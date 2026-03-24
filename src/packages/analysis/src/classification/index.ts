// ============================================================
// analysis/classification/index.ts — 数据分类
// 职责：为连续数值数据提供分级分类方法（Jenks/等距/分位数/标准差）。
// 用于地图专题制图中的色彩分级（choropleth）。
// 依赖层级：analysis 可选分析包，不消费外部类型。
// ============================================================

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const CLASS_ERROR_CODES = {
    /** 输入数据为空或无效 */
    INVALID_DATA: 'CLASS_INVALID_DATA',
    /** 分类数无效 */
    INVALID_NUM_CLASSES: 'CLASS_INVALID_NUM_CLASSES',
    /** 标准差乘数无效 */
    INVALID_MULTIPLIER: 'CLASS_INVALID_MULTIPLIER',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 最小分类数——至少分 2 类才有意义 */
const MIN_CLASSES = 2;

/** 最大分类数——超过 20 类通常无实际意义 */
const MAX_CLASSES = 20;

/** 标准差乘数下限 */
const MIN_STD_MULTIPLIER = 0.25;

/** 标准差乘数上限 */
const MAX_STD_MULTIPLIER = 3.0;

// ---------------------------------------------------------------------------
// ClassificationOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 数据分类运算集合。
 * 提供 Jenks 自然断裂、等距分类、分位数分类、标准差分类四种方法。
 * 每个方法返回断裂点数组（包含最小值和最大值，长度 = numClasses + 1）。
 *
 * @stability experimental
 *
 * @example
 * const breaks = ClassificationOps.jenks([1,2,3,10,11,12,50,51,52], 3);
 * // → [1, 3, 12, 52] — 三类：[1-3], (3-12], (12-52]
 */
export const ClassificationOps = {
    /**
     * Jenks 自然断裂分类（Fisher-Jenks 动态规划优化）。
     * 通过最小化组内方差来确定最优的类别断裂点。
     * 时间复杂度 O(n² × k)，适用于中等规模数据集。
     *
     * 算法核心：
     * 1. 对数据排序
     * 2. 构建组内方差矩阵（DP 递推）
     * 3. 回溯最优断裂点
     *
     * @param data - 数值数组（会自动过滤 NaN/Infinity）
     * @param numClasses - 分类数量，范围 [2, 20]
     * @returns 断裂点数组（长度 = numClasses + 1），包含 min 和 max
     *
     * @stability experimental
     *
     * @example
     * ClassificationOps.jenks([1,5,10,15,30,50,55,60,100], 3);
     * // → [1, 15, 60, 100]
     */
    jenks(data: readonly number[], numClasses: number): number[] {
        // 校验输入
        if (!data || data.length === 0) {
            if (__DEV__) {
                console.warn(`[${CLASS_ERROR_CODES.INVALID_DATA}] 数据数组不能为空`);
            }
            return [];
        }

        // 过滤无效值
        const valid = data.filter(v => isFinite(v));
        if (valid.length === 0) {
            return [];
        }

        // 校验分类数
        const k = Math.round(Math.max(MIN_CLASSES, Math.min(MAX_CLASSES, numClasses)));

        // 如果数据量不足以分成 k 类，降低类数
        if (valid.length <= k) {
            // 每个值一个类
            const sorted = [...valid].sort((a, b) => a - b);
            const unique = [...new Set(sorted)];
            return unique.length > 0 ? unique : [];
        }

        // 排序
        const sorted = [...valid].sort((a, b) => a - b);
        const n = sorted.length;

        // 构建两个 DP 矩阵：
        // lowerClassLimits[i][j] = 使前 i 个元素分成 j 类时，最后一类的起始索引
        // varianceCombinations[i][j] = 使前 i 个元素分成 j 类时的最小组内方差和
        const lowerClassLimits: number[][] = [];
        const varianceCombinations: number[][] = [];

        for (let i = 0; i <= n; i++) {
            const row1 = new Array<number>(k + 1).fill(0);
            const row2 = new Array<number>(k + 1).fill(Infinity);
            lowerClassLimits.push(row1);
            varianceCombinations.push(row2);
        }

        // 基础情况：1 类时方差为前 i 个元素的方差
        varianceCombinations[0]![0] = 0;

        for (let i = 1; i <= n; i++) {
            // 计算从索引 1 到 i 的元素分成 1 类的方差
            let sumX = 0;
            let sumX2 = 0;
            for (let m = 1; m <= i; m++) {
                const val = sorted[m - 1]!;
                sumX += val;
                sumX2 += val * val;
            }
            // 方差 = Σx² - (Σx)²/n
            varianceCombinations[i]![1] = sumX2 - (sumX * sumX) / i;
            lowerClassLimits[i]![1] = 1;
        }

        // DP 填表：对于 j=2..k 类，i=j..n 个元素
        for (let j = 2; j <= k; j++) {
            for (let i = j; i <= n; i++) {
                let bestVariance = Infinity;
                let bestLower = j;

                // 尝试所有可能的最后一类起始位置 m
                // 前 m-1 个元素分成 j-1 类 + 第 m..i 个元素为第 j 类
                let sumX = 0;
                let sumX2 = 0;

                for (let m = i; m >= j; m--) {
                    // 逐步扩展最后一类（从右往左加入元素）
                    const val = sorted[m - 1]!;
                    sumX += val;
                    sumX2 += val * val;
                    const count = i - m + 1;

                    // 最后一类的方差
                    const lastClassVariance = sumX2 - (sumX * sumX) / count;

                    // 前 m-1 个元素分成 j-1 类的最优方差
                    const prevVariance = varianceCombinations[m - 1]![j - 1]!;

                    const totalVariance = prevVariance + lastClassVariance;

                    if (totalVariance < bestVariance) {
                        bestVariance = totalVariance;
                        bestLower = m;
                    }
                }

                varianceCombinations[i]![j] = bestVariance;
                lowerClassLimits[i]![j] = bestLower;
            }
        }

        // 回溯断裂点
        const breaks: number[] = new Array<number>(k + 1);
        breaks[0] = sorted[0]!;
        breaks[k] = sorted[n - 1]!;

        let kk = k;
        let idx = n;
        while (kk > 1) {
            const lower = lowerClassLimits[idx]![kk]!;
            // 断裂点为 lower 位置对应的值
            breaks[kk - 1] = sorted[lower - 1]!;
            idx = lower - 1;
            kk--;
        }

        return breaks;
    },

    /**
     * 等距分类——将数据范围等分为指定数量的区间。
     * 最简单的分类方法，每个类的取值跨度相同。
     *
     * @param data - 数值数组
     * @param numClasses - 分类数量
     * @returns 断裂点数组（长度 = numClasses + 1）
     *
     * @stability stable
     *
     * @example
     * ClassificationOps.equalInterval([1, 100], 4);
     * // → [1, 25.75, 50.5, 75.25, 100]
     */
    equalInterval(data: readonly number[], numClasses: number): number[] {
        // 校验输入
        if (!data || data.length === 0) {
            if (__DEV__) {
                console.warn(`[${CLASS_ERROR_CODES.INVALID_DATA}] 数据数组不能为空`);
            }
            return [];
        }

        const valid = data.filter(v => isFinite(v));
        if (valid.length === 0) {
            return [];
        }

        const k = Math.round(Math.max(MIN_CLASSES, Math.min(MAX_CLASSES, numClasses)));

        // 找最小值和最大值
        let min = Infinity;
        let max = -Infinity;
        for (const v of valid) {
            if (v < min) min = v;
            if (v > max) max = v;
        }

        // 等距切分
        const interval = (max - min) / k;
        const breaks: number[] = [];
        for (let i = 0; i <= k; i++) {
            breaks.push(min + i * interval);
        }

        // 确保最后一个断裂点精确等于 max（避免浮点误差）
        breaks[k] = max;

        return breaks;
    },

    /**
     * 分位数分类——每个类包含相同数量的数据点。
     * 适用于偏态分布数据，确保每个类别的视觉权重均匀。
     *
     * @param data - 数值数组
     * @param numClasses - 分类数量
     * @returns 断裂点数组（长度 = numClasses + 1）
     *
     * @stability stable
     *
     * @example
     * ClassificationOps.quantile([1,2,3,4,5,6,7,8,9,10], 4);
     * // → [1, 3, 5, 8, 10]（每组约 2-3 个值）
     */
    quantile(data: readonly number[], numClasses: number): number[] {
        // 校验输入
        if (!data || data.length === 0) {
            if (__DEV__) {
                console.warn(`[${CLASS_ERROR_CODES.INVALID_DATA}] 数据数组不能为空`);
            }
            return [];
        }

        const valid = data.filter(v => isFinite(v));
        if (valid.length === 0) {
            return [];
        }

        const k = Math.round(Math.max(MIN_CLASSES, Math.min(MAX_CLASSES, numClasses)));

        // 排序
        const sorted = [...valid].sort((a, b) => a - b);
        const n = sorted.length;

        // 计算分位点——每个分位点对应 n/k 处的值
        const breaks: number[] = [sorted[0]!];
        for (let i = 1; i < k; i++) {
            // 分位数索引（使用线性插值计算非整数位置）
            const q = (i / k) * (n - 1);
            const lower = Math.floor(q);
            const upper = Math.ceil(q);
            const fraction = q - lower;

            // 线性插值——当 q 恰好为整数时 fraction=0，直接取值
            const value = sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
            breaks.push(value);
        }
        breaks.push(sorted[n - 1]!);

        return breaks;
    },

    /**
     * 标准差分类——以均值为中心，按标准差的倍数划分区间。
     * 适用于正态分布数据，清晰展示偏离均值的程度。
     *
     * @param data - 数值数组
     * @param multiplier - 标准差倍数（每个类的宽度 = multiplier × σ），范围 [0.25, 3.0]
     * @returns 断裂点数组
     *
     * @stability experimental
     *
     * @example
     * ClassificationOps.standardDeviation([1,2,3,4,5,6,7,8,9,10], 1);
     * // 均值=5.5, σ≈2.87 → 断裂点 ≈ [1, 2.63, 5.5, 8.37, 10]
     */
    standardDeviation(data: readonly number[], multiplier: number = 1): number[] {
        // 校验输入
        if (!data || data.length === 0) {
            if (__DEV__) {
                console.warn(`[${CLASS_ERROR_CODES.INVALID_DATA}] 数据数组不能为空`);
            }
            return [];
        }

        const valid = data.filter(v => isFinite(v));
        if (valid.length === 0) {
            return [];
        }

        // 校验乘数
        const safeMult = Math.max(
            MIN_STD_MULTIPLIER,
            Math.min(MAX_STD_MULTIPLIER, isFinite(multiplier) ? multiplier : 1)
        );

        // 计算均值
        let sum = 0;
        for (const v of valid) {
            sum += v;
        }
        const mean = sum / valid.length;

        // 计算标准差
        let sumSq = 0;
        for (const v of valid) {
            const diff = v - mean;
            sumSq += diff * diff;
        }
        const stddev = Math.sqrt(sumSq / valid.length);

        // 零标准差（所有值相同）时返回单一断裂点
        if (stddev === 0) {
            return [mean, mean];
        }

        // 计算数据范围
        let min = Infinity;
        let max = -Infinity;
        for (const v of valid) {
            if (v < min) min = v;
            if (v > max) max = v;
        }

        // 从均值向两侧扩展，每步 multiplier × σ
        const breaks: number[] = [mean];
        const step = safeMult * stddev;

        // 向下扩展
        let current = mean - step;
        while (current > min) {
            breaks.unshift(current);
            current -= step;
        }
        // 确保包含最小值
        if (breaks[0]! > min) {
            breaks.unshift(min);
        }

        // 向上扩展
        current = mean + step;
        while (current < max) {
            breaks.push(current);
            current += step;
        }
        // 确保包含最大值
        if (breaks[breaks.length - 1]! < max) {
            breaks.push(max);
        }

        return breaks;
    },
} as const;

export { ClassificationOps as classificationOps };
