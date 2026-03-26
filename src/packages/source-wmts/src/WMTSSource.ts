// ============================================================
// source-wmts/WMTSSource.ts — OGC WMTS 数据源（KVP + RESTful）
// 职责：从 OGC WMTS 服务获取栅格瓦片，支持 KVP 和 RESTful 两种请求模式。
// 层级：L4 数据源（非图层，不参与渲染管线）
// 零 npm 依赖，所有功能自研。
// ============================================================

declare const __DEV__: boolean;

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

// ======================== 常量 ========================

/**
 * OGC 标准像素物理尺寸（米/像素）。
 * 来源：OGC WMTS 1.0.0 标准 §6.1，定义 1 像素 = 0.28mm。
 * 用于从 TileMatrix 的 scaleDenominator 反算缩放级别。
 *
 * @stability stable
 */
const OGC_PIXEL_SIZE = 0.00028;

/**
 * 默认瓦片格式（MIME 类型）。
 * image/png 为最广泛支持的 WMTS 瓦片格式，支持透明通道。
 *
 * @stability stable
 */
const DEFAULT_TILE_FORMAT = 'image/png';

/**
 * 默认样式标识符。
 * OGC WMTS 标准中，当图层仅有单一默认样式时使用此值。
 *
 * @stability stable
 */
const DEFAULT_STYLE = 'default';

/**
 * WMTS 协议版本号。
 * GIS-Forge 当前仅支持 WMTS 1.0.0（OGC 06-042r4）。
 *
 * @stability stable
 */
const WMTS_VERSION = '1.0.0';

/**
 * GetCapabilities 请求超时时间（毫秒）。
 * 超过此时间的能力文档请求将被终止并抛出错误。
 * 10 秒足以覆盖大部分网络延迟场景，防止无限等待。
 *
 * @stability stable
 */
const CAPABILITIES_TIMEOUT_MS = 10_000;

/**
 * 地球赤道周长（米），用于 TileMatrix scaleDenominator → zoom 换算。
 * 等于 WGS-84 赤道半径 6378137m × 2π。
 * 来源：OGC CRS84 / EPSG:3857 投影中的标准值。
 *
 * @stability stable
 */
const EARTH_CIRCUMFERENCE = 40_075_016.685578488;

/**
 * 默认瓦片过期时间增量（毫秒），24 小时。
 * 当服务器未返回 Cache-Control / Expires 头时，使用此默认过期策略。
 *
 * @stability stable
 */
const DEFAULT_TILE_EXPIRATION_MS = 86_400_000;

/**
 * 最大缩放级别上限，防止非法 TileMatrix 导致越界。
 * 22 级已可覆盖约 10cm 分辨率（Web 墨卡托），足够绝大多数 WMTS 服务。
 *
 * @stability stable
 */
const MAX_ZOOM = 22;

// ======================== 类型定义 ========================

/**
 * WMTS 请求模式。
 * - `'KVP'`：Key-Value-Pair 查询字符串方式，通用性最强
 * - `'RESTful'`：RESTful URL 模板方式，CDN 友好
 *
 * @stability stable
 */
export type WMTSRequestMode = 'KVP' | 'RESTful';

/**
 * WMTS 数据源配置选项。
 * 创建 WMTSSource 时传入，指定服务端点、图层、样式等参数。
 *
 * @example
 * const options: WMTSSourceOptions = {
 *   url: 'https://example.com/wmts',
 *   layer: 'satellite',
 *   matrixSet: 'EPSG:3857',
 *   style: 'default',
 *   format: 'image/png',
 *   requestMode: 'KVP',
 * };
 *
 * @stability stable
 */
export interface WMTSSourceOptions {
    /**
     * WMTS 服务端点 URL。
     * KVP 模式下为基础 URL（参数将附加为查询字符串），
     * RESTful 模式下为 URL 模板（含 {TileMatrix}/{TileRow}/{TileCol} 等占位符）。
     * 必填项，不得为空字符串。
     */
    readonly url: string;

    /**
     * 请求的图层标识符。
     * 对应 WMTS Capabilities 文档中 <Layer><ows:Identifier> 的值。
     * 必填项，大小写敏感。
     */
    readonly layer: string;

    /**
     * 图层样式标识符。
     * 对应 WMTS Capabilities 中 <Style><ows:Identifier>。
     * 默认值：`'default'`。
     */
    readonly style?: string;

    /**
     * 瓦片矩阵集标识符。
     * 指定使用的坐标系和分辨率层级方案，如 `'EPSG:3857'`、`'GoogleMapsCompatible'`。
     * 必填项，需与 Capabilities 中的 TileMatrixSet 匹配。
     */
    readonly matrixSet: string;

