// ============================================================
// camera-3d/ScreenSpaceCameraController.ts — 屏幕空间相机控制器
//
// 移植自 Cesium ScreenSpaceCameraController.js
// 层级：L3（依赖 L0 input 和同包 Camera3D、CameraEventAggregator）
// 职责：处理聚合输入事件并更新相机状态（旋转、缩放、倾斜、自由视角）
// ============================================================

import type { Cartesian2 } from '../../core/src/input/ScreenSpaceEventHandler.ts';
import { KeyboardEventModifier } from '../../core/src/input/KeyboardEventModifier.ts';
import { CameraEventAggregator, type Movement } from './CameraEventAggregator.ts';
import { CameraEventType } from './CameraEventType.ts';
import type { Camera3D } from './Camera3D.ts';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 事件类型绑定：可以是单个 CameraEventType 或带修饰键的组合或数组 */
export type EventTypeBinding =
    | CameraEventType
    | { eventType: CameraEventType; modifier: KeyboardEventModifier }
    | (CameraEventType | { eventType: CameraEventType; modifier: KeyboardEventModifier })[];

/** 惯性运动状态 */
interface InertiaMovementState {
    startPosition: Cartesian2;
    endPosition: Cartesian2;
    motion: Cartesian2;
    inertiaEnabled: boolean;
}

/** 控制器构造选项 */
export interface ScreenSpaceCameraControllerOptions {
    /** 目标 Canvas 元素 */
    canvas: HTMLElement;
    /** Camera3D 实例 */
    camera: Camera3D;
    /** 椭球拾取：屏幕坐标 → ECEF 位置（命中返回 Float64Array，未命中返回 null） */
    pickEllipsoid: (screenX: number, screenY: number) => Float64Array | null;
    /** 获取视口尺寸 */
    getViewport: () => { width: number; height: number };
}

// ---------------------------------------------------------------------------
// 常量（与 Cesium 对齐）
// ---------------------------------------------------------------------------

/** 惯性衰减计算 */
function decay(time: number, coefficient: number): number {
    if (time < 0) return 0;
    const tau = (1 - coefficient) * 25;
    return Math.exp(-tau * time);
}

/** 惯性触发的最大点击时长阈值（秒） */
const INERTIA_MAX_CLICK_TIME = 0.4;

/** 最小旋转速率 */
const MIN_ROTATE_RATE = 1 / 5000;
/** 最大旋转速率 */
const MAX_ROTATE_RATE = 100;
/** 最小缩放速率 */
const MIN_ZOOM_RATE = 20;
/** 最大缩放速率 */
const MAX_ZOOM_RATE = 5906376272000; // Cesium _maximumZoomRate

/** WGS84 半长轴 */
const WGS84_A = 6378137.0;

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// ScreenSpaceCameraController
// ---------------------------------------------------------------------------

/**
 * 屏幕空间相机控制器。
 *
 * 每帧调用 `update()` 方法，自动从 {@link CameraEventAggregator} 读取输入，
 * 根据配置的事件映射分发到旋转、缩放、倾斜或自由视角操作。
 *
 * 移植自 Cesium `ScreenSpaceCameraController`，架构完全一致：
 * - 可配置事件映射（`rotateEventTypes`, `zoomEventTypes` 等）
 * - 惯性系统（`inertiaSpin`, `inertiaZoom`）
 * - 高度感知交互模式切换（`spin3D` 调度器）
 * - 碰撞检测与缩放距离约束
 */
export class ScreenSpaceCameraController {
    // ═══ 公开配置（与 Cesium 一致）═══

    /** 全局输入开关 */
    enableInputs = true;
    /** 是否允许旋转/轨道 */
    enableRotate = true;
    /** 是否允许缩放 */
    enableZoom = true;
    /** 是否允许倾斜 */
    enableTilt = true;
    /** 是否允许自由视角 */
    enableLook = true;

