/**
 * L3 调度层 — 全局错误恢复：重试策略、Worker 崩溃与 GPU 设备丢失的协调入口。
 * 实际重建逻辑由外部 ResourceManager / DeviceManager 完成；本模块负责状态、统计与事件分发。
 */

/** 错误大类，用于上层按类型做策略分流（网络退避、GPU 重建等）。 */
export type ErrorCategory = 'network' | 'decode' | 'gpu' | 'worker' | 'unknown';

/**
 * 统一错误事件结构，便于日志聚合与重试决策。
 */
export interface ErrorEvent {
  /** 错误类别，决定恢复路径。 */
  readonly category: ErrorCategory;
  /** 可读描述（面向日志与调试）。 */
  readonly message: string;
  /** 可选：报告模块名（如 `TileScheduler`）。 */
  readonly source?: string;
  /** 可选：资源标识（瓦片 id、请求 id 等），用于 per-resource 重试计数。 */
  readonly resourceId?: string;
  /** 是否适合自动重试（用户取消、校验失败等应标为 false）。 */
  readonly retryable: boolean;
  /** 事件发生时间戳（毫秒，`Date.now()`）。 */
  readonly timestamp: number;
}

/**
 * 指数退避重试策略；与瓦片加载文档一致：基数 × 乘方^尝试，上限封顶，可选抖动防惊群。
 */
export interface RetryPolicy {
  /** 同一资源允许的最大重试次数（不含首次尝试）。 */
  readonly maxRetries: number;
  /** 退避基数（毫秒），与 `backoffMultiplier` 组合成指数曲线。 */
  readonly baseDelay: number;
  /** 单次等待上限（毫秒），避免无限增长。 */
  readonly maxDelay: number;
  /** 指数乘子，通常为 2。 */
  readonly backoffMultiplier: number;
  /** 为 true 时在延迟上叠加随机抖动。 */
  readonly jitter: boolean;
}

/**
 * 全局错误恢复门面：上报、重试判定、永久失败、Worker/GPU 恢复钩子与订阅。
 */
export interface ErrorRecovery {
  /**
   * 上报错误：更新统计、通知监听者，并对可重试错误累加 per-resource 失败计数。
   *
   * @param error - 结构化错误事件
   * @returns void
   *
   * @example
   * recovery.report({
   *   category: 'network',
   *   message: 'fetch failed',
   *   resourceId: 'tile-1-2-3',
   *   retryable: true,
   *   timestamp: Date.now(),
   * });
   */
  report(error: ErrorEvent): void;

  /**
   * 根据当前策略与资源失败次数，判断是否继续重试以及等待多久。
   *
   * @param resourceId - 资源 id（与 `report` / `markSuccess` 使用同一键）
   * @returns 是否重试与延迟毫秒数（不重试时 delayMs 为 0）
   *
   * @example
   * const { retry, delayMs } = recovery.shouldRetry('tile-0-0-0');
   * if (retry) await sleep(delayMs);
   */
  shouldRetry(resourceId: string): { retry: boolean; delayMs: number };

  /**
   * 标记资源已成功，清零该资源的失败计数并通知恢复监听者。
   *
   * @param resourceId - 资源 id
   * @returns void
   *
   * @example
   * recovery.markSuccess('tile-0-0-0');
   */
  markSuccess(resourceId: string): void;

  /**
   * 标记永久失败：后续 `shouldRetry` 对该 id 恒为 false，直到外部再次清理（若需要可扩展）。
   *
   * @param resourceId - 资源 id
   * @returns void
   *
   * @example
   * recovery.markPermanentFailure('tile-bad-key');
   */
  markPermanentFailure(resourceId: string): void;

  /**
   * Worker 崩溃时调用：记录日志、递增统计；真实重启由 WorkerPool 完成。
   *
   * @param workerIndex - Worker 槽位索引（0-based）
   * @returns 在微任务中完成的 Promise，便于与异步重建链衔接
   *
   * @example
   * await recovery.handleWorkerCrash(0);
   */
  handleWorkerCrash(workerIndex: number): Promise<void>;

