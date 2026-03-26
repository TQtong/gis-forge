/**
 * @module preset-3d/globe-interaction
 * @description
 * 指针设备与滚轮到 {@link import('../../camera-3d/src/Camera3D.ts').Camera3D} 的映射，以及 **2D↔3D morph** 状态机（当前仅事件与计时，渲染路径仍以 3D globe 为主）。
 *
 * @stability experimental
 */

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import {
    ROTATE_SENSITIVITY,
    ZOOM_SENSITIVITY,
} from './globe-constants.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';

/**
 * 工厂：返回一组可绑定到 DOM 的事件处理器；闭包捕获 `camera3D` 与可变 `state`。
 *
 * @param camera3D - 接收 pan / rotate / zoom
 * @param options - 功能开关：左键轨道、滚轮缩放、中键倾斜
 * @param state - 拖拽中与按钮 id；由本模块读写
 * @param lifecycle - `isDestroyed` 用于销毁后忽略回调
 * @returns `onMouseDown` / `onMouseMove` / `onMouseUp` / `onWheel` / `onContextMenu`
 *
 * @remarks
 * - 左键：`handlePanStart`/`Move`/`End`
 * - 中键：`handleRotate`（delta 来自 `movementX/Y × ROTATE_SENSITIVITY`）
 * - 滚轮：`handleZoom`（`deltaY × ZOOM_SENSITIVITY`）
 */
export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    options: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
    state: GlobeInteractionState,
    lifecycle: { isDestroyed: () => boolean },
): {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
} {
    const onMouseDown = (e: MouseEvent) => {
        if (lifecycle.isDestroyed()) { return; }

        if (e.button === 0 && options.enableRotate) {
            state.isDragging = true;
            state.dragButton = 0;
            camera3D.handlePanStart(e.clientX, e.clientY);
        } else if (e.button === 1 && options.enableTilt) {
            state.isDragging = true;
            state.dragButton = 1;
            e.preventDefault();
        }
    };

    const onMouseMove = (e: MouseEvent) => {
        if (!state.isDragging || lifecycle.isDestroyed()) { return; }

        if (state.dragButton === 0) {
            camera3D.handlePanMove(e.clientX, e.clientY);
        } else if (state.dragButton === 1) {
            const bearingDelta = e.movementX * ROTATE_SENSITIVITY;
            const pitchDelta = e.movementY * ROTATE_SENSITIVITY;
            camera3D.handleRotate(bearingDelta, pitchDelta);
        }
    };

    const onMouseUp = (_e: MouseEvent) => {
        if (!state.isDragging) { return; }

        if (state.dragButton === 0) {
            camera3D.handlePanEnd();
        }

        state.isDragging = false;
        state.dragButton = -1;
    };

    const onWheel = (e: WheelEvent) => {
        if (lifecycle.isDestroyed() || !options.enableZoom) { return; }

        e.preventDefault();

        const delta = -e.deltaY * ZOOM_SENSITIVITY;
        camera3D.handleZoom(delta, e.clientX, e.clientY);
    };

    const onContextMenu = (e: Event) => {
        e.preventDefault();
    };

    return { onMouseDown, onMouseMove, onMouseUp, onWheel, onContextMenu };
}

/**
 * 启动视图 morph：设置 `morphState` 时间戳并用 `requestAnimationFrame` 轮询直到 `t≥1`。
 *
 * @param morphState - 读写 `morphing` / 时间 / `viewMode` / `morphTarget`
 * @param target - 目标视图模式
 * @param durationMs - 动画时长（毫秒），下限 16ms
 * @param emit - 与 `Globe3D._emit` 兼容的 `(type, payload)`
 * @param isDestroyed - 为 true 时停止轮询
 *
 * @remarks
 * 若 `viewMode === target` 则立即返回；完成时 `viewMode = morphTarget` 并 `emit('morph:complete')`。
 */
export function runMorph(
    morphState: MorphState,
    target: '2d' | '25d' | '3d',
    durationMs: number,
    emit: (type: string, payload: unknown) => void,
    isDestroyed: () => boolean,
): void {
    if (morphState.viewMode === target) { return; }

    morphState.morphing = true;
    morphState.morphStartTime = performance.now();
    morphState.morphDuration = Math.max(durationMs, 16);
    morphState.morphTarget = target;

    emit('morph:start', { from: morphState.viewMode, to: target });

    const checkMorph = (): void => {
        if (isDestroyed() || !morphState.morphing) { return; }

        const elapsed = performance.now() - morphState.morphStartTime;
        const t = Math.min(elapsed / morphState.morphDuration, 1.0);

        if (t >= 1.0) {
            morphState.morphing = false;
            morphState.viewMode = morphState.morphTarget;
            emit('morph:complete', { mode: morphState.viewMode });
        } else {
            requestAnimationFrame(checkMorph);
        }
    };

    requestAnimationFrame(checkMorph);
}
