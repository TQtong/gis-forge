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
