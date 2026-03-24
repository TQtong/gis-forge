// ============================================================
// Tiles3DLayer.ts — 3D Tiles 图层（L4 图层包）
// 职责：管理 3D Tiles (OGC/Cesium) 瓦片集的生命周期：
//       加载 tileset.json → 构建 BVH → 每帧遍历（SSE + 视锥剔除）
//       → 异步加载内容（b3dm/glb/pnts）→ GPU 提交渲染命令。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';
import type { CameraController, CameraAnimation } from '../../runtime/src/camera-controller.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建由 tree-shake 移除）
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/**
 * Tiles3DLayer 模块错误码，前缀 `TILES3D_` 以避免跨模块碰撞。
 */
const TILES3D_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'TILES3D_INVALID_OPTIONS',
  /** tileset.json 加载或解析失败 */
  TILESET_LOAD_FAILED: 'TILES3D_TILESET_LOAD_FAILED',
  /** 瓦片内容加载超时 */
  TILE_LOAD_TIMEOUT: 'TILES3D_TILE_LOAD_TIMEOUT',
  /** 瓦片内容解码失败 */
  TILE_DECODE_FAILED: 'TILES3D_TILE_DECODE_FAILED',
  /** GPU 内存超预算 */
  MEMORY_EXCEEDED: 'TILES3D_MEMORY_EXCEEDED',
  /** 包围体类型不可识别 */
  INVALID_BOUNDING_VOLUME: 'TILES3D_INVALID_BOUNDING_VOLUME',
  /** SSE 参数超出有效区间 */
  INVALID_SSE: 'TILES3D_INVALID_SSE',
  /** 内存预算参数超出有效区间 */
  INVALID_MEMORY: 'TILES3D_INVALID_MEMORY',
  /** flyTo 时根节点包围体不可用 */
  NO_ROOT_BOUNDING: 'TILES3D_NO_ROOT_BOUNDING',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认最大屏幕空间误差阈值（像素） */
const DEFAULT_MAX_SSE = 16;

/** 默认 GPU 内存预算上限（MB） */
const DEFAULT_MAX_MEMORY_MB = 512;

/** 默认点云渲染点大小（像素） */
const DEFAULT_POINT_SIZE = 2.0;

/** 默认最大并发请求数 */
const DEFAULT_MAX_CONCURRENT = 6;

/** b3dm 格式魔术字节（ASCII 'b3dt' 的小端序 uint32） */
const B3DM_MAGIC = 0x62336474;

/** i3dm 格式魔术字节（ASCII 'i3dt' 的小端序 uint32） */
const I3DM_MAGIC = 0x69336474;

/** pnts 格式魔术字节（ASCII 'pnts' 的小端序 uint32） */
const PNTS_MAGIC = 0x736E7470;

/** glTF Binary 格式魔术字节（ASCII 'glTF' 的小端序 uint32） */
const GLB_MAGIC = 0x46546C67;

/** 内存淘汰目标比例——降至预算的 90% 后停止淘汰 */
const MEMORY_EVICT_TARGET = 0.9;

/** 单个瓦片加载超时时间（毫秒） */
const MAX_TILE_LOAD_TIME_MS = 30000;

/** SSE 参数允许的最小值 */
const MIN_SSE = 1;

/** SSE 参数允许的最大值 */
const MAX_SSE = 256;

/** 内存预算允许的最小值（MB） */
const MIN_MEMORY_MB = 64;

/** 内存预算允许的最大值（MB） */
const MAX_MEMORY_MB = 4096;

/** 点大小允许的最小值（像素） */
const MIN_POINT_SIZE = 0.5;

/** 点大小允许的最大值（像素） */
const MAX_POINT_SIZE = 50;

/** 最大并发请求下限 */
const MIN_CONCURRENT = 1;

/** 最大并发请求上限 */
const MAX_CONCURRENT = 32;

/** 字节转 MB 的除数 */
const BYTES_PER_MB = 1024 * 1024;

/** flyTo 默认距离安全系数（在包围球半径基础上乘以此系数） */
const FLY_TO_DISTANCE_FACTOR = 1.5;

/** 默认模型缩放比例 */
const DEFAULT_MODEL_SCALE = 1.0;

/** 瓦片 ID 自增计数器起始值 */
const TILE_ID_START = 0;

/** 度 → 弧度转换系数 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度 → 度转换系数 */
const RAD_TO_DEG = 180 / Math.PI;

/** WGS84 长半轴（米），用于 region 类型包围体的球面→笛卡尔转换 */
const WGS84_A = 6378137.0;

// ---------------------------------------------------------------------------
// Tiles3DStyle（外部配置：条件样式）
// ---------------------------------------------------------------------------

/**
 * 3D Tiles 瓦片集条件样式配置。
 * 对标 Cesium 3D Tiles Styling：支持常量值和条件表达式。
 *
 * @example
 * const style: Tiles3DStyle = {
 *   color: {
 *     conditions: [
 *       ['${height} > 100', 'color("red")'],
 *       ['true', 'color("white")'],
 *     ],
 *   },
 *   show: '${class} !== "vegetation"',
 *   pointSize: 3,
 * };
 */
export interface Tiles3DStyle {
  /**
   * 颜色样式。
   * 字符串时为直接 CSS 颜色或样式表达式；
   * 对象时包含条件数组 `conditions`，按顺序匹配第一条为 true 的条件。
   * 条件格式：`[表达式字符串, 颜色表达式字符串]`。
   * 可选——缺省使用瓦片自身材质颜色。
   */
  readonly color?: string | { readonly conditions: ReadonlyArray<readonly [string, string]> };

  /**
   * 可见性过滤表达式。
   * 布尔值时直接控制显隐；字符串时为样式表达式（如 `'${class} !== "tree"'`）。
   * 可选——缺省全部显示。
   */
  readonly show?: string | boolean;

  /**
   * 点云点大小。
   * 数值时为固定像素大小；字符串时为样式表达式。
   * 可选——缺省使用 Tiles3DLayerOptions.pointSize。
   */
  readonly pointSize?: number | string;
}

// ---------------------------------------------------------------------------
// Tiles3DLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 3D Tiles 图层构造选项。
 * 由用户传入 `createTiles3DLayer`，驱动图层初始化和 tileset.json 加载。
 *
 * @example
 * const opts: Tiles3DLayerOptions = {
 *   id: 'buildings-3d',
 *   url: 'https://example.com/tileset.json',
 *   maximumScreenSpaceError: 8,
 *   maximumMemoryUsage: 1024,
 *   show: true,
 *   modelScale: 1.0,
 *   modelOffset: [0, 0, 0],
 *   castShadow: false,
 *   receiveShadow: true,
 *   pointSize: 2.0,
 *   maxConcurrentRequests: 6,
 * };
 */
export interface Tiles3DLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * tileset.json 的 URL 地址。
   * 支持绝对路径和相对路径；相对路径以当前页面为基准。
   * 必填。
   */
  readonly url: string;

  /**
   * 最大屏幕空间误差阈值（像素）。
   * SSE 大于此值时细化（加载子瓦片），小于时不再细化。
   * 值越小细节越丰富，渲染开销越大。
   * 范围 [1, 256]。
   * 可选，默认 16。
   */
  readonly maximumScreenSpaceError?: number;

  /**
   * 最大 GPU 内存使用量（MB）。
   * 超过此预算时触发非可见瓦片淘汰。
   * 范围 [64, 4096]。
   * 可选，默认 512。
   */
  readonly maximumMemoryUsage?: number;

  /**
   * 图层是否可见。
   * false 时跳过遍历和渲染。
   * 可选，默认 true。
   */
  readonly show?: boolean;

  /**
   * 模型整体缩放比例。
   * 应用于所有瓦片的世界变换矩阵。
   * 通常用于单位换算（如米→其他单位）。
   * 可选，默认 1.0。
   */
  readonly modelScale?: number;

  /**
   * 模型整体平移偏移量 [x, y, z]（米）。
   * 应用于所有瓦片的世界变换矩阵。
   * 用于将模型移至正确的地理位置。
   * 可选，默认 [0, 0, 0]。
   */
  readonly modelOffset?: readonly [number, number, number];

  /**
   * 是否投射阴影。
   * true 时此图层参与 CSM 阴影 Pass 的投射端。
   * 可选，默认 false。
   */
  readonly castShadow?: boolean;

  /**
   * 是否接收阴影。
   * true 时此图层在主 Pass 中采样阴影贴图。
   * 可选，默认 true。
   */
  readonly receiveShadow?: boolean;

  /**
   * 点云默认点大小（像素）。
   * 仅对 pnts 格式内容有效。
   * 范围 [0.5, 50]。
   * 可选，默认 2.0。
   */
  readonly pointSize?: number;

  /**
   * 条件样式配置。
   * 可选——缺省使用瓦片原始材质。
   */
  readonly style?: Tiles3DStyle;

  /**
   * 最大并发瓦片内容请求数。
   * 限制同时发出的 HTTP 请求，避免浏览器连接池耗尽。
   * 范围 [1, 32]。
   * 可选，默认 6。
   */
  readonly maxConcurrentRequests?: number;
}

// ---------------------------------------------------------------------------
// TilesetJSON / TileJSON / BoundingVolume（tileset.json 解析结构）
// ---------------------------------------------------------------------------

/**
 * tileset.json 根结构。
 * 对标 OGC 3D Tiles 1.0 规范的 JSON Schema。
 *
 * @internal 仅模块内使用，不导出。
 */
interface TilesetJSON {
  /** 资产元数据（version/tilesetVersion/gltfUpAxis 等） */
  readonly asset: {
    /** 3D Tiles 规范版本，如 "1.0" */
    readonly version: string;
    /** 可选的瓦片集特定版本号 */
    readonly tilesetVersion?: string;
    /** glTF 向上轴方向，"Y"（默认）或 "Z" */
    readonly gltfUpAxis?: string;
  };

  /** 根瓦片的几何误差（米），驱动最顶层 SSE 判断 */
  readonly geometricError: number;

  /** 根瓦片节点（递归结构） */
  readonly root: TileJSON;

  /** 可选的全局属性元数据（如 height 的最小/最大值） */
  readonly properties?: Record<string, { readonly minimum: number; readonly maximum: number }>;
}

/**
 * 单个瓦片节点的 JSON 描述。
 * 递归结构：每个节点可包含 children 子数组。
 *
 * @internal 仅模块内使用。
 */
interface TileJSON {
  /** 包围体——三种格式之一：box / region / sphere */
  readonly boundingVolume: BoundingVolume;

  /** 该瓦片的几何误差（米），用于 SSE 计算 */
  readonly geometricError: number;

  /** 瓦片内容引用（如 { uri: "tile.b3dm" }） */
  readonly content?: { readonly uri?: string; readonly url?: string };

  /** 子瓦片数组 */
  readonly children?: readonly TileJSON[];

