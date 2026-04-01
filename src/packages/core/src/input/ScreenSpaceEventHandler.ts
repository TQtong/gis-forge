// ============================================================
// input/ScreenSpaceEventHandler.ts — 屏幕空间事件处理器
//
// 移植自 Cesium ScreenSpaceEventHandler.js
// 层级：L0（仅依赖同包 ScreenSpaceEventType / KeyboardEventModifier）
// 职责：捕获 DOM 鼠标/触摸/滚轮事件，归一化为统一回调接口
// ============================================================

import { ScreenSpaceEventType } from './ScreenSpaceEventType.ts';
import { KeyboardEventModifier } from './KeyboardEventModifier.ts';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 二维屏幕坐标 */
export interface Cartesian2 {
    x: number;
    y: number;
}

/** 按下/点击事件回调参数 */
export interface PositionedEvent {
    position: Cartesian2;
}

/** 移动事件回调参数 */
export interface MovementEvent {
    startPosition: Cartesian2;
    endPosition: Cartesian2;
}

/** 双指触摸开始事件回调参数 */
export interface PinchStartEvent {
    position1: Cartesian2;
    position2: Cartesian2;
}

/** 双指触摸移动事件回调参数 */
export interface PinchMovementEvent {
    distance: { startPosition: Cartesian2; endPosition: Cartesian2 };
    angleAndHeight: { startPosition: Cartesian2; endPosition: Cartesian2 };
}

/** 输入动作回调函数类型 */
export type InputAction =
    | ((event: PositionedEvent) => void)
    | ((event: MovementEvent) => void)
    | ((delta: number) => void)
    | ((event: PinchStartEvent) => void)
    | ((event: PinchMovementEvent) => void)
    | (() => void);

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const MouseButton = { LEFT: 0, MIDDLE: 1, RIGHT: 2 } as const;

function getInputEventKey(
    type: ScreenSpaceEventType,
    modifier?: KeyboardEventModifier,
): string {
    let key = `${type}`;
    if (modifier !== undefined) {
        key += `+${modifier}`;
    }
    return key;
}

function getModifier(event: MouseEvent | TouchEvent | KeyboardEvent): KeyboardEventModifier | undefined {
    if (event.shiftKey) return KeyboardEventModifier.SHIFT;
    if (event.ctrlKey) return KeyboardEventModifier.CTRL;
    if (event.altKey) return KeyboardEventModifier.ALT;
    return undefined;
}

function getPosition(
    element: HTMLElement,
    event: MouseEvent | Touch,
    result: Cartesian2,
): Cartesian2 {
    const rect = element.getBoundingClientRect();
    result.x = event.clientX - rect.left;
    result.y = event.clientY - rect.top;
    return result;
}

function cloneCartesian2(src: Cartesian2, dst: Cartesian2): Cartesian2 {
    dst.x = src.x;
    dst.y = src.y;
    return dst;
}

function newCartesian2(x = 0, y = 0): Cartesian2 {
    return { x, y };
}

