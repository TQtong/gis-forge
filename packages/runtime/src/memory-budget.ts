// ============================================================
// memory-budget.ts — L3 MemoryBudget：CPU+GPU 双轨内存预算与淘汰
// 依赖通过 forward-reference 接口注入，避免与 L1/L3 其它模块循环引用。
// ============================================================

/**
 * GPU 内存追踪器的最小可替换接口（duck typing）。
 * 由 L1 GPUMemoryTracker 实现；此处仅声明调度所需方法，保持 L3 独立。
 */
export interface GPUMemoryTrackerLike {
  /** 当前 GPU 侧已分配字节总数（近似值即可，用于预算比较） */
  readonly totalBytes: number;
  /** 追踪条目数量（用于诊断与快照） */
  readonly entryCount: number;
  /**
   * 在超出预算时执行淘汰策略，返回本轮被淘汰的资源 id 列表。
   *
   * @param budget - 允许的最大 GPU 字节预算
   * @param currentFrame - 当前帧序号（用于 LRU/帧龄策略）
   */
  enforceBudget(budget: number, currentFrame: number): string[];
}

/**
 * 资源管理器的最小可替换接口（duck typing）。
 * 由 L3 ResourceManager 实现；负责 CPU/GPU 双轨统计与按 id 淘汰。
 */
export interface ResourceManagerLike {
  /** 聚合统计：条目数与 CPU/GPU 字节估算 */
  readonly stats: {
    /** 资源条目总数（跨 CPU/GPU 句柄） */
    readonly totalCount: number;
    /** CPU 侧驻留字节估算（解码几何、元数据等） */
    readonly cpuBytes: number;
    /** GPU 侧驻留字节估算（与 tracker 可能部分重叠，用于交叉校验） */
    readonly gpuBytes: number;
  };
  /**
   * 按资源 id 批量淘汰（释放 CPU/GPU 两侧关联对象）。
   *
   * @param ids - 要淘汰的资源 id 列表（空数组为合法 no-op）
   */
  evict(ids: string[]): void;
  /**
   * 按内部状态桶枚举资源，用于 LRU 淘汰与缓存分桶计数。
   *
   * @param state - 状态标签（如 `tile` / `texture` / `buffer`）
   */
  getByState(state: string): Array<{
    /** 资源唯一 id */
    readonly id: string;
    /** 该资源估算字节占用 */
    readonly byteSize: number;
    /** 最近访问帧号（越小越旧，越适合淘汰） */
    readonly lastAccessFrame: number;
    /** 引用计数（>0 的资源应尽量避免淘汰） */
    readonly refCount: number;
  }>;
}

/** 已知用于缓存分桶计数的状态标签（ResourceManager 约定字符串）。 */
const KNOWN_CACHE_STATE_TILE = 'tile' as const;
/** 纹理类缓存桶（与 tile 分离，便于统计与差异化淘汰权重）。 */
const KNOWN_CACHE_STATE_TEXTURE = 'texture' as const;
/** Buffer 类缓存桶（几何/索引/UBO 等）。 */
const KNOWN_CACHE_STATE_BUFFER = 'buffer' as const;

/** 默认 GPU 预算：256 MiB（桌面端常见起点；可在运行时下调）。 */
const DEFAULT_GPU_BUDGET_BYTES = 256 * 1024 * 1024;
/** 默认 CPU 预算：128 MiB（矢量解码与元数据更偏 CPU）。 */
const DEFAULT_CPU_BUDGET_BYTES = 128 * 1024 * 1024;
/** 默认告警阈值：达到预算的 85% 触发 onWarning（提前留余量）。 */
const DEFAULT_WARNING_THRESHOLD = 0.85;
/** 默认淘汰触发阈值：达到预算的 95% 开始主动淘汰（避免抖动）。 */
const DEFAULT_EVICTION_THRESHOLD = 0.95;
/** 默认单帧最多淘汰批大小：避免单帧卡顿过长。 */
const DEFAULT_EVICTION_BATCH_SIZE = 32;
/** 默认检查间隔：每帧检查（1）；提高该值可降低 check() 开销。 */
const DEFAULT_CHECK_INTERVAL_FRAMES = 1;

/** 最小合法预算字节（1 KiB），避免除零与无意义配置。 */
const MIN_BUDGET_BYTES = 1024;
/** 合法阈值必须在 (0,1] 内；用于 clamp 与校验。 */
const EPSILON_RATIO = 1e-6;

