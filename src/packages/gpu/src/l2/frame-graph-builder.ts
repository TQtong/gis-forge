// ============================================================
// l2/frame-graph-builder.ts — 声明式 FrameGraph 构建器
// 层级：L2（渲染层）
// 职责：以高层 API 描述剔除 / 排序 / 标注 / 自定义计算 / 场景渲染 /
//       后处理 / 屏幕呈现 / 拾取等 Pass，并写入 RenderGraph。
//
// 设计要点：
// - begin(surface, camera) 重置本帧构建状态并清空 RenderGraph 中已有 Pass
// - build() 前向 RenderGraphImpl 注入 bindFrame，再 compile()
// - Pass id 使用稳定前缀 + 单调计数，便于日志与 DOT 对齐
// ============================================================

import type { SurfaceConfig } from '../l1/surface.ts';
import type { BufferHandle } from '../l1/buffer-pool.ts';
import type { CameraState, Viewport } from '../../../core/src/types/viewport.ts';
import type { Vec3f, Mat4f } from '../../../core/src/types/math-types.ts';
import {
  SWAPCHAIN_TEXTURE_NAME,
  type CompiledRenderGraph,
  type PassExecutionContext,
  type RenderGraph,
  type RenderPassNode,
  type ResourceReference,
  RenderGraphImpl,
} from './render-graph.ts';

// ===================== 常量 =====================

/** 场景颜色默认格式（HDR 中间缓冲常用；与后处理衔接）。 */
const DEFAULT_SCENE_COLOR_FORMAT: GPUTextureFormat = 'rgba16float';

/** 场景深度格式（GeoForge 约定 depth32float + Reversed-Z）。 */
const DEFAULT_SCENE_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** 拾取离屏颜色格式（8-bit 足够存 color-id）。 */
const DEFAULT_PICKING_COLOR_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** 后处理输出默认格式。 */
const DEFAULT_POST_OUTPUT_FORMAT: GPUTextureFormat = 'rgba16float';

/** 屏幕 Pass 清屏颜色（线性空间近似 sRGB 深灰）。 */
const DEFAULT_SCREEN_CLEAR: GPUColor = { r: 0.08, g: 0.09, b: 0.11, a: 1 };

/** 默认拾取视口像素坐标（未指定时使用视口中心）。 */
const DEFAULT_PICK_CENTER = 0.5;

/** 哈希串中使用的无效数值占位，避免 NaN/Infinity 产生碰撞。 */
const INVALID_SCALAR_PLACEHOLDER = 'invalid';

// ===================== 视口 / 表面哈希（FrameGraph 复用）=====================

/**
 * 由 SurfaceConfig 计算稳定哈希串，用于判断「表面 / 视口尺寸」相对上一帧是否变化。
 * 含逻辑尺寸、物理尺寸、DPR、纹理格式、alpha 模式与 MSAA。
 *
 * @param surface - 当前表面快照
 * @returns 稳定字符串；输入无效时返回可区分占位串
 */
function computeSurfaceHash(surface: SurfaceConfig): string {
  if (!surface || !surface.canvas) {
    return `${INVALID_SCALAR_PLACEHOLDER}:surface`;
  }
  const pr = surface.devicePixelRatio;
  const safePr = Number.isFinite(pr) && pr > 0 ? pr : 1;
  const w = Math.max(0, Math.floor(surface.width));
  const h = Math.max(0, Math.floor(surface.height));
  const pw = Math.max(0, Math.floor(surface.physicalWidth));
  const ph = Math.max(0, Math.floor(surface.physicalHeight));
  return [
    w,
    h,
    pw,
    ph,
    safePr.toFixed(6),
    String(surface.format),
    String(surface.alphaMode),
    surface.sampleCount,
  ].join('|');
}

/**
 * 由相机与逻辑视口尺寸计算稳定哈希串（center / zoom / bearing / pitch / width / height）。
 * 用于判断相对上一帧是否可跳过 `build()` 并复用 {@link CompiledRenderGraph}。
 *
 * @param camera - 当前帧相机快照
 * @param logicalWidth - 逻辑视口宽度（CSS 像素，与 {@link Viewport.width} 一致）
 * @param logicalHeight - 逻辑视口高度（CSS 像素，与 {@link Viewport.height} 一致）
 * @returns 稳定字符串
 *
 * @example
 * const h = computeCameraHash(camera, 800, 600);
 */
