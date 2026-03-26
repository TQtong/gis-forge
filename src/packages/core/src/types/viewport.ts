// ============================================================
// types/viewport.ts — 视口、相机状态、拾取结果
// 被引用于：L1/SurfaceManager, L2/PickingEngine, L2/FrameGraphBuilder,
//          L3/TileScheduler, L3/FrameScheduler, L4/LabelManager,
//          L5/CustomLayer, L5/InteractionTool, L6/Map2D/Globe3D
//
// 修复审计报告不一致 #3(CameraState), #6(PickResult), #7(Viewport)。
// 这些类型在 L0 中唯一定义，L1~L6 全部从此处 import。
// ============================================================

// ===================== Viewport =====================

/**
 * 视口描述。
 * 描述渲染目标（Canvas）的尺寸信息，包含逻辑尺寸和物理尺寸。
 * 物理尺寸 = 逻辑尺寸 × 像素比，用于高 DPI 屏幕的正确渲染。
 *
 * 由 SurfaceManager 在 Canvas resize 时更新，
 * 通过 FrameScheduler 分发到 TileScheduler、LabelManager 等需要尺寸信息的模块。
 *
 * @example
 * const viewport: Viewport = {
 *   width: 1920,
 *   height: 1080,
 *   physicalWidth: 3840,
 *   physicalHeight: 2160,
 *   pixelRatio: 2.0,
 * };
 */
export interface Viewport {
  /**
   * 逻辑宽度（CSS 像素）。
   * 等于 Canvas 元素的 clientWidth。
   * 用于屏幕空间计算（如鼠标坐标映射、UI 布局）。
   * 范围 [1, +∞)，必须为正整数。
   */
  readonly width: number;

  /**
   * 逻辑高度（CSS 像素）。
   * 等于 Canvas 元素的 clientHeight。
   * 用于屏幕空间计算。
   * 范围 [1, +∞)，必须为正整数。
   */
  readonly height: number;

  /**
   * 物理宽度（设备像素）。
   * 等于 width × pixelRatio，即 Canvas 元素的实际绘制像素宽度。
   * 对应 WebGPU texture 的 width。
   * 范围 [1, +∞)，必须为正整数。
   */
  readonly physicalWidth: number;

  /**
   * 物理高度（设备像素）。
   * 等于 height × pixelRatio，即 Canvas 元素的实际绘制像素高度。
   * 对应 WebGPU texture 的 height。
   * 范围 [1, +∞)，必须为正整数。
   */
  readonly physicalHeight: number;

  /**
   * 设备像素比（Device Pixel Ratio, DPR）。
   * 通常等于 window.devicePixelRatio。
   * 标准屏幕为 1.0，Retina/HiDPI 屏幕为 2.0 或 3.0。
   * compat-mobile 包可能主动降低此值以提升移动端性能。
   * 范围 (0, +∞)，通常为 [1.0, 3.0]。
   */
  readonly pixelRatio: number;
}

// ===================== CameraState =====================

/**
 * 相机状态快照。
 * 由 CameraController（2D/2.5D/3D）在每帧 UPDATE 阶段计算后生成。
 * 包含相机的地理位置、姿态参数和预计算的变换矩阵。
 * 此为只读快照——修改相机需通过 CameraController 的方法。
 *
 * **关键设计决策**：
 * - 旋转角统一使用 `bearing`（非 heading），单位弧度
 * - 俯仰角 `pitch` 单位弧度
 * - 矩阵为列主序（Column-Major），与 WGSL mat4x4 对齐
 * - 位置 `position` 为世界坐标（ECEF 或投影坐标系，取决于投影模式）
 *
 * @example
 * const camera: CameraState = {
 *   center: [116.39, 39.91],
 *   zoom: 12,
 *   bearing: 0,
 *   pitch: 0,
 *   viewMatrix: mat4.create(),
 *   projectionMatrix: mat4.create(),
 *   vpMatrix: mat4.create(),
 *   inverseVPMatrix: mat4.create(),
 *   position: vec3.create(),
 *   altitude: 5000,
 *   fov: Math.PI / 4,
 *   roll: 0,
 * };
 */
export interface CameraState {
  // ===================== 地理位置参数 =====================

