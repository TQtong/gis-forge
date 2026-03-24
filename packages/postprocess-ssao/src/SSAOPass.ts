// ============================================================
// postprocess-ssao/src/SSAOPass.ts — 屏幕空间环境光遮蔽（SSAO）后处理 Pass
// 基于深度缓冲区计算每像素的环境光遮蔽因子，增强场景的空间深度感。
// MVP 实现：纯 CPU Float32Array 像素缓冲区，便于无 WebGPU 环境验证算法。
//
// 所属层级：L2（渲染层 — 后处理子系统）
// 依赖：仅 L0 Viewport 类型
// ============================================================

import type { Viewport } from '../../core/src/types/viewport.ts';

/** @stability experimental */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 默认采样半径（世界空间单位）。控制遮蔽检测范围，范围 [0.01, 5] */
const DEFAULT_RADIUS = 0.5;

/** 默认遮蔽强度。1.0 为标准强度，范围 [0, 5] */
const DEFAULT_INTENSITY = 1.0;

/** 默认深度偏移量（防止自遮蔽伪影），范围 [0, 0.1] */
const DEFAULT_BIAS = 0.025;

/** 默认采样核心大小（半球采样点数），可选 16/32/64 */
const DEFAULT_KERNEL_SIZE = 32;

/** 噪声纹理尺寸（4×4 = 16 个随机旋转向量），用于去带状伪影 */
const NOISE_TEXTURE_SIZE = 4;

/** 每像素通道数（RGBA） */
const CHANNELS = 4;

/** 双边滤波器核大小（5×5），在模糊 AO 结果时保留深度边缘 */
const BILATERAL_KERNEL_SIZE = 5;

/** 双边滤波器核半径（核大小 / 2 向下取整） */
const BILATERAL_HALF_KERNEL = 2;

/** 双边滤波器深度相似性阈值。深度差超过此值的像素权重大幅衰减 */
const BILATERAL_DEPTH_THRESHOLD = 0.05;

// ===================== 选项接口 =====================

/**
 * SSAOPass 配置选项。
 * 所有参数均可选，使用默认值即可获得视觉效果与性能的良好平衡。
 *
 * @example
 * const options: SSAOPassOptions = {
 *   radius: 0.5,
 *   intensity: 1.5,
 *   bias: 0.025,
 *   kernelSize: 32,
 *   blur: true,
 * };
 */
export interface SSAOPassOptions {
    /**
     * 采样半径（归一化空间）。
     * 控制遮蔽检测的范围：值越大检测范围越广，但过大会导致失真。
     * 默认值：0.5，范围 [0.01, 5]。
     */
    readonly radius?: number;

    /**
     * 遮蔽强度。
     * AO 结果的乘数。0 = 无遮蔽效果，1 = 标准，>1 = 强化阴影。
     * 默认值：1.0，范围 [0, 5]。
     */
    readonly intensity?: number;

    /**
     * 深度偏移（Bias）。
     * 防止平面表面自遮蔽产生的带状伪影（acne artifact）。
     * 默认值：0.025，范围 [0, 0.1]。
     */
    readonly bias?: number;

    /**
     * 采样核心大小（半球采样点数量）。
     * 更多采样点 = 更精确的遮蔽估算，但 CPU 开销更高。
     * 仅支持 16、32、64 三个预设值。
     * 默认值：32。
     */
    readonly kernelSize?: 16 | 32 | 64;

    /**
     * 是否对 AO 结果进行双边模糊。
     * true（默认）：5×5 双边滤波器平滑 AO 同时保留深度边缘。
     * false：跳过模糊，AO 结果可能有噪点但更锐利。
     */
    readonly blur?: boolean;
}

// ===================== PostProcessPass 接口 =====================

/**
 * 后处理 Pass 通用接口。
 * 定义了后处理管线中每个 Pass 的生命周期方法。
 * MVP 阶段在 CPU 侧 Float32Array 像素缓冲区上执行算法。
 */
interface PostProcessPass {
    /** Pass 唯一标识符 */
    readonly id: string;

    /** 当前是否启用 */
    readonly enabled: boolean;

