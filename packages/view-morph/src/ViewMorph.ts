// ============================================================
// view-morph/src/ViewMorph.ts — 视图模式过渡（2D ↔ 2.5D ↔ 3D）
// 层级：L3（运行时调度 / 相机控制）
// 职责：管理不同维度相机之间的平滑过渡动画，
//       包括投影矩阵混合、坐标系变换（Mercator ↔ ECEF）、
//       和相机参数（pitch/bearing/zoom/fov）的分阶段插值。
// 依赖：L0 CameraState/Viewport、L0 mat4/vec3、
//       L3 CameraController/CameraAnimation
// ============================================================

declare const __DEV__: boolean;

import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type { CameraController, CameraAnimation } from '../../runtime/src/camera-controller.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';

// ===================== 常量定义 =====================

/** 默认过渡动画持续时间（毫秒），用于 ViewMorphOptions.duration 的默认值 */
const DEFAULT_MORPH_DURATION = 2000;

/** 允许的最小过渡时长（毫秒），防止过快导致视觉突变 */
const MIN_MORPH_DURATION = 500;

/** 允许的最大过渡时长（毫秒），防止用户设置过长等待 */
const MAX_MORPH_DURATION = 10000;

/** 默认最大缩放偏移量，2D→3D 过渡时 zoom 可临时偏移的最大级数 */
const DEFAULT_MAX_ZOOM_OFFSET = 2;

/** 2D→3D 两阶段过渡：Phase1（2D→2.5D）结束的归一化进度 */
const DEFAULT_PHASE1_END_2D_TO_3D = 0.4;

/** 3D→2D 两阶段过渡：Phase1（3D→2.5D）结束的归一化进度 */
const DEFAULT_PHASE1_END_3D_TO_2D = 0.6;

/** 正交投影的最小 FOV 替代值（弧度），接近零但非零以避免数学奇异 */
const MIN_FOV_FOR_ORTHO = 0.0001;

/** WGS84 椭球长半轴（米），用于 lon/lat → ECEF 坐标变换 */
const WGS84_A = 6378137.0;

/** 度到弧度换算因子 */
const DEG_TO_RAD = Math.PI / 180;

/** 2D→3D 过渡中间态的目标俯仰角（弧度），60° = π/3 */
const INTERMEDIATE_PITCH_RAD = Math.PI / 3;

/** 地球赤道周长（米），用于 zoom → 海拔换算 */
const EARTH_CIRCUMFERENCE = 40075017;

/** 标准瓦片像素边长（Web Mercator 切片约定） */
const TILE_SIZE = 256;

/** 默认透视投影 FOV（弧度），π/4 = 45° */
const DEFAULT_PERSPECTIVE_FOV = Math.PI / 4;

/** 4×4 矩阵元素总数 */
const MAT4_ELEMENTS = 16;

/** 浮点极小量，用于除零和比较保护 */
const EPSILON = 1e-8;

/** 角度极小量（弧度），低于此值认为角度相等 */
const ANGLE_EPSILON = 1e-6;

/** 毫秒到秒换算因子 */
const MS_TO_SEC = 0.001;

// ===================== 公共类型定义 =====================

/**
 * 视图模式枚举。
 * - `'2d'`：纯 2D 平面地图（正交投影，pitch=0, bearing=0）
 * - `'25d'`：2.5D 倾斜地图（透视投影，pitch/bearing 可变）
 * - `'3d'`：3D 地球模式（透视投影，ECEF 坐标系）
 *
 * @stability experimental
 */
export type ViewMode = '2d' | '25d' | '3d';

/**
 * 视图过渡选项。
 * 控制过渡动画的时长、缓动曲线、缩放偏移和投影混合方式。
 *
 * @stability experimental
 *
 * @example
 * const options: ViewMorphOptions = {
 *   duration: 3000,
 *   easing: t => t * t,
 *   maxZoomOffset: 3,
 *   projectionBlendMethod: 'parameter',
 * };
 */
export interface ViewMorphOptions {
  /**
   * 过渡动画持续时间（毫秒）。
   * 范围 [500, 10000]，默认 2000。
   * 值越大过渡越平滑，但用户等待时间越长。
   */
  duration?: number;

  /**
   * 缓动函数，将线性进度 t∈[0,1] 映射到缓动后的值。
   * 默认 easeInOutCubic。
   * 必须满足 f(0)≈0, f(1)≈1。
   */
  easing?: (t: number) => number;

  /**
   * 最大缩放偏移量（zoom 级数）。
   * 2D→3D 过渡期间，zoom 可临时偏离起终值的最大量，
   * 用于在过渡中"拉远"镜头产生飞行效果。
   * 范围 [0, 5]，默认 2。
   */
  maxZoomOffset?: number;

  /**
   * 投影矩阵混合方式。
   * - `'parameter'`：插值 fov/near/far 参数后重建矩阵（推荐，视觉更正确）
   * - `'matrix'`：逐元素线性插值投影矩阵（简单但可能产生轻微畸变）
   * 默认 `'parameter'`。
   */
  projectionBlendMethod?: 'parameter' | 'matrix';
}

/**
 * 视图过渡的实时状态快照（只读）。
 * 每帧通过 `ViewMorph.state` 获取，可用于 UI 或调试。
 *
 * @stability experimental
 *
 * @example
 * if (viewMorph.state.isMorphing) {
 *   console.log(`进度: ${(viewMorph.state.progress * 100).toFixed(1)}%`);
 * }
 */
export interface ViewMorphState {
  /** 是否正在进行视图过渡 */
  readonly isMorphing: boolean;

  /** 当前过渡进度 [0, 1]，0=开始，1=结束；未过渡时为 0 */
  readonly progress: number;

  /** 当前（源）视图模式 */
  readonly currentMode: ViewMode;

  /** 目标视图模式 */
  readonly targetMode: ViewMode;

  /** 混合后的相机状态（过渡期间每帧更新，用于渲染） */
  readonly blendedState: CameraState;
}

/**
 * 视图过渡动画句柄。
 * 可取消、可 await 完成态。
 *
 * @stability experimental
 *
 * @example
 * const anim = viewMorph.morphTo('3d', cam2d, cam3d);
 * anim.cancel(); // 取消
 * await anim.finished; // 等待完成或取消
 */
export interface ViewMorphAnimation {
  /** 当动画完成（或被取消）时 resolve 的 Promise */
  readonly finished: Promise<void>;

  /** 立即取消当前过渡动画 */
  cancel(): void;
}

/**
 * 视图过渡控制器接口。
 * 管理 2D ↔ 2.5D ↔ 3D 之间的平滑相机过渡。
 *
 * @stability experimental
 *
 * @example
 * const morph = createViewMorph();
 * morph.onMorphStart(() => console.log('开始过渡'));
 * const anim = morph.morphTo('3d', camera2d, camera3d, { duration: 2500 });
 * // 每帧 UPDATE 阶段调用
 * const blended = morph.update(deltaTime);
 * if (blended) { renderer.setCamera(blended); }
 */
export interface ViewMorph {
  /**
   * 启动视图模式过渡。
   * 如果已有过渡在进行中，先取消当前再启动新的。
   *
   * @param targetMode - 目标视图模式
   * @param fromCamera - 源相机控制器（读取起始状态）
   * @param toCamera - 目标相机控制器（读取终止状态）
   * @param options - 可选过渡参数
   * @returns 过渡动画句柄
   *
   * @stability experimental
   *
   * @example
   * const anim = morph.morphTo('25d', cam2d, cam25d, { duration: 1500 });
   */
  morphTo(
    targetMode: ViewMode,
    fromCamera: CameraController,
    toCamera: CameraController,
    options?: ViewMorphOptions
  ): ViewMorphAnimation;

