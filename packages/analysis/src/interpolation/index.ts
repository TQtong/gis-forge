// ============================================================
// analysis/interpolation/index.ts — 空间插值分析
// 职责：TIN（Delaunay 三角剖分）、IDW（反距离加权插值）、
//       等值线（Marching Squares）、双线性/双三次插值。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { Position, PolygonGeometry, LineStringGeometry } from '../../../core/src/types/geometry.ts';
import type { Feature, FeatureCollection } from '../../../core/src/types/feature.ts';
import type { BBox2D } from '../../../core/src/types/math-types.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const INTERP_ERROR_CODES = {
    /** 输入点数不足 */
    INSUFFICIENT_POINTS: 'INTERP_INSUFFICIENT_POINTS',
    /** 网格参数无效 */
    INVALID_GRID: 'INTERP_INVALID_GRID',
    /** IDW 幂次参数无效 */
    INVALID_POWER: 'INTERP_INVALID_POWER',
    /** 输入数据无效 */
    INVALID_DATA: 'INTERP_INVALID_DATA',
    /** 等值线阈值无效 */
    INVALID_THRESHOLDS: 'INTERP_INVALID_THRESHOLDS',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** IDW 默认幂次——幂次越高，近邻权重越大 */
const DEFAULT_IDW_POWER = 2;

/** IDW 零距离阈值——距离小于此值时直接返回已知点值（避免除零） */
const IDW_ZERO_DISTANCE = 1e-10;

/** Delaunay 三角剖分最少需要的非共线点数 */
const MIN_TRIANGULATION_POINTS = 3;

/** Marching Squares 16 种 case 的边交叉索引查找表 */
const MS_EDGE_TABLE: readonly (readonly number[])[] = [
    /* case 0:  0000 */ [],
    /* case 1:  0001 */ [3, 0],
    /* case 2:  0010 */ [0, 1],
    /* case 3:  0011 */ [3, 1],
    /* case 4:  0100 */ [1, 2],
    /* case 5:  0101 */ [3, 0, 1, 2],
    /* case 6:  0110 */ [0, 2],
    /* case 7:  0111 */ [3, 2],
    /* case 8:  1000 */ [2, 3],
    /* case 9:  1001 */ [2, 0],
    /* case 10: 1010 */ [0, 1, 2, 3],
    /* case 11: 1011 */ [2, 1],
    /* case 12: 1100 */ [1, 3],
    /* case 13: 1101 */ [1, 0],
    /* case 14: 1110 */ [0, 3],
    /* case 15: 1111 */ [],
];

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

/**
 * 带权重值的采样点（用于 IDW/TIN）。
 *
 * @stability experimental
 */
export interface WeightedPoint {
    /** 经度（度） */
    readonly x: number;
    /** 纬度（度） */
    readonly y: number;
    /** 该点的观测值（如温度、海拔、降水量等） */
    readonly value: number;
}

/**
 * 规则网格数据结构（用于等值线/栅格分析）。
 *
 * @stability experimental
 */
export interface GridData {
    /** 网格值二维数组，grid[row][col]。NaN 表示无数据。 */
    readonly values: readonly (readonly number[])[];
    /** 网格行数 */
    readonly rows: number;
    /** 网格列数 */
    readonly cols: number;
    /** 网格覆盖范围 */
    readonly bbox: BBox2D;
}

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 计算两点的欧几里得距离（平面近似，适用于小范围）。
 *
 * @param x1 - 点 1 x
 * @param y1 - 点 1 y
 * @param x2 - 点 2 x
 * @param y2 - 点 2 y
 * @returns 距离
 *
 * @example
 * dist(0, 0, 3, 4); // → 5
 */
