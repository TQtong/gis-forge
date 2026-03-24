// ============================================================
// packages/camera-25d/src/Camera25D.ts
// 2.5D 透视相机实现 — Web Mercator (EPSG:3857) 像素空间
// 层级：Camera 实现包（被 L3 CameraController / L6 Map25D 引用）
//
// 功能概览：
// - Web Mercator 像素坐标空间的视图/投影矩阵计算
// - Reversed-Z 透视投影（depthCompare:'greater', clear 0.0）
// - bearing（方位角）与 pitch（俯仰角）交互支持
// - 三通道独立惯性衰减（pan / bearing / pitch）
// - flyTo 弧线动画（鸟瞰弧：中间缩小 peakZoom）
// - easeTo 线性插值动画（含 bearing/pitch 插值）
// - resetNorth / resetNorthPitch / snapToNorth 旋转复位动画
// - 锚点缩放（以光标位置为缩放中心）
// - 屏幕坐标 ↔ 经纬度双向转换（射线-平面相交）
// - 约束执行（缩放范围 + 地理包围盒 + pitch 上限）
// - 地平线 Y 计算（高 pitch 时的视口裁剪参考）
//
// 零 npm 依赖。全部数学运算来自 @geoforge/core。
// ============================================================

/**
 * 编译期开发模式标志。
 * 构建系统（esbuild/rollup）在生产构建中替换为 false，
 * 使所有 `if (__DEV__)` 分支被 tree-shake 移除。
 */
declare const __DEV__: boolean;

// ============================================================
// 外部依赖导入
// ============================================================

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type {
    CameraType,
    CameraConstraints,
    CameraAnimation,
    CameraController,
} from '../../runtime/src/camera-controller.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
import {
    TILE_SIZE,
    EARTH_CIRCUMFERENCE,
    MAX_LATITUDE,
    lngLatToPixel,
    pixelToLngLat,
    clampLatitude,
    lngLatToMercator,
    mercatorToLngLat,
} from '../../core/src/geo/mercator.ts';

// ============================================================
// 常量定义 — 全部命名、注释其含义和来源
// ============================================================

/** 默认最小缩放级别（含），z=0 为全球视图 */
const DEFAULT_MIN_ZOOM: number = 0;

/** 默认最大缩放级别（含），z=22 约为建筑物级别（~1cm/px 地面分辨率） */
const DEFAULT_MAX_ZOOM: number = 22;

/**
 * 默认最大俯仰角（弧度），约 85°。
 * 避免 pitch 达到 90°（正切趋向无穷），同时允许极端透视效果。
 * 85° ≈ 1.4835 rad。
 */
const DEFAULT_MAX_PITCH: number = 1.4835;

/**
 * 默认垂直视场角（弧度），约 36.87°。
 * 0.6435 rad ≈ 36.87°。
 * 这个值在 GIS 地图场景中提供适度透视感而不过分变形。
 * 对应 tan(fov/2) ≈ 0.333，即 ~1/3 的透视缩放因子。
 */
const DEFAULT_FOV: number = 0.6435;

/**
 * 默认平移惯性衰减系数（归一化到 60fps 的每帧乘性因子）。
 * 值域 (0, 1)：越接近 1 滑行越远；0.85 提供中等平移惯性。
 * 实际衰减 = decay^(dt * 60)，确保不同帧率下表现一致。
 */
const DEFAULT_PAN_INERTIA_DECAY: number = 0.85;

/**
 * 默认旋转（bearing）惯性衰减系数。
 * 比平移衰减更快（0.75 < 0.85），旋转停止更迅速以避免眩晕。
 */
const DEFAULT_BEARING_INERTIA_DECAY: number = 0.75;

/**
 * 默认俯仰（pitch）惯性衰减系数。
 * 最快的衰减（0.7），倾斜停止最迅速以保持空间感知稳定。
 */
const DEFAULT_PITCH_INERTIA_DECAY: number = 0.7;

/**
 * snapToNorth 触发阈值（弧度），约 7°。
 * 当 bearing 绝对值小于此值时，snapToNorth 才会执行吸附动画。
 * 0.12 rad ≈ 6.88°。
 */
const SNAP_TO_NORTH_THRESHOLD: number = 0.12;

/**
 * 高 pitch 阈值（弧度），60°。
 * 超过此角度时发出 'camera:high-pitch' 事件，
 * 提示上层系统可能需要调整远平面或 LOD 策略。
 */
const HIGH_PITCH_THRESHOLD: number = Math.PI / 3;

/**
 * 惯性采样环形缓冲区容量（帧数）。
 * 5 帧在 60fps 下约覆盖最近 83ms 的拖拽轨迹。
 */
const DEFAULT_INERTIA_SAMPLE_FRAMES: number = 5;

/**
 * 惯性最大速度上限（像素/秒）。
 * 防止极端快速拖拽产生过大的惯性速度。
 */
const DEFAULT_MAX_INERTIA_VELOCITY: number = 4000;

/**
 * 惯性速度停止阈值（像素/秒）。
 * 当平移惯性速度衰减至此值以下时完全停止。
 */
const INERTIA_VELOCITY_THRESHOLD: number = 1.0;

/**
 * 旋转惯性最小角速度阈值（弧度/秒）。
 * 当 bearing 或 pitch 角速度低于此值时完全停止。
 */
const INERTIA_ANGULAR_THRESHOLD: number = 0.001;

/**
 * 惯性采样最小时间跨度（毫秒）。
 * 10ms 是安全下界（单帧 16.7ms@60fps > 10ms）。
 */
const INERTIA_MIN_DURATION_MS: number = 10;

/**
 * 惯性最小触发速度（像素/秒）。
 * 低于此速度的拖拽结束不触发惯性。
 */
const INERTIA_MIN_SPEED: number = 50;

/** 默认 flyTo 动画时长（毫秒） */
const DEFAULT_FLY_DURATION_MS: number = 1500;

/** 默认 easeTo 动画时长（毫秒） */
const DEFAULT_EASE_DURATION_MS: number = 500;

/** 极小值阈值，用于浮点零判断 */
const EPSILON: number = 1e-10;

/**
 * 判定「近似俯视」的俯仰角阈值（弧度）。
 * 低于此值时 {@link Camera25DImpl.zoomAround} 可走墨卡托米空间快路径（与 2D 一致）。
 */
const PITCH_NEAR_ZERO_FOR_ZOOM_AROUND: number = 1e-4;

/**
 * 动态远裁面：pitch 低于此值（弧度）时按近似俯视处理（far = cameraToCenterDist×1.5）。
 * 约 0.57°；与视口填充文档「pitch < 0.01」一致。
 */
const PITCH_NEAR_ZERO_FOR_FAR_PLANE: number = 0.01;

/**
 * 视锥上边缘与地面相交分支的上界余量（弧度）：与 π/2 保留间隙，避免 `cos(topRayAngle)→0` 除法不稳定。
 */
const TOP_RAY_ANGLE_EPS: number = 0.01;

/** 视口最小合法边长（像素），防止零宽/高导致除零 */
const MIN_VIEWPORT_DIM: number = 1;

/**
 * 最小动画时长（毫秒），防止除零或帧跳过。
 * 16ms ≈ 1 帧@60fps。
 */
const MIN_ANIM_DURATION_MS: number = 16;

/**
 * 旋转手势灵敏度（弧度/像素）。
 * 控制鼠标/触摸每移动 1px 对应的 bearing/pitch 增量。
 * 0.003 使全屏宽度约 = 180° 旋转。
 */
const ROTATE_SENSITIVITY: number = 0.003;

// ============================================================
// 内部类型定义
// ============================================================

/**
 * 惯性采样点，记录单次 panMove 的位移和时间戳。
 */
interface InertiaSample {
    /** X 方向 Mercator 像素位移（正值 = 中心向东移动） */
    dx: number;
    /** Y 方向 Mercator 像素位移（正值 = 中心向南移动） */
    dy: number;
    /** 采样时间戳（performance.now() 毫秒） */
    time: number;
}

/**
 * 内部动画状态，描述一个正在执行的 flyTo 或 easeTo 动画。
 */
interface AnimationInternal {
    /** 动画唯一标识符 */
    readonly id: string;
    /** 动画类型：'fly' = 弧线飞行，'ease' = 线性缓动 */
    readonly kind: 'fly' | 'ease';
    /** 起始中心 [lon, lat]（度） */
    readonly fromCenter: [number, number];
    /** 目标中心 [lon, lat]（度） */
    readonly toCenter: [number, number];
    /** 起始缩放级别 */
    readonly fromZoom: number;
    /** 目标缩放级别 */
    readonly toZoom: number;
    /** flyTo 弧线的最低缩放级别 */
    readonly peakZoom: number;
    /** 起始 bearing（弧度） */
    readonly fromBearing: number;
    /** 目标 bearing（弧度） */
    readonly toBearing: number;
    /** 起始 pitch（弧度） */
    readonly fromPitch: number;
    /** 目标 pitch（弧度） */
    readonly toPitch: number;
    /** 动画总时长（毫秒） */
    readonly durationMs: number;
    /** 缓动函数 */
    readonly easing: (t: number) => number;
    /** 动画开始时间戳 */
    readonly startMs: number;
    /** 对外暴露的动画句柄 */
    readonly handle: AnimationHandle;
}

/**
 * CameraAnimation 的内部可变实现。
 */
interface AnimationHandle extends CameraAnimation {
    /** 内部可变状态字段 */
    _state: 'running' | 'finished' | 'cancelled';
    /** 完成时调用以 resolve finished Promise */
    _resolve?: () => void;
}

// ============================================================
// 导出类型定义
// ============================================================

/**
 * Camera25D 构造选项。
 * 控制 2.5D 透视相机的初始状态、约束参数和三通道惯性行为。
 *
 * @example
 * const options: Camera25DOptions = {
 *   center: [116.39, 39.91],
 *   zoom: 10,
 *   bearing: 0,
 *   pitch: Math.PI / 6,
 *   maxPitch: 1.4835,
 *   fov: 0.6435,
 *   inertia: true,
 *   panInertiaDecay: 0.85,
 *   bearingInertiaDecay: 0.75,
 *   pitchInertiaDecay: 0.7,
 * };
 */
export interface Camera25DOptions {
    /**
     * 初始中心坐标 [经度, 纬度]（度）。
     * 经度范围 [-180, 180]，纬度范围 [-85.05, 85.05]。
     * 超出墨卡托有效范围的纬度会被自动钳制。
     * 默认值：[0, 0]（几内亚湾，本初子午线与赤道交点）。
     */
    readonly center?: [number, number];

    /**
     * 初始缩放级别。
     * 连续值（支持小数），范围 [minZoom, maxZoom]。
     * z=0 为全球视图（1 个瓦片），z=22 约为建筑物级别。
     * 默认值：1。
     */
    readonly zoom?: number;

    /**
     * 最小缩放级别（含）。
     * 用户无法缩放到此级别以下。
     * 默认值：0。
     */
    readonly minZoom?: number;

    /**
     * 最大缩放级别（含）。
     * 用户无法缩放到此级别以上。
     * 默认值：22。
     */
    readonly maxZoom?: number;

    /**
     * 可选地理包围盒约束。
     * 设置后，相机中心将被限制在此范围内。
     * 单位：度。west/south 为最小值，east/north 为最大值。
     */
    readonly maxBounds?: BBox2D;

    /**
     * 初始方位角 bearing（弧度）。
     * 0 = 正北（默认），正值顺时针。
     * 范围会被归一化到 [-π, π]。
     * 默认值：0。
     */
    readonly bearing?: number;

    /**
     * 初始俯仰角 pitch（弧度）。
     * 0 = 正俯视，正值向地平线倾斜。
     * 自动钳制到 [0, maxPitch]。
     * 默认值：0。
     */
    readonly pitch?: number;

    /**
     * 最大俯仰角（弧度）。
     * 用户无法将俯仰倾斜超过此角度。
     * 默认值：1.4835（≈85°）。
     */
    readonly maxPitch?: number;

