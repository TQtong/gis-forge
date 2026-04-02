// ============================================================
// camera-3d/Camera3D.ts — Globe3D 相机：ECEF 向量模型 + 约束旋转
// 层级：L3
// 职责：Camera3D 接口实现。采用 Cesium 兼容的 ECEF 位置/方向/上/右四向量
//       表示，通过四元数→旋转矩阵实现旋转，constrainedAxis 防止极点越过。
// 依赖：L0/math（vec3d / mat3 / quat）、L0/geo（ellipsoid / enu）
// 被消费：preset-3d/globe-3d.ts、preset-3d/globe-camera.ts、
//         preset-3d/screen-space-camera-controller.ts
// ============================================================

import type { CameraAnimation, CameraConstraints, CameraController } from '../../runtime/src/camera-controller.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import { geodeticToECEF, ecefToGeodetic, WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import { computeENUBasis } from '../../core/src/geo/enu.ts';
import { fromQuatd, multiplyVec3d } from '../../core/src/math/mat3.ts';
import type { Mat3d } from '../../core/src/math/mat3.ts';
import * as mat4 from '../../core/src/math/mat4.ts';

// ============================================================
// 常量
// ============================================================

/** 默认 zoom 范围 */
const DEFAULT_MIN_ZOOM = 0;
const DEFAULT_MAX_ZOOM = 22;

/** 默认垂直 FOV（弧度），π/4 ≈ 45° */
const DEFAULT_FOV = Math.PI / 4;

/** 地球周长（米），用于 zoom ↔ 海拔换算 */
const EARTH_CIRCUMFERENCE = 40_075_017;

/** 瓦片像素边长 */
const TILE_PX = 256;

/** 动画默认时长（毫秒） */
const DEFAULT_ANIM_MS = 1500;
const MIN_ANIM_MS = 16;

/** 惯性衰减阈值（m/s 或 rad/s） */
const INERTIA_EPS = 1e-5;

/** 度 ↔ 弧度 */
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 约束轴角度保护：距极轴最小间隙（弧度），防止精确到达极点 */
const EPSILON4 = 1e-4;

/** 视口最小边长 */
const MIN_VP = 1;

/** 最小/最大相机高度（米） */
const DEFAULT_MIN_ALT = 100;
const DEFAULT_MAX_ALT = 5e7;

/** 半PI */
const HALF_PI = Math.PI * 0.5;

/** 两倍PI */
const TWO_PI = Math.PI * 2;

// ============================================================
// 工具函数
// ============================================================

/** 钳制到 [lo,hi] */
function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

/** zoom → 海拔（米） */
function altFromZoom(z: number): number {
    return EARTH_CIRCUMFERENCE / (Math.pow(2, Math.max(0, z)) * TILE_PX);
}

/** 海拔 → zoom */
function zoomFromAlt(alt: number): number {
    return clamp(Math.log2(EARTH_CIRCUMFERENCE / (TILE_PX * Math.max(1, alt))), DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);
}

