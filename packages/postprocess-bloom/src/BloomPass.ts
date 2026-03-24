// ============================================================
// postprocess-bloom/src/BloomPass.ts — 泛光（Bloom）后处理 Pass
// 将场景中高亮区域提取、模糊、叠加回原图以产生光晕效果。
// MVP 实现：纯 CPU Float32Array 像素缓冲区，便于无 WebGPU 环境验证算法。
//
// 所属层级：L2（渲染层 — 后处理子系统）
// 依赖：仅 L0 Viewport 类型
// ============================================================

import type { Viewport } from '../../core/src/types/viewport.ts';

/** @stability experimental */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 默认亮度提取阈值。低于此亮度的像素不参与泛光，范围 [0, 2] */
const DEFAULT_THRESHOLD = 0.8;

/** 默认泛光叠加强度，范围 [0, 5]。1.0 为标准强度 */
const DEFAULT_INTENSITY = 1.0;

/** 默认模糊半径缩放因子，范围 [0, 2]。影响模糊纹理的采样步长 */
const DEFAULT_RADIUS = 0.5;

/** 默认高斯模糊迭代次数，范围 [1, 10]。次数越多模糊范围越大 */
const DEFAULT_BLUR_ITERATIONS = 5;

/**
 * 9-tap 高斯模糊权重（对称，中心 + 4 个方向）。
 * 总和 ≈ 1.0（0.227027 + 2×0.1945946 + 2×0.1216216 + 2×0.054054 + 2×0.016216 ≈ 1.0003）。
 * 来源：标准高斯核 σ≈1.5 归一化离散近似。
 */
const GAUSSIAN_WEIGHTS: readonly number[] = [
    0.227027,   // 中心权重
    0.1945946,  // 偏移 ±1 的权重
    0.1216216,  // 偏移 ±2 的权重
    0.054054,   // 偏移 ±3 的权重
    0.016216,   // 偏移 ±4 的权重
];

/**
 * ITU-R BT.709 亮度系数（线性 sRGB）。
 * 用于将 RGB 转换为感知亮度：L = 0.2126R + 0.7152G + 0.0722B。
 */
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;

/** 每像素通道数（RGBA） */
const CHANNELS = 4;

// ===================== 选项接口 =====================

/**
 * BloomPass 配置选项。
 * 所有参数均可选，使用默认值即可获得良好的视觉效果。
 *
 * @example
 * const options: BloomPassOptions = {
 *   threshold: 0.8,
 *   intensity: 1.5,
 *   radius: 0.6,
 *   blurIterations: 5,
 * };
 */
export interface BloomPassOptions {
    /**
     * 亮度提取阈值。
     * 只有亮度（BT.709 luminance）超过此值的像素才会参与泛光计算。
     * 值越低，更多像素被提取（泛光范围越大）；值越高，只有极亮区域才发光。
     * 默认值：0.8，范围 [0, 2]。
     */
    readonly threshold?: number;

    /**
     * 泛光叠加强度。
     * 最终混合时 bloom 贡献的乘数。0 = 无泛光，1 = 标准，>1 = 增强。
     * 默认值：1.0，范围 [0, 5]。
     */
    readonly intensity?: number;

    /**
     * 模糊半径缩放因子。
     * 控制高斯模糊的采样步长（step = radius / blurIterations）。
     * 值越大模糊范围越大。
     * 默认值：0.5，范围 [0, 2]。
     */
    readonly radius?: number;

    /**
     * 高斯模糊迭代次数。
     * 每次迭代执行一次水平 + 一次垂直分离式模糊。
     * 次数越多结果越平滑，但 CPU 开销线性增长。
     * 默认值：5，范围 [1, 10]。
     */
    readonly blurIterations?: number;
}

// ===================== PostProcessPass 接口 =====================

/**
 * 后处理 Pass 通用接口。
 * 定义了后处理管线中每个 Pass 的生命周期方法。
 * MVP 阶段在 CPU 侧 Float32Array 像素缓冲区上执行算法，
 * 后续迁移到 GPU Compute Pass。
 */
