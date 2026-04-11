// ============================================================
// @gis-forge/preset-25d — Map25D（2.5D 地图，继承 Map2D）
// 在 2D 基础上提供俯仰/方位角/光照 API；俯仰上限默认 85°。
// 俯仰与方位角的**公共 API 使用度（°）**，与 maxPitch 单位一致；
// 内部通过 jumpTo/flyTo 与 Map2D 的弧度制相机对齐。
//
// 投影矩阵由 Camera25D（camera-25d 包）计算：
// - 透视 Reversed-Z（perspectiveReversedZ）替代正交投影
// - bearing / pitch 反映到 lookAt 视图矩阵
// - 输出 vpMatrix 原生工作在相机相对坐标系（lookAt 已减去 center）
// ============================================================

import type { LightSpec } from '../../core/src/types/style-spec.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import { createCamera25D, type Camera25D } from '../../camera-25d/src/Camera25D.ts';

import { GeoForgeError, GeoForgeErrorCode, Map2D } from '../../preset-2d/src/map-2d.ts';
import type { AnimationOptions, Map2DOptions } from '../../preset-2d/src/map-2d.ts';
import type { LayerSpec } from '../../scene/src/layer-manager.ts';
import type { RasterTileLayer } from '../../layer-tile-raster/src/RasterTileLayer.ts';

// --- 从 L0 再导出光照类型（与 StyleSpec.light 一致） ---
export type { LightSpec } from '../../core/src/types/style-spec.ts';

// ============================================================
// 常量
// ============================================================

/** 默认最大俯仰角（度），对标常见 Web 地图可倾斜上限。 */
const DEFAULT_MAX_PITCH_DEG = 85;

/** 全圆角度（度）。 */
const FULL_CIRCLE_DEG = 360;

/** 将度转为弧度（用于调用 Map2D / FlyToOptions）。 */
const DEG2RAD = Math.PI / 180;

/** 将弧度转为度（用于对外 getter）。 */
const RAD2DEG = 180 / Math.PI;

/**
 * 中键拖拽灵敏度——垂直方向：每 CSS 像素对应的俯仰角变化（度）。
 * 值越大，鼠标拖动相同距离时 pitch 变化越快。
 * 0.3 deg/px ≈ 拖 200px 改变 60°，在 1080p 屏幕上手感适中。
 */
const PITCH_SENSITIVITY_DEG = 0.3;

/**
 * 中键拖拽灵敏度——水平方向：每 CSS 像素对应的方位角变化（度）。
 * 0.5 deg/px ≈ 拖 180px 旋转 90°。
 */
const BEARING_SENSITIVITY_DEG = 0.5;

/** 鼠标中键编号（MouseEvent.button）。 */
const MIDDLE_BUTTON = 1;

/**
 * 与 MapLibre 风格对齐的默认全局光照（与 core/types/style-spec LightSpec 一致）。
 */
const DEFAULT_LIGHT: LightSpec = {
  anchor: 'viewport',
  color: '#ffffff',
  intensity: 0.5,
  position: [1.15, 210, 30],
};

// ============================================================
// 模块级暂存缓冲区（避免每帧分配）
// ============================================================


// ============================================================
// 纯函数
// ============================================================

/**
 * Map25D 构造选项：在 {@link Map2DOptions} 基础上增加 2.5D 参数。
 */
export interface Map25DOptions extends Map2DOptions {
  /**
   * 初始俯仰角（度）。
   * 范围 [0, maxPitch]；默认 0（正俯视）。
   */
  readonly pitch?: number;

  /**
   * 初始方位角（度）。
   * 范围 [0, 360)；0 表示正北，顺时针为正。
   */
  readonly bearing?: number;

  /**
   * 允许的最大俯仰角（度）。
   * 默认 85。
   */
  readonly maxPitch?: number;
}

/**
 * 将角度归一化到 [0, 360) 度区间。
 *
 * @param deg - 方位角（度），可为任意有限值
 * @returns 归一化后的角度（度）
 *
 * @example
 * normalizeBearingDeg(370); // 10
 */
