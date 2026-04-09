// ============================================================
// analysis/raster/index.ts — 栅格分析
// 职责：DEM（数字高程模型）分析——坡度、坡向、山影、视域、等高线、重分类。
// 使用 Horn/Sobel 3×3 卷积核计算地形导数，Lambert 余弦定律渲染山影。
// 依赖层级：analysis 可选分析包，仅消费 L0 类型。
// ============================================================

import type { BBox2D } from '../../../core/src/types/math-types.ts';
import type { LineStringGeometry } from '../../../core/src/types/geometry.ts';
import type { FeatureCollection } from '../../../core/src/types/feature.ts';
import {
    fillSinks as _fillSinks,
    flowDirection as _flowDirection,
    flowAccumulation as _flowAccumulation,
    watershed as _watershed,
    D8_DIRECTIONS,
    type FlowDirectionResult,
    type FlowAccumulationResult,
} from './hydrology.ts';

export {
    fillSinks,
    flowDirection,
    flowAccumulation,
    watershed,
    D8_DIRECTIONS,
} from './hydrology.ts';
export type { FlowDirectionResult, FlowAccumulationResult } from './hydrology.ts';

import {
    localAdd as _localAdd,
    localSub as _localSub,
    localMul as _localMul,
    localDiv as _localDiv,
    localPow as _localPow,
    localMin as _localMin,
    localMax as _localMax,
    localSum as _localSum,
    localMean as _localMean,
    localAbs as _localAbs,
    localSqrt as _localSqrt,
    localLog as _localLog,
    localExp as _localExp,
    localClamp as _localClamp,
    localCondition as _localCondition,
    localCombine as _localCombine,
    evaluate as _mapAlgebraEvaluate,
} from './map-algebra.ts';

export {
    localAdd,
    localSub,
    localMul,
    localDiv,
    localPow,
    localMin,
    localMax,
    localSum,
    localMean,
    localAbs,
    localSqrt,
    localLog,
    localExp,
    localClamp,
    localCondition,
    localCombine,
    evaluate as mapAlgebraEvaluate,
} from './map-algebra.ts';

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

