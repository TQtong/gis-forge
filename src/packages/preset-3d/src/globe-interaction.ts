/**
 * @module preset-3d/globe-interaction
 * @description
 * 鼠标/滚轮 → {@link Camera3D} 交互。完全参照 CesiumJS ScreenSpaceCameraController 3D 模式。
 *
 * **关键修复**：所有帧内球面拾取使用 {@link screenRaySphereHit}，
 * 从 **当前 CamVec**（getCamVec → camera3D.getPosition/getOrientation）直接计算射线，
 * 不经过 `_lastGlobeCam.inverseVP_ECEF`（该矩阵仅在 `_renderFrame` 中更新，
 * mouseMove 期间已过时 → 反馈振荡 → 抖动/跳动）。
 *
 * | 输入 | CesiumJS 函数 | 本模块 |
 * |------|-------------|--------|
 * | 左键拖拽 | spin3D → pan3D | grab-point 旋转 |
 * | 中键拖拽 | tilt3D | ENU + rotate3D (PR #9562) |
 * | 滚轮 | zoom3D → handleZoom | 距离自适应 + direction 移动 |
 * | 未命中 | rotate3D / look3D | trackball / handleRotate |
 *
 * @stability experimental
 */

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import {
    WGS84_A,
    WGS84_E2,
} from '../../core/src/geo/ellipsoid.ts';
import {
    DEG2RAD,
    DEFAULT_FOV,
    PI,
    RAD2DEG,
    ROTATE_SENSITIVITY,
} from './globe-constants.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';

// ════════════════════════════════════════════════════════════════
// CesiumJS 默认常量
// ════════════════════════════════════════════════════════════════

/** CesiumJS `zoomFactor = 5.0` */
const ZOOM_FACTOR = 5.0;
/** CesiumJS `maximumMovementRatio = 0.1` */
const MAX_MOVEMENT_RATIO = 0.1;
/** CesiumJS `_maximumRotateRate = 1.77` */
const MAX_ROTATE_RATE = 1.77;
/** CesiumJS `_minimumRotateRate = 1/5000` */
const MIN_ROTATE_RATE = 1.0 / 5000.0;
/** CesiumJS `_minimumZoomRate = 20.0` */
const MIN_ZOOM_RATE = 20.0;
/** CesiumJS `_maximumZoomRate = 5906376272000.0` */
const MAX_ZOOM_RATE = 5906376272000.0;
/** CesiumJS `minimumTrackBallHeight = 7500000.0` */
const MIN_TRACKBALL_HEIGHT = 7_500_000;
/** CesiumJS `minimumZoomDistance = 1.0` */
const MIN_ZOOM_DISTANCE = 1.0;
/** CesiumJS `maximumZoomDistance = Infinity` */
const MAX_ZOOM_DISTANCE = Number.POSITIVE_INFINITY;
/** 中键 pitch 上限 ≈ -1° */
const ORBIT_PITCH_MAX = -0.0175;
/** 中键 pitch 下限 ≈ -88.2° */
const ORBIT_PITCH_MIN = -PI * 0.49;

// ════════════════════════════════════════════════════════════════
// CamVec — 相机 ECEF 向量组（等价 CesiumJS Camera 内部状态）
// ════════════════════════════════════════════════════════════════

/** CesiumJS Camera 的 position/direction/up/right 四个 ECEF 向量 */
interface CamVec {
    px: number; py: number; pz: number;
    dx: number; dy: number; dz: number;
    ux: number; uy: number; uz: number;
    rx: number; ry: number; rz: number;
}

/**
 * 从 Camera3D geodetic+orientation → ECEF CamVec。
 * position 使用球面近似 (R=WGS84_A+alt) 保证 Rodrigues 旋转对称性。
 */
