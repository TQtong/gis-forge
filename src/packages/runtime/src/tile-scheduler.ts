// ============================================================
// tile-scheduler.ts — L3 TileScheduler：SSE 驱动的瓦片调度（MVP）
// 类型从 L0 import；本模块不依赖 L1，避免 GPU 资源创建。
// ============================================================

import type { CameraState, Viewport, BBox2D } from '../../core/src/types/index.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';

/** 开发构建标记；生产构建由打包器剔除调试分支。 */
declare const __DEV__: boolean | undefined;

/** 瓦片生命周期/缓存状态（调度器视角）。 */
export type TileState = 'empty' | 'loading' | 'loaded' | 'error' | 'cached';

/** 默认最大并发加载数（每帧网络/Worker 压力上限）。 */
const DEFAULT_MAX_CONCURRENT_LOADS = 6;
/** 默认最大缓存瓦片数量（跨所有 source 的简单全局上限，MVP）。 */
const DEFAULT_MAX_CACHE_SIZE = 512;
/** 默认 SSE 阈值：越大越“宽松”（更少细分请求），单位与 MVP 的 sse 计算一致。 */
const DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD = 8;
/** 默认允许“过采样”级别：相机 zoom 高于数据 maxZoom 时仍保留的额外 zoom 裕量。 */
const DEFAULT_OVERZOOM_LEVELS = 2;
/** 默认预取：在可见范围基础上每边扩展的瓦片数（Chebyshev）。 */
const DEFAULT_PREFETCH_ZOOM_DELTA = 1;
/** 默认 pitch 惩罚：pitch 越大，SSE 等效越高（远处瓦片更倾向不加载）。 */
const DEFAULT_PITCH_PRIORITY_REDUCTION = 0.35;
/** 默认 SSE 分项权重（与 visibility/cache 组成多因子优先级）。 */
const DEFAULT_PRIORITY_WEIGHT_SSE = 0.5;
/** 默认视锥/严格可见性分项权重（2D MVP：内层可见窗口视为视锥代理）。 */
const DEFAULT_PRIORITY_WEIGHT_VISIBILITY = 0.3;
/** 默认缓存命中分项权重。 */
const DEFAULT_PRIORITY_WEIGHT_CACHE = 0.2;
/** 最小合法瓦片像素边长（避免除零）。 */
const MIN_TILE_SIZE_PX = 1;
/** 经纬度合法范围钳制，避免 asinh 域错误。 */
const MAX_LAT_CLAMP = 85.05112878;
/** 浮点比较 epsilon。 */
const EPS = 1e-6;
/** LOD 衰减：与中心 tile 距离比较时的参考距离（tile 单位）；与 `distanceFromCenter` 同量纲。 */
const TILE_LOD_CENTER_DISTANCE_TILE_UNITS = 1;
/** 默认：屏幕上同时允许的最大 zoom 档位数（与 MapLibre `maxZoomLevelsOnScreen` 对齐）。 */
const DEFAULT_TILE_LOD_MAX_LEVELS_ON_SCREEN = 4;
/** 默认：高 pitch 时总瓦片数上限 = 基准可见格数 × 该比值。 */
const DEFAULT_TILE_LOD_TILE_COUNT_MAX_MIN_RATIO = 3;

/**
 * 高 pitch 时按距地图中心的距离衰减瓦片 zoom（减少远端高清瓦片请求、保证覆盖）。
 */
export interface TileLodConfig {
  /** Max different zoom levels on screen at once. @range [1,8] @default 4 */
  maxZoomLevelsOnScreen: number;
  /** Ratio of max tiles to min tiles at high pitch. @range [1,10] @default 3 */
  tileCountMaxMinRatio: number;
}

/**
 * 按与中心的距离计算该位置应采样的整数 zoom（越远越低）。
 * 公式：`clamp(centerZoom - floor(log2(distanceFromCenter / centerDistance)), centerZoom - maxLevels + 1, centerZoom)`。
 *
 * @param centerZoom - 视口中心处目标整数 zoom（与瓦片 z 一致）
 * @param distanceFromCenter - 与中心 tile 的平面距离（与中心同 z 的 tile 单位，如欧氏距离）
 * @param centerDistance - 参考距离；超过该距离后开始按 log2 降 zoom
 * @param maxLevels - 允许的最大 zoom 跨度档位数（对应 `TileLodConfig.maxZoomLevelsOnScreen`）
 * @returns 建议的整数 zoom（已钳制）
 *
 * @example
 * computeTileZoomAtDistance(10, 4, 1, 4); // 较远 → 低于 10
 */
export function computeTileZoomAtDistance(
  centerZoom: number,
  distanceFromCenter: number,
  centerDistance: number,
  maxLevels: number,
): number {
  try {
    const cz = clampInt(centerZoom, 0, 30);
    const maxLv = Math.max(1, Math.min(8, Math.floor(finiteNumber(maxLevels, DEFAULT_TILE_LOD_MAX_LEVELS_ON_SCREEN))));
    const dc = Math.max(EPS, finiteNumber(centerDistance, TILE_LOD_CENTER_DISTANCE_TILE_UNITS));
    const d = Math.max(0, finiteNumber(distanceFromCenter, 0));
    const ratio = d / dc;
    const safeRatio = ratio > 0 ? ratio : Number.MIN_VALUE;
    const logTerm = Math.floor(Math.log2(safeRatio));
    const rawTarget = cz - logTerm;
    const lo = cz - maxLv + 1;
    const hi = cz;
    return clampInt(rawTarget, lo, hi);
  } catch (err) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[TileScheduler] computeTileZoomAtDistance failed', err);
    }
    return clampInt(centerZoom, 0, 30);
  }
}

/**
 * 将瓦片沿四叉树向上收束到不高于 `targetZ` 的祖先（用于 LOD 降级）。
 *
 * @param coord - 当前格点瓦片坐标（与调度 grid 同 z）
 * @param targetZ - 目标整数 zoom（≤ coord.z）
 * @param minZ - 数据源最小 zoom
 * @returns 祖先瓦片坐标
 */
