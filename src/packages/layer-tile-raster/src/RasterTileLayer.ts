// ============================================================
// RasterTileLayer.ts — 栅格瓦片图层完整 WebGPU 实现
// 职责：管理栅格瓦片生命周期（加载→解码→纹理→渐显→淘汰），
//       O(1) LRU 缓存 + Pin 防淘汰、请求调度 + 取消、父瓦片占位防闪烁、
//       相机相对坐标高精度、数据源切换 Cross-Fade、完整 encode() 绘制。
// 依赖层级：L4 图层包，消费 L0 类型 + L4 Layer 接口。
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
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/** RasterTileLayer 模块错误码，前缀 `RASTER_` 以避免跨模块碰撞。 */
const RASTER_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'RASTER_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'RASTER_INVALID_OPACITY',
  /** 亮度超出有效区间 */
  INVALID_BRIGHTNESS: 'RASTER_INVALID_BRIGHTNESS',
  /** 对比度超出有效区间 */
  INVALID_CONTRAST: 'RASTER_INVALID_CONTRAST',
  /** 饱和度超出有效区间 */
  INVALID_SATURATION: 'RASTER_INVALID_SATURATION',
  /** 色相旋转角度为非有限数 */
  INVALID_HUE_ROTATE: 'RASTER_INVALID_HUE_ROTATE',
  /** 渐显时长为非有限正数 */
  INVALID_FADE_DURATION: 'RASTER_INVALID_FADE_DURATION',
  /** GPU 设备不可用 */
  NO_GPU_DEVICE: 'RASTER_NO_GPU_DEVICE',
  /** 瓦片 URL 模板未配置 */
  NO_URL_TEMPLATE: 'RASTER_NO_URL_TEMPLATE',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认瓦片像素尺寸（WebGPU 纹理大小） */
const DEFAULT_TILE_SIZE = 256;

/** 默认渐显时长（毫秒），与 MapLibre 保持一致 */
const DEFAULT_FADE_DURATION_MS = 300;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 亮度的有效下限 */
const BRIGHTNESS_MIN = -1;

/** 亮度的有效上限 */
const BRIGHTNESS_MAX = 1;

/** 对比度的有效下限 */
const CONTRAST_MIN = -1;

/** 对比度的有效上限 */
const CONTRAST_MAX = 1;

/** 饱和度的有效下限 */
const SATURATION_MIN = -1;

/** 饱和度的有效上限 */
const SATURATION_MAX = 1;

/** 不透明度的有效下限 */
const OPACITY_MIN = 0;

/** 不透明度的有效上限 */
const OPACITY_MAX = 1;

/** 渐显完成阈值——当 fadeProgress ≥ 此值时视为完全不透明 */
const FADE_COMPLETE_THRESHOLD = 1.0;

/** 视口覆盖枚举的父级瓦片数上限（与方案五 maxTiles 一致） */
const MAX_COVERING_TILES = 200;

/**
 * 单帧最多绘制的瓦片四边形数（含 zoom-out 时 2×2 子瓦片拼合，≤ MAX_COVERING_TILES×4）。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 */
const MAX_RENDER_TILE_QUADS = 800;

/** 缓存默认最大条目数 */
const CACHE_MAX_ENTRIES = 512;

/** 缓存默认最大字节数 (256 MB) */
const CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * 祖先回溯最大层级差——搜索到 z=0 以保证 pre-loaded 全球瓦片可达。
 * 代价仅为 Map.get 查找，z=22 最多 22 次，可忽略不计。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 */
const MAX_ANCESTOR_SEARCH_DEPTH = 22;

/** 最大并发请求数 */
const MAX_CONCURRENT_REQUESTS = 6;

/**
 * IoU（Intersection over Union）阈值——低于此值时强制重新计算 coveringTiles。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 */
const SCHEDULE_IOU_THRESHOLD = 0.9;

/**
 * 视口未显著变化时最多跳过多少帧后强制重算 coveringTiles。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 */
const SCHEDULE_MAX_SKIP_FRAMES = 30;

/**
 * 预加载全球覆盖瓦片的最大 zoom——从 z=0 到此级别均在 onAdd 时请求。
 * z=0 (1 瓦片) + z=1 (4 瓦片) + z=2 (16 瓦片) = 21 瓦片，确保
 * findAncestor 在任意 zoom 下都能找到纹理，根治边缘闪烁。
 */
const PRELOAD_ANCESTOR_MAX_ZOOM = 2;

/** 每个瓦片 RGBA8 纹理的字节大小 (tileSize × tileSize × 4) 在运行时计算 */
const BYTES_PER_PIXEL_RGBA8 = 4;

/** 角度→弧度的乘法常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度→角度的乘法常量 */
const RAD_TO_DEG = 180 / Math.PI;

/** Web 墨卡托最大纬度 */
const MAX_LATITUDE = 85.051128779806604;

/** 默认瓦片 URL 尺寸 */
const TILE_PIXEL_SIZE = 512;

/** 顶点步长 = 3(pos) + 2(uv) + 1(alpha) = 6 floats × 4 bytes = 24 bytes */
const VERTEX_STRIDE_BYTES = 24;

/** 每个瓦片 4 个顶点 */
const VERTS_PER_TILE = 4;

/** 每个瓦片 6 个索引 */
const INDICES_PER_TILE = 6;

/** 重试最大次数 */
const MAX_RETRY_COUNT = 3;

/** 重试基础延迟 (ms) */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * 栅格图层默认 overzoom 配置。
 * 允许超出数据源最大 zoom 最多 6 级，使用 'scale' 策略（缩放父级瓦片子区域）。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §零
 */
const DEFAULT_RASTER_OVERZOOM_STRATEGY = 'scale' as const;
const DEFAULT_RASTER_MAX_OVERZOOM = 6;
const DEFAULT_RASTER_MAX_UNDERZOOM = 0;

/**
 * 矢量图层默认 overzoom 配置（保留用于将来的矢量图层支持）。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §零
 */
const DEFAULT_VECTOR_MAX_OVERZOOM = 10;

/**
 * AncestorProber 最大缓存条目数（missing + exists 之和），超出后粗粒度清理一半。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §二
 */
const ANCESTOR_PROBER_MAX_SIZE = 2000;

/**
 * 安全最大显示 zoom 上限。
 * MapLibre 上限 24，此处扩展到 28 以支持极限 overzoom 场景。
 * 防止 2^z 溢出精度（2^28 ≈ 2.68 亿，远在 float64 安全整数范围内）。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
const MAX_DISPLAY_ZOOM_CAP = 28;

/**
 * AncestorProber.findAncestor 默认最大回溯级数。
 * 在稀疏金字塔中最多向上搜索 8 级寻找有数据的祖先。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §二
 */
const PROBER_MAX_LEVELS_UP = 8;

/**
 * Cohen-Sutherland 线段裁剪最大迭代次数——防止极端退化情况下死循环。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
const CLIP_MAX_ITERATIONS = 20;

/**
 * 裁剪连续性判断阈值——两个端点距离小于此值时视为连续。
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
const CLIP_CONTINUITY_EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// 内联 WGSL 着色器源码
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片完整 WGSL 着色器。
 * group(0) = 相机 (每帧 1 次), group(1) = 样式 (每层 1 次),
 * group(2) = 瓦片纹理+采样器 (每瓦片切换)。
 * 顶点属性携带相机相对坐标 + 预计算 UV + 渐显 alpha。
 * 片元着色器实现亮度/对比度/饱和度/色相旋转完整调色。
 */
const RASTER_TILE_WGSL = /* wgsl */ `
// ═══ 相机 Uniform（group 0，每帧更新一次）═══
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ═══ 样式 Uniform（group 1，样式变更时更新）═══
struct StyleUniforms {
  brightness: f32,
  contrast:   f32,
  saturation: f32,
  hueRotate:  f32,
};
@group(1) @binding(0) var<uniform> style: StyleUniforms;

// ═══ 瓦片纹理（group 2，每瓦片切换）═══
@group(2) @binding(0) var tileSampler: sampler;
@group(2) @binding(1) var tileTexture: texture_2d<f32>;

// ═══ 顶点输入/输出 ═══
struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) uv:       vec2<f32>,
  @location(2) alpha:    f32,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv:             vec2<f32>,
  @location(1) alpha:          f32,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(in.position, 1.0);
  out.uv      = in.uv;
  out.alpha   = in.alpha;
  return out;
}

// 色相旋转——在 RGB 空间绕灰度轴 (1,1,1)/sqrt(3) 旋转
fn hueRotateRGB(color: vec3<f32>, angle: f32) -> vec3<f32> {
  let cosA = cos(angle);
  let sinA = sin(angle);
  // 1/sqrt(3) ≈ 0.57735
  let k = 0.57735026919;
  let oneThird = 1.0 / 3.0;
  let oneMinusCos = 1.0 - cosA;
  // Rodrigues 旋转公式在 RGB 空间的展开
  let rx = color.r * (cosA + oneThird * oneMinusCos)
         + color.g * (oneThird * oneMinusCos - k * sinA)
         + color.b * (oneThird * oneMinusCos + k * sinA);
  let gx = color.r * (oneThird * oneMinusCos + k * sinA)
         + color.g * (cosA + oneThird * oneMinusCos)
         + color.b * (oneThird * oneMinusCos - k * sinA);
  let bx = color.r * (oneThird * oneMinusCos - k * sinA)
         + color.g * (oneThird * oneMinusCos + k * sinA)
         + color.b * (cosA + oneThird * oneMinusCos);
  return vec3<f32>(rx, gx, bx);
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);

  // 亮度：线性偏移
  color = vec4<f32>(color.rgb + vec3<f32>(style.brightness), color.a);

  // 对比度：以 0.5 为中心缩放
  color = vec4<f32>(
    (color.rgb - vec3<f32>(0.5)) * (1.0 + style.contrast) + vec3<f32>(0.5),
    color.a,
  );

  // 饱和度：与灰度混合
  let gray = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  color = vec4<f32>(
    mix(vec3<f32>(gray), color.rgb, 1.0 + style.saturation),
    color.a,
  );

  // 色相旋转（仅在 hueRotate ≠ 0 时有效果，但 GPU 总是执行——分支更贵）
  color = vec4<f32>(hueRotateRGB(color.rgb, style.hueRotate), color.a);

  // Clamp 到合法颜色范围
  color = clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));

  // 渐显 alpha（来自顶点属性，已乘以图层 opacity）
  color.a *= in.alpha;

  return color;
}
`;

// ---------------------------------------------------------------------------
// 内部类型定义
// ---------------------------------------------------------------------------

/**
 * LRU 缓存条目：一个栅格瓦片在缓存中的完整状态。
 * 包含 GPU 纹理、BindGroup、双向链表指针和加载状态。
 */
interface CacheEntry {
  /** 瓦片唯一键 "z/x/y" */
  key: string;
  /** 瓦片坐标 */
  coord: TileCoord;
  /** GPU 纹理句柄，loading/error 状态下为 null */
  texture: GPUTexture | null;
  /** 纹理 + 采样器的 BindGroup，与 texture 同步创建/销毁 */
  bindGroup: GPUBindGroup | null;
  /** 纹理字节大小（用于内存统计） */
  byteSize: number;
  /** 瓦片当前状态 */
  state: 'loading' | 'ready' | 'error-transient' | 'error-permanent';
  /** 连续错误次数（用于指数退避） */
  errorCount: number;
  /** 渐显进度 [0, 1]，0=刚加载完（透明），1=完全不透明 */
  fadeProgress: number;
  /** 加载完成时间戳 (performance.now()) */
  loadedAt: number;
  /** 双向链表前驱——指向更旧的条目 */
  prev: CacheEntry | null;
  /** 双向链表后继——指向更新的条目 */
  next: CacheEntry | null;
}

/**
 * 可见瓦片描述：经过可见性仲裁后最终参与渲染的瓦片。
 * 可能是原始请求的瓦片，也可能是祖先瓦片占位（此时 UV 为子区域）。
 */
interface VisibleTile {
  /** 请求的原始瓦片坐标（决定绘制在世界中的位置） */
  targetCoord: TileCoord;
  /** 实际使用的缓存条目（可能是祖先） */
  entry: CacheEntry;
  /** UV 子区域偏移 [0,0]=完整瓦片 */
  uvOffset: [number, number];
  /** UV 子区域缩放 [1,1]=完整瓦片 */
  uvScale: [number, number];
}

/**
 * 样式 Uniform CPU 端镜像，对应 WGSL StyleUniforms struct。
 * 每帧检查脏标记后上传到 GPU。
 */
interface StyleUniformData {
  /** 亮度偏移量 [-1, 1]，0=无变化 */
  brightness: number;
  /** 对比度倍率 [-1, 1]，0=无变化 */
  contrast: number;
  /** 饱和度倍率 [-1, 1]，0=无变化 */
  saturation: number;
  /** 色相旋转角度（弧度），0=无旋转 */
  hueRotate: number;
  /** 不透明度 [0, 1]（不上传到 GPU，而是乘入顶点 alpha） */
  opacity: number;
}

// ---------------------------------------------------------------------------
// Overzoom 类型定义
// ---------------------------------------------------------------------------

/**
 * 数据源的 zoom 范围。
 * minNativeZoom 和 maxNativeZoom 表示数据源实际提供瓦片的级别范围。
 * 超出此范围的 zoom 需要 overzoom（向上缩放）或 underzoom（向下缩放）处理。
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §零
 */
interface TileSourceZoomRange {
  /** 数据源最小原生 zoom，默认 0。有些数据源不提供低 zoom 级别的瓦片。 */
  readonly minNativeZoom: number;
  /** 数据源最大原生 zoom，默认 22。这是数据源实际能返回瓦片的最高级别。 */
  readonly maxNativeZoom: number;
}

/**
 * 图层 overzoom 配置（只读，不可变）。
 * 控制当相机 zoom 超出数据源原生范围时的行为。
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §零
 */
interface OverzoomConfig {
  /**
   * overzoom 策略：
   * - 'scale': 缩放显示父级瓦片的子区域（默认，栅格地图最常用）
   * - 'transparent': 超出范围显示透明（适合叠加图层）
   * - 'none': 完全不处理 overzoom（适合聚类层等不允许跨 zoom 的场景）
   */
  readonly overzoomStrategy: 'scale' | 'transparent' | 'none';
  /** 最大允许的 overzoom 级数（栅格默认 6，矢量默认 10） */
  readonly maxOverzoom: number;
  /** 最大允许的 underzoom 级数（默认 0，即不允许 underzoom） */
  readonly maxUnderzoom: number;
}

