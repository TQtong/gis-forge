// ============================================================
// algorithm/delaunay.ts — Delaunay 三角剖分与 Voronoi 图
// 增量插入算法 + 外接圆检测，O(n log n) 期望。
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 常量 ========================

/** 浮点零阈值 */
const EPSILON: number = 1e-10;

// ======================== Delaunay 三角剖分 ========================

/**
 * 对 2D 点集进行 Delaunay 三角剖分。
 * 使用 Bowyer-Watson 增量插入算法。
 *
 * 算法概述：
 *   1. 创建一个包含所有点的"超级三角形"
 *   2. 依次插入每个点，找到外接圆包含该点的所有三角形（"坏三角形"）
 *   3. 移除坏三角形，形成星形多边形空洞
 *   4. 用新点与空洞边界的每条边构造新三角形
 *   5. 插入完毕后移除与超级三角形相关的三角形
 *
 * @param points - 输入点集 [[x, y], ...]，至少 3 个不共线的点
 * @returns 三角形索引数组，每 3 个连续整数为一个三角形的顶点索引。
 *          例如 [0,1,2, 0,2,3] 表示 2 个三角形。
 *          空点集或不足 3 点返回空数组。
 *
 * @example
 * const indices = delaunay([[0,0], [1,0], [0.5,1], [1,1]]);
 * // 返回如 [0,1,2, 1,3,2]（2 个三角形）
 */
