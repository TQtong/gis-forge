// ============================================================
// L3/resource-manager.ts — CPU/GPU 资源缓存与生命周期（MVP）
// 层级：L3（运行时调度）
// 职责：统一 load/get/ref/evict 与事件通知；与 MemoryBudget / TileScheduler
//       协作时使用 lastAccessFrame 做 LRU 提示。
// ============================================================

/**
 * 资源大类：瓦片、矢量、地形、3D Tiles、样式、字形等。
 */
export type ResourceType =
  | 'tile-raster'
  | 'tile-vector'
  | 'tile-terrain'
  | 'tile-3dtiles'
  | 'geojson'
  | 'glyph'
  | 'sprite'
  | 'style'
  | 'custom';

/**
 * 资源生命周期状态。
 */
export type ResourceState =
  | 'pending'
  | 'loading'
  | 'decoding'
  | 'uploading'
  | 'ready'
  | 'error'
  | 'evicted';

/**
 * 对外暴露的资源快照（只读字段）。
 *
 * @typeParam T - 资源载荷类型
 */
export interface Resource<T = unknown> {
  /** 全局唯一资源键（通常含 sourceId + tileKey 等） */
  readonly id: string;

  /** 资源类型，用于按类型淘汰与统计 */
  readonly type: ResourceType;

  /** 当前状态机位置 */
  readonly state: ResourceState;

  /** 解码后的 CPU 侧数据；未就绪时为 undefined */
  readonly data?: T;

  /** 失败时的错误对象；成功路径为 undefined */
  readonly error?: Error;

  /**
   * 估算的 CPU 内存占用（字节）。
   * 范围 [0, 2^53-1]；无法估算时为 0。
   */
  readonly byteSize: number;

  /**
   * GPU 侧占用（字节）；MVP 默认 0，上传管线可后续写入。
   * 范围 [0, 2^53-1]。
   */
  readonly gpuByteSize: number;

  /**
   * 最近一次被 markAccessed 记录的帧序号；用于 LRU。
   * 范围 [0, 2^53-1]。
   */
  readonly lastAccessFrame: number;

  /**
   * 引用计数；为 0 时表示无外部句柄（仍可由管理器保留直至 evict）。
   * 范围 [0, 2^53-1]。
   */
  readonly refCount: number;
}

/**
 * 资源管理器：加载去重、缓存、事件与统计。
 */
export interface ResourceManager {
  /**
   * 异步加载资源；同一 `id` 并发调用共享同一 in-flight Promise。
   *
   * @typeParam T - 载荷类型
   * @param id - 资源键
   * @param type - 资源类型
   * @param loader - 异步加载器（网络/解码/解析）
   * @returns 就绪或出错的资源快照
   */
  load<T>(id: string, type: ResourceType, loader: () => Promise<T>): Promise<Resource<T>>;

  /**
   * 同步查询缓存中的资源（若不存在返回 undefined）。
   *
   * @typeParam T - 载荷类型
   * @param id - 资源键
   * @returns 资源快照或 undefined
   */
  get<T>(id: string): Resource<T> | undefined;

  /**
   * 增加引用计数；资源必须已存在。
   *
   * @param id - 资源键
   */
  addRef(id: string): void;

  /**
   * 释放一次引用；不会自动销毁资源（由 evict/clear 驱动）。
   *
   * @param id - 资源键
   */
  releaseRef(id: string): void;

  /**
   * 更新 LRU 帧标记（通常在每帧遍历可见资源时调用）。
   *
   * @param id - 资源键
   * @param frameIndex - 当前帧序号（单调递增非负整数）
   */
  markAccessed(id: string, frameIndex: number): void;

  /**
   * 按 ID 列表驱逐：从缓存移除并触发 `onResourceEvicted`。
   *
   * @param ids - 资源 ID 列表
   */
  evict(ids: string[]): void;

  /**
   * 空闲队列处理：MVP 占位，预取/后台解码可在此扩展。
   */
  processIdleQueue(): void;

  /** 聚合统计（只读快照） */
  readonly stats: {
    /** 当前缓存中的资源条目总数 */
    readonly totalCount: number;
    /** 状态为 ready 的条目数 */
    readonly readyCount: number;
    /** 处于 loading/pending/decoding/uploading 的条目数 */
    readonly loadingCount: number;
    /** 所有条目的 byteSize 之和 */
    readonly cpuBytes: number;
    /** 所有条目的 gpuByteSize 之和 */
    readonly gpuBytes: number;
  };