interface PostProcessPass {
    /** Pass 唯一标识符，用于在后处理管线中查找和排序 */
    readonly id: string;

    /** 当前是否启用。禁用后 execute() 将直接拷贝输入到输出 */
    readonly enabled: boolean;

    /**
     * 设置启用状态。
     * @param enabled - true 启用泛光效果，false 禁用（直通模式）
     */
    setEnabled(enabled: boolean): void;

    /**
     * 初始化/重新配置 Pass。
     * 在首次使用或视口变化时调用，用于分配内部缓冲区。
     * @param context - 包含视口尺寸的上下文对象
     */
    setup(context: { viewport: { width: number; height: number } }): void;

    /**
     * 执行后处理算法。
     * 从 inputColor 读取场景颜色，将处理后的结果写入 outputColor。
     *
     * @param inputColor - 输入颜色缓冲区，RGBA Float32（每像素 4 个 float，范围 [0,1]）
     * @param inputDepth - 输入深度缓冲区（单通道 Float32），Bloom 不使用，可为 null
     * @param outputColor - 输出颜色缓冲区，RGBA Float32
     * @param width - 缓冲区宽度（像素）
     * @param height - 缓冲区高度（像素）
     */
    execute(
        inputColor: Float32Array,
        inputDepth: Float32Array | null,
        outputColor: Float32Array,
        width: number,
        height: number,
    ): void;

    /**
     * 视口尺寸变化时调用，重新分配内部缓冲区。
     * @param width - 新宽度（像素）
     * @param height - 新高度（像素）
     */
    onResize(width: number, height: number): void;

    /** 释放所有内部资源 */
    destroy(): void;
}

// ===================== BloomPass 实现 =====================

/**
 * 泛光（Bloom）后处理 Pass。
 *
 * 算法流程：
 * 1. **亮度提取**：计算每像素亮度，超过阈值的像素按比例保留到临时缓冲区
 * 2. **可分离高斯模糊**：对提取结果进行多次水平+垂直 9-tap 高斯模糊
 * 3. **合成**：将模糊后的泛光叠加回原始场景颜色
 *
 * MVP 实现在 CPU 端 Float32Array 上执行所有运算，
 * 方便在无 WebGPU 环境下验证算法正确性。
 *
 * @stability experimental
 *
 * @example
 * const bloom = new BloomPass({ threshold: 0.8, intensity: 1.5 });
 * bloom.setup({ viewport: { width: 1920, height: 1080 } });
 * bloom.execute(inputColor, null, outputColor, 1920, 1080);
 */
export class BloomPass implements PostProcessPass {
    /** Pass 唯一标识符 */
    public readonly id: string = 'bloom';

    /** 当前启用状态 */
    public enabled: boolean = true;

    /** 亮度提取阈值，范围 [0, 2] */
    private _threshold: number;

    /** 泛光叠加强度，范围 [0, 5] */
    private _intensity: number;

    /** 模糊半径缩放因子，范围 [0, 2] */
    private _radius: number;

    /** 高斯模糊迭代次数，范围 [1, 10] */
    private _blurIterations: number;

    /** 当前缓冲区宽度（像素） */
    private _width: number = 0;

    /** 当前缓冲区高度（像素） */
    private _height: number = 0;

    /** 亮度提取结果 / 模糊 Ping 缓冲区（RGBA Float32） */
    private _brightBuffer: Float32Array | null = null;

    /** 模糊 Pong 缓冲区（RGBA Float32，用于乒乓交换） */
    private _blurBuffer: Float32Array | null = null;

    /** 资源是否已销毁 */
    private _destroyed: boolean = false;

