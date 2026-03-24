// ============================================================
// interaction-select/src/SelectTool.ts — 要素选择交互工具
// 被引用于：L5/InteractionManager, L6/Map2D/Globe3D
//
// 提供三种选择模式：单击选择、框选、套索选择。
// 维护选中要素集合（Set<string|number>），支持多选与切换。
// 内置点在多边形内检测算法（射线法），不依赖引擎内部模块。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Position } from '../../core/src/types/geometry.ts';

/** 编译期开关：开发模式调试代码，生产构建 tree-shake 移除 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/** 框选拖拽的最小像素距离平方（4px²），小于此值视为单击而非拖拽 */
const MIN_BOX_DRAG_DIST_SQ = 16;

/** 套索模式下两点最小像素距离平方（9px²），防止过密的套索路径 */
const MIN_LASSO_SEGMENT_DIST_SQ = 9;

// ===================== 类型定义 =====================

/**
 * 选择模式枚举。
 * - `'click'`：单击选择/切换单个要素
 * - `'box'`：框选模式，拖拽矩形范围选择
 * - `'lasso'`：套索模式，自由绘制闭合多边形范围选择
 */
export type SelectMode = 'click' | 'box' | 'lasso';

/**
 * 高亮样式选项。
 * 控制选中要素的视觉高亮效果。
 */
export interface HighlightStyle {
    /** 高亮填充颜色，CSS 颜色字符串，默认 `'#ffcc00'` */
    color?: string;
    /** 高亮填充透明度，范围 [0, 1]，默认 `0.4` */
    opacity?: number;
    /** 高亮轮廓颜色，默认 `'#ff6600'` */
    outlineColor?: string;
    /** 高亮轮廓宽度（CSS 像素），默认 `2` */
    outlineWidth?: number;
}

/**
 * 选择工具配置选项。
 */
export interface SelectToolOptions {
    /**
     * 初始选择模式。
     * 默认 `'click'`。
     */
    mode?: SelectMode;

    /**
     * 限定可选择的图层 ID 列表。
     * 为 `undefined` 或空数组时表示所有图层均可选择。
     */
    layers?: string[];

    /**
     * 是否允许多选。
     * 启用后 click 模式下单击不会清除已有选中，而是切换。
     * box/lasso 模式下按住 Shift 追加选择。
     * 默认 `true`。
     */
    multiSelect?: boolean;

    /**
     * 选中要素的高亮样式。
     */
    highlightStyle?: HighlightStyle;
}

/**
 * 选择工具事件名称。
 * - `'selectionchange'`：选中集合发生变化时触发
 */
export type SelectEventType = 'selectionchange';

/**
 * 选择变化事件载荷。
 */
export interface SelectEvent {
    /** 事件类型，始终为 `'selectionchange'` */
    readonly type: 'selectionchange';

    /** 当前选中的所有要素 ID 列表 */
    readonly selectedIds: ReadonlyArray<string | number>;

    /** 本次新增选中的要素 ID 列表 */
    readonly added: ReadonlyArray<string | number>;

    /** 本次取消选中的要素 ID 列表 */
    readonly removed: ReadonlyArray<string | number>;

    /** 当前选择模式 */
    readonly mode: SelectMode;
}

/**
 * 框选拖拽状态。
 */
interface BoxDragState {
    /** 拖拽起点屏幕坐标 [x, y] */
    readonly startScreen: [number, number];
    /** 拖拽起点经纬度 */
    readonly startCoord: Position;
    /** 是否已开始有效拖拽（超过最小距离阈值） */
    dragging: boolean;
}

/**
 * 套索绘制状态。
 */
interface LassoState {
    /** 套索路径的屏幕坐标序列 */
    readonly screenPath: Array<[number, number]>;
    /** 套索路径的经纬度坐标序列 */
    readonly coordPath: Position[];
    /** 鼠标是否按下 */
    active: boolean;
}

