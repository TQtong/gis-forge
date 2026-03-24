// ============================================================
// HiDPIAdapter.ts — 高 DPI 屏幕适配器
// 职责：根据设备像素比（DPR）自动调整渲染分辨率，
//       并提供动态分辨率缩放（帧率不足时自动降分辨率，
//       帧率恢复时缓慢回升）。
// 依赖层级：L6（预设层 compat-hidpi 包）。
// ============================================================

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

/**
 * HiDPIAdapter 模块错误码，前缀 `HIDPI_` 以避免跨模块碰撞。
 */
const HIDPI_ERROR_CODES = {
    /** 选项校验失败 */
    INVALID_OPTIONS: 'HIDPI_INVALID_OPTIONS',
    /** maxPixelRatio 超出有效范围 */
    INVALID_MAX_PIXEL_RATIO: 'HIDPI_INVALID_MAX_PIXEL_RATIO',
    /** minResolutionScale 超出有效范围 */
    INVALID_MIN_RESOLUTION_SCALE: 'HIDPI_INVALID_MIN_RESOLUTION_SCALE',
    /** fpsThreshold 超出有效范围 */
    INVALID_FPS_THRESHOLD: 'HIDPI_INVALID_FPS_THRESHOLD',
    /** 速率参数超出有效范围 */
    INVALID_RATE: 'HIDPI_INVALID_RATE',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认最大像素比限制——超过 2 的 DPR 对画质提升有限但 GPU 开销倍增 */
const DEFAULT_MAX_PIXEL_RATIO = 2.0;

/** 默认动态分辨率最低缩放下限——0.5 = 50% 渲染分辨率 */
const DEFAULT_MIN_RESOLUTION_SCALE = 0.5;

/** 默认 FPS 阈值——低于此值触发降分辨率 */
const DEFAULT_FPS_THRESHOLD = 30;

/** 默认恢复速率（每帧增加的缩放比）——慢恢复避免画面抖动 */
const DEFAULT_RESTORE_RATE = 0.02;

/** 默认降级速率（每帧减少的缩放比）——快降级保证帧率优先 */
const DEFAULT_DEGRADE_RATE = 0.05;

/** 迟滞倍率——恢复阈值 = fpsThreshold × HYSTERESIS_MULTIPLIER，防止在阈值附近反复切换 */
const HYSTERESIS_MULTIPLIER = 1.2;

/** 最大像素比上界——超过 5 的 DPR 设备理论上不存在 */
const MAX_PIXEL_RATIO_UPPER = 5.0;

/** 最小像素比下界 */
const MIN_PIXEL_RATIO_LOWER = 0.5;

/** 最小分辨率缩放下限——不低于 25% 否则画面不可用 */
const MIN_RESOLUTION_SCALE_LOWER = 0.25;

/** 最小分辨率缩放上限——不超过 100% */
const MIN_RESOLUTION_SCALE_UPPER = 1.0;

/** FPS 阈值下限——低于 10 FPS 的阈值无意义 */
const FPS_THRESHOLD_LOWER = 10;

/** FPS 阈值上限——高于 144 FPS 的阈值无意义 */
const FPS_THRESHOLD_UPPER = 144;

/** 速率下限——太小则调节无效 */
const RATE_LOWER = 0.001;

/** 速率上限——太大则每帧变化过剧 */
const RATE_UPPER = 0.5;

/** GPU 时间超标阈值（毫秒）——超过 12ms 也触发降级（60fps 帧预算 16.67ms） */
const GPU_TIME_DEGRADE_THRESHOLD_MS = 12.0;

// ---------------------------------------------------------------------------
// HiDPIAdapter 选项
// ---------------------------------------------------------------------------

/**
 * HiDPIAdapter 配置选项。
 * 控制静态 DPR 限制和动态分辨率缩放行为。
 *
 * @stability stable
 *
 * @example
 * const options: HiDPIAdapterOptions = {
 *   maxPixelRatio: 2,
 *   dynamicResolution: true,
 *   minResolutionScale: 0.5,
 *   fpsThreshold: 30,
 *   restoreRate: 0.02,
 *   degradeRate: 0.05,
 * };
 */
export interface HiDPIAdapterOptions {
    /**
     * 最大像素比限制，范围 [0.5, 5.0]。
     * 实际使用的 DPR = min(devicePixelRatio, maxPixelRatio)。
     * 设为 2 可将 3x 屏幕的渲染负载降低约 56%。
     * @default 2.0
     */
    readonly maxPixelRatio?: number;

    /**
     * 是否启用动态分辨率缩放。
     * 启用后根据实时帧率自动调节渲染分辨率。
     * @default false
     */
    readonly dynamicResolution?: boolean;

    /**
     * 动态分辨率最低缩放值，范围 [0.25, 1.0]。
     * 缩放不会低于此值以保证最低画质。
     * @default 0.5
     */
    readonly minResolutionScale?: number;

    /**
     * 触发降级的 FPS 阈值，范围 [10, 144]。
     * 当实时帧率低于此值时开始降低渲染分辨率。
     * 恢复阈值为 fpsThreshold × 1.2（迟滞防抖动）。
     * @default 30
     */
    readonly fpsThreshold?: number;

    /**
     * 分辨率恢复速率（每帧增量），范围 [0.001, 0.5]。
     * 值越小恢复越慢，画面越稳定。
     * 非对称设计：restoreRate << degradeRate，快降慢升。
     * @default 0.02
     */
    readonly restoreRate?: number;

    /**
     * 分辨率降级速率（每帧降量），范围 [0.001, 0.5]。
     * 值越大降级越快，帧率恢复越迅速。
     * 非对称设计：degradeRate >> restoreRate，快降慢升。
     * @default 0.05
     */
    readonly degradeRate?: number;
}

// ---------------------------------------------------------------------------
// 动态分辨率评估结果
// ---------------------------------------------------------------------------

/**
 * 动态分辨率评估结果。
 * 每帧调用 evaluate() 返回，告知调用方是否需要更新渲染分辨率。
 *
 * @stability experimental
 *
 * @example
 * const result = adapter.evaluate(fps, gpuTimeMs);
 * if (result.changed) {
 *   renderer.setResolutionScale(result.scale);
 * }
 */
export interface DynamicResolutionResult {
    /** 当前推荐的渲染分辨率缩放比 [minResolutionScale, 1.0] */
    readonly scale: number;

    /** 相比上一帧是否发生了变化（避免无意义的 resize 操作） */
    readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 将数值限制在 [min, max] 闭区间内。
 * 处理 NaN：NaN 被钳制为 min（保守策略）。
 *
 * @param value - 输入值
 * @param min - 下界（含）
 * @param max - 上界（含）
 * @returns 钳制后的值
 *
 * @example
 * clamp(0.3, 0.5, 1.0); // → 0.5
 */
function clamp(value: number, min: number, max: number): number {
    if (value >= min) {
        return value <= max ? value : max;
    }
    return min;
}

// ---------------------------------------------------------------------------
// HiDPIAdapter 主类
// ---------------------------------------------------------------------------

/**
 * 高 DPI 屏幕适配器。
 * 提供两大功能：
 * 1. 静态 DPR 限制——将过高的 devicePixelRatio 钳制到 maxPixelRatio
 * 2. 动态分辨率缩放——实时监测帧率/GPU 时间，自动调节渲染分辨率
 *
 * 动态分辨率的核心设计为**非对称调节**：
 * - 降级速度快（degradeRate=0.05），保证帧率优先恢复
 * - 恢复速度慢（restoreRate=0.02），避免画面频繁跳变
 * - 迟滞带（hysteresis=1.2×threshold），防止在阈值附近振荡
 *
 * @stability experimental
 *
 * @example
 * const adapter = new HiDPIAdapter({ maxPixelRatio: 2, dynamicResolution: true });
 * const dpr = adapter.getRecommendedDPR();
 * adapter.startDynamicResolution();
 * // 每帧调用
 * const { scale, changed } = adapter.evaluate(currentFPS, gpuTimeMs);
 * if (changed) renderer.setResolutionScale(scale);
 */
export class HiDPIAdapter {
    // --------------- 私有成员 ---------------

    /** 用户选项（合并默认值后的最终值） */
    private readonly _maxPixelRatio: number;

    /** 是否启用动态分辨率 */
    private readonly _dynamicResolution: boolean;

    /** 动态分辨率最低缩放值 */
    private readonly _minResolutionScale: number;

    /** FPS 降级阈值 */
    private readonly _fpsThreshold: number;

    /** FPS 恢复阈值（= fpsThreshold × HYSTERESIS_MULTIPLIER） */
    private readonly _restoreThreshold: number;

    /** 每帧恢复速率 */
    private readonly _restoreRate: number;

    /** 每帧降级速率 */
    private readonly _degradeRate: number;

    /** 当前动态缩放值（1.0 = 满分辨率） */
    private _currentScale: number = 1.0;

    /** 动态分辨率是否正在运行 */
    private _isDynamicActive: boolean = false;

    // --------------- 构造函数 ---------------

    /**
     * 创建 HiDPIAdapter 实例。
     *
     * @param options - 配置选项，所有字段均可选
     * @throws 当 options 中的数值超出有效范围时抛出错误
     *
     * @example
     * const adapter = new HiDPIAdapter({ maxPixelRatio: 2 });
     */
    constructor(options: HiDPIAdapterOptions = {}) {
        // 合并默认值
        const maxPixelRatio = options.maxPixelRatio !== undefined
            ? options.maxPixelRatio
            : DEFAULT_MAX_PIXEL_RATIO;
        const dynamicResolution = options.dynamicResolution !== undefined
            ? options.dynamicResolution
            : false;
        const minResolutionScale = options.minResolutionScale !== undefined
            ? options.minResolutionScale
            : DEFAULT_MIN_RESOLUTION_SCALE;
        const fpsThreshold = options.fpsThreshold !== undefined
            ? options.fpsThreshold
            : DEFAULT_FPS_THRESHOLD;
        const restoreRate = options.restoreRate !== undefined
            ? options.restoreRate
            : DEFAULT_RESTORE_RATE;
        const degradeRate = options.degradeRate !== undefined
            ? options.degradeRate
            : DEFAULT_DEGRADE_RATE;

        // 校验 maxPixelRatio
        if (
            typeof maxPixelRatio !== 'number' ||
            !isFinite(maxPixelRatio) ||
            maxPixelRatio < MIN_PIXEL_RATIO_LOWER ||
            maxPixelRatio > MAX_PIXEL_RATIO_UPPER
        ) {
            throw new Error(
                `[${HIDPI_ERROR_CODES.INVALID_MAX_PIXEL_RATIO}] maxPixelRatio 必须在 [${MIN_PIXEL_RATIO_LOWER}, ${MAX_PIXEL_RATIO_UPPER}] 范围内，当前值: ${maxPixelRatio}`
            );
        }

        // 校验 minResolutionScale
        if (
            typeof minResolutionScale !== 'number' ||
            !isFinite(minResolutionScale) ||
            minResolutionScale < MIN_RESOLUTION_SCALE_LOWER ||
            minResolutionScale > MIN_RESOLUTION_SCALE_UPPER
        ) {
            throw new Error(
                `[${HIDPI_ERROR_CODES.INVALID_MIN_RESOLUTION_SCALE}] minResolutionScale 必须在 [${MIN_RESOLUTION_SCALE_LOWER}, ${MIN_RESOLUTION_SCALE_UPPER}] 范围内，当前值: ${minResolutionScale}`
            );
        }

        // 校验 fpsThreshold
        if (
            typeof fpsThreshold !== 'number' ||
            !isFinite(fpsThreshold) ||
            fpsThreshold < FPS_THRESHOLD_LOWER ||
            fpsThreshold > FPS_THRESHOLD_UPPER
        ) {
            throw new Error(
                `[${HIDPI_ERROR_CODES.INVALID_FPS_THRESHOLD}] fpsThreshold 必须在 [${FPS_THRESHOLD_LOWER}, ${FPS_THRESHOLD_UPPER}] 范围内，当前值: ${fpsThreshold}`
            );
        }

        // 校验 restoreRate
        if (
            typeof restoreRate !== 'number' ||
            !isFinite(restoreRate) ||
            restoreRate < RATE_LOWER ||
            restoreRate > RATE_UPPER
        ) {
            throw new Error(
                `[${HIDPI_ERROR_CODES.INVALID_RATE}] restoreRate 必须在 [${RATE_LOWER}, ${RATE_UPPER}] 范围内，当前值: ${restoreRate}`
            );
        }

        // 校验 degradeRate
        if (
            typeof degradeRate !== 'number' ||
            !isFinite(degradeRate) ||
            degradeRate < RATE_LOWER ||
            degradeRate > RATE_UPPER
        ) {
            throw new Error(
                `[${HIDPI_ERROR_CODES.INVALID_RATE}] degradeRate 必须在 [${RATE_LOWER}, ${RATE_UPPER}] 范围内，当前值: ${degradeRate}`
            );
        }

        this._maxPixelRatio = maxPixelRatio;
        this._dynamicResolution = dynamicResolution;
        this._minResolutionScale = minResolutionScale;
        this._fpsThreshold = fpsThreshold;
        // 恢复阈值取迟滞倍率，防止在阈值附近反复切换
        this._restoreThreshold = fpsThreshold * HYSTERESIS_MULTIPLIER;
        this._restoreRate = restoreRate;
        this._degradeRate = degradeRate;
        // 初始缩放为满分辨率
        this._currentScale = 1.0;
        // 如果构造时 dynamicResolution=true，自动启动
        this._isDynamicActive = dynamicResolution;
    }

    // --------------- 公共属性 ---------------

    /**
     * 当前动态分辨率缩放值。
     * 范围 [minResolutionScale, 1.0]，1.0 表示满分辨率。
     *
     * @stability stable
     *
     * @example
     * console.log(adapter.currentScale); // 0.75
     */
    get currentScale(): number {
        return this._currentScale;
    }

    /**
     * 动态分辨率是否处于活动状态。
     *
     * @stability stable
     *
     * @example
     * if (adapter.isDynamicActive) { ... }
     */
    get isDynamicActive(): boolean {
        return this._isDynamicActive;
    }

    // --------------- 核心方法 ---------------

    /**
     * 获取推荐的设备像素比（DPR）。
     * 将实际 devicePixelRatio 钳制到 [1, maxPixelRatio] 范围内。
     * 非浏览器环境返回 1.0 作为安全默认值。
     *
     * @returns 推荐的 DPR 值
     *
     * @stability stable
     *
     * @example
     * const dpr = adapter.getRecommendedDPR(); // 2 on 3x screen with maxPixelRatio=2
     */
    getRecommendedDPR(): number {
        // 非浏览器环境安全回退
        if (typeof window === 'undefined' || typeof window.devicePixelRatio !== 'number') {
            return 1.0;
        }

        const nativeDPR = window.devicePixelRatio;

        // 防御 NaN/Infinity/负数
        if (!isFinite(nativeDPR) || nativeDPR <= 0) {
            return 1.0;
        }

        // 取实际 DPR 和最大限制中的较小值
        return Math.min(nativeDPR, this._maxPixelRatio);
    }

    /**
     * 启动动态分辨率缩放。
     * 启动后需每帧调用 evaluate() 以更新缩放值。
     * 重复调用为幂等操作（不会重置当前缩放值）。
     *
     * @stability experimental
     *
     * @example
     * adapter.startDynamicResolution();
     */
    startDynamicResolution(): void {
        if (this._isDynamicActive) {
            // 已经在运行中，幂等返回
            if (__DEV__) {
                console.log('[HiDPIAdapter] 动态分辨率已在运行中，跳过重复启动');
            }
            return;
        }

        this._isDynamicActive = true;
        // 不重置 _currentScale，保持之前的状态（如果有的话）

        if (__DEV__) {
            console.log(
                `[HiDPIAdapter] 动态分辨率已启动: fpsThreshold=${this._fpsThreshold}, ` +
                `restoreThreshold=${this._restoreThreshold.toFixed(1)}, ` +
                `degradeRate=${this._degradeRate}, restoreRate=${this._restoreRate}`
            );
        }
    }

    /**
     * 停止动态分辨率缩放。
     * 停止后 evaluate() 将返回固定的 1.0 缩放值。
     * 重复调用为幂等操作。
     *
     * @stability experimental
     *
     * @example
     * adapter.stopDynamicResolution();
     */
    stopDynamicResolution(): void {
        if (!this._isDynamicActive) {
            return;
        }

        this._isDynamicActive = false;
        // 恢复满分辨率
        const previousScale = this._currentScale;
        this._currentScale = 1.0;

        if (__DEV__) {
            console.log(
                `[HiDPIAdapter] 动态分辨率已停止: scale ${previousScale.toFixed(3)} → 1.0`
            );
        }
    }

    /**
     * 每帧评估动态分辨率缩放值。
     *
     * 核心算法：
     * 1. 若 FPS < fpsThreshold 或 gpuTimeMs > 12ms → 降级（快速，degradeRate）
     * 2. 若 FPS > fpsThreshold × 1.2（迟滞带）且 gpuTimeMs < 12ms → 恢复（缓慢，restoreRate）
     * 3. 否则保持不变（在迟滞带内不操作）
     *
     * 非对称速率设计保证：
     * - 性能不足时快速响应（2-3 帧内即可显著降低分辨率）
     * - 性能充裕时缓慢恢复（约 25-50 帧才完全恢复，避免画面跳变）
     *
     * @param fps - 当前帧率（由 FrameScheduler 或 RenderStats 提供）
     * @param gpuTimeMs - 当前帧 GPU 耗时（毫秒），可选。由 GPU 时间戳查询提供。
     * @returns 评估结果，包含当前推荐缩放值和是否变化
     *
     * @stability experimental
     *
     * @example
     * // 在帧循环中调用
     * const { scale, changed } = adapter.evaluate(55, 8.5);
     * if (changed) {
     *   surfaceManager.setResolutionScale(scale);
     * }
     */
    evaluate(fps: number, gpuTimeMs?: number): DynamicResolutionResult {
        // 动态分辨率未激活时返回固定满分辨率
        if (!this._isDynamicActive) {
            return { scale: 1.0, changed: false };
        }

        const previousScale = this._currentScale;

        // 防御 NaN/Infinity/负数的 FPS 输入——视为性能极差需降级
        const safeFps = isFinite(fps) && fps >= 0 ? fps : 0;

        // 防御 gpuTimeMs 异常输入
        const safeGpuTime = (gpuTimeMs !== undefined && isFinite(gpuTimeMs) && gpuTimeMs >= 0)
            ? gpuTimeMs
            : 0;

        // 判断是否需要降级：FPS 低于阈值 或 GPU 时间超标
        const needsDegrade = safeFps < this._fpsThreshold ||
            (safeGpuTime > 0 && safeGpuTime > GPU_TIME_DEGRADE_THRESHOLD_MS);

        // 判断是否可以恢复：FPS 高于迟滞阈值 且 GPU 时间未超标
        const canRestore = safeFps > this._restoreThreshold &&
            (safeGpuTime <= 0 || safeGpuTime <= GPU_TIME_DEGRADE_THRESHOLD_MS);

        if (needsDegrade) {
            // 快速降级：每帧减少 degradeRate，钳制到 minResolutionScale
            this._currentScale = Math.max(
                this._minResolutionScale,
                this._currentScale - this._degradeRate
            );
        } else if (canRestore && this._currentScale < 1.0) {
            // 缓慢恢复：每帧增加 restoreRate，钳制到 1.0
            this._currentScale = Math.min(
                1.0,
                this._currentScale + this._restoreRate
            );
        }
        // 否则处于迟滞带内，保持不变

        // 判断缩放值是否实际发生了变化（使用小 epsilon 避免浮点误差误判）
        const EPSILON = 1e-6;
        const changed = Math.abs(this._currentScale - previousScale) > EPSILON;

        if (__DEV__ && changed) {
            console.log(
                `[HiDPIAdapter] scale: ${previousScale.toFixed(3)} → ${this._currentScale.toFixed(3)} ` +
                `(fps=${safeFps.toFixed(1)}, gpu=${safeGpuTime.toFixed(1)}ms, ` +
                `${needsDegrade ? 'DEGRADE' : 'RESTORE'})`
            );
        }

        return {
            scale: this._currentScale,
            changed,
        };
    }
}
