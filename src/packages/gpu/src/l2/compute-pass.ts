// ============================================================
// l2/compute-pass.ts — ComputePassManager（GeoForge L2）
// 层级：L2（渲染层）
// 职责：封装内置计算任务（视锥剔除、深度排序、标注碰撞、点聚类、地形细分）
//       的管线与 BindGroup 构建；按依赖拓扑排序后编码 compute pass。
// 约束：零 npm 依赖；Buffer 仅通过 L1 `BufferHandle` 引用；管线走 PipelineCache。
// ============================================================

import type { BufferHandle } from '../l1/buffer-pool.ts';
import type { PipelineCache } from './pipeline-cache.ts';
import { uniqueId } from '../../../core/src/infra/id.ts';
import BUILTIN_WGSL_FRUSTUM_CULL from '../wgsl/compute/frustum-cull.wgsl?raw';
import BUILTIN_WGSL_RADIX_SORT from '../wgsl/compute/depth-sort.wgsl?raw';
import BUILTIN_WGSL_LABEL_COLLISION from '../wgsl/compute/label-collision.wgsl?raw';
import BUILTIN_WGSL_SPATIAL_HASH from '../wgsl/compute/spatial-hash.wgsl?raw';
import BUILTIN_WGSL_TERRAIN_TESSELLATION from '../wgsl/compute/terrain-tessellation.wgsl?raw';

// ===================== 内置 WGSL（入口统一为 cs_main） =====================
// 各着色器源码位于 `wgsl/compute/*.wgsl`，经 `?raw` 导入为字符串（与原先内嵌模板字面量等价）。
//
// - frustum-cull：视锥剔除；`objectBounds` 每项 min(vec4)+max(vec4)，`frustumPlanes` 至少 6 个 vec4。
// - depth-sort：深度键排序占位（identity on values；可换真实 radix）。
// - label-collision：像素空间 AABB 碰撞；同索引较小者优先；`{{VIEWPORT_W}}` / `{{VIEWPORT_H}}` 由运行时替换。
// - spatial-hash：3D 位置量化网格，输出哈希簇 id；`{{CELL_SIZE}}` 由运行时替换。
// - terrain-tessellation：每 patch 细分因子占位 LOD。

// ===================== 常量 =====================

/** 多数内置计算着色器使用的 workgroup 大小（线程数）。 */
const DEFAULT_WORKGROUP_SIZE = 64;

/** 深度排序占位内核使用的较大 workgroup（与 wgsl-templates 占位一致，便于后续换 radix）。 */
const DEPTH_SORT_WORKGROUP_SIZE = 256;

/** 单维 dispatch 最大 workgroup 数（WebGPU）。 */
const MAX_WORKGROUPS_1D = 65535;

/** 每个物体 AABB 在 buffer 中占用的字节数：min vec4 + max vec4。 */
const BYTES_PER_OBJECT_BOUNDS = 32;

/** 六个视锥平面，每平面 vec4。 */
const BYTES_FRUSTUM_PLANES = 6 * 16;

/** 每个 u32 可见性标记 4 字节。 */
const BYTES_PER_U32 = 4;

/** 每个 f32 键 4 字节。 */
const BYTES_PER_F32 = 4;

// ===================== 类型 =====================

/**
 * 内置计算任务类型枚举（与 FrameGraph / 文档约定一致）。
 */
export type BuiltinComputeTask =
  | 'frustum-cull'
  | 'depth-sort'
  | 'label-collision'
  | 'point-cluster'
  | 'terrain-tessellation';

/**
 * 单次计算任务描述：管线、BindGroup、三维 workgroup 网格与可选依赖。
 */
export interface ComputeTaskDescriptor {
  /** 任务唯一 id，用于依赖边与调试。 */
  readonly id: string;

  /** 内置类型或 `custom`。 */
  readonly type: BuiltinComputeTask | 'custom';

  /** 已创建的计算管线（入口 `cs_main`）。 */
  readonly pipeline: GPUComputePipeline;

