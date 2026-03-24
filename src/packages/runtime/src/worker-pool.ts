// ============================================================
// L3/worker-pool.ts — 主线程模拟 Worker 池（MVP）
// 层级：L3（运行时调度）
// 职责：任务入队、按优先级调度、超时/取消、统计；真实 Web Worker
//       需独立 worker 入口，本实现用 setTimeout(0) 异步化，接口完整。
// ============================================================

/**
 * 支持的 Worker 任务类型（与 TileScheduler / StyleEngine 等约定对齐）。
 * 共 16 种，含 `custom` 供扩展。
 */
export type WorkerTaskType =
  | 'mvt-decode'
  | 'raster-decode'
  | 'geojson-parse'
  | 'triangulate'
  | 'simplify'
  | 'rtree-build'
  | 'rtree-query'
  | 'label-collision'
  | 'text-shaping'
  | 'split-double'
  | 'terrain-mesh'
  | 'tiles3d-bvh'
  | 'antimeridian-cut'
  | 'cluster'
  | 'boolean-op'
  | 'custom';

/**
 * 提交到池中的单个任务描述。
 *
 * @typeParam TInput - 任务输入载荷类型
 * @typeParam TOutput - 任务输出载荷类型（模拟阶段可与输入相同）
 */
export interface WorkerTask<TInput = unknown, TOutput = unknown> {
  /** 调用方生成的全局唯一任务 ID，用于 cancel / reprioritize */
  readonly id: string;

  /** 任务类型，用于 cancelByType 与统计分组 */
  readonly type: WorkerTaskType;

  /**
   * 优先级；数值越大越先执行。
   * 范围建议 [0, 2^31-1]；相等时按入队顺序 FIFO。
   */
  readonly priority: number;

  /** 任务输入；真实 Worker 会序列化后传入 */
  readonly input: TInput;

  /** 可选 transferable，真实 Worker 路径会用于零拷贝；模拟阶段仅透传到结果 */
  readonly transferables?: Transferable[];

  /** 可选中止信号；已 aborted 的任务立即拒绝 */
  readonly abortSignal?: AbortSignal;
}

/**
 * 任务完成结果。
 *
 * @typeParam TOutput - 输出载荷类型
 */
export interface WorkerTaskResult<TOutput = unknown> {
  /** 对应 WorkerTask.id */
  readonly taskId: string;

  /** 任务输出；模拟实现为 input 透传（见 createWorkerPool 说明） */
  readonly output: TOutput;

  /** 与任务提交时一致的 transferable 列表（若有） */
  readonly transferables?: Transferable[];

  /** 从调度开始到 resolve 的耗时（毫秒，performance.now） */
  readonly durationMs: number;
}

/**
 * Worker 池配置。
 */
export interface WorkerPoolConfig {
  /**
   * 并发“槽位”数量；`'auto'` 时取 `navigator.hardwareConcurrency` 启发式裁剪。
   * 模拟实现中等于可同时运行的任务上限。
   */
  readonly workerCount: number | 'auto';

  /** 等待队列最大长度（仅统计挂起任务，不含正在运行的任务） */
  readonly maxQueueSize: number;

  /**
   * 单任务超时（毫秒）；`<=0` 表示禁用超时。
   * 超时后 Promise reject，并计为 failed。
   */
  readonly taskTimeout: number;

  /**
   * 是否启用任务类型与 Worker 槽位的亲和路由（O4）。
   * 默认 `true`；为 `false` 时退化为按负载最少分配。
   */
  readonly enableTaskAffinity?: boolean;
}

/**
 * Worker 池对外能力（MVP 为模拟池，行为与真实池一致，仅执行体不同）。
 */
export interface WorkerPool {
  /**
   * 初始化池；可重复调用时若已初始化则幂等 resolve。
   *
   * @param config - 池配置
   * @returns 异步完成时池可用
   */
  initialize(config: WorkerPoolConfig): Promise<void>;

  /** 是否已 initialize 成功 */
  readonly isInitialized: boolean;

  /** 当前并发槽位数（initialize 后有效） */
  readonly workerCount: number;

  /**
   * 提交单个任务。
   *
   * @typeParam TInput - 输入类型
   * @typeParam TOutput - 输出类型
   * @param task - 任务描述
   * @returns 任务结果 Promise
   */
  submit<TInput, TOutput>(task: WorkerTask<TInput, TOutput>): Promise<WorkerTaskResult<TOutput>>;