function getCamVec(camera3D: Camera3D): CamVec {
    const pos = camera3D.getPosition();
    const o = camera3D.getOrientation();
    const lonR = pos.lon * DEG2RAD, latR = pos.lat * DEG2RAD;
    const b = o.bearing, p = o.pitch;

    const r = WGS84_A + pos.alt;
    const cLat = Math.cos(latR), sLat = Math.sin(latR);
    const cLon = Math.cos(lonR), sLon = Math.sin(lonR);

    // ECEF 位置
    const px = r * cLat * cLon, py = r * cLat * sLon, pz = r * sLat;

    // ENU at camera
    const eX = -sLon, eY = cLon, eZ = 0;
    const nX = -sLat * cLon, nY = -sLat * sLon, nZ = cLat;
    const uX = cLat * cLon, uY = cLat * sLon, uZ = sLat;

    // bearing/pitch → direction/up in ENU → ECEF
    const cp = Math.cos(p), sp = Math.sin(p);
    const sb = Math.sin(b), cb = Math.cos(b);
    const dE = sb * cp, dN = cb * cp, dU = sp;
    const upE = -sb * sp, upN = -cb * sp, upU = cp;

    const dx = dE * eX + dN * nX + dU * uX;
    const dy = dE * eY + dN * nY + dU * uY;
    const dz = dE * eZ + dN * nZ + dU * uZ;
    const cux = upE * eX + upN * nX + upU * uX;
    const cuy = upE * eY + upN * nY + upU * uY;
    const cuz = upE * eZ + upN * nZ + upU * uZ;
    const crx = dy * cuz - dz * cuy;
    const cry = dz * cux - dx * cuz;
    const crz = dx * cuy - dy * cux;

    return { px, py, pz, dx, dy, dz, ux: cux, uy: cuy, uz: cuz, rx: crx, ry: cry, rz: crz };
}

/**
 * ECEF CamVec → Camera3D geodetic+orientation（Bowring 2 次迭代 + ENU 反投影）。
 */
function setCamVec(camera3D: Camera3D, cv: CamVec): void {
    const lonR = Math.atan2(cv.py, cv.px);
    const p2d = Math.sqrt(cv.px * cv.px + cv.py * cv.py);
    let latR = Math.atan2(cv.pz, p2d * (1 - WGS84_E2));
    for (let i = 0; i < 2; i++) {
        const sL = Math.sin(latR);
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sL * sL);
        latR = Math.atan2(cv.pz + WGS84_E2 * N * sL, p2d);
    }
    const sF = Math.sin(latR), cF = Math.cos(latR);
    const Nf = WGS84_A / Math.sqrt(1 - WGS84_E2 * sF * sF);
    let alt: number;
    if (Math.abs(cF) > 1e-10) { alt = p2d / cF - Nf; }
    else { alt = Math.abs(cv.pz) / Math.abs(sF) - Nf * (1 - WGS84_E2); }

    // direction → ENU 投影 → bearing/pitch
    const sLon = Math.sin(lonR), cLon = Math.cos(lonR);
    const sLat = Math.sin(latR), cLat = Math.cos(latR);
    const eX = -sLon, eY = cLon, eZ = 0;
    const nX = -sLat * cLon, nY = -sLat * sLon, nZ = cLat;
    const uX = cLat * cLon, uY = cLat * sLon, uZ = sLat;
    const dE = cv.dx * eX + cv.dy * eY + cv.dz * eZ;
    const dN = cv.dx * nX + cv.dy * nY + cv.dz * nZ;
    const dU = cv.dx * uX + cv.dy * uY + cv.dz * uZ;
    const bearing = Math.atan2(dE, dN);
    const pitch = Math.atan2(dU, Math.sqrt(dE * dE + dN * dN));

    const lonDeg = lonR * RAD2DEG, latDeg = latR * RAD2DEG;
    const altC = Math.max(alt, MIN_ZOOM_DISTANCE);
    if (!Number.isFinite(lonDeg) || !Number.isFinite(latDeg) || !Number.isFinite(altC)
        || !Number.isFinite(bearing) || !Number.isFinite(pitch)) { return; }
    camera3D.setPosition(lonDeg, latDeg, altC);
    camera3D.setOrientation(bearing, pitch, 0);
}

// ════════════════════════════════════════════════════════════════
// Rodrigues + cameraRotate（CesiumJS Camera.rotate 等价）
// ════════════════════════════════════════════════════════════════

const _rod: [number, number, number] = [0, 0, 0];

/** Rodrigues 旋转：v_rot = v·cosα + (axis×v)·sinα + axis·(axis·v)·(1−cosα) */
function rodrigues(
    vx: number, vy: number, vz: number,
    ax: number, ay: number, az: number,
    angle: number,
    out: [number, number, number],
): void {
    const c = Math.cos(angle), s = Math.sin(angle);
    const d = ax * vx + ay * vy + az * vz;
    const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
    out[0] = vx * c + cx * s + ax * d * (1 - c);
    out[1] = vy * c + cy * s + ay * d * (1 - c);
    out[2] = vz * c + cz * s + az * d * (1 - c);
}

