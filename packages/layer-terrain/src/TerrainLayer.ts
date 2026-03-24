// ============================================================
// TerrainLayer.ts — 地形图层（L4 图层包）
// 职责：管理 DEM 瓦片的生命周期（加载→解码→网格生成→GPU 缓冲区→渲染），
//       维护每瓦片高程缓存，支持高程查询 / Morphing 过渡 / LOD 边缘约束，
//       按 Mapbox 或 Terrarium 编码解码 DEM 像素为高程值。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建定义为 false 以便 tree-shake 剥离调试代码）
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建由 bundler 定义为 `false`，
 * 使所有 `if (__DEV__)` 分支在 tree-shake 中被移除。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/**
 * TerrainLayer 模块错误码，前缀 `TERRAIN_` 以避免跨模块碰撞。
 */
const TERRAIN_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'TERRAIN_INVALID_OPTIONS',
  /** 夸张系数超出有效区间 */
  INVALID_EXAGGERATION: 'TERRAIN_INVALID_EXAGGERATION',
  /** 网格分辨率不合法（非 2 的幂 / 超出 [8,128]） */
  INVALID_MESH_RESOLUTION: 'TERRAIN_INVALID_MESH_RESOLUTION',
  /** DEM 编码类型不在支持列表中 */
  INVALID_ENCODING: 'TERRAIN_INVALID_ENCODING',
  /** 裙边高度为非法值 */
  INVALID_SKIRT_HEIGHT: 'TERRAIN_INVALID_SKIRT_HEIGHT',
  /** Morph 范围超出 (0,1) */
  INVALID_MORPH_RANGE: 'TERRAIN_INVALID_MORPH_RANGE',
  /** 高程查询超时 */
  ELEVATION_QUERY_TIMEOUT: 'TERRAIN_ELEVATION_QUERY_TIMEOUT',
  /** 高程查询坐标超出有效范围 */
  INVALID_COORDINATES: 'TERRAIN_INVALID_COORDINATES',
  /** DEM 像素数据不合法 */
  INVALID_IMAGE_DATA: 'TERRAIN_INVALID_IMAGE_DATA',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认高程夸张系数，1.0 表示真实高度 */
const DEFAULT_EXAGGERATION = 1.0;

/** 默认网格分辨率（每瓦片网格边长的顶点数 - 1），即 32×32 格子 = 33×33 顶点 */
const DEFAULT_MESH_RESOLUTION = 32;

/** 默认 DEM 编码格式（Mapbox Terrain-RGB） */
const DEFAULT_ENCODING: 'mapbox' | 'terrarium' = 'mapbox';

/** 默认 Morph 过渡区间占缩放级差的比例，(0,1) 范围 */
const DEFAULT_MORPH_RANGE = 0.3;

/** 裙边高度系数：自动模式下 skirtHeight = maxElevationRange × SKIRT_HEIGHT_FACTOR */
const SKIRT_HEIGHT_FACTOR = 5;

/**
 * Mapbox Terrain-RGB 编码基准值（米）。
 * 公式：height = MAPBOX_DEM_BASE + (R×65536 + G×256 + B) × MAPBOX_DEM_SCALE
 */
const MAPBOX_DEM_BASE = -10000;

/**
 * Mapbox Terrain-RGB 编码缩放因子（米/单位）。
 */
const MAPBOX_DEM_SCALE = 0.1;

/**
 * Terrarium 编码基准偏移量（米）。
 * 公式：height = (R×256 + G + B/256) + TERRARIUM_DEM_BASE
 */
const TERRARIUM_DEM_BASE = -32768;

/** 异步高程查询的超时时间（毫秒） */
const ELEVATION_QUERY_TIMEOUT_MS = 5000;

/** 夸张系数上限 */
const MAX_EXAGGERATION = 100;

/** 网格分辨率下限（最低 8×8 格子） */
const MIN_MESH_RESOLUTION = 8;

/** 网格分辨率上限（最高 128×128 格子） */
const MAX_MESH_RESOLUTION = 128;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 不透明度下限 */
const OPACITY_MIN = 0;

/** 不透明度上限 */
const OPACITY_MAX = 1;

/** 经度有效范围下限 */
const LNG_MIN = -180;

/** 经度有效范围上限 */
const LNG_MAX = 180;

/** 纬度有效范围下限 */
const LAT_MIN = -90;

/** 纬度有效范围上限 */
const LAT_MAX = 90;

/** RGBA 像素的字节数 */
const RGBA_BYTES_PER_PIXEL = 4;

/** 每个三角形的索引数量 */
const INDICES_PER_TRIANGLE = 3;

/** 每个顶点的浮点分量数（position xyz + normal xyz + uv st = 8 floats） */
const FLOATS_PER_VERTEX = 8;

/** 裙边每段四边形需要的三角形数量（2 个三角形 = 6 个索引） */
const SKIRT_INDICES_PER_SEGMENT = 6;

/** 裙边四条边：上、右、下、左 */
const SKIRT_EDGE_COUNT = 4;

// ---------------------------------------------------------------------------
// 支持的 DEM 编码类型集合
// ---------------------------------------------------------------------------

/** 支持的 DEM 编码格式白名单，用于选项校验 */
const SUPPORTED_ENCODINGS = new Set<string>(['mapbox', 'terrarium']);

// ---------------------------------------------------------------------------
// TerrainLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 地形图层构造选项。
 * 由用户传入 `createTerrainLayer`，驱动图层初始化。
 *
 * @example
 * const opts: TerrainLayerOptions = {
 *   id: 'terrain-dem',
 *   source: 'mapbox-terrain-dem',
 *   exaggeration: 1.5,
 *   meshResolution: 64,
 *   encoding: 'mapbox',
 *   skirtHeight: 'auto',
 *   enableMorphing: true,
 *   morphRange: 0.3,
 *   enableLighting: true,
 * };
 */
export interface TerrainLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的 DEM 数据源 ID（对应 StyleSpec.sources 中的键名）。
   * 数据源应提供 Terrain-RGB 或 Terrarium 编码的 PNG 瓦片。
   * 必填。
   */
  readonly source: string;

  /**
   * 高程夸张系数。
   * 1.0 = 真实高度，2.0 = 两倍高度。
   * 用于在低山区域增强地形起伏的视觉效果。
   * 范围 [0, 100]。0 = 完全平坦。
   * 可选，默认 1.0。
   */
  readonly exaggeration?: number;

  /**
   * 网格分辨率——每瓦片一条边被分割的段数。
   * 值越大则三角网越精细、高程还原越准确，但顶点数呈二次方增长。
   * 必须为 2 的幂次方，范围 [8, 128]。
   * 可选，默认 32。
   */
  readonly meshResolution?: number;

  /**
   * DEM 像素编码格式。
   * - `'mapbox'`：Mapbox Terrain-RGB。 height = -10000 + (R×65536 + G×256 + B) × 0.1
   * - `'terrarium'`：Terrarium。 height = (R×256 + G + B/256) - 32768
   * 可选，默认 `'mapbox'`。
   */
  readonly encoding?: 'mapbox' | 'terrarium';

  /**
   * 裙边高度（米）。
   * 裙边是沿瓦片四边向下延伸的三角条带，用于遮挡相邻瓦片之间的缝隙。
   * - 数值：固定裙边高度（米）
   * - `'auto'`：根据瓦片高程范围自动计算（最大高差 × SKIRT_HEIGHT_FACTOR）
   * 可选，默认 `'auto'`。
   */
  readonly skirtHeight?: number | 'auto';

  /**
   * 是否启用 LOD Morphing 过渡。
   * 启用后，瓦片在缩放级别切换时顶点高程在父级和子级之间平滑插值，
   * 避免突变弹跳（popping）。
   * 可选，默认 true。
   */
  readonly enableMorphing?: boolean;

  /**
   * Morph 过渡区间比例。
   * 当缩放级别的小数部分进入 [1 - morphRange, 1] 时开始过渡。
   * 范围 (0, 1)。值越大过渡区间越长、越平滑但计算量越大。
   * 可选，默认 0.3。
   */
  readonly morphRange?: number;

  /**
   * 是否启用光照计算（基于法线的漫反射着色）。
   * 关闭时使用纯色/纹理着色，无明暗变化。
   * 可选，默认 true。
   */
  readonly enableLighting?: boolean;

  /**
   * 图层可见的最小缩放级别（含）。
   * 低于此级别时图层不渲染。
   * 范围 [0, 22]。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 范围 [0, 22]，必须 ≥ minzoom。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 图层初始不透明度。
   * 范围 [0, 1]。
   * 可选，默认 1。
   */
  readonly opacity?: number;

  /**
   * 投影标识（对应 SceneGraph 的投影分组键）。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * paint 属性表（预留扩展，地形图层暂无 paint 属性）。
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * layout 属性表。
   * 支持键：
   * - `'visibility'`: `'visible'` | `'none'`
   * 可选。
   */
  readonly layout?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TerrainTileRenderData（每瓦片渲染数据）
// ---------------------------------------------------------------------------

/**
 * 单个地形瓦片的渲染数据包。
 * 由 Worker 完成网格构建后回传主线程填充，encode() 遍历此结构提交绘制命令。
 *
 * @internal 仅模块内使用，不导出为公共 API。
 */
interface TerrainTileRenderData {
  /** 瓦片 XYZ 坐标，标识在金字塔中的位置 */
  coord: TileCoord;

  /**
   * GPU 顶点缓冲区 ID（由 BufferPool 分配）。
   * 顶点布局：position(xyz) + normal(xyz) + uv(st) = 8 floats/vertex。
   * MVP 阶段使用 number 占位。
   */
  vertexBufferHandle: number;

  /**
   * GPU 索引缓冲区 ID（由 BufferPool 分配）。
   * Uint32 索引，描述三角形连接关系。
   * MVP 阶段使用 number 占位。
   */
  indexBufferHandle: number;

