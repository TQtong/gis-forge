// ============================================================
// l2/pipeline-cache.ts — 渲染 / 计算管线缓存（GeoForge L2）
// 层级：L2（渲染层）
// 职责：按 PipelineDescriptor 与 WGSL 源码缓存 GPURenderPipeline /
//       GPUComputePipeline；统计命中、未命中与编译耗时；支持异步创建与预热。
// 约束：零 npm 依赖；仅使用 WebGPU 与 ShaderAssembler 拼装结果。
// ============================================================

import type { ShaderAssembler, ShaderVariantKey } from './shader-assembler.ts';

// ===================== 常量 =====================

/** 顶点输入步长（字节）：vec3+vec3+vec2+vec4，与 wgsl-templates VertexInput 一致。 */
const VERTEX_INPUT_STRIDE_BYTES = 48;

/** 默认顶点着色器入口名（GeoForge 模板约定）。 */
const VERTEX_ENTRY_POINT = 'vs_main';

/** 默认片元着色器入口名（GeoForge 模板约定）。 */
const FRAGMENT_ENTRY_POINT = 'fs_main';

/** 计算着色器默认入口名（ComputePassManager 与 getOrCreateCompute 约定）。 */
const COMPUTE_ENTRY_POINT = 'cs_main';

/** 单维 dispatch 最大 workgroup 数（WebGPU 规范）。 */
const MAX_WORKGROUP_COUNT_PER_DIMENSION = 65535;

/**
 * 若运行环境与类型定义支持 `destroy()`，则销毁管线对象（兼容旧版 @webgpu/types）。
 *
 * @param pipeline - 渲染或计算管线
 */
function destroyPipelineIfSupported(pipeline: GPURenderPipeline | GPUComputePipeline): void {
  const maybe = pipeline as GPURenderPipeline & { destroy?: () => void };
  if (typeof maybe.destroy === 'function') {
    try {
      maybe.destroy();
    } catch {
      // 忽略驱动侧销毁异常，保证 clear 可继续
    }
  }
}

/** 用于 compute 缓存键的简单字符串哈希（djb2 变体），降低 Map 键长度。 */
function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
    hash = hash | 0;
  }
  return `djb2_${(hash >>> 0).toString(16)}_${input.length.toString(16)}`;
}

// ===================== 类型 =====================

/**
 * 渲染管线描述：着色器变体 + 固定功能状态 + 颜色/深度格式与 MSAA。
 * 全字段参与缓存键序列化；`blendState` 为 undefined 时表示不透明替换写入。
 */
export interface PipelineDescriptor {
  /** 着色器变体键（由 ShaderAssembler 拼装）。 */
  readonly shaderVariant: ShaderVariantKey;

  /** 图元拓扑（`triangle-list` 等）。 */
  readonly topology: GPUPrimitiveTopology;

  /** 面剔除模式。 */
  readonly cullMode: GPUCullMode;

  /** 深度比较函数（GeoForge 默认 Reversed-Z 为 `greater`）。 */
  readonly depthCompare: GPUCompareFunction;

  /** 是否写入深度缓冲。 */
  readonly depthWriteEnabled: boolean;

  /** 颜色附件混合状态；undefined 表示不混合（替换）。 */
  readonly blendState?: GPUBlendState;

  /** MSAA 采样数（1 或 4 等）。 */
  readonly sampleCount: number;

  /** 颜色附件格式。 */
  readonly colorFormat: GPUTextureFormat;

  /** 深度附件格式（通常为 `depth32float`）。 */
  readonly depthFormat: GPUTextureFormat;
}

/**
 * PipelineCache 统计：命中、未命中、缓存条目数、累计编译耗时（毫秒）。
 */
export interface PipelineCacheStats {
  /** 当前缓存的管线条数（渲染 + 计算）。 */
  readonly cacheSize: number;

  /** 缓存命中次数（getOrCreate / getOrCreateCompute 命中）。 */
  readonly cacheHits: number;

  /** 缓存未命中次数。 */
  readonly cacheMisses: number;

  /** 累计管线创建耗时（毫秒），含同步与异步路径完成后的增量。 */
  readonly compilationTimeMs: number;
}

/**
 * 渲染与计算管线缓存接口。
 */
