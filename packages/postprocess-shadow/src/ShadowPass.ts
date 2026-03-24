// ============================================================
// postprocess-shadow/src/ShadowPass.ts — 屏幕空间阴影（Shadow）后处理 Pass
// 根据深度缓冲区和光照方向生成建筑/地形的投影阴影效果。
// MVP 实现：纯 CPU Float32Array 像素缓冲区，便于无 WebGPU 环境验证算法。
//
// 所属层级：L2（渲染层 — 后处理子系统）
// 依赖：仅 L0 Viewport 类型
// ============================================================

import type { Viewport } from '../../core/src/types/viewport.ts';

/** @stability experimental */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 默认光照方向 [x, y, z]（归一化）。太阳从右上方照射 */
const DEFAULT_LIGHT_DIR: readonly [number, number, number] = [0.5, 0.5, -1];

/** 默认阴影颜色，CSS rgba 格式。半透明黑色 */
const DEFAULT_SHADOW_COLOR = 'rgba(0,0,0,0.3)';

/** 默认阴影模糊半径（像素），范围 [0, 20]。控制阴影边缘柔软度 */
const DEFAULT_BLUR_RADIUS = 4;

/** 默认偏移因子，范围 [0, 2]。控制阴影长度与高度的比例关系 */
const DEFAULT_OFFSET_FACTOR = 1.0;

/** 每像素通道数（RGBA） */
const CHANNELS = 4;

/**
 * 深度阈值：低于此值的像素认为是"有高度"的几何体（如建筑、地形）。
 * 在 Reversed-Z 中，1 = 最近，0 = 最远。
 * 大于此阈值意味着物体在相机前方有一定距离，属于"凸起"的几何体。
 */
const ELEVATION_DEPTH_THRESHOLD = 0.9;

/**
 * 9-tap 高斯模糊权重（对称核），用于阴影边缘软化。
 * 与 BloomPass 使用相同的标准高斯近似。
 */
const GAUSSIAN_WEIGHTS: readonly number[] = [
    0.227027,   // 中心
    0.1945946,  // ±1
    0.1216216,  // ±2
    0.054054,   // ±3
    0.016216,   // ±4
];

// ===================== 选项接口 =====================

/**
 * ShadowPass 配置选项。
 * 所有参数均可选，使用默认值即可获得合理的投影阴影效果。
 *
 * @example
 * const options: ShadowPassOptions = {
 *   lightDirection: [0.5, 0.5, -1],
 *   shadowColor: 'rgba(0,0,0,0.4)',
 *   blurRadius: 6,
 *   offsetFactor: 1.2,
 * };
 */
export interface ShadowPassOptions {
    /**
     * 光照方向向量 [x, y, z]。
     * 定义平行光的入射方向，阴影朝反方向投射。
     * 不需要归一化（内部会归一化处理）。
     * 默认值：[0.5, 0.5, -1]（太阳从右上方照射）。
     */
    readonly lightDirection?: [number, number, number];

    /**
     * 阴影颜色，CSS rgba 格式字符串。
     * 格式：'rgba(r,g,b,a)'，其中 r/g/b 范围 [0,255]，a 范围 [0,1]。
     * 默认值：'rgba(0,0,0,0.3)'（半透明黑色）。
     */
    readonly shadowColor?: string;

    /**
     * 阴影模糊半径（像素）。
     * 控制高斯模糊的范围，值越大阴影边缘越柔和。
     * 0 = 无模糊（硬阴影），20 = 非常模糊（软阴影）。
     * 默认值：4，范围 [0, 20]。
     */
    readonly blurRadius?: number;

    /**
     * 阴影偏移因子。
     * 控制阴影长度与几何体高度的比例关系。
     * 1.0 = 标准，>1 = 阴影更长，<1 = 阴影更短。
     * 默认值：1.0，范围 [0, 2]。
     */
    readonly offsetFactor?: number;
}

// ===================== PostProcessPass 接口 =====================

