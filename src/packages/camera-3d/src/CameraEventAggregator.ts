// ============================================================
// camera-3d/CameraEventAggregator.ts — 相机事件聚合器
//
// 移植自 Cesium CameraEventAggregator.js
// 层级：L3（依赖 L0 ScreenSpaceEventHandler）
// 职责：将帧间多次 DOM 事件聚合为单个 Movement，供 ScreenSpaceCameraController 消费
// ============================================================

import {
    ScreenSpaceEventHandler,
    type Cartesian2,
    type PositionedEvent,
    type MovementEvent,
    type PinchStartEvent,
    type PinchMovementEvent,
} from '../../core/src/input/ScreenSpaceEventHandler.ts';
import { ScreenSpaceEventType } from '../../core/src/input/ScreenSpaceEventType.ts';
import { KeyboardEventModifier } from '../../core/src/input/KeyboardEventModifier.ts';
import { CameraEventType } from './CameraEventType.ts';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 聚合后的移动事件 */
export interface Movement {
    startPosition: Cartesian2;
    endPosition: Cartesian2;
}

/** 上一帧的移动记录（含有效标记） */
export interface LastMovement extends Movement {
    valid: boolean;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function getKey(type: CameraEventType, modifier?: KeyboardEventModifier): string {
    let key = `${type}`;
    if (modifier !== undefined) {
        key += `+${modifier}`;
    }
    return key;
}

function newC2(x = 0, y = 0): Cartesian2 {
    return { x, y };
}

function cloneC2(src: Cartesian2, dst: Cartesian2): void {
    dst.x = src.x;
    dst.y = src.y;
}

/** Cesium 滚轮 delta → 弧长换算系数 */
const WHEEL_DELTA_TO_ARC = 7.5 * (Math.PI / 180);

/** 所有修饰键值 */
const ALL_MODIFIERS: (KeyboardEventModifier | undefined)[] = [
    undefined,
    KeyboardEventModifier.SHIFT,
    KeyboardEventModifier.CTRL,
    KeyboardEventModifier.ALT,
];

/** 所有拖拽类型 */
const DRAG_TYPES: CameraEventType[] = [
    CameraEventType.LEFT_DRAG,
    CameraEventType.RIGHT_DRAG,
    CameraEventType.MIDDLE_DRAG,
];

/** CameraEventType → ScreenSpaceEventType down/up 映射 */
function dragToDownUp(type: CameraEventType): [ScreenSpaceEventType, ScreenSpaceEventType] | null {
    if (type === CameraEventType.LEFT_DRAG) return [ScreenSpaceEventType.LEFT_DOWN, ScreenSpaceEventType.LEFT_UP];
    if (type === CameraEventType.RIGHT_DRAG) return [ScreenSpaceEventType.RIGHT_DOWN, ScreenSpaceEventType.RIGHT_UP];
    if (type === CameraEventType.MIDDLE_DRAG) return [ScreenSpaceEventType.MIDDLE_DOWN, ScreenSpaceEventType.MIDDLE_UP];
    return null;
}

// ---------------------------------------------------------------------------
// CameraEventAggregator
// ---------------------------------------------------------------------------

/**
 * 相机事件聚合器。
 *
 * 将帧间发生的多个 DOM 输入事件聚合为每帧一个 {@link Movement}（包含起始位置和结束位置）。
 * 供 {@link ScreenSpaceCameraController} 在其 `update()` 中查询。
 *
 * 移植自 Cesium `CameraEventAggregator`，保持完全一致的语义：
 * - 按 `(CameraEventType, KeyboardEventModifier)` 组合键追踪状态
 * - `_update[key] === false` 表示本帧有新事件
 * - `isMoving()` / `getMovement()` / `getLastMovement()` 查询接口
 * - `reset()` 在帧末重置 `_update` 标记
 */
export class CameraEventAggregator {
    _eventHandler: ScreenSpaceEventHandler;

    /** 本帧是否已消费（true=空闲，false=有事件待处理） */
    _update: Record<string, boolean> = {};
    /** 当前帧聚合移动 */
    _movement: Record<string, Movement> = {};
    /** 上一帧移动（供惯性使用） */
    _lastMovement: Record<string, LastMovement> = {};
    /** 按键按下状态 */
    _isDown: Record<string, boolean> = {};
    /** 按键按下时的起始屏幕坐标 */
    _eventStartPosition: Record<string, Cartesian2> = {};
    /** 按键按下时间戳 */
    _pressTime: Record<string, number> = {};
    /** 按键释放时间戳 */
    _releaseTime: Record<string, number> = {};
    /** 当前按下的按钮数 */
    _buttonsDown = 0;
    /** 当前鼠标位置 */
    _currentMousePosition: Cartesian2 = newC2();

    private _destroyed = false;