/**
 * Overzoom 解析结果——将"显示需要的瓦片"映射为"实际请求的瓦片 + UV 子区域"。
 * 当 displayZ > maxNativeZoom 时，requestZ 被 clamp 到 maxNativeZoom，
 * uvOffset/uvScale 指示从该请求瓦片中取哪个子区域来渲染 display 位置。
 *
 * @example
 * // 数据源 maxNativeZoom=14，相机 zoom=18，瓦片 x=200003 y=150001
 * // shift=4, requestZ=14, requestX=12500, requestY=9375
 * // uvOffset=[3/16, 1/16], uvScale=[1/16, 1/16]
 * // → 请求 14/12500/9375，渲染第 4 列第 2 行的 1/16 子区域
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
interface ResolvedTile {
  /** 实际请求的瓦片 zoom（≤ maxNativeZoom） */
  readonly requestZ: number;
  /** 实际请求的瓦片列号 */
  readonly requestX: number;
  /** 实际请求的瓦片行号 */
  readonly requestY: number;
  /** 实际请求的瓦片键 "z/x/y"——用于缓存查找和请求调度 */
  readonly requestKey: string;
  /** 目标显示位置 zoom（可能 > maxNativeZoom，是用户看到的 zoom） */
  readonly displayZ: number;
  /** 目标显示位置列号 */
  readonly displayX: number;
  /** 目标显示位置行号 */
  readonly displayY: number;
  /** 目标显示位置键 "z/x/y"——用于可见性去重 */
  readonly displayKey: string;
  /** UV 子区域偏移 [0,0]=完整瓦片（非 overzoom 时） */
  readonly uvOffset: [number, number];
  /** UV 子区域缩放 [1,1]=完整瓦片（非 overzoom 时） */
  readonly uvScale: [number, number];
  /** 是否处于 overzoom 状态（displayZ ≠ requestZ） */
  readonly isOverzoomed: boolean;
  /** overzoom 级数 = |displayZ - requestZ|，0 = 正常模式 */
  readonly overzoomLevels: number;
}

/**
 * 矢量瓦片特征（用于矢量瓦片 overzoom 几何裁剪）。
 * 坐标归一化到 [0, 1] 范围（瓦片内部坐标系）。
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
interface VectorFeature {
  /** 几何类型——Point / LineString / Polygon */
  readonly type: 'Point' | 'LineString' | 'Polygon';
  /** 坐标数组，Point: [[x,y]], Line: [[x,y],...], Polygon: [[x,y],...] */
  readonly geometry: number[][];
  /** 属性键值对 */
  readonly properties: Record<string, unknown>;
  /** 所属矢量图层名 */
  readonly layer: string;
}

// ---------------------------------------------------------------------------
// RasterTileLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层构造选项。
 *
 * @example
 * const opts: RasterTileLayerOptions = {
 *   id: 'satellite',
 *   source: 'mapbox-satellite',
 *   tiles: ['https://tile.example.com/{z}/{x}/{y}.png'],
 *   tileSize: 256,
 *   opacity: 0.9,
 *   minzoom: 0,
 *   maxzoom: 19,
 * };
 */
export interface RasterTileLayerOptions {
  /** 图层唯一 ID */
  readonly id: string;
  /** 绑定的栅格数据源 ID */
  readonly source: string;
  /** 瓦片 URL 模板列表（支持 {z}/{x}/{y} 占位符），从 source 解析或直接指定 */
  readonly tiles?: string[];
  /** 瓦片像素尺寸，可选，默认 256 */
  readonly tileSize?: number;
  /** 初始不透明度 [0,1]，默认 1 */
  readonly opacity?: number;
  /** 最小可见缩放级别，默认 0 */
  readonly minzoom?: number;
  /** 最大可见缩放级别，默认 22 */
  readonly maxzoom?: number;
  /** 渐显时长（毫秒），默认 300 */
  readonly fadeDuration?: number;
  /** 投影标识，默认 'mercator' */
  readonly projection?: string;
  /**
   * 数据源最小原生 zoom（有些源不提供低 zoom 瓦片），默认等于 minzoom。
   * 当 camera.zoom < minNativeZoom 时触发 underzoom（缩小显示 minNativeZoom 瓦片）。
   * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
   */
  readonly minNativeZoom?: number;
  /**
   * 数据源最大原生 zoom（源实际提供瓦片的最高级别），默认等于 maxzoom。
   * 当 camera.zoom > maxNativeZoom 时触发 overzoom（放大显示子区域）。
   * 注意与 maxzoom 不同：maxzoom 控制图层最大可见级别，maxNativeZoom 控制数据源边界。
   * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
   */
  readonly maxNativeZoom?: number;
  /**
   * Overzoom 配置，控制超出数据源 zoom 范围时的行为。
   * 部分字段可省略，未指定的字段使用默认值 { strategy:'scale', maxOverzoom:6, maxUnderzoom:0 }。
   * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
   */
  readonly overzoom?: Partial<OverzoomConfig>;
  /**
   * Zoom fade-in 范围——图层在 [start, end] 范围内从透明渐变为不透明。
   * 用于多图层平滑切换（如位图→矢量过渡）。
   * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §四
   */
  readonly fadeInZoom?: { readonly start: number; readonly end: number };
  /**
   * Zoom fade-out 范围——图层在 [start, end] 范围内从不透明渐变为透明。
   * 用于多图层平滑切换。
   * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §四
   */
  readonly fadeOutZoom?: { readonly start: number; readonly end: number };
  /** paint 属性 */
  readonly paint?: Record<string, unknown>;
  /** layout 属性 */
  readonly layout?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RasterTileLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层公开接口。
 *
 * @stability experimental
 */
export interface RasterTileLayer extends Layer {
  /** 图层类型鉴别字面量 */
  readonly type: 'raster';
  /** 当前帧可见瓦片数 */
  readonly visibleTiles: number;
  /** 加载中瓦片数 */
  readonly loadingTiles: number;
  /** 缓存总瓦片数 */
  readonly cachedTileCount: number;
  /** 当前是否处于 overzoom 状态（camera.zoom > maxNativeZoom） */
  readonly isOverzoomed: boolean;
  /** 当前 overzoom 级数（0 = 正常，>0 = overzoom 中） */
  readonly currentOverzoomLevels: number;

  setBrightness(value: number): void;
  getBrightness(): number;
  setContrast(value: number): void;
  getContrast(): number;
  setSaturation(value: number): void;
  getSaturation(): number;
  setHueRotate(degrees: number): void;
  getHueRotate(): number;
  setFadeDuration(ms: number): void;

  /**
   * 方案八 IdleDetector：所有瓦片加载完成后 resolve。
   * 可用于截图等需要等待完整渲染的场景。
   * @see doc/architecture/GeoForge_Tile_Solutions.md 方案八
   */
  waitForIdle(): Promise<void>;

  /**
   * 当前是否处于 idle（无进行中的瓦片加载）。
   */
  isIdle(): boolean;

  /**
   * 启/停该图层的绘制编码。保留瓦片下载 / 缓存等所有能力，仅禁用 `encode` 的实际 draw call。
   * 用于 2.5D 模式：地形层接管底图渲染时，平面 raster 层需停绘，但缓存继续供地形层 drape 使用。
   */
  setRenderEnabled(enabled: boolean): void;

  /**
   * 同步读取已就绪瓦片的 GPU 纹理（若存在）。
   * 供地形层 drape 借用，避免重复下载 OSM。
   */
  getTextureForTile(z: number, x: number, y: number): GPUTexture | null;

  /**
   * 异步触发指定瓦片的加载（若缓存/待队列中都没有）。
   * 地形层在 drape 贴图未命中时调用，让下次命中可立即拿到。
   */
  requireTile(z: number, x: number, y: number): void;
}

// ---------------------------------------------------------------------------
// O(1) LRU 瓦片缓存
// ---------------------------------------------------------------------------

/**
 * O(1) 双向链表 LRU 瓦片缓存。
 * 支持 Pin 机制：当前帧正在渲染的瓦片不可被淘汰。
 * 淘汰策略：条目数 > maxSize 或字节 > maxBytes 时从链表头（最旧）开始淘汰。
 */
class TileCache {
  /** 键→条目的快速查找表 */
  private readonly map = new Map<string, CacheEntry>();
  /** 链表头：最久未使用（最先淘汰） */
  private head: CacheEntry | null = null;
  /** 链表尾：最近使用（最后淘汰） */
  private tail: CacheEntry | null = null;
  /** 当前缓存占用字节数 */
  private currentBytes = 0;
  /** 当前帧被 Pin 的瓦片键集合 */
  private readonly pinnedKeys = new Set<string>();

  /** 最大条目数 */
  readonly maxSize: number;
  /** 最大字节数 */
  readonly maxBytes: number;

  constructor(maxSize = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }

  /**
   * 查找缓存条目，命中时自动提升到链表尾部（最近使用）。
   *
   * @param key - 瓦片键 "z/x/y"
   * @returns 缓存条目或 undefined
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.moveToTail(entry);
    }
    return entry;
  }

  /**
   * 获取或创建一个 loading 状态的条目。
   *
   * @param key - 瓦片键
   * @param coord - 瓦片坐标
   * @returns 已存在或新建的条目
   */
  getOrCreate(key: string, coord: TileCoord): CacheEntry {
    let entry = this.map.get(key);
    if (entry === undefined) {
      entry = {
        key, coord,
        texture: null, bindGroup: null, byteSize: 0,
        state: 'loading', errorCount: 0, fadeProgress: 0, loadedAt: 0,
        prev: null, next: null,
      };
      this.map.set(key, entry);
      this.appendToTail(entry);
    }
    return entry;
  }

  /**
   * 将加载完成的瓦片纹理写入缓存。
   *
   * @param key - 瓦片键
   * @param texture - GPU 纹理
   * @param bindGroup - 纹理 BindGroup
   * @param byteSize - 纹理字节大小
   */
  setReady(key: string, texture: GPUTexture, bindGroup: GPUBindGroup, byteSize: number): void {
    const entry = this.map.get(key);
    if (entry === undefined) {
      return;
    }
    // 如果旧纹理存在且不同，先销毁旧的
    if (entry.texture !== null && entry.texture !== texture) {
      entry.texture.destroy();
      this.currentBytes -= entry.byteSize;
    }
    entry.texture = texture;
    entry.bindGroup = bindGroup;
    entry.byteSize = byteSize;
    entry.state = 'ready';
    entry.errorCount = 0;
    // 跳过渐显：瓦片到达时该位置通常已被子瓦片/祖先占位覆盖，
    // 若 fadeProgress 从 0 开始，新瓦片会有 300ms 透明期导致闪烁。
    // 直接设为 1.0 让新瓦片立即完全不透明，覆盖占位纹理。
    entry.fadeProgress = FADE_COMPLETE_THRESHOLD;
    entry.loadedAt = performance.now();
    this.currentBytes += byteSize;
    this.moveToTail(entry);
    // 填入新数据后检查是否需要淘汰
    this.evictUntilFit();
  }

  /** 检查键是否存在 */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.map.size;
  }

  /** 当前缓存字节数 */
  get bytes(): number {
    return this.currentBytes;
  }

  /**
   * 每帧渲染前调用：标记本帧要渲染的瓦片不可被 LRU 淘汰。
   *
   * @param keys - 当前帧可见瓦片键的可迭代对象
   */
  pinForFrame(keys: Iterable<string>): void {
    this.pinnedKeys.clear();
    for (const k of keys) {
      this.pinnedKeys.add(k);
    }
  }

  /**
   * 销毁缓存中所有 GPU 资源，清空所有数据结构。
   */
  destroy(): void {
    for (const entry of this.map.values()) {
      if (entry.texture !== null) {
        entry.texture.destroy();
        entry.texture = null;
      }
      entry.bindGroup = null;
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.currentBytes = 0;
    this.pinnedKeys.clear();
  }

  // ═══ O(1) 双向链表操作 ═══

  /** 将条目移动到链表尾（最近使用） */
  private moveToTail(entry: CacheEntry): void {
    if (entry === this.tail) {
      return;
    }
    this.removeFromList(entry);
    this.appendToTail(entry);
  }

  /** 将条目追加到链表尾 */
  private appendToTail(entry: CacheEntry): void {
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail !== null) {
      this.tail.next = entry;
    }
    this.tail = entry;
    if (this.head === null) {
      this.head = entry;
    }
  }

  /** 将条目从链表中摘除 */
  private removeFromList(entry: CacheEntry): void {
    if (entry.prev !== null) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }
    if (entry.next !== null) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  /** 从链表头开始淘汰，直到满足容量约束。跳过 pinned 条目。 */
  private evictUntilFit(): void {
    let cursor = this.head;
    while ((this.map.size > this.maxSize || this.currentBytes > this.maxBytes) && cursor !== null) {
      const next = cursor.next;
      // 跳过当前帧正在渲染的瓦片
      if (!this.pinnedKeys.has(cursor.key)) {
        this.removeFromList(cursor);
        if (cursor.texture !== null) {
          cursor.texture.destroy();
          cursor.texture = null;
        }
        cursor.bindGroup = null;
        this.currentBytes -= cursor.byteSize;
        this.map.delete(cursor.key);
      }
      cursor = next;
    }
  }
}

// ---------------------------------------------------------------------------
// AncestorProber——动态稀疏金字塔探测器
// ---------------------------------------------------------------------------

/**
 * 动态记录哪些瓦片有数据、哪些缺失，在请求失败时自动向上查找有数据的祖先。
 *
 * 与 findAncestor 的职责分离：
 *   - findAncestor = 在 **缓存** 中搜索最近的就绪祖先（基于 TileCache 内容）
 *   - AncestorProber = 基于 **实际 HTTP 响应** 记录哪些坐标有数据/缺失，
 *     在请求失败时跳过已知缺失的祖先，减少无效请求
 *
 * 典型场景（MapLibre #111/#5692）：
 *   稀疏数据源只在部分区域有高 zoom 瓦片，其他区域 404。
 *   AncestorProber 记住 404 的位置，下次直接跳到有数据的祖先。
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §二
 */
class AncestorProber {
  /** 已知缺失的瓦片坐标键集合 */
  private readonly missing = new Set<string>();
  /** 已知存在的瓦片坐标键集合 */
  private readonly exists = new Set<string>();
  /** 两个集合大小之和的上限，超出后触发粗粒度清理 */
  private readonly maxCacheSize: number;

