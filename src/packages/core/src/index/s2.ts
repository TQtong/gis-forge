// ============================================================
// index/s2.ts — S2 Geometry Cell 编解码（Google S2 的核心子集）
// ============================================================
//
// S2 是 Google 的层次化球面空间索引。它把地球用一个外切立方体的 6 个面映射
// 成 6 个象限（face 0..5），在每个面上做四叉树细分（level 0..30），并用
// Hilbert 空间填充曲线给所有单元一个 64-bit 排序键（Cell ID）。
//
// 关键性质：
// - 同一父节点的子节点 Cell ID 相邻 → 空间邻近 = 字典序邻近（绝大多数情况）。
// - 任意精度：level 0（6 个面的整个面）到 level 30（约 0.7 cm² 单元）。
// - 面积差异 ≈ 2.1 倍（最优压缩因子，优于四叉树的 5.6 倍）。
//
// 本实现：完整 face/i/j/Hilbert Cell ID 编码 + 反算。
// 支持：
// - latLngToCellId(lat, lng, level)     经纬度 → S2 Cell ID
// - cellIdToLatLng(cellId)              Cell ID → 经纬度中心
// - cellIdLevel(cellId)                 提取 level
// - cellIdFace(cellId)                  提取 face 0..5
// - cellIdParent(cellId, level)         向上取父节点
// - cellIdChildren(cellId)              4 个子节点
//
// Cell ID 使用 BigInt 表示（JavaScript Number 对 64-bit 整数会丢失精度）。
//
// 全部 Float64 浮点 + BigInt 整数运算。
// ============================================================

export type S2CellId = bigint;

const MAX_LEVEL = 30;
const POS_BITS = 2 * MAX_LEVEL + 1; // 61
// 最低位为哨兵 1，最高 3 位为 face。总共 64 bits.
const LSB_MASK: bigint = 1n;

// ─── 球面 → 立方体面坐标 ────────────────────────────────────

/**
 * 把单位球面坐标 (x,y,z) 映射到立方体面 + 面内 (u,v) ∈ [-1, 1]。
 * face 编号：
 *   0: +x
 *   1: +y
 *   2: +z
 *   3: -x
 *   4: -y
 *   5: -z
 */
function xyzToFaceUV(x: number, y: number, z: number): [number, number, number] {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    let face: number;
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
        if (x >= 0) { face = 0; u = y / x; v = z / x; }
        else { face = 3; u = y / x; v = z / x; }
    } else if (ay >= az) {
        if (y >= 0) { face = 1; u = -x / y; v = z / y; }
        else { face = 4; u = -x / y; v = z / y; }
    } else {
        if (z >= 0) { face = 2; u = -x / z; v = -y / z; }
        else { face = 5; u = -x / z; v = -y / z; }
    }
    return [face, u, v];
}

function faceUVToXYZ(face: number, u: number, v: number): [number, number, number] {
    switch (face) {
        case 0: return [1, u, v];
        case 1: return [-u, 1, v];
        case 2: return [-u, -v, 1];
        case 3: return [-1, -v, -u];
        case 4: return [v, -1, -u];
        default: return [v, u, -1];
    }
}

// ─── 非线性变换：u ↔ s（修正面内面积失真） ─────────────────
//
// S2 用二次变换 s = 0.5 · (1 + u) 后再做 u = f(s) 的反变换使面积更均匀。
// 这里用 Google S2 "QUADRATIC" 变换（最大误差 1.9% 对 "LINEAR" 的 3.7%）。

function uToS(u: number): number {
    return u >= 0
        ? 0.5 * Math.sqrt(1 + 3 * u)
        : 1 - 0.5 * Math.sqrt(1 - 3 * u);
}

function sToU(s: number): number {
    return s >= 0.5
        ? (1 / 3) * (4 * s * s - 1)
        : (1 / 3) * (1 - 4 * (1 - s) * (1 - s));
}

// ─── s ∈ [0,1] ↔ 离散 i ∈ [0, 2^30) ────────────────────────

const MAX_SI = 1 << MAX_LEVEL; // 2^30 ~ 1.07e9

