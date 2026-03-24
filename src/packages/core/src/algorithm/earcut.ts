// ============================================================
// algorithm/earcut.ts — Ear-clipping 三角剖分算法（完整自研实现）
// 支持带岛洞的复杂多边形，使用 z-order 曲线加速大多边形处理。
// 时间复杂度 O(n²) 最坏，O(n log n) 平均（z-order 优化后）。
// 零外部依赖，所有算法自研。
// ============================================================

// ======================== 常量定义 ========================

/** z-order 曲线坐标量化位数（2^15 = 32768 个格子，足够 16 位精度） */
const Z_ORDER_BITS = 15;

/** z-order 坐标最大值（2^15 = 32768），用于将浮点坐标归一化到整数网格 */
const Z_ORDER_MAX = 1 << Z_ORDER_BITS;

// ======================== 双向链表节点 ========================

/**
 * 双向链表节点，表示多边形顶点。
 * 使用链表而非数组可以在 O(1) 时间内删除耳朵顶点，
 * 并方便桥接孔洞时的节点插入操作。
 */
class Node {
    /** 顶点在原始 data 数组中的索引（除以 dim 得到顶点序号） */
    readonly i: number;

    /** 顶点 x 坐标 */
    readonly x: number;

    /** 顶点 y 坐标 */
    readonly y: number;

    /** 前驱节点（双向链表） */
    prev: Node;

    /** 后继节点（双向链表） */
    next: Node;

    /** z-order 曲线值，用于空间哈希加速点在三角形内检测 */
    z: number;

    /** z-order 链表前驱（按 z-order 值排序的辅助链表） */
    prevZ: Node | null;

    /** z-order 链表后继 */
    nextZ: Node | null;

    /** 是否为 Steiner 点（桥接孔洞时创建的额外顶点） */
    steiner: boolean;

    /**
     * 构造双向链表节点。
     *
     * @param i - 顶点在平铺数组中的起始索引
     * @param x - 顶点 x 坐标
     * @param y - 顶点 y 坐标
     */
    constructor(i: number, x: number, y: number) {
        this.i = i;
        this.x = x;
        this.y = y;

        // 链表指针初始化为自身，后续由构建函数设置
        this.prev = this;
        this.next = this;

        // z-order 相关字段
        this.z = 0;
        this.prevZ = null;
        this.nextZ = null;

        // 非 Steiner 点
        this.steiner = false;
    }
}

// ======================== 公共 API ========================

/**
 * 将平铺坐标数组表示的多边形（可含孔洞）三角剖分为三角形索引数组。
 * 使用 ear-clipping 算法：迭代寻找并切除"耳朵"三角形，
 * 对大多边形使用 z-order 曲线空间哈希加速点在三角形内的检测。
 *
 * @param data - 平铺的顶点坐标数组 [x1,y1, x2,y2, ...] 或 [x1,y1,z1, x2,y2,z2, ...]
 * @param holeIndices - 孔洞起始顶点索引数组 [h1Start, h2Start, ...]，
 *                      每个值是 data 中孔洞第一个顶点的序号（非坐标索引）
 * @param dim - 每个顶点的维度（默认 2），3D 坐标时取前两维做 2D 投影剖分
 * @returns 三角形顶点索引数组 [i1,i2,i3, i4,i5,i6, ...]，
 *          每三个连续索引构成一个三角形。索引为顶点序号（data 索引 / dim）。
 *
 * @example
 * // 简单三角形
 * const tri = earcut([0,0, 1,0, 0,1]); // → [0, 1, 2] 或等效排列
 *
 * @example
 * // 带孔洞的正方形
 * const sq = earcut([0,0, 4,0, 4,4, 0,4,  1,1, 3,1, 3,3, 1,3], [4]);
 */