export function normalizeBearingDeg(deg: number): number {
  // 非有限输入：无法定义方向，返回 0 作为安全默认值
  if (!Number.isFinite(deg)) {
    return 0;
  }
  // 使用模运算将任意角度折叠到 [0, 360)
  let x = deg % FULL_CIRCLE_DEG;
  if (x < 0) {
    x += FULL_CIRCLE_DEG;
  }
  return x;
}

/**
 * 将俯仰角限制在 [0, maxPitchDeg]（度）。
 *
 * @param pitchDeg - 俯仰角（度）
 * @param maxPitchDeg - 上限（度）
 * @returns 钳制后的俯仰角（度）
 *
 * @example
 * clampPitchDeg(100, 85); // 85
 */
export function clampPitchDeg(pitchDeg: number, maxPitchDeg: number): number {
  // 输入非法时直接返回 0，避免 NaN 传播到 GPU 矩阵
  if (!Number.isFinite(pitchDeg) || !Number.isFinite(maxPitchDeg)) {
    return 0;
  }
  const hi = Math.max(0, maxPitchDeg);
  if (pitchDeg < 0) {
    return 0;
  }
  if (pitchDeg > hi) {
    return hi;
  }
  return pitchDeg;
}

/**
 * 合并两个 LightSpec，后者覆盖前者。
 *
 * @param base - 基础光照
 * @param patch - 覆盖项
 * @returns 合并后的新对象
 *
 * @example
 * mergeLight(DEFAULT_LIGHT, { intensity: 0.8 });
 */
export function mergeLight(base: LightSpec, patch: Partial<LightSpec> | undefined): LightSpec {
  const cloneTuple = (p: readonly [number, number, number]): [number, number, number] => [
    p[0],
    p[1],
    p[2],
  ];
  // patch 为空时直接浅拷贝 base，避免共享引用被外部修改
  if (patch === undefined) {
    return {
      anchor: base.anchor,
      color: base.color,
      intensity: base.intensity,
      position: base.position !== undefined ? cloneTuple(base.position) : undefined,
    };
  }
  const pos: [number, number, number] | undefined =
    patch.position !== undefined
      ? cloneTuple(patch.position)
      : base.position !== undefined
        ? cloneTuple(base.position)
        : undefined;
  return {
    anchor: patch.anchor ?? base.anchor,
    color: patch.color ?? base.color,
    intensity: patch.intensity ?? base.intensity,
    position: pos,
  };
}

// ============================================================
// Map25D 类
// ============================================================

/**
 * Map25D：在 {@link Map2D} 上增加俯仰、方位角与光照控制。
 *
 * 投影矩阵由 {@link Camera25D}（camera-25d 包）生成：
 * - 使用 `perspectiveReversedZ` 透视投影
 * - 视图矩阵由 `lookAt(eye, target, up)` 构建，支持 bearing/pitch
 * - 输出 vpMatrix 经过坐标适配，可直接用于相机相对顶点
 *
 * @example
 * const map = new Map25D({ container: '#map', pitch: 45, bearing: 20, maxPitch: 60 });
 */
export class Map25D extends Map2D {
  /**
   * 最大俯仰角（度），由构造选项确定。
   */
  private readonly _maxPitch: number;

  /**
   * 当前全局光照参数（影响建筑拉伸等图层）。
   */
  private _light: LightSpec;

  /**
   * 仅用于矩阵计算的 Camera25D 实例。
   * 状态由 Map2D 管理（center/zoom/bearing/pitch），每帧通过 jumpTo 同步。
   * Camera25D 不参与事件、交互或动画——只负责 Reversed-Z 透视 VP 矩阵的生成。
   */
  private readonly _cam25d: Camera25D;

  // ── 中键拖拽 pitch/bearing 状态 ──

  /** 中键拖拽是否激活。 */
  private _pitchDragActive = false;

  /** 中键拖拽上一帧的屏幕坐标 [clientX, clientY]。 */
  private _pitchDragLastPt: [number, number] | null = null;

  /** 中键拖拽事件监听器清理函数（remove 时调用）。 */
  private _pitchDragCleanup: (() => void) | null = null;