  /** 三角形数量（= indexCount / 3），用于 drawIndexed 调用 */
  triangleCount: number;

  /**
   * 高程纹理句柄 ID（由 TextureManager 分配）。
   * 存储原始解码后的高程值，供 Shader 采样。
   * MVP 阶段使用 number 占位。
   */
  elevationTextureHandle: number;

  /**
   * 法线纹理句柄 ID（由 TextureManager 分配）。
   * 存储中心差分计算的法线向量，供光照着色器采样。
   * MVP 阶段使用 number 占位。
   */
  normalTextureHandle: number;

  /** 该瓦片内高程值的范围 [最小高程, 最大高程]（米），用于裙边计算和视锥剔除 */
  heightRange: [number, number];

  /** 瓦片覆盖的地理范围（经纬度包围盒） */
  extent: BBox2D;

  /**
   * 父级瓦片的高程采样（用于 Morphing 过渡）。
   * 长度与网格顶点数相同，存储从父级 DEM 双线性插值得到的高程值。
   * 当 enableMorphing=false 或父级不可用时为 null。
   */
  parentHeights: Float32Array | null;

  /**
   * 当前帧的 Morph 因子 [0, 1]。
   * 0 = 完全使用当前级别高程，1 = 完全使用父级高程。
   * 由 onUpdate 根据缩放小数部分和 morphRange 计算。
   */
  morphFactor: number;
}

// ---------------------------------------------------------------------------
// TerrainMeshBuildParams（网格构建参数——用于 Worker 消息）
// ---------------------------------------------------------------------------

/**
 * 地形网格构建参数，由主线程组装后发送到 Worker。
 * Worker 根据此参数解码 DEM、生成三角网+法线+裙边。
 *
 * @internal 仅模块内使用。
 */
interface TerrainMeshBuildParams {
  /** DEM 图像像素数据（RGBA Uint8），来自 fetch+decode 的原始像素 */
  imageData: Uint8Array;

  /** 图像宽度（像素） */
  imageWidth: number;

  /** 图像高度（像素） */
  imageHeight: number;

  /** DEM 编码格式 */
  encoding: 'mapbox' | 'terrarium';

  /** 网格分辨率（段数） */
  resolution: number;

  /** 高程夸张系数 */
  exaggeration: number;

  /** 裙边高度（米），已解析（非 'auto'） */
  skirtHeight: number;

  /** 瓦片地理范围 */
  extent: BBox2D;

  /** 父级 DEM 数据（用于 Morphing），可为 null */
  parentDEM: Float32Array | null;
}

// ---------------------------------------------------------------------------
// TerrainMeshResult（网格构建结果——Worker 返回）
// ---------------------------------------------------------------------------

/**
 * 地形网格构建结果，由 Worker 计算完毕后回传主线程。
 * vertices/indices 的 buffer 通过 transferable 传输以实现零拷贝。
 *
 * @internal 仅模块内使用。
 */
interface TerrainMeshResult {
  /** 交错顶点数组：[px,py,pz, nx,ny,nz, u,v, ...] */
  vertices: Float32Array;

  /** 三角形索引数组 */
  indices: Uint32Array;

  /** 高程范围 [min, max]（米，已乘夸张系数） */
  heightRange: [number, number];

  /** 解码后的高程网格数据（未乘夸张系数，用于 CPU 高程查询） */
  elevationData: Float32Array;

  /** 法线数据（与顶点一一对应的紧凑 xyz 数组） */
  normalData: Float32Array;

  /** 父级高程采样值（用于 Morphing），或 null */
  parentHeights: Float32Array | null;

  /** 可转移对象列表（零拷贝传输所用的 ArrayBuffer） */
  transferables: ArrayBuffer[];
}

// ---------------------------------------------------------------------------
// 每瓦片高程缓存条目
// ---------------------------------------------------------------------------

/**
 * 用于 CPU 端高程查询的每瓦片高程缓存。
 * 存储解码后的高程网格，支持双线性插值查询。
 *
 * @internal 仅模块内使用。
 */
interface ElevationCacheEntry {
  /** 解码后的高程网格（行优先，大小 = (resolution+1) × (resolution+1)） */
  heights: Float32Array;

  /** 瓦片地理范围 */
  extent: BBox2D;

  /** 网格分辨率（段数），用于索引计算 */
  resolution: number;
}

// ---------------------------------------------------------------------------
// TerrainLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 地形图层接口——在 Layer 基础上扩展高程查询、夸张系数控制和网格分辨率调节。
 * 实例由 `createTerrainLayer` 工厂创建。
 *
 * @example
 * const terrain = createTerrainLayer({
 *   id: 'terrain',
 *   source: 'mapbox-terrain-dem',
 *   exaggeration: 1.5,
 *   encoding: 'mapbox',
 * });
 * sceneGraph.addLayer(terrain);
 *
 * // 查询某点高程
 * const h = await terrain.getElevation(116.39, 39.91);
 * console.log(`北京高程: ${h}m`);
 *
 * // 同步查询（瓦片未加载时返回 null）
 * const hSync = terrain.getElevationSync(116.39, 39.91);
 */
