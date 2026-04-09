// ============================================================
// l2/csm-cascades.ts — Cascaded Shadow Maps 分割/矩阵计算
// ============================================================
//
// 为 compositor/csm.wgsl 提供 CSM 所需的 uniform 数据：
// - 每级级联的视空间分割距离
// - 每级级联的光空间 VP 矩阵（正交投影包围）
//
// 使用 "practical split scheme" (Zhang 2006)：
//   split_i = lambda · uniform(i) + (1 - lambda) · logarithmic(i)
// lambda = 0.5 是工业常用折中。
//
// 全部 Float64 计算，最后按需写入 Float32 GPU 缓冲。
// ============================================================

/**
 * CSM 配置参数。
 */
export interface CSMParams {
    /** 级联数（1-4） */
    readonly numCascades: number;
    /** 相机近平面（视空间距离） */
    readonly near: number;
    /** 相机远平面 */
    readonly far: number;
    /** 实际阴影有效距离（可小于 far，节省远处级联范围） */
    readonly shadowDistance: number;
    /** Lambda 0 = 纯线性分割，1 = 纯对数分割，0.5 典型 */
    readonly lambda: number;
}

/**
 * 计算结果。
 */
export interface CSMCascades {
    /** 每级末端的视空间距离（长度 = numCascades） */
    readonly splits: Float64Array;
    /** 每级光空间 VP 矩阵（扁平 16·numCascades，行主序 Float64） */
    readonly lightViewProj: Float64Array;
}

/**
 * 计算级联分割距离（Practical Split Scheme）。
 *
 * @param params CSM 参数
 * @returns 每级末端到相机的视空间距离（严格单调递增）
 *
 * @example
 * computeCascadeSplits({ numCascades:4, near:0.1, far:1000, shadowDistance:200, lambda:0.5 })
 * // → Float64Array [~3.5, ~16, ~60, 200]
 */
export function computeCascadeSplits(params: CSMParams): Float64Array {
    const { numCascades, near, far, shadowDistance, lambda } = params;
    const n = numCascades;
    const effectiveFar = Math.min(far, shadowDistance);

    const splits = new Float64Array(n);
    const ratio = effectiveFar / near;
    for (let i = 0; i < n; i++) {
        const p = (i + 1) / n;
        // 对数分割
        const log = near * Math.pow(ratio, p);
        // 均匀分割
        const uniform = near + (effectiveFar - near) * p;
        // 混合
        splits[i] = lambda * log + (1 - lambda) * uniform;
    }
    return splits;
}

/**
 * 给定 4x4 相机逆视图投影矩阵和级联近远距离，计算包住该级联视锥的
 * 光空间正交投影视锥，返回 4x4 光空间 VP 矩阵。
 *
 * 步骤：
 * 1. 构造级联视锥 8 顶点（NDC → world，通过 invViewProj）
 * 2. 把 8 顶点变换到光坐标系（lightView）
 * 3. 求 AABB 得到正交视锥尺寸
 * 4. 组装 lightProj · lightView
 *
 * @param invViewProj 4x4 相机逆视图投影矩阵（行主序 Float64Array, length 16）
 * @param nearDistance 级联起始距离（视空间）
 * @param farDistance 级联结束距离（视空间）
 * @param lightDir 光方向单位向量（世界空间，指向光源）
 * @param out 输出光空间 VP 矩阵（Float64Array, length 16，行主序）
 */
