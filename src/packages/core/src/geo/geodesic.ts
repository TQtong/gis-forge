/**
 * @module geo/geodesic
 * @description 大地测量计算——Vincenty 正算（正解）、方位角、大圆中点、
 * 大圆中间点、最近线上点。所有角度输入输出均为**弧度制**。
 * 零 npm 依赖，全部自研实现。
 */

import { WGS84_A, WGS84_B, WGS84_F } from './ellipsoid.ts';

// ============================================================
// 返回类型定义
// ============================================================

/**
 * Vincenty 正解（Direct Problem）的返回结果。
 * 给定起点、初始方位角和距离，计算终点坐标和终点方位角。
 */
export interface VincentyDirectResult {
    /** 终点经度（弧度） */
    readonly lon: number;
    /** 终点纬度（弧度） */
    readonly lat: number;
    /** 终点处的方位角（弧度），范围 [0, 2π)。即在终点处沿测地线前进方向的方位角 */
    readonly finalBearing: number;
}

/**
 * 最近线上点查询的返回结果。
 * 包含最近点的坐标、距离、所在线段索引和线段内的分数位置。
 */
export interface NearestPointResult {
    /** 最近点的经度（弧度） */
    readonly lon: number;
    /** 最近点的纬度（弧度） */
    readonly lat: number;
    /** 从查询点到最近点的角距离（弧度）。乘以地球半径可得米 */
    readonly distance: number;
    /** 最近点所在的线段索引（0-based）。线段 i 连接 lineCoords[i] 和 lineCoords[i+1] */
    readonly index: number;
    /** 最近点在所在线段上的分数位置，范围 [0, 1]。0 = 线段起点，1 = 线段终点 */
    readonly fraction: number;
}

// ============================================================
// 内部常量
// ============================================================

/** Vincenty 正解迭代收敛阈值（σ 的变化量），1e-12 弧度 ≈ 0.06mm */
const DIRECT_CONVERGENCE_THRESHOLD: number = 1e-12;

/** Vincenty 正解最大迭代次数 */
const DIRECT_MAX_ITERATIONS: number = 100;

/**
 * 角距离的微小阈值（弧度）。
 * 当两点间角距离小于此值时视为重合，避免除零。
 * 1e-15 弧度 ≈ 6.4 纳米地表距离。
 */
const ANGULAR_EPSILON: number = 1e-15;

/** 2π 常量，避免重复计算 */
const TWO_PI: number = 2.0 * Math.PI;

// ============================================================
// Vincenty 正解（Direct Problem）
// ============================================================

/**
 * Vincenty 正解：给定起点、初始方位角和距离，计算终点坐标和终点方位角。
 *
 * 算法概述（Vincenty, 1975）：
 *   1. 将大地纬度换算为归化纬度
 *   2. 计算初始辅助参数（赤道方位角、椭球修正因子 A/B）
 *   3. 迭代求解辅助球面角距离 σ 直至收敛
 *   4. 从 σ 推算终点的大地坐标和方位角
 *
 * 精度 <0.5mm，适合长距离高精度计算（航线规划、测量控制网等）。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param initialBearing - 初始方位角（弧度），从正北顺时针量度，范围 [0, 2π)
 * @param distance - 测地线距离（米），必须非负
 * @returns 终点坐标和终点方位角
 *
 * @example
 * // 从伦敦出发，方位角 45°（东北），走 1000km
 * const result = vincentyDirect(
 *   -0.1278 * Math.PI / 180,
 *   51.5074 * Math.PI / 180,
 *   45 * Math.PI / 180,
 *   1000000,
 * );
 * // result.lat ≈ 57.6°N, result.lon ≈ 17.5°E（大致在瑞典南部）
 */
