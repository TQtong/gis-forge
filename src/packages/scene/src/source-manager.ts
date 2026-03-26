// ============================================================
// L4 scene — SourceManager：数据源注册、类型工厂与生命周期管理
// 依赖：L0 types（BBox2D / Feature / TileCoord）
// ============================================================

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';

// ---------------------------------------------------------------------------
// 结构化错误（与 GIS-Forge 规范对齐；scene 包内自包含最小实现）
// ---------------------------------------------------------------------------

/**
 * GIS-Forge 场景层结构化错误：携带机器可读错误码与可选上下文。
 *
 * @example
 * throw new GeoForgeError('SOURCE_DUPLICATE', 'source id already exists', { id: 'roads' });
 */
export class GeoForgeError extends Error {
  /**
   * 机器可读错误码（大写 SNAKE_CASE），用于日志聚合与分支处理。
   */
  public readonly code: string;

  /**
   * 可选调试上下文（sourceId、layerId 等），禁止存放敏感信息。
   */
  public readonly context?: Readonly<Record<string, unknown>>;

  /**
   * @param code - 错误码
   * @param message - 可读说明
   * @param context - 可选上下文
   */
  public constructor(code: string, message: string, context?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'GeoForgeError';
    this.code = code;
    this.context = context;
    // 维持 V8 Error.stack 捕获链（若存在 cause 可扩展）
    Object.setPrototypeOf(this, GeoForgeError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 数据源规格 SourceSpec
// ---------------------------------------------------------------------------

/**
 * 数据源规格：描述数据来源、瓦片策略与元数据（对齐 Style Spec 常用字段）。
 */
export interface SourceSpec {
  /**
   * 数据源唯一标识（在 StyleSpec.sources 中作为键；此处冗余携带便于对象传递）。
   */
  readonly id: string;

  /**
   * 数据源类型（vector / raster / geojson / 自定义扩展名）。
   */
  readonly type: string;

  /**
   * TileJSON 或元数据端点 URL（可选）。
   */
  readonly url?: string;

  /**
   * 瓦片 URL 模板列表（可选，与 url 二选一常见）。
   */
  readonly tiles?: readonly string[];

  /**
   * 内嵌 GeoJSON 或远程 URL 字符串（geojson 源常用）。
   */
  readonly data?: object | string;

  /**
   * 瓦片边长（像素），常见 256 或 512。
   */
  readonly tileSize?: number;

  /**
   * 最小缩放级别（含），范围通常 [0, 22]。
   */
  readonly minZoom?: number;

  /**
   * 最大缩放级别（含），须 ≥ minZoom。
   */
  readonly maxZoom?: number;

  /**
   * 地理范围（经纬度或投影单位包围盒）。
   */
  readonly bounds?: BBox2D;

  /**
   * 归属/版权 HTML 文本（展示于地图角落）。
   */
  readonly attribution?: string;

  /**
   * 瓦片坐标方案：xyz 或 tms。
   */
  readonly scheme?: 'xyz' | 'tms';

  /**
   * DEM 编码（仅 raster-dem），mapbox 或 terrarium。
   */
  readonly encoding?: 'mapbox' | 'terrarium';

  /**
   * 将指定属性字段提升为 Feature.id（vector/geojson）。
   */
  readonly promoteId?: string;
}

/**
 * 数据源元数据：TileJSON 解析结果或引擎探测信息（可扩展键值）。
 */
export type SourceMetadata = Readonly<Record<string, unknown>>;

/**
 * 运行时数据源实例：持有加载状态、可选瓦片/要素加载钩子与生命周期。
 */
export interface Source {
  /**
   * 与 SourceSpec.id 一致的数据源 ID。
   */
  readonly id: string;

  /**
   * 数据源类型字符串。
   */
  readonly type: string;

  /**
   * 是否已完成初始化并成功进入可用状态。
   */
  readonly loaded: boolean;

  /**
   * 若加载或运行失败则非 null；成功为 null。
   */
  readonly error: GeoForgeError | null;

  /**
   * 解析得到的元数据（TileJSON 等），无则为空对象。
   */
  readonly metadata: SourceMetadata;

  /**
   * 异步加载单个瓦片数据（矢量/栅格）；未实现的可选。
   *
   * @param coord - 瓦片坐标
   * @param signal - 取消信号
   * @returns 瓦片负载（引擎特定结构）
   */
  loadTile?(coord: TileCoord, signal: AbortSignal): Promise<unknown>;

  /**
   * 直接加载要素列表（如 geojson 内联）；可选。
   *
   * @param signal - 取消信号
   * @returns 要素数组
   */
  loadFeatures?(signal: AbortSignal): Promise<readonly Feature[]>;

  /**
   * 运行时替换/设置内嵌数据（geojson）；可选。
   *
   * @param data - GeoJSON 或 URL
   */
  setData?(data: object | string): void;

  /**
   * 初始化数据源（拉取 TileJSON、探测能力等）。
   *
   * @returns Promise，完成时须将 loaded 置为 true 或设置 error
   */
  initialize(): Promise<void>;

  /**
   * 释放网络、句柄与内部缓存。
   */
  destroy(): void;
}

/**
 * 由 SourceSpec 构造 Source 的工厂函数签名（registerSourceType）。
 */
export type SourceFactory = (spec: SourceSpec) => Source;

/**
 * 数据源加载成功监听器。
 *
 * @param sourceId - 数据源 ID
 * @param source - 已加载的 Source 实例
 */
export type SourceLoadedHandler = (sourceId: string, source: Source) => void;

/**
 * 数据源错误监听器。
 *
 * @param sourceId - 数据源 ID
 * @param error - 结构化错误
 */
export type SourceErrorHandler = (sourceId: string, error: GeoForgeError) => void;

/**
 * SourceManager：集中管理数据源实例与自定义类型注册。
 */
export interface SourceManager {
  /**
   * 注册并初始化数据源；重复 id 抛错。
   *
   * @param spec - 数据源规格
   * @returns Promise，初始化完成后 resolve
   */
  addSource(spec: SourceSpec): Promise<void>;

  /**
   * 移除并销毁数据源。
   *
   * @param id - 数据源 id
   * @returns 是否确实移除（不存在则 false）
   */
  removeSource(id: string): boolean;

  /**
   * 按 id 获取数据源实例。
   *
   * @param id - 数据源 id
   */
  getSource(id: string): Source | undefined;

  /**
   * 获取当前全部数据源只读列表（快照）。
   */
  getSources(): readonly Source[];

  /**
   * 注册自定义类型工厂（覆盖同名内置类型时后注册优先，由实现策略决定；此处后注册覆盖）。
   *
   * @param type - 类型名
   * @param factory - 工厂
   */
  registerSourceType(type: string, factory: SourceFactory): void;

  /**
   * 订阅数据源加载成功事件。
   *
   * @param handler - 回调
   * @returns 取消订阅函数
   */
  onSourceLoaded(handler: SourceLoadedHandler): () => void;

  /**
   * 订阅数据源错误事件。
   *
   * @param handler - 回调
   * @returns 取消订阅函数
   */
  onSourceError(handler: SourceErrorHandler): () => void;
}

// ---------------------------------------------------------------------------
// 默认桩实现：仅保存规格并在 initialize 中标记 loaded
// ---------------------------------------------------------------------------

/**
 * 内置默认数据源：无网络、无解码；用于占位与单元测试。
 */
class DefaultStubSource implements Source {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public readonly type: string;

  /** 内部可变加载标志（初始化后置 true）。 */
  private _loaded: boolean;

  /** 内部错误槽位。 */
  private _error: GeoForgeError | null;

  /** 保存的规格副本（避免外部后续修改影响内部状态）。 */
  private readonly _specSnapshot: SourceSpec;

  /**
   * 构造桩数据源。
   *
   * @param spec - 数据源规格
   */
  public constructor(spec: SourceSpec) {
    this.id = spec.id;
    this.type = spec.type;
    this._loaded = false;
    this._error = null;
    // 浅拷贝规格对象，避免共享引用被意外修改
    this._specSnapshot = { ...spec };
  }

  /** @inheritdoc */
  public get loaded(): boolean {
    return this._loaded;
  }

  /** @inheritdoc */
  public get error(): GeoForgeError | null {
    return this._error;
  }

  /** @inheritdoc */
  public get metadata(): SourceMetadata {
    // 默认元数据包含类型与 tileSize 提示，供调度器使用
    const meta: Record<string, unknown> = {
      kind: 'default-stub',
      type: this.type,
    };
    if (this._specSnapshot.tileSize !== undefined) {
      meta.tileSize = this._specSnapshot.tileSize;
    }
    if (this._specSnapshot.bounds !== undefined) {
      meta.bounds = this._specSnapshot.bounds;
    }
    return meta;
  }

  /**
   * @inheritdoc
   */
  public async initialize(): Promise<void> {
    // 桩实现：无异步 IO，仍使用 async 以保持接口一致
    if (this._loaded) {
      return;
    }
    try {
      // 校验 id 非空（防御性）
      if (this.id.trim().length === 0) {
        throw new GeoForgeError('SOURCE_INVALID_ID', 'source id must be non-empty', { id: this.id });
      }
      // 校验 zoom 范围若同时存在
      const minZ = this._specSnapshot.minZoom;
      const maxZ = this._specSnapshot.maxZoom;
      if (minZ !== undefined && maxZ !== undefined) {
        if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || minZ > maxZ) {
          throw new GeoForgeError(
            'SOURCE_INVALID_ZOOM_RANGE',
            'minZoom/maxZoom must be finite and minZoom <= maxZoom',
            { id: this.id, minZoom: minZ, maxZoom: maxZ },
          );
        }
      }
      this._loaded = true;
      this._error = null;
    } catch (e) {
      const err =
        e instanceof GeoForgeError
          ? e
          : new GeoForgeError('SOURCE_INIT_FAILED', e instanceof Error ? e.message : String(e), {
              id: this.id,
            });
      this._error = err;
      this._loaded = false;
      throw err;
    }
  }

  /**
   * @inheritdoc
   */
  public destroy(): void {
    // 无外部资源需要释放；重置标志以避免误用
    this._loaded = false;
  }
}

/**
 * SourceManager 具体实现（闭包私有状态）。
 */
class SourceManagerImpl implements SourceManager {
  /** id → Source */
  private readonly sources = new Map<string, Source>();

  /** type → factory */
  private readonly typeRegistry = new Map<string, SourceFactory>();

  /** 加载成功订阅者 */
  private readonly loadedHandlers = new Set<SourceLoadedHandler>();

  /** 错误订阅者 */
  private readonly errorHandlers = new Set<SourceErrorHandler>();

  /**
   * 解析用于构造 Source 的工厂：优先注册表，其次默认桩。
   *
   * @param spec - 规格
   * @returns 工厂产生的实例
   */
  private resolveFactory(spec: SourceSpec): Source {
    const registered = this.typeRegistry.get(spec.type);
    if (registered !== undefined) {
      try {
        return registered(spec);
      } catch (e) {
        throw new GeoForgeError(
          'SOURCE_FACTORY_THROW',
          e instanceof Error ? e.message : String(e),
          { type: spec.type, id: spec.id },
        );
      }
    }
    return new DefaultStubSource(spec);
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public async addSource(spec: SourceSpec): Promise<void> {
    // 校验 id
    if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
      throw new GeoForgeError('SOURCE_INVALID_ID', 'SourceSpec.id must be a non-empty string', {});
    }
    if (this.sources.has(spec.id)) {
      throw new GeoForgeError('SOURCE_DUPLICATE', `source "${spec.id}" already exists`, { id: spec.id });
    }
    const src = this.resolveFactory(spec);
    if (src.id !== spec.id) {
      throw new GeoForgeError('SOURCE_ID_MISMATCH', 'factory produced Source with different id', {
        expected: spec.id,
        actual: src.id,
      });
    }
    this.sources.set(spec.id, src);
    try {
      await src.initialize();
      if (src.error !== null) {
        // initialize 内部已设置 error 时仍可能 reject；双保险通知
        this.emitError(spec.id, src.error);
        throw src.error;
      }
      this.emitLoaded(spec.id, src);
    } catch (e) {
      // 初始化失败：移除并向上抛
      this.sources.delete(spec.id);
      try {
        src.destroy();
      } catch (destroyErr) {
        // destroy 不应阻断主错误路径；记录为二次错误
        const wrapped = new GeoForgeError(
          'SOURCE_DESTROY_FAILED',
          destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          { id: spec.id },
        );
        this.emitError(spec.id, wrapped);
      }
      if (e instanceof GeoForgeError) {
        this.emitError(spec.id, e);
        throw e;
      }
      const ge = new GeoForgeError(
        'SOURCE_INIT_FAILED',
        e instanceof Error ? e.message : String(e),
        { id: spec.id },
      );
      this.emitError(spec.id, ge);
      throw ge;
    }
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public removeSource(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0) {
      throw new GeoForgeError('SOURCE_INVALID_ID', 'removeSource: id must be non-empty string', {});
    }
    const src = this.sources.get(id);
    if (src === undefined) {
      return false;
    }
    try {
      src.destroy();
    } catch (e) {
      // 仍从映射移除，避免泄漏；上报错误
      this.emitError(
        id,
        new GeoForgeError('SOURCE_DESTROY_FAILED', e instanceof Error ? e.message : String(e), { id }),
      );
    }
    this.sources.delete(id);
    return true;
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public getSource(id: string): Source | undefined {
    if (typeof id !== 'string' || id.length === 0) {
      return undefined;
    }
    return this.sources.get(id);
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public getSources(): readonly Source[] {
    return Array.from(this.sources.values());
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public registerSourceType(type: string, factory: SourceFactory): void {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new GeoForgeError('SOURCE_TYPE_INVALID', 'registerSourceType: type must be non-empty string', {});
    }
    if (typeof factory !== 'function') {
      throw new GeoForgeError('SOURCE_FACTORY_INVALID', 'registerSourceType: factory must be a function', {
        type,
      });
    }
    this.typeRegistry.set(type, factory);
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public onSourceLoaded(handler: SourceLoadedHandler): () => void {
    if (typeof handler !== 'function') {
      throw new GeoForgeError('SOURCE_HANDLER_INVALID', 'onSourceLoaded: handler must be a function', {});
    }
    this.loadedHandlers.add(handler);
    return () => {
      this.loadedHandlers.delete(handler);
    };
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public onSourceError(handler: SourceErrorHandler): () => void {
    if (typeof handler !== 'function') {
      throw new GeoForgeError('SOURCE_HANDLER_INVALID', 'onSourceError: handler must be a function', {});
    }
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * 分发加载成功事件（拷贝处理器集合避免回调内修改集合导致异常）。
   *
   * @param id - 数据源 id
   * @param source - 实例
   */
  private emitLoaded(id: string, source: Source): void {
    const copy = Array.from(this.loadedHandlers.values());
    for (const h of copy) {
      try {
        h(id, source);
      } catch (e) {
        // 监听器错误隔离
        this.emitError(
          id,
          new GeoForgeError(
            'SOURCE_LISTENER_FAILED',
            e instanceof Error ? e.message : String(e),
            { phase: 'loaded' },
          ),
        );
      }
    }
  }

  /**
   * 分发错误事件。
   *
   * @param id - 数据源 id
   * @param error - 错误对象
   */
  private emitError(id: string, error: GeoForgeError): void {
    const copy = Array.from(this.errorHandlers.values());
    for (const h of copy) {
      try {
        h(id, error);
      } catch {
        // 错误回调再失败则忽略，避免无限递归
      }
    }
  }
}

/**
 * 创建 SourceManager 实例。
 *
 * @returns 新的 SourceManager
 *
 * @example
 * const sm = createSourceManager();
 * await sm.addSource({ id: 'g', type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
 */
export function createSourceManager(): SourceManager {
  return new SourceManagerImpl();
}
