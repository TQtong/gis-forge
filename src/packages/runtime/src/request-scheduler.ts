/**
 * L3 调度层 — 网络请求调度：优先级队列、主机并发限制、超时/取消与统计。
 * 依赖 `ErrorRecovery` 做错误上报与全局重试策略对齐。
 */

import type { ErrorCategory, ErrorEvent, ErrorRecovery } from './error-recovery.ts';

/**
 * 请求调度器运行时配置（并发、每主机上限、超时与本地重试次数）。
 */
export interface RequestConfig {
  /** 全局最大并发请求数。 */
  readonly maxConcurrent: number;
  /** 单主机最大并发数，防止单域占满连接。 */
  readonly maxPerHost: number;
  /** 单次请求超时（毫秒），超时后中止 `fetch`。 */
  readonly timeout: number;
  /** 本地最大重试次数（与 `ErrorRecovery` 策略共同约束）。 */
  readonly retryCount: number;
  /** 本地重试基数（毫秒）；与指数退避组合时作为文档中的基数参考。 */
  readonly retryDelay: number;
}

/** 请求优先级：数值越小越优先（内部映射为 0..4）。 */
export type RequestPriority = 'critical' | 'high' | 'normal' | 'low' | 'prefetch';

/**
 * 已调度请求描述：调用方提供 `AbortController` 以便外部取消与调度器超时合并。
 */
export interface ScheduledRequest<T = unknown> {
  /** 唯一请求 id，用于取消、重试统计与 `ErrorRecovery` 关联。 */
  readonly id: string;
  /** 完整请求 URL。 */
  readonly url: string;
  /** 优先级。 */
  readonly priority: RequestPriority;
  /** 期望的响应解析方式。 */
  readonly responseType: 'arrayBuffer' | 'json' | 'blob' | 'text';
  /** 外部可触发的中止控制器。 */
  readonly abortController: AbortController;
  /** 可选额外请求头。 */
  readonly headers?: Record<string, string>;
}

/**
 * 网络请求调度器：入队、限流、优先级出队与统计。
 */
export interface RequestScheduler {
  /**
   * 将请求入队并在有空闲槽位时执行；返回解析后的响应体。
   *
   * @typeParam T - 响应体类型（由 `responseType` 决定）
   * @param request - 调度请求描述
   * @returns 解析后的结果 Promise
   *
   * @example
   * const ctrl = new AbortController();
   * const data = await scheduler.schedule<ArrayBuffer>({
   *   id: 't1',
   *   url: 'https://example.com/tile',
   *   priority: 'high',
   *   responseType: 'arrayBuffer',
   *   abortController: ctrl,
   * });
   */
  schedule<T>(request: ScheduledRequest<T>): Promise<T>;

  /**
   * 调整已排队请求的优先级；正在执行的请求不受影响。
   *
   * @param id - 请求 id
   * @param newPriority - 新优先级
   * @returns 是否找到并更新排队项
   *
   * @example
   * scheduler.reprioritize('t1', 'critical');
   */
  reprioritize(id: string, newPriority: RequestPriority): boolean;

  /**
   * 取消指定 id：排队项直接移除；进行中的请求通过 `AbortController` 中止。
   *
   * @param id - 请求 id
   * @returns 是否命中排队或进行中请求
   *
   * @example
   * scheduler.cancel('t1');
   */
  cancel(id: string): boolean;

  /**
   * 按 URL 模式批量取消（字符串包含匹配或正则测试）。
   *
   * @param urlPattern - 子串或正则
   * @returns 取消的请求数量
   *
   * @example
   * scheduler.cancelByUrl(/tiles\\//);
   */
  cancelByUrl(urlPattern: string | RegExp): number;

  /**
   * 取消所有排队与进行中的请求。
   *
   * @returns 取消的请求数量
   *
   * @example
   * scheduler.cancelAll();
   */
  cancelAll(): number;