  /** 取消当前正在进行的过渡。无过渡时为空操作。 */
  cancel(): void;

  /** 当前过渡状态的只读快照 */
  readonly state: ViewMorphState;

  /**
   * 每帧更新：推进过渡进度并计算混合相机状态。
   * 应在引擎 UPDATE 阶段调用。
   *
   * @param deltaTime - 距上一帧的时间（秒）
   * @returns 混合后的 CameraState（过渡中），或 null（无过渡）
   *
   * @stability experimental
   *
   * @example
   * const blended = morph.update(1 / 60);
   * if (blended) { renderer.setCamera(blended); }
   */
  update(deltaTime: number): CameraState | null;

  /**
   * 注册过渡开始回调。
   * @param callback - 过渡开始时调用
   * @returns 取消订阅函数
   */
  onMorphStart(callback: () => void): () => void;

  /**
   * 注册过渡进度回调（每帧触发）。
   * @param callback - 传入当前进度 [0, 1]
   * @returns 取消订阅函数
   */
  onMorphProgress(callback: (progress: number) => void): () => void;

  /**
   * 注册过渡结束回调。
   * @param callback - 过渡完成或取消时调用
   * @returns 取消订阅函数
   */
  onMorphEnd(callback: () => void): () => void;

  /** 销毁过渡控制器，释放所有资源和回调。销毁后不可再使用。 */
  destroy(): void;
}

// ===================== 内部类型 =====================

/**
 * 可变相机状态（内部），预分配所有 Float32Array 缓冲区以避免帧内 GC。
 * 外部以 readonly CameraState 暴露。
 */
interface MutableCameraState {
  /** 注视点经纬度 [lon, lat]（度） */
  center: [number, number];
  /** 缩放级别 */
  zoom: number;
  /** 方位角（弧度） */
  bearing: number;
  /** 俯仰角（弧度） */
  pitch: number;
  /** 翻滚角（弧度） */
  roll: number;
  /** 视图矩阵，Float32Array(16) 列主序 */
  viewMatrix: Float32Array;
  /** 投影矩阵，Float32Array(16) 列主序 */
  projectionMatrix: Float32Array;
  /** 视图投影合矩阵，Float32Array(16) 列主序 */
  vpMatrix: Float32Array;
  /** 视图投影逆矩阵，Float32Array(16) 列主序 */
  inverseVPMatrix: Float32Array;
  /** 相机世界坐标，Float32Array(3) */
  position: Float32Array;
  /** 海拔（米） */
  altitude: number;
  /** 垂直视场角（弧度） */
  fov: number;
}

/** 过渡方向，决定使用哪种过渡算法 */
type TransitionKind =
  | '2d-25d' | '25d-3d' | '2d-3d'
  | '3d-2d'  | '3d-25d' | '25d-2d'
  | 'same';

/** 已规范化的完整过渡选项（所有字段已填充默认值） */
type ResolvedOptions = Required<ViewMorphOptions>;

/** 活跃过渡的内部状态 */
interface ActiveMorph {
  /** 过渡方向 */
  readonly kind: TransitionKind;
  /** 源视图模式 */
  readonly fromMode: ViewMode;
  /** 目标视图模式 */
  readonly targetMode: ViewMode;
  /** 捕获的源相机状态快照（深拷贝） */
  readonly fromSnap: MutableCameraState;
  /** 捕获的目标相机状态快照（深拷贝） */
  readonly toSnap: MutableCameraState;
  /** 已规范化的选项 */
  readonly options: ResolvedOptions;
  /** 已消耗时间（毫秒） */
  elapsedMs: number;
  /** Promise resolve */
  resolve: () => void;
  /** 是否已取消 */
  cancelled: boolean;
}

// ===================== 模块级预分配临时缓冲区 =====================

/** 临时 3D 向量 A（eye 计算） */
const _tmpEye = new Float32Array(3);

/** 临时 3D 向量 B（target 计算） */
const _tmpTarget = new Float32Array(3);

/** 临时 3D 向量 C（up 向量） */
const _tmpUp = new Float32Array(3);

/** 临时 4×4 矩阵 A（flat view） */
const _tmpMat4A = mat4.create();

/** 临时 4×4 矩阵 B（ECEF view） */
const _tmpMat4B = mat4.create();

// ===================== 缓动与插值工具 =====================

/**
 * 默认缓动函数：easeInOutCubic。
 * 起步加速、中段匀速、结尾减速的 S 曲线。
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeInOutCubic(0);   // 0
 * easeInOutCubic(0.5); // 0.5
 * easeInOutCubic(1);   // 1
 */
function easeInOutCubic(t: number): number {
  // 前半段 4t³ 加速
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  // 后半段 1 - (−2t+2)³/2 减速
  const p = -2 * t + 2;
  return 1 - (p * p * p) * 0.5;
}

/**
 * 标量线性插值：a + (b − a) × t。
 * 保证 t=0 精确返回 a，t=1 精确返回 b。
 *
 * @param a - 起始值
 * @param b - 终止值
 * @param t - 插值因子 [0, 1]
 * @returns 插值结果
 *
 * @example
 * lerpScalar(0, 10, 0.3); // 3
 */
function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 角度线性插值（最短弧路径）。
 * 将角度差归一化到 [−π, π] 后插值，确保走最短圆弧。
 *
 * @param a - 起始角度（弧度）
 * @param b - 终止角度（弧度）
 * @param t - 插值因子 [0, 1]
 * @returns 插值后的角度（弧度）
 *
 * @example
 * lerpAngle(0.1, 2 * Math.PI - 0.1, 0.5); // ≈ 0（走短弧经过 0/2π）
 */
function lerpAngle(a: number, b: number, t: number): number {
  // 计算角度差
  let delta = b - a;
  // 归一化到 [−π, π]：floor((delta+π)/(2π)) × 2π 截断整圈
  delta = delta - Math.floor((delta + Math.PI) / (2 * Math.PI)) * (2 * Math.PI);
  return a + delta * t;
}

/**
 * 将数值钳制在闭区间 [lo, hi]。
 * 非有限值回退到 lo，lo > hi 时自动交换。
 *
 * @param v - 输入值
 * @param lo - 下界
 * @param hi - 上界
 * @returns 钳制后的值
 *
 * @example
 * clampValue(15, 0, 10); // 10
 * clampValue(NaN, 0, 10); // 0
 */
function clampValue(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) {
    return lo;
  }
  // 确保 a <= b
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.min(b, Math.max(a, v));
}

// ===================== 相机状态工具 =====================

/**
 * 创建预分配的可变相机状态。
 * 所有 Float32Array 在此时一次性分配，避免帧循环内 GC。
 *
 * @returns 新的 MutableCameraState（单位矩阵、零参数）
 *
 * @example
 * const state = createMutableCameraState();
 */
function createMutableCameraState(): MutableCameraState {
  return {
    center: [0, 0],
    zoom: 0,
    bearing: 0,
    pitch: 0,
    roll: 0,
    viewMatrix: mat4.create(),
    projectionMatrix: mat4.create(),
    vpMatrix: mat4.create(),
    inverseVPMatrix: mat4.create(),
    position: new Float32Array(3),
    altitude: 0,
    fov: DEFAULT_PERSPECTIVE_FOV,
  };
}