  /**
   * 批量提交；顺序不保证完成顺序，全部独立入队。
   *
   * @typeParam TInput - 输入类型
   * @typeParam TOutput - 输出类型
   * @param tasks - 任务数组
   * @returns 与 tasks 同序的结果数组（任一失败则整批 reject）
   */
  submitBatch<TInput, TOutput>(
    tasks: WorkerTask<TInput, TOutput>[]
  ): Promise<WorkerTaskResult<TOutput>[]>;

  /**
   * 取消指定 ID：若在等待队列则移除并拒绝；若正在运行则标记取消（尽力）。
   *
   * @param taskId - 任务 ID
   * @returns 是否找到并处理了该任务
   */
  cancel(taskId: string): boolean;

  /**
   * 按类型批量取消。
   *
   * @param type - 任务类型
   * @returns 被取消的任务数量
   */
  cancelByType(type: WorkerTaskType): number;

  /**
   * 调整等待中任务的优先级；运行中任务返回 false。
   *
   * @param taskId - 任务 ID
   * @param newPriority - 新优先级
   * @returns 是否成功调整
   */
  reprioritize(taskId: string, newPriority: number): boolean;

  /** 运行时统计快照（只读） */
  readonly stats: {
    /** 当前正在执行任务所占用的槽位数 */
    readonly activeWorkers: number;
    /** 空闲槽位数 = workerCount - activeWorkers */
    readonly idleWorkers: number;
    /** 等待队列中的任务数 */
    readonly queuedTasks: number;
    /** 与 activeWorkers 相同（语义：正在运行的任务数） */
    readonly runningTasks: number;
    /** 历史成功完成数（累计） */
    readonly completedTasks: number;
    /** 历史失败数（超时、异常、取消，累计） */
    readonly failedTasks: number;
    /** 已完成任务的平均耗时（毫秒）；无完成记录时为 0 */
    readonly averageTaskTimeMs: number;

    /** 亲和路由命中次数：成功路由到偏好槽位（累计） */
    readonly affinityHitCount: number;

    /** 亲和路由未命中次数：存在偏好但因过载等原因改用其它槽位（累计） */
    readonly affinityMissCount: number;
  };

  /**
   * 终止池：清空队列、拒绝挂起任务、尽力取消运行中任务；之后 submit 会抛错。
   */
  terminate(): void;
}

// ===================== 内部常量 =====================

/** `'auto'` 时使用的默认并发数（无法读取硬件信息时） */
const AUTO_WORKER_FALLBACK = 4;

/** 并发槽位下限，避免 0 导致死锁 */
const MIN_WORKER_SLOTS = 1;

/** 并发槽位上限，避免在超大机器上创建过多并发任务 */
const MAX_WORKER_SLOTS = 32;

/** 连续同类型任务在同槽位完成达到该次数后锁定亲和（O4） */
const AFFINITY_LOCK_STREAK = 5;

/** 过载判定：偏好槽位等待队列长度超过平均队列长度的该倍数时退避 */
const AFFINITY_OVERLOAD_QUEUE_FACTOR = 3;

/** 单调递增序列，用于同优先级 FIFO */
let globalSequence = 0;

// ===================== 内部类型 =====================

/**
 * 内部任务节点：在 WorkerTask 基础上增加 Promise 控制与元数据。
 */
interface InternalTaskNode {
  /** 与 WorkerTask.id 一致 */
  readonly id: string;

  /** 任务类型 */
  readonly type: WorkerTaskType;

  /** 当前优先级（可被 reprioritize 修改） */
  priority: number;

  /** 入队序列，保证同优先级稳定排序 */
  readonly sequence: number;

  /** 输入载荷 */
  readonly input: unknown;

  /** transferable 透传 */
  readonly transferables?: Transferable[];

  /** 用户传入的 AbortSignal（若有） */
  readonly userAbort?: AbortSignal;

  /** 内部取消用控制器（与 userAbort 合并） */
  readonly internalAbort: AbortController;

  /** 成功回调 */
  readonly resolve: (value: WorkerTaskResult<unknown>) => void;

  /** 失败回调 */
  readonly reject: (reason: Error) => void;

  /** 超时定时器 ID；无超时则为 undefined */
  timeoutId?: ReturnType<typeof setTimeout>;

  /** setTimeout(0) 返回的句柄，用于 terminate 时清理 */
  runHandle?: ReturnType<typeof setTimeout>;

