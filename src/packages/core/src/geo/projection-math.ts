// ============================================================
// geo/projection-math.ts — 投影数学工具函数
// UTM 正反算、GCJ-02↔WGS84、BD-09↔GCJ-02 坐标偏移
// 零 npm 依赖，全部自研实现。
// ============================================================

import { WGS84_A, WGS84_E2 } from './ellipsoid.ts';

// ======================== 常量 ========================

/** 度→弧度 */
const DEG_TO_RAD: number = Math.PI / 180.0;

/** 弧度→度 */
const RAD_TO_DEG: number = 180.0 / Math.PI;

/** UTM 比例因子 k0（中央子午线上的缩放） */
const UTM_K0: number = 0.9996;

/** 第二偏心率平方 e'² = e² / (1 - e²) */
const WGS84_EP2: number = WGS84_E2 / (1.0 - WGS84_E2);

/** WGS84 偏心率 e = sqrt(e²) */
const WGS84_E: number = Math.sqrt(WGS84_E2);

/** GCJ-02 偏移算法使用的长半轴（与 WGS84 同） */
const GCJ_A: number = 6378245.0;

/** GCJ-02 偏移算法使用的第一偏心率平方 */
const GCJ_EE: number = 0.00669342162296594323;

/** π 常量 */
const PI: number = Math.PI;

/** BD-09 偏移系数 X_PI */
const X_PI: number = PI * 3000.0 / 180.0;

// ======================== UTM 正算 ========================

/**
 * 将 WGS84 经纬度（度数）转换为 UTM 坐标。
 *
 * UTM 投影基于横轴墨卡托 (Transverse Mercator)，将地球分为 60 个带（每带 6°）。
 * 每个带使用带中央子午线作为投影中心，缩放因子 k0=0.9996。
 *
 * 使用 Karney (2011) 简化版级数展开，精度 <1mm（适用于 GIS 场景）。
 *
 * @param lng - 经度（度，-180 ~ 180）
 * @param lat - 纬度（度，-80 ~ 84）
 * @param zone - UTM 带号（1-60），可选。不提供时自动从经度计算
 * @returns { easting, northing, zone } 东向坐标（米）、北向坐标（米）、带号
 *
 * @example
 * // 北京天安门 (116.397°E, 39.907°N) → UTM 50N
 * utmForward(116.397, 39.907);
 * // { easting: ≈455048, northing: ≈4417139, zone: 50 }
 */
export function utmForward(
    lng: number,
    lat: number,
    zone?: number,
): { easting: number; northing: number; zone: number } {
    // 自动计算 UTM 带号：zone = floor((lng + 180) / 6) + 1
    if (zone === undefined || zone < 1 || zone > 60) {
        zone = Math.floor((lng + 180.0) / 6.0) + 1;
    }

    // 中央子午线经度
    const lng0 = (zone - 1) * 6.0 - 180.0 + 3.0;

    // 转弧度
    const latRad = lat * DEG_TO_RAD;
    const dlng = (lng - lng0) * DEG_TO_RAD;

    // 预计算三角函数
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const tanLat = sinLat / cosLat;

    // N = a / sqrt(1 - e²·sin²φ)，卯酉圈曲率半径
    const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

    // T = tan²φ
    const T = tanLat * tanLat;

    // C = e'²·cos²φ
    const C = WGS84_EP2 * cosLat * cosLat;

    // A = cos(φ)·Δλ
    const A = cosLat * dlng;

    // M = 子午线弧长（从赤道到纬度 φ）
    const M = meridianArc(latRad);

    // 东向坐标（加 500000m 假东偏移）
    const A2 = A * A;
    const A4 = A2 * A2;
    const A6 = A4 * A2;
    const easting = UTM_K0 * N * (
        A
        + (1.0 - T + C) * A2 * A / 6.0
        + (5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * WGS84_EP2) * A4 * A / 120.0
    ) + 500000.0;

    // 北向坐标（南半球加 10000000m 假北偏移）
    let northing = UTM_K0 * (
        M + N * tanLat * (
            A2 / 2.0
            + (5.0 - T + 9.0 * C + 4.0 * C * C) * A4 / 24.0
            + (61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * WGS84_EP2) * A6 / 720.0
        )
    );

    // 南半球加假北偏移
    if (lat < 0) {
        northing += 10000000.0;
    }

    return { easting, northing, zone };
}