/**
 * 后处理 Pass 通用接口。
 * 定义后处理管线中每个 Pass 的生命周期方法。
 * MVP 阶段在 CPU 侧 Float32Array 像素缓冲区上执行算法。
 */
interface PostProcessPass {
    /** Pass 唯一标识符 */
    readonly id: string;

    /** 当前是否启用 */
    readonly enabled: boolean;

    /**
     * 设置启用状态。
     * @param enabled - true 启用阴影，false 禁用
     */
    setEnabled(enabled: boolean): void;

    /**
     * 初始化/重新配置 Pass。
     * @param context - 包含视口尺寸的上下文对象
     */
    setup(context: { viewport: { width: number; height: number } }): void;

    /**
     * 执行后处理算法。
     * @param inputColor - 输入颜色缓冲区
     * @param inputDepth - 输入深度缓冲区（阴影必需）
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

// ===================== 内部颜色类型 =====================

/**
 * 解析后的 RGBA 颜色值。
 * r/g/b 范围 [0, 1]（从 [0, 255] 归一化），a 范围 [0, 1]。
 */
interface ParsedColor {
    /** 红色通道，范围 [0, 1] */
    readonly r: number;
    /** 绿色通道，范围 [0, 1] */
    readonly g: number;
    /** 蓝色通道，范围 [0, 1] */
    readonly b: number;
    /** 不透明度，范围 [0, 1] */
    readonly a: number;
}

// ===================== ShadowPass 实现 =====================

/**
 * 屏幕空间阴影（Screen-Space Shadow）后处理 Pass。
 *
 * 算法流程：
 * 1. **阴影生成**：根据深度缓冲区识别"凸起"几何体（深度 > 阈值），
 *    计算其投影阴影在屏幕空间的偏移位置，写入阴影遮罩
 * 2. **高斯模糊**：对阴影遮罩进行可分离高斯模糊以软化边缘
 * 3. **合成**：根据阴影遮罩将场景颜色与阴影颜色混合
 *
 * @stability experimental
 *
 * @example
 * const shadow = new ShadowPass({ lightDirection: [1, 1, -1], blurRadius: 6 });
 * shadow.setup({ viewport: { width: 1920, height: 1080 } });
 * shadow.execute(inputColor, inputDepth, outputColor, 1920, 1080);
 */
export class ShadowPass implements PostProcessPass {
    /** Pass 唯一标识符 */
    public readonly id: string = 'shadow';

    /** 当前启用状态 */
    public enabled: boolean = true;

    /** 归一化光照方向 [x, y, z] */
    private _lightDir: [number, number, number];

    /** 解析后的阴影颜色 */
    private _shadowColor: ParsedColor;

    /** 原始阴影颜色字符串（用于 DevTools 显示） */
    private _shadowColorStr: string;

    /** 模糊半径（像素），范围 [0, 20] */
    private _blurRadius: number;

    /** 偏移因子，范围 [0, 2] */
    private _offsetFactor: number;

    /** 当前缓冲区宽度（像素） */
    private _width: number = 0;

    /** 当前缓冲区高度（像素） */
    private _height: number = 0;

    /** 阴影遮罩缓冲区（单通道，0=无阴影，1=完全阴影） */
    private _shadowMask: Float32Array | null = null;

    /** 模糊中间缓冲区（单通道） */
    private _blurTempBuffer: Float32Array | null = null;

    /** 资源是否已销毁 */
    private _destroyed: boolean = false;

