// ============================================================
// math/vec4.ts — 4D 向量运算（Float32 版本）
// 用于齐次坐标、颜色 RGBA、视锥体平面等场景
// 所有函数采用 out 参数模式，零内存分配（create/fromArray 除外）
// ============================================================

/** Float32 四维向量，长度为 4 的 Float32Array */
export type Vec4f = Float32Array;

/** Float64 四维向量，长度为 4 的 Float64Array（CPU 精确计算用） */
export type Vec4d = Float64Array;

/** 4x4 矩阵类型前向声明（transformMat4 用），列主序 Float32Array 长度 16 */
export type Mat4f = Float32Array;

/**
 * 创建一个新的 4D 向量。
 * 仅在初始化阶段调用，热路径应复用预分配的向量。
 *
 * @param x - X 分量，默认 0
 * @param y - Y 分量，默认 0
 * @param z - Z 分量，默认 0
 * @param w - W 分量，默认 0
 * @returns 新分配的 Float32Array(4)
 *
 * @example
 * const v = vec4.create(1, 0, 0, 1); // RGBA 红色不透明
 */
export function create(x = 0, y = 0, z = 0, w = 0): Vec4f {
    // 分配 4 元素 Float32Array
    const out = new Float32Array(4);
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = w;
    return out;
}

/**
 * 从任意类数组中提取 4 个连续元素构造 Vec4f。
 *
 * @param arr - 源数组
 * @param offset - 起始偏移量，默认 0
 * @returns 新分配的 Vec4f
 *
 * @example
 * const data = [0, 0, 1, 0, 0, 1, 2, 3];
 * const v = vec4.fromArray(data, 4); // Float32Array [0, 1, 2, 3]
 */
export function fromArray(arr: ArrayLike<number>, offset = 0): Vec4f {
    // 从源数组偏移处拷贝 4 个分量
    const out = new Float32Array(4);
    out[0] = arr[offset];
    out[1] = arr[offset + 1];
    out[2] = arr[offset + 2];
    out[3] = arr[offset + 3];
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
 * vec4.copy(dest, src);
 */
export function copy(out: Vec4f, a: Vec4f): Vec4f {
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
 * vec4.set(color, 1, 0.5, 0, 1); // 橙色 RGBA
 */
export function set(out: Vec4f, x: number, y: number, z: number, w: number): Vec4f {
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
 * vec4.add(result, [1, 2, 3, 4], [5, 6, 7, 8]); // result = [6, 8, 10, 12]
 */
export function add(out: Vec4f, a: Vec4f, b: Vec4f): Vec4f {
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
 * vec4.sub(result, [5, 6, 7, 8], [1, 2, 3, 4]); // result = [4, 4, 4, 4]
 */
export function sub(out: Vec4f, a: Vec4f, b: Vec4f): Vec4f {
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
 * vec4.scale(result, [1, 2, 3, 4], 0.5); // result = [0.5, 1, 1.5, 2]
 */
export function scale(out: Vec4f, a: Vec4f, s: number): Vec4f {
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
 * vec4.dot([1, 0, 0, 0], [0, 1, 0, 0]); // 0
 */
export function dot(a: Vec4f, b: Vec4f): number {
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
 * vec4.length([1, 2, 2, 0]); // 3
 */
export function length(a: Vec4f): number {
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
 * vec4.squaredLength([1, 2, 2, 0]); // 9
 */
export function squaredLength(a: Vec4f): number {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
}

/**
 * 将向量归一化为单位向量。
 * 若输入接近零向量，输出零向量以避免 NaN。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * vec4.normalize(result, [0, 0, 0, 5]); // result = [0, 0, 0, 1]
 */
export function normalize(out: Vec4f, a: Vec4f): Vec4f {
    const len = length(a);
    if (len > 1e-6) {
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
 * vec4.negate(result, [1, -2, 3, -4]); // result = [-1, 2, -3, 4]
 */
export function negate(out: Vec4f, a: Vec4f): Vec4f {
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
 * vec4.lerp(result, [0, 0, 0, 0], [1, 1, 1, 1], 0.5); // result = [0.5, 0.5, 0.5, 0.5]
 */
export function lerp(out: Vec4f, a: Vec4f, b: Vec4f, t: number): Vec4f {
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
 * vec4.multiply(result, [2, 3, 4, 5], [6, 7, 8, 9]); // result = [12, 21, 32, 45]
 */
export function multiply(out: Vec4f, a: Vec4f, b: Vec4f): Vec4f {
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
 * const clipPos = vec4.create();
 * vec4.transformMat4(clipPos, [x, y, z, 1], mvpMatrix);
 */
export function transformMat4(out: Vec4f, a: Vec4f, m: Mat4f): Vec4f {
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
 *
 * @param a - 向量 A
 * @param b - 向量 B
 * @param epsilon - 容差阈值，默认 1e-6
 * @returns 若所有分量差值均 ≤ epsilon 则为 true
 *
 * @example
 * vec4.equals([1, 2, 3, 4], [1, 2, 3, 4.0000001]); // true
 */
export function equals(a: Vec4f, b: Vec4f, epsilon = 1e-6): boolean {
    // 逐分量绝对差值检查，短路求值
    return Math.abs(a[0] - b[0]) <= epsilon
        && Math.abs(a[1] - b[1]) <= epsilon
        && Math.abs(a[2] - b[2]) <= epsilon
        && Math.abs(a[3] - b[3]) <= epsilon;
}
