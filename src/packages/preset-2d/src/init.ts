// ============================================================
// @geoforge/preset-2d — 引擎初始化编排器
// L0→L1→L2→L3→L4→L5 按层初始化全部管理器。
// 导出 initializeEngine(canvas, config) 工厂函数，返回 EngineContext。
// 依赖层级：L6 预设层，消费 L0~L5 各包的工厂/管理器接口。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 默认最大 GPU 内存预算（字节），256 MB。 */
const DEFAULT_GPU_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

/** 默认 Worker 线程数量上限。 */
const DEFAULT_WORKER_COUNT = 4;

/** 默认请求队列并发度。 */
const DEFAULT_REQUEST_CONCURRENCY = 6;

/** 默认目标帧率（FPS）。 */
const DEFAULT_TARGET_FPS = 60;

/** 默认 GPU 帧时间预算（毫秒），对应 60FPS 的 GPU 部分。 */
const DEFAULT_MAX_GPU_TIME_MS = 12;

/** 默认 JS 帧时间预算（毫秒）。 */
const DEFAULT_MAX_JS_TIME_MS = 4;

// ===================== 配置接口 =====================

/**
 * 引擎初始化配置。
 */
export interface EngineConfig {
    /** GPU 电源偏好。 */
    readonly powerPreference?: GPUPowerPreference;

    /** GPU 内存预算（字节），默认 256MB。 */
    readonly gpuMemoryBudget?: number;

    /** Worker 线程数上限，默认 4。 */
    readonly workerCount?: number;

    /** 请求队列并发度，默认 6。 */
    readonly requestConcurrency?: number;

    /** 目标帧率（FPS），默认 60。 */
    readonly targetFPS?: number;

    /** 最大 GPU 帧时间（毫秒），默认 12。 */
    readonly maxGPUTimeMs?: number;

    /** 最大 JS 帧时间（毫秒），默认 4。 */
    readonly maxJSTimeMs?: number;

    /** 是否开启抗锯齿（MSAA 4x），默认 true。 */
    readonly antialias?: boolean;

    /** 投影名称（MVP 占位），默认 'web-mercator'。 */
    readonly projection?: string;
}

// ===================== 层占位句柄接口 =====================

/**
 * L0 基础层句柄：数学/类型/基础设施模块引用（无有状态资源）。
 */
export interface L0Handle {
    /** L0 已就绪标记。 */
    readonly ready: true;
}

/**
 * L1 GPU 层句柄：Device、BufferPool、TextureManager 等。
 */
export interface L1Handle {
    /** 底层 GPUDevice 引用（不可直接使用，仅调试用途）。 */
    readonly device: GPUDevice;

    /** 释放 L1 全部 GPU 资源。 */
    destroy(): void;
}

/**
 * L2 渲染层句柄：ShaderAssembler、PipelineCache、RenderGraph 等。
 */
export interface L2Handle {
    /** 是否已就绪（Pipeline 缓存预热完成后为 true）。 */
    readonly ready: boolean;

    /** 释放 L2 渲染资源。 */
    destroy(): void;
}

/**
 * L3 调度层句柄：FrameScheduler、TileScheduler、WorkerPool 等。
 */
export interface L3Handle {
    /** 启动帧循环。 */
    start(): void;

    /** 停止帧循环。 */
    stop(): void;

    /** 释放 L3 资源（终止 Worker 等）。 */
    destroy(): void;
}

/**
 * L4 场景层句柄：SceneGraph、LayerManager、SourceManager 等。
 */
export interface L4Handle {
    /** 释放 L4 场景资源。 */
    destroy(): void;
}

/**
 * L5 扩展层句柄：ExtensionRegistry、Lifecycle。
 */
export interface L5Handle {
    /** 释放 L5 扩展资源。 */
    destroy(): void;
}

// ===================== 引擎上下文 =====================

/**
 * 引擎初始化完成后返回的上下文对象。
 * 持有 L0~L5 各层句柄，供 L6 Map2D / Map25D / Globe3D 使用。
 */
