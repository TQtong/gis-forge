// ============================================================
// algorithm/contain.ts — 几何包含关系检测（自研实现）
// 提供点在多边形、三角形、包围盒内的判定，以及点在线段上的判定。
// 所有算法零外部依赖，处理边界和退化情况。
// ============================================================

/**
 * 使用射线法（Ray Casting / Even-Odd Rule）判断点是否在多边形内部。
 * 从测试点向 +x 方向发射水平射线，统计与多边形边的交点数。
 * 奇数交点 = 在内部，偶数交点 = 在外部。
 *
 * 注意：对于点恰好在多边形边上的情况，结果取决于边的方向，
 * 建议使用 pointOnLine 先排除边界情况。
 *
 * @param point - 测试点 [x, y]
 * @param polygon - 多边形顶点数组 [[x1,y1], [x2,y2], ...]，首尾可以不闭合
 * @returns 点是否在多边形内部
 *
 * @example
 * const poly = [[0,0], [4,0], [4,4], [0,4]];
 * pointInPolygon([2, 2], poly); // → true（正方形中心）
 * pointInPolygon([5, 5], poly); // → false（正方形外部）
 */
export function pointInPolygon(
    point: [number, number],
    polygon: number[][],
): boolean {
    // 边界检查：多边形至少需要 3 个顶点
    if (polygon.length < 3) {
        return false;
    }

    // 测试点坐标
    const x = point[0];
    const y = point[1];

    let inside = false;
    const n = polygon.length;

    // 遍历多边形的每条边 (polygon[i], polygon[j])
    // j 从最后一个顶点开始，与第一个顶点构成最后一条边
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i][0];
        const yi = polygon[i][1];
        const xj = polygon[j][0];
        const yj = polygon[j][1];

        // 射线法核心条件：
        // 1) 边跨越测试点的 y 坐标（yi > y !== yj > y）
        // 2) 交点的 x 坐标在测试点右侧
        // 交点 x = xj + (y - yj) / (yi - yj) * (xi - xj)
        if (
            (yi > y) !== (yj > y) &&
            x < (xj - xi) * (y - yi) / (yj - yi) + xi
        ) {
            // 每次交叉翻转 inside 状态
            inside = !inside;
        }
    }

    return inside;
}

/**
 * 使用重心坐标法（Barycentric Coordinates）判断点是否在三角形内部。
 * 将点表示为三角形三个顶点的加权组合 P = u*A + v*B + w*C，
 * 当 u、v、w 均在 [0,1] 范围内时点在三角形内。
 *
 * 此方法数值稳定，且天然处理退化三角形（面积为 0 时返回 false）。
 *
 * @param px - 测试点 x 坐标
 * @param py - 测试点 y 坐标
 * @param ax - 三角形顶点 A 的 x 坐标
 * @param ay - 三角形顶点 A 的 y 坐标
 * @param bx - 三角形顶点 B 的 x 坐标
 * @param by - 三角形顶点 B 的 y 坐标
 * @param cx - 三角形顶点 C 的 x 坐标
 * @param cy - 三角形顶点 C 的 y 坐标
 * @returns 点是否在三角形内部（含边界）
 *
 * @example
 * pointInTriangle(0.5, 0.5, 0,0, 1,0, 0,1); // → true
 * pointInTriangle(2.0, 2.0, 0,0, 1,0, 0,1); // → false
 */
export function pointInTriangle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
): boolean {
    // 计算向量 v0 = C-A, v1 = B-A, v2 = P-A
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    // 计算点积
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    // 分母为三角形面积平方的 4 倍
    const denom = dot00 * dot11 - dot01 * dot01;

    // 退化三角形（面积为 0）：三点共线
    if (Math.abs(denom) < 1e-12) {
        return false;
    }

    // 计算重心坐标 (u, v)
    const invDenom = 1.0 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    // u >= 0, v >= 0, u + v <= 1 时点在三角形内（含边界）
    // 使用小容差处理浮点精度问题
    const epsilon = -1e-10;
    return u >= epsilon && v >= epsilon && (u + v) <= (1.0 - epsilon);
}

/**
 * 判断点 (x, y) 是否在轴对齐包围盒（AABB）内部。
 * 简单的范围检查，含边界。
 *
 * @param x - 测试点 x 坐标
 * @param y - 测试点 y 坐标
 * @param minX - 包围盒最小 x
 * @param minY - 包围盒最小 y
 * @param maxX - 包围盒最大 x
 * @param maxY - 包围盒最大 y
 * @returns 点是否在包围盒内（含边界）
 *
 * @example
 * pointInBBox(2, 3, 0, 0, 4, 4); // → true
 * pointInBBox(5, 3, 0, 0, 4, 4); // → false
 */