  /** 与 `@group(i)` 对齐的 BindGroup 数组。 */
  readonly bindGroups: GPUBindGroup[];

  /** dispatchWorkgroups(x,y,z)。 */
  readonly workgroupCount: [x: number, y: number, z: number];

  /** 必须先完成的其它任务 id（拓扑边：依赖 -> 本任务）。 */
  readonly dependencies?: string[];
}

/**
 * ComputePassManager：构建内置任务与编码顺序。
 */
export interface ComputePassManager {
  /**
   * 创建视锥剔除任务：AABB storage、六平面 storage、可见性 u32 输出。
   *
   * @param options - 缓冲与物体数量
   * @returns 任务描述
   */
  createFrustumCullTask(options: {
    readonly objectBoundsBuffer: BufferHandle;
    readonly objectCount: number;
    readonly frustumPlanesBuffer: BufferHandle;
    readonly outputVisibilityBuffer: BufferHandle;
  }): ComputeTaskDescriptor;

  /**
   * 创建深度排序占位任务：depth key 与 values（通常为索引）成对。
   *
   * @param options - key/value buffer 与元素数量
   */
  createDepthSortTask(options: {
    readonly keyBuffer: BufferHandle;
    readonly valueBuffer: BufferHandle;
    readonly count: number;
  }): ComputeTaskDescriptor;

  /**
   * 创建标注碰撞任务：像素空间 AABB，输出每标注是否可见。
   *
   * @param options - 盒缓冲、数量、视口像素尺寸、输出缓冲
   */
  createLabelCollisionTask(options: {
    readonly labelBoxBuffer: BufferHandle;
    readonly labelCount: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly outputVisibilityBuffer: BufferHandle;
  }): ComputeTaskDescriptor;

  /**
   * 创建点聚类（空间哈希）任务。
   *
   * @param options - 位置 vec4、点数、cell 尺寸、输出簇 id
   */
  createPointClusterTask(options: {
    readonly positionBuffer: BufferHandle;
    readonly pointCount: number;
    readonly cellSize: number;
    readonly outputClusterBuffer: BufferHandle;
  }): ComputeTaskDescriptor;

  /**
   * 透传自定义任务（做浅拷贝校验）。
   *
   * @param descriptor - 完整任务描述
   */
  createCustomTask(descriptor: ComputeTaskDescriptor): ComputeTaskDescriptor;

  /**
   * 按依赖拓扑排序后，依次 beginComputePass → setPipeline → setBindGroup → dispatch。
   *
   * @param encoder - 命令编码器
   * @param tasks - 任务列表
   */
  encodeAll(encoder: GPUCommandEncoder, tasks: ComputeTaskDescriptor[]): void;

  /** 内置 WGSL 源码字符串（可在外部自定义管线中复用）。 */
  readonly builtinShaders: {
    readonly frustumCull: string;
    readonly radixSort: string;
    readonly labelCollision: string;
    readonly spatialHash: string;
    readonly terrainTessellation: string;
  };
}

// ===================== 校验与工具 =====================

/**
 * 校验 BufferHandle 可用（非空、含合法 buffer）。
 *
 * @param handle - L1 缓冲句柄
 * @param name - 参数名（用于错误信息）
 */
function assertBufferHandle(handle: BufferHandle | null | undefined, name: string): asserts handle is BufferHandle {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError(`${name} must be a BufferHandle object.`);
  }
  if (!handle.buffer || typeof handle.buffer !== 'object') {
    throw new TypeError(`${name}.buffer is invalid.`);
  }
  if (!Number.isFinite(handle.size) || handle.size <= 0) {
    throw new TypeError(`${name}.size must be a positive finite number.`);
  }
}

/**
 * 校验正整数（用于 objectCount 等）。
 *
 * @param value - 数值
 * @param name - 字段名
 */
