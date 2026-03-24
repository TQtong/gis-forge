// ============================================================
// interaction-measure/src/MeasureTool.ts — 测量交互工具
// 被引用于：L5/InteractionManager, L6/Map2D/Globe3D
//
// 提供三种测量模式：距离、面积、高程剖面。
// 内置 Haversine 距离计算和球面多边形面积公式，
// 支持多种单位转换。不依赖任何引擎内部模块。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type {
    LineStringGeometry,
    PolygonGeometry,
    Position,
} from '../../core/src/types/geometry.ts';

/** 编译期开关：开发模式调试代码，生产构建 tree-shake 移除 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 地球平均半径（米），WGS84 平均值，用于 Haversine 和球面面积公式 */
const EARTH_RADIUS_M = 6371008.8;

/** 角度转弧度乘数 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度转角度乘数 */
const RAD_TO_DEG = 180 / Math.PI;

/** 米→公里换算因子 */
const M_TO_KM = 1 / 1000;

/** 米→英里换算因子（1 英里 = 1609.344 米） */
const M_TO_MILES = 1 / 1609.344;

/** 米→海里换算因子（1 海里 = 1852 米） */
const M_TO_NAUTICAL_MILES = 1 / 1852;

/** 平方米→平方公里换算因子 */
const SQM_TO_SQKM = 1 / 1e6;

/** 平方米→公顷换算因子（1 公顷 = 10000 平方米） */
const SQM_TO_HECTARES = 1 / 10000;

/** 平方米→英亩换算因子（1 英亩 = 4046.856 平方米） */
const SQM_TO_ACRES = 1 / 4046.856;

/** 高程剖面默认采样点数 */
const DEFAULT_PROFILE_SAMPLE_COUNT = 100;

// ===================== 类型定义 =====================

/**
 * 测量模式枚举。
 * - `'distance'`：距离测量（折线各段距离 + 总距离）
 * - `'area'`：面积测量（多边形球面面积）
 * - `'elevation-profile'`：高程剖面（沿线采样地形高度）
 */
export type MeasureMode = 'distance' | 'area' | 'elevation-profile';

/**
 * 距离单位枚举。
 * - `'meters'`：米（默认）
 * - `'kilometers'`：公里
 * - `'miles'`：英里
 * - `'nautical-miles'`：海里
 */
export type DistanceUnit = 'meters' | 'kilometers' | 'miles' | 'nautical-miles';

/**
 * 面积单位枚举。
 * - `'sq-meters'`：平方米（默认）
 * - `'sq-kilometers'`：平方公里
 * - `'hectares'`：公顷
 * - `'acres'`：英亩
 */
export type AreaUnit = 'sq-meters' | 'sq-kilometers' | 'hectares' | 'acres';

/**
 * 线条样式选项。
 * 控制测量线条的外观。
 */
export interface MeasureLineStyle {
    /** 线条颜色，CSS 颜色字符串，默认 `'#ff6600'` */
    color?: string;
    /** 线条宽度（CSS 像素），范围 [0.5, 20]，默认 `2` */
    width?: number;
    /** 虚线模式数组，默认 `[6, 4]`（虚线） */
    dasharray?: number[];
}

/**
 * 高程剖面中的单个采样点。
 */
export interface ElevationProfilePoint {
    /** 采样点距路线起点的累计距离（米） */
    readonly distance: number;
    /** 该采样点的海拔高度（米），未获取到时为 `null` */
    readonly elevation: number | null;
    /** 采样点经纬度坐标 [lng, lat] */
    readonly coordinate: Position;
}

/**
 * 测量结果数据对象。
 * 根据当前测量模式，部分字段可能为 `undefined`。
 */
export interface MeasureResult {
    /** 测量模式 */
    readonly mode: MeasureMode;

    /** 测量路径/多边形的顶点坐标（用户点击产生的） */
    readonly coordinates: Position[];

    /**
     * 总距离（米）。
     * 距离模式和高程剖面模式下有值。
     * 为所有线段 Haversine 距离之和。
     */
    readonly distance?: number;

