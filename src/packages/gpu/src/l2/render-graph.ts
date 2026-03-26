// ============================================================
// l2/render-graph.ts — RenderGraph（DAG）与编译执行
// 层级：L2（渲染层）
// 职责：以有向无环图描述 Compute / Render / Composite / PostProcess / Screen
//       等 Pass 的依赖与资源读写关系；拓扑排序（Kahn）、同投影 Render
//       Pass 合并、资源生命周期粗优化、Graphviz DOT 导出、编译为单次 submit。
//
// 设计要点：
// - Pass 之间仅允许依赖边，compile() 前检测环与缺失依赖
// - CompiledRenderGraph.execute(queue) 单 encoder → finish → submit
// - 帧状态（Camera / Viewport / frameIndex / Surface）由 bindFrame 注入，
//   供 PassExecutionContext 与 swapchain 纹理解析使用
// ============================================================

import type { CameraState, Viewport } from '../../../core/src/types/viewport.ts';

/** 构建期开发模式；生产构建中 `false` 以 tree-shake 调试分支。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 未绑定帧状态时的默认逻辑宽度（像素），避免 0 尺寸纹理创建失败。 */
const DEFAULT_VIEWPORT_WIDTH = 1;

/** 未绑定帧状态时的默认逻辑高度（像素）。 */
const DEFAULT_VIEWPORT_HEIGHT = 1;

/** 未绑定帧状态时的默认物理宽度（像素）。 */
const DEFAULT_PHYSICAL_WIDTH = 1;

/** 未绑定帧状态时的默认物理高度（像素）。 */
const DEFAULT_PHYSICAL_HEIGHT = 1;

/** 未绑定帧状态时的默认 DPR。 */
const DEFAULT_PIXEL_RATIO = 1;

/** 占位 Buffer 的默认字节大小（当 ResourceReference 未描述 buffer 尺寸时）。 */
const DEFAULT_PLACEHOLDER_BUFFER_BYTES = 256;

/** 资源名：当前帧 swapchain 颜色纹理（由 execute 动态解析）。 */
export const SWAPCHAIN_TEXTURE_NAME = 'gis-forge-swapchain-current';

/** 内部标记：已合并 Pass 的前缀，便于 DOT / 调试识别。 */
const MERGED_PASS_PREFIX = 'merged-render::';

/**
 * 默认帧缓冲清除色（深色主题，线性 RGBA）。
 * 与 {@link ClearColorConfig.clearColor} 默认一致；地平线以上未绘制区域显示为深蓝灰而非纯黑。
 */
export const DEFAULT_CLEAR_COLOR_RGBA: readonly [number, number, number, number] = [
  0.1, 0.1, 0.18, 1.0,
];

// ===================== 公共类型 =====================

/**
 * 帧缓冲清除颜色配置（swapchain / 场景 Pass 的默认 clear）。
 * 由 {@link RenderGraphImpl.setClearColor} 应用；显式传入 `addSceneRenderPass({ clearColor })` 时仍优先使用每 Pass 覆盖值。
 */
export interface ClearColorConfig {
  /**
   * 帧缓冲清除颜色（地平线以上 fallback 背景）。
   * 深色主题默认：[0.10, 0.10, 0.18, 1.0]（#1a1a2e）；浅色主题常用：[0.94, 0.95, 0.96, 1.0]（#f0f2f5）。
   * 分量线性空间 0~1；启用天空 Pass 后多数像素由天空着色覆盖。
   */
  clearColor: [number, number, number, number];
}

/**
 * RenderGraph 支持的 Pass 种类。
 * - compute：计算着色器（剔除 / 排序 / 碰撞等）
 * - render：常规几何渲染（可带 projection 分组合并）
 * - composite：多投影或离屏合成
 * - postprocess：全屏后处理（Bloom / ToneMapping 等）
 * - screen：最终呈现至 swapchain
 */
export type RenderPassType = 'compute' | 'render' | 'composite' | 'postprocess' | 'screen';

/**
 * 资源引用：描述 Pass 对纹理或 buffer 的逻辑读写需求。
 * compile() 会据此创建 GPU 资源（或绑定 swapchain 代理名）。
 */
export interface ResourceReference {
  /**
   * 逻辑资源名（在图内唯一）。
   * 约定使用 `scene-xxx-color` / `post-xxx-out` 等稳定字符串，便于 FrameGraphBuilder 串联。
   */
  readonly name: string;

  /**
   * 资源种类：纹理或 buffer。
   */
  readonly type: 'texture' | 'buffer';

