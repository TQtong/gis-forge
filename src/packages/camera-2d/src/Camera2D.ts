// ============================================================
// packages/camera-2d/src/Camera2D.ts
// 2D 正交相机实现 — Web Mercator (EPSG:3857) 像素空间
// 层级：Camera 实现包（被 L3 CameraController / L6 Map2D 引用）
//
// 功能概览：
// - Web Mercator 像素坐标空间的视图/投影矩阵计算
// - Reversed-Z 正交投影（depthCompare:'greater', clear 0.0）
// - 惯性平移（环形缓冲区速度采样 + 指数衰减）
// - flyTo 弧线动画（鸟瞰弧：中间缩小 peakZoom）
// - easeTo 线性插值动画（缓入缓出三次曲线）
// - 锚点缩放（以光标位置为缩放中心）
// - 屏幕坐标 ↔ 经纬度双向转换
// - 约束执行（缩放范围 + 地理包围盒视口级约束）
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
 * 默认惯性衰减系数（每帧乘性衰减，归一化到 60fps）。
 * 值域 (0, 1)：越接近 1 滑行越远；0.85 提供中等惯性手感。
 * 实际衰减 = decay^(dt * 60)，确保不同帧率下表现一致。
 */
const DEFAULT_INERTIA_DECAY: number = 0.85;

/**
 * 惯性采样环形缓冲区容量（帧数）。
 * 过小导致速度估计不稳定，过大导致旧样本权重过高。
 * 5 帧在 60fps 下约覆盖最近 83ms 的拖拽轨迹。
 */
const DEFAULT_INERTIA_SAMPLE_FRAMES: number = 5;

/**
 * 惯性最大速度上限（像素/秒）。
 * 防止极端快速拖拽产生过大的惯性速度导致地图飞出可视范围。
 * 4000 px/s 在标准 DPI 下约为屏幕宽度的 2-4 倍每秒。
 */
const DEFAULT_MAX_INERTIA_VELOCITY: number = 4000;

/**
 * 惯性速度停止阈值（像素/秒）。
 * 当惯性速度衰减至此值以下时，完全停止惯性运动。
 * 过低会导致长时间微小抖动，1.0 在视觉上已不可感知。
 */
const INERTIA_VELOCITY_THRESHOLD: number = 1.0;

/**
 * 惯性采样最小时间跨度（毫秒）。
 * 若样本时间跨度过短，速度估计将因除数过小而不稳定。
 * 10ms 是安全下界（单帧 16.7ms@60fps > 10ms）。
 */
const INERTIA_MIN_DURATION_MS: number = 10;

/**
 * 惯性最小触发速度（像素/秒）。
 * 低于此速度的拖拽结束不触发惯性，直接停止。
 * 50 px/s 约为每秒 3mm 屏幕位移，是可感知运动的下界。
 */
const INERTIA_MIN_SPEED: number = 50;

/** 默认 flyTo 动画时长（毫秒）。1500ms 提供流畅但不拖沓的飞行体验 */
const DEFAULT_FLY_DURATION_MS: number = 1500;

/** 默认 easeTo 动画时长（毫秒）。500ms 提供快速平滑过渡 */
const DEFAULT_EASE_DURATION_MS: number = 500;

/** 极小值阈值，用于浮点零判断（避免 === 0 的精度陷阱） */
const EPSILON: number = 1e-10;

/** 视口最小合法边长（像素），防止零宽/高导致除零 */
const MIN_VIEWPORT_DIM: number = 1;

/** 2D 模式固定俯仰角（弧度），正俯视 */
const FIXED_2D_PITCH: number = 0;

/** 2D 模式固定方位角（弧度），正北向 */
const FIXED_2D_BEARING: number = 0;

/** 2D 模式固定翻滚角（弧度），无翻滚 */
const FIXED_2D_ROLL: number = 0;

/**
 * 2D 正交模式下的默认视场角（弧度）。
 * 正交投影本身不使用 FOV，但 CameraState.fov 字段需要填充。
 * π/4 = 45° 是透视模式的标准默认值，保持一致性。
 */
const DEFAULT_FOV: number = Math.PI / 4;

/**
 * 最小动画时长（毫秒），防止除零或帧跳过。
 * 16ms ≈ 1 帧@60fps，保证至少渲染 1 帧过渡。
 */
const MIN_ANIM_DURATION_MS: number = 16;

/**
 * 缩放灵敏度系数。
 * 将原始 delta 值（通常为 ±100/±120 的滚轮像素值）
 * 转换为缩放级别变化量。0.01 使每 100px 滚动 ≈ ±1 zoom 级别。
 */
const ZOOM_DELTA_SENSITIVITY: number = 0.01;

// ============================================================
// 内部类型定义
// ============================================================

/**
 * 惯性采样点，记录单次 panMove 的位移和时间戳。
 * 存储在环形缓冲区中，用于在 panEnd 时估算平均速度。
 *
 * @example
 * const sample: InertiaSample = { dx: -5.2, dy: 3.1, time: 1234.5 };
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
 * 由 Camera2DImpl 持有，每帧在 update() 中推进。
 */
interface AnimationInternal {
    /** 动画唯一标识符 */
    readonly id: string;
    /** 动画类型：'fly' = 弧线飞行（中间缩小），'ease' = 线性缓动 */
    readonly kind: 'fly' | 'ease';
    /** 起始中心 [lon, lat]（度） */
    readonly fromCenter: [number, number];
    /** 目标中心 [lon, lat]（度） */
    readonly toCenter: [number, number];
    /** 起始缩放级别 */
    readonly fromZoom: number;
    /** 目标缩放级别 */
    readonly toZoom: number;
    /**
     * flyTo 弧线的最低缩放级别（鸟瞰时的缩小程度）。
     * 对 easeTo 动画此值等于 fromZoom（不使用）。
     */
    readonly peakZoom: number;
    /** 动画总时长（毫秒） */
    readonly durationMs: number;
    /** 缓动函数：将线性时间 t∈[0,1] 映射到缓动时间 */
    readonly easing: (t: number) => number;
    /** 动画开始时间戳（performance.now() 毫秒） */
    readonly startMs: number;
    /** 对外暴露的动画句柄（可取消、可 await） */
    readonly handle: AnimationHandle;
}

/**
 * CameraAnimation 的内部可变实现。
 * _state 可被内部代码修改，对外通过 getter 只读暴露。
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
 * Camera2D 构造选项。
 * 控制 2D 正交相机的初始状态、约束参数和惯性行为。
 *
 * @example
 * const options: Camera2DOptions = {
 *   center: [116.39, 39.91],
 *   zoom: 10,
 *   minZoom: 3,
 *   maxZoom: 18,
 *   maxBounds: { west: 70, south: 10, east: 140, north: 55 },
 *   inertia: true,
 *   inertiaDecay: 0.85,
 *   inertiaSampleFrames: 5,
 * };
 */
export interface Camera2DOptions {
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
     * 默认值：4（大洲级别）。
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
     * 最小俯仰角（弧度）。
     * 2D 模式下固定为 0，此选项仅为兼容 CameraConstraints 接口。
     * 默认值：0。
     */
    readonly minPitch?: number;

    /**
     * 最大俯仰角（弧度）。
     * 2D 模式下固定为 0，此选项仅为兼容 CameraConstraints 接口。
     * 默认值：0。
     */
    readonly maxPitch?: number;

    /**
     * 可选地理包围盒约束。
     * 设置后，相机视口将被限制在此范围内（视口级约束，非仅中心点）。
     * 单位：度。west/south 为最小值，east/north 为最大值。
     */
    readonly maxBounds?: BBox2D;

    /**
     * 是否启用惯性平移。
     * 开启时，松手后地图将以拖拽速度惯性滑行并逐渐减速。
     * 默认值：true。
     */
    readonly inertia?: boolean;

