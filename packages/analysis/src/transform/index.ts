// ============================================================
// analysis/transform/index.ts — 几何变换
// 职责：对 GeoJSON Feature 执行坐标级几何变换——旋转、缩放、平移、翻转、
//       多边形绕行方向修正、冗余坐标清理。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { Position, Geometry, PolygonGeometry, LinearRing } from '../../../core/src/types/geometry.ts';
import type { Feature } from '../../../core/src/types/feature.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const TRANSFORM_ERROR_CODES = {
    /** 输入 Feature 无效 */
    INVALID_FEATURE: 'TRANSFORM_INVALID_FEATURE',
    /** 旋转角度无效 */
    INVALID_ANGLE: 'TRANSFORM_INVALID_ANGLE',
    /** 缩放因子无效 */
    INVALID_SCALE: 'TRANSFORM_INVALID_SCALE',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 度→弧度 */
const DEG_TO_RAD = Math.PI / 180.0;

/** 重复坐标判定 epsilon */
const COORD_EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 计算 Feature 所有坐标的质心（算术平均）。
 * 用作默认的旋转/缩放中心点。
 *
 * @param coords - 扁平化的坐标数组
 * @returns 质心 [x, y]
 *
 * @example
 * centroid([[0,0],[2,0],[2,2],[0,2]]); // → [1, 1]
 */
function centroid(coords: Position[]): Position {
    if (coords.length === 0) {
        return [0, 0] as Position;
    }

    let sumX = 0;
    let sumY = 0;
    for (const c of coords) {
        sumX += c[0];
        sumY += c[1];
    }

    return [sumX / coords.length, sumY / coords.length] as Position;
}

/**
 * 递归提取 Geometry 中所有 Position 坐标（扁平化）。
 *
 * @param geometry - GeoJSON 几何对象
 * @returns 扁平化的 Position 数组
 *
 * @example
 * flattenCoords(pointGeometry); // → [[lon, lat]]
 */
function flattenCoords(geometry: Geometry): Position[] {
    const result: Position[] = [];

    switch (geometry.type) {
        case 'Point':
            result.push(geometry.coordinates);
            break;
        case 'MultiPoint':
        case 'LineString':
            for (const pos of geometry.coordinates) {
                result.push(pos);
            }
            break;
        case 'MultiLineString':
        case 'Polygon':
            for (const ring of geometry.coordinates) {
                for (const pos of ring) {
                    result.push(pos);
                }
            }
            break;
        case 'MultiPolygon':
            for (const polygon of geometry.coordinates) {
                for (const ring of polygon) {
                    for (const pos of ring) {
                        result.push(pos);
                    }
                }
            }
            break;
        case 'GeometryCollection':
            for (const geom of geometry.geometries) {
                result.push(...flattenCoords(geom));
            }
            break;
    }

    return result;
}

/**
 * 对单个坐标执行 2D 旋转变换。
 *
 * @param pos - 原始坐标
 * @param angleRad - 旋转角度（弧度，逆时针为正）
 * @param cx - 旋转中心 x
 * @param cy - 旋转中心 y
 * @returns 旋转后的坐标
 *
 * @example
 * rotatePoint([1, 0], Math.PI / 2, 0, 0); // → [0, 1]
 */
function rotatePoint(pos: Position, angleRad: number, cx: number, cy: number): Position {
    const dx = pos[0] - cx;
    const dy = pos[1] - cy;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    const nx = dx * cosA - dy * sinA + cx;
    const ny = dx * sinA + dy * cosA + cy;

    // 保持原始坐标维度（2D 或 3D）
    if (pos.length === 3) {
        return [nx, ny, pos[2]] as Position;
    }
    return [nx, ny] as Position;
}

/**
 * 递归地对 Geometry 内所有坐标应用变换函数。
 * 返回新 Geometry 对象，不修改输入。
 *
 * @param geometry - 原始几何
 * @param transformFn - 坐标变换函数
 * @returns 变换后的新几何
 *
 * @example
 * const moved = mapCoords(geom, pos => [pos[0]+1, pos[1]+1]);
 */