function assertPositiveInt(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be a positive finite integer.`);
  }
}

/**
 * 校验正有限浮点数（viewport、cellSize）。
 *
 * @param value - 数值
 * @param name - 字段名
 */
function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
}

/**
 * 计算一维 dispatch 的 workgroup 数量，并检查 WebGPU 上限。
 *
 * @param elementCount - 元素个数
 * @param workgroupSize - 每 workgroup 线程数
 * @returns workgroup 数量（至少为 1）
 */
function computeWorkgroupCount1D(elementCount: number, workgroupSize: number): number {
  if (!Number.isFinite(elementCount) || elementCount <= 0) {
    throw new TypeError('computeWorkgroupCount1D: elementCount must be positive.');
  }
  if (!Number.isFinite(workgroupSize) || workgroupSize <= 0 || !Number.isInteger(workgroupSize)) {
    throw new TypeError('computeWorkgroupCount1D: workgroupSize must be a positive integer.');
  }
  const wg = Math.ceil(elementCount / workgroupSize);
  if (wg > MAX_WORKGROUPS_1D) {
    throw new RangeError(
      `computeWorkgroupCount1D: dispatch ${wg} exceeds max workgroups ${MAX_WORKGROUPS_1D} for size ${workgroupSize}.`,
    );
  }
  return Math.max(1, wg);
}

/**
 * 对任务列表按 `dependencies` 做 Kahn 拓扑排序。
 *
 * @param tasks - 输入任务
 * @returns 拓扑有序的任务数组
 * @throws Error 当存在环、重复 id 或缺失依赖时
 */
function topologicalSortTasks(tasks: readonly ComputeTaskDescriptor[]): ComputeTaskDescriptor[] {
  const idToTask = new Map<string, ComputeTaskDescriptor>();
  for (const t of tasks) {
    if (idToTask.has(t.id)) {
      throw new Error(`ComputePassManager: duplicate task id "${t.id}".`);
    }
    idToTask.set(t.id, t);
  }
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, (t.dependencies ?? []).length);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) {
      if (!idToTask.has(dep)) {
        throw new Error(`ComputePassManager: task "${t.id}" depends on unknown id "${dep}".`);
      }
      if (!children.has(dep)) {
        children.set(dep, []);
      }
      children.get(dep)!.push(t.id);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }
  const sorted: ComputeTaskDescriptor[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      break;
    }
    const node = idToTask.get(id);
    if (!node) {
      throw new Error(`ComputePassManager: internal error, missing id "${id}".`);
    }
    sorted.push(node);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        queue.push(child);
      }
    }
  }
  if (sorted.length !== tasks.length) {
    throw new Error('ComputePassManager: cyclic dependency detected in compute task graph.');
  }
  return sorted;
}

/**
 * 创建 ComputePassManager 实例。
 *
 * @param device - WebGPU 设备（创建 BindGroup）
 * @param pipelineCache - 管线缓存
 * @returns ComputePassManager
 *
 * @example
 * const cpm = createComputePassManager(device, pipelineCache);
 * const task = cpm.createFrustumCullTask({ ... });
 * cpm.encodeAll(encoder, [task]);
 */
export function createComputePassManager(device: GPUDevice, pipelineCache: PipelineCache): ComputePassManager {
  if (!device || typeof device.createBindGroup !== 'function') {
    throw new TypeError('createComputePassManager: device must be a valid GPUDevice.');
  }
  if (!pipelineCache || typeof pipelineCache.getOrCreateCompute !== 'function') {
    throw new TypeError('createComputePassManager: pipelineCache must be a PipelineCache.');
  }

  const builtinShaders: ComputePassManager['builtinShaders'] = {
    frustumCull: BUILTIN_WGSL_FRUSTUM_CULL,
    radixSort: BUILTIN_WGSL_RADIX_SORT,
    labelCollision: BUILTIN_WGSL_LABEL_COLLISION,
    spatialHash: BUILTIN_WGSL_SPATIAL_HASH,
    terrainTessellation: BUILTIN_WGSL_TERRAIN_TESSELLATION,
  };

  const api: ComputePassManager = {
    createFrustumCullTask(options: {
      readonly objectBoundsBuffer: BufferHandle;
      readonly objectCount: number;
      readonly frustumPlanesBuffer: BufferHandle;
      readonly outputVisibilityBuffer: BufferHandle;
    }): ComputeTaskDescriptor {
      assertBufferHandle(options.objectBoundsBuffer, 'objectBoundsBuffer');
      assertBufferHandle(options.frustumPlanesBuffer, 'frustumPlanesBuffer');
      assertBufferHandle(options.outputVisibilityBuffer, 'outputVisibilityBuffer');
      assertPositiveInt(options.objectCount, 'objectCount');

      const needBounds = options.objectCount * BYTES_PER_OBJECT_BOUNDS;
      if (options.objectBoundsBuffer.size < needBounds) {
        throw new RangeError(
          `createFrustumCullTask: objectBoundsBuffer.size (${options.objectBoundsBuffer.size}) < required ${needBounds}.`,
        );
      }
      if (options.frustumPlanesBuffer.size < BYTES_FRUSTUM_PLANES) {
        throw new RangeError(
          `createFrustumCullTask: frustumPlanesBuffer.size (${options.frustumPlanesBuffer.size}) < ${BYTES_FRUSTUM_PLANES}.`,
        );
      }
      if (options.outputVisibilityBuffer.size < options.objectCount * BYTES_PER_U32) {
        throw new RangeError(
          `createFrustumCullTask: outputVisibilityBuffer too small for ${options.objectCount} u32 values.`,
        );
      }

      let pipeline: GPUComputePipeline;
      try {
        pipeline = pipelineCache.getOrCreateCompute(BUILTIN_WGSL_FRUSTUM_CULL, 'geoforge-frustum-cull');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createFrustumCullTask: pipeline creation failed: ${msg}`);
      }

      let bindGroup: GPUBindGroup;
      try {
        const layout = pipeline.getBindGroupLayout(0);
        bindGroup = device.createBindGroup({
          label: 'frustum-cull-bg0',
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: options.objectBoundsBuffer.buffer,
                offset: 0,
                size: options.objectBoundsBuffer.size,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: options.frustumPlanesBuffer.buffer,
                offset: 0,
                size: options.frustumPlanesBuffer.size,
              },
            },
            {
              binding: 2,
              resource: {
                buffer: options.outputVisibilityBuffer.buffer,
                offset: 0,
                size: options.outputVisibilityBuffer.size,
              },
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createFrustumCullTask: createBindGroup failed: ${msg}`);
      }

      const wx = computeWorkgroupCount1D(options.objectCount, DEFAULT_WORKGROUP_SIZE);

      return {
        id: `frustum-cull-${uniqueId()}`,
        type: 'frustum-cull',
        pipeline,
        bindGroups: [bindGroup],
        workgroupCount: [wx, 1, 1],
      };
    },

    createDepthSortTask(options: {
      readonly keyBuffer: BufferHandle;
      readonly valueBuffer: BufferHandle;
      readonly count: number;
    }): ComputeTaskDescriptor {
      assertBufferHandle(options.keyBuffer, 'keyBuffer');
      assertBufferHandle(options.valueBuffer, 'valueBuffer');
      assertPositiveInt(options.count, 'count');

      const need = options.count * BYTES_PER_F32;
      if (options.keyBuffer.size < need) {
        throw new RangeError(`createDepthSortTask: keyBuffer.size (${options.keyBuffer.size}) < ${need} bytes.`);
      }
      if (options.valueBuffer.size < options.count * BYTES_PER_U32) {
        throw new RangeError('createDepthSortTask: valueBuffer too small for count u32 elements.');
      }

      let pipeline: GPUComputePipeline;
      try {
        pipeline = pipelineCache.getOrCreateCompute(BUILTIN_WGSL_RADIX_SORT, 'geoforge-depth-sort');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createDepthSortTask: pipeline creation failed: ${msg}`);
      }

      let bindGroup: GPUBindGroup;
      try {
        const layout = pipeline.getBindGroupLayout(0);
        bindGroup = device.createBindGroup({
          label: 'depth-sort-bg0',
          layout,
          entries: [
            {
              binding: 0,
              resource: { buffer: options.keyBuffer.buffer, offset: 0, size: options.keyBuffer.size },
            },
            {
              binding: 1,
              resource: { buffer: options.valueBuffer.buffer, offset: 0, size: options.valueBuffer.size },
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createDepthSortTask: createBindGroup failed: ${msg}`);
      }

      const wx = computeWorkgroupCount1D(options.count, DEPTH_SORT_WORKGROUP_SIZE);

      return {
        id: `depth-sort-${uniqueId()}`,
        type: 'depth-sort',
        pipeline,
        bindGroups: [bindGroup],
        workgroupCount: [wx, 1, 1],
      };
    },

    createLabelCollisionTask(options: {
      readonly labelBoxBuffer: BufferHandle;
      readonly labelCount: number;
      readonly viewportWidth: number;
      readonly viewportHeight: number;
      readonly outputVisibilityBuffer: BufferHandle;
    }): ComputeTaskDescriptor {
      assertBufferHandle(options.labelBoxBuffer, 'labelBoxBuffer');
      assertBufferHandle(options.outputVisibilityBuffer, 'outputVisibilityBuffer');
      assertPositiveInt(options.labelCount, 'labelCount');
      assertPositiveFinite(options.viewportWidth, 'viewportWidth');
      assertPositiveFinite(options.viewportHeight, 'viewportHeight');

      const needBoxes = options.labelCount * 16;
      if (options.labelBoxBuffer.size < needBoxes) {
        throw new RangeError(
          `createLabelCollisionTask: labelBoxBuffer.size (${options.labelBoxBuffer.size}) < ${needBoxes} for vec4 boxes.`,
        );
      }
      if (options.outputVisibilityBuffer.size < options.labelCount * BYTES_PER_U32) {
        throw new RangeError('createLabelCollisionTask: outputVisibilityBuffer too small.');
      }

      const wgsl = BUILTIN_WGSL_LABEL_COLLISION.replace('{{VIEWPORT_W}}', String(options.viewportWidth)).replace(
        '{{VIEWPORT_H}}',
        String(options.viewportHeight),
      );

      let pipeline: GPUComputePipeline;
      try {
        pipeline = pipelineCache.getOrCreateCompute(wgsl, 'geoforge-label-collision');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createLabelCollisionTask: pipeline creation failed: ${msg}`);
      }

      let bindGroup: GPUBindGroup;
      try {
        const layout = pipeline.getBindGroupLayout(0);
        bindGroup = device.createBindGroup({
          label: 'label-collision-bg0',
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: options.labelBoxBuffer.buffer,
                offset: 0,
                size: options.labelBoxBuffer.size,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: options.outputVisibilityBuffer.buffer,
                offset: 0,
                size: options.outputVisibilityBuffer.size,
              },
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createLabelCollisionTask: createBindGroup failed: ${msg}`);
      }

      const wx = computeWorkgroupCount1D(options.labelCount, DEFAULT_WORKGROUP_SIZE);

      return {
        id: `label-collision-${uniqueId()}`,
        type: 'label-collision',
        pipeline,
        bindGroups: [bindGroup],
        workgroupCount: [wx, 1, 1],
      };
    },

    createPointClusterTask(options: {
      readonly positionBuffer: BufferHandle;
      readonly pointCount: number;
      readonly cellSize: number;
      readonly outputClusterBuffer: BufferHandle;
    }): ComputeTaskDescriptor {
      assertBufferHandle(options.positionBuffer, 'positionBuffer');
      assertBufferHandle(options.outputClusterBuffer, 'outputClusterBuffer');
      assertPositiveInt(options.pointCount, 'pointCount');
      assertPositiveFinite(options.cellSize, 'cellSize');

      const needPos = options.pointCount * 16;
      if (options.positionBuffer.size < needPos) {
        throw new RangeError(
          `createPointClusterTask: positionBuffer.size (${options.positionBuffer.size}) < ${needPos} for vec4 positions.`,
        );
      }
      if (options.outputClusterBuffer.size < options.pointCount * BYTES_PER_U32) {
        throw new RangeError('createPointClusterTask: outputClusterBuffer too small.');
      }

      const wgsl = BUILTIN_WGSL_SPATIAL_HASH.replace('{{CELL_SIZE}}', String(options.cellSize));

      let pipeline: GPUComputePipeline;
      try {
        pipeline = pipelineCache.getOrCreateCompute(wgsl, 'geoforge-point-cluster');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createPointClusterTask: pipeline creation failed: ${msg}`);
      }

      let bindGroup: GPUBindGroup;
      try {
        const layout = pipeline.getBindGroupLayout(0);
        bindGroup = device.createBindGroup({
          label: 'point-cluster-bg0',
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: options.positionBuffer.buffer,
                offset: 0,
                size: options.positionBuffer.size,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: options.outputClusterBuffer.buffer,
                offset: 0,
                size: options.outputClusterBuffer.size,
              },
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`createPointClusterTask: createBindGroup failed: ${msg}`);
      }

      const wx = computeWorkgroupCount1D(options.pointCount, DEFAULT_WORKGROUP_SIZE);

      return {
        id: `point-cluster-${uniqueId()}`,
        type: 'point-cluster',
        pipeline,
        bindGroups: [bindGroup],
        workgroupCount: [wx, 1, 1],
      };
    },

    createCustomTask(descriptor: ComputeTaskDescriptor): ComputeTaskDescriptor {
      if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError('createCustomTask: descriptor must be an object.');
      }
      if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
        throw new TypeError('createCustomTask: descriptor.id must be a non-empty string.');
      }
      if (!descriptor.pipeline || typeof descriptor.pipeline !== 'object') {
        throw new TypeError('createCustomTask: descriptor.pipeline is invalid.');
      }
      if (!Array.isArray(descriptor.bindGroups)) {
        throw new TypeError('createCustomTask: descriptor.bindGroups must be an array.');
      }
      const wc = descriptor.workgroupCount;
      if (
        !Array.isArray(wc) ||
        wc.length !== 3 ||
        !Number.isFinite(wc[0]) ||
        !Number.isFinite(wc[1]) ||
        !Number.isFinite(wc[2])
      ) {
        throw new TypeError('createCustomTask: workgroupCount must be a tuple of 3 finite numbers.');
      }
      if (wc[0]! < 1 || wc[1]! < 1 || wc[2]! < 1) {
        throw new RangeError('createCustomTask: workgroupCount components must be >= 1.');
      }
      return descriptor;
    },

    encodeAll(encoder: GPUCommandEncoder, tasks: ComputeTaskDescriptor[]): void {
      if (!encoder || typeof encoder.beginComputePass !== 'function') {
        throw new TypeError('encodeAll: encoder must be a GPUCommandEncoder.');
      }
      if (!Array.isArray(tasks)) {
        throw new TypeError('encodeAll: tasks must be an array.');
      }
      if (tasks.length === 0) {
        return;
      }

      let sorted: ComputeTaskDescriptor[];
      try {
        sorted = topologicalSortTasks(tasks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`encodeAll: ${msg}`);
      }

      for (let i = 0; i < sorted.length; i++) {
        const task = sorted[i]!;
        let pass: GPUComputePassEncoder;
        try {
          pass = encoder.beginComputePass({ label: `compute-${task.id}` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`encodeAll: beginComputePass failed for task "${task.id}": ${msg}`);
        }
        try {
          pass.setPipeline(task.pipeline);
          for (let g = 0; g < task.bindGroups.length; g++) {
            pass.setBindGroup(g, task.bindGroups[g]!);
          }
          pass.dispatchWorkgroups(task.workgroupCount[0], task.workgroupCount[1], task.workgroupCount[2]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            pass.end();
          } catch {
            // 忽略二次错误
          }
          throw new Error(`encodeAll: encoding failed for task "${task.id}": ${msg}`);
        }
        try {
          pass.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`encodeAll: pass.end failed for task "${task.id}": ${msg}`);
        }
      }
    },

    get builtinShaders(): ComputePassManager['builtinShaders'] {
      return builtinShaders;
    },
  };

  return api;
}
