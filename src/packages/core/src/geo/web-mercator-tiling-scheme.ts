/**
 * @module core/geo/web-mercator-tiling-scheme
 * @description
 * WebMercator (EPSG:3857) 瓦片方案——冻结常量对象。
 *
 * 网格拓扑：
 * - zoom=0: 1×1（整个地球一个方形瓦片）
 * - zoom=z: 2^z × 2^z
 *
 * 纬度范围：±85.05112878°（Mercator 投影在极点处纬度趋向无穷）
 *
 * 兼容服务：OpenStreetMap, Google Maps, Mapbox, ArcGIS Online, Bing Maps
 *
 * @stability stable
 */

import type { TilingScheme } from './tiling-scheme.ts';
import { _registerBuiltins } from './tiling-scheme.ts';

/** Mercator 投影的最大有效纬度（度）。tan(85.051°) + sec(85.051°) 的对数有限 */
const MERC_MAX_LAT = 85.05112878;

/** 度 → 弧度乘数 */
const DEG2RAD = Math.PI / 180;

/** 弧度 → 度乘数 */
const RAD2DEG = 180 / Math.PI;

/** 圆周率 */
const PI = Math.PI;

/**
 * WebMercator (EPSG:3857) 瓦片方案。
 *
 * - zoom=0 → 1×1 瓦片，覆盖全球（±180° 经度，±85.05° 纬度）
 * - zoom=z → 2^z × 2^z 网格
 * - 纬度范围 ±85.05112878°（Mercator 投影极限）
 *
 * 所有方法 O(1)、无状态、无 GC 分配。
 *
 * @example
 * import { WebMercator } from './web-mercator-tiling-scheme';
 * // zoom=10 东京站
 * const col = Math.floor(WebMercator.lngX(139.767, 10)); // 909
 * const row = Math.floor(WebMercator.latY(35.681, 10));   // 403
 *
 * @stability stable
 */
export const WebMercator: TilingScheme = Object.freeze({
    /** 方案 ID：0 = WebMercator */
    id: 0,
    /** 人类可读名称 */
    name: 'WebMercator',
    /** 纬度有效范围（度）：±85.05112878° */
    latRange: Object.freeze([-MERC_MAX_LAT, MERC_MAX_LAT]) as readonly [number, number],

    /**
     * zoom=z → 2^z 列
     * @param z - 整数 zoom 级别
     * @returns 列数
     */
    numX(z: number): number { return 1 << z; },

    /**
     * zoom=z → 2^z 行
     * @param z - 整数 zoom 级别
     * @returns 行数
     */
    numY(z: number): number { return 1 << z; },

    /**
     * 经度 → 连续列号。线性映射：(lng + 180) / 360 × 2^z
     * @param lngDeg - 经度（度）
     * @param z - zoom
     * @returns 浮点列号
     */
    lngX(lngDeg: number, z: number): number {
        return ((lngDeg + 180) / 360) * (1 << z);
    },

    /**
     * 纬度 → 连续行号。Mercator 投影公式（非线性）。
     * 对 ±85.05° 之外的纬度做 clamp，避免 tan 爆炸。
     * @param latDeg - 纬度（度）
     * @param z - zoom
     * @returns 浮点行号
     */
    latY(latDeg: number, z: number): number {
        // 对极点附近纬度做 clamp，避免 tan/log 趋向无穷
        const clamped = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, latDeg));
        const r = clamped * DEG2RAD;
        // 标准 WebMercator latY 公式
        return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / PI) / 2) * (1 << z);
    },

    /**
     * 列号 → 西边界经度。线性逆映射。
     * @param x - 列号
     * @param z - zoom
     * @returns 经度（度）
     */
    xLng(x: number, z: number): number {
        return (x / (1 << z)) * 360 - 180;
    },

    /**
     * 行号 → 北边界纬度。逆 Mercator 投影（atan + sinh）。
     * @param y - 行号
     * @param z - zoom
     * @returns 纬度（度）
     */
    yLat(y: number, z: number): number {
        const n = PI - 2 * PI * y / (1 << z);
        return Math.atan(Math.sinh(n)) * RAD2DEG;
    },
});

// 模块加载时自动注册到全局注册表
_registerBuiltins(WebMercator);
