// ============================================================
// camera-3d/Camera3D.ts — 3D 地球相机控制器（ECEF 坐标系）
//
// 编译期开发模式标志（生产构建 tree-shake 移除）
declare const __DEV__: boolean;
// ============================================================
// 层级：独立相机包，实现 L3/CameraController 接口
// 职责：ECEF 坐标定位、大圆弧飞行动画、地形碰撞、惯性轨道旋转。
// 依赖：L0 CameraState/Viewport/BBox2D、L0 mat4/vec3/quat、L0 ellipsoid
// ============================================================

import type { Viewport, CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type {
    CameraType,
    CameraConstraints,
    CameraAnimation,
    CameraController,
} from '../../runtime/src/camera-controller.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
import * as quat from '../../core/src/math/quat.ts';
import {
    WGS84_A,
    geodeticToECEF,
    ecefToGeodetic,
    haversineDistance,
} from '../../core/src/geo/ellipsoid.ts';

// ---------------------------------------------------------------------------
// 常量 — 所有魔法数字抽为命名常量，附带含义与来源
// ---------------------------------------------------------------------------

/** 地球赤道周长（米），用于 zoom ↔ altitude 换算 */
const EARTH_CIRCUMFERENCE = 2 * Math.PI * WGS84_A;

/** 默认相机海拔高度（米），约 20 000 km 可看到整个地球 */
const DEFAULT_ALTITUDE = 20_000_000;

/**
 * 默认俯仰角（弧度）。
 * 内部约定：0 = 水平看地平线，-π/2 = 正俯视地面。
 * -π/4 即 45° 俯角，是 3D 地球常见默认视角。
 */
const DEFAULT_PITCH_3D = -Math.PI / 4;

/** 最小缩放距离（米），防止相机穿透地面 */
const DEFAULT_MIN_ZOOM_DISTANCE = 1;

/** 默认垂直视场角（弧度），45° */
const DEFAULT_FOV_3D = Math.PI / 4;

/** 地形高度缓存失效距离（米），相机水平移动超过此值后重新查询 DEM */
const TERRAIN_CACHE_DISTANCE = 100;

/** 地形查询超时（毫秒），超时后放弃本次查询 */
const TERRAIN_QUERY_TIMEOUT = 5000;

/** 碰撞平滑因子（每帧 lerp 权重），值越大推离速度越快 */
const COLLISION_SMOOTH_FACTOR = 0.3;

/** 弧度→度 换算常量 */
const RAD_TO_DEG = 180 / Math.PI;

/** 度→弧度 换算常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 半个 π（常用于俯仰角 CameraState ↔ 内部表示转换） */
const HALF_PI = Math.PI * 0.5;

/** 惯性速度最小阈值（弧度/秒），低于此值则停止惯性滑行 */
const INERTIA_EPS = 1e-6;

/** 默认轨道旋转惯性衰减系数（每帧乘性因子，越接近 1 滑行越远） */
const DEFAULT_ORBIT_INERTIA_DECAY = 0.85;

/** 默认缩放惯性衰减系数 */
const DEFAULT_ZOOM_INERTIA_DECAY = 0.9;

/** 默认飞行动画时长（毫秒） */
const DEFAULT_FLY_DURATION_MS = 2000;

/** 最小动画时长（毫秒），避免除零 */
const MIN_ANIM_MS = 16;

/** 视口最小合法边长（像素），避免除零 */
const MIN_VIEWPORT_DIM = 1;

/**
 * 内部俯仰角上限（弧度），略低于水平（0）以防 ENU 帧奇异。
 * 对应 CameraState.pitch ≈ 89.4°
 */
const MAX_PITCH_INTERNAL = -0.01;

/** 内部俯仰角下限（弧度），即正俯视 */
const MIN_PITCH_INTERNAL = -HALF_PI;

/** 飞行动画高度峰值系数：peak = angularDistance × R × 此系数 */
const FLY_PEAK_HEIGHT_FACTOR = 0.3;

/** 默认最小 zoom 级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大 zoom 级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 轨道拖拽速度平滑因子（IIR 低通权重，0~1） */
const PAN_VELOCITY_SMOOTH = 0.35;

/** 默认离地安全高度（米），地形碰撞检测时使用 */
const DEFAULT_MIN_ALT_ABOVE_TERRAIN = 10;

// ---------------------------------------------------------------------------
// 类型定义 — Camera3DOptions / Camera3D
// ---------------------------------------------------------------------------

/**
 * Camera3D 初始化选项。
 * 控制相机的初始位置、姿态、约束、惯性和地形碰撞参数。
 *
 * @example
 * const opts: Camera3DOptions = {
 *   position: { lon: 116.39, lat: 39.91, alt: 500_000 },
 *   bearing: 0,
 *   pitch: -Math.PI / 4,
 *   fov: Math.PI / 4,
 * };
 */
export interface Camera3DOptions {
    /** 初始位置 { lon (度), lat (度), alt (米) }，默认 { lon: 0, lat: 0, alt: 20_000_000 } */
    position?: { lon: number; lat: number; alt: number };

    /** 初始方位角（弧度，0=正北，顺时针为正），默认 0 */
    bearing?: number;

    /** 初始俯仰角（弧度，0=水平看地平线，负值向下看），默认 -Math.PI/4 */
    pitch?: number;

    /** 初始翻滚角（弧度），默认 0 */
    roll?: number;

    /** 最小缩放距离（米），相机到地面的最小距离，默认 1 */
    minimumZoomDistance?: number;

    /** 最大缩放距离（米），相机到地面的最大距离，默认 Infinity */
    maximumZoomDistance?: number;

    /** 是否启用地形碰撞检测，默认 true */
    enableCollision?: boolean;

    /** 最小离地高度（米），碰撞时的安全余量，默认 10 */
    minAltitudeAboveTerrain?: number;

    /** 是否启用惯性，默认 true */
    inertia?: boolean;

    /** 轨道旋转惯性衰减系数（0~1，越大滑行越远），默认 0.85 */
    orbitInertiaDecay?: number;

    /** 缩放惯性衰减系数（0~1），默认 0.9 */
    zoomInertiaDecay?: number;

    /** 垂直视场角（弧度），默认 Math.PI / 4 */
    fov?: number;
}

/**
 * 3D 地球相机控制器接口。
 * 在 {@link CameraController} 基础上扩展了 ECEF 定位、地形碰撞、大圆弧飞行等 3D 特有功能。
 *
 * @stability experimental
 */
export interface Camera3D extends CameraController {
    /** 相机类型标识，始终为 '3d' */
    readonly type: '3d';

    /**
     * 设置相机的大地坐标位置。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @param alt - 海拔高度（米）
     *
     * @example
     * cam.setPosition(116.39, 39.91, 500_000);
     */
    setPosition(lon: number, lat: number, alt: number): void;

    /**
     * 获取相机当前的大地坐标位置。
     *
     * @returns { lon (度), lat (度), alt (米) }
     *
     * @example
     * const { lon, lat, alt } = cam.getPosition();
     */
    getPosition(): { lon: number; lat: number; alt: number };

    /**
     * 设置相机姿态（方位角、俯仰角、翻滚角）。
     *
     * @param bearing - 方位角（弧度，0=正北，顺时针为正）
     * @param pitch - 俯仰角（弧度，0=水平，负值向下看）
     * @param roll - 翻滚角（弧度，可选，默认 0）
     *
     * @example
     * cam.setOrientation(Math.PI / 4, -Math.PI / 6);
     */
    setOrientation(bearing: number, pitch: number, roll?: number): void;

    /**
     * 获取相机当前姿态。
     *
     * @returns { bearing, pitch, roll } 全部弧度
     *
     * @example
     * const { bearing, pitch, roll } = cam.getOrientation();
     */
    getOrientation(): { bearing: number; pitch: number; roll: number };

    /**
     * 将相机朝向指定目标点。若提供 offset 则同时调整相机位置。
     *
     * @param target - 目标点 [lon(度), lat(度), alt(米)]
     * @param offset - 可选偏移：bearing/pitch 为从目标到相机的方位和仰角，range 为距离
     *
     * @example
     * cam.lookAt([116.39, 39.91, 0], { bearing: 0, pitch: Math.PI / 6, range: 100_000 });
     */
    lookAt(
        target: [number, number, number],
        offset?: { bearing?: number; pitch?: number; range?: number },
    ): void;

    /**
     * 飞行到指定位置，沿大圆弧 + 抛物线高度插值。
     *
     * @param options - 目标位置和动画参数
     * @returns 可取消的动画句柄
     *
     * @example
     * const anim = cam.flyToPosition({ lon: 121.47, lat: 31.23, alt: 300_000, duration: 3000 });
     * anim.finished.then(() => console.log('到达'));
     */
    flyToPosition(options: {
        lon: number;
        lat: number;
        alt: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
        easing?: (t: number) => number;
    }): CameraAnimation;

    /** 地形碰撞检测是否启用 */
    terrainCollisionEnabled: boolean;

    /**
     * 启用或禁用地形碰撞检测。
     *
     * @param enabled - 是否启用
     *
     * @example
     * cam.setTerrainCollisionEnabled(false);
     */
    setTerrainCollisionEnabled(enabled: boolean): void;

    /**
     * 设置最小离地高度（地形碰撞安全余量）。
     *
     * @param meters - 最小高度（米），必须 ≥ 0
     *
     * @example
     * cam.setMinAltitudeAboveTerrain(50);
     */
    setMinAltitudeAboveTerrain(meters: number): void;

    /**
     * 异步查询指定位置的地形高度。若无地形提供者则返回 0。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns 地形高度（米），无提供者时返回 0
     *
     * @example
     * const h = await cam.queryTerrainHeight(116.39, 39.91);
     */
    queryTerrainHeight(lon: number, lat: number): Promise<number>;

    /**
     * 设置地形高度查询提供者。
     *
     * @param provider - 异步高度查询函数（接收度为单位的经纬度）
     *
     * @example
     * cam.setTerrainProvider(async (lon, lat) => fetchDEM(lon, lat));
     */
    setTerrainProvider(provider: (lon: number, lat: number) => Promise<number>): void;

    /**
     * 获取相机到椭球面的距离（米），即大地高程。
     *
     * @returns 距离值
     *
     * @example
     * const dist = cam.getDistanceToSurface();
     */
    getDistanceToSurface(): number;

    /**
     * 设置缩放距离范围（相机到椭球面的最小和最大距离）。
     *
     * @param min - 最小距离（米）
     * @param max - 最大距离（米）
     *
     * @example
     * cam.setZoomDistanceRange(100, 50_000_000);
     */
    setZoomDistanceRange(min: number, max: number): void;

    /**
     * 以屏幕锚点为中心缩放：从相机经锚点构造射线，与椭球求交后沿射线按 zoom 差移动相机位置，再钳制高度。
     * `anchorLngLat` 与 2D/25D API 对齐，供调用方传入已拾取的地理锚点；当前实现以射线为主，开发模式下可校验一致性。
     *
     * @param anchorScreenX - 锚点屏幕 X（CSS 像素）
     * @param anchorScreenY - 锚点屏幕 Y（CSS 像素）
     * @param anchorLngLat - 锚点 [经度, 纬度]（度）
     * @param newZoom - 目标缩放级别（映射为高度后钳制）
     *
     * @stability experimental
     */
    zoomAround(
        anchorScreenX: number,
        anchorScreenY: number,
        anchorLngLat: [number, number],
        newZoom: number,
    ): void;

    // ── ECEF 直接旋转接口（极点安全）──────────────────────────────

    /**
     * 直接获取相机 ECEF 位置向量（Float64，只读引用）。
     *
     * 返回内部缓冲的**只读**引用，调用方不得修改。
     * 每帧 `update()` 执行后刷新。
     * 用途：传给 {@link rotate}/{@link rotateHorizontal}/{@link rotateVertical} 的调用方，
     * 避免 `getPosition()` → `toECEF()` 的大地坐标往返。
     *
     * @returns ECEF 位置（Float64Array[3]，米）
     */
    getPositionECEF(): Float64Array;

    /**
     * 绕任意 ECEF 单位轴旋转相机位置（Rodrigues，Float64 精度）。
     * 旋转后自动同步内部大地坐标（lon/lat/alt）。
     *
     * @param axisECEF - 单位旋转轴（ECEF，Float64Array[3]）
     * @param angle    - 旋转角（弧度）
     */
    rotate(axisECEF: Float64Array, angle: number): void;

    /**
     * 水平旋转：绕地球极轴 UNIT_Z（constrainedAxis）旋转。
     * 等价于 Cesium `rotateHorizontal`。
     * 极点无奇异性——任意纬度永远稳定。
     *
     * @param angle - 旋转角（弧度）
     */
    rotateHorizontal(angle: number): void;

    /**
     * 垂直旋转：绕切线轴旋转，极点前自动 clamp。
     *
     * 移植自 Cesium `Camera.rotateVertical`（constrainedAxis = UNIT_Z）：
     * - 计算相机位置到北/南极的角距
     * - `angle` 超过该角距时截断为 `(angleToAxis − EPSILON4)`
     * - 精确在极点时：离开方向允许，深入方向阻止
     *
     * @param angle - 旋转角（弧度，正值向北极倾斜）
     */
    rotateVertical(angle: number): void;
}

// ---------------------------------------------------------------------------
// ECEF 旋转常量（Cesium CesiumMath.EPSILON 系列等价）
// ---------------------------------------------------------------------------

/**
 * 极点方向并行判定阈值（Cesium CesiumMath.EPSILON2）。
 * `rotateVertical` 中用于判断相机位置是否在极点邻域内（|px|≤ε && |py|≤ε）。
 */
const CAM_ROT_EPSILON2 = 1e-2;

/**
 * 极点 clamp 安全余量（Cesium CesiumMath.EPSILON4，弧度）。
 * `rotateVertical` 旋转到极点前留出 ε4 安全距离，防止 ENU 帧退化。
 */
const CAM_ROT_EPSILON4 = 1e-4;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * Rodrigues 旋转（Float64）：将向量 v 绕**单位轴** k 旋转 θ 弧度，结果写入 out。
 *
 * 公式：v_rot = v·cosθ + (k×v)·sinθ + k·(k·v)·(1−cosθ)
 *
 * **in-place 安全**：`out === v` 时结果正确（k×v、k·v 均在写入前完成计算）。
 *
 * @param v     - 被旋转向量（Float64Array[3]）
 * @param k     - 单位旋转轴（Float64Array[3]）
 * @param theta - 旋转角（弧度）
 * @param out   - 输出（可与 v 相同）
 */
function rodrigues64(
    v: Float64Array, k: Float64Array, theta: number, out: Float64Array,
): void {
    const c  = Math.cos(theta);
    const s  = Math.sin(theta);
    const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];     // dot(k, v)
    const kx0 = k[1] * v[2] - k[2] * v[1];                   // cross(k,v).x
    const kx1 = k[2] * v[0] - k[0] * v[2];                   // cross(k,v).y
    const kx2 = k[0] * v[1] - k[1] * v[0];                   // cross(k,v).z
    out[0] = v[0] * c + kx0 * s + k[0] * kv * (1 - c);
    out[1] = v[1] * c + kx1 * s + k[1] * kv * (1 - c);
    out[2] = v[2] * c + kx2 * s + k[2] * kv * (1 - c);
}

