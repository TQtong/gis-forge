// ============================================================
// interaction-draw/src/DrawTool.ts — 矢量绘制交互工具
// 被引用于：L5/InteractionManager, L6/Map2D/Globe3D
//
// 提供五种绘制模式：点、线、多边形、矩形、圆形。
// 维护顶点列表与撤销/重做栈，支持吸附检测与自由绘制。
// 输出标准 GeoJSON Feature，不依赖任何引擎内部模块。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type {
    PointGeometry,
    LineStringGeometry,
    PolygonGeometry,
    Position,
} from '../../core/src/types/geometry.ts';

/** 编译期开关：开发模式调试代码，生产构建 tree-shake 移除 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 圆形近似时使用的线段数量（64 段即每段约 5.625°，视觉上近似光滑圆弧） */
const CIRCLE_SEGMENT_COUNT = 64;

/** 默认吸附距离（CSS 像素），鼠标在此范围内的已有顶点会被吸附 */
const DEFAULT_SNAP_DISTANCE_PX = 10;

/** 自由绘制模式下两点之间的最小像素距离，防止产生过密的顶点 */
const DEFAULT_FREEHAND_MIN_DISTANCE_PX = 5;

/** 生成唯一 Feature ID 的计数器起始值 */
let featureIdCounter = 0;

// ===================== 类型定义 =====================

/**
 * 绘制模式枚举。
 * - `'point'`：单击放置点要素
 * - `'line'`：多次单击添加折线顶点，双击完成
 * - `'polygon'`：多次单击添加多边形顶点，双击闭合完成
 * - `'rectangle'`：按下拖拽释放绘制矩形
 * - `'circle'`：第一次单击确定圆心，第二次单击确定半径
 */
export type DrawMode = 'point' | 'line' | 'polygon' | 'rectangle' | 'circle';

/**
 * 线条样式选项。
 * 控制绘制过程中线条的外观。
 */
export interface LineStyle {
    /** 线条颜色，CSS 颜色字符串，默认 `'#3388ff'` */
    color?: string;
    /** 线条宽度（CSS 像素），范围 [0.5, 20]，默认 `2` */
    width?: number;
    /** 虚线模式数组，如 `[5, 3]` 表示 5px 实线 + 3px 间隔，默认 `undefined`（实线） */
    dasharray?: number[];
}

/**
 * 填充样式选项。
 * 控制多边形/矩形/圆形绘制过程中填充的外观。
 */
export interface FillStyle {
    /** 填充颜色，CSS 颜色字符串，默认 `'#3388ff'` */
    color?: string;
    /** 填充透明度，范围 [0, 1]，0 完全透明，1 完全不透明，默认 `0.2` */
    opacity?: number;
}

/**
 * 绘制工具配置选项。
 * 通过构造函数传入，运行时可通过对应 setter 修改部分选项。
 */
export interface DrawToolOptions {
    /**
     * 初始绘制模式。
     * 默认 `'polygon'`。
     */
    mode?: DrawMode;

    /**
     * 绘制线条样式。
     * 用于折线轮廓和多边形边界的渲染。
     */
    lineStyle?: LineStyle;

    /**
     * 填充样式。
     * 仅对面状要素（polygon / rectangle / circle）有效。
     */
    fillStyle?: FillStyle;

    /**
     * 吸附距离（CSS 像素）。
     * 鼠标距离已有顶点小于此值时自动吸附。
     * 设为 `0` 禁用吸附。
     * 范围 [0, 100]，默认 `10`。
     */
    snapDistance?: number;

    /**
     * 是否启用自由绘制模式。
     * 启用后按住鼠标移动即自动添加顶点（类似手绘）。
     * 默认 `false`。
     */
    freehand?: boolean;

    /**
     * 自由绘制模式下两点最小像素间距。
     * 过小会产生过多顶点导致性能问题。
     * 范围 [1, 50]，默认 `5`。
     */
    freehandMinDistance?: number;

    /**
     * 是否在绘制过程中显示测量值（距离/面积）。
     * 默认 `true`。
     */
    showMeasurements?: boolean;
}

/**
 * 绘制工具事件名称。
 * - `'drawstart'`：开始绘制（第一个顶点放置时触发）
 * - `'drawend'`：绘制完成（调用 `finish()` 或双击完成时触发）
 * - `'drawcancel'`：绘制取消（调用 `cancel()` 或按 Escape 时触发）
 * - `'vertexadd'`：添加顶点
 * - `'vertexremove'`：移除顶点（撤销时触发）
 */
export type DrawEventType = 'drawstart' | 'drawend' | 'drawcancel' | 'vertexadd' | 'vertexremove';

/**
 * 绘制事件载荷。
 * 事件回调接收此对象，包含当前绘制状态信息。
 */
export interface DrawEvent {
    /** 事件类型 */
    readonly type: DrawEventType;
    /** 当前绘制模式 */
    readonly mode: DrawMode;
    /** 当前顶点坐标列表的浅拷贝 */
    readonly coordinates: Position[];
    /** 绘制完成时产生的 Feature（仅 `drawend` 事件有值） */
    readonly feature?: Feature;
}

/**
 * 撤销/重做操作项。
 * 记录一次顶点变更以便撤销/重做。
 */