/** Float64 向量长度 */
function len64(v: Float64Array): number {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** Float64 向量就地归一化 */
function normalize64(v: Float64Array): void {
    const l = len64(v);
    if (l > 1e-12) {
        const il = 1 / l;
        v[0] *= il; v[1] *= il; v[2] *= il;
    }
}

/** Float64 点积 */
function dot64(a: Float64Array, b: Float64Array): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Float64 叉积 out = a × b */
function cross64(out: Float64Array, a: Float64Array, b: Float64Array): void {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
}

/** Float64 减法 out = a - b */
function sub64(out: Float64Array, a: Float64Array, b: Float64Array): void {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
}

/** Float64 加法 out = a + b */
function add64(out: Float64Array, a: Float64Array, b: Float64Array): void {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
}

/** Float64 缩放 out = a * s */
function scale64(out: Float64Array, a: Float64Array, s: number): void {
    out[0] = a[0] * s;
    out[1] = a[1] * s;
    out[2] = a[2] * s;
}

/** 线性插值 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * clamp(t, 0, 1);
}

/** smoothstep 缓动 */
function smoothstep(t: number): number {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

/** 生成唯一 ID */
function makeId(): string {
    try { return crypto.randomUUID(); } catch { /* */ }
    return `c3d-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// ============================================================
// 模块级预分配缓冲区（零 GC 热路径）
// ============================================================

const _rotMat = new Float64Array(9);                 // fromQuatd 输出
const _tmpA = new Float64Array(3);                   // 通用临时向量
const _tmpB = new Float64Array(3);
const _tmpC = new Float64Array(3);
const _enuE = new Float64Array(3);                   // ENU east
const _enuN = new Float64Array(3);                   // ENU north
const _enuU = new Float64Array(3);                   // ENU up
const _geo = new Float64Array(3);                    // ecefToGeodetic 输出
const _ecefEye = new Float64Array(3);                // rebuild 用
const _ecefTgt = new Float64Array(3);                // rebuild 用

// ============================================================
// Camera3D 接口
// ============================================================

/** 工厂选项 */
export interface Camera3DOptions {
    /** 初始相机位置（度 / 米） */
    readonly position?: { lon: number; lat: number; alt: number };
    /** 初始 heading（弧度，0=北） */
    readonly heading?: number;
    /** 初始 bearing（弧度，0=北），heading 的别名 */
    readonly bearing?: number;
    /** 初始 pitch（弧度，0=水平，正值向上看） */
    readonly pitch?: number;
    /** 初始 roll（弧度） */
    readonly roll?: number;
    /** 初始垂直 FOV（弧度），默认 π/4 */
    readonly fov?: number;
    /** 最近距离（米） */
    readonly minimumZoomDistance?: number;
    /** 最远距离（米） */
    readonly maximumZoomDistance?: number;
    /** 地形碰撞 */
    readonly enableCollision?: boolean;
}

/** Camera3D 扩展接口 */
export interface Camera3D extends CameraController {
    readonly type: '3d';

    // ── ECEF 向量访问（核心） ──
    /** 相机 ECEF 位置（Float64，米）— 只读引用，禁止外部修改 */
    readonly positionWC: Float64Array;
    /** 相机 look 方向单位向量（Float64）*/
    readonly directionWC: Float64Array;
    /** 相机 up 单位向量（Float64）*/
    readonly upWC: Float64Array;
    /** 相机 right 单位向量（Float64）*/
    readonly rightWC: Float64Array;

    /**
     * 约束轴：当设置时，`rotateHorizontal` 围绕此轴旋转，
     * `rotateVertical` 被钳制以防止越过此轴。
     * 默认 [0,0,1]（ECEF Z 轴 = 地球自转轴），与 Cesium 一致。
     * 设置为 null 允许自由旋转（无极点约束）。
     */
    constrainedAxis: Float64Array | null;

    // ── 低级旋转方法（Cesium 兼容） ──
    /** 围绕任意轴旋转相机（位置+方向+上都转） */
    rotate(axis: Float64Array, angle: number): void;
    /** 水平旋转（围绕 constrainedAxis 或 up）*/
    rotateRight(angle: number): void;
    /** 垂直旋转（围绕切线轴，受 constrainedAxis 钳制）*/
    rotateUp(angle: number): void;
    /** 自由观看（仅旋转方向，不改变位置）*/
    look(axis: Float64Array, angle: number): void;

    // ── 便捷方法 ──
    setPosition(lon: number, lat: number, alt: number): void;
    getPosition(): { lon: number; lat: number; alt: number };
    setHeadingPitchRoll(heading: number, pitch: number, roll: number): void;
    lookAt(target: [number, number, number], offset?: { heading?: number; bearing?: number; pitch?: number; range?: number }): void;

    /** 获取当前朝向（heading/pitch/roll，弧度）和方位（bearing = heading 别名） */
    getOrientation(): { heading: number; pitch: number; roll: number; bearing: number };
    /** 设置朝向（弧度） */
    setOrientation(bearing: number, pitch: number, roll: number): void;

    /** 从 ECEF 位置+方向射线与椭球体求交，返回 [lon, lat]（度）或 null */
    pickEllipsoid(screenX: number, screenY: number): Float64Array | null;

    /**
     * 用渲染管线的逆 VP 矩阵（ECEF 绝对空间）更新拾取矩阵。
     * 每帧在 computeGlobeCamera 之后调用，确保 pickEllipsoid 与渲染完全一致。
     */
    updatePickMatrix(inverseVP_ECEF: Float32Array): void;

    readonly terrainCollisionEnabled: boolean;
    setTerrainCollisionEnabled(enabled: boolean): void;
    setMinAltitudeAboveTerrain(meters: number): void;
    queryTerrainHeight(lon: number, lat: number): Promise<number>;
    flyToPosition(options: { lon: number; lat: number; alt: number; heading?: number; bearing?: number; pitch?: number; duration?: number }): CameraAnimation;
}

// ============================================================
// 内部可变状态容器
// ============================================================

type Mut = {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
    roll: number;
    viewMatrix: Float32Array;
    projectionMatrix: Float32Array;
    vpMatrix: Float32Array;
    inverseVPMatrix: Float32Array;
    position: Float32Array;
    altitude: number;
    fov: number;
};

// ============================================================
// 动画
// ============================================================

type AnimTarget = {
    positionWC: Float64Array;
    directionWC: Float64Array;
    upWC: Float64Array;
};

type Anim = {
    id: string;
    startMs: number;
    durationMs: number;
    easing: (t: number) => number;
    from: AnimTarget;
    to: AnimTarget;
    handle: CameraAnimation & { _st: 'running' | 'finished' | 'cancelled'; _res?: () => void };
};

function mkHandle(id: string, onCancel: () => void): Anim['handle'] {
    let done = false;
    let res: (() => void) | undefined;
    const finished = new Promise<void>((r) => { res = r; });
    const h: Anim['handle'] = {
        id,
        _st: 'running',
        get state() { return h._st; },
        cancel: () => {
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

function finishAnim(h: Anim['handle']): void {
    if (h._st !== 'running') return;
    h._st = 'finished';
    h._res?.();
}

// ============================================================
// Camera3DImpl
// ============================================================

class Camera3DImpl implements Camera3D {
    readonly type = '3d' as const;

    // ── ECEF 核心向量（Float64，高精度） ──
    readonly positionWC: Float64Array;
    readonly directionWC: Float64Array;
    readonly upWC: Float64Array;
    readonly rightWC: Float64Array;
    constrainedAxis: Float64Array | null;

    // ── 内部状态 ──
    private readonly _m: Mut;
    private _constraints: CameraConstraints;
    private _minAlt: number;
    private _maxAlt: number;
    private _terrainCollision: boolean;
    private _minClear: number;
    private _inertia = true;
    private _vpW = 1024;
    private _vpH = 768;

    // ── 拖拽/惯性状态 ──
    private _panning = false;
    private _lastSx: number | null = null;
    private _lastSy: number | null = null;
    private _lastMs = 0;
    private _velE = 0;
    private _velN = 0;

    // ── 动画 ──
    private _anim: Anim | null = null;

    // ── 生命周期 ──
    private _destroyed = false;
    private _onStart = new Set<() => void>();
    private _onMv = new Set<(s: CameraState) => void>();
    private _onEnd = new Set<() => void>();

    constructor(options?: Camera3DOptions) {
        // 默认相机位于 (lon=0, lat=25°, alt=12000km)
        const pos = options?.position ?? { lon: 0, lat: 25, alt: 12_000_000 };
        const lonRad = pos.lon * DEG;
        const latRad = pos.lat * DEG;
        const alt = clamp(pos.alt, options?.minimumZoomDistance ?? DEFAULT_MIN_ALT, options?.maximumZoomDistance ?? DEFAULT_MAX_ALT);

        // 计算初始 ECEF 位置
        this.positionWC = new Float64Array(3);
        geodeticToECEF(this.positionWC, lonRad, latRad, alt);

        // 初始方向：从相机看向地球中心（target = 地面注视点 ECEF）
        // 先计算目标点 ECEF（纬度相同、高度为 0）
        const tgt = new Float64Array(3);
        geodeticToECEF(tgt, lonRad, latRad, 0);

        // direction = normalize(target - position)
        this.directionWC = new Float64Array(3);
        sub64(this.directionWC, tgt, this.positionWC);
        normalize64(this.directionWC);

        // up = 初始 ENU 的 north 方向在 ECEF 中的投影
        // 使用 computeENUBasis 得到 ENU 框架
        this.upWC = new Float64Array(3);
        this.rightWC = new Float64Array(3);
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);

        // 相机 up 方向 = ENU 的 Up 方向（椭球面法线方向）
        // 但需要与 direction 正交化
        this.upWC[0] = _enuU[0]; this.upWC[1] = _enuU[1]; this.upWC[2] = _enuU[2];
        // right = direction × up
        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);
        // re-orthogonalize up = right × direction
        cross64(this.upWC, this.rightWC, this.directionWC);
        normalize64(this.upWC);

        // 默认约束轴：ECEF Z 轴（匹配 Cesium 默认行为）
        this.constrainedAxis = new Float64Array([0, 0, 1]);

        // 如果指定了 heading 或 bearing，旋转相机
        const initHeading = options?.heading ?? options?.bearing ?? 0;
        if (initHeading !== 0) {
            this.rotateRight(-initHeading);
        }

        this._minAlt = options?.minimumZoomDistance ?? DEFAULT_MIN_ALT;
        this._maxAlt = options?.maximumZoomDistance ?? DEFAULT_MAX_ALT;
        this._terrainCollision = options?.enableCollision ?? false;
        this._minClear = 50;

        this._constraints = {
            minZoom: DEFAULT_MIN_ZOOM,
            maxZoom: DEFAULT_MAX_ZOOM,
            minPitch: 0,
            maxPitch: HALF_PI - 0.02,
            maxBounds: undefined,
        };

        this._m = {
            center: [0, 0],
            zoom: 2,
            bearing: 0,
            pitch: 0,
            roll: 0,
            viewMatrix: mat4.create(),
            projectionMatrix: mat4.create(),
            vpMatrix: mat4.create(),
            inverseVPMatrix: mat4.create(),
            position: new Float32Array(3),
            altitude: alt,
            fov: DEFAULT_FOV,
        };
    }

    // ════════════════════════════════════════════════════════════
    // 核心旋转方法（匹配 Cesium Camera.js）
    // ════════════════════════════════════════════════════════════

    /**
     * 围绕任意 ECEF 轴旋转相机。
     * 同时旋转 position、direction、up，然后通过叉积重新正交化 right 和 up。
     *
     * 这是 Cesium Camera.prototype.rotate 的精确复刻：
     * 1. 从 axis-angle 构建四元数
     * 2. 四元数 → 3x3 旋转矩阵
     * 3. 矩阵乘以 position、direction、up
     * 4. 叉积重正交化
     *
     * @param axis  - 旋转轴（ECEF 单位向量）
     * @param angle - 旋转角度（弧度，正值为右手定则方向）
     */
    rotate(axis: Float64Array, angle: number): void {
        if (Math.abs(angle) < 1e-15) return;

        // 构建 axis-angle 四元数：q = (sin(θ/2)*axis, cos(θ/2))
        // 注意：Cesium 使用 -angle（约定差异），这里保持一致
        const halfAngle = -angle * 0.5;
        const s = Math.sin(halfAngle);
        const qx = axis[0] * s;
        const qy = axis[1] * s;
        const qz = axis[2] * s;
        const qw = Math.cos(halfAngle);

        // 四元数 → 3x3 旋转矩阵
        fromQuatd(_rotMat, qx, qy, qz, qw);

        // 旋转 position, direction, up
        multiplyVec3d(this.positionWC, _rotMat, this.positionWC);
        multiplyVec3d(this.directionWC, _rotMat, this.directionWC);
        multiplyVec3d(this.upWC, _rotMat, this.upWC);

        // 重新正交化：right = direction × up, up = right × direction
        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);
        cross64(this.upWC, this.rightWC, this.directionWC);
        normalize64(this.upWC);
    }

    /**
     * 水平旋转（"向右看"方向）。
     * 如果 constrainedAxis 存在，围绕该轴旋转（保持"北"方向稳定）。
     * 否则围绕相机 up 旋转。
     *
     * 匹配 Cesium Camera.prototype.rotateRight → rotateHorizontal。
     *
     * @param angle - 旋转角度（弧度，正值向右）
     */
    rotateRight(angle: number): void {
        if (this.constrainedAxis) {
            // 围绕约束轴旋转（通常是 ECEF Z 轴）
            // 这保证水平拖拽始终围绕地球自转轴，不会导致 heading 不稳定
            this.rotate(this.constrainedAxis, angle);
        } else {
            // 无约束：围绕相机 up 旋转
            this.rotate(this.upWC, angle);
        }
    }

    /**
     * 垂直旋转（"向上看"方向）。受 constrainedAxis 钳制，防止越过极点。
     *
     * 匹配 Cesium Camera.prototype.rotateUp → rotateVertical：
     * 1. 如果无 constrainedAxis，直接围绕 right 旋转
     * 2. 如果有 constrainedAxis：
     *    a. 检查相机是否在极点（position 平行于 constrainedAxis）
     *    b. 如果不在极点：计算 position 到 constrainedAxis 的角距离，
     *       钳制旋转量使其不会越过极点
     *    c. 旋转轴 = cross(constrainedAxis, position)（切线方向）
     *    d. 如果在极点：仅允许远离极点的旋转，轴 = right
     *
     * @param angle - 旋转角度（弧度，正值向上）
     */
    rotateUp(angle: number): void {
        if (!this.constrainedAxis) {
            // 无约束：围绕 right 旋转
            this.rotate(this.rightWC, angle);
            return;
        }

        const axis = this.constrainedAxis;

        // 归一化 position
        const posLen = len64(this.positionWC);
        if (posLen < 1e-10) return;

        _tmpA[0] = this.positionWC[0] / posLen;
        _tmpA[1] = this.positionWC[1] / posLen;
        _tmpA[2] = this.positionWC[2] / posLen;

        // 检查是否在北极（position ∥ constrainedAxis）
        const dotNorth = dot64(_tmpA, axis);
        const northParallel = Math.abs(dotNorth - 1.0) < EPSILON4;
        // 检查是否在南极（position ∥ -constrainedAxis）
        const southParallel = Math.abs(dotNorth + 1.0) < EPSILON4;

        if (!northParallel && !southParallel) {
            // ── 非极点：正常约束旋转 ──

            // angleToAxis = 从 position 到 constrainedAxis 的角距离
            const angleToAxis = Math.acos(clamp(dotNorth, -1, 1));
            // angleToAxisComplement = 从 position 到 -constrainedAxis 的角距离
            const angleToAxisComplement = Math.PI - angleToAxis;

            let clampedAngle = angle;

            // 钳制：如果旋转会越过北极
            if (angle > 0 && angle > angleToAxis - EPSILON4) {
                clampedAngle = angleToAxis - EPSILON4;
            }
            // 钳制：如果旋转会越过南极
            if (angle < 0 && -angle > angleToAxisComplement - EPSILON4) {
                clampedAngle = -(angleToAxisComplement - EPSILON4);
            }

            if (Math.abs(clampedAngle) < 1e-15) return;

            // 旋转轴 = cross(constrainedAxis, position)
            // 这是在赤道平面内的切线方向
            cross64(_tmpB, axis, this.positionWC);
            normalize64(_tmpB);

            // 如果叉积接近零（position 几乎与 axis 平行），退化使用 right
            if (len64(_tmpB) < 1e-10) {
                _tmpB[0] = this.rightWC[0];
                _tmpB[1] = this.rightWC[1];
                _tmpB[2] = this.rightWC[2];
            }

            this.rotate(_tmpB, clampedAngle);
        } else {
            // ── 在极点：只允许远离极点的旋转 ──
            // 使用 right 作为旋转轴

            let clampedAngle = angle;
            if (northParallel && angle > 0) {
                // 在北极，尝试向"上"（更靠近轴）→ 阻止
                clampedAngle = 0;
            }
            if (southParallel && angle < 0) {
                // 在南极，尝试向"下"（更靠近 -轴）→ 阻止
                clampedAngle = 0;
            }

            if (Math.abs(clampedAngle) < 1e-15) return;
            this.rotate(this.rightWC, clampedAngle);
        }
    }

    /**
     * 自由观看：仅旋转 direction/up/right，不改变 position。
     * 用于 Shift+左键拖拽（look 模式）。
     *
     * 匹配 Cesium Camera.prototype.look。
     *
     * @param axis  - 旋转轴
     * @param angle - 旋转角度（弧度）
     */
    look(axis: Float64Array, angle: number): void {
        if (Math.abs(angle) < 1e-15) return;

        const halfAngle = -angle * 0.5;
        const s = Math.sin(halfAngle);
        fromQuatd(_rotMat, axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(halfAngle));

        // 仅旋转方向向量（不旋转 position）
        multiplyVec3d(this.directionWC, _rotMat, this.directionWC);
        multiplyVec3d(this.upWC, _rotMat, this.upWC);

        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);
        cross64(this.upWC, this.rightWC, this.directionWC);
        normalize64(this.upWC);
    }

    // ════════════════════════════════════════════════════════════
    // Heading / Pitch / Roll（从 ECEF 向量导出）
    // ════════════════════════════════════════════════════════════

    /**
     * 获取 heading（方位角），匹配 Cesium Camera.prototype.heading。
     *
     * 在 ENU 坐标系中：heading = atan2(direction_east, direction_north)。
     * 极点退化：当 direction 几乎垂直（沿 Z 轴）时，使用 up 向量计算。
     */
    getHeading(): number {
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);

        const dirE = dot64(this.directionWC, _enuE);
        const dirN = dot64(this.directionWC, _enuN);
        const dirU = dot64(this.directionWC, _enuU);

        // 检查是否接近垂直看下/上（|direction·up| ≈ 1）
        if (Math.abs(dirU) > 1.0 - 1e-3) {
            // direction 几乎沿法线方向 → heading 由 up 向量定义（Cesium 约定）
            const upE = dot64(this.upWC, _enuE);
            const upN = dot64(this.upWC, _enuN);
            return Math.atan2(upE, upN);
        }

        // 常规：heading = atan2(direction_east, direction_north)
        return Math.atan2(dirE, dirN);
    }

    /**
     * 获取 pitch（俯仰角）。
     * 在 ENU 中：pitch = asin(direction · up_enu)。
     * 负值 = 俯视，正值 = 仰视。
     */
    getPitch(): number {
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);
        const d = dot64(this.directionWC, _enuU);
        return Math.asin(clamp(d, -1, 1));
    }

    /**
     * 获取 roll。极点退化时返回 0。
     */
    getRoll(): number {
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);
        const dirU = dot64(this.directionWC, _enuU);
        if (Math.abs(dirU) > 1.0 - 1e-3) return 0;
        const rightE = dot64(this.rightWC, _enuE);
        const rightN = dot64(this.rightWC, _enuN);
        const rightU = dot64(this.rightWC, _enuU);
        void rightE; void rightN;
        return Math.asin(clamp(-rightU, -1, 1));
    }

    // ════════════════════════════════════════════════════════════
    // CameraController 接口实现
    // ════════════════════════════════════════════════════════════

    get state(): CameraState { return this._m as CameraState; }
    get constraints(): CameraConstraints { return this._constraints; }
    get isAnimating(): boolean { return this._anim !== null; }
    get inertiaEnabled(): boolean { return this._inertia; }

    setInertiaEnabled(en: boolean): void {
        this._alive();
        this._inertia = en;
        if (!en) { this._velE = 0; this._velN = 0; }
    }

    get terrainCollisionEnabled(): boolean { return this._terrainCollision; }
    setTerrainCollisionEnabled(en: boolean): void { this._alive(); this._terrainCollision = en; }
    setMinAltitudeAboveTerrain(m: number): void { this._alive(); this._minClear = Math.max(0, m); }
    async queryTerrainHeight(_lon: number, _lat: number): Promise<number> { return 0; }

    setConstraints(c: Partial<CameraConstraints>): void {
        this._alive();
        this._constraints = {
            minZoom: c.minZoom ?? this._constraints.minZoom,
            maxZoom: c.maxZoom ?? this._constraints.maxZoom,
            minPitch: c.minPitch ?? this._constraints.minPitch,
            maxPitch: c.maxPitch ?? this._constraints.maxPitch,
            maxBounds: c.maxBounds !== undefined ? c.maxBounds : this._constraints.maxBounds,
        };
    }

    setCenter(center: [number, number]): void {
        this._alive();
        // 保持当前海拔，移动到新经纬度上方
        const alt = this._currentAltitude();
        this._setFromGeodetic(center[0], center[1], alt);
    }

    setZoom(zoom: number): void {
        this._alive();
        const z = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
        const alt = clamp(altFromZoom(z), this._minAlt, this._maxAlt);
        const geo = this._currentGeodetic();
        this._setFromGeodetic(geo[0] * RAD, geo[1] * RAD, alt);
    }

    setBearing(b: number): void {
        this._alive();
        if (!Number.isFinite(b)) return;
        const currentHeading = this.getHeading();
        const delta = b - currentHeading;
        if (Math.abs(delta) > 1e-10) {
            this.rotateRight(-delta);
        }
    }

    setPitch(p: number): void {
        this._alive();
        const currentPitch = this.getPitch();
        const delta = p - currentPitch;
        if (Math.abs(delta) > 1e-10) {
            this.rotateUp(delta);
        }
    }

    setPosition(lon: number, lat: number, alt: number): void {
        this._alive();
        this._setFromGeodetic(lon, lat, clamp(alt, this._minAlt, this._maxAlt));
    }

    getPosition(): { lon: number; lat: number; alt: number } {
        const g = this._currentGeodetic();
        return { lon: g[0] * RAD, lat: g[1] * RAD, alt: g[2] };
    }

    setHeadingPitchRoll(h: number, p: number, _r: number): void {
        this._alive();
        if (Number.isFinite(h)) this.setBearing(h);
        if (Number.isFinite(p)) this.setPitch(p);
    }

    lookAt(target: [number, number, number], offset?: { heading?: number; bearing?: number; pitch?: number; range?: number }): void {
        this._alive();
        const [tlon, tlat] = target;
        if (!Number.isFinite(tlon) || !Number.isFinite(tlat)) return;

        const range = offset?.range ?? 4_000_000;
        const heading = offset?.heading ?? offset?.bearing ?? 0;
        const pitch = offset?.pitch ?? -0.4;

        // 计算目标 ECEF
        geodeticToECEF(_ecefTgt, tlon * DEG, tlat * DEG, 0);

        // 在目标点的 ENU 系中，按 heading/pitch/range 偏移得到相机位置
        computeENUBasis(_enuE, _enuN, _enuU, _ecefTgt[0], _ecefTgt[1], _ecefTgt[2]);

        // 从目标出发，沿 -heading 方向、pitch 仰角、range 距离处放置相机
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        const ch = Math.cos(heading);
        const sh = Math.sin(heading);
        // 相机在 ENU 中的偏移（从目标指向相机）
        const east = range * cp * sh;
        const north = range * cp * ch;
        const up = range * sp;

        // 偏移转 ECEF
        this.positionWC[0] = _ecefTgt[0] + east * _enuE[0] + north * _enuN[0] + up * _enuU[0];
        this.positionWC[1] = _ecefTgt[1] + east * _enuE[1] + north * _enuN[1] + up * _enuU[1];
        this.positionWC[2] = _ecefTgt[2] + east * _enuE[2] + north * _enuN[2] + up * _enuU[2];

        // direction = normalize(target - camera)
        sub64(this.directionWC, _ecefTgt, this.positionWC);
        normalize64(this.directionWC);

        // up = ENU up at camera position
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);
        this.upWC[0] = _enuU[0]; this.upWC[1] = _enuU[1]; this.upWC[2] = _enuU[2];

        // 正交化
        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);
        cross64(this.upWC, this.rightWC, this.directionWC);
        normalize64(this.upWC);
    }

    getOrientation(): { heading: number; pitch: number; roll: number; bearing: number } {
        const h = this.getHeading();
        const p = this.getPitch();
        const r = this.getRoll();
        return { heading: h, pitch: p, roll: r, bearing: h };
    }

    setOrientation(bearing: number, pitch: number, roll: number): void {
        this.setHeadingPitchRoll(bearing, pitch, roll);
    }

    /**
     * 椭球体拾取：从屏幕坐标发射射线，与 WGS84 球体（近似为正球体 R=WGS84_A）求交。
     * 返回 ECEF 命中点（Float64Array(3)），或 null 未命中。
     */
    pickEllipsoid(screenX: number, screenY: number): Float64Array | null {
        // NDC 坐标
        const ndcX = (screenX / this._vpW) * 2 - 1;
        const ndcY = 1 - (screenY / this._vpH) * 2;

        // 使用 inverseVPMatrix 反投影到世界空间
        const invVP = this._m.inverseVPMatrix;

        // 近平面点（NDC z = 0）
        const nx = invVP[0] * ndcX + invVP[4] * ndcY + invVP[8] * 0 + invVP[12];
        const ny = invVP[1] * ndcX + invVP[5] * ndcY + invVP[9] * 0 + invVP[13];
        const nz = invVP[2] * ndcX + invVP[6] * ndcY + invVP[10] * 0 + invVP[14];
        const nw = invVP[3] * ndcX + invVP[7] * ndcY + invVP[11] * 0 + invVP[15] || 1;

        // 远平面点（NDC z = 1）
        const fx = invVP[0] * ndcX + invVP[4] * ndcY + invVP[8] * 1 + invVP[12];
        const fy = invVP[1] * ndcX + invVP[5] * ndcY + invVP[9] * 1 + invVP[13];
        const fz = invVP[2] * ndcX + invVP[6] * ndcY + invVP[10] * 1 + invVP[14];
        const fw = invVP[3] * ndcX + invVP[7] * ndcY + invVP[11] * 1 + invVP[15] || 1;

        // 透视除法
        const nearX = nx / nw, nearY = ny / nw, nearZ = nz / nw;
        const farX = fx / fw, farY = fy / fw, farZ = fz / fw;

        // 射线：origin = 相机 ECEF 位置, direction = normalize(far - near)
        const ox = this.positionWC[0], oy = this.positionWC[1], oz = this.positionWC[2];
        let dx = farX - nearX, dy = farY - nearY, dz = farZ - nearZ;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl < 1e-10) return null;
        dx /= dl; dy /= dl; dz /= dl;

        // 射线-球体求交（球体半径 R = WGS84_A，中心在原点）
        // 二次方程 at² + bt + c = 0
        const R = WGS84_A;
        const a = dx * dx + dy * dy + dz * dz;   // = 1（方向已归一化）
        const b = 2 * (ox * dx + oy * dy + oz * dz);
        const c = ox * ox + oy * oy + oz * oz - R * R;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return null;

        const sqrtDisc = Math.sqrt(disc);
        const t1 = (-b - sqrtDisc) / (2 * a);
        const t2 = (-b + sqrtDisc) / (2 * a);

        // 取最近的正交点
        let t = t1 >= 0 ? t1 : t2;
        if (t < 0) return null;

        const hit = new Float64Array(3);
        hit[0] = ox + dx * t;
        hit[1] = oy + dy * t;
        hit[2] = oz + dz * t;
        return hit;
    }

    jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
        this._alive();
        this.stop();
        if (o.center) this.setCenter(o.center);
        if (o.zoom !== undefined) this.setZoom(o.zoom);
        if (o.bearing !== undefined) this.setBearing(o.bearing);
        if (o.pitch !== undefined) this.setPitch(o.pitch);
    }

    flyTo(o: {
        center?: [number, number]; zoom?: number; bearing?: number; pitch?: number;
        duration?: number; easing?: (t: number) => number;
    }): CameraAnimation {
        this._alive();
        this.stop();
        const id = makeId();
        const h = mkHandle(id, () => { if (this._anim?.id === id) this._anim = null; });

        // 快照当前状态
        const fromPos = new Float64Array(this.positionWC);
        const fromDir = new Float64Array(this.directionWC);
        const fromUp = new Float64Array(this.upWC);

        // 计算目标状态：先在临时相机上 jumpTo，读取结果
        const toPos = new Float64Array(this.positionWC);
        const toDir = new Float64Array(this.directionWC);
        const toUp = new Float64Array(this.upWC);

        // 应用目标参数（临时修改，之后恢复）
        if (o.center) this.setCenter(o.center);
        if (o.zoom !== undefined) this.setZoom(o.zoom);
        if (o.bearing !== undefined) this.setBearing(o.bearing);
        if (o.pitch !== undefined) this.setPitch(o.pitch);

        toPos.set(this.positionWC);
        toDir.set(this.directionWC);
        toUp.set(this.upWC);

        // 恢复起始状态
        this.positionWC.set(fromPos);
        this.directionWC.set(fromDir);
        this.upWC.set(fromUp);
        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);

        this._anim = {
            id,
            startMs: performance.now(),
            durationMs: Math.max(MIN_ANIM_MS, o.duration ?? DEFAULT_ANIM_MS),
            easing: o.easing ?? smoothstep,
            from: { positionWC: fromPos, directionWC: fromDir, upWC: fromUp },
            to: { positionWC: toPos, directionWC: toDir, upWC: toUp },
            handle: h,
        };
        return h;
    }

    easeTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): CameraAnimation {
        return this.flyTo({ ...o, easing: smoothstep });
    }

    flyToPosition(o: { lon: number; lat: number; alt: number; heading?: number; bearing?: number; pitch?: number; duration?: number }): CameraAnimation {
        return this.flyTo({
            center: [o.lon, o.lat],
            zoom: zoomFromAlt(o.alt),
            bearing: o.heading ?? o.bearing,
            pitch: o.pitch,
            duration: o.duration,
        });
    }

    stop(): void {
        if (this._anim) {
            const h = this._anim.handle;
            this._anim = null;
            h.cancel();
        }
    }

    /**
     * 每帧更新：推进动画/惯性，重建矩阵和 CameraState。
     */
    update(dt: number, viewport: Viewport): CameraState {
        this._alive();
        this._vpW = Math.max(viewport.width, MIN_VP);
        this._vpH = Math.max(viewport.height, MIN_VP);
        const dts = Number.isFinite(dt) && dt > 0 ? dt : 0;

        // ── 动画推进 ──
        if (this._anim) {
            const a = this._anim;
            const u = clamp((performance.now() - a.startMs) / a.durationMs, 0, 1);
            const t = a.easing(u);

            // 线性插值 position
            for (let i = 0; i < 3; i++) {
                this.positionWC[i] = a.from.positionWC[i] + t * (a.to.positionWC[i] - a.from.positionWC[i]);
                this.directionWC[i] = a.from.directionWC[i] + t * (a.to.directionWC[i] - a.from.directionWC[i]);
                this.upWC[i] = a.from.upWC[i] + t * (a.to.upWC[i] - a.from.upWC[i]);
            }
            normalize64(this.directionWC);
            normalize64(this.upWC);
            cross64(this.rightWC, this.directionWC, this.upWC);
            normalize64(this.rightWC);
            cross64(this.upWC, this.rightWC, this.directionWC);
            normalize64(this.upWC);

            if (u >= 1) {
                finishAnim(a.handle);
                this._anim = null;
            }
        }

        // ── 惯性衰减（暂用简单线性惯性占位） ──
        if (this._inertia && !this._panning && !this._anim) {
            if (Math.abs(this._velE) > INERTIA_EPS || Math.abs(this._velN) > INERTIA_EPS) {
                const dec = Math.pow(0.9, dts * 60);
                // 将 ENU 速度转为旋转
                const alt = this._currentAltitude();
                const rateE = (this._velE * dts) / (WGS84_A + alt);
                const rateN = (this._velN * dts) / (WGS84_A + alt);
                if (Math.abs(rateE) > 1e-12) this.rotateRight(rateE);
                if (Math.abs(rateN) > 1e-12) this.rotateUp(-rateN);
                this._velE *= dec;
                this._velN *= dec;
            }
        }

        // ── 重建 CameraState ──
        return this._rebuild(viewport);
    }

    // ── 交互处理 ──

    handlePanStart(_sx: number, _sy: number): void {
        this._alive();
        this._panning = true;
        this._lastSx = null;
        this._lastSy = null;
        this._lastMs = performance.now();
        this._velE = 0; this._velN = 0;
        for (const c of this._onStart) { try { c(); } catch { /* */ } }
    }

    handlePanMove(sx: number, sy: number): void {
        this._alive();
        const now = performance.now();
        const dts = Math.max(1e-4, (now - this._lastMs) / 1000);
        this._lastMs = now;

        if (this._lastSx === null || this._lastSy === null) {
            this._lastSx = sx; this._lastSy = sy;
            return;
        }

        const dx = sx - this._lastSx;
        const dy = sy - this._lastSy;
        this._lastSx = sx; this._lastSy = sy;

        // 简单像素→角度映射（ScreenSpaceCameraController 会替代此逻辑）
        const alt = this._currentAltitude();
        const rate = Math.max(1e-7, alt / (WGS84_A * 4));
        const deltaH = -dx / this._vpW * Math.PI * 2 * rate;
        const deltaV = dy / this._vpH * Math.PI * rate;

        this.rotateRight(deltaH);
        this.rotateUp(deltaV);

        // 记录惯性速度
        this._velE = (deltaH * (WGS84_A + alt)) / dts;
        this._velN = (-deltaV * (WGS84_A + alt)) / dts;

        for (const c of this._onMv) { try { c(this.state); } catch { /* */ } }
    }

    handlePanEnd(): void {
        this._alive();
        this._panning = false;
        this._lastSx = null; this._lastSy = null;
        for (const c of this._onEnd) { try { c(); } catch { /* */ } }
    }

    handleZoom(delta: number, _sx: number, _sy: number): void {
        this._alive();
        if (!Number.isFinite(delta) || delta === 0) return;

        // 沿 direction 前进/后退
        const factor = Math.pow(1.001, -delta);
        const alt = this._currentAltitude();
        const newAlt = clamp(alt * factor, this._minAlt, this._maxAlt);
        const ratio = newAlt / Math.max(alt, 1);

        // 缩放 position 长度（沿从地心到相机的方向）
        const posLen = len64(this.positionWC);
        const newLen = posLen * ratio;
        scale64(this.positionWC, this.positionWC, newLen / posLen);
    }

    handleRotate(db: number, dp: number): void {
        this._alive();
        if (Math.abs(db) > 1e-10) this.rotateRight(-db);
        if (Math.abs(dp) > 1e-10) this.rotateUp(dp);
    }

    onMoveStart(cb: () => void): () => void { this._onStart.add(cb); return () => this._onStart.delete(cb); }
    onMove(cb: (s: CameraState) => void): () => void { this._onMv.add(cb); return () => this._onMv.delete(cb); }
    onMoveEnd(cb: () => void): () => void { this._onEnd.add(cb); return () => this._onEnd.delete(cb); }

    destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this.stop();
        this._onStart.clear(); this._onMv.clear(); this._onEnd.clear();
    }

    // ════════════════════════════════════════════════════════════
    // 私有方法
    // ════════════════════════════════════════════════════════════

    private _alive(): void {
        if (this._destroyed) throw new Error('[Camera3D] destroyed');
    }

    /** 获取当前海拔（ECEF position 长度 - WGS84_A） */
    private _currentAltitude(): number {
        return len64(this.positionWC) - WGS84_A;
    }

    /** 获取当前大地坐标 [lonRad, latRad, alt] */
    private _currentGeodetic(): Float64Array {
        ecefToGeodetic(_geo, this.positionWC[0], this.positionWC[1], this.positionWC[2]);
        return _geo;
    }

    /** 从大地坐标设置相机位置，保持方向不变 */
    private _setFromGeodetic(lonDeg: number, latDeg: number, alt: number): void {
        const lonR = lonDeg * DEG;
        const latR = clamp(latDeg, -90, 90) * DEG;
        const a = clamp(alt, this._minAlt, this._maxAlt);

        // 保存旧的 heading/pitch 以便恢复朝向
        const oldHeading = this.getHeading();
        const oldPitch = this.getPitch();

        // 新位置 ECEF
        geodeticToECEF(this.positionWC, lonR, latR, a);

        // 默认朝向：看向地心
        geodeticToECEF(_ecefTgt, lonR, latR, 0);
        sub64(this.directionWC, _ecefTgt, this.positionWC);
        normalize64(this.directionWC);

        // up = ENU up
        computeENUBasis(_enuE, _enuN, _enuU, this.positionWC[0], this.positionWC[1], this.positionWC[2]);
        this.upWC[0] = _enuU[0]; this.upWC[1] = _enuU[1]; this.upWC[2] = _enuU[2];
        cross64(this.rightWC, this.directionWC, this.upWC);
        normalize64(this.rightWC);
        cross64(this.upWC, this.rightWC, this.directionWC);
        normalize64(this.upWC);

        // 恢复 heading 和 pitch
        if (Math.abs(oldHeading) > 1e-6) this.rotateRight(-oldHeading);
        if (Math.abs(oldPitch) > 1e-6) this.rotateUp(oldPitch);
    }

    /**
     * 从 ECEF 向量重建 CameraState（矩阵 + 衍生属性）。
     *
     * 1. 计算大地坐标（center, altitude, zoom）
     * 2. 计算 heading/pitch/roll
     * 3. 构建 view/projection/VP 矩阵
     * 4. 填充 CameraState
     */
    private _rebuild(viewport: Viewport): CameraState {
        const m = this._m;
        const g = this._currentGeodetic();
        const alt = Math.max(1, g[2]);

        // center = direction 射线与球面的交点（简化：直接用相机正下方经纬度）
        // 更精确的做法是射线求交，但 MVP 先用相机位置
        m.center[0] = g[0] * RAD;
        m.center[1] = g[1] * RAD;
        m.altitude = alt;
        m.zoom = zoomFromAlt(alt);
        m.bearing = this.getHeading();
        m.pitch = this.getPitch();
        m.roll = this.getRoll();
        m.fov = DEFAULT_FOV;

        // Float32 position
        m.position[0] = this.positionWC[0];
        m.position[1] = this.positionWC[1];
        m.position[2] = this.positionWC[2];

        // View matrix: lookAt(eye, eye + direction, up)
        // 使用 Float32 精度（GPU 用）
        const eye32 = _tmpF32A;
        const center32 = _tmpF32B;
        const up32 = _tmpF32C;

        eye32[0] = this.positionWC[0];
        eye32[1] = this.positionWC[1];
        eye32[2] = this.positionWC[2];

        center32[0] = this.positionWC[0] + this.directionWC[0];
        center32[1] = this.positionWC[1] + this.directionWC[1];
        center32[2] = this.positionWC[2] + this.directionWC[2];

        up32[0] = this.upWC[0];
        up32[1] = this.upWC[1];
        up32[2] = this.upWC[2];

        mat4.lookAt(m.viewMatrix, eye32, center32, up32);

        // Projection matrix
        const aspect = Math.max(viewport.width, MIN_VP) / Math.max(viewport.height, MIN_VP);
        const near = Math.max(10, alt * 1e-4);
        const far = Math.max(near + 100, alt * 2 + WGS84_A);
        mat4.perspectiveReversedZ(m.projectionMatrix, DEFAULT_FOV, aspect, near, far);

        // VP
        mat4.multiply(m.vpMatrix, m.projectionMatrix, m.viewMatrix);
        if (mat4.invert(m.inverseVPMatrix, m.vpMatrix) === null) {
            mat4.identity(m.inverseVPMatrix);
        }

        return m as CameraState;
    }
}

// Float32 临时向量（rebuild 用，避免分配）
const _tmpF32A = new Float32Array(3);
const _tmpF32B = new Float32Array(3);
const _tmpF32C = new Float32Array(3);

/**
 * 创建 Camera3D 实例。
 *
 * @param options - 初始化选项
 * @returns Camera3D 实例
 *
 * @example
 * const cam = createCamera3D({ position: { lon: 121.47, lat: 31.23, alt: 500_000 } });
 */
export function createCamera3D(options?: Camera3DOptions): Camera3D {
    return new Camera3DImpl(options);
}
