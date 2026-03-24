// ============================================================
// analysis/aggregation/index.ts — 空间聚合
// 职责：基于空间关系（点在多边形内）对要素进行统计聚合。
// 提供 collect（收集）、count/sum/avg/median/deviation 等统计方法。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { Position, PointGeometry, PolygonGeometry } from '../../../core/src/types/geometry.ts';
import type { Feature, FeatureCollection } from '../../../core/src/types/feature.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const AGGREGATION_ERROR_CODES = {
    /** 输入数据无效 */
    INVALID_DATA: 'AGGREGATION_INVALID_DATA',
    /** 属性名无效 */
    INVALID_PROPERTY: 'AGGREGATION_INVALID_PROPERTY',
} as const;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 射线法（Ray Casting）判断点是否在多边形内。
 * 从点向右发射水平射线，计算与多边形边界的交点数。
 * 奇数交点 = 在内部，偶数交点 = 在外部。
 *
 * @param px - 点的 x 坐标（经度）
 * @param py - 点的 y 坐标（纬度）
 * @param ring - 多边形环的坐标数组
 * @returns true 表示点在环内
 *
 * @example
 * pointInRing(0.5, 0.5, [[0,0],[1,0],[1,1],[0,1],[0,0]]); // → true
 */
function pointInRing(px: number, py: number, ring: readonly Position[]): boolean {
    let inside = false;
    const n = ring.length;

    // 遍历多边形的每条边
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i]![0];
        const yi = ring[i]![1];
        const xj = ring[j]![0];
        const yj = ring[j]![1];

        // 检查射线是否与当前边相交
        // 条件：边的 y 范围跨越 py，且交点 x > px
        const intersects = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi);

        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * 判断点是否在多边形内（考虑孔洞）。
 * 在外环内 且 不在任何内环内 = 在多边形内。
 *
 * @param px - 点 x
 * @param py - 点 y
 * @param polygon - 多边形的 coordinates（环数组）
 * @returns true 表示点在多边形内
 *
 * @example
 * pointInPolygon(0.5, 0.5, polygon.coordinates); // → true
 */
function pointInPolygon(
    px: number,
    py: number,
    polygon: readonly (readonly Position[])[]
): boolean {
    // 必须在外环内
    const outerRing = polygon[0];
    if (!outerRing || !pointInRing(px, py, outerRing)) {
        return false;
    }

    // 检查是否在任何孔洞内——如果是则不在多边形内
    for (let i = 1; i < polygon.length; i++) {
        const hole = polygon[i]!;
        if (pointInRing(px, py, hole)) {
            return false;
        }
    }

    return true;
}

/**
 * 提取 Feature 属性中指定字段的数值。
 * 自动跳过 NaN、Infinity、非数值类型。
 *
 * @param feature - 要素
 * @param property - 属性名
 * @returns 数值，或 NaN 表示无效
 *
 * @example
 * getNumericValue(feature, 'population'); // → 50000
 */
function getNumericValue(feature: Feature<PointGeometry>, property: string): number {
    const val = feature.properties?.[property];
    if (typeof val === 'number' && isFinite(val)) {
        return val;
    }
    return NaN;
}

// ---------------------------------------------------------------------------
// AggregationOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 空间聚合运算集合。
 * 将点要素按空间关系聚合到多边形要素中，计算统计值。
 *
 * @stability experimental
 *
 * @example
 * const result = AggregationOps.count(polygons, points);
 */