  /** 调度统计（只读）。 */
  readonly stats: {
    /** 当前执行中的请求数。 */
    readonly active: number;
    /** 队列中等待数。 */
    readonly queued: number;
    /** 成功完成数。 */
    readonly completed: number;
    /** 最终失败数（重试用尽或不可恢复）。 */
    readonly failed: number;
    /** 累计下载字节（尽力估算）。 */
    readonly totalBytes: number;
    /** 成功请求的平均耗时（毫秒）。 */
    readonly averageLatencyMs: number;
  };

  /**
   * 当队列与活动槽同时为空时触发（每次从非空变为空时最多一次）。
   *
   * @param callback - 空队列回调
   * @returns 取消订阅函数
   *
   * @example
   * const off = scheduler.onQueueEmpty(() => loadHUD.hide());
   */
  onQueueEmpty(callback: () => void): () => void;
}

/** 默认配置，与 GIS-Forge L3 文档一致。 */
const DEFAULT_REQUEST_CONFIG: RequestConfig = {
  maxConcurrent: 6,
  maxPerHost: 6,
  timeout: 30_000,
  retryCount: 3,
  retryDelay: 1000,
};

/** 优先级到序数：越小越优先。 */
const PRIORITY_RANK: Record<RequestPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  prefetch: 4,
};

/** 本地重试退避上限（毫秒），与 ErrorRecovery 文档「最大 30s」对齐。 */
const LOCAL_RETRY_MAX_DELAY_MS = 30_000;

/**
 * 合并请求配置并校验边界，避免并发为 0 导致死锁。
 *
 * @param partial - 部分配置
 * @returns 完整配置
 *
 * @example
 * mergeRequestConfig({ maxConcurrent: 2 });
 */
function mergeRequestConfig(partial: Partial<RequestConfig>): RequestConfig {
  const p = partial;
  const maxConcurrent =
    Number.isFinite(p.maxConcurrent) && (p.maxConcurrent as number) > 0 ? Math.floor(p.maxConcurrent as number) : DEFAULT_REQUEST_CONFIG.maxConcurrent;
  const maxPerHost =
    Number.isFinite(p.maxPerHost) && (p.maxPerHost as number) > 0 ? Math.floor(p.maxPerHost as number) : DEFAULT_REQUEST_CONFIG.maxPerHost;
  const timeout = Number.isFinite(p.timeout) && (p.timeout as number) > 0 ? (p.timeout as number) : DEFAULT_REQUEST_CONFIG.timeout;
  const retryCount =
    Number.isFinite(p.retryCount) && (p.retryCount as number) >= 0 ? Math.floor(p.retryCount as number) : DEFAULT_REQUEST_CONFIG.retryCount;
  const retryDelay =
    Number.isFinite(p.retryDelay) && (p.retryDelay as number) >= 0 ? (p.retryDelay as number) : DEFAULT_REQUEST_CONFIG.retryDelay;
  return { maxConcurrent, maxPerHost, timeout, retryCount, retryDelay };
}

/**
 * 解析 URL 的主机名，用于每主机限流；非法 URL 归入占位桶，避免抛异常中断调度。
 *
 * @param url - 请求地址
 * @returns 小写 host 或占位字符串
 *
 * @example
 * safeHost('https://tiles.example.com/z/x/y'); // → 'tiles.example.com'
 */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    const h = u.host;
    return h.length > 0 ? h : '__nohost__';
  } catch {
    return '__invalid_url__';
  }
}

/**
 * 判断是否为中止错误（用户取消或超时），此类错误不应按网络重试策略重试。
 *
 * @param err - 未知错误
 * @returns 是否中止
 *
 * @example
 * isAbortError(new DOMException('aborted', 'AbortError')); // → true
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return false;
}

/**
 * 将任意错误规范为 `Error`，便于统一传递。
 *
 * @param err - 未知错误
 * @returns Error 实例
 *
 * @example
 * toError('oops'); // → Error('oops')
 */
function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}

/**
 * 非阻塞等待，用于重试间隔与策略延迟。
 *
 * @param ms - 毫秒
 * @returns Promise
 *
 * @example
 * await sleepMs(100);
 */