  /**
   * 访问模式：只读、只写或读写。
   * 映射到 WebGPU 纹理 usage / buffer usage 的保守超集。
   */
  readonly usage: 'read' | 'write' | 'readwrite';

  /**
   * 纹理格式；buffer 时通常省略。
   * 未指定时由 compile 回退为 `rgba8unorm`（可渲染可采样）。
   */
  readonly format?: GPUTextureFormat;

  /**
   * 纹理像素尺寸；buffer 时可用于某些打包描述（可选）。
   * 未指定时使用当前 Viewport 的物理像素尺寸。
   */
  readonly size?: { width: number; height: number };
}

/**
 * 单个渲染 / 计算 Pass 节点。
 * dependencies 仅允许引用图中其他 Pass 的 id（边：依赖 → 本节点）。
 */
export interface RenderPassNode {
  /**
   * Pass 唯一 id（在整张图内唯一）。
   */
  readonly id: string;

  /**
   * Pass 类型，决定 execute 阶段的编码方式（由调用方闭包实现）。
   */
  readonly type: RenderPassType;

  /**
   * 投影标识（如 `mercator` / `globe`）；仅 render/composite 有意义。
   * autoMergePasses 仅合并「type===render 且 projection 相同」的节点。
   */
  readonly projection?: string;

  /**
   * 依赖的 Pass id 列表（必须为图中已存在或后续可解析的边，compile 时统一校验）。
   */
  readonly dependencies: readonly string[];

  /**
   * 输入资源列表（逻辑声明，用于资源分配与生命周期分析）。
   */
  readonly inputs: readonly ResourceReference[];

  /**
   * 输出资源列表。
   */
  readonly outputs: readonly ResourceReference[];

  /**
   * 将本 Pass 编码进 command encoder。
   * 典型实现：beginComputePass / beginRenderPass → 编码 → end。
   *
   * @param context - 执行期上下文（device/encoder/资源解析器/相机等）
   */
  execute(context: PassExecutionContext): void;
}

/**
 * Pass 执行期上下文：提供资源解析与帧一致的全局状态。
 * 注意：WebGPU 不允许 encoder 重入；各 Pass 需顺序打开/关闭子 Pass。
 */
export interface PassExecutionContext {
  /**
   * 当前 GPU 设备。
   */
  readonly device: GPUDevice;

  /**
   * 当前帧命令编码器（所有 Pass 共享）。
   */
  readonly encoder: GPUCommandEncoder;

  /**
   * 按逻辑名解析纹理；swapchain 名由内部映射到当前帧纹理。
   *
   * @param name - 逻辑资源名
   * @returns 已创建的 GPUTexture
   */
  readonly getTexture: (name: string) => GPUTexture;

  /**
   * 按逻辑名解析纹理视图。
   *
   * @param name - 逻辑资源名
   * @returns GPUTextureView
   */
  readonly getTextureView: (name: string) => GPUTextureView;

  /**
   * 按逻辑名解析 buffer。
   *
   * @param name - 逻辑资源名
   * @returns GPUBuffer
   */
  readonly getBuffer: (name: string) => GPUBuffer;

  /**
   * 当前帧相机状态（只读快照）。
   */
  readonly camera: Readonly<CameraState>;

  /**
   * 当前帧视口（只读快照）。
   */
  readonly viewport: Readonly<Viewport>;

  /**
   * 单调递增帧索引；用于时间抖动或缓存失效。
   */
  readonly frameIndex: number;
}

/**
 * 编译后的可执行渲染图（通常每帧由 FrameGraphBuilder.build() 生成）。
 */
export interface CompiledRenderGraph {
  /**
   * 编码并提交本帧命令缓冲。
   * 典型实现：createCommandEncoder → 顺序执行各 Pass → finish → queue.submit。
   *
   * @param queue - GPU 队列
   */
  execute(queue: GPUQueue): void;

  /**
   * 编译期统计：Pass 数、合并数、分配纹理数、command buffer 数。
   */
  readonly stats: {
    /** 拓扑展开后的 Pass 数。 */
    readonly passCount: number;

    /** autoMergePasses 折叠掉的 render pass 数量（减少的节点数）。 */
    readonly mergedPassCount: number;

    /** compile 时创建的纹理对象数（不含 swapchain 代理）。 */
    readonly texturesAllocated: number;

    /** execute 每次提交产生的 command buffer 数（通常为 1）。 */
    readonly commandBufferCount: number;
  };
}

/**
 * 运行时 RenderGraph：维护 Pass DAG 并提供分析与编译。
 */
export interface RenderGraph {
  /**
   * 添加 Pass；id 冲突时抛错。
   *
   * @param node - Pass 节点
   */
  addPass(node: RenderPassNode): void;

