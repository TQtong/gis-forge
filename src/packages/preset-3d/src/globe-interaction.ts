/**
 * @module preset-3d/globe-interaction
 * @description
 * Globe3D 交互模块。实现鼠标左键拖拽旋转地球。
 *
 * 算法参考 CesiumJS `ScreenSpaceCameraController.pan3D`：
 *
 * **关键**：每帧用**当前相机**同时拾取两个屏幕点（上一帧鼠标位置 & 当前鼠标位置），
 * 计算**增量旋转**。两次拾取共享同一相机状态，因此不会因相机移动导致映射不一致。
 *
 * 若改为「mousedown 缓存 ECEF 锚点 + mousemove 拾取当前点」的方案，
 * 锚点是用旧相机拾取的，当前点是用新相机拾取的——屏幕→ECEF 映射已改变，
 * 导致每帧过度修正 → 反向修正 → **抖动**。
 *
 * @stability experimental
 */

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';

// ─── 常量 ───────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** WGS84 长半轴（米），球面近似用 */
const R_EARTH = 6378137.0;

// ─── scratch 缓冲区（零分配复用）─────────────────────────────

const _p0     = new Float64Array(3);
const _p1     = new Float64Array(3);
const _camE   = new Float64Array(3);
const _rotE   = new Float64Array(3);
const _axis   = new Float64Array(3);
const _nA     = new Float64Array(3);
const _nB     = new Float64Array(3);

// ─── 内联向量工具 ───────────────────────────────────────────