    /**
     * 设置启用状态。
     * @param enabled - true 启用 SSAO，false 禁用
     */
    setEnabled(enabled: boolean): void;

    /**
     * 初始化/重新配置 Pass。
     * @param context - 包含视口尺寸的上下文对象
     */
    setup(context: { viewport: { width: number; height: number } }): void;

    /**
     * 执行后处理算法。
     * @param inputColor - 输入颜色缓冲区，RGBA Float32
     * @param inputDepth - 输入深度缓冲区（单通道 Float32），SSAO 必需
     * @param outputColor - 输出颜色缓冲区
     * @param width - 宽度（像素）
     * @param height - 高度（像素）
     */
    execute(
        inputColor: Float32Array,
        inputDepth: Float32Array | null,
        outputColor: Float32Array,
        width: number,
        height: number,
    ): void;

    /**
     * 视口尺寸变化回调。
     * @param width - 新宽度
     * @param height - 新高度
     */
    onResize(width: number, height: number): void;

    /** 释放所有内部资源 */
    destroy(): void;
}

// ===================== SSAOPass 实现 =====================

/**
 * 屏幕空间环境光遮蔽（Screen-Space Ambient Occlusion）后处理 Pass。
 *
 * 算法流程：
 * 1. **采样核生成**：在初始化时生成半球分布的采样向量（加权朝法线方向集中）
 * 2. **噪声纹理生成**：4×4 随机旋转向量，用于随机化采样方向以消除带状伪影
 * 3. **SSAO 计算**：对每像素从深度缓冲区重建位置，
 *    用 TBN 矩阵变换采样点，检查遮蔽关系
 * 4. **双边模糊**：5×5 核保边模糊，消除噪声同时保留深度边缘
 * 5. **合成**：场景颜色 × AO 因子
 *
 * @stability experimental
 *
 * @example
 * const ssao = new SSAOPass({ radius: 0.5, intensity: 1.0, kernelSize: 32 });
 * ssao.setup({ viewport: { width: 1920, height: 1080 } });
 * ssao.execute(inputColor, inputDepth, outputColor, 1920, 1080);
 */
export class SSAOPass implements PostProcessPass {
    /** Pass 唯一标识符 */
    public readonly id: string = 'ssao';

    /** 当前启用状态 */
    public enabled: boolean = true;

    /** 采样半径，范围 [0.01, 5] */
    private _radius: number;

    /** 遮蔽强度，范围 [0, 5] */
    private _intensity: number;

    /** 深度偏移量（防自遮蔽），范围 [0, 0.1] */
    private _bias: number;

    /** 采样核心大小，16/32/64 */
    private _kernelSize: 16 | 32 | 64;

    /** 是否启用双边模糊 */
    private _blur: boolean;

    /** 当前缓冲区宽度（像素） */
    private _width: number = 0;

    /** 当前缓冲区高度（像素） */
    private _height: number = 0;

    /** 半球采样核心向量（每 3 个 float 一组 [x, y, z]） */
    private _kernel: Float32Array;

    /** 4×4 噪声纹理（每 2 个 float 一组 [x, y]，共 16 个向量） */
    private _noiseTex: Float32Array;

    /** AO 中间结果缓冲区（单通道，每像素一个 float） */
    private _aoBuffer: Float32Array | null = null;

    /** AO 模糊结果缓冲区（单通道） */
    private _aoBlurBuffer: Float32Array | null = null;

    /** 伪随机数生成器种子（确定性种子确保可复现） */
    private _rngSeed: number = 12345;

    /** 资源是否已销毁 */
    private _destroyed: boolean = false;

