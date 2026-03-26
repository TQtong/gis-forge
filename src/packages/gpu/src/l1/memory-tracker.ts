// ============================================================
// l1/memory-tracker.ts — GPU 资源内存跟踪器
// 层级：L1（GPU 层）
// 职责：跟踪所有 GPU 资源（Buffer/Texture/Pipeline/BindGroup）的
//       分配、引用计数、最后使用帧号，支持 LRU 淘汰与陈旧审计。
//
// 被引用于：L1/BufferPool, L1/TextureManager, L1/BindGroupCache,
//           L3/MemoryBudget, L3/ResourceManager
//
// 设计要点：
// - 纯数据结构，不持有任何 GPU 句柄——销毁由调用方负责
// - enforceBudget 按类型权重优先淘汰（texture > buffer > pipeline > bindGroup）
// - 引用计数为 0 的资源才可被淘汰
// ============================================================

// ===================== 资源类型 =====================

/** GPU 资源类型枚举，用于 enforceBudget 中的淘汰优先级 */
export type GPUResourceType = 'buffer' | 'texture' | 'pipeline' | 'bindGroup';

// ===================== GPUResourceEntry =====================

/**
 * GPU 资源条目。
 * 描述一个被跟踪的 GPU 资源的元信息——不持有实际 GPU 对象引用。
 * MemoryBudget 和 ResourceManager 根据此信息做淘汰与审计决策。
 */
export interface GPUResourceEntry {
  /** 资源唯一标识符，由调用方分配（如 "buffer-tile-12-3-5"）。 */
  readonly id: string;

  /**
   * 资源类型。
   * 影响 enforceBudget 的淘汰优先级：
   * texture（最大）> buffer > pipeline > bindGroup（最小）。
   */
  readonly type: GPUResourceType;

  /**
   * 资源占用字节数。
   * Buffer 为 GPUBufferDescriptor.size；
   * Texture 为 width × height × bytesPerPixel × mipLevels；
   * Pipeline/BindGroup 为估算值（通常较小，可设 0）。
   * 范围 [0, +∞)。
   */
  readonly size: number;

  /**
   * 资源最后被使用的帧编号。
   * 由 markUsed 更新，帧号由 FrameScheduler 单调递增分配。
   * 初始值为 0（表示从未被使用）。
   */
  readonly lastUsedFrame: number;

  /** 可选的可读标签，用于调试（如 Chrome DevTools GPU 标签列）。 */
  readonly label?: string;

  /**
   * 引用计数。
   * 创建时为 1，调用 addRef 加 1，releaseRef 减 1。
   * 为 0 时资源可被 enforceBudget 淘汰。
   * 范围 [0, +∞)。
   */
  readonly refCount: number;
}

// ===================== 内部可变条目 =====================

/**
 * 内部可变版本的资源条目。
 * 外部接口只暴露 readonly 的 GPUResourceEntry；
 * 内部通过此类型修改 lastUsedFrame、refCount 等字段。
 */
interface MutableResourceEntry {
  /** 资源唯一标识符 */
  readonly id: string;
  /** 资源类型 */
  readonly type: GPUResourceType;
  /** 字节大小 */
  readonly size: number;
  /** 最后使用帧号（可变） */
  lastUsedFrame: number;
  /** 可选标签 */
  readonly label?: string;
  /** 引用计数（可变） */
  refCount: number;
}

// ===================== GPUMemoryTracker 接口 =====================

/**
 * GPU 内存跟踪器接口。
 * 负责跟踪所有 GPU 资源的生命周期，提供 LRU 淘汰和陈旧审计功能。
 * 由 createGPUMemoryTracker 工厂函数创建。
 *
 * @example
 * const tracker = createGPUMemoryTracker();
 * tracker.track({ id: 'buf-1', type: 'buffer', size: 1024, label: 'vertex' });
 * tracker.markUsed('buf-1', 42);
 * tracker.addRef('buf-1');          // refCount → 2
 * tracker.releaseRef('buf-1');      // refCount → 1
 * const stale = tracker.audit(100, 50); // 返回 50 帧未使用的资源
 */
export interface GPUMemoryTracker {
  /**
   * 注册一个新的 GPU 资源进行跟踪。
   * @param entry - 资源信息（不含 lastUsedFrame 和 refCount，它们由内部初始化）
   */
  track(entry: Omit<GPUResourceEntry, 'lastUsedFrame' | 'refCount'>): void;