  /** 是否已从队列移出并开始执行逻辑 */
  started: boolean;

  /**
   * 该任务绑定的 Worker 槽位索引 `[0, workerCount)`；
   * 在 `schedule` 出队时写入，用于亲和统计与完成回调。
   */
  assignedWorkerIndex?: number;
}

// ===================== 工具函数 =====================

/**
 * 判定 a 是否应比 b 先出队（优先级更高或同优先级先入队者优先）。
 *
 * @param a - 候选任务 a
 * @param b - 候选任务 b
 * @returns 若 a 应先于 b 出队则为 true
 */
function shouldDequeueBefore(a: InternalTaskNode, b: InternalTaskNode): boolean {
  // 高 priority 先执行；同 priority 时序号小者先（FIFO）
  if (a.priority !== b.priority) {
    return a.priority > b.priority;
  }
  return a.sequence < b.sequence;
}

/**
 * 将任务按优先级插入等待队列，保持队首为最高优先级。
 *
 * @param queue - 等待队列（可变）
 * @param node - 新任务节点
 */
function insertByPriority(queue: InternalTaskNode[], node: InternalTaskNode): void {
  // 线性查找插入点：对 MVP 足够；队列过长时可换二分堆
  let index = 0;
  while (index < queue.length && shouldDequeueBefore(queue[index], node)) {
    index += 1;
  }
  queue.splice(index, 0, node);
}

/**
 * 解析并发槽位数。
 *
 * @param workerCount - 配置项
 * @returns 实际槽位数
 */
function resolveWorkerCount(workerCount: number | 'auto'): number {
  if (typeof workerCount === 'number') {
    // 防御：非法数值回退到 fallback，避免 NaN/Infinity
    if (!Number.isFinite(workerCount) || workerCount < MIN_WORKER_SLOTS) {
      return AUTO_WORKER_FALLBACK;
    }
    return Math.min(MAX_WORKER_SLOTS, Math.floor(workerCount));
  }
  // 浏览器环境尝试 hardwareConcurrency；非浏览器或无该 API 时用 fallback
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    const hc = navigator.hardwareConcurrency;
    if (Number.isFinite(hc) && hc >= 1) {
      // 留一核给主线程与 GPU 提交，经验值且 capped
      const suggested = Math.max(MIN_WORKER_SLOTS, Math.min(MAX_WORKER_SLOTS, hc - 1));
      return suggested;
    }
  }
  return AUTO_WORKER_FALLBACK;
}

/**
 * 合并用户 AbortSignal 与内部 controller，任一 abort 则触发。
 *
 * @param user - 用户信号，可缺省
 * @param internal - 内部 AbortController
 * @returns 卸载函数，用于任务结束时移除监听
 */
function linkAbortSignals(user: AbortSignal | undefined, internal: AbortController): () => void {
  if (!user) {
    return () => {
      /* noop */
    };
  }
  const onAbort = (): void => {
    internal.abort();
  };
  if (user.aborted) {
    internal.abort();
    return () => {
      /* noop */
    };
  }
  user.addEventListener('abort', onAbort, { once: true });
  return () => {
    user.removeEventListener('abort', onAbort);
  };
}

/**
 * 模拟 Worker 计算：将 input 原样作为 output（类型断言），保证泛型链路可用。
 *
 * @typeParam TOutput - 输出类型
 * @param input - 输入
 * @returns 模拟输出
 */
function simulateWorkerOutput<TOutput>(input: unknown): TOutput {
  // MVP：无真实算法，透传 input；调用方应把 TOutput 与业务约定一致
  return input as TOutput;
}

// ===================== 实现 =====================

/**
 * 创建主线程模拟的 Worker 池实例。
 *
 * @returns WorkerPool 实现
 *
 * @example
 * const pool = createWorkerPool();
 * await pool.initialize({ workerCount: 2, maxQueueSize: 64, taskTimeout: 5000 });
 * const out = await pool.submit({
 *   id: 't1',
 *   type: 'mvt-decode',
 *   priority: 10,
 *   input: new ArrayBuffer(8),
 * });
 * console.log(out.durationMs);
 */