interface UndoEntry {
    /** 操作类型：add 表示添加了一个顶点，remove 表示移除了一个顶点 */
    readonly action: 'add' | 'remove';
    /** 被操作的顶点坐标 */
    readonly coordinate: Position;
    /** 被操作的顶点在列表中的索引 */
    readonly index: number;
}

/**
 * 矩形模式下的拖拽起始状态。
 */
interface RectangleDragState {
    /** 拖拽起点经纬度 */
    readonly startCoord: Position;
    /** 拖拽起点屏幕坐标 [x, y]（CSS 像素） */
    readonly startScreen: [number, number];
}

/**
 * 圆形模式下的状态。
 */
interface CircleState {
    /** 圆心经纬度 */
    readonly center: Position;
}

/** 事件监听器类型 */
type DrawEventListener = (event: DrawEvent) => void;

// ===================== DrawTool 类 =====================

/**
 * 矢量绘制交互工具。
 *
 * 提供点、线、多边形、矩形、圆形五种绘制模式。
 * 维护顶点列表与撤销/重做栈，支持吸附检测。
 * 输出标准 GeoJSON Feature。
 *
 * **不是图层（Layer）**——DrawTool 是交互工具，通过
 * InteractionManager 注册到引擎，接收指针/键盘事件。
 *
 * @stability experimental
 *
 * @example
 * const draw = new DrawTool({ mode: 'polygon', snapDistance: 15 });
 * draw.on('drawend', (e) => console.log('完成:', e.feature));
 * draw.setMode('line');
 */
export class DrawTool {
    // ===================== 公共只读字段 =====================

    /** 工具唯一标识，用于 InteractionManager 注册 */
    readonly id = 'draw' as const;

    // ===================== 私有字段 =====================

    /** 当前绘制模式 */
    private _mode: DrawMode;

    /** 线条样式（合并默认值后的完整对象） */
    private _lineStyle: Required<LineStyle>;

    /** 填充样式（合并默认值后的完整对象） */
    private _fillStyle: Required<FillStyle>;

    /** 吸附距离（CSS 像素） */
    private _snapDistance: number;

    /** 是否启用自由绘制 */
    private _freehand: boolean;

    /** 自由绘制最小像素间距 */
    private _freehandMinDistance: number;

    /** 是否显示测量值 */
    private _showMeasurements: boolean;

    /** 当前绘制的顶点坐标列表 */
    private _coordinates: Position[] = [];

    /** 撤销栈（从旧到新） */
    private _undoStack: UndoEntry[] = [];

    /** 重做栈（从旧到新） */
    private _redoStack: UndoEntry[] = [];

    /** 是否正在进行绘制操作 */
    private _isDrawing = false;

    /** 矩形模式拖拽状态 */
    private _rectDragState: RectangleDragState | null = null;

    /** 圆形模式状态 */
    private _circleState: CircleState | null = null;

    /** 自由绘制模式下鼠标是否按下 */
    private _freehandActive = false;

    /** 自由绘制模式下上一次记录的屏幕坐标 */
    private _lastFreehandScreen: [number, number] | null = null;

    /** 当前鼠标位置（用于预览线段） */
    private _currentMouseCoord: Position | null = null;

    /** 事件监听器注册表：事件类型 → 回调集合 */
    private _listeners: Map<DrawEventType, Set<DrawEventListener>> = new Map();

    // ===================== 构造函数 =====================

    /**
     * 创建绘制工具实例。
     *
     * @param options - 配置选项，所有字段可选，有默认值
     *
     * @example
     * const draw = new DrawTool({ mode: 'line', freehand: true });
     */
    constructor(options: DrawToolOptions = {}) {
        // 解构配置项，应用默认值
        this._mode = options.mode ?? 'polygon';
        this._snapDistance = options.snapDistance ?? DEFAULT_SNAP_DISTANCE_PX;
        this._freehand = options.freehand ?? false;
        this._freehandMinDistance = options.freehandMinDistance ?? DEFAULT_FREEHAND_MIN_DISTANCE_PX;
        this._showMeasurements = options.showMeasurements ?? true;

        // 线条样式：合并用户值与默认值
        this._lineStyle = {
            color: options.lineStyle?.color ?? '#3388ff',
            width: options.lineStyle?.width ?? 2,
            dasharray: options.lineStyle?.dasharray ?? [],
        };

        // 填充样式：合并用户值与默认值
        this._fillStyle = {
            color: options.fillStyle?.color ?? '#3388ff',
            opacity: options.fillStyle?.opacity ?? 0.2,
        };

        if (__DEV__) {
            console.debug(`[DrawTool] 初始化完成，模式=${this._mode}, 吸附=${this._snapDistance}px`);
        }
    }

    // ===================== 公共属性访问器 =====================

    /**
     * 获取当前绘制模式。
     *
     * @returns 当前模式字符串
     *
     * @example
     * console.log(draw.mode); // 'polygon'
     */
    get mode(): DrawMode {
        return this._mode;
    }

    /**
     * 是否正在进行绘制操作。
     * 从第一个顶点放置到完成/取消之间为 `true`。
     *
     * @returns 绘制中状态
     *
     * @example
     * if (draw.isDrawing) draw.cancel();
     */
    get isDrawing(): boolean {
        return this._isDrawing;
    }