  /**
   * @param maxCacheSize - 最大缓存条目数，默认 ANCESTOR_PROBER_MAX_SIZE
   */
  constructor(maxCacheSize = ANCESTOR_PROBER_MAX_SIZE) {
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * 标记瓦片有数据（HTTP 200 + 非空响应体）。
   * 同时从 missing 中移除（状态可能从缺失变为存在，如稀疏数据源更新）。
   *
   * @param z - zoom 级别
   * @param x - 列号
   * @param y - 行号
   */
  markExists(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    this.exists.add(key);
    this.missing.delete(key);
    this.trimIfNeeded();
  }

  /**
   * 标记瓦片缺失（HTTP 404 / 204 / 空响应 / 永久错误）。
   * 同时从 exists 中移除。
   *
   * @param z - zoom 级别
   * @param x - 列号
   * @param y - 行号
   */
  markMissing(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    this.missing.add(key);
    this.exists.delete(key);
    this.trimIfNeeded();
  }

  /**
   * 查找最近的有数据祖先，跳过已知缺失的级别。
   * 返回 ResolvedTile（含 UV 子区域映射），或 null（所有祖先均缺失或超出搜索深度）。
   *
   * 搜索逻辑：
   *   - 已知 missing → 跳过，继续向上
   *   - 已知 exists → 返回该祖先（带 UV 子区域）
   *   - 未知（不在 missing 也不在 exists）→ 返回该祖先（需要请求验证）
   *
   * @param z - 起始 zoom
   * @param x - 起始列号
   * @param y - 起始行号
   * @param maxLevelsUp - 最大向上搜索级数，默认 PROBER_MAX_LEVELS_UP
   * @returns ResolvedTile 或 null
   */
  findAncestor(z: number, x: number, y: number, maxLevelsUp = PROBER_MAX_LEVELS_UP): ResolvedTile | null {
    let pz = z - 1;
    let px = x >> 1;
    let py = y >> 1;

    while (pz >= 0 && (z - pz) <= maxLevelsUp) {
      const pKey = `${pz}/${px}/${py}`;

      if (this.missing.has(pKey)) {
        // 已知缺失，跳过继续向上
        pz--;
        px >>= 1;
        py >>= 1;
        continue;
      }

      // 已知存在 或 未知（需要请求验证）→ 返回这个祖先
      return makeResolvedTileWithUV(z, x, y, pz, px, py, z - pz);
    }

    return null;
  }

  /**
   * 防止无限增长——当 missing + exists 总数超过 maxCacheSize 时，
   * 各清理一半条目。简单粗暴但足够有效（Set 遍历顺序近似插入顺序）。
   */
  private trimIfNeeded(): void {
    const total = this.missing.size + this.exists.size;
    if (total <= this.maxCacheSize) {
      return;
    }
    const half = this.maxCacheSize >> 1;
    let count = 0;
    for (const k of this.missing) {
      if (count++ >= half) { break; }
      this.missing.delete(k);
    }
    count = 0;
    for (const k of this.exists) {
      if (count++ >= half) { break; }
      this.exists.delete(k);
    }
  }

  /**
   * 销毁探测器，清空所有记录。
   */
  destroy(): void {
    this.missing.clear();
    this.exists.clear();
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/**
 * 瓦片坐标→字符串键。
 *
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns "z/x/y" 格式字符串
 */
function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * 构建瓦片请求 URL，替换 {z}/{x}/{y} 占位符。
 *
 * @param template - URL 模板
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns 完整 URL
 */
function buildTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * 钳制纬度到 Web Mercator 有效范围。
 *
 * @param lat - 输入纬度（度）
 * @returns 钳制后的纬度
 */
function clampLat(lat: number): number {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

/**
 * 经纬度→世界像素坐标（基于 512 瓦片尺寸的 Web Mercator）。
 *
 * @param lng - 经度（度）
 * @param lat - 纬度（度）
 * @param worldSize - 当前缩放级别下世界总像素 = TILE_PIXEL_SIZE × 2^zoom
 * @returns [pixelX, pixelY]
 */
function lngLatToWorldPixel(lng: number, lat: number, worldSize: number): [number, number] {
  const px = ((lng + 180) / 360) * worldSize;
  const cLat = clampLat(lat);
  const latRad = cLat * DEG_TO_RAD;
  const py = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * worldSize;
  return [px, py];
}

// ════════════════════════════════════════════════════════════════════
// 屏幕→地面反投影工具函数（Pipeline v2 §3.5 / §4.2 实现）
// ════════════════════════════════════════════════════════════════════

/**
 * 4×4 列主序矩阵 × 4D 齐次向量乘法。
 * 用于将 NDC 坐标通过 inverseVPMatrix 反投影到世界像素坐标系。
 *
 * @param m  - 4×4 矩阵（Float32Array[16]，column-major）
 * @param x  - 齐次向量 x 分量
 * @param y  - 齐次向量 y 分量
 * @param z  - 齐次向量 z 分量
 * @param w  - 齐次向量 w 分量
 * @returns [rx, ry, rz, rw] 结果四维向量
   *
   * @example
 * const clip = mulMat4Vec4(invVP, ndcX, ndcY, 1.0, 1.0);
 * const worldX = clip[0] / clip[3];
 */
function mulMat4Vec4(
  m: Float32Array,
  x: number, y: number, z: number, w: number,
): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8]  * z + m[12] * w,
    m[1] * x + m[5] * y + m[9]  * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

/**
 * 屏幕像素 → 地面世界像素坐标（相机相对坐标系）。
 *
 * 将屏幕点通过 inverseVPMatrix 反投影为射线（near/far 两端），
 * 然后与 z=0 地面平面求交。
 *
 * Reversed-Z 约定：近裁面 ndc_z=1，远裁面 ndc_z=0。
 * 正交投影（2D）同样适用——射线竖直穿过地面，t 恒为正。
 *
 * @param sx    - 屏幕 x（CSS 像素）
 * @param sy    - 屏幕 y（CSS 像素）
 * @param invVP - 逆 VP 矩阵（Float32Array[16]，column-major）
 * @param vpW   - 视口宽度（CSS 像素）
 * @param vpH   - 视口高度（CSS 像素）
 * @returns 相机相对世界像素坐标 [rx, ry]；射线不与地面相交返回 null
 *
 * @example
 * const ground = screenToGroundRel(400, 300, invVP, 800, 600);
 * if (ground) { const [rx, ry] = ground; }
 */
function screenToGroundRel(
  sx: number, sy: number,
  invVP: Float32Array,
  vpW: number, vpH: number,
): [number, number] | null {
  // 屏幕像素 → NDC [-1, 1]
  const ndcX = (sx / vpW) * 2 - 1;
  const ndcY = 1 - (sy / vpH) * 2;

  // Reversed-Z: near=1, far=0
  const a = mulMat4Vec4(invVP, ndcX, ndcY, 1, 1);
  const b = mulMat4Vec4(invVP, ndcX, ndcY, 0, 1);

  // 透视除法 → 世界坐标（相机相对）
  const nearX = a[0] / a[3], nearY = a[1] / a[3], nearZ = a[2] / a[3];
  const farX  = b[0] / b[3], farY  = b[1] / b[3], farZ  = b[2] / b[3];

  // 射线与 z=0 平面求交: P(t) = near + t·(far − near), 令 P.z = 0
  const dz = farZ - nearZ;
  /** 平行于地面的射线（dz≈0）无法求交 */
  if (Math.abs(dz) < 1e-10) { return null; }
  const t = -nearZ / dz;
  /** t<0 表示地面在射线反方向——该屏幕点看向天空 */
  if (t < 0) { return null; }

  return [
    nearX + t * (farX - nearX),
    nearY + t * (farY - nearY),
  ];
}

/**
 * 屏幕射线不与地面相交时的兜底——沿射线水平方向延伸到最远可视距离。
 * 用于 pitch 较大时屏幕上部看向天空/地平线的采样点。
 *
 * 策略（Pipeline v2 §3.5 screenToHorizon）：
 * 取远裁面点与相机位置的水平差向量，归一化后乘 maxDist。
 * 结果仍为**相机相对**坐标。
 *
 * @param sx        - 屏幕 x（CSS 像素）
 * @param sy        - 屏幕 y（CSS 像素）
 * @param invVP     - 逆 VP 矩阵
 * @param vpW       - 视口宽度
 * @param vpH       - 视口高度
 * @param camRelX   - 相机在相机相对坐标系中的 x（= position[0] − centerPx）
 * @param camRelY   - 相机在相机相对坐标系中的 y（= position[1] − centerPy）
 * @param maxDist   - 最远可视地面距离（世界像素），保守上限
 * @returns 相机相对世界像素坐标 [rx, ry]
 */
function screenToHorizonRel(
  sx: number, sy: number,
  invVP: Float32Array,
  vpW: number, vpH: number,
  camRelX: number, camRelY: number,
  maxDist: number,
): [number, number] {
  const ndcX = (sx / vpW) * 2 - 1;
  const ndcY = 1 - (sy / vpH) * 2;

  // 远裁面点（Reversed-Z far = ndc_z=0）
  const fp = mulMat4Vec4(invVP, ndcX, ndcY, 0, 1);
  const farX = fp[0] / fp[3];
  const farY = fp[1] / fp[3];

  // 从相机位置到远裁面点的水平方向
  const dx = farX - camRelX;
  const dy = farY - camRelY;
  const hLen = Math.sqrt(dx * dx + dy * dy);

  // 退化情况（射线几乎垂直）：返回相机正下方
  if (hLen < 1e-6) { return [camRelX, camRelY]; }

  // 沿水平方向延伸到 maxDist（保守覆盖地平线附近瓦片）
  const scale = maxDist / hLen;
  return [
    camRelX + dx * scale,
    camRelY + dy * scale,
  ];
}

/**
 * 计算当前相机视口覆盖的瓦片列表（Pipeline v2 §4.2 实现）。
 *
 * 算法三步：
 * 1. 在屏幕边缘均匀采样 20+ 个点，通过 inverseVPMatrix 反投影到地面世界像素坐标。
 *    → 自动处理 bearing 旋转、pitch 透视、正交/透视投影。
 * 2. 地面点取 axis-aligned BBox → 瓦片坐标范围（旋转后 BBox 天然是扩大的范围）。
 * 3. 枚举范围内瓦片，按距中心排序，截断到上限。
 *
 * 对于 2D（pitch=0, bearing=0, 正交投影），退化为与旧 BBox 方法完全等价的结果。
 *
 * @param camera       - 当前相机状态（包含 inverseVPMatrix / center / zoom / position / fov）
 * @param canvasWidth  - CSS 画布宽度
 * @param canvasHeight - CSS 画布高度
 * @param minZoom      - 图层最小缩放级别
 * @param maxZoom      - 图层最大缩放级别（数据源最大级别）
 * @returns 需要的瓦片坐标列表，按距中心排序
 */
function computeCoveringTiles(
  camera: CameraState,
  canvasWidth: number,
  canvasHeight: number,
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const zoom = camera.zoom;
  // 瓦片 zoom 级别：取整数，限制在图层范围内
  const tileZ = Math.min(Math.max(Math.floor(zoom), minZoom), maxZoom);
  const n = Math.pow(2, tileZ);

  // 浮点 worldSize（相机连续 zoom 用于精确像素定位）
  const worldSize = TILE_PIXEL_SIZE * Math.pow(2, zoom);

  // 相机中心的绝对世界像素坐标（camera-relative → absolute 转换基准）
  const [cx, cy] = lngLatToWorldPixel(camera.center[0], camera.center[1], worldSize);

  // 最远可视地面距离（horizon fallback 用）
  // cameraToCenterDist ≈ vpH / 2 / tan(fov/2)
  const tanHalfFov = Math.tan(camera.fov / 2);
  const cameraToCenterDist = (tanHalfFov > 1e-10)
    ? canvasHeight / 2 / tanHalfFov
    : canvasHeight * 10;
  // 保守取 3 倍 cameraToCenterDist——覆盖 pitch≤70° 的 farZ
  const maxDist = cameraToCenterDist * 3;

  // 相机在相机相对坐标系中的位置——直接从 pitch/bearing 推导，
  // 不使用 camera.position（其存储的是 Mercator 米制坐标，与世界像素坐标系不兼容）
  const altPixels = cameraToCenterDist; // vpH/2/tan(fov/2) 即 altPixels
  const offsetBack = Math.sin(camera.pitch) * altPixels;
  const camRelX = -Math.sin(camera.bearing) * offsetBack;
  const camRelY = Math.cos(camera.bearing) * offsetBack;

  const invVP = camera.inverseVPMatrix;
  const W = canvasWidth;
  const H = canvasHeight;

  // ═══ 步骤 1：屏幕边缘 20+ 个采样点 → 地面世界像素（camera-relative → absolute） ═══
  // 上边缘 5 点 + 下边缘 5 点 + 左边缘 3 点 + 右边缘 3 点 + 中心 = 17 点
  // 比四角更密采样，避免凹形可视区域（高 pitch + bearing）遗漏瓦片
  const screenPts: [number, number][] = [];
  for (let i = 0; i <= 4; i++) { screenPts.push([W * i / 4, 0]); }
  for (let i = 0; i <= 4; i++) { screenPts.push([W * i / 4, H]); }
  for (let i = 1; i <= 3; i++) { screenPts.push([0, H * i / 4]); }
  for (let i = 1; i <= 3; i++) { screenPts.push([W, H * i / 4]); }
  screenPts.push([W / 2, H / 2]);

  // 每个屏幕点 → 地面绝对世界像素
  let minAbsX = Infinity, minAbsY = Infinity;
  let maxAbsX = -Infinity, maxAbsY = -Infinity;

  for (let pi = 0; pi < screenPts.length; pi++) {
    const sx = screenPts[pi][0];
    const sy = screenPts[pi][1];

    // 优先尝试射线-地面求交；高 pitch 上部射线不与地面相交时走 horizon
    let relPt = screenToGroundRel(sx, sy, invVP, W, H);
    if (relPt === null) {
      relPt = screenToHorizonRel(sx, sy, invVP, W, H, camRelX, camRelY, maxDist);
    }

    // camera-relative → absolute world pixel
    const absX = relPt[0] + cx;
    const absY = relPt[1] + cy;

    // 直接累积 min/max（旋转后的 axis-aligned BBox 天然比正交 BBox 大，正确行为）
    if (absX < minAbsX) { minAbsX = absX; }
    if (absY < minAbsY) { minAbsY = absY; }
    if (absX > maxAbsX) { maxAbsX = absX; }
    if (absY > maxAbsY) { maxAbsY = absY; }
  }

  // ═══ 步骤 2：地面 BBox → tileZ 级别瓦片坐标范围 ═══
  // 如果所有采样点都未命中地面（BBox 无效），提前返回空列表
  if (!Number.isFinite(minAbsX) || !Number.isFinite(maxAbsX) ||
      !Number.isFinite(minAbsY) || !Number.isFinite(maxAbsY) ||
      minAbsX > maxAbsX || minAbsY > maxAbsY) {
    return [];
  }

  const tileSizePx = worldSize / n;
  const minTileX = Math.max(0, Math.floor(minAbsX / tileSizePx));
  const minTileY = Math.max(0, Math.floor(minAbsY / tileSizePx));
  const maxTileX = Math.min(n - 1, Math.ceil(maxAbsX / tileSizePx));
  const maxTileY = Math.min(n - 1, Math.ceil(maxAbsY / tileSizePx));

  // 安全检查：如果估算瓦片数量过大（可能由精度问题导致），截断范围
  const estTileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  if (estTileCount > MAX_COVERING_TILES * 4 || estTileCount < 0) {
    // 回退到以中心为基准的保守范围
    const halfRange = Math.ceil(Math.sqrt(MAX_COVERING_TILES) / 2);
    const cTileX = Math.floor(cx / tileSizePx);
    const cTileY = Math.floor(cy / tileSizePx);
    return [{
      x: Math.max(0, Math.min(n - 1, cTileX)),
      y: Math.max(0, Math.min(n - 1, cTileY)),
      z: tileZ,
    }];
  }

  // ═══ 步骤 3：枚举 + 按距中心排序 + 截断 ═══
  const centerTileX = cx / tileSizePx;
  const centerTileY = cy / tileSizePx;

  const tiles: TileCoord[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      tiles.push({ x: tx, y: ty, z: tileZ });
    }
  }

  // 按距离相机中心排序（优先加载靠近中心的瓦片，利于 early-Z 与用户感知）
  tiles.sort((a, b) => {
    const da = (a.x + 0.5 - centerTileX) ** 2 + (a.y + 0.5 - centerTileY) ** 2;
    const db = (b.x + 0.5 - centerTileX) ** 2 + (b.y + 0.5 - centerTileY) ** 2;
    return da - db;
  });

  // 瓦片数上限
  if (tiles.length > MAX_COVERING_TILES) {
    tiles.length = MAX_COVERING_TILES;
  }

  return tiles;
}

/**
 * Intersection over Union（IoU）——衡量两个 AABB 的重叠程度。
 * 1 = 完全重叠，0 = 无交集。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 *
 * @param a - [minX, minY, maxX, maxY]
 * @param b - [minX, minY, maxX, maxY]
 * @returns IoU ∈ [0, 1]
 */
function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 从连续 zoom 的相机 + 画布尺寸推算世界像素级视口 AABB。
 *
 * @param camera - 当前相机状态
 * @param canvasW - CSS 画布宽度
 * @param canvasH - CSS 画布高度
 * @returns [minX, minY, maxX, maxY] 世界像素坐标
 */
function computeViewBBox(
  camera: CameraState,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] {
  const worldSize = TILE_PIXEL_SIZE * Math.pow(2, camera.zoom);
  const [cx, cy] = lngLatToWorldPixel(camera.center[0], camera.center[1], worldSize);

  const invVP = camera.inverseVPMatrix;

  // 相机在 camera-relative 坐标系中的位置（horizon fallback 用）
  // 直接从 pitch/bearing 推导，避免 camera.position（Mercator 米制）与世界像素混用
  const tanHalfFov = Math.tan(camera.fov / 2);
  const cameraToCenterDist = (tanHalfFov > 1e-10)
    ? canvasH / 2 / tanHalfFov
    : canvasH * 10;
  const maxDist = cameraToCenterDist * 3;
  const altPixels = cameraToCenterDist;
  const offsetBack = Math.sin(camera.pitch) * altPixels;
  const camRelX = -Math.sin(camera.bearing) * offsetBack;
  const camRelY = Math.cos(camera.bearing) * offsetBack;

  // 采样 4 角 + 4 边中点 + 中心 = 9 点（IoU 节流用，不必像 coveringTiles 那样密）
  const pts: [number, number][] = [
    [0, 0], [canvasW, 0], [0, canvasH], [canvasW, canvasH],
    [canvasW / 2, 0], [canvasW / 2, canvasH],
    [0, canvasH / 2], [canvasW, canvasH / 2],
    [canvasW / 2, canvasH / 2],
  ];

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    let rel = screenToGroundRel(pts[i][0], pts[i][1], invVP, canvasW, canvasH);
    if (rel === null) {
      rel = screenToHorizonRel(pts[i][0], pts[i][1], invVP, canvasW, canvasH, camRelX, camRelY, maxDist);
    }
    // camera-relative → absolute
    const ax = rel[0] + cx;
    const ay = rel[1] + cy;
    if (ax < minX) { minX = ax; }
    if (ay < minY) { minY = ay; }
    if (ax > maxX) { maxX = ax; }
    if (ay > maxY) { maxY = ay; }
  }

  return [minX, minY, maxX, maxY];
}

/**
 * zoom-out 子瓦片逐格拼合——不再要求 4 个子瓦片全部就绪。
 * 每个子格独立判定：子瓦片就绪→直接渲染；子瓦片缺失→用最近祖先 UV 子区域填充。
 * 只要至少有一个子格可渲染就返回列表；全部无可渲染数据时返回 null。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 *
 * @param tile - 需要的父级瓦片坐标
 * @param cache - 瓦片缓存
 * @param maxSourceZoom - 数据源允许的最大 z
 * @returns 1~4 条可见项，或全部无数据时 null
 */
function resolveChildrenOrAncestors(
  tile: TileCoord,
  cache: TileCache,
  maxSourceZoom: number,
): VisibleTile[] | null {
  if (tile.z >= maxSourceZoom) {
    return null;
  }
  const cz = tile.z + 1;
  const x0 = tile.x * 2;
  const y0 = tile.y * 2;
  const children: TileCoord[] = [
    { z: cz, x: x0,     y: y0 },
    { z: cz, x: x0 + 1, y: y0 },
    { z: cz, x: x0,     y: y0 + 1 },
    { z: cz, x: x0 + 1, y: y0 + 1 },
  ];

  const out: VisibleTile[] = [];
  let anyResolved = false;

  for (const child of children) {
    const ck = tileKey(child.z, child.x, child.y);
    const ce = cache.get(ck);

    if (ce !== undefined && ce.state === 'ready' && ce.texture !== null) {
      // 子瓦片就绪——直接用全 UV
      out.push({ targetCoord: child, entry: ce, uvOffset: [0, 0], uvScale: [1, 1] });
      anyResolved = true;
    } else {
      // 子瓦片缺失——查找该子格位置的最近祖先 UV 子区域
      const anc = findAncestor(child, cache);
      if (anc !== null) {
        out.push(anc);
        anyResolved = true;
      }
      // 若连祖先也无（仅在 z=0 瓦片未加载的极短冷启动窗口出现），该子格暂无纹理
    }
  }

  return anyResolved ? out : null;
}

/**
 * 完整可见性仲裁——方案一核心实现。
 *
 * 对每个需要的瓦片按以下优先级选取最佳渲染纹理：
 *   ① 当前 zoom 瓦片已就绪 → 全 UV 直接渲染
 *   ② zoom-out 子瓦片逐格拼合（就绪子格直接渲染 + 缺失子格用祖先 UV 子区域）
 *   ③ 祖先瓦片 UV 子区域（zoom-in / 子瓦片也无数据时的最终兜底）
 *
 * @param needed - 需要的瓦片列表
 * @param cache - 瓦片缓存
 * @param maxSourceZoom - 数据源 maxzoom
 * @returns 可渲染的可见瓦片列表
 */
function resolveVisibleTiles(
  needed: TileCoord[],
  cache: TileCache,
  maxSourceZoom: number,
): VisibleTile[] {
  const result: VisibleTile[] = [];

  for (const tile of needed) {
    const key = tileKey(tile.z, tile.x, tile.y);
    const entry = cache.get(key);

    // ① 当前 zoom 瓦片已就绪
    if (entry !== undefined && entry.state === 'ready' && entry.texture !== null) {
      result.push({
        targetCoord: tile,
        entry,
        uvOffset: [0, 0],
        uvScale: [1, 1],
      });
      continue;
    }

    // ② zoom-out 子瓦片逐格拼合（部分子格可用也返回结果）
    const composite = resolveChildrenOrAncestors(tile, cache, maxSourceZoom);
    if (composite !== null) {
      result.push(...composite);
      continue;
    }

    // ③ 祖先占位（zoom-in / 子瓦片和子祖先全部不可用时的终极兜底）
    const ancestor = findAncestor(tile, cache);
    if (ancestor !== null) {
      result.push(ancestor);
    }
    // 无可用纹理 → 该位置显示背景色（冷启动极短时间内可能发生）
  }

  return result;
}

/**
 * 在缓存中搜索最近的就绪祖先瓦片，计算 UV 子区域。
 *
 * @param tile - 目标瓦片坐标
 * @param cache - 瓦片缓存
 * @returns 祖先可见瓦片描述，或 null
 */
function findAncestor(tile: TileCoord, cache: TileCache): VisibleTile | null {
  const maxDepth = Math.min(tile.z, MAX_ANCESTOR_SEARCH_DEPTH);
  for (let dz = 1; dz <= maxDepth; dz++) {
    const pz = tile.z - dz;
    // 父瓦片坐标：右移 dz 位
    const px = tile.x >> dz;
    const py = tile.y >> dz;
    const parentKey = tileKey(pz, px, py);
    const parent = cache.get(parentKey);
    if (parent !== undefined && parent.state === 'ready' && parent.texture !== null) {
      // 计算 UV 子区域：当前瓦片在祖先瓦片中的位置
      const n = 1 << dz;
      const sx = tile.x - (px << dz);
      const sy = tile.y - (py << dz);
      return {
        targetCoord: tile,
        entry: parent,
        uvOffset: [sx / n, sy / n],
        uvScale: [1 / n, 1 / n],
      };
    }
  }
  return null;
}

/**
 * 错误分类：区分临时可重试错误和永久错误。
 *
 * @param err - 捕获的错误
 * @returns 错误类别
 */
function classifyError(err: unknown): 'transient' | 'permanent' | 'ignore' {
  if (err instanceof Error) {
    // AbortError = 请求被取消，忽略
    if (err.name === 'AbortError') {
      return 'ignore';
    }
    // TypeError 通常是网络/CORS 错误，可重试
    if (err.name === 'TypeError') {
      return 'transient';
    }
  }
  // HTTP 状态码分类
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: number }).status;
    // 404 / 204 = 瓦片永久缺失
    if (status === 404 || status === 204) {
      return 'permanent';
    }
    // 5xx = 服务端临时错误，可重试
    if (status >= 500) {
      return 'transient';
    }
    // 4xx (非 404) = 永久错误（权限/参数问题）
    if (status >= 400) {
      return 'permanent';
    }
  }
  return 'transient';
}

