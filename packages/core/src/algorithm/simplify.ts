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
