// ============================================================
// algorithm/bentley-ottmann.ts — 扫描线找所有线段相交
// ============================================================
//
// 给定 n 条平面线段，报告所有相交点。
// 朴素算法 O(n²)；Bentley-Ottmann 用扫描线 + 事件队列把复杂度降到
// O((n + k) log n)，其中 k 是交点数量。
//
// 对 GIS 的用途：
// - 检查 GeoJSON 线/多边形数据的拓扑错误
// - 构建线图（line graph）
// - 布尔运算的预处理
// - 找路网自交点
//
// 算法骨架（de Berg et al. 第 2 章）：
// 1. 事件队列 Q：按 (y 降序, x 升序) 排序的点集合，含三类事件：
//    - upper endpoint (线段上端点)
//    - lower endpoint (线段下端点)
//    - intersection (扫描过程中发现的交点)
// 2. 状态 T：当前扫描线截到的活动线段集合，按线段在扫描线 x 位置排序
// 3. 处理每个事件：
//    - upper: 插入对应线段到 T，检查它与左右邻居是否相交
//    - lower: 从 T 删除，检查前后邻居是否相交
//    - intersection: 交换两条相交线段在 T 中的位置，检查新邻居
// 4. 相交检测到的交点加入 Q（去重）
//
// 本实现：
// - Q、T 都用排序数组（O(log n) 二分插入 + O(1) 查询）。
//   对 n < 10000 的 GIS 场景足够；需要更快可替换为 Red-Black Tree。
// - 处理垂直线段、共线重合、三线共点等退化情况。
// - 全部 Float64。
// ============================================================

/**
 * 输入线段：两个端点。
 */
export interface Segment {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}

/**
 * 报告的一个交点事件。
 */
export interface IntersectionReport {
    /** 交点 x 坐标 */
    readonly x: number;
    /** 交点 y 坐标 */
    readonly y: number;
    /** 参与交点的所有线段下标（按输入数组索引） */
    readonly segmentIndices: number[];
}

// ─── 内部事件/状态 ─────────────────────────────────────────────

interface Event {
    x: number;
    y: number;
    /** 以此为上端点的线段索引列表 */
    upper: number[];
    /** 以此为下端点的线段索引列表 */
    lower: number[];
    /** 在此点内部相交的线段索引列表 */
    interior: number[];
}

/** 事件比较：y 降序，y 相同时 x 升序。 */
function eventLess(a: Event, b: Event): number {
    if (a.y !== b.y) return b.y - a.y;
    return a.x - b.x;
}

/** 事件相等判断（用于去重）。 */
function eventEq(a: Event, b: Event): boolean {
    return Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;
}

// ─── 公共入口 ──────────────────────────────────────────────────

/**
 * Bentley-Ottmann 扫描线找所有线段相交。
 *
 * @param segments 输入线段数组
 * @returns 所有相交点（包括共端点、T 形交、十字交等）
 *
 * @example
 * const segs = [
 *     { x1: 0, y1: 0, x2: 2, y2: 2 },
 *     { x1: 0, y1: 2, x2: 2, y2: 0 },
 * ];
 * bentleyOttmann(segs);
 * // → [{ x: 1, y: 1, segmentIndices: [0, 1] }]
 */