export interface EngineContext {
    /** 基础层句柄。 */
    readonly l0: L0Handle;

    /** GPU 层句柄。 */
    readonly l1: L1Handle;

    /** 渲染层句柄。 */
    readonly l2: L2Handle;

    /** 调度层句柄。 */
    readonly l3: L3Handle;

    /** 场景层句柄。 */
    readonly l4: L4Handle;

    /** 扩展层句柄。 */
    readonly l5: L5Handle;

    /** 画布引用。 */
    readonly canvas: HTMLCanvasElement;

    /**
     * 销毁所有层资源（按逆序 L5→L0）。
     */
    destroy(): void;
}

// ===================== 初始化步骤函数 =====================

/**
 * 初始化 L0 基础层：数学常量/类型注册/基础设施引导。
 * L0 纯模块，无有状态资源需要初始化，此处仅做标记。
 *
 * @returns L0 句柄
 */
function initL0(): L0Handle {
    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] L0 基础层就绪');
    }
    return { ready: true };
}

/**
 * 初始化 L1 GPU 层：请求 Adapter→创建 Device→初始化 BufferPool / TextureManager / BindGroupCache 等。
 *
 * @param canvas - 渲染目标 canvas
 * @param config - 引擎配置
 * @returns L1 句柄（异步：需要 requestAdapter / requestDevice）
 */
async function initL1(
    canvas: HTMLCanvasElement,
    config: EngineConfig,
): Promise<L1Handle> {
    // 检查 WebGPU 可用性
    if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
        throw new Error('[GeoForge L1] WebGPU 不可用：navigator.gpu 未定义');
    }

    // 请求 GPU 适配器
    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: config.powerPreference ?? 'high-performance',
    });
    if (adapter === null) {
        throw new Error('[GeoForge L1] 无法获取 GPU Adapter');
    }

    // 请求 GPU Device
    const device = await adapter.requestDevice({
        requiredFeatures: [],
        requiredLimits: {},
    });

    // 配置 Canvas Surface
    const ctx = canvas.getContext('webgpu');
    if (ctx === null) {
        throw new Error('[GeoForge L1] 无法获取 WebGPU 上下文');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
        device,
        format,
        alphaMode: 'premultiplied',
    });

    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] L1 GPU 层就绪', {
            adapterInfo: adapter.info,
            format,
        });
    }

    // 监听 Device Lost 以便 L3 ErrorRecovery 捕获
    device.lost.then((info) => {
        if (__DEV__) {
            // eslint-disable-next-line no-console
            console.error('[GeoForge L1] Device Lost:', info.message, info.reason);
        }
    });

    return {
        device,
        destroy(): void {
            device.destroy();
        },
    };
}

/**
 * 初始化 L2 渲染层：ShaderAssembler / PipelineCache / DepthManager / RenderGraph 等。
 *
 * @param l1 - L1 句柄
 * @param _config - 引擎配置
 * @returns L2 句柄
 */
function initL2(l1: L1Handle, _config: EngineConfig): L2Handle {
    // MVP：记录 Device 引用，Pipeline 缓存预热标记
    const _device = l1.device;
    let ready = false;

    // 模拟异步预热完成（实际实现会预编译常用 Shader 变体）
    queueMicrotask(() => {
        ready = true;
        if (__DEV__) {
            // eslint-disable-next-line no-console
            console.debug('[GeoForge] L2 渲染层就绪');
        }
    });

    return {
        get ready(): boolean {
            return ready;
        },
        destroy(): void {
            ready = false;
        },
    };
}

/**
 * 初始化 L3 调度层：FrameScheduler / TileScheduler / WorkerPool / ResourceManager 等。
 *
 * @param _l2 - L2 句柄
 * @param config - 引擎配置
 * @returns L3 句柄
 */