    /**
     * 惯性衰减系数（归一化到 60fps 的每帧乘性因子）。
     * 范围 (0, 1)：越接近 1 滑行距离越长。
     * 实际衰减 = decay^(deltaTime * 60)。
     * 默认值：0.85。
     */
    readonly inertiaDecay?: number;

    /**
     * 惯性采样缓冲区容量（帧数）。
     * 控制用于估算拖拽速度的最近样本数量。
     * 范围 [2, 30]，默认值：5。
     */
    readonly inertiaSampleFrames?: number;
}

/**
 * 2D 正交相机接口。
 * 扩展 {@link CameraController} 基础接口，增加 2D 专用的坐标转换、
 * 可见范围查询和细粒度状态查询方法。
 *
 * bearing、pitch、roll 在 2D 模式下固定为 0。
 * setBearing / setPitch / handleRotate 为 no-op（静默忽略）。
 *
 * @example
 * const cam = createCamera2D({ center: [116.39, 39.91], zoom: 12 });
 * cam.setZoom(14);
 * const state = cam.update(1/60, viewport);
 * const bounds = cam.getVisibleBounds();
 */
export interface Camera2D extends CameraController {
    /** 类型标识，始终为 '2d' */
    readonly type: '2d';

    /**
     * 惯性是否正在运行（松手后的减速滑行阶段）。
     * 不包含手势平移阶段（isPanning）和主动画阶段（isAnimating）。
     */
    readonly isInertiaActive: boolean;

    /**
     * 用户是否正在进行手势平移（handlePanStart → handlePanEnd 之间）。
     */
    readonly isPanning: boolean;

    /**
     * 相机是否处于任何运动状态。
     * isMoving = isPanning || isInertiaActive || isAnimating。
     * 可用于决定是否需要持续渲染（非运动时可降频）。
     */
    readonly isMoving: boolean;

    /**
     * 获取当前视口可见的地理范围。
     * 通过反投影四个屏幕角计算经纬度包围盒。
     *
     * @returns 可见范围的经纬度包围盒
     *
     * @example
     * const bounds = cam.getVisibleBounds();
     * console.log(`West: ${bounds.west}, East: ${bounds.east}`);
     */
    getVisibleBounds(): BBox2D;

    /**
     * 将屏幕坐标转换为经纬度。
     * 屏幕坐标原点在视口左上角，X 向右，Y 向下（CSS 像素）。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @returns [经度, 纬度]（度），若转换失败则返回 null
     *
     * @example
     * const lngLat = cam.screenToLngLat(400, 300);
     * if (lngLat) console.log(`Lon: ${lngLat[0]}, Lat: ${lngLat[1]}`);
     */
    screenToLngLat(screenX: number, screenY: number): [number, number] | null;

    /**
     * 将经纬度转换为屏幕坐标。
     * 返回的屏幕坐标原点在视口左上角，X 向右，Y 向下。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns [screenX, screenY]（CSS 像素）
     *
     * @example
     * const [sx, sy] = cam.lngLatToScreen(116.39, 39.91);
     */
    lngLatToScreen(lon: number, lat: number): [number, number];

