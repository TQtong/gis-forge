// ============================================================
// globe/lod-geomorph.ts — 经典 LOD Geomorphing（消除级联跳变 pop）
// ============================================================
//
// LOD Geomorph 不同于 globe-tile-mesh.ts 中的 `computeMorphFactor`
// （后者是 2.5D ↔ 3D Globe 过渡）。
//
// 经典 LOD Geomorph 解决的问题：
// - 地形按相机距离分级 LOD（高级别 = 高分辨率，低级别 = 低分辨率）。
// - 当相机距离跨过级联阈值切换 LOD 时，相邻级的网格顶点位置不同
//   → 屏幕上出现明显的"地形跳变"伪像（pop）。
// - Geomorph 的解决方案：在级联切换的"模糊带"内，把高分辨率顶点
//   线性插值到它在父级（低分辨率）网格上对应位置。tile 距相机越远，
//   morph 因子越接近 1（完全退化为父级形状）；越近越接近 0（保持高分辨率）。
//
// 公式：
//   distance = ‖cameraPos − tileCenter‖
//   normalized = (distance − morphStart) / (morphEnd − morphStart)
//   morph = clamp(normalized, 0, 1)
//   finalPos = mix(highResPos, parentPos, morph)
//
// CPU 端职责（本文件）：
// 1. 计算每个 tile 的 morph 因子（CameraDistanceToMorph）
// 2. 计算每个高分辨率顶点对应的"父级顶点位置"（GeomorphVertexBuilder）
//    —— 在 4×4 → 2×2 降采样时，奇数 i 的顶点取相邻偶数 i 的中点
// 3. 把 (highResPos, parentPos, morphFactor) 喂给 vertex shader
//
// GPU 端（vertex shader）：
//   final_pos = mix(in.position, in.parentPosition, uniforms.morphFactor);
//
// 配套的 WGSL 顶点着色器片段在文件末尾的 `LOD_GEOMORPH_VERTEX_WGSL` 字符串。
// ============================================================

/**
 * LOD Geomorph 配置参数。
 */
export interface LODGeomorphConfig {
    /** Morph 开始的归一化距离（0 = 此距离时还未开始 morph） */
    readonly morphStart: number;
    /** Morph 完成的归一化距离（≥ 此距离时完全退化为父级网格） */
    readonly morphEnd: number;
}

/**
 * 计算单个 tile 的 morph 因子。
 *
 * @param cameraPos 相机世界坐标
 * @param tileCenter tile 中心世界坐标
 * @param tileSize tile 边长（用作距离归一化单位）
 * @param config 配置
 * @returns morph ∈ [0, 1]，0 = 保持高分辨率，1 = 完全退化为父级
 *
 * @example
 * const morph = computeTileGeomorph(
 *   [0, 0, 1000],
 *   [500, 500, 0],
 *   1000,
 *   { morphStart: 0.5, morphEnd: 1.5 },
 * );
 */