  /** 细化策略："ADD" 或 "REPLACE"，默认继承父级 */
  readonly refine?: 'ADD' | 'REPLACE';

  /** 4x4 行主序变换矩阵（16 元素数组），将此瓦片从局部空间变换到父空间 */
  readonly transform?: readonly number[];

  /** 视角请求包围体——仅当观察者在此体内时才触发加载 */
  readonly viewerRequestVolume?: BoundingVolume;
}

/**
 * 3D Tiles 包围体——三种互斥格式之一。
 *
 * - **box**: 12 个 number，布局 `[cx,cy,cz, x0,x1,x2, y0,y1,y2, z0,z1,z2]`
 *   前 3 为中心，后 9 为半轴向量（列主序 3x3）。
 * - **region**: 6 个 number `[west,south,east,north,minH,maxH]`
 *   前 4 为弧度经纬度，后 2 为椭球面高度（米）。
 * - **sphere**: 4 个 number `[cx,cy,cz,r]`
 *   前 3 为中心，第 4 为半径。
 *
 * @internal 仅模块内使用。
 */
interface BoundingVolume {
  /** OBB 定义：12 个 number */
  readonly box?: readonly number[];
  /** 地理区域定义：6 个 number（弧度+米） */
  readonly region?: readonly number[];
  /** 包围球定义：4 个 number */
  readonly sphere?: readonly number[];
}

// ---------------------------------------------------------------------------
// BoundingVolumeComputed（运行时计算的包围体）
// ---------------------------------------------------------------------------

/**
 * 从 JSON 包围体解析并经世界变换后的运行时包围体。
 * 所有瓦片统一使用此结构进行视锥剔除和 SSE 计算。
 *
 * @internal 仅模块内使用。
 */
interface BoundingVolumeComputed {
  /**
   * 包围体中心（世界坐标）。
   * Float32Array 长度 3，布局 [x, y, z]。
   */
  center: Float32Array;

  /**
   * OBB 半轴矩阵（世界坐标）。
   * Float32Array 长度 9，列主序 3x3，三个列向量分别为 X/Y/Z 半轴。
   * 对于球体和区域类型，此值为单位矩阵 × 半径（退化为球）。
   */
  halfAxes: Float32Array;

  /**
   * 包围球半径（世界坐标，米）。
   * 对 OBB 取包围球半径 = 三半轴长度的向量模；
   * 对 sphere 直接赋值；对 region 由地理范围估算。
   */
  radius: number;
}

// ---------------------------------------------------------------------------
// TileContentState（瓦片内容加载状态机）
// ---------------------------------------------------------------------------

/**
 * 瓦片内容加载状态。
 * 状态流转：`unloaded` → `loading` → `loaded` | `failed`
 *          `loaded` → `unloaded`（淘汰时）
 *
 * @internal 仅模块内使用。
 */
type TileContentState = 'unloaded' | 'loading' | 'loaded' | 'failed';

// ---------------------------------------------------------------------------
// TileRenderData（每瓦片 GPU 渲染数据占位）
// ---------------------------------------------------------------------------

/**
 * 单个瓦片的渲染资源句柄集合。
 * MVP 阶段为占位结构——完整实现需要 L1/BufferPool + TextureManager 管理的实际 GPU 资源。
 * b3dm/glb/pnts 解码在 Worker 中完成，解码结果通过 Transferable 传回主线程后填充此结构。
 *
 * @internal 仅模块内使用。
 */
interface TileRenderData {
  /** 内容类型标识（根据魔术字节判定） */
  type: 'b3dm' | 'i3dm' | 'pnts' | 'glb' | 'unknown';

  /** 顶点缓冲区句柄 ID（MVP 占位：-1 表示未分配） */
  vertexBuffer: number;

  /** 索引缓冲区句柄 ID（MVP 占位：-1 表示未分配） */
  indexBuffer: number;

  /** 顶点数量 */
  vertexCount: number;

  /** 索引数量（0 表示非索引绘制） */
  indexCount: number;

  /** 材质描述（MVP 占位：简单的颜色 + 纹理标记） */
  material: {
    /** 基础颜色 RGBA [0,1] */
    baseColor: Float32Array;
    /** 是否有漫反射纹理 */
    hasTexture: boolean;
  };

  /** 纹理句柄 ID 列表（MVP 占位） */
  textures: number[];

  /** 实例缓冲区句柄 ID（i3dm 用，MVP 占位：-1 表示无实例化） */
  instanceBuffer: number;

  /** 实例数量（i3dm 用，0 = 无实例化） */
  instanceCount: number;

  /** 批次表属性（Batch Table）——用于样式查询和拾取 */
  batchTable: Record<string, unknown> | null;

  /** 此瓦片 GPU 资源占用字节数 */
  gpuBytes: number;
}

// ---------------------------------------------------------------------------
// RuntimeTile（运行时瓦片节点——BVH 树节点）
// ---------------------------------------------------------------------------

/**
 * 运行时瓦片节点——3D Tiles BVH 树中的一个节点。
 * 包含从 TileJSON 解析的静态数据和运行时动态状态。
 *
 * @internal 仅模块内使用。
 */
interface RuntimeTile {
  /** 唯一递增 ID，在整棵树中不重复 */
  id: number;

  /** 原始 JSON 节点引用（保留以便重新解析子瓦片集） */
  json: TileJSON;

  /** 世界空间包围体（经 worldTransform 变换后） */
  worldBoundingVolume: BoundingVolumeComputed;

  /** 几何误差（米），从 JSON 继承 */
  geometricError: number;

  /** 细化策略："ADD" 累加渲染 / "REPLACE" 替换渲染 */
  refine: 'ADD' | 'REPLACE';

  /** 世界变换矩阵 = 祖先链变换的累积乘积（列主序 4x4） */
  worldTransform: Float32Array;

  /** 父节点引用（根节点为 null） */
  parent: RuntimeTile | null;

  /** 子节点数组 */
  children: RuntimeTile[];

  /** 瓦片内容的 URI（相对于 tileset.json 的路径，null = 无内容） */
  contentUri: string | null;

  /** 内容加载状态 */
  contentState: TileContentState;

  /** GPU 渲染数据（loaded 后填充，unloaded 后清空为 null） */
  renderData: TileRenderData | null;

  /** 最近一次被渲染的帧序号（用于 LRU 淘汰排序） */
  lastRenderedFrame: number;

  /** 此瓦片占用的 GPU 内存字节数（冗余缓存，避免每帧深入 renderData） */
  gpuBytes: number;

  /** 当前帧计算的屏幕空间误差值（像素） */
  screenSpaceError: number;

  /** 当前帧是否通过视锥剔除测试 */
  isVisible: boolean;

  /** 当前帧是否需要进一步细化（SSE 超阈值） */
  needsRefine: boolean;
}

// ---------------------------------------------------------------------------
// Tiles3DLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 3D Tiles 图层接口——在 Layer 基础上扩展 3D Tiles 特有的状态查询、
 * 配置调整、事件回调和飞行动画功能。
 * 实例由 `createTiles3DLayer` 工厂创建。
 *
 * @example
 * const layer = createTiles3DLayer({
 *   id: 'city-model',
 *   url: 'https://example.com/tileset.json',
 *   maximumScreenSpaceError: 8,
 * });
 * layer.onReady(() => {
 *   console.log('tileset loaded, total tiles:', layer.totalTileCount);
 * });
 */
