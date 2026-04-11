// ============================================================
// algorithm/douglas-peucker-3d.ts — 3D Douglas-Peucker 折线简化
//
// 经典 Douglas-Peucker 在二维下度量的是 "点到弦" 的垂直距离；推广到三维
// 时，弦是一条 3D 线段，垂距是 "点到该线段所在直线" 的最短距离（不是
// 到无限平面）。其它策略一致：
//
//   1. 保留首尾两个点；
//   2. 在中间点中找出离首尾连线 3D 距离最大的点 P_max（距离 d_max）；
//   3. 若 d_max ≤ tolerance，丢弃所有中间点；
//      否则在 P_max 处分割，递归处理两段。
//
// 使用迭代实现以避免极长输入栈溢出。复杂度 O(n log n) 平均，O(n²) 最差。
// ============================================================

const EPS = 1e-12;

/** 3D 点：[x, y, z]（任意单位，本算法不假设投影） */
export type Point3D = readonly [number, number, number];

/**
 * 计算点 P 到经过 A、B 的 3D 直线的最短距离。
 * 公式： d = |(P - A) × (B - A)| / |B - A|
 */
function distancePointToLine3D(p: Point3D, a: Point3D, b: Point3D): number {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const apx = p[0] - a[0];
    const apy = p[1] - a[1];
    const apz = p[2] - a[2];

    const ab2 = abx * abx + aby * aby + abz * abz;
    if (ab2 < EPS) {
        // A B 重合 → 退化为点到 A 的欧氏距离
        return Math.hypot(apx, apy, apz);
    }

    // (P - A) × (B - A)
    const cx = apy * abz - apz * aby;
    const cy = apz * abx - apx * abz;
    const cz = apx * aby - apy * abx;

    const crossLen = Math.hypot(cx, cy, cz);
    return crossLen / Math.sqrt(ab2);
}

/**
 * 3D Douglas-Peucker 折线简化。
 *
 * @param points - 输入折线 3D 点序列
 * @param tolerance - 最大允许偏差（与点坐标同单位）。≤ 0 时返回原序列拷贝。
 * @returns 简化后的点序列（保留首尾点；首尾相同的环按环处理）
 *
 * @example
 * douglasPeucker3D([
 *   [0,0,0], [1,0.05,0], [2,0,0], [3,5,0], [4,0,0],
 * ], 0.1);
 * // → [[0,0,0], [2,0,0], [3,5,0], [4,0,0]]（中间噪点被丢弃）
 */
export function douglasPeucker3D(
    points: readonly Point3D[],
    tolerance: number,
): Point3D[] {
    const n = points.length;
    if (n <= 2 || tolerance <= 0) {
        return points.map((p) => [p[0], p[1], p[2]] as Point3D);
    }

    // 标记数组：true 表示保留
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    // 迭代栈：待处理的子段 [start, end]
    const stack: Array<[number, number]> = [[0, n - 1]];
    const tol2 = tolerance; // 直接比较距离即可

    while (stack.length > 0) {
        const [start, end] = stack.pop()!;
        if (end <= start + 1) { continue; }

        let maxDist = -1;
        let maxIdx = -1;
        const a = points[start];
        const b = points[end];
        for (let i = start + 1; i < end; i++) {
            const d = distancePointToLine3D(points[i], a, b);
            if (d > maxDist) {
                maxDist = d;
                maxIdx = i;
            }
        }

        if (maxDist > tol2 && maxIdx > 0) {
            keep[maxIdx] = 1;
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }

    const out: Point3D[] = [];
    for (let i = 0; i < n; i++) {
        if (keep[i]) {
            const p = points[i];
            out.push([p[0], p[1], p[2]]);
        }
    }
    return out;
}