function dist(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 判断点 d 是否在三角形 abc 的外接圆内。
 * Delaunay 条件检查核心：如果 d 在 abc 外接圆内，则需要翻转对角线。
 *
 * @param ax - 点 a 的 x 坐标
 * @param ay - 点 a 的 y 坐标
 * @param bx - 点 b 的 x 坐标
 * @param by - 点 b 的 y 坐标
 * @param cx - 点 c 的 x 坐标
 * @param cy - 点 c 的 y 坐标
 * @param dx - 点 d 的 x 坐标
 * @param dy - 点 d 的 y 坐标
 * @returns true 表示 d 在 abc 外接圆内
 *
 * @example
 * inCircumcircle(0,0, 1,0, 0,1, 0.3,0.3); // → true
 */
function inCircumcircle(
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
    dx: number, dy: number
): boolean {
    // 行列式判据——通过 3×3 行列式的符号判断 d 是否在 abc 外接圆内
    const dax = ax - dx;
    const day = ay - dy;
    const dbx = bx - dx;
    const dby = by - dy;
    const dcx = cx - dx;
    const dcy = cy - dy;

    const det =
        dax * (dby * (dcx * dcx + dcy * dcy) - dcy * (dbx * dbx + dby * dby)) -
        day * (dbx * (dcx * dcx + dcy * dcy) - dcx * (dbx * dbx + dby * dby)) +
        (dax * dax + day * day) * (dbx * dcy - dby * dcx);

    // 正值表示 abc 为逆时针且 d 在外接圆内
    return det > 0;
}

/**
 * 增量式 Delaunay 三角剖分（Bowyer-Watson 算法）。
 * 逐点插入，删除不满足 Delaunay 条件的三角形，重新三角化星形孔洞。
 *
 * @param points - 输入点数组
 * @returns 三角形索引数组，每 3 个元素为一个三角形的顶点索引
 *
 * @example
 * const triangles = delaunay(points); // [0,1,2, 0,2,3, ...]
 */
function delaunay(points: readonly WeightedPoint[]): number[] {
    const n = points.length;
    if (n < MIN_TRIANGULATION_POINTS) {
        return [];
    }

    // 找到包围所有点的超级三角形
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const p = points[i]!;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dmax = Math.max(dx, dy);

    // 超级三角形顶点——足够大以包围所有点
    const SUPER_MARGIN = 10;
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;

    // 超级三角形的三个虚拟点索引为 n, n+1, n+2
    const superA: WeightedPoint = { x: midX - SUPER_MARGIN * dmax, y: midY - dmax, value: 0 };
    const superB: WeightedPoint = { x: midX + SUPER_MARGIN * dmax, y: midY - dmax, value: 0 };
    const superC: WeightedPoint = { x: midX, y: midY + SUPER_MARGIN * dmax, value: 0 };

    // 扩展点数组以包含超级三角形顶点
    const allPoints: WeightedPoint[] = [...points, superA, superB, superC];

    // 三角形列表：每个三角形存储为 [i, j, k] 顶点索引
    let triangles: number[][] = [[n, n + 1, n + 2]];

    // 逐点插入
    for (let i = 0; i < n; i++) {
        const p = allPoints[i]!;
        const badTriangles: number[] = [];

        // 找出所有外接圆包含新点的三角形
        for (let t = 0; t < triangles.length; t++) {
            const tri = triangles[t]!;
            const a = allPoints[tri[0]!]!;
            const b = allPoints[tri[1]!]!;
            const c = allPoints[tri[2]!]!;

            if (inCircumcircle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) {
                badTriangles.push(t);
            }
        }

        // 收集坏三角形的边界边（多边形孔洞边界）
        const boundary: number[][] = [];
        for (const t of badTriangles) {
            const tri = triangles[t]!;
            // 三角形的三条边
            const edges: number[][] = [
                [tri[0]!, tri[1]!],
                [tri[1]!, tri[2]!],
                [tri[2]!, tri[0]!],
            ];

            for (const edge of edges) {
                // 如果这条边只属于一个坏三角形，则它是边界边
                let shared = false;
                for (const t2 of badTriangles) {
                    if (t2 === t) continue;
                    const tri2 = triangles[t2]!;
                    // 检查 tri2 是否包含这条边（无序匹配）
                    const hasEdge =
                        (tri2[0] === edge[0] && tri2[1] === edge[1]) ||
                        (tri2[1] === edge[0] && tri2[2] === edge[1]) ||
                        (tri2[2] === edge[0] && tri2[0] === edge[1]) ||
                        (tri2[0] === edge[1] && tri2[1] === edge[0]) ||
                        (tri2[1] === edge[1] && tri2[2] === edge[0]) ||
                        (tri2[2] === edge[1] && tri2[0] === edge[0]);
                    if (hasEdge) {
                        shared = true;
                        break;
                    }
                }
                if (!shared) {
                    boundary.push(edge);
                }
            }
        }

        // 删除坏三角形（从后往前删以保持索引有效）
        const sortedBad = badTriangles.sort((a, b) => b - a);
        for (const idx of sortedBad) {
            triangles.splice(idx, 1);
        }

        // 用新点和边界边创建新三角形
        for (const edge of boundary) {
            triangles.push([edge[0]!, edge[1]!, i]);
        }
    }

    // 移除包含超级三角形顶点的三角形
    triangles = triangles.filter(tri => {
        return tri[0]! < n && tri[1]! < n && tri[2]! < n;
    });

    // 扁平化为索引数组
    const result: number[] = [];
    for (const tri of triangles) {
        result.push(tri[0]!, tri[1]!, tri[2]!);
    }

    return result;
}

/**
 * Marching Squares 等值线提取——根据网格数据和阈值生成等值线。
 * 使用 16-case 查找表和线性插值计算边交叉点。
 *
 * @param grid - 规则网格数据
 * @param threshold - 等值线阈值
 * @returns 等值线段数组，每条线段为两个端点
 *
 * @example
 * const segments = marchingSquares(grid, 100); // 提取 100m 等高线
 */
function marchingSquares(
    grid: GridData,
    threshold: number
): Position[][] {
    const { values, rows, cols, bbox } = grid;

    // 安全检查
    if (rows < 2 || cols < 2) {
        return [];
    }

    // 计算网格单元的地理尺寸
    const cellWidth = (bbox.east - bbox.west) / (cols - 1);
    const cellHeight = (bbox.north - bbox.south) / (rows - 1);

    const segments: Position[][] = [];

    // 遍历每个 2×2 网格单元
    for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < cols - 1; col++) {
            // 四个角的值（按左下、右下、右上、左上顺序）
            // grid 索引：[row][col] 对应空间 (west + col*cellWidth, south + row*cellHeight)
            const bl = values[row]![col]!;      // 左下 (bottom-left)
            const br = values[row]![col + 1]!;  // 右下 (bottom-right)
            const tr = values[row + 1]![col + 1]!;  // 右上 (top-right)
            const tl = values[row + 1]![col]!;  // 左上 (top-left)

            // 跳过含 NaN 的单元
            if (isNaN(bl) || isNaN(br) || isNaN(tr) || isNaN(tl)) {
                continue;
            }

            // 计算 case index（4-bit 编码，每个角是否 >= threshold）
            let caseIndex = 0;
            if (bl >= threshold) caseIndex |= 1;
            if (br >= threshold) caseIndex |= 2;
            if (tr >= threshold) caseIndex |= 4;
            if (tl >= threshold) caseIndex |= 8;

            // 查找边交叉表
            const edges = MS_EDGE_TABLE[caseIndex]!;
            if (edges.length === 0) {
                continue;
            }

            // 计算四个角的地理坐标
            const x0 = bbox.west + col * cellWidth;
            const x1 = bbox.west + (col + 1) * cellWidth;
            const y0 = bbox.south + row * cellHeight;
            const y1 = bbox.south + (row + 1) * cellHeight;

            // 四条边的线性插值交叉点
            // 边 0: 底边 bl → br
            // 边 1: 右边 br → tr
            // 边 2: 顶边 tr → tl
            // 边 3: 左边 tl → bl
            const edgePoints: Position[] = new Array(4);

            // 边 0: 底边——x 方向插值
            const t0 = (threshold - bl) / (br - bl);
            edgePoints[0] = [x0 + t0 * (x1 - x0), y0] as Position;

            // 边 1: 右边——y 方向插值
            const t1 = (threshold - br) / (tr - br);
            edgePoints[1] = [x1, y0 + t1 * (y1 - y0)] as Position;

            // 边 2: 顶边——x 方向插值（注意方向 tr → tl）
            const t2 = (threshold - tr) / (tl - tr);
            edgePoints[2] = [x1 + t2 * (x0 - x1), y1] as Position;

            // 边 3: 左边——y 方向插值（注意方向 tl → bl）
            const t3 = (threshold - tl) / (bl - tl);
            edgePoints[3] = [x0, y1 + t3 * (y0 - y1)] as Position;

            // 根据 edge 表每两个一组构成线段
            for (let i = 0; i < edges.length; i += 2) {
                const startEdge = edges[i]!;
                const endEdge = edges[i + 1]!;
                segments.push([edgePoints[startEdge]!, edgePoints[endEdge]!]);
            }
        }
    }

    return segments;
}