    /**
     * 以锚点为中心缩放：锚点屏幕位置对应的地理坐标在缩放前后保持不变（Web Mercator 米空间）。
     *
     * @param anchorScreenX - 锚点屏幕 X（CSS 像素，左上角原点）
     * @param anchorScreenY - 锚点屏幕 Y（CSS 像素）
     * @param anchorLngLat - 锚点处的 [经度, 纬度]（度），须与当前视图一致
     * @param newZoom - 目标缩放级别（会钳制到 [minZoom, maxZoom]）
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
// 这些缓冲区仅在函数调用内部使用，不跨帧持有引用。
// ============================================================

/** lookAt 计算用：相机眼位置 [x, y, z] */
const _eye = vec3.create();

/** lookAt 计算用：注视目标位置 [x, y, z] */
const _target = vec3.create();

/** lookAt 计算用：上方向向量 [0, 1, 0] */
const _up = vec3.create(0, 1, 0);

/** 通用 3D 临时向量（transformMat4 等用） */
const _tempVec3 = vec3.create();

/** Mercator 像素坐标临时缓冲区 A（Float64 双精度） */
const _pxA: Float64Array = new Float64Array(2);

/** Mercator 像素坐标临时缓冲区 B（Float64 双精度） */
const _pxB: Float64Array = new Float64Array(2);

/** 经纬度输出临时缓冲区（Float64 双精度） */
const _llOut: Float64Array = new Float64Array(2);

/** Mercator 米制坐标输出临时缓冲区（position 字段用） */
const _mercOut: Float64Array = new Float64Array(2);

// ============================================================
// 工具函数
// ============================================================

/**
 * 缓入缓出三次曲线（Ease-In-Out Cubic）。
 * 前半段加速（4t³），后半段减速（1 - (-2t+2)³/2）。
 * 在 t=0 和 t=1 处斜率为 0，在 t=0.5 处斜率最大。
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
    // 前半段使用 4t³ 公式（加速）
    // 后半段使用 1 - (-2t+2)³/2 公式（减速）
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
 * clamp(-5, 0, 10); // → 0
 * clamp(NaN, 0, 10); // → 0
 */
function clamp(v: number, lo: number, hi: number): number {
    // 非有限值保护：NaN、Infinity 等回退为 0
    if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        return 0;
    }
    // 若 lo > hi 自动修正，避免约束反转导致异常
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
    // a + (b-a)*t 形式保证端点精确（相比 a*(1-t)+b*t 更稳定）
    return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 获取当前高精度时间戳（毫秒）。
 * 优先使用 performance.now()（微秒精度），退化到 Date.now()。
 *
 * @returns 时间戳（毫秒）
 *
 * @example
 * const t = now(); // 1234567.89
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
 * const id = generateAnimationId(); // 'a1b2c3d4-...' 或 'cam2d-anim-...'
 */
function generateAnimationId(): string {
    // 优先 UUID v4，避免并发动画 ID 冲突
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // 受限环境（部分 Worker、iframe 沙箱）可能抛错
    }
    // 退化路径：时间戳 + 随机片段（非密码安全，仅用于调试标识）
    return `cam2d-anim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 检查视口是否具有有限的正尺寸。
 * 零宽/零高视口会导致矩阵除零，必须在构建矩阵前校验。
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
 * 内部持有 _state 和 _resolve 用于状态管理。
 *
 * @param id - 动画唯一 ID
 * @param cancelFn - 取消时执行的回调（清理内部动画引用）
 * @returns 可取消、可 await 的动画句柄
 *
 * @example
 * const handle = createAnimHandle('id-1', () => { currentAnim = null; });
 * handle.cancel(); // 立即取消
 * await handle.finished; // 等待完成或取消
 */
function createAnimHandle(id: string, cancelFn: () => void): AnimationHandle {
    let resolved = false;
    let resolveFn: (() => void) | undefined;
    // Promise 在创建时立即捕获 resolve 函数供后续调用
    const finished = new Promise<void>((resolve) => {
        resolveFn = resolve;
    });

    const handle: AnimationHandle = {
        id,
        _state: 'running',
        // 通过 getter 暴露只读状态
        get state() {
            return handle._state;
        },
        cancel: () => {
            // 幂等：已完成/已取消的动画再次 cancel 无效
            if (handle._state !== 'running') {
                return;
            }
            handle._state = 'cancelled';
            // 安全执行取消回调，防止异常传播到调用方
            try {
                cancelFn();
            } catch (err) {
                if (typeof __DEV__ !== 'undefined' && __DEV__) {
                    console.error('[Camera2D] animation cancel callback error', err);
                }
            }
            // resolve Promise 使 await handle.finished 继续
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
 * 将动画标记为「已完成」并 resolve 其 finished Promise。
 * 仅对 'running' 状态的动画生效。
 *
 * @param handle - 内部动画句柄
 *
 * @example
 * finishAnimHandle(anim.handle); // 动画自然结束
 */
function finishAnimHandle(handle: AnimationHandle): void {
    if (handle._state !== 'running') {
        return;
    }
    handle._state = 'finished';
    // resolve Promise 通知 await 方
    handle._resolve?.();
}

/**
 * 根据缩放级别和纬度计算等效相机海拔（米）。
 * 公式：altitude = C / (2^zoom × tileSize × cos(latRad))
 * cos(lat) 修正墨卡托投影在高纬度的面积畸变。
 *
 * @param zoom - 缩放级别
 * @param latDeg - 纬度（度）
 * @returns 海拔（米），始终为正有限值
 *
 * @example
 * altitudeFromZoom(10, 0);   // ≈ 78271 米（赤道）
 * altitudeFromZoom(10, 60);  // ≈ 156543 米（60°N，墨卡托畸变）
 */
function altitudeFromZoom(zoom: number, latDeg: number): number {
    const z = Math.max(0, zoom);
    // cos(lat) 修正项：高纬度地区同一 zoom 覆盖更小的地面范围
    const latRad = clampLatitude(latDeg) * (Math.PI / 180);
    const cosLat = Math.max(Math.cos(latRad), EPSILON);
    // 分母 = 世界像素尺寸 × cos(lat)
    const denom = Math.pow(2, z) * TILE_SIZE * cosLat;
    // 防止极端 zoom 下分母为零
    const safeDenom = Math.max(denom, EPSILON);
    return EARTH_CIRCUMFERENCE / safeDenom;
}

// ============================================================
// Camera2DImpl — 2D 正交相机完整实现
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

/**
 * Camera2D 的私有实现类。
 * 通过 createCamera2D 工厂函数实例化，对外暴露 Camera2D 接口。
 */
class Camera2DImpl implements Camera2D {
    // ==================== 固定属性 ====================

    /** 相机类型标识：2D 正交 */
    readonly type: '2d' = '2d';

    // ==================== 内部状态 ====================

    /** 预分配的可变状态（矩阵缓冲区复用） */
    private readonly _mutable: MutableCameraState;

    /** 中心经度（度） */
    private _cx: number;

    /** 中心纬度（度） */
    private _cy: number;

    /** 连续缩放级别 */
    private _zoom: number;

    /** 约束配置 */
    private _constraints: CameraConstraints;

    /** 是否启用惯性 */
    private _inertiaEnabled: boolean;

    /** 惯性衰减系数（归一化到 60fps） */
    private _inertiaDecay: number;

    /** 惯性 X 速度（Mercator 像素/秒），正值 = 中心向东 */
    private _inertiaVelX: number = 0;

    /** 惯性 Y 速度（Mercator 像素/秒），正值 = 中心向南 */
    private _inertiaVelY: number = 0;

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

    /** 当前活动动画（flyTo / easeTo），同一时间最多一个 */
    private _animation: AnimationInternal | null = null;

    // ==================== 事件订阅 ====================

    /** 移动开始回调集合 */
    private readonly _onMoveStartCallbacks: Set<() => void> = new Set();

    /** 移动中回调集合 */
    private readonly _onMoveCallbacks: Set<(state: CameraState) => void> = new Set();

    /** 移动结束回调集合 */
    private readonly _onMoveEndCallbacks: Set<() => void> = new Set();

    // ==================== 缓存与标记 ====================

    /** 销毁标记：销毁后所有操作抛错 */
    private _destroyed: boolean = false;

    /** 缓存的视口宽度（CSS 像素），供 handlePanMove/handleZoom 使用 */
    private _lastViewportWidth: number = 1024;

    /** 缓存的视口高度（CSS 像素） */
    private _lastViewportHeight: number = 768;

    /** 上一帧是否处于 isMoving 状态（用于检测 move 起止边沿） */
    private _wasMoving: boolean = false;

    /** 上一帧是否有过至少一次 update 调用（矩阵是否已初始化） */
    private _hasUpdated: boolean = false;

    // ==================== 构造函数 ====================

    /**
     * 构造 Camera2D 实例。
     * 初始化中心、缩放、约束、惯性参数和预分配缓冲区。
     *
     * @param options - 初始化选项，全部可选
     */
    constructor(options?: Camera2DOptions) {
        // 初始化可变状态：预分配所有 Float32Array 矩阵和向量
        this._mutable = {
            center: [0, 0],
            zoom: DEFAULT_MIN_ZOOM,
            bearing: FIXED_2D_BEARING,
            pitch: FIXED_2D_PITCH,
            roll: FIXED_2D_ROLL,
            viewMatrix: mat4.create(),
            projectionMatrix: mat4.create(),
            vpMatrix: mat4.create(),
            inverseVPMatrix: mat4.create(),
            position: new Float32Array(3),
            altitude: 0,
            fov: DEFAULT_FOV,
        };

        // 初始化中心坐标
        const initCenter = options?.center ?? [0, 0];
        this._cx = Number.isFinite(initCenter[0]) ? initCenter[0] : 0;
        this._cy = Number.isFinite(initCenter[1]) ? initCenter[1] : 0;

        // 初始化约束
        const minZ = options?.minZoom ?? DEFAULT_MIN_ZOOM;
        const maxZ = options?.maxZoom ?? DEFAULT_MAX_ZOOM;
        this._constraints = {
            minZoom: Math.min(minZ, maxZ),
            maxZoom: Math.max(minZ, maxZ),
            minPitch: options?.minPitch ?? 0,
            maxPitch: options?.maxPitch ?? 0,
            maxBounds: options?.maxBounds,
        };

        // 初始化缩放（钳制到约束范围）
        this._zoom = clamp(
            options?.zoom ?? 4,
            this._constraints.minZoom,
            this._constraints.maxZoom,
        );

        // 惯性配置
        this._inertiaEnabled = options?.inertia ?? true;
        this._inertiaDecay = clamp(options?.inertiaDecay ?? DEFAULT_INERTIA_DECAY, 0, 0.9999);

        // 惯性环形缓冲区：预分配固定容量，避免运行时 new
        const capacity = clamp(
            options?.inertiaSampleFrames ?? DEFAULT_INERTIA_SAMPLE_FRAMES,
            2,
            30,
        );
        this._inertiaSamples = new Array(capacity);
        for (let i = 0; i < capacity; i++) {
            // 预填充对象，避免后续写入时创建新对象
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
     * 是否存在正在运行的飞行/缓动动画。
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
     * 惯性是否正在运行（松手后的减速滑行阶段）。
     *
     * @stability stable
     */
    get isInertiaActive(): boolean {
        // 非平移状态下有非零速度即为惯性活跃
        return !this._panning && (
            Math.abs(this._inertiaVelX) > INERTIA_VELOCITY_THRESHOLD ||
            Math.abs(this._inertiaVelY) > INERTIA_VELOCITY_THRESHOLD
        );
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
     * 相机是否处于任何运动状态（平移/惯性/动画）。
     *
     * @stability stable
     */
    get isMoving(): boolean {
        return this._panning || this.isInertiaActive || this.isAnimating;
    }

    // ==================== 状态设置方法 ====================

    /**
     * 设置地图中心 [经度, 纬度]（度）。
     * 自动应用地理约束。不影响缩放级别。
     *
     * @param center - [经度, 纬度]，度
     *
     * @example
     * cam.setCenter([116.39, 39.91]); // 跳转到北京
     */
    setCenter(center: [number, number]): void {
        this._checkDestroyed();
        if (__DEV__) {
            if (!Array.isArray(center) || center.length < 2) {
                console.warn('[Camera2D] setCenter: invalid center array');
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
     * 设置缩放级别。自动钳制到 [minZoom, maxZoom] 范围。
     *
     * @param zoom - 连续缩放级别
     *
     * @example
     * cam.setZoom(14.5);
     */
    setZoom(zoom: number): void {
        this._checkDestroyed();
        if (!Number.isFinite(zoom)) {
            if (__DEV__) {
                console.warn('[Camera2D] setZoom: non-finite zoom ignored');
            }
            return;
        }
        this._zoom = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
    }

    /**
     * 设置方位角（弧度）。
     * **2D 模式下为 no-op**：bearing 固定为 0（正北向）。
     *
     * @param _bearing - 忽略的方位角参数
     */
    setBearing(_bearing: number): void {
        this._checkDestroyed();
        // 2D 模式不支持旋转，静默忽略以避免调用方误用时崩溃
    }

    /**
     * 设置俯仰角（弧度）。
     * **2D 模式下为 no-op**：pitch 固定为 0（正俯视）。
     *
     * @param _pitch - 忽略的俯仰角参数
     */
    setPitch(_pitch: number): void {
        this._checkDestroyed();
        // 2D 模式不支持倾斜，静默忽略
    }

    // ==================== 跳转与动画 ====================

    /**
     * 瞬间跳转到指定状态（无动画过渡）。
     * 会停止当前所有动画和惯性。
     *
     * @param options - 跳转参数，未指定的属性保持当前值
     *
     * @example
     * cam.jumpTo({ center: [116.39, 39.91], zoom: 14 });
     */
    jumpTo(options: {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
    }): void {
        this._checkDestroyed();
        // 停止所有进行中的运动
        this.stop();
        this._killInertia();

        // 应用中心坐标
        if (options.center) {
            const [cx, cy] = this._constrainCenter(
                Number.isFinite(options.center[0]) ? options.center[0] : this._cx,
                Number.isFinite(options.center[1]) ? options.center[1] : this._cy,
            );
            this._cx = cx;
            this._cy = cy;
        }
        // 应用缩放（bearing/pitch 在 2D 下忽略）
        if (options.zoom !== undefined && Number.isFinite(options.zoom)) {
            this._zoom = clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom);
        }
    }

    /**
     * 执行弧线飞行动画（bird's-eye arc）。
     * 中间阶段先缩小（zoom out）以获得鸟瞰视角，然后缩放到目标级别。
     * 距离越远，中间缩小程度越大。
     *
     * @param options - 飞行参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @example
     * const anim = cam.flyTo({ center: [121.47, 31.23], zoom: 12, duration: 2000 });
     * await anim.finished; // 等待飞行完成
     *
     * @example
     * const anim = cam.flyTo({ center: [0, 0] });
     * anim.cancel(); // 中途取消
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
        // 停止之前的动画和惯性
        this.stop();
        this._killInertia();

        // 解析目标参数
        const durationMs = Math.max(
            MIN_ANIM_DURATION_MS,
            options.duration ?? DEFAULT_FLY_DURATION_MS,
        );
        const easing = options.easing ?? easeInOutCubic;
        const toZoom = options.zoom !== undefined
            ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom)
            : this._zoom;
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

        // 计算 peakZoom（弧线最低缩放级别）
        // 基于起止点的 Mercator 像素距离与屏幕对角线的比值
        const refZoom = Math.min(this._zoom, toZoom);
        lngLatToPixel(_pxA, this._cx, this._cy, refZoom);
        lngLatToPixel(_pxB, toX, toY, refZoom);
        const dxPx = _pxB[0] - _pxA[0];
        const dyPx = _pxB[1] - _pxA[1];
        const mercDist = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        const screenDiag = Math.sqrt(vpW * vpW + vpH * vpH);

        // 距离/屏幕对角线比值越大 → peakZoom 越小（缩得越远）
        // log2(ratio) 使缩放程度与距离呈对数关系（远距离不过度缩小）
        let peakZoom: number;
        if (mercDist < 1) {
            // 起止点几乎重合，无需弧线，退化为 easeTo
            peakZoom = refZoom;
        } else {
            const ratio = Math.max(mercDist / Math.max(screenDiag, 1), 1);
            peakZoom = refZoom - Math.log2(ratio) - 1;
            // 钳制到合法范围
            peakZoom = Math.max(peakZoom, this._constraints.minZoom);
            peakZoom = Math.min(peakZoom, refZoom);
        }

        // 创建动画句柄
        const id = generateAnimationId();
        const handle = createAnimHandle(id, () => {
            // cancel 回调：清除内部动画引用
            if (this._animation && this._animation.id === id) {
                this._animation = null;
            }
        });

        // 创建内部动画描述
        this._animation = {
            id,
            kind: 'fly',
            fromCenter: [this._cx, this._cy],
            toCenter: [toX, toY],
            fromZoom: this._zoom,
            toZoom,
            peakZoom,
            durationMs,
            easing,
            startMs: now(),
            handle,
        };

        return handle;
    }

    /**
     * 执行线性缓动动画（easeTo）。
     * 中心和缩放同时线性插值，使用三次缓入缓出曲线。
     *
     * @param options - 缓动参数
     * @returns 可取消、可 await 的动画句柄
     *
     * @example
     * const anim = cam.easeTo({ zoom: 16, duration: 800 });
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
        this._killInertia();

        const durationMs = Math.max(
            MIN_ANIM_DURATION_MS,
            options.duration ?? DEFAULT_EASE_DURATION_MS,
        );
        const toZoom = options.zoom !== undefined
            ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom)
            : this._zoom;
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

        // easeTo 不使用 peakZoom 弧线，设为 fromZoom（不影响插值）
        this._animation = {
            id,
            kind: 'ease',
            fromCenter: [this._cx, this._cy],
            toCenter: [toX, toY],
            fromZoom: this._zoom,
            toZoom,
            peakZoom: this._zoom,
            durationMs,
            easing: easeInOutCubic,
            startMs: now(),
            handle,
        };

        return handle;
    }

    /**
     * 停止所有活动动画。
     * 动画句柄的 state 变为 'cancelled'，finished Promise resolve。
     * 不影响惯性（惯性由 panEnd 触发，自行衰减至停止）。
     *
     * @example
     * cam.stop(); // 立即停止飞行
     */
    stop(): void {
        if (this._animation) {
            const h = this._animation.handle;
            this._animation = null;
            // cancel 会调用 handle.cancel() 内的 cancelFn，但此时 _animation 已为 null
            h.cancel();
        }
    }

    // ==================== 约束与惯性配置 ====================

    /**
     * 合并更新约束。未指定的字段保持当前值。
     * 更新后立即钳制当前缩放和中心到新约束范围内。
     *
     * @param constraints - 部分约束更新
     *
     * @example
     * cam.setConstraints({ minZoom: 5, maxBounds: { west: 70, south: 10, east: 140, north: 55 } });
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

        // 自动修正 min > max 的情况
        if (next.minZoom > next.maxZoom) {
            const nextMut = next as { minZoom: number; maxZoom: number };
            const tmp = nextMut.minZoom;
            nextMut.minZoom = nextMut.maxZoom;
            nextMut.maxZoom = tmp;
        }

        this._constraints = next;

        // 立即钳制当前状态到新约束
        this._zoom = clamp(this._zoom, next.minZoom, next.maxZoom);
        const [cx, cy] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx;
        this._cy = cy;
    }

    /**
     * 启用或禁用惯性。禁用时立即清零惯性速度。
     *
     * @param enabled - 是否启用惯性
     *
     * @example
     * cam.setInertiaEnabled(false); // 关闭惯性，松手即停
     */
    setInertiaEnabled(enabled: boolean): void {
        this._checkDestroyed();
        this._inertiaEnabled = enabled;
        if (!enabled) {
            this._killInertia();
        }
    }

    // ==================== 核心帧更新 ====================

    /**
     * 每帧更新：推进动画/惯性、重建变换矩阵、触发回调。
     * 由 FrameScheduler 在 UPDATE 阶段调用，每帧恰好一次。
     *
     * 矩阵计算流程：
     * 1. lngLatToPixel(center, zoom) → Mercator 像素坐标 [cx, cy]
     * 2. lookAt(eye=[cx, cy, 1], target=[cx, cy, 0], up=[0,1,0]) → viewMatrix
     * 3. ortho(-halfW, halfW, halfH, -halfH, -1, 1) → projMatrix（Reversed-Z + Y翻转）
     * 4. VP = projMatrix × viewMatrix
     * 5. inverseVP = invert(VP)
     * 6. altitude = C / (2^zoom × tileSize × cos(lat))
     *
     * @param deltaTime - 距上一帧的时间差（秒）。非正值视为 0
     * @param viewport - 当前视口尺寸
     * @returns 更新后的 CameraState 快照
     *
     * @example
     * const state = cam.update(1/60, { width: 1920, height: 1080, ... });
     */
    update(deltaTime: number, viewport: Viewport): CameraState {
        this._checkDestroyed();

        // 安全化 deltaTime：非有限值或负值归零
        const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;

        // 缓存视口尺寸供 handlePanMove/handleZoom 使用
        this._lastViewportWidth = Math.max(viewport.width, MIN_VIEWPORT_DIM);
        this._lastViewportHeight = Math.max(viewport.height, MIN_VIEWPORT_DIM);

        // ===== 阶段 1：推进动画或惯性 =====

        if (this._animation) {
            // 飞行/缓动动画正在进行
            this._advanceAnimation();
        } else if (this._inertiaEnabled && !this._panning && this.isInertiaActive) {
            // 惯性滑行阶段
            this._advanceInertia(dt);
        }

        // ===== 阶段 2：应用约束 =====

        this._zoom = clamp(this._zoom, this._constraints.minZoom, this._constraints.maxZoom);
        const [cx, cy] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx;
        this._cy = cy;

        // ===== 阶段 3：构建变换矩阵 =====

        this._rebuildMatrices(viewport);

        // ===== 阶段 4：检测 move 状态转变并触发回调 =====

        const currentlyMoving = this.isMoving;
        if (currentlyMoving && !this._wasMoving) {
            // 从静止进入运动：触发 onMoveStart
            this._fireMoveStart();
        }
        if (currentlyMoving) {
            // 运动中：触发 onMove
            this._fireMove();
        }
        if (!currentlyMoving && this._wasMoving) {
            // 从运动进入静止：触发 onMoveEnd
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
     * @example
     * canvas.addEventListener('pointerdown', (e) => cam.handlePanStart(e.clientX, e.clientY));
     */
    handlePanStart(screenX: number, screenY: number): void {
        this._checkDestroyed();
        // 停止动画（手势优先于动画）
        this.stop();
        // 标记平移状态
        this._panning = true;
        this._panPrevX = screenX;
        this._panPrevY = screenY;
        // 重置惯性速度和缓冲区
        this._killInertia();
        this._inertiaHead = 0;
        this._inertiaCount = 0;
    }

    /**
     * 平移手势移动。计算位移、更新中心、记录惯性样本。
     *
     * 位移映射：屏幕像素与 Mercator 像素 1:1（正交投影，无旋转时）。
     * 拖拽向右 → 地图内容右移 → 中心向左（Mercator X 减小）。
     *
     * @param screenX - 当前屏幕 X（CSS 像素）
     * @param screenY - 当前屏幕 Y（CSS 像素）
     *
     * @example
     * canvas.addEventListener('pointermove', (e) => cam.handlePanMove(e.clientX, e.clientY));
     */
    handlePanMove(screenX: number, screenY: number): void {
        this._checkDestroyed();
        // 未开始平移则忽略
        if (this._panPrevX === null || this._panPrevY === null) {
            return;
        }

        // 计算屏幕像素位移
        const dx = screenX - this._panPrevX;
        const dy = screenY - this._panPrevY;
        this._panPrevX = screenX;
        this._panPrevY = screenY;

        // 零位移跳过计算
        if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
            return;
        }

        // 将中心从 lngLat 转换到 Mercator 像素坐标
        lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);

        // 拖拽位移取反：拖右 → 中心左移（像素 X 减小）
        // Y 轴：拖下 → 中心上移（Mercator Y 减小 = 纬度增大 = 向北）
        _pxA[0] -= dx;
        _pxA[1] -= dy;

        // 转换回 lngLat
        pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
        this._cx = _llOut[0];
        this._cy = _llOut[1];

        // 应用约束
        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;

        // 记录惯性样本（中心在 Mercator 像素空间的位移）
        // 注意：这里记录的是中心的移动方向（与拖拽方向相反）
        this._addInertiaSample(-dx, -dy, now());
    }

    /**
     * 平移手势结束。从惯性缓冲区计算初始速度，开启惯性滑行。
     *
     * @example
     * canvas.addEventListener('pointerup', () => cam.handlePanEnd());
     */
    handlePanEnd(): void {
        this._checkDestroyed();
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;

        // 从环形缓冲区计算惯性速度
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
     * 算法：
     * 1. 计算锚点的 Mercator 像素坐标（旧 zoom）
     * 2. 应用缩放级别变化
     * 3. 缩放后锚点像素坐标 = 旧坐标 × 2^(newZoom - oldZoom)
     * 4. 调整中心使锚点保持在相同屏幕位置
     *
     * @param delta - 缩放量。正值放大（zoom 增加），负值缩小
     * @param screenX - 缩放锚点屏幕 X（CSS 像素）
     * @param screenY - 缩放锚点屏幕 Y（CSS 像素）
     *
     * @example
     * canvas.addEventListener('wheel', (e) => {
     *   cam.handleZoom(-e.deltaY * 0.01, e.clientX, e.clientY);
     * });
     */
    handleZoom(delta: number, screenX: number, screenY: number): void {
        this._checkDestroyed();
        // 非有限或零 delta 跳过
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

        // 无实际缩放变化则跳过
        if (Math.abs(newZoom - oldZoom) < EPSILON) {
            return;
        }

        // 锚点在视口中相对于中心的像素偏移
        const halfW = vpW / 2;
        const halfH = vpH / 2;
        const anchorOffsetX = screenX - halfW;
        const anchorOffsetY = screenY - halfH;

        // 中心在旧 zoom 的 Mercator 像素坐标
        lngLatToPixel(_pxA, this._cx, this._cy, oldZoom);
        const oldCenterPxX = _pxA[0];
        const oldCenterPxY = _pxA[1];

        // 锚点在旧 zoom 的 Mercator 像素坐标
        // 2D 无旋转时：1 屏幕像素 = 1 Mercator 像素
        const anchorPxX = oldCenterPxX + anchorOffsetX;
        const anchorPxY = oldCenterPxY + anchorOffsetY;

        // Mercator 像素坐标随 zoom 线性缩放：pixel(z2) = pixel(z1) × 2^(z2-z1)
        const scaleRatio = Math.pow(2, newZoom - oldZoom);

        // 锚点在新 zoom 的 Mercator 像素坐标
        const newAnchorPxX = anchorPxX * scaleRatio;
        const newAnchorPxY = anchorPxY * scaleRatio;

        // 新中心 = 锚点新位置 - 锚点屏幕偏移（保持锚点不动）
        const newCenterPxX = newAnchorPxX - anchorOffsetX;
        const newCenterPxY = newAnchorPxY - anchorOffsetY;

        // 转换回 lngLat
        pixelToLngLat(_llOut, newCenterPxX, newCenterPxY, newZoom);
        this._zoom = newZoom;
        this._cx = _llOut[0];
        this._cy = _llOut[1];

        // 应用约束
        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;
    }

    /**
     * 以锚点为中心缩放：在墨卡托米坐标下保持锚点地理坐标对应屏幕位置不变。
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
                console.warn('[Camera2D] zoomAround: non-finite arguments ignored');
            }
            return;
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
            if (__DEV__) {
                console.warn('[Camera2D] zoomAround: viewport not ready');
            }
            return;
        }

        const oldZoom = this._zoom;
        const zNew = clamp(newZoom, this._constraints.minZoom, this._constraints.maxZoom);
        if (Math.abs(zNew - oldZoom) < EPSILON) {
            return;
        }

        const scaleFactor = Math.pow(2, zNew - oldZoom);
        if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
            if (__DEV__) {
                console.warn('[Camera2D] zoomAround: invalid scale factor');
            }
            return;
        }

        lngLatToMercator(_pxA, anchorLngLat[0], anchorLngLat[1]);
        lngLatToMercator(_pxB, this._cx, this._cy);
        const anchorMx = _pxA[0];
        const anchorMy = _pxA[1];
        const centerMx = _pxB[0];
        const centerMy = _pxB[1];

        const newCenterMx = anchorMx + (centerMx - anchorMx) / scaleFactor;
        const newCenterMy = anchorMy + (centerMy - anchorMy) / scaleFactor;

        mercatorToLngLat(_llOut, newCenterMx, newCenterMy);
        this._zoom = zNew;
        this._cx = _llOut[0];
        this._cy = _llOut[1];

        const [cx2, cy2] = this._constrainCenter(this._cx, this._cy);
        this._cx = cx2;
        this._cy = cy2;
    }

    /**
     * 旋转手势处理。
     * **2D 模式下为 no-op**：不支持 bearing/pitch 交互。
     *
     * @param _bearingDelta - 忽略的方位角增量
     * @param _pitchDelta - 忽略的俯仰角增量
     */
    handleRotate(_bearingDelta: number, _pitchDelta: number): void {
        this._checkDestroyed();
        // 2D 模式无旋转交互，静默忽略
    }

    // ==================== 坐标转换与查询 ====================

    /**
     * 获取当前视口可见的地理范围。
     * 通过反投影四个屏幕角到 Mercator 像素再转 lngLat 计算。
     *
     * @returns 可见范围的经纬度包围盒 {west, south, east, north}
     *
     * @example
     * const bounds = cam.getVisibleBounds();
     * // 用于按需加载可视区域的瓦片或数据
     */
    getVisibleBounds(): BBox2D {
        // 若尚未调用 update()，矩阵未初始化，返回全球范围
        if (!this._hasUpdated) {
            return { west: -180, south: -MAX_LATITUDE, east: 180, north: MAX_LATITUDE };
        }

        // 反投影四个屏幕角
        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        const tl = this.screenToLngLat(0, 0);
        const tr = this.screenToLngLat(vpW, 0);
        const bl = this.screenToLngLat(0, vpH);
        const br = this.screenToLngLat(vpW, vpH);

        // 若任一角转换失败，返回全球范围
        if (!tl || !tr || !bl || !br) {
            return { west: -180, south: -MAX_LATITUDE, east: 180, north: MAX_LATITUDE };
        }

        // 取四个角的经纬度包围盒
        return {
            west: Math.min(tl[0], tr[0], bl[0], br[0]),
            south: Math.min(tl[1], tr[1], bl[1], br[1]),
            east: Math.max(tl[0], tr[0], bl[0], br[0]),
            north: Math.max(tl[1], tr[1], bl[1], br[1]),
        };
    }

    /**
     * 将屏幕坐标转换为经纬度。
     * 通过 inverseVP 矩阵将 NDC 坐标反投影到 Mercator 像素空间，再转 lngLat。
     *
     * @param screenX - 屏幕 X 坐标（CSS 像素，原点在左上角）
     * @param screenY - 屏幕 Y 坐标（CSS 像素）
     * @returns [经度, 纬度]（度），若矩阵未初始化或参数非法则返回 null
     *
     * @example
     * const lngLat = cam.screenToLngLat(mouseX, mouseY);
     */
    screenToLngLat(screenX: number, screenY: number): [number, number] | null {
        // 参数安全检查
        if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
            return null;
        }
        // 矩阵尚未初始化
        if (!this._hasUpdated) {
            return null;
        }

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;
        if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
            return null;
        }

        // 屏幕坐标 → NDC
        // X: [0, vpW] → [-1, 1]
        // Y: [0, vpH] → [1, -1]（屏幕 Y 向下 → NDC Y 向上）
        const ndcX = (screenX / vpW) * 2 - 1;
        const ndcY = 1 - (screenY / vpH) * 2;

        // 使用 inverseVP 反投影到 Mercator 像素空间
        // z_ndc = 1.0 对应地图平面（Reversed-Z 近平面）
        vec3.set(_tempVec3, ndcX, ndcY, 1.0);
        vec3.transformMat4(_tempVec3, _tempVec3, this._mutable.inverseVPMatrix);

        // _tempVec3 现在包含 Mercator 像素坐标 [wx, wy, wz]
        const worldPxX = _tempVec3[0];
        const worldPxY = _tempVec3[1];

        // 检查反投影结果是否有限
        if (!Number.isFinite(worldPxX) || !Number.isFinite(worldPxY)) {
            return null;
        }

        // Mercator 像素 → lngLat
        pixelToLngLat(_llOut, worldPxX, worldPxY, this._zoom);

        return [_llOut[0], _llOut[1]];
    }

    /**
     * 将经纬度转换为屏幕坐标。
     * 通过 lngLatToPixel 转 Mercator 像素，再用 VP 矩阵投影到 NDC，最后转屏幕坐标。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns [screenX, screenY]（CSS 像素，原点在左上角）
     *
     * @example
     * const [sx, sy] = cam.lngLatToScreen(116.39, 39.91);
     */
    lngLatToScreen(lon: number, lat: number): [number, number] {
        // 经纬度 → Mercator 像素
        lngLatToPixel(_pxA, lon, lat, this._zoom);

        // Mercator 像素 → 裁剪空间（通过 VP 矩阵）
        vec3.set(_tempVec3, _pxA[0], _pxA[1], 0);
        vec3.transformMat4(_tempVec3, _tempVec3, this._mutable.vpMatrix);

        const vpW = this._lastViewportWidth;
        const vpH = this._lastViewportHeight;

        // NDC → 屏幕坐标
        // X: [-1, 1] → [0, vpW]
        // Y: [1, -1] → [0, vpH]（NDC Y 向上 → 屏幕 Y 向下）
        const screenX = (_tempVec3[0] + 1) * 0.5 * vpW;
        const screenY = (1 - _tempVec3[1]) * 0.5 * vpH;

        return [screenX, screenY];
    }

    // ==================== 事件订阅 ====================

    /**
     * 注册移动开始回调。
     * 当相机从静止进入任何运动状态（平移/惯性/动画）时触发。
     *
     * @param callback - 回调函数
     * @returns 取消订阅函数
     *
     * @example
     * const unsub = cam.onMoveStart(() => console.log('started'));
     * unsub(); // 取消订阅
     */
    onMoveStart(callback: () => void): () => void {
        this._onMoveStartCallbacks.add(callback);
        return () => {
            this._onMoveStartCallbacks.delete(callback);
        };
    }

    /**
     * 注册移动中回调。
     * 每帧相机处于运动状态时触发（在矩阵重建后）。
     *
     * @param callback - 回调函数，接收当前 CameraState
     * @returns 取消订阅函数
     *
     * @example
     * cam.onMove((state) => updateUI(state.center));
     */
    onMove(callback: (state: CameraState) => void): () => void {
        this._onMoveCallbacks.add(callback);
        return () => {
            this._onMoveCallbacks.delete(callback);
        };
    }

    /**
     * 注册移动结束回调。
     * 当相机从运动状态进入静止（无平移、无惯性、无动画）时触发。
     *
     * @param callback - 回调函数
     * @returns 取消订阅函数
     *
     * @example
     * cam.onMoveEnd(() => loadHighResData());
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
     * @example
     * cam.destroy();
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        // 停止动画
        this.stop();
        // 清零惯性
        this._killInertia();
        // 清空事件订阅
        this._onMoveStartCallbacks.clear();
        this._onMoveCallbacks.clear();
        this._onMoveEndCallbacks.clear();
        // 重置平移状态
        this._panning = false;
        this._panPrevX = null;
        this._panPrevY = null;
    }

    // ==================== 私有方法 ====================

    /**
     * 检查销毁状态，若已销毁则抛出错误。
     * 所有公共方法的入口守卫。
     */
    private _checkDestroyed(): void {
        if (this._destroyed) {
            throw new Error('[Camera2D] controller has been destroyed; create a new instance');
        }
    }

    /**
     * 将惯性速度清零。
     */
    private _killInertia(): void {
        this._inertiaVelX = 0;
        this._inertiaVelY = 0;
    }

    /**
     * 向惯性环形缓冲区添加一个样本。
     * 复用预分配的对象，不产生 GC 压力。
     *
     * @param dx - Mercator 像素 X 位移
     * @param dy - Mercator 像素 Y 位移
     * @param time - 时间戳（ms）
     */
    private _addInertiaSample(dx: number, dy: number, time: number): void {
        const sample = this._inertiaSamples[this._inertiaHead];
        // 复用已分配的对象，直接修改字段
        sample.dx = dx;
        sample.dy = dy;
        sample.time = time;
        // 环形推进写指针
        this._inertiaHead = (this._inertiaHead + 1) % this._inertiaSamples.length;
        this._inertiaCount = Math.min(this._inertiaCount + 1, this._inertiaSamples.length);
    }

    /**
     * 从环形缓冲区计算惯性初始速度。
     * 使用所有有效样本的总位移 / 总时间跨度 = 平均速度。
     *
     * @returns [vx, vy] 惯性速度（Mercator 像素/秒）
     */
    private _computeInertiaVelocity(): [number, number] {
        // 至少需要 2 个样本才能计算速度
        if (this._inertiaCount < 2) {
            return [0, 0];
        }

        const capacity = this._inertiaSamples.length;

        // 定位最新和最旧样本的索引
        const newestIdx = (this._inertiaHead - 1 + capacity) % capacity;
        const oldestIdx = (this._inertiaHead - this._inertiaCount + capacity) % capacity;

        // 时间跨度检查
        const timeSpanMs = this._inertiaSamples[newestIdx].time - this._inertiaSamples[oldestIdx].time;
        if (timeSpanMs < INERTIA_MIN_DURATION_MS) {
            return [0, 0];
        }

        // 累加所有样本的位移
        let totalDx = 0;
        let totalDy = 0;
        for (let i = 0; i < this._inertiaCount; i++) {
            const idx = (oldestIdx + i) % capacity;
            totalDx += this._inertiaSamples[idx].dx;
            totalDy += this._inertiaSamples[idx].dy;
        }

        // 转换为像素/秒
        const timeSpanSec = timeSpanMs / 1000;
        let vx = totalDx / timeSpanSec;
        let vy = totalDy / timeSpanSec;

        // 速度下限检查：过慢不触发惯性
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed < INERTIA_MIN_SPEED) {
            return [0, 0];
        }

        // 速度上限钳制：防止过快飞出视野
        if (speed > DEFAULT_MAX_INERTIA_VELOCITY) {
            const scale = DEFAULT_MAX_INERTIA_VELOCITY / speed;
            vx *= scale;
            vy *= scale;
        }

        return [vx, vy];
    }

    /**
     * 推进惯性：衰减速度并位移中心。
     *
     * @param dt - 帧时间差（秒）
     */
    private _advanceInertia(dt: number): void {
        // 将中心转换到 Mercator 像素空间
        lngLatToPixel(_pxA, this._cx, this._cy, this._zoom);

        // 应用速度位移：center += velocity × dt
        _pxA[0] += this._inertiaVelX * dt;
        _pxA[1] += this._inertiaVelY * dt;

        // 转换回 lngLat
        pixelToLngLat(_llOut, _pxA[0], _pxA[1], this._zoom);
        this._cx = _llOut[0];
        this._cy = _llOut[1];

        // 指数衰减速度
        // decay^(dt*60) 将衰减归一化到 60fps：无论实际帧率如何，滑行距离一致
        const decay = Math.pow(this._inertiaDecay, dt * 60);
        this._inertiaVelX *= decay;
        this._inertiaVelY *= decay;

        // 速度低于阈值时完全停止，避免长时间微小抖动
        const speed = Math.sqrt(
            this._inertiaVelX * this._inertiaVelX +
            this._inertiaVelY * this._inertiaVelY,
        );
        if (speed < INERTIA_VELOCITY_THRESHOLD) {
            this._killInertia();
        }
    }

    /**
     * 推进飞行/缓动动画。
     * 根据当前时间戳计算归一化进度，应用缓动曲线，插值中心和缩放。
     *
     * flyTo 弧线：前半段从 fromZoom 缩小到 peakZoom，后半段从 peakZoom 放大到 toZoom。
     * easeTo 线性：center 和 zoom 全程线性插值。
     */
    private _advanceAnimation(): void {
        const anim = this._animation;
        if (!anim) {
            return;
        }

        // 计算归一化时间进度
        const elapsed = now() - anim.startMs;
        const tRaw = elapsed / anim.durationMs;
        // 钳制到 [0, 1] 后应用缓动曲线
        const tEased = anim.easing(clamp(tRaw, 0, 1));

        // 插值中心坐标（始终线性于缓动时间）
        this._cx = lerp(anim.fromCenter[0], anim.toCenter[0], tEased);
        this._cy = lerp(anim.fromCenter[1], anim.toCenter[1], tEased);

        // 插值缩放级别
        if (anim.kind === 'fly') {
            // flyTo 弧线：分前后半段插值
            if (tEased < 0.5) {
                // 前半段：fromZoom → peakZoom（zoom out）
                // 使用 tEased * 2 映射 [0, 0.5] → [0, 1]
                this._zoom = lerp(anim.fromZoom, anim.peakZoom, tEased * 2);
            } else {
                // 后半段：peakZoom → toZoom（zoom in）
                // 使用 (tEased - 0.5) * 2 映射 [0.5, 1] → [0, 1]
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
            // 标记完成并清除动画
            finishAnimHandle(anim.handle);
            this._animation = null;
        }
    }

    /**
     * 重建所有变换矩阵。
     * 这是 update() 的核心计算环节，每帧执行一次。
     *
     * 1. lookAt 构建视图矩阵（平移到 Mercator 像素中心）
     * 2. ortho 构建投影矩阵（Reversed-Z + Y 轴翻转）
     * 3. VP = P × V
     * 4. inverseVP = VP^(-1)
     * 5. 填充 altitude / position / fov 等标量字段
     *
     * @param viewport - 当前视口
     */
    private _rebuildMatrices(viewport: Viewport): void {
        const vpOk = isViewportValid(viewport);
        const z = clamp(this._zoom, this._constraints.minZoom, this._constraints.maxZoom);

        if (!vpOk) {
            // 视口无效：保持上一帧矩阵，仅更新标量字段
            mat4.identity(this._mutable.viewMatrix);
            mat4.identity(this._mutable.projectionMatrix);
            mat4.identity(this._mutable.vpMatrix);
            mat4.identity(this._mutable.inverseVPMatrix);
        } else {
            // 将中心 lngLat 转换为 Mercator 像素坐标
            lngLatToPixel(_pxA, this._cx, this._cy, z);
            // Float64 → Float32 截断（zoom < 18 时精度充足）
            const centerPxX = _pxA[0];
            const centerPxY = _pxA[1];

            // 构建视图矩阵：lookAt(eye, target, up)
            // eye 在 Mercator 像素中心上方 z=1 处
            // target 在 Mercator 像素中心 z=0 处
            // up = [0, 1, 0]（世界 Y 轴向上）
            vec3.set(_eye, centerPxX, centerPxY, 1);
            vec3.set(_target, centerPxX, centerPxY, 0);
            vec3.set(_up, 0, 1, 0);
            mat4.lookAt(this._mutable.viewMatrix, _eye, _target, _up);

            // 构建投影矩阵：正交投影
            // halfW/halfH 为视口半尺寸（CSS 像素）
            // bottom = halfH, top = -halfH 实现 Y 轴翻转
            //   → Mercator Y 向下 → 屏幕 Y 向下 → clip Y 向上
            // near = -1, far = 1 在 WebGPU NDC [0,1] 下自然产生 Reversed-Z：
            //   near(-1) → z_ndc = 1.0（最近），far(1) → z_ndc = 0.0（最远）
            const halfW = viewport.width / 2;
            const halfH = viewport.height / 2;
            mat4.ortho(
                this._mutable.projectionMatrix,
                -halfW, halfW,    // left, right
                halfH, -halfH,    // bottom, top（翻转以修正 Y 轴方向）
                -1, 1,            // near, far（Reversed-Z for WebGPU）
            );

            // VP = P × V（列主序右乘向量）
            mat4.multiply(
                this._mutable.vpMatrix,
                this._mutable.projectionMatrix,
                this._mutable.viewMatrix,
            );

            // 计算逆 VP 矩阵（用于屏幕坐标反投影）
            const inv = mat4.invert(this._mutable.inverseVPMatrix, this._mutable.vpMatrix);
            if (inv === null) {
                // VP 矩阵奇异（极端退化情况）：回退为单位矩阵
                mat4.identity(this._mutable.inverseVPMatrix);
                if (__DEV__) {
                    console.warn('[Camera2D] VP matrix is singular, inverseVP fallback to identity');
                }
            }
        }

        // 计算海拔（米）
        const altitude = altitudeFromZoom(z, this._cy);

        // 计算世界坐标系下的相机位置（Mercator 米制坐标）
        lngLatToMercator(_mercOut, this._cx, this._cy);
        // Float64 → Float32 截断写入 position
        this._mutable.position[0] = _mercOut[0];
        this._mutable.position[1] = _mercOut[1];
        this._mutable.position[2] = altitude;

        // 填充标量字段
        this._mutable.center[0] = this._cx;
        this._mutable.center[1] = this._cy;
        this._mutable.zoom = z;
        this._mutable.bearing = FIXED_2D_BEARING;
        this._mutable.pitch = FIXED_2D_PITCH;
        this._mutable.roll = FIXED_2D_ROLL;
        this._mutable.altitude = altitude;
        this._mutable.fov = DEFAULT_FOV;
    }

    /**
     * 约束中心坐标：将中心钳制到合法范围。
     * 若设置了 maxBounds，使用视口级约束（整个视口必须在 bounds 内）。
     * 否则钳制到 Mercator 有效纬度范围。
     *
     * @param lon - 输入经度
     * @param lat - 输入纬度
     * @returns 约束后的 [lon, lat]
     */
    private _constrainCenter(lon: number, lat: number): [number, number] {
        // 非有限值保护
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
            // bounds 非法：回退到默认钳制
            x = clamp(x, -180, 180);
            y = clamp(y, -MAX_LATITUDE, MAX_LATITUDE);
            return [x, y];
        }

        // 视口级约束：整个视口矩形必须在 bounds 像素范围内
        const zoom = this._zoom;
        const halfW = this._lastViewportWidth / 2;
        const halfH = this._lastViewportHeight / 2;

        // bounds 的四角转换为 Mercator 像素
        // top-left = (west, north)，bottom-right = (east, south)
        lngLatToPixel(_pxA, bounds.west, bounds.north, zoom);
        const boundsLeftPx = _pxA[0];
        const boundsTopPx = _pxA[1];

        lngLatToPixel(_pxB, bounds.east, bounds.south, zoom);
        const boundsRightPx = _pxB[0];
        const boundsBottomPx = _pxB[1];

        // 当前中心转换为 Mercator 像素
        lngLatToPixel(_pxA, x, y, zoom);
        let cx = _pxA[0];
        let cy = _pxA[1];

        // X 方向约束
        const boundsWidthPx = boundsRightPx - boundsLeftPx;
        if (2 * halfW >= boundsWidthPx) {
            // 视口比 bounds 宽：居中对齐
            cx = (boundsLeftPx + boundsRightPx) / 2;
        } else {
            // 视口比 bounds 窄：钳制使左右边不超出
            cx = Math.max(boundsLeftPx + halfW, Math.min(boundsRightPx - halfW, cx));
        }

        // Y 方向约束
        const boundsHeightPx = boundsBottomPx - boundsTopPx;
        if (2 * halfH >= boundsHeightPx) {
            // 视口比 bounds 高：居中对齐
            cy = (boundsTopPx + boundsBottomPx) / 2;
        } else {
            // 视口比 bounds 矮：钳制使上下边不超出
            cy = Math.max(boundsTopPx + halfH, Math.min(boundsBottomPx - halfH, cy));
        }

        // 转换回 lngLat
        pixelToLngLat(_llOut, cx, cy, zoom);
        return [_llOut[0], _llOut[1]];
    }

    // ==================== 回调触发辅助 ====================

    /**
     * 安全触发 onMoveStart 回调集合。
     * 单个回调抛出异常不影响其他回调执行。
     */
    private _fireMoveStart(): void {
        for (const cb of this._onMoveStartCallbacks) {
            try {
                cb();
            } catch (err) {
                if (__DEV__) {
                    console.error('[Camera2D] onMoveStart callback error', err);
                }
            }
        }
    }

    /**
     * 安全触发 onMove 回调集合，传递当前 CameraState。
     */
    private _fireMove(): void {
        const state = this._mutable as CameraState;
        for (const cb of this._onMoveCallbacks) {
            try {
                cb(state);
            } catch (err) {
                if (__DEV__) {
                    console.error('[Camera2D] onMove callback error', err);
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
                if (__DEV__) {
                    console.error('[Camera2D] onMoveEnd callback error', err);
                }
            }
        }
    }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建 2D 正交相机控制器。
 *
 * 返回的 Camera2D 实例提供：
 * - Web Mercator 投影下的正交渲染矩阵
 * - 惯性平移（环形缓冲区速度采样 + 指数衰减）
 * - flyTo 弧线动画和 easeTo 缓动动画
 * - 锚点缩放（以光标位置为中心缩放）
 * - 屏幕坐标 ↔ 经纬度双向转换
 * - 视口级地理包围盒约束
 *
 * bearing / pitch / roll 在 2D 模式下固定为 0。
 * setBearing / setPitch / handleRotate 为 no-op。
 *
 * @param options - 初始化选项（中心、缩放、约束、惯性配置）
 * @returns Camera2D 实例
 *
 * @stability stable
 *
 * @example
 * const cam = createCamera2D({
 *   center: [116.39, 39.91],
 *   zoom: 10,
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
 * @example
 * // 飞行到纽约
 * const anim = cam.flyTo({ center: [-74.006, 40.7128], zoom: 14, duration: 3000 });
 * await anim.finished;
 *
 * @example
 * // 获取可见范围用于数据加载
 * const bounds = cam.getVisibleBounds();
 * fetchData(bounds.west, bounds.south, bounds.east, bounds.north);
 */
export function createCamera2D(options?: Camera2DOptions): Camera2D {
    if (__DEV__) {
        // 开发模式下校验选项参数
        if (options) {
            if (options.center) {
                if (!Array.isArray(options.center) || options.center.length < 2) {
                    console.warn('[Camera2D] createCamera2D: center should be [lon, lat]');
                }
            }
            if (options.zoom !== undefined && !Number.isFinite(options.zoom)) {
                console.warn('[Camera2D] createCamera2D: zoom should be a finite number');
            }
            if (options.minZoom !== undefined && options.maxZoom !== undefined) {
                if (options.minZoom > options.maxZoom) {
                    console.warn('[Camera2D] createCamera2D: minZoom > maxZoom, will be auto-swapped');
                }
            }
        }
    }
    return new Camera2DImpl(options);
}