    /**
     * 创建 ShadowPass 实例。
     *
     * @param options - 配置选项
     *
     * @example
     * const shadow = new ShadowPass();
     * const shadow2 = new ShadowPass({
     *   lightDirection: [1, 0.5, -0.8],
     *   shadowColor: 'rgba(0,0,50,0.4)',
     *   blurRadius: 8,
     * });
     */
    constructor(options: ShadowPassOptions = {}) {
        // 归一化光照方向
        this._lightDir = ShadowPass._normalizeDir(
            options.lightDirection ?? [...DEFAULT_LIGHT_DIR] as [number, number, number],
        );

        // 解析阴影颜色字符串
        this._shadowColorStr = options.shadowColor ?? DEFAULT_SHADOW_COLOR;
        this._shadowColor = ShadowPass._parseRgba(this._shadowColorStr);

        // 钳制模糊半径
        this._blurRadius = ShadowPass._clamp(
            Math.round(options.blurRadius ?? DEFAULT_BLUR_RADIUS),
            0,
            20,
        );

        // 钳制偏移因子
        this._offsetFactor = ShadowPass._clamp(
            options.offsetFactor ?? DEFAULT_OFFSET_FACTOR,
            0,
            2,
        );

        if (__DEV__) {
            console.debug(
                `[ShadowPass] 创建: lightDir=[${this._lightDir}], ` +
                `shadowColor='${this._shadowColorStr}', ` +
                `blurRadius=${this._blurRadius}, offsetFactor=${this._offsetFactor}`,
            );
        }
    }

    // ===================== 公共 Setter 方法 =====================

    /**
     * 设置光照方向。
     * 阴影朝光照反方向投射。输入向量会被自动归一化。
     *
     * @param dir - 光照方向 [x, y, z]，不需要归一化
     *
     * @example
     * shadow.setLightDirection([1, 1, -0.5]); // 低角度斜射光
     */
    public setLightDirection(dir: [number, number, number]): void {
        this._lightDir = ShadowPass._normalizeDir(dir);
    }

    /**
     * 设置阴影颜色。
     * 解析 CSS rgba 格式字符串。解析失败时保持原值不变。
     *
     * @param color - CSS rgba 格式，如 'rgba(0,0,0,0.5)'
     *
     * @example
     * shadow.setShadowColor('rgba(50,0,0,0.4)'); // 带红色调的阴影
     */
    public setShadowColor(color: string): void {
        const parsed = ShadowPass._parseRgba(color);
        // 解析成功才更新（_parseRgba 始终返回有效值，失败时返回默认值）
        this._shadowColor = parsed;
        this._shadowColorStr = color;
    }

    /**
     * 设置模糊半径。
     * 0 = 硬阴影（无模糊），值越大阴影边缘越柔和。
     *
     * @param value - 模糊半径（像素），范围 [0, 20]
     *
     * @example
     * shadow.setBlurRadius(10); // 非常柔和的阴影
     */
    public setBlurRadius(value: number): void {
        this._blurRadius = ShadowPass._clamp(Math.round(value), 0, 20);
    }

    /**
     * 设置偏移因子。
     * 控制阴影长度与几何体高度的比例。
     *
     * @param value - 偏移因子，范围 [0, 2]
     *
     * @example
     * shadow.setOffsetFactor(1.5); // 更长的阴影
     */
    public setOffsetFactor(value: number): void {
        this._offsetFactor = ShadowPass._clamp(value, 0, 2);
    }

    // ===================== PostProcessPass 生命周期方法 =====================

    /**
     * 设置启用状态。
     * 禁用后 execute() 直接拷贝输入到输出。
     *
     * @param enabled - true 启用阴影，false 禁用
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * 初始化 Pass，分配内部缓冲区。
     *
     * @param context - 包含视口尺寸的上下文
     *
     * @example
     * shadow.setup({ viewport: { width: 1920, height: 1080 } });
     */
    public setup(context: { viewport: { width: number; height: number } }): void {
        if (this._destroyed) {
            if (__DEV__) {
                console.warn('[ShadowPass] setup() 在已销毁的实例上调用，操作被忽略');
            }
            return;
        }

        const { width, height } = context.viewport;

        if (width <= 0 || height <= 0) {
            if (__DEV__) {
                console.warn(`[ShadowPass] 无效视口尺寸: ${width}×${height}，跳过 setup`);
            }
            return;
        }

        // 尺寸未变化且缓冲区已分配时跳过
        if (width === this._width && height === this._height && this._shadowMask !== null) {
            return;
        }

        this._width = width;
        this._height = height;

        // 单通道阴影遮罩（每像素 1 个 float）
        const pixelCount = width * height;
        this._shadowMask = new Float32Array(pixelCount);
        this._blurTempBuffer = new Float32Array(pixelCount);

        if (__DEV__) {
            console.debug(
                `[ShadowPass] setup: ${width}×${height}, 遮罩缓冲区 = ${pixelCount * 4} bytes × 2`,
            );
        }
    }