/**
 * 将数值限制在闭区间 [lo, hi]；若任一参数非有限则返回安全值。
 *
 * @param v - 输入值
 * @param lo - 下界
 * @param hi - 上界
 * @returns 钳制后的值
 *
 * @example
 * clamp(12, 0, 10); // → 10
 */
function clamp(v: number, lo: number, hi: number): number {
    if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        return 0;
    }
    // 若 lo>hi 则交换，避免约束反转
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    return Math.min(b, Math.max(a, v));
}

/**
 * 线性插值。
 *
 * @param a - 起点
 * @param b - 终点
 * @param t - 插值因子 [0,1]
 * @returns 插值结果
 *
 * @example
 * lerp(0, 10, 0.5); // → 5
 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 平滑步进（Hermite），用于 easeTo 默认曲线。
 *
 * @param t - 归一化时间 [0,1]
 * @returns 缓动后的 [0,1]
 *
 * @example
 * smoothstep01(0.5); // ≈ 0.5
 */
function smoothstep01(t: number): number {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

/**
 * 生成动画实例唯一 ID（优先 Web Crypto，退化到时间戳随机串）。
 *
 * @returns 全局唯一字符串 ID
 *
 * @example
 * const id = generateAnimationId();
 */
function generateAnimationId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // 受限环境走退化路径
    }
    return `cam3d-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 将方位角归一化到 [0, 2π) 范围。
 *
 * @param bearing - 任意弧度值
 * @returns [0, 2π) 范围内的等价角
 *
 * @example
 * wrapBearing(-Math.PI / 2); // → 3π/2
 */
function wrapBearing(bearing: number): number {
    if (!Number.isFinite(bearing)) {
        return 0;
    }
    const TWO_PI = Math.PI * 2;
    let b = bearing % TWO_PI;
    if (b < 0) {
        b += TWO_PI;
    }
    return b;
}

/**
 * 计算两个角度间的最短差值（结果在 [-π, π]）。
 * 用于方位角插值避免绕远路。
 *
 * @param from - 起始角（弧度）
 * @param to - 终止角（弧度）
 * @returns 最短角差
 *
 * @example
 * shortestAngleDiff(0.1, 6.2); // ≈ -0.18（走近路）
 */
function shortestAngleDiff(from: number, to: number): number {
    let diff = to - from;
    // 防御 NaN/Infinity：while 循环对 Infinity 永不终止 → 死循环
    if (!Number.isFinite(diff)) { return 0; }
    // 将差值归一化到 [-π, π]
    while (diff > Math.PI) { diff -= Math.PI * 2; }
    while (diff < -Math.PI) { diff += Math.PI * 2; }
    return diff;
}

/**
 * 射线–球体相交检测。返回沿射线方向的参数 t（> 0 表示命中）。
 * 假设射线方向为单位向量。
 *
 * @param ox - 射线原点 X
 * @param oy - 射线原点 Y
 * @param oz - 射线原点 Z
 * @param dx - 射线方向 X（单位向量）
 * @param dy - 射线方向 Y
 * @param dz - 射线方向 Z
 * @param radius - 球体半径
 * @returns 参数 t（命中时 > 0，未命中返回 -1）
 *
 * @example
 * raySphereIntersect(0, 0, 7e6, 0, 0, -1, 6378137); // > 0（向球心射击）
 */
function raySphereIntersect(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    radius: number,
): number {
    // 对于单位方向向量 a=1, b=2(O·D), c=|O|²-R²
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - 4 * c;
    // 判别式 < 0 表示射线不与球体相交
    if (disc < 0) {
        return -1;
    }
    const sqrtDisc = Math.sqrt(disc);
    // t1 是近交点，t2 是远交点
    const t1 = (-b - sqrtDisc) * 0.5;
    const t2 = (-b + sqrtDisc) * 0.5;
    // 取最近的正交点（相机在球外时 t1>0）
    if (t1 > 0) { return t1; }
    if (t2 > 0) { return t2; }
    return -1;
}

/**
 * 将 zoom 级别转换为海拔高度（米）。
 * 近似公式：alt = C / (2^zoom × fov × 2)
 *
 * @param zoom - 缩放级别
 * @param fov - 视场角（弧度）
 * @returns 海拔高度（米）
 *
 * @example
 * zoomToAltitude(10, Math.PI / 4); // ≈ 25 000
 */
function zoomToAltitude(zoom: number, fov: number): number {
    const z = Math.max(0, zoom);
    const denom = Math.pow(2, z) * Math.max(fov, 0.01) * 2;
    return EARTH_CIRCUMFERENCE / Math.max(denom, 1e-6);
}

/**
 * 将海拔高度转换为 zoom 级别。
 * 反函数：zoom = log2(C / (alt × fov × 2))
 *
 * @param alt - 海拔高度（米）
 * @param fov - 视场角（弧度）
 * @returns zoom 级别
 *
 * @example
 * altitudeToZoom(25000, Math.PI / 4); // ≈ 10
 */
function altitudeToZoom(alt: number, fov: number): number {
    const safeAlt = Math.max(alt, 1);
    const safeFov = Math.max(fov, 0.01);
    return Math.log2(EARTH_CIRCUMFERENCE / (safeAlt * safeFov * 2));
}

// ---------------------------------------------------------------------------
// 内部动画类型
// ---------------------------------------------------------------------------

/** CameraAnimation 实现对象（可变 state） */
type CameraAnimationInternal = CameraAnimation & {
    /** 可变状态字段 */
    _state: 'running' | 'finished' | 'cancelled';
    /** 完成时 resolve 的函数引用 */
    _resolveFinished?: () => void;
};

/** 3D 飞行/缓动动画内部参数 */
type FlyAnim3D = {
    /** 动画类型：fly=大圆弧飞行 ease=线性缓动 flyPos=按位置飞行 */
    readonly kind: 'fly' | 'ease' | 'flyPos';
    /** 全局唯一 ID */
    readonly id: string;
    /** 起始时间戳（performance.now） */
    startMs: number;
    /** 时长（毫秒） */
    durationMs: number;
    /** 缓动函数 */
    easing: (t: number) => number;
    /** 起始状态 */
    from: { lonRad: number; latRad: number; alt: number; bearing: number; pitch: number; roll: number };
    /** 终止状态 */
    to: { lonRad: number; latRad: number; alt: number; bearing: number; pitch: number; roll: number };
    /** 大圆弧飞行时抛物线高度峰值（米），ease 模式为 0 */
    peakAltBonus: number;
    /** 大圆弧角度（弧度），ease 模式为 0 */
    greatCircleAngle: number;
    /** 对外动画句柄 */
    handle: CameraAnimationInternal;
};

/**
 * 创建对外可见的 CameraAnimation 句柄。
 *
 * @param id - 动画 ID
 * @param onCancel - 取消时回调
 * @returns 动画句柄对象
 *
 * @example
 * const h = createAnimHandle('id', () => cleanup());
 */
function createAnimHandle(id: string, onCancel: () => void): CameraAnimationInternal {
    let resolved = false;
    let resolveFn: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => { resolveFn = resolve; });
    const handle: CameraAnimationInternal = {
        id,
        _state: 'running',
        get state() { return handle._state; },
        cancel: () => {
            if (handle._state !== 'running') { return; }
            handle._state = 'cancelled';
            try { onCancel(); } catch (err) {
                console.error('[Camera3D] animation onCancel error', err);
            }
            if (!resolved && resolveFn) { resolved = true; resolveFn(); }
        },
        finished,
    };
    // 暴露 resolve 函数供内部完成调用
    handle._resolveFinished = () => {
        if (resolved || !resolveFn) { return; }
        resolved = true;
        resolveFn();
    };
    return handle;
}

/**
 * 完成动画（成功结束）。
 *
 * @param anim - 内部动画句柄
 *
 * @example
 * finishAnimHandle(anim);
 */
function finishAnimHandle(anim: CameraAnimationInternal): void {
    if (anim._state !== 'running') { return; }
    anim._state = 'finished';
    anim._resolveFinished?.();
}

// ---------------------------------------------------------------------------
// 可变 CameraState（矩阵缓冲区复用）
// ---------------------------------------------------------------------------

/** 可变内部状态快照 */
type MutableCameraState = {
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

/**
 * 创建可复用的矩阵与向量缓冲区。
 *
 * @returns 新建的 MutableCameraState
 *
 * @example
 * const s = createMutableState3D();
 */
function createMutableState3D(): MutableCameraState {
    return {
        center: [0, 0],
        zoom: DEFAULT_MIN_ZOOM,
        bearing: 0,
        pitch: 0,
        roll: 0,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
        vpMatrix: mat4.create(),
        inverseVPMatrix: mat4.create(),
        position: new Float32Array(3),
        altitude: DEFAULT_ALTITUDE,
        fov: DEFAULT_FOV_3D,
    };
}

// ---------------------------------------------------------------------------
// Camera3DImpl 实现
// ---------------------------------------------------------------------------

/**
 * Camera3D 完整实现（单文件内聚）。
 * 使用 ECEF 坐标系进行 3D 地球相机控制。
 */
class Camera3DImpl implements Camera3D {
    // ---- 类型标识 ----
    /** @inheritdoc */
    readonly type: '3d' = '3d';

    // ---- 大地坐标（弧度 + 米）----
    /** 经度（弧度） */
    private _lonRad: number;
    /** 纬度（弧度） */
    private _latRad: number;
    /** 大地高程 / 距椭球面距离（米） */
    private _alt: number;

    // ---- 姿态（弧度）----
    /** 方位角（弧度，0=正北，顺时针为正） */
    private _bearing: number;
    /** 俯仰角（弧度，0=水平，-π/2=正俯视） */
    private _pitch: number;
    /** 翻滚角（弧度） */
    private _roll: number;
    /** 垂直视场角（弧度） */
    private _fov: number;

    // ---- 距离约束 ----
    /** 最小缩放距离（米） */
    private _minZoomDist: number;
    /** 最大缩放距离（米） */
    private _maxZoomDist: number;

    // ---- 地形碰撞 ----
    /** 碰撞检测开关 */
    private _terrainCollision: boolean;
    /** 离地安全高度（米） */
    private _minAltAboveTerrain: number;
    /** 地形高度查询提供者 */
    private _terrainProvider: ((lon: number, lat: number) => Promise<number>) | null;
    /** 缓存的地形高度（米） */
    private _cachedTerrainH: number;
    /** 缓存对应的经度（弧度） */
    private _cachedTerrainLon: number;
    /** 缓存对应的纬度（弧度） */
    private _cachedTerrainLat: number;
    /** 是否正在进行异步地形查询 */
    private _terrainQueryPending: boolean;

    // ---- 惯性 ----
    /** 惯性开关 */
    private _inertiaEnabled: boolean;
    /** 轨道惯性衰减系数 */
    private _orbitDecay: number;
    /** 缩放惯性衰减系数 */
    private _zoomDecay: number;
    /** 经度角速度（弧度/秒） */
    private _velLon: number;
    /** 纬度角速度（弧度/秒） */
    private _velLat: number;

    // ---- 拖拽状态 ----
    /** 是否正在拖拽 */
    private _panning: boolean;
    /** 上一帧屏幕 X */
    private _panPrevX: number | null;
    /** 上一帧屏幕 Y */
    private _panPrevY: number | null;
    /** 上一 panMove 时间戳（ms） */
    private _lastPanMs: number;

    // ---- 约束 ----
    /** 当前约束对象 */
    private _constraints: CameraConstraints;

    // ---- 动画 ----
    /** 当前飞行动画（null 表示无动画） */
    private _fly: FlyAnim3D | null;

    // ---- 事件回调 ----
    /** 移动开始回调集 */
    private readonly _onMoveStartCbs: Set<() => void>;
    /** 移动中回调集 */
    private readonly _onMoveCbs: Set<(s: CameraState) => void>;
    /** 移动结束回调集 */
    private readonly _onMoveEndCbs: Set<() => void>;

    // ---- 视口缓存 ----
    /** 最近一次视口宽（像素） */
    private _vpW: number;
    /** 最近一次视口高（像素） */
    private _vpH: number;

    // ---- 销毁标记 ----
    private _destroyed: boolean;

    // ---- 是否处于移动状态（用于回调触发判定）----
    private _isMoving: boolean;

    // ---- 预分配缓冲区（帧循环内零 GC）----
    /** 可变 CameraState 快照 */
    private readonly _mutable: MutableCameraState;
    /** 双精度 ECEF 位置 */
    private readonly _ecefPosD: Float64Array;
    /** 临时双精度大地坐标 */
    private readonly _tempGeoD: Float64Array;
    /** 临时双精度 ECEF */
    private readonly _tempEcefD: Float64Array;
    /** 动画用临时 Float64 向量 A */
    private readonly _animTempA: Float64Array;
    /** 动画用临时 Float64 向量 B */
    private readonly _animTempB: Float64Array;
    /** 相机位置（Float32，用于 GPU 矩阵） */
    private readonly _eye: Float32Array;
    /** 局部 up 方向 */
    private readonly _upVec: Float32Array;
    /** 局部 east 方向 */
    private readonly _eastVec: Float32Array;
    /** 局部 north 方向 */
    private readonly _northVec: Float32Array;
    /** 水平前方（bearing 后） */
    private readonly _fwdH: Float32Array;
    /** 水平右方（bearing 后） */
    private readonly _rightH: Float32Array;
    /** 最终观察方向 */
    private readonly _lookDir: Float32Array;
    /** 最终相机上方 */
    private readonly _camUp: Float32Array;
    /** 最终相机右方 */
    private readonly _camRight: Float32Array;
    /** 临时 Vec3f */
    private readonly _tv3: Float32Array;

    /** zoomAround：逆投影近平面点（ECEF，world） */
    private readonly _zrNear: Float32Array;
    /** zoomAround：逆投影远平面点（ECEF，world） */
    private readonly _zrFar: Float32Array;
    /** zoomAround：归一化视线方向（ECEF） */
    private readonly _zrDir: Float32Array;

    /** rotateVertical 用：切线轴（Float64，预分配复用） */
    private readonly _rotTan64: Float64Array;

    // ── Cesium 架构：ECEF 朝向向量（Float64，primary state for rotate）────
    /** 相机观察方向（ECEF，单位向量），等同 Cesium Camera.direction */
    private readonly _dirECEF: Float64Array;
    /** 相机上方向（ECEF，单位向量），等同 Cesium Camera.up */
    private readonly _upECEF: Float64Array;

    /** 是否已至少执行过一次 {@link Camera3DImpl.update}（inverseVP 有效） */
    private _hasUpdatedFrame: boolean = false;

    /**
     * ECEF 向量权威标志（Cesium 架构核心）。
     *
     * - `true`：`rotate()` 刚修改了 `_ecefPosD` + `_dirECEF` + `_upECEF`（刚体旋转），
     *   `update()` 必须从这些 ECEF 向量反算 geodetic + bearing/pitch，
     *   **不得** 用旧的 geodetic/bearing/pitch 覆写 ECEF 向量。
     * - `false`（默认）：geodetic + bearing/pitch 为权威源。
     *
     * 每次 `update()` 消费后重置为 `false`。
     */
    private _ecefAuthoritative: boolean = false;

    /**
     * bearing/pitch 脏标志。
     * 当 setOrientation / handleRotate / animation / inertia 修改了 bearing/pitch 时设为 true。
     * update() 非 ECEF 路径只在此标志为 true 时才调 _syncECEFVectorsFromBearingPitch()。
     * 空闲帧（什么都没改）不同步 → _dirECEF/_upECEF 保持 rotate() 设置的正确值。
     */
    private _orientationDirty: boolean = true;  // 构造后第一帧需要同步

    /**
     * 构造 Camera3D 实例。
     *
     * @param options - 初始化选项
     */
    constructor(options?: Camera3DOptions) {
        // 解析选项，带默认值
        const pos = options?.position ?? { lon: 0, lat: 0, alt: DEFAULT_ALTITUDE };
        this._lonRad = pos.lon * DEG_TO_RAD;
        this._latRad = clamp(pos.lat * DEG_TO_RAD, -HALF_PI, HALF_PI);
        this._alt = Math.max(pos.alt, 0);
        this._bearing = wrapBearing(options?.bearing ?? 0);
        this._pitch = clamp(options?.pitch ?? DEFAULT_PITCH_3D, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        this._roll = options?.roll ?? 0;
        this._fov = clamp(options?.fov ?? DEFAULT_FOV_3D, 0.01, Math.PI - 0.01);

        // 距离约束
        this._minZoomDist = Math.max(options?.minimumZoomDistance ?? DEFAULT_MIN_ZOOM_DISTANCE, 0);
        this._maxZoomDist = Math.max(options?.maximumZoomDistance ?? Infinity, this._minZoomDist);
        // 立即钳制初始高度
        this._alt = clamp(this._alt, this._minZoomDist, this._maxZoomDist);

        // 地形碰撞
        this._terrainCollision = options?.enableCollision ?? true;
        this._minAltAboveTerrain = Math.max(options?.minAltitudeAboveTerrain ?? DEFAULT_MIN_ALT_ABOVE_TERRAIN, 0);
        this._terrainProvider = null;
        this._cachedTerrainH = 0;
        this._cachedTerrainLon = 0;
        this._cachedTerrainLat = 0;
        this._terrainQueryPending = false;

        // 惯性
        this._inertiaEnabled = options?.inertia ?? true;
        this._orbitDecay = clamp(options?.orbitInertiaDecay ?? DEFAULT_ORBIT_INERTIA_DECAY, 0, 0.9999);
        this._zoomDecay = clamp(options?.zoomInertiaDecay ?? DEFAULT_ZOOM_INERTIA_DECAY, 0, 0.9999);
        this._velLon = 0;
        this._velLat = 0;

        // 拖拽
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;
        this._lastPanMs = 0;

        // 约束（CameraState 约定：pitch 0=俯视，π/2=地平线）
        this._constraints = {
            minZoom: DEFAULT_MIN_ZOOM,
            maxZoom: DEFAULT_MAX_ZOOM,
            minPitch: 0,
            maxPitch: HALF_PI - 0.01,
        };

        // 动画
        this._fly = null;

        // 事件
        this._onMoveStartCbs = new Set();
        this._onMoveCbs = new Set();
        this._onMoveEndCbs = new Set();

        // 视口
        this._vpW = 1024;
        this._vpH = 768;

        // 标志
        this._destroyed = false;
        this._isMoving = false;

        // 预分配缓冲区
        this._mutable = createMutableState3D();
        this._ecefPosD = new Float64Array(3);
        this._tempGeoD = new Float64Array(3);
        this._tempEcefD = new Float64Array(3);
        this._animTempA = new Float64Array(3);
        this._animTempB = new Float64Array(3);
        this._eye = vec3.create();
        this._upVec = vec3.create();
        this._eastVec = vec3.create();
        this._northVec = vec3.create();
        this._fwdH = vec3.create();
        this._rightH = vec3.create();
        this._lookDir = vec3.create();
        this._camUp = vec3.create();
        this._camRight = vec3.create();
        this._tv3 = vec3.create();
        this._zrNear = vec3.create();
        this._zrFar = vec3.create();
        this._zrDir = vec3.create();
        this._rotTan64 = new Float64Array(3);
        // Cesium 架构：ECEF 朝向向量初始化
        // 初始值在第一次 update() 中由 bearing/pitch + ENU 帧计算得出
        this._dirECEF = new Float64Array(3);
        this._upECEF = new Float64Array(3);
    }

    // ===================================================================
    // 只读属性
    // ===================================================================

    /** @inheritdoc */
    get state(): CameraState { return this._mutable as CameraState; }

    /** @inheritdoc */
    get constraints(): CameraConstraints { return this._constraints; }

    /** @inheritdoc */
    get isAnimating(): boolean { return this._fly !== null; }

    /** @inheritdoc */
    get inertiaEnabled(): boolean { return this._inertiaEnabled; }

    /** @inheritdoc */
    get terrainCollisionEnabled(): boolean { return this._terrainCollision; }
    set terrainCollisionEnabled(v: boolean) { this._terrainCollision = v; }

    // ===================================================================
    // CameraController 基础方法
    // ===================================================================

    /** @inheritdoc */
    setCenter(center: [number, number]): void {
        this._checkDestroyed();
        // center 是 [lon, lat] 度
        this._lonRad = (Number.isFinite(center[0]) ? center[0] : 0) * DEG_TO_RAD;
        this._latRad = clamp((Number.isFinite(center[1]) ? center[1] : 0) * DEG_TO_RAD, -HALF_PI, HALF_PI);
    }

    /** @inheritdoc */
    setZoom(zoom: number): void {
        this._checkDestroyed();
        const z = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
        // 将 zoom 转换为高度
        this._alt = clamp(zoomToAltitude(z, this._fov), this._minZoomDist, this._maxZoomDist);
    }

    /** @inheritdoc */
    setBearing(bearing: number): void {
        this._checkDestroyed();
        this._bearing = wrapBearing(bearing);
    }

    /**
     * 设置俯仰角（CameraState 约定：0=正俯视，正值向地平线倾斜）。
     * @inheritdoc
     */
    setPitch(pitch: number): void {
        this._checkDestroyed();
        // CameraState pitch → 内部 pitch：internal = cs - π/2
        const internal = (Number.isFinite(pitch) ? pitch : 0) - HALF_PI;
        this._pitch = clamp(internal, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
    }

    /** @inheritdoc */
    jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
        this._checkDestroyed();
        this.stop();
        if (options.center) {
            this.setCenter(options.center);
        }
        if (options.zoom !== undefined) {
            this.setZoom(options.zoom);
        }
        if (options.bearing !== undefined) {
            this.setBearing(options.bearing);
        }
        if (options.pitch !== undefined) {
            this.setPitch(options.pitch);
        }
    }

    /** @inheritdoc */
    flyTo(options: {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
        easing?: (t: number) => number;
    }): CameraAnimation {
        this._checkDestroyed();
        this.stop();

        // 计算目标值（内部表示）
        const toLon = options.center ? options.center[0] * DEG_TO_RAD : this._lonRad;
        const toLat = options.center
            ? clamp(options.center[1] * DEG_TO_RAD, -HALF_PI, HALF_PI)
            : this._latRad;
        const toAlt = options.zoom !== undefined
            ? clamp(zoomToAltitude(
                clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom),
                this._fov,
            ), this._minZoomDist, this._maxZoomDist)
            : this._alt;
        const toBearing = options.bearing !== undefined ? wrapBearing(options.bearing) : this._bearing;
        const toPitch = options.pitch !== undefined
            ? clamp(options.pitch - HALF_PI, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL)
            : this._pitch;
        const durationMs = Math.max(MIN_ANIM_MS, options.duration ?? DEFAULT_FLY_DURATION_MS);
        const easing = options.easing ?? smoothstep01;

        return this._startFlyAnimation('fly', toLon, toLat, toAlt, toBearing, toPitch, this._roll, durationMs, easing);
    }

    /** @inheritdoc */
    easeTo(options: {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
    }): CameraAnimation {
        this._checkDestroyed();
        this.stop();

        const toLon = options.center ? options.center[0] * DEG_TO_RAD : this._lonRad;
        const toLat = options.center
            ? clamp(options.center[1] * DEG_TO_RAD, -HALF_PI, HALF_PI)
            : this._latRad;
        const toAlt = options.zoom !== undefined
            ? clamp(zoomToAltitude(
                clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom),
                this._fov,
            ), this._minZoomDist, this._maxZoomDist)
            : this._alt;
        const toBearing = options.bearing !== undefined ? wrapBearing(options.bearing) : this._bearing;
        const toPitch = options.pitch !== undefined
            ? clamp(options.pitch - HALF_PI, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL)
            : this._pitch;
        const durationMs = Math.max(MIN_ANIM_MS, options.duration ?? DEFAULT_FLY_DURATION_MS);

        return this._startFlyAnimation('ease', toLon, toLat, toAlt, toBearing, toPitch, this._roll, durationMs, smoothstep01);
    }

    /** @inheritdoc */
    stop(): void {
        if (this._fly) {
            const h = this._fly.handle;
            this._fly = null;
            h.cancel();
        }
    }

    /** @inheritdoc */
    setConstraints(constraints: Partial<CameraConstraints>): void {
        this._checkDestroyed();
        const next: CameraConstraints = {
            minZoom: constraints.minZoom ?? this._constraints.minZoom,
            maxZoom: constraints.maxZoom ?? this._constraints.maxZoom,
            minPitch: constraints.minPitch ?? this._constraints.minPitch,
            maxPitch: constraints.maxPitch ?? this._constraints.maxPitch,
            maxBounds: constraints.maxBounds !== undefined ? constraints.maxBounds : this._constraints.maxBounds,
        };
        // 校正 min/max 反转
        if (next.minZoom > next.maxZoom) {
            const t = next.minZoom;
            (next as { minZoom: number }).minZoom = next.maxZoom;
            (next as { maxZoom: number }).maxZoom = t;
        }
        this._constraints = next;
        // 钳制当前 zoom（通过 altitude）
        const curZoom = altitudeToZoom(this._alt, this._fov);
        const clampedZoom = clamp(curZoom, next.minZoom, next.maxZoom);
        this._alt = clamp(zoomToAltitude(clampedZoom, this._fov), this._minZoomDist, this._maxZoomDist);
        // 钳制 pitch（CameraState → 内部）
        const csMin = next.minPitch;
        const csMax = next.maxPitch;
        const iMin = clamp(csMin - HALF_PI, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        const iMax = clamp(csMax - HALF_PI, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        this._pitch = clamp(this._pitch, iMin, iMax);
        // 钳制地理范围
        if (next.maxBounds) {
            this._clampToBounds(next.maxBounds);
        }
    }

    /** @inheritdoc */
    setInertiaEnabled(enabled: boolean): void {
        this._checkDestroyed();
        this._inertiaEnabled = enabled;
        if (!enabled) {
            this._velLon = 0;
            this._velLat = 0;
        }
    }

    // ===================================================================
    // Camera3D 扩展方法
    // ===================================================================

    /** @inheritdoc */
    setPosition(lon: number, lat: number, alt: number): void {
        this._checkDestroyed();
        this._lonRad = (Number.isFinite(lon) ? lon : 0) * DEG_TO_RAD;
        this._latRad = clamp((Number.isFinite(lat) ? lat : 0) * DEG_TO_RAD, -HALF_PI, HALF_PI);
        this._alt = clamp(Number.isFinite(alt) ? alt : DEFAULT_ALTITUDE, this._minZoomDist, this._maxZoomDist);
        // 同步 ECEF，确保 _ecefPosD 与 geodetic 一致
        geodeticToECEF(this._ecefPosD, this._lonRad, this._latRad, this._alt);
        this._ecefAuthoritative = false;
        this._orientationDirty = true;  // 位置变了 → ENU 帧变了 → 需要重算 dir/up
    }

    /** @inheritdoc */
    getPosition(): { lon: number; lat: number; alt: number } {
        // 若 ECEF 为权威源（rotate*() 后尚未 update()），先按需同步 geodetic
        if (this._ecefAuthoritative) {
            ecefToGeodetic(this._tempGeoD, this._ecefPosD[0], this._ecefPosD[1], this._ecefPosD[2]);
            this._lonRad = this._tempGeoD[0];
            this._latRad = clamp(this._tempGeoD[1], -HALF_PI, HALF_PI);
            this._alt    = this._tempGeoD[2];
            // 注意：不重置 _ecefAuthoritative，update() 仍需知道 ECEF 是权威
        }
        return {
            lon: this._lonRad * RAD_TO_DEG,
            lat: this._latRad * RAD_TO_DEG,
            alt: this._alt,
        };
    }

    // ── ECEF 直接旋转接口（Cesium 架构移植）────────────────────────

    /** @inheritdoc */
    getPositionECEF(): Float64Array {
        // _ecefPosD 在每次 update() step-5 以及 rotate*() 后均保持最新。
        return this._ecefPosD;
    }

    /** @inheritdoc */
    rotate(axisECEF: Float64Array, angle: number): void {
        this._checkDestroyed();
        // ═══════════════════════════════════════════════════════════
        // 完全移植 Cesium Camera.rotate (Camera.js lines 2027-2048)
        //
        //   quaternion = Quaternion.fromAxisAngle(axis, -angle);
        //   rotation = Matrix3.fromQuaternion(quaternion);
        //   rotation × position → position
        //   rotation × direction → direction
        //   rotation × up → up
        //   right = cross(direction, up)
        //   up = cross(right, direction)   // 重正交化
        //
        // 核心：position + direction + up 三个持久 ECEF 向量用同一旋转 = 刚体运动。
        // _dirECEF/_upECEF 是持久存储，不从 bearing/pitch 重建——
        // 这样即使越过极点，朝向也自然跟随，不会因 ENU 退化而翻转。
        // ═══════════════════════════════════════════════════════════

        const negAngle = -angle;  // Cesium 约定：内部取反

        // 首次调用前确保 _dirECEF/_upECEF 已从 bearing/pitch 初始化
        if (!this._hasUpdatedFrame) {
            this._syncECEFVectorsFromBearingPitch();
        }

        // 同时旋转三个 ECEF 向量（刚体运动，和 Cesium Camera.rotate 完全一致）
        rodrigues64(this._ecefPosD, axisECEF, negAngle, this._ecefPosD);
        rodrigues64(this._dirECEF, axisECEF, negAngle, this._dirECEF);
        rodrigues64(this._upECEF, axisECEF, negAngle, this._upECEF);

        // 重正交化 up（Cesium: right = cross(dir, up); up = cross(right, dir)）
        // 用 _rotTan64 作为临时 right 向量
        const r = this._rotTan64;
        const d = this._dirECEF, u = this._upECEF;
        r[0] = d[1] * u[2] - d[2] * u[1];  // right = cross(dir, up)
        r[1] = d[2] * u[0] - d[0] * u[2];
        r[2] = d[0] * u[1] - d[1] * u[0];
        u[0] = r[1] * d[2] - r[2] * d[1];  // up = cross(right, dir)
        u[1] = r[2] * d[0] - r[0] * d[2];
        u[2] = r[0] * d[1] - r[1] * d[0];

        this._ecefAuthoritative = true;

        // ═════════════════════════════════════════════════════════════
        // 关键：立即重建 inverseVP，让同一帧内下一次 pickGlobeECEF 使用最新相机。
        //
        // 不这么做的后果：一帧内多次 mousemove 共用同一个过时 inverseVP，
        // 相机越过极点后屏幕→ECEF 映射完全反转 → 旋转方向反复跳变（振荡/翻转）。
        //
        // Cesium 不存在此问题因为 updateMembers() 在每次属性访问前自动重算；
        // 我们的架构需要手动触发。
        // ═════════════════════════════════════════════════════════════
        this._rebuildVP();
    }

    /**
     * 从当前 _ecefPosD + _dirECEF + _upECEF 快速重建 view matrix → VP → inverseVP。
     * 不涉及 geodetic、ENU、bearing/pitch——纯 ECEF 向量 → 矩阵。
     * 由 rotate() 在每次旋转后调用，确保同帧内下一次 pick 用最新相机。
     */
    private _rebuildVP(): void {
        // 1. 拷贝到 Float32
        this._eye[0] = this._ecefPosD[0];
        this._eye[1] = this._ecefPosD[1];
        this._eye[2] = this._ecefPosD[2];
        this._lookDir[0] = this._dirECEF[0];
        this._lookDir[1] = this._dirECEF[1];
        this._lookDir[2] = this._dirECEF[2];
        this._camUp[0] = this._upECEF[0];
        this._camUp[1] = this._upECEF[1];
        this._camUp[2] = this._upECEF[2];
        this._camRight[0] = this._dirECEF[1] * this._upECEF[2] - this._dirECEF[2] * this._upECEF[1];
        this._camRight[1] = this._dirECEF[2] * this._upECEF[0] - this._dirECEF[0] * this._upECEF[2];
        this._camRight[2] = this._dirECEF[0] * this._upECEF[1] - this._dirECEF[1] * this._upECEF[0];

        // 2. view matrix
        this._buildViewMatrix();

        // 3. VP = P × V（projection 不变）
        mat4.multiply(this._mutable.vpMatrix, this._mutable.projectionMatrix, this._mutable.viewMatrix);

        // 4. 逆 VP（pick 用）
        if (mat4.invert(this._mutable.inverseVPMatrix, this._mutable.vpMatrix) === null) {
            mat4.identity(this._mutable.inverseVPMatrix);
        }
    }

    /**
     * 从当前 bearing/pitch + ENU 帧 初始化持久的 _dirECEF 和 _upECEF。
     * 在 rotate() 首次调用前、或 setOrientation() 后调用。
     */
    private _syncECEFVectorsFromBearingPitch(): void {
        // 确保 _ecefPosD 有效
        geodeticToECEF(this._ecefPosD, this._lonRad, this._latRad, this._alt);

        const ex = this._ecefPosD[0], ey = this._ecefPosD[1], ez = this._ecefPosD[2];
        const rho = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (rho < 1e-10) { return; }

        // ENU 帧
        const uX = ex / rho, uY = ey / rho, uZ = ez / rho;
        let eX = -uY, eY = uX, eZ = 0;
        const eLen = Math.sqrt(eX * eX + eY * eY);
        if (eLen < 1e-10) { eX = 1; eY = 0; } else { eX /= eLen; eY /= eLen; }
        const nX = uY * eZ - uZ * eY;
        const nY = uZ * eX - uX * eZ;
        const nZ = uX * eY - uY * eX;

        // fwdH = cos(bearing)·north + sin(bearing)·east
        const cB = Math.cos(this._bearing), sB = Math.sin(this._bearing);
        const fX = cB * nX + sB * eX, fY = cB * nY + sB * eY, fZ = cB * nZ + sB * eZ;

        // direction = cos(pitch)·fwdH + sin(pitch)·up
        const cP = Math.cos(this._pitch), sP = Math.sin(this._pitch);
        this._dirECEF[0] = cP * fX + sP * uX;
        this._dirECEF[1] = cP * fY + sP * uY;
        this._dirECEF[2] = cP * fZ + sP * uZ;

        // camUp = -sin(pitch)·fwdH + cos(pitch)·up
        this._upECEF[0] = -sP * fX + cP * uX;
        this._upECEF[1] = -sP * fY + cP * uY;
        this._upECEF[2] = -sP * fZ + cP * uZ;
    }

    /** @inheritdoc */
    rotateHorizontal(angle: number): void {
        this._checkDestroyed();
        if (!this._hasUpdatedFrame) { this._syncECEFVectorsFromBearingPitch(); }

        // 绕 UNIT_Z = (0,0,1) 旋转 position + direction + up（刚体运动）
        // 对 Z 轴旋转简化为 2D：x'=x·c-y·s, y'=x·s+y·c, z'=z
        // Cesium 约定：内部取反角度
        const c = Math.cos(-angle);
        const s = Math.sin(-angle);

        // position
        const px = this._ecefPosD[0], py = this._ecefPosD[1];
        this._ecefPosD[0] = px * c - py * s;
        this._ecefPosD[1] = px * s + py * c;

        // direction
        const dx = this._dirECEF[0], dy = this._dirECEF[1];
        this._dirECEF[0] = dx * c - dy * s;
        this._dirECEF[1] = dx * s + dy * c;

        // up
        const ux = this._upECEF[0], uy = this._upECEF[1];
        this._upECEF[0] = ux * c - uy * s;
        this._upECEF[1] = ux * s + uy * c;

        this._ecefAuthoritative = true;
        this._rebuildVP();
    }

    /** @inheritdoc */
    rotateVertical(angle: number): void {
        this._checkDestroyed();
        if (!this._hasUpdatedFrame) { this._syncECEFVectorsFromBearingPitch(); }

        // 归一化当前位置方向 p̂
        const ex = this._ecefPosD[0], ey = this._ecefPosD[1], ez = this._ecefPosD[2];
        const rho = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (rho < 1e-10) { return; }
        const px = ex / rho, py = ey / rho, pz = ez / rho;

        // 极点并行判定（Cesium equalsEpsilon(p, ±UNIT_Z, EPSILON2)）
        const nearPole = Math.abs(px) <= CAM_ROT_EPSILON2 && Math.abs(py) <= CAM_ROT_EPSILON2;
        const northParallel = nearPole && pz > 0;
        const southParallel = nearPole && pz < 0;

        if (!northParallel && !southParallel) {
            // ── 常规情况：clamp 后绕切线轴旋转 ────────────────────
            let angleToNorth = Math.acos(Math.max(-1, Math.min(1, pz)));
            if (angle > 0 && angle > angleToNorth) {
                angle = angleToNorth - CAM_ROT_EPSILON4;
            }
            const angleToSouth = Math.acos(Math.max(-1, Math.min(1, -pz)));
            if (angle < 0 && -angle > angleToSouth) {
                angle = -angleToSouth + CAM_ROT_EPSILON4;
            }
            if (Math.abs(angle) < 1e-14) { return; }

            // 切线轴 = normalize(cross(UNIT_Z, p̂)) = normalize((-py, px, 0))
            const tx = -py, ty = px;
            const tLen = Math.sqrt(tx * tx + ty * ty);
            this._rotTan64[0] = tx / tLen;
            this._rotTan64[1] = ty / tLen;
            this._rotTan64[2] = 0;

            // 刚体旋转 position + direction + up（Cesium 约定：取反角度）
            rodrigues64(this._ecefPosD, this._rotTan64, -angle, this._ecefPosD);
            rodrigues64(this._dirECEF, this._rotTan64, -angle, this._dirECEF);
            rodrigues64(this._upECEF, this._rotTan64, -angle, this._upECEF);

        } else if ((northParallel && angle < 0) || (southParallel && angle > 0)) {
            // 精确在极点，离开方向 → 绕任意水平轴
            this._rotTan64[0] = 1; this._rotTan64[1] = 0; this._rotTan64[2] = 0;
            rodrigues64(this._ecefPosD, this._rotTan64, -angle, this._ecefPosD);
            rodrigues64(this._dirECEF, this._rotTan64, -angle, this._dirECEF);
            rodrigues64(this._upECEF, this._rotTan64, -angle, this._upECEF);
        } else {
            return; // 在极点且试图深入 → 不旋转
        }

        this._ecefAuthoritative = true;
        this._rebuildVP();
    }

    /** @inheritdoc */
    setOrientation(bearing: number, pitch: number, roll?: number): void {
        this._checkDestroyed();
        this._bearing = wrapBearing(Number.isFinite(bearing) ? bearing : 0);
        this._pitch = clamp(Number.isFinite(pitch) ? pitch : DEFAULT_PITCH_3D, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        this._roll = Number.isFinite(roll ?? 0) ? (roll ?? 0) : 0;
        // 同步 ECEF 朝向向量，供 rotate() 使用
        this._syncECEFVectorsFromBearingPitch();
    }

    /** @inheritdoc */
    getOrientation(): { bearing: number; pitch: number; roll: number } {
        return { bearing: this._bearing, pitch: this._pitch, roll: this._roll };
    }

    /** @inheritdoc */
    lookAt(
        target: [number, number, number],
        offset?: { bearing?: number; pitch?: number; range?: number },
    ): void {
        this._checkDestroyed();
        this.stop();

        // 目标大地坐标（弧度）
        const tLonRad = (Number.isFinite(target[0]) ? target[0] : 0) * DEG_TO_RAD;
        const tLatRad = clamp((Number.isFinite(target[1]) ? target[1] : 0) * DEG_TO_RAD, -HALF_PI, HALF_PI);
        const tAlt = Number.isFinite(target[2]) ? target[2] : 0;

        if (offset && offset.range !== undefined && offset.range > 0) {
            // 有偏移：计算相机在目标周围的轨道位置
            const offBearing = offset.bearing ?? 0;
            const offPitch = clamp(offset.pitch ?? 0, -HALF_PI + 0.01, HALF_PI - 0.01);
            const range = Math.max(offset.range, 1);

            // 目标 ECEF
            geodeticToECEF(this._tempEcefD, tLonRad, tLatRad, tAlt);

            // 在目标处构建 ENU 帧
            const tLen = Math.sqrt(
                this._tempEcefD[0] ** 2 + this._tempEcefD[1] ** 2 + this._tempEcefD[2] ** 2,
            );
            const safeLen = Math.max(tLen, 1);
            const tux = this._tempEcefD[0] / safeLen;
            const tuy = this._tempEcefD[1] / safeLen;
            const tuz = this._tempEcefD[2] / safeLen;

            // east = normalize(cross([0,0,1], up))
            let tex = -tuy, tey = tux, tez = 0;
            const eLen = Math.sqrt(tex * tex + tey * tey + tez * tez);
            if (eLen < 1e-6) { tex = 1; tey = 0; tez = 0; } else {
                tex /= eLen; tey /= eLen; tez /= eLen;
            }
            // north = cross(up, east)
            const tnx = tuy * tez - tuz * tey;
            const tny = tuz * tex - tux * tez;
            const tnz = tux * tey - tuy * tex;

            // 从目标到相机的方向（在目标 ENU 帧中）
            const cosOB = Math.cos(offBearing), sinOB = Math.sin(offBearing);
            const cosOP = Math.cos(offPitch), sinOP = Math.sin(offPitch);
            // 水平方向（bearing 旋转 north）
            const hx = cosOB * tnx + sinOB * tex;
            const hy = cosOB * tny + sinOB * tey;
            const hz = cosOB * tnz + sinOB * tez;
            // 三维方向（pitch 提升）
            const dirX = cosOP * hx + sinOP * tux;
            const dirY = cosOP * hy + sinOP * tuy;
            const dirZ = cosOP * hz + sinOP * tuz;

            // 相机 ECEF = target_ECEF + dir * range
            this._ecefPosD[0] = this._tempEcefD[0] + dirX * range;
            this._ecefPosD[1] = this._tempEcefD[1] + dirY * range;
            this._ecefPosD[2] = this._tempEcefD[2] + dirZ * range;

            // 转回大地坐标
            ecefToGeodetic(this._tempGeoD, this._ecefPosD[0], this._ecefPosD[1], this._ecefPosD[2]);
            this._lonRad = this._tempGeoD[0];
            this._latRad = clamp(this._tempGeoD[1], -HALF_PI, HALF_PI);
            this._alt = clamp(this._tempGeoD[2], this._minZoomDist, this._maxZoomDist);

            // 从相机看向目标：bearing = offBearing + π, pitch 相应反转
            this._bearing = wrapBearing(offBearing + Math.PI);
            this._pitch = clamp(-offPitch, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        } else {
            // 无偏移：仅改变朝向，不移动相机
            // 计算从相机到目标的方向
            geodeticToECEF(this._ecefPosD, this._lonRad, this._latRad, this._alt);
            geodeticToECEF(this._tempEcefD, tLonRad, tLatRad, tAlt);

            // 方向向量（目标 - 相机）
            const dx = this._tempEcefD[0] - this._ecefPosD[0];
            const dy = this._tempEcefD[1] - this._ecefPosD[1];
            const dz = this._tempEcefD[2] - this._ecefPosD[2];
            const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dLen < 1e-3) { return; }

            // 转换为相机的 ENU 局部方向
            this._computeENUFromEcef();
            const eE = this._eastVec, eN = this._northVec, eU = this._upVec;
            // 将方向投影到 ENU 分量
            const localE = (dx * eE[0] + dy * eE[1] + dz * eE[2]) / dLen;
            const localN = (dx * eN[0] + dy * eN[1] + dz * eN[2]) / dLen;
            const localU = (dx * eU[0] + dy * eU[1] + dz * eU[2]) / dLen;

            // bearing = atan2(east, north)
            this._bearing = wrapBearing(Math.atan2(localE, localN));
            // pitch = asin(up_component)，结果在 [-π/2, π/2]
            const horizontalMag = Math.sqrt(localE * localE + localN * localN);
            this._pitch = clamp(Math.atan2(localU, horizontalMag), MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        }
    }

    /** @inheritdoc */
    flyToPosition(options: {
        lon: number;
        lat: number;
        alt: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
        easing?: (t: number) => number;
    }): CameraAnimation {
        this._checkDestroyed();
        this.stop();

        const toLon = (Number.isFinite(options.lon) ? options.lon : 0) * DEG_TO_RAD;
        const toLat = clamp((Number.isFinite(options.lat) ? options.lat : 0) * DEG_TO_RAD, -HALF_PI, HALF_PI);
        const toAlt = clamp(Number.isFinite(options.alt) ? options.alt : this._alt, this._minZoomDist, this._maxZoomDist);
        const toBearing = options.bearing !== undefined ? wrapBearing(options.bearing) : this._bearing;
        // flyToPosition 的 pitch 使用 Camera3D 内部约定
        const toPitch = options.pitch !== undefined
            ? clamp(options.pitch, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL)
            : this._pitch;
        const durationMs = Math.max(MIN_ANIM_MS, options.duration ?? DEFAULT_FLY_DURATION_MS);
        const easing = options.easing ?? smoothstep01;

        return this._startFlyAnimation('flyPos', toLon, toLat, toAlt, toBearing, toPitch, this._roll, durationMs, easing);
    }

    /** @inheritdoc */
    setTerrainCollisionEnabled(enabled: boolean): void {
        this._checkDestroyed();
        this._terrainCollision = enabled;
    }

    /** @inheritdoc */
    setMinAltitudeAboveTerrain(meters: number): void {
        this._checkDestroyed();
        this._minAltAboveTerrain = Math.max(Number.isFinite(meters) ? meters : 0, 0);
    }

    /** @inheritdoc */
    queryTerrainHeight(lon: number, lat: number): Promise<number> {
        if (!this._terrainProvider) {
            return Promise.resolve(0);
        }
        // 增加超时保护
        const provider = this._terrainProvider;
        return new Promise<number>((resolve) => {
            const timer = setTimeout(() => { resolve(0); }, TERRAIN_QUERY_TIMEOUT);
            provider(lon, lat)
                .then((h) => { clearTimeout(timer); resolve(Number.isFinite(h) ? h : 0); })
                .catch(() => { clearTimeout(timer); resolve(0); });
        });
    }

    /** @inheritdoc */
    setTerrainProvider(provider: (lon: number, lat: number) => Promise<number>): void {
        this._checkDestroyed();
        this._terrainProvider = provider;
        // 重置缓存，下次 update 重新查询
        this._cachedTerrainH = 0;
        this._cachedTerrainLon = 0;
        this._cachedTerrainLat = 0;
        this._terrainQueryPending = false;
    }

    /** @inheritdoc */
    getDistanceToSurface(): number {
        return Math.max(this._alt, 0);
    }

    /** @inheritdoc */
    setZoomDistanceRange(min: number, max: number): void {
        this._checkDestroyed();
        this._minZoomDist = Math.max(Number.isFinite(min) ? min : 0, 0);
        this._maxZoomDist = Math.max(Number.isFinite(max) ? max : Infinity, this._minZoomDist);
        // 钳制当前高度
        this._alt = clamp(this._alt, this._minZoomDist, this._maxZoomDist);
    }

    /** @inheritdoc */
    zoomAround(
        anchorScreenX: number,
        anchorScreenY: number,
        anchorLngLat: [number, number],
        newZoom: number,
    ): void {
        this._checkDestroyed();
        if (
            !Number.isFinite(anchorScreenX) ||
            !Number.isFinite(anchorScreenY) ||
            !Number.isFinite(anchorLngLat[0]) ||
            !Number.isFinite(anchorLngLat[1]) ||
            !Number.isFinite(newZoom)
        ) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera3D] zoomAround: non-finite arguments ignored');
            }
            return;
        }

        if (!this._hasUpdatedFrame) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera3D] zoomAround: inverse VP not ready; call update() first');
            }
            return;
        }

        const vpW = Math.max(this._vpW, MIN_VIEWPORT_DIM);
        const vpH = Math.max(this._vpH, MIN_VIEWPORT_DIM);

        const oldZoom = altitudeToZoom(this._alt, this._fov);
        const zNew = clamp(newZoom, this._constraints.minZoom, this._constraints.maxZoom);
        if (Math.abs(zNew - oldZoom) < 1e-10) {
            return;
        }

        const ndcX = (anchorScreenX / vpW) * 2 - 1;
        const ndcY = 1 - (anchorScreenY / vpH) * 2;

        vec3.set(this._zrNear, ndcX, ndcY, 1.0);
        vec3.transformMat4(this._zrNear, this._zrNear, this._mutable.inverseVPMatrix);
        vec3.set(this._zrFar, ndcX, ndcY, 0.0);
        vec3.transformMat4(this._zrFar, this._zrFar, this._mutable.inverseVPMatrix);

        this._zrDir[0] = this._zrFar[0] - this._zrNear[0];
        this._zrDir[1] = this._zrFar[1] - this._zrNear[1];
        this._zrDir[2] = this._zrFar[2] - this._zrNear[2];
        const dlen = Math.sqrt(
            this._zrDir[0] * this._zrDir[0] +
                this._zrDir[1] * this._zrDir[1] +
                this._zrDir[2] * this._zrDir[2],
        );
        if (dlen < 1e-12 || !Number.isFinite(dlen)) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera3D] zoomAround: degenerate ray direction');
            }
            this.setZoom(zNew);
            return;
        }
        this._zrDir[0] /= dlen;
        this._zrDir[1] /= dlen;
        this._zrDir[2] /= dlen;

        const ox = this._ecefPosD[0];
        const oy = this._ecefPosD[1];
        const oz = this._ecefPosD[2];
        const dx = this._zrDir[0];
        const dy = this._zrDir[1];
        const dz = this._zrDir[2];

        const tHit = raySphereIntersect(ox, oy, oz, dx, dy, dz, WGS84_A);
        if (tHit <= 0 || !Number.isFinite(tHit)) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera3D] zoomAround: ray misses ellipsoid; falling back to setZoom');
            }
            this.setZoom(zNew);
            return;
        }

        const zoomDelta = zNew - oldZoom;
        // moveFactor = 沿射线移动的高度比例，使一个 zoom 级对应高度减半
        // zoom 数学推导：altNew/altOld = 2^(-delta) → moveFraction = 1 - 2^(-delta)
        // delta=1.0 → moveFactor=0.5（高度减半），delta=0.5 → moveFactor≈0.293
        const moveFactor = 1 - Math.pow(2, -zoomDelta);
        const step = tHit * moveFactor;
        if (!Number.isFinite(step)) {
            this.setZoom(zNew);
            return;
        }

        const newX = ox + dx * step;
        const newY = oy + dy * step;
        const newZ = oz + dz * step;

        ecefToGeodetic(this._tempGeoD, newX, newY, newZ);
        this._lonRad = this._tempGeoD[0];
        this._latRad = clamp(this._tempGeoD[1], -HALF_PI, HALF_PI);
        this._alt = clamp(this._tempGeoD[2], this._minZoomDist, this._maxZoomDist);
    }

    // ===================================================================
    // 交互处理
    // ===================================================================

    /** @inheritdoc */
    handlePanStart(screenX: number, screenY: number): void {
        this._checkDestroyed();
        this._panning = true;
        this._panPrevX = screenX;
        this._panPrevY = screenY;
        this._lastPanMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // 重置惯性速度
        this._velLon = 0;
        this._velLat = 0;
        this._emitMoveStart();
    }

    /** @inheritdoc */
    handlePanMove(screenX: number, screenY: number): void {
        this._checkDestroyed();
        if (this._panPrevX === null || this._panPrevY === null) { return; }

        const dx = screenX - this._panPrevX;
        const dy = screenY - this._panPrevY;
        this._panPrevX = screenX;
        this._panPrevY = screenY;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const prevMs = this._lastPanMs;
        this._lastPanMs = now;

        // 从视口和距离计算每像素对应的弧度
        const vpH = Math.max(this._vpH, MIN_VIEWPORT_DIM);
        const distToSurface = Math.max(this._alt, 1);
        // 每像素在地面上对应的米数
        const metersPerPixel = 2 * Math.tan(this._fov * 0.5) * distToSurface / vpH;
        // 换算为地心角（弧度/像素）
        const radiansPerPixel = metersPerPixel / WGS84_A;

        // 经度变化需除以 cos(lat) 以补偿经线收敛
        const cosLat = Math.max(Math.abs(Math.cos(this._latRad)), 0.01);
        const dLon = -dx * radiansPerPixel / cosLat;
        const dLat = dy * radiansPerPixel;

        this._lonRad += dLon;
        this._latRad = clamp(this._latRad + dLat, -HALF_PI, HALF_PI);

        // 更新惯性速度（IIR 低通滤波）
        const dtSec = Math.max(1e-4, (now - prevMs) / 1000);
        const vLon = dLon / dtSec;
        const vLat = dLat / dtSec;
        this._velLon = PAN_VELOCITY_SMOOTH * vLon + (1 - PAN_VELOCITY_SMOOTH) * this._velLon;
        this._velLat = PAN_VELOCITY_SMOOTH * vLat + (1 - PAN_VELOCITY_SMOOTH) * this._velLat;

        // 若有地理范围约束则钳制
        if (this._constraints.maxBounds) {
            this._clampToBounds(this._constraints.maxBounds);
        }

        this._emitMove();
    }

    /** @inheritdoc */
    handlePanEnd(): void {
        this._checkDestroyed();
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;
        this._emitMoveEnd();
    }

    /** @inheritdoc */
    handleZoom(delta: number, _screenX: number, _screenY: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(delta) || delta === 0) { return; }

        // 缩放因子：正 delta（滚轮上滚）= 放大 = 靠近地面 = 距离减小
        const factor = Math.pow(1.002, -delta);
        const newAlt = clamp(this._alt * factor, this._minZoomDist, this._maxZoomDist);
        this._alt = newAlt;
    }

    /** @inheritdoc */
    handleRotate(bearingDelta: number, pitchDelta: number): void {
        this._checkDestroyed();
        if (Number.isFinite(bearingDelta) && bearingDelta !== 0) {
            this._bearing = wrapBearing(this._bearing + bearingDelta);
        }
        if (Number.isFinite(pitchDelta) && pitchDelta !== 0) {
            this._pitch = clamp(this._pitch + pitchDelta, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        }
        // 同步 ECEF 朝向向量（bearing/pitch 变了 → _dirECEF/_upECEF 必须更新）
        this._syncECEFVectorsFromBearingPitch();
    }

    // ===================================================================
    // 事件订阅
    // ===================================================================

    /** @inheritdoc */
    onMoveStart(callback: () => void): () => void {
        this._onMoveStartCbs.add(callback);
        return () => { this._onMoveStartCbs.delete(callback); };
    }

    /** @inheritdoc */
    onMove(callback: (state: CameraState) => void): () => void {
        this._onMoveCbs.add(callback);
        return () => { this._onMoveCbs.delete(callback); };
    }

    /** @inheritdoc */
    onMoveEnd(callback: () => void): () => void {
        this._onMoveEndCbs.add(callback);
        return () => { this._onMoveEndCbs.delete(callback); };
    }

    // ===================================================================
    // 帧更新
    // ===================================================================

    /** @inheritdoc */
    update(deltaTime: number, viewport: Viewport): CameraState {
        this._checkDestroyed();

        // 缓存视口
        this._vpW = Math.max(viewport.width, MIN_VIEWPORT_DIM);
        this._vpH = Math.max(viewport.height, MIN_VIEWPORT_DIM);
        const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;

        // ---- 1. 动画处理 ----
        if (this._fly) {
            this._updateAnimation();
            this._orientationDirty = true;  // 动画修改了 bearing/pitch/position
        } else if (this._inertiaEnabled && !this._panning) {
            // ---- 2. 惯性处理 ----
            const hasOrbitInertia = Math.abs(this._velLon) > INERTIA_EPS || Math.abs(this._velLat) > INERTIA_EPS;
            if (hasOrbitInertia && dt > 0) {
                const decay = Math.pow(this._orbitDecay, dt * 60);
                this._lonRad += this._velLon * dt;
                this._latRad = clamp(this._latRad + this._velLat * dt, -HALF_PI, HALF_PI);
                this._velLon *= decay;
                this._velLat *= decay;
                if (Math.abs(this._velLon) < INERTIA_EPS) { this._velLon = 0; }
                if (Math.abs(this._velLat) < INERTIA_EPS) { this._velLat = 0; }
                if (this._constraints.maxBounds) { this._clampToBounds(this._constraints.maxBounds); }
                this._orientationDirty = true;  // 惯性修改了 position → ENU 变了
            }
        }

        // ---- 3. 地形碰撞 ----
        if (this._terrainCollision && this._terrainProvider) {
            this._processTerrainCollision(dt);
        }

        // ---- 4 & 5. 位置同步 ──────────────────────────────────────
        if (this._ecefAuthoritative) {
            // rotate() 修改了 _ecefPosD + _dirECEF + _upECEF（刚体旋转）。
            // 反算 geodetic（给 terrain/fillCameraState 消费），不覆写 ECEF。
            ecefToGeodetic(this._tempGeoD, this._ecefPosD[0], this._ecefPosD[1], this._ecefPosD[2]);
            this._lonRad = this._tempGeoD[0];
            this._latRad = clamp(this._tempGeoD[1], -HALF_PI, HALF_PI);
            this._alt = clamp(this._tempGeoD[2], this._minZoomDist, this._maxZoomDist);
            this._ecefAuthoritative = false;
            // _dirECEF/_upECEF 已被 rotate() 正确设置，不做任何操作
        } else {
            // geodetic 为权威源（setPosition / animation / inertia）
            this._alt = clamp(this._alt, this._minZoomDist, this._maxZoomDist);
            this._latRad = clamp(this._latRad, -HALF_PI, HALF_PI);
            geodeticToECEF(this._ecefPosD, this._lonRad, this._latRad, this._alt);
            // 只在 bearing/pitch 实际被修改时才同步 _dirECEF/_upECEF。
            // 空闲帧不同步 → rotate() 设置的正确朝向被保留，不被极点退化的 bearing/pitch 覆盖。
            if (this._orientationDirty) {
                this._syncECEFVectorsFromBearingPitch();
                this._orientationDirty = false;
            }
        }

        // ---- 6. 从 _dirECEF/_upECEF 构建相机轴（永远，无分支）────
        // _dirECEF/_upECEF 始终是朝向的 primary state：
        //   - rotate() 直接旋转它们
        //   - 非 rotate 路径由 _syncECEFVectorsFromBearingPitch() 保持同步
        // 这样永远不会因 ENU 退化（极点）导致朝向错误。
        this._eye[0] = this._ecefPosD[0];
        this._eye[1] = this._ecefPosD[1];
        this._eye[2] = this._ecefPosD[2];

        this._lookDir[0] = this._dirECEF[0];
        this._lookDir[1] = this._dirECEF[1];
        this._lookDir[2] = this._dirECEF[2];
        this._camUp[0] = this._upECEF[0];
        this._camUp[1] = this._upECEF[1];
        this._camUp[2] = this._upECEF[2];
        // right = cross(direction, up)
        this._camRight[0] = this._dirECEF[1] * this._upECEF[2] - this._dirECEF[2] * this._upECEF[1];
        this._camRight[1] = this._dirECEF[2] * this._upECEF[0] - this._dirECEF[0] * this._upECEF[2];
        this._camRight[2] = this._dirECEF[0] * this._upECEF[1] - this._dirECEF[1] * this._upECEF[0];

        // ---- 7. 构建视图矩阵 ────
        this._buildViewMatrix();

        // 反算 bearing/pitch 给 fillCameraState（metadata only，不影响渲染）
        this._computeENUFromEye();
        {
            const eN = this._northVec, eE = this._eastVec, eU = this._upVec;
            const dotU = this._dirECEF[0] * eU[0] + this._dirECEF[1] * eU[1] + this._dirECEF[2] * eU[2];
            this._pitch = clamp(Math.asin(Math.max(-1, Math.min(1, dotU))), MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
            const dotE = this._dirECEF[0] * eE[0] + this._dirECEF[1] * eE[1] + this._dirECEF[2] * eE[2];
            const dotN = this._dirECEF[0] * eN[0] + this._dirECEF[1] * eN[1] + this._dirECEF[2] * eN[2];
            this._bearing = wrapBearing(Math.atan2(dotE, dotN));
        }

        // ---- 9. 投影矩阵 ----
        const aspect = this._vpW / Math.max(this._vpH, 1);
        const distToSurface = Math.max(this._alt, 1);
        // near plane 与离地距离成正比，保证近处不裁剪
        const near = Math.max(1.0, distToSurface * 0.001);
        mat4.perspectiveReversedZInfinite(this._mutable.projectionMatrix, this._fov, aspect, near);

        // ---- 10. VP = P × V ----
        mat4.multiply(this._mutable.vpMatrix, this._mutable.projectionMatrix, this._mutable.viewMatrix);

        // ---- 11. 逆 VP ----
        if (mat4.invert(this._mutable.inverseVPMatrix, this._mutable.vpMatrix) === null) {
            mat4.identity(this._mutable.inverseVPMatrix);
        }

        // ---- 12. 填充 CameraState ----
        this._fillCameraState();

        this._hasUpdatedFrame = true;

        return this._mutable as CameraState;
    }

    // ===================================================================
    // destroy
    // ===================================================================

    /** @inheritdoc */
    destroy(): void {
        if (this._destroyed) { return; }
        this._destroyed = true;
        this.stop();
        this._onMoveStartCbs.clear();
        this._onMoveCbs.clear();
        this._onMoveEndCbs.clear();
        this._velLon = 0;
        this._velLat = 0;
        this._terrainProvider = null;
    }

    // ===================================================================
    // 私有辅助方法
    // ===================================================================

    /**
     * 检查是否已销毁，若已销毁则抛出错误。
     *
     * @throws Error 若控制器已销毁
     *
     * @example
     * this._checkDestroyed();
     */
    private _checkDestroyed(): void {
        if (this._destroyed) {
            throw new Error('[Camera3D] controller destroyed');
        }
    }

    /**
     * 从 Float32 _eye 计算 ENU 帧（_upVec, _eastVec, _northVec）。
     * 处理极点退化情况。
     *
     * @example
     * this._computeENUFromEye();
     */
    private _computeENUFromEye(): void {
        // up = normalize(eye)
        vec3.normalize(this._upVec, this._eye);

        // east = normalize(cross([0,0,1], up))
        vec3.set(this._tv3, 0, 0, 1);
        vec3.cross(this._eastVec, this._tv3, this._upVec);
        const eastLen = vec3.length(this._eastVec);
        if (eastLen < 1e-6) {
            // 极点退化：up ≈ [0,0,±1]，选用 [1,0,0] 作为东方向
            vec3.set(this._eastVec, 1, 0, 0);
        } else {
            vec3.normalize(this._eastVec, this._eastVec);
        }

        // north = normalize(cross(up, east))
        vec3.cross(this._northVec, this._upVec, this._eastVec);
        vec3.normalize(this._northVec, this._northVec);
    }

    /**
     * 从 Float64 _ecefPosD 计算 ENU 帧（写入 Float32 _upVec, _eastVec, _northVec）。
     * 用于 lookAt 方法中在 update 之外访问 ENU 帧。
     *
     * @example
     * this._computeENUFromEcef();
     */
    private _computeENUFromEcef(): void {
        // 先复制到 _eye
        this._eye[0] = this._ecefPosD[0];
        this._eye[1] = this._ecefPosD[1];
        this._eye[2] = this._ecefPosD[2];
        this._computeENUFromEye();
    }

    /**
     * 根据 bearing/pitch/roll 和 ENU 帧计算最终相机轴
     * （_lookDir, _camUp, _camRight）。
     *
     * @example
     * this._computeCameraAxes();
     */
    private _computeCameraAxes(): void {
        const cosB = Math.cos(this._bearing);
        const sinB = Math.sin(this._bearing);
        const eE = this._eastVec, eN = this._northVec, eU = this._upVec;

        // fwdH = cos(bearing)·north + sin(bearing)·east（水平前方）
        this._fwdH[0] = cosB * eN[0] + sinB * eE[0];
        this._fwdH[1] = cosB * eN[1] + sinB * eE[1];
        this._fwdH[2] = cosB * eN[2] + sinB * eE[2];

        // rightH = cos(bearing)·east - sin(bearing)·north（水平右方）
        this._rightH[0] = cosB * eE[0] - sinB * eN[0];
        this._rightH[1] = cosB * eE[1] - sinB * eN[1];
        this._rightH[2] = cosB * eE[2] - sinB * eN[2];

        // 应用 pitch（0=水平，-π/2=俯视）
        const cosP = Math.cos(this._pitch);
        const sinP = Math.sin(this._pitch);
        // lookDir = cos(pitch)·fwdH + sin(pitch)·up
        this._lookDir[0] = cosP * this._fwdH[0] + sinP * eU[0];
        this._lookDir[1] = cosP * this._fwdH[1] + sinP * eU[1];
        this._lookDir[2] = cosP * this._fwdH[2] + sinP * eU[2];
        // camUp（roll 前）= -sin(pitch)·fwdH + cos(pitch)·up
        this._camUp[0] = -sinP * this._fwdH[0] + cosP * eU[0];
        this._camUp[1] = -sinP * this._fwdH[1] + cosP * eU[1];
        this._camUp[2] = -sinP * this._fwdH[2] + cosP * eU[2];

        // 应用 roll（绕 lookDir 旋转 camUp 和 rightH）
        if (Math.abs(this._roll) > 1e-8) {
            const cosR = Math.cos(this._roll);
            const sinR = Math.sin(this._roll);
            // camRight = cos(roll)·rightH + sin(roll)·camUp
            this._camRight[0] = cosR * this._rightH[0] + sinR * this._camUp[0];
            this._camRight[1] = cosR * this._rightH[1] + sinR * this._camUp[1];
            this._camRight[2] = cosR * this._rightH[2] + sinR * this._camUp[2];
            // camUp_final = -sin(roll)·rightH + cos(roll)·camUp
            const cu0 = -sinR * this._rightH[0] + cosR * this._camUp[0];
            const cu1 = -sinR * this._rightH[1] + cosR * this._camUp[1];
            const cu2 = -sinR * this._rightH[2] + cosR * this._camUp[2];
            this._camUp[0] = cu0;
            this._camUp[1] = cu1;
            this._camUp[2] = cu2;
        } else {
            // roll=0 时 camRight 就是 rightH
            this._camRight[0] = this._rightH[0];
            this._camRight[1] = this._rightH[1];
            this._camRight[2] = this._rightH[2];
        }
    }

    /**
     * 从相机轴直接构建视图矩阵（列主序），避免 lookAt 中 Float32 精度问题。
     * 平移分量使用 Float64 ECEF 位置计算，最后截断为 Float32。
     *
     * @example
     * this._buildViewMatrix();
     */
    private _buildViewMatrix(): void {
        const V = this._mutable.viewMatrix;
        const rx = this._camRight[0], ry = this._camRight[1], rz = this._camRight[2];
        const ux = this._camUp[0], uy = this._camUp[1], uz = this._camUp[2];
        const fx = this._lookDir[0], fy = this._lookDir[1], fz = this._lookDir[2];
        // Float64 相机位置（dot 积保持 Float64 精度）
        const ex = this._ecefPosD[0], ey = this._ecefPosD[1], ez = this._ecefPosD[2];

        // 列主序：列 0 = [right.x, up.x, -fwd.x, 0] 等
        V[0] = rx;  V[1] = ux;  V[2] = -fx;  V[3] = 0;
        V[4] = ry;  V[5] = uy;  V[6] = -fy;  V[7] = 0;
        V[8] = rz;  V[9] = uz;  V[10] = -fz; V[11] = 0;
        // 平移 = -R^T × eye（dot 积使用 Float64 以获得更好精度）
        V[12] = -(rx * ex + ry * ey + rz * ez);
        V[13] = -(ux * ex + uy * ey + uz * ez);
        V[14] = (fx * ex + fy * ey + fz * ez);
        V[15] = 1;
    }

    /**
     * 填充 CameraState 的非矩阵字段。
     *
     * @example
     * this._fillCameraState();
     */
    private _fillCameraState(): void {
        const m = this._mutable;

        // ---- center：射线-球体交点的大地坐标 ----
        const t = raySphereIntersect(
            this._ecefPosD[0], this._ecefPosD[1], this._ecefPosD[2],
            this._lookDir[0], this._lookDir[1], this._lookDir[2],
            WGS84_A,
        );
        if (t > 0) {
            // 交点坐标（Float64）
            const ix = this._ecefPosD[0] + this._lookDir[0] * t;
            const iy = this._ecefPosD[1] + this._lookDir[1] * t;
            const iz = this._ecefPosD[2] + this._lookDir[2] * t;
            ecefToGeodetic(this._tempGeoD, ix, iy, iz);
            m.center[0] = this._tempGeoD[0] * RAD_TO_DEG;
            m.center[1] = this._tempGeoD[1] * RAD_TO_DEG;
        } else {
            // 看向天空，使用相机正下方点
            m.center[0] = this._lonRad * RAD_TO_DEG;
            m.center[1] = this._latRad * RAD_TO_DEG;
        }

        // ---- zoom ----
        m.zoom = clamp(altitudeToZoom(this._alt, this._fov), DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);

        // ---- bearing（同一约定，无需转换）----
        m.bearing = this._bearing;

        // ---- pitch（CameraState 约定 = 内部 + π/2）----
        m.pitch = this._pitch + HALF_PI;

        // ---- roll ----
        m.roll = this._roll;

        // ---- position（ECEF Float32）----
        m.position[0] = this._ecefPosD[0];
        m.position[1] = this._ecefPosD[1];
        m.position[2] = this._ecefPosD[2];

        // ---- altitude ----
        m.altitude = this._alt;

        // ---- fov ----
        m.fov = this._fov;
    }

    /**
     * 处理地形碰撞：异步查询 DEM 高度 + 平滑推离。
     *
     * @param dt - 帧时长（秒）
     *
     * @example
     * this._processTerrainCollision(dt);
     */
    private _processTerrainCollision(dt: number): void {
        // 检查是否移动了足够距离需要重新查询
        const curLon = this._lonRad;
        const curLat = this._latRad;

        // 使用 haversine 距离判断是否超过缓存阈值
        const distMoved = haversineDistance(
            this._cachedTerrainLon, this._cachedTerrainLat,
            curLon, curLat,
        );

        if (distMoved > TERRAIN_CACHE_DISTANCE && !this._terrainQueryPending && this._terrainProvider) {
            this._terrainQueryPending = true;
            const lonDeg = curLon * RAD_TO_DEG;
            const latDeg = curLat * RAD_TO_DEG;
            // 增加超时保护
            const timer = setTimeout(() => { this._terrainQueryPending = false; }, TERRAIN_QUERY_TIMEOUT);
            this._terrainProvider(lonDeg, latDeg)
                .then((h) => {
                    clearTimeout(timer);
                    this._cachedTerrainH = Number.isFinite(h) ? h : 0;
                    this._cachedTerrainLon = curLon;
                    this._cachedTerrainLat = curLat;
                    this._terrainQueryPending = false;
                })
                .catch(() => {
                    clearTimeout(timer);
                    this._terrainQueryPending = false;
                });
        }

        // 平滑推离：若当前高度低于安全高度则向安全高度 lerp
        const safeAlt = this._cachedTerrainH + this._minAltAboveTerrain;
        if (this._alt < safeAlt) {
            // 根据帧时长缩放平滑因子（60fps 基准）
            const smoothFactor = 1 - Math.pow(1 - COLLISION_SMOOTH_FACTOR, dt * 60);
            this._alt = this._alt + (safeAlt - this._alt) * clamp(smoothFactor, 0, 1);
        }
    }

    /**
     * 根据大圆弧距离创建并启动飞行/缓动动画。
     *
     * @param kind - 动画类型
     * @param toLon - 目标经度（弧度）
     * @param toLat - 目标纬度（弧度）
     * @param toAlt - 目标高度（米）
     * @param toBearing - 目标方位角（弧度）
     * @param toPitch - 目标俯仰角（内部约定，弧度）
     * @param toRoll - 目标翻滚角（弧度）
     * @param durationMs - 动画时长（毫秒）
     * @param easing - 缓动函数
     * @returns 动画句柄
     *
     * @example
     * this._startFlyAnimation('fly', 2.0, 0.5, 100000, 0, -0.5, 0, 2000, smoothstep01);
     */
    private _startFlyAnimation(
        kind: 'fly' | 'ease' | 'flyPos',
        toLon: number, toLat: number, toAlt: number,
        toBearing: number, toPitch: number, toRoll: number,
        durationMs: number, easing: (t: number) => number,
    ): CameraAnimation {
        const id = generateAnimationId();

        // 计算大圆弧角度（用于飞行高度峰值）
        let greatCircleAngle = 0;
        let peakAltBonus = 0;
        if (kind !== 'ease') {
            // 将起终点转为 ECEF 方向向量，计算角距
            geodeticToECEF(this._animTempA, this._lonRad, this._latRad, 0);
            geodeticToECEF(this._animTempB, toLon, toLat, 0);
            const lenA = Math.sqrt(
                this._animTempA[0] ** 2 + this._animTempA[1] ** 2 + this._animTempA[2] ** 2,
            );
            const lenB = Math.sqrt(
                this._animTempB[0] ** 2 + this._animTempB[1] ** 2 + this._animTempB[2] ** 2,
            );
            if (lenA > 1e-3 && lenB > 1e-3) {
                const dotVal = (
                    this._animTempA[0] * this._animTempB[0] +
                    this._animTempA[1] * this._animTempB[1] +
                    this._animTempA[2] * this._animTempB[2]
                ) / (lenA * lenB);
                greatCircleAngle = Math.acos(clamp(dotVal, -1, 1));
            }
            // 峰值高度与角距成正比
            peakAltBonus = greatCircleAngle * WGS84_A * FLY_PEAK_HEIGHT_FACTOR;
        }

        const handle = createAnimHandle(id, () => {
            if (this._fly && this._fly.id === id) { this._fly = null; }
        });

        const anim: FlyAnim3D = {
            kind,
            id,
            startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            durationMs,
            easing,
            from: {
                lonRad: this._lonRad, latRad: this._latRad, alt: this._alt,
                bearing: this._bearing, pitch: this._pitch, roll: this._roll,
            },
            to: {
                lonRad: toLon, latRad: toLat, alt: toAlt,
                bearing: toBearing, pitch: toPitch, roll: toRoll,
            },
            peakAltBonus,
            greatCircleAngle,
            handle,
        };
        this._fly = anim;
        this._emitMoveStart();
        return handle;
    }

    /**
     * 推进当前飞行动画一帧。
     * fly/flyPos 使用大圆弧 slerp + 抛物线高度；ease 使用线性插值。
     *
     * @example
     * this._updateAnimation();
     */
    private _updateAnimation(): void {
        const anim = this._fly!;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const tRaw = (now - anim.startMs) / anim.durationMs;
        const t = anim.easing(clamp(tRaw, 0, 1));

        const from = anim.from;
        const to = anim.to;

        if (anim.kind === 'ease') {
            // 线性插值经纬度和高度
            this._lonRad = from.lonRad + (to.lonRad - from.lonRad) * t;
            this._latRad = clamp(from.latRad + (to.latRad - from.latRad) * t, -HALF_PI, HALF_PI);
            this._alt = from.alt + (to.alt - from.alt) * t;
        } else {
            // 大圆弧 slerp + 抛物线高度
            if (anim.greatCircleAngle < 1e-8) {
                // 角距极小，直接线性插值
                this._lonRad = from.lonRad + (to.lonRad - from.lonRad) * t;
                this._latRad = clamp(from.latRad + (to.latRad - from.latRad) * t, -HALF_PI, HALF_PI);
            } else {
                // 将起终点转为 ECEF 归一化方向，然后 slerp
                geodeticToECEF(this._animTempA, from.lonRad, from.latRad, 0);
                geodeticToECEF(this._animTempB, to.lonRad, to.latRad, 0);
                const lenA = Math.sqrt(
                    this._animTempA[0] ** 2 + this._animTempA[1] ** 2 + this._animTempA[2] ** 2,
                );
                const lenB = Math.sqrt(
                    this._animTempB[0] ** 2 + this._animTempB[1] ** 2 + this._animTempB[2] ** 2,
                );
                // 归一化为单位方向向量
                const n1x = this._animTempA[0] / lenA;
                const n1y = this._animTempA[1] / lenA;
                const n1z = this._animTempA[2] / lenA;
                const n2x = this._animTempB[0] / lenB;
                const n2y = this._animTempB[1] / lenB;
                const n2z = this._animTempB[2] / lenB;

                // 球面 slerp
                const angle = anim.greatCircleAngle;
                const sinAngle = Math.sin(angle);
                const s1 = Math.sin((1 - t) * angle) / sinAngle;
                const s2 = Math.sin(t * angle) / sinAngle;
                let nx = s1 * n1x + s2 * n2x;
                let ny = s1 * n1y + s2 * n2y;
                let nz = s1 * n1z + s2 * n2z;

                // 重新归一化（浮点误差防护）
                const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nLen > 1e-10) { nx /= nLen; ny /= nLen; nz /= nLen; }

                // 通过方向向量 + 半径转回大地坐标
                const tempRadius = WGS84_A + 1;
                this._tempEcefD[0] = nx * tempRadius;
                this._tempEcefD[1] = ny * tempRadius;
                this._tempEcefD[2] = nz * tempRadius;
                ecefToGeodetic(this._tempGeoD, this._tempEcefD[0], this._tempEcefD[1], this._tempEcefD[2]);
                this._lonRad = this._tempGeoD[0];
                this._latRad = clamp(this._tempGeoD[1], -HALF_PI, HALF_PI);
            }

            // 抛物线高度：线性基础 + sin(πt) 峰值
            const altBase = from.alt + (to.alt - from.alt) * t;
            const altBonus = Math.sin(Math.PI * t) * anim.peakAltBonus;
            this._alt = altBase + altBonus;
        }

        // 方位角插值（走短弧）
        const bearingDiff = shortestAngleDiff(from.bearing, to.bearing);
        this._bearing = wrapBearing(from.bearing + bearingDiff * t);

        // 俯仰和翻滚线性插值
        this._pitch = clamp(from.pitch + (to.pitch - from.pitch) * t, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
        this._roll = from.roll + (to.roll - from.roll) * t;

        // 动画完成检测
        if (tRaw >= 1) {
            // 精确设置到终点
            this._lonRad = to.lonRad;
            this._latRad = clamp(to.latRad, -HALF_PI, HALF_PI);
            this._alt = clamp(to.alt, this._minZoomDist, this._maxZoomDist);
            this._bearing = wrapBearing(to.bearing);
            this._pitch = clamp(to.pitch, MIN_PITCH_INTERNAL, MAX_PITCH_INTERNAL);
            this._roll = to.roll;
            finishAnimHandle(anim.handle);
            this._fly = null;
            this._emitMoveEnd();
        } else {
            this._emitMove();
        }
    }

    /**
     * 将经纬度钳制到 maxBounds 范围。
     *
     * @param bounds - 地理包围盒（度）
     *
     * @example
     * this._clampToBounds({ west: 70, south: 10, east: 140, north: 55 });
     */
    private _clampToBounds(bounds: BBox2D): void {
        if (
            !Number.isFinite(bounds.west) || !Number.isFinite(bounds.east) ||
            !Number.isFinite(bounds.south) || !Number.isFinite(bounds.north) ||
            bounds.west > bounds.east || bounds.south > bounds.north
        ) {
            return;
        }
        const lonDeg = this._lonRad * RAD_TO_DEG;
        const latDeg = this._latRad * RAD_TO_DEG;
        this._lonRad = clamp(lonDeg, bounds.west, bounds.east) * DEG_TO_RAD;
        this._latRad = clamp(latDeg, bounds.south, bounds.north) * DEG_TO_RAD;
    }

    /**
     * 触发 onMoveStart 回调。
     *
     * @example
     * this._emitMoveStart();
     */
    private _emitMoveStart(): void {
        if (this._isMoving) { return; }
        this._isMoving = true;
        for (const cb of this._onMoveStartCbs) {
            try { cb(); } catch (err) { console.error('[Camera3D] onMoveStart error', err); }
        }
    }

    /**
     * 触发 onMove 回调。
     *
     * @example
     * this._emitMove();
     */
    private _emitMove(): void {
        for (const cb of this._onMoveCbs) {
            try { cb(this._mutable as CameraState); } catch (err) {
                console.error('[Camera3D] onMove error', err);
            }
        }
    }

    /**
     * 触发 onMoveEnd 回调。
     *
     * @example
     * this._emitMoveEnd();
     */
    private _emitMoveEnd(): void {
        if (!this._isMoving) { return; }
        this._isMoving = false;
        for (const cb of this._onMoveEndCbs) {
            try { cb(); } catch (err) { console.error('[Camera3D] onMoveEnd error', err); }
        }
    }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * 工厂：创建 3D 地球相机控制器。
 * 使用 ECEF 坐标系，支持大圆弧飞行、地形碰撞和惯性轨道旋转。
 *
 * @param options - 初始化选项（位置、姿态、约束、惯性等）
 * @returns 实现 {@link Camera3D} 接口的实例
 *
 * @example
 * const cam = createCamera3D({
 *   position: { lon: 116.39, lat: 39.91, alt: 500_000 },
 *   bearing: 0,
 *   pitch: -Math.PI / 4,
 * });
 *
 * @example
 * const cam = createCamera3D(); // 默认参数：经纬度 0, 海拔 20000km
 */
export function createCamera3D(options?: Camera3DOptions): Camera3D {
    return new Camera3DImpl(options);
}
