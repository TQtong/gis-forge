// ============================================================
// index/spatial-hash.ts — 空间哈希网格（完整自研实现）
// 将 2D 空间划分为等大的单元格网格，每个单元格维护一个元素列表。
// 适合均匀分布的数据（如标注碰撞检测），查询性能 O(1) 到 O(k)。
// 零外部依赖。
// ============================================================

// ======================== 公共接口 ========================

/**
 * 空间哈希网格接口。
 * 将 2D 空间分割为等大的正方形单元格，支持快速矩形范围查询。
 * 适合数据分布比较均匀的场景（如屏幕空间碰撞检测）。
 * 对于非均匀分布的数据，建议使用 R-Tree。
 */
export interface SpatialHash<T> {
    /**
     * 插入一个带包围盒的数据项。
     * 数据项会被注册到所有与其包围盒重叠的单元格中。
     *
     * @param minX - 包围盒最小 x
     * @param minY - 包围盒最小 y
     * @param maxX - 包围盒最大 x
     * @param maxY - 包围盒最大 y
     * @param data - 关联数据
     */
    insert(minX: number, minY: number, maxX: number, maxY: number, data: T): void;

    /**
     * 矩形范围查询：返回所有包围盒与查询矩形重叠的数据。
     * 注意：结果可能包含重复项（当一个项跨越多个单元格时），
     * 内部已做去重处理。
     *
     * @param minX - 查询矩形最小 x
     * @param minY - 查询矩形最小 y
     * @param maxX - 查询矩形最大 x
     * @param maxY - 查询矩形最大 y
     * @returns 与查询矩形重叠的所有数据
     */
    query(minX: number, minY: number, maxX: number, maxY: number): T[];

    /** 清空所有数据 */
    clear(): void;

    /**
     * 以新的单元格大小重新初始化网格。
     * 已有的数据会被清空。
     *
     * @param newCellSize - 新的单元格边长
     */
    resize(newCellSize: number): void;
}

// ======================== 内部类型 ========================

/**
 * 空间哈希中存储的条目，包含包围盒和数据引用。
 * 用唯一 ID 标识，避免跨单元格查询时的重复。
 */