    /**
     * 瓦片输出格式（MIME 类型）。
     * 常见值：`'image/png'`（透明）、`'image/jpeg'`（高压缩）、`'image/webp'`。
     * 默认值：`'image/png'`。
     */
    readonly format?: string;

    /**
     * 请求模式。
     * - `'KVP'`：Key-Value-Pair，参数附加为 URL 查询字符串（默认）
     * - `'RESTful'`：使用 ResourceURL 模板，替换 {Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}
     * 默认值：`'KVP'`。
     */
    readonly requestMode?: WMTSRequestMode;

    /**
     * 额外维度参数映射（如时间维度 TIME、高度维度 ELEVATION）。
     * Key 为维度名，Value 为维度值字符串。
     * WMTS 标准允许服务端声明任意自定义维度。
     *
     * @example
     * { TIME: '2025-01-01', ELEVATION: '500' }
     */
    readonly dimensions?: Record<string, string>;

    /**
     * 子域名数组，用于域名分散（Domain Sharding）提升并发请求数。
     * URL 中的 `{s}` 占位符将按轮询替换为子域名。
     * 可选，若 URL 不含 `{s}` 则忽略。
     *
     * @example
     * ['a', 'b', 'c']
     */
    readonly subdomains?: string[];

    /**
     * 自定义 HTTP 请求头。
     * 用于鉴权（Authorization）、自定义 User-Agent 等场景。
     * 不得包含 Content-Type（由引擎自动设置）。
     */
    readonly headers?: Record<string, string>;

    /**
     * 瓦片缓存过期时间（毫秒）。
     * 覆盖服务器返回的 Cache-Control 策略。
     * 0 表示不缓存，undefined 使用服务器策略或默认 24 小时。
     */
    readonly tileExpiration?: number;
}

/**
 * 单个 TileMatrix（瓦片矩阵）描述。
 * 对应 WMTS Capabilities 中 <TileMatrix> 元素的关键字段。
 *
 * @stability stable
 */
export interface TileMatrixDescriptor {
    /** TileMatrix 标识符（通常是数字字符串如 "0"、"1"，或类似 "EPSG:3857:0"） */
    readonly identifier: string;

    /**
     * 比例尺分母。
     * 与 OGC_PIXEL_SIZE 结合可计算地面分辨率：
     * groundResolution = scaleDenominator × 0.00028（米/像素）。
     */
    readonly scaleDenominator: number;

    /**
     * 瓦片矩阵左上角坐标 [x, y]。
     * CRS 相关：EPSG:3857 下为投影坐标（米），EPSG:4326 下为 [lon, lat]（度）。
     */
    readonly topLeftCorner: [number, number];

    /** 单个瓦片宽度（像素），常见值 256 或 512 */
    readonly tileWidth: number;

    /** 单个瓦片高度（像素），常见值 256 或 512 */
    readonly tileHeight: number;

    /** 矩阵宽度（瓦片列数） */
    readonly matrixWidth: number;

    /** 矩阵高度（瓦片行数） */
    readonly matrixHeight: number;
}

/**
 * TileMatrixSet（瓦片矩阵集）描述。
 * 一个 TileMatrixSet 包含一组按分辨率排列的 TileMatrix。
 *
 * @stability stable
 */
export interface TileMatrixSetDescriptor {
    /** 矩阵集标识符，如 `'EPSG:3857'`、`'GoogleMapsCompatible'` */
    readonly identifier: string;

    /** 支持的坐标参考系 URI，如 `'urn:ogc:def:crs:EPSG::3857'` */
    readonly supportedCRS: string;

    /** 包含的 TileMatrix 列表，按 scaleDenominator 从大到小（zoom 从小到大）排列 */
    readonly matrices: TileMatrixDescriptor[];
}

/**
 * WMTS 图层描述信息。
 * 对应 Capabilities 文档中 <Layer> 元素的摘要。
 *
 * @stability stable
 */
export interface WMTSLayerDescriptor {
    /** 图层标识符 */
    readonly identifier: string;

    /** 图层标题（可读） */
    readonly title: string;

    /** 图层支持的样式标识符列表 */
    readonly styles: string[];

    /** 图层支持的 TileMatrixSet 标识符列表 */
    readonly tileMatrixSetLinks: string[];

    /** 图层支持的格式列表，如 ['image/png', 'image/jpeg'] */
    readonly formats: string[];

    /**
     * 图层地理范围（WGS-84 经纬度）。
     * 来源于 Capabilities 中的 <ows:WGS84BoundingBox>。
     * 可选，部分服务不提供此字段。
     */
    readonly wgs84BBox?: BBox2D;
}

/**
 * WMTS ResourceURL 模板描述。
 * 仅 RESTful 模式使用。
 *
 * @stability stable
 */
export interface WMTSResourceUrl {
    /** 资源格式（MIME 类型），如 'image/png' */
    readonly format: string;

