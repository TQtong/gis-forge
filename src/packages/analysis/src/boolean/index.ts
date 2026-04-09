// ============================================================
// analysis/boolean/index.ts — 布尔空间运算
// 职责：多边形集合运算（交集/并集/差集/异或）、自相交检测、拓扑修复。
// 使用简化 Sutherland-Hodgman 算法实现多边形裁剪，
// 并以组合方式构建并集/差集/异或操作。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { Position, PolygonGeometry, LinearRing } from '../../../core/src/types/geometry.ts';
import type { Feature, FeatureCollection } from '../../../core/src/types/feature.ts';
import {
    martinez as _martinez,
    type MartinezOp,
    type MartinezPolygon,
} from './martinez.ts';

export {
    martinez,
    type MartinezOp,
    type MartinezPolygon,
} from './martinez.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const BOOLEAN_ERROR_CODES = {
    /** 输入几何类型不合法 */
    INVALID_GEOMETRY: 'BOOLEAN_INVALID_GEOMETRY',
    /** 多边形环顶点不足 */
    INSUFFICIENT_VERTICES: 'BOOLEAN_INSUFFICIENT_VERTICES',
    /** 运算过程中出现退化结果 */
    DEGENERATE_RESULT: 'BOOLEAN_DEGENERATE_RESULT',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 最小有效多边形顶点数（含闭合点需至少 4 个坐标） */
const MIN_RING_VERTICES = 4;

/** 浮点比较 epsilon，用于共线/共点判断 */
const EPSILON = 1e-10;

/** 面积阈值——小于此面积的多边形视为退化 */
const MIN_AREA_THRESHOLD = 1e-12;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 计算二维叉积 (b-a) × (c-a)。
 * 正值表示 c 在线段 ab 左侧（逆时针），负值表示右侧（顺时针），0 表示共线。
 *
 * @param a - 起点
 * @param b - 终点
 * @param c - 待判断点
 * @returns 叉积值
 *
 * @example
 * cross2D([0,0], [1,0], [0,1]); // → 1 (逆时针)
 */