  /**
   * 移除 Pass；同步清理其他 Pass 依赖边上指向该 id 的边，避免悬挂引用。
   *
   * @param id - Pass id
   * @returns 是否删除成功
   */
  removePass(id: string): boolean;

  /**
   * 合并「type===render 且 projection 相同」的多个 Pass 为一个顺序执行节点。
   * 合并后仍保持原拓扑序（在各自依赖约束下尽可能串联）。
   */
  autoMergePasses(): void;

  /**
   * Kahn 算法拓扑排序；若存在环则抛出明确错误。
   *
   * @returns 拓扑序的 Pass id 列表（依赖在前）
   */
  topologicalSort(): string[];

  /**
   * 基于拓扑序构建资源首次/末次使用表，并检测明显的读写竞争（同帧内写后读冲突报警）。
   * 该结果会影响 compile 的资源池复用策略（保守实现：记录重叠区间）。
   */
  optimizeResourceLifetimes(): void;

  /**
   * 将当前图编译为可执行对象；失败时抛出。
   */
  compile(): CompiledRenderGraph;

  /**
   * 导出 Graphviz DOT（用于调试依赖结构）。
   */
  toDot(): string;

  /**
   * 设置默认帧缓冲清除颜色（RGBA，线性 0~1）。
   * 影响 {@link FrameGraphBuilder} 中未显式指定 `clearColor` 的场景 Pass 与屏幕 Pass 的 `clearValue`。
   *
   * @param color - 四通道颜色；非法分量将被钳制，全无效时回退 {@link DEFAULT_CLEAR_COLOR_RGBA}
   */
  setClearColor(color: [number, number, number, number]): void;

  /**
   * 获取当前默认清除颜色（拷贝元组，调用方可安全修改返回值）。
   */
  getClearColor(): [number, number, number, number];

  /**
   * 当前注册的所有 Pass（只读映射）。
   */
  readonly passes: ReadonlyMap<string, RenderPassNode>;
}

// ===================== 内部类型 =====================

/**
 * 帧绑定：在 compile 前由 FrameGraphBuilder 注入。
 */
interface FrameBinding {
  /** 相机快照。 */
  readonly camera: Readonly<CameraState>;

  /** 视口快照。 */
  readonly viewport: Readonly<Viewport>;

  /** 帧索引。 */
  readonly frameIndex: number;

  /**
   * 可选表面配置；用于 screen pass 解析 canvas 与 swapchain。
   */
  readonly surface?: import('../l1/surface.ts').SurfaceConfig;
}

/**
 * 资源生命周期（Pass 序列下标闭区间）。
 */
interface ResourceLifetime {
  /** 首次出现（输入或输出）的 Pass 序号。 */
  readonly first: number;

  /** 最后一次出现的 Pass 序号。 */
  readonly last: number;
}

/**
 * 合并后的资源描述（用于创建真实 GPU 对象）。
 */
interface CompiledResourceDesc {
  /** 逻辑名。 */
  readonly name: string;

  /** 纹理或 buffer。 */
  readonly kind: 'texture' | 'buffer';

  /** 像素宽（纹理）。 */
  readonly width: number;

  /** 像素高（纹理）。 */
  readonly height: number;

  /** 像素格式（纹理）。 */
  readonly format: GPUTextureFormat;

  /** buffer 字节大小（buffer）。 */
  readonly bufferByteSize: number;
}

// ===================== 工具函数 =====================

/**
 * 构建默认相机占位（仅用于未 bindFrame 的安全回退）。
 * 数值满足类型约束，不保证几何意义正确。
 *
 * @param device - 用于创建占位矩阵缓冲的设备（此处仅取模板，不实际分配）
 * @returns 占位 CameraState
 */
function createFallbackCamera(_device: GPUDevice): CameraState {
  // 使用单位矩阵占位，避免未绑定帧时访问 undefined
  const id4 = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const z = new Float32Array([0, 0, 0]);
  return {
    center: [0, 0],
    zoom: 0,
    bearing: 0,
    pitch: 0,
    roll: 0,
    viewMatrix: id4,
    projectionMatrix: id4,
    vpMatrix: id4,
    inverseVPMatrix: id4,
    position: z,
    altitude: 1,
    fov: Math.PI / 4,
  };
}

/**
 * 构建默认视口占位。
 *
 * @returns Viewport
 */
function createFallbackViewport(): Viewport {
  return {
    width: DEFAULT_VIEWPORT_WIDTH,
    height: DEFAULT_VIEWPORT_HEIGHT,
    physicalWidth: DEFAULT_PHYSICAL_WIDTH,
    physicalHeight: DEFAULT_PHYSICAL_HEIGHT,
    pixelRatio: DEFAULT_PIXEL_RATIO,
  };
}

