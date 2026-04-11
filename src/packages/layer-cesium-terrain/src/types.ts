// ============================================================
// layer-cesium-terrain/types.ts — 公共类型与常量
// ============================================================

import type { TileCoord } from '../../core/src/types/tile.ts';

/** Web Mercator 世界像素分辨率的瓦片尺寸（与 layer-tile-raster 对齐） */
export const TILE_PIXEL_SIZE = 512;

/** 地球平均半径（米），用于 metersPerPixel 换算 */
export const EARTH_RADIUS_METERS = 6378137;

/** 地球周长（米） */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS_METERS;

/** 角度↔弧度常量 */
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** quantized-mesh 顶点坐标量化精度（spec：14 bit，范围 0..32767） */
export const QM_COORD_RANGE = 32767;

/** Cesium quantized-mesh 扩展 ID */
export const QM_EXT_OCT_VERTEX_NORMALS = 1;
export const QM_EXT_WATER_MASK = 2;
export const QM_EXT_METADATA = 4;

/** 默认每次请求 accept 头（请求服务器返回各扩展） */
export const DEFAULT_ACCEPT_HEADER =
  'application/vnd.quantized-mesh;extensions=octvertexnormals-watermask-metadata,*/*;q=0.01';

/** 并发请求上限 */
export const MAX_CONCURRENT_REQUESTS = 6;

/** LRU 上限
 *
 * 必须大于任意单帧调度瓦片数，否则会触发 LRU thrashing：
 * 当前帧 cache.get/set 的顺序导致 head 恰好是本帧仍在用的瓦片 →
 * 新瓦片 set 时把它们驱逐 → 下一帧重新加载 → 闪烁。
 *
 * 当前 scheduler 在 pitch=85° 下最多产出约 48×48 ≈ 2300 片瓦片（已通过
 * MAX_SCHEDULED_TILES 限制），所以缓存上限留足 3000 条目 / 1 GB 字节。
 */
export const CACHE_MAX_ENTRIES = 3000;
export const CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/** 默认屏幕空间误差（像素） */
export const DEFAULT_MAX_SCREEN_SPACE_ERROR = 4.0;

/** Cesium 根层每瓦片几何误差（米）。z=0 的基准值 ~75000；每级除以 2。 */
export const GEOMETRIC_ERROR_Z0 = 75000;

/** 裙边高度相对于瓦片高度区间的系数 */
export const SKIRT_HEIGHT_FACTOR = 0.02;

/** 裙边最小高度（米），防止极平地瓦片裙边为零导致缝隙 */
export const SKIRT_MIN_HEIGHT_METERS = 10;

/**
 * 几何体每顶点 float 数量：
 *   posXY (z=0 mercator px, 相对瓦片中心) — 2
 *   height (米)                            — 1
 *   normal xyz (世界空间)                   — 3
 *   uv (drape 纹理 UV)                     — 2
 *  ───────────────────────────────────────
 *   合计 8 floats / 32 bytes
 */
export const FLOATS_PER_VERTEX = 8;
export const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * 4;

/** Uniform 缓冲大小：与 WGSL struct 匹配（注意 std140 对齐） */
export const CAMERA_UNIFORM_SIZE = 64 + 16; // mat4x4 + vec2(center) + vec2(pad)
export const STYLE_UNIFORM_SIZE = 64;      // vec3 light + ambient + exaggeration + opacity + vec2 pad
export const TILE_UNIFORM_SIZE = 48;       // vec3 offset + f32 pad + vec2 heightRange + vec2 pad

/** 瓦片解码结果（主线程处理后的顶点数据，zoom-independent） */
export interface DecodedTerrainTile {
  readonly coord: TileCoord;
  /**
   * 8 floats 交错：
   *   posXY (z=0 mercator px，相对瓦片中心)
   *   height (米)
   *   normal xyz (世界空间)
   *   uv (OSM drape 纹理 UV，已裁到 osmTile 局部 [0,1])
   */
  readonly vertices: Float32Array;
  /** 顶点索引 */
  readonly indices: Uint16Array | Uint32Array;
  /** 顶点总数（含裙边） */
  readonly vertexCount: number;
  /** 索引总数（主网格 + 裙边） */
  readonly indexCount: number;
  /** 主网格索引数（前 mainIndexCount 个索引） */
  readonly mainIndexCount: number;
  /** 瓦片地理 bbox：[west, south, east, north]（度） */
  readonly bbox: readonly [number, number, number, number];
  /** 高度范围（米） */
  readonly heightRange: readonly [number, number];
  /** 瓦片中心墨卡托像素坐标（z=0 基准，zoom-independent） */
  readonly tileCenterMercatorPxZ0: readonly [number, number];
  /** 瓦片中心 (lng,lat) 度 */
  readonly tileCenterLngLat: readonly [number, number];
  /** 用于 drape 的 OSM 瓦片坐标（XYZ 墨卡托）— 该瓦片完整包含地形 bbox */
  readonly drapeOsm: { readonly z: number; readonly x: number; readonly y: number };
  /** 原始字节数（用于 LRU 计费） */
  readonly byteSize: number;
}

/** Provider 元数据（layer.json 解析后） */
export interface CesiumTerrainMetadata {
  readonly bounds: readonly [number, number, number, number];
  readonly maxZoom: number;
  readonly minZoom: number;
  readonly tileUrlTemplates: readonly string[];
  readonly attribution: string;
  readonly version: string;
  /** available[z] = rectangle list，标识该层哪些 (x,y) 有瓦片 */
  readonly available: ReadonlyArray<ReadonlyArray<{
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
  }>>;
}

/** 内部 LRU 条目 */
export interface TerrainCacheEntry {
  key: string;
  coord: TileCoord;
  /** 'loading' = 网格未就绪；'mesh-ready' = 网格已上传但贴图未就绪；'ready' = 全部就绪 */
  state: 'loading' | 'mesh-ready' | 'ready' | 'error';
  decoded: DecodedTerrainTile | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  indexFormat: 'uint16' | 'uint32';
  /** OSM 贴图（drape 纹理） */
  drapeTexture: GPUTexture | null;
  /** 真实 OSM drape 是否已加载（false 时 tileBindGroup 指向 1×1 白占位） */
  drapeLoaded: boolean;
  /** 该瓦片完整 bind group（uniform + sampler + texture） */
  tileBindGroup: GPUBindGroup | null;
  /** 与 drape 纹理对应的 OSM 瓦片坐标 */
  drapeOsm: { z: number; x: number; y: number } | null;
  byteSize: number;
  errorCount: number;
  prev: TerrainCacheEntry | null;
  next: TerrainCacheEntry | null;
}

/** 外部构造选项 */
export interface CesiumTerrainLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  /** 用于地形 drape 的栅格瓦片 URL 模板（如 OSM `https://tile.openstreetmap.org/{z}/{x}/{y}.png`） */
  readonly drapeUrlTemplate?: string;
  readonly drapeMaxZoom?: number;
  readonly exaggeration?: number;
  readonly opacity?: number;
  readonly maxScreenSpaceError?: number;
  readonly lightDirection?: readonly [number, number, number];
  readonly ambient?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly paint?: Record<string, unknown>;
  readonly layout?: Record<string, unknown>;
}