/** 事件监听器类型 */
type SelectEventListener = (event: SelectEvent) => void;

// ===================== SelectTool 类 =====================

/**
 * 要素选择交互工具。
 *
 * 提供单击选择、框选和套索选择三种模式。
 * 维护一个 `Set<string|number>` 存储选中要素的 ID。
 * 支持多选切换、批量添加/移除、事件通知。
 *
 * **不是图层（Layer）**——SelectTool 是交互工具，通过
 * InteractionManager 注册到引擎，接收指针事件。
 *
 * @stability experimental
 *
 * @example
 * const select = new SelectTool({ mode: 'box', multiSelect: true });
 * select.on('selectionchange', (e) => {
 *   console.log('选中数量:', e.selectedIds.length);
 * });
 */
export class SelectTool {
    // ===================== 公共只读字段 =====================

    /** 工具唯一标识，用于 InteractionManager 注册 */
    readonly id = 'select' as const;

    // ===================== 私有字段 =====================

    /** 当前选择模式 */
    private _mode: SelectMode;

    /** 可选图层过滤列表（空表示不限制） */
    private _layers: string[];

    /** 是否允许多选 */
    private _multiSelect: boolean;

    /** 高亮样式（合并默认值后的完整对象） */
    private _highlightStyle: Required<HighlightStyle>;

    /** 当前选中的要素 ID 集合 */
    private _selectedIds: Set<string | number> = new Set();

    /** 框选拖拽状态 */
    private _boxDragState: BoxDragState | null = null;

    /** 套索绘制状态 */
    private _lassoState: LassoState | null = null;

    /** 事件监听器注册表 */
    private _listeners: Map<SelectEventType, Set<SelectEventListener>> = new Map();

    /**
     * 外部提供的查询函数：通过屏幕坐标查询命中的要素。
     * 由 InteractionManager 在注册时注入，SelectTool 不直接依赖 PickingEngine。
     * 如果未设置，click 模式下不会选中任何要素。
     */
    private _queryFeaturesAtPoint: ((x: number, y: number) => Feature[]) | null = null;

    /**
     * 外部提供的查询函数：通过 BBox 查询范围内的要素。
     * 由 InteractionManager 在注册时注入。
     */
    private _queryFeaturesInBox: ((bbox: BBox2D) => Feature[]) | null = null;

    /**
     * 外部提供的查询函数：通过多边形（屏幕坐标）查询范围内的要素。
     * 由 InteractionManager 在注册时注入。
     */
    private _queryFeaturesInPolygon: ((polygon: Position[]) => Feature[]) | null = null;

    // ===================== 构造函数 =====================

    /**
     * 创建选择工具实例。
     *
     * @param options - 配置选项，所有字段可选，有默认值
     *
     * @example
     * const select = new SelectTool({ mode: 'lasso', multiSelect: false });
     */
    constructor(options: SelectToolOptions = {}) {
        this._mode = options.mode ?? 'click';
        this._layers = options.layers?.slice() ?? [];
        this._multiSelect = options.multiSelect ?? true;

        // 高亮样式合并默认值
        this._highlightStyle = {
            color: options.highlightStyle?.color ?? '#ffcc00',
            opacity: options.highlightStyle?.opacity ?? 0.4,
            outlineColor: options.highlightStyle?.outlineColor ?? '#ff6600',
            outlineWidth: options.highlightStyle?.outlineWidth ?? 2,
        };

        if (__DEV__) {
            console.debug(`[SelectTool] 初始化完成，模式=${this._mode}, 多选=${this._multiSelect}, 限定图层=${this._layers.length > 0 ? this._layers.join(',') : '全部'}`);
        }
    }

    // ===================== 公共属性访问器 =====================

    /**
     * 获取当前选择模式。
     *
     * @returns 当前模式
     */
    get mode(): SelectMode {
        return this._mode;
    }