    /**
     * 创建 BloomPass 实例。
     *
     * @param options - 配置选项（所有参数可选，使用默认值即可获得良好效果）
     *
     * @example
     * const bloom = new BloomPass();
     * const bloom2 = new BloomPass({ threshold: 1.0, intensity: 2.0 });
     */
    constructor(options: BloomPassOptions = {}) {
        // 解构并使用默认值，每个值都做范围钳制
        this._threshold = BloomPass._clamp(
            options.threshold ?? DEFAULT_THRESHOLD,
            0,
            2,
        );
        this._intensity = BloomPass._clamp(
            options.intensity ?? DEFAULT_INTENSITY,
            0,
            5,
        );
        this._radius = BloomPass._clamp(
            options.radius ?? DEFAULT_RADIUS,
            0,
            2,
        );
        this._blurIterations = BloomPass._clamp(
            Math.round(options.blurIterations ?? DEFAULT_BLUR_ITERATIONS),
            1,
            10,
        );

        if (__DEV__) {
            console.debug(
                `[BloomPass] 创建: threshold=${this._threshold}, intensity=${this._intensity}, ` +
                `radius=${this._radius}, blurIterations=${this._blurIterations}`,
            );
        }
    }

    // ===================== 公共 Setter 方法 =====================

    /**
     * 设置亮度提取阈值。
     * 低于阈值的像素不参与泛光，值越低泛光范围越大。
     *
     * @param value - 新阈值，范围 [0, 2]，超出范围自动钳制
     *
     * @example
     * bloom.setThreshold(1.2); // 只有非常亮的区域才产生泛光
     */
    public setThreshold(value: number): void {
        this._threshold = BloomPass._clamp(value, 0, 2);
    }

    /**
     * 设置泛光叠加强度。
     * 0 = 无泛光，1 = 标准，>1 = 增强发光效果。
     *
     * @param value - 新强度，范围 [0, 5]，超出范围自动钳制
     *
     * @example
     * bloom.setIntensity(2.0); // 强泛光效果
     */
    public setIntensity(value: number): void {
        this._intensity = BloomPass._clamp(value, 0, 5);
    }

    /**
     * 设置模糊半径缩放因子。
     * 值越大高斯模糊的采样步长越大，光晕扩散越远。
     *
     * @param value - 新半径缩放因子，范围 [0, 2]，超出范围自动钳制
     *
     * @example
     * bloom.setRadius(1.0); // 较大的模糊半径
     */
    public setRadius(value: number): void {
        this._radius = BloomPass._clamp(value, 0, 2);
    }

    /**
     * 设置高斯模糊迭代次数。
     * 次数越多模糊越平滑，但 CPU 开销线性增长。
     *
     * @param value - 新迭代次数，范围 [1, 10]，超出范围自动钳制，非整数四舍五入
     *
     * @example
     * bloom.setBlurIterations(3); // 减少模糊次数以提升性能
     */
    public setBlurIterations(value: number): void {
        this._blurIterations = BloomPass._clamp(Math.round(value), 1, 10);
    }

    // ===================== PostProcessPass 生命周期方法 =====================

    /**
     * 设置启用状态。
     * 禁用后 execute() 将直接将输入颜色拷贝到输出，跳过泛光计算。
     *
     * @param enabled - true 启用泛光，false 禁用（直通模式）
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * 初始化 Pass，分配内部缓冲区。
     * 首次调用或视口尺寸变化时使用。
     *
     * @param context - 包含视口尺寸的上下文对象
     *
     * @example
     * bloom.setup({ viewport: { width: 1920, height: 1080 } });
     */
    public setup(context: { viewport: { width: number; height: number } }): void {
        // 防止销毁后调用
        if (this._destroyed) {
            if (__DEV__) {
                console.warn('[BloomPass] setup() 在已销毁的实例上调用，操作被忽略');
            }
            return;
        }

        const { width, height } = context.viewport;

        // 验证尺寸有效性
        if (width <= 0 || height <= 0) {
            if (__DEV__) {
                console.warn(`[BloomPass] 无效视口尺寸: ${width}×${height}，跳过 setup`);
            }
            return;
        }

        // 如果尺寸未变化，无需重新分配
        if (width === this._width && height === this._height && this._brightBuffer !== null) {
            return;
        }

        // 更新尺寸并分配 RGBA 缓冲区（每像素 4 个 float）
        this._width = width;
        this._height = height;
        const bufferSize = width * height * CHANNELS;
        this._brightBuffer = new Float32Array(bufferSize);
        this._blurBuffer = new Float32Array(bufferSize);

        if (__DEV__) {
            console.debug(
                `[BloomPass] setup: ${width}×${height}, 缓冲区大小 = ${bufferSize * 4} bytes × 2`,
            );
        }
    }