/**
 * MemoryBudget 的运行时配置。
 * 所有字段只读，修改通过 `updateConfig` 合并更新，避免半初始化状态外泄。
 */
export interface MemoryBudgetConfig {
  /** GPU 最大允许占用（字节） */
  readonly gpuBudget: number;
  /** CPU 最大允许占用（字节） */
  readonly cpuBudget: number;
  /** 告警阈值：gpu/cpu 利用率达到该比例时触发 onWarning（0~1） */
  readonly warningThreshold: number;
  /** 淘汰阈值：gpu/cpu 利用率达到该比例时允许触发主动淘汰（0~1） */
  readonly evictionThreshold: number;
  /** 单轮淘汰的最大批大小（防止单帧停顿过久） */
  readonly evictionBatchSize: number;
  /** 至少每隔多少帧执行一次完整检查（1 表示每帧） */
  readonly checkIntervalFrames: number;
}

/**
 * 某一时刻的内存快照（用于 HUD/诊断/回调）。
 */
export interface MemorySnapshot {
  /** GPU 已用字节（来自 tracker.totalBytes） */
  readonly gpuUsed: number;
  /** GPU 预算字节 */
  readonly gpuBudget: number;
  /** GPU 利用率：gpuUsed / gpuBudget（0~+∞，>1 表示超预算） */
  readonly gpuUtilization: number;
  /** CPU 已用字节（来自 resourceManager.stats.cpuBytes） */
  readonly cpuUsed: number;
  /** CPU 预算字节 */
  readonly cpuBudget: number;
  /** CPU 利用率：cpuUsed / cpuBudget */
  readonly cpuUtilization: number;
  /** tile 桶资源数量（按 state=`tile` 计数） */
  readonly tileCacheCount: number;
  /** texture 桶资源数量（按 state=`texture` 计数） */
  readonly textureCacheCount: number;
  /** buffer 桶资源数量（按 state=`buffer` 计数） */
  readonly bufferCacheCount: number;
}

/**
 * `check()` 的淘汰结果摘要。
 */
export interface EvictionResult {
  /** 本轮合并去重后的被淘汰资源 id */
  readonly evicted: string[];
  /** 估算释放的 GPU 字节（基于淘汰前记录的 tracker 差分或条目 byteSize） */
  readonly freedGpuBytes: number;
  /** 估算释放的 CPU 字节（基于被淘汰条目的 byteSize 求和） */
  readonly freedCpuBytes: number;
  /** 检查开始时是否已处于超预算状态（用于上层策略分流） */
  readonly wasOverBudget: boolean;
}

/**
 * MemoryBudget 实例接口：配置、检查、快照与事件订阅。
 */
