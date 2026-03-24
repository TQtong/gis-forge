// ============================================================
// HeatmapLayer.ts — 热力图图层（L4 图层包）
// 职责：管理点数据的核密度估计、颜色渐变映射和 2-Pass 渲染，
//       维护 paint 属性（radius/weight/intensity/color/opacity），
//       在 encode() 中提交绘制命令（MVP 阶段为桩实现）。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression, StyleExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建由 tree-shake 移除）
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/**
 * HeatmapLayer 模块错误码，前缀 `HEATMAP_` 以避免跨模块碰撞。
 */
const HEATMAP_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'HEATMAP_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'HEATMAP_INVALID_OPACITY',
  /** 半径超出有效区间 */
  INVALID_RADIUS: 'HEATMAP_INVALID_RADIUS',
  /** 权重超出有效区间 */
  INVALID_WEIGHT: 'HEATMAP_INVALID_WEIGHT',
  /** 强度超出有效区间 */
  INVALID_INTENSITY: 'HEATMAP_INVALID_INTENSITY',
  /** 颜色渐变格式错误 */
  INVALID_COLOR_RAMP: 'HEATMAP_INVALID_COLOR_RAMP',
  /** 点数据格式不合法 */
  INVALID_POINT_DATA: 'HEATMAP_INVALID_POINT_DATA',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认热力半径（像素），影响高斯核扩散范围 */
const DEFAULT_HEATMAP_RADIUS = 30;

/** 密度纹理分辨率缩放因子——密度累积在半分辨率下计算以降低开销 */
const DENSITY_TEXTURE_SCALE = 0.5;

/** 高斯衰减系数——距离超过 radius × GAUSSIAN_DECAY 的标准差即视为零贡献 */
const GAUSSIAN_DECAY = 4.0;

/** 颜色渐变查找表宽度（像素数 = RGBA 条目数） */
const COLOR_RAMP_WIDTH = 256;

/** 最大密度平滑因子——帧间最大密度值的指数移动平均系数，抑制闪烁 */
const MAX_DENSITY_SMOOTH_FACTOR = 0.9;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 不透明度的有效下限 */
const OPACITY_MIN = 0;

/** 不透明度的有效上限 */
const OPACITY_MAX = 1;

/** 半径的有效下限（像素） */
const RADIUS_MIN = 1;

/** 半径的有效上限（像素） */
const RADIUS_MAX = 200;

/** 权重的有效下限 */
const WEIGHT_MIN = 0;

/** 强度的有效下限 */
const INTENSITY_MIN = 0;

/** 每条目的 RGBA 通道数 */
const RGBA_CHANNELS = 4;

// ---------------------------------------------------------------------------
// 默认颜色渐变停靠点（对标 MapLibre heatmap-color 默认值）
// ---------------------------------------------------------------------------

/**
 * 默认热力图颜色渐变停靠点。
 * 每个条目 [position, r, g, b, a]，position 范围 [0, 1]，
 * RGBA 各通道范围 [0, 255]。
 * 模拟 MapLibre 默认热力渐变：透明→蓝→青→绿→黄→红。
 */
const DEFAULT_COLOR_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0.0, 0, 0, 0, 0],         // 密度 0：完全透明
  [0.1, 65, 105, 225, 255],   // 低密度：皇家蓝
  [0.3, 0, 200, 200, 255],    // 中低密度：青色
  [0.5, 0, 255, 0, 255],      // 中密度：绿色
  [0.7, 255, 255, 0, 255],    // 中高密度：黄色
  [1.0, 255, 0, 0, 255],      // 高密度：红色
] as const;

// ---------------------------------------------------------------------------
// HeatmapLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 热力图图层构造选项。
 * 由用户传入 `createHeatmapLayer`，驱动图层初始化。
 *
 * @example
 * const opts: HeatmapLayerOptions = {
 *   id: 'earthquakes-heat',
 *   source: 'earthquakes',
 *   paint: {
 *     'heatmap-radius': 40,
 *     'heatmap-weight': ['get', 'magnitude'],
 *     'heatmap-intensity': 1.5,
 *     'heatmap-opacity': 0.8,
 *   },
 *   minzoom: 0,
 *   maxzoom: 14,
 * };
 */
