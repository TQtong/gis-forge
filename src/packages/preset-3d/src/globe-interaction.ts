// ============================================================
// globe-interaction.ts — 鼠标/触摸交互 → Camera3D 操作
// 对标：Cesium ScreenSpaceCameraController — spin3D / pan3D / rotate3D / zoom3D
// 职责：左键拖拽旋转（含极地穿越）、滚轮缩放（光标位置感知）、
//       中键 tilt3D（对标 Cesium MIDDLE_DRAG）、morph 动画。
// ============================================================

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import { eastNorthUpToFixedFrame } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';
import {
    _panEast, _panPlaneNormal, _panRejA, _panRejB,
    _panTmpA, _panTmpB, _panBasis1, _panBasis2,
    _zoomDir, _zoomUnitPos,
    _spinCurrentECEF,
    _tiltCenterECEF, _tiltENUMat, _tiltVerticalCenter, _tiltVerticalENUMat,
    _tiltTmpAxis, _tiltTangent, _tiltNegAxis, _tiltNormalUp,
} from './globe-buffers.ts';
import { geodeticToECEF, WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';

// ─── 常量 ────────────────────────────────────────────────────

/** 高空 trackball 阈值（米）。高于此高度且未命中球面时使用 rotate3D */
const TRACKBALL_HEIGHT = 7_500_000;

/** 缩放灵敏度因子 */
const ZOOM_FACTOR = 5.0;

/** 最小缩放高度（米），防止 zoomRate 为 0 */
const MIN_ZOOM_HEIGHT = 1.0;

/** 旋转速率因子（对标 Cesium _rotateFactor = 1/ellipsoid.radius） */
const ROTATE_FACTOR = 1.0 / WGS84_A;

/** 旋转速率范围调整 */
const ROTATE_RANGE_ADJUST = WGS84_A;

/** 最小旋转速率 */
const MIN_ROTATE_RATE = 1 / 5000;

/** 最大旋转速率 */
const MAX_ROTATE_RATE = 1.77;

/** tilt3D：高度高于此值使用 tilt3DOnEllipsoid，低于则用 tilt3DOnTerrain（对标 SSCC:246） */
const MINIMUM_COLLISION_TERRAIN_HEIGHT = 15_000;

/** tilt3D：高于此高度且未命中时切换到 look 模式（对标 SSCC:258-259） */
const MINIMUM_TRACKBALL_HEIGHT_TILT = WGS84_A * 0.75;

const EPSILON2 = 1e-2;
const EPSILON3 = 1e-3;
const EPSILON4 = 1e-4;
const EPSILON6 = 1e-6;
const UNIT_Z = new Float64Array([0, 0, 1]);

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** 最大仰角限制（对标 Cesium SSCC.maximumTiltAngle = PI/2 → 不允许翻过地平线） */
const MAXIMUM_TILT_ANGLE = HALF_PI;

/** maximumMovementRatio（对标 Cesium SSCC:272） */
const MAXIMUM_MOVEMENT_RATIO = 0.1;

// ─── Float64 向量工具 ────────────────────────────────────────

function v3Dot(a: Float64Array, b: Float64Array): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function v3Cross(out: Float64Array, a: Float64Array, b: Float64Array): void {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
}

function v3Length(a: Float64Array): number {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function v3Normalize(out: Float64Array, a: Float64Array): void {
    const len = v3Length(a);
    if (len < 1e-15) { out[0] = 0; out[1] = 0; out[2] = 1; return; }
    const inv = 1 / len;
    out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
}

function v3Sub(out: Float64Array, a: Float64Array, b: Float64Array): void {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
}

function v3Scale(out: Float64Array, a: Float64Array, s: number): void {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
}

function v3ScaleAndAdd(out: Float64Array, a: Float64Array, b: Float64Array, s: number): void {
    out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
}

function v3Copy(out: Float64Array, a: Float64Array): void {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
}

function v3Distance(a: Float64Array, b: Float64Array): number {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

/**
 * Cesium Cartesian3.mostOrthogonalAxis：找到与 v 最正交的标准轴，
 * 返回 cross(result, v) 归一化后的 basis1。
 */
function mostOrthogonalBasis(out: Float64Array, v: Float64Array): void {
    const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    // 选与 v 最正交的标准轴
    if (ax <= ay && ax <= az) {
        out[0] = 1; out[1] = 0; out[2] = 0;
    } else if (ay <= ax && ay <= az) {
        out[0] = 0; out[1] = 1; out[2] = 0;
    } else {
        out[0] = 0; out[1] = 0; out[2] = 1;
    }
    // basis1 = cross(out, v)  然后 normalize
    v3Cross(out, out, v);
    v3Normalize(out, out);
}

// ═══════════════════════════════════════════════════════════════
// pan3D — 极地穿越核心（对标 Cesium SSCC:2102-2311 with constrainedAxis）
// ═══════════════════════════════════════════════════════════════

function pan3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    sx: number,
    sy: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
): void {
    // ─── 关键：每帧用当前相机状态 pick 上一帧和当前帧的鼠标位置 ───
    // 对标 Cesium：p0 = pickEllipsoid(movement.startPosition)
    //             p1 = pickEllipsoid(movement.endPosition)
    // 这样每帧的 delta 都是小增量，不会累积错误。

    // ⚠ pickGlobe 返回共享 Float64Array 缓冲（_pickECEFBuf），
    // 第二次调用会覆盖第一次的结果。必须在第二次 pick 之前
    // 将 p0 的值复制到独立缓冲 _spinCurrentECEF 中。
    const p0Raw = pickGlobe(state.spinLastScreenX, state.spinLastScreenY);
    if (!p0Raw) {
        // 上一帧位置未命中球面 → 回退到屏幕空间旋转
        rotate3D(camera3D, state, sx, sy, getViewport);
        return;
    }

    // 复制到独立缓冲——防止第二次 pickGlobe 覆盖
    v3Copy(_spinCurrentECEF, p0Raw);

    const p1 = pickGlobe(sx, sy);
    if (!p1) {
        // 当前位置未命中球面 → 回退到屏幕空间旋转
        rotate3D(camera3D, state, sx, sy, getViewport);
        return;
    }

    // p0 = 上一帧交点（独立缓冲），p1 = 当前帧交点（共享缓冲但后续不再 pick）
    const p0 = _spinCurrentECEF;

    const axis = camera3D.getConstrainedAxis();
    if (!axis) return;

    // ─── basis0 = constrainedAxis ────────────────
    // basis1 = mostOrthogonalAxis cross
    mostOrthogonalBasis(_panBasis1, axis);
    // basis2 = cross(basis0, basis1)
    v3Cross(_panBasis2, axis, _panBasis1);

    // ─── p0 球坐标 (theta, phi) ──────────────────
    const startRho = v3Length(p0);
    const startDot = v3Dot(axis, p0);
    const startTheta = Math.acos(clamp(startDot / startRho, -1, 1));

    // startRej = p0 - startDot * axis
    v3Scale(_panRejA, axis, startDot);
    v3Sub(_panRejA, p0, _panRejA);
    v3Normalize(_panRejA, _panRejA);

    let startPhi = Math.acos(clamp(v3Dot(_panRejA, _panBasis1), -1, 1));
    if (v3Dot(_panRejA, _panBasis2) < 0) {
        startPhi = TWO_PI - startPhi;
    }

    // ─── p1 球坐标 (theta, phi) ──────────────────
    const endRho = v3Length(p1);
    const endDot = v3Dot(axis, p1);
    const endTheta = Math.acos(clamp(endDot / endRho, -1, 1));

    v3Scale(_panRejB, axis, endDot);
    v3Sub(_panRejB, p1, _panRejB);
    v3Normalize(_panRejB, _panRejB);

    let endPhi = Math.acos(clamp(v3Dot(_panRejB, _panBasis1), -1, 1));
    if (v3Dot(_panRejB, _panBasis2) < 0) {
        endPhi = TWO_PI - endPhi;
    }

    // ─── deltaPhi（水平旋转） ───────────────────
    const deltaPhi = startPhi - endPhi;

    // ─── 极地穿越检测（对标 Cesium SSCC:2276-2306）───
    const camPos = camera3D.getPositionECEF();

    // east = cross(axis, camera.position)
    // 若在极点（cross 退化），用 camera.right
    v3Cross(_panEast, axis, camPos);
    if (v3Length(_panEast) < 1e-10) {
        v3Copy(_panEast, camera3D.getRight());
    }

    // planeNormal = cross(axis, east)
    v3Cross(_panPlaneNormal, axis, _panEast);
    v3Normalize(_panPlaneNormal, _panPlaneNormal);

    v3Sub(_panTmpA, p0, axis);
    const side0 = v3Dot(_panPlaneNormal, _panTmpA);
    v3Sub(_panTmpA, p1, axis);
    const side1 = v3Dot(_panPlaneNormal, _panTmpA);

    let deltaTheta: number;
    if (side0 > 0 && side1 > 0) {
        // 同侧正常
        deltaTheta = endTheta - startTheta;
    } else if (side0 > 0 && side1 <= 0) {
        // 跨越检测
        if (v3Dot(camPos, axis) > 0) {
            // 北半球穿越
            deltaTheta = -startTheta - endTheta;
        } else {
            // 南半球穿越
            deltaTheta = startTheta + endTheta;
        }
    } else {
        deltaTheta = startTheta - endTheta;
    }

    // ─── 应用旋转 ──────────────────────────────
    camera3D.rotateRight(deltaPhi);
    camera3D.rotateUp(deltaTheta);
}

// ═══════════════════════════════════════════════════════════════
// rotate3D — 高空屏幕空间旋转（对标 Cesium SSCC:2025-2088）
// 含 maximumTiltAngle 约束
// ═══════════════════════════════════════════════════════════════

function rotate3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    sx: number,
    sy: number,
    getViewport: () => { width: number; height: number },
): void {
    const vp = getViewport();
    const dx = (state.spinLastScreenX - sx) / vp.width;
    const dy = (state.spinLastScreenY - sy) / vp.height;

    const camPos = camera3D.getPositionECEF();
    const rho = v3Length(camPos);
    let rotateRate = ROTATE_FACTOR * (rho - ROTATE_RANGE_ADJUST);
    rotateRate = clamp(rotateRate, MIN_ROTATE_RATE, MAX_ROTATE_RATE);

    const deltaPhi = rotateRate * dx * TWO_PI;
    let deltaTheta = rotateRate * dy * Math.PI;

    // ─── maximumTiltAngle 约束（对标 Cesium SSCC:2070-2077）───
    // tilt = PI - acos(dot(direction, constrainedAxis))
    // constrainedAxis 在世界空间中 = 地表法线 ≈ normalize(position)
    const constrainedAxis = camera3D.getConstrainedAxis();
    if (constrainedAxis) {
        const dir = camera3D.getDirection();
        const dotProduct = v3Dot(dir, constrainedAxis);
        const tilt = Math.PI - Math.acos(clamp(dotProduct, -1, 1)) + deltaTheta;
        if (tilt > MAXIMUM_TILT_ANGLE) {
            deltaTheta -= tilt - MAXIMUM_TILT_ANGLE;
        }
    }

    camera3D.rotateRight(deltaPhi);
    camera3D.rotateUp(deltaTheta);
}

// ═══════════════════════════════════════════════════════════════
// rotate3DLocal — ENU 局部空间旋转（对标 Cesium rotate3D with setTransform）
// camera 已经 setTransform 到 ENU，constrainedAxis = UNIT_Z
// ═══════════════════════════════════════════════════════════════

function rotate3DLocal(
    camera3D: Camera3D,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    getViewport: () => { width: number; height: number },
    constrainedAxis: Float64Array | undefined,
    rotateOnlyVertical: boolean,
    rotateOnlyHorizontal: boolean,
): void {
    const vp = getViewport();

    const camPos = camera3D.getPositionECEF();
    const rho = v3Length(camPos);

    // ENU 下使用单位球：rotateFactor=1, rangeAdjustment=1（对标 SSCC:2530-2533）
    let rotateRate = 1.0 * (rho - 1.0);
    if (rotateRate > MAX_ROTATE_RATE) rotateRate = MAX_ROTATE_RATE;
    if (rotateRate < MIN_ROTATE_RATE) rotateRate = MIN_ROTATE_RATE;

    let phiWindowRatio = (startSX - endSX) / vp.width;
    let thetaWindowRatio = (startSY - endSY) / vp.height;
    phiWindowRatio = Math.min(phiWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    thetaWindowRatio = Math.min(thetaWindowRatio, MAXIMUM_MOVEMENT_RATIO);

    const deltaPhi = rotateRate * phiWindowRatio * TWO_PI;
    let deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

    // ─── maximumTiltAngle 约束（对标 Cesium SSCC:2070-2077）───
    if (constrainedAxis) {
        const dir = camera3D.getDirection();
        const dotProduct = v3Dot(dir, constrainedAxis);
        const tilt = Math.PI - Math.acos(clamp(dotProduct, -1, 1)) + deltaTheta;
        if (tilt > MAXIMUM_TILT_ANGLE) {
            deltaTheta -= tilt - MAXIMUM_TILT_ANGLE;
        }
    }

    // 临时设置 constrainedAxis
    const oldAxis = camera3D.getConstrainedAxis();
    if (constrainedAxis) {
        camera3D.setConstrainedAxis(constrainedAxis);
    }

    if (!rotateOnlyVertical) {
        camera3D.rotateRight(deltaPhi);
    }
    if (!rotateOnlyHorizontal) {
        camera3D.rotateUp(deltaTheta);
    }

    // 恢复 constrainedAxis
    camera3D.setConstrainedAxis(oldAxis);
}

// ═══════════════════════════════════════════════════════════════
// look3D — 低空自由观察（仅旋转方向不动位置）
// ═══════════════════════════════════════════════════════════════

function look3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    sx: number,
    sy: number,
    getViewport: () => { width: number; height: number },
): void {
    const vp = getViewport();
    const dx = (state.spinLastScreenX - sx) / vp.width;
    const dy = (state.spinLastScreenY - sy) / vp.height;

    camera3D.look(camera3D.getUp(), -dx * Math.PI * 0.5);
    camera3D.look(camera3D.getRight(), -dy * Math.PI * 0.5);
}

// ═══════════════════════════════════════════════════════════════
// spin3D — 分发逻辑（对标 Cesium SSCC:1906-2023）
// ═══════════════════════════════════════════════════════════════

function spin3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    sx: number,
    sy: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
): void {
    // 连续拖拽中：保持当前模式
    if (state.spinStartScreenX === state.spinLastScreenX &&
        state.spinStartScreenY === state.spinLastScreenY) {
        // 这是第一帧移动，不是连续帧
    } else {
        // 连续帧：继续之前的模式
        if (state.spinning) {
            pan3D(camera3D, state, sx, sy, pickGlobe, getViewport);
            return;
        }
        if (state.rotating) {
            rotate3D(camera3D, state, sx, sy, getViewport);
            return;
        }
        if (state.looking) {
            look3D(camera3D, state, sx, sy, getViewport);
            return;
        }
    }

    // 新拖拽起始或第一帧：判断模式
    state.spinning = false;
    state.rotating = false;
    state.looking = false;

    if (state.spinStartECEF) {
        // 起始点命中球面 → pan3D
        state.spinning = true;
        pan3D(camera3D, state, sx, sy, pickGlobe, getViewport);
    } else {
        // 未命中球面
        const alt = camera3D.getPosition().alt;
        if (alt > TRACKBALL_HEIGHT) {
            state.rotating = true;
            rotate3D(camera3D, state, sx, sy, getViewport);
        } else {
            state.looking = true;
            look3D(camera3D, state, sx, sy, getViewport);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// zoom3D — 滚轮缩放（对标 Cesium SSCC:2318-2408 + handleZoom:559-677）
// ═══════════════════════════════════════════════════════════════

function zoom3D(
    camera3D: Camera3D,
    deltaY: number,
    sx: number,
    sy: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
): void {
    const camPos = camera3D.getPositionECEF();
    const hitECEF = pickGlobe(sx, sy);

    if (hitECEF) {
        // ─── 鼠标在球上：以鼠标位置为锚点缩放 ───
        const distance = v3Distance(camPos, hitECEF);

        // 速率调节（对标 Cesium handleZoom percentage）
        v3Normalize(_zoomUnitPos, camPos);
        const dirDot = Math.abs(v3Dot(_zoomUnitPos, camera3D.getDirection()));
        const percentage = clamp(dirDot, 0.25, 1.0);

        // 越近越慢
        const approachingSurface = deltaY > 0;
        const minDist = approachingSurface ? Math.max(distance * 0.01, MIN_ZOOM_HEIGHT) : 0;
        let zoomRate = ZOOM_FACTOR * Math.max(distance - minDist, MIN_ZOOM_HEIGHT);
        zoomRate = clamp(zoomRate, 0.01, 1e8);

        const sign = deltaY > 0 ? 1 : -1;
        const amount = zoomRate * sign * 0.02 * percentage;

        // 沿 camera→hitPoint 方向移动
        v3Sub(_zoomDir, hitECEF, camPos);
        v3Normalize(_zoomDir, _zoomDir);
        camera3D.moveAlongDirection(_zoomDir, amount);
    } else {
        // ─── 鼠标不在球上：以屏幕中心沿视线方向缩放 ───
        const alt = camera3D.getPosition().alt;
        let zoomRate = ZOOM_FACTOR * Math.max(alt, MIN_ZOOM_HEIGHT);
        zoomRate = clamp(zoomRate, 0.01, 1e8);

        const sign = deltaY > 0 ? 1 : -1;
        const amount = zoomRate * sign * 0.02;
        camera3D.zoomIn(amount);
    }
}

// ═══════════════════════════════════════════════════════════════
// tilt3DOnEllipsoid — 高空 tilt（对标 Cesium SSCC:2467-2547）
//
// 在屏幕中心 pick 椭球得到枢轴 center → 构建 ENU transform →
// 在 ENU 局部空间中调用 rotate3DLocal(UNIT_Z) →
// maximumTiltAngle 在 ENU 空间中自然生效。
// ═══════════════════════════════════════════════════════════════

function tilt3DOnEllipsoid(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
): void {
    const vp = getViewport();

    // 1. 防穿地（对标 SSCC:2473-2479）
    const alt = camera3D.getPosition().alt;
    const minHeight = minimumZoomDistance * 0.25;
    if (alt - minHeight - 1.0 < EPSILON3 && endSY - startSY < 0) {
        return;
    }

    // 2. 确定枢轴 center（屏幕中心 pick）
    let center: Float64Array;
    const hit = pickGlobe(vp.width / 2, vp.height / 2);
    if (hit) {
        // 命中球面
        _tiltCenterECEF[0] = hit[0]; _tiltCenterECEF[1] = hit[1]; _tiltCenterECEF[2] = hit[2];
        center = _tiltCenterECEF;
    } else if (alt > MINIMUM_TRACKBALL_HEIGHT_TILT) {
        // 高空未命中：投影到地表正下方作为枢轴（简化 grazingAltitudeLocation）
        const pos = camera3D.getPosition();
        geodeticToECEF(_tiltCenterECEF as Vec3d, pos.lon * DEG2RAD, pos.lat * DEG2RAD, 0);
        center = _tiltCenterECEF;
    } else {
        // 太低无法 pick → 切换到 look 模式（对标 SSCC:2512-2519）
        state.tiltLooking = true;
        const pos = camera3D.getPosition();
        surfaceNormalFromDeg(_tiltNormalUp, pos.lon, pos.lat);
        tiltLook3D(camera3D, startSX, startSY, endSX, endSY, getViewport, _tiltNormalUp);
        state.tiltCenterMouseSX = startSX;
        state.tiltCenterMouseSY = startSY;
        return;
    }

    // 3. 构建 ENU transform（对标 SSCC:2522-2536）
    eastNorthUpToFixedFrame(_tiltENUMat, center);

    // 4. 切换到 ENU 局部空间（对标 Cesium camera._setTransform）
    // 在 ENU 空间中：UNIT_Z = 局部 up
    camera3D.setTransform(_tiltENUMat);

    // 5. 在 ENU 局部空间中做 rotate3D，constrainedAxis = UNIT_Z
    rotate3DLocal(camera3D,
        startSX, startSY, endSX, endSY,
        getViewport, UNIT_Z, false, false);

    // 6. 恢复世界空间
    camera3D.restoreTransform();
}

// ═══════════════════════════════════════════════════════════════
// tilt3DOnTerrain — 低空 tilt（对标 Cesium SSCC:2549-2700）
//
// 枢轴 = pick 点（首帧）或缓存；双 ENU transform 分离垂直/水平旋转；
// 翻转防护：cross(verticalCenter, posWC) · rightWC < 0 时阻止继续 tilt。
// ═══════════════════════════════════════════════════════════════

function tilt3DOnTerrain(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
): void {
    // 1. 确定枢轴 center（对标 SSCC:2559-2595）
    let center: Float64Array;
    if (state.tiltCenter &&
        state.tiltCenterMouseSX === startSX &&
        state.tiltCenterMouseSY === startSY) {
        center = state.tiltCenter;
    } else {
        const hit = pickGlobe(startSX, startSY);
        if (!hit) {
            // pick 失败：回退到 look 模式
            const alt = camera3D.getPosition().alt;
            if (alt <= MINIMUM_TRACKBALL_HEIGHT_TILT) {
                state.tiltLooking = true;
                const pos = camera3D.getPosition();
                surfaceNormalFromDeg(_tiltNormalUp, pos.lon, pos.lat);
                tiltLook3D(camera3D, startSX, startSY, endSX, endSY, getViewport, _tiltNormalUp);
                state.tiltCenterMouseSX = startSX;
                state.tiltCenterMouseSY = startSY;
            }
            return;
        }
        if (!state.tiltCenter) state.tiltCenter = new Float64Array(3);
        state.tiltCenter[0] = hit[0]; state.tiltCenter[1] = hit[1]; state.tiltCenter[2] = hit[2];
        state.tiltCenterMouseSX = startSX;
        state.tiltCenterMouseSY = startSY;
        center = state.tiltCenter;
    }

    // 2. verticalCenter（对标 SSCC:2597-2617）
    v3Copy(_tiltVerticalCenter, center);

    // 3. 构建两个 ENU 变换
    eastNorthUpToFixedFrame(_tiltENUMat, center);
    eastNorthUpToFixedFrame(_tiltVerticalENUMat, _tiltVerticalCenter);

    // 4. 翻转防护（对标 SSCC:2637-2667）
    let constrainedAxis: Float64Array | undefined = UNIT_Z;

    // 在世界空间中计算翻转检测
    const camPosWC = camera3D.getPositionECEF();
    const camRightWC = camera3D.getRight();
    v3Cross(_tiltTangent, _tiltVerticalCenter, camPosWC);
    const flipDot = v3Dot(camRightWC, _tiltTangent);

    if (flipDot < 0.0) {
        const movementDelta = startSY - endSY;
        // 非地下 + 向上拖拽 → 阻止翻转（对标 SSCC:2651-2657）
        if (movementDelta > 0.0) {
            constrainedAxis = undefined;
        }
    }

    // 5. 垂直旋转：在 verticalTransform 下旋转（对标 SSCC:2662/2666）
    camera3D.setTransform(_tiltVerticalENUMat);

    if (flipDot < 0.0) {
        // camera.constrainedAxis = undefined 期间旋转（对标 SSCC:2659-2664）
        const oldAxis = camera3D.getConstrainedAxis();
        camera3D.setConstrainedAxis(null);
        rotate3DLocal(camera3D,
            startSX, startSY, endSX, endSY,
            getViewport, constrainedAxis, true, false);
        camera3D.setConstrainedAxis(oldAxis);
    } else {
        rotate3DLocal(camera3D,
            startSX, startSY, endSX, endSY,
            getViewport, constrainedAxis, true, false);
    }

    // 6. 恢复并切换到 center transform 做水平旋转（对标 SSCC:2669-2670）
    camera3D.restoreTransform();
    camera3D.setTransform(_tiltENUMat);

    rotate3DLocal(camera3D,
        startSX, startSY, endSX, endSY,
        getViewport, constrainedAxis, false, true);

    // 7. 旋转后重正交化（对标 SSCC:2672-2691）
    const cAxis = camera3D.getConstrainedAxis();
    if (cAxis) {
        const dir = camera3D.getDirection();
        const right = camera3D.getRight();
        v3Cross(_tiltTmpAxis, dir, cAxis);
        if (!v3EqualsEpsilon(_tiltTmpAxis, _zeroVec, EPSILON6)) {
            if (v3Dot(_tiltTmpAxis, right) < 0.0) {
                v3Negate(_tiltTmpAxis, _tiltTmpAxis);
            }
            // Cesium: up = cross(right, direction), right = cross(direction, up)
            // 由 restoreTransform 中的 Gram-Schmidt 自动处理
        }
    }

    // 8. 恢复世界空间
    camera3D.restoreTransform();
}

const _zeroVec = new Float64Array(3);

// ═══════════════════════════════════════════════════════════════
// tiltLook3D — 低空自由观察（对标 Cesium SSCC look3D:2750-2870）
// 仅旋转 direction/up（不动 position），带极点约束
// ═══════════════════════════════════════════════════════════════

function tiltLook3D(
    camera3D: Camera3D,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    getViewport: () => { width: number; height: number },
    rotationAxis: Float64Array | null,
): void {
    const vp = getViewport();

    // 水平旋转（鼠标 X 移动）
    const dx = endSX - startSX;
    let angleH = (dx / vp.width) * Math.PI * 0.5;
    angleH = startSX > endSX ? -Math.abs(angleH) : Math.abs(angleH);

    if (rotationAxis) {
        camera3D.look(rotationAxis, -angleH);
    } else {
        camera3D.look(camera3D.getUp(), -angleH);
    }

    // 垂直旋转（鼠标 Y 移动）— 带极点约束（对标 SSCC:2841-2868）
    const dy = endSY - startSY;
    let angleV = (dy / vp.height) * Math.PI * 0.5;
    angleV = startSY > endSY ? -Math.abs(angleV) : Math.abs(angleV);

    if (rotationAxis) {
        const dir = camera3D.getDirection();
        v3Negate(_tiltNegAxis, rotationAxis);
        const northParallel = v3EqualsEpsilon(dir, rotationAxis, EPSILON2);
        const southParallel = v3EqualsEpsilon(dir, _tiltNegAxis, EPSILON2);

        if (!northParallel && !southParallel) {
            const dot1 = v3Dot(dir, rotationAxis);
            const angleToAxis = acosClamped(dot1);
            if (angleV > 0 && angleV > angleToAxis) {
                angleV = angleToAxis - EPSILON4;
            }

            const dot2 = v3Dot(dir, _tiltNegAxis);
            const angleToAxis2 = acosClamped(dot2);
            if (angleV < 0 && -angleV > angleToAxis2) {
                angleV = -angleToAxis2 + EPSILON4;
            }

            v3Cross(_tiltTangent, rotationAxis, dir);
            v3Normalize(_tiltTangent, _tiltTangent);
            camera3D.look(_tiltTangent, angleV);
        } else if ((northParallel && angleV < 0) || (southParallel && angleV > 0)) {
            camera3D.look(camera3D.getRight(), -angleV);
        }
    } else {
        camera3D.look(camera3D.getRight(), -angleV);
    }
}

function acosClamped(v: number): number {
    return Math.acos(clamp(v, -1, 1));
}

function v3EqualsEpsilon(a: Float64Array, b: Float64Array, eps: number): boolean {
    return Math.abs(a[0] - b[0]) <= eps &&
           Math.abs(a[1] - b[1]) <= eps &&
           Math.abs(a[2] - b[2]) <= eps;
}

function v3Negate(out: Float64Array, a: Float64Array): void {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
}

/** 从经纬度（度）计算地表法线 */
function surfaceNormalFromDeg(out: Float64Array, lonDeg: number, latDeg: number): void {
    const lonR = lonDeg * DEG2RAD;
    const latR = latDeg * DEG2RAD;
    const cosLat = Math.cos(latR);
    out[0] = cosLat * Math.cos(lonR);
    out[1] = cosLat * Math.sin(lonR);
    out[2] = Math.sin(latR);
}

// ═══════════════════════════════════════════════════════════════
// tilt3D — 主分发（对标 Cesium SSCC:2422-2463）
//
// 根据高度分发到三种模式：
//   - tiltLook3D:       低空无法 pick 时的自由观察
//   - tilt3DOnEllipsoid: 高空时在屏幕中心枢轴做 ENU 旋转
//   - tilt3DOnTerrain:   低空时在 pick 点枢轴做双 transform 旋转
// ═══════════════════════════════════════════════════════════════

function tilt3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
): void {
    // 连续拖拽中如果已确定为 look 模式，继续 look（对标 SSCC:2428-2434）
    if (state.tiltLooking) {
        const pos = camera3D.getPosition();
        surfaceNormalFromDeg(_tiltNormalUp, pos.lon, pos.lat);
        tiltLook3D(camera3D, startSX, startSY, endSX, endSY, getViewport, _tiltNormalUp);
        return;
    }

    // 鼠标起始位置变化 → 重置模式标记（对标 SSCC:2436-2439）
    if (startSX !== state.tiltCenterMouseSX || startSY !== state.tiltCenterMouseSY) {
        state.tiltOnEllipsoid = false;
        state.tiltLooking = false;
    }

    const alt = camera3D.getPosition().alt;

    if (state.tiltOnEllipsoid || alt > MINIMUM_COLLISION_TERRAIN_HEIGHT) {
        // 高空模式（对标 SSCC:2454-2458）
        state.tiltOnEllipsoid = true;
        tilt3DOnEllipsoid(camera3D, state, startSX, startSY, endSX, endSY,
            pickGlobe, getViewport, minimumZoomDistance);
    } else {
        // 低空模式（对标 SSCC:2459-2461）
        tilt3DOnTerrain(camera3D, state, startSX, startSY, endSX, endSY,
            pickGlobe, getViewport, minimumZoomDistance);
    }
}

// ═══════════════════════════════════════════════════════════════
// createGlobeMouseHandlers — 主入口
// ═══════════════════════════════════════════════════════════════

export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    opts: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean; minimumZoomDistance?: number },
    state: GlobeInteractionState,
    guard: { isDestroyed: () => boolean },
    pickGlobe: (sx: number, sy: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    canvas: HTMLCanvasElement,
): {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
} {
    const rect = () => canvas.getBoundingClientRect();

    function onMouseDown(e: MouseEvent): void {
        if (guard.isDestroyed()) return;
        const r = rect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;

        if (e.button === 0 && opts.enableRotate) {
            // 左键：spin/pan
            state.isDragging = true;
            state.dragButton = 0;
            state.spinStartScreenX = sx;
            state.spinStartScreenY = sy;
            state.spinLastScreenX = sx;
            state.spinLastScreenY = sy;
            state.spinning = false;
            state.rotating = false;
            state.looking = false;

            // 射线求交起始点
            const hit = pickGlobe(sx, sy);
            if (hit) {
                if (!state.spinStartECEF) {
                    state.spinStartECEF = new Float64Array(3);
                }
                state.spinStartECEF[0] = hit[0];
                state.spinStartECEF[1] = hit[1];
                state.spinStartECEF[2] = hit[2];
            } else {
                state.spinStartECEF = null;
            }
        } else if (e.button === 1 && opts.enableTilt) {
            // 中键：tilt（对标 Cesium MIDDLE_DRAG → tilt3D）
            state.isDragging = true;
            state.dragButton = 1;
            state.tiltLastScreenX = sx;
            state.tiltLastScreenY = sy;
            state.tiltOnEllipsoid = false;
            state.tiltLooking = false;
            state.tiltCenterMouseSX = -1;
            state.tiltCenterMouseSY = -1;
            state.tiltCenter = null;
        }
    }

    function onMouseMove(e: MouseEvent): void {
        if (guard.isDestroyed() || !state.isDragging) return;
        const r = rect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;

        if (state.dragButton === 0) {
            // 左键拖拽
            spin3D(camera3D, state, sx, sy, pickGlobe, getViewport);
            state.spinLastScreenX = sx;
            state.spinLastScreenY = sy;
        } else if (state.dragButton === 1) {
            // 中键 tilt（对标 Cesium MIDDLE_DRAG → tilt3D）
            tilt3D(camera3D, state,
                   state.tiltLastScreenX, state.tiltLastScreenY,
                   sx, sy,
                   pickGlobe, getViewport,
                   opts.minimumZoomDistance ?? 100);
            state.tiltLastScreenX = sx;
            state.tiltLastScreenY = sy;
        }
    }

    function onMouseUp(_e: MouseEvent): void {
        if (guard.isDestroyed()) return;
        state.isDragging = false;
        state.dragButton = -1;
        state.spinning = false;
        state.rotating = false;
        state.looking = false;
    }

    function onWheel(e: WheelEvent): void {
        if (guard.isDestroyed() || !opts.enableZoom) return;
        e.preventDefault();

        const r = rect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;

        // 取反 deltaY：浏览器 deltaY>0 表示向后滚（远离用户），应缩小；
        // deltaY<0 表示向前滚（靠近用户），应放大。zoom3D 中正值=靠近球面，
        // 因此传入 -deltaY 使方向符合用户直觉。
        zoom3D(camera3D, -e.deltaY, sx, sy, pickGlobe);
    }

    function onContextMenu(e: Event): void {
        e.preventDefault();
    }

    return { onMouseDown, onMouseMove, onMouseUp, onWheel, onContextMenu };
}

// ═══════════════════════════════════════════════════════════════
// runMorph — 视图模式切换动画
// ═══════════════════════════════════════════════════════════════

export function runMorph(
    morphState: MorphState,
    target: '2d' | '25d' | '3d',
    durationMs: number,
    emit: (type: string, payload?: unknown) => void,
    isDestroyed: () => boolean,
): void {
    if (isDestroyed()) return;

    morphState.morphTarget = target;
    morphState.morphStartTime = performance.now();
    morphState.morphDuration = Math.max(durationMs, 16);
    morphState.morphing = true;

    // 简化：立即切换视图模式（后续可添加插值动画）
    morphState.viewMode = target;
    morphState.morphing = false;

    emit('morphcomplete', { mode: target });
}
