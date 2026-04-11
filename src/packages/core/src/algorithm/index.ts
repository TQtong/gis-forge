// ============================================================
// algorithm/index.ts — 算法模块统一导出
// 聚合所有几何算法子模块，提供统一的命名导出入口。
// ============================================================

export {
    CHUNK_THRESHOLD,
    earcut,
    earcutChunked,
    earcutChunkedStats,
    flatten,
    flattenChunk,
    deviation,
} from './earcut.ts';
export type { EarcutChunkBBox, EarcutChunkedStats } from './earcut.ts';
export { douglasPeucker, visvalingam } from './simplify.ts';
export { pointInPolygon, pointInTriangle, pointInBBox, pointOnLine } from './contain.ts';
export {
    segmentSegment,
    rayAABB,
    bboxOverlap,
    type SegmentIntersection,
} from './intersect.ts';
export { delaunay, voronoi } from './delaunay.ts';
export { convexHull } from './convex-hull.ts';
export { sutherlandHodgman, cohenSutherland, liangBarsky } from './clip.ts';
export { weilerAtherton } from './weiler-atherton.ts';
export { greinerHormann, type BooleanOp } from './greiner-hormann.ts';
export {
    closestPointOnEllipsoid,
    type ClosestPointOnEllipsoid,
} from './closest-point-on-ellipsoid.ts';
export { douglasPeucker3D, type Point3D } from './douglas-peucker-3d.ts';
export { evaluateBSpline, interpolateBSpline } from './b-spline.ts';
export {
    supercluster,
    dbscan,
    kMeans,
    type SuperclusterOptions,
    type Supercluster,
    type ClusterFeature,
    type KMeansResult,
} from './cluster.ts';