export function computeCameraHash(
  camera: CameraState,
  logicalWidth: number,
  logicalHeight: number,
): string {
  if (!camera) {
    return `${INVALID_SCALAR_PLACEHOLDER}:camera`;
  }
  const lon = camera.center[0];
  const lat = camera.center[1];
  const z = camera.zoom;
  const bearing = camera.bearing;
  const pitch = camera.pitch;
  const safeLon = Number.isFinite(lon) ? lon : NaN;
  const safeLat = Number.isFinite(lat) ? lat : NaN;
  const safeZ = Number.isFinite(z) ? z : NaN;
  const safeB = Number.isFinite(bearing) ? bearing : NaN;
  const safeP = Number.isFinite(pitch) ? pitch : NaN;
  const lw = Number.isFinite(logicalWidth) && logicalWidth > 0 ? Math.floor(logicalWidth) : 0;
  const lh = Number.isFinite(logicalHeight) && logicalHeight > 0 ? Math.floor(logicalHeight) : 0;
  const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(9) : INVALID_SCALAR_PLACEHOLDER);
  return [fmt(safeLon), fmt(safeLat), fmt(safeZ), fmt(safeB), fmt(safeP), lw, lh].join('|');
}

// ===================== Layer（L4 未就绪时的最小接口）=====================

/**
 * 渲染图层的最小抽象（待 L4 LayerManager 替换为正式类型）。
 * FrameGraph 仅依赖 encode 钩子完成 GPU 编码。
 */
interface Layer {
  /**
   * 图层唯一 id（与样式/数据源关联）。
   */
  readonly id: string;

  /**
   * 投影标识（用于与 Scene Pass 的 projection 对齐）。
   */
  readonly projection: string;

  /**
   * 渲染排序键（升序：数值越小越早绘制）。
   */
  readonly renderOrder: number;

  /**
   * 是否为透明通道（用于将来拆分不透明/透明子通道；当前仅保留语义）。
   */
  readonly isTransparent: boolean;

  /**
   * 将图元编码进给定的渲染通道编码器。
   *
   * @param encoder - 渲染通道编码器
   * @param camera - 当前相机快照
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 可选：拾取专用编码（颜色 ID / 深度等）。
   *
   * @param encoder - 渲染通道编码器
   * @param camera - 当前相机快照
   */
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

// ===================== 公共类型 =====================

/**
 * 后处理 Pass 工厂：由具体效果模块实现（Bloom / ToneMapping 等）。
 */
export interface PostProcessPassFactory {
  /**
   * 创建后处理执行器（持有 pipeline / bind group 的闭包在工厂内部）。
   *
   * @param inputTexture - 输入纹理（通常为场景颜色）
   * @param outputTexture - 输出纹理（可复用为下一链输入）
   * @returns 执行器（在 PassExecutionContext 上编码）
   */
  createPass(
    inputTexture: GPUTexture,
    outputTexture: GPUTexture
  ): { execute(context: PassExecutionContext): void };
}

/**
 * 声明式 FrameGraph 构建器。
 */
export interface FrameGraphBuilder {
  /**
   * 开始新一帧：重置内部计数并清空 RenderGraph。
   *
   * @param surface - 表面配置（尺寸 / 格式 / Canvas）
   * @param camera - 相机状态快照
   */
  begin(surface: SurfaceConfig, camera: CameraState): void;

  /**
   * 添加视锥剔除计算 Pass（占位实现：调试标记 + 资源校验钩子）。
   *
   * @param options - 输入 buffer 与视锥矩阵
   * @returns 新建 Pass id
   */
  addFrustumCullPass(options: { inputBuffers: BufferHandle[]; frustum: Mat4f }): string;

