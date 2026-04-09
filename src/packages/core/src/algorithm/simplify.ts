// ============================================================
// algorithm/simplify.ts — 线简化算法（自研实现）
// 提供 Douglas-Peucker 和 Visvalingam-Whyatt 两种线简化方法。
// Douglas-Peucker 基于最大距离偏差，Visvalingam 基于最小三角形面积。
// 零外部依赖。
// ============================================================

// ======================== 公共 API ========================

/**
 * Douglas-Peucker 线简化算法。
 * 递归地找到离线段最远的点，如果距离超过容差则保留该点并递归处理两侧。
 * 时间复杂度 O(n log n) 平均，O(n²) 最坏。
 * 适合保持线的整体形状特征。
 *
 * @param points - 输入点序列 [[x1,y1], [x2,y2], ...]
 * @param tolerance - 简化容差（与点到线段的垂直距离比较），
 *                    单位与坐标系一致。值越大简化越激进。
 * @returns 简化后的点序列（首尾点始终保留）
 *
 * @example
 * const line = [[0,0], [1,0.1], [2,0], [3,0.2], [4,0]];
 * const simplified = douglasPeucker(line, 0.5);
 * // → [[0,0], [4,0]]（中间点偏差均小于 0.5，被移除）
 */
export function douglasPeucker(
    points: number[][],
    tolerance: number,
): number[][] {
    // 边界检查：不足 3 个点时无需简化
    if (points.length <= 2) {
        return points.slice();
    }

    // 容差不能为负
    if (tolerance < 0) {
        tolerance = 0;
    }

    // 容差的平方，避免在比较时频繁开方
    const sqTolerance = tolerance * tolerance;

    // 标记数组：true 表示该点被保留
    const keep = new Uint8Array(points.length);

    // 首尾点始终保留
    keep[0] = 1;
    keep[points.length - 1] = 1;

    // 递归标记需要保留的点
    dpStep(points, 0, points.length - 1, sqTolerance, keep);

    // 根据标记收集保留的点
    const result: number[][] = [];
    for (let i = 0; i < points.length; i++) {
        if (keep[i] === 1) {
            result.push(points[i]);
        }
    }

    return result;
}

/**
 * Visvalingam-Whyatt 线简化算法（面积-based）。
 * 迭代移除"有效面积"最小的顶点，直到所有剩余顶点的有效面积都大于容差。
 * 有效面积 = 该顶点与前后两个顶点构成的三角形面积。
 * 时间复杂度 O(n²)（可用优先队列优化到 O(n log n)，此处为简单实现）。
 * 适合保持区域面积特征。
 *
 * @param points - 输入点序列 [[x1,y1], [x2,y2], ...]
 * @param tolerance - 最小面积容差，面积小于此值的顶点将被移除。
 *                    注意这里是三角形面积，不是距离。
 * @returns 简化后的点序列（首尾点始终保留）
 *
 * @example
 * const line = [[0,0], [1,0.1], [2,0], [3,0.2], [4,0]];
 * const simplified = visvalingam(line, 0.5);
 * // 移除面积最小的中间点
 */
export function visvalingam(
    points: number[][],
    tolerance: number,
): number[][] {
    // 边界检查：不足 3 个点时无需简化
    if (points.length <= 2) {
        return points.slice();
    }

    // 容差不能为负
    if (tolerance < 0) {
        tolerance = 0;
    }

    // 为每个点计算有效面积，首尾设为无穷大确保它们不被移除
    const areas = new Float64Array(points.length);
    const removed = new Uint8Array(points.length);

    // 首尾点面积设为正无穷，永远不被移除
    areas[0] = Infinity;
    areas[points.length - 1] = Infinity;

    // 计算每个内部点的初始有效面积
    for (let i = 1; i < points.length - 1; i++) {
        areas[i] = triangleArea(
            points[i - 1][0], points[i - 1][1],
            points[i][0], points[i][1],
            points[i + 1][0], points[i + 1][1],
        );
    }

    // 迭代移除面积最小的点，直到所有剩余点面积 >= tolerance
    while (true) {
        // 找到面积最小的未移除点
        let minArea = Infinity;
        let minIndex = -1;

        for (let i = 1; i < points.length - 1; i++) {
            if (removed[i] === 0 && areas[i] < minArea) {
                minArea = areas[i];
                minIndex = i;
            }
        }

        // 所有剩余点的面积都 >= tolerance，或没有可移除的点
        if (minIndex === -1 || minArea >= tolerance) {
            break;
        }

        // 标记该点为已移除
        removed[minIndex] = 1;

        // 重新计算相邻未移除点的面积
        const prevIdx = findPrevAlive(minIndex, removed);
        const nextIdx = findNextAlive(minIndex, removed, points.length);

        // 更新前一个活跃点的面积（如果不是首点）
        if (prevIdx > 0) {
            const pp = findPrevAlive(prevIdx, removed);
            areas[prevIdx] = triangleArea(
                points[pp][0], points[pp][1],
                points[prevIdx][0], points[prevIdx][1],
                points[nextIdx][0], points[nextIdx][1],
            );
            // Visvalingam 规则：面积不能比已移除点的面积更小
            if (areas[prevIdx] < minArea) {
                areas[prevIdx] = minArea;
            }
        }

        // 更新后一个活跃点的面积（如果不是尾点）
        if (nextIdx < points.length - 1) {
            const nn = findNextAlive(nextIdx, removed, points.length);
            areas[nextIdx] = triangleArea(
                points[prevIdx][0], points[prevIdx][1],
                points[nextIdx][0], points[nextIdx][1],
                points[nn][0], points[nn][1],
            );
            // 同样应用面积下限规则
            if (areas[nextIdx] < minArea) {
                areas[nextIdx] = minArea;
            }
        }
    }

    // 收集未移除的点
    const result: number[][] = [];
    for (let i = 0; i < points.length; i++) {
        if (removed[i] === 0) {
            result.push(points[i]);
        }
    }

    return result;
}

