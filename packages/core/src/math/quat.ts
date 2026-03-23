// ============================================================
// math/quat.ts — 四元数运算（Float32 版本）
// 存储格式 [x, y, z, w]，Hamilton 约定，Float32Array 长度 4
// 用于 3D 旋转、球面线性插值（slerp）、相机控制等
// ============================================================

/** Float32 四元数 [x,y,z,w]，长度为 4 的 Float32Array */
export type Quatf = Float32Array;

/** Float32 三维向量，长度为 3 的 Float32Array */
export type Vec3f = Float32Array;

/** Float32 3x3 矩阵（列主序），长度为 9 的 Float32Array */
export type Mat3f = Float32Array;

/**
 * 创建一个新的四元数（默认为单位四元数 [0,0,0,1]）。
 * 仅在初始化阶段调用。
 *
 * @returns 新分配的单位四元数 Float32Array(4)
 *
 * @example
 * const q = quat.create(); // [0, 0, 0, 1]（无旋转）
 */
export function create(): Quatf {
    // 分配 4 元素，w=1 表示单位四元数（无旋转）
    const out = new Float32Array(4);
    out[3] = 1;
    return out;
}

/**
 * 将四元数重置为单位四元数（无旋转）。
 *
 * @param out - 目标四元数（预分配）
 * @returns out 引用
 *
 * @example
 * quat.identity(q); // q = [0, 0, 0, 1]
 */
export function identity(out: Quatf): Quatf {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    // w = 1 表示零度旋转
    out[3] = 1;
    return out;
}

/**
 * 从欧拉角（yaw/pitch/roll）构建四元数。
 * 旋转顺序为 ZYX（先 roll，再 pitch，最后 yaw）。
 * 所有角度单位为弧度。
 *
 * @param out - 结果四元数（预分配）
 * @param yaw - 偏航角（绕 Y 轴，弧度）
 * @param pitch - 俯仰角（绕 X 轴，弧度）
 * @param roll - 翻滚角（绕 Z 轴，弧度）
 * @returns out 引用
 *
 * @example
 * const q = new Float32Array(4);
 * quat.fromEuler(q, Math.PI / 2, 0, 0); // 绕 Y 轴旋转 90°
 */
export function fromEuler(out: Quatf, yaw: number, pitch: number, roll: number): Quatf {
    // 预计算各角度的半角三角函数
    const halfYaw = yaw * 0.5;
    const halfPitch = pitch * 0.5;
    const halfRoll = roll * 0.5;
    const cy = Math.cos(halfYaw);
    const sy = Math.sin(halfYaw);
    const cp = Math.cos(halfPitch);
    const sp = Math.sin(halfPitch);
    const cr = Math.cos(halfRoll);
    const sr = Math.sin(halfRoll);

    // ZYX 旋转顺序的四元数合成公式
    out[0] = sr * cp * cy - cr * sp * sy;   // x
    out[1] = cr * sp * cy + sr * cp * sy;   // y
    out[2] = cr * cp * sy - sr * sp * cy;   // z
    out[3] = cr * cp * cy + sr * sp * sy;   // w
    return out;
}

/**
 * 从旋转轴和角度构建四元数。
 * q = [axis * sin(angle/2), cos(angle/2)]
 *
 * @param out - 结果四元数（预分配）
 * @param axis - 旋转轴（应为单位向量）
 * @param rad - 旋转角度（弧度）
 * @returns out 引用
 *
 * @example
 * const q = new Float32Array(4);
 * quat.fromAxisAngle(q, [0, 1, 0], Math.PI / 4); // 绕 Y 轴旋转 45°
 */
export function fromAxisAngle(out: Quatf, axis: Vec3f, rad: number): Quatf {
    // 四元数公式：q = (sin(θ/2) * axis, cos(θ/2))
    const halfAngle = rad * 0.5;
    const s = Math.sin(halfAngle);
    out[0] = axis[0] * s;
    out[1] = axis[1] * s;
    out[2] = axis[2] * s;
    out[3] = Math.cos(halfAngle);
    return out;
}

/**
 * 四元数乘法：out = a × b（Hamilton 乘积）。
 * 表示先旋转 b 再旋转 a 的复合旋转。
 * 支持 out === a 或 out === b。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 左四元数
 * @param b - 右四元数
 * @returns out 引用
 *
 * @example
 * quat.multiply(combined, rotationA, rotationB);
 */
export function multiply(out: Quatf, a: Quatf, b: Quatf): Quatf {
    // 缓存分量以防就地运算
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    // Hamilton 乘积公式
    out[0] = ax * bw + aw * bx + ay * bz - az * by;   // x
    out[1] = ay * bw + aw * by + az * bx - ax * bz;   // y
    out[2] = az * bw + aw * bz + ax * by - ay * bx;   // z
    out[3] = aw * bw - ax * bx - ay * by - az * bz;   // w
    return out;
}

