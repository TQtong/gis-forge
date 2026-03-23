// ============================================================
// math/mat4.ts — 4x4 矩阵运算（列主序 Column-Major，Float32 版本）
// 引擎最关键的数学模块，用于 MVP 变换、投影、视图矩阵等
// 列主序索引（与 WGSL mat4x4<f32> 内存布局一致）：
//   | m[0]  m[4]  m[8]   m[12] |     | c0r0 c1r0 c2r0 c3r0 |
//   | m[1]  m[5]  m[9]   m[13] |  =  | c0r1 c1r1 c2r1 c3r1 |
//   | m[2]  m[6]  m[10]  m[14] |     | c0r2 c1r2 c2r2 c3r2 |
//   | m[3]  m[7]  m[11]  m[15] |     | c0r3 c1r3 c2r3 c3r3 |
// ============================================================

/** Float32 4x4 矩阵，列主序，长度为 16 的 Float32Array */
export type Mat4f = Float32Array;

/** Float64 4x4 矩阵，列主序，长度为 16 的 Float64Array（CPU 精确计算用） */
export type Mat4d = Float64Array;

/** Float32 三维向量，长度为 3 的 Float32Array */
export type Vec3f = Float32Array;

/** Float32 四元数 [x,y,z,w]，长度为 4 的 Float32Array */
export type Quatf = Float32Array;

/**
 * 创建一个新的 4x4 单位矩阵。
 * 仅在初始化阶段调用。
 *
 * @returns 新分配的 Float32Array(16)，初始化为单位矩阵
 *
 * @example
 * const m = mat4.create(); // 单位矩阵
 */
export function create(): Mat4f {
    // 分配 16 元素，对角线设为 1
    const out = new Float32Array(16);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
    return out;
}

/**
 * 将矩阵重置为单位矩阵。
 *
 * @param out - 目标矩阵（预分配）
 * @returns out 引用
 *
 * @example
 * mat4.identity(m);
 */
export function identity(out: Mat4f): Mat4f {
    // 列 0
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    // 列 1
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    // 列 2
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    // 列 3
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
}

/**
 * 将矩阵 a 的值复制到 out 中。
 *
 * @param out - 目标矩阵（预分配）
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * mat4.copy(backup, currentMatrix);
 */
export function copy(out: Mat4f, a: Mat4f): Mat4f {
    // 逐元素复制所有 16 个元素
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
    out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
    out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    return out;
}

/**
 * 克隆矩阵（分配新内存）。
 * 仅在需要独立副本时调用，热路径应使用 copy 到预分配矩阵。
 *
 * @param a - 源矩阵
 * @returns 新分配的矩阵副本
 *
 * @example
 * const cloned = mat4.clone(originalMatrix);
 */
export function clone(a: Mat4f): Mat4f {
    // 使用 Float32Array 构造函数从现有数组创建副本
    const out = new Float32Array(16);
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
    out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
    out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    return out;
}

/**
 * 4x4 矩阵乘法：out = a × b（列主序）。
 * 64 次乘法 + 48 次加法。
 * 支持 out === a 或 out === b（就地运算安全）。
 *
 * @param out - 结果矩阵（预分配）
 * @param a - 左矩阵
 * @param b - 右矩阵
 * @returns out 引用
 *
 * @example
 * mat4.multiply(mvp, projection, modelView);
 */
export function multiply(out: Mat4f, a: Mat4f, b: Mat4f): Mat4f {
    // 缓存 a 的全部 16 个元素到局部变量，以防 out === a
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    // 逐列计算：取 b 的每一列，乘以 a 的每一行的对应元素，累加
    // 列 0
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    // 列 1
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    // 列 2
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    // 列 3
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    return out;
}

/**
 * 4x4 矩阵求逆（伴随矩阵/余子式方法）。
 * 若行列式接近零（|det| < 1e-8）则返回 null 表示不可逆。
 *
 * @param out - 结果矩阵（预分配）
 * @param a - 源矩阵
 * @returns out 引用，若不可逆则返回 null
 *
 * @example
 * const inv = mat4.create();
 * if (mat4.invert(inv, vpMatrix) === null) {
 *   console.error('VP 矩阵不可逆');
 * }
 */
export function invert(out: Mat4f, a: Mat4f): Mat4f | null {
    // 缓存所有 16 个元素
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    // 计算 2x2 子矩阵行列式（6 个来自上半部分，6 个来自下半部分）
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    // 用 2x2 行列式组合计算 4x4 行列式
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-8) {
        // 行列式接近零，矩阵奇异不可逆
        return null;
    }
    // 取倒数用于后续乘法
    det = 1.0 / det;

    // 计算伴随矩阵各元素 / 行列式 = 逆矩阵各元素
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;

    return out;
}