  /**
   * @param options - 2D + 2.5D 选项
   *
   * @example
   * new Map25D({ container: '#map', pitch: 30, bearing: 90 });
   */
  public constructor(options: Map25DOptions) {
    // 先完成 Map2D 初始化（挂载 canvas、解析中心与缩放）
    super(options);
    const maxPitchDeg = options.maxPitch ?? DEFAULT_MAX_PITCH_DEG;
    if (!Number.isFinite(maxPitchDeg) || maxPitchDeg <= 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'maxPitch 必须为正有限数', {
        maxPitch: maxPitchDeg,
      });
    }
    this._maxPitch = maxPitchDeg;
    this._light = mergeLight(DEFAULT_LIGHT, undefined);

    // 创建 Camera25D（仅用于 VP 矩阵，不管理状态）
    const pDeg = clampPitchDeg(options.pitch ?? 0, maxPitchDeg);
    const bDeg = normalizeBearingDeg(options.bearing ?? 0);
    this._cam25d = createCamera25D({
      center: options.center ?? [0, 0],
      zoom: options.zoom ?? 1,
      bearing: bDeg * DEG2RAD,
      pitch: pDeg * DEG2RAD,
      maxPitch: maxPitchDeg * DEG2RAD,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom,
    });

    // 应用初始俯仰/方位到 Map2D（度 → 弧度）
    try {
      this.jumpTo({
        pitch: pDeg * DEG2RAD,
        bearing: bDeg * DEG2RAD,
      });
    } catch (err) {
      // jumpTo 已校验；若仍失败，包装为统一错误
      throw new GeoForgeError(
        GeoForgeErrorCode.CONFIG_INVALID_VIEW,
        'Map25D 初始相机状态非法',
        { pitch: options.pitch, bearing: options.bearing },
        err,
      );
    }