  /**
   * 按类型列出当前缓存中的资源（快照数组）。
   *
   * @param type - 资源类型
   * @returns 资源数组副本
   */
  getByType(type: ResourceType): Resource[];

  /**
   * 按状态列出资源（快照数组）。
   *
   * @param state - 状态
   * @returns 资源数组副本
   */
  getByState(state: ResourceState): Resource[];

  /**
   * 订阅资源变为 ready（每次注册返回取消函数）。
   *
   * @param callback - 回调
   * @returns 取消订阅函数
   */
  onResourceReady(callback: (resource: Resource) => void): () => void;

  /**
   * 订阅资源进入 error。
   *
   * @param callback - 回调
   * @returns 取消订阅函数
   */
  onResourceError(callback: (resource: Resource, error: Error) => void): () => void;

  /**
   * 订阅资源被驱逐。
   *
   * @param callback - 回调
   * @returns 取消订阅函数
   */
  onResourceEvicted(callback: (resource: Resource) => void): () => void;

  /** 清空全部缓存并逐条通知 evicted（若适用） */
  clearAll(): void;

  /**
   * 按类型清空。
   *
   * @param type - 资源类型
   */
  clearByType(type: ResourceType): void;
}

// ===================== 内部：可变资源记录 =====================

/**
 * 内部可变资源结构（存储层）；对外通过 `toReadonlyResource` 投影。
 *
 * @typeParam T - 载荷类型
 */
interface MutableResource<T = unknown> {
  /** 资源 ID */
  id: string;

  /** 资源类型 */
  type: ResourceType;

  /** 状态机当前状态 */
  state: ResourceState;

  /** CPU 侧数据 */
  data?: T;

  /** 错误对象 */
  error?: Error;

  /** CPU 字节估算 */
  byteSize: number;

  /** GPU 字节估算 */
  gpuByteSize: number;

  /** 最近访问帧 */
  lastAccessFrame: number;

  /** 引用计数 */
  refCount: number;
}

// ===================== 工具函数 =====================

/**
 * 将可变记录投影为对外只读 `Resource` 快照（浅拷贝标量与引用字段）。
 *
 * @typeParam T - 载荷类型
 * @param r - 内部记录
 * @returns 只读资源对象
 */
function toReadonlyResource<T>(r: MutableResource<T>): Resource<T> {
  // 新对象避免调用方修改内部记录；data/error 仍为引用语义（大对象不复制）
  return {
    id: r.id,
    type: r.type,
    state: r.state,
    data: r.data,
    error: r.error,
    byteSize: r.byteSize,
    gpuByteSize: r.gpuByteSize,
    lastAccessFrame: r.lastAccessFrame,
    refCount: r.refCount,
  };
}

/**
 * 估算任意 JS 值的近似 CPU 字节占用（启发式，用于预算统计）。
 *
 * @param value - 任意载荷
 * @returns 非负字节估算值
 */
function estimateByteSize(value: unknown): number {
  // null/undefined 不占可观测堆（按 0 处理）
  if (value === null || value === undefined) {
    return 0;
  }
  // 原始类型：按保守上界估计
  if (typeof value === 'string') {
    // UTF-16 每字符至多 2 字节
    return value.length * 2;
  }
  if (typeof value === 'number') {
    return 8;
  }
  if (typeof value === 'boolean') {
    return 4;
  }
  if (typeof value === 'bigint') {
    return 8;
  }
  // 二进制缓冲
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  // 数组：递归求和（深度过大时截断，避免栈溢出）
  if (Array.isArray(value)) {
    let sum = 0;
    const cap = Math.min(value.length, 4096);
    for (let i = 0; i < cap; i += 1) {
      sum += estimateByteSize(value[i]);
    }
    // 大数组额外线性惩罚项，表示槽位开销
    if (value.length > cap) {
      sum += (value.length - cap) * 8;
    }
    return sum;
  }
  // 普通对象：尝试 JSON 序列化长度
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value);
      return s.length * 2;
    } catch {
      // 循环引用等：给固定下限，避免抛错中断加载
      return 64;
    }
  }
  return 32;
}

/**
 * 判定状态是否属于“加载中”集合（用于 loadingCount 统计）。
 *
 * @param s - 状态
 * @returns 是否算入 loadingCount
 */
function isLoadingLike(s: ResourceState): boolean {
  return s === 'pending' || s === 'loading' || s === 'decoding' || s === 'uploading';
}

// ===================== 工厂 =====================