  /**
   * 添加深度排序计算 Pass（占位实现：调试标记）。
   *
   * @param options - 输入 buffer 与相机位置
   * @returns 新建 Pass id
   */
  addDepthSortPass(options: { inputBuffer: BufferHandle; cameraPosition: Vec3f }): string;

  /**
   * 添加标注碰撞计算 Pass（占位实现：调试标记）。
   *
   * @param options - 标注包围盒 buffer 与数量
   * @returns 新建 Pass id
   */
  addLabelCollisionPass(options: { labelBoxes: BufferHandle; labelCount: number; viewport: Viewport }): string;

  /**
   * 添加自定义计算 Pass（直接派发 workgroups）。
   *
   * @param pass - pipeline / bindGroups / 派发尺寸 / 依赖
   * @returns 新建 Pass id
   */
  addCustomComputePass(pass: {
    id: string;
    pipeline: GPUComputePipeline;
    bindGroups: GPUBindGroup[];
    workgroupCount: [number, number, number];
    dependencies?: string[];
  }): string;

  /**
   * 添加场景渲染 Pass（MRT：颜色 + 深度）。
   *
   * @param options - id / projection / layers / clear / 依赖
   * @returns 新建 Pass id（等于 options.id）
   */
  addSceneRenderPass(options: {
    id: string;
    projection: string;
    layers: Layer[];
    clearColor?: [number, number, number, number];
    dependencies?: string[];
  }): string;

  /**
   * 添加后处理 Pass（读写纹理由工厂闭包完成）。
   *
   * @param pass - id / 工厂 / 上游 Pass id（通常为场景 Pass）
   * @returns 新建 Pass id
   */
  addPostProcessPass(pass: { id: string; factory: PostProcessPassFactory; inputPassId: string }): string;

  /**
   * 添加呈现至 swapchain 的 Pass。
   *
   * @param options - 参与合成的图层
   * @returns 新建 Pass id
   */
  addScreenPass(options: { layers: Layer[] }): string;

  /**
   * 添加拾取 Pass（离屏颜色附件 + 深度）。
   *
   * @param options - 图层与可选像素坐标
   * @returns 新建 Pass id
   */
  addPickingPass(options: { layers: Layer[]; pixelX?: number; pixelY?: number }): string;

  /**
   * 编译为可执行对象（内部 bindFrame → compile）。
   */
  build(): CompiledRenderGraph;

  /**
   * 若本帧 `begin()` 判定与上一成功 `build()` 时相机与表面哈希一致，则返回缓存的
   * {@link CompiledRenderGraph}，跳过图构建与 `compile()`。
   * 调用后本帧不应再调用任何 `add*` 或 `build()`（除非再次 `begin()`）。
   *
   * @returns 上一帧编译结果；不可复用时返回 `null`
   */
  tryReuse(): CompiledRenderGraph | null;

  /**
   * 读取 FrameGraph 复用统计（调试 / 性能分析）。
   *
   * @returns `reuseCount` 为 `tryReuse` 成功次数，`rebuildCount` 为 `build()` 调用次数
   */
  getFrameGraphReuseStats(): { readonly reuseCount: number; readonly rebuildCount: number };
}

// ===================== 内部实现 =====================

/**
 * 将 Layer 按 renderOrder 稳定排序。
 *
 * @param layers - 图层数组（只读）
 * @returns 排序后的新数组
 */
function sortLayers(layers: readonly Layer[]): Layer[] {
  return [...layers].sort((a, b) => a.renderOrder - b.renderOrder);
}

/**
 * 由 SurfaceConfig 推导 Viewport（与 L0 Viewport 字段对齐）。
 *
 * @param surface - 表面配置
 * @returns Viewport 快照
 */
function surfaceToViewport(surface: SurfaceConfig): Viewport {
  const pr = surface.devicePixelRatio;
  // 防御：非法 DPR 时回退 1，避免 0/NaN 导致纹理尺寸为 0
  const safePr = Number.isFinite(pr) && pr > 0 ? pr : 1;
  const pw = Math.max(1, Math.floor(surface.physicalWidth));
  const ph = Math.max(1, Math.floor(surface.physicalHeight));
  return {
    width: Math.max(1, Math.floor(surface.width)),
    height: Math.max(1, Math.floor(surface.height)),
    physicalWidth: pw,
    physicalHeight: ph,
    pixelRatio: safePr,
  };
}

/**
 * 清空 RenderGraph 内所有 Pass（用于每帧重建）。
 *
 * @param graph - RenderGraph
 */
function clearAllPasses(graph: RenderGraph): void {
  // 复制 keys，避免在迭代中修改 Map
  const ids = [...graph.passes.keys()];
  for (const id of ids) {
    graph.removePass(id);
  }
}

/**
 * FrameGraphBuilder 的具体实现。
 */
class FrameGraphBuilderImpl implements FrameGraphBuilder {
  /** 关联的渲染图（可复用）。 */
  private readonly _graph: RenderGraph;

