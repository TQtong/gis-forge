// ============================================================
// index/grid-index.ts — 均匀网格空间索引
// 将空间分割为固定大小的网格单元，O(1) 查找。
// 适用于均匀分布的数据（如标注碰撞检测、粒子系统）。
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 公共接口 ========================

/**
 * 网格索引接口。
 * 支持插入、矩形查询、清空和动态调整网格大小。
 */
export interface GridIndex<T = unknown> {
    /**
     * 插入一个带坐标和包围盒的数据项。
     *
     * @param item - 要插入的项（需要包含 minX/minY/maxX/maxY）
     */
    insert(item: GridItem<T>): void;

    /**
     * 查询与给定矩形范围重叠的所有数据项。
     *
     * @param minX - 查询范围最小 x
     * @param minY - 查询范围最小 y
     * @param maxX - 查询范围最大 x
     * @param maxY - 查询范围最大 y
     * @returns 与查询范围重叠的项数组
     */
    query(minX: number, minY: number, maxX: number, maxY: number): GridItem<T>[];

    /** 清空所有数据 */
    clear(): void;

    /**
     * 调整网格单元大小并重建索引。
     * 所有已插入的数据将被清空。
     *
     * @param cellSize - 新的网格单元大小
     */
    resize(cellSize: number): void;

    /** 当前存储的项数 */
    readonly size: number;
}

/**
 * 网格索引中的数据项。
 * 使用 AABB 包围盒表示空间范围。
 */
export interface GridItem<T = unknown> {
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

// ======================== 工厂函数 ========================

/**
 * 创建一个均匀网格空间索引。
 *
 * 网格将空间分为固定大小的单元格，每个单元格存储与之重叠的数据项。
 * 查询时只检查与查询范围重叠的单元格，实现 O(1) 平均查找时间（数据均匀分布时）。
 *
 * @param cellSize - 网格单元大小。应选择与数据密度匹配的值——
 *                   太大则每个单元格存储过多项；太小则需要检查过多单元格。
 *                   经验法则：cellSize ≈ 查询范围的典型大小。
 * @returns 网格索引实例
 *
 * @example
 * const grid = createGridIndex<string>(10);
 * grid.insert({ minX: 5, minY: 5, maxX: 8, maxY: 8, data: "a" });
 * grid.insert({ minX: 15, minY: 15, maxX: 18, maxY: 18, data: "b" });
 * grid.query(0, 0, 10, 10); // [{ ..., data: "a" }]
 */
export function createGridIndex<T = unknown>(cellSize: number): GridIndex<T> {
    // 确保单元格大小为正数
    let cs = Math.max(1e-6, cellSize);
    // 倒数缓存，避免频繁除法
    let invCellSize = 1.0 / cs;

    // 用 Map 存储网格：key = 行列编码字符串，value = 项数组
    // 使用字符串键因为 JavaScript 的 Map 对数值键不做哈希优化
    let cells = new Map<string, GridItem<T>[]>();
    let itemCount = 0;

    /**
     * 将世界坐标转换为网格行列号。
     * 使用 floor 确保负坐标也能正确映射。
     *
     * @param v - 坐标值
     * @returns 网格索引
     */
    function toCell(v: number): number {
        return Math.floor(v * invCellSize);
    }

    /**
     * 将行列号编码为 Map 键。
     *
     * @param col - 列号
     * @param row - 行号
     * @returns 编码字符串
     */
    function cellKey(col: number, row: number): string {
        return `${col}:${row}`;
    }

    const grid: GridIndex<T> = {
        insert(item: GridItem<T>): void {
            // 计算项的包围盒覆盖的网格范围
            const colMin = toCell(item.minX);
            const colMax = toCell(item.maxX);
            const rowMin = toCell(item.minY);
            const rowMax = toCell(item.maxY);

            // 将项添加到所有覆盖的网格单元中
            for (let col = colMin; col <= colMax; col++) {
                for (let row = rowMin; row <= rowMax; row++) {
                    const key = cellKey(col, row);
                    let cell = cells.get(key);
                    if (cell === undefined) {
                        cell = [];
                        cells.set(key, cell);
                    }
                    cell.push(item);
                }
            }

            itemCount++;
        },

        query(
            qMinX: number, qMinY: number,
            qMaxX: number, qMaxY: number,
        ): GridItem<T>[] {
            // 计算查询范围覆盖的网格范围
            const colMin = toCell(qMinX);
            const colMax = toCell(qMaxX);
            const rowMin = toCell(qMinY);
            const rowMax = toCell(qMaxY);

            const result: GridItem<T>[] = [];

            // 用 Set 去重（同一项可能存在于多个单元格中）
            const seen = new Set<GridItem<T>>();

            // 遍历所有覆盖的网格单元
            for (let col = colMin; col <= colMax; col++) {
                for (let row = rowMin; row <= rowMax; row++) {
                    const key = cellKey(col, row);
                    const cell = cells.get(key);
                    if (cell === undefined) continue;

                    // 检查单元格内每个项是否与查询范围重叠
                    for (let i = 0; i < cell.length; i++) {
                        const item = cell[i];

                        // 跳过已处理的项（去重）
                        if (seen.has(item)) continue;
                        seen.add(item);

                        // AABB 重叠测试
                        if (item.maxX >= qMinX && item.maxY >= qMinY &&
                            item.minX <= qMaxX && item.minY <= qMaxY) {
                            result.push(item);
                        }
                    }
                }
            }

            return result;
        },

        clear(): void {
            cells.clear();
            itemCount = 0;
        },

        resize(newCellSize: number): void {
            // 更新单元格大小
            cs = Math.max(1e-6, newCellSize);
            invCellSize = 1.0 / cs;
            // 清空重建
            cells = new Map<string, GridItem<T>[]>();
            itemCount = 0;
        },

        get size(): number {
            return itemCount;
        },
    };

    return grid;
}

declare const __DEV__: boolean;
