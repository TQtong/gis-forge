// ============================================================
// globe/skybox.ts — 星空天穹渲染器
// 生成随机恒星位置并渲染为点状星空背景。
// 导出 createSkyboxRenderer 工厂函数。
// 依赖层级：L4 场景层组件，消费 L0 数学工具。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * 默认恒星数量。
 * 肉眼可见恒星约 9000 颗，此处取可接受的渲染密度。
 */
const DEFAULT_STAR_COUNT = 8000;

/**
 * 最小恒星数量下限。
 */
const MIN_STAR_COUNT = 100;

/**
 * 最大恒星数量上限（性能保护）。
 */
const MAX_STAR_COUNT = 50000;

/**
 * 天穹球半径（相对单位，大于大气层即可）。
 * 用于将恒星放置在远处球面上。
 */
const CELESTIAL_SPHERE_RADIUS = 1e7;

/**
 * 2π 常量。
 */
const TWO_PI = 2 * Math.PI;

/**
 * 恒星亮度最小值（归一化 [0, 1]）。
 */
const BRIGHTNESS_MIN = 0.3;

/**
 * 恒星亮度范围（最大 - 最小）。
 */
const BRIGHTNESS_RANGE = 0.7;

/**
 * 每颗恒星的数据分量数：x, y, z, brightness, r, g, b。
 */
const COMPONENTS_PER_STAR = 7;

// ===================== 类型接口 =====================

/**
 * 星空渲染器构造选项。
 */
export interface SkyboxRendererOptions {
    /** 恒星数量，默认 8000。 */
    readonly starCount?: number;

    /** 随机种子（用于可复现的星空），默认 42。 */
    readonly seed?: number;

    /** 初始天穹旋转（弧度，绕 Y 轴），默认 0。 */
    readonly rotation?: number;
}

/**
 * 渲染上下文。
 */
export interface SkyboxRenderContext {
    /** 视图投影矩阵（Float32Array[16]，列主序）。 */
    readonly viewProjectionMatrix: Float32Array;

    /** 视口宽度（像素）。 */
    readonly viewportWidth: number;

    /** 视口高度（像素）。 */
    readonly viewportHeight: number;
}

/**
 * 星空渲染器公共接口。
 */
export interface SkyboxRenderer {
    /**
     * 渲染星空背景（每帧调用）。
     *
     * @param ctx - 渲染上下文
     */
    render(ctx: SkyboxRenderContext): void;

    /**
     * 更改恒星数量并重新生成星空数据。
     *
     * @param count - 新的恒星数量
     */
    setStarCount(count: number): void;

    /**
     * 设置天穹旋转角度（弧度，绕 Y 轴）。
     *
     * @param radians - 旋转角度
     */
    setRotation(radians: number): void;

    /**
     * 获取当前恒星位置 + 颜色数据（用于 GPU 上传）。
     *
     * @returns { positions, count } 每颗恒星 7 个 float (x,y,z, brightness, r,g,b)
     */
    getStarData(): { data: Float32Array; count: number };

    /**
     * 释放内部资源。
     */
    destroy(): void;
}

// ===================== 伪随机数生成器（可复现） =====================

/**
 * 基于 Mulberry32 的简单 PRNG。
 * 给定种子可生成可复现的随机序列。
 *
 * @param seed - 32 位整数种子
 * @returns 返回 [0,1) 浮点的函数
 */
