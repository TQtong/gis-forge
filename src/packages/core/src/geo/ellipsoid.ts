/**
 * @module geo/ellipsoid
 * @description WGS84 椭球体数学——经纬度↔ECEF 转换、椭球面法线、大地测量距离
 * （Vincenty 反算 / Haversine）。所有角度参数使用**弧度制**。
 * CPU 精确计算全部使用 Float64Array，保证 <1mm 精度。
 * 零 npm 依赖，全部自研实现。
 */

// ============================================================
// 类型别名 — Float64Array 语义化包装，便于阅读与文档自描述
// ============================================================

/** 双精度二维向量（CPU 精确计算用），底层 Float64Array，长度 2，存储 [x, y] 或 [lon, lat] */
export type Vec2d = Float64Array;

/** 双精度三维向量（CPU 精确计算用），底层 Float64Array，长度 3，存储 [x, y, z] 或 [lon, lat, alt] */
export type Vec3d = Float64Array;

// ============================================================
// WGS84 椭球体常量
// 参考来源：NIMA TR8350.2 (2000)，IERS Conventions (2010)
// 这些常量被 mercator.ts / geodesic.ts / 上层 L1~L6 广泛引用
// ============================================================

/** WGS84 长半轴（赤道半径），单位：米。定义值，无误差 */
export const WGS84_A: number = 6378137.0;

/**
 * WGS84 短半轴（极半径），单位：米。
 * 由 b = a × (1 - f) 精确推导而来，值 ≈ 6356752.314245179
 */
export const WGS84_B: number = 6356752.314245179;

/**
 * WGS84 扁率（flattening），无量纲。
 * 定义值 f = 1 / 298.257223563
 */
export const WGS84_F: number = 1.0 / 298.257223563;

/**
 * WGS84 第一偏心率的平方 e² = 2f - f²，无量纲。
 * 值 ≈ 0.00669437999014，描述椭球体偏离正球体的程度
 */
export const WGS84_E2: number = 2.0 * WGS84_F - WGS84_F * WGS84_F;

// ============================================================
// 内部常量 — 控制迭代精度和收敛行为
// ============================================================

/**
 * Vincenty 迭代收敛阈值（经度差 λ 的变化量）。
 * 1e-12 弧度 ≈ 0.06mm 地表距离，远超测量精度需求
 */
const VINCENTY_CONVERGENCE_THRESHOLD: number = 1e-12;

/**
 * Vincenty 最大迭代次数。
 * 正常情况 3~5 次即可收敛；近对跖点（nearly-antipodal）可能需要更多。
 * 100 次足以覆盖所有合理输入；若仍不收敛则返回 NaN
 */
const VINCENTY_MAX_ITERATIONS: number = 100;

/**
 * Bowring 迭代法的迭代次数。
 * 5 次迭代在地球尺度上可保证 <1mm 的纬度/高程精度
 */
const BOWRING_ITERATIONS: number = 5;

// ============================================================
// 核心转换函数
// ============================================================

/**
 * 将大地坐标（经度、纬度、高程）转换为 ECEF 地心地固笛卡尔坐标。
 *
 * ECEF (Earth-Centered Earth-Fixed) 坐标系：
 *   X 轴指向 0°经度（本初子午线）与赤道交点
 *   Y 轴指向 90°E 经度与赤道交点
 *   Z 轴指向北极
 *
 * 公式来源：标准大地测量学（Torge & Müller, 2012）
 *
 * @param out - 预分配的 Float64Array(3) 输出，存储 [X, Y, Z]（米）
 * @param lonRad - 经度（弧度），范围 [-π, π]
 * @param latRad - 纬度（弧度），范围 [-π/2, π/2]
 * @param alt - 椭球面上方高程（米），即海拔高度
 * @returns out 引用，便于链式调用
 *
 * @example
 * const ecef = new Float64Array(3);
 * geodeticToECEF(ecef, 0, 0, 0);
 * // ecef ≈ [6378137, 0, 0]  （赤道与本初子午线交点）
 *
 * @example
 * const ecef2 = new Float64Array(3);
 * geodeticToECEF(ecef2, 0, Math.PI / 2, 0);
 * // ecef2 ≈ [0, 0, 6356752.31]  （北极点）
 */
