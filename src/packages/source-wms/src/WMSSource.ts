// ============================================================
// source-wms/WMSSource.ts — OGC WMS 数据源（GetMap + GetFeatureInfo）
// 职责：从 OGC WMS 服务获取栅格瓦片和要素信息查询。
// 支持 WMS 1.1.1 和 1.3.0 版本，处理 BBOX 轴序差异。
// 层级：L4 数据源（非图层，不参与渲染管线）
// 零 npm 依赖，所有功能自研。
// ============================================================

declare const __DEV__: boolean;

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

// ======================== 常量 ========================

/**
 * 默认 WMS 版本号。
 * 1.3.0 为当前最新 OGC 标准版本（OGC 06-042），推荐使用。
 * 注意：1.3.0 对部分 CRS（如 EPSG:4326）有轴序反转行为。
 *
 * @stability stable
 */
const DEFAULT_WMS_VERSION = '1.3.0';

/**
 * 默认坐标参考系。
 * EPSG:3857（Web 墨卡托）是 Web 地图领域最广泛使用的投影坐标系。
 * BBOX 轴序固定为 [minX, minY, maxX, maxY]（东-北方向）。
 *
 * @stability stable
 */
const DEFAULT_CRS = 'EPSG:3857';

/**
 * 默认输出格式（MIME 类型）。
 * image/png 支持透明通道，适合叠加图层。
 *
 * @stability stable
 */
const DEFAULT_FORMAT = 'image/png';

/**
 * 默认瓦片尺寸（像素）。
 * 256×256 是 Web 地图瓦片的事实标准尺寸。
 *
 * @stability stable
 */
const DEFAULT_TILE_SIZE = 256;

/**
 * GetCapabilities 请求超时时间（毫秒）。
 *
 * @stability stable
 */
const CAPABILITIES_TIMEOUT_MS = 10_000;

/**
 * GetFeatureInfo 请求超时时间（毫秒）。
 *
 * @stability stable
 */
const FEATURE_INFO_TIMEOUT_MS = 8_000;

/**
 * 默认瓦片过期时间增量（毫秒），24 小时。
 *
 * @stability stable
 */
const DEFAULT_TILE_EXPIRATION_MS = 86_400_000;

/**
 * 地球赤道周长（米），用于 TileCoord → BBOX 转换（Web 墨卡托投影）。
 * 等于 WGS-84 赤道半径 6378137m × 2π。
 *
 * @stability stable
 */
const EARTH_CIRCUMFERENCE = 40_075_016.685578488;

/**
 * Web 墨卡托半周长（米），即坐标系 X/Y 轴的最大绝对值。
 * 等于 EARTH_CIRCUMFERENCE / 2。
 *
 * @stability stable
 */
const HALF_CIRCUMFERENCE = EARTH_CIRCUMFERENCE / 2;

/**
 * Web 墨卡托最大纬度界限（度）。
 * 超出此范围的纬度在 Mercator 投影中趋于无穷大。
 *
 * @stability stable
 */
const MAX_MERCATOR_LATITUDE = 85.05112878;

/**
 * 需要轴序反转的 CRS 列表（WMS 1.3.0 下）。
 * 这些 CRS 在 WMS 1.3.0 中 BBOX 参数使用 [lat, lon] 而非 [lon, lat]。
 * 来源：OGC WMS 1.3.0 §6.7.2 + EPSG 数据库轴定义。
 *
 * @stability stable
 */
const AXIS_REVERSED_CRS = new Set<string>([
    'EPSG:4326',
    'CRS:84',
    'EPSG:4258',
    'EPSG:4269',
    'EPSG:4267',
]);

/**
 * 最大缩放级别上限。
 *
 * @stability stable
 */
const MAX_ZOOM = 22;

// ======================== 类型定义 ========================

/**
 * WMS 协议版本。
 * - `'1.1.1'`：广泛支持的旧版，BBOX 始终为 [minX, minY, maxX, maxY]
 * - `'1.3.0'`：当前标准，部分 CRS 有轴序反转
 *
 * @stability stable
 */