    /**
     * 垂直视场角 FOV（弧度）。
     * 控制透视投影的张角，值越大透视越夸张。
     * 典型范围 [0.3, 1.2]（约 17°~69°）。
     * 默认值：0.6435（≈36.87°）。
     */
    readonly fov?: number;

    /**
     * 是否启用惯性。
     * 开启时松手后地图将以拖拽速度惯性滑行/旋转/倾斜。
     * 默认值：true。
     */
    readonly inertia?: boolean;

    /**
     * 平移惯性衰减系数（归一化到 60fps）。
     * 范围 (0, 1)：越接近 1 滑行距离越长。
     * 默认值：0.85。
     */
    readonly panInertiaDecay?: number;

    /**
     * 旋转（bearing）惯性衰减系数。
     * 范围 (0, 1)：越接近 1 旋转惯性越长。
     * 默认值：0.75。
     */
    readonly bearingInertiaDecay?: number;

    /**
     * 俯仰（pitch）惯性衰减系数。
     * 范围 (0, 1)：越接近 1 倾斜惯性越长。
     * 默认值：0.7。
     */
    readonly pitchInertiaDecay?: number;
}

/**
 * 2.5D 透视相机接口。
 * 扩展 {@link CameraController} 基础接口，增加 bearing/pitch 交互、
 * 旋转复位动画、地平线计算和透视坐标转换。
 *
 * 与 Camera2D 的核心区别：
 * - 透视投影（perspectiveReversedZ）替代正交投影
 * - bearing/pitch 可变且支持交互
 * - 三通道独立惯性衰减
 * - 地平线 Y 计算
 * - 射线-平面相交的 screenToLngLat
 *
 * @example
 * const cam = createCamera25D({
 *   center: [116.39, 39.91],
 *   zoom: 12,
 *   pitch: Math.PI / 6,
 *   bearing: 0.5,
 * });
 * cam.setBearing(Math.PI / 4);
 * cam.setPitch(Math.PI / 4);
 * const state = cam.update(1/60, viewport);
 */
export interface Camera25D extends CameraController {
    /** 类型标识，始终为 '25d' */
    readonly type: '25d';

    /**
     * 惯性是否正在运行（松手后的减速滑行/旋转/倾斜阶段）。
     * 任一通道（pan/bearing/pitch）有非零速度即为 true。
     */
    readonly isInertiaActive: boolean;

    /**
     * 用户是否正在进行手势平移（handlePanStart → handlePanEnd 之间）。
     */
    readonly isPanning: boolean;

    /**
     * 相机是否处于任何运动状态。
     * isMoving = isPanning || isInertiaActive || isAnimating。
     */
    readonly isMoving: boolean;

    /**
     * 设置方位角 bearing（弧度）。
     * **2.5D 模式下有效**：立即更改旋转角。
     * 值会被归一化到 [-π, π]。
     *
     * @param bearing - 方位角（弧度），0 = 正北
     *
     * @example
     * cam.setBearing(Math.PI / 4); // 旋转到东北方向
     */
    setBearing(bearing: number): void;

    /**
     * 设置俯仰角 pitch（弧度）。
     * **2.5D 模式下有效**：自动钳制到 [0, maxPitch]。
     *
     * @param pitch - 俯仰角（弧度），0 = 正俯视
     *
     * @example
     * cam.setPitch(Math.PI / 3); // 倾斜到 60°
     */
    setPitch(pitch: number): void;

    /**
     * 动画复位方位角到正北（bearing=0）。
     * pitch 保持不变。
     *
     * @param options - 可选动画参数（时长、缓动）
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * const anim = cam.resetNorth({ duration: 800 });
     * await anim.finished;
     */
    resetNorth(options?: { duration?: number }): CameraAnimation;

    /**
     * 动画同时复位方位角和俯仰角（bearing=0, pitch=0）。
     *
     * @param options - 可选动画参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * await cam.resetNorthPitch().finished;
     */
    resetNorthPitch(options?: { duration?: number }): CameraAnimation;

    /**
     * 若 bearing 接近正北（|bearing| < SNAP_TO_NORTH_THRESHOLD），
     * 则动画吸附到正北；否则不执行任何操作。
     *
     * @param options - 可选动画参数
     * @returns 动画句柄（若未触发则立即处于 finished 状态）
     *
     * @stability stable
     *
     * @example
     * cam.snapToNorth(); // 若当前 bearing ≈ 0.05，吸附到 0
     */
    snapToNorth(options?: { duration?: number }): CameraAnimation;

    /**
     * 计算当前视口中地平线的 Y 坐标（CSS 像素，从顶部计）。
     * 在高 pitch 场景下用于裁剪地平线以上区域。
     * pitch=0 时返回 0（地平线在视口上方不可见）。
     *
     * @returns 地平线 Y 坐标（CSS 像素），0 表示视口顶部
     *
     * @stability stable
     *
     * @example
     * const horizonY = cam.getHorizonY();
     * if (horizonY > 0) renderSkyAbove(horizonY);
     */
    getHorizonY(): number;

    /**
     * 获取当前视口可见的地理范围。
     * 通过反投影视口角点到地面平面计算经纬度包围盒。
     * 高 pitch 时底部角点更远、顶部角点可能在地平线以上。
     *
     * @returns 可见范围的经纬度包围盒
     *
     * @stability stable
     */
    getVisibleBounds(): BBox2D;

    /**
     * 将屏幕坐标转换为经纬度（射线-地面平面相交）。
     * 在高 pitch 时若射线未命中地面（指向天空），返回 null。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @returns [经度, 纬度]（度），若射线未命中地面则返回 null
     *
     * @stability stable
     */
    screenToLngLat(screenX: number, screenY: number): [number, number] | null;

    /**
     * 将经纬度转换为屏幕坐标。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns [screenX, screenY]（CSS 像素）
     *
     * @stability stable
     */
    lngLatToScreen(lon: number, lat: number): [number, number];

    /**
     * 以锚点为中心缩放：俯仰近 0 时与 2D 相同（墨卡托米空间）；否则先应用目标 zoom 再按屏幕误差修正中心。
     *
     * @param anchorScreenX - 锚点屏幕 X（CSS 像素）
     * @param anchorScreenY - 锚点屏幕 Y（CSS 像素）
     * @param anchorLngLat - 锚点 [经度, 纬度]（度）
     * @param newZoom - 目标缩放级别
     *
     * @stability stable
     */
    zoomAround(
        anchorScreenX: number,
        anchorScreenY: number,
        anchorLngLat: [number, number],
        newZoom: number,
    ): void;
}

// ============================================================
// 模块级预分配资源 — 零 GC 临时缓冲区
// JS 单线程保证同一帧内不会被并发覆盖。
// ============================================================

/** lookAt 计算用：相机眼位置 [x, y, z] */
const _eye = vec3.create();

/** lookAt 计算用：注视目标位置 [x, y, z] */
const _target = vec3.create();

/** lookAt 计算用：上方向向量 */
const _up = vec3.create(0, 1, 0);

/** 通用 3D 临时向量 A（transformMat4 等用） */
const _tempVec3A = vec3.create();

/** 通用 3D 临时向量 B（screenToLngLat 射线方向用） */
const _tempVec3B = vec3.create();

/** Mercator 像素坐标临时缓冲区 A（Float64 双精度） */
const _pxA: Float64Array = new Float64Array(2);

/** Mercator 像素坐标临时缓冲区 B（Float64 双精度） */
const _pxB: Float64Array = new Float64Array(2);

/** 经纬度输出临时缓冲区（Float64 双精度） */
const _llOut: Float64Array = new Float64Array(2);

/** Mercator 米制坐标输出临时缓冲区（position 字段用） */
const _mercOut: Float64Array = new Float64Array(2);

/** 临时 4x4 矩阵 A（矩阵链乘中间结果） */
const _tempMat4 = mat4.create();

// ============================================================
// 工具函数
// ============================================================

/**
 * 缓入缓出三次曲线（Ease-In-Out Cubic）。
 * 前半段加速（4t³），后半段减速（1 - (-2t+2)³/2）。
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的 [0, 1] 值
 *
 * @example
 * easeInOutCubic(0);    // → 0
 * easeInOutCubic(0.5);  // → 0.5
 * easeInOutCubic(1);    // → 1
 */
function easeInOutCubic(t: number): number {
    // 前半段 4t³ 加速，后半段 1 - (-2t+2)³/2 减速
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 将数值钳制到闭区间 [lo, hi]。
 * 若输入为 NaN/Infinity 则回退为 0，若 lo > hi 则自动交换。
 *
 * @param v - 输入值
 * @param lo - 下界
 * @param hi - 上界
 * @returns 钳制后的安全值
 *
 * @example
 * clamp(12, 0, 10); // → 10
 * clamp(NaN, 0, 10); // → 0
 */
function clamp(v: number, lo: number, hi: number): number {
    // 非有限值保护：NaN、Infinity 等回退为 0
    if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        return 0;
    }
    // 若 lo > hi 自动修正
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    return Math.min(b, Math.max(a, v));
}

/**
 * 线性插值。保证 t=0 → a 和 t=1 → b 精确。
 *
 * @param a - 起始值
 * @param b - 终止值
 * @param t - 插值因子 [0, 1]
 * @returns 插值结果
 *
 * @example
 * lerp(0, 100, 0.5); // → 50
 */