function checkPixelTolerance(
    start: Cartesian2,
    end: Cartesian2,
    tolerance: number,
): boolean {
    const dx = start.x - end.x;
    const dy = start.y - end.y;
    return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

/** 触摸事件后忽略鼠标模拟事件的时间窗口（毫秒） */
const TOUCH_EMULATION_IGNORE_MS = 800;

// ---------------------------------------------------------------------------
// ScreenSpaceEventHandler
// ---------------------------------------------------------------------------

/**
 * 屏幕空间事件处理器。
 *
 * 在指定的 HTMLElement（通常为 Canvas）上监听鼠标/触摸/滚轮 DOM 事件，
 * 将其归一化为 {@link ScreenSpaceEventType} 并分发到通过 {@link setInputAction} 注册的回调。
 *
 * 移植自 Cesium `ScreenSpaceEventHandler`，保持完全一致的事件模型：
 * - 按键+修饰键组合注册/分发
 * - 点击检测（像素容差区分 click vs. drag）
 * - 触摸→鼠标映射（单指=左键，长按=右键点击）
 * - 双指 pinch 开始/移动/结束
 * - 滚轮事件跨浏览器标准化
 */
export class ScreenSpaceEventHandler {
    private _element: HTMLElement;
    private _inputActions: Map<string, InputAction> = new Map();
    private _buttonDown: boolean[] = [false, false, false];
    private _isPinching = false;
    private _isTouchHolding = false;

    // 鼠标位置追踪
    private _primaryPosition: Cartesian2 = newCartesian2();
    private _primaryStartPosition: Cartesian2 = newCartesian2();
    private _primaryPreviousPosition: Cartesian2 = newCartesian2();

    // 触摸追踪
    private _positions: Map<number, Cartesian2> = new Map();
    private _previousPositions: Map<number, Cartesian2> = new Map();
    private _touchHoldTimer: ReturnType<typeof setTimeout> | undefined;
    private _lastSeenTouchEvent = 0;

    // 像素容差
    private _clickPixelTolerance = 5;
    private _holdPixelTolerance = 25;

    // DOM 监听器清理
    private _removalFunctions: (() => void)[] = [];
    private _destroyed = false;

    // ── 可重用事件对象（避免每次分配 GC） ──
    private _mouseDownEvt: PositionedEvent = { position: newCartesian2() };
    private _mouseUpEvt: PositionedEvent = { position: newCartesian2() };
    private _mouseClickEvt: PositionedEvent = { position: newCartesian2() };
    private _mouseMoveEvt: MovementEvent = { startPosition: newCartesian2(), endPosition: newCartesian2() };
    private _mouseDblClickEvt: PositionedEvent = { position: newCartesian2() };
    private _touchStartEvt: PositionedEvent = { position: newCartesian2() };
    private _touchEndEvt: PositionedEvent = { position: newCartesian2() };
    private _touchClickEvt: PositionedEvent = { position: newCartesian2() };
    private _touchHoldEvt: PositionedEvent = { position: newCartesian2() };
    private _touchMoveEvt: MovementEvent = { startPosition: newCartesian2(), endPosition: newCartesian2() };
    private _touch2StartEvt: PinchStartEvent = { position1: newCartesian2(), position2: newCartesian2() };
    private _touchPinchMoveEvt: PinchMovementEvent = {
        distance: { startPosition: newCartesian2(), endPosition: newCartesian2() },
        angleAndHeight: { startPosition: newCartesian2(), endPosition: newCartesian2() },
    };

    constructor(element: HTMLElement) {
        this._element = element;
        this._registerListeners();
    }

    // ═══════════════════════════════════════════════════════════
    // 公开 API
    // ═══════════════════════════════════════════════════════════

    setInputAction(
        action: InputAction,
        type: ScreenSpaceEventType,
        modifier?: KeyboardEventModifier,
    ): void {
        const key = getInputEventKey(type, modifier);
        this._inputActions.set(key, action);
    }

    getInputAction(
        type: ScreenSpaceEventType,
        modifier?: KeyboardEventModifier,
    ): InputAction | undefined {
        return this._inputActions.get(getInputEventKey(type, modifier));
    }

    removeInputAction(
        type: ScreenSpaceEventType,
        modifier?: KeyboardEventModifier,
    ): void {
        this._inputActions.delete(getInputEventKey(type, modifier));
    }

    get element(): HTMLElement {
        return this._element;
    }

    isDestroyed(): boolean {
        return this._destroyed;
    }

    destroy(): void {
        this._unregisterListeners();
        this._inputActions.clear();
        this._positions.clear();
        this._previousPositions.clear();
        if (this._touchHoldTimer !== undefined) {
            clearTimeout(this._touchHoldTimer);
        }
        this._destroyed = true;
    }

    // ═══════════════════════════════════════════════════════════
    // 内部：DOM 监听器注册
    // ═══════════════════════════════════════════════════════════

    private _registerListeners(): void {
        const el = this._element;
        const add = (
            domType: string,
            target: EventTarget,
            cb: (handler: ScreenSpaceEventHandler, e: Event) => void,
        ) => {
            const listener = (e: Event) => cb(this, e);
            target.addEventListener(domType, listener, { capture: false, passive: false });
            this._removalFunctions.push(() => target.removeEventListener(domType, listener));
        };

        // Pointer events（现代浏览器）
        if ('onpointerdown' in el) {
            add('pointerdown', el, handlePointerDown);
            add('pointerup', el, handlePointerUp);
            add('pointermove', el, handlePointerMove);
            add('pointercancel', el, handlePointerUp);
        } else {
            add('mousedown', el, handleMouseDown);
            add('mouseup', document, handleMouseUp);
            add('mousemove', document, handleMouseMove);
            add('touchstart', el, handleTouchStart);
            add('touchend', document, handleTouchEnd);
            add('touchmove', document, handleTouchMove);
            add('touchcancel', document, handleTouchEnd);
        }

        add('dblclick', el, handleDblClick);
        add('wheel', el, handleWheel);
        add('contextmenu', el, handleContextMenu);
    }

    private _unregisterListeners(): void {
        for (const fn of this._removalFunctions) fn();
        this._removalFunctions.length = 0;
    }

    // ═══════════════════════════════════════════════════════════
    // 内部：触摸-鼠标去重
    // ═══════════════════════════════════════════════════════════

    _gotTouchEvent(): void {
        this._lastSeenTouchEvent = performance.now();
    }

    _canProcessMouseEvent(): boolean {
        return performance.now() - this._lastSeenTouchEvent > TOUCH_EMULATION_IGNORE_MS;
    }
}

// ═══════════════════════════════════════════════════════════════
// 静态事件处理器（与 Cesium 架构对齐）
// ═══════════════════════════════════════════════════════════════

function handleContextMenu(_handler: ScreenSpaceEventHandler, e: Event): void {
    e.preventDefault();
}

// ── Pointer Events（现代浏览器统一路径） ──

function handlePointerDown(handler: ScreenSpaceEventHandler, e: Event): void {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch') {
        handleTouchPointerDown(handler, pe);
    } else {
        handleMouseDown(handler, pe);
    }
}

