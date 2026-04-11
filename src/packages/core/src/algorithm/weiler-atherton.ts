// ============================================================
// algorithm/weiler-atherton.ts — Weiler-Atherton 多边形裁剪
//
// 经典算法，可用任意凹/凸多边形裁剪任意凹/凸多边形（与 Sutherland-Hodgman
// 仅能用矩形/凸窗口裁剪不同），并能正确产生多个不连通的输出多边形。
//
// 算法概述：
//   1. 对 subject 与 clip 多边形求所有交点，将交点按各自顺序插回两个
//      链表，每个交点同时位于两个链表中；
//   2. 标注每个交点为 "Entering"（进入裁剪区）或 "Exiting"（离开裁剪区），
//      基于 subject 边在该点处由外向内还是由内向外穿越；
//   3. 从任一未访问的 Entering 交点出发：
//        在 subject 链表上前进，遇到下一个交点时跳到 clip 链表上前进，
//        遇到下一个交点再跳回 subject —— 直到回到出发点；
//        每条游走轨迹即一条输出多边形；
//   4. 若 subject 完全在 clip 内（无交点）→ 返回 subject；
//      若 clip 完全在 subject 内（无交点）→ 返回 clip；
//      其它无交点情形 → 返回空。
//
// 假设：subject 与 clip 均为 CCW（逆时针）外环。本实现仅支持简单（无自交）
// 多边形，不处理孔洞。
// ============================================================

const EPS = 1e-12;

type Pt = readonly [number, number];

interface Node {
    /** 顶点坐标 */
    x: number;
    y: number;
    /** 是否为交点 */
    intersect: boolean;
    /** 交点状态：true=进入裁剪区, false=离开 */
    entering: boolean;
    /** 在所属环上的下一节点 */
    next: Node | null;
    /** 在所属环上的前一节点 */
    prev: Node | null;
    /** 配对的另一环上的节点（仅交点） */
    neighbor: Node | null;
    /** 在原边上的参数 t，用于在原边上排序交点 */
    alpha: number;
    /** 是否已被遍历 */
    visited: boolean;
}

function makeRing(poly: number[][]): Node {
    const head: Node = nodeOf(poly[0][0], poly[0][1], 0);
    let prev = head;
    for (let i = 1; i < poly.length; i++) {
        const n = nodeOf(poly[i][0], poly[i][1], 0);
        prev.next = n; n.prev = prev;
        prev = n;
    }
    prev.next = head; head.prev = prev;
    return head;
}

function nodeOf(x: number, y: number, alpha: number): Node {
    return {
        x, y,
        intersect: false,
        entering: false,
        next: null, prev: null,
        neighbor: null,
        alpha,
        visited: false,
    };
}

/**
 * 求两线段交点（参数式）。返回 (alphaA, alphaB, x, y) 或 null。
 * alphaA ∈ (0,1) 在 a 上，alphaB ∈ (0,1) 在 b 上；端点退化时返回 null。
 */
function segIntersect(
    a0: Pt, a1: Pt, b0: Pt, b1: Pt,
): { alphaA: number; alphaB: number; x: number; y: number } | null {
    const ax = a1[0] - a0[0], ay = a1[1] - a0[1];
    const bx = b1[0] - b0[0], by = b1[1] - b0[1];
    const denom = ax * by - ay * bx;
    if (Math.abs(denom) < EPS) { return null; }
    const dx = b0[0] - a0[0], dy = b0[1] - a0[1];
    const alphaA = (dx * by - dy * bx) / denom;
    const alphaB = (dx * ay - dy * ax) / denom;
    if (alphaA <= EPS || alphaA >= 1 - EPS) { return null; }
    if (alphaB <= EPS || alphaB >= 1 - EPS) { return null; }
    return {
        alphaA, alphaB,
        x: a0[0] + ax * alphaA,
        y: a0[1] + ay * alphaA,
    };
}

/** 点在多边形内（射线法），与 contain.ts.pointInPolygon 等价但内联以避免循环依赖 */
function pointInPoly(px: number, py: number, poly: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) { inside = !inside; }
    }
    return inside;
}