    /**
     * 获取当前选中的要素数量。
     *
     * @returns 选中数量
     *
     * @example
     * console.log(`选中了 ${select.selectedCount} 个要素`);
     */
    get selectedCount(): number {
        return this._selectedIds.size;
    }

    /**
     * 获取高亮样式（只读）。
     *
     * @returns 高亮样式对象
     */
    get highlightStyle(): Readonly<Required<HighlightStyle>> {
        return this._highlightStyle;
    }

    /**
     * 获取可选图层过滤列表（只读副本）。
     *
     * @returns 图层 ID 数组
     */
    get layers(): ReadonlyArray<string> {
        return this._layers;
    }

    /**
     * 是否允许多选。
     *
     * @returns 多选状态
     */
    get multiSelect(): boolean {
        return this._multiSelect;
    }

    // ===================== 公共方法 =====================

    /**
     * 切换选择模式。
     * 切换时会取消正在进行的框选/套索操作。
     *
     * @param mode - 新的选择模式
     *
     * @example
     * select.setMode('box');
     */
    setMode(mode: SelectMode): void {
        if (mode === this._mode) {
            return;
        }

        // 取消正在进行的操作
        this._cancelPendingOperation();
        this._mode = mode;

        if (__DEV__) {
            console.debug(`[SelectTool] 模式切换至 ${mode}`);
        }
    }

    /**
     * 获取当前选中的所有要素 ID 列表。
     * 返回防御性浅拷贝。
     *
     * @returns 选中的要素 ID 数组
     *
     * @example
     * const features = select.getSelectedFeatures();
     * features.forEach(id => console.log('选中:', id));
     */
    getSelectedFeatures(): ReadonlyArray<string | number> {
        return Array.from(this._selectedIds);
    }

    /**
     * 清除所有选中。
     * 触发 selectionchange 事件（如果确实有要素被取消选中）。
     *
     * @example
     * select.clearSelection();
     */
    clearSelection(): void {
        if (this._selectedIds.size === 0) {
            // 已经为空，无需操作
            return;
        }

        // 记录被移除的 ID（用于事件载荷）
        const removed = Array.from(this._selectedIds);
        this._selectedIds.clear();

        // 发射变更事件
        this._emitChange([], removed);

        if (__DEV__) {
            console.debug(`[SelectTool] 清除选择，移除 ${removed.length} 个要素`);
        }
    }

    /**
     * 通过 ID 列表批量选中要素（替换当前选中集合）。
     *
     * @param ids - 要选中的要素 ID 数组
     *
     * @example
     * select.selectFeatures([1, 2, 3]);
     */
    selectFeatures(ids: ReadonlyArray<string | number>): void {
        // 记录之前的选中状态用于 diff
        const prevIds = new Set(this._selectedIds);
        this._selectedIds.clear();

        // 添加新的 ID，过滤掉 null / undefined / NaN
        const validIds: Array<string | number> = [];
        for (const id of ids) {
            if (id !== null && id !== undefined && (typeof id === 'string' || isFinite(id))) {
                this._selectedIds.add(id);
                validIds.push(id);
            }
        }

        // 计算 diff
        const added: Array<string | number> = [];
        const removed: Array<string | number> = [];

        // 新增的：在新集合中但不在旧集合中
        for (const id of validIds) {
            if (!prevIds.has(id)) {
                added.push(id);
            }
        }

        // 移除的：在旧集合中但不在新集合中
        for (const id of prevIds) {
            if (!this._selectedIds.has(id)) {
                removed.push(id);
            }
        }

        // 只有确实发生了变化才发射事件
        if (added.length > 0 || removed.length > 0) {
            this._emitChange(added, removed);
        }
    }