    /**
     * 球面多边形面积（平方米）。
     * 仅面积模式下有值。
     */
    readonly area?: number;

    /**
     * 高程剖面数据数组。
     * 仅高程剖面模式下有值。
     * 包含沿路线等间距采样的高程点。
     */
    readonly elevationProfile?: ElevationProfilePoint[];

    /**
     * 每条线段的距离数组（米）。
     * 距离和高程剖面模式下有值。
     * `segmentDistances[i]` 对应 `coordinates[i]` → `coordinates[i+1]` 的距离。
     */
    readonly segmentDistances?: number[];

    /**
     * 带单位的格式化距离字符串。
     * 根据当前 `unit` 设置格式化。
     *
     * @example `'1.23 km'`、`'456.78 m'`、`'0.77 mi'`
     */
    readonly formattedDistance?: string;

    /**
     * 带单位的格式化面积字符串。
     * 根据当前 `areaUnit` 设置格式化。
     *
     * @example `'1.23 km²'`、`'45.6 ha'`、`'112.3 acres'`
     */
    readonly formattedArea?: string;
}

/**
 * 测量工具配置选项。
 */
export interface MeasureToolOptions {
    /**
     * 初始测量模式。
     * 默认 `'distance'`。
     */
    mode?: MeasureMode;

    /**
     * 距离单位。
     * 默认 `'meters'`。
     */
    unit?: DistanceUnit;

    /**
     * 面积单位。
     * 默认 `'sq-meters'`。
     */
    areaUnit?: AreaUnit;

    /**
     * 是否在测量过程中显示标签（距离/面积文本）。
     * 默认 `true`。
     */
    showLabels?: boolean;

    /**
     * 测量线条样式。
     */
    lineStyle?: MeasureLineStyle;

    /**
     * 高程剖面的沿线采样点数量。
     * 范围 [2, 1000]，默认 `100`。
     */
    profileSampleCount?: number;
}

/**
 * 测量工具事件名称。
 * - `'measurestart'`：开始测量（第一个点放置时触发）
 * - `'measureend'`：测量完成（双击完成时触发）
 * - `'measureupdate'`：测量更新（每次添加顶点或鼠标移动时触发）
 */
export type MeasureEventType = 'measurestart' | 'measureend' | 'measureupdate';

/**
 * 测量事件载荷。
 */
export interface MeasureEvent {
    /** 事件类型 */
    readonly type: MeasureEventType;
    /** 当前测量模式 */
    readonly mode: MeasureMode;
    /** 当前测量结果（可能为部分结果） */
    readonly result: MeasureResult;
}

/** 事件监听器类型 */
type MeasureEventListener = (event: MeasureEvent) => void;

// ===================== MeasureTool 类 =====================

/**
 * 测量交互工具。
 *
 * 提供距离、面积和高程剖面三种测量模式。
 * 内置 Haversine 距离计算和球面多边形面积公式，
 * 支持多种单位格式化输出。
 *
 * **不是图层（Layer）**——MeasureTool 是交互工具，通过
 * InteractionManager 注册到引擎，接收指针事件。
 *
 * @stability experimental
 *
 * @example
 * const measure = new MeasureTool({ mode: 'distance', unit: 'kilometers' });
 * measure.on('measureend', (e) => console.log('距离:', e.result.formattedDistance));
 */
export class MeasureTool {
    // ===================== 公共只读字段 =====================

    /** 工具唯一标识，用于 InteractionManager 注册 */
    readonly id = 'measure' as const;

    // ===================== 私有字段 =====================

    /** 当前测量模式 */
    private _mode: MeasureMode;

    /** 距离单位 */
    private _unit: DistanceUnit;

    /** 面积单位 */
    private _areaUnit: AreaUnit;

    /** 是否显示标签 */
    private _showLabels: boolean;

    /** 线条样式 */
    private _lineStyle: Required<MeasureLineStyle>;

    /** 高程剖面采样点数 */
    private _profileSampleCount: number;

