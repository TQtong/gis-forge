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
export { douglasPeucker, visvalingam, chaikin, douglasPeucker3D, bspline } from './simplify.ts';
export {
    weilerAtherton,
    greinerHormann,
    type WAOp,
} from './polygon-clip.ts';
export {
    pointInPolygon,
    pointInTriangle,
    pointInBBox,
    pointOnLine,
    pointInPolygonWinding,
    pointToPolygonDistance,
} from './contain.ts';
export {
    segmentSegment,
    rayAABB,
    rayOBB,
    rayTriangle,
    planeSphere,
    PlaneSphereRelation,
    bboxOverlap,
    type SegmentIntersection,
    type RayTriangleHit,
} from './intersect.ts';
export { delaunay, voronoi } from './delaunay.ts';
export {
    constrainedDelaunay,
    type Constraint,
    type CDTResult,
    type CDTOptions,
} from './constrained-delaunay.ts';
export {
    monotoneDecompose,
    type MonotoneDecomposition,
} from './monotone.ts';
export {
    bentleyOttmann,
    type Segment,
    type IntersectionReport,
} from './bentley-ottmann.ts';
export {
    convexHull,
    quickHull,
    concaveHull,
    minBoundingBox,
    type MinBoundingBox,
} from './convex-hull.ts';
export {
    sutherlandHodgman,
    cohenSutherland,
    liangBarsky,
    polygonSplit,
} from './clip.ts';
export {
    bezierFit,
    bezierSample,
    type CubicBezier,
} from './curve-fit.ts';
export {
    supercluster,
    dbscan,
    kMeans,
    type SuperclusterOptions,
    type Supercluster,
    type ClusterFeature,
    type KMeansResult,
} from './cluster.ts';
