// ============================================================
// algorithm/index.ts — 算法模块统一导出
// 聚合所有几何算法子模块，提供统一的命名导出入口。
// ============================================================

export { earcut, flatten, deviation } from './earcut.ts';
export { douglasPeucker, visvalingam } from './simplify.ts';
export { pointInPolygon, pointInTriangle, pointInBBox, pointOnLine } from './contain.ts';
export {
    segmentSegment,
    rayAABB,
    bboxOverlap,
    type SegmentIntersection,
} from './intersect.ts';