function tileDownToZoom(coord: TileCoord, targetZ: number, minZ: number): TileCoord {
  const tz = clampInt(targetZ, minZ, coord.z);
  let c = coord;
  let guard = 0;
  while (c.z > tz && guard < 64) {
    c = parentTile(c);
    guard += 1;
  }
  return c;
}

/**
 * 单个候选瓦片的优先级信息。
 */
export interface TilePriority {
  /** 瓦片坐标 */
  readonly coord: TileCoord;
  /**
   * 距离度量（越小越优先）。
   * MVP：使用视锥中心瓦片与目标瓦片在相同 z 下的欧氏距离（单位：瓦片）。
   */
  readonly distance: number;
  /**
   * 屏幕空间误差（Screen Space Error）代理量。
   * MVP：由 zoom 与瓦片层级差、pitch、以及距离共同构成的标量；越小越“够清晰”。
   */
  readonly screenSpaceError: number;
  /**
   * 多因子综合优先级分数（越大越应优先加载）。
   * 由 `computeTilePriority` 根据 SSE / 可见性 / 缓存 加权得到。
   */
  readonly priorityScore: number;
  /** 当前是否判定为屏幕相关（可见或强预取）。 */
  readonly isVisible: boolean;
  /** 是否被策略判定为“需要持有/加载”的瓦片（可见 + 预取）。 */
  readonly isNeeded: boolean;
}

/**
 * TileScheduler 配置。
 */
export interface TileSchedulerConfig {
  /** 最大并发加载数（in-flight loading 上限） */
  readonly maxConcurrentLoads: number;
  /** 最大缓存瓦片数量（超过触发 LRU 卸载候选） */
  readonly maxCacheSize: number;
  /** SSE 阈值：候选瓦片的 sse 超过该值将被降级处理（MVP：不进入 toLoad） */
  readonly screenSpaceErrorThreshold: number;
  /** 过 zoom 级别裕量（配合 TileSourceOptions.maxZoom） */
  readonly overzoomLevels: number;
  /** 预取扩展：在可见窗口外额外扩展的瓦片层数（Chebyshev 半径） */
  readonly prefetchZoomDelta: number;
  /** pitch 惩罚强度：越大越降低高 pitch 区域的加载积极性 */
  readonly pitchPriorityReduction: number;
  /**
   * SSE 归一化上界（与 `screenSpaceErrorThreshold` 解耦时可单独调）。
   * 用于 `sse / maxSSE` 计算 SSE 分项；默认与阈值一致。
   */
  readonly maxSSE: number;
  /**
   * 多因子优先级权重（SSE / 视锥可见 / 缓存），默认 0.5 / 0.3 / 0.2。
   * 三者不必和为 1；最终得分为加权和。
   */
  readonly priorityWeights: {
    /** SSE 分项权重（higher SSE → higher normalized score） */
    readonly sse: number;
    /** 与视锥（2D：严格可见窗口）相交的权重 */
    readonly visibility: number;
    /** 已缓存（loaded/cached）分项权重 */
    readonly cache: number;
  };
  /** 高 pitch 时按距离衰减 zoom 与总瓦片上限（Layer 3 + 6.3）。 */
  readonly tileLod: TileLodConfig;
}

/**
 * 数据源注册参数（每个 sourceId 一份）。
 */
export interface TileSourceOptions {
  /** 最小 zoom（含） */
  readonly minZoom: number;
  /** 最大 zoom（含） */
  readonly maxZoom: number;
  /** 瓦片像素边长（通常为 256/512） */
  readonly tileSize: number;
  /** 可选地理范围约束（经纬度包围盒） */
  readonly bounds?: BBox2D;
  /** 是否允许过 zoom（zoom 超过 maxZoom 时仍使用 maxZoom 瓦片） */
  readonly overzoomEnabled: boolean;
}

/**
 * `update()` 输出：加载队列、卸载队列、可见集、占位映射。
 */
export interface TileScheduleResult {
  /** 需要加载的候选（按多因子优先级分数降序） */
  readonly toLoad: TilePriority[];
  /** 建议卸载的瓦片坐标（LRU/超缓存） */
  readonly toUnload: TileCoord[];
  /** 当前帧判定为可见的瓦片坐标 */
  readonly visible: TileCoord[];
  /**
   * 占位瓦片映射：key 为 `${x}:${y}:${z}`，value 为父级瓦片坐标（用于未加载时回退显示）。
   */
  readonly placeholder: Map<string, TileCoord>;
}

/**
 * 内部瓦片记录（调度器状态机）。
 */
interface TileRecord {
  /** 当前状态 */
  state: TileState;
  /** 最近一次被调度器访问的帧号（用于 LRU） */
  lastAccessFrame: number;
  /** 最近一次错误信息（仅 error 状态有意义） */
  lastErrorMessage?: string;
}

/**
 * 内部 source 表项。
 */
interface SourceEntry {
  /** 注册参数 */
  options: TileSourceOptions;
}

/**
 * TileScheduler 实例接口。
 */
