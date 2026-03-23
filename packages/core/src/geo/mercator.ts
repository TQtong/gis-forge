/**
 * @module geo/mercator
 * @description Web Mercator (EPSG:3857) 投影纯数学实现——经纬度↔米、瓦片坐标、
 * 世界像素坐标、地面分辨率。所有经纬度参数使用**度数制**（用户侧 API）。
 * 零 npm 依赖，全部自研实现。
 */

import { WGS84_A } from './ellipsoid.ts';
import type { Vec2d } from './ellipsoid.ts';

// ============================================================
// BBox2D 类型 — 二维包围盒（经纬度范围或投影坐标范围）
// 正式定义位于 math/bbox.ts（尚未创建），此处提供前向定义供 geo 模块使用
// ============================================================

/**
 * 二维轴对齐包围盒，用于表示地理范围或投影坐标范围。
 * 字段名与地理方位对应：west/south 为最小值，east/north 为最大值。
 */
export interface BBox2D {
    /** 西边界（最小经度或最小 X），单位：度或米 */
    readonly west: number;
    /** 南边界（最小纬度或最小 Y），单位：度或米 */
    readonly south: number;
    /** 东边界（最大经度或最大 X），单位：度或米 */
    readonly east: number;
    /** 北边界（最大纬度或最大 Y），单位：度或米 */
    readonly north: number;
}

// ============================================================
// 瓦片坐标返回类型
// ============================================================

/**
 * 瓦片坐标，由 x（列）、y（行）、z（缩放级别）三元组表示。
 * 遵循 XYZ 瓦片编号约定（TMS 的 y 轴已翻转为 Web 标准）。
 */
export interface TileCoord {
    /** 瓦片列号，范围 [0, 2^z - 1]，向东递增 */
    readonly x: number;
    /** 瓦片行号，范围 [0, 2^z - 1]，向南递增（Web 约定，非 TMS） */
    readonly y: number;
    /** 缩放级别，整数，范围 [0, 30]（实际最大取决于数据源） */
    readonly z: number;
}

// ============================================================
// 常量定义
// ============================================================

/**
 * 默认瓦片尺寸（像素）。
 * 512×512 是现代矢量瓦片的标准尺寸（Mapbox GL / MapLibre GL）。
 * 比传统的 256 像素更高效：同等视觉效果下瓦片数量减半。
 */
export const TILE_SIZE: number = 512;

/**
 * 地球赤道周长（米）。
 * 由 WGS84 长半轴计算：C = 2π × a ≈ 40075016.686 米。
 * 这也是 Web Mercator 投影在缩放级别 0 时的世界宽度（米）。
 */
export const EARTH_CIRCUMFERENCE: number = 2.0 * Math.PI * WGS84_A;

/**
 * Web Mercator 投影的最大纬度（度）。
 * 超过此纬度，墨卡托投影 Y 值趋向无穷大。
 * 精确值 = atan(sinh(π)) × (180/π) ≈ 85.051128779806604°。
 * 这使得缩放级别 0 的世界地图是一个正方形。
 */
export const MAX_LATITUDE: number = 85.051128779806604;

// ============================================================
// 内部常量 — 度/弧度转换因子（避免函数内重复计算）
// ============================================================

/** 度转弧度乘数：π / 180 ≈ 0.017453292519943 */
const DEG_TO_RAD: number = Math.PI / 180.0;

/** 弧度转度乘数：180 / π ≈ 57.29577951308232 */
const RAD_TO_DEG: number = 180.0 / Math.PI;

/** 墨卡托 X 坐标的缩放因子：赤道周长 / 360°，即每度对应的米数 */
const METERS_PER_DEGREE: number = EARTH_CIRCUMFERENCE / 360.0;

// ============================================================
// 工具函数
// ============================================================

/**
 * 将纬度钳制（clamp）到 Web Mercator 有效范围 [-MAX_LATITUDE, +MAX_LATITUDE]。
 * 超出此范围的纬度会导致 Mercator Y 值趋向 ±∞。
 *
 * @param lat - 输入纬度（度）
 * @returns 钳制后的纬度（度），保证在 [-85.0511, +85.0511] 范围内
 *
 * @example
 * clampLatitude(90);   // → 85.051128779806604
 * clampLatitude(-90);  // → -85.051128779806604
 * clampLatitude(40);   // → 40（不变）
 */