export interface Tiles3DLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'3d-tiles'` */
  readonly type: '3d-tiles';

  /** tileset.json 是否已加载且根 BVH 构建完毕 */
  readonly isReady: boolean;

  /** 已加载内容的瓦片数量（contentState === 'loaded'） */
  readonly loadedTileCount: number;

  /** 当前帧实际提交渲染的瓦片数量 */
  readonly renderedTileCount: number;

  /** 当前所有已加载瓦片占用的 GPU 内存（字节） */
  readonly gpuMemoryUsage: number;

  /** BVH 树中的瓦片总数（含未加载的） */
  readonly totalTileCount: number;

  /**
   * 设置最大屏幕空间误差阈值。
   * 值越小细节越丰富，开销越大。
   *
   * @param sse - 新阈值（像素），范围 [1, 256]
   * @throws 若 sse 不在有效范围内
   *
   * @example
   * layer.setMaximumScreenSpaceError(8); // 更精细
   */
  setMaximumScreenSpaceError(sse: number): void;

  /**
   * 设置最大 GPU 内存预算。
   *
   * @param mb - 新预算（MB），范围 [64, 4096]
   * @throws 若 mb 不在有效范围内
   *
   * @example
   * layer.setMaximumMemoryUsage(1024); // 1GB
   */
  setMaximumMemoryUsage(mb: number): void;

  /**
   * 设置模型整体缩放。
   *
   * @param scale - 缩放比例（正数）
   *
   * @example
   * layer.setModelScale(0.01); // 厘米→米
   */
  setModelScale(scale: number): void;

  /**
   * 设置模型整体平移偏移。
   *
   * @param offset - [x, y, z] 偏移量（米）
   *
   * @example
   * layer.setModelOffset([100, 200, 0]);
   */
  setModelOffset(offset: [number, number, number]): void;

  /**
   * 设置条件样式。
   *
   * @param style - 新样式配置，null 清除自定义样式
   *
   * @example
   * layer.setStyle({ color: 'red', show: true });
   */
  setStyle(style: Tiles3DStyle | null): void;

  /**
   * 获取瓦片集整体包围体（根节点的世界包围体）。
   *
   * @returns 包围体信息（中心+半轴），或 null 若瓦片集未加载
   *
   * @example
   * const bv = layer.getBoundingVolume();
   * if (bv) console.log('center:', bv.center, 'halfAxes:', bv.halfAxes);
   */
  getBoundingVolume(): { center: Float32Array; halfAxes: Float32Array } | null;

  /**
   * 飞行至瓦片集的最佳视角。
   * 计算根包围球的包围距离，将相机移至可完整看到瓦片集的位置。
   *
   * @param camera - 相机控制器实例
   * @param options - 可选参数（时长、缓动等）
   * @returns 飞行动画句柄
   * @throws 若瓦片集未就绪或无有效包围体
   *
   * @example
   * const anim = layer.flyTo(cameraController, { duration: 2000 });
   * await anim.finished;
   */
  flyTo(camera: CameraController, options?: {
    readonly duration?: number;
    readonly bearing?: number;
    readonly pitch?: number;
  }): CameraAnimation;

  /**
   * 注册 tileset.json 加载完成回调。
   *
   * @param cb - 回调函数（无参数）
   * @returns 取消注册的函数
   *
   * @example
   * const off = layer.onReady(() => console.log('ready'));
   */
  onReady(cb: () => void): () => void;

  /**
   * 注册单个瓦片内容加载完成回调。
   *
   * @param cb - 回调函数，参数为瓦片 ID
   * @returns 取消注册的函数
   *
   * @example
   * layer.onTileLoaded((tileId) => console.log('tile loaded:', tileId));
   */
  onTileLoaded(cb: (tileId: number) => void): () => void;

  /**
   * 注册当前帧所有需要的瓦片均已加载完成的回调。
   *
   * @param cb - 回调函数
   * @returns 取消注册的函数
   *
   * @example
   * layer.onAllTilesLoaded(() => console.log('all tiles loaded'));
   */
  onAllTilesLoaded(cb: () => void): () => void;

  /**
   * 阴影 Pass 编码（castShadow=true 时由 RenderGraph 调用）。
   * MVP 阶段为桩实现。
   *
   * @param encoder - WebGPU 渲染通道编码器
   * @param camera - 阴影相机快照
   *
   * @stability experimental
   */
  encodeShadow?(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 Tiles3DLayerOptions。
 * 对必填字段做空检查，对可选数值字段做范围钳位和校验。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的配置（带默认值）
 * @throws Error 若必填字段缺失或格式非法
 *
 * @example
 * const cfg = validateOptions({ id: 'bld', url: '/tileset.json' });
 */
function validateOptions(opts: Tiles3DLayerOptions): {
  id: string;
  url: string;
  maximumScreenSpaceError: number;
  maximumMemoryUsage: number;
  show: boolean;
  modelScale: number;
  modelOffset: [number, number, number];
  castShadow: boolean;
  receiveShadow: boolean;
  pointSize: number;
  style: Tiles3DStyle | null;
  maxConcurrentRequests: number;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] Tiles3DLayerOptions.id must be a non-empty string`,
    );
  }

  // url 必须为非空字符串
  if (typeof opts.url !== 'string' || opts.url.trim().length === 0) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] Tiles3DLayerOptions.url must be a non-empty string`,
    );
  }

  // SSE 校验：默认 16，范围 [1, 256]
  const maximumScreenSpaceError = opts.maximumScreenSpaceError ?? DEFAULT_MAX_SSE;
  if (
    !Number.isFinite(maximumScreenSpaceError) ||
    maximumScreenSpaceError < MIN_SSE ||
    maximumScreenSpaceError > MAX_SSE
  ) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_SSE}] maximumScreenSpaceError must be in [${MIN_SSE}, ${MAX_SSE}], got ${maximumScreenSpaceError}`,
    );
  }

  // 内存预算校验：默认 512MB，范围 [64, 4096]
  const maximumMemoryUsage = opts.maximumMemoryUsage ?? DEFAULT_MAX_MEMORY_MB;
  if (
    !Number.isFinite(maximumMemoryUsage) ||
    maximumMemoryUsage < MIN_MEMORY_MB ||
    maximumMemoryUsage > MAX_MEMORY_MB
  ) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_MEMORY}] maximumMemoryUsage must be in [${MIN_MEMORY_MB}, ${MAX_MEMORY_MB}], got ${maximumMemoryUsage}`,
    );
  }

  // show 默认 true
  const show = opts.show !== undefined ? Boolean(opts.show) : true;

  // modelScale 默认 1.0，必须为正有限数
  const modelScale = opts.modelScale ?? DEFAULT_MODEL_SCALE;
  if (!Number.isFinite(modelScale) || modelScale <= 0) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] modelScale must be a positive finite number, got ${modelScale}`,
    );
  }

  // modelOffset 默认 [0,0,0]，每个分量必须为有限数
  const rawOffset = opts.modelOffset ?? [0, 0, 0];
  if (
    !Array.isArray(rawOffset) ||
    rawOffset.length < 3 ||
    !Number.isFinite(rawOffset[0]) ||
    !Number.isFinite(rawOffset[1]) ||
    !Number.isFinite(rawOffset[2])
  ) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] modelOffset must be [number, number, number] with finite values`,
    );
  }
  const modelOffset: [number, number, number] = [rawOffset[0], rawOffset[1], rawOffset[2]];

  // 阴影相关默认值
  const castShadow = opts.castShadow !== undefined ? Boolean(opts.castShadow) : false;
  const receiveShadow = opts.receiveShadow !== undefined ? Boolean(opts.receiveShadow) : true;

  // pointSize 校验：默认 2.0，范围 [0.5, 50]
  const pointSize = opts.pointSize ?? DEFAULT_POINT_SIZE;
  if (!Number.isFinite(pointSize) || pointSize < MIN_POINT_SIZE || pointSize > MAX_POINT_SIZE) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] pointSize must be in [${MIN_POINT_SIZE}, ${MAX_POINT_SIZE}], got ${pointSize}`,
    );
  }

  // style 可选
  const style = opts.style ?? null;

  // maxConcurrentRequests 校验：默认 6，范围 [1, 32]
  const maxConcurrentRequests = opts.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT;
  if (
    !Number.isFinite(maxConcurrentRequests) ||
    maxConcurrentRequests < MIN_CONCURRENT ||
    maxConcurrentRequests > MAX_CONCURRENT ||
    Math.floor(maxConcurrentRequests) !== maxConcurrentRequests
  ) {
    throw new Error(
      `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] maxConcurrentRequests must be an integer in [${MIN_CONCURRENT}, ${MAX_CONCURRENT}], got ${maxConcurrentRequests}`,
    );
  }

  return {
    id: opts.id.trim(),
    url: opts.url.trim(),
    maximumScreenSpaceError,
    maximumMemoryUsage,
    show,
    modelScale,
    modelOffset,
    castShadow,
    receiveShadow,
    pointSize,
    style,
    maxConcurrentRequests,
  };
}

// ---------------------------------------------------------------------------
// tileset.json 基础 URL 解析
// ---------------------------------------------------------------------------

/**
 * 从 tileset.json 完整 URL 中提取基础路径。
 * 用于将瓦片内容的相对 URI 解析为绝对 URL。
 *
 * @param tilesetUrl - tileset.json 的完整 URL
 * @returns 基础路径（以 `/` 结尾）
 *
 * @example
 * resolveBaseUrl('https://cdn.example.com/model/tileset.json');
 * // → 'https://cdn.example.com/model/'
 */
function resolveBaseUrl(tilesetUrl: string): string {
  // 查找最后一个 `/` 的位置
  const lastSlash = tilesetUrl.lastIndexOf('/');
  if (lastSlash >= 0) {
    // 取 `/` 之前的部分（含 `/`）
    return tilesetUrl.substring(0, lastSlash + 1);
  }
  // 无路径分隔符——当前目录
  return './';
}

// ---------------------------------------------------------------------------
// 包围体解析工具函数
// ---------------------------------------------------------------------------

/**
 * 从 BoundingVolume JSON 解析出运行时包围体。
 * 支持三种格式：box（OBB）、region（地理区域）、sphere（包围球）。
 *
 * @param bv - JSON 包围体对象
 * @returns 解析后的运行时包围体
 * @throws Error 若三种格式均未匹配或数据长度不足
 *
 * @example
 * const computed = parseBoundingVolume({
 *   box: [0,0,0, 10,0,0, 0,10,0, 0,0,10],
 * });
 */
function parseBoundingVolume(bv: BoundingVolume): BoundingVolumeComputed {
  // 尝试解析 box 格式
  if (bv.box !== undefined && bv.box !== null && bv.box.length >= 12) {
    return parseBoundingVolumeBox(bv.box);
  }

  // 尝试解析 region 格式
  if (bv.region !== undefined && bv.region !== null && bv.region.length >= 6) {
    return parseBoundingVolumeRegion(bv.region);
  }

  // 尝试解析 sphere 格式
  if (bv.sphere !== undefined && bv.sphere !== null && bv.sphere.length >= 4) {
    return parseBoundingVolumeSphere(bv.sphere);
  }

  // 三种格式均未匹配——抛出结构化错误
  throw new Error(
    `[${TILES3D_ERROR_CODES.INVALID_BOUNDING_VOLUME}] BoundingVolume must contain 'box' (12 numbers), 'region' (6 numbers), or 'sphere' (4 numbers)`,
  );
}

/**
 * 解析 OBB 格式包围体。
 * 12 个元素：前 3 为中心 [cx,cy,cz]，后 9 为三个半轴向量（列主序 3x3）。
 *
 * @param box - 12 个 number 的数组
 * @returns 运行时包围体
 *
 * @example
 * parseBoundingVolumeBox([0,0,0, 10,0,0, 0,5,0, 0,0,3]);
 */
function parseBoundingVolumeBox(box: readonly number[]): BoundingVolumeComputed {
  // 中心坐标
  const center = new Float32Array(3);
  center[0] = box[0];
  center[1] = box[1];
  center[2] = box[2];

  // 半轴矩阵（3x3 列主序）
  // box[3..5] = X 半轴，box[6..8] = Y 半轴，box[9..11] = Z 半轴
  const halfAxes = new Float32Array(9);
  halfAxes[0] = box[3];  // X 半轴 x 分量
  halfAxes[1] = box[4];  // X 半轴 y 分量
  halfAxes[2] = box[5];  // X 半轴 z 分量
  halfAxes[3] = box[6];  // Y 半轴 x 分量
  halfAxes[4] = box[7];  // Y 半轴 y 分量
  halfAxes[5] = box[8];  // Y 半轴 z 分量
  halfAxes[6] = box[9];  // Z 半轴 x 分量
  halfAxes[7] = box[10]; // Z 半轴 y 分量
  halfAxes[8] = box[11]; // Z 半轴 z 分量

  // 计算包围球半径 = 三个半轴向量长度的向量模
  const hx = Math.sqrt(halfAxes[0] * halfAxes[0] + halfAxes[1] * halfAxes[1] + halfAxes[2] * halfAxes[2]);
  const hy = Math.sqrt(halfAxes[3] * halfAxes[3] + halfAxes[4] * halfAxes[4] + halfAxes[5] * halfAxes[5]);
  const hz = Math.sqrt(halfAxes[6] * halfAxes[6] + halfAxes[7] * halfAxes[7] + halfAxes[8] * halfAxes[8]);
  // 包围球半径 = sqrt(hx² + hy² + hz²)，保证 OBB 全部包含在球内
  const radius = Math.sqrt(hx * hx + hy * hy + hz * hz);

  return { center, halfAxes, radius };
}

/**
 * 解析 region 格式包围体。
 * 6 个元素：[west, south, east, north, minHeight, maxHeight]
 * 前 4 为弧度经纬度，后 2 为椭球面高度（米）。
 * 计算中心点和等效球半径。
 *
 * @param region - 6 个 number 的数组
 * @returns 运行时包围体
 *
 * @example
 * parseBoundingVolumeRegion([2.0, 0.8, 2.01, 0.81, 0, 100]);
 */