/**
 * 深拷贝 CameraState 到 MutableCameraState（复用目标缓冲区，零分配）。
 *
 * @param out - 目标可变状态
 * @param src - 源只读状态
 *
 * @example
 * snapshotCameraState(mutable, camera.state);
 */
function snapshotCameraState(out: MutableCameraState, src: CameraState): void {
  // 标量参数逐字段复制
  out.center[0] = src.center[0];
  out.center[1] = src.center[1];
  out.zoom = src.zoom;
  out.bearing = src.bearing;
  out.pitch = src.pitch;
  out.roll = src.roll;
  out.altitude = src.altitude;
  out.fov = src.fov;
  // 矩阵使用 mat4.copy 确保 16 元素完整拷贝
  mat4.copy(out.viewMatrix, src.viewMatrix);
  mat4.copy(out.projectionMatrix, src.projectionMatrix);
  mat4.copy(out.vpMatrix, src.vpMatrix);
  mat4.copy(out.inverseVPMatrix, src.inverseVPMatrix);
  // position 向量
  out.position[0] = src.position[0];
  out.position[1] = src.position[1];
  out.position[2] = src.position[2];
}

/**
 * 4×4 矩阵逐元素线性插值：out[i] = a[i] + (b[i] − a[i]) × t。
 *
 * @param out - 结果矩阵（预分配）
 * @param a - 起始矩阵
 * @param b - 终止矩阵
 * @param t - 插值因子 [0, 1]
 *
 * @example
 * lerpMatrix(result, identityMat, targetMat, 0.5);
 */
function lerpMatrix(out: Float32Array, a: Float32Array, b: Float32Array, t: number): void {
  // 展开循环写法，但 16 次迭代差异可忽略，用 for 循环更清晰
  for (let i = 0; i < MAT4_ELEMENTS; i++) {
    out[i] = a[i] + (b[i] - a[i]) * t;
  }
}

// ===================== 投影矩阵分析 =====================

/**
 * 判断投影矩阵是否为透视投影。
 * 透视矩阵特征：proj[11] ≈ −1（齐次坐标 w 分量来自 −z_eye）。
 * 正交矩阵特征：proj[11] ≈ 0。
 *
 * @param proj - 4×4 投影矩阵（列主序）
 * @returns 是否为透视投影
 *
 * @example
 * isPerspectiveMatrix(mat4.perspectiveReversedZ(...)); // true
 * isPerspectiveMatrix(mat4.ortho(...));                // false
 */
function isPerspectiveMatrix(proj: Float32Array): boolean {
  // 透视投影 proj[11] = −1，正交投影 proj[11] = 0；用 0.5 阈值判别
  return Math.abs(proj[11] + 1) < 0.5;
}

/**
 * 从投影矩阵提取垂直视场角（弧度）。
 * 透视：proj[5] = 1/tan(fov/2) → fov = 2·atan(1/proj[5])。
 * 正交：返回 MIN_FOV_FOR_ORTHO。
 *
 * @param proj - 4×4 投影矩阵（列主序）
 * @returns FOV（弧度），范围 [MIN_FOV_FOR_ORTHO, π)
 *
 * @example
 * extractFov(perspectiveMatrix); // ~0.7854 (π/4)
 */
function extractFov(proj: Float32Array): number {
  if (!isPerspectiveMatrix(proj)) {
    // 正交投影无真实 FOV
    return MIN_FOV_FOR_ORTHO;
  }
  // proj[5] = f = 1/tan(fov/2)；f 接近 0 时退化
  const f = proj[5];
  if (Math.abs(f) < EPSILON) {
    return MIN_FOV_FOR_ORTHO;
  }
  return Math.max(2 * Math.atan(1 / Math.abs(f)), MIN_FOV_FOR_ORTHO);
}

/**
 * 从投影矩阵提取宽高比 (width/height)。
 * 对透视和正交均适用：aspect = proj[5] / proj[0]。
 *
 * @param proj - 4×4 投影矩阵（列主序）
 * @returns 宽高比，最小 0.1
 *
 * @example
 * extractAspect(projMatrix); // 1.7778 (16/9)
 */
function extractAspect(proj: Float32Array): number {
  if (Math.abs(proj[0]) < EPSILON) {
    return 1;
  }
  // 透视：proj[0]=f/aspect, proj[5]=f → aspect=proj[5]/proj[0]
  // 正交：proj[0]=2/(right-left), proj[5]=2/(top-bottom) → aspect=(right-left)/(top-bottom)
  return Math.max(Math.abs(proj[5] / proj[0]), 0.1);
}

/**
 * 从透视投影矩阵提取 near/far 裁剪面距离。
 * 支持标准透视、Reversed-Z 透视和无限远透视。
 * 正交矩阵或无法解析时返回安全默认值。
 *
 * @param proj - 4×4 投影矩阵（列主序）
 * @returns [near, far] 正值元组
 *
 * @example
 * const [near, far] = extractNearFar(perspMatrix); // [0.1, 10000]
 */
function extractNearFar(proj: Float32Array): [number, number] {
  if (!isPerspectiveMatrix(proj)) {
    // 正交矩阵的 near/far 在度空间，对透视无意义
    return [0.1, 10000];
  }
  const a = proj[10];
  const b = proj[14];
  // 无限远透视：proj[10] ≈ 0，proj[14] = near
  if (Math.abs(a) < EPSILON) {
    const near = Math.max(Math.abs(b), 0.1);
    return [near, near * 1e6];
  }
  // Reversed-Z 透视：proj[10] = near/(far−near), proj[14] = near·far/(far−near)
  // 解方程：far = b/a, near = b/(1+a)
  const far = Math.abs(b / a);
  const denom = 1 + a;
  const near = Math.abs(denom) > EPSILON ? Math.abs(b / denom) : 0.1;
  // 确保 near < far 且都为正
  return [Math.max(Math.min(near, far), EPSILON), Math.max(Math.max(near, far), 1)];
}

// ===================== 坐标与海拔工具 =====================

/**
 * 根据缩放级别计算相机海拔（米）。
 * 公式：altitude = earthCircumference / (2^zoom × tileSize)。
 *
 * @param zoom - 连续缩放级别
 * @returns 海拔（米），正值
 *
 * @example
 * altitudeFromZoom(10); // ≈78271 米
 */
function altitudeFromZoom(zoom: number): number {
  const z = Math.max(0, zoom);
  return EARTH_CIRCUMFERENCE / Math.max(Math.pow(2, z) * TILE_SIZE, EPSILON);
}

/**
 * 根据 zoom、宽高比和 FOV 计算度坐标系中的相机高度。
 * 用于在 degree-space 中构建 lookAt 视图矩阵，
 * 使可见纬度跨度与 zoom 级别一致。
 *
 * @param zoom - 缩放级别
 * @param aspect - 视口宽高比 (width/height)
 * @param fov - 垂直视场角（弧度）
 * @returns degree-space 相机高度
 *
 * @example
 * computeCameraHeightDeg(10, 16/9, Math.PI/4);
 */
function computeCameraHeightDeg(zoom: number, aspect: number, fov: number): number {
  // 经度方向可见跨度（度）：360 / 2^zoom
  const lonSpan = 360 / Math.pow(2, Math.max(0, zoom));
  // 纬度跨度 = 经度跨度 / 宽高比
  const latSpan = lonSpan / Math.max(aspect, EPSILON);
  const halfLat = latSpan * 0.5;
  // 相机高度：halfLat / tan(fov/2)。FOV 趋近零时高度趋近无穷（正交近似）
  const tanHalfFov = Math.tan(Math.max(fov, MIN_FOV_FOR_ORTHO) * 0.5);
  return halfLat / Math.max(tanHalfFov, EPSILON);
}

