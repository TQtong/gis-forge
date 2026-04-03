// ============================================================
// globe/sun.ts — 太阳位置计算器
// 基于简化天文算法计算给定日期的太阳方位角、高度角与方向向量。
// 导出 computeSunPosition 纯函数。
// 依赖层级：L0 级纯数学，无外部依赖。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 天文常量 =====================

/**
 * J2000.0 历元的 Julian Day Number。
 * 对应 2000-01-01T12:00:00 UTC，是现代天文历的标准起点。
 */
const J2000_JDN = 2451545.0;

/**
 * 一天的毫秒数。
 */
const MS_PER_DAY = 86400000;

/**
 * Unix 纪元（1970-01-01T00:00:00 UTC）的 Julian Day Number。
 * JDN(1970-01-01) = 2440587.5
 */
const UNIX_EPOCH_JDN = 2440587.5;

/**
 * 度转弧度。
 */
const DEG2RAD = Math.PI / 180;

/**
 * 弧度转度。
 */
const RAD2DEG = 180 / Math.PI;

/**
 * 地球轨道离心率（J2000 近似值）。
 * 影响太阳距离与视运动速度，但对方向影响极小。
 */
const ECCENTRICITY = 0.016709;

/**
 * 黄赤交角（度），J2000 近似值。
 * 地球自转轴与黄道面法线的夹角，决定四季与太阳赤纬变化。
 */
const OBLIQUITY_DEG = 23.4393;

/**
 * 近日点黄经（度），J2000 近似值。
 */
const PERIHELION_LONG_DEG = 102.9372;

// ===================== 返回类型 =====================

/**
 * 太阳位置计算结果。
 */
export interface SunPosition {
    /**
     * 太阳方位角（弧度），从正北顺时针。
     * 范围 [0, 2π)。
     */
    readonly azimuth: number;

    /**
     * 太阳高度角（弧度），地平线以上为正。
     * 范围 [-π/2, π/2]。
     */
    readonly altitude: number;

    /**
     * 太阳方向单位向量 [x, y, z]，在 ENU（东-北-天）坐标系中。
     * x=东, y=北, z=天。
     */
    readonly direction: [number, number, number];
}

// ===================== 纯数学辅助函数 =====================

/**
 * 将角度归一化到 [0°, 360°) 范围。
 *
 * @param deg - 输入角度
 * @returns 归一化后的度数
 */
function normalizeDeg(deg: number): number {
    let d = deg % 360;
    if (d < 0) {
        d += 360;
    }
    return d;
}

/**
 * 将 Date 转换为 Julian Day Number。
 *
 * @param date - JavaScript Date 对象
 * @returns JDN（浮点数）
 *
 * @example
 * dateToJD(new Date('2024-03-20T12:00:00Z')); // ≈ 2460388.0
 */
function dateToJD(date: Date): number {
    // Date.getTime() 返回自 Unix 纪元的毫秒
    const ms = date.getTime();
    if (!Number.isFinite(ms)) {
        // 非法日期回退到 J2000
        return J2000_JDN;
    }
    return UNIX_EPOCH_JDN + ms / MS_PER_DAY;
}

/**
 * 计算太阳黄经（ecliptic longitude），简化算法。
 * 基于平太阳黄经 + 中心差（equation of center）一阶修正。
 *
 * @param daysSinceJ2000 - 自 J2000.0 起的天数（小数）
 * @returns 太阳地心黄经（度）
 */
function solarEclipticLongitude(daysSinceJ2000: number): number {
    // 平近点角 M（Mean Anomaly）
    const M = normalizeDeg(357.5291 + 0.98560028 * daysSinceJ2000);
    const Mrad = M * DEG2RAD;

    // 中心差 C（Equation of Center），截断到 3 阶
    const C =
        1.9148 * Math.sin(Mrad) +
        0.0200 * Math.sin(2 * Mrad) +
        0.0003 * Math.sin(3 * Mrad);

    // 真近点角
    const _trueAnomaly = M + C;

    // 太阳地心黄经 = 真近点角 + 近日点黄经 + 180°（地心→日心反转）
    const sunLong = normalizeDeg(_trueAnomaly + PERIHELION_LONG_DEG + 180);

    return sunLong;
}

