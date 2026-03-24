/**
 * @file GeoForge L5 — EP3 Data Source（自定义数据源扩展点）
 *
 * @description
 * **EP3** 抽象矢量/栅格/流式数据入口：`DataSource` 负责元数据、瓦片或要素加载；
 * `SourceContext` 注入调度器与 Worker 池（类型用 `any` 聚合，避免 runtime 包依赖）。
 * 瓦片请求通过 `AbortSignal` 协作取消，降低带宽与 CPU 浪费。
 */

/**
 * 轴对齐边界（数据源语义），用于瓦片范围与数据源全局范围。
 * @remarks 与 EP2 `BBox2DLike` 结构相同但独立导出，避免 EP3↔EP2 文件耦合。
 */
export interface SourceBBox2DLike {
  /** 西边界（投影或经纬度，由 `SourceMetadata.crs` 解释）。 */
  west: number;
  /** 南边界。 */
  south: number;
  /** 东边界。 */
  east: number;
  /** 北边界。 */
  north: number;
}

/**
 * 引擎在 `initialize` 时注入的服务集合（RequestScheduler、WorkerPool 等）。
 * 使用单一 `any` 占位，保持扩展包零反向依赖。
 */
export interface SourceContext {
  /** 聚合的运行时服务句柄（具体类型由引擎装配）。 */
  readonly services: any;
}

/**
 * 单个瓦片请求参数（XYZ/TMS 由数据源解释）。
 */
export interface TileParams {
  /** 瓦片列索引（非负整数）。 */
  readonly x: number;
  /** 瓦片行索引（非负整数）。 */
  readonly y: number;
  /** 缩放级别（非负整数）。 */
  readonly z: number;
  /** 瓦片对应的空间范围（与数据 CRS 一致）。 */
  readonly extent: SourceBBox2DLike;
  /** 取消信号：失效或超时时引擎 abort。 */
  readonly signal: AbortSignal;
}

/**
 * 解码后的瓦片负载与元信息。
 *
 * @typeParam T - 载荷类型（MVT 解析结果、栅格像素等）
 */
export interface TileData<T = unknown> {
  /** 解码后的业务数据。 */
  readonly data: T;
  /** 该瓦片空间范围。 */
  readonly extent: SourceBBox2DLike;
  /** 可选：可转移对象列表，用于 `postMessage` 零拷贝。 */
  readonly transferables?: Transferable[];
  /** 可选：估算字节大小（用于内存预算）。 */
  readonly byteSize?: number;
  /** 可选：缓存过期时间戳（ms since epoch）。 */
  readonly expiresAt?: number;
}

/**
 * 实时要素流增量更新。
 */
export interface FeatureUpdate {
  /** 增量类型。 */
  readonly type: 'add' | 'update' | 'remove';
  /**
   * 受影响要素集合（`any[]` 避免对 L0 `Feature` 的硬引用）。
   */
  readonly features: readonly any[];
}

/**
 * 数据源静态元数据：用于图层初始化与 LOD 决策。
 */
export interface SourceMetadata {
  /** 坐标参考系标识（如 `EPSG:4326`）。 */
  readonly crs: string;
  /** 数据整体范围。 */
  readonly bounds: SourceBBox2DLike;
  /** 可选：最小可用缩放级别。 */
  readonly minZoom?: number;
  /** 可选：最大可用缩放级别。 */
  readonly maxZoom?: number;
  /** 可选：瓦片像素尺寸。 */
  readonly tileSize?: number;
  /** 可选：属性字段类型提示（用于样式绑定）。 */
  readonly attributeSchema?: Record<string, 'string' | 'number' | 'boolean'>;
  /** 可选：格式名（`mvt`/`geojson`/…）。 */
  readonly format?: string;
  /** 可选：版权/归属文字。 */
  readonly attribution?: string;
}

/**
 * 数据源实例：瓦片型、全量要素型或流式订阅可组合实现。
 *
 * @typeParam T - `loadTile` 返回的瓦片载荷类型
 */
export interface DataSource<T = unknown> {
  /** 数据源 id（在 SourceManager 中唯一）。 */
  readonly id: string;
  /** 类型标签（`vector`/`raster`/…）。 */
  readonly type: string;
  /**
   * 异步初始化：建立连接、探测元数据缓存等。
   * @param context - 引擎注入
   */
  initialize(context: SourceContext): Promise<void>;
  /** 释放网络、句柄与内部缓存。 */
  destroy(): void;
  /** 返回元数据；失败时应 reject 并由引擎转为 `GeoForgeError`。 */
  getMetadata(): Promise<SourceMetadata>;
  /** 可选：加载单个瓦片；取消时 `signal` 被触发。 */
  loadTile?(params: TileParams): Promise<TileData<T>>;
  /** 可选：主动取消进行中的瓦片请求（若底层 API 支持）。 */
  cancelTile?(params: TileParams): void;
  /** 可选：按视口加载要素（非瓦片管线）。 */
  loadFeatures?(extent: SourceBBox2DLike, zoom: number, signal?: AbortSignal): Promise<any[]>;
  /** 可选：订阅实时更新；返回取消订阅函数。 */
  subscribe?(extent: SourceBBox2DLike, callback: (update: FeatureUpdate) => void): () => void;
  /** 是否允许磁盘/内存缓存。 */
  readonly cacheable: boolean;
  /** 可选：缓存最大存活时间（毫秒）。 */
  readonly maxCacheAge?: number;
  /** 可选：预取提示（调度器优化顺序）。 */
  prefetchHint?(tiles: readonly TileParams[]): void;
}

/**
 * `ExtensionRegistry.registerSource` 使用的工厂签名。
 *
 * @param options - 用户配置
 * @returns 新的 `DataSource` 实例
 */
export type DataSourceFactory = (options: Record<string, unknown>) => DataSource;

/**
 * 创建一个最小占位数据源：元数据为全局 WGS84 边界，不加载任何瓦片。
 *
 * @param id - 数据源 id
 * @returns 仅用于测试装配的 `DataSource`
 *
 * @example
 * ```ts
 * const src = createNoOpDataSource('empty');
 * await src.initialize({ services: {} } as SourceContext);
 * const meta = await src.getMetadata();
 * console.assert(meta.crs === 'EPSG:4326');
 * src.destroy();
 * ```
 */
export function createNoOpDataSource(id: string): DataSource {
  const safeId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'empty-source';

  return {
    id: safeId,
    type: 'noop',
    cacheable: false,
    async initialize(_context: SourceContext): Promise<void> {
      // 无外部资源需要初始化
    },
    destroy(): void {
      // 无句柄泄漏
    },
    async getMetadata(): Promise<SourceMetadata> {
      return {
        crs: 'EPSG:4326',
        bounds: { west: -180, south: -85, east: 180, north: 85 },
        minZoom: 0,
        maxZoom: 22,
        format: 'noop',
      };
    },
  };
}
