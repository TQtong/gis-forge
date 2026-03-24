// ============================================================
// source-wfs/WFSSource.ts — OGC WFS 数据源（矢量要素服务）
// 职责：从 OGC WFS 服务获取矢量要素（Feature），支持 BBOX 和全量加载策略，
//       分页请求、CQL 过滤、BBOX 缓存去冗余。
// 支持 WFS 1.1.0 和 2.0.0 版本。
// 层级：L4 数据源（非图层，不参与渲染管线）
// 零 npm 依赖，所有功能自研。
// ============================================================

declare const __DEV__: boolean;

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

// ======================== 常量 ========================

/**
 * 默认 WFS 版本号。
 * WFS 2.0.0（OGC 09-025r2 / ISO 19142）为当前最新标准版本。
 *
 * @stability stable
 */
const DEFAULT_WFS_VERSION = '2.0.0';

/**
 * 默认输出格式。
 * GeoJSON 是 Web 环境中最易解析的格式，减少 GML→Feature 的额外转换。
 *
 * @stability stable
 */
const DEFAULT_OUTPUT_FORMAT = 'application/json';

/**
 * 默认空间参考系。
 * EPSG:4326（WGS-84 地理坐标系）是 GeoJSON 的标准 CRS。
 *
 * @stability stable
 */
const DEFAULT_SRS = 'EPSG:4326';

/**
 * 默认最大要素数量上限。
 * 防止无限量请求导致内存溢出，10000 是常见 WFS 服务的默认上限。
 *
 * @stability stable
 */
const DEFAULT_MAX_FEATURES = 10_000;

/**
 * 默认分页大小（每页要素数）。
 * 1000 在网络传输效率和解析延迟间取得平衡。
 *
 * @stability stable
 */
const DEFAULT_PAGE_SIZE = 1_000;

/**
 * 最大分页数安全限制。
 * 防止分页查询无限循环（如服务端返回数据不减少），最多请求 10 页。
 *
 * @stability stable
 */
const MAX_PAGES = 10;

/**
 * BBOX 缓存边距系数。
 * 扩大已缓存 BBOX 20%，当新请求范围完全落入扩展后的缓存范围时跳过请求。
 * 减少视口微移导致的频繁重请求。
 *
 * @stability stable
 */
const BBOX_CACHE_MARGIN = 0.2;

/**
 * 单页请求超时时间（毫秒）。
 *
 * @stability stable
 */
const PAGE_REQUEST_TIMEOUT_MS = 15_000;

// ======================== 类型定义 ========================

/**
 * WFS 协议版本。
 *
 * @stability stable
 */
export type WFSVersion = '1.1.0' | '2.0.0';

/**
 * WFS 加载策略。
 * - `'bbox'`：按视口范围请求，适合大数据集（默认）
 * - `'all'`：一次加载全部要素，适合小数据集
 *
 * @stability stable
 */
export type WFSStrategy = 'bbox' | 'all';

/**
 * WFS 数据源配置选项。
 *
 * @example
 * const options: WFSSourceOptions = {
 *   url: 'https://example.com/wfs',
 *   typeName: 'buildings',
 *   version: '2.0.0',
 *   strategy: 'bbox',
 *   pageSize: 1000,
 * };
 *
 * @stability stable
 */
export interface WFSSourceOptions {
    /**
     * WFS 服务端点 URL（不含查询参数）。
     * 必填项，不得为空。
     */
    readonly url: string;

    /**
     * 要素类型名称（TypeName）。
     * 对应 WFS Capabilities 中 <FeatureType><Name> 的值。
     * WFS 2.0.0 使用 typeNames（复数），1.1.0 使用 typeName（单数）。
     * 必填项，大小写敏感。
     */
    readonly typeName: string;

    /**
     * WFS 协议版本。
     * 默认值：`'2.0.0'`。
     */
    readonly version?: WFSVersion;

    /**
     * 输出格式（MIME 类型）。
     * 推荐使用 `'application/json'`（GeoJSON）。
     * 默认值：`'application/json'`。
     */
    readonly outputFormat?: string;