/**
 * 经纬度 + 海拔 → ECEF 直角坐标（简化球体模型）。
 * ECEF 坐标系：X 指向 (0°N, 0°E)，Y 指向 (0°N, 90°E)，Z 指向北极。
 *
 * @param out - 输出 Float32Array(3)（预分配）
 * @param lon - 经度（度）
 * @param lat - 纬度（度）
 * @param alt - 海拔（米），默认 0
 * @returns out 引用
 *
 * @example
 * const ecef = new Float32Array(3);
 * lonLatAltToECEF(ecef, 116.39, 39.91, 1000);
 */
function lonLatAltToECEF(out: Float32Array, lon: number, lat: number, alt: number = 0): Float32Array {
  const lonRad = lon * DEG_TO_RAD;
  const latRad = lat * DEG_TO_RAD;
  // 球面半径 = WGS84 长半轴 + 海拔
  const r = WGS84_A + alt;
  const cosLat = Math.cos(latRad);
  out[0] = r * cosLat * Math.cos(lonRad);
  out[1] = r * cosLat * Math.sin(lonRad);
  out[2] = r * Math.sin(latRad);
  return out;
}

// ===================== 视图矩阵构建 =====================

/**
 * 在度坐标系（Flat/Mercator-like）中从相机参数构建视图矩阵。
 * 坐标系：x=经度(°)，y=纬度(°)，z=高度(degree-space)。
 * 使用 lookAt 构建，camera eye 基于 center + bearing/pitch 偏移。
 *
 * @param out - 输出视图矩阵 Float32Array(16)（预分配）
 * @param centerLon - 注视点经度（度）
 * @param centerLat - 注视点纬度（度）
 * @param bearing - 方位角（弧度，0=正北）
 * @param pitch - 俯仰角（弧度，0=正俯视）
 * @param cameraHeight - degree-space 相机高度
 * @returns out 引用
 *
 * @example
 * buildFlatViewMatrix(viewMat, 116.39, 39.91, 0, 0.5, 100);
 */
function buildFlatViewMatrix(
  out: Float32Array,
  centerLon: number,
  centerLat: number,
  bearing: number,
  pitch: number,
  cameraHeight: number
): Float32Array {
  // 确保高度为正有限值
  const h = Math.max(cameraHeight, EPSILON);
  const sinP = Math.sin(pitch);
  const cosP = Math.cos(pitch);
  const sinB = Math.sin(bearing);
  const cosB = Math.cos(bearing);

  // 水平偏移：pitch>0 时相机向"后方"偏移（远离观察方向）
  const horizDist = h * sinP;

  // 相机眼点：从目标点向"观察方向的反方向"偏移
  // 观察方向在地面投影 = (sin(bearing), cos(bearing))
  // bearing=0 → 看向北(+y)，相机在南(-y)
  _tmpEye[0] = centerLon - sinB * horizDist;
  _tmpEye[1] = centerLat - cosB * horizDist;
  _tmpEye[2] = h * cosP;

  // 目标点在地面
  _tmpTarget[0] = centerLon;
  _tmpTarget[1] = centerLat;
  _tmpTarget[2] = 0;

  // Up hint：(sin(bearing), cos(bearing), 0) — 屏幕"上"方向对应的世界方向
  // bearing=0 → (0,1,0)=北，bearing=π/2 → (1,0,0)=东
  // 对于所有 pitch < π/2 都不会与 forward 平行
  _tmpUp[0] = sinB;
  _tmpUp[1] = cosB;
  _tmpUp[2] = 0;

  return mat4.lookAt(out, _tmpEye, _tmpTarget, _tmpUp);
}

/**
 * 在 ECEF 坐标系中从相机参数构建视图矩阵。
 * 用于 3D 地球模式和 2.5D→3D 坐标变换过渡。
 *
 * @param out - 输出视图矩阵 Float32Array(16)（预分配）
 * @param centerLon - 注视点经度（度）
 * @param centerLat - 注视点纬度（度）
 * @param bearing - 方位角（弧度）
 * @param pitch - 俯仰角（弧度）
 * @param altitude - 海拔（米）
 * @returns out 引用
 *
 * @example
 * buildECEFViewMatrix(viewMat, 116.39, 39.91, 0, Math.PI/6, 50000);
 */
function buildECEFViewMatrix(
  out: Float32Array,
  centerLon: number,
  centerLat: number,
  bearing: number,
  pitch: number,
  altitude: number
): Float32Array {
  const lonRad = centerLon * DEG_TO_RAD;
  const latRad = centerLat * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);

  // 地表法向量（球面）
  const nx = cosLat * cosLon;
  const ny = cosLat * sinLon;
  const nz = sinLat;

  // 地表 ECEF 坐标
  const sx = WGS84_A * nx;
  const sy = WGS84_A * ny;
  const sz = WGS84_A * nz;

  // 局部东向（East）：(-sinLon, cosLon, 0)
  const ex = -sinLon;
  const ey = cosLon;
  const ez = 0;

  // 局部北向（North）：(-sinLat·cosLon, -sinLat·sinLon, cosLat)
  const northX = -sinLat * cosLon;
  const northY = -sinLat * sinLon;
  const northZ = cosLat;

  // 地面观察方向 = north·cos(bearing) + east·sin(bearing)
  const cosB = Math.cos(bearing);
  const sinB = Math.sin(bearing);
  const lookX = northX * cosB + ex * sinB;
  const lookY = northY * cosB + ey * sinB;
  const lookZ = northZ * cosB + ez * sinB;

  // 相机距地表的垂直和水平分量
  const h = Math.max(altitude, 1);
  const vertDist = h * Math.cos(pitch);
  const horizDist = h * Math.sin(pitch);

  // 相机位置 = 地表 + 法向 × vertDist − 观察方向 × horizDist
  _tmpEye[0] = sx + nx * vertDist - lookX * horizDist;
  _tmpEye[1] = sy + ny * vertDist - lookY * horizDist;
  _tmpEye[2] = sz + nz * vertDist - lookZ * horizDist;

  // 目标 = 地表点
  _tmpTarget[0] = sx;
  _tmpTarget[1] = sy;
  _tmpTarget[2] = sz;

  // Up hint 选择：pitch≈0 时 forward≈-normal，与 normal 平行→用 look 代替
  if (Math.abs(pitch) < ANGLE_EPSILON) {
    _tmpUp[0] = lookX;
    _tmpUp[1] = lookY;
    _tmpUp[2] = lookZ;
  } else {
    // pitch>0 时 forward 与 normal 不平行，用 normal 作为 up hint
    _tmpUp[0] = nx;
    _tmpUp[1] = ny;
    _tmpUp[2] = nz;
  }

  return mat4.lookAt(out, _tmpEye, _tmpTarget, _tmpUp);
}

// ===================== 投影矩阵混合 =====================

/**
 * 基于参数插值构建过渡投影矩阵（Reversed-Z 透视）。
 * 从混合后的 fov/aspect/altitude 计算 near/far 并重建矩阵。
 *
 * @param out - 输出投影矩阵（预分配）
 * @param fov - 混合后的垂直 FOV（弧度）
 * @param aspect - 宽高比
 * @param altitudeMeters - 当前相机海拔（米），用于推算 near/far
 *
 * @example
 * buildMorphProjection(projMat, Math.PI/4, 16/9, 50000);
 */