export function computeLightSpaceVP(
    invViewProj: Float64Array | number[],
    nearDistance: number,
    farDistance: number,
    lightDir: readonly [number, number, number],
    out: Float64Array,
): void {
    // 1. 视锥 8 顶点（NDC 立方体，近平面 z=0 / 远平面 z=1，WebGPU 约定）
    const ndcCorners: Array<[number, number, number]> = [
        [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], // 近
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], // 远
    ];
    const worldCorners: Array<[number, number, number]> = new Array(8);
    for (let i = 0; i < 8; i++) {
        const [x, y, z] = ndcCorners[i];
        const wx = invViewProj[0] * x + invViewProj[1] * y + invViewProj[2] * z + invViewProj[3];
        const wy = invViewProj[4] * x + invViewProj[5] * y + invViewProj[6] * z + invViewProj[7];
        const wz = invViewProj[8] * x + invViewProj[9] * y + invViewProj[10] * z + invViewProj[11];
        const ww = invViewProj[12] * x + invViewProj[13] * y + invViewProj[14] * z + invViewProj[15];
        worldCorners[i] = [wx / ww, wy / ww, wz / ww];
    }

    // 2. 根据 nearDistance/farDistance 对角线插值，得到本级联的实际视锥角点
    // 近/远分别对应 z=0/z=1，实际级联的近远是 near/far 的插值比例
    // 先求相机位置（所有近平面点的质心）
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 4; i++) {
        cx += worldCorners[i][0];
        cy += worldCorners[i][1];
        cz += worldCorners[i][2];
    }
    cx /= 4; cy /= 4; cz /= 4;

    // 近点沿视线方向延伸到 nearDistance / farDistance
    // 估计视锥方向：far 平面质心 - 近平面质心
    let fx = 0, fy = 0, fz = 0;
    for (let i = 4; i < 8; i++) {
        fx += worldCorners[i][0];
        fy += worldCorners[i][1];
        fz += worldCorners[i][2];
    }
    fx /= 4; fy /= 4; fz /= 4;

    const dirX = fx - cx;
    const dirY = fy - cy;
    const dirZ = fz - cz;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    const dx = dirX / dirLen;
    const dy = dirY / dirLen;
    const dz = dirZ / dirLen;

    // 级联角点：近角点沿 dir 推 nearDistance，远角点推 farDistance
    const cascadeCorners: Array<[number, number, number]> = new Array(8);
    for (let i = 0; i < 4; i++) {
        const p = worldCorners[i];
        const t = nearDistance / dirLen;
        cascadeCorners[i] = [
            p[0] + dirX * t,
            p[1] + dirY * t,
            p[2] + dirZ * t,
        ];
    }
    for (let i = 4; i < 8; i++) {
        const p = worldCorners[i];
        const t = (farDistance - dirLen) / dirLen;
        cascadeCorners[i] = [
            p[0] + dirX * t,
            p[1] + dirY * t,
            p[2] + dirZ * t,
        ];
    }
    void dx; void dy; void dz;

    // 3. 构建光空间 view 矩阵：LookAt(center - lightDir, center, up)
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < 8; i++) {
        mx += cascadeCorners[i][0];
        my += cascadeCorners[i][1];
        mz += cascadeCorners[i][2];
    }
    mx /= 8; my /= 8; mz /= 8;

    const [lx, ly, lz] = lightDir;
    // 光位置沿 -lightDir 从 center 推出一段距离（这里用级联半径）
    let maxR2 = 0;
    for (let i = 0; i < 8; i++) {
        const ddx = cascadeCorners[i][0] - mx;
        const ddy = cascadeCorners[i][1] - my;
        const ddz = cascadeCorners[i][2] - mz;
        const r2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (r2 > maxR2) maxR2 = r2;
    }
    const R = Math.sqrt(maxR2);
    const eyeX = mx - lx * R;
    const eyeY = my - ly * R;
    const eyeZ = mz - lz * R;

    // LookAt：forward = center - eye = lightDir
    const fwdX = lx, fwdY = ly, fwdZ = lz;
    // right = normalize(cross(up_guess, forward))，up_guess = (0, 1, 0)，若平行则退化到 (1,0,0)
    let upGx = 0, upGy = 1, upGz = 0;
    if (Math.abs(fwdY) > 0.99) {
        upGx = 1; upGy = 0; upGz = 0;
    }
    let rightX = upGy * fwdZ - upGz * fwdY;
    let rightY = upGz * fwdX - upGx * fwdZ;
    let rightZ = upGx * fwdY - upGy * fwdX;
    const rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
    rightX /= rightLen; rightY /= rightLen; rightZ /= rightLen;
    // up = cross(forward, right)
    const upX = fwdY * rightZ - fwdZ * rightY;
    const upY = fwdZ * rightX - fwdX * rightZ;
    const upZ = fwdX * rightY - fwdY * rightX;

    // lightView（行主序 4x4，world→light）
    const lv = new Float64Array(16);
    lv[0] = rightX; lv[1] = rightY; lv[2] = rightZ; lv[3] = -(rightX * eyeX + rightY * eyeY + rightZ * eyeZ);
    lv[4] = upX;    lv[5] = upY;    lv[6] = upZ;    lv[7] = -(upX * eyeX + upY * eyeY + upZ * eyeZ);
    lv[8] = -fwdX;  lv[9] = -fwdY;  lv[10] = -fwdZ; lv[11] = (fwdX * eyeX + fwdY * eyeY + fwdZ * eyeZ);
    lv[12] = 0;     lv[13] = 0;     lv[14] = 0;     lv[15] = 1;

    // 4. 把 8 个角点变换到光空间，求 AABB
    let minLX = Infinity, minLY = Infinity, minLZ = Infinity;
    let maxLX = -Infinity, maxLY = -Infinity, maxLZ = -Infinity;
    for (let i = 0; i < 8; i++) {
        const p = cascadeCorners[i];
        const x = lv[0] * p[0] + lv[1] * p[1] + lv[2] * p[2] + lv[3];
        const y = lv[4] * p[0] + lv[5] * p[1] + lv[6] * p[2] + lv[7];
        const z = lv[8] * p[0] + lv[9] * p[1] + lv[10] * p[2] + lv[11];
        if (x < minLX) minLX = x; if (x > maxLX) maxLX = x;
        if (y < minLY) minLY = y; if (y > maxLY) maxLY = y;
        if (z < minLZ) minLZ = z; if (z > maxLZ) maxLZ = z;
    }

    // 5. 正交投影矩阵（WebGPU 约定：z ∈ [0,1]）
    const w = maxLX - minLX;
    const h = maxLY - minLY;
    const d = maxLZ - minLZ;
    const lp = new Float64Array(16);
    lp[0] = 2 / w;  lp[5] = 2 / h;  lp[10] = 1 / d;
    lp[3] = -(maxLX + minLX) / w;
    lp[7] = -(maxLY + minLY) / h;
    lp[11] = -minLZ / d;
    lp[15] = 1;

    // 6. out = lp · lv（行主序 4x4 乘法）
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += lp[r * 4 + k] * lv[k * 4 + c];
            }
            out[r * 4 + c] = sum;
        }
    }
}

/**
 * 一次性计算整套 CSM 级联（分割 + 每级光空间 VP）。
 *
 * @param params CSM 参数
 * @param invViewProj 相机逆视图投影矩阵（Float64Array length 16）
 * @param lightDir 光方向单位向量（世界空间）
 * @returns CSMCascades（splits + 扁平 lightViewProj 矩阵数组）
 */
export function computeCSMCascades(
    params: CSMParams,
    invViewProj: Float64Array | number[],
    lightDir: readonly [number, number, number],
): CSMCascades {
    const splits = computeCascadeSplits(params);
    const lightVP = new Float64Array(16 * params.numCascades);

    let prevDist = params.near;
    const tmp = new Float64Array(16);
    for (let i = 0; i < params.numCascades; i++) {
        const nextDist = splits[i];
        computeLightSpaceVP(invViewProj, prevDist, nextDist, lightDir, tmp);
        lightVP.set(tmp, i * 16);
        prevDist = nextDist;
    }

    return {
        splits,
        lightViewProj: lightVP,
    };
}
