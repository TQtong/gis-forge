// ============================================================
// math/vec4d.ts — 4D 向量运算（Float64 版本）
// 用于齐次坐标高精度计算、双精度颜色插值等场景
// 所有函数采用 out 参数模式，零内存分配（create/fromArray 除外）
// ============================================================

/** Float64 四维向量，长度为 4 的 Float64Array */
export type Vec4d = Float64Array;

/** Float32 四维向量，长度为 4 的 Float32Array（GPU 提交用） */
export type Vec4f = Float32Array;

/** 4x4 矩阵类型前向声明（transformMat4 用），列主序 Float64Array 长度 16 */
export type Mat4d = Float64Array;

/**
 * 创建一个新的 Float64 4D 向量。
 * 仅在初始化阶段调用，热路径应复用预分配的向量。
 *
 * @param x - X 分量，默认 0
 * @param y - Y 分量，默认 0
 * @param z - Z 分量，默认 0
 * @param w - W 分量，默认 0
 * @returns 新分配的 Float64Array(4)
 *
 * @example
 * const v = vec4d.create(1, 0, 0, 1); // 齐次坐标
 */
export function create(x = 0, y = 0, z = 0, w = 0): Vec4d {
    // 分配 4 元素 Float64Array
    const out = new Float64Array(4);
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = w;
    return out;
}

/**
 * 从任意类数组中提取 4 个连续元素构造 Vec4d。
 *
 * @param arr - 源数组
 * @param offset - 起始偏移量，默认 0
 * @returns 新分配的 Vec4d
 *
 * @example
 * const data = [0, 0, 1, 0, 0, 1, 2, 3];
 * const v = vec4d.fromArray(data, 4); // Float64Array [0, 1, 2, 3]
 */
export function fromArray(arr: ArrayLike<number>, offset = 0): Vec4d {
    // 从源数组偏移处拷贝 4 个分量
    const out = new Float64Array(4);
    out[0] = arr[offset];
    out[1] = arr[offset + 1];
    out[2] = arr[offset + 2];
    out[3] = arr[offset + 3];
    return out;
}

/**
 * 将 Float64 向量降精度转换为 Float32 向量。
 * 用于将 CPU 计算结果提交到 GPU Buffer。
 *
 * @param out - 目标 Float32 向量（预分配）
 * @param a - 源 Float64 向量
 * @returns out 引用
 *
 * @example
 * const gpuVec = new Float32Array(4);
 * vec4d.toFloat32(gpuVec, highPrecVec);
 */
export function toFloat32(out: Vec4f, a: Vec4d): Vec4f {
    // 隐式截断：Float64 → Float32
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[3];
    return out;
}

/**
 * 将向量 a 的值复制到 out 中。
 *
 * @param out - 目标向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * vec4d.copy(dest, src);
 */
export function copy(out: Vec4d, a: Vec4d): Vec4d {
    // 逐分量复制，保持 V8 内联友好
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    out[3] = a[3];
    return out;
}

/**
 * 用标量值设置向量的各分量。
 *
 * @param out - 目标向量（预分配）
 * @param x - X 分量
 * @param y - Y 分量
 * @param z - Z 分量
 * @param w - W 分量
 * @returns out 引用
 *
 * @example
 * vec4d.set(color, 1, 0.5, 0, 1); // 橙色 RGBA
 */
export function set(out: Vec4d, x: number, y: number, z: number, w: number): Vec4d {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = w;
    return out;
}

/**
 * 逐分量相加：out = a + b。
 *
 * @param out - 结果向量（预分配）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用
 *
 * @example
 * vec4d.add(result, [1, 2, 3, 4], [5, 6, 7, 8]); // result = [6, 8, 10, 12]
 */
export function add(out: Vec4d, a: Vec4d, b: Vec4d): Vec4d {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    out[3] = a[3] + b[3];
    return out;
}

/**
 * 逐分量相减：out = a - b。
 *
 * @param out - 结果向量（预分配）
 * @param a - 被减数
 * @param b - 减数
 * @returns out 引用
 *
 * @example
 * vec4d.sub(result, [5, 6, 7, 8], [1, 2, 3, 4]); // result = [4, 4, 4, 4]
 */
export function sub(out: Vec4d, a: Vec4d, b: Vec4d): Vec4d {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    out[3] = a[3] - b[3];
    return out;
}

/**
 * 标量缩放：out = a * s。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @param s - 缩放因子
 * @returns out 引用
 *
 * @example
 * vec4d.scale(result, [1, 2, 3, 4], 0.5); // result = [0.5, 1, 1.5, 2]
 */
export function scale(out: Vec4d, a: Vec4d, s: number): Vec4d {
    out[0] = a[0] * s;
    out[1] = a[1] * s;
    out[2] = a[2] * s;
    out[3] = a[3] * s;
    return out;
}