    /** 用户点击产生的测量顶点坐标 */
    private _coordinates: Position[] = [];

    /** 是否正在测量中 */
    private _isMeasuring = false;

    /** 当前鼠标位置（用于实时预览计算） */
    private _currentMouseCoord: Position | null = null;

    /** 事件监听器注册表 */
    private _listeners: Map<MeasureEventType, Set<MeasureEventListener>> = new Map();

    // ===================== 构造函数 =====================

    /**
     * 创建测量工具实例。
     *
     * @param options - 配置选项，所有字段可选，有默认值
     *
     * @example
     * const measure = new MeasureTool({ mode: 'area', areaUnit: 'hectares' });
     */
    constructor(options: MeasureToolOptions = {}) {
        this._mode = options.mode ?? 'distance';
        this._unit = options.unit ?? 'meters';
        this._areaUnit = options.areaUnit ?? 'sq-meters';
        this._showLabels = options.showLabels ?? true;
        this._profileSampleCount = options.profileSampleCount ?? DEFAULT_PROFILE_SAMPLE_COUNT;

        // 线条样式合并默认值
        this._lineStyle = {
            color: options.lineStyle?.color ?? '#ff6600',
            width: options.lineStyle?.width ?? 2,
            dasharray: options.lineStyle?.dasharray ?? [6, 4],
        };

        if (__DEV__) {
            console.debug(`[MeasureTool] 初始化完成，模式=${this._mode}, 距离单位=${this._unit}, 面积单位=${this._areaUnit}`);
        }
    }

    // ===================== 公共属性访问器 =====================

    /**
     * 获取当前测量模式。
     *
     * @returns 当前模式
     */
    get mode(): MeasureMode {
        return this._mode;
    }

    /**
     * 是否正在进行测量操作。
     *
     * @returns 测量中状态
     */
    get isMeasuring(): boolean {
        return this._isMeasuring;
    }

    /**
     * 是否显示标签。
     *
     * @returns 是否显示
     */
    get showLabels(): boolean {
        return this._showLabels;
    }

    /**
     * 获取当前距离单位。
     *
     * @returns 距离单位
     */
    get unit(): DistanceUnit {
        return this._unit;
    }

    /**
     * 获取当前面积单位。
     *
     * @returns 面积单位
     */
    get areaUnit(): AreaUnit {
        return this._areaUnit;
    }

    /**
     * 获取当前线条样式（只读）。
     *
     * @returns 线条样式
     */
    get lineStyle(): Readonly<Required<MeasureLineStyle>> {
        return this._lineStyle;
    }

    // ===================== 公共方法 =====================

    /**
     * 切换测量模式。
     * 如果当前正在测量中，会先自动清除。
     *
     * @param mode - 新的测量模式
     *
     * @example
     * measure.setMode('area');
     */
    setMode(mode: MeasureMode): void {
        if (mode === this._mode) {
            return;
        }
        // 正在测量中则先清除
        if (this._isMeasuring) {
            this.clear();
        }
        this._mode = mode;

        if (__DEV__) {
            console.debug(`[MeasureTool] 模式切换至 ${mode}`);
        }
    }

    /**
     * 设置距离单位。
     * 如果当前有测量结果，会触发 measureupdate 事件以刷新格式化字符串。
     *
     * @param unit - 新的距离单位
     *
     * @example
     * measure.setUnit('kilometers');
     */
    setUnit(unit: DistanceUnit): void {
        this._unit = unit;

        // 如果正在测量中，重新触发 update 以刷新格式化结果
        if (this._isMeasuring && this._coordinates.length > 0) {
            this._emitUpdate();
        }

        if (__DEV__) {
            console.debug(`[MeasureTool] 距离单位切换至 ${unit}`);
        }
    }

    /**
     * 设置面积单位。
     * 如果当前有测量结果，会触发 measureupdate 事件。
     *
     * @param areaUnit - 新的面积单位
     *
     * @example
     * measure.setUnit('hectares'); // 注意：面积单位用 setAreaUnit
     */
    setAreaUnit(areaUnit: AreaUnit): void {
        this._areaUnit = areaUnit;

        if (this._isMeasuring && this._coordinates.length > 0) {
            this._emitUpdate();
        }

        if (__DEV__) {
            console.debug(`[MeasureTool] 面积单位切换至 ${areaUnit}`);
        }
    }

