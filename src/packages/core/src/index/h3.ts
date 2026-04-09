// ============================================================
// index/h3.ts — H3 六边形层次空间索引（Uber H3 官方封装）
// ============================================================
//
// 使用 Uber 官方维护的 h3-js 包，保证与 Uber H3 生态完全二进制兼容：
// 同一经纬度 + 分辨率生成的 H3 index 与 h3-py/h3-java/PostGIS-H3 等一致。
//
// 本文件是一层薄封装：
// - 统一命名（把 h3-js 的 latLngToCell 等对齐到项目惯用名）
// - 类型明确（H3Index 为 string 类型别名）
// - 常用便利函数
//
// 完整 API 列表请直接 import 'h3-js'；本文件只导出 GIS-Forge 主流程用到的子集。
//
// 参考：https://h3geo.org
// ============================================================

import {
    latLngToCell as _latLngToCell,
    cellToLatLng as _cellToLatLng,
    cellToBoundary as _cellToBoundary,
    getResolution as _getResolution,
    getBaseCellNumber as _getBaseCellNumber,
    cellToParent as _cellToParent,
    cellToChildren as _cellToChildren,
    gridDisk as _gridDisk,
    gridRingUnsafe as _gridRingUnsafe,
    gridDistance as _gridDistance,
    isPentagon as _isPentagon,
    isValidCell as _isValidCell,
    polygonToCells as _polygonToCells,
    cellsToMultiPolygon as _cellsToMultiPolygon,
} from 'h3-js';

/**
 * H3 index 的字符串表示（15-字符十六进制，64-bit 整数的规范形式）。
 *
 * h3-js 的所有函数都用字符串表示 H3 index，以避免 JavaScript Number
 * 对 64-bit 整数的精度丢失。跨平台交换使用这个字符串即可。
 */
export type H3Index = string;

/**
 * 经纬度 → H3 index。
 *
 * @param latDeg 纬度（度，[-90, 90]）
 * @param lngDeg 经度（度，[-180, 180]）
 * @param res    分辨率（0..15，0 最粗 ~4250km，15 最细 ~0.5m 边长）
 * @returns H3 index 字符串
 *
 * @example
 * latLngToH3(51.5085, -0.1257, 9); // → "89195da49b7ffff"（伦敦）
 */
export function latLngToH3(latDeg: number, lngDeg: number, res: number): H3Index {
    return _latLngToCell(latDeg, lngDeg, res);
}

/**
 * H3 index → 经纬度中心点。
 *
 * @returns [latDeg, lngDeg]
 */
export function h3ToLatLng(h3: H3Index): [number, number] {
    return _cellToLatLng(h3);
}

/**
 * H3 index → 六边形顶点经纬度数组。
 *
 * @param h3 H3 index
 * @param geoJson 若为 true，按 GeoJSON 顺序返回 [lng, lat]；否则 [lat, lng]（默认）
 * @returns 顶点数组（长度 6，五边形为 5）
 */
export function h3ToBoundary(h3: H3Index, geoJson: boolean = false): Array<[number, number]> {
    return _cellToBoundary(h3, geoJson) as Array<[number, number]>;
}

/** 提取 H3 index 的分辨率（0..15）。 */
export function h3Resolution(h3: H3Index): number {
    return _getResolution(h3);
}

/** 提取 H3 index 的 base cell 编号（0..121）。 */
export function h3BaseCell(h3: H3Index): number {
    return _getBaseCellNumber(h3);
}

/**
 * 向上取父 cell。
 *
 * @param h3 原始 cell
 * @param parentRes 目标分辨率（必须 ≤ 当前分辨率）
 */
export function h3Parent(h3: H3Index, parentRes: number): H3Index {
    return _cellToParent(h3, parentRes);
}

/**
 * 返回 H3 cell 的所有子 cell（aperture-7：通常 7 个，五边形为 6 个）。
 */
export function h3Children(h3: H3Index, childRes: number): H3Index[] {
    return _cellToChildren(h3, childRes);
}

/**
 * 返回以 h3 为中心、半径 k 的 Disk（所有距离 ≤ k 的 cell，含自身）。
 *
 * k = 0 → 只返回自身
 * k = 1 → 自身 + 6 个（或 5 个）直接邻居
 * k = 2 → 19 个（或 16 个）cell，依此类推
 */
export function h3Disk(h3: H3Index, k: number): H3Index[] {
    return _gridDisk(h3, k);
}

/**
 * 返回距离恰为 k 的环（ring）上的 cell。
 *
 * ⚠️ 跨越 5 边形时可能失败（h3-js 的 gridRingUnsafe 限制），
 * 这种情况下请降级用 gridDisk(k) 差分 gridDisk(k-1)。
 */
export function h3Ring(h3: H3Index, k: number): H3Index[] {
    return _gridRingUnsafe(h3, k);
}

/**
 * 两个同分辨率 cell 的网格距离（跳数）。
 *
 * ⚠️ 跨越 5 边形时 h3-js 可能返回 -1 表示无法计算。
 */
export function h3Distance(a: H3Index, b: H3Index): number {
    return _gridDistance(a, b);
}

/** 该 cell 是否为五边形（全球 12 个五边形位置）。 */
export function h3IsPentagon(h3: H3Index): boolean {
    return _isPentagon(h3);
}

/** 该字符串是否为合法 H3 index。 */
export function h3IsValid(h3: H3Index): boolean {
    return _isValidCell(h3);
}

/**
 * 把 GeoJSON 多边形填充为 H3 cell 数组。
 *
 * @param polygon GeoJSON Polygon coordinates：外环 + 可选内环（洞），每个环是 [[lng,lat], ...]
 * @param res 目标分辨率
 * @returns 覆盖多边形的 H3 index 数组
 */
export function polygonToH3(
    polygon: Array<Array<[number, number]>>,
    res: number,
): H3Index[] {
    return _polygonToCells(polygon, res, true);
}

/**
 * 把一组 H3 cell 合并为 GeoJSON MultiPolygon 边界。
 */
export function h3ToMultiPolygon(
    cells: H3Index[],
    geoJson: boolean = true,
): Array<Array<Array<[number, number]>>> {
    return _cellsToMultiPolygon(cells, geoJson) as Array<Array<Array<[number, number]>>>;
}