function handlePointerUp(handler: ScreenSpaceEventHandler, e: Event): void {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch') {
        handleTouchPointerUp(handler, pe);
    } else {
        handleMouseUp(handler, pe);
    }
}

function handlePointerMove(handler: ScreenSpaceEventHandler, e: Event): void {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch') {
        handleTouchPointerMove(handler, pe);
    } else {
        handleMouseMove(handler, pe);
    }
}

// ── 触摸 Pointer 简化实现 ──

function handleTouchPointerDown(h: ScreenSpaceEventHandler, e: PointerEvent): void {
    h._gotTouchEvent();
    const pos = newCartesian2();
    getPosition(h['_element'], e, pos);
    h['_positions'].set(e.pointerId, pos);
    fireTouchEvents(h, e);
    h['_previousPositions'].set(e.pointerId, { x: pos.x, y: pos.y });
}

function handleTouchPointerUp(h: ScreenSpaceEventHandler, e: PointerEvent): void {
    h._gotTouchEvent();
    h['_positions'].delete(e.pointerId);
    fireTouchEvents(h, e);
    h['_previousPositions'].delete(e.pointerId);
}

function handleTouchPointerMove(h: ScreenSpaceEventHandler, e: PointerEvent): void {
    h._gotTouchEvent();
    const pos = h['_positions'].get(e.pointerId);
    if (pos) {
        getPosition(h['_element'], e, pos);
    }
    fireTouchMoveEvents(h, e);
    const prev = h['_previousPositions'].get(e.pointerId);
    const cur = h['_positions'].get(e.pointerId);
    if (prev && cur) {
        cloneCartesian2(cur, prev);
    }
}

// ── 鼠标事件 ──

function handleMouseDown(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    if (!h._canProcessMouseEvent()) return;
    const event = e as MouseEvent;
    const button = event.button;
    h['_buttonDown'][button] = true;

    let type: ScreenSpaceEventType;
    if (button === MouseButton.LEFT) type = ScreenSpaceEventType.LEFT_DOWN;
    else if (button === MouseButton.MIDDLE) type = ScreenSpaceEventType.MIDDLE_DOWN;
    else if (button === MouseButton.RIGHT) type = ScreenSpaceEventType.RIGHT_DOWN;
    else return;

    const pos = getPosition(h['_element'], event, h['_primaryPosition']);
    cloneCartesian2(pos, h['_primaryStartPosition']);
    cloneCartesian2(pos, h['_primaryPreviousPosition']);

    const modifier = getModifier(event);
    const action = h.getInputAction(type, modifier);
    if (action) {
        cloneCartesian2(pos, h['_mouseDownEvt'].position);
        (action as (e: PositionedEvent) => void)(h['_mouseDownEvt']);
        event.preventDefault();
    }
}