export interface TerrainLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'terrain'` */
  readonly type: 'terrain';

  /** 当前高程夸张系数（只读，通过 setExaggeration 修改） */
  readonly exaggeration: number;

  /**
   * 异步查询指定经纬度的高程值（米）。
   * 使用双线性插值从最接近的已加载 DEM 瓦片中采样。
   * 若对应瓦片未加载，会等待加载完成或超时。
   *
   * @param lon - 经度（度），范围 [-180, 180]
   * @param lat - 纬度（度），范围 [-90, 90]
   * @returns 高程值（米），已乘夸张系数
   * @throws 若坐标无效或查询超时
   *
   * @stability experimental
   *
   * @example
   * const elevation = await terrain.getElevation(116.39, 39.91);
   */
  getElevation(lon: number, lat: number): Promise<number>;

  /**
   * 同步查询指定经纬度的高程值。
   * 仅在对应 DEM 瓦片已加载到缓存中时返回数值，否则返回 null。
   * 不会触发网络请求，适用于高频调用场景（如鼠标移动）。
   *
   * @param lon - 经度（度），范围 [-180, 180]
   * @param lat - 纬度（度），范围 [-90, 90]
   * @returns 高程值（米，已乘夸张系数），或 null（瓦片未加载）
   *
   * @stability experimental
   *
   * @example
   * const h = terrain.getElevationSync(116.39, 39.91);
   * if (h !== null) console.log(`高程: ${h}m`);
   */
  getElevationSync(lon: number, lat: number): number | null;

  /**
   * 批量查询高程剖面线。
   * 沿给定点列等间距采样，返回每个采样点的高程值数组。
   *
   * @param points - 采样点坐标数组 [[lon,lat], [lon,lat], ...]
   * @param sampleCount - 总采样点数（含起终点），默认等于 points.length
   * @returns 高程值数组（米，已乘夸张系数），长度等于 sampleCount
   *
   * @stability experimental
   *
   * @example
   * const profile = await terrain.getElevationProfile(
   *   [[116.0, 39.0], [117.0, 40.0]],
   *   100,
   * );
   */
  getElevationProfile(
    points: ReadonlyArray<[number, number]>,
    sampleCount?: number,
  ): Promise<number[]>;

  /**
   * 设置高程夸张系数。
   * 已加载瓦片的网格不会立即重建——新值将在下一帧 onUpdate 中生效，
   * 后续加载的瓦片将使用新系数。
   *
   * @param value - 夸张系数，范围 [0, 100]
   * @throws 若 value 不是有限数或超出有效范围
   *
   * @stability experimental
   *
   * @example
   * terrain.setExaggeration(2.0); // 高程放大两倍
   */
  setExaggeration(value: number): void;

  /**
   * 设置网格分辨率。
   * 已加载瓦片不受影响，新值对后续加载的瓦片生效。
   *
   * @param resolution - 网格段数，范围 [8, 128]，必须为 2 的幂
   * @throws 若 resolution 不合法
   *
   * @stability experimental
   *
   * @example
   * terrain.setMeshResolution(64); // 提高网格精度
   */
  setMeshResolution(resolution: number): void;

  /**
   * 获取全局高程纹理。
   * MVP 阶段返回 null——完整实现将返回一个拼合的全局 DEM 纹理，
   * 供其它图层（如水面、阴影）读取地形高度。
   *
   * @returns 始终返回 null（MVP 桩）
   *
   * @stability internal
   */
  getElevationTexture(): null;

  /**
   * 获取全局法线纹理。
   * MVP 阶段返回 null——完整实现将返回法线贴图用于光照。
   *
   * @returns 始终返回 null（MVP 桩）
   *
   * @stability internal
   */
  getNormalTexture(): null;
}

// ---------------------------------------------------------------------------
// 瓦片坐标→字符串键（用于 Map 索引）
// ---------------------------------------------------------------------------

/**
 * 将瓦片坐标序列化为唯一字符串键，用于 Map/Set 索引。
 * 格式 `z/x/y`，保证同一坐标总是产出相同键。
 *
 * @param coord - 瓦片 XYZ 坐标
 * @returns 形如 `"8/215/99"` 的字符串
 *
 * @example
 * tileKey({ x: 215, y: 99, z: 8 }); // '8/215/99'
 */
function tileKey(coord: TileCoord): string {
  return `${coord.z}/${coord.x}/${coord.y}`;
}

// ---------------------------------------------------------------------------
// 判断是否为 2 的幂
// ---------------------------------------------------------------------------

/**
 * 判断一个正整数是否为 2 的幂。
 * 使用位运算 `n & (n - 1) === 0` 的经典技巧：
 * 2 的幂在二进制中只有一个 1 位，减 1 后所有低位变 1，AND 结果为 0。
 *
 * @param n - 待检查的正整数
 * @returns true 若 n 是 2 的幂
 *
 * @example
 * isPowerOfTwo(32);  // true
 * isPowerOfTwo(33);  // false
 */
function isPowerOfTwo(n: number): boolean {
  // 排除非正整数的情况
  if (n <= 0 || Math.floor(n) !== n) {
    return false;
  }
  // 经典位运算：2 的幂只有最高位为 1，减 1 后该位变 0、低位全 1
  return (n & (n - 1)) === 0;
}

// ---------------------------------------------------------------------------
// DEM 解码函数
// ---------------------------------------------------------------------------

/**
 * 将 Mapbox Terrain-RGB 编码的 RGB 像素值解码为海拔高程（米）。
 *
 * Mapbox Terrain-RGB 公式：
 *   height = -10000 + (R × 65536 + G × 256 + B) × 0.1
 *
 * 编码精度为 0.1 米，理论范围约 [-10000, +1667721.5] 米，
 * 涵盖地球上所有海拔和大部分海底深度。
 *
 * @param r - 红色通道值 [0, 255]
 * @param g - 绿色通道值 [0, 255]
 * @param b - 蓝色通道值 [0, 255]
 * @returns 海拔高程（米）
 *
 * @example
 * // 海平面编码为 R=1, G=134, B=160 → 0.0m
 * decodeMapboxHeight(1, 134, 160); // ≈ 0.0
 *
 * // 珠穆朗玛峰 8848m → 对应特定 RGB 值
 * decodeMapboxHeight(2, 73, 192);  // ≈ 8848.0
 */
function decodeMapboxHeight(r: number, g: number, b: number): number {
  // 将 RGB 三通道编码为一个 24 位无符号整数，再乘以 0.1 得到米
  // R 占高 8 位（×65536=×2^16），G 占中 8 位（×256=×2^8），B 占低 8 位
  return MAPBOX_DEM_BASE + (r * 65536 + g * 256 + b) * MAPBOX_DEM_SCALE;
}

/**
 * 将 Terrarium 编码的 RGB 像素值解码为海拔高程（米）。
 *
 * Terrarium 公式：
 *   height = (R × 256 + G + B / 256) - 32768
 *
 * R 提供高 8 位（粗精度 256m），G 提供中间 8 位（1m 精度），
 * B 提供低 8 位（约 0.004m 精度）。
 * 理论范围约 [-32768, +32767] 米。
 *
 * @param r - 红色通道值 [0, 255]
 * @param g - 绿色通道值 [0, 255]
 * @param b - 蓝色通道值 [0, 255]
 * @returns 海拔高程（米）
 *
 * @example
 * // 海平面：R=128, G=0, B=0 → 0m
 * decodeTerrariumHeight(128, 0, 0); // 0.0
 */
function decodeTerrariumHeight(r: number, g: number, b: number): number {
  // R×256 给出粗精度（每单位 256m），G 给出 1m 精度，B/256 给出亚米精度
  return (r * 256 + g + b / 256) + TERRARIUM_DEM_BASE;
}

/**
 * 从 RGBA 像素数组中解码整个 DEM 高程网格。
 * 按行优先顺序依次读取像素，根据编码格式调用对应解码函数，
 * 输出与像素数量等长的 Float32Array 高程值数组。
 *
 * @param imageData - RGBA 像素数据，长度 = width × height × 4
 * @param width - 图像宽度（像素）
 * @param height - 图像高度（像素）
 * @param encoding - DEM 编码格式
 * @returns Float32Array 高程网格，行优先，大小 = width × height
 *
 * @example
 * const rgba = new Uint8Array([1,134,160,255, ...]); // Mapbox 编码
 * const heights = decodeDEMImage(rgba, 256, 256, 'mapbox');
 * console.log(heights[0]); // ≈ 0.0（海平面）
 */
function decodeDEMImage(
  imageData: Uint8Array,
  width: number,
  height: number,
  encoding: 'mapbox' | 'terrarium',
): Float32Array {
  // 像素总数
  const pixelCount = width * height;

  // 分配输出数组
  const elevations = new Float32Array(pixelCount);

  // 选择解码函数——避免在循环内做分支判断以获得更好的性能
  const isMapbox = encoding === 'mapbox';

  // 遍历所有像素，每 4 字节（RGBA）解码一个高程值
  for (let i = 0; i < pixelCount; i++) {
    // 每个像素在 imageData 中占 4 字节（R, G, B, A）
    const offset = i * RGBA_BYTES_PER_PIXEL;

    // 提取 RGB 通道（忽略 A 通道）
    const r = imageData[offset];
    const g = imageData[offset + 1];
    const b = imageData[offset + 2];

    // 根据编码格式解码高程
    if (isMapbox) {
      elevations[i] = decodeMapboxHeight(r, g, b);
    } else {
      elevations[i] = decodeTerrariumHeight(r, g, b);
    }
  }

  return elevations;
}

// ---------------------------------------------------------------------------
// 双线性插值
// ---------------------------------------------------------------------------

/**
 * 在规则网格上执行双线性插值。
 * 给定归一化坐标 (u, v) ∈ [0, 1]²，从 (resolution+1)×(resolution+1)
 * 的高程网格中采样连续高程值。
 *
 * 双线性插值公式：
 *   f(u,v) = f00×(1-fu)×(1-fv) + f10×fu×(1-fv) + f01×(1-fu)×fv + f11×fu×fv
 * 其中 fu/fv 为网格单元内的局部小数坐标。
 *
 * @param grid - 行优先高程网格，大小 = (gridSize) × (gridSize)
 * @param gridSize - 网格边长（= resolution + 1）
 * @param u - 水平归一化坐标 [0, 1]，0=西/左，1=东/右
 * @param v - 垂直归一化坐标 [0, 1]，0=北/上，1=南/下
 * @returns 插值后的高程值
 *
 * @example
 * const grid = new Float32Array([0, 10, 20, 30]); // 2×2 网格
 * bilinearSample(grid, 2, 0.5, 0.5); // 15.0（四点平均）
 */
function bilinearSample(
  grid: Float32Array,
  gridSize: number,
  u: number,
  v: number,
): number {
  // 将 [0,1] 归一化坐标映射到网格索引空间 [0, gridSize-1]
  const maxIdx = gridSize - 1;
  const gx = u * maxIdx;
  const gy = v * maxIdx;

  // 取左上角网格索引（floor），并 clamp 到有效范围
  const ix = Math.min(Math.floor(gx), maxIdx - 1);
  const iy = Math.min(Math.floor(gy), maxIdx - 1);

  // 防止负数索引（当 u=0 或 v=0 时 floor 可能为 -0，此处确保非负）
  const safeIx = Math.max(0, ix);
  const safeIy = Math.max(0, iy);

  // 计算网格单元内的局部小数坐标 [0, 1]
  const fx = gx - safeIx;
  const fy = gy - safeIy;

  // 取四个角点的高程值（左上 f00、右上 f10、左下 f01、右下 f11）
  const f00 = grid[safeIy * gridSize + safeIx];
  const f10 = grid[safeIy * gridSize + safeIx + 1];
  const f01 = grid[(safeIy + 1) * gridSize + safeIx];
  const f11 = grid[(safeIy + 1) * gridSize + safeIx + 1];

  // 检查四个采样值是否有效（NaN/Infinity 保护）
  if (!Number.isFinite(f00) || !Number.isFinite(f10) ||
      !Number.isFinite(f01) || !Number.isFinite(f11)) {
    // 退化情况：返回四个值中第一个有限值，或 0
    if (Number.isFinite(f00)) return f00;
    if (Number.isFinite(f10)) return f10;
    if (Number.isFinite(f01)) return f01;
    if (Number.isFinite(f11)) return f11;
    return 0;
  }

  // 双线性插值公式
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  return f00 * w00 + f10 * w10 + f01 * w01 + f11 * w11;
}

// ---------------------------------------------------------------------------
// 地形网格生成
// ---------------------------------------------------------------------------

/**
 * 从 DEM 数据构建完整的地形三角网格，包括：
 * 1. 顶点位置（经纬度→投影坐标 + 高程）
 * 2. 法线向量（中心差分法计算）
 * 3. UV 纹理坐标
 * 4. 三角形索引（两个三角形组成一个四边形）
 * 5. 裙边三角条带（沿四边向下延伸遮挡缝隙）
 *
 * 此函数为纯函数（无副作用），可安全运行在 Worker 线程中。
 *
 * @param params - 网格构建参数
 * @returns 网格构建结果，含顶点、索引、高程数据和 transferable 缓冲区
 *
 * @example
 * const result = buildTerrainMesh({
 *   imageData: demPixels,
 *   imageWidth: 256,
 *   imageHeight: 256,
 *   encoding: 'mapbox',
 *   resolution: 32,
 *   exaggeration: 1.5,
 *   skirtHeight: 100,
 *   extent: { west: 116, south: 39, east: 117, north: 40 },
 *   parentDEM: null,
 * });
 */
function buildTerrainMesh(params: TerrainMeshBuildParams): TerrainMeshResult {
  const {
    imageData,
    imageWidth,
    imageHeight,
    encoding,
    resolution,
    exaggeration,
    skirtHeight,
    extent,
    parentDEM,
  } = params;

  // ── 1. 解码 DEM 图像为高程网格 ──
  const rawElevations = decodeDEMImage(imageData, imageWidth, imageHeight, encoding);

  // ── 2. 将 DEM 像素重采样到目标网格分辨率 ──
  // 网格边长顶点数 = resolution + 1（如 32 段 = 33 个顶点）
  const gridSize = resolution + 1;
  const gridVertexCount = gridSize * gridSize;

  // 重采样后的高程网格（用于 CPU 高程查询，不含夸张系数）
  const elevationGrid = new Float32Array(gridVertexCount);

  // 遍历网格顶点，通过双线性插值从 DEM 图像采样高程
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      // 将网格坐标映射到 DEM 图像坐标（归一化 [0,1] → 像素坐标）
      const u = gx / resolution;
      const v = gy / resolution;

      // 从 DEM 图像网格进行双线性采样
      elevationGrid[gy * gridSize + gx] = bilinearSample(
        rawElevations,
        imageWidth,
        u,
        v,
      );
    }
  }

  // ── 3. 计算高程范围（用于裙边和视锥剔除） ──
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let i = 0; i < gridVertexCount; i++) {
    const h = elevationGrid[i];
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }

  // 边界保护：所有高程相同或数据为空时设为零
  if (!Number.isFinite(minHeight)) minHeight = 0;
  if (!Number.isFinite(maxHeight)) maxHeight = 0;

  // ── 4. 计算法线向量（中心差分法） ──
  // 法线数组：每个网格顶点 3 个分量 (nx, ny, nz)
  const normalData = new Float32Array(gridVertexCount * 3);

  // 地理范围的东西/南北跨度（度），用于将网格间距转换为近似米
  const extentWidth = extent.east - extent.west;
  const extentHeight = extent.north - extent.south;

  // 网格单元在经纬度空间的大小
  const cellLng = extentWidth / resolution;
  const cellLat = extentHeight / resolution;

  // 将经度差转换为近似米（赤道附近 1° ≈ 111320m，随纬度变化）
  // 取瓦片中心纬度来估算纬度余弦因子
  const centerLat = (extent.south + extent.north) * 0.5;
  const cosLat = Math.cos(centerLat * Math.PI / 180);

  // 每经度度对应米数（粗略近似，仅用于法线计算）
  const metersPerDegreeLng = 111320 * cosLat;
  // 每纬度度对应米数（近似常数）
  const metersPerDegreeLat = 110540;

  // 网格单元在米空间的大小（用于中心差分的步长）
  const cellDx = cellLng * metersPerDegreeLng;
  const cellDy = cellLat * metersPerDegreeLat;

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      // 中心差分法：取当前点的左右/上下邻居的高程差
      // 边界处使用前向/后向差分代替中心差分
      const leftIdx = gy * gridSize + Math.max(0, gx - 1);
      const rightIdx = gy * gridSize + Math.min(gridSize - 1, gx + 1);
      const topIdx = Math.max(0, gy - 1) * gridSize + gx;
      const bottomIdx = Math.min(gridSize - 1, gy + 1) * gridSize + gx;

      // 高程差（乘以夸张系数）
      const dhdx = (elevationGrid[rightIdx] - elevationGrid[leftIdx]) * exaggeration;
      const dhdy = (elevationGrid[bottomIdx] - elevationGrid[topIdx]) * exaggeration;

      // 差分步长：非边界用 2 倍单元格，边界用 1 倍
      const stepsX = (gx > 0 && gx < gridSize - 1) ? 2 : 1;
      const stepsY = (gy > 0 && gy < gridSize - 1) ? 2 : 1;

      // 法线 = normalize(cross(tangentX, tangentY))
      // tangentX = (stepDx, 0, dhdx/stepsX)
      // tangentY = (0, stepDy, dhdy/stepsY)
      // cross = (-dhdx/stepsX * stepDy, -dhdy/stepsY * stepDx, stepDx * stepDy)
      const dzx = dhdx / stepsX;
      const dzy = dhdy / stepsY;

      // 简化法线计算：假设平面上 x 方向为经度、y 方向为纬度
      // 法线 = normalize(-dzx/cellDx, -dzy/cellDy, 1) 的近似
      // 更精确版本使用叉积
      const nx = -dzx / cellDx;
      const ny = -dzy / cellDy;
      const nz = 1.0;

      // 归一化
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const invLen = len > 0 ? 1.0 / len : 1.0;

      const nIdx = (gy * gridSize + gx) * 3;
      normalData[nIdx] = nx * invLen;
      normalData[nIdx + 1] = ny * invLen;
      normalData[nIdx + 2] = nz * invLen;
    }
  }

  // ── 5. 从父级 DEM 采样 Morphing 高程 ──
  let parentHeights: Float32Array | null = null;

  if (parentDEM !== null) {
    // 父级 DEM 的网格大小假定与当前相同（简化处理）
    parentHeights = new Float32Array(gridVertexCount);
    const parentGridSize = Math.round(Math.sqrt(parentDEM.length));

    // 当前瓦片在父级瓦片中的 UV 偏移由瓦片坐标决定
    // 简化版：直接对父级 DEM 做双线性插值采样
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const u = gx / resolution;
        const v = gy / resolution;
        parentHeights[gy * gridSize + gx] = bilinearSample(
          parentDEM,
          parentGridSize > 0 ? parentGridSize : 1,
          u,
          v,
        );
      }
    }
  }

  // ── 6. 计算裙边顶点和索引数量 ──
  // 裙边沿四边（上、右、下、左），每边 resolution 段
  // 每边需要 (resolution + 1) 个额外顶点（下方对偶顶点）
  // 实际每边额外顶点 = resolution + 1（顶点已存在，只需底部对偶顶点）
  const skirtVerticesPerEdge = gridSize;
  const totalSkirtVertices = skirtVerticesPerEdge * SKIRT_EDGE_COUNT;
  // 每边 resolution 个四边形 = resolution × 2 三角形 = resolution × 6 索引
  const skirtIndicesPerEdge = resolution * SKIRT_INDICES_PER_SEGMENT;
  const totalSkirtIndices = skirtIndicesPerEdge * SKIRT_EDGE_COUNT;

  // ── 7. 分配顶点和索引缓冲区 ──
  // 网格体三角形：resolution × resolution 个四边形 = × 2 三角形 = × 6 索引
  const bodyIndexCount = resolution * resolution * INDICES_PER_TRIANGLE * 2;
  const totalVertexCount = gridVertexCount + totalSkirtVertices;
  const totalIndexCount = bodyIndexCount + totalSkirtIndices;

  // 交错顶点布局：[px, py, pz, nx, ny, nz, u, v] × vertexCount
  const vertices = new Float32Array(totalVertexCount * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(totalIndexCount);

  // ── 8. 填充网格体顶点 ──
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const vertexIdx = gy * gridSize + gx;
      const vOffset = vertexIdx * FLOATS_PER_VERTEX;

      // UV 坐标（归一化 [0,1]）
      const u = gx / resolution;
      const v = gy / resolution;

      // 地理坐标（经纬度）
      const lng = extent.west + u * extentWidth;
      // 注意：v=0 对应 north（上方），v=1 对应 south（下方）
      const lat = extent.north - v * extentHeight;

      // 高程值（乘以夸张系数）
      const elevation = elevationGrid[vertexIdx] * exaggeration;

      // 位置：使用经纬度作为 x/y，高程作为 z
      // 实际 GPU 管线中会在 Shader 内做投影变换，此处存储地理坐标
      vertices[vOffset] = lng;
      vertices[vOffset + 1] = lat;
      vertices[vOffset + 2] = elevation;

      // 法线
      const nIdx = vertexIdx * 3;
      vertices[vOffset + 3] = normalData[nIdx];
      vertices[vOffset + 4] = normalData[nIdx + 1];
      vertices[vOffset + 5] = normalData[nIdx + 2];

      // UV
      vertices[vOffset + 6] = u;
      vertices[vOffset + 7] = v;
    }
  }

  // ── 9. 填充网格体三角形索引 ──
  // 每个四边形由两个三角形组成（逆时针绕序）
  let idxPtr = 0;

  for (let gy = 0; gy < resolution; gy++) {
    for (let gx = 0; gx < resolution; gx++) {
      // 四边形四个角的顶点索引
      const topLeft = gy * gridSize + gx;
      const topRight = topLeft + 1;
      const bottomLeft = (gy + 1) * gridSize + gx;
      const bottomRight = bottomLeft + 1;

      // 三角形 1：左上 → 左下 → 右下（逆时针）
      indices[idxPtr++] = topLeft;
      indices[idxPtr++] = bottomLeft;
      indices[idxPtr++] = bottomRight;

      // 三角形 2：左上 → 右下 → 右上（逆时针）
      indices[idxPtr++] = topLeft;
      indices[idxPtr++] = bottomRight;
      indices[idxPtr++] = topRight;
    }
  }

  // ── 10. 生成裙边顶点和索引 ──
  // 裙边顶点从 gridVertexCount 开始编号
  let skirtVertexBase = gridVertexCount;

  /**
   * 为一条边生成裙边。
   * 裙边是在现有边缘顶点正下方创建对偶顶点（z 降低 skirtHeight），
   * 然后用两个三角形连接原顶点和对偶顶点形成围裙。
   *
   * @param edgeIndices - 沿该边的顶点索引数组（按顺序）
   */
  function generateSkirtForEdge(edgeIndices: number[]): void {
    // 为每个边缘顶点创建对偶裙边顶点
    for (let i = 0; i < edgeIndices.length; i++) {
      const srcIdx = edgeIndices[i];
      const srcOffset = srcIdx * FLOATS_PER_VERTEX;
      const dstOffset = skirtVertexBase * FLOATS_PER_VERTEX;

      // 复制原顶点的所有属性
      vertices[dstOffset] = vertices[srcOffset];         // x (lng)
      vertices[dstOffset + 1] = vertices[srcOffset + 1]; // y (lat)
      // z 坐标下移 skirtHeight（裙边底部）
      vertices[dstOffset + 2] = vertices[srcOffset + 2] - skirtHeight;
      // 法线指向水平外侧——简化处理使用原顶点法线
      vertices[dstOffset + 3] = vertices[srcOffset + 3]; // nx
      vertices[dstOffset + 4] = vertices[srcOffset + 4]; // ny
      vertices[dstOffset + 5] = vertices[srcOffset + 5]; // nz
      // UV 与原顶点相同
      vertices[dstOffset + 6] = vertices[srcOffset + 6]; // u
      vertices[dstOffset + 7] = vertices[srcOffset + 7]; // v

      skirtVertexBase++;
    }

    // 裙边对偶顶点起始索引
    const dualBase = skirtVertexBase - edgeIndices.length;

    // 为每对相邻边缘顶点生成两个三角形
    for (let i = 0; i < edgeIndices.length - 1; i++) {
      const a = edgeIndices[i];       // 上方左
      const b = edgeIndices[i + 1];   // 上方右
      const c = dualBase + i;         // 下方左
      const d = dualBase + i + 1;     // 下方右

      // 三角形 1：上左 → 下左 → 下右
      indices[idxPtr++] = a;
      indices[idxPtr++] = c;
      indices[idxPtr++] = d;

      // 三角形 2：上左 → 下右 → 上右
      indices[idxPtr++] = a;
      indices[idxPtr++] = d;
      indices[idxPtr++] = b;
    }
  }

  // 上边（y=0, gx 从左到右）
  const topEdge: number[] = [];
  for (let gx = 0; gx < gridSize; gx++) {
    topEdge.push(gx);
  }
  generateSkirtForEdge(topEdge);

  // 右边（gx=resolution, gy 从上到下）
  const rightEdge: number[] = [];
  for (let gy = 0; gy < gridSize; gy++) {
    rightEdge.push(gy * gridSize + resolution);
  }
  generateSkirtForEdge(rightEdge);

  // 下边（gy=resolution, gx 从右到左——保持逆时针绕序）
  const bottomEdge: number[] = [];
  for (let gx = gridSize - 1; gx >= 0; gx--) {
    bottomEdge.push(resolution * gridSize + gx);
  }
  generateSkirtForEdge(bottomEdge);

  // 左边（gx=0, gy 从下到上——保持逆时针绕序）
  const leftEdge: number[] = [];
  for (let gy = gridSize - 1; gy >= 0; gy--) {
    leftEdge.push(gy * gridSize);
  }
  generateSkirtForEdge(leftEdge);

  // ── 11. 组装结果 ──
  const heightRangeResult: [number, number] = [
    minHeight * exaggeration,
    maxHeight * exaggeration,
  ];

  // 收集可转移的 ArrayBuffer（零拷贝传输到主线程）
  const transferables: ArrayBuffer[] = [
    vertices.buffer,
    indices.buffer,
    elevationGrid.buffer,
    normalData.buffer,
  ];

  // 如果有 parentHeights，也加入 transferables
  if (parentHeights !== null) {
    transferables.push(parentHeights.buffer as ArrayBuffer);
  }

  return {
    vertices,
    indices,
    heightRange: heightRangeResult,
    elevationData: elevationGrid,
    normalData,
    parentHeights,
    transferables,
  };
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 TerrainLayerOptions。
 * 对必填字段做空检查，对可选数值字段做范围、类型和约束校验。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项（带默认值）
 * @throws Error 若任何校验失败
 *
 * @example
 * const cfg = validateTerrainOptions({
 *   id: 'terrain',
 *   source: 'mapbox-terrain-dem',
 * });
 */
function validateTerrainOptions(opts: TerrainLayerOptions): {
  id: string;
  source: string;
  exaggeration: number;
  meshResolution: number;
  encoding: 'mapbox' | 'terrarium';
  skirtHeight: number | 'auto';
  enableMorphing: boolean;
  morphRange: number;
  enableLighting: boolean;
  minzoom: number;
  maxzoom: number;
  opacity: number;
  projection: string;
  paint: Record<string, unknown> | undefined;
  layout: Record<string, unknown> | undefined;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] TerrainLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] TerrainLayerOptions.source must be a non-empty string`,
    );
  }

  // 夸张系数校验
  const exaggeration = opts.exaggeration ?? DEFAULT_EXAGGERATION;
  if (!Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > MAX_EXAGGERATION) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_EXAGGERATION}] exaggeration must be in [0, ${MAX_EXAGGERATION}], got ${exaggeration}`,
    );
  }

  // 网格分辨率校验
  const meshResolution = opts.meshResolution ?? DEFAULT_MESH_RESOLUTION;
  if (
    !Number.isFinite(meshResolution) ||
    meshResolution < MIN_MESH_RESOLUTION ||
    meshResolution > MAX_MESH_RESOLUTION ||
    !isPowerOfTwo(meshResolution)
  ) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_MESH_RESOLUTION}] meshResolution must be a power of 2 in ` +
        `[${MIN_MESH_RESOLUTION}, ${MAX_MESH_RESOLUTION}], got ${meshResolution}`,
    );
  }

  // 编码格式校验
  const encoding = opts.encoding ?? DEFAULT_ENCODING;
  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_ENCODING}] encoding must be one of ` +
        `${Array.from(SUPPORTED_ENCODINGS).join(', ')}, got '${encoding}'`,
    );
  }

  // 裙边高度校验
  const skirtHeight = opts.skirtHeight ?? 'auto';
  if (skirtHeight !== 'auto') {
    if (!Number.isFinite(skirtHeight) || skirtHeight < 0) {
      throw new Error(
        `[${TERRAIN_ERROR_CODES.INVALID_SKIRT_HEIGHT}] skirtHeight must be 'auto' or a non-negative number, got ${skirtHeight}`,
      );
    }
  }

  // Morphing 开关
  const enableMorphing = opts.enableMorphing ?? true;

  // Morph 范围校验
  const morphRange = opts.morphRange ?? DEFAULT_MORPH_RANGE;
  if (!Number.isFinite(morphRange) || morphRange <= 0 || morphRange >= 1) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_MORPH_RANGE}] morphRange must be in (0, 1), got ${morphRange}`,
    );
  }

  // 光照开关
  const enableLighting = opts.enableLighting ?? true;

  // minzoom 校验
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  // maxzoom 校验
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // opacity 校验
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    exaggeration,
    meshResolution,
    encoding: encoding as 'mapbox' | 'terrarium',
    skirtHeight,
    enableMorphing,
    morphRange,
    enableLighting,
    minzoom,
    maxzoom,
    opacity,
    projection,
    paint: opts.paint,
    layout: opts.layout,
  };
}

