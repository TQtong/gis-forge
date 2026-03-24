// ============================================================
// analysis/topology/index.ts — 拓扑空间关系判断
// 职责：判断两个几何对象之间的拓扑关系——包含、在内、重叠、
//       交叉、分离、相交、接触（DE-9IM 简化实现）。
// 使用射线法（Ray Casting）和线段交叉检测实现。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type {
    Position,
    Geometry,
    PointGeometry,
    LineStringGeometry,
    PolygonGeometry,
} from '../../../core/src/types/geometry.ts';
import type { Feature } from '../../../core/src/types/feature.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const TOPO_ERROR_CODES = {
    /** 输入几何无效 */
    INVALID_GEOMETRY: 'TOPO_INVALID_GEOMETRY',
    /** 不支持的几何类型组合 */
    UNSUPPORTED_COMBINATION: 'TOPO_UNSUPPORTED_COMBINATION',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 浮点比较 epsilon */
const EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 射线法（Ray Casting）判断点是否在多边形环内。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param ring - 多边形环坐标
 * @returns true 表示在内
 *
 * @example
 * pointInRing(0.5, 0.5, [[0,0],[1,0],[1,1],[0,1],[0,0]]); // → true
 */
function pointInRing(px: number, py: number, ring: readonly Position[]): boolean {
    let inside = false;
    const n = ring.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i]![0];
        const yi = ring[i]![1];
        const xj = ring[j]![0];
        const yj = ring[j]![1];

        const intersects = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);

        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * 判断点是否在多边形内（含孔洞判断）。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param polygonCoords - 多边形 coordinates（环数组）
 * @returns true 表示在多边形内
 *
 * @example
 * pointInPolygon(0.5, 0.5, polygon.coordinates); // → true
 */
function pointInPolygon(
    px: number,
    py: number,
    polygonCoords: readonly (readonly Position[])[]
): boolean {
    // 在外环内
    const outer = polygonCoords[0];
    if (!outer || !pointInRing(px, py, outer)) {
        return false;
    }

    // 不在任何孔洞内
    for (let i = 1; i < polygonCoords.length; i++) {
        if (pointInRing(px, py, polygonCoords[i]!)) {
            return false;
        }
    }

    return true;
}

/**
 * 判断点是否在线段上（距离判定）。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param ax - 线段起点 x
 * @param ay - 线段起点 y
 * @param bx - 线段终点 x
 * @param by - 线段终点 y
 * @returns true 表示点在线段上
 *
 * @example
 * pointOnSegment(0.5, 0, 0, 0, 1, 0); // → true
 */
function pointOnSegment(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number
): boolean {
    // 叉积判断共线性
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(cross) > EPSILON) {
        return false;
    }

    // 点积判断是否在线段范围内
    const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
    const lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);

    return dot >= -EPSILON && dot <= lenSq + EPSILON;
}

/**
 * 判断点是否在多边形边界上。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param polygonCoords - 多边形坐标
 * @returns true 表示点在边界上
 *
 * @example
 * pointOnBoundary(0, 0.5, polygon.coordinates); // → true (if on edge)
 */
function pointOnBoundary(
    px: number, py: number,
    polygonCoords: readonly (readonly Position[])[]
): boolean {
    for (const ring of polygonCoords) {
        for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i]!;
            const b = ring[i + 1]!;
            if (pointOnSegment(px, py, a[0], a[1], b[0], b[1])) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 检查两条线段是否相交（真交叉，不仅仅是端点接触）。
 *
 * @param p1 - 线段1起点
 * @param p2 - 线段1终点
 * @param p3 - 线段2起点
 * @param p4 - 线段2终点
 * @returns true 表示两线段有交叉
 *
 * @example
 * segmentsIntersect([0,0],[2,2],[0,2],[2,0]); // → true
 */
function segmentsIntersect(
    p1: Position, p2: Position,
    p3: Position, p4: Position
): boolean {
    const d1x = p2[0] - p1[0];
    const d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0];
    const d2y = p4[1] - p3[1];

    const denom = d1x * d2y - d1y * d2x;

    // 平行线段不相交
    if (Math.abs(denom) < EPSILON) {
        return false;
    }

    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;

    // t 和 u 都在 (0, 1) 开区间内——真交叉（不含端点接触）
    return t > EPSILON && t < 1 - EPSILON && u > EPSILON && u < 1 - EPSILON;
}

/**
 * 检查两条线段是否有任何接触（含端点重合和交叉）。
 *
 * @param p1 - 线段1起点
 * @param p2 - 线段1终点
 * @param p3 - 线段2起点
 * @param p4 - 线段2终点
 * @returns true 表示有接触
 */