export function geodeticToECEF(
    out: Vec3d,
    lonRad: number,
    latRad: number,
    alt: number,
): Vec3d {
    // 预计算三角函数值，避免重复调用（V8 无法自动 CSE 跨 Math.sin/cos 调用）
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    // N = 卯酉圈曲率半径（Prime Vertical Radius of Curvature）
    // 公式：N = a / sqrt(1 - e²·sin²φ)
    // N 随纬度变化：赤道处 N = a ≈ 6378137m，极点处 N = a²/b ≈ 6399594m
    const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

    // ECEF 转换公式（标准大地测量公式）
    // X = (N + h) · cosφ · cosλ
    out[0] = (N + alt) * cosLat * cosLon;
    // Y = (N + h) · cosφ · sinλ
    out[1] = (N + alt) * cosLat * sinLon;
    // Z = (N·(1-e²) + h) · sinφ    ← Z 方向因扁率 e² 而比 X/Y 短
    out[2] = (N * (1.0 - WGS84_E2) + alt) * sinLat;

    return out;
}

/**
 * 将 ECEF 地心地固笛卡尔坐标转换回大地坐标（经度、纬度、高程）。
 * 使用 Bowring 迭代法（1985），5 次迭代可达 <1mm 精度。
 *
 * 算法概述：
 *   1. 经度由 atan2(Y, X) 直接求得（无需迭代）
 *   2. 纬度由 Bowring 公式迭代求解：给定初始近似值，
 *      每次利用当前纬度计算新的卯酉圈半径 N，再反算纬度
 *   3. 高程从纬度和水平距离推算
 *
 * @param out - 预分配的 Float64Array(3) 输出，存储 [lonRad, latRad, alt]
 * @param x - ECEF X 坐标（米）
 * @param y - ECEF Y 坐标（米）
 * @param z - ECEF Z 坐标（米）
 * @returns out 引用，便于链式调用
 *
 * @example
 * const geo = new Float64Array(3);
 * ecefToGeodetic(geo, 6378137, 0, 0);
 * // geo ≈ [0, 0, 0]  （赤道与本初子午线交点，高程 0）
 *
 * @example
 * const geo2 = new Float64Array(3);
 * ecefToGeodetic(geo2, 0, 0, 6356752.314245179);
 * // geo2 ≈ [0, π/2, 0]  （北极点）
 */
export function ecefToGeodetic(
    out: Vec3d,
    x: number,
    y: number,
    z: number,
): Vec3d {
    // 经度由 X/Y 直接求解，无需迭代（atan2 处理了所有象限）
    const lon = Math.atan2(y, x);

    // 水平距离 p = sqrt(X² + Y²)，即到 Z 轴的距离
    const p = Math.sqrt(x * x + y * y);

    // Bowring 初始近似：假设高程为 0，给出粗略纬度估计
    // 初始公式：lat₀ = atan2(Z, p·(1-e²))
    let lat = Math.atan2(z, p * (1.0 - WGS84_E2));

    // Bowring 迭代：每次用当前 lat 计算 N，再更新 lat
    // 5 次迭代在全球范围内保证 <1mm 精度（含极端高程）
    for (let i = 0; i < BOWRING_ITERATIONS; i++) {
        const sinLat = Math.sin(lat);
        // 当前纬度对应的卯酉圈曲率半径 N
        const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
        // Bowring 更新公式：lat = atan2(Z + e²·N·sinφ, p)
        // 这里 e²·N·sinφ 修正了由椭球扁率引起的 Z 偏移
        lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
    }

    // 收敛后的最终三角函数值
    const sinLatFinal = Math.sin(lat);
    const cosLatFinal = Math.cos(lat);
    // 最终卯酉圈曲率半径
    const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLatFinal * sinLatFinal);

    // 高程计算：根据纬度选择不同公式，避免极点附近 cos(lat)→0 导致的除零
    let alt: number;
    if (Math.abs(cosLatFinal) > 1e-10) {
        // 一般情况：用水平距离 p 推算高程
        // h = p / cosφ - N
        alt = p / cosLatFinal - N;
    } else {
        // 极点附近：cos(lat) ≈ 0，改用垂直距离 Z 推算
        // h = |Z| / |sinφ| - N·(1 - e²)
        alt = Math.abs(z) / Math.abs(sinLatFinal) - N * (1.0 - WGS84_E2);
    }

    out[0] = lon;
    out[1] = lat;
    out[2] = alt;

    return out;
}