function parseBoundingVolumeRegion(region: readonly number[]): BoundingVolumeComputed {
  const west = region[0];
  const south = region[1];
  const east = region[2];
  const north = region[3];
  const minHeight = region[4];
  const maxHeight = region[5];

  // 计算中心经纬度（弧度）和中心高度
  const centerLon = (west + east) * 0.5;
  const centerLat = (south + north) * 0.5;
  const centerHeight = (minHeight + maxHeight) * 0.5;

  // 将中心经纬度 + 高度转换为近似笛卡尔坐标（简化球面模型）
  // 使用 WGS84 长半轴近似球面半径
  const cosLat = Math.cos(centerLat);
  const sinLat = Math.sin(centerLat);
  const cosLon = Math.cos(centerLon);
  const sinLon = Math.sin(centerLon);

  // 近似 ECEF：(N + h) * cos(lat) * cos(lon), (N + h) * cos(lat) * sin(lon), (N + h) * sin(lat)
  // 简化：N ≈ WGS84_A
  const N = WGS84_A + centerHeight;

  const center = new Float32Array(3);
  center[0] = N * cosLat * cosLon;
  center[1] = N * cosLat * sinLon;
  center[2] = N * sinLat;

  // 估算包围球半径
  // 水平跨度（弧度 × 球面距离）
  const dLon = Math.abs(east - west);
  const dLat = Math.abs(north - south);
  const horizontalSpan = WGS84_A * Math.sqrt(
    (dLon * cosLat) * (dLon * cosLat) + dLat * dLat,
  ) * 0.5;
  // 垂直跨度
  const verticalSpan = (maxHeight - minHeight) * 0.5;
  // 合成半径
  const radius = Math.sqrt(horizontalSpan * horizontalSpan + verticalSpan * verticalSpan);

  // region 退化为球：半轴矩阵设为半径 × 单位矩阵
  const halfAxes = new Float32Array(9);
  halfAxes[0] = radius; halfAxes[1] = 0; halfAxes[2] = 0;
  halfAxes[3] = 0; halfAxes[4] = radius; halfAxes[5] = 0;
  halfAxes[6] = 0; halfAxes[7] = 0; halfAxes[8] = radius;

  return { center, halfAxes, radius };
}

/**
 * 解析 sphere 格式包围体。
 * 4 个元素：[cx, cy, cz, radius]。
 *
 * @param sphere - 4 个 number 的数组
 * @returns 运行时包围体
 *
 * @example
 * parseBoundingVolumeSphere([100, 200, 50, 30]);
 */
function parseBoundingVolumeSphere(sphere: readonly number[]): BoundingVolumeComputed {
  const center = new Float32Array(3);
  center[0] = sphere[0];
  center[1] = sphere[1];
  center[2] = sphere[2];

  const radius = sphere[3];

  // 球体退化为等比半轴矩阵：radius × 单位矩阵
  const halfAxes = new Float32Array(9);
  halfAxes[0] = radius; halfAxes[1] = 0; halfAxes[2] = 0;
  halfAxes[3] = 0; halfAxes[4] = radius; halfAxes[5] = 0;
  halfAxes[6] = 0; halfAxes[7] = 0; halfAxes[8] = radius;

  return { center, halfAxes, radius };
}

// ---------------------------------------------------------------------------
// 变换矩阵应用于包围体
// ---------------------------------------------------------------------------

/**
 * 将世界变换矩阵应用于局部包围体，得到世界空间包围体。
 * 中心通过齐次变换（4x4矩阵×点）；半轴通过左上 3x3 子矩阵变换。
 *
 * @param localBV - 局部空间包围体
 * @param worldTransform - 4x4 列主序世界变换矩阵
 * @returns 新的世界空间包围体
 *
 * @example
 * const worldBV = transformBoundingVolume(localBV, tileWorldTransform);
 */
function transformBoundingVolume(
  localBV: BoundingVolumeComputed,
  worldTransform: Float32Array,
): BoundingVolumeComputed {
  // 提取矩阵的列主序分量
  const m = worldTransform;

  // 变换中心点：result = M × [cx, cy, cz, 1]
  const cx = localBV.center[0];
  const cy = localBV.center[1];
  const cz = localBV.center[2];

  const newCenter = new Float32Array(3);
  // 列主序乘法：col0 * cx + col1 * cy + col2 * cz + col3 * 1
  newCenter[0] = m[0] * cx + m[4] * cy + m[8]  * cz + m[12];
  newCenter[1] = m[1] * cx + m[5] * cy + m[9]  * cz + m[13];
  newCenter[2] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];

  // 变换半轴：提取左上 3x3 子矩阵，逐列变换半轴向量
  const newHalfAxes = new Float32Array(9);

  // X 半轴 = M3x3 × localHalfAxes.column0
  const ax = localBV.halfAxes[0];
  const ay = localBV.halfAxes[1];
  const az = localBV.halfAxes[2];
  newHalfAxes[0] = m[0] * ax + m[4] * ay + m[8]  * az;
  newHalfAxes[1] = m[1] * ax + m[5] * ay + m[9]  * az;
  newHalfAxes[2] = m[2] * ax + m[6] * ay + m[10] * az;

  // Y 半轴 = M3x3 × localHalfAxes.column1
  const bx = localBV.halfAxes[3];
  const by = localBV.halfAxes[4];
  const bz = localBV.halfAxes[5];
  newHalfAxes[3] = m[0] * bx + m[4] * by + m[8]  * bz;
  newHalfAxes[4] = m[1] * bx + m[5] * by + m[9]  * bz;
  newHalfAxes[5] = m[2] * bx + m[6] * by + m[10] * bz;

  // Z 半轴 = M3x3 × localHalfAxes.column2
  const dx = localBV.halfAxes[6];
  const dy = localBV.halfAxes[7];
  const dz = localBV.halfAxes[8];
  newHalfAxes[6] = m[0] * dx + m[4] * dy + m[8]  * dz;
  newHalfAxes[7] = m[1] * dx + m[5] * dy + m[9]  * dz;
  newHalfAxes[8] = m[2] * dx + m[6] * dy + m[10] * dz;

  // 重新计算包围球半径（变换后半轴长度可能改变）
  const hx = Math.sqrt(
    newHalfAxes[0] * newHalfAxes[0] + newHalfAxes[1] * newHalfAxes[1] + newHalfAxes[2] * newHalfAxes[2],
  );
  const hy = Math.sqrt(
    newHalfAxes[3] * newHalfAxes[3] + newHalfAxes[4] * newHalfAxes[4] + newHalfAxes[5] * newHalfAxes[5],
  );
  const hz = Math.sqrt(
    newHalfAxes[6] * newHalfAxes[6] + newHalfAxes[7] * newHalfAxes[7] + newHalfAxes[8] * newHalfAxes[8],
  );
  const newRadius = Math.sqrt(hx * hx + hy * hy + hz * hz);

  return { center: newCenter, halfAxes: newHalfAxes, radius: newRadius };
}

// ---------------------------------------------------------------------------
// BVH 树构建（递归解析 tileset.json → RuntimeTile 树）
// ---------------------------------------------------------------------------

/**
 * 从 tileset.json 的根 TileJSON 递归构建 BVH 运行时树。
 * 每个节点计算 worldTransform（父累积 × 当前 transform）和 worldBoundingVolume。
 *
 * @param json - 当前 TileJSON 节点
 * @param parentTransform - 父节点的世界变换矩阵（根节点传入 identity）
 * @param parentRefine - 父节点的细化策略（根节点默认 'REPLACE'）
 * @param parent - 父 RuntimeTile 引用（根为 null）
 * @param nextId - 可变引用，用于分配自增 ID `{ value: number }`
 * @param baseUrl - tileset.json 所在目录的 URL（用于解析 content.uri）
 * @param modelScale - 模型全局缩放比例
 * @param modelOffset - 模型全局平移偏移 [x, y, z]
 * @param isRoot - 是否为根节点（需要额外应用 modelScale + modelOffset）
 * @returns 运行时瓦片节点
 *
 * @example
 * const rootTile = buildBVHTree(
 *   tilesetJson.root,
 *   mat4.create(),
 *   'REPLACE',
 *   null,
 *   { value: 0 },
 *   'https://example.com/tiles/',
 *   1.0,
 *   [0, 0, 0],
 *   true,
 * );
 */
function buildBVHTree(
  json: TileJSON,
  parentTransform: Float32Array,
  parentRefine: 'ADD' | 'REPLACE',
  parent: RuntimeTile | null,
  nextId: { value: number },
  baseUrl: string,
  modelScale: number,
  modelOffset: [number, number, number],
  isRoot: boolean,
): RuntimeTile {
  // 分配唯一 ID
  const id = nextId.value;
  nextId.value += 1;

  // 计算此节点的局部变换矩阵
  const localTransform = mat4.create();
  if (json.transform !== undefined && json.transform !== null && json.transform.length >= 16) {
    // tileset.json 中 transform 为行主序 4x4，需要转为列主序
    // 实际上 3D Tiles 规范使用列主序存储，直接拷贝即可
    for (let i = 0; i < 16; i++) {
      localTransform[i] = json.transform[i];
    }
  } else {
    // 无 transform 属性——使用单位矩阵
    mat4.identity(localTransform);
  }

  // 如果是根节点，额外叠加 modelScale 和 modelOffset
  if (isRoot) {
    // 构建模型偏移+缩放矩阵: translate(offset) × scale(s)
    const modelMatrix = mat4.create();
    // 先设为缩放矩阵
    modelMatrix[0] = modelScale;
    modelMatrix[5] = modelScale;
    modelMatrix[10] = modelScale;
    modelMatrix[15] = 1;
    // 叠加平移
    modelMatrix[12] = modelOffset[0];
    modelMatrix[13] = modelOffset[1];
    modelMatrix[14] = modelOffset[2];

    // localTransform = modelMatrix × localTransform
    const temp = mat4.create();
    mat4.multiply(temp, modelMatrix, localTransform);
    mat4.copy(localTransform, temp);
  }

  // 计算世界变换 = parent.worldTransform × localTransform
  const worldTransform = mat4.create();
  mat4.multiply(worldTransform, parentTransform, localTransform);

  // 解析局部包围体
  const localBV = parseBoundingVolume(json.boundingVolume);

  // 将局部包围体变换到世界空间
  const worldBoundingVolume = transformBoundingVolume(localBV, worldTransform);

  // 继承或覆盖细化策略
  const refine: 'ADD' | 'REPLACE' = json.refine ?? parentRefine;

  // 解析内容 URI（content.uri 优先，兼容旧格式 content.url）
  let contentUri: string | null = null;
  if (json.content !== undefined && json.content !== null) {
    const rawUri = json.content.uri ?? json.content.url ?? null;
    if (rawUri !== null && typeof rawUri === 'string' && rawUri.length > 0) {
      // 判断是否为绝对 URL
      if (rawUri.startsWith('http://') || rawUri.startsWith('https://') || rawUri.startsWith('//')) {
        contentUri = rawUri;
      } else {
        // 相对路径——拼接 baseUrl
        contentUri = baseUrl + rawUri;
      }
    }
  }

  // 构建运行时节点
  const tile: RuntimeTile = {
    id,
    json,
    worldBoundingVolume,
    geometricError: json.geometricError,
    refine,
    worldTransform,
    parent,
    children: [],
    contentUri,
    contentState: 'unloaded',
    renderData: null,
    lastRenderedFrame: -1,
    gpuBytes: 0,
    screenSpaceError: 0,
    isVisible: false,
    needsRefine: false,
  };

  // 递归构建子节点
  if (json.children !== undefined && json.children !== null && json.children.length > 0) {
    for (let i = 0; i < json.children.length; i++) {
      const childJson = json.children[i];
      // 子节点不再应用 modelScale/modelOffset（已经包含在根的 worldTransform 中）
      const childTile = buildBVHTree(
        childJson,
        worldTransform,
        refine,
        tile,
        nextId,
        baseUrl,
        modelScale,
        modelOffset,
        false,
      );
      tile.children.push(childTile);
    }
  }

  return tile;
}