/**
 * 校验宽高为有限正整数；非法时回退为物理视口尺寸。
 *
 * @param w - 输入宽
 * @param h - 输入高
 * @param fallbackW - 回退宽
 * @param fallbackH - 回退高
 * @returns 安全宽高
 */
function sanitizeSize(
  w: number | undefined,
  h: number | undefined,
  fallbackW: number,
  fallbackH: number
): { width: number; height: number } {
  const ww = Number.isFinite(w) && (w as number) > 0 ? Math.floor(w as number) : fallbackW;
  const hh = Number.isFinite(h) && (h as number) > 0 ? Math.floor(h as number) : fallbackH;
  return { width: Math.max(1, ww), height: Math.max(1, hh) };
}

/**
 * 将输入 RGBA 钳制到 [0,1]；任一分量非有限则使用默认值对应通道。
 *
 * @param color - 四通道输入
 * @param defaults - 回退默认值（通常为 {@link DEFAULT_CLEAR_COLOR_RGBA}）
 * @returns 安全 RGBA 元组
 */
function sanitizeClearColorTuple(
  color: [number, number, number, number],
  defaults: readonly [number, number, number, number]
): [number, number, number, number] {
  const clamp01 = (v: number, d: number): number => {
    if (!Number.isFinite(v)) {
      return d;
    }
    return Math.min(1, Math.max(0, v));
  };
  return [
    clamp01(color[0], defaults[0]),
    clamp01(color[1], defaults[1]),
    clamp01(color[2], defaults[2]),
    clamp01(color[3], defaults[3]),
  ];
}

/**
 * Kahn 拓扑排序核心实现。
 *
 * @param nodes - 所有节点 id → 节点
 * @returns 拓扑序 id 列表
 */