export function delaunay(points: number[][]): number[] {
    const n = points.length;
    // 不足 3 个点无法三角剖分
    if (n < 3) {
        return [];
    }

    // --- Step 1：计算包围盒并创建超级三角形 ---
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = points[i][0], y = points[i][1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    // 超级三角形必须足够大以包含所有点
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dmax = Math.max(dx, dy);
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;

    // 超级三角形的 3 个顶点（远离数据集的大三角形）
    const superP0: [number, number] = [midX - 20 * dmax, midY - dmax];
    const superP1: [number, number] = [midX, midY + 20 * dmax];
    const superP2: [number, number] = [midX + 20 * dmax, midY - dmax];

    // 构建含超级三角形顶点的扩展点集（超级顶点在索引 n, n+1, n+2）
    const allPoints: number[][] = points.slice();
    allPoints.push(superP0, superP1, superP2);

    // 初始三角形列表，每个三角形存 [i, j, k] 索引
    const triangles: number[][] = [[n, n + 1, n + 2]];

    // --- Step 2：增量插入每个点 ---
    for (let p = 0; p < n; p++) {
        const px = allPoints[p][0];
        const py = allPoints[p][1];

        // 找出外接圆包含点 p 的所有"坏三角形"
        const badTriangles: number[] = [];
        for (let t = 0; t < triangles.length; t++) {
            const tri = triangles[t];
            if (inCircumcircle(
                px, py,
                allPoints[tri[0]][0], allPoints[tri[0]][1],
                allPoints[tri[1]][0], allPoints[tri[1]][1],
                allPoints[tri[2]][0], allPoints[tri[2]][1],
            )) {
                badTriangles.push(t);
            }
        }

        // 收集坏三角形的边界边（只出现一次的边 = 空洞边界）
        const boundary: number[][] = [];
        for (let i = 0; i < badTriangles.length; i++) {
            const tri = triangles[badTriangles[i]];
            // 三角形的 3 条边
            const edges: number[][] = [
                [tri[0], tri[1]],
                [tri[1], tri[2]],
                [tri[2], tri[0]],
            ];

            for (let e = 0; e < 3; e++) {
                const edge = edges[e];
                let shared = false;
                // 检查这条边是否被其他坏三角形共享
                for (let j = 0; j < badTriangles.length; j++) {
                    if (j === i) continue;
                    const other = triangles[badTriangles[j]];
                    if (hasEdge(other, edge[0], edge[1])) {
                        shared = true;
                        break;
                    }
                }
                // 非共享边 = 空洞边界
                if (!shared) {
                    boundary.push(edge);
                }
            }
        }

        // 移除坏三角形（从后向前删除以保持索引有效）
        badTriangles.sort((a, b) => b - a);
        for (let i = 0; i < badTriangles.length; i++) {
            triangles.splice(badTriangles[i], 1);
        }

        // 用新点和空洞边界的每条边构造新三角形
        for (let i = 0; i < boundary.length; i++) {
            triangles.push([boundary[i][0], boundary[i][1], p]);
        }
    }

    // --- Step 3：移除与超级三角形顶点相关的三角形 ---
    const result: number[] = [];
    for (let t = 0; t < triangles.length; t++) {
        const tri = triangles[t];
        // 如果三角形的任何顶点是超级三角形的顶点，跳过
        if (tri[0] >= n || tri[1] >= n || tri[2] >= n) {
            continue;
        }
        result.push(tri[0], tri[1], tri[2]);
    }

    return result;
}

// ======================== Voronoi 图 ========================

/**
 * 从 Delaunay 三角剖分构造 Voronoi 图。
 * Voronoi 单元格是与每个输入点关联的凸多边形，
 * 多边形内的所有点都比其他输入点更接近该关联点。
 *
 * 算法概述：
 *   1. 先计算 Delaunay 三角剖分
 *   2. 每个三角形的外接圆圆心是 Voronoi 的一个顶点
 *   3. 对每个输入点，收集所有包含该点的三角形的外接圆圆心
 *   4. 按角度排序构成 Voronoi 单元格
 *   5. 用边界矩形裁剪无界单元格
 *
 * @param points - 输入点集 [[x, y], ...]
 * @param bbox - 边界矩形 [xmin, ymin, xmax, ymax]，用于裁剪无界单元格
 * @returns Voronoi 单元格数组，每个元素为一个多边形的顶点数组 [[[x,y], ...], ...]。
 *          单元格顺序与输入点顺序一致。
 *
 * @example
 * const cells = voronoi([[0,0], [2,0], [1,2]], [-5,-5,5,5]);
 * // cells[0] = 点 (0,0) 对应的 Voronoi 多边形
 */
export function voronoi(
    points: number[][],
    bbox: [number, number, number, number],
): number[][][] {
    const n = points.length;
    // 空点集或不足 3 点返回空数组
    if (n < 3) {
        return [];
    }

    // 计算 Delaunay 三角剖分
    const triIndices = delaunay(points);
    const triCount = triIndices.length / 3;

    // 如果没有三角形，返回空
    if (triCount === 0) {
        return [];
    }

    // 计算每个三角形的外接圆圆心
    const circumcenters: number[][] = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const i = triIndices[t * 3];
        const j = triIndices[t * 3 + 1];
        const k = triIndices[t * 3 + 2];
        circumcenters[t] = computeCircumcenter(
            points[i][0], points[i][1],
            points[j][0], points[j][1],
            points[k][0], points[k][1],
        );
    }

    // 为每个点收集包含它的三角形索引
    const pointTriangles: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
        pointTriangles[i] = [];
    }
    for (let t = 0; t < triCount; t++) {
        pointTriangles[triIndices[t * 3]].push(t);
        pointTriangles[triIndices[t * 3 + 1]].push(t);
        pointTriangles[triIndices[t * 3 + 2]].push(t);
    }

    // 构造每个 Voronoi 单元格
    const cells: number[][][] = new Array(n);
    for (let i = 0; i < n; i++) {
        const tris = pointTriangles[i];
        if (tris.length === 0) {
            cells[i] = [];
            continue;
        }

        // 收集该点关联的所有外接圆圆心
        const centers: number[][] = new Array(tris.length);
        for (let j = 0; j < tris.length; j++) {
            centers[j] = circumcenters[tris[j]];
        }

        // 按相对于该点的角度排序，形成有序多边形
        const px = points[i][0];
        const py = points[i][1];
        centers.sort((a, b) => {
            return Math.atan2(a[1] - py, a[0] - px) - Math.atan2(b[1] - py, b[0] - px);
        });

        // 裁剪到边界矩形内
        cells[i] = clipCellToBBox(centers, bbox);
    }

    return cells;
}

// ======================== 内部辅助函数 ========================

/**
 * 判断点 (px, py) 是否在三角形 (ax,ay)-(bx,by)-(cx,cy) 的外接圆内。
 * 使用行列式方法，正值表示在圆内。
 *
 * @returns true 如果点在外接圆内（含边界）
 */
function inCircumcircle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
): boolean {
    // 平移到以 (ax, ay) 为原点，减少浮点误差
    const dax = ax - px;
    const day = ay - py;
    const dbx = bx - px;
    const dby = by - py;
    const dcx = cx - px;
    const dcy = cy - py;

    // 行列式判断：
    // | dax  day  dax²+day² |
    // | dbx  dby  dbx²+dby² | > 0 → 点在外接圆内
    // | dcx  dcy  dcx²+dcy² |
    const det = (
        dax * (dby * (dcx * dcx + dcy * dcy) - dcy * (dbx * dbx + dby * dby))
        - day * (dbx * (dcx * dcx + dcy * dcy) - dcx * (dbx * dbx + dby * dby))
        + (dax * dax + day * day) * (dbx * dcy - dby * dcx)
    );

    // 正值 → 在外接圆内（假设三角形顶点逆时针排列）
    // 如果顺时针排列则符号翻转，因此取绝对值后用 orient2D 修正
    const orient = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (orient > 0) {
        return det > -EPSILON;
    }
    return -det > -EPSILON;
}

