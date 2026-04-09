// ============================================================
// analysis/buffer/index.ts — 缓冲区分析
// 职责：对点、线、面几何对象创建指定距离的缓冲区多边形。
// 使用 Vincenty 椭球测地线（WGS84）计算缓冲区顶点位置，
// 高纬度精度优于球面 Haversine（典型 < 0.5mm）。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type {
    Position,
    PolygonGeometry,
    LineStringGeometry,
    PointGeometry,
} from '../../../core/src/types/geometry.ts';
import type { Feature } from '../../../core/src/types/feature.ts';
import { vincentyDirect } from '../../../core/src/geo/geodesic.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const BUFFER_ERROR_CODES = {
    /** 输入几何类型不合法 */
    INVALID_GEOMETRY: 'BUFFER_INVALID_GEOMETRY',
    /** 缓冲距离无效 */
    INVALID_DISTANCE: 'BUFFER_INVALID_DISTANCE',
    /** 圆弧步数无效 */
    INVALID_STEPS: 'BUFFER_INVALID_STEPS',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 地球平均半径（米），WGS84 椭球体 */
const EARTH_RADIUS_M = 6_371_008.8;

/** 度→弧度转换常量 */
const DEG_TO_RAD = Math.PI / 180.0;

/** 弧度→度转换常量 */
const RAD_TO_DEG = 180.0 / Math.PI;

/** 默认圆弧细分步数——64 步足以保证视觉圆滑 */
const DEFAULT_STEPS = 64;

/** 最小步数——至少 4 步才能形成闭合多边形 */
const MIN_STEPS = 4;

/** 最大步数——过多步数导致顶点爆炸 */
const MAX_STEPS = 360;

/** 最小缓冲距离（米）——过小的缓冲无意义 */
const MIN_DISTANCE_M = 0.001;

/** 最大缓冲距离（米）——不超过地球半周长 */
const MAX_DISTANCE_M = Math.PI * EARTH_RADIUS_M;

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 根据 Haversine 公式计算从起点出发、沿给定方位角（bearing）前进指定距离后的终点。
 * 这是大圆导航的核心公式，用于在球面上计算测地线终点。
 *
 * @param lon - 起点经度（度）
 * @param lat - 起点纬度（度）
 * @param distanceM - 前进距离（米）
 * @param bearingDeg - 方位角（度），0=正北，90=正东，顺时针
 * @returns 终点坐标 [longitude, latitude]（度）
 *
 * @example
 * destination(116.39, 39.91, 1000, 90); // → 东偏 1km 的坐标
 */
function destination(
    lon: number,
    lat: number,
    distanceM: number,
    bearingDeg: number
): Position {
    // Vincenty 椭球测地线（WGS84）：相比球面 Haversine 在高纬度精度好得多
    // （典型距离误差 < 0.5mm vs Haversine 的 ~30m / 10km）。
    // vincentyDirect 接口用弧度，直接转换并提取 lon/lat。
    const result = vincentyDirect(
        lon * DEG_TO_RAD,
        lat * DEG_TO_RAD,
        bearingDeg * DEG_TO_RAD,
        distanceM,
    );

    // 经度归一化到 [-180, 180]
    const destLon = ((result.lon * RAD_TO_DEG + 540) % 360) - 180;
    const destLat = result.lat * RAD_TO_DEG;

    return [destLon, destLat] as Position;
}

/**
 * 计算两点之间的方位角（初始方向角）。
 * 返回值范围 [0, 360)，0=正北，90=正东。
 *
 * @param lon1 - 起点经度（度）
 * @param lat1 - 起点纬度（度）
 * @param lon2 - 终点经度（度）
 * @param lat2 - 终点纬度（度）
 * @returns 方位角（度）
 *
 * @example
 * bearing(0, 0, 1, 0); // → 90 (正东)
 */
function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const lat1Rad = lat1 * DEG_TO_RAD;
    const lat2Rad = lat2 * DEG_TO_RAD;
    const dLonRad = (lon2 - lon1) * DEG_TO_RAD;

    const y = Math.sin(dLonRad) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
        Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLonRad);

    // atan2 返回 [-π, π]，转换到 [0, 360)
    const bearingDeg = (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;

    return bearingDeg;
}

