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

/**
 * Quickhull 2D 凸包算法。
 *
 * 与 Andrew 单调链不同，Quickhull 类似快速排序的"分治"思路：
 * 1. 找出最左和最右两个极点 L、R，连线 LR 把点集分成上下两半。
 * 2. 对每一半，找到距离 LR 最远的点 P。三角形 LPR 内部的点不可能在凸包上，丢弃。
 * 3. 递归处理 LP 和 PR 的"外侧"点集。
 *
 * 平均复杂度 O(n log n)，最坏 O(n²)（共线情况），常数因子很小。
 * 对均匀分布的点集，因为每次裁掉三角形内部的所有点，实测往往比 Andrew 更快。
 *
 * @param points 输入点集 [[x,y], ...]
 * @returns 凸包顶点（逆时针顺序，首尾不闭合）
 *
 * @example
 * quickHull([[0,0],[4,0],[2,2],[0,4],[4,4],[2,1]]);
 * // → [[0,0],[4,0],[4,4],[0,4]]
 */
export function quickHull(points: number[][]): number[][] {
    const n = points.length;
    if (n === 0) return [];
    if (n === 1) return [[points[0][0], points[0][1]]];
    if (n === 2) {
        return [
            [points[0][0], points[0][1]],
            [points[1][0], points[1][1]],
        ];
    }

    // 找最左点（取最小 x；x 相等取最小 y）和最右点
    let leftIdx = 0;
    let rightIdx = 0;
    for (let i = 1; i < n; i++) {
        if (
            points[i][0] < points[leftIdx][0] ||
            (points[i][0] === points[leftIdx][0] && points[i][1] < points[leftIdx][1])
        ) {
            leftIdx = i;
        }
        if (
            points[i][0] > points[rightIdx][0] ||
            (points[i][0] === points[rightIdx][0] && points[i][1] > points[rightIdx][1])
        ) {
            rightIdx = i;
        }
    }

    const L = points[leftIdx];
    const R = points[rightIdx];

    // 划分到 L→R 的左侧（cross > 0）和右侧（cross < 0）
    const upper: number[][] = [];
    const lower: number[][] = [];
    for (let i = 0; i < n; i++) {
        if (i === leftIdx || i === rightIdx) continue;
        const c = cross2D(L, R, points[i]);
        if (c > 0) upper.push(points[i]);
        else if (c < 0) lower.push(points[i]);
        // c === 0：共线点丢弃
    }

    // 凸包按逆时针：L → 下半（R 一侧的远点们）→ R → 上半 → L
    const hull: number[][] = [];
    hull.push([L[0], L[1]]);
    qhRecurse(L, R, lower, hull);
    hull.push([R[0], R[1]]);
    qhRecurse(R, L, upper, hull);
    return hull;
}

/**
 * Quickhull 递归：从点集中找到距离边 ab 最远的点 farthest，
 * 把 farthest 加入 hull，然后递归处理 (a, farthest) 和 (farthest, b) 的外侧。
 */
function qhRecurse(
    a: number[],
    b: number[],
    pts: number[][],
    hull: number[][],
): void {
    if (pts.length === 0) return;

    // 找距离 ab 最远的点（用未归一化的"伪距离"——叉积绝对值，单调一致）
    let farthest = pts[0];
    let maxDist = Math.abs(cross2D(a, b, farthest));
    for (let i = 1; i < pts.length; i++) {
        const d = Math.abs(cross2D(a, b, pts[i]));
        if (d > maxDist) {
            maxDist = d;
            farthest = pts[i];
        }
    }

    // 划分外侧点集：在 a→farthest 外侧 / 在 farthest→b 外侧
    // "外侧" = 与原方向 a→b 同号的那一侧
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p === farthest) continue;
        if (cross2D(a, farthest, p) > 0) {
            left.push(p);
        } else if (cross2D(farthest, b, p) > 0) {
            right.push(p);
        }
        // 三角形 (a, farthest, b) 内部的点直接丢弃
    }

    qhRecurse(a, farthest, left, hull);
    hull.push([farthest[0], farthest[1]]);
    qhRecurse(farthest, b, right, hull);
}

/**
 * Concave Hull（凹包）算法 — k-Nearest-Neighbors 法（Moreira-Santos 2007 的简化版）。
 *
 * 与凸包的区别：凹包允许"凹"的边界，更贴合点云真实轮廓。
 * 用途：要素边界轮廓提取、空间集群边界、地理热点圈地。
 *
 * 算法步骤：
 * 1. 找最低点作为起始点。
 * 2. 反复选择"上一条边方向逆时针旋转后角度最小、且不导致自相交"的最近邻点。
 * 3. 当回到起点时停止。
 *
 * 参数 `k` 控制凹陷敏感度：
 * - k 越小越凹（轮廓更贴合，但可能产生过度噪声或自相交）
 * - k 越大越接近凸包
 * - 推荐 k ∈ [3, 10]。本实现会自适应增大 k 直到生成合法（无自相交）的环。
 *
 * 注：本实现为 O(n²) 朴素版本，适合 ≤ 5000 点的中小规模。
 *
 * @param points 输入点集 [[x,y], ...]
 * @param k 初始邻居数，默认 3
 * @returns 凹包顶点（顺序成环，首尾不闭合）。失败时退回到凸包。
 */
