// ============================================================
// geo/measure.ts — 几何测量函数
// 提供平面与球面几何量测：面积、长度、质心、视觉中心、
// 最小包围圆、点到线距离、周长。
// 零 npm 依赖，全部自研实现。
// ============================================================

import { WGS84_A } from './ellipsoid.ts';

// ======================== 常量 ========================

/** 弧度→度的转换系数 */
const RAD_TO_DEG: number = 180.0 / Math.PI;

/** 度→弧度的转换系数 */
const DEG_TO_RAD: number = Math.PI / 180.0;

/** 近零阈值，用于面积/长度退化检查 */
const EPSILON: number = 1e-12;

// ======================== 平面面积 ========================

/**
 * 使用 Shoelace（鞋带）公式计算平面多边形的有符号面积。
 * 输入坐标为度数（适用于小区域近似计算）。
 * 正值表示逆时针绕向，负值表示顺时针。返回绝对值。
 *
 * 公式：A = |Σ(x_i * y_{i+1} - x_{i+1} * y_i)| / 2
 *
 * @param ring - 多边形外环顶点数组 [[x,y], ...]，无需首尾闭合
 * @returns 面积（平方度）。空数组或不足 3 点返回 0
 *
 * @example
 * // 单位正方形面积 = 1
 * area([[0,0], [1,0], [1,1], [0,1]]); // 1
 */
export function area(ring: number[][]): number {
    const n = ring.length;
    // 不足 3 个顶点无法构成多边形
    if (n < 3) {
        return 0;
    }

    let sum = 0;
    // 遍历所有边，累加叉积分量
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
        // Shoelace：(x_j * y_i - x_i * y_j)
        sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    // 取绝对值再除以 2
    return Math.abs(sum) * 0.5;
}

// ======================== 球面面积 ========================

/**
 * 使用球面超量公式（Spherical Excess）计算 WGS84 球面上的多边形面积。
 * 输入坐标为 [经度度数, 纬度度数]。
 * 使用 L'Huilier 定理计算球面三角形的球面超量，然后逐三角形累加。
 *
 * @param ring - 多边形外环 [[lng, lat], ...]，单位度数，无需首尾闭合
 * @returns 面积（平方米）。空数组或不足 3 点返回 0
 *
 * @example
 * // 约 12400 平方米的小三角形
 * geodesicArea([[0,0], [0,0.001], [0.001,0]]); // ≈ 6165 m²
 */
export function geodesicArea(ring: [number, number][]): number {
    const n = ring.length;
    // 不足 3 个顶点无法构成多边形
    if (n < 3) {
        return 0;
    }

    // 将度数转换为弧度的经纬度数组
    const lngs: number[] = new Array(n);
    const lats: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        lngs[i] = ring[i][0] * DEG_TO_RAD;
        lats[i] = ring[i][1] * DEG_TO_RAD;
    }

    // 使用球面超量公式逐三角形累加
    // 将多边形分解为以第一个顶点为扇形中心的三角形
    let totalExcess = 0;
    for (let i = 1; i < n - 1; i++) {
        // 三角形：ring[0], ring[i], ring[i+1]
        totalExcess += sphericalTriangleExcess(
            lngs[0], lats[0],
            lngs[i], lats[i],
            lngs[i + 1], lats[i + 1],
        );
    }

    // 面积 = |球面超量| × R²（R 为 WGS84 长半轴）
    return Math.abs(totalExcess) * WGS84_A * WGS84_A;
}

// ======================== 平面长度 ========================

/**
 * 计算折线的欧几里得总长度（平面坐标）。
 * 逐段求两点距离并累加。
 *
 * @param coords - 折线坐标 [[x1,y1], [x2,y2], ...]
 * @returns 总长度。空数组或只有 1 个点返回 0
 *
 * @example
 * length([[0,0], [3,4]]); // 5
 * length([[0,0], [1,0], [1,1]]); // 2
 */