/**
 * 计算线段在给定顶点处的左侧或右侧法向量方位角。
 * 用于线缓冲区的平行偏移方向计算。
 *
 * @param prev - 前一个顶点
 * @param current - 当前顶点
 * @param next - 下一个顶点（可选，若无则用 prev→current 的方向）
 * @param side - 偏移方向，'left' 或 'right'
 * @returns 法向量方位角（度）
 *
 * @example
 * perpendicularBearing([0,0], [1,0], [2,0], 'left'); // → 0 (正北)
 */
function perpendicularBearing(
    prev: Position,
    current: Position,
    next: Position | null,
    side: 'left' | 'right'
): number {
    // 计算线段方向角
    let segBearing: number;
    if (next !== null) {
        // 取前后线段的平均方向——角平分线法，产生平滑的偏移方向
        const bearingIn = bearing(prev[0], prev[1], current[0], current[1]);
        const bearingOut = bearing(current[0], current[1], next[0], next[1]);
        segBearing = (bearingIn + bearingOut) * 0.5;
    } else {
        segBearing = bearing(prev[0], prev[1], current[0], current[1]);
    }

    // 垂直偏移：左侧 -90°，右侧 +90°
    const offset = side === 'left' ? -90 : 90;
    return (segBearing + offset + 360) % 360;
}

// ---------------------------------------------------------------------------
// BufferOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 缓冲区分析运算集合。
 * 对点/线/面几何创建指定距离（米）的缓冲区多边形。
 * 所有距离参数单位为米，使用 Haversine 测地线计算。
 *
 * @stability experimental
 *
 * @example
 * const circleBuffer = BufferOps.pointBuffer(pointFeature, 1000, 64);
 */