export const AggregationOps = {
    /**
     * 收集落入每个多边形内的点要素。
     * 对每个多边形，找出所有在其内部的点，将指定属性值收集为数组。
     *
     * @param polygons - 多边形集合（聚合容器）
     * @param points - 点集合（被聚合对象）
     * @param property - 要收集的点属性名
     * @returns 新的多边形 FeatureCollection，每个多边形增加 `collected` 属性
     *
     * @stability experimental
     *
     * @example
     * const result = AggregationOps.collect(polygons, points, 'temperature');
     * // result.features[0].properties.collected → [20.5, 21.0, 19.8]
     */
    collect(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>,
        property: string
    ): FeatureCollection<PolygonGeometry> {
        // 校验输入
        if (!polygons || !polygons.features || !points || !points.features) {
            if (__DEV__) {
                console.warn(`[${AGGREGATION_ERROR_CODES.INVALID_DATA}] 输入 FeatureCollection 无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        if (!property || typeof property !== 'string') {
            if (__DEV__) {
                console.warn(`[${AGGREGATION_ERROR_CODES.INVALID_PROPERTY}] 属性名无效`);
            }
            return polygons;
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            const collected: unknown[] = [];

            // 遍历所有点判断是否在当前多边形内
            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') {
                    continue;
                }

                const [px, py] = pt.geometry.coordinates;

                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    // 收集该点的指定属性值
                    const val = pt.properties?.[property];
                    if (val !== undefined) {
                        collected.push(val);
                    }
                }
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: {
                    ...poly.properties,
                    collected,
                },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 计算每个多边形内的点数。
     *
     * @param polygons - 多边形集合
     * @param points - 点集合
     * @returns 每个多边形增加 `count` 属性
     *
     * @stability stable
     *
     * @example
     * const result = AggregationOps.count(polygons, points);
     * // result.features[0].properties.count → 42
     */
    count(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>
    ): FeatureCollection<PolygonGeometry> {
        if (!polygons || !polygons.features || !points || !points.features) {
            if (__DEV__) {
                console.warn(`[${AGGREGATION_ERROR_CODES.INVALID_DATA}] 输入无效`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            let count = 0;

            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') continue;
                const [px, py] = pt.geometry.coordinates;
                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    count++;
                }
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: { ...poly.properties, count },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 计算每个多边形内点的指定属性值之和。
     *
     * @param polygons - 多边形集合
     * @param points - 点集合
     * @param property - 求和的属性名
     * @returns 每个多边形增加 `sum` 属性
     *
     * @stability stable
     *
     * @example
     * const result = AggregationOps.sum(polygons, points, 'revenue');
     */
    sum(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>,
        property: string
    ): FeatureCollection<PolygonGeometry> {
        if (!polygons || !polygons.features || !points || !points.features) {
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            let total = 0;
            let hasValue = false;

            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') continue;
                const [px, py] = pt.geometry.coordinates;
                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    const val = getNumericValue(pt, property);
                    if (!isNaN(val)) {
                        total += val;
                        hasValue = true;
                    }
                }
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: { ...poly.properties, sum: hasValue ? total : null },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 计算每个多边形内点的指定属性值的平均值。
     *
     * @param polygons - 多边形集合
     * @param points - 点集合
     * @param property - 求平均的属性名
     * @returns 每个多边形增加 `avg` 属性
     *
     * @stability stable
     *
     * @example
     * const result = AggregationOps.avg(polygons, points, 'temperature');
     */
    avg(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>,
        property: string
    ): FeatureCollection<PolygonGeometry> {
        if (!polygons || !polygons.features || !points || !points.features) {
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            let total = 0;
            let count = 0;

            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') continue;
                const [px, py] = pt.geometry.coordinates;
                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    const val = getNumericValue(pt, property);
                    if (!isNaN(val)) {
                        total += val;
                        count++;
                    }
                }
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: {
                    ...poly.properties,
                    avg: count > 0 ? total / count : null,
                },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 计算每个多边形内点的指定属性值的中位数。
     *
     * @param polygons - 多边形集合
     * @param points - 点集合
     * @param property - 求中位数的属性名
     * @returns 每个多边形增加 `median` 属性
     *
     * @stability experimental
     *
     * @example
     * const result = AggregationOps.median(polygons, points, 'price');
     */
    median(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>,
        property: string
    ): FeatureCollection<PolygonGeometry> {
        if (!polygons || !polygons.features || !points || !points.features) {
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            const values: number[] = [];

            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') continue;
                const [px, py] = pt.geometry.coordinates;
                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    const val = getNumericValue(pt, property);
                    if (!isNaN(val)) {
                        values.push(val);
                    }
                }
            }

            let medianVal: number | null = null;
            if (values.length > 0) {
                values.sort((a, b) => a - b);
                const mid = Math.floor(values.length / 2);
                // 偶数个取中间两个的平均，奇数个取中间值
                medianVal = values.length % 2 === 0
                    ? (values[mid - 1]! + values[mid]!) / 2
                    : values[mid]!;
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: { ...poly.properties, median: medianVal },
            });
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 计算每个多边形内点的指定属性值的标准差。
     *
     * @param polygons - 多边形集合
     * @param points - 点集合
     * @param property - 求标准差的属性名
     * @returns 每个多边形增加 `deviation` 属性
     *
     * @stability experimental
     *
     * @example
     * const result = AggregationOps.deviation(polygons, points, 'temperature');
     */
    deviation(
        polygons: FeatureCollection<PolygonGeometry>,
        points: FeatureCollection<PointGeometry>,
        property: string
    ): FeatureCollection<PolygonGeometry> {
        if (!polygons || !polygons.features || !points || !points.features) {
            return { type: 'FeatureCollection', features: [] };
        }

        const features: Feature<PolygonGeometry>[] = [];

        for (const poly of polygons.features) {
            if (!poly.geometry || poly.geometry.type !== 'Polygon') {
                features.push(poly);
                continue;
            }

            const values: number[] = [];

            for (const pt of points.features) {
                if (!pt.geometry || pt.geometry.type !== 'Point') continue;
                const [px, py] = pt.geometry.coordinates;
                if (pointInPolygon(px, py, poly.geometry.coordinates)) {
                    const val = getNumericValue(pt, property);
                    if (!isNaN(val)) {
                        values.push(val);
                    }
                }
            }

            let dev: number | null = null;
            if (values.length > 0) {
                // 计算均值
                let sum = 0;
                for (const v of values) sum += v;
                const mean = sum / values.length;

                // 计算方差
                let sumSq = 0;
                for (const v of values) {
                    const diff = v - mean;
                    sumSq += diff * diff;
                }

                // 总体标准差
                dev = Math.sqrt(sumSq / values.length);
            }

            features.push({
                type: 'Feature',
                geometry: poly.geometry,
                properties: { ...poly.properties, deviation: dev },
            });
        }

        return { type: 'FeatureCollection', features };
    },
} as const;

export { AggregationOps as aggregationOps };