export function length(coords: number[][]): number {
    const n = coords.length;
    // 不足 2 个点没有长度
    if (n < 2) {
        return 0;
    }

    let total = 0;
    // 逐段计算欧几里得距离并累加
    for (let i = 1; i < n; i++) {
        const dx = coords[i][0] - coords[i - 1][0];
        const dy = coords[i][1] - coords[i - 1][1];
        total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
}

// ======================== 球面长度 ========================

/**
 * 使用 Haversine 公式计算折线在 WGS84 球面上的总长度。
 * 输入坐标为 [经度度数, 纬度度数]。
 *
 * @param coords - 折线坐标 [[lng, lat], ...]，单位度数
 * @returns 总长度（米）。空数组或只有 1 个点返回 0
 *
 * @example
 * // 北京到上海约 1068km
 * geodesicLength([[116.397, 39.907], [121.473, 31.230]]); // ≈ 1068000
 */
export function geodesicLength(coords: [number, number][]): number {
    const n = coords.length;
    // 不足 2 个点没有长度
    if (n < 2) {
        return 0;
    }

    let total = 0;
    // 逐段计算 Haversine 距离并累加
    for (let i = 1; i < n; i++) {
        total += haversineDistanceDeg(
            coords[i - 1][0], coords[i - 1][1],
            coords[i][0], coords[i][1],
        );
    }
    return total;
}

// ======================== 质心 ========================

/**
 * 计算多边形顶点的算术平均质心。
 * 简单平均所有顶点坐标（非面积加权质心）。
 *
 * @param ring - 多边形外环顶点 [[x,y], ...]
 * @returns 质心坐标 [cx, cy]。空数组返回 [0, 0]
 *
 * @example
 * centroid([[0,0], [2,0], [2,2], [0,2]]); // [1, 1]
 */
export function centroid(ring: number[][]): [number, number] {
    const n = ring.length;
    // 空数组返回原点
    if (n === 0) {
        return [0, 0];
    }

    let sx = 0;
    let sy = 0;
    // 累加所有顶点坐标
    for (let i = 0; i < n; i++) {
        sx += ring[i][0];
        sy += ring[i][1];
    }
    // 取平均值
    return [sx / n, sy / n];
}

// ======================== 视觉中心 (Polylabel) ========================

/**
 * 使用基于单元格的迭代搜索算法计算多边形的"视觉中心"——
 * 多边形内部距边界最远的点（即最大内切圆的圆心）。
 * 这是 Mapbox polylabel 算法的自研实现。
 *
 * 算法概述：
 *   1. 用多边形包围盒初始化网格单元
 *   2. 每个单元记录其中心到多边形边界的有符号距离
 *   3. 用优先队列（按 d + cellSize/2 排序）迭代细分最有前途的单元
 *   4. 当最佳候选不可能超过当前已知最优解时停止
 *
 * @param polygon - 多边形环数组，polygon[0] 为外环，其余为内洞。每个环为 [[x,y], ...]
 * @param precision - 搜索精度阈值（坐标单位），默认 1.0。值越小结果越精确但越慢
 * @returns 视觉中心坐标 [x, y]
 *
 * @example
 * const poly = [[[0,0], [10,0], [10,10], [0,10]]];
 * polylabel(poly, 0.01); // [5, 5]（正方形的中心）
 */
export function polylabel(polygon: number[][][], precision = 1.0): [number, number] {
    // 空多边形或无环返回原点
    if (polygon.length === 0 || polygon[0].length === 0) {
        return [0, 0];
    }

    const outerRing = polygon[0];

    // 计算多边形包围盒
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < outerRing.length; i++) {
        const x = outerRing[i][0];
        const y = outerRing[i][1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    // 初始单元格尺寸为包围盒较短边的一半
    const width = maxX - minX;
    const height = maxY - minY;
    let cellSize = Math.min(width, height);

    // 退化多边形（零面积）返回包围盒中心
    if (cellSize < EPSILON) {
        return [(minX + maxX) * 0.5, (minY + maxY) * 0.5];
    }

    let halfCell = cellSize * 0.5;

    // 初始化候选单元格队列（按潜力值降序排列——最大堆模拟）
    let cellQueue: PolylabelCell[] = [];

    // 用网格单元覆盖包围盒
    for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) {
            cellQueue.push(createPolylabelCell(x + halfCell, y + halfCell, halfCell, polygon));
        }
    }

    // 按潜力值排序（降序，最大潜力在末尾以便 pop）
    cellQueue.sort((a, b) => a.potential - b.potential);

    // 用质心作为初始最优猜测
    let bestCell = createPolylabelCellFromCentroid(polygon);

    // 用包围盒中心也做一次尝试
    const bboxCell = createPolylabelCell(
        (minX + maxX) * 0.5, (minY + maxY) * 0.5, 0, polygon,
    );
    if (bboxCell.distance > bestCell.distance) {
        bestCell = bboxCell;
    }

    // 迭代搜索：不断细分最有前途的单元格
    while (cellQueue.length > 0) {
        // 取出潜力最大的单元
        const cell = cellQueue.pop()!;

        // 如果此单元中心比当前最优更好，更新最优
        if (cell.distance > bestCell.distance) {
            bestCell = cell;
        }

        // 如果此单元的潜力无法超过当前最优 + 精度要求，剪枝
        if (cell.potential - bestCell.distance <= precision) {
            continue;
        }

        // 将单元格细分为 4 个子单元
        halfCell = cell.halfSize * 0.5;
        const cx = cell.x;
        const cy = cell.y;

        const c1 = createPolylabelCell(cx - halfCell, cy - halfCell, halfCell, polygon);
        const c2 = createPolylabelCell(cx + halfCell, cy - halfCell, halfCell, polygon);
        const c3 = createPolylabelCell(cx - halfCell, cy + halfCell, halfCell, polygon);
        const c4 = createPolylabelCell(cx + halfCell, cy + halfCell, halfCell, polygon);

        // 插入队列并保持排序
        insertSorted(cellQueue, c1);
        insertSorted(cellQueue, c2);
        insertSorted(cellQueue, c3);
        insertSorted(cellQueue, c4);
    }

    return [bestCell.x, bestCell.y];
}