function stToIJ(s: number): number {
    const i = Math.floor(MAX_SI * s);
    if (i < 0) return 0;
    if (i >= MAX_SI) return MAX_SI - 1;
    return i;
}

function ijToST(i: number): number {
    return (i + 0.5) / MAX_SI;
}

// ─── (i, j) ↔ Hilbert 位置 ──────────────────────────────────
//
// Hilbert 位置 p ∈ [0, 4^30)。交错两个 30-bit 整数并应用 Hilbert 旋转。
// 为了效率使用逐 bit 位运算，BigInt 累加结果。

/**
 * 把 (i, j) 编码为 level 30 的 Hilbert 位置（0..4^30-1）。
 * Hilbert 顺序取自 S2 参考实现的状态机：在每一级根据 (ix, iy) bit 决定
 * 子象限顺序和旋转。
 */
function ijToPos(i: number, j: number): bigint {
    // 初始方向：S2 default orientation
    let rx = 0;
    let ry = 0;
    let pos = 0n;
    // 从最高位开始处理
    for (let s = MAX_LEVEL - 1; s >= 0; s--) {
        rx = (i >> s) & 1;
        ry = (j >> s) & 1;
        // Gray code: d = (3*rx ^ ry)
        const d = BigInt((3 * rx) ^ ry);
        pos = (pos << 2n) | d;
        // 旋转 (i, j) 使子象限对齐下一级
        if (ry === 0) {
            if (rx === 1) {
                i = (1 << s) - 1 - i;
                j = (1 << s) - 1 - j;
            }
            // 交换 i, j
            const t = i;
            i = j;
            j = t;
        }
    }
    return pos;
}

/**
 * Hilbert 位置反算到 (i, j)。
 */
function posToIJ(pos: bigint): [number, number] {
    let i = 0;
    let j = 0;
    for (let s = 0; s < MAX_LEVEL; s++) {
        const d = Number((pos >> BigInt(2 * s)) & 3n);
        const rx = (d >> 1) & 1;
        const ry = (d & 1) ^ rx; // 反 Gray code
        if (ry === 0) {
            if (rx === 1) {
                i = (1 << s) - 1 - i;
                j = (1 << s) - 1 - j;
            }
            const t = i;
            i = j;
            j = t;
        }
        i |= rx << s;
        j |= ry << s;
    }
    return [i, j];
}

// ─── Cell ID 格式 ────────────────────────────────────────────
//
// Cell ID 64-bit 布局（高位到低位）：
//   face (3 bits) | Hilbert pos (2*level bits) | 1 | 0...0
// 最低为 1 的位称为"哨兵位"；其位置决定 level：
//   lsb 位置 = 2·(30 - level) + 1
// level 30 时 lsb 位置 = 1（最低位）。
// level 0 时 lsb 位置 = 61。

function cellIdFromFacePos(face: number, pos: bigint, level: number): S2CellId {
    // pos 已是 level 30 的 Hilbert 位置（2*30 bits）
    // 对应 level 的 Cell ID：把最低 2*(30-level) 位清零再 | 哨兵位
    const shift = BigInt(2 * (MAX_LEVEL - level));
    const trimmed = (pos >> shift) << shift;
    const lsb = 1n << shift;
    return (BigInt(face) << BigInt(POS_BITS)) | trimmed | lsb;
}

/**
 * 从 Cell ID 中提取 face 编号。
 */
export function cellIdFace(cellId: S2CellId): number {
    return Number(cellId >> BigInt(POS_BITS)) & 7;
}

/**
 * 提取 Cell 的 level（0..30）。
 *
 * level = MAX_LEVEL - floor(trailing_zero_count(lsb) / 2)
 * 其中 lsb 是哨兵位（最低位的 1）。
 */
export function cellIdLevel(cellId: S2CellId): number {
    if (cellId === 0n) return 0;
    let bit = cellId & (-cellId); // lowest set bit
    let zeros = 0;
    while ((bit & 1n) === 0n) {
        zeros++;
        bit >>= 1n;
    }
    return MAX_LEVEL - Math.floor(zeros / 2);
}

/**
 * 从 Cell ID 中提取 Hilbert 位置（已左对齐到 level 30）。
 */