    /**
     * 空间参考系名称。
     * 默认值：`'EPSG:4326'`。
     */
    readonly srsName?: string;

    /**
     * 最大返回要素数。
     * 所有分页总和不超过此上限。
     * 默认值：`10000`。
     */
    readonly maxFeatures?: number;

    /**
     * CQL 过滤表达式。
     * 遵循 OGC CQL 语法，如 `"population > 100000 AND country = 'CN'"`。
     * 可选，运行时可通过 setCQLFilter 动态修改。
     */
    readonly cqlFilter?: string;

    /**
     * 请求的属性名列表。
     * 指定后仅返回这些属性字段，减少传输数据量。
     * 可选，undefined 表示返回所有属性。
     *
     * @example ['name', 'population', 'geometry']
     */
    readonly propertyNames?: string[];

    /**
     * 分页大小（每页要素数）。
     * 默认值：`1000`。
     */
    readonly pageSize?: number;

    /**
     * 自定义 HTTP 请求头。
     */
    readonly headers?: Record<string, string>;

    /**
     * 加载策略。
     * 默认值：`'bbox'`。
     */
    readonly strategy?: WFSStrategy;
}

/**
 * WFS DescribeFeatureType 结果。
 *
 * @stability experimental
 */
export interface WFSFeatureTypeDescription {
    /** 要素类型名称 */
    readonly typeName: string;

    /** 属性描述列表 */
    readonly properties: WFSPropertyDescriptor[];
}

/**
 * WFS 属性描述。
 *
 * @stability experimental
 */
export interface WFSPropertyDescriptor {
    /** 属性名称 */
    readonly name: string;

    /** 属性类型（如 'xsd:string'、'xsd:integer'、'gml:PointPropertyType'） */
    readonly type: string;

    /** 是否可为空 */
    readonly nillable: boolean;

    /** 最小出现次数 */
    readonly minOccurs: number;

    /** 最大出现次数（-1 表示无限） */
    readonly maxOccurs: number;
}

/**
 * WFS 数据源元数据。
 *
 * @stability stable
 */
export interface WFSSourceMetadata {
    /** 数据源类型标识 */
    readonly type: 'wfs';

    /** 要素类型名称 */
    readonly typeName: string;

    /** WFS 版本 */
    readonly version: WFSVersion;

    /** 输出格式 */
    readonly outputFormat: string;

    /** 空间参考系 */
    readonly srsName: string;

    /** 加载策略 */
    readonly strategy: WFSStrategy;

    /** 当前 CQL 过滤表达式 */
    readonly cqlFilter: string | undefined;

    /** 已加载的要素总数 */
    readonly loadedFeatureCount: number;

    /** 是否已初始化 */
    readonly initialized: boolean;
}

// ======================== 内部类型 ========================

/**
 * BBOX 缓存条目。
 * 存储已请求过的 BBOX 范围及对应要素，避免重复请求。
 */
interface BBoxCacheEntry {
    /** 已请求的 BBOX（扩展过边距的范围） */
    extent: BBox2D;

    /** 缓存的要素列表 */
    features: Feature[];

    /** 缓存创建时间戳 */
    timestamp: number;
}

// ======================== 内部工具函数 ========================

/**
 * 检查 target BBOX 是否完全包含在 container BBOX 内。
 * 用于 BBOX 缓存命中判断。
 *
 * @param container - 容器 BBOX
 * @param target - 目标 BBOX
 * @returns 是否完全包含
 *
 * @example
 * bboxContains({ west: 0, south: 0, east: 10, north: 10 },
 *              { west: 2, south: 2, east: 8, north: 8 }); // → true
 */
function bboxContains(container: BBox2D, target: BBox2D): boolean {
    return (
        container.west <= target.west &&
        container.south <= target.south &&
        container.east >= target.east &&
        container.north >= target.north
    );
}

