// ============================================================
// frame-scheduler.ts — L3 FrameScheduler：rAF 帧循环、预算与可见性
// 零依赖；在 SSR/Worker 环境通过能力探测降级。
// ============================================================

/** 默认目标帧率（用于推导帧预算）。 */
const DEFAULT_TARGET_FRAME_RATE = 60;
/** 默认后台节流间隔（Page Hidden 时降低调度频率）。 */
const DEFAULT_BACKGROUND_THROTTLE_MS = 250;
/** FPS 滚动窗口大小（帧数）。 */
const FPS_ROLLING_WINDOW = 60;
/** 最小合法目标帧率（避免除零）。 */
const MIN_TARGET_FPS = 1;
/** 最大合法目标帧率（避免异常配置）。 */
const MAX_TARGET_FPS = 1000;

/**
 * 帧阶段标签。
 * - `update`：输入/相机/调度等逻辑更新
 * - `render`：录制渲染命令/提交 GPU
 * - `postFrame`：统计、回收、调试输出
 * - `idle`：低优先级工作（仅在剩余预算内执行）
 */
export type FramePhase = 'idle' | 'update' | 'render' | 'postFrame';

/**
 * 帧回调描述。
 */
export interface FrameCallback {
  /** 回调唯一 id（用于 unregister） */
  readonly id: string;
  /** 所属阶段（用于分组与排序） */
  readonly phase: FramePhase;
  /**
   * 优先级（同阶段内升序执行：数值越小越早）。
   * 用于稳定排序，避免注册顺序引入不确定性。
   */
  readonly priority: number;
  /**
   * 执行回调。
   *
   * @param deltaTime - 距离上一帧的时间（毫秒）
   * @param frameIndex - 单调递增帧序号（从 0 开始）
   */
  execute(deltaTime: number, frameIndex: number): void;
}

/**
 * FrameScheduler 实例接口。
 */
export interface FrameScheduler {
  /** 启动循环（重复调用应为幂等） */
  start(): void;
  /** 停止循环并取消挂起的调度 */
  stop(): void;
  /** 是否正在运行 */
  readonly isRunning: boolean;
  /**
   * 注册回调。
   *
   * @param callback - 回调描述
   * @returns 取消注册函数
   */
  register(callback: FrameCallback): () => void;
  /**
   * 按 id 取消注册。
   *
   * @param id - 回调 id
   */
  unregister(id: string): void;
  /** 目标帧时间（毫秒）= 1000 / targetFrameRate */
  readonly targetFrameTimeMs: number;
  /** 当前帧剩余预算（毫秒），随时间递减；为 0 表示耗尽 */
  readonly frameBudgetMs: number;
  /** 是否仍有剩余预算 */
  hasBudget(): boolean;
  /** 请求渲染一帧（在 requestRenderMode 下用于触发 render/post） */
  requestRender(): void;
  /** 是否需要渲染（requestRenderMode 语义） */
  readonly needsRender: boolean;
  /** Page Visibility：页面是否可见 */
  readonly isPageVisible: boolean;
  /** 单调递增帧序号 */
  readonly frameIndex: number;
  /** 当前帧与上一帧时间差（毫秒） */
  readonly deltaTime: number;
  /** 累计时间（毫秒） */
  readonly elapsedTime: number;
  /** 基于最近 60 帧平均帧时估算的 FPS */
  readonly currentFPS: number;
  /** 手动推进一帧（用于测试/无 rAF 环境） */
  stepOneFrame(): void;
}

/**
 * 将数值限制为有限数。
 *
 * @param v - 输入
 * @param fallback - 回退值
 * @returns 有限数
 *
 * @example
 * const x = finiteNumber(NaN, 0);
 */
function finiteNumber(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 选择 requestAnimationFrame 的降级实现（测试/非浏览器环境）。
 *
 * @returns rAF 函数
 *
 * @example
 * const raf = resolveRaf();
 */
function resolveRaf(): (cb: FrameRequestCallback) => number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame.bind(globalThis);
  }
  // 无 rAF：用定时器模拟（不精确，但保证可运行）
  return (cb: FrameRequestCallback) => {
    const id = setTimeout(() => {
      cb(performance.now());
    }, 16) as unknown as number;
    return id;
  };
}

/**
 * 选择 cancelAnimationFrame 的降级实现。
 *
 * @returns cancel 函数
 *
 * @example
 * const cancel = resolveCancelRaf();
 */
