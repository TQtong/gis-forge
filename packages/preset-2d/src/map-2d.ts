// ============================================================
// @geoforge/preset-2d — Map2D（L6 最简 2D 地图入口）
// MVP：不初始化 WebGPU / L1~L5，仅维护状态与 DOM，便于 API 联调。
// 零 npm 依赖；类型从 L0（@geoforge/core）引用。
// ============================================================

import type { BBox2D } from '../../core/src/math/bbox.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression, StyleSpec } from '../../core/src/types/style-spec.ts';
import type { PickResult } from '../../core/src/types/viewport.ts';

// ===================== 常量（避免魔法数字）=====================

/** Web 墨卡托瓦片世界宽度（像素），与 MapLibre / Mapbox 默认 512 瓦片一致。 */
const WORLD_SIZE_PX = 512;

/** 默认 flyTo / easeTo 动画时长（毫秒）。 */
const DEFAULT_FLIGHT_DURATION_MS = 1500;

/** 默认缓动：ease-in-out cubic（t∈[0,1]）。 */
const DEFAULT_EASING_FN: (t: number) => number = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** 合法缩放级别下界（含）。 */
const MIN_ZOOM_LEVEL = 0;

/** 合法缩放级别上界（含）。 */
const MAX_ZOOM_LEVEL = 22;

/** 浮点比较 epsilon（包围盒包含判定）。 */
const BOUNDS_EPSILON = 1e-9;

/**
 * 是否为开发模式（构建工具可注入 `globalThis.__DEV__`）。
 * 使用函数体避免直接引用未声明的全局标识符。
 *
 * @returns 是否开发模式
 */
function isDevMode(): boolean {
    return (
        typeof globalThis !== 'undefined' &&
        (globalThis as { __DEV__?: boolean }).__DEV__ === true
    );
}

/**
 * 开发模式下输出错误日志。
 *
 * @param args - 透传 console.error
 */
function devError(...args: unknown[]): void {
    if (isDevMode()) {
        // eslint-disable-next-line no-console
        console.error(...args);
    }
}

// ===================== 结构化错误（对齐 GeoForge 约定）=====================
// 使用 const 对象而非 enum，以符合 `erasableSyntaxOnly`（TS 5.8+）。

/**
 * GeoForge 错误码（L6 预设层子集）。
 * 用于 `instanceof GeoForgeError` 与 `code` 分支处理。
 */
export const GeoForgeErrorCode = {
    /** 容器选择器未匹配到任何元素，或传入非法 HTMLElement。 */
    CONFIG_INVALID_CONTAINER: 'CONFIG_INVALID_CONTAINER',
    /** center / zoom / bounds 等参数超出可接受范围或 NaN。 */
    CONFIG_INVALID_VIEW: 'CONFIG_INVALID_VIEW',
    /** addSource / addLayer 等操作的 id 非法（空串、重复）。 */
    CONFIG_INVALID_ID: 'CONFIG_INVALID_ID',
    /** 引用的 source / layer 不存在。 */
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    /** 地图实例已销毁仍被调用。 */
    MAP_DESTROYED: 'MAP_DESTROYED',
} as const;

/**
 * 错误码联合类型（与 {@link GeoForgeErrorCode} 常量值一致）。
 */
export type GeoForgeErrorCode = (typeof GeoForgeErrorCode)[keyof typeof GeoForgeErrorCode];

/**
 * 结构化错误：携带 `code` 与可选 `context`，便于日志与 DevTools。
 */
export class GeoForgeError extends Error {
    /** 机器可读错误码。 */
    public readonly code: GeoForgeErrorCode;

    /** 附加上下文（图层 id、source id 等），便于定位。 */
    public readonly context?: Record<string, unknown>;

    /**
     * @param code - 错误码枚举值
     * @param message - 人类可读说明
     * @param context - 可选上下文键值
     * @param cause - 可选底层原因（ES2022 cause）
     */
    constructor(
        code: GeoForgeErrorCode,
        message: string,
        context?: Record<string, unknown>,
        cause?: unknown,
    ) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = 'GeoForgeError';
        this.code = code;
        this.context = context;
        Object.setPrototypeOf(this, GeoForgeError.prototype);
    }
}

// ===================== 动画 / 飞行选项 =====================

/**
 * 地图视口内边距（像素），用于 fitBounds / flyTo 等留空区域。
 */
export interface PaddingOptions {
    /** 上内边距，默认 0，范围 [0, +∞)。 */
    top?: number;
    /** 下内边距，默认 0，范围 [0, +∞)。 */
    bottom?: number;
    /** 左内边距，默认 0，范围 [0, +∞)。 */
    left?: number;
    /** 右内边距，默认 0，范围 [0, +∞)。 */
    right?: number;
}

/**
 * 通用相机动画选项（setCenter / setZoom 等）。
 */
export interface AnimationOptions {
    /** 动画时长（毫秒）；0 或 undefined 表示无动画瞬时切换。 */
    duration?: number;
    /** 缓动函数，参数 t∈[0,1]，返回插值系数。 */
    easing?: (t: number) => number;
}

/**
 * flyTo / easeTo 的完整选项（对标 MapLibre 子集）。
 */
export interface FlyToOptions {
    /** 目标中心 [lng, lat]（度）。 */
    center?: [number, number];
    /** 目标缩放级别。 */
    zoom?: number;
    /** 目标方位角（弧度，GeoForge 内部统一 bearing）。 */
    bearing?: number;
    /** 目标俯仰角（弧度）。 */
    pitch?: number;
    /** 动画时长（毫秒），默认 {@link DEFAULT_FLIGHT_DURATION_MS}。 */
    duration?: number;
    /** 缓动函数；默认 cubic ease-in-out。 */
    easing?: (t: number) => number;
    /** 飞行曲线参数（预留，MVP 不模拟弧高）。 */
    curve?: number;
    /** 视口内边距。 */
    padding?: PaddingOptions;
}

// ===================== 事件类型 =====================

/**
 * 地图事件名联合（对标 MapLibre 常用子集）。
 */
export type MapEventType =
    | 'click'
    | 'dblclick'
    | 'contextmenu'
    | 'mousedown'
    | 'mouseup'
    | 'mousemove'
    | 'mouseenter'
    | 'mouseleave'
    | 'touchstart'
    | 'touchend'
    | 'touchmove'
    | 'wheel'
    | 'movestart'
    | 'move'
    | 'moveend'
    | 'zoomstart'
    | 'zoom'
    | 'zoomend'
    | 'rotatestart'
    | 'rotate'
    | 'rotateend'
    | 'pitchstart'
    | 'pitch'
    | 'pitchend'
    | 'load'
    | 'idle'
    | 'resize'
    | 'remove'
    | 'data'
    | 'sourcedata'
    | 'tiledata'
    | 'error'
    | 'render'
    | 'prerender'
    | 'postrender';

/**
 * 基础地图事件：携带事件类型与目标地图实例。
 */
export interface MapEvent {
    /** 事件类型字面量。 */
    readonly type: MapEventType;
    /** 事件目标（当前为 Map2D）。 */
    readonly target: Map2D;
}

