// ============================================================
// index/kd-tree.ts — KD-Tree 空间索引
// 用于最近邻搜索、k 近邻查询、范围搜索。
// 基于中位数分裂的平衡 KD-Tree。
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 公共接口 ========================

/**
 * KD-Tree 接口。
 * 支持最近邻搜索、k 近邻查询和矩形范围搜索。
 */
export interface KDTree<T = unknown> {
    /**
     * 查找距给定点最近的数据项。
     *
     * @param x - 查询点 x
     * @param y - 查询点 y
     * @returns 最近的数据项，树为空时返回 null
     */
    nearest(x: number, y: number): KDTreeItem<T> | null;

    /**
     * 查找距给定点最近的 k 个数据项。
     *
     * @param x - 查询点 x
     * @param y - 查询点 y
     * @param k - 返回的邻居数量
     * @returns 最近的 k 个项（按距离升序排列）
     */
    kNearest(x: number, y: number, k: number): KDTreeItem<T>[];

    /**
     * 查找矩形范围内的所有数据项。
     *
     * @param minX - 范围最小 x
     * @param minY - 范围最小 y
     * @param maxX - 范围最大 x
     * @param maxY - 范围最大 y
     * @returns 范围内的所有项
     */
    rangeSearch(minX: number, minY: number, maxX: number, maxY: number): KDTreeItem<T>[];

    /** 树中存储的项数 */
    readonly size: number;
}

/**
 * KD-Tree 中存储的项。
 */
export interface KDTreeItem<T = unknown> {
    /** 点 x 坐标 */
    readonly x: number;
    /** 点 y 坐标 */
    readonly y: number;
    /** 关联数据 */
    readonly data: T;
}

// ======================== 内部节点类型 ========================

/**
 * KD-Tree 内部节点。
 * 每个节点存储一个数据点，按交替的 x/y 轴分裂。
 */
interface KDNode<T> {
    /** 数据项 */
    item: KDTreeItem<T>;
    /** 左子树（值 ≤ 分裂面） */
    left: KDNode<T> | null;
    /** 右子树（值 > 分裂面） */
    right: KDNode<T> | null;
    /** 分裂轴：0 = x, 1 = y */
    axis: number;
}

// ======================== 工厂函数 ========================

/**
 * 从点集构建一棵平衡 KD-Tree。
 *
 * 使用中位数分裂策略构建，保证树高 O(log n)。
 * 构建时间 O(n log² n)（每层排序），查询时间 O(√n + k)。
 *
 * @param points - 输入点和关联数据数组
 * @returns KD-Tree 实例
 *
 * @example
 * const tree = createKDTree([
 *   { x: 0, y: 0, data: 'A' },
 *   { x: 3, y: 4, data: 'B' },
 *   { x: 1, y: 1, data: 'C' },
 * ]);
 * tree.nearest(0.5, 0.5); // { x: 0, y: 0, data: 'A' } 或 { x: 1, y: 1, data: 'C' }
 */