export function pointInBBox(
    x: number, y: number,
    minX: number, minY: number,
    maxX: number, maxY: number,
): boolean {
    // NaN 检查：如果任何坐标为 NaN，返回 false
    if (x !== x || y !== y || minX !== minX || minY !== minY || maxX !== maxX || maxY !== maxY) {
        return false;
    }

    // 简单的范围检查
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/**
 * 判断点 (px, py) 是否在线段 (x1,y1)-(x2,y2) 上（在容差范围内）。
 * 先计算点到线段的最短距离，如果小于容差则判定为在线段上。
 *
 * @param px - 测试点 x 坐标
 * @param py - 测试点 y 坐标
 * @param x1 - 线段起点 x
 * @param y1 - 线段起点 y
 * @param x2 - 线段终点 x
 * @param y2 - 线段终点 y
 * @param tolerance - 判定容差（默认 1e-6），单位与坐标系一致
 * @returns 点是否在线段上（距离 ≤ 容差）
 *
 * @example
 * pointOnLine(0.5, 0, 0, 0, 1, 0, 0.001); // → true（在水平线段上）
 * pointOnLine(0.5, 1, 0, 0, 1, 0, 0.001); // → false（距离线段太远）
 */
export function pointOnLine(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
    tolerance: number = 1e-6,
): boolean {
    // NaN 检查
    if (px !== px || py !== py || x1 !== x1 || y1 !== y1 || x2 !== x2 || y2 !== y2) {
        return false;
    }

    // 容差必须非负
    if (tolerance < 0) {
        tolerance = 0;
    }

    // 线段退化为一个点
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-20) {
        // 线段长度接近 0，比较点到端点的距离
        const distSq = (px - x1) * (px - x1) + (py - y1) * (py - y1);
        return distSq <= tolerance * tolerance;
    }

    // 计算投影参数 t = dot(P-A, B-A) / |B-A|²
    // t ∈ [0, 1] 表示投影点在线段上
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;

    // 将 t 限制在 [0, 1]，使投影点不超出线段两端
    if (t < 0) {
        t = 0;
    } else if (t > 1) {
        t = 1;
    }

    // 计算投影点坐标
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    // 计算点到投影点的距离平方
    const distSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);

    // 与容差比较
    return distSq <= tolerance * tolerance;
}

/**
 * 使用绕数法（Winding Number）判断点是否在多边形内部。
 *
 * 绕数法相比射线法（pointInPolygon）的优势：
 * - 正确处理自相交多边形：射线法对自相交区域结果不稳定（依赖奇偶规则），
 *   绕数法返回真实的旋转圈数。
 * - 对极端退化输入更稳健（不依赖单一射线方向）。
 *
 * 实现：累加每条边相对测试点的有符号扫过角度。
 * 使用 Sunday 提出的整数化优化版本：根据边端点是否跨越水平射线，
 * 用叉积符号判断绕向，避免昂贵的 atan2。
 *
 * @param point - 测试点 [x, y]
 * @param polygon - 多边形顶点数组（首尾可不闭合）
 * @returns 绕数 ≠ 0 表示在内部
 *
 * @example
 * const star = [[0,3],[1,1],[3,1],[1.5,-0.5],[2.5,-3],[0,-1.5],[-2.5,-3],[-1.5,-0.5],[-3,1],[-1,1]];
 * pointInPolygonWinding([0, 0], star); // → true（即使是自相交星形）
 */
export function pointInPolygonWinding(
    point: [number, number],
    polygon: number[][],
): boolean {
    if (polygon.length < 3) {
        return false;
    }

    const px = point[0];
    const py = point[1];

    if (px !== px || py !== py) {
        return false;
    }

    let wn = 0;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = polygon[j][0];
        const ay = polygon[j][1];
        const bx = polygon[i][0];
        const by = polygon[i][1];

        if (ay <= py) {
            // 边 a→b 向上跨越测试点的水平线
            if (by > py) {
                // 叉积 > 0 → b 在 a→p 的左侧 → 逆时针绕一圈
                const cross = (bx - ax) * (py - ay) - (px - ax) * (by - ay);
                if (cross > 0) {
                    wn++;
                }
            }
        } else {
            // 边 a→b 向下跨越测试点的水平线
            if (by <= py) {
                const cross = (bx - ax) * (py - ay) - (px - ax) * (by - ay);
                if (cross < 0) {
                    wn--;
                }
            }
        }
    }

    return wn !== 0;
}

/**
 * 计算点到多边形边界的最短距离（欧氏距离）。
 *
 * 遍历多边形所有边（包括所有内环），计算点到每条线段的最短距离，取最小值。
 * 注意：返回的是到**边界**的距离，不区分点在内部还是外部。
 * 若需要带符号距离（内部为负），调用方可结合 pointInPolygon 自行加符号。
 *
 * 性能：O(n)，n 为多边形顶点总数。批量查询场景应配合 R-Tree 加速。
 *
 * @param px 测试点 x
 * @param py 测试点 y
 * @param polygon 多边形（GeoJSON Polygon 风格）：第一个环为外环，其余为内环（孔洞）
 * @returns 点到边界的最短欧氏距离
 *
 * @example
 * const square = [[[0,0],[10,0],[10,10],[0,10],[0,0]]];
 * pointToPolygonDistance(15, 5, square); // → 5（外部，到右边界）
 * pointToPolygonDistance(5, 5, square);  // → 5（内部，到任一边界）
 */
export function pointToPolygonDistance(
    px: number, py: number,
    polygon: number[][][],
): number {
    if (px !== px || py !== py) {
        return NaN;
    }
    if (polygon.length === 0) {
        return Infinity;
    }

    let minDistSq = Infinity;

    for (let r = 0; r < polygon.length; r++) {
        const ring = polygon[r];
        const n = ring.length;
        if (n < 2) continue;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const ax = ring[j][0];
            const ay = ring[j][1];
            const bx = ring[i][0];
            const by = ring[i][1];

            // 点到线段 a-b 的最短距离平方
            const dx = bx - ax;
            const dy = by - ay;
            const lenSq = dx * dx + dy * dy;

            let cx: number;
            let cy: number;

            if (lenSq < 1e-20) {
                // 退化为点
                cx = ax;
                cy = ay;
            } else {
                let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                cx = ax + t * dx;
                cy = ay + t * dy;
            }

            const ddx = px - cx;
            const ddy = py - cy;
            const distSq = ddx * ddx + ddy * ddy;
            if (distSq < minDistSq) {
                minDistSq = distSq;
            }
        }
    }

    return Math.sqrt(minDistSq);
}
