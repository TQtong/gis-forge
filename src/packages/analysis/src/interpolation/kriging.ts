// ============================================================
// analysis/interpolation/kriging.ts — 普通克里金插值（Ordinary Kriging）
// ============================================================
//
// 克里金是地统计学的标准空间插值方法，与 IDW 不同的是它通过显式建模
// 空间相关性（变差函数 / variogram）来确定插值权重，并给出预测方差。
//
// 本实现：Ordinary Kriging（OK），假设未知常数均值。
// - 模型：z(x) = μ + ε(x)，其中 ε 是均值 0 的二阶平稳随机场
// - 变差函数：γ(h) = ½ E[(z(x+h) - z(x))²]
// - 求解线性方程组 K·λ = k 得到权重 λ
//
// 支持三种常用变差模型：
//   - spherical    球状模型
//   - exponential  指数模型
//   - gaussian     高斯模型
//
// 全部 Float64 计算。
// ============================================================

/**
 * 变差函数模型类型。
 */
export type VariogramModel = 'spherical' | 'exponential' | 'gaussian';

/**
 * 变差函数参数。
 *
 * @property model    模型类型
 * @property nugget   块金值（h=0 时的截距，反映测量误差）
 * @property sill     基台值（半方差的渐进极限）
 * @property range    变程（相关性消失的距离）
 */
export interface VariogramParams {
    readonly model: VariogramModel;
    readonly nugget: number;
    readonly sill: number;
    readonly range: number;
}

/**
 * 克里金插值结果。
 */
export interface KrigingResult {
    /** 估计值 */
    readonly value: number;
    /** 估计方差（克里金方差） */
    readonly variance: number;
}

/**
 * 计算变差函数 γ(h)。
 *
 * @param h 滞后距离
 * @param p 变差函数参数
 * @returns 半方差
 */
export function variogram(h: number, p: VariogramParams): number {
    if (h <= 0) return 0;
    const { model, nugget, sill, range } = p;
    const c = sill - nugget; // 偏基台值
    let g: number;
    switch (model) {
        case 'spherical': {
            if (h >= range) {
                g = sill;
            } else {
                const r = h / range;
                g = nugget + c * (1.5 * r - 0.5 * r * r * r);
            }
            break;
        }
        case 'exponential': {
            g = nugget + c * (1 - Math.exp(-3 * h / range));
            break;
        }
        case 'gaussian': {
            const r = h / range;
            g = nugget + c * (1 - Math.exp(-3 * r * r));
            break;
        }
        default:
            g = sill;
    }
    return g;
}

/**
 * 通过经验半方差自动拟合变差函数参数（最小二乘）。
 *
 * 1. 把样本对按距离分成 nLags 个区间，计算每个区间的平均半方差。
 * 2. 估计 nugget = 最小区间的半方差，sill = 最大区间的半方差。
 * 3. 估计 range = 半方差达到 sill·0.95 时的距离。
 * 4. 在指定模型下不再做迭代拟合（使用上述启发式估计）。
 *
 * 这是一个工程级简化，足够大多数 GIS 应用。需要严格拟合时可在外部
 * 用观测点对自行计算并传入参数。
 *
 * @param points 样本点 [{x, y, value}, ...]
 * @param model  变差函数模型
 * @param nLags  距离分箱数（默认 10）
 * @returns 估计的变差参数
 */
export function fitVariogram(
    points: ReadonlyArray<{ x: number; y: number; value: number }>,
    model: VariogramModel = 'exponential',
    nLags: number = 10,
): VariogramParams {
    const n = points.length;
    if (n < 2) {
        return { model, nugget: 0, sill: 1, range: 1 };
    }

    // 计算所有样本对的距离和半方差贡献
    let maxDist = 0;
    const distances: number[] = [];
    const semivars: number[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dx = points[i].x - points[j].x;
            const dy = points[i].y - points[j].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const dv = points[i].value - points[j].value;
            distances.push(d);
            semivars.push(0.5 * dv * dv);
            if (d > maxDist) maxDist = d;
        }
    }
    if (maxDist === 0) {
        return { model, nugget: 0, sill: 1, range: 1 };
    }

    // 分箱
    const lagSize = maxDist / nLags;
    const lagSums = new Float64Array(nLags);
    const lagCounts = new Int32Array(nLags);
    for (let i = 0; i < distances.length; i++) {
        const k = Math.min(nLags - 1, Math.floor(distances[i] / lagSize));
        lagSums[k] += semivars[i];
        lagCounts[k]++;
    }
    const lagMeans = new Float64Array(nLags);
    for (let i = 0; i < nLags; i++) {
        lagMeans[i] = lagCounts[i] > 0 ? lagSums[i] / lagCounts[i] : 0;
    }

    // 启发式估计参数
    let nugget = lagMeans[0];
    let sill = 0;
    for (let i = 0; i < nLags; i++) {
        if (lagMeans[i] > sill) sill = lagMeans[i];
    }
    if (sill < nugget) sill = nugget * 1.1;

    // range：半方差达到 sill·0.95 的最小距离
    const target = nugget + (sill - nugget) * 0.95;
    let range = maxDist;
    for (let i = 0; i < nLags; i++) {
        if (lagMeans[i] >= target) {
            range = (i + 0.5) * lagSize;
            break;
        }
    }
    if (range <= 0) range = lagSize;

    return { model, nugget, sill, range };
}