/**
 * 标准透视投影矩阵（WebGPU NDC：X[-1,1], Y[-1,1], Z[0,1]）。
 * 注意 WebGPU 的 Z 范围是 [0,1] 而非 OpenGL 的 [-1,1]。
 *
 * @param out - 结果矩阵（预分配）
 * @param fovY - 垂直视场角（弧度）
 * @param aspect - 宽高比 (width / height)
 * @param near - 近裁剪面距离（正值）
 * @param far - 远裁剪面距离（正值，far > near）
 * @returns out 引用
 *
 * @example
 * mat4.perspective(proj, Math.PI / 4, 16 / 9, 0.1, 1000);
 */
export function perspective(out: Mat4f, fovY: number, aspect: number, near: number, far: number): Mat4f {
    // f = 1 / tan(fovY/2)，即焦距的倒数
    const f = 1.0 / Math.tan(fovY * 0.5);
    // 列 0：X 方向缩放（除以宽高比）
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    // 列 1：Y 方向缩放
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    // 列 2：Z 映射到 [0,1] NDC（WebGPU 规范）
    out[8] = 0; out[9] = 0;
    out[10] = far / (near - far);
    out[11] = -1;
    // 列 3：透视除法偏移
    out[12] = 0; out[13] = 0;
    out[14] = (near * far) / (near - far);
    out[15] = 0;
    return out;
}

/**
 * Reversed-Z 透视投影矩阵（近平面 → Z=1，远平面 → Z=0）。
 * 反转深度映射可极大提升浮点深度缓冲精度（远处精度提升 ~100 倍）。
 * 配合 depthCompare:'greater' 和 clear 0.0 使用。
 *
 * @param out - 结果矩阵（预分配）
 * @param fovY - 垂直视场角（弧度）
 * @param aspect - 宽高比
 * @param near - 近裁剪面距离（正值）
 * @param far - 远裁剪面距离（正值）
 * @returns out 引用
 *
 * @example
 * mat4.perspectiveReversedZ(proj, Math.PI / 4, 16 / 9, 0.1, 10000);
 */
export function perspectiveReversedZ(out: Mat4f, fovY: number, aspect: number, near: number, far: number): Mat4f {
    const f = 1.0 / Math.tan(fovY * 0.5);
    // 列 0, 1 与标准透视相同
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    // 列 2：Reversed-Z 翻转深度映射
    // 标准：z_ndc = far/(near-far) * z_eye + near*far/(near-far)
    // 翻转：z_ndc = near/(far-near) * z_eye + near*far/(far-near)
    out[8] = 0; out[9] = 0;
    out[10] = near / (far - near);
    out[11] = -1;
    // 列 3
    out[12] = 0; out[13] = 0;
    out[14] = (near * far) / (far - near);
    out[15] = 0;
    return out;
}

/**
 * Reversed-Z 无限远透视投影矩阵（far → ∞）。
 * 适用于地球级场景，远裁剪面推到无穷远，结合 Reversed-Z 保证近处精度。
 * far → ∞ 时 near/(far-near) → 0, near*far/(far-near) → near。
 *
 * @param out - 结果矩阵（预分配）
 * @param fovY - 垂直视场角（弧度）
 * @param aspect - 宽高比
 * @param near - 近裁剪面距离（正值）
 * @returns out 引用
 *
 * @example
 * mat4.perspectiveReversedZInfinite(proj, Math.PI / 4, 16 / 9, 0.1);
 */
export function perspectiveReversedZInfinite(out: Mat4f, fovY: number, aspect: number, near: number): Mat4f {
    const f = 1.0 / Math.tan(fovY * 0.5);
    // 列 0, 1 标准
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    // 列 2：far→∞ 时 near/(far-near)→0
    out[8] = 0; out[9] = 0; out[10] = 0; out[11] = -1;
    // 列 3：far→∞ 时 near*far/(far-near)→near
    out[12] = 0; out[13] = 0; out[14] = near; out[15] = 0;
    return out;
}

/**
 * 正交投影矩阵（2D 模式，WebGPU NDC Z[0,1]）。
 *
 * @param out - 结果矩阵（预分配）
 * @param left - 左边界
 * @param right - 右边界
 * @param bottom - 下边界
 * @param top - 上边界
 * @param near - 近裁剪面
 * @param far - 远裁剪面
 * @returns out 引用
 *
 * @example
 * mat4.ortho(proj, 0, 800, 600, 0, -1, 1); // 屏幕坐标正交投影
 */