    /**
     * 获取当前测量结果。
     * 如果未在测量中或无顶点，返回当前模式的空结果。
     *
     * @returns 测量结果对象
     *
     * @example
     * const result = measure.getResult();
     * console.log(result.formattedDistance); // '1.23 km'
     */
    getResult(): MeasureResult {
        return this._computeResult();
    }

    /**
     * 清除当前测量，重置所有状态。
     *
     * @example
     * measure.clear();
     */
    clear(): void {
        this._coordinates = [];
        this._isMeasuring = false;
        this._currentMouseCoord = null;

        if (__DEV__) {
            console.debug('[MeasureTool] 测量已清除');
        }
    }

    // ===================== 事件系统 =====================

    /**
     * 注册事件监听器。
     *
     * @param type - 事件类型
     * @param listener - 回调函数
     * @returns 当前实例（链式调用）
     *
     * @example
     * measure.on('measureend', (e) => {
     *   console.log('测量完成:', e.result);
     * });
     */
    on(type: MeasureEventType, listener: MeasureEventListener): this {
        let set = this._listeners.get(type);
        if (set === undefined) {
            set = new Set();
            this._listeners.set(type, set);
        }
        set.add(listener);
        return this;
    }

    /**
     * 移除事件监听器。
     *
     * @param type - 事件类型
     * @param listener - 要移除的回调
     * @returns 当前实例
     *
     * @example
     * measure.off('measureend', myHandler);
     */
    off(type: MeasureEventType, listener: MeasureEventListener): this {
        const set = this._listeners.get(type);
        if (set !== undefined) {
            set.delete(listener);
            if (set.size === 0) {
                this._listeners.delete(type);
            }
        }
        return this;
    }

    // ===================== 输入事件处理器 =====================

    /**
     * 处理指针按下事件。
     * 添加测量顶点。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * measure.handlePointerDown(500, 300, [116.39, 39.91]);
     */
    handlePointerDown(screenX: number, screenY: number, lngLat: Position): void {
        // 参数有效性检查
        if (!isFinite(screenX) || !isFinite(screenY)) {
            if (__DEV__) {
                console.warn('[MeasureTool] handlePointerDown: 无效的屏幕坐标');
            }
            return;
        }
        if (!this._isValidPosition(lngLat)) {
            if (__DEV__) {
                console.warn('[MeasureTool] handlePointerDown: 无效的经纬度');
            }
            return;
        }

        // 如果尚未开始测量，标记为测量中并发射 start 事件
        if (!this._isMeasuring) {
            this._isMeasuring = true;
            this._coordinates = [];
            this._emit('measurestart');
        }

        // 添加顶点
        this._coordinates.push(lngLat);

        // 发射 update 事件（实时更新结果）
        this._emitUpdate();

        if (__DEV__) {
            console.debug(`[MeasureTool] 添加测量点 #${this._coordinates.length}: [${lngLat[0].toFixed(6)}, ${lngLat[1].toFixed(6)}]`);
        }
    }

    /**
     * 处理指针移动事件。
     * 更新鼠标位置用于实时预览（橡皮筋效果）。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * measure.handlePointerMove(510, 310, [116.40, 39.92]);
     */
    handlePointerMove(screenX: number, screenY: number, lngLat: Position): void {
        if (!isFinite(screenX) || !isFinite(screenY) || !this._isValidPosition(lngLat)) {
            return;
        }

        // 更新当前鼠标坐标（用于实时预览计算）
        this._currentMouseCoord = lngLat;

        // 如果正在测量中且已有至少一个顶点，发射 update（实时距离/面积预览）
        if (this._isMeasuring && this._coordinates.length > 0) {
            this._emitUpdate();
        }
    }