/**
 * 普通克里金插值：在查询点 (qx, qy) 估计值。
 *
 * 求解 OK 线性系统：
 *   [ Γ  1 ] [ λ ]   [ γ₀ ]
 *   [ 1ᵀ 0 ] [ μ ] = [ 1  ]
 * 其中 Γ_ij = γ(|x_i - x_j|), γ₀_i = γ(|x_i - q|), λ 是权重，μ 是拉格朗日乘子。
 * 估计值 = Σ λ_i · z_i，估计方差 = μ + Σ λ_i · γ₀_i。
 *
 * 用 Gauss-Jordan 消元解线性系统（Float64）。复杂度 O(n³)，适合 n ≤ 200 的局部
 * 邻域插值。大数据集应配合 KD-Tree 选取最近 K 个邻居（典型 K = 12-20）。
 *
 * @param points 样本点
 * @param params 变差函数参数
 * @param qx 查询点 x
 * @param qy 查询点 y
 * @returns 插值结果（估计值 + 方差）
 */
export function ordinaryKriging(
    points: ReadonlyArray<{ x: number; y: number; value: number }>,
    params: VariogramParams,
    qx: number,
    qy: number,
): KrigingResult {
    const n = points.length;
    if (n === 0) {
        return { value: NaN, variance: Infinity };
    }
    if (n === 1) {
        return { value: points[0].value, variance: params.sill };
    }

    // 构建 (n+1) x (n+2) 增广矩阵：[K | b]
    const N = n + 1;
    const M = new Float64Array(N * (N + 1));
    // K[i,j] = γ(|x_i - x_j|)
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const dx = points[i].x - points[j].x;
            const dy = points[i].y - points[j].y;
            const h = Math.sqrt(dx * dx + dy * dy);
            M[i * (N + 1) + j] = variogram(h, params);
        }
        // 拉格朗日约束行/列
        M[i * (N + 1) + n] = 1;
        // 右端项 b_i = γ(|x_i - q|)
        const dx = points[i].x - qx;
        const dy = points[i].y - qy;
        const h = Math.sqrt(dx * dx + dy * dy);
        M[i * (N + 1) + N] = variogram(h, params);
    }
    // 最后一行（约束 Σλ = 1）
    for (let j = 0; j < n; j++) {
        M[n * (N + 1) + j] = 1;
    }
    M[n * (N + 1) + n] = 0;
    M[n * (N + 1) + N] = 1;

    // Gauss-Jordan 消元 + 部分主元
    for (let i = 0; i < N; i++) {
        // 找列主元
        let maxRow = i;
        let maxVal = Math.abs(M[i * (N + 1) + i]);
        for (let r = i + 1; r < N; r++) {
            const v = Math.abs(M[r * (N + 1) + i]);
            if (v > maxVal) {
                maxVal = v;
                maxRow = r;
            }
        }
        if (maxVal < 1e-15) {
            // 矩阵奇异：返回最近邻插值
            let nearest = 0;
            let minD = Infinity;
            for (let k = 0; k < n; k++) {
                const dx = points[k].x - qx;
                const dy = points[k].y - qy;
                const d = dx * dx + dy * dy;
                if (d < minD) { minD = d; nearest = k; }
            }
            return { value: points[nearest].value, variance: params.sill };
        }
        // 交换行
        if (maxRow !== i) {
            for (let c = 0; c <= N; c++) {
                const t = M[i * (N + 1) + c];
                M[i * (N + 1) + c] = M[maxRow * (N + 1) + c];
                M[maxRow * (N + 1) + c] = t;
            }
        }
        // 归一化主元行
        const pivot = M[i * (N + 1) + i];
        for (let c = i; c <= N; c++) {
            M[i * (N + 1) + c] /= pivot;
        }
        // 消去其它行
        for (let r = 0; r < N; r++) {
            if (r === i) continue;
            const factor = M[r * (N + 1) + i];
            if (factor === 0) continue;
            for (let c = i; c <= N; c++) {
                M[r * (N + 1) + c] -= factor * M[i * (N + 1) + c];
            }
        }
    }

    // 解：M[i, N] = λ_i (i < n) 或 μ (i = n)
    let value = 0;
    let variance = M[n * (N + 1) + N]; // μ
    for (let i = 0; i < n; i++) {
        const lam = M[i * (N + 1) + N];
        value += lam * points[i].value;
        // variance += λ_i · γ₀_i
        const dx = points[i].x - qx;
        const dy = points[i].y - qy;
        const h = Math.sqrt(dx * dx + dy * dy);
        variance += lam * variogram(h, params);
    }

    return { value, variance: Math.max(0, variance) };
}