export interface TileScheduler {
  /**
   * 根据相机与视口更新调度结果，并推进内部帧计数。
   *
   * @param camera - 相机状态（center/zoom/pitch 等）
   * @param viewport - 视口尺寸（CSS 像素）
   */
  update(camera: CameraState, viewport: Viewport): TileScheduleResult;
  /** 当前配置（只读） */
  readonly config: TileSchedulerConfig;
  /**
   * 合并更新配置。
   *
   * @param config - 部分配置
   */
  updateConfig(config: Partial<TileSchedulerConfig>): void;
  /**
   * 查询瓦片状态。
   *
   * @param coord - 瓦片坐标
   * @param sourceId - 数据源 id
   */
  getTileState(coord: TileCoord, sourceId: string): TileState;
  /**
   * 获取最近一帧判定的可见瓦片列表（拷贝）。
   *
   * @param sourceId - 数据源 id
   */
  getVisibleTiles(sourceId: string): TileCoord[];
  /**
   * 获取缓存中的瓦片（loaded/cached）。
   *
   * @param sourceId - 数据源 id
   */
  getCachedTiles(sourceId: string): TileCoord[];
  /**
   * 注册数据源。
   *
   * @param sourceId - 数据源 id
   * @param options - 数据源参数
   */
  registerSource(sourceId: string, options: TileSourceOptions): void;
  /**
   * 注销数据源并清理其瓦片表。
   *
   * @param sourceId - 数据源 id
   */
  unregisterSource(sourceId: string): void;
  /**
   * 通知瓦片加载成功。
   *
   * @param sourceId - 数据源 id
   * @param coord - 瓦片坐标
   * @param data - 瓦片数据（MVP 不解析）
   */
  onTileLoaded(sourceId: string, coord: TileCoord, data: any): void;
  /**
   * 通知瓦片加载失败。
   *
   * @param sourceId - 数据源 id
   * @param coord - 瓦片坐标
   * @param error - 错误对象
   */
  onTileError(sourceId: string, coord: TileCoord, error: Error): void;
  /** 重新将所有已注册瓦片标记为需要 reload（MVP：清空非 cached 状态并触发队列刷新） */
  reloadAll(): void;
  /**
   * 清理缓存。
   *
   * @param sourceId - 若提供则只清理该 source；否则清理全部
   */
  clearCache(sourceId?: string): void;
  /** 统计信息（只读） */
  readonly stats: {
    /** 最近一帧可见瓦片总数（跨 source） */
    readonly visibleCount: number;
    /** 当前 loading 数（跨 source） */
    readonly loadingCount: number;
    /** 当前 cached/loaded 总数（跨 source） */
    readonly cachedCount: number;
    /** 历史累计加载成功次数 */
    readonly totalLoaded: number;
    /** 历史累计加载失败次数 */
    readonly totalErrors: number;
    /** 本帧候选池的平均综合优先级分数（无候选时为 0） */
    readonly avgTilePriority: number;
    /** 本帧经 LOD 降级后（使用更低 zoom 祖先）的瓦片数（去重后） */
    readonly lodDecreasedTileCount: number;
    /** 本帧相对中心 zoom 的最大降级档数（整数，0 表示未降级） */
    readonly maxZoomDelta: number;
  };
}

/**
 * 将数值限制为有限数。
 *
 * @param v - 输入
 * @param fallback - 回退值
 * @returns 有限数
 *
 * @example
 * const x = finiteNumber(NaN, 0);
 */
function finiteNumber(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * clamp 整数并保证非负。
 *
 * @param v - 输入
 * @param lo - 下界
 * @param hi - 上界
 * @returns clamp 后的整数
 *
 * @example
 * const z = clampInt(10, 0, 3); // → 3
 */
function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(finiteNumber(v, lo));
  // 先 floor 再 clamp，避免 zoom 小数带来的边界抖动
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 将经度限制在 WebMercator 常用范围内，避免 tile x 计算溢出。
 *
 * @param lonDeg - 经度（度）
 * @returns 钳制后的经度
 *
 * @example
 * const lon = clampLon(200); // → 180
 */
function clampLon(lonDeg: number): number {
  const lon = finiteNumber(lonDeg, 0);
  // Web 地图通常允许环绕；但 XYZ tile x 计算使用 -180..180 更稳定
  return Math.max(-180, Math.min(180, lon));
}

/**
 * 将纬度限制在墨卡托投影有效范围内，避免 log/tan 发散。
 *
 * @param latDeg - 纬度（度）
 * @returns 钳制后的纬度
 *
 * @example
 * const lat = clampLat(89.9);
 */
function clampLat(latDeg: number): number {
  const lat = finiteNumber(latDeg, 0);
  return Math.max(-MAX_LAT_CLAMP, Math.min(MAX_LAT_CLAMP, lat));
}

/**
 * 计算 2^z（z 为非负整数）。
 *
 * @param z - zoom
 * @returns 栅格尺寸
 *
 * @example
 * const n = exp2z(3); // → 8
 */
function exp2z(z: number): number {
  const zz = clampInt(z, 0, 30);
  // 30 级是实用上限：避免 2**z 过大导致 Number 精度问题
  return 2 ** zz;
}

/**
 * 经纬度转 XYZ 瓦片坐标（WebMercator / Spherical Mercator）。
 *
 * @param lonDeg - 经度
 * @param latDeg - 纬度
 * @param z - zoom（整数）
 * @returns 瓦片 x/y（已 clamp 到网格内）
 *
 * @example
 * const t = lonLatToTileXY(116.4, 39.9, 10);
 */
function lonLatToTileXY(lonDeg: number, latDeg: number, z: number): { readonly x: number; readonly y: number } {
  const lon = clampLon(lonDeg);
  const lat = clampLat(latDeg);
  const n = exp2z(z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  // WebMercator：使用 sinh 形式避免 tan 在极点附近溢出（更稳）
  const sinLat = Math.sin(latRad);
  const y = Math.floor(
    ((1 - Math.log((1 + sinLat) / Math.max(EPS, 1 - sinLat)) / Math.PI) / 2) * n,
  );
  const xx = clampInt(x, 0, n - 1);
  const yy = clampInt(y, 0, n - 1);
  return { x: xx, y: yy };
}

/**
 * 从瓦片号反推瓦片地理包围盒（经纬度）。
 *
 * @param x - tile x
 * @param y - tile y
 * @param z - zoom
 * @returns 包围盒
 *
 * @example
 * const bb = tileToBBox(0, 0, 0);
 */
function tileToBBox(x: number, y: number, z: number): BBox2D {
  const n = exp2z(z);
  const xx = clampInt(x, 0, n - 1);
  const yy = clampInt(y, 0, n - 1);
  const west = (xx / n) * 360 - 180;
  const east = ((xx + 1) / n) * 360 - 180;
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (yy + 1)) / n)));
  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;
  return { west, south, east, north };
}

