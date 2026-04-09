// ============================================================
// analysis/raster/hydrology.ts — 水文栅格分析（自研实现）
// ============================================================
//
// 提供三个核心水文算法：
// 1. fillSinks       — Priority-Flood 填洼（消除 DEM 中的局部最低点）
// 2. flowDirection   — D8 流向（每格指向 8 邻居中最陡下坡的那个）
// 3. flowAccumulation — 流量累积（每格上游贡献的总面积 / 格数）
// 4. watershed       — 从"流出口" cell 反向追溯得到流域范围
//
// 所有算法都基于 `DEMData`（analysis/raster/index.ts）的 readonly (readonly number[])[]
// 行主序数组表示，NaN 表示 NO_DATA。
//
// 全部 Float64 + Int32 数组；Priority-Flood 使用二叉堆（自研，无外部依赖）。
// ============================================================

import type { DEMData } from './index.ts';

// ============================================================
// 工具：最小堆（基于 Float64Array 存 (value, row, col) 打包）
// ============================================================

interface MinHeap {
    readonly size: () => number;
    readonly push: (value: number, row: number, col: number) => void;
    readonly pop: () => { value: number; row: number; col: number } | null;
}

/** 按 value 升序出堆的二叉最小堆。等值时先入先出（通过插入序号打破平局）。 */
function createMinHeap(capacityHint: number): MinHeap {
    // 每个节点 4 个 f64：value / row / col / seq
    let cap = Math.max(16, capacityHint);
    let data = new Float64Array(cap * 4);
    let n = 0;
    let seqCounter = 0;

    function less(i: number, j: number): boolean {
        const vi = data[i * 4];
        const vj = data[j * 4];
        if (vi !== vj) return vi < vj;
        // 相等 → 先入先出
        return data[i * 4 + 3] < data[j * 4 + 3];
    }

    function swap(i: number, j: number): void {
        for (let k = 0; k < 4; k++) {
            const t = data[i * 4 + k];
            data[i * 4 + k] = data[j * 4 + k];
            data[j * 4 + k] = t;
        }
    }

    function up(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (less(i, parent)) {
                swap(i, parent);
                i = parent;
            } else {
                break;
            }
        }
    }

    function down(i: number): void {
        for (;;) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = i;
            if (l < n && less(l, smallest)) smallest = l;
            if (r < n && less(r, smallest)) smallest = r;
            if (smallest === i) break;
            swap(i, smallest);
            i = smallest;
        }
    }

    function grow(): void {
        cap *= 2;
        const next = new Float64Array(cap * 4);
        next.set(data);
        data = next;
    }

    return {
        size(): number {
            return n;
        },
        push(value: number, row: number, col: number): void {
            if (n >= cap) grow();
            data[n * 4] = value;
            data[n * 4 + 1] = row;
            data[n * 4 + 2] = col;
            data[n * 4 + 3] = seqCounter++;
            n++;
            up(n - 1);
        },
        pop(): { value: number; row: number; col: number } | null {
            if (n === 0) return null;
            const value = data[0];
            const row = data[1];
            const col = data[2];
            n--;
            if (n > 0) {
                data[0] = data[n * 4];
                data[1] = data[n * 4 + 1];
                data[2] = data[n * 4 + 2];
                data[3] = data[n * 4 + 3];
                down(0);
            }
            return { value, row, col };
        },
    };
}

// ============================================================
// 1. Priority-Flood 填洼
// ============================================================

/**
 * 把 readonly DEMData 的 values 拷贝为可变 number[][]。
 */
function cloneValues(dem: DEMData): number[][] {
    const out: number[][] = new Array(dem.rows);
    for (let r = 0; r < dem.rows; r++) {
        const row = dem.values[r]!;
        const nrow: number[] = new Array(dem.cols);
        for (let c = 0; c < dem.cols; c++) {
            nrow[c] = row[c]!;
        }
        out[r] = nrow;
    }
    return out;
}