/**
 * 计算椭球面上指定大地坐标处的外法线向量（单位向量）。
 *
 * 在球面上，法线就是从球心到地表点的方向。
 * 在椭球面上，法线不再精确指向球心，而是垂直于椭球面的切平面。
 * 但对于 WGS84 椭球（扁率很小），法线与球心方向的偏差 < 0.2°。
 *
 * 此处返回的是**球面近似**法线（即归一化的球面坐标方向），
 * 对于 GIS 渲染中的光照/法线贴图场景足够精确。
 *
 * @param out - 预分配的 Float64Array(3) 输出，存储单位法线 [nx, ny, nz]
 * @param lonRad - 经度（弧度），范围 [-π, π]
 * @param latRad - 纬度（弧度），范围 [-π/2, π/2]
 * @returns out 引用，便于链式调用
 *
 * @example
 * const normal = new Float64Array(3);
 * surfaceNormal(normal, 0, 0);
 * // normal ≈ [1, 0, 0]  （赤道本初子午线处，法线指向 +X）
 *
 * @example
 * const normalPole = new Float64Array(3);
 * surfaceNormal(normalPole, 0, Math.PI / 2);
 * // normalPole ≈ [0, 0, 1]  （北极，法线指向 +Z）
 */
export function surfaceNormal(
    out: Vec3d,
    lonRad: number,
    latRad: number,
): Vec3d {
    // 法线方向就是从球心到地表的单位向量
    // nx = cosφ · cosλ, ny = cosφ · sinλ, nz = sinφ
    const cosLat = Math.cos(latRad);
    out[0] = cosLat * Math.cos(lonRad);
    out[1] = cosLat * Math.sin(lonRad);
    out[2] = Math.sin(latRad);

    return out;
}

// ============================================================
// 大地测量距离
// ============================================================

/**
 * 使用 Vincenty 反算公式计算两点间的椭球面测地线距离。
 * 精度 <0.5mm，适合任意距离的高精度计算。
 *
 * 算法概述（Vincenty, 1975）：
 *   1. 将大地纬度换算为归化纬度（reduced latitude）
 *   2. 迭代求解辅助球面上的经度差 λ 直至收敛
 *   3. 从收敛的 λ 推算椭球面上的真实测地线长度
 *
 * 注意：对于近对跖点（nearly antipodal），迭代可能缓慢收敛或不收敛。
 * 若 100 次迭代仍未收敛，返回 NaN。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param lon2 - 终点经度（弧度）
 * @param lat2 - 终点纬度（弧度）
 * @returns 两点间的测地线距离（米），若不收敛返回 NaN
 *
 * @example
 * // 纽约 → 伦敦（粗略坐标，弧度）
 * const d = vincentyDistance(
 *   -74.006 * Math.PI / 180, 40.7128 * Math.PI / 180,
 *   -0.1278 * Math.PI / 180, 51.5074 * Math.PI / 180,
 * );
 * // d ≈ 5570226 米（≈5570 km）
 */
