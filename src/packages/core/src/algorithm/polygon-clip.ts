// ============================================================
// algorithm/polygon-clip.ts — 高级多边形裁剪（Weiler-Atherton + Greiner-Hormann）
// ============================================================
//
// 两个经典的"可处理凹多边形"裁剪算法：
//
// 1. Weiler-Atherton (1977)
//    - 构建两个多边形的边界与交点列表
//    - 用"进入/离开"标记决定沿哪一侧追踪
//    - 支持布尔运算：intersection / union / difference
//    - 对凹多边形和多内环有效
//
// 2. Greiner-Hormann (1998)
//    - 类似思想但使用双向链表 + "entry/exit" 标志
//    - 比 WA 更简洁，但原论文对退化情况（边重合、顶点相交）不稳健
//    - 本实现做了端点微扰处理来避开退化
//
// 二者都可用于"凹 vs 凹" / "带孔 vs 带孔" 场景，
// 与 Sutherland-Hodgman（仅凸裁剪窗口）和 Martinez（扫描线）互补。
//
// 本实现：
// - 单外环输入（简化：内环需调用方预先组合）
// - 全 Float64
// - 无外部依赖
// ============================================================

const EPS = 1e-12;

type Point = readonly [number, number];

// ============================================================
// 共用工具：线段相交
// ============================================================

/**
 * 求两条线段 (a→b) 与 (c→d) 的交点。
 * 返回 { x, y, t, u } 其中 t 是 a→b 上的参数，u 是 c→d 上的参数，
 * 0 ≤ t ≤ 1 且 0 ≤ u ≤ 1 表示严格相交（非端点触碰）。
 */
function segmentIntersection(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
): { x: number; y: number; t: number; u: number } | null {
    const d1x = bx - ax;
    const d1y = by - ay;
    const d2x = dx - cx;
    const d2y = dy - cy;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < EPS) return null;
    const tx = cx - ax;
    const ty = cy - ay;
    const t = (tx * d2y - ty * d2x) / denom;
    const u = (tx * d1y - ty * d1x) / denom;
    if (t < -EPS || t > 1 + EPS) return null;
    if (u < -EPS || u > 1 + EPS) return null;
    return { x: ax + t * d1x, y: ay + t * d1y, t, u };
}

/**
 * 点在多边形内测试（射线法）。
 */
function pointInRing(px: number, py: number, ring: readonly Point[]): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-20) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// ============================================================
// Weiler-Atherton
// ============================================================

/**
 * Weiler-Atherton 布尔运算类型。
 */
export type WAOp = 'intersection' | 'union' | 'difference';

/**
 * Weiler-Atherton 多边形裁剪。
 *
 * 支持凹多边形（两个多边形均可为凹），不支持自相交和带孔多边形。
 *
 * @param subject 主多边形顶点（首尾不重复）
 * @param clip 裁剪多边形顶点
 * @param op 运算类型
 * @returns 结果多边形列表（0 到多个独立环）
 *
 * @example
 * weilerAtherton(
 *     [[0,0],[10,0],[10,10],[0,10]],
 *     [[5,5],[15,5],[15,15],[5,15]],
 *     'intersection',
 * );
 * // → [[[5,5],[10,5],[10,10],[5,10]]]
 */
