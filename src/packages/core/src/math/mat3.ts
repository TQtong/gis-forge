// ============================================================
// math/mat3.ts — 3x3 矩阵运算（列主序 Column-Major，Float32 版本）
// 用于 2D 仿射变换、法线变换（normalFromMat4）
// 列主序索引：
//   | m[0] m[3] m[6] |
//   | m[1] m[4] m[7] |
//   | m[2] m[5] m[8] |
// ============================================================

/** Float32 3x3 矩阵，列主序，长度为 9 的 Float32Array */
export type Mat3f = Float32Array;

/** Float32 4x4 矩阵类型前向声明（fromMat4/normalFromMat4 用） */
export type Mat4f = Float32Array;

/** Float32 二维向量类型前向声明（fromScaling/fromTranslation 用） */
export type Vec2f = Float32Array;

/**
 * 创建一个新的 3x3 单位矩阵。
 * 仅在初始化阶段调用。
 *
 * @returns 新分配的 Float32Array(9)，初始化为单位矩阵
 *
 * @example
 * const m = mat3.create();
 * // m = [1,0,0, 0,1,0, 0,0,1]（列主序单位矩阵）
 */
export function create(): Mat3f {
    // 分配 9 元素并设对角线为 1
    const out = new Float32Array(9);
    out[0] = 1;
    out[4] = 1;
    out[8] = 1;
    return out;
}

/**
 * 将矩阵重置为单位矩阵。
 *
 * @param out - 目标矩阵（预分配）
 * @returns out 引用
 *
 * @example
 * mat3.identity(m); // m 变为单位矩阵
 */
export function identity(out: Mat3f): Mat3f {
    // 列 0
    out[0] = 1; out[1] = 0; out[2] = 0;
    // 列 1
    out[3] = 0; out[4] = 1; out[5] = 0;
    // 列 2
    out[6] = 0; out[7] = 0; out[8] = 1;
    return out;
}

/**
 * 从 4x4 矩阵中提取左上角 3x3 子矩阵。
 * 常用于从模型矩阵中提取旋转+缩放部分。
 *
 * 4x4 列主序索引映射到 3x3：
 *   m4[0] → m3[0],  m4[1] → m3[1],  m4[2] → m3[2]    （列 0）
 *   m4[4] → m3[3],  m4[5] → m3[4],  m4[6] → m3[5]    （列 1）
 *   m4[8] → m3[6],  m4[9] → m3[7],  m4[10]→ m3[8]    （列 2）
 *
 * @param out - 结果 3x3 矩阵（预分配）
 * @param a - 源 4x4 矩阵
 * @returns out 引用
 *
 * @example
 * const normalMat = mat3.create();
 * mat3.fromMat4(normalMat, modelMatrix);
 */
export function fromMat4(out: Mat3f, a: Mat4f): Mat3f {
    // 列 0：从 m4 索引 0,1,2 拷贝
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    // 列 1：从 m4 索引 4,5,6 拷贝（跳过 m4[3] 即 w 行）
    out[3] = a[4]; out[4] = a[5]; out[5] = a[6];
    // 列 2：从 m4 索引 8,9,10 拷贝
    out[6] = a[8]; out[7] = a[9]; out[8] = a[10];
    return out;
}

/**
 * 3x3 矩阵乘法：out = a × b。
 * 列主序下，out 的第 j 列 = a × b 的第 j 列。
 *
 * @param out - 结果矩阵（预分配，可与 a 或 b 相同）
 * @param a - 左矩阵
 * @param b - 右矩阵
 * @returns out 引用
 *
 * @example
 * const result = mat3.create();
 * mat3.multiply(result, rotationMat, scaleMat);
 */
export function multiply(out: Mat3f, a: Mat3f, b: Mat3f): Mat3f {
    // 缓存 a 的所有元素到局部变量，以防 out === a
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];

    // 逐列计算：第 j 列 = a × b 的第 j 列向量
    // 列 0
    let b0 = b[0], b1 = b[1], b2 = b[2];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22;

    // 列 1
    b0 = b[3]; b1 = b[4]; b2 = b[5];
    out[3] = b0 * a00 + b1 * a10 + b2 * a20;
    out[4] = b0 * a01 + b1 * a11 + b2 * a21;
    out[5] = b0 * a02 + b1 * a12 + b2 * a22;

    // 列 2
    b0 = b[6]; b1 = b[7]; b2 = b[8];
    out[6] = b0 * a00 + b1 * a10 + b2 * a20;
    out[7] = b0 * a01 + b1 * a11 + b2 * a21;
    out[8] = b0 * a02 + b1 * a12 + b2 * a22;

    return out;
}

/**
 * 3x3 矩阵求逆。
 * 使用伴随矩阵法：adj(A) / det(A)。若行列式接近零则返回 null。
 *
 * @param out - 结果矩阵（预分配）
 * @param a - 源矩阵
 * @returns out 引用，若不可逆则返回 null
 *
 * @example
 * const inv = mat3.create();
 * if (mat3.invert(inv, m) === null) {
 *   console.error('矩阵不可逆');
 * }
 */
export function invert(out: Mat3f, a: Mat3f): Mat3f | null {
    // 提取所有 9 个元素到局部变量
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];

    // 计算各 2x2 子阵的余子式（cofactor）
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    // 按第一列展开计算行列式
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-8) {
        // 行列式接近零，矩阵不可逆（奇异矩阵）
        return null;
    }
    // 取倒数，后续用乘法代替除法
    det = 1.0 / det;

    // 伴随矩阵的转置 / 行列式 = 逆矩阵
    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det;
    out[7] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;

    return out;
}

