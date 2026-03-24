// ============================================================
// math/vec3d.ts — 3D 向量运算（Float64 版本）
// 所有函数采用 out 参数模式，零内存分配（create/fromArray 除外）
// Float64 精度用于 CPU 坐标计算（ECEF、Split-Double、WGS84 等场景）
// 与 WGSL vec3<f32> 配合时需经 toFloat32 降精度
// ============================================================

/** Float64 三维向量，长度为 3 的 Float64Array */
export type Vec3d = Float64Array;

/** Float32 三维向量，长度为 3 的 Float32Array（GPU 提交用） */
export type Vec3f = Float32Array;

/** 4x4 矩阵类型前向声明（transformMat4 用），列主序 Float64Array 长度 16 */
export type Mat4d = Float64Array;

/** 四元数类型前向声明（transformQuat 用），Float64Array 长度 4 [x,y,z,w] */
export type Quatd = Float64Array;

/**
 * 创建一个新的 Float64 3D 向量。
 * 仅在初始化阶段调用，热路径应复用预分配的向量。
 *
 * @param x - X 分量，默认 0
 * @param y - Y 分量，默认 0
 * @param z - Z 分量，默认 0
 * @returns 新分配的 Float64Array(3)
 *
 * @example
 * const v = vec3d.create(1, 2, 3); // Float64Array [1, 2, 3]
 */
export function create(x = 0, y = 0, z = 0): Vec3d {
    // 分配 3 元素 Float64Array 并设初值
    const out = new Float64Array(3);
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}

/**
 * 从任意类数组中提取 3 个连续元素构造 Vec3d。
 * 用于从 ECEF 坐标数组或交错顶点数据中提取高精度坐标。
 *
 * @param arr - 源数组（Float64Array / number[] 等）
 * @param offset - 起始偏移量，默认 0
 * @returns 新分配的 Vec3d
 *
 * @example
 * const ecef = [-2694892.1, 4297728.4, 3854036.5, 0, 0, 0];
 * const v = vec3d.fromArray(ecef, 0); // 北京的 ECEF 坐标
 */