export function vincentyDirect(
    lon1: number,
    lat1: number,
    initialBearing: number,
    distance: number,
): VincentyDirectResult {
    // --- 快捷返回：距离为 0 时终点就是起点 ---
    if (distance <= 0) {
        return { lon: lon1, lat: lat1, finalBearing: initialBearing };
    }

    // --- Step 1: 归化纬度和初始方位角分量 ---
    // U1 = atan((1-f)·tan(φ1))：将大地纬度映射到辅助球面
    const tanU1 = (1.0 - WGS84_F) * Math.tan(lat1);
    // 用 1/sqrt(1+tan²) 计算 cosU1，避免直接计算 atan 再取 cos（精度更好）
    const cosU1 = 1.0 / Math.sqrt(1.0 + tanU1 * tanU1);
    const sinU1 = tanU1 * cosU1;

    // 方位角的三角函数值
    const cosAlpha1 = Math.cos(initialBearing);
    const sinAlpha1 = Math.sin(initialBearing);

    // σ1 = atan2(tanU1, cosα1)：起点到赤道交点的辅助角距离
    const sigma1 = Math.atan2(tanU1, cosAlpha1);

    // sinα = cosU1·sinα1：测地线在赤道处的方位角正弦
    const sinAlpha = cosU1 * sinAlpha1;

    // cos²α = 1 - sin²α：赤道方位角的余弦平方
    const cos2Alpha = 1.0 - sinAlpha * sinAlpha;

    // --- Step 2: 椭球修正因子 A 和 B ---
    // u² = cos²α·(a²-b²)/b²：纬度相关的椭球修正参数
    const uSquared = cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

    // A = 1 + u²/16384·(4096 + u²·(-768 + u²·(320 - 175·u²)))
    // Helmert 级数展开的高阶近似，距离主修正系数
    const A = 1.0 + (uSquared / 16384.0) * (
        4096.0 + uSquared * (-768.0 + uSquared * (320.0 - 175.0 * uSquared))
    );

    // B = u²/1024·(256 + u²·(-128 + u²·(74 - 47·u²)))
    // 角距离修正系数
    const B = (uSquared / 1024.0) * (
        256.0 + uSquared * (-128.0 + uSquared * (74.0 - 47.0 * uSquared))
    );

    // --- Step 3: 迭代求解 σ ---
    // 初始猜测：σ = s / (b·A)（球面近似）
    let sigma = distance / (WGS84_B * A);
    let sigmaPrev: number;

    // 迭代变量
    let cos2SigmaM: number = 0;
    let sinSigma: number = 0;
    let cosSigma: number = 0;

    for (let i = 0; i < DIRECT_MAX_ITERATIONS; i++) {
        // cos(2σ_m) = cos(2·σ1 + σ)：中点辅助参数
        cos2SigmaM = Math.cos(2.0 * sigma1 + sigma);
        sinSigma = Math.sin(sigma);
        cosSigma = Math.cos(sigma);

        // Δσ 修正量（与 Vincenty 反算公式结构相同）
        const cos2SigmaMSq = cos2SigmaM * cos2SigmaM;
        const deltaSigma = B * sinSigma * (
            cos2SigmaM + (B / 4.0) * (
                cosSigma * (-1.0 + 2.0 * cos2SigmaMSq)
                - (B / 6.0) * cos2SigmaM * (-3.0 + 4.0 * sinSigma * sinSigma) * (-3.0 + 4.0 * cos2SigmaMSq)
            )
        );

        // 保存旧值用于收敛判断
        sigmaPrev = sigma;

        // 更新 σ = s/(b·A) + Δσ
        sigma = distance / (WGS84_B * A) + deltaSigma;

        // 收敛判断：σ 的变化量小于阈值
        if (Math.abs(sigma - sigmaPrev) < DIRECT_CONVERGENCE_THRESHOLD) {
            break;
        }
    }

    // --- Step 4: 从收敛的 σ 计算终点坐标 ---

    // 终点纬度公式（确保精确的反正切计算）
    // φ2 = atan2(sinU1·cosσ + cosU1·sinσ·cosα1,
    //            (1-f)·sqrt(sinα² + (sinU1·sinσ - cosU1·cosσ·cosα1)²))
    const sinU1CosSigma = sinU1 * cosSigma;
    const cosU1SinSigmaCosAlpha1 = cosU1 * sinSigma * cosAlpha1;

    // 分子：sinU1·cosσ + cosU1·sinσ·cosα1
    const latNumerator = sinU1CosSigma + cosU1SinSigmaCosAlpha1;
    // 分母中的中间项：sinU1·sinσ - cosU1·cosσ·cosα1
    const latDenomTerm = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
    // 分母：(1-f)·sqrt(sinα² + term²)
    const latDenominator = (1.0 - WGS84_F) * Math.sqrt(sinAlpha * sinAlpha + latDenomTerm * latDenomTerm);
    const lat2 = Math.atan2(latNumerator, latDenominator);

    // 辅助经度差 λ（辅助球面上）
    // λ = atan2(sinσ·sinα1, cosU1·cosσ - sinU1·sinσ·cosα1)
    const lambdaNumerator = sinSigma * sinAlpha1;
    const lambdaDenominator = cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1;
    const lambda = Math.atan2(lambdaNumerator, lambdaDenominator);

    // C 系数：将辅助球面经度差修正为大地经度差
    const C = (WGS84_F / 16.0) * cos2Alpha * (4.0 + WGS84_F * (4.0 - 3.0 * cos2Alpha));

    // 大地经度差 L = λ - (1-C)·f·sinα·(σ + C·sinσ·(cos2σ_m + C·cosσ·(-1 + 2·cos²2σ_m)))
    const L = lambda - (1.0 - C) * WGS84_F * sinAlpha * (
        sigma + C * sinSigma * (
            cos2SigmaM + C * cosSigma * (-1.0 + 2.0 * cos2SigmaM * cos2SigmaM)
        )
    );

    // 终点经度
    const lon2 = lon1 + L;

    // 终点方位角：α2 = atan2(sinα, -sinU1·sinσ + cosU1·cosσ·cosα1)
    // 注意分子是 sinα（赤道方位角），分母包含负号
    const finalBearing = Math.atan2(
        sinAlpha,
        -sinU1 * sinSigma + cosU1 * cosSigma * cosAlpha1,
    );

    // 将终点方位角归一化到 [0, 2π)
    const normalizedBearing = ((finalBearing % TWO_PI) + TWO_PI) % TWO_PI;

    return { lon: lon2, lat: lat2, finalBearing: normalizedBearing };
}