/** 在指定环的某条边后面按 alpha 升序插入交点节点 */
function insertSortedAfter(start: Node, ix: Node): void {
    let cur = start;
    while (cur.next!.intersect && cur.next!.alpha < ix.alpha && cur.next !== start.next!.prev) {
        cur = cur.next!;
    }
    ix.next = cur.next;
    ix.prev = cur;
    cur.next!.prev = ix;
    cur.next = ix;
}

/**
 * Weiler-Atherton 多边形裁剪。
 *
 * @param subject - 主体多边形顶点 [[x,y], ...]（CCW，不必首尾闭合）
 * @param clip    - 裁剪多边形顶点 [[x,y], ...]（CCW，不必首尾闭合）
 * @returns 裁剪结果——一组多边形（每个为 [[x,y], ...]）。空数组表示无交集。
 *
 * @example
 * const out = weilerAtherton(
 *   [[0,0],[10,0],[10,10],[0,10]],
 *   [[5,5],[15,5],[15,15],[5,15]],
 * );
 * // → [[[5,5],[10,5],[10,10],[5,10]]]
 */
export function weilerAtherton(
    subject: number[][],
    clip: number[][],
): number[][][] {
    if (subject.length < 3 || clip.length < 3) { return []; }

    const subjHead = makeRing(subject);
    const clipHead = makeRing(clip);

    // ── 1. 对每条 subject 边求与所有 clip 边的交点，并插入两个链表 ──
    let foundIntersection = false;
    let s = subjHead;
    do {
        const sNext = s.next!;
        if (!s.intersect) {
            let c = clipHead;
            do {
                const cNext = c.next!;
                if (!c.intersect) {
                    const ip = segIntersect(
                        [s.x, s.y], [sNext.x, sNext.y],
                        [c.x, c.y], [cNext.x, cNext.y],
                    );
                    if (ip !== null) {
                        const inS = nodeOf(ip.x, ip.y, ip.alphaA);
                        const inC = nodeOf(ip.x, ip.y, ip.alphaB);
                        inS.intersect = true;
                        inC.intersect = true;
                        inS.neighbor = inC;
                        inC.neighbor = inS;
                        insertSortedAfter(s, inS);
                        insertSortedAfter(c, inC);
                        foundIntersection = true;
                    }
                }
                c = cNext;
            } while (c !== clipHead);
        }
        s = sNext;
    } while (s !== subjHead);

    // ── 退化：无交点 ──
    if (!foundIntersection) {
        if (pointInPoly(subject[0][0], subject[0][1], clip)) {
            return [subject.map(p => [p[0], p[1]])];
        }
        if (pointInPoly(clip[0][0], clip[0][1], subject)) {
            return [clip.map(p => [p[0], p[1]])];
        }
        return [];
    }

    // ── 2. 标注 entering/exiting：从 subject 起点开始，状态随每个交点翻转 ──
    let inside = pointInPoly(subjHead.x, subjHead.y, clip);
    let cur: Node = subjHead;
    do {
        if (cur.intersect) {
            cur.entering = !inside;
            inside = !inside;
        }
        cur = cur.next!;
    } while (cur !== subjHead);

    // ── 3. 从未访问的 entering 交点出发游走 ──
    const result: number[][][] = [];
    do {
        // 找一个未访问的 entering 交点
        let start: Node | null = null;
        let it: Node = subjHead;
        do {
            if (it.intersect && it.entering && !it.visited) { start = it; break; }
            it = it.next!;
        } while (it !== subjHead);
        if (start === null) { break; }

        const ring: number[][] = [];
        let walker = start;
        let onSubject = true;
        do {
            walker.visited = true;
            if (walker.neighbor !== null) { walker.neighbor.visited = true; }
            ring.push([walker.x, walker.y]);
            // 在当前环上前进直到下一个交点
            walker = walker.next!;
            while (!walker.intersect) {
                ring.push([walker.x, walker.y]);
                walker = walker.next!;
            }
            // 切换到对端环
            walker.visited = true;
            if (walker.neighbor !== null) {
                walker = walker.neighbor;
                onSubject = !onSubject;
            }
        } while (walker !== start && walker.neighbor !== start);

        if (ring.length >= 3) { result.push(ring); }
    } while (true);

    return result;
}