    // GPU 初始化完成后安装 2.5D 专属交互（中键拖拽 pitch/bearing）
    void this.ready().then(() => {
      this._install25DInteractions();
    });
  }

  // ==================== 2.5D 交互 ====================

  /**
   * 安装 2.5D 专属交互手势——鼠标中键（滚轮按钮）拖拽控制 pitch / bearing。
   *
   * 手势映射：
   * - **垂直拖拽（dy）→ pitch**：向上拖 → pitch 增大（趋向地平线），向下拖 → pitch 减小（趋向俯视）
   * - **水平拖拽（dx）→ bearing**：向左拖 → 顺时针旋转，向右拖 → 逆时针旋转
   *
   * 内部通过 `jumpTo({ pitch, bearing })` 更新 Map2D 权威状态，
   * 下一帧 `_computeCameraState` 会自动拾取新值并生成对应的透视 VP 矩阵。
   *
   * @stability experimental
   */
  private _install25DInteractions(): void {
    const canvas = this._canvas;

    // 中键按下 → 启动拖拽
    const onMiddleDown = (e: MouseEvent): void => {
      if (e.button !== MIDDLE_BUTTON) { return; }
      // 阻止默认滚动行为（部分浏览器中键点击触发自动滚动）
      e.preventDefault();
      this._pitchDragActive = true;
      this._pitchDragLastPt = [e.clientX, e.clientY];
      // 在 window 上监听，确保拖出 canvas 外仍跟踪
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);
    };

    // 拖拽中 → 增量更新 pitch / bearing
    const onDragMove = (e: MouseEvent): void => {
      if (!this._pitchDragActive || this._pitchDragLastPt === null) { return; }

      const dx = e.clientX - this._pitchDragLastPt[0];
      const dy = e.clientY - this._pitchDragLastPt[1];
      this._pitchDragLastPt = [e.clientX, e.clientY];

      // 无有效增量时跳过（避免触发无意义的 move 事件）
      if (dx === 0 && dy === 0) { return; }

      // dy > 0 (drag down) → pitch 增大（趋向地平线）；dy < 0 (drag up) → pitch 减小
      const newPitchDeg = clampPitchDeg(
        this.getPitch() + dy * PITCH_SENSITIVITY_DEG,
        this._maxPitch,
      );

      // dx > 0 (drag right) → bearing 增大（顺时针）；dx < 0 → bearing 减小
      const newBearingDeg = normalizeBearingDeg(
        this.getBearing() + dx * BEARING_SENSITIVITY_DEG,
      );

      // 使用公共 API 更新权威状态（jumpTo 接受弧度制）
      this.jumpTo({
        pitch: newPitchDeg * DEG2RAD,
        bearing: newBearingDeg * DEG2RAD,
      });
    };

    // 中键释放 → 结束拖拽
    const onDragEnd = (e: MouseEvent): void => {
      if (e.button !== MIDDLE_BUTTON) { return; }
      this._pitchDragActive = false;
      this._pitchDragLastPt = null;
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };

    canvas.addEventListener('mousedown', onMiddleDown);

    // 存储清理函数，供 remove() 销毁时调用
    this._pitchDragCleanup = (): void => {
      canvas.removeEventListener('mousedown', onMiddleDown);
      // 若拖拽中被销毁，也需移除 window 监听
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };
  }

  /**
   * 销毁 Map25D 并释放 2.5D 专属资源（中键拖拽监听器）。
   * 调用后地图不可再用。
   *
   * @stability stable
   *
   * @example
   * map.remove();
   */
  // ==================== 屏幕反投影（考虑 pitch/bearing） ====================
  //
  // Map2D 的 unproject 是纯正交反投影，无法处理 pitch 与 bearing。2.5D
  // 场景下必须用 inverseVPMatrix 做真正的屏幕射线与地面平面的相交，
  // 否则拖拽时屏幕 Y 方向像素变化对应的 lat 变化会被严重低估，造成
  // "只能左右拖不能上下拖"的假象。

  public override unproject(point: [number, number]): [number, number] {
    const camera = this._cameraState;
    if (camera === null || camera.inverseVPMatrix === null) {
      return super.unproject(point);
    }
    const rect = this._canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    // 屏幕像素 → NDC（x:[-1,1] 右正，y:[-1,1] 上正）
    const ndcX = (point[0] / w) * 2 - 1;
    const ndcY = 1 - (point[1] / h) * 2;

    // Reversed-Z：near clip.z=1，far clip.z=0；取两个端点反投影得到相机
    // 相对的当前 zoom 世界像素空间中的射线
    const inv = camera.inverseVPMatrix;
    const unprojectToWorld = (nx: number, ny: number, nz: number): [number, number, number] => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
      const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
      const wRec = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
      const invW = wRec === 0 ? 1 : 1 / wRec;
      return [x * invW, y * invW, z * invW];
    };

    const near = unprojectToWorld(ndcX, ndcY, 1);
    const far = unprojectToWorld(ndcX, ndcY, 0);
    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];

    // 与地面 z=0 平面求交
    let groundRelX: number;
    let groundRelY: number;
    if (Math.abs(dz) < 1e-9) {
      // 射线与地面近乎平行（俯仰接近水平）—— 退化为中心点
      groundRelX = near[0];
      groundRelY = near[1];
    } else {
      const t = -near[2] / dz;
      groundRelX = near[0] + t * dx;
      groundRelY = near[1] + t * dy;
    }

    // (groundRelX, groundRelY) 为当前 zoom 下、相机中心为原点的 mercator 像素
    // → 加回相机中心的绝对世界像素得到绝对坐标
    const zoom = this.getZoom();
    const center = this.getCenter();
    const worldSize = 512 * Math.pow(2, zoom);
    const cLat = Math.max(-85.05, Math.min(85.05, center[1]));
    const cLatRad = (cLat * Math.PI) / 180;
    const cxAbs = ((center[0] + 180) / 360) * worldSize;
    const cyAbs = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * worldSize;

    const worldPx = cxAbs + groundRelX;
    const worldPy = cyAbs + groundRelY;

    const lng = (worldPx / worldSize) * 360 - 180;
    const yNorm = 1 - (2 * worldPy) / worldSize;
    const lat = Math.atan(Math.sinh(Math.PI * yNorm)) * (180 / Math.PI);
    return [lng, lat];
  }

  // ==================== 地形接管底图渲染 ====================
  //
  // 参考 Mapbox GL v3 / Cesium：开启 cesium-terrain 后，所有平面 raster
  // 图层停止 encode draw call，但保留瓦片下载/缓存能力供地形层 drape 借用。
  // 切回 2D 模式（移除地形层）时自动恢复。

  protected override _createLayerInstance(spec: LayerSpec): void {
    super._createLayerInstance(spec);
    this._syncRasterRenderState();
  }

  public override removeLayer(id: string): this {
    super.removeLayer(id);
    this._syncRasterRenderState();
    return this;
  }

  /**
   * 在 2.5D + 直接 QM 渲染架构下，CesiumTerrainLayer 只覆盖 available 矩阵
   * 内的地形瓦片（如北京局部），其它区域仍需底图 RasterTileLayer 提供
   * 平面 OSM。因此**不再禁用 raster 层渲染**，让两层共存：
   *   • RasterTileLayer：平面底图，全球覆盖
   *   • CesiumTerrainLayer：局部 3D 地形，深度测试让山脊盖住同位置底图
   */
  private _syncRasterRenderState(): void {
    // 保持所有 raster 层渲染开启（No-op）
    for (const inst of this._layerInstances.values()) {
      if (inst.type === 'raster') {
        const rl = inst as RasterTileLayer;
        rl.setRenderEnabled?.(true);
      }
    }
  }

  public override remove(): void {
    // 清理 2.5D 专属交互监听器
    if (this._pitchDragCleanup !== null) {
      this._pitchDragCleanup();
      this._pitchDragCleanup = null;
    }
    this._pitchDragActive = false;
    this._pitchDragLastPt = null;
    // 调用父类销毁（GPU 资源 / 图层 / Map2D 交互 / 事件）
    super.remove();
  }

  // ==================== 透视投影覆盖 ====================

  /**
   * 覆盖 Map2D 的正交 CameraState，改为使用 Camera25D 的透视 Reversed-Z 投影。
   *
   * 流程：
   * 1. 从 Map2D 公共 API 读取当前 center/zoom/bearing/pitch
   * 2. 通过 Camera25D.jumpTo 同步状态
   * 3. Camera25D.update 生成绝对世界像素空间的透视 VP 矩阵
   * 4. 后乘平移矩阵 T(centerPx, centerPy, 0)，将 VP 适配到
   *    RasterTileLayer 使用的相机相对顶点坐标
   *
   * @returns CameraState 快照（vpMatrix 为相机相对透视投影）
   */
  protected override _computeCameraState(): CameraState {
    // --- 1. 从 Map2D 读取权威状态 ---
    const center = this.getCenter();
    const zoom = this.getZoom();
    // camera.getBearing/getPitch 返回 Map2D 内部弧度值
    const bearingRad = this.camera.getBearing();
    const pitchRad = this.camera.getPitch();

    // --- 2. 同步到 Camera25D（仅用于矩阵生成，不触发外部回调） ---
    this._cam25d.jumpTo({
      center,
      zoom,
      bearing: bearingRad,
      pitch: pitchRad,
    });

    // --- 3. 构建 Viewport 并让 Camera25D 计算透视矩阵 ---
    const rect = this._canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    const viewport: Viewport = {
      width: w,
      height: h,
      physicalWidth: Math.round(w * dpr),
      physicalHeight: Math.round(h * dpr),
      pixelRatio: dpr,
    };

    // deltaTime=0：Camera25D 不管理动画，仅计算矩阵
    const absState = this._cam25d.update(0, viewport);

    // --- 4. 坐标适配 ---
    // Camera25D 的 lookAt 已在相机相对坐标系中构建（eye/target 减去 center），
    // vpMatrix 直接接受相机相对顶点 (worldPx - centerPx, worldPy - centerPy, 0)，
    // 无需额外平移，避免了 Float32 截断大坐标导致的精度丢失。
    const vpMatrix = new Float32Array(16);
    mat4.copy(vpMatrix, absState.vpMatrix);

    // --- 4b. X 轴镜像修正 ---
    // Mercator 像素坐标系 (X=东, Y=南, Z=上) 是右手系。
    // lookAt 在此系中将「东」映射到 clip-space 负 X（屏幕左侧），
    // 因为 right = forward × up 沿 -X。
    // 翻转 VP 矩阵第一行（clip_x 取反）使 screen-right = 地理东。
    vpMatrix[0] = -vpMatrix[0];
    vpMatrix[4] = -vpMatrix[4];
    vpMatrix[8] = -vpMatrix[8];
    vpMatrix[12] = -vpMatrix[12];

    // 逆 VP 矩阵（屏幕反投影用）
    const inverseVPMatrix = new Float32Array(16);
    const inv = mat4.invert(inverseVPMatrix, vpMatrix);
    if (inv === null) {
      // 退化情况（极端缩放/pitch）：回退单位阵
      mat4.identity(inverseVPMatrix);
    }

    // --- 5. 组装完整 CameraState（复用 Camera25D 的标量与位置） ---
    return {
      center: [center[0], center[1]],
      zoom,
      bearing: bearingRad,
      pitch: pitchRad,
      viewMatrix: absState.viewMatrix,
      projectionMatrix: absState.projectionMatrix,
      vpMatrix,
      inverseVPMatrix,
      position: absState.position,
      altitude: absState.altitude,
      fov: absState.fov,
      roll: 0,
    };
  }

  // ==================== 2.5D 公共 API ====================

  /**
   * 返回当前俯仰角（度）。
   *
   * @returns 俯仰角 [0, maxPitch]
   *
   * @example
   * const p = map.getPitch();
   */
  public getPitch(): number {
    // Map2D 内部为弧度；对外转换为度
    return this.camera.getPitch() * RAD2DEG;
  }

  /**
   * 设置俯仰角（度），可选动画。
   *
   * @param pitch - 目标俯仰角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.setPitch(60, { duration: 500 });
   */
  public setPitch(pitch: number, options?: AnimationOptions): this {
    const pDeg = clampPitchDeg(pitch, this._maxPitch);
    const rad = pDeg * DEG2RAD;
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ pitch: rad });
      return this;
    }
    // 使用 flyTo 保持与 Map2D 相机动画一致
    this.flyTo({
      pitch: rad,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 返回当前方位角（度），范围 [0, 360)。
   *
   * @returns 方位角（度）
   *
   * @example
   * map.getBearing();
   */
  public getBearing(): number {
    return normalizeBearingDeg(this.camera.getBearing() * RAD2DEG);
  }

  /**
   * 设置方位角（度），可选动画。
   *
   * @param bearing - 目标方位角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.setBearing(90, { duration: 400 });
   */
  public setBearing(bearing: number, options?: AnimationOptions): this {
    const bDeg = normalizeBearingDeg(bearing);
    const rad = bDeg * DEG2RAD;
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ bearing: rad });
      return this;
    }
    this.flyTo({
      bearing: rad,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 旋转到指定方位角（度）。
   * 语义与 setBearing 相同，仅命名对标 MapLibre。
   *
   * @param bearing - 目标方位角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.rotateTo(180, { duration: 800 });
   */
  public rotateTo(bearing: number, options?: AnimationOptions): this {
    return this.setBearing(bearing, options);
  }

  /**
   * 将方位角重置为 0°（正北）。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.resetNorth({ duration: 300 });
   */
  public resetNorth(options?: AnimationOptions): this {
    return this.setBearing(0, options);
  }

  /**
   * 重置方位角为 0° 且俯仰为 0°。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.resetNorthPitch({ duration: 400 });
   */
  public resetNorthPitch(options?: AnimationOptions): this {
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ bearing: 0, pitch: 0 });
      return this;
    }
    this.flyTo({
      bearing: 0,
      pitch: 0,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 快速指北（与 resetNorth 相同，保留别名以兼容文档）。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.snapToNorth();
   */
  public snapToNorth(options?: AnimationOptions): this {
    return this.resetNorth(options);
  }

  /**
   * 设置全局光照（合并到当前样式光照）。
   *
   * @param light - 部分或完整光照参数
   * @returns this
   *
   * @example
   * map.setLight({ anchor: 'map', intensity: 0.7 });
   */
  public setLight(light: LightSpec): this {
    if (light === undefined || light === null) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light 不能为空', {});
    }
    // 强度若提供，需为非负有限数
    if (light.intensity !== undefined && (!Number.isFinite(light.intensity) || light.intensity < 0)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light.intensity 非法', {
        intensity: light.intensity,
      });
    }
    if (light.position !== undefined) {
      const [a, b, c] = light.position;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
        throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light.position 分量非法', {
          position: light.position,
        });
      }
    }
    this._light = mergeLight(this._light, light);
    this.triggerRepaint();
    return this;
  }

  /**
   * 返回当前光照参数的浅拷贝。
   *
   * @returns 光照规格
   *
   * @example
   * const L = map.getLight();
   */
  public getLight(): LightSpec {
    return mergeLight(this._light, {});
  }
}