/**
 * CesiumJS `Camera.rotate(axis, angle)`：旋转 position/direction/up 绕 axis 旋转 -angle，
 * 重算 right=cross(dir,up)、up=cross(right,dir)，归一化。
 */
function cameraRotate(cv: CamVec, ax: number, ay: number, az: number, angle: number): void {
    const a = -angle; // CesiumJS 源码取反
    rodrigues(cv.px, cv.py, cv.pz, ax, ay, az, a, _rod);
    cv.px = _rod[0]; cv.py = _rod[1]; cv.pz = _rod[2];
    rodrigues(cv.dx, cv.dy, cv.dz, ax, ay, az, a, _rod);
    cv.dx = _rod[0]; cv.dy = _rod[1]; cv.dz = _rod[2];
    rodrigues(cv.ux, cv.uy, cv.uz, ax, ay, az, a, _rod);
    cv.ux = _rod[0]; cv.uy = _rod[1]; cv.uz = _rod[2];
    // right = cross(dir, up)
    cv.rx = cv.dy * cv.uz - cv.dz * cv.uy;
    cv.ry = cv.dz * cv.ux - cv.dx * cv.uz;
    cv.rz = cv.dx * cv.uy - cv.dy * cv.ux;
    // up = cross(right, dir)
    cv.ux = cv.ry * cv.dz - cv.rz * cv.dy;
    cv.uy = cv.rz * cv.dx - cv.rx * cv.dz;
    cv.uz = cv.rx * cv.dy - cv.ry * cv.dx;
    let len = Math.sqrt(cv.ux * cv.ux + cv.uy * cv.uy + cv.uz * cv.uz);
    if (len > 1e-10) { cv.ux /= len; cv.uy /= len; cv.uz /= len; }
    len = Math.sqrt(cv.rx * cv.rx + cv.ry * cv.ry + cv.rz * cv.rz);
    if (len > 1e-10) { cv.rx /= len; cv.ry /= len; cv.rz /= len; }
}

// ════════════════════════════════════════════════════════════════
// ★ screenRaySphereHit — 绕过 _lastGlobeCam 的自主球面拾取
// ════════════════════════════════════════════════════════════════

/** 从 CamVec + 屏幕坐标 → ECEF 球面交点。始终使用当前相机状态，不依赖渲染帧缓存。 */
const _hitOut = new Float64Array(3);

/**
 * 从当前 CamVec 直接计算屏幕射线并与 WGS84 球面求交。
 *
 * **这是修复抖动的核心**：不依赖 `_lastGlobeCam.inverseVP_ECEF`（仅在 `_renderFrame` 更新），
 * 而是从 camera3D.getPosition/getOrientation 实时构建的 CamVec 计算射线。
 * 保证 pick 与 camera 状态始终同帧一致——消除反馈振荡。
 *
 * @param cv - 当前相机 ECEF 向量组
 * @param screenX - 屏幕 X（CSS 像素）
 * @param screenY - 屏幕 Y（CSS 像素）
 * @param vpW - 视口宽度
 * @param vpH - 视口高度
 * @param fov - 垂直 FOV（弧度）
 * @returns Float64Array(3) 引用（ECEF 米），或 null（射线未命中球面）
 */
function screenRaySphereHit(
    cv: CamVec,
    screenX: number,
    screenY: number,
    vpW: number,
    vpH: number,
    fov: number,
): Float64Array | null {
    // NDC
    const ndcX = (2.0 * screenX / vpW) - 1.0;
    const ndcY = 1.0 - (2.0 * screenY / vpH);

    // 视线在 ECEF 中的方向 = direction + ndcX × halfW × right + ndcY × halfH × up
    const halfH = Math.tan(fov * 0.5);
    const halfW = halfH * (vpW / vpH);

    let rdx = cv.dx + ndcX * halfW * cv.rx + ndcY * halfH * cv.ux;
    let rdy = cv.dy + ndcX * halfW * cv.ry + ndcY * halfH * cv.uy;
    let rdz = cv.dz + ndcX * halfW * cv.rz + ndcY * halfH * cv.uz;

    const rdLen = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
    if (rdLen < 1e-10) { return null; }
    rdx /= rdLen; rdy /= rdLen; rdz /= rdLen;

    // 射线-球面求交：O + t·D，球心 = 原点，R = WGS84_A
    // a=1, b = 2(O·D), c = O·O − R²
    const b = 2 * (cv.px * rdx + cv.py * rdy + cv.pz * rdz);
    const c = cv.px * cv.px + cv.py * cv.py + cv.pz * cv.pz - WGS84_A * WGS84_A;
    const disc = b * b - 4 * c;

    if (disc < 0) { return null; }

    const sqrtD = Math.sqrt(disc);
    let t = (-b - sqrtD) * 0.5; // 近交点
    if (t < 0) {
        t = (-b + sqrtD) * 0.5; // 远交点（相机在球内）
        if (t < 0) { return null; }
    }

    _hitOut[0] = cv.px + rdx * t;
    _hitOut[1] = cv.py + rdy * t;
    _hitOut[2] = cv.pz + rdz * t;
    return _hitOut;
}

