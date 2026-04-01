/**
 * @module preset-3d/globe-interaction
 * @description
 * Globe3D 鼠标左键拖拽旋转地球。
 *
 * ## 架构：移植 CesiumJS `rotate3D`（屏幕空间旋转 + constrainedAxis = UNIT_Z）
 *
 * **关键发现**：Cesium 在 `CesiumWidget.js:333` 设置了
 * `camera.constrainedAxis = Cartesian3.UNIT_Z`，
 * 因此 3D 地球的默认拖拽走的是 `rotate3D`（而非 `pan3D` unconstrained），核心逻辑为：
 *
 * ```js
 * // ScreenSpaceCameraController.js rotate3D (lines 2025-2088)
 * deltaPhi   = rotateRate × (startPos.x - endPos.x) / canvasWidth  × 2π   // 水平
 * deltaTheta = rotateRate × (startPos.y - endPos.y) / canvasHeight × π    // 垂直
 * camera.rotateRight(deltaPhi)   // → 绕 constrainedAxis (UNIT_Z) 旋转
 * camera.rotateUp(deltaTheta)    // → 绕切线轴旋转，极点前自动 clamp
 * ```
 *
 * 优势：
 * - 不需要 pickEllipsoid → 不需要 inverseVP → 无过期矩阵问题
 * - 不需要 cross product → 无极点退化
 * - constrainedAxis clamp → 相机永远不越过极点 → 无 ENU 翻转
 * - 极点处继续拖拽 → 只有水平分量生效 → 地球绕极轴"转圈"（和 Cesium 一致）
 *
 * @stability experimental
 */

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';

// ═══════════════════════════════════════════════════════════════
// 画布坐标
// ═══════════════════════════════════════════════════════════════

function canvasXY(e: MouseEvent, cvs: HTMLCanvasElement): [number, number] {
    const r = cvs.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
}

// ═══════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════

/**
 * 创建鼠标左键拖拽旋转地球的事件处理器。
 *
 * 移植自 Cesium `rotate3D`（constrainedAxis = UNIT_Z）：
 * 1. mousedown：记录屏幕坐标，测试球面命中
 * 2. mousemove：从屏幕像素位移计算 deltaPhi / deltaTheta
 *    - camera.rotateHorizontal(deltaPhi)  → 绕 Z 轴（永远稳定）
 *    - camera.rotateVertical(deltaTheta)  → 绕切线轴（极点 clamp）
 * 3. mouseup：结束拖拽
 */
export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    options: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
    state: GlobeInteractionState,
    lifecycle: { isDestroyed: () => boolean },
    pickGlobeECEF: (screenX: number, screenY: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    canvas: HTMLCanvasElement,
): {
    onMouseDown:   (e: MouseEvent) => void;
    onMouseMove:   (e: MouseEvent) => void;
    onMouseUp:     (e: MouseEvent) => void;
    onWheel:       (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
} {
    /** 上一帧鼠标画布坐标 */
    let lastSX = 0;
    let lastSY = 0;

    // ── mousedown ───────────────────────────────────────────────
    const onMouseDown = (e: MouseEvent): void => {
        if (lifecycle.isDestroyed() || e.button !== 0 || !options.enableRotate) {
            return;
        }
        const [sx, sy] = canvasXY(e, canvas);

        // 必须命中球面才进入拖拽
        const picked = pickGlobeECEF(sx, sy);
        if (!picked) { return; }

        state.isDragging = true;
        state.dragButton = 0;
        lastSX = sx;
        lastSY = sy;
    };

    // ── mousemove（核心：Cesium rotate3D 方案）────────────────────
    const onMouseMove = (e: MouseEvent): void => {
        if (lifecycle.isDestroyed() || !state.isDragging || state.dragButton !== 0) {
            return;
        }

        const [curSX, curSY] = canvasXY(e, canvas);
        const dx = curSX - lastSX;
        const dy = curSY - lastSY;

        // 亚像素噪声过滤
        if (dx * dx + dy * dy < 0.25) { return; }

        // ── Cesium rotate3D 核心算法 ──────────────────────────────
        //
        // Cesium 原文 (ScreenSpaceCameraController.js lines 2057-2068)：
        //   phiWindowRatio   = (startPos.x - endPos.x) / canvasWidth
        //   thetaWindowRatio = (startPos.y - endPos.y) / canvasHeight
        //   deltaPhi   = rotateRate × phiWindowRatio × 2π
        //   deltaTheta = rotateRate × thetaWindowRatio × π
        //
        // rotateRate = rotateFactor × (rho - rateAdjustment)
        // 简化：对于全球视图（高空），rotateRate ≈ 1.0

        const vp = getViewport();
        const w = Math.max(vp.width, 1);
        const h = Math.max(vp.height, 1);

        // Cesium: (start - end)，但我们的 rotateHorizontal/rotateVertical 内部已取反，
        // 所以这里用 (end - start) = (cur - last) 让两次取反抵消
        const phiRatio = (curSX - lastSX) / w;
        const thetaRatio = (curSY - lastSY) / h;

        // Cesium: rotateRate = controller._rotateFactor * (rho - adjustment)
        // 对于高空视图，rotateFactor ≈ 1/magnitude(position)，所以 rotateRate ≈ 1
        // 简化为常数 1.0（可后续按 Cesium 原始公式精确计算）
        const rotateRate = 1.0;

        const deltaPhi = rotateRate * phiRatio * Math.PI * 2.0;
        const deltaTheta = rotateRate * thetaRatio * Math.PI;

        // ── 应用旋转（constrainedAxis = UNIT_Z）──────────────────
        // rotateRight(deltaPhi) → 绕 Z 轴旋转，任何纬度都稳定
        if (Math.abs(deltaPhi) > 1e-10) {
            camera3D.rotateHorizontal(deltaPhi);
        }
        // rotateUp(deltaTheta) → 绕切线轴旋转，极点前 clamp
        if (Math.abs(deltaTheta) > 1e-10) {
            camera3D.rotateVertical(deltaTheta);
        }

        lastSX = curSX;
        lastSY = curSY;
    };

    // ── mouseup ─────────────────────────────────────────────────
    const onMouseUp = (_e: MouseEvent): void => {
        if (lifecycle.isDestroyed()) { return; }
        if (state.dragButton === 0) {
            state.isDragging = false;
            state.dragButton = -1;
        }
    };

    return {
        onMouseDown,
        onMouseMove,
        onMouseUp,
        onWheel:       (e: WheelEvent) => { e.preventDefault(); },
        onContextMenu: (e: Event)      => { e.preventDefault(); },
    };
}

// ═══════════════════════════════════════════════════════════════
// Morph（视图模式切换动画，与交互无关，原样保留）
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
