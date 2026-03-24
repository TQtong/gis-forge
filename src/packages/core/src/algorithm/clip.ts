// ============================================================
// algorithm/clip.ts — 裁剪算法
// Sutherland-Hodgman 多边形矩形裁剪、Cohen-Sutherland 线段裁剪、
// Liang-Barsky 线段裁剪。
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 常量 ========================

/** Cohen-Sutherland 区域码：中心（可见区域） */
const INSIDE: number = 0;

/** Cohen-Sutherland 区域码：左侧 */
const LEFT: number = 1;

/** Cohen-Sutherland 区域码：右侧 */
const RIGHT: number = 2;

/** Cohen-Sutherland 区域码：下方 */
const BOTTOM: number = 4;

/** Cohen-Sutherland 区域码：上方 */
const TOP: number = 8;

// ======================== Sutherland-Hodgman ========================

/**
 * Sutherland-Hodgman 多边形裁剪算法。
 * 将任意凸/凹多边形裁剪到矩形区域内。
 *
 * 算法概述：
 *   依次用矩形的 4 条边裁剪多边形，每条边裁剪产生新的多边形。
 *   对每条边：遍历多边形的每条边，根据端点位置（内/外）决定输出：
 *   - 内→内：输出终点
 *   - 内→外：输出交点
 *   - 外→内：输出交点 + 终点
 *   - 外→外：不输出
 *
 * @param polygon - 输入多边形顶点 [[x,y], ...]（不要求首尾闭合）
 * @param clipRect - 裁剪矩形 [xmin, ymin, xmax, ymax]
 * @returns 裁剪后的多边形顶点。若多边形完全在外则返回空数组
 *
 * @example
 * const clipped = sutherlandHodgman(
 *   [[0,0], [10,0], [10,10], [0,10]],
 *   [2, 2, 8, 8],
 * );
 * // → [[2,2], [8,2], [8,8], [2,8]]（矩形裁剪为内部方块）
 */
export function sutherlandHodgman(
    polygon: number[][],
    clipRect: [number, number, number, number],
): number[][] {
    // 空多边形或不足 3 个顶点返回空
    if (polygon.length < 3) {
        return [];
    }

    const [xmin, ymin, xmax, ymax] = clipRect;

    // 用矩形的 4 条边依次裁剪
    // 每条边定义为一个 "inside test" 函数和一个 "intersection" 函数
    let output: number[][] = polygon.slice();

    // 裁剪边 1：左边 (x = xmin)
    output = clipByEdge(output, (p) => p[0] >= xmin, intersectLeft, xmin);
    if (output.length === 0) return [];

    // 裁剪边 2：右边 (x = xmax)
    output = clipByEdge(output, (p) => p[0] <= xmax, intersectRight, xmax);
    if (output.length === 0) return [];

    // 裁剪边 3：下边 (y = ymin)
    output = clipByEdge(output, (p) => p[1] >= ymin, intersectBottom, ymin);
    if (output.length === 0) return [];

    // 裁剪边 4：上边 (y = ymax)
    output = clipByEdge(output, (p) => p[1] <= ymax, intersectTop, ymax);

    return output;
}

// ======================== Cohen-Sutherland ========================

/**
 * Cohen-Sutherland 线段裁剪算法。
 * 将线段裁剪到矩形区域内，如果完全在外则返回 null。
 *
 * 算法概述：
 *   1. 为线段两端点计算 4 位区域码
 *   2. 若两端点区域码都为 0（都在内部），接受
 *   3. 若两端点区域码的按位与非零，拒绝（完全在某一侧外部）
 *   4. 否则计算与矩形边的交点，替换外部端点，重复
 *
 * @param x0 - 线段起点 x
 * @param y0 - 线段起点 y
 * @param x1 - 线段终点 x
 * @param y1 - 线段终点 y
 * @param xmin - 裁剪矩形最小 x
 * @param ymin - 裁剪矩形最小 y
 * @param xmax - 裁剪矩形最大 x
 * @param ymax - 裁剪矩形最大 y
 * @returns 裁剪后的线段 [x0, y0, x1, y1]，若线段完全在外则返回 null
 *
 * @example
 * cohenSutherland(-5, 5, 15, 5, 0, 0, 10, 10);
 * // → [0, 5, 10, 5]（裁剪到矩形内）
 */