export function createKDTree<T = unknown>(
    points: KDTreeItem<T>[],
): KDTree<T> {
    const n = points.length;

    // 构建平衡 KD-Tree
    const root = n > 0 ? buildBalanced(points.slice(), 0, n - 1, 0) : null;

    /**
     * 递归构建平衡 KD-Tree。
     * 在每一层按当前轴排序，取中位数作为分裂点。
     *
     * @param items - 数据项数组（会被排序修改）
     * @param lo - 当前范围起始索引
     * @param hi - 当前范围结束索引
     * @param depth - 当前深度（决定分裂轴）
     * @returns 子树根节点
     */
    function buildBalanced(
        items: KDTreeItem<T>[],
        lo: number,
        hi: number,
        depth: number,
    ): KDNode<T> | null {
        if (lo > hi) return null;

        // 分裂轴：交替 x(0) 和 y(1)
        const axis = depth % 2;

        // 按当前轴排序
        if (axis === 0) {
            sortRange(items, lo, hi, (a, b) => a.x - b.x || a.y - b.y);
        } else {
            sortRange(items, lo, hi, (a, b) => a.y - b.y || a.x - b.x);
        }

        // 取中位数
        const mid = (lo + hi) >>> 1;

        return {
            item: items[mid],
            left: buildBalanced(items, lo, mid - 1, depth + 1),
            right: buildBalanced(items, mid + 1, hi, depth + 1),
            axis,
        };
    }

    /**
     * 最近邻搜索核心递归。
     *
     * @param node - 当前节点
     * @param x - 查询 x
     * @param y - 查询 y
     * @param best - 当前最优结果 { item, distSq }
     */
    function nearestSearch(
        node: KDNode<T> | null,
        x: number,
        y: number,
        best: { item: KDTreeItem<T> | null; distSq: number },
    ): void {
        if (node === null) return;

        // 计算到当前节点的距离平方
        const dx = x - node.item.x;
        const dy = y - node.item.y;
        const distSq = dx * dx + dy * dy;

        // 更新最优
        if (distSq < best.distSq) {
            best.distSq = distSq;
            best.item = node.item;
        }

        // 确定先搜索哪个子树
        const diff = node.axis === 0 ? dx : dy;
        const first = diff <= 0 ? node.left : node.right;
        const second = diff <= 0 ? node.right : node.left;

        // 先搜索更可能包含最近邻的子树
        nearestSearch(first, x, y, best);

        // 如果分裂平面到查询点的距离小于当前最优距离，也搜索另一侧
        if (diff * diff < best.distSq) {
            nearestSearch(second, x, y, best);
        }
    }

    /**
     * k 近邻搜索核心递归。
     * 使用最大堆维护 k 个最近邻。
     *
     * @param node - 当前节点
     * @param x - 查询 x
     * @param y - 查询 y
     * @param k - 最大邻居数
     * @param heap - 最大堆 [{ item, distSq }, ...]
     */
    function kNearestSearch(
        node: KDNode<T> | null,
        x: number,
        y: number,
        k: number,
        heap: Array<{ item: KDTreeItem<T>; distSq: number }>,
    ): void {
        if (node === null) return;

        const dx = x - node.item.x;
        const dy = y - node.item.y;
        const distSq = dx * dx + dy * dy;

        // 如果堆未满或当前距离小于堆顶（最大距离），加入堆
        if (heap.length < k) {
            heap.push({ item: node.item, distSq });
            // 上浮维护堆性质
            heapifyUp(heap, heap.length - 1);
        } else if (distSq < heap[0].distSq) {
            // 替换堆顶
            heap[0] = { item: node.item, distSq };
            // 下沉维护堆性质
            heapifyDown(heap, 0);
        }

        // 确定搜索顺序
        const diff = node.axis === 0 ? dx : dy;
        const first = diff <= 0 ? node.left : node.right;
        const second = diff <= 0 ? node.right : node.left;

        kNearestSearch(first, x, y, k, heap);

        // 剪枝：分裂面距离是否可能有更近的点
        if (heap.length < k || diff * diff < heap[0].distSq) {
            kNearestSearch(second, x, y, k, heap);
        }
    }

    /**
     * 范围搜索核心递归。
     *
     * @param node - 当前节点
     * @param minX - 范围最小 x
     * @param minY - 范围最小 y
     * @param maxX - 范围最大 x
     * @param maxY - 范围最大 y
     * @param result - 结果数组
     */
    function rangeSearchNode(
        node: KDNode<T> | null,
        rMinX: number, rMinY: number,
        rMaxX: number, rMaxY: number,
        result: KDTreeItem<T>[],
    ): void {
        if (node === null) return;

        // 检查当前节点是否在范围内
        const ix = node.item.x;
        const iy = node.item.y;
        if (ix >= rMinX && ix <= rMaxX && iy >= rMinY && iy <= rMaxY) {
            result.push(node.item);
        }

        // 确定是否需要搜索子树
        // 左子树包含 axis 值 ≤ 当前节点的点
        // 右子树包含 axis 值 > 当前节点的点
        const splitVal = node.axis === 0 ? ix : iy;
        const rangeMin = node.axis === 0 ? rMinX : rMinY;
        const rangeMax = node.axis === 0 ? rMaxX : rMaxY;

        // 如果范围最小值 ≤ 分裂值，左子树可能有匹配
        if (rangeMin <= splitVal) {
            rangeSearchNode(node.left, rMinX, rMinY, rMaxX, rMaxY, result);
        }
        // 如果范围最大值 > 分裂值，右子树可能有匹配
        if (rangeMax > splitVal) {
            rangeSearchNode(node.right, rMinX, rMinY, rMaxX, rMaxY, result);
        }
    }

    // ======================== KDTree 实例 ========================

    const tree: KDTree<T> = {
        nearest(x: number, y: number): KDTreeItem<T> | null {
            if (root === null) return null;
            const best = { item: null as KDTreeItem<T> | null, distSq: Infinity };
            nearestSearch(root, x, y, best);
            return best.item;
        },

        kNearest(x: number, y: number, k: number): KDTreeItem<T>[] {
            if (root === null || k <= 0) return [];

            const heap: Array<{ item: KDTreeItem<T>; distSq: number }> = [];
            kNearestSearch(root, x, y, k, heap);

            // 按距离升序排序输出
            return heap
                .sort((a, b) => a.distSq - b.distSq)
                .map(h => h.item);
        },

        rangeSearch(
            rMinX: number, rMinY: number,
            rMaxX: number, rMaxY: number,
        ): KDTreeItem<T>[] {
            const result: KDTreeItem<T>[] = [];
            rangeSearchNode(root, rMinX, rMinY, rMaxX, rMaxY, result);
            return result;
        },

        get size(): number {
            return n;
        },
    };

    return tree;
}