// ======================== 最小包围圆 ========================

/**
 * 使用 Welzl 算法计算最小包围圆（Minimum Enclosing Circle）。
 * 递归随机增量算法，期望 O(n) 时间复杂度。
 *
 * @param points - 输入点集 [[x,y], ...]
 * @returns 最小包围圆 { center: [cx, cy], radius: r }。空数组返回原点半径 0
 *
 * @example
 * minBoundingCircle([[0,0], [1,0], [0,1]]); // { center: [0.5, 0.5], radius: ≈0.707 }
 */
export function minBoundingCircle(
    points: number[][],
): { center: [number, number]; radius: number } {
    const n = points.length;
    // 空点集返回原点零半径
    if (n === 0) {
        return { center: [0, 0], radius: 0 };
    }
    // 单点返回该点零半径
    if (n === 1) {
        return { center: [points[0][0], points[0][1]], radius: 0 };
    }

    // 随机打乱点集（Fisher-Yates 洗牌），确保期望线性时间
    const shuffled = points.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        // 使用确定性伪随机避免不可重现：(i * 2654435761) 是 Knuth 乘法散列
        const j = ((i * 2654435761) >>> 0) % (i + 1);
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }

    // Welzl 递归入口（使用迭代方式避免栈溢出）
    return welzlIterative(shuffled);
}

// ======================== 点到折线距离 ========================

/**
 * 计算点到折线的最短垂直距离。
 * 遍历折线每一段，计算点到线段的投影距离，返回最小值。
 *
 * @param point - 查询点 [x, y]
 * @param line - 折线坐标 [[x1,y1], [x2,y2], ...]
 * @returns 最短距离。空线返回 Infinity，单点线返回点间距离
 *
 * @example
 * pointToLineDistance([1, 1], [[0,0], [2,0]]); // 1（垂直距离）
 */
