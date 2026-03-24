// ============================================================
// index/quadtree.ts — 四叉树空间索引
// 用于瓦片调度、2D 空间分区、碰撞检测等场景。
// 支持插入、搜索、删除、遍历。
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 常量 ========================

/** 每个节点在分裂前的最大项数，默认 8 */
const DEFAULT_MAX_ITEMS: number = 8;

/** 最大树深度，防止退化时无限细分 */
const MAX_DEPTH: number = 20;

// ======================== 公共接口 ========================

/**
 * 四叉树接口。
 * 支持点数据的插入、范围查询、删除和遍历。
 */
export interface QuadTree<T = unknown> {
    /**
     * 插入一个带坐标的数据项。
     *
     * @param x - 数据点 x 坐标
     * @param y - 数据点 y 坐标
     * @param data - 关联数据
     */
    insert(x: number, y: number, data: T): void;

    /**
     * 查询与给定包围盒重叠的所有数据项。
     *
     * @param minX - 查询范围最小 x
     * @param minY - 查询范围最小 y
     * @param maxX - 查询范围最大 x
     * @param maxY - 查询范围最大 y
     * @returns 匹配的数据项数组
     */
    search(minX: number, minY: number, maxX: number, maxY: number): QuadTreeItem<T>[];

    /**
     * 删除一个数据项。使用坐标 + 引用相等 (===) 定位。
     *
     * @param x - 数据点 x 坐标
     * @param y - 数据点 y 坐标
     * @param data - 要删除的数据（引用相等）
     * @returns 是否成功删除
     */
    remove(x: number, y: number, data: T): boolean;

    /**
     * 遍历与给定包围盒重叠的所有项，调用回调函数。
     * 比 search 更高效，因为不创建结果数组。
     *
     * @param minX - 范围最小 x
     * @param minY - 范围最小 y
     * @param maxX - 范围最大 x
     * @param maxY - 范围最大 y
     * @param callback - 对每个匹配项调用的回调
     */
    forEachInBBox(
        minX: number, minY: number, maxX: number, maxY: number,
        callback: (item: QuadTreeItem<T>) => void,
    ): void;

    /** 清空整棵树 */
    clear(): void;

    /** 当前存储的项数 */
    readonly size: number;
}

/**
 * 四叉树中存储的项，包含坐标和关联数据。
 */
export interface QuadTreeItem<T = unknown> {
    /** 点 x 坐标 */
    readonly x: number;
    /** 点 y 坐标 */
    readonly y: number;
    /** 关联数据 */
    readonly data: T;
}

// ======================== 内部节点类型 ========================

/**
 * 四叉树内部节点。
 * 当项数超过 maxItems 且深度未达上限时分裂为 4 个子节点。
 */
interface QTNode<T> {
    /** 节点包围盒最小 x */
    minX: number;
    /** 节点包围盒最小 y */
    minY: number;
    /** 节点包围盒最大 x */
    maxX: number;
    /** 节点包围盒最大 y */
    maxY: number;
    /** 节点中心 x（分裂分界线） */
    cx: number;
    /** 节点中心 y */
    cy: number;
    /** 节点深度（根=0） */
    depth: number;
    /** 叶节点存储的项 */
    items: QuadTreeItem<T>[];
    /** 子节点：NW=0, NE=1, SW=2, SE=3，null 表示未分裂 */
    children: (QTNode<T> | null)[];
    /** 是否已分裂 */
    split: boolean;
}

// ======================== 工厂函数 ========================

/**
 * 创建一个新的四叉树空间索引。
 *
 * @param minX - 空间范围最小 x
 * @param minY - 空间范围最小 y
 * @param maxX - 空间范围最大 x
 * @param maxY - 空间范围最大 y
 * @param maxItems - 节点分裂阈值，默认 8
 * @returns 四叉树实例
 *
 * @example
 * const qt = createQuadTree<string>(0, 0, 100, 100);
 * qt.insert(50, 50, "center-point");
 * qt.search(40, 40, 60, 60); // [{ x: 50, y: 50, data: "center-point" }]
 */
