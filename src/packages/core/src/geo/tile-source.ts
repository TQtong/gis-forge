/**
 * @module core/geo/tile-source
 * @description
 * 瓦片数据源描述——不可变值类型，不持有 GPU 资源或网络连接。
 *
 * 将 {@link TilingScheme}（纯数学）与 IO 层配置（URL 模板、zoom 范围、TMS 翻转）
 * 打包为一个不可变结构。L6 的 Globe3D 持有 TileSource 实例，
 * 传递给加载/渲染函数，而非逐个传递 scheme + url + maxZoom + ...
 *
 * TileSource 位于 L0 是因为它只包含值类型描述，不 import 任何上层模块。
 * 它不执行网络请求——那是 L6 `globe-tiles.ts` 的职责。
 *
 * @stability stable
 */

import type { TilingScheme } from './tiling-scheme.ts';

// ════════════════════════════════════════════════════════════════
// §1 类型定义
// ════════════════════════════════════════════════════════════════

/**
 * 数据源格式枚举。
 * 使用字符串字面量联合而非 enum，便于 tree-shake 和 JSON 序列化。
 *
 * @stability stable
 */
export type TileSourceFormat =
    | 'raster'
    | 'terrain-heightmap'
    | 'terrain-quantized-mesh'
    | 'vector-pbf';

/**
 * 瓦片数据源描述——不可变值类型。
 *
 * @stability stable
 *
 * @example
 * const osm = createTileSource({
 *   scheme: WebMercator,
 *   urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
 * });
 */
export interface TileSource {
    /** 所用的 tiling scheme 引用 */
    readonly scheme: TilingScheme;

    /**
     * URL 模板，支持以下占位符：
     * - `{z}` — zoom 级别
     * - `{x}` — 列号
     * - `{y}` — 行号（XYZ 标准：y=0 在北端）
     * - `{-y}` — 翻转行号（TMS 标准：y=0 在南端），等价于 numY-1-y
     * - `{s}` — 子域名（可选，轮询 a/b/c）
     *
     * @example 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
     * @example 'https://tiles.example.com/{z}/{x}/{-y}.terrain'
     */
    readonly urlTemplate: string;

    /**
     * 子域名列表。URL 中的 {s} 按瓦片坐标 hash 轮询。
     * 空数组表示不使用子域名。
     *
     * @example ['a', 'b', 'c']
     */
    readonly subdomains: readonly string[];

    /**
     * Y 轴翻转标记（TMS 兼容）。
     * 为 true 时，URL 中的 {y} 自动替换为 `numY(z) - 1 - y`。
     * 与 {-y} 占位符作用相同，但 {-y} 的优先级更高（显式翻转覆盖此标记）。
     */
    readonly tmsFlipY: boolean;

    /** 可请求的最低 zoom（含）。默认 0 */
    readonly minZoom: number;

    /** 可请求的最高 zoom（含）。默认 22 */
    readonly maxZoom: number;

    /**
     * 数据格式标识（影像 vs 地形 vs 矢量）。
     * 用于选择解码器和渲染管线。
     */
    readonly format: TileSourceFormat;

    /**
     * 该数据源的用户可读名称（调试/图层面板）。
     * 与 scheme.name 不同——scheme 描述投影方式，name 描述数据内容。
     *
     * @example 'OpenStreetMap', 'Cesium World Terrain', 'Mapbox Satellite'
     */
    readonly name: string;
}

// ════════════════════════════════════════════════════════════════
// §2 工厂函数
// ════════════════════════════════════════════════════════════════

/**
 * 创建 {@link TileSource} 的便捷工厂。填充默认值，冻结结果对象。
 *
 * @param config - 部分配置，仅 scheme 和 urlTemplate 必填
 * @returns 不可变 TileSource
 *
 * @example
 * const osm = createTileSource({
 *   scheme: WebMercator,
 *   urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
 * });
 *
 * @example
 * const cesiumTerrain = createTileSource({
 *   scheme: Geographic,
 *   urlTemplate: 'https://assets.cesium.com/1/{z}/{x}/{y}.terrain',
 *   format: 'terrain-quantized-mesh',
 *   name: 'Cesium World Terrain',
 *   maxZoom: 15,
 * });
 *
 * @stability stable
 */
export function createTileSource(config: {
    /** 瓦片方案（必填） */
    scheme: TilingScheme;
    /** URL 模板（必填） */
    urlTemplate: string;
    /** 子域名列表，默认空数组 */
    subdomains?: readonly string[];
    /** TMS Y 翻转，默认 false */
    tmsFlipY?: boolean;
    /** 最低 zoom，默认 0 */
    minZoom?: number;
    /** 最高 zoom，默认 22 */
    maxZoom?: number;
    /** 数据格式，默认 'raster' */
    format?: TileSourceFormat;
    /** 数据源名称，默认 'Unnamed' */
    name?: string;
}): TileSource {
    return Object.freeze({
        scheme: config.scheme,
        urlTemplate: config.urlTemplate,
        subdomains: Object.freeze(config.subdomains ?? []),
        tmsFlipY: config.tmsFlipY ?? false,
        minZoom: config.minZoom ?? 0,
        maxZoom: config.maxZoom ?? 22,
        format: config.format ?? 'raster',
        name: config.name ?? 'Unnamed',
    });
}

// ════════════════════════════════════════════════════════════════
// §3 URL 实例化
// ════════════════════════════════════════════════════════════════

/**
 * 将 {@link TileSource} 的 URL 模板实例化为具体瓦片 URL。
 *
 * 替换规则：
 * 1. `{s}` → 子域名轮询（(x + y + z) % subdomains.length）
 * 2. `{z}` → zoom 字符串
 * 3. `{x}` → 列号字符串
 * 4. `{y}` → 行号（若 tmsFlipY=true 则翻转）
 * 5. `{-y}` → 始终翻转的行号（显式 TMS 占位符）
 *
 * @param src - 数据源
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号（XYZ 标准方向）
 * @returns 完整 HTTP URL
 *
 * @complexity O(n) 其中 n = urlTemplate 长度（字符串替换）
 *
 * @example
 * const osm = createTileSource({ scheme: WebMercator, urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' });
 * tileUrl(osm, 5, 16, 11) // 'https://tile.openstreetmap.org/5/16/11.png'
 *
 * @stability stable
 */
export function tileUrl(src: TileSource, z: number, x: number, y: number): string {
    const numY = src.scheme.numY(z);
    // TMS 翻转：y=0 在南端 → numY - 1 - y
    const flippedY = numY - 1 - y;
    // tmsFlipY 标记决定 {y} 是否翻转
    const actualY = src.tmsFlipY ? flippedY : y;

    let url = src.urlTemplate;

    // 子域名轮询：(x + y + z) % subdomains.length
    if (src.subdomains.length > 0) {
        const idx = (x + y + z) % src.subdomains.length;
        url = url.replace('{s}', src.subdomains[idx]);
    }

    // 依次替换所有占位符
    return url
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(actualY))
        .replace('{-y}', String(flippedY));
}
