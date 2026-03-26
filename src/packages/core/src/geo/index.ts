/**
 * @module geo
 * @description L0 地理计算模块统一入口——重导出 WGS84 椭球体、Mercator 投影、
 * 大地测量（Vincenty/Haversine/方位角/中点/最近线上点）的全部公共 API。
 *
 * 上层模块通过 `import { ... } from '@gis-forge/core/geo'` 一站式引入。
 */

// ============================================================
// ellipsoid — WGS84 椭球体常量与坐标转换
// ============================================================
export {
    WGS84_A,
    WGS84_B,
    WGS84_F,
    WGS84_E2,
    geodeticToECEF,
    ecefToGeodetic,
    surfaceNormal,
    vincentyDistance,
    haversineDistance,
    batchGeodeticToECEF,
} from './ellipsoid.ts';

export type { Vec2d, Vec3d } from './ellipsoid.ts';

// ============================================================
// mercator — Web Mercator (EPSG:3857) 投影数学
// ============================================================
export {
    TILE_SIZE,
    EARTH_CIRCUMFERENCE,
    MAX_LATITUDE,
    clampLatitude,
    lngLatToMercator,
    mercatorToLngLat,
    lngLatToTile,
    tileToBBox,
    tileCount,
    groundResolution,
    lngLatToPixel,
    pixelToLngLat,
} from './mercator.ts';

export type { BBox2D, TileCoord } from './mercator.ts';

// ============================================================
// geodesic — 大地测量计算（Vincenty 正解、方位角、插值、最近点）
// ============================================================
export {
    vincentyDirect,
    initialBearing,
    finalBearing,
    midpoint,
    intermediatePoint,
    nearestPointOnLine,
} from './geodesic.ts';

export type { VincentyDirectResult, NearestPointResult } from './geodesic.ts';

// ============================================================
// measure — 几何测量（面积/长度/质心/视觉中心/最小包围圆/距离/周长）
// ============================================================
export {
    area,
    geodesicArea,
    length,
    geodesicLength,
    centroid,
    polylabel,
    minBoundingCircle,
    pointToLineDistance,
    perimeter,
} from './measure.ts';

// ============================================================
// projection-math — 投影数学工具（UTM/GCJ-02/BD-09）
// ============================================================
export {
    utmForward,
    utmInverse,
    gcj02ToWgs84,
    wgs84ToGcj02,
    bd09ToGcj02,
    gcj02ToBd09,
} from './projection-math.ts';

// ============================================================
// tiling-scheme — 瓦片方案抽象（TilingScheme 接口 + 自由函数 + 注册表）
// ============================================================
export {
    tileBoundsInto,
    tileBounds,
    tileKey,
    decodeTileKey,
    tileKeyStr,
    tileKeyAuto,
    touchesPole,
    forEachOverlappingTile,
    tileCenterInto,
    registerTilingScheme,
    getTilingSchemeById,
    _registerBuiltins,
} from './tiling-scheme.ts';

export type {
    TilingScheme,
    TileCoord as TilingTileCoord,
    GlobeTileID as TilingGlobeTileID,
    TileBounds,
} from './tiling-scheme.ts';

// ============================================================
// web-mercator-tiling-scheme — EPSG:3857 瓦片方案
// ============================================================
export { WebMercator } from './web-mercator-tiling-scheme.ts';

// ============================================================
// geographic-tiling-scheme — EPSG:4326 瓦片方案
// ============================================================
export { Geographic } from './geographic-tiling-scheme.ts';

// ============================================================
// tile-source — 瓦片数据源描述
// ============================================================
export {
    createTileSource,
    tileUrl,
} from './tile-source.ts';

export type {
    TileSource,
    TileSourceFormat,
} from './tile-source.ts';