export function computeTileGeomorph(
    cameraPos: readonly [number, number, number],
    tileCenter: readonly [number, number, number],
    tileSize: number,
    config: LODGeomorphConfig,
): number {
    if (tileSize <= 0) return 0;
    const dx = cameraPos[0] - tileCenter[0];
    const dy = cameraPos[1] - tileCenter[1];
    const dz = cameraPos[2] - tileCenter[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const normalized = dist / tileSize;
    if (normalized <= config.morphStart) return 0;
    if (normalized >= config.morphEnd) return 1;
    return (normalized - config.morphStart) / (config.morphEnd - config.morphStart);
}

/**
 * 给一组 tile 计算各自的 morph 因子（批量）。
 */
export function computeTileGeomorphBatch(
    cameraPos: readonly [number, number, number],
    tileCenters: ReadonlyArray<readonly [number, number, number]>,
    tileSizes: ReadonlyArray<number>,
    config: LODGeomorphConfig,
    out?: Float32Array,
): Float32Array {
    const n = tileCenters.length;
    const result = out ?? new Float32Array(n);
    for (let i = 0; i < n; i++) {
        result[i] = computeTileGeomorph(cameraPos, tileCenters[i], tileSizes[i], config);
    }
    return result;
}

/**
 * 给定一个 (n+1) × (n+1) 的高分辨率网格顶点数组（行主序，每顶点 3 个 f32），
 * 计算它在父级（n/2 + 1 横向分辨率）网格上"对应的"父级位置。
 *
 * 父级位置定义：
 * - 当 (col, row) 都为偶数时，父级顶点 = 自身（无变化）
 * - 当 col 为奇数 row 为偶数时，父级顶点 = (col-1, row) 与 (col+1, row) 的中点
 * - 当 col 为偶数 row 为奇数时，父级顶点 = (col, row-1) 与 (col, row+1) 的中点
 * - 当 col 和 row 都为奇数时，父级顶点 = 周围 4 个偶数顶点的双线性中心
 *
 * 输出与输入同形状（每顶点 3 个 f32）。配合 `morph factor` 在顶点着色器
 * 中插值即可消除 pop。
 *
 * @param highResPositions Float32Array (rows*cols*3)，高分辨率位置
 * @param cols 列数（顶点数，不是 cell 数）
 * @param rows 行数
 * @param out 输出 Float32Array（可选，可重用）
 */
export function buildParentPositions(
    highResPositions: Float32Array,
    cols: number,
    rows: number,
    out?: Float32Array,
): Float32Array {
    const result = out ?? new Float32Array(highResPositions.length);

    function get(c: number, r: number, axis: 0 | 1 | 2): number {
        const cc = Math.max(0, Math.min(cols - 1, c));
        const rr = Math.max(0, Math.min(rows - 1, r));
        return highResPositions[(rr * cols + cc) * 3 + axis];
    }

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const baseIdx = (r * cols + c) * 3;
            const cOdd = (c & 1) === 1;
            const rOdd = (r & 1) === 1;

            if (!cOdd && !rOdd) {
                // 自身就是父级顶点
                result[baseIdx] = highResPositions[baseIdx];
                result[baseIdx + 1] = highResPositions[baseIdx + 1];
                result[baseIdx + 2] = highResPositions[baseIdx + 2];
            } else if (cOdd && !rOdd) {
                // 左右中点
                for (let a = 0 as 0 | 1 | 2; a <= 2; a = (a + 1) as 0 | 1 | 2) {
                    result[baseIdx + a] = 0.5 * (get(c - 1, r, a) + get(c + 1, r, a));
                }
            } else if (!cOdd && rOdd) {
                // 上下中点
                for (let a = 0 as 0 | 1 | 2; a <= 2; a = (a + 1) as 0 | 1 | 2) {
                    result[baseIdx + a] = 0.5 * (get(c, r - 1, a) + get(c, r + 1, a));
                }
            } else {
                // 4 角点平均
                for (let a = 0 as 0 | 1 | 2; a <= 2; a = (a + 1) as 0 | 1 | 2) {
                    result[baseIdx + a] = 0.25 * (
                        get(c - 1, r - 1, a)
                        + get(c + 1, r - 1, a)
                        + get(c - 1, r + 1, a)
                        + get(c + 1, r + 1, a)
                    );
                }
            }
        }
    }

    return result;
}

/**
 * 配套的 WGSL vertex shader 片段：把 `position` 与 `parentPosition` 按
 * `uniforms.morphFactor` 插值得到 `morphedPos`。
 *
 * 集成方式：把这段字符串拼到上层 vertex shader 的开头（在投影变换之前）。
 *
 * 预期 vertex 输入布局：
 *   @location(0) position: vec3<f32>
 *   @location(1) parentPosition: vec3<f32>
 * 预期 uniform：
 *   uniforms.morphFactor: f32
 */
export const LOD_GEOMORPH_VERTEX_WGSL: string = `
// LOD Geomorph helper：在高分辨率顶点和父级位置之间插值。
// 调用：let pos = applyGeomorph(in.position, in.parentPosition, u.morphFactor);
fn applyGeomorph(
    highRes: vec3<f32>,
    parent: vec3<f32>,
    morph: f32,
) -> vec3<f32> {
    return mix(highRes, parent, clamp(morph, 0.0, 1.0));
}
`;
