// ============================================================
// math/bbox.ts — 2D/3D 包围盒（Bounding Box）
// BBox2D 是 L0 的共享类型，被 L1~L6 全局引用
// 使用 interface 而非 TypedArray，因为包围盒是语义化数据结构
// ============================================================

/**
 * 2D 轴对齐包围盒（AABB）。
 * 在 GIS 上下文中表示经纬度范围，在屏幕/瓦片上下文中表示像素/坐标范围。
 * 这是全局共享类型的唯一定义位置，L1~L6 全部从此处 import。
 */
export interface BBox2D {
    /** 最小经度 / 最小 X（度或米） */
    readonly west: number;
    /** 最小纬度 / 最小 Y（度或米） */
    readonly south: number;
    /** 最大经度 / 最大 X（度或米） */
    readonly east: number;
    /** 最大纬度 / 最大 Y（度或米） */
    readonly north: number;
}

/**
 * 3D 轴对齐包围盒，在 2D 基础上增加高度范围。
 * 用于 3D 场景中的建筑、地形等具有高度信息的对象。
 */
export interface BBox3D extends BBox2D {
    /** 最小海拔（米） */
    readonly minAlt: number;
    /** 最大海拔（米） */
    readonly maxAlt: number;
}

/**
 * 创建一个 2D 包围盒。
 *
 * @param west - 最小经度/X
 * @param south - 最小纬度/Y
 * @param east - 最大经度/X
 * @param north - 最大纬度/Y
 * @returns 新的 BBox2D 对象
 *
 * @example
 * const bbox = create2D(-180, -90, 180, 90); // 全球范围
 */
export function create2D(west: number, south: number, east: number, north: number): BBox2D {
    return { west, south, east, north };
}

/**
 * 创建一个 3D 包围盒。
 *
 * @param west - 最小经度/X
 * @param south - 最小纬度/Y
 * @param east - 最大经度/X
 * @param north - 最大纬度/Y
 * @param minAlt - 最小海拔（米）
 * @param maxAlt - 最大海拔（米）
 * @returns 新的 BBox3D 对象
 *
 * @example
 * const bbox = create3D(116.3, 39.9, 116.5, 40.0, 0, 500);
 */
export function create3D(
    west: number, south: number, east: number, north: number,
    minAlt: number, maxAlt: number,
): BBox3D {
    return { west, south, east, north, minAlt, maxAlt };
}

/**
 * 计算两个 2D 包围盒的并集（最小外接矩形）。
 * 返回能包含 a 和 b 的最小包围盒。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @returns 新的包含两者的 BBox2D
 *
 * @example
 * const merged = union2D(bboxA, bboxB);
 */
export function union2D(a: BBox2D, b: BBox2D): BBox2D {
    // 取各方向的最小/最大值
    return {
        west: Math.min(a.west, b.west),
        south: Math.min(a.south, b.south),
        east: Math.max(a.east, b.east),
        north: Math.max(a.north, b.north),
    };
}

/**
 * 计算两个 2D 包围盒的交集。
 * 若不相交，返回的 BBox2D 中 west > east 或 south > north（空盒）。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @returns 交集 BBox2D（可能为空盒）
 *
 * @example
 * const overlap = intersect2D(bboxA, bboxB);
 * if (isEmpty2D(overlap)) console.log('不相交');
 */
export function intersect2D(a: BBox2D, b: BBox2D): BBox2D {
    // 取各方向的交叉范围
    return {
        west: Math.max(a.west, b.west),
        south: Math.max(a.south, b.south),
        east: Math.min(a.east, b.east),
        north: Math.min(a.north, b.north),
    };
}

/**
 * 判断包围盒 a 是否完全包含包围盒 b。
 *
 * @param a - 外部包围盒
 * @param b - 内部包围盒
 * @returns 若 a 完全包含 b 则为 true
 *
 * @example
 * contains2D(worldBBox, tileBBox); // true if tile within world
 */
export function contains2D(a: BBox2D, b: BBox2D): boolean {
    // a 的每个边界都必须不比 b 更严格
    return a.west <= b.west
        && a.south <= b.south
        && a.east >= b.east
        && a.north >= b.north;
}

/**
 * 判断 2D 包围盒是否包含给定点。
 *
 * @param bbox - 包围盒
 * @param x - 点的 X 坐标（经度）
 * @param y - 点的 Y 坐标（纬度）
 * @returns 若点在包围盒内或边界上则为 true
 *
 * @example
 * containsPoint2D(bbox, 116.4, 39.9); // 北京坐标
 */
export function containsPoint2D(bbox: BBox2D, x: number, y: number): boolean {
    // 闭区间检查：边界上的点也算包含
    return x >= bbox.west && x <= bbox.east
        && y >= bbox.south && y <= bbox.north;
}