function handleMouseUp(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    if (!h._canProcessMouseEvent()) return;
    const event = e as MouseEvent;
    const button = event.button;

    if (button !== MouseButton.LEFT && button !== MouseButton.MIDDLE && button !== MouseButton.RIGHT) return;

    if (h['_buttonDown'][MouseButton.LEFT]) {
        cancelMouseEvent(h, ScreenSpaceEventType.LEFT_UP, ScreenSpaceEventType.LEFT_CLICK, event);
        h['_buttonDown'][MouseButton.LEFT] = false;
    }
    if (h['_buttonDown'][MouseButton.MIDDLE]) {
        cancelMouseEvent(h, ScreenSpaceEventType.MIDDLE_UP, ScreenSpaceEventType.MIDDLE_CLICK, event);
        h['_buttonDown'][MouseButton.MIDDLE] = false;
    }
    if (h['_buttonDown'][MouseButton.RIGHT]) {
        cancelMouseEvent(h, ScreenSpaceEventType.RIGHT_UP, ScreenSpaceEventType.RIGHT_CLICK, event);
        h['_buttonDown'][MouseButton.RIGHT] = false;
    }
}

function cancelMouseEvent(
    h: ScreenSpaceEventHandler,
    upType: ScreenSpaceEventType,
    clickType: ScreenSpaceEventType,
    event: MouseEvent,
): void {
    const modifier = getModifier(event);
    const upAction = h.getInputAction(upType, modifier);
    const clickAction = h.getInputAction(clickType, modifier);

    if (upAction || clickAction) {
        const pos = getPosition(h['_element'], event, h['_primaryPosition']);
        if (upAction) {
            cloneCartesian2(pos, h['_mouseUpEvt'].position);
            (upAction as (e: PositionedEvent) => void)(h['_mouseUpEvt']);
        }
        if (clickAction) {
            if (checkPixelTolerance(h['_primaryStartPosition'], pos, h['_clickPixelTolerance'])) {
                cloneCartesian2(pos, h['_mouseClickEvt'].position);
                (clickAction as (e: PositionedEvent) => void)(h['_mouseClickEvt']);
            }
        }
    }
}

function handleMouseMove(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    if (!h._canProcessMouseEvent()) return;
    const event = e as MouseEvent;
    const modifier = getModifier(event);

    const pos = getPosition(h['_element'], event, h['_primaryPosition']);
    const prev = h['_primaryPreviousPosition'];

    const action = h.getInputAction(ScreenSpaceEventType.MOUSE_MOVE, modifier);
    if (action) {
        cloneCartesian2(prev, h['_mouseMoveEvt'].startPosition);
        cloneCartesian2(pos, h['_mouseMoveEvt'].endPosition);
        (action as (e: MovementEvent) => void)(h['_mouseMoveEvt']);
    }

    cloneCartesian2(pos, prev);

    if (h['_buttonDown'][MouseButton.LEFT] || h['_buttonDown'][MouseButton.MIDDLE] || h['_buttonDown'][MouseButton.RIGHT]) {
        event.preventDefault();
    }
}

function handleDblClick(handler: ScreenSpaceEventHandler, e: Event): void {
    const event = e as MouseEvent;
    if (event.button !== MouseButton.LEFT) return;

    const modifier = getModifier(event);
    const action = handler.getInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK, modifier);
    if (action) {
        getPosition(handler['_element'], event, handler['_mouseDblClickEvt'].position);
        (action as (e: PositionedEvent) => void)(handler['_mouseDblClickEvt']);
    }
}

function handleWheel(handler: ScreenSpaceEventHandler, e: Event): void {
    const event = e as WheelEvent;
    let delta: number;

    if (event.deltaY !== undefined) {
        const deltaMode = event.deltaMode;
        if (deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
            delta = -event.deltaY;
        } else if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
            delta = -event.deltaY * 40;
        } else {
            // DOM_DELTA_PAGE
            delta = -event.deltaY * 120;
        }
    } else {
        return;
    }

    const modifier = getModifier(event);
    const action = handler.getInputAction(ScreenSpaceEventType.WHEEL, modifier);
    if (action) {
        (action as (d: number) => void)(delta);
        event.preventDefault();
    }
}

// ── 传统触摸事件 ──