/**
 * 判断两个经纬度包围盒是否相交（包含边界）。
 *
 * @param a - A
 * @param b - B
 * @returns 是否相交
 *
 * @example
 * ok = bboxIntersects({west:-1,south:-1,east:1,north:1},{west:0,south:0,east:2,north:2});
 */
function bboxIntersects(a: BBox2D, b: BBox2D): boolean {
  if (a.west > b.east || a.east < b.west) {
    return false;
  }
  if (a.south > b.north || a.north < b.south) {
    return false;
  }
  return true;
}

/**
 * 将相机 zoom 映射到数据 zoom（考虑过 zoom）。
 *
 * @param cameraZoom - 相机 zoom（连续）
 * @param minZ - 最小 zoom
 * @param maxZ - 最大 zoom
 * @param overzoomEnabled - 是否启用过 zoom
 * @param overzoomLevels - 过 zoom 裕量
 * @returns 选用的整数 zoom
 *
 * @example
 * const z = pickTileZoom(15.2, 0, 14, true, 2); // → 14
 */
function pickTileZoom(
  cameraZoom: number,
  minZ: number,
  maxZ: number,
  overzoomEnabled: boolean,
  overzoomLevels: number,
): number {
  const minZZ = clampInt(minZ, 0, 30);
  const maxZZ = clampInt(maxZ, minZZ, 30);
  const zFloat = finiteNumber(cameraZoom, minZZ);
  let z = clampInt(Math.floor(zFloat + EPS), minZZ, maxZZ);
  if (overzoomEnabled && zFloat > maxZZ + finiteNumber(overzoomLevels, 0)) {
    // 过 zoom：仍采样 maxZZ 的瓦片，由渲染侧拉伸/锐化策略处理
    z = maxZZ;
  }
  return z;
}

/**
 * 估算屏幕能覆盖的瓦片跨度（MVP：按 CSS 像素与 tileSize 粗略换算）。
 *
 * @param viewport - 视口
 * @param tileSize - 瓦片像素大小
 * @returns {spanX, spanY}
 *
 * @example
 * const s = estimateVisibleSpan(vp, 256);
 */
function estimateVisibleSpan(viewport: Viewport, tileSize: number): { spanX: number; spanY: number } {
  const w = Math.max(1, Math.floor(finiteNumber(viewport.width, 1)));
  const h = Math.max(1, Math.floor(finiteNumber(viewport.height, 1)));
  const ts = Math.max(MIN_TILE_SIZE_PX, finiteNumber(tileSize, 256));
  // 用视口像素与瓦片像素估计“覆盖多少格瓦片”：MVP 近似，避免引入完整投影逆变换
  const spanX = Math.max(1, Math.ceil(w / ts) + 2);
  const spanY = Math.max(1, Math.ceil(h / ts) + 2);
  return { spanX, spanY };
}

/**
 * 计算候选瓦片的 SSE 代理量与距离代理量。
 *
 * @param coord - 目标瓦片
 * @param centerTileX - 中心 tile x
 * @param centerTileY - 中心 tile y
 * @param cameraZoom - 相机 zoom
 * @param pitch - pitch（弧度）
 * @param cfg - 调度配置
 * @returns {distance, sse}
 *
 * @example
 * const m = measurePriority(tile, cx, cy, 12.2, 0.2, cfg);
 */
function measurePriority(
  coord: TileCoord,
  centerTileX: number,
  centerTileY: number,
  cameraZoom: number,
  pitch: number,
  cfg: TileSchedulerConfig,
): { distance: number; screenSpaceError: number } {
  const dx = coord.x - centerTileX;
  const dy = coord.y - centerTileY;
  const distance = Math.hypot(dx, dy);
  const z = coord.z;
  const zoom = finiteNumber(cameraZoom, z);
  // zoom 与瓦片层级不一致会产生“过采样/欠采样”误差感：作为 SSE 主项
  const levelMismatch = Math.abs(zoom - z);
  const pitchPenalty = 1 + finiteNumber(pitch, 0) * cfg.pitchPriorityReduction;
  // 距离项：离中心越远，越可能只在屏幕边缘，SSE 等效更高
  const distTerm = distance / 8;
  const sse = (levelMismatch * 256 + distTerm * 64) * pitchPenalty;
  return { distance, screenSpaceError: sse };
}

/**
 * 计算瓦片的多因子综合优先级（越大越应优先加载）。
 * SSE 项为 `sse / maxSSE`（钳制到 [0,1]）再乘 `priorityWeights.sse`；
 * 可见性：与视锥相交为 1 否则 0，乘 `priorityWeights.visibility`；
 * 缓存：已 resident（loaded/cached）为 1 否则 0，乘 `priorityWeights.cache`。
 *
 * @param tile - 瓦片坐标（保留用于未来扩展）
 * @param camera - 相机状态（保留用于未来真视锥测试；2D MVP 由调用方传入 metrics）
 * @param config - 含 `maxSSE` 与 `priorityWeights`
 * @param metrics - 当前瓦片的 SSE、与视锥相交、是否已缓存
 * @returns 加权和
 */