function buildMorphProjection(
  out: Float32Array,
  fov: number,
  aspect: number,
  altitudeMeters: number
): void {
  // 确保参数合法
  const safeFov = Math.max(fov, MIN_FOV_FOR_ORTHO);
  const safeAspect = Math.max(aspect, 0.1);
  const safeAlt = Math.max(altitudeMeters, 1);
  // near/far 基于海拔动态计算，保证深度缓冲有效范围
  const near = safeAlt * 0.001;
  const far = safeAlt * 100;
  mat4.perspectiveReversedZ(out, safeFov, safeAspect, Math.max(near, 0.01), far);
}

// ===================== 状态终结化 =====================

/**
 * 从 viewMatrix 和 projectionMatrix 计算 vpMatrix、inverseVPMatrix、position、altitude。
 * 在每帧混合完标量参数、viewMatrix、projectionMatrix 之后调用。
 *
 * @param out - 可变相机状态（viewMatrix 和 projectionMatrix 须已填充）
 *
 * @example
 * finalizeBlendedState(mutableState);
 */
function finalizeBlendedState(out: MutableCameraState): void {
  // VP = projection × view
  mat4.multiply(out.vpMatrix, out.projectionMatrix, out.viewMatrix);
  // 求逆；奇异时保持上一帧值（inverseVPMatrix 未清零则自然保留）
  const inv = mat4.invert(out.inverseVPMatrix, out.vpMatrix);
  if (inv === null) {
    mat4.identity(out.inverseVPMatrix);
  }
  // altitude 从 zoom 推算
  out.altitude = altitudeFromZoom(out.zoom);
}

/**
 * 根据混合模式计算 position 字段。
 * ecefBlend=0 时用 degree-space 近似米，ecefBlend=1 时用 ECEF。
 *
 * @param out - 可变相机状态
 * @param ecefBlend - ECEF 混合因子 [0, 1]
 *
 * @example
 * computeBlendedPosition(mutableState, 0.5);
 */
function computeBlendedPosition(out: MutableCameraState, ecefBlend: number): void {
  // 度→近似米（赤道附近 1°≈111320m）
  const latRad = out.center[1] * DEG_TO_RAD;
  const mPerDegLon = 111320 * Math.max(Math.cos(latRad), EPSILON);
  const mPerDegLat = 111320;
  const flatX = out.center[0] * mPerDegLon;
  const flatY = out.center[1] * mPerDegLat;
  const flatZ = out.altitude;

  if (ecefBlend < EPSILON) {
    // 纯 flat
    out.position[0] = flatX;
    out.position[1] = flatY;
    out.position[2] = flatZ;
  } else if (ecefBlend > 1 - EPSILON) {
    // 纯 ECEF
    lonLatAltToECEF(out.position, out.center[0], out.center[1], out.altitude);
  } else {
    // 混合
    lonLatAltToECEF(_tmpEye, out.center[0], out.center[1], out.altitude);
    out.position[0] = lerpScalar(flatX, _tmpEye[0], ecefBlend);
    out.position[1] = lerpScalar(flatY, _tmpEye[1], ecefBlend);
    out.position[2] = lerpScalar(flatZ, _tmpEye[2], ecefBlend);
  }
}

// ===================== 过渡方向确定 =====================

/**
 * 从源模式和目标模式确定过渡方向。
 *
 * @param from - 源视图模式
 * @param to - 目标视图模式
 * @returns 过渡类型标识
 *
 * @example
 * getTransitionKind('2d', '3d'); // '2d-3d'
 */
function getTransitionKind(from: ViewMode, to: ViewMode): TransitionKind {
  if (from === to) { return 'same'; }
  if (from === '2d'  && to === '25d') { return '2d-25d'; }
  if (from === '25d' && to === '3d')  { return '25d-3d'; }
  if (from === '2d'  && to === '3d')  { return '2d-3d'; }
  if (from === '3d'  && to === '2d')  { return '3d-2d'; }
  if (from === '3d'  && to === '25d') { return '3d-25d'; }
  if (from === '25d' && to === '2d')  { return '25d-2d'; }
  return 'same';
}

// ===================== 过渡混合核心算法 =====================

/**
 * 2D → 2.5D 单阶段过渡。
 * - pitch: 0 → targetPitch
 * - bearing: 0 → targetBearing（最短弧）
 * - zoom: fromZoom → toZoom
 * - center: 线性插值
 * - 投影：正交 → 透视（fov 从 MIN_FOV_FOR_ORTHO 到目标值）
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（2D）
 * @param to - 目标状态快照（2.5D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend2DTo25D(blended, fromSnap, toSnap, easedT, options);
 */
function blend2DTo25D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  // 标量参数插值
  out.center[0] = lerpScalar(from.center[0], to.center[0], t);
  out.center[1] = lerpScalar(from.center[1], to.center[1], t);
  out.zoom = lerpScalar(from.zoom, to.zoom, t);
  out.bearing = lerpAngle(from.bearing, to.bearing, t);
  out.pitch = lerpScalar(from.pitch, to.pitch, t);
  out.roll = lerpScalar(from.roll, to.roll, t);

  // FOV 从正交替代值渐变到目标透视 FOV
  const fromFov = Math.max(extractFov(from.projectionMatrix), MIN_FOV_FOR_ORTHO);
  const toFov = Math.max(extractFov(to.projectionMatrix), MIN_FOV_FOR_ORTHO);
  out.fov = lerpScalar(fromFov, toFov, t);

  // 投影矩阵
  const aspect = extractAspect(from.projectionMatrix);
  if (opts.projectionBlendMethod === 'matrix') {
    lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
  } else {
    // 参数法：从当前 fov/altitude 构建 Reversed-Z 透视
    const alt = altitudeFromZoom(out.zoom);
    buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
  }

  // 视图矩阵：从混合参数重建 flat lookAt
  const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
  buildFlatViewMatrix(out.viewMatrix, out.center[0], out.center[1], out.bearing, out.pitch, camH);

  // 终结化：VP、invVP、position
  finalizeBlendedState(out);
  computeBlendedPosition(out, 0);
}

/**
 * 2.5D → 3D 单阶段过渡（含坐标系变换 Mercator → ECEF）。
 * - 标量参数线性插值
 * - 视图矩阵：flat 和 ECEF 两路构建后逐元素混合
 * - 投影：透视 → 透视（参数或矩阵混合）
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（2.5D）
 * @param to - 目标状态快照（3D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend25DTo3D(blended, fromSnap, toSnap, easedT, options);
 */
