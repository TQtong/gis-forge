// ============================================================
// @geoforge/core — L0 基础层包入口
// 统一导出所有子模块的公共 API，上层通过以下方式导入：
//   import { vec3, mat4, bbox, ... } from '@geoforge/core';
//   import type { Feature, Viewport, ... } from '@geoforge/core';
//
// 子模块分类：
//   - types/    — 全局共享类型定义（纯 TS 类型，编译后擦除）
//   - math/     — 向量/矩阵/包围盒/视锥体/插值/三角函数
//   - geo/      — WGS84 椭球体/Mercator 投影/大地测量
//   - algorithm/ — earcut 三角剖分/线简化/包含检测/相交检测
//   - index/    — R-Tree/空间哈希（空间索引）
//   - precision/ — Split-Double/RTC（GPU 精度增强）
//   - infra/    — 事件总线/ID 生成器/日志/配置/CRS/投影接口
// ============================================================

// --- 全局共享类型（纯类型导出，零运行时体积） ---
export type {
  Vec2f, Vec3f, Vec4f, Mat3f, Mat4f, Quatf,
  Vec2d, Vec3d, Vec4d, Mat4d,
} from './types/math-types.ts';

export type {
  GeometryType, Position, LinearRing,
  PointGeometry, MultiPointGeometry,
  LineStringGeometry, MultiLineStringGeometry,
  PolygonGeometry, MultiPolygonGeometry,
  GeometryCollectionGeometry, Geometry,
} from './types/geometry.ts';

export type { BBox2D, TileCoord, TileParams, TileData, TileState } from './types/tile.ts';
export type { Feature, FeatureCollection } from './types/feature.ts';
export type { Viewport, CameraState, PickResult } from './types/viewport.ts';
export type {
  StyleSpec, SourceSpec, LayerStyleSpec, LightSpec,
  StyleExpression, InterpolationType, FilterExpression,
} from './types/style-spec.ts';
export type {
  MapEventType, MapPointerEvent, FlyToOptions, AnimationOptions,
} from './types/events.ts';
export type { LogLevel } from './types/events.ts';

// --- 数学模块（命名空间导出，支持 tree-shaking） ---
export * as vec2 from './math/vec2.ts';
export * as vec3 from './math/vec3.ts';
export * as vec4 from './math/vec4.ts';
export * as mat3 from './math/mat3.ts';
export * as mat4 from './math/mat4.ts';
export * as quat from './math/quat.ts';
export * as bbox from './math/bbox.ts';
export * as frustum from './math/frustum.ts';
export * as interpolate from './math/interpolate.ts';
export * as trigonometry from './math/trigonometry.ts';

// --- 地理计算模块 ---
export {
  WGS84_A, WGS84_B, WGS84_F, WGS84_E2,
  geodeticToECEF, ecefToGeodetic, surfaceNormal,
  vincentyDistance, haversineDistance, batchGeodeticToECEF,
} from './geo/ellipsoid.ts';

export {
  TILE_SIZE, EARTH_CIRCUMFERENCE, MAX_LATITUDE,
  clampLatitude, lngLatToMercator, mercatorToLngLat,
  lngLatToTile, tileToBBox, tileCount,
  groundResolution, lngLatToPixel, pixelToLngLat,
} from './geo/mercator.ts';

export {
  vincentyDirect, initialBearing, finalBearing,
  midpoint, intermediatePoint, nearestPointOnLine,
} from './geo/geodesic.ts';

export type { VincentyDirectResult, NearestPointResult } from './geo/geodesic.ts';

// --- 算法模块 ---
export {
    CHUNK_THRESHOLD,
    earcut,
    earcutChunked,
    earcutChunkedStats,
    flatten,
    flattenChunk,
    deviation,
} from './algorithm/earcut.ts';
export type { EarcutChunkBBox, EarcutChunkedStats } from './algorithm/earcut.ts';
export { douglasPeucker, visvalingam } from './algorithm/simplify.ts';
export { pointInPolygon, pointInTriangle, pointInBBox, pointOnLine } from './algorithm/contain.ts';
export { segmentSegment, rayAABB, bboxOverlap } from './algorithm/intersect.ts';
export type { SegmentIntersection } from './algorithm/intersect.ts';

// --- 空间索引 ---
export { createRTree } from './index/rtree.ts';
export type { RTree, RTreeItem } from './index/rtree.ts';
export { createSpatialHash } from './index/spatial-hash.ts';
export type { SpatialHash } from './index/spatial-hash.ts';

// --- 精度模块 ---
export { splitDouble, splitDoubleArray, recombine } from './precision/split-double.ts';
export { computeRTCCenter, offsetPositions, fromECEF } from './precision/rtc.ts';

// --- 基础设施 ---
export { EventEmitter } from './infra/event.ts';
export {
  createInternalBus,
  type InternalBus,
  type InternalEventMap,
} from './infra/internal-bus.ts';
export {
  GeoForgeError,
  GeoForgeErrorCode,
  DEVELOPER_HINTS,
  formatErrorWithHint,
  type DeveloperHint,
  type GeoForgeErrorCodeType,
} from './infra/errors.ts';
export { createObjectPool, type ObjectPool } from './infra/object-pool.ts';
export { uniqueId, sequentialId, nanoid } from './infra/id.ts';
export { Logger, createLogger, setLogLevel, getLogLevel } from './infra/logger.ts';
export { createDefaultConfig, mergeConfig } from './infra/config.ts';
export type { EngineConfig } from './infra/config.ts';
export { registerCRS, getCRS, transform, registerTransform } from './infra/coordinate.ts';
export type { CRSDefinition } from './infra/coordinate.ts';
export type { ProjectionDef, TileGridDefinition } from './infra/projection.ts';