function segmentsTouch(
    p1: Position, p2: Position,
    p3: Position, p4: Position
): boolean {
    const d1x = p2[0] - p1[0];
    const d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0];
    const d2y = p4[1] - p3[1];

    const denom = d1x * d2y - d1y * d2x;

    if (Math.abs(denom) < EPSILON) {
        // 平行——检查是否有端点重合
        return (
            pointOnSegment(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1]) ||
            pointOnSegment(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1]) ||
            pointOnSegment(p3[0], p3[1], p1[0], p1[1], p2[0], p2[1]) ||
            pointOnSegment(p4[0], p4[1], p1[0], p1[1], p2[0], p2[1])
        );
    }

    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;

    return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON;
}

/**
 * 获取几何的所有坐标序列（扁平化为点列表和线段列表）。
 *
 * @param geom - 几何对象
 * @returns 坐标点数组和线段数组
 */
function extractEdges(geom: Geometry): { points: Position[]; edges: [Position, Position][] } {
    const points: Position[] = [];
    const edges: [Position, Position][] = [];

    switch (geom.type) {
        case 'Point':
            points.push(geom.coordinates);
            break;
        case 'MultiPoint':
            for (const p of geom.coordinates) points.push(p);
            break;
        case 'LineString':
            for (const p of geom.coordinates) points.push(p);
            for (let i = 0; i < geom.coordinates.length - 1; i++) {
                edges.push([geom.coordinates[i]!, geom.coordinates[i + 1]!]);
            }
            break;
        case 'MultiLineString':
            for (const line of geom.coordinates) {
                for (const p of line) points.push(p);
                for (let i = 0; i < line.length - 1; i++) {
                    edges.push([line[i]!, line[i + 1]!]);
                }
            }
            break;
        case 'Polygon':
            for (const ring of geom.coordinates) {
                for (const p of ring) points.push(p);
                for (let i = 0; i < ring.length - 1; i++) {
                    edges.push([ring[i]!, ring[i + 1]!]);
                }
            }
            break;
        case 'MultiPolygon':
            for (const poly of geom.coordinates) {
                for (const ring of poly) {
                    for (const p of ring) points.push(p);
                    for (let i = 0; i < ring.length - 1; i++) {
                        edges.push([ring[i]!, ring[i + 1]!]);
                    }
                }
            }
            break;
        case 'GeometryCollection':
            for (const g of geom.geometries) {
                const extracted = extractEdges(g);
                points.push(...extracted.points);
                edges.push(...extracted.edges);
            }
            break;
    }

    return { points, edges };
}

// ---------------------------------------------------------------------------
// TopologyOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 拓扑空间关系判断运算集合。
 * 基于 DE-9IM 模型的简化实现，判断两个几何对象之间的空间关系。
 *
 * @stability experimental
 *
 * @example
 * if (TopologyOps.booleanContains(polygonA, pointB)) {
 *   console.log('点在多边形内');
 * }
 */