export type WMSVersion = '1.1.1' | '1.3.0';

/**
 * WMS 数据源配置选项。
 *
 * @example
 * const options: WMSSourceOptions = {
 *   url: 'https://example.com/wms',
 *   layers: 'roads,buildings',
 *   version: '1.3.0',
 *   crs: 'EPSG:3857',
 *   format: 'image/png',
 *   transparent: true,
 *   tileSize: 256,
 * };
 *
 * @stability stable
 */
export interface WMSSourceOptions {
    /**
     * WMS 服务端点 URL（不含查询参数）。
     * 必填项，不得为空。
     */
    readonly url: string;

    /**
     * 请求的图层名列表（逗号分隔字符串）。
     * 对应 WMS GetMap 的 LAYERS 参数。
     * 必填项，至少包含一个图层名。
     *
     * @example 'roads,buildings,labels'
     */
    readonly layers: string;

    /**
     * WMS 协议版本。
     * 默认值：`'1.3.0'`。
     */
    readonly version?: WMSVersion;

    /**
     * 坐标参考系标识符。
     * WMS 1.1.1 使用 SRS 参数，1.3.0 使用 CRS 参数。
     * 默认值：`'EPSG:3857'`。
     */
    readonly crs?: string;

    /**
     * 输出图像格式（MIME 类型）。
     * 默认值：`'image/png'`。
     */
    readonly format?: string;

    /**
     * 是否请求透明背景。
     * 对应 GetMap 的 TRANSPARENT 参数。
     * 默认值：`true`。
     */
    readonly transparent?: boolean;

    /**
     * 图层样式列表（逗号分隔字符串）。
     * 与 layers 一一对应，空字符串表示使用默认样式。
     * 可选，未设置时服务端使用默认样式。
     *
     * @example 'road_style,building_style,'
     */
    readonly styles?: string;

    /**
     * 瓦片尺寸（像素），256 或 512。
     * 影响 GetMap 请求的 WIDTH/HEIGHT 参数和 BBOX 计算。
     * 默认值：`256`。
     */
    readonly tileSize?: 256 | 512;

    /**
     * 自定义查询参数。
     * 附加到每个 GetMap 请求 URL 中的额外键值对。
     * 不得覆盖标准 WMS 参数（如 SERVICE、VERSION、REQUEST 等）。
     */
    readonly customParams?: Record<string, string>;

    /**
     * 自定义 HTTP 请求头。
     * 用于鉴权或自定义 User-Agent。
     */
    readonly headers?: Record<string, string>;
}

/**
 * WMS 瓦片加载参数。
 *
 * @stability stable
 */
export interface WMSTileLoadParams {
    /** 瓦片坐标 */
    readonly coord: TileCoord;

    /** 请求取消信号 */
    readonly signal?: AbortSignal;
}

/**
 * WMS 瓦片加载结果。
 *
 * @stability stable
 */
export interface WMSTileLoadResult {
    /** 瓦片图像二进制数据 */
    readonly data: ArrayBuffer;

    /** 瓦片坐标 */
    readonly coord: TileCoord;

    /** 缓存过期时间戳（Unix 毫秒） */
    readonly expiresAt?: number;

    /** 瓦片字节大小 */
    readonly byteSize: number;
}

/**
 * GetFeatureInfo 查询结果。
 *
 * @stability stable
 */
export interface WMSFeatureInfoResult {
    /** 原始响应文本内容（GML/JSON/HTML/TEXT，取决于服务配置） */
    readonly content: string;

    /** 响应的 Content-Type */
    readonly contentType: string;

    /** 查询的经度（WGS-84） */
    readonly longitude: number;

    /** 查询的纬度（WGS-84） */
    readonly latitude: number;
}

/**
 * WMS Capabilities 简要结果。
 *
 * @stability experimental
 */
export interface WMSCapabilities {
    /** 服务标题 */
    readonly title: string;

    /** 服务摘要 */
    readonly abstract: string;

    /** 可用图层列表 */
    readonly layers: WMSLayerDescriptor[];

    /** 支持的输出格式列表 */
    readonly formats: string[];
}

