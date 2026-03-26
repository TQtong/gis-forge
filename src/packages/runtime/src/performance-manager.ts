// ============================================================
// performance-manager.ts — L3 PerformanceManager：自适应性能降级与恢复
// 零 npm 依赖；错误使用本模块内结构化错误（不依赖 L6 preset）。
// ============================================================

// ---------------------------------------------------------------------------
// 结构化错误（与 GIS-Forge 约定对齐：code + context，禁止裸 Error）
// ---------------------------------------------------------------------------

/**
 * PerformanceManager 子集错误码（字符串字面量联合，兼容 erasableSyntaxOnly）。
 */
export const PerformanceManagerErrorCode = {
  /** budget 字段非法（NaN/Infinity/负数或逻辑矛盾）。 */
  CONFIG_INVALID_BUDGET: 'CONFIG_INVALID_BUDGET',
  /** setQuality 收到未知或非预期的画质档位。 */
  CONFIG_INVALID_QUALITY: 'CONFIG_INVALID_QUALITY',
  /** evaluate 传入的统计字段类型或数值非法。 */
  CONFIG_INVALID_STATS: 'CONFIG_INVALID_STATS',
} as const;

/**
 * {@link PerformanceManagerErrorCode} 值的联合类型。
 */
export type PerformanceManagerErrorCode =
  (typeof PerformanceManagerErrorCode)[keyof typeof PerformanceManagerErrorCode];

/**
 * L3 PerformanceManager 抛出的结构化错误。
 */
export class PerformanceManagerError extends Error {
  /** 机器可读错误码。 */
  public readonly code: PerformanceManagerErrorCode;

  /** 诊断用上下文（预算快照、字段名等）。 */
  public readonly context?: Record<string, unknown>;