// ---------------------------------------------------------------------------
// 经纬度→瓦片坐标辅助
// ---------------------------------------------------------------------------

/**
 * 根据经纬度和缩放级别计算对应的瓦片坐标。
 * 使用 Web Mercator 瓦片编号公式：
 *   x = floor((lng + 180) / 360 × 2^z)
 *   y = floor((1 - ln(tan(lat_rad) + 1/cos(lat_rad)) / π) / 2 × 2^z)
 *
 * @param lon - 经度（度），范围 [-180, 180]
 * @param lat - 纬度（度），范围 [-85.051, 85.051]（Web Mercator 极限）
 * @param zoom - 缩放级别（取整数部分）
 * @returns 瓦片坐标
 *
 * @example
 * lngLatToTileCoord(116.39, 39.91, 14); // { x: 13523, y: 6176, z: 14 }
 */
function lngLatToTileCoord(lon: number, lat: number, zoom: number): TileCoord {
  // 取整数缩放级别
  const z = Math.floor(zoom);

  // 2^z 表示该级别下每个维度的瓦片数
  const tileCount = Math.pow(2, z);

  // 经度映射到 [0, 1] 范围
  const lngNorm = (lon + 180) / 360;

  // 纬度映射到 [0, 1] 范围（Web Mercator 投影）
  const latRad = lat * Math.PI / 180;
  // clamp 纬度避免 tan 溢出（Web Mercator 在极地无法表示）
  const clampedLatRad = Math.max(Math.min(latRad, Math.PI * 85.051 / 180), -Math.PI * 85.051 / 180);
  const latNorm = (1 - Math.log(Math.tan(clampedLatRad) + 1 / Math.cos(clampedLatRad)) / Math.PI) / 2;

  // 映射到瓦片索引并 clamp 到有效范围
  const x = Math.max(0, Math.min(tileCount - 1, Math.floor(lngNorm * tileCount)));
  const y = Math.max(0, Math.min(tileCount - 1, Math.floor(latNorm * tileCount)));

  return { x, y, z };
}

