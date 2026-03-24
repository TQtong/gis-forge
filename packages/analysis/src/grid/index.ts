// ============================================================
// analysis/grid/index.ts — 规则网格生成
// 职责：生成覆盖指定范围的规则网格（正方形/六角/三角/Voronoi），
//       返回 FeatureCollection<Polygon> 供后续分析或可视化使用。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { Position, PolygonGeometry } from '../../../core/src/types/geometry.ts';
import type { Feature, FeatureCollection } from '../../../core/src/types/feature.ts';
import type { BBox2D } from '../../../core/src/types/math-types.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const GRID_ERROR_CODES = {
    /** BBox 无效 */
    INVALID_BBOX: 'GRID_INVALID_BBOX',
    /** 单元尺寸无效 */
    INVALID_CELL_SIZE: 'GRID_INVALID_CELL_SIZE',
    /** 输入点数不足 */
    INSUFFICIENT_POINTS: 'GRID_INSUFFICIENT_POINTS',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 最小单元尺寸（度）——过小会生成海量格子 */
const MIN_CELL_SIZE = 1e-8;

/** 最大生成要素数量限制——防止内存爆炸 */
const MAX_FEATURES = 1_000_000;

/** 六角网格中 sqrt(3) 的常量缓存 */
const SQRT3 = Math.sqrt(3);

/** 六角网格中 sqrt(3)/2 的常量缓存 */
const SQRT3_HALF = SQRT3 * 0.5;

/** 浮点比较 epsilon */
const EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 校验 BBox 是否有效（非退化、有限值）。
 *
 * @param bbox - 待校验的包围盒
 * @returns true 表示有效
 *
 * @example
 * isValidBBox({ west: 0, south: 0, east: 1, north: 1 }); // → true
 */
function isValidBBox(bbox: BBox2D): boolean {
    return (
        isFinite(bbox.west) && isFinite(bbox.south) &&
        isFinite(bbox.east) && isFinite(bbox.north) &&
        bbox.east > bbox.west && bbox.north > bbox.south
    );
}

// ---------------------------------------------------------------------------
// GridOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 规则网格生成运算集合。
 * 生成正方形、六角形、三角形网格和 Voronoi 多边形。
 *
 * @stability experimental
 *
 * @example
 * const hexGrid = GridOps.hexGrid({ west: 0, south: 0, east: 1, north: 1 }, 0.1);
 */