  /**
   * 相机注视点的经纬度坐标 [longitude, latitude]。
   * 单位：度（°）。
   * longitude 范围 [-180, 180]，latitude 范围 [-90, 90]。
   * 在 2D 模式下为地图中心点，在 3D 模式下为相机俯视目标点。
   */
  readonly center: [number, number];

  /**
   * 缩放级别。
   * 连续值（支持小数），范围通常 [0, 22]。
   * z=0 为全球视图，每增加 1 级分辨率翻倍（地面分辨率减半）。
   * 实际最大值受数据源的 maxzoom 限制。
   */
  readonly zoom: number;

  /**
   * 旋转角 / 方位角（弧度）。
   * 0 = 正北（默认），正值顺时针旋转。
   * 范围 [-π, π] 或 [0, 2π]，引擎内部会归一化。
   *
   * **注意**：统一使用 `bearing` 名称（非 heading / rotation / azimuth），
   * 这是审计报告不一致 #3 的修复。
   */
  readonly bearing: number;

  /**
   * 俯仰角 / 倾斜角（弧度）。
   * 0 = 正俯视（2D 模式），正值向地平线方向倾斜。
   * 2D 模式下固定为 0，2.5D 模式下范围 [0, π/3]（约 0~60°），
   * 3D 模式下范围 [0, π/2)（0~90°，不含 90° 以避免奇异）。
   */
  readonly pitch: number;

  // ===================== 变换矩阵（每帧预计算）=====================

  /**
   * 视图矩阵（View Matrix / Camera Matrix）。
   * 将世界坐标变换到相机坐标系（Eye Space）。
   * Float32Array 长度 16，列主序存储。
   * 由 CameraController 通过 lookAt 或相机姿态参数每帧计算。
   */
  readonly viewMatrix: Float32Array;

  /**
   * 投影矩阵（Projection Matrix）。
   * 将相机坐标变换到裁剪空间（Clip Space）。
   * Float32Array 长度 16，列主序存储。
   * 2D 模式使用正交投影（ortho），3D 模式使用透视投影（perspective）。
   * GIS-Forge 默认使用 Reversed-Z 投影以获得更好的深度精度。
   */
  readonly projectionMatrix: Float32Array;

  /**
   * 视图投影矩阵（View-Projection Matrix）。
   * vpMatrix = projectionMatrix × viewMatrix，将世界坐标直接变换到裁剪空间。
   * Float32Array 长度 16，列主序存储。
   * 预乘合矩阵避免每个顶点重复矩阵乘法，提升 GPU 顶点着色器性能。
   */
  readonly vpMatrix: Float32Array;

  /**
   * 视图投影逆矩阵（Inverse View-Projection Matrix）。
   * 将裁剪空间坐标反变换回世界坐标。
   * Float32Array 长度 16，列主序存储。
   * 用于屏幕坐标→世界坐标反投影（如鼠标拾取、射线投射）。
   * 如果 vpMatrix 不可逆（退化情况），此矩阵为上一帧的有效值。
   */
  readonly inverseVPMatrix: Float32Array;

  // ===================== 3D 空间信息 =====================

  /**
   * 相机在世界坐标系中的位置。
   * Float32Array 长度 3，布局 [x, y, z]。
   * 坐标系取决于投影模式：
   * - 墨卡托投影：投影坐标（米）
   * - Globe 模式：ECEF 坐标（米）
   * 用于距离计算、LOD 判断、大气散射等。
   */
  readonly position: Float32Array;

  /**
   * 相机海拔高度（米）。
   * 相机到地球表面（或投影平面）的垂直距离。
   * 2D 模式下由 zoom 换算得出：altitude = earthCircumference / (2^zoom × tileSize)。
   * 3D 模式下为相机实际高度。
   * 范围 (0, +∞)，值越小越接近地面。
   */
  readonly altitude: number;

  /**
   * 视场角（Field of View, FOV），单位弧度。
   * 透视投影的垂直视场角。
   * 典型值 π/4（45°）到 π/3（60°）。
   * 2D 正交投影模式下此值无实际意义但仍保留（默认 π/4）。
   * 范围 (0, π)。
   */
  readonly fov: number;

  // ===================== 便捷属性 =====================