    /** 资源类型，通常为 'tile' */
    readonly resourceType: string;

    /**
     * URL 模板字符串，含 OGC 标准占位符。
     * 如 `'https://example.com/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png'`
     */
    readonly template: string;
}

/**
 * WMTS 能力文档解析结果。
 * 包含服务中所有图层、矩阵集和资源 URL 模板信息。
 *
 * @stability stable
 */
export interface WMTSCapabilities {
    /** 服务标题 */
    readonly title: string;

    /** 可用图层列表 */
    readonly layers: WMTSLayerDescriptor[];

    /** 可用瓦片矩阵集列表 */
    readonly matrixSets: TileMatrixSetDescriptor[];

    /**
     * RESTful 资源 URL 模板列表。
     * 仅当服务支持 RESTful 编码时存在。
     */
    readonly resourceUrls?: WMTSResourceUrl[];
}

/**
 * 瓦片加载参数（传给 loadTile）。
 *
 * @stability stable
 */
export interface WMTSTileLoadParams {
    /** 瓦片坐标 */
    readonly coord: TileCoord;

    /** 请求取消信号 */
    readonly signal?: AbortSignal;
}

/**
 * 瓦片加载结果。
 *
 * @stability stable
 */
export interface WMTSTileLoadResult {
    /** 瓦片图像二进制数据 */
    readonly data: ArrayBuffer;

    /** 瓦片坐标（回传便于上层匹配） */
    readonly coord: TileCoord;

    /** 缓存过期时间戳（Unix 毫秒），undefined 表示未知 */
    readonly expiresAt?: number;

    /** 瓦片字节大小 */
    readonly byteSize: number;
}

/**
 * WMTS 数据源元数据。
 *
 * @stability stable
 */
export interface WMTSSourceMetadata {
    /** 数据源类型标识 */
    readonly type: 'wmts';

    /** 当前配置的图层标识符 */
    readonly layer: string;

    /** 当前配置的矩阵集标识符 */
    readonly matrixSet: string;

    /** 当前配置的样式 */
    readonly style: string;

    /** 当前配置的格式 */
    readonly format: string;

    /** 请求模式 */
    readonly requestMode: WMTSRequestMode;

    /** 是否已初始化 */
    readonly initialized: boolean;
}

// ======================== 内部工具函数 ========================

/**
 * 将 TileMatrix 的 scaleDenominator 换算为 Web 地图缩放级别。
 * 公式：zoom = round(log2(EARTH_CIRCUMFERENCE / (scaleDenom × OGC_PIXEL_SIZE × tileWidth)))
 * 原理：zoom=0 时单张瓦片覆盖全球，每级 zoom 分辨率翻倍。
 *
 * @param scaleDenominator - TileMatrix 比例尺分母（必须 > 0）
 * @param tileWidth - 瓦片宽度像素数（必须 > 0）
 * @returns 缩放级别（整数，钳位到 [0, MAX_ZOOM]）
 *
 * @example
 * const zoom = scaleToZoom(559082264.0287178, 256); // → 0
 * const zoom2 = scaleToZoom(2183.915072, 256); // → 18
 */
function scaleToZoom(scaleDenominator: number, tileWidth: number): number {
    // 防御 ≤0 的异常值，直接返回 0 级
    if (scaleDenominator <= 0 || tileWidth <= 0) {
        return 0;
    }

    // 单个瓦片覆盖的地面距离（米）= scaleDenom × 像素物理尺寸 × 瓦片宽度
    const tileGroundSpan = scaleDenominator * OGC_PIXEL_SIZE * tileWidth;

    // zoom = log2(全球周长 / 单瓦片地面跨度)
    const rawZoom = Math.log2(EARTH_CIRCUMFERENCE / tileGroundSpan);

    // 四舍五入到最近整数级，并钳位到合法范围
    const clamped = Math.max(0, Math.min(MAX_ZOOM, Math.round(rawZoom)));

    return clamped;
}

/**
 * 构建 KVP 模式的 GetTile 请求 URL。
 * 按 OGC WMTS 1.0.0 标准拼接所有必要查询参数。
 *
 * @param baseUrl - 服务端点基础 URL
 * @param layer - 图层标识符
 * @param style - 样式标识符
 * @param matrixSet - 瓦片矩阵集标识符
 * @param matrixId - 当前 TileMatrix 标识符（对应 zoom 级别）
 * @param row - 瓦片行号（TileRow = y）
 * @param col - 瓦片列号（TileCol = x）
 * @param format - 输出格式（MIME 类型）
 * @param dimensions - 额外维度参数
 * @returns 完整的 GetTile KVP URL
 *
 * @example
 * const url = buildKVPUrl('https://maps.example.com/wmts', 'topo', 'default',
 *   'EPSG:3857', '5', 10, 15, 'image/png', { TIME: '2025-01-01' });
 */