// ======================== 内部辅助函数 ========================

/**
 * Douglas-Peucker 递归步骤。
 * 在 [first, last] 区间内找到离首尾连线最远的点，
 * 如果距离超过容差则标记保留并递归处理两侧。
 *
 * @param points - 输入点序列
 * @param first - 当前处理区间的起始索引
 * @param last - 当前处理区间的结束索引
 * @param sqTolerance - 容差的平方
 * @param keep - 标记数组
 */
function dpStep(
    points: number[][],
    first: number,
    last: number,
    sqTolerance: number,
    keep: Uint8Array,
): void {
    // 区间不足以包含中间点
    if (last - first <= 1) {
        return;
    }

    let maxSqDist = 0;
    let maxIndex = first;

    // 遍历区间内所有中间点，找到距首尾连线最远的点
    for (let i = first + 1; i < last; i++) {
        const sqDist = sqSegmentDistance(
            points[i][0], points[i][1],
            points[first][0], points[first][1],
            points[last][0], points[last][1],
        );
        if (sqDist > maxSqDist) {
            maxSqDist = sqDist;
            maxIndex = i;
        }
    }

    // 如果最远点超过容差，标记保留并递归处理两侧
    if (maxSqDist > sqTolerance) {
        keep[maxIndex] = 1;
        // 递归处理 [first, maxIndex] 和 [maxIndex, last]
        dpStep(points, first, maxIndex, sqTolerance, keep);
        dpStep(points, maxIndex, last, sqTolerance, keep);
    }
}

/**
 * 计算点 (px, py) 到线段 (x1,y1)-(x2,y2) 的距离的平方。
 * 使用向量投影公式，处理投影点在线段延长线上的情况。
 *
 * @param px - 点 x 坐标
 * @param py - 点 y 坐标
 * @param x1 - 线段起点 x
 * @param y1 - 线段起点 y
 * @param x2 - 线段终点 x
 * @param y2 - 线段终点 y
 * @returns 距离的平方
 */
function sqSegmentDistance(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
): number {
    // 线段方向向量
    let dx = x2 - x1;
    let dy = y2 - y1;

    if (dx !== 0 || dy !== 0) {
        // 计算投影参数 t：点在线段方向上的投影位置
        // t = dot(P-A, B-A) / dot(B-A, B-A)
        const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);

        if (t > 1) {
            // 投影点在线段终点之后，用终点计算距离
            x1 = x2;
            y1 = y2;
        } else if (t > 0) {
            // 投影点在线段上，用投影点计算距离
            x1 += dx * t;
            y1 += dy * t;
        }
        // t <= 0 时用起点计算距离（x1, y1 不变）
    }

    // 返回点到最近点的距离平方
    dx = px - x1;
    dy = py - y1;
    return dx * dx + dy * dy;
}

/**
 * 计算三个点构成的三角形面积（无符号）。
 * 使用叉积公式：area = |cross(B-A, C-A)| / 2
 *
 * @param ax - 顶点 A 的 x
 * @param ay - 顶点 A 的 y
 * @param bx - 顶点 B 的 x
 * @param by - 顶点 B 的 y
 * @param cx - 顶点 C 的 x
 * @param cy - 顶点 C 的 y
 * @returns 三角形面积（始终 ≥ 0）
 */