export function concaveHull(points: number[][], k: number = 3): number[][] {
    const n = points.length;
    if (n < 3) {
        return points.map((p) => [p[0], p[1]]);
    }
    // 去重（同位点会破坏算法）
    const dedup = dedupPoints(points);
    if (dedup.length < 3) {
        return dedup.map((p) => [p[0], p[1]]);
    }

    let kk = Math.max(3, k);
    const maxK = Math.min(dedup.length - 1, 64);

    while (kk <= maxK) {
        const hull = tryConcaveHull(dedup, kk);
        if (hull !== null) {
            return hull;
        }
        kk++;
    }

    // 失败兜底：返回凸包
    return convexHull(dedup);
}

function dedupPoints(points: number[][]): number[][] {
    const seen = new Set<string>();
    const out: number[][] = [];
    for (let i = 0; i < points.length; i++) {
        const key = `${points[i][0]},${points[i][1]}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push([points[i][0], points[i][1]]);
        }
    }
    return out;
}

function tryConcaveHull(points: number[][], k: number): number[][] | null {
    const n = points.length;

    // 找最低点（y 最小，y 相同取 x 最小）
    let startIdx = 0;
    for (let i = 1; i < n; i++) {
        if (
            points[i][1] < points[startIdx][1] ||
            (points[i][1] === points[startIdx][1] && points[i][0] < points[startIdx][0])
        ) {
            startIdx = i;
        }
    }

    const used = new Uint8Array(n);
    const hullIdx: number[] = [];
    let current = startIdx;
    hullIdx.push(current);
    used[current] = 1;

    // 上一段的方向角（起步用 -π，相当于水平向左）
    let prevAngle = -Math.PI;
    let step = 0;
    const maxSteps = n * 3;

    while (step < maxSteps) {
        step++;

        // 至少走过 2 步后才允许回到起点
        if (step > 2 && current === startIdx) {
            // 闭合 → 移除末尾重复
            hullIdx.pop();
            return hullIdx.map((i) => [points[i][0], points[i][1]]);
        }

        // 找 k 个最近邻（排除已使用的，但如果走了至少 3 步允许 startIdx 作为候选）
        const knn = findKNN(points, current, k, used, step > 2 ? startIdx : -1);
        if (knn.length === 0) {
            return null;
        }

        // 按"相对 prevAngle 的逆时针右转角"排序——选最小右转的邻居
        knn.sort((a, b) => {
            const angA = relativeRightTurn(prevAngle, points[current], points[a]);
            const angB = relativeRightTurn(prevAngle, points[current], points[b]);
            return angA - angB;
        });

        // 选第一个不会引入自相交的候选
        let chosen = -1;
        for (let i = 0; i < knn.length; i++) {
            const cand = knn[i];
            if (!segmentSelfIntersects(points, hullIdx, current, cand)) {
                chosen = cand;
                break;
            }
        }

        if (chosen === -1) {
            return null;
        }

        // 更新上一段方向角
        const dx = points[chosen][0] - points[current][0];
        const dy = points[chosen][1] - points[current][1];
        prevAngle = Math.atan2(dy, dx);

        current = chosen;
        hullIdx.push(current);
        used[current] = 1;
    }

    return null;
}

function findKNN(
    points: number[][],
    fromIdx: number,
    k: number,
    used: Uint8Array,
    allowExtra: number,
): number[] {
    const n = points.length;
    const candidates: { idx: number; d: number }[] = [];
    const fx = points[fromIdx][0];
    const fy = points[fromIdx][1];
    for (let i = 0; i < n; i++) {
        if (i === fromIdx) continue;
        if (used[i] && i !== allowExtra) continue;
        const dx = points[i][0] - fx;
        const dy = points[i][1] - fy;
        candidates.push({ idx: i, d: dx * dx + dy * dy });
    }
    candidates.sort((a, b) => a.d - b.d);
    const out: number[] = [];
    const limit = Math.min(k, candidates.length);
    for (let i = 0; i < limit; i++) out.push(candidates[i].idx);
    return out;
}

/**
 * 计算从 prevAngle 方向逆时针扫到 current→next 方向所经过的角度。
 * 返回 [0, 2π)，越小表示"右转越大、越贴近边界"。
 */
function relativeRightTurn(
    prevAngle: number,
    current: number[],
    next: number[],
): number {
    const a = Math.atan2(next[1] - current[1], next[0] - current[0]);
    let diff = a - prevAngle - Math.PI;
    while (diff < 0) diff += Math.PI * 2;
    while (diff >= Math.PI * 2) diff -= Math.PI * 2;
    return diff;
}

function segmentSelfIntersects(
    points: number[][],
    hullIdx: number[],
    curIdx: number,
    nextIdx: number,
): boolean {
    const ax = points[curIdx][0];
    const ay = points[curIdx][1];
    const bx = points[nextIdx][0];
    const by = points[nextIdx][1];

    // 跳过最后一段（相邻边共享端点不算相交）
    const last = hullIdx.length - 1;
    for (let i = 0; i < last - 1; i++) {
        const px = points[hullIdx[i]][0];
        const py = points[hullIdx[i]][1];
        const qx = points[hullIdx[i + 1]][0];
        const qy = points[hullIdx[i + 1]][1];
        if (segIntersectsProper(ax, ay, bx, by, px, py, qx, qy)) {
            return true;
        }
    }
    return false;
}

function segIntersectsProper(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
): boolean {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return (
        ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    );
}

/**
 * 旋转卡壳法计算最小面积外接矩形（OBB）。
 *
 * 经典算法：
 * 1. 先求点集的凸包（OBB 的最小覆盖矩形必有一边与凸包某边平行——
 *    这是 Freeman & Shapira 1975 的结论）。
 * 2. 对凸包每条边，把整个凸包旋转使该边水平，求轴对齐包围盒，计算面积。
 * 3. 返回面积最小的那个矩形。
 *
 * 输出 4 个顶点（逆时针）+ 中心 + 两条轴向量 + 半边长，便于直接构造 OBB
 * 数据结构（与 `intersect.ts` 的 `rayOBB` 接口直接对接）。
 *
 * @param points 输入点集 [[x,y], ...]
 * @returns 最小外接矩形，输入退化时返回 null
 *
 * @example
 * minBoundingBox([[0,0],[4,0],[4,1],[0,1]]); // → 4×1 的矩形
 */
export interface MinBoundingBox {
    /** 4 个顶点（逆时针） */
    readonly corners: [number, number][];
    /** 中心点 */
    readonly center: [number, number];
    /** 矩形两条主轴：[axisX, axisY]（单位向量） */
    readonly axes: [[number, number], [number, number]];
    /** 半边长（沿两轴方向） */
    readonly halfExtents: [number, number];
    /** 矩形面积 */
    readonly area: number;
    /** X 主轴的角度（弧度） */
    readonly angle: number;
}

export function minBoundingBox(points: number[][]): MinBoundingBox | null {
    if (points.length === 0) return null;

    const hull = convexHull(points);
    if (hull.length === 0) return null;

    if (hull.length === 1) {
        return {
            corners: [
                [hull[0][0], hull[0][1]],
                [hull[0][0], hull[0][1]],
                [hull[0][0], hull[0][1]],
                [hull[0][0], hull[0][1]],
            ],
            center: [hull[0][0], hull[0][1]],
            axes: [[1, 0], [0, 1]],
            halfExtents: [0, 0],
            area: 0,
            angle: 0,
        };
    }

    const n = hull.length;
    let bestArea = Infinity;
    let bestAxisX = 1;
    let bestAxisY = 0;
    let bestMinU = 0;
    let bestMaxU = 0;
    let bestMinV = 0;
    let bestMaxV = 0;

    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ex = hull[j][0] - hull[i][0];
        const ey = hull[j][1] - hull[i][1];
        const len = Math.sqrt(ex * ex + ey * ey);
        if (len < 1e-12) continue;

        // 该边的单位方向向量（U 轴）和左法向量（V 轴）
        const ux = ex / len;
        const uy = ey / len;
        const vx = -uy;
        const vy = ux;

        // 把所有凸包点投影到 (U, V) 局部坐标
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;
        for (let k = 0; k < n; k++) {
            const u = hull[k][0] * ux + hull[k][1] * uy;
            const v = hull[k][0] * vx + hull[k][1] * vy;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }

        const w = maxU - minU;
        const h = maxV - minV;
        const area = w * h;
        if (area < bestArea) {
            bestArea = area;
            bestAxisX = ux;
            bestAxisY = uy;
            bestMinU = minU;
            bestMaxU = maxU;
            bestMinV = minV;
            bestMaxV = maxV;
        }
    }

    // 反算 4 个顶点（用 best 轴）
    const ux = bestAxisX;
    const uy = bestAxisY;
    const vx = -uy;
    const vy = ux;

    const corners: [number, number][] = [
        [bestMinU * ux + bestMinV * vx, bestMinU * uy + bestMinV * vy],
        [bestMaxU * ux + bestMinV * vx, bestMaxU * uy + bestMinV * vy],
        [bestMaxU * ux + bestMaxV * vx, bestMaxU * uy + bestMaxV * vy],
        [bestMinU * ux + bestMaxV * vx, bestMinU * uy + bestMaxV * vy],
    ];

    const cu = (bestMinU + bestMaxU) * 0.5;
    const cv = (bestMinV + bestMaxV) * 0.5;
    const center: [number, number] = [
        cu * ux + cv * vx,
        cu * uy + cv * vy,
    ];

    return {
        corners,
        center,
        axes: [[ux, uy], [vx, vy]],
        halfExtents: [(bestMaxU - bestMinU) * 0.5, (bestMaxV - bestMinV) * 0.5],
        area: bestArea,
        angle: Math.atan2(uy, ux),
    };
}

declare const __DEV__: boolean;
