// ============================================================
// algorithm/greiner-hormann.ts — Greiner-Hormann 多边形布尔运算
//
// 现代经典算法，比 Weiler-Atherton 更通用：能在同一框架下计算
// 交集 / 并集 / 差集，处理任意凹凸多边形（不含自交、不含孔洞）。
//
// 参考：
//   Greiner, G., Hormann, K. (1998). "Efficient clipping of arbitrary
//   polygons." ACM Transactions on Graphics 17(2): 71-83.
//
// 核心思想：
//   1. 构造 subject 与 clip 的双向链表，对每对边求交点；
//      新交点同时插回两个链表（按 alpha 升序），并互为 neighbor；
//   2. 对每个交点标注 entry/exit（基于 subject 边在该点的穿越方向）；
//   3. 从未访问的 entry 出发，按操作类型选择前进方向：
//        intersect:  entry → forward subject → exit → forward clip
//        union:      entry → backward subject → exit → backward clip
//        difference: entry → forward subject → exit → backward clip
// ============================================================

const EPS = 1e-12;

export type BooleanOp = 'intersect' | 'union' | 'difference';

interface Vertex {
    x: number;
    y: number;
    next: Vertex | null;
    prev: Vertex | null;
    intersect: boolean;
    entry: boolean;
    visited: boolean;
    alpha: number;
    neighbor: Vertex | null;
}

function makeVertex(x: number, y: number): Vertex {
    return {
        x, y,
        next: null, prev: null,
        intersect: false,
        entry: false,
        visited: false,
        alpha: 0,
        neighbor: null,
    };
}

function buildRing(poly: number[][]): Vertex {
    const head = makeVertex(poly[0][0], poly[0][1]);
    let prev = head;
    for (let i = 1; i < poly.length; i++) {
        const v = makeVertex(poly[i][0], poly[i][1]);
        prev.next = v; v.prev = prev;
        prev = v;
    }
    prev.next = head; head.prev = prev;
    return head;
}

function nextNonIntersect(v: Vertex): Vertex {
    let n = v.next!;
    while (n.intersect && n !== v) { n = n.next!; }
    return n;
}