/**
 * 指针类地图事件：包含地理坐标与屏幕坐标。
 */
export interface MapMouseEvent extends MapEvent {
    /** 事件对应的经纬度（度）。 */
    readonly lngLat: [number, number];
    /** 相对地图容器的 CSS 像素坐标。 */
    readonly point: [number, number];
    /** 异步拾取结果（MVP 通常为空数组）。 */
    readonly features?: PickResult[];
    /** 底层 DOM 指针事件。 */
    readonly originalEvent: MouseEvent;

    /**
     * 阻止默认浏览器行为（委托给 originalEvent）。
     */
    preventDefault(): void;
}

// ===================== 图层 / 数据源（简化规格）=====================

/**
 * 简化图层规格：声明式描述数据来源与样式字段。
 */
export interface LayerSpec {
    /** 图层唯一 id。 */
    readonly id: string;
    /** 图层类型（raster / fill / line / symbol / background / custom 等）。 */
    readonly type: string;
    /** 数据源 id 或内联 SourceSpec。 */
    readonly source?: string | SourceSpec;
    /** 矢量切片 source-layer 名称。 */
    readonly 'source-layer'?: string;
    /** 最小可见缩放级别。 */
    readonly minzoom?: number;
    /** 最大可见缩放级别。 */
    readonly maxzoom?: number;
    /** 过滤器表达式（MapLibre 风格数组）。 */
    readonly filter?: FilterExpression;
    /** layout 属性键值。 */
    readonly layout?: Record<string, unknown>;
    /** paint 属性键值。 */
    readonly paint?: Record<string, unknown>;
    /** 插入到指定图层 id 之前。 */
    readonly beforeId?: string;
}

/**
 * 简化数据源规格。
 */
export interface SourceSpec {
    /** 数据源类型。 */
    readonly type: string;
    /** TileJSON 或 manifest URL。 */
    readonly url?: string;
    /** 瓦片 URL 模板列表。 */
    readonly tiles?: string[];
    /** 内联 GeoJSON 或任意负载。 */
    readonly data?: unknown;
    /** 栅格瓦片尺寸（像素），默认 512/256 依规范。 */
    readonly tileSize?: number;
    /** 最小缩放级别。 */
    readonly minzoom?: number;
    /** 最大缩放级别。 */
    readonly maxzoom?: number;
    /** 归属/版权显示字符串。 */
    readonly attribution?: string;
}

// ===================== 地图构造选项 / 控件协议 =====================

/**
 * Map2D 构造函数选项。
 */
export interface Map2DOptions {
    /** 容器：CSS 选择器或 HTMLElement。 */
    container: string | HTMLElement;
    /** 初始中心 [lng,lat]（度）。 */
    center?: [number, number];
    /** 初始缩放级别。 */
    zoom?: number;
    /** 最小缩放级别。 */
    minZoom?: number;
    /** 最大缩放级别。 */
    maxZoom?: number;
    /** 初始显示范围（与 center/zoom 二选一时优先生效）。 */
    bounds?: BBox2D;
    /** 样式 URL 或内联 StyleSpec。 */
    style?: string | StyleSpec;
    /** 投影名（MVP 仅占位）。 */
    projection?: string;
    /** 是否可交互（MVP 仅占位）。 */
    interactive?: boolean;
    /** 滚轮缩放（占位）。 */
    scrollZoom?: boolean;
    /** 框选缩放（占位）。 */
    boxZoom?: boolean;
    /** 拖拽旋转（占位）。 */
    dragRotate?: boolean;
    /** 拖拽平移（占位）。 */
    dragPan?: boolean;
    /** 键盘导航（占位）。 */
    keyboard?: boolean;
    /** 双击缩放（占位）。 */
    doubleClickZoom?: boolean;
    /** 触摸缩放旋转（占位）。 */
    touchZoomRotate?: boolean;
    /** 协作手势（占位）。 */
    cooperativeGestures?: boolean;
    /** 抗锯齿（占位）。 */
    antialias?: boolean;
    /** 最大 devicePixelRatio 上限。 */
    maxPixelRatio?: number;
    /** 保留绘制缓冲（占位）。 */
    preserveDrawingBuffer?: boolean;
    /** 请求渲染模式（占位）。 */
    requestRenderMode?: boolean;
    /** URL hash 同步。 */
    hash?: boolean | string;
    /** 国际化字符串表。 */
    locale?: Record<string, string>;
    /** Canvas 无障碍标题。 */
    accessibleTitle?: string;
}

/**
 * 控件停靠角位置。
 */
export type ControlPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/**
 * UI 控件接口：与 MapLibre IControl 对齐的 MVP 子集。
 */
export interface IControl {
    /**
     * 控件添加到地图时调用，返回根 DOM 元素。
     *
     * @param map - 宿主 Map2D 实例
     * @returns 控件根元素
     */
    onAdd(map: Map2D): HTMLElement;

    /**
     * 控件从地图移除时调用，负责解绑事件与清理。
     *
     * @param map - 宿主 Map2D 实例
     */
    onRemove(map: Map2D): void;

    /**
     * 默认建议停靠位置。
     *
     * @returns 四角之一
     */
    getDefaultPosition(): ControlPosition;
}

// ===================== 内部：图层运行时条目 =====================

/**
 * 图层运行时：在 LayerSpec 基础上保留可变 layout/paint/filter。
 */
interface LayerRuntimeEntry {
    /** 原始规格（用于追溯 beforeId 等）。 */
    readonly base: LayerSpec;
    /** 当前 layout（可被 setLayoutProperty 修改）。 */
    layout: Record<string, unknown>;
    /** 当前 paint（可被 setPaintProperty 修改）。 */
    paint: Record<string, unknown>;
    /** 当前过滤器。 */
    filter: FilterExpression | null;
    /** 是否可见。 */
    visible: boolean;
}

// ===================== 内部：轻量事件发射器 =====================

/**
 * 字符串键事件发射器（零依赖），用于 Map2D 的 on/once/off。
 */
class MapInternalEmitter {
    /** 事件名 → 处理器集合。 */
    private readonly _listeners: Map<string, Set<(ev: MapEvent | MapMouseEvent) => void>> = new Map();

    /** once 包装器：原始 → 包装。 */
    private readonly _onceWrappers: Map<
        (ev: MapEvent | MapMouseEvent) => void,
        (ev: MapEvent | MapMouseEvent) => void
    > = new Map();

    /**
     * 注册事件。
     *
     * @param key - 事件键（含 `type:layerId` 约定）
     * @param handler - 回调
     */
    public on(key: string, handler: (ev: MapEvent | MapMouseEvent) => void): void {
        let set = this._listeners.get(key);
        if (set === undefined) {
            set = new Set();
            this._listeners.set(key, set);
        }
        set.add(handler);
    }