export interface HeatmapLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的数据源 ID（对应 StyleSpec.sources 中的键名）。
   * 必填。
   */
  readonly source: string;

  /**
   * MVT 矢量瓦片中的 source-layer 名。
   * 仅当 source type 为 vector 时需要。
   * 可选。
   */
  readonly sourceLayer?: string;

  /**
   * 投影标识（对应 SceneGraph 的投影分组键）。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * 图层可见的最小缩放级别（含）。
   * 低于此级别时图层不渲染。
   * 范围 [0, 22]。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 超过此级别时图层不渲染。
   * 范围 [0, 22]，必须 ≥ minzoom。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 要素过滤器表达式。
   * 仅渲染满足条件的点要素。
   * 可选，默认不过滤。
   */
  readonly filter?: FilterExpression;

  /**
   * paint 属性表（v8 样式规范 heatmap paint 属性子集）。
   * 支持键：
   * - `'heatmap-radius'`: 核扩散半径（像素），默认 30
   * - `'heatmap-weight'`: 点权重（number 或 StyleExpression），默认 1
   * - `'heatmap-intensity'`: 全局强度乘数，默认 1
   * - `'heatmap-color'`: 颜色渐变（StyleExpression interpolate 表达式），默认内置渐变
   * - `'heatmap-opacity'`: 图层不透明度 [0,1]，默认 1
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * layout 属性表（v8 样式规范 heatmap layout 属性子集）。
   * 支持键：
   * - `'visibility'`: `'visible'` | `'none'`，默认 `'visible'`
   * 可选。
   */
  readonly layout?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HeatmapPointData（每瓦片/每数据集的点缓存）
// ---------------------------------------------------------------------------

/**
 * 热力图点数据——存储一批点的屏幕坐标和权重。
 * 每帧 onUpdate 时由世界坐标投影到屏幕坐标并缓存。
 *
 * @internal 仅模块内使用。
 */
interface HeatmapPointData {
  /** 点的屏幕 X 坐标数组（CSS 像素） */
  screenX: Float32Array;

  /** 点的屏幕 Y 坐标数组（CSS 像素） */
  screenY: Float32Array;

  /** 每个点的权重数组（≥ 0） */
  weights: Float32Array;

  /** 实际使用的点数量（数组可能预分配更大） */
  count: number;

  /** 数据来源标识（瓦片 key 或 'direct'） */
  sourceKey: string;
}

// ---------------------------------------------------------------------------
// HeatmapLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 热力图图层接口——在 Layer 基础上扩展热力图特有的样式控制和状态查询。
 * 实例由 `createHeatmapLayer` 工厂创建。
 *
 * @example
 * const layer = createHeatmapLayer({ id: 'heat', source: 'points' });
 * layer.setRadius(50);
 * layer.setIntensity(2.0);
 * console.log(layer.pointCount); // 当前渲染的点数量
 */