export function cohenSutherland(
    x0: number, y0: number,
    x1: number, y1: number,
    xmin: number, ymin: number,
    xmax: number, ymax: number,
): [number, number, number, number] | null {
    // 计算两端点的区域码
    let code0 = computeOutCode(x0, y0, xmin, ymin, xmax, ymax);
    let code1 = computeOutCode(x1, y1, xmin, ymin, xmax, ymax);

    // 最多迭代 20 次（理论上 4 次足够，但加余量防止浮点极端情况）
    for (let iter = 0; iter < 20; iter++) {
        if ((code0 | code1) === 0) {
            // 两端点都在内部——完全接受
            return [x0, y0, x1, y1];
        }

        if ((code0 & code1) !== 0) {
            // 两端点在矩形同一侧外部——完全拒绝
            return null;
        }

        // 选择在外部的端点进行裁剪
        const codeOut = code0 !== 0 ? code0 : code1;
        let x = 0, y = 0;

        // 计算交点
        if (codeOut & TOP) {
            // 与上边 (y = ymax) 的交点
            x = x0 + (x1 - x0) * (ymax - y0) / (y1 - y0);
            y = ymax;
        } else if (codeOut & BOTTOM) {
            // 与下边 (y = ymin) 的交点
            x = x0 + (x1 - x0) * (ymin - y0) / (y1 - y0);
            y = ymin;
        } else if (codeOut & RIGHT) {
            // 与右边 (x = xmax) 的交点
            y = y0 + (y1 - y0) * (xmax - x0) / (x1 - x0);
            x = xmax;
        } else if (codeOut & LEFT) {
            // 与左边 (x = xmin) 的交点
            y = y0 + (y1 - y0) * (xmin - x0) / (x1 - x0);
            x = xmin;
        }

        // 替换外部端点并重新计算区域码
        if (codeOut === code0) {
            x0 = x;
            y0 = y;
            code0 = computeOutCode(x0, y0, xmin, ymin, xmax, ymax);
        } else {
            x1 = x;
            y1 = y;
            code1 = computeOutCode(x1, y1, xmin, ymin, xmax, ymax);
        }
    }

    // 迭代耗尽仍未收敛（极罕见），返回 null
    return null;
}

// ======================== Liang-Barsky ========================

/**
 * Liang-Barsky 线段裁剪算法。
 * 比 Cohen-Sutherland 更高效（不需要迭代），使用参数化线段表示。
 *
 * 算法概述：
 *   将线段参数化为 P(t) = P0 + t*(P1-P0)，t ∈ [0,1]。
 *   对矩形的每条边计算 p 和 q 参数，更新有效 t 范围 [tEnter, tLeave]。
 *   若 tEnter > tLeave 则线段完全在外。
 *
 * @param x0 - 线段起点 x
 * @param y0 - 线段起点 y
 * @param x1 - 线段终点 x
 * @param y1 - 线段终点 y
 * @param xmin - 裁剪矩形最小 x
 * @param ymin - 裁剪矩形最小 y
 * @param xmax - 裁剪矩形最大 x
 * @param ymax - 裁剪矩形最大 y
 * @returns 裁剪后的线段 [x0, y0, x1, y1]，若完全在外则返回 null
 *
 * @example
 * liangBarsky(-5, 5, 15, 5, 0, 0, 10, 10);
 * // → [0, 5, 10, 5]
 */
export function liangBarsky(
    x0: number, y0: number,
    x1: number, y1: number,
    xmin: number, ymin: number,
    xmax: number, ymax: number,
): [number, number, number, number] | null {
    // 线段方向向量
    const dx = x1 - x0;
    const dy = y1 - y0;

    // 参数范围 [tEnter, tLeave]，初始为 [0, 1]（整条线段）
    let tEnter = 0;
    let tLeave = 1;

    // 对 4 条裁剪边分别测试
    // p[i] = -dx, dx, -dy, dy
    // q[i] = x0-xmin, xmax-x0, y0-ymin, ymax-y0
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];

    for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-12) {
            // 线段平行于此裁剪边
            if (q[i] < 0) {
                // 线段在此边外部——完全拒绝
                return null;
            }
            // 否则不影响 t 范围，跳过
            continue;
        }

        // t = q / p：线段与此裁剪边的交点参数
        const t = q[i] / p[i];

        if (p[i] < 0) {
            // 从外部进入——更新 tEnter
            if (t > tEnter) {
                tEnter = t;
            }
        } else {
            // 从内部离开——更新 tLeave
            if (t < tLeave) {
                tLeave = t;
            }
        }

        // 如果进入晚于离开，线段完全在外
        if (tEnter > tLeave) {
            return null;
        }
    }

    // 用最终的 t 范围计算裁剪后的端点
    return [
        x0 + tEnter * dx,
        y0 + tEnter * dy,
        x0 + tLeave * dx,
        y0 + tLeave * dy,
    ];
}

