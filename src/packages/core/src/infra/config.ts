// ============================================================
// infra/config.ts — 引擎全局配置（自研实现）
// 定义 GeoForge 引擎的所有可配置参数及其合理默认值。
// 提供配置创建和合并工具函数。
// 零外部依赖。
// ============================================================

import type { LogLevel } from './logger.ts';

// ======================== 常量定义 ========================

/** 默认 GPU 内存预算（256 MB），适合大多数中端 GPU */
const DEFAULT_GPU_MEMORY_BUDGET = 256 * 1024 * 1024;

/** 默认 CPU 内存预算（512 MB），用于 Worker 缓存、瓦片缓存等 */
const DEFAULT_CPU_MEMORY_BUDGET = 512 * 1024 * 1024;

/** 默认瓦片大小（512 像素），WebGPU 友好的 2 的幂次 */
const DEFAULT_TILE_SIZE = 512;

/** 默认最大瓦片缓存数量（500 个瓦片） */
const DEFAULT_MAX_TILE_CACHE = 500;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

// ======================== 类型定义 ========================

/**
 * GeoForge 引擎全局配置接口。
 * 所有字段都有合理的默认值，使用者只需覆盖需要修改的部分。
 *
 * @example
 * const config = mergeConfig(createDefaultConfig(), {
 *   maxWorkers: 8,
 *   logLevel: 'debug',
 * });
 */
export interface EngineConfig {
    /**
     * 设备像素比（DPR）。
     * 控制渲染分辨率：physicalWidth = logicalWidth × DPR。
     * 设为 1 可降低渲染分辨率提升性能（移动端常用策略）。
     * 默认值：取 window.devicePixelRatio 或 1。
     * 有效范围：[0.5, 4]
     */
    readonly devicePixelRatio: number;

    /**
     * 最大 Worker 线程数。
     * Worker 用于 CPU 密集任务（MVT 解码、earcut 三角剖分、宽线生成等）。
     * 设太大会抢占主线程资源，设太小会导致 Worker 队列积压。
     * 默认值：Math.max(2, navigator.hardwareConcurrency - 2) 或 4。
     * 有效范围：[1, 32]
     */
    readonly maxWorkers: number;

    /**
     * GPU 内存预算（字节）。
     * 超出预算时触发 LRU 淘汰：不可见瓦片 → 远处瓦片 → 纹理 > Buffer > Pipeline。
     * 默认值：256 MB。
     * 有效范围：[32MB, 4GB]
     */
    readonly gpuMemoryBudget: number;

    /**
     * CPU 内存预算（字节）。
     * 包括 Worker 端缓存、瓦片解码缓冲区、GeoJSON 数据等。
     * 默认值：512 MB。
     * 有效范围：[64MB, 8GB]
     */
    readonly cpuMemoryBudget: number;

    /**
     * 瓦片大小（像素）。
     * 影响瓦片请求粒度和 GPU 纹理大小。512 是 WebGPU 友好的默认值。
     * 矢量瓦片通常使用 512，栅格瓦片可能使用 256。
     * 默认值：512。
     * 有效范围：[128, 1024]，必须是 2 的幂
     */
    readonly tileSize: number;

    /**
     * 最大瓦片缓存数量。
     * 缓存已加载的瓦片数据，避免重复请求。
     * LRU 策略淘汰最久未使用的瓦片。
     * 默认值：500。
     * 有效范围：[50, 10000]
     */
    readonly maxTileCacheSize: number;

    /**
     * 日志级别。
     * 控制控制台输出的日志量。
     * 默认值：'warn'（只显示警告和错误）。
     */
    readonly logLevel: LogLevel;

    /**
     * 是否启用多重采样抗锯齿（MSAA）。
     * 启用后使用 4x MSAA（WebGPU 标准值），
     * 会增加约 4 倍的帧缓冲内存消耗。
     * 默认值：true。
     */
    readonly antialias: boolean;

    /**
     * 最大缩放级别。
     * 限制用户可以放大到的最大级别，超过此级别使用过采样。
     * 默认值：22。
     * 有效范围：[0, 30]
     */
    readonly maxZoom: number;

    /**
     * 最小缩放级别。
     * 限制用户可以缩小到的最小级别。
     * 默认值：0。
     * 有效范围：[0, maxZoom]
     */
    readonly minZoom: number;

    /**
     * GPU 电源偏好。
     * 'high-performance' 优先选择独立显卡（桌面端推荐），
     * 'low-power' 优先选择集成显卡（移动端推荐以节省电量）。
     * 默认值：'high-performance'。
     */
    readonly powerPreference: 'high-performance' | 'low-power';

    /**
     * 是否启用 Reversed-Z 深度缓冲。
     * Reversed-Z 将近平面映射到 1.0、远平面映射到 0.0，
     * 大幅改善远处物体的深度精度。GeoForge 强制启用。
     * 默认值：true（不建议关闭）。
     */
    readonly reversedZ: boolean;

    /**
     * 渲染分辨率缩放因子。
     * 1.0 = 完整分辨率，0.5 = 半分辨率（4 倍性能提升）。
     * 用于移动端或性能受限设备的自适应降质。
     * 默认值：1.0。
     * 有效范围：[0.25, 2.0]
     */
    readonly renderScale: number;
}

// ======================== 公共 API ========================

/**
 * 创建具有合理默认值的引擎配置。
 * 默认值针对中端桌面设备优化。
 * 移动端建议降低 devicePixelRatio、gpuMemoryBudget，增大 maxWorkers。
 *
 * @returns 完整的默认配置对象
 *
 * @example
 * const config = createDefaultConfig();
 * // config.maxWorkers === 4
 * // config.tileSize === 512
 * // config.logLevel === 'warn'
 */