export interface HeatmapLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'heatmap'` */
  readonly type: 'heatmap';

  /** 当前帧参与密度计算的点数量 */
  readonly pointCount: number;

  /** 当前帧最大密度值（用于归一化） */
  readonly maxDensity: number;

  /**
   * 设置热力半径。
   *
   * @param pixels - 半径（像素），范围 [1, 200]
   * @throws 若 pixels 不是有限数或超出 [1,200] 范围
   *
   * @example
   * layer.setRadius(50); // 50 像素扩散半径
   */
  setRadius(pixels: number): void;

  /**
   * 获取当前热力半径。
   *
   * @returns 半径（像素）
   */
  getRadius(): number;

  /**
   * 设置全局强度乘数。
   *
   * @param value - 强度，范围 [0, +∞)
   * @throws 若 value 不是有限非负数
   *
   * @example
   * layer.setIntensity(2.0); // 翻倍热力强度
   */
  setIntensity(value: number): void;

  /**
   * 获取当前强度乘数。
   *
   * @returns 强度值
   */
  getIntensity(): number;

  /**
   * 设置热力图不透明度。
   *
   * @param value - 不透明度，范围 [0, 1]
   * @throws 若 value 不是有限数或超出 [0,1] 范围
   *
   * @example
   * layer.setHeatmapOpacity(0.7);
   */
  setHeatmapOpacity(value: number): void;

  /**
   * 获取颜色渐变查找表（256 条 RGBA 条目，共 1024 字节）。
   * 用于调试或自定义渲染管线。
   *
   * @returns Uint8Array 长度 1024（256 × 4 RGBA）
   */
  getColorRamp(): Uint8Array;

  /**
   * 使用自定义颜色停靠点重新生成颜色渐变。
   *
   * @param stops - 停靠点数组，每项 [position, r, g, b, a]
   *               position 范围 [0, 1]，RGBA 范围 [0, 255]
   *
   * @example
   * layer.setColorStops([
   *   [0.0, 0, 0, 0, 0],
   *   [0.5, 255, 255, 0, 255],
   *   [1.0, 255, 0, 0, 255],
   * ]);
   */
  setColorStops(stops: ReadonlyArray<readonly [number, number, number, number, number]>): void;
}

// ---------------------------------------------------------------------------
// 颜色渐变生成
// ---------------------------------------------------------------------------

/**
 * 从颜色停靠点生成 256 条 RGBA 线性插值查找表。
 * 停靠点按 position 升序排列，两相邻停靠点之间做线性插值填充。
 *
 * @param stops - 停靠点数组，每项 [position, r, g, b, a]，position ∈ [0,1]
 * @returns Uint8Array 长度 COLOR_RAMP_WIDTH × 4（1024 字节）
 *
 * @example
 * const ramp = generateColorRamp([
 *   [0.0, 0, 0, 0, 0],
 *   [1.0, 255, 0, 0, 255],
 * ]);
 * // ramp[0..3] ≈ [0,0,0,0], ramp[1020..1023] = [255,0,0,255]
 */
function generateColorRamp(
  stops: ReadonlyArray<readonly [number, number, number, number, number]>,
): Uint8Array {
  // 分配 256 × 4 字节的输出缓冲
  const ramp = new Uint8Array(COLOR_RAMP_WIDTH * RGBA_CHANNELS);

  // 空停靠点处理：返回全透明
  if (stops.length === 0) {
    return ramp;
  }

  // 单停靠点处理：整条渐变都是同一颜色
  if (stops.length === 1) {
    const [, r, g, b, a] = stops[0];
    for (let i = 0; i < COLOR_RAMP_WIDTH; i++) {
      const offset = i * RGBA_CHANNELS;
      ramp[offset] = r;
      ramp[offset + 1] = g;
      ramp[offset + 2] = b;
      ramp[offset + 3] = a;
    }
    return ramp;
  }

  // 确保停靠点按 position 升序排列（创建可变副本排序）
  const sorted = stops.slice().sort((a, b) => a[0] - b[0]);

  // 遍历每个输出像素，在停靠点间做线性插值
  for (let i = 0; i < COLOR_RAMP_WIDTH; i++) {
    // 当前位置在 [0, 1] 范围内的归一化值
    const t = i / (COLOR_RAMP_WIDTH - 1);

    // 查找 t 所在的区间 [sorted[lo], sorted[hi]]
    let lo = 0;
    let hi = sorted.length - 1;

    // 如果 t 小于第一个停靠点，使用第一个颜色
    if (t <= sorted[0][0]) {
      lo = 0;
      hi = 0;
    } else if (t >= sorted[sorted.length - 1][0]) {
      // 如果 t 大于最后一个停靠点，使用最后一个颜色
      lo = sorted.length - 1;
      hi = sorted.length - 1;
    } else {
      // 二分搜索或线性搜索定位区间（停靠点数量少，线性即可）
      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s][0] && t <= sorted[s + 1][0]) {
          lo = s;
          hi = s + 1;
          break;
        }
      }
    }

    // 计算区间内的插值因子
    const offset = i * RGBA_CHANNELS;
    if (lo === hi) {
      // 退化情况：单点，直接赋值
      ramp[offset] = sorted[lo][1];
      ramp[offset + 1] = sorted[lo][2];
      ramp[offset + 2] = sorted[lo][3];
      ramp[offset + 3] = sorted[lo][4];
    } else {
      // 计算区间宽度，避免除零（两停靠点 position 相同时使用 lo 颜色）
      const range = sorted[hi][0] - sorted[lo][0];
      const factor = range > 0 ? (t - sorted[lo][0]) / range : 0;

      // 线性插值每个 RGBA 通道并钳位到 [0, 255]
      ramp[offset] = Math.round(sorted[lo][1] + (sorted[hi][1] - sorted[lo][1]) * factor);
      ramp[offset + 1] = Math.round(sorted[lo][2] + (sorted[hi][2] - sorted[lo][2]) * factor);
      ramp[offset + 2] = Math.round(sorted[lo][3] + (sorted[hi][3] - sorted[lo][3]) * factor);
      ramp[offset + 3] = Math.round(sorted[lo][4] + (sorted[hi][4] - sorted[lo][4]) * factor);
    }
  }

  return ramp;
}

// ---------------------------------------------------------------------------
// 高斯核密度计算
// ---------------------------------------------------------------------------

/**
 * 在给定屏幕坐标处计算所有点的高斯核密度累积值。
 * 公式：density(x,y) = Σ weight_i × exp( -dist²_i / (2σ²) )
 * 其中 σ = radius / GAUSSIAN_DECAY，即在 radius 像素处衰减至 e^(-8) ≈ 0.00034。
 *
 * @param px - 查询点屏幕 X 坐标
 * @param py - 查询点屏幕 Y 坐标
 * @param points - 点数据集
 * @param radius - 扩散半径（像素）
 * @param intensity - 全局强度乘数
 * @returns 累积密度值（≥ 0）
 *
 * @example
 * const d = computeDensityAtPoint(100, 100, pointData, 30, 1.0);
 */
function computeDensityAtPoint(
  px: number,
  py: number,
  points: HeatmapPointData,
  radius: number,
  intensity: number,
): number {
  // 计算高斯标准差：σ = radius / GAUSSIAN_DECAY
  const sigma = radius / GAUSSIAN_DECAY;

  // 预计算 2σ² 的倒数，避免循环内除法
  const invTwoSigmaSq = 1.0 / (2.0 * sigma * sigma);

  // 距离截断阈值的平方——超过此距离的点贡献可忽略
  const cutoffDistSq = radius * radius;

  // 累积密度
  let density = 0.0;

  // 遍历所有点，累加高斯核贡献
  for (let i = 0; i < points.count; i++) {
    // 计算屏幕空间距离分量
    const dx = px - points.screenX[i];
    const dy = py - points.screenY[i];
    const distSq = dx * dx + dy * dy;

    // 距离截断优化：超过 radius 的点跳过
    if (distSq > cutoffDistSq) {
      continue;
    }

    // 高斯核值：exp(-dist² / 2σ²) × weight
    const gaussianValue = Math.exp(-distSq * invTwoSigmaSq);
    density += points.weights[i] * gaussianValue;
  }

  // 应用全局强度乘数
  return density * intensity;
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 HeatmapLayerOptions。
 * 对必填字段做空检查，对可选数值字段做范围校验。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项（带默认值）
 * @throws Error 若任何校验失败
 *
 * @example
 * const normalized = validateHeatmapOptions({ id: 'heat', source: 'pts' });
 */
function validateHeatmapOptions(opts: HeatmapLayerOptions): {
  id: string;
  source: string;
  sourceLayer: string | undefined;
  projection: string;
  minzoom: number;
  maxzoom: number;
  filter: FilterExpression | undefined;
  paint: Record<string, unknown> | undefined;
  layout: Record<string, unknown> | undefined;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${HEATMAP_ERROR_CODES.INVALID_OPTIONS}] HeatmapLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${HEATMAP_ERROR_CODES.INVALID_OPTIONS}] HeatmapLayerOptions.source must be a non-empty string`,
    );
  }

  // 解析 minzoom，校验范围 [0, 22]
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${HEATMAP_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  // 解析 maxzoom，校验范围 [minzoom, 22]
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${HEATMAP_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    sourceLayer: opts.sourceLayer,
    projection,
    minzoom,
    maxzoom,
    filter: opts.filter,
    paint: opts.paint,
    layout: opts.layout,
  };
}