function resolveCancelRaf(): (handle: number) => void {
  if (typeof cancelAnimationFrame === 'function') {
    return cancelAnimationFrame.bind(globalThis);
  }
  return (handle: number) => {
    clearTimeout(handle);
  };
}

/**
 * 读取页面可见性（无 DOM 时视为可见，避免阻塞测试）。
 *
 * @returns 是否可见
 *
 * @example
 * const ok = readPageVisible();
 */
function readPageVisible(): boolean {
  if (typeof document === 'undefined' || !document) {
    return true;
  }
  // hidden===true 表示页面在后台或最小化
  return document.visibilityState === 'visible' && document.hidden === false;
}

/**
 * 创建 FrameScheduler。
 *
 * @param options - 可选配置
 * @returns FrameScheduler 实例
 *
 * @example
 * const fs = createFrameScheduler({ targetFrameRate: 60, requestRenderMode: true });
 * fs.register({ id:'u1', phase:'update', priority:0, execute(){ } });
 * fs.start();
 */
export function createFrameScheduler(options?: {
  readonly targetFrameRate?: number;
  readonly requestRenderMode?: boolean;
  readonly backgroundThrottleMs?: number;
}): FrameScheduler {
  const raf = resolveRaf();
  const cancelRaf = resolveCancelRaf();

  const targetFrameRate = Math.max(
    MIN_TARGET_FPS,
    Math.min(MAX_TARGET_FPS, Math.floor(finiteNumber(options?.targetFrameRate ?? DEFAULT_TARGET_FRAME_RATE, DEFAULT_TARGET_FRAME_RATE))),
  );
  const targetFrameTimeMs = 1000 / targetFrameRate;

  const requestRenderMode = Boolean(options?.requestRenderMode);
  const backgroundThrottleMs = Math.max(
    0,
    Math.floor(finiteNumber(options?.backgroundThrottleMs ?? DEFAULT_BACKGROUND_THROTTLE_MS, DEFAULT_BACKGROUND_THROTTLE_MS)),
  );

  const callbacks = new Map<string, FrameCallback>();

  let running = false;
  let rafHandle = 0;
  let timeoutHandle = 0;

  let frameIndex = 0;
  let lastFrameTimestamp = performance.now();
  let deltaTimeMs = 0;
  let elapsedTimeMs = 0;

  let frameStartTimestamp = performance.now();
  let needsRenderFlag = !requestRenderMode;

  let isPageVisible = readPageVisible();

  const frameDurationsMs: number[] = [];

  /** 避免极小 avg 导致 Infinity（与 rolling FPS 共用） */
  const EPS = 1e-6;

  /**
   * 计算当前帧剩余时间预算（毫秒）。
   * 语义：`targetFrameTimeMs - (now - frameStartTimestamp)`，并夹紧到非负。
   *
   * @returns 剩余毫秒
   *
   * @example
   * const ms = getRemainingBudgetMs();
   */
  const getRemainingBudgetMs = (): number => {
    const now = performance.now();
    const elapsedInFrame = Math.max(0, now - frameStartTimestamp);
    return Math.max(0, targetFrameTimeMs - elapsedInFrame);
  };

  /**
   * 是否仍有帧预算（用于非 update 阶段的提前中断）。
   *
   * @returns 是否剩余
   *
   * @example
   * const ok = hasBudgetInternal();
   */
  const hasBudgetInternal = (): boolean => {
    return getRemainingBudgetMs() > EPS;
  };

  const sortByPriority = (a: FrameCallback, b: FrameCallback): number => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // 次键：id，保证稳定排序
    return a.id.localeCompare(b.id);
  };

  const collectPhase = (phase: FramePhase): FrameCallback[] => {
    const out: FrameCallback[] = [];
    for (const cb of callbacks.values()) {
      if (cb.phase === phase) {
        out.push(cb);
      }
    }
    out.sort(sortByPriority);
    return out;
  };

  const computeFps = (): number => {
    if (frameDurationsMs.length === 0) {
      return 0;
    }
    let sum = 0;
    for (const d of frameDurationsMs) {
      sum += d;
    }
    const avg = sum / frameDurationsMs.length;
    if (avg <= EPS) {
      return 0;
    }
    return 1000 / avg;
  };

  const updateRollingFrameDuration = (dt: number): void => {
    const v = Math.max(0, finiteNumber(dt, 0));
    frameDurationsMs.push(v);
    if (frameDurationsMs.length > FPS_ROLLING_WINDOW) {
      frameDurationsMs.shift();
    }
  };

  const safeExecute = (cb: FrameCallback, dt: number, fi: number): void => {
    try {
      cb.execute(dt, fi);
    } catch {
      // 回调异常必须隔离：避免一帧内某个扩展拖死整个引擎循环
    }
  };

  const runPhase = (phase: FramePhase, dt: number, fi: number): void => {
    const list = collectPhase(phase);
    for (const cb of list) {
      // 若预算耗尽：仍允许 update 跑完（避免输入饿死），其它阶段提前结束
      if (phase !== 'update' && !hasBudgetInternal()) {
        break;
      }
      safeExecute(cb, dt, fi);
    }
  };

  const runOneFrameInternal = (): void => {
    const now = performance.now();
    deltaTimeMs = Math.max(0, now - lastFrameTimestamp);
    lastFrameTimestamp = now;
    elapsedTimeMs += deltaTimeMs;
    updateRollingFrameDuration(deltaTimeMs);

    frameStartTimestamp = now;

    // Phase order：update → render → postFrame → idle（idle 仅在有预算时）
    runPhase('update', deltaTimeMs, frameIndex);

    if (!requestRenderMode || needsRenderFlag) {
      runPhase('render', deltaTimeMs, frameIndex);
      runPhase('postFrame', deltaTimeMs, frameIndex);
      if (requestRenderMode) {
        // 单帧渲染请求消费：若用户在 render 内再次 requestRender，会在下一帧生效
        needsRenderFlag = false;
      }
    }

    if (hasBudgetInternal()) {
      runPhase('idle', deltaTimeMs, frameIndex);
    }

    frameIndex += 1;
  };

  const scheduleNext = (): void => {
    if (!running) {
      return;
    }
    // 后台：降低频率；前台：rAF 对齐显示器刷新
    if (!isPageVisible && backgroundThrottleMs > 0) {
      timeoutHandle = setTimeout(() => {
        tick();
      }, backgroundThrottleMs) as unknown as number;
      return;
    }
    rafHandle = raf(tick);
  };

  const cancelScheduled = (): void => {
    if (rafHandle !== 0) {
      cancelRaf(rafHandle);
      rafHandle = 0;
    }
    if (timeoutHandle !== 0) {
      clearTimeout(timeoutHandle);
      timeoutHandle = 0;
    }
  };

  const tick = (): void => {
    if (!running) {
      return;
    }
    runOneFrameInternal();
    scheduleNext();
  };

  const onVisibilityChange = (): void => {
    isPageVisible = readPageVisible();
    // 可见性变化时：请求一帧以快速恢复画面（避免后台节流导致“唤醒后一帧陈旧”）
    needsRenderFlag = true;
  };

  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });
  }

  const scheduler: FrameScheduler = {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      lastFrameTimestamp = performance.now();
      // 启动后立即进入稳定节拍：先排程，再在 tick 内推进逻辑
      scheduleNext();
    },

    stop(): void {
      running = false;
      cancelScheduled();
    },

    get isRunning(): boolean {
      return running;
    },

    register(callback: FrameCallback): () => void {
      if (typeof callback.id !== 'string' || callback.id.length === 0) {
        return () => {};
      }
      callbacks.set(callback.id, callback);
      return () => {
        callbacks.delete(callback.id);
      };
    },

    unregister(id: string): void {
      if (typeof id !== 'string' || id.length === 0) {
        return;
      }
      callbacks.delete(id);
    },

    get targetFrameTimeMs(): number {
      return targetFrameTimeMs;
    },

    get frameBudgetMs(): number {
      return getRemainingBudgetMs();
    },

    hasBudget(): boolean {
      return hasBudgetInternal();
    },

    requestRender(): void {
      needsRenderFlag = true;
    },

    get needsRender(): boolean {
      return needsRenderFlag;
    },

    get isPageVisible(): boolean {
      return isPageVisible;
    },

    get frameIndex(): number {
      return frameIndex;
    },

    get deltaTime(): number {
      return deltaTimeMs;
    },

    get elapsedTime(): number {
      return elapsedTimeMs;
    },

    get currentFPS(): number {
      return computeFps();
    },

    stepOneFrame(): void {
      // 单步：不依赖 running，便于单元测试；会推进 frameIndex 与计时统计
      runOneFrameInternal();
    },
  };

  return scheduler;
}