/**
 * 3x3 矩阵转置。
 * 列主序下转置即交换 m[i][j] 和 m[j][i]。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * mat3.transpose(result, m);
 */
export function transpose(out: Mat3f, a: Mat3f): Mat3f {
    // 若 out === a 则需要暂存中间值
    if (out === a) {
        const a01 = a[1], a02 = a[2], a12 = a[5];
        out[1] = a[3];
        out[2] = a[6];
        out[3] = a01;
        out[5] = a[7];
        out[6] = a02;
        out[7] = a12;
    } else {
        // 对角线元素不变
        out[0] = a[0];
        out[4] = a[4];
        out[8] = a[8];
        // 交换对称位置的元素
        out[1] = a[3];
        out[2] = a[6];
        out[3] = a[1];
        out[5] = a[7];
        out[6] = a[2];
        out[7] = a[5];
    }
    return out;
}

/**
 * 计算 3x3 矩阵的行列式。
 * 使用 Sarrus 法则（按第一列展开）。
 *
 * @param a - 输入矩阵
 * @returns 行列式标量值
 *
 * @example
 * const det = mat3.determinant(m); // 若 det ≈ 0 则矩阵奇异
 */
export function determinant(a: Mat3f): number {
    // 提取元素
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    // 按第一列展开行列式
    return a00 * (a22 * a11 - a12 * a21)
        + a01 * (-a22 * a10 + a12 * a20)
        + a02 * (a21 * a10 - a11 * a20);
}

/**
 * 创建 2D 旋转矩阵（绕原点，列主序 3x3）。
 * 结果矩阵仿射部分为旋转，平移为零。
 *
 * @param out - 结果矩阵（预分配）
 * @param rad - 旋转角度（弧度），正值为逆时针
 * @returns out 引用
 *
 * @example
 * const rot = mat3.create();
 * mat3.fromRotation(rot, Math.PI / 4); // 45° 旋转
 */
export function fromRotation(out: Mat3f, rad: number): Mat3f {
    // 预计算三角函数
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // 列 0：旋转矩阵第一列
    out[0] = c;  out[1] = s;  out[2] = 0;
    // 列 1：旋转矩阵第二列
    out[3] = -s; out[4] = c;  out[5] = 0;
    // 列 2：无平移
    out[6] = 0;  out[7] = 0;  out[8] = 1;
    return out;
}

/**
 * 创建 2D 缩放矩阵（列主序 3x3）。
 *
 * @param out - 结果矩阵（预分配）
 * @param v - 缩放向量 [sx, sy]
 * @returns out 引用
 *
 * @example
 * const s = mat3.create();
 * mat3.fromScaling(s, [2, 3]); // X 放大 2 倍，Y 放大 3 倍
 */
export function fromScaling(out: Mat3f, v: Vec2f): Mat3f {
    // 对角线放缩放因子，其余为 0
    out[0] = v[0]; out[1] = 0;    out[2] = 0;
    out[3] = 0;    out[4] = v[1]; out[5] = 0;
    out[6] = 0;    out[7] = 0;    out[8] = 1;
    return out;
}

/**
 * 创建 2D 平移矩阵（列主序 3x3）。
 * 平移值存储在第三列的前两个元素。
 *
 * @param out - 结果矩阵（预分配）
 * @param v - 平移向量 [tx, ty]
 * @returns out 引用
 *
 * @example
 * const t = mat3.create();
 * mat3.fromTranslation(t, [10, 20]); // 平移 (10, 20)
 */
export function fromTranslation(out: Mat3f, v: Vec2f): Mat3f {
    // 单位矩阵 + 第三列存平移
    out[0] = 1; out[1] = 0; out[2] = 0;
    out[3] = 0; out[4] = 1; out[5] = 0;
    // 列主序下，平移在索引 6, 7
    out[6] = v[0]; out[7] = v[1]; out[8] = 1;
    return out;
}

/**
 * 从 4x4 矩阵计算法线变换矩阵（逆转置的左上角 3x3）。
 * 法线不能直接用模型矩阵变换（非均匀缩放时方向会歪），
 * 需要使用 (M^-1)^T 即模型矩阵逆的转置。
 *
 * @param out - 结果 3x3 法线矩阵（预分配）
 * @param a - 源 4x4 模型矩阵
 * @returns out 引用，若左上角 3x3 不可逆则返回 null
 *
 * @example
 * const normalMat = mat3.create();
 * if (mat3.normalFromMat4(normalMat, modelMatrix)) {
 *   // 在 shader 中用 normalMat * localNormal 变换法线
 * }
 */
export function normalFromMat4(out: Mat3f, a: Mat4f): Mat3f | null {
    // 提取 4x4 矩阵的左上角 3x3 元素
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[4], a11 = a[5], a12 = a[6];
    const a20 = a[8], a21 = a[9], a22 = a[10];

    // 计算 3x3 子阵的余子式
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    // 计算 3x3 子阵的行列式
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-8) {
        // 不可逆，无法计算法线矩阵
        return null;
    }
    det = 1.0 / det;

    // 计算逆矩阵的转置
    // 先算逆矩阵各元素，然后转置存储
    // 逆矩阵 (行 i, 列 j) = cofactor(j,i) / det
    // 转置后 (行 i, 列 j) = cofactor(i,j) / det
    // 在列主序中，[列j * 3 + 行i] = cofactor(i,j) / det
    out[0] = b01 * det;
    out[1] = b11 * det;
    out[2] = b21 * det;
    out[3] = (-a22 * a01 + a02 * a21) * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a21 * a00 + a01 * a20) * det;
    out[6] = (a12 * a01 - a02 * a11) * det;
    out[7] = (-a12 * a00 + a02 * a10) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;

    return out;
}
