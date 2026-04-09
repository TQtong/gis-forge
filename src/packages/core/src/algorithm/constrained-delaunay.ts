// ============================================================
// algorithm/constrained-delaunay.ts — 约束 Delaunay 三角剖分
// 自研实现：Steiner 点细化法（Chew refinement 的简化版）
// ============================================================
//
// 约束 Delaunay 三角剖分（Constrained Delaunay Triangulation, CDT）
// 在普通 Delaunay 的基础上要求若干指定边（"约束边"）一定出现在结果中。
// 典型用途：
// - 多边形带洞三角剖分（外环 + 内环边作为约束）
// - 河流/道路网与地形 TIN 融合（线要素必须保留为边）
// - 等值线/标注的硬性边界保留
//
// 实现策略：Steiner 点细化（vs. 边翻转算法）
// ───────────────────────────────────────────
// 1. 先运行无约束 Delaunay。
// 2. 检查每条约束边是否已存在于三角剖分中。
// 3. 对每条缺失的约束边：在中点加入一个 Steiner 点，并把约束拆成两段。
// 4. 重新做 Delaunay。重复直到所有约束都成为三角剖分的边，或达到迭代上限。
//
// 优点：实现极简、稳健、不依赖三角形邻接表维护。
// 代价：会引入额外顶点（Steiner 点），三角形数比理论 CDT 多。
//        对于多数 GIS 用途（瓦片渲染/地形）这是可接受的。
// ============================================================

import { delaunay } from './delaunay.ts';

/**
 * 约束 Delaunay 输入：一对顶点索引，表示一条必须保留的边。
 */
export type Constraint = readonly [number, number];

/**
 * 约束 Delaunay 三角剖分结果。
 *
 * 注意：返回的 `points` 可能比输入更长——算法可能添加 Steiner 中点
 * 以保证所有约束边都能成为合法的 Delaunay 边。新点追加在末尾，
 * 原有顶点的索引（0..origN-1）保持不变。
 */
export interface CDTResult {
    /** 顶点数组（可能包含追加的 Steiner 点） */
    readonly points: number[][];
    /** 三角形顶点索引（扁平 number[]，每 3 个为一个三角形） */
    readonly triangles: number[];
    /** 实际使用的迭代次数 */
    readonly iterations: number;
    /** 是否所有约束都成功保留 */
    readonly converged: boolean;
}

/**
 * 选项。
 */
export interface CDTOptions {
    /** 最大迭代次数（每次失败就细化一次），默认 32 */
    readonly maxIterations?: number;
}

/**
 * 约束 Delaunay 三角剖分。
 *
 * @param points 输入顶点 [[x,y], ...]
 * @param constraints 约束边数组 [[i, j], ...]，i/j 是 points 的下标
 * @param options 可选参数
 * @returns 三角剖分结果（包含可能追加的 Steiner 点）
 *
 * @example
 * // 一个带"对角约束"的方形：要求 0→2 是一条边
 * const pts = [[0,0],[1,0],[1,1],[0,1]];
 * const cdt = constrainedDelaunay(pts, [[0, 2]]);
 * // cdt.triangles 包含两个三角形且都共享边 0-2
 */
export function constrainedDelaunay(
    points: number[][],
    constraints: Constraint[],
    options: CDTOptions = {},
): CDTResult {
    const maxIter = options.maxIterations ?? 32;

    if (points.length < 3) {
        return {
            points: points.map((p) => [p[0], p[1]]),
            triangles: [],
            iterations: 0,
            converged: true,
        };
    }

    // 工作副本：算法可能追加新点
    const pts: number[][] = points.map((p) => [p[0], p[1]]);
    // 当前活动约束集合：拆分时会替换条目
    let cons: Array<[number, number]> = constraints.map((c) => [c[0], c[1]]);

    let triangles: number[] = delaunay(pts);
    let iter = 0;

    for (iter = 0; iter < maxIter; iter++) {
        // 收集仍未出现在三角剖分中的约束
        const present = collectEdges(triangles);
        const missing: Array<[number, number]> = [];
        for (let i = 0; i < cons.length; i++) {
            const a = cons[i][0];
            const b = cons[i][1];
            if (!hasEdge(present, a, b)) {
                missing.push([a, b]);
            }
        }

        if (missing.length === 0) {
            return {
                points: pts,
                triangles,
                iterations: iter,
                converged: true,
            };
        }

        // 对每条缺失的约束插入中点 Steiner，把约束拆成两段
        const newCons: Array<[number, number]> = [];
        // 保留所有当前已存在于三角剖分中的约束（无需细化）
        for (let i = 0; i < cons.length; i++) {
            const a = cons[i][0];
            const b = cons[i][1];
            if (hasEdge(present, a, b)) {
                newCons.push([a, b]);
            }
        }

        for (let i = 0; i < missing.length; i++) {
            const a = missing[i][0];
            const b = missing[i][1];
            const ax = pts[a][0];
            const ay = pts[a][1];
            const bx = pts[b][0];
            const by = pts[b][1];
            const midIdx = pts.length;
            pts.push([(ax + bx) * 0.5, (ay + by) * 0.5]);
            newCons.push([a, midIdx]);
            newCons.push([midIdx, b]);
        }

        cons = newCons;
        triangles = delaunay(pts);
    }

    return {
        points: pts,
        triangles,
        iterations: iter,
        converged: false,
    };
}

// ============================================================
// 内部辅助：边集
// ============================================================

/**
 * 用 Set<bigint-like-key> 存储三角剖分中所有的无向边。
 * 用 `min*N + max` 编码（N 取一个安全大数值）。
 */
function edgeKey(a: number, b: number): number {
    // 使用 a*EDGE_MULT + b 编码无向边（保证 a < b）
    if (a > b) {
        const t = a;
        a = b;
        b = t;
    }
    return a * EDGE_MULT + b;
}

const EDGE_MULT = 16777216; // 2^24，足够覆盖 ~1600 万顶点

function collectEdges(triangles: number[]): Set<number> {
    const set = new Set<number>();
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i];
        const b = triangles[i + 1];
        const c = triangles[i + 2];
        set.add(edgeKey(a, b));
        set.add(edgeKey(b, c));
        set.add(edgeKey(c, a));
    }
    return set;
}

function hasEdge(set: Set<number>, a: number, b: number): boolean {
    return set.has(edgeKey(a, b));
}