    /**
     * 当前撤销栈的深度。
     * 可用于 UI 上禁用/启用撤销按钮。
     *
     * @returns 可撤销的操作数
     *
     * @example
     * undoButton.disabled = draw.undoStackSize === 0;
     */
    get undoStackSize(): number {
        return this._undoStack.length;
    }

    /**
     * 是否显示测量值。
     *
     * @returns 是否显示
     */
    get showMeasurements(): boolean {
        return this._showMeasurements;
    }

    /**
     * 获取当前线条样式（只读副本）。
     *
     * @returns 线条样式对象
     */
    get lineStyle(): Readonly<Required<LineStyle>> {
        return this._lineStyle;
    }

    /**
     * 获取当前填充样式（只读副本）。
     *
     * @returns 填充样式对象
     */
    get fillStyle(): Readonly<Required<FillStyle>> {
        return this._fillStyle;
    }

    // ===================== 公共方法 =====================

    /**
     * 切换绘制模式。
     * 如果当前正在绘制中，会先自动取消当前绘制。
     *
     * @param mode - 新的绘制模式
     *
     * @example
     * draw.setMode('rectangle');
     */
    setMode(mode: DrawMode): void {
        // 模式没变则无需操作
        if (mode === this._mode) {
            return;
        }

        // 正在绘制中则先取消，避免状态残留
        if (this._isDrawing) {
            this.cancel();
        }

        this._mode = mode;

        if (__DEV__) {
            console.debug(`[DrawTool] 模式切换至 ${mode}`);
        }
    }

    /**
     * 撤销上一步顶点操作。
     * 如果撤销栈为空则静默返回（不抛异常）。
     *
     * @example
     * draw.undo(); // 移除最后添加的顶点
     */
    undo(): void {
        // 空栈时静默返回
        if (this._undoStack.length === 0) {
            return;
        }

        // 弹出最近一次操作
        const entry = this._undoStack.pop()!;

        // 反向执行操作
        if (entry.action === 'add') {
            // 撤销"添加"→从坐标列表移除该顶点
            this._coordinates.splice(entry.index, 1);
            // 发射顶点移除事件
            this._emit('vertexremove');
        } else {
            // 撤销"移除"→重新插入该顶点
            this._coordinates.splice(entry.index, 0, entry.coordinate);
            // 发射顶点添加事件
            this._emit('vertexadd');
        }

        // 将此操作压入重做栈
        this._redoStack.push(entry);

        // 如果所有顶点都撤销完了，重置绘制状态
        if (this._coordinates.length === 0) {
            this._isDrawing = false;
        }

        if (__DEV__) {
            console.debug(`[DrawTool] 撤销操作: ${entry.action} at index ${entry.index}, 剩余顶点=${this._coordinates.length}`);
        }
    }

    /**
     * 重做上一步被撤销的操作。
     * 如果重做栈为空则静默返回。
     *
     * @example
     * draw.redo(); // 恢复刚被撤销的顶点
     */
    redo(): void {
        // 空栈时静默返回
        if (this._redoStack.length === 0) {
            return;
        }

        // 弹出最近一次被撤销的操作
        const entry = this._redoStack.pop()!;

        // 重新执行原操作
        if (entry.action === 'add') {
            // 重做"添加"→重新插入顶点
            this._coordinates.splice(entry.index, 0, entry.coordinate);
            this._emit('vertexadd');
        } else {
            // 重做"移除"→移除顶点
            this._coordinates.splice(entry.index, 1);
            this._emit('vertexremove');
        }

        // 压入撤销栈
        this._undoStack.push(entry);

        // 如果重新有了顶点，恢复绘制状态
        if (this._coordinates.length > 0 && !this._isDrawing) {
            this._isDrawing = true;
        }

        if (__DEV__) {
            console.debug(`[DrawTool] 重做操作: ${entry.action} at index ${entry.index}, 当前顶点=${this._coordinates.length}`);
        }
    }