function buildKVPUrl(
    baseUrl: string,
    layer: string,
    style: string,
    matrixSet: string,
    matrixId: string,
    row: number,
    col: number,
    format: string,
    dimensions?: Record<string, string>,
): string {
    // 确定分隔符：如果基础 URL 已含 '?' 则用 '&'，否则用 '?'
    const separator = baseUrl.includes('?') ? '&' : '?';

    // 构建标准 GetTile 参数列表（OGC WMTS §7.2 Table 5）
    const params: string[] = [
        'SERVICE=WMTS',
        `VERSION=${WMTS_VERSION}`,
        'REQUEST=GetTile',
        `LAYER=${encodeURIComponent(layer)}`,
        `STYLE=${encodeURIComponent(style)}`,
        `TILEMATRIXSET=${encodeURIComponent(matrixSet)}`,
        `TILEMATRIX=${encodeURIComponent(matrixId)}`,
        `TILEROW=${row}`,
        `TILECOL=${col}`,
        `FORMAT=${encodeURIComponent(format)}`,
    ];

    // 追加自定义维度参数（如 TIME、ELEVATION）
    if (dimensions !== undefined && dimensions !== null) {
        const dimKeys = Object.keys(dimensions);
        for (let i = 0; i < dimKeys.length; i++) {
            const key = dimKeys[i];
            const value = dimensions[key];
            // 跳过空值维度
            if (value !== undefined && value !== null && value !== '') {
                params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
            }
        }
    }

    return baseUrl + separator + params.join('&');
}

/**
 * 构建 RESTful 模式的 GetTile 请求 URL。
 * 将 URL 模板中的 OGC 标准占位符替换为实际值。
 *
 * 支持的占位符：
 * - `{Style}` → 样式标识符
 * - `{TileMatrixSet}` → 矩阵集标识符
 * - `{TileMatrix}` → 当前矩阵标识符
 * - `{TileRow}` → 瓦片行号
 * - `{TileCol}` → 瓦片列号
 * - `{s}` → 子域名（轮询选择）
 * - `{DimensionName}` → 自定义维度值
 *
 * @param template - URL 模板字符串
 * @param style - 样式标识符
 * @param matrixSet - 瓦片矩阵集标识符
 * @param matrixId - 当前 TileMatrix 标识符
 * @param row - 瓦片行号
 * @param col - 瓦片列号
 * @param subdomains - 子域名数组（可选）
 * @param subdomainIndex - 用于子域名轮询的索引
 * @param dimensions - 额外维度参数
 * @returns 替换完成的完整 URL
 *
 * @example
 * const url = buildRESTfulUrl(
 *   'https://{s}.maps.example.com/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
 *   'default', 'EPSG:3857', '5', 10, 15, ['a','b','c'], 7, undefined
 * );
 */
function buildRESTfulUrl(
    template: string,
    style: string,
    matrixSet: string,
    matrixId: string,
    row: number,
    col: number,
    subdomains?: string[],
    subdomainIndex?: number,
    dimensions?: Record<string, string>,
): string {
    let url = template;

    // 替换 OGC 标准占位符
    url = url.replace(/\{Style\}/gi, encodeURIComponent(style));
    url = url.replace(/\{TileMatrixSet\}/gi, encodeURIComponent(matrixSet));
    url = url.replace(/\{TileMatrix\}/gi, encodeURIComponent(matrixId));
    url = url.replace(/\{TileRow\}/gi, String(row));
    url = url.replace(/\{TileCol\}/gi, String(col));

    // 替换子域名占位符（按索引轮询）
    if (subdomains !== undefined && subdomains.length > 0 && subdomainIndex !== undefined) {
        const subIdx = ((subdomainIndex % subdomains.length) + subdomains.length) % subdomains.length;
        url = url.replace(/\{s\}/gi, subdomains[subIdx]);
    }

    // 替换自定义维度占位符
    if (dimensions !== undefined && dimensions !== null) {
        const dimKeys = Object.keys(dimensions);
        for (let i = 0; i < dimKeys.length; i++) {
            const key = dimKeys[i];
            const value = dimensions[key];
            if (value !== undefined && value !== null) {
                // 维度占位符为 {DimensionName}，大小写敏感
                const regex = new RegExp(`\\{${key}\\}`, 'g');
                url = url.replace(regex, encodeURIComponent(value));
            }
        }
    }

    return url;
}

/**
 * 从 HTTP 响应头解析缓存过期时间。
 * 优先使用 Cache-Control max-age，其次 Expires 头。
 *
 * @param headers - fetch 响应的 Headers 对象
 * @param fallbackMs - 回退过期时间（毫秒），当响应头无缓存信息时使用
 * @returns 过期时间戳（Unix 毫秒），undefined 表示无法确定
 *
 * @example
 * const expires = parseExpiresFromHeaders(response.headers, 86400000);
 */