    /**
     * 执行泛光后处理。
     * 完整流程：亮度提取 → 高斯模糊 → 合成。
     *
     * @param inputColor - 输入场景颜色，RGBA Float32（长度 = width×height×4）
     * @param inputDepth - 输入深度缓冲区（Bloom 不使用，可为 null）
     * @param outputColor - 输出颜色缓冲区，RGBA Float32
     * @param width - 图像宽度（像素）
     * @param height - 图像高度（像素）
     */
    public execute(
        inputColor: Float32Array,
        inputDepth: Float32Array | null,
        outputColor: Float32Array,
        width: number,
        height: number,
    ): void {
        // 销毁检查
        if (this._destroyed) {
            if (__DEV__) {
                console.warn('[BloomPass] execute() 在已销毁的实例上调用');
            }
            return;
        }

        // 禁用时直接拷贝输入到输出（直通模式）
        if (!this.enabled) {
            outputColor.set(inputColor);
            return;
        }

        // 验证缓冲区长度一致性
        const expectedLength = width * height * CHANNELS;
        if (
            inputColor.length < expectedLength ||
            outputColor.length < expectedLength
        ) {
            if (__DEV__) {
                console.warn(
                    `[BloomPass] 缓冲区长度不足: 期望 ${expectedLength}, ` +
                    `inputColor=${inputColor.length}, outputColor=${outputColor.length}`,
                );
            }
            // 尽可能拷贝输入到输出以避免黑屏
            outputColor.set(inputColor.subarray(0, Math.min(inputColor.length, outputColor.length)));
            return;
        }

        // 尺寸变化时重新分配内部缓冲区
        if (width !== this._width || height !== this._height || this._brightBuffer === null) {
            this.setup({ viewport: { width, height } });
        }

        // 安全检查：确保 setup 成功分配了缓冲区
        if (this._brightBuffer === null || this._blurBuffer === null) {
            outputColor.set(inputColor);
            return;
        }

        // === 第 1 步：亮度提取 ===
        this._extractBright(inputColor, this._brightBuffer, width, height);

        // === 第 2 步：可分离高斯模糊（乒乓缓冲） ===
        this._applyBlur(this._brightBuffer, this._blurBuffer, width, height);

        // === 第 3 步：合成（场景 + 泛光 × 强度） ===
        this._composite(inputColor, this._brightBuffer, outputColor, width, height);
    }

    /**
     * 视口尺寸变化时重新分配内部缓冲区。
     *
     * @param width - 新宽度（像素）
     * @param height - 新高度（像素）
     */
    public onResize(width: number, height: number): void {
        this.setup({ viewport: { width, height } });
    }

    /**
     * 释放所有内部资源。
     * 调用后该实例不可再使用。
     */
    public destroy(): void {
        this._brightBuffer = null;
        this._blurBuffer = null;
        this._width = 0;
        this._height = 0;
        this._destroyed = true;

        if (__DEV__) {
            console.debug('[BloomPass] 已销毁');
        }
    }

    // ===================== 私有算法方法 =====================