    /**
     * 注销事件；省略 handler 时移除该 key 下全部监听。
     *
     * @param key - 事件键
     * @param handler - 可选回调引用
     */
    public off(key: string, handler?: (ev: MapEvent | MapMouseEvent) => void): void {
        if (handler === undefined) {
            this._listeners.delete(key);
            return;
        }
        const set = this._listeners.get(key);
        if (set === undefined) {
            return;
        }
        set.delete(handler);
        const w = this._onceWrappers.get(handler);
        if (w !== undefined) {
            set.delete(w);
            this._onceWrappers.delete(handler);
        }
        if (set.size === 0) {
            this._listeners.delete(key);
        }
    }

    /**
     * 注册一次性监听。
     *
     * @param key - 事件键
     * @param handler - 回调
     */
    public once(key: string, handler: (ev: MapEvent | MapMouseEvent) => void): void {
        const wrapper: (ev: MapEvent | MapMouseEvent) => void = (ev) => {
            this.off(key, wrapper);
            this._onceWrappers.delete(handler);
            handler(ev);
        };
        this._onceWrappers.set(handler, wrapper);
        this.on(key, wrapper);
    }

    /**
     * 同步派发事件；吞掉单个处理器异常，避免中断其余监听。
     *
     * @param key - 事件键
     * @param event - 事件对象
     */
    public emit(key: string, event: MapEvent | MapMouseEvent): void {
        const set = this._listeners.get(key);
        if (set === undefined) {
            return;
        }
        for (const fn of set) {
            try {
                fn(event);
            } catch (err) {
                // 单个监听失败不影响其他监听；开发环境可打印
                devError('[Map2D] event handler error', err);
            }
        }
    }

    /**
     * 移除所有监听（用于 destroy）。
     */
    public removeAllListeners(): void {
        this._listeners.clear();
        this._onceWrappers.clear();
    }
}

// ===================== 纯函数：校验与地理辅助 =====================

/**
 * 校验经纬度对是否有限且范围合法（宽松 WGS84 边界）。
 *
 * @param c - [lng, lat]
 * @returns 合法返回 true
 *
 * @example
 * assertValidLngLat([116, 39]); // true
 */
function assertValidLngLat(c: [number, number]): boolean {
    const lng = c[0];
    const lat = c[1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return false;
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return false;
    }
    return true;
}

/**
 * 将 zoom 限制在 [minZ, maxZ]。
 *
 * @param z - 输入缩放
 * @param minZ - 下限
 * @param maxZ - 上限
 * @returns 裁剪后的缩放
 */
function clampZoom(z: number, minZ: number, maxZ: number): number {
    if (!Number.isFinite(z)) {
        return minZ;
    }
    if (z < minZ) {
        return minZ;
    }
    if (z > maxZ) {
        return maxZ;
    }
    return z;
}

/**
 * 根据中心、缩放与画布尺寸估算视口地理包围盒（Web 墨卡托近似，MVP）。
 *
 * @param center - [lng, lat]
 * @param zoom - 缩放级别
 * @param width - CSS 像素宽
 * @param height - CSS 像素高
 * @returns 轴对齐包围盒
 *
 * @example
 * const b = approximateBoundsFromView([0,0], 2, 800, 600);
 */
function approximateBoundsFromView(
    center: [number, number],
    zoom: number,
    width: number,
    height: number,
): BBox2D {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    const z = clampZoom(zoom, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL);
    const scale = WORLD_SIZE_PX * Math.pow(2, z);
    const lng = center[0];
    const lat = center[1];
    const latRad = (lat * Math.PI) / 180;
    const cosLat = Math.max(Math.cos(latRad), 1e-6);
    const halfLng = ((safeW / scale) * 180) / cosLat;
    const halfLat = ((safeH / scale) * 180) / Math.PI;
    return {
        west: lng - halfLng,
        east: lng + halfLng,
        south: lat - halfLat,
        north: lat + halfLat,
    };
}

/**
 * 判定 a 是否完全包含 b（轴对齐，带 epsilon）。
 *
 * @param outer - 外盒
 * @param inner - 内盒
 * @returns outer ⊇ inner 时 true
 */
function boundsContains(outer: BBox2D, inner: BBox2D): boolean {
    return (
        outer.west <= inner.west + BOUNDS_EPSILON &&
        outer.east >= inner.east - BOUNDS_EPSILON &&
        outer.south <= inner.south + BOUNDS_EPSILON &&
        outer.north >= inner.north - BOUNDS_EPSILON
    );
}

/**
 * 根据包围盒与画布尺寸计算合适的中心与最大可用缩放（MVP 线性近似）。
 *
 * @param bounds - 目标地理范围
 * @param width - 可用像素宽（已扣 padding）
 * @param height - 可用像素高（已扣 padding）
 * @param minZ - 地图允许最小缩放
 * @param maxZ - 地图允许最大缩放
 * @returns 中心与缩放
 */
function fitCenterZoom(
    bounds: BBox2D,
    width: number,
    height: number,
    minZ: number,
    maxZ: number,
): { center: [number, number]; zoom: number } {
    const spanLng = bounds.east - bounds.west;
    const spanLat = bounds.north - bounds.south;
    if (!(spanLng > 0 && spanLat > 0)) {
        throw new GeoForgeError(
            GeoForgeErrorCode.CONFIG_INVALID_VIEW,
            'bounds 必须具有正的经纬跨度',
            { bounds },
        );
    }
    const center: [number, number] = [
        (bounds.west + bounds.east) * 0.5,
        (bounds.south + bounds.north) * 0.5,
    ];
    if (!assertValidLngLat(center)) {
        throw new GeoForgeError(
            GeoForgeErrorCode.CONFIG_INVALID_VIEW,
            'bounds 推导的中心点不合法',
            { center, bounds },
        );
    }
    let chosenZ = minZ;
    for (let z = maxZ; z >= minZ; z--) {
        const vb = approximateBoundsFromView(center, z, width, height);
        if (boundsContains(vb, bounds)) {
            chosenZ = z;
            break;
        }
    }
    return { center, zoom: chosenZ };
}

/**
 * 解析 padding 四边为数值（默认 0）。
 *
 * @param p - 用户 padding
 * @returns 四边数值
 */
function normalizePadding(p?: PaddingOptions): { top: number; bottom: number; left: number; right: number } {
    return {
        top: p?.top ?? 0,
        bottom: p?.bottom ?? 0,
        left: p?.left ?? 0,
        right: p?.right ?? 0,
    };
}

/**
 * 生成要素状态复合键。
 *
 * @param source - 数据源 id
 * @param id - 要素 id
 * @returns 内部 Map 键
 */
function featureStateKey(source: string, id: string | number): string {
    return `${source}\u0001${String(id)}`;
}

// ===================== Map2D 类 =====================

/**
 * Map2D：2D 地图 MVP 入口类（无 WebGPU 初始化）。
 *
 * @example
 * const map = new Map2D({ container: '#map', center: [116.39, 39.91], zoom: 10 });
 * await map.ready();
 */
export class Map2D {
    /** 异步初始化 Promise（构造时启动）。 */
    private readonly _ready: Promise<void>;

    /** 内部异步初始化是否已完成。 */
    private _initialized = false;