  /** 单调计数：视锥剔除。 */
  private _frustumCullSeq = 0;

  /** 单调计数：深度排序。 */
  private _depthSortSeq = 0;

  /** 单调计数：标注碰撞。 */
  private _labelCollisionSeq = 0;

  /** 单调计数：屏幕 Pass。 */
  private _screenSeq = 0;

  /** 单调计数：拾取 Pass。 */
  private _pickingSeq = 0;

  /** 当前帧表面（swapchain / 尺寸）。 */
  private _surface: SurfaceConfig | null = null;

  /** 当前帧相机。 */
  private _camera: CameraState | null = null;

  /** 当前帧视口。 */
  private _viewport: Viewport | null = null;

  /** 帧索引（每帧 begin 递增；首帧为 0）。 */
  private _frameIndex = -1;

  /** 上一成功 `build()` 产出的编译图（供 `tryReuse` 返回）。 */
  private _lastCompiledGraph: CompiledRenderGraph | null = null;

  /** 上一成功 `build()` 时对应的相机哈希（见 {@link computeCameraHash}）。 */
  private _lastCameraHash = '';

  /** 上一成功 `build()` 时对应的表面哈希（见 {@link computeSurfaceHash}）。 */
  private _lastSurfaceHash = '';

  /** 本帧 `begin()` 计算的相机哈希，在 `build()` 成功时写入 `_lastCameraHash`。 */
  private _pendingCameraHash = '';

  /** 本帧 `begin()` 计算的表面哈希，在 `build()` 成功时写入 `_lastSurfaceHash`。 */
  private _pendingSurfaceHash = '';

  /** 本帧是否允许 `tryReuse` 命中（由 `begin()` 与 `add*` 共同维护）。 */
  private _canReuse = false;

  /** `tryReuse` 成功次数。 */
  private _reuseCount = 0;

  /** `build()` 调用次数。 */
  private _rebuildCount = 0;

  /**
   * 构造 FrameGraphBuilder。
   *
   * @param graph - RenderGraph
   * @param device - GPUDevice（预留：后续与 PipelineCache / 能力探测对接）
   */
  constructor(graph: RenderGraph, device: GPUDevice) {
    this._graph = graph;
    // 保留参数以满足工厂签名；避免未使用变量告警
    void device;
  }

  /**
   * @inheritdoc
   */
  begin(surface: SurfaceConfig, camera: CameraState): void {
    if (!surface || !surface.canvas) {
      throw new Error('FrameGraphBuilder.begin: surface / canvas 无效');
    }
    if (!camera) {
      throw new Error('FrameGraphBuilder.begin: camera 不能为空');
    }
    const vpForHash = surfaceToViewport(surface);
    const newCameraHash = computeCameraHash(camera, vpForHash.width, vpForHash.height);
    const newSurfaceHash = computeSurfaceHash(surface);
    this._pendingCameraHash = newCameraHash;
    this._pendingSurfaceHash = newSurfaceHash;
    // 与上一成功 compile 的哈希一致时可走 tryReuse（跳过 add* / build）
    this._canReuse =
      this._lastCompiledGraph !== null &&
      newCameraHash === this._lastCameraHash &&
      newSurfaceHash === this._lastSurfaceHash;
    if (__DEV__ && this._canReuse) {
      // 开发态提示：本帧可跳过图构建（由调度器调用 tryReuse）
      // eslint-disable-next-line no-console
      console.debug('[FrameGraphBuilder] frame graph reuse eligible (hashes match)');
    }
    // 新帧：清空图与内部计数（复用路径亦不保留旧 Pass 节点，避免与 tryReuse 混用出错）
    clearAllPasses(this._graph);
    this._surface = surface;
    this._camera = camera;
    this._viewport = vpForHash;
    // 新帧序号：第一次 begin 后为 0
    this._frameIndex += 1;
    // 重置序列号以保证 id 每帧从 0 起（更利于 diff）
    this._frustumCullSeq = 0;
    this._depthSortSeq = 0;
    this._labelCollisionSeq = 0;
    this._screenSeq = 0;
    this._pickingSeq = 0;
  }