  /**
   * GPU 设备丢失时调用：记录日志、递增统计；重新 adapter/device 由 L1 完成。
   *
   * @param reason - 丢失原因字符串（来自 `GPUDevice.lost` 等）
   * @returns 在微任务中完成的 Promise
   *
   * @example
   * await recovery.handleDeviceLost('destroyed');
   */
  handleDeviceLost(reason: string): Promise<void>;

  /** 当前生效的重试策略（只读快照）。 */
  readonly retryPolicy: RetryPolicy;

  /**
   * 合并更新重试策略；未提供的字段保留原值。
   *
   * @param policy - 部分策略
   * @returns void
   *
   * @example
   * recovery.updateRetryPolicy({ maxRetries: 5 });
   */
  updateRetryPolicy(policy: Partial<RetryPolicy>): void;

  /** 聚合统计（只读）。 */
  readonly stats: {
    /** 累计上报错误次数。 */
    readonly totalErrors: number;
    /** 曾经在失败计数>0 后通过 `markSuccess` 恢复成功的次数。 */
    readonly retriedSuccess: number;
    /** 累计 `markPermanentFailure` 调用次数。 */
    readonly permanentFailures: number;
    /** Worker 崩溃处理次数。 */
    readonly workerRestarts: number;
    /** GPU 设备丢失处理次数。 */
    readonly deviceRecoveries: number;
  };

  /**
   * 订阅错误事件；返回取消订阅函数。
   *
   * @param callback - 错误回调
   * @returns 取消订阅函数
   *
   * @example
   * const off = recovery.onError((e) => console.warn(e.message));
   * off();
   */
  onError(callback: (error: ErrorEvent) => void): () => void;

  /**
   * 订阅恢复事件（`markSuccess` 或系统级恢复占位 id）；返回取消订阅函数。
   *
   * @param callback - 恢复回调，参数为 resourceId
   * @returns 取消订阅函数
   *
   * @example
   * recovery.onRecovery((id) => tiles.refresh(id));
   */
  onRecovery(callback: (resourceId: string) => void): () => void;
}

/** 默认重试策略，与 GeoForge L3 文档默认值对齐。 */
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  backoffMultiplier: 2,
  jitter: true,
};

/** 抖动幅度上限（毫秒），避免延迟过大时抖动占比失控。 */
const JITTER_CAP_MS = 500;

/** Worker 崩溃日志前缀，便于过滤。 */
const LOG_PREFIX_WORKER = '[ErrorRecovery] Worker crash';

/** GPU 丢失日志前缀。 */
const LOG_PREFIX_GPU = '[ErrorRecovery] GPU device lost';

/**
 * 将 resourceId 规范为 Map 键；空字符串使用占位，避免与“未设置”混淆时仍保持可预测。
 *
 * @param resourceId - 调用方传入的资源 id
 * @returns 用作内部 Map 的键
 *
 * @example
 * normalizeResourceKey('tile-0-0-0'); // → 'tile-0-0-0'
 * normalizeResourceKey(''); // → '__empty_resource__'
 */
function normalizeResourceKey(resourceId: string): string {
  // 空串在部分调用路径表示“未知资源”，统一映射到稳定占位键
  return resourceId.length > 0 ? resourceId : '__empty_resource__';
}

/**
 * 合并部分策略与默认值，并做边界校验，防止 NaN/负数导致死循环或负延迟。
 *
 * @param partial - 可选覆盖项
 * @param base - 基准完整策略
 * @returns 新的完整策略对象
 *
 * @example
 * mergeRetryPolicy({ maxRetries: 1 }, { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2, jitter: true });
 */
function mergeRetryPolicy(partial: Partial<RetryPolicy> | undefined, base: RetryPolicy): RetryPolicy {
  const p = partial ?? {};
  const maxRetries = Number.isFinite(p.maxRetries) && (p.maxRetries as number) >= 0 ? Math.floor(p.maxRetries as number) : base.maxRetries;
  const baseDelay = Number.isFinite(p.baseDelay) && (p.baseDelay as number) >= 0 ? (p.baseDelay as number) : base.baseDelay;
  const maxDelay = Number.isFinite(p.maxDelay) && (p.maxDelay as number) >= 0 ? (p.maxDelay as number) : base.maxDelay;
  const backoffMultiplier =
    Number.isFinite(p.backoffMultiplier) && (p.backoffMultiplier as number) > 0 ? (p.backoffMultiplier as number) : base.backoffMultiplier;
  const jitter = typeof p.jitter === 'boolean' ? p.jitter : base.jitter;
  // 确保 maxDelay 不小于 baseDelay，避免调度器读到反常区间
  const safeMaxDelay = Math.max(maxDelay, baseDelay);
  return {
    maxRetries,
    baseDelay,
    maxDelay: safeMaxDelay,
    backoffMultiplier,
    jitter,
  };
}