/**
 * WMS 图层描述信息。
 *
 * @stability experimental
 */
export interface WMSLayerDescriptor {
    /** 图层名称（用于 LAYERS 参数） */
    readonly name: string;

    /** 图层标题（可读） */
    readonly title: string;

    /** 图层是否可查询（支持 GetFeatureInfo） */
    readonly queryable: boolean;

    /** 支持的 CRS 列表 */
    readonly crsList: string[];

    /** 地理范围（WGS-84），可选 */
    readonly wgs84BBox?: BBox2D;
}

/**
 * WMS 数据源元数据。
 *
 * @stability stable
 */
export interface WMSSourceMetadata {
    /** 数据源类型标识 */
    readonly type: 'wms';

    /** 请求的图层列表 */
    readonly layers: string;

    /** WMS 版本 */
    readonly version: WMSVersion;

    /** 坐标参考系 */
    readonly crs: string;

    /** 输出格式 */
    readonly format: string;

    /** 瓦片尺寸 */
    readonly tileSize: number;

    /** 是否已初始化 */
    readonly initialized: boolean;
}

// ======================== 内部工具函数 ========================

/**
 * 将瓦片坐标转换为 Web 墨卡托投影 BBOX（单位：米）。
 * 基于标准 Slippy Map 瓦片编号方案计算。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns Web 墨卡托 BBOX [west, south, east, north]（单位：米）
 *
 * @example
 * const bbox = tileToMercatorBBox(0, 0, 1); // 左上瓦片
 */
function tileToMercatorBBox(x: number, y: number, z: number): BBox2D {
    // 瓦片总数 = 2^z
    const n = Math.pow(2, z);

    // 每个瓦片在投影空间中的跨度（米）
    const tileSpan = EARTH_CIRCUMFERENCE / n;

    // 计算四边界（Web 墨卡托原点在左上角 [-20037508, 20037508]）
    const west = x * tileSpan - HALF_CIRCUMFERENCE;
    const east = (x + 1) * tileSpan - HALF_CIRCUMFERENCE;

    // Y 轴反向：瓦片 y=0 对应北极方向
    const north = HALF_CIRCUMFERENCE - y * tileSpan;
    const south = HALF_CIRCUMFERENCE - (y + 1) * tileSpan;

    return { west, south, east, north };
}

/**
 * 将瓦片坐标转换为 WGS-84 经纬度 BBOX。
 * 使用 Web 墨卡托逆投影公式。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns WGS-84 BBOX [west, south, east, north]（单位：度）
 *
 * @example
 * const bbox = tileToWGS84BBox(0, 0, 1);
 */
function tileToWGS84BBox(x: number, y: number, z: number): BBox2D {
    const n = Math.pow(2, z);

    // 经度线性映射：[0, n) → [-180, 180)
    const west = (x / n) * 360.0 - 180.0;
    const east = ((x + 1) / n) * 360.0 - 180.0;

    // 纬度通过 Mercator 逆公式计算：lat = atan(sinh(π - 2π·y/n))
    const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

    // 弧度 → 度
    const north = northRad * (180.0 / Math.PI);
    const south = southRad * (180.0 / Math.PI);

    return { west, south, east, north };
}

/**
 * 判断指定 CRS 在 WMS 1.3.0 中是否需要轴序反转。
 * WMS 1.3.0 标准规定：某些地理坐标系（如 EPSG:4326）的 BBOX
 * 参数轴序为 [lat, lon]（即 [south, west, north, east]），
 * 而非直觉上的 [west, south, east, north]。
 *
 * @param version - WMS 版本号
 * @param crs - 坐标参考系标识符
 * @returns 是否需要反转轴序
 *
 * @example
 * isAxisReversed('1.3.0', 'EPSG:4326'); // → true
 * isAxisReversed('1.1.1', 'EPSG:4326'); // → false
 * isAxisReversed('1.3.0', 'EPSG:3857'); // → false
 */