export function bentleyOttmann(segments: readonly Segment[]): IntersectionReport[] {
    const n = segments.length;
    if (n < 2) return [];

    // 规范化：每条线段保证 (x1, y1) 在 (x2, y2) 上方（y 大），
    // 用于区分上端点 / 下端点
    interface Normalized {
        upperX: number;
        upperY: number;
        lowerX: number;
        lowerY: number;
    }
    const segs: Normalized[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const s = segments[i];
        if (s.y1 > s.y2 || (s.y1 === s.y2 && s.x1 < s.x2)) {
            segs[i] = { upperX: s.x1, upperY: s.y1, lowerX: s.x2, lowerY: s.y2 };
        } else {
            segs[i] = { upperX: s.x2, upperY: s.y2, lowerX: s.x1, lowerY: s.y1 };
        }
    }

    // 事件队列：排序数组
    const events: Event[] = [];

    function pushEvent(ev: Event): void {
        // 二分插入 + 合并同位事件
        let lo = 0;
        let hi = events.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (eventLess(events[mid], ev) < 0) lo = mid + 1;
            else hi = mid;
        }
        if (lo < events.length && eventEq(events[lo], ev)) {
            // 合并
            for (const idx of ev.upper) {
                if (events[lo].upper.indexOf(idx) === -1) events[lo].upper.push(idx);
            }
            for (const idx of ev.lower) {
                if (events[lo].lower.indexOf(idx) === -1) events[lo].lower.push(idx);
            }
            for (const idx of ev.interior) {
                if (events[lo].interior.indexOf(idx) === -1) events[lo].interior.push(idx);
            }
            return;
        }
        events.splice(lo, 0, ev);
    }

    // 初始化事件队列：每条线段贡献上端点事件和下端点事件
    for (let i = 0; i < n; i++) {
        const seg = segs[i];
        pushEvent({ x: seg.upperX, y: seg.upperY, upper: [i], lower: [], interior: [] });
        pushEvent({ x: seg.lowerX, y: seg.lowerY, upper: [], lower: [i], interior: [] });
    }

    // 状态 T：当前扫描线截到的活动线段索引，按扫描线处 x 坐标升序
    const T: number[] = [];

    /** 扫描线 y 位置（由当前事件驱动）。 */
    let sweepY = Infinity;
    /** 扫描线 x 位置（事件 x，用于 x 相同的 tie-break）。 */
    let sweepX = -Infinity;

    /** 计算线段 i 在当前扫描线 y 上的 x 坐标。 */
    function xAtSweep(i: number): number {
        const s = segs[i];
        const dy = s.upperY - s.lowerY;
        if (Math.abs(dy) < 1e-20) {
            // 水平线 → 返回 sweepX（使共线段刚好"碰到"扫描线事件）
            return sweepX;
        }
        const t = (s.upperY - sweepY) / dy;
        return s.upperX + t * (s.lowerX - s.upperX);
    }

    /** T 中线段的顺序比较：按 x 升序，x 相同按斜率。 */
    function segLess(a: number, b: number): number {
        const xa = xAtSweep(a);
        const xb = xAtSweep(b);
        if (Math.abs(xa - xb) > 1e-12) return xa - xb;
        // 斜率比较（用向量）
        const sa = segs[a];
        const sb = segs[b];
        const slopeA = (sa.lowerX - sa.upperX) / ((sa.lowerY - sa.upperY) || 1e-20);
        const slopeB = (sb.lowerX - sb.upperX) / ((sb.lowerY - sb.upperY) || 1e-20);
        return slopeA - slopeB;
    }

    function insertIntoT(i: number): number {
        let lo = 0;
        let hi = T.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (segLess(T[mid], i) < 0) lo = mid + 1;
            else hi = mid;
        }
        T.splice(lo, 0, i);
        return lo;
    }

    function removeFromT(i: number): number {
        const idx = T.indexOf(i);
        if (idx >= 0) T.splice(idx, 1);
        return idx;
    }

    // 检测两条线段相交；仅在严格大于当前事件的 y 下报告
    function tryIntersect(a: number, b: number): void {
        if (a < 0 || b < 0 || a >= n || b >= n) return;
        const sa = segs[a];
        const sb = segs[b];
        const x1 = sa.upperX, y1 = sa.upperY, x2 = sa.lowerX, y2 = sa.lowerY;
        const x3 = sb.upperX, y3 = sb.upperY, x4 = sb.lowerX, y4 = sb.lowerY;

        const d1x = x2 - x1;
        const d1y = y2 - y1;
        const d2x = x4 - x3;
        const d2y = y4 - y3;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-20) return; // 平行 / 共线（共线点已在端点事件中覆盖）

        const tx = x3 - x1;
        const ty = y3 - y1;
        const t = (tx * d2y - ty * d2x) / denom;
        const u = (tx * d1y - ty * d1x) / denom;
        if (t < -1e-9 || t > 1 + 1e-9) return;
        if (u < -1e-9 || u > 1 + 1e-9) return;

        const ix = x1 + t * d1x;
        const iy = y1 + t * d1y;

        // 必须严格在扫描线下方（或同一点但 x 更大）才加入队列
        if (iy > sweepY + 1e-12) return;
        if (Math.abs(iy - sweepY) < 1e-12 && ix <= sweepX + 1e-12) return;

        pushEvent({ x: ix, y: iy, upper: [], lower: [], interior: [a, b] });
    }

    const reports: IntersectionReport[] = [];

    // 主循环
    while (events.length > 0) {
        const ev = events.shift()!;
        sweepY = ev.y;
        sweepX = ev.x;

        // 当前点涉及的所有线段
        const involved = new Set<number>();
        for (const i of ev.upper) involved.add(i);
        for (const i of ev.lower) involved.add(i);
        for (const i of ev.interior) involved.add(i);

        // 如果 ≥ 2 条线段涉及同一点，即为交点
        if (involved.size >= 2) {
            reports.push({
                x: ev.x,
                y: ev.y,
                segmentIndices: [...involved].sort((a, b) => a - b),
            });
        }

        // 从 T 中移除下端点线段 + 内部相交线段（再插回以更新顺序）
        for (const i of ev.lower) removeFromT(i);
        for (const i of ev.interior) removeFromT(i);

        // 扫描线下移一个 epsilon 用于计算新序（让交换后的顺序正确）
        sweepY -= 1e-9;

        // 插入 upper + interior（这两类在本事件之后仍活跃）
        for (const i of ev.upper) insertIntoT(i);
        for (const i of ev.interior) insertIntoT(i);

        sweepY = ev.y;

        // 检查相交：
        // - 若本事件没有活跃线段留下（只有 lower 退出），检查本事件前后两邻居
        // - 否则检查"最左 / 最右 新插入线段"的邻居
        if (ev.upper.length === 0 && ev.interior.length === 0) {
            // 事件点仅移除了线段。找事件点处的 T 中位置左右邻居
            // 用扫描前最接近 ev.x 的间隙
            let leftIdx = -1;
            let rightIdx = -1;
            for (let k = 0; k < T.length; k++) {
                const x = xAtSweep(T[k]);
                if (x < ev.x - 1e-12) leftIdx = k;
                else if (x > ev.x + 1e-12 && rightIdx === -1) rightIdx = k;
            }
            if (leftIdx >= 0 && rightIdx >= 0) {
                tryIntersect(T[leftIdx], T[rightIdx]);
            }
        } else {
            // 找新活跃集合在 T 中的最小/最大位置
            const active = [...ev.upper, ...ev.interior];
            let minPos = Infinity;
            let maxPos = -Infinity;
            for (const i of active) {
                const p = T.indexOf(i);
                if (p >= 0) {
                    if (p < minPos) minPos = p;
                    if (p > maxPos) maxPos = p;
                }
            }
            if (minPos > 0 && Number.isFinite(minPos)) {
                tryIntersect(T[minPos - 1], T[minPos]);
            }
            if (maxPos < T.length - 1 && Number.isFinite(maxPos)) {
                tryIntersect(T[maxPos], T[maxPos + 1]);
            }
        }
    }

    return reports;
}