  /**
   * @param code - 错误码
   * @param message - 可读说明
   * @param context - 可选上下文
   * @param cause - 可选底层原因
   */
  constructor(
    code: PerformanceManagerErrorCode,
    message: string,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PerformanceManagerError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, PerformanceManagerError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 常量：阈值、默认预算、降级链参数
// ---------------------------------------------------------------------------

/** 默认目标帧率（fps），与常见显示器刷新率一致。 */
const DEFAULT_TARGET_FPS = 60;

/** 默认单帧最大时间（ms）= 1000 / 60，约 16.67ms。 */
const DEFAULT_MAX_FRAME_TIME_MS = 1000 / DEFAULT_TARGET_FPS;

/** 默认 GPU 时间上限（ms），与架构文档 PerformanceManager 预算一致。 */
const DEFAULT_MAX_GPU_TIME_MS = 12;

/** 默认主线程 JS 时间上限（ms）。 */
const DEFAULT_MAX_JS_TIME_MS = 4;

/** 默认单帧最大瓦片加载请求数（预算占位，evaluate 当前不含瓦片计数）。 */
const DEFAULT_MAX_TILE_LOADS_PER_FRAME = 6;

/** 默认单帧最大三角形数。 */
const DEFAULT_MAX_TRIANGLES_PER_FRAME = 2_000_000;

/** 默认单帧最大 DrawCall 数。 */
const DEFAULT_MAX_DRAW_CALLS_PER_FRAME = 200;

/** 连续超预算帧数达到该值后触发一次降级（N=30）。 */
const CONSECUTIVE_OVER_FRAMES_THRESHOLD = 30;

/** 连续在预算内帧数达到该值后尝试恢复一级（M=60）。 */
const CONSECUTIVE_UNDER_FRAMES_THRESHOLD = 60;

/** 后处理 Pass 的占位 id（引擎接入时可替换为真实 id）。 */
const DEFAULT_POST_PROCESS_PASS_ID = 'postprocess';

/** 首次降分辨率比例（1.0 → 0.75）。 */
const FIRST_RESOLUTION_SCALE = 0.75;

/** 首次抬升 SSE 的绝对阈值（屏幕空间误差，单位依赖 TileScheduler 约定）。 */
const FIRST_SSE_THRESHOLD = 48;

/** 首次降低标注密度的乘子。 */
const FIRST_LABEL_DENSITY_FACTOR = 0.5;

/** 合法分辨率缩放下界（避免 0 或负数）。 */
const MIN_RESOLUTION_SCALE = 0.25;

/** 合法 SSE 上界（防止无限膨胀）。 */
const MAX_SSE_THRESHOLD = 512;

/** 浮点比较 epsilon（避免边界抖动）。 */
const EPSILON_MS = 1e-4;

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/**
 * 性能预算：帧时间、GPU/JS 时间、几何与请求上限。
 */
export interface PerformanceBudget {
  /** 目标帧率（fps），用于推导参考帧时间（展示/日志，不强制）。 */
  readonly targetFPS: number;
  /** 单帧 wall-clock 上限（ms，含 GPU+JS+同步开销）。 */
  readonly maxFrameTimeMs: number;
  /** GPU 记录时间上限（ms）；若无 GPU 计时则仅作预算占位。 */
  readonly maxGPUTimeMs: number;
  /** 主线程 JS 时间上限（ms）；需 gpuDurationMs 才能从 frame 中拆分。 */
  readonly maxJSTimeMs: number;
  /** 单帧最大瓦片加载数量（调度器侧约束，evaluate 未统计时仅作文档字段）。 */
  readonly maxTileLoadsPerFrame: number;
  /** 单帧最大三角形提交数。 */
  readonly maxTrianglesPerFrame: number;
  /** 单帧最大 DrawCall 数。 */
  readonly maxDrawCallsPerFrame: number;
}

/**
 * 离散画质档位，从 ultra 到 potato 递减。
 */
export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low' | 'potato';

/**
 * 性能调度动作：降级、恢复或具体参数调整。
 */
export type PerformanceAction =
  | { type: 'reduce-resolution'; scale: number }
  | { type: 'reduce-tile-quality'; maxZoom: number }
  | { type: 'disable-postprocess'; passId: string }
  | { type: 'reduce-label-density'; factor: number }
  | { type: 'disable-shadows' }
  | { type: 'disable-atmosphere' }
  | { type: 'increase-sse-threshold'; value: number }
  | { type: 'reduce-msaa'; sampleCount: 1 }
  | { type: 'restore' };

/**
 * 已应用的一条降级记录（用于 DevTools / 诊断）。
 */
export interface PerformanceDowngrade {
  /** 与 {@link PerformanceAction} 对应的类型字符串（不含 restore）。 */
  readonly type: string;
  /** 应用时刻的时间戳（ms，performance.now 或 Date.now）。 */
  readonly appliedAt: number;
  /** 推断的瓶颈类别。 */
  readonly reason: 'gpu-bound' | 'cpu-bound' | 'memory-bound';
}

/**
 * 自适应性能管理器：基于帧统计驱动降级链与恢复。
 */
export interface PerformanceManager {
  /** 当前生效的预算快照（只读）。 */
  readonly budget: PerformanceBudget;
  /** 当前目标画质档位。 */
  readonly currentQuality: QualityLevel;
  /** 是否启用自适应 evaluate 逻辑。 */
  readonly isAdaptiveEnabled: boolean;
  /**
   * 启用或关闭自适应降级/恢复。
   *
   * @param enabled - true 开启
   */
  setAdaptiveEnabled(enabled: boolean): void;
  /**
   * 每帧调用一次，根据统计与预算返回本帧应执行的动作列表（可能为空）。
   *
   * @param stats - 帧耗时与几何负载
   */
  evaluate(stats: {
    frameDurationMs: number;
    gpuDurationMs?: number;
    drawCallCount: number;
    triangleCount: number;
  }): PerformanceAction[];
  /**
   * 手动设置画质档位（会重置内部连续计数，并清空已记录降级栈）。
   *
   * @param level - 目标档位
   */
  setQuality(level: QualityLevel): void;
  /** 当前仍生效的降级历史（从旧到新）。 */
  readonly activeDowngrades: PerformanceDowngrade[];
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 budget 字段；非法时抛出 {@link PerformanceManagerError}。
 *
 * @param partial - 调用方传入的部分预算
 * @returns 完整预算
 *
 * @example
 * const b = resolveBudget({ targetFPS: 30 });
 */
function resolveBudget(partial?: Partial<PerformanceBudget>): PerformanceBudget {
  // 以默认值起算，再逐项合并；合并失败时带上下文字段名抛出
  const base: PerformanceBudget = {
    targetFPS: DEFAULT_TARGET_FPS,
    maxFrameTimeMs: DEFAULT_MAX_FRAME_TIME_MS,
    maxGPUTimeMs: DEFAULT_MAX_GPU_TIME_MS,
    maxJSTimeMs: DEFAULT_MAX_JS_TIME_MS,
    maxTileLoadsPerFrame: DEFAULT_MAX_TILE_LOADS_PER_FRAME,
    maxTrianglesPerFrame: DEFAULT_MAX_TRIANGLES_PER_FRAME,
    maxDrawCallsPerFrame: DEFAULT_MAX_DRAW_CALLS_PER_FRAME,
  };

  if (partial === undefined || partial === null) {
    return base;
  }

  if (typeof partial !== 'object') {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_BUDGET,
      'budget 必须是对象或 undefined',
      { typeofPartial: typeof partial },
    );
  }

  const merged: PerformanceBudget = {
    targetFPS: partial.targetFPS ?? base.targetFPS,
    maxFrameTimeMs: partial.maxFrameTimeMs ?? base.maxFrameTimeMs,
    maxGPUTimeMs: partial.maxGPUTimeMs ?? base.maxGPUTimeMs,
    maxJSTimeMs: partial.maxJSTimeMs ?? base.maxJSTimeMs,
    maxTileLoadsPerFrame: partial.maxTileLoadsPerFrame ?? base.maxTileLoadsPerFrame,
    maxTrianglesPerFrame: partial.maxTrianglesPerFrame ?? base.maxTrianglesPerFrame,
    maxDrawCallsPerFrame: partial.maxDrawCallsPerFrame ?? base.maxDrawCallsPerFrame,
  };

  // 逐项校验：NaN / Infinity / 负数对“上限”类字段非法
  const checkPositiveFinite = (label: keyof PerformanceBudget, v: number, allowZero: boolean) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new PerformanceManagerError(
        PerformanceManagerErrorCode.CONFIG_INVALID_BUDGET,
        `budget.${String(label)} 必须为有限数字`,
        { label, value: v },
      );
    }
    if (v < 0 || (!allowZero && v === 0)) {
      throw new PerformanceManagerError(
        PerformanceManagerErrorCode.CONFIG_INVALID_BUDGET,
        `budget.${String(label)} 必须${allowZero ? '非负' : '为正'}有限数`,
        { label, value: v },
      );
    }
  };