function isAxisReversed(version: WMSVersion, crs: string): boolean {
    // WMS 1.1.1 始终使用 [minX, minY, maxX, maxY]，无轴序反转
    if (version === '1.1.1') {
        return false;
    }

    // WMS 1.3.0：检查 CRS 是否在反转列表中（大写归一化）
    return AXIS_REVERSED_CRS.has(crs.toUpperCase());
}

/**
 * 格式化 BBOX 参数字符串，处理轴序反转。
 *
 * @param bbox - 标准 BBOX (west, south, east, north)
 * @param version - WMS 版本
 * @param crs - 坐标参考系
 * @returns BBOX 参数字符串
 *
 * @example
 * formatBBox({ west: -180, south: -90, east: 180, north: 90 }, '1.3.0', 'EPSG:4326');
 * // → '-90,-180,90,180'（lat,lon 轴序）
 */
function formatBBox(bbox: BBox2D, version: WMSVersion, crs: string): string {
    if (isAxisReversed(version, crs)) {
        // 轴序反转：[minY, minX, maxY, maxX] = [south, west, north, east]
        return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    }
    // 标准轴序：[minX, minY, maxX, maxY] = [west, south, east, north]
    return `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
}

/**
 * 将 WGS-84 经纬度转换为 Web 墨卡托坐标（米）。
 *
 * @param lon - 经度（度），范围 [-180, 180]
 * @param lat - 纬度（度），范围 [-85.05, 85.05]
 * @returns [x, y] 墨卡托坐标（米）
 *
 * @example
 * const [mx, my] = lonLatToMercator(116.39, 39.91);
 */
function lonLatToMercator(lon: number, lat: number): [number, number] {
    // 经度线性映射
    const x = (lon / 180.0) * HALF_CIRCUMFERENCE;

    // 纬度通过 Mercator 正投影公式
    const clampedLat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat));
    const latRad = (clampedLat * Math.PI) / 180.0;
    const y = (Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0)) / Math.PI) * HALF_CIRCUMFERENCE;

    return [x, y];
}

/**
 * 从 HTTP 响应头解析缓存过期时间。
 *
 * @param headers - fetch 响应的 Headers 对象
 * @param fallbackMs - 回退过期时间（毫秒）
 * @returns 过期时间戳（Unix 毫秒）
 */
function parseExpiresFromHeaders(headers: Headers, fallbackMs?: number): number | undefined {
    // 优先解析 Cache-Control: max-age=<seconds>
    const cacheControl = headers.get('Cache-Control');
    if (cacheControl !== null && cacheControl.length > 0) {
        const maxAgeMatch = cacheControl.match(/max-age\s*=\s*(\d+)/i);
        if (maxAgeMatch !== null && maxAgeMatch[1] !== undefined) {
            const maxAgeSec = parseInt(maxAgeMatch[1], 10);
            if (Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
                return Date.now() + maxAgeSec * 1000;
            }
        }
    }

    // 其次解析 Expires 头
    const expiresStr = headers.get('Expires');
    if (expiresStr !== null && expiresStr.length > 0) {
        const expiresTimestamp = Date.parse(expiresStr);
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

// ======================== WMSSource 类 ========================

/**
 * OGC WMS（Web Map Service）数据源。
 *
 * 支持 WMS 1.1.1 和 1.3.0 版本，自动处理 BBOX 轴序差异。
 * 提供 GetMap（瓦片化请求）和 GetFeatureInfo（点查询）能力。
 *
 * 这是一个纯数据源，不继承 Layer，不参与渲染管线。
 * 由上层图层（如 RasterTileLayer）组合使用。
 *
 * @stability stable
 *
 * @example
 * const source = new WMSSource({
 *   url: 'https://maps.example.com/wms',
 *   layers: 'roads,buildings',
 *   version: '1.3.0',
 *   crs: 'EPSG:3857',
 * });
 * await source.initialize();
 * const tile = await source.loadTile({ coord: { x: 1, y: 0, z: 1 } });
 */
export class WMSSource {
    /** 数据源类型标识 */
    readonly type: 'wms' = 'wms';

    /** 配置选项 */
    private readonly _options: Readonly<WMSSourceOptions>;

    /** 生效的 WMS 版本 */
    private readonly _version: WMSVersion;

    /** 生效的 CRS */
    private readonly _crs: string;

    /** 生效的输出格式 */
    private readonly _format: string;

    /** 是否请求透明背景 */
    private readonly _transparent: boolean;

    /** 生效的瓦片尺寸 */
    private readonly _tileSize: number;

    /** 是否已初始化 */
    private _initialized: boolean;

    /** 是否已销毁 */
    private _destroyed: boolean;

    /** 缓存的 Capabilities 结果 */
    private _capabilities: WMSCapabilities | null;

    /** 活跃的瓦片请求映射 */
    private readonly _activeRequests: Map<string, AbortController>;

    /**
     * 创建 WMS 数据源实例。
     *
     * @param options - WMS 配置选项
     * @throws {GeoForgeError} 当 url 或 layers 为空时
     *
     * @example
     * const source = new WMSSource({
     *   url: 'https://example.com/wms',
     *   layers: 'topo',
     * });
     */
    constructor(options: WMSSourceOptions) {
        // 参数验证：url 必须非空
        if (options.url === undefined || options.url === null || options.url.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: url 不能为空',
                { optionKeys: Object.keys(options) },
            );
        }

        // 参数验证：layers 必须非空
        if (options.layers === undefined || options.layers === null || options.layers.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: layers 不能为空',
                { url: options.url },
            );
        }

        this._options = options;
        this._version = options.version ?? DEFAULT_WMS_VERSION;
        this._crs = options.crs ?? DEFAULT_CRS;
        this._format = options.format ?? DEFAULT_FORMAT;
        this._transparent = options.transparent ?? true;
        this._tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;

        this._initialized = false;
        this._destroyed = false;
        this._capabilities = null;
        this._activeRequests = new Map<string, AbortController>();
    }

    /**
     * 初始化数据源。
     * 验证配置并准备内部状态。
     *
     * @returns 初始化完成的 Promise
     * @throws {GeoForgeError} 当数据源已销毁时
     *
     * @stability stable
     *
     * @example
     * await source.initialize();
     */
    async initialize(): Promise<void> {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 无法初始化已销毁的数据源',
                { layers: this._options.layers },
            );
        }

        // 幂等
        if (this._initialized) {
            return;
        }

        this._initialized = true;

        if (__DEV__) {
            console.log(
                `[WMSSource] 初始化完成: layers=${this._options.layers}, version=${this._version}, crs=${this._crs}`,
            );
        }
    }

    /**
     * 销毁数据源，释放所有资源。
     * 取消所有进行中的请求。
     *
     * @stability stable
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }

        // 取消所有活跃请求
        this._activeRequests.forEach((controller) => {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出
            }
        });
        this._activeRequests.clear();

        this._capabilities = null;
        this._destroyed = true;
        this._initialized = false;

        if (__DEV__) {
            console.log(`[WMSSource] 已销毁: layers=${this._options.layers}`);
        }
    }

    /**
     * 获取数据源元数据。
     *
     * @returns 不可变元数据快照
     *
     * @stability stable
     */
    getMetadata(): WMSSourceMetadata {
        return {
            type: 'wms',
            layers: this._options.layers,
            version: this._version,
            crs: this._crs,
            format: this._format,
            tileSize: this._tileSize,
            initialized: this._initialized,
        };
    }

    /**
     * 加载指定坐标的瓦片（通过 WMS GetMap 请求）。
     * 根据瓦片坐标计算 BBOX，构建 GetMap URL，发起请求。
     *
     * @param params - 瓦片加载参数
     * @returns 瓦片数据的 Promise
     * @throws {GeoForgeError} 当未初始化、已销毁或请求失败时
     *
     * @stability stable
     *
     * @example
     * const result = await source.loadTile({
     *   coord: { x: 215, y: 99, z: 8 },
     * });
     */
    async loadTile(params: WMSTileLoadParams): Promise<WMSTileLoadResult> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 数据源已销毁',
                { coord: params.coord },
            );
        }

        if (!this._initialized) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 数据源未初始化，请先调用 initialize()',
                { coord: params.coord },
            );
        }

        const { coord, signal: externalSignal } = params;

        // 验证坐标有效性
        if (coord.z < 0 || coord.z > MAX_ZOOM || coord.x < 0 || coord.y < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 无效的瓦片坐标',
                { x: coord.x, y: coord.y, z: coord.z },
            );
        }

        const maxTileIndex = Math.pow(2, coord.z) - 1;
        if (coord.x > maxTileIndex || coord.y > maxTileIndex) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 瓦片坐标超出范围',
                { x: coord.x, y: coord.y, z: coord.z, maxIndex: maxTileIndex },
            );
        }

        // 根据 CRS 计算 BBOX
        let bbox: BBox2D;
        const isMercator = this._crs === 'EPSG:3857' || this._crs === 'EPSG:900913';
        if (isMercator) {
            // Web 墨卡托投影 BBOX（单位：米）
            bbox = tileToMercatorBBox(coord.x, coord.y, coord.z);
        } else {
            // WGS-84 或其他地理 CRS：使用经纬度 BBOX
            bbox = tileToWGS84BBox(coord.x, coord.y, coord.z);
        }

        // 构建 BBOX 字符串（处理轴序反转）
        const bboxStr = formatBBox(bbox, this._version, this._crs);

        // 构建 GetMap URL
        const separator = this._options.url.includes('?') ? '&' : '?';

        // 版本决定 CRS/SRS 参数名
        const crsParamName = this._version === '1.3.0' ? 'CRS' : 'SRS';

        const queryParams: string[] = [
            'SERVICE=WMS',
            `VERSION=${this._version}`,
            'REQUEST=GetMap',
            `LAYERS=${encodeURIComponent(this._options.layers)}`,
            `${crsParamName}=${encodeURIComponent(this._crs)}`,
            `BBOX=${bboxStr}`,
            `WIDTH=${this._tileSize}`,
            `HEIGHT=${this._tileSize}`,
            `FORMAT=${encodeURIComponent(this._format)}`,
            `TRANSPARENT=${this._transparent ? 'TRUE' : 'FALSE'}`,
        ];

        // 追加样式参数
        if (this._options.styles !== undefined && this._options.styles !== null) {
            queryParams.push(`STYLES=${encodeURIComponent(this._options.styles)}`);
        } else {
            // WMS 标准要求 STYLES 参数存在（可为空）
            queryParams.push('STYLES=');
        }

        // 追加自定义参数
        if (this._options.customParams !== undefined && this._options.customParams !== null) {
            const customKeys = Object.keys(this._options.customParams);
            for (let i = 0; i < customKeys.length; i++) {
                const key = customKeys[i];
                const value = this._options.customParams[key];
                if (value !== undefined && value !== null) {
                    queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
                }
            }
        }

        const tileUrl = this._options.url + separator + queryParams.join('&');
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;

        // 创建内部 AbortController
        const internalController = new AbortController();
        this._activeRequests.set(tileKey, internalController);

        // 联动外部取消信号
        let externalAbortHandler: (() => void) | undefined;
        if (externalSignal !== undefined) {
            if (externalSignal.aborted) {
                internalController.abort();
            } else {
                externalAbortHandler = () => { internalController.abort(); };
                externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        try {
            const fetchOptions: RequestInit = {
                method: 'GET',
                signal: internalController.signal,
                headers: this._options.headers !== undefined ? { ...this._options.headers } : undefined,
            };

            if (__DEV__) {
                console.log(`[WMSSource] 加载瓦片: ${tileKey} → ${tileUrl.substring(0, 120)}...`);
            }

            const response = await fetch(tileUrl, fetchOptions);

            if (!response.ok) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    `WMSSource: GetMap 请求失败 HTTP ${response.status}`,
                    { tileKey, url: tileUrl, status: response.status },
                );
            }

            // 检查响应是否为 XML 错误（WMS 服务有时返回 200 但内容是 ServiceException XML）
            const contentType = response.headers.get('Content-Type') ?? '';
            if (contentType.includes('xml') || contentType.includes('text/plain')) {
                const text = await response.text();
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMSSource: 服务返回错误响应（非图像）',
                    { tileKey, contentType, responseSnippet: text.substring(0, 200) },
                );
            }

            const data = await response.arrayBuffer();

            if (data.byteLength === 0) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMSSource: 瓦片响应体为空',
                    { tileKey },
                );
            }

            const expiresAt = parseExpiresFromHeaders(response.headers, DEFAULT_TILE_EXPIRATION_MS);

            return {
                data,
                coord,
                expiresAt,
                byteSize: data.byteLength,
            };
        } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMSSource: 瓦片请求已取消',
                    { tileKey, aborted: true },
                );
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `WMSSource: 瓦片加载异常 (${tileKey})`,
                { tileKey, url: tileUrl },
                err instanceof Error ? err : new Error(String(err)),
            );
        } finally {
            this._activeRequests.delete(tileKey);
            if (externalAbortHandler !== undefined && externalSignal !== undefined) {
                externalSignal.removeEventListener('abort', externalAbortHandler);
            }
        }
    }

    /**
     * 取消指定瓦片坐标的加载请求。
     *
     * @param coord - 要取消的瓦片坐标
     *
     * @stability stable
     */
    cancelTile(coord: TileCoord): void {
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;
        const controller = this._activeRequests.get(tileKey);
        if (controller !== undefined) {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出
            }
            this._activeRequests.delete(tileKey);
        }
    }

    /**
     * 执行 GetFeatureInfo 点查询。
     * 给定经纬度和缩放级别，向 WMS 服务查询该位置的要素信息。
     *
     * @param lon - 查询点经度（WGS-84，度），范围 [-180, 180]
     * @param lat - 查询点纬度（WGS-84，度），范围 [-90, 90]
     * @param zoom - 当前缩放级别（用于确定查询的空间分辨率）
     * @returns 要素信息查询结果的 Promise
     * @throws {GeoForgeError} 当未初始化、已销毁或请求失败时
     *
     * @stability stable
     *
     * @example
     * const info = await source.getFeatureInfo(116.39, 39.91, 12);
     * console.log(info.content); // GML/JSON/HTML 响应
     */
    async getFeatureInfo(lon: number, lat: number, zoom: number): Promise<WMSFeatureInfoResult> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 数据源已销毁',
                { lon, lat, zoom },
            );
        }

        if (!this._initialized) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 数据源未初始化',
                { lon, lat, zoom },
            );
        }

        // 验证经纬度范围
        if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 经度超出范围 [-180, 180]',
                { lon },
            );
        }

        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 纬度超出范围 [-90, 90]',
                { lat },
            );
        }

        // 钳位 zoom 到合法范围
        const clampedZoom = Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)));

        // 将经纬度转换为瓦片坐标，以确定查询的 BBOX
        const n = Math.pow(2, clampedZoom);
        const tileX = Math.floor(((lon + 180.0) / 360.0) * n);
        const latRad = (lat * Math.PI) / 180.0;
        const tileY = Math.floor((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n);

        // 计算 BBOX
        const isMercator = this._crs === 'EPSG:3857' || this._crs === 'EPSG:900913';
        let bbox: BBox2D;
        if (isMercator) {
            bbox = tileToMercatorBBox(tileX, tileY, clampedZoom);
        } else {
            bbox = tileToWGS84BBox(tileX, tileY, clampedZoom);
        }
        const bboxStr = formatBBox(bbox, this._version, this._crs);

        // 计算查询点在瓦片内的像素坐标
        let pixelX: number;
        let pixelY: number;
        if (isMercator) {
            // 将经纬度转为墨卡托坐标，再映射到瓦片像素空间
            const [mx, my] = lonLatToMercator(lon, lat);
            pixelX = Math.round(((mx - bbox.west) / (bbox.east - bbox.west)) * this._tileSize);
            pixelY = Math.round(((bbox.north - my) / (bbox.north - bbox.south)) * this._tileSize);
        } else {
            // 地理坐标直接映射到像素空间
            pixelX = Math.round(((lon - bbox.west) / (bbox.east - bbox.west)) * this._tileSize);
            pixelY = Math.round(((bbox.north - lat) / (bbox.north - bbox.south)) * this._tileSize);
        }

        // 钳位像素坐标到有效范围
        pixelX = Math.max(0, Math.min(this._tileSize - 1, pixelX));
        pixelY = Math.max(0, Math.min(this._tileSize - 1, pixelY));

        // 版本决定像素坐标参数名和 CRS/SRS 参数名
        const crsParamName = this._version === '1.3.0' ? 'CRS' : 'SRS';
        const xParamName = this._version === '1.3.0' ? 'I' : 'X';
        const yParamName = this._version === '1.3.0' ? 'J' : 'Y';

        // 构建 GetFeatureInfo URL
        const separator = this._options.url.includes('?') ? '&' : '?';
        const queryParams: string[] = [
            'SERVICE=WMS',
            `VERSION=${this._version}`,
            'REQUEST=GetFeatureInfo',
            `LAYERS=${encodeURIComponent(this._options.layers)}`,
            `QUERY_LAYERS=${encodeURIComponent(this._options.layers)}`,
            `${crsParamName}=${encodeURIComponent(this._crs)}`,
            `BBOX=${bboxStr}`,
            `WIDTH=${this._tileSize}`,
            `HEIGHT=${this._tileSize}`,
            `${xParamName}=${pixelX}`,
            `${yParamName}=${pixelY}`,
            'INFO_FORMAT=application/json',
            'FEATURE_COUNT=10',
        ];

        if (this._options.styles !== undefined) {
            queryParams.push(`STYLES=${encodeURIComponent(this._options.styles)}`);
        } else {
            queryParams.push('STYLES=');
        }

        const infoUrl = this._options.url + separator + queryParams.join('&');

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FEATURE_INFO_TIMEOUT_MS);

            const response = await fetch(infoUrl, {
                method: 'GET',
                signal: controller.signal,
                headers: this._options.headers !== undefined ? { ...this._options.headers } : undefined,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    `WMSSource: GetFeatureInfo 请求失败 HTTP ${response.status}`,
                    { url: infoUrl, status: response.status },
                );
            }

            const content = await response.text();
            const contentType = response.headers.get('Content-Type') ?? 'text/plain';

            return {
                content,
                contentType,
                longitude: lon,
                latitude: lat,
            };
        } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WMSSource: GetFeatureInfo 请求超时',
                    { lon, lat, zoom, timeoutMs: FEATURE_INFO_TIMEOUT_MS },
                );
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: GetFeatureInfo 请求异常',
                { lon, lat, zoom },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    /**
     * 获取 WMS Capabilities 文档。
     * MVP 阶段返回基于当前配置的桩数据。
     *
     * @returns Capabilities 的 Promise
     * @throws {GeoForgeError} 当数据源已销毁时
     *
     * @stability experimental
     *
     * @example
     * const caps = await source.getCapabilities();
     * console.log(caps.layers.map(l => l.name));
     */
    async getCapabilities(): Promise<WMSCapabilities> {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WMSSource: 数据源已销毁',
                { layers: this._options.layers },
            );
        }

        // 返回缓存
        if (this._capabilities !== null) {
            return this._capabilities;
        }

        // MVP 桩数据
        const layerNames = this._options.layers.split(',').map((name) => name.trim()).filter((name) => name.length > 0);

        const caps: WMSCapabilities = {
            title: 'WMS Service (stub)',
            abstract: '',
            layers: layerNames.map((name) => ({
                name,
                title: name,
                queryable: true,
                crsList: [this._crs, 'EPSG:4326', 'EPSG:3857'],
                wgs84BBox: { west: -180, south: -85.05112878, east: 180, north: 85.05112878 },
            })),
            formats: [this._format, 'image/png', 'image/jpeg'],
        };

        this._capabilities = caps;

        if (__DEV__) {
            console.log(`[WMSSource] Capabilities 已加载 (stub): ${caps.layers.length} 图层`);
        }

        return caps;
    }
}