function kahnTopologicalSort(nodes: ReadonlyMap<string, RenderPassNode>): string[] {
  const idList = [...nodes.keys()];
  const indegree = new Map<string, number>();
  // 入度 = 指向该节点的边数：Pass n 依赖 dep，即 dep -> n，故 n 的入度 = dependencies.length
  for (const n of nodes.values()) {
    for (const dep of n.dependencies) {
      if (!nodes.has(dep)) {
        throw new Error(`RenderGraph: 依赖 "${dep}" 不存在（引用自 Pass "${n.id}"）`);
      }
    }
    indegree.set(n.id, n.dependencies.length);
  }

  const queue: string[] = [];
  for (const id of idList) {
    if ((indegree.get(id) ?? 0) === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    // 减少后继入度：所有以 id 为依赖的节点
    for (const n of nodes.values()) {
      if (n.dependencies.includes(id)) {
        const v = (indegree.get(n.id) ?? 0) - 1;
        indegree.set(n.id, v);
        if (v === 0) {
          queue.push(n.id);
        }
      }
    }
  }

  if (order.length !== nodes.size) {
    throw new Error('RenderGraph: 检测到环或非弱连通导致的拓扑排序不完整（存在循环依赖）');
  }
  return order;
}

/**
 * 收集资源描述：合并同名资源的尺寸与格式（保守取最大面积与更高精度格式优先）。
 *
 * @param orderedIds - 拓扑序 Pass id
 * @param passes - Pass 映射
 * @param viewport - 视口（像素尺寸回退）
 * @returns 资源描述表
 */
function collectResourceDesc(
  orderedIds: readonly string[],
  passes: ReadonlyMap<string, RenderPassNode>,
  viewport: Readonly<Viewport>
): Map<string, CompiledResourceDesc> {
  const map = new Map<string, CompiledResourceDesc>();

  for (const pid of orderedIds) {
    const node = passes.get(pid);
    if (!node) {
      continue;
    }
    const refs = [...node.inputs, ...node.outputs];
    for (const r of refs) {
      if (r.name === SWAPCHAIN_TEXTURE_NAME) {
        // swapchain 由 execute 动态绑定，不参与预分配
        continue;
      }
      const fallbackW = viewport.physicalWidth;
      const fallbackH = viewport.physicalHeight;
      const sz = sanitizeSize(r.size?.width, r.size?.height, fallbackW, fallbackH);
      const fmt = r.format ?? 'rgba8unorm';
      const prev = map.get(r.name);
      if (!prev) {
        map.set(r.name, {
          name: r.name,
          kind: r.type,
          width: sz.width,
          height: sz.height,
          format: fmt,
          bufferByteSize: r.type === 'buffer' ? DEFAULT_PLACEHOLDER_BUFFER_BYTES : 0,
        });
      } else {
        // 合并：取更大分辨率与「更宽」格式（此处简化：后者覆盖前者 format）
        const mergedW = Math.max(prev.width, sz.width);
        const mergedH = Math.max(prev.height, sz.height);
        map.set(r.name, {
          name: r.name,
          kind: r.type,
          width: mergedW,
          height: mergedH,
          format: fmt,
          bufferByteSize:
            r.type === 'buffer'
              ? Math.max(prev.bufferByteSize, DEFAULT_PLACEHOLDER_BUFFER_BYTES)
              : prev.bufferByteSize,
        });
      }
    }
  }
  return map;
}

/**
 * 基于拓扑序构建资源生命周期。
 *
 * @param orderedIds - 拓扑序
 * @param passes - Pass 映射
 * @returns 资源名 → 生命周期
 */
function buildResourceLifetimes(
  orderedIds: readonly string[],
  passes: ReadonlyMap<string, RenderPassNode>
): Map<string, ResourceLifetime> {
  const lifetimes = new Map<string, ResourceLifetime>();

  orderedIds.forEach((pid, index) => {
    const node = passes.get(pid);
    if (!node) {
      return;
    }
    const refs = [...node.inputs, ...node.outputs];
    for (const r of refs) {
      const cur = lifetimes.get(r.name);
      if (!cur) {
        lifetimes.set(r.name, { first: index, last: index });
      } else {
        lifetimes.set(r.name, {
          first: Math.min(cur.first, index),
          last: Math.max(cur.last, index),
        });
      }
    }
  });
  return lifetimes;
}

// ===================== RenderGraphImpl =====================

/**
 * RenderGraph 的具体实现。
 */
export class RenderGraphImpl implements RenderGraph {
  /** Pass 映射（可变，合并/删除时更新）。 */
  private readonly _passes = new Map<string, RenderPassNode>();

  /** GPUDevice 引用。 */
  private readonly _device: GPUDevice;

  /** 最近一次 autoMergePasses 折叠掉的 render pass 数量。 */
  private _mergedPassCount = 0;

  /** optimizeResourceLifetimes 结果缓存。 */
  private _lifetimeMap = new Map<string, ResourceLifetime>();

  /** 帧绑定（compile 使用）。 */
  private _frame: FrameBinding | null = null;

  /**
   * 默认帧缓冲清除色（swapchain / 场景 Pass 未显式指定 clear 时使用）。
   * 初始为深色主题 {@link DEFAULT_CLEAR_COLOR_RGBA}。
   */
  private _clearColor: [number, number, number, number] = [
    DEFAULT_CLEAR_COLOR_RGBA[0],
    DEFAULT_CLEAR_COLOR_RGBA[1],
    DEFAULT_CLEAR_COLOR_RGBA[2],
    DEFAULT_CLEAR_COLOR_RGBA[3],
  ];

  /**
   * 构造 RenderGraph。
   *
   * @param device - WebGPU 设备
   */
  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * @inheritdoc
   */
  get passes(): ReadonlyMap<string, RenderPassNode> {
    return this._passes;
  }

  /**
   * 绑定当前帧状态（由 FrameGraphBuilder 在 compile 前调用）。
   *
   * @param camera - 相机
   * @param viewport - 视口
   * @param frameIndex - 帧号
   * @param surface - 可选表面
   */
  bindFrame(
    camera: Readonly<CameraState>,
    viewport: Readonly<Viewport>,
    frameIndex: number,
    surface?: FrameBinding['surface']
  ): void {
    this._frame = { camera, viewport, frameIndex, surface };
  }

  /**
   * @inheritdoc
   */
  setClearColor(color: [number, number, number, number]): void {
    if (!Array.isArray(color) || color.length < 4) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.warn(
          'RenderGraphImpl.setClearColor: 需要长度为 4 的 RGBA 元组，已回退默认深色清除色',
        );
      }
      this._clearColor = sanitizeClearColorTuple(
        [...DEFAULT_CLEAR_COLOR_RGBA] as [number, number, number, number],
        DEFAULT_CLEAR_COLOR_RGBA,
      );
      return;
    }
    const allFinite = [color[0], color[1], color[2], color[3]].every((c) => Number.isFinite(c));
    if (!allFinite) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.warn(
          'RenderGraphImpl.setClearColor: 存在非有限分量，已按通道回退到默认或钳制到 [0,1]',
        );
      }
    }
    this._clearColor = sanitizeClearColorTuple(
      [color[0], color[1], color[2], color[3]],
      DEFAULT_CLEAR_COLOR_RGBA,
    );
  }

  /**
   * @inheritdoc
   */
  getClearColor(): [number, number, number, number] {
    return [
      this._clearColor[0],
      this._clearColor[1],
      this._clearColor[2],
      this._clearColor[3],
    ];
  }

  /**
   * @inheritdoc
   */
  addPass(node: RenderPassNode): void {
    if (this._passes.has(node.id)) {
      throw new Error(`RenderGraph.addPass: Pass id 冲突 "${node.id}"`);
    }
    for (const dep of node.dependencies) {
      if (dep === node.id) {
        throw new Error(`RenderGraph.addPass: Pass "${node.id}" 不能依赖自身`);
      }
    }
    this._passes.set(node.id, node);
  }

  /**
   * @inheritdoc
   */
  removePass(id: string): boolean {
    if (!this._passes.has(id)) {
      return false;
    }
    this._passes.delete(id);
    // 清理所有依赖边
    for (const n of this._passes.values()) {
      if (n.dependencies.includes(id)) {
        // RenderPassNode 只读视图不可变；需要替换对象
        const deps = n.dependencies.filter((d) => d !== id);
        const updated: RenderPassNode = {
          ...n,
          dependencies: deps,
        };
        this._passes.set(n.id, updated);
      }
    }
    return true;
  }

  /**
   * @inheritdoc
   */
  autoMergePasses(): void {
    this._mergedPassCount = 0;
    if (this._passes.size === 0) {
      return;
    }

    // 分组：projection key -> pass ids（仅 type===render）
    const groups = new Map<string, string[]>();
    for (const n of this._passes.values()) {
      if (n.type !== 'render') {
        continue;
      }
      const key = n.projection ?? '__undefined__';
      const arr = groups.get(key) ?? [];
      arr.push(n.id);
      groups.set(key, arr);
    }

    for (const [projKey, ids] of groups) {
      if (ids.length <= 1) {
        continue;
      }

      // 依据当前拓扑序确定稳定合并顺序
      const order = kahnTopologicalSort(this._passes);
      const orderedSet = new Set(ids);
      const orderedIds = order.filter((x) => orderedSet.has(x));

      const nodes = orderedIds.map((id) => this._passes.get(id)!);

      // 合并 dependencies（并集），并移除组内互依赖边
      const depSet = new Set<string>();
      for (const n of nodes) {
        for (const d of n.dependencies) {
          if (!orderedSet.has(d)) {
            depSet.add(d);
          }
        }
      }

      // 合并 inputs/outputs（后者覆盖同名资源的描述）
      const inputMap = new Map<string, ResourceReference>();
      const outputMap = new Map<string, ResourceReference>();
      for (const n of nodes) {
        for (const i of n.inputs) {
          inputMap.set(i.name, i);
        }
        for (const o of n.outputs) {
          outputMap.set(o.name, o);
        }
      }

      const mergedId = `${MERGED_PASS_PREFIX}${projKey}::${nodes[0]!.id}`;
      const execute: RenderPassNode['execute'] = (ctx) => {
        for (const n of nodes) {
          n.execute(ctx);
        }
      };

      const mergedNode: RenderPassNode = {
        id: mergedId,
        type: 'render',
        projection: projKey === '__undefined__' ? undefined : projKey,
        dependencies: [...depSet],
        inputs: [...inputMap.values()],
        outputs: [...outputMap.values()],
        execute,
      };

      // 删除旧节点并插入合并节点
      for (const id of orderedIds) {
        this._passes.delete(id);
      }
      this._passes.set(mergedId, mergedNode);
      this._mergedPassCount += orderedIds.length - 1;

      // 重写所有外部依赖指向
      for (const n of this._passes.values()) {
        let deps = [...n.dependencies];
        let changed = false;
        deps = deps.map((d) => {
          if (orderedSet.has(d)) {
            changed = true;
            return mergedId;
          }
          return d;
        });
        if (changed) {
          // 去重
          deps = [...new Set(deps)];
          this._passes.set(n.id, { ...n, dependencies: deps });
        }
      }
    }
  }

  /**
   * @inheritdoc
   */
  topologicalSort(): string[] {
    return kahnTopologicalSort(this._passes);
  }

  /**
   * @inheritdoc
   */
  optimizeResourceLifetimes(): void {
    if (this._passes.size === 0) {
      this._lifetimeMap.clear();
      return;
    }
    const order = kahnTopologicalSort(this._passes);
    this._lifetimeMap = buildResourceLifetimes(order, this._passes);

    // 同一 Pass 内同名资源若同时出现读与写引用，发出警告（保守提示）
    for (const n of this._passes.values()) {
      const byName = new Map<string, ResourceReference[]>();
      for (const r of [...n.inputs, ...n.outputs]) {
        const arr = byName.get(r.name) ?? [];
        arr.push(r);
        byName.set(r.name, arr);
      }
      for (const [name, refs] of byName) {
        if (refs.length <= 1) {
          continue;
        }
        const hasRead = refs.some((r) => r.usage === 'read' || r.usage === 'readwrite');
        const hasWrite = refs.some((r) => r.usage === 'write' || r.usage === 'readwrite');
        if (hasRead && hasWrite) {
          // eslint-disable-next-line no-console
          console.warn(
            `RenderGraph.optimizeResourceLifetimes: 资源 "${name}" 在 Pass "${n.id}" 的多条引用中同时包含读与写，请确认同步与 Pass 划分`
          );
        }
      }
    }
  }

  /**
   * @inheritdoc
   */
  compile(): CompiledRenderGraph {
    if (this._passes.size === 0) {
      throw new Error('RenderGraph.compile: 空图，无法编译');
    }

    const order = kahnTopologicalSort(this._passes);
    const frame = this._frame;
    const camera = frame?.camera ?? createFallbackCamera(this._device);
    const viewport = frame?.viewport ?? createFallbackViewport();
    const frameIndex = frame?.frameIndex ?? 0;
    const surface = frame?.surface;

    if (!frame) {
      // eslint-disable-next-line no-console
      console.warn(
        'RenderGraph.compile: 未调用 bindFrame，已使用占位 Camera/Viewport；请在 compile 前注入真实帧状态'
      );
    }

    const resourceDesc = collectResourceDesc(order, this._passes, viewport);

    const compiled = compileInternal({
      device: this._device,
      order,
      passes: this._passes,
      resourceDesc,
      mergedPassCount: this._mergedPassCount,
      camera,
      viewport,
      frameIndex,
      surface,
    });
    return compiled;
  }

  /**
   * @inheritdoc
   */
  toDot(): string {
    const lines: string[] = [];
    lines.push('digraph RenderGraph {');
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=rounded];');
    for (const n of this._passes.values()) {
      const label = `${n.id}\\n${n.type}${n.projection ? `\\nproj=${n.projection}` : ''}`;
      lines.push(`  "${n.id}" [label="${label}"];`);
    }
    for (const n of this._passes.values()) {
      for (const d of n.dependencies) {
        lines.push(`  "${d}" -> "${n.id}";`);
      }
    }
    lines.push('}');
    return lines.join('\n');
  }
}