// ════════════════════════════════════════════════════════════════
// doRotate3D — CesiumJS trackball
// ════════════════════════════════════════════════════════════════

/**
 * CesiumJS `rotate3D`：rate = (rho−R)/R；deltaPhi 绕 up，deltaTheta 绕 right。
 */
function doRotate3D(cv: CamVec, dxM: number, dyM: number, cW: number, cH: number): void {
    const rho = Math.sqrt(cv.px * cv.px + cv.py * cv.py + cv.pz * cv.pz);
    let rate = (rho - WGS84_A) / WGS84_A;
    rate = Math.max(MIN_ROTATE_RATE, Math.min(MAX_ROTATE_RATE, rate));

    let phiR = Math.max(-MAX_MOVEMENT_RATIO, Math.min(MAX_MOVEMENT_RATIO, dxM / Math.max(cW, 1)));
    let thetaR = Math.max(-MAX_MOVEMENT_RATIO, Math.min(MAX_MOVEMENT_RATIO, dyM / Math.max(cH, 1)));

    const dPhi = rate * phiR * PI * 2.0;
    const dTheta = rate * thetaR * PI;

    if (Math.abs(dPhi) > 1e-10) { cameraRotate(cv, cv.ux, cv.uy, cv.uz, dPhi); }
    if (Math.abs(dTheta) > 1e-10) { cameraRotate(cv, cv.rx, cv.ry, cv.rz, dTheta); }
}

// ════════════════════════════════════════════════════════════════
// doHandleZoom — CesiumJS 缩放数学
// ════════════════════════════════════════════════════════════════

/** CesiumJS handleZoom：zoomRate = zoomFactor × distance，沿 direction 移动。 */
function doHandleZoom(cv: CamVec, diff: number, canvasH: number, distMeasure: number): void {
    const rho = Math.sqrt(cv.px * cv.px + cv.py * cv.py + cv.pz * cv.pz);
    const updd = (rho > 1e-10) ? Math.abs((cv.px * cv.dx + cv.py * cv.dy + cv.pz * cv.dz) / rho) : 1.0;
    const pct = Math.max(0.25, Math.min(1.0, updd));

    const approaching = diff > 0;
    const minH = approaching ? MIN_ZOOM_DISTANCE * pct : 0;
    const minD = distMeasure - minH;
    let zr = Math.max(MIN_ZOOM_RATE, Math.min(MAX_ZOOM_RATE, ZOOM_FACTOR * minD));
    let rwr = Math.max(-MAX_MOVEMENT_RATIO, Math.min(MAX_MOVEMENT_RATIO, diff / Math.max(canvasH, 1)));
    let dist = zr * rwr;

    if (dist > 0.0 && Math.abs(distMeasure - minH) < 1.0) { return; }
    if (dist < 0.0 && Math.abs(distMeasure - MAX_ZOOM_DISTANCE) < 1.0) { return; }
    if (distMeasure - dist < minH) { dist = distMeasure - minH - 1.0; }
    if (distMeasure - dist > MAX_ZOOM_DISTANCE) { dist = distMeasure - MAX_ZOOM_DISTANCE; }
    if (!Number.isFinite(dist) || Math.abs(dist) < 1e-6) { return; }

    cv.px += cv.dx * dist;
    cv.py += cv.dy * dist;
    cv.pz += cv.dz * dist;
}

// ════════════════════════════════════════════════════════════════
// doTilt3D — CesiumJS tilt3DOnTerrain (PR #9562 修正)
// ════════════════════════════════════════════════════════════════