/**
 * 填洼算法（Priority-Flood，Barnes et al. 2014, "Priority-flood: An optimal
 * depression-filling and watershed-labeling algorithm"）。
 *
 * 每个内部 cell 的高程被提升到"从它出发能不上坡地到达 DEM 边界"所经过的最小高程。
 * 这一步是所有后续水文分析（流向/流量/流域）的先决条件 —— 否则局部洼地会
 * 造成水"无处可去"的死循环。
 *
 * 算法：
 * 1. 把所有边界 cell 加入优先队列（堆顶为最小高程）
 * 2. 弹出最小 cell c，对每个未处理的邻居 n：
 *    填充高程 = max(c.filled, n.original)，标记已处理，入队
 * 3. 重复直到堆空
 *
 * 复杂度：O(N log N)，N = rows * cols
 *
 * @param dem 原始 DEM
 * @returns 新的 DEMData，values 为填洼后的高程
 */
export function fillSinks(dem: DEMData): DEMData {
    const rows = dem.rows;
    const cols = dem.cols;
    if (rows < 2 || cols < 2) {
        return { ...dem, values: cloneValues(dem) };
    }

    const filled = cloneValues(dem);
    const closed = new Uint8Array(rows * cols);
    const heap = createMinHeap(2 * (rows + cols));

    // 1. 所有边界 cell 入队
    for (let c = 0; c < cols; c++) {
        const top = dem.values[0]![c]!;
        const bot = dem.values[rows - 1]![c]!;
        if (!Number.isNaN(top)) {
            heap.push(top, 0, c);
            closed[0 * cols + c] = 1;
        }
        if (!Number.isNaN(bot)) {
            heap.push(bot, rows - 1, c);
            closed[(rows - 1) * cols + c] = 1;
        }
    }
    for (let r = 1; r < rows - 1; r++) {
        const left = dem.values[r]![0]!;
        const right = dem.values[r]![cols - 1]!;
        if (!Number.isNaN(left)) {
            heap.push(left, r, 0);
            closed[r * cols + 0] = 1;
        }
        if (!Number.isNaN(right)) {
            heap.push(right, r, cols - 1);
            closed[r * cols + cols - 1] = 1;
        }
    }

    const dR = [-1, -1, -1, 0, 0, 1, 1, 1];
    const dC = [-1, 0, 1, -1, 1, -1, 0, 1];

    // 2. 主循环
    while (heap.size() > 0) {
        const cell = heap.pop()!;
        const cr = cell.row | 0;
        const cc = cell.col | 0;
        const cv = cell.value;
        for (let k = 0; k < 8; k++) {
            const nr = cr + dR[k];
            const nc = cc + dC[k];
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const idx = nr * cols + nc;
            if (closed[idx] !== 0) continue;
            const orig = dem.values[nr]![nc]!;
            if (Number.isNaN(orig)) {
                closed[idx] = 1;
                continue;
            }
            // 关键一步：填洼到 max(邻居原值, 当前 cell 已填值)
            const newVal = orig < cv ? cv : orig;
            filled[nr]![nc] = newVal;
            closed[idx] = 1;
            heap.push(newVal, nr, nc);
        }
    }

    return {
        values: filled,
        rows,
        cols,
        bbox: dem.bbox,
        cellSizeM: dem.cellSizeM,
    };
}

// ============================================================
// 2. D8 流向
// ============================================================

/**
 * D8 流向编码（每个 cell 指向 8 邻居中的一个）。
 *
 * ESRI 约定：
 *   32   64  128
 *   16    0    1
 *    8    4    2
 * 0 = 无流向（sink 或 NO_DATA）
 */
export const D8_DIRECTIONS = {
    EAST: 1,
    SOUTHEAST: 2,
    SOUTH: 4,
    SOUTHWEST: 8,
    WEST: 16,
    NORTHWEST: 32,
    NORTH: 64,
    NORTHEAST: 128,
    NONE: 0,
} as const;

/**
 * D8 流向结果。
 */
export interface FlowDirectionResult {
    /** 每个 cell 的方向编码（Int32Array, rows*cols） */
    readonly direction: Int32Array;
    /** 与 DEM 同尺寸 */
    readonly rows: number;
    readonly cols: number;
}