function blend25DTo3D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  // 标量参数插值
  out.center[0] = lerpScalar(from.center[0], to.center[0], t);
  out.center[1] = lerpScalar(from.center[1], to.center[1], t);
  out.zoom = lerpScalar(from.zoom, to.zoom, t);
  out.bearing = lerpAngle(from.bearing, to.bearing, t);
  out.pitch = lerpScalar(from.pitch, to.pitch, t);
  out.roll = lerpScalar(from.roll, to.roll, t);

  // FOV 插值（两端均为透视）
  const fromFov = extractFov(from.projectionMatrix);
  const toFov = extractFov(to.projectionMatrix);
  out.fov = lerpScalar(fromFov, toFov, t);

  const aspect = extractAspect(from.projectionMatrix);
  const alt = altitudeFromZoom(out.zoom);

  // 投影矩阵
  if (opts.projectionBlendMethod === 'matrix') {
    lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
  } else {
    buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
  }

  // 视图矩阵：坐标系变换混合
  // 构建 flat 视图矩阵
  const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
  buildFlatViewMatrix(_tmpMat4A, out.center[0], out.center[1], out.bearing, out.pitch, camH);
  // 构建 ECEF 视图矩阵
  buildECEFViewMatrix(_tmpMat4B, out.center[0], out.center[1], out.bearing, out.pitch, alt);
  // 逐元素混合：t=0 → flat，t=1 → ECEF
  lerpMatrix(out.viewMatrix, _tmpMat4A, _tmpMat4B, t);

  // 终结化
  finalizeBlendedState(out);
  // position 也做坐标系混合
  computeBlendedPosition(out, t);
}

/**
 * 2D → 3D 两阶段过渡。
 * Phase 1 (0 → 0.4)：2D → 2.5D（pitch 升至 60°，zoom 拉远，ortho→perspective）
 * Phase 2 (0.4 → 1.0)：2.5D → 3D（坐标系 Mercator → ECEF）
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（2D）
 * @param to - 目标状态快照（3D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend2DTo3D(blended, fromSnap, toSnap, easedT, options);
 */
function blend2DTo3D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  const phase1End = DEFAULT_PHASE1_END_2D_TO_3D;

  // 全程线性插值的参数（中心、bearing 跨越两个阶段连续变化）
  out.center[0] = lerpScalar(from.center[0], to.center[0], t);
  out.center[1] = lerpScalar(from.center[1], to.center[1], t);
  out.bearing = lerpAngle(from.bearing, to.bearing, t);
  out.roll = lerpScalar(from.roll, to.roll, t);

  // 中间态参数：Phase1 末尾的 zoom 和 pitch
  const zoomMid = Math.max(0, Math.min(from.zoom, to.zoom) - opts.maxZoomOffset);
  const aspect = extractAspect(from.projectionMatrix);
  const fromFov = Math.max(extractFov(from.projectionMatrix), MIN_FOV_FOR_ORTHO);
  const toFov = extractFov(to.projectionMatrix);

  if (t <= phase1End) {
    // ====== Phase 1：2D → 2.5D-like ======
    const pt = phase1End > EPSILON ? t / phase1End : 1;

    // pitch 从 0 升到中间态 60°
    out.pitch = lerpScalar(from.pitch, INTERMEDIATE_PITCH_RAD, pt);
    // zoom 从起始值降到中间值（拉远）
    out.zoom = lerpScalar(from.zoom, zoomMid, pt);
    // FOV 从正交替代值过渡到标准透视 FOV
    out.fov = lerpScalar(fromFov, DEFAULT_PERSPECTIVE_FOV, pt);

    // 投影矩阵
    if (opts.projectionBlendMethod === 'matrix') {
      // 矩阵法：直接按全程进度插值两端矩阵
      lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
    } else {
      const alt = altitudeFromZoom(out.zoom);
      buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
    }

    // 视图矩阵：flat 重建
    const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
    buildFlatViewMatrix(out.viewMatrix, out.center[0], out.center[1], out.bearing, out.pitch, camH);

    // 终结化（Phase 1 全程在 flat 坐标系）
    finalizeBlendedState(out);
    computeBlendedPosition(out, 0);
  } else {
    // ====== Phase 2：2.5D-like → 3D ======
    const phase2Span = 1 - phase1End;
    const pt = phase2Span > EPSILON ? (t - phase1End) / phase2Span : 1;

    // pitch 从中间态 60° 到目标
    out.pitch = lerpScalar(INTERMEDIATE_PITCH_RAD, to.pitch, pt);
    // zoom 从中间值回升到目标值
    out.zoom = lerpScalar(zoomMid, to.zoom, pt);
    // FOV 从标准透视过渡到目标 FOV
    out.fov = lerpScalar(DEFAULT_PERSPECTIVE_FOV, toFov, pt);

    const alt = altitudeFromZoom(out.zoom);

    // 投影矩阵
    if (opts.projectionBlendMethod === 'matrix') {
      lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
    } else {
      buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
    }

    // 视图矩阵：坐标系变换混合（flat → ECEF）
    const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
    buildFlatViewMatrix(_tmpMat4A, out.center[0], out.center[1], out.bearing, out.pitch, camH);
    buildECEFViewMatrix(_tmpMat4B, out.center[0], out.center[1], out.bearing, out.pitch, alt);
    lerpMatrix(out.viewMatrix, _tmpMat4A, _tmpMat4B, pt);

    // 终结化
    finalizeBlendedState(out);
    computeBlendedPosition(out, pt);
  }
}

/**
 * 3D → 2D 两阶段过渡（2D→3D 的逆过程）。
 * Phase 1 (0 → 0.6)：3D → 2.5D-like（ECEF → Mercator 坐标变换）
 * Phase 2 (0.6 → 1.0)：2.5D-like → 2D（perspective → ortho，pitch → 0）
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（3D）
 * @param to - 目标状态快照（2D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend3DTo2D(blended, fromSnap, toSnap, easedT, options);
 */
function blend3DTo2D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  const phase1End = DEFAULT_PHASE1_END_3D_TO_2D;

  // 全程线性插值参数
  out.center[0] = lerpScalar(from.center[0], to.center[0], t);
  out.center[1] = lerpScalar(from.center[1], to.center[1], t);
  out.bearing = lerpAngle(from.bearing, to.bearing, t);
  out.roll = lerpScalar(from.roll, to.roll, t);

  // 中间态参数
  const zoomMid = Math.max(0, Math.min(from.zoom, to.zoom) - opts.maxZoomOffset);
  const aspect = extractAspect(from.projectionMatrix);
  const fromFov = extractFov(from.projectionMatrix);
  const toFov = Math.max(extractFov(to.projectionMatrix), MIN_FOV_FOR_ORTHO);

  if (t <= phase1End) {
    // ====== Phase 1：3D → 2.5D-like（ECEF → flat 坐标变换）======
    const pt = phase1End > EPSILON ? t / phase1End : 1;

    // pitch 从 3D 值降到中间态 60°
    out.pitch = lerpScalar(from.pitch, INTERMEDIATE_PITCH_RAD, pt);
    // zoom 从 3D 值降到中间值
    out.zoom = lerpScalar(from.zoom, zoomMid, pt);
    // FOV 从 3D 值过渡到标准透视
    out.fov = lerpScalar(fromFov, DEFAULT_PERSPECTIVE_FOV, pt);

    const alt = altitudeFromZoom(out.zoom);

    // 投影矩阵
    if (opts.projectionBlendMethod === 'matrix') {
      lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
    } else {
      buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
    }

    // 视图矩阵：坐标变换混合（ECEF → flat），注意 1−pt 使 ECEF 权重从 1→0
    const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
    buildFlatViewMatrix(_tmpMat4A, out.center[0], out.center[1], out.bearing, out.pitch, camH);
    buildECEFViewMatrix(_tmpMat4B, out.center[0], out.center[1], out.bearing, out.pitch, alt);
    lerpMatrix(out.viewMatrix, _tmpMat4B, _tmpMat4A, pt);

    finalizeBlendedState(out);
    computeBlendedPosition(out, 1 - pt);
  } else {
    // ====== Phase 2：2.5D-like → 2D（pitch→0，perspective→ortho）======
    const phase2Span = 1 - phase1End;
    const pt = phase2Span > EPSILON ? (t - phase1End) / phase2Span : 1;

    // pitch 从中间态 60° 降到 2D 的 0
    out.pitch = lerpScalar(INTERMEDIATE_PITCH_RAD, to.pitch, pt);
    // zoom 从中间值回升到 2D 值
    out.zoom = lerpScalar(zoomMid, to.zoom, pt);
    // FOV 从标准透视过渡到正交替代值
    out.fov = lerpScalar(DEFAULT_PERSPECTIVE_FOV, toFov, pt);

    // 投影矩阵
    if (opts.projectionBlendMethod === 'matrix') {
      lerpMatrix(out.projectionMatrix, from.projectionMatrix, to.projectionMatrix, t);
    } else {
      const alt = altitudeFromZoom(out.zoom);
      buildMorphProjection(out.projectionMatrix, out.fov, aspect, alt);
    }

    // 视图矩阵：flat 重建（Phase 2 全程在 flat 坐标系）
    const camH = computeCameraHeightDeg(out.zoom, aspect, out.fov);
    buildFlatViewMatrix(out.viewMatrix, out.center[0], out.center[1], out.bearing, out.pitch, camH);

    finalizeBlendedState(out);
    computeBlendedPosition(out, 0);
  }
}