    /**
     * 创建 SSAOPass 实例。
     *
     * @param options - 配置选项
     *
     * @example
     * const ssao = new SSAOPass();
     * const ssao2 = new SSAOPass({ radius: 1.0, intensity: 1.5, kernelSize: 64 });
     */
    constructor(options: SSAOPassOptions = {}) {
        // 解构并钳制各参数到有效范围
        this._radius = SSAOPass._clamp(
            options.radius ?? DEFAULT_RADIUS,
            0.01,
            5,
        );
        this._intensity = SSAOPass._clamp(
            options.intensity ?? DEFAULT_INTENSITY,
            0,
            5,
        );
        this._bias = SSAOPass._clamp(
            options.bias ?? DEFAULT_BIAS,
            0,
            0.1,
        );
        this._kernelSize = SSAOPass._validateKernelSize(
            options.kernelSize ?? DEFAULT_KERNEL_SIZE,
        );
        this._blur = options.blur ?? true;

        // 生成半球采样核心和噪声纹理
        this._kernel = this._generateKernel(this._kernelSize);
        this._noiseTex = this._generateNoiseTex();

        if (__DEV__) {
            console.debug(
                `[SSAOPass] 创建: radius=${this._radius}, intensity=${this._intensity}, ` +
                `bias=${this._bias}, kernelSize=${this._kernelSize}, blur=${this._blur}`,
            );
        }
    }

    // ===================== 公共 Setter 方法 =====================

    /**
     * 设置采样半径。
     * 控制遮蔽检测的范围大小。
     *
     * @param value - 新半径，范围 [0.01, 5]，超出范围自动钳制
     *
     * @example
     * ssao.setRadius(1.0); // 更大的检测范围
     */
    public setRadius(value: number): void {
        this._radius = SSAOPass._clamp(value, 0.01, 5);
    }

    /**
     * 设置遮蔽强度。
     *
     * @param value - 新强度，范围 [0, 5]
     *
     * @example
     * ssao.setIntensity(2.0); // 更明显的 AO 效果
     */
    public setIntensity(value: number): void {
        this._intensity = SSAOPass._clamp(value, 0, 5);
    }

    /**
     * 设置采样核心大小。
     * 更多采样点提供更精确的遮蔽估算，但性能开销更高。
     *
     * @param value - 新核心大小，仅支持 16/32/64
     *
     * @example
     * ssao.setKernelSize(64); // 最高质量
     */
    public setKernelSize(value: 16 | 32 | 64): void {
        const validated = SSAOPass._validateKernelSize(value);
        if (validated !== this._kernelSize) {
            this._kernelSize = validated;
            // 重新生成采样核心
            this._rngSeed = 12345; // 重置种子以保证可复现
            this._kernel = this._generateKernel(validated);
        }
    }

    /**
     * 设置深度偏移量。
     * 防止平面表面自遮蔽产生的带状伪影。
     *
     * @param value - 新偏移值，范围 [0, 0.1]
     *
     * @example
     * ssao.setBias(0.05); // 增大偏移以减少伪影
     */
    public setBias(value: number): void {
        this._bias = SSAOPass._clamp(value, 0, 0.1);
    }

    // ===================== PostProcessPass 生命周期方法 =====================

    /**
     * 设置启用状态。
     * 禁用后 execute() 直接拷贝输入到输出。
     *
     * @param enabled - true 启用 SSAO，false 禁用
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * 初始化 Pass，分配内部缓冲区。
     *
     * @param context - 包含视口尺寸的上下文对象
     *
     * @example
     * ssao.setup({ viewport: { width: 1920, height: 1080 } });
     */
    public setup(context: { viewport: { width: number; height: number } }): void {
        if (this._destroyed) {
            if (__DEV__) {
                console.warn('[SSAOPass] setup() 在已销毁的实例上调用，操作被忽略');
            }
            return;
        }

        const { width, height } = context.viewport;

        if (width <= 0 || height <= 0) {
            if (__DEV__) {
                console.warn(`[SSAOPass] 无效视口尺寸: ${width}×${height}，跳过 setup`);
            }
            return;
        }

        // 尺寸未变化且缓冲区已分配时跳过
        if (width === this._width && height === this._height && this._aoBuffer !== null) {
            return;
        }

        this._width = width;
        this._height = height;

        // AO 单通道缓冲区（每像素 1 个 float）
        const pixelCount = width * height;
        this._aoBuffer = new Float32Array(pixelCount);
        this._aoBlurBuffer = new Float32Array(pixelCount);

        if (__DEV__) {
            console.debug(
                `[SSAOPass] setup: ${width}×${height}, AO 缓冲区 = ${pixelCount * 4} bytes × 2`,
            );
        }
    }