    /**
     * 执行阴影后处理。
     * 完整流程：阴影生成 → 高斯模糊 → 合成。
     *
     * @param inputColor - 输入场景颜色，RGBA Float32
     * @param inputDepth - 输入深度缓冲区（单通道 Float32）。
     *                     **阴影必需**——如果为 null 则直通。
     *                     Reversed-Z：1=近，0=远。
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
                console.warn('[ShadowPass] execute() 在已销毁的实例上调用');
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
                    `[ShadowPass] 缓冲区长度不足: 期望 color=${expectedColor}, depth=${expectedDepth}`,
                );
            }
            outputColor.set(inputColor.subarray(0, Math.min(inputColor.length, outputColor.length)));
            return;
        }

        // 必要时重新分配内部缓冲区
        if (width !== this._width || height !== this._height || this._shadowMask === null) {
            this.setup({ viewport: { width, height } });
        }

        if (this._shadowMask === null || this._blurTempBuffer === null) {
            outputColor.set(inputColor);
            return;
        }

        // === 第 1 步：生成阴影遮罩 ===
        this._generateShadowMask(inputDepth, this._shadowMask, width, height);

        // === 第 2 步：高斯模糊阴影遮罩 ===
        if (this._blurRadius > 0) {
            this._blurShadowMask(this._shadowMask, this._blurTempBuffer, width, height);
        }

        // === 第 3 步：合成 ===
        this._composite(inputColor, this._shadowMask, outputColor, width, height);
    }

    /**
     * 视口尺寸变化时重新分配内部缓冲区。
     *
     * @param width - 新宽度
     * @param height - 新高度
     */
    public onResize(width: number, height: number): void {
        this.setup({ viewport: { width, height } });
    }

    /**
     * 释放所有内部资源。
     */
    public destroy(): void {
        this._shadowMask = null;
        this._blurTempBuffer = null;
        this._width = 0;
        this._height = 0;
        this._destroyed = true;

        if (__DEV__) {
            console.debug('[ShadowPass] 已销毁');
        }
    }

    // ===================== 私有算法方法 =====================