/**
 * 将 Marching Squares 输出的离散线段连接成连续等值线。
 * 通过端点匹配将相邻线段串联。
 *
 * @param segments - 离散线段数组
 * @returns 连续等值线坐标数组
 *
 * @example
 * const lines = connectSegments(segments);
 */
function connectSegments(segments: Position[][]): Position[][] {
    if (segments.length === 0) {
        return [];
    }

    // 使用简单的端点匹配——将线段连接成链
    const MATCH_EPSILON = 1e-8;
    const used = new Array<boolean>(segments.length).fill(false);
    const lines: Position[][] = [];

    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        used[i] = true;

        // 从当前线段开始构建一条线
        const line: Position[] = [segments[i]![0]!, segments[i]![1]!];

        // 向前扩展（从 line 末端匹配）
        let extended = true;
        while (extended) {
            extended = false;
            const tail = line[line.length - 1]!;

            for (let j = 0; j < segments.length; j++) {
                if (used[j]) continue;

                const seg = segments[j]!;
                const s0 = seg[0]!;
                const s1 = seg[1]!;

                // 检查 seg 起点是否匹配 tail
                if (Math.abs(s0[0] - tail[0]) < MATCH_EPSILON &&
                    Math.abs(s0[1] - tail[1]) < MATCH_EPSILON) {
                    line.push(s1);
                    used[j] = true;
                    extended = true;
                    break;
                }

                // 检查 seg 终点是否匹配 tail（反向连接）
                if (Math.abs(s1[0] - tail[0]) < MATCH_EPSILON &&
                    Math.abs(s1[1] - tail[1]) < MATCH_EPSILON) {
                    line.push(s0);
                    used[j] = true;
                    extended = true;
                    break;
                }
            }
        }

        lines.push(line);
    }

    return lines;
}