/**
 * 按边距系数扩展 BBOX。
 * 各方向按总跨度的百分比扩展。
 *
 * @param bbox - 原始 BBOX
 * @param margin - 边距系数（0.2 = 20%）
 * @returns 扩展后的 BBOX
 *
 * @example
 * expandBBox({ west: 0, south: 0, east: 10, north: 10 }, 0.2);
 * // → { west: -2, south: -2, east: 12, north: 12 }
 */
function expandBBox(bbox: BBox2D, margin: number): BBox2D {
    const dw = (bbox.east - bbox.west) * margin;
    const dh = (bbox.north - bbox.south) * margin;

    return {
        west: bbox.west - dw,
        south: bbox.south - dh,
        east: bbox.east + dw,
        north: bbox.north + dh,
    };
}

/**
 * 将瓦片坐标转换为 WGS-84 经纬度 BBOX。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns WGS-84 BBOX
 */
function tileToWGS84BBox(x: number, y: number, z: number): BBox2D {
    const n = Math.pow(2, z);

    const west = (x / n) * 360.0 - 180.0;
    const east = ((x + 1) / n) * 360.0 - 180.0;

    const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

    const north = northRad * (180.0 / Math.PI);
    const south = southRad * (180.0 / Math.PI);

    return { west, south, east, north };
}

// ======================== WFSSource 类 ========================

/**
 * OGC WFS（Web Feature Service）数据源。
 *
 * 从 WFS 服务获取矢量要素（Feature），支持：
 * - BBOX 空间过滤加载和全量加载两种策略
 * - WFS 2.0.0 标准分页（STARTINDEX + COUNT）
 * - CQL 过滤器动态切换
 * - BBOX 缓存避免重复请求
 * - DescribeFeatureType 元数据查询
 *
 * 这是一个纯数据源，不继承 Layer，不参与渲染管线。
 *
 * @stability stable
 *
 * @example
 * const source = new WFSSource({
 *   url: 'https://example.com/wfs',
 *   typeName: 'buildings',
 *   strategy: 'bbox',
 * });
 * await source.initialize();
 * const features = await source.loadFeatures(
 *   { west: 116.0, south: 39.5, east: 117.0, north: 40.5 }, 12
 * );
 */
export class WFSSource {
    /** 数据源类型标识 */
    readonly type: 'wfs' = 'wfs';

    /** 配置选项 */
    private readonly _options: Readonly<WFSSourceOptions>;

    /** 生效的 WFS 版本 */
    private readonly _version: WFSVersion;

    /** 生效的输出格式 */
    private readonly _outputFormat: string;

    /** 生效的 SRS */
    private readonly _srsName: string;

    /** 生效的最大要素数 */
    private readonly _maxFeatures: number;

    /** 生效的分页大小 */
    private readonly _pageSize: number;

    /** 生效的加载策略 */
    private readonly _strategy: WFSStrategy;

    /** 当前 CQL 过滤器（可动态修改） */
    private _cqlFilter: string | undefined;

    /** 是否已初始化 */
    private _initialized: boolean;

    /** 是否已销毁 */
    private _destroyed: boolean;

    /** 全量加载策略下的要素缓存（strategy='all' 时使用） */
    private _allFeaturesCache: Feature[] | null;

    /** BBOX 缓存条目（strategy='bbox' 时使用） */
    private _bboxCache: BBoxCacheEntry | null;

    /** 活跃的请求 AbortController 映射（用于 cancelTile） */
    private readonly _activeRequests: Map<string, AbortController>;

    /** 已加载的要素总数（用于元数据报告） */
    private _loadedFeatureCount: number;

    /**
     * 创建 WFS 数据源实例。
     *
     * @param options - WFS 配置选项
     * @throws {GeoForgeError} 当 url 或 typeName 为空时
     *
     * @example
     * const source = new WFSSource({
     *   url: 'https://example.com/wfs',
     *   typeName: 'roads',
     * });
     */
    constructor(options: WFSSourceOptions) {
        // 参数验证：url 必须非空
        if (options.url === undefined || options.url === null || options.url.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: url 不能为空',
                { optionKeys: Object.keys(options) },
            );
        }