interface HashEntry<T> {
    /** 唯一标识符，用于去重 */
    readonly id: number;

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
 * 创建一个空间哈希网格。
 * 空间哈希将无限 2D 平面分割为边长为 cellSize 的正方形单元格，
 * 使用哈希表存储每个单元格内的元素。
 *
 * 性能特点：
 * - 插入 O(k)，k = 项覆盖的单元格数
 * - 查询 O(k)，k = 查询矩形覆盖的单元格数 + 命中元素数
 * - 内存与已使用单元格数成正比（未使用的单元格不占内存）
 *
 * @param cellSize - 单元格边长，应约等于数据项的平均大小。
 *                   太小导致大项覆盖太多单元格，太大导致查询不精确。
 * @returns 新的空间哈希实例
 *
 * @example
 * const hash = createSpatialHash<string>(100);
 * hash.insert(50, 50, 150, 150, "building");
 * const results = hash.query(0, 0, 200, 200); // → ["building"]
 */
export function createSpatialHash<T>(cellSize: number): SpatialHash<T> {
    // 确保 cellSize 为正数
    if (cellSize <= 0 || !Number.isFinite(cellSize)) {
        cellSize = 1;
    }

    // 单元格边长和倒数（避免除法）
    let currentCellSize = cellSize;
    let invCellSize = 1.0 / currentCellSize;

    // 哈希表：key = 单元格哈希值，value = 该单元格中的条目数组
    let grid = new Map<number, HashEntry<T>[]>();

    // 条目 ID 计数器，用于去重
    let nextId = 0;

    /**
     * 将 2D 网格坐标哈希为单个数字。
     * 使用大质数哈希避免碰撞，同时保持整数运算（位运算快）。
     *
     * @param cx - 单元格 x 索引
     * @param cy - 单元格 y 索引
     * @returns 哈希值
     */
    function hashCell(cx: number, cy: number): number {
        // 使用 Cantor 配对函数的变体：
        // 先位运算转为无符号整数再组合，避免负数索引问题
        // 两个大质数确保低碰撞率
        const h = (cx * 73856093) ^ (cy * 19349663);
        return h;
    }

    /**
     * 将世界坐标转换为单元格索引。
     * 使用 Math.floor 确保负坐标也能正确映射。
     *
     * @param coord - 世界坐标
     * @returns 单元格索引
     */
    function toCellIndex(coord: number): number {
        return Math.floor(coord * invCellSize);
    }

    const hash: SpatialHash<T> = {
        insert(minX: number, minY: number, maxX: number, maxY: number, data: T): void {
            // NaN / Infinity 检查
            if (!Number.isFinite(minX) || !Number.isFinite(minY) ||
                !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
                return;
            }

            // 确保 min <= max
            if (minX > maxX) { const t = minX; minX = maxX; maxX = t; }
            if (minY > maxY) { const t = minY; minY = maxY; maxY = t; }

            // 创建条目
            const entry: HashEntry<T> = {
                id: nextId++,
                minX, minY, maxX, maxY,
                data,
            };

            // 计算包围盒覆盖的单元格范围
            const cellMinX = toCellIndex(minX);
            const cellMinY = toCellIndex(minY);
            const cellMaxX = toCellIndex(maxX);
            const cellMaxY = toCellIndex(maxY);

            // 将条目注册到所有覆盖的单元格
            for (let cx = cellMinX; cx <= cellMaxX; cx++) {
                for (let cy = cellMinY; cy <= cellMaxY; cy++) {
                    const key = hashCell(cx, cy);
                    let bucket = grid.get(key);
                    if (bucket === undefined) {
                        // 第一次使用该单元格，创建桶
                        bucket = [];
                        grid.set(key, bucket);
                    }
                    bucket.push(entry);
                }
            }
        },

        query(minX: number, minY: number, maxX: number, maxY: number): T[] {
            const result: T[] = [];

            // NaN / Infinity 检查
            if (!Number.isFinite(minX) || !Number.isFinite(minY) ||
                !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
                return result;
            }

            // 确保 min <= max
            if (minX > maxX) { const t = minX; minX = maxX; maxX = t; }
            if (minY > maxY) { const t = minY; minY = maxY; maxY = t; }

            // 计算查询矩形覆盖的单元格范围
            const cellMinX = toCellIndex(minX);
            const cellMinY = toCellIndex(minY);
            const cellMaxX = toCellIndex(maxX);
            const cellMaxY = toCellIndex(maxY);

            // 去重集合：记录已添加条目的 ID
            const seen = new Set<number>();

            // 遍历所有覆盖的单元格
            for (let cx = cellMinX; cx <= cellMaxX; cx++) {
                for (let cy = cellMinY; cy <= cellMaxY; cy++) {
                    const key = hashCell(cx, cy);
                    const bucket = grid.get(key);
                    if (bucket === undefined) continue;

                    // 检查桶中的每个条目
                    for (let i = 0; i < bucket.length; i++) {
                        const entry = bucket[i];

                        // 跳过已见过的条目（去重）
                        if (seen.has(entry.id)) continue;
                        seen.add(entry.id);

                        // 精确的包围盒重叠检测
                        if (
                            entry.maxX >= minX && entry.maxY >= minY &&
                            entry.minX <= maxX && entry.minY <= maxY
                        ) {
                            result.push(entry.data);
                        }
                    }
                }
            }

            return result;
        },

        clear(): void {
            grid.clear();
            nextId = 0;
        },

        resize(newCellSize: number): void {
            // 确保新大小有效
            if (newCellSize <= 0 || !Number.isFinite(newCellSize)) {
                newCellSize = 1;
            }

            currentCellSize = newCellSize;
            invCellSize = 1.0 / currentCellSize;

            // 清空现有数据（调用者需要重新插入）
            grid = new Map();
            nextId = 0;
        },
    };

    return hash;
}