/**
 * 3D → 2.5D 单阶段过渡（2.5D→3D 的逆过程）。
 * 复用 blend25DTo3D 逻辑，交换 from/to 并反转进度。
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（3D）
 * @param to - 目标状态快照（2.5D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend3DTo25D(blended, fromSnap, toSnap, easedT, options);
 */
function blend3DTo25D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  // 逆向：from/to 交换，进度反转
  blend25DTo3D(out, to, from, 1 - t, opts);
}

/**
 * 2.5D → 2D 单阶段过渡（2D→2.5D 的逆过程）。
 * 复用 blend2DTo25D 逻辑，交换 from/to 并反转进度。
 *
 * @param out - 输出混合状态
 * @param from - 源状态快照（2.5D）
 * @param to - 目标状态快照（2D）
 * @param t - 缓动后的进度 [0, 1]
 * @param opts - 已规范化的选项
 *
 * @example
 * blend25DTo2D(blended, fromSnap, toSnap, easedT, options);
 */
function blend25DTo2D(
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  // 逆向：from/to 交换，进度反转
  blend2DTo25D(out, to, from, 1 - t, opts);
}

/**
 * 根据过渡类型分发到对应的混合函数。
 *
 * @param kind - 过渡类型
 * @param out - 输出混合状态
 * @param from - 源状态快照
 * @param to - 目标状态快照
 * @param t - 缓动后进度 [0, 1]
 * @param opts - 已规范化选项
 *
 * @example
 * dispatchBlend('2d-3d', out, from, to, 0.5, opts);
 */
function dispatchBlend(
  kind: TransitionKind,
  out: MutableCameraState,
  from: MutableCameraState,
  to: MutableCameraState,
  t: number,
  opts: ResolvedOptions
): void {
  switch (kind) {
    case '2d-25d':
      blend2DTo25D(out, from, to, t, opts);
      break;
    case '25d-3d':
      blend25DTo3D(out, from, to, t, opts);
      break;
    case '2d-3d':
      blend2DTo3D(out, from, to, t, opts);
      break;
    case '3d-2d':
      blend3DTo2D(out, from, to, t, opts);
      break;
    case '3d-25d':
      blend3DTo25D(out, from, to, t, opts);
      break;
    case '25d-2d':
      blend25DTo2D(out, from, to, t, opts);
      break;
    case 'same':
      // 同模式：直接使用目标状态
      snapshotCameraState(out, to as unknown as CameraState);
      break;
    default: {
      // 兜底：不应到达；使用目标状态
      if (__DEV__) {
        console.warn(`[ViewMorph] 未知过渡类型: ${kind as string}`);
      }
      snapshotCameraState(out, to as unknown as CameraState);
    }
  }
}

// ===================== 选项规范化 =====================

/**
 * 将用户传入的可选参数合并默认值，输出完整选项对象。
 *
 * @param opts - 用户传入的可选参数
 * @returns 完整选项
 *
 * @example
 * const resolved = resolveOptions({ duration: 3000 });
 */
function resolveOptions(opts?: ViewMorphOptions): ResolvedOptions {
  const duration = clampValue(opts?.duration ?? DEFAULT_MORPH_DURATION, MIN_MORPH_DURATION, MAX_MORPH_DURATION);
  const easing = opts?.easing ?? easeInOutCubic;
  const maxZoomOffset = clampValue(opts?.maxZoomOffset ?? DEFAULT_MAX_ZOOM_OFFSET, 0, 5);
  const projectionBlendMethod = opts?.projectionBlendMethod ?? 'parameter';
  return { duration, easing, maxZoomOffset, projectionBlendMethod };
}

// ===================== ViewMorph 实现 =====================

/**
 * ViewMorph 内部实现。
 * 管理活跃过渡状态、回调集合和预分配缓冲区。
 */
class ViewMorphImpl implements ViewMorph {
  /** 预分配的混合输出状态 */
  private readonly _blended: MutableCameraState = createMutableCameraState();

  /** 捕获的源状态快照缓冲区 */
  private readonly _fromBuf: MutableCameraState = createMutableCameraState();

  /** 捕获的目标状态快照缓冲区 */
  private readonly _toBuf: MutableCameraState = createMutableCameraState();

  /** 当前活跃过渡（null 表示无过渡） */
  private _active: ActiveMorph | null = null;

  /** 当前暴露给外部的过渡进度 */
  private _progress: number = 0;

  /** 当前源模式（无过渡时为 '2d'） */
  private _currentMode: ViewMode = '2d';

  /** 当前目标模式 */
  private _targetMode: ViewMode = '2d';

  /** 过渡开始回调集 */
  private readonly _startCbs: Set<() => void> = new Set();

  /** 过渡进度回调集 */
  private readonly _progressCbs: Set<(p: number) => void> = new Set();

  /** 过渡结束回调集 */
  private readonly _endCbs: Set<() => void> = new Set();

  /** 销毁标记 */
  private _destroyed: boolean = false;

  /**
   * 获取当前过渡状态的只读快照。
   *
   * @returns ViewMorphState
   *
   * @example
   * const { isMorphing, progress } = morph.state;
   */
  get state(): ViewMorphState {
    return {
      isMorphing: this._active !== null && !this._active.cancelled,
      progress: this._progress,
      currentMode: this._currentMode,
      targetMode: this._targetMode,
      blendedState: this._blended as unknown as CameraState,
    };
  }