// ---------------------------------------------------------------------------
// SSE（屏幕空间误差）计算
// ---------------------------------------------------------------------------

/**
 * 计算瓦片在当前视口中的屏幕空间误差（Screen Space Error）。
 * SSE = geometricError / distance × sseFactor
 * 其中 sseFactor = viewportHeight / (2 × tan(fov / 2))
 *
 * @param tile - 运行时瓦片节点
 * @param cameraPosition - 相机世界坐标
 * @param sseFactor - 预计算的 SSE 因子（与视口和 FOV 相关）
 * @returns 屏幕空间误差（像素）
 *
 * @example
 * const sse = computeSSE(tile, cameraPos, factor);
 */
function computeSSE(
  tile: RuntimeTile,
  cameraPosition: Float32Array,
  sseFactor: number,
): number {
  // 叶节点 geometricError 为 0 时，SSE 也为 0（无需细化）
  if (tile.geometricError <= 0) {
    return 0;
  }

  // 计算相机到瓦片包围体中心的距离
  const dx = tile.worldBoundingVolume.center[0] - cameraPosition[0];
  const dy = tile.worldBoundingVolume.center[1] - cameraPosition[1];
  const dz = tile.worldBoundingVolume.center[2] - cameraPosition[2];
  const distSq = dx * dx + dy * dy + dz * dz;

  // 防止距离为零导致除零（相机在包围体中心时，SSE 设为极大值以强制细化）
  if (distSq < 1e-10) {
    return Infinity;
  }

  const distance = Math.sqrt(distSq);

  // 从距离中减去包围球半径，得到到包围体表面的近似距离
  // 确保距离不小于一个极小的正值
  const surfaceDistance = Math.max(distance - tile.worldBoundingVolume.radius, 1e-6);

  // SSE = geometricError / surfaceDistance × sseFactor
  return (tile.geometricError / surfaceDistance) * sseFactor;
}

/**
 * 从视口高度和相机 FOV 预计算 SSE 因子。
 * sseFactor = viewportHeight / (2 × tan(fov / 2))
 * 对于正交投影（fov ≈ 0），使用视口高度作为退化值。
 *
 * @param viewportHeight - 视口逻辑高度（CSS 像素）
 * @param fov - 垂直视场角（弧度）
 * @returns SSE 因子
 *
 * @example
 * const factor = computeSSEFactor(1080, Math.PI / 4); // ≈ 1304
 */
function computeSSEFactor(viewportHeight: number, fov: number): number {
  // 安全检查：视口高度和 FOV 必须为正
  if (viewportHeight <= 0 || !Number.isFinite(viewportHeight)) {
    return 1;
  }

  // 正交投影退化：FOV 接近 0 时直接使用视口高度
  if (fov <= 1e-6 || !Number.isFinite(fov)) {
    return viewportHeight;
  }

  // 透视投影公式
  const halfTan = Math.tan(fov * 0.5);
  if (halfTan <= 1e-10) {
    return viewportHeight;
  }

  return viewportHeight / (2.0 * halfTan);
}

// ---------------------------------------------------------------------------
// 视锥剔除（简化球 vs 6 平面测试）
// ---------------------------------------------------------------------------

/**
 * 从视图投影矩阵（VP Matrix）提取 6 个视锥平面。
 * 平面以 [a, b, c, d] 格式存储，满足 ax + by + cz + d = 0 且法线指向内侧。
 * 使用 Gribb/Hartmann 方法从 VP 矩阵行组合中提取。
 *
 * @param vpMatrix - 视图投影矩阵（列主序 4x4）
 * @returns 6 个平面组成的 Float32Array（6×4 = 24 元素）
 *
 * @example
 * const planes = extractFrustumPlanes(camera.vpMatrix);
 */
function extractFrustumPlanes(vpMatrix: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vpMatrix;

  // 列主序矩阵中，行 i 的元素分布在 m[i], m[i+4], m[i+8], m[i+12]
  // 提取行向量以便组合平面
  // row0 = [m0, m4, m8, m12]
  // row1 = [m1, m5, m9, m13]
  // row2 = [m2, m6, m10, m14]
  // row3 = [m3, m7, m11, m15]

  // Left:   row3 + row0
  planes[0]  = m[3]  + m[0];
  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];
  planes[3]  = m[15] + m[12];

  // Right:  row3 - row0
  planes[4]  = m[3]  - m[0];
  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];
  planes[7]  = m[15] - m[12];

  // Bottom: row3 + row1
  planes[8]  = m[3]  + m[1];
  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];
  planes[11] = m[15] + m[13];

  // Top:    row3 - row1
  planes[12] = m[3]  - m[1];
  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];
  planes[15] = m[15] - m[13];

  // Near:   row3 + row2 (WebGPU NDC z ∈ [0,1]，ReversedZ: near→1)
  planes[16] = m[3]  + m[2];
  planes[17] = m[7]  + m[6];
  planes[18] = m[11] + m[10];
  planes[19] = m[15] + m[14];

  // Far:    row3 - row2
  planes[20] = m[3]  - m[2];
  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10];
  planes[23] = m[15] - m[14];

  // 归一化每个平面的法线
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const a = planes[offset];
    const b = planes[offset + 1];
    const c = planes[offset + 2];
    const len = Math.sqrt(a * a + b * b + c * c);
    if (len > 1e-10) {
      const invLen = 1.0 / len;
      planes[offset]     *= invLen;
      planes[offset + 1] *= invLen;
      planes[offset + 2] *= invLen;
      planes[offset + 3] *= invLen;
    }
  }

  return planes;
}

/**
 * 球体 vs 视锥 6 平面剔除测试。
 * 如果球体完全在任一平面的负半空间外，则不可见。
 *
 * @param center - 球心坐标 [x, y, z]
 * @param radius - 球半径
 * @param frustumPlanes - 6 个归一化视锥平面（24 元素 Float32Array）
 * @returns true 表示球体可能可见（不被完全剔除），false 表示完全不可见
 *
 * @example
 * const visible = sphereInFrustum(center, 50, planes);
 */
function sphereInFrustum(
  center: Float32Array,
  radius: number,
  frustumPlanes: Float32Array,
): boolean {
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];

  // 逐个检查 6 个平面
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    // 球心到平面的有符号距离 = a*cx + b*cy + c*cz + d
    const signedDist =
      frustumPlanes[offset]     * cx +
      frustumPlanes[offset + 1] * cy +
      frustumPlanes[offset + 2] * cz +
      frustumPlanes[offset + 3];

    // 如果球心到平面距离 < -radius，球体完全在平面外侧
    if (signedDist < -radius) {
      return false;
    }
  }

  // 未被任何平面完全剔除——视为可见
  return true;
}

// ---------------------------------------------------------------------------
// BVH 遍历（深度优先 + SSE 细化 + 视锥剔除）
// ---------------------------------------------------------------------------

/**
 * 深度优先遍历 BVH 树，收集需要渲染的瓦片列表和需要加载的瓦片列表。
 * 实现 REPLACE 和 ADD 两种细化策略。
 *
 * @param root - BVH 树根节点
 * @param cameraPosition - 相机世界坐标
 * @param sseFactor - 预计算的 SSE 因子
 * @param maxSSE - 最大屏幕空间误差阈值
 * @param frustumPlanes - 6 个视锥平面
 * @param frameNumber - 当前帧序号
 * @param renderList - 输出：需要渲染的瓦片列表
 * @param loadList - 输出：需要加载内容的瓦片列表
 *
 * @example
 * traverseBVH(rootTile, camPos, factor, 16, planes, 42, renderList, loadList);
 */
function traverseBVH(
  root: RuntimeTile,
  cameraPosition: Float32Array,
  sseFactor: number,
  maxSSE: number,
  frustumPlanes: Float32Array,
  frameNumber: number,
  renderList: RuntimeTile[],
  loadList: RuntimeTile[],
): void {
  // 使用显式栈避免递归深度限制
  const stack: RuntimeTile[] = [root];

  while (stack.length > 0) {
    // 弹出栈顶节点
    const tile = stack.pop()!;

    // 视锥剔除：球体 vs 视锥平面
    const isVisible = sphereInFrustum(
      tile.worldBoundingVolume.center,
      tile.worldBoundingVolume.radius,
      frustumPlanes,
    );
    tile.isVisible = isVisible;

    // 不可见——跳过此子树
    if (!isVisible) {
      continue;
    }

    // 计算 SSE
    const sse = computeSSE(tile, cameraPosition, sseFactor);
    tile.screenSpaceError = sse;

    // 判断是否需要细化（SSE 超过阈值且有子节点）
    const hasChildren = tile.children.length > 0;
    const needsRefine = sse > maxSSE && hasChildren;
    tile.needsRefine = needsRefine;

    if (tile.refine === 'REPLACE') {
      // REPLACE 策略：渲染父节点直到所有子节点都已加载
      if (!needsRefine) {
        // SSE 满足要求——渲染此瓦片
        if (tile.contentUri !== null) {
          addToRenderOrLoad(tile, frameNumber, renderList, loadList);
        }
      } else {
        // 需要细化——检查所有子节点是否已加载
        let allChildrenLoaded = true;
        for (let i = 0; i < tile.children.length; i++) {
          const child = tile.children[i];
          // 有内容的子节点必须已加载
          if (child.contentUri !== null && child.contentState !== 'loaded') {
            allChildrenLoaded = false;
          }
        }

        if (allChildrenLoaded) {
          // 所有子节点已加载——向下细化（将子节点入栈）
          for (let i = tile.children.length - 1; i >= 0; i--) {
            stack.push(tile.children[i]);
          }
        } else {
          // 子节点未全部加载——先渲染父节点（REPLACE 回退）
          if (tile.contentUri !== null) {
            addToRenderOrLoad(tile, frameNumber, renderList, loadList);
          }
          // 同时触发子节点加载
          for (let i = 0; i < tile.children.length; i++) {
            const child = tile.children[i];
            if (child.contentUri !== null && child.contentState === 'unloaded') {
              loadList.push(child);
            }
          }
        }
      }
    } else {
      // ADD 策略：始终渲染父节点，按需递归子节点
      if (tile.contentUri !== null) {
        addToRenderOrLoad(tile, frameNumber, renderList, loadList);
      }

      // SSE 超阈值时递归子节点
      if (needsRefine) {
        // 将子节点入栈（逆序以保证先遍历第一个子节点）
        for (let i = tile.children.length - 1; i >= 0; i--) {
          stack.push(tile.children[i]);
        }
      }
    }
  }
}

