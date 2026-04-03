// ============================================================
// globe-interaction.ts — 鼠标/触摸交互 → Camera3D 操作
// 对标：Cesium ScreenSpaceCameraController — spin3D / pan3D / rotate3D / zoom3D / tilt3D
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
    _zoomWorldPosBuf, _zoomCenterHit,
    _zoomPosNormal, _zoomPickNormal, _zoomRotAxis,
    _zoomPosToTarget, _zoomPosToTargetNorm,
    _zoomCamPos, _zoomCenter, _zoomForward, _zoomUp, _zoomRight,
    _zoomPan, _zoomCMid, _zoomTmpA, _zoomTmpB, _zoomRayDir,
    _spinCurrentECEF,
    _tiltCenterECEF, _tiltENUMat, _tiltOldAxis,
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

/** tilt3D：高度高于此值使用 tilt3DOnEllipsoid，低于则用 look 模式（对标 SSCC:246） */
const MINIMUM_COLLISION_TERRAIN_HEIGHT = 15_000;

/** maximumMovementRatio（对标 Cesium SSCC:272）—— 单帧最大移动比率 */
const MAXIMUM_MOVEMENT_RATIO = 0.1;

/** 最大仰角限制（对标 Cesium maximumTiltAngle = PI/2 → 不允许翻过地平线） */
const MAXIMUM_TILT_ANGLE = Math.PI / 2;

const EPSILON3 = 1e-3;

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** ENU 局部空间中的 up 方向（Z 轴）—— tilt3D constrainedAxis */
const UNIT_Z = new Float64Array([0, 0, 1]);

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