export function clampLatitude(lat: number): number {
    // Math.max/min 组合实现双向钳制，比 if-else 更紧凑且 JIT 友好
    return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

// ============================================================
// 坐标转换函数
// ============================================================

/**
 * 将经纬度（度）转换为 Web Mercator 投影坐标（米）。
 *
 * X 方向：线性缩放，1° 经度 = (赤道周长 / 360) 米
 * Y 方向：非线性缩放，使用 Mercator 对数公式：
 *   Y = R · ln(tan(π/4 + φ/2))
 *
 * 纬度会被自动钳制到 [-85.0511°, +85.0511°] 范围。
 *
 * @param out - 预分配的 Float64Array(2) 输出，存储 [x_meters, y_meters]
 * @param lng - 经度（度），范围 [-180, 180]
 * @param lat - 纬度（度），范围 [-90, 90]（超出 MAX_LATITUDE 会被钳制）
 * @returns out 引用，便于链式调用
 *
 * @example
 * const m = new Float64Array(2);
 * lngLatToMercator(m, 0, 0);
 * // m ≈ [0, 0]  （原点在赤道与本初子午线交点）
 *
 * @example
 * const m2 = new Float64Array(2);
 * lngLatToMercator(m2, 180, 0);
 * // m2 ≈ [20037508.34, 0]  （赤道周长的一半）
 */
export function lngLatToMercator(out: Vec2d, lng: number, lat: number): Vec2d {
    // X = 经度 × (赤道周长 / 360)，线性映射
    out[0] = lng * METERS_PER_DEGREE;

    // 钳制纬度防止 tan 趋向无穷
    const clampedLat = clampLatitude(lat);

    // Y = R · ln(tan(π/4 + φ/2))
    // 其中 φ 是纬度（弧度），R 是 WGS84 长半轴
    // 这是 Mercator 投影的核心非线性变换：保角（等角）映射
    const latRad = clampedLat * DEG_TO_RAD;
    out[1] = WGS84_A * Math.log(Math.tan(Math.PI / 4.0 + latRad * 0.5));

    return out;
}

/**
 * 将 Web Mercator 投影坐标（米）转换回经纬度（度）。
 * 这是 {@link lngLatToMercator} 的逆运算。
 *
 * X → 经度：线性反算
 * Y → 纬度：逆 Mercator 公式，lat = 2·atan(exp(y/R)) - π/2
 *
 * @param out - 预分配的 Float64Array(2) 输出，存储 [lng_degrees, lat_degrees]
 * @param x - Mercator X 坐标（米）
 * @param y - Mercator Y 坐标（米）
 * @returns out 引用，便于链式调用
 *
 * @example
 * const ll = new Float64Array(2);
 * mercatorToLngLat(ll, 0, 0);
 * // ll ≈ [0, 0]
 *
 * @example
 * const ll2 = new Float64Array(2);
 * mercatorToLngLat(ll2, 20037508.342789244, 0);
 * // ll2 ≈ [180, 0]
 */
export function mercatorToLngLat(out: Vec2d, x: number, y: number): Vec2d {
    // 经度 = X / (赤道周长 / 360)，线性反算
    out[0] = x / METERS_PER_DEGREE;

    // 纬度 = (2·atan(exp(Y/R)) - π/2) × (180/π)
    // 这是 Mercator 对数公式的逆：Gudermannian 函数
    out[1] = (2.0 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2.0) * RAD_TO_DEG;

    return out;
}

// ============================================================
// 瓦片坐标函数
// ============================================================

/**
 * 将经纬度（度）转换为 XYZ 瓦片坐标。
 *
 * 瓦片编号规则（Web / Slippy Map）：
 *   x: 从 0（180°W）到 2^z - 1（180°E），向东递增
 *   y: 从 0（≈85°N）到 2^z - 1（≈85°S），向南递增
 *
 * @param lng - 经度（度），范围 [-180, 180]
 * @param lat - 纬度（度），范围 [-85.0511, 85.0511]
 * @param zoom - 缩放级别，非负整数
 * @returns 瓦片坐标 {x, y, z}
 *
 * @example
 * lngLatToTile(0, 0, 0);
 * // → { x: 0, y: 0, z: 0 }  （缩放级别 0 只有 1 个瓦片）
 *
 * @example
 * lngLatToTile(0, 0, 1);
 * // → { x: 1, y: 1, z: 1 }  （缩放级别 1 有 4 个瓦片，(0,0)在右下象限）
 */
export function lngLatToTile(lng: number, lat: number, zoom: number): TileCoord {
    // 2^zoom = 该缩放级别下每轴的瓦片数
    const n = Math.pow(2, zoom);

    // X = floor((lng + 180) / 360 × n)
    // 将经度 [-180, 180] 映射到 [0, n)，然后取整
    // clamp 到 [0, n-1] 防止 lng = 180 时越界
    const x = Math.min(Math.floor(((lng + 180.0) / 360.0) * n), n - 1);

    // Y = floor((1 - ln(tan(lat_rad) + sec(lat_rad)) / π) / 2 × n)
    // 这是 Mercator Y 归一化到 [0, 1] 后乘以 n
    const clampedLat = clampLatitude(lat);
    const latRad = clampedLat * DEG_TO_RAD;
    // sec(x) = 1/cos(x)，但直接用 1/cos 在极点附近有数值问题
    // 这里 clampLatitude 保证了 latRad 在安全范围内
    const y = Math.min(
        Math.floor(
            (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n,
        ),
        n - 1,
    );

    return { x, y, z: zoom };
}

/**
 * 将瓦片坐标转换为经纬度范围（BBox2D）。
 *
 * 返回该瓦片覆盖的地理范围，单位为度。
 * 边界为瓦片的四条边对应的经纬度值。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns 瓦片的经纬度范围 {west, south, east, north}（度）
 *
 * @example
 * tileToBBox(0, 0, 0);
 * // → { west: -180, south: -85.0511..., east: 180, north: 85.0511... }
 *
 * @example
 * tileToBBox(0, 0, 1);
 * // → { west: -180, south: 0, east: 0, north: 85.0511... }
 */
export function tileToBBox(x: number, y: number, z: number): BBox2D {
    // 每轴瓦片数
    const n = Math.pow(2, z);

    // 西边界 = 瓦片左边缘的经度
    const west = (x / n) * 360.0 - 180.0;

    // 东边界 = 瓦片右边缘的经度
    const east = ((x + 1) / n) * 360.0 - 180.0;

    // 北边界 = 瓦片上边缘的纬度（y 越小越北）
    // 公式：lat = atan(sinh(π·(1 - 2·y/n))) × (180/π)
    // 其中 sinh(x) = (e^x - e^(-x)) / 2
    const north = Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * y / n))) * RAD_TO_DEG;

    // 南边界 = 瓦片下边缘的纬度（y+1 更南）
    const south = Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * (y + 1) / n))) * RAD_TO_DEG;

    return { west, south, east, north };
}