  /**
   * @inheritdoc
   */
  addFrustumCullPass(options: { inputBuffers: BufferHandle[]; frustum: Mat4f }): string {
    this.ensureBegin();
    this._canReuse = false;
    const frustum = options.frustum;
    if (!frustum || frustum.length < 16) {
      throw new Error('FrameGraphBuilder.addFrustumCullPass: frustum 必须是至少 16 元素的矩阵');
    }
    const handles = options.inputBuffers ?? [];
    const id = `frustum-cull-${this._frustumCullSeq++}`;
    const node: RenderPassNode = {
      id,
      type: 'compute',
      dependencies: [],
      inputs: [],
      outputs: [],
      execute: (ctx) => {
        // 视锥矩阵参与闭包：后续接入 compute pipeline 时写入 uniform / storage
        void frustum;
        void ctx;
        for (const h of handles) {
          if (!h || !h.buffer) {
            throw new Error(`FrameGraphBuilder: FrustumCullPass 收到非法 BufferHandle（Pass "${id}"）`);
          }
        }
        // 当前帧占位：仅插入调试标记，避免空编码器在某些驱动上产生警告
        ctx.encoder.insertDebugMarker(`geoforge:${id}:stub`);
      },
    };
    this._graph.addPass(node);
    return id;
  }

  /**
   * @inheritdoc
   */
  addDepthSortPass(options: { inputBuffer: BufferHandle; cameraPosition: Vec3f }): string {
    this.ensureBegin();
    this._canReuse = false;
    const buf = options.inputBuffer;
    const pos = options.cameraPosition;
    if (!buf || !buf.buffer) {
      throw new Error('FrameGraphBuilder.addDepthSortPass: inputBuffer 无效');
    }
    if (!pos || pos.length < 3) {
      throw new Error('FrameGraphBuilder.addDepthSortPass: cameraPosition 必须是长度≥3 的向量');
    }
    const id = `depth-sort-${this._depthSortSeq++}`;
    const node: RenderPassNode = {
      id,
      type: 'compute',
      dependencies: [],
      inputs: [],
      outputs: [],
      execute: (ctx) => {
        void buf;
        void pos;
        ctx.encoder.insertDebugMarker(`geoforge:${id}:stub`);
      },
    };
    this._graph.addPass(node);
    return id;
  }

  /**
   * @inheritdoc
   */
  addLabelCollisionPass(options: {
    labelBoxes: BufferHandle;
    labelCount: number;
    viewport: Viewport;
  }): string {
    this.ensureBegin();
    this._canReuse = false;
    const boxes = options.labelBoxes;
    const count = options.labelCount;
    const vp = options.viewport;
    if (!boxes || !boxes.buffer) {
      throw new Error('FrameGraphBuilder.addLabelCollisionPass: labelBoxes 无效');
    }
    if (!Number.isFinite(count) || count < 0) {
      throw new Error('FrameGraphBuilder.addLabelCollisionPass: labelCount 必须是非负有限数');
    }
    if (!vp || vp.physicalWidth <= 0 || vp.physicalHeight <= 0) {
      throw new Error('FrameGraphBuilder.addLabelCollisionPass: viewport 尺寸无效');
    }
    const id = `label-collision-${this._labelCollisionSeq++}`;
    const node: RenderPassNode = {
      id,
      type: 'compute',
      dependencies: [],
      inputs: [],
      outputs: [],
      execute: (ctx) => {
        void boxes;
        void count;
        void vp;
        ctx.encoder.insertDebugMarker(`geoforge:${id}:stub`);
      },
    };
    this._graph.addPass(node);
    return id;
  }

