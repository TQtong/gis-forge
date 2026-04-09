// ============================================================
// algorithm/monotone.ts — 多边形单调分解 (Y-Monotone Decomposition)
// ============================================================
//
// 把一个简单多边形分解为若干 y-单调子多边形。y-单调指：任一水平线与
// 多边形边界的交点最多 2 个（即多边形沿 y 方向只有一个凸/凹但不反折）。
//
// 这是"将任意简单多边形三角化"的经典中间步骤（de Berg et al
// "Computational Geometry: Algorithms and Applications" 第 3 章）：
//   1) y-monotone decomposition
//   2) 再对每个 y-monotone 片段用 O(n) 三角化
//
// 步骤 1 就是本文件实现的 `monotoneDecompose`。
//
// 算法：
// 1. 顶点分 5 类：start / end / split / merge / regular
//    - start: 两个邻居都在当前顶点下方 + 内角 < π
//    - end:   两个邻居都在当前顶点上方 + 内角 < π
//    - split: 两个邻居都在下方 + 内角 > π（"会让水平线穿越 4 次"的点）
//    - merge: 两个邻居都在上方 + 内角 > π
//    - regular: 其余（一上一下）
// 2. 从上到下扫描线：维护当前活动边集合 T（按 x 坐标排序）
//    - split 顶点：找到直接左侧的边 e，连接 split → helper(e) 作为对角线
//    - merge 顶点：记 helper(e_prev) 为 merge；下一次 helper 被替换时补对角线
//    - 其它类型按规则更新 helper
// 3. 最终得到的对角线集合把原多边形切成若干 y-monotone 片段。
//
// 本实现简化处：T 用线性数组（O(n) 查找最近左侧边），对 n < 1000 的
// GIS 多边形足够；大数据可替换为平衡树。
//
// 全部 Float64。
// ============================================================

/** 顶点类型。 */
const VertexType = {
    START: 0 as const,
    END: 1 as const,
    SPLIT: 2 as const,
    MERGE: 3 as const,
    REGULAR: 4 as const,
};
type VertexType = 0 | 1 | 2 | 3 | 4;

/**
 * 单调分解结果。
 *
 * `diagonals` 每项是 [i, j]，表示 polygon 中索引 i 和 j 的两个顶点之间
 * 应添加一条对角线。把这些对角线加入原多边形边集合后，平面被分成
 * 若干 y-monotone 子多边形。
 *
 * `monotonePieces` 每项是一组顶点索引序列（闭合环，首尾不重复），
 * 表示分解后的一个 y-monotone 片段。
 */
export interface MonotoneDecomposition {
    readonly diagonals: Array<[number, number]>;
    readonly monotonePieces: number[][];
}

/**
 * 把一个简单多边形分解为 y-monotone 子多边形。
 *
 * 假设：
 * - polygon 顶点按逆时针顺序
 * - 无自交
 * - 首尾不重复（即 polygon[n-1] ≠ polygon[0]）
 *
 * @param polygon 顶点数组 [[x,y], ...]
 * @returns 对角线 + 分解后的 y-monotone 片段索引环
 *
 * @example
 * // 一个 L 形（非 y-monotone）
 * const poly = [[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]];
 * const { diagonals } = monotoneDecompose(poly);
 */