  checkPositiveFinite('targetFPS', merged.targetFPS, false);
  checkPositiveFinite('maxFrameTimeMs', merged.maxFrameTimeMs, false);
  checkPositiveFinite('maxGPUTimeMs', merged.maxGPUTimeMs, false);
  checkPositiveFinite('maxJSTimeMs', merged.maxJSTimeMs, false);
  checkPositiveFinite('maxTileLoadsPerFrame', merged.maxTileLoadsPerFrame, false);
  checkPositiveFinite('maxTrianglesPerFrame', merged.maxTrianglesPerFrame, false);
  checkPositiveFinite('maxDrawCallsPerFrame', merged.maxDrawCallsPerFrame, false);

  // 逻辑一致性：JS+GPU 预算之和不应大于帧预算过多（仅警告性校验，宽松阈值防误报）
  if (merged.maxJSTimeMs + merged.maxGPUTimeMs > merged.maxFrameTimeMs * 3) {
    // 不抛错：某些管线把 maxFrameTimeMs 设得很紧；仅记录到 context 供调用方日志
    // 此处保持静默，避免误杀合法配置
  }

  return merged;
}

/**
 * 校验 evaluate 入参 stats。
 *
 * @param stats - 帧统计
 *
 * @example
 * validateStats({ frameDurationMs: 16, drawCallCount: 1, triangleCount: 3 });
 */