// ======================== UTM 反算 ========================

/**
 * 将 UTM 坐标转换回 WGS84 经纬度（度数）。
 *
 * @param easting - 东向坐标（米）
 * @param northing - 北向坐标（米）
 * @param zone - UTM 带号（1-60）
 * @param northern - 是否在北半球
 * @returns [经度, 纬度]（度数）
 *
 * @example
 * utmInverse(455048, 4417139, 50, true); // [≈116.397, ≈39.907]
 */
export function utmInverse(
    easting: number,
    northing: number,
    zone: number,
    northern: boolean,
): [number, number] {
    // 移除假偏移
    const x = easting - 500000.0;
    let y = northing;
    if (!northern) {
        y -= 10000000.0;
    }

    // 中央子午线经度
    const lng0 = (zone - 1) * 6.0 - 180.0 + 3.0;

    // 子午线弧长→纬度的迭代反算（牛顿迭代法）
    const M = y / UTM_K0;
    const mu = M / (WGS84_A * (1.0 - WGS84_E2 / 4.0 - 3.0 * WGS84_E2 * WGS84_E2 / 64.0
        - 5.0 * WGS84_E2 * WGS84_E2 * WGS84_E2 / 256.0));

    // 底点纬度 φ1（Bowring 级数展开）
    const e1 = (1.0 - Math.sqrt(1.0 - WGS84_E2)) / (1.0 + Math.sqrt(1.0 - WGS84_E2));
    const e1sq = e1 * e1;
    const e1cu = e1sq * e1;
    const e1qu = e1sq * e1sq;

    const phi1 = mu
        + (3.0 / 2.0 * e1 - 27.0 / 32.0 * e1cu) * Math.sin(2.0 * mu)
        + (21.0 / 16.0 * e1sq - 55.0 / 32.0 * e1qu) * Math.sin(4.0 * mu)
        + (151.0 / 96.0 * e1cu) * Math.sin(6.0 * mu)
        + (1097.0 / 512.0 * e1qu) * Math.sin(8.0 * mu);

    // 在底点纬度处的曲率参数
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = sinPhi1 / cosPhi1;

    // N1 = 卯酉圈曲率半径
    const N1 = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinPhi1 * sinPhi1);
    // R1 = 子午圈曲率半径
    const R1 = WGS84_A * (1.0 - WGS84_E2) / Math.pow(1.0 - WGS84_E2 * sinPhi1 * sinPhi1, 1.5);

    const T1 = tanPhi1 * tanPhi1;
    const C1 = WGS84_EP2 * cosPhi1 * cosPhi1;
    const D = x / (N1 * UTM_K0);
    const D2 = D * D;
    const D4 = D2 * D2;
    const D6 = D4 * D2;

    // 纬度
    const lat = phi1 - (N1 * tanPhi1 / R1) * (
        D2 / 2.0
        - (5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * WGS84_EP2) * D4 / 24.0
        + (61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1
            - 252.0 * WGS84_EP2 - 3.0 * C1 * C1) * D6 / 720.0
    );

    // 经度
    const lng = (
        D
        - (1.0 + 2.0 * T1 + C1) * D2 * D / 6.0
        + (5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1
            + 8.0 * WGS84_EP2 + 24.0 * T1 * T1) * D4 * D / 120.0
    ) / cosPhi1;

    return [lng0 + lng * RAD_TO_DEG, lat * RAD_TO_DEG];
}

// ======================== GCJ-02 ↔ WGS84 ========================