function initL3(_l2: L2Handle, config: EngineConfig): L3Handle {
    const _workerCount = config.workerCount ?? DEFAULT_WORKER_COUNT;
    const _concurrency = config.requestConcurrency ?? DEFAULT_REQUEST_CONCURRENCY;
    const _targetFPS = config.targetFPS ?? DEFAULT_TARGET_FPS;
    let running = false;
    let rafId: number | null = null;

    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] L3 调度层就绪', {
            workerCount: _workerCount,
            requestConcurrency: _concurrency,
            targetFPS: _targetFPS,
        });
    }

    return {
        start(): void {
            if (running) {
                return;
            }
            running = true;
            // MVP 帧循环占位：后续接入真实 FrameScheduler
            const tick = (): void => {
                if (!running) {
                    return;
                }
                // 帧循环：UPDATE → RENDER → POST → IDLE
                rafId = requestAnimationFrame(tick);
            };
            rafId = requestAnimationFrame(tick);
        },
        stop(): void {
            running = false;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        },
        destroy(): void {
            this.stop();
        },
    };
}

/**
 * 初始化 L4 场景层：SceneGraph / LayerManager / SourceManager / StyleEngine 等。
 *
 * @param _l3 - L3 句柄
 * @param _config - 引擎配置
 * @returns L4 句柄
 */
function initL4(_l3: L3Handle, _config: EngineConfig): L4Handle {
    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] L4 场景层就绪');
    }
    return {
        destroy(): void {
            // 释放场景图、图层管理器等资源
        },
    };
}

/**
 * 初始化 L5 扩展层：ExtensionRegistry / Lifecycle / 内置投影与交互。
 *
 * @param _l4 - L4 句柄
 * @param _config - 引擎配置
 * @returns L5 句柄
 */
function initL5(_l4: L4Handle, _config: EngineConfig): L5Handle {
    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] L5 扩展层就绪');
    }
    return {
        destroy(): void {
            // 注销所有扩展
        },
    };
}

// ===================== 公共工厂函数 =====================

/**
 * 引擎初始化编排：按 L0→L1→L2→L3→L4→L5 顺序创建所有管理器。
 *
 * @param canvas - 渲染目标 canvas 元素
 * @param config - 引擎配置（可选，均有合理默认值）
 * @returns 引擎上下文 Promise（L1 需要异步请求 GPU Device）
 *
 * @stability experimental
 *
 * @example
 * const canvas = document.querySelector('canvas')!;
 * const engine = await initializeEngine(canvas, { powerPreference: 'high-performance' });
 * engine.l3.start();
 */
export async function initializeEngine(
    canvas: HTMLCanvasElement,
    config: EngineConfig = {},
): Promise<EngineContext> {
    // 参数校验
    if (canvas === null || canvas === undefined) {
        throw new Error('[GeoForge] initializeEngine: canvas 不能为 null');
    }
    if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('[GeoForge] initializeEngine: canvas 必须是 HTMLCanvasElement');
    }

    // L0 — 纯模块，无异步
    const l0 = initL0();

    // L1 — 异步：需要 requestAdapter / requestDevice
    const l1 = await initL1(canvas, config);

    // L2 — 同步初始化（内部 microtask 预热）
    const l2 = initL2(l1, config);

    // L3 — 同步初始化
    const l3 = initL3(l2, config);

    // L4 — 同步初始化
    const l4 = initL4(l3, config);

    // L5 — 同步初始化
    const l5 = initL5(l4, config);

    if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[GeoForge] 引擎初始化完成 ✓');
    }

    return {
        l0,
        l1,
        l2,
        l3,
        l4,
        l5,
        canvas,

        /**
         * 销毁全部层资源（逆序：L5→L4→L3→L2→L1→L0）。
         */
        destroy(): void {
            l5.destroy();
            l4.destroy();
            l3.destroy();
            l2.destroy();
            l1.destroy();
            // L0 无需销毁
            if (__DEV__) {
                // eslint-disable-next-line no-console
                console.debug('[GeoForge] 引擎已销毁');
            }
        },
    };
}