/**
 * 计算指数退避延迟：`baseDelay * multiplier^attempt`，加可选抖动，并封顶 `maxDelay`。
 *
 * @param policy - 当前策略
 * @param attemptZeroBased - 第几次重试等待（0 表示首次失败后的等待）
 * @returns 本次应等待的毫秒数（非负整数）
 *
 * @example
 * computeBackoffDelayMs({ maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2, jitter: false }, 2);
 */
function computeBackoffDelayMs(policy: RetryPolicy, attemptZeroBased: number): number {
  const exp = Math.max(0, attemptZeroBased);
  // 使用 Math.pow 明确表达指数退避，便于与文档公式对照
  const raw = policy.baseDelay * Math.pow(policy.backoffMultiplier, exp);
  let jitterMs = 0;
  if (policy.jitter) {
    // 抖动取 [0, min(JITTER_CAP, baseDelay*0.5)]，减轻同步重试雪崩
    const jitterSpan = Math.min(JITTER_CAP_MS, policy.baseDelay * 0.5);
    jitterMs = Math.random() * jitterSpan;
  }
  const total = raw + jitterMs;
  const capped = Math.min(total, policy.maxDelay);
  // 防御：确保为有限非负数，避免 setTimeout 异常
  if (!Number.isFinite(capped) || capped < 0) {
    return 0;
  }
  return Math.floor(capped);
}

/**
 * 创建全局 `ErrorRecovery` 实例。
 *
 * @param policy - 可选部分重试策略，与默认合并
 * @returns 完整实现的 `ErrorRecovery`
 *
 * @example
 * const recovery = createErrorRecovery({ maxRetries: 5, jitter: true });
 * recovery.report({ category: 'network', message: 'timeout', retryable: true, timestamp: Date.now() });
 */