  /**
   * 翻滚角（Roll），单位弧度。
   * 绕相机前方向轴（look direction）的旋转角。
   * 正值为顺时针旋转（从相机后方观察）。
   * 通常为 0（地图应用几乎不使用翻滚），
   * 仅在特殊 3D 可视化或飞行模拟场景中使用。
   * 范围 [-π, π]。
   */
  readonly roll: number;
}

// ===================== PickResult =====================

/**
 * 拾取结果（Pick Result）。
 * 由 PickingEngine 在异步拾取查询后返回，描述屏幕坐标处命中的要素信息。
 * queryRenderedFeatures 返回 `Promise<PickResult[]>`（可能命中多个图层的多个要素）。
 *
 * **关键设计决策**：
 * - 异步查询（GPU Readback 不可同步）
 * - 包含深度信息和 3D 世界坐标（3D 模式下可用于精确空间分析）
 * - featureId 可为 null（命中了图层但未命中具体要素，如背景图层）
 *
 * 修复审计报告不一致 #6：统一了 L2/PickingEngine 和 L5/InteractionTool
 * 之前各自定义的不同 PickResult 字段集合。
 *
 * @example
 * const result: PickResult = {
 *   featureId: 42,
 *   layerId: 'buildings',
 *   sourceId: 'openmaptiles',
 *   coordinates: [116.39, 39.91],
 *   screenPosition: [960, 540],
 *   properties: { name: '国贸大厦', height: 330 },
 *   depth: 0.85,
 *   worldPosition: new Float32Array([1234.5, 5678.9, 330.0]),
 *   normal: new Float32Array([0, 0, 1]),
 * };
 */
export interface PickResult {
  /**
   * 命中要素的 ID。
   * 对应 Feature.id，可以是字符串或数值。
   * 为 null 表示命中了图层区域但未关联到具体要素
   * （如背景图层、无 ID 的栅格瓦片等）。
   */
  readonly featureId: string | number | null;

  /**
   * 命中要素所在的图层 ID。
   * 对应 LayerStyleSpec.id，标识渲染此要素的图层。
   * 始终有值（拾取至少命中一个图层才会产生 PickResult）。
   */
  readonly layerId: string;

  /**
   * 命中要素所在的数据源 ID。
   * 对应 StyleSpec.sources 中的键名。
   * 用于 queryRenderedFeatures 按数据源过滤结果。
   */
  readonly sourceId: string;

  /**
   * 命中位置的地理坐标。
   * 2D: [longitude, latitude]，单位度
   * 3D: [longitude, latitude, altitude]，altitude 单位米
   * 通过屏幕坐标反投影计算得出。
   */
  readonly coordinates: [number, number] | [number, number, number];

  /**
   * 拾取点的屏幕坐标 [x, y]。
   * 单位：CSS 像素（逻辑像素），原点为 Canvas 左上角。
   * 与输入的查询坐标一致。
   */
  readonly screenPosition: [number, number];

  /**
   * 命中要素的属性集合。
   * 对应 Feature.properties 的浅拷贝。
   * 可选，某些图层类型（如栅格）可能没有关联属性。
   */
  readonly properties?: Record<string, unknown>;

  /**
   * 归一化深度值。
   * 从 GPU depth buffer 读取的原始深度。
   * GIS-Forge 使用 Reversed-Z：1.0 = 最近平面，0.0 = 最远平面。
   * 范围 [0.0, 1.0]。
   * 可用于深度排序（同一像素多图层命中时按深度排序）。
   */
  readonly depth: number;

  /**
   * 从深度反算的 3D 世界坐标。
   * Float32Array 长度 3，布局 [x, y, z]。
   * 通过 inverseVPMatrix × 屏幕坐标 + 深度 反投影得出。
   * 3D 模式下可用于精确的空间分析（如测距、体积计算）。
   * 可选，2D 模式下或深度不可用时为 undefined。
   */
  readonly worldPosition?: Float32Array;

  /**
   * 命中表面的法线向量。
   * Float32Array 长度 3，布局 [nx, ny, nz]，单位向量。
   * 从 G-Buffer 或相邻深度差分估算得出。
   * 可用于光照计算、法线方向判断等。
   * 可选，仅在 3D 模式且法线信息可用时提供。
   */
  readonly normal?: Float32Array;
}