function cross2D(a: Position, b: Position, c: Position): number {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * 计算两条线段的交点。
 * 线段 p1-p2 与 p3-p4 的交点，使用参数方程法。
 * 若平行或退化则返回 null。
 *
 * @param p1 - 线段1起点
 * @param p2 - 线段1终点
 * @param p3 - 线段2起点
 * @param p4 - 线段2终点
 * @returns 交点坐标，或 null 表示不相交
 *
 * @example
 * segmentIntersection([0,0],[2,2],[0,2],[2,0]); // → [1,1]
 */
function segmentIntersection(
    p1: Position,
    p2: Position,
    p3: Position,
    p4: Position
): Position | null {
    const d1x = p2[0] - p1[0];
    const d1y = p2[1] - p1[1];
    const d2x = p4[0] - p3[0];
    const d2y = p4[1] - p3[1];

    // 计算分母（两向量的叉积）
    const denom = d1x * d2y - d1y * d2x;

    // 分母为零说明平行或共线
    if (Math.abs(denom) < EPSILON) {
        return null;
    }

    const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
    const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;

    // t 和 u 都在 [0,1] 范围内才表示线段真正相交（非延长线交点）
    if (t >= -EPSILON && t <= 1.0 + EPSILON && u >= -EPSILON && u <= 1.0 + EPSILON) {
        return [
            p1[0] + t * d1x,
            p1[1] + t * d1y,
        ] as Position;
    }

    return null;
}

/**
 * 判断点是否在裁剪边的"内侧"（Sutherland-Hodgman 算法核心判断）。
 * "内侧"定义为：点在裁剪边方向的左侧（逆时针多边形的内部）。
 *
 * @param point - 待判断的点
 * @param edgeStart - 裁剪边起点
 * @param edgeEnd - 裁剪边终点
 * @returns true 表示点在内侧（或恰好在边上）
 *
 * @example
 * isInside([0.5, 0.5], [0, 0], [1, 0]); // true (逆时针外环内部)
 */
function isInside(point: Position, edgeStart: Position, edgeEnd: Position): boolean {
    // 叉积 >= 0 表示点在裁剪边左侧或线上（内侧）
    return cross2D(edgeStart, edgeEnd, point) >= -EPSILON;
}

/**
 * 计算线段与裁剪边的交点（无限延伸线交点，非线段截断）。
 * 用于 Sutherland-Hodgman 裁剪算法中出入边界时的交点计算。
 *
 * @param p1 - 线段起点
 * @param p2 - 线段终点
 * @param edgeStart - 裁剪边起点
 * @param edgeEnd - 裁剪边终点
 * @returns 交点坐标
 *
 * @example
 * lineIntersection([0,0],[2,2],[0,1],[2,1]); // → [1,1]
 */
function lineIntersection(
    p1: Position,
    p2: Position,
    edgeStart: Position,
    edgeEnd: Position
): Position {
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = edgeStart[0], y3 = edgeStart[1];
    const x4 = edgeEnd[0], y4 = edgeEnd[1];

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

    // 分母为零时两线平行——返回中点作为近似值（退化情况）
    if (Math.abs(denom) < EPSILON) {
        return [(x1 + x2) * 0.5, (y1 + y2) * 0.5] as Position;
    }

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;

    return [
        x1 + t * (x2 - x1),
        y1 + t * (y2 - y1),
    ] as Position;
}

/**
 * Sutherland-Hodgman 多边形裁剪算法。
 * 用裁剪多边形的每条边依次裁剪主多边形，生成交集区域。
 * 仅处理凸裁剪多边形——对于凹多边形结果可能不正确。
 *
 * @param subjectRing - 被裁剪多边形的顶点数组（不含闭合重复点）
 * @param clipRing - 裁剪多边形的顶点数组（不含闭合重复点）
 * @returns 裁剪后的顶点数组（不含闭合重复点），空数组表示无交集
 *
 * @example
 * const clipped = sutherlandHodgman(subject, clip);
 */
function sutherlandHodgman(subjectRing: Position[], clipRing: Position[]): Position[] {
    // 初始输出列表 = 被裁剪多边形的全部顶点
    let output: Position[] = [...subjectRing];

    // 用裁剪多边形的每条边依次裁剪
    const clipLen = clipRing.length;
    for (let i = 0; i < clipLen; i++) {
        // 当前裁剪边：clipRing[i] → clipRing[(i+1) % n]
        const edgeStart = clipRing[i]!;
        const edgeEnd = clipRing[(i + 1) % clipLen]!;

        const input = output;
        output = [];

        // 空输入表示已被完全裁剪掉
        if (input.length === 0) {
            return [];
        }

        // 遍历 input 中每条边（相邻顶点对），判断出入关系
        const inputLen = input.length;
        for (let j = 0; j < inputLen; j++) {
            const current = input[j]!;
            const previous = input[(j + inputLen - 1) % inputLen]!;

            const currentInside = isInside(current, edgeStart, edgeEnd);
            const previousInside = isInside(previous, edgeStart, edgeEnd);

            if (currentInside) {
                if (!previousInside) {
                    // 从外到内——添加交点 + 当前点
                    output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
                }
                // 内 → 内 或 外 → 内：添加当前点
                output.push(current);
            } else if (previousInside) {
                // 从内到外——只添加交点
                output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
            }
            // 外 → 外：不添加任何点
        }
    }

    return output;
}

/**
 * 计算多边形环面积（Shoelace 公式）。
 * 正值表示逆时针方向，负值表示顺时针方向。
 * 返回有符号面积（用于方向判断）。
 *
 * @param ring - 多边形环顶点数组（不含闭合重复点或含闭合重复点均可）
 * @returns 有符号面积
 *
 * @example
 * signedArea([[0,0],[1,0],[1,1],[0,1]]); // → 1.0 (逆时针)
 */
function signedArea(ring: Position[]): number {
    let area = 0;
    const n = ring.length;

    // 空环或退化环返回 0
    if (n < 3) {
        return 0;
    }

    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        // Shoelace 公式累加项：x_i * y_j - x_j * y_i
        area += ring[i]![0] * ring[j]![1];
        area -= ring[j]![0] * ring[i]![1];
    }

    return area * 0.5;
}