function validateStats(stats: {
  frameDurationMs: number;
  gpuDurationMs?: number;
  drawCallCount: number;
  triangleCount: number;
}): void {
  if (stats === null || stats === undefined || typeof stats !== 'object') {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
      'stats 必须为非空对象',
      { stats },
    );
  }

  const { frameDurationMs, gpuDurationMs, drawCallCount, triangleCount } = stats;

  if (typeof frameDurationMs !== 'number' || !Number.isFinite(frameDurationMs) || frameDurationMs < 0) {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
      'stats.frameDurationMs 必须为非负有限数',
      { frameDurationMs },
    );
  }

  if (gpuDurationMs !== undefined) {
    if (typeof gpuDurationMs !== 'number' || !Number.isFinite(gpuDurationMs) || gpuDurationMs < 0) {
      throw new PerformanceManagerError(
        PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
        'stats.gpuDurationMs 若提供则必须为非负有限数',
        { gpuDurationMs },
      );
    }
    if (gpuDurationMs > frameDurationMs + EPSILON_MS) {
      // GPU 计时不应显著大于 wall time；容忍浮点误差
      throw new PerformanceManagerError(
        PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
        'stats.gpuDurationMs 不能大于 frameDurationMs',
        { gpuDurationMs, frameDurationMs },
      );
    }
  }

  if (typeof drawCallCount !== 'number' || !Number.isFinite(drawCallCount) || drawCallCount < 0) {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
      'stats.drawCallCount 必须为非负有限数',
      { drawCallCount },
    );
  }

  if (typeof triangleCount !== 'number' || !Number.isFinite(triangleCount) || triangleCount < 0) {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_STATS,
      'stats.triangleCount 必须为非负有限数',
      { triangleCount },
    );
  }
}

/**
 * 判定本帧是否超出预算（任一条件满足即为超预算）。
 *
 * @param budget - 预算
 * @param stats - 帧统计
 * @returns 是否超预算
 */
function isOverBudget(
  budget: PerformanceBudget,
  stats: {
    frameDurationMs: number;
    gpuDurationMs?: number;
    drawCallCount: number;
    triangleCount: number;
  },
): boolean {
  // 帧总时长：超过 maxFrameTimeMs 视为超预算（CPU 侧或整体卡顿）
  if (stats.frameDurationMs > budget.maxFrameTimeMs + EPSILON_MS) {
    return true;
  }

  // GPU 时长：若提供且超过阈值
  if (stats.gpuDurationMs !== undefined && stats.gpuDurationMs > budget.maxGPUTimeMs + EPSILON_MS) {
    return true;
  }

  // JS 时长估计：frame - gpu（仅当 gpu 已提供）
  if (stats.gpuDurationMs !== undefined) {
    const jsEst = stats.frameDurationMs - stats.gpuDurationMs;
    if (jsEst > budget.maxJSTimeMs + EPSILON_MS) {
      return true;
    }
  }

  // 几何与调度负载
  if (stats.drawCallCount > budget.maxDrawCallsPerFrame) {
    return true;
  }
  if (stats.triangleCount > budget.maxTrianglesPerFrame) {
    return true;
  }

  return false;
}

/**
 * 根据统计推断降级记录上的 reason 字段。
 *
 * @param budget - 预算
 * @param stats - 帧统计
 * @returns 瓶颈类型
 */
function inferReason(
  budget: PerformanceBudget,
  stats: {
    frameDurationMs: number;
    gpuDurationMs?: number;
    drawCallCount: number;
    triangleCount: number;
  },
): 'gpu-bound' | 'cpu-bound' | 'memory-bound' {
  // GPU 明确超限优先标记 gpu-bound
  if (stats.gpuDurationMs !== undefined && stats.gpuDurationMs > budget.maxGPUTimeMs + EPSILON_MS) {
    return 'gpu-bound';
  }

  // 几何负载过高视为 GPU 侧瓶颈（填充率/带宽）
  if (stats.triangleCount > budget.maxTrianglesPerFrame || stats.drawCallCount > budget.maxDrawCallsPerFrame) {
    return 'gpu-bound';
  }

  // 拆分 JS：若 GPU 未给出，则无法区分，整体帧超时记为 cpu-bound（含同步 JS）
  if (stats.gpuDurationMs !== undefined) {
    const jsEst = stats.frameDurationMs - stats.gpuDurationMs;
    if (jsEst > budget.maxJSTimeMs + EPSILON_MS) {
      return 'cpu-bound';
    }
  }

  if (stats.frameDurationMs > budget.maxFrameTimeMs + EPSILON_MS) {
    return 'cpu-bound';
  }

  // 不应到达：evaluate 仅在超预算时调用
  return 'cpu-bound';
}

