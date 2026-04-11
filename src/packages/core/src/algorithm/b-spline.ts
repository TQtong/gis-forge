// ============================================================
// algorithm/b-spline.ts — B-Spline 曲线求值与插值
//
// 提供两种主入口：
//
//   1. evaluateBSpline(controlPoints, knots, degree, t)
//      给定控制点 + 节点向量 + 阶数，计算参数 t 处的曲线点。
//      使用 De Boor 递推算法，数值稳定，复杂度 O(degree²)。
//
//   2. interpolateBSpline(points, degree, samples)
//      "通过给定路点的 B 样条插值"——生成穿过每个 path 点的 clamped
//      uniform B-spline，并按 samples 个等参数样本输出曲线点。
//      实现要点：
//        a. 使用 chord-length 参数化得到每个路点对应的 t_i；
//        b. 构造 clamped knot 向量（前后各 degree+1 个重复端点）；
//        c. 解三对角线性方程组求控制点（仅 cubic 时严格三对角；这里
//           对一般 degree 用稠密 LU 分解，规模 = 路点数，足够大多数
//           交互场景）；
//        d. 对 [0,1] 等距取样，对每个 t 调用 De Boor。
//
// 维度：所有点为 N 维向量，由 number[] 表示，函数自动复用维度。
// ============================================================

const EPS = 1e-12;

/**
 * 在节点向量 knots 中找到使 knots[i] ≤ t < knots[i+1] 的索引 i。
 * 处理 t == 最末节点的边界情形。
 */
function findKnotSpan(t: number, degree: number, knots: readonly number[]): number {
    const n = knots.length - degree - 2;
    if (t >= knots[n + 1]) { return n; }
    if (t <= knots[degree]) { return degree; }
    // 二分
    let lo = degree, hi = n + 1;
    let mid = (lo + hi) >>> 1;
    while (t < knots[mid] || t >= knots[mid + 1]) {
        if (t < knots[mid]) { hi = mid; } else { lo = mid; }
        mid = (lo + hi) >>> 1;
    }
    return mid;
}

/**
 * 在参数 t 处用 De Boor 算法计算 B-spline 曲线点。
 *
 * @param controlPoints - 控制点数组（每个为 N 维 number[]）
 * @param knots         - 节点向量，长度 = controlPoints.length + degree + 1
 * @param degree        - 曲线次数（cubic = 3）
 * @param t             - 参数（取值范围 [knots[degree], knots[knots.length-degree-1]]）
 * @returns 曲线在 t 处的点（N 维）
 */
export function evaluateBSpline(
    controlPoints: readonly (readonly number[])[],
    knots: readonly number[],
    degree: number,
    t: number,
): number[] {
    if (controlPoints.length < degree + 1) {
        throw new Error('[B_SPLINE_INSUFFICIENT_CONTROL_POINTS]');
    }
    if (knots.length !== controlPoints.length + degree + 1) {
        throw new Error('[B_SPLINE_INVALID_KNOT_VECTOR]');
    }
    const dim = controlPoints[0].length;
    const span = findKnotSpan(t, degree, knots);

    // De Boor 局部数组：取 degree+1 个相关控制点的副本
    const d: number[][] = [];
    for (let j = 0; j <= degree; j++) {
        d.push(controlPoints[span - degree + j].slice());
    }

    for (let r = 1; r <= degree; r++) {
        for (let j = degree; j >= r; j--) {
            const i = span - degree + j;
            const denom = knots[i + degree - r + 1] - knots[i];
            const alpha = denom < EPS ? 0 : (t - knots[i]) / denom;
            for (let k = 0; k < dim; k++) {
                d[j][k] = (1 - alpha) * d[j - 1][k] + alpha * d[j][k];
            }
        }
    }
    return d[degree];
}

/**
 * 求 B-spline 基函数 N_{i,p}(t) 的所有非零值。
 * 返回 degree+1 个值，对应索引 [span-degree, span]。
 */
function basisFunctions(
    span: number,
    t: number,
    degree: number,
    knots: readonly number[],
): number[] {
    const N = new Array<number>(degree + 1).fill(0);
    const left = new Array<number>(degree + 1).fill(0);
    const right = new Array<number>(degree + 1).fill(0);
    N[0] = 1;
    for (let j = 1; j <= degree; j++) {
        left[j] = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            const denom = right[r + 1] + left[j - r];
            const temp = denom < EPS ? 0 : N[r] / denom;
            N[r] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        N[j] = saved;
    }
    return N;
}

/**
 * 解 n×n 线性方程组 A x = b（稠密 LU 分解 + 部分主元）。
 * 仅在内部插值阶段使用，n = 路点数，对几百级输入足够。
 */