/**
 * 计算指定瓦片坐标覆盖的地理范围（经纬度包围盒）。
 * 使用 Web Mercator 瓦片 → 经纬度反算公式。
 *
 * @param coord - 瓦片坐标
 * @returns 瓦片覆盖的地理范围
 *
 * @example
 * tileCoordToExtent({ x: 0, y: 0, z: 1 });
 * // { west: -180, south: 0, east: 0, north: 85.051 }
 */
function tileCoordToExtent(coord: TileCoord): BBox2D {
  const tileCount = Math.pow(2, coord.z);

  // 经度范围
  const west = coord.x / tileCount * 360 - 180;
  const east = (coord.x + 1) / tileCount * 360 - 180;

  // 纬度范围（Web Mercator 反算）
  const n1 = Math.PI - 2 * Math.PI * coord.y / tileCount;
  const n2 = Math.PI - 2 * Math.PI * (coord.y + 1) / tileCount;
  const north = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n1) - Math.exp(-n1)));
  const south = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));

  return { west, south, east, north };
}

// ---------------------------------------------------------------------------
// createTerrainLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建地形图层实例。
 * 返回完整的 {@link TerrainLayer} 实现，包含 DEM 解码、网格生成、
 * 高程查询、Morphing 过渡和 LOD 边缘约束逻辑。
 *
 * GPU 渲染管线（encode）在 MVP 阶段为桩实现——
 * 完整管线需要 L2/ShaderAssembler + PipelineCache + FrameGraphBuilder 协同，
 * 将在后续 Sprint 接入。
 *
 * @param opts - 地形图层构造选项
 * @returns 完整的 TerrainLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const terrainLayer = createTerrainLayer({
 *   id: 'terrain',
 *   source: 'mapbox-terrain-dem',
 *   exaggeration: 1.5,
 *   meshResolution: 64,
 *   encoding: 'mapbox',
 *   enableMorphing: true,
 *   enableLighting: true,
 * });
 * sceneGraph.addLayer(terrainLayer);
 *
 * // 异步高程查询
 * const elevation = await terrainLayer.getElevation(116.39, 39.91);
 */