/**
 * 计算给定缩放级别下的瓦片总数（单轴）。
 *
 * 在缩放级别 z 下，每条轴有 2^z 个瓦片，总瓦片数 = (2^z)²。
 * 此函数返回单轴瓦片数 2^z，总数可由调用方平方得到。
 *
 * @param zoom - 缩放级别，非负整数
 * @returns 单轴瓦片数 2^zoom
 *
 * @example
 * tileCount(0);  // → 1
 * tileCount(1);  // → 2
 * tileCount(10); // → 1024
 * tileCount(20); // → 1048576
 */
export function tileCount(zoom: number): number {
    // 使用 Math.pow 而非位运算，因为 zoom > 30 时位运算会溢出 32 位整数
    return Math.pow(2, zoom);
}

// ============================================================
// 地面分辨率与像素坐标
// ============================================================

/**
 * 计算给定纬度和缩放级别下的地面分辨率（米/像素）。
 *
 * Mercator 投影的特性：同一缩放级别下，靠近极点的像素代表更少的地面距离。
 * 公式：resolution = C·cos(lat) / (tileSize·2^zoom)
 *
 * @param lat - 纬度（度），范围 [-85.0511, 85.0511]
 * @param zoom - 缩放级别
 * @returns 地面分辨率，单位：米/像素
 *
 * @example
 * groundResolution(0, 0);   // ≈ 78271.52 米/像素（赤道，zoom=0）
 * groundResolution(0, 10);  // ≈ 76.44 米/像素（赤道，zoom=10）
 * groundResolution(60, 10); // ≈ 38.22 米/像素（60°N，zoom=10）
 */