    /**
     * 处理双击事件。
     * 完成当前测量（distance/area 模式下双击结束）。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * measure.handleDoubleClick(500, 300, [116.39, 39.91]);
     */
    handleDoubleClick(screenX: number, screenY: number, lngLat: Position): void {
        if (!this._isMeasuring) {
            return;
        }

        // 双击通常也触发了 pointerDown，已多添加了一个重复点
        // 移除最后一个重复点
        if (this._coordinates.length > 1) {
            this._coordinates.pop();
        }

        // 验证最少顶点数：距离至少 2 个，面积至少 3 个
        let valid = false;
        switch (this._mode) {
            case 'distance':
            case 'elevation-profile':
                valid = this._coordinates.length >= 2;
                break;
            case 'area':
                valid = this._coordinates.length >= 3;
                break;
        }

        if (!valid) {
            if (__DEV__) {
                console.warn(`[MeasureTool] 测量模式 '${this._mode}' 的顶点数不足: ${this._coordinates.length}`);
            }
            return;
        }

        // 计算最终结果并发射完成事件
        const result = this._computeResult();
        this._dispatchEvent({
            type: 'measureend',
            mode: this._mode,
            result,
        });

        // 完成后重置测量状态
        this._isMeasuring = false;
        this._currentMouseCoord = null;

        if (__DEV__) {
            console.debug('[MeasureTool] 测量完成', result);
        }
    }

    // ===================== 私有方法 =====================

    /**
     * 验证 Position 坐标是否有效。
     *
     * @param pos - 要验证的坐标
     * @returns 坐标有效则返回 `true`
     */
    private _isValidPosition(pos: Position): boolean {
        if (pos.length < 2) {
            return false;
        }
        const lng = pos[0];
        const lat = pos[1];
        if (!isFinite(lng) || !isFinite(lat)) {
            return false;
        }
        if (lng < -360 || lng > 360 || lat < -90 || lat > 90) {
            return false;
        }
        return true;
    }

    /**
     * 根据当前模式和坐标计算测量结果。
     *
     * @returns 完整的 MeasureResult 对象
     */
    private _computeResult(): MeasureResult {
        const coords = this._coordinates;

        switch (this._mode) {
            case 'distance':
                return this._computeDistanceResult(coords);
            case 'area':
                return this._computeAreaResult(coords);
            case 'elevation-profile':
                return this._computeElevationProfileResult(coords);
            default:
                // 不应到达此处，TypeScript 的 exhaustive check
                return {
                    mode: this._mode,
                    coordinates: coords.slice(),
                };
        }
    }

    /**
     * 计算距离测量结果。
     * 使用 Haversine 公式计算各线段距离并求和。
     *
     * @param coords - 测量顶点坐标
     * @returns 距离测量结果
     */
    private _computeDistanceResult(coords: Position[]): MeasureResult {
        // 如果不足 2 个点，距离为 0
        if (coords.length < 2) {
            return {
                mode: 'distance',
                coordinates: coords.slice(),
                distance: 0,
                segmentDistances: [],
                formattedDistance: this._formatDistance(0),
            };
        }

        // 计算每条线段的 Haversine 距离
        const segmentDistances: number[] = [];
        let totalDistance = 0;

        for (let i = 0; i < coords.length - 1; i++) {
            const segDist = haversineDistance(coords[i], coords[i + 1]);
            segmentDistances.push(segDist);
            totalDistance += segDist;
        }

        // 如果有鼠标预览位置，追加一段临时距离（不存入最终结果的 segments）
        // 这里的预览距离只影响格式化输出，用于实时 UI 展示
        let previewTotalDistance = totalDistance;
        if (this._currentMouseCoord !== null && this._isMeasuring) {
            const lastCoord = coords[coords.length - 1];
            previewTotalDistance += haversineDistance(lastCoord, this._currentMouseCoord);
        }

        return {
            mode: 'distance',
            coordinates: coords.slice(),
            distance: totalDistance,
            segmentDistances,
            formattedDistance: this._formatDistance(previewTotalDistance),
        };
    }