/**
 * 内部编译函数：生成 CompiledRenderGraph 闭包。
 *
 * @param args - 编译参数包
 * @returns 可执行对象
 */
function compileInternal(args: {
  readonly device: GPUDevice;
  readonly order: readonly string[];
  readonly passes: ReadonlyMap<string, RenderPassNode>;
  readonly resourceDesc: ReadonlyMap<string, CompiledResourceDesc>;
  readonly mergedPassCount: number;
  readonly camera: Readonly<CameraState>;
  readonly viewport: Readonly<Viewport>;
  readonly frameIndex: number;
  readonly surface?: FrameBinding['surface'];
}): CompiledRenderGraph {
  const {
    device,
    order,
    passes,
    resourceDesc,
    mergedPassCount,
    camera,
    viewport,
    frameIndex,
    surface,
  } = args;

  /** 编译期统计：分配的纹理数量（不含 swapchain 代理名）。 */
  const texturesAllocatedCount = [...resourceDesc.values()].filter((d) => d.kind === 'texture').length;

  /**
   * 执行一帧：创建资源、编码、提交。
   *
   * @param queue - 队列
   */
  const execute = (queue: GPUQueue): void => {
    if (!queue) {
      throw new Error('CompiledRenderGraph.execute: queue 不能为空');
    }

    const textures = new Map<string, GPUTexture>();
    const textureViews = new Map<string, GPUTextureView>();
    const buffers = new Map<string, GPUBuffer>();

    // 预创建资源（非 swapchain）
    try {
      for (const [name, desc] of resourceDesc) {
        if (name === SWAPCHAIN_TEXTURE_NAME) {
          continue;
        }
        if (desc.kind === 'texture') {
          const tex = device.createTexture({
            label: `RenderGraph:${name}`,
            size: { width: desc.width, height: desc.height, depthOrArrayLayers: 1 },
            format: desc.format,
            usage:
              GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.STORAGE_BINDING |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.COPY_DST,
          });
          textures.set(name, tex);
          textureViews.set(name, tex.createView({ label: `RenderGraphView:${name}` }));
        } else {
          const buf = device.createBuffer({
            label: `RenderGraphBuffer:${name}`,
            size: Math.max(4, desc.bufferByteSize),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          });
          buffers.set(name, buf);
        }
      }
    } catch (e) {
      // 失败时清理已分配对象
      for (const t of textures.values()) {
        t.destroy();
      }
      for (const b of buffers.values()) {
        b.destroy();
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    const encoder = device.createCommandEncoder({ label: 'RenderGraphFrame' });

    /**
     * 解析 swapchain 纹理视图（延迟到执行期）。
     *
     * @returns 当前 drawable 纹理
     */
    const resolveSwapchainTexture = (): GPUTexture => {
      if (!surface) {
        throw new Error(
          'CompiledRenderGraph: 需要 swapchain，但 compile 前未绑定 SurfaceConfig；请在 bindFrame 传入 surface'
        );
      }
      const canvas = surface.canvas;
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) {
        throw new Error('CompiledRenderGraph: Canvas 未配置 WebGPU 上下文');
      }
      const tex = ctx.getCurrentTexture();
      return tex;
    };

    /**
     * 获取纹理：支持逻辑资源名与 swapchain 代理名。
     *
     * @param name - 逻辑名
     * @returns 纹理对象
     */
    const getTexture = (name: string): GPUTexture => {
      if (!name) {
        throw new Error('PassExecutionContext.getTexture: name 不能为空');
      }
      if (name === SWAPCHAIN_TEXTURE_NAME) {
        return resolveSwapchainTexture();
      }
      const t = textures.get(name);
      if (!t) {
        throw new Error(`PassExecutionContext.getTexture: 未找到资源 "${name}"`);
      }
      return t;
    };

    /**
     * 获取纹理视图。
     *
     * @param name - 逻辑名
     * @returns 视图对象
     */
    const getTextureView = (name: string): GPUTextureView => {
      if (!name) {
        throw new Error('PassExecutionContext.getTextureView: name 不能为空');
      }
      if (name === SWAPCHAIN_TEXTURE_NAME) {
        return resolveSwapchainTexture().createView({ label: 'swapchain-view' });
      }
      const v = textureViews.get(name);
      if (!v) {
        throw new Error(`PassExecutionContext.getTextureView: 未找到资源 "${name}"`);
      }
      return v;
    };

    /**
     * 获取 buffer。
     *
     * @param name - 逻辑名
     * @returns buffer
     */
    const getBuffer = (name: string): GPUBuffer => {
      const b = buffers.get(name);
      if (!b) {
        throw new Error(`PassExecutionContext.getBuffer: 未找到资源 "${name}"`);
      }
      return b;
    };

    const passCtx: PassExecutionContext = {
      device,
      encoder,
      getTexture,
      getTextureView,
      getBuffer,
      camera,
      viewport,
      frameIndex,
    };

    try {
      for (const pid of order) {
        const node = passes.get(pid);
        if (!node) {
          throw new Error(`CompiledRenderGraph: 内部错误，缺失 Pass "${pid}"`);
        }
        node.execute(passCtx);
      }

      const cb = encoder.finish({ label: 'RenderGraphCommandBuffer' });
      queue.submit([cb]);
    } catch (e) {
      // 出错释放本帧纹理
      for (const t of textures.values()) {
        t.destroy();
      }
      for (const b of buffers.values()) {
        b.destroy();
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    // 成功路径：销毁瞬时资源（下一帧重新 compile/build）
    for (const t of textures.values()) {
      t.destroy();
    }
    for (const b of buffers.values()) {
      b.destroy();
    }
  };

  return {
    execute,
    stats: {
      passCount: order.length,
      mergedPassCount: mergedPassCount,
      texturesAllocated: texturesAllocatedCount,
      commandBufferCount: 1,
    },
  };
}

/**
 * 创建与指定 `GPUDevice` 关联的 RenderGraph。
 * 返回实例同时支持 `bindFrame`（由 FrameGraphBuilder 在 compile 前注入帧状态）。
 *
 * @param device - WebGPU 设备
 * @returns RenderGraph 实现
 *
 * @example
 * const rg = createRenderGraph(device);
 * (rg as RenderGraphImpl).bindFrame(camera, viewport, 0, surface);
 * const compiled = rg.compile();
 * compiled.execute(device.queue);
 */
export function createRenderGraph(device: GPUDevice): RenderGraph {
  if (!device) {
    throw new Error('createRenderGraph: device 不能为空');
  }
  return new RenderGraphImpl(device);
}