export function createQuadTree<T = unknown>(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    maxItems: number = DEFAULT_MAX_ITEMS,
): QuadTree<T> {
    // 确保至少容纳 1 个项
    const maxItemsPerNode = Math.max(1, maxItems);

    // 创建根节点
    let root = createNode<T>(minX, minY, maxX, maxY, 0);
    let itemCount = 0;

    /**
     * 创建空四叉树节点。
     */
    function createNode<U>(
        nMinX: number, nMinY: number,
        nMaxX: number, nMaxY: number,
        depth: number,
    ): QTNode<U> {
        return {
            minX: nMinX,
            minY: nMinY,
            maxX: nMaxX,
            maxY: nMaxY,
            cx: (nMinX + nMaxX) * 0.5,
            cy: (nMinY + nMaxY) * 0.5,
            depth,
            items: [],
            children: [null, null, null, null],
            split: false,
        };
    }

    /**
     * 将节点分裂为 4 个子节点。
     */
    function splitNode(node: QTNode<T>): void {
        const { minX: nMinX, minY: nMinY, maxX: nMaxX, maxY: nMaxY, cx, cy, depth } = node;
        const d = depth + 1;

        // NW (0): 左上
        node.children[0] = createNode<T>(nMinX, cy, cx, nMaxY, d);
        // NE (1): 右上
        node.children[1] = createNode<T>(cx, cy, nMaxX, nMaxY, d);
        // SW (2): 左下
        node.children[2] = createNode<T>(nMinX, nMinY, cx, cy, d);
        // SE (3): 右下
        node.children[3] = createNode<T>(cx, nMinY, nMaxX, cy, d);

        node.split = true;

        // 将现有项重新分配到子节点
        const items = node.items;
        node.items = [];
        for (let i = 0; i < items.length; i++) {
            insertIntoNode(node, items[i]);
        }
    }

    /**
     * 确定点应该落入哪个象限。
     * 0=NW, 1=NE, 2=SW, 3=SE
     */
    function getQuadrant(node: QTNode<T>, x: number, y: number): number {
        // 左/右由 x 与 cx 的关系决定，上/下由 y 与 cy 的关系决定
        const right = x >= node.cx ? 1 : 0;
        const top = y >= node.cy ? 0 : 2;
        return top + right;
    }

    /**
     * 向节点插入一项。
     */
    function insertIntoNode(node: QTNode<T>, item: QuadTreeItem<T>): void {
        if (node.split) {
            // 已分裂：递归到对应子节点
            const quad = getQuadrant(node, item.x, item.y);
            const child = node.children[quad];
            if (child !== null) {
                insertIntoNode(child, item);
            }
            return;
        }

        // 未分裂：加入项列表
        node.items.push(item);

        // 超过容量且未达最大深度→分裂
        if (node.items.length > maxItemsPerNode && node.depth < MAX_DEPTH) {
            splitNode(node);
        }
    }

    /**
     * 在节点子树中查询匹配项。
     */
    function searchNode(
        node: QTNode<T>,
        sMinX: number, sMinY: number,
        sMaxX: number, sMaxY: number,
        result: QuadTreeItem<T>[],
    ): void {
        // 节点范围与查询范围不重叠→跳过
        if (sMaxX < node.minX || sMaxY < node.minY ||
            sMinX > node.maxX || sMinY > node.maxY) {
            return;
        }

        if (node.split) {
            // 递归搜索子节点
            for (let i = 0; i < 4; i++) {
                const child = node.children[i];
                if (child !== null) {
                    searchNode(child, sMinX, sMinY, sMaxX, sMaxY, result);
                }
            }
        } else {
            // 叶节点：检查每个项是否在查询范围内
            for (let i = 0; i < node.items.length; i++) {
                const item = node.items[i];
                if (item.x >= sMinX && item.x <= sMaxX &&
                    item.y >= sMinY && item.y <= sMaxY) {
                    result.push(item);
                }
            }
        }
    }

    /**
     * 在节点子树中遍历匹配项（无分配版本）。
     */
    function forEachNode(
        node: QTNode<T>,
        sMinX: number, sMinY: number,
        sMaxX: number, sMaxY: number,
        callback: (item: QuadTreeItem<T>) => void,
    ): void {
        // 节点范围与查询范围不重叠→跳过
        if (sMaxX < node.minX || sMaxY < node.minY ||
            sMinX > node.maxX || sMinY > node.maxY) {
            return;
        }

        if (node.split) {
            for (let i = 0; i < 4; i++) {
                const child = node.children[i];
                if (child !== null) {
                    forEachNode(child, sMinX, sMinY, sMaxX, sMaxY, callback);
                }
            }
        } else {
            for (let i = 0; i < node.items.length; i++) {
                const item = node.items[i];
                if (item.x >= sMinX && item.x <= sMaxX &&
                    item.y >= sMinY && item.y <= sMaxY) {
                    callback(item);
                }
            }
        }
    }

    /**
     * 从节点子树中删除一项。
     */
    function removeFromNode(
        node: QTNode<T>,
        x: number, y: number, data: T,
    ): boolean {
        // 点不在节点范围内→跳过
        if (x < node.minX || x > node.maxX || y < node.minY || y > node.maxY) {
            return false;
        }

        if (node.split) {
            const quad = getQuadrant(node, x, y);
            const child = node.children[quad];
            if (child !== null) {
                return removeFromNode(child, x, y, data);
            }
            return false;
        }

        // 叶节点：查找并删除
        for (let i = 0; i < node.items.length; i++) {
            if (node.items[i].data === data &&
                node.items[i].x === x &&
                node.items[i].y === y) {
                node.items.splice(i, 1);
                return true;
            }
        }

        return false;
    }

    // ======================== QuadTree 实例 ========================

    const tree: QuadTree<T> = {
        insert(x: number, y: number, data: T): void {
            const item: QuadTreeItem<T> = { x, y, data };
            insertIntoNode(root, item);
            itemCount++;
        },

        search(
            sMinX: number, sMinY: number,
            sMaxX: number, sMaxY: number,
        ): QuadTreeItem<T>[] {
            const result: QuadTreeItem<T>[] = [];
            searchNode(root, sMinX, sMinY, sMaxX, sMaxY, result);
            return result;
        },

        remove(x: number, y: number, data: T): boolean {
            const found = removeFromNode(root, x, y, data);
            if (found) {
                itemCount--;
            }
            return found;
        },

        forEachInBBox(
            fMinX: number, fMinY: number,
            fMaxX: number, fMaxY: number,
            callback: (item: QuadTreeItem<T>) => void,
        ): void {
            forEachNode(root, fMinX, fMinY, fMaxX, fMaxY, callback);
        },

        clear(): void {
            root = createNode<T>(minX, minY, maxX, maxY, 0);
            itemCount = 0;
        },

        get size(): number {
            return itemCount;
        },
    };

    return tree;
}

declare const __DEV__: boolean;
