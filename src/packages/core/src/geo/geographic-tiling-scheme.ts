/**
 * @module core/geo/geographic-tiling-scheme
 * @description
 * Geographic (EPSG:4326) 瓦片方案——冻结常量对象。
 *
 * 网格拓扑：
 * - zoom=0: 2×1（经度 360° 分两半，纬度 180° 一行）
 * - zoom=z: 2^(z+1) × 2^z
 *
 * 纬度范围：±90°（全球覆盖，含极地）
 *
 * 兼容服务：Cesium Ion Terrain, 国家测绘局 WMTS, TileMatrixSet EPSG:4326
 *
 * @stability stable
 */

import type { TilingScheme } from './tiling-scheme.ts';
import { _registerBuiltins } from './tiling-scheme.ts';

/**
 * Geographic (EPSG:4326) 瓦片方案。
 *
 * - zoom=0 → 2×1 瓦片（西半球 + 东半球）
 * - zoom=z → 2^(z+1) × 2^z 网格
 * - 纬度范围 ±90°（全球覆盖，含极地，无 Mercator 的极地空白）
 *
 * 所有映射均为线性——经度和纬度在网格中均匀分布。
 *
 * @example
 * import { Geographic } from './geographic-tiling-scheme';
 * // zoom=0 只有 2 个瓦片：西半球 (0,0) 和东半球 (1,0)
 * Geographic.numX(0) // 2
 * Geographic.numY(0) // 1
 *
 * @example
 * // zoom=5 北极
 * const row = Math.floor(Geographic.latY(89.0, 5)); // 0（最北行）
 *
 * @stability stable
 */
export const Geographic: TilingScheme = Object.freeze({
    /** 方案 ID：1 = Geographic */
    id: 1,
    /** 人类可读名称 */
    name: 'Geographic',
    /** 纬度有效范围（度）：±90°（全球覆盖） */
    latRange: Object.freeze([-90, 90]) as readonly [number, number],

    /**
     * zoom=z → 2^(z+1) 列（zoom=0 有 2 列：西半球 + 东半球）
     * @param z - 整数 zoom 级别
     * @returns 列数
     */
    numX(z: number): number { return 2 << z; },

    /**
     * zoom=z → 2^z 行（与 WebMercator 行数相同，但含义不同——等角度分布）
     * @param z - 整数 zoom 级别
     * @returns 行数
     */
    numY(z: number): number { return 1 << z; },

    /**
     * 经度 → 连续列号。线性映射：(lng + 180) / 360 × 2^(z+1)
     * @param lngDeg - 经度（度）
     * @param z - zoom
     * @returns 浮点列号
     */
    lngX(lngDeg: number, z: number): number {
        return ((lngDeg + 180) / 360) * (2 << z);
    },

    /**
     * 纬度 → 连续行号。线性映射：(90 - lat) / 180 × 2^z
     * 行号 0 = 最北（90°），行号 numY-1 = 最南（-90°）
     * @param latDeg - 纬度（度）
     * @param z - zoom
     * @returns 浮点行号
     */
    latY(latDeg: number, z: number): number {
        return ((90 - latDeg) / 180) * (1 << z);
    },

    /**
     * 列号 → 西边界经度。线性逆映射。
     * @param x - 列号
     * @param z - zoom
     * @returns 经度（度）
     */
    xLng(x: number, z: number): number {
        return (x / (2 << z)) * 360 - 180;
    },

    /**
     * 行号 → 北边界纬度。线性逆映射：90 - (y / 2^z) × 180
     * @param y - 行号
     * @param z - zoom
     * @returns 纬度（度）
     */
    yLat(y: number, z: number): number {
        return 90 - (y / (1 << z)) * 180;
    },
});

// 模块加载时自动注册到全局注册表
_registerBuiltins(Geographic);