export function ortho(out: Mat4f, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4f {
    // 预计算倒数，避免多次除法
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    // 列 0：X 轴缩放到 [-1, 1]
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
    // 列 1：Y 轴缩放到 [-1, 1]
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
    // 列 2：Z 轴映射到 [0, 1]（WebGPU NDC）
    out[8] = 0; out[9] = 0; out[10] = nf; out[11] = 0;
    // 列 3：平移使中心对齐原点
    out[12] = (left + right) * lr;
    out[13] = (top + bottom) * bt;
    out[14] = near * nf;
    out[15] = 1;
    return out;
}

/**
 * 构建视图矩阵（lookAt）。
 * 将世界坐标系变换到相机坐标系：Z 轴朝向 eye→center 的反方向（右手系）。
 *
 * @param out - 结果视图矩阵（预分配）
 * @param eye - 相机位置（世界坐标）
 * @param center - 注视目标点（世界坐标）
 * @param up - 上方向向量（通常为 [0,1,0]）
 * @returns out 引用
 *
 * @example
 * mat4.lookAt(viewMatrix, [0, 5, 10], [0, 0, 0], [0, 1, 0]);
 */
export function lookAt(out: Mat4f, eye: Vec3f, center: Vec3f, up: Vec3f): Mat4f {
    // 计算前向向量 f = normalize(center - eye)
    let fx = center[0] - eye[0];
    let fy = center[1] - eye[1];
    let fz = center[2] - eye[2];
    let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (len < 1e-6) {
        // eye 和 center 重合，返回单位矩阵
        identity(out);
        return out;
    }
    // 归一化前向向量
    len = 1 / len;
    fx *= len; fy *= len; fz *= len;

    // 计算右向量 s = normalize(f × up)
    let sx = fy * up[2] - fz * up[1];
    let sy = fz * up[0] - fx * up[2];
    let sz = fx * up[1] - fy * up[0];
    len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len < 1e-6) {
        // f 与 up 平行，无法确定右方向
        sx = 0; sy = 0; sz = 0;
    } else {
        len = 1 / len;
        sx *= len; sy *= len; sz *= len;
    }

    // 计算真正的上向量 u = s × f（已经是单位向量，无需归一化）
    const ux = sy * fz - sz * fy;
    const uy = sz * fx - sx * fz;
    const uz = sx * fy - sy * fx;

    // 构建视图矩阵：旋转部分 + 平移 = -R^T * eye
    // 列 0：右方向
    out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0;
    // 列 1：上方向
    out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0;
    // 列 2：后方向（-forward）
    out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0;
    // 列 3：平移 = -dot(轴, eye)
    out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
    out[15] = 1;

    return out;
}

/**
 * 对矩阵施加平移变换：out = a × T(v)。
 * 等价于在 a 的基础上追加一个平移。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param v - 平移向量 [tx, ty, tz]
 * @returns out 引用
 *
 * @example
 * mat4.translate(modelMatrix, modelMatrix, [10, 0, 5]);
 */
export function translate(out: Mat4f, a: Mat4f, v: Vec3f): Mat4f {
    const x = v[0], y = v[1], z = v[2];
    if (out === a) {
        // 就地变换：只需修改列 3（平移列）
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    } else {
        // 前 12 个元素直接复制（旋转/缩放部分不变）
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
        out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
        out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
        // 列 3 = 原列0×x + 原列1×y + 原列2×z + 原列3
        out[12] = a00 * x + a10 * y + a20 * z + a[12];
        out[13] = a01 * x + a11 * y + a21 * z + a[13];
        out[14] = a02 * x + a12 * y + a22 * z + a[14];
        out[15] = a03 * x + a13 * y + a23 * z + a[15];
    }
    return out;
}

/**
 * 绕 X 轴旋转矩阵：out = a × Rx(rad)。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param rad - 旋转角度（弧度）
 * @returns out 引用
 *
 * @example
 * mat4.rotateX(modelMatrix, modelMatrix, Math.PI / 6);
 */