    /** 旋转/轨道事件绑定 */
    rotateEventTypes: EventTypeBinding = CameraEventType.LEFT_DRAG;
    /** 缩放事件绑定 */
    zoomEventTypes: EventTypeBinding = [
        CameraEventType.RIGHT_DRAG,
        CameraEventType.WHEEL,
        CameraEventType.PINCH,
    ];
    /** 倾斜事件绑定 */
    tiltEventTypes: EventTypeBinding = [
        CameraEventType.MIDDLE_DRAG,
        { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
        { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
    ];
    /** 自由视角事件绑定 */
    lookEventTypes: EventTypeBinding = {
        eventType: CameraEventType.LEFT_DRAG,
        modifier: KeyboardEventModifier.SHIFT,
    };

    /** 旋转惯性系数 [0, 1)，越大滑行越远 */
    inertiaSpin = 0.9;
    /** 缩放惯性系数 [0, 1) */
    inertiaZoom = 0.8;

    /** 每帧最大移动比例（占窗口宽/高百分比） */
    maximumMovementRatio = 0.1;

    /** 最小缩放距离（米） */
    minimumZoomDistance = 1.0;
    /** 最大缩放距离（米） */
    maximumZoomDistance = Infinity;
    /** 缩放速度系数 */
    zoomFactor = 5.0;

    /** 碰撞检测开关 */
    enableCollisionDetection = true;

    /** 高空 trackball 切换高度（米） */
    minimumTrackBallHeight = 7_500_000;
    /** 地形拾取最低高度（米） */
    minimumPickingTerrainHeight = 150_000;

    // ═══ 内部状态 ═══

    _aggregator: CameraEventAggregator;
    private _camera: Camera3D;
    private _pickEllipsoid: (sx: number, sy: number) => Float64Array | null;
    private _getViewport: () => { width: number; height: number };

    /** 旋转速率因子 */
    private _rotateFactor = 0;
    private _rotateRateRangeAdjustment = 0;

    /** 惯性状态 */
    private _lastInertiaSpinMovement: InertiaMovementState | undefined;
    private _lastInertiaZoomMovement: InertiaMovementState | undefined;
    private _lastInertiaTiltMovement: InertiaMovementState | undefined;

    /** spin3D 状态追踪 */
    private _rotateMousePosition: Cartesian2 = { x: -1, y: -1 };
    private _looking = false;
    private _rotating = false;

    /** 惯性互斥表（与 Cesium 一致：缩放禁用旋转/倾斜惯性） */
    private _inertiaDisablers: Record<string, string[]> = {
        _lastInertiaZoomMovement: ['_lastInertiaSpinMovement', '_lastInertiaTiltMovement'],
        _lastInertiaSpinMovement: ['_lastInertiaZoomMovement'],
        _lastInertiaTiltMovement: ['_lastInertiaZoomMovement'],
    };

    private _destroyed = false;

    constructor(options: ScreenSpaceCameraControllerOptions) {
        this._camera = options.camera;
        this._pickEllipsoid = options.pickEllipsoid;
        this._getViewport = options.getViewport;
        this._aggregator = new CameraEventAggregator(options.canvas);
    }

    // ═══════════════════════════════════════════════════════════
    // 帧更新（与 Cesium update3D 对齐）
    // ═══════════════════════════════════════════════════════════

    /**
     * 每帧调用一次。从聚合器读取输入事件，分发到相应的相机操作。
     * 帧末自动重置聚合器。
     */
    update(): void {
        if (this._destroyed) return;

        // 计算 rotateRate（与 Cesium 一致）
        const radius = WGS84_A;
        this._rotateFactor = 1.0 / radius;
        this._rotateRateRangeAdjustment = radius;

        // 分发输入到动作
        this._reactToInput(
            this.enableRotate,
            this.rotateEventTypes,
            spin3D,
            this.inertiaSpin,
            '_lastInertiaSpinMovement',
        );
        this._reactToInput(
            this.enableZoom,
            this.zoomEventTypes,
            zoom3D,
            this.inertiaZoom,
            '_lastInertiaZoomMovement',
        );
        this._reactToInput(
            this.enableTilt,
            this.tiltEventTypes,
            tilt3D,
            this.inertiaSpin,
            '_lastInertiaTiltMovement',
        );
        this._reactToInput(
            this.enableLook,
            this.lookEventTypes,
            look3D,
            1.0, // no inertia for look
            undefined,
        );

        // 帧末重置
        this._aggregator.reset();
    }

    // ═══════════════════════════════════════════════════════════
    // reactToInput（与 Cesium 完全一致）
    // ═══════════════════════════════════════════════════════════

    private _reactToInput(
        enabled: boolean,
        eventTypes: EventTypeBinding | undefined,
        action: (controller: ScreenSpaceCameraController, startPosition: Cartesian2, movement: Movement) => void,
        inertiaConstant: number,
        inertiaStateName: string | undefined,
    ): void {
        if (!eventTypes) return;

        const aggregator = this._aggregator;
        const bindings: (CameraEventType | { eventType: CameraEventType; modifier: KeyboardEventModifier })[] =
            Array.isArray(eventTypes) ? eventTypes : [eventTypes as CameraEventType | { eventType: CameraEventType; modifier: KeyboardEventModifier }];

        for (const binding of bindings) {
            const type = typeof binding === 'number' ? binding : binding.eventType;
            const modifier = typeof binding === 'number' ? undefined : binding.modifier;

            const isMoving = aggregator.isMoving(type, modifier);
            const movement = isMoving ? aggregator.getMovement(type, modifier) : undefined;
            const startPosition = aggregator.getStartMousePosition(type, modifier);

            if (this.enableInputs && enabled) {
                if (movement) {
                    action(this, startPosition, movement);
                    this._activateInertia(inertiaStateName);
                } else if (inertiaConstant < 1.0 && inertiaStateName) {
                    maintainInertia(
                        aggregator,
                        type,
                        modifier,
                        inertiaConstant,
                        action,
                        this,
                        inertiaStateName,
                    );
                }
            }
        }
    }

    private _activateInertia(inertiaStateName: string | undefined): void {
        if (!inertiaStateName) return;

        // Re-enable inertia for this action
        const state = (this as unknown as Record<string, InertiaMovementState | undefined>)[inertiaStateName];
        if (state) state.inertiaEnabled = true;

        // Disable inertia on conflicting actions
        const disablers = this._inertiaDisablers[inertiaStateName];
        if (disablers) {
            for (const otherName of disablers) {
                const otherState = (this as unknown as Record<string, InertiaMovementState | undefined>)[otherName];
                if (otherState) otherState.inertiaEnabled = false;
            }
        }
    }

    isDestroyed(): boolean {
        return this._destroyed;
    }

    destroy(): void {
        this._aggregator.destroy();
        this._destroyed = true;
    }
}

// ═══════════════════════════════════════════════════════════════
// maintainInertia（与 Cesium 完全一致的惯性系统）
// ═══════════════════════════════════════════════════════════════

function maintainInertia(
    aggregator: CameraEventAggregator,
    type: CameraEventType,
    modifier: KeyboardEventModifier | undefined,
    decayCoef: number,
    action: (c: ScreenSpaceCameraController, s: Cartesian2, m: Movement) => void,
    controller: ScreenSpaceCameraController,
    inertiaStateName: string,
): void {
    const record = controller as unknown as Record<string, InertiaMovementState | undefined>;
    let movementState = record[inertiaStateName];
    if (!movementState) {
        movementState = record[inertiaStateName] = {
            startPosition: { x: 0, y: 0 },
            endPosition: { x: 0, y: 0 },
            motion: { x: 0, y: 0 },
            inertiaEnabled: true,
        };
    }

    const ts = aggregator.getButtonPressTime(type, modifier);
    const tr = aggregator.getButtonReleaseTime(type, modifier);

    if (!ts || !tr) return;

    const threshold = (tr - ts) / 1000;
    const fromNow = (performance.now() - tr) / 1000;

    if (threshold < INERTIA_MAX_CLICK_TIME) {
        const d = decay(fromNow, decayCoef);

        const lastMovement = aggregator.getLastMovement(type, modifier);
        if (!lastMovement || !movementState.inertiaEnabled) return;

        // 检查 lastMovement 的起终位置是否相同
        const eps = 1e-14;
        const dx = lastMovement.startPosition.x - lastMovement.endPosition.x;
        const dy = lastMovement.startPosition.y - lastMovement.endPosition.y;
        if (Math.abs(dx) < eps && Math.abs(dy) < eps) return;

        movementState.motion.x = (lastMovement.endPosition.x - lastMovement.startPosition.x) * 0.5;
        movementState.motion.y = (lastMovement.endPosition.y - lastMovement.startPosition.y) * 0.5;

        movementState.startPosition.x = lastMovement.startPosition.x;
        movementState.startPosition.y = lastMovement.startPosition.y;

        movementState.endPosition.x = movementState.startPosition.x + movementState.motion.x * d;
        movementState.endPosition.y = movementState.startPosition.y + movementState.motion.y * d;

        // 衰减接近零时停止
        if (
            isNaN(movementState.endPosition.x) ||
            isNaN(movementState.endPosition.y)
        ) return;
        const distSq = (movementState.endPosition.x - movementState.startPosition.x) ** 2 +
                       (movementState.endPosition.y - movementState.startPosition.y) ** 2;
        if (distSq < 0.25) return;

        if (!aggregator.isButtonDown(type, modifier)) {
            const startPosition = aggregator.getStartMousePosition(type, modifier);
            action(controller, startPosition, movementState);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// spin3D — 旋转/轨道调度器（与 Cesium 对齐）
// ═══════════════════════════════════════════════════════════════

function spin3D(
    controller: ScreenSpaceCameraController,
    startPosition: Cartesian2,
    movement: Movement,
): void {
    const camera = controller['_camera'];

    // 继续上一帧的模式
    if (startPosition.x === controller['_rotateMousePosition'].x &&
        startPosition.y === controller['_rotateMousePosition'].y) {
        if (controller['_looking']) {
            look3D(controller, startPosition, movement);
            return;
        }
        if (controller['_rotating']) {
            rotate3D(controller, startPosition, movement);
            return;
        }
        // 默认继续 rotate3D
        rotate3D(controller, startPosition, movement);
        return;
    }

    // 新的拖拽开始：重置模式
    controller['_looking'] = false;
    controller['_rotating'] = false;

    const pos = camera.getPosition();
    const height = pos.alt;

    // 尝试在椭球上拾取
    const picked = controller['_pickEllipsoid'](movement.startPosition.x, movement.startPosition.y);

    if (picked) {
        // 可以拾取到球面：使用 rotate3D
        rotate3D(controller, startPosition, movement);
    } else if (height > controller.minimumTrackBallHeight) {
        // 高空且未拾取：trackball 模式
        controller['_rotating'] = true;
        rotate3D(controller, startPosition, movement);
    } else {
        // 无法拾取且不够高：自由视角
        controller['_looking'] = true;
        look3D(controller, startPosition, movement);
    }

    controller['_rotateMousePosition'].x = startPosition.x;
    controller['_rotateMousePosition'].y = startPosition.y;
}

// ═══════════════════════════════════════════════════════════════
// rotate3D — 旋转/轨道（与 Cesium rotate3D 完全一致）
// ═══════════════════════════════════════════════════════════════

function rotate3D(
    controller: ScreenSpaceCameraController,
    _startPosition: Cartesian2,
    movement: Movement,
): void {
    const camera = controller['_camera'];
    const vp = controller['_getViewport']();
    const w = Math.max(vp.width, 1);
    const h = Math.max(vp.height, 1);

    // 计算 rotateRate（与 Cesium 一致）
    const pos = camera.getPosition();
    // rho ≈ WGS84_A + altitude
    const rho = WGS84_A + pos.alt;
    let rotateRate = controller['_rotateFactor'] * (rho - controller['_rotateRateRangeAdjustment']);
    rotateRate = clamp(rotateRate, MIN_ROTATE_RATE, MAX_ROTATE_RATE);

    // 计算屏幕位移比（Cesium: start - end）
    let phiWindowRatio = (movement.startPosition.x - movement.endPosition.x) / w;
    let thetaWindowRatio = (movement.startPosition.y - movement.endPosition.y) / h;

    phiWindowRatio = Math.min(phiWindowRatio, controller.maximumMovementRatio);
    thetaWindowRatio = Math.min(thetaWindowRatio, controller.maximumMovementRatio);

    // 计算旋转角（Cesium 原始公式）
    const deltaPhi = rotateRate * phiWindowRatio * Math.PI * 2.0;
    const deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

    // 应用旋转（constrainedAxis = UNIT_Z，与 Cesium 一致）
    if (Math.abs(deltaPhi) > 1e-10) {
        camera.rotateHorizontal(deltaPhi);
    }
    if (Math.abs(deltaTheta) > 1e-10) {
        camera.rotateVertical(deltaTheta);
    }
}

// ═══════════════════════════════════════════════════════════════
// zoom3D — 缩放（与 Cesium handleZoom 对齐）
// ═══════════════════════════════════════════════════════════════

function zoom3D(
    controller: ScreenSpaceCameraController,
    _startPosition: Cartesian2,
    movement: Movement,
): void {
    const camera = controller['_camera'];
    const pos = camera.getPosition();
    const distanceMeasure = pos.alt;

    handleZoom(controller, movement, controller.zoomFactor, distanceMeasure);
}

function handleZoom(
    controller: ScreenSpaceCameraController,
    movement: Movement,
    zoomFactor: number,
    distanceMeasure: number,
): void {
    const camera = controller['_camera'];
    const vp = controller['_getViewport']();

    const diff = movement.endPosition.y - movement.startPosition.y;

    // 接近表面时降低缩放速率
    const approachingSurface = diff > 0;
    const minHeight = approachingSurface ? controller.minimumZoomDistance : 0;
    const maxHeight = controller.maximumZoomDistance;

    const minDistance = distanceMeasure - minHeight;
    let zoomRate = zoomFactor * minDistance;
    zoomRate = clamp(zoomRate, MIN_ZOOM_RATE, MAX_ZOOM_RATE);

    let rangeWindowRatio = diff / Math.max(vp.height, 1);
    rangeWindowRatio = Math.min(rangeWindowRatio, controller.maximumMovementRatio);
    let distance = zoomRate * rangeWindowRatio;

    // 强制约束
    if (controller.enableCollisionDetection) {
        if (distance > 0 && Math.abs(distanceMeasure - minHeight) < 1.0) return;
        if (distance < 0 && Math.abs(distanceMeasure - maxHeight) < 1.0) return;

        if (distanceMeasure - distance < minHeight) {
            distance = distanceMeasure - minHeight - 1.0;
        } else if (distanceMeasure - distance > maxHeight) {
            distance = distanceMeasure - maxHeight;
        }
    }

    if (Math.abs(distance) < 0.01) return;

    // 应用缩放：沿相机方向移动（修改高度）
    const pos = camera.getPosition();
    const newAlt = clamp(pos.alt - distance, controller.minimumZoomDistance, controller.maximumZoomDistance);
    camera.setPosition(pos.lon, pos.lat, newAlt);
}

// ═══════════════════════════════════════════════════════════════
// tilt3D — 倾斜（中键拖拽调节 bearing 和 pitch）
// ═══════════════════════════════════════════════════════════════

function tilt3D(
    controller: ScreenSpaceCameraController,
    _startPosition: Cartesian2,
    movement: Movement,
): void {
    const camera = controller['_camera'];
    const vp = controller['_getViewport']();
    const w = Math.max(vp.width, 1);
    const h = Math.max(vp.height, 1);

    // 水平移动 → bearing 变化
    const dxRatio = (movement.endPosition.x - movement.startPosition.x) / w;
    // 垂直移动 → pitch 变化
    const dyRatio = (movement.endPosition.y - movement.startPosition.y) / h;

    const orient = camera.getOrientation();

    // bearing: 水平像素差 → 弧度（full width = 2π）
    const deltaBearing = dxRatio * Math.PI * 2.0;
    // pitch: 垂直像素差 → 弧度（full height = π/2）
    const deltaPitch = -dyRatio * Math.PI * 0.5;

    const newBearing = orient.bearing + deltaBearing;
    // pitch 约束：内部 [-π/2, -0.01]，对应 CameraState [-89.4°, 0°]
    const newPitch = clamp(orient.pitch + deltaPitch, -Math.PI / 2, -0.01);

    camera.setOrientation(newBearing, newPitch, orient.roll);
}

// ═══════════════════════════════════════════════════════════════
// look3D — 自由视角（Shift+拖拽改变视线方向，不改变位置）
// ═══════════════════════════════════════════════════════════════

function look3D(
    controller: ScreenSpaceCameraController,
    _startPosition: Cartesian2,
    movement: Movement,
): void {
    const camera = controller['_camera'];
    const vp = controller['_getViewport']();
    const w = Math.max(vp.width, 1);
    const h = Math.max(vp.height, 1);

    // 水平 → bearing
    const dxRatio = (movement.endPosition.x - movement.startPosition.x) / w;
    // 垂直 → pitch
    const dyRatio = (movement.endPosition.y - movement.startPosition.y) / h;

    const orient = camera.getOrientation();

    const deltaBearing = dxRatio * Math.PI;
    const deltaPitch = -dyRatio * Math.PI * 0.5;

    const newBearing = orient.bearing + deltaBearing;
    const newPitch = clamp(orient.pitch + deltaPitch, -Math.PI / 2, -0.01);

    camera.setOrientation(newBearing, newPitch, orient.roll);
}