export function fromArray(arr: ArrayLike<number>, offset = 0): Vec3d {
    // 从源数组偏移处拷贝 3 个分量到新向量
    const out = new Float64Array(3);
    out[0] = arr[offset];
    out[1] = arr[offset + 1];
    out[2] = arr[offset + 2];
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
 * const gpuVec = new Float32Array(3);
 * vec3d.toFloat32(gpuVec, ecefPosition);
 */
export function toFloat32(out: Vec3f, a: Vec3d): Vec3f {
    // 隐式截断：Float64 → Float32 会丢失尾数精度
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
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
 * const snapshot = vec3d.create();
 * vec3d.copy(snapshot, cameraPosition);
 */
export function copy(out: Vec3d, a: Vec3d): Vec3d {
    // 逐分量复制，比 TypedArray.set() 更利于 V8 内联
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}

/**
 * 用标量值设置向量的各分量。
 *
 * @param out - 目标向量（预分配）
 * @param x - X 分量
 * @param y - Y 分量
 * @param z - Z 分量
 * @returns out 引用
 *
 * @example
 * vec3d.set(v, 1, 0, 0); // v = [1, 0, 0]（X 轴单位向量）
 */
export function set(out: Vec3d, x: number, y: number, z: number): Vec3d {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}

/**
 * 逐分量相加：out = a + b。
 *
 * @param out - 结果向量（预分配，可与 a/b 相同）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用
 *
 * @example
 * vec3d.add(result, [1, 2, 3], [4, 5, 6]); // result = [5, 7, 9]
 */
export function add(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
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
 * vec3d.sub(result, [5, 7, 9], [1, 2, 3]); // result = [4, 5, 6]
 */
export function sub(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
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
 * vec3d.scale(result, [1, 2, 3], 2); // result = [2, 4, 6]
 */
export function scale(out: Vec3d, a: Vec3d, s: number): Vec3d {
    out[0] = a[0] * s;
    out[1] = a[1] * s;
    out[2] = a[2] * s;
    return out;
}

/**
 * 计算两个 3D 向量的点积。
 * 结果为标量，等于 |a||b|cos(θ)。
 *
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns 标量点积值
 *
 * @example
 * vec3d.dot([1, 0, 0], [0, 1, 0]); // 0（正交）
 */
export function dot(a: Vec3d, b: Vec3d): number {
    // 3D 点积：x1*x2 + y1*y2 + z1*z2
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 计算两个 3D 向量的叉积（Cross Product）。
 * 结果向量垂直于 a 和 b 所在平面，方向遵循右手定则。
 *
 * @param out - 输出向量（预分配，避免 GC）
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns out 引用，便于链式调用
 *
 * @example
 * const result = vec3d.create();
 * vec3d.cross(result, [1, 0, 0], [0, 1, 0]); // result = [0, 0, 1]
 */
export function cross(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    // 缓存分量到局部变量，避免数组多次寻址（V8 优化友好）
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    // 叉积公式：(ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx)
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}

/**
 * 计算 3D 向量的欧几里得长度（模）。
 *
 * @param a - 输入向量
 * @returns 非负长度值
 *
 * @example
 * vec3d.length([1, 2, 2]); // 3
 */
export function length(a: Vec3d): number {
    // sqrt(x² + y² + z²)
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/**
 * 计算 3D 向量长度的平方。
 * 避免 sqrt 开销，适用于距离比较场景。
 *
 * @param a - 输入向量
 * @returns 长度的平方（非负）
 *
 * @example
 * vec3d.squaredLength([1, 2, 2]); // 9
 */
export function squaredLength(a: Vec3d): number {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

/**
 * 将向量归一化为单位向量（长度为 1）。
 * 若输入接近零向量（长度 < 1e-12），则输出零向量以避免 NaN。
 * Float64 版本使用更严格的零向量阈值。
 *
 * @param out - 结果单位向量（预分配）
 * @param a - 源向量
 * @returns out 引用
 *
 * @example
 * const n = vec3d.create();
 * vec3d.normalize(n, [0, 0, 5]); // n = [0, 0, 1]
 */
export function normalize(out: Vec3d, a: Vec3d): Vec3d {
    const len = length(a);
    if (len > 1e-12) {
        // 乘以倒数代替除法——减少除法指令数
        const invLen = 1.0 / len;
        out[0] = a[0] * invLen;
        out[1] = a[1] * invLen;
        out[2] = a[2] * invLen;
    } else {
        // 近零向量保护，避免 NaN 传播
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
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
 * vec3d.negate(result, [1, -2, 3]); // result = [-1, 2, -3]
 */
export function negate(out: Vec3d, a: Vec3d): Vec3d {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
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
 * vec3d.lerp(result, [0, 0, 0], [10, 10, 10], 0.25); // result = [2.5, 2.5, 2.5]
 */
export function lerp(out: Vec3d, a: Vec3d, b: Vec3d, t: number): Vec3d {
    // a + t*(b-a) 形式保证 t=0→a, t=1→b 精确
    out[0] = a[0] + t * (b[0] - a[0]);
    out[1] = a[1] + t * (b[1] - a[1]);
    out[2] = a[2] + t * (b[2] - a[2]);
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
 * vec3d.distance([0, 0, 0], [1, 2, 2]); // 3
 */
export function distance(a: Vec3d, b: Vec3d): number {
    // 计算各轴差值后求模
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 计算两点之间距离的平方。
 *
 * @param a - 点 A
 * @param b - 点 B
 * @returns 距离的平方（非负）
 *
 * @example
 * vec3d.squaredDistance([0, 0, 0], [1, 2, 2]); // 9
 */
export function squaredDistance(a: Vec3d, b: Vec3d): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return dx * dx + dy * dy + dz * dz;
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
 * vec3d.multiply(result, [2, 3, 4], [5, 6, 7]); // result = [10, 18, 28]
 */
export function multiply(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    out[2] = a[2] * b[2];
    return out;
}

/**
 * 逐分量取最小值。
 *
 * @param out - 结果向量（预分配）
 * @param a - 向量 A
 * @param b - 向量 B
 * @returns out 引用
 *
 * @example
 * vec3d.min(result, [1, 5, 3], [3, 2, 7]); // result = [1, 2, 3]
 */
export function min(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    out[0] = Math.min(a[0], b[0]);
    out[1] = Math.min(a[1], b[1]);
    out[2] = Math.min(a[2], b[2]);
    return out;
}

/**
 * 逐分量取最大值。
 *
 * @param out - 结果向量（预分配）
 * @param a - 向量 A
 * @param b - 向量 B
 * @returns out 引用
 *
 * @example
 * vec3d.max(result, [1, 5, 3], [3, 2, 7]); // result = [3, 5, 7]
 */
export function max(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
    out[0] = Math.max(a[0], b[0]);
    out[1] = Math.max(a[1], b[1]);
    out[2] = Math.max(a[2], b[2]);
    return out;
}

/**
 * 用 4x4 列主序矩阵变换 3D 向量（齐次坐标 w=1，带透视除法）。
 * 适用于 MVP 变换后的顶点投影。
 *
 * @param out - 结果向量（预分配，可与 a 相同）
 * @param a - 源 3D 向量
 * @param m - 4x4 列主序变换矩阵
 * @returns out 引用
 *
 * @example
 * const projected = vec3d.create();
 * vec3d.transformMat4(projected, worldPos, vpMatrix);
 */
export function transformMat4(out: Vec3d, a: Vec3d, m: Mat4d): Vec3d {
    // 缓存输入，以防 out === a
    const x = a[0], y = a[1], z = a[2];
    // 计算齐次坐标 w 分量，用于透视除法
    // 若 w≈0 则回退到 1.0 防止除零
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1.0;
    // 列主序矩阵×列向量：result = M * [x, y, z, 1]^T
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}

/**
 * 用四元数旋转 3D 向量。
 * 使用优化公式 v' = v + 2w(q×v) + 2(q×(q×v))，避免构造旋转矩阵。
 * q = [x, y, z, w]（Hamilton 约定）
 *
 * @param out - 结果向量（预分配，可与 a 相同）
 * @param a - 源 3D 向量
 * @param q - 单位四元数 [x, y, z, w]
 * @returns out 引用
 *
 * @example
 * const rotated = vec3d.create();
 * const q = new Float64Array([0, 0.7071067811865476, 0, 0.7071067811865476]);
 * vec3d.transformQuat(rotated, [1, 0, 0], q); // rotated ≈ [0, 0, -1]
 */
export function transformQuat(out: Vec3d, a: Vec3d, q: Quatd): Vec3d {
    // 提取四元数分量
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    // 缓存向量分量
    const ax = a[0], ay = a[1], az = a[2];
    // 第一次叉积：uv = q.xyz × v
    let uvx = qy * az - qz * ay;
    let uvy = qz * ax - qx * az;
    let uvz = qx * ay - qy * ax;
    // 第二次叉积：uuv = q.xyz × uv
    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;
    // 缩放 uv 乘以 2w
    const w2 = 2 * qw;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;
    // 缩放 uuv 乘以 2
    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;
    // 最终结果：v' = v + 2w*(q×v) + 2*(q×(q×v))
    out[0] = ax + uvx + uuvx;
    out[1] = ay + uvy + uuvy;
    out[2] = az + uvz + uuvz;
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
 * vec3d.equals([1, 2, 3], [1, 2, 3.0000000000001]); // true
 */
export function equals(a: Vec3d, b: Vec3d, epsilon = 1e-12): boolean {
    // 逐分量绝对差值检查，短路求值
    return Math.abs(a[0] - b[0]) <= epsilon
        && Math.abs(a[1] - b[1]) <= epsilon
        && Math.abs(a[2] - b[2]) <= epsilon;
}

declare const __DEV__: boolean;