/**
 * 球面线性插值（Slerp）：在两个四元数之间进行恒速旋转插值。
 * t=0 返回 a，t=1 返回 b。
 * 自动处理 dot<0 的情况（取短弧）。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 起始四元数
 * @param b - 终止四元数
 * @param t - 插值因子 [0, 1]
 * @returns out 引用
 *
 * @example
 * quat.slerp(result, startRot, endRot, 0.5); // 旋转到一半
 */
export function slerp(out: Quatf, a: Quatf, b: Quatf, t: number): Quatf {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];

    // 计算两个四元数的点积（cos of half angle）
    let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;

    // 若 dot < 0，则翻转 b 以取最短弧（四元数双覆盖）
    if (cosHalfTheta < 0) {
        bx = -bx; by = -by; bz = -bz; bw = -bw;
        cosHalfTheta = -cosHalfTheta;
    }

    let scale0: number;
    let scale1: number;

    if (cosHalfTheta >= 1.0 - 1e-6) {
        // 两个四元数几乎相同，退化为线性插值避免除零
        scale0 = 1.0 - t;
        scale1 = t;
    } else {
        // 标准 slerp 公式
        const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
        const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
        // 预计算 1/sin(θ)
        const invSin = 1.0 / sinHalfTheta;
        scale0 = Math.sin((1.0 - t) * halfTheta) * invSin;
        scale1 = Math.sin(t * halfTheta) * invSin;
    }

    // 加权混合
    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
}

/**
 * 将四元数归一化为单位四元数。
 * 累积旋转运算后四元数可能漂移，需要定期归一化。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 源四元数
 * @returns out 引用
 *
 * @example
 * quat.normalize(q, q); // 就地归一化
 */
export function normalize(out: Quatf, a: Quatf): Quatf {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
    if (len > 1e-6) {
        // 乘以倒数代替除法
        const invLen = 1.0 / len;
        out[0] = a[0] * invLen;
        out[1] = a[1] * invLen;
        out[2] = a[2] * invLen;
        out[3] = a[3] * invLen;
    } else {
        // 零四元数保护，重置为单位
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    }
    return out;
}

/**
 * 四元数共轭：q* = [-x, -y, -z, w]。
 * 对于单位四元数，共轭等于逆。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 源四元数
 * @returns out 引用
 *
 * @example
 * quat.conjugate(result, q); // 反向旋转
 */
export function conjugate(out: Quatf, a: Quatf): Quatf {
    // 虚部取反，实部保持
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = a[3];
    return out;
}

/**
 * 四元数求逆：q^-1 = q* / |q|²。
 * 对于单位四元数，等同于共轭。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 源四元数
 * @returns out 引用
 *
 * @example
 * quat.invert(inv, rotation); // 计算反向旋转
 */
export function invert(out: Quatf, a: Quatf): Quatf {
    // 计算模的平方
    const dot = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
    if (dot > 1e-6) {
        // 共轭 / |q|²
        const invDot = 1.0 / dot;
        out[0] = -a[0] * invDot;
        out[1] = -a[1] * invDot;
        out[2] = -a[2] * invDot;
        out[3] = a[3] * invDot;
    } else {
        // 零四元数无逆，重置为单位
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    }
    return out;
}

/**
 * 用四元数旋转 3D 向量：v' = q × v × q*。
 * 使用优化公式避免完整的四元数乘法链。
 *
 * @param out - 结果向量（预分配，可与 v 相同）
 * @param q - 旋转四元数（应为单位四元数）
 * @param v - 源 3D 向量
 * @returns out 引用
 *
 * @example
 * const rotated = new Float32Array(3);
 * quat.rotateVec3(rotated, rotation, [1, 0, 0]);
 */
export function rotateVec3(out: Vec3f, q: Quatf, v: Vec3f): Vec3f {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];

    // 第一次叉积：t = 2 * (q.xyz × v)
    let tx = 2 * (qy * vz - qz * vy);
    let ty = 2 * (qz * vx - qx * vz);
    let tz = 2 * (qx * vy - qy * vx);

    // 第二次叉积：q.xyz × t
    const ttx = qy * tz - qz * ty;
    const tty = qz * tx - qx * tz;
    const ttz = qx * ty - qy * tx;

    // v' = v + w*t + (q.xyz × t)
    out[0] = vx + qw * tx + ttx;
    out[1] = vy + qw * ty + tty;
    out[2] = vz + qw * tz + ttz;
    return out;
}

/**
 * 计算四元数的长度（模）。
 * 单位四元数的长度应为 1。
 *
 * @param a - 输入四元数
 * @returns 非负长度值
 *
 * @example
 * const len = quat.length(q); // 应该接近 1.0
 */
