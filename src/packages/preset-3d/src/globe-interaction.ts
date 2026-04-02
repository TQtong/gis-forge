// ============================================================
// globe-interaction.ts — 鼠标/触摸交互 → Camera3D 操作
// 对标：Cesium ScreenSpaceCameraController — spin3D / pan3D / rotate3D / zoom3D
// 职责：左键拖拽旋转（含极地穿越）、滚轮缩放（光标位置感知）、
//       中键 pivot orbit、morph 动画。
// ============================================================

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';
import {
    _panEast, _panPlaneNormal, _panRejA, _panRejB,
    _panTmpA, _panTmpB, _panBasis1, _panBasis2,
    _zoomDir, _zoomUnitPos,
    _orbitCamECEF, _orbitENUBuf,
    _spinCurrentECEF,
} from './globe-buffers.ts';
import {
    geodeticToECEF, ecefToGeodetic, surfaceNormal, WGS84_A,
} from '../../core/src/geo/ellipsoid.ts';
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

/** 极地 pivot orbit 约束 */
const ORBIT_PITCH_MIN = -Math.PI / 2 + 0.02;
const ORBIT_PITCH_MAX = -0.02;

/** orbit 灵敏度 */
const ORBIT_SENSITIVITY = 0.005;

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

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

// ─── 临时地理缓冲 ───────────────────────────────────────────

const _geoBuf = new Float64Array(3) as Vec3d;
const _normalBuf = new Float64Array(3) as Vec3d;

// ─── ENU 基向量计算 ─────────────────────────────────────────

function computeENUBasis(enuOut: Float64Array, ecef: Float64Array): { lonRad: number; latRad: number } {
    ecefToGeodetic(_geoBuf, ecef[0], ecef[1], ecef[2]);
    const lonR = _geoBuf[0];
    const latR = _geoBuf[1];

    // 法线 = up
    surfaceNormal(_normalBuf, lonR, latR);

    // east = cross([0,0,1], normal)  然后 normalize
    const nx = _normalBuf[0], ny = _normalBuf[1], nz = _normalBuf[2];
    let ex = -ny, ey = nx, ez = 0;
    const el = Math.sqrt(ex * ex + ey * ey);
    if (el < 1e-10) {
        // 极点：east = [1,0,0]
        ex = 1; ey = 0; ez = 0;
    } else {
        const inv = 1 / el;
        ex *= inv; ey *= inv;
    }
    // north = cross(normal, east)
    const northX = ny * ez - nz * ey;
    const northY = nz * ex - nx * ez;
    const northZ = nx * ey - ny * ex;

    // E
    enuOut[0] = ex; enuOut[1] = ey; enuOut[2] = ez;
    // N
    enuOut[3] = northX; enuOut[4] = northY; enuOut[5] = northZ;
    // U
    enuOut[6] = nx; enuOut[7] = ny; enuOut[8] = nz;

    return { lonRad: lonR, latRad: latR };
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
// 中键 Pivot Orbit
// ═══════════════════════════════════════════════════════════════

function applyCameraOrbit(camera3D: Camera3D, state: GlobeInteractionState): void {
    const pivot = state.orbitPivot;
    const enu = state.orbitENU;
    if (!pivot || !enu) return;

    const dist = state.orbitDistance;
    const bearing = state.orbitBearing;
    const pitch = state.orbitPitch;

    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);

    // 相机 ECEF = pivot + dist * (cosP*sinB*E + cosP*cosB*N + sinP*U)
    const camPos = camera3D.getPositionECEF();
    for (let i = 0; i < 3; i++) {
        camPos[i] = pivot[i]
            + dist * cosP * sinB * enu[i]        // East
            + dist * cosP * cosB * enu[3 + i]    // North
            + dist * sinP * enu[6 + i];          // Up
    }

    // direction = normalize(pivot - camPos)
    const dir = camera3D.getDirection();
    v3Sub(dir, pivot, camPos);
    v3Normalize(dir, dir);

    // up = U
    const up = camera3D.getUp();
    up[0] = enu[6]; up[1] = enu[7]; up[2] = enu[8];

    // 重正交化
    const right = camera3D.getRight();
    v3Cross(right, dir, up);
    v3Normalize(right, right);
    v3Cross(up, right, dir);
    v3Normalize(up, up);
}

// ═══════════════════════════════════════════════════════════════
// createGlobeMouseHandlers — 主入口
// ═══════════════════════════════════════════════════════════════

export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    opts: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
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
            // 中键：pivot orbit
            state.isDragging = true;
            state.dragButton = 1;

            const hit = pickGlobe(sx, sy);
            if (hit) {
                if (!state.orbitPivot) state.orbitPivot = new Float64Array(3);
                state.orbitPivot[0] = hit[0];
                state.orbitPivot[1] = hit[1];
                state.orbitPivot[2] = hit[2];

                // 计算 ENU
                if (!state.orbitENU) state.orbitENU = _orbitENUBuf;
                const geo = computeENUBasis(state.orbitENU, state.orbitPivot);
                state.orbitPivotLngRad = geo.lonRad;
                state.orbitPivotLatRad = geo.latRad;

                // 相机到 pivot 距离
                const camPos = camera3D.getPositionECEF();
                state.orbitDistance = v3Distance(camPos, state.orbitPivot);

                // 初始 bearing/pitch 从当前相机位置推算
                const dx = camPos[0] - hit[0];
                const dy = camPos[1] - hit[1];
                const dz = camPos[2] - hit[2];
                // 投影到 ENU
                const enu = state.orbitENU;
                const eComp = dx * enu[0] + dy * enu[1] + dz * enu[2];
                const nComp = dx * enu[3] + dy * enu[4] + dz * enu[5];
                const uComp = dx * enu[6] + dy * enu[7] + dz * enu[8];
                state.orbitBearing = Math.atan2(eComp, nComp);
                const horizDist = Math.sqrt(eComp * eComp + nComp * nComp);
                state.orbitPitch = Math.atan2(uComp, horizDist);
            } else {
                state.orbitPivot = null;
            }
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
            // 中键 orbit
            if (state.orbitPivot && state.orbitENU) {
                const dx = e.movementX ?? (sx - state.spinLastScreenX);
                const dy = e.movementY ?? (sy - state.spinLastScreenY);
                state.orbitBearing += dx * ORBIT_SENSITIVITY;
                state.orbitPitch = clamp(
                    state.orbitPitch - dy * ORBIT_SENSITIVITY,
                    ORBIT_PITCH_MIN,
                    ORBIT_PITCH_MAX,
                );
                applyCameraOrbit(camera3D, state);
                state.spinLastScreenX = sx;
                state.spinLastScreenY = sy;
            }
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

        zoom3D(camera3D, e.deltaY, sx, sy, pickGlobe);
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