export function groundResolution(lat: number, zoom: number): number {
    // cos(lat) 修正项：高纬度地区像素覆盖的地面距离更短
    const cosLat = Math.cos(clampLatitude(lat) * DEG_TO_RAD);
    // worldSize = 全球在该缩放级别下的总像素数（单轴）
    const worldSizePixels = TILE_SIZE * Math.pow(2, zoom);
    // 地面分辨率 = 赤道周长 × cos(lat) / 总像素数
    return (EARTH_CIRCUMFERENCE * cosLat) / worldSizePixels;
}

/**
 * 将经纬度（度）转换为世界像素坐标。
 *
 * 世界像素坐标系：原点在左上角（180°W, ≈85°N），
 * X 向右递增，Y 向下递增。
 * 总范围：[0, tileSize × 2^zoom] × [0, tileSize × 2^zoom]。
 *
 * @param out - 预分配的 Float64Array(2) 输出，存储 [px, py]
 * @param lng - 经度（度），范围 [-180, 180]
 * @param lat - 纬度（度），范围 [-85.0511, 85.0511]
 * @param zoom - 缩放级别
 * @returns out 引用，便于链式调用
 *
 * @example
 * const px = new Float64Array(2);
 * lngLatToPixel(px, 0, 0, 0);
 * // px ≈ [256, 256]  （zoom=0 时世界中心在 512/2 = 256）
 */
export function lngLatToPixel(out: Vec2d, lng: number, lat: number, zoom: number): Vec2d {
    // 世界尺寸 = 瓦片大小 × 2^zoom（总像素数，单轴）
    const worldSize = TILE_SIZE * Math.pow(2, zoom);

    // X 像素 = 经度归一化到 [0, 1] 后乘以世界尺寸
    // (lng + 180) / 360 将 [-180, 180] 映射到 [0, 1]
    out[0] = ((lng + 180.0) / 360.0) * worldSize;

    // Y 像素 = Mercator Y 归一化到 [0, 1] 后乘以世界尺寸
    // 公式与 lngLatToTile 相同，但不取整
    const clampedLat = clampLatitude(lat);
    const latRad = clampedLat * DEG_TO_RAD;
    // (1 - ln(tan(φ) + sec(φ)) / π) / 2 将纬度映射到 [0, 1]
    out[1] = (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * worldSize;

    return out;
}

/**
 * 将世界像素坐标转换回经纬度（度）。
 * 这是 {@link lngLatToPixel} 的逆运算。
 *
 * @param out - 预分配的 Float64Array(2) 输出，存储 [lng_degrees, lat_degrees]
 * @param px - 世界像素 X 坐标
 * @param py - 世界像素 Y 坐标
 * @param zoom - 缩放级别
 * @returns out 引用，便于链式调用
 *
 * @example
 * const ll = new Float64Array(2);
 * pixelToLngLat(ll, 256, 256, 0);
 * // ll ≈ [0, 0]  （zoom=0 时像素中心 = 赤道本初子午线）
 */
export function pixelToLngLat(out: Vec2d, px: number, py: number, zoom: number): Vec2d {
    // 世界尺寸
    const worldSize = TILE_SIZE * Math.pow(2, zoom);

    // 经度 = 像素 X 归一化到 [0, 1] 后映射到 [-180, 180]
    out[0] = (px / worldSize) * 360.0 - 180.0;

    // 纬度 = 逆 Mercator 变换
    // 归一化 Y 值：y' = 1 - 2·py/worldSize
    // 纬度 = atan(sinh(π·y')) × (180/π)
    // 等价于 Gudermannian 函数 gd(π·y')
    const yNormalized = 1.0 - (2.0 * py) / worldSize;
    out[1] = Math.atan(Math.sinh(Math.PI * yNormalized)) * RAD_TO_DEG;

    return out;
}