export function monotoneDecompose(polygon: number[][]): MonotoneDecomposition {
    const n = polygon.length;
    if (n < 3) {
        return { diagonals: [], monotonePieces: [Array.from({ length: n }, (_, i) => i)] };
    }

    // 1. 顶点分类
    const types = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        types[i] = classifyVertex(polygon, i);
    }

    // 2. 扫描线：按 y 降序（y 大 = 上面）处理顶点
    //    y 相等时 x 小的先处理
    const order: number[] = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => {
        const dy = polygon[b][1] - polygon[a][1];
        if (dy !== 0) return dy;
        return polygon[a][0] - polygon[b][0];
    });

    // 活动边列表：每条边 = 多边形中以某顶点为起点的那条边（指向下一个顶点）
    // T[i] = { edgeStart: 顶点索引, helper: 顶点索引 }
    const T: Array<{ edgeStart: number; helper: number }> = [];

    const diagonals: Array<[number, number]> = [];

    function prevIdx(i: number): number { return (i - 1 + n) % n; }
    function nextIdx(i: number): number { return (i + 1) % n; }

    /**
     * 从 T 中找到 "直接在顶点 v 左侧" 的边：
     * 即当前扫描线高度上，x 坐标 < v.x 且最大的那条边。
     */
    function findEdgeDirectlyLeftOf(v: number): number {
        const vy = polygon[v][1];
        const vx = polygon[v][0];
        let bestIdx = -1;
        let bestX = -Infinity;
        for (let k = 0; k < T.length; k++) {
            const e = T[k];
            const a = polygon[e.edgeStart];
            const b = polygon[nextIdx(e.edgeStart)];
            // 计算边在 y = vy 处的 x 坐标
            const dy = b[1] - a[1];
            if (Math.abs(dy) < 1e-20) continue; // 水平边跳过
            const t = (vy - a[1]) / dy;
            if (t < -1e-9 || t > 1 + 1e-9) continue; // 扫描线不在边内
            const x = a[0] + t * (b[0] - a[0]);
            if (x < vx && x > bestX) {
                bestX = x;
                bestIdx = k;
            }
        }
        return bestIdx;
    }

    function insertEdge(edgeStart: number, helper: number): void {
        T.push({ edgeStart, helper });
    }

    function removeEdge(edgeStart: number): void {
        for (let k = 0; k < T.length; k++) {
            if (T[k].edgeStart === edgeStart) {
                T.splice(k, 1);
                return;
            }
        }
    }

    function findEdge(edgeStart: number): { edgeStart: number; helper: number } | null {
        for (let k = 0; k < T.length; k++) {
            if (T[k].edgeStart === edgeStart) return T[k];
        }
        return null;
    }

    // 3. 主循环
    for (let i = 0; i < order.length; i++) {
        const v = order[i];
        const type = types[v];

        switch (type) {
            case VertexType.START: {
                // 把从 v 出发的边 (v → next) 插入 T，helper = v
                insertEdge(v, v);
                break;
            }
            case VertexType.END: {
                // 处理以 v 为终点的边 (prev → v)
                const e = findEdge(prevIdx(v));
                if (e && types[e.helper] === VertexType.MERGE) {
                    diagonals.push([v, e.helper]);
                }
                removeEdge(prevIdx(v));
                break;
            }
            case VertexType.SPLIT: {
                // 找直接左侧的边 e_left
                const idx = findEdgeDirectlyLeftOf(v);
                if (idx >= 0) {
                    diagonals.push([v, T[idx].helper]);
                    T[idx].helper = v;
                }
                insertEdge(v, v);
                break;
            }
            case VertexType.MERGE: {
                // 关闭入边
                const e = findEdge(prevIdx(v));
                if (e && types[e.helper] === VertexType.MERGE) {
                    diagonals.push([v, e.helper]);
                }
                removeEdge(prevIdx(v));
                // 更新左侧边的 helper
                const idx = findEdgeDirectlyLeftOf(v);
                if (idx >= 0) {
                    if (types[T[idx].helper] === VertexType.MERGE) {
                        diagonals.push([v, T[idx].helper]);
                    }
                    T[idx].helper = v;
                }
                break;
            }
            case VertexType.REGULAR: {
                // 判断"内部在右侧还是左侧"：
                // 若前一顶点 y 大于后一顶点 y，则内部在右侧（扫描线从上到下）
                const prev = polygon[prevIdx(v)];
                const next = polygon[nextIdx(v)];
                const interiorOnRight = prev[1] > next[1];
                if (interiorOnRight) {
                    // 关闭入边，新开出边
                    const e = findEdge(prevIdx(v));
                    if (e && types[e.helper] === VertexType.MERGE) {
                        diagonals.push([v, e.helper]);
                    }
                    removeEdge(prevIdx(v));
                    insertEdge(v, v);
                } else {
                    // 更新左侧边的 helper
                    const idx = findEdgeDirectlyLeftOf(v);
                    if (idx >= 0) {
                        if (types[T[idx].helper] === VertexType.MERGE) {
                            diagonals.push([v, T[idx].helper]);
                        }
                        T[idx].helper = v;
                    }
                }
                break;
            }
        }
    }

    // 4. 根据对角线把多边形切成若干 y-monotone 片段
    const pieces = splitByDiagonals(n, diagonals);

    return { diagonals, monotonePieces: pieces };
}

/**
 * 判断顶点 i 是否为起始类型（两邻居都在下方且内角 < π）。
 */
function classifyVertex(polygon: number[][], i: number): VertexType {
    const n = polygon.length;
    const prev = polygon[(i - 1 + n) % n];
    const cur = polygon[i];
    const next = polygon[(i + 1) % n];

    // y 相等时用 x 作为二级比较（避免平局）
    const prevBelow = isBelow(prev, cur);
    const nextBelow = isBelow(next, cur);

    // 内角：若交叉积（prev → cur → next）> 0 说明左转 = 凸（内角 < π，逆时针）
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1])
                - (cur[1] - prev[1]) * (next[0] - cur[0]);
    const convex = cross > 0;

    if (prevBelow && nextBelow) {
        return convex ? VertexType.START : VertexType.SPLIT;
    }
    if (!prevBelow && !nextBelow) {
        return convex ? VertexType.END : VertexType.MERGE;
    }
    return VertexType.REGULAR;
}

/** 判断点 a 是否"在点 b 下方"（y 小，y 相同时 x 大）。 */
function isBelow(a: number[], b: number[]): boolean {
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[0] > b[0];
}

/**
 * 把原始环 + 对角线集合分解为多个简单环。
 *
 * 实现：把多边形看作"边-顶点"的平面图。从每个顶点出发的边按角度排序，
 * DFS 追随"右转"（相对来向的下一条顺时针边）直到回到起点，即得到一个面。
 *
 * 本实现是一个简化版：直接从原环出发逐条分割，每遇到对角线就把当前环
 * 一分为二。适合中小规模（n < 1000）的单调分解输出，避免完整的 DCEL。
 */
function splitByDiagonals(n: number, diagonals: Array<[number, number]>): number[][] {
    // 从原始闭合环开始
    let pieces: number[][] = [Array.from({ length: n }, (_, i) => i)];

    for (const diag of diagonals) {
        const [a, b] = diag;
        // 找到包含 a 和 b 的那个片段
        let found = -1;
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            if (p.indexOf(a) !== -1 && p.indexOf(b) !== -1) {
                found = i;
                break;
            }
        }
        if (found === -1) continue;

        const piece = pieces[found];
        const ia = piece.indexOf(a);
        const ib = piece.indexOf(b);
        if (ia === ib) continue;

        // 切成两段
        const lo = Math.min(ia, ib);
        const hi = Math.max(ia, ib);
        const leftPiece = [...piece.slice(lo, hi + 1)];
        const rightPiece = [...piece.slice(hi), ...piece.slice(0, lo + 1)];
        pieces.splice(found, 1, leftPiece, rightPiece);
    }

    return pieces;
}