function mapCoords(geometry: Geometry, transformFn: (pos: Position) => Position): Geometry {
    switch (geometry.type) {
        case 'Point':
            return { type: 'Point', coordinates: transformFn(geometry.coordinates) };
        case 'MultiPoint':
            return { type: 'MultiPoint', coordinates: geometry.coordinates.map(transformFn) };
        case 'LineString':
            return { type: 'LineString', coordinates: geometry.coordinates.map(transformFn) };
        case 'MultiLineString':
            return {
                type: 'MultiLineString',
                coordinates: geometry.coordinates.map(ring => ring.map(transformFn)),
            };
        case 'Polygon':
            return {
                type: 'Polygon',
                coordinates: geometry.coordinates.map(ring => ring.map(transformFn)),
            };
        case 'MultiPolygon':
            return {
                type: 'MultiPolygon',
                coordinates: geometry.coordinates.map(poly => poly.map(ring => ring.map(transformFn))),
            };
        case 'GeometryCollection':
            return {
                type: 'GeometryCollection',
                geometries: geometry.geometries.map(g => mapCoords(g, transformFn)),
            };
        default:
            return geometry;
    }
}

/**
 * 计算多边形环的有符号面积（Shoelace 公式）。
 * 正值=逆时针，负值=顺时针。
 *
 * @param ring - 环的坐标数组
 * @returns 有符号面积
 */
function signedArea(ring: Position[]): number {
    let area = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += ring[i]![0] * ring[j]![1];
        area -= ring[j]![0] * ring[i]![1];
    }
    return area * 0.5;
}

// ---------------------------------------------------------------------------
// TransformOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 几何变换运算集合。
 * 对 Feature 的几何坐标执行旋转、缩放、平移、翻转、绕行方向修正、坐标清理。
 *
 * @stability experimental
 *
 * @example
 * const rotated = TransformOps.rotate(feature, 45);
 */