function solveLinear(A: number[][], b: number[][]): number[][] {
    const n = A.length;
    const dim = b[0].length;
    // 构造增广矩阵（A | b）
    const M: number[][] = [];
    for (let i = 0; i < n; i++) {
        M.push([...A[i], ...b[i]]);
    }
    // 前向消元 + 部分主元
    for (let i = 0; i < n; i++) {
        let pivot = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) { pivot = k; }
        }
        if (Math.abs(M[pivot][i]) < EPS) {
            throw new Error('[B_SPLINE_SINGULAR_MATRIX]');
        }
        if (pivot !== i) {
            const tmp = M[i]; M[i] = M[pivot]; M[pivot] = tmp;
        }
        for (let k = i + 1; k < n; k++) {
            const factor = M[k][i] / M[i][i];
            for (let j = i; j < n + dim; j++) {
                M[k][j] -= factor * M[i][j];
            }
        }
    }
    // 回代
    const x: number[][] = [];
    for (let i = 0; i < n; i++) { x.push(new Array<number>(dim).fill(0)); }
    for (let i = n - 1; i >= 0; i--) {
        const row = M[i];
        const xi: number[] = x[i];
        for (let dd = 0; dd < dim; dd++) {
            let sum = row[n + dd];
            for (let j = i + 1; j < n; j++) {
                const xj: number[] = x[j];
                sum -= row[j] * xj[dd];
            }
            xi[dd] = sum / row[i];
        }
    }
    return x;
}

/** chord-length 参数化：计算 t_0 .. t_{n-1} ∈ [0,1] */
function chordParameterization(points: readonly (readonly number[])[]): number[] {
    const n = points.length;
    const t = new Array<number>(n).fill(0);
    let total = 0;
    for (let i = 1; i < n; i++) {
        let d2 = 0;
        for (let k = 0; k < points[i].length; k++) {
            const dk = points[i][k] - points[i - 1][k];
            d2 += dk * dk;
        }
        total += Math.sqrt(d2);
        t[i] = total;
    }
    if (total < EPS) {
        for (let i = 0; i < n; i++) { t[i] = i / (n - 1); }
    } else {
        for (let i = 0; i < n; i++) { t[i] /= total; }
    }
    return t;
}

/**
 * 通过给定路点构造 clamped uniform B-spline 并按 samples 个等参数样本求值。
 *
 * @param points  - 路点序列（每个为 N 维 number[]，N >= 2）
 * @param degree  - 曲线次数（推荐 3 即 cubic）
 * @param samples - 输出样本数（≥ 2）
 * @returns 曲线在 [0,1] 上 samples 个等参数位置的点序列
 *
 * @example
 * interpolateBSpline(
 *   [[0,0],[1,2],[3,3],[5,1],[6,4]],
 *   3, 50,
 * );
 * // → 50 个 2D 点，曲线穿过每个输入路点
 */
export function interpolateBSpline(
    points: readonly (readonly number[])[],
    degree: number = 3,
    samples: number = 100,
): number[][] {
    const n = points.length;
    if (n < 2) {
        throw new Error('[B_SPLINE_NEED_AT_LEAST_2_POINTS]');
    }
    if (degree < 1) {
        throw new Error('[B_SPLINE_DEGREE_LT_1]');
    }
    if (samples < 2) {
        throw new Error('[B_SPLINE_SAMPLES_LT_2]');
    }
    // 退化：路点不够形成给定次数 → 降阶
    const p = Math.min(degree, n - 1);

    const dim = points[0].length;

    // 1. chord-length 参数化
    const t = chordParameterization(points);

    // 2. clamped knot 向量：前后各 (p+1) 个重复端点，中间使用平均
    const m = n + p + 1; // 节点总数
    const knots = new Array<number>(m).fill(0);
    for (let i = 0; i <= p; i++) { knots[i] = 0; knots[m - 1 - i] = 1; }
    for (let j = 1; j <= n - p - 1; j++) {
        let sum = 0;
        for (let i = j; i <= j + p - 1; i++) { sum += t[i]; }
        knots[j + p] = sum / p;
    }

    // 3. 求解控制点：A_{i,j} = N_{j,p}(t_i)
    const A: number[][] = [];
    for (let i = 0; i < n; i++) { A.push(new Array<number>(n).fill(0)); }
    for (let i = 0; i < n; i++) {
        const span = findKnotSpan(t[i], p, knots);
        const Nvals = basisFunctions(span, t[i], p, knots);
        for (let k = 0; k <= p; k++) {
            A[i][span - p + k] = Nvals[k];
        }
    }
    const rhs: number[][] = points.map((pt) => pt.slice());
    const controlPoints = solveLinear(A, rhs);

    // 4. 等参数采样
    const out: number[][] = [];
    for (let i = 0; i < samples; i++) {
        const u = i / (samples - 1);
        out.push(evaluateBSpline(controlPoints, knots, p, u));
    }
    void dim;
    return out;
}