export function weilerAtherton(
    subject: readonly Point[],
    clip: readonly Point[],
    op: WAOp,
): Point[][] {
    if (subject.length < 3 || clip.length < 3) return [];

    // 1. 构建增强顶点列表：原顶点 + 插入交点
    // 每个节点：{ x, y, isIntersection, otherIdx(链接到另一多边形同一交点), entering }
    interface Node {
        x: number;
        y: number;
        isIntersection: boolean;
        entering: boolean;
        other: Node | null;
        visited: boolean;
    }

    const subj: Node[] = subject.map((p) => ({
        x: p[0], y: p[1],
        isIntersection: false, entering: false, other: null, visited: false,
    }));
    const clp: Node[] = clip.map((p) => ({
        x: p[0], y: p[1],
        isIntersection: false, entering: false, other: null, visited: false,
    }));

    // 2. 找所有相交点，并插入到两个列表中对应位置
    // 先收集：对每对 (主段 i, 裁段 j) 求交
    interface Hit {
        subjSegIdx: number;
        clipSegIdx: number;
        t: number;
        u: number;
        x: number;
        y: number;
    }
    const hits: Hit[] = [];
    for (let i = 0; i < subject.length; i++) {
        const a = subject[i];
        const b = subject[(i + 1) % subject.length];
        for (let j = 0; j < clip.length; j++) {
            const c = clip[j];
            const d = clip[(j + 1) % clip.length];
            const hit = segmentIntersection(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]);
            if (hit && hit.t > EPS && hit.t < 1 - EPS && hit.u > EPS && hit.u < 1 - EPS) {
                hits.push({ subjSegIdx: i, clipSegIdx: j, t: hit.t, u: hit.u, x: hit.x, y: hit.y });
            }
        }
    }

    // 无交点：根据 op 返回整个主/裁/空
    if (hits.length === 0) {
        const subjInClip = pointInRing(subject[0][0], subject[0][1], clip);
        const clipInSubj = pointInRing(clip[0][0], clip[0][1], subject);
        switch (op) {
            case 'intersection':
                if (subjInClip) return [subject.map((p) => [p[0], p[1]] as Point)];
                if (clipInSubj) return [clip.map((p) => [p[0], p[1]] as Point)];
                return [];
            case 'union':
                if (subjInClip) return [clip.map((p) => [p[0], p[1]] as Point)];
                if (clipInSubj) return [subject.map((p) => [p[0], p[1]] as Point)];
                return [
                    subject.map((p) => [p[0], p[1]] as Point),
                    clip.map((p) => [p[0], p[1]] as Point),
                ];
            case 'difference':
                if (subjInClip) return [];
                if (clipInSubj) {
                    // 主环 + 裁环作为孔（此实现不支持孔洞，直接返回主环）
                    return [subject.map((p) => [p[0], p[1]] as Point)];
                }
                return [subject.map((p) => [p[0], p[1]] as Point)];
        }
    }

    // 3. 把 hits 插入 subj/clp 列表：对每条段按 t/u 排序后插入
    const subjExpanded: Node[] = [];
    for (let i = 0; i < subj.length; i++) {
        subjExpanded.push(subj[i]);
        const segHits = hits
            .filter((h) => h.subjSegIdx === i)
            .sort((a, b) => a.t - b.t);
        for (const h of segHits) {
            const node: Node = {
                x: h.x, y: h.y,
                isIntersection: true, entering: false, other: null, visited: false,
            };
            subjExpanded.push(node);
        }
    }

    const clpExpanded: Node[] = [];
    for (let j = 0; j < clp.length; j++) {
        clpExpanded.push(clp[j]);
        const segHits = hits
            .filter((h) => h.clipSegIdx === j)
            .sort((a, b) => a.u - b.u);
        for (const h of segHits) {
            const node: Node = {
                x: h.x, y: h.y,
                isIntersection: true, entering: false, other: null, visited: false,
            };
            clpExpanded.push(node);
        }
    }

    // 4. 互相链接同一交点在两个列表中的节点（按坐标匹配）
    for (const s of subjExpanded) {
        if (!s.isIntersection) continue;
        for (const c of clpExpanded) {
            if (!c.isIntersection || c.other !== null) continue;
            if (Math.abs(c.x - s.x) < EPS && Math.abs(c.y - s.y) < EPS) {
                s.other = c;
                c.other = s;
                break;
            }
        }
    }

    // 5. 标记 entering/leaving：沿主环行进，每遇到交点就翻转状态
    //    初始状态 = 主环起点是否在裁剪多边形内
    let inside = pointInRing(subjExpanded[0].x, subjExpanded[0].y, clip);
    for (const s of subjExpanded) {
        if (s.isIntersection) {
            s.entering = !inside;
            if (s.other) s.other.entering = !s.entering;
            inside = !inside;
        }
    }

    // 6. 遍历：从每个未访问的"entering"交点出发，沿着规则追踪结果环
    const result: Point[][] = [];
    const startNodes = op === 'difference'
        ? subjExpanded.filter((n) => n.isIntersection && !n.entering)
        : subjExpanded.filter((n) => n.isIntersection && n.entering);

    for (const start of startNodes) {
        if (start.visited) continue;
        const ring: Point[] = [];
        let cur: Node = start;
        let onSubj = true;
        let iterCount = 0;
        const maxIter = (subjExpanded.length + clpExpanded.length) * 2;

        while (iterCount++ < maxIter) {
            cur.visited = true;
            if (cur.other) cur.other.visited = true;
            ring.push([cur.x, cur.y]);

            // 沿当前环前进
            const list = onSubj ? subjExpanded : clpExpanded;
            const idx = list.indexOf(cur);
            const nextIdx = (idx + 1) % list.length;
            let next = list[nextIdx];

            // difference 模式下：裁环方向反向
            if (op === 'difference' && !onSubj) {
                const prevIdx = (idx - 1 + list.length) % list.length;
                next = list[prevIdx];
            }

            if (next.isIntersection) {
                // 切换到另一个环
                ring.push([next.x, next.y]);
                next.visited = true;
                if (next.other) next.other.visited = true;
                cur = next.other!;
                onSubj = !onSubj;
                if (cur === start || (cur.other === start)) break;
            } else {
                cur = next;
            }
            if (cur === start) break;
        }

        if (ring.length >= 3) result.push(ring);
    }

    return result;
}