export function createErrorRecovery(policy?: Partial<RetryPolicy>): ErrorRecovery {
  let retryPolicyState: RetryPolicy = mergeRetryPolicy(policy, DEFAULT_RETRY_POLICY);

  /** 每个资源的连续可重试失败次数（每次 `report` 可重试错误 +1）。 */
  const failCountByResource = new Map<string, number>();
  /** 永久失败集合，优先于计数判断。 */
  const permanentFailureKeys = new Set<string>();
  /** 错误订阅者集合。 */
  const errorListeners = new Set<(e: ErrorEvent) => void>();
  /** 恢复订阅者集合。 */
  const recoveryListeners = new Set<(id: string) => void>();

  let totalErrors = 0;
  let retriedSuccess = 0;
  let permanentFailureReports = 0;
  let workerRestarts = 0;
  let deviceRecoveries = 0;

  /**
   * 向所有监听者广播错误；内部调用需包裹 try-catch 防止单个监听者抛错拖垮上报链。
   *
   * @param event - 要分发的事件
   * @returns void
   *
   * @example
   * emitError({ category: 'network', message: 'x', retryable: true, timestamp: Date.now() });
   */
  const emitError = (event: ErrorEvent): void => {
    for (const cb of errorListeners) {
      try {
        cb(event);
      } catch {
        // 监听者错误必须隔离，避免影响其他订阅者与核心状态
      }
    }
  };

  /**
   * 向所有监听者广播恢复事件。
   *
   * @param resourceId - 资源或系统占位 id
   * @returns void
   *
   * @example
   * emitRecovery('tile-0-0-0');
   */
  const emitRecovery = (resourceId: string): void => {
    for (const cb of recoveryListeners) {
      try {
        cb(resourceId);
      } catch {
        // 同上：恢复回调失败不得影响主流程
      }
    }
  };

  const api: ErrorRecovery = {
    report(error: ErrorEvent): void {
      totalErrors += 1;
      emitError(error);

      if (!error.retryable) {
        // 不可重试错误不累加失败计数，避免误判后续 shouldRetry
        return;
      }

      const rid = error.resourceId;
      if (rid === undefined) {
        // 无 resourceId 时无法做 per-resource 退避，仅记录统计
        return;
      }

      const key = normalizeResourceKey(rid);
      if (permanentFailureKeys.has(key)) {
        // 已标记永久失败的资源不再累加计数
        return;
      }

      const prev = failCountByResource.get(key) ?? 0;
      const next = prev + 1;
      failCountByResource.set(key, next);
    },

    shouldRetry(resourceId: string): { retry: boolean; delayMs: number } {
      const key = normalizeResourceKey(resourceId);

      if (permanentFailureKeys.has(key)) {
        return { retry: false, delayMs: 0 };
      }

      const failCount = failCountByResource.get(key) ?? 0;
      // failCount===0 表示尚无失败记录，不应触发重试等待
      if (failCount <= 0) {
        return { retry: false, delayMs: 0 };
      }

      // 允许重试当且仅当当前失败次数不超过策略上限（与 L3 文档「最多 maxRetries 次重试」一致）
      if (failCount > retryPolicyState.maxRetries) {
        return { retry: false, delayMs: 0 };
      }

      const attemptZeroBased = failCount - 1;
      const delayMs = computeBackoffDelayMs(retryPolicyState, attemptZeroBased);
      return { retry: true, delayMs };
    },

    markSuccess(resourceId: string): void {
      const key = normalizeResourceKey(resourceId);
      const prevFails = failCountByResource.get(key) ?? 0;
      failCountByResource.delete(key);
      permanentFailureKeys.delete(key);

      if (prevFails > 0) {
        // 曾在失败状态下恢复成功，计入「重试后成功」统计
        retriedSuccess += 1;
      }

      emitRecovery(key);
    },

    markPermanentFailure(resourceId: string): void {
      const key = normalizeResourceKey(resourceId);
      permanentFailureKeys.add(key);
      failCountByResource.delete(key);
      permanentFailureReports += 1;
    },

    async handleWorkerCrash(workerIndex: number): Promise<void> {
      // 索引非法时仍记录一次，便于发现调用方 bug
      if (!Number.isFinite(workerIndex) || workerIndex < 0) {
        console.warn(`${LOG_PREFIX_WORKER}: invalid workerIndex`, workerIndex);
      } else {
        console.warn(`${LOG_PREFIX_WORKER}: index=${workerIndex} (restart delegated to WorkerPool)`);
      }
      workerRestarts += 1;
      // 使用微任务与文档初始化链一致，便于与外部 await 串联
      await Promise.resolve();
      emitRecovery(`system:worker:${Number.isFinite(workerIndex) ? Math.floor(workerIndex) : -1}`);
    },

    async handleDeviceLost(reason: string): Promise<void> {
      const safeReason = typeof reason === 'string' && reason.length > 0 ? reason : '(no reason)';
      console.warn(`${LOG_PREFIX_GPU}: ${safeReason} (rebuild delegated to L1/L2)`);
      deviceRecoveries += 1;
      await Promise.resolve();
      emitRecovery('system:gpu');
    },

    get retryPolicy(): RetryPolicy {
      // 返回展开快照，避免调用方就地改写字段破坏内部不变量
      return { ...retryPolicyState };
    },

    updateRetryPolicy(p: Partial<RetryPolicy>): void {
      retryPolicyState = mergeRetryPolicy(p, retryPolicyState);
    },

    get stats() {
      return {
        get totalErrors(): number {
          return totalErrors;
        },
        get retriedSuccess(): number {
          return retriedSuccess;
        },
        get permanentFailures(): number {
          return permanentFailureReports;
        },
        get workerRestarts(): number {
          return workerRestarts;
        },
        get deviceRecoveries(): number {
          return deviceRecoveries;
        },
      };
    },

    onError(callback: (error: ErrorEvent) => void): () => void {
      errorListeners.add(callback);
      return () => {
        errorListeners.delete(callback);
      };
    },

    onRecovery(callback: (resourceId: string) => void): () => void {
      recoveryListeners.add(callback);
      return () => {
        recoveryListeners.delete(callback);
      };
    },
  };

  return api;
}