    /**
     * 计算面积测量结果。
     * 使用球面多边形面积公式（Girard 定理 / 球面超额法）。
     *
     * @param coords - 测量顶点坐标（多边形顶点，无需闭合）
     * @returns 面积测量结果
     */
    private _computeAreaResult(coords: Position[]): MeasureResult {
        // 面积至少需要 3 个顶点
        if (coords.length < 3) {
            // 不足 3 个时也计算距离（方便 UI 显示路径长度）
            const segmentDistances: number[] = [];
            let totalDist = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                const d = haversineDistance(coords[i], coords[i + 1]);
                segmentDistances.push(d);
                totalDist += d;
            }
            return {
                mode: 'area',
                coordinates: coords.slice(),
                area: 0,
                distance: totalDist,
                segmentDistances,
                formattedArea: this._formatArea(0),
                formattedDistance: this._formatDistance(totalDist),
            };
        }

        // 计算球面多边形面积
        const areaM2 = sphericalPolygonArea(coords);

        // 同时计算周长
        const segmentDistances: number[] = [];
        let perimeter = 0;
        for (let i = 0; i < coords.length; i++) {
            const nextIdx = (i + 1) % coords.length;
            const d = haversineDistance(coords[i], coords[nextIdx]);
            segmentDistances.push(d);
            perimeter += d;
        }