function triangleArea(
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
): number {
    // 叉积的绝对值除以 2
    return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

/**
 * 在已移除标记数组中向前查找最近的活跃点索引。
 *
 * @param index - 当前索引
 * @param removed - 已移除标记数组
 * @returns 前一个活跃点的索引
 */
function findPrevAlive(index: number, removed: Uint8Array): number {
    let i = index - 1;
    // 跳过已移除的点
    while (i > 0 && removed[i] === 1) {
        i--;
    }
    return i;
}

/**
 * 在已移除标记数组中向后查找最近的活跃点索引。
 *
 * @param index - 当前索引
 * @param removed - 已移除标记数组
 * @param length - 数组总长度
 * @returns 后一个活跃点的索引
 */
function findNextAlive(index: number, removed: Uint8Array, length: number): number {
    let i = index + 1;
    // 跳过已移除的点
    while (i < length - 1 && removed[i] === 1) {
        i++;
    }
    return i;
}

/**
 * Chaikin 角点切割平滑算法。
 *
 * 每次迭代将每条边 P_i → P_{i+1} 替换为：
 *   Q = 0.75·P_i + 0.25·P_{i+1}
 *   R = 0.25·P_i + 0.75·P_{i+1}
 * 极限曲线收敛到二次 B-Spline，每次迭代点数约 ×2，视觉上把折线"圆化"。
 *
 * - 开放模式（closed=false）：保留首尾端点不动，仅切割中间边。
 * - 闭合模式（closed=true）：所有顶点都参与切割（包括首尾连接段）。
 *
 * @param points 输入点 [[x,y], ...]
 * @param iterations 迭代次数（默认 1，3-4 次基本足够圆滑）
 * @param closed 是否视为闭合环（默认 false）
 * @returns 平滑后的点序列
 *
 * @example
 * chaikin([[0,0],[10,0],[10,10],[0,10]], 3, true);
 * // → 圆角化后的方形点列
 */
export function chaikin(
    points: number[][],
    iterations: number = 1,
    closed: boolean = false,
): number[][] {
    if (points.length < 2) {
        return points.map((p) => [p[0], p[1]]);
    }
    if (iterations < 1) {
        return points.map((p) => [p[0], p[1]]);
    }

    let current: number[][] = points;

    for (let iter = 0; iter < iterations; iter++) {
        const n = current.length;
        if (n < 2) break;

        const out: number[][] = [];

        if (!closed) {
            out.push([current[0][0], current[0][1]]);
        }

        const edgeCount = closed ? n : n - 1;
        for (let i = 0; i < edgeCount; i++) {
            const ax = current[i][0];
            const ay = current[i][1];
            const next = closed ? (i + 1) % n : (i + 1);
            const bx = current[next][0];
            const by = current[next][1];

            out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by]);
            out.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
        }

        if (!closed) {
            out.push([current[n - 1][0], current[n - 1][1]]);
        }

        current = out;
    }

    return current;
}

// ============================================================
// 3D Douglas-Peucker（含 Z 轴的折线简化）
// ============================================================

/**
 * 3D 版 Douglas-Peucker：在 2D 版基础上把"点到线段距离"改为 3D 点到 3D 线段距离。
 *
 * 用途：
 * - 航迹（GPS 轨迹带高度）简化
 * - LIDAR 点云折线化
 * - 3D 河网/道路网络简化
 *
 * @param points 3D 点序列 [[x,y,z], ...]
 * @param tolerance 3D 距离阈值（欧氏）
 * @returns 简化后的点序列
 */
export function douglasPeucker3D(
    points: number[][],
    tolerance: number,
): number[][] {
    if (points.length <= 2) return points.map((p) => [p[0], p[1], p[2]]);
    if (tolerance < 0) tolerance = 0;

    const sqTol = tolerance * tolerance;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    dpStep3D(points, 0, points.length - 1, sqTol, keep);

    const result: number[][] = [];
    for (let i = 0; i < points.length; i++) {
        if (keep[i] === 1) result.push([points[i][0], points[i][1], points[i][2]]);
    }
    return result;
}