function dot3(a: Float64Array, b: Float64Array): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Float64Array, b: Float64Array, out: Float64Array): void {
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

function normalize3(v: Float64Array): boolean {
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (l < 1e-12) { return false; }
    v[0] /= l; v[1] /= l; v[2] /= l;
    return true;
}

/**
 * Rodrigues 旋转：v 绕单位轴 k 旋转 θ 弧度
 *   v_rot = v·cosθ + (k×v)·sinθ + k·(k·v)·(1−cosθ)
 */
function rodrigues(
    v: Float64Array, k: Float64Array, theta: number, out: Float64Array,
): void {
    const c  = Math.cos(theta);
    const s  = Math.sin(theta);
    const kv = dot3(k, v);
    const kx0 = k[1] * v[2] - k[2] * v[1];
    const kx1 = k[2] * v[0] - k[0] * v[2];
    const kx2 = k[0] * v[1] - k[1] * v[0];
    out[0] = v[0] * c + kx0 * s + k[0] * kv * (1 - c);
    out[1] = v[1] * c + kx1 * s + k[1] * kv * (1 - c);
    out[2] = v[2] * c + kx2 * s + k[2] * kv * (1 - c);
}

// ─── 坐标转换（球面近似，交互级精度足够）────────────────────

function toECEF(lonDeg: number, latDeg: number, alt: number, out: Float64Array): void {
    const lonR = lonDeg * DEG2RAD;
    const latR = latDeg * DEG2RAD;
    const r    = R_EARTH + alt;
    const cl   = Math.cos(latR);
    out[0] = r * cl * Math.cos(lonR);
    out[1] = r * cl * Math.sin(lonR);
    out[2] = r * Math.sin(latR);
}

function fromECEF(ecef: Float64Array): { lonDeg: number; latDeg: number; alt: number } {
    const x = ecef[0], y = ecef[1], z = ecef[2];
    return {
        lonDeg: Math.atan2(y, x) * RAD2DEG,
        latDeg: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG,
        alt:    Math.sqrt(x * x + y * y + z * z) - R_EARTH,
    };
}

// ─── 画布坐标工具 ───────────────────────────────────────────

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
 * ### 增量旋转算法（CesiumJS `pan3D` 等价）
 *
 * ```
 * mousedown:  记录屏幕坐标 (lastSX, lastSY)
 * mousemove:  P₀ = pickGlobe(lastSX, lastSY)   ← 用当前相机
 *             P₁ = pickGlobe(curSX, curSY)      ← 用当前相机（同一帧！）
 *             axis  = normalize(P₀ × P₁)
 *             angle = acos(dot(P₀_n, P₁_n))
 *             camera_ecef = rodrigues(camera_ecef, axis, angle)
 *             lastSX = curSX;  lastSY = curSY
 * ```
 *
 * 两次 pick 共享同一相机状态 → 无映射不一致 → 无抖动。
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
    /** 上一帧鼠标的画布坐标 */
    let lastSX = 0;
    let lastSY = 0;

    // ── mousedown ───────────────────────────────────────────
    const onMouseDown = (e: MouseEvent): void => {
        if (lifecycle.isDestroyed() || e.button !== 0 || !options.enableRotate) {
            return;
        }

        const [sx, sy] = canvasXY(e, canvas);

        // 先测试是否命中球面——未命中则不进入拖拽
        const picked = pickGlobeECEF(sx, sy);
        if (!picked) { return; }

        state.isDragging = true;
        state.dragButton = 0;
        lastSX = sx;
        lastSY = sy;
    };

    // ── mousemove ───────────────────────────────────────────
    const onMouseMove = (e: MouseEvent): void => {
        if (
            lifecycle.isDestroyed() ||
            !state.isDragging ||
            state.dragButton !== 0
        ) {
            return;
        }

        const [curSX, curSY] = canvasXY(e, canvas);

        // 微小移动跳过（避免浮点噪声）
        const dx = curSX - lastSX;
        const dy = curSY - lastSY;
        if (dx * dx + dy * dy < 0.25) { return; }

        // ── 用当前相机同时拾取两点（关键：共享同一相机状态！）──
        const picked0 = pickGlobeECEF(lastSX, lastSY);
        if (!picked0) {
            // 上一帧位置已不在球面上（相机移动导致），放弃本帧
            lastSX = curSX;
            lastSY = curSY;
            return;
        }
        _p0[0] = picked0[0]; _p0[1] = picked0[1]; _p0[2] = picked0[2];

        const picked1 = pickGlobeECEF(curSX, curSY);
        if (!picked1) {
            // 当前位置不在球面上，不更新 lastSX/SY，等回到球面再继续
            return;
        }
        _p1[0] = picked1[0]; _p1[1] = picked1[1]; _p1[2] = picked1[2];

        // ── 归一化为单位球方向 ──
        _nA[0] = _p0[0]; _nA[1] = _p0[1]; _nA[2] = _p0[2];
        _nB[0] = _p1[0]; _nB[1] = _p1[1]; _nB[2] = _p1[2];
        if (!normalize3(_nA) || !normalize3(_nB)) {
            lastSX = curSX; lastSY = curSY;
            return;
        }

        // ── 旋转轴 = P₁ × P₀ ──
        // 鼠标从 lastSX 拖到 curSX → P₁ 在 P₀ 的拖拽方向侧
        // 相机需向**反方向**旋转，使地球跟随鼠标（P₁×P₀ 而非 P₀×P₁）
        cross3(_nB, _nA, _axis);
        if (!normalize3(_axis)) {
            lastSX = curSX; lastSY = curSY;
            return;
        }

        // ── 旋转角 ──
        const d = Math.max(-1, Math.min(1, dot3(_nA, _nB)));
        const angle = Math.acos(d);
        if (angle < 1e-10) {
            lastSX = curSX; lastSY = curSY;
            return;
        }

        // ── 旋转相机 ECEF 位置 ──
        const pos = camera3D.getPosition();
        toECEF(pos.lon, pos.lat, pos.alt, _camE);
        rodrigues(_camE, _axis, angle, _rotE);

        // ── ECEF → 大地坐标 → 写回 Camera3D ──
        const geo = fromECEF(_rotE);
        geo.latDeg = Math.max(-89.999, Math.min(89.999, geo.latDeg));
        camera3D.setPosition(geo.lonDeg, geo.latDeg, pos.alt);

        // ── 更新 last 屏幕坐标 ──
        lastSX = curSX;
        lastSY = curSY;
    };

    // ── mouseup ─────────────────────────────────────────────
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