/**
 * 创建资源管理器实例（内存 Map + 事件订阅）。
 *
 * @returns ResourceManager 实现
 *
 * @example
 * const rm = createResourceManager();
 * const off = rm.onResourceReady((r) => console.log(r.id));
 * rm.load('tile:1', 'tile-raster', async () => new Uint8Array([1, 2, 3])).finally(off);
 */
export function createResourceManager(): ResourceManager {
  /** 主存储 */
  const store = new Map<string, MutableResource<unknown>>();

  /** in-flight 去重：id -> Promise */
  const inflight = new Map<string, Promise<Resource<unknown>>>();

  /** ready 回调集合 */
  const onReady = new Set<(resource: Resource) => void>();

  /** error 回调集合 */
  const onError = new Set<(resource: Resource, error: Error) => void>();

  /** evicted 回调集合 */
  const onEvicted = new Set<(resource: Resource) => void>();

  /**
   * 触发 ready 事件（异常隔离，避免单个监听破坏其他监听）。
   *
   * @param resource - 资源快照
   */
  function emitReady(resource: Resource): void {
    onReady.forEach((cb) => {
      try {
        cb(resource);
      } catch {
        // 监听错误不应影响资源管线；静默吞掉（可接 Logger）
      }
    });
  }

  /**
   * 触发 error 事件。
   *
   * @param resource - 资源快照
   * @param error - 错误对象
   */
  function emitError(resource: Resource, error: Error): void {
    onError.forEach((cb) => {
      try {
        cb(resource, error);
      } catch {
        /* 同上：隔离监听异常 */
      }
    });
  }

  /**
   * 触发 evicted 事件。
   *
   * @param resource - 被驱逐资源的快照（state 置为 evicted）
   */
  function emitEvicted(resource: Resource): void {
    onEvicted.forEach((cb) => {
      try {
        cb(resource);
      } catch {
        /* 同上 */
      }
    });
  }

  /**
   * 重新计算聚合 stats（避免维护增量出错，条目数有限时可全量扫描）。
   *
   * @returns stats 快照
   */
  function computeStats(): ResourceManager['stats'] {
    let totalCount = 0;
    let readyCount = 0;
    let loadingCount = 0;
    let cpuBytes = 0;
    let gpuBytes = 0;
    store.forEach((r) => {
      totalCount += 1;
      if (r.state === 'ready') {
        readyCount += 1;
      }
      if (isLoadingLike(r.state)) {
        loadingCount += 1;
      }
      // byteSize 可能来自估算；保证非负
      cpuBytes += Math.max(0, r.byteSize);
      gpuBytes += Math.max(0, r.gpuByteSize);
    });
    return {
      totalCount,
      readyCount,
      loadingCount,
      cpuBytes,
      gpuBytes,
    };
  }

  const manager: ResourceManager = {
    load<T>(id: string, type: ResourceType, loader: () => Promise<T>): Promise<Resource<T>> {
      // 参数校验：id/type/loader 必须有效
      if (typeof id !== 'string' || id.length === 0) {
        return Promise.reject(new TypeError('ResourceManager.load: id must be a non-empty string.'));
      }
      if (typeof loader !== 'function') {
        return Promise.reject(new TypeError('ResourceManager.load: loader must be a function.'));
      }

      // 并发去重：同一 id 复用 Promise
      const existingInflight = inflight.get(id);
      if (existingInflight) {
        return existingInflight as Promise<Resource<T>>;
      }

      const existed = store.get(id);
      if (existed && existed.type !== type) {
        return Promise.reject(
          new Error(`ResourceManager.load: id "${id}" exists with different type.`)
        );
      }
      // 已就绪：直接返回快照（避免重复解码）
      if (existed && existed.state === 'ready') {
        return Promise.resolve(toReadonlyResource(existed as MutableResource<T>));
      }

      const promise: Promise<Resource<T>> = (async () => {
        // 创建或复用记录：从 pending 进入 loading
        let record = store.get(id) as MutableResource<T> | undefined;
        if (!record) {
          record = {
            id,
            type,
            state: 'pending',
            byteSize: 0,
            gpuByteSize: 0,
            lastAccessFrame: 0,
            refCount: 0,
          };
          store.set(id, record as MutableResource<unknown>);
        } else {
          // 重试 error/evicted 路径：清理错误并重新走加载
          record.error = undefined;
          record.data = undefined;
          record.byteSize = 0;
          record.gpuByteSize = 0;
          record.state = 'pending';
        }

        record.state = 'loading';
        try {
          const data = await loader();
          // 成功后估算 CPU 占用
          const bytes = estimateByteSize(data);
          record.data = data;
          record.error = undefined;
          record.byteSize = bytes;
          record.gpuByteSize = 0;
          record.state = 'ready';
          const snap = toReadonlyResource(record);
          emitReady(snap);
          return snap;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          record.data = undefined;
          record.error = err;
          record.byteSize = 0;
          record.gpuByteSize = 0;
          record.state = 'error';
          const snap = toReadonlyResource(record);
          emitError(snap, err);
          return snap;
        } finally {
          // 无论成功失败都清理 in-flight，允许后续显式 reload
          inflight.delete(id);
        }
      })();

      inflight.set(id, promise as Promise<Resource<unknown>>);
      return promise;
    },

    get<T>(id: string): Resource<T> | undefined {
      if (typeof id !== 'string' || id.length === 0) {
        return undefined;
      }
      const r = store.get(id);
      if (!r) {
        return undefined;
      }
      return toReadonlyResource(r as MutableResource<T>);
    },

    addRef(id: string): void {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('ResourceManager.addRef: id must be a non-empty string.');
      }
      const r = store.get(id);
      if (!r) {
        throw new Error(`ResourceManager.addRef: resource "${id}" not found.`);
      }
      // 大整数保护：避免溢出为负
      if (r.refCount < Number.MAX_SAFE_INTEGER) {
        r.refCount += 1;
      }
    },

    releaseRef(id: string): void {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('ResourceManager.releaseRef: id must be a non-empty string.');
      }
      const r = store.get(id);
      if (!r) {
        throw new Error(`ResourceManager.releaseRef: resource "${id}" not found.`);
      }
      // 释放不应低于 0（防御性）
      r.refCount = Math.max(0, r.refCount - 1);
    },

    markAccessed(id: string, frameIndex: number): void {
      if (typeof id !== 'string' || id.length === 0) {
        return;
      }
      if (!Number.isFinite(frameIndex) || frameIndex < 0) {
        return;
      }
      const r = store.get(id);
      if (!r) {
        return;
      }
      // 单调性由调用方保证；此处仅记录最后一次可见帧
      r.lastAccessFrame = Math.floor(frameIndex);
    },

    evict(ids: string[]): void {
      if (!Array.isArray(ids)) {
        throw new TypeError('ResourceManager.evict: ids must be an array.');
      }
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (typeof id !== 'string' || id.length === 0) {
          continue;
        }
        const r = store.get(id);
        if (!r) {
          continue;
        }
        // 从 in-flight 表移除：无法取消 Promise，但避免新订阅者误用旧 Promise
        inflight.delete(id);
        store.delete(id);
        const evictedSnapshot: Resource<unknown> = {
          ...toReadonlyResource(r),
          state: 'evicted',
        };
        emitEvicted(evictedSnapshot);
      }
    },

    processIdleQueue(): void {
      // MVP：占位；未来可在此调度 prefetch、Worker 解码、GPU 上传批次
      return;
    },

    get stats(): ResourceManager['stats'] {
      return computeStats();
    },

    getByType(type: ResourceType): Resource[] {
      const out: Resource[] = [];
      store.forEach((r) => {
        if (r.type === type) {
          out.push(toReadonlyResource(r));
        }
      });
      return out;
    },

    getByState(state: ResourceState): Resource[] {
      const out: Resource[] = [];
      store.forEach((r) => {
        if (r.state === state) {
          out.push(toReadonlyResource(r));
        }
      });
      return out;
    },

    onResourceReady(callback: (resource: Resource) => void): () => void {
      if (typeof callback !== 'function') {
        throw new TypeError('ResourceManager.onResourceReady: callback must be a function.');
      }
      onReady.add(callback);
      return () => {
        onReady.delete(callback);
      };
    },

    onResourceError(callback: (resource: Resource, error: Error) => void): () => void {
      if (typeof callback !== 'function') {
        throw new TypeError('ResourceManager.onResourceError: callback must be a function.');
      }
      onError.add(callback);
      return () => {
        onError.delete(callback);
      };
    },

    onResourceEvicted(callback: (resource: Resource) => void): () => void {
      if (typeof callback !== 'function') {
        throw new TypeError('ResourceManager.onResourceEvicted: callback must be a function.');
      }
      onEvicted.add(callback);
      return () => {
        onEvicted.delete(callback);
      };
    },

    clearAll(): void {
      const ids = Array.from(store.keys());
      // 逐个 evict 语义：通知监听器
      manager.evict(ids);
    },

    clearByType(type: ResourceType): void {
      const ids: string[] = [];
      store.forEach((r, id) => {
        if (r.type === type) {
          ids.push(id);
        }
      });
      manager.evict(ids);
    },
  };

  return manager;
}