export interface PipelineCache {
  /**
   * 同步获取或创建渲染管线。
   *
   * @param descriptor - 管线描述
   * @returns 缓存或新创建的 `GPURenderPipeline`
   * @throws TypeError 当 descriptor 非法时
   * @throws Error 当 ShaderAssembler 或 GPU 创建失败时
   */
  getOrCreate(descriptor: PipelineDescriptor): GPURenderPipeline;

  /**
   * 异步获取或创建渲染管线（优先 `createRenderPipelineAsync`，不可用时回退同步）。
   *
   * @param descriptor - 管线描述
   * @returns 解析为 `GPURenderPipeline` 的 Promise
   */
  getOrCreateAsync(descriptor: PipelineDescriptor): Promise<GPURenderPipeline>;

  /**
   * 批量预热：按顺序为每个描述创建管线（异步优先），失败则拒绝 Promise。
   *
   * @param descriptors - 描述列表
   * @returns 全部完成时 resolve
   */
  warmup(descriptors: PipelineDescriptor[]): Promise<void>;

  /**
   * 是否已存在与描述等价的缓存项（序列化键一致）。
   *
   * @param descriptor - 管线描述
   * @returns 若渲染缓存命中则为 true
   */
  has(descriptor: PipelineDescriptor): boolean;

  /** 只读统计快照。 */
  readonly stats: PipelineCacheStats;

  /**
   * 清空缓存并销毁已创建的 GPU 管线对象。
   */
  clear(): void;

  /**
   * 同步获取或创建计算管线（以 WGSL 源码为键，入口固定为 `cs_main`）。
   *
   * @param shaderCode - 完整 WGSL 源码（须含 `@compute` 与 `cs_main`）
   * @param label - 可选调试标签
   * @returns `GPUComputePipeline`
   */
  getOrCreateCompute(shaderCode: string, label?: string): GPUComputePipeline;

  /**
   * 异步获取或创建计算管线。
   *
   * @param shaderCode - 完整 WGSL 源码
   * @param label - 可选调试标签
   * @returns `GPUComputePipeline` 的 Promise
   */
  getOrCreateComputeAsync(shaderCode: string, label?: string): Promise<GPUComputePipeline>;
}

/** 与 GeoForge 顶点模板一致的 `GPUVertexBufferLayout`（单流交错属性）。 */
const STANDARD_VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_INPUT_STRIDE_BYTES,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
    { shaderLocation: 3, offset: 32, format: 'float32x4' },
  ],
};

/**
 * 将 `PipelineDescriptor` 全字段序列化为稳定字符串，用作 Map 键。
 *
 * @param descriptor - 管线描述
 * @returns JSON 字符串键
 * @throws Error 当序列化失败（如循环引用）时
 */
function serializePipelineDescriptor(descriptor: PipelineDescriptor): string {
  try {
    const payload = {
      shaderVariant: {
        projection: descriptor.shaderVariant.projection,
        geometry: descriptor.shaderVariant.geometry,
        style: descriptor.shaderVariant.style,
        features: [...descriptor.shaderVariant.features],
      },
      topology: descriptor.topology,
      cullMode: descriptor.cullMode,
      depthCompare: descriptor.depthCompare,
      depthWriteEnabled: descriptor.depthWriteEnabled,
      blendState: descriptor.blendState,
      sampleCount: descriptor.sampleCount,
      colorFormat: descriptor.colorFormat,
      depthFormat: descriptor.depthFormat,
    };
    return JSON.stringify(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`serializePipelineDescriptor failed: ${msg}`);
  }
}

/**
 * 校验 `PipelineDescriptor` 基本合法性（非 NaN、正样本数、非空变体字符串）。
 *
 * @param descriptor - 待校验描述
 * @throws TypeError 当参数不合法时
 */
function validatePipelineDescriptor(descriptor: PipelineDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('PipelineDescriptor must be a non-null object.');
  }
  const sv = descriptor.shaderVariant;
  if (!sv || typeof sv.projection !== 'string' || sv.projection.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.projection must be a non-empty string.');
  }
  if (typeof sv.geometry !== 'string' || sv.geometry.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.geometry must be a non-empty string.');
  }
  if (typeof sv.style !== 'string' || sv.style.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.style must be a non-empty string.');
  }
  if (!Array.isArray(sv.features)) {
    throw new TypeError('PipelineDescriptor.shaderVariant.features must be an array.');
  }
  const sc = descriptor.sampleCount;
  if (!Number.isFinite(sc) || sc <= 0 || !Number.isInteger(sc)) {
    throw new TypeError('PipelineDescriptor.sampleCount must be a positive finite integer.');
  }
  if (typeof descriptor.colorFormat !== 'string' || descriptor.colorFormat.length === 0) {
    throw new TypeError('PipelineDescriptor.colorFormat must be a non-empty string.');
  }
  if (typeof descriptor.depthFormat !== 'string' || descriptor.depthFormat.length === 0) {
    throw new TypeError('PipelineDescriptor.depthFormat must be a non-empty string.');
  }
}