export function earcut(
    data: ArrayLike<number>,
    holeIndices?: number[],
    dim: number = 2,
): number[] {
    // 边界检查：数据长度不足一个三角形
    const hasHoles = holeIndices !== undefined && holeIndices !== null && holeIndices.length > 0;
    const outerLen = hasHoles ? holeIndices![0] * dim : data.length;

    // 至少需要 3 个顶点才能形成三角形
    if (outerLen < dim * 3) {
        return [];
    }

    // 结果三角形索引数组
    const triangles: number[] = [];

    // 步骤 1：将外环顶点构建为双向链表
    let outerNode = linkedList(data, 0, outerLen, dim, true);

    // 空链表说明多边形退化
    if (outerNode === null || outerNode.next === outerNode.prev) {
        return triangles;
    }

    // 步骤 2：如果有孔洞，桥接孔洞到外环
    if (hasHoles) {
        outerNode = eliminateHoles(data, holeIndices!, outerNode, dim);
    }

    // 步骤 3：计算包围盒，用于 z-order 坐标归一化
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let invSize = 0;

    // 当多边形顶点数超过 80 时启用 z-order 加速
    if (data.length > 80 * dim) {
        // 遍历外环计算包围盒
        for (let i = 0; i < outerLen; i += dim) {
            const x = data[i];
            const y = data[i + 1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        // invSize 用于将坐标归一化到 [0, Z_ORDER_MAX) 整数范围
        invSize = Math.max(maxX - minX, maxY - minY);
        invSize = invSize !== 0 ? Z_ORDER_MAX / invSize : 0;
    }

    // 步骤 4：执行耳朵裁剪
    earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);

    return triangles;
}

/**
 * 将嵌套的 GeoJSON 风格坐标数组展平为 earcut 所需的平铺格式。
 * GeoJSON Polygon 的 coordinates 格式为 [[[x,y], [x,y], ...], [[hx,hy], ...]]，
 * 第一个子数组为外环，后续为孔洞环。
 *
 * @param data - 嵌套坐标数组 [外环, 孔洞1, 孔洞2, ...]，
 *               每个环为 [[x,y], [x,y], ...] 或 [[x,y,z], ...]
 * @returns 展平结果：
 *   - vertices: 平铺坐标 [x1,y1, x2,y2, ...]
 *   - holes: 孔洞起始顶点索引数组
 *   - dimensions: 检测到的坐标维度
 *
 * @example
 * const polygon = [[[0,0],[4,0],[4,4],[0,4]], [[1,1],[3,1],[3,3],[1,3]]];
 * const { vertices, holes, dimensions } = flatten(polygon);
 * const triangles = earcut(vertices, holes, dimensions);
 */
export function flatten(
    data: number[][][],
): { vertices: number[]; holes: number[]; dimensions: number } {
    // 边界检查：空数组
    if (data.length === 0) {
        return { vertices: [], holes: [], dimensions: 2 };
    }

    // 从第一个环的第一个坐标推断维度
    const dim = data[0].length > 0 ? data[0][0].length : 2;

    const result: { vertices: number[]; holes: number[]; dimensions: number } = {
        vertices: [],
        holes: [],
        dimensions: dim,
    };

    // 累计顶点数，用于计算孔洞的起始索引
    let holeIndex = 0;

    for (let i = 0; i < data.length; i++) {
        // 遍历每个环中的每个顶点
        for (let j = 0; j < data[i].length; j++) {
            // 将每个维度的坐标平铺到 vertices 数组
            for (let d = 0; d < dim; d++) {
                result.vertices.push(data[i][j][d]);
            }
        }
        // 第一个环（索引 0）为外环，不记入 holes；从第二个环开始记为孔洞
        if (i > 0) {
            holeIndex += data[i - 1].length;
            result.holes.push(holeIndex);
        }
    }

    return result;
}

/**
 * 计算三角剖分结果与原始多边形面积之间的偏差。
 * 返回值为归一化偏差：|多边形面积 - 三角形面积之和| / 多边形面积。
 * 理想三角剖分返回 0，值越大说明剖分质量越差。
 *
 * @param data - 平铺的顶点坐标数组（与 earcut 输入相同）
 * @param holeIndices - 孔洞起始顶点索引数组
 * @param dim - 每个顶点的维度
 * @param triangles - earcut 返回的三角形索引数组
 * @returns 归一化面积偏差（0 = 完美，>0 = 有误差）
 *
 * @example
 * const data = [0,0, 4,0, 4,4, 0,4];
 * const tri = earcut(data);
 * const dev = deviation(data, undefined, 2, tri); // 应接近 0
 */
export function deviation(
    data: ArrayLike<number>,
    holeIndices: number[] | undefined,
    dim: number,
    triangles: number[],
): number {
    // 边界：无三角形或无数据
    if (triangles.length === 0 || data.length === 0) {
        return 0;
    }

    const hasHoles = holeIndices !== undefined && holeIndices !== null && holeIndices.length > 0;

    // 步骤 1：计算所有三角形面积之和
    let trianglesArea = 0;
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i] * dim;
        const b = triangles[i + 1] * dim;
        const c = triangles[i + 2] * dim;
        // 使用叉积计算三角形面积（无符号）
        trianglesArea += Math.abs(
            (data[a] - data[c]) * (data[b + 1] - data[a + 1]) -
            (data[a] - data[b]) * (data[c + 1] - data[a + 1]),
        );
    }

    // 步骤 2：计算多边形面积（外环面积 - 孔洞面积之和）
    let polygonArea = 0;

    // 外环面积
    const outerLen = hasHoles ? holeIndices![0] * dim : data.length;
    polygonArea += Math.abs(signedArea(data, 0, outerLen, dim));

    // 减去孔洞面积
    if (hasHoles) {
        for (let i = 0; i < holeIndices!.length; i++) {
            const start = holeIndices![i] * dim;
            const end = i < holeIndices!.length - 1 ? holeIndices![i + 1] * dim : data.length;
            polygonArea -= Math.abs(signedArea(data, start, end, dim));
        }
    }

    // 步骤 3：如果多边形面积为 0，返回 0（退化多边形）
    if (polygonArea === 0 && trianglesArea === 0) {
        return 0;
    }

    // 返回归一化偏差：面积差 / 多边形面积
    return Math.abs((trianglesArea - polygonArea) / polygonArea);
}

