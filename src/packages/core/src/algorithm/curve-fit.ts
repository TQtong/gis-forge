// ============================================================
// algorithm/curve-fit.ts — 曲线拟合（自研实现）
// 把离散点序列拟合为参数化曲线（贝塞尔等）。
// 与 math/interpolate.ts 的"已知控制点求点"形成正交：
//   curve-fit 是反问题——已知点，求最佳控制点。
// ============================================================

/**
 * 三次贝塞尔曲线（4 个控制点）。
 */
export interface CubicBezier {
    /** 起点 = 输入点首点 */
    readonly p0: [number, number];
    /** 第一控制点（最小二乘求解） */
    readonly p1: [number, number];
    /** 第二控制点（最小二乘求解） */
    readonly p2: [number, number];
    /** 终点 = 输入点尾点 */
    readonly p3: [number, number];
}

/**
 * 把 N 个采样点拟合为单条三次贝塞尔曲线（最小二乘解）。
 *
 * 算法（经典 Graphics Gems "An Algorithm for Automatically Fitting
 * Digitized Curves" 的简化版，单段非递归）：
 *
 * 1. 弦长参数化：t_i = (累计弦长 i / 总弦长)，t_0 = 0, t_{n-1} = 1
 * 2. 固定 P0 = points[0], P3 = points[n-1]
 * 3. 三次 Bernstein 基：
 *      B0(t) = (1-t)³,    B1(t) = 3(1-t)²t
 *      B2(t) = 3(1-t)t²,  B3(t) = t³
 *    曲线：Q(t) = B0·P0 + B1·P1 + B2·P2 + B3·P3
 * 4. 残差 R_i = points[i] - B0(t_i)·P0 - B3(t_i)·P3
 * 5. 求解 2×2 线性方程组（对 P1, P2 各 2 维独立）：
 *      [Σ B1²    Σ B1·B2] [P1]   [Σ B1·R]
 *      [Σ B1·B2  Σ B2² ] [P2] = [Σ B2·R]
 *
 * 返回的曲线在端点严格穿过 points[0] 和 points[n-1]，中间最小化平方误差。
 *
 * 限制：
 * - 单段拟合，对 S 形或自交点序列效果有限——这种情况应分段拟合。
 * - 至少需要 4 个点（少于 4 个会退化但不报错）。
 * - 当矩阵奇异（共线点或 t 全相同）时回退到 P1=P0+(P3-P0)/3, P2=P0+2(P3-P0)/3。
 *
 * @param points 输入点序列 [[x,y], ...]，n ≥ 2
 * @returns 拟合得到的三次贝塞尔曲线
 *
 * @example
 * const curve = bezierFit([[0,0],[1,2],[2,3],[3,2],[4,0]]);
 * // 用 curve.p0..p3 渲染或导出
 */
export function bezierFit(points: number[][]): CubicBezier {
    const n = points.length;
    if (n === 0) {
        return {
            p0: [0, 0],
            p1: [0, 0],
            p2: [0, 0],
            p3: [0, 0],
        };
    }
    if (n === 1) {
        const p = points[0];
        return {
            p0: [p[0], p[1]],
            p1: [p[0], p[1]],
            p2: [p[0], p[1]],
            p3: [p[0], p[1]],
        };
    }

    const p0x = points[0][0];
    const p0y = points[0][1];
    const p3x = points[n - 1][0];
    const p3y = points[n - 1][1];

    if (n === 2) {
        // 两点退化：直线，三等分
        const dx = (p3x - p0x) / 3;
        const dy = (p3y - p0y) / 3;
        return {
            p0: [p0x, p0y],
            p1: [p0x + dx, p0y + dy],
            p2: [p0x + 2 * dx, p0y + 2 * dy],
            p3: [p3x, p3y],
        };
    }

    // 弦长参数化
    const u = chordLengthParameterize(points);

    // 累加 2×2 法方程矩阵 A 和右端向量 b（x, y 各一份）
    let a11 = 0;
    let a12 = 0; // = a21
    let a22 = 0;
    let bx1 = 0;
    let bx2 = 0;
    let by1 = 0;
    let by2 = 0;

    for (let i = 0; i < n; i++) {
        const t = u[i];
        const omt = 1 - t;
        const b0 = omt * omt * omt;
        const b1 = 3 * omt * omt * t;
        const b2 = 3 * omt * t * t;
        const b3 = t * t * t;

        // 残差 = 实际点 - 端点贡献
        const rx = points[i][0] - (b0 * p0x + b3 * p3x);
        const ry = points[i][1] - (b0 * p0y + b3 * p3y);

        a11 += b1 * b1;
        a12 += b1 * b2;
        a22 += b2 * b2;
        bx1 += b1 * rx;
        bx2 += b2 * rx;
        by1 += b1 * ry;
        by2 += b2 * ry;
    }

    const det = a11 * a22 - a12 * a12;

    let p1x: number;
    let p1y: number;
    let p2x: number;
    let p2y: number;

    if (Math.abs(det) < 1e-20) {
        // 退化：均匀三等分
        const dx = (p3x - p0x) / 3;
        const dy = (p3y - p0y) / 3;
        p1x = p0x + dx;
        p1y = p0y + dy;
        p2x = p0x + 2 * dx;
        p2y = p0y + 2 * dy;
    } else {
        const invDet = 1 / det;
        p1x = (a22 * bx1 - a12 * bx2) * invDet;
        p1y = (a22 * by1 - a12 * by2) * invDet;
        p2x = (-a12 * bx1 + a11 * bx2) * invDet;
        p2y = (-a12 * by1 + a11 * by2) * invDet;
    }

    return {
        p0: [p0x, p0y],
        p1: [p1x, p1y],
        p2: [p2x, p2y],
        p3: [p3x, p3y],
    };
}

/**
 * 在拟合曲线上等参数采样若干点，得到平滑折线。
 * 便于把 bezierFit 的结果直接用于绘制或几何处理。
 *
 * @param curve 三次贝塞尔曲线
 * @param samples 采样数（≥2），默认 32
 * @returns 折线点数组，长度 = samples
 */
export function bezierSample(curve: CubicBezier, samples: number = 32): number[][] {
    if (samples < 2) samples = 2;
    const out: number[][] = new Array(samples);
    const { p0, p1, p2, p3 } = curve;
    for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        const omt = 1 - t;
        const b0 = omt * omt * omt;
        const b1 = 3 * omt * omt * t;
        const b2 = 3 * omt * t * t;
        const b3 = t * t * t;
        out[i] = [
            b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
            b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
        ];
    }
    return out;
}

/**
 * 弦长参数化：t_i = (累计弦长到 i) / 总弦长。
 * 返回 [0, ..., 1] 的数组，长度 = points.length。
 */
function chordLengthParameterize(points: number[][]): number[] {
    const n = points.length;
    const u = new Array<number>(n);
    u[0] = 0;
    for (let i = 1; i < n; i++) {
        const dx = points[i][0] - points[i - 1][0];
        const dy = points[i][1] - points[i - 1][1];
        u[i] = u[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    const total = u[n - 1];
    if (total < 1e-20) {
        // 所有点重合 → 均匀分布
        for (let i = 0; i < n; i++) {
            u[i] = i / (n - 1);
        }
    } else {
        for (let i = 1; i < n; i++) {
            u[i] /= total;
        }
        u[n - 1] = 1; // 强制端点闭合
    }
    return u;
}
