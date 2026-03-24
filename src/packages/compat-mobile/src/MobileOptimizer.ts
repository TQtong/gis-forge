// ============================================================
// MobileOptimizer.ts — 移动端兼容性优化器
// 职责：检测设备性能特征，生成设备配置文件（DeviceProfile），
//       并根据设备能力自动调整引擎配置以获得最佳性能/质量平衡。
// 依赖层级：L6（预设层 compat-mobile 包），消费 L0 类型。
// ============================================================

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/**
 * MobileOptimizer 模块错误码，前缀 `MOBILE_` 以避免跨模块碰撞。
 */
const MOBILE_ERROR_CODES = {
    /** 选项校验失败 */
    INVALID_OPTIONS: 'MOBILE_INVALID_OPTIONS',
    /** 检测失败（例如无法获取 GPU 能力） */
    DETECT_FAILED: 'MOBILE_DETECT_FAILED',
    /** 配置优化失败 */
    OPTIMIZE_FAILED: 'MOBILE_OPTIMIZE_FAILED',
    /** maxResolutionScale 超出有效范围 */
    INVALID_RESOLUTION_SCALE: 'MOBILE_INVALID_RESOLUTION_SCALE',
    /** maxTileCache 超出有效范围 */
    INVALID_TILE_CACHE: 'MOBILE_INVALID_TILE_CACHE',
    /** maxWorkers 超出有效范围 */
    INVALID_MAX_WORKERS: 'MOBILE_INVALID_MAX_WORKERS',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认最大渲染分辨率缩放比（0.75 = 75% 原生分辨率） */
const DEFAULT_MAX_RESOLUTION_SCALE = 0.75;

/** 默认最大瓦片缓存数量 */
const DEFAULT_MAX_TILE_CACHE = 128;

/** 默认最大 Worker 线程数 */
const DEFAULT_MAX_WORKERS = 2;

/** 分辨率缩放最小值（低于此值画面过于模糊无意义） */
const MIN_RESOLUTION_SCALE = 0.25;

/** 分辨率缩放最大值（不超过原生分辨率） */
const MAX_RESOLUTION_SCALE = 1.0;

/** 瓦片缓存数量下限 */
const MIN_TILE_CACHE = 16;

/** 瓦片缓存数量上限 */
const MAX_TILE_CACHE = 1024;

/** Worker 数量下限 */
const MIN_WORKERS = 1;

/** Worker 数量上限 */
const MAX_WORKERS = 16;

/** 高性能设备最小纹理尺寸阈值——maxTextureSize >= 8192 归类为高性能 */
const HIGH_TEXTURE_THRESHOLD = 8192;

/** 中性能设备最小纹理尺寸阈值——maxTextureSize >= 4096 归类为中性能 */
const MEDIUM_TEXTURE_THRESHOLD = 4096;

/** 高性能设备最小估算显存阈值（MB） */
const HIGH_MEMORY_THRESHOLD_MB = 4096;

/** 中性能设备最小估算显存阈值（MB） */
const MEDIUM_MEMORY_THRESHOLD_MB = 2048;

/** 平板检测最小屏幕短边阈值（CSS 像素） */
const TABLET_MIN_SCREEN_SHORT_EDGE = 600;

/** 平板检测最大屏幕短边阈值（CSS 像素） */
const TABLET_MAX_SCREEN_SHORT_EDGE = 1400;

/** 低配设备渲染分辨率缩放 */
const LOW_LEVEL_RESOLUTION_SCALE = 0.5;

/** 中配设备渲染分辨率缩放 */
const MEDIUM_LEVEL_RESOLUTION_SCALE = 0.75;

/** 高配设备渲染分辨率缩放 */
const HIGH_LEVEL_RESOLUTION_SCALE = 1.0;

/** 低配设备瓦片缓存上限 */
const LOW_LEVEL_TILE_CACHE = 64;

/** 中配设备瓦片缓存上限 */
const MEDIUM_LEVEL_TILE_CACHE = 128;

/** 高配设备瓦片缓存上限 */
const HIGH_LEVEL_TILE_CACHE = 256;

/** 低配设备 Worker 数量上限 */
const LOW_LEVEL_MAX_WORKERS = 1;

/** 中配设备 Worker 数量上限 */
const MEDIUM_LEVEL_MAX_WORKERS = 2;

/** 高配设备 Worker 数量上限 */
const HIGH_LEVEL_MAX_WORKERS = 4;

/** 低配设备最大绘制调用数 */
const LOW_LEVEL_MAX_DRAW_CALLS = 50;

/** 中配设备最大绘制调用数 */
const MEDIUM_LEVEL_MAX_DRAW_CALLS = 100;

/** 高配设备最大绘制调用数 */
const HIGH_LEVEL_MAX_DRAW_CALLS = 200;

/** 低配设备最大三角面数 */
const LOW_LEVEL_MAX_TRIANGLES = 500_000;

/** 中配设备最大三角面数 */
const MEDIUM_LEVEL_MAX_TRIANGLES = 1_000_000;

/** 高配设备最大三角面数 */
const HIGH_LEVEL_MAX_TRIANGLES = 2_000_000;

/** 低配 SSE（Screen Space Error）阈值——更大 = 更早降级 LOD */
const LOW_LEVEL_SSE_THRESHOLD = 8.0;

/** 中配 SSE 阈值 */
const MEDIUM_LEVEL_SSE_THRESHOLD = 4.0;

/** 高配 SSE 阈值 */
const HIGH_LEVEL_SSE_THRESHOLD = 2.0;

/** 低配 MSAA 采样数（关闭） */
const LOW_LEVEL_MSAA = 1;

/** 中配 MSAA 采样数 */
const MEDIUM_LEVEL_MSAA = 1;

/** 高配 MSAA 采样数 */
const HIGH_LEVEL_MSAA = 4;

// ---------------------------------------------------------------------------
// GPU 能力接口
// ---------------------------------------------------------------------------

/**
 * GPU 设备能力描述，由 L1 DeviceManager 检测后传入。
 * MobileOptimizer 用这些信息评估设备性能级别。
 *
 * @stability experimental
 */
export interface GPUCapabilities {
    /** GPU 适配器名称/描述（例如 "Apple GPU", "Adreno 730"） */
    readonly adapterDescription: string;

    /** GPU 供应商名称（例如 "apple", "qualcomm", "arm"） */
    readonly vendor: string;

    /** 支持的最大纹理尺寸（单维度像素数） */
    readonly maxTextureSize: number;

    /** 是否支持计算着色器（Compute Shader） */
    readonly supportsCompute: boolean;

    /** 是否支持 float32 纹理过滤（textureFilterFloat 特性） */
    readonly supportsFloat32Filter: boolean;

    /** 是否支持时间戳查询（用于 GPU 性能分析） */
    readonly supportsTimestampQuery: boolean;

    /** 估算的 GPU 可用显存（MB），不可用时为 0 */
    readonly estimatedMemoryMB: number;
}

// ---------------------------------------------------------------------------
// MobileOptimizer 选项
// ---------------------------------------------------------------------------

/**
 * MobileOptimizer 配置选项。
 * 控制自动检测行为和移动端优化参数的上下限。
 *
 * @stability stable
 *
 * @example
 * const options: MobileOptimizerOptions = {
 *   autoDetect: true,
 *   maxResolutionScale: 0.75,
 *   maxTileCache: 128,
 *   maxWorkers: 2,
 *   touchOptimization: true,
 * };
 */
export interface MobileOptimizerOptions {
    /**
     * 是否在构造时自动检测设备配置。
     * 设为 false 可延迟到手动调用 detect()。
     * @default true
     */
    readonly autoDetect?: boolean;

    /**
     * 强制指定设备性能级别，跳过自动检测。
     * 用于调试或已知设备的快速配置。
     * 若不提供则由 detect() 自动判定。
     * @default undefined
     */
    readonly forceLevel?: 'high' | 'medium' | 'low';

    /**
     * 最大渲染分辨率缩放比，范围 [0.25, 1.0]。
     * 1.0 = 原生分辨率，0.5 = 半分辨率。
     * 移动端降低渲染分辨率可显著降低 GPU 负载。
     * @default 0.75
     */
    readonly maxResolutionScale?: number;

    /**
     * 最大瓦片缓存数量，范围 [16, 1024]。
     * 移动端内存有限，应限制缓存瓦片数量。
     * @default 128
     */
    readonly maxTileCache?: number;

    /**
     * 最大 Worker 线程数量，范围 [1, 16]。
     * 移动端 CPU 核心少，过多 Worker 反而拖慢主线程。
     * @default 2
     */
    readonly maxWorkers?: number;

    /**
     * 是否启用触摸交互优化。
     * 启用后增大手势惯性衰减、放大触摸目标区域等。
     * @default true
     */
    readonly touchOptimization?: boolean;
}

// ---------------------------------------------------------------------------
// 设备配置文件
// ---------------------------------------------------------------------------

/**
 * 设备性能配置文件。
 * 由 detect() 方法生成，描述当前设备的硬件特征和性能级别。
 * 用于后续 optimize() 和 getRecommendedConfig() 调用。
 *
 * @stability stable
 *
 * @example
 * const profile: DeviceProfile = {
 *   level: 'medium',
 *   gpu: 'Adreno 730',
 *   isMobile: true,
 *   isTablet: false,
 *   estimatedMemoryMB: 2048,
 *   maxTextureSize: 4096,
 *   supportsCompute: true,
 *   supportsFloat32Filter: false,
 *   devicePixelRatio: 3,
 *   screenSize: { width: 393, height: 852 },
 *   supportsTimestampQuery: false,
 * };
 */
export interface DeviceProfile {
    /** 设备性能级别，由 detect() 基于硬件特征综合评估 */
    readonly level: 'high' | 'medium' | 'low';

    /** GPU 适配器描述字符串（来自 WebGPU 适配器信息） */
    readonly gpu: string;

    /** 是否为移动设备（手机/平板），基于 UA 嗅探 + 触摸能力判断 */
    readonly isMobile: boolean;

    /** 是否为平板设备（区别于手机），基于屏幕尺寸范围判断 */
    readonly isTablet: boolean;

    /** 估算 GPU 可用显存（MB），0 表示无法获取 */
    readonly estimatedMemoryMB: number;

    /** GPU 支持的最大纹理单维度像素数 */
    readonly maxTextureSize: number;

    /** 是否支持计算着色器 */
    readonly supportsCompute: boolean;

    /** 是否支持 float32 纹理过滤 */
    readonly supportsFloat32Filter: boolean;

    /** 设备像素比（来自 window.devicePixelRatio） */
    readonly devicePixelRatio: number;

    /** 屏幕 CSS 像素尺寸 */
    readonly screenSize: { readonly width: number; readonly height: number };

    /** 是否支持 GPU 时间戳查询 */
    readonly supportsTimestampQuery: boolean;
}

// ---------------------------------------------------------------------------
// 引擎优化配置（optimize() 返回的结构）
// ---------------------------------------------------------------------------

/**
 * 引擎优化配置——optimize() 基于 DeviceProfile 生成的推荐参数集。
 * 上层引擎（L3/L6）读取此配置来调整调度参数。
 *
 * @stability experimental
 *
 * @example
 * const config = optimizer.getRecommendedConfig(profile);
 * frameScheduler.setTargetFPS(config.targetFPS);
 */
export interface EngineOptimizedConfig {
    /** 目标帧率（FPS），低端设备降到 30 减轻负载 */
    readonly targetFPS: number;

    /** 渲染分辨率缩放比 [0.25, 1.0] */
    readonly resolutionScale: number;

    /** MSAA 采样数（1 = 关闭，4 = 4x MSAA） */
    readonly msaaSampleCount: number;

    /** 最大瓦片缓存数量 */
    readonly maxTileCache: number;

    /** 最大 Worker 线程数 */
    readonly maxWorkers: number;

    /** 最大绘制调用数（超出则由 PerformanceManager 降级） */
    readonly maxDrawCalls: number;

    /** 最大三角形数量（超出则由 PerformanceManager 降级） */
    readonly maxTriangles: number;

    /** SSE（Screen Space Error）阈值——越大越激进地降低 LOD */
    readonly sseThreshold: number;

    /** 是否启用后处理（低端设备应关闭） */
    readonly enablePostProcess: boolean;

    /** 是否启用大气效果（低端设备应关闭） */
    readonly enableAtmosphere: boolean;

    /** 是否启用阴影（低端设备应关闭） */
    readonly enableShadows: boolean;

    /** 是否启用标注碰撞检测（低端设备应关闭） */
    readonly enableLabelCollision: boolean;

    /** 是否启用触摸优化（增大惯性衰减、放大触摸目标区） */
    readonly touchOptimization: boolean;

    /** GPU 电源偏好设置 */
    readonly powerPreference: 'high-performance' | 'low-power';
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 将数值限制在 [min, max] 闭区间内。
 * 处理 NaN 输入：NaN 会被钳制为 min（保守策略）。
 *
 * @param value - 输入值
 * @param min - 下界（含）
 * @param max - 上界（含）
 * @returns 钳制后的值
 *
 * @example
 * clamp(1.5, 0, 1); // → 1.0
 * clamp(NaN, 0, 1); // → 0（NaN 走保守路径）
 */
function clamp(value: number, min: number, max: number): number {
    // NaN 与任何值比较都返回 false，因此 NaN 会落入 else 分支返回 min
    if (value >= min) {
        return value <= max ? value : max;
    }
    return min;
}

/**
 * 通过 User-Agent 字符串检测是否为移动设备。
 * 同时检查 navigator.maxTouchPoints 作为辅助判断（覆盖 UA 被修改的情况）。
 *
 * @returns true 表示当前环境为移动设备
 *
 * @example
 * const mobile = detectMobileByUA(); // true on iPhone/Android
 */
function detectMobileByUA(): boolean {
    // 非浏览器环境（如 Node.js 测试）保守返回 false
    if (typeof navigator === 'undefined') {
        return false;
    }

    const ua = navigator.userAgent || '';

    // 主流移动设备 UA 关键词匹配（覆盖 iOS/Android/Windows Phone/BlackBerry）
    const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
    const uaIsMobile = mobileRegex.test(ua);

    // navigator.maxTouchPoints > 0 辅助判断——覆盖 iPad（iPadOS 13+ 默认桌面 UA）
    const hasTouchPoints = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0;

    // 两个条件满足其一即视为移动设备
    return uaIsMobile || hasTouchPoints;
}

/**
 * 通过屏幕尺寸检测是否为平板设备。
 * 平板定义：屏幕短边在 [600, 1400] CSS 像素范围内的移动设备。
 * 仅在已确认 isMobile 为 true 时调用，纯桌面设备不走此判断。
 *
 * @returns true 表示当前设备为平板
 *
 * @example
 * const tablet = detectTablet(); // true on iPad
 */
function detectTablet(): boolean {
    // 非浏览器环境保守返回 false
    if (typeof screen === 'undefined') {
        return false;
    }

    const w = screen.width || 0;
    const h = screen.height || 0;

    // 取屏幕短边——横竖屏旋转不影响判断
    const shortEdge = Math.min(w, h);

    // 平板短边通常在 600~1400 CSS 像素之间
    return shortEdge >= TABLET_MIN_SCREEN_SHORT_EDGE && shortEdge <= TABLET_MAX_SCREEN_SHORT_EDGE;
}

/**
 * 获取当前屏幕 CSS 像素尺寸。
 * 在非浏览器环境返回安全默认值 (0, 0)。
 *
 * @returns 屏幕宽高对象
 *
 * @example
 * const { width, height } = getScreenSize();
 */
function getScreenSize(): { readonly width: number; readonly height: number } {
    if (typeof screen === 'undefined') {
        return { width: 0, height: 0 };
    }
    return {
        width: screen.width || 0,
        height: screen.height || 0,
    };
}

/**
 * 获取当前设备像素比。
 * 非浏览器环境返回 1.0 作为安全默认值。
 *
 * @returns 设备像素比
 *
 * @example
 * const dpr = getDevicePixelRatio(); // 3 on iPhone 15 Pro
 */
function getDevicePixelRatio(): number {
    if (typeof window === 'undefined' || typeof window.devicePixelRatio !== 'number') {
        return 1.0;
    }
    // devicePixelRatio 理论上始终 > 0，但为防异常值钳制到 [0.5, 5]
    return clamp(window.devicePixelRatio, 0.5, 5.0);
}

/**
 * 根据硬件特征评估设备性能级别（high/medium/low）。
 * 评估维度：最大纹理尺寸、估算显存、Compute Shader 支持。
 * 三级判定逻辑：满足 high 全部条件 → high；满足 medium 全部条件 → medium；否则 low。
 *
 * @param capabilities - GPU 设备能力
 * @param isMobile - 是否为移动设备（移动设备对 high 条件更严格）
 * @returns 性能级别
 *
 * @example
 * const level = assessLevel(caps, true); // 'medium'
 */
function assessLevel(capabilities: GPUCapabilities, isMobile: boolean): 'high' | 'medium' | 'low' {
    const { maxTextureSize, estimatedMemoryMB, supportsCompute } = capabilities;

    // 高性能设备条件：大纹理 + 大显存 + 支持 Compute
    const isHigh =
        maxTextureSize >= HIGH_TEXTURE_THRESHOLD &&
        estimatedMemoryMB >= HIGH_MEMORY_THRESHOLD_MB &&
        supportsCompute;

    if (isHigh) {
        // 移动设备即使硬件指标达标，也需要 Compute + float32 过滤才算 high
        // 因为移动 GPU 的散热和功耗限制实际持续性能低于纸面参数
        if (isMobile && !capabilities.supportsFloat32Filter) {
            return 'medium';
        }
        return 'high';
    }

    // 中性能设备条件：中等纹理 + 中等显存
    const isMedium =
        maxTextureSize >= MEDIUM_TEXTURE_THRESHOLD &&
        estimatedMemoryMB >= MEDIUM_MEMORY_THRESHOLD_MB;

    if (isMedium) {
        return 'medium';
    }

    // 其余归为低性能
    return 'low';
}

// ---------------------------------------------------------------------------
// MobileOptimizer 主类
// ---------------------------------------------------------------------------

/**
 * 移动端兼容性优化器。
 * 检测设备硬件特征，评估性能级别，生成最优引擎配置。
 *
 * 使用流程：
 * 1. 创建实例（可配置 autoDetect/forceLevel）
 * 2. 调用 detect(capabilities) 传入 GPU 能力信息
 * 3. 调用 optimize(baseConfig, profile) 或 getRecommendedConfig(profile) 获取优化配置
 * 4. 将配置应用到引擎各子系统（FrameScheduler/MemoryBudget/PerformanceManager）
 *
 * @stability experimental
 *
 * @example
 * const optimizer = new MobileOptimizer({ autoDetect: true });
 * const profile = optimizer.detect(gpuCapabilities);
 * const config = optimizer.getRecommendedConfig(profile);
 * engine.applyConfig(config);
 */
export class MobileOptimizer {
    // --------------- 私有成员 ---------------

    /** 已生成的设备配置文件，detect() 后填充 */
    private _profile: DeviceProfile | null = null;

    /** 用户选项（合并默认值后的最终值） */
    private readonly _options: Required<Omit<MobileOptimizerOptions, 'forceLevel'>> & {
        readonly forceLevel?: 'high' | 'medium' | 'low';
    };

    // --------------- 构造函数 ---------------

    /**
     * 创建 MobileOptimizer 实例。
     *
     * @param options - 配置选项，所有字段均可选，使用内置默认值
     * @throws 当 options 中的数值超出有效范围时抛出错误
     *
     * @example
     * const optimizer = new MobileOptimizer();
     * const optimizerCustom = new MobileOptimizer({ maxResolutionScale: 0.5, maxWorkers: 1 });
     */
    constructor(options: MobileOptimizerOptions = {}) {
        // 合并默认值——每个字段都取用户值或默认值
        const autoDetect = options.autoDetect !== undefined ? options.autoDetect : true;
        const forceLevel = options.forceLevel;
        const maxResolutionScale = options.maxResolutionScale !== undefined
            ? options.maxResolutionScale
            : DEFAULT_MAX_RESOLUTION_SCALE;
        const maxTileCache = options.maxTileCache !== undefined
            ? options.maxTileCache
            : DEFAULT_MAX_TILE_CACHE;
        const maxWorkers = options.maxWorkers !== undefined
            ? options.maxWorkers
            : DEFAULT_MAX_WORKERS;
        const touchOptimization = options.touchOptimization !== undefined
            ? options.touchOptimization
            : true;

        // 校验 maxResolutionScale 范围
        if (
            typeof maxResolutionScale !== 'number' ||
            !isFinite(maxResolutionScale) ||
            maxResolutionScale < MIN_RESOLUTION_SCALE ||
            maxResolutionScale > MAX_RESOLUTION_SCALE
        ) {
            throw new Error(
                `[${MOBILE_ERROR_CODES.INVALID_RESOLUTION_SCALE}] maxResolutionScale 必须在 [${MIN_RESOLUTION_SCALE}, ${MAX_RESOLUTION_SCALE}] 范围内，当前值: ${maxResolutionScale}`
            );
        }

        // 校验 maxTileCache 范围
        if (
            typeof maxTileCache !== 'number' ||
            !isFinite(maxTileCache) ||
            maxTileCache < MIN_TILE_CACHE ||
            maxTileCache > MAX_TILE_CACHE
        ) {
            throw new Error(
                `[${MOBILE_ERROR_CODES.INVALID_TILE_CACHE}] maxTileCache 必须在 [${MIN_TILE_CACHE}, ${MAX_TILE_CACHE}] 范围内，当前值: ${maxTileCache}`
            );
        }

        // 校验 maxWorkers 范围
        if (
            typeof maxWorkers !== 'number' ||
            !isFinite(maxWorkers) ||
            maxWorkers < MIN_WORKERS ||
            maxWorkers > MAX_WORKERS
        ) {
            throw new Error(
                `[${MOBILE_ERROR_CODES.INVALID_MAX_WORKERS}] maxWorkers 必须在 [${MIN_WORKERS}, ${MAX_WORKERS}] 范围内，当前值: ${maxWorkers}`
            );
        }

        this._options = {
            autoDetect,
            forceLevel,
            maxResolutionScale,
            maxTileCache: Math.round(maxTileCache),
            maxWorkers: Math.round(maxWorkers),
            touchOptimization,
        };
    }

    // --------------- 公共属性 ---------------

    /**
     * 获取当前设备配置文件。
     * 在调用 detect() 之前返回 null。
     *
     * @stability stable
     *
     * @example
     * const optimizer = new MobileOptimizer();
     * optimizer.detect(caps);
     * console.log(optimizer.profile?.level); // 'medium'
     */
    get profile(): DeviceProfile | null {
        return this._profile;
    }

    // --------------- 核心方法 ---------------

    /**
     * 检测设备性能特征，生成 DeviceProfile。
     *
     * 检测流程：
     * 1. UA 嗅探 + touchPoints 检查 → isMobile
     * 2. 屏幕尺寸检查 → isTablet（仅 isMobile 时）
     * 3. GPU 能力 + 显存 + Compute 支持 → level（high/medium/low）
     * 4. 如果 forceLevel 被设置则跳过自动评级
     *
     * @param capabilities - GPU 设备能力（由 L1 DeviceManager 提供）
     * @returns 生成的 DeviceProfile
     *
     * @stability stable
     *
     * @example
     * const profile = optimizer.detect({
     *   adapterDescription: 'Apple GPU',
     *   vendor: 'apple',
     *   maxTextureSize: 8192,
     *   supportsCompute: true,
     *   supportsFloat32Filter: true,
     *   supportsTimestampQuery: false,
     *   estimatedMemoryMB: 4096,
     * });
     */
    detect(capabilities: GPUCapabilities): DeviceProfile {
        try {
            // 步骤 1：检测是否为移动设备
            const isMobile = detectMobileByUA();

            // 步骤 2：检测是否为平板（仅移动设备时判断）
            const isTablet = isMobile ? detectTablet() : false;

            // 步骤 3：评估性能级别
            // 优先使用 forceLevel（强制覆盖），否则自动评估
            const level = this._options.forceLevel
                ? this._options.forceLevel
                : assessLevel(capabilities, isMobile);

            // 步骤 4：收集设备像素比和屏幕尺寸
            const devicePixelRatio = getDevicePixelRatio();
            const screenSize = getScreenSize();

            // 步骤 5：组装 DeviceProfile
            const profile: DeviceProfile = {
                level,
                gpu: capabilities.adapterDescription || 'Unknown GPU',
                isMobile,
                isTablet,
                estimatedMemoryMB: capabilities.estimatedMemoryMB || 0,
                maxTextureSize: capabilities.maxTextureSize || 0,
                supportsCompute: capabilities.supportsCompute || false,
                supportsFloat32Filter: capabilities.supportsFloat32Filter || false,
                devicePixelRatio,
                screenSize,
                supportsTimestampQuery: capabilities.supportsTimestampQuery || false,
            };

            // 缓存到实例以便后续 optimize() 使用
            this._profile = profile;

            if (__DEV__) {
                console.log(
                    `[MobileOptimizer] 设备检测完成: level=${level}, gpu=${profile.gpu}, ` +
                    `mobile=${isMobile}, tablet=${isTablet}, memory=${profile.estimatedMemoryMB}MB`
                );
            }

            return profile;
        } catch (error) {
            // 检测失败时返回最保守的低配 profile
            if (__DEV__) {
                console.warn(`[MobileOptimizer] 设备检测失败，使用保守配置:`, error);
            }

            const fallbackProfile: DeviceProfile = {
                level: 'low',
                gpu: 'Unknown (detect failed)',
                isMobile: true,
                isTablet: false,
                estimatedMemoryMB: 0,
                maxTextureSize: 2048,
                supportsCompute: false,
                supportsFloat32Filter: false,
                devicePixelRatio: 1.0,
                screenSize: { width: 0, height: 0 },
                supportsTimestampQuery: false,
            };

            this._profile = fallbackProfile;
            return fallbackProfile;
        }
    }

    /**
     * 基于 DeviceProfile 对基础配置进行优化调整。
     * 将 baseConfig 中的各项参数根据设备性能级别进行覆盖/钳制。
     * 返回新对象，不修改输入。
     *
     * @param baseConfig - 基础引擎配置（通常为桌面端默认值）
     * @param profile - 设备配置文件（由 detect() 生成）
     * @returns 优化后的引擎配置
     *
     * @stability experimental
     *
     * @example
     * const baseConfig = { resolutionScale: 1.0, maxTileCache: 256, ... };
     * const optimized = optimizer.optimize(baseConfig, profile);
     */
    optimize(
        baseConfig: Partial<EngineOptimizedConfig>,
        profile: DeviceProfile
    ): EngineOptimizedConfig {
        try {
            // 获取当前级别的推荐配置作为基线
            const recommended = this.getRecommendedConfig(profile);

            // 用推荐值填充 baseConfig 中缺失的字段
            // 同时将用户 baseConfig 中已设置的值钳制到安全范围内
            const resolutionScale = baseConfig.resolutionScale !== undefined
                ? clamp(
                    Math.min(baseConfig.resolutionScale, this._options.maxResolutionScale),
                    MIN_RESOLUTION_SCALE,
                    recommended.resolutionScale
                )
                : recommended.resolutionScale;

            const maxTileCache = baseConfig.maxTileCache !== undefined
                ? Math.min(baseConfig.maxTileCache, this._options.maxTileCache, recommended.maxTileCache)
                : recommended.maxTileCache;

            const maxWorkers = baseConfig.maxWorkers !== undefined
                ? Math.min(baseConfig.maxWorkers, this._options.maxWorkers, recommended.maxWorkers)
                : recommended.maxWorkers;

            return {
                targetFPS: baseConfig.targetFPS !== undefined
                    ? baseConfig.targetFPS
                    : recommended.targetFPS,
                resolutionScale,
                msaaSampleCount: recommended.msaaSampleCount,
                maxTileCache,
                maxWorkers,
                maxDrawCalls: recommended.maxDrawCalls,
                maxTriangles: recommended.maxTriangles,
                sseThreshold: recommended.sseThreshold,
                enablePostProcess: recommended.enablePostProcess,
                enableAtmosphere: recommended.enableAtmosphere,
                enableShadows: recommended.enableShadows,
                enableLabelCollision: recommended.enableLabelCollision,
                touchOptimization: this._options.touchOptimization && profile.isMobile,
                powerPreference: profile.isMobile ? 'high-performance' : recommended.powerPreference,
            };
        } catch (error) {
            if (__DEV__) {
                console.warn(`[MobileOptimizer] 配置优化失败，返回保守配置:`, error);
            }
            // 失败时返回低配保守值
            return this.getRecommendedConfig({ ...profile, level: 'low' });
        }
    }

    /**
     * 根据 DeviceProfile 直接生成推荐引擎配置（不基于 baseConfig）。
     * 三级配置方案——每个级别对应一套完整的参数预设。
     *
     * @param profile - 设备配置文件
     * @returns 该性能级别的推荐引擎配置
     *
     * @stability experimental
     *
     * @example
     * const config = optimizer.getRecommendedConfig(profile);
     * console.log(config.resolutionScale); // 0.5 for low-level devices
     */
    getRecommendedConfig(profile: DeviceProfile): EngineOptimizedConfig {
        const { level, isMobile } = profile;

        switch (level) {
            // 高性能配置——接近桌面端默认值
            case 'high':
                return {
                    targetFPS: 60,
                    resolutionScale: Math.min(HIGH_LEVEL_RESOLUTION_SCALE, this._options.maxResolutionScale),
                    msaaSampleCount: HIGH_LEVEL_MSAA,
                    maxTileCache: Math.min(HIGH_LEVEL_TILE_CACHE, this._options.maxTileCache),
                    maxWorkers: Math.min(HIGH_LEVEL_MAX_WORKERS, this._options.maxWorkers),
                    maxDrawCalls: HIGH_LEVEL_MAX_DRAW_CALLS,
                    maxTriangles: HIGH_LEVEL_MAX_TRIANGLES,
                    sseThreshold: HIGH_LEVEL_SSE_THRESHOLD,
                    enablePostProcess: true,
                    enableAtmosphere: true,
                    enableShadows: true,
                    enableLabelCollision: true,
                    touchOptimization: this._options.touchOptimization && isMobile,
                    powerPreference: 'high-performance',
                };

            // 中性能配置——关闭部分高级特效
            case 'medium':
                return {
                    targetFPS: 60,
                    resolutionScale: Math.min(MEDIUM_LEVEL_RESOLUTION_SCALE, this._options.maxResolutionScale),
                    msaaSampleCount: MEDIUM_LEVEL_MSAA,
                    maxTileCache: Math.min(MEDIUM_LEVEL_TILE_CACHE, this._options.maxTileCache),
                    maxWorkers: Math.min(MEDIUM_LEVEL_MAX_WORKERS, this._options.maxWorkers),
                    maxDrawCalls: MEDIUM_LEVEL_MAX_DRAW_CALLS,
                    maxTriangles: MEDIUM_LEVEL_MAX_TRIANGLES,
                    sseThreshold: MEDIUM_LEVEL_SSE_THRESHOLD,
                    enablePostProcess: false,
                    enableAtmosphere: true,
                    enableShadows: false,
                    enableLabelCollision: true,
                    touchOptimization: this._options.touchOptimization && isMobile,
                    powerPreference: 'high-performance',
                };

            // 低性能配置——最激进的降级策略
            case 'low':
            default:
                return {
                    targetFPS: 30,
                    resolutionScale: Math.min(LOW_LEVEL_RESOLUTION_SCALE, this._options.maxResolutionScale),
                    msaaSampleCount: LOW_LEVEL_MSAA,
                    maxTileCache: Math.min(LOW_LEVEL_TILE_CACHE, this._options.maxTileCache),
                    maxWorkers: Math.min(LOW_LEVEL_MAX_WORKERS, this._options.maxWorkers),
                    maxDrawCalls: LOW_LEVEL_MAX_DRAW_CALLS,
                    maxTriangles: LOW_LEVEL_MAX_TRIANGLES,
                    sseThreshold: LOW_LEVEL_SSE_THRESHOLD,
                    enablePostProcess: false,
                    enableAtmosphere: false,
                    enableShadows: false,
                    enableLabelCollision: false,
                    touchOptimization: this._options.touchOptimization && isMobile,
                    powerPreference: 'high-performance',
                };
        }
    }
}