/**
 * D8 流向：每格指向 8 邻居中下坡梯度最大的那个。
 *
 * 使用对角线长度 √2 进行梯度归一化：
 *   slope = (z - z_neighbor) / distance
 *
 * NO_DATA / 无下坡邻居 → direction = 0。
 * 建议先调用 fillSinks 消除洼地后再计算，否则 sink 永远没有出口。
 *
 * @param dem DEM（推荐先 fillSinks）
 * @returns 方向栅格
 */
export function flowDirection(dem: DEMData): FlowDirectionResult {
    const rows = dem.rows;
    const cols = dem.cols;
    const dir = new Int32Array(rows * cols);
    if (rows < 1 || cols < 1) {
        return { direction: dir, rows, cols };
    }

    // D8 编码 + 相对距离
    //                          E  SE  S  SW  W  NW  N  NE
    const codes = [D8_DIRECTIONS.EAST, D8_DIRECTIONS.SOUTHEAST, D8_DIRECTIONS.SOUTH, D8_DIRECTIONS.SOUTHWEST, D8_DIRECTIONS.WEST, D8_DIRECTIONS.NORTHWEST, D8_DIRECTIONS.NORTH, D8_DIRECTIONS.NORTHEAST];
    const dR = [0, 1, 1, 1, 0, -1, -1, -1];
    const dC = [1, 1, 0, -1, -1, -1, 0, 1];
    const SQRT2 = Math.SQRT2;
    const dist = [1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const z = dem.values[r]![c]!;
            if (Number.isNaN(z)) {
                dir[r * cols + c] = D8_DIRECTIONS.NONE;
                continue;
            }

            let bestCode: number = D8_DIRECTIONS.NONE;
            let bestSlope = 0;

            for (let k = 0; k < 8; k++) {
                const nr = r + dR[k];
                const nc = c + dC[k];
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                const nz = dem.values[nr]![nc]!;
                if (Number.isNaN(nz)) continue;
                const slope = (z - nz) / dist[k];
                if (slope > bestSlope) {
                    bestSlope = slope;
                    bestCode = codes[k];
                }
            }

            dir[r * cols + c] = bestCode;
        }
    }

    return { direction: dir, rows, cols };
}

// ============================================================
// 3. 流量累积（Flow Accumulation）
// ============================================================

/**
 * 流量累积结果。每个 cell 存储"有多少上游 cell 的水流汇入此 cell"
 * （包含自身贡献 1）。典型用法：阈值化得到河网。
 */
export interface FlowAccumulationResult {
    readonly accumulation: Float64Array;
    readonly rows: number;
    readonly cols: number;
}

/**
 * 把 D8 方向编码转为 [dRow, dCol] 偏移。
 */
function decodeD8(code: number): [number, number] {
    switch (code) {
        case D8_DIRECTIONS.EAST: return [0, 1];
        case D8_DIRECTIONS.SOUTHEAST: return [1, 1];
        case D8_DIRECTIONS.SOUTH: return [1, 0];
        case D8_DIRECTIONS.SOUTHWEST: return [1, -1];
        case D8_DIRECTIONS.WEST: return [0, -1];
        case D8_DIRECTIONS.NORTHWEST: return [-1, -1];
        case D8_DIRECTIONS.NORTH: return [-1, 0];
        case D8_DIRECTIONS.NORTHEAST: return [-1, 1];
        default: return [0, 0];
    }
}

/**
 * 计算 D8 流量累积（基于 Topological Sort / in-degree 的 O(N) 算法）。
 *
 * 1. 构造每个 cell 的 in-degree（多少邻居指向它）
 * 2. 从 in-degree=0 的 cell 开始 BFS，每处理一个 cell 就把它的累积值
 *    加到下游 cell 上，并减少下游 in-degree
 * 3. in-degree 降到 0 时加入队列
 *
 * @param flow 来自 flowDirection 的结果
 * @returns 流量累积栅格（每 cell ≥ 1，自身贡献）
 */