// ---------------------------------------------------------------------------
// Overzoom 纯函数
// ---------------------------------------------------------------------------

/**
 * 校验并返回规范化后的 overzoom 配置。不修改输入对象。
 * 修复 Leaflet #3004（maxNativeZoom=0 作为 falsy 被忽略）和
 * Leaflet #5644（min > max 自动交换）等边界情况。
 *
 * @param source - 数据源 zoom 范围
 * @param config - 用户 overzoom 配置（可能含非法值）
 * @returns 规范化后的 { source, config }
 *
 * @example
 * normalizeOverzoomConfig(
 *   { minNativeZoom: 0, maxNativeZoom: 18 },
 *   { overzoomStrategy: 'scale', maxOverzoom: 6, maxUnderzoom: 0 },
 * );
 * // → { source: { minNativeZoom: 0, maxNativeZoom: 18 },
 * //     config: { overzoomStrategy: 'scale', maxOverzoom: 6, maxUnderzoom: 0 } }
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
function normalizeOverzoomConfig(
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): { source: TileSourceZoomRange; config: OverzoomConfig } {
  let minZ = source.minNativeZoom;
  let maxZ = source.maxNativeZoom;

  // Leaflet #3004：用 typeof 检查而非 truthiness（maxNativeZoom=0 是合法值）
  if (typeof minZ !== 'number' || isNaN(minZ)) { minZ = 0; }
  if (typeof maxZ !== 'number' || isNaN(maxZ)) { maxZ = DEFAULT_MAX_ZOOM; }

  // Leaflet #5644：min > max 自动交换
  if (minZ > maxZ) {
    const tmp = minZ;
    minZ = maxZ;
    maxZ = tmp;
  }

  // MapLibre #4055：zoom 安全上限——clamp 到 MAX_DISPLAY_ZOOM_CAP
  let maxOZ = config.maxOverzoom;
  if (!Number.isFinite(maxOZ)) {
    maxOZ = Math.max(0, MAX_DISPLAY_ZOOM_CAP - maxZ);
  }
  maxOZ = Math.max(0, Math.floor(maxOZ));

  let maxUZ = config.maxUnderzoom;
  if (!Number.isFinite(maxUZ)) { maxUZ = 0; }
  maxUZ = Math.max(0, Math.floor(maxUZ));

  return {
    source: { minNativeZoom: minZ, maxNativeZoom: maxZ },
    config: {
      overzoomStrategy: config.overzoomStrategy,
      maxOverzoom: maxOZ,
      maxUnderzoom: maxUZ,
    },
  };
}

/**
 * 构建无 UV 偏移的 ResolvedTile（display 和 request 是同一瓦片或 underzoom 全瓦片渲染）。
 *
 * @param dz - display zoom
 * @param dx - display 列号
 * @param dy - display 行号
 * @param rz - request zoom
 * @param rx - request 列号
 * @param ry - request 行号
 * @returns ResolvedTile，uvOffset=[0,0]，uvScale=[1,1]
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
function makeResolvedTile(
  dz: number, dx: number, dy: number,
  rz: number, rx: number, ry: number,
): ResolvedTile {
  return {
    displayZ: dz, displayX: dx, displayY: dy,
    displayKey: `${dz}/${dx}/${dy}`,
    requestZ: rz, requestX: rx, requestY: ry,
    requestKey: `${rz}/${rx}/${ry}`,
    uvOffset: [0, 0],
    uvScale: [1, 1],
    isOverzoomed: dz !== rz,
    overzoomLevels: Math.abs(dz - rz),
  };
}

/**
 * 构建带 UV 子区域的 ResolvedTile（overzoom 专用）。
 * 当 displayZ > maxNativeZoom 时，从 requestZ 级别的瓦片中取 1/(2^shift) 的子区域。
 *
 * UV 计算原理：
 *   shift = displayZ - requestZ
 *   n = 2^shift（一个 request 瓦片包含 n×n 个 display 瓦片）
 *   subX = displayX - (requestX << shift)（display 瓦片在 request 瓦片中的列偏移）
 *   subY = displayY - (requestY << shift)（display 瓦片在 request 瓦片中的行偏移）
 *   uvOffset = [subX/n, subY/n]，uvScale = [1/n, 1/n]
 *
 * @param dz - display zoom
 * @param dx - display 列号
 * @param dy - display 行号
 * @param rz - request zoom
 * @param rx - request 列号
 * @param ry - request 行号
 * @param shift - zoom 级差 = dz - rz
 * @returns ResolvedTile 含 UV 子区域
 *
 * @example
 * // source.maxNativeZoom=14, display z=18, x=200003, y=150001
 * // shift=4, n=16, subX=3, subY=1
 * // uvOffset=[3/16, 1/16], uvScale=[1/16, 1/16]
 * makeResolvedTileWithUV(18, 200003, 150001, 14, 12500, 9375, 4);
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
function makeResolvedTileWithUV(
  dz: number, dx: number, dy: number,
  rz: number, rx: number, ry: number,
  shift: number,
): ResolvedTile {
  // n = 一个 request 瓦片在 display zoom 下被分成 n×n 格
  const n = 1 << shift;
  // display 瓦片在 request 瓦片内部的 x/y 偏移
  const subX = dx - (rx << shift);
  const subY = dy - (ry << shift);
  return {
    displayZ: dz, displayX: dx, displayY: dy,
    displayKey: `${dz}/${dx}/${dy}`,
    requestZ: rz, requestX: rx, requestY: ry,
    requestKey: `${rz}/${rx}/${ry}`,
    uvOffset: [subX / n, subY / n],
    uvScale: [1 / n, 1 / n],
    isOverzoomed: true,
    overzoomLevels: shift,
  };
}

/**
 * 将"显示需要的瓦片"转换为"实际请求的瓦片 + UV 映射"。
 * 纯函数，无副作用。
 *
 * 三种情况：
 *   1. 正常范围（minZ ≤ displayZ ≤ maxZ）→ 直接请求 display 坐标
 *   2. Overzoom（displayZ > maxZ）→ 请求 maxZ 瓦片，UV 取子区域
 *   3. Underzoom（displayZ < minZ）→ 请求 minZ 瓦片中心对齐，UV 全部
 *
 * @param displayZ - 显示需要的 zoom
 * @param displayX - 显示需要的列号
 * @param displayY - 显示需要的行号
 * @param source - 数据源 zoom 范围（已规范化）
 * @param config - overzoom 配置（已规范化）
 * @returns ResolvedTile 或 null（策略为 none/transparent 或超出允许范围）
 *
 * @example
 * // Overzoom: source.maxNativeZoom=14, display z=18
 * resolveTile(18, 200003, 150001, { minNativeZoom:0, maxNativeZoom:14 },
 *   { overzoomStrategy:'scale', maxOverzoom:6, maxUnderzoom:0 });
 * // → { requestZ:14, requestX:12500, requestY:9375,
 * //     uvOffset:[0.1875, 0.0625], uvScale:[0.0625, 0.0625] }
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
function resolveTile(
  displayZ: number, displayX: number, displayY: number,
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): ResolvedTile | null {
  const { minNativeZoom: minZ, maxNativeZoom: maxZ } = source;

  // ═══ 正常范围：直接请求，无 UV 偏移 ═══
  if (displayZ >= minZ && displayZ <= maxZ) {
    return makeResolvedTile(displayZ, displayX, displayY, displayZ, displayX, displayY);
  }

  // ═══ Overzoom（displayZ > maxZ）═══
  if (displayZ > maxZ) {
    // 策略为 none 或 transparent 时不做 overzoom
    if (config.overzoomStrategy === 'none' || config.overzoomStrategy === 'transparent') {
      return null;
    }
    const levels = displayZ - maxZ;
    // 超出允许的最大 overzoom 级数
    if (levels > config.maxOverzoom) {
      return null;
    }

    // 计算 request 坐标：右移 shift 位将 display 坐标映射到 maxZ 级别
    const shift = levels;
    const rz = maxZ;
    const rx = displayX >> shift;
    const ry = displayY >> shift;
    return makeResolvedTileWithUV(displayZ, displayX, displayY, rz, rx, ry, shift);
  }

  // ═══ Underzoom（displayZ < minZ）═══
  if (displayZ < minZ) {
    const levels = minZ - displayZ;
    if (levels > config.maxUnderzoom) {
      return null;
    }

    // Underzoom：请求 minZ 级别的瓦片，但只渲染覆盖 display 范围的那一块。
    // 一个 displayZ 瓦片 = minZ 级别中多个瓦片的合并区域。
    // 简化处理：请求 display 区域中心对应的 minZ 瓦片，UV 渲染该瓦片的全部。
    // 效果：display 瓦片显示的是 minZ 瓦片缩小后的样子。
    const shift = levels;
    const rz = minZ;
    // display(z=3, x=2, y=1) 对应 minZ(z=5) 中 x=8..11, y=4..7 的区域
    // 请求中心瓦片 (8+11)/2=9, (4+7)/2=5
    const centerX = (displayX << shift) + ((1 << shift) >> 1);
    const centerY = (displayY << shift) + ((1 << shift) >> 1);
    // clamp 到合法坐标范围
    const rx = Math.min(centerX, (1 << rz) - 1);
    const ry = Math.min(centerY, (1 << rz) - 1);
    // UV 保持完整（整个瓦片渲染，由顶点缩放来适配 display 位置）
    return makeResolvedTile(displayZ, displayX, displayY, rz, rx, ry);
  }

  return null;
}

/**
 * 计算视口覆盖瓦片并应用 overzoom 映射——方案一的集成入口。
 * 先按 displayZoom 计算覆盖瓦片，再逐个通过 resolveTile 映射到 requestKey + UV。
 *
 * @param camera - 相机状态
 * @param canvasWidth - 画布宽度
 * @param canvasHeight - 画布高度
 * @param minZoom - 图层最小可见 zoom
 * @param maxDisplayZoom - 允许的最大显示 zoom（= maxNativeZoom + maxOverzoom）
 * @param source - 数据源 zoom 范围（已规范化）
 * @param config - overzoom 配置（已规范化）
 * @returns 去重后的 ResolvedTile[]（按 displayKey 去重）
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §一
 */