function parseExpiresFromHeaders(headers: Headers, fallbackMs?: number): number | undefined {
    // 优先解析 Cache-Control: max-age=<seconds>
    const cacheControl = headers.get('Cache-Control');
    if (cacheControl !== null && cacheControl.length > 0) {
        const maxAgeMatch = cacheControl.match(/max-age\s*=\s*(\d+)/i);
        if (maxAgeMatch !== null && maxAgeMatch[1] !== undefined) {
            const maxAgeSec = parseInt(maxAgeMatch[1], 10);
            // 验证解析结果为有限正数
            if (Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
                return Date.now() + maxAgeSec * 1000;
            }
        }
    }

    // 其次解析 Expires 头
    const expiresStr = headers.get('Expires');
    if (expiresStr !== null && expiresStr.length > 0) {
        const expiresTimestamp = Date.parse(expiresStr);
        // Date.parse 对无效字符串返回 NaN
        if (Number.isFinite(expiresTimestamp) && expiresTimestamp > 0) {
            return expiresTimestamp;
        }
    }

    // 使用回退值
    if (fallbackMs !== undefined && Number.isFinite(fallbackMs) && fallbackMs > 0) {
        return Date.now() + fallbackMs;
    }

    return undefined;
}

/**
 * 生成 MVP 阶段的 WMTS Capabilities 示例数据。
 * 当无法从服务端获取真实 Capabilities 时返回此桩数据。
 * 仅在开发和测试环境中使用，生产环境应始终尝试获取真实 Capabilities。
 *
 * @param options - WMTS 数据源配置
 * @returns 符合 WMTSCapabilities 结构的示例数据
 */
function buildStubCapabilities(options: WMTSSourceOptions): WMTSCapabilities {
    // 构建 0~22 级标准 Web 墨卡托 TileMatrix 列表
    const matrices: TileMatrixDescriptor[] = [];
    for (let z = 0; z <= MAX_ZOOM; z++) {
        // scaleDenominator: zoom=0 时约为 559082264.0287178（Web 墨卡托标准）
        const scaleDenom = EARTH_CIRCUMFERENCE / (256 * OGC_PIXEL_SIZE * Math.pow(2, z));
        const dim = Math.pow(2, z);
        matrices.push({
            identifier: String(z),
            scaleDenominator: scaleDenom,
            topLeftCorner: [-20037508.3427892, 20037508.3427892],
            tileWidth: 256,
            tileHeight: 256,
            matrixWidth: dim,
            matrixHeight: dim,
        });
    }

    return {
        title: 'WMTS Service (stub)',
        layers: [
            {
                identifier: options.layer,
                title: options.layer,
                styles: [options.style ?? DEFAULT_STYLE],
                tileMatrixSetLinks: [options.matrixSet],
                formats: [options.format ?? DEFAULT_TILE_FORMAT],
                wgs84BBox: { west: -180, south: -85.05112878, east: 180, north: 85.05112878 },
            },
        ],
        matrixSets: [
            {
                identifier: options.matrixSet,
                supportedCRS: 'urn:ogc:def:crs:EPSG::3857',
                matrices,
            },
        ],
        resourceUrls: undefined,
    };
}

// ======================== WMTSSource 类 ========================

/**
 * OGC WMTS（Web Map Tile Service）数据源。
 *
 * 支持 KVP（查询字符串）和 RESTful（URL 模板）两种请求模式。
 * 负责构建瓦片请求 URL、管理维度参数、解析 Capabilities 文档，
 * 以及处理瓦片加载生命周期（含取消和过期）。
 *
 * 这是一个纯数据源，不继承 Layer，不参与渲染管线。
 * 由上层图层（如 RasterTileLayer）组合使用。
 *
 * @stability stable
 *
 * @example
 * const source = new WMTSSource({
 *   url: 'https://maps.example.com/wmts',
 *   layer: 'satellite',
 *   matrixSet: 'EPSG:3857',
 *   requestMode: 'KVP',
 * });
 * await source.initialize();
 * const tile = await source.loadTile({ coord: { x: 1, y: 0, z: 1 } });
 */
export class WMTSSource {
    /** 数据源类型标识，用于运行时类型鉴别 */
    readonly type: 'wmts' = 'wmts';

    /** 配置选项（不可变副本） */
    private readonly _options: Readonly<WMTSSourceOptions>;

    /** 生效的图层样式 */
    private readonly _style: string;

    /** 生效的瓦片格式 */
    private readonly _format: string;

    /** 生效的请求模式 */
    private readonly _requestMode: WMTSRequestMode;

    /** 维度参数（可通过 setDimension 动态修改） */
    private _dimensions: Record<string, string>;

    /** 是否已完成初始化 */
    private _initialized: boolean;

