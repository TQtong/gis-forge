// ============================================================
// index/rtree.ts — R-Tree 空间索引（完整自研实现）
// 基于 Sort-Tile-Recursive (STR) 批量加载的 R-Tree。
// 支持插入、删除、矩形查询、碰撞检测。
// 节点扇出 M=16（cache-line 友好，64B = 16 × 4B float 对齐）。
// 零外部依赖。
// ============================================================

// ======================== 常量定义 ========================

/** 默认节点最大子节点数（扇出因子），16 对 L1 缓存友好 */
const DEFAULT_MAX_ENTRIES = 16;

/** 节点最小填充率（避免下溢），最大子节点数的 40% */
const MIN_FILL_FACTOR = 0.4;

// ======================== 公共接口 ========================

/**
 * R-Tree 中存储的项，包含包围盒和关联数据。
 * 包围盒使用 minX/minY/maxX/maxY 格式（非 west/south/east/north），
 * 更适合通用空间索引场景。
 *
 * @example
 * const item: RTreeItem<string> = { minX: 0, minY: 0, maxX: 1, maxY: 1, data: "building-42" };
 */
export interface RTreeItem<T = unknown> {
    /** 包围盒最小 x */
    readonly minX: number;

    /** 包围盒最小 y */
    readonly minY: number;

    /** 包围盒最大 x */
    readonly maxX: number;

    /** 包围盒最大 y */
    readonly maxY: number;

    /** 关联数据 */
    readonly data: T;
}

/**
 * R-Tree 空间索引接口。
 * 支持 STR 批量加载、逐个插入/删除、矩形查询、碰撞检测。
 */
export interface RTree<T = unknown> {
    /**
     * 批量加载数据项（比逐个 insert 快 10 倍+）。
     * 使用 STR (Sort-Tile-Recursive) 算法自底向上构建平衡树。
     * 调用此方法会清空现有数据。
     *
     * @param items - 要加载的数据项数组
     */
    load(items: RTreeItem<T>[]): void;

    /**
     * 插入单个数据项。
     * 选择面积增长最小的叶节点插入，必要时分裂节点。
     *
     * @param item - 要插入的数据项
     */
    insert(item: RTreeItem<T>): void;

    /**
     * 删除一个数据项。
     * 使用引用相等 (===) 比较来匹配项。
     *
     * @param item - 要删除的数据项（必须与插入时是同一个对象引用）
     * @returns 是否成功删除
     */
    remove(item: RTreeItem<T>): boolean;

    /**
     * 矩形范围查询：返回所有与给定包围盒重叠的项。
     *
     * @param bbox - 查询包围盒
     * @returns 与查询范围重叠的所有项
     */
    search(bbox: { minX: number; minY: number; maxX: number; maxY: number }): RTreeItem<T>[];

    /**
     * 碰撞检测：检查是否存在与给定包围盒重叠的项。
     * 比 search 更快，因为找到第一个就返回。
     *
     * @param bbox - 查询包围盒
     * @returns 是否存在碰撞
     */
    collides(bbox: { minX: number; minY: number; maxX: number; maxY: number }): boolean;

    /**
     * 返回所有存储的项。
     *
     * @returns 所有项的数组
     */
    all(): RTreeItem<T>[];

    /** 当前存储的项数 */
    readonly size: number;

    /** 清空整棵树 */
    clear(): void;
}

// ======================== 内部节点类型 ========================

/**
 * R-Tree 内部节点，存储子节点列表和包围盒。
 * 叶节点的 children 包含 RTreeItem，中间节点的 children 包含 RTreeNode。
 */
interface RTreeNode<T> {
    /** 子节点数组（叶节点存 RTreeItem，内部节点存 RTreeNode） */
    children: Array<RTreeNode<T> | RTreeItem<T>>;

    /** 节点包围盒最小 x（覆盖所有子节点） */
    minX: number;

    /** 节点包围盒最小 y */
    minY: number;

    /** 节点包围盒最大 x */
    maxX: number;

    /** 节点包围盒最大 y */
    maxY: number;

    /** 节点高度（叶节点 = 1，根节点 = 树高） */
    height: number;

    /** 是否为叶节点 */
    leaf: boolean;
}

// ======================== 工厂函数 ========================