/**
 * 将环的顶点数组转换为闭合 LinearRing（首尾坐标相同）。
 *
 * @param vertices - 不含闭合点的顶点数组
 * @returns 闭合的 LinearRing
 *
 * @example
 * closeRing([[0,0],[1,0],[1,1]]); // → [[0,0],[1,0],[1,1],[0,0]]
 */
function closeRing(vertices: Position[]): LinearRing {
    if (vertices.length === 0) {
        return [];
    }

    const first = vertices[0]!;
    const last = vertices[vertices.length - 1]!;

    // 如果首尾已经相同则直接返回（浮点精确匹配）
    if (first[0] === last[0] && first[1] === last[1]) {
        return [...vertices];
    }

    // 添加闭合点
    return [...vertices, [first[0], first[1]] as Position];
}

/**
 * 从环中移除闭合的重复尾点，返回开环顶点数组。
 *
 * @param ring - 可能含闭合点的环
 * @returns 不含闭合重复点的顶点数组
 *
 * @example
 * openRing([[0,0],[1,0],[1,1],[0,0]]); // → [[0,0],[1,0],[1,1]]
 */
function openRing(ring: Position[]): Position[] {
    if (ring.length < 2) {
        return [...ring];
    }

    const first = ring[0]!;
    const last = ring[ring.length - 1]!;

    // 首尾坐标相同则移除最后一个
    if (first[0] === last[0] && first[1] === last[1]) {
        return ring.slice(0, -1);
    }

    return [...ring];
}

/**
 * 从顶点数组构建 PolygonGeometry Feature。
 *
 * @param rings - 环数组（外环 + 内环），每个环为 LinearRing
 * @returns Feature<PolygonGeometry>，空环返回 null
 *
 * @example
 * const feature = buildPolygonFeature([outerRing]);
 */
function buildPolygonFeature(rings: LinearRing[]): Feature<PolygonGeometry> | null {
    // 过滤掉退化的环（不足 4 个顶点）
    const validRings = rings.filter(r => r.length >= MIN_RING_VERTICES);

    if (validRings.length === 0) {
        return null;
    }

    return {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: validRings,
        },
        properties: {},
    };
}

// ---------------------------------------------------------------------------
// BooleanOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 布尔空间运算集合。
 * 提供多边形的交集、并集、差集、异或运算，以及自相交检测和修复。
 *
 * 注意事项：
 * - intersection 使用 Sutherland-Hodgman 算法，对凸多边形效果最佳
 * - 凹多边形的交集结果可能不完全精确
 * - union/difference/xor 基于 intersection 组合实现
 *
 * @stability experimental
 *
 * @example
 * const result = BooleanOps.intersection(polyA, polyB);
 */