function createPRNG(seed: number): () => number {
    let state = seed | 0;

    return (): number => {
        // Mulberry32 算法
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 生成球面上均匀分布的恒星位置与属性。
 * 使用球面均匀采样（纬度 = acos(1 - 2u)，经度 = 2πv）。
 *
 * @param count - 恒星数量
 * @param seed - 随机种子
 * @returns Float32Array，每 COMPONENTS_PER_STAR 个分量描述一颗恒星
 */
function generateStarfield(count: number, seed: number): Float32Array {
    const rand = createPRNG(seed);
    const data = new Float32Array(count * COMPONENTS_PER_STAR);

    for (let i = 0; i < count; i++) {
        const offset = i * COMPONENTS_PER_STAR;

        // 球面均匀采样
        const u = rand();
        const v = rand();
        const theta = Math.acos(1 - 2 * u);
        const phi = TWO_PI * v;

        // 球面→笛卡尔
        const sinTheta = Math.sin(theta);
        const x = CELESTIAL_SPHERE_RADIUS * sinTheta * Math.cos(phi);
        const y = CELESTIAL_SPHERE_RADIUS * Math.cos(theta);
        const z = CELESTIAL_SPHERE_RADIUS * sinTheta * Math.sin(phi);

        data[offset + 0] = x;
        data[offset + 1] = y;
        data[offset + 2] = z;

        // 亮度：模拟恒星视等级分布（偏暗的更多）
        const rawBrightness = rand();
        // 使用幂函数让大多数恒星偏暗
        data[offset + 3] = BRIGHTNESS_MIN + BRIGHTNESS_RANGE * rawBrightness * rawBrightness;

        // 颜色：模拟光谱类型
        // 大多数恒星偏白，少量蓝/黄/红
        const colorRoll = rand();
        if (colorRoll < 0.05) {
            // O/B 型蓝白星（5%）
            data[offset + 4] = 0.7;
            data[offset + 5] = 0.8;
            data[offset + 6] = 1.0;
        } else if (colorRoll < 0.15) {
            // K/M 型红/橙星（10%）
            data[offset + 4] = 1.0;
            data[offset + 5] = 0.8;
            data[offset + 6] = 0.6;
        } else if (colorRoll < 0.30) {
            // G 型黄星（15%）
            data[offset + 4] = 1.0;
            data[offset + 5] = 0.95;
            data[offset + 6] = 0.85;
        } else {
            // A/F 型白星（70%）
            data[offset + 4] = 1.0;
            data[offset + 5] = 1.0;
            data[offset + 6] = 1.0;
        }
    }

    return data;
}

// ===================== 工厂函数 =====================

/**
 * 创建星空天穹渲染器。
 * 生成随机恒星位置并提供每帧渲染接口。
 *
 * @param options - 恒星数量、种子、旋转
 * @returns SkyboxRenderer 实例
 *
 * @stability experimental
 *
 * @example
 * const sky = createSkyboxRenderer({ starCount: 10000 });
 * sky.setRotation(Math.PI / 4);
 * sky.render(ctx);
 */
export function createSkyboxRenderer(
    options?: SkyboxRendererOptions,
): SkyboxRenderer {
    let starCount = Math.max(
        MIN_STAR_COUNT,
        Math.min(options?.starCount ?? DEFAULT_STAR_COUNT, MAX_STAR_COUNT),
    );
    const seed = options?.seed ?? 42;
    let rotation = options?.rotation ?? 0;
    let destroyed = false;

    // 生成初始星空数据
    let starData = generateStarfield(starCount, seed);

    /**
     * 将旋转应用到恒星位置（绕 Y 轴）。
     * 返回旋转后的数据副本。
     *
     * @param srcData - 原始星空数据
     * @param angle - 旋转弧度
     * @returns 旋转后的数据
     */
    function applyRotation(srcData: Float32Array, angle: number): Float32Array {
        if (Math.abs(angle) < 1e-9) {
            return srcData;
        }
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const result = new Float32Array(srcData.length);

        const count = srcData.length / COMPONENTS_PER_STAR;
        for (let i = 0; i < count; i++) {
            const off = i * COMPONENTS_PER_STAR;
            const x = srcData[off + 0];
            const z = srcData[off + 2];
            // 绕 Y 轴旋转：x' = x·cosA + z·sinA, z' = -x·sinA + z·cosA
            result[off + 0] = x * cosA + z * sinA;
            result[off + 1] = srcData[off + 1];
            result[off + 2] = -x * sinA + z * cosA;
            // 亮度和颜色不变
            result[off + 3] = srcData[off + 3];
            result[off + 4] = srcData[off + 4];
            result[off + 5] = srcData[off + 5];
            result[off + 6] = srcData[off + 6];
        }

        return result;
    }

    return {
        /**
         * 渲染星空。
         * MVP 实现：准备旋转后的恒星数据（不实际提交 GPU 指令）。
         *
         * @param ctx - 渲染上下文
         */
        render(ctx: SkyboxRenderContext): void {
            if (destroyed) {
                return;
            }
            // 准备旋转后数据供 GPU 上传
            const _rotatedData = applyRotation(starData, rotation);

            if (__DEV__) {
                void ctx;
                void _rotatedData;
            }
        },

        /**
         * 更改恒星数量，重新生成。
         *
         * @param count - 新数量
         */
        setStarCount(count: number): void {
            if (!Number.isFinite(count)) {
                return;
            }
            starCount = Math.max(MIN_STAR_COUNT, Math.min(Math.floor(count), MAX_STAR_COUNT));
            starData = generateStarfield(starCount, seed);
        },

        /**
         * 设置天穹旋转。
         *
         * @param radians - 弧度
         */
        setRotation(radians: number): void {
            if (!Number.isFinite(radians)) {
                return;
            }
            rotation = radians;
        },

        /**
         * 获取恒星数据。
         *
         * @returns 数据与恒星数
         */
        getStarData(): { data: Float32Array; count: number } {
            return {
                data: applyRotation(starData, rotation),
                count: starCount,
            };
        },

        /**
         * 释放资源。
         */
        destroy(): void {
            destroyed = true;
        },
    };
}