/**
 * 检查三角形是否包含指定边（无向边）。
 *
 * @param tri - 三角形顶点索引 [i, j, k]
 * @param a - 边顶点 1
 * @param b - 边顶点 2
 * @returns true 如果三角形包含边 (a, b)
 */
function hasEdge(tri: number[], a: number, b: number): boolean {
    // 检查 6 种可能的匹配（无向边：a-b 或 b-a）
    const i = tri[0], j = tri[1], k = tri[2];
    return (
        (i === a && j === b) || (j === a && i === b) ||
        (j === a && k === b) || (k === a && j === b) ||
        (k === a && i === b) || (i === a && k === b)
    );
}

/**
 * 计算三角形的外接圆圆心。
 *
 * @returns [cx, cy] 外接圆圆心坐标
 */
function computeCircumcenter(
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
): number[] {
    // 用行列式公式计算
    const D = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

    // 退化：三点共线
    if (Math.abs(D) < EPSILON) {
        return [(ax + bx + cx) / 3.0, (ay + by + cy) / 3.0];
    }

    const aSq = ax * ax + ay * ay;
    const bSq = bx * bx + by * by;
    const cSq = cx * cx + cy * cy;

    const ux = (aSq * (by - cy) + bSq * (cy - ay) + cSq * (ay - by)) / D;
    const uy = (aSq * (cx - bx) + bSq * (ax - cx) + cSq * (bx - ax)) / D;

    return [ux, uy];
}

/**
 * 将 Voronoi 单元格裁剪到边界矩形。
 * 简单处理：丢弃边界外的顶点，用边界交点替换。
 *
 * @param cell - Voronoi 单元格顶点
 * @param bbox - 边界矩形 [xmin, ymin, xmax, ymax]
 * @returns 裁剪后的顶点数组
 */
function clipCellToBBox(
    cell: number[][],
    bbox: [number, number, number, number],
): number[][] {
    const [xmin, ymin, xmax, ymax] = bbox;

    // 逐边裁剪（与 Sutherland-Hodgman 类似的简化版本）
    let output = cell;

    // 左边
    output = clipCellByEdge(output, (p) => p[0] >= xmin, (a, b) => {
        const t = (xmin - a[0]) / (b[0] - a[0]);
        return [xmin, a[1] + t * (b[1] - a[1])];
    });
    // 右边
    output = clipCellByEdge(output, (p) => p[0] <= xmax, (a, b) => {
        const t = (xmax - a[0]) / (b[0] - a[0]);
        return [xmax, a[1] + t * (b[1] - a[1])];
    });
    // 下边
    output = clipCellByEdge(output, (p) => p[1] >= ymin, (a, b) => {
        const t = (ymin - a[1]) / (b[1] - a[1]);
        return [a[0] + t * (b[0] - a[0]), ymin];
    });
    // 上边
    output = clipCellByEdge(output, (p) => p[1] <= ymax, (a, b) => {
        const t = (ymax - a[1]) / (b[1] - a[1]);
        return [a[0] + t * (b[0] - a[0]), ymax];
    });

    return output;
}

/**
 * 按单条裁剪边裁剪多边形。
 *
 * @param polygon - 输入多边形
 * @param isInside - 内侧判断
 * @param intersect - 交点计算
 * @returns 裁剪后的多边形
 */
function clipCellByEdge(
    polygon: number[][],
    isInside: (p: number[]) => boolean,
    intersect: (a: number[], b: number[]) => number[],
): number[][] {
    if (polygon.length === 0) return [];

    const output: number[][] = [];
    const len = polygon.length;

    for (let i = 0; i < len; i++) {
        const current = polygon[i];
        const next = polygon[(i + 1) % len];
        const curIn = isInside(current);
        const nextIn = isInside(next);

        if (curIn && nextIn) {
            output.push(next);
        } else if (curIn && !nextIn) {
            output.push(intersect(current, next));
        } else if (!curIn && nextIn) {
            output.push(intersect(current, next));
            output.push(next);
        }
    }

    return output;
}

declare const __DEV__: boolean;