  /**
   * @inheritdoc
   */
  addCustomComputePass(pass: {
    id: string;
    pipeline: GPUComputePipeline;
    bindGroups: GPUBindGroup[];
    workgroupCount: [number, number, number];
    dependencies?: string[];
  }): string {
    this.ensureBegin();
    this._canReuse = false;
    const pid = pass.id;
    if (!pid) {
      throw new Error('FrameGraphBuilder.addCustomComputePass: id 不能为空');
    }
    if (!pass.pipeline) {
      throw new Error('FrameGraphBuilder.addCustomComputePass: pipeline 不能为空');
    }
    const wx = pass.workgroupCount[0] ?? 0;
    const wy = pass.workgroupCount[1] ?? 0;
    const wz = pass.workgroupCount[2] ?? 0;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz) || wx <= 0 || wy <= 0 || wz <= 0) {
      throw new Error('FrameGraphBuilder.addCustomComputePass: workgroupCount 必须为正整数维度');
    }
    const deps = [...(pass.dependencies ?? [])];
    const pipeline = pass.pipeline;
    const bindGroups = [...pass.bindGroups];
    const node: RenderPassNode = {
      id: pid,
      type: 'compute',
      dependencies: deps,
      inputs: [],
      outputs: [],
      execute: (ctx) => {
        const cp = ctx.encoder.beginComputePass({ label: `geoforge:${pid}` });
        try {
          cp.setPipeline(pipeline);
          for (let i = 0; i < bindGroups.length; i++) {
            const bg = bindGroups[i];
            if (!bg) {
              throw new Error(`FrameGraphBuilder: bindGroups[${i}] 为空（Pass "${pid}"）`);
            }
            cp.setBindGroup(i, bg);
          }
          cp.dispatchWorkgroups(wx, wy, wz);
        } finally {
          cp.end();
        }
      },
    };
    this._graph.addPass(node);
    return pid;
  }

  /**
   * @inheritdoc
   */
  addSceneRenderPass(options: {
    id: string;
    projection: string;
    layers: Layer[];
    clearColor?: [number, number, number, number];
    dependencies?: string[];
  }): string {
    this.ensureBegin();
    this._canReuse = false;
    const sid = options.id;
    if (!sid) {
      throw new Error('FrameGraphBuilder.addSceneRenderPass: id 不能为空');
    }
    const proj = options.projection;
    if (!proj) {
      throw new Error('FrameGraphBuilder.addSceneRenderPass: projection 不能为空');
    }
    const layers = options.layers ?? [];
    const deps = [...(options.dependencies ?? [])];
    const cc = options.clearColor ?? [0, 0, 0, 1];
    const colorName = `scene-${sid}-color`;
    const depthName = `scene-${sid}-depth`;
    const colorOut: ResourceReference = {
      name: colorName,
      type: 'texture',
      usage: 'write',
      format: DEFAULT_SCENE_COLOR_FORMAT,
    };
    const depthOut: ResourceReference = {
      name: depthName,
      type: 'texture',
      usage: 'write',
      format: DEFAULT_SCENE_DEPTH_FORMAT,
    };
    const sorted = sortLayers(layers);
    const node: RenderPassNode = {
      id: sid,
      type: 'render',
      projection: proj,
      dependencies: deps,
      inputs: [],
      outputs: [colorOut, depthOut],
      execute: (ctx) => {
        const colorView = ctx.getTextureView(colorName);
        const depthView = ctx.getTextureView(depthName);
        const pass = ctx.encoder.beginRenderPass({
          label: `geoforge:scene:${sid}`,
          colorAttachments: [
            {
              view: colorView,
              clearValue: { r: cc[0], g: cc[1], b: cc[2], a: cc[3] },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 0.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        try {
          for (const layer of sorted) {
            if (!layer) {
              continue;
            }
            if (layer.projection !== proj) {
              // 跳过后续投影不匹配图层，避免错误矩阵进入当前 pass
              continue;
            }
            layer.encode(pass, ctx.camera);
          }
        } finally {
          pass.end();
        }
      },
    };
    this._graph.addPass(node);
    return sid;
  }

  /**
   * @inheritdoc
   */
  addPostProcessPass(pass: { id: string; factory: PostProcessPassFactory; inputPassId: string }): string {
    this.ensureBegin();
    this._canReuse = false;
    const pid = pass.id;
    if (!pid) {
      throw new Error('FrameGraphBuilder.addPostProcessPass: id 不能为空');
    }
    const inputPassId = pass.inputPassId;
    if (!inputPassId) {
      throw new Error('FrameGraphBuilder.addPostProcessPass: inputPassId 不能为空');
    }
    const factory = pass.factory;
    if (!factory) {
      throw new Error('FrameGraphBuilder.addPostProcessPass: factory 不能为空');
    }
    const inputTexName = `scene-${inputPassId}-color`;
    const outName = `post-${pid}-out`;
    const outRef: ResourceReference = {
      name: outName,
      type: 'texture',
      usage: 'write',
      format: DEFAULT_POST_OUTPUT_FORMAT,
    };
    const inRef: ResourceReference = {
      name: inputTexName,
      type: 'texture',
      usage: 'read',
      format: DEFAULT_SCENE_COLOR_FORMAT,
    };
    const node: RenderPassNode = {
      id: pid,
      type: 'postprocess',
      dependencies: [inputPassId],
      inputs: [inRef],
      outputs: [outRef],
      execute: (ctx) => {
        const inTex = ctx.getTexture(inputTexName);
        const outTex = ctx.getTexture(outName);
        const exec = factory.createPass(inTex, outTex);
        exec.execute(ctx);
      },
    };
    this._graph.addPass(node);
    return pid;
  }

  /**
   * @inheritdoc
   */
  addScreenPass(options: { layers: Layer[] }): string {
    this.ensureBegin();
    this._canReuse = false;
    const id = `screen-${this._screenSeq++}`;
    const sorted = sortLayers(options.layers ?? []);
    const outRef: ResourceReference = {
      name: SWAPCHAIN_TEXTURE_NAME,
      type: 'texture',
      usage: 'write',
      format: this._surface?.format ?? 'bgra8unorm',
    };
    const node: RenderPassNode = {
      id,
      type: 'screen',
      dependencies: [],
      inputs: [],
      outputs: [outRef],
      execute: (ctx) => {
        const view = ctx.getTextureView(SWAPCHAIN_TEXTURE_NAME);
        const pass = ctx.encoder.beginRenderPass({
          label: `geoforge:screen:${id}`,
          colorAttachments: [
            {
              view,
              clearValue: DEFAULT_SCREEN_CLEAR,
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        try {
          const cam = ctx.camera;
          for (const layer of sorted) {
            if (!layer) {
              continue;
            }
            layer.encode(pass, cam);
          }
        } finally {
          pass.end();
        }
      },
    };
    this._graph.addPass(node);
    return id;
  }

  /**
   * @inheritdoc
   */
  addPickingPass(options: { layers: Layer[]; pixelX?: number; pixelY?: number }): string {
    this.ensureBegin();
    this._canReuse = false;
    const id = `picking-${this._pickingSeq++}`;
    const sorted = sortLayers(options.layers ?? []);
    const colorName = `picking-${id}-color`;
    const depthName = `picking-${id}-depth`;
    const outColor: ResourceReference = {
      name: colorName,
      type: 'texture',
      usage: 'write',
      format: DEFAULT_PICKING_COLOR_FORMAT,
    };
    const outDepth: ResourceReference = {
      name: depthName,
      type: 'texture',
      usage: 'write',
      format: DEFAULT_SCENE_DEPTH_FORMAT,
    };
    const px = options.pixelX;
    const py = options.pixelY;
    const node: RenderPassNode = {
      id,
      type: 'render',
      projection: 'picking',
      dependencies: [],
      inputs: [],
      outputs: [outColor, outDepth],
      execute: (ctx) => {
        const vp = ctx.viewport;
        const ix =
          Number.isFinite(px) ? Math.floor(px as number) : Math.floor(vp.width * DEFAULT_PICK_CENTER);
        const iy =
          Number.isFinite(py) ? Math.floor(py as number) : Math.floor(vp.height * DEFAULT_PICK_CENTER);
        ctx.encoder.insertDebugMarker(`geoforge:picking:${id}:pixel=${ix},${iy}`);
        const colorView = ctx.getTextureView(colorName);
        const depthView = ctx.getTextureView(depthName);
        const pass = ctx.encoder.beginRenderPass({
          label: `geoforge:picking:${id}`,
          colorAttachments: [
            {
              view: colorView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 0.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        try {
          const cam = ctx.camera;
          for (const layer of sorted) {
            if (!layer) {
              continue;
            }
            if (typeof layer.encodePicking === 'function') {
              layer.encodePicking(pass, cam);
            } else {
              layer.encode(pass, cam);
            }
          }
        } finally {
          pass.end();
        }
      },
    };
    this._graph.addPass(node);
    return id;
  }

  /**
   * @inheritdoc
   */
  build(): CompiledRenderGraph {
    this.ensureBegin();
    this._canReuse = false;
    const graph = this._graph;
    if (!(graph instanceof RenderGraphImpl)) {
      throw new Error('FrameGraphBuilder.build: 需要 createRenderGraph(device) 返回的 RenderGraphImpl 实例');
    }
    const cam = this._camera!;
    const vp = this._viewport!;
    const surface = this._surface!;
    graph.bindFrame(cam, vp, this._frameIndex, surface);
    const compiled = graph.compile();
    this._lastCompiledGraph = compiled;
    this._lastCameraHash = this._pendingCameraHash;
    this._lastSurfaceHash = this._pendingSurfaceHash;
    this._rebuildCount += 1;
    return compiled;
  }

  /**
   * @inheritdoc
   *
   * @remarks
   * 返回的 {@link CompiledRenderGraph} 在 `compile()` 时绑定了当时的相机 / 视口快照；
   * 仅当 {@link computeCameraHash} 与表面哈希与上一 `build()` 一致时复用才有语义保证。
   */
  tryReuse(): CompiledRenderGraph | null {
    this.ensureBegin();
    if (!this._canReuse || this._lastCompiledGraph === null) {
      return null;
    }
    this._canReuse = false;
    this._reuseCount += 1;
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.debug(
        `[FrameGraphBuilder] tryReuse: hit (reuseCount=${this._reuseCount}, rebuildCount=${this._rebuildCount})`,
      );
    }
    return this._lastCompiledGraph;
  }

  /**
   * @inheritdoc
   */
  getFrameGraphReuseStats(): { readonly reuseCount: number; readonly rebuildCount: number } {
    return { reuseCount: this._reuseCount, rebuildCount: this._rebuildCount };
  }

  /**
   * 校验 begin 已调用且状态完整。
   */
  private ensureBegin(): void {
    if (!this._surface || !this._camera || !this._viewport) {
      throw new Error('FrameGraphBuilder: 请先调用 begin(surface, camera)');
    }
  }
}

/**
 * 创建 FrameGraphBuilder。
 *
 * @param renderGraph - 由 createRenderGraph 创建的图
 * @param device - GPU 设备（用于参数校验与资源占位）
 * @returns FrameGraphBuilder
 *
 * @example
 * const rg = createRenderGraph(device);
 * const fgb = createFrameGraphBuilder(rg, device);
 * fgb.begin(surface, camera);
 * fgb.addScreenPass({ layers: [] });
 * const compiled = fgb.build();
 * compiled.execute(device.queue);
 */
export function createFrameGraphBuilder(renderGraph: RenderGraph, device: GPUDevice): FrameGraphBuilder {
  if (!device) {
    throw new Error('createFrameGraphBuilder: device 不能为空');
  }
  return new FrameGraphBuilderImpl(renderGraph, device);
}

/**
 * 开发模式标记：生产构建应剔除调试日志。
 */
declare const __DEV__: boolean;