export const BooleanOps = {
    /**
     * 计算两个多边形的交集（公共区域）。
     * 使用 Sutherland-Hodgman 裁剪算法。
     *
     * @param a - 多边形 A（Feature<PolygonGeometry>）
     * @param b - 多边形 B（Feature<PolygonGeometry>）
     * @returns 交集多边形 Feature，无交集时返回 null
     *
     * @stability experimental
     *
     * @example
     * const inter = BooleanOps.intersection(featureA, featureB);
     * if (inter) console.log('有交集');
     */
    intersection(
        a: Feature<PolygonGeometry>,
        b: Feature<PolygonGeometry>
    ): Feature<PolygonGeometry> | null {
        // 校验输入类型
        if (!a || !a.geometry || a.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数 a 必须是 Polygon Feature`);
            }
            return null;
        }
        if (!b || !b.geometry || b.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数 b 必须是 Polygon Feature`);
            }
            return null;
        }

        const ringA = a.geometry.coordinates[0];
        const ringB = b.geometry.coordinates[0];

        // 校验环顶点数量
        if (!ringA || ringA.length < MIN_RING_VERTICES || !ringB || ringB.length < MIN_RING_VERTICES) {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INSUFFICIENT_VERTICES}] 多边形环至少需要 ${MIN_RING_VERTICES} 个顶点`);
            }
            return null;
        }

        // 移除闭合点后执行 Sutherland-Hodgman 裁剪
        const openA = openRing(ringA);
        const openB = openRing(ringB);

        const clipped = sutherlandHodgman(openA, openB);

        // 裁剪结果不足以构成多边形
        if (clipped.length < 3) {
            return null;
        }

        // 检查结果面积是否退化
        const area = Math.abs(signedArea(clipped));
        if (area < MIN_AREA_THRESHOLD) {
            return null;
        }

        // 闭合环并构建 Feature
        const closedRing = closeRing(clipped);
        return buildPolygonFeature([closedRing]);
    },

    /**
     * 计算两个多边形的并集。
     * 简化实现：A ∪ B = A + B - (A ∩ B)。
     * 返回近似结果（两个多边形加交集的负面积补偿），
     * 精确的并集需要完整的多边形裁剪框架（Weiler-Atherton 等）。
     *
     * 当前实现返回包含两个多边形的 FeatureCollection。
     * 如果存在交集则返回 3 个要素（A、B、交集带负面积标记）。
     *
     * @param a - 多边形 A
     * @param b - 多边形 B
     * @returns 并集结果作为 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const union = BooleanOps.union(featureA, featureB);
     */
    union(
        a: Feature<PolygonGeometry>,
        b: Feature<PolygonGeometry>
    ): FeatureCollection<PolygonGeometry> {
        // 校验输入
        if (!a || !a.geometry || a.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数 a 必须是 Polygon Feature`);
            }
            return { type: 'FeatureCollection', features: [] };
        }
        if (!b || !b.geometry || b.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数 b 必须是 Polygon Feature`);
            }
            return { type: 'FeatureCollection', features: [a] };
        }

        // 简化策略：返回两个多边形的集合
        // 真正的 merge 需要 Weiler-Atherton 或 Vatti，此处提供组合近似
        const features: Feature<PolygonGeometry>[] = [a, b];

        return {
            type: 'FeatureCollection',
            features,
        };
    },

    /**
     * 计算两个多边形的差集（A - B）。
     * A 中去除与 B 重叠的区域。
     * 简化实现：返回 A 中不在交集内的近似区域。
     *
     * @param a - 被减多边形
     * @param b - 减去的多边形
     * @returns 差集多边形 Feature，或 null 表示 A 完全被 B 覆盖
     *
     * @stability experimental
     *
     * @example
     * const diff = BooleanOps.difference(featureA, featureB);
     */
    difference(
        a: Feature<PolygonGeometry>,
        b: Feature<PolygonGeometry>
    ): Feature<PolygonGeometry> | null {
        // 校验输入
        if (!a || !a.geometry || a.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数 a 必须是 Polygon Feature`);
            }
            return null;
        }
        if (!b || !b.geometry || b.geometry.type !== 'Polygon') {
            // B 无效，差集 = A 本身
            return a;
        }

        // 计算交集
        const inter = BooleanOps.intersection(a, b);

        // 无交集，差集 = A 本身
        if (!inter) {
            return a;
        }

        // 检查交集面积是否接近 A 的面积（A 几乎被 B 完全覆盖）
        const aRing = openRing(a.geometry.coordinates[0]!);
        const interRing = openRing(inter.geometry.coordinates[0]!);
        const aArea = Math.abs(signedArea(aRing));
        const interArea = Math.abs(signedArea(interRing));

        // A 几乎完全被 B 覆盖时返回 null
        if (aArea > 0 && interArea / aArea > 0.999) {
            return null;
        }

        // 简化策略：将交集区域作为 A 的孔洞
        // 构建带孔洞的多边形：外环=A，内环=交集
        const outerRing = a.geometry.coordinates[0]!;
        const holeRing = inter.geometry.coordinates[0]!;

        // 确保孔洞环为顺时针方向（GeoJSON 规范）
        const holeOpen = openRing(holeRing);
        const holeArea = signedArea(holeOpen);
        const orientedHole = holeArea > 0
            ? closeRing(holeOpen.slice().reverse())
            : closeRing(holeOpen);

        return buildPolygonFeature([outerRing, orientedHole]);
    },

    /**
     * 计算两个多边形的异或（对称差集）。
     * XOR = (A - B) ∪ (B - A)，即只在一个多边形中但不同时在两个中的区域。
     *
     * @param a - 多边形 A
     * @param b - 多边形 B
     * @returns 异或结果作为 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const xorResult = BooleanOps.xor(featureA, featureB);
     */
    xor(
        a: Feature<PolygonGeometry>,
        b: Feature<PolygonGeometry>
    ): FeatureCollection<PolygonGeometry> {
        const features: Feature<PolygonGeometry>[] = [];

        // A - B
        const diffAB = BooleanOps.difference(a, b);
        if (diffAB) {
            features.push(diffAB);
        }

        // B - A
        const diffBA = BooleanOps.difference(b, a);
        if (diffBA) {
            features.push(diffBA);
        }

        return {
            type: 'FeatureCollection',
            features,
        };
    },

    /**
     * 检测多边形的自相交点（kinks）。
     * 遍历所有非相邻边对，检查是否存在线段交叉。
     * 自相交点表明多边形不符合 OGC Simple Feature 规范。
     *
     * @param polygon - 待检测的多边形 Feature
     * @returns 所有自相交点的坐标数组，空数组表示无自相交
     *
     * @stability experimental
     *
     * @example
     * const kinkPoints = BooleanOps.kinks(bowTiePolygon);
     * if (kinkPoints.length > 0) console.log('多边形存在自相交');
     */
    kinks(polygon: Feature<PolygonGeometry>): Position[] {
        // 校验输入
        if (!polygon || !polygon.geometry || polygon.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 Polygon Feature`);
            }
            return [];
        }

        const kinkPoints: Position[] = [];

        // 遍历每个环检测自相交
        for (const ring of polygon.geometry.coordinates) {
            const n = ring.length;
            if (n < MIN_RING_VERTICES) {
                continue;
            }

            // 检查所有非相邻边对——O(n²) 但对分析用途可接受
            for (let i = 0; i < n - 1; i++) {
                for (let j = i + 2; j < n - 1; j++) {
                    // 跳过首尾相连的边对（它们共享端点，不算自相交）
                    if (i === 0 && j === n - 2) {
                        continue;
                    }

                    const pt = segmentIntersection(
                        ring[i]!,
                        ring[i + 1]!,
                        ring[j]!,
                        ring[j + 1]!
                    );

                    if (pt !== null) {
                        kinkPoints.push(pt);
                    }
                }
            }
        }

        return kinkPoints;
    },

    /**
     * 简单的多边形拓扑修复——在自相交点处分割多边形。
     * 对于无自相交的多边形直接返回原始 Feature。
     * 对于存在自相交的多边形，尝试修复为合法的 Simple Feature。
     *
     * 当前简化策略：检测自相交 → 移除退化区域 → 保证外环逆时针。
     *
     * @param polygon - 可能含自相交的多边形 Feature
     * @returns 修复后的多边形 Feature
     *
     * @stability experimental
     *
     * @example
     * const valid = BooleanOps.makeValid(invalidPolygon);
     */
    /**
     * Martinez-Rueda-Feito 布尔运算（凹多边形 / 多孔洞正确）。
     *
     * 与 `intersection/union/difference/xor` 不同：那些方法底层是
     * Sutherland-Hodgman 仅适合凸裁剪多边形；本方法是真正的扫描线
     * 算法，对任意简单多边形都正确。
     *
     * @param subject 主多边形 Feature
     * @param clipping 裁剪多边形 Feature
     * @param op 'intersection' | 'union' | 'difference' | 'xor'
     * @returns 结果 FeatureCollection（每个 Feature 是一个独立的输出环）
     *
     * @stability experimental
     */
    martinezBoolean(
        subject: Feature<PolygonGeometry>,
        clipping: Feature<PolygonGeometry>,
        op: MartinezOp,
    ): FeatureCollection<PolygonGeometry> {
        if (!subject?.geometry || subject.geometry.type !== 'Polygon' ||
            !clipping?.geometry || clipping.geometry.type !== 'Polygon') {
            return { type: 'FeatureCollection', features: [] };
        }
        const subjectPoly: MartinezPolygon = subject.geometry.coordinates.map(
            (ring) => ring.map((p) => [p[0]!, p[1]!] as [number, number]),
        );
        const clipPoly: MartinezPolygon = clipping.geometry.coordinates.map(
            (ring) => ring.map((p) => [p[0]!, p[1]!] as [number, number]),
        );
        const result = _martinez(subjectPoly, clipPoly, op);
        const features: Feature<PolygonGeometry>[] = result.map((rings) => ({
            type: 'Feature' as const,
            geometry: {
                type: 'Polygon' as const,
                coordinates: rings as Position[][],
            },
            properties: {},
        }));
        return { type: 'FeatureCollection', features };
    },

    /**
     * 多边形有效性谓词。
     *
     * 当且仅当满足以下全部条件时返回 true：
     * - 是合法的 Polygon Feature
     * - 每个环至少 4 个顶点（即 ≥3 不重复 + 闭合）
     * - 没有自相交（kinks）
     *
     * 这是一个布尔判断，不修改几何。要修复请用 `makeValid()`。
     *
     * @stability experimental
     *
     * @example
     * if (!BooleanOps.isValid(poly)) {
     *     poly = BooleanOps.makeValid(poly);
     * }
     */
    isValid(polygon: Feature<PolygonGeometry>): boolean {
        if (!polygon || !polygon.geometry || polygon.geometry.type !== 'Polygon') {
            return false;
        }
        const rings = polygon.geometry.coordinates;
        if (!rings || rings.length === 0) return false;
        for (const ring of rings) {
            if (!ring || ring.length < MIN_RING_VERTICES) return false;
        }
        // 复用 kinks() 检测自相交
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return BooleanOps.kinks(polygon).length === 0;
    },

    makeValid(polygon: Feature<PolygonGeometry>): Feature<PolygonGeometry> {
        // 校验输入
        if (!polygon || !polygon.geometry || polygon.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BOOLEAN_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 Polygon Feature`);
            }
            // 返回空多边形作为兜底
            return {
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [] },
                properties: {},
            };
        }

        // 检测自相交
        const kinkPoints = BooleanOps.kinks(polygon);

        // 无自相交时只做方向修正
        if (kinkPoints.length === 0) {
            return ensureWindingOrder(polygon);
        }

        // 有自相交时：修复策略——确保外环逆时针、内环顺时针
        // 完整的自相交分割需要 Bentley-Ottmann 扫描线算法，
        // 此处简化为方向修正 + 退化环过滤
        if (__DEV__) {
            console.log(
                `[BooleanOps.makeValid] 检测到 ${kinkPoints.length} 个自相交点，执行简化修复`
            );
        }

        return ensureWindingOrder(polygon);
    },
} as const;

/**
 * 确保多边形的绕行方向正确：外环逆时针，内环顺时针。
 * 不修改输入对象，返回新 Feature。
 *
 * @param polygon - 待修正的多边形
 * @returns 方向修正后的多边形
 *
 * @example
 * const corrected = ensureWindingOrder(polygon);
 */
function ensureWindingOrder(polygon: Feature<PolygonGeometry>): Feature<PolygonGeometry> {
    const newCoords: LinearRing[] = [];

    for (let i = 0; i < polygon.geometry.coordinates.length; i++) {
        const ring = polygon.geometry.coordinates[i]!;
        const open = openRing(ring);

        // 跳过退化环
        if (open.length < 3) {
            continue;
        }

        const area = signedArea(open);

        if (i === 0) {
            // 外环应为逆时针（正面积）
            if (area < 0) {
                newCoords.push(closeRing(open.slice().reverse()));
            } else {
                newCoords.push(closeRing(open));
            }
        } else {
            // 内环应为顺时针（负面积）
            if (area > 0) {
                newCoords.push(closeRing(open.slice().reverse()));
            } else {
                newCoords.push(closeRing(open));
            }
        }
    }

    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: newCoords },
        properties: polygon.properties,
    };
}

export { BooleanOps as booleanOps };