function v3Add(out: Float64Array, a: Float64Array, b: Float64Array): void {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
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
// Float64 射线-椭球求交（tilt3D 枢轴计算专用，绕过 Float32 VP 精度问题）
// ═══════════════════════════════════════════════════════════════

const _RAY_INV_A2 = 1.0 / (WGS84_A * WGS84_A);
const _RAY_INV_B2 = 1.0 / (6356752.314245179 * 6356752.314245179);

/**
 * Float64 射线-WGS84 椭球求交。返回 ECEF 交点写入 out，未命中返回 null。
 *
 * @param origin - 射线起点 ECEF (Float64Array)
 * @param dir - 射线方向（单位向量，Float64Array）
 * @param out - 输出 ECEF 交点 (Float64Array[3])
 * @returns out 引用或 null
 */
function _rayEllipsoidIntersect64(
    origin: Float64Array,
    dir: Float64Array,
    out: Float64Array,
): Float64Array | null {
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const dx = dir[0], dy = dir[1], dz = dir[2];

    const A = dx * dx * _RAY_INV_A2 + dy * dy * _RAY_INV_A2 + dz * dz * _RAY_INV_B2;
    const B = 2 * (ox * dx * _RAY_INV_A2 + oy * dy * _RAY_INV_A2 + oz * dz * _RAY_INV_B2);
    const C = ox * ox * _RAY_INV_A2 + oy * oy * _RAY_INV_A2 + oz * oz * _RAY_INV_B2 - 1;

    const disc = B * B - 4 * A * C;
    if (disc < 0) { return null; }

    const t = (-B - Math.sqrt(disc)) / (2 * A);
    if (t < 0) { return null; }

    out[0] = ox + t * dx;
    out[1] = oy + t * dy;
    out[2] = oz + t * dz;
    return out;
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
    const deltaTheta = rotateRate * dy * Math.PI;

    camera3D.rotateRight(deltaPhi);
    camera3D.rotateUp(deltaTheta);
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
// zoom3D — 滚轮缩放入口（完全对标 Cesium SSCC:2318-2408）
//
// 与旧实现的核心区别：
//   1. distanceMeasure 从**屏幕中心** pick（非光标位置）
//   2. 首次滚轮在光标位置 pick 锚点，后续帧复用
//   3. height < 2000km 时调用旋转缩放（camera.rotate / 球面正弦定律）
//      同时更新 position + direction + up → 修复缩放后 tilt 偏移 bug
//   4. height >= 2000km 时回退到 camera.zoomIn（沿视线方向平移）
// ═══════════════════════════════════════════════════════════════

/** handleZoom 前一次相交距离（对标 Cesium 模块级 preIntersectionDistance） */
let _preIntersectionDistance = 0;

/** 最小缩放速率（对标 Cesium controller._minimumZoomRate = 20） */
const MIN_ZOOM_RATE = 20.0;

/** 最大缩放速率（对标 Cesium controller._maximumZoomRate = 5906376272000） */
const MAX_ZOOM_RATE = 5_906_376_272_000.0;

/** 旋转缩放激活阈值 2000km（对标 Cesium camera.positionCartographic.height < 2000000） */
const ROTATING_ZOOM_HEIGHT = 2_000_000;

/**
 * 高精度旋转缩放阈值 1000km（对标 Cesium camera.positionCartographic.height < 1000000）。
 * 低于此值且相机朝向地表时使用 sub-path B 球面正弦定律大圆旋转。
 */
const HIGH_PRECISION_ZOOM_HEIGHT = 1_000_000;

/**
 * 低空水平视角检测阈值 3000m（对标 Cesium camera.positionCartographic.height < 3000）。
 * 低于此值且相机几乎水平时回退到 zoomOnVector。
 */
const LOW_ALT_HORIZONTAL_HEIGHT = 3_000;

/** sub-path A denom 分界角度 20°（对标 Cesium CesiumMath.toRadians(20)） */
const ZOOM_ANGLE_THRESHOLD = 20 * DEG2RAD;

/**
 * zoom3D 入口——对标 Cesium SSCC:2318-2408。
 *
 * 职责：
 *   1. 在屏幕中心 pick 得到 distanceMeasure
 *   2. 计算 unitPositionDotDirection
 *   3. 委托给 handleZoom 执行实际缩放
 */
function zoom3D(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    deltaY: number,
    sx: number,
    sy: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
): void {
    const vp = getViewport();
    const camPos = camera3D.getPositionECEF();

    // ─── 1. 在屏幕中心 pick 计算 distanceMeasure（对标 Cesium zoom3D:2331-2394）───
    //    Cesium 使用屏幕中心（非光标位置）来计算距离度量。
    //    ⚠ pickGlobe 返回共享缓冲，后续 handleZoom 中会再次 pick 光标位置，
    //    必须在此处复制结果到 _zoomCenterHit。
    const cx = vp.width / 2;
    const cy = vp.height / 2;
    const centerHitRaw = pickGlobe(cx, cy);

    let distanceMeasure: number;
    let centerHit: Float64Array | null = null;
    if (centerHitRaw) {
        v3Copy(_zoomCenterHit, centerHitRaw);
        centerHit = _zoomCenterHit;
        distanceMeasure = v3Distance(camPos, centerHit);
        _preIntersectionDistance = distanceMeasure;
    } else {
        // 屏幕中心未命中球面 → 使用高度作为距离度量（对标 Cesium zoom3D:2392-2394）
        distanceMeasure = camera3D.getPosition().alt;
    }

    // ─── 2. unitPositionDotDirection（对标 Cesium zoom3D:2396-2407）───
    v3Normalize(_zoomUnitPos, camPos);
    const unitPosDotDir = v3Dot(_zoomUnitPos, camera3D.getDirection());

    // ─── 3. 委托 handleZoom ───
    handleZoom(
        camera3D, state,
        deltaY, sx, sy,
        distanceMeasure, unitPosDotDir,
        pickGlobe, getViewport,
        minimumZoomDistance, centerHit,
    );
}

// ═══════════════════════════════════════════════════════════════
// _restoreOrientationAtPosition — 对标 Cesium setView3D (Camera.js:1267-1300)
//
// 在当前位置用给定 bearing/pitch 重建 direction/up/right，**不修改 position**。
//
// ⚠ 不使用 setTransform/restoreTransform（在 ENU 空间调用 _clampAltitude 会崩溃）。
// 改为直接在世界空间中用 ENU 基向量合成 direction 和 up。
// ═══════════════════════════════════════════════════════════════

function _restoreOrientationAtPosition(
    camera3D: Camera3D,
    bearing: number,
    pitch: number,
): void {
    // 1. 在当前相机位置构建 ENU 变换，提取 east/north/up 世界空间基向量
    const camPos = camera3D.getPositionECEF();
    eastNorthUpToFixedFrame(_tiltENUMat, camPos);
    // 列主序：col0=east, col1=north, col2=up
    const ex = _tiltENUMat[0], ey = _tiltENUMat[1], ez = _tiltENUMat[2];
    const nx = _tiltENUMat[4], ny = _tiltENUMat[5], nz = _tiltENUMat[6];
    const ux = _tiltENUMat[8], uy = _tiltENUMat[9], uz = _tiltENUMat[10];

    // 2. 从 bearing/pitch 计算 ENU 局部方向，然后用世界空间基向量合成
    //    getOrientation 约定：pitch=0 → nadir, pitch=-π/2 → horizontal
    //    elev = -pitch - π/2 → nadir: elev=-π/2, horizontal: elev=0
    const elev = -pitch - HALF_PI;
    const cosE = Math.cos(elev);
    const sinE = Math.sin(elev);
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);

    // direction(world) = cosE·sinB·east + cosE·cosB·north + sinE·up
    _zoomTmpA[0] = cosE * sinB * ex + cosE * cosB * nx + sinE * ux;
    _zoomTmpA[1] = cosE * sinB * ey + cosE * cosB * ny + sinE * uy;
    _zoomTmpA[2] = cosE * sinB * ez + cosE * cosB * nz + sinE * uz;

    // up(world) = -sinE·sinB·east - sinE·cosB·north + cosE·up
    _zoomTmpB[0] = -sinE * sinB * ex - sinE * cosB * nx + cosE * ux;
    _zoomTmpB[1] = -sinE * sinB * ey - sinE * cosB * ny + cosE * uy;
    _zoomTmpB[2] = -sinE * sinB * ez - sinE * cosB * nz + cosE * uz;

    // nadir 退化：elev ≈ -π/2 时 cosE ≈ 0，up 变零向量。
    // 此时 up 必须包含 bearing 信息，否则 heading 会被重置为 0。
    // 对标 Cesium setView3D：使用 HeadingPitchRoll 四元数保留 heading。
    // nadir 下 up = -sin(bearing)*east + cos(bearing)*north（绕 down 轴旋转 bearing）
    if (Math.abs(cosE) < 1e-10) {
        _zoomTmpB[0] = -sinB * ex + cosB * nx;
        _zoomTmpB[1] = -sinB * ey + cosB * ny;
        _zoomTmpB[2] = -sinB * ez + cosB * nz;
    }

    // 3. 写入相机——position 不变，只更新 direction/up/right
    camera3D.setPositionDirectionUp(camPos, _zoomTmpA, _zoomTmpB);
}

// ═══════════════════════════════════════════════════════════════
// _handleZoomRotatingSimple — sub-path A（对标 Cesium SSCC:913-939）
//
// height >= 1,000,000m 或相机几乎水平时的简单旋转缩放。
// 计算 screenCenter↔anchor 之间的角度，按 distance 比例旋转相机。
// camera.rotate 同时旋转 position + direction + up → 保持姿态一致。
// ═══════════════════════════════════════════════════════════════

function _handleZoomRotatingSimple(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    distance: number,
    centerHit: Float64Array,
): void {
    // positionNormal = normalize(centerHit)（屏幕中心球面交点的径向方向）
    v3Normalize(_zoomPosNormal, centerHit);
    // pickedNormal = normalize(zoomWorldPosition)（光标锚点的径向方向）
    v3Normalize(_zoomPickNormal, state.zoomWorldPosition!);

    const dotProduct = v3Dot(_zoomPickNormal, _zoomPosNormal);

    // 点积 ≤ 0 表示两点在球体对侧，≥ 1 表示重合——均无法定义旋转轴
    if (dotProduct <= 0 || dotProduct >= 1) { return; }

    // 两点间的角度
    const angle = Math.acos(clamp(dotProduct, -1, 1));

    // 旋转轴 = cross(pickedNormal, positionNormal)，垂直于两点所在的大圆平面
    v3Cross(_zoomRotAxis, _zoomPickNormal, _zoomPosNormal);
    v3Normalize(_zoomRotAxis, _zoomRotAxis);

    // denom 决定旋转比例的分母（对标 Cesium SSCC:932-936）
    //   大角度（> 20°）：用 height * 0.75，减小旋转幅度避免过冲
    //   小角度（≤ 20°）：用 height - distance，线性缩小
    const alt = camera3D.getPosition().alt;
    const denom = Math.abs(angle) > ZOOM_ANGLE_THRESHOLD
        ? alt * 0.75
        : alt - distance;
    const scalar = distance / denom;

    // camera.rotate 同时旋转 position + direction + up（对标 Cesium camera.rotate）
    camera3D.rotate(_zoomRotAxis, angle * scalar);
}

// ═══════════════════════════════════════════════════════════════
// _handleZoomRotatingFull — sub-path B（完全对标 Cesium SSCC:762-911）
//
// height < 1,000,000m 且相机朝向地表时的**完整球面旋转缩放**。
//
// 核心算法：
//   1. 在 camera-target 平面内用球面正弦定律求旋转角 beta
//   2. 构建 up/right/forward 旋转基底
//   3. 沿大圆路径移动 camera position 和 center 参考点
//   4. 重算 direction = normalize(center - position)
//   5. setPositionDirectionUp 直接写入相机向量
//
// 这是 Cesium handleZoom 中最精确的路径。
// ═══════════════════════════════════════════════════════════════

function _handleZoomRotatingFull(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    distance: number,
    _centerHit: Float64Array,
): void {
    const camPos = camera3D.getPositionECEF();
    const camDir = camera3D.getDirection();
    const target = state.zoomWorldPosition!;

    // ─── center = cameraPosition + forward * 1000（对标 Cesium SSCC:775-782）───
    // 沿视线前方 1000m 处的参考点，用于后续重算 direction。
    v3Copy(_zoomForward, camDir);
    v3Scale(_zoomTmpA, _zoomForward, 1000);
    v3Add(_zoomCenter, camPos, _zoomTmpA);

    // ─── positionToTarget = target - cameraPosition（对标 SSCC:784-788）───
    v3Sub(_zoomPosToTarget, target, camPos);
    v3Normalize(_zoomPosToTargetNorm, _zoomPosToTarget);

    // ─── 检查 target 和 camera 是否在椭球同侧（对标 SSCC:769-773）───
    v3Normalize(_zoomUp, camPos);    // cameraPositionNormal
    v3Normalize(_zoomTmpA, target);  // targetNormal
    if (v3Dot(_zoomTmpA, _zoomUp) < 0) { return; }

    // ─── alpha（对标 SSCC:790-800）───
    // alpha = acos(-dot(cameraPositionNormal, positionToTargetNormal))
    // 相机径向与 camera→target 方向之间的角度补角
    const alphaDot = v3Dot(_zoomUp, _zoomPosToTargetNorm);
    if (alphaDot >= 0) {
        // 已 zoom 过目标点（camera→target 方向朝外而非朝地表）→ invalidate
        state.zoomMouseStartX = -1;
        return;
    }
    const alpha = Math.acos(clamp(-alphaDot, -1, 1));

    // ─── 距离参数（对标 SSCC:801-805）───
    const cameraDistance = v3Length(camPos);
    const targetDistance = v3Length(target);
    const remainingDistance = cameraDistance - distance;
    const positionToTargetDistance = v3Length(_zoomPosToTarget);

    // ─── 球面正弦定律（对标 SSCC:807-821）───
    // 在 camera-center-target 球面三角形中：
    //   gamma = 当前 camera→target 对应的球面角
    //   delta = 缩放后 camera→target 对应的球面角
    //   beta = gamma - delta + alpha = 相机需要旋转的大圆角度
    const sinAlpha = Math.sin(alpha);
    const gamma = Math.asin(clamp(
        (positionToTargetDistance / targetDistance) * sinAlpha, -1, 1,
    ));
    const delta = Math.asin(clamp(
        (remainingDistance / targetDistance) * sinAlpha, -1, 1,
    ));
    const beta = gamma - delta + alpha;

    // ─── 构建旋转基底（对标 SSCC:823-832）───
    // up = normalize(cameraPosition)（径向方向，已在 _zoomUp 中）
    // right = normalize(cross(positionToTargetNormal, up))（旋转轴，⊥ camera-target 平面）
    v3Cross(_zoomRight, _zoomPosToTargetNorm, _zoomUp);
    v3Normalize(_zoomRight, _zoomRight);
    // forward = normalize(cross(up, right))（大圆切线方向）
    v3Cross(_zoomForward, _zoomUp, _zoomRight);
    v3Normalize(_zoomForward, _zoomForward);

    // ─── 移动 center 参考点（对标 SSCC:834-839）───
    // center = normalize(center) * (|center| - distance)
    const centerMag = v3Length(_zoomCenter);
    v3Normalize(_zoomTmpA, _zoomCenter);
    v3Scale(_zoomCenter, _zoomTmpA, centerMag - distance);

    // ─── 移动 camera position 到新半径（对标 SSCC:840-845）───
    // cameraPosition = normalize(camPos) * remainingDistance
    v3Normalize(_zoomTmpA, camPos);
    v3Scale(_zoomCamPos, _zoomTmpA, remainingDistance);

    // ─── 沿大圆位移 camera（对标 SSCC:847-866）───
    // pMid = ((cos(β)-1) * up + sin(β) * forward) * remainingDistance
    const cosBeta = Math.cos(beta);
    const sinBeta = Math.sin(beta);
    v3Scale(_zoomTmpA, _zoomUp, cosBeta - 1);
    v3Scale(_zoomTmpB, _zoomForward, sinBeta);
    v3Add(_zoomPan, _zoomTmpA, _zoomTmpB);
    v3Scale(_zoomPan, _zoomPan, remainingDistance);
    v3Add(_zoomCamPos, _zoomCamPos, _zoomPan);

    // ─── 重新计算 up 和 forward 用于 center 位移（对标 SSCC:868-872）───
    v3Normalize(_zoomUp, _zoomCenter);
    v3Cross(_zoomForward, _zoomUp, _zoomRight);
    v3Normalize(_zoomForward, _zoomForward);

    // ─── 沿大圆位移 center（对标 SSCC:874-892）───
    // cMid = ((cos(β)-1) * up + sin(β) * forward) * |center|
    v3Scale(_zoomTmpA, _zoomUp, cosBeta - 1);
    v3Scale(_zoomTmpB, _zoomForward, sinBeta);
    v3Add(_zoomCMid, _zoomTmpA, _zoomTmpB);
    v3Scale(_zoomCMid, _zoomCMid, v3Length(_zoomCenter));
    v3Add(_zoomCenter, _zoomCenter, _zoomCMid);

    // ─── 更新相机（对标 SSCC:894-910）───
    // direction = normalize(center - cameraPosition)  ← 这是修复 bug 的关键！
    v3Sub(_zoomDir, _zoomCenter, _zoomCamPos);
    v3Normalize(_zoomDir, _zoomDir);

    // right = cross(direction, camera.up)
    // up = cross(right, direction)
    // 使用当前 camera.up 作为参考方向，由 setPositionDirectionUp 内部重正交化
    v3Cross(_zoomRight, _zoomDir, camera3D.getUp());
    v3Normalize(_zoomRight, _zoomRight);
    v3Cross(_zoomUp, _zoomRight, _zoomDir);
    v3Normalize(_zoomUp, _zoomUp);

    // 直接写入相机 position + direction + up（对标 Cesium SSCC:897-908）
    camera3D.setPositionDirectionUp(_zoomCamPos, _zoomDir, _zoomUp);
}

// ═══════════════════════════════════════════════════════════════
// handleZoom — 核心缩放逻辑（完全对标 Cesium SSCC:559-983 的 SCENE3D 路径）
//
// 五个阶段：
//   Phase 1: 计算缩放量 distance
//   Phase 2: 首次滚轮 pick 光标锚点
//   Phase 3: 旋转缩放（三个子路径 A/B/C）
//   Phase 4: 最终移动
//   Phase 5: 恢复 HPR 一致性
// ═══════════════════════════════════════════════════════════════

function handleZoom(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    scrollDelta: number,
    cursorSX: number,
    cursorSY: number,
    distanceMeasure: number,
    unitPosDotDir: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
    centerHit: Float64Array | null,
): void {
    // ━━━━ Phase 1: 计算缩放量 distance（对标 Cesium handleZoom:567-616）━━━━

    // percentage：视角因子——相机越接近垂直俯视（dot ≈ -1 → |dot| ≈ 1），缩放越快
    let percentage = 1.0;
    percentage = clamp(Math.abs(unitPosDotDir), 0.25, 1.0);

    // 滚动方向：scrollDelta > 0 = 靠近球面，< 0 = 远离
    const approachingSurface = scrollDelta > 0;
    const minHeight = approachingSurface ? minimumZoomDistance * percentage : 0;

    // 缩放速率（对标 Cesium handleZoom:586-592）
    const minDistance = distanceMeasure - minHeight;
    let zoomRate = ZOOM_FACTOR * minDistance;
    zoomRate = clamp(zoomRate, MIN_ZOOM_RATE, MAX_ZOOM_RATE);

    // NDC 归一化滚动比率（对标 Cesium handleZoom:594-596）
    const vp = getViewport();
    let rangeWindowRatio = scrollDelta / vp.height;
    rangeWindowRatio = Math.min(rangeWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    let distance = zoomRate * rangeWindowRatio;

    // 高度限制防护（对标 Cesium handleZoom:598-616）
    if (distance > 0 && Math.abs(distanceMeasure - minHeight) < 1.0) { return; }
    if (distanceMeasure - distance < minHeight) {
        distance = distanceMeasure - minHeight - 1.0;
    }

    // ━━━━ Phase 2: 首次滚轮 pick 锚点（对标 Cesium handleZoom:627-677）━━━━

    // sameStartPosition：光标位置是否与上一帧相同（2px 阈值）
    const sameStartPosition =
        Math.abs(cursorSX - state.zoomMouseStartX) < 2 &&
        Math.abs(cursorSY - state.zoomMouseStartY) < 2;

    let zoomingOnVector = state.zoomingOnVector;
    let rotatingZoom = state.rotatingZoom;

    if (!sameStartPosition) {
        // 光标位置变化——重新 pick 锚点
        state.zoomMouseStartX = cursorSX;
        state.zoomMouseStartY = cursorSY;

        // 在光标位置 pick 球面交点作为缩放锚点
        const pickedRaw = pickGlobe(cursorSX, cursorSY);
        if (pickedRaw) {
            v3Copy(_zoomWorldPosBuf, pickedRaw);
            state.zoomWorldPosition = _zoomWorldPosBuf;
            state.useZoomWorldPosition = true;
        } else {
            state.useZoomWorldPosition = false;
        }

        zoomingOnVector = state.zoomingOnVector = false;
        rotatingZoom = state.rotatingZoom = false;
    }

    // 未 pick 到锚点 → 简单沿视线方向缩放（对标 Cesium handleZoom:674-677）
    if (!state.useZoomWorldPosition) {
        camera3D.zoomIn(distance);
        return;
    }

    // ━━━━ Phase 3: 旋转缩放（对标 Cesium handleZoom:681-943 SCENE3D）━━━━

    let zoomOnVector = false;
    const alt = camera3D.getPosition().alt;

    if (alt < ROTATING_ZOOM_HEIGHT) {
        rotatingZoom = true;
    }

    if (!sameStartPosition || rotatingZoom) {
        // ─── SCENE3D 路径（对标 Cesium handleZoom:727-941）───
        const camPos = camera3D.getPositionECEF();
        v3Normalize(_zoomTmpA, camPos); // cameraPositionNormal

        if (alt < LOW_ALT_HORIZONTAL_HEIGHT &&
            Math.abs(v3Dot(camera3D.getDirection(), _zoomTmpA)) < 0.6) {
            // 低空 + 相机几乎水平 → zoomOnVector 回退（对标 SSCC:732-739）
            zoomOnVector = true;
        } else if (!centerHit) {
            // 屏幕中心未命中球面 → zoomOnVector 回退（对标 SSCC:753-754）
            zoomOnVector = true;
        } else if (alt < HIGH_PRECISION_ZOOM_HEIGHT) {
            // ─── 低空路径（对标 SSCC:755-912）───
            if (v3Dot(camera3D.getDirection(), _zoomTmpA) >= -0.5) {
                // 相机几乎水平（dot ≥ -0.5）→ zoomOnVector（对标 SSCC:760-761）
                zoomOnVector = true;
            } else {
                // ★ Sub-path B: 完整球面旋转缩放（对标 SSCC:762-911）
                // Sub-path B 自己处理 position + direction + up，然后 return 提前退出。
                // 对标 Cesium SSCC:910-911 的 camera.setView + return。
                _handleZoomRotatingFull(camera3D, state, distance, centerHit);
                // Sub-path B 在 return 前必须恢复 HPR（对标 Cesium SSCC:910 setView）
                return;
            }
        } else {
            // ─── 中高空路径（对标 SSCC:913-939）───
            // ★ Sub-path A: 简单旋转缩放
            _handleZoomRotatingSimple(camera3D, state, distance, centerHit);
        }

        state.rotatingZoom = !zoomOnVector;
    }

    // ━━━━ Phase 4: 最终移动（对标 Cesium handleZoom:946-978）━━━━

    if ((!sameStartPosition && zoomOnVector) || zoomingOnVector) {
        // Sub-path C: 沿 camera→anchor 方向线性移动（对标 Cesium handleZoom:946-978）
        //
        // Cesium 在此处会将 _zoomWorldPosition 投影回屏幕再取 pickRay，
        // 但我们简化为直接计算 camera→anchor 方向——效果等价：
        // 当 sameStartPosition 时 anchor 不变，camera 方向一致。
        const camPos = camera3D.getPositionECEF();
        v3Sub(_zoomRayDir, state.zoomWorldPosition!, camPos);
        v3Normalize(_zoomRayDir, _zoomRayDir);
        camera3D.moveAlongDirection(_zoomRayDir, distance);

        state.zoomingOnVector = true;
    } else {
        // 沿视线方向移动（对标 Cesium handleZoom:976-978）
        // ⚠ Cesium 中此处无条件执行 camera.zoomIn(distance)。
        // Sub-path A (rotate) 只处理光标跟踪旋转，实际距离移动由 zoomIn 完成。
        // Sub-path B 已在上方 return 退出，不会重复移动。
        camera3D.zoomIn(distance);
    }

    // ━━━━ Phase 5: 不执行 HPR 重建 ━━━━
    //
    // Sub-path A (camera.rotate) 同时旋转 position+direction+up → 方向已对齐。
    // Sub-path B (setPositionDirectionUp) 直接设置所有向量 → 方向已对齐。
    // zoomIn 沿视线方向移动 → 方向不变。
    // zoomOnVector 方向轻微偏差可接受。
    //
    // ⚠ _restoreOrientationAtPosition 会改变 ENU 帧导致 bearing 漂移，
    // 使地球在缩放时可见旋转。因此不执行 Phase 5。
    // camera.rotate 引入的微小 roll 在正常使用中可忽略。
}

// ═══════════════════════════════════════════════════════════════
// tilt3DCore — 对标 Cesium tilt3DOnEllipsoid（SSCC:2467-2547）
//
// 核心机制（完全对标 Cesium 方案）：
//   1. 在屏幕中心 pick 枢轴点 → 构建 ENU（East-North-Up）局部坐标系
//   2. camera.setTransform(ENU) → 相机坐标切换到 ENU 局部空间
//   3. 在 ENU 空间中，constrainedAxis = UNIT_Z（局部 up），用 rotateRight/rotateUp
//      做 heading + pitch 旋转。rotateUp 内部的极点检测天然处理 nadir 约束：
//      - 当相机在 ENU 空间中处于"北极"（= 世界空间中正上方 = nadir 状态），
//        垂直拖拽被阻断，但水平旋转仍然生效 → 类似极点处旋转地球的效果
//   4. maximumTiltAngle = π/2 防止越过水平线
//   5. camera.restoreTransform() → 坐标回到 ECEF 世界空间
//
// 倾斜角范围：0°（nadir，垂直向下看）→ 90°（水平看），不允许越过水平线。
// nadir 时继续向下拖拽 → 垂直分量被 rotateVertical 极点逻辑屏蔽，
// 但水平分量（rotateRight）始终生效 → 地球绕枢轴法线旋转。
// ═══════════════════════════════════════════════════════════════

function tilt3DCore(
    camera3D: Camera3D,
    state: GlobeInteractionState,
    startSX: number, startSY: number,
    endSX: number, endSY: number,
    pickGlobe: (x: number, y: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
    minimumZoomDistance: number,
): void {
    const vp = getViewport();

    // 1. 防穿地：高度接近最小缩放距离时，禁止向地面方向继续拖拽
    //    对标 Cesium SSCC:2473-2479（endY - startY < 0 = 鼠标向上移动 = 试图压低相机）
    const alt = camera3D.getPosition().alt;
    const minHeight = minimumZoomDistance * 0.25;
    if (alt - minHeight - 1.0 < EPSILON3 &&
        (endSY - startSY) < 0) {
        return;
    }

    // 2. 确定枢轴：每帧用 Camera3D 的 Float64 向量做射线-球求交（对标 Cesium tilt3DOnEllipsoid）。
    //    Cesium 每帧重新计算枢轴——随着相机倾斜，视口中心在球面的交点会移动，
    //    始终围绕当前视口中心旋转可防止地球偏移出屏幕。
    //    ⚠ 不使用 pickGlobe（依赖 Float32 inverseVP，精度不够导致累积漂移），
    //    改为直接用 Camera3D 的 Float64 position+direction 做射线-球求交。
    const camPos = camera3D.getPositionECEF();
    const camDir = camera3D.getDirection();
    const tiltCenter = _rayEllipsoidIntersect64(camPos, camDir, _tiltCenterECEF);
    if (!tiltCenter) {
        // 射线未命中椭球 → 用相机正下方地表点作为备用枢轴
        const pos = camera3D.getPosition();
        geodeticToECEF(
            _tiltCenterECEF as Vec3d,
            pos.lon * DEG2RAD, pos.lat * DEG2RAD, 0,
        );
    }

    // 3. 在枢轴点构建 ENU 变换矩阵（对标 Cesium Transforms.eastNorthUpToFixedFrame）
    //    ENU 列主序：col0=east, col1=north, col2=up, col3=center
    eastNorthUpToFixedFrame(_tiltENUMat, _tiltCenterECEF);

    // 4. 保存相机当前的 constrainedAxis，然后切换到 ENU 局部空间
    //    对标 Cesium SSCC:2523-2533 的 setTransform + 临时修改 rotateFactor
    //    ⚠ getConstrainedAxis() 返回内部数组引用，setConstrainedAxis 会原地修改，
    //    所以必须先把旧值复制到独立缓冲 _tiltOldAxis，否则 restore 时旧值已被覆盖。
    const rawOldAxis = camera3D.getConstrainedAxis();
    let hasOldAxis = false;
    if (rawOldAxis) {
        _tiltOldAxis[0] = rawOldAxis[0];
        _tiltOldAxis[1] = rawOldAxis[1];
        _tiltOldAxis[2] = rawOldAxis[2];
        hasOldAxis = true;
    }

    // 切换到 ENU 空间：position/direction/up 变为 ENU 局部坐标
    camera3D.setTransform(_tiltENUMat);

    // 在 ENU 空间中 constrainedAxis = Z 轴（= 局部 up 方向）
    camera3D.setConstrainedAxis(UNIT_Z);

    // 5. 计算旋转量（对标 Cesium rotate3D SSCC:2025-2088 中的 NDC 归一化方案）
    //    ENU 下使用单位球：rotateFactor=1, rangeAdjustment=1
    const camPosLocal = camera3D.getPositionECEF(); // setTransform 后返回 ENU 局部位置
    const rho = v3Length(camPosLocal);


    // 旋转速率：与 Cesium 一致的 rho - 1 方案（ENU 下椭球半径 = 1）
    let rotateRate = 1.0 * (rho - 1.0);
    rotateRate = clamp(rotateRate, MIN_ROTATE_RATE, MAX_ROTATE_RATE);

    // 屏幕像素 → NDC 归一化比率
    let phiWindowRatio = (startSX - endSX) / vp.width;
    let thetaWindowRatio = (startSY - endSY) / vp.height;

    // 防抖：限制单帧最大移动比率（对标 Cesium SSCC:272 maximumMovementRatio）
    phiWindowRatio = Math.min(phiWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    thetaWindowRatio = Math.min(thetaWindowRatio, MAXIMUM_MOVEMENT_RATIO);

    // 转换为弧度：水平满屏 = 360° 旋转，垂直满屏 = 180° 旋转
    const deltaPhi = rotateRate * phiWindowRatio * TWO_PI;
    let deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

    // 6. maximumTiltAngle 约束（对标 Cesium SSCC:2070-2077）
    //    tilt = π - acos(dot(direction, constrainedAxis))
    //    - nadir（正下方看）：dot(dir, up) ≈ -1 → acos = π → tilt ≈ 0
    //    - 水平看：dot(dir, up) ≈ 0 → acos = π/2 → tilt ≈ π/2
    //    - MAXIMUM_TILT_ANGLE = π/2 → 不允许越过水平线
    const dir = camera3D.getDirection();
    const dotProduct = v3Dot(dir, UNIT_Z);
    const currentTilt = Math.PI - Math.acos(clamp(dotProduct, -1, 1));
    const tiltAfterDelta = currentTilt + deltaTheta;
    if (tiltAfterDelta > MAXIMUM_TILT_ANGLE) {
        // 将超出部分裁剪：deltaTheta 只允许把 tilt 推到 MAXIMUM_TILT_ANGLE
        deltaTheta -= (tiltAfterDelta - MAXIMUM_TILT_ANGLE);
    }

    // 7. 应用旋转
    //    rotateRight：绕 constrainedAxis（ENU Z 轴 = 地表 up）旋转 → heading 变化
    //    rotateUp：绕 tangent 旋转 → pitch 变化
    //    在 nadir 时，rotateUp 内部的极点检测（Camera3D._rotateUp）会：
    //      - 检测 normalize(position) ≈ constrainedAxis（北极 = nadir）
    //      - 阻断"向北极更深处"方向的旋转（= 阻止越过 nadir）
    //      - 允许"离开北极"方向的旋转（= 允许从 nadir 向水平倾斜）
    //    水平旋转 rotateRight 不受极点约束影响 → 始终生效 → nadir 时拖拽只旋转地球
    camera3D.rotateRight(deltaPhi);
    camera3D.rotateUp(deltaTheta);

    // 8. 恢复世界空间 + 恢复原 constrainedAxis
    camera3D.restoreTransform();
    camera3D.setConstrainedAxis(hasOldAxis ? _tiltOldAxis : null);
}

// ═══════════════════════════════════════════════════════════════
// tilt3D — 主分发（对标 Cesium SSCC:2422-2463）
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
    // 统一路由到 tilt3DCore（ENU 方案）：
    // 绕屏幕中心枢轴点做倾斜+旋转，
    // 水平拖拽改变 heading（方位角），垂直拖拽改变 pitch（倾斜角），
    // 在 nadir 时垂直被阻断、水平仍生效 → 类似极点旋转效果。
    tilt3DCore(camera3D, state, startSX, startSY, endSX, endSY,
              pickGlobe, getViewport, minimumZoomDistance);
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

        // ── 重置 zoom 状态（对标 Cesium：任何 mouseDown 都 invalidate 缩放锚点）──
        state.zoomMouseStartX = -1;
        state.zoomMouseStartY = -1;
        state.zoomWorldPosition = null;
        state.useZoomWorldPosition = false;
        state.zoomingOnVector = false;
        state.rotatingZoom = false;

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
            // 首帧 tilt 时将确定枢轴，此处置 null 触发重新 pick
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
        zoom3D(camera3D, state, -e.deltaY, sx, sy,
               pickGlobe, getViewport, opts.minimumZoomDistance ?? 1);
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