// ======================== 内部实现函数 ========================

/**
 * 将坐标序列构建为双向循环链表。
 * 根据 clockwise 参数决定链表方向——外环逆时针（正面积），孔洞顺时针（负面积）。
 *
 * @param data - 平铺坐标数组
 * @param start - 起始坐标索引
 * @param end - 结束坐标索引（不含）
 * @param dim - 顶点维度
 * @param clockwise - 是否按顺时针方向构建（外环 true → 实际按正面积方向）
 * @returns 链表头节点，或 null（顶点不足）
 */
function linkedList(
    data: ArrayLike<number>,
    start: number,
    end: number,
    dim: number,
    clockwise: boolean,
): Node | null {
    let last: Node | null = null;

    // 根据环的绕向决定遍历方向：外环需要逆时针（CCW）排列
    if (clockwise === (signedArea(data, start, end, dim) > 0)) {
        // 正序插入
        for (let i = start; i < end; i += dim) {
            last = insertNode(i, data[i], data[i + 1], last);
        }
    } else {
        // 逆序插入，翻转绕向
        for (let i = end - dim; i >= start; i -= dim) {
            last = insertNode(i, data[i], data[i + 1], last);
        }
    }

    // 如果首尾顶点重合（闭合多边形），移除重复的最后一个节点
    if (last !== null && equals(last, last.next)) {
        removeNode(last);
        last = last.next;
    }

    // 空链表或只有一个节点时返回 null
    if (last === null) return null;
    if (last === last.next) return null;

    return last;
}

/**
 * 消除所有孔洞：将每个孔洞通过"桥接边"连接到外环。
 * 算法：对每个孔洞找到最右侧点，从该点向外环发射水平射线，
 * 找到与外环最近的"可见点"，然后在两点之间建立桥接。
 *
 * @param data - 平铺坐标数组
 * @param holeIndices - 孔洞起始顶点索引数组
 * @param outerNode - 外环链表头节点
 * @param dim - 顶点维度
 * @returns 合并后的链表头节点
 */
function eliminateHoles(
    data: ArrayLike<number>,
    holeIndices: number[],
    outerNode: Node,
    dim: number,
): Node {
    // 收集所有孔洞的链表节点
    const queue: Node[] = [];

    for (let i = 0; i < holeIndices.length; i++) {
        const start = holeIndices[i] * dim;
        const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * dim : data.length;

        // 构建孔洞链表（孔洞需要顺时针方向，传 false）
        const list = linkedList(data, start, end, dim, false);

        // 跳过退化孔洞
        if (list === null) continue;

        // 找孔洞中 x 坐标最大的点，用于确定桥接方向
        if (list === list.next) {
            list.steiner = true;
        }
        queue.push(getLeftmost(list));
    }

    // 按 x 坐标从大到小排序，确保先处理最右侧的孔洞
    // 这减少了桥接边交叉的概率
    queue.sort((a, b) => a.x - b.x);

    // 逐个桥接孔洞到外环
    for (let i = 0; i < queue.length; i++) {
        outerNode = eliminateHole(queue[i], outerNode);
    }

    return outerNode;
}

/**
 * 将单个孔洞桥接到外环。
 * 从孔洞的最左点向外环发射水平射线，找到最近可见点建桥。
 *
 * @param hole - 孔洞中 x 最大的节点
 * @param outerNode - 外环链表中的任意节点
 * @returns 外环的更新后头节点
 */
function eliminateHole(hole: Node, outerNode: Node): Node {
    // 找到外环中与孔洞最近的可见点
    const bridge = findHoleBridge(hole, outerNode);
    if (bridge === null) {
        return outerNode;
    }

    // 在桥接点处分裂外环，插入孔洞顶点
    const bridgeReverse = splitPolygon(bridge, hole);

    // 清理可能产生的共线点
    filterPoints(bridgeReverse, bridgeReverse.next);

    return filterPoints(bridge, bridge.next);
}