export function vincentyDistance(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
): number {
    // --- 快捷返回：两点重合时距离为 0 ---
    // 避免 sinσ = 0 导致后续除零
    if (lon1 === lon2 && lat1 === lat2) {
        return 0.0;
    }

    // --- Step 1: 计算归化纬度（reduced latitude）---
    // 归化纬度 U = atan((1-f)·tan(φ))，将椭球面映射到辅助球面
    const U1 = Math.atan((1.0 - WGS84_F) * Math.tan(lat1));
    const U2 = Math.atan((1.0 - WGS84_F) * Math.tan(lat2));

    // 预计算归化纬度的三角函数值（循环中会反复使用）
    const sinU1 = Math.sin(U1);
    const cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2);
    const cosU2 = Math.cos(U2);

    // --- Step 2: 迭代求解经度差 λ ---
    // L = 两点间的经度差（大地坐标系）
    const L = lon2 - lon1;

    // λ 初始值设为 L（球面近似）
    let lambda = L;
    let lambdaPrev: number;

    // 迭代过程中会更新的中间变量
    let sinSigma: number = 0;
    let cosSigma: number = 0;
    let sigma: number = 0;
    let sinAlpha: number = 0;
    let cos2Alpha: number = 0;
    let cos2SigmaM: number = 0;
    let C: number = 0;

    for (let iteration = 0; iteration < VINCENTY_MAX_ITERATIONS; iteration++) {
        // 当前 λ 的三角函数值
        const sinLambda = Math.sin(lambda);
        const cosLambda = Math.cos(lambda);

        // sinσ = sqrt((cosU2·sinλ)² + (cosU1·sinU2 - sinU1·cosU2·cosλ)²)
        // 这是辅助球面上两点间角距离的正弦值
        const term1 = cosU2 * sinLambda;
        const term2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
        sinSigma = Math.sqrt(term1 * term1 + term2 * term2);

        // 如果 sinσ ≈ 0，两点重合（或经过迭代收缩到重合），距离为 0
        if (sinSigma < 1e-15) {
            return 0.0;
        }

        // cosσ = sinU1·sinU2 + cosU1·cosU2·cosλ
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;

        // σ = atan2(sinσ, cosσ) — 辅助球面上的角距离
        sigma = Math.atan2(sinSigma, cosSigma);

        // sinα = cosU1·cosU2·sinλ / sinσ — 测地线在赤道处的方位角正弦
        sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;

        // cos²α = 1 - sin²α — 赤道方位角的余弦平方
        cos2Alpha = 1.0 - sinAlpha * sinAlpha;

        // cos(2σ_m) — 测地线中点的辅助纬度参数
        // 特殊情况：当 cos²α = 0（赤道上的测地线），cos2σ_m 定义为 0
        if (Math.abs(cos2Alpha) < 1e-15) {
            cos2SigmaM = 0.0;
        } else {
            cos2SigmaM = cosSigma - (2.0 * sinU1 * sinU2) / cos2Alpha;
        }

        // C = (f/16)·cos²α·(4 + f·(4 - 3·cos²α))
        // C 是将辅助球面经度差修正为大地经度差的系数
        C = (WGS84_F / 16.0) * cos2Alpha * (4.0 + WGS84_F * (4.0 - 3.0 * cos2Alpha));

        // 保存上一轮的 λ，用于收敛判断
        lambdaPrev = lambda;

        // 更新 λ：从辅助球面经度差反算大地经度差
        // λ = L + (1-C)·f·sinα·(σ + C·sinσ·(cos2σ_m + C·cosσ·(-1 + 2·cos²2σ_m)))
        lambda = L + (1.0 - C) * WGS84_F * sinAlpha * (
            sigma + C * sinSigma * (
                cos2SigmaM + C * cosSigma * (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM)
            )
        );

        // 收敛判断：λ 的变化量小于阈值（~0.06mm）
        if (Math.abs(lambda - lambdaPrev) < VINCENTY_CONVERGENCE_THRESHOLD) {
            break;
        }

        // 最后一次迭代仍未收敛：近对跖点情况，返回 NaN
        if (iteration === VINCENTY_MAX_ITERATIONS - 1) {
            return NaN;
        }
    }

    // --- Step 3: 从收敛的辅助参数计算椭球面上的测地线距离 ---

    // u² = cos²α · (a² - b²) / b² — 椭球面上纬度相关的修正参数
    const uSquared = cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

    // A = 1 + u²/16384 · (4096 + u²·(-768 + u²·(320 - 175·u²)))
    // A 是距离的主修正系数（Helmert 级数展开的截断近似）
    const A = 1.0 + (uSquared / 16384.0) * (
        4096.0 + uSquared * (-768.0 + uSquared * (320.0 - 175.0 * uSquared))
    );

    // B = u²/1024 · (256 + u²·(-128 + u²·(74 - 47·u²)))
    // B 是角距离的修正系数
    const B = (uSquared / 1024.0) * (
        256.0 + uSquared * (-128.0 + uSquared * (74.0 - 47.0 * uSquared))
    );

    // Δσ — 角距离的修正量
    // Δσ = B·sinσ·(cos2σ_m + B/4·(cosσ·(-1 + 2·cos²2σ_m) - B/6·cos2σ_m·(-3 + 4·sin²σ)·(-3 + 4·cos²2σ_m)))
    const cos2SigmaMSq = cos2SigmaM * cos2SigmaM;
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + (B / 4.0) * (
            cosSigma * (-1.0 + 2.0 * cos2SigmaMSq)
            - (B / 6.0) * cos2SigmaM * (-3.0 + 4.0 * sinSigma * sinSigma) * (-3.0 + 4.0 * cos2SigmaMSq)
        )
    );

    // 最终距离：s = b · A · (σ - Δσ)
    const distance = WGS84_B * A * (sigma - deltaSigma);

    return distance;
}