export function pointToLineDistance(point: number[], line: number[][]): number {
    const n = line.length;
    // 空线返回 Infinity
    if (n === 0) {
        return Infinity;
    }
    // 退化为点：直接计算两点距离
    if (n === 1) {
        const dx = point[0] - line[0][0];
        const dy = point[1] - line[0][1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    let minDist = Infinity;
    const px = point[0];
    const py = point[1];

    // 遍历每一段线段
    for (let i = 0; i < n - 1; i++) {
        const dist = sqSegDistToSegment(
            px, py,
            line[i][0], line[i][1],
            line[i + 1][0], line[i + 1][1],
        );
        if (dist < minDist) {
            minDist = dist;
        }
    }

    // 返回距离（取平方根）
    return Math.sqrt(minDist);
}

// ======================== 周长 ========================

/**
 * 计算多边形环的周长（欧几里得距离之和）。
 * 自动闭合环（首尾点相连）。
 *
 * @param ring - 多边形环顶点 [[x,y], ...]
 * @returns 周长。不足 2 个点返回 0
 *
 * @example
 * perimeter([[0,0], [1,0], [1,1], [0,1]]); // 4（正方形）
 */
export function perimeter(ring: number[][]): number {
    const n = ring.length;
    // 不足 2 个点没有周长
    if (n < 2) {
        return 0;
    }

    let total = 0;
    // 逐边计算距离（包括从最后一个点回到第一个点的闭合边）
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = ring[j][0] - ring[i][0];
        const dy = ring[j][1] - ring[i][1];
        total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
}

// ======================== 内部辅助函数 ========================

/**
 * 计算球面三角形的球面超量（Spherical Excess），使用 L'Huilier 定理。
 * 球面超量 = 三角形三个球面角之和 - π。
 *
 * @param lng1 - 顶点 1 经度（弧度）
 * @param lat1 - 顶点 1 纬度（弧度）
 * @param lng2 - 顶点 2 经度（弧度）
 * @param lat2 - 顶点 2 纬度（弧度）
 * @param lng3 - 顶点 3 经度（弧度）
 * @param lat3 - 顶点 3 纬度（弧度）
 * @returns 球面超量（弧度），有符号
 */
function sphericalTriangleExcess(
    lng1: number, lat1: number,
    lng2: number, lat2: number,
    lng3: number, lat3: number,
): number {
    // 计算三条边的角距离（弧度）
    const a = haversineAngle(lat1, lng1, lat2, lng2);
    const b = haversineAngle(lat2, lng2, lat3, lng3);
    const c = haversineAngle(lat3, lng3, lat1, lng1);

    // 半周长
    const s = (a + b + c) * 0.5;

    // L'Huilier 定理：
    // tan(E/4) = sqrt(tan(s/2) * tan((s-a)/2) * tan((s-b)/2) * tan((s-c)/2))
    const tanHalfS = Math.tan(s * 0.5);
    const tanSA = Math.tan((s - a) * 0.5);
    const tanSB = Math.tan((s - b) * 0.5);
    const tanSC = Math.tan((s - c) * 0.5);

    // 乘积可能为负（数值误差），取绝对值后开方
    const product = tanHalfS * tanSA * tanSB * tanSC;
    const sqrtProduct = Math.sqrt(Math.abs(product));

    // 球面超量 E = 4 * atan(sqrtProduct)
    return 4.0 * Math.atan(sqrtProduct);
}

/**
 * Haversine 公式计算两点间的角距离（弧度）。
 *
 * @param lat1 - 第一点纬度（弧度）
 * @param lng1 - 第一点经度（弧度）
 * @param lat2 - 第二点纬度（弧度）
 * @param lng2 - 第二点经度（弧度）
 * @returns 角距离（弧度）
 */
function haversineAngle(
    lat1: number, lng1: number,
    lat2: number, lng2: number,
): number {
    const dLat = lat2 - lat1;
    const dLng = lng2 - lng1;
    const sinHalfDLat = Math.sin(dLat * 0.5);
    const sinHalfDLng = Math.sin(dLng * 0.5);
    const a = sinHalfDLat * sinHalfDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;
    // clamp 到 [0, 1] 防止浮点溢出
    return 2.0 * Math.asin(Math.sqrt(Math.min(a, 1.0)));
}

/**
 * Haversine 公式计算两点间的地表距离（米），输入为度数。
 *
 * @param lng1 - 第一点经度（度）
 * @param lat1 - 第一点纬度（度）
 * @param lng2 - 第二点经度（度）
 * @param lat2 - 第二点纬度（度）
 * @returns 距离（米）
 */
function haversineDistanceDeg(
    lng1: number, lat1: number,
    lng2: number, lat2: number,
): number {
    // 转弧度
    const rlat1 = lat1 * DEG_TO_RAD;
    const rlat2 = lat2 * DEG_TO_RAD;
    const rlng1 = lng1 * DEG_TO_RAD;
    const rlng2 = lng2 * DEG_TO_RAD;
    // 角距离乘以地球半径
    return haversineAngle(rlat1, rlng1, rlat2, rlng2) * WGS84_A;
}

/**
 * 计算点到线段的距离的平方（投影法）。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param x1 - 线段起点 x
 * @param y1 - 线段起点 y
 * @param x2 - 线段终点 x
 * @param y2 - 线段终点 y
 * @returns 距离的平方
 */
function sqSegDistToSegment(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
): number {
    let dx = x2 - x1;
    let dy = y2 - y1;

    if (dx !== 0 || dy !== 0) {
        // 计算投影参数 t = dot(P-A, B-A) / |B-A|²
        const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);

        if (t > 1) {
            // 投影在线段终点之后
            x1 = x2;
            y1 = y2;
        } else if (t > 0) {
            // 投影在线段上
            x1 += dx * t;
            y1 += dy * t;
        }
        // t <= 0：用起点
    }

    dx = px - x1;
    dy = py - y1;
    return dx * dx + dy * dy;
}

// ======================== Polylabel 辅助 ========================

/** polylabel 算法中的候选单元格 */
interface PolylabelCell {
    /** 单元中心 x */
    readonly x: number;
    /** 单元中心 y */
    readonly y: number;
    /** 单元半尺寸 */
    readonly halfSize: number;
    /** 中心到多边形边界的有符号距离（正=内部） */
    readonly distance: number;
    /** 潜力值 = distance + halfSize（上界估计） */
    readonly potential: number;
}

/**
 * 创建 polylabel 候选单元格。
 *
 * @param x - 中心 x
 * @param y - 中心 y
 * @param halfSize - 半尺寸
 * @param polygon - 多边形环数组
 * @returns 候选单元格
 */
function createPolylabelCell(
    x: number, y: number,
    halfSize: number,
    polygon: number[][][],
): PolylabelCell {
    // 计算点到多边形边界的有符号距离
    const distance = pointToPolygonDistance(x, y, polygon);
    return {
        x,
        y,
        halfSize,
        distance,
        // 潜力 = 当前距离 + 半尺寸（单元内最优点的上界）
        potential: distance + halfSize * Math.SQRT2,
    };
}

/**
 * 用多边形质心创建初始候选单元。
 *
 * @param polygon - 多边形环数组
 * @returns 候选单元格
 */
function createPolylabelCellFromCentroid(polygon: number[][][]): PolylabelCell {
    const ring = polygon[0];
    let cx = 0, cy = 0, totalArea = 0;

    // 使用有符号面积加权质心（比简单平均更精确）
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
        const a = ring[j];
        const b = ring[i];
        // 有符号面积分量
        const cross = a[0] * b[1] - b[0] * a[1];
        cx += (a[0] + b[0]) * cross;
        cy += (a[1] + b[1]) * cross;
        totalArea += cross;
    }

    // 退化多边形回退到第一个顶点
    if (Math.abs(totalArea) < EPSILON) {
        return createPolylabelCell(ring[0][0], ring[0][1], 0, polygon);
    }

    totalArea *= 3;
    return createPolylabelCell(cx / totalArea, cy / totalArea, 0, polygon);
}