  /**
   * 启动视图模式过渡。
   * 先取消已有过渡，再捕获两端状态并创建新的活跃过渡。
   *
   * @param targetMode - 目标视图模式
   * @param fromCamera - 源相机控制器
   * @param toCamera - 目标相机控制器
   * @param options - 可选过渡参数
   * @returns ViewMorphAnimation 句柄
   *
   * @example
   * const anim = morph.morphTo('3d', cam2d, cam3d, { duration: 2500 });
   */
  morphTo(
    targetMode: ViewMode,
    fromCamera: CameraController,
    toCamera: CameraController,
    options?: ViewMorphOptions
  ): ViewMorphAnimation {
    this._checkDestroyed();

    // 取消已有过渡（如果有）
    this.cancel();

    // 推断源模式：优先从 CameraController.type 获取
    const fromMode = (fromCamera.type as ViewMode) || '2d';
    this._currentMode = fromMode;
    this._targetMode = targetMode;

    // 确定过渡方向
    const kind = getTransitionKind(fromMode, targetMode);

    // 同模式快速路径：立即完成
    if (kind === 'same') {
      snapshotCameraState(this._blended, toCamera.state);
      this._progress = 1;
      this._currentMode = targetMode;
      // 返回已 resolve 的句柄
      const animation: ViewMorphAnimation = {
        finished: Promise.resolve(),
        cancel: () => { /* 已完成，无操作 */ },
      };
      return animation;
    }

    // 深拷贝两端相机状态（快照当前帧，避免后续帧被修改）
    snapshotCameraState(this._fromBuf, fromCamera.state);
    snapshotCameraState(this._toBuf, toCamera.state);

    // 规范化选项
    const resolved = resolveOptions(options);

    // 创建 Promise 用于 finished 信号
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    // 初始化活跃过渡
    this._active = {
      kind,
      fromMode,
      targetMode,
      fromSnap: this._fromBuf,
      toSnap: this._toBuf,
      options: resolved,
      elapsedMs: 0,
      resolve: resolveFinished,
      cancelled: false,
    };
    this._progress = 0;

    // 初始混合：t=0 时应匹配源状态
    dispatchBlend(kind, this._blended, this._fromBuf, this._toBuf, 0, resolved);

    // 触发开始回调
    this._fireCallbacks(this._startCbs);

    // 构建动画句柄
    const self = this;
    const animation: ViewMorphAnimation = {
      finished,
      cancel(): void {
        self.cancel();
      },
    };
    return animation;
  }

  /**
   * 取消当前过渡。
   * 将 active morph 标记为 cancelled 并 resolve finished Promise。
   *
   * @example
   * morph.cancel();
   */
  cancel(): void {
    const active = this._active;
    if (active === null || active.cancelled) {
      return;
    }
    // 标记取消
    active.cancelled = true;
    this._active = null;
    // resolve finished Promise（使 await 方不再挂起）
    try {
      active.resolve();
    } catch (err) {
      if (__DEV__) {
        console.error('[ViewMorph] cancel resolve error', err);
      }
    }
    // 触发结束回调
    this._fireCallbacks(this._endCbs);
  }

  /**
   * 每帧更新：推进过渡进度并计算混合状态。
   *
   * @param deltaTime - 距上一帧时间（秒）
   * @returns 混合后的 CameraState，或 null（无活跃过渡）
   *
   * @example
   * const blended = morph.update(1/60);
   */
  update(deltaTime: number): CameraState | null {
    this._checkDestroyed();

    const active = this._active;
    if (active === null || active.cancelled) {
      return null;
    }

    // deltaTime 安全检查
    const dtSec = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    const dtMs = dtSec * 1000;

    // 推进时间
    active.elapsedMs += dtMs;
    const durationMs = active.options.duration;

    // 计算线性进度并钳制到 [0, 1]
    const linearT = clampValue(active.elapsedMs / Math.max(durationMs, 1), 0, 1);

    // 应用缓动函数
    let easedT: number;
    try {
      easedT = clampValue(active.options.easing(linearT), 0, 1);
    } catch {
      // 缓动函数异常时回退线性
      easedT = linearT;
    }

    this._progress = linearT;

    // 分发到对应混合算法
    dispatchBlend(active.kind, this._blended, active.fromSnap, active.toSnap, easedT, active.options);

    // 触发进度回调
    this._fireProgressCallbacks(linearT);

    // 检查是否完成
    if (linearT >= 1) {
      // 确保最终状态精确匹配目标
      this._progress = 1;
      this._currentMode = active.targetMode;
      const resolveRef = active.resolve;
      this._active = null;
      // resolve finished Promise
      try {
        resolveRef();
      } catch (err) {
        if (__DEV__) {
          console.error('[ViewMorph] finish resolve error', err);
        }
      }
      // 触发结束回调
      this._fireCallbacks(this._endCbs);
    }

    return this._blended as unknown as CameraState;
  }

  /**
   * 注册过渡开始回调。
   *
   * @param callback - 过渡开始时调用
   * @returns 取消订阅函数
   *
   * @example
   * const unsub = morph.onMorphStart(() => console.log('开始'));
   * unsub(); // 取消订阅
   */
  onMorphStart(callback: () => void): () => void {
    this._startCbs.add(callback);
    return () => { this._startCbs.delete(callback); };
  }

  /**
   * 注册过渡进度回调。
   *
   * @param callback - 传入进度 [0, 1]
   * @returns 取消订阅函数
   *
   * @example
   * const unsub = morph.onMorphProgress(p => console.log(p));
   */
  onMorphProgress(callback: (progress: number) => void): () => void {
    this._progressCbs.add(callback);
    return () => { this._progressCbs.delete(callback); };
  }

  /**
   * 注册过渡结束回调。
   *
   * @param callback - 过渡完成或取消时调用
   * @returns 取消订阅函数
   *
   * @example
   * const unsub = morph.onMorphEnd(() => console.log('结束'));
   */
  onMorphEnd(callback: () => void): () => void {
    this._endCbs.add(callback);
    return () => { this._endCbs.delete(callback); };
  }

  /**
   * 销毁控制器，释放所有资源。
   * 取消活跃过渡，清空回调集。
   *
   * @example
   * morph.destroy();
   */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    // 取消活跃过渡
    this.cancel();
    // 清空所有回调
    this._startCbs.clear();
    this._progressCbs.clear();
    this._endCbs.clear();
  }

  /**
   * 安全触发回调集合中的所有回调。
   * 单个回调抛出异常不影响其余回调执行。
   *
   * @param cbs - 回调集合
   */
  private _fireCallbacks(cbs: Set<() => void>): void {
    for (const cb of cbs) {
      try {
        cb();
      } catch (err) {
        if (__DEV__) {
          console.error('[ViewMorph] callback error', err);
        }
      }
    }
  }

  /**
   * 安全触发进度回调。
   *
   * @param progress - 当前进度 [0, 1]
   */
  private _fireProgressCallbacks(progress: number): void {
    for (const cb of this._progressCbs) {
      try {
        cb(progress);
      } catch (err) {
        if (__DEV__) {
          console.error('[ViewMorph] progress callback error', err);
        }
      }
    }
  }

  /**
   * 检查是否已销毁，已销毁则抛出错误。
   */
  private _checkDestroyed(): void {
    if (this._destroyed) {
      throw new Error('[ViewMorph] controller has been destroyed');
    }
  }
}

// ===================== 工厂函数 =====================

/**
 * 创建视图过渡控制器。
 * 返回的控制器管理 2D ↔ 2.5D ↔ 3D 相机过渡的全部状态。
 * 内部预分配所有矩阵和向量缓冲区，update() 为零分配。
 *
 * @returns ViewMorph 实例
 *
 * @stability experimental
 *
 * @example
 * const morph = createViewMorph();
 * const anim = morph.morphTo('3d', camera2d, camera3d, { duration: 2000 });
 *
 * // 每帧 UPDATE 阶段
 * function onFrame(dt: number) {
 *   const blended = morph.update(dt);
 *   if (blended) {
 *     renderer.setCamera(blended);
 *   }
 * }
 *
 * // 清理
 * morph.destroy();
 */
export function createViewMorph(): ViewMorph {
  return new ViewMorphImpl();
}