    /**
     * 完成当前绘制，生成 GeoJSON Feature。
     *
     * 根据当前绘制模式和已收集的顶点生成对应的 Feature：
     * - point → Feature<Point>
     * - line → Feature<LineString>（至少 2 个顶点）
     * - polygon → Feature<Polygon>（至少 3 个顶点，自动闭合）
     * - rectangle → Feature<Polygon>（需完整拖拽）
     * - circle → Feature<Polygon>（需圆心和边缘点）
     *
     * 顶点不足时返回 `null`。
     *
     * @returns 生成的 GeoJSON Feature，或 `null`（顶点不足）
     *
     * @example
     * const feature = draw.finish();
     * if (feature) {
     *   map.addSource('draw', { type: 'geojson', data: feature });
     * }
     */
    finish(): Feature | null {
        // 未在绘制中或无坐标则返回 null
        if (!this._isDrawing || this._coordinates.length === 0) {
            if (__DEV__) {
                console.warn('[DrawTool] finish() 调用时未在绘制中或无顶点');
            }
            return null;
        }

        let feature: Feature | null = null;

        // 根据模式生成不同几何类型的 Feature
        switch (this._mode) {
            case 'point': {
                // 点模式：取第一个（也是唯一一个）顶点
                feature = this._createPointFeature(this._coordinates[0]);
                break;
            }
            case 'line': {
                // 线模式：至少需要 2 个顶点才能构成线段
                if (this._coordinates.length < 2) {
                    if (__DEV__) {
                        console.warn('[DrawTool] 线模式至少需要 2 个顶点，当前仅有', this._coordinates.length);
                    }
                    return null;
                }
                feature = this._createLineFeature(this._coordinates);
                break;
            }
            case 'polygon': {
                // 多边形模式：至少需要 3 个顶点才能构成面
                if (this._coordinates.length < 3) {
                    if (__DEV__) {
                        console.warn('[DrawTool] 多边形模式至少需要 3 个顶点，当前仅有', this._coordinates.length);
                    }
                    return null;
                }
                feature = this._createPolygonFeature(this._coordinates);
                break;
            }
            case 'rectangle': {
                // 矩形模式：需要恰好 2 个对角顶点（由拖拽产生）
                if (this._coordinates.length < 2) {
                    if (__DEV__) {
                        console.warn('[DrawTool] 矩形模式需要 2 个对角顶点');
                    }
                    return null;
                }
                feature = this._createRectangleFeature(
                    this._coordinates[0],
                    this._coordinates[1],
                );
                break;
            }
            case 'circle': {
                // 圆形模式：需要圆心和边缘点（共 2 个坐标）
                if (this._coordinates.length < 2 || this._circleState === null) {
                    if (__DEV__) {
                        console.warn('[DrawTool] 圆形模式需要圆心和边缘点');
                    }
                    return null;
                }
                feature = this._createCircleFeature(
                    this._circleState.center,
                    this._coordinates[1],
                );
                break;
            }
        }

        if (feature !== null) {
            // 发射绘制完成事件
            this._emitWithFeature('drawend', feature);
        }

        // 重置内部状态
        this._resetState();

        return feature;
    }

    /**
     * 取消当前绘制，清除所有顶点和状态。
     *
     * @example
     * draw.cancel(); // 放弃当前正在绘制的图形
     */
    cancel(): void {
        // 即使未在绘制中也安全调用（幂等）
        const wasDrawing = this._isDrawing;

        // 重置所有状态
        this._resetState();

        // 仅在确实取消了正在进行的绘制时才发射事件
        if (wasDrawing) {
            this._emit('drawcancel');
        }

        if (__DEV__) {
            console.debug(`[DrawTool] 绘制取消 (wasDrawing=${wasDrawing})`);
        }
    }

    /**
     * 获取当前绘制中的坐标列表的防御性浅拷贝。
     * 外部修改返回数组不会影响内部状态。
     *
     * @returns 顶点坐标数组的拷贝
     *
     * @example
     * const coords = draw.getDrawingCoordinates();
     * console.log(`已有 ${coords.length} 个顶点`);
     */
    getDrawingCoordinates(): Position[] {
        // 返回浅拷贝，防止外部修改内部数组
        return this._coordinates.slice();
    }

    /**
     * 获取当前鼠标位置坐标（用于绘制预览线段）。
     *
     * @returns 当前鼠标位置的经纬度坐标，未移动过则为 `null`
     */
    getCurrentMouseCoord(): Position | null {
        return this._currentMouseCoord;
    }

    // ===================== 事件系统 =====================