        return {
            mode: 'area',
            coordinates: coords.slice(),
            area: areaM2,
            distance: perimeter,
            segmentDistances,
            formattedArea: this._formatArea(areaM2),
            formattedDistance: this._formatDistance(perimeter),
        };
    }

    /**
     * 计算高程剖面测量结果。
     * 沿路径等间距生成采样点坐标。
     * 高程值为 stub（返回 null），需由上层接入地形数据源填充。
     *
     * @param coords - 测量顶点坐标
     * @returns 高程剖面测量结果
     */
    private _computeElevationProfileResult(coords: Position[]): MeasureResult {
        if (coords.length < 2) {
            return {
                mode: 'elevation-profile',
                coordinates: coords.slice(),
                distance: 0,
                segmentDistances: [],
                elevationProfile: [],
                formattedDistance: this._formatDistance(0),
            };
        }

        // 计算线段距离和累积距离
        const segmentDistances: number[] = [];
        const cumulativeDistances: number[] = [0];
        let totalDistance = 0;

        for (let i = 0; i < coords.length - 1; i++) {
            const d = haversineDistance(coords[i], coords[i + 1]);
            segmentDistances.push(d);
            totalDistance += d;
            cumulativeDistances.push(totalDistance);
        }

        // 沿路径等间距采样
        const sampleCount = Math.max(2, this._profileSampleCount);
        const profile: ElevationProfilePoint[] = [];

        for (let s = 0; s < sampleCount; s++) {
            // 当前采样点距起点的距离
            const targetDist = (s / (sampleCount - 1)) * totalDistance;

            // 找到 targetDist 所在的线段
            const sampleCoord = this._interpolateAlongPath(
                coords,
                cumulativeDistances,
                targetDist,
            );

            profile.push({
                distance: targetDist,
                elevation: null, // stub：需由地形数据源填充
                coordinate: sampleCoord,
            });
        }

        return {
            mode: 'elevation-profile',
            coordinates: coords.slice(),
            distance: totalDistance,
            segmentDistances,
            elevationProfile: profile,
            formattedDistance: this._formatDistance(totalDistance),
        };
    }

    /**
     * 沿路径的累积距离插值，获取目标距离处的坐标。
     *
     * @param coords - 路径顶点
     * @param cumulativeDists - 每个顶点对应的累积距离数组
     * @param targetDist - 目标距离（米）
     * @returns 插值后的坐标 [lng, lat]
     */
    private _interpolateAlongPath(
        coords: Position[],
        cumulativeDists: number[],
        targetDist: number,
    ): Position {
        // 如果目标距离 <= 0，返回起点
        if (targetDist <= 0 || coords.length < 2) {
            return coords[0];
        }

        // 如果目标距离 >= 总距离，返回终点
        const totalDist = cumulativeDists[cumulativeDists.length - 1];
        if (targetDist >= totalDist) {
            return coords[coords.length - 1];
        }

        // 二分查找目标距离所在的线段索引
        let segIdx = 0;
        for (let i = 1; i < cumulativeDists.length; i++) {
            if (cumulativeDists[i] >= targetDist) {
                segIdx = i - 1;
                break;
            }
        }

        // 计算线段内的插值比例
        const segStart = cumulativeDists[segIdx];
        const segEnd = cumulativeDists[segIdx + 1];
        const segLength = segEnd - segStart;

        // 防止除以零
        if (segLength <= 0) {
            return coords[segIdx];
        }

        const t = (targetDist - segStart) / segLength;

        // 线性插值经纬度
        const p0 = coords[segIdx];
        const p1 = coords[segIdx + 1];
        const lng = p0[0] + (p1[0] - p0[0]) * t;
        const lat = p0[1] + (p1[1] - p0[1]) * t;

        return [lng, lat];
    }

    // ===================== 格式化方法 =====================

    /**
     * 将距离（米）格式化为带单位的字符串。
     *
     * @param meters - 距离（米）
     * @returns 格式化字符串
     */
    private _formatDistance(meters: number): string {
        // 处理无效值
        if (!isFinite(meters) || meters < 0) {
            return '0 m';
        }

        switch (this._unit) {
            case 'meters': {
                // 小于 1 米时显示 2 位小数，否则保留整数
                if (meters < 1) {
                    return `${meters.toFixed(2)} m`;
                }
                return `${meters.toFixed(meters < 100 ? 1 : 0)} m`;
            }
            case 'kilometers': {
                const km = meters * M_TO_KM;
                return `${km.toFixed(km < 10 ? 2 : 1)} km`;
            }
            case 'miles': {
                const mi = meters * M_TO_MILES;
                return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
            }
            case 'nautical-miles': {
                const nm = meters * M_TO_NAUTICAL_MILES;
                return `${nm.toFixed(nm < 10 ? 2 : 1)} nmi`;
            }
            default: {
                // 未知单位回退为米
                return `${meters.toFixed(0)} m`;
            }
        }
    }

    /**
     * 将面积（平方米）格式化为带单位的字符串。
     *
     * @param sqMeters - 面积（平方米）
     * @returns 格式化字符串
     */
    private _formatArea(sqMeters: number): string {
        // 处理无效值
        if (!isFinite(sqMeters) || sqMeters < 0) {
            return '0 m²';
        }

        switch (this._areaUnit) {
            case 'sq-meters': {
                return `${sqMeters.toFixed(sqMeters < 100 ? 1 : 0)} m²`;
            }
            case 'sq-kilometers': {
                const sqkm = sqMeters * SQM_TO_SQKM;
                return `${sqkm.toFixed(sqkm < 10 ? 3 : 2)} km²`;
            }
            case 'hectares': {
                const ha = sqMeters * SQM_TO_HECTARES;
                return `${ha.toFixed(ha < 10 ? 2 : 1)} ha`;
            }
            case 'acres': {
                const ac = sqMeters * SQM_TO_ACRES;
                return `${ac.toFixed(ac < 10 ? 2 : 1)} acres`;
            }
            default: {
                return `${sqMeters.toFixed(0)} m²`;
            }
        }
    }

    // ===================== 事件发射 =====================

    /**
     * 发射指定类型的事件。
     *
     * @param type - 事件类型
     */
    private _emit(type: MeasureEventType): void {
        const result = this._computeResult();
        this._dispatchEvent({ type, mode: this._mode, result });
    }

    /**
     * 发射 measureupdate 事件（包含当前计算结果）。
     */
    private _emitUpdate(): void {
        const result = this._computeResult();
        this._dispatchEvent({
            type: 'measureupdate',
            mode: this._mode,
            result,
        });
    }

    /**
     * 将事件分发给所有已注册的监听器。
     * 每个监听器在 try-catch 中执行，单个监听器异常不影响其他。
     *
     * @param event - 要分发的事件对象
     */
    private _dispatchEvent(event: MeasureEvent): void {
        const set = this._listeners.get(event.type);
        if (set === undefined || set.size === 0) {
            return;
        }
        for (const listener of set) {
            try {
                listener(event);
            } catch (err) {
                if (__DEV__) {
                    console.error(`[MeasureTool] 事件监听器 '${event.type}' 执行出错:`, err);
                }
            }
        }
    }
}

