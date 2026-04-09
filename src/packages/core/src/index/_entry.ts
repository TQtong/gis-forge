// ============================================================
// index/_entry.ts — 空间索引模块统一导出
// 因为目录名 "index" 与 TypeScript 的 index.ts 约定冲突，
// 使用 _entry.ts 作为该目录的聚合导出文件。
// ============================================================

export {
    createRTree,
    type RTree,
    type RTreeItem,
} from './rtree.ts';

export {
    createSpatialHash,
    type SpatialHash,
} from './spatial-hash.ts';

export {
    createQuadTree,
    type QuadTree,
    type QuadTreeItem,
} from './quadtree.ts';

export {
    createKDTree,
    type KDTree,
    type KDTreeItem,
} from './kd-tree.ts';

export {
    createGridIndex,
    type GridIndex,
    type GridItem,
} from './grid-index.ts';

export {
    geohashEncode,
    geohashDecode,
    geohashNeighbors,
    type GeohashBounds,
} from './geohash.ts';

export {
    createOctree,
    type Octree,
    type OctreeItem,
} from './octree.ts';

export {
    latLngToCellId,
    cellIdToLatLng,
    cellIdLevel,
    cellIdFace,
    cellIdParent,
    cellIdChildren,
    type S2CellId,
} from './s2.ts';

export {
    latLngToH3,
    h3ToLatLng,
    h3ToBoundary,
    h3Resolution,
    h3BaseCell,
    h3Parent,
    h3Children,
    h3Disk,
    h3Ring,
    h3Distance,
    h3IsPentagon,
    h3IsValid,
    polygonToH3,
    h3ToMultiPolygon,
    type H3Index,
} from './h3.ts';