function sleepMs(ms: number): Promise<void> {
  const t = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}

/**
 * 合并用户 `AbortSignal` 与超时中止，返回清理函数以移除监听。
 *
 * @param userController - 用户提供的控制器
 * @param timeoutMs - 超时毫秒
 * @returns 合并后的控制器与 dispose
 *
 * @example
 * const { controller, dispose } = createMergedAbort(new AbortController(), 5000);
 */
function createMergedAbort(
  userController: AbortController,
  timeoutMs: number,
): { controller: AbortController; dispose: () => void } {
  const merged = new AbortController();
  const onUserAbort = (): void => {
    merged.abort();
  };
  userController.signal.addEventListener('abort', onUserAbort);
  const tid = setTimeout(() => {
    merged.abort();
  }, timeoutMs);

  const dispose = (): void => {
    clearTimeout(tid);
    userController.signal.removeEventListener('abort', onUserAbort);
  };

  merged.signal.addEventListener(
    'abort',
    () => {
      dispose();
    },
    { once: true },
  );

  return { controller: merged, dispose };
}

/**
 * 从响应头或解析后的体估算字节数。
 *
 * @param response - fetch 响应
 * @param body - 已解析体
 * @param responseType - 解析类型
 * @returns 字节数（非负整数）
 *
 * @example
 * estimateBytes(new Response('hi'), 'hi', 'text');
 */