export function flowAccumulation(flow: FlowDirectionResult): FlowAccumulationResult {
    const { direction, rows, cols } = flow;
    const n = rows * cols;
    const acc = new Float64Array(n);
    const inDegree = new Int32Array(n);

    // 1. 计算每个 cell 的入度
    for (let i = 0; i < n; i++) {
        const code = direction[i];
        if (code === D8_DIRECTIONS.NONE) continue;
        const r = (i / cols) | 0;
        const c = i - r * cols;
        const [dr, dc] = decodeD8(code);
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        inDegree[nr * cols + nc]++;
    }

    // 2. 初始化队列
    const queue = new Int32Array(n);
    let qHead = 0;
    let qTail = 0;
    for (let i = 0; i < n; i++) {
        acc[i] = 1; // 自身贡献
        if (inDegree[i] === 0) {
            queue[qTail++] = i;
        }
    }

    // 3. 拓扑 BFS
    while (qHead < qTail) {
        const i = queue[qHead++];
        const code = direction[i];
        if (code === D8_DIRECTIONS.NONE) continue;
        const r = (i / cols) | 0;
        const c = i - r * cols;
        const [dr, dc] = decodeD8(code);
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const downIdx = nr * cols + nc;
        acc[downIdx] += acc[i];
        inDegree[downIdx]--;
        if (inDegree[downIdx] === 0) {
            queue[qTail++] = downIdx;
        }
    }

    return { accumulation: acc, rows, cols };
}

// ============================================================
// 4. 流域（Watershed）
// ============================================================

/**
 * 从一个"出水口" cell 反向追溯所有最终流到此 cell 的上游 cell，得到流域范围。
 *
 * 实现：反向 BFS —— 对每个已在流域内的 cell，检查 8 邻居中有哪些"D8 方向指向
 * 当前 cell"，把这些邻居加入流域。
 *
 * @param flow D8 方向栅格
 * @param outletRow 出水口行
 * @param outletCol 出水口列
 * @returns Uint8Array，1 = 在流域内，0 = 不在
 */
export function watershed(
    flow: FlowDirectionResult,
    outletRow: number,
    outletCol: number,
): Uint8Array {
    const { direction, rows, cols } = flow;
    const mask = new Uint8Array(rows * cols);
    if (outletRow < 0 || outletRow >= rows || outletCol < 0 || outletCol >= cols) {
        return mask;
    }

    const queue = new Int32Array(rows * cols);
    let qHead = 0;
    let qTail = 0;
    const outletIdx = outletRow * cols + outletCol;
    mask[outletIdx] = 1;
    queue[qTail++] = outletIdx;

    // 8 邻居及其"指向中心"所需的方向编码
    const nbrDR = [0, 1, 1, 1, 0, -1, -1, -1];
    const nbrDC = [1, 1, 0, -1, -1, -1, 0, 1];
    // 如果邻居 (nr, nc) 在 (r, c) 的 dR[k]/dC[k] 方向上，那它需要指向 (r, c) 的反向
    const expectedInverse = [
        D8_DIRECTIONS.WEST,       // 邻居在东，它需要流向西 = 指向中心
        D8_DIRECTIONS.NORTHWEST,  // 邻居在东南 → 流向西北
        D8_DIRECTIONS.NORTH,      // 邻居在南 → 流向北
        D8_DIRECTIONS.NORTHEAST,  // 邻居在西南 → 流向东北
        D8_DIRECTIONS.EAST,       // 邻居在西 → 流向东
        D8_DIRECTIONS.SOUTHEAST,  // 邻居在西北 → 流向东南
        D8_DIRECTIONS.SOUTH,      // 邻居在北 → 流向南
        D8_DIRECTIONS.SOUTHWEST,  // 邻居在东北 → 流向西南
    ];

    while (qHead < qTail) {
        const idx = queue[qHead++];
        const r = (idx / cols) | 0;
        const c = idx - r * cols;
        for (let k = 0; k < 8; k++) {
            const nr = r + nbrDR[k];
            const nc = c + nbrDC[k];
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const nIdx = nr * cols + nc;
            if (mask[nIdx] !== 0) continue;
            if (direction[nIdx] === expectedInverse[k]) {
                mask[nIdx] = 1;
                queue[qTail++] = nIdx;
            }
        }
    }

    return mask;
}