// ===================== 独立工具函数 =====================

/**
 * 计算两点之间的 Haversine（大圆）距离。
 * 自包含实现，不依赖其他模块。
 *
 * @param a - 起点 [lng, lat]（度）
 * @param b - 终点 [lng, lat]（度）
 * @returns 两点间的大圆距离（米）
 *
 * @example
 * const d = haversineDistance([116.39, 39.91], [121.47, 31.23]);
 * // ≈ 1068 km（北京→上海直线距离）
 */
function haversineDistance(a: Position, b: Position): number {
    // 将经纬度从度转为弧度
    const lat1 = a[1] * DEG_TO_RAD;
    const lat2 = b[1] * DEG_TO_RAD;
    const dLat = (b[1] - a[1]) * DEG_TO_RAD;
    const dLng = (b[0] - a[0]) * DEG_TO_RAD;

    // Haversine 公式核心
    const sinHalfDLat = Math.sin(dLat / 2);
    const sinHalfDLng = Math.sin(dLng / 2);
    const h = sinHalfDLat * sinHalfDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

    // clamp h 到 [0, 1] 防止浮点误差导致 sqrt 参数越界
    const clamped = Math.min(1, Math.max(0, h));
    // 使用 atan2 比 asin 有更好的数值稳定性
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}

/**
 * 计算球面多边形面积（平方米）。
 *
 * 使用球面超额公式（Spherical Excess / Girard's Theorem）的简化实现：
 * 基于 WGS84 球面近似，通过经纬度坐标直接计算面积。
 *
 * 算法来源：Robert Chamberlain 的 "Some Algorithms for Polygons on a Sphere"
 * (JPL Publication 07-03, NASA/JPL)。
 *
 * @param coords - 多边形顶点坐标数组（不含闭合点），至少 3 个
 * @returns 面积（平方米），始终为正值
 *
 * @example
 * const area = sphericalPolygonArea([
 *   [0, 0], [1, 0], [1, 1], [0, 1]
 * ]);
 * // ≈ 12308.5 km² (约一个 1°×1° 的赤道网格面积)
 */
function sphericalPolygonArea(coords: Position[]): number {
    const n = coords.length;
    // 至少需要 3 个顶点
    if (n < 3) {
        return 0;
    }

    // 球面多边形面积公式：
    // A = |R² × Σ(λ_{i+1} - λ_{i-1}) × sin(φ_i)|
    // 其中 λ 为经度（弧度），φ 为纬度（弧度）
    // 这是梯形公式在球面上的推广
    let sum = 0;

    for (let i = 0; i < n; i++) {
        // 前一个顶点索引（环绕）
        const prevIdx = (i + n - 1) % n;
        // 后一个顶点索引（环绕）
        const nextIdx = (i + 1) % n;

        // 当前顶点的纬度（弧度）
        const lat = coords[i][1] * DEG_TO_RAD;
        // 前后顶点的经度（弧度）
        const lngPrev = coords[prevIdx][0] * DEG_TO_RAD;
        const lngNext = coords[nextIdx][0] * DEG_TO_RAD;

        // 累加 (λ_{next} - λ_{prev}) × sin(φ_current)
        sum += (lngNext - lngPrev) * Math.sin(lat);
    }

    // 面积 = |R² × sum / 2|
    // 取绝对值确保正值（多边形绕向不影响面积结果）
    const area = Math.abs(EARTH_RADIUS_M * EARTH_RADIUS_M * sum / 2);

    return area;
}