export const TopologyOps = {
    /**
     * 判断几何 A 是否完全包含几何 B。
     * Contains = B 的所有点都在 A 的内部或边界上，
     * 且 B 至少有一个点在 A 的内部（不全在边界上）。
     *
     * @param a - 容器几何 Feature
     * @param b - 被包含几何 Feature
     * @returns true 表示 A 包含 B
     *
     * @stability experimental
     *
     * @example
     * TopologyOps.booleanContains(polygon, point); // → true if point inside polygon
     */
    booleanContains(a: Feature, b: Feature): boolean {
        if (!a?.geometry || !b?.geometry) {
            if (__DEV__) {
                console.warn(`[${TOPO_ERROR_CODES.INVALID_GEOMETRY}] 几何对象为空`);
            }
            return false;
        }

        const geomA = a.geometry;
        const geomB = b.geometry;

        // Polygon contains Point
        if (geomA.type === 'Polygon' && geomB.type === 'Point') {
            return pointInPolygon(
                geomB.coordinates[0],
                geomB.coordinates[1],
                geomA.coordinates
            );
        }

        // Polygon contains LineString
        if (geomA.type === 'Polygon' && geomB.type === 'LineString') {
            // 所有顶点都在多边形内且不只在边界上
            let hasInterior = false;
            for (const pt of geomB.coordinates) {
                if (!pointInPolygon(pt[0], pt[1], geomA.coordinates) &&
                    !pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                    return false;
                }
                if (pointInPolygon(pt[0], pt[1], geomA.coordinates) &&
                    !pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                    hasInterior = true;
                }
            }
            return hasInterior;
        }

        // Polygon contains Polygon
        if (geomA.type === 'Polygon' && geomB.type === 'Polygon') {
            const outerB = geomB.coordinates[0];
            if (!outerB) return false;
            let hasInterior = false;
            for (const pt of outerB) {
                if (!pointInPolygon(pt[0], pt[1], geomA.coordinates) &&
                    !pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                    return false;
                }
                if (pointInPolygon(pt[0], pt[1], geomA.coordinates) &&
                    !pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                    hasInterior = true;
                }
            }
            return hasInterior;
        }

        if (__DEV__) {
            console.warn(
                `[${TOPO_ERROR_CODES.UNSUPPORTED_COMBINATION}] booleanContains 不支持 ${geomA.type} contains ${geomB.type}`
            );
        }
        return false;
    },

    /**
     * 判断几何 A 是否完全在几何 B 内部。
     * Within 是 Contains 的反向关系：A within B ⟺ B contains A。
     *
     * @param a - 被包含几何
     * @param b - 容器几何
     * @returns true 表示 A 在 B 内
     *
     * @stability experimental
     *
     * @example
     * TopologyOps.booleanWithin(point, polygon); // → true if point inside polygon
     */
    booleanWithin(a: Feature, b: Feature): boolean {
        // Within = reverse Contains
        return TopologyOps.booleanContains(b, a);
    },

    /**
     * 判断两个几何是否有重叠（同维度部分交集）。
     * Overlap = 两个同维度的几何有交集，且交集的维度与输入相同，
     * 但两者互不包含。
     *
     * @param a - 几何 A
     * @param b - 几何 B
     * @returns true 表示有重叠
     *
     * @stability experimental
     *
     * @example
     * TopologyOps.booleanOverlap(polygonA, polygonB); // → true if partial overlap
     */
    booleanOverlap(a: Feature, b: Feature): boolean {
        if (!a?.geometry || !b?.geometry) {
            return false;
        }

        const geomA = a.geometry;
        const geomB = b.geometry;

        // Polygon-Polygon 重叠
        if (geomA.type === 'Polygon' && geomB.type === 'Polygon') {
            // 如果 A 包含 B 或 B 包含 A，不算重叠
            if (TopologyOps.booleanContains(a, b) || TopologyOps.booleanContains(b, a)) {
                return false;
            }
            // 存在交集 = 有某些 B 的点在 A 内
            return TopologyOps.booleanIntersects(a, b);
        }

        // LineString-LineString 重叠
        if (geomA.type === 'LineString' && geomB.type === 'LineString') {
            // 简化判断：有边交叉但互不包含
            const edgesA = extractEdges(geomA);
            const edgesB = extractEdges(geomB);
            for (const ea of edgesA.edges) {
                for (const eb of edgesB.edges) {
                    if (segmentsIntersect(ea[0], ea[1], eb[0], eb[1])) {
                        return true;
                    }
                }
            }
            return false;
        }

        return false;
    },

    /**
     * 判断两个几何是否交叉。
     * Crosses = 不同维度的几何有内部交集，或同维度的线在内部点相交。
     *
     * @param a - 几何 A
     * @param b - 几何 B
     * @returns true 表示交叉
     *
     * @stability experimental
     *
     * @example
     * TopologyOps.booleanCrosses(lineA, lineB); // → true if lines cross
     */
    booleanCrosses(a: Feature, b: Feature): boolean {
        if (!a?.geometry || !b?.geometry) {
            return false;
        }

        const geomA = a.geometry;
        const geomB = b.geometry;

        // Line crosses Line
        if (geomA.type === 'LineString' && geomB.type === 'LineString') {
            const edgesA = extractEdges(geomA);
            const edgesB = extractEdges(geomB);
            for (const ea of edgesA.edges) {
                for (const eb of edgesB.edges) {
                    if (segmentsIntersect(ea[0], ea[1], eb[0], eb[1])) {
                        return true;
                    }
                }
            }
            return false;
        }

        // Line crosses Polygon
        if (geomA.type === 'LineString' && geomB.type === 'Polygon') {
            // 线穿过多边形 = 部分点在内部，部分在外部
            let hasInside = false;
            let hasOutside = false;
            for (const pt of geomA.coordinates) {
                if (pointInPolygon(pt[0], pt[1], geomB.coordinates)) {
                    hasInside = true;
                } else {
                    hasOutside = true;
                }
                if (hasInside && hasOutside) return true;
            }
            return false;
        }

        // Polygon crosses Line (symmetric)
        if (geomA.type === 'Polygon' && geomB.type === 'LineString') {
            return TopologyOps.booleanCrosses(b, a);
        }

        return false;
    },

    /**
     * 判断两个几何是否完全不相交。
     * Disjoint = 无任何公共点。
     *
     * @param a - 几何 A
     * @param b - 几何 B
     * @returns true 表示完全分离
     *
     * @stability stable
     *
     * @example
     * TopologyOps.booleanDisjoint(polygonA, polygonB); // → true if no intersection
     */
    booleanDisjoint(a: Feature, b: Feature): boolean {
        // Disjoint 是 Intersects 的否定
        return !TopologyOps.booleanIntersects(a, b);
    },

    /**
     * 判断两个几何是否有任何公共点（含边界接触）。
     * Intersects = NOT Disjoint。
     *
     * @param a - 几何 A
     * @param b - 几何 B
     * @returns true 表示有交集
     *
     * @stability stable
     *
     * @example
     * TopologyOps.booleanIntersects(polygonA, polygonB); // → true if any intersection
     */
    booleanIntersects(a: Feature, b: Feature): boolean {
        if (!a?.geometry || !b?.geometry) {
            return false;
        }

        const geomA = a.geometry;
        const geomB = b.geometry;

        // 提取边和点
        const dataA = extractEdges(geomA);
        const dataB = extractEdges(geomB);

        // 检查 A 的点是否在 B 内（或 B 的点在 A 内）
        if (geomB.type === 'Polygon') {
            for (const pt of dataA.points) {
                if (pointInPolygon(pt[0], pt[1], geomB.coordinates) ||
                    pointOnBoundary(pt[0], pt[1], geomB.coordinates)) {
                    return true;
                }
            }
        }

        if (geomA.type === 'Polygon') {
            for (const pt of dataB.points) {
                if (pointInPolygon(pt[0], pt[1], geomA.coordinates) ||
                    pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                    return true;
                }
            }
        }

        // 检查边是否有交叉或接触
        for (const ea of dataA.edges) {
            for (const eb of dataB.edges) {
                if (segmentsTouch(ea[0], ea[1], eb[0], eb[1])) {
                    return true;
                }
            }
        }

        // Point-Point 精确匹配
        if (geomA.type === 'Point' && geomB.type === 'Point') {
            return (
                Math.abs(geomA.coordinates[0] - geomB.coordinates[0]) < EPSILON &&
                Math.abs(geomA.coordinates[1] - geomB.coordinates[1]) < EPSILON
            );
        }

        return false;
    },

    /**
     * 判断两个几何是否仅在边界上接触（内部不相交）。
     * Touches = 有公共点但公共点全在边界上，内部无交集。
     *
     * @param a - 几何 A
     * @param b - 几何 B
     * @returns true 表示仅边界接触
     *
     * @stability experimental
     *
     * @example
     * TopologyOps.booleanTouches(polygonA, polygonB); // → true if only boundary contact
     */
    booleanTouches(a: Feature, b: Feature): boolean {
        if (!a?.geometry || !b?.geometry) {
            return false;
        }

        // 必须有交集才可能接触
        if (!TopologyOps.booleanIntersects(a, b)) {
            return false;
        }

        const geomA = a.geometry;
        const geomB = b.geometry;

        // Point touches Polygon = 点在多边形边界上
        if (geomA.type === 'Point' && geomB.type === 'Polygon') {
            const px = geomA.coordinates[0];
            const py = geomA.coordinates[1];
            return (
                pointOnBoundary(px, py, geomB.coordinates) &&
                !pointInPolygon(px, py, geomB.coordinates)
            );
        }

        // Polygon touches Point (symmetric)
        if (geomA.type === 'Polygon' && geomB.type === 'Point') {
            return TopologyOps.booleanTouches(b, a);
        }

        // Polygon touches Polygon = 有边界交点但无内部交集
        if (geomA.type === 'Polygon' && geomB.type === 'Polygon') {
            // 如果 A 的任何内部点在 B 内部（或反过来），则不是 touches
            const outerA = geomA.coordinates[0];
            const outerB = geomB.coordinates[0];

            if (outerA && outerB) {
                for (const pt of outerA) {
                    if (pointInPolygon(pt[0], pt[1], geomB.coordinates) &&
                        !pointOnBoundary(pt[0], pt[1], geomB.coordinates)) {
                        return false;
                    }
                }
                for (const pt of outerB) {
                    if (pointInPolygon(pt[0], pt[1], geomA.coordinates) &&
                        !pointOnBoundary(pt[0], pt[1], geomA.coordinates)) {
                        return false;
                    }
                }
            }

            return true;
        }

        // 其他组合的简化判断：有交集但互不包含
        return !TopologyOps.booleanContains(a, b) && !TopologyOps.booleanContains(b, a);
    },
} as const;

export { TopologyOps as topologyOps };