const RASTER_ERROR_CODES = {
    /** DEM 数据无效 */
    INVALID_DEM: 'RASTER_INVALID_DEM',
    /** DEM 尺寸无效 */
    INVALID_SIZE: 'RASTER_INVALID_SIZE',
    /** 参数超出有效范围 */
    INVALID_PARAM: 'RASTER_INVALID_PARAM',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 度→弧度转换常量 */
const DEG_TO_RAD = Math.PI / 180.0;

/** 弧度→度转换常量 */
const RAD_TO_DEG = 180.0 / Math.PI;

/** Horn 算法 3×3 核的 dz/dx 分母因子——8 × cellSize */
const HORN_DENOMINATOR_FACTOR = 8;

/** 默认太阳方位角（度，0=北，顺时针）——315° = 西北方 */
const DEFAULT_SUN_AZIMUTH = 315;

/** 默认太阳高度角（度，0=水平，90=天顶）——45° */
const DEFAULT_SUN_ALTITUDE = 45;

/** 默认 Z 因子——用于将高程单位与水平单位统一（例如高程米/水平度） */
const DEFAULT_Z_FACTOR = 1.0;

/** 无数据值标记 */
const NO_DATA = -9999;

/** 视域射线步进分辨率——每个网格单元内的步数 */
const VIEWSHED_STEPS_PER_CELL = 1;

/** 坡度最大合理值（度）——超过 90° 为不合理（垂直面） */
const MAX_SLOPE_DEG = 90;

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

/**
 * DEM 栅格数据结构。
 *
 * @stability experimental
 */
export interface DEMData {
    /** 高程值二维数组，dem[row][col]，单位米。NO_DATA 区域用 NaN 标记。 */
    readonly values: readonly (readonly number[])[];
    /** 行数 */
    readonly rows: number;
    /** 列数 */
    readonly cols: number;
    /** 覆盖范围 */
    readonly bbox: BBox2D;
    /** 网格单元水平尺寸（米），用于坡度计算。默认从 bbox 和 cols 推算。 */
    readonly cellSizeM?: number;
}

/**
 * 山影渲染参数。
 *
 * @stability experimental
 */
export interface HillshadeOptions {
    /** 太阳方位角（度），0=正北，顺时针。默认 315（西北方）。 */
    readonly azimuth?: number;
    /** 太阳高度角（度），0=地平线，90=天顶。默认 45。 */
    readonly altitude?: number;
    /** Z 因子——高程与水平坐标的单位转换比。默认 1.0。 */
    readonly zFactor?: number;
}

/**
 * 视域分析参数。
 *
 * @stability experimental
 */
export interface ViewshedOptions {
    /** 观察点在 DEM 中的行索引 */
    readonly observerRow: number;
    /** 观察点在 DEM 中的列索引 */
    readonly observerCol: number;
    /** 观察者高度（米，叠加在地面高程之上） */
    readonly observerHeight?: number;
    /** 最大分析半径（网格单元数） */
    readonly maxRadius?: number;
}

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/**
 * 安全读取 DEM 值——超出边界返回 NaN。
 *
 * @param dem - DEM 数据
 * @param row - 行索引
 * @param col - 列索引
 * @returns 高程值，越界返回 NaN
 */
function getDemValue(dem: DEMData, row: number, col: number): number {
    if (row < 0 || row >= dem.rows || col < 0 || col >= dem.cols) {
        return NaN;
    }
    const val = dem.values[row]?.[col];
    return val !== undefined ? val : NaN;
}

/**
 * 从 DEM 的 bbox 和列数推算网格单元水平尺寸（米）。
 * 使用纬度中间值近似。
 *
 * @param dem - DEM 数据
 * @returns 单元尺寸（米）
 */
function estimateCellSizeM(dem: DEMData): number {
    if (dem.cellSizeM !== undefined && dem.cellSizeM > 0) {
        return dem.cellSizeM;
    }

    // 从度数计算：1° ≈ 111320m（赤道处），按纬度修正
    const midLat = (dem.bbox.south + dem.bbox.north) * 0.5;
    const metersPerDeg = 111320 * Math.cos(midLat * DEG_TO_RAD);
    const cellSizeDeg = (dem.bbox.east - dem.bbox.west) / Math.max(1, dem.cols - 1);

    return cellSizeDeg * metersPerDeg;
}

// ---------------------------------------------------------------------------
// RasterOps 导出对象
// ---------------------------------------------------------------------------

/**
 * 栅格分析运算集合。
 * 提供 DEM 地形分析算法：坡度、坡向、山影、视域、等高线、重分类。
 *
 * @stability experimental
 *
 * @example
 * const slopeGrid = RasterOps.slope(dem);
 */
export const RasterOps = {
    /**
     * 计算 DEM 坡度（Horn 算法，3×3 卷积）。
     * 使用 Horn 梯度公式，对每个像素的 3×3 邻域计算 dz/dx 和 dz/dy，
     * 然后 slope = atan(sqrt(dz/dx² + dz/dy²))。
     *
     * @param dem - DEM 栅格数据
     * @param zFactor - Z 因子，默认 1.0
     * @returns 坡度栅格（值为度数 [0, 90]），与输入同尺寸
     *
     * @stability experimental
     *
     * @example
     * const slopeGrid = RasterOps.slope(dem, 1.0);
     */
    slope(dem: DEMData, zFactor: number = DEFAULT_Z_FACTOR): DEMData {
        // 校验输入
        if (!dem || dem.rows < 3 || dem.cols < 3) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 至少需要 3×3`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem?.bbox ?? { west: 0, south: 0, east: 0, north: 0 } };
        }

        const safeZ = isFinite(zFactor) && zFactor > 0 ? zFactor : DEFAULT_Z_FACTOR;
        const cellSize = estimateCellSizeM(dem);
        const result: number[][] = [];

        for (let r = 0; r < dem.rows; r++) {
            const row: number[] = [];
            for (let c = 0; c < dem.cols; c++) {
                // 边界像素无法计算完整 3×3 邻域，标记为 NaN
                if (r === 0 || r === dem.rows - 1 || c === 0 || c === dem.cols - 1) {
                    row.push(NaN);
                    continue;
                }

                // Horn 3×3 邻域取值（a-i 对应标准命名）
                const a = getDemValue(dem, r - 1, c - 1);
                const b = getDemValue(dem, r - 1, c);
                const cc = getDemValue(dem, r - 1, c + 1);
                const d = getDemValue(dem, r, c - 1);
                // e = center, 未使用
                const f = getDemValue(dem, r, c + 1);
                const g = getDemValue(dem, r + 1, c - 1);
                const h = getDemValue(dem, r + 1, c);
                const ii = getDemValue(dem, r + 1, c + 1);

                // 含 NaN 的邻域无法计算
                if (isNaN(a) || isNaN(b) || isNaN(cc) || isNaN(d) ||
                    isNaN(f) || isNaN(g) || isNaN(h) || isNaN(ii)) {
                    row.push(NaN);
                    continue;
                }

                // Horn 公式：dz/dx = ((c + 2f + i) - (a + 2d + g)) / (8 × cellSize)
                const dzdx = ((cc + 2 * f + ii) - (a + 2 * d + g)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize);

                // dz/dy = ((g + 2h + i) - (a + 2b + c)) / (8 × cellSize)
                const dzdy = ((g + 2 * h + ii) - (a + 2 * b + cc)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize);

                // 应用 Z 因子
                const dzdxZ = dzdx * safeZ;
                const dzdyZ = dzdy * safeZ;

                // 坡度 = atan(sqrt(dz/dx² + dz/dy²))，转为度数
                const slopeDeg = Math.atan(Math.sqrt(dzdxZ * dzdxZ + dzdyZ * dzdyZ)) * RAD_TO_DEG;

                row.push(Math.min(slopeDeg, MAX_SLOPE_DEG));
            }
            result.push(row);
        }

        return { values: result, rows: dem.rows, cols: dem.cols, bbox: dem.bbox };
    },

    /**
     * 计算 DEM 坡向（Aspect）。
     * 坡向表示地表面最陡方向的方位角，范围 [0, 360)，0=正北，顺时针。
     * 平坦区域（坡度接近 0）标记为 -1。
     *
     * @param dem - DEM 栅格数据
     * @returns 坡向栅格（值为度数 [0, 360) 或 -1 表示平坦）
     *
     * @stability experimental
     *
     * @example
     * const aspectGrid = RasterOps.aspect(dem);
     */
    aspect(dem: DEMData): DEMData {
        if (!dem || dem.rows < 3 || dem.cols < 3) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 至少需要 3×3`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem?.bbox ?? { west: 0, south: 0, east: 0, north: 0 } };
        }

        const cellSize = estimateCellSizeM(dem);
        const result: number[][] = [];

        for (let r = 0; r < dem.rows; r++) {
            const row: number[] = [];
            for (let c = 0; c < dem.cols; c++) {
                if (r === 0 || r === dem.rows - 1 || c === 0 || c === dem.cols - 1) {
                    row.push(NaN);
                    continue;
                }

                const a = getDemValue(dem, r - 1, c - 1);
                const b = getDemValue(dem, r - 1, c);
                const cc = getDemValue(dem, r - 1, c + 1);
                const d = getDemValue(dem, r, c - 1);
                const f = getDemValue(dem, r, c + 1);
                const g = getDemValue(dem, r + 1, c - 1);
                const h = getDemValue(dem, r + 1, c);
                const ii = getDemValue(dem, r + 1, c + 1);

                if (isNaN(a) || isNaN(b) || isNaN(cc) || isNaN(d) ||
                    isNaN(f) || isNaN(g) || isNaN(h) || isNaN(ii)) {
                    row.push(NaN);
                    continue;
                }

                const dzdx = ((cc + 2 * f + ii) - (a + 2 * d + g)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize);
                const dzdy = ((g + 2 * h + ii) - (a + 2 * b + cc)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize);

                // 平坦区域
                if (Math.abs(dzdx) < 1e-10 && Math.abs(dzdy) < 1e-10) {
                    row.push(-1);
                    continue;
                }

                // 坡向 = atan2(-dzdy, dzdx) 转为地理方位角（0=北，顺时针）
                let aspectDeg = Math.atan2(-dzdy, dzdx) * RAD_TO_DEG;
                // 从数学角度转换到地理方位角
                aspectDeg = (450 - aspectDeg) % 360;

                row.push(aspectDeg);
            }
            result.push(row);
        }

        return { values: result, rows: dem.rows, cols: dem.cols, bbox: dem.bbox };
    },

    /**
     * 计算山影（Hillshade/Shaded Relief）。
     * 使用 Lambert 余弦定律模拟光照：
     * hillshade = cos(zenith) × cos(slope) + sin(zenith) × sin(slope) × cos(azimuth - aspect)
     * 结果归一化到 [0, 255]。
     *
     * @param dem - DEM 栅格数据
     * @param options - 光照参数（太阳方位角、高度角、Z因子）
     * @returns 山影栅格（值为 [0, 255] 灰度值）
     *
     * @stability experimental
     *
     * @example
     * const hillshade = RasterOps.hillshade(dem, { azimuth: 315, altitude: 45 });
     */
    hillshade(dem: DEMData, options: HillshadeOptions = {}): DEMData {
        if (!dem || dem.rows < 3 || dem.cols < 3) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 至少需要 3×3`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem?.bbox ?? { west: 0, south: 0, east: 0, north: 0 } };
        }

        const azimuthDeg = options.azimuth !== undefined ? options.azimuth : DEFAULT_SUN_AZIMUTH;
        const altitudeDeg = options.altitude !== undefined ? options.altitude : DEFAULT_SUN_ALTITUDE;
        const zFactor = options.zFactor !== undefined && options.zFactor > 0
            ? options.zFactor
            : DEFAULT_Z_FACTOR;

        // 太阳方向转换为弧度
        // 方位角：从北顺时针转为数学角度（从东逆时针）
        const azimuthRad = ((360 - azimuthDeg + 90) % 360) * DEG_TO_RAD;
        // 天顶角 = 90° - 高度角
        const zenithRad = (90 - altitudeDeg) * DEG_TO_RAD;

        const cosZenith = Math.cos(zenithRad);
        const sinZenith = Math.sin(zenithRad);
        const cellSize = estimateCellSizeM(dem);

        const result: number[][] = [];

        for (let r = 0; r < dem.rows; r++) {
            const row: number[] = [];
            for (let c = 0; c < dem.cols; c++) {
                if (r === 0 || r === dem.rows - 1 || c === 0 || c === dem.cols - 1) {
                    row.push(NaN);
                    continue;
                }

                const a = getDemValue(dem, r - 1, c - 1);
                const b = getDemValue(dem, r - 1, c);
                const cc = getDemValue(dem, r - 1, c + 1);
                const d = getDemValue(dem, r, c - 1);
                const f = getDemValue(dem, r, c + 1);
                const g = getDemValue(dem, r + 1, c - 1);
                const h = getDemValue(dem, r + 1, c);
                const ii = getDemValue(dem, r + 1, c + 1);

                if (isNaN(a) || isNaN(b) || isNaN(cc) || isNaN(d) ||
                    isNaN(f) || isNaN(g) || isNaN(h) || isNaN(ii)) {
                    row.push(NaN);
                    continue;
                }

                const dzdx = ((cc + 2 * f + ii) - (a + 2 * d + g)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize) * zFactor;
                const dzdy = ((g + 2 * h + ii) - (a + 2 * b + cc)) /
                    (HORN_DENOMINATOR_FACTOR * cellSize) * zFactor;

                // 坡度（弧度）
                const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));

                // 坡向（弧度，数学角度）
                let aspectRad = Math.atan2(-dzdy, dzdx);
                if (aspectRad < 0) {
                    aspectRad += 2 * Math.PI;
                }

                // Lambert 余弦定律
                const hs = cosZenith * Math.cos(slopeRad) +
                    sinZenith * Math.sin(slopeRad) * Math.cos(azimuthRad - aspectRad);

                // 归一化到 [0, 255]
                const value = Math.max(0, Math.min(255, Math.round(hs * 255)));
                row.push(value);
            }
            result.push(row);
        }

        return { values: result, rows: dem.rows, cols: dem.cols, bbox: dem.bbox };
    },

    /**
     * 视域分析（Viewshed）。
     * 从观察点出发沿 360° 射线行进，基于视线仰角判断每个网格单元是否可见。
     * 返回可见性栅格（1=可见，0=不可见）。
     *
     * @param dem - DEM 栅格数据
     * @param options - 视域分析参数
     * @returns 可见性栅格（1=可见，0=不可见，NaN=超出范围）
     *
     * @stability experimental
     *
     * @example
     * const visible = RasterOps.viewshed(dem, { observerRow: 50, observerCol: 50, observerHeight: 10 });
     */
    viewshed(dem: DEMData, options: ViewshedOptions): DEMData {
        if (!dem || dem.rows < 3 || dem.cols < 3) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 至少需要 3×3`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem?.bbox ?? { west: 0, south: 0, east: 0, north: 0 } };
        }

        const oRow = Math.round(options.observerRow);
        const oCol = Math.round(options.observerCol);

        // 校验观察点在 DEM 范围内
        if (oRow < 0 || oRow >= dem.rows || oCol < 0 || oCol >= dem.cols) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_PARAM}] 观察点超出 DEM 范围`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem.bbox };
        }

        const observerHeight = options.observerHeight !== undefined ? options.observerHeight : 0;
        const maxRadius = options.maxRadius !== undefined
            ? Math.min(options.maxRadius, Math.max(dem.rows, dem.cols))
            : Math.max(dem.rows, dem.cols);

        // 观察点的绝对高程（地面 + 观察者高度）
        const observerElev = getDemValue(dem, oRow, oCol);
        if (isNaN(observerElev)) {
            return { values: [], rows: 0, cols: 0, bbox: dem.bbox };
        }
        const observerZ = observerElev + observerHeight;

        // 初始化可见性网格（全 0）
        const visibility: number[][] = [];
        for (let r = 0; r < dem.rows; r++) {
            visibility.push(new Array<number>(dem.cols).fill(0));
        }
        // 观察点自身标记为可见
        visibility[oRow]![oCol] = 1;

        // 射线行进分析——沿 360° 方向发射射线
        // 使用 Bresenham 变体沿每条射线步进
        const numRays = Math.max(360, Math.round(maxRadius * 4));
        const angleStep = (2 * Math.PI) / numRays;

        for (let rayIdx = 0; rayIdx < numRays; rayIdx++) {
            const angle = rayIdx * angleStep;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);

            // 沿射线步进，记录最大仰角
            let maxTanAngle = -Infinity;

            for (let step = 1; step <= maxRadius; step++) {
                const r = Math.round(oRow + dy * step);
                const c = Math.round(oCol + dx * step);

                // 超出 DEM 范围则停止
                if (r < 0 || r >= dem.rows || c < 0 || c >= dem.cols) {
                    break;
                }

                const elev = getDemValue(dem, r, c);
                if (isNaN(elev)) {
                    continue;
                }

                // 计算水平距离和仰角正切值
                const distH = Math.sqrt(
                    (r - oRow) * (r - oRow) + (c - oCol) * (c - oCol)
                );

                if (distH < 1e-10) {
                    continue;
                }

                const tanAngle = (elev - observerZ) / distH;

                // 如果当前仰角大于之前的最大仰角，则该点可见
                if (tanAngle > maxTanAngle) {
                    visibility[r]![c] = 1;
                    maxTanAngle = tanAngle;
                } else {
                    // 被前方地形遮挡
                    // visibility 保持 0（不可见）
                }
            }
        }

        return { values: visibility, rows: dem.rows, cols: dem.cols, bbox: dem.bbox };
    },

    /**
     * 等高线提取——委托给 interpolation 模块的 isolines。
     * 此处提供快捷入口，将 DEM 数据格式化后调用 Marching Squares。
     *
     * @param dem - DEM 栅格数据
     * @param intervals - 等高线间距（米），例如 100 表示每 100m 一条
     * @returns 等高线 FeatureCollection
     *
     * @stability experimental
     *
     * @example
     * const contours = RasterOps.contour(dem, 100);
     */
    contour(dem: DEMData, intervals: number): FeatureCollection<LineStringGeometry> {
        if (!dem || dem.rows < 2 || dem.cols < 2) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 至少需要 2×2`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        if (!isFinite(intervals) || intervals <= 0) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_PARAM}] 等高线间距必须 > 0`);
            }
            return { type: 'FeatureCollection', features: [] };
        }

        // 找数据范围
        let minVal = Infinity;
        let maxVal = -Infinity;
        for (let r = 0; r < dem.rows; r++) {
            for (let c = 0; c < dem.cols; c++) {
                const v = dem.values[r]![c]!;
                if (isFinite(v)) {
                    if (v < minVal) minVal = v;
                    if (v > maxVal) maxVal = v;
                }
            }
        }

        if (!isFinite(minVal) || !isFinite(maxVal)) {
            return { type: 'FeatureCollection', features: [] };
        }

        // 生成阈值列表
        const thresholds: number[] = [];
        const start = Math.ceil(minVal / intervals) * intervals;
        for (let t = start; t <= maxVal; t += intervals) {
            thresholds.push(t);
        }

        if (thresholds.length === 0) {
            return { type: 'FeatureCollection', features: [] };
        }

        // 内联简化版 Marching Squares（避免跨模块依赖）
        const MS_TABLE: readonly (readonly number[])[] = [
            [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
            [2, 3], [2, 0], [0, 1, 2, 3], [2, 1], [1, 3], [1, 0], [0, 3], [],
        ];

        const cellW = (dem.bbox.east - dem.bbox.west) / (dem.cols - 1);
        const cellH = (dem.bbox.north - dem.bbox.south) / (dem.rows - 1);

        const features: FeatureCollection<LineStringGeometry>['features'] = [];

        for (const threshold of thresholds) {
            const segments: [number, number][][] = [];

            for (let r = 0; r < dem.rows - 1; r++) {
                for (let c = 0; c < dem.cols - 1; c++) {
                    const bl = dem.values[r]![c]!;
                    const br = dem.values[r]![c + 1]!;
                    const tr = dem.values[r + 1]![c + 1]!;
                    const tl = dem.values[r + 1]![c]!;

                    if (isNaN(bl) || isNaN(br) || isNaN(tr) || isNaN(tl)) continue;

                    let ci = 0;
                    if (bl >= threshold) ci |= 1;
                    if (br >= threshold) ci |= 2;
                    if (tr >= threshold) ci |= 4;
                    if (tl >= threshold) ci |= 8;

                    const edges = MS_TABLE[ci]!;
                    if (edges.length === 0) continue;

                    const x0 = dem.bbox.west + c * cellW;
                    const x1 = dem.bbox.west + (c + 1) * cellW;
                    const y0 = dem.bbox.south + r * cellH;
                    const y1 = dem.bbox.south + (r + 1) * cellH;

                    const t0 = (threshold - bl) / (br - bl);
                    const t1 = (threshold - br) / (tr - br);
                    const t2 = (threshold - tr) / (tl - tr);
                    const t3 = (threshold - tl) / (bl - tl);

                    const ep: [number, number][] = [
                        [x0 + t0 * (x1 - x0), y0],
                        [x1, y0 + t1 * (y1 - y0)],
                        [x1 + t2 * (x0 - x1), y1],
                        [x0, y1 + t3 * (y0 - y1)],
                    ];

                    for (let i = 0; i < edges.length; i += 2) {
                        segments.push([ep[edges[i]!]!, ep[edges[i + 1]!]!]);
                    }
                }
            }

            // 连接线段
            if (segments.length > 0) {
                const lines = connectContourSegments(segments);
                for (const line of lines) {
                    if (line.length >= 2) {
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'LineString', coordinates: line },
                            properties: { elevation: threshold },
                        });
                    }
                }
            }
        }

        return { type: 'FeatureCollection', features };
    },

    /**
     * 栅格重分类——根据分类规则将连续值映射到离散类别。
     * 每个规则定义一个 [min, max) 范围和对应的输出值。
     *
     * @param dem - 输入栅格数据
     * @param rules - 分类规则数组 [[minInclusive, maxExclusive, outputValue], ...]
     * @returns 重分类后的栅格
     *
     * @stability experimental
     *
     * @example
     * const landCover = RasterOps.reclassify(dem, [
     *   [0, 100, 1],    // 低地 → 1
     *   [100, 500, 2],  // 丘陵 → 2
     *   [500, 9000, 3], // 山地 → 3
     * ]);
     */
    reclassify(
        dem: DEMData,
        rules: readonly (readonly [number, number, number])[]
    ): DEMData {
        if (!dem || dem.rows < 1 || dem.cols < 1) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_DEM}] DEM 数据无效`);
            }
            return { values: [], rows: 0, cols: 0, bbox: dem?.bbox ?? { west: 0, south: 0, east: 0, north: 0 } };
        }

        if (!rules || rules.length === 0) {
            if (__DEV__) {
                console.warn(`[${RASTER_ERROR_CODES.INVALID_PARAM}] 至少需要一条重分类规则`);
            }
            return dem;
        }

        const result: number[][] = [];

        for (let r = 0; r < dem.rows; r++) {
            const row: number[] = [];
            for (let c = 0; c < dem.cols; c++) {
                const val = dem.values[r]![c]!;

                if (isNaN(val)) {
                    row.push(NaN);
                    continue;
                }

                // 查找匹配的规则
                let classified = NaN;
                for (const rule of rules) {
                    const [minVal, maxVal, outVal] = rule;
                    // [min, max) 左闭右开区间
                    if (val >= minVal && val < maxVal) {
                        classified = outVal;
                        break;
                    }
                }

                row.push(classified);
            }
            result.push(row);
        }

        return { values: result, rows: dem.rows, cols: dem.cols, bbox: dem.bbox };
    },

    /**
     * 填洼（Priority-Flood）。消除 DEM 中的局部最低点，返回填洼后的 DEMData。
     * 所有后续水文分析（流向/流量/流域）的先决条件。
     *
     * @stability experimental
     */
    fillSinks(dem: DEMData): DEMData {
        return _fillSinks(dem);
    },

    /**
     * D8 流向。每格指向 8 邻居中最陡下坡方向，使用 ESRI 编码
     * (1=E, 2=SE, 4=S, 8=SW, 16=W, 32=NW, 64=N, 128=NE, 0=NONE)。
     * 建议先调用 fillSinks。
     *
     * @stability experimental
     */
    flowDirection(dem: DEMData): FlowDirectionResult {
        return _flowDirection(dem);
    },

    /**
     * 流量累积（基于 D8 流向的拓扑 BFS，O(N)）。
     * 每个 cell 的值 = 汇入此 cell 的上游 cell 数量 + 1（自身贡献）。
     * 阈值化后可得到河网。
     *
     * @stability experimental
     */
    flowAccumulation(flow: FlowDirectionResult): FlowAccumulationResult {
        return _flowAccumulation(flow);
    },

    /**
     * 流域范围提取。从出水口反向 BFS 追溯所有上游 cell，返回 Uint8Array mask。
     *
     * @stability experimental
     */
    watershed(flow: FlowDirectionResult, outletRow: number, outletCol: number): Uint8Array {
        return _watershed(flow, outletRow, outletCol);
    },

    // ========================================================
    // Map Algebra（Tomlin 栅格代数）
    // ========================================================

    /** 逐像元加（栅格+栅格 或 栅格+标量）。NaN 传播。 */
    localAdd(a: DEMData | number, b: DEMData | number): DEMData { return _localAdd(a, b); },
    /** 逐像元减。 */
    localSub(a: DEMData | number, b: DEMData | number): DEMData { return _localSub(a, b); },
    /** 逐像元乘。 */
    localMul(a: DEMData | number, b: DEMData | number): DEMData { return _localMul(a, b); },
    /** 逐像元除（除 0 → NaN）。 */
    localDiv(a: DEMData | number, b: DEMData | number): DEMData { return _localDiv(a, b); },
    /** 逐像元幂。 */
    localPow(a: DEMData | number, b: DEMData | number): DEMData { return _localPow(a, b); },
    /** 逐像元最小。 */
    localMin(a: DEMData | number, b: DEMData | number): DEMData { return _localMin(a, b); },
    /** 逐像元最大。 */
    localMax(a: DEMData | number, b: DEMData | number): DEMData { return _localMax(a, b); },
    /** N 个栅格逐像元求和。 */
    localSum(rasters: readonly DEMData[]): DEMData { return _localSum(rasters); },
    /** N 个栅格逐像元求算术平均。 */
    localMean(rasters: readonly DEMData[]): DEMData { return _localMean(rasters); },
    /** 逐像元绝对值。 */
    localAbs(a: DEMData): DEMData { return _localAbs(a); },
    /** 逐像元平方根。 */
    localSqrt(a: DEMData): DEMData { return _localSqrt(a); },
    /** 逐像元自然对数。 */
    localLog(a: DEMData): DEMData { return _localLog(a); },
    /** 逐像元 e^x。 */
    localExp(a: DEMData): DEMData { return _localExp(a); },
    /** 逐像元钳位到 [lo, hi]。 */
    localClamp(a: DEMData, lo: number, hi: number): DEMData { return _localClamp(a, lo, hi); },
    /** 条件选择：cond > 0 则 trueVal，否则 falseVal。 */
    localCondition(cond: DEMData, trueVal: DEMData | number, falseVal: DEMData | number): DEMData {
        return _localCondition(cond, trueVal, falseVal);
    },
    /** 自定义 per-cell 多栅格运算。 */
    localCombine(rasters: readonly DEMData[], fn: (values: number[]) => number): DEMData {
        return _localCombine(rasters, fn);
    },
    /**
     * 表达式求值：对栅格应用算术表达式，支持 + - * / ^ ( ) 与内置函数
     * abs/sqrt/log/exp/sin/cos/tan/min/max/pow。
     *
     * @example
     * RasterOps.mapAlgebraEvaluate("sqrt(a*a + b*b)", { a: dx, b: dy });
     */
    mapAlgebraEvaluate(expression: string, rasterMap: Readonly<Record<string, DEMData>>): DEMData {
        return _mapAlgebraEvaluate(expression, rasterMap);
    },
} as const;

/**
 * 连接等高线线段为连续折线。
 */
function connectContourSegments(segments: [number, number][][]): [number, number][][] {
    const MATCH_EPS = 1e-8;
    const used = new Array<boolean>(segments.length).fill(false);
    const lines: [number, number][][] = [];

    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const line: [number, number][] = [segments[i]![0]!, segments[i]![1]!];

        let extended = true;
        while (extended) {
            extended = false;
            const tail = line[line.length - 1]!;
            for (let j = 0; j < segments.length; j++) {
                if (used[j]) continue;
                const s0 = segments[j]![0]!;
                const s1 = segments[j]![1]!;
                if (Math.abs(s0[0] - tail[0]) < MATCH_EPS && Math.abs(s0[1] - tail[1]) < MATCH_EPS) {
                    line.push(s1);
                    used[j] = true;
                    extended = true;
                    break;
                }
                if (Math.abs(s1[0] - tail[0]) < MATCH_EPS && Math.abs(s1[1] - tail[1]) < MATCH_EPS) {
                    line.push(s0);
                    used[j] = true;
                    extended = true;
                    break;
                }
            }
        }
        lines.push(line);
    }

    return lines;
}

export { RasterOps as rasterOps };
