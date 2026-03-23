// ============================================================
// precision/split-double.ts — Float64 → Float32×2 拆分（Veltkamp splitting）
// 将一个 Float64 值拆分为两个 Float32 值（high + low），
// 使得 high + low ≈ 原始值，精度接近 Float64。
// GPU 端可用两个 f32 uniform 重组还原精度。
// 零外部依赖。
// ============================================================

// ======================== 常量定义 ========================

/**
 * Veltkamp 分裂因子 = 2^12 + 1 = 4097。
 * 选择 12 位是因为 Float32 有 23 位尾数，
 * 拆分后 high 部分占 11 位（23 - 12），low 部分占 12 位，
 * 两部分之和可以恢复大部分 Float64 精度。
 * 参考：T.J. Dekker (1971), "A floating-point technique for extending
 * the available precision"
 */
const SPLITTER = 4097.0; // 2^12 + 1

// ======================== 公共 API ========================

/**
 * 将一个 Float64 值拆分为两个 Float32 值（高位 + 低位）。
 * 拆分使用 Veltkamp splitting 算法：
 *   temp = value × (2^12 + 1)
 *   high = temp - (temp - value)
 *   low = value - high
 *
 * 用途：GPU 上使用两个 f32 uniform 传递高精度坐标，
 * 在 vertex shader 中 `position = a_positionHigh + a_positionLow - u_eyeHigh - u_eyeLow`
 * 可以消除浮点抖动（jitter）。
 *
 * @param value - 要拆分的 Float64 值
 * @returns [high, low] 元组，high 为高位 Float32，low 为低位 Float32。
 *          满足 Math.fround(high) + Math.fround(low) ≈ value。
 *
 * @example
 * const [high, low] = splitDouble(116.3912757);
 * // high ≈ 116.390625（Float32 可精确表示）
 * // low ≈ 0.0006507（差值，也可用 Float32 表示）
 * // high + low ≈ 116.3912757（接近原始精度）
 */
export function splitDouble(value: number): [high: number, low: number] {
    // 处理特殊值
    if (!Number.isFinite(value)) {
        // NaN 和 Infinity 无法拆分，high = value, low = 0
        return [value, 0.0];
    }

    // 零值特殊处理
    if (value === 0) {
        return [0.0, 0.0];
    }

    // Veltkamp splitting 算法
    // 乘以 (2^12 + 1) 产生一个"扩展"值
    const temp = SPLITTER * value;

    // 高位部分：从 temp 中减去误差项
    // 这个减法序列确保 high 是 value 的 Float32 精度近似值
    const high = temp - (temp - value);

    // 低位部分：原始值减去高位，得到余量
    const low = value - high;

    return [high, low];
}

/**
 * 批量将 Float64Array 拆分为两个 Float32Array（高位 + 低位）。
 * 这是性能关键路径——用于处理瓦片顶点坐标的 RTC 拆分。
 * 对每个元素应用 Veltkamp splitting。
 *
 * 用途：将地理坐标（Float64 精度）拆分后分别上传到 GPU，
 * 在 shader 中用 SplitDouble 方式重组，消除远距离渲染抖动。
 *
 * @param input - 输入 Float64Array（原始双精度值）
 * @param outHigh - 输出高位 Float32Array（必须预分配，长度 ≥ input.length）
 * @param outLow - 输出低位 Float32Array（必须预分配，长度 ≥ input.length）
 * @throws 无（输出数组过短时只处理到其长度为止）
 *
 * @example
 * const positions = new Float64Array([116.3912757, 39.906217, 0.0]);
 * const high = new Float32Array(3);
 * const low = new Float32Array(3);
 * splitDoubleArray(positions, high, low);
 * // high ≈ [116.390625, 39.90625, 0]
 * // low  ≈ [0.0006507, -0.0000330, 0]
 */
export function splitDoubleArray(
    input: Float64Array,
    outHigh: Float32Array,
    outLow: Float32Array,
): void {
    // 处理长度为 0 的输入
    if (input.length === 0) {
        return;
    }

    // 取三个数组长度的最小值，确保不越界
    const len = Math.min(input.length, outHigh.length, outLow.length);

    // 批量处理每个元素
    for (let i = 0; i < len; i++) {
        const value = input[i];

        // 对特殊值快速处理
        if (!Number.isFinite(value)) {
            outHigh[i] = value;
            outLow[i] = 0.0;
            continue;
        }

        // Veltkamp splitting（内联避免函数调用开销）
        const temp = SPLITTER * value;
        const high = temp - (temp - value);
        const low = value - high;

        outHigh[i] = high;
        outLow[i] = low;
    }
}

/**
 * 将拆分后的高位和低位重组为近似原始 Float64 值。
 * 用于调试和验证——在 CPU 端检查拆分精度。
 * GPU 端在 shader 中直接做 `high + low` 即可。
 *
 * @param high - 高位 Float32 值
 * @param low - 低位 Float32 值
 * @returns 重组后的 Float64 值（high + low）
 *
 * @example
 * const [h, l] = splitDouble(116.3912757);
 * const restored = recombine(h, l);
 * Math.abs(restored - 116.3912757) < 1e-7; // → true
 */
export function recombine(high: number, low: number): number {
    // NaN 检查：如果任一部分为 NaN，结果也是 NaN
    if (high !== high || low !== low) {
        return NaN;
    }

    // 简单相加即可——高位提供主要精度，低位补充细节
    return high + low;
}