/**
 * 向四个方向均匀扩展包围盒。
 *
 * @param bbox - 原始包围盒
 * @param amount - 扩展量（正值外扩，负值内缩）
 * @returns 新的扩展后 BBox2D
 *
 * @example
 * const padded = expand2D(bbox, 0.01); // 各方向扩展 0.01 度
 */
export function expand2D(bbox: BBox2D, amount: number): BBox2D {
    return {
        west: bbox.west - amount,
        south: bbox.south - amount,
        east: bbox.east + amount,
        north: bbox.north + amount,
    };
}

/**
 * 计算包围盒的中心点。
 *
 * @param bbox - 输入包围盒
 * @returns 中心点 [x, y]（二元数组）
 *
 * @example
 * const [cx, cy] = center2D(bbox);
 */
export function center2D(bbox: BBox2D): [number, number] {
    // 取各轴的中点
    return [
        (bbox.west + bbox.east) * 0.5,
        (bbox.south + bbox.north) * 0.5,
    ];
}

/**
 * 计算包围盒的尺寸（宽度和高度）。
 *
 * @param bbox - 输入包围盒
 * @returns [width, height] 二元数组
 *
 * @example
 * const [w, h] = size2D(bbox);
 */
export function size2D(bbox: BBox2D): [number, number] {
    return [
        bbox.east - bbox.west,
        bbox.north - bbox.south,
    ];
}

/**
 * 从一组 2D 点构建最小包围盒。
 * 遍历所有点找到各轴的极值。
 *
 * @param points - 平铺的坐标数组 [x1, y1, x2, y2, ...]
 * @returns 包含所有点的最小 BBox2D，若点数为 0 返回空盒
 *
 * @example
 * const bbox = fromPoints2D([0, 0, 10, 5, -3, 8]);
 * // bbox = { west: -3, south: 0, east: 10, north: 8 }
 */
export function fromPoints2D(points: ArrayLike<number>): BBox2D {
    const count = points.length;
    if (count < 2) {
        // 无点时返回"反转极值"空盒
        return { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    }

    // 初始化为第一个点的坐标
    let west = points[0];
    let south = points[1];
    let east = points[0];
    let north = points[1];

    // 遍历剩余点，更新极值（每次步进 2 个元素）
    for (let i = 2; i < count; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        if (x < west) west = x;
        if (x > east) east = x;
        if (y < south) south = y;
        if (y > north) north = y;
    }

    return { west, south, east, north };
}

/**
 * 判断包围盒是否为空（无效）。
 * 空盒的特征是 west > east 或 south > north。
 *
 * @param bbox - 输入包围盒
 * @returns 若为空盒则为 true
 *
 * @example
 * isEmpty2D({ west: 10, south: 0, east: 5, north: 10 }); // true（west > east）
 */
export function isEmpty2D(bbox: BBox2D): boolean {
    // 只要任一轴的最小值大于最大值，就是空盒
    return bbox.west > bbox.east || bbox.south > bbox.north;
}

/**
 * 判断两个包围盒是否相等（精确比较）。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @param epsilon - 容差阈值，默认 1e-10
 * @returns 若所有边界差值均 ≤ epsilon 则为 true
 *
 * @example
 * equals2D(bboxA, bboxB);
 */
export function equals2D(a: BBox2D, b: BBox2D, epsilon = 1e-10): boolean {
    // 逐字段比较
    return Math.abs(a.west - b.west) <= epsilon
        && Math.abs(a.south - b.south) <= epsilon
        && Math.abs(a.east - b.east) <= epsilon
        && Math.abs(a.north - b.north) <= epsilon;
}

/**
 * 计算 2D 包围盒的面积。
 * 若包围盒为空则返回 0。
 *
 * @param bbox - 输入包围盒
 * @returns 面积（非负），单位取决于坐标系（度²或米²）
 *
 * @example
 * area2D({ west: 0, south: 0, east: 10, north: 5 }); // 50
 */
export function area2D(bbox: BBox2D): number {
    // 宽度 × 高度，空盒返回 0
    const w = bbox.east - bbox.west;
    const h = bbox.north - bbox.south;
    if (w < 0 || h < 0) {
        // 空盒面积为 0
        return 0;
    }
    return w * h;
}

/**
 * 判断两个 2D 包围盒是否有重叠。
 * 比 intersect2D + isEmpty2D 更高效（无需创建中间对象）。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @returns 若有重叠（包括边界相切）则为 true
 *
 * @example
 * overlap2D(bboxA, bboxB); // 快速相交测试
 */
export function overlap2D(a: BBox2D, b: BBox2D): boolean {
    // 分离轴测试：只要在任一轴上不重叠就不相交
    // 不相交条件：a 的右边在 b 的左边之左，或 a 的上边在 b 的下边之下，etc.
    return a.west <= b.east
        && a.east >= b.west
        && a.south <= b.north
        && a.north >= b.south;
}
