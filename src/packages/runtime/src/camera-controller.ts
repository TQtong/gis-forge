// ============================================================
// L3/camera-controller.ts — 抽象相机控制器 + Camera2D 实现
// 层级：L3（运行时调度）
// 职责：统一 2D 相机接口、正交投影、惯性平移、flyTo/easeTo 动画。
// 依赖：L0 CameraState/Viewport/BBox2D、L0 mat4（正交/乘/逆）。
// ============================================================

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import * as mat4 from '../../core/src/math/mat4.ts';

// ---------------------------------------------------------------------------
// 常量（避免魔法数；与墨卡托瓦片尺度弱相关，MVP 用连续 zoom→地面跨度）
// ---------------------------------------------------------------------------

/** 地球赤道周长（米），用于 zoom→海拔近似换算（与 viewport.ts 文档一致） */
const EARTH_CIRCUMFERENCE_METERS = 40075017;

/** 标准瓦片像素边长（与 Web Mercator 切片约定一致） */
const TILE_PIXEL_SIZE = 256;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 默认俯仰/旋转约束（2D 固定为 0） */
const DEFAULT_MIN_PITCH = 0;

/** 默认最大俯仰（2D 不使用，仅占位满足接口） */
const DEFAULT_MAX_PITCH = 0;

/** 默认惯性衰减系数（每帧乘性衰减，越接近 1 滑行越远） */
const DEFAULT_INERTIA_DECAY = 0.92;

/** 惯性速度最小阈值（度/秒或相对单位，低于则停止） */
const INERTIA_EPS = 1e-4;

/** 视口最小合法边长（像素），避免除零 */
const MIN_VIEWPORT_DIM = 1;

/** 惯性采样：保留最近 pan 速度样本用于平滑 */
const PAN_VELOCITY_SMOOTH = 0.35;

/** 默认 flyTo / easeTo 时长（毫秒） */
const DEFAULT_ANIM_MS = 1200;

/** 最小动画时长（毫秒），避免除零 */
const MIN_ANIM_MS = 16;

/** 俯仰/方位角默认（2D 固定） */
const FIXED_ANGLE_2D = 0;

/** 默认 2D 视场角（弧度，仅填充 CameraState.fov，正交下无物理意义） */
const DEFAULT_FOV = Math.PI / 4;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 生成动画实例唯一 ID（优先 Web Crypto，退化到时间戳随机串）。
 *
 * @returns 全局唯一字符串 ID
 *
 * @example
 * const id = generateAnimationId();
 */