// ---------------------------------------------------------------------------
// InterpolationOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 空间插值运算集合。
 * 提供 TIN、IDW、等值线、双线性/双三次插值等常用空间插值方法。
 *
 * @stability experimental
 *
 * @example
 * const grid = InterpolationOps.idw(points, bbox, 100, 100, 2);
 */
export const InterpolationOps = {
    /**
     * 构建 Delaunay 三角网（TIN）。
     * 使用 Bowyer-Watson 增量算法进行 Delaunay 三角剖分。
     * 返回三角形多边形的 FeatureCollection。
     *
     * @param points - 输入采样点数组，至少 3 个
     * @returns 三角形 FeatureCollection，每个 Feature 属性包含三个顶点的 value
     *
     * @stability experimental
     *
     * @example
     * const tin = InterpolationOps.tin(samplePoints);
     */
    tin(points: readonly WeightedPoint[]): FeatureCollection<PolygonGeometry> {
        // 校验输入
        if (!points || points.length < MIN_TRIANGULATION_POINTS) {
            if (__DEV__) {
                console.warn(
                    `[${INTERP_ERROR_CODES.INSUFFICIENT_POINTS}] TIN 至少需要 ${MIN_TRIANGULATION_POINTS} 个点，当前 ${points?.length ?? 0}`
                );
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 过滤无效点（NaN 坐标或值）
        const validPoints = points.filter(
            p => isFinite(p.x) && isFinite(p.y) && isFinite(p.value)
        );

        if (validPoints.length < MIN_TRIANGULATION_POINTS) {
            return { type: 'FeatureCollection', features: [] };
        }

        // 执行 Delaunay 三角剖分
        const indices = delaunay(validPoints);

        // 将索引数组转换为三角形 Feature
        const features: Feature<PolygonGeometry>[] = [];
        for (let i = 0; i < indices.length; i += 3) {
            const ia = indices[i]!;
            const ib = indices[i + 1]!;
            const ic = indices[i + 2]!;

            const a = validPoints[ia]!;
            const b = validPoints[ib]!;
            const c = validPoints[ic]!;

            // 构建三角形多边形（闭合环）
            const ring: Position[] = [
                [a.x, a.y] as Position,
                [b.x, b.y] as Position,
                [c.x, c.y] as Position,
                [a.x, a.y] as Position,
            ];

            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [ring],
                },
                properties: {
                    a: a.value,
                    b: b.value,
                    c: c.value,
                },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 反距离加权插值（IDW）。
     * 在指定范围内生成规则网格，每个网格点的值由周围已知点按距离加权计算。
     *
     * @param points - 输入采样点数组
     * @param bbox - 输出网格覆盖范围
     * @param cols - 输出网格列数
     * @param rows - 输出网格行数
     * @param power - 距离幂次（默认 2），越大则近邻影响越强
     * @returns GridData 网格数据
     *
     * @stability experimental
     *
     * @example
     * const grid = InterpolationOps.idw(points, bbox, 100, 100, 2);
     */
    idw(
        points: readonly WeightedPoint[],
        bbox: BBox2D,
        cols: number,
        rows: number,
        power: number = DEFAULT_IDW_POWER
    ): GridData {
        // 校验输入
        if (!points || points.length === 0) {
            if (__DEV__) {
                console.warn(`[${INTERP_ERROR_CODES.INSUFFICIENT_POINTS}] IDW 至少需要 1 个采样点`);
            }
            return { values: [], rows: 0, cols: 0, bbox };
        }

        if (cols < 1 || rows < 1 || !isFinite(cols) || !isFinite(rows)) {
            if (__DEV__) {
                console.warn(`[${INTERP_ERROR_CODES.INVALID_GRID}] 网格尺寸无效: ${cols}×${rows}`);
            }
            return { values: [], rows: 0, cols: 0, bbox };
        }

        if (!isFinite(power) || power <= 0) {
            if (__DEV__) {
                console.warn(`[${INTERP_ERROR_CODES.INVALID_POWER}] 幂次必须 > 0，当前: ${power}`);
            }
            power = DEFAULT_IDW_POWER;
        }

        const safeCols = Math.round(cols);
        const safeRows = Math.round(rows);

        // 过滤无效点
        const validPoints = points.filter(
            p => isFinite(p.x) && isFinite(p.y) && isFinite(p.value)
        );

        if (validPoints.length === 0) {
            return { values: [], rows: 0, cols: 0, bbox };
        }

        // 计算网格单元尺寸
        const cellWidth = (bbox.east - bbox.west) / Math.max(1, safeCols - 1);
        const cellHeight = (bbox.north - bbox.south) / Math.max(1, safeRows - 1);

        // 生成网格值
        const values: number[][] = [];
        for (let r = 0; r < safeRows; r++) {
            const row: number[] = [];
            for (let c = 0; c < safeCols; c++) {
                const gx = bbox.west + c * cellWidth;
                const gy = bbox.south + r * cellHeight;

                // IDW 计算：value = Σ(w_i × v_i) / Σ(w_i)，其中 w_i = 1 / d_i^p
                let weightSum = 0;
                let valueSum = 0;
                let exactMatch = false;
                let exactValue = 0;

                for (let i = 0; i < validPoints.length; i++) {
                    const pt = validPoints[i]!;
                    const d = dist(gx, gy, pt.x, pt.y);

                    // 距离极小时直接取该点值（避免除零）
                    if (d < IDW_ZERO_DISTANCE) {
                        exactMatch = true;
                        exactValue = pt.value;
                        break;
                    }

                    const weight = 1.0 / Math.pow(d, power);
                    weightSum += weight;
                    valueSum += weight * pt.value;
                }

                if (exactMatch) {
                    row.push(exactValue);
                } else if (weightSum > 0) {
                    row.push(valueSum / weightSum);
                } else {
                    row.push(NaN);
                }
            }
            values.push(row);
        }

        return { values, rows: safeRows, cols: safeCols, bbox };
    },

    /**
     * 等值线提取（Marching Squares 算法）。
     * 从规则网格数据中提取指定阈值的等值线，生成 LineString FeatureCollection。
     * 使用完整的 16-case 查找表和线性插值计算边交叉点。
     *
     * @param grid - 规则网格数据
     * @param thresholds - 等值线阈值数组
     * @returns 等值线 FeatureCollection，每条线带 threshold 属性
     *
     * @stability experimental
     *
     * @example
     * const contours = InterpolationOps.isolines(grid, [100, 200, 300, 400, 500]);
     */
    isolines(
        grid: GridData,
        thresholds: readonly number[]
    ): FeatureCollection<LineStringGeometry> {
        // 校验输入
        if (!grid || !grid.values || grid.rows < 2 || grid.cols < 2) {
            if (__DEV__) {
                console.warn(`[${INTERP_ERROR_CODES.INVALID_DATA}] 网格数据无效或尺寸不足`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        if (!thresholds || thresholds.length === 0) {
            if (__DEV__) {
                console.warn(`[${INTERP_ERROR_CODES.INVALID_THRESHOLDS}] 至少需要一个阈值`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<LineStringGeometry>[] = [];

        // 对每个阈值提取等值线
        for (const threshold of thresholds) {
            if (!isFinite(threshold)) {
                continue;
            }

            // 提取离散线段
            const segments = marchingSquares(grid, threshold);

            // 连接线段为连续线
            const lines = connectSegments(segments);

            // 将连续线转换为 Feature
            for (const coords of lines) {
                // 至少 2 个点才能形成线
                if (coords.length < 2) {
                    continue;
                }

                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: coords,
                    },
                    properties: { threshold },
                });
            }
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 双线性插值。
     * 在四个角值定义的单元内，对给定 (u, v) 参数坐标进行双线性插值。
     *
     * @param q00 - 左下角值
     * @param q10 - 右下角值
     * @param q01 - 左上角值
     * @param q11 - 右上角值
     * @param u - x 方向参数 [0, 1]
     * @param v - y 方向参数 [0, 1]
     * @returns 插值结果
     *
     * @stability experimental
     *
     * @example
     * InterpolationOps.bilinear(0, 1, 2, 3, 0.5, 0.5); // → 1.5
     */
    bilinear(
        q00: number,
        q10: number,
        q01: number,
        q11: number,
        u: number,
        v: number
    ): number {
        // 处理 NaN 输入
        if (isNaN(q00) || isNaN(q10) || isNaN(q01) || isNaN(q11)) {
            return NaN;
        }

        // 钳制参数到 [0, 1]
        const su = Math.max(0, Math.min(1, u));
        const sv = Math.max(0, Math.min(1, v));

        // 双线性插值公式：先沿 x 方向插值两次，再沿 y 方向插值一次
        const r0 = q00 * (1 - su) + q10 * su;  // 底边插值
        const r1 = q01 * (1 - su) + q11 * su;  // 顶边插值
        return r0 * (1 - sv) + r1 * sv;         // 纵向插值
    },

    /**
     * 双三次插值（Catmull-Rom 样条）。
     * 在 4×4 邻域格点定义的区域内，对给定参数坐标进行双三次插值。
     * 结果比双线性更平滑，但可能产生过冲（值超出输入范围）。
     *
     * @param grid4x4 - 4×4 网格值数组（行优先，grid4x4[row][col]）
     * @param u - x 方向参数 [0, 1]（在中心 2×2 单元内的位置）
     * @param v - y 方向参数 [0, 1]（在中心 2×2 单元内的位置）
     * @returns 插值结果
     *
     * @stability experimental
     *
     * @example
     * const grid4x4 = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16]];
     * InterpolationOps.bicubic(grid4x4, 0.5, 0.5); // ≈ 8.5
     */
    bicubic(
        grid4x4: readonly (readonly number[])[],
        u: number,
        v: number
    ): number {
        // 校验 4×4 网格
        if (!grid4x4 || grid4x4.length < 4) {
            return NaN;
        }
        for (let i = 0; i < 4; i++) {
            if (!grid4x4[i] || grid4x4[i]!.length < 4) {
                return NaN;
            }
        }

        // 钳制参数
        const su = Math.max(0, Math.min(1, u));
        const sv = Math.max(0, Math.min(1, v));

        // Catmull-Rom 三次核函数
        const cubicKernel = (t: number): [number, number, number, number] => {
            const t2 = t * t;
            const t3 = t2 * t;
            return [
                -0.5 * t3 + t2 - 0.5 * t,         // w0
                1.5 * t3 - 2.5 * t2 + 1.0,          // w1
                -1.5 * t3 + 2.0 * t2 + 0.5 * t,    // w2
                0.5 * t3 - 0.5 * t2,                 // w3
            ];
        };

        // 计算 x/y 方向的权重
        const wx = cubicKernel(su);
        const wy = cubicKernel(sv);

        // 先沿 x 方向对每行插值
        let result = 0;
        for (let j = 0; j < 4; j++) {
            let rowVal = 0;
            for (let i = 0; i < 4; i++) {
                const val = grid4x4[j]![i]!;
                if (isNaN(val)) return NaN;
                rowVal += wx[i]! * val;
            }
            result += wy[j]! * rowVal;
        }

        return result;
    },
} as const;

export { InterpolationOps as interpolationOps };