export interface MemoryBudget {
  /** 当前生效配置（只读视图） */
  readonly config: MemoryBudgetConfig;
  /**
   * 合并更新配置；未提供字段保持原值。
   *
   * @param config - 部分配置
   */
  updateConfig(config: Partial<MemoryBudgetConfig>): void;
  /**
   * 执行一次预算检查：必要时触发 GPU enforceBudget 与 CPU LRU 淘汰。
   *
   * @param gpuTracker - GPU 追踪器（可替换实现）
   * @param resourceManager - 资源管理器（可替换实现）
   * @param currentFrame - 当前帧序号（必须为非负有限数）
   */
  check(
    gpuTracker: GPUMemoryTrackerLike,
    resourceManager: ResourceManagerLike,
    currentFrame: number,
  ): EvictionResult;
  /**
   * 生成当前内存快照（不做淘汰）。
   *
   * @param gpuTracker - GPU 追踪器
   * @param resourceManager - 资源管理器
   */
  snapshot(
    gpuTracker: GPUMemoryTrackerLike,
    resourceManager: ResourceManagerLike,
  ): MemorySnapshot;
  /**
   * 订阅告警回调（利用率超过 warningThreshold）。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onWarning(callback: (snapshot: MemorySnapshot) => void): () => void;
  /**
   * 订阅淘汰回调（只要本轮 evicted 非空就会触发）。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onEviction(callback: (evictedIds: string[]) => void): () => void;
  /**
   * 订阅超预算回调（检查开始时 gpu/cpu 任一已超预算）。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onBudgetExceeded(callback: (snapshot: MemorySnapshot) => void): () => void;
}

/**
 * 将数值限制在有限范围；用于避免 NaN/Infinity 污染预算计算。
 *
 * @param value - 输入值
 * @param fallback - 非有限值时的回退值
 * @returns 有限数
 *
 * @example
 * const x = finiteOr(1 / 0, 0); // → 0
 */
function finiteOr(value: number, fallback: number): number {
  // Number.isFinite 同时排除 NaN 与 ±Infinity，符合预算统计要求
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 将预算字节数约束到合理下限，避免除零与无意义配置。
 *
 * @param bytes - 原始字节预算
 * @returns 夹紧后的字节预算
 *
 * @example
 * const b = clampBudgetBytes(-1); // → 1024
 */
function clampBudgetBytes(bytes: number): number {
  const v = finiteOr(bytes, MIN_BUDGET_BYTES);
  // 负数预算在语义上不可用：夹到最小值，保证利用率分母稳定
  return Math.max(MIN_BUDGET_BYTES, v);
}

/**
 * 将阈值约束到 (0,1] 区间，避免告警/淘汰阈值失效。
 *
 * @param t - 原始阈值
 * @returns 夹紧后的阈值
 *
 * @example
 * const w = clampThreshold(1.2); // → 1
 */
function clampThreshold(t: number): number {
  const v = finiteOr(t, DEFAULT_WARNING_THRESHOLD);
  // 阈值必须 >0，否则告警永不触发；上限 1 表示“到达 100% 才触发”
  return Math.min(1, Math.max(EPSILON_RATIO, v));
}

/**
 * 合并默认与部分配置，形成完整配置对象。
 *
 * @param partial - 部分配置
 * @returns 完整配置
 *
 * @example
 * const cfg = mergeMemoryBudgetConfig({ gpuBudget: 1 << 30 });
 */
function mergeMemoryBudgetConfig(partial?: Partial<MemoryBudgetConfig>): MemoryBudgetConfig {
  const p = partial ?? {};
  // 先读取 partial，再逐项夹紧；避免字段缺失时使用默认值
  return {
    gpuBudget: clampBudgetBytes(p.gpuBudget ?? DEFAULT_GPU_BUDGET_BYTES),
    cpuBudget: clampBudgetBytes(p.cpuBudget ?? DEFAULT_CPU_BUDGET_BYTES),
    warningThreshold: clampThreshold(p.warningThreshold ?? DEFAULT_WARNING_THRESHOLD),
    evictionThreshold: clampThreshold(p.evictionThreshold ?? DEFAULT_EVICTION_THRESHOLD),
    evictionBatchSize: Math.max(
      1,
      Math.floor(finiteOr(p.evictionBatchSize ?? DEFAULT_EVICTION_BATCH_SIZE, DEFAULT_EVICTION_BATCH_SIZE)),
    ),
    checkIntervalFrames: Math.max(
      1,
      Math.floor(finiteOr(p.checkIntervalFrames ?? DEFAULT_CHECK_INTERVAL_FRAMES, DEFAULT_CHECK_INTERVAL_FRAMES)),
    ),
  };
}

/**
 * 计算利用率：used/budget，并对非法输入回退为 0。
 *
 * @param used - 已用字节
 * @param budget - 预算字节
 * @returns 利用率（0~+∞）
 *
 * @example
 * const u = utilization(50, 100); // → 0.5
 */
function utilization(used: number, budget: number): number {
  const u = finiteOr(used, 0);
  const b = clampBudgetBytes(budget);
  // b 已保证 >= MIN_BUDGET_BYTES，因此除法安全
  return Math.max(0, u) / b;
}

/**
 * 统计某状态桶条目数量（getByState 抛错时回退 0）。
 *
 * @param rm - 资源管理器
 * @param state - 状态标签
 * @returns 条目数量
 *
 * @example
 * const n = safeCountByState(rm, 'tile');
 */
function safeCountByState(rm: ResourceManagerLike, state: string): number {
  try {
    const entries = rm.getByState(state);
    // entries 可能为 null（错误实现），需要兜底
    if (!Array.isArray(entries)) {
      return 0;
    }
    return entries.length;
  } catch {
    // 分桶查询失败不应拖垮预算系统：返回 0 并继续其它统计
    return 0;
  }
}

/**
 * 构建 MemorySnapshot（纯函数，便于测试与复用）。
 *
 * @param gpuTracker - GPU 追踪器
 * @param resourceManager - 资源管理器
 * @param cfg - 预算配置
 * @returns 快照对象
 *
 * @example
 * const snap = buildSnapshot(tracker, rm, cfg);
 */
function buildSnapshot(
  gpuTracker: GPUMemoryTrackerLike,
  resourceManager: ResourceManagerLike,
  cfg: MemoryBudgetConfig,
): MemorySnapshot {
  let gpuUsed = 0;
  let cpuUsed = 0;
  try {
    gpuUsed = Math.max(0, finiteOr(gpuTracker.totalBytes, 0));
  } catch {
    // tracker 读取失败：按 0 处理，避免预算模块崩溃
    gpuUsed = 0;
  }
  try {
    cpuUsed = Math.max(0, finiteOr(resourceManager.stats.cpuBytes, 0));
  } catch {
    cpuUsed = 0;
  }

  const gpuBudget = cfg.gpuBudget;
  const cpuBudget = cfg.cpuBudget;

  return {
    gpuUsed,
    gpuBudget,
    gpuUtilization: utilization(gpuUsed, gpuBudget),
    cpuUsed,
    cpuBudget,
    cpuUtilization: utilization(cpuUsed, cpuBudget),
    tileCacheCount: safeCountByState(resourceManager, KNOWN_CACHE_STATE_TILE),
    textureCacheCount: safeCountByState(resourceManager, KNOWN_CACHE_STATE_TEXTURE),
    bufferCacheCount: safeCountByState(resourceManager, KNOWN_CACHE_STATE_BUFFER),
  };
}

/**
 * 判断是否需要在本帧执行完整检查（包含淘汰）。
 *
 * @param currentFrame - 当前帧
 * @param lastFrame - 上次检查帧
 * @param interval - 最小间隔帧数
 * @param force - 是否强制（超预算）
 * @returns 是否执行
 *
 * @example
 * const run = shouldRunCheck(10, 8, 2, false); // → false
 */
function shouldRunCheck(currentFrame: number, lastFrame: number, interval: number, force: boolean): boolean {
  if (force) {
    return true;
  }
  const cf = Math.max(0, Math.floor(finiteOr(currentFrame, 0)));
  const lf = Math.max(0, Math.floor(finiteOr(lastFrame, 0)));
  const step = Math.max(1, Math.floor(finiteOr(interval, 1)));
  // 用帧差驱动节流：避免每帧都执行昂贵的 LRU 合并排序
  return cf - lf >= step;
}

/**
 * 合并并去重 id 列表，保持首次出现顺序。
 *
 * @param a - 列表 a
 * @param b - 列表 b
 * @returns 合并结果
 *
 * @example
 * const ids = mergeIdLists(['a'], ['a', 'b']); // → ['a','b']
 */
function mergeIdLists(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of a) {
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  for (const id of b) {
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 从 ResourceManager 拉取 CPU 侧候选淘汰条目并排序（LRU：lastAccessFrame 升序）。
 *
 * @param resourceManager - 资源管理器
 * @returns 候选条目
 *
 * @example
 * const cands = collectCpuEvictionCandidates(rm);
 */
function collectCpuEvictionCandidates(
  resourceManager: ResourceManagerLike,
): Array<{ id: string; byteSize: number; lastAccessFrame: number; refCount: number }> {
  const states = [KNOWN_CACHE_STATE_TILE, KNOWN_CACHE_STATE_TEXTURE, KNOWN_CACHE_STATE_BUFFER, 'other'];
  const byId = new Map<string, { id: string; byteSize: number; lastAccessFrame: number; refCount: number }>();
  try {
    for (const st of states) {
      const part = resourceManager.getByState(st);
      if (!Array.isArray(part)) {
        continue;
      }
      for (const e of part) {
        if (!e || typeof e.id !== 'string' || e.id.length === 0) {
          continue;
        }
        const next = {
          id: e.id,
          byteSize: Math.max(0, finiteOr(e.byteSize, 0)),
          lastAccessFrame: Math.max(0, finiteOr(e.lastAccessFrame, 0)),
          refCount: Math.max(0, finiteOr(e.refCount, 0)),
        };
        const prev = byId.get(next.id);
        if (!prev) {
          byId.set(next.id, next);
          continue;
        }
        // 同一 id 多桶重复出现时：保留“更容易淘汰”的视图（ref 更低、帧更旧）
        if (prev.refCount !== next.refCount) {
          if (next.refCount < prev.refCount) {
            byId.set(next.id, next);
          }
          continue;
        }
        if (next.lastAccessFrame < prev.lastAccessFrame) {
          byId.set(next.id, next);
        }
      }
    }
  } catch {
    // getByState 异常：返回空候选，交由上层决定是否仅处理 GPU
    return [];
  }
  const merged = Array.from(byId.values());
  // 先按 refCount（升序）再按 lastAccessFrame（升序）：优先淘汰无引用且最旧的资源
  merged.sort((x, y) => {
    if (x.refCount !== y.refCount) {
      return x.refCount - y.refCount;
    }
    return x.lastAccessFrame - y.lastAccessFrame;
  });
  return merged;
}

/**
 * 创建 MemoryBudget 实例。
 *
 * @param config - 可选部分配置
 * @returns MemoryBudget 句柄
 *
 * @example
 * const mb = createMemoryBudget({ gpuBudget: 64 * 1024 * 1024 });
 * mb.onWarning((s) => console.warn('mem', s.gpuUtilization));
 */
export function createMemoryBudget(config?: Partial<MemoryBudgetConfig>): MemoryBudget {
  let cfg = mergeMemoryBudgetConfig(config);
  let lastCheckFrame = -1;

  const warningHandlers = new Set<(snapshot: MemorySnapshot) => void>();
  const evictionHandlers = new Set<(ids: string[]) => void>();
  const exceededHandlers = new Set<(snapshot: MemorySnapshot) => void>();

  const safeCall = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      // 回调错误必须隔离：预算系统本身不能因监听器崩溃而失效
      return fallback;
    }
  };

  const emitWarning = (snap: MemorySnapshot): void => {
    for (const cb of warningHandlers) {
      safeCall(
        () => {
          cb(snap);
          return true;
        },
        true,
      );
    }
  };

  const emitEviction = (ids: string[]): void => {
    if (ids.length === 0) {
      return;
    }
    for (const cb of evictionHandlers) {
      safeCall(
        () => {
          cb(ids);
          return true;
        },
        true,
      );
    }
  };

  const emitExceeded = (snap: MemorySnapshot): void => {
    for (const cb of exceededHandlers) {
      safeCall(
        () => {
          cb(snap);
          return true;
        },
        true,
      );
    }
  };

  const budget: MemoryBudget = {
    get config(): MemoryBudgetConfig {
      return cfg;
    },

    updateConfig(partial: Partial<MemoryBudgetConfig>): void {
      cfg = mergeMemoryBudgetConfig({ ...cfg, ...partial });
    },

    snapshot(gpuTracker: GPUMemoryTrackerLike, resourceManager: ResourceManagerLike): MemorySnapshot {
      try {
        return buildSnapshot(gpuTracker, resourceManager, cfg);
      } catch {
        // 快照失败时返回“全零”快照，避免调用方拿不到对象
        return {
          gpuUsed: 0,
          gpuBudget: cfg.gpuBudget,
          gpuUtilization: 0,
          cpuUsed: 0,
          cpuBudget: cfg.cpuBudget,
          cpuUtilization: 0,
          tileCacheCount: 0,
          textureCacheCount: 0,
          bufferCacheCount: 0,
        };
      }
    },

    check(
      gpuTracker: GPUMemoryTrackerLike,
      resourceManager: ResourceManagerLike,
      currentFrame: number,
    ): EvictionResult {
      const frame = Math.max(0, Math.floor(finiteOr(currentFrame, 0)));

      const snap0 = budget.snapshot(gpuTracker, resourceManager);
      const gpuOver = snap0.gpuUsed > cfg.gpuBudget;
      const cpuOver = snap0.cpuUsed > cfg.cpuBudget;
      const wasOverBudget = gpuOver || cpuOver;

      if (wasOverBudget) {
        emitExceeded(snap0);
      }

      const warnLine = cfg.warningThreshold;
      if (snap0.gpuUtilization >= warnLine || snap0.cpuUtilization >= warnLine) {
        emitWarning(snap0);
      }

      const needEvictionPressure =
        snap0.gpuUtilization >= cfg.evictionThreshold || snap0.cpuUtilization >= cfg.evictionThreshold || wasOverBudget;

      const forceRun = wasOverBudget || needEvictionPressure;
      if (!shouldRunCheck(frame, lastCheckFrame, cfg.checkIntervalFrames, forceRun)) {
        return {
          evicted: [],
          freedGpuBytes: 0,
          freedCpuBytes: 0,
          wasOverBudget,
        };
      }
      lastCheckFrame = frame;

      let evicted: string[] = [];
      let freedGpuBytes = 0;
      let freedCpuBytes = 0;

      let gpuBytesBefore = 0;
      try {
        gpuBytesBefore = Math.max(0, finiteOr(gpuTracker.totalBytes, 0));
      } catch {
        gpuBytesBefore = 0;
      }

      // ---------- GPU：优先调用 tracker.enforceBudget（由 L1 决定具体策略） ----------
      if (snap0.gpuUsed > cfg.gpuBudget || snap0.gpuUtilization >= cfg.evictionThreshold) {
        let gpuIds: string[] = [];
        try {
          gpuIds = gpuTracker.enforceBudget(cfg.gpuBudget, frame);
        } catch {
          gpuIds = [];
        }
        if (gpuIds.length > 0) {
          evicted = mergeIdLists(evicted, gpuIds);
          try {
            resourceManager.evict(gpuIds);
          } catch {
            // evict 失败不抛：避免预算线程中断；后续帧会再次尝试
          }
        }
        let gpuBytesAfter = gpuBytesBefore;
        try {
          gpuBytesAfter = Math.max(0, finiteOr(gpuTracker.totalBytes, gpuBytesBefore));
        } catch {
          gpuBytesAfter = gpuBytesBefore;
        }
        freedGpuBytes = Math.max(0, gpuBytesBefore - gpuBytesAfter);
      }

      // ---------- CPU：LRU 批淘汰，直到回到预算或候选耗尽 ----------
      let cpuUsedNow = snap0.cpuUsed;
      try {
        cpuUsedNow = Math.max(0, finiteOr(resourceManager.stats.cpuBytes, snap0.cpuUsed));
      } catch {
        cpuUsedNow = snap0.cpuUsed;
      }

      if (cpuUsedNow > cfg.cpuBudget || snap0.cpuUtilization >= cfg.evictionThreshold) {
        const candidates = collectCpuEvictionCandidates(resourceManager);
        let safety = 0;
        // safety 上限防止异常循环（候选无限增长或 stats 不更新）
        while (cpuUsedNow > cfg.cpuBudget && safety < 10_000) {
          safety += 1;
          const batch: string[] = [];
          let batchBytes = 0;
          for (const c of candidates) {
            if (batch.length >= cfg.evictionBatchSize) {
              break;
            }
            if (c.refCount > 0) {
              // 仍有引用：跳过（避免破坏渲染中资源）；继续扫描更合适的候选
              continue;
            }
            batch.push(c.id);
            batchBytes += c.byteSize;
          }
          if (batch.length === 0) {
            break;
          }
          try {
            resourceManager.evict(batch);
          } catch {
            break;
          }
          freedCpuBytes += batchBytes;
          evicted = mergeIdLists(evicted, batch);
          // 从候选中移除已淘汰 id（避免重复 evict）
          for (const id of batch) {
            const idx = candidates.findIndex((x) => x.id === id);
            if (idx >= 0) {
              candidates.splice(idx, 1);
            }
          }
          try {
            cpuUsedNow = Math.max(0, finiteOr(resourceManager.stats.cpuBytes, cpuUsedNow - batchBytes));
          } catch {
            cpuUsedNow = Math.max(0, cpuUsedNow - batchBytes);
          }
          if (candidates.length === 0) {
            break;
          }
        }
      }

      if (evicted.length > 0) {
        emitEviction(evicted);
      }

      return {
        evicted,
        freedGpuBytes,
        freedCpuBytes,
        wasOverBudget,
      };
    },

    onWarning(callback: (snapshot: MemorySnapshot) => void): () => void {
      warningHandlers.add(callback);
      return () => {
        warningHandlers.delete(callback);
      };
    },

    onEviction(callback: (evictedIds: string[]) => void): () => void {
      evictionHandlers.add(callback);
      return () => {
        evictionHandlers.delete(callback);
      };
    },

    onBudgetExceeded(callback: (snapshot: MemorySnapshot) => void): () => void {
      exceededHandlers.add(callback);
      return () => {
        exceededHandlers.delete(callback);
      };
    },
  };

  return budget;
}