function coveringTilesWithOverzoom(
  camera: CameraState,
  canvasWidth: number,
  canvasHeight: number,
  minZoom: number,
  maxDisplayZoom: number,
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): ResolvedTile[] {
  // 计算 display zoom 下的覆盖瓦片（允许超过 maxNativeZoom）
  const displayTiles = computeCoveringTiles(camera, canvasWidth, canvasHeight, minZoom, maxDisplayZoom);
  const resolved: ResolvedTile[] = [];
  // 按 displayKey 去重——同一个显示位置不重复
  const seen = new Set<string>();

  for (const dt of displayTiles) {
    const r = resolveTile(dt.z, dt.x, dt.y, source, config);
    if (r === null) { continue; }
    if (seen.has(r.displayKey)) { continue; }
    seen.add(r.displayKey);
    resolved.push(r);
  }

  return resolved;
}

/**
 * 计算图层的 zoom-based alpha（用于多图层平滑切换）。
 * 在 fadeIn / fadeOut 范围内线性插值，范围外为 0 或 1。
 *
 * @param zoom - 当前相机 zoom
 * @param fadeIn - fade-in 范围 { start, end }（zoom < start → 0，zoom > end → 1）
 * @param fadeOut - fade-out 范围 { start, end }（zoom < start → 1，zoom > end → 0）
 * @returns alpha ∈ [0, 1]
 *
 * @example
 * // 位图→矢量切换：位图 fade out at 13.5~14，矢量 fade in at 14~14.5
 * computeLayerAlpha(13.7, undefined, { start: 13.5, end: 14 }); // → 0.4
 * computeLayerAlpha(14.2, { start: 14, end: 14.5 }, undefined); // → 0.4
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §四
 */
function computeLayerAlpha(
  zoom: number,
  fadeIn?: { start: number; end: number },
  fadeOut?: { start: number; end: number },
): number {
  let a = 1;

  if (fadeIn !== undefined) {
    if (zoom < fadeIn.start) { return 0; }
    if (zoom < fadeIn.end) {
      // 线性插值：start→0, end→1
      const range = fadeIn.end - fadeIn.start;
      a = range > 0 ? (zoom - fadeIn.start) / range : 1;
    }
  }

  if (fadeOut !== undefined) {
    if (zoom > fadeOut.end) { return 0; }
    if (zoom > fadeOut.start) {
      // 线性插值：start→1, end→0
      const range = fadeOut.end - fadeOut.start;
      const fadeOutAlpha = range > 0 ? 1 - (zoom - fadeOut.start) / range : 0;
      a *= fadeOutAlpha;
    }
  }

  return a;
}

/**
 * 从 ResolvedTile[] 构建 VisibleTile[]——统一 overzoom UV 子区域与
 * Tile Solutions §方案一的父瓦片占位/子瓦片拼合机制。
 *
 * 优先级：
 *   ① request 瓦片已缓存就绪 → 使用 resolved 的 UV 子区域渲染
 *   ② 非 overzoom 模式下尝试 zoom-out 子瓦片逐格拼合（已有子瓦片 + 缺失子格用祖先）
 *   ③ 在缓存中搜索 display 坐标的最近祖先（兜底）
 *
 * @param resolved - resolveTile 映射后的 ResolvedTile 列表
 * @param cache - 瓦片缓存
 * @param maxSourceZoom - 数据源最大原生 zoom（用于限制子瓦片拼合搜索深度）
 * @returns 可渲染的 VisibleTile 列表
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §五
 */
function resolveVisibleTilesFromResolved(
  resolved: ResolvedTile[],
  cache: TileCache,
  maxSourceZoom: number,
): VisibleTile[] {
  const result: VisibleTile[] = [];

  for (const r of resolved) {
    // ① request 瓦片已缓存就绪——直接用 resolved 的 UV 子区域
    const entry = cache.get(r.requestKey);
    if (entry !== undefined && entry.state === 'ready' && entry.texture !== null) {
      result.push({
        targetCoord: { z: r.displayZ, x: r.displayX, y: r.displayY },
        entry,
        uvOffset: r.uvOffset,
        uvScale: r.uvScale,
      });
      continue;
    }

    // ② 非 overzoom 时尝试子瓦片逐格拼合（zoom-out 场景：父格缺失但子格可用）
    if (!r.isOverzoomed) {
      const composite = resolveChildrenOrAncestors(
        { z: r.displayZ, x: r.displayX, y: r.displayY },
        cache,
        maxSourceZoom,
      );
      if (composite !== null) {
        result.push(...composite);
        continue;
      }
    }

    // ③ 在缓存中搜索 display 坐标的最近祖先（兜底——overzoom 时也能找到 maxNativeZoom 瓦片）
    // 注意：对于 overzoom 场景（如 display z=20, request z=18），如果 z=18 瓦片未缓存，
    // findAncestor 从 z=19 向下搜索会依次经过 z=18（即 request 瓦片），自然覆盖 overzoom。
    const ancestor = findAncestor(
      { z: r.displayZ, x: r.displayX, y: r.displayY },
      cache,
    );
    if (ancestor !== null) {
      result.push(ancestor);
    }
    // 无可用纹理 → 该位置显示背景色（仅在冷启动极短窗口可能发生）
  }

  return result;
}

// ---------------------------------------------------------------------------
// 矢量瓦片 Overzoom 几何裁剪
// ---------------------------------------------------------------------------

/**
 * 从父矢量瓦片裁剪出子瓦片范围的特征。
 * 坐标归一化到 [0, 1] 范围（子瓦片内部坐标）。
 *
 * 使用场景：矢量瓦片 overzoom 时，从低 zoom 的父瓦片中裁剪出高 zoom 子区域的特征，
 * 避免重新请求或丢失精度。
 *
 * @param features - 父瓦片中的矢量特征数组
 * @param parentZ - 父瓦片 zoom
 * @param parentX - 父瓦片列号
 * @param parentY - 父瓦片行号
 * @param childZ - 子瓦片 zoom（display zoom）
 * @param childX - 子瓦片列号
 * @param childY - 子瓦片行号
 * @returns 裁剪后的特征数组（坐标已归一化到子瓦片 [0,1] 范围）
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
function clipVectorTileForOverzoom(
  features: VectorFeature[],
  parentZ: number, parentX: number, parentY: number,
  childZ: number, childX: number, childY: number,
): VectorFeature[] {
  const shift = childZ - parentZ;
  // 子瓦片数量 per 轴
  const n = 1 << shift;
  // 子瓦片在父瓦片中的偏移
  const subX = childX - (parentX << shift);
  const subY = childY - (parentY << shift);
  // 裁剪窗口（父瓦片归一化坐标 [0,1]）
  const cMinX = subX / n;
  const cMinY = subY / n;
  const cMaxX = (subX + 1) / n;
  const cMaxY = (subY + 1) / n;
  // 子区域宽高（用于归一化到子瓦片坐标）
  const cW = cMaxX - cMinX;
  const cH = cMaxY - cMinY;

  const result: VectorFeature[] = [];

  for (const f of features) {
    const clipped = clipFeature(f, cMinX, cMinY, cMaxX, cMaxY, cW, cH);
    if (clipped !== null) {
      result.push(clipped);
    }
  }

  return result;
}

/**
 * 裁剪单个矢量特征到指定矩形范围，并归一化坐标。
 *
 * @param f - 输入特征
 * @param minX - 裁剪窗口左边界（父瓦片归一化坐标）
 * @param minY - 裁剪窗口上边界
 * @param maxX - 裁剪窗口右边界
 * @param maxY - 裁剪窗口下边界
 * @param w - 裁剪窗口宽度（用于归一化）
 * @param h - 裁剪窗口高度（用于归一化）
 * @returns 裁剪后的特征或 null（特征完全在窗口外）
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
function clipFeature(
  f: VectorFeature,
  minX: number, minY: number, maxX: number, maxY: number,
  w: number, h: number,
): VectorFeature | null {
  const { type, geometry } = f;

  if (type === 'Point') {
    // 点裁剪：简单边界检查
    if (geometry.length === 0) { return null; }
    const [x, y] = geometry[0];
    if (x < minX || x > maxX || y < minY || y > maxY) { return null; }
    // 归一化到子瓦片 [0,1] 坐标
    return { ...f, geometry: [[(x - minX) / w, (y - minY) / h]] };
  }

  if (type === 'LineString') {
    // 折线裁剪：Cohen-Sutherland 逐段裁剪保持连续性
    const clipped = clipPolyline(geometry, minX, minY, maxX, maxY);
    if (clipped.length < 2) { return null; }
    // 归一化坐标
    const norm = clipped.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return { ...f, geometry: norm };
  }

  if (type === 'Polygon') {
    // 多边形裁剪：Sutherland-Hodgman 四边依次裁剪
    let ring = [...geometry];
    ring = clipRingByEdge(ring, minX, 'left');
    ring = clipRingByEdge(ring, maxX, 'right');
    ring = clipRingByEdge(ring, minY, 'bottom');
    ring = clipRingByEdge(ring, maxY, 'top');
    if (ring.length < 3) { return null; }
    // 归一化坐标
    const norm = ring.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return { ...f, geometry: norm };
  }

  return null;
}

/**
 * Cohen-Sutherland 折线裁剪——保持输出折线的连续性。
 * 与简单的逐段裁剪不同，此实现合并连续的已裁剪段。
 *
 * @param line - 输入折线坐标数组
 * @param minX - 裁剪窗口左边界
 * @param minY - 裁剪窗口上边界
 * @param maxX - 裁剪窗口右边界
 * @param maxY - 裁剪窗口下边界
 * @returns 裁剪后的连续折线坐标数组
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
function clipPolyline(
  line: number[][], minX: number, minY: number, maxX: number, maxY: number,
): number[][] {
  const result: number[][] = [];

  for (let i = 0; i < line.length - 1; i++) {
    const seg = clipOneSegment(
      line[i][0], line[i][1], line[i + 1][0], line[i + 1][1],
      minX, minY, maxX, maxY,
    );
    if (seg === null) {
      // 线段完全在窗口外 → 断开连续性
      continue;
    }
    const [ax, ay, bx, by] = seg;
    if (result.length === 0) {
      // 第一个有效段——push 起点
      result.push([ax, ay]);
    } else {
      // 检查是否与上一个端点连续
      const last = result[result.length - 1];
      if (
        Math.abs(last[0] - ax) > CLIP_CONTINUITY_EPSILON ||
        Math.abs(last[1] - ay) > CLIP_CONTINUITY_EPSILON
      ) {
        // 不连续 → push 当前段起点（裁剪后折线本身可能断开）
        result.push([ax, ay]);
      }
    }
    result.push([bx, by]);
  }

  return result;
}

/**
 * Cohen-Sutherland 单线段裁剪。
 * 修复 v1 的 `code0 || code1` bug（改为 `c0 !== 0 ? c0 : c1`）。
 *
 * @param x0 - 线段起点 X
 * @param y0 - 线段起点 Y
 * @param x1 - 线段终点 X
 * @param y1 - 线段终点 Y
 * @param minX - 裁剪窗口左边界
 * @param minY - 裁剪窗口上边界
 * @param maxX - 裁剪窗口右边界
 * @param maxY - 裁剪窗口下边界
 * @returns [裁剪后 x0, y0, x1, y1] 或 null（完全在窗口外）
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
function clipOneSegment(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): [number, number, number, number] | null {
  let c0 = regionCode(x0, y0, minX, minY, maxX, maxY);
  let c1 = regionCode(x1, y1, minX, minY, maxX, maxY);

  for (let iter = 0; iter < CLIP_MAX_ITERATIONS; iter++) {
    // 两点都在窗口内 → 完全接受
    if (!(c0 | c1)) { return [x0, y0, x1, y1]; }
    // 两点在窗口同一侧 → 完全拒绝
    if (c0 & c1) { return null; }

    // 选择在窗口外部的点（修复 v1 的 || bug）
    const c = c0 !== 0 ? c0 : c1;
    let x: number;
    let y: number;

    // 按优先级裁剪到窗口边界
    if (c & 8) {
      // 上方（y > maxY）
      x = x0 + (x1 - x0) * (maxY - y0) / (y1 - y0);
      y = maxY;
    } else if (c & 4) {
      // 下方（y < minY）
      x = x0 + (x1 - x0) * (minY - y0) / (y1 - y0);
      y = minY;
    } else if (c & 2) {
      // 右方（x > maxX）
      y = y0 + (y1 - y0) * (maxX - x0) / (x1 - x0);
      x = maxX;
    } else {
      // 左方（x < minX）
      y = y0 + (y1 - y0) * (minX - x0) / (x1 - x0);
      x = minX;
    }

    // 更新被裁剪的点
    if (c === c0) {
      x0 = x; y0 = y;
      c0 = regionCode(x0, y0, minX, minY, maxX, maxY);
    } else {
      x1 = x; y1 = y;
      c1 = regionCode(x1, y1, minX, minY, maxX, maxY);
    }
  }

  // 超过最大迭代次数（极端退化情况）→ 安全拒绝
  return null;
}

/**
 * Cohen-Sutherland 区域码：4 位标记点相对裁剪窗口的位置。
 * bit 0 (1): 左方, bit 1 (2): 右方, bit 2 (4): 下方, bit 3 (8): 上方。
 *
 * @param x - 点 X 坐标
 * @param y - 点 Y 坐标
 * @param minX - 窗口左边界
 * @param minY - 窗口下边界
 * @param maxX - 窗口右边界
 * @param maxY - 窗口上边界
 * @returns 4 位区域码
 */