/**
 * 使用 Haversine 公式计算两点间的球面大圆距离。
 * 以 WGS84 长半轴 a 为球体半径（赤道近似），精度约 0.5%。
 * 速度远快于 Vincenty，适用于短距离或精度要求不高的场景。
 *
 * Haversine 公式利用半正矢函数（haversine = sin²(θ/2)）来避免浮点精度问题，
 * 在短距离时比余弦球面公式更稳定。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param lon2 - 终点经度（弧度）
 * @param lat2 - 终点纬度（弧度）
 * @returns 球面大圆距离（米），基于 WGS84_A 半径
 *
 * @example
 * // 北京 → 上海（粗略坐标，弧度）
 * const d = haversineDistance(
 *   116.4 * Math.PI / 180, 39.9 * Math.PI / 180,
 *   121.5 * Math.PI / 180, 31.2 * Math.PI / 180,
 * );
 * // d ≈ 1067 km
 */
export function haversineDistance(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
): number {
    // 计算纬度差和经度差
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;

    // Haversine 核心公式：a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
    // 使用半正矢函数避免 cos 公式在短距离时的精度损失
    const sinHalfDLat = Math.sin(dLat * 0.5);
    const sinHalfDLon = Math.sin(dLon * 0.5);
    const a = sinHalfDLat * sinHalfDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLon * sinHalfDLon;

    // 中心角 c = 2·atan2(√a, √(1-a))
    // 用 atan2 而非 asin 来获得完整的数值范围稳定性
    // 但对于 Haversine，经典形式 2·asin(√a) 在 a ≤ 1 时也是安全的
    // clamp a 到 [0, 1] 防止浮点溢出导致 sqrt 出 NaN
    const clampedA = Math.min(a, 1.0);

    // 距离 = 2 · R · asin(√a)，R 取 WGS84 长半轴作为球体近似半径
    return 2.0 * WGS84_A * Math.asin(Math.sqrt(clampedA));
}