/**
 * 由 `AssembledShader.bindGroupLayouts` 创建 `GPUPipelineLayout`；空数组时返回 `'auto'`。
 *
 * @param device - GPU 设备
 * @param bindGroupLayouts - BindGroup 布局描述数组
 * @returns `GPUPipelineLayout` 或字面量 `'auto'`
 */
function createRenderPipelineLayout(
  device: GPUDevice,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
): GPUPipelineLayout | 'auto' {
  if (bindGroupLayouts.length === 0) {
    return 'auto';
  }
  try {
    const layouts: GPUBindGroupLayout[] = [];
    for (let i = 0; i < bindGroupLayouts.length; i++) {
      layouts.push(device.createBindGroupLayout(bindGroupLayouts[i]!));
    }
    return device.createPipelineLayout({ bindGroupLayouts: layouts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`createRenderPipelineLayout failed at index binding: ${msg}`);
  }
}

/**
 * 创建 `PipelineCache` 实现。
 *
 * @param device - WebGPU 设备
 * @param shaderAssembler - 着色器拼装器
 * @returns `PipelineCache` 实例
 *
 * @example
 * const cache = createPipelineCache(device, shaderAssembler);
 * const pl = cache.getOrCreate(descriptor);
 */
export function createPipelineCache(device: GPUDevice, shaderAssembler: ShaderAssembler): PipelineCache {
  if (!device || typeof device.createShaderModule !== 'function') {
    throw new TypeError('createPipelineCache: device must be a valid GPUDevice.');
  }
  if (!shaderAssembler || typeof shaderAssembler.assemble !== 'function') {
    throw new TypeError('createPipelineCache: shaderAssembler must provide assemble().');
  }

  const renderCache = new Map<string, GPURenderPipeline>();
  const computeCache = new Map<string, GPUComputePipeline>();

  let cacheHits = 0;
  let cacheMisses = 0;
  let compilationTimeMs = 0;

  /**
   * 记录一次编译耗时并累加到统计。
   *
   * @param startMs - performance.now() 起始时间
   */
  const addCompilationTime = (startMs: number): void => {
    const dt = performance.now() - startMs;
    if (Number.isFinite(dt) && dt >= 0) {
      compilationTimeMs += dt;
    }
  };

  /**
   * 内部：构建单条渲染管线（同步路径）。
   *
   * @param descriptor - 已校验的管线描述
   * @returns 新创建的 `GPURenderPipeline`
   */
  const buildRenderPipeline = (descriptor: PipelineDescriptor): GPURenderPipeline => {
    const t0 = performance.now();
    let assembled;
    try {
      assembled = shaderAssembler.assemble(descriptor.shaderVariant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ShaderAssembler.assemble failed: ${msg}`);
    }

    if (!assembled.vertexCode || assembled.vertexCode.trim().length === 0) {
      throw new Error('AssembledShader.vertexCode is empty.');
    }
    if (!assembled.fragmentCode || assembled.fragmentCode.trim().length === 0) {
      throw new Error('AssembledShader.fragmentCode is empty.');
    }

    let vertexModule: GPUShaderModule;
    let fragmentModule: GPUShaderModule;
    try {
      vertexModule = device.createShaderModule({
        label: `${assembled.key}-vertex`,
        code: assembled.vertexCode,
      });
      fragmentModule = device.createShaderModule({
        label: `${assembled.key}-fragment`,
        code: assembled.fragmentCode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule failed: ${msg}`);
    }

    let pipelineLayout: GPUPipelineLayout | 'auto';
    try {
      pipelineLayout = createRenderPipelineLayout(device, assembled.bindGroupLayouts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineLayout failed: ${msg}`);
    }

    const colorTarget: GPUColorTargetState = {
      format: descriptor.colorFormat,
      blend: descriptor.blendState,
    };

    let pipeline: GPURenderPipeline;
    try {
      pipeline = device.createRenderPipeline({
        label: `render-${assembled.key}`,
        layout: pipelineLayout,
        vertex: {
          module: vertexModule,
          entryPoint: VERTEX_ENTRY_POINT,
          buffers: [STANDARD_VERTEX_BUFFER_LAYOUT],
        },
        fragment: {
          module: fragmentModule,
          entryPoint: FRAGMENT_ENTRY_POINT,
          targets: [colorTarget],
        },
        primitive: {
          topology: descriptor.topology,
          cullMode: descriptor.cullMode,
        },
        depthStencil: {
          format: descriptor.depthFormat,
          depthWriteEnabled: descriptor.depthWriteEnabled,
          depthCompare: descriptor.depthCompare,
        },
        multisample: {
          count: descriptor.sampleCount,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipeline failed: ${msg}`);
    }

    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：构建计算管线（同步）。
   *
   * @param shaderCode - WGSL 源码
   * @param label - 调试标签
   * @returns `GPUComputePipeline`
   */
  const buildComputePipeline = (shaderCode: string, label: string | undefined): GPUComputePipeline => {
    const t0 = performance.now();
    if (!shaderCode || shaderCode.trim().length === 0) {
      throw new TypeError('getOrCreateCompute: shaderCode must be a non-empty string.');
    }
    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({ label: label ?? 'compute-shader', code: shaderCode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule (compute) failed: ${msg}`);
    }
    let pipeline: GPUComputePipeline;
    try {
      pipeline = device.createComputePipeline({
        label: label ?? 'compute-pipeline',
        layout: 'auto',
        compute: {
          module,
          entryPoint: COMPUTE_ENTRY_POINT,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createComputePipeline failed: ${msg}`);
    }
    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：异步构建渲染管线。
   *
   * @param descriptor - 管线描述
   * @returns Promise<GPURenderPipeline>
   */
  const buildRenderPipelineAsync = async (descriptor: PipelineDescriptor): Promise<GPURenderPipeline> => {
    const t0 = performance.now();
    let assembled;
    try {
      assembled = shaderAssembler.assemble(descriptor.shaderVariant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ShaderAssembler.assemble failed: ${msg}`);
    }

    if (!assembled.vertexCode || !assembled.fragmentCode) {
      throw new Error('AssembledShader vertex/fragment code is empty.');
    }

    let vertexModule: GPUShaderModule;
    let fragmentModule: GPUShaderModule;
    try {
      vertexModule = device.createShaderModule({ label: `${assembled.key}-vertex`, code: assembled.vertexCode });
      fragmentModule = device.createShaderModule({
        label: `${assembled.key}-fragment`,
        code: assembled.fragmentCode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule failed: ${msg}`);
    }

    let pipelineLayout: GPUPipelineLayout | 'auto';
    try {
      pipelineLayout = createRenderPipelineLayout(device, assembled.bindGroupLayouts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineLayout failed: ${msg}`);
    }

    const colorTarget: GPUColorTargetState = {
      format: descriptor.colorFormat,
      blend: descriptor.blendState,
    };

    const desc: GPURenderPipelineDescriptor = {
      label: `render-${assembled.key}`,
      layout: pipelineLayout,
      vertex: {
        module: vertexModule,
        entryPoint: VERTEX_ENTRY_POINT,
        buffers: [STANDARD_VERTEX_BUFFER_LAYOUT],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: FRAGMENT_ENTRY_POINT,
        targets: [colorTarget],
      },
      primitive: {
        topology: descriptor.topology,
        cullMode: descriptor.cullMode,
      },
      depthStencil: {
        format: descriptor.depthFormat,
        depthWriteEnabled: descriptor.depthWriteEnabled,
        depthCompare: descriptor.depthCompare,
      },
      multisample: {
        count: descriptor.sampleCount,
      },
    };

    let pipeline: GPURenderPipeline;
    try {
      const asyncFn = device.createRenderPipelineAsync?.bind(device);
      if (typeof asyncFn === 'function') {
        pipeline = await asyncFn(desc);
      } else {
        pipeline = device.createRenderPipeline(desc);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineAsync failed: ${msg}`);
    }

    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：异步构建计算管线。
   *
   * @param shaderCode - WGSL
   * @param label - 标签
   */
  const buildComputePipelineAsync = async (
    shaderCode: string,
    label: string | undefined,
  ): Promise<GPUComputePipeline> => {
    const t0 = performance.now();
    if (!shaderCode || shaderCode.trim().length === 0) {
      throw new TypeError('getOrCreateComputeAsync: shaderCode must be non-empty.');
    }
    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({ label: label ?? 'compute-shader', code: shaderCode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule (compute) failed: ${msg}`);
    }
    const desc: GPUComputePipelineDescriptor = {
      label: label ?? 'compute-pipeline',
      layout: 'auto',
      compute: {
        module,
        entryPoint: COMPUTE_ENTRY_POINT,
      },
    };
    let pipeline: GPUComputePipeline;
    try {
      const asyncFn = device.createComputePipelineAsync?.bind(device);
      if (typeof asyncFn === 'function') {
        pipeline = await asyncFn(desc);
      } else {
        pipeline = device.createComputePipeline(desc);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createComputePipelineAsync failed: ${msg}`);
    }
    addCompilationTime(t0);
    return pipeline;
  };

  const statsGetter: PipelineCacheStats = {
    get cacheSize(): number {
      return renderCache.size + computeCache.size;
    },
    get cacheHits(): number {
      return cacheHits;
    },
    get cacheMisses(): number {
      return cacheMisses;
    },
    get compilationTimeMs(): number {
      return compilationTimeMs;
    },
  };

  const api: PipelineCache = {
    getOrCreate(descriptor: PipelineDescriptor): GPURenderPipeline {
      validatePipelineDescriptor(descriptor);
      let key: string;
      try {
        key = serializePipelineDescriptor(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreate: ${msg}`);
      }
      const hit = renderCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      let pipeline: GPURenderPipeline;
      try {
        pipeline = buildRenderPipeline(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreate: ${msg}`);
      }
      renderCache.set(key, pipeline);
      return pipeline;
    },

    async getOrCreateAsync(descriptor: PipelineDescriptor): Promise<GPURenderPipeline> {
      validatePipelineDescriptor(descriptor);
      let key: string;
      try {
        key = serializePipelineDescriptor(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreateAsync: ${msg}`);
      }
      const hit = renderCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      let pipeline: GPURenderPipeline;
      try {
        pipeline = await buildRenderPipelineAsync(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreateAsync: ${msg}`);
      }
      renderCache.set(key, pipeline);
      return pipeline;
    },

    async warmup(descriptors: PipelineDescriptor[]): Promise<void> {
      if (!Array.isArray(descriptors)) {
        throw new TypeError('warmup: descriptors must be an array.');
      }
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        if (!d) {
          throw new TypeError(`warmup: descriptors[${i}] is null or undefined.`);
        }
        try {
          await api.getOrCreateAsync(d);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`warmup failed at index ${i}: ${msg}`);
        }
      }
    },

    has(descriptor: PipelineDescriptor): boolean {
      try {
        validatePipelineDescriptor(descriptor);
        const key = serializePipelineDescriptor(descriptor);
        return renderCache.has(key);
      } catch {
        return false;
      }
    },

    get stats(): PipelineCacheStats {
      return statsGetter;
    },

    clear(): void {
      for (const pl of renderCache.values()) {
        destroyPipelineIfSupported(pl);
      }
      renderCache.clear();
      for (const cp of computeCache.values()) {
        destroyPipelineIfSupported(cp);
      }
      computeCache.clear();
      cacheHits = 0;
      cacheMisses = 0;
      compilationTimeMs = 0;
    },

    getOrCreateCompute(shaderCode: string, label?: string): GPUComputePipeline {
      const key = hashStringDjb2(shaderCode);
      const hit = computeCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      const pipeline = buildComputePipeline(shaderCode, label);
      computeCache.set(key, pipeline);
      return pipeline;
    },

    async getOrCreateComputeAsync(shaderCode: string, label?: string): Promise<GPUComputePipeline> {
      const key = hashStringDjb2(shaderCode);
      const hit = computeCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      const pipeline = await buildComputePipelineAsync(shaderCode, label);
      computeCache.set(key, pipeline);
      return pipeline;
    },
  };

  return api;
}

export type { ShaderVariantKey } from './shader-assembler.ts';