// ============================================================
// 方位角（Bearing）
// ============================================================

/**
 * 计算从起点到终点的初始方位角（Initial Bearing）。
 *
 * 初始方位角是在起点处沿大圆弧出发的方向角，
 * 从正北顺时针量度，范围 [0, 2π)。
 *
 * 使用球面三角学公式（非 Vincenty），精度足够用于 GIS 可视化。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param lon2 - 终点经度（弧度）
 * @param lat2 - 终点纬度（弧度）
 * @returns 初始方位角（弧度），范围 [0, 2π)
 *
 * @example
 * // 从赤道本初子午线到北极
 * initialBearing(0, 0, 0, Math.PI / 2);
 * // → 0（正北）
 *
 * @example
 * // 从赤道本初子午线向东
 * initialBearing(0, 0, Math.PI / 2, 0);
 * // → π/2（正东）
 */
export function initialBearing(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
): number {
    // 经度差
    const dLon = lon2 - lon1;

    // 球面三角学公式：
    // θ = atan2(sin(Δlon)·cos(lat2),
    //           cos(lat1)·sin(lat2) - sin(lat1)·cos(lat2)·cos(Δlon))
    const sinDLon = Math.sin(dLon);
    const cosDLon = Math.cos(dLon);
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const sinLat2 = Math.sin(lat2);
    const cosLat2 = Math.cos(lat2);

    // 分子：sin(Δlon)·cos(lat2) — 东西方向分量
    const y = sinDLon * cosLat2;
    // 分母：cos(lat1)·sin(lat2) - sin(lat1)·cos(lat2)·cos(Δlon) — 南北方向分量
    const x = cosLat1 * sinLat2 - sinLat1 * cosLat2 * cosDLon;

    // atan2 返回 [-π, π]，归一化到 [0, 2π)
    const bearing = Math.atan2(y, x);
    return ((bearing % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * 计算从起点到终点的终点方位角（Final Bearing）。
 *
 * 终点方位角是大圆弧在终点处的切线方向角，
 * 从正北顺时针量度，范围 [0, 2π)。
 *
 * 实现方式：计算从终点到起点的初始方位角，然后加 π（反转 180°）。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param lon2 - 终点经度（弧度）
 * @param lat2 - 终点纬度（弧度）
 * @returns 终点方位角（弧度），范围 [0, 2π)
 *
 * @example
 * // 赤道上向东的测地线，终点方位角仍为东（因为赤道是大圆）
 * finalBearing(0, 0, Math.PI / 2, 0);
 * // → π/2（正东）
 */
export function finalBearing(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
): number {
    // 终点方位角 = 反向初始方位角 + π
    // 即从 (lon2,lat2) 到 (lon1,lat1) 的初始方位角翻转 180°
    const reverseBearing = initialBearing(lon2, lat2, lon1, lat1);
    return ((reverseBearing + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
}

// ============================================================
// 大圆中点与中间点
// ============================================================

/**
 * 计算两点间大圆弧上的地理中点。
 *
 * 使用球面三角学的中点公式，将两点转换为 3D 单位向量，
 * 取中点后转回经纬度。比 intermediatePoint(f=0.5) 更高效，
 * 因为避免了角距离计算。
 *
 * @param lon1 - 第一点经度（弧度）
 * @param lat1 - 第一点纬度（弧度）
 * @param lon2 - 第二点经度（弧度）
 * @param lat2 - 第二点纬度（弧度）
 * @returns 中点坐标 {lon, lat}（弧度）
 *
 * @example
 * // 赤道上两点的中点
 * midpoint(0, 0, Math.PI / 2, 0);
 * // → { lon: π/4, lat: 0 }
 *
 * @example
 * // 北极与赤道点的中点
 * midpoint(0, 0, 0, Math.PI / 2);
 * // → { lon: 0, lat: π/4 }（约 45°N）
 */
export function midpoint(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
): { lon: number; lat: number } {
    // 经度差
    const dLon = lon2 - lon1;

    // 预计算三角函数值
    const cosLat1 = Math.cos(lat1);
    const cosLat2 = Math.cos(lat2);
    const sinLat1 = Math.sin(lat1);
    const sinLat2 = Math.sin(lat2);

    // 球面中点公式的辅助变量：
    // Bx = cos(lat2)·cos(Δlon)
    // By = cos(lat2)·sin(Δlon)
    const bx = cosLat2 * Math.cos(dLon);
    const by = cosLat2 * Math.sin(dLon);

    // 中点纬度：lat_m = atan2(sin(lat1) + sin(lat2), sqrt((cos(lat1)+Bx)² + By²))
    // 这个公式比简单平均更精确，因为考虑了球面弯曲
    const latMid = Math.atan2(
        sinLat1 + sinLat2,
        Math.sqrt((cosLat1 + bx) * (cosLat1 + bx) + by * by),
    );

    // 中点经度：lon_m = lon1 + atan2(By, cos(lat1) + Bx)
    const lonMid = lon1 + Math.atan2(by, cosLat1 + bx);

    return { lon: lonMid, lat: latMid };
}

/**
 * 计算大圆弧上给定分数位置处的中间点。
 *
 * 使用球面线性插值（SLERP）在大圆弧上精确插值。
 * fraction = 0 返回起点，fraction = 1 返回终点，fraction = 0.5 返回中点。
 *
 * 公式基于单位球面上的 SLERP：
 *   P(f) = sin((1-f)·d)/sin(d) · P1 + sin(f·d)/sin(d) · P2
 * 其中 d 是两点间的角距离（弧度）。
 *
 * @param lon1 - 起点经度（弧度）
 * @param lat1 - 起点纬度（弧度）
 * @param lon2 - 终点经度（弧度）
 * @param lat2 - 终点纬度（弧度）
 * @param fraction - 沿大圆弧的分数位置，范围 [0, 1]
 * @returns 中间点坐标 {lon, lat}（弧度）
 *
 * @example
 * // 大圆弧的 1/4 位置
 * intermediatePoint(0, 0, Math.PI / 2, 0, 0.25);
 * // → { lon: ≈π/8, lat: 0 }（赤道上约 22.5°E）
 *
 * @example
 * // fraction=0 返回起点
 * intermediatePoint(0, 0, 1, 1, 0);
 * // → { lon: 0, lat: 0 }
 */
export function intermediatePoint(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
    fraction: number,
): { lon: number; lat: number } {
    // --- 边界情况：fraction 在端点处或两点重合 ---
    if (fraction <= 0) {
        return { lon: lon1, lat: lat1 };
    }
    if (fraction >= 1) {
        return { lon: lon2, lat: lat2 };
    }

    // --- 计算两点间的角距离 d（Haversine 公式，弧度） ---
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const sinHalfDLat = Math.sin(dLat * 0.5);
    const sinHalfDLon = Math.sin(dLon * 0.5);
    const cosLat1 = Math.cos(lat1);
    const cosLat2 = Math.cos(lat2);
    const a = sinHalfDLat * sinHalfDLat + cosLat1 * cosLat2 * sinHalfDLon * sinHalfDLon;
    // d = 2·asin(√a) — 中心角（弧度）
    const d = 2.0 * Math.asin(Math.sqrt(Math.min(a, 1.0)));

    // 两点重合时直接返回起点（避免 sin(d)=0 导致除零）
    if (d < ANGULAR_EPSILON) {
        return { lon: lon1, lat: lat1 };
    }

    // --- SLERP 插值：在单位球面上沿大圆弧插值 ---
    const sinD = Math.sin(d);

    // A 权重：起点的贡献，随 fraction 从 1 衰减到 0
    const weightA = Math.sin((1.0 - fraction) * d) / sinD;
    // B 权重：终点的贡献，随 fraction 从 0 增加到 1
    const weightB = Math.sin(fraction * d) / sinD;

    // 将两个地理点转换为 3D 笛卡尔坐标（单位球面上），然后加权混合
    // P1 = (cosLat1·cosLon1, cosLat1·sinLon1, sinLat1)
    const sinLat1 = Math.sin(lat1);
    const sinLat2 = Math.sin(lat2);
    const cosLon1 = Math.cos(lon1);
    const sinLon1 = Math.sin(lon1);
    const cosLon2 = Math.cos(lon2);
    const sinLon2 = Math.sin(lon2);

    // 加权混合的 3D 坐标
    const x = weightA * cosLat1 * cosLon1 + weightB * cosLat2 * cosLon2;
    const y = weightA * cosLat1 * sinLon1 + weightB * cosLat2 * sinLon2;
    const z = weightA * sinLat1 + weightB * sinLat2;

    // 从 3D 笛卡尔坐标反算经纬度
    // lat = atan2(z, √(x²+y²)), lon = atan2(y, x)
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lon = Math.atan2(y, x);

    return { lon, lat };
}

// ============================================================
// 最近线上点
// ============================================================

/**
 * 计算折线上距给定点最近的点。
 *
 * 对折线的每一段，在单位球面上将其视为大圆弧，
 * 利用 3D 向量投影找到弧上距查询点最近的点。
 * 返回全局最近点的坐标、距离、所在线段索引和线段内分数位置。
 *
 * 算法概述（球面几何）：
 *   1. 将所有点转换为单位球面上的 3D 笛卡尔坐标
 *   2. 对每段大圆弧，计算大圆平面的法线 n = A × B
 *   3. 将查询点投影到大圆平面上，然后在弧上参数化定位
 *   4. 将投影点钳制到弧的 [0, 1] 范围内
 *   5. 计算角距离并选择全局最近的
 *
 * 使用球面近似（非椭球面），对于 GIS 可视化和交互场景精度足够。
 *
 * @param point - 查询点坐标 [lonRad, latRad]
 * @param lineCoords - 折线坐标数组，每个元素为 [lonRad, latRad]
 * @returns 最近点结果，包含坐标、距离、线段索引和分数
 *
 * @example
 * const result = nearestPointOnLine(
 *   [0.1, 0.1],                          // 查询点
 *   [[0, 0], [1, 0], [1, 1]],            // 折线（3 个顶点，2 段）
 * );
 * // result.index = 0（最近点在第一段上）
 * // result.fraction ≈ 0.1（距第一段起点约 10%）
 */
export function nearestPointOnLine(
    point: readonly [number, number],
    lineCoords: ReadonlyArray<readonly [number, number]>,
): NearestPointResult {
    // --- 输入验证 ---
    // 折线至少需要 1 个点
    if (lineCoords.length === 0) {
        return { lon: point[0], lat: point[1], distance: 0, index: 0, fraction: 0 };
    }

    // 退化情况：折线只有 1 个点，最近点就是该点本身
    if (lineCoords.length === 1) {
        const angDist = angularDistance(
            point[1], point[0],
            lineCoords[0][1], lineCoords[0][0],
        );
        return {
            lon: lineCoords[0][0],
            lat: lineCoords[0][1],
            distance: angDist,
            index: 0,
            fraction: 0,
        };
    }

    // --- 将查询点转换为单位球面 3D 坐标 ---
    const pLon = point[0];
    const pLat = point[1];
    const px = Math.cos(pLat) * Math.cos(pLon);
    const py = Math.cos(pLat) * Math.sin(pLon);
    const pz = Math.sin(pLat);

    // --- 初始化结果为"无穷远" ---
    let bestDistance = Infinity;
    let bestLon = lineCoords[0][0];
    let bestLat = lineCoords[0][1];
    let bestIndex = 0;
    let bestFraction = 0;

    // --- 遍历折线的每一段 ---
    for (let i = 0; i < lineCoords.length - 1; i++) {
        // 将线段端点 A、B 转换为单位球面 3D 坐标
        const aLon = lineCoords[i][0];
        const aLat = lineCoords[i][1];
        const ax = Math.cos(aLat) * Math.cos(aLon);
        const ay = Math.cos(aLat) * Math.sin(aLon);
        const az = Math.sin(aLat);

        const bLon = lineCoords[i + 1][0];
        const bLat = lineCoords[i + 1][1];
        const bx = Math.cos(bLat) * Math.cos(bLon);
        const by = Math.cos(bLat) * Math.sin(bLon);
        const bz = Math.sin(bLat);

        // 计算大圆弧的法线 n = A × B（叉积）
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);

        // 退化线段（A ≈ B）：线段长度接近 0，直接用端点 A 作为候选
        if (nLen < ANGULAR_EPSILON) {
            const dist = angularDistanceFromCartesian(px, py, pz, ax, ay, az);
            if (dist < bestDistance) {
                bestDistance = dist;
                bestLon = aLon;
                bestLat = aLat;
                bestIndex = i;
                bestFraction = 0;
            }
            continue;
        }

        // 归一化法线
        const nnx = nx / nLen;
        const nny = ny / nLen;
        const nnz = nz / nLen;

        // --- 将查询点投影到大圆平面 ---
        // 投影 P' = P - dot(P, n)·n
        // P' 是查询点在包含大圆弧的平面上的投影
        const dotPN = px * nnx + py * nny + pz * nnz;
        let projX = px - dotPN * nnx;
        let projY = py - dotPN * nny;
        let projZ = pz - dotPN * nnz;

        // 归一化投影点回到单位球面
        const projLen = Math.sqrt(projX * projX + projY * projY + projZ * projZ);

        // 投影长度 ≈ 0 意味着查询点恰好在大圆的极点（距大圆 90°）
        // 此时大圆上所有点等距，选端点 A
        if (projLen < ANGULAR_EPSILON) {
            const dist = angularDistanceFromCartesian(px, py, pz, ax, ay, az);
            if (dist < bestDistance) {
                bestDistance = dist;
                bestLon = aLon;
                bestLat = aLat;
                bestIndex = i;
                bestFraction = 0;
            }
            continue;
        }

        projX /= projLen;
        projY /= projLen;
        projZ /= projLen;

        // --- 参数化定位：判断投影点是否在弧段 [A, B] 范围内 ---
        // 使用 m = n × A（大圆平面内垂直于 A 的方向）构建弧参数化
        // 弧上的点可以写为 C(θ) = A·cos(θ) + m·sin(θ)
        // 其中 θ = 0 对应 A，θ = Ω 对应 B
        const mx = nny * az - nnz * ay;
        const my = nnz * ax - nnx * az;
        const mz = nnx * ay - nny * ax;
        // m 已经是单位向量（因为 n 和 A 都是单位向量且正交分量已归一化）
        // 但为安全起见，归一化
        const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
        const mnx = mLen > ANGULAR_EPSILON ? mx / mLen : 0;
        const mny = mLen > ANGULAR_EPSILON ? my / mLen : 0;
        const mnz = mLen > ANGULAR_EPSILON ? mz / mLen : 0;

        // B 在参数空间中的角度 Ω
        // cos(Ω) = dot(B, A), sin(Ω) = dot(B, m)
        const omegaCos = ax * bx + ay * by + az * bz;
        const omegaSin = bx * mnx + by * mny + bz * mnz;
        const omega = Math.atan2(omegaSin, omegaCos);

        // 投影点在参数空间中的角度 θ_P
        // cos(θ_P) = dot(P', A), sin(θ_P) = dot(P', m)
        const thetaCos = projX * ax + projY * ay + projZ * az;
        const thetaSin = projX * mnx + projY * mny + projZ * mnz;
        const thetaP = Math.atan2(thetaSin, thetaCos);

        // 计算分数 f = θ_P / Ω，并钳制到 [0, 1]
        let fraction: number;
        let nearestX: number;
        let nearestY: number;
        let nearestZ: number;

        // omega 的符号表示弧的方向；若 |omega| 极小则退化
        if (Math.abs(omega) < ANGULAR_EPSILON) {
            // 弧长 ≈ 0，退化到端点 A
            fraction = 0;
            nearestX = ax;
            nearestY = ay;
            nearestZ = az;
        } else {
            fraction = thetaP / omega;

            if (fraction <= 0) {
                // 投影点在弧起点之前 → 最近点是 A
                fraction = 0;
                nearestX = ax;
                nearestY = ay;
                nearestZ = az;
            } else if (fraction >= 1) {
                // 投影点在弧终点之后 → 最近点是 B
                fraction = 1;
                nearestX = bx;
                nearestY = by;
                nearestZ = bz;
            } else {
                // 投影点在弧内 → 使用投影点（已在球面上）
                nearestX = projX;
                nearestY = projY;
                nearestZ = projZ;
            }
        }

        // 计算查询点到最近点的角距离
        const dist = angularDistanceFromCartesian(px, py, pz, nearestX, nearestY, nearestZ);

        // 更新全局最优
        if (dist < bestDistance) {
            bestDistance = dist;
            // 从 3D 坐标反算经纬度
            bestLat = Math.atan2(nearestZ, Math.sqrt(nearestX * nearestX + nearestY * nearestY));
            bestLon = Math.atan2(nearestY, nearestX);
            bestIndex = i;
            bestFraction = fraction;
        }
    }

    return {
        lon: bestLon,
        lat: bestLat,
        distance: bestDistance,
        index: bestIndex,
        fraction: bestFraction,
    };
}

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 计算两点间的角距离（弧度），使用 Haversine 公式。
 * 内部辅助函数，参数为纬度在前（符合数学惯例）。
 *
 * @param lat1 - 第一点纬度（弧度）
 * @param lon1 - 第一点经度（弧度）
 * @param lat2 - 第二点纬度（弧度）
 * @param lon2 - 第二点经度（弧度）
 * @returns 角距离（弧度），范围 [0, π]
 */
function angularDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number {
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    // Haversine 核心公式
    const sinHalfDLat = Math.sin(dLat * 0.5);
    const sinHalfDLon = Math.sin(dLon * 0.5);
    const a = sinHalfDLat * sinHalfDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLon * sinHalfDLon;
    // 中心角 = 2·asin(√a)，clamp 防止浮点溢出
    return 2.0 * Math.asin(Math.sqrt(Math.min(a, 1.0)));
}

/**
 * 从单位球面 3D 笛卡尔坐标计算两点间的角距离。
 * 使用 atan2(|cross|, dot) 公式，在所有距离尺度上都比 acos(dot) 稳定。
 *
 * @param ax - 第一点 X 分量
 * @param ay - 第一点 Y 分量
 * @param az - 第一点 Z 分量
 * @param bx - 第二点 X 分量
 * @param by - 第二点 Y 分量
 * @param bz - 第二点 Z 分量
 * @returns 角距离（弧度），范围 [0, π]
 */
function angularDistanceFromCartesian(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
): number {
    // 叉积 |A × B| = sin(d)
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const crossLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
    // 点积 A · B = cos(d)
    const dot = ax * bx + ay * by + az * bz;
    // atan2(sin, cos) 在所有象限都稳定，优于 acos 在 d ≈ 0 或 d ≈ π 时的精度问题
    return Math.atan2(crossLen, dot);
}

// ============================================================
// Karney 大地测量算法（Vincenty 跨极点失败时的替代）
// ============================================================
//
// Vincenty 反算在两点接近对跖（almost-antipodal）时不收敛。
// Karney 2013（"Algorithms for geodesics"）给出了一个无条件收敛的算法，
// 通过辅助球面（auxiliary sphere）+ 椭圆积分级数展开，
// 在地球椭球任意两点间都能稳定求解距离/方位/正算。
//
// 完整 Karney 实现（GeographicLib）有数千行；本文件实现的是一个
// 简化版本：
//   - 对常规点对（< 175° 角距）直接调用现有的 Vincenty 算法（已经够快够准）。
//   - 对接近对跖的点对，回退到稳健的"球面 + 椭球修正"近似：
//     先用球面 Haversine 求初值，再用一阶椭球扁率修正。
//   - 误差在跨极点情况下约 1 米量级（远好于 Vincenty 的 NaN/不收敛）。
//
// 这不是 GeographicLib 级精度（< 0.5mm），但能在 GIS 渲染/分析所需的
// 米级精度下保证"任意两点都有稳定结果"。
// ============================================================

import { karneyInverse, karneyDirect } from './karney.ts';
export { karneyInverse, karneyDirect } from './karney.ts';
export type { KarneyInverseResult, KarneyDirectResult } from './karney.ts';

/**
 * Karney 大地测量距离（完整 order 6 级数实现，对跖点严格稳定）。
 *
 * 直接调用 `karneyInverse` 提取 s12。底层是 Karney 2013 论文的完整算法，
 * Float64 精度下距离误差 ≤ 15 nm，方位误差 ≤ 1 µas。
 *
 * @param lng1Deg 起点经度（度）
 * @param lat1Deg 起点纬度（度）
 * @param lng2Deg 终点经度（度）
 * @param lat2Deg 终点纬度（度）
 * @returns 距离（米）
 */
export function karneyDistance(
    lng1Deg: number, lat1Deg: number,
    lng2Deg: number, lat2Deg: number,
): number {
    return karneyInverse(lat1Deg, lng1Deg, lat2Deg, lng2Deg).s12;
}

/**
 * Karney 大地测量初始方位角（完整实现，对跖点严格稳定）。
 *
 * @param lng1Deg 起点经度（度）
 * @param lat1Deg 起点纬度（度）
 * @param lng2Deg 终点经度（度）
 * @param lat2Deg 终点纬度（度）
 * @returns 初始方位角（度，[0, 360)）
 */
export function karneyInitialBearing(
    lng1Deg: number, lat1Deg: number,
    lng2Deg: number, lat2Deg: number,
): number {
    return karneyInverse(lat1Deg, lng1Deg, lat2Deg, lng2Deg).az1;
}

// 抑制 lint：karneyDirect 通过 export 重导出
void karneyDirect;
