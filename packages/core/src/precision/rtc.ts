// ============================================================
// precision/rtc.ts — Relative-To-Center (RTC) 坐标偏移
// 将高精度 Float64 坐标转换为相对于中心点的 Float32 偏移量。
// 通过减去一个公共中心点，使得顶点坐标值变小，
// 从而可以安全地用 Float32 表示而不丢失有效精度。
// 零外部依赖。
// ============================================================

// ======================== 公共 API ========================

/**
 * 计算一组 3D 位置的质心作为 RTC 中心。
 * 质心是所有顶点坐标分量的算术平均值。
 * 使用质心作为 RTC 中心可以最大化所有顶点偏移量的精度——
 * 偏移量的绝对值最小化，Float32 的有效位数利用最充分。
 *
 * @param positions - 平铺的 3D 坐标数组 [x1,y1,z1, x2,y2,z2, ...]，
 *                    长度必须是 3 的倍数
 * @returns 质心坐标 Float64Array [cx, cy, cz]，作为 RTC 中心传给 GPU uniform
 *
 * @example
 * const positions = new Float64Array([
 *   -2187110.0, 4524060.0, 4069060.0,  // ECEF 坐标 1
 *   -2187120.0, 4524070.0, 4069050.0,  // ECEF 坐标 2
 * ]);
 * const center = computeRTCCenter(positions);
 * // center ≈ [-2187115.0, 4524065.0, 4069055.0]（两个点的中点）
 */
export function computeRTCCenter(positions: Float64Array): Float64Array {
    // 结果：3 分量质心
    const center = new Float64Array(3);

    // 空数组返回零中心
    if (positions.length === 0) {
        return center;
    }

    // 计算顶点数（每个顶点 3 个分量）
    const vertexCount = Math.floor(positions.length / 3);

    // 顶点数为 0 时返回零中心
    if (vertexCount === 0) {
        return center;
    }

    // 累加所有顶点的各分量
    // 使用 Kahan 求和补偿浮点累加误差（对大量 ECEF 坐标很重要）
    let sumX = 0.0;
    let sumY = 0.0;
    let sumZ = 0.0;
    let compX = 0.0;
    let compY = 0.0;
    let compZ = 0.0;

    for (let i = 0; i < vertexCount; i++) {
        const offset = i * 3;

        // Kahan 补偿求和 —— X 分量
        let yc = positions[offset] - compX;
        let t = sumX + yc;
        compX = (t - sumX) - yc;
        sumX = t;

        // Kahan 补偿求和 —— Y 分量
        yc = positions[offset + 1] - compY;
        t = sumY + yc;
        compY = (t - sumY) - yc;
        sumY = t;

        // Kahan 补偿求和 —— Z 分量
        yc = positions[offset + 2] - compZ;
        t = sumZ + yc;
        compZ = (t - sumZ) - yc;
        sumZ = t;
    }

    // 除以顶点数得到质心
    center[0] = sumX / vertexCount;
    center[1] = sumY / vertexCount;
    center[2] = sumZ / vertexCount;

    return center;
}

/**
 * 将 3D 坐标从绝对坐标偏移为相对于 RTC 中心的 Float32 坐标。
 * 对每个顶点执行 out[i] = Float32(positions[i] - center[i % 3])。
 * 偏移后的值通常很小（瓦片范围内几百到几千米），Float32 精度完全足够。
 *
 * @param positions - 输入 Float64Array，平铺 3D 坐标 [x1,y1,z1, x2,y2,z2, ...]
 * @param center - RTC 中心 Float64Array [cx, cy, cz]（通常由 computeRTCCenter 计算）
 * @param out - 输出 Float32Array（必须预分配，长度 ≥ positions.length）
 * @returns out 引用，便于链式调用
 *
 * @example
 * const positions = new Float64Array([-2187110, 4524060, 4069060]);
 * const center = new Float64Array([-2187115, 4524065, 4069055]);
 * const out = new Float32Array(3);
 * offsetPositions(positions, center, out);
 * // out ≈ [5.0, -5.0, 5.0]（相对于中心的小偏移量，Float32 精度足够）
 */
export function offsetPositions(
    positions: Float64Array,
    center: Float64Array,
    out: Float32Array,
): Float32Array {
    // 空输入快速返回
    if (positions.length === 0) {
        return out;
    }

    // 缓存中心坐标到局部变量，避免数组寻址开销
    const cx = center[0];
    const cy = center[1];
    const cz = center[2];

    // 计算安全处理长度
    const len = Math.min(positions.length, out.length);

    // 每 3 个分量为一组（xyz），减去中心坐标
    let i = 0;
    // 主循环：完整的三元组
    const tripletEnd = len - (len % 3);
    for (; i < tripletEnd; i += 3) {
        out[i] = positions[i] - cx;
        out[i + 1] = positions[i + 1] - cy;
        out[i + 2] = positions[i + 2] - cz;
    }
    // 处理剩余的 1~2 个分量（不完整的三元组）
    if (i < len) {
        out[i] = positions[i] - cx;
    }
    if (i + 1 < len) {
        out[i + 1] = positions[i + 1] - cy;
    }

    return out;
}

/**
 * 将 ECEF（Earth-Centered Earth-Fixed）坐标转换为相对于 RTC 中心的 Float32 坐标。
 * 与 offsetPositions 功能相同，但语义更明确——
 * 输入是 ECEF 笛卡尔坐标（通常由 ellipsoid.geodeticToECEF 生成），
 * 输出是相对于 RTC 中心的 Float32 偏移量。
 *
 * ECEF 坐标值可达数百万米量级（如 X ≈ -2,187,110），
 * 直接用 Float32 会丢失有效精度（Float32 在该量级仅约 0.125m 精度），
 * 减去 RTC 中心后偏移量通常在 ±数千米范围内，Float32 精度可达 ±0.001m。
 *
 * @param ecef - 输入 ECEF 坐标 Float64Array [x1,y1,z1, ...]
 * @param rtcCenter - RTC 中心 ECEF 坐标 Float64Array [cx, cy, cz]
 * @param out - 输出 Float32Array（必须预分配）
 * @returns out 引用
 *
 * @example
 * const ecef = new Float64Array([-2187110.0, 4524060.0, 4069060.0]);
 * const center = new Float64Array([-2187115.0, 4524065.0, 4069055.0]);
 * const out = new Float32Array(3);
 * fromECEF(ecef, center, out);
 * // out ≈ [5.0, -5.0, 5.0]
 */
export function fromECEF(
    ecef: Float64Array,
    rtcCenter: Float64Array,
    out: Float32Array,
): Float32Array {
    // 委托给 offsetPositions，语义相同只是参数名更明确
    return offsetPositions(ecef, rtcCenter, out);
}