export function computeTilePriority(
  tile: TileCoord,
  camera: CameraState,
  config: TileSchedulerConfig,
  metrics: {
    /** 屏幕空间误差代理量（与 measurePriority 一致） */
    readonly sse: number;
    /** 与相机视锥相交；2D MVP 使用严格可见窗口 */
    readonly intersectsFrustum: boolean;
    /** 已为 loaded 或 cached */
    readonly inCache: boolean;
  },
): number {
  try {
    void tile;
    void camera;
    const w = config.priorityWeights;
    const maxS = Math.max(EPS, finiteNumber(config.maxSSE, DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD));
    const sseRaw = finiteNumber(metrics.sse, 0);
    const sseNorm = Math.min(1, Math.max(0, sseRaw / maxS));
    const sseScore = sseNorm * w.sse;
    const visibilityScore = (metrics.intersectsFrustum ? 1 : 0) * w.visibility;
    const cacheScore = (metrics.inCache ? 1 : 0) * w.cache;
    return sseScore + visibilityScore + cacheScore;
  } catch (err) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[TileScheduler] computeTilePriority failed', err);
    }
    return 0;
  }
}

/**
 * 生成瓦片 key（不含 sourceId，用于单表内索引）。
 *
 * @param c - 瓦片坐标
 * @returns key
 *
 * @example
 * const k = tileKey({x:1,y:2,z:3}); // '1:2:3'
 */
function tileKey(c: TileCoord): string {
  return `${c.x}:${c.y}:${c.z}`;
}

/**
 * 合并默认配置。
 *
 * @param partial - 部分配置
 * @returns 完整配置
 *
 * @example
 * const c = mergeTileSchedulerConfig({ maxCacheSize: 1024 });
 */
function mergeTileSchedulerConfig(partial?: Partial<TileSchedulerConfig>): TileSchedulerConfig {
  const p = partial ?? {};
  const pw: Partial<TileSchedulerConfig['priorityWeights']> = p.priorityWeights ?? {};
  const tl: Partial<TileLodConfig> = p.tileLod ?? {};
  const maxLevels = Math.max(1, Math.min(8, Math.floor(finiteNumber(tl.maxZoomLevelsOnScreen ?? DEFAULT_TILE_LOD_MAX_LEVELS_ON_SCREEN, DEFAULT_TILE_LOD_MAX_LEVELS_ON_SCREEN))));
  const ratio = Math.max(1, Math.min(10, finiteNumber(tl.tileCountMaxMinRatio ?? DEFAULT_TILE_LOD_TILE_COUNT_MAX_MIN_RATIO, DEFAULT_TILE_LOD_TILE_COUNT_MAX_MIN_RATIO)));
  return {
    maxConcurrentLoads: Math.max(1, Math.floor(finiteNumber(p.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT_LOADS, DEFAULT_MAX_CONCURRENT_LOADS))),
    maxCacheSize: Math.max(1, Math.floor(finiteNumber(p.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_SIZE))),
    screenSpaceErrorThreshold: Math.max(
      EPS,
      finiteNumber(p.screenSpaceErrorThreshold ?? DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD, DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD),
    ),
    overzoomLevels: Math.max(0, Math.floor(finiteNumber(p.overzoomLevels ?? DEFAULT_OVERZOOM_LEVELS, DEFAULT_OVERZOOM_LEVELS))),
    prefetchZoomDelta: Math.max(0, Math.floor(finiteNumber(p.prefetchZoomDelta ?? DEFAULT_PREFETCH_ZOOM_DELTA, DEFAULT_PREFETCH_ZOOM_DELTA))),
    pitchPriorityReduction: Math.max(0, finiteNumber(p.pitchPriorityReduction ?? DEFAULT_PITCH_PRIORITY_REDUCTION, DEFAULT_PITCH_PRIORITY_REDUCTION)),
    maxSSE: Math.max(
      EPS,
      finiteNumber(
        p.maxSSE ?? p.screenSpaceErrorThreshold ?? DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD,
        DEFAULT_SCREEN_SPACE_ERROR_THRESHOLD,
      ),
    ),
    priorityWeights: {
      sse: Math.max(0, finiteNumber(pw.sse ?? DEFAULT_PRIORITY_WEIGHT_SSE, DEFAULT_PRIORITY_WEIGHT_SSE)),
      visibility: Math.max(0, finiteNumber(pw.visibility ?? DEFAULT_PRIORITY_WEIGHT_VISIBILITY, DEFAULT_PRIORITY_WEIGHT_VISIBILITY)),
      cache: Math.max(0, finiteNumber(pw.cache ?? DEFAULT_PRIORITY_WEIGHT_CACHE, DEFAULT_PRIORITY_WEIGHT_CACHE)),
    },
    tileLod: {
      maxZoomLevelsOnScreen: maxLevels,
      tileCountMaxMinRatio: ratio,
    },
  };
}

/**
 * 校验 TileSourceOptions。
 *
 * @param options - 输入
 * @returns 合法化后的 options
 *
 * @example
 * const o = normalizeSourceOptions({ minZoom:0,maxZoom:22,tileSize:256,overzoomEnabled:true });
 */
function normalizeSourceOptions(options: TileSourceOptions): TileSourceOptions {
  const minZoom = clampInt(options.minZoom, 0, 30);
  const maxZoom = clampInt(options.maxZoom, minZoom, 30);
  const tileSize = Math.max(MIN_TILE_SIZE_PX, finiteNumber(options.tileSize, 256));
  const bounds = options.bounds;
  if (bounds) {
    const west = finiteNumber(bounds.west, -180);
    const east = finiteNumber(bounds.east, 180);
    const south = finiteNumber(bounds.south, -90);
    const north = finiteNumber(bounds.north, 90);
    return {
      minZoom,
      maxZoom,
      tileSize,
      bounds: {
        west: Math.min(west, east),
        east: Math.max(west, east),
        south: Math.min(south, north),
        north: Math.max(south, north),
      },
      overzoomEnabled: Boolean(options.overzoomEnabled),
    };
  }
  return { minZoom, maxZoom, tileSize, overzoomEnabled: Boolean(options.overzoomEnabled) };
}

/**
 * 计算父瓦片坐标（用于 placeholder）。
 *
 * @param coord - 子瓦片
 * @returns 父瓦片坐标（z-1），若 z=0 则返回自身
 *
 * @example
 * const p = parentTile({x:3,y:4,z:3});
 */