function estimateBytes(
  response: Response,
  body: unknown,
  responseType: ScheduledRequest['responseType'],
): number {
  const cl = response.headers.get('Content-Length');
  if (cl !== null) {
    const n = Number.parseInt(cl, 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  if (typeof body === 'string') {
    // TextEncoder 给出 UTF-8 字节长度，比 string.length 更接近网络字节
    return new TextEncoder().encode(body).length;
  }
  if (body !== null && typeof body === 'object') {
    try {
      const s = JSON.stringify(body);
      return new TextEncoder().encode(s).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * 按 `responseType` 解析 `fetch` 响应体。
 *
 * @param response - HTTP 响应
 * @param responseType - 目标类型
 * @returns 解析后的体
 *
 * @example
 * await parseBody(new Response('{}'), 'json');
 */
async function parseBody(response: Response, responseType: ScheduledRequest['responseType']): Promise<unknown> {
  try {
    if (responseType === 'arrayBuffer') {
      return await response.arrayBuffer();
    }
    if (responseType === 'json') {
      return await response.json();
    }
    if (responseType === 'blob') {
      return await response.blob();
    }
    return await response.text();
  } catch (err) {
    // 解析失败向上抛，由上层统计为失败并触发重试策略
    throw toError(err);
  }
}

/**
 * 计算本地指数退避（与 L3 文档）：`retryDelay * 2^attempt`，封顶 30s。
 *
 * @param baseMs - 基数毫秒
 * @param attemptZeroBased - 第几次重试（0 起）
 * @returns 延迟毫秒
 *
 * @example
 * localBackoffMs(1000, 2); // 4000（封顶前）
 */
function localBackoffMs(baseMs: number, attemptZeroBased: number): number {
  const exp = Math.max(0, attemptZeroBased);
  const raw = baseMs * Math.pow(2, exp);
  const capped = Math.min(LOCAL_RETRY_MAX_DELAY_MS, raw);
  if (!Number.isFinite(capped) || capped < 0) {
    return 0;
  }
  return Math.floor(capped);
}

/**
 * 构造网络类 `ErrorEvent`，供 `ErrorRecovery` 使用。
 *
 * @param message - 描述
 * @param resourceId - 资源 id
 * @param retryable - 是否可重试
 * @param source - 来源标签
 * @returns ErrorEvent
 *
 * @example
 * buildNetworkErrorEvent('timeout', 'r1', true, 'RequestScheduler');
 */
function buildNetworkErrorEvent(message: string, resourceId: string, retryable: boolean, source: string): ErrorEvent {
  return {
    category: 'network' as ErrorCategory,
    message,
    source,
    resourceId,
    retryable,
    timestamp: Date.now(),
  };
}

/**
 * 队列项：挂起 Promise、单调序号保证同优先级 FIFO。
 */
interface QueueItem<T> {
  /** 调度请求。 */
  readonly request: ScheduledRequest<T>;
  /** 成功回调。 */
  readonly resolve: (v: T) => void;
  /** 失败回调。 */
  readonly reject: (e: Error) => void;
  /** 入队序号，越小越早。 */
  readonly seq: number;
}

/**
 * 创建请求调度器实例。
 *
 * @param config - 部分请求配置
 * @param errorRecovery - 全局错误恢复（上报/重试策略）
 * @returns `RequestScheduler` 实现
 *
 * @example
 * const scheduler = createRequestScheduler({ maxConcurrent: 4 }, errorRecovery);
 * await scheduler.schedule({ id: 'a', url, priority: 'normal', responseType: 'json', abortController: new AbortController() });
 */
export function createRequestScheduler(config: Partial<RequestConfig>, errorRecovery: ErrorRecovery): RequestScheduler {
  const cfg = mergeRequestConfig(config);

  /** 等待队列。 */
  const queue: QueueItem<unknown>[] = [];
  /** 全局活跃请求数。 */
  let activeCount = 0;
  /** 每主机活跃数。 */
  const hostActive = new Map<string, number>();
  /** 已完成成功次数。 */
  let completed = 0;
  /** 最终失败次数。 */
  let failed = 0;
  /** 累计字节。 */
  let totalBytes = 0;
  /** 成功请求耗时总和（毫秒）。 */
  let latencySumMs = 0;
  /** 单调入队序号。 */
  let seqCounter = 0;
  /** 进行中请求句柄，便于取消与按 URL 匹配；键为 request id。 */
  const activeRequestById = new Map<string, ScheduledRequest<unknown>>();
  /** 空队列监听。 */
  const emptyListeners = new Set<() => void>();

  /**
   * 递增主机计数。
   *
   * @param host - 主机键
   * @returns void
   *
   * @example
   * incHost('a.example.com');
   */
  const incHost = (host: string): void => {
    hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
  };

  /**
   * 递减主机计数并清理 0 项，避免 Map 无限增长。
   *
   * @param host - 主机键
   * @returns void
   *
   * @example
   * decHost('a.example.com');
   */
  const decHost = (host: string): void => {
    const v = (hostActive.get(host) ?? 0) - 1;
    if (v <= 0) {
      hostActive.delete(host);
    } else {
      hostActive.set(host, v);
    }
  };

  /**
   * 若当前无排队且无活跃，触发空队列回调（用于 UI 收尾）。
   *
   * @returns void
   *
   * @example
   * maybeEmitQueueEmpty();
   */
  const maybeEmitQueueEmpty = (): void => {
    if (queue.length > 0 || activeCount > 0) {
      return;
    }
    for (const cb of emptyListeners) {
      try {
        cb();
      } catch {
        // 监听者异常不得影响调度器
      }
    }
  };

  /**
   * 比较两个队列项：先比优先级，再比 seq FIFO。
   *
   * @param a - 队列项 a
   * @param b - 队列项 b
   * @returns 负数表示 a 更优先
   *
   * @example
   * compareItems(itemHigh, itemLow);
   */
  const compareItems = (a: QueueItem<unknown>, b: QueueItem<unknown>): number => {
    const pa = PRIORITY_RANK[a.request.priority];
    const pb = PRIORITY_RANK[b.request.priority];
    if (pa !== pb) {
      return pa - pb;
    }
    return a.seq - b.seq;
  };

  /**
   * 查找下一个可启动请求的下标（满足全局与主机并发）。
   *
   * @returns 下标或 null
   *
   * @example
   * const i = findRunnableIndex();
   */
  const findRunnableIndex = (): number | null => {
    if (queue.length === 0) {
      return null;
    }
    const indices = queue.map((_, i) => i);
    indices.sort((i, j) => compareItems(queue[i]!, queue[j]!));
    for (const i of indices) {
      const item = queue[i]!;
      const host = safeHost(item.request.url);
      const h = hostActive.get(host) ?? 0;
      if (h < cfg.maxPerHost && activeCount < cfg.maxConcurrent) {
        return i;
      }
    }
    return null;
  };

  /**
   * 执行单次 HTTP 获取与解析（不含重试循环）。
   *
   * @typeParam T - 响应类型
   * @param request - 调度请求
   * @returns 解析体
   *
   * @example
   * await fetchOnce({ id: '1', url: 'https://example.com', priority: 'normal', responseType: 'text', abortController: new AbortController() });
   */
  const fetchOnce = async <T>(request: ScheduledRequest<T>): Promise<T> => {
    const { controller, dispose } = createMergedAbort(request.abortController, cfg.timeout);
    const start = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    try {
      const init: RequestInit = {
        signal: controller.signal,
      };
      if (request.headers !== undefined) {
        init.headers = request.headers;
      }
      let response: Response;
      try {
        response = await fetch(request.url, init);
      } catch (err) {
        throw toError(err);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${request.url}`);
      }

      // 在流式读取 body 完成后再释放超时句柄，避免下载大瓦片时过早清除 timer 导致资源泄漏语义混乱
      const body = await parseBody(response, request.responseType);
      const bytes = estimateBytes(response, body, request.responseType);
      totalBytes += bytes;

      const end = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      const latency = Math.max(0, end - start);
      latencySumMs += latency;
      completed += 1;

      return body as T;
    } catch (err) {
      throw toError(err);
    } finally {
      dispose();
    }
  };

  /**
   * 带重试的执行：失败上报 `ErrorRecovery`，尊重 `shouldRetry` 与本地 `retryCount`。
   *
   * @typeParam T - 响应类型
   * @param item - 队列项
   * @returns void
   *
   * @example
   * void runItem(queueItem);
   */
  const runItem = async <T>(item: QueueItem<T>): Promise<void> => {
    const { request, resolve, reject } = item;
    const host = safeHost(request.url);
    activeRequestById.set(request.id, request as ScheduledRequest<unknown>);
    activeCount += 1;
    incHost(host);

    let attempt = 0;

    try {
      while (true) {
        try {
          const result = await fetchOnce<T>(request);
          errorRecovery.markSuccess(request.id);
          resolve(result);
          break;
        } catch (err) {
          const errObj = toError(err);
          const aborted = isAbortError(errObj);
          // 中止路径不上报，避免取消/超时污染 totalErrors 与 per-resource fail 计数
          if (!aborted) {
            errorRecovery.report(
              buildNetworkErrorEvent(errObj.message, request.id, true, 'RequestScheduler'),
            );
          }

          if (aborted) {
            // 用户取消或调度器超时：不计入「业务失败」统计，仅结束 Promise
            reject(errObj);
            break;
          }

          if (attempt >= cfg.retryCount) {
            failed += 1;
            reject(errObj);
            break;
          }

          const decision = errorRecovery.shouldRetry(request.id);
          if (!decision.retry) {
            failed += 1;
            reject(errObj);
            break;
          }

          const policyDelay = decision.delayMs;
          const localDelay = localBackoffMs(cfg.retryDelay, attempt);
          const waitMs = Math.max(policyDelay, localDelay);
          await sleepMs(waitMs);
          attempt += 1;
        }
      }
    } finally {
      activeRequestById.delete(request.id);
      activeCount -= 1;
      decHost(host);
      pump();
      maybeEmitQueueEmpty();
    }
  };

  /**
   * 从队列中尽可能启动新请求，直到并发或主机限制阻塞。
   *
   * @returns void
   *
   * @example
   * pump();
   */
  const pump = (): void => {
    while (activeCount < cfg.maxConcurrent && queue.length > 0) {
      const idx = findRunnableIndex();
      if (idx === null) {
        break;
      }
      const [item] = queue.splice(idx, 1);
      if (item === undefined) {
        break;
      }
      void runItem(item as QueueItem<unknown>);
    }
  };

  const scheduler: RequestScheduler = {
    schedule<T>(request: ScheduledRequest<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (typeof request.id !== 'string' || request.id.length === 0) {
          reject(new Error('RequestScheduler.schedule: request.id must be a non-empty string'));
          return;
        }
        if (typeof request.url !== 'string' || request.url.length === 0) {
          reject(new Error('RequestScheduler.schedule: request.url must be non-empty'));
          return;
        }
        seqCounter += 1;
        const item: QueueItem<T> = {
          request,
          resolve,
          reject,
          seq: seqCounter,
        };
        queue.push(item as QueueItem<unknown>);
        pump();
      });
    },

    reprioritize(id: string, newPriority: RequestPriority): boolean {
      const idx = queue.findIndex((q) => q.request.id === id);
      if (idx < 0) {
        return false;
      }
      const old = queue[idx];
      if (old === undefined) {
        return false;
      }
      const req = old.request;
      const next: ScheduledRequest<unknown> = {
        id: req.id,
        url: req.url,
        priority: newPriority,
        responseType: req.responseType,
        abortController: req.abortController,
        headers: req.headers,
      };
      const replaced: QueueItem<unknown> = {
        request: next,
        resolve: old.resolve,
        reject: old.reject,
        seq: old.seq,
      };
      queue[idx] = replaced;
      return true;
    },

    cancel(id: string): boolean {
      const qi = queue.findIndex((q) => q.request.id === id);
      if (qi >= 0) {
        const item = queue.splice(qi, 1)[0];
        if (item !== undefined) {
          try {
            item.request.abortController.abort();
          } catch {
            // abort 极少失败；忽略以避免调度器崩溃
          }
          item.reject(new DOMException('Request cancelled', 'AbortError'));
        }
        maybeEmitQueueEmpty();
        return true;
      }
      const activeReq = activeRequestById.get(id);
      if (activeReq !== undefined) {
        try {
          activeReq.abortController.abort();
        } catch {
          // 进行中 abort 失败时仍返回 true，因 fetch 侧通常会随后抛出 AbortError
        }
        return true;
      }
      return false;
    },

    cancelByUrl(urlPattern: string | RegExp): number {
      let count = 0;
      const match = (url: string): boolean => {
        if (typeof urlPattern === 'string') {
          return url.includes(urlPattern);
        }
        return urlPattern.test(url);
      };
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const item = queue[i];
        if (item !== undefined && match(item.request.url)) {
          queue.splice(i, 1);
          try {
            item.request.abortController.abort();
          } catch {
            // 同上：吞掉 abort 异常
          }
          item.reject(new DOMException('Request cancelled by URL pattern', 'AbortError'));
          count += 1;
        }
      }
      for (const [, req] of activeRequestById) {
        if (match(req.url)) {
          try {
            req.abortController.abort();
          } catch {
            // 同上
          }
          count += 1;
        }
      }
      maybeEmitQueueEmpty();
      return count;
    },

    cancelAll(): number {
      let count = 0;
      while (queue.length > 0) {
        const item = queue.pop();
        if (item !== undefined) {
          try {
            item.request.abortController.abort();
          } catch {
            // 同上
          }
          item.reject(new DOMException('Request cancelled (cancelAll)', 'AbortError'));
          count += 1;
        }
      }
      for (const [, req] of activeRequestById) {
        try {
          req.abortController.abort();
        } catch {
          // 同上
        }
        count += 1;
      }
      maybeEmitQueueEmpty();
      return count;
    },

    get stats() {
      return {
        get active(): number {
          return activeCount;
        },
        get queued(): number {
          return queue.length;
        },
        get completed(): number {
          return completed;
        },
        get failed(): number {
          return failed;
        },
        get totalBytes(): number {
          return totalBytes;
        },
        get averageLatencyMs(): number {
          return completed > 0 ? latencySumMs / completed : 0;
        },
      };
    },

    onQueueEmpty(callback: () => void): () => void {
      emptyListeners.add(callback);
      return () => {
        emptyListeners.delete(callback);
      };
    },
  };

  return scheduler;
}