export function length(a: Quatf): number {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
}

/**
 * 计算两个四元数的点积。
 * dot(a,b) = cos(两旋转之间半角)，用于判断旋转相似度。
 *
 * @param a - 四元数 A
 * @param b - 四元数 B
 * @returns 标量点积值
 *
 * @example
 * const similarity = quat.dot(q1, q2); // 接近 1 表示旋转相近
 */
export function dot(a: Quatf, b: Quatf): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * 四元数线性插值（Lerp）然后归一化（NLerp）。
 * 比 slerp 更快，但插值速度不恒定。适用于小角度或不需要恒速的场景。
 *
 * @param out - 结果四元数（预分配）
 * @param a - 起始四元数（t=0）
 * @param b - 终止四元数（t=1）
 * @param t - 插值因子
 * @returns out 引用
 *
 * @example
 * quat.lerp(result, q1, q2, 0.5);
 */
export function lerp(out: Quatf, a: Quatf, b: Quatf, t: number): Quatf {
    // 线性插值（不保证单位长度）
    const oneMinusT = 1.0 - t;
    out[0] = oneMinusT * a[0] + t * b[0];
    out[1] = oneMinusT * a[1] + t * b[1];
    out[2] = oneMinusT * a[2] + t * b[2];
    out[3] = oneMinusT * a[3] + t * b[3];
    // 归一化以保持单位四元数性质
    return normalize(out, out);
}

/**
 * 判断两个四元数是否在误差范围内相等。
 * 注意：q 和 -q 表示相同旋转，此函数不处理此等价关系。
 *
 * @param a - 四元数 A
 * @param b - 四元数 B
 * @param epsilon - 容差阈值，默认 1e-6
 * @returns 若所有分量差值均 ≤ epsilon 则为 true
 *
 * @example
 * quat.equals(q1, q2); // true if approximately equal
 */
export function equals(a: Quatf, b: Quatf, epsilon = 1e-6): boolean {
    // 逐分量绝对差值检查
    return Math.abs(a[0] - b[0]) <= epsilon
        && Math.abs(a[1] - b[1]) <= epsilon
        && Math.abs(a[2] - b[2]) <= epsilon
        && Math.abs(a[3] - b[3]) <= epsilon;
}

/**
 * 从 3x3 旋转矩阵（列主序）提取四元数。
 * 使用 Shepperd 方法，选择对角线最大元素的分支以保证数值稳定。
 *
 * 列主序 3x3 索引：
 * | m[0] m[3] m[6] |
 * | m[1] m[4] m[7] |
 * | m[2] m[5] m[8] |
 *
 * @param out - 结果四元数（预分配）
 * @param m - 3x3 旋转矩阵（列主序，应为纯旋转无缩放）
 * @returns out 引用
 *
 * @example
 * const q = new Float32Array(4);
 * quat.fromMat3(q, rotationMatrix3x3);
 */
export function fromMat3(out: Quatf, m: Mat3f): Quatf {
    // 列主序索引转为行列符号以方便推导
    // m00=m[0], m10=m[1], m20=m[2]  （列 0）
    // m01=m[3], m11=m[4], m21=m[5]  （列 1）
    // m02=m[6], m12=m[7], m22=m[8]  （列 2）
    const m00 = m[0], m10 = m[1], m20 = m[2];
    const m01 = m[3], m11 = m[4], m21 = m[5];
    const m02 = m[6], m12 = m[7], m22 = m[8];

    // 旋转矩阵的迹 = m00 + m11 + m22
    const trace = m00 + m11 + m22;

    if (trace > 0) {
        // w 分量最大的分支（trace > 0 保证 w > 0.5）
        const s = 0.5 / Math.sqrt(trace + 1.0);
        out[3] = 0.25 / s;
        out[0] = (m12 - m21) * s;
        out[1] = (m20 - m02) * s;
        out[2] = (m01 - m10) * s;
    } else if (m00 > m11 && m00 > m22) {
        // x 分量最大的分支
        const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
        out[3] = (m12 - m21) / s;
        out[0] = 0.25 * s;
        out[1] = (m01 + m10) / s;
        out[2] = (m20 + m02) / s;
    } else if (m11 > m22) {
        // y 分量最大的分支
        const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
        out[3] = (m20 - m02) / s;
        out[0] = (m01 + m10) / s;
        out[1] = 0.25 * s;
        out[2] = (m12 + m21) / s;
    } else {
        // z 分量最大的分支
        const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
        out[3] = (m01 - m10) / s;
        out[0] = (m20 + m02) / s;
        out[1] = (m12 + m21) / s;
        out[2] = 0.25 * s;
    }

    return out;
}