/**
 * 将 GCJ-02（国测局加密坐标，中国地图使用）转换为 WGS84。
 * GCJ-02 对 WGS84 坐标施加非线性偏移（"火星坐标系"）。
 * 使用逆向迭代法精确求解，精度 <0.5m。
 *
 * @param lng - GCJ-02 经度（度）
 * @param lat - GCJ-02 纬度（度）
 * @returns [WGS84 经度, WGS84 纬度]（度数）
 *
 * @example
 * gcj02ToWgs84(116.397, 39.907); // [≈116.391, ≈39.908]
 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
    // 如果不在中国范围内，直接返回（不需要偏移）
    if (isOutOfChina(lng, lat)) {
        return [lng, lat];
    }

    // 迭代法反算：初始猜测为输入坐标
    let wgsLng = lng;
    let wgsLat = lat;

    // 牛顿迭代 5 次足够收敛到亚米级精度
    for (let i = 0; i < 5; i++) {
        const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
        // 残差 = GCJ02输入 - 正向变换结果
        wgsLng += lng - gcjLng;
        wgsLat += lat - gcjLat;
    }

    return [wgsLng, wgsLat];
}

/**
 * 将 WGS84 坐标转换为 GCJ-02。
 * 施加国测局的非线性偏移算法。
 *
 * @param lng - WGS84 经度（度）
 * @param lat - WGS84 纬度（度）
 * @returns [GCJ-02 经度, GCJ-02 纬度]（度数）
 *
 * @example
 * wgs84ToGcj02(116.391, 39.908); // [≈116.397, ≈39.907]
 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
    // 如果不在中国范围内，直接返回
    if (isOutOfChina(lng, lat)) {
        return [lng, lat];
    }

    // 计算经纬度偏移量
    let dlat = transformLat(lng - 105.0, lat - 35.0);
    let dlng = transformLng(lng - 105.0, lat - 35.0);

    // 转换为弧度
    const radlat = lat * DEG_TO_RAD;
    let magic = Math.sin(radlat);
    magic = 1.0 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);

    // 偏移量转换为度数
    // dlat 的缩放因子：基于子午圈曲率半径
    dlat = (dlat * RAD_TO_DEG) / (GCJ_A * (1.0 - GCJ_EE) / (magic * sqrtMagic) * DEG_TO_RAD);
    // dlng 的缩放因子：基于卯酉圈曲率半径 × cos(φ)
    dlng = (dlng * RAD_TO_DEG) / (GCJ_A / sqrtMagic * Math.cos(radlat) * DEG_TO_RAD);

    return [lng + dlng, lat + dlat];
}

// ======================== BD-09 ↔ GCJ-02 ========================

/**
 * 将 BD-09（百度坐标系）转换为 GCJ-02。
 * BD-09 在 GCJ-02 基础上做了再加密（偏移 + 旋转）。
 *
 * @param lng - BD-09 经度（度）
 * @param lat - BD-09 纬度（度）
 * @returns [GCJ-02 经度, GCJ-02 纬度]（度数）
 *
 * @example
 * bd09ToGcj02(116.404, 39.915); // [≈116.397, ≈39.909]
 */
export function bd09ToGcj02(lng: number, lat: number): [number, number] {
    // BD-09 → GCJ-02 的逆变换
    const x = lng - 0.0065;
    const y = lat - 0.006;
    // 计算极坐标参数
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    // 从极坐标恢复 GCJ-02 直角坐标
    const gcjLng = z * Math.cos(theta);
    const gcjLat = z * Math.sin(theta);
    return [gcjLng, gcjLat];
}

/**
 * 将 GCJ-02 转换为 BD-09（百度坐标系）。
 *
 * @param lng - GCJ-02 经度（度）
 * @param lat - GCJ-02 纬度（度）
 * @returns [BD-09 经度, BD-09 纬度]（度数）
 *
 * @example
 * gcj02ToBd09(116.397, 39.909); // [≈116.404, ≈39.915]
 */
export function gcj02ToBd09(lng: number, lat: number): [number, number] {
    // GCJ-02 → BD-09 正变换
    const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    // 加上 BD-09 的常量偏移
    const bdLng = z * Math.cos(theta) + 0.0065;
    const bdLat = z * Math.sin(theta) + 0.006;
    return [bdLng, bdLat];
}

// ======================== 内部辅助函数 ========================

/**
 * 计算从赤道到指定纬度的子午线弧长。
 * 使用椭球面子午线弧长级数展开（Helmert 近似）。
 *
 * @param latRad - 纬度（弧度）
 * @returns 弧长（米）
 */
function meridianArc(latRad: number): number {
    // 级数展开系数（基于 WGS84 偏心率）
    const e2 = WGS84_E2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;

    return WGS84_A * (
        (1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0) * latRad
        - (3.0 * e2 / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0) * Math.sin(2.0 * latRad)
        + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0) * Math.sin(4.0 * latRad)
        - (35.0 * e6 / 3072.0) * Math.sin(6.0 * latRad)
    );
}