function parentTile(coord: TileCoord): TileCoord {
  if (coord.z <= 0) {
    return { x: coord.x, y: coord.y, z: coord.z };
  }
  const z = coord.z - 1;
  const x = Math.floor(coord.x / 2);
  const y = Math.floor(coord.y / 2);
  return { x, y, z };
}

/**
 * 创建 TileScheduler。
 *
 * @param config - 可选部分配置
 * @returns TileScheduler 实例
 *
 * @example
 * const ts = createTileScheduler({ maxConcurrentLoads: 8 });
 * ts.registerSource('osm', { minZoom:0,maxZoom:19,tileSize:256,overzoomEnabled:true });
 */
export function createTileScheduler(config?: Partial<TileSchedulerConfig>): TileScheduler {
  let cfg = mergeTileSchedulerConfig(config);

  let frameCounter = 0;
  let totalLoaded = 0;
  let totalErrors = 0;

  const sources = new Map<string, SourceEntry>();
  const tiles = new Map<string, Map<string, TileRecord>>();

  let lastVisibleCount = 0;
  let lastLoadingCount = 0;
  let lastCachedCount = 0;

  const lastVisibleBySource = new Map<string, TileCoord[]>();

  const getTable = (sourceId: string): Map<string, TileRecord> => {
    let t = tiles.get(sourceId);
    if (!t) {
      t = new Map();
      tiles.set(sourceId, t);
    }
    return t;
  };

  const getRecord = (sourceId: string, coord: TileCoord, create: boolean): TileRecord | undefined => {
    const table = getTable(sourceId);
    const k = tileKey(coord);
    const existing = table.get(k);
    if (existing || !create) {
      return existing;
    }
    const rec: TileRecord = { state: 'empty', lastAccessFrame: frameCounter };
    table.set(k, rec);
    return rec;
  };

  /**
   * 统计所有 source 中处于指定状态的瓦片条目数量。
   *
   * @param state - 目标状态
   * @returns 数量
   *
   * @example
   * const n = countTilesByState('loading');
   */
  const countTilesByState = (state: TileState): number => {
    let n = 0;
    for (const table of tiles.values()) {
      for (const rec of table.values()) {
        if (rec.state === state) {
          n += 1;
        }
      }
    }
    return n;
  };

  /**
   * 内部候选行：用于在多数据源下把 `TilePriority` 与 `sourceId` 绑定（不暴露到公共类型）。
   */
  type CandidateRow = { readonly sourceId: string; readonly priority: TilePriority };

  /** 最近一帧候选池的平均综合优先级（无候选时为 0） */
  let lastAvgTilePriority = 0;
  /** 最近一帧 LOD 降级后的瓦片数（去重后，跨 source 累计） */
  let lastLodDecreasedTileCount = 0;
  /** 最近一帧最大 zoom 降级档数 */
  let lastMaxZoomDelta = 0;

  const scheduler: TileScheduler = {
    get config(): TileSchedulerConfig {
      return cfg;
    },

    updateConfig(partial: Partial<TileSchedulerConfig>): void {
      const mergedPartial =
        partial.priorityWeights !== undefined
          ? { ...partial, priorityWeights: { ...cfg.priorityWeights, ...partial.priorityWeights } }
          : partial;
      const tileLodMerged =
        partial.tileLod !== undefined ? { ...cfg.tileLod, ...partial.tileLod } : cfg.tileLod;
      cfg = mergeTileSchedulerConfig({ ...cfg, ...mergedPartial, tileLod: tileLodMerged });
    },

    get stats() {
      return {
        visibleCount: lastVisibleCount,
        loadingCount: lastLoadingCount,
        cachedCount: lastCachedCount,
        totalLoaded,
        totalErrors,
        avgTilePriority: lastAvgTilePriority,
        lodDecreasedTileCount: lastLodDecreasedTileCount,
        maxZoomDelta: lastMaxZoomDelta,
      };
    },

    registerSource(sourceId: string, options: TileSourceOptions): void {
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return;
      }
      sources.set(sourceId, { options: normalizeSourceOptions(options) });
      if (!tiles.has(sourceId)) {
        tiles.set(sourceId, new Map());
      }
    },

    unregisterSource(sourceId: string): void {
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return;
      }
      sources.delete(sourceId);
      tiles.delete(sourceId);
      lastVisibleBySource.delete(sourceId);
    },

    getTileState(coord: TileCoord, sourceId: string): TileState {
      const table = tiles.get(sourceId);
      if (!table) {
        return 'empty';
      }
      const rec = table.get(tileKey(coord));
      return rec ? rec.state : 'empty';
    },

    getVisibleTiles(sourceId: string): TileCoord[] {
      const v = lastVisibleBySource.get(sourceId);
      return v ? v.slice() : [];
    },

    getCachedTiles(sourceId: string): TileCoord[] {
      const table = tiles.get(sourceId);
      if (!table) {
        return [];
      }
      const out: TileCoord[] = [];
      for (const [k, rec] of table.entries()) {
        if (rec.state === 'loaded' || rec.state === 'cached') {
          const parts = k.split(':');
          if (parts.length !== 3) {
            continue;
          }
          const x = Number(parts[0]);
          const y = Number(parts[1]);
          const z = Number(parts[2]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
          }
          out.push({ x, y, z });
        }
      }
      return out;
    },

    update(camera: CameraState, viewport: Viewport): TileScheduleResult {
      frameCounter += 1;

      const candidates: CandidateRow[] = [];
      const toUnload: TileCoord[] = [];
      const visibleAll: TileCoord[] = [];
      const placeholder = new Map<string, TileCoord>();

      const centerLon = clampLon(camera.center[0]);
      const centerLat = clampLat(camera.center[1]);
      const cameraZoom = finiteNumber(camera.zoom, 0);
      const pitch = finiteNumber(camera.pitch, 0);

      lastLodDecreasedTileCount = 0;
      lastMaxZoomDelta = 0;

      for (const [sourceId, entry] of sources.entries()) {
        const opt = entry.options;
        const z = pickTileZoom(cameraZoom, opt.minZoom, opt.maxZoom, opt.overzoomEnabled, cfg.overzoomLevels);
        const spanBase = estimateVisibleSpan(viewport, opt.tileSize);
        const cx = lonLatToTileXY(centerLon, centerLat, z).x;
        const cy = lonLatToTileXY(centerLon, centerLat, z).y;

        const prefetch = cfg.prefetchZoomDelta;
        // 预取：在基础跨度上向四周扩展（Chebyshev 半径），避免把预取当作“可见”
        const spanX = spanBase.spanX + 2 * prefetch;
        const spanY = spanBase.spanY + 2 * prefetch;

        const n = exp2z(z);
        const x0 = clampInt(cx - Math.floor(spanX / 2), 0, n - 1);
        const x1 = clampInt(cx + Math.floor(spanX / 2), 0, n - 1);
        const y0 = clampInt(cy - Math.floor(spanY / 2), 0, n - 1);
        const y1 = clampInt(cy + Math.floor(spanY / 2), 0, n - 1);

        const xc0 = clampInt(cx - Math.floor(spanBase.spanX / 2), 0, n - 1);
        const xc1 = clampInt(cx + Math.floor(spanBase.spanX / 2), 0, n - 1);
        const yc0 = clampInt(cy - Math.floor(spanBase.spanY / 2), 0, n - 1);
        const yc1 = clampInt(cy + Math.floor(spanBase.spanY / 2), 0, n - 1);

        const visibleForSource: TileCoord[] = [];

        /** 经距离 LOD 合并后的条目（key = tileKey(effective)） */
        const lodMerged = new Map<
          string,
          { readonly coord: TileCoord; readonly maxDistance: number; readonly zoomDelta: number; visible: boolean }
        >();

        for (let y = y0; y <= y1; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            const gridCoord: TileCoord = { x, y, z };
            if (opt.bounds) {
              const bb = tileToBBox(x, y, z);
              if (!bboxIntersects(bb, opt.bounds)) {
                continue;
              }
            }

            const distance = Math.hypot(x - cx, y - cy);
            let desiredZ: number;
            try {
              desiredZ = computeTileZoomAtDistance(
                z,
                distance,
                TILE_LOD_CENTER_DISTANCE_TILE_UNITS,
                cfg.tileLod.maxZoomLevelsOnScreen,
              );
            } catch (errLod) {
              if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[TileScheduler] computeTileZoomAtDistance in update failed', errLod);
              }
              desiredZ = z;
            }
            const clampedDesired = clampInt(desiredZ, opt.minZoom, z);
            const effective = tileDownToZoom(gridCoord, clampedDesired, opt.minZoom);
            const zoomDelta = z - effective.z;
            const kEff = tileKey(effective);
            const isVisibleCell = x >= xc0 && x <= xc1 && y >= yc0 && y <= yc1;
            const prev = lodMerged.get(kEff);
            if (!prev) {
              lodMerged.set(kEff, {
                coord: effective,
                maxDistance: distance,
                zoomDelta,
                visible: isVisibleCell,
              });
            } else {
              lodMerged.set(kEff, {
                coord: effective,
                maxDistance: Math.max(prev.maxDistance, distance),
                zoomDelta: Math.max(prev.zoomDelta, zoomDelta),
                visible: prev.visible || isVisibleCell,
              });
            }
          }
        }

        const baseTileCount = Math.max(1, (xc1 - xc0 + 1) * (yc1 - yc0 + 1));
        const maxTileCount = Math.max(1, Math.floor(baseTileCount * cfg.tileLod.tileCountMaxMinRatio));
        if (lodMerged.size > maxTileCount) {
          const ranked = Array.from(lodMerged.entries());
          ranked.sort((a, b) => b[1].maxDistance - a[1].maxDistance);
          const drop = lodMerged.size - maxTileCount;
          for (let di = 0; di < drop; di += 1) {
            const head = ranked[di];
            if (head) {
              lodMerged.delete(head[0]);
            }
          }
        }

        for (const v of lodMerged.values()) {
          if (v.zoomDelta > 0) {
            lastLodDecreasedTileCount += 1;
          }
          if (v.zoomDelta > lastMaxZoomDelta) {
            lastMaxZoomDelta = v.zoomDelta;
          }
        }

        for (const v of lodMerged.values()) {
          const coord = v.coord;
          if (opt.bounds) {
            const bbEff = tileToBBox(coord.x, coord.y, coord.z);
            if (!bboxIntersects(bbEff, opt.bounds)) {
              continue;
            }
          }

          const centerAtZ = lonLatToTileXY(centerLon, centerLat, coord.z);
          const m = measurePriority(coord, centerAtZ.x, centerAtZ.y, cameraZoom, pitch, cfg);
          const isVisible = v.visible;
          const isNeeded = true;

          const rec = getRecord(sourceId, coord, true);
          if (!rec) {
            continue;
          }
          rec.lastAccessFrame = frameCounter;

          if (isVisible) {
            visibleForSource.push(coord);
            visibleAll.push(coord);
          }

          if (rec.state !== 'loaded' && rec.state !== 'cached') {
            let p = parentTile(coord);
            let guard = 0;
            while (guard < 32 && p.z >= opt.minZoom) {
              const pr = getRecord(sourceId, p, false);
              if (pr && (pr.state === 'loaded' || pr.state === 'cached')) {
                placeholder.set(`${sourceId}:${tileKey(coord)}`, p);
                break;
              }
              p = parentTile(p);
              guard += 1;
            }
          }

          if (!isNeeded) {
            continue;
          }

          if (m.screenSpaceError > cfg.screenSpaceErrorThreshold) {
            continue;
          }

          if (rec.state === 'empty' || rec.state === 'error') {
            const priorityScore = computeTilePriority(coord, camera, cfg, {
              sse: m.screenSpaceError,
              intersectsFrustum: isVisible,
              inCache: false,
            });
            candidates.push({
              sourceId,
              priority: {
                coord,
                distance: m.distance,
                screenSpaceError: m.screenSpaceError,
                priorityScore,
                isVisible,
                isNeeded,
              },
            });
          }
        }

        lastVisibleBySource.set(sourceId, visibleForSource);
      }

      let sumTilePriority = 0;
      for (const row of candidates) {
        sumTilePriority += row.priority.priorityScore;
      }
      lastAvgTilePriority = candidates.length > 0 ? sumTilePriority / candidates.length : 0;

      // 并发加载限制：按多因子优先级降序，再按距离与坐标稳定排序
      candidates.sort((a, b) => {
        const ap = a.priority.priorityScore;
        const bp = b.priority.priorityScore;
        if (bp !== ap) {
          return bp - ap;
        }
        if (a.priority.distance !== b.priority.distance) {
          return a.priority.distance - b.priority.distance;
        }
        if (a.priority.coord.z !== b.priority.coord.z) {
          return b.priority.coord.z - a.priority.coord.z;
        }
        if (a.priority.coord.x !== b.priority.coord.x) {
          return a.priority.coord.x - b.priority.coord.x;
        }
        if (a.priority.coord.y !== b.priority.coord.y) {
          return a.priority.coord.y - b.priority.coord.y;
        }
        return a.sourceId.localeCompare(b.sourceId);
      });

      const loadingExisting = countTilesByState('loading');
      let allowed = Math.max(0, cfg.maxConcurrentLoads - loadingExisting);
      const chosen: TilePriority[] = [];

      for (const row of candidates) {
        if (allowed <= 0) {
          break;
        }
        const rec = getRecord(row.sourceId, row.priority.coord, true);
        if (!rec) {
          continue;
        }
        // 竞态：在排序后可能已被其它路径改为 loading/loaded
        if (rec.state !== 'empty' && rec.state !== 'error') {
          continue;
        }
        rec.state = 'loading';
        rec.lastAccessFrame = frameCounter;
        chosen.push(row.priority);
        allowed -= 1;
      }

      // 缓存淘汰：全局 LRU（按 lastAccessFrame）
      let totalCachedEntries = 0;
      const cacheList: Array<{ sourceId: string; key: string; frame: number; coord: TileCoord }> = [];
      for (const [sourceId, table] of tiles.entries()) {
        if (!sources.has(sourceId)) {
          continue;
        }
        for (const [key, rec] of table.entries()) {
          if (rec.state === 'loaded' || rec.state === 'cached') {
            totalCachedEntries += 1;
            const parts = key.split(':');
            if (parts.length !== 3) {
              continue;
            }
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            const zz = Number(parts[2]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zz)) {
              continue;
            }
            cacheList.push({ sourceId, key, frame: rec.lastAccessFrame, coord: { x, y, z: zz } });
          }
        }
      }

      if (totalCachedEntries > cfg.maxCacheSize) {
        cacheList.sort((a, b) => a.frame - b.frame);
        const need = totalCachedEntries - cfg.maxCacheSize;
        let freed = 0;
        let idx = 0;
        // 可能大量条目受“仍可见”保护：扫描全表直到凑够淘汰数量或耗尽候选
        while (freed < need && idx < cacheList.length) {
          const item = cacheList[idx];
          idx += 1;
          const table = tiles.get(item.sourceId);
          if (!table) {
            continue;
          }
          const rec = table.get(item.key);
          if (!rec) {
            continue;
          }
          // 仅保护“该 source 的可见集合”中的瓦片，避免跨 source 坐标偶合误判
          const stillVisibleForSource = lastVisibleBySource.get(item.sourceId)?.some(
            (c) => c.x === item.coord.x && c.y === item.coord.y && c.z === item.coord.z,
          );
          if (stillVisibleForSource) {
            continue;
          }
          table.delete(item.key);
          toUnload.push(item.coord);
          freed += 1;
        }
      }

      lastVisibleCount = visibleAll.length;
      lastLoadingCount = countTilesByState('loading');
      lastCachedCount = countTilesByState('loaded') + countTilesByState('cached');

      return {
        toLoad: chosen,
        toUnload,
        visible: visibleAll,
        placeholder,
      };
    },

    onTileLoaded(sourceId: string, coord: TileCoord, data: any): void {
      void data;
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return;
      }
      const rec = getRecord(sourceId, coord, true);
      if (!rec) {
        return;
      }
      rec.state = 'loaded';
      rec.lastErrorMessage = undefined;
      rec.lastAccessFrame = frameCounter;
      totalLoaded += 1;
    },

    onTileError(sourceId: string, coord: TileCoord, error: Error): void {
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return;
      }
      const rec = getRecord(sourceId, coord, true);
      if (!rec) {
        return;
      }
      rec.state = 'error';
      rec.lastErrorMessage = String(error?.message ?? 'error');
      rec.lastAccessFrame = frameCounter;
      totalErrors += 1;
    },

    reloadAll(): void {
      for (const table of tiles.values()) {
        for (const rec of table.values()) {
          if (rec.state === 'loading') {
            // loading 中不强制打断：避免与网络层竞态；仅标记空/错误重试
            continue;
          }
          if (rec.state === 'loaded' || rec.state === 'cached') {
            rec.state = 'empty';
          }
        }
      }
    },

    clearCache(sourceId?: string): void {
      if (typeof sourceId === 'string' && sourceId.length > 0) {
        tiles.delete(sourceId);
        getTable(sourceId);
        lastVisibleBySource.delete(sourceId);
        return;
      }
      tiles.clear();
      lastVisibleBySource.clear();
      for (const sid of sources.keys()) {
        getTable(sid);
      }
    },
  };

  return scheduler;
}