function regionCode(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): number {
  return (x < minX ? 1 : 0) | (x > maxX ? 2 : 0) | (y < minY ? 4 : 0) | (y > maxY ? 8 : 0);
}

/**
 * Sutherland-Hodgman 单边裁剪——将多边形环裁剪到指定边界。
 * 四次调用（left/right/bottom/top）完成矩形裁剪。
 *
 * @param ring - 输入多边形环（坐标数组，最后一点不必等于第一点，算法自动闭合）
 * @param value - 裁剪边界值
 * @param edge - 裁剪方向：'left'/'right'/'bottom'/'top'
 * @returns 裁剪后的多边形环
 *
 * @see doc/architecture/GeoForge_Tile_Overzoom_Solutions.md §三
 */
function clipRingByEdge(ring: number[][], value: number, edge: 'left' | 'right' | 'top' | 'bottom'): number[][] {
  if (ring.length === 0) { return ring; }
  const out: number[][] = [];
  const n = ring.length;

  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const cIn = ptInside(curr, value, edge);
    const nIn = ptInside(next, value, edge);

    if (cIn && nIn) {
      // 两点都在内部 → 输出 next
      out.push(next);
    } else if (cIn && !nIn) {
      // 从内到外 → 输出交点
      out.push(edgeIntersect(curr, next, value, edge));
    } else if (!cIn && nIn) {
      // 从外到内 → 输出交点和 next
      out.push(edgeIntersect(curr, next, value, edge));
      out.push(next);
    }
    // 两点都在外部 → 不输出
  }

  return out;
}

/**
 * 判断点是否在裁剪边界内部。
 *
 * @param p - 点坐标 [x, y]
 * @param val - 边界值
 * @param edge - 边界方向
 * @returns 是否在内部
 */
function ptInside(p: number[], val: number, edge: string): boolean {
  if (edge === 'left') { return p[0] >= val; }
  if (edge === 'right') { return p[0] <= val; }
  if (edge === 'bottom') { return p[1] >= val; }
  // top
  return p[1] <= val;
}

/**
 * 计算线段与裁剪边界的交点。
 *
 * @param a - 线段起点 [x, y]
 * @param b - 线段终点 [x, y]
 * @param val - 边界值
 * @param edge - 边界方向
 * @returns 交点 [x, y]
 */