/**
 * 批量将大地坐标数组（经纬度+高程）转换为 ECEF 笛卡尔坐标。
 * 性能关键路径：瓦片解码时需要一次性转换大量坐标。
 *
 * 输入输出均为紧凑排列的 Float64Array（stride = 3），
 * 避免中间对象分配，对 V8 GC 友好。
 *
 * @param lonLatAlt - 输入坐标数组，紧凑排列 [lon1, lat1, alt1, lon2, lat2, alt2, ...]（弧度+米）
 * @param outECEF - 输出 ECEF 数组，紧凑排列 [x1, y1, z1, x2, y2, z2, ...]（米）
 * @returns void — 结果直接写入 outECEF
 *
 * @example
 * const input = new Float64Array([0, 0, 0, Math.PI/2, 0, 0]);
 * const output = new Float64Array(6);
 * batchGeodeticToECEF(input, output);
 * // output ≈ [6378137, 0, 0, 0, 6378137, 0]
 */
export function batchGeodeticToECEF(
    lonLatAlt: Float64Array,
    outECEF: Float64Array,
): void {
    // 验证输入长度是 3 的倍数（lon, lat, alt 三元组）
    // 整数除法获取坐标点数量
    const count = (lonLatAlt.length / 3) | 0;

    // 逐点调用 geodeticToECEF，利用 subarray 避免数组拷贝
    // subarray 返回原 buffer 的视图，零分配
    for (let i = 0; i < count; i++) {
        const offset = i * 3;
        // subarray 创建的是同一 ArrayBuffer 的视图，不分配新内存
        // 这样 geodeticToECEF 直接写入 outECEF 的对应位置
        geodeticToECEF(
            outECEF.subarray(offset, offset + 3) as Vec3d,
            lonLatAlt[offset],
            lonLatAlt[offset + 1],
            lonLatAlt[offset + 2],
        );
    }
}

// ============================================================
// ENU 局部切平面坐标
// ============================================================

const _enuTmpO: Vec3d = new Float64Array(3) as Vec3d;

/**
 * ECEF → ENU（East-North-Up）局部切平面坐标。
 *
 * 给定参考原点（lonRad0, latRad0, alt0），把一个 ECEF 点变换到以原点为中心、
 * X=East / Y=North / Z=Up 的局部直角坐标系。
 *
 * 推导：相对原点的 ECEF 偏移 → 通过原点处旋转矩阵投影到局部三轴。
 *   R = [[-sinλ,        cosλ,         0     ],
 *        [-sinφ·cosλ,  -sinφ·sinλ,    cosφ ],
 *        [ cosφ·cosλ,   cosφ·sinλ,    sinφ ]]
 *
 * 适用范围：原点附近 km 量级（建模 / Camera-Relative Render / AR）。
 * 离原点越远精度越差。
 *
 * @param out 输出 [east, north, up]（米），可重用避免分配
 * @param x   被测点 ECEF x（米）
 * @param y   被测点 ECEF y（米）
 * @param z   被测点 ECEF z（米）
 * @param lonRad0 参考原点经度（弧度）
 * @param latRad0 参考原点纬度（弧度）
 * @param alt0 参考原点高程（米）
 * @returns out 引用
 */
export function ecefToENU(
    out: Vec3d,
    x: number, y: number, z: number,
    lonRad0: number, latRad0: number, alt0: number = 0,
): Vec3d {
    geodeticToECEF(_enuTmpO, lonRad0, latRad0, alt0);
    const dx = x - _enuTmpO[0];
    const dy = y - _enuTmpO[1];
    const dz = z - _enuTmpO[2];

    const sinL = Math.sin(lonRad0);
    const cosL = Math.cos(lonRad0);
    const sinP = Math.sin(latRad0);
    const cosP = Math.cos(latRad0);

    out[0] = -sinL * dx + cosL * dy;
    out[1] = -sinP * cosL * dx - sinP * sinL * dy + cosP * dz;
    out[2] = cosP * cosL * dx + cosP * sinL * dy + sinP * dz;
    return out;
}