/**
 * 将瓦片添加到渲染列表或加载列表。
 * 已加载的瓦片加入渲染列表；未加载的加入加载列表。
 *
 * @param tile - 运行时瓦片节点
 * @param frameNumber - 当前帧序号（用于 LRU 更新）
 * @param renderList - 渲染列表（输出）
 * @param loadList - 加载列表（输出）
 */
function addToRenderOrLoad(
  tile: RuntimeTile,
  frameNumber: number,
  renderList: RuntimeTile[],
  loadList: RuntimeTile[],
): void {
  if (tile.contentState === 'loaded' && tile.renderData !== null) {
    // 已加载——加入渲染列表并更新 LRU 帧号
    renderList.push(tile);
    tile.lastRenderedFrame = frameNumber;
  } else if (tile.contentState === 'unloaded') {
    // 未加载——请求加载
    loadList.push(tile);
  }
  // loading / failed 状态下不做操作——loading 等待回调，failed 可重试
}

// ---------------------------------------------------------------------------
// 内存管理：LRU + SSE 淘汰
// ---------------------------------------------------------------------------

/**
 * 当 GPU 内存超出预算时，淘汰非可见的已加载瓦片。
 * 淘汰优先级：SSE 低的（低优先级）先淘汰；同 SSE 按 LRU（lastRenderedFrame 小的先淘汰）。
 * 淘汰目标：降至预算的 90%（MEMORY_EVICT_TARGET）。
 *
 * @param allTiles - BVH 树的扁平列表（所有瓦片）
 * @param currentGpuBytes - 当前 GPU 内存占用（字节）
 * @param budgetBytes - GPU 内存预算（字节）
 * @param currentFrameNumber - 当前帧序号（用于判断可见性）
 * @returns 被淘汰的瓦片数量
 *
 * @example
 * const evicted = evictTiles(flatList, currentBytes, budgetBytes, frameNum);
 */
function evictTiles(
  allTiles: RuntimeTile[],
  currentGpuBytes: number,
  budgetBytes: number,
  currentFrameNumber: number,
): number {
  // 未超预算则无需淘汰
  if (currentGpuBytes <= budgetBytes) {
    return 0;
  }

  // 目标字节数 = 预算 × 90%
  const targetBytes = budgetBytes * MEMORY_EVICT_TARGET;

  // 收集可淘汰候选：已加载且当前帧未被渲染的瓦片
  const candidates: RuntimeTile[] = [];
  for (let i = 0; i < allTiles.length; i++) {
    const tile = allTiles[i];
    if (
      tile.contentState === 'loaded' &&
      tile.renderData !== null &&
      tile.lastRenderedFrame < currentFrameNumber
    ) {
      candidates.push(tile);
    }
  }

  // 按淘汰优先级排序：SSE 低的优先（低→高），SSE 相同则 LRU 优先（旧→新）
  candidates.sort((a, b) => {
    // 主排序键：SSE 升序（SSE 低的先淘汰——对画面影响小）
    if (a.screenSpaceError !== b.screenSpaceError) {
      return a.screenSpaceError - b.screenSpaceError;
    }
    // 次排序键：lastRenderedFrame 升序（更久未渲染的先淘汰）
    return a.lastRenderedFrame - b.lastRenderedFrame;
  });

  // 逐个淘汰直到降至目标
  let bytesNow = currentGpuBytes;
  let evictedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    // 已降至目标以下——停止
    if (bytesNow <= targetBytes) {
      break;
    }

    const tile = candidates[i];
    const freedBytes = tile.gpuBytes;

    // 释放 GPU 数据（标记为未加载，清空 renderData）
    tile.contentState = 'unloaded';
    tile.renderData = null;
    tile.gpuBytes = 0;

    bytesNow -= freedBytes;
    evictedCount += 1;
  }

  return evictedCount;
}

// ---------------------------------------------------------------------------
// BVH 树扁平化工具
// ---------------------------------------------------------------------------

/**
 * 将 BVH 树扁平化为数组。
 * 深度优先遍历，结果数组保持遍历顺序。
 *
 * @param root - 树根节点
 * @returns 所有节点的扁平数组
 *
 * @example
 * const flatList = flattenBVH(rootTile);
 * console.log('total tiles:', flatList.length);
 */