    /**
     * 向当前选中集合追加要素。
     * 已存在的 ID 不会重复添加。
     *
     * @param ids - 要追加的要素 ID 数组
     *
     * @example
     * select.addToSelection([4, 5]);
     */
    addToSelection(ids: ReadonlyArray<string | number>): void {
        const added: Array<string | number> = [];

        for (const id of ids) {
            // 过滤无效 ID
            if (id === null || id === undefined) {
                continue;
            }
            if (typeof id === 'number' && !isFinite(id)) {
                continue;
            }
            // 只有不存在的才算新增
            if (!this._selectedIds.has(id)) {
                this._selectedIds.add(id);
                added.push(id);
            }
        }

        // 只有确实新增了才发射事件
        if (added.length > 0) {
            this._emitChange(added, []);
        }
    }

    /**
     * 从当前选中集合移除要素。
     *
     * @param ids - 要移除的要素 ID 数组
     *
     * @example
     * select.removeFromSelection([2, 3]);
     */
    removeFromSelection(ids: ReadonlyArray<string | number>): void {
        const removed: Array<string | number> = [];

        for (const id of ids) {
            if (this._selectedIds.has(id)) {
                this._selectedIds.delete(id);
                removed.push(id);
            }
        }

        if (removed.length > 0) {
            this._emitChange([], removed);
        }
    }