function generateAnimationId(): string {
  // 优先使用 UUID，避免并发动画 ID 冲突
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 某些受限环境可能抛错，走退化路径
  }
  // 退化：时间戳 + 随机片段（非密码学安全，仅用于调试标识）
  return `cam-anim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 将数值限制在闭区间 [lo, hi]；若区间非法则回退为安全值。
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
  // 若 lo>hi，交换边界，避免约束反转导致异常
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return 0;
  }
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
  const tt = clamp(t, 0, 1);
  return a + (b - a) * tt;
}

/**
 * 平滑步进（Hermite），用于 easeTo 默认曲线。
 *
 * @param t - 归一化时间 [0,1]
 * @returns 缓动后的 [0,1]
 *
 * @example
 * smoothstep01(0.25); // 小 t 时变化慢，中段加速
 */
function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * 根据缩放级别估算相机海拔（米），与文档公式一致：C/(2^z * tileSize)。
 *
 * @param zoom - 连续缩放级别
 * @returns 估算海拔（米）
 *
 * @example
 * const alt = altitudeFromZoom(10);
 */
function altitudeFromZoom(zoom: number): number {
  const z = Math.max(0, zoom);
  const denom = Math.pow(2, z) * TILE_PIXEL_SIZE;
  // denom 极小保护（极端 zoom 下仍保持有限值）
  const safe = Math.max(denom, 1e-6);
  return EARTH_CIRCUMFERENCE_METERS / safe;
}

/**
 * 计算当前 zoom 与视口下的经纬度半跨度（度），近似：可见经度跨度 = 360/2^z。
 *
 * @param zoom - 缩放级别
 * @param viewportWidth - 视口宽（CSS 像素）
 * @param viewportHeight - 视口高（CSS 像素）
 * @returns [halfLonDeg, halfLatDeg]
 *
 * @example
 * const [hLon, hLat] = computeHalfSpanDeg(8, 800, 600);
 */
function computeHalfSpanDeg(zoom: number, viewportWidth: number, viewportHeight: number): [number, number] {
  const z = clamp(zoom, DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);
  // 经度方向可见跨度（度）：随 zoom 指数衰减
  const lonSpan = 360 / Math.pow(2, Math.max(0, z));
  const aspect = viewportHeight / Math.max(viewportWidth, MIN_VIEWPORT_DIM);
  // 纬度跨度按视口纵横比缩放，保持像素近似方形地面采样
  const latSpan = lonSpan * aspect;
  return [lonSpan * 0.5, latSpan * 0.5];
}

/**
 * 将经纬度限制在 BBox2D 内（独立分量钳制；跨日界线场景后续由 AntiMeridian 处理）。
 *
 * @param lon - 经度（度）
 * @param lat - 纬度（度）
 * @param bounds - 可选地理包围盒
 * @returns 钳制后的 [lon, lat]
 *
 * @example
 * clampLngLat(200, 10, { west: -180, south: -85, east: 180, north: 85 });
 */
function clampLngLat(lon: number, lat: number, bounds?: BBox2D): [number, number] {
  let x = lon;
  let y = lat;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return [0, 0];
  }
  if (bounds) {
    // 若包围盒非法，忽略约束避免 NaN
    if (
      Number.isFinite(bounds.west) &&
      Number.isFinite(bounds.east) &&
      Number.isFinite(bounds.south) &&
      Number.isFinite(bounds.north) &&
      bounds.west <= bounds.east &&
      bounds.south <= bounds.north
    ) {
      x = clamp(x, bounds.west, bounds.east);
      y = clamp(y, bounds.south, bounds.north);
    }
  } else {
    // 默认可渲染纬度范围
    x = clamp(x, -180, 180);
    y = clamp(y, -85, 85);
  }
  return [x, y];
}

/**
 * 类型守卫：视口是否包含有限正尺寸。
 *
 * @param viewport - 视口对象
 * @returns 是否合法
 *
 * @example
 * if (!isViewportValid(vp)) return lastState;
 */
function isViewportValid(viewport: Viewport): boolean {
  return (
    viewport.width >= MIN_VIEWPORT_DIM &&
    viewport.height >= MIN_VIEWPORT_DIM &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height)
  );
}

// ---------------------------------------------------------------------------
// 类型定义（导出）
// ---------------------------------------------------------------------------

/**
 * 相机维度类型标识。
 * - `2d`：平面地图
 * - `25d`：倾斜透视
 * - `3d`：球体/地球模式
 */
export type CameraType = '2d' | '25d' | '3d';

/**
 * 相机数值约束：缩放、俯仰范围与可选地理范围。
 */
export interface CameraConstraints {
  /** 最小缩放级别（含） */
  readonly minZoom: number;
  /** 最大缩放级别（含） */
  readonly maxZoom: number;
  /** 最小俯仰角（弧度） */
  readonly minPitch: number;
  /** 最大俯仰角（弧度） */
  readonly maxPitch: number;
  /** 可选经纬度边界（west/south/east/north，单位度） */
  readonly maxBounds?: BBox2D;
}

/**
 * 相机动画句柄：可取消、可 await 完成态。
 */
export interface CameraAnimation {
  /** 动画唯一 ID */
  readonly id: string;
  /** 当前状态 */
  readonly state: 'running' | 'finished' | 'cancelled';
  /** 立即取消动画并进入 cancelled 态 */
  cancel(): void;
  /** 动画结束（完成或取消后 resolve）的 Promise */
  readonly finished: Promise<void>;
}

/**
 * 抽象相机控制器：每帧 `update` 产出 `CameraState`，并处理交互与动画。
 */
export interface CameraController {
  /** 相机类型标识 */
  readonly type: CameraType;
  /** 最近一次 `update` 计算的快照（只读语义由实现保证） */
  readonly state: CameraState;
  /** 设置地图中心 [lon, lat]（度） */
  setCenter(center: [number, number]): void;
  /** 设置缩放级别（连续值） */
  setZoom(zoom: number): void;
  /** 设置方位角 bearing（弧度，0=正北） */
  setBearing(bearing: number): void;
  /** 设置俯仰 pitch（弧度） */
  setPitch(pitch: number): void;
  /** 瞬时跳转（无动画） */
  jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void;
  /** 飞行动画（可自定义时长与缓动） */
  flyTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation;
  /** 缓动动画（默认平滑缓动曲线） */
  easeTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
  }): CameraAnimation;
  /** 停止所有主动画 */
  stop(): void;
  /** 是否存在未完成的飞行动画 */
  readonly isAnimating: boolean;
  /** 当前约束（只读） */
  readonly constraints: CameraConstraints;
  /** 合并更新约束 */
  setConstraints(constraints: Partial<CameraConstraints>): void;
  /**
   * 每帧更新：惯性衰减、动画推进、矩阵重算。
   * @param deltaTime - 距上一帧时间（秒）
   * @param viewport - 当前视口
   */
  update(deltaTime: number, viewport: Viewport): CameraState;
  /** 平移开始（记录触点） */
  handlePanStart(screenX: number, screenY: number): void;
  /** 平移移动（累积位移并可选更新惯性速度） */
  handlePanMove(screenX: number, screenY: number): void;
  /** 平移结束（开启惯性衰减） */
  handlePanEnd(): void;
  /** 缩放（delta 为滚轮累积；sx/sy 为锚点屏幕坐标） */
  handleZoom(delta: number, screenX: number, screenY: number): void;
  /** 旋转（bearing/pitch 增量，弧度） */
  handleRotate(bearingDelta: number, pitchDelta: number): void;
  /** 是否启用平移惯性 */
  readonly inertiaEnabled: boolean;
  /** 开关惯性 */
  setInertiaEnabled(enabled: boolean): void;
  /** 注册移动开始回调，返回取消订阅函数 */
  onMoveStart(callback: () => void): () => void;
  /** 注册移动中回调 */
  onMove(callback: (state: CameraState) => void): () => void;
  /** 注册移动结束回调 */
  onMoveEnd(callback: () => void): () => void;
  /** 释放资源、取消动画与事件 */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// 内部：2D 动画描述
// ---------------------------------------------------------------------------

/** 飞行动画内部参数 */
type FlyAnim = {
  readonly kind: 'fly' | 'ease';
  readonly id: string;
  /** 起始时间戳（performance.now） */
  startMs: number;
  /** 时长毫秒 */
  durationMs: number;
  /** 缓动函数 */
  easing: (t: number) => number;
  /** 起始值 */
  from: { cx: number; cy: number; zoom: number; bearing: number; pitch: number };
  /** 结束值 */
  to: { cx: number; cy: number; zoom: number; bearing: number; pitch: number };
  /** 对外句柄 */
  handle: CameraAnimationInternal;
};

/** CameraAnimation 实现对象（可变 state） */
type CameraAnimationInternal = CameraAnimation & {
  _state: 'running' | 'finished' | 'cancelled';
  _resolveFinished?: () => void;
};

/**
 * 创建对外可见的 CameraAnimation 句柄。
 *
 * @param id - 动画 ID
 * @param onCancel - 取消时回调（停止内部计时）
 * @returns 动画对象
 *
 * @example
 * const anim = createAnimationHandle('id', () => {});
 */
function createAnimationHandle(id: string, onCancel: () => void): CameraAnimationInternal {
  let resolved = false;
  let resolveFn: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  const handle: CameraAnimationInternal = {
    id,
    _state: 'running',
    get state() {
      return handle._state;
    },
    cancel: () => {
      if (handle._state !== 'running') {
        return;
      }
      handle._state = 'cancelled';
      try {
        onCancel();
      } catch (err) {
        // 取消回调不应抛出到调用方；记录为未处理异常在宿主侧可见
        console.error('[Camera2D] animation onCancel error', err);
      }
      if (!resolved && resolveFn) {
        resolved = true;
        resolveFn();
      }
    },
    finished,
  };
  handle._resolveFinished = () => {
    if (resolved || !resolveFn) {
      return;
    }
    resolved = true;
    resolveFn();
  };
  return handle;
}

/**
 * 完成动画（成功结束）。
 *
 * @param anim - 内部动画对象
 *
 * @example
 * finishAnimationHandle(anim);
 */
function finishAnimationHandle(anim: CameraAnimationInternal): void {
  if (anim._state !== 'running') {
    return;
  }
  anim._state = 'finished';
  anim._resolveFinished?.();
}

// ---------------------------------------------------------------------------
// Camera2D 实现
// ---------------------------------------------------------------------------

/**
 * 构建 2D 相机 `CameraState`（正交投影 + 单位视图或平移视图）。
 *
 * @param centerLon - 中心经度（度）
 * @param centerLat - 中心纬度（度）
 * @param zoom - 缩放级别
 * @param viewport - 视口
 * @param bearing - 方位角（弧度，2D 固定 0）
 * @param pitch - 俯仰角（弧度，2D 固定 0）
 * @param roll - 翻滚角（弧度，2D 固定 0）
 * @param outState - 可复用的状态对象（矩阵缓冲区预分配）
 * @returns 更新后的 CameraState
 *
 * @example
 * rebuildCamera2DState(116, 39, 10, vp, 0, 0, 0, state);
 */
function rebuildCamera2DState(
  centerLon: number,
  centerLat: number,
  zoom: number,
  viewport: Viewport,
  bearing: number,
  pitch: number,
  roll: number,
  outState: MutableCameraState
): CameraState {
  // 视口非法时保持上一帧矩阵，避免除零；中心仍更新供逻辑使用
  const vpOk = isViewportValid(viewport);
  const z = clamp(zoom, DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);
  const [halfLon, halfLat] = computeHalfSpanDeg(z, viewport.width, viewport.height);
  let left = centerLon - halfLon;
  let right = centerLon + halfLon;
  let top = centerLat + halfLat;
  let bottom = centerLat - halfLat;
  // 若包围盒存在，先对中心做钳制再展开半跨度可能仍溢出——此处仅对中心保证，边界由外部 clampLngLat 处理
  if (!vpOk) {
    mat4.identity(outState.viewMatrix);
    mat4.identity(outState.projectionMatrix);
    mat4.multiply(outState.vpMatrix, outState.projectionMatrix, outState.viewMatrix);
    const inv = mat4.invert(outState.inverseVPMatrix, outState.vpMatrix);
    if (inv === null) {
      mat4.identity(outState.inverseVPMatrix);
    }
  } else {
    // 正交投影：直接使用经纬度作为平面坐标（MVP）
    mat4.ortho(outState.projectionMatrix, left, right, bottom, top, -1, 1);
    // 视图矩阵：2D 固定无旋转，仅可保留为单位（中心已烘焙进投影范围）
    mat4.identity(outState.viewMatrix);
    // VP = P × V（列主序右乘向量）
    mat4.multiply(outState.vpMatrix, outState.projectionMatrix, outState.viewMatrix);
    const inv = mat4.invert(outState.inverseVPMatrix, outState.vpMatrix);
    if (inv === null) {
      // 奇异时回退单位逆，避免后续拾取 NaN
      mat4.identity(outState.inverseVPMatrix);
    }
  }
  const alt = altitudeFromZoom(z);
  outState.center[0] = centerLon;
  outState.center[1] = centerLat;
  outState.zoom = z;
  outState.bearing = bearing;
  outState.pitch = pitch;
  outState.roll = roll;
  outState.altitude = alt;
  outState.fov = DEFAULT_FOV;
  // 位置：用近似米制平面位置填充（便于 LOD/分析；非精确 ECEF）
  const latRad = (centerLat * Math.PI) / 180;
  const mPerDegLon = 111320 * Math.max(Math.cos(latRad), 1e-6);
  const mPerDegLat = 111320;
  outState.position[0] = centerLon * mPerDegLon;
  outState.position[1] = centerLat * mPerDegLat;
  outState.position[2] = alt;
  return outState as CameraState;
}

/** 可变内部状态（矩阵缓冲区复用） */
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
 * @returns MutableCameraState
 *
 * @example
 * const s = createMutableState();
 */
function createMutableState(): MutableCameraState {
  return {
    center: [0, 0],
    zoom: DEFAULT_MIN_ZOOM,
    bearing: FIXED_ANGLE_2D,
    pitch: FIXED_ANGLE_2D,
    roll: FIXED_ANGLE_2D,
    viewMatrix: mat4.create(),
    projectionMatrix: mat4.create(),
    vpMatrix: mat4.create(),
    inverseVPMatrix: mat4.create(),
    position: new Float32Array(3),
    altitude: 0,
    fov: DEFAULT_FOV,
  };
}

/**
 * Camera2D 具体实现（单文件内聚）。
 */
class Camera2DImpl implements CameraController {
  /** 类型标识 */
  readonly type: CameraType = '2d';

  /** 内部可变状态快照 */
  private readonly _mutable: MutableCameraState;

  /** 中心经纬度（度） */
  private _cx: number;

  /** 中心纬度（度） */
  private _cy: number;

  /** 连续缩放级别 */
  private _zoom: number;

  /** 约束 */
  private _constraints: CameraConstraints;

  /** 惯性开关 */
  private _inertiaEnabled: boolean;

  /** 惯性衰减（每帧乘性因子，基于 deltaTime 缩放） */
  private _inertiaDecay: number;

  /** 平移拖拽：上一屏幕位置 */
  private _panPrevX: number | null = null;

  private _panPrevY: number | null = null;

  /** 是否正在手势平移 */
  private _panning = false;

  /** 惯性速度（度/秒，经纬分量） */
  private _velLon = 0;

  private _velLat = 0;

  /** 上一 pan move 时间戳（用于速度估计） */
  private _lastPanMs = 0;

  /** 主动飞行动画 */
  private _fly: FlyAnim | null = null;

  /** 移动开始监听 */
  private readonly _onMoveStart: Set<() => void> = new Set();

  /** 移动监听 */
  private readonly _onMove: Set<(s: CameraState) => void> = new Set();

  /** 移动结束监听 */
  private readonly _onMoveEnd: Set<() => void> = new Set();

  /** 销毁标记 */
  private _destroyed = false;

  /** 最近一次视口宽（CSS 像素），供 pan/zoom 在未调用 update 前使用 */
  private _lastViewportWidth = 1024;

  /** 最近一次视口高（CSS 像素） */
  private _lastViewportHeight = 768;

  /**
   * 构造 Camera2D 实例。
   *
   * @param options - 初始中心、缩放、约束与惯性参数
   */
  constructor(options?: {
    center?: [number, number];
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    maxBounds?: BBox2D;
    inertia?: boolean;
    inertiaDecay?: number;
  }) {
    this._mutable = createMutableState();
    const initCenter = options?.center ?? [0, 0];
    this._cx = initCenter[0];
    this._cy = initCenter[1];
    this._zoom = clamp(
      options?.zoom ?? 4,
      options?.minZoom ?? DEFAULT_MIN_ZOOM,
      options?.maxZoom ?? DEFAULT_MAX_ZOOM
    );
    this._constraints = {
      minZoom: options?.minZoom ?? DEFAULT_MIN_ZOOM,
      maxZoom: options?.maxZoom ?? DEFAULT_MAX_ZOOM,
      minPitch: DEFAULT_MIN_PITCH,
      maxPitch: DEFAULT_MAX_PITCH,
      maxBounds: options?.maxBounds,
    };
    this._inertiaEnabled = options?.inertia ?? true;
    this._inertiaDecay = clamp(options?.inertiaDecay ?? DEFAULT_INERTIA_DECAY, 0, 0.9999);
  }

  /** @inheritdoc */
  get state(): CameraState {
    return this._mutable as CameraState;
  }

  /** @inheritdoc */
  get constraints(): CameraConstraints {
    return this._constraints;
  }

  /** @inheritdoc */
  get isAnimating(): boolean {
    return this._fly !== null;
  }

  /** @inheritdoc */
  get inertiaEnabled(): boolean {
    return this._inertiaEnabled;
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
    // 校验 min/max zoom
    if (next.minZoom > next.maxZoom) {
      const t = next.minZoom;
      (next as { minZoom: number }).minZoom = next.maxZoom;
      (next as { maxZoom: number }).maxZoom = t;
    }
    this._constraints = next;
    // 立即钳制当前值
    this._zoom = clamp(this._zoom, next.minZoom, next.maxZoom);
    const [lx, ly] = clampLngLat(this._cx, this._cy, next.maxBounds);
    this._cx = lx;
    this._cy = ly;
  }

  /** @inheritdoc */
  setCenter(center: [number, number]): void {
    this._checkDestroyed();
    const [x, y] = clampLngLat(center[0], center[1], this._constraints.maxBounds);
    this._cx = x;
    this._cy = y;
  }

  /** @inheritdoc */
  setZoom(zoom: number): void {
    this._checkDestroyed();
    this._zoom = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
  }

  /** @inheritdoc */
  setBearing(_bearing: number): void {
    this._checkDestroyed();
    // 2D 模式固定正北向；忽略外部 bearing 以符合规格
  }

  /** @inheritdoc */
  setPitch(_pitch: number): void {
    this._checkDestroyed();
    // 2D 模式俯仰恒为 0
  }

  /** @inheritdoc */
  jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    this._checkDestroyed();
    this.stop();
    if (options.center) {
      const [x, y] = clampLngLat(options.center[0], options.center[1], this._constraints.maxBounds);
      this._cx = x;
      this._cy = y;
    }
    if (options.zoom !== undefined) {
      this._zoom = clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom);
    }
    // bearing/pitch 在 2D 下不使用
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
    const durationMs = Math.max(MIN_ANIM_MS, options.duration ?? DEFAULT_ANIM_MS);
    const easing = options.easing ?? smoothstep01;
    const toZ = options.zoom !== undefined ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom) : this._zoom;
    let tox = this._cx;
    let toy = this._cy;
    if (options.center) {
      const c = clampLngLat(options.center[0], options.center[1], this._constraints.maxBounds);
      tox = c[0];
      toy = c[1];
    }
    const id = generateAnimationId();
    const handle = createAnimationHandle(id, () => {
      if (this._fly && this._fly.id === id) {
        this._fly = null;
      }
    });
    const anim: FlyAnim = {
      kind: 'fly',
      id,
      startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      durationMs,
      easing,
      from: { cx: this._cx, cy: this._cy, zoom: this._zoom, bearing: FIXED_ANGLE_2D, pitch: FIXED_ANGLE_2D },
      to: { cx: tox, cy: toy, zoom: toZ, bearing: FIXED_ANGLE_2D, pitch: FIXED_ANGLE_2D },
      handle,
    };
    this._fly = anim;
    return handle;
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
    const durationMs = Math.max(MIN_ANIM_MS, options.duration ?? DEFAULT_ANIM_MS);
    const easing = smoothstep01;
    const toZ = options.zoom !== undefined ? clamp(options.zoom, this._constraints.minZoom, this._constraints.maxZoom) : this._zoom;
    let tox = this._cx;
    let toy = this._cy;
    if (options.center) {
      const c = clampLngLat(options.center[0], options.center[1], this._constraints.maxBounds);
      tox = c[0];
      toy = c[1];
    }
    const id = generateAnimationId();
    const handle = createAnimationHandle(id, () => {
      if (this._fly && this._fly.id === id) {
        this._fly = null;
      }
    });
    const anim: FlyAnim = {
      kind: 'ease',
      id,
      startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      durationMs,
      easing,
      from: { cx: this._cx, cy: this._cy, zoom: this._zoom, bearing: FIXED_ANGLE_2D, pitch: FIXED_ANGLE_2D },
      to: { cx: tox, cy: toy, zoom: toZ, bearing: FIXED_ANGLE_2D, pitch: FIXED_ANGLE_2D },
      handle,
    };
    this._fly = anim;
    return handle;
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
  update(deltaTime: number, viewport: Viewport): CameraState {
    this._checkDestroyed();
    // 缓存视口，确保 pan/zoom 与上一帧投影一致（即使未先 render）
    this._lastViewportWidth = Math.max(viewport.width, MIN_VIEWPORT_DIM);
    this._lastViewportHeight = Math.max(viewport.height, MIN_VIEWPORT_DIM);
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    // 飞行动画优先
    if (this._fly) {
      const anim = this._fly;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const tRaw = (now - anim.startMs) / anim.durationMs;
      const te = anim.easing(clamp(tRaw, 0, 1));
      this._cx = lerp(anim.from.cx, anim.to.cx, te);
      this._cy = lerp(anim.from.cy, anim.to.cy, te);
      this._zoom = lerp(anim.from.zoom, anim.to.zoom, te);
      const [cx2, cy2] = clampLngLat(this._cx, this._cy, this._constraints.maxBounds);
      this._cx = cx2;
      this._cy = cy2;
      this._zoom = clamp(this._zoom, this._constraints.minZoom, this._constraints.maxZoom);
      if (tRaw >= 1) {
        finishAnimationHandle(anim.handle);
        this._fly = null;
      }
    } else if (this._inertiaEnabled && !this._panning && (Math.abs(this._velLon) > INERTIA_EPS || Math.abs(this._velLat) > INERTIA_EPS)) {
      // 指数衰减：factor 与帧时长相关
      const decay = Math.pow(this._inertiaDecay, dt * 60);
      this._cx += this._velLon * dt;
      this._cy += this._velLat * dt;
      this._velLon *= decay;
      this._velLat *= decay;
      const [cx2, cy2] = clampLngLat(this._cx, this._cy, this._constraints.maxBounds);
      this._cx = cx2;
      this._cy = cy2;
      if (Math.abs(this._velLon) < INERTIA_EPS) {
        this._velLon = 0;
      }
      if (Math.abs(this._velLat) < INERTIA_EPS) {
        this._velLat = 0;
      }
    }
    rebuildCamera2DState(this._cx, this._cy, this._zoom, viewport, FIXED_ANGLE_2D, FIXED_ANGLE_2D, FIXED_ANGLE_2D, this._mutable);
    return this._mutable as CameraState;
  }

  /** @inheritdoc */
  handlePanStart(screenX: number, screenY: number): void {
    this._checkDestroyed();
    this._panning = true;
    this._panPrevX = screenX;
    this._panPrevY = screenY;
    this._lastPanMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._velLon = 0;
    this._velLat = 0;
    for (const cb of this._onMoveStart) {
      try {
        cb();
      } catch (err) {
        console.error('[Camera2D] onMoveStart callback error', err);
      }
    }
  }

  /** @inheritdoc */
  handlePanMove(screenX: number, screenY: number): void {
    this._checkDestroyed();
    if (this._panPrevX === null || this._panPrevY === null) {
      return;
    }
    const dx = screenX - this._panPrevX;
    const dy = screenY - this._panPrevY;
    this._panPrevX = screenX;
    this._panPrevY = screenY;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prevMs = this._lastPanMs;
    this._lastPanMs = now;
    // 使用最近一次 update 缓存的视口尺寸，将屏幕像素位移映射为经纬度增量
    const vpW = this._lastViewportWidth;
    const vpH = this._lastViewportHeight;
    if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
      return;
    }
    const [halfLon, halfLat] = computeHalfSpanDeg(this._zoom, vpW, vpH);
    const spanLon = halfLon * 2;
    const spanLat = halfLat * 2;
    const dLon = (-dx / vpW) * spanLon;
    const dLat = (dy / vpH) * spanLat;
    this._cx += dLon;
    this._cy += dLat;
    const [cx2, cy2] = clampLngLat(this._cx, this._cy, this._constraints.maxBounds);
    this._cx = cx2;
    this._cy = cy2;
    const dtSec = Math.max(1e-4, (now - prevMs) / 1000);
    const vx = dLon / dtSec;
    const vy = dLat / dtSec;
    this._velLon = PAN_VELOCITY_SMOOTH * vx + (1 - PAN_VELOCITY_SMOOTH) * this._velLon;
    this._velLat = PAN_VELOCITY_SMOOTH * vy + (1 - PAN_VELOCITY_SMOOTH) * this._velLat;
    for (const cb of this._onMove) {
      try {
        cb(this.state);
      } catch (err) {
        console.error('[Camera2D] onMove callback error', err);
      }
    }
  }

  /** @inheritdoc */
  handlePanEnd(): void {
    this._checkDestroyed();
    this._panning = false;
    this._panPrevX = null;
    this._panPrevY = null;
    for (const cb of this._onMoveEnd) {
      try {
        cb();
      } catch (err) {
        console.error('[Camera2D] onMoveEnd callback error', err);
      }
    }
  }

  /** @inheritdoc */
  handleZoom(delta: number, screenX: number, screenY: number): void {
    this._checkDestroyed();
    const vpW = this._lastViewportWidth;
    const vpH = this._lastViewportHeight;
    if (vpW < MIN_VIEWPORT_DIM || vpH < MIN_VIEWPORT_DIM) {
      return;
    }
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    const [halfLon, halfLat] = computeHalfSpanDeg(this._zoom, vpW, vpH);
    const left = this._cx - halfLon;
    const right = this._cx + halfLon;
    const top = this._cy + halfLat;
    const bottom = this._cy - halfLat;
    const spanLon = right - left;
    const spanLat = top - bottom;
    const wx = left + (screenX / vpW) * spanLon;
    const wy = top - (screenY / vpH) * spanLat;
    const zoomFactor = Math.pow(1.002, -delta);
    const newZoom = clamp(this._zoom * zoomFactor, this._constraints.minZoom, this._constraints.maxZoom);
    const [nhalfLon, nhalfLat] = computeHalfSpanDeg(newZoom, vpW, vpH);
    const nspanLon = nhalfLon * 2;
    const nspanLat = nhalfLat * 2;
    const nLeft = wx + (0.5 - screenX / vpW) * nspanLon;
    const nCy = wy + (screenY / vpH - 0.5) * nspanLat;
    this._cx = nLeft + nhalfLon;
    this._cy = nCy;
    this._zoom = newZoom;
    const [cx2, cy2] = clampLngLat(this._cx, this._cy, this._constraints.maxBounds);
    this._cx = cx2;
    this._cy = cy2;
  }

  /** @inheritdoc */
  handleRotate(_bearingDelta: number, _pitchDelta: number): void {
    this._checkDestroyed();
    // 2D 无旋转交互
  }

  /** @inheritdoc */
  onMoveStart(callback: () => void): () => void {
    this._onMoveStart.add(callback);
    return () => {
      this._onMoveStart.delete(callback);
    };
  }

  /** @inheritdoc */
  onMove(callback: (state: CameraState) => void): () => void {
    this._onMove.add(callback);
    return () => {
      this._onMove.delete(callback);
    };
  }

  /** @inheritdoc */
  onMoveEnd(callback: () => void): () => void {
    this._onMoveEnd.add(callback);
    return () => {
      this._onMoveEnd.delete(callback);
    };
  }

  /** @inheritdoc */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.stop();
    this._onMoveStart.clear();
    this._onMove.clear();
    this._onMoveEnd.clear();
    this._velLon = 0;
    this._velLat = 0;
  }

  private _checkDestroyed(): void {
    if (this._destroyed) {
      throw new Error('[Camera2D] controller destroyed');
    }
  }
}

/**
 * 工厂：创建 2D 正交相机控制器（bearing/pitch 固定为 0）。
 *
 * @param options - 初始中心、缩放级别、约束与惯性参数
 * @returns 实现 `CameraController` 的实例
 *
 * @example
 * const cam = createCamera2D({ center: [116.4, 39.9], zoom: 10, maxBounds: { west: 70, south: 10, east: 140, north: 55 } });
 */
export function createCamera2D(options?: {
  center?: [number, number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  maxBounds?: BBox2D;
  inertia?: boolean;
  inertiaDecay?: number;
}): CameraController {
  return new Camera2DImpl(options);
}
