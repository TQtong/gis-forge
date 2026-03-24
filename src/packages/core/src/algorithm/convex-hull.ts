// ============================================================
// algorithm/convex-hull.ts — 凸包算法（Andrew's Monotone Chain）
// 时间复杂度 O(n log n)（排序主导），空间 O(n)。
// 零 npm 依赖，全部自研实现。
// ============================================================

/**
 * 使用 Andrew's Monotone Chain 算法计算 2D 点集的凸包。
 *
 * 算法概述：
 *   1. 按 x 坐标排序（x 相同按 y），O(n log n)
 *   2. 从左到右构建下凸包（lower hull）
 *   3. 从右到左构建上凸包（upper hull）
 *   4. 拼接两者得到完整凸包（逆时针方向）
 *
 * 使用叉积判断左转/右转来决定是否保留顶点。
 *
 * @param points - 输入点集 [[x, y], ...]，至少 1 个点
 * @returns 凸包顶点（逆时针排列）。1 个点返回该点，2 个点返回两点，
 *          共线点集返回最远两端点。不修改原数组。
 *
 * @example
 * convexHull([[0,0], [1,0], [0.5,0.5], [1,1], [0,1]]);
 * // → [[0,0], [1,0], [1,1], [0,1]]（正方形的 4 个角，逆时针）
 *
 * @example
 * convexHull([[0,0], [1,1], [2,2]]);
 * // → [[0,0], [2,2]]（共线退化为线段两端点）
 */
export function convexHull(points: number[][]): number[][] {
    const n = points.length;

    // 0 个点返回空
    if (n === 0) {
        return [];
    }

    // 1 个点返回自身的副本
    if (n === 1) {
        return [points[0].slice()];
    }

    // 复制并排序：先按 x 升序，x 相同按 y 升序
    const sorted = points.slice().sort(comparePoints);

    // 2 个点直接返回
    if (n === 2) {
        return [sorted[0].slice(), sorted[1].slice()];
    }

    // --- 构建下凸包（lower hull）---
    // 从左到右扫描，保持右转（叉积 ≤ 0 时弹出）
    const lower: number[][] = [];
    for (let i = 0; i < sorted.length; i++) {
        // 当栈中至少有 2 个点且最后三个点不是右转时，弹出栈顶
        while (lower.length >= 2 && cross2D(
            lower[lower.length - 2],
            lower[lower.length - 1],
            sorted[i],
        ) <= 0) {
            lower.pop();
        }
        lower.push(sorted[i]);
    }

    // --- 构建上凸包（upper hull）---
    // 从右到左扫描
    const upper: number[][] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross2D(
            upper[upper.length - 2],
            upper[upper.length - 1],
            sorted[i],
        ) <= 0) {
            upper.pop();
        }
        upper.push(sorted[i]);
    }

    // --- 拼接：去掉各自的最后一个点（因为它是另一半的第一个点） ---
    lower.pop();
    upper.pop();

    // 合并为完整凸包
    const hull = lower.concat(upper);

    // 返回副本，避免引用修改
    return hull.map(p => p.slice());
}

// ======================== 内部辅助函数 ========================

/**
 * 比较函数：先按 x 升序，x 相同按 y 升序。
 *
 * @param a - 点 A
 * @param b - 点 B
 * @returns 排序值
 */
function comparePoints(a: number[], b: number[]): number {
    // x 不同按 x 排序，x 相同按 y 排序
    return a[0] - b[0] || a[1] - b[1];
}

/**
 * 计算向量 OA→OB 和 OA→OC 的叉积（2D 伪叉积）。
 * 正值 → C 在 AB 左侧（左转），零 → 共线，负值 → 右转。
 *
 * 公式：(B-O) × (C-O) = (bx-ox)(cy-oy) - (by-oy)(cx-ox)
 *
 * @param o - 原点
 * @param a - 中间点
 * @param b - 测试点
 * @returns 叉积值
 */
function cross2D(o: number[], a: number[], b: number[]): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

declare const __DEV__: boolean;