// ======================== 内部辅助函数 ========================

/**
 * 计算点相对于裁剪矩形的 Cohen-Sutherland 区域码。
 * 4 位编码：bit0=左, bit1=右, bit2=下, bit3=上。
 *
 * @param x - 点 x
 * @param y - 点 y
 * @param xmin - 矩形最小 x
 * @param ymin - 矩形最小 y
 * @param xmax - 矩形最大 x
 * @param ymax - 矩形最大 y
 * @returns 4 位区域码
 */
function computeOutCode(
    x: number, y: number,
    xmin: number, ymin: number,
    xmax: number, ymax: number,
): number {
    let code = INSIDE;
    if (x < xmin) code |= LEFT;
    else if (x > xmax) code |= RIGHT;
    if (y < ymin) code |= BOTTOM;
    else if (y > ymax) code |= TOP;
    return code;
}

/**
 * 用单条裁剪边裁剪多边形（Sutherland-Hodgman 的单边处理步骤）。
 *
 * @param polygon - 输入多边形顶点
 * @param isInside - 测试点是否在裁剪边内侧的函数
 * @param intersect - 计算线段与裁剪边交点的函数
 * @param edgeValue - 裁剪边的坐标值
 * @returns 裁剪后的多边形顶点
 */
function clipByEdge(
    polygon: number[][],
    isInside: (p: number[]) => boolean,
    intersect: (a: number[], b: number[], v: number) => number[],
    edgeValue: number,
): number[][] {
    const output: number[][] = [];
    const len = polygon.length;

    // 空多边形快速返回
    if (len === 0) {
        return output;
    }

    // 遍历多边形的每条边
    for (let i = 0; i < len; i++) {
        const current = polygon[i];
        const next = polygon[(i + 1) % len];
        const curInside = isInside(current);
        const nextInside = isInside(next);

        if (curInside && nextInside) {
            // 内→内：输出终点
            output.push(next);
        } else if (curInside && !nextInside) {
            // 内→外：输出交点
            output.push(intersect(current, next, edgeValue));
        } else if (!curInside && nextInside) {
            // 外→内：输出交点 + 终点
            output.push(intersect(current, next, edgeValue));
            output.push(next);
        }
        // 外→外：不输出
    }

    return output;
}

/**
 * 计算线段与左裁剪边 (x = xmin) 的交点。
 *
 * @param a - 线段起点
 * @param b - 线段终点
 * @param xmin - 左边界 x 值
 * @returns 交点坐标
 */
function intersectLeft(a: number[], b: number[], xmin: number): number[] {
    // 参数化：t = (xmin - ax) / (bx - ax)
    const t = (xmin - a[0]) / (b[0] - a[0]);
    return [xmin, a[1] + t * (b[1] - a[1])];
}

/**
 * 计算线段与右裁剪边 (x = xmax) 的交点。
 *
 * @param a - 线段起点
 * @param b - 线段终点
 * @param xmax - 右边界 x 值
 * @returns 交点坐标
 */
function intersectRight(a: number[], b: number[], xmax: number): number[] {
    const t = (xmax - a[0]) / (b[0] - a[0]);
    return [xmax, a[1] + t * (b[1] - a[1])];
}

/**
 * 计算线段与下裁剪边 (y = ymin) 的交点。
 *
 * @param a - 线段起点
 * @param b - 线段终点
 * @param ymin - 下边界 y 值
 * @returns 交点坐标
 */
function intersectBottom(a: number[], b: number[], ymin: number): number[] {
    const t = (ymin - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), ymin];
}

/**
 * 计算线段与上裁剪边 (y = ymax) 的交点。
 *
 * @param a - 线段起点
 * @param b - 线段终点
 * @param ymax - 上边界 y 值
 * @returns 交点坐标
 */
function intersectTop(a: number[], b: number[], ymax: number): number[] {
    const t = (ymax - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), ymax];
}

declare const __DEV__: boolean;