function flattenBVH(root: RuntimeTile): RuntimeTile[] {
  const result: RuntimeTile[] = [];
  const stack: RuntimeTile[] = [root];

  while (stack.length > 0) {
    const tile = stack.pop()!;
    result.push(tile);

    // 逆序入栈以保持正序遍历
    for (let i = tile.children.length - 1; i >= 0; i--) {
      stack.push(tile.children[i]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 简易事件发射器（避免引入外部依赖）
// ---------------------------------------------------------------------------

/**
 * 极简事件订阅管理器。
 * 支持注册回调和取消注册。
 *
 * @typeParam T - 回调参数类型
 * @internal 仅模块内使用。
 */
interface SimpleEmitter<T extends (...args: never[]) => void> {
  /** 注册回调并返回取消函数 */
  on(cb: T): () => void;
  /** 触发所有已注册回调 */
  emit(...args: Parameters<T>): void;
  /** 移除所有回调 */
  clear(): void;
  /** 当前注册的回调数量 */
  readonly size: number;
}

/**
 * 创建简易事件发射器实例。
 *
 * @typeParam T - 回调函数类型
 * @returns 事件发射器
 *
 * @example
 * const emitter = createEmitter<() => void>();
 * const off = emitter.on(() => console.log('fired'));
 * emitter.emit();
 * off(); // 取消注册
 */
function createEmitter<T extends (...args: never[]) => void>(): SimpleEmitter<T> {
  const listeners = new Set<T>();

  return {
    on(cb: T): () => void {
      listeners.add(cb);
      // 返回取消函数
      return () => {
        listeners.delete(cb);
      };
    },

    emit(...args: Parameters<T>): void {
      // 遍历快照以允许回调中 off
      for (const cb of Array.from(listeners)) {
        try {
          cb(...args);
        } catch (err) {
          // 回调异常不应影响其他监听器
          if (__DEV__) {
            console.warn('[Tiles3DLayer] event callback error:', err);
          }
        }
      }
    },

    clear(): void {
      listeners.clear();
    },

    get size(): number {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// 内容加载桩（MVP 阶段：实际解码在 Worker 中完成）
// ---------------------------------------------------------------------------

/**
 * 加载瓦片内容并填充 renderData。
 * MVP 阶段为桩实现：发出 fetch 请求，读取文件头魔术字节判断类型，
 * 生成占位 TileRenderData。完整实现需将二进制数据发送到 Worker 解码。
 *
 * @param tile - 要加载内容的瓦片节点
 * @param abortSignal - 取消信号（图层卸载或瓦片淘汰时取消）
 * @returns Promise 在加载完成后 resolve
 *
 * @example
 * await loadTileContent(tile, controller.signal);
 */
async function loadTileContent(
  tile: RuntimeTile,
  abortSignal: AbortSignal,
): Promise<void> {
  // 内容 URI 为空——无需加载
  if (tile.contentUri === null) {
    return;
  }

  // 标记为加载中
  tile.contentState = 'loading';

  try {
    // 发起 HTTP 请求
    const response = await fetch(tile.contentUri, {
      signal: abortSignal,
    });

    // 检查 HTTP 状态
    if (!response.ok) {
      throw new Error(
        `[${TILES3D_ERROR_CODES.TILE_DECODE_FAILED}] HTTP ${response.status} for ${tile.contentUri}`,
      );
    }

    // 读取前 4 字节判断格式类型
    const arrayBuffer = await response.arrayBuffer();
    const dataView = new DataView(arrayBuffer);
    const magic = dataView.byteLength >= 4 ? dataView.getUint32(0, true) : 0;

    // 根据魔术字节判断内容类型
    let contentType: TileRenderData['type'] = 'unknown';
    if (magic === B3DM_MAGIC) {
      contentType = 'b3dm';
    } else if (magic === I3DM_MAGIC) {
      contentType = 'i3dm';
    } else if (magic === PNTS_MAGIC) {
      contentType = 'pnts';
    } else if (magic === GLB_MAGIC) {
      contentType = 'glb';
    }

    // 构造占位 TileRenderData
    // 完整实现会将 arrayBuffer 通过 WorkerPool.submit('tiles3d-decode', ...) 解码
    const gpuBytes = arrayBuffer.byteLength;
    const renderData: TileRenderData = {
      type: contentType,
      vertexBuffer: -1,
      indexBuffer: -1,
      vertexCount: 0,
      indexCount: 0,
      material: {
        baseColor: new Float32Array([1.0, 1.0, 1.0, 1.0]),
        hasTexture: false,
      },
      textures: [],
      instanceBuffer: -1,
      instanceCount: 0,
      batchTable: null,
      gpuBytes,
    };

    // 填充瓦片渲染数据
    tile.renderData = renderData;
    tile.gpuBytes = gpuBytes;
    tile.contentState = 'loaded';
  } catch (err: unknown) {
    // 区分中止和真正的错误
    if (err instanceof DOMException && err.name === 'AbortError') {
      // 请求被取消——重置为未加载（可重新请求）
      tile.contentState = 'unloaded';
      return;
    }

    // 真正的加载/解码错误
    tile.contentState = 'failed';

    if (__DEV__) {
      console.warn(
        `[Tiles3DLayer] Failed to load tile ${tile.id} from ${tile.contentUri}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// createTiles3DLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建 3D Tiles 图层实例。
 * 返回完整的 {@link Tiles3DLayer} 实现，包含 BVH 构建、SSE 遍历、
 * 视锥剔除、内存淘汰和瓦片内容异步加载（桩实现）。
 *
 * GPU 渲染管线（encode）在 MVP 阶段为桩实现——
 * 完整管线需要 L2/ShaderAssembler + PipelineCache + FrameGraphBuilder 协同，
 * 将在后续 Sprint 接入。
 *
 * @param opts - 3D Tiles 图层构造选项
 * @returns 完整的 Tiles3DLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const layer = createTiles3DLayer({
 *   id: 'buildings',
 *   url: 'https://example.com/tileset.json',
 *   maximumScreenSpaceError: 8,
 *   maximumMemoryUsage: 1024,
 * });
 * sceneGraph.addLayer(layer);
 */
export function createTiles3DLayer(opts: Tiles3DLayerOptions): Tiles3DLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);

  // ── 2. 内部状态 ──

  /** BVH 树根节点（tileset.json 加载后填充） */
  let rootTile: RuntimeTile | null = null;

  /** BVH 树的扁平列表（用于内存淘汰扫描） */
  let flatTileList: RuntimeTile[] = [];

  /** tileset.json 是否已加载完毕 */
  let tilesetReady = false;

  /** 当前帧被选中渲染的瓦片列表（每帧重建） */
  let currentRenderList: RuntimeTile[] = [];

  /** 当前帧需要加载的瓦片列表（每帧重建） */
  let currentLoadList: RuntimeTile[] = [];

  /** 当前帧序号（每帧递增） */
  let frameNumber = 0;

  /** 当前正在进行的并发加载数 */
  let activeLoadCount = 0;

  /** 当前 GPU 内存总占用（字节） */
  let totalGpuBytes = 0;

  /** 可变 SSE 阈值（运行时可调） */
  let maxSSE = cfg.maximumScreenSpaceError;

  /** 可变内存预算（字节） */
  let memoryBudgetBytes = cfg.maximumMemoryUsage * BYTES_PER_MB;

  /** 可变模型缩放 */
  let modelScale = cfg.modelScale;

  /** 可变模型偏移 */
  let modelOffset: [number, number, number] = [...cfg.modelOffset];

  /** 可变样式 */
  let currentStyle: Tiles3DStyle | null = cfg.style;

  /** 是否已挂载到场景 */
  let mounted = false;

  /** 引擎上下文 */
  let layerContext: LayerContext | null = null;

  /** tileset.json 加载请求的 AbortController */
  let tilesetAbortController: AbortController | null = null;

  /** 所有瓦片内容加载请求的 AbortController（卸载时统一取消） */
  let contentAbortController: AbortController | null = null;

  /** paint 属性缓存 */
  const paintProps = new Map<string, unknown>();

  /** layout 属性缓存 */
  const layoutProps = new Map<string, unknown>();

  /** 要素状态表 */
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 事件发射器
  const readyEmitter = createEmitter<() => void>();
  const tileLoadedEmitter = createEmitter<(tileId: number) => void>();
  const allTilesLoadedEmitter = createEmitter<() => void>();

  /** tileset.json 的基础 URL（内容 URI 相对路径解析用） */
  let baseUrl = resolveBaseUrl(cfg.url);

  /** 预计算的视锥平面缓存（每帧更新） */
  let cachedFrustumPlanes: Float32Array = new Float32Array(24);

  /** 上一帧是否所有可见瓦片已加载（用于检测 allTilesLoaded 事件） */
  let prevAllLoaded = false;

  // ── 3. tileset.json 加载 ──

  /**
   * 异步加载 tileset.json 并构建 BVH 树。
   * 在 onAdd 后自动调用。
   */
  async function loadTileset(): Promise<void> {
    tilesetAbortController = new AbortController();

    try {
      const response = await fetch(cfg.url, {
        signal: tilesetAbortController.signal,
      });

      // HTTP 错误处理
      if (!response.ok) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.TILESET_LOAD_FAILED}] HTTP ${response.status} fetching ${cfg.url}`,
        );
      }

      // 解析 JSON
      const json: unknown = await response.json();
      if (json === null || json === undefined || typeof json !== 'object') {
        throw new Error(
          `[${TILES3D_ERROR_CODES.TILESET_LOAD_FAILED}] tileset.json parsed as non-object`,
        );
      }

      const tilesetJson = json as TilesetJSON;

      // 校验必要字段
      if (tilesetJson.root === undefined || tilesetJson.root === null) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.TILESET_LOAD_FAILED}] tileset.json missing 'root' property`,
        );
      }

      if (tilesetJson.asset === undefined || tilesetJson.asset === null) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.TILESET_LOAD_FAILED}] tileset.json missing 'asset' property`,
        );
      }

      // 构建 BVH 树
      const idCounter = { value: TILE_ID_START };
      const parentIdentity = mat4.create();
      rootTile = buildBVHTree(
        tilesetJson.root,
        parentIdentity,
        'REPLACE',
        null,
        idCounter,
        baseUrl,
        modelScale,
        modelOffset,
        true,
      );

      // 扁平化用于内存淘汰
      flatTileList = flattenBVH(rootTile);

      // 标记就绪
      tilesetReady = true;

      // 创建内容加载的 AbortController
      contentAbortController = new AbortController();

      // 触发 ready 事件
      readyEmitter.emit();

      if (__DEV__) {
        console.debug(
          `[Tiles3DLayer:${cfg.id}] tileset loaded: ${flatTileList.length} tiles, ` +
            `rootGeometricError=${tilesetJson.geometricError.toFixed(2)}, ` +
            `version=${tilesetJson.asset.version}`,
        );
      }
    } catch (err: unknown) {
      // 区分取消和真正的错误
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }

      if (__DEV__) {
        console.error(
          `[Tiles3DLayer:${cfg.id}] Failed to load tileset.json from ${cfg.url}:`,
          err,
        );
      }
    }
  }

  // ── 4. 瓦片内容加载调度 ──

  /**
   * 处理加载列表中的瓦片——按并发上限逐个发起异步加载。
   * 每帧 onUpdate 结束后调用。
   */
  function processLoadQueue(): void {
    // 无可加载瓦片或已卸载
    if (currentLoadList.length === 0 || contentAbortController === null) {
      return;
    }

    // 按 SSE 降序排序——优先加载 SSE 大的（对画面影响最大）
    currentLoadList.sort((a, b) => b.screenSpaceError - a.screenSpaceError);

    // 逐个发起加载直到达到并发上限
    for (let i = 0; i < currentLoadList.length; i++) {
      if (activeLoadCount >= cfg.maxConcurrentRequests) {
        break;
      }

      const tile = currentLoadList[i];

      // 跳过已在加载中或已加载的瓦片
      if (tile.contentState !== 'unloaded') {
        continue;
      }

      // 发起异步加载
      activeLoadCount += 1;
      loadTileContent(tile, contentAbortController.signal)
        .then(() => {
          activeLoadCount -= 1;

          // 加载成功——更新 GPU 内存计数
          if (tile.contentState === 'loaded') {
            totalGpuBytes += tile.gpuBytes;

            // 触发 tileLoaded 事件
            tileLoadedEmitter.emit(tile.id);
          }
        })
        .catch(() => {
          // 错误已在 loadTileContent 内处理，此处仅回收计数
          activeLoadCount -= 1;
        });
    }
  }

  // ── 5. 重建 BVH（当 modelScale/modelOffset 变更时） ──

  /**
   * 重建 BVH 树以反映新的 modelScale/modelOffset。
   * 重新解析已缓存的 tileset.json 根节点。
   */
  function rebuildBVH(): void {
    if (rootTile === null) {
      return;
    }

    // 保留原始 JSON 引用
    const originalJson = rootTile.json;

    // 取消所有进行中的内容加载
    if (contentAbortController !== null) {
      contentAbortController.abort();
    }

    // 重建树
    const idCounter = { value: TILE_ID_START };
    const parentIdentity = mat4.create();
    rootTile = buildBVHTree(
      originalJson,
      parentIdentity,
      'REPLACE',
      null,
      idCounter,
      baseUrl,
      modelScale,
      modelOffset,
      true,
    );

    flatTileList = flattenBVH(rootTile);

    // 重置内存计数（旧 GPU 资源已标记释放）
    totalGpuBytes = 0;

    // 重建内容 AbortController
    contentAbortController = new AbortController();
  }

  // ── 6. 构造 Layer 实现对象 ──
  const layer: Tiles3DLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: '3d-tiles' as const,
    source: cfg.url,
    projection: 'ecef',

    // ==================== 可变渲染属性 ====================
    visible: cfg.show,
    opacity: 1,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（tileset.json 已加载且 BVH 已构建）。
     */
    get isLoaded(): boolean {
      return tilesetReady;
    },

    /**
     * 是否包含半透明内容。
     * 3D Tiles 默认不透明（除非样式中指定了透明色）。
     */
    get isTransparent(): boolean {
      return layer.opacity < 1;
    },

    /**
     * 全局渲染次序。
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * tileset.json 是否已加载完毕。
     */
    get isReady(): boolean {
      return tilesetReady;
    },

    /**
     * 已加载内容的瓦片数量。
     */
    get loadedTileCount(): number {
      let count = 0;
      for (let i = 0; i < flatTileList.length; i++) {
        if (flatTileList[i].contentState === 'loaded') {
          count += 1;
        }
      }
      return count;
    },

    /**
     * 当前帧实际渲染的瓦片数量。
     */
    get renderedTileCount(): number {
      return currentRenderList.length;
    },

    /**
     * 当前 GPU 内存使用量（字节）。
     */
    get gpuMemoryUsage(): number {
      return totalGpuBytes;
    },

    /**
     * BVH 树中的瓦片总数。
     */
    get totalTileCount(): number {
      return flatTileList.length;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载到场景——保存上下文并启动 tileset.json 加载。
     *
     * @param context - 引擎注入的上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;

      // 异步加载 tileset.json（不阻塞挂载流程）
      loadTileset();
    },

    /**
     * 图层从场景卸载——取消所有加载、释放内部状态。
     */
    onRemove(): void {
      // 取消 tileset.json 加载
      if (tilesetAbortController !== null) {
        tilesetAbortController.abort();
        tilesetAbortController = null;
      }

      // 取消所有瓦片内容加载
      if (contentAbortController !== null) {
        contentAbortController.abort();
        contentAbortController = null;
      }

      // 清空所有内部状态
      rootTile = null;
      flatTileList = [];
      tilesetReady = false;
      currentRenderList = [];
      currentLoadList = [];
      activeLoadCount = 0;
      totalGpuBytes = 0;
      frameNumber = 0;
      prevAllLoaded = false;

      // 清空属性缓存
      paintProps.clear();
      layoutProps.clear();
      featureStateMap.clear();

      // 清空事件监听器
      readyEmitter.clear();
      tileLoadedEmitter.clear();
      allTilesLoadedEmitter.clear();

      // 重置标志
      mounted = false;
      layerContext = null;
    },

    /**
     * 每帧更新——执行 BVH 遍历、SSE 判断、视锥剔除、内存淘汰、加载调度。
     *
     * @param deltaTime - 距上一帧的时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // tileset 未就绪或不可见——跳过
      if (!tilesetReady || rootTile === null || !layer.visible) {
        currentRenderList = [];
        currentLoadList = [];
        return;
      }

      // 递增帧号
      frameNumber += 1;

      // 预计算 SSE 因子
      // 使用 camera.fov 和视口高度（从 camera.altitude/zoom 近似推导）
      // MVP 阶段使用固定视口高度 1080 作为退化值
      const viewportHeight = 1080;
      const sseFactor = computeSSEFactor(viewportHeight, camera.fov);

      // 提取视锥平面
      cachedFrustumPlanes = extractFrustumPlanes(camera.vpMatrix);

      // 重建渲染/加载列表
      currentRenderList = [];
      currentLoadList = [];

      // 执行 BVH 遍历
      traverseBVH(
        rootTile,
        camera.position,
        sseFactor,
        maxSSE,
        cachedFrustumPlanes,
        frameNumber,
        currentRenderList,
        currentLoadList,
      );

      // 内存淘汰
      if (totalGpuBytes > memoryBudgetBytes) {
        const evicted = evictTiles(flatTileList, totalGpuBytes, memoryBudgetBytes, frameNumber);

        // 重新计算 GPU 内存
        totalGpuBytes = 0;
        for (let i = 0; i < flatTileList.length; i++) {
          totalGpuBytes += flatTileList[i].gpuBytes;
        }

        if (__DEV__ && evicted > 0) {
          console.debug(
            `[Tiles3DLayer:${cfg.id}] evicted ${evicted} tiles, GPU memory: ${(totalGpuBytes / BYTES_PER_MB).toFixed(1)}MB / ${cfg.maximumMemoryUsage}MB`,
          );
        }
      }

      // 调度瓦片内容加载
      processLoadQueue();

      // 检测 allTilesLoaded 事件
      const allLoaded = currentLoadList.length === 0 && activeLoadCount === 0 && currentRenderList.length > 0;
      if (allLoaded && !prevAllLoaded) {
        allTilesLoadedEmitter.emit();
      }
      prevAllLoaded = allLoaded;
    },

    /**
     * 将 3D Tiles 绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现——完整管线需要 ShaderAssembler + PipelineCache。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要以下步骤：
      // 1. 遍历 currentRenderList
      // 2. 每个瓦片：
      //    a. setPipeline(根据 renderData.type 选择 b3dm/pnts 管线)
      //    b. setBindGroup(0, globalUniforms: VP矩阵 + 光照)
      //    c. setBindGroup(1, tileUniforms: worldTransform + 材质)
      //    d. setVertexBuffer(0, renderData.vertexBuffer)
      //    e. setIndexBuffer(renderData.indexBuffer)
      //    f. drawIndexed(renderData.indexCount) 或 draw(renderData.vertexCount)
      if (__DEV__) {
        if (currentRenderList.length > 0) {
          console.debug(
            `[Tiles3DLayer:${cfg.id}] encode stub: ${currentRenderList.length} tiles rendered, ` +
              `${currentLoadList.length} pending, ` +
              `GPU=${(totalGpuBytes / BYTES_PER_MB).toFixed(1)}MB`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——使用瓦片/要素 ID 编码进行 GPU 拾取。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现使用瓦片 ID + batch ID → color 编码
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性值。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
    },

    /**
     * 设置 layout 属性值。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      // 同步 visibility
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性。
     *
     * @param name - 属性名
     * @returns 属性值或 undefined
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性。
     *
     * @param name - 属性名
     * @returns 属性值或 undefined
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素状态。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态对象或 undefined
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 3D Tiles 特有方法 ====================

    /**
     * 设置最大屏幕空间误差阈值。
     *
     * @param sse - 新阈值（像素），范围 [1, 256]
     */
    setMaximumScreenSpaceError(sse: number): void {
      if (!Number.isFinite(sse) || sse < MIN_SSE || sse > MAX_SSE) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.INVALID_SSE}] maximumScreenSpaceError must be in [${MIN_SSE}, ${MAX_SSE}], got ${sse}`,
        );
      }
      maxSSE = sse;
    },

    /**
     * 设置最大 GPU 内存预算。
     *
     * @param mb - 新预算（MB），范围 [64, 4096]
     */
    setMaximumMemoryUsage(mb: number): void {
      if (!Number.isFinite(mb) || mb < MIN_MEMORY_MB || mb > MAX_MEMORY_MB) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.INVALID_MEMORY}] maximumMemoryUsage must be in [${MIN_MEMORY_MB}, ${MAX_MEMORY_MB}], got ${mb}`,
        );
      }
      memoryBudgetBytes = mb * BYTES_PER_MB;
    },

    /**
     * 设置模型整体缩放比例。
     * 触发 BVH 重建以反映新的变换。
     *
     * @param scale - 缩放比例（正有限数）
     */
    setModelScale(scale: number): void {
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] modelScale must be a positive finite number, got ${scale}`,
        );
      }
      modelScale = scale;

      // 重建 BVH 以反映新缩放
      if (tilesetReady) {
        rebuildBVH();
      }
    },

    /**
     * 设置模型整体平移偏移。
     * 触发 BVH 重建以反映新的变换。
     *
     * @param offset - [x, y, z] 偏移量（米）
     */
    setModelOffset(offset: [number, number, number]): void {
      if (
        !Array.isArray(offset) ||
        offset.length < 3 ||
        !Number.isFinite(offset[0]) ||
        !Number.isFinite(offset[1]) ||
        !Number.isFinite(offset[2])
      ) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.INVALID_OPTIONS}] modelOffset must be [number, number, number] with finite values`,
        );
      }
      modelOffset = [offset[0], offset[1], offset[2]];

      // 重建 BVH 以反映新偏移
      if (tilesetReady) {
        rebuildBVH();
      }
    },

    /**
     * 设置条件样式。
     *
     * @param style - 新样式配置，null 清除自定义样式
     */
    setStyle(style: Tiles3DStyle | null): void {
      currentStyle = style;
      // 样式变更不需要重建 BVH，仅影响渲染 Pass 的 Uniform
    },

    /**
     * 获取瓦片集整体包围体。
     *
     * @returns 根节点世界包围体的中心和半轴，或 null 若瓦片集未加载
     */
    getBoundingVolume(): { center: Float32Array; halfAxes: Float32Array } | null {
      if (rootTile === null) {
        return null;
      }
      return {
        center: new Float32Array(rootTile.worldBoundingVolume.center),
        halfAxes: new Float32Array(rootTile.worldBoundingVolume.halfAxes),
      };
    },

    /**
     * 飞行至瓦片集的最佳视角。
     * 计算根包围球的包围距离，将相机移至可完整看到瓦片集的位置。
     *
     * @param camera - 相机控制器实例
     * @param options - 可选参数（时长、方位角、俯仰角）
     * @returns 飞行动画句柄
     */
    flyTo(camera: CameraController, options?: {
      readonly duration?: number;
      readonly bearing?: number;
      readonly pitch?: number;
    }): CameraAnimation {
      // 瓦片集必须已就绪
      if (rootTile === null || !tilesetReady) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.NO_ROOT_BOUNDING}] Cannot flyTo: tileset not ready`,
        );
      }

      const bv = rootTile.worldBoundingVolume;

      // 包围球半径为 0 时无法计算距离
      if (bv.radius <= 0) {
        throw new Error(
          `[${TILES3D_ERROR_CODES.NO_ROOT_BOUNDING}] Cannot flyTo: root bounding volume has zero radius`,
        );
      }

      // 计算飞行目标距离 = radius / sin(fov/2) × 安全系数
      // sin(fov/2) 确保整个包围球恰好填满视口（垂直方向）
      const fov = camera.state.fov > 0 ? camera.state.fov : Math.PI / 4;
      const sinHalfFov = Math.sin(fov * 0.5);
      // 防止 sin(fov/2) 为零
      const safeSinHalfFov = Math.max(sinHalfFov, 1e-6);
      const distance = (bv.radius / safeSinHalfFov) * FLY_TO_DISTANCE_FACTOR;

      // 计算包围体中心的经纬度（从 ECEF 近似反算）
      // ECEF → (lon, lat) 简化球面模型
      const cx = bv.center[0];
      const cy = bv.center[1];
      const cz = bv.center[2];
      const horizontalDist = Math.sqrt(cx * cx + cy * cy);

      let centerLon: number;
      let centerLat: number;

      if (horizontalDist < 1e-10) {
        // 极点退化
        centerLon = 0;
        centerLat = cz >= 0 ? 90 : -90;
      } else {
        // atan2(y, x) 返回弧度，转换为度
        centerLon = Math.atan2(cy, cx) * RAD_TO_DEG;
        centerLat = Math.atan2(cz, horizontalDist) * RAD_TO_DEG;
      }

      // 确保经纬度在有效范围
      centerLon = Math.max(-180, Math.min(180, centerLon));
      centerLat = Math.max(-90, Math.min(90, centerLat));

      // 从距离估算 zoom（使用地球周长 / 2^zoom / tileSize 公式的逆运算）
      // altitude ≈ distance，zoom ≈ log2(earthCircumference / (altitude × tileSize / viewportHeight))
      // 这里用简单的 altitude-to-zoom 估算
      const EARTH_CIRCUMFERENCE = 40075017;
      const TILE_SIZE = 256;
      const estimatedZoom = Math.log2(EARTH_CIRCUMFERENCE / (distance * TILE_SIZE / 1080));
      const clampedZoom = Math.max(0, Math.min(22, estimatedZoom));

      // 调用相机的 flyTo
      return camera.flyTo({
        center: [centerLon, centerLat],
        zoom: clampedZoom,
        bearing: options?.bearing ?? 0,
        pitch: options?.pitch ?? 0,
        duration: options?.duration ?? 1500,
      });
    },

    /**
     * 注册 tileset.json 加载完成回调。
     *
     * @param cb - 回调函数
     * @returns 取消注册函数
     */
    onReady(cb: () => void): () => void {
      // 如果已就绪，立即异步调用（不阻塞当前调用栈）
      if (tilesetReady) {
        queueMicrotask(() => {
          try {
            cb();
          } catch (err) {
            if (__DEV__) {
              console.warn('[Tiles3DLayer] onReady callback error:', err);
            }
          }
        });
      }
      return readyEmitter.on(cb);
    },

    /**
     * 注册单个瓦片加载完成回调。
     *
     * @param cb - 回调函数，参数为瓦片 ID
     * @returns 取消注册函数
     */
    onTileLoaded(cb: (tileId: number) => void): () => void {
      return tileLoadedEmitter.on(cb);
    },

    /**
     * 注册所有可见瓦片加载完成回调。
     *
     * @param cb - 回调函数
     * @returns 取消注册函数
     */
    onAllTilesLoaded(cb: () => void): () => void {
      return allTilesLoadedEmitter.on(cb);
    },

    // ==================== 阴影 Pass 编码（可选） ====================

    /**
     * 阴影 Pass 编码——在 CSM 阴影贴图中渲染此图层的几何体。
     * 仅当 castShadow === true 时由 RenderGraph 调用。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 阴影相机快照
     */
    encodeShadow(_encoder: GPURenderPassEncoder, _camera: CameraState) {
      if (!cfg.castShadow) {
        return;
      }
      // MVP 桩：完整实现使用深度 only 管线将几何体渲染到阴影贴图
      if (__DEV__) {
        if (currentRenderList.length > 0) {
          console.debug(
            `[Tiles3DLayer:${cfg.id}] encodeShadow stub: ${currentRenderList.length} tiles`,
          );
        }
      }
    },
  };

  return layer;
}