    /**
     * 注册事件监听器。
     *
     * @param type - 事件类型
     * @param listener - 回调函数
     * @returns 当前实例（支持链式调用）
     *
     * @example
     * draw.on('drawend', (e) => {
     *   console.log('绘制完成', e.feature);
     * });
     */
    on(type: DrawEventType, listener: DrawEventListener): this {
        // 获取或创建该事件类型的监听器集合
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
     * @param listener - 要移除的回调函数
     * @returns 当前实例
     *
     * @example
     * draw.off('drawend', myHandler);
     */
    off(type: DrawEventType, listener: DrawEventListener): this {
        const set = this._listeners.get(type);
        if (set !== undefined) {
            set.delete(listener);
            // 集合为空时清理映射，避免内存泄漏
            if (set.size === 0) {
                this._listeners.delete(type);
            }
        }
        return this;
    }

    // ===================== 输入事件处理器 =====================

    /**
     * 处理指针按下事件。
     * 由 InteractionManager 分发到此方法。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * draw.handlePointerDown(500, 300, [116.39, 39.91]);
     */
    handlePointerDown(screenX: number, screenY: number, lngLat: Position): void {
        // 参数有效性检查
        if (!isFinite(screenX) || !isFinite(screenY)) {
            if (__DEV__) {
                console.warn('[DrawTool] handlePointerDown: 无效的屏幕坐标', screenX, screenY);
            }
            return;
        }
        if (!this._isValidPosition(lngLat)) {
            if (__DEV__) {
                console.warn('[DrawTool] handlePointerDown: 无效的经纬度', lngLat);
            }
            return;
        }

        switch (this._mode) {
            case 'point': {
                // 点模式：单击立即完成一个点要素
                this._startDrawingIfNeeded();
                this._addVertex(lngLat);
                // 自动完成绘制
                this.finish();
                break;
            }
            case 'line':
            case 'polygon': {
                if (this._freehand) {
                    // 自由绘制模式：按下开始记录轨迹
                    this._freehandActive = true;
                    this._lastFreehandScreen = [screenX, screenY];
                    this._startDrawingIfNeeded();
                    // 添加起始点
                    const snapped = this._trySnap(screenX, screenY, lngLat);
                    this._addVertex(snapped);
                } else {
                    // 标准模式：单击添加顶点
                    this._startDrawingIfNeeded();
                    const snapped = this._trySnap(screenX, screenY, lngLat);
                    this._addVertex(snapped);
                }
                break;
            }
            case 'rectangle': {
                // 矩形模式：按下记录起始点，开始拖拽
                this._startDrawingIfNeeded();
                this._rectDragState = {
                    startCoord: lngLat,
                    startScreen: [screenX, screenY],
                };
                // 将起始点作为第一个坐标
                this._coordinates = [lngLat];
                break;
            }
            case 'circle': {
                if (this._circleState === null) {
                    // 第一次点击：设置圆心
                    this._startDrawingIfNeeded();
                    this._circleState = { center: lngLat };
                    this._addVertex(lngLat);
                } else {
                    // 第二次点击：设置边缘点，计算半径并完成
                    this._addVertex(lngLat);
                    this.finish();
                }
                break;
            }
        }
    }

    /**
     * 处理指针移动事件。
     * 用于预览绘制效果（橡皮筋线段）、矩形拖拽、自由绘制。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * draw.handlePointerMove(510, 310, [116.40, 39.92]);
     */
    handlePointerMove(screenX: number, screenY: number, lngLat: Position): void {
        // 参数有效性检查
        if (!isFinite(screenX) || !isFinite(screenY) || !this._isValidPosition(lngLat)) {
            return;
        }

        // 更新当前鼠标经纬度（用于渲染预览）
        this._currentMouseCoord = lngLat;

        switch (this._mode) {
            case 'line':
            case 'polygon': {
                if (this._freehand && this._freehandActive && this._lastFreehandScreen !== null) {
                    // 自由绘制模式：检查像素距离是否达到最小间距
                    const dx = screenX - this._lastFreehandScreen[0];
                    const dy = screenY - this._lastFreehandScreen[1];
                    const distSq = dx * dx + dy * dy;
                    const minDistSq = this._freehandMinDistance * this._freehandMinDistance;

                    if (distSq >= minDistSq) {
                        // 超过最小间距才添加顶点，防止过密
                        this._addVertex(lngLat);
                        this._lastFreehandScreen = [screenX, screenY];
                    }
                }
                break;
            }
            case 'rectangle': {
                if (this._rectDragState !== null) {
                    // 拖拽中：用当前位置更新第二个对角点（预览矩形）
                    if (this._coordinates.length >= 2) {
                        this._coordinates[1] = lngLat;
                    } else {
                        this._coordinates.push(lngLat);
                    }
                }
                break;
            }
            case 'circle': {
                if (this._circleState !== null && this._coordinates.length === 1) {
                    // 圆心已设置，移动预览半径
                    this._currentMouseCoord = lngLat;
                }
                break;
            }
            default:
                // point 模式无需处理移动
                break;
        }
    }

    /**
     * 处理指针抬起事件。
     * 主要用于矩形模式的拖拽结束和自由绘制模式的完成。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * draw.handlePointerUp(600, 400, [116.50, 40.00]);
     */
    handlePointerUp(screenX: number, screenY: number, lngLat: Position): void {
        // 参数有效性检查
        if (!isFinite(screenX) || !isFinite(screenY) || !this._isValidPosition(lngLat)) {
            return;
        }

        switch (this._mode) {
            case 'rectangle': {
                if (this._rectDragState !== null) {
                    // 更新最终对角点
                    if (this._coordinates.length >= 2) {
                        this._coordinates[1] = lngLat;
                    } else {
                        this._coordinates.push(lngLat);
                    }

                    // 检查拖拽距离是否足够大（避免误触）
                    const dx = screenX - this._rectDragState.startScreen[0];
                    const dy = screenY - this._rectDragState.startScreen[1];
                    const dragDistSq = dx * dx + dy * dy;
                    // 最小 4 像素的拖拽距离才视为有效矩形
                    const MIN_DRAG_DIST_SQ = 16;

                    if (dragDistSq >= MIN_DRAG_DIST_SQ) {
                        // 拖拽有效，完成矩形绘制
                        this.finish();
                    } else {
                        // 拖拽太短，视为误触，取消
                        this.cancel();
                    }
                }
                break;
            }
            case 'line':
            case 'polygon': {
                if (this._freehand && this._freehandActive) {
                    // 自由绘制结束
                    this._freehandActive = false;
                    this._lastFreehandScreen = null;
                    // 自动完成绘制
                    this.finish();
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * 处理双击事件。
     * 线模式和多边形模式下双击完成绘制。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * draw.handleDoubleClick(500, 300, [116.39, 39.91]);
     */
    handleDoubleClick(screenX: number, screenY: number, lngLat: Position): void {
        // 双击在 line / polygon 模式下完成绘制
        if (this._mode === 'line' || this._mode === 'polygon') {
            if (this._isDrawing) {
                // 双击事件通常也触发了一次 pointerDown，已多添加了一个点
                // 移除最后一个重复的点（双击的第二次点击产生的）
                if (this._coordinates.length > 1) {
                    this._coordinates.pop();
                    if (this._undoStack.length > 0) {
                        this._undoStack.pop();
                    }
                }
                this.finish();
            }
        }
    }

    /**
     * 处理键盘按下事件。
     * 支持快捷键：
     * - `Escape`：取消绘制
     * - `Ctrl+Z` / `Meta+Z`：撤销
     * - `Ctrl+Shift+Z` / `Ctrl+Y`：重做
     * - `Enter`：完成绘制
     *
     * @param event - 键盘事件对象
     *
     * @example
     * draw.handleKeyDown(keyboardEvent);
     */
    handleKeyDown(event: KeyboardEvent): void {
        switch (event.key) {
            case 'Escape': {
                // Escape 取消当前绘制
                if (this._isDrawing) {
                    this.cancel();
                }
                break;
            }
            case 'z':
            case 'Z': {
                // Ctrl+Shift+Z 或 Ctrl+Z
                if (event.ctrlKey || event.metaKey) {
                    if (event.shiftKey) {
                        // Ctrl+Shift+Z = 重做
                        this.redo();
                    } else {
                        // Ctrl+Z = 撤销
                        this.undo();
                    }
                    // 阻止浏览器默认的撤销行为
                    event.preventDefault();
                }
                break;
            }
            case 'y':
            case 'Y': {
                // Ctrl+Y = 重做（Windows 习惯）
                if (event.ctrlKey || event.metaKey) {
                    this.redo();
                    event.preventDefault();
                }
                break;
            }
            case 'Enter': {
                // Enter 完成绘制
                if (this._isDrawing) {
                    this.finish();
                }
                break;
            }
        }
    }

    // ===================== 私有方法 =====================

    /**
     * 如果当前未在绘制状态，则标记为绘制中并发射 drawstart 事件。
     * 幂等方法——多次调用不会重复发射事件。
     */
    private _startDrawingIfNeeded(): void {
        if (!this._isDrawing) {
            this._isDrawing = true;
            this._emit('drawstart');
        }
    }

    /**
     * 添加一个顶点到坐标列表并记录到撤销栈。
     * 同时清空重做栈（新操作后重做历史失效）。
     *
     * @param coord - 要添加的顶点经纬度坐标
     */
    private _addVertex(coord: Position): void {
        const index = this._coordinates.length;
        this._coordinates.push(coord);

        // 记录到撤销栈
        this._undoStack.push({
            action: 'add',
            coordinate: coord,
            index,
        });

        // 新操作使重做栈失效
        this._redoStack.length = 0;

        // 发射顶点添加事件
        this._emit('vertexadd');
    }

    /**
     * 尝试吸附到已有顶点。
     * 检查屏幕坐标是否在任意已有顶点的吸附距离内。
     *
     * 当前实现为简单版本：将顶点屏幕距离与阈值对比。
     * 由于此工具不直接持有相机/投影引用，吸附基于坐标差异的
     * 粗略估算。完整实现需要 InteractionManager 提供 project/unproject。
     *
     * @param screenX - 当前鼠标屏幕 X
     * @param screenY - 当前鼠标屏幕 Y
     * @param lngLat - 当前鼠标经纬度
     * @returns 吸附后的坐标（如果触发吸附则返回已有顶点坐标，否则返回原坐标）
     */
    private _trySnap(screenX: number, screenY: number, lngLat: Position): Position {
        // 吸附距离为 0 表示禁用
        if (this._snapDistance <= 0 || this._coordinates.length === 0) {
            return lngLat;
        }

        // 遍历所有已有顶点，找到最近的一个
        let closestIdx = -1;
        let closestDistSq = Infinity;
        // 简化吸附：使用经纬度坐标差异来粗略估算屏幕像素距离
        // 一个完整的实现需要 project() 函数将每个已有顶点投影到屏幕空间
        // 这里假设在中等缩放级别下，每度约对应一定数量的像素
        // 此方法在高纬度或低缩放级别下精度较低，但可接受
        for (let i = 0; i < this._coordinates.length; i++) {
            const existing = this._coordinates[i];
            // 直接用经纬度差作为近似像素距离的度量单位
            // 完整实现中应该传入已有顶点的屏幕坐标用于精确比较
            const dLng = lngLat[0] - existing[0];
            const dLat = lngLat[1] - existing[1];
            const distSq = dLng * dLng + dLat * dLat;
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestIdx = i;
            }
        }

        // 将吸附距离换算为粗略的度（在赤道附近，1度 ≈ 111km ≈ 很多像素）
        // 真实实现中需要 project/unproject，这里用一个合理的启发阈值：
        // snapDistance 像素 / 假定每度约 100000 像素 = snapDegrees
        // 此处使用一个保守的估计值（对应约 zoom 14 级别的精度）
        const APPROX_PIXELS_PER_DEGREE = 100000;
        const snapDegrees = this._snapDistance / APPROX_PIXELS_PER_DEGREE;
        const snapDegreeSq = snapDegrees * snapDegrees;

        if (closestIdx >= 0 && closestDistSq <= snapDegreeSq) {
            // 触发吸附：返回已有顶点的坐标
            if (__DEV__) {
                console.debug(`[DrawTool] 吸附到顶点 #${closestIdx}`);
            }
            return this._coordinates[closestIdx];
        }

        return lngLat;
    }

    /**
     * 验证 Position 坐标是否有效（非 NaN、非 Infinity、经纬度范围内）。
     *
     * @param pos - 要验证的坐标
     * @returns 坐标有效则返回 `true`
     */
    private _isValidPosition(pos: Position): boolean {
        // 至少要有经度和纬度两个分量
        if (pos.length < 2) {
            return false;
        }
        const lng = pos[0];
        const lat = pos[1];
        // 检查 NaN 和 Infinity
        if (!isFinite(lng) || !isFinite(lat)) {
            return false;
        }
        // 检查经纬度基本范围（允许少量溢出以处理反子午线附近数据）
        if (lng < -360 || lng > 360 || lat < -90 || lat > 90) {
            return false;
        }
        return true;
    }

    /**
     * 重置所有内部绘制状态到初始值。
     */
    private _resetState(): void {
        this._coordinates = [];
        this._undoStack = [];
        this._redoStack = [];
        this._isDrawing = false;
        this._rectDragState = null;
        this._circleState = null;
        this._freehandActive = false;
        this._lastFreehandScreen = null;
        this._currentMouseCoord = null;
    }

    // ===================== Feature 工厂方法 =====================

    /**
     * 创建点 Feature。
     *
     * @param coord - 点坐标 [lng, lat]
     * @returns Feature<PointGeometry>
     */
    private _createPointFeature(coord: Position): Feature<PointGeometry> {
        featureIdCounter++;
        return {
            type: 'Feature',
            id: `draw-point-${featureIdCounter}`,
            geometry: {
                type: 'Point',
                coordinates: coord,
            },
            properties: {
                _drawTool: true,
                _drawMode: 'point' as const,
            },
        };
    }

    /**
     * 创建线串 Feature。
     *
     * @param coords - 折线顶点坐标数组（至少 2 个）
     * @returns Feature<LineStringGeometry>
     */
    private _createLineFeature(coords: Position[]): Feature<LineStringGeometry> {
        featureIdCounter++;
        return {
            type: 'Feature',
            id: `draw-line-${featureIdCounter}`,
            geometry: {
                type: 'LineString',
                coordinates: coords.slice(),
            },
            properties: {
                _drawTool: true,
                _drawMode: 'line' as const,
                _vertexCount: coords.length,
            },
        };
    }

    /**
     * 创建多边形 Feature。
     * 自动闭合：确保首尾坐标相同（GeoJSON Polygon 规范要求）。
     *
     * @param coords - 多边形顶点坐标数组（至少 3 个，不含闭合点）
     * @returns Feature<PolygonGeometry>
     */
    private _createPolygonFeature(coords: Position[]): Feature<PolygonGeometry> {
        featureIdCounter++;

        // 构建闭合环：复制输入 + 首点追加到尾部
        const ring = coords.slice();
        const first = ring[0];
        const last = ring[ring.length - 1];

        // 如果首尾不同则追加首点以闭合
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push(first);
        }

        return {
            type: 'Feature',
            id: `draw-polygon-${featureIdCounter}`,
            geometry: {
                type: 'Polygon',
                // GeoJSON Polygon 的 coordinates 是环数组，这里只有一个外环
                coordinates: [ring],
            },
            properties: {
                _drawTool: true,
                _drawMode: 'polygon' as const,
                _vertexCount: coords.length,
            },
        };
    }

    /**
     * 创建矩形 Feature（实际上是 Polygon）。
     * 由两个对角顶点确定。
     *
     * @param corner1 - 第一个对角顶点（拖拽起点）
     * @param corner2 - 第二个对角顶点（拖拽终点）
     * @returns Feature<PolygonGeometry>
     */
    private _createRectangleFeature(corner1: Position, corner2: Position): Feature<PolygonGeometry> {
        featureIdCounter++;

        // 从两个对角点生成矩形的四个顶点（逆时针方向）+ 闭合点
        const west = Math.min(corner1[0], corner2[0]);
        const east = Math.max(corner1[0], corner2[0]);
        const south = Math.min(corner1[1], corner2[1]);
        const north = Math.max(corner1[1], corner2[1]);

        // 逆时针方向排列（GeoJSON 外环规范）
        const ring: Position[] = [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south], // 闭合
        ];

        return {
            type: 'Feature',
            id: `draw-rectangle-${featureIdCounter}`,
            geometry: {
                type: 'Polygon',
                coordinates: [ring],
            },
            properties: {
                _drawTool: true,
                _drawMode: 'rectangle' as const,
                _west: west,
                _east: east,
                _south: south,
                _north: north,
            },
        };
    }

    /**
     * 创建圆形 Feature（64 段多边形近似）。
     *
     * 由圆心和边缘点确定半径，用 Haversine 公式计算大圆距离作为半径，
     * 然后按固定角度间隔在圆心周围生成顶点。
     *
     * @param center - 圆心经纬度
     * @param edgePoint - 圆边缘上的一个经纬度点
     * @returns Feature<PolygonGeometry>
     */
    private _createCircleFeature(center: Position, edgePoint: Position): Feature<PolygonGeometry> {
        featureIdCounter++;

        // 用 Haversine 公式计算圆心到边缘点的大圆距离（米）
        const radiusMeters = haversineDistance(center, edgePoint);

        // 如果半径为 0 或无效，退化为一个点状极小多边形
        const safeRadius = (isFinite(radiusMeters) && radiusMeters > 0) ? radiusMeters : 1;

        // 在圆心周围生成 CIRCLE_SEGMENT_COUNT 个顶点
        const ring: Position[] = [];

        for (let i = 0; i < CIRCLE_SEGMENT_COUNT; i++) {
            // 当前角度（弧度），从正北(0°)开始顺时针
            const angle = (2 * Math.PI * i) / CIRCLE_SEGMENT_COUNT;
            // 用目的地公式计算经纬度偏移
            const vertex = destinationPoint(center, safeRadius, angle);
            ring.push(vertex);
        }

        // 闭合环：首尾相同
        ring.push(ring[0]);

        return {
            type: 'Feature',
            id: `draw-circle-${featureIdCounter}`,
            geometry: {
                type: 'Polygon',
                coordinates: [ring],
            },
            properties: {
                _drawTool: true,
                _drawMode: 'circle' as const,
                _centerLng: center[0],
                _centerLat: center[1],
                _radiusMeters: safeRadius,
            },
        };
    }

    // ===================== 事件发射 =====================

    /**
     * 发射不含 Feature 的事件。
     *
     * @param type - 事件类型
     */
    private _emit(type: DrawEventType): void {
        const event: DrawEvent = {
            type,
            mode: this._mode,
            coordinates: this._coordinates.slice(),
        };
        this._dispatchEvent(event);
    }

    /**
     * 发射包含 Feature 的事件（drawend 专用）。
     *
     * @param type - 事件类型
     * @param feature - 生成的 Feature
     */
    private _emitWithFeature(type: DrawEventType, feature: Feature): void {
        const event: DrawEvent = {
            type,
            mode: this._mode,
            coordinates: this._coordinates.slice(),
            feature,
        };
        this._dispatchEvent(event);
    }

    /**
     * 将事件分发给所有已注册的监听器。
     * 每个监听器在 try-catch 中执行，单个监听器抛异常不影响其他。
     *
     * @param event - 要分发的事件对象
     */
    private _dispatchEvent(event: DrawEvent): void {
        const set = this._listeners.get(event.type);
        if (set === undefined || set.size === 0) {
            return;
        }
        // 遍历所有监听器并安全执行
        for (const listener of set) {
            try {
                listener(event);
            } catch (err) {
                // 监听器错误不应中断工具运行
                if (__DEV__) {
                    console.error(`[DrawTool] 事件监听器 '${event.type}' 执行出错:`, err);
                }
            }
        }
    }
}

// ===================== 独立工具函数 =====================

/** 地球平均半径（米），用于 Haversine 和 destination 公式 */
const EARTH_RADIUS_M = 6371008.8;

/** 角度转弧度常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度转角度常量 */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * 计算两点之间的 Haversine（大圆）距离。
 *
 * @param a - 起点 [lng, lat]（度）
 * @param b - 终点 [lng, lat]（度）
 * @returns 两点间的大圆距离（米）
 *
 * @example
 * const d = haversineDistance([116.39, 39.91], [121.47, 31.23]);
 * console.log(d); // ≈ 1068 km
 */
function haversineDistance(a: Position, b: Position): number {
    // 将经纬度从度转为弧度
    const lat1 = a[1] * DEG_TO_RAD;
    const lat2 = b[1] * DEG_TO_RAD;
    const dLat = (b[1] - a[1]) * DEG_TO_RAD;
    const dLng = (b[0] - a[0]) * DEG_TO_RAD;

    // Haversine 公式核心：sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
    const sinHalfDLat = Math.sin(dLat / 2);
    const sinHalfDLng = Math.sin(dLng / 2);
    const h = sinHalfDLat * sinHalfDLat
        + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

    // 使用 atan2 而非 asin 以获得更好的数值稳定性
    // clamp h 到 [0, 1] 防止浮点误差导致 sqrt 输入超范围
    const clamped = Math.min(1, Math.max(0, h));
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}

/**
 * 给定起点、距离和方位角，计算目的地点坐标。
 * 使用球面三角学的 destination 公式。
 *
 * @param from - 起点 [lng, lat]（度）
 * @param distanceM - 距离（米）
 * @param bearingRad - 方位角（弧度），0 = 正北，顺时针为正
 * @returns 目的地坐标 [lng, lat]（度）
 *
 * @example
 * const dest = destinationPoint([116.39, 39.91], 1000, 0);
 * // 从北京向正北走 1km 的坐标
 */
function destinationPoint(from: Position, distanceM: number, bearingRad: number): Position {
    // 角距离 = 线距离 / 地球半径
    const angularDist = distanceM / EARTH_RADIUS_M;

    // 起点纬度和经度（弧度）
    const lat1 = from[1] * DEG_TO_RAD;
    const lng1 = from[0] * DEG_TO_RAD;

    // 预计算三角函数值
    const sinAngDist = Math.sin(angularDist);
    const cosAngDist = Math.cos(angularDist);
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);

    // 目的地纬度
    const sinLat2 = sinLat1 * cosAngDist + cosLat1 * sinAngDist * Math.cos(bearingRad);
    // clamp 防止 asin 参数越界
    const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));

    // 目的地经度
    const y = Math.sin(bearingRad) * sinAngDist * cosLat1;
    const x = cosAngDist - sinLat1 * sinLat2;
    const lng2 = lng1 + Math.atan2(y, x);

    return [lng2 * RAD_TO_DEG, lat2 * RAD_TO_DEG];
}