function pointInPoly(px: number, py: number, poly: Vertex): boolean {
    let inside = false;
    let v = poly;
    do {
        const xi = v.x, yi = v.y;
        const next = v.next!;
        const xj = next.x, yj = next.y;
        if (((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
        v = next;
    } while (v !== poly);
    return inside;
}

interface IntersectResult {
    alphaP: number;
    alphaQ: number;
    x: number;
    y: number;
}

function intersectSeg(
    p1: Vertex, p2: Vertex, q1: Vertex, q2: Vertex,
): IntersectResult | null {
    const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
    const dx2 = q2.x - q1.x, dy2 = q2.y - q1.y;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < EPS) { return null; }
    const dx = q1.x - p1.x, dy = q1.y - p1.y;
    const alphaP = (dx * dy2 - dy * dx2) / denom;
    const alphaQ = (dx * dy1 - dy * dx1) / denom;
    if (alphaP <= EPS || alphaP >= 1 - EPS) { return null; }
    if (alphaQ <= EPS || alphaQ >= 1 - EPS) { return null; }
    return {
        alphaP, alphaQ,
        x: p1.x + alphaP * dx1,
        y: p1.y + alphaP * dy1,
    };
}

function insertByAlpha(after: Vertex, before: Vertex, ix: Vertex): void {
    let cur = after;
    while (cur.next !== before && cur.next!.alpha < ix.alpha) {
        cur = cur.next!;
    }
    ix.next = cur.next;
    ix.prev = cur;
    cur.next!.prev = ix;
    cur.next = ix;
}

/**
 * Greiner-Hormann 多边形布尔运算（intersect / union / difference）。
 *
 * @param subject - 主体多边形 [[x,y], ...]
 * @param clip    - 裁剪/操作多边形 [[x,y], ...]
 * @param op      - 操作类型
 * @returns 结果多边形数组（每个为顶点序列）
 *
 * @example
 * greinerHormann(
 *   [[0,0],[10,0],[10,10],[0,10]],
 *   [[5,5],[15,5],[15,15],[5,15]],
 *   'intersect',
 * );
 * // → [[[5,5],[10,5],[10,10],[5,10]]]
 */
export function greinerHormann(
    subject: number[][],
    clip: number[][],
    op: BooleanOp = 'intersect',
): number[][][] {
    if (subject.length < 3 || clip.length < 3) { return []; }

    const P = buildRing(subject);
    const Q = buildRing(clip);

    // ── 1. 求交点并双向插入 ──
    let hasIntersect = false;
    let p = P;
    do {
        if (!p.intersect) {
            const pn = nextNonIntersect(p);
            let q = Q;
            do {
                if (!q.intersect) {
                    const qn = nextNonIntersect(q);
                    const ip = intersectSeg(p, pn, q, qn);
                    if (ip !== null) {
                        const ipP = makeVertex(ip.x, ip.y);
                        const ipQ = makeVertex(ip.x, ip.y);
                        ipP.intersect = true;
                        ipQ.intersect = true;
                        ipP.alpha = ip.alphaP;
                        ipQ.alpha = ip.alphaQ;
                        ipP.neighbor = ipQ;
                        ipQ.neighbor = ipP;
                        insertByAlpha(p, pn, ipP);
                        insertByAlpha(q, qn, ipQ);
                        hasIntersect = true;
                    }
                }
                q = q.next!;
            } while (q !== Q);
        }
        p = p.next!;
    } while (p !== P);

    // ── 退化：无交点 ──
    if (!hasIntersect) {
        const subjInClip = pointInPoly(P.x, P.y, Q);
        const clipInSubj = pointInPoly(Q.x, Q.y, P);
        if (op === 'intersect') {
            if (subjInClip) { return [ringToArray(P)]; }
            if (clipInSubj) { return [ringToArray(Q)]; }
            return [];
        } else if (op === 'union') {
            if (subjInClip) { return [ringToArray(Q)]; }
            if (clipInSubj) { return [ringToArray(P)]; }
            return [ringToArray(P), ringToArray(Q)];
        } else /* difference */ {
            if (subjInClip) { return []; }
            if (clipInSubj) {
                // P 包含 Q —— 差集为带洞多边形，本实现不支持洞，
                // 退化为外环 P + 内环 Q（顺序反向）作为两条独立环
                return [ringToArray(P), ringToArray(Q).reverse()];
            }
            return [ringToArray(P)];
        }
    }

    // ── 2. 标注 entry/exit ──
    // P 的入口：第一个 P 顶点是否在 Q 内决定起始翻转方向
    {
        let inside = pointInPoly(P.x, P.y, Q);
        let v = P;
        do {
            if (v.intersect) {
                v.entry = !inside;
                inside = !inside;
            }
            v = v.next!;
        } while (v !== P);
    }
    {
        let inside = pointInPoly(Q.x, Q.y, P);
        let v = Q;
        do {
            if (v.intersect) {
                v.entry = !inside;
                inside = !inside;
            }
            v = v.next!;
        } while (v !== Q);
    }

    // ── 3. 操作类型决定方向：differecne 时取反 P 的 entry，union 时取反两者 ──
    if (op === 'union') {
        flipEntries(P);
        flipEntries(Q);
    } else if (op === 'difference') {
        flipEntries(Q);
    }

    // ── 4. 游走构造结果 ──
    const result: number[][][] = [];
    while (true) {
        // 找未访问的 entry 交点
        let start: Vertex | null = null;
        let it = P;
        do {
            if (it.intersect && it.entry && !it.visited) { start = it; break; }
            it = it.next!;
        } while (it !== P);
        if (start === null) { break; }

        const ring: number[][] = [];
        let walker: Vertex = start;
        do {
            walker.visited = true;
            if (walker.neighbor !== null) { walker.neighbor.visited = true; }
            ring.push([walker.x, walker.y]);

            // 根据 entry 标记决定前进方向
            const forward = walker.entry;
            walker = walker.neighbor !== null ? walker : walker; // no-op
            // 在当前环上沿 forward 方向走到下一个交点
            do {
                walker = forward ? walker.next! : walker.prev!;
                if (!walker.intersect) { ring.push([walker.x, walker.y]); }
            } while (!walker.intersect);

            // 切换到 neighbor 环
            walker.visited = true;
            if (walker.neighbor === null) { break; }
            walker = walker.neighbor;
        } while (walker !== start);

        if (ring.length >= 3) { result.push(ring); }
    }

    return result;
}

function ringToArray(v: Vertex): number[][] {
    const arr: number[][] = [];
    let cur = v;
    do {
        arr.push([cur.x, cur.y]);
        cur = cur.next!;
    } while (cur !== v);
    return arr;
}

function flipEntries(head: Vertex): void {
    let v = head;
    do {
        if (v.intersect) { v.entry = !v.entry; }
        v = v.next!;
    } while (v !== head);
}
