/**
 * @module preset-3d/globe-interaction
 * @description
 * Globe3D 交互功能模块。
 *
 * ## 架构重构：Cesium 三层事件架构
 *
 * 鼠标/触摸交互已迁移至 Cesium 标准三层架构：
 *
 * ```
 * ScreenSpaceEventHandler (L0)  — DOM 事件捕获与归一化
 *         ↓
 * CameraEventAggregator  (L3)  — 帧间事件聚合
 *         ↓
 * ScreenSpaceCameraController (L3) — 输入→相机动作分发 + 惯性
 * ```
 *
 * 本文件仅保留与相机交互无关的 morph（视图模式切换动画）。
 *
 * @stability experimental
 */

import type { MorphState } from './globe-types.ts';

// ═══════════════════════════════════════════════════════════════
// Morph（视图模式切换动画，与交互无关）
// ═══════════════════════════════════════════════════════════════

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

    const check = (): void => {
        if (isDestroyed() || !morphState.morphing) { return; }
        const t = Math.min(
            (performance.now() - morphState.morphStartTime) / morphState.morphDuration,
            1.0,
        );
        if (t >= 1.0) {
            morphState.morphing = false;
            morphState.viewMode = morphState.morphTarget;
            emit('morph:complete', { mode: morphState.viewMode });
        } else {
            requestAnimationFrame(check);
        }
    };
    requestAnimationFrame(check);
}