// ---------------------------------------------------------------------------
// 从 paint 属性解析热力图初始参数
// ---------------------------------------------------------------------------

/**
 * 从 paint 属性中提取热力图参数初始值。
 *
 * @param paint - 用户 paint 属性表
 * @returns 解析后的参数对象
 *
 * @example
 * const p = parseHeatmapPaint({ 'heatmap-radius': 50 });
 * // p.radius === 50
 */
function parseHeatmapPaint(paint: Record<string, unknown> | undefined): {
  radius: number;
  weight: number | StyleExpression;
  intensity: number;
  opacity: number;
} {
  // 安全读取数值（非数值回退默认）
  const readNum = (key: string, fallback: number): number => {
    if (paint === undefined || paint === null) {
      return fallback;
    }
    const v = paint[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    return fallback;
  };

  // 热力半径
  const radius = readNum('heatmap-radius', DEFAULT_HEATMAP_RADIUS);

  // 权重——可以是数字或表达式（data-driven），此处仅解析常量数字
  let weight: number | StyleExpression = 1;
  if (paint !== undefined && paint !== null) {
    const w = paint['heatmap-weight'];
    if (typeof w === 'number' && Number.isFinite(w)) {
      weight = w;
    } else if (Array.isArray(w)) {
      // StyleExpression——运行时由 StyleEngine 求值，此处保留表达式引用
      weight = w as StyleExpression;
    }
  }

  // 全局强度乘数
  const intensity = readNum('heatmap-intensity', 1);

  // 图层不透明度
  const opacity = readNum('heatmap-opacity', 1);

  return { radius, weight, intensity, opacity };
}

// ---------------------------------------------------------------------------
// createHeatmapLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建热力图图层实例。
 * 返回完整的 {@link HeatmapLayer} 实现，包含点数据管理、颜色渐变生成、
 * 高斯核密度计算和 2-Pass 渲染概念（密度累积 + 颜色映射）。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现——
 * 完整管线需要 L2/ShaderAssembler + PipelineCache + FrameGraphBuilder 协同。
 *
 * @param opts - 热力图图层构造选项
 * @returns 完整的 HeatmapLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const heatLayer = createHeatmapLayer({
 *   id: 'earthquakes-heat',
 *   source: 'earthquakes',
 *   paint: {
 *     'heatmap-radius': 40,
 *     'heatmap-weight': ['get', 'magnitude'],
 *     'heatmap-intensity': 1.5,
 *     'heatmap-opacity': 0.8,
 *   },
 * });
 * sceneGraph.addLayer(heatLayer);
 */
export function createHeatmapLayer(opts: HeatmapLayerOptions): HeatmapLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateHeatmapOptions(opts);

  // ── 2. 从 paint 属性解析初始热力参数 ──
  const heatParams = parseHeatmapPaint(cfg.paint);

  // ── 3. 内部状态 ──

  // 热力半径（像素），运行时可通过 setRadius 修改
  let heatRadius = heatParams.radius;

  // 点权重（常量值或 StyleExpression）
  let heatWeight: number | StyleExpression = heatParams.weight;

  // 全局强度乘数
  let heatIntensity = heatParams.intensity;

  // 图层不透明度
  let heatOpacity = heatParams.opacity;

  // 颜色渐变查找表（256 × RGBA = 1024 字节）
  let colorRamp: Uint8Array = generateColorRamp(DEFAULT_COLOR_STOPS);

  // 当前颜色停靠点（保留以便重新生成）
  let currentColorStops: ReadonlyArray<readonly [number, number, number, number, number]> =
    DEFAULT_COLOR_STOPS;

  // 点数据存储（key = 数据来源标识）
  const pointDataMap = new Map<string, HeatmapPointData>();

  // 当前帧的总点数和最大密度值
  let currentPointCount = 0;
  let currentMaxDensity = 0;

  // 平滑后的最大密度（帧间 EMA，抑制密度归一化闪烁）
  let smoothedMaxDensity = 0;

  // paint/layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化 paint 属性缓存
  if (cfg.paint) {
    for (const k of Object.keys(cfg.paint)) {
      paintProps.set(k, cfg.paint[k]);
    }
  }

  // 初始化 layout 属性缓存
  if (cfg.layout) {
    for (const k of Object.keys(cfg.layout)) {
      layoutProps.set(k, cfg.layout[k]);
    }
  }

  // 图层生命周期标志
  let mounted = false;
  let layerContext: LayerContext | null = null;
  let dataReady = false;

  // ── 4. 构造 Layer 实现对象 ──
  const layer: HeatmapLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'heatmap' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: heatOpacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（至少有一组点数据加载完成）。
     * @returns true 表示有可渲染内容
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 热力图始终包含半透明内容（alpha 混合是核心渲染机制）。
     * @returns 始终 true
     */
    get isTransparent(): boolean {
      return true;
    },

    /**
     * 全局渲染次序（与 zIndex 同步）。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前帧参与密度计算的总点数。
     * @returns 点数量
     */
    get pointCount(): number {
      return currentPointCount;
    },

    /**
     * 当前帧的（平滑后）最大密度值。
     * @returns 最大密度
     */
    get maxDensity(): number {
      return smoothedMaxDensity;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载时由 LayerManager 调用。
     * 保存引擎上下文引用，初始化颜色渐变纹理。
     *
     * @param context - 引擎注入的上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;

      // 初始化颜色渐变（后续接入 L1/TextureManager 时创建 1D 纹理）
      colorRamp = generateColorRamp(currentColorStops);
    },

    /**
     * 图层卸载时由 LayerManager 调用。
     * 释放所有点数据和内部状态。
     */
    onRemove(): void {
      // 清空所有点数据
      pointDataMap.clear();
      featureStateMap.clear();

      // 重置运行时状态
      currentPointCount = 0;
      currentMaxDensity = 0;
      smoothedMaxDensity = 0;
      mounted = false;
      layerContext = null;
      dataReady = false;
    },

    /**
     * 每帧更新——统计点数量、更新密度峰值的 EMA 平滑。
     *
     * @param deltaTime - 距上一帧的时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // ── 缩放级别可见性判断 ──
      const zoom = camera.zoom;
      if (zoom < cfg.minzoom || zoom > cfg.maxzoom) {
        currentPointCount = 0;
        return;
      }

      // ── 统计本帧总点数 ──
      let totalPoints = 0;
      for (const pd of pointDataMap.values()) {
        totalPoints += pd.count;
      }
      currentPointCount = totalPoints;

      // ── 更新密度峰值的指数移动平均（EMA） ──
      // 使用 MAX_DENSITY_SMOOTH_FACTOR 平滑帧间最大密度变化，避免热力图闪烁
      if (currentMaxDensity > 0) {
        smoothedMaxDensity =
          smoothedMaxDensity * MAX_DENSITY_SMOOTH_FACTOR +
          currentMaxDensity * (1.0 - MAX_DENSITY_SMOOTH_FACTOR);
      }

      // 防止平滑值退化为零（至少保持一个小正值避免除零）
      if (smoothedMaxDensity < 1e-10) {
        smoothedMaxDensity = currentMaxDensity > 0 ? currentMaxDensity : 1e-10;
      }
    },

    /**
     * 将热力图绘制命令编码进 RenderPass。
     * 完整实现为 2-Pass 渲染：
     *   Pass 1: 密度累积——每个点绘制一个 radius 大小的 quad，
     *           fragment shader 计算高斯核值，additive blend 到密度纹理。
     *   Pass 2: 颜色映射——全屏 quad，fragment shader 采样密度纹理，
     *           通过颜色渐变 LUT 映射为最终颜色。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        if (currentPointCount > 0) {
          console.debug(
            `[HeatmapLayer:${cfg.id}] encode stub: ${currentPointCount} points, ` +
              `radius=${heatRadius}, intensity=${heatIntensity.toFixed(2)}, ` +
              `maxDensity=${smoothedMaxDensity.toFixed(4)}, opacity=${heatOpacity.toFixed(2)}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——热力图不支持要素级拾取。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // 热力图无要素级几何，拾取 Pass 中不提交绘制命令
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性值。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);

      // 同步到内部参数
      if (typeof value === 'number' && Number.isFinite(value)) {
        switch (name) {
          case 'heatmap-radius':
            heatRadius = value;
            break;
          case 'heatmap-weight':
            heatWeight = value;
            break;
          case 'heatmap-intensity':
            heatIntensity = value;
            break;
          case 'heatmap-opacity':
            heatOpacity = value;
            layer.opacity = value;
            break;
          default:
            break;
        }
      } else if (name === 'heatmap-weight' && Array.isArray(value)) {
        // data-driven weight 表达式
        heatWeight = value as StyleExpression;
      } else if (name === 'heatmap-color' && Array.isArray(value)) {
        // 颜色渐变表达式——需要解析并重新生成 LUT
        // MVP：仅存储表达式，完整实现需 StyleEngine 解析
      }
    },

    /**
     * 设置 layout 属性值。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      // 同步 visibility 到 Layer.visible
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性值。
     *
     * @param name - paint 属性名
     * @returns 属性值，或 undefined 若未设置
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性值。
     *
     * @param name - layout 属性名
     * @returns 属性值，或 undefined 若未设置
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 设置点数据——接受 GeoJSON FeatureCollection 或预处理的点数组。
     * 将传入数据解析为内部 HeatmapPointData 格式。
     *
     * @param data - 点数据载荷，支持以下格式：
     *              - GeoJSON FeatureCollection（仅提取 Point 几何）
     *              - { screenX: Float32Array, screenY: Float32Array, weights: Float32Array, count: number }
     */
    setData(data: unknown): void {
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 格式 1：预处理的点数组（直接传入屏幕坐标）
      if (
        record['screenX'] instanceof Float32Array &&
        record['screenY'] instanceof Float32Array &&
        record['weights'] instanceof Float32Array &&
        typeof record['count'] === 'number'
      ) {
        const count = record['count'] as number;
        const sourceKey = typeof record['sourceKey'] === 'string' ? record['sourceKey'] : 'direct';

        // 校验 count 不超过数组长度
        const safeCount = Math.min(
          count,
          (record['screenX'] as Float32Array).length,
          (record['screenY'] as Float32Array).length,
          (record['weights'] as Float32Array).length,
        );

        const pd: HeatmapPointData = {
          screenX: record['screenX'] as Float32Array,
          screenY: record['screenY'] as Float32Array,
          weights: record['weights'] as Float32Array,
          count: safeCount,
          sourceKey,
        };

        pointDataMap.set(sourceKey, pd);
        dataReady = true;
        return;
      }

      // 格式 2：GeoJSON FeatureCollection
      if (record['type'] === 'FeatureCollection' && Array.isArray(record['features'])) {
        const features = record['features'] as Array<Record<string, unknown>>;

        // 预分配数组（按最大可能大小）
        const sx = new Float32Array(features.length);
        const sy = new Float32Array(features.length);
        const wt = new Float32Array(features.length);
        let count = 0;

        for (let i = 0; i < features.length; i++) {
          const feat = features[i];
          if (feat === null || feat === undefined || typeof feat !== 'object') {
            continue;
          }

          // 提取几何
          const geom = feat['geometry'] as Record<string, unknown> | null | undefined;
          if (geom === null || geom === undefined || geom['type'] !== 'Point') {
            continue;
          }

          // 提取坐标 [lng, lat]
          const coords = geom['coordinates'] as number[] | null | undefined;
          if (!Array.isArray(coords) || coords.length < 2) {
            continue;
          }

          // 校验坐标为有限数
          if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
            continue;
          }

          // 存储经纬度（后续 onUpdate 中投影到屏幕坐标）
          // MVP：直接存储为经纬度，实际应投影
          sx[count] = coords[0];
          sy[count] = coords[1];

          // 解析权重：如果 heatWeight 是常量数字，使用常量值
          // 如果是 StyleExpression，需要 StyleEngine 求值——MVP 用默认值 1
          if (typeof heatWeight === 'number') {
            wt[count] = heatWeight;
          } else {
            // data-driven 权重：尝试从 properties 读取
            const props = feat['properties'] as Record<string, unknown> | null;
            if (props !== null && props !== undefined) {
              // 简单处理 ['get', 'field'] 表达式
              if (
                Array.isArray(heatWeight) &&
                heatWeight.length === 2 &&
                heatWeight[0] === 'get' &&
                typeof heatWeight[1] === 'string'
              ) {
                const fieldVal = props[heatWeight[1] as string];
                wt[count] = typeof fieldVal === 'number' && Number.isFinite(fieldVal) ? fieldVal : 1;
              } else {
                wt[count] = 1;
              }
            } else {
              wt[count] = 1;
            }
          }

          count++;
        }

        // 存储解析结果
        const pd: HeatmapPointData = {
          screenX: sx,
          screenY: sy,
          weights: wt,
          count,
          sourceKey: 'geojson',
        };

        pointDataMap.set('geojson', pd);
        dataReady = count > 0;
      }
    },

    /**
     * 读取当前点数据快照（调试用途）。
     *
     * @returns 包含各数据源点数量的对象
     */
    getData(): unknown {
      const summary: Record<string, number> = {};
      for (const [key, pd] of pointDataMap) {
        summary[key] = pd.count;
      }
      return { pointSources: summary, totalPoints: currentPointCount };
    },

    // ==================== 要素查询方法 ====================

    /**
     * 包围盒要素查询——热力图无要素级查询，返回空数组。
     *
     * @param _bbox - 查询范围
     * @param _filter - 可选过滤器
     * @returns 空数组
     */
    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },

    /**
     * 屏幕点选查询——热力图不支持要素级拾取，返回空数组。
     *
     * @param _point - 屏幕坐标
     * @returns 空数组
     */
    queryRenderedFeatures(_point: [number, number]): Feature[] {
      return [];
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素状态——热力图无要素概念，接口兼容保留。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态对象或 undefined
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 热力图特有方法 ====================

    /**
     * 设置热力半径。
     *
     * @param pixels - 范围 [1, 200]
     */
    setRadius(pixels: number): void {
      if (!Number.isFinite(pixels) || pixels < RADIUS_MIN || pixels > RADIUS_MAX) {
        throw new Error(
          `[${HEATMAP_ERROR_CODES.INVALID_RADIUS}] radius must be in [${RADIUS_MIN}, ${RADIUS_MAX}], got ${pixels}`,
        );
      }
      heatRadius = pixels;
      paintProps.set('heatmap-radius', pixels);
    },

    /**
     * 获取当前热力半径。
     *
     * @returns 半径（像素）
     */
    getRadius(): number {
      return heatRadius;
    },

    /**
     * 设置全局强度乘数。
     *
     * @param value - 范围 [0, +∞)
     */
    setIntensity(value: number): void {
      if (!Number.isFinite(value) || value < INTENSITY_MIN) {
        throw new Error(
          `[${HEATMAP_ERROR_CODES.INVALID_INTENSITY}] intensity must be >= 0, got ${value}`,
        );
      }
      heatIntensity = value;
      paintProps.set('heatmap-intensity', value);
    },

    /**
     * 获取当前强度乘数。
     *
     * @returns 强度值
     */
    getIntensity(): number {
      return heatIntensity;
    },

    /**
     * 设置热力图不透明度。
     *
     * @param value - 范围 [0, 1]
     */
    setHeatmapOpacity(value: number): void {
      if (!Number.isFinite(value) || value < OPACITY_MIN || value > OPACITY_MAX) {
        throw new Error(
          `[${HEATMAP_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${value}`,
        );
      }
      heatOpacity = value;
      layer.opacity = value;
      paintProps.set('heatmap-opacity', value);
    },

    /**
     * 获取颜色渐变查找表副本。
     *
     * @returns Uint8Array 长度 1024（256 × 4 RGBA）
     */
    getColorRamp(): Uint8Array {
      // 返回副本，防止外部修改内部状态
      return new Uint8Array(colorRamp);
    },

    /**
     * 使用自定义颜色停靠点重新生成颜色渐变。
     *
     * @param stops - 停靠点数组
     */
    setColorStops(
      stops: ReadonlyArray<readonly [number, number, number, number, number]>,
    ): void {
      // 校验停靠点格式
      if (!Array.isArray(stops) || stops.length === 0) {
        throw new Error(
          `[${HEATMAP_ERROR_CODES.INVALID_COLOR_RAMP}] stops must be a non-empty array`,
        );
      }

      // 校验每个停靠点的格式
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        if (!Array.isArray(stop) || stop.length !== 5) {
          throw new Error(
            `[${HEATMAP_ERROR_CODES.INVALID_COLOR_RAMP}] stop[${i}] must be [position, r, g, b, a]`,
          );
        }

        // position 范围 [0, 1]
        if (!Number.isFinite(stop[0]) || stop[0] < 0 || stop[0] > 1) {
          throw new Error(
            `[${HEATMAP_ERROR_CODES.INVALID_COLOR_RAMP}] stop[${i}].position must be in [0, 1], got ${stop[0]}`,
          );
        }

        // RGBA 范围 [0, 255]
        for (let c = 1; c <= 4; c++) {
          if (!Number.isFinite(stop[c]) || stop[c] < 0 || stop[c] > 255) {
            throw new Error(
              `[${HEATMAP_ERROR_CODES.INVALID_COLOR_RAMP}] stop[${i}] channel ${c} must be in [0, 255], got ${stop[c]}`,
            );
          }
        }
      }

      // 保存停靠点并重新生成 LUT
      currentColorStops = stops;
      colorRamp = generateColorRamp(stops);
    },
  };

  return layer;
}