/**
 * 计算两个 4D 向量的点积。
 *
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns 标量点积值
 *
 * @example
 * vec4d.dot([1, 0, 0, 0], [0, 1, 0, 0]); // 0
 */
export function dot(a: Vec4d, b: Vec4d): number {
    // 4D 点积：所有分量乘积之和
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * 计算 4D 向量的欧几里得长度。
 *
 * @param a - 输入向量
 * @returns 非负长度值
 *
 * @example
 * vec4d.length([1, 2, 2, 0]); // 3
 */
export function length(a: Vec4d): number {
    // sqrt(x² + y² + z² + w²)
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
}

/**
 * 计算 4D 向量长度的平方。
 *
 * @param a - 输入向量
 * @returns 长度的平方
 *
 * @example
 * vec4d.squaredLength([1, 2, 2, 0]); // 9
 */
export function squaredLength(a: Vec4d): number {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
}

/**
 * 将向量归一化为单位向量。
 * 若输入接近零向量（长度 < 1e-12），输出零向量以避免 NaN。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * vec4d.normalize(result, [0, 0, 0, 5]); // result = [0, 0, 0, 1]
 */
export function normalize(out: Vec4d, a: Vec4d): Vec4d {
    const len = length(a);
    if (len > 1e-12) {
        // 乘以倒数避免多次除法
        const invLen = 1.0 / len;
        out[0] = a[0] * invLen;
        out[1] = a[1] * invLen;
        out[2] = a[2] * invLen;
        out[3] = a[3] * invLen;
    } else {
        // 零向量保护
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
    }
    return out;
}

/**
 * 取反：out = -a。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * vec4d.negate(result, [1, -2, 3, -4]); // result = [-1, 2, -3, 4]
 */
export function negate(out: Vec4d, a: Vec4d): Vec4d {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = -a[3];
    return out;
}

/**
 * 线性插值：out = a + t * (b - a)。
 *
 * @param out - 结果向量（预分配）
 * @param a - 起始向量（t=0）
 * @param b - 终止向量（t=1）
 * @param t - 插值因子
 * @returns out 引用
 *
 * @example
 * vec4d.lerp(result, [0, 0, 0, 0], [1, 1, 1, 1], 0.5); // result = [0.5, 0.5, 0.5, 0.5]
 */
export function lerp(out: Vec4d, a: Vec4d, b: Vec4d, t: number): Vec4d {
    // a + t*(b-a) 保证端点精确
    out[0] = a[0] + t * (b[0] - a[0]);
    out[1] = a[1] + t * (b[1] - a[1]);
    out[2] = a[2] + t * (b[2] - a[2]);
    out[3] = a[3] + t * (b[3] - a[3]);
    return out;
}

/**
 * 逐分量相乘（Hadamard 积）。
 *
 * @param out - 结果向量（预分配）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用
 *
 * @example
 * vec4d.multiply(result, [2, 3, 4, 5], [6, 7, 8, 9]); // result = [12, 21, 32, 45]
 */
export function multiply(out: Vec4d, a: Vec4d, b: Vec4d): Vec4d {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    out[2] = a[2] * b[2];
    out[3] = a[3] * b[3];
    return out;
}

/**
 * 用 4x4 列主序矩阵变换 4D 向量：out = M * a。
 * 不做透视除法（保留齐次坐标 w 分量）。
 *
 * @param out - 结果向量（预分配，可与 a 相同）
 * @param a - 源 4D 向量
 * @param m - 4x4 列主序变换矩阵
 * @returns out 引用
 *
 * @example
 * const clipPos = vec4d.create();
 * vec4d.transformMat4(clipPos, [x, y, z, 1], mvpMatrix);
 */
export function transformMat4(out: Vec4d, a: Vec4d, m: Mat4d): Vec4d {
    // 缓存输入分量，以防 out === a
    const x = a[0], y = a[1], z = a[2], w = a[3];
    // 列主序矩阵乘法：result = M * v
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
}

/**
 * 判断两个向量是否在误差范围内相等。
 * Float64 版本默认使用更严格的 epsilon（1e-12）。
 *
 * @param a - 向量 A
 * @param b - 向量 B
 * @param epsilon - 容差阈值，默认 1e-12
 * @returns 若所有分量差值均 ≤ epsilon 则为 true
 *
 * @example
 * vec4d.equals([1, 2, 3, 4], [1, 2, 3, 4.0000000000001]); // true
 */
export function equals(a: Vec4d, b: Vec4d, epsilon = 1e-12): boolean {
    // 逐分量绝对差值检查，短路求值
    return Math.abs(a[0] - b[0]) <= epsilon
        && Math.abs(a[1] - b[1]) <= epsilon
        && Math.abs(a[2] - b[2]) <= epsilon
        && Math.abs(a[3] - b[3]) <= epsilon;
}

declare const __DEV__: boolean;