function handleTouchStart(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    h._gotTouchEvent();
    const event = e as TouchEvent;
    const changedTouches = event.changedTouches;
    for (let i = 0; i < changedTouches.length; ++i) {
        const touch = changedTouches[i];
        const pos = newCartesian2();
        getPosition(h['_element'], touch, pos);
        h['_positions'].set(touch.identifier, pos);
    }
    fireTouchEvents(h, event);
    for (let i = 0; i < changedTouches.length; ++i) {
        const touch = changedTouches[i];
        const cur = h['_positions'].get(touch.identifier);
        if (cur) h['_previousPositions'].set(touch.identifier, { x: cur.x, y: cur.y });
    }
}

function handleTouchEnd(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    h._gotTouchEvent();
    const event = e as TouchEvent;
    const changedTouches = event.changedTouches;
    for (let i = 0; i < changedTouches.length; ++i) {
        h['_positions'].delete(changedTouches[i].identifier);
    }
    fireTouchEvents(h, event);
    for (let i = 0; i < changedTouches.length; ++i) {
        h['_previousPositions'].delete(changedTouches[i].identifier);
    }
}

function handleTouchMove(handler: ScreenSpaceEventHandler, e: Event): void {
    const h = handler;
    h._gotTouchEvent();
    const event = e as TouchEvent;
    const changedTouches = event.changedTouches;
    for (let i = 0; i < changedTouches.length; ++i) {
        const touch = changedTouches[i];
        const pos = h['_positions'].get(touch.identifier);
        if (pos) getPosition(h['_element'], touch, pos);
    }
    fireTouchMoveEvents(h, event);
    for (let i = 0; i < changedTouches.length; ++i) {
        const touch = changedTouches[i];
        const cur = h['_positions'].get(touch.identifier);
        const prev = h['_previousPositions'].get(touch.identifier);
        if (cur && prev) cloneCartesian2(cur, prev);
    }
}

// ── 触摸状态转换（Cesium fireTouchEvents） ──

function fireTouchEvents(h: ScreenSpaceEventHandler, event: TouchEvent | PointerEvent): void {
    const modifier = getModifier(event as unknown as MouseEvent);
    const positions = h['_positions'];
    const numberOfTouches = positions.size;
    const pinching = h['_isPinching'];

    // 从单指切换到其他状态
    if (numberOfTouches !== 1 && h['_buttonDown'][MouseButton.LEFT]) {
        h['_buttonDown'][MouseButton.LEFT] = false;
        if (h['_touchHoldTimer'] !== undefined) {
            clearTimeout(h['_touchHoldTimer']);
            h['_touchHoldTimer'] = undefined;
        }

        const upAction = h.getInputAction(ScreenSpaceEventType.LEFT_UP, modifier);
        if (upAction) {
            cloneCartesian2(h['_primaryPosition'], h['_touchEndEvt'].position);
            (upAction as (e: PositionedEvent) => void)(h['_touchEndEvt']);
        }

        if (numberOfTouches === 0 && !h['_isTouchHolding']) {
            const clickAction = h.getInputAction(ScreenSpaceEventType.LEFT_CLICK, modifier);
            if (clickAction) {
                const prevArr = Array.from(h['_previousPositions'].values());
                if (prevArr.length > 0 && checkPixelTolerance(h['_primaryStartPosition'], prevArr[0], h['_clickPixelTolerance'])) {
                    cloneCartesian2(h['_primaryPosition'], h['_touchClickEvt'].position);
                    (clickAction as (e: PositionedEvent) => void)(h['_touchClickEvt']);
                }
            }
        }
        h['_isTouchHolding'] = false;
    }

    // pinch 结束
    if (numberOfTouches === 0 && pinching) {
        h['_isPinching'] = false;
        const action = h.getInputAction(ScreenSpaceEventType.PINCH_END, modifier);
        if (action) (action as () => void)();
    }

    // 进入单指
    if (numberOfTouches === 1 && !pinching) {
        const posArr = Array.from(positions.values());
        const pos = posArr[0];
        cloneCartesian2(pos, h['_primaryPosition']);
        cloneCartesian2(pos, h['_primaryStartPosition']);
        cloneCartesian2(pos, h['_primaryPreviousPosition']);

        h['_buttonDown'][MouseButton.LEFT] = true;

        const downAction = h.getInputAction(ScreenSpaceEventType.LEFT_DOWN, modifier);
        if (downAction) {
            cloneCartesian2(pos, h['_touchStartEvt'].position);
            (downAction as (e: PositionedEvent) => void)(h['_touchStartEvt']);
        }

        // 长按检测
        h['_touchHoldTimer'] = setTimeout(() => {
            if (!h.isDestroyed()) {
                h['_touchHoldTimer'] = undefined;
                h['_isTouchHolding'] = true;
                const holdAction = h.getInputAction(ScreenSpaceEventType.RIGHT_CLICK, modifier);
                if (holdAction) {
                    const prevArr = Array.from(h['_previousPositions'].values());
                    if (prevArr.length > 0 && checkPixelTolerance(h['_primaryStartPosition'], prevArr[0], h['_holdPixelTolerance'])) {
                        cloneCartesian2(h['_primaryPosition'], h['_touchHoldEvt'].position);
                        (holdAction as (e: PositionedEvent) => void)(h['_touchHoldEvt']);
                    }
                }
            }
        }, 1500);

        event.preventDefault();
    }

    // 进入双指 pinch
    if (numberOfTouches === 2 && !pinching) {
        h['_isPinching'] = true;
        const pinchAction = h.getInputAction(ScreenSpaceEventType.PINCH_START, modifier);
        if (pinchAction) {
            const posArr = Array.from(positions.values());
            cloneCartesian2(posArr[0], h['_touch2StartEvt'].position1);
            cloneCartesian2(posArr[1], h['_touch2StartEvt'].position2);
            (pinchAction as (e: PinchStartEvent) => void)(h['_touch2StartEvt']);
            event.preventDefault();
        }
    }
}