// ======================== 内部辅助函数 ========================

/**
 * 对数组的指定范围进行排序。
 *
 * @param arr - 数组
 * @param lo - 起始索引
 * @param hi - 结束索引
 * @param cmp - 比较函数
 */
function sortRange<T>(
    arr: T[],
    lo: number,
    hi: number,
    cmp: (a: T, b: T) => number,
): void {
    // 提取子数组排序后放回
    const sub = arr.slice(lo, hi + 1);
    sub.sort(cmp);
    for (let i = 0; i < sub.length; i++) {
        arr[lo + i] = sub[i];
    }
}

/**
 * 最大堆上浮操作。
 *
 * @param heap - 堆数组
 * @param index - 上浮起始索引
 */
function heapifyUp<T extends { distSq: number }>(
    heap: T[],
    index: number,
): void {
    while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (heap[index].distSq > heap[parent].distSq) {
            // 交换
            const tmp = heap[index];
            heap[index] = heap[parent];
            heap[parent] = tmp;
            index = parent;
        } else {
            break;
        }
    }
}

/**
 * 最大堆下沉操作。
 *
 * @param heap - 堆数组
 * @param index - 下沉起始索引
 */
function heapifyDown<T extends { distSq: number }>(
    heap: T[],
    index: number,
): void {
    const n = heap.length;
    while (true) {
        let largest = index;
        const left = 2 * index + 1;
        const right = 2 * index + 2;

        if (left < n && heap[left].distSq > heap[largest].distSq) {
            largest = left;
        }
        if (right < n && heap[right].distSq > heap[largest].distSq) {
            largest = right;
        }

        if (largest !== index) {
            const tmp = heap[index];
            heap[index] = heap[largest];
            heap[largest] = tmp;
            index = largest;
        } else {
            break;
        }
    }
}

declare const __DEV__: boolean;