  /**
   * 移除一个 GPU 资源的跟踪记录。
   * 调用后该资源从 entries 中删除，totalBytes 相应减少。
   * @param id - 资源唯一标识符
   */
  untrack(id: string): void;

  /**
   * 增加资源的引用计数（+1）。
   * @param id - 资源唯一标识符
   */
  addRef(id: string): void;

  /**
   * 减少资源的引用计数（-1），最低为 0。
   * @param id - 资源唯一标识符
   */
  releaseRef(id: string): void;

  /**
   * 标记资源在指定帧号被使用过。
   * @param id - 资源唯一标识符
   * @param frame - 当前帧号（单调递增）
   */
  markUsed(id: string, frame: number): void;

  /**
   * 在超出内存预算时淘汰 LRU 资源。
   * 只淘汰 refCount === 0 的资源，按类型权重 × LRU 优先级排序。
   * @param budget - 目标内存预算（字节）
   * @param currentFrame - 当前帧号，用于计算 LRU 距离
   * @returns 被淘汰的资源 ID 列表（调用方需负责实际 GPU 销毁）
   */
  enforceBudget(budget: number, currentFrame: number): string[];

  /**
   * 审计陈旧资源——返回超过指定帧数未被使用的资源列表。
   * @param currentFrame - 当前帧号
   * @param staleThreshold - 帧数阈值，超过此帧数未使用视为陈旧
   * @returns 陈旧资源条目的只读数组
   */
  audit(currentFrame: number, staleThreshold: number): GPUResourceEntry[];

  /** 当前所有被跟踪资源的总字节数。 */
  readonly totalBytes: number;

  /** 当前被跟踪的资源总数。 */
  readonly entryCount: number;

  /** 所有被跟踪资源条目的只读 Map 视图。 */
  readonly entries: ReadonlyMap<string, GPUResourceEntry>;
}

// ===================== 类型权重常量 =====================

/**
 * 各资源类型的淘汰权重系数。
 * 值越大，在超预算时越优先被淘汰。
 * 设计依据：Texture 通常占用最多显存，优先回收效果最显著；
 * BindGroup 重建成本低但占用极小，最后回收。
 * 这些权重乘以 LRU 帧距离得到最终淘汰分数。
 */
const TYPE_EVICTION_WEIGHT: Readonly<Record<GPUResourceType, number>> = {
  texture: 4,
  buffer: 3,
  pipeline: 2,
  bindGroup: 1,
};

// ===================== 工厂函数 =====================

/**
 * 创建一个 GPU 内存跟踪器实例。
 * 使用 Map 存储资源条目，提供 O(1) 的 track/untrack/markUsed 操作。
 * enforceBudget 为 O(n log n) —— 需要排序计算淘汰优先级。
 *
 * @returns GPUMemoryTracker 实例
 *
 * @example
 * const tracker = createGPUMemoryTracker();
 *
 * // 跟踪一个 1MB 的纹理
 * tracker.track({ id: 'tex-terrain-0', type: 'texture', size: 1024 * 1024, label: 'terrain tile 0' });
 * tracker.markUsed('tex-terrain-0', 1);
 *
 * // 跟踪一个 64KB 的 buffer
 * tracker.track({ id: 'buf-vertex-1', type: 'buffer', size: 65536, label: 'vertex data' });
 * tracker.markUsed('buf-vertex-1', 1);
 *
 * // 预算为 512KB，淘汰超出部分
 * const evicted = tracker.enforceBudget(512 * 1024, 10);
 * // evicted 可能包含 'tex-terrain-0'（如果 refCount === 0 且优先级最高）
 */