function fireTouchMoveEvents(h: ScreenSpaceEventHandler, event: TouchEvent | PointerEvent): void {
    const modifier = getModifier(event as unknown as MouseEvent);
    const positions = h['_positions'];
    const previousPositions = h['_previousPositions'];
    const numberOfTouches = positions.size;

    if (numberOfTouches === 1 && h['_buttonDown'][MouseButton.LEFT]) {
        const posArr = Array.from(positions.values());
        const pos = posArr[0];
        cloneCartesian2(pos, h['_primaryPosition']);
        const prev = h['_primaryPreviousPosition'];

        const moveAction = h.getInputAction(ScreenSpaceEventType.MOUSE_MOVE, modifier);
        if (moveAction) {
            cloneCartesian2(prev, h['_touchMoveEvt'].startPosition);
            cloneCartesian2(pos, h['_touchMoveEvt'].endPosition);
            (moveAction as (e: MovementEvent) => void)(h['_touchMoveEvt']);
        }
        cloneCartesian2(pos, prev);
        event.preventDefault();
    } else if (numberOfTouches === 2 && h['_isPinching']) {
        const pinchAction = h.getInputAction(ScreenSpaceEventType.PINCH_MOVE, modifier);
        if (pinchAction) {
            const posArr = Array.from(positions.values());
            const prevArr = Array.from(previousPositions.values());
            if (posArr.length >= 2 && prevArr.length >= 2) {
                const p1 = posArr[0], p2 = posArr[1];
                const pp1 = prevArr[0], pp2 = prevArr[1];

                const dX = p2.x - p1.x, dY = p2.y - p1.y;
                const dist = Math.sqrt(dX * dX + dY * dY) * 0.25;
                const prevDX = pp2.x - pp1.x, prevDY = pp2.y - pp1.y;
                const prevDist = Math.sqrt(prevDX * prevDX + prevDY * prevDY) * 0.25;

                const cY = (p2.y + p1.y) * 0.125;
                const prevCY = (pp2.y + pp1.y) * 0.125;
                const angle = Math.atan2(dY, dX);
                const prevAngle = Math.atan2(prevDY, prevDX);

                const evt = h['_touchPinchMoveEvt'];
                evt.distance.startPosition.x = 0;
                evt.distance.startPosition.y = prevDist;
                evt.distance.endPosition.x = 0;
                evt.distance.endPosition.y = dist;
                evt.angleAndHeight.startPosition.x = prevAngle;
                evt.angleAndHeight.startPosition.y = prevCY;
                evt.angleAndHeight.endPosition.x = angle;
                evt.angleAndHeight.endPosition.y = cY;

                (pinchAction as (e: PinchMovementEvent) => void)(evt);
            }
        }
    }
}