export function rotateX(out: Mat4f, a: Mat4f, rad: number): Mat4f {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // 只有列 1 和列 2 受影响（Y 和 Z 轴混合）
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

    if (out !== a) {
        // 列 0 和列 3 不变，直接复制
        out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    // 列 1 = 原列1×cos + 原列2×sin
    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    // 列 2 = 原列2×cos - 原列1×sin
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;

    return out;
}

/**
 * 绕 Y 轴旋转矩阵：out = a × Ry(rad)。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param rad - 旋转角度（弧度）
 * @returns out 引用
 *
 * @example
 * mat4.rotateY(modelMatrix, modelMatrix, bearing);
 */
export function rotateY(out: Mat4f, a: Mat4f, rad: number): Mat4f {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // 只有列 0 和列 2 受影响（X 和 Z 轴混合）
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

    if (out !== a) {
        // 列 1 和列 3 不变
        out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    // 列 0 = 原列0×cos - 原列2×sin
    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    // 列 2 = 原列0×sin + 原列2×cos
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;

    return out;
}

/**
 * 绕 Z 轴旋转矩阵：out = a × Rz(rad)。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param rad - 旋转角度（弧度）
 * @returns out 引用
 *
 * @example
 * mat4.rotateZ(modelMatrix, modelMatrix, bearing);
 */
export function rotateZ(out: Mat4f, a: Mat4f, rad: number): Mat4f {
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    // 只有列 0 和列 1 受影响（X 和 Y 轴混合）
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];

    if (out !== a) {
        // 列 2 和列 3 不变
        out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    // 列 0 = 原列0×cos + 原列1×sin
    out[0] = a00 * c + a10 * s;
    out[1] = a01 * c + a11 * s;
    out[2] = a02 * c + a12 * s;
    out[3] = a03 * c + a13 * s;
    // 列 1 = 原列1×cos - 原列0×sin
    out[4] = a10 * c - a00 * s;
    out[5] = a11 * c - a01 * s;
    out[6] = a12 * c - a02 * s;
    out[7] = a13 * c - a03 * s;

    return out;
}

/**
 * 绕任意轴旋转矩阵：out = a × R(axis, rad)。
 * 使用 Rodrigues 旋转公式构造旋转矩阵再乘以 a。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param rad - 旋转角度（弧度）
 * @param axis - 旋转轴（应为单位向量）
 * @returns out 引用
 *
 * @example
 * mat4.rotateAxis(m, m, Math.PI / 3, [0, 1, 0]);
 */
export function rotateAxis(out: Mat4f, a: Mat4f, rad: number, axis: Vec3f): Mat4f {
    let x = axis[0], y = axis[1], z = axis[2];
    // 归一化旋转轴（以防输入不是单位向量）
    let len = Math.sqrt(x * x + y * y + z * z);
    if (len < 1e-6) {
        // 轴长度接近零，无法旋转，返回 a 的副本
        return copy(out, a);
    }
    len = 1 / len;
    x *= len; y *= len; z *= len;

    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const t = 1 - c;

    // Rodrigues 旋转矩阵 R 的 9 个元素
    const r00 = x * x * t + c;
    const r01 = y * x * t + z * s;
    const r02 = z * x * t - y * s;
    const r10 = x * y * t - z * s;
    const r11 = y * y * t + c;
    const r12 = z * y * t + x * s;
    const r20 = x * z * t + y * s;
    const r21 = y * z * t - x * s;
    const r22 = z * z * t + c;

    // 缓存 a 的列 0~2
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

    // 新列 0 = a的列0×r00 + a的列1×r01 + a的列2×r02
    out[0] = a00 * r00 + a10 * r01 + a20 * r02;
    out[1] = a01 * r00 + a11 * r01 + a21 * r02;
    out[2] = a02 * r00 + a12 * r01 + a22 * r02;
    out[3] = a03 * r00 + a13 * r01 + a23 * r02;
    // 新列 1
    out[4] = a00 * r10 + a10 * r11 + a20 * r12;
    out[5] = a01 * r10 + a11 * r11 + a21 * r12;
    out[6] = a02 * r10 + a12 * r11 + a22 * r12;
    out[7] = a03 * r10 + a13 * r11 + a23 * r12;
    // 新列 2
    out[8] = a00 * r20 + a10 * r21 + a20 * r22;
    out[9] = a01 * r20 + a11 * r21 + a21 * r22;
    out[10] = a02 * r20 + a12 * r21 + a22 * r22;
    out[11] = a03 * r20 + a13 * r21 + a23 * r22;

    // 列 3（平移列）不受旋转影响
    if (out !== a) {
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    return out;
}

/**
 * 对矩阵施加非均匀缩放：out = a × S(v)。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @param v - 缩放向量 [sx, sy, sz]
 * @returns out 引用
 *
 * @example
 * mat4.scaleBy(modelMatrix, modelMatrix, [2, 2, 2]); // 均匀放大 2 倍
 */
export function scaleBy(out: Mat4f, a: Mat4f, v: Vec3f): Mat4f {
    const x = v[0], y = v[1], z = v[2];
    // 列 0 乘以 sx
    out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
    // 列 1 乘以 sy
    out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
    // 列 2 乘以 sz
    out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
    // 列 3（平移列）不受缩放影响
    if (out !== a) {
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    return out;
}

/**
 * 4x4 矩阵转置。
 *
 * @param out - 结果矩阵（预分配，可与 a 相同）
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * mat4.transpose(result, m);
 */
export function transpose(out: Mat4f, a: Mat4f): Mat4f {
    if (out === a) {
        // 就地转置：交换对称位置元素，对角线不变
        const a01 = a[1], a02 = a[2], a03 = a[3];
        const a12 = a[6], a13 = a[7];
        const a23 = a[11];
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a01; out[6] = a[9]; out[7] = a[13];
        out[8] = a02; out[9] = a12; out[11] = a[14];
        out[12] = a03; out[13] = a13; out[14] = a23;
    } else {
        // 对角线直接复制
        out[0] = a[0]; out[5] = a[5]; out[10] = a[10]; out[15] = a[15];
        // 交换对称位置
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a[1]; out[6] = a[9]; out[7] = a[13];
        out[8] = a[2]; out[9] = a[6]; out[11] = a[14];
        out[12] = a[3]; out[13] = a[7]; out[14] = a[11];
    }
    return out;
}

/**
 * 计算 4x4 矩阵的行列式。
 *
 * @param a - 输入矩阵
 * @returns 行列式标量值
 *
 * @example
 * if (Math.abs(mat4.determinant(m)) < 1e-8) {
 *   console.warn('矩阵接近奇异');
 * }
 */
export function determinant(a: Mat4f): number {
    // 按照 Laplace 展开法，利用 2x2 子矩阵行列式
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    // 6 个 2x2 子行列式
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    // 组合：det = Σ (±) b_upper × b_lower
    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

/**
 * 从四元数和平移向量构建变换矩阵。
 * 等价于 T(v) × R(q)，无缩放。
 *
 * @param out - 结果矩阵（预分配）
 * @param q - 旋转四元数 [x, y, z, w]
 * @param v - 平移向量 [tx, ty, tz]
 * @returns out 引用
 *
 * @example
 * mat4.fromRotationTranslation(m, quaternion, position);
 */
export function fromRotationTranslation(out: Mat4f, q: Quatf, v: Vec3f): Mat4f {
    // 提取四元数分量
    const x = q[0], y = q[1], z = q[2], w = q[3];
    // 预计算四元数分量的组合乘积（避免重复计算）
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    // 从四元数构建旋转矩阵的 3x3 部分（列主序）
    // 列 0
    out[0] = 1 - (yy + zz);
    out[1] = xy + wz;
    out[2] = xz - wy;
    out[3] = 0;
    // 列 1
    out[4] = xy - wz;
    out[5] = 1 - (xx + zz);
    out[6] = yz + wx;
    out[7] = 0;
    // 列 2
    out[8] = xz + wy;
    out[9] = yz - wx;
    out[10] = 1 - (xx + yy);
    out[11] = 0;
    // 列 3：平移
    out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;

    return out;
}

/**
 * 从四元数、平移和缩放向量构建完整变换矩阵。
 * 等价于 T(v) × R(q) × S(s)。
 *
 * @param out - 结果矩阵（预分配）
 * @param q - 旋转四元数 [x, y, z, w]
 * @param v - 平移向量 [tx, ty, tz]
 * @param s - 缩放向量 [sx, sy, sz]
 * @returns out 引用
 *
 * @example
 * mat4.fromRotationTranslationScale(m, quat, pos, scale);
 */
export function fromRotationTranslationScale(out: Mat4f, q: Quatf, v: Vec3f, s: Vec3f): Mat4f {
    // 提取四元数分量
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    // 提取缩放分量
    const sx = s[0], sy = s[1], sz = s[2];

    // 旋转矩阵元素乘以对应轴的缩放因子（列主序）
    // 列 0 × sx
    out[0] = (1 - (yy + zz)) * sx;
    out[1] = (xy + wz) * sx;
    out[2] = (xz - wy) * sx;
    out[3] = 0;
    // 列 1 × sy
    out[4] = (xy - wz) * sy;
    out[5] = (1 - (xx + zz)) * sy;
    out[6] = (yz + wx) * sy;
    out[7] = 0;
    // 列 2 × sz
    out[8] = (xz + wy) * sz;
    out[9] = (yz - wx) * sz;
    out[10] = (1 - (xx + yy)) * sz;
    out[11] = 0;
    // 列 3：平移
    out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;

    return out;
}

/**
 * 从 4x4 矩阵中提取平移分量（列 3 的前 3 个元素）。
 *
 * @param out - 结果 Vec3f（预分配）
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * const pos = vec3.create();
 * mat4.getTranslation(pos, modelMatrix); // pos = [tx, ty, tz]
 */
export function getTranslation(out: Vec3f, a: Mat4f): Vec3f {
    // 列主序下平移在索引 12, 13, 14
    out[0] = a[12];
    out[1] = a[13];
    out[2] = a[14];
    return out;
}

/**
 * 从 4x4 矩阵中提取各轴缩放因子。
 * 缩放 = 每列向量的长度。
 *
 * @param out - 结果 Vec3f（预分配），[scaleX, scaleY, scaleZ]
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * const s = vec3.create();
 * mat4.getScaling(s, modelMatrix); // s = [sx, sy, sz]
 */
export function getScaling(out: Vec3f, a: Mat4f): Vec3f {
    // 列 0 的前 3 个元素构成 X 轴向量，其长度即 X 缩放
    out[0] = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    // 列 1 的前 3 个元素构成 Y 轴向量
    out[1] = Math.sqrt(a[4] * a[4] + a[5] * a[5] + a[6] * a[6]);
    // 列 2 的前 3 个元素构成 Z 轴向量
    out[2] = Math.sqrt(a[8] * a[8] + a[9] * a[9] + a[10] * a[10]);
    return out;
}

/**
 * 从 4x4 矩阵中提取旋转四元数。
 * 先消除缩放影响（除以列向量长度），再从纯旋转矩阵提取四元数。
 * 使用 Shepperd 方法（数值稳定）。
 *
 * @param out - 结果四元数 [x, y, z, w]（预分配）
 * @param a - 源矩阵
 * @returns out 引用
 *
 * @example
 * const q = new Float32Array(4);
 * mat4.getRotation(q, modelMatrix);
 */
export function getRotation(out: Quatf, a: Mat4f): Quatf {
    // 先计算各列的缩放因子
    const sx = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    const sy = Math.sqrt(a[4] * a[4] + a[5] * a[5] + a[6] * a[6]);
    const sz = Math.sqrt(a[8] * a[8] + a[9] * a[9] + a[10] * a[10]);

    // 除以缩放因子得到纯旋转矩阵元素（防止零除）
    const isx = sx > 1e-6 ? 1 / sx : 0;
    const isy = sy > 1e-6 ? 1 / sy : 0;
    const isz = sz > 1e-6 ? 1 / sz : 0;

    // 去缩放后的旋转矩阵元素（列主序→行列表示）
    const m00 = a[0] * isx, m01 = a[1] * isx, m02 = a[2] * isx;
    const m10 = a[4] * isy, m11 = a[5] * isy, m12 = a[6] * isy;
    const m20 = a[8] * isz, m21 = a[9] * isz, m22 = a[10] * isz;

    // Shepperd 方法：选择对角线上最大元素对应的分支，避免数值不稳定
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        // trace > 0：w 最大
        const s = 0.5 / Math.sqrt(trace + 1.0);
        out[3] = 0.25 / s;
        out[0] = (m12 - m21) * s;
        out[1] = (m20 - m02) * s;
        out[2] = (m01 - m10) * s;
    } else if (m00 > m11 && m00 > m22) {
        // m00 最大：x 分支
        const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
        out[3] = (m12 - m21) / s;
        out[0] = 0.25 * s;
        out[1] = (m01 + m10) / s;
        out[2] = (m20 + m02) / s;
    } else if (m11 > m22) {
        // m11 最大：y 分支
        const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
        out[3] = (m20 - m02) / s;
        out[0] = (m01 + m10) / s;
        out[1] = 0.25 * s;
        out[2] = (m12 + m21) / s;
    } else {
        // m22 最大：z 分支
        const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
        out[3] = (m01 - m10) / s;
        out[0] = (m20 + m02) / s;
        out[1] = (m12 + m21) / s;
        out[2] = 0.25 * s;
    }

    return out;
}