    /** 实例是否已销毁。 */
    private _destroyed = false;

    /** 防止 remove() 重入（监听器内再次 remove）。 */
    private _removing = false;

    /** 地图是否完成首次 load（MVP：ready 后即 true）。 */
    private _loaded = false;

    /** 当前中心 [lng,lat]。 */
    private _center: [number, number];

    /** 当前缩放级别。 */
    private _zoom: number;

    /** 方位角（弧度）。 */
    private _bearing: number;

    /** 俯仰角（弧度）。 */
    private _pitch: number;

    /** 最小缩放。 */
    private readonly _minZoom: number;

    /** 最大缩放。 */
    private readonly _maxZoom: number;

    /** 主画布元素。 */
    private readonly _canvas: HTMLCanvasElement;

    /** 容器元素。 */
    private readonly _container: HTMLElement;

    /** 控件根：四角定位容器。 */
    private readonly _controlRoot: HTMLElement;

    /** 已注册控件（用于 remove/has）。 */
    private readonly _controls: Map<IControl, { element: HTMLElement; position: ControlPosition }> = new Map();

    /** 数据源 id → 规格。 */
    private readonly _sources: Map<string, SourceSpec> = new Map();

    /** 图层 id → 运行时条目。 */
    private readonly _layers: Map<string, LayerRuntimeEntry> = new Map();

    /** 图层顺序（从底到顶）。 */
    private readonly _layerOrder: string[] = [];

    /** 要素状态表。 */
    private readonly _featureStates: Map<string, Record<string, unknown>> = new Map();

    /** 内部事件发射器。 */
    private readonly _emitter: MapInternalEmitter = new MapInternalEmitter();

    /** 当前相机动画 rAF id；无动画时为 null。 */
    private _animFrameId: number | null = null;

    /** 平移/飞行动画中。 */
    private _moving = false;

    /** 缩放动画中。 */
    private _zooming = false;

    /** 构造选项副本（只读字段快照）。 */
    private readonly _options: Readonly<Map2DOptions>;