/**
 * 画质档位到内部质量权重的映射（用于文档与未来扩展）。
 *
 * @param level - 档位
 * @returns 0~1 权重
 */
function qualityRank(level: QualityLevel): number {
  switch (level) {
    case 'ultra':
      return 1;
    case 'high':
      return 0.85;
    case 'medium':
      return 0.65;
    case 'low':
      return 0.45;
    case 'potato':
      return 0.25;
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/**
 * 校验画质档位字符串。
 *
 * @param level - 档位
 */
function assertQualityLevel(level: QualityLevel): void {
  const allowed: QualityLevel[] = ['ultra', 'high', 'medium', 'low', 'potato'];
  if (!allowed.includes(level)) {
    throw new PerformanceManagerError(
      PerformanceManagerErrorCode.CONFIG_INVALID_QUALITY,
      'setQuality: 未知的 QualityLevel',
      { level },
    );
  }
}

/**
 * 创建 PerformanceManager 实例。
 *
 * @param budget - 可选部分预算覆盖默认值
 * @returns 管理器实例
 *
 * @example
 * const pm = createPerformanceManager({ maxGPUTimeMs: 10 });
 * pm.setAdaptiveEnabled(true);
 * const actions = pm.evaluate({ frameDurationMs: 20, drawCallCount: 1, triangleCount: 3 });
 */
export function createPerformanceManager(budget?: Partial<PerformanceBudget>): PerformanceManager {
  // 解析预算；非法直接抛错，避免静默进入不一致状态
  const resolvedBudget = resolveBudget(budget);

  // 降级栈：与 activeDowngrades 同步（从旧到新）
  const downgradeStack: PerformanceDowngrade[] = [];

  // 自适应开关：默认开启更符合“自适应”语义
  let adaptiveEnabled = true;

  // 连续超预算 / 在预算内计数器
  let consecutiveOver = 0;
  let consecutiveUnder = 0;

  // 当前画质档位
  let currentQuality: QualityLevel = 'high';

  // 记录分辨率步骤（链中仅一步 reduce-resolution，此处保留扩展点）
  let resolutionScaleApplied = FIRST_RESOLUTION_SCALE;

  /**
   * 构建降级链上第 k 步对应的动作（k 为当前栈深度）。
   *
   * @param stepIndex - 0..5 链索引
   * @returns 动作或 undefined（已达链尾）
   */
  const buildActionForStep = (stepIndex: number): PerformanceAction | undefined => {
    // 固定顺序：MSAA → PostProcess → Resolution → SSE → Labels → Atmosphere
    switch (stepIndex) {
      case 0:
        return { type: 'reduce-msaa', sampleCount: 1 };
      case 1:
        return { type: 'disable-postprocess', passId: DEFAULT_POST_PROCESS_PASS_ID };
      case 2:
        // 保证缩放落在合法区间，避免多次 evaluate 重复应用时 scale 崩溃
        resolutionScaleApplied = Math.max(MIN_RESOLUTION_SCALE, Math.min(1, FIRST_RESOLUTION_SCALE));
        return { type: 'reduce-resolution', scale: resolutionScaleApplied };
      case 3:
        return { type: 'increase-sse-threshold', value: Math.min(MAX_SSE_THRESHOLD, FIRST_SSE_THRESHOLD) };
      case 4:
        return { type: 'reduce-label-density', factor: FIRST_LABEL_DENSITY_FACTOR };
      case 5:
        return { type: 'disable-atmosphere' };
      default:
        return undefined;
    }
  };

  /**
   * 由动作推断 downgrade.type 字符串。
   *
   * @param action - 动作
   * @returns 类型键
   */
  const actionToDowngradeType = (action: PerformanceAction): string => {
    switch (action.type) {
      case 'restore':
        return 'restore';
      default:
        return action.type;
    }
  };

  const manager: PerformanceManager = {
    get budget(): PerformanceBudget {
      return resolvedBudget;
    },

    get currentQuality(): QualityLevel {
      return currentQuality;
    },

    get isAdaptiveEnabled(): boolean {
      return adaptiveEnabled;
    },

    get activeDowngrades(): PerformanceDowngrade[] {
      // 返回浅拷贝，防止外部 mutates 内部栈
      return downgradeStack.slice();
    },

    setAdaptiveEnabled(enabled: boolean): void {
      if (typeof enabled !== 'boolean') {
        throw new PerformanceManagerError(
          PerformanceManagerErrorCode.CONFIG_INVALID_BUDGET,
          'setAdaptiveEnabled 需要 boolean',
          { enabled },
        );
      }
      adaptiveEnabled = enabled;
      if (!enabled) {
        // 关闭自适应时清零计数，避免恢复瞬间抖动
        consecutiveOver = 0;
        consecutiveUnder = 0;
      }
    },

    setQuality(level: QualityLevel): void {
      assertQualityLevel(level);
      currentQuality = level;
      // 手动切换画质：清空栈与计数，避免与自动降级交织
      downgradeStack.length = 0;
      consecutiveOver = 0;
      consecutiveUnder = 0;
      // 预调权重：低画质从更低分辨率起点开始（仅影响下次降分辨率动作数值）
      const rank = qualityRank(level);
      resolutionScaleApplied = Math.max(MIN_RESOLUTION_SCALE, Math.min(1, FIRST_RESOLUTION_SCALE * rank));
    },

    evaluate(stats: {
      frameDurationMs: number;
      gpuDurationMs?: number;
      drawCallCount: number;
      triangleCount: number;
    }): PerformanceAction[] {
      validateStats(stats);

      if (!adaptiveEnabled) {
        return [];
      }

      const over = isOverBudget(resolvedBudget, stats);

      if (over) {
        // 超预算：累加 over，清零 under
        consecutiveUnder = 0;
        consecutiveOver++;

        if (consecutiveOver < CONSECUTIVE_OVER_FRAMES_THRESHOLD) {
          return [];
        }

        // 达到连续超预算阈值：尝试推入下一级降级
        consecutiveOver = 0;

        const nextIndex = downgradeStack.length;
        const nextAction = buildActionForStep(nextIndex);

        if (nextAction === undefined) {
          // 链已用尽：不再产生新动作（仍保持超预算计数由后续帧继续统计）
          return [];
        }

        const reason = inferReason(resolvedBudget, stats);
        const entry: PerformanceDowngrade = {
          type: actionToDowngradeType(nextAction),
          appliedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          reason,
        };

        downgradeStack.push(entry);

        // 同步压低当前画质档位（每步一档）
        if (currentQuality !== 'potato') {
          const order: QualityLevel[] = ['ultra', 'high', 'medium', 'low', 'potato'];
          const idx = order.indexOf(currentQuality);
          if (idx >= 0 && idx < order.length - 1) {
            currentQuality = order[idx + 1]!;
          }
        }

        return [nextAction];
      }

      // 未超预算：累加 under，清零 over
      consecutiveOver = 0;
      consecutiveUnder++;

      if (consecutiveUnder < CONSECUTIVE_UNDER_FRAMES_THRESHOLD) {
        return [];
      }

      if (downgradeStack.length === 0) {
        // 无降级可恢复：仅重置计数器
        consecutiveUnder = 0;
        return [];
      }

      // 连续在预算内：恢复一级
      consecutiveUnder = 0;
      downgradeStack.pop();

      if (currentQuality !== 'ultra') {
        const order: QualityLevel[] = ['ultra', 'high', 'medium', 'low', 'potato'];
        const idx = order.indexOf(currentQuality);
        if (idx > 0) {
          currentQuality = order[idx - 1]!;
        }
      }

      return [{ type: 'restore' }];
    },
  };

  return manager;
}