    /**
     * 亮度提取：从输入颜色缓冲区中提取超过阈值的高亮像素。
     * 计算方法：对每像素的 RGB 计算 BT.709 亮度值，
     * 如果亮度 > threshold，则输出 = color × (luminance - threshold) / luminance；
     * 否则输出黑色（0, 0, 0, 0）。
     *
     * @param input - 输入 RGBA 颜色缓冲区
     * @param output - 输出亮区缓冲区（与 input 相同尺寸）
     * @param width - 图像宽度（像素）
     * @param height - 图像高度（像素）
     */
    private _extractBright(
        input: Float32Array,
        output: Float32Array,
        width: number,
        height: number,
    ): void {
        const threshold = this._threshold;
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            // 计算该像素在缓冲区中的字节偏移（每像素 4 个 float：R, G, B, A）
            const offset = i * CHANNELS;
            const r = input[offset];
            const g = input[offset + 1];
            const b = input[offset + 2];

            // 计算 BT.709 感知亮度
            const luminance = LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b;

            if (luminance > threshold && luminance > 0) {
                // 亮度超过阈值：按超出比例缩放颜色
                // factor = (luminance - threshold) / luminance 使得刚过阈值的像素只保留微弱亮度
                const factor = (luminance - threshold) / luminance;
                output[offset] = r * factor;
                output[offset + 1] = g * factor;
                output[offset + 2] = b * factor;
                output[offset + 3] = input[offset + 3]; // 保留 Alpha
            } else {
                // 亮度不足：输出纯黑透明
                output[offset] = 0;
                output[offset + 1] = 0;
                output[offset + 2] = 0;
                output[offset + 3] = 0;
            }
        }
    }

    /**
     * 对亮度提取结果应用可分离高斯模糊。
     * 使用 9-tap 高斯核（中心 + 左右各 4 个采样点），分离为水平和垂直两趟。
     * 乒乓缓冲技术：每次迭代在两个缓冲区之间交替读写。
     *
     * @param pingBuffer - 初始输入 / 乒缓冲区
     * @param pongBuffer - 乓缓冲区
     * @param width - 图像宽度（像素）
     * @param height - 图像高度（像素）
     */
    private _applyBlur(
        pingBuffer: Float32Array,
        pongBuffer: Float32Array,
        width: number,
        height: number,
    ): void {
        // 计算采样步长：radius 归一化到 [0, blurIterations] 区间
        // 步长 = radius，每次迭代使用该步长乘以 tap 偏移
        const step = this._radius;

        let src = pingBuffer;
        let dst = pongBuffer;

        for (let iter = 0; iter < this._blurIterations; iter++) {
            // 水平模糊 pass：沿 X 轴采样
            this._blurPass(src, dst, width, height, step, true);

            // 交换 src 和 dst
            const temp = src;
            src = dst;
            dst = temp;

            // 垂直模糊 pass：沿 Y 轴采样
            this._blurPass(src, dst, width, height, step, false);

            // 再次交换，确保下一次迭代从最新结果读取
            const temp2 = src;
            src = dst;
            dst = temp2;
        }

        // 确保最终结果在 pingBuffer 中（供后续 composite 使用）
        // 由于每次迭代执行两次 swap（水平后 + 垂直后），
        // 经过偶数次 pass 后 src 指向 pingBuffer
        // 如果结果不在 pingBuffer 中，需要拷贝
        if (src !== pingBuffer) {
            pingBuffer.set(src);
        }
    }

    /**
     * 单方向高斯模糊（水平或垂直）。
     * 9-tap 对称核：中心 + 两侧各 4 个采样点。
     * 边界处理：clamp 到边缘（镜像到最近有效像素）。
     *
     * @param src - 源缓冲区（只读）
     * @param dst - 目标缓冲区（写入）
     * @param width - 图像宽度（像素）
     * @param height - 图像高度（像素）
     * @param step - 采样步长因子
     * @param horizontal - true 为水平模糊，false 为垂直模糊
     */
    private _blurPass(
        src: Float32Array,
        dst: Float32Array,
        width: number,
        height: number,
        step: number,
        horizontal: boolean,
    ): void {
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            // 当前像素的 2D 坐标
            const x = i % width;
            const y = (i - x) / width;
            const dstOffset = i * CHANNELS;

            // 中心权重贡献
            const centerOffset = i * CHANNELS;
            let sumR = src[centerOffset] * GAUSSIAN_WEIGHTS[0];
            let sumG = src[centerOffset + 1] * GAUSSIAN_WEIGHTS[0];
            let sumB = src[centerOffset + 2] * GAUSSIAN_WEIGHTS[0];
            let sumA = src[centerOffset + 3] * GAUSSIAN_WEIGHTS[0];

            // 对称采样：正方向和负方向各 4 个采样点
            for (let tap = 1; tap < GAUSSIAN_WEIGHTS.length; tap++) {
                const weight = GAUSSIAN_WEIGHTS[tap];
                // 采样偏移量 = tap 索引 × 步长因子（四舍五入到像素坐标）
                const offsetPixels = Math.round(tap * Math.max(step, 1));

                let posIdx: number;
                let negIdx: number;

                if (horizontal) {
                    // 水平方向：clamp x 坐标到 [0, width-1]
                    const posX = Math.min(x + offsetPixels, width - 1);
                    const negX = Math.max(x - offsetPixels, 0);
                    posIdx = (y * width + posX) * CHANNELS;
                    negIdx = (y * width + negX) * CHANNELS;
                } else {
                    // 垂直方向：clamp y 坐标到 [0, height-1]
                    const posY = Math.min(y + offsetPixels, height - 1);
                    const negY = Math.max(y - offsetPixels, 0);
                    posIdx = (posY * width + x) * CHANNELS;
                    negIdx = (negY * width + x) * CHANNELS;
                }

                // 累加正方向和负方向的加权颜色
                sumR += (src[posIdx] + src[negIdx]) * weight;
                sumG += (src[posIdx + 1] + src[negIdx + 1]) * weight;
                sumB += (src[posIdx + 2] + src[negIdx + 2]) * weight;
                sumA += (src[posIdx + 3] + src[negIdx + 3]) * weight;
            }

            // 写入目标缓冲区
            dst[dstOffset] = sumR;
            dst[dstOffset + 1] = sumG;
            dst[dstOffset + 2] = sumB;
            dst[dstOffset + 3] = sumA;
        }
    }

    /**
     * 合成阶段：将模糊后的泛光叠加回原始场景。
     * 公式：output = scene + bloom × intensity
     * 结果钳制到 [0, 1] 避免溢出。
     *
     * @param scene - 原始场景颜色缓冲区
     * @param bloom - 模糊后的泛光缓冲区
     * @param output - 合成输出缓冲区
     * @param width - 图像宽度（像素）
     * @param height - 图像高度（像素）
     */
    private _composite(
        scene: Float32Array,
        bloom: Float32Array,
        output: Float32Array,
        width: number,
        height: number,
    ): void {
        const intensity = this._intensity;
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            const offset = i * CHANNELS;

            // 线性叠加：scene + bloom × intensity，每通道独立计算
            const r = scene[offset] + bloom[offset] * intensity;
            const g = scene[offset + 1] + bloom[offset + 1] * intensity;
            const b = scene[offset + 2] + bloom[offset + 2] * intensity;

            // 钳制到 [0, 1] 避免 HDR 溢出
            output[offset] = Math.min(Math.max(r, 0), 1);
            output[offset + 1] = Math.min(Math.max(g, 0), 1);
            output[offset + 2] = Math.min(Math.max(b, 0), 1);

            // Alpha 直接使用场景 Alpha（泛光不影响透明度）
            output[offset + 3] = scene[offset + 3];
        }
    }

    // ===================== 工具方法 =====================

    /**
     * 将数值钳制到 [min, max] 范围内。
     * 处理 NaN 的情况：如果 value 为 NaN，返回 min（安全默认）。
     *
     * @param value - 待钳制的值
     * @param min - 最小值（含）
     * @param max - 最大值（含）
     * @returns 钳制后的值
     */
    private static _clamp(value: number, min: number, max: number): number {
        // NaN 与任何数比较均为 false，此处 NaN 会落入 else 返回 min
        if (value >= min) {
            return value <= max ? value : max;
        }
        return min;
    }
}