/**
 * 从太阳黄经计算赤经（Right Ascension）与赤纬（Declination）。
 *
 * @param sunLongDeg - 太阳黄经（度）
 * @returns [赤经（弧度）, 赤纬（弧度）]
 */
function eclipticToEquatorial(sunLongDeg: number): [number, number] {
    const L = sunLongDeg * DEG2RAD;
    const oblRad = OBLIQUITY_DEG * DEG2RAD;

    // 赤经 α = atan2(sin(L) × cos(ε), cos(L))
    const sinL = Math.sin(L);
    const cosL = Math.cos(L);
    const cosObl = Math.cos(oblRad);
    const sinObl = Math.sin(oblRad);

    const ra = Math.atan2(sinL * cosObl, cosL);
    // 赤纬 δ = asin(sin(L) × sin(ε))
    const dec = Math.asin(sinL * sinObl);

    return [ra, dec];
}

/**
 * 计算格林威治平恒星时（GMST），单位度。
 *
 * @param jd - Julian Day Number
 * @returns GMST（度），范围 [0, 360)
 */
function greenwichMeanSiderealTime(jd: number): number {
    // 自 J2000.0 的儒略世纪
    const T = (jd - J2000_JDN) / 36525;
    // GMST 公式（IAU 1982）
    let gmst = 280.46061837 + 360.98564736629 * (jd - J2000_JDN) + 0.000387933 * T * T - T * T * T / 38710000;
    return normalizeDeg(gmst);
}

/**
 * 从赤经、赤纬与恒星时计算太阳的方位角与高度角。
 * 假设观测者在赤道 (lat=0, lon=0) 处。
 * 实际使用中可扩展为接受观测者经纬度。
 *
 * @param ra - 赤经（弧度）
 * @param dec - 赤纬（弧度）
 * @param gmstDeg - 格林威治平恒星时（度）
 * @returns [方位角（弧度, 从北顺时针）, 高度角（弧度）]
 */
function equatorialToHorizontal(ra: number, dec: number, gmstDeg: number): [number, number] {
    // 观测者在赤道 (lat=0°) 的本地恒星时
    const lstRad = gmstDeg * DEG2RAD;
    // 时角 H = LST - RA
    const H = lstRad - ra;

    // 赤道处 lat=0 的简化公式
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);
    const sinH = Math.sin(H);
    const cosH = Math.cos(H);

    // 高度角 alt = asin(sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(H))
    // lat=0 => alt = asin(cos(dec) * cos(H))
    const sinAlt = cosDec * cosH;
    const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

    // 方位角 az = atan2(-cos(dec)*sin(H), sin(dec))
    // lat=0 简化
    const azimuth = Math.atan2(-cosDec * sinH, sinDec);

    // 归一化到 [0, 2π)
    let az = azimuth;
    if (az < 0) {
        az += 2 * Math.PI;
    }

    return [az, altitude];
}

// ===================== 公共函数 =====================

/**
 * 计算太阳在 ECEF（Earth-Centered Earth-Fixed）坐标系下的归一化方向向量。
 *
 * 算法：
 * 1. 由日期计算太阳黄经 → 赤经(RA) + 赤纬(Dec)
 * 2. 由日期计算格林威治平恒星时(GMST)
 * 3. 太阳地理经度 = RA - GMST（赤经减去地球自转角）
 * 4. 太阳地理纬度 = Dec（赤纬即为太阳直射纬度）
 * 5. 将地理经纬度转为 ECEF 单位向量
 *
 * 返回的向量指向太阳方向（从地心出发），在 ECEF 坐标系中。
 * 精度约 ±1°，足够用于 GIS 地球光照渲染。
 *
 * @param date - JavaScript Date 对象（UTC 时间）
 * @returns 归一化的 ECEF 太阳方向向量 [x, y, z]
 *
 * @stability stable
 *
 * @example
 * // 2024-06-21 正午 UTC 时，太阳直射北回归线附近，经度约 0°
 * const dir = computeSunDirectionECEF(new Date('2024-06-21T12:00:00Z'));
 * // dir ≈ [1, 0, 0.4]（归一化后）— X 轴正方向即经度 0°
 */