function lerp(a: number, b: number, t: number): number {
    // a + (b-a)*t 形式保证端点精确
    return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 角度线性插值（最短路径）。
 * 处理 -π 到 π 的角度跨界情况，始终选择最短弧插值。
 *
 * @param a - 起始角度（弧度）
 * @param b - 目标角度（弧度）
 * @param t - 插值因子 [0, 1]
 * @returns 插值角度（弧度）
 *
 * @example
 * lerpAngle(-3.0, 3.0, 0.5); // ≈ π（跨 -π↔π 边界最短路径）
 */
function lerpAngle(a: number, b: number, t: number): number {
    // 计算 a 到 b 的最短角度差
    let diff = b - a;
    // 归一化差值到 [-π, π]，确保沿最短弧插值
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return a + diff * clamp(t, 0, 1);
}

/**
 * 将角度归一化到 [-π, π] 范围。
 *
 * @param angle - 输入角度（弧度）
 * @returns 归一化后的角度
 *
 * @example
 * normalizeBearing(3 * Math.PI); // → Math.PI
 */
function normalizeBearing(angle: number): number {
    // 非有限值保护
    if (!Number.isFinite(angle)) return 0;
    // 使用取模 + 修正将角度约束到 [-π, π]
    let a = angle % (2 * Math.PI);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * 获取当前高精度时间戳（毫秒）。
 * 优先使用 performance.now()，退化到 Date.now()。
 *
 * @returns 时间戳（毫秒）
 *
 * @example
 * const t = now();
 */
function now(): number {
    // performance.now() 在 Worker 和受限环境中可能不可用
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * 生成动画实例唯一 ID。
 * 优先使用 Web Crypto UUID，退化到时间戳+随机串组合。
 *
 * @returns 全局唯一字符串 ID
 *
 * @example
 * const id = generateAnimationId(); // 'a1b2c3d4-...' 或 'cam25d-anim-...'
 */
function generateAnimationId(): string {
    // 优先 UUID v4
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // 受限环境可能抛错
    }
    // 退化路径
    return `cam25d-anim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 检查视口是否具有有限的正尺寸。
 *
 * @param viewport - 视口对象
 * @returns 视口是否合法
 *
 * @example
 * if (!isViewportValid(vp)) return cachedState;
 */
function isViewportValid(viewport: Viewport): boolean {
    return (
        viewport.width >= MIN_VIEWPORT_DIM &&
        viewport.height >= MIN_VIEWPORT_DIM &&
        Number.isFinite(viewport.width) &&
        Number.isFinite(viewport.height)
    );
}

/**
 * 创建动画句柄对象，对外暴露 CameraAnimation 接口。
 *
 * @param id - 动画唯一 ID
 * @param cancelFn - 取消时执行的回调
 * @returns 可取消、可 await 的动画句柄
 *
 * @example
 * const handle = createAnimHandle('id-1', () => { currentAnim = null; });
 * await handle.finished;
 */
function createAnimHandle(id: string, cancelFn: () => void): AnimationHandle {
    let resolved = false;
    let resolveFn: (() => void) | undefined;
    // Promise 在创建时立即捕获 resolve 函数
    const finished = new Promise<void>((resolve) => {
        resolveFn = resolve;
    });

    const handle: AnimationHandle = {
        id,
        _state: 'running',
        get state() {
            return handle._state;
        },
        cancel: () => {
            // 幂等：已完成/已取消则忽略
            if (handle._state !== 'running') {
                return;
            }
            handle._state = 'cancelled';
            // 安全执行取消回调
            try {
                cancelFn();
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera25D] animation cancel callback error', err);
                }
            }
            // resolve Promise
            if (!resolved && resolveFn) {
                resolved = true;
                resolveFn();
            }
        },
        finished,
        _resolve: undefined,
    };
    // 存储 resolve 函数供 finishAnimHandle 调用
    handle._resolve = () => {
        if (resolved || !resolveFn) {
            return;
        }
        resolved = true;
        resolveFn();
    };
    return handle;
}

/**
 * 创建一个已完成状态的动画句柄（用于 snapToNorth 未触发时）。
 *
 * @returns 立即处于 finished 状态的句柄
 *
 * @example
 * return createFinishedAnimHandle(); // snapToNorth 未触发
 */
function createFinishedAnimHandle(): AnimationHandle {
    const id = generateAnimationId();
    const handle: AnimationHandle = {
        id,
        _state: 'finished',
        get state() {
            return handle._state;
        },
        cancel: () => {
            // 已完成，cancel 为 no-op
        },
        finished: Promise.resolve(),
        _resolve: undefined,
    };
    return handle;
}

/**
 * 将动画标记为「已完成」并 resolve 其 finished Promise。
 *
 * @param handle - 内部动画句柄
 *
 * @example
 * finishAnimHandle(anim.handle);
 */
function finishAnimHandle(handle: AnimationHandle): void {
    if (handle._state !== 'running') {
        return;
    }
    handle._state = 'finished';
    handle._resolve?.();
}

/**
 * 根据缩放级别和纬度计算等效相机海拔（米）。
 * 公式：altitude = C / (2^zoom × tileSize × cos(latRad))
 *
 * @param zoom - 缩放级别
 * @param latDeg - 纬度（度）
 * @returns 海拔（米），始终为正有限值
 *
 * @example
 * altitudeFromZoom(10, 0);   // ≈ 78271 米（赤道）
 * altitudeFromZoom(10, 60);  // ≈ 156543 米（60°N）
 */
function altitudeFromZoom(zoom: number, latDeg: number): number {
    const z = Math.max(0, zoom);
    // cos(lat) 修正项：高纬度地区同一 zoom 覆盖更小的地面范围
    const latRad = clampLatitude(latDeg) * (Math.PI / 180);
    const cosLat = Math.max(Math.cos(latRad), EPSILON);
    const denom = Math.pow(2, z) * TILE_SIZE * cosLat;
    const safeDenom = Math.max(denom, EPSILON);
    return EARTH_CIRCUMFERENCE / safeDenom;
}

// ============================================================
// 内部可变状态类型
// ============================================================

/**
 * 内部可变相机状态。
 * 矩阵和向量的 Float32Array 缓冲区在构造时分配一次，之后复用。
 */
interface MutableCameraState {
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
}

// ============================================================
// Camera25DImpl — 2.5D 透视相机完整实现
// ============================================================

/**
 * Camera25D 的私有实现类。
 * 通过 createCamera25D 工厂函数实例化，对外暴露 Camera25D 接口。
 */
class Camera25DImpl implements Camera25D {
    // ==================== 固定属性 ====================

    /** 相机类型标识：2.5D 透视 */
    readonly type: '25d' = '25d';

    // ==================== 内部状态 ====================

    /** 预分配的可变状态（矩阵缓冲区复用） */
    private readonly _mutable: MutableCameraState;

    /** 中心经度（度） */
    private _cx: number;

    /** 中心纬度（度） */
    private _cy: number;

    /** 连续缩放级别 */
    private _zoom: number;

    /** 方位角 bearing（弧度，0=正北，正值顺时针） */
    private _bearing: number;

    /** 俯仰角 pitch（弧度，0=正俯视，正值向地平线） */
    private _pitch: number;

    /** 垂直视场角 FOV（弧度） */
    private _fov: number;

    /** 约束配置 */
    private _constraints: CameraConstraints;

    /** 是否启用惯性 */
    private _inertiaEnabled: boolean;

    /** 平移惯性衰减系数 */
    private _panInertiaDecay: number;

    /** 旋转惯性衰减系数 */
    private _bearingInertiaDecay: number;

    /** 俯仰惯性衰减系数 */
    private _pitchInertiaDecay: number;

    // ==================== 平移惯性状态 ====================

    /** 惯性 X 速度（Mercator 像素/秒），正值 = 中心向东 */
    private _inertiaVelX: number = 0;

    /** 惯性 Y 速度（Mercator 像素/秒），正值 = 中心向南 */
    private _inertiaVelY: number = 0;

    // ==================== 旋转/倾斜惯性状态 ====================

    /** bearing 角速度（弧度/秒） */
    private _inertiaBearingVel: number = 0;

    /** pitch 角速度（弧度/秒） */
    private _inertiaPitchVel: number = 0;

    // ==================== 手势状态 ====================

    /** 上一次平移的屏幕 X 坐标 */
    private _panPrevX: number | null = null;

    /** 上一次平移的屏幕 Y 坐标 */
    private _panPrevY: number | null = null;

    /** 是否正在手势平移 */
    private _panning: boolean = false;

    // ==================== 惯性环形缓冲区 ====================

    /** 惯性采样环形缓冲区（固定容量，预分配） */
    private readonly _inertiaSamples: InertiaSample[];

    /** 环形缓冲区写入头指针 */
    private _inertiaHead: number = 0;

    /** 环形缓冲区有效样本数 */
    private _inertiaCount: number = 0;

    // ==================== 动画状态 ====================

    /** 当前活动动画（flyTo / easeTo / resetNorth 等），同一时间最多一个 */
    private _animation: AnimationInternal | null = null;

    // ==================== 事件订阅 ====================

    /** 移动开始回调集合 */
    private readonly _onMoveStartCallbacks: Set<() => void> = new Set();

    /** 移动中回调集合 */
    private readonly _onMoveCallbacks: Set<(state: CameraState) => void> = new Set();

    /** 移动结束回调集合 */
    private readonly _onMoveEndCallbacks: Set<() => void> = new Set();

    /** 高 pitch 回调集合（pitch > 60° 时触发） */
    private readonly _onHighPitchCallbacks: Set<() => void> = new Set();

    // ==================== 缓存与标记 ====================

    /** 销毁标记 */
    private _destroyed: boolean = false;

    /** 缓存的视口宽度（CSS 像素） */
    private _lastViewportWidth: number = 1024;

    /** 缓存的视口高度（CSS 像素） */
    private _lastViewportHeight: number = 768;

    /** 上一帧是否处于 isMoving 状态 */
    private _wasMoving: boolean = false;

    /** 是否已至少调用过一次 update（矩阵是否已初始化） */
    private _hasUpdated: boolean = false;

    /** 上一帧 pitch 是否在高 pitch 区间（边沿检测用） */
    private _wasHighPitch: boolean = false;

    // ==================== 构造函数 ====================

    /**
     * 构造 Camera25D 实例。
     * 初始化所有内部状态、约束参数、惯性参数和预分配缓冲区。
     *
     * @param options - 初始化选项，全部可选
     */
    constructor(options?: Camera25DOptions) {
        // 解析 maxPitch，用于约束初始化
        const maxPitch = Number.isFinite(options?.maxPitch)
            ? Math.max(0, options!.maxPitch!)
            : DEFAULT_MAX_PITCH;

        // 解析 FOV
        this._fov = Number.isFinite(options?.fov) && options!.fov! > 0
            ? options!.fov!
            : DEFAULT_FOV;

        // 初始化可变状态：预分配所有 Float32Array
        this._mutable = {
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
            altitude: 0,
            fov: this._fov,
        };

        // 初始化中心坐标（非有限值回退为 0）
        const initCenter = options?.center ?? [0, 0];
        this._cx = Number.isFinite(initCenter[0]) ? initCenter[0] : 0;
        this._cy = Number.isFinite(initCenter[1]) ? initCenter[1] : 0;

        // 初始化约束
        const minZ = options?.minZoom ?? DEFAULT_MIN_ZOOM;
        const maxZ = options?.maxZoom ?? DEFAULT_MAX_ZOOM;
        this._constraints = {
            minZoom: Math.min(minZ, maxZ),
            maxZoom: Math.max(minZ, maxZ),
            minPitch: 0,
            maxPitch: maxPitch,
            maxBounds: options?.maxBounds,
        };

        // 初始化缩放（钳制到约束范围）
        this._zoom = clamp(
            options?.zoom ?? 1,
            this._constraints.minZoom,
            this._constraints.maxZoom,
        );

        // 初始化 bearing（归一化到 [-π, π]）
        this._bearing = normalizeBearing(
            Number.isFinite(options?.bearing) ? options!.bearing! : 0,
        );

        // 初始化 pitch（钳制到 [0, maxPitch]）
        this._pitch = clamp(
            Number.isFinite(options?.pitch) ? options!.pitch! : 0,
            0,
            maxPitch,
        );

        // 惯性配置
        this._inertiaEnabled = options?.inertia ?? true;
        this._panInertiaDecay = clamp(
            options?.panInertiaDecay ?? DEFAULT_PAN_INERTIA_DECAY, 0, 0.9999,
        );
        this._bearingInertiaDecay = clamp(
            options?.bearingInertiaDecay ?? DEFAULT_BEARING_INERTIA_DECAY, 0, 0.9999,
        );
        this._pitchInertiaDecay = clamp(
            options?.pitchInertiaDecay ?? DEFAULT_PITCH_INERTIA_DECAY, 0, 0.9999,
        );

        // 惯性环形缓冲区：预分配固定容量
        const capacity = clamp(DEFAULT_INERTIA_SAMPLE_FRAMES, 2, 30);
        this._inertiaSamples = new Array(capacity);
        for (let i = 0; i < capacity; i++) {
            this._inertiaSamples[i] = { dx: 0, dy: 0, time: 0 };
        }

        // 初始约束应用
        const [cx, cy] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx;
        this._cy = cy;
    }

    // ==================== 公共 Getter ====================

    /**
     * 最近一次 update() 计算的相机状态快照。
     * 矩阵缓冲区为内部复用对象，调用方不应修改。
     *
     * @stability stable
     */
    get state(): CameraState {
        return this._mutable as CameraState;
    }

    /**
     * 当前约束配置（只读）。
     *
     * @stability stable
     */
    get constraints(): CameraConstraints {
        return this._constraints;
    }

    /**
     * 是否存在正在运行的动画。
     *
     * @stability stable
     */
    get isAnimating(): boolean {
        return this._animation !== null;
    }

    /**
     * 是否启用了惯性。
     *
     * @stability stable
     */
    get inertiaEnabled(): boolean {
        return this._inertiaEnabled;
    }

    /**
     * 惯性是否正在运行。
     * 任一通道（pan/bearing/pitch）有非零速度即为活跃。
     *
     * @stability stable
     */
    get isInertiaActive(): boolean {
        if (this._panning) return false;
        // 检查平移惯性
        const panActive =
            Math.abs(this._inertiaVelX) > INERTIA_VELOCITY_THRESHOLD ||
            Math.abs(this._inertiaVelY) > INERTIA_VELOCITY_THRESHOLD;
        // 检查旋转/倾斜惯性
        const rotateActive =
            Math.abs(this._inertiaBearingVel) > INERTIA_ANGULAR_THRESHOLD ||
            Math.abs(this._inertiaPitchVel) > INERTIA_ANGULAR_THRESHOLD;
        return panActive || rotateActive;
    }

    /**
     * 用户是否正在进行手势平移。
     *
     * @stability stable
     */
    get isPanning(): boolean {
        return this._panning;
    }

    /**
     * 相机是否处于任何运动状态。
     *
     * @stability stable
     */
    get isMoving(): boolean {
        return this._panning || this.isInertiaActive || this.isAnimating;
    }

    // ==================== 状态设置方法 ====================

    /**
     * 设置地图中心 [经度, 纬度]（度）。
     * 自动应用地理约束。
     *
     * @param center - [经度, 纬度]，度
     *
     * @stability stable
     *
     * @example
     * cam.setCenter([116.39, 39.91]);
     */
    setCenter(center: [number, number]): void {
        this._checkDestroyed();
        if (__DEV__) {
            if (!Array.isArray(center) || center.length < 2) {
                console.warn('[Camera25D] setCenter: invalid center array');
            }
        }
        const [cx, cy] = this._constrainCenter(
            Number.isFinite(center[0]) ? center[0] : this._cx,
            Number.isFinite(center[1]) ? center[1] : this._cy,
        );
        this._cx = cx;
        this._cy = cy;
    }

    /**
     * 设置缩放级别。自动钳制到 [minZoom, maxZoom]。
     *
     * @param zoom - 连续缩放级别
     *
     * @stability stable
     *
     * @example
     * cam.setZoom(14.5);
     */
    setZoom(zoom: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(zoom)) {
            if (__DEV__) {
                console.warn('[Camera25D] setZoom: non-finite zoom ignored');
            }
            return;
        }
        this._zoom = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
    }

    /**
     * 设置方位角 bearing（弧度）。
     * **2.5D 模式下有效**：立即更改旋转角，归一化到 [-π, π]。
     *
     * @param bearing - 方位角（弧度），0 = 正北
     *
     * @stability stable
     *
     * @example
     * cam.setBearing(Math.PI / 4);
     */
    setBearing(bearing: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(bearing)) {
            if (__DEV__) {
                console.warn('[Camera25D] setBearing: non-finite bearing ignored');
            }
            return;
        }
        this._bearing = normalizeBearing(bearing);
    }

    /**
     * 设置俯仰角 pitch（弧度）。
     * **2.5D 模式下有效**：自动钳制到 [0, maxPitch]。
     *
     * @param pitch - 俯仰角（弧度），0 = 正俯视
     *
     * @stability stable
     *
     * @example
     * cam.setPitch(Math.PI / 3);
     */
    setPitch(pitch: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(pitch)) {
            if (__DEV__) {
                console.warn('[Camera25D] setPitch: non-finite pitch ignored');
            }
            return;
        }
        this._pitch = clamp(pitch, 0, this._constraints.maxPitch);
    }

    // ==================== 跳转与动画 ====================

    /**
     * 瞬间跳转到指定状态（无动画过渡）。
     * 会停止当前所有动画和惯性。
     *
     * @param options - 跳转参数，未指定的属性保持当前值
     *
     * @stability stable
     *
     * @example
     * cam.jumpTo({ center: [116.39, 39.91], zoom: 14, bearing: 0, pitch: 0.5 });
     */
    jumpTo(options: {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
    }): void {
        this._checkDestroyed();
        this.stop();
        this._killAllInertia();

        // 应用 bearing
        if (options.bearing !== undefined && Number.isFinite(options.bearing)) {
            this._bearing = normalizeBearing(options.bearing);
        }
        // 应用 pitch
        if (options.pitch !== undefined && Number.isFinite(options.pitch)) {
            this._pitch = clamp(options.pitch, 0, this._constraints.maxPitch);
        }
        // 应用中心坐标
        if (options.center) {
            const [cx, cy] = this._constrainCenter(
                Number.isFinite(options.center[0]) ? options.center[0] : this._cx,
                Number.isFinite(options.center[1]) ? options.center[1] : this._cy,
            );
            this._cx = cx;
            this._cy = cy;
        }
        // 应用缩放
        if (options.zoom !== undefined && Number.isFinite(options.zoom)) {
            this._zoom = clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom);
        }
    }

    /**
     * 执行弧线飞行动画（bird's-eye arc）。
     * 中间阶段先缩小以获得鸟瞰视角，然后缩放到目标级别。
     * 同时插值 bearing 和 pitch。
     *
     * @param options - 飞行参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * const anim = cam.flyTo({ center: [121.47, 31.23], zoom: 12, bearing: 0, pitch: 0.8, duration: 2000 });
     * await anim.finished;
     */
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
        this._killAllInertia();

        // 解析目标参数
        const durationMs = Math.max(
            MIN_ANIM_DURATION_MS,
            options.duration ?? DEFAULT_FLY_DURATION_MS,
        );
        const easing = options.easing ?? easeInOutCubic;
        const toZoom = options.zoom !== undefined
            ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom)
            : this._zoom;
        const toBearing = options.bearing !== undefined && Number.isFinite(options.bearing)
            ? normalizeBearing(options.bearing)
            : this._bearing;
        const toPitch = options.pitch !== undefined && Number.isFinite(options.pitch)
            ? clamp(options.pitch, 0, this._constraints.maxPitch)
            : this._pitch;

        let toX = this._cx;
        let toY = this._cy;
        if (options.center) {
            const [cx, cy] = this._constrainCenter(
                Number.isFinite(options.center[0]) ? options.center[0] : this._cx,
                Number.isFinite(options.center[1]) ? options.center[1] : this._cy,
            );
            toX = cx;
            toY = cy;
        }

        // 计算 peakZoom：基于起止点的 Mercator 像素距离
        const refZoom = Math.min(this._zoom, toZoom);
        lngLatToPixel(_pxA, this._cx, this._cy, refZoom);
        lngLatToPixel(_pxB, toX, toY, refZoom);
        const dxPx = _pxB[0] - _pxA[0];
        const dyPx = _pxB[1] - _pxA[1];
        const mercDist = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        const screenDiag = Math.sqrt(vpW * vpW + vpH * vpH);

        let peakZoom: number;
        if (mercDist < 1) {
            // 起止点几乎重合，退化为 easeTo
            peakZoom = refZoom;
        } else {
            // 距离/屏幕对角线比值越大 → peakZoom 越小
            const ratio = Math.max(mercDist / Math.max(screenDiag, 1), 1);
            peakZoom = refZoom - Math.log2(ratio) - 1;
            peakZoom = Math.max(peakZoom, this._constraints.minZoom);
            peakZoom = Math.min(peakZoom, refZoom);
        }

        // 创建动画句柄
        const id = generateAnimationId();
        const handle = createAnimHandle(id, () => {
            if (this._animation && this._animation.id === id) {
                this._animation = null;
            }
        });

        this._animation = {
            id,
            kind: 'fly',
            fromCenter: [this._cx, this._cy],
            toCenter: [toX, toY],
            fromZoom: this._zoom,
            toZoom,
            peakZoom,
            fromBearing: this._bearing,
            toBearing,
            fromPitch: this._pitch,
            toPitch,
            durationMs,
            easing,
            startMs: now(),
            handle,
        };

        return handle;
    }

    /**
     * 执行线性缓动动画（easeTo）。
     * 中心、缩放、bearing、pitch 同时线性插值。
     *
     * @param options - 缓动参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * const anim = cam.easeTo({ zoom: 16, bearing: 0, pitch: 0.4, duration: 800 });
     * await anim.finished;
     */
    easeTo(options: {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
    }): CameraAnimation {
        this._checkDestroyed();
        this.stop();
        this._killAllInertia();

        const durationMs = Math.max(
            MIN_ANIM_DURATION_MS,
            options.duration ?? DEFAULT_EASE_DURATION_MS,
        );
        const toZoom = options.zoom !== undefined
            ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom)
            : this._zoom;
        const toBearing = options.bearing !== undefined && Number.isFinite(options.bearing)
            ? normalizeBearing(options.bearing)
            : this._bearing;
        const toPitch = options.pitch !== undefined && Number.isFinite(options.pitch)
            ? clamp(options.pitch, 0, this._constraints.maxPitch)
            : this._pitch;

        let toX = this._cx;
        let toY = this._cy;
        if (options.center) {
            const [cx, cy] = this._constrainCenter(
                Number.isFinite(options.center[0]) ? options.center[0] : this._cx,
                Number.isFinite(options.center[1]) ? options.center[1] : this._cy,
            );
            toX = cx;
            toY = cy;
        }

        const id = generateAnimationId();
        const handle = createAnimHandle(id, () => {
            if (this._animation && this._animation.id === id) {
                this._animation = null;
            }
        });

        this._animation = {
            id,
            kind: 'ease',
            fromCenter: [this._cx, this._cy],
            toCenter: [toX, toY],
            fromZoom: this._zoom,
            toZoom,
            peakZoom: this._zoom,
            fromBearing: this._bearing,
            toBearing,
            fromPitch: this._pitch,
            toPitch,
            durationMs,
            easing: easeInOutCubic,
            startMs: now(),
            handle,
        };

        return handle;
    }

    /**
     * 动画复位方位角到正北（bearing=0），pitch 保持不变。
     *
     * @param options - 可选动画参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * await cam.resetNorth({ duration: 800 }).finished;
     */
    resetNorth(options?: { duration?: number }): CameraAnimation {
        this._checkDestroyed();
        // 通过 easeTo 实现，只改变 bearing
        return this.easeTo({
            bearing: 0,
            duration: options?.duration ?? DEFAULT_EASE_DURATION_MS,
        });
    }

    /**
     * 动画同时复位方位角和俯仰角（bearing=0, pitch=0）。
     *
     * @param options - 可选动画参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @stability stable
     *
     * @example
     * await cam.resetNorthPitch().finished;
     */
    resetNorthPitch(options?: { duration?: number }): CameraAnimation {
        this._checkDestroyed();
        return this.easeTo({
            bearing: 0,
            pitch: 0,
            duration: options?.duration ?? DEFAULT_EASE_DURATION_MS,
        });
    }

    /**
     * 若 bearing 接近正北，动画吸附到正北；否则不执行任何操作。
     * 阈值为 SNAP_TO_NORTH_THRESHOLD（约 7°）。
     *
     * @param options - 可选动画参数
     * @returns 动画句柄。若未触发则立即处于 finished 状态
     *
     * @stability stable
     *
     * @example
     * cam.snapToNorth(); // 若 bearing ≈ 0.05，吸附到 0
     */
    snapToNorth(options?: { duration?: number }): CameraAnimation {
        this._checkDestroyed();
        // 检查 bearing 是否在吸附阈值内
        if (Math.abs(normalizeBearing(this._bearing)) < SNAP_TO_NORTH_THRESHOLD) {
            // 在阈值内，执行吸附动画
            return this.easeTo({
                bearing: 0,
                duration: options?.duration ?? 300,
            });
        }
        // 不在阈值内，返回已完成的句柄
        return createFinishedAnimHandle();
    }

    /**
     * 停止所有活动动画。
     * 不影响惯性。
     *
     * @stability stable
     *
     * @example
     * cam.stop();
     */
    stop(): void {
        if (this._animation) {
            const h = this._animation.handle;
            this._animation = null;
            h.cancel();
        }
    }

    // ==================== 约束与惯性配置 ====================

    /**
     * 合并更新约束。未指定的字段保持当前值。
     * 更新后立即钳制当前状态。
     *
     * @param constraints - 部分约束更新
     *
     * @stability stable
     *
     * @example
     * cam.setConstraints({ maxPitch: Math.PI / 4 });
     */
    setConstraints(constraints: Partial<CameraConstraints>): void {
        this._checkDestroyed();
        const next: CameraConstraints = {
            minZoom: constraints.minZoom ?? this._constraints.minZoom,
            maxZoom: constraints.maxZoom ?? this._constraints.maxZoom,
            minPitch: constraints.minPitch ?? this._constraints.minPitch,
            maxPitch: constraints.maxPitch ?? this._constraints.maxPitch,
            maxBounds: constraints.maxBounds !== undefined
                ? constraints.maxBounds
                : this._constraints.maxBounds,
        };

        // 自动修正 min > max
        if (next.minZoom > next.maxZoom) {
            const tmp = next.minZoom;
            (next as { minZoom: number }).minZoom = next.maxZoom;
            (next as { maxZoom: number }).maxZoom = tmp;
        }

        this._constraints = next;

        // 立即钳制当前状态到新约束
        this._zoom = clamp(this._zoom, next.minZoom, next.maxZoom);
        this._pitch = clamp(this._pitch, 0, next.maxPitch);
        const [cx, cy] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx;
        this._cy = cy;
    }

    /**
     * 启用或禁用惯性。禁用时立即清零所有惯性速度。
     *
     * @param enabled - 是否启用惯性
     *
     * @stability stable
     *
     * @example
     * cam.setInertiaEnabled(false);
     */
    setInertiaEnabled(enabled: boolean): void {
        this._checkDestroyed();
        this._inertiaEnabled = enabled;
        if (!enabled) {
            this._killAllInertia();
        }
    }

    // ==================== 2.5D 专用查询方法 ====================

    /**
     * 计算当前视口中地平线的 Y 坐标（CSS 像素，从顶部计）。
     *
     * 地平线出现在倾斜视图中，当视线方向接近水平时。
     * 公式推导：在透视投影中，地面平面 z=0 在视口中的消失线位置
     * 由 pitch 和 fov 共同决定。
     *
     * 当 pitch ≤ fov/2 时，地平线在视口上方（不可见），返回 0。
     * 当 pitch 接近 90° 时，地平线接近视口中心。
     *
     * @returns 地平线 Y 坐标（CSS 像素），0=顶部
     *
     * @stability stable
     *
     * @example
     * const horizonY = cam.getHorizonY();
     */
    getHorizonY(): number {
        const vpH = this._lastViewportHeight;
        if (vpH < MIN_VIEWPORT_DIM) {
            return 0;
        }
        const normalized = this._computeHorizonY();
        if (!Number.isFinite(normalized)) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera25D] getHorizonY: _computeHorizonY 非有限，回退 0');
            }
            return 0;
        }
        return clamp(normalized, 0, 1) * vpH;
    }

    /**
     * 获取当前视口可见的地理范围。
     * 通过反投影视口角点到地面平面计算。
     * 高 pitch 时上方角点可能命中天空，使用地平线裁剪。
     *
     * @returns 可见范围的经纬度包围盒
     *
     * @stability stable
     *
     * @example
     * const bounds = cam.getVisibleBounds();
     */
    getVisibleBounds(): BBox2D {
        // 若尚未调用 update()，返回全球范围
        if (!this._hasUpdated) {
            return { west: -180, south: -MAX_LATITUDE, east: 180, north: MAX_LATITUDE };
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;

        // 获取地平线 Y，用于裁剪上方不可见区域
        const horizonY = this.getHorizonY();
        // 上边界使用地平线 Y（或略低于地平线以确保命中地面），下限为 0
        const topY = Math.max(horizonY + 1, 0);

        // 反投影视口的四个采样点
        const tl = this.screenToLngLat(0, topY);
        const tr = this.screenToLngLat(vpW, topY);
        const bl = this.screenToLngLat(0, vpH);
        const br = this.screenToLngLat(vpW, vpH);

        // 若任一角转换失败，返回全球范围
        if (!tl || !tr || !bl || !br) {
            return { west: -180, south: -MAX_LATITUDE, east: 180, north: MAX_LATITUDE };
        }

        return {
            west: Math.min(tl[0], tr[0], bl[0], br[0]),
            south: Math.min(tl[1], tr[1], bl[1], br[1]),
            east: Math.max(tl[0], tr[0], bl[0], br[0]),
            north: Math.max(tl[1], tr[1], bl[1], br[1]),
        };
    }

    /**
     * 将屏幕坐标转换为经纬度（射线-地面平面相交）。
     *
     * 算法：
     * 1. 屏幕坐标 → NDC
     * 2. NDC 近平面点和远平面点通过 inverseVP 反投影到世界空间
     * 3. 构造射线 = nearPoint + t * (farPoint - nearPoint)
     * 4. 与 z=0 平面相交求 t
     * 5. 世界坐标 → Mercator 像素 → lngLat
     *
     * @param screenX - 屏幕 X（CSS 像素）
     * @param screenY - 屏幕 Y（CSS 像素）
     * @returns [经度, 纬度] 或 null（射线未命中地面）
     *
     * @stability stable
     *
     * @example
     * const lngLat = cam.screenToLngLat(mouseX, mouseY);
     */
    screenToLngLat(screenX: number, screenY: number): [number, number] | null {
        // 参数安全检查
        if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
            return null;
        }
        if (!this._hasUpdated) {
            return null;
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
            return null;
        }

        // 屏幕坐标 → NDC
        const ndcX = (screenX / vpW) * 2 - 1;
        const ndcY = 1 - (screenY / vpH) * 2;

        // Reversed-Z: near=1.0, far=0.0
        // 反投影近平面点 (ndcX, ndcY, 1.0)
        vec3.set(_tempVec3A, ndcX, ndcY, 1.0);
        vec3.transformMat4(_tempVec3A, _tempVec3A, this._mutable.inverseVPMatrix);

        // 反投影远平面点 (ndcX, ndcY, 0.0)
        vec3.set(_tempVec3B, ndcX, ndcY, 0.0);
        vec3.transformMat4(_tempVec3B, _tempVec3B, this._mutable.inverseVPMatrix);

        // 检查反投影结果有效性
        if (!Number.isFinite(_tempVec3A[0]) || !Number.isFinite(_tempVec3B[0])) {
            return null;
        }

        // 射线方向 = far - near
        const dirX = _tempVec3B[0] - _tempVec3A[0];
        const dirY = _tempVec3B[1] - _tempVec3A[1];
        const dirZ = _tempVec3B[2] - _tempVec3A[2];

        // 与 z=0 地面平面相交：nearZ + t * dirZ = 0
        // t = -nearZ / dirZ
        if (Math.abs(dirZ) < EPSILON) {
            // 射线平行于地面，无交点
            return null;
        }

        const t = -_tempVec3A[2] / dirZ;
        if (t < 0) {
            // 交点在射线反方向（指向天空），无有效命中
            return null;
        }

        // 交点的 Mercator 像素坐标
        const worldPxX = _tempVec3A[0] + t * dirX;
        const worldPxY = _tempVec3A[1] + t * dirY;

        if (!Number.isFinite(worldPxX) || !Number.isFinite(worldPxY)) {
            return null;
        }

        // Mercator 像素 → lngLat
        pixelToLngLat(_llOut, worldPxX, worldPxY, this._zoom);

        return [_llOut[0], _llOut[1]];
    }

    /**
     * 将经纬度转换为屏幕坐标。
     * 通过 lngLatToPixel → VP 矩阵投影到 NDC → 屏幕坐标。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns [screenX, screenY]（CSS 像素）
     *
     * @stability stable
     *
     * @example
     * const [sx, sy] = cam.lngLatToScreen(116.39, 39.91);
     */
    lngLatToScreen(lon: number, lat: number): [number, number] {
        // 经纬度 → Mercator 像素
        lngLatToPixel(_pxA, lon, lat, this._zoom);

        // Mercator 像素 → 裁剪空间（地面 z=0）
        vec3.set(_tempVec3A, _pxA[0], _pxA[1], 0);
        vec3.transformMat4(_tempVec3A, _tempVec3A, this._mutable.vpMatrix);

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;

        // NDC → 屏幕坐标
        const screenX = (_tempVec3A[0] + 1) * 0.5 * vpW;
        const screenY = (1 - _tempVec3A[1]) * 0.5 * vpH;

        return [screenX, screenY];
    }

    // ==================== 核心帧更新 ====================

    /**
     * 每帧更新：推进动画/惯性、重建变换矩阵、触发回调。
     * 由 FrameScheduler 在 UPDATE 阶段调用，每帧恰好一次。
     *
     * 2.5D 透视矩阵计算流程：
     * 1. altitude = C / (2^zoom × tileSize × cos(lat))
     * 2. 相机位置：从中心沿 pitch 方向后退 altitude 距离
     *    eye = center + [-sin(bearing)*sin(pitch)*altitude, cos(bearing)*sin(pitch)*altitude, cos(pitch)*altitude]
     * 3. lookAt(eye, target=[centerPx, centerPy, 0], up=rotate([0,1,0], bearing))
     * 4. perspectiveReversedZ(fov, aspect, near, far)
     *    near = max(cameraToCenterDist×0.01, 10)；far = _computeFarPlane(cameraToCenterDist)
     * 5. VP = P × V, inverseVP = VP^(-1)
     *
     * @param deltaTime - 距上一帧时间差（秒）
     * @param viewport - 当前视口尺寸
     * @returns 更新后的 CameraState 快照
     *
     * @stability stable
     *
     * @example
     * const state = cam.update(1/60, { width: 1920, height: 1080, ... });
     */
    update(deltaTime: number, viewport: Viewport): CameraState {
        this._checkDestroyed();

        // 安全化 deltaTime
        const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;

        // 缓存视口尺寸
        this._lastViewportWidth = Math.max(viewport.width, MIN_VIEWPORT_DIM);
        this._lastViewportHeight = Math.max(viewport.height, MIN_VIEWPORT_DIM);

        // ===== 阶段 1：推进动画或惯性 =====

        if (this._animation) {
            this._advanceAnimation();
        } else if (this._inertiaEnabled && !this._panning && this.isInertiaActive) {
            this._advanceInertia(dt);
        }

        // ===== 阶段 2：应用约束 =====

        this._zoom = clamp(this._zoom, this._constraints.minZoom, this._constraints.maxZoom);
        this._pitch = clamp(this._pitch, 0, this._constraints.maxPitch);
        this._bearing = normalizeBearing(this._bearing);
        const [cx, cy] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx;
        this._cy = cy;

        // ===== 阶段 3：构建变换矩阵 =====

        this._rebuildMatrices(viewport);

        // ===== 阶段 4：高 pitch 检测 =====

        const isHighPitch = this._pitch > HIGH_PITCH_THRESHOLD;
        if (isHighPitch && !this._wasHighPitch) {
            // 进入高 pitch 区间，触发回调
            this._fireHighPitch();
        }
        this._wasHighPitch = isHighPitch;

        // ===== 阶段 5：检测 move 状态转变并触发回调 =====

        const currentlyMoving = this.isMoving;
        if (currentlyMoving && !this._wasMoving) {
            this._fireMoveStart();
        }
        if (currentlyMoving) {
            this._fireMove();
        }
        if (!currentlyMoving && this._wasMoving) {
            this._fireMoveEnd();
        }
        this._wasMoving = currentlyMoving;
        this._hasUpdated = true;

        return this._mutable as CameraState;
    }

    // ==================== 交互处理 ====================

    /**
     * 平移手势开始。记录起始位置，重置惯性缓冲区。
     *
     * @param screenX - 起始屏幕 X（CSS 像素）
     * @param screenY - 起始屏幕 Y（CSS 像素）
     *
     * @stability stable
     *
     * @example
     * canvas.addEventListener('pointerdown', (e) => cam.handlePanStart(e.clientX, e.clientY));
     */
    handlePanStart(screenX: number, screenY: number): void {
        this._checkDestroyed();
        this.stop();
        this._panning = true;
        this._panPrevX = screenX;
        this._panPrevY = screenY;
        // 重置所有惯性
        this._killAllInertia();
        this._inertiaHead = 0;
        this._inertiaCount = 0;
    }

    /**
     * 平移手势移动。计算位移、更新中心、记录惯性样本。
     *
     * 在 2.5D 透视模式下，屏幕像素与 Mercator 像素不再 1:1。
     * 需要通过 screenToLngLat 差分来实现准确的拖拽映射：
     * 记录上一帧和当前帧的屏幕位置对应的 lngLat，差值即为中心偏移。
     *
     * 简化实现（不依赖矩阵已就绪）：使用缩放因子近似。
     * 在 pitch 较小时与精确方法几乎等同。
     *
     * @param screenX - 当前屏幕 X（CSS 像素）
     * @param screenY - 当前屏幕 Y（CSS 像素）
     *
     * @stability stable
     */
    handlePanMove(screenX: number, screenY: number): void {
        this._checkDestroyed();
        if (this._panPrevX === null || this._panPrevY === null) {
            return;
        }

        // 屏幕像素位移
        const dx = screenX - this._panPrevX;
        const dy = screenY - this._panPrevY;
        this._panPrevX = screenX;
        this._panPrevY = screenY;

        // 零位移跳过
        if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
            return;
        }

        // 将中心从 lngLat 转换到 Mercator 像素坐标
        lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);

        // 在倾斜视图中，Y 轴拖拽需要考虑 pitch 引起的透视缩放
        // 近似：Y 方向的有效位移 = dy / cos(pitch)
        // 这是因为倾斜后地面在 Y 方向被「压缩」了 cos(pitch) 倍
        const cosPitch = Math.max(Math.cos(this._pitch), EPSILON);

        // bearing 旋转：屏幕位移需要按 bearing 旋转到世界坐标
        const sinB = Math.sin(this._bearing);
        const cosB = Math.cos(this._bearing);

        // 屏幕位移 → 世界像素位移（含 bearing 旋转和 pitch 缩放）
        // 旋转矩阵：[cosB, -sinB; sinB, cosB] × [dx, dy/cosPitch]
        const worldDx = cosB * dx + sinB * (dy / cosPitch);
        const worldDy = -sinB * dx + cosB * (dy / cosPitch);

        // 拖拽位移取反：拖右 → 中心左移
        _pxA[0] -= worldDx;
        _pxA[1] -= worldDy;

        // 转换回 lngLat
        pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
        this._cx = _llOut[0];
        this._cy = _llOut[1];

        // 应用约束
        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;

        // 记录惯性样本（世界像素空间位移）
        this._addInertiaSample(-worldDx, -worldDy, now());
    }

    /**
     * 平移手势结束。从惯性缓冲区计算初始速度。
     *
     * @stability stable
     *
     * @example
     * canvas.addEventListener('pointerup', () => cam.handlePanEnd());
     */
    handlePanEnd(): void {
        this._checkDestroyed();
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;

        if (this._inertiaEnabled) {
            const [vx, vy] = this._computeInertiaVelocity();
            this._inertiaVelX = vx;
            this._inertiaVelY = vy;
        }
    }

    /**
     * 缩放（锚点缩放）。
     * 以指定屏幕位置为缩放中心，保证该位置对应的地理坐标不变。
     *
     * @param delta - 缩放量。正值放大（zoom 增加），负值缩小
     * @param screenX - 缩放锚点屏幕 X（CSS 像素）
     * @param screenY - 缩放锚点屏幕 Y（CSS 像素）
     *
     * @stability stable
     *
     * @example
     * canvas.addEventListener('wheel', (e) => {
     *   cam.handleZoom(-e.deltaY * 0.01, e.clientX, e.clientY);
     * });
     */
    handleZoom(delta: number, screenX: number, screenY: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(delta) || Math.abs(delta) < EPSILON) {
            return;
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
            return;
        }

        const oldZoom = this._zoom;
        const newZoom = clamp(
            oldZoom + delta,
            this._constraints.minZoom,
            this._constraints.maxZoom,
        );

        if (Math.abs(newZoom - oldZoom) < EPSILON) {
            return;
        }

        // 尝试使用射线相交进行锚点缩放
        // 获取锚点在缩放前对应的 lngLat
        const anchorLngLat = this.screenToLngLat(screenX, screenY);

        // 先应用缩放
        this._zoom = newZoom;

        if (anchorLngLat) {
            // 缩放后锚点应仍然在屏幕同一位置
            // 计算缩放后锚点的新屏幕位置
            const [newSx, newSy] = this.lngLatToScreen(anchorLngLat[0], anchorLngLat[1]);

            // 屏幕位置差 = 锚点应在位置 - 锚点实际位置
            // 将这个差值转换为中心偏移
            const offsetSx = screenX - newSx;
            const offsetSy = screenY - newSy;

            // 在 Mercator 像素空间中偏移中心
            if (Math.abs(offsetSx) > EPSILON || Math.abs(offsetSy) > EPSILON) {
                lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);

                // 屏幕偏移 → 世界偏移（考虑 bearing 和 pitch）
                const cosPitch = Math.max(Math.cos(this._pitch), EPSILON);
                const sinB = Math.sin(this._bearing);
                const cosB = Math.cos(this._bearing);
                const worldDx = cosB * (-offsetSx) + sinB * (-offsetSy / cosPitch);
                const worldDy = -sinB * (-offsetSx) + cosB * (-offsetSy / cosPitch);

                _pxA[0] += worldDx;
                _pxA[1] += worldDy;

                pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
                this._cx = _llOut[0];
                this._cy = _llOut[1];
            }
        } else {
            // 射线未命中地面（高 pitch 时锚点指向天空），仅缩放不偏移中心
            // 回退到简单缩放：使用视口中心作为缩放锚点
            const halfW = vpW / 2;
            const halfH = vpH / 2;
            const anchorOffsetX = screenX - halfW;
            const anchorOffsetY = screenY - halfH;

            lngLatToPixel(_pxA, this._cx, this._cy, oldZoom);
            const oldCenterPxX = _pxA[0];
            const oldCenterPxY = _pxA[1];
            const anchorPxX = oldCenterPxX + anchorOffsetX;
            const anchorPxY = oldCenterPxY + anchorOffsetY;

            const scaleRatio = Math.pow(2, newZoom - oldZoom);
            const newAnchorPxX = anchorPxX * scaleRatio;
            const newAnchorPxY = anchorPxY * scaleRatio;
            const newCenterPxX = newAnchorPxX - anchorOffsetX;
            const newCenterPxY = newAnchorPxY - anchorOffsetY;

            pixelToLngLat(_llOut, newCenterPxX, newCenterPxY, newZoom);
            this._cx = _llOut[0];
            this._cy = _llOut[1];
        }

        // 应用约束
        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;
    }

    /**
     * 以锚点为中心缩放：pitch≈0 时走墨卡托米空间快路径；否则先设 zoom 再按屏幕像素差修正中心（与 handleZoom 一致）。
     *
     * @param anchorScreenX - 锚点屏幕 X（CSS 像素）
     * @param anchorScreenY - 锚点屏幕 Y（CSS 像素）
     * @param anchorLngLat - 锚点 [lon, lat]（度）
     * @param newZoom - 目标缩放级别
     *
     * @stability stable
     */
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
            if (__DEV__) {
                console.warn('[Camera25D] zoomAround: non-finite arguments ignored');
            }
            return;
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
            if (__DEV__) {
                console.warn('[Camera25D] zoomAround: viewport not ready');
            }
            return;
        }

        const oldZoom = this._zoom;
        const zNew = clamp(newZoom, this._constraints.minZoom, this._constraints.maxZoom);
        if (Math.abs(zNew - oldZoom) < EPSILON) {
            return;
        }

        if (Math.abs(this._pitch) < PITCH_NEAR_ZERO_FOR_ZOOM_AROUND) {
            const scaleFactor = Math.pow(2, zNew - oldZoom);
            if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
                if (__DEV__) {
                    console.warn('[Camera25D] zoomAround: invalid scale factor');
                }
                return;
            }
            lngLatToMercator(_pxA, anchorLngLat[0], anchorLngLat[1]);
            lngLatToMercator(_pxB, this._cx, this._cy);
            const newCenterMx = _pxA[0] + (_pxB[0] - _pxA[0]) / scaleFactor;
            const newCenterMy = _pxA[1] + (_pxB[1] - _pxA[1]) / scaleFactor;
            mercatorToLngLat(_llOut, newCenterMx, newCenterMy);
            this._zoom = zNew;
            this._cx = _llOut[0];
            this._cy = _llOut[1];
            const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
            this._cx = cx2;
            this._cy = cy2;
            return;
        }

        this._zoom = zNew;

        const [newSx, newSy] = this.lngLatToScreen(anchorLngLat[0], anchorLngLat[1]);
        if (!Number.isFinite(newSx) || !Number.isFinite(newSy)) {
            if (__DEV__) {
                console.warn('[Camera25D] zoomAround: lngLatToScreen failed');
            }
            this._zoom = oldZoom;
            return;
        }

        const offsetSx = anchorScreenX - newSx;
        const offsetSy = anchorScreenY - newSy;

        if (Math.abs(offsetSx) > EPSILON || Math.abs(offsetSy) > EPSILON) {
            lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);
            const cosPitch = Math.max(Math.cos(this._pitch), EPSILON);
            const sinB = Math.sin(this._bearing);
            const cosB = Math.cos(this._bearing);
            const worldDx = cosB * (-offsetSx) + sinB * (-offsetSy / cosPitch);
            const worldDy = -sinB * (-offsetSx) + cosB * (-offsetSy / cosPitch);
            _pxA[0] += worldDx;
            _pxA[1] += worldDy;
            pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
            this._cx = _llOut[0];
            this._cy = _llOut[1];
        }

        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;
    }

    /**
     * 旋转手势处理。
     * **2.5D 模式下有效**：bearing += bearingDelta, pitch = clamp(pitch + pitchDelta)。
     * 同时记录旋转/倾斜速度供惯性使用。
     *
     * @param bearingDelta - 方位角增量（弧度，正值顺时针）
     * @param pitchDelta - 俯仰角增量（弧度，正值向地平线）
     *
     * @stability stable
     *
     * @example
     * cam.handleRotate(0.02, 0.01); // 微小旋转和倾斜
     */
    handleRotate(bearingDelta: number, pitchDelta: number): void {
        this._checkDestroyed();

        // 安全化增量
        const dBearing = Number.isFinite(bearingDelta) ? bearingDelta : 0;
        const dPitch = Number.isFinite(pitchDelta) ? pitchDelta : 0;

        if (Math.abs(dBearing) < EPSILON && Math.abs(dPitch) < EPSILON) {
            return;
        }

        // 应用 bearing 增量
        if (Math.abs(dBearing) >= EPSILON) {
            this._bearing = normalizeBearing(this._bearing + dBearing);
            // 记录旋转速度供惯性使用（简化：直接用增量/假定帧时间）
            // 精确的帧时间在 update 中处理，这里做平滑估算
            this._inertiaBearingVel = dBearing * 60;
        }

        // 应用 pitch 增量并钳制
        if (Math.abs(dPitch) >= EPSILON) {
            this._pitch = clamp(
                this._pitch + dPitch,
                0,
                this._constraints.maxPitch,
            );
            this._inertiaPitchVel = dPitch * 60;
        }
    }

    // ==================== 事件订阅 ====================

    /**
     * 注册移动开始回调。
     *
     * @param callback - 回调函数
     * @returns 取消订阅函数
     *
     * @stability stable
     *
     * @example
     * const unsub = cam.onMoveStart(() => console.log('started'));
     * unsub();
     */
    onMoveStart(callback: () => void): () => void {
        this._onMoveStartCallbacks.add(callback);
        return () => {
            this._onMoveStartCallbacks.delete(callback);
        };
    }

    /**
     * 注册移动中回调。
     *
     * @param callback - 回调函数
     * @returns 取消订阅函数
     *
     * @stability stable
     */
    onMove(callback: (state: CameraState) => void): () => void {
        this._onMoveCallbacks.add(callback);
        return () => {
            this._onMoveCallbacks.delete(callback);
        };
    }

    /**
     * 注册移动结束回调。
     *
     * @param callback - 回调函数
     * @returns 取消订阅函数
     *
     * @stability stable
     */
    onMoveEnd(callback: () => void): () => void {
        this._onMoveEndCallbacks.add(callback);
        return () => {
            this._onMoveEndCallbacks.delete(callback);
        };
    }

    // ==================== 销毁 ====================

    /**
     * 释放所有资源、取消动画、清空事件订阅。
     * 销毁后任何方法调用都会抛出错误。
     *
     * @stability stable
     *
     * @example
     * cam.destroy();
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        this.stop();
        this._killAllInertia();
        this._onMoveStartCallbacks.clear();
        this._onMoveCallbacks.clear();
        this._onMoveEndCallbacks.clear();
        this._onHighPitchCallbacks.clear();
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;
    }

    // ==================== 私有方法 ====================

    /**
     * 检查销毁状态，若已销毁则抛出错误。
     */
    private _checkDestroyed(): void {
        if (this._destroyed) {
            throw new Error('[Camera25D] controller has been destroyed; create a new instance');
        }
    }

    /**
     * 清零所有惯性速度（平移 + 旋转 + 倾斜）。
     */
    private _killAllInertia(): void {
        this._inertiaVelX = 0;
        this._inertiaVelY = 0;
        this._inertiaBearingVel = 0;
        this._inertiaPitchVel = 0;
    }

    /**
     * 向惯性环形缓冲区添加一个样本。
     *
     * @param dx - Mercator 像素 X 位移
     * @param dy - Mercator 像素 Y 位移
     * @param time - 时间戳（ms）
     */
    private _addInertiaSample(dx: number, dy: number, time: number): void {
        const sample = this._inertiaSamples[this._inertiaHead];
        sample.dx = dx;
        sample.dy = dy;
        sample.time = time;
        this._inertiaHead = (this._inertiaHead + 1) % this._inertiaSamples.length;
        this._inertiaCount = Math.min(this._inertiaCount + 1, this._inertiaSamples.length);
    }

    /**
     * 从环形缓冲区计算平移惯性初始速度。
     *
     * @returns [vx, vy] 惯性速度（Mercator 像素/秒）
     */
    private _computeInertiaVelocity(): [number, number] {
        if (this._inertiaCount < 2) {
            return [0, 0];
        }

        const capacity = this._inertiaSamples.length;
        const newestIdx = (this._inertiaHead - 1 + capacity) % capacity;
        const oldestIdx = (this._inertiaHead - this._inertiaCount + capacity) % capacity;

        const timeSpanMs = this._inertiaSamples[newestIdx].time - this._inertiaSamples[oldestIdx].time;
        if (timeSpanMs < INERTIA_MIN_DURATION_MS) {
            return [0, 0];
        }

        // 累加所有样本位移
        let totalDx = 0;
        let totalDy = 0;
        for (let i = 0; i < this._inertiaCount; i++) {
            const idx = (oldestIdx + i) % capacity;
            totalDx += this._inertiaSamples[idx].dx;
            totalDy += this._inertiaSamples[idx].dy;
        }

        const timeSpanSec = timeSpanMs / 1000;
        let vx = totalDx / timeSpanSec;
        let vy = totalDy / timeSpanSec;

        // 速度下限检查
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed < INERTIA_MIN_SPEED) {
            return [0, 0];
        }

        // 速度上限钳制
        if (speed > DEFAULT_MAX_INERTIA_VELOCITY) {
            const scale = DEFAULT_MAX_INERTIA_VELOCITY / speed;
            vx *= scale;
            vy *= scale;
        }

        return [vx, vy];
    }

    /**
     * 推进三通道惯性：平移速度衰减、旋转速度衰减、倾斜速度衰减。
     * 三个通道使用独立的衰减系数。
     *
     * @param dt - 帧时间差（秒）
     */
    private _advanceInertia(dt: number): void {
        // ===== 平移惯性 =====
        const panActive =
            Math.abs(this._inertiaVelX) > INERTIA_VELOCITY_THRESHOLD ||
            Math.abs(this._inertiaVelY) > INERTIA_VELOCITY_THRESHOLD;

        if (panActive) {
            // 将中心转换到 Mercator 像素空间
            lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);

            // 应用速度位移
            _pxA[0] += this._inertiaVelX * dt;
            _pxA[1] += this._inertiaVelY * dt;

            // 转换回 lngLat
            pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
            this._cx = _llOut[0];
            this._cy = _llOut[1];

            // 指数衰减：decay^(dt*60) 归一化到 60fps
            const panDecay = Math.pow(this._panInertiaDecay, dt * 60);
            this._inertiaVelX *= panDecay;
            this._inertiaVelY *= panDecay;

            // 低于阈值完全停止
            const speed = Math.sqrt(
                this._inertiaVelX * this._inertiaVelX +
                this._inertiaVelY * this._inertiaVelY,
            );
            if (speed < INERTIA_VELOCITY_THRESHOLD) {
                this._inertiaVelX = 0;
                this._inertiaVelY = 0;
            }
        }

        // ===== 旋转（bearing）惯性 =====
        if (Math.abs(this._inertiaBearingVel) > INERTIA_ANGULAR_THRESHOLD) {
            // 应用角速度
            this._bearing = normalizeBearing(this._bearing + this._inertiaBearingVel * dt);

            // 独立衰减
            const bearingDecay = Math.pow(this._bearingInertiaDecay, dt * 60);
            this._inertiaBearingVel *= bearingDecay;

            if (Math.abs(this._inertiaBearingVel) < INERTIA_ANGULAR_THRESHOLD) {
                this._inertiaBearingVel = 0;
            }
        }

        // ===== 倾斜（pitch）惯性 =====
        if (Math.abs(this._inertiaPitchVel) > INERTIA_ANGULAR_THRESHOLD) {
            // 应用角速度并钳制
            this._pitch = clamp(
                this._pitch + this._inertiaPitchVel * dt,
                0,
                this._constraints.maxPitch,
            );

            // 独立衰减
            const pitchDecay = Math.pow(this._pitchInertiaDecay, dt * 60);
            this._inertiaPitchVel *= pitchDecay;

            if (Math.abs(this._inertiaPitchVel) < INERTIA_ANGULAR_THRESHOLD) {
                this._inertiaPitchVel = 0;
            }

            // pitch 到达约束边界时立即停止惯性
            if (this._pitch <= 0 || this._pitch >= this._constraints.maxPitch) {
                this._inertiaPitchVel = 0;
            }
        }
    }

    /**
     * 推进飞行/缓动动画。
     * 根据时间进度插值 center、zoom、bearing、pitch。
     *
     * flyTo：前半段 fromZoom → peakZoom（缩小），后半段 peakZoom → toZoom（放大）。
     * easeTo：全程线性插值。
     * bearing 使用最短路径角度插值。
     */
    private _advanceAnimation(): void {
        const anim = this._animation;
        if (!anim) {
            return;
        }

        // 归一化时间进度
        const elapsed = now() - anim.startMs;
        const tRaw = elapsed / anim.durationMs;
        const tEased = anim.easing(clamp(tRaw, 0, 1));

        // 插值中心坐标
        this._cx = lerp(anim.fromCenter[0], anim.toCenter[0], tEased);
        this._cy = lerp(anim.fromCenter[1], anim.toCenter[1], tEased);

        // 插值 bearing（最短路径）
        this._bearing = lerpAngle(anim.fromBearing, anim.toBearing, tEased);

        // 插值 pitch
        this._pitch = lerp(anim.fromPitch, anim.toPitch, tEased);

        // 插值缩放级别
        if (anim.kind === 'fly') {
            // flyTo 弧线：分前后半段
            if (tEased < 0.5) {
                // 前半段：fromZoom → peakZoom（zoom out）
                this._zoom = lerp(anim.fromZoom, anim.peakZoom, tEased * 2);
            } else {
                // 后半段：peakZoom → toZoom（zoom in）
                this._zoom = lerp(anim.peakZoom, anim.toZoom, (tEased - 0.5) * 2);
            }
        } else {
            // easeTo 线性插值
            this._zoom = lerp(anim.fromZoom, anim.toZoom, tEased);
        }

        // 检查动画是否完成
        if (tRaw >= 1) {
            // 确保最终值精确到达目标
            this._cx = anim.toCenter[0];
            this._cy = anim.toCenter[1];
            this._zoom = anim.toZoom;
            this._bearing = normalizeBearing(anim.toBearing);
            this._pitch = clamp(anim.toPitch, 0, this._constraints.maxPitch);
            finishAnimHandle(anim.handle);
            this._animation = null;
        }
    }

    /**
     * 计算地平线在当前视口中的归一化垂直位置（0=顶部，1=底部）。
     * 基于中心视线与竖直方向夹角及垂直 FOV 的透视关系：`horizonAngle = π/2 - pitch`。
     *
     * @returns [0,1] 内归一化 Y；越接近 1 表示地平线越靠近视口底边
     */
    private _computeHorizonY(): number {
        const halfFov = this._fov * 0.5;
        if (!(halfFov > EPSILON) || !Number.isFinite(halfFov)) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera25D] _computeHorizonY: halfFov 无效，回退 0');
            }
            return 0;
        }
        const horizonAngle = Math.PI / 2 - this._pitch;
        if (!Number.isFinite(horizonAngle)) {
            return 0;
        }
        if (horizonAngle >= halfFov) {
            return 0.0;
        }
        if (horizonAngle <= -halfFov) {
            return 1.0;
        }
        const tanHalf = Math.tan(halfFov);
        if (Math.abs(tanHalf) < EPSILON) {
            return 0.5;
        }
        const tanH = Math.tan(horizonAngle);
        if (!Number.isFinite(tanH)) {
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.warn('[Camera25D] _computeHorizonY: tan(horizonAngle) 非有限');
            }
            return horizonAngle > 0 ? 0 : 1;
        }
        return 0.5 - (tanH / tanHalf) * 0.5;
    }

    /**
     * 计算动态近裁面距离（Mercator 像素空间，与 eye–target 尺度一致）。
     * Reversed-Z 下近裁面对应 depth=1.0。
     *
     * @param cameraToCenterDist - 相机到地面注视点的直线距离（≈ altPixels）
     * @returns near 距离，至少为 10 或与距离成比例的下限
     */
    private _computeNearPlane(cameraToCenterDist: number): number {
        const dist = Number.isFinite(cameraToCenterDist) && cameraToCenterDist > 0 ? cameraToCenterDist : 1;
        return Math.max(dist * 0.01, 10.0);
    }

    /**
     * 按俯仰角与视锥几何计算远裁面距离，使倾斜时地面延伸至地平线附近、减少远端裁剪空洞。
     * 分支：近似俯视；视锥上沿仍与地面相交；上沿指向天空（大 pitch）。
     *
     * @param cameraToCenterDist - 相机到地面中心点的距离（Mercator 像素，与 `_rebuildMatrices` 中 altPixels 一致）
     * @returns far 平面距离（世界单位与投影一致）
     */
    private _computeFarPlane(cameraToCenterDist: number): number {
        const dist = Number.isFinite(cameraToCenterDist) && cameraToCenterDist > EPSILON
            ? cameraToCenterDist
            : 1;
        const halfFov = this._fov * 0.5;
        const pitch = this._pitch;
        if (pitch < PITCH_NEAR_ZERO_FOR_FAR_PLANE) {
            return dist * 1.5;
        }
        const topRayAngle = pitch + halfFov;
        const cosPitch = Math.max(Math.cos(pitch), EPSILON);
        const cameraHeight = dist * cosPitch;
        const horizonLimit = Math.PI / 2 - TOP_RAY_ANGLE_EPS;
        if (topRayAngle < horizonLimit) {
            const cosTop = Math.cos(topRayAngle);
            const safeCos = Math.max(Math.abs(cosTop), EPSILON);
            const groundDist = cameraHeight / safeCos;
            if (!Number.isFinite(groundDist)) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.warn('[Camera25D] _computeFarPlane: groundDist 非有限，使用 pitch 分支');
                }
            } else {
                return Math.max(groundDist * 1.5, dist * 2.0);
            }
        }
        const pitchNormalized = pitch / (Math.PI / 2);
        const mult = Math.min(2 + pitchNormalized * 98, 100);
        return dist * mult;
    }

    /**
     * 重建所有变换矩阵（2.5D 透视投影）。
     *
     * 关键区别于 Camera2D：
     * 1. 使用 perspectiveReversedZ 替代 ortho
     * 2. 相机位置沿 pitch 方向后退
     * 3. up 向量随 bearing 旋转
     * 4. near/far 平面随 altitude 和 pitch 动态调整
     *
     * @param viewport - 当前视口
     */
    private _rebuildMatrices(viewport: Viewport): void {
        const vpOk = isViewportValid(viewport);
        const z = clamp(this._zoom, this._constraints.minZoom, this._constraints.maxZoom);

        if (!vpOk) {
            // 视口无效：保持上一帧矩阵
            mat4.identity(this._mutable.viewMatrix);
            mat4.identity(this._mutable.projectionMatrix);
            mat4.identity(this._mutable.vpMatrix);
            mat4.identity(this._mutable.inverseVPMatrix);
        } else {
            // 将中心 lngLat 转换为 Mercator 像素坐标
            lngLatToPixel(_pxA, this._cx, this._cy, z);
            const centerPxX = _pxA[0];
            const centerPxY = _pxA[1];

            // 计算等效海拔（Mercator 像素单位）
            // 使用 Mercator 像素空间中的「高度」：
            // 将真实海拔（米）转换为 Mercator 像素
            const altMeters = altitudeFromZoom(z, this._cy);
            // Mercator 像素尺度 = EARTH_CIRCUMFERENCE / worldSize
            const worldSize = TILE_SIZE * Math.pow(2, z);
            const metersPerPixel = Math.max(EARTH_CIRCUMFERENCE / worldSize, EPSILON);
            const altPixels = altMeters / metersPerPixel;

            // 相机位置计算：
            // 从中心点沿 pitch 方向后退 altPixels 距离
            // offsetBack = sin(pitch) * altPixels（水平后退量）
            // offsetUp = cos(pitch) * altPixels（垂直高度）
            const sinPitch = Math.sin(this._pitch);
            const cosPitch = Math.cos(this._pitch);
            const offsetBack = sinPitch * altPixels;
            const offsetUp = cosPitch * altPixels;

            // bearing 旋转：后退方向由 bearing 决定
            // bearing=0 时相机向南后退（-Y 方向），即 eye.y > center.y
            // sin(bearing) 控制东西分量，cos(bearing) 控制南北分量
            const sinB = Math.sin(this._bearing);
            const cosB = Math.cos(this._bearing);

            // eye 位置 = center + bearing旋转后的后退偏移
            const eyeX = centerPxX - sinB * offsetBack;
            const eyeY = centerPxY + cosB * offsetBack;
            const eyeZ = offsetUp;

            // target = 地面中心点
            vec3.set(_eye, eyeX, eyeY, eyeZ);
            vec3.set(_target, centerPxX, centerPxY, 0);

            // up 向量：绕 Z 轴旋转 bearing 角度
            // 默认 up = [0, -1, 0]（Mercator Y 轴向南增大，屏幕 up 对应 -Y）
            // 旋转后：up = [-sin(bearing)*(-1), -cos(bearing)*(-1), 0]
            // 简化：在倾斜透视中，up 应垂直于视线方向并指向天空
            // 对于 GIS 地图，up 方向 = 旋转后的「屏幕上方」
            const upX = sinB * cosPitch;
            const upY = -cosB * cosPitch;
            const upZ = sinPitch;
            vec3.set(_up, upX, upY, upZ);

            // 构建视图矩阵
            mat4.lookAt(this._mutable.viewMatrix, _eye, _target, _up);

            // 构建投影矩阵：透视 Reversed-Z（near/far 与 eye–target 距离同尺度）
            const aspect = viewport.width / viewport.height;
            const cameraToCenterDist = Math.max(
                Math.hypot(offsetBack, offsetUp),
                EPSILON,
            );
            const near = this._computeNearPlane(cameraToCenterDist);
            const far = this._computeFarPlane(cameraToCenterDist);
            if (!(far > near) || !Number.isFinite(near) || !Number.isFinite(far)) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.warn(
                        '[Camera25D] _rebuildMatrices: near/far 无效，使用 legacy 回退',
                        { near, far },
                    );
                }
                const fallbackNear = Math.max(altPixels * 0.1, 0.1);
                const pitchFactor = 1.0 + 1.0 / Math.max(cosPitch, EPSILON);
                const fallbackFar = altPixels * pitchFactor * 2.0;
                mat4.perspectiveReversedZ(
                    this._mutable.projectionMatrix,
                    this._fov,
                    aspect,
                    fallbackNear,
                    fallbackFar,
                );
            } else {
                mat4.perspectiveReversedZ(
                    this._mutable.projectionMatrix,
                    this._fov,
                    aspect,
                    near,
                    far,
                );
            }

            // VP = P × V
            mat4.multiply(
                this._mutable.vpMatrix,
                this._mutable.projectionMatrix,
                this._mutable.viewMatrix,
            );

            // 逆 VP 矩阵（屏幕反投影用）
            const inv = mat4.invert(this._mutable.inverseVPMatrix, this._mutable.vpMatrix);
            if (inv === null) {
                mat4.identity(this._mutable.inverseVPMatrix);
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.warn('[Camera25D] VP matrix is singular, inverseVP fallback to identity');
                }
            }
        }

        // 计算海拔（米）
        const altitude = altitudeFromZoom(z, this._cy);

        // 世界坐标系下的相机位置（Mercator 米制坐标）
        lngLatToMercator(_mercOut, this._cx, this._cy);
        this._mutable.position[0] = _mercOut[0];
        this._mutable.position[1] = _mercOut[1];
        this._mutable.position[2] = altitude;

        // 填充标量字段
        this._mutable.center[0] = this._cx;
        this._mutable.center[1] = this._cy;
        this._mutable.zoom = z;
        this._mutable.bearing = this._bearing;
        this._mutable.pitch = this._pitch;
        this._mutable.roll = 0;
        this._mutable.altitude = altitude;
        this._mutable.fov = this._fov;
    }

    /**
     * 约束中心坐标。
     * 若设置了 maxBounds，钳制到范围内。
     * 否则钳制到全球有效范围。
     *
     * @param lon - 输入经度
     * @param lat - 输入纬度
     * @returns 约束后的 [lon, lat]
     */
    private _constrainCenter(lon: number, lat: number): [number, number] {
        let x = Number.isFinite(lon) ? lon : 0;
        let y = Number.isFinite(lat) ? lat : 0;

        const bounds = this._constraints.maxBounds;
        if (!bounds) {
            // 无 bounds 约束：仅钳制到全球有效范围
            x = clamp(x, -180, 180);
            y = clamp(y, -MAX_LATITUDE, MAX_LATITUDE);
            return [x, y];
        }

        // 校验 bounds 是否合法
        if (
            !Number.isFinite(bounds.west) || !Number.isFinite(bounds.east) ||
            !Number.isFinite(bounds.south) || !Number.isFinite(bounds.north) ||
            bounds.west > bounds.east || bounds.south > bounds.north
        ) {
            x = clamp(x, -180, 180);
            y = clamp(y, -MAX_LATITUDE, MAX_LATITUDE);
            return [x, y];
        }

        // 简单中心点约束（2.5D 的透视视口级约束更复杂，
        // 这里使用中心点钳制作为基本保障）
        x = clamp(x, bounds.west, bounds.east);
        y = clamp(y, bounds.south, bounds.north);
        return [x, y];
    }

    // ==================== 回调触发辅助 ====================

    /**
     * 安全触发 onMoveStart 回调集合。
     */
    private _fireMoveStart(): void {
        for (const cb of this._onMoveStartCallbacks) {
            try {
                cb();
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera25D] onMoveStart callback error', err);
                }
            }
        }
    }

    /**
     * 安全触发 onMove 回调集合。
     */
    private _fireMove(): void {
        const state = this._mutable as CameraState;
        for (const cb of this._onMoveCallbacks) {
            try {
                cb(state);
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera25D] onMove callback error', err);
                }
            }
        }
    }

    /**
     * 安全触发 onMoveEnd 回调集合。
     */
    private _fireMoveEnd(): void {
        for (const cb of this._onMoveEndCallbacks) {
            try {
                cb();
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera25D] onMoveEnd callback error', err);
                }
            }
        }
    }

    /**
     * 安全触发高 pitch 回调集合。
     * 当 pitch 首次超过 HIGH_PITCH_THRESHOLD（60°）时触发。
     */
    private _fireHighPitch(): void {
        for (const cb of this._onHighPitchCallbacks) {
            try {
                cb();
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera25D] onHighPitch callback error', err);
                }
            }
        }
    }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建 2.5D 透视相机控制器。
 *
 * 返回的 Camera25D 实例提供：
 * - Web Mercator 投影下的透视渲染矩阵（Reversed-Z）
 * - bearing（方位角）和 pitch（俯仰角）交互支持
 * - 三通道独立惯性衰减（pan / bearing / pitch）
 * - flyTo 弧线动画和 easeTo 缓动动画（含 bearing/pitch 插值）
 * - resetNorth / resetNorthPitch / snapToNorth 旋转复位动画
 * - 锚点缩放（以光标位置为中心缩放）
 * - 射线-平面相交的 screenToLngLat（高 pitch 兼容）
 * - 地平线 Y 计算
 * - 视口级地理包围盒约束
 *
 * @param options - 初始化选项
 * @returns Camera25D 实例
 *
 * @stability stable
 *
 * @example
 * const cam = createCamera25D({
 *   center: [116.39, 39.91],
 *   zoom: 10,
 *   bearing: 0,
 *   pitch: Math.PI / 6,
 *   maxBounds: { west: 70, south: 10, east: 140, north: 55 },
 * });
 *
 * // 每帧更新
 * function frame(dt: number) {
 *   const state = cam.update(dt, viewport);
 *   // 使用 state.vpMatrix 渲染
 * }
 *
 * // 交互
 * canvas.addEventListener('pointerdown', (e) => cam.handlePanStart(e.clientX, e.clientY));
 * canvas.addEventListener('pointermove', (e) => cam.handlePanMove(e.clientX, e.clientY));
 * canvas.addEventListener('pointerup', () => cam.handlePanEnd());
 * canvas.addEventListener('wheel', (e) => cam.handleZoom(-e.deltaY * 0.01, e.clientX, e.clientY));
 *
 * // 旋转/倾斜（右键拖拽或双指旋转）
 * cam.handleRotate(bearingDelta, pitchDelta);
 *
 * // 复位
 * await cam.resetNorth().finished;
 * await cam.resetNorthPitch().finished;
 * cam.snapToNorth();
 *
 * @example
 * // 飞行到上海并倾斜视角
 * const anim = cam.flyTo({
 *   center: [121.47, 31.23],
 *   zoom: 14,
 *   bearing: Math.PI / 4,
 *   pitch: Math.PI / 4,
 *   duration: 3000,
 * });
 * await anim.finished;
 */
export function createCamera25D(options?: Camera25DOptions): Camera25D {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        if (options) {
            if (options.center) {
                if (!Array.isArray(options.center) || options.center.length < 2) {
                    console.warn('[Camera25D] createCamera25D: center should be [lon, lat]');
                }
            }
            if (options.zoom !== undefined && !Number.isFinite(options.zoom)) {
                console.warn('[Camera25D] createCamera25D: zoom should be a finite number');
            }
            if (options.minZoom !== undefined && options.maxZoom !== undefined) {
                if (options.minZoom > options.maxZoom) {
                    console.warn('[Camera25D] createCamera25D: minZoom > maxZoom, will be auto-swapped');
                }
            }
            if (options.pitch !== undefined && options.pitch < 0) {
                console.warn('[Camera25D] createCamera25D: pitch should be >= 0');
            }
            if (options.fov !== undefined && (options.fov <= 0 || options.fov >= Math.PI)) {
                console.warn('[Camera25D] createCamera25D: fov should be in (0, π)');
            }
        }
    }
    return new Camera25DImpl(options);
}