export const TransformOps = {
    /**
     * 旋转几何。
     * 绕指定中心点（默认质心）逆时针旋转指定角度。
     *
     * @param feature - 输入 Feature
     * @param angleDeg - 旋转角度（度，逆时针为正）
     * @param pivot - 旋转中心 [x, y]，默认为几何质心
     * @returns 旋转后的新 Feature
     *
     * @stability experimental
     *
     * @example
     * const rotated = TransformOps.rotate(feature, 90);
     * const rotatedPivot = TransformOps.rotate(feature, 45, [0, 0]);
     */
    rotate(feature: Feature, angleDeg: number, pivot?: Position): Feature {
        if (!feature || !feature.geometry) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] Feature 或 geometry 为空`);
            }
            return feature;
        }

        if (!isFinite(angleDeg)) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_ANGLE}] 角度无效: ${angleDeg}`);
            }
            return feature;
        }

        // 角度为 0 时无需变换
        if (angleDeg === 0) {
            return feature;
        }

        const angleRad = angleDeg * DEG_TO_RAD;

        // 确定旋转中心
        const center = pivot ?? centroid(flattenCoords(feature.geometry));
        const cx = center[0];
        const cy = center[1];

        const newGeometry = mapCoords(feature.geometry, pos =>
            rotatePoint(pos, angleRad, cx, cy)
        );

        return { type: 'Feature', geometry: newGeometry, properties: feature.properties };
    },

    /**
     * 缩放几何。
     * 以指定中心点（默认质心）为原点，对所有坐标进行缩放。
     *
     * @param feature - 输入 Feature
     * @param factor - 缩放因子（>0），1.0 = 不变，2.0 = 放大一倍
     * @param origin - 缩放原点 [x, y]，默认为几何质心
     * @returns 缩放后的新 Feature
     *
     * @stability experimental
     *
     * @example
     * const doubled = TransformOps.scale(feature, 2.0);
     */
    scale(feature: Feature, factor: number, origin?: Position): Feature {
        if (!feature || !feature.geometry) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] Feature 或 geometry 为空`);
            }
            return feature;
        }

        if (!isFinite(factor) || factor <= 0) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_SCALE}] 缩放因子必须 > 0，当前: ${factor}`);
            }
            return feature;
        }

        if (factor === 1.0) {
            return feature;
        }

        const center = origin ?? centroid(flattenCoords(feature.geometry));
        const cx = center[0];
        const cy = center[1];

        const newGeometry = mapCoords(feature.geometry, pos => {
            const nx = (pos[0] - cx) * factor + cx;
            const ny = (pos[1] - cy) * factor + cy;
            if (pos.length === 3) {
                return [nx, ny, pos[2]] as Position;
            }
            return [nx, ny] as Position;
        });

        return { type: 'Feature', geometry: newGeometry, properties: feature.properties };
    },

    /**
     * 平移几何。
     * 将所有坐标在 x/y 方向上偏移指定距离（度）。
     *
     * @param feature - 输入 Feature
     * @param dx - x 方向偏移量（度/经度）
     * @param dy - y 方向偏移量（度/纬度）
     * @returns 平移后的新 Feature
     *
     * @stability stable
     *
     * @example
     * const moved = TransformOps.translate(feature, 1.0, -0.5);
     */
    translate(feature: Feature, dx: number, dy: number): Feature {
        if (!feature || !feature.geometry) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] Feature 或 geometry 为空`);
            }
            return feature;
        }

        if (!isFinite(dx) || !isFinite(dy)) {
            return feature;
        }

        if (dx === 0 && dy === 0) {
            return feature;
        }

        const newGeometry = mapCoords(feature.geometry, pos => {
            if (pos.length === 3) {
                return [pos[0] + dx, pos[1] + dy, pos[2]] as Position;
            }
            return [pos[0] + dx, pos[1] + dy] as Position;
        });

        return { type: 'Feature', geometry: newGeometry, properties: feature.properties };
    },

    /**
     * 翻转几何。
     * 沿 x 轴和/或 y 轴翻转（以指定中心为对称轴）。
     *
     * @param feature - 输入 Feature
     * @param flipX - 是否沿 x 轴翻转（上下翻转）
     * @param flipY - 是否沿 y 轴翻转（左右翻转）
     * @param origin - 翻转中心 [x, y]，默认为几何质心
     * @returns 翻转后的新 Feature
     *
     * @stability experimental
     *
     * @example
     * const flipped = TransformOps.flip(feature, true, false); // 上下翻转
     */
    flip(feature: Feature, flipX: boolean, flipY: boolean, origin?: Position): Feature {
        if (!feature || !feature.geometry) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] Feature 或 geometry 为空`);
            }
            return feature;
        }

        if (!flipX && !flipY) {
            return feature;
        }

        const center = origin ?? centroid(flattenCoords(feature.geometry));
        const cx = center[0];
        const cy = center[1];

        const newGeometry = mapCoords(feature.geometry, pos => {
            const nx = flipY ? 2 * cx - pos[0] : pos[0];
            const ny = flipX ? 2 * cy - pos[1] : pos[1];
            if (pos.length === 3) {
                return [nx, ny, pos[2]] as Position;
            }
            return [nx, ny] as Position;
        });

        return { type: 'Feature', geometry: newGeometry, properties: feature.properties };
    },

    /**
     * 修正多边形绕行方向（Winding Order）。
     * 确保外环为逆时针（CCW），内环为顺时针（CW），符合 RFC 7946 规范。
     *
     * @param feature - 多边形 Feature
     * @returns 修正后的新 Feature
     *
     * @stability stable
     *
     * @example
     * const corrected = TransformOps.rewindPolygon(feature);
     */
    rewindPolygon(feature: Feature<PolygonGeometry>): Feature<PolygonGeometry> {
        if (!feature || !feature.geometry || feature.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] 参数必须是 Polygon Feature`);
            }
            return feature;
        }

        const newRings: LinearRing[] = [];

        for (let i = 0; i < feature.geometry.coordinates.length; i++) {
            const ring = feature.geometry.coordinates[i]!;

            if (ring.length < 4) {
                newRings.push(ring);
                continue;
            }

            // 计算有符号面积
            const area = signedArea(ring);

            if (i === 0) {
                // 外环应为逆时针（正面积）
                if (area < 0) {
                    newRings.push([...ring].reverse() as LinearRing);
                } else {
                    newRings.push(ring);
                }
            } else {
                // 内环应为顺时针（负面积）
                if (area > 0) {
                    newRings.push([...ring].reverse() as LinearRing);
                } else {
                    newRings.push(ring);
                }
            }
        }

        return {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: newRings },
            properties: feature.properties,
        };
    },

    /**
     * 清理坐标——移除重复顶点和退化线段。
     * 遍历所有坐标，移除与前一个坐标完全相同（在 epsilon 内）的点。
     * 保留首尾闭合点（环的闭合特性不受影响）。
     *
     * @param feature - 输入 Feature
     * @returns 清理后的新 Feature
     *
     * @stability experimental
     *
     * @example
     * const cleaned = TransformOps.cleanCoords(duplicatedFeature);
     */
    cleanCoords(feature: Feature): Feature {
        if (!feature || !feature.geometry) {
            if (__DEV__) {
                console.warn(`[${TRANSFORM_ERROR_CODES.INVALID_FEATURE}] Feature 或 geometry 为空`);
            }
            return feature;
        }

        /**
         * 清理坐标数组——移除连续重复点。
         */
        const cleanPositions = (coords: Position[], isRing: boolean): Position[] => {
            if (coords.length <= 1) {
                return [...coords];
            }

            const cleaned: Position[] = [coords[0]!];

            // 遍历后续点，跳过与前一个相同的
            for (let i = 1; i < coords.length; i++) {
                const prev = cleaned[cleaned.length - 1]!;
                const curr = coords[i]!;

                const dx = Math.abs(curr[0] - prev[0]);
                const dy = Math.abs(curr[1] - prev[1]);

                // 如果是最后一个点且是环，保留闭合点
                if (i === coords.length - 1 && isRing) {
                    cleaned.push(curr);
                    continue;
                }

                // 跳过重复点
                if (dx > COORD_EPSILON || dy > COORD_EPSILON) {
                    cleaned.push(curr);
                }
            }

            return cleaned;
        };

        // 对不同几何类型递归处理
        const cleanGeometry = (geom: Geometry): Geometry => {
            switch (geom.type) {
                case 'Point':
                    return geom;
                case 'MultiPoint':
                    return { type: 'MultiPoint', coordinates: cleanPositions(geom.coordinates, false) };
                case 'LineString':
                    return { type: 'LineString', coordinates: cleanPositions(geom.coordinates, false) };
                case 'MultiLineString':
                    return {
                        type: 'MultiLineString',
                        coordinates: geom.coordinates.map(ring => cleanPositions(ring, false)),
                    };
                case 'Polygon':
                    return {
                        type: 'Polygon',
                        coordinates: geom.coordinates.map(ring => cleanPositions(ring, true)),
                    };
                case 'MultiPolygon':
                    return {
                        type: 'MultiPolygon',
                        coordinates: geom.coordinates.map(poly =>
                            poly.map(ring => cleanPositions(ring, true))
                        ),
                    };
                case 'GeometryCollection':
                    return {
                        type: 'GeometryCollection',
                        geometries: geom.geometries.map(cleanGeometry),
                    };
                default:
                    return geom;
            }
        };

        return {
            type: 'Feature',
            geometry: cleanGeometry(feature.geometry),
            properties: feature.properties,
        };
    },
} as const;

export { TransformOps as transformOps };
