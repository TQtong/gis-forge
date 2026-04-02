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
// tilt3DCore — 完全对标 Cesium tilt3DOnEllipsoid（SSCC:2467-2547）
//
// 核心机制：相机绕枢轴点轨道运动：
//   - 水平拖拽 → 绕枢轴法线旋转 → heading 变化
//   - 垂直拖拽 → 绕 camera.right 旋转 → pitch 变化
//   - 约束防翻转 + 允许到达水平视角
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

    // 1. 防穿地（对标 SSCC:2473-2479）──────────────────
    const alt = camera3D.getPosition().alt;
    const minHeight = minimumZoomDistance * 0.25;
    if (alt - minHeight - 1.0 < EPSILON3 && endSY < startSY) {
        return;
    }

    // 2. 确定枢轴（屏幕中心 pick）────────────────────────
    if (!state.tiltCenter) {
        let hit = pickGlobe(vp.width / 2, vp.height / 2);
        if (!hit) {
            const pos = camera3D.getPosition();
            geodeticToECEF(_tiltCenterECEF as Vec3d, pos.lon * DEG2RAD, pos.lat * DEG2RAD, 0);
            hit = _tiltCenterECEF;
        }
        state.tiltCenter = new Float64Array(3);
        state.tiltCenter[0] = hit[0]; state.tiltCenter[1] = hit[1]; state.tiltCenter[2] = hit[2];
    }

    // 3. 计算旋转量 ───────────────────────────────────
    const dx = endSX - startSX;
    const dy = endSY - startSY;
    const sensitivity = 0.005;

    // 4. 垂直拖拽 → 绕 camera.right（屏幕水平轴）做 tilt
    //    对标 Cesium rotateVertical (Camera.js:2080-2134) 的约束逻辑
    if (Math.abs(dy) > 0.5) {
        let pitchAngle = -dy * sensitivity;

        const center = state.tiltCenter;
        const camPos = camera3D.getPositionECEF();

        // 计算相机相对枢轴的偏移向量，归一化
        const relX = camPos[0] - center[0];
        const relY = camPos[1] - center[1];
        const relZ = camPos[2] - center[2];
        const relLen = Math.sqrt(relX * relX + relY * relY + relZ * relZ);

        if (relLen > 1e-10) {
            const px = relX / relLen, py = relY / relLen, pz = relZ / relLen;

            // 枢轴法线（= constrainedAxis 在世界空间中的等价物）
            const cLen = v3Length(center);
            if (cLen > 1e-10) {
                const ax = center[0] / cLen, ay = center[1] / cLen, az = center[2] / cLen;

                // 对标 Cesium rotateVertical:2107-2120
                // angleToAxis = 到"正上方"（north pole = 枢轴法线方向）的角度
                const dotNorth = px * ax + py * ay + pz * az;
                const angleToNorth = Math.acos(clamp(dotNorth, -1, 1));

                // 正旋转（向上/向正上方）：不能越过正上方
                if (pitchAngle > 0 && pitchAngle > angleToNorth) {
                    pitchAngle = angleToNorth - EPSILON4;
                }

                // angleToSouth = 到"正下方"（south pole = 枢轴法线反方向）的角度
                const dotSouth = -(px * ax + py * ay + pz * az); // = dot(p, -axis)
                const angleToSouth = Math.acos(clamp(dotSouth, -1, 1));

                // 负旋转（向下/向水平方向）：不能越过水平（south pole 方向）
                if (pitchAngle < 0 && -pitchAngle > angleToSouth) {
                    pitchAngle = -angleToSouth + EPSILON4;
                }

                if (Math.abs(pitchAngle) > 1e-8) {
                    camera3D.rotateAroundPoint(center, camera3D.getRight(), pitchAngle);
                }
            }
        }
    }

    // 5. 水平拖拽 → 绕枢轴法线（地表 up 方向）做 heading 旋转
    //    往左拖转左，往右拖转右
    if (Math.abs(dx) > 0.5) {
        const headingAngle = dx * sensitivity;
        const center = state.tiltCenter;
        const cLen = v3Length(center);
        if (cLen > 1e-10) {
            _tiltTmpAxis[0] = center[0] / cLen;
            _tiltTmpAxis[1] = center[1] / cLen;
            _tiltTmpAxis[2] = center[2] / cLen;
            camera3D.rotateAroundPoint(center, _tiltTmpAxis, headingAngle);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// tiltLook3D — 对标 Cesium SSCC look3D:2750-2870
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
    // 统一路由到 tilt3DCore：
    // 绕鼠标点击位置的枢轴点做倾斜+旋转，
    // 水平拖拽改变 heading（方位角），垂直拖拽改变 pitch（倾斜角），
    // 在 90° 垂直向下时不允许翻转。
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