export function createGPUMemoryTracker(): GPUMemoryTracker {
  // 内部 Map 存储可变条目，外部只暴露 ReadonlyMap<string, GPUResourceEntry>
  const resourceMap = new Map<string, MutableResourceEntry>();

  // 累计总字节数，避免每次读取时遍历计算
  let cachedTotalBytes = 0;

  /**
   * 注册一个新的 GPU 资源进行跟踪。
   * lastUsedFrame 初始化为 0（从未使用），refCount 初始化为 1（刚创建）。
   *
   * @param entry - 资源描述（不含运行时字段）
   *
   * @example
   * tracker.track({ id: 'buf-0', type: 'buffer', size: 2048 });
   */
  function track(entry: Omit<GPUResourceEntry, 'lastUsedFrame' | 'refCount'>): void {
    // 校验 id 非空，防止空键导致 Map 查找异常
    if (!entry.id) {
      throw new Error('[GPUMemoryTracker] track: id must be a non-empty string');
    }

    // 校验 size 非负，NaN 和 Infinity 均不合法
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      throw new Error(
        `[GPUMemoryTracker] track: size must be a non-negative finite number, got ${entry.size}`
      );
    }

    // 如果 id 已存在，先移除旧条目再覆盖（保证 totalBytes 正确）
    if (resourceMap.has(entry.id)) {
      const old = resourceMap.get(entry.id)!;
      // 扣减旧条目的字节数
      cachedTotalBytes -= old.size;
    }

    // 构造内部可变条目
    const mutable: MutableResourceEntry = {
      id: entry.id,
      type: entry.type,
      size: entry.size,
      lastUsedFrame: 0,
      label: entry.label,
      refCount: 1,
    };

    // 存入 Map 并累加字节数
    resourceMap.set(entry.id, mutable);
    cachedTotalBytes += entry.size;
  }

  /**
   * 移除一个资源的跟踪记录。
   * 如果 id 不存在则静默忽略（幂等语义）。
   *
   * @param id - 资源唯一标识符
   *
   * @example
   * tracker.untrack('buf-0');
   */
  function untrack(id: string): void {
    const entry = resourceMap.get(id);

    // id 不存在时静默返回——支持幂等 untrack
    if (!entry) {
      return;
    }

    // 从累计字节数中扣减
    cachedTotalBytes -= entry.size;
    // 从 Map 中删除
    resourceMap.delete(id);
  }

  /**
   * 增加指定资源的引用计数。
   * 当多个模块共享同一个 GPU 资源时，通过引用计数防止提前释放。
   *
   * @param id - 资源唯一标识符
   *
   * @example
   * tracker.addRef('buf-0'); // refCount: 1 → 2
   */
  function addRef(id: string): void {
    const entry = resourceMap.get(id);

    // id 不存在视为编程错误，抛出异常帮助定位 bug
    if (!entry) {
      throw new Error(`[GPUMemoryTracker] addRef: unknown resource id "${id}"`);
    }

    // 递增引用计数
    entry.refCount += 1;
  }

  /**
   * 减少指定资源的引用计数，最低降至 0。
   * refCount 降到 0 后资源成为淘汰候选（enforceBudget 可回收）。
   *
   * @param id - 资源唯一标识符
   *
   * @example
   * tracker.releaseRef('buf-0'); // refCount: 2 → 1
   */
  function releaseRef(id: string): void {
    const entry = resourceMap.get(id);

    // id 不存在视为编程错误
    if (!entry) {
      throw new Error(`[GPUMemoryTracker] releaseRef: unknown resource id "${id}"`);
    }

    // 防止 refCount 变为负数——钳位到 0
    if (entry.refCount > 0) {
      entry.refCount -= 1;
    }
  }

  /**
   * 标记资源在指定帧被使用。
   * 仅当新帧号 ≥ 当前 lastUsedFrame 时才更新（帧号应单调递增）。
   *
   * @param id - 资源唯一标识符
   * @param frame - 当前帧号
   *
   * @example
   * tracker.markUsed('buf-0', 42);
   */
  function markUsed(id: string, frame: number): void {
    const entry = resourceMap.get(id);

    // id 不存在时静默忽略——资源可能已被淘汰但帧循环尚未感知
    if (!entry) {
      return;
    }

    // 只接受单调递增帧号，避免乱序帧导致 LRU 计算异常
    if (frame >= entry.lastUsedFrame) {
      entry.lastUsedFrame = frame;
    }
  }

  /**
   * 在总内存超出预算时，按 LRU 策略淘汰资源直至预算以内。
   * 仅淘汰 refCount === 0 的资源。
   * 淘汰优先级 = 类型权重 × (currentFrame - lastUsedFrame)。
   * 权重：texture(4) > buffer(3) > pipeline(2) > bindGroup(1)。
   *
   * @param budget - 目标内存预算（字节），范围 [0, +∞)
   * @param currentFrame - 当前帧号，用于计算陈旧度
   * @returns 被淘汰的资源 ID 数组（调用方需负责 GPU 销毁与资源回收）
   *
   * @example
   * // 预算 10MB，当前帧 1000
   * const evicted = tracker.enforceBudget(10 * 1024 * 1024, 1000);
   * for (const id of evicted) {
   *   // 调用方负责实际 GPU 资源销毁
   *   gpuResourceMap.get(id)?.destroy();
   * }
   */
  function enforceBudget(budget: number, currentFrame: number): string[] {
    // 预算校验——NaN/负数/Infinity 均使用 0 作为回退
    const safeBudget = Number.isFinite(budget) && budget >= 0 ? budget : 0;
    const evictedIds: string[] = [];

    // 如果当前总量未超预算，无需淘汰
    if (cachedTotalBytes <= safeBudget) {
      return evictedIds;
    }

    // 收集所有 refCount === 0 的候选条目
    const candidates: MutableResourceEntry[] = [];
    for (const entry of resourceMap.values()) {
      // 只有无引用的资源才可淘汰——有引用说明仍在被使用
      if (entry.refCount === 0) {
        candidates.push(entry);
      }
    }

    // 按淘汰优先级降序排列：类型权重 × 帧距离越大越优先淘汰
    candidates.sort((a, b) => {
      // 计算每个候选的淘汰分数
      const scoreA = TYPE_EVICTION_WEIGHT[a.type] * (currentFrame - a.lastUsedFrame + 1);
      const scoreB = TYPE_EVICTION_WEIGHT[b.type] * (currentFrame - b.lastUsedFrame + 1);
      // 降序——分数高的排前面优先淘汰
      return scoreB - scoreA;
    });

    // 逐个淘汰直到总量回到预算以内
    for (const candidate of candidates) {
      // 每次循环检查是否已满足预算
      if (cachedTotalBytes <= safeBudget) {
        break;
      }

      // 从 Map 中移除并扣减字节数
      resourceMap.delete(candidate.id);
      cachedTotalBytes -= candidate.size;
      evictedIds.push(candidate.id);
    }

    return evictedIds;
  }

  /**
   * 审计陈旧资源——返回超过指定帧数阈值未被使用的资源。
   * 用于 ResourceManager 的定期清理策略。
   *
   * @param currentFrame - 当前帧号
   * @param staleThreshold - 帧数阈值，(currentFrame - lastUsedFrame) > staleThreshold 视为陈旧
   * @returns 陈旧资源条目数组（只读快照）
   *
   * @example
   * // 查找 300 帧以上未使用的资源
   * const staleEntries = tracker.audit(1000, 300);
   * console.log(`${staleEntries.length} stale resources found`);
   */
  function audit(currentFrame: number, staleThreshold: number): GPUResourceEntry[] {
    // 阈值校验——非有限正数时使用极大值（不返回任何陈旧资源）
    const safeThreshold =
      Number.isFinite(staleThreshold) && staleThreshold >= 0
        ? staleThreshold
        : Number.MAX_SAFE_INTEGER;

    const staleEntries: GPUResourceEntry[] = [];

    for (const entry of resourceMap.values()) {
      // 计算该资源距上次使用的帧数差值
      const framesSinceUsed = currentFrame - entry.lastUsedFrame;

      // 超过阈值则视为陈旧
      if (framesSinceUsed > safeThreshold) {
        // 返回只读快照——冻结防止外部修改
        staleEntries.push(Object.freeze({ ...entry }));
      }
    }

    return staleEntries;
  }

  // ===================== 公开的跟踪器对象 =====================

  return {
    track,
    untrack,
    addRef,
    releaseRef,
    markUsed,
    enforceBudget,
    audit,

    /** 当前所有被跟踪资源的总字节数（实时计算缓存值）。 */
    get totalBytes(): number {
      return cachedTotalBytes;
    },

    /** 当前被跟踪的资源总数。 */
    get entryCount(): number {
      return resourceMap.size;
    },

    /**
     * 所有被跟踪资源条目的只读 Map 视图。
     * 返回内部 Map 的直接引用（ReadonlyMap 在类型层面阻止修改），
     * 性能优于每次复制一份新 Map。
     */
    get entries(): ReadonlyMap<string, GPUResourceEntry> {
      return resourceMap as ReadonlyMap<string, GPUResourceEntry>;
    },
  };
}