export const GridOps = {
    /**
     * 生成正方形网格。
     * 覆盖 bbox 范围，每个正方形边长为 cellSize（度）。
     *
     * @param bbox - 覆盖范围
     * @param cellSize - 正方形边长（度），必须 > 0
     * @returns 正方形网格 FeatureCollection
     *
     * @stability stable
     *
     * @example
     * const grid = GridOps.squareGrid(
     *   { west: 116.0, south: 39.0, east: 117.0, north: 40.0 },
     *   0.1
     * );
     */
    squareGrid(bbox: BBox2D, cellSize: number): FeatureCollection<PolygonGeometry> {
        // 校验 bbox
        if (!isValidBBox(bbox)) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_BBOX}] BBox 无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 校验单元尺寸
        if (!isFinite(cellSize) || cellSize < MIN_CELL_SIZE) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] cellSize 必须 > ${MIN_CELL_SIZE}`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        // 计算列数和行数
        const cols = Math.ceil((bbox.east - bbox.west) / cellSize);
        const rows = Math.ceil((bbox.north - bbox.south) / cellSize);

        // 防止生成过多要素
        if (cols * rows > MAX_FEATURES) {
            if (__DEV__) {
                console.warn(
                    `[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] 网格数量超限: ${cols * rows} > ${MAX_FEATURES}，请增大 cellSize`
                );
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 生成每个正方形
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = bbox.west + c * cellSize;
                const y0 = bbox.south + r * cellSize;
                const x1 = Math.min(x0 + cellSize, bbox.east);
                const y1 = Math.min(y0 + cellSize, bbox.north);

                // 闭合的正方形环（逆时针）
                const ring: Position[] = [
                    [x0, y0] as Position,
                    [x1, y0] as Position,
                    [x1, y1] as Position,
                    [x0, y1] as Position,
                    [x0, y0] as Position,
                ];

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties: { row: r, col: c },
                });
            }
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 生成六角形网格（偏移排列/Offset Hex Grid）。
     * 使用扁平顶（flat-top）六角形排列，奇数行向右偏移半个单元。
     *
     * @param bbox - 覆盖范围
     * @param cellSize - 六角形外接圆半径（度），即中心到顶点的距离
     * @returns 六角形网格 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const hexes = GridOps.hexGrid(
     *   { west: 0, south: 0, east: 10, north: 10 },
     *   0.5
     * );
     */
    hexGrid(bbox: BBox2D, cellSize: number): FeatureCollection<PolygonGeometry> {
        // 校验 bbox
        if (!isValidBBox(bbox)) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_BBOX}] BBox 无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 校验单元尺寸
        if (!isFinite(cellSize) || cellSize < MIN_CELL_SIZE) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] cellSize 必须 > ${MIN_CELL_SIZE}`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        // 扁平顶六角形的几何参数
        // 宽度 = 2 × cellSize（水平方向顶点到顶点）
        // 高度 = sqrt(3) × cellSize（垂直方向边到边）
        const hexWidth = cellSize * 2;
        const hexHeight = SQRT3 * cellSize;

        // 列间距 = 1.5 × hexWidth/2 = 0.75 × hexWidth
        const colStep = hexWidth * 0.75;
        // 行间距 = hexHeight
        const rowStep = hexHeight;

        // 估算网格数量
        const cols = Math.ceil((bbox.east - bbox.west) / colStep) + 1;
        const rows = Math.ceil((bbox.north - bbox.south) / rowStep) + 1;

        if (cols * rows > MAX_FEATURES) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] 网格数量超限`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                // 六角形中心坐标
                const cx = bbox.west + c * colStep;
                // 奇数列向上偏移半个行步长
                const cy = bbox.south + r * rowStep + (c % 2 === 1 ? rowStep * 0.5 : 0);

                // 跳过超出 bbox 范围的六角形
                if (cx - cellSize > bbox.east || cx + cellSize < bbox.west ||
                    cy - cellSize > bbox.north || cy + cellSize < bbox.south) {
                    continue;
                }

                // 扁平顶六角形的 6 个顶点（从右侧顶点开始逆时针）
                const ring: Position[] = [];
                for (let i = 0; i < 6; i++) {
                    // 角度：扁平顶从 0° 开始，每 60° 一个顶点
                    const angleDeg = 60 * i;
                    const angleRad = (Math.PI / 180) * angleDeg;
                    const vx = cx + cellSize * Math.cos(angleRad);
                    const vy = cy + cellSize * Math.sin(angleRad);
                    ring.push([vx, vy] as Position);
                }
                // 闭合
                ring.push([ring[0]![0], ring[0]![1]] as Position);

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties: { row: r, col: c },
                });
            }
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 生成三角形网格。
     * 将正方形网格的每个单元对角线切分为两个三角形。
     *
     * @param bbox - 覆盖范围
     * @param cellSize - 三角形底边长（度）
     * @returns 三角形网格 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const triGrid = GridOps.triangleGrid(bbox, 0.1);
     */
    triangleGrid(bbox: BBox2D, cellSize: number): FeatureCollection<PolygonGeometry> {
        // 校验 bbox
        if (!isValidBBox(bbox)) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_BBOX}] BBox 无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        if (!isFinite(cellSize) || cellSize < MIN_CELL_SIZE) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] cellSize 必须 > ${MIN_CELL_SIZE}`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        const cols = Math.ceil((bbox.east - bbox.west) / cellSize);
        const rows = Math.ceil((bbox.north - bbox.south) / cellSize);

        // 每个正方形产生 2 个三角形
        if (cols * rows * 2 > MAX_FEATURES) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_CELL_SIZE}] 网格数量超限`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = bbox.west + c * cellSize;
                const y0 = bbox.south + r * cellSize;
                const x1 = Math.min(x0 + cellSize, bbox.east);
                const y1 = Math.min(y0 + cellSize, bbox.north);

                // 下三角形（左下-右下-左上）
                const lowerRing: Position[] = [
                    [x0, y0] as Position,
                    [x1, y0] as Position,
                    [x0, y1] as Position,
                    [x0, y0] as Position,
                ];

                // 上三角形（右下-右上-左上）
                const upperRing: Position[] = [
                    [x1, y0] as Position,
                    [x1, y1] as Position,
                    [x0, y1] as Position,
                    [x1, y0] as Position,
                ];

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [lowerRing] },
                    properties: { row: r, col: c, half: 'lower' },
                });

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [upperRing] },
                    properties: { row: r, col: c, half: 'upper' },
                });
            }
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 生成 Voronoi 多边形（基于 Delaunay 三角剖分的对偶图）。
     * 每个 Voronoi 单元包含离其生成点最近的所有空间点。
     *
     * 算法：
     * 1. 对输入点执行 Delaunay 三角剖分
     * 2. 计算每个三角形的外接圆圆心
     * 3. 连接共享边的三角形外接圆圆心形成 Voronoi 边
     * 4. 用 bbox 裁剪无限 Voronoi 边
     *
     * @param points - 输入点坐标数组 [lon, lat]
     * @param bbox - 裁剪范围（Voronoi 边在此范围外被截断）
     * @returns Voronoi 多边形 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const voronoi = GridOps.voronoi([[0,0],[1,0],[0.5,1]], bbox);
     */
    voronoi(points: readonly Position[], bbox: BBox2D): FeatureCollection<PolygonGeometry> {
        // 校验输入
        if (!points || points.length < 3) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INSUFFICIENT_POINTS}] Voronoi 至少需要 3 个点`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        if (!isValidBBox(bbox)) {
            if (__DEV__) {
                console.warn(`[${GRID_ERROR_CODES.INVALID_BBOX}] BBox 无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 转换为 WeightedPoint 格式以复用 Delaunay 算法
        const weightedPoints = points.map(p => ({
            x: p[0],
            y: p[1],
            value: 0,
        }));

        const n = weightedPoints.length;

        // 执行 Delaunay 三角剖分（复用 interpolation 模块的算法逻辑）
        // 此处内联简化版 Bowyer-Watson 以避免跨模块依赖
        const triangleIndices = delaunaySimple(weightedPoints);

        if (triangleIndices.length === 0) {
            return { type: 'FeatureCollection', features: [] };
        }

        // 计算每个三角形的外接圆圆心
        const numTriangles = triangleIndices.length / 3;
        const circumcenters: Position[] = [];
        for (let t = 0; t < numTriangles; t++) {
            const ia = triangleIndices[t * 3]!;
            const ib = triangleIndices[t * 3 + 1]!;
            const ic = triangleIndices[t * 3 + 2]!;
            const a = weightedPoints[ia]!;
            const b = weightedPoints[ib]!;
            const c = weightedPoints[ic]!;

            const cc = circumcenter(a.x, a.y, b.x, b.y, c.x, c.y);
            circumcenters.push(cc);
        }

        // 构建每个点的 Voronoi 单元
        // 对于每个点，找到所有包含该点的三角形，收集其外接圆圆心
        const features: Feature<PolygonGeometry>[] = [];

        for (let p = 0; p < n; p++) {
            // 找到包含点 p 的所有三角形索引
            const adjacentTriangles: number[] = [];
            for (let t = 0; t < numTriangles; t++) {
                if (
                    triangleIndices[t * 3] === p ||
                    triangleIndices[t * 3 + 1] === p ||
                    triangleIndices[t * 3 + 2] === p
                ) {
                    adjacentTriangles.push(t);
                }
            }

            if (adjacentTriangles.length < 3) {
                continue;
            }

            // 收集外接圆圆心并按角度排序（围绕点 p 排列）
            const px = weightedPoints[p]!.x;
            const py = weightedPoints[p]!.y;

            const vertices = adjacentTriangles.map(t => ({
                pos: circumcenters[t]!,
                angle: Math.atan2(circumcenters[t]![1] - py, circumcenters[t]![0] - px),
            }));

            // 按角度排序形成多边形
            vertices.sort((a, b) => a.angle - b.angle);

            // 构建闭合环
            const ring: Position[] = vertices.map(v => v.pos);

            // 裁剪到 bbox（简化：只保留在 bbox 内的顶点，bbox 边界上的交点不计算）
            const clipped = ring.map(v => [
                Math.max(bbox.west, Math.min(bbox.east, v[0])),
                Math.max(bbox.south, Math.min(bbox.north, v[1])),
            ] as Position);

            // 闭合环
            if (clipped.length >= 3) {
                clipped.push([clipped[0]![0], clipped[0]![1]] as Position);

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [clipped] },
                    properties: { pointIndex: p },
                });
            }
        }

        return { type: 'FeatureCollection', features };
    },
} as const;

// ---------------------------------------------------------------------------
// Voronoi 辅助函数（内联简化版 Delaunay + 外接圆圆心）
// ---------------------------------------------------------------------------

/**
 * 简化版 Delaunay 三角剖分（Bowyer-Watson）。
 * 与 interpolation 模块中的算法相同，此处内联以避免跨子模块依赖。
 *
 * @param pts - 输入点数组
 * @returns 三角形顶点索引的扁平数组
 *
 * @example
 * const indices = delaunaySimple(points); // [0,1,2, 0,2,3, ...]
 */
function delaunaySimple(pts: readonly { x: number; y: number }[]): number[] {
    const n = pts.length;
    if (n < 3) return [];

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        if (pts[i]!.x < minX) minX = pts[i]!.x;
        if (pts[i]!.y < minY) minY = pts[i]!.y;
        if (pts[i]!.x > maxX) maxX = pts[i]!.x;
        if (pts[i]!.y > maxY) maxY = pts[i]!.y;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dmax = Math.max(dx, dy);
    const MARGIN = 10;
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;

    const allPts = [
        ...pts,
        { x: midX - MARGIN * dmax, y: midY - dmax },
        { x: midX + MARGIN * dmax, y: midY - dmax },
        { x: midX, y: midY + MARGIN * dmax },
    ];

    let tris: number[][] = [[n, n + 1, n + 2]];

    for (let i = 0; i < n; i++) {
        const p = allPts[i]!;
        const bad: number[] = [];

        for (let t = 0; t < tris.length; t++) {
            const tri = tris[t]!;
            const a = allPts[tri[0]!]!;
            const b = allPts[tri[1]!]!;
            const c = allPts[tri[2]!]!;
            if (inCircle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) {
                bad.push(t);
            }
        }

        const boundary: number[][] = [];
        for (const t of bad) {
            const tri = tris[t]!;
            const edges = [[tri[0]!, tri[1]!], [tri[1]!, tri[2]!], [tri[2]!, tri[0]!]];
            for (const edge of edges) {
                let shared = false;
                for (const t2 of bad) {
                    if (t2 === t) continue;
                    const tri2 = tris[t2]!;
                    const has =
                        (tri2[0] === edge[0] && tri2[1] === edge[1]) ||
                        (tri2[1] === edge[0] && tri2[2] === edge[1]) ||
                        (tri2[2] === edge[0] && tri2[0] === edge[1]) ||
                        (tri2[0] === edge[1] && tri2[1] === edge[0]) ||
                        (tri2[1] === edge[1] && tri2[2] === edge[0]) ||
                        (tri2[2] === edge[1] && tri2[0] === edge[0]);
                    if (has) { shared = true; break; }
                }
                if (!shared) boundary.push(edge);
            }
        }

        const sorted = bad.sort((a, b) => b - a);
        for (const idx of sorted) tris.splice(idx, 1);
        for (const edge of boundary) tris.push([edge[0]!, edge[1]!, i]);
    }

    tris = tris.filter(tri => tri[0]! < n && tri[1]! < n && tri[2]! < n);

    const result: number[] = [];
    for (const tri of tris) result.push(tri[0]!, tri[1]!, tri[2]!);
    return result;
}

/**
 * 判断点是否在三角形外接圆内。
 */
function inCircle(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
): boolean {
    const dax = ax - dx, day = ay - dy;
    const dbx = bx - dx, dby = by - dy;
    const dcx = cx - dx, dcy = cy - dy;
    const det =
        dax * (dby * (dcx * dcx + dcy * dcy) - dcy * (dbx * dbx + dby * dby)) -
        day * (dbx * (dcx * dcx + dcy * dcy) - dcx * (dbx * dbx + dby * dby)) +
        (dax * dax + day * day) * (dbx * dcy - dby * dcx);
    return det > 0;
}

/**
 * 计算三角形的外接圆圆心。
 *
 * @param ax - 顶点 A 的 x
 * @param ay - 顶点 A 的 y
 * @param bx - 顶点 B 的 x
 * @param by - 顶点 B 的 y
 * @param cx - 顶点 C 的 x
 * @param cy - 顶点 C 的 y
 * @returns 外接圆圆心坐标
 *
 * @example
 * circumcenter(0, 0, 1, 0, 0, 1); // → [0.5, 0.5]
 */
function circumcenter(
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
): Position {
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

    // 退化三角形（三点共线）——返回重心
    if (Math.abs(D) < EPSILON) {
        return [(ax + bx + cx) / 3, (ay + by + cy) / 3] as Position;
    }

    const ux = ((ax * ax + ay * ay) * (by - cy) +
        (bx * bx + by * by) * (cy - ay) +
        (cx * cx + cy * cy) * (ay - by)) / D;

    const uy = ((ax * ax + ay * ay) * (cx - bx) +
        (bx * bx + by * by) * (ax - cx) +
        (cx * cx + cy * cy) * (bx - ax)) / D;

    return [ux, uy] as Position;
}

export { GridOps as gridOps };