    constructor(canvas: HTMLElement) {
        this._eventHandler = new ScreenSpaceEventHandler(canvas);

        // 为所有修饰键组合注册监听
        for (const mod of ALL_MODIFIERS) {
            this._listenToWheel(mod);
            this._listenToPinch(mod);
            for (const dragType of DRAG_TYPES) {
                this._listenMouseButtonDownUp(mod, dragType);
            }
            this._listenMouseMove(mod);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 公开查询 API（与 Cesium 一致）
    // ═══════════════════════════════════════════════════════════

    /** 本帧是否有该类型的移动事件 */
    isMoving(type: CameraEventType, modifier?: KeyboardEventModifier): boolean {
        return !this._update[getKey(type, modifier)];
    }

    /** 获取本帧聚合的移动 */
    getMovement(type: CameraEventType, modifier?: KeyboardEventModifier): Movement | undefined {
        return this._movement[getKey(type, modifier)];
    }

    /** 获取上一帧的移动（供惯性计算） */
    getLastMovement(type: CameraEventType, modifier?: KeyboardEventModifier): LastMovement | undefined {
        const lm = this._lastMovement[getKey(type, modifier)];
        return lm?.valid ? lm : undefined;
    }

    /** 按钮是否处于按下状态 */
    isButtonDown(type: CameraEventType, modifier?: KeyboardEventModifier): boolean {
        return !!this._isDown[getKey(type, modifier)];
    }

    /** 获取拖拽开始时的鼠标位置 */
    getStartMousePosition(type: CameraEventType, modifier?: KeyboardEventModifier): Cartesian2 {
        if (type === CameraEventType.WHEEL) {
            return this._currentMousePosition;
        }
        return this._eventStartPosition[getKey(type, modifier)] ?? this._currentMousePosition;
    }

    /** 获取按钮按下时间 */
    getButtonPressTime(type: CameraEventType, modifier?: KeyboardEventModifier): number {
        return this._pressTime[getKey(type, modifier)] ?? 0;
    }

    /** 获取按钮释放时间 */
    getButtonReleaseTime(type: CameraEventType, modifier?: KeyboardEventModifier): number {
        return this._releaseTime[getKey(type, modifier)] ?? 0;
    }

    /** 是否有任何按钮按下 */
    get anyButtonDown(): boolean {
        const wheelMoved =
            !this._update[getKey(CameraEventType.WHEEL)] ||
            !this._update[getKey(CameraEventType.WHEEL, KeyboardEventModifier.SHIFT)] ||
            !this._update[getKey(CameraEventType.WHEEL, KeyboardEventModifier.CTRL)] ||
            !this._update[getKey(CameraEventType.WHEEL, KeyboardEventModifier.ALT)];
        return this._buttonsDown > 0 || wheelMoved;
    }

    /** 当前鼠标位置 */
    get currentMousePosition(): Cartesian2 {
        return this._currentMousePosition;
    }

    /** 帧末重置所有 update 标记 */
    reset(): void {
        for (const key in this._update) {
            this._update[key] = true;
        }
    }

    isDestroyed(): boolean {
        return this._destroyed;
    }

    destroy(): void {
        this._eventHandler.destroy();
        this._destroyed = true;
    }

    // ═══════════════════════════════════════════════════════════
    // 内部：事件注册
    // ═══════════════════════════════════════════════════════════

    /** 监听滚轮事件 */
    private _listenToWheel(modifier?: KeyboardEventModifier): void {
        const key = getKey(CameraEventType.WHEEL, modifier);
        this._update[key] = true;

        if (!this._movement[key]) {
            this._movement[key] = { startPosition: newC2(), endPosition: newC2() };
        }
        if (!this._lastMovement[key]) {
            this._lastMovement[key] = { startPosition: newC2(), endPosition: newC2(), valid: false };
        }

        const movement = this._movement[key];
        const lastMovement = this._lastMovement[key];

        this._eventHandler.setInputAction(
            (delta: number) => {
                const arcLength = WHEEL_DELTA_TO_ARC * delta;
                this._pressTime[key] = this._releaseTime[key] = performance.now();
                movement.endPosition.x = 0;
                movement.endPosition.y = arcLength;
                cloneC2(movement.endPosition, lastMovement.endPosition);
                lastMovement.valid = true;
                this._update[key] = false;
            },
            ScreenSpaceEventType.WHEEL,
            modifier,
        );
    }

    /** 监听双指缩放 */
    private _listenToPinch(modifier?: KeyboardEventModifier): void {
        const key = getKey(CameraEventType.PINCH, modifier);
        this._update[key] = true;
        this._isDown[key] = false;
        this._eventStartPosition[key] = newC2();

        if (!this._movement[key]) {
            this._movement[key] = { startPosition: newC2(), endPosition: newC2() };
        }
        if (!this._lastMovement[key]) {
            this._lastMovement[key] = { startPosition: newC2(), endPosition: newC2(), valid: false };
        }

        this._eventHandler.setInputAction(
            (event: PinchStartEvent) => {
                this._buttonsDown++;
                this._isDown[key] = true;
                this._pressTime[key] = performance.now();
                // 存储双指中心点作为起始位置
                this._eventStartPosition[key] = {
                    x: (event.position1.x + event.position2.x) * 0.5,
                    y: (event.position1.y + event.position2.y) * 0.5,
                };
            },
            ScreenSpaceEventType.PINCH_START,
            modifier,
        );

        this._eventHandler.setInputAction(
            () => {
                this._buttonsDown = Math.max(this._buttonsDown - 1, 0);
                this._isDown[key] = false;
                this._releaseTime[key] = performance.now();
            },
            ScreenSpaceEventType.PINCH_END,
            modifier,
        );

        this._eventHandler.setInputAction(
            (pinchMovement: PinchMovementEvent) => {
                if (this._isDown[key]) {
                    // 简化 pinch：将距离变化转换为 y 轴移动
                    const movement = this._movement[key];
                    const lastMovement = this._lastMovement[key];
                    if (!this._update[key]) {
                        movement.endPosition.y = pinchMovement.distance.endPosition.y;
                    } else {
                        cloneC2(movement.startPosition, lastMovement.startPosition);
                        cloneC2(movement.endPosition, lastMovement.endPosition);
                        lastMovement.valid = true;
                        movement.startPosition.x = 0;
                        movement.startPosition.y = pinchMovement.distance.startPosition.y;
                        movement.endPosition.x = 0;
                        movement.endPosition.y = pinchMovement.distance.endPosition.y;
                        this._update[key] = false;
                    }
                }
            },
            ScreenSpaceEventType.PINCH_MOVE,
            modifier,
        );
    }

    /** 监听鼠标按键按下/抬起 */
    private _listenMouseButtonDownUp(modifier: KeyboardEventModifier | undefined, type: CameraEventType): void {
        const key = getKey(type, modifier);
        const mapping = dragToDownUp(type);
        if (!mapping) return;
        const [downType, upType] = mapping;

        this._isDown[key] = false;
        this._eventStartPosition[key] = newC2();

        if (!this._lastMovement[key]) {
            this._lastMovement[key] = { startPosition: newC2(), endPosition: newC2(), valid: false };
        }

        this._eventHandler.setInputAction(
            (event: PositionedEvent) => {
                this._buttonsDown++;
                this._lastMovement[key].valid = false;
                this._isDown[key] = true;
                this._pressTime[key] = performance.now();
                cloneC2(event.position, this._eventStartPosition[key]);
            },
            downType,
            modifier,
        );

        this._eventHandler.setInputAction(
            () => {
                // 释放时取消所有修饰键变体的按下状态
                this._cancelMouseDown(getKey(type, undefined));
                for (const mod of [KeyboardEventModifier.SHIFT, KeyboardEventModifier.CTRL, KeyboardEventModifier.ALT]) {
                    this._cancelMouseDown(getKey(type, mod));
                }
            },
            upType,
            modifier,
        );
    }

    private _cancelMouseDown(cancelKey: string): void {
        if (this._isDown[cancelKey]) {
            this._buttonsDown = Math.max(this._buttonsDown - 1, 0);
        }
        this._isDown[cancelKey] = false;
        this._releaseTime[cancelKey] = performance.now();
    }

    /** 监听鼠标移动（为所有拖拽类型聚合） */
    private _listenMouseMove(modifier?: KeyboardEventModifier): void {
        // 为所有 CameraEventType 初始化 update/movement
        for (const typeName of Object.keys(CameraEventType) as (keyof typeof CameraEventType)[]) {
            const type = CameraEventType[typeName];
            const key = getKey(type, modifier);
            this._update[key] = true;
            if (!this._lastMovement[key]) {
                this._lastMovement[key] = { startPosition: newC2(), endPosition: newC2(), valid: false };
            }
            if (!this._movement[key]) {
                this._movement[key] = { startPosition: newC2(), endPosition: newC2() };
            }
        }

        this._eventHandler.setInputAction(
            (mouseMovement: MovementEvent) => {
                for (const typeName of Object.keys(CameraEventType) as (keyof typeof CameraEventType)[]) {
                    const type = CameraEventType[typeName];
                    const key = getKey(type, modifier);

                    if (this._isDown[key]) {
                        const movement = this._movement[key];
                        const lastMovement = this._lastMovement[key];
                        if (!this._update[key]) {
                            // 同帧多次移动：只更新 endPosition
                            cloneC2(mouseMovement.endPosition, movement.endPosition);
                        } else {
                            // 新帧第一次移动：保存上帧，记录新帧
                            cloneC2(movement.startPosition, lastMovement.startPosition);
                            cloneC2(movement.endPosition, lastMovement.endPosition);
                            lastMovement.valid = true;
                            cloneC2(mouseMovement.startPosition, movement.startPosition);
                            cloneC2(mouseMovement.endPosition, movement.endPosition);
                            this._update[key] = false;
                        }
                    }
                }

                cloneC2(mouseMovement.endPosition, this._currentMousePosition);
            },
            ScreenSpaceEventType.MOUSE_MOVE,
            modifier,
        );
    }
}
