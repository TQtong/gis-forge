/**
 * @module geo
 * @description L0 地理计算模块统一入口——重导出 WGS84 椭球体、Mercator 投影、
 * 大地测量（Vincenty/Haversine/方位角/中点/最近线上点）的全部公共 API。
 *
 * 上层模块通过 `import { ... } from '@geoforge/core/geo'` 一站式引入。
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
