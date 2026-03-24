// ============================================================
// math/vec2d.ts — 2D 向量运算（Float64 版本）
// 所有函数采用 out 参数模式，零内存分配（create/fromArray 除外）
// Float64 精度用于 CPU 坐标计算（WGS84 经纬度、墨卡托高精度等场景）
// ============================================================

/** Float64 二维向量，长度为 2 的 Float64Array */
export type Vec2d = Float64Array;

/** Float32 二维向量，长度为 2 的 Float32Array（GPU 提交用） */
export type Vec2f = Float32Array;

/** 3x3 矩阵类型前向声明（transformMat3 用），列主序 Float64Array 长度 9 */
export type Mat3d = Float64Array;

/**
 * 创建一个新的 Float64 2D 向量。
 * 这是唯一允许 new Float64Array 的地方——用于初始化阶段，不在热路径调用。
 *
 * @param x - X 分量，默认 0
 * @param y - Y 分量，默认 0
 * @returns 新分配的 Float64Array(2)
 *
 * @example
 * const v = vec2d.create(116.397, 39.907); // WGS84 经纬度
 */
export function create(x = 0, y = 0): Vec2d {
    // 分配 2 元素的 Float64Array 并设初值
    const out = new Float64Array(2);
    out[0] = x;
    out[1] = y;
    return out;
}

/**
 * 从任意类数组中提取 2 个连续元素构造 Vec2d。
 * 常用于从平铺坐标数组中提取高精度坐标。
 *
 * @param arr - 源数组（Float64Array / number[] 等）
 * @param offset - 起始偏移量，默认 0
 * @returns 新分配的 Vec2d
 *
 * @example
 * const coords = [116.397, 39.907, 121.473, 31.230];
 * const v = vec2d.fromArray(coords, 2); // Float64Array [121.473, 31.230]
 */