/**
 * 从孔洞的一个顶点向外环发射水平射线，找到最佳桥接点。
 * 选择标准：射线与外环边相交的最近点，同时该点必须"可见"。
 *
 * @param hole - 孔洞中的一个顶点
 * @param outerNode - 外环链表节点
 * @returns 最佳桥接点，或 null
 */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
    let p = outerNode;
    const hx = hole.x;
    const hy = hole.y;
    let qx = -Infinity;
    let m: Node | null = null;

    // 从外环中找到射线（hole → +x 方向）与外环边的最近交点
    do {
        // 检查边 p→p.next 是否与水平射线 y=hy 相交
        if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
            // 计算交点 x 坐标
            const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
            // 交点必须在孔洞点右侧（射线方向），且比当前最近交点更近
            if (x <= hx && x > qx) {
                qx = x;
                m = p.x < p.next.x ? p : p.next;
                // 精确命中顶点时直接返回
                if (x === hx) return m;
            }
        }
        p = p.next;
    } while (p !== outerNode);

    if (m === null) return null;

    // 如果 qx === hx，说明射线精确命中了一个外环顶点
    // 否则需要检查是否有更优的候选点（在 hole-m 三角形内部）
    const stop = m;
    const mx = m.x;
    const my = m.y;
    let tanMin = Infinity;

    p = m;

    do {
        // 检查外环顶点是否在 hole-m 构成的三角扇区内
        if (
            hx >= p.x && p.x >= mx && hx !== p.x &&
            pointInTriangleInternal(
                hy < my ? hx : qx, hy,
                mx, my,
                hy < my ? qx : hx, hy,
                p.x, p.y,
            )
        ) {
            // 选择角度最小的点（最"可见"的点）
            const tan = Math.abs(hy - p.y) / (hx - p.x);
            if (
                locallyInside(p, hole) &&
                (tan < tanMin || (tan === tanMin && (p.x > m!.x || (p.x === m!.x && sectorContainsSector(m!, p)))))
            ) {
                m = p;
                tanMin = tan;
            }
        }
        p = p.next;
    } while (p !== stop);

    return m;
}

/**
 * 检查从节点 m 到节点 p 的方向是否在 m 所在扇区内。
 * 用于桥接点选择时的角度比较。
 *
 * @param m - 当前最佳桥接候选
 * @param p - 新候选点
 * @returns p 是否在 m 的扇区内
 */