    /**
     * 执行 SSAO 后处理。
     * 完整流程：遮蔽计算 → 双边模糊 → 合成。
     *
     * @param inputColor - 输入场景颜色，RGBA Float32
     * @param inputDepth - 输入深度缓冲区（单通道 Float32，长度 = width×height）。
     *                     **SSAO 必需**——如果为 null 则直通。
     *                     值范围 [0, 1]，0 = 最远（Reversed-Z），1 = 最近。
     * @param outputColor - 输出颜色缓冲区
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
        if (this._destroyed) {
            if (__DEV__) {
                console.warn('[SSAOPass] execute() 在已销毁的实例上调用');
            }
            return;
        }

        // 禁用或无深度信息时直通
        if (!this.enabled || inputDepth === null) {
            outputColor.set(inputColor);
            return;
        }

        // 验证缓冲区尺寸
        const expectedColor = width * height * CHANNELS;
        const expectedDepth = width * height;
        if (
            inputColor.length < expectedColor ||
            outputColor.length < expectedColor ||
            inputDepth.length < expectedDepth
        ) {
            if (__DEV__) {
                console.warn(
                    `[SSAOPass] 缓冲区长度不足: 期望 color=${expectedColor}, depth=${expectedDepth}`,
                );
            }
            outputColor.set(inputColor.subarray(0, Math.min(inputColor.length, outputColor.length)));
            return;
        }

        // 必要时重新分配内部缓冲区
        if (width !== this._width || height !== this._height || this._aoBuffer === null) {
            this.setup({ viewport: { width, height } });
        }

        if (this._aoBuffer === null || this._aoBlurBuffer === null) {
            outputColor.set(inputColor);
            return;
        }

        // === 第 1 步：计算 SSAO ===
        this._computeSSAO(inputDepth, this._aoBuffer, width, height);

        // === 第 2 步：双边模糊（可选） ===
        let finalAO: Float32Array;
        if (this._blur) {
            this._bilateralBlur(this._aoBuffer, this._aoBlurBuffer, inputDepth, width, height);
            finalAO = this._aoBlurBuffer;
        } else {
            finalAO = this._aoBuffer;
        }

        // === 第 3 步：合成（场景色 × AO） ===
        this._composite(inputColor, finalAO, outputColor, width, height);
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
     */
    public destroy(): void {
        this._aoBuffer = null;
        this._aoBlurBuffer = null;
        this._width = 0;
        this._height = 0;
        this._destroyed = true;

        if (__DEV__) {
            console.debug('[SSAOPass] 已销毁');
        }
    }

    // ===================== 私有算法方法 =====================

    /**
     * 生成半球采样核心。
     * 采样点在单位半球内均匀分布，但通过二次加速权重使更多采样点靠近原点，
     * 因为近处的遮蔽物对 AO 贡献更大。
     *
     * @param size - 采样点数量（16/32/64）
     * @returns Float32Array，每 3 个 float 一组 [x, y, z]，长度 = size × 3
     */
    private _generateKernel(size: number): Float32Array {
        const kernel = new Float32Array(size * 3);

        for (let i = 0; i < size; i++) {
            // 使用确定性伪随机数生成半球方向
            const x = this._nextRandom() * 2.0 - 1.0; // [-1, 1]
            const y = this._nextRandom() * 2.0 - 1.0; // [-1, 1]
            const z = this._nextRandom();               // [0, 1] — 半球正上方

            // 归一化为单位向量
            let len = Math.sqrt(x * x + y * y + z * z);

            // 防止零向量（极端罕见但数值安全）
            if (len < 1e-10) {
                len = 1.0;
            }

            const nx = x / len;
            const ny = y / len;
            const nz = z / len;

            // 二次加速缩放：使采样点更多地聚集在半球中心附近
            // scale = lerp(0.1, 1.0, (i/size)²)
            // 靠前的样本（i 小）距离原点更近，靠后的样本（i 大）更远
            const t = i / size;
            const scale = 0.1 + 0.9 * t * t;

            // 乘以随机半径使采样点分布在半球体积内而非仅表面
            const radius = this._nextRandom() * scale;

            kernel[i * 3] = nx * radius;
            kernel[i * 3 + 1] = ny * radius;
            kernel[i * 3 + 2] = nz * radius;
        }

        return kernel;
    }