export function createDefaultConfig(): EngineConfig {
    // 检测默认 Worker 数：使用 navigator.hardwareConcurrency 减 2（留给主线程和合成线程）
    let defaultWorkers = 4;
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
        defaultWorkers = Math.max(2, Math.min(navigator.hardwareConcurrency - 2, 16));
    }

    // 检测默认 DPR
    let defaultDPR = 1;
    if (typeof window !== 'undefined' && window.devicePixelRatio) {
        defaultDPR = Math.min(window.devicePixelRatio, 4);
    }

    return {
        devicePixelRatio: defaultDPR,
        maxWorkers: defaultWorkers,
        gpuMemoryBudget: DEFAULT_GPU_MEMORY_BUDGET,
        cpuMemoryBudget: DEFAULT_CPU_MEMORY_BUDGET,
        tileSize: DEFAULT_TILE_SIZE,
        maxTileCacheSize: DEFAULT_MAX_TILE_CACHE,
        logLevel: 'warn',
        antialias: true,
        maxZoom: DEFAULT_MAX_ZOOM,
        minZoom: DEFAULT_MIN_ZOOM,
        powerPreference: 'high-performance',
        reversedZ: true,
        renderScale: 1.0,
    };
}

/**
 * 合并基础配置和用户覆盖配置。
 * 用户只需提供想修改的字段，其余使用基础配置的值。
 * 会对关键字段进行范围校验和修正。
 *
 * @param base - 基础配置（通常由 createDefaultConfig() 创建）
 * @param overrides - 用户覆盖配置（Partial，所有字段可选）
 * @returns 合并后的完整配置
 *
 * @example
 * const config = mergeConfig(createDefaultConfig(), {
 *   maxWorkers: 8,
 *   logLevel: 'debug',
 *   devicePixelRatio: 2,
 * });
 */
export function mergeConfig(
    base: EngineConfig,
    overrides: Partial<EngineConfig>,
): EngineConfig {
    // 合并所有字段——overrides 中的非 undefined 值覆盖 base
    const merged = { ...base, ...overrides };

    // ---- 范围校验和修正 ----

    // DPR 限制在 [0.5, 4]
    const dpr = merged.devicePixelRatio;
    if (!Number.isFinite(dpr) || dpr < 0.5) {
        (merged as Record<string, unknown>).devicePixelRatio = 0.5;
    } else if (dpr > 4) {
        (merged as Record<string, unknown>).devicePixelRatio = 4;
    }

    // Worker 数量限制在 [1, 32]
    const workers = merged.maxWorkers;
    if (!Number.isFinite(workers) || workers < 1) {
        (merged as Record<string, unknown>).maxWorkers = 1;
    } else if (workers > 32) {
        (merged as Record<string, unknown>).maxWorkers = 32;
    } else {
        (merged as Record<string, unknown>).maxWorkers = Math.floor(workers);
    }

    // GPU 内存预算限制在 [32MB, 4GB]
    const gpuBudget = merged.gpuMemoryBudget;
    if (!Number.isFinite(gpuBudget) || gpuBudget < 32 * 1024 * 1024) {
        (merged as Record<string, unknown>).gpuMemoryBudget = 32 * 1024 * 1024;
    } else if (gpuBudget > 4 * 1024 * 1024 * 1024) {
        (merged as Record<string, unknown>).gpuMemoryBudget = 4 * 1024 * 1024 * 1024;
    }

    // CPU 内存预算限制在 [64MB, 8GB]
    const cpuBudget = merged.cpuMemoryBudget;
    if (!Number.isFinite(cpuBudget) || cpuBudget < 64 * 1024 * 1024) {
        (merged as Record<string, unknown>).cpuMemoryBudget = 64 * 1024 * 1024;
    } else if (cpuBudget > 8 * 1024 * 1024 * 1024) {
        (merged as Record<string, unknown>).cpuMemoryBudget = 8 * 1024 * 1024 * 1024;
    }

    // 瓦片大小必须是 2 的幂，在 [128, 1024] 范围内
    const ts = merged.tileSize;
    if (!Number.isFinite(ts) || ts < 128) {
        (merged as Record<string, unknown>).tileSize = 128;
    } else if (ts > 1024) {
        (merged as Record<string, unknown>).tileSize = 1024;
    } else {
        // 向上取整到最近的 2 的幂
        const log2 = Math.ceil(Math.log2(ts));
        (merged as Record<string, unknown>).tileSize = Math.pow(2, log2);
    }

    // 瓦片缓存数量限制在 [50, 10000]
    const cache = merged.maxTileCacheSize;
    if (!Number.isFinite(cache) || cache < 50) {
        (merged as Record<string, unknown>).maxTileCacheSize = 50;
    } else if (cache > 10000) {
        (merged as Record<string, unknown>).maxTileCacheSize = 10000;
    } else {
        (merged as Record<string, unknown>).maxTileCacheSize = Math.floor(cache);
    }

    // 缩放级别范围校验
    let minZ = merged.minZoom;
    let maxZ = merged.maxZoom;
    if (!Number.isFinite(minZ) || minZ < 0) minZ = 0;
    if (!Number.isFinite(maxZ) || maxZ > 30) maxZ = 30;
    if (minZ > maxZ) minZ = maxZ;
    (merged as Record<string, unknown>).minZoom = minZ;
    (merged as Record<string, unknown>).maxZoom = maxZ;

    // 渲染缩放限制在 [0.25, 2.0]
    const rs = merged.renderScale;
    if (!Number.isFinite(rs) || rs < 0.25) {
        (merged as Record<string, unknown>).renderScale = 0.25;
    } else if (rs > 2.0) {
        (merged as Record<string, unknown>).renderScale = 2.0;
    }

    return merged;
}