export function fromArray(arr: ArrayLike<number>, offset = 0): Vec2d {
    // 分配新向量并从源数组指定偏移处拷贝
    const out = new Float64Array(2);
    out[0] = arr[offset];
    out[1] = arr[offset + 1];
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
 * const gpuVec = new Float32Array(2);
 * vec2d.toFloat32(gpuVec, highPrecisionPos);
 */
export function toFloat32(out: Vec2f, a: Vec2d): Vec2f {
    // 隐式截断：Float64 → Float32 会丢失尾数精度
    out[0] = a[0];
    out[1] = a[1];
    return out;
}

/**
 * 将向量 a 的值复制到 out 中。
 * 用于在不分配新内存的情况下保存向量快照。
 *
 * @param out - 目标向量（预分配）
 * @param a - 源向量
 * @returns out 引用，便于链式调用
 *
 * @example
 * const backup = vec2d.create();
 * vec2d.copy(backup, position);
 */
export function copy(out: Vec2d, a: Vec2d): Vec2d {
    // 逐分量复制，避免 TypedArray.set 的函数调用开销
    out[0] = a[0];
    out[1] = a[1];
    return out;
}

/**
 * 用标量值设置向量的各分量。
 *
 * @param out - 目标向量（预分配）
 * @param x - X 分量
 * @param y - Y 分量
 * @returns out 引用
 *
 * @example
 * const v = vec2d.create();
 * vec2d.set(v, 116.397, 39.907);
 */
export function set(out: Vec2d, x: number, y: number): Vec2d {
    out[0] = x;
    out[1] = y;
    return out;
}

/**
 * 逐分量相加：out = a + b。
 *
 * @param out - 结果向量（预分配，可与 a 或 b 相同）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用
 *
 * @example
 * const result = vec2d.create();
 * vec2d.add(result, [1, 2], [3, 4]); // result = [4, 6]
 */
export function add(out: Vec2d, a: Vec2d, b: Vec2d): Vec2d {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
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
 * const result = vec2d.create();
 * vec2d.sub(result, [5, 7], [2, 3]); // result = [3, 4]
 */
export function sub(out: Vec2d, a: Vec2d, b: Vec2d): Vec2d {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    return out;
}

/**
 * 标量缩放：out = a * s。
 * 将向量每个分量乘以标量 s。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @param s - 缩放因子
 * @returns out 引用
 *
 * @example
 * const result = vec2d.create();
 * vec2d.scale(result, [3, 4], 2); // result = [6, 8]
 */
export function scale(out: Vec2d, a: Vec2d, s: number): Vec2d {
    out[0] = a[0] * s;
    out[1] = a[1] * s;
    return out;
}

/**
 * 计算两个 2D 向量的点积（内积）。
 * 点积 = |a||b|cos(θ)，可用于判断方向关系。
 *
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns 标量点积值
 *
 * @example
 * vec2d.dot([1, 0], [0, 1]); // 0（正交）
 * vec2d.dot([1, 0], [1, 0]); // 1（同向）
 */
export function dot(a: Vec2d, b: Vec2d): number {
    // 2D 点积：x1*x2 + y1*y2
    return a[0] * b[0] + a[1] * b[1];
}

/**
 * 计算 2D 向量的欧几里得长度（模）。
 * 内部使用 Math.sqrt，如果只需比较大小请用 squaredLength 避免开方。
 *
 * @param a - 输入向量
 * @returns 非负长度值
 *
 * @example
 * vec2d.length([3, 4]); // 5
 */
export function length(a: Vec2d): number {
    // sqrt(x² + y²)，Float64 下精度损失可忽略
    return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

/**
 * 计算 2D 向量长度的平方。
 * 避免 sqrt 开销，适用于距离比较等场景。
 *
 * @param a - 输入向量
 * @returns 长度的平方（非负）
 *
 * @example
 * vec2d.squaredLength([3, 4]); // 25
 */
export function squaredLength(a: Vec2d): number {
    return a[0] * a[0] + a[1] * a[1];
}

/**
 * 将向量归一化为单位向量（长度为 1）。
 * 若输入接近零向量（长度 < 1e-12），则输出零向量以避免 NaN。
 * Float64 版本使用更严格的零向量阈值（1e-12 vs Float32 的 1e-6）。
 *
 * @param out - 结果单位向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * const n = vec2d.create();
 * vec2d.normalize(n, [3, 4]); // n ≈ [0.6, 0.8]
 */
export function normalize(out: Vec2d, a: Vec2d): Vec2d {
    const len = length(a);
    if (len > 1e-12) {
        // 用乘以倒数代替除法——乘法比除法快约 3 倍（V8 微基准）
        const invLen = 1.0 / len;
        out[0] = a[0] * invLen;
        out[1] = a[1] * invLen;
    } else {
        // 零向量或近零向量，避免除零产生 NaN/Infinity
        out[0] = 0;
        out[1] = 0;
    }
    return out;
}

/**
 * 取反：out = -a，即每个分量取负。
 *
 * @param out - 结果向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * const neg = vec2d.create();
 * vec2d.negate(neg, [3, -4]); // neg = [-3, 4]
 */
export function negate(out: Vec2d, a: Vec2d): Vec2d {
    out[0] = -a[0];
    out[1] = -a[1];
    return out;
}

/**
 * 线性插值（Lerp）：out = a + t * (b - a)。
 * t=0 返回 a，t=1 返回 b，t=0.5 返回中点。
 *
 * @param out - 结果向量（预分配）
 * @param a - 起始向量（t=0）
 * @param b - 终止向量（t=1）
 * @param t - 插值因子，通常在 [0, 1] 范围内
 * @returns out 引用
 *
 * @example
 * const mid = vec2d.create();
 * vec2d.lerp(mid, [0, 0], [10, 10], 0.5); // mid = [5, 5]
 */
export function lerp(out: Vec2d, a: Vec2d, b: Vec2d, t: number): Vec2d {
    // 使用 a + t*(b-a) 形式，一次乘法 + 一次加法，数值稳定
    out[0] = a[0] + t * (b[0] - a[0]);
    out[1] = a[1] + t * (b[1] - a[1]);
    return out;
}

/**
 * 计算两点之间的欧几里得距离。
 *
 * @param a - 点 A
 * @param b - 点 B
 * @returns 非负距离值
 *
 * @example
 * vec2d.distance([0, 0], [3, 4]); // 5
 */
export function distance(a: Vec2d, b: Vec2d): number {
    // 先计算各分量差值，再求模
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 计算两点之间距离的平方。
 * 避免 sqrt 开销，适用于距离比较排序。
 *
 * @param a - 点 A
 * @param b - 点 B
 * @returns 距离的平方（非负）
 *
 * @example
 * vec2d.squaredDistance([0, 0], [3, 4]); // 25
 */
export function squaredDistance(a: Vec2d, b: Vec2d): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return dx * dx + dy * dy;
}

/**
 * 逐分量相乘（Hadamard 积）：out[i] = a[i] * b[i]。
 * 注意这不是点积，而是逐元素乘法。
 *
 * @param out - 结果向量（预分配）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用
 *
 * @example
 * const result = vec2d.create();
 * vec2d.multiply(result, [2, 3], [4, 5]); // result = [8, 15]
 */
export function multiply(out: Vec2d, a: Vec2d, b: Vec2d): Vec2d {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    return out;
}

/**
 * 逐分量取最小值：out[i] = min(a[i], b[i])。
 * 常用于计算 AABB 包围盒的最小角点。
 *
 * @param out - 结果向量（预分配）
 * @param a - 向量 A
 * @param b - 向量 B
 * @returns out 引用
 *
 * @example
 * const lo = vec2d.create();
 * vec2d.min(lo, [1, 5], [3, 2]); // lo = [1, 2]
 */
export function min(out: Vec2d, a: Vec2d, b: Vec2d): Vec2d {
    out[0] = Math.min(a[0], b[0]);
    out[1] = Math.min(a[1], b[1]);
    return out;
}

/**
 * 逐分量取最大值：out[i] = max(a[i], b[i])。
 * 常用于计算 AABB 包围盒的最大角点。
 *
 * @param out - 结果向量（预分配）
 * @param a - 向量 A
 * @param b - 向量 B
 * @returns out 引用
 *
 * @example
 * const hi = vec2d.create();
 * vec2d.max(hi, [1, 5], [3, 2]); // hi = [3, 5]
 */
export function max(out: Vec2d, a: Vec2d, b: Vec2d): Vec2d {
    out[0] = Math.max(a[0], b[0]);
    out[1] = Math.max(a[1], b[1]);
    return out;
}

/**
 * 将 2D 向量绕原点旋转指定弧度。
 * 使用 2D 旋转矩阵公式：
 *   x' = x*cos(θ) - y*sin(θ)
 *   y' = x*sin(θ) + y*cos(θ)
 *
 * @param out - 结果向量（预分配，可与 a 相同）
 * @param a - 源向量
 * @param rad - 旋转角度（弧度），正值为逆时针
 * @returns out 引用
 *
 * @example
 * const rotated = vec2d.create();
 * vec2d.rotate(rotated, [1, 0], Math.PI / 2); // rotated ≈ [0, 1]
 */
export function rotate(out: Vec2d, a: Vec2d, rad: number): Vec2d {
    // 预计算三角函数，避免重复调用
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // 缓存原始值，以防 out === a（就地旋转）
    const ax = a[0];
    const ay = a[1];
    // 应用 2D 旋转矩阵
    out[0] = ax * cos - ay * sin;
    out[1] = ax * sin + ay * cos;
    return out;
}

/**
 * 判断两个向量是否在误差范围内相等。
 * 使用逐分量绝对误差比较，适用于浮点精度场景。
 * Float64 版本默认使用更严格的 epsilon（1e-12 vs Float32 的 1e-6）。
 *
 * @param a - 向量 A
 * @param b - 向量 B
 * @param epsilon - 容差阈值，默认 1e-12
 * @returns 若所有分量差值均 ≤ epsilon 则为 true
 *
 * @example
 * vec2d.equals([1, 2], [1.0000000000001, 2.0000000000001]); // true
 * vec2d.equals([1, 2], [1.1, 2.0]);                          // false
 */
export function equals(a: Vec2d, b: Vec2d, epsilon = 1e-12): boolean {
    // 逐分量绝对差值检查，短路求值优化
    return Math.abs(a[0] - b[0]) <= epsilon
        && Math.abs(a[1] - b[1]) <= epsilon;
}

/**
 * 用 3x3 矩阵变换 2D 向量（齐次坐标 w=1）。
 * 矩阵为列主序存储，适用于 2D 仿射变换（平移、旋转、缩放、错切）。
 *
 * 列主序 3x3 矩阵索引：
 * | m[0] m[3] m[6] |
 * | m[1] m[4] m[7] |
 * | m[2] m[5] m[8] |
 *
 * 齐次坐标：[x, y, 1] * M = [x', y', w']，最终 x''/=w', y''/=w'
 *
 * @param out - 结果向量（预分配，可与 a 相同）
 * @param a - 源 2D 向量
 * @param m - 3x3 列主序变换矩阵
 * @returns out 引用
 *
 * @example
 * const translated = vec2d.create();
 * const mat = new Float64Array([1,0,0, 0,1,0, 10,20,1]);
 * vec2d.transformMat3(translated, [5, 5], mat); // translated = [15, 25]
 */
export function transformMat3(out: Vec2d, a: Vec2d, m: Mat3d): Vec2d {
    // 缓存输入分量，以防 out === a
    const ax = a[0];
    const ay = a[1];
    // 列主序矩阵乘法：result = M * [x, y, 1]^T
    // x' = m[0]*x + m[3]*y + m[6]*1
    // y' = m[1]*x + m[4]*y + m[7]*1
    out[0] = m[0] * ax + m[3] * ay + m[6];
    out[1] = m[1] * ax + m[4] * ay + m[7];
    return out;
}

declare const __DEV__: boolean;