    /**
     * 注册外部查询函数。
     * 由 InteractionManager 在注册时调用，注入引擎的查询能力。
     *
     * @param queryAtPoint - 通过屏幕坐标查询命中要素
     * @param queryInBox - 通过 BBox 查询范围内要素
     * @param queryInPolygon - 通过多边形查询范围内要素
     *
     * @stability internal
     */
    setQueryFunctions(
        queryAtPoint: (x: number, y: number) => Feature[],
        queryInBox: (bbox: BBox2D) => Feature[],
        queryInPolygon: (polygon: Position[]) => Feature[],
    ): void {
        this._queryFeaturesAtPoint = queryAtPoint;
        this._queryFeaturesInBox = queryInBox;
        this._queryFeaturesInPolygon = queryInPolygon;
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
     * select.on('selectionchange', (e) => {
     *   console.log('新增:', e.added, '移除:', e.removed);
     * });
     */
    on(type: SelectEventType, listener: SelectEventListener): this {
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
     * select.off('selectionchange', myHandler);
     */
    off(type: SelectEventType, listener: SelectEventListener): this {
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
     * click 模式下触发选择/切换，box/lasso 模式下开始操作。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     * @param shiftKey - 是否按住 Shift 键（追加选择）
     *
     * @example
     * select.handlePointerDown(500, 300, [116.39, 39.91], false);
     */
    handlePointerDown(
        screenX: number,
        screenY: number,
        lngLat: Position,
        shiftKey: boolean = false,
    ): void {
        // 参数有效性检查
        if (!isFinite(screenX) || !isFinite(screenY)) {
            if (__DEV__) {
                console.warn('[SelectTool] handlePointerDown: 无效的屏幕坐标');
            }
            return;
        }

        switch (this._mode) {
            case 'click': {
                // 单击模式：通过查询函数获取命中要素并处理选择
                this._handleClickSelect(screenX, screenY, shiftKey);
                break;
            }
            case 'box': {
                // 框选模式：记录拖拽起点
                this._boxDragState = {
                    startScreen: [screenX, screenY],
                    startCoord: lngLat,
                    dragging: false,
                };
                break;
            }
            case 'lasso': {
                // 套索模式：开始记录路径
                this._lassoState = {
                    screenPath: [[screenX, screenY]],
                    coordPath: [lngLat],
                    active: true,
                };
                break;
            }
        }
    }

    /**
     * 处理指针移动事件。
     * box 模式下更新拖拽矩形，lasso 模式下追加路径点。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * select.handlePointerMove(510, 310, [116.40, 39.92]);
     */
    handlePointerMove(screenX: number, screenY: number, lngLat: Position): void {
        if (!isFinite(screenX) || !isFinite(screenY)) {
            return;
        }

        switch (this._mode) {
            case 'box': {
                if (this._boxDragState !== null) {
                    // 计算拖拽距离平方
                    const dx = screenX - this._boxDragState.startScreen[0];
                    const dy = screenY - this._boxDragState.startScreen[1];
                    const distSq = dx * dx + dy * dy;

                    // 超过最小阈值才标记为有效拖拽
                    if (distSq >= MIN_BOX_DRAG_DIST_SQ) {
                        this._boxDragState.dragging = true;
                    }
                }
                break;
            }
            case 'lasso': {
                if (this._lassoState !== null && this._lassoState.active) {
                    // 检查与上一个路径点的像素距离
                    const path = this._lassoState.screenPath;
                    const lastPt = path[path.length - 1];
                    const dx = screenX - lastPt[0];
                    const dy = screenY - lastPt[1];
                    const distSq = dx * dx + dy * dy;

                    // 超过最小间距才添加新路径点
                    if (distSq >= MIN_LASSO_SEGMENT_DIST_SQ) {
                        this._lassoState.screenPath.push([screenX, screenY]);
                        this._lassoState.coordPath.push(lngLat);
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * 处理指针抬起事件。
     * box 模式下完成框选，lasso 模式下完成套索选择。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     * @param shiftKey - 是否按住 Shift 键
     *
     * @example
     * select.handlePointerUp(600, 400, [116.50, 40.00], false);
     */
    handlePointerUp(
        screenX: number,
        screenY: number,
        lngLat: Position,
        shiftKey: boolean = false,
    ): void {
        if (!isFinite(screenX) || !isFinite(screenY)) {
            return;
        }

        switch (this._mode) {
            case 'box': {
                if (this._boxDragState !== null) {
                    if (this._boxDragState.dragging) {
                        // 有效拖拽：计算 BBox 并执行框选
                        this._handleBoxSelect(
                            this._boxDragState.startCoord,
                            lngLat,
                            shiftKey,
                        );
                    }
                    // 重置拖拽状态
                    this._boxDragState = null;
                }
                break;
            }
            case 'lasso': {
                if (this._lassoState !== null && this._lassoState.active) {
                    // 最后一个点
                    this._lassoState.screenPath.push([screenX, screenY]);
                    this._lassoState.coordPath.push(lngLat);

                    // 至少需要 3 个点才能形成闭合多边形
                    if (this._lassoState.coordPath.length >= 3) {
                        this._handleLassoSelect(
                            this._lassoState.coordPath,
                            shiftKey,
                        );
                    }

                    // 重置套索状态
                    this._lassoState = null;
                }
                break;
            }
            default:
                break;
        }
    }

    /**
     * 处理双击事件。
     * 当前实现中双击无特殊逻辑，预留以备扩展。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @param lngLat - 经纬度坐标 [longitude, latitude]
     *
     * @example
     * select.handleDoubleClick(500, 300, [116.39, 39.91]);
     */
    handleDoubleClick(screenX: number, screenY: number, lngLat: Position): void {
        // 双击预留扩展点（如双击选中整个图层、缩放到选中要素等）
        if (__DEV__) {
            console.debug(`[SelectTool] 双击事件 at (${screenX}, ${screenY})`);
        }
    }

    // ===================== 私有方法 =====================

    /**
     * 处理单击选择逻辑。
     * 通过外部注入的查询函数获取命中要素，然后根据多选设置处理。
     *
     * @param screenX - 屏幕 X
     * @param screenY - 屏幕 Y
     * @param shiftKey - 是否按住 Shift
     */
    private _handleClickSelect(screenX: number, screenY: number, shiftKey: boolean): void {
        // 通过外部查询函数获取命中要素
        let hitFeatures: Feature[] = [];

        if (this._queryFeaturesAtPoint !== null) {
            try {
                hitFeatures = this._queryFeaturesAtPoint(screenX, screenY);
            } catch (err) {
                if (__DEV__) {
                    console.error('[SelectTool] queryFeaturesAtPoint 执行出错:', err);
                }
                return;
            }
        }

        // 过滤图层
        if (this._layers.length > 0) {
            hitFeatures = hitFeatures.filter(
                (f) => f._layerId !== undefined && this._layers.includes(f._layerId),
            );
        }

        if (hitFeatures.length === 0) {
            // 未命中任何要素
            if (!shiftKey && !this._multiSelect) {
                // 非追加模式下，清除选中
                this.clearSelection();
            } else if (!shiftKey) {
                // 多选模式下单击空白也清除
                this.clearSelection();
            }
            return;
        }

        // 取第一个命中的要素（最上层）
        const topFeature = hitFeatures[0];
        const featureId = topFeature.id;

        // 无 ID 的要素无法进行选择管理
        if (featureId === undefined || featureId === null) {
            if (__DEV__) {
                console.warn('[SelectTool] 命中要素无 ID，无法选择');
            }
            return;
        }

        if (this._multiSelect || shiftKey) {
            // 多选/Shift 模式：切换选中状态
            if (this._selectedIds.has(featureId)) {
                // 已选中→取消选中
                this._selectedIds.delete(featureId);
                this._emitChange([], [featureId]);
            } else {
                // 未选中→添加选中
                this._selectedIds.add(featureId);
                this._emitChange([featureId], []);
            }
        } else {
            // 单选模式：替换选中
            const prevIds = Array.from(this._selectedIds);
            this._selectedIds.clear();
            this._selectedIds.add(featureId);

            // 计算 diff
            const removed = prevIds.filter((id) => id !== featureId);
            const added = prevIds.includes(featureId) ? [] : [featureId];
            if (added.length > 0 || removed.length > 0) {
                this._emitChange(added, removed);
            }
        }
    }

    /**
     * 处理框选逻辑。
     * 由两个对角点构建 BBox，通过查询函数获取范围内要素。
     *
     * @param startCoord - 拖拽起点经纬度
     * @param endCoord - 拖拽终点经纬度
     * @param shiftKey - 是否按住 Shift（追加模式）
     */
    private _handleBoxSelect(startCoord: Position, endCoord: Position, shiftKey: boolean): void {
        // 构建 BBox
        const west = Math.min(startCoord[0], endCoord[0]);
        const east = Math.max(startCoord[0], endCoord[0]);
        const south = Math.min(startCoord[1], endCoord[1]);
        const north = Math.max(startCoord[1], endCoord[1]);

        const bbox: BBox2D = { west, south, east, north };

        // 通过外部查询函数获取范围内要素
        let boxFeatures: Feature[] = [];

        if (this._queryFeaturesInBox !== null) {
            try {
                boxFeatures = this._queryFeaturesInBox(bbox);
            } catch (err) {
                if (__DEV__) {
                    console.error('[SelectTool] queryFeaturesInBox 执行出错:', err);
                }
                return;
            }
        }

        // 过滤图层
        if (this._layers.length > 0) {
            boxFeatures = boxFeatures.filter(
                (f) => f._layerId !== undefined && this._layers.includes(f._layerId),
            );
        }

        // 收集有效的要素 ID
        const hitIds: Array<string | number> = [];
        for (const f of boxFeatures) {
            if (f.id !== undefined && f.id !== null) {
                hitIds.push(f.id);
            }
        }

        if (shiftKey && this._multiSelect) {
            // Shift+多选：追加到已有选中
            this.addToSelection(hitIds);
        } else {
            // 替换选中
            this.selectFeatures(hitIds);
        }

        if (__DEV__) {
            console.debug(`[SelectTool] 框选完成: bbox=(${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}), 命中 ${hitIds.length} 个要素`);
        }
    }

    /**
     * 处理套索选择逻辑。
     * 使用经纬度坐标构建闭合多边形，通过查询函数获取范围内要素。
     * 如果外部查询函数不可用，则使用内置的点在多边形内检测。
     *
     * @param lassoCoords - 套索路径的经纬度坐标序列
     * @param shiftKey - 是否按住 Shift（追加模式）
     */
    private _handleLassoSelect(lassoCoords: Position[], shiftKey: boolean): void {
        let lassoFeatures: Feature[] = [];

        if (this._queryFeaturesInPolygon !== null) {
            try {
                lassoFeatures = this._queryFeaturesInPolygon(lassoCoords);
            } catch (err) {
                if (__DEV__) {
                    console.error('[SelectTool] queryFeaturesInPolygon 执行出错:', err);
                }
                return;
            }
        }

        // 过滤图层
        if (this._layers.length > 0) {
            lassoFeatures = lassoFeatures.filter(
                (f) => f._layerId !== undefined && this._layers.includes(f._layerId),
            );
        }

        // 收集有效 ID
        const hitIds: Array<string | number> = [];
        for (const f of lassoFeatures) {
            if (f.id !== undefined && f.id !== null) {
                hitIds.push(f.id);
            }
        }

        if (shiftKey && this._multiSelect) {
            this.addToSelection(hitIds);
        } else {
            this.selectFeatures(hitIds);
        }

        if (__DEV__) {
            console.debug(`[SelectTool] 套索选择完成: 路径顶点数=${lassoCoords.length}, 命中 ${hitIds.length} 个要素`);
        }
    }

    /**
     * 取消正在进行的框选/套索操作。
     */
    private _cancelPendingOperation(): void {
        this._boxDragState = null;
        if (this._lassoState !== null) {
            this._lassoState.active = false;
            this._lassoState = null;
        }
    }

    // ===================== 事件发射 =====================

    /**
     * 发射 selectionchange 事件。
     *
     * @param added - 本次新增选中的 ID
     * @param removed - 本次取消选中的 ID
     */
    private _emitChange(
        added: ReadonlyArray<string | number>,
        removed: ReadonlyArray<string | number>,
    ): void {
        const event: SelectEvent = {
            type: 'selectionchange',
            selectedIds: Array.from(this._selectedIds),
            added,
            removed,
            mode: this._mode,
        };

        const set = this._listeners.get('selectionchange');
        if (set === undefined || set.size === 0) {
            return;
        }

        for (const listener of set) {
            try {
                listener(event);
            } catch (err) {
                if (__DEV__) {
                    console.error('[SelectTool] selectionchange 监听器执行出错:', err);
                }
            }
        }
    }
}

// ===================== 独立工具函数 =====================

/**
 * 射线投射法判断点是否在多边形内（2D）。
 *
 * 从点向右发射水平射线，统计与多边形边的交叉次数。
 * 奇数次交叉表示在多边形内，偶数次在外。
 *
 * 算法来源：W. Randolph Franklin (WRF)
 * https://wrf.ecse.rpi.edu/Research/Short_Notes/pnpoly.html
 *
 * @param point - 待检测的点坐标 [x, y]
 * @param polygon - 多边形顶点数组（不要求闭合，函数内部处理环绕）
 * @returns 点在多边形内部或边界上返回 `true`
 *
 * @example
 * const inside = pointInPolygon(
 *   [0.5, 0.5],
 *   [[0,0], [1,0], [1,1], [0,1]]
 * );
 * console.log(inside); // true
 */
export function pointInPolygon(point: Position, polygon: Position[]): boolean {
    const n = polygon.length;
    // 至少需要 3 个顶点
    if (n < 3) {
        return false;
    }

    const px = point[0];
    const py = point[1];
    let inside = false;

    // j 始终指向当前顶点 i 的前一个顶点（环绕处理）
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i][0];
        const yi = polygon[i][1];
        const xj = polygon[j][0];
        const yj = polygon[j][1];

        // 条件 1：点的 y 坐标在边的 y 范围内（半开区间防止重复计数角点）
        // 条件 2：射线（水平向右）与边相交
        const intersect = ((yi > py) !== (yj > py))
            && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);

        if (intersect) {
            inside = !inside;
        }
    }

    return inside;
}