    /** 是否已销毁 */
    private _destroyed: boolean;

    /** 缓存的 Capabilities 文档解析结果 */
    private _capabilities: WMTSCapabilities | null;

    /**
     * TileMatrix 标识符→zoom 级别映射表。
     * 由 initialize() 或 getCapabilities() 建立，用于 loadTile 时查找对应 matrixId。
     */
    private _zoomToMatrixId: Map<number, string>;

    /**
     * 活跃的瓦片请求映射（tileKey → AbortController）。
     * 用于 cancelTile 取消正在进行的网络请求。
     */
    private readonly _activeRequests: Map<string, AbortController>;

    /** 子域名轮询计数器 */
    private _subdomainCounter: number;

    /**
     * 创建 WMTS 数据源实例。
     *
     * @param options - WMTS 配置选项
     * @throws {GeoForgeError} 当 url 或 layer 或 matrixSet 为空时
     *
     * @example
     * const source = new WMTSSource({
     *   url: 'https://example.com/wmts',
     *   layer: 'imagery',
     *   matrixSet: 'EPSG:3857',
     * });
     */
    constructor(options: WMTSSourceOptions) {
        // 参数验证：url 必须非空
        if (options.url === undefined || options.url === null || options.url.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: url 不能为空',
                { optionKeys: Object.keys(options) },
            );
        }