    /**
     * 生成阴影遮罩。
     *
     * 对每个像素：
     * 1. 如果深度值表示"凸起"几何体（depth > ELEVATION_DEPTH_THRESHOLD），
     *    计算其相对高度（depth - threshold）
     * 2. 根据光照方向 XY 分量和高度计算阴影在屏幕空间的偏移
     * 3. 在偏移位置标记阴影
     *
     * @param depth - 深度缓冲区（Reversed-Z：1=近，0=远）
     * @param mask - 输出阴影遮罩（0=无阴影，值越大阴影越浓）
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _generateShadowMask(
        depth: Float32Array,
        mask: Float32Array,
        width: number,
        height: number,
    ): void {
        // 先清零遮罩
        mask.fill(0);

        const lightX = this._lightDir[0];
        const lightY = this._lightDir[1];
        const offsetFactor = this._offsetFactor;

        // 最大偏移量限制（像素），防止阴影投射过远导致不真实
        const maxOffset = Math.max(width, height) * 0.1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const d = depth[idx];

                // 只有"凸起"的几何体才投射阴影
                if (d <= ELEVATION_DEPTH_THRESHOLD) {
                    continue;
                }

                // 相对高度：depth 超过阈值的部分，归一化到 [0, 1]
                // (1 - ELEVATION_DEPTH_THRESHOLD) 是可用的高度范围
                const relativeHeight = (d - ELEVATION_DEPTH_THRESHOLD) /
                    (1.0 - ELEVATION_DEPTH_THRESHOLD);

                // 阴影偏移 = 高度 × 光照方向 XY × 偏移因子
                // 偏移方向与光照方向相反（阴影投射在光源对侧）
                const rawOffsetX = relativeHeight * lightX * offsetFactor * maxOffset;
                const rawOffsetY = relativeHeight * lightY * offsetFactor * maxOffset;

                // 计算阴影落点的像素坐标
                const shadowX = Math.round(x - rawOffsetX);
                const shadowY = Math.round(y - rawOffsetY);

                // 边界检查
                if (shadowX < 0 || shadowX >= width || shadowY < 0 || shadowY >= height) {
                    continue;
                }

                const shadowIdx = shadowY * width + shadowX;

                // 阴影强度与高度成正比。使用 max 保留最浓的阴影（多个遮蔽物叠加时取最大值）
                const shadowStrength = ShadowPass._clamp(relativeHeight, 0, 1);
                if (shadowStrength > mask[shadowIdx]) {
                    mask[shadowIdx] = shadowStrength;
                }
            }
        }
    }

    /**
     * 对阴影遮罩进行可分离高斯模糊，软化阴影边缘。
     * 水平 pass 后接垂直 pass。
     *
     * @param mask - 阴影遮罩缓冲区（就地更新为模糊结果）
     * @param temp - 临时缓冲区
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _blurShadowMask(
        mask: Float32Array,
        temp: Float32Array,
        width: number,
        height: number,
    ): void {
        const radius = this._blurRadius;

        // 水平模糊：mask → temp
        this._blurPassSingleChannel(mask, temp, width, height, radius, true);

        // 垂直模糊：temp → mask
        this._blurPassSingleChannel(temp, mask, width, height, radius, false);
    }

    /**
     * 单通道单方向高斯模糊。
     * 使用预定义的 9-tap 权重，采样步长由 blurRadius 控制。
     *
     * @param src - 源缓冲区（单通道，只读）
     * @param dst - 目标缓冲区（单通道，写入）
     * @param width - 图像宽度
     * @param height - 图像高度
     * @param radius - 模糊半径（像素）
     * @param horizontal - true 水平方向，false 垂直方向
     */
    private _blurPassSingleChannel(
        src: Float32Array,
        dst: Float32Array,
        width: number,
        height: number,
        radius: number,
        horizontal: boolean,
    ): void {
        const totalPixels = width * height;
        // 步长因子：将 radius 均匀分配到 4 个 tap 位置
        const stepScale = radius / (GAUSSIAN_WEIGHTS.length - 1);

        for (let i = 0; i < totalPixels; i++) {
            const x = i % width;
            const y = (i - x) / width;

            // 中心权重
            let sum = src[i] * GAUSSIAN_WEIGHTS[0];

            for (let tap = 1; tap < GAUSSIAN_WEIGHTS.length; tap++) {
                const weight = GAUSSIAN_WEIGHTS[tap];
                const offset = Math.round(tap * stepScale);

                let posIdx: number;
                let negIdx: number;

                if (horizontal) {
                    // 水平方向 clamp
                    const posX = Math.min(x + offset, width - 1);
                    const negX = Math.max(x - offset, 0);
                    posIdx = y * width + posX;
                    negIdx = y * width + negX;
                } else {
                    // 垂直方向 clamp
                    const posY = Math.min(y + offset, height - 1);
                    const negY = Math.max(y - offset, 0);
                    posIdx = posY * width + x;
                    negIdx = negY * width + x;
                }

                sum += (src[posIdx] + src[negIdx]) * weight;
            }

            dst[i] = sum;
        }
    }