/** 3D DP 递归主体。 */
function dpStep3D(
    points: number[][],
    first: number,
    last: number,
    sqTol: number,
    keep: Uint8Array,
): void {
    if (last - first <= 1) return;

    let maxSqDist = 0;
    let maxIdx = 0;
    for (let i = first + 1; i < last; i++) {
        const d = sqSegmentDistance3D(
            points[i][0], points[i][1], points[i][2],
            points[first][0], points[first][1], points[first][2],
            points[last][0], points[last][1], points[last][2],
        );
        if (d > maxSqDist) {
            maxSqDist = d;
            maxIdx = i;
        }
    }
    if (maxSqDist > sqTol) {
        keep[maxIdx] = 1;
        dpStep3D(points, first, maxIdx, sqTol, keep);
        dpStep3D(points, maxIdx, last, sqTol, keep);
    }
}

/** 点 (px,py,pz) 到 3D 线段 (x1,y1,z1)-(x2,y2,z2) 的平方距离。 */
function sqSegmentDistance3D(
    px: number, py: number, pz: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 1e-20) {
        const ex = px - x1;
        const ey = py - y1;
        const ez = pz - z1;
        return ex * ex + ey * ey + ez * ez;
    }
    let t = ((px - x1) * dx + (py - y1) * dy + (pz - z1) * dz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    const cz = z1 + t * dz;
    const ex = px - cx;
    const ey = py - cy;
    const ez = pz - cz;
    return ex * ex + ey * ey + ez * ez;
}

// ============================================================
// B-Spline 曲线求值（均匀节点 / 开放型）
// ============================================================

/**
 * 均匀开放型 B-Spline 曲线求值。
 *
 * 给定 n+1 个控制点和次数 k（典型 3 = cubic），计算曲线上若干采样点。
 * 使用 Cox-de Boor 递归公式：
 *   N_{i,0}(t) = 1 if u_i ≤ t < u_{i+1} else 0
 *   N_{i,p}(t) = (t - u_i)/(u_{i+p} - u_i) · N_{i,p-1}(t)
 *              + (u_{i+p+1} - t)/(u_{i+p+1} - u_{i+1}) · N_{i+1,p-1}(t)
 *
 * 开放（clamped）均匀节点向量：前 k+1 个节点 = 0，后 k+1 个节点 = 1，
 * 中间均匀分布 → 曲线在端点处严格穿过第一个和最后一个控制点。
 *
 * 不是"插值"——控制点通常不在曲线上（除端点外）。要对给定点拟合曲线
 * 请用 `curve-fit.ts` 的 `bezierFit`。
 *
 * @param controlPoints 控制点 [[x,y], ...]
 * @param degree 次数（≥1，典型 3）
 * @param samples 采样点数（≥2）
 * @returns 曲线上的采样点数组
 *
 * @example
 * bspline([[0,0],[1,3],[2,-2],[3,3],[4,0]], 3, 50);
 */
export function bspline(
    controlPoints: number[][],
    degree: number = 3,
    samples: number = 50,
): number[][] {
    const n = controlPoints.length - 1; // n+1 个控制点
    if (n < 1) return controlPoints.map((p) => [p[0], p[1]]);
    let p = degree;
    if (p < 1) p = 1;
    if (p > n) p = n; // 次数不能高于 n
    if (samples < 2) samples = 2;

    // 构建开放均匀节点向量：长度 = n + p + 2
    const knotCount = n + p + 2;
    const knots: number[] = new Array(knotCount);
    for (let i = 0; i < knotCount; i++) {
        if (i <= p) knots[i] = 0;
        else if (i >= knotCount - p - 1) knots[i] = 1;
        else knots[i] = (i - p) / (n - p + 1);
    }

    /** Cox-de Boor 基函数 N_{i,deg}(t)。 */
    function N(i: number, deg: number, t: number): number {
        if (deg === 0) {
            // 最后一个节点区间特例：t == 1 时闭合区间
            if (i === n && t >= 1 - 1e-12) return 1;
            return t >= knots[i] && t < knots[i + 1] ? 1 : 0;
        }
        const denom1 = knots[i + deg] - knots[i];
        const denom2 = knots[i + deg + 1] - knots[i + 1];
        let a = 0, b = 0;
        if (denom1 > 1e-20) a = ((t - knots[i]) / denom1) * N(i, deg - 1, t);
        if (denom2 > 1e-20) b = ((knots[i + deg + 1] - t) / denom2) * N(i + 1, deg - 1, t);
        return a + b;
    }

    const out: number[][] = new Array(samples);
    for (let s = 0; s < samples; s++) {
        const t = s / (samples - 1);
        let x = 0;
        let y = 0;
        for (let i = 0; i <= n; i++) {
            const w = N(i, p, t);
            x += w * controlPoints[i][0];
            y += w * controlPoints[i][1];
        }
        out[s] = [x, y];
    }
    return out;
}