/**
 * ENU → ECEF 反变换（ecefToENU 的逆运算）。
 *
 * @param out 输出 ECEF [x, y, z]（米）
 * @param east 被测点东向（米）
 * @param north 被测点北向（米）
 * @param up 被测点天向（米）
 * @param lonRad0 参考原点经度（弧度）
 * @param latRad0 参考原点纬度（弧度）
 * @param alt0 参考原点高程（米）
 * @returns out 引用
 */
export function enuToECEF(
    out: Vec3d,
    east: number, north: number, up: number,
    lonRad0: number, latRad0: number, alt0: number = 0,
): Vec3d {
    geodeticToECEF(_enuTmpO, lonRad0, latRad0, alt0);

    const sinL = Math.sin(lonRad0);
    const cosL = Math.cos(lonRad0);
    const sinP = Math.sin(latRad0);
    const cosP = Math.cos(latRad0);

    // R^T 应用于 (east, north, up)
    const dx = -sinL * east - sinP * cosL * north + cosP * cosL * up;
    const dy = cosL * east - sinP * sinL * north + cosP * sinL * up;
    const dz = cosP * north + sinP * up;

    out[0] = _enuTmpO[0] + dx;
    out[1] = _enuTmpO[1] + dy;
    out[2] = _enuTmpO[2] + dz;
    return out;
}

const _enuTmpEcef: Vec3d = new Float64Array(3) as Vec3d;

/**
 * 经纬度（弧度）→ ENU 便捷函数：先 geodeticToECEF 再 ecefToENU。
 */
export function geodeticToENU(
    out: Vec3d,
    lonRad: number, latRad: number, alt: number,
    lonRad0: number, latRad0: number, alt0: number = 0,
): Vec3d {
    geodeticToECEF(_enuTmpEcef, lonRad, latRad, alt);
    return ecefToENU(out, _enuTmpEcef[0], _enuTmpEcef[1], _enuTmpEcef[2], lonRad0, latRad0, alt0);
}

// ============================================================
// 椭球面最近点
// ============================================================

/**
 * 给定 ECEF 空间中一个任意点 P，求 WGS84 椭球面上**距离 P 最近**的点 Q。
 *
 * 思路：把 P 转换为大地坐标 (lon, lat, alt) 后，把 alt 设为 0 再转回 ECEF。
 * 这是标准方法——`ecefToGeodetic` 的几何含义就是"P 到椭球面的垂足"加上
 * 沿法线方向的高度偏移 alt。丢弃 alt 后剩下的即为最近点。
 *
 * 精度：与 `ecefToGeodetic` 的 Bowring / Heiskanen-Moritz 迭代精度一致
 * （通常 < 1cm）。
 *
 * @param out 输出 ECEF [x, y, z]
 * @param px 查询点 ECEF x（米）
 * @param py 查询点 ECEF y（米）
 * @param pz 查询点 ECEF z（米）
 * @returns out 引用
 */
const _closestTmpGeo: Vec3d = new Float64Array(3) as Vec3d;

export function closestPointOnEllipsoid(
    out: Vec3d,
    px: number, py: number, pz: number,
): Vec3d {
    // 转成大地坐标：geodetic[0] = lon (rad), [1] = lat (rad), [2] = alt (m)
    ecefToGeodetic(_closestTmpGeo, px, py, pz);
    // alt = 0 再转回 ECEF
    geodeticToECEF(out, _closestTmpGeo[0], _closestTmpGeo[1], 0);
    return out;
}

/**
 * 计算任意点到椭球面的距离（沿椭球面法线方向的高度，可为负）。
 *
 * 返回 `ecefToGeodetic` 解算出的 altitude，即该点相对椭球面的高度：
 * 正值 = 在椭球面外部，负值 = 在椭球面内部。
 *
 * @param px ECEF x
 * @param py ECEF y
 * @param pz ECEF z
 * @returns 高度（米）
 */
export function distanceToEllipsoid(px: number, py: number, pz: number): number {
    ecefToGeodetic(_closestTmpGeo, px, py, pz);
    return _closestTmpGeo[2];
}