    /**
     * 合成阶段：根据阴影遮罩混合场景颜色与阴影颜色。
     * 公式：output = lerp(sceneColor, shadowColor, mask * shadowAlpha)
     *
     * @param scene - 原始场景颜色（RGBA）
     * @param mask - 阴影遮罩（单通道，[0,1]）
     * @param output - 合成输出（RGBA）
     * @param width - 图像宽度
     * @param height - 图像高度
     */
    private _composite(
        scene: Float32Array,
        mask: Float32Array,
        output: Float32Array,
        width: number,
        height: number,
    ): void {
        const { r: sr, g: sg, b: sb, a: sa } = this._shadowColor;
        const totalPixels = width * height;

        for (let i = 0; i < totalPixels; i++) {
            const colorOffset = i * CHANNELS;
            const shadowAmount = mask[i] * sa; // 遮罩强度 × 阴影 alpha

            // 线性插值：output = scene * (1 - shadowAmount) + shadowColor * shadowAmount
            const invShadow = 1.0 - shadowAmount;
            output[colorOffset] = scene[colorOffset] * invShadow + sr * shadowAmount;
            output[colorOffset + 1] = scene[colorOffset + 1] * invShadow + sg * shadowAmount;
            output[colorOffset + 2] = scene[colorOffset + 2] * invShadow + sb * shadowAmount;
            // Alpha：保留场景 alpha
            output[colorOffset + 3] = scene[colorOffset + 3];
        }
    }

    // ===================== 工具方法 =====================

    /**
     * 解析 CSS rgba 颜色字符串为归一化 RGBA 值。
     * 支持格式：'rgba(r, g, b, a)' 和 'rgba(r,g,b,a)'（空格可选）。
     * 解析失败时返回默认阴影颜色（半透明黑色）。
     *
     * @param color - CSS rgba 字符串
     * @returns 解析后的颜色对象，r/g/b 范围 [0,1]，a 范围 [0,1]
     *
     * @example
     * ShadowPass._parseRgba('rgba(0,0,0,0.3)'); // → { r: 0, g: 0, b: 0, a: 0.3 }
     * ShadowPass._parseRgba('rgba(255, 128, 0, 0.5)'); // → { r: 1, g: 0.502, b: 0, a: 0.5 }
     */
    private static _parseRgba(color: string): ParsedColor {
        // 正则匹配 rgba(r, g, b, a) 格式，支持整数和浮点数
        const match = color.match(
            /rgba\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/,
        );

        if (match !== null && match.length >= 5) {
            // 解析并归一化各通道
            const rawR = parseFloat(match[1]);
            const rawG = parseFloat(match[2]);
            const rawB = parseFloat(match[3]);
            const rawA = parseFloat(match[4]);

            // 检查解析结果是否为有效数字
            if (!Number.isNaN(rawR) && !Number.isNaN(rawG) && !Number.isNaN(rawB) && !Number.isNaN(rawA)) {
                return {
                    r: ShadowPass._clamp(rawR / 255, 0, 1),
                    g: ShadowPass._clamp(rawG / 255, 0, 1),
                    b: ShadowPass._clamp(rawB / 255, 0, 1),
                    a: ShadowPass._clamp(rawA, 0, 1),
                };
            }
        }

        // 解析失败：返回默认半透明黑色并在开发模式下警告
        if (__DEV__) {
            console.warn(
                `[ShadowPass] 无法解析阴影颜色 '${color}'，使用默认值 '${DEFAULT_SHADOW_COLOR}'`,
            );
        }

        return { r: 0, g: 0, b: 0, a: 0.3 };
    }

    /**
     * 归一化 3D 方向向量。
     * 零向量或 NaN 向量回退到默认光照方向。
     *
     * @param dir - 输入方向向量 [x, y, z]
     * @returns 归一化后的方向向量
     */
    private static _normalizeDir(dir: [number, number, number]): [number, number, number] {
        const x = dir[0];
        const y = dir[1];
        const z = dir[2];

        // 检查 NaN
        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
            if (__DEV__) {
                console.warn('[ShadowPass] 光照方向包含 NaN，使用默认值');
            }
            return [...DEFAULT_LIGHT_DIR] as [number, number, number];
        }

        const len = Math.sqrt(x * x + y * y + z * z);

        // 零向量回退
        if (len < 1e-10) {
            if (__DEV__) {
                console.warn('[ShadowPass] 光照方向为零向量，使用默认值');
            }
            return [...DEFAULT_LIGHT_DIR] as [number, number, number];
        }

        return [x / len, y / len, z / len];
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
}