/**
 * 在 tiltCenter 的 ENU 帧内做 rotate3D。
 * PR #9562 修正：先 vertical（绕 right），后 horizontal（绕 surface normal）。
 */
function doTilt3D(
    cv: CamVec,
    center: Float64Array,
    dxM: number, dyM: number,
    cW: number, cH: number,
): void {
    // position -= center
    cv.px -= center[0]; cv.py -= center[1]; cv.pz -= center[2];

    // center 处 surface normal（constrainedAxis 在 ECEF 中）
    const clng = Math.atan2(center[1], center[0]);
    const cp2d = Math.sqrt(center[0] * center[0] + center[1] * center[1]);
    const clat = Math.atan2(center[2], cp2d);
    const upCx = Math.cos(clat) * Math.cos(clng);
    const upCy = Math.cos(clat) * Math.sin(clng);
    const upCz = Math.sin(clat);

    // CesiumJS tilt3D 中 rate：在 UNIT_SPHERE 帧，rotateFactor=1, adj=1
    // → rate = 1 * (rho_local - 1) where rho_local = |relPos|/R
    const relLen = Math.sqrt(cv.px * cv.px + cv.py * cv.py + cv.pz * cv.pz);
    let rate = (relLen / WGS84_A) - 1.0;
    rate = Math.max(MIN_ROTATE_RATE, Math.min(MAX_ROTATE_RATE, rate));

    let phiR = Math.max(-MAX_MOVEMENT_RATIO, Math.min(MAX_MOVEMENT_RATIO, dxM / Math.max(cW, 1)));
    let thetaR = Math.max(-MAX_MOVEMENT_RATIO, Math.min(MAX_MOVEMENT_RATIO, dyM / Math.max(cH, 1)));

    const dPhi = rate * phiR * PI * 2.0;
    const dTheta = rate * thetaR * PI;

    // PR #9562：先垂直（绕 right），后水平（绕 surface normal）
    if (Math.abs(dTheta) > 1e-10) { cameraRotate(cv, cv.rx, cv.ry, cv.rz, dTheta); }
    if (Math.abs(dPhi) > 1e-10) { cameraRotate(cv, upCx, upCy, upCz, dPhi); }

    // CesiumJS 防 roll：将 right 约束到 cross(direction, constrainedAxis) 方向
    const crx = cv.dy * upCz - cv.dz * upCy;
    const cry = cv.dz * upCx - cv.dx * upCz;
    const crz = cv.dx * upCy - cv.dy * upCx;
    const crLen = Math.sqrt(crx * crx + cry * cry + crz * crz);
    if (crLen > 1e-6) {
        let nrx = crx / crLen, nry = cry / crLen, nrz = crz / crLen;
        if (nrx * cv.rx + nry * cv.ry + nrz * cv.rz < 0) { nrx = -nrx; nry = -nry; nrz = -nrz; }
        // up = cross(right, dir), right = cross(dir, up)
        cv.ux = nry * cv.dz - nrz * cv.dy;
        cv.uy = nrz * cv.dx - nrx * cv.dz;
        cv.uz = nrx * cv.dy - nry * cv.dx;
        cv.rx = cv.dy * cv.uz - cv.dz * cv.uy;
        cv.ry = cv.dz * cv.ux - cv.dx * cv.uz;
        cv.rz = cv.dx * cv.uy - cv.dy * cv.ux;
        let len = Math.sqrt(cv.ux * cv.ux + cv.uy * cv.uy + cv.uz * cv.uz);
        if (len > 1e-10) { cv.ux /= len; cv.uy /= len; cv.uz /= len; }
        len = Math.sqrt(cv.rx * cv.rx + cv.ry * cv.ry + cv.rz * cv.rz);
        if (len > 1e-10) { cv.rx /= len; cv.ry /= len; cv.rz /= len; }
    }

    // position += center
    cv.px += center[0]; cv.py += center[1]; cv.pz += center[2];
}

// ════════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════════

/**
 * @param camera3D - 相机
 * @param options - 功能开关
 * @param state - 共享可变拖拽状态
 * @param lifecycle - 销毁检查
 * @param _pickGlobeECEF - 保留签名兼容（实际帧内 pick 使用 screenRaySphereHit）
 * @param getViewport - 返回视口 CSS 像素 { width, height }
 */