        // 参数验证：layer 必须非空
        if (options.layer === undefined || options.layer === null || options.layer.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: layer 不能为空',
                { url: options.url },
            );
        }

        // 参数验证：matrixSet 必须非空
        if (options.matrixSet === undefined || options.matrixSet === null || options.matrixSet.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: matrixSet 不能为空',
                { url: options.url, layer: options.layer },
            );
        }

        this._options = options;
        this._style = options.style ?? DEFAULT_STYLE;
        this._format = options.format ?? DEFAULT_TILE_FORMAT;
        this._requestMode = options.requestMode ?? 'KVP';

        // 深拷贝维度参数，防止外部引用修改
        this._dimensions = options.dimensions !== undefined && options.dimensions !== null
            ? { ...options.dimensions }
            : {};

        this._initialized = false;
        this._destroyed = false;
        this._capabilities = null;
        this._zoomToMatrixId = new Map<number, string>();
        this._activeRequests = new Map<string, AbortController>();
        this._subdomainCounter = 0;
    }

    /**
     * 初始化数据源。
     * 建立默认的 zoom → TileMatrix 映射表。
     * 可选传入上下文参数用于高级场景（当前保留）。
     *
     * @param _context - 保留参数，未来可传入 SourceContext
     * @returns 初始化完成的 Promise
     * @throws {GeoForgeError} 当数据源已销毁时
     *
     * @stability stable
     *
     * @example
     * await source.initialize();
     */
    async initialize(_context?: unknown): Promise<void> {
        // 防止在已销毁状态下初始化
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 无法初始化已销毁的数据源',
                { layer: this._options.layer },
            );
        }

        // 幂等：重复初始化直接返回
        if (this._initialized) {
            return;
        }

        try {
            // 构建默认 zoom→matrixId 映射（0~22 直接映射为字符串 "0"~"22"）
            // 真实场景中应从 Capabilities 文档的 TileMatrix 中推导
            this._zoomToMatrixId.clear();
            for (let z = 0; z <= MAX_ZOOM; z++) {
                this._zoomToMatrixId.set(z, String(z));
            }

            this._initialized = true;

            if (__DEV__) {
                console.log(
                    `[WMTSSource] 初始化完成: layer=${this._options.layer}, matrixSet=${this._options.matrixSet}, mode=${this._requestMode}`,
                );
            }
        } catch (err: unknown) {
            // 包装非 GeoForgeError 的异常
            if (err instanceof GeoForgeError) {
                throw err;
            }
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 初始化失败',
                { layer: this._options.layer, matrixSet: this._options.matrixSet },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    /**
     * 销毁数据源，释放所有资源。
     * 取消所有进行中的瓦片请求，清除内部状态。
     * 调用后此实例不可再使用。
     *
     * @stability stable
     *
     * @example
     * source.destroy();
     */
    destroy(): void {
        // 幂等：重复销毁无副作用
        if (this._destroyed) {
            return;
        }

        // 取消所有活跃请求
        this._activeRequests.forEach((controller, _key) => {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出，但防御性处理
            }
        });
        this._activeRequests.clear();

        // 清除缓存
        this._capabilities = null;
        this._zoomToMatrixId.clear();
        this._dimensions = {};

        this._destroyed = true;
        this._initialized = false;

        if (__DEV__) {
            console.log(`[WMTSSource] 已销毁: layer=${this._options.layer}`);
        }
    }

    /**
     * 获取数据源元数据。
     *
     * @returns 数据源当前状态的不可变元数据快照
     *
     * @stability stable
     *
     * @example
     * const meta = source.getMetadata();
     * console.log(meta.layer, meta.initialized);
     */
    getMetadata(): WMTSSourceMetadata {
        return {
            type: 'wmts',
            layer: this._options.layer,
            matrixSet: this._options.matrixSet,
            style: this._style,
            format: this._format,
            requestMode: this._requestMode,
            initialized: this._initialized,
        };
    }

    /**
     * 加载指定坐标的瓦片数据。
     * 根据请求模式（KVP / RESTful）构建 URL，发起 fetch 请求，返回二进制数据。
     * 支持通过 AbortSignal 取消请求。
     *
     * @param params - 瓦片加载参数（坐标 + 可选取消信号）
     * @returns 瓦片数据的 Promise
     * @throws {GeoForgeError} 当数据源未初始化、已销毁、或请求失败时
     *
     * @stability stable
     *
     * @example
     * const result = await source.loadTile({
     *   coord: { x: 215, y: 99, z: 8 },
     *   signal: abortController.signal,
     * });
     * console.log(result.byteSize); // 瓦片字节大小
     */
    async loadTile(params: WMTSTileLoadParams): Promise<WMTSTileLoadResult> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 数据源已销毁，无法加载瓦片',
                { coord: params.coord },
            );
        }

        if (!this._initialized) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 数据源未初始化，请先调用 initialize()',
                { coord: params.coord },
            );
        }

        const { coord, signal: externalSignal } = params;

        // 验证瓦片坐标有效性
        if (coord.z < 0 || coord.z > MAX_ZOOM || coord.x < 0 || coord.y < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 无效的瓦片坐标',
                { x: coord.x, y: coord.y, z: coord.z },
            );
        }

        // 验证 x/y 不超出当前 zoom 级别范围
        const maxTileIndex = Math.pow(2, coord.z) - 1;
        if (coord.x > maxTileIndex || coord.y > maxTileIndex) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 瓦片坐标超出范围',
                { x: coord.x, y: coord.y, z: coord.z, maxIndex: maxTileIndex },
            );
        }

        // 查找当前 zoom 对应的 TileMatrix 标识符
        const matrixId = this._zoomToMatrixId.get(coord.z);
        if (matrixId === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `WMTSSource: zoom ${coord.z} 无对应的 TileMatrix`,
                { z: coord.z, availableZooms: Array.from(this._zoomToMatrixId.keys()) },
            );
        }

        // 构建请求 URL
        let tileUrl: string;
        if (this._requestMode === 'RESTful') {
            // RESTful 模式：替换 URL 模板占位符
            tileUrl = buildRESTfulUrl(
                this._options.url,
                this._style,
                this._options.matrixSet,
                matrixId,
                coord.y,
                coord.x,
                this._options.subdomains,
                this._subdomainCounter++,
                this._dimensions,
            );
        } else {
            // KVP 模式：拼接查询参数
            tileUrl = buildKVPUrl(
                this._options.url,
                this._options.layer,
                this._style,
                this._options.matrixSet,
                matrixId,
                coord.y,
                coord.x,
                this._format,
                this._dimensions,
            );
        }

        // 生成瓦片唯一键（用于请求追踪和取消）
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;

        // 创建内部 AbortController，支持外部和内部双重取消
        const internalController = new AbortController();
        this._activeRequests.set(tileKey, internalController);

        // 监听外部取消信号，联动内部 controller
        let externalAbortHandler: (() => void) | undefined;
        if (externalSignal !== undefined) {
            // 如果外部信号已经被中止，直接中止内部 controller
            if (externalSignal.aborted) {
                internalController.abort();
            } else {
                externalAbortHandler = () => { internalController.abort(); };
                externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        try {
            // 构建 fetch 请求选项
            const fetchOptions: RequestInit = {
                method: 'GET',
                signal: internalController.signal,
                headers: this._options.headers !== undefined ? { ...this._options.headers } : undefined,
            };

            if (__DEV__) {
                console.log(`[WMTSSource] 加载瓦片: ${tileKey} → ${tileUrl.substring(0, 120)}...`);
            }

            // 发起网络请求
            const response = await fetch(tileUrl, fetchOptions);

            // 检查 HTTP 状态码
            if (!response.ok) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    `WMTSSource: 瓦片请求失败 HTTP ${response.status} ${response.statusText}`,
                    { tileKey, url: tileUrl, status: response.status },
                );
            }

            // 读取响应体为 ArrayBuffer
            const data = await response.arrayBuffer();

            // 验证响应体非空
            if (data.byteLength === 0) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMTSSource: 瓦片响应体为空',
                    { tileKey, url: tileUrl },
                );
            }

            // 解析缓存过期时间
            const expiresAt = parseExpiresFromHeaders(
                response.headers,
                this._options.tileExpiration ?? DEFAULT_TILE_EXPIRATION_MS,
            );

            return {
                data,
                coord,
                expiresAt,
                byteSize: data.byteLength,
            };
        } catch (err: unknown) {
            // 区分取消和真正的错误
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMTSSource: 瓦片请求已取消',
                    { tileKey, aborted: true },
                );
            }

            // 已经是 GeoForgeError 直接重新抛出
            if (err instanceof GeoForgeError) {
                throw err;
            }

            // 包装未知错误
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `WMTSSource: 瓦片加载异常 (${tileKey})`,
                { tileKey, url: tileUrl },
                err instanceof Error ? err : new Error(String(err)),
            );
        } finally {
            // 清理：移除活跃请求记录
            this._activeRequests.delete(tileKey);

            // 移除外部信号监听器，避免内存泄漏
            if (externalAbortHandler !== undefined && externalSignal !== undefined) {
                externalSignal.removeEventListener('abort', externalAbortHandler);
            }
        }
    }

    /**
     * 取消指定瓦片坐标的加载请求。
     * 如果该瓦片有活跃的 fetch 请求，将通过 AbortController 取消。
     *
     * @param coord - 要取消的瓦片坐标
     *
     * @stability stable
     *
     * @example
     * source.cancelTile({ x: 215, y: 99, z: 8 });
     */
    cancelTile(coord: TileCoord): void {
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;
        const controller = this._activeRequests.get(tileKey);
        if (controller !== undefined) {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出，但防御性处理
            }
            this._activeRequests.delete(tileKey);
        }
    }

    /**
     * 获取 WMTS Capabilities 文档。
     * 首次调用时从服务器获取（当前 MVP 版本返回桩数据），后续返回缓存。
     * 解析完成后会更新 zoom → TileMatrix 映射表。
     *
     * @returns Capabilities 文档的 Promise
     * @throws {GeoForgeError} 当数据源已销毁或请求失败时
     *
     * @stability experimental
     *
     * @example
     * const caps = await source.getCapabilities();
     * console.log(caps.layers.map(l => l.identifier));
     */
    async getCapabilities(): Promise<WMTSCapabilities> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 数据源已销毁，无法获取 Capabilities',
                { layer: this._options.layer },
            );
        }

        // 返回缓存（如果有）
        if (this._capabilities !== null) {
            return this._capabilities;
        }

        try {
            // MVP 阶段：使用桩数据（后续版本将实现真实 XML 解析）
            // 真实实现应发送 GetCapabilities KVP 请求并解析 XML
            const caps = buildStubCapabilities(this._options);
            this._capabilities = caps;

            // 从 Capabilities 更新 zoom→matrixId 映射
            const targetSet = caps.matrixSets.find(
                (ms) => ms.identifier === this._options.matrixSet,
            );
            if (targetSet !== undefined) {
                this._zoomToMatrixId.clear();
                for (let i = 0; i < targetSet.matrices.length; i++) {
                    const matrix = targetSet.matrices[i];
                    const zoom = scaleToZoom(matrix.scaleDenominator, matrix.tileWidth);
                    this._zoomToMatrixId.set(zoom, matrix.identifier);
                }
            }

            if (__DEV__) {
                console.log(
                    `[WMTSSource] Capabilities 已加载: ${caps.layers.length} 图层, ${caps.matrixSets.length} 矩阵集`,
                );
            }

            return caps;
        } catch (err: unknown) {
            if (err instanceof GeoForgeError) {
                throw err;
            }
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMTSSource: 获取 Capabilities 失败',
                { url: this._options.url },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    /**
     * 动态设置或更新维度参数值。
     * 设置后后续的瓦片请求将携带新的维度值。
     * 常用于时间维度切换（如气象数据的 TIME 维度）。
     *
     * @param name - 维度名称（大小写敏感，如 'TIME'、'ELEVATION'）
     * @param value - 维度值（空字符串或 undefined 将删除该维度）
     *
     * @stability stable
     *
     * @example
     * source.setDimension('TIME', '2025-06-15T12:00:00Z');
     * source.setDimension('ELEVATION', '500');
     */
    setDimension(name: string, value: string | undefined): void {
        // 参数验证：name 不能为空
        if (name === undefined || name === null || name.trim().length === 0) {
            if (__DEV__) {
                console.warn('[WMTSSource] setDimension: 维度名称不能为空');
            }
            return;
        }

        if (value === undefined || value === null || value === '') {
            // 删除维度
            delete this._dimensions[name];
        } else {
            // 设置或更新维度
            this._dimensions[name] = value;
        }

        if (__DEV__) {
            console.log(`[WMTSSource] 维度已更新: ${name}=${value ?? '(deleted)'}`);
        }
    }
}