export const BufferOps = {
    /**
     * 为点创建圆形缓冲区。
     * 通过 Haversine destination 在每个方位角上计算圆弧顶点，
     * 生成近似圆形的多边形。
     *
     * @param point - 点 Feature
     * @param distanceM - 缓冲半径（米），范围 [0.001, ~20000km]
     * @param steps - 圆弧细分步数，范围 [4, 360]，默认 64
     * @returns 圆形缓冲区多边形 Feature
     *
     * @stability experimental
     *
     * @example
     * const circle = BufferOps.pointBuffer(
     *   { type: 'Feature', geometry: { type: 'Point', coordinates: [116.39, 39.91] }, properties: {} },
     *   1000, 64
     * );
     */
    pointBuffer(
        point: Feature<PointGeometry>,
        distanceM: number,
        steps: number = DEFAULT_STEPS
    ): Feature<PolygonGeometry> | null {
        // 校验输入几何类型
        if (!point || !point.geometry || point.geometry.type !== 'Point') {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 Point Feature`);
            }
            return null;
        }

        // 校验缓冲距离
        if (!isFinite(distanceM) || distanceM < MIN_DISTANCE_M || distanceM > MAX_DISTANCE_M) {
            if (__DEV__) {
                console.warn(
                    `[${BUFFER_ERROR_CODES.INVALID_DISTANCE}] 距离必须在 [${MIN_DISTANCE_M}, ${MAX_DISTANCE_M}] 范围内，当前值: ${distanceM}`
                );
            }
            return null;
        }

        // 校验步数
        const safeSteps = Math.round(Math.max(MIN_STEPS, Math.min(MAX_STEPS, steps)));

        const center = point.geometry.coordinates;
        const lon = center[0];
        const lat = center[1];

        // 每步对应的角度增量（度）
        const angleStep = 360.0 / safeSteps;

        // 在每个方位角上计算缓冲区顶点
        const ring: Position[] = [];
        for (let i = 0; i < safeSteps; i++) {
            const bearingDeg = i * angleStep;
            const pt = destination(lon, lat, distanceM, bearingDeg);
            ring.push(pt);
        }

        // 闭合环：添加第一个点作为尾点
        if (ring.length > 0) {
            ring.push([ring[0]![0], ring[0]![1]] as Position);
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [ring],
            },
            properties: point.properties,
        };
    },

    /**
     * 为线创建缓冲区。
     * 沿线两侧各偏移 distanceM 生成平行线，首尾用半圆弧封闭。
     *
     * @param line - 线 Feature
     * @param distanceM - 缓冲宽度（米），线两侧各偏移此距离
     * @param steps - 端帽/转角圆弧细分步数，默认 16
     * @returns 缓冲区多边形 Feature
     *
     * @stability experimental
     *
     * @example
     * const lineBuffer = BufferOps.lineBuffer(lineFeature, 100, 16);
     */
    lineBuffer(
        line: Feature<LineStringGeometry>,
        distanceM: number,
        steps: number = 16
    ): Feature<PolygonGeometry> | null {
        // 校验输入
        if (!line || !line.geometry || line.geometry.type !== 'LineString') {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 LineString Feature`);
            }
            return null;
        }

        if (!isFinite(distanceM) || distanceM < MIN_DISTANCE_M || distanceM > MAX_DISTANCE_M) {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_DISTANCE}] 距离无效: ${distanceM}`);
            }
            return null;
        }

        const coords = line.geometry.coordinates;
        if (coords.length < 2) {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] LineString 至少需要 2 个顶点`);
            }
            return null;
        }

        const safeSteps = Math.round(Math.max(MIN_STEPS, Math.min(MAX_STEPS, steps)));

        // 构建左侧偏移线（从起点到终点）
        const leftOffsets: Position[] = [];
        // 构建右侧偏移线（从终点到起点——反向以形成闭合环）
        const rightOffsets: Position[] = [];

        for (let i = 0; i < coords.length; i++) {
            const current = coords[i]!;
            const prev = i > 0 ? coords[i - 1]! : null;
            const next = i < coords.length - 1 ? coords[i + 1]! : null;

            // 计算左侧法向量方位角
            const leftBearing = prev !== null
                ? perpendicularBearing(prev, current, next, 'left')
                : perpendicularBearing(current, next!, null, 'left');

            // 计算右侧法向量方位角
            const rightBearing = prev !== null
                ? perpendicularBearing(prev, current, next, 'right')
                : perpendicularBearing(current, next!, null, 'right');

            // 沿法向量偏移 distanceM
            leftOffsets.push(destination(current[0], current[1], distanceM, leftBearing));
            rightOffsets.push(destination(current[0], current[1], distanceM, rightBearing));
        }

        // 构建完整的缓冲区环：左侧线 + 终点半圆弧 + 右侧线反向 + 起点半圆弧
        const ring: Position[] = [];

        // 1. 左侧偏移线（起点到终点）
        for (const pt of leftOffsets) {
            ring.push(pt);
        }

        // 2. 终点半圆弧（从左侧终点绕到右侧终点）
        const endPt = coords[coords.length - 1]!;
        const endPrev = coords[coords.length - 2]!;
        const endBearing = bearing(endPrev[0], endPrev[1], endPt[0], endPt[1]);
        // 半圆弧从 endBearing-90 到 endBearing+90
        const halfSteps = Math.max(2, Math.round(safeSteps / 4));
        for (let i = 0; i <= halfSteps; i++) {
            const angle = (endBearing - 90) + (180 * i / halfSteps);
            ring.push(destination(endPt[0], endPt[1], distanceM, angle));
        }

        // 3. 右侧偏移线（终点到起点——反向）
        for (let i = rightOffsets.length - 1; i >= 0; i--) {
            ring.push(rightOffsets[i]!);
        }

        // 4. 起点半圆弧（从右侧起点绕到左侧起点）
        const startPt = coords[0]!;
        const startNext = coords[1]!;
        const startBearing = bearing(startPt[0], startPt[1], startNext[0], startNext[1]);
        for (let i = 0; i <= halfSteps; i++) {
            const angle = (startBearing + 90) + (180 * i / halfSteps);
            ring.push(destination(startPt[0], startPt[1], distanceM, angle));
        }

        // 闭合环
        if (ring.length > 0) {
            ring.push([ring[0]![0], ring[0]![1]] as Position);
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [ring],
            },
            properties: line.properties,
        };
    },

    /**
     * 为多边形创建外扩缓冲区。
     * 对外环的每个顶点沿法向量外扩 distanceM。
     *
     * @param polygon - 面 Feature
     * @param distanceM - 外扩距离（米）
     * @param steps - 转角圆弧细分步数，默认 16
     * @returns 外扩缓冲区多边形 Feature
     *
     * @stability experimental
     *
     * @example
     * const expanded = BufferOps.polygonBuffer(polygonFeature, 500);
     */
    polygonBuffer(
        polygon: Feature<PolygonGeometry>,
        distanceM: number,
        steps: number = 16
    ): Feature<PolygonGeometry> | null {
        // 校验输入
        if (!polygon || !polygon.geometry || polygon.geometry.type !== 'Polygon') {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 Polygon Feature`);
            }
            return null;
        }

        if (!isFinite(distanceM) || distanceM < MIN_DISTANCE_M || distanceM > MAX_DISTANCE_M) {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_DISTANCE}] 距离无效: ${distanceM}`);
            }
            return null;
        }

        const outerRing = polygon.geometry.coordinates[0];
        if (!outerRing || outerRing.length < 4) {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] 多边形外环至少需要 4 个顶点`);
            }
            return null;
        }

        // 移除闭合点处理
        const open = outerRing[0]![0] === outerRing[outerRing.length - 1]![0] &&
            outerRing[0]![1] === outerRing[outerRing.length - 1]![1]
            ? outerRing.slice(0, -1)
            : [...outerRing];

        const n = open.length;
        if (n < 3) {
            return null;
        }

        // 对每个顶点沿外法向量偏移
        const bufferedRing: Position[] = [];
        for (let i = 0; i < n; i++) {
            const prev = open[(i + n - 1) % n]!;
            const current = open[i]!;
            const next = open[(i + 1) % n]!;

            // 外法向量方向——对于逆时针外环，"外"侧为右侧
            const perpBearing = perpendicularBearing(prev, current, next, 'right');

            bufferedRing.push(
                destination(current[0], current[1], distanceM, perpBearing)
            );
        }

        // 闭合环
        if (bufferedRing.length > 0) {
            bufferedRing.push([bufferedRing[0]![0], bufferedRing[0]![1]] as Position);
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [bufferedRing],
            },
            properties: polygon.properties,
        };
    },

    /**
     * 计算线的单侧偏移曲线（Offset Curve）。
     * 沿线的指定侧偏移 distanceM，返回偏移后的线。
     *
     * @param line - 线 Feature
     * @param distanceM - 偏移距离（米），正值
     * @param side - 偏移方向，'left' 或 'right'
     * @returns 偏移线 Feature
     *
     * @stability experimental
     *
     * @example
     * const offset = BufferOps.offsetCurve(lineFeature, 50, 'left');
     */
    offsetCurve(
        line: Feature<LineStringGeometry>,
        distanceM: number,
        side: 'left' | 'right' = 'left'
    ): Feature<LineStringGeometry> | null {
        // 校验输入
        if (!line || !line.geometry || line.geometry.type !== 'LineString') {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_GEOMETRY}] 参数必须是 LineString Feature`);
            }
            return null;
        }

        if (!isFinite(distanceM) || distanceM < MIN_DISTANCE_M || distanceM > MAX_DISTANCE_M) {
            if (__DEV__) {
                console.warn(`[${BUFFER_ERROR_CODES.INVALID_DISTANCE}] 距离无效: ${distanceM}`);
            }
            return null;
        }

        const coords = line.geometry.coordinates;
        if (coords.length < 2) {
            return null;
        }

        // 对每个顶点沿法向量偏移
        const offsetCoords: Position[] = [];
        for (let i = 0; i < coords.length; i++) {
            const current = coords[i]!;
            const prev = i > 0 ? coords[i - 1]! : null;
            const next = i < coords.length - 1 ? coords[i + 1]! : null;

            const perpBearing = prev !== null
                ? perpendicularBearing(prev, current, next, side)
                : perpendicularBearing(current, next!, null, side);

            offsetCoords.push(
                destination(current[0], current[1], distanceM, perpBearing)
            );
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: offsetCoords,
            },
            properties: line.properties,
        };
    },
} as const;

export { BufferOps as bufferOps };