export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    options: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
    state: GlobeInteractionState,
    lifecycle: { isDestroyed: () => boolean },
    _pickGlobeECEF: (screenX: number, screenY: number) => Float64Array | null,
    getViewport: () => { width: number; height: number },
): {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
} {
    // ── 左键状态（CesiumJS spin3D）──────────────────────
    /** 抓取点：mouseDown 时球面交点的归一化 ECEF 方向向量 */
    let _grabNorm: [number, number, number] | null = null;
    /** 拖拽模式：pan（球面旋转）/ rotate（trackball）/ look（自由视角） */
    let _spinMode: 'pan' | 'rotate' | 'look' = 'pan';
    /** 帧间鼠标位置（rotate3D/tilt3D 用增量） */
    let _prevMX = 0;
    let _prevMY = 0;

    // ── 中键状态（CesiumJS tilt3D）──────────────────────
    let _tiltCenter: Float64Array | null = null;
    let _tiltPrevMX = 0;
    let _tiltPrevMY = 0;

    // ── mouseDown ──────────────────────────────────────

    const onMouseDown = (e: MouseEvent) => {
        if (lifecycle.isDestroyed()) { return; }

        if (e.button === 0 && options.enableRotate) {
            // ═══ 左键：CesiumJS spin3D 初始化 ═══
            state.isDragging = true;
            state.dragButton = 0;
            _prevMX = e.clientX;
            _prevMY = e.clientY;
            _grabNorm = null;
            _spinMode = 'pan';

            // handlePanStart 重置惯性
            camera3D.handlePanStart(e.clientX, e.clientY);

            // 用 screenRaySphereHit 从当前 CamVec 拾取球面
            const vp = getViewport();
            const cv = getCamVec(camera3D);
            const hit = screenRaySphereHit(cv, e.clientX, e.clientY, vp.width, vp.height, DEFAULT_FOV);

            if (hit) {
                const len = Math.sqrt(hit[0] * hit[0] + hit[1] * hit[1] + hit[2] * hit[2]);
                if (len > 1.0) {
                    // 抓取点归一化为球面方向向量（mouseDown 锁定，整个拖拽不变）
                    _grabNorm = [hit[0] / len, hit[1] / len, hit[2] / len];
                    _spinMode = 'pan';
                } else {
                    _spinMode = 'rotate';
                }
            } else {
                // 未命中球面：高空→trackball，低空→look
                const h = camera3D.getPosition().alt;
                _spinMode = h > MIN_TRACKBALL_HEIGHT ? 'rotate' : 'look';
            }

        } else if (e.button === 1 && options.enableTilt) {
            // ═══ 中键：CesiumJS tilt3D 初始化 ═══
            e.preventDefault();
            state.isDragging = true;
            state.dragButton = 1;
            _tiltPrevMX = e.clientX;
            _tiltPrevMY = e.clientY;

            // 拾取 tilt center
            const vp = getViewport();
            const cv = getCamVec(camera3D);
            const hit = screenRaySphereHit(cv, e.clientX, e.clientY, vp.width, vp.height, DEFAULT_FOV);

            if (hit) {
                if (!_tiltCenter) { _tiltCenter = new Float64Array(3); }
                _tiltCenter[0] = hit[0]; _tiltCenter[1] = hit[1]; _tiltCenter[2] = hit[2];
            } else {
                _tiltCenter = null;
            }
        }
    };

    // ── mouseMove ──────────────────────────────────────

    const onMouseMove = (e: MouseEvent) => {
        if (!state.isDragging || lifecycle.isDestroyed()) { return; }

        if (state.dragButton === 0) {
            // ═══ 左键移动 ═══

            if (_spinMode === 'pan' && _grabNorm) {
                // ── CesiumJS pan3D（grab-point 旋转） ──
                // 用当前 CamVec 拾取当前鼠标位置 → p1
                // 计算旋转将 p1 对齐到 _grabNorm → 抓取点保持在光标下
                const vp = getViewport();
                const cv = getCamVec(camera3D);
                const hit = screenRaySphereHit(cv, e.clientX, e.clientY, vp.width, vp.height, DEFAULT_FOV);

                if (hit) {
                    const len = Math.sqrt(hit[0] * hit[0] + hit[1] * hit[1] + hit[2] * hit[2]);
                    if (len > 1.0) {
                        const n1x = hit[0] / len, n1y = hit[1] / len, n1z = hit[2] / len;
                        const g = _grabNorm;

                        // CesiumJS pan3D: axis = cross(p0, p1), angle = acos(dot)
                        // 这里 p0 = grabNorm（mouseDown 锁定），p1 = 当前 pick
                        // 旋转使 p1 移到 grabNorm 位置 → 抓取点跟随光标
                        const axX = n1y * g[2] - n1z * g[1];
                        const axY = n1z * g[0] - n1x * g[2];
                        const axZ = n1x * g[1] - n1y * g[0];
                        const axLen = Math.sqrt(axX * axX + axY * axY + axZ * axZ);

                        if (axLen > 1e-10) {
                            const dot = Math.max(-1, Math.min(1,
                                g[0] * n1x + g[1] * n1y + g[2] * n1z));
                            const angle = Math.acos(dot);

                            if (angle > 1e-9) {
                                // CesiumJS: camera.rotate(axis, angle)
                                cameraRotate(cv, axX / axLen, axY / axLen, axZ / axLen, angle);
                                setCamVec(camera3D, cv);
                            }
                        }
                    }
                }
                // 光标移出球面时不移动（CesiumJS 行为）

            } else if (_spinMode === 'rotate') {
                // ── CesiumJS rotate3D（trackball）──
                const dxM = _prevMX - e.clientX;
                const dyM = _prevMY - e.clientY;
                if (dxM !== 0 || dyM !== 0) {
                    const vp = getViewport();
                    const cv = getCamVec(camera3D);
                    doRotate3D(cv, dxM, dyM, vp.width, vp.height);
                    setCamVec(camera3D, cv);
                }
                _prevMX = e.clientX;
                _prevMY = e.clientY;

            } else {
                // ── look3D（自由视角）──
                camera3D.handleRotate(
                    -e.movementX * ROTATE_SENSITIVITY,
                    -e.movementY * ROTATE_SENSITIVITY,
                );
            }

        } else if (state.dragButton === 1) {
            // ═══ 中键：CesiumJS tilt3D ═══
            const dxM = _tiltPrevMX - e.clientX;
            const dyM = _tiltPrevMY - e.clientY;

            if (dxM === 0 && dyM === 0) { return; }

            if (_tiltCenter) {
                const vp = getViewport();
                const cv = getCamVec(camera3D);
                doTilt3D(cv, _tiltCenter, dxM, dyM, vp.width, vp.height);
                setCamVec(camera3D, cv);
            } else {
                camera3D.handleRotate(
                    -e.movementX * ROTATE_SENSITIVITY,
                    -e.movementY * ROTATE_SENSITIVITY,
                );
            }

            _tiltPrevMX = e.clientX;
            _tiltPrevMY = e.clientY;
        }
    };

    // ── mouseUp ────────────────────────────────────────

    const onMouseUp = (_e: MouseEvent) => {
        if (!state.isDragging) { return; }
        if (state.dragButton === 0) {
            camera3D.handlePanEnd();
            _grabNorm = null;
        }
        state.isDragging = false;
        state.dragButton = -1;
    };

    // ── wheel（CesiumJS zoom3D + handleZoom）────────────

    const onWheel = (e: WheelEvent) => {
        if (lifecycle.isDestroyed() || !options.enableZoom) { return; }
        e.preventDefault();

        let diff = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
        if (Math.abs(diff) < 0.1) { return; }

        const vp = getViewport();
        const cv = getCamVec(camera3D);
        const distMeasure = camera3D.getPosition().alt;
        doHandleZoom(cv, diff, vp.height, distMeasure);
        setCamVec(camera3D, cv);
    };

    // ── contextmenu ────────────────────────────────────

    const onContextMenu = (e: Event) => { e.preventDefault(); };

    return { onMouseDown, onMouseMove, onMouseUp, onWheel, onContextMenu };
}

// ════════════════════════════════════════════════════════════════
// runMorph
// ════════════════════════════════════════════════════════════════

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
        const t = Math.min((performance.now() - morphState.morphStartTime) / morphState.morphDuration, 1.0);
        if (t >= 1.0) {
            morphState.morphing = false;
            morphState.viewMode = morphState.morphTarget;
            emit('morph:complete', { mode: morphState.viewMode });
        } else { requestAnimationFrame(check); }
    };
    requestAnimationFrame(check);
}