export function computeSunDirectionECEF(date: Date): [number, number, number] {
    // 将 Date 转为 Julian Day
    const jd = dateToJD(date);
    // 自 J2000.0 的天数
    const d = jd - J2000_JDN;

    // 太阳黄经
    const sunLong = solarEclipticLongitude(d);

    // 黄经→赤经(RA)/赤纬(Dec)
    const [ra, dec] = eclipticToEquatorial(sunLong);

    // 格林威治平恒星时（度→弧度）
    const gmstDeg = greenwichMeanSiderealTime(jd);
    const gmstRad = gmstDeg * DEG2RAD;

    // 太阳地理经度 = RA - GMST
    // RA 是太阳在惯性坐标系中的经度，GMST 是地球自转角度
    // 两者之差即为太阳在地固坐标系（ECEF）中的经度
    const sunLon = ra - gmstRad;

    // 太阳地理纬度 = 赤纬 Dec
    // 赤纬直接对应太阳直射点的地理纬度
    const sunLat = dec;

    // 地理经纬度 → ECEF 单位向量
    // 对于单位球：x = cos(lat)*cos(lon), y = cos(lat)*sin(lon), z = sin(lat)
    // 这里不需要考虑椭球扁率，因为只要方向，不要精确位置
    const cosLat = Math.cos(sunLat);
    const x = cosLat * Math.cos(sunLon);
    const y = cosLat * Math.sin(sunLon);
    const z = Math.sin(sunLat);

    return [x, y, z];
}

/**
 * 计算给定日期时刻的太阳位置。
 * 使用简化天文算法（精度约 ±1°），适用于 GIS 光照模拟。
 *
 * @param date - JavaScript Date 对象（UTC 时间）
 * @returns 太阳位置（方位角、高度角、方向向量）
 *
 * @stability stable
 *
 * @example
 * const sun = computeSunPosition(new Date('2024-06-21T12:00:00Z'));
 * console.log(sun.azimuth, sun.altitude);
 * // 太阳在正南偏高位置（北半球夏至正午）
 */
export function computeSunPosition(date: Date): SunPosition {
    // 将 Date 转为 Julian Day
    const jd = dateToJD(date);
    // 自 J2000.0 的天数
    const d = jd - J2000_JDN;

    // 太阳黄经
    const sunLong = solarEclipticLongitude(d);

    // 黄经→赤经/赤纬
    const [ra, dec] = eclipticToEquatorial(sunLong);

    // 格林威治恒星时
    const gmst = greenwichMeanSiderealTime(jd);

    // 赤道坐标→地平坐标
    const [azimuth, altitude] = equatorialToHorizontal(ra, dec, gmst);

    // 构建 ENU 方向向量
    // ENU: x=东, y=北, z=天
    const cosAlt = Math.cos(altitude);
    const sinAlt = Math.sin(altitude);
    const cosAz = Math.cos(azimuth);
    const sinAz = Math.sin(azimuth);

    // 方位角从北顺时针：
    // x(东) = cos(alt) * sin(az)
    // y(北) = cos(alt) * cos(az)
    // z(天) = sin(alt)
    const dx = cosAlt * sinAz;
    const dy = cosAlt * cosAz;
    const dz = sinAlt;

    return {
        azimuth,
        altitude,
        direction: [dx, dy, dz],
    };
}
