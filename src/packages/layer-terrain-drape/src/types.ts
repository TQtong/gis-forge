// ============================================================
// layer-terrain-drape/types.ts — 常量 + 公共接口
//
// 参照 Mapbox GL v3 / MapLibre / Cesium 的单层地形架构：
//   • 所有瓦片共享 singleton grid mesh
//   • DEM 作为 GPU 纹理，vertex shader 内采样
//   • 无 DEM 时绑 1×1 零纹理 → 纯平面
// ============================================================

// ---------------------------------------------------------------------------
// Grid mesh 常量
// ---------------------------------------------------------------------------

/** 每条边分段数（128×128 格 = 16641 顶点 / 98304 索引） */
export const GRID_N = 128;
/** 顶点总数 */
export const GRID_VERTS = (GRID_N + 1) * (GRID_N + 1);
/** 索引总数（三角形 × 3） */
export const GRID_INDICES = GRID_N * GRID_N * 6;

// ---------------------------------------------------------------------------
// 瓦片 & DEM 常量
// ---------------------------------------------------------------------------

/** Web Mercator 世界像素分辨率的瓦片尺寸 */
export const TILE_PIXEL_SIZE = 512;
/** DEM 纹理尺寸（65×65 与 Cesium HeightmapTerrainData 对齐） */
export const DEM_TEX_SIZE = 65;
/** 地球半径（米） */
export const EARTH_RADIUS = 6378137;
/** 地球周长 */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

// ---------------------------------------------------------------------------
// 调度 & 缓存常量
// ---------------------------------------------------------------------------

/** LRU 最大条目数 */
export const CACHE_MAX_ENTRIES = 1024;
/** LRU 最大字节 (512 MB) */
export const CACHE_MAX_BYTES = 512 * 1024 * 1024;
/** 每帧最多新触发的瓦片加载数 */
export const LOAD_BUDGET_PER_FRAME = 8;
/** 单帧最多调度瓦片总数 */
export const MAX_SCHEDULED_TILES = 200;
/** IoU 节流阈值 */
export const SCHEDULE_IOU_THRESHOLD = 0.9;
/** 强制刷新间隔（帧） */
export const SCHEDULE_MAX_SKIP_FRAMES = 30;

// ---------------------------------------------------------------------------
// Uniform buffer 大小
// ---------------------------------------------------------------------------

/** CameraUniforms: mat4x4(64) + vec4(16) = 80 bytes */
export const CAMERA_UB_SIZE = 80;
/** StyleUniforms: vec4(16) + vec4(16) = 32 bytes */
export const STYLE_UB_SIZE = 32;
/** TileUniforms: vec4(bboxZ0, 16) + vec4(heightInfo, 16) = 32 bytes */
export const TILE_UB_SIZE = 32;

// ---------------------------------------------------------------------------
// 外部配置接口
// ---------------------------------------------------------------------------

export interface TerrainDrapeLayerOptions {
  readonly id: string;
  /** OSM/卫星 raster URL 模板，含 {z}/{x}/{y} */
  readonly rasterUrlTemplate: string;
  readonly rasterMaxZoom?: number;
  /** 可选 Cesium QM 地形服务根 URL（末尾含 /） */
  readonly elevationUrl?: string;
  readonly elevationMaxZoom?: number;
  /** 高程夸张系数，默认 1.5 */
  readonly exaggeration?: number;
  /** 不透明度，默认 1 */
  readonly opacity?: number;
  /** hillshade 强度（0=无，0.15=默认，1=极强） */
  readonly hillshadeStrength?: number;
  /** 光照方向（世界空间），默认 [-0.5, -0.7, 1.0] */
  readonly lightDirection?: readonly [number, number, number];
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

// ---------------------------------------------------------------------------
// 瓦片缓存条目
// ---------------------------------------------------------------------------

export interface TerrainDrapeTileEntry {
  key: string;
  z: number;
  x: number;
  y: number;
  /** 'loading' = 至少有一个资源在加载中；'ready' = drape ready（DEM 可选）；'error' */
  state: 'loading' | 'ready' | 'error';
  /** OSM drape 纹理（owned） */
  drapeTex: GPUTexture | null;
  /** DEM 纹理（owned，R16Float 或 R8Unorm） */
  demTex: GPUTexture | null;
  /** 完整 bind group（tileUB + sampler + demTex + drapeTex） */
  tileBindGroup: GPUBindGroup | null;
  /** 每瓦片 uniform buffer */
  tileUB: GPUBuffer | null;
  /** 该瓦片是否有真实 DEM（否则绑零纹理） */
  hasElevation: boolean;
  /** 高度范围（米），[min, max] */
  heightRange: [number, number];
  /** 内存估算 */
  byteSize: number;
  errorCount: number;
  // LRU 双向链表
  prev: TerrainDrapeTileEntry | null;
  next: TerrainDrapeTileEntry | null;
}

// ---------------------------------------------------------------------------
// Elevation Source 接口（可插拔：Cesium QM / Mapbox RGB / Terrarium）
// ---------------------------------------------------------------------------

export interface DemTileData {
  /** 归一化高度 [0, 1]，行主序 width×height floats */
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  /** 实际最低高度（米） */
  readonly minHeight: number;
  /** 实际最高高度（米） */
  readonly maxHeight: number;
}

export interface ElevationSource {
  initialize(): Promise<void>;
  readonly ready: boolean;
  /** 该 Mercator XYZ 瓦片是否有 DEM 覆盖 */
  hasTile(z: number, x: number, y: number): boolean;
  /** 异步获取归一化 DEM 数据（65×65 Float32） */
  loadDem(z: number, x: number, y: number): Promise<DemTileData | null>;
}