function sectorContainsSector(m: Node, p: Node): boolean {
    return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

/**
 * 主耳朵裁剪循环。
 * 遍历链表寻找"耳朵"（当前顶点与前后两个顶点构成的三角形内部无其他顶点），
 * 找到后切除并记录三角形索引。
 *
 * @param ear - 链表中的某个起始节点
 * @param triangles - 输出三角形索引数组
 * @param dim - 顶点维度
 * @param minX - 包围盒最小 x（z-order 用）
 * @param minY - 包围盒最小 y（z-order 用）
 * @param invSize - 坐标归一化因子（z-order 用）
 * @param pass - 当前处理阶段（0=基本, 1=过滤共线, 2=分裂重试）
 */
function earcutLinked(
    ear: Node | null,
    triangles: number[],
    dim: number,
    minX: number,
    minY: number,
    invSize: number,
    pass: number,
): void {
    if (ear === null) return;

    // 第一轮处理前，如果启用了 z-order 优化，先计算所有节点的 z 值
    if (pass === 0 && invSize !== 0) {
        indexCurve(ear, minX, minY, invSize);
    }

    let stop = ear;
    let prev: Node;
    let next: Node;

    // 循环遍历链表，尝试切除每个耳朵
    while (ear!.prev !== ear!.next) {
        prev = ear!.prev;
        next = ear!.next;

        if (invSize !== 0 ? isEarHashed(ear!, minX, minY, invSize) : isEar(ear!)) {
            // 找到一个耳朵——记录三角形索引
            triangles.push(prev.i / dim);
            triangles.push(ear!.i / dim);
            triangles.push(next.i / dim);

            // 从链表中移除当前耳朵顶点
            removeNode(ear!);

            // 跳过下一个节点，继续扫描
            ear = next.next;
            stop = next.next;
            continue;
        }

        // 当前节点不是耳朵，移动到下一个
        ear = next;

        // 如果扫完一圈都没找到耳朵
        if (ear === stop) {
            if (pass === 0) {
                // 第二轮：过滤共线点后重试
                earcutLinked(filterPoints(ear, null), triangles, dim, minX, minY, invSize, 1);
            } else if (pass === 1) {
                // 第三轮：尝试消除局部自交后重试
                ear = cureLocalIntersections(filterPoints(ear, null)!, triangles, dim);
                earcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
            } else if (pass === 2) {
                // 最终手段：分裂多边形为两部分分别处理
                splitEarcut(ear!, triangles, dim, minX, minY, invSize);
            }
            return;
        }
    }
}

/**
 * 检查顶点是否为耳朵（无 z-order 加速版本）。
 * 耳朵条件：三角形 prev→ear→next 为逆时针方向，且内部无其他顶点。
 *
 * @param ear - 待检测的顶点节点
 * @returns 是否为耳朵
 */
function isEar(ear: Node): boolean {
    const a = ear.prev;
    const b = ear;
    const c = ear.next;

    // 退化三角形（面积为 0）不是耳朵
    if (area(a, b, c) >= 0) return false;

    // 使用面积判断三角形朝向——负面积 = 逆时针
    // 不使用面积≥0的三角形（顺时针或退化）

    // 检查链表中所有其他点是否在该三角形内
    let p = c.next;
    while (p !== a) {
        if (
            pointInTriangleInternal(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
            area(p.prev, p, p.next) >= 0
        ) {
            return false;
        }
        p = p.next;
    }

    return true;
}

/**
 * 检查顶点是否为耳朵（z-order 加速版本）。
 * 利用 z-order 空间索引只检查附近的点，避免遍历所有点。
 *
 * @param ear - 待检测的顶点节点
 * @param minX - 包围盒最小 x
 * @param minY - 包围盒最小 y
 * @param invSize - 坐标归一化因子
 * @returns 是否为耳朵
 */
function isEarHashed(ear: Node, minX: number, minY: number, invSize: number): boolean {
    const a = ear.prev;
    const b = ear;
    const c = ear.next;

    // 退化三角形不是耳朵
    if (area(a, b, c) >= 0) return false;

    // 计算三角形包围盒
    const minTX = Math.min(a.x, b.x, c.x);
    const minTY = Math.min(a.y, b.y, c.y);
    const maxTX = Math.max(a.x, b.x, c.x);
    const maxTY = Math.max(a.y, b.y, c.y);

    // 计算包围盒对应的 z-order 范围
    const minZ = zOrder(minTX, minTY, minX, minY, invSize);
    const maxZ = zOrder(maxTX, maxTY, minX, minY, invSize);

    // 沿 z-order 链表双向搜索附近的点
    let p = ear.prevZ;
    let n = ear.nextZ;

    while (p !== null && p.z >= minZ && n !== null && n.z <= maxZ) {
        // 向前搜索：检查 z-order 较小的点
        if (
            p.x >= minTX && p.x <= maxTX && p.y >= minTY && p.y <= maxTY &&
            p !== a && p !== c &&
            pointInTriangleInternal(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
            area(p.prev, p, p.next) >= 0
        ) {
            return false;
        }
        p = p.prevZ;

        // 向后搜索：检查 z-order 较大的点
        if (
            n.x >= minTX && n.x <= maxTX && n.y >= minTY && n.y <= maxTY &&
            n !== a && n !== c &&
            pointInTriangleInternal(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) &&
            area(n.prev, n, n.next) >= 0
        ) {
            return false;
        }
        n = n.nextZ;
    }

    // 继续向前检查剩余节点
    while (p !== null && p.z >= minZ) {
        if (
            p.x >= minTX && p.x <= maxTX && p.y >= minTY && p.y <= maxTY &&
            p !== a && p !== c &&
            pointInTriangleInternal(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
            area(p.prev, p, p.next) >= 0
        ) {
            return false;
        }
        p = p.prevZ;
    }

    // 继续向后检查剩余节点
    while (n !== null && n.z <= maxZ) {
        if (
            n.x >= minTX && n.x <= maxTX && n.y >= minTY && n.y <= maxTY &&
            n !== a && n !== c &&
            pointInTriangleInternal(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) &&
            area(n.prev, n, n.next) >= 0
        ) {
            return false;
        }
        n = n.nextZ;
    }

    return true;
}

/**
 * 尝试修复局部自相交：当两条相邻边交叉时，
 * 通过重新排列顶点消除交叉。
 *
 * @param start - 链表起始节点
 * @param triangles - 输出三角形索引数组
 * @param dim - 顶点维度
 * @returns 修复后的链表节点
 */
function cureLocalIntersections(start: Node, triangles: number[], dim: number): Node {
    let p = start;
    do {
        const a = p.prev;
        const b = p.next.next;

        // 检查边 a-p 与 p.next-b 是否交叉（非共顶点交叉）
        if (
            !equals(a, b) &&
            intersects(a, p, p.next, b) &&
            locallyInside(a, b) &&
            locallyInside(b, a)
        ) {
            // 用交叉区域形成的三角形替代
            triangles.push(a.i / dim);
            triangles.push(p.i / dim);
            triangles.push(b.i / dim);

            // 移除交叉的两个节点
            removeNode(p);
            removeNode(p.next);

            p = start = b;
        }
        p = p.next;
    } while (p !== start);

    return p;
}

/**
 * 当无法再切耳时，尝试在多边形中间找到一条对角线，
 * 将多边形分为两部分分别递归处理。
 *
 * @param start - 链表起始节点
 * @param triangles - 输出三角形索引数组
 * @param dim - 顶点维度
 * @param minX - 包围盒最小 x
 * @param minY - 包围盒最小 y
 * @param invSize - 坐标归一化因子
 */
function splitEarcut(
    start: Node,
    triangles: number[],
    dim: number,
    minX: number,
    minY: number,
    invSize: number,
): void {
    let a = start;
    do {
        let b = a.next.next;
        while (b !== a.prev) {
            if (a.i !== b.i && isValidDiagonal(a, b)) {
                // 找到有效对角线 a-b，分裂多边形
                let c = splitPolygon(a, b);

                // 过滤共线点
                a = filterPoints(a, a.next);
                c = filterPoints(c, c.next);

                // 递归处理两部分
                earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
                earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
                return;
            }
            b = b.next;
        }
        a = a.next;
    } while (a !== start);
}

/**
 * 为所有链表节点计算 z-order 值，并建立 z-order 排序链表。
 * z-order 曲线将 2D 坐标映射到 1D 值，使空间相近的点在链表中也相邻。
 *
 * @param start - 链表起始节点
 * @param minX - 包围盒最小 x
 * @param minY - 包围盒最小 y
 * @param invSize - 坐标归一化因子
 */
function indexCurve(start: Node, minX: number, minY: number, invSize: number): void {
    let p: Node | null = start;

    // 步骤 1：为每个节点计算 z-order 值
    do {
        if (p!.z === 0) {
            p!.z = zOrder(p!.x, p!.y, minX, minY, invSize);
        }
        p!.prevZ = p!.prev;
        p!.nextZ = p!.next;
        p = p!.next;
    } while (p !== start);

    // 断开 z-order 链表的循环
    p!.prevZ!.nextZ = null;
    p!.prevZ = null;

    // 步骤 2：对 z-order 链表进行归并排序
    sortLinked(p);
}

/**
 * 对链表按 z-order 值进行归并排序（Simon Tatham 的链表排序算法）。
 * 时间复杂度 O(n log n)，空间复杂度 O(1)。
 *
 * @param list - 链表头节点
 * @returns 排序后的链表头节点
 */
function sortLinked(list: Node | null): Node | null {
    if (list === null) return null;

    let inSize = 1;
    let numMerges: number;

    do {
        let p: Node | null = list;
        list = null;
        let tail: Node | null = null;
        numMerges = 0;

        while (p !== null) {
            numMerges++;
            let q: Node | null = p;
            let pSize = 0;

            // 找到第二段的起始位置
            for (let i = 0; i < inSize; i++) {
                pSize++;
                q = q!.nextZ;
                if (q === null) break;
            }

            let qSize = inSize;

            // 合并两段
            while (pSize > 0 || (qSize > 0 && q !== null)) {
                let e: Node;

                if (pSize !== 0 && (qSize === 0 || q === null || p!.z <= q.z)) {
                    e = p!;
                    p = p!.nextZ;
                    pSize--;
                } else {
                    e = q!;
                    q = q!.nextZ;
                    qSize--;
                }

                // 将选中的节点追加到结果链表
                if (tail !== null) {
                    tail.nextZ = e;
                } else {
                    list = e;
                }
                e.prevZ = tail;
                tail = e;
            }

            p = q;
        }

        tail!.nextZ = null;

        // 每轮归并后段长翻倍
        inSize *= 2;
    } while (numMerges > 1);

    return list;
}

/**
 * 计算 z-order 曲线值（Morton code）。
 * 将 2D 坐标交错位编码为 1D 整数，使空间相近的点在排序后也相邻。
 *
 * @param x - x 坐标
 * @param y - y 坐标
 * @param minX - 包围盒最小 x
 * @param minY - 包围盒最小 y
 * @param invSize - 坐标归一化因子
 * @returns 32 位 z-order 值
 */
function zOrder(x: number, y: number, minX: number, minY: number, invSize: number): number {
    // 将坐标归一化到 [0, Z_ORDER_MAX) 整数范围
    let lx = ((x - minX) * invSize) | 0;
    let ly = ((y - minY) * invSize) | 0;

    // 位交错：将 x 和 y 的比特位交替排列
    // 使用分治法展开比特位，每步将相邻位分开
    lx = (lx | (lx << 8)) & 0x00FF00FF;
    lx = (lx | (lx << 4)) & 0x0F0F0F0F;
    lx = (lx | (lx << 2)) & 0x33333333;
    lx = (lx | (lx << 1)) & 0x55555555;

    ly = (ly | (ly << 8)) & 0x00FF00FF;
    ly = (ly | (ly << 4)) & 0x0F0F0F0F;
    ly = (ly | (ly << 2)) & 0x33333333;
    ly = (ly | (ly << 1)) & 0x55555555;

    // x 占偶数位，y 占奇数位
    return lx | (ly << 1);
}

/**
 * 找到环中 x 坐标最小（最左）的节点。
 * 用于确定孔洞桥接方向。
 *
 * @param start - 环的起始节点
 * @returns x 最小的节点
 */
function getLeftmost(start: Node): Node {
    let p = start;
    let leftmost = start;
    do {
        if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) {
            leftmost = p;
        }
        p = p.next;
    } while (p !== start);
    return leftmost;
}

/**
 * 检查点 (px, py) 是否在三角形 (ax,ay)-(bx,by)-(cx,cy) 内部。
 * 使用叉积符号判断：点在三条边的同侧则在三角形内。
 *
 * @param ax - 三角形顶点 A 的 x
 * @param ay - 三角形顶点 A 的 y
 * @param bx - 三角形顶点 B 的 x
 * @param by - 三角形顶点 B 的 y
 * @param cx - 三角形顶点 C 的 x
 * @param cy - 三角形顶点 C 的 y
 * @param px - 测试点的 x
 * @param py - 测试点的 y
 * @returns 点是否在三角形内（含边界）
 */
function pointInTriangleInternal(
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number,
    px: number, py: number,
): boolean {
    return (
        (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
        (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
        (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0
    );
}

/**
 * 检查对角线 a-b 是否有效（不与多边形边相交、在多边形内部）。
 *
 * @param a - 对角线端点 A
 * @param b - 对角线端点 B
 * @returns 对角线是否有效
 */
function isValidDiagonal(a: Node, b: Node): boolean {
    return (
        // a.next.i !== b.i 排除相邻顶点
        a.next.i !== b.i &&
        a.prev.i !== b.i &&
        // 对角线不与多边形任何边相交
        !intersectsPolygon(a, b) &&
        // 对角线在 a 和 b 处都局部在多边形内部
        (
            (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b)) &&
            (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)
        ) ||
        (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0)
    );
}

/**
 * 计算三角形 (p, q, r) 的有向面积的两倍。
 * 正值 = 逆时针，负值 = 顺时针，0 = 共线。
 *
 * @param p - 顶点 P
 * @param q - 顶点 Q
 * @param r - 顶点 R
 * @returns 有向面积 × 2
 */
function area(p: Node, q: Node, r: Node): number {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

/**
 * 检查两个节点坐标是否相等（同一位置）。
 *
 * @param p1 - 节点 1
 * @param p2 - 节点 2
 * @returns 坐标是否相等
 */
function equals(p1: Node, p2: Node): boolean {
    return p1.x === p2.x && p1.y === p2.y;
}

/**
 * 检查线段 p1-q1 和 p2-q2 是否相交。
 * 使用向量叉积方向判断。
 *
 * @param p1 - 线段 1 端点 A
 * @param q1 - 线段 1 端点 B
 * @param p2 - 线段 2 端点 A
 * @param q2 - 线段 2 端点 B
 * @returns 是否相交
 */
function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
    const o1 = sign(area(p1, q1, p2));
    const o2 = sign(area(p1, q1, q2));
    const o3 = sign(area(p2, q2, p1));
    const o4 = sign(area(p2, q2, q1));

    // 标准交叉：四个方向两两不同
    if (o1 !== o2 && o3 !== o4) return true;

    // 共线特殊情况
    if (o1 === 0 && onSegment(p1, p2, q1)) return true;
    if (o2 === 0 && onSegment(p1, q2, q1)) return true;
    if (o3 === 0 && onSegment(p2, p1, q2)) return true;
    if (o4 === 0 && onSegment(p2, q1, q2)) return true;

    return false;
}

/**
 * 检查对角线 a-b 是否与多边形中的任何边相交。
 *
 * @param a - 对角线端点 A
 * @param b - 对角线端点 B
 * @returns 是否相交
 */
function intersectsPolygon(a: Node, b: Node): boolean {
    let p = a;
    do {
        if (
            p.i !== a.i && p.next.i !== a.i &&
            p.i !== b.i && p.next.i !== b.i &&
            intersects(p, p.next, a, b)
        ) {
            return true;
        }
        p = p.next;
    } while (p !== a);
    return false;
}

/**
 * 检查节点 b 是否在节点 a 的局部内侧。
 * "局部内侧"指在 a 处的多边形拐角内部。
 *
 * @param a - 参考节点
 * @param b - 待测节点
 * @returns b 是否在 a 的局部内侧
 */
function locallyInside(a: Node, b: Node): boolean {
    // 如果 a 处为凸角（逆时针），则 b 在 prev-a-next 三角形内
    // 如果 a 处为凹角（顺时针），则 b 不在 prev-a-next 三角形外
    return area(a.prev, a, a.next) < 0
        ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
        : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

/**
 * 检查对角线 a-b 的中点是否在多边形内部。
 *
 * @param a - 对角线端点 A
 * @param b - 对角线端点 B
 * @returns 中点是否在多边形内部
 */
function middleInside(a: Node, b: Node): boolean {
    let p = a;
    let inside = false;
    const px = (a.x + b.x) / 2;
    const py = (a.y + b.y) / 2;

    // 射线法判断中点是否在多边形内
    do {
        if (
            (p.y > py) !== (p.next.y > py) &&
            p.next.y !== p.y &&
            px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x
        ) {
            inside = !inside;
        }
        p = p.next;
    } while (p !== a);

    return inside;
}

/**
 * 在点 a 和 b 之间分裂多边形，创建两个独立的环。
 * 插入两个新节点作为桥接，使原来的一个环变成两个环。
 *
 * @param a - 分裂点 A
 * @param b - 分裂点 B
 * @returns 新环的头节点（b 侧）
 */
function splitPolygon(a: Node, b: Node): Node {
    // 创建 a 和 b 的副本节点
    const a2 = new Node(a.i, a.x, a.y);
    const b2 = new Node(b.i, b.x, b.y);
    const an = a.next;
    const bp = b.prev;

    // 第一个环：a → b → ... → a（用 a 和 b 的副本）
    a.next = b;
    b.prev = a;

    // 第二个环：a2 → an → ... → bp → b2 → a2
    a2.next = an;
    an.prev = a2;

    b2.next = a2;
    a2.prev = b2;

    bp.next = b2;
    b2.prev = bp;

    return b2;
}

/**
 * 在双向链表中插入一个新节点。
 * 如果 last 为 null，创建新的单节点循环链表。
 *
 * @param i - 顶点在数组中的索引
 * @param x - 顶点 x 坐标
 * @param y - 顶点 y 坐标
 * @param last - 上一个插入的节点（新节点插在它后面）
 * @returns 新插入的节点
 */
function insertNode(i: number, x: number, y: number, last: Node | null): Node {
    const p = new Node(i, x, y);

    if (last === null) {
        // 第一个节点：自环
        p.prev = p;
        p.next = p;
    } else {
        // 插入到 last 之后
        p.next = last.next;
        p.prev = last;
        last.next.prev = p;
        last.next = p;
    }
    return p;
}

/**
 * 从双向链表中移除一个节点。
 * 同时更新 z-order 链表的指针。
 *
 * @param p - 要移除的节点
 */
function removeNode(p: Node): void {
    p.next.prev = p.prev;
    p.prev.next = p.next;

    if (p.prevZ !== null) p.prevZ.nextZ = p.nextZ;
    if (p.nextZ !== null) p.nextZ.prevZ = p.prevZ;
}

/**
 * 计算有向面积（Shoelace 公式）。
 * 正值 = 逆时针（CCW），负值 = 顺时针（CW）。
 *
 * @param data - 平铺坐标数组
 * @param start - 起始坐标索引
 * @param end - 结束坐标索引
 * @param dim - 顶点维度
 * @returns 有向面积（未除以 2）
 */
function signedArea(data: ArrayLike<number>, start: number, end: number, dim: number): number {
    let sum = 0;
    // Shoelace 公式：∑(x_i * y_{i+1} - x_{i+1} * y_i)
    for (let i = start, j = end - dim; i < end; i += dim) {
        sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
        j = i;
    }
    return sum;
}

/**
 * 返回数值的符号：正→1，负→-1，零→0。
 *
 * @param num - 输入值
 * @returns 符号值
 */
function sign(num: number): number {
    return num > 0 ? 1 : num < 0 ? -1 : 0;
}

/**
 * 检查点 p 是否在线段 q1-q2 上（假设 p、q1、q2 共线）。
 *
 * @param p - 测试点
 * @param q1 - 线段端点 1
 * @param q2 - 线段端点 2
 * @returns p 是否在 q1-q2 上
 */
function onSegment(p: Node, q1: Node, q2: Node): boolean {
    return (
        Math.max(p.x, q2.x) >= q1.x &&
        q1.x >= Math.min(p.x, q2.x) &&
        Math.max(p.y, q2.y) >= q1.y &&
        q1.y >= Math.min(p.y, q2.y)
    );
}

/**
 * 过滤共线点和重复点。
 * 遍历链表，移除面积为 0（共线）或坐标相同的连续节点。
 *
 * @param start - 链表起始节点
 * @param end - 终止检查的节点（或 null 表示完整遍历）
 * @returns 过滤后的链表头节点
 */
function filterPoints(start: Node, end: Node | null): Node {
    if (end === null) end = start;

    let p = start;
    let again: boolean;

    do {
        again = false;

        if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
            // 移除重复或共线的点
            removeNode(p);
            p = end = p.prev;
            if (p === p.next) break;
            again = true;
        } else {
            p = p.next;
        }
    } while (again || p !== end);

    return end;
}