/**
 * 创建一个新的 R-Tree 空间索引。
 * R-Tree 是一种用于空间数据的平衡树结构，支持高效的矩形范围查询。
 *
 * @param maxEntries - 每个节点的最大子节点数（默认 16）。
 *                     较大值减少树高但增加节点搜索时间，16 是 cache-line 友好的折中值。
 * @returns 新的 R-Tree 实例
 *
 * @example
 * const tree = createRTree<string>(16);
 * tree.insert({ minX: 0, minY: 0, maxX: 1, maxY: 1, data: "a" });
 * const results = tree.search({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
 */
export function createRTree<T = unknown>(maxEntries: number = DEFAULT_MAX_ENTRIES): RTree<T> {
    // 确保扇出因子至少为 4（太小会导致树太高）
    const M = Math.max(4, maxEntries);
    // 最小填充数 = 扇出的 40%，至少 2
    const m = Math.max(2, Math.ceil(M * MIN_FILL_FACTOR));

    // 初始化空树：高度 1 的叶节点
    let root: RTreeNode<T> = createEmptyNode<T>(true);
    let itemCount = 0;

    /**
     * 创建空节点。
     *
     * @param leaf - 是否为叶节点
     * @returns 新的空节点
     */
    function createEmptyNode<U>(leaf: boolean): RTreeNode<U> {
        return {
            children: [],
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
            height: 1,
            leaf,
        };
    }

    /**
     * 扩展节点的包围盒以包含给定的包围盒。
     *
     * @param node - 要扩展的节点
     * @param bbox - 需要包含的包围盒
     */
    function extendBBox(
        node: RTreeNode<T>,
        bbox: { minX: number; minY: number; maxX: number; maxY: number },
    ): void {
        if (bbox.minX < node.minX) node.minX = bbox.minX;
        if (bbox.minY < node.minY) node.minY = bbox.minY;
        if (bbox.maxX > node.maxX) node.maxX = bbox.maxX;
        if (bbox.maxY > node.maxY) node.maxY = bbox.maxY;
    }

    /**
     * 重新计算节点的包围盒（从子节点推导）。
     *
     * @param node - 需要重算包围盒的节点
     */
    function recalcBBox(node: RTreeNode<T>): void {
        node.minX = Infinity;
        node.minY = Infinity;
        node.maxX = -Infinity;
        node.maxY = -Infinity;
        // 遍历所有子节点取并集
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i] as { minX: number; minY: number; maxX: number; maxY: number };
            extendBBox(node, child);
        }
    }

    /**
     * 计算包围盒面积。
     *
     * @param bbox - 包围盒
     * @returns 面积值
     */
    function bboxArea(bbox: { minX: number; minY: number; maxX: number; maxY: number }): number {
        return (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
    }

    /**
     * 计算将 bbox 加入 node 后面积的增量。
     *
     * @param bbox - 新加入的包围盒
     * @param node - 目标节点
     * @returns 面积增量
     */
    function enlargedArea(
        bbox: { minX: number; minY: number; maxX: number; maxY: number },
        node: { minX: number; minY: number; maxX: number; maxY: number },
    ): number {
        // 合并后的面积 - 原始面积
        return (
            (Math.max(bbox.maxX, node.maxX) - Math.min(bbox.minX, node.minX)) *
            (Math.max(bbox.maxY, node.maxY) - Math.min(bbox.minY, node.minY)) -
            bboxArea(node)
        );
    }

    /**
     * 计算两个包围盒交集的面积。
     *
     * @param a - 包围盒 A
     * @param b - 包围盒 B
     * @returns 交集面积（不重叠返回 0）
     */
    function intersectionArea(
        a: { minX: number; minY: number; maxX: number; maxY: number },
        b: { minX: number; minY: number; maxX: number; maxY: number },
    ): number {
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        // 任何轴没有重叠则交集为 0
        if (overlapX <= 0 || overlapY <= 0) return 0;
        return overlapX * overlapY;
    }

    /**
     * 选择插入目标叶节点：从根到叶自顶向下选择面积增长最小的路径。
     * 在叶层使用最小重叠面积增长，非叶层使用最小面积增长。
     *
     * @param bbox - 待插入项的包围盒
     * @param node - 当前搜索节点
     * @param level - 目标插入层级
     * @param path - 路径记录（用于分裂时回溯）
     * @returns 最佳目标节点
     */
    function chooseSubtree(
        bbox: { minX: number; minY: number; maxX: number; maxY: number },
        node: RTreeNode<T>,
        level: number,
        path: RTreeNode<T>[],
    ): RTreeNode<T> {
        let current = node;

        while (true) {
            path.push(current);

            // 到达目标层级或叶节点
            if (current.leaf || path.length - 1 === level) {
                break;
            }

            let bestChild: RTreeNode<T> | null = null;
            let minEnlargement = Infinity;
            let minArea = Infinity;

            const children = current.children as RTreeNode<T>[];

            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const childArea = bboxArea(child);
                const enlargement = enlargedArea(bbox, child);

                // 选择面积增长最小的子树
                if (enlargement < minEnlargement) {
                    minEnlargement = enlargement;
                    minArea = childArea;
                    bestChild = child;
                } else if (enlargement === minEnlargement) {
                    // 面积增长相同时选面积更小的
                    if (childArea < minArea) {
                        minArea = childArea;
                        bestChild = child;
                    }
                }
            }

            // 如果没选到（不应发生），用第一个子节点
            current = bestChild || children[0];
        }

        return current;
    }

    /**
     * 节点分裂：当子节点数超过 M 时分裂为两个节点。
     * 使用选择分裂轴 + 最小重叠面积分裂策略。
     *
     * @param node - 需要分裂的节点
     * @returns 新节点（包含被移出的子节点）
     */
    function split(node: RTreeNode<T>): RTreeNode<T> {
        // 选择分裂轴（哪个轴上分裂能产生最小的总边界长度）
        const axis = chooseSplitAxis(node);

        // 按选定轴排序子节点
        sortByAxis(node.children, axis);

        // 找到最优分裂位置
        const splitIndex = chooseSplitIndex(node);

        // 创建新节点，将右半部分的子节点移入
        const newNode = createEmptyNode<T>(node.leaf);
        newNode.height = node.height;
        newNode.children = node.children.splice(splitIndex);

        // 重新计算两个节点的包围盒
        recalcBBox(node);
        recalcBBox(newNode);

        return newNode;
    }

    /**
     * 选择分裂轴：比较 X 轴和 Y 轴分裂的总边界周长，选择周长更小的轴。
     *
     * @param node - 需要分裂的节点
     * @returns 0 = X 轴，1 = Y 轴
     */
    function chooseSplitAxis(node: RTreeNode<T>): number {
        // 计算 X 轴排序的总边界周长
        sortByAxis(node.children, 0);
        const xMargin = computeAllDistributionMargins(node);

        // 计算 Y 轴排序的总边界周长
        sortByAxis(node.children, 1);
        const yMargin = computeAllDistributionMargins(node);

        // 选择总边界周长更小的轴
        if (xMargin < yMargin) {
            // 需要重新按 X 轴排序
            sortByAxis(node.children, 0);
            return 0;
        }
        return 1;
    }

    /**
     * 计算所有可能分裂位置的总边界周长。
     *
     * @param node - 节点
     * @returns 总边界周长
     */
    function computeAllDistributionMargins(node: RTreeNode<T>): number {
        let totalMargin = 0;
        const len = node.children.length;

        // 尝试所有有效的分裂位置：从 m 到 len - m
        for (let i = m; i <= len - m; i++) {
            // 计算左组包围盒的周长
            let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity;
            for (let j = 0; j < i; j++) {
                const c = node.children[j] as { minX: number; minY: number; maxX: number; maxY: number };
                if (c.minX < lMinX) lMinX = c.minX;
                if (c.minY < lMinY) lMinY = c.minY;
                if (c.maxX > lMaxX) lMaxX = c.maxX;
                if (c.maxY > lMaxY) lMaxY = c.maxY;
            }
            // 计算右组包围盒的周长
            let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
            for (let j = i; j < len; j++) {
                const c = node.children[j] as { minX: number; minY: number; maxX: number; maxY: number };
                if (c.minX < rMinX) rMinX = c.minX;
                if (c.minY < rMinY) rMinY = c.minY;
                if (c.maxX > rMaxX) rMaxX = c.maxX;
                if (c.maxY > rMaxY) rMaxY = c.maxY;
            }

            // 周长 = 2 * (width + height)
            totalMargin +=
                (lMaxX - lMinX) + (lMaxY - lMinY) +
                (rMaxX - rMinX) + (rMaxY - rMinY);
        }

        return totalMargin;
    }

    /**
     * 选择最优分裂位置：使左右两组包围盒的重叠面积最小。
     *
     * @param node - 节点
     * @returns 分裂位置索引
     */
    function chooseSplitIndex(node: RTreeNode<T>): number {
        const len = node.children.length;
        let bestIndex = m;
        let bestOverlap = Infinity;
        let bestArea = Infinity;

        for (let i = m; i <= len - m; i++) {
            // 计算左组包围盒
            let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity;
            for (let j = 0; j < i; j++) {
                const c = node.children[j] as { minX: number; minY: number; maxX: number; maxY: number };
                if (c.minX < lMinX) lMinX = c.minX;
                if (c.minY < lMinY) lMinY = c.minY;
                if (c.maxX > lMaxX) lMaxX = c.maxX;
                if (c.maxY > lMaxY) lMaxY = c.maxY;
            }
            // 计算右组包围盒
            let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
            for (let j = i; j < len; j++) {
                const c = node.children[j] as { minX: number; minY: number; maxX: number; maxY: number };
                if (c.minX < rMinX) rMinX = c.minX;
                if (c.minY < rMinY) rMinY = c.minY;
                if (c.maxX > rMaxX) rMaxX = c.maxX;
                if (c.maxY > rMaxY) rMaxY = c.maxY;
            }

            // 计算两组的重叠面积和总面积
            const overlap = intersectionArea(
                { minX: lMinX, minY: lMinY, maxX: lMaxX, maxY: lMaxY },
                { minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY },
            );
            const area =
                (lMaxX - lMinX) * (lMaxY - lMinY) +
                (rMaxX - rMinX) * (rMaxY - rMinY);

            // 优先最小重叠，重叠相同时选总面积最小
            if (overlap < bestOverlap) {
                bestOverlap = overlap;
                bestArea = area;
                bestIndex = i;
            } else if (overlap === bestOverlap && area < bestArea) {
                bestArea = area;
                bestIndex = i;
            }
        }

        return bestIndex;
    }

    /**
     * 按指定轴排序子节点。
     *
     * @param children - 子节点数组
     * @param axis - 0 = X 轴，1 = Y 轴
     */
    function sortByAxis(
        children: Array<RTreeNode<T> | RTreeItem<T>>,
        axis: number,
    ): void {
        if (axis === 0) {
            // 按 minX 排序，相同时按 minY
            children.sort((a, b) => (a as any).minX - (b as any).minX || (a as any).minY - (b as any).minY);
        } else {
            // 按 minY 排序，相同时按 minX
            children.sort((a, b) => (a as any).minY - (b as any).minY || (a as any).minX - (b as any).minX);
        }
    }

    /**
     * STR 批量加载：将所有项自底向上构建平衡树。
     * Sort-Tile-Recursive 算法按 X 排序后分块，每块内按 Y 排序再分块，递归构建。
     *
     * @param items - 数据项数组（会被排序修改）
     * @param left - 当前处理范围左端
     * @param right - 当前处理范围右端
     * @param height - 树高（从期望高度递减到 1）
     * @returns 构建好的子树根节点
     */
    function buildSTR(
        items: RTreeItem<T>[],
        left: number,
        right: number,
        height: number,
    ): RTreeNode<T> {
        const N = right - left + 1;
        const node = createEmptyNode<T>(height === 1);
        node.height = height;

        if (N <= M) {
            // 项数不超过节点容量，直接放入叶节点
            for (let i = left; i <= right; i++) {
                node.children.push(items[i]);
                extendBBox(node, items[i]);
            }
            return node;
        }

        if (height === 1) {
            // 叶层：每 M 个项构成一个叶节点
            for (let i = left; i <= right; i++) {
                node.children.push(items[i]);
                extendBBox(node, items[i]);
            }
            return node;
        }

        // 计算每个"条带"的宽度，使得条带数 × 条带内行数 ≈ N/M
        const childCount = Math.ceil(N / M);
        const stripCount = Math.ceil(Math.sqrt(childCount));
        const stripSize = Math.ceil(N / stripCount);

        // 按 X 坐标的中心排序
        sortItemsByAxis(items, left, right, 0);

        // 对每个 X 条带，按 Y 排序并递归构建子树
        for (let i = left; i <= right; i += stripSize) {
            const stripEnd = Math.min(i + stripSize - 1, right);

            // 条带内按 Y 排序
            sortItemsByAxis(items, i, stripEnd, 1);

            // 按 M 分组，每组递归
            for (let j = i; j <= stripEnd; j += M) {
                const groupEnd = Math.min(j + M - 1, stripEnd);
                const child = buildSTR(items, j, groupEnd, height - 1);
                node.children.push(child);
                extendBBox(node, child);
            }
        }

        return node;
    }

    /**
     * 按轴中心排序项数组的指定范围。
     *
     * @param items - 项数组
     * @param left - 排序起始
     * @param right - 排序结束
     * @param axis - 0 = X, 1 = Y
     */
    function sortItemsByAxis(
        items: RTreeItem<T>[],
        left: number,
        right: number,
        axis: number,
    ): void {
        // 提取子数组排序后放回（避免写自定义排序范围）
        const sub = items.slice(left, right + 1);
        if (axis === 0) {
            sub.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
        } else {
            sub.sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
        }
        for (let i = 0; i < sub.length; i++) {
            items[left + i] = sub[i];
        }
    }

    /**
     * 计算 N 个项需要的树高。
     *
     * @param n - 项数
     * @returns 树高
     */
    function calcTreeHeight(n: number): number {
        // height = ceil(log_M(n))，至少为 1
        return Math.max(1, Math.ceil(Math.log(n) / Math.log(M)));
    }

    /**
     * 递归收集节点下所有叶项。
     *
     * @param node - 起始节点
     * @param result - 结果数组
     */
    function collectAll(node: RTreeNode<T>, result: RTreeItem<T>[]): void {
        if (node.leaf) {
            // 叶节点：子节点就是数据项
            for (let i = 0; i < node.children.length; i++) {
                result.push(node.children[i] as RTreeItem<T>);
            }
        } else {
            // 内部节点：递归收集
            for (let i = 0; i < node.children.length; i++) {
                collectAll(node.children[i] as RTreeNode<T>, result);
            }
        }
    }

    /**
     * 在节点子树中查找并删除指定项。
     *
     * @param node - 搜索起点节点
     * @param item - 要删除的项
     * @param path - 路径记录
     * @param pathIndices - 路径中的子节点索引记录
     * @returns 是否找到并删除
     */
    function removeItem(
        node: RTreeNode<T>,
        item: RTreeItem<T>,
        path: RTreeNode<T>[],
        pathIndices: number[],
    ): boolean {
        if (node.leaf) {
            // 叶节点：查找并移除项
            for (let i = 0; i < node.children.length; i++) {
                if (node.children[i] === item) {
                    node.children.splice(i, 1);
                    return true;
                }
            }
            return false;
        }

        // 内部节点：只在包围盒重叠的子节点中搜索
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i] as RTreeNode<T>;
            if (
                item.minX >= child.minX && item.maxX <= child.maxX &&
                item.minY >= child.minY && item.maxY <= child.maxY
            ) {
                path.push(node);
                pathIndices.push(i);
                if (removeItem(child, item, path, pathIndices)) {
                    return true;
                }
                path.pop();
                pathIndices.pop();
            }
        }

        return false;
    }

    /**
     * 删除后修复树结构：重新计算路径上的包围盒，处理下溢节点。
     *
     * @param path - 从根到删除点的路径
     */
    function condense(path: RTreeNode<T>[]): void {
        const reinsertItems: RTreeItem<T>[] = [];

        // 自底向上修复
        for (let i = path.length - 1; i >= 0; i--) {
            const node = path[i];

            if (node.children.length === 0) {
                // 节点为空：从父节点移除
                if (i > 0) {
                    const parent = path[i - 1];
                    const idx = parent.children.indexOf(node);
                    if (idx >= 0) parent.children.splice(idx, 1);
                } else {
                    // 根节点为空：重置
                    root = createEmptyNode<T>(true);
                }
            } else {
                // 重新计算包围盒
                recalcBBox(node);
            }
        }

        // 重新插入下溢节点的子项
        for (let i = 0; i < reinsertItems.length; i++) {
            tree.insert(reinsertItems[i]);
        }
    }

    // ======================== R-Tree 实例 ========================

    const tree: RTree<T> = {
        load(items: RTreeItem<T>[]): void {
            // 边界检查：空数组
            if (items.length === 0) return;

            // 复制一份避免修改原数组
            const copy = items.slice();
            const n = copy.length;

            // 计算树高
            const height = calcTreeHeight(n);

            // 使用 STR 算法构建
            root = buildSTR(copy, 0, n - 1, height);
            itemCount = n;
        },

        insert(item: RTreeItem<T>): void {
            // 选择目标叶节点
            const path: RTreeNode<T>[] = [];
            const targetNode = chooseSubtree(item, root, root.height - 1, path);

            // 在叶节点中插入项
            targetNode.children.push(item);
            extendBBox(targetNode, item);

            // 自底向上扩展路径上所有节点的包围盒，必要时分裂
            let level = path.length - 1;
            let currentNode: RTreeNode<T> = targetNode;

            while (level >= 0) {
                // 扩展路径节点的包围盒
                extendBBox(path[level], item);

                // 检查是否需要分裂
                if (currentNode.children.length > M) {
                    const newNode = split(currentNode);

                    if (level === 0) {
                        // 根节点分裂：创建新根
                        const newRoot = createEmptyNode<T>(false);
                        newRoot.height = root.height + 1;
                        newRoot.children.push(root, newNode);
                        recalcBBox(newRoot);
                        root = newRoot;
                    } else {
                        // 非根节点分裂：将新节点添加到父节点
                        path[level - 1].children.push(newNode);
                        recalcBBox(path[level - 1]);
                    }
                }

                level--;
                currentNode = level >= 0 ? path[level] : root;
            }

            itemCount++;
        },

        remove(item: RTreeItem<T>): boolean {
            const path: RTreeNode<T>[] = [];
            const pathIndices: number[] = [];

            // 在树中查找并删除
            const found = removeItem(root, item, path, pathIndices);

            if (found) {
                // 修复树结构
                path.push(root);
                condense(path);
                itemCount--;

                // 如果根节点只有一个子节点且不是叶节点，降低树高
                if (root.children.length === 1 && !root.leaf) {
                    root = root.children[0] as RTreeNode<T>;
                }
            }

            return found;
        },

        search(bbox: { minX: number; minY: number; maxX: number; maxY: number }): RTreeItem<T>[] {
            const result: RTreeItem<T>[] = [];

            // 空树快速返回
            if (root.children.length === 0) return result;

            // 使用栈代替递归（避免大数据集栈溢出）
            const stack: RTreeNode<T>[] = [root];

            while (stack.length > 0) {
                const node = stack.pop()!;

                // 跳过不重叠的节点
                if (bbox.maxX < node.minX || bbox.maxY < node.minY ||
                    bbox.minX > node.maxX || bbox.minY > node.maxY) {
                    continue;
                }

                if (node.leaf) {
                    // 叶节点：检查每个项
                    for (let i = 0; i < node.children.length; i++) {
                        const child = node.children[i] as RTreeItem<T>;
                        if (
                            bbox.maxX >= child.minX && bbox.maxY >= child.minY &&
                            bbox.minX <= child.maxX && bbox.minY <= child.maxY
                        ) {
                            result.push(child);
                        }
                    }
                } else {
                    // 内部节点：将重叠的子节点压栈
                    for (let i = 0; i < node.children.length; i++) {
                        const child = node.children[i] as RTreeNode<T>;
                        if (
                            bbox.maxX >= child.minX && bbox.maxY >= child.minY &&
                            bbox.minX <= child.maxX && bbox.minY <= child.maxY
                        ) {
                            stack.push(child);
                        }
                    }
                }
            }

            return result;
        },

        collides(bbox: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
            // 空树快速返回
            if (root.children.length === 0) return false;

            // 使用栈遍历，找到第一个碰撞就返回
            const stack: RTreeNode<T>[] = [root];

            while (stack.length > 0) {
                const node = stack.pop()!;

                // 跳过不重叠的节点
                if (bbox.maxX < node.minX || bbox.maxY < node.minY ||
                    bbox.minX > node.maxX || bbox.minY > node.maxY) {
                    continue;
                }

                if (node.leaf) {
                    // 叶节点：找到第一个碰撞的项
                    for (let i = 0; i < node.children.length; i++) {
                        const child = node.children[i] as RTreeItem<T>;
                        if (
                            bbox.maxX >= child.minX && bbox.maxY >= child.minY &&
                            bbox.minX <= child.maxX && bbox.minY <= child.maxY
                        ) {
                            return true;
                        }
                    }
                } else {
                    for (let i = 0; i < node.children.length; i++) {
                        const child = node.children[i] as RTreeNode<T>;
                        if (
                            bbox.maxX >= child.minX && bbox.maxY >= child.minY &&
                            bbox.minX <= child.maxX && bbox.minY <= child.maxY
                        ) {
                            stack.push(child);
                        }
                    }
                }
            }

            return false;
        },

        all(): RTreeItem<T>[] {
            const result: RTreeItem<T>[] = [];
            collectAll(root, result);
            return result;
        },

        get size(): number {
            return itemCount;
        },

        clear(): void {
            root = createEmptyNode<T>(true);
            itemCount = 0;
        },
    };

    return tree;
}
