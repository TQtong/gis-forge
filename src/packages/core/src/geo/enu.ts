// ============================================================
// geo/enu.ts — ENU（East-North-Up）局部切线坐标系构建
// 层级：L0（基础层）
// 职责：给定 ECEF 位置，计算 ENU 基向量和 4x4 变换矩阵。
//       包含 Cesium 兼容的极点退化处理（x≈0,y≈0 时硬编码 ENU 方向）。
// 依赖：无（纯数学）
// 被消费：Camera3D（heading/pitch/roll 计算）、ScreenSpaceCameraController（tilt 参考系）
// ============================================================

/**
 * 在 ECEF 坐标系中，给定某点的 ECEF 位置 [x,y,z]，计算该点的 ENU 局部坐标系。
 *
 * ENU 坐标系定义：
 *   - East：沿地表向东的单位向量
 *   - North：沿地表向北的单位向量
 *   - Up：沿椭球面法线向上的单位向量
 *
 * 极点特殊处理（匹配 Cesium Transforms.js）：
 *   当 x≈0 且 y≈0（即位于南/北极附近）时，常规 ENU 计算退化
 *   （因为"东"方向 = normalize(-y, x, 0) 变为零向量）。
 *   此时使用硬编码退化方案：
 *     北极（z>0）：east=[0,1,0], north=[-1,0,0], up=[0,0,1]
 *     南极（z<0）：east=[0,1,0], north=[1,0,0], up=[0,0,-1]
 *
 * @param east  - 输出：East 单位向量，Float64Array(3)
 * @param north - 输出：North 单位向量，Float64Array(3)
 * @param up    - 输出：Up 单位向量，Float64Array(3)
 * @param x     - ECEF X 坐标（米）
 * @param y     - ECEF Y 坐标（米）
 * @param z     - ECEF Z 坐标（米）
 */
export function computeENUBasis(
    east: Float64Array,
    north: Float64Array,
    up: Float64Array,
    x: number,
    y: number,
    z: number,
): void {
    // 水平距离 p = sqrt(x² + y²)
    // 当 p ≈ 0 时位于极点附近，ENU 退化需要特殊处理
    const p = Math.sqrt(x * x + y * y);

    if (p < 1e-10) {
        // ── 极点退化情况 ──
        // 常规公式 east = normalize(-y, x, 0) 会产生零向量
        // 采用 Cesium 的硬编码方案，保证 heading/pitch/roll 在极点仍有定义

        if (z >= 0) {
            // 北极：east 指向 +Y（ECEF），north 指向 -X（ECEF），up 指向 +Z
            east[0] = 0; east[1] = 1; east[2] = 0;
            north[0] = -1; north[1] = 0; north[2] = 0;
            up[0] = 0; up[1] = 0; up[2] = 1;
        } else {
            // 南极：east 指向 +Y（ECEF），north 指向 +X（ECEF），up 指向 -Z
            east[0] = 0; east[1] = 1; east[2] = 0;
            north[0] = 1; north[1] = 0; north[2] = 0;
            up[0] = 0; up[1] = 0; up[2] = -1;
        }
        return;
    }

    // ── 常规情况 ──
    // Up = normalize(ECEF position)（球面近似法线，对 WGS84 扁率误差 < 0.2°）
    const invLen = 1.0 / Math.sqrt(x * x + y * y + z * z);
    up[0] = x * invLen;
    up[1] = y * invLen;
    up[2] = z * invLen;

    // East = normalize(-y, x, 0)
    // 这是 Up 向量投影到赤道平面后，逆时针旋转 90° 得到的水平东向
    const invP = 1.0 / p;
    east[0] = -y * invP;
    east[1] = x * invP;
    east[2] = 0;

    // North = Up × East（右手定则：上叉东=北）
    north[0] = up[1] * east[2] - up[2] * east[1];
    north[1] = up[2] * east[0] - up[0] * east[2];
    north[2] = up[0] * east[1] - up[1] * east[0];
}

/**
 * 构建 ENU → ECEF 的 4x4 变换矩阵（列主序）。
 *
 * 矩阵结构（列主序）：
 *   | E.x  N.x  U.x  P.x |
 *   | E.y  N.y  U.y  P.y |
 *   | E.z  N.z  U.z  P.z |
 *   |  0    0    0    1   |
 *
 * 其中 E=East, N=North, U=Up 为旋转部分，P=ECEF position 为平移部分。
 * 该矩阵将 ENU 局部坐标变换到 ECEF 世界坐标。
 *
 * @param out - 输出 4x4 矩阵，Float64Array(16)，列主序
 * @param x   - ECEF X（米）
 * @param y   - ECEF Y（米）
 * @param z   - ECEF Z（米）
 * @returns out 引用
 */
export function eastNorthUpToFixedFrame(
    out: Float64Array,
    x: number,
    y: number,
    z: number,
): Float64Array {
    // 复用栈上临时变量（热路径避免堆分配）
    const east = _tmpE;
    const north = _tmpN;
    const up = _tmpU;

    computeENUBasis(east, north, up, x, y, z);

    // 列 0: East
    out[0] = east[0];
    out[1] = east[1];
    out[2] = east[2];
    out[3] = 0;
    // 列 1: North
    out[4] = north[0];
    out[5] = north[1];
    out[6] = north[2];
    out[7] = 0;
    // 列 2: Up
    out[8] = up[0];
    out[9] = up[1];
    out[10] = up[2];
    out[11] = 0;
    // 列 3: 平移（ECEF 位置）
    out[12] = x;
    out[13] = y;
    out[14] = z;
    out[15] = 1;

    return out;
}

// ── 模块级临时变量（避免 computeENUBasis 在热路径上分配） ──
const _tmpE = new Float64Array(3);
const _tmpN = new Float64Array(3);
const _tmpU = new Float64Array(3);