/**
 * 计算点到多边形边界的有符号距离。
 * 正值表示在多边形内部，负值表示在外部。
 *
 * @param x - 查询点 x
 * @param y - 查询点 y
 * @param polygon - 多边形环数组
 * @returns 有符号距离
 */
function pointToPolygonDistance(x: number, y: number, polygon: number[][][]): number {
    // 首先判断点是否在多边形内部（射线法）
    let inside = false;
    let minDistSq = Infinity;

    // 遍历所有环（外环 + 内洞）
    for (let k = 0; k < polygon.length; k++) {
        const ring = polygon[k];
        const len = ring.length;

        for (let i = 0, j = len - 1; i < len; j = i, i++) {
            const ai = ring[i];
            const aj = ring[j];

            // 射线法判断内外：水平射线穿越测试
            if ((ai[1] > y) !== (aj[1] > y) &&
                x < (aj[0] - ai[0]) * (y - ai[1]) / (aj[1] - ai[1]) + ai[0]) {
                inside = !inside;
            }

            // 同时计算点到每条边的最短距离平方
            const distSq = sqSegDistToSegment(x, y, ai[0], ai[1], aj[0], aj[1]);
            if (distSq < minDistSq) {
                minDistSq = distSq;
            }
        }
    }

    // 有符号距离：内部为正，外部为负
    const dist = Math.sqrt(minDistSq);
    return inside ? dist : -dist;
}

/**
 * 将单元格按潜力值有序插入队列（升序，pop 取最大值）。
 * 使用二分查找定位插入位置，O(log n) 查找 + O(n) 移动。
 *
 * @param queue - 排序队列
 * @param cell - 待插入单元格
 */
function insertSorted(queue: PolylabelCell[], cell: PolylabelCell): void {
    // 二分查找插入位置
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (queue[mid].potential < cell.potential) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    queue.splice(lo, 0, cell);
}

// ======================== Welzl 最小包围圆辅助 ========================

/**
 * Welzl 算法的迭代实现（避免递归栈溢出）。
 * 算法原理：增量构造，每次加入一个点，如果该点在当前圆外则重建圆。
 *
 * @param points - 已打乱的点集
 * @returns 最小包围圆
 */