function edgeIntersect(a: number[], b: number[], val: number, edge: string): number[] {
  if (edge === 'left' || edge === 'right') {
    // 垂直边界：x = val，插值 y
    const dx = b[0] - a[0];
    // 防除零（两点 x 相同时 t 无意义，但此情况不应出现因为一内一外）
    const t = dx !== 0 ? (val - a[0]) / dx : 0;
    return [val, a[1] + t * (b[1] - a[1])];
  }
  // 水平边界：y = val，插值 x
  const dy = b[1] - a[1];
  const t = dy !== 0 ? (val - a[1]) / dy : 0;
  return [a[0] + t * (b[0] - a[0]), val];
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 RasterTileLayerOptions。
 *
 * @param opts - 原始选项
 * @returns 规范化后的选项（带默认值）
 */
function validateOptions(opts: RasterTileLayerOptions): {
  id: string; source: string; tiles: string[];
  tileSize: number; opacity: number; minzoom: number;
  maxzoom: number; fadeDuration: number; projection: string;
  minNativeZoom: number; maxNativeZoom: number;
  overzoom: OverzoomConfig;
  fadeInZoom?: { start: number; end: number };
  fadeOutZoom?: { start: number; end: number };
  paint?: Record<string, unknown>; layout?: Record<string, unknown>;
} {
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] id must be a non-empty string`);
  }
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] source must be a non-empty string`);
  }
  const tileSize = opts.tileSize ?? DEFAULT_TILE_SIZE;
  if (!Number.isFinite(tileSize) || tileSize <= 0 || Math.floor(tileSize) !== tileSize) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] tileSize must be a positive integer`);
  }
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1]`);
  }
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  const fadeDuration = opts.fadeDuration ?? DEFAULT_FADE_DURATION_MS;
  if (!Number.isFinite(fadeDuration) || fadeDuration < 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0`);
  }
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';
  const tiles = opts.tiles ?? [];

  // ── Overzoom 配置解析 ──
  // minNativeZoom / maxNativeZoom 默认与 minzoom / maxzoom 一致
  const rawMinNative = opts.minNativeZoom ?? minzoom;
  const rawMaxNative = opts.maxNativeZoom ?? maxzoom;
  // 合并用户 overzoom 配置与默认值
  const rawOZ = opts.overzoom ?? {};
  const mergedOZ: OverzoomConfig = {
    overzoomStrategy: rawOZ.overzoomStrategy ?? DEFAULT_RASTER_OVERZOOM_STRATEGY,
    maxOverzoom: rawOZ.maxOverzoom ?? DEFAULT_RASTER_MAX_OVERZOOM,
    maxUnderzoom: rawOZ.maxUnderzoom ?? DEFAULT_RASTER_MAX_UNDERZOOM,
  };
  // 用 normalizeOverzoomConfig 校验边界并规范化
  const normalized = normalizeOverzoomConfig(
    { minNativeZoom: rawMinNative, maxNativeZoom: rawMaxNative },
    mergedOZ,
  );

  return {
    id: opts.id.trim(), source: opts.source.trim(), tiles,
    tileSize, opacity, minzoom, maxzoom, fadeDuration, projection,
    minNativeZoom: normalized.source.minNativeZoom,
    maxNativeZoom: normalized.source.maxNativeZoom,
    overzoom: normalized.config,
    fadeInZoom: opts.fadeInZoom,
    fadeOutZoom: opts.fadeOutZoom,
    paint: opts.paint, layout: opts.layout,
  };
}

/**
 * 从 paint 属性表解析样式 Uniform 初始值。
 *
 * @param paint - 用户 paint 属性
 * @param baseOpacity - 图层级不透明度
 * @returns 样式 Uniform 数据
 */
function parseStyleUniforms(paint: Record<string, unknown> | undefined, baseOpacity: number): StyleUniformData {
  const readNum = (key: string, fallback: number): number => {
    if (paint === undefined || paint === null) { return fallback; }
    const v = paint[key];
    return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
  };
  return {
    brightness: readNum('raster-brightness-min', 0),
    contrast: readNum('raster-contrast', 0),
    saturation: readNum('raster-saturation', 0),
    hueRotate: readNum('raster-hue-rotate', 0) * DEG_TO_RAD,
    opacity: readNum('raster-opacity', baseOpacity),
  };
}

// ---------------------------------------------------------------------------
// createRasterTileLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建栅格瓦片图层完整实例。
 * 包含 O(1) LRU 缓存、请求调度、父瓦片占位、相机相对坐标、
 * WebGPU 管线创建和 encode() 完整绘制实现。
 *
 * @param opts - 构造选项
 * @returns 完整 RasterTileLayer 实例
 *
 * @stability experimental
 *
 * @example
 * const layer = createRasterTileLayer({
 *   id: 'osm', source: 'osm-tiles',
 *   tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
 *   tileSize: 256,
 * });
 */
export function createRasterTileLayer(opts: RasterTileLayerOptions): RasterTileLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);
  const tileByteSize = cfg.tileSize * cfg.tileSize * BYTES_PER_PIXEL_RGBA8;

  // ── 2. 内部状态 ──
  const cache = new TileCache(CACHE_MAX_ENTRIES, CACHE_MAX_BYTES);
  const styleUniforms: StyleUniformData = parseStyleUniforms(cfg.paint, cfg.opacity);
  let fadeDurationMs = cfg.fadeDuration;
  let mounted = false;
  /** 是否编码实际 draw call（2.5D 下地形接管底图时可关闭） */
  let renderEnabled = true;
  let styleDirty = true;
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化属性缓存
  if (cfg.paint) { for (const k of Object.keys(cfg.paint)) { paintProps.set(k, cfg.paint[k]); } }
  if (cfg.layout) { for (const k of Object.keys(cfg.layout)) { layoutProps.set(k, cfg.layout[k]); } }

  // 瓦片 URL 模板（运行时可从 source 更新）
  let urlTemplates: string[] = [...cfg.tiles];

  // ── Overzoom 状态 ──
  /** 数据源 zoom 范围（已规范化） */
  const sourceZoomRange: TileSourceZoomRange = {
    minNativeZoom: cfg.minNativeZoom,
    maxNativeZoom: cfg.maxNativeZoom,
  };
  /** Overzoom 配置（已规范化） */
  const overzoomConfig: OverzoomConfig = cfg.overzoom;
  /** 最大允许的显示 zoom = maxNativeZoom + maxOverzoom，上限 MAX_DISPLAY_ZOOM_CAP */
  const maxDisplayZoom = Math.min(
    sourceZoomRange.maxNativeZoom + overzoomConfig.maxOverzoom,
    MAX_DISPLAY_ZOOM_CAP,
  );
  /** zoom fade 配置 */
  const fadeInZoomCfg = cfg.fadeInZoom;
  const fadeOutZoomCfg = cfg.fadeOutZoom;
  /** 稀疏金字塔探测器——记录哪些瓦片坐标实际有数据/缺失 */
  const prober = new AncestorProber();
  /** 当前帧的 overzoom 级数（0 = 正常，>0 = overzoom 中） */
  let currentOverzoomLevels = 0;

  // 请求管理
  const inflightRequests = new Map<string, AbortController>();
  let concurrentCount = 0;
  const pendingQueue: Array<{ key: string; z: number; x: number; y: number; priority: number }> = [];

  // 当前帧可见瓦片
  let currentVisibleTiles: VisibleTile[] = [];
  let lastNeededKeys = new Set<string>();

  // ── 方案五 TileScheduler：IoU 节流 ──
  /** 上次计算 coveringTiles 时的整数 tileZ */
  let schedLastTileZ = -1;
  /** 上次计算时的世界像素视口 AABB */
  let schedLastBBox: [number, number, number, number] | null = null;
  /** 上次 coveringTilesWithOverzoom 的缓存（节流期内复用） */
  let schedCachedResolved: ResolvedTile[] = [];
  /** 节流计帧器——即使视口几乎不变也每 N 帧强制刷新 */
  let schedFrameCount = 0;

  // ── 方案一 RetainedTiles：旧帧保持 ──
  /** 上一次 "覆盖完整" 的可见瓦片快照——新帧覆盖不足时退用此集合渲染 */
  let retainedVisibleTiles: VisibleTile[] = [];

  // ── 方案八 IdleDetector：计数 + 回调 ──
  /** 仍在加载中的瓦片请求计数 */
  let idlePendingCount = 0;
  /** idle 回调队列 */
  let idleCallbacks: Array<() => void> = [];
  /** 防抖定时器 */
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  /** idle 检测器已销毁标记 */
  let idleDestroyed = false;

  /** 检测并触发 idle 回调 */
  function checkIdle(): void {
    if (idlePendingCount > 0 || idleDestroyed) {
      return;
    }
    if (idleTimerId !== null) {
      clearTimeout(idleTimerId);
    }
    idleTimerId = setTimeout(() => {
      if (idleDestroyed || idlePendingCount > 0) {
        return;
      }
      const cbs = idleCallbacks.splice(0);
      for (const cb of cbs) {
        cb();
      }
    }, 100);
  }

  // 画布尺寸（由 onAdd 注入或 onUpdate 推断）
  let canvasWidth = 800;
  let canvasHeight = 600;

  // ── 3. GPU 资源 ──
  let device: GPUDevice | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let sampler: GPUSampler | null = null;
  let cameraUniformBuffer: GPUBuffer | null = null;
  let styleUniformBuffer: GPUBuffer | null = null;
  let cameraBindGroup: GPUBindGroup | null = null;
  let styleBindGroup: GPUBindGroup | null = null;
  let vertexBuffer: GPUBuffer | null = null;
  let indexBuffer: GPUBuffer | null = null;
  let cameraBindGroupLayout: GPUBindGroupLayout | null = null;
  let styleBindGroupLayout: GPUBindGroupLayout | null = null;
  let textureBindGroupLayout: GPUBindGroupLayout | null = null;
  let pipelineLayout: GPUPipelineLayout | null = null;

  // ── 4. GPU 资源初始化 ──

  /**
   * 初始化所有 WebGPU 资源：管线、缓冲区、采样器、BindGroup 布局。
   * 在 onAdd 获得 GPUDevice 后调用一次。
   *
   * @param dev - WebGPU 设备实例
   */
  function initGPUResources(dev: GPUDevice): void {
    device = dev;

    // 着色器模块
    const shaderModule = dev.createShaderModule({ code: RASTER_TILE_WGSL });

    // 采样器：双线性过滤 + clamp-to-edge（防瓦片边缘溢出）
    sampler = dev.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // BindGroup 布局定义
    cameraBindGroupLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });

    styleBindGroupLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    textureBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });

    pipelineLayout = dev.createPipelineLayout({
      bindGroupLayouts: [cameraBindGroupLayout, styleBindGroupLayout, textureBindGroupLayout],
    });

    // 渲染管线
    const format = navigator.gpu.getPreferredCanvasFormat();
    pipeline = dev.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          // 顶点缓冲布局：position(vec3f) + uv(vec2f) + alpha(f32) = 24 bytes
          arrayStride: VERTEX_STRIDE_BYTES,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
            { shaderLocation: 1, offset: 12, format: 'float32x2' },  // uv
            { shaderLocation: 2, offset: 20, format: 'float32' },    // alpha
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            // 标准 alpha blending（支持渐显和半透明）
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: 'none',
      },
      // 与 Map2D 的 render pass 的深度附件保持一致（供地形层等使用深度测试）。
      // 栅格瓦片自身不做深度比较也不写入，避免影响其它层。
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    // Uniform 缓冲区
    cameraUniformBuffer = dev.createBuffer({
      size: 64, // mat4x4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    styleUniformBuffer = dev.createBuffer({
      size: 16, // 4 × f32 (brightness, contrast, saturation, hueRotate)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // BindGroups
    cameraBindGroup = dev.createBindGroup({
      layout: cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cameraUniformBuffer } }],
    });

    styleBindGroup = dev.createBindGroup({
      layout: styleBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: styleUniformBuffer } }],
    });

    // 顶点缓冲（预分配 MAX_RENDER_TILE_QUADS 个瓦片四边形）
    vertexBuffer = dev.createBuffer({
      size: MAX_RENDER_TILE_QUADS * VERTS_PER_TILE * VERTEX_STRIDE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // 索引缓冲（单个四边形 [0,1,2, 2,1,3]，通过 baseVertex 复用）
    const indexData = new Uint16Array([0, 1, 2, 2, 1, 3]);
    indexBuffer = dev.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(indexBuffer, 0, indexData);
  }

  /**
   * 为一个已加载的瓦片创建纹理 BindGroup。
   *
   * @param texture - 瓦片 GPU 纹理
   * @returns BindGroup
   */
  function createTileBindGroup(texture: GPUTexture): GPUBindGroup {
    if (device === null || textureBindGroupLayout === null || sampler === null) {
      throw new Error(`[${RASTER_ERROR_CODES.NO_GPU_DEVICE}] GPU not initialized`);
    }
    return device.createBindGroup({
      layout: textureBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
  }

  // ── 5. 瓦片加载 ──

  /**
   * 异步加载单个瓦片：fetch → decode → upload GPU texture → cache。
   *
   * @param key - 瓦片键
   * @param z - 缩放级别
   * @param x - 列号
   * @param y - 行号
   */
  async function loadTile(key: string, z: number, x: number, y: number): Promise<void> {
    if (device === null || urlTemplates.length === 0) {
      return;
    }

    // 选择 URL 模板（多个模板时随机选择以分散请求）
    const templateIdx = urlTemplates.length > 1
      ? Math.floor(Math.random() * urlTemplates.length)
      : 0;
    const url = buildTileUrl(urlTemplates[templateIdx], z, x, y);

    // 创建取消控制器
    const controller = new AbortController();
    inflightRequests.set(key, controller);
    concurrentCount++;
    idlePendingCount++;

    try {
      // 网络请求
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      }

      // 解码为 ImageBitmap（浏览器原生异步解码）
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });

      // 检查取消（可能在解码过程中被 abort）
      if (controller.signal.aborted) {
        bitmap.close();
        return;
      }

      // 创建 GPU 纹理
      const texture = device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // 上传图像数据到纹理
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      );
      bitmap.close();

      // 创建 BindGroup 并存入缓存
      const bindGroup = createTileBindGroup(texture);
      cache.setReady(key, texture, bindGroup, tileByteSize);

      // ── Overzoom §二：标记瓦片有数据 ──
      prober.markExists(z, x, y);

    } catch (err: unknown) {
      // 错误分类与处理
      const errType = classifyError(err);
      if (errType === 'ignore') {
        return;
      }

      const entry = cache.get(key);
      if (entry !== undefined) {
        if (errType === 'permanent') {
          entry.state = 'error-permanent';
          // ── Overzoom §二：标记瓦片缺失（永久错误） ──
          prober.markMissing(z, x, y);
        } else {
          entry.errorCount++;
          entry.state = 'error-transient';
          // 超过最大重试次数则标记为永久错误
          if (entry.errorCount > MAX_RETRY_COUNT) {
            entry.state = 'error-permanent';
          } else {
            // 指数退避重试
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, entry.errorCount - 1);
            setTimeout(() => {
              if (mounted && !controller.signal.aborted) {
                scheduleTileLoad(key, z, x, y, 0);
              }
            }, delay);
          }
        }
      }
    } finally {
      inflightRequests.delete(key);
      concurrentCount--;
      idlePendingCount = Math.max(0, idlePendingCount - 1);
      checkIdle();
      // 触发队列中的下一个请求
      flushPendingQueue();
    }
  }

  /**
   * 将瓦片加载请求入队。如果并发未满则立即执行，否则按优先级排队。
   *
   * @param key - 瓦片键
   * @param z - 缩放级别
   * @param x - 列号
   * @param y - 行号
   * @param priority - 优先级（越大越优先）
   */
  function scheduleTileLoad(key: string, z: number, x: number, y: number, priority: number): void {
    // 已在加载中 → 忽略
    if (inflightRequests.has(key)) {
      return;
    }

    if (concurrentCount < MAX_CONCURRENT_REQUESTS) {
      // 直接执行
      void loadTile(key, z, x, y);
    } else {
      // 入队等待
      pendingQueue.push({ key, z, x, y, priority });
      // 按优先级降序排列
      pendingQueue.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * 从等待队列中取出请求执行，直到达到并发上限。
   */
  function flushPendingQueue(): void {
    while (concurrentCount < MAX_CONCURRENT_REQUESTS && pendingQueue.length > 0) {
      const req = pendingQueue.shift()!;
      // 检查该瓦片是否仍然需要
      if (lastNeededKeys.has(req.key)) {
        void loadTile(req.key, req.z, req.x, req.y);
      }
    }
  }

  /**
   * 取消所有不在 neededKeys 中的进行中请求和待队列请求。
   *
   * @param neededKeys - 当前帧需要的瓦片键集合
   */
  function cancelStaleRequests(neededKeys: Set<string>): void {
    // 取消进行中的过期请求
    for (const [key, controller] of inflightRequests) {
      if (!neededKeys.has(key)) {
        controller.abort();
        inflightRequests.delete(key);
        concurrentCount--;
      }
    }
    // 清理队列中过期的请求
    for (let i = pendingQueue.length - 1; i >= 0; i--) {
      if (!neededKeys.has(pendingQueue[i].key)) {
        pendingQueue.splice(i, 1);
      }
    }
  }

  /**
   * 取消所有请求（destroy 时调用）。
   */
  function cancelAllRequests(): void {
    for (const controller of inflightRequests.values()) {
      controller.abort();
    }
    inflightRequests.clear();
    concurrentCount = 0;
    pendingQueue.length = 0;
  }

  // ── 6. 释放 GPU 资源 ──

  /**
   * 销毁所有 GPU 资源。
   */
  function destroyGPUResources(): void {
    cameraUniformBuffer?.destroy();
    styleUniformBuffer?.destroy();
    vertexBuffer?.destroy();
    indexBuffer?.destroy();
    cameraUniformBuffer = null;
    styleUniformBuffer = null;
    vertexBuffer = null;
    indexBuffer = null;
    pipeline = null;
    sampler = null;
    cameraBindGroup = null;
    styleBindGroup = null;
    cameraBindGroupLayout = null;
    styleBindGroupLayout = null;
    textureBindGroupLayout = null;
    pipelineLayout = null;
    device = null;
  }

  // ── 7. 构造 Layer 实现对象 ──
  const layer: RasterTileLayer = {
    id: cfg.id,
    type: 'raster' as const,
    source: cfg.source,
    projection: cfg.projection,
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    get isLoaded(): boolean {
      return cache.size > 0;
    },

    get isTransparent(): boolean {
      if (styleUniforms.opacity < OPACITY_MAX) { return true; }
      for (const vt of currentVisibleTiles) {
        if (vt.entry.fadeProgress < FADE_COMPLETE_THRESHOLD) { return true; }
      }
      return false;
    },

    get renderOrder(): number {
      return layer.zIndex;
    },

    get visibleTiles(): number {
      return currentVisibleTiles.length;
    },

    get loadingTiles(): number {
      return inflightRequests.size;
    },

    get cachedTileCount(): number {
      return cache.size;
    },

    get isOverzoomed(): boolean {
      return currentOverzoomLevels > 0;
    },

    get currentOverzoomLevels(): number {
      return currentOverzoomLevels;
    },

    // ══════ 生命周期 ══════

    onAdd(context: LayerContext): void {
      mounted = true;

      // 尝试从 LayerContext 获取 GPU 设备
      const dev = context.gpuDevice ?? null;
      if (dev !== null && dev !== undefined) {
        initGPUResources(dev);
      }

      // 获取画布尺寸
      if (context.canvasSize !== undefined) {
        canvasWidth = context.canvasSize[0];
        canvasHeight = context.canvasSize[1];
      }

      // 尝试从 services 获取 URL 模板
      if (context.services !== undefined) {
        const srcTiles = context.services['tiles'];
        if (Array.isArray(srcTiles) && srcTiles.length > 0) {
          urlTemplates = srcTiles as string[];
        }
      }

      // ── 方案一：预加载全球覆盖瓦片（z=0 ~ PRELOAD_ANCESTOR_MAX_ZOOM）──
      // 确保 findAncestor 在任何 zoom 下都至少找到 z≤2 的纹理，
      // 彻底消除 zoom-out 时边缘区域因无祖先纹理导致的闪烁。
      if (urlTemplates.length > 0) {
        const maxPreloadZ = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, cfg.maxzoom);
        for (let pz = 0; pz <= maxPreloadZ; pz++) {
          const n = 1 << pz;
          for (let py = 0; py < n; py++) {
            for (let px = 0; px < n; px++) {
              const pk = tileKey(pz, px, py);
              if (!cache.has(pk)) {
                cache.getOrCreate(pk, { z: pz, x: px, y: py });
                scheduleTileLoad(pk, pz, px, py, 0);
              }
            }
          }
        }
      }
    },

    onRemove(): void {
      cancelAllRequests();
      cache.destroy();
      prober.destroy();
      destroyGPUResources();
      currentVisibleTiles = [];
      retainedVisibleTiles = [];
      lastNeededKeys.clear();
      featureStateMap.clear();
      schedLastTileZ = -1;
      schedLastBBox = null;
      schedCachedResolved = [];
      schedFrameCount = 0;
      currentOverzoomLevels = 0;
      idleDestroyed = true;
      if (idleTimerId !== null) {
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
      idleCallbacks = [];
      idlePendingCount = 0;
      mounted = false;
    },

    onUpdate(deltaTime: number, camera: CameraState): void {
      if (device === null || !mounted || !layer.visible) {
        currentVisibleTiles = [];
        return;
      }

      // ════════════════════════════════════════════════════
      // Overzoom §四：Zoom fade——alpha=0 的图层直接跳过全部逻辑
      // ════════════════════════════════════════════════════
      const layerAlpha = computeLayerAlpha(camera.zoom, fadeInZoomCfg, fadeOutZoomCfg);
      if (layerAlpha <= 0) {
        currentVisibleTiles = [];
        return;
      }

      // 缩放可见性判断——扩展到 maxDisplayZoom（而非 cfg.maxzoom）以支持 overzoom
      if (camera.zoom < cfg.minzoom || camera.zoom > maxDisplayZoom + 1) {
        currentVisibleTiles = [];
        return;
      }

      // 记录当前 overzoom 级数
      currentOverzoomLevels = Math.max(0, Math.floor(camera.zoom) - sourceZoomRange.maxNativeZoom);

      // ════════════════════════════════════════════════════
      // 方案五：IoU 节流——视口几乎不变时复用上帧 coveringTilesWithOverzoom
      // ════════════════════════════════════════════════════
      const idealTileZ = Math.min(
        Math.max(Math.floor(camera.zoom), cfg.minzoom),
        maxDisplayZoom,
      );
      const viewBBox = computeViewBBox(camera, canvasWidth, canvasHeight);
      schedFrameCount++;

      const shouldRecalc =
        schedLastTileZ !== idealTileZ ||
        schedLastBBox === null ||
        bboxIoU(schedLastBBox, viewBBox) < SCHEDULE_IOU_THRESHOLD ||
        schedFrameCount >= SCHEDULE_MAX_SKIP_FRAMES;

      if (shouldRecalc) {
        // ── Overzoom §一 + §五统一：按 maxDisplayZoom 计算覆盖瓦片，然后 resolveTile ──
        schedCachedResolved = coveringTilesWithOverzoom(
          camera, canvasWidth, canvasHeight, cfg.minzoom, maxDisplayZoom,
          sourceZoomRange, overzoomConfig,
        );
        schedLastTileZ = idealTileZ;
        schedLastBBox = viewBBox;
        schedFrameCount = 0;
      }

      const resolved = schedCachedResolved;

      // ════════════════════════════════════════════════════
      // 构建扩展 neededKeys（requestKey 维度）——
      //   · resolved 列表的 requestKeys（实际需要的瓦片）
      //   · 非 overzoom 瓦片的 z+1 子瓦片（zoom-out 拼合辅助）
      //   · 上一帧 retainedVisibleTiles 使用的纹理键（旧帧保持）
      //   · 预加载祖先瓦片 z=0~2
      // 三者合并后再 cancelStale，保证过渡期纹理不被误杀。
      // ════════════════════════════════════════════════════
      const loadRequestList: Array<{ key: string; z: number; x: number; y: number }> = [];
      for (const r of resolved) {
        loadRequestList.push({ key: r.requestKey, z: r.requestZ, x: r.requestX, y: r.requestY });
      }

      // 非 overzoom 瓦片：如果 request 瓦片未就绪，添加 z+1 子瓦片辅助加载（zoom-out 拼合）
      for (const r of resolved) {
        if (r.isOverzoomed) { continue; }
        const pe = cache.get(r.requestKey);
        const parentReady = pe !== undefined && pe.state === 'ready' && pe.texture !== null;
        if (!parentReady && r.requestZ < sourceZoomRange.maxNativeZoom) {
          const cz = r.requestZ + 1;
          const x0 = r.requestX * 2;
          const y0 = r.requestY * 2;
          loadRequestList.push(
            { key: tileKey(cz, x0,     y0),     z: cz, x: x0,     y: y0 },
            { key: tileKey(cz, x0 + 1, y0),     z: cz, x: x0 + 1, y: y0 },
            { key: tileKey(cz, x0,     y0 + 1), z: cz, x: x0,     y: y0 + 1 },
            { key: tileKey(cz, x0 + 1, y0 + 1), z: cz, x: x0 + 1, y: y0 + 1 },
          );
        }
      }

      const neededKeys = new Set<string>();
      for (const lr of loadRequestList) {
        neededKeys.add(lr.key);
      }
      // 保留旧帧正在使用的纹理键——避免 cancelStale 杀死仍在渲染的占位纹理
      for (const vt of retainedVisibleTiles) {
        neededKeys.add(vt.entry.key);
      }
      // 预加载 z=0~2 瓦片始终保留——不被 cancelStale 杀死
      const maxPreZ2 = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, sourceZoomRange.maxNativeZoom);
      for (let pz = 0; pz <= maxPreZ2; pz++) {
        const pn = 1 << pz;
        for (let py = 0; py < pn; py++) {
          for (let px = 0; px < pn; px++) {
            neededKeys.add(tileKey(pz, px, py));
          }
        }
      }

      cancelStaleRequests(neededKeys);
      lastNeededKeys = neededKeys;

      // ════════════════════════════════════════════════════
      // 重试未就绪的预加载祖先（onAdd 时 device 可能尚未就绪导致首次加载跳过）
      // ════════════════════════════════════════════════════
      if (urlTemplates.length > 0) {
        for (let pz = 0; pz <= maxPreZ2; pz++) {
          const pn = 1 << pz;
          for (let py = 0; py < pn; py++) {
            for (let px = 0; px < pn; px++) {
              const pk = tileKey(pz, px, py);
              const pe = cache.get(pk);
              if (pe === undefined) {
                cache.getOrCreate(pk, { z: pz, x: px, y: py });
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              } else if (pe.state !== 'ready' && pe.state !== 'loading' && pe.state !== 'error-permanent') {
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              } else if (pe.state === 'loading' && !inflightRequests.has(pk)) {
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              }
            }
          }
        }
      }

      // ════════════════════════════════════════════════════
      // 瓦片加载调度（去重 + 优先级，按 requestKey 维度）
      // overzoom 瓦片优先级 = 'normal'，正常瓦片按距离排序
      // ════════════════════════════════════════════════════
      const seenLoad = new Set<string>();
      for (let i = 0; i < loadRequestList.length; i++) {
        const lr = loadRequestList[i];
        if (seenLoad.has(lr.key)) { continue; }
        seenLoad.add(lr.key);

        // 在 resolved 列表中的瓦片优先级更高（按顺序递减）
        const priority = i < resolved.length ? MAX_COVERING_TILES - i : 0;

        const entry = cache.get(lr.key);
        if (entry === undefined) {
          cache.getOrCreate(lr.key, { z: lr.z, x: lr.x, y: lr.y });
          if (urlTemplates.length > 0) {
            scheduleTileLoad(lr.key, lr.z, lr.x, lr.y, priority);
          }
        } else if (
          entry.state !== 'ready' &&
          entry.state !== 'error-permanent' &&
          entry.state !== 'loading'
        ) {
          if (urlTemplates.length > 0) {
            scheduleTileLoad(lr.key, lr.z, lr.x, lr.y, priority);
          }
        }
      }

      // ════════════════════════════════════════════════════
      // Overzoom §二：AncestorProber 辅助加载——
      // 对于 prober 已知缺失的 request 瓦片，尝试向上查找有数据的祖先并触发加载
      // ════════════════════════════════════════════════════
      if (urlTemplates.length > 0) {
        for (const r of resolved) {
          const ce = cache.get(r.requestKey);
          // 只对 error-permanent（已知 404/缺失）的瓦片触发祖先探查
          if (ce !== undefined && ce.state === 'error-permanent') {
            const ancestor = prober.findAncestor(r.requestZ, r.requestX, r.requestY);
            if (ancestor !== null && !cache.has(ancestor.requestKey)) {
              cache.getOrCreate(ancestor.requestKey, {
                z: ancestor.requestZ, x: ancestor.requestX, y: ancestor.requestY,
              });
              scheduleTileLoad(
                ancestor.requestKey,
                ancestor.requestZ, ancestor.requestX, ancestor.requestY,
                MAX_COVERING_TILES,
              );
            }
          }
        }
      }

      // ════════════════════════════════════════════════════
      // Overzoom §五：统一可见性仲裁——
      // resolveVisibleTilesFromResolved 统一处理:
      //   ① request 瓦片已缓存 → 使用 overzoom UV 子区域
      //   ② 非 overzoom → 尝试 zoom-out 子瓦片拼合
      //   ③ 兜底 → 在缓存中搜索 display 坐标的最近祖先
      // ════════════════════════════════════════════════════
      const newVisible = resolveVisibleTilesFromResolved(
        resolved, cache, sourceZoomRange.maxNativeZoom,
      );

      // 统计新帧覆盖情况（按 displayKey 维度）
      const coveredPositions = new Set<string>();
      for (const vt of newVisible) {
        coveredPositions.add(
          tileKey(vt.targetCoord.z, vt.targetCoord.x, vt.targetCoord.y),
        );
      }
      let gapCount = 0;
      for (const r of resolved) {
        // ① 精确匹配或祖先（targetCoord == display coord）
        if (coveredPositions.has(r.displayKey)) {
          continue;
        }
        // ② 子瓦片拼合路径——targetCoord 在 displayZ+1（仅非 overzoom）
        if (!r.isOverzoomed) {
          const cz = r.displayZ + 1;
          const cx = r.displayX * 2;
          const cy = r.displayY * 2;
          if (
            coveredPositions.has(tileKey(cz, cx,     cy)) &&
            coveredPositions.has(tileKey(cz, cx + 1, cy)) &&
            coveredPositions.has(tileKey(cz, cx,     cy + 1)) &&
            coveredPositions.has(tileKey(cz, cx + 1, cy + 1))
          ) {
            continue;
          }
        }
        gapCount++;
      }

      if (gapCount === 0 || retainedVisibleTiles.length === 0) {
        currentVisibleTiles = newVisible;
        retainedVisibleTiles = newVisible.slice();
      } else {
        currentVisibleTiles = [...retainedVisibleTiles, ...newVisible];
      }

      // ════════════════════════════════════════════════════
      // Pin 当前帧 + retained + 预加载祖先（防 LRU 淘汰）
      // ════════════════════════════════════════════════════
      const pinKeys: string[] = [];
      for (const vt of currentVisibleTiles) {
        pinKeys.push(vt.entry.key);
      }
      // 永久 pin z=0~2 预加载瓦片——它们是全局兜底祖先
      const maxPreZ = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, sourceZoomRange.maxNativeZoom);
      for (let pz = 0; pz <= maxPreZ; pz++) {
        const pn = 1 << pz;
        for (let py = 0; py < pn; py++) {
          for (let px = 0; px < pn; px++) {
            pinKeys.push(tileKey(pz, px, py));
          }
        }
      }
      cache.pinForFrame(pinKeys);

      // ════════════════════════════════════════════════════
      // 渐显动画推进
      // ════════════════════════════════════════════════════
      const dtMs = deltaTime * 1000;
      for (const vt of currentVisibleTiles) {
        if (vt.entry.fadeProgress < FADE_COMPLETE_THRESHOLD) {
          if (fadeDurationMs <= 0) {
            vt.entry.fadeProgress = FADE_COMPLETE_THRESHOLD;
          } else {
            vt.entry.fadeProgress = Math.min(
              FADE_COMPLETE_THRESHOLD,
              vt.entry.fadeProgress + dtMs / fadeDurationMs,
            );
          }
        }
      }
    },

    encode(encoder: GPURenderPassEncoder, camera: CameraState): void {
      // 前置条件检查
      if (
        device === null || pipeline === null ||
        cameraBindGroup === null || styleBindGroup === null ||
        vertexBuffer === null || indexBuffer === null ||
        cameraUniformBuffer === null || styleUniformBuffer === null ||
        currentVisibleTiles.length === 0 || !layer.visible ||
        !renderEnabled
      ) {
        return;
      }

      const tileCount = Math.min(currentVisibleTiles.length, MAX_RENDER_TILE_QUADS);

      // ① 上传相机 Uniform（VP 矩阵）
      device.queue.writeBuffer(cameraUniformBuffer, 0, camera.vpMatrix.buffer, camera.vpMatrix.byteOffset, camera.vpMatrix.byteLength);

      // ② 上传样式 Uniform（仅在脏时）
      if (styleDirty) {
        const styleData = new Float32Array([
          styleUniforms.brightness,
          styleUniforms.contrast,
          styleUniforms.saturation,
          styleUniforms.hueRotate,
        ]);
        device.queue.writeBuffer(styleUniformBuffer, 0, styleData);
        styleDirty = false;
      }

      // ③ 构建所有瓦片的顶点数据（相机相对坐标 + 预计算 UV + fade alpha）
      const worldSize = TILE_PIXEL_SIZE * Math.pow(2, camera.zoom);
      const [centerPx, centerPy] = lngLatToWorldPixel(
        camera.center[0], camera.center[1], worldSize,
      );

      // 每个顶点 6 floats: px, py, pz, u, v, alpha
      const vertData = new Float32Array(tileCount * VERTS_PER_TILE * 6);
      let offset = 0;

      for (let i = 0; i < tileCount; i++) {
        const vt = currentVisibleTiles[i];
        const t = vt.targetCoord;
        const tileSizePx = worldSize / Math.pow(2, t.z);

        // 瓦片世界像素边界
        const tx0 = t.x * tileSizePx;
        const ty0 = t.y * tileSizePx;
        const tx1 = tx0 + tileSizePx;
        const ty1 = ty0 + tileSizePx;

        // 相机相对坐标（Solution 9：减去 center 保持 float32 精度）
        const rx0 = tx0 - centerPx;
        const ry0 = ty0 - centerPy;
        const rx1 = tx1 - centerPx;
        const ry1 = ty1 - centerPy;

        // UV 子区域（祖先占位时为子区域，正常时为 [0,0]-[1,1]）
        const u0 = vt.uvOffset[0];
        const v0 = vt.uvOffset[1];
        const u1 = u0 + vt.uvScale[0];
        const v1 = v0 + vt.uvScale[1];

        // 综合 alpha = 渐显进度 × 图层不透明度
        const alpha = vt.entry.fadeProgress * styleUniforms.opacity;

        // 顶点 0: 左上
        vertData[offset++] = rx0; vertData[offset++] = ry0; vertData[offset++] = 0;
        vertData[offset++] = u0; vertData[offset++] = v0; vertData[offset++] = alpha;
        // 顶点 1: 右上
        vertData[offset++] = rx1; vertData[offset++] = ry0; vertData[offset++] = 0;
        vertData[offset++] = u1; vertData[offset++] = v0; vertData[offset++] = alpha;
        // 顶点 2: 左下
        vertData[offset++] = rx0; vertData[offset++] = ry1; vertData[offset++] = 0;
        vertData[offset++] = u0; vertData[offset++] = v1; vertData[offset++] = alpha;
        // 顶点 3: 右下
        vertData[offset++] = rx1; vertData[offset++] = ry1; vertData[offset++] = 0;
        vertData[offset++] = u1; vertData[offset++] = v1; vertData[offset++] = alpha;
      }

      // ④ 上传顶点数据
      device.queue.writeBuffer(vertexBuffer, 0, vertData, 0, offset);

      // ⑤ 设置管线和共享 BindGroups
      encoder.setPipeline(pipeline);
      encoder.setBindGroup(0, cameraBindGroup);
      encoder.setBindGroup(1, styleBindGroup);
      encoder.setVertexBuffer(0, vertexBuffer);
      encoder.setIndexBuffer(indexBuffer, 'uint16');

      // ⑥ 逐瓦片绘制（每个瓦片切换纹理 BindGroup）
      for (let i = 0; i < tileCount; i++) {
        const vt = currentVisibleTiles[i];
        if (vt.entry.bindGroup === null) {
          continue;
        }
        encoder.setBindGroup(2, vt.entry.bindGroup);
        encoder.drawIndexed(INDICES_PER_TILE, 1, 0, i * VERTS_PER_TILE, 0);
      }
    },

    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // 栅格瓦片无要素 ID，拾取 Pass 不提交绘制命令
    },

    // ══════ 属性方法 ══════

    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
      if (typeof value === 'number' && Number.isFinite(value)) {
        switch (name) {
          case 'raster-brightness-min':
          case 'raster-brightness-max':
            styleUniforms.brightness = value;
            styleDirty = true;
            break;
          case 'raster-contrast':
            styleUniforms.contrast = value;
            styleDirty = true;
            break;
          case 'raster-saturation':
            styleUniforms.saturation = value;
            styleDirty = true;
            break;
          case 'raster-hue-rotate':
            styleUniforms.hueRotate = value * DEG_TO_RAD;
            styleDirty = true;
            break;
          case 'raster-opacity':
            styleUniforms.opacity = value;
            break;
          case 'raster-fade-duration':
            fadeDurationMs = value;
            break;
          default:
            break;
        }
      }
    },

    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    setData(data: unknown): void {
      // 支持外部注入 URL 模板（由 Map2D 在 addSource 后传入）
      if (data !== null && data !== undefined && typeof data === 'object') {
      const record = data as Record<string, unknown>;
        if (Array.isArray(record['tiles'])) {
          urlTemplates = record['tiles'] as string[];
        }
      }
    },

    getData(): unknown {
      return {
        cachedTiles: cache.size,
        loadingCount: inflightRequests.size,
        visibleCount: currentVisibleTiles.length,
        cacheBytes: cache.bytes,
      };
    },

    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ══════ 栅格特有样式方法 ══════

    setBrightness(value: number): void {
      if (!Number.isFinite(value) || value < BRIGHTNESS_MIN || value > BRIGHTNESS_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_BRIGHTNESS}] brightness must be in [-1, 1]`);
      }
      styleUniforms.brightness = value;
      paintProps.set('raster-brightness-min', value);
      styleDirty = true;
    },

    getBrightness(): number {
      return styleUniforms.brightness;
    },

    setContrast(value: number): void {
      if (!Number.isFinite(value) || value < CONTRAST_MIN || value > CONTRAST_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_CONTRAST}] contrast must be in [-1, 1]`);
      }
      styleUniforms.contrast = value;
      paintProps.set('raster-contrast', value);
      styleDirty = true;
    },

    getContrast(): number {
      return styleUniforms.contrast;
    },

    setSaturation(value: number): void {
      if (!Number.isFinite(value) || value < SATURATION_MIN || value > SATURATION_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_SATURATION}] saturation must be in [-1, 1]`);
      }
      styleUniforms.saturation = value;
      paintProps.set('raster-saturation', value);
      styleDirty = true;
    },

    getSaturation(): number {
      return styleUniforms.saturation;
    },

    setHueRotate(degrees: number): void {
      if (!Number.isFinite(degrees)) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_HUE_ROTATE}] hueRotate must be finite`);
      }
      styleUniforms.hueRotate = degrees * DEG_TO_RAD;
      paintProps.set('raster-hue-rotate', degrees);
      styleDirty = true;
    },

    getHueRotate(): number {
      return styleUniforms.hueRotate * RAD_TO_DEG;
    },

    setFadeDuration(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0`);
      }
      fadeDurationMs = ms;
      paintProps.set('raster-fade-duration', ms);
    },

    // ══════ 方案八 IdleDetector ══════

    waitForIdle(): Promise<void> {
      if (idlePendingCount === 0 && inflightRequests.size === 0 && pendingQueue.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleCallbacks.push(resolve);
      });
    },

    isIdle(): boolean {
      return idlePendingCount === 0 && inflightRequests.size === 0 && pendingQueue.length === 0;
    },

    setRenderEnabled(enabled: boolean): void {
      renderEnabled = enabled;
    },

    getTextureForTile(z: number, x: number, y: number): GPUTexture | null {
      const key = tileKey(z, x, y);
      const entry = cache.get(key);
      if (entry === undefined || entry.state !== 'ready' || entry.texture === null) {
        return null;
      }
      return entry.texture;
    },

    requireTile(z: number, x: number, y: number): void {
      const key = tileKey(z, x, y);
      const entry = cache.get(key);
      if (entry !== undefined && entry.state === 'ready') { return; }
      if (inflightRequests.has(key)) { return; }
      // 以中等优先级入队（真实调度会在下一帧 onUpdate 中重排）
      scheduleTileLoad(key, z, x, y, 50);
    },
  };

  return layer;
}
