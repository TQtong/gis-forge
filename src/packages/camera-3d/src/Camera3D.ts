// ============================================================
// camera-3d/Camera3D.ts — ECEF 四向量相机（Cesium 兼容）
// 职责：Camera3D 接口、ECEF position/direction/up/right 四向量、
//       旋转/极地穿越/缩放原语、CameraController 接口实现。
// 对标：Cesium Camera.js — rotate / rotateVertical / rotateHorizontal
// ============================================================

import type { CameraAnimation, CameraConstraints, CameraController } from '../../runtime/src/camera-controller.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';
import { geodeticToECEF, ecefToGeodetic, surfaceNormal, WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import * as mat4 from '../../core/src/math/mat4.ts';

// ─── 常量 ────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** 地球周长（米），与 2D zoom 保持一致 */
const EARTH_CIRCUMFERENCE = 40075017;
/** 标准瓦片像素边长 */
const TILE_SIZE = 256;

/** 默认 zoom 范围 */
const DEFAULT_MIN_ZOOM = 0;
const DEFAULT_MAX_ZOOM = 22;
/** 默认 FOV（弧度） */
const DEFAULT_FOV = Math.PI / 4;

/** 极点检测 epsilon（≈cos(2.5°)） */
const EPSILON2 = 1e-2;
/** 角度 clamp 安全边距 */
const EPSILON4 = 1e-4;

/** 动画默认时长 */
const DEFAULT_ANIM_MS = 1500;
const MIN_ANIM_MS = 16;

/** 惯性阈值 */
const INERTIA_EPS = 1e-5;

// ─── Float64 向量工具 ────────────────────────────────────────

function v3Set(out: Float64Array, x: number, y: number, z: number): void {
    out[0] = x; out[1] = y; out[2] = z;
}

function v3Copy(out: Float64Array, a: Float64Array): void {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
}

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

function v3Negate(out: Float64Array, a: Float64Array): void {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
}

function v3EqualsEpsilon(a: Float64Array, b: Float64Array, eps: number): boolean {
    return Math.abs(a[0] - b[0]) <= eps &&
           Math.abs(a[1] - b[1]) <= eps &&
           Math.abs(a[2] - b[2]) <= eps;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function acosClamped(v: number): number {
    return Math.acos(clamp(v, -1, 1));
}

// ─── Float64 四元数 → 3×3 旋转（对标 Cesium Quaternion→Matrix3）───

/** 四元数 [x,y,z,w] from axis-angle */
function quatFromAxisAngle(out: Float64Array, axis: Float64Array, angle: number): void {
    const half = angle * 0.5;
    const s = Math.sin(half);
    out[0] = axis[0] * s;
    out[1] = axis[1] * s;
    out[2] = axis[2] * s;
    out[3] = Math.cos(half);
}

/** 3×3 rotation matrix from quaternion (column-major: m[col*3+row]) */
function mat3FromQuat(out: Float64Array, q: Float64Array): void {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    // column 0
    out[0] = 1 - yy - zz; out[1] = xy + wz;     out[2] = xz - wy;
    // column 1
    out[3] = xy - wz;     out[4] = 1 - xx - zz; out[5] = yz + wx;
    // column 2
    out[6] = xz + wy;     out[7] = yz - wx;     out[8] = 1 - xx - yy;
}

/** mat3 × vec3 (column-major) */
function mat3MulVec(out: Float64Array, m: Float64Array, v: Float64Array): void {
    const x = v[0], y = v[1], z = v[2];
    out[0] = m[0] * x + m[3] * y + m[6] * z;
    out[1] = m[1] * x + m[4] * y + m[7] * z;
    out[2] = m[2] * x + m[5] * y + m[8] * z;
}

// ─── Float64 4×4 矩阵工具（transform 切换用）────────────────

/** 4x4 列主序矩阵 × 点（齐次 w=1） */
function m4MulPoint(out: Float64Array, m: Float64Array, p: Float64Array): void {
    const x = p[0], y = p[1], z = p[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/** 4x4 列主序矩阵 × 向量（齐次 w=0，忽略平移列） */
function m4MulVec(out: Float64Array, m: Float64Array, v: Float64Array): void {
    const x = v[0], y = v[1], z = v[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
}

/**
 * Float64 4x4 矩阵求逆（仿射变换特化：旋转部分转置 + 平移部分重算）。
 * 前提：m 的 3×3 左上为正交矩阵（ENU 变换满足此条件）。
 */
function m4InvertAffine(out: Float64Array, m: Float64Array): void {
    // 旋转部分转置（行列互换）
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8];  out[3] = 0;
    out[4] = m[1]; out[5] = m[5]; out[6] = m[9];  out[7] = 0;
    out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = 0;
    // 平移部分：-R^T * t
    const tx = m[12], ty = m[13], tz = m[14];
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
    out[15] = 1;
}

/**
 * 在 ECEF 点 center 处构建 East-North-Up → Fixed 变换矩阵（4x4 列主序 Float64）。
 * 对标 Cesium Transforms.eastNorthUpToFixedFrame。
 *
 * @param out - 输出 Float64Array(16)，列主序 4x4
 * @param center - ECEF 坐标 Float64Array(3)
 *
 * @remarks
 * 极点退化处理：当 center 的 XY 分量接近零（= 极点），
 * 回退到固定 east=[sign,0,0] / north=[0,sign,0] / up=[0,0,sign]，
 * 对标 Cesium Transforms.js:181-211。
 */
export function eastNorthUpToFixedFrame(out: Float64Array, center: Float64Array): void {
    const cx = center[0], cy = center[1], cz = center[2];

    // 极点退化检测
    const xyLen = Math.sqrt(cx * cx + cy * cy);
    let ex: number, ey: number, ez: number;
    let nx: number, ny: number, nz: number;
    let ux: number, uy: number, uz: number;

    if (xyLen < 1e-14) {
        // 在极点：up = [0,0,sign(z)], east = [sign(z),0,0]
        const sign = cz >= 0 ? 1 : -1;
        ex = sign; ey = 0; ez = 0;
        nx = 0; ny = sign; nz = 0;
        ux = 0; uy = 0; uz = sign;
    } else {
        // up = normalize(center)（球面法线近似）
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
        const invLen = 1 / len;
        ux = cx * invLen; uy = cy * invLen; uz = cz * invLen;

        // east = normalize(cross([0,0,1], up)) = normalize([-cy, cx, 0])
        const invXY = 1 / xyLen;
        ex = -cy * invXY; ey = cx * invXY; ez = 0;

        // north = cross(up, east)
        nx = uy * ez - uz * ey;
        ny = uz * ex - ux * ez;
        nz = ux * ey - uy * ex;
    }

    // 列主序：col0=east, col1=north, col2=up, col3=center
    out[0] = ex;  out[1] = ey;  out[2] = ez;  out[3] = 0;
    out[4] = nx;  out[5] = ny;  out[6] = nz;  out[7] = 0;
    out[8] = ux;  out[9] = uy;  out[10] = uz; out[11] = 0;
    out[12] = cx; out[13] = cy; out[14] = cz; out[15] = 1;
}

// ─── 预分配暂存 ─────────────────────────────────────────────

const _quat = new Float64Array(4);
const _mat3 = new Float64Array(9);
const _tmpA = new Float64Array(3);
const _tmpB = new Float64Array(3);
const _tmpC = new Float64Array(3);
const _tmpD = new Float64Array(3);
const _geodetic = new Float64Array(3) as Vec3d;
const _targetECEF = new Float64Array(3) as Vec3d;
const _normalUp = new Float64Array(3) as Vec3d;

// Float32 缓冲（CameraState 输出）
const _viewMat = mat4.create();
const _projMat = mat4.create();
const _vpMat = mat4.create();
const _invVPMat = mat4.create();
const _posF32 = new Float32Array(3);
const _eyeF32 = new Float32Array(3);
const _centerF32 = new Float32Array(3);
const _upF32 = new Float32Array(3);

// ─── zoom ↔ altitude 换算 ───────────────────────────────────

function altFromZoom(z: number): number {
    return EARTH_CIRCUMFERENCE / (Math.pow(2, Math.max(0, z)) * TILE_SIZE);
}

function zoomFromAlt(alt: number): number {
    const a = Math.max(1, alt);
    return clamp(Math.log2(EARTH_CIRCUMFERENCE / (TILE_SIZE * a)), DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);
}

// ─── smoothstep 缓动 ────────────────────────────────────────

function smoothstep(t: number): number {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * clamp(t, 0, 1);
}

// ─── 动画句柄 ───────────────────────────────────────────────

function makeId(): string {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* */ }
    return `c3d-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

type AnimHandle = CameraAnimation & { _st: 'running' | 'finished' | 'cancelled'; _res?: () => void };

function mkHandle(id: string, onCancel: () => void): AnimHandle {
    let done = false;
    let res: (() => void) | undefined;
    const finished = new Promise<void>(r => { res = r; });
    const h: AnimHandle = {
        id, _st: 'running',
        get state() { return h._st; },
        cancel() {
            if (h._st !== 'running') return;
            h._st = 'cancelled';
            try { onCancel(); } catch { /* */ }
            if (!done && res) { done = true; res(); }
        },
        finished,
    };
    h._res = () => { if (!done && res) { done = true; res(); } };
    return h;
}

function finishHandle(h: AnimHandle): void {
    if (h._st !== 'running') return;
    h._st = 'finished';
    h._res?.();
}

// ─── Camera3D 接口 ──────────────────────────────────────────

export interface Camera3DOptions {
    readonly position?: { lon: number; lat: number; alt: number };
    readonly bearing?: number;
    readonly pitch?: number;
    readonly fov?: number;
    readonly minimumZoomDistance?: number;
    readonly maximumZoomDistance?: number;
    /**
     * 是否启用椭球碰撞检测（默认 true）。
     * 启用时所有改变 position 的原语（zoomIn / moveAlongDirection /
     * setPositionDirectionUp）都会做 ray-ellipsoid 求交拒入，
     * 保证相机不会穿透 (R + minimumZoomDistance) 的安全椭球。
     * 关闭时允许相机进入地球内部（地下视角，对标 Cesium
     * ScreenSpaceCameraController.enableCollisionDetection=false）。
     */
    readonly enableCollisionDetection?: boolean;
}

export interface Camera3D extends CameraController {
    readonly type: '3d';
    setPosition(lon: number, lat: number, alt: number): void;
    getPosition(): { lon: number; lat: number; alt: number };
    setHeadingPitchRoll(heading: number, pitch: number, roll: number): void;
    lookAt(target: [number, number, number], offset?: { heading?: number; bearing?: number; pitch?: number; range?: number }): void;
    readonly terrainCollisionEnabled: boolean;
    setTerrainCollisionEnabled(enabled: boolean): void;
    setMinAltitudeAboveTerrain(meters: number): void;
    queryTerrainHeight(lon: number, lat: number): Promise<number>;

    /**
     * 椭球碰撞检测开关。
     * 对标 Cesium ScreenSpaceCameraController.enableCollisionDetection。
     * 启用时（默认）相机不能穿透 (R + minimumZoomDistance) 椭球；
     * 关闭时允许相机进入地球内部（地下视角）。
     */
    readonly ellipsoidCollisionEnabled: boolean;
    setEllipsoidCollisionEnabled(enabled: boolean): void;

    /** 当前 minimumZoomDistance（米）——硬性配置下界 */
    readonly minimumZoomDistance: number;
    /** 当前 maximumZoomDistance（米） */
    readonly maximumZoomDistance: number;
    /**
     * 当前有效的最小高度（米）= max(minimumZoomDistance, minTerrainAlt)。
     * 由 globe-render 每帧基于最粗 LOD 弦割下沉量动态推送 minTerrainAlt。
     * globe-interaction.handleZoom 应使用这个值作为 minHeight，而不是裸 minimumZoomDistance。
     */
    readonly effectiveMinAltitude: number;
    flyToPosition(options: { lon: number; lat: number; alt: number; heading?: number; bearing?: number; pitch?: number; duration?: number }): CameraAnimation;

    getOrientation(): { bearing: number; pitch: number; roll: number };
    setOrientation(bearing: number, pitch: number, roll: number): void;

    // ━━ ECEF 访问（供 globe-interaction 使用）━━
    getPositionECEF(): Float64Array;
    getDirection(): Float64Array;
    getUp(): Float64Array;
    getRight(): Float64Array;
    getConstrainedAxis(): Float64Array | null;

    /**
     * 替换 constrainedAxis。传 null 则移除约束。
     * 对标 Cesium Camera.constrainedAxis setter。
     */
    setConstrainedAxis(axis: Float64Array | null): void;

    rotate(axis: Float64Array, angle: number): void;
    rotateRight(angle: number): void;
    rotateUp(angle: number): void;
    look(axis: Float64Array, angle: number): void;
    zoomIn(amount: number): void;
    moveAlongDirection(direction: Float64Array, distance: number): void;

    /**
     * 直接设置相机的 position/direction/up（ECEF 世界空间）。
     * 对标 Cesium handleZoom sub-path B 中直接写入 camera.position / camera.direction / camera.up。
     * 内部自动重正交化 right/up（Gram-Schmidt）并 clamp altitude。
     *
     * @param pos - 新的 ECEF 位置 (Float64Array[3])
     * @param dir - 新的视线方向（无需归一化，内部归一化）
     * @param up - 新的上方向参考（无需归一化，内部通过 cross 重正交化）
     */
    setPositionDirectionUp(pos: Float64Array, dir: Float64Array, up: Float64Array): void;

    /**
     * 将 position/direction/up 从世界空间转换到 transform 定义的局部空间。
     * 对标 Cesium Camera._setTransform：保存世界坐标快照，乘以逆变换写入局部坐标。
     * 调用后 getPositionECEF/getDirection/getUp 返回的是局部空间向量。
     * 必须与 restoreTransform 配对使用。
     */
    setTransform(transform: Float64Array): void;

    /**
     * 将 position/direction/up 从局部空间转换回世界空间。
     * 与 setTransform 配对调用。
     */
    restoreTransform(): void;
}

// ─── 工厂 ───────────────────────────────────────────────────

export function createCamera3D(opts: Camera3DOptions): Camera3D {
    // ─── 内部状态 ─────────────────────────────────────
    const _position = new Float64Array(3);
    const _direction = new Float64Array(3);
    const _up = new Float64Array(3);
    const _right = new Float64Array(3);
    let _constrainedAxis: Float64Array | null = new Float64Array([0, 0, 1]); // Z = north pole
    /** 备用轴（当 _constrainedAxis 为 null 时用于 bearing 计算等非轨道操作） */
    const _defaultAxis = new Float64Array([0, 0, 1]);

    // transform 切换状态（对标 Cesium Camera._setTransform）
    const _currentTransform = new Float64Array(16);
    const _invTransform = new Float64Array(16);
    let _hasTransform = false;

    const _fov = opts.fov ?? DEFAULT_FOV;
    // 默认值对标 Cesium ScreenSpaceCameraController：
    //   Cesium: minimumZoomDistance = 1.0, maximumZoomDistance = +Infinity
    // 这里取 0.1m 让用户能近距离贴近地面（街景级别）。
    // ⚠ 不要设置成 100 这种"高空"值——会出现"放大到一定程度卡住 + 近平面把地面裁掉"的现象。
    const _minZoomDist = opts.minimumZoomDistance ?? 0.1;
    const _maxZoomDist = opts.maximumZoomDistance ?? Number.POSITIVE_INFINITY;

    let _terrainCollision = false;
    let _minTerrainAlt = 10;

    // 椭球碰撞检测开关（对标 Cesium SSCC.enableCollisionDetection）
    let _ellipsoidCollision = opts.enableCollisionDetection ?? true;

    // 约束
    let _constraints: CameraConstraints = {
        minZoom: DEFAULT_MIN_ZOOM,
        maxZoom: DEFAULT_MAX_ZOOM,
        minPitch: 0,
        maxPitch: HALF_PI,
    };

    // 动画
    type FlyAnim = {
        id: string;
        startMs: number;
        durationMs: number;
        from: { pos: Float64Array; dir: Float64Array; up: Float64Array };
        to: { pos: Float64Array; dir: Float64Array; up: Float64Array };
        handle: AnimHandle;
    };
    let _anim: FlyAnim | null = null;

    // 事件回调
    const _onMoveStart: Set<() => void> = new Set();
    const _onMove: Set<(s: CameraState) => void> = new Set();
    const _onMoveEnd: Set<() => void> = new Set();
    let _moving = false;

    // 惯性（简化：3D 交互由 globe-interaction 驱动，惯性在那里处理）
    let _inertiaEnabled = true;

    // 最新 CameraState 缓存
    let _cachedState: CameraState = _makeState({ width: 1, height: 1, physicalWidth: 1, physicalHeight: 1, pixelRatio: 1 });

    // ─── 初始化 ───────────────────────────────────────

    function _initFromGeodetic(lonDeg: number, latDeg: number, alt: number, bearing: number, pitch: number): void {
        const lonR = lonDeg * DEG2RAD;
        const latR = latDeg * DEG2RAD;
        const safeAlt = clamp(alt, _minZoomDist, _maxZoomDist);

        // 相机 ECEF 位置
        geodeticToECEF(_position as Vec3d, lonR, latR, safeAlt);

        // 地表正下方
        geodeticToECEF(_targetECEF, lonR, latR, 0);

        // 地表法线（局部 up）
        surfaceNormal(_normalUp, lonR, latR);

        // direction = normalize(target - position)（即向下看向地表）
        v3Sub(_direction, _targetECEF, _position);
        v3Normalize(_direction, _direction);

        // 构建正交基：直接从经度计算 east 方向，
        // 避免 cross(direction, normalUp) 在 nadir（direction ≈ -normalUp）时退化为零向量。
        // east = (-sin(lon), cos(lon), 0)——赤道平面上始终垂直于径向，长度恒为 1。
        _right[0] = -Math.sin(lonR);
        _right[1] = Math.cos(lonR);
        _right[2] = 0;
        // up = cross(right, direction)：nadir 时等价于 north 方向
        v3Cross(_up, _right, _direction);
        v3Normalize(_up, _up);

        // 应用 pitch: 绕 right 旋转。pitch < 0 表示俯视（默认状态下 direction 已经是正下方）
        // Cesium 约定：pitch=0 对应水平看，pitch=-π/2 对应正下方看
        // 我们的初始 direction 指向地心（≈-π/2 pitch），需要先调整到水平，再加 pitch
        // 但 globe-3d.ts 传入 pitch=-45°*DEG2RAD 表示"45度俯视"
        // 所以：从正下方开始，rotateUp(π/2 + pitch) 把视线提升到水平+pitch
        if (Math.abs(pitch + HALF_PI) > 0.001) {
            // 当前是正下方（-π/2），需要旋转到目标 pitch
            const rotateDelta = -(HALF_PI + pitch); // 负号因为从正下方往水平方向旋转
            _applyRotate(_right, rotateDelta);
        }

        // 应用 bearing: 绕 constrainedAxis 旋转
        if (Math.abs(bearing) > 0.001) {
            _applyRotate(_constrainedAxis ?? _defaultAxis, -bearing);
        }
    }

    const initPos = opts.position ?? { lon: 0, lat: 0, alt: 1e7 };
    const initBearing = opts.bearing ?? 0;
    const initPitch = opts.pitch ?? -HALF_PI * 0.5; // 默认 -45 度俯视
    _initFromGeodetic(initPos.lon, initPos.lat, initPos.alt, initBearing, initPitch);

    // ─── 旋转原语（对标 Cesium Camera.rotate）────────

    /**
     * 绕 axis 旋转 angle 弧度。
     * 对标 Cesium Camera.js:2027-2048。
     * 旋转 position、direction、up 三个向量，然后重正交化。
     */
    function _applyRotate(axis: Float64Array, angle: number): void {
        // 四元数 from axis-angle（Cesium 用 -turnAngle）
        quatFromAxisAngle(_quat, axis, -angle);
        mat3FromQuat(_mat3, _quat);

        // 旋转 position
        mat3MulVec(_tmpA, _mat3, _position);
        v3Copy(_position, _tmpA);

        // 旋转 direction
        mat3MulVec(_tmpA, _mat3, _direction);
        v3Copy(_direction, _tmpA);

        // 旋转 up
        mat3MulVec(_tmpA, _mat3, _up);
        v3Copy(_up, _tmpA);

        // Gram-Schmidt 重正交化
        v3Cross(_right, _direction, _up);
        v3Normalize(_right, _right);
        v3Cross(_up, _right, _direction);
        v3Normalize(_up, _up);
    }

    /**
     * 水平旋转。对标 Cesium rotateHorizontal (Camera.js:2162-2168)。
     * 有 constrainedAxis 时绕约束轴旋转（经度方向），否则绕 up 旋转。
     */
    function _rotateRight(angle: number): void {
        if (_constrainedAxis) {
            _applyRotate(_constrainedAxis, -angle);
        } else {
            _applyRotate(_up, -angle);
        }
    }

    /**
     * 垂直旋转（含极地检测）。对标 Cesium rotateVertical (Camera.js:2080-2134)。
     */
    function _rotateUp(angle: number): void {
        const a = -angle; // Cesium: rotateUp 调用 rotateVertical(-angle)

        // 无约束轴或位置在原点 → 绕 right 自由旋转（对标 Cesium rotateVertical outer else）
        if (!_constrainedAxis ||
            v3EqualsEpsilon(_position, new Float64Array(3), EPSILON2)) {
            _applyRotate(_right, a);
            return;
        }

        // 归一化位置
        v3Normalize(_tmpA, _position);

        // 北极检测
        const northParallel = v3EqualsEpsilon(_tmpA, _constrainedAxis, EPSILON2);
        // 南极检测
        v3Negate(_tmpB, _constrainedAxis);
        const southParallel = v3EqualsEpsilon(_tmpA, _tmpB, EPSILON2);

        if (!northParallel && !southParallel) {
            // 非极点：计算到极点的角度并 clamp
            let dot = v3Dot(_tmpA, _constrainedAxis);
            let angleToAxis = acosClamped(dot);
            let clampedAngle = a;

            if (clampedAngle > 0 && clampedAngle > angleToAxis) {
                clampedAngle = angleToAxis - EPSILON4;
            }

            v3Negate(_tmpB, _constrainedAxis);
            dot = v3Dot(_tmpA, _tmpB);
            angleToAxis = acosClamped(dot);
            if (clampedAngle < 0 && -clampedAngle > angleToAxis) {
                clampedAngle = -angleToAxis + EPSILON4;
            }

            // tangent = cross(constrainedAxis, p)
            v3Cross(_tmpC, _constrainedAxis, _tmpA);
            v3Normalize(_tmpC, _tmpC);
            _applyRotate(_tmpC, clampedAngle);
        } else if ((northParallel && a < 0) || (southParallel && a > 0)) {
            // 在极点且旋转方向"离开"极点 → 绕 right 旋转
            _applyRotate(_right, a);
        }
        // 其他情况（在极点但旋转方向"更深入"极点）→ 不旋转
    }

    /**
     * 仅旋转 direction/up/right（不动 position）。对标 Cesium Camera.look。
     */
    function _look(axis: Float64Array, angle: number): void {
        quatFromAxisAngle(_quat, axis, -angle);
        mat3FromQuat(_mat3, _quat);

        mat3MulVec(_tmpA, _mat3, _direction);
        v3Copy(_direction, _tmpA);

        mat3MulVec(_tmpA, _mat3, _up);
        v3Copy(_up, _tmpA);

        v3Cross(_right, _direction, _up);
        v3Normalize(_right, _right);
        v3Cross(_up, _right, _direction);
        v3Normalize(_up, _up);
    }

    // ─── 高度约束 ─────────────────────────────────────
    //
    // 设计：position 原语只做"硬上界"和退化兜底，**不做几何拒入**。
    // 真正的"防穿透"由 globe-interaction.handleZoom Phase 1 的
    //   if (distanceMeasure - distance < minHeight) distance = distanceMeasure - minHeight - 1.0
    // 完成——这是 Cesium ScreenSpaceCameraController.handleZoom 的原始逻辑
    // （ScreenSpaceCameraController.js:611）。前提是 distanceMeasure 必须是
    // **相机的几何高度 (alt)**，而不是切向锚点距离。
    //
    // _clampAltitude 在这里只兜底两件事：
    //   1. alt > maxZoomDist 时拉回 maxZoomDist（数值上不会发生穿透）
    //   2. _ellipsoidCollision = true 且 alt < minZoomDist 时，沿法线推回安全壳
    //      （处理 setPosition / flyTo 等绕开 handleZoom 的入口）

    function _getAlt(): number {
        ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
        return _geodetic[2];
    }

    function _clampAltitude(): void {
        ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
        const alt = _geodetic[2];
        // 下界 = max(minimumZoomDistance, minTerrainAlt)
        //   minTerrainAlt 由 globe-render 每帧根据当前最粗 LOD 的弦割下沉量推送，
        //   防止相机进入 mesh 多边形面之下产生 backface culling 黑洞。
        const lo = _ellipsoidCollision
            ? Math.max(_minZoomDist, _minTerrainAlt)
            : -Infinity;
        const hi = _maxZoomDist;
        if (alt < lo || alt > hi) {
            const clamped = alt < lo ? lo : hi;
            // 沿地表法线方向调整位置
            surfaceNormal(_normalUp, _geodetic[0], _geodetic[1]);
            const delta = clamped - alt;
            v3ScaleAndAdd(_position, _position, _normalUp, delta);
        }
    }

    // ─── CameraState 构建 ─────────────────────────────

    function _makeState(vp: Viewport): CameraState {
        ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
        const lonDeg = _geodetic[0] * RAD2DEG;
        const latDeg = _geodetic[1] * RAD2DEG;
        const alt = _geodetic[2];

        // center：射线与椭球交点（简化：当前位置正下方）
        // 精确做法需要 ray-ellipsoid 交点，但对于近俯视状态正下方是很好的近似
        const centerLon = lonDeg;
        const centerLat = latDeg;

        const zoom = zoomFromAlt(alt);

        // bearing: direction 在水平面上的方位角
        // 在地表法线坐标系中，east = cross([0,0,1], normal), north = cross(normal, east)
        surfaceNormal(_normalUp, _geodetic[0], _geodetic[1]);

        // east = cross(constrainedAxis, normalUp)... 但更准确的做法：
        // 投影 direction 到水平面，计算与北方的角度
        // north = 沿经线方向 = cross(normalUp, east_approx)
        // 简化计算 bearing
        const _axisForBearing = _constrainedAxis ?? _defaultAxis;
        v3Cross(_tmpA, _axisForBearing, _normalUp); // east_ish
        const eastLen = v3Length(_tmpA);
        let bearing = 0;
        if (eastLen > 1e-10) {
            v3Normalize(_tmpA, _tmpA); // east
            v3Cross(_tmpB, _normalUp, _tmpA); // north
            v3Normalize(_tmpB, _tmpB);
            // project direction onto horizontal plane
            const de = v3Dot(_direction, _tmpA); // east component
            const dn = v3Dot(_direction, _tmpB); // north component
            bearing = Math.atan2(de, dn); // 0=north, π/2=east
        }

        // pitch: angle between direction and surface normal
        // pitch = acos(-dot(direction, normalUp)) - π/2
        // dot(dir, -normalUp) = cos(angle_from_nadir)
        const dotDN = -v3Dot(_direction, _normalUp);
        const pitch = Math.asin(clamp(dotDN, -1, 1)) - HALF_PI;

        // 构建矩阵（Float32 精度 for GPU）
        const w = Math.max(1, vp.width);
        const h = Math.max(1, vp.height);
        const aspect = w / h;

        // ─── near/far 平面 ───
        //
        // 关键约束：sky shader 写 NDC depth = 0.9999（"几乎最远"）。
        // 对于 WebGPU [0,1] 深度，距离 d 处 tile 的 NDC depth =
        //   (f/(f-n)) × (1 - n/d)
        // 要让 tile 赢过 sky（depth < 0.9999），必须 n/d > 0.0001，即 **d < 10000·n**。
        //
        // 因此 nearZ 不能太小——否则远处地面深度全部 ≈ 1.0 被 sky 盖住。
        // 设 nearZ ≈ alt * 0.5 即可：
        //   - 相机正下方地面距离 = alt → d/n = 2 → NDC ≈ 0.5（远低于 0.9999）✓
        //   - 距离 d = 10·alt 的地面 → d/n = 20 → NDC ≈ 0.95 ✓
        //   - 距离 d = 100·alt 的地面 → NDC ≈ 0.995 ✓
        //   - 距离 d = 5000·alt 的地面 → NDC ≈ 0.9998 ✓（刚好 < 0.9999）
        //
        // 这样 horizonDist ≈ √(2Rh) 范围内的所有地面都能正确渲染。
        const R = WGS84_A;
        const safeAlt = Math.max(alt, 0.1);
        // nearZ = alt 的一半，floor 0.1m（极近距离贴地）
        // 不能 ≥ alt，否则正下方地面被 near 平面裁掉
        let nearZ = Math.max(0.1, safeAlt * 0.5);
        // 强约束：留 1cm 余量保证 nearZ < alt
        nearZ = Math.min(nearZ, Math.max(safeAlt - 0.01, 0.1));

        const horizonDist = alt > 0 ? Math.sqrt((R + alt) * (R + alt) - R * R) : R;
        // farZ 覆盖整个可见地面 + 一点冗余
        let farZ = horizonDist * 2.0 + alt + nearZ * 10;
        // 极端情况：保证 far > near
        if (farZ <= nearZ) farZ = nearZ * 100;

        mat4.perspective(_projMat, _fov, aspect, nearZ, farZ);

        // RTE view matrix: eye at origin, target = direction（使用实际视线方向，不假设俯视）
        _eyeF32[0] = 0; _eyeF32[1] = 0; _eyeF32[2] = 0;

        // target = direction（lookAt 需要一个目标点，用 direction 作为相对偏移）
        _centerF32[0] = _direction[0];
        _centerF32[1] = _direction[1];
        _centerF32[2] = _direction[2];

        _upF32[0] = _up[0]; _upF32[1] = _up[1]; _upF32[2] = _up[2];

        mat4.lookAt(_viewMat, _eyeF32, _centerF32, _upF32);
        mat4.multiply(_vpMat, _projMat, _viewMat);
        mat4.invert(_invVPMat, _vpMat);

        _posF32[0] = _position[0]; _posF32[1] = _position[1]; _posF32[2] = _position[2];

        return {
            center: [centerLon, centerLat],
            zoom,
            bearing,
            pitch,
            viewMatrix: new Float32Array(_viewMat),
            projectionMatrix: new Float32Array(_projMat),
            vpMatrix: new Float32Array(_vpMat),
            inverseVPMatrix: new Float32Array(_invVPMat),
            position: new Float32Array(_posF32),
            altitude: alt,
            fov: _fov,
            roll: 0,
        };
    }

    // ─── 动画推进 ─────────────────────────────────────

    function _tickAnim(now: number): boolean {
        if (!_anim) return false;
        const elapsed = now - _anim.startMs;
        const t = clamp(elapsed / _anim.durationMs, 0, 1);
        const s = smoothstep(t);

        // SLERP position on unit sphere + interpolate altitude
        const fromPos = _anim.from.pos;
        const toPos = _anim.to.pos;

        // 简化：线性插值 ECEF 然后投影到正确高度
        for (let i = 0; i < 3; i++) {
            _position[i] = fromPos[i] + (toPos[i] - fromPos[i]) * s;
            _direction[i] = _anim.from.dir[i] + (_anim.to.dir[i] - _anim.from.dir[i]) * s;
            _up[i] = _anim.from.up[i] + (_anim.to.up[i] - _anim.from.up[i]) * s;
        }
        v3Normalize(_direction, _direction);
        v3Normalize(_up, _up);
        v3Cross(_right, _direction, _up);
        v3Normalize(_right, _right);
        v3Cross(_up, _right, _direction);
        v3Normalize(_up, _up);

        if (t >= 1) {
            finishHandle(_anim.handle);
            _anim = null;
            return false;
        }
        return true;
    }

    // ─── 公共 API（Camera3D + CameraController）──────

    const cam: Camera3D = {
        type: '3d' as const,

        get state() { return _cachedState; },

        // ─── 地理位置 API ────────────────────────────

        setCenter(center: [number, number]) {
            cam.setPosition(center[0], center[1], _getAlt());
        },

        setZoom(zoom: number) {
            const alt = altFromZoom(clamp(zoom, _constraints.minZoom, _constraints.maxZoom));
            ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
            cam.setPosition(_geodetic[0] * RAD2DEG, _geodetic[1] * RAD2DEG, alt);
        },

        setBearing(b: number) {
            // 计算当前 bearing 差值并旋转
            ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
            surfaceNormal(_normalUp, _geodetic[0], _geodetic[1]);
            v3Cross(_tmpA, _constrainedAxis ?? _defaultAxis, _normalUp);
            const eastLen = v3Length(_tmpA);
            if (eastLen > 1e-10) {
                v3Normalize(_tmpA, _tmpA);
                v3Cross(_tmpB, _normalUp, _tmpA);
                v3Normalize(_tmpB, _tmpB);
                const de = v3Dot(_direction, _tmpA);
                const dn = v3Dot(_direction, _tmpB);
                const currentBearing = Math.atan2(de, dn);
                const delta = b - currentBearing;
                _rotateRight(delta);
            }
        },

        setPitch(_p: number) {
            // pitch 调整在 3D 模式中通过 rotateUp 实现
            // 简化：不直接支持 setPitch，由交互层驱动
        },

        jumpTo(options) {
            if (_anim) { _anim.handle.cancel(); _anim = null; }
            const pos = cam.getPosition();
            const lon = options.center?.[0] ?? pos.lon;
            const lat = options.center?.[1] ?? pos.lat;
            const alt = options.zoom != null ? altFromZoom(options.zoom) : pos.alt;
            _initFromGeodetic(lon, lat, alt, options.bearing ?? 0, options.pitch ?? -HALF_PI * 0.5);
        },

        flyTo(options) {
            return cam.flyToPosition({
                lon: options.center?.[0] ?? cam.getPosition().lon,
                lat: options.center?.[1] ?? cam.getPosition().lat,
                alt: options.zoom != null ? altFromZoom(options.zoom) : cam.getPosition().alt,
                heading: options.bearing,
                pitch: options.pitch,
                duration: options.duration,
            });
        },

        easeTo(options) {
            return cam.flyTo({ ...options, duration: options.duration ?? 600 });
        },

        stop() {
            if (_anim) { _anim.handle.cancel(); _anim = null; }
        },

        get isAnimating() { return _anim != null; },

        get constraints() { return _constraints; },
        setConstraints(c: Partial<CameraConstraints>) {
            _constraints = { ..._constraints, ...c };
        },

        // ─── 每帧更新 ───────────────────────────────

        update(deltaTime: number, viewport: Viewport): CameraState {
            const now = performance.now();
            _tickAnim(now);
            _cachedState = _makeState(viewport);

            // 事件通知
            for (const cb of _onMove) {
                try { cb(_cachedState); } catch { /* */ }
            }

            return _cachedState;
        },

        // ─── 交互入口（由 globe-interaction 驱动）────

        handlePanStart(_sx: number, _sy: number) { /* noop — globe-interaction manages */ },
        handlePanMove(_sx: number, _sy: number) { /* noop */ },
        handlePanEnd() { /* noop */ },
        handleZoom(delta: number, _sx: number, _sy: number) {
            const alt = _getAlt();
            const amount = alt * 0.001 * delta;
            v3ScaleAndAdd(_position, _position, _direction, amount);
            _clampAltitude();
        },
        handleRotate(bearingDelta: number, pitchDelta: number) {
            if (Math.abs(bearingDelta) > 1e-8) _rotateRight(-bearingDelta);
            if (Math.abs(pitchDelta) > 1e-8) _rotateUp(pitchDelta);
        },

        get inertiaEnabled() { return _inertiaEnabled; },
        setInertiaEnabled(enabled: boolean) { _inertiaEnabled = enabled; },

        onMoveStart(cb: () => void) {
            _onMoveStart.add(cb);
            return () => { _onMoveStart.delete(cb); };
        },
        onMove(cb: (s: CameraState) => void) {
            _onMove.add(cb);
            return () => { _onMove.delete(cb); };
        },
        onMoveEnd(cb: () => void) {
            _onMoveEnd.add(cb);
            return () => { _onMoveEnd.delete(cb); };
        },

        destroy() {
            if (_anim) { _anim.handle.cancel(); _anim = null; }
            _onMoveStart.clear();
            _onMove.clear();
            _onMoveEnd.clear();
        },

        // ─── 3D 专用 API ────────────────────────────

        setPosition(lon: number, lat: number, alt: number) {
            // ⚠ 必须传 pitch = -HALF_PI（nadir），否则 _initFromGeodetic 内部的
            // `if (Math.abs(pitch + HALF_PI) > 0.001) _applyRotate(_right, ...)`
            // 会**绕地心旋转相机位置**，把相机从目标经纬度挪走。
            //
            // 之前的 `-HALF_PI * 0.5` 会强制 45° 旋转：
            //   setPosition(116.4, 39.9, 500) → 实际到 (116.4, -5.3, -8072)
            // 即 lat 偏移 45°，alt 变成地下。
            //
            // 姿态应该由调用方随后用 setHeadingPitchRoll/setOrientation 显式设置。
            _initFromGeodetic(lon, lat, clamp(alt, _minZoomDist, _maxZoomDist), 0, -HALF_PI);
        },

        getPosition() {
            ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
            return { lon: _geodetic[0] * RAD2DEG, lat: _geodetic[1] * RAD2DEG, alt: _geodetic[2] };
        },

        setHeadingPitchRoll(heading: number, pitch: number, _roll: number) {
            // 从当前位置重新计算方向（nadir 基准）
            ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
            geodeticToECEF(_targetECEF, _geodetic[0], _geodetic[1], 0);
            v3Sub(_direction, _targetECEF, _position);
            v3Normalize(_direction, _direction);
            surfaceNormal(_normalUp, _geodetic[0], _geodetic[1]);
            // 直接从经度计算 east，避免 cross(direction, normalUp) 在 nadir 时退化
            _right[0] = -Math.sin(_geodetic[0]);
            _right[1] = Math.cos(_geodetic[0]);
            _right[2] = 0;
            v3Cross(_up, _right, _direction);
            v3Normalize(_up, _up);

            // ⚠ 只能用 _look（原地旋转 direction/up/right）——
            // 不能用 _applyRotate（_applyRotate 会把 position 一起旋转 →
            // 每次 setOrientation 相机都会被搬到地球另一侧）。
            if (Math.abs(pitch + HALF_PI) > 0.001) {
                const rotateDelta = -(HALF_PI + pitch);
                _look(_right, rotateDelta);
            }
            if (Math.abs(heading) > 0.001) {
                _look(_constrainedAxis ?? _defaultAxis, -heading);
            }
        },

        lookAt(target: [number, number, number], offset?: { heading?: number; bearing?: number; pitch?: number; range?: number }) {
            const tLonR = target[0] * DEG2RAD;
            const tLatR = target[1] * DEG2RAD;
            const tAlt = target[2] ?? 0;
            const range = offset?.range ?? 1e6;
            const heading = offset?.heading ?? offset?.bearing ?? 0;
            const pitch = offset?.pitch ?? -HALF_PI * 0.5;

            // 目标 ECEF
            geodeticToECEF(_targetECEF, tLonR, tLatR, tAlt);
            // 在目标点构建 ENU 坐标系
            surfaceNormal(_normalUp, tLonR, tLatR);
            v3Cross(_tmpA, _constrainedAxis ?? _defaultAxis, _normalUp); // east
            v3Normalize(_tmpA, _tmpA);
            v3Cross(_tmpB, _normalUp, _tmpA); // north
            v3Normalize(_tmpB, _tmpB);

            // 相机在 ENU 中的偏移
            const cosP = Math.cos(pitch);
            const sinP = Math.sin(pitch);
            const cosH = Math.cos(heading);
            const sinH = Math.sin(heading);
            for (let i = 0; i < 3; i++) {
                _position[i] = _targetECEF[i]
                    + range * cosP * sinH * _tmpA[i]   // east
                    + range * cosP * cosH * _tmpB[i]   // north
                    + range * sinP * _normalUp[i];     // up
            }

            // direction = normalize(target - position)
            v3Sub(_direction, _targetECEF, _position);
            v3Normalize(_direction, _direction);
            v3Copy(_up, _normalUp);
            v3Cross(_right, _direction, _up);
            v3Normalize(_right, _right);
            v3Cross(_up, _right, _direction);
            v3Normalize(_up, _up);
        },

        getOrientation() {
            ecefToGeodetic(_geodetic, _position[0], _position[1], _position[2]);
            surfaceNormal(_normalUp, _geodetic[0], _geodetic[1]);

            // bearing
            v3Cross(_tmpA, _constrainedAxis ?? _defaultAxis, _normalUp);
            const eastLen = v3Length(_tmpA);
            let bearing = 0;
            if (eastLen > 1e-10) {
                v3Normalize(_tmpA, _tmpA); // east
                v3Cross(_tmpB, _normalUp, _tmpA); // north
                v3Normalize(_tmpB, _tmpB);
                const de = v3Dot(_direction, _tmpA);
                const dn = v3Dot(_direction, _tmpB);
                bearing = Math.atan2(de, dn);
            }

            // pitch
            const dotDN = -v3Dot(_direction, _normalUp);
            const pitch = Math.asin(clamp(dotDN, -1, 1)) - HALF_PI;

            return { bearing, pitch, roll: 0 };
        },

        setOrientation(bearing: number, pitch: number, roll: number) {
            cam.setHeadingPitchRoll(bearing, pitch, roll);
        },

        get terrainCollisionEnabled() { return _terrainCollision; },
        setTerrainCollisionEnabled(enabled: boolean) { _terrainCollision = enabled; },
        setMinAltitudeAboveTerrain(meters: number) { _minTerrainAlt = meters; },
        async queryTerrainHeight(_lon: number, _lat: number): Promise<number> { return 0; },

        get ellipsoidCollisionEnabled() { return _ellipsoidCollision; },
        setEllipsoidCollisionEnabled(enabled: boolean) {
            _ellipsoidCollision = enabled;
            // 启用时立刻把当前位置拉回安全椭球外（防止从 underground 模式切回时滞留）
            if (enabled) _clampAltitude();
        },

        get minimumZoomDistance() { return _minZoomDist; },
        get maximumZoomDistance() { return _maxZoomDist; },
        get effectiveMinAltitude() {
            return Math.max(_minZoomDist, _minTerrainAlt);
        },

        flyToPosition(options) {
            if (_anim) { _anim.handle.cancel(); _anim = null; }

            const fromPos = new Float64Array(_position);
            const fromDir = new Float64Array(_direction);
            const fromUp = new Float64Array(_up);

            // 构建目标状态
            const targetCam = createCamera3D({
                position: { lon: options.lon, lat: options.lat, alt: options.alt },
                bearing: options.heading ?? options.bearing ?? 0,
                pitch: options.pitch ?? -HALF_PI * 0.5,
                fov: _fov,
                minimumZoomDistance: _minZoomDist,
                maximumZoomDistance: _maxZoomDist,
            });
            const toPos = new Float64Array(targetCam.getPositionECEF());
            const toDir = new Float64Array(targetCam.getDirection());
            const toUp = new Float64Array(targetCam.getUp());
            targetCam.destroy();

            const duration = Math.max(options.duration ?? DEFAULT_ANIM_MS, MIN_ANIM_MS);
            const id = makeId();
            const handle = mkHandle(id, () => { _anim = null; });

            _anim = {
                id,
                startMs: performance.now(),
                durationMs: duration,
                from: { pos: fromPos, dir: fromDir, up: fromUp },
                to: { pos: toPos, dir: toDir, up: toUp },
                handle,
            };
            return handle;
        },

        // ─── ECEF 直接访问 ──────────────────────────

        getPositionECEF() { return _position; },
        getDirection() { return _direction; },
        getUp() { return _up; },
        getRight() { return _right; },
        getConstrainedAxis() { return _constrainedAxis; },

        setConstrainedAxis(axis: Float64Array | null) {
            if (axis) {
                // 原地写入而非替换引用——减少 GC 压力
                if (!_constrainedAxis) _constrainedAxis = new Float64Array(3);
                _constrainedAxis[0] = axis[0];
                _constrainedAxis[1] = axis[1];
                _constrainedAxis[2] = axis[2];
            } else {
                _constrainedAxis = null;
            }
        },

        rotate(axis: Float64Array, angle: number) { _applyRotate(axis, angle); },
        rotateRight(angle: number) { _rotateRight(angle); },
        rotateUp(angle: number) { _rotateUp(angle); },
        look(axis: Float64Array, angle: number) { _look(axis, angle); },

        zoomIn(amount: number) {
            // 对标 Cesium Camera.zoomIn —— 沿视线方向直接前进。
            // 防穿透由调用方（globe-interaction.handleZoom Phase 1）保证：
            //   if (distanceMeasure - distance < minHeight) distance = distanceMeasure - minHeight - 1
            v3ScaleAndAdd(_position, _position, _direction, amount);
            _clampAltitude();
        },

        moveAlongDirection(dir: Float64Array, dist: number) {
            v3ScaleAndAdd(_position, _position, dir, dist);
            _clampAltitude();
        },

        setPositionDirectionUp(pos: Float64Array, dir: Float64Array, up: Float64Array) {
            // 对标 Cesium handleZoom sub-path B：直接写入 position/direction/up/right
            v3Copy(_position, pos);
            v3Copy(_direction, dir);
            v3Normalize(_direction, _direction);
            // Gram-Schmidt 重正交化：right = normalize(cross(direction, up))
            v3Cross(_right, _direction, up);
            v3Normalize(_right, _right);
            // up = normalize(cross(right, direction))
            v3Cross(_up, _right, _direction);
            v3Normalize(_up, _up);
            _clampAltitude();
        },

        // ─── transform 切换（对标 Cesium Camera._setTransform）───

        setTransform(transform: Float64Array) {
            // 1. 保存变换矩阵，计算逆矩阵
            _currentTransform.set(transform);
            m4InvertAffine(_invTransform, transform);

            // 2. 将 position/direction/up 从世界空间转到局部空间
            m4MulPoint(_tmpA, _invTransform, _position);
            v3Copy(_position, _tmpA);

            m4MulVec(_tmpA, _invTransform, _direction);
            v3Copy(_direction, _tmpA);

            m4MulVec(_tmpA, _invTransform, _up);
            v3Copy(_up, _tmpA);

            // 3. 重正交化（数值稳定性）
            v3Cross(_right, _direction, _up);
            v3Normalize(_right, _right);
            v3Cross(_up, _right, _direction);
            v3Normalize(_up, _up);

            _hasTransform = true;
        },

        restoreTransform() {
            if (!_hasTransform) return;

            // 将 position/direction/up 从局部空间转回世界空间
            m4MulPoint(_tmpA, _currentTransform, _position);
            v3Copy(_position, _tmpA);

            m4MulVec(_tmpA, _currentTransform, _direction);
            v3Copy(_direction, _tmpA);
            v3Normalize(_direction, _direction);

            m4MulVec(_tmpA, _currentTransform, _up);
            v3Copy(_up, _tmpA);
            v3Normalize(_up, _up);

            // 重正交化
            v3Cross(_right, _direction, _up);
            v3Normalize(_right, _right);
            v3Cross(_up, _right, _direction);
            v3Normalize(_up, _up);

            _hasTransform = false;
        },
    };

    return cam;
}