export function createWorkerPool(): WorkerPool {
  /** 是否已初始化 */
  let initialized = false;

  /** 是否已终止 */
  let terminated = false;

  /** 槽位数量 */
  let slots = AUTO_WORKER_FALLBACK;

  /** 配置副本 */
  let config: WorkerPoolConfig | undefined;

  /** 是否启用任务类型亲和（默认 true，由 initialize 写入） */
  let enableTaskAffinity = true;

  /**
   * 任务类型 → 偏好 Worker 槽位索引（O4 亲和表；连续同槽完成 5 次同类型任务后锁定）。
   */
  const _workerAffinityMap = new Map<string, number>();

  /** 各槽位上的等待队列（优先级队列，与原先全局队列语义一致，仅按亲和分片） */
  let pendingQueues: InternalTaskNode[][] = [];

  /** 各槽位当前是否正在执行任务（与 `runningById` 一致，便于 O(1) 定位槽位负载） */
  let runningByWorker: Array<InternalTaskNode | undefined> = [];

  /** 等待队列索引 id -> node（用于 O(1) cancel / reprioritize） */
  const pendingById = new Map<string, InternalTaskNode>();

  /** 运行中任务 id -> node */
  const runningById = new Map<string, InternalTaskNode>();

  /** 当前占用槽位数 */
  let runningCount = 0;

  /** 完成任务数 */
  let completedTasks = 0;

  /** 失败任务数 */
  let failedTasks = 0;

  /** 完成耗时总和（用于均值） */
  let totalDurationMs = 0;

  /** 亲和路由命中累计 */
  let affinityHitCount = 0;

  /** 亲和路由未命中累计 */
  let affinityMissCount = 0;

  /**
   * 任务类型 → 最近一次连续完成的槽位与连击数（用于锁定亲和）。
   */
  const affinityStreakByType = new Map<string, { readonly worker: number; streak: number }>();

  /**
   * 将 `pendingQueues` / `runningByWorker` 调整为当前 `slots` 长度（initialize 时调用）。
   * 槽位减少时，溢出等待队列合并至最后一个槽位，避免任务丢失。
   *
   * @param newSlots - 新的并发槽位数
   */
  function ensureWorkerStructures(newSlots: number): void {
    if (newSlots <= 0 || !Number.isFinite(newSlots)) {
      return;
    }
    if (pendingQueues.length === newSlots && runningByWorker.length === newSlots) {
      return;
    }
    const oldPending = pendingQueues;
    const oldRunning = runningByWorker;
    pendingQueues = [];
    runningByWorker = [];
    for (let i = 0; i < newSlots; i += 1) {
      pendingQueues.push(oldPending[i] ?? []);
      runningByWorker.push(oldRunning[i]);
    }
    if (oldPending.length > newSlots) {
      const sink = pendingQueues[newSlots - 1];
      if (sink) {
        for (let j = newSlots; j < oldPending.length; j += 1) {
          const overflow = oldPending[j];
          if (!overflow) {
            continue;
          }
          for (let k = 0; k < overflow.length; k += 1) {
            insertByPriority(sink, overflow[k]!);
          }
        }
      }
    }
  }

  /**
   * 计算所有槽位等待队列长度的算术平均（用于过载判定）。
   */
  function averagePendingQueueLength(): number {
    if (slots <= 0) {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < slots; i += 1) {
      sum += pendingQueues[i]?.length ?? 0;
    }
    return sum / slots;
  }

  /**
   * 选取负载最轻的槽位索引（等待数 + 是否运行中计 1）。
   *
   * @returns 槽位索引 `[0, slots)`
   */
  function pickLeastLoadedWorkerIndex(): number {
    let best = 0;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slots; i += 1) {
      const q = pendingQueues[i]?.length ?? 0;
      const run = runningByWorker[i] ? 1 : 0;
      const load = q + run;
      if (load < bestLoad) {
        bestLoad = load;
        best = i;
      }
    }
    return best;
  }

  /**
   * 为即将入队的任务选择槽位：亲和优先，过载时退避到最轻载槽位（O4）。
   *
   * @param taskType - 任务类型键（与 `WorkerTaskType` 字符串一致）
   * @returns 槽位索引
   */
  function pickWorkerIndexForTask(taskType: string): number {
    if (!enableTaskAffinity || slots <= 0) {
      return pickLeastLoadedWorkerIndex();
    }
    const preferred = _workerAffinityMap.get(taskType);
    if (
      preferred === undefined ||
      !Number.isFinite(preferred) ||
      preferred < 0 ||
      preferred >= slots
    ) {
      return pickLeastLoadedWorkerIndex();
    }
    const prefQueueLen = pendingQueues[preferred]?.length ?? 0;
    const avg = averagePendingQueueLength();
    const overloadThreshold = AFFINITY_OVERLOAD_QUEUE_FACTOR * avg;
    // 平均为 0 时仅当偏好槽位已有积压才视为过载，避免除零与误伤
    const isOverloaded =
      avg > 0 ? prefQueueLen > overloadThreshold : prefQueueLen > 0 && slots > 1;
    if (!isOverloaded) {
      affinityHitCount += 1;
      return preferred;
    }
    affinityMissCount += 1;
    return pickLeastLoadedWorkerIndex();
  }

  /**
   * 任务成功完成后更新连续同槽计数，达到阈值则锁定亲和。
   *
   * @param node - 已完成节点
   */
  function updateAffinityAfterSuccess(node: InternalTaskNode): void {
    if (!enableTaskAffinity) {
      return;
    }
    const w = node.assignedWorkerIndex;
    if (w === undefined || !Number.isFinite(w) || w < 0 || w >= slots) {
      return;
    }
    const typeKey = node.type;
    const prev = affinityStreakByType.get(typeKey);
    if (prev && prev.worker === w) {
      const nextStreak = prev.streak + 1;
      affinityStreakByType.set(typeKey, { worker: w, streak: nextStreak });
      if (nextStreak >= AFFINITY_LOCK_STREAK) {
        _workerAffinityMap.set(typeKey, w);
      }
    } else {
      affinityStreakByType.set(typeKey, { worker: w, streak: 1 });
    }
  }

  /**
   * 调度下一批任务：每个空闲槽位从其等待队列取最高优先级任务并启动。
   */
  function schedule(): void {
    // 终止后不再调度，避免 terminate 后仍触发回调
    if (terminated) {
      return;
    }
    for (let w = 0; w < slots; w += 1) {
      if (runningByWorker[w]) {
        continue;
      }
      const pq = pendingQueues[w];
      if (!pq || pq.length === 0) {
        continue;
      }
      const node = pq.shift();
      if (!node) {
        continue;
      }
      pendingById.delete(node.id);
      runningCount += 1;
      runningByWorker[w] = node;
      node.assignedWorkerIndex = w;
      runningById.set(node.id, node);
      node.started = true;
      startSimulatedRun(node);
    }
  }

  /**
   * 使用 setTimeout(0) 异步执行单任务模拟。
   *
   * @param node - 内部任务节点
   */
  function startSimulatedRun(node: InternalTaskNode): void {
    const unlinkUser = linkAbortSignals(node.userAbort, node.internalAbort);

    const signal = node.internalAbort.signal;
    if (signal.aborted) {
      finishFailure(node, new DOMException('The task was aborted.', 'AbortError'), unlinkUser);
      return;
    }

    const startedAt = performance.now();

    // 配置超时：与内部 abort 联动
    if (config && config.taskTimeout > 0) {
      node.timeoutId = setTimeout(() => {
        node.internalAbort.abort();
      }, config.taskTimeout);
    }

    // 主线程让出：模拟 Worker 异步完成
    node.runHandle = setTimeout(() => {
      try {
        if (node.internalAbort.signal.aborted) {
          throw new DOMException('The task was aborted.', 'AbortError');
        }
        const output = simulateWorkerOutput(node.input);
        const durationMs = performance.now() - startedAt;
        clearTimeoutIfAny(node);
        unlinkUser();
        runningById.delete(node.id);
        runningCount -= 1;
        const wDone = node.assignedWorkerIndex;
        if (
          wDone !== undefined &&
          Number.isFinite(wDone) &&
          wDone >= 0 &&
          wDone < slots &&
          runningByWorker[wDone] === node
        ) {
          runningByWorker[wDone] = undefined;
        }
        completedTasks += 1;
        totalDurationMs += durationMs;
        updateAffinityAfterSuccess(node);
        node.resolve({
          taskId: node.id,
          output,
          transferables: node.transferables,
          durationMs,
        });
        schedule();
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Worker task failed');
        finishFailure(node, error, unlinkUser);
      }
    }, 0);
  }

  /**
   * 清理节点上的超时定时器。
   *
   * @param node - 任务节点
   */
  function clearTimeoutIfAny(node: InternalTaskNode): void {
    if (node.timeoutId !== undefined) {
      clearTimeout(node.timeoutId);
      node.timeoutId = undefined;
    }
  }

  /**
   * 失败收尾：更新统计、释放槽位并继续调度。
   *
   * @param node - 任务节点
   * @param error - 错误对象
   * @param unlinkUser - 卸载用户 abort 监听
   */
  function finishFailure(node: InternalTaskNode, error: Error, unlinkUser: () => void): void {
    clearTimeoutIfAny(node);
    if (node.runHandle !== undefined) {
      clearTimeout(node.runHandle);
      node.runHandle = undefined;
    }
    unlinkUser();
    if (runningById.has(node.id)) {
      runningById.delete(node.id);
      runningCount -= 1;
      const wFail = node.assignedWorkerIndex;
      if (
        wFail !== undefined &&
        Number.isFinite(wFail) &&
        wFail >= 0 &&
        wFail < slots &&
        runningByWorker[wFail] === node
      ) {
        runningByWorker[wFail] = undefined;
      }
    }
    failedTasks += 1;
    node.reject(error);
    schedule();
  }

  /**
   * 拒绝队列中的节点（用于 cancel / terminate）。
   *
   * @param node - 节点
   * @param message - 错误信息
   */
  function rejectPending(node: InternalTaskNode, message: string): void {
    clearTimeoutIfAny(node);
    pendingById.delete(node.id);
    for (let w = 0; w < slots; w += 1) {
      const pq = pendingQueues[w];
      if (!pq) {
        continue;
      }
      const idx = pq.indexOf(node);
      if (idx >= 0) {
        pq.splice(idx, 1);
        break;
      }
    }
    failedTasks += 1;
    node.reject(new DOMException(message, 'AbortError'));
  }

  /**
   * 所有槽位等待队列长度之和。
   */
  function totalPendingCount(): number {
    let n = 0;
    for (let w = 0; w < slots; w += 1) {
      n += pendingQueues[w]?.length ?? 0;
    }
    return n;
  }

  /** 前向引用：submitBatch 需要调用同实例的 submit */
  let pool: WorkerPool;

  pool = {
    async initialize(initConfig: WorkerPoolConfig): Promise<void> {
      // 已终止则不允许再初始化，避免状态混乱
      if (terminated) {
        throw new Error('WorkerPool: cannot initialize after terminate().');
      }
      if (!initConfig || typeof initConfig !== 'object') {
        throw new TypeError('WorkerPool.initialize: config must be an object.');
      }
      if (!Number.isFinite(initConfig.maxQueueSize) || initConfig.maxQueueSize < 0) {
        throw new RangeError('WorkerPool.initialize: maxQueueSize must be a non-negative finite number.');
      }
      slots = resolveWorkerCount(initConfig.workerCount);
      config = initConfig;
      enableTaskAffinity = initConfig.enableTaskAffinity !== false;
      ensureWorkerStructures(slots);
      initialized = true;
      // 允许微任务链继续，保持 API 为 Promise
      await Promise.resolve();
    },

    get isInitialized(): boolean {
      return initialized && !terminated;
    },

    get workerCount(): number {
      return slots;
    },

    submit<TInput, TOutput>(task: WorkerTask<TInput, TOutput>): Promise<WorkerTaskResult<TOutput>> {
      if (!initialized || terminated) {
        return Promise.reject(new Error('WorkerPool: submit before initialize or after terminate.'));
      }
      if (!task || typeof task.id !== 'string' || task.id.length === 0) {
        return Promise.reject(new TypeError('WorkerPool.submit: task.id must be a non-empty string.'));
      }
      if (!Number.isFinite(task.priority)) {
        return Promise.reject(new RangeError('WorkerPool.submit: task.priority must be finite.'));
      }
      if (pendingById.has(task.id) || runningById.has(task.id)) {
        return Promise.reject(new Error(`WorkerPool.submit: duplicate task id "${task.id}".`));
      }
      if (config && totalPendingCount() >= config.maxQueueSize) {
        return Promise.reject(new Error('WorkerPool.submit: queue is full (maxQueueSize exceeded).'));
      }
      if (task.abortSignal?.aborted) {
        return Promise.reject(new DOMException('The task was aborted.', 'AbortError'));
      }

      return new Promise<WorkerTaskResult<TOutput>>((resolve, reject) => {
        const internalAbort = new AbortController();
        const sequence = globalSequence++;
        const node: InternalTaskNode = {
          id: task.id,
          type: task.type,
          priority: task.priority,
          sequence,
          input: task.input,
          transferables: task.transferables,
          userAbort: task.abortSignal,
          internalAbort,
          resolve: resolve as (v: WorkerTaskResult<unknown>) => void,
          reject,
          started: false,
        };
        pendingById.set(task.id, node);
        const workerIndex = pickWorkerIndexForTask(task.type);
        const pq = pendingQueues[workerIndex];
        if (!pq) {
          pendingById.delete(task.id);
          reject(new Error('WorkerPool.submit: internal worker queue is uninitialized.'));
          return;
        }
        insertByPriority(pq, node);
        schedule();
      });
    },

    submitBatch<TInput, TOutput>(
      tasks: WorkerTask<TInput, TOutput>[]
    ): Promise<WorkerTaskResult<TOutput>[]> {
      // 批量语义：并行 submit；任一失败则整批 reject（Promise.all 行为）
      if (!Array.isArray(tasks)) {
        return Promise.reject(
          new TypeError('WorkerPool.submitBatch: tasks must be an array.')
        );
      }
      if (tasks.length === 0) {
        return Promise.resolve([]);
      }
      return Promise.all(tasks.map((t) => pool.submit(t)));
    },

    cancel(taskId: string): boolean {
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return false;
      }
      const pending = pendingById.get(taskId);
      if (pending) {
        rejectPending(pending, 'Worker task cancelled.');
        schedule();
        return true;
      }
      const running = runningById.get(taskId);
      if (running) {
        running.internalAbort.abort();
        return true;
      }
      return false;
    },

    cancelByType(type: WorkerTaskType): number {
      let count = 0;
      for (let w = 0; w < slots; w += 1) {
        const pq = pendingQueues[w];
        if (!pq || pq.length === 0) {
          continue;
        }
        const snapshot = pq.slice();
        for (let i = 0; i < snapshot.length; i += 1) {
          const node = snapshot[i];
          if (node && node.type === type) {
            if (pendingById.has(node.id)) {
              rejectPending(node, 'Worker task cancelled by type.');
              count += 1;
            }
          }
        }
      }
      if (count > 0) {
        schedule();
      }
      // 运行中：abort 所有匹配类型（尽力）
      const runningSnapshot = Array.from(runningById.values());
      for (let j = 0; j < runningSnapshot.length; j += 1) {
        const r = runningSnapshot[j];
        if (r.type === type) {
          r.internalAbort.abort();
          count += 1;
        }
      }
      return count;
    },

    reprioritize(taskId: string, newPriority: number): boolean {
      if (!Number.isFinite(newPriority)) {
        return false;
      }
      const node = pendingById.get(taskId);
      if (!node) {
        return false;
      }
      for (let w = 0; w < slots; w += 1) {
        const pq = pendingQueues[w];
        if (!pq) {
          continue;
        }
        const idx = pq.indexOf(node);
        if (idx >= 0) {
          pq.splice(idx, 1);
          node.priority = newPriority;
          insertByPriority(pq, node);
          return true;
        }
      }
      return false;
    },

    get stats() {
      const activeWorkers = runningCount;
      const idleWorkers = Math.max(0, slots - activeWorkers);
      const averageTaskTimeMs = completedTasks > 0 ? totalDurationMs / completedTasks : 0;
      return {
        activeWorkers,
        idleWorkers,
        queuedTasks: totalPendingCount(),
        runningTasks: runningCount,
        completedTasks,
        failedTasks,
        averageTaskTimeMs,
        affinityHitCount,
        affinityMissCount,
      };
    },

    terminate(): void {
      if (terminated) {
        return;
      }
      terminated = true;
      initialized = false;

      // 清空各槽位等待队列（已 shift 出队，不可再走 `rejectPending` 的按队列查找逻辑）
      for (let w = 0; w < pendingQueues.length; w += 1) {
        const pq = pendingQueues[w];
        if (!pq) {
          continue;
        }
        while (pq.length > 0) {
          const node = pq.shift();
          if (node) {
            clearTimeoutIfAny(node);
            pendingById.delete(node.id);
            failedTasks += 1;
            node.reject(new DOMException('WorkerPool terminated.', 'AbortError'));
          }
        }
      }
      pendingById.clear();
      _workerAffinityMap.clear();
      affinityStreakByType.clear();

      // 取消运行中任务
      const running = Array.from(runningById.values());
      for (let i = 0; i < running.length; i += 1) {
        running[i].internalAbort.abort();
      }
      runningById.clear();
      runningCount = 0;
    },
  };

  return pool;
}