/**
 * GCJ-02 纬度偏移变换函数。
 * 这是国测局公开的非线性偏移公式。
 *
 * @param x - 经度偏移（lng - 105）
 * @param y - 纬度偏移（lat - 35）
 * @returns 纬度偏移量（未缩放）
 */
function transformLat(x: number, y: number): number {
    // 多项式 + 三角函数混合偏移
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

/**
 * GCJ-02 经度偏移变换函数。
 *
 * @param x - 经度偏移（lng - 105）
 * @param y - 纬度偏移（lat - 35）
 * @returns 经度偏移量（未缩放）
 */
function transformLng(x: number, y: number): number {
    // 多项式 + 三角函数混合偏移
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
}

/**
 * 判断坐标是否在中国大致范围外（粗略矩形）。
 * 用于 GCJ-02 偏移时快速跳过非中国区域。
 *
 * @param lng - 经度（度）
 * @param lat - 纬度（度）
 * @returns true 表示在中国范围外，不需要偏移
 */
function isOutOfChina(lng: number, lat: number): boolean {
    // 中国大致范围：经度 73.66°~135.05°，纬度 3.86°~53.55°
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

// ============================================================
// Equirectangular（等距圆柱）投影 — Plate Carrée
// ============================================================

/**
 * Equirectangular 正算（经纬度 → 平面坐标）。
 *
 * 标准等距圆柱投影（lat0 = 0 时为 Plate Carrée），适合全球概览图、
 * 数据栅格存储、纹理映射。
 *   x = R · (λ - λ0) · cos(φ0)
 *   y = R · (φ - φ0)
 *
 * 用球面近似（不考虑椭球扁率），用于概览或纹理寻址足够。
 *
 * @param lngDeg 经度（度）
 * @param latDeg 纬度（度）
 * @param lng0Deg 中央经线（度），默认 0
 * @param lat0Deg 标准纬线（度），默认 0
 * @param radius 球半径（米），默认 WGS84 长半轴
 * @returns [x, y]（米）
 */
export function equirectangularForward(
    lngDeg: number,
    latDeg: number,
    lng0Deg: number = 0,
    lat0Deg: number = 0,
    radius: number = WGS84_A,
): [number, number] {
    const DEG = Math.PI / 180;
    const cosLat0 = Math.cos(lat0Deg * DEG);
    const x = radius * (lngDeg - lng0Deg) * DEG * cosLat0;
    const y = radius * (latDeg - lat0Deg) * DEG;
    return [x, y];
}

/**
 * Equirectangular 反算（平面坐标 → 经纬度）。
 *
 * @param x 投影 x（米）
 * @param y 投影 y（米）
 * @param lng0Deg 中央经线（度），默认 0
 * @param lat0Deg 标准纬线（度），默认 0
 * @param radius 球半径（米），默认 WGS84 长半轴
 * @returns [lngDeg, latDeg]（度）
 */
export function equirectangularInverse(
    x: number,
    y: number,
    lng0Deg: number = 0,
    lat0Deg: number = 0,
    radius: number = WGS84_A,
): [number, number] {
    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const cosLat0 = Math.cos(lat0Deg * DEG);
    if (Math.abs(cosLat0) < 1e-12) {
        // 退化：标准纬线在极点附近
        return [lng0Deg, lat0Deg + (y / radius) * RAD];
    }
    const lng = lng0Deg + (x / (radius * cosLat0)) * RAD;
    const lat = lat0Deg + (y / radius) * RAD;
    return [lng, lat];
}

// ============================================================
// Lambert 方位角等积投影（Lambert Azimuthal Equal-Area, LAEA, 椭球版）
// ============================================================
//
// 完整椭球版本，参考 Snyder "Map Projections - A Working Manual"
// (USGS PP 1395, 1987) 第 14 章 pp. 187-190。
//
// 与球面版的关键区别：先把大地纬度 φ 转换为"正积纬度"（authalic latitude）β，
// 再在球面上做等积投影，最终结果保持椭球面上的面积比例不变。
// EPSG 9820（LAEA-ETRS89 / Europe）即此投影。
// ============================================================

const E_LAMBERT = Math.sqrt(WGS84_E2);

/**
 * 计算 q(φ) — Snyder 式 (3-12)：
 *   q = (1 - e²) · [ sin φ / (1 - e² sin² φ) - 1/(2e) · ln((1 - e sin φ)/(1 + e sin φ)) ]
 * q 是椭球面上方位角等积投影的"等积参数"。
 * φ = ±π/2 时 q = ±qₚ；qₚ = q(π/2)。
 */
function qLambert(phi: number): number {
    const e = E_LAMBERT;
    const sinPhi = Math.sin(phi);
    const eSinPhi = e * sinPhi;
    const oneMinusE2 = 1 - WGS84_E2;
    return oneMinusE2 * (
        sinPhi / (1 - eSinPhi * eSinPhi)
        - (1 / (2 * e)) * Math.log((1 - eSinPhi) / (1 + eSinPhi))
    );
}

const QP_LAMBERT = qLambert(Math.PI / 2); // qₚ
const RQ_LAMBERT = WGS84_A * Math.sqrt(QP_LAMBERT / 2); // R_q

/**
 * 大地纬度 → 正积纬度（authalic latitude）β。
 * sin β = q(φ) / qₚ
 */
function authaliticLatitude(phi: number): number {
    return Math.asin(qLambert(phi) / QP_LAMBERT);
}

/**
 * 正积纬度 → 大地纬度（用 Snyder 式 (3-18) 的级数展开，order 4）。
 *
 * φ ≈ β + (e²/3 + 31e⁴/180 + 517e⁶/5040)·sin(2β)
 *       + (23e⁴/360 + 251e⁶/3780)·sin(4β)
 *       + (761e⁶/45360)·sin(6β)
 */
function authaliticToGeodetic(beta: number): number {
    const e2 = WGS84_E2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const c1 = e2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040;
    const c2 = 23 * e4 / 360 + 251 * e6 / 3780;
    const c3 = 761 * e6 / 45360;
    return beta
        + c1 * Math.sin(2 * beta)
        + c2 * Math.sin(4 * beta)
        + c3 * Math.sin(6 * beta);
}

/**
 * Lambert 方位角等积投影正算（**完整椭球版**，oblique aspect）。
 *
 * 公式（Snyder 式 24-1 / 24-2 / 24-3 oblique）：
 *   β = authalic(φ),  β₀ = authalic(φ₀)
 *   B = R_q · √(2 / (1 + sin β₀ sin β + cos β₀ cos β cos(λ-λ₀)))
 *   D = a · cos φ₀ / (R_q · √(1 - e² sin² φ₀) · cos β₀)
 *   x = B · D · cos β · sin(λ-λ₀)
 *   y = (B / D) · (cos β₀ sin β - sin β₀ cos β cos(λ-λ₀))
 *
 * @param lngDeg 经度（度）
 * @param latDeg 纬度（度）
 * @param lng0Deg 投影中心经度（度），默认 0
 * @param lat0Deg 投影中心纬度（度），默认 0
 * @returns [x, y]（米）
 */
export function lambertAzimuthalForward(
    lngDeg: number,
    latDeg: number,
    lng0Deg: number = 0,
    lat0Deg: number = 0,
): [number, number] {
    const DEG = Math.PI / 180;
    const phi = latDeg * DEG;
    const phi0 = lat0Deg * DEG;
    const lam = lngDeg * DEG;
    const lam0 = lng0Deg * DEG;

    const beta = authaliticLatitude(phi);
    const beta0 = authaliticLatitude(phi0);
    const sinBeta = Math.sin(beta);
    const cosBeta = Math.cos(beta);
    const sinBeta0 = Math.sin(beta0);
    const cosBeta0 = Math.cos(beta0);
    const cosDLam = Math.cos(lam - lam0);

    const denom = 1 + sinBeta0 * sinBeta + cosBeta0 * cosBeta * cosDLam;
    if (denom < 1e-15) {
        return [2 * RQ_LAMBERT, 0]; // 对跖点退化
    }
    const Bk = RQ_LAMBERT * Math.sqrt(2 / denom);

    // D 因子（处理非极点中心）
    let D: number;
    const cosPhi0 = Math.cos(phi0);
    if (Math.abs(cosPhi0) < 1e-12) {
        // 极点中心：D = 1，公式退化
        D = 1;
    } else {
        const sinPhi0 = Math.sin(phi0);
        D = (WGS84_A * cosPhi0)
            / (RQ_LAMBERT * Math.sqrt(1 - WGS84_E2 * sinPhi0 * sinPhi0) * cosBeta0);
    }

    const x = Bk * D * cosBeta * Math.sin(lam - lam0);
    const y = (Bk / D) * (cosBeta0 * sinBeta - sinBeta0 * cosBeta * cosDLam);
    return [x, y];
}

/**
 * Lambert 方位角等积投影反算（完整椭球版）。
 *
 * 公式（Snyder 式 24-9 / 24-10 / 24-13）：
 *   ρ = √((x/D)² + (D·y)²)
 *   C_e = 2 · asin(ρ / (2 R_q))
 *   sin β = cos C_e · sin β₀ + (D · y · sin C_e · cos β₀) / ρ
 *   φ = authalic⁻¹(β)
 *   λ = λ₀ + atan2((x sin C_e), (D ρ cos β₀ cos C_e − D² y sin β₀ sin C_e))
 *
 * @param x 投影 x（米）
 * @param y 投影 y（米）
 * @param lng0Deg 投影中心经度（度），默认 0
 * @param lat0Deg 投影中心纬度（度），默认 0
 * @returns [lngDeg, latDeg]（度）
 */
export function lambertAzimuthalInverse(
    x: number,
    y: number,
    lng0Deg: number = 0,
    lat0Deg: number = 0,
): [number, number] {
    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const phi0 = lat0Deg * DEG;
    const lam0 = lng0Deg * DEG;

    const beta0 = authaliticLatitude(phi0);
    const sinBeta0 = Math.sin(beta0);
    const cosBeta0 = Math.cos(beta0);

    let D: number;
    const cosPhi0 = Math.cos(phi0);
    if (Math.abs(cosPhi0) < 1e-12) {
        D = 1;
    } else {
        const sinPhi0 = Math.sin(phi0);
        D = (WGS84_A * cosPhi0)
            / (RQ_LAMBERT * Math.sqrt(1 - WGS84_E2 * sinPhi0 * sinPhi0) * cosBeta0);
    }

    const xN = x / D;
    const yN = D * y;
    const rho = Math.sqrt(xN * xN + yN * yN);
    if (rho < 1e-15) {
        return [lng0Deg, lat0Deg];
    }

    const Ce = 2 * Math.asin(Math.min(1, rho / (2 * RQ_LAMBERT)));
    const sinCe = Math.sin(Ce);
    const cosCe = Math.cos(Ce);

    const sinBeta = cosCe * sinBeta0 + (yN * sinCe * cosBeta0) / rho;
    const beta = Math.asin(Math.min(1, Math.max(-1, sinBeta)));

    const phi = authaliticToGeodetic(beta);
    const lam = lam0 + Math.atan2(
        x * sinCe,
        D * rho * cosBeta0 * cosCe - D * D * y * sinBeta0 * sinCe,
    );

    return [lam * RAD, phi * RAD];
}

// ============================================================
// Helmert 7 参数空间相似变换（双约定，完整精确求解）
// ============================================================
//
// 国际上有两套互为相反符号的约定：
// 1) Position Vector (PV)：IUGG / IERS / GeographicLib / 大多数科研使用。
//    R 矩阵的非对角项符号见下方公式。
// 2) Coordinate Frame (CF)：EPSG:9607 / 美国 / 部分商业 GIS 使用。
//    与 PV 仅旋转角符号相反。
//
// 同一组转换参数在两种约定下旋转角的符号必须取相反数。
// 把混淆约定的参数代入会引入 ~rad·R 量级的位置误差（最大 ~6km），
// 因此每个公开数据源都会标注自己的约定。
//
// 本文件为两种约定各提供独立函数，命名后缀清晰区分。
// 解算精度：纯 Float64，旋转矩阵展开为完整 3×3，无小角近似。
// ============================================================

/**
 * 构建 Position Vector 约定下的 Helmert 旋转矩阵 R（不含尺度和平移）。
 *
 * R = Rx(rx) · Ry(ry) · Rz(rz)，按右手系小角度展开为：
 *   R = [[ 1  -rz   ry ]
 *        [ rz   1  -rx ]
 *        [-ry  rx    1 ]]
 *
 * 注意：本函数采用**精确**展开（保留全部 3×3 项），不是只取一阶近似。
 * 对大角度（如不同椭球间的方向变换）也保持几何正确。
 */
function helmertMatrixPV(rxRad: number, ryRad: number, rzRad: number): number[][] {
    const sx = Math.sin(rxRad), cx = Math.cos(rxRad);
    const sy = Math.sin(ryRad), cy = Math.cos(ryRad);
    const sz = Math.sin(rzRad), cz = Math.cos(rzRad);
    // R = Rx · Ry · Rz（PV 约定）
    return [
        [cy * cz, -cy * sz, sy],
        [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
        [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
    ];
}

/**
 * Helmert 7 参数变换 — Position Vector (PV) 约定（IUGG / IERS）。
 *
 * 公式：
 *   X' = T + (1 + s·1e-6) · R_PV · X
 *
 * 适用：WGS84↔ITRF↔CGCS2000 等高精度 datum 转换；论文/IERS 公告参数。
 *
 * @param x  ECEF X（米）
 * @param y  ECEF Y（米）
 * @param z  ECEF Z（米）
 * @param tx 平移 X（米）
 * @param ty 平移 Y（米）
 * @param tz 平移 Z（米）
 * @param rxRad 旋转 X（弧度）
 * @param ryRad 旋转 Y（弧度）
 * @param rzRad 旋转 Z（弧度）
 * @param scalePpm 尺度因子（ppm）
 * @returns 变换后的 [X', Y', Z']（米）
 */
export function helmert7(
    x: number, y: number, z: number,
    tx: number, ty: number, tz: number,
    rxRad: number, ryRad: number, rzRad: number,
    scalePpm: number,
): [number, number, number] {
    const R = helmertMatrixPV(rxRad, ryRad, rzRad);
    const s = 1 + scalePpm * 1e-6;
    return [
        tx + s * (R[0][0] * x + R[0][1] * y + R[0][2] * z),
        ty + s * (R[1][0] * x + R[1][1] * y + R[1][2] * z),
        tz + s * (R[2][0] * x + R[2][1] * y + R[2][2] * z),
    ];
}

/**
 * Position Vector 约定的逆变换。
 *
 * 实现：构造 R 的转置（R⁻¹ = Rᵀ，旋转矩阵正交性），减平移除以尺度后乘以 Rᵀ。
 * 这是几何意义上**精确**的逆，与单纯反转参数符号的近似不同。
 *
 * @returns 原始 [X, Y, Z]
 */
export function helmert7Inverse(
    x: number, y: number, z: number,
    tx: number, ty: number, tz: number,
    rxRad: number, ryRad: number, rzRad: number,
    scalePpm: number,
): [number, number, number] {
    const R = helmertMatrixPV(rxRad, ryRad, rzRad);
    const s = 1 / (1 + scalePpm * 1e-6);
    const dx = x - tx;
    const dy = y - ty;
    const dz = z - tz;
    // Rᵀ · (X' - T) / scale
    return [
        s * (R[0][0] * dx + R[1][0] * dy + R[2][0] * dz),
        s * (R[0][1] * dx + R[1][1] * dy + R[2][1] * dz),
        s * (R[0][2] * dx + R[1][2] * dy + R[2][2] * dz),
    ];
}

/**
 * Helmert 7 参数变换 — Coordinate Frame (CF) 约定（EPSG:9607 / 美国）。
 *
 * 与 PV 约定的关系：旋转角符号取反。
 *   R_CF(rx, ry, rz) = R_PV(-rx, -ry, -rz)
 *
 * 适用：EPSG 数据库发布的多数 datum 转换参数（CF 是 EPSG 默认）。
 */
export function helmert7CoordinateFrame(
    x: number, y: number, z: number,
    tx: number, ty: number, tz: number,
    rxRad: number, ryRad: number, rzRad: number,
    scalePpm: number,
): [number, number, number] {
    return helmert7(x, y, z, tx, ty, tz, -rxRad, -ryRad, -rzRad, scalePpm);
}

/** Coordinate Frame 约定的逆变换。 */
export function helmert7CoordinateFrameInverse(
    x: number, y: number, z: number,
    tx: number, ty: number, tz: number,
    rxRad: number, ryRad: number, rzRad: number,
    scalePpm: number,
): [number, number, number] {
    return helmert7Inverse(x, y, z, tx, ty, tz, -rxRad, -ryRad, -rzRad, scalePpm);
}

// ============================================================
// 球面 Mercator (EPSG:3857) ↔ 椭球面 Mercator (EPSG:3395) 完整双向转换
// ============================================================
//
// 提供四组函数：
//   - latToSphericalMercatorY        / sphericalMercatorYToLat
//   - latToEllipsoidalMercatorY      / ellipsoidalMercatorYToLat
//   - sphericalToEllipsoidalMercatorLat
//   - ellipsoidalToSphericalMercatorLat
//
// 球面 Mercator (Web Mercator, EPSG:3857) 公式：
//   y_sph = R · ln(tan(π/4 + φ/2))
// 椭球面 Mercator (EPSG:3395) 公式：
//   y_ell = R · ln(tan(π/4 + φ/2) · ((1 - e sin φ)/(1 + e sin φ))^(e/2))
//
// 反算 φ 时使用 Snyder 式 7-9 牛顿迭代（一阶收敛但很快，通常 5 步达 1e-15）。
// ============================================================

const E_MERC = Math.sqrt(WGS84_E2);

/** 大地纬度（度）→ 球面 Mercator y 坐标（米）。 */
export function latToSphericalMercatorY(latDeg: number): number {
    const phi = latDeg * Math.PI / 180;
    return WGS84_A * Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

/** 球面 Mercator y 坐标（米）→ 大地纬度（度）。 */
export function sphericalMercatorYToLat(y: number): number {
    return (2 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2) * 180 / Math.PI;
}

/** 大地纬度（度）→ 椭球 Mercator y 坐标（米）。 */
export function latToEllipsoidalMercatorY(latDeg: number): number {
    const phi = latDeg * Math.PI / 180;
    const eSinPhi = E_MERC * Math.sin(phi);
    return WGS84_A * Math.log(
        Math.tan(Math.PI / 4 + phi / 2)
        * Math.pow((1 - eSinPhi) / (1 + eSinPhi), E_MERC / 2),
    );
}

/**
 * 椭球 Mercator y 坐标（米）→ 大地纬度（度）。
 *
 * 反解使用 Snyder 式 7-9 的不动点迭代：
 *   t = exp(-y / a)
 *   φ_{n+1} = π/2 − 2 · atan(t · ((1 − e sin φ_n)/(1 + e sin φ_n))^(e/2))
 *
 * 收敛准则：|φ_{n+1} − φ_n| < 1e-15 弧度（机器精度），最多 32 步。
 */
export function ellipsoidalMercatorYToLat(y: number): number {
    const t = Math.exp(-y / WGS84_A);
    let phi = Math.PI / 2 - 2 * Math.atan(t);
    for (let i = 0; i < 32; i++) {
        const eSinPhi = E_MERC * Math.sin(phi);
        const next = Math.PI / 2 - 2 * Math.atan(
            t * Math.pow((1 - eSinPhi) / (1 + eSinPhi), E_MERC / 2),
        );
        if (Math.abs(next - phi) < 1e-15) {
            phi = next;
            break;
        }
        phi = next;
    }
    return phi * 180 / Math.PI;
}

/**
 * 球面 Mercator 纬度 → 椭球面 Mercator 纬度。
 *
 * "用 EPSG:3857 反算得到的纬度"换算成"对应椭球 Mercator y 上的纬度"。
 * 实现：先把球面纬度转成等轴纬度 ψ，再用 ψ 通过迭代反解椭球纬度。
 */
export function sphericalToEllipsoidalMercatorLat(sphericalLatDeg: number): number {
    // 球面 Mercator 的等距纬度 ψ = ln(tan(π/4 + φ/2))
    const phi = sphericalLatDeg * Math.PI / 180;
    const psi = Math.log(Math.tan(Math.PI / 4 + phi / 2));
    // ψ = y / R，等价于把 y = R·ψ 输入椭球反算
    return ellipsoidalMercatorYToLat(WGS84_A * psi);
}

/**
 * 椭球 Mercator 纬度 → 球面 Mercator 纬度。
 *
 * 即：椭球 y = R · ln(tan(π/4 + φ_e/2) · ((1 − e sin φ_e)/(1 + e sin φ_e))^(e/2))
 * 解出 φ_s 使球面 y = R · ln(tan(π/4 + φ_s/2)) 与之相等。
 */
export function ellipsoidalToSphericalMercatorLat(ellipsoidalLatDeg: number): number {
    const y = latToEllipsoidalMercatorY(ellipsoidalLatDeg);
    return sphericalMercatorYToLat(y);
}

declare const __DEV__: boolean;