function welzlIterative(
    points: number[][],
): { center: [number, number]; radius: number } {
    const n = points.length;

    // 从前两个点初始化圆
    let cx = (points[0][0] + points[1][0]) * 0.5;
    let cy = (points[0][1] + points[1][1]) * 0.5;
    let dx = points[1][0] - points[0][0];
    let dy = points[1][1] - points[0][1];
    let rSq = (dx * dx + dy * dy) * 0.25;

    // 依次加入每个点
    for (let i = 2; i < n; i++) {
        dx = points[i][0] - cx;
        dy = points[i][1] - cy;
        const distSq = dx * dx + dy * dy;

        // 如果点在当前圆内（含边界），跳过
        if (distSq <= rSq + EPSILON) {
            continue;
        }

        // 点在圆外——需要重建：找包含 points[0..i] 且边界上有 points[i] 的最小圆
        // 一定经过 points[i]
        cx = (points[0][0] + points[i][0]) * 0.5;
        cy = (points[0][1] + points[i][1]) * 0.5;
        dx = points[i][0] - points[0][0];
        dy = points[i][1] - points[0][1];
        rSq = (dx * dx + dy * dy) * 0.25;

        for (let j = 1; j < i; j++) {
            dx = points[j][0] - cx;
            dy = points[j][1] - cy;
            const djSq = dx * dx + dy * dy;

            if (djSq <= rSq + EPSILON) {
                continue;
            }

            // 需要经过 points[i] 和 points[j] 的圆
            cx = (points[j][0] + points[i][0]) * 0.5;
            cy = (points[j][1] + points[i][1]) * 0.5;
            dx = points[i][0] - points[j][0];
            dy = points[i][1] - points[j][1];
            rSq = (dx * dx + dy * dy) * 0.25;

            for (let k = 0; k < j; k++) {
                dx = points[k][0] - cx;
                dy = points[k][1] - cy;
                const dkSq = dx * dx + dy * dy;

                if (dkSq <= rSq + EPSILON) {
                    continue;
                }

                // 需要经过三个点的外接圆
                const circ = circumcircle(points[i], points[j], points[k]);
                cx = circ.cx;
                cy = circ.cy;
                rSq = circ.rSq;
            }
        }
    }

    return { center: [cx, cy], radius: Math.sqrt(rSq) };
}

/**
 * 计算三点的外接圆。
 *
 * @param a - 点 A [x, y]
 * @param b - 点 B [x, y]
 * @param c - 点 C [x, y]
 * @returns 外接圆中心和半径平方
 */
function circumcircle(
    a: number[], b: number[], c: number[],
): { cx: number; cy: number; rSq: number } {
    const ax = a[0], ay = a[1];
    const bx = b[0], by = b[1];
    const ccx = c[0], ccy = c[1];

    // 使用行列式公式计算外接圆圆心
    const D = 2.0 * (ax * (by - ccy) + bx * (ccy - ay) + ccx * (ay - by));

    // 退化情况：三点共线
    if (Math.abs(D) < EPSILON) {
        // 取最远两点的中点和半径
        const d1 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
        const d2 = (ccx - ax) * (ccx - ax) + (ccy - ay) * (ccy - ay);
        const d3 = (ccx - bx) * (ccx - bx) + (ccy - by) * (ccy - by);
        if (d1 >= d2 && d1 >= d3) {
            return { cx: (ax + bx) * 0.5, cy: (ay + by) * 0.5, rSq: d1 * 0.25 };
        } else if (d2 >= d3) {
            return { cx: (ax + ccx) * 0.5, cy: (ay + ccy) * 0.5, rSq: d2 * 0.25 };
        } else {
            return { cx: (bx + ccx) * 0.5, cy: (by + ccy) * 0.5, rSq: d3 * 0.25 };
        }
    }

    const invD = 1.0 / D;
    const aSq = ax * ax + ay * ay;
    const bSq = bx * bx + by * by;
    const cSq = ccx * ccx + ccy * ccy;

    // 圆心坐标
    const ux = (aSq * (by - ccy) + bSq * (ccy - ay) + cSq * (ay - by)) * invD;
    const uy = (aSq * (ccx - bx) + bSq * (ax - ccx) + cSq * (bx - ax)) * invD;

    // 半径平方 = 圆心到任一点的距离平方
    const dxa = ax - ux;
    const dya = ay - uy;

    return { cx: ux, cy: uy, rSq: dxa * dxa + dya * dya };
}

declare const __DEV__: boolean;