export function createTerrainLayer(opts: TerrainLayerOptions): TerrainLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateTerrainOptions(opts);

  // ── 2. 内部可变状态 ──

  // 当前夸张系数（运行时可通过 setExaggeration 修改）
  let currentExaggeration = cfg.exaggeration;

  // 当前网格分辨率（运行时可通过 setMeshResolution 修改）
  let currentMeshResolution = cfg.meshResolution;

  // 已加载瓦片的渲染数据（key = "z/x/y"）
  const loadedTiles = new Map<string, TerrainTileRenderData>();

  // CPU 高程缓存（key = "z/x/y"，用于 getElevation/getElevationSync）
  const elevationCache = new Map<string, ElevationCacheEntry>();

  // 当前帧可见瓦片的 key 集合（每帧 onUpdate 重建）
  const visibleSet = new Set<string>();

  // paint 属性缓存
  const paintProps = new Map<string, unknown>();

  // layout 属性缓存
  const layoutProps = new Map<string, unknown>();

  // 要素状态表（地形图层不使用，但 Layer 接口要求）
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化 paint 属性缓存
  if (cfg.paint) {
    for (const k of Object.keys(cfg.paint)) {
      paintProps.set(k, cfg.paint[k]);
    }
  }

  // 初始化 layout 属性缓存
  if (cfg.layout) {
    for (const k of Object.keys(cfg.layout)) {
      layoutProps.set(k, cfg.layout[k]);
    }
  }

  // 图层是否已挂载到场景
  let mounted = false;

  // 图层上下文引用（onAdd 时注入）
  let layerContext: LayerContext | null = null;

  // 数据是否就绪标记（至少有一个瓦片加载完成后为 true）
  let dataReady = false;

  // 当前帧的全局 morph 因子（由 onUpdate 根据缩放小数部分计算）
  let currentMorphFactor = 0;

  // 待解决的高程查询 Promise（用于 getElevation 的 await 逻辑）
  const pendingElevationQueries = new Map<string, Array<{
    resolve: (value: number) => void;
    reject: (reason: Error) => void;
    lon: number;
    lat: number;
    timeoutId: ReturnType<typeof setTimeout>;
  }>>();

  // ── 3. 内部辅助函数 ──

  /**
   * 校验经纬度坐标是否在有效范围内。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @returns true 若坐标合法
   */
  function isValidCoordinate(lon: number, lat: number): boolean {
    return (
      Number.isFinite(lon) && Number.isFinite(lat) &&
      lon >= LNG_MIN && lon <= LNG_MAX &&
      lat >= LAT_MIN && lat <= LAT_MAX
    );
  }

  /**
   * 在已加载的高程缓存中查找包含指定经纬度的瓦片，并执行双线性插值。
   * 优先选择缩放级别最高（最精细）的瓦片。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @returns 高程值（已乘夸张系数），或 null（无缓存命中）
   */
  function sampleElevationFromCache(lon: number, lat: number): number | null {
    let bestEntry: ElevationCacheEntry | null = null;
    let bestZoom = -1;

    // 遍历所有缓存条目，找到包含该坐标的最高缩放级别瓦片
    for (const entry of elevationCache.values()) {
      const ext = entry.extent;

      // 检查坐标是否在瓦片范围内
      if (lon >= ext.west && lon <= ext.east && lat >= ext.south && lat <= ext.north) {
        // 从 extent 反推缩放级别（通过经度跨度估算）
        const lngSpan = ext.east - ext.west;
        // 在 Web Mercator 中，z 级别的经度跨度 ≈ 360 / 2^z
        const estimatedZoom = lngSpan > 0 ? Math.round(Math.log2(360 / lngSpan)) : 0;
        if (estimatedZoom > bestZoom) {
          bestZoom = estimatedZoom;
          bestEntry = entry;
        }
      }
    }

    // 未找到覆盖该坐标的缓存瓦片
    if (bestEntry === null) {
      return null;
    }

    // 将经纬度映射到瓦片内 [0,1] 归一化坐标
    const ext = bestEntry.extent;
    const extWidth = ext.east - ext.west;
    const extHeight = ext.north - ext.south;

    // 防止零除（退化瓦片范围）
    if (extWidth <= 0 || extHeight <= 0) {
      return null;
    }

    // u: 经度方向归一化 [0,1]
    const u = (lon - ext.west) / extWidth;
    // v: 纬度方向归一化 [0,1]，north 对应 v=0，south 对应 v=1
    const v = (ext.north - lat) / extHeight;

    // clamp 到 [0,1] 防止浮点误差越界
    const cu = Math.max(0, Math.min(1, u));
    const cv = Math.max(0, Math.min(1, v));

    // 双线性插值采样
    const gridSize = bestEntry.resolution + 1;
    const rawHeight = bilinearSample(bestEntry.heights, gridSize, cu, cv);

    // 乘以当前夸张系数返回
    return rawHeight * currentExaggeration;
  }

  /**
   * 尝试解决指定瓦片键的所有待处理高程查询。
   * 当新瓦片数据注入到高程缓存时调用。
   *
   * @param tileKeyStr - 瓦片键
   */
  function resolvePendingQueries(tileKeyStr: string): void {
    const queries = pendingElevationQueries.get(tileKeyStr);
    if (queries === undefined || queries.length === 0) {
      return;
    }

    // 逐个解决待处理的查询
    const resolvedQueries: typeof queries = [];
    for (const query of queries) {
      const elevation = sampleElevationFromCache(query.lon, query.lat);
      if (elevation !== null) {
        // 清除超时定时器
        clearTimeout(query.timeoutId);
        query.resolve(elevation);
        resolvedQueries.push(query);
      }
    }

    // 移除已解决的查询
    if (resolvedQueries.length === queries.length) {
      pendingElevationQueries.delete(tileKeyStr);
    } else {
      // 保留未解决的查询（可能需要更精细的瓦片）
      const remaining = queries.filter((q) => !resolvedQueries.includes(q));
      pendingElevationQueries.set(tileKeyStr, remaining);
    }
  }

  /**
   * 解析 skirtHeight 配置。
   * 'auto' 模式根据高程范围动态计算，数值模式直接使用。
   *
   * @param heightRange - 瓦片高程范围 [min, max]
   * @returns 实际裙边高度（米）
   */
  function resolveSkirtHeight(heightRange: [number, number]): number {
    if (cfg.skirtHeight === 'auto') {
      // 自动模式：裙边高度 = 高程差 × 系数，最小保底 10 米防止零高差时无裙边
      const elevationRange = Math.abs(heightRange[1] - heightRange[0]);
      return Math.max(10, elevationRange * SKIRT_HEIGHT_FACTOR);
    }
    return cfg.skirtHeight;
  }

  // ── 4. 构造 Layer 实现对象 ──
  const layer: TerrainLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'terrain' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（至少一个 DEM 瓦片完成解码）。
     * @returns true 表示有可查询/渲染的高程数据
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 是否包含半透明内容。
     * 地形图层在不透明度 < 1 时为半透明。
     * @returns true 表示需要参与透明排序
     */
    get isTransparent(): boolean {
      return layer.opacity < OPACITY_MAX;
    },

    /**
     * 全局渲染次序。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前高程夸张系数。
     * @returns 夸张系数值
     */
    get exaggeration(): number {
      return currentExaggeration;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载时由 LayerManager 调用。
     * 保存引擎上下文引用，后续用于 Worker 任务提交和 GPU 资源创建。
     *
     * @param context - 引擎注入的上下文
     *
     * @example
     * // LayerManager 内部调用
     * terrainLayer.onAdd(engineContext);
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;

      if (__DEV__) {
        console.debug(
          `[TerrainLayer:${cfg.id}] onAdd: exaggeration=${currentExaggeration}, ` +
            `resolution=${currentMeshResolution}, encoding=${cfg.encoding}, ` +
            `morphing=${cfg.enableMorphing}, lighting=${cfg.enableLighting}`,
        );
      }
    },

    /**
     * 图层卸载时由 LayerManager 调用。
     * 释放所有瓦片数据、高程缓存，取消未完成的高程查询。
     *
     * @example
     * terrainLayer.onRemove();
     */
    onRemove(): void {
      // 清空所有瓦片渲染数据
      loadedTiles.clear();

      // 清空高程缓存
      elevationCache.clear();

      // 清空可见集合
      visibleSet.clear();

      // 清空属性和状态缓存
      featureStateMap.clear();

      // 拒绝所有未完成的高程查询
      for (const queries of pendingElevationQueries.values()) {
        for (const query of queries) {
          clearTimeout(query.timeoutId);
          query.reject(new Error(
            `[${TERRAIN_ERROR_CODES.INVALID_OPTIONS}] TerrainLayer removed while elevation query pending`,
          ));
        }
      }
      pendingElevationQueries.clear();

      // 重置标志
      mounted = false;
      layerContext = null;
      dataReady = false;
      currentMorphFactor = 0;

      if (__DEV__) {
        console.debug(`[TerrainLayer:${cfg.id}] onRemove: all resources released`);
      }
    },

    /**
     * 每帧更新——计算 Morph 因子、判断缩放可见性、更新可见瓦片集合。
     * 由 FrameScheduler 在 UPDATE 阶段调用。
     *
     * @param deltaTime - 距上一帧的时间（秒）
     * @param camera - 当前相机快照
     *
     * @example
     * // FrameScheduler 内部调用
     * terrainLayer.onUpdate(0.016, cameraState);
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // ── 缩放级别可见性判断 ──
      const zoom = camera.zoom;
      if (zoom < cfg.minzoom || zoom > cfg.maxzoom) {
        visibleSet.clear();
        currentMorphFactor = 0;
        return;
      }

      // ── 计算全局 Morph 因子 ──
      if (cfg.enableMorphing) {
        // 缩放级别的小数部分
        const zoomFraction = zoom - Math.floor(zoom);

        // 当 zoomFraction 进入 [1 - morphRange, 1] 区间时启动过渡
        // morphFactor 在此区间从 0 线性增长到 1
        const morphStart = 1 - cfg.morphRange;
        if (zoomFraction >= morphStart) {
          // 映射 [morphStart, 1] → [0, 1]
          currentMorphFactor = (zoomFraction - morphStart) / cfg.morphRange;
        } else {
          currentMorphFactor = 0;
        }
      } else {
        currentMorphFactor = 0;
      }

      // ── 重建本帧可见瓦片集合 ──
      visibleSet.clear();

      // 更新每个已加载瓦片的 morphFactor
      for (const [key, tileData] of loadedTiles) {
        // 将全局 morph 因子写入每瓦片数据（Shader 可能按瓦片变化）
        tileData.morphFactor = currentMorphFactor;

        // MVP: 所有已加载瓦片均标记为可见
        // 完整实现需要视锥体剔除（Camera frustum vs tile extent + height AABB）
        visibleSet.add(key);
      }
    },

    /**
     * 将地形网格绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现——完整管线需要 ShaderAssembler + PipelineCache。
     *
     * 完整实现的渲染流程：
     * 1. setPipeline(terrainPipeline) — 带高程顶点着色器和光照片段着色器
     * 2. 遍历 visibleSet 中每个瓦片：
     *    a. setBindGroup(0, globalUniforms) — VP 矩阵、光照参数
     *    b. setBindGroup(1, tileUniforms) — 瓦片 extent、morphFactor、exaggeration
     *    c. setVertexBuffer(0, tileVBO)
     *    d. setIndexBuffer(tileIBO, 'uint32')
     *    e. drawIndexed(triangleCount × 3)
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     *
     * @example
     * // FrameGraphBuilder 内部调用
     * terrainLayer.encode(renderPassEncoder, cameraState);
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        if (visibleSet.size > 0) {
          // 统计总三角形数
          let totalTriangles = 0;
          for (const key of visibleSet) {
            const tile = loadedTiles.get(key);
            if (tile !== undefined) {
              totalTriangles += tile.triangleCount;
            }
          }

          console.debug(
            `[TerrainLayer:${cfg.id}] encode stub: ${visibleSet.size} visible tiles, ` +
              `${totalTriangles} triangles, exaggeration=${currentExaggeration.toFixed(2)}, ` +
              `morphFactor=${currentMorphFactor.toFixed(3)}, ` +
              `lighting=${cfg.enableLighting}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——地形图层不支持要素级拾取。
     * 但可以在拾取 Pass 中写入深度信息，供其它图层做高程感知拾取。
     * MVP 阶段为空实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     *
     * @example
     * terrainLayer.encodePicking(pickPassEncoder, cameraState);
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // 地形无要素 ID，拾取 Pass 中不提交绘制命令
      // 完整实现可在此写入深度以支持高程感知的射线投射
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性值。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     *
     * @example
     * terrainLayer.setPaintProperty('terrain-exaggeration', 2.0);
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);

      // 同步特定属性到内部状态
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (name === 'terrain-exaggeration') {
          // 通过 setPaintProperty 也可以修改夸张系数
          if (value >= 0 && value <= MAX_EXAGGERATION) {
            currentExaggeration = value;
          }
        }
      }
    },

    /**
     * 设置 layout 属性值。
     * 支持 'visibility'（'visible' | 'none'）。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     *
     * @example
     * terrainLayer.setLayoutProperty('visibility', 'none');
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      // 同步 visibility 到 Layer.visible
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性值。
     *
     * @param name - paint 属性名
     * @returns 属性值，或 undefined 若未设置
     *
     * @example
     * const exag = terrainLayer.getPaintProperty('terrain-exaggeration');
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性值。
     *
     * @param name - layout 属性名
     * @returns 属性值，或 undefined 若未设置
     *
     * @example
     * const vis = terrainLayer.getLayoutProperty('visibility');
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 注入瓦片 DEM 解码后的网格数据。
     * 由 TileScheduler → Worker('terrain-mesh') → 主线程回调链注入。
     * 接受 TerrainMeshResult 格式的数据包，解析为 TerrainTileRenderData
     * 和 ElevationCacheEntry 存入内部缓存。
     *
     * @param data - 瓦片数据对象，需包含 coord、vertices、indices 等字段
     *
     * @example
     * terrainLayer.setData({
     *   coord: { x: 215, y: 99, z: 8 },
     *   vertices: vertexArray,
     *   indices: indexArray,
     *   heightRange: [-50, 1200],
     *   elevationData: heightGrid,
     *   normalData: normals,
     *   parentHeights: null,
     *   extent: { west: 112.5, south: 33.43, east: 114.08, north: 34.30 },
     * });
     */
    setData(data: unknown): void {
      // 类型守卫：确保传入对象非空
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 检查 coord 字段合法性
      if (
        record['coord'] === undefined ||
        record['coord'] === null ||
        typeof record['coord'] !== 'object'
      ) {
        return;
      }

      const coord = record['coord'] as TileCoord;

      // 校验坐标字段均为非负整数
      if (
        !Number.isFinite(coord.x) || coord.x < 0 ||
        !Number.isFinite(coord.y) || coord.y < 0 ||
        !Number.isFinite(coord.z) || coord.z < 0
      ) {
        return;
      }

      // 提取三角形数量
      const indicesArr = record['indices'];
      let triangleCount = 0;
      if (indicesArr instanceof Uint32Array) {
        triangleCount = Math.floor(indicesArr.length / INDICES_PER_TRIANGLE);
      } else if (typeof record['triangleCount'] === 'number') {
        triangleCount = record['triangleCount'] as number;
      }

      // 提取高程范围
      let heightRange: [number, number] = [0, 0];
      if (Array.isArray(record['heightRange']) && record['heightRange'].length >= 2) {
        const hr = record['heightRange'] as number[];
        if (Number.isFinite(hr[0]) && Number.isFinite(hr[1])) {
          heightRange = [hr[0], hr[1]];
        }
      }

      // 提取地理范围
      const extent: BBox2D = (record['extent'] as BBox2D) ?? tileCoordToExtent(coord);

      // 提取父级高程数据
      const parentHeightsRaw = record['parentHeights'];
      const parentHeightsVal = parentHeightsRaw instanceof Float32Array ? parentHeightsRaw : null;

      // 创建渲染数据
      const key = tileKey(coord);
      const renderData: TerrainTileRenderData = {
        coord,
        vertexBufferHandle: typeof record['vertexBufferHandle'] === 'number'
          ? record['vertexBufferHandle'] as number : 0,
        indexBufferHandle: typeof record['indexBufferHandle'] === 'number'
          ? record['indexBufferHandle'] as number : 0,
        triangleCount,
        elevationTextureHandle: typeof record['elevationTextureHandle'] === 'number'
          ? record['elevationTextureHandle'] as number : 0,
        normalTextureHandle: typeof record['normalTextureHandle'] === 'number'
          ? record['normalTextureHandle'] as number : 0,
        heightRange,
        extent,
        parentHeights: parentHeightsVal,
        morphFactor: 0,
      };

      // 存入渲染数据缓存
      loadedTiles.set(key, renderData);

      // 提取高程网格数据到 CPU 缓存（用于高程查询）
      const elevationData = record['elevationData'];
      if (elevationData instanceof Float32Array && elevationData.length > 0) {
        // 从数组长度反推网格边长
        const gridSize = Math.round(Math.sqrt(elevationData.length));
        if (gridSize * gridSize === elevationData.length && gridSize >= 2) {
          elevationCache.set(key, {
            heights: elevationData,
            extent,
            resolution: gridSize - 1,
          });
        }
      }

      // 标记数据就绪
      dataReady = true;

      // 尝试解决待处理的高程查询
      resolvePendingQueries(key);

      // 也尝试对所有待处理查询做检查（新瓦片可能覆盖了任意查询点）
      for (const pendingKey of pendingElevationQueries.keys()) {
        if (pendingKey !== key) {
          resolvePendingQueries(pendingKey);
        }
      }
    },

    /**
     * 读取当前瓦片缓存快照（调试用途）。
     *
     * @returns 包含已加载瓦片信息的对象
     *
     * @example
     * const info = terrainLayer.getData();
     * console.log(info); // { loadedTiles: [...], cacheSize: 42 }
     */
    getData(): unknown {
      const tiles: Array<{
        coord: TileCoord;
        triangleCount: number;
        heightRange: [number, number];
      }> = [];
      for (const tile of loadedTiles.values()) {
        tiles.push({
          coord: tile.coord,
          triangleCount: tile.triangleCount,
          heightRange: tile.heightRange,
        });
      }
      return {
        loadedTiles: tiles,
        cacheSize: elevationCache.size,
        exaggeration: currentExaggeration,
        meshResolution: currentMeshResolution,
      };
    },

    // ==================== 要素状态方法（地形图层仅为接口兼容） ====================

    /**
     * 设置要素状态——地形图层无要素概念，但接口要求实现。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     *
     * @example
     * terrainLayer.setFeatureState('peak-1', { highlight: true });
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态对象或 undefined
     *
     * @example
     * const state = terrainLayer.getFeatureState('peak-1');
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 地形特有方法 ====================

    /**
     * 异步查询指定经纬度的高程值。
     * 先尝试从已加载的高程缓存中采样，若缓存未命中则注册等待回调，
     * 直到对应瓦片加载完成或超时。
     *
     * @param lon - 经度（度），范围 [-180, 180]
     * @param lat - 纬度（度），范围 [-90, 90]
     * @returns Promise 解析为高程值（米，已乘夸张系数）
     *
     * @example
     * const h = await terrain.getElevation(116.39, 39.91);
     * console.log(`高程: ${h}m`);
     */
    getElevation(lon: number, lat: number): Promise<number> {
      // 校验坐标有效性
      if (!isValidCoordinate(lon, lat)) {
        return Promise.reject(new Error(
          `[${TERRAIN_ERROR_CODES.INVALID_COORDINATES}] Invalid coordinates: lon=${lon}, lat=${lat}. ` +
            `lon must be in [${LNG_MIN}, ${LNG_MAX}], lat must be in [${LAT_MIN}, ${LAT_MAX}]`,
        ));
      }

      // 首先尝试从已有缓存采样
      const cached = sampleElevationFromCache(lon, lat);
      if (cached !== null) {
        return Promise.resolve(cached);
      }

      // 缓存未命中——创建 Promise 等待瓦片加载
      return new Promise<number>((resolve, reject) => {
        // 计算该坐标对应的瓦片键（使用当前可能的缩放级别范围内最粗级别）
        // 这里使用中间缩放级别作为查询目标
        const queryZoom = Math.min(
          cfg.maxzoom,
          Math.max(cfg.minzoom, Math.floor((cfg.minzoom + cfg.maxzoom) / 2)),
        );
        const tileCoord = lngLatToTileCoord(lon, lat, queryZoom);
        const key = tileKey(tileCoord);

        // 设置超时——超时后拒绝 Promise
        const timeoutId = setTimeout(() => {
          // 从待处理列表中移除
          const queries = pendingElevationQueries.get(key);
          if (queries !== undefined) {
            const idx = queries.findIndex((q) => q.resolve === resolve);
            if (idx >= 0) {
              queries.splice(idx, 1);
            }
            if (queries.length === 0) {
              pendingElevationQueries.delete(key);
            }
          }

          reject(new Error(
            `[${TERRAIN_ERROR_CODES.ELEVATION_QUERY_TIMEOUT}] Elevation query timed out after ` +
              `${ELEVATION_QUERY_TIMEOUT_MS}ms for (${lon}, ${lat})`,
          ));
        }, ELEVATION_QUERY_TIMEOUT_MS);

        // 注册待处理查询
        const queryEntry = { resolve, reject, lon, lat, timeoutId };
        if (pendingElevationQueries.has(key)) {
          pendingElevationQueries.get(key)!.push(queryEntry);
        } else {
          pendingElevationQueries.set(key, [queryEntry]);
        }
      });
    },

    /**
     * 同步查询指定经纬度的高程值。
     * 仅在对应 DEM 瓦片已加载到缓存中时返回数值，否则返回 null。
     * 不会触发网络请求，适用于鼠标移动等高频场景。
     *
     * @param lon - 经度（度），范围 [-180, 180]
     * @param lat - 纬度（度），范围 [-90, 90]
     * @returns 高程值（米，已乘夸张系数），或 null（瓦片未加载或坐标无效）
     *
     * @example
     * const h = terrain.getElevationSync(116.39, 39.91);
     * if (h !== null) overlay.textContent = `${h.toFixed(1)}m`;
     */
    getElevationSync(lon: number, lat: number): number | null {
      // 校验坐标有效性
      if (!isValidCoordinate(lon, lat)) {
        return null;
      }

      // 从缓存采样
      return sampleElevationFromCache(lon, lat);
    },

    /**
     * 批量查询高程剖面线。
     * 沿给定点列在相邻点对之间等距线性插值，对每个采样点异步查询高程。
     * 返回长度等于 sampleCount 的高程数组。
     *
     * @param points - 剖面线控制点 [[lon, lat], ...]，至少 2 个点
     * @param sampleCount - 总采样点数（含起终点），默认等于 points.length
     * @returns 高程值数组（米，已乘夸张系数）
     *
     * @example
     * const profile = await terrain.getElevationProfile(
     *   [[116.0, 39.0], [116.5, 39.5], [117.0, 40.0]],
     *   200,
     * );
     * // profile.length === 200
     */
    async getElevationProfile(
      points: ReadonlyArray<[number, number]>,
      sampleCount?: number,
    ): Promise<number[]> {
      // 点列至少需要 2 个点才能形成剖面线
      if (points.length < 2) {
        return [];
      }

      // 默认采样数等于控制点数
      const count = (sampleCount !== undefined && sampleCount > 0) ? sampleCount : points.length;

      // ── 计算剖面线总长度（球面距离的简化版——使用欧氏距离近似） ──
      // 计算每段的经纬度距离
      const segmentLengths: number[] = [];
      let totalLength = 0;

      for (let i = 0; i < points.length - 1; i++) {
        const [lon1, lat1] = points[i];
        const [lon2, lat2] = points[i + 1];
        // 使用欧氏距离近似（适用于短距离剖面线）
        const dLon = lon2 - lon1;
        const dLat = lat2 - lat1;
        const segLen = Math.sqrt(dLon * dLon + dLat * dLat);
        segmentLengths.push(segLen);
        totalLength += segLen;
      }

      // 退化情况：所有点重合
      if (totalLength <= 0) {
        const elevation = await layer.getElevation(points[0][0], points[0][1]);
        return new Array(count).fill(elevation);
      }

      // ── 生成等距采样点坐标 ──
      const sampledCoords: Array<[number, number]> = [];

      for (let si = 0; si < count; si++) {
        // 当前采样点在总剖面线上的比例位置 [0, 1]
        const t = count > 1 ? si / (count - 1) : 0;
        // 对应的累积距离
        const targetDist = t * totalLength;

        // 找到该距离落在哪一段上
        let accumDist = 0;
        let segIdx = 0;
        while (segIdx < segmentLengths.length - 1 && accumDist + segmentLengths[segIdx] < targetDist) {
          accumDist += segmentLengths[segIdx];
          segIdx++;
        }

        // 段内插值比例
        const segLen = segmentLengths[segIdx];
        const localT = segLen > 0 ? (targetDist - accumDist) / segLen : 0;

        // 线性插值得到经纬度
        const [lon1, lat1] = points[segIdx];
        const [lon2, lat2] = points[segIdx + 1];
        const lon = lon1 + (lon2 - lon1) * localT;
        const lat = lat1 + (lat2 - lat1) * localT;

        sampledCoords.push([lon, lat]);
      }

      // ── 对每个采样点查询高程 ──
      const elevationPromises = sampledCoords.map(([lon, lat]) => {
        // 优先同步查询避免不必要的异步开销
        const syncResult = sampleElevationFromCache(lon, lat);
        if (syncResult !== null) {
          return Promise.resolve(syncResult);
        }
        return layer.getElevation(lon, lat);
      });

      return Promise.all(elevationPromises);
    },

    /**
     * 设置高程夸张系数。
     * 已加载瓦片的网格不会立即重建——新值将影响后续加载的瓦片
     * 和 getElevation 系列方法的返回值。
     *
     * @param value - 夸张系数，范围 [0, 100]
     *
     * @example
     * terrain.setExaggeration(2.0); // 高程放大两倍
     * terrain.setExaggeration(0);   // 完全平坦
     */
    setExaggeration(value: number): void {
      // 非有限值回退为默认值，超范围值 clamp 到 [0, MAX_EXAGGERATION]
      let clamped = Number.isFinite(value) ? value : DEFAULT_EXAGGERATION;
      if (clamped < 0) clamped = 0;
      if (clamped > MAX_EXAGGERATION) clamped = MAX_EXAGGERATION;
      if (__DEV__ && clamped !== value) {
        console.warn(
          `[TerrainLayer:${cfg.id}] exaggeration ${value} clamped to ${clamped} (valid range [0, ${MAX_EXAGGERATION}])`,
        );
      }
      currentExaggeration = clamped;
      // 同步到 paint 属性缓存
      paintProps.set('terrain-exaggeration', value);

      if (__DEV__) {
        console.debug(`[TerrainLayer:${cfg.id}] setExaggeration: ${value}`);
      }
    },

    /**
     * 设置网格分辨率。
     * 已加载瓦片不受影响，新值对后续加载的瓦片生效。
     *
     * @param resolution - 网格段数，范围 [8, 128]，必须为 2 的幂
     *
     * @example
     * terrain.setMeshResolution(64); // 更精细的网格
     */
    setMeshResolution(resolution: number): void {
      if (
        !Number.isFinite(resolution) ||
        resolution < MIN_MESH_RESOLUTION ||
        resolution > MAX_MESH_RESOLUTION ||
        !isPowerOfTwo(resolution)
      ) {
        throw new Error(
          `[${TERRAIN_ERROR_CODES.INVALID_MESH_RESOLUTION}] meshResolution must be a power of 2 in ` +
            `[${MIN_MESH_RESOLUTION}, ${MAX_MESH_RESOLUTION}], got ${resolution}`,
        );
      }
      currentMeshResolution = resolution;

      if (__DEV__) {
        console.debug(`[TerrainLayer:${cfg.id}] setMeshResolution: ${resolution}`);
      }
    },

    /**
     * 获取全局高程纹理。
     * MVP 阶段返回 null——完整实现将返回一个拼合的全局 DEM 纹理。
     *
     * @returns null（MVP 桩实现）
     *
     * @example
     * const tex = terrain.getElevationTexture(); // null (MVP)
     */
    getElevationTexture(): null {
      return null;
    },

    /**
     * 获取全局法线纹理。
     * MVP 阶段返回 null——完整实现将返回法线贴图。
     *
     * @returns null（MVP 桩实现）
     *
     * @example
     * const tex = terrain.getNormalTexture(); // null (MVP)
     */
    getNormalTexture(): null {
      return null;
    },
  };

  return layer;
}