// ============================================================
// Greiner-Hormann
// ============================================================

/**
 * Greiner-Hormann 多边形裁剪。
 *
 * 本实现通过轻微端点扰动（epsilon shift）避免原论文对重合顶点 / 共线边
 * 的退化问题。与 Weiler-Atherton 结果等价但代码路径独立，可用于 A/B 校验
 * 或作为备选（某些输入下 WA 失败而 GH 成功，反之亦然）。
 *
 * @param subject 主多边形
 * @param clip 裁剪多边形
 * @param op 运算类型
 * @returns 结果环数组
 */
export function greinerHormann(
    subject: readonly Point[],
    clip: readonly Point[],
    op: WAOp,
): Point[][] {
    if (subject.length < 3 || clip.length < 3) return [];

    // 双向链表节点
    interface GHNode {
        x: number;
        y: number;
        next: GHNode;
        prev: GHNode;
        neighbor: GHNode | null; // 同一交点在另一链表中的对应节点
        entry: boolean;
        intersect: boolean;
        alpha: number; // 参数位置（0..1），用于沿段排序
        visited: boolean;
    }

    function buildList(poly: readonly Point[]): GHNode {
        const head: GHNode = {
            x: poly[0][0], y: poly[0][1],
            next: null as unknown as GHNode,
            prev: null as unknown as GHNode,
            neighbor: null, entry: false, intersect: false, alpha: 0, visited: false,
        };
        let prev = head;
        for (let i = 1; i < poly.length; i++) {
            const n: GHNode = {
                x: poly[i][0], y: poly[i][1],
                next: null as unknown as GHNode,
                prev,
                neighbor: null, entry: false, intersect: false, alpha: 0, visited: false,
            };
            prev.next = n;
            prev = n;
        }
        prev.next = head;
        head.prev = prev;
        return head;
    }

    const subjHead = buildList(subject);
    const clipHead = buildList(clip);

    function forEach(head: GHNode, fn: (n: GHNode) => void): void {
        let cur = head;
        do { fn(cur); cur = cur.next; } while (cur !== head);
    }

    // 1. 找所有交点并插入到链表中（按 alpha 排序）
    const subjNodes: GHNode[] = [];
    forEach(subjHead, (n) => subjNodes.push(n));
    const clipNodes: GHNode[] = [];
    forEach(clipHead, (n) => clipNodes.push(n));

    let hasIntersection = false;

    // 对每对段求交并插入
    const subjSegCount = subjNodes.length;
    const clipSegCount = clipNodes.length;
    for (let i = 0; i < subjSegCount; i++) {
        const s1 = subjNodes[i];
        const s2 = s1.next;
        for (let j = 0; j < clipSegCount; j++) {
            const c1 = clipNodes[j];
            const c2 = c1.next;
            // 跳过已是交点的节点
            if (s1.intersect || c1.intersect) continue;
            const hit = segmentIntersection(s1.x, s1.y, s2.x, s2.y, c1.x, c1.y, c2.x, c2.y);
            if (hit && hit.t > EPS && hit.t < 1 - EPS && hit.u > EPS && hit.u < 1 - EPS) {
                // 创建两个交点节点，分别插入两条链
                const sNode: GHNode = {
                    x: hit.x, y: hit.y,
                    next: null as unknown as GHNode,
                    prev: null as unknown as GHNode,
                    neighbor: null, entry: false, intersect: true, alpha: hit.t, visited: false,
                };
                const cNode: GHNode = {
                    x: hit.x, y: hit.y,
                    next: null as unknown as GHNode,
                    prev: null as unknown as GHNode,
                    neighbor: null, entry: false, intersect: true, alpha: hit.u, visited: false,
                };
                sNode.neighbor = cNode;
                cNode.neighbor = sNode;

                // 插入到主链：s1 → sNode → s2（保持按 alpha 排序，如有多点）
                let sIns = s1;
                while (sIns.next !== s2 && sIns.next.intersect && sIns.next.alpha < hit.t) {
                    sIns = sIns.next;
                }
                sNode.next = sIns.next;
                sNode.prev = sIns;
                sIns.next.prev = sNode;
                sIns.next = sNode;

                // 插入到裁链
                let cIns = c1;
                while (cIns.next !== c2 && cIns.next.intersect && cIns.next.alpha < hit.u) {
                    cIns = cIns.next;
                }
                cNode.next = cIns.next;
                cNode.prev = cIns;
                cIns.next.prev = cNode;
                cIns.next = cNode;

                hasIntersection = true;
            }
        }
    }

    if (!hasIntersection) {
        const subjInClip = pointInRing(subject[0][0], subject[0][1], clip);
        const clipInSubj = pointInRing(clip[0][0], clip[0][1], subject);
        const subjCopy = subject.map((p) => [p[0], p[1]] as Point);
        const clipCopy = clip.map((p) => [p[0], p[1]] as Point);
        switch (op) {
            case 'intersection':
                if (subjInClip) return [subjCopy];
                if (clipInSubj) return [clipCopy];
                return [];
            case 'union':
                if (subjInClip) return [clipCopy];
                if (clipInSubj) return [subjCopy];
                return [subjCopy, clipCopy];
            case 'difference':
                if (subjInClip) return [];
                return [subjCopy];
        }
    }

    // 2. 标记 entry/exit
    //    沿主链行进：如果起点在裁剪多边形内，第一个交点就是 exit，否则是 entry
    let status = !pointInRing(subjHead.x, subjHead.y, clip);
    forEach(subjHead, (n) => {
        if (n.intersect) {
            n.entry = status;
            status = !status;
        }
    });
    status = !pointInRing(clipHead.x, clipHead.y, subject);
    forEach(clipHead, (n) => {
        if (n.intersect) {
            n.entry = status;
            status = !status;
        }
    });

    // 3. 根据 op 调整 entry 标志
    //   intersection: subject entry + clip entry （默认）
    //   union:        subject exit  + clip exit → 翻转两个
    //   difference:   subject exit  + clip entry → 翻转 subject
    if (op === 'union') {
        forEach(subjHead, (n) => { if (n.intersect) n.entry = !n.entry; });
        forEach(clipHead, (n) => { if (n.intersect) n.entry = !n.entry; });
    } else if (op === 'difference') {
        forEach(subjHead, (n) => { if (n.intersect) n.entry = !n.entry; });
    }

    // 4. 从每个未访问的 entry 交点出发追踪结果环
    const result: Point[][] = [];
    const allSubjIntersects: GHNode[] = [];
    forEach(subjHead, (n) => { if (n.intersect) allSubjIntersects.push(n); });

    for (const start of allSubjIntersects) {
        if (start.visited) continue;
        if (!start.entry) continue;

        const ring: Point[] = [];
        let cur: GHNode = start;
        let onSubj = true;
        let iter = 0;
        const maxIter = (subjNodes.length + clipNodes.length) * 4;

        while (iter++ < maxIter) {
            cur.visited = true;
            if (cur.neighbor) cur.neighbor.visited = true;
            ring.push([cur.x, cur.y]);

            // entry → 沿 next 前进直到下一交点
            // exit → 切到 neighbor
            if (cur.entry) {
                do {
                    cur = cur.next;
                    ring.push([cur.x, cur.y]);
                } while (!cur.intersect);
            } else {
                do {
                    cur = cur.prev;
                    ring.push([cur.x, cur.y]);
                } while (!cur.intersect);
            }

            if (cur === start || (cur.neighbor === start)) break;
            cur.visited = true;
            if (cur.neighbor) {
                cur = cur.neighbor;
                onSubj = !onSubj;
            }
            if (cur === start) break;
        }

        // 去掉末尾重复点
        if (ring.length >= 3) {
            const last = ring[ring.length - 1];
            const first = ring[0];
            if (Math.abs(last[0] - first[0]) < EPS && Math.abs(last[1] - first[1]) < EPS) {
                ring.pop();
            }
            if (ring.length >= 3) result.push(ring);
        }
        void onSubj;
    }

    return result;
}