        // 参数验证：typeName 必须非空
        if (options.typeName === undefined || options.typeName === null || options.typeName.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: typeName 不能为空',
                { url: options.url },
            );
        }

        this._options = options;
        this._version = options.version ?? DEFAULT_WFS_VERSION;
        this._outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
        this._srsName = options.srsName ?? DEFAULT_SRS;
        this._maxFeatures = options.maxFeatures ?? DEFAULT_MAX_FEATURES;
        this._pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
        this._strategy = options.strategy ?? 'bbox';
        this._cqlFilter = options.cqlFilter;

        this._initialized = false;
        this._destroyed = false;
        this._allFeaturesCache = null;
        this._bboxCache = null;
        this._activeRequests = new Map<string, AbortController>();
        this._loadedFeatureCount = 0;
    }

    /**
     * 初始化数据源。
     *
     * @returns 初始化完成的 Promise
     * @throws {GeoForgeError} 当数据源已销毁时
     *
     * @stability stable
     */
    async initialize(): Promise<void> {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: 无法初始化已销毁的数据源',
                { typeName: this._options.typeName },
            );
        }

        if (this._initialized) {
            return;
        }

        this._initialized = true;

        if (__DEV__) {
            console.log(
                `[WFSSource] 初始化完成: typeName=${this._options.typeName}, version=${this._version}, strategy=${this._strategy}`,
            );
        }
    }

    /**
     * 销毁数据源，释放所有资源。
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

        // 清除缓存
        this._allFeaturesCache = null;
        this._bboxCache = null;
        this._loadedFeatureCount = 0;

        this._destroyed = true;
        this._initialized = false;

        if (__DEV__) {
            console.log(`[WFSSource] 已销毁: typeName=${this._options.typeName}`);
        }
    }

    /**
     * 获取数据源元数据。
     *
     * @returns 不可变元数据快照
     *
     * @stability stable
     */
    getMetadata(): WFSSourceMetadata {
        return {
            type: 'wfs',
            typeName: this._options.typeName,
            version: this._version,
            outputFormat: this._outputFormat,
            srsName: this._srsName,
            strategy: this._strategy,
            cqlFilter: this._cqlFilter,
            loadedFeatureCount: this._loadedFeatureCount,
            initialized: this._initialized,
        };
    }

    /**
     * 加载指定范围内的矢量要素。
     *
     * 根据 strategy 策略决定加载行为：
     * - `'bbox'`：按 extent 参数请求范围内的要素，支持 BBOX 缓存
     * - `'all'`：忽略 extent 参数，首次加载全部要素后缓存
     *
     * 支持分页请求（WFS 2.0.0 的 STARTINDEX + COUNT 参数），
     * 最多请求 MAX_PAGES（10）页，防止无限循环。
     *
     * @param extent - 请求范围（WGS-84 经纬度 BBOX），bbox 策略必需
     * @param zoom - 当前缩放级别（用于日志和策略判断）
     * @param signal - 可选的取消信号
     * @returns 要素数组的 Promise
     * @throws {GeoForgeError} 当未初始化、已销毁或请求失败时
     *
     * @stability stable
     *
     * @example
     * const features = await source.loadFeatures(
     *   { west: 116.0, south: 39.5, east: 117.0, north: 40.5 },
     *   12,
     *   abortController.signal,
     * );
     * console.log(`加载了 ${features.length} 个要素`);
     */
    async loadFeatures(extent: BBox2D, zoom: number, signal?: AbortSignal): Promise<Feature[]> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: 数据源已销毁',
                { typeName: this._options.typeName },
            );
        }

        if (!this._initialized) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: 数据源未初始化',
                { typeName: this._options.typeName },
            );
        }

        // 全量策略：从缓存返回（如已加载），否则加载一次
        if (this._strategy === 'all') {
            if (this._allFeaturesCache !== null) {
                return this._allFeaturesCache;
            }
            const features = await this._fetchAllFeatures(signal);
            this._allFeaturesCache = features;
            this._loadedFeatureCount = features.length;
            return features;
        }

        // BBOX 策略：检查缓存是否涵盖请求范围
        if (this._bboxCache !== null) {
            if (bboxContains(this._bboxCache.extent, extent)) {
                if (__DEV__) {
                    console.log(
                        `[WFSSource] BBOX 缓存命中: 缓存 ${this._bboxCache.features.length} 个要素`,
                    );
                }
                return this._bboxCache.features;
            }
        }

        // 缓存未命中或不覆盖：发起新请求
        const expandedExtent = expandBBox(extent, BBOX_CACHE_MARGIN);
        const features = await this._fetchFeaturesByBBox(expandedExtent, signal);

        // 更新 BBOX 缓存
        this._bboxCache = {
            extent: expandedExtent,
            features,
            timestamp: Date.now(),
        };
        this._loadedFeatureCount = features.length;

        if (__DEV__) {
            console.log(`[WFSSource] BBOX 加载完成: ${features.length} 个要素, zoom=${zoom}`);
        }

        return features;
    }

    /**
     * 取消指定瓦片坐标的加载请求。
     * WFS 是非瓦片化数据源，但为统一接口保留此方法。
     * 实际取消的是以 tileKey 为标识的请求。
     *
     * @param coord - 瓦片坐标
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
     * 查询要素类型描述信息（DescribeFeatureType）。
     * MVP 阶段返回基于配置的桩数据。
     *
     * @returns 要素类型描述的 Promise
     * @throws {GeoForgeError} 当数据源已销毁时
     *
     * @stability experimental
     *
     * @example
     * const desc = await source.describeFeatureType();
     * console.log(desc.properties.map(p => p.name));
     */
    async describeFeatureType(): Promise<WFSFeatureTypeDescription> {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: 数据源已销毁',
                { typeName: this._options.typeName },
            );
        }

        // MVP 桩数据
        return {
            typeName: this._options.typeName,
            properties: [
                { name: 'geometry', type: 'gml:GeometryPropertyType', nillable: false, minOccurs: 1, maxOccurs: 1 },
                { name: 'id', type: 'xsd:integer', nillable: false, minOccurs: 1, maxOccurs: 1 },
                { name: 'name', type: 'xsd:string', nillable: true, minOccurs: 0, maxOccurs: 1 },
            ],
        };
    }

    /**
     * 动态设置或清除 CQL 过滤器。
     * 更改后会清除缓存，下次 loadFeatures 将重新请求。
     *
     * @param filter - CQL 过滤表达式，undefined 或空字符串表示清除
     *
     * @stability stable
     *
     * @example
     * source.setCQLFilter("population > 100000");
     * source.setCQLFilter(undefined); // 清除过滤器
     */
    setCQLFilter(filter: string | undefined): void {
        const newFilter = (filter !== undefined && filter !== null && filter.trim().length > 0)
            ? filter.trim()
            : undefined;

        // 仅当过滤器实际变化时才清除缓存
        if (newFilter !== this._cqlFilter) {
            this._cqlFilter = newFilter;

            // 清除缓存，强制下次重新加载
            this._allFeaturesCache = null;
            this._bboxCache = null;

            if (__DEV__) {
                console.log(`[WFSSource] CQL 过滤器已更新: ${newFilter ?? '(cleared)'}`);
            }
        }
    }

    // ======================== 私有方法 ========================

    /**
     * 按 BBOX 分页获取要素。
     *
     * @param bbox - 查询范围
     * @param signal - 可选取消信号
     * @returns 要素数组
     */
    private async _fetchFeaturesByBBox(bbox: BBox2D, signal?: AbortSignal): Promise<Feature[]> {
        const allFeatures: Feature[] = [];
        let startIndex = 0;
        let pageCount = 0;

        // 分页循环：每次请求一页，直到无更多数据或达到上限
        while (pageCount < MAX_PAGES && allFeatures.length < this._maxFeatures) {
            // 检查取消信号
            if (signal !== undefined && signal.aborted) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WFSSource: 请求已取消',
                    { typeName: this._options.typeName, pageCount },
                );
            }

            // 计算本页实际请求数量（不超过总上限剩余）
            const remaining = this._maxFeatures - allFeatures.length;
            const count = Math.min(this._pageSize, remaining);

            // 构建 GetFeature URL
            const url = this._buildGetFeatureUrl(startIndex, count, bbox);

            if (__DEV__) {
                console.log(
                    `[WFSSource] 请求第 ${pageCount + 1} 页: startIndex=${startIndex}, count=${count}`,
                );
            }

            // 发起请求
            const pageFeatures = await this._fetchPage(url, signal);

            // 将本页要素追加到结果
            for (let i = 0; i < pageFeatures.length; i++) {
                allFeatures.push(pageFeatures[i]);
            }

            pageCount++;

            // 如果返回数少于请求数，说明已无更多数据
            if (pageFeatures.length < count) {
                break;
            }

            // 推进分页偏移
            startIndex += pageFeatures.length;
        }

        if (__DEV__) {
            console.log(
                `[WFSSource] BBOX 分页加载完成: ${allFeatures.length} 个要素, ${pageCount} 页`,
            );
        }

        return allFeatures;
    }

    /**
     * 全量获取所有要素（strategy='all'）。
     *
     * @param signal - 可选取消信号
     * @returns 要素数组
     */
    private async _fetchAllFeatures(signal?: AbortSignal): Promise<Feature[]> {
        const allFeatures: Feature[] = [];
        let startIndex = 0;
        let pageCount = 0;

        while (pageCount < MAX_PAGES && allFeatures.length < this._maxFeatures) {
            if (signal !== undefined && signal.aborted) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WFSSource: 请求已取消',
                    { typeName: this._options.typeName, pageCount },
                );
            }

            const remaining = this._maxFeatures - allFeatures.length;
            const count = Math.min(this._pageSize, remaining);

            // 全量请求不带 BBOX 参数
            const url = this._buildGetFeatureUrl(startIndex, count, undefined);

            const pageFeatures = await this._fetchPage(url, signal);

            for (let i = 0; i < pageFeatures.length; i++) {
                allFeatures.push(pageFeatures[i]);
            }

            pageCount++;

            if (pageFeatures.length < count) {
                break;
            }

            startIndex += pageFeatures.length;
        }

        if (__DEV__) {
            console.log(
                `[WFSSource] 全量加载完成: ${allFeatures.length} 个要素, ${pageCount} 页`,
            );
        }

        return allFeatures;
    }

    /**
     * 构建 GetFeature 请求 URL。
     *
     * @param startIndex - 分页起始索引
     * @param count - 本页请求数量
     * @param bbox - 可选的空间过滤 BBOX
     * @returns 完整 URL
     */
    private _buildGetFeatureUrl(startIndex: number, count: number, bbox?: BBox2D): string {
        const separator = this._options.url.includes('?') ? '&' : '?';

        // WFS 2.0.0 使用 typeNames（复数）和 COUNT，1.1.0 使用 typeName 和 MAXFEATURES
        const typeParamName = this._version === '2.0.0' ? 'typeNames' : 'typeName';
        const countParamName = this._version === '2.0.0' ? 'COUNT' : 'MAXFEATURES';

        const params: string[] = [
            'SERVICE=WFS',
            `VERSION=${this._version}`,
            'REQUEST=GetFeature',
            `${typeParamName}=${encodeURIComponent(this._options.typeName)}`,
            `OUTPUTFORMAT=${encodeURIComponent(this._outputFormat)}`,
            `SRSNAME=${encodeURIComponent(this._srsName)}`,
            `${countParamName}=${count}`,
            `STARTINDEX=${startIndex}`,
        ];

        // 追加 BBOX 空间过滤
        if (bbox !== undefined) {
            // WFS BBOX 格式：minx,miny,maxx,maxy[,srsName]
            params.push(
                `BBOX=${bbox.west},${bbox.south},${bbox.east},${bbox.north},${encodeURIComponent(this._srsName)}`,
            );
        }

        // 追加 CQL 过滤器
        if (this._cqlFilter !== undefined && this._cqlFilter.length > 0) {
            params.push(`CQL_FILTER=${encodeURIComponent(this._cqlFilter)}`);
        }

        // 追加属性名限制
        if (this._options.propertyNames !== undefined && this._options.propertyNames.length > 0) {
            params.push(
                `PROPERTYNAME=${encodeURIComponent(this._options.propertyNames.join(','))}`,
            );
        }

        return this._options.url + separator + params.join('&');
    }

    /**
     * 获取单页要素数据。
     *
     * @param url - GetFeature 请求 URL
     * @param signal - 可选取消信号
     * @returns 要素数组
     */
    private async _fetchPage(url: string, signal?: AbortSignal): Promise<Feature[]> {
        const controller = new AbortController();

        // 联动外部取消信号
        let externalAbortHandler: (() => void) | undefined;
        if (signal !== undefined) {
            if (signal.aborted) {
                controller.abort();
            } else {
                externalAbortHandler = () => { controller.abort(); };
                signal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        // 设置超时
        const timeoutId = setTimeout(() => controller.abort(), PAGE_REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: this._options.headers !== undefined ? { ...this._options.headers } : undefined,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    `WFSSource: GetFeature 请求失败 HTTP ${response.status}`,
                    { url: url.substring(0, 200), status: response.status },
                );
            }

            // 解析 JSON 响应
            const text = await response.text();
            if (text.trim().length === 0) {
                return [];
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch (parseErr: unknown) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.GEOJSON_PARSE_FAILED,
                    'WFSSource: 响应 JSON 解析失败',
                    { responseSnippet: text.substring(0, 200) },
                    parseErr instanceof Error ? parseErr : new Error(String(parseErr)),
                );
            }

            // 提取要素数组（支持 GeoJSON FeatureCollection 和裸 Feature 数组）
            return this._extractFeatures(parsed);
        } catch (err: unknown) {
            clearTimeout(timeoutId);

            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'WFSSource: 请求已取消或超时',
                    { url: url.substring(0, 200) },
                );
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'WFSSource: 请求异常',
                { url: url.substring(0, 200) },
                err instanceof Error ? err : new Error(String(err)),
            );
        } finally {
            if (externalAbortHandler !== undefined && signal !== undefined) {
                signal.removeEventListener('abort', externalAbortHandler);
            }
        }
    }

    /**
     * 从解析后的 JSON 中提取 Feature 数组。
     * 支持 GeoJSON FeatureCollection 格式和裸 Feature 数组。
     *
     * @param parsed - 解析后的 JSON 对象
     * @returns Feature 数组（可能为空）
     */
    private _extractFeatures(parsed: unknown): Feature[] {
        // null 或 undefined → 空数组
        if (parsed === null || parsed === undefined) {
            return [];
        }

        // GeoJSON FeatureCollection 格式
        if (
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>).type === 'FeatureCollection' &&
            Array.isArray((parsed as Record<string, unknown>).features)
        ) {
            const rawFeatures = (parsed as { features: unknown[] }).features;
            const result: Feature[] = [];
            for (let i = 0; i < rawFeatures.length; i++) {
                const f = rawFeatures[i] as Record<string, unknown>;
                // 基本类型守卫：确保有 type='Feature' 和 geometry 字段
                if (f !== null && typeof f === 'object' && f.type === 'Feature' && f.geometry !== undefined) {
                    result.push(f as unknown as Feature);
                }
            }
            return result;
        }

        // 裸 Feature 数组格式
        if (Array.isArray(parsed)) {
            const result: Feature[] = [];
            for (let i = 0; i < parsed.length; i++) {
                const f = parsed[i] as Record<string, unknown>;
                if (f !== null && typeof f === 'object' && f.type === 'Feature' && f.geometry !== undefined) {
                    result.push(f as unknown as Feature);
                }
            }
            return result;
        }

        // 单个 Feature 对象
        if (
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>).type === 'Feature' &&
            (parsed as Record<string, unknown>).geometry !== undefined
        ) {
            return [parsed as unknown as Feature];
        }

        // 未知格式返回空
        if (__DEV__) {
            console.warn('[WFSSource] 未知响应格式，无法提取要素');
        }
        return [];
    }
}