function cellIdPos(cellId: S2CellId): bigint {
    const posMask = (1n << BigInt(POS_BITS)) - 1n;
    const raw = cellId & posMask;
    // 去掉哨兵位
    const lsb = raw & (-raw);
    return raw ^ lsb; // 清除 lsb
}

// ─── 公共 API ────────────────────────────────────────────────

/**
 * 经纬度 → S2 Cell ID。
 *
 * @param latDeg 纬度（度）
 * @param lngDeg 经度（度）
 * @param level  目标层级（0..30），默认 30
 * @returns 64-bit S2 Cell ID（BigInt）
 */
export function latLngToCellId(latDeg: number, lngDeg: number, level: number = MAX_LEVEL): S2CellId {
    if (level < 0) level = 0;
    if (level > MAX_LEVEL) level = MAX_LEVEL;

    // 经纬度 → 单位球面坐标（WGS84 球面近似）
    const lat = latDeg * Math.PI / 180;
    const lng = lngDeg * Math.PI / 180;
    const cosLat = Math.cos(lat);
    const x = Math.cos(lng) * cosLat;
    const y = Math.sin(lng) * cosLat;
    const z = Math.sin(lat);

    const [face, u, v] = xyzToFaceUV(x, y, z);
    const s = uToS(u);
    const t = uToS(v);
    const i = stToIJ(s);
    const j = stToIJ(t);
    const pos = ijToPos(i, j);
    return cellIdFromFacePos(face, pos, level);
}

/**
 * S2 Cell ID → 经纬度中心点。
 *
 * @returns [latDeg, lngDeg]
 */
export function cellIdToLatLng(cellId: S2CellId): [number, number] {
    const face = cellIdFace(cellId);
    // 取 Cell 的 Hilbert 位置，视为 level 30 的位置
    const pos = cellIdPos(cellId);
    const level = cellIdLevel(cellId);
    // 把 pos 左对齐（低位补 0 到 level 30）
    // 实际上 posMask 已经按 level 30 对齐；只是低位是 0 或任意
    // 把低位设到中心：对于 level < 30，中心位置在 cell 范围内部
    const midOffset = level < MAX_LEVEL
        ? (1n << BigInt(2 * (MAX_LEVEL - level) - 1))
        : 0n;
    const posCenter = pos + midOffset;
    const [i, j] = posToIJ(posCenter);
    const s = ijToST(i);
    const t = ijToST(j);
    const u = sToU(s);
    const v = sToU(t);
    const [x, y, z] = faceUVToXYZ(face, u, v);
    // 归一化
    const r = Math.hypot(x, y, z);
    const nx = x / r, ny = y / r, nz = z / r;
    const lat = Math.asin(nz) * 180 / Math.PI;
    const lng = Math.atan2(ny, nx) * 180 / Math.PI;
    return [lat, lng];
}

/**
 * 向上取父 Cell ID。
 *
 * @param cellId 原始 Cell
 * @param parentLevel 目标父级（必须 ≤ 当前 level）
 */
export function cellIdParent(cellId: S2CellId, parentLevel: number): S2CellId {
    const face = cellIdFace(cellId);
    const pos = cellIdPos(cellId);
    return cellIdFromFacePos(face, pos, parentLevel);
}

/**
 * 返回当前 Cell 的 4 个子 Cell ID。
 *
 * @param cellId 原始 Cell（必须 level < 30）
 */
export function cellIdChildren(cellId: S2CellId): [S2CellId, S2CellId, S2CellId, S2CellId] {
    const face = cellIdFace(cellId);
    const level = cellIdLevel(cellId);
    if (level >= MAX_LEVEL) {
        throw new Error('S2: cannot get children of level-30 cell');
    }
    const pos = cellIdPos(cellId);
    const childLevel = level + 1;
    const offset = 1n << BigInt(2 * (MAX_LEVEL - childLevel));
    return [
        cellIdFromFacePos(face, pos + 0n * offset, childLevel),
        cellIdFromFacePos(face, pos + 1n * offset, childLevel),
        cellIdFromFacePos(face, pos + 2n * offset, childLevel),
        cellIdFromFacePos(face, pos + 3n * offset, childLevel),
    ];
}