    /**
     * 生成 4×4 噪声纹理（随机旋转向量）。
     * 用于 TBN 矩阵构建时的随机旋转，消除有限采样核导致的带状伪影。
     * 每个向量为 2D 归一化方向 [x, y]，共 16 个。
     *
     * @returns Float32Array 长度 32（16 个 [x, y] 向量）
     */
    private _generateNoiseTex(): Float32Array {
        const noiseCount = NOISE_TEXTURE_SIZE * NOISE_TEXTURE_SIZE;
        const noise = new Float32Array(noiseCount * 2);

        for (let i = 0; i < noiseCount; i++) {
            // 随机方向向量（在 XY 平面内），用于绕法线旋转采样核
            const angle = this._nextRandom() * Math.PI * 2.0;
            noise[i * 2] = Math.cos(angle);
            noise[i * 2 + 1] = Math.sin(angle);
        }

        return noise;
    }

    /**
     * 计算每像素的 SSAO 遮蔽因子。
     *
     * 对每个像素：
     * 1. 从深度缓冲区重建视图空间位置
     * 2. 从相邻像素深度差分估算法线
     * 3. 用噪声纹理随机旋转采样核构建 TBN 矩阵
     * 4. 对每个采样点检查是否被遮蔽（采样点深度 > 缓冲区深度 + bias）
     * 5. 遮蔽率 = 被遮蔽的采样点数 / 总采样点数
     *
     * @param depth - 深度缓冲区（单通道，Reversed-Z：1=近，0=远）
     * @param aoOut - 输出 AO 缓冲区（单通道，0=完全遮蔽，1=无遮蔽）
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _computeSSAO(
        depth: Float32Array,
        aoOut: Float32Array,
        width: number,
        height: number,
    ): void {
        const radius = this._radius;
        const bias = this._bias;
        const intensity = this._intensity;
        const kernelSize = this._kernelSize;
        const kernel = this._kernel;
        const noiseTex = this._noiseTex;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixelIndex = y * width + x;
                const centerDepth = depth[pixelIndex];

                // 跳过天空/背景像素（深度为 0 在 Reversed-Z 中表示最远处）
                if (centerDepth <= 0.0001) {
                    aoOut[pixelIndex] = 1.0; // 无遮蔽
                    continue;
                }

                // 将深度值转换为线性深度（近似）
                // Reversed-Z 中 1 = 近平面，0 = 远平面
                const linearDepth = centerDepth;

                // 从深度差分估算法线（屏幕空间差分法）
                // 使用相邻像素深度差近似表面梯度
                const dxIdx = y * width + Math.min(x + 1, width - 1);
                const dyIdx = Math.min(y + 1, height - 1) * width + x;
                const ddx = depth[dxIdx] - centerDepth;
                const ddy = depth[dyIdx] - centerDepth;

                // 近似法线：cross(tangent, bitangent) 在屏幕空间
                // tangent ≈ (1/width, 0, ddx), bitangent ≈ (0, 1/height, ddy)
                // normal ≈ normalize(-ddx, -ddy, 1/(width*height))
                const invW = 1.0 / width;
                const invH = 1.0 / height;
                let nx = -ddx;
                let ny = -ddy;
                let nz = invW * invH;
                const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nLen > 1e-10) {
                    nx /= nLen;
                    ny /= nLen;
                    nz /= nLen;
                } else {
                    // 退化情况：法线朝上
                    nx = 0;
                    ny = 0;
                    nz = 1;
                }

                // 从噪声纹理获取随机旋转向量（4×4 平铺）
                const noiseIdx = ((y % NOISE_TEXTURE_SIZE) * NOISE_TEXTURE_SIZE +
                    (x % NOISE_TEXTURE_SIZE)) * 2;
                const noiseX = noiseTex[noiseIdx];
                const noiseY = noiseTex[noiseIdx + 1];

                // 构建 TBN 矩阵（Tangent-Bitangent-Normal）
                // tangent = normalize(noise - normal * dot(noise, normal))（Gram-Schmidt 正交化）
                const dotNR = noiseX * nx + noiseY * ny;
                let tx = noiseX - nx * dotNR;
                let ty = noiseY - ny * dotNR;
                let tz = -nz * dotNR;
                const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
                if (tLen > 1e-10) {
                    tx /= tLen;
                    ty /= tLen;
                    tz /= tLen;
                } else {
                    // 退化情况：使用默认切线方向
                    tx = 1;
                    ty = 0;
                    tz = 0;
                }

                // bitangent = cross(normal, tangent)
                const bx = ny * tz - nz * ty;
                const by = nz * tx - nx * tz;
                const bz = nx * ty - ny * tx;

                // 在屏幕空间位置（归一化到 [0,1]）
                const posX = x / width;
                const posY = y / height;

                // 对每个采样点检查遮蔽
                let occluded = 0;

                for (let s = 0; s < kernelSize; s++) {
                    // 从采样核获取方向并用 TBN 矩阵变换
                    const kx = kernel[s * 3];
                    const ky = kernel[s * 3 + 1];
                    const kz = kernel[s * 3 + 2];

                    // TBN * kernelSample = tangent*kx + bitangent*ky + normal*kz
                    const sampleDx = (tx * kx + bx * ky + nx * kz) * radius;
                    const sampleDy = (ty * kx + by * ky + ny * kz) * radius;
                    const sampleDz = (tz * kx + bz * ky + nz * kz) * radius;

                    // 采样点的屏幕空间位置
                    const sampleX = posX + sampleDx;
                    const sampleY = posY + sampleDy;

                    // 采样点的预期深度
                    const sampleDepth = linearDepth + sampleDz;

                    // 将屏幕空间坐标转换为像素索引
                    const sx = Math.round(sampleX * width);
                    const sy = Math.round(sampleY * height);

                    // 边界检查：超出屏幕的采样点不计入遮蔽
                    if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
                        continue;
                    }

                    // 读取采样点位置的实际深度
                    const actualDepth = depth[sy * width + sx];

                    // 遮蔽判定：如果实际表面比采样点更近（深度更大，Reversed-Z），
                    // 且深度差在有效范围内（避免远处物体的错误遮蔽），则判定为遮蔽
                    if (actualDepth > sampleDepth + bias) {
                        // 范围检查：遮蔽物与当前点距离过大时衰减（避免光晕伪影）
                        const depthDiff = Math.abs(actualDepth - centerDepth);
                        const rangeCheck = 1.0 - SSAOPass._clamp(depthDiff / radius, 0, 1);
                        occluded += rangeCheck;
                    }
                }

                // 遮蔽率归一化到 [0, 1]
                const occlusion = occluded / kernelSize;

                // AO = 1 - occlusion * intensity，钳制到 [0, 1]
                const ao = SSAOPass._clamp(1.0 - occlusion * intensity, 0, 1);
                aoOut[pixelIndex] = ao;
            }
        }
    }

    /**
     * 双边模糊：5×5 核加权平均 AO 值，同时根据深度相似性保留边缘。
     * 深度差异大的相邻像素权重被大幅衰减，防止 AO 泄漏到不同深度的表面。
     *
     * @param aoIn - 输入 AO 缓冲区（单通道）
     * @param aoOut - 输出模糊后 AO 缓冲区
     * @param depth - 深度缓冲区（用于深度相似性权重）
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _bilateralBlur(
        aoIn: Float32Array,
        aoOut: Float32Array,
        depth: Float32Array,
        width: number,
        height: number,
    ): void {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const centerIdx = y * width + x;
                const centerDepth = depth[centerIdx];

                let sumAO = 0;
                let sumWeight = 0;

                // 5×5 邻域遍历
                for (let ky = -BILATERAL_HALF_KERNEL; ky <= BILATERAL_HALF_KERNEL; ky++) {
                    for (let kx = -BILATERAL_HALF_KERNEL; kx <= BILATERAL_HALF_KERNEL; kx++) {
                        // 边界钳制
                        const sx = Math.min(Math.max(x + kx, 0), width - 1);
                        const sy = Math.min(Math.max(y + ky, 0), height - 1);
                        const sampleIdx = sy * width + sx;

                        // 空间权重：简化为均匀权重（5×5 box，高斯核的简化版本）
                        const spatialWeight = 1.0;

                        // 深度权重：深度差异越大，权重越低（保边特性）
                        const depthDiff = Math.abs(depth[sampleIdx] - centerDepth);
                        // 高斯函数衰减：exp(-depthDiff² / (2 × threshold²))
                        const depthWeight = Math.exp(
                            -(depthDiff * depthDiff) /
                            (2.0 * BILATERAL_DEPTH_THRESHOLD * BILATERAL_DEPTH_THRESHOLD),
                        );

                        const weight = spatialWeight * depthWeight;
                        sumAO += aoIn[sampleIdx] * weight;
                        sumWeight += weight;
                    }
                }

                // 归一化加权平均（防零除）
                aoOut[centerIdx] = sumWeight > 0 ? sumAO / sumWeight : aoIn[centerIdx];
            }
        }
    }

    /**
     * 合成阶段：场景颜色 × AO 因子。
     * AO = 1 表示无遮蔽（原色），AO = 0 表示完全遮蔽（全黑）。
     *
     * @param scene - 原始场景颜色缓冲区（RGBA）
     * @param ao - AO 单通道缓冲区
     * @param output - 合成输出缓冲区（RGBA）
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _composite(
        scene: Float32Array,
        ao: Float32Array,
        output: Float32Array,
        width: number,
        height: number,
    ): void {
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            const colorOffset = i * CHANNELS;
            const aoFactor = ao[i];

            // RGB 各通道乘以 AO 因子
            output[colorOffset] = scene[colorOffset] * aoFactor;
            output[colorOffset + 1] = scene[colorOffset + 1] * aoFactor;
            output[colorOffset + 2] = scene[colorOffset + 2] * aoFactor;
            // Alpha 不受 AO 影响
            output[colorOffset + 3] = scene[colorOffset + 3];
        }
    }

    // ===================== 工具方法 =====================

    /**
     * 确定性伪随机数生成器（xorshift32 算法）。
     * 每次调用返回 [0, 1) 范围的浮点数。
     * 使用确定性种子确保采样核和噪声纹理在不同运行中可复现。
     *
     * @returns [0, 1) 范围的伪随机浮点数
     */
    private _nextRandom(): number {
        // xorshift32：快速、周期长、无外部依赖
        let s = this._rngSeed;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        this._rngSeed = s;
        // 将有符号 32 位整数转为 [0, 1) 浮点数
        return (s >>> 0) / 4294967296;
    }

    /**
     * 将数值钳制到 [min, max] 范围内。
     * NaN 安全：NaN 返回 min。
     *
     * @param value - 待钳制的值
     * @param min - 最小值（含）
     * @param max - 最大值（含）
     * @returns 钳制后的值
     */
    private static _clamp(value: number, min: number, max: number): number {
        if (value >= min) {
            return value <= max ? value : max;
        }
        return min;
    }

    /**
     * 验证并归一化 kernelSize 到允许的值（16/32/64）。
     * 不在允许列表中的值回退到默认值 32。
     *
     * @param size - 输入核心大小
     * @returns 有效的核心大小
     */
    private static _validateKernelSize(size: number): 16 | 32 | 64 {
        if (size === 16 || size === 32 || size === 64) {
            return size;
        }
        if (__DEV__) {
            console.warn(
                `[SSAOPass] 无效 kernelSize: ${size}，已回退到默认值 ${DEFAULT_KERNEL_SIZE}`,
            );
        }
        return DEFAULT_KERNEL_SIZE as 16 | 32 | 64;
    }
}