    /**
     * 创建 Map2D：挂载 canvas、解析视图参数并启动异步初始化。
     *
     * @param options - 地图选项
     *
     * @example
     * const m = new Map2D({ container: 'body', zoom: 3, center: [0, 0] });
     */
    constructor(options: Map2DOptions) {
        if (options === undefined || options === null) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'Map2DOptions 不能为空',
            );
        }
        this._options = { ...options };
        const maxPR = options.maxPixelRatio ?? 2;
        this._minZoom = clampZoom(options.minZoom ?? MIN_ZOOM_LEVEL, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL);
        this._maxZoom = clampZoom(options.maxZoom ?? MAX_ZOOM_LEVEL, this._minZoom, MAX_ZOOM_LEVEL);
        this._container = this._resolveContainer(options.container);
        this._canvas = document.createElement('canvas');
        const title = options.accessibleTitle ?? 'GeoForge Map2D';
        this._canvas.setAttribute('role', 'application');
        this._canvas.setAttribute('aria-label', title);
        this._canvas.style.display = 'block';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._container.style.position = 'relative';
        this._container.appendChild(this._canvas);
        this._controlRoot = document.createElement('div');
        this._controlRoot.style.position = 'absolute';
        this._controlRoot.style.inset = '0';
        this._controlRoot.style.pointerEvents = 'none';
        this._container.appendChild(this._controlRoot);
        const initialCenter: [number, number] = options.center ?? [0, 0];
        if (!assertValidLngLat(initialCenter)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                '初始 center 经纬度非法',
                { center: initialCenter },
            );
        }
        this._center = [initialCenter[0], initialCenter[1]];
        this._zoom = clampZoom(options.zoom ?? 1, this._minZoom, this._maxZoom);
        this._bearing = 0;
        this._pitch = 0;
        if (options.bounds !== undefined) {
            this._applyInitialBounds(options.bounds);
        }
        this._resizeCanvasInternal(maxPR);
        this._ready = this._bootstrapAsync();
    }

    /**
     * 异步初始化：MVP 仅微任务解析，不触碰 WebGPU。
     *
     * @returns 初始化完成的 Promise
     */
    private async _bootstrapAsync(): Promise<void> {
        await Promise.resolve();
        if (this._destroyed) {
            return;
        }
        this._initialized = true;
        this._loaded = true;
        this._emitBase('load', { type: 'load', target: this });
        this._emitBase('idle', { type: 'idle', target: this });
    }

    /**
     * 解析容器为 HTMLElement。
     *
     * @param container - 选择器或元素
     * @returns 容器元素
     */
    private _resolveContainer(container: string | HTMLElement): HTMLElement {
        if (typeof container === 'string') {
            const el = document.querySelector(container);
            if (el === null || !(el instanceof HTMLElement)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    `容器选择器未匹配到 HTMLElement: ${container}`,
                    { selector: container },
                );
            }
            return el;
        }
        if (!(container instanceof HTMLElement)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                'container 必须是 HTMLElement',
            );
        }
        return container;
    }

    /**
     * 使用初始 bounds 设置 center/zoom（瞬时）。
     *
     * @param bounds - 地理包围盒
     */
    private _applyInitialBounds(bounds: BBox2D): void {
        const pad = normalizePadding(undefined);
        const w = Math.max(
            1,
            this._container.clientWidth - pad.left - pad.right,
        );
        const h = Math.max(
            1,
            this._container.clientHeight - pad.top - pad.bottom,
        );
        const { center, zoom } = fitCenterZoom(bounds, w, h, this._minZoom, this._maxZoom);
        this._center = center;
        this._zoom = zoom;
    }

    /**
     * 根据容器尺寸设置 canvas 像素尺寸与 CSS 尺寸。
     *
     * @param maxPixelRatio - DPR 上限
     */
    private _resizeCanvasInternal(maxPixelRatio: number): void {
        const rect = this._container.getBoundingClientRect();
        const cssW = Math.max(1, Math.floor(rect.width));
        const cssH = Math.max(1, Math.floor(rect.height));
        const dpr = Math.min(
            typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
                ? window.devicePixelRatio
                : 1,
            maxPixelRatio,
        );
        const bufW = Math.max(1, Math.floor(cssW * dpr));
        const bufH = Math.max(1, Math.floor(cssH * dpr));
        this._canvas.width = bufW;
        this._canvas.height = bufH;
        this._canvas.style.width = `${cssW}px`;
        this._canvas.style.height = `${cssH}px`;
    }

    /**
     * 派发基础 MapEvent（无指针字段）。
     *
     * @param type - 事件类型
     * @param ev - 事件对象
     */
    private _emitBase(type: MapEventType, ev: MapEvent): void {
        this._emitter.emit(type, ev);
        const layerKeys = this._layerEventKeys(type);
        for (const lk of layerKeys) {
            this._emitter.emit(lk, ev);
        }
    }

    /**
     * 枚举与图层绑定的内部事件键（`type:layerId`）。
     *
     * @param type - 事件类型
     * @returns 键列表
     */
    private _layerEventKeys(type: MapEventType): string[] {
        const keys: string[] = [];
        for (const id of this._layerOrder) {
            keys.push(`${type}:${id}`);
        }
        return keys;
    }

    /**
     * 取消进行中的相机动画。
     */
    private _cancelAnimations(): void {
        if (this._animFrameId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._animFrameId);
        }
        this._animFrameId = null;
        this._moving = false;
        this._zooming = false;
    }

    /**
     * 返回初始化 Promise。
     *
     * @returns ready Promise
     *
     * @example
     * await map.ready();
     */
    public ready(): Promise<void> {
        return this._ready;
    }

    /**
     * 获取当前地图中心。
     *
     * @returns [lng, lat] 度
     *
     * @example
     * const c = map.getCenter();
     */
    public getCenter(): [number, number] {
        this._ensureAlive();
        return [this._center[0], this._center[1]];
    }

    /**
     * 设置地图中心；可选动画。
     *
     * @param center - 目标中心
     * @param options - 动画参数
     * @returns this
     *
     * @example
     * map.setCenter([10, 20], { duration: 300 });
     */
    public setCenter(center: [number, number], options?: AnimationOptions): this {
        this._ensureAlive();
        if (!assertValidLngLat(center)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'setCenter 收到非法经纬度',
                { center },
            );
        }
        const duration = options?.duration ?? 0;
        if (!Number.isFinite(duration) || duration < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'duration 必须为非负有限数',
                { duration },
            );
        }
        if (duration === 0) {
            this._center = [center[0], center[1]];
            this._emitBase('move', { type: 'move', target: this });
            return this;
        }
        this._animateCameraTo(
            { center: [center[0], center[1]], zoom: this._zoom, bearing: this._bearing, pitch: this._pitch },
            duration,
            options?.easing ?? DEFAULT_EASING_FN,
            false,
        );
        return this;
    }

    /**
     * 获取当前缩放级别。
     *
     * @returns zoom
     */
    public getZoom(): number {
        this._ensureAlive();
        return this._zoom;
    }

    /**
     * 设置缩放级别；可选动画。
     *
     * @param zoom - 目标 zoom
     * @param options - 动画参数
     * @returns this
     */
    public setZoom(zoom: number, options?: AnimationOptions): this {
        this._ensureAlive();
        const z = clampZoom(zoom, this._minZoom, this._maxZoom);
        const duration = options?.duration ?? 0;
        if (!Number.isFinite(duration) || duration < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'duration 必须为非负有限数',
                { duration },
            );
        }
        if (duration === 0) {
            this._zoom = z;
            this._emitZoomEvents();
            return this;
        }
        this._animateCameraTo(
            { center: this._center, zoom: z, bearing: this._bearing, pitch: this._pitch },
            duration,
            options?.easing ?? DEFAULT_EASING_FN,
            true,
        );
        return this;
    }

    /**
     * 派发缩放相关事件序列（start/zoom/end）。
     */
    private _emitZoomEvents(): void {
        this._emitBase('zoom', { type: 'zoom', target: this });
        this._emitBase('move', { type: 'move', target: this });
    }

    /**
     * 获取当前视口近似地理包围盒。
     *
     * @returns BBox2D
     */
    public getBounds(): BBox2D {
        this._ensureAlive();
        const rect = this._canvas.getBoundingClientRect();
        const cssW = Math.max(1, rect.width);
        const cssH = Math.max(1, rect.height);
        return approximateBoundsFromView(this._center, this._zoom, cssW, cssH);
    }

    /**
     * 将视图适配到给定 bounds（可选动画）。
     *
     * @param bounds - 目标范围
     * @param options - padding 与 duration
     * @returns this
     */
    public setBounds(bounds: BBox2D, options?: { padding?: PaddingOptions; duration?: number }): this {
        this._ensureAlive();
        const pad = normalizePadding(options?.padding);
        const cssW = Math.max(
            1,
            this._container.clientWidth - pad.left - pad.right,
        );
        const cssH = Math.max(
            1,
            this._container.clientHeight - pad.top - pad.bottom,
        );
        const { center, zoom } = fitCenterZoom(bounds, cssW, cssH, this._minZoom, this._maxZoom);
        const duration = options?.duration ?? 0;
        if (!Number.isFinite(duration) || duration < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'duration 必须为非负有限数',
                { duration },
            );
        }
        if (duration === 0) {
            this._center = center;
            this._zoom = zoom;
            this._emitBase('move', { type: 'move', target: this });
            return this;
        }
        this._animateCameraTo(
            { center, zoom, bearing: this._bearing, pitch: this._pitch },
            duration,
            DEFAULT_EASING_FN,
            true,
        );
        return this;
    }

    /**
     * 飞行动画至目标视图（MVP：等价于平滑插值，忽略 curve 高度）。
     *
     * @param options - FlyToOptions
     * @returns this
     */
    public flyTo(options: FlyToOptions): this {
        this._ensureAlive();
        const duration = options.duration ?? DEFAULT_FLIGHT_DURATION_MS;
        if (!Number.isFinite(duration) || duration < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'flyTo duration 非法',
                { duration },
            );
        }
        const targetCenter = options.center ?? this._center;
        if (!assertValidLngLat(targetCenter)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'flyTo center 非法',
                { center: targetCenter },
            );
        }
        const targetZoom = options.zoom !== undefined
            ? clampZoom(options.zoom, this._minZoom, this._maxZoom)
            : this._zoom;
        const targetBearing = options.bearing ?? this._bearing;
        const targetPitch = options.pitch ?? this._pitch;
        if (!Number.isFinite(targetBearing) || !Number.isFinite(targetPitch)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'bearing/pitch 必须为有限数',
                { targetBearing, targetPitch },
            );
        }
        this._animateCameraTo(
            {
                center: [targetCenter[0], targetCenter[1]],
                zoom: targetZoom,
                bearing: targetBearing,
                pitch: targetPitch,
            },
            duration,
            options.easing ?? DEFAULT_EASING_FN,
            true,
        );
        return this;
    }

    /**
     * 与 flyTo 类似；MVP 实现相同。
     *
     * @param options - FlyToOptions
     * @returns this
     */
    public easeTo(options: FlyToOptions): this {
        return this.flyTo(options);
    }

    /**
     * 瞬时跳转至目标视图（无 duration）。
     *
     * @param options - 省略 duration/easing 的 FlyToOptions
     * @returns this
     */
    public jumpTo(options: Omit<FlyToOptions, 'duration' | 'easing'>): this {
        this._ensureAlive();
        const c = options.center ?? this._center;
        if (!assertValidLngLat(c)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'jumpTo center 非法',
                { center: c },
            );
        }
        this._center = [c[0], c[1]];
        if (options.zoom !== undefined) {
            this._zoom = clampZoom(options.zoom, this._minZoom, this._maxZoom);
        }
        if (options.bearing !== undefined) {
            this._bearing = options.bearing;
        }
        if (options.pitch !== undefined) {
            this._pitch = options.pitch;
        }
        this._emitBase('move', { type: 'move', target: this });
        return this;
    }

    /**
     * 将视图适配 bounds，可选最大 zoom 与动画。
     *
     * @param bounds - 数据范围
     * @param options - padding / duration / maxZoom
     * @returns this
     */
    public fitBounds(
        bounds: BBox2D,
        options?: { padding?: PaddingOptions; duration?: number; maxZoom?: number },
    ): this {
        this._ensureAlive();
        const pad = normalizePadding(options?.padding);
        const cssW = Math.max(
            1,
            this._container.clientWidth - pad.left - pad.right,
        );
        const cssH = Math.max(
            1,
            this._container.clientHeight - pad.top - pad.bottom,
        );
        let { center, zoom } = fitCenterZoom(bounds, cssW, cssH, this._minZoom, this._maxZoom);
        if (options?.maxZoom !== undefined) {
            const mz = clampZoom(options.maxZoom, this._minZoom, this._maxZoom);
            if (!Number.isFinite(mz)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                    'maxZoom 非法',
                    { maxZoom: options.maxZoom },
                );
            }
            zoom = Math.min(zoom, mz);
        }
        const duration = options?.duration ?? 0;
        if (!Number.isFinite(duration) || duration < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                'duration 必须为非负有限数',
                { duration },
            );
        }
        if (duration === 0) {
            this._center = center;
            this._zoom = zoom;
            this._emitBase('move', { type: 'move', target: this });
            return this;
        }
        this._animateCameraTo(
            { center, zoom, bearing: this._bearing, pitch: this._pitch },
            duration,
            DEFAULT_EASING_FN,
            true,
        );
        return this;
    }

    /**
     * 停止当前相机动画。
     *
     * @returns this
     */
    public stop(): this {
        this._ensureAlive();
        this._cancelAnimations();
        this._emitBase('moveend', { type: 'moveend', target: this });
        this._emitBase('zoomend', { type: 'zoomend', target: this });
        return this;
    }

    /**
     * 是否处于平移/飞行动画中。
     *
     * @returns moving
     */
    public isMoving(): boolean {
        this._ensureAlive();
        return this._moving;
    }

    /**
     * 是否处于缩放动画中。
     *
     * @returns zooming
     */
    public isZooming(): boolean {
        this._ensureAlive();
        return this._zooming;
    }

    /**
     * 插值相机动画（单 rAF 时间线）。
     *
     * @param target - 目标状态
     * @param durationMs - 时长
     * @param easing - 缓动
     * @param zooming - 是否视为缩放动画（用于 isZooming）
     */
    private _animateCameraTo(
        target: {
            center: [number, number];
            zoom: number;
            bearing: number;
            pitch: number;
        },
        durationMs: number,
        easing: (t: number) => number,
        zooming: boolean,
    ): void {
        this._cancelAnimations();
        const startCenter: [number, number] = [this._center[0], this._center[1]];
        const startZoom = this._zoom;
        const startBearing = this._bearing;
        const startPitch = this._pitch;
        const start = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        this._moving = true;
        this._zooming = zooming;
        this._emitBase('movestart', { type: 'movestart', target: this });
        if (zooming) {
            this._emitBase('zoomstart', { type: 'zoomstart', target: this });
        }
        const step = (now: number) => {
            if (this._destroyed) {
                return;
            }
            const t = Math.min(1, (now - start) / durationMs);
            const k = easing(t);
            this._center = [
                startCenter[0] + (target.center[0] - startCenter[0]) * k,
                startCenter[1] + (target.center[1] - startCenter[1]) * k,
            ];
            this._zoom = startZoom + (target.zoom - startZoom) * k;
            this._bearing = startBearing + (target.bearing - startBearing) * k;
            this._pitch = startPitch + (target.pitch - startPitch) * k;
            this._emitBase('move', { type: 'move', target: this });
            if (zooming) {
                this._emitBase('zoom', { type: 'zoom', target: this });
            }
            if (t < 1) {
                this._animFrameId = requestAnimationFrame(step);
            } else {
                this._animFrameId = null;
                this._moving = false;
                this._zooming = false;
                this._center = [target.center[0], target.center[1]];
                this._zoom = clampZoom(target.zoom, this._minZoom, this._maxZoom);
                this._bearing = target.bearing;
                this._pitch = target.pitch;
                this._emitBase('moveend', { type: 'moveend', target: this });
                if (zooming) {
                    this._emitBase('zoomend', { type: 'zoomend', target: this });
                }
                this._emitBase('idle', { type: 'idle', target: this });
            }
        };
        this._animFrameId = requestAnimationFrame(step);
    }

    /**
     * 添加数据源。
     *
     * @param id - 数据源 id
     * @param source - 规格
     * @returns this
     */
    public addSource(id: string, source: SourceSpec): this {
        this._ensureAlive();
        if (id === undefined || id === null || String(id).trim() === '') {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                '数据源 id 不能为空',
            );
        }
        if (this._sources.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                '数据源已存在',
                { id },
            );
        }
        this._sources.set(id, source);
        this._emitBase('data', { type: 'data', target: this });
        return this;
    }

    /**
     * 移除数据源。
     *
     * @param id - 数据源 id
     * @returns this
     */
    public removeSource(id: string): this {
        this._ensureAlive();
        if (!this._sources.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '数据源不存在',
                { id },
            );
        }
        this._sources.delete(id);
        return this;
    }

    /**
     * 获取数据源规格。
     *
     * @param id - id
     * @returns 规格或 undefined
     */
    public getSource(id: string): SourceSpec | undefined {
        this._ensureAlive();
        return this._sources.get(id);
    }

    /**
     * 添加图层。
     *
     * @param layer - LayerSpec
     * @returns this
     */
    public addLayer(layer: LayerSpec): this {
        this._ensureAlive();
        const id = layer.id;
        if (id === undefined || String(id).trim() === '') {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                '图层 id 不能为空',
            );
        }
        if (this._layers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                '图层已存在',
                { id },
            );
        }
        const src = layer.source;
        if (typeof src === 'string') {
            if (!this._sources.has(src)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_NOT_FOUND,
                    '图层引用的数据源不存在',
                    { layerId: id, sourceId: src },
                );
            }
        }
        const layout: Record<string, unknown> = layer.layout !== undefined
            ? { ...layer.layout }
            : {};
        const paint: Record<string, unknown> = layer.paint !== undefined ? { ...layer.paint } : {};
        const filterVal = layer.filter ?? null;
        const entry: LayerRuntimeEntry = {
            base: layer,
            layout,
            paint,
            filter: filterVal,
            visible: true,
        };
        if (layer.beforeId !== undefined) {
            if (layer.beforeId === id) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_ID,
                    'beforeId 不能与当前图层 id 相同',
                    { id },
                );
            }
            if (!this._layers.has(layer.beforeId)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_NOT_FOUND,
                    'beforeId 引用的图层不存在',
                    { beforeId: layer.beforeId },
                );
            }
        }
        this._layers.set(id, entry);
        if (layer.beforeId !== undefined) {
            const idx = this._layerOrder.indexOf(layer.beforeId);
            if (idx >= 0) {
                this._layerOrder.splice(idx, 0, id);
            } else {
                this._layerOrder.push(id);
            }
        } else {
            this._layerOrder.push(id);
        }
        this._emitBase('data', { type: 'data', target: this });
        return this;
    }

    /**
     * 移除图层。
     *
     * @param id - 图层 id
     * @returns this
     */
    public removeLayer(id: string): this {
        this._ensureAlive();
        if (!this._layers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { id },
            );
        }
        this._layers.delete(id);
        const ix = this._layerOrder.indexOf(id);
        if (ix >= 0) {
            this._layerOrder.splice(ix, 1);
        }
        return this;
    }

    /**
     * 获取图层合成规格（layout/paint 为运行时拷贝）。
     *
     * @param id - 图层 id
     * @returns LayerSpec 或 undefined
     */
    public getLayer(id: string): LayerSpec | undefined {
        this._ensureAlive();
        const e = this._layers.get(id);
        if (e === undefined) {
            return undefined;
        }
        return this._layerSpecFromRuntime(e);
    }

    /**
     * 将运行时条目转换为 LayerSpec 快照。
     *
     * @param e - 运行时
     * @returns LayerSpec
     */
    private _layerSpecFromRuntime(e: LayerRuntimeEntry): LayerSpec {
        const b = e.base;
        return {
            id: b.id,
            type: b.type,
            source: b.source,
            'source-layer': b['source-layer'],
            minzoom: b.minzoom,
            maxzoom: b.maxzoom,
            filter: e.filter ?? undefined,
            layout: { ...e.layout },
            paint: { ...e.paint },
            beforeId: b.beforeId,
        };
    }

    /**
     * 移动图层顺序。
     *
     * @param id - 图层 id
     * @param beforeId - 插入到该 id 之前；省略则置顶
     * @returns this
     */
    public moveLayer(id: string, beforeId?: string): this {
        this._ensureAlive();
        if (!this._layers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { id },
            );
        }
        const cur = this._layerOrder.indexOf(id);
        if (cur < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层顺序表损坏',
                { id },
            );
        }
        this._layerOrder.splice(cur, 1);
        if (beforeId !== undefined) {
            if (beforeId === id) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_ID,
                    'moveLayer 的 beforeId 不能与自身相同',
                    { id },
                );
            }
            if (!this._layers.has(beforeId)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_NOT_FOUND,
                    'beforeId 引用的图层不存在',
                    { beforeId },
                );
            }
            const idx = this._layerOrder.indexOf(beforeId);
            if (idx < 0) {
                this._layerOrder.push(id);
            } else {
                this._layerOrder.splice(idx, 0, id);
            }
        } else {
            this._layerOrder.push(id);
        }
        return this;
    }

    /**
     * 设置 layout 属性。
     *
     * @param layerId - 图层
     * @param name - 属性名
     * @param value - 属性值
     * @returns this
     */
    public setLayoutProperty(layerId: string, name: string, value: unknown): this {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        e.layout[name] = value;
        this.triggerRepaint();
        return this;
    }

    /**
     * 设置 paint 属性。
     *
     * @param layerId - 图层
     * @param name - 属性名
     * @param value - 属性值
     * @returns this
     */
    public setPaintProperty(layerId: string, name: string, value: unknown): this {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        e.paint[name] = value;
        this.triggerRepaint();
        return this;
    }

    /**
     * 设置过滤器。
     *
     * @param layerId - 图层
     * @param filter - 表达式数组
     * @returns this
     */
    public setFilter(layerId: string, filter: FilterExpression): this {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        e.filter = filter;
        return this;
    }

    /**
     * 获取过滤器副本。
     *
     * @param layerId - 图层
     * @returns 过滤器表达式；未设置时返回 `undefined`
     */
    public getFilter(layerId: string): FilterExpression | undefined {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        return e.filter === null ? undefined : e.filter;
    }

    /**
     * 设置图层可见性。
     *
     * @param layerId - 图层
     * @param visible - 是否可见
     * @returns this
     */
    public setLayerVisibility(layerId: string, visible: boolean): this {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        e.visible = visible;
        this.triggerRepaint();
        return this;
    }

    /**
     * 获取图层可见性。
     *
     * @param layerId - 图层
     * @returns visible
     */
    public getLayerVisibility(layerId: string): boolean {
        this._ensureAlive();
        const e = this._layers.get(layerId);
        if (e === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                '图层不存在',
                { layerId },
            );
        }
        return e.visible;
    }

    /**
     * 异步查询渲染要素（MVP 返回空数组）。
     *
     * @param _pointOrBox - 点或框（未使用）
     * @param _options - 过滤选项（未使用）
     * @returns Promise<Feature[]>
     */
    public async queryRenderedFeatures(
        _pointOrBox?: [number, number] | [[number, number], [number, number]],
        _options?: { layers?: string[]; filter?: FilterExpression },
    ): Promise<Feature[]> {
        this._ensureAlive();
        await Promise.resolve();
        return [];
    }

    /**
     * 同步查询源要素（MVP 返回空数组）。
     *
     * @param _sourceId - 数据源 id
     * @param _options - 过滤选项
     * @returns Feature[]
     */
    public querySourceFeatures(
        _sourceId: string,
        _options?: { sourceLayer?: string; filter?: FilterExpression },
    ): Feature[] {
        this._ensureAlive();
        return [];
    }

    /**
     * 设置要素状态。
     *
     * @param feature - source 与 id
     * @param state - 状态键值
     */
    public setFeatureState(
        feature: { source: string; id: string | number },
        state: Record<string, unknown>,
    ): void {
        this._ensureAlive();
        const key = featureStateKey(feature.source, feature.id);
        const prev = this._featureStates.get(key) ?? {};
        this._featureStates.set(key, { ...prev, ...state });
    }

    /**
     * 获取要素状态。
     *
     * @param feature - source 与 id
     * @returns 状态对象
     */
    public getFeatureState(feature: { source: string; id: string | number }): Record<string, unknown> {
        this._ensureAlive();
        const key = featureStateKey(feature.source, feature.id);
        const s = this._featureStates.get(key);
        return s !== undefined ? { ...s } : {};
    }

    /**
     * 移除要素状态或某键。
     *
     * @param feature - source 与 id
     * @param key - 可选状态键；省略则清除全部
     */
    public removeFeatureState(feature: { source: string; id: string | number }, key?: string): void {
        this._ensureAlive();
        const k = featureStateKey(feature.source, feature.id);
        if (key === undefined) {
            this._featureStates.delete(k);
            return;
        }
        const cur = this._featureStates.get(k);
        if (cur === undefined) {
            return;
        }
        const next = { ...cur };
        delete next[key];
        if (Object.keys(next).length === 0) {
            this._featureStates.delete(k);
        } else {
            this._featureStates.set(k, next);
        }
    }

    /**
     * 注册事件监听。
     *
     * @param type - 事件类型
     * @param a - 回调或图层 id
     * @param b - 当 a 为图层 id 时的回调
     * @returns this
     */
    public on(
        type: MapEventType,
        a: ((event: MapEvent | MapMouseEvent) => void) | string,
        b?: (event: MapMouseEvent) => void,
    ): this {
        this._ensureAlive();
        if (typeof a === 'function') {
            this._emitter.on(type, a as (ev: MapEvent | MapMouseEvent) => void);
            return this;
        }
        if (b === undefined) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                '图层事件必须提供回调',
                { type, layerId: a },
            );
        }
        const key = `${type}:${a}`;
        this._emitter.on(key, b as (ev: MapEvent | MapMouseEvent) => void);
        return this;
    }

    /**
     * 注册一次性监听。
     *
     * @param type - 事件类型
     * @param callback - 回调
     * @returns this
     */
    public once(type: MapEventType, callback: (event: MapEvent | MapMouseEvent) => void): this {
        this._ensureAlive();
        this._emitter.once(type, callback);
        return this;
    }

    /**
     * 移除监听。
     *
     * @param type - 事件类型
     * @param callback - 回调；省略则清除该类型全部监听
     * @returns this
     */
    public off(type: MapEventType, callback?: (event: MapEvent | MapMouseEvent) => void): this {
        this._ensureAlive();
        if (callback === undefined) {
            this._emitter.off(type);
            return this;
        }
        this._emitter.off(type, callback);
        return this;
    }

    /**
     * 添加控件到地图。
     *
     * @param control - 控件实例
     * @param position - 停靠角；省略则使用控件默认
     * @returns this
     */
    public addControl(control: IControl, position?: ControlPosition): this {
        this._ensureAlive();
        if (this._controls.has(control)) {
            return this;
        }
        const pos = position ?? control.getDefaultPosition();
        const el = control.onAdd(this);
        el.style.pointerEvents = 'auto';
        this._placeControlElement(el, pos);
        this._controls.set(control, { element: el, position: pos });
        return this;
    }

    /**
     * 将控件元素放入四角之一。
     *
     * @param el - 根元素
     * @param position - 角位置
     */
    private _placeControlElement(el: HTMLElement, position: ControlPosition): void {
        el.style.position = 'absolute';
        const margin = '8px';
        if (position === 'top-right') {
            el.style.top = margin;
            el.style.right = margin;
        } else if (position === 'top-left') {
            el.style.top = margin;
            el.style.left = margin;
        } else if (position === 'bottom-right') {
            el.style.bottom = margin;
            el.style.right = margin;
        } else {
            el.style.bottom = margin;
            el.style.left = margin;
        }
        this._controlRoot.appendChild(el);
    }

    /**
     * 移除控件。
     *
     * @param control - 控件实例
     * @returns this
     */
    public removeControl(control: IControl): this {
        this._ensureAlive();
        const rec = this._controls.get(control);
        if (rec === undefined) {
            return this;
        }
        control.onRemove(this);
        rec.element.remove();
        this._controls.delete(control);
        return this;
    }

    /**
     * 是否已注册该控件。
     *
     * @param control - 控件实例
     * @returns 是否包含
     */
    public hasControl(control: IControl): boolean {
        this._ensureAlive();
        return this._controls.has(control);
    }

    /**
     * 经纬度 → 屏幕像素（MVP 占位返回 [0,0]）。
     *
     * @param _lngLat - 经纬度
     * @returns 像素坐标
     */
    public project(_lngLat: [number, number]): [number, number] {
        this._ensureAlive();
        return [0, 0];
    }

    /**
     * 屏幕像素 → 经纬度（MVP 占位返回 [0,0]）。
     *
     * @param _point - 像素坐标
     * @returns 经纬度
     */
    public unproject(_point: [number, number]): [number, number] {
        this._ensureAlive();
        return [0, 0];
    }

    /**
     * 获取主 WebGL/WebGPU 画布（此处为 2D canvas 占位）。
     *
     * @returns canvas
     */
    public getCanvas(): HTMLCanvasElement {
        this._ensureAlive();
        return this._canvas;
    }

    /**
     * 获取容器元素。
     *
     * @returns container
     */
    public getContainer(): HTMLElement {
        this._ensureAlive();
        return this._container;
    }

    /**
     * 尺寸变化后同步 canvas 缓冲（读 client 尺寸）。
     *
     * @returns this
     */
    public resize(): this {
        this._ensureAlive();
        const maxPR = this._options.maxPixelRatio ?? 2;
        this._resizeCanvasInternal(maxPR);
        this._emitBase('resize', { type: 'resize', target: this });
        return this;
    }

    /**
     * 是否已完成首次加载。
     *
     * @returns loaded
     */
    public loaded(): boolean {
        this._ensureAlive();
        return this._loaded;
    }

    /**
     * 销毁地图实例与 DOM 引用。
     */
    public remove(): void {
        if (this._destroyed || this._removing) {
            return;
        }
        this._removing = true;
        try {
            this._cancelAnimations();
            this._emitBase('remove', { type: 'remove', target: this });
            for (const c of this._controls.keys()) {
                const rec = this._controls.get(c);
                if (rec !== undefined) {
                    try {
                        c.onRemove(this);
                    } catch (err) {
                        devError('[Map2D] control onRemove error', err);
                    }
                    rec.element.remove();
                }
            }
            this._controls.clear();
            this._emitter.removeAllListeners();
            this._canvas.remove();
            this._controlRoot.remove();
            this._destroyed = true;
        } finally {
            this._removing = false;
        }
    }

    /**
     * 请求重绘（MVP：派发 render 事件）。
     */
    public triggerRepaint(): void {
        if (this._destroyed) {
            return;
        }
        this._emitBase('render', { type: 'render', target: this });
    }

    /**
     * 轻量 CameraController 替身（MVP）。
     */
    public get camera(): {
        getCenter: () => [number, number];
        getZoom: () => number;
        getBearing: () => number;
        getPitch: () => number;
    } {
        this._ensureAlive();
        const self = this;
        return {
            getCenter(): [number, number] {
                return self.getCenter();
            },
            getZoom(): number {
                return self.getZoom();
            },
            getBearing(): number {
                return self._bearing;
            },
            getPitch(): number {
                return self._pitch;
            },
        };
    }

    /**
     * 渲染子系统逃生舱（MVP 空对象）。
     */
    public get renderer(): Record<string, never> {
        this._ensureAlive();
        return {};
    }

    /**
     * 场景子系统逃生舱（MVP 空对象）。
     */
    public get scene(): Record<string, never> {
        this._ensureAlive();
        return {};
    }

    /**
     * 调度子系统逃生舱（MVP 空对象）。
     */
    public get scheduler(): Record<string, never> {
        this._ensureAlive();
        return {};
    }

    /**
     * 扩展子系统逃生舱（MVP 空对象）。
     */
    public get extensions(): Record<string, never> {
        this._ensureAlive();
        return {};
    }

    /**
     * 确保实例仍可用；否则抛错。
     */
    private _ensureAlive(): void {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.MAP_DESTROYED,
                'Map2D 已销毁',
            );
        }
    }
}
