// ============================================================
// PointCloudLayer.ts — 点云图层（L4 图层包）
// 职责：管理大规模 3D 点云的渲染（LAS/LAZ/3D Tiles 点云），
//       支持多种着色模式（RGB/高度/强度/分类）、EDL 增强、
//       自适应点尺寸衰减。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
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
// 错误码常量
// ---------------------------------------------------------------------------

/**
 * PointCloudLayer 模块错误码，前缀 `POINTCLOUD_` 以避免跨模块碰撞。
 */
const POINTCLOUD_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'POINTCLOUD_INVALID_OPTIONS',
  /** 点尺寸超出有效区间 */
  INVALID_POINT_SIZE: 'POINTCLOUD_INVALID_POINT_SIZE',
  /** 颜色模式不合法 */
  INVALID_COLOR_MODE: 'POINTCLOUD_INVALID_COLOR_MODE',
  /** EDL 参数不合法 */
  INVALID_EDL_PARAMS: 'POINTCLOUD_INVALID_EDL_PARAMS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'POINTCLOUD_INVALID_OPACITY',
  /** maxPoints 不合法 */
  INVALID_MAX_POINTS: 'POINTCLOUD_INVALID_MAX_POINTS',
  /** 点云数据格式不合法 */
  INVALID_POINT_DATA: 'POINTCLOUD_INVALID_POINT_DATA',
  /** 高度色带格式不合法 */
  INVALID_HEIGHT_RAMP: 'POINTCLOUD_INVALID_HEIGHT_RAMP',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认点尺寸（像素） */
const DEFAULT_POINT_SIZE = 2.0;

/** 点尺寸的有效下限（像素） */
const POINT_SIZE_MIN = 0.5;

/** 点尺寸的有效上限（像素） */
const POINT_SIZE_MAX = 64.0;

/** 默认 EDL 强度因子——控制边缘暗化程度 */
const DEFAULT_EDL_STRENGTH = 1.0;

/** 默认 EDL 采样半径（像素）——深度差分的采样邻域 */
const DEFAULT_EDL_RADIUS = 1.4;

/** 默认最大渲染点数——超过此数量的点将被 LOD 或采样策略跳过 */
const DEFAULT_MAX_POINTS = 5_000_000;

/** 最大渲染点数下限 */
const MAX_POINTS_MIN = 1000;

/** 不透明度范围 */
const OPACITY_MIN = 0;
const OPACITY_MAX = 1;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** EDL 强度有效范围下限 */
const EDL_STRENGTH_MIN = 0;

/** EDL 半径有效范围下限 */
const EDL_RADIUS_MIN = 0;

/** 高度色带条目数 */
const HEIGHT_RAMP_WIDTH = 256;

/** RGBA 通道数 */
const RGBA_CHANNELS = 4;

/** 自适应点尺寸衰减的参考距离（米）——在此距离下点尺寸为配置值 */
const ADAPTIVE_REFERENCE_DISTANCE = 1000.0;

// ---------------------------------------------------------------------------
// LAS 分类颜色常量（ASPRS LAS 1.4 标准分类码）
// ---------------------------------------------------------------------------

/**
 * LAS 标准分类码对应的默认 RGB 颜色。
 * 键为分类码（0~18），值为 [r, g, b]，各通道范围 [0, 255]。
 * 分类码定义参见 ASPRS LAS 1.4 Specification Table 17。
 */
const DEFAULT_CLASSIFICATION_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [200, 200, 200], // 0: Never Classified（灰色）
  [200, 200, 200], // 1: Unassigned（灰色）
  [139, 90, 43],   // 2: Ground（棕色）
  [0, 128, 0],     // 3: Low Vegetation（深绿）
  [0, 180, 0],     // 4: Medium Vegetation（中绿）
  [0, 230, 0],     // 5: High Vegetation（亮绿）
  [255, 0, 0],     // 6: Building（红色）
  [255, 165, 0],   // 7: Low Point (Noise)（橙色）
  [128, 128, 128], // 8: Reserved / Model Key-point（中灰）
  [0, 0, 255],     // 9: Water（蓝色）
  [192, 192, 192], // 10: Rail（银色）
  [64, 64, 64],    // 11: Road Surface（深灰）
  [128, 128, 128], // 12: Reserved / Overlap（灰色）
  [255, 255, 0],   // 13: Wire - Guard（黄色）
  [255, 200, 0],   // 14: Wire - Conductor（金色）
  [100, 100, 100], // 15: Transmission Tower（暗灰）
  [0, 200, 200],   // 16: Wire - Structure Connector（青色）
  [180, 0, 180],   // 17: Bridge Deck（紫色）
  [255, 100, 100], // 18: High Noise（浅红）
] as const;

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 点云着色模式。
 * - `'rgb'`: 使用点自带的 RGB 颜色
 * - `'height'`: 按高度(Z)映射颜色渐变
 * - `'intensity'`: 按激光反射强度映射灰度
 * - `'classification'`: 按 LAS 分类码映射预定义颜色
 */
export type PointCloudColorMode = 'rgb' | 'height' | 'intensity' | 'classification';

/**
 * 点尺寸衰减模式。
 * - `'fixed'`: 固定像素大小，不随距离变化
 * - `'adaptive'`: 根据相机到点的距离自适应缩放
 */
export type PointCloudSizeAttenuation = 'fixed' | 'adaptive';

/**
 * 点的形状。
 * - `'circle'`: 圆形（fragment shader 中做圆形裁剪）
 * - `'square'`: 方形（默认 quad）
 */
export type PointCloudShape = 'circle' | 'square';

// ---------------------------------------------------------------------------
// PointCloudLayerOptions
// ---------------------------------------------------------------------------

/**
 * 点云图层构造选项。
 * 由用户传入 `createPointCloudLayer`，驱动图层初始化。
 *
 * @example
 * const opts: PointCloudLayerOptions = {
 *   id: 'lidar-scan',
 *   source: 'pointcloud-tiles',
 *   pointSize: 3.0,
 *   sizeAttenuation: 'adaptive',
 *   shape: 'circle',
 *   colorMode: 'height',
 *   edlStrength: 1.5,
 *   edlRadius: 2.0,
 *   maxPoints: 3000000,
 * };
 */
export interface PointCloudLayerOptions {
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
   * 投影标识。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * 基础点尺寸（像素）。
   * 在 adaptive 模式下作为参考距离处的点大小。
   * 范围 [0.5, 64.0]。
   * 可选，默认 2.0。
   */
  readonly pointSize?: number;

  /**
   * 点尺寸衰减模式。
   * 可选，默认 `'adaptive'`。
   */
  readonly sizeAttenuation?: PointCloudSizeAttenuation;

  /**
   * 点的渲染形状。
   * 可选，默认 `'circle'`。
   */
  readonly shape?: PointCloudShape;

  /**
   * 点云着色模式。
   * 可选，默认 `'rgb'`。
   */
  readonly colorMode?: PointCloudColorMode;

  /**
   * 高度着色渐变停靠点数组。
   * 每项 [normalizedHeight, r, g, b]，normalizedHeight ∈ [0, 1]，RGB ∈ [0, 255]。
   * 仅在 colorMode='height' 时使用。
   * 可选，默认为蓝→青→绿→黄→红渐变。
   */
  readonly heightColorRamp?: ReadonlyArray<readonly [number, number, number, number]>;

  /**
   * 分类码颜色自定义覆盖。
   * 键为分类码（数字），值为 [r, g, b]。
   * 仅在 colorMode='classification' 时使用。
   * 可选，默认使用 ASPRS LAS 标准颜色。
   */
  readonly classificationColors?: Record<number, readonly [number, number, number]>;

  /**
   * Eye-Dome Lighting 强度。
   * 0 = 禁用 EDL，越大边缘暗化越明显。
   * 可选，默认 1.0。
   */
  readonly edlStrength?: number;

  /**
   * Eye-Dome Lighting 采样半径（像素）。
   * 控制深度差分比较的像素邻域大小。
   * 可选，默认 1.4。
   */
  readonly edlRadius?: number;

  /**
   * 每帧最大渲染点数。
   * 超过此数量的点将被 LOD 采样或剔除。
   * 可选，默认 5,000,000。
   */
  readonly maxPoints?: number;

  /**
   * 图层可见的最小缩放级别（含）。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 初始不透明度 [0, 1]。
   * 可选，默认 1。
   */
  readonly opacity?: number;
}

// ---------------------------------------------------------------------------
// PointCloudBounds（点云数据包围盒）
// ---------------------------------------------------------------------------

/**
 * 点云 3D 包围盒（轴对齐），存储数据集的空间范围。
 *
 * @internal 仅模块内使用。
 */
interface PointCloudBounds {
  /** X 最小值 */
  minX: number;
  /** Y 最小值 */
  minY: number;
  /** Z 最小值（高度下限） */
  minZ: number;
  /** X 最大值 */
  maxX: number;
  /** Y 最大值 */
  maxY: number;
  /** Z 最大值（高度上限） */
  maxZ: number;
}

// ---------------------------------------------------------------------------
// PointCloudLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 点云图层接口——在 Layer 基础上扩展点云特有的样式控制和状态查询。
 * 实例由 `createPointCloudLayer` 工厂创建。
 *
 * @example
 * const layer = createPointCloudLayer({ id: 'lidar', source: 'pc-tiles' });
 * layer.setColorMode('height');
 * layer.setPointSize(4.0);
 * console.log(layer.renderedPointCount); // 当前帧渲染的点数
 */
export interface PointCloudLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'pointcloud'` */
  readonly type: 'pointcloud';

  /** 当前帧实际渲染的点数量（受 maxPoints 和 LOD 限制） */
  readonly renderedPointCount: number;

  /**
   * 获取点云数据的 2D 地理包围盒。
   * 无数据时返回 null。
   *
   * @returns BBox2D 或 null
   *
   * @example
   * const bounds = layer.getBounds();
   * if (bounds) map.fitBounds(bounds);
   */
  getBounds(): BBox2D | null;

  /**
   * 设置着色模式。
   *
   * @param mode - 着色模式
   * @throws 若 mode 不是合法的 PointCloudColorMode
   *
   * @example
   * layer.setColorMode('classification');
   */
  setColorMode(mode: PointCloudColorMode): void;

  /**
   * 设置基础点尺寸。
   *
   * @param pixels - 点尺寸（像素），范围 [0.5, 64.0]
   * @throws 若 pixels 不是有限数或超出范围
   *
   * @example
   * layer.setPointSize(5.0);
   */
  setPointSize(pixels: number): void;

  /**
   * 设置 Eye-Dome Lighting 参数。
   * 传入 strength=0 时禁用 EDL。
   *
   * @param strength - EDL 强度，范围 [0, +∞)
   * @param radius - EDL 采样半径（像素），范围 (0, +∞)
   * @throws 若参数不是有限非负数
   *
   * @example
   * layer.setEDL(2.0, 1.4);
   */
  setEDL(strength: number, radius: number): void;
}

// ---------------------------------------------------------------------------
// 高度色带生成
// ---------------------------------------------------------------------------

/**
 * 默认高度着色渐变停靠点：蓝→青→绿→黄→红。
 * 每项 [normalizedHeight, r, g, b]。
 */
const DEFAULT_HEIGHT_RAMP_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 0, 0, 255],     // 最低：蓝色
  [0.25, 0, 200, 200],   // 低：青色
  [0.5, 0, 255, 0],      // 中：绿色
  [0.75, 255, 255, 0],   // 高：黄色
  [1.0, 255, 0, 0],      // 最高：红色
] as const;

/**
 * 从高度色带停靠点生成 256 × 3 字节的 RGB 查找表。
 * 停靠点间线性插值。
 *
 * @param stops - 停靠点数组 [normalizedHeight, r, g, b]
 * @returns Uint8Array 长度 HEIGHT_RAMP_WIDTH × 3（768 字节）
 *
 * @example
 * const ramp = generateHeightRamp(DEFAULT_HEIGHT_RAMP_STOPS);
 */
function generateHeightRamp(
  stops: ReadonlyArray<readonly [number, number, number, number]>,
): Uint8Array {
  // 每个条目 3 通道 RGB（无 alpha，点云 alpha 由图层 opacity 控制）
  const channelCount = 3;
  const ramp = new Uint8Array(HEIGHT_RAMP_WIDTH * channelCount);

  // 空停靠点处理：返回全黑
  if (stops.length === 0) {
    return ramp;
  }

  // 单停靠点处理
  if (stops.length === 1) {
    const [, r, g, b] = stops[0];
    for (let i = 0; i < HEIGHT_RAMP_WIDTH; i++) {
      const offset = i * channelCount;
      ramp[offset] = r;
      ramp[offset + 1] = g;
      ramp[offset + 2] = b;
    }
    return ramp;
  }

  // 按 position 升序排序（可变副本）
  const sorted = stops.slice().sort((a, b) => a[0] - b[0]);

  // 遍历每个输出条目，线性插值
  for (let i = 0; i < HEIGHT_RAMP_WIDTH; i++) {
    const t = i / (HEIGHT_RAMP_WIDTH - 1);
    const offset = i * channelCount;

    // 查找 t 所在区间
    let lo = 0;
    let hi = sorted.length - 1;

    if (t <= sorted[0][0]) {
      lo = 0;
      hi = 0;
    } else if (t >= sorted[sorted.length - 1][0]) {
      lo = sorted.length - 1;
      hi = sorted.length - 1;
    } else {
      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s][0] && t <= sorted[s + 1][0]) {
          lo = s;
          hi = s + 1;
          break;
        }
      }
    }

    if (lo === hi) {
      ramp[offset] = sorted[lo][1];
      ramp[offset + 1] = sorted[lo][2];
      ramp[offset + 2] = sorted[lo][3];
    } else {
      const range = sorted[hi][0] - sorted[lo][0];
      const factor = range > 0 ? (t - sorted[lo][0]) / range : 0;

      ramp[offset] = Math.round(sorted[lo][1] + (sorted[hi][1] - sorted[lo][1]) * factor);
      ramp[offset + 1] = Math.round(sorted[lo][2] + (sorted[hi][2] - sorted[lo][2]) * factor);
      ramp[offset + 2] = Math.round(sorted[lo][3] + (sorted[hi][3] - sorted[lo][3]) * factor);
    }
  }

  return ramp;
}

// ---------------------------------------------------------------------------
// EDL 核心算法
// ---------------------------------------------------------------------------

/**
 * 计算单像素的 Eye-Dome Lighting 遮蔽因子。
 * EDL 通过比较中心像素与周围像素的深度差来产生边缘暗化效果，
 * 增强点云的空间感知（无需法线信息）。
 *
 * 算法：
 * 1. 采样中心像素深度 d_c
 * 2. 沿 4 个主方向（上/下/左/右）采样邻域深度 d_i
 * 3. 计算 response = Σ max(0, log2(d_c) - log2(d_i))
 * 4. 遮蔽因子 = exp(-strength × response)
 *
 * @param centerDepth - 中心像素的线性深度（米）
 * @param neighborDepths - 4 个邻域像素的线性深度 [上, 右, 下, 左]
 * @param strength - EDL 强度因子
 * @returns 遮蔽因子 [0, 1]，0 = 完全遮蔽（黑），1 = 无遮蔽
 *
 * @example
 * const factor = computeEDLFactor(10.0, [10.5, 9.5, 10.0, 10.2], 1.0);
 */
function computeEDLFactor(
  centerDepth: number,
  neighborDepths: readonly [number, number, number, number],
  strength: number,
): number {
  // 深度为零或负值时不计算遮蔽（无效像素）
  if (centerDepth <= 0) {
    return 1.0;
  }

  // 计算中心像素的 log2 深度
  const logCenter = Math.log2(centerDepth);

  // 累加 4 方向的深度响应
  let response = 0.0;
  for (let i = 0; i < 4; i++) {
    const nd = neighborDepths[i];
    // 无效邻域（深度 ≤ 0）跳过
    if (nd <= 0) {
      continue;
    }
    // 深度差响应：仅当中心比邻域更远时产生遮蔽
    const diff = logCenter - Math.log2(nd);
    response += Math.max(0.0, diff);
  }

  // 指数衰减：response 越大遮蔽越强
  return Math.exp(-strength * response);
}

// ---------------------------------------------------------------------------
// LAS 分类颜色查找
// ---------------------------------------------------------------------------

/**
 * 根据 LAS 分类码查找对应的 RGB 颜色。
 * 自定义覆盖优先于默认颜色。未知分类码返回灰色。
 *
 * @param classCode - LAS 分类码（0~255）
 * @param customColors - 用户自定义分类颜色覆盖表
 * @returns [r, g, b]，各通道 [0, 255]
 *
 * @example
 * const color = lookupClassificationColor(2, {}); // [139, 90, 43] (Ground)
 */
function lookupClassificationColor(
  classCode: number,
  customColors: Record<number, readonly [number, number, number]>,
): readonly [number, number, number] {
  // 优先使用自定义颜色
  if (classCode in customColors) {
    return customColors[classCode];
  }

  // 查找默认颜色表（索引 0~18）
  if (classCode >= 0 && classCode < DEFAULT_CLASSIFICATION_COLORS.length) {
    return DEFAULT_CLASSIFICATION_COLORS[classCode];
  }

  // 未知分类码：返回中灰色
  return [128, 128, 128] as const;
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 PointCloudLayerOptions。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项
 * @throws Error 若任何校验失败
 *
 * @example
 * const cfg = validatePointCloudOptions({ id: 'pc', source: 's1' });
 */
function validatePointCloudOptions(opts: PointCloudLayerOptions): {
  id: string;
  source: string;
  projection: string;
  pointSize: number;
  sizeAttenuation: PointCloudSizeAttenuation;
  shape: PointCloudShape;
  colorMode: PointCloudColorMode;
  edlStrength: number;
  edlRadius: number;
  maxPoints: number;
  minzoom: number;
  maxzoom: number;
  opacity: number;
  heightColorRamp: ReadonlyArray<readonly [number, number, number, number]> | undefined;
  classificationColors: Record<number, readonly [number, number, number]>;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] PointCloudLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] PointCloudLayerOptions.source must be a non-empty string`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  // 点尺寸校验
  const pointSize = opts.pointSize ?? DEFAULT_POINT_SIZE;
  if (!Number.isFinite(pointSize) || pointSize < POINT_SIZE_MIN || pointSize > POINT_SIZE_MAX) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_POINT_SIZE}] pointSize must be in [${POINT_SIZE_MIN}, ${POINT_SIZE_MAX}], got ${pointSize}`,
    );
  }

  // 衰减模式校验
  const sizeAttenuation = opts.sizeAttenuation ?? 'adaptive';
  if (sizeAttenuation !== 'fixed' && sizeAttenuation !== 'adaptive') {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] sizeAttenuation must be 'fixed' or 'adaptive', got '${sizeAttenuation}'`,
    );
  }

  // 形状校验
  const shape = opts.shape ?? 'circle';
  if (shape !== 'circle' && shape !== 'square') {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] shape must be 'circle' or 'square', got '${shape}'`,
    );
  }

  // 着色模式校验
  const colorMode = opts.colorMode ?? 'rgb';
  const validModes: PointCloudColorMode[] = ['rgb', 'height', 'intensity', 'classification'];
  if (!validModes.includes(colorMode)) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_COLOR_MODE}] colorMode must be one of ${validModes.join('/')}, got '${colorMode}'`,
    );
  }

  // EDL 参数校验
  const edlStrength = opts.edlStrength ?? DEFAULT_EDL_STRENGTH;
  if (!Number.isFinite(edlStrength) || edlStrength < EDL_STRENGTH_MIN) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_EDL_PARAMS}] edlStrength must be >= 0, got ${edlStrength}`,
    );
  }

  const edlRadius = opts.edlRadius ?? DEFAULT_EDL_RADIUS;
  if (!Number.isFinite(edlRadius) || edlRadius < EDL_RADIUS_MIN) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_EDL_PARAMS}] edlRadius must be >= 0, got ${edlRadius}`,
    );
  }

  // maxPoints 校验
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
  if (!Number.isFinite(maxPoints) || maxPoints < MAX_POINTS_MIN) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_MAX_POINTS}] maxPoints must be >= ${MAX_POINTS_MIN}, got ${maxPoints}`,
    );
  }

  // 缩放范围校验
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // 不透明度校验
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${POINTCLOUD_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  // 分类颜色覆盖——如果未提供则为空对象
  const classificationColors: Record<number, readonly [number, number, number]> =
    opts.classificationColors
      ? { ...opts.classificationColors }
      : {};

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    projection,
    pointSize,
    sizeAttenuation,
    shape,
    colorMode,
    edlStrength,
    edlRadius,
    maxPoints,
    minzoom,
    maxzoom,
    opacity,
    heightColorRamp: opts.heightColorRamp,
    classificationColors,
  };
}

// ---------------------------------------------------------------------------
// createPointCloudLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建点云图层实例。
 * 返回完整的 {@link PointCloudLayer} 实现，包含多着色模式、EDL 增强、
 * 自适应点尺寸和包围盒管理。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现。
 *
 * @param opts - 点云图层构造选项
 * @returns 完整的 PointCloudLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const pcLayer = createPointCloudLayer({
 *   id: 'lidar-scan',
 *   source: 'pointcloud-tiles',
 *   pointSize: 3.0,
 *   colorMode: 'height',
 *   edlStrength: 1.5,
 * });
 * sceneGraph.addLayer(pcLayer);
 */
export function createPointCloudLayer(opts: PointCloudLayerOptions): PointCloudLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validatePointCloudOptions(opts);

  // ── 2. 内部状态 ──

  // 渲染参数（运行时可修改）
  let pointSize = cfg.pointSize;
  let sizeAttenuation: PointCloudSizeAttenuation = cfg.sizeAttenuation;
  let shape: PointCloudShape = cfg.shape;
  let colorMode: PointCloudColorMode = cfg.colorMode;
  let edlStrength = cfg.edlStrength;
  let edlRadius = cfg.edlRadius;
  let maxPoints = cfg.maxPoints;

  // 高度色带 LUT
  let heightRamp: Uint8Array = generateHeightRamp(
    cfg.heightColorRamp ?? DEFAULT_HEIGHT_RAMP_STOPS,
  );

  // 分类颜色覆盖表
  const classificationColors: Record<number, readonly [number, number, number]> =
    { ...cfg.classificationColors };

  // 点云数据包围盒（加载数据后更新）
  let bounds: PointCloudBounds | null = null;

  // 当前帧渲染的点数量
  let renderedPoints = 0;

  // 总加载的点数量
  let totalLoadedPoints = 0;

  // paint/layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 图层生命周期标志
  let mounted = false;
  let layerContext: LayerContext | null = null;
  let dataReady = false;

  // ── 3. 构造 Layer 实现对象 ──
  const layer: PointCloudLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'pointcloud' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪。
     * @returns true 表示有可渲染内容
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 点云在不透明度 < 1 时视为半透明。
     * @returns 是否半透明
     */
    get isTransparent(): boolean {
      return layer.opacity < OPACITY_MAX;
    },

    /**
     * 全局渲染次序。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前帧渲染的点数量。
     * @returns 渲染点数
     */
    get renderedPointCount(): number {
      return renderedPoints;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载时由 LayerManager 调用。
     *
     * @param context - 引擎注入的上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
    },

    /**
     * 图层卸载时由 LayerManager 调用。
     */
    onRemove(): void {
      featureStateMap.clear();
      bounds = null;
      renderedPoints = 0;
      totalLoadedPoints = 0;
      mounted = false;
      layerContext = null;
      dataReady = false;
    },

    /**
     * 每帧更新——计算自适应点尺寸、确定渲染点数。
     *
     * @param deltaTime - 距上一帧的时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // ── 缩放级别可见性判断 ──
      if (camera.zoom < cfg.minzoom || camera.zoom > cfg.maxzoom) {
        renderedPoints = 0;
        return;
      }

      // ── 计算当前帧渲染点数 ──
      // 受 maxPoints 限制
      renderedPoints = Math.min(totalLoadedPoints, maxPoints);

      // ── 自适应点尺寸计算（将在 encode 阶段使用） ──
      // 在 adaptive 模式下，点尺寸按相机高度等比缩放：
      // effectiveSize = pointSize × (referenceDistance / altitude)
      // 已在内部状态中准备好参数，encode 阶段通过 Uniform 传递给 GPU
    },

    /**
     * 将点云绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        if (renderedPoints > 0) {
          // 计算自适应点尺寸（仅用于日志）
          let effectiveSize = pointSize;
          if (sizeAttenuation === 'adaptive' && _camera.altitude > 0) {
            effectiveSize = pointSize * (ADAPTIVE_REFERENCE_DISTANCE / _camera.altitude);
            // 钳位到合理范围
            effectiveSize = Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, effectiveSize));
          }

          console.debug(
            `[PointCloudLayer:${cfg.id}] encode stub: ${renderedPoints}/${totalLoadedPoints} points, ` +
              `size=${effectiveSize.toFixed(1)}px (${sizeAttenuation}), ` +
              `colorMode=${colorMode}, shape=${shape}, ` +
              `edl=${edlStrength > 0 ? `on(s=${edlStrength},r=${edlRadius})` : 'off'}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——点云支持点级拾取（通过 ID 编码）。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要将点索引编码为拾取颜色
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

      if (typeof value === 'number' && Number.isFinite(value)) {
        switch (name) {
          case 'point-size':
            pointSize = value;
            break;
          case 'point-opacity':
            layer.opacity = value;
            break;
          case 'edl-strength':
            edlStrength = value;
            break;
          case 'edl-radius':
            edlRadius = value;
            break;
          default:
            break;
        }
      } else if (typeof value === 'string') {
        switch (name) {
          case 'color-mode':
            if (['rgb', 'height', 'intensity', 'classification'].includes(value)) {
              colorMode = value as PointCloudColorMode;
            }
            break;
          case 'size-attenuation':
            if (value === 'fixed' || value === 'adaptive') {
              sizeAttenuation = value;
            }
            break;
          case 'shape':
            if (value === 'circle' || value === 'square') {
              shape = value;
            }
            break;
          default:
            break;
        }
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

      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性值。
     *
     * @param name - paint 属性名
     * @returns 属性值或 undefined
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性值。
     *
     * @param name - layout 属性名
     * @returns 属性值或 undefined
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 设置点云数据。
     * 接受包含位置数组和可选属性的数据对象。
     *
     * @param data - 点云数据载荷，需包含 positions(Float32Array xyz interleaved), count
     */
    setData(data: unknown): void {
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 提取点数量
      const count = typeof record['count'] === 'number' ? record['count'] : 0;
      if (count <= 0) {
        return;
      }

      // 提取位置数组（xyz 交错，每个点 3 个 float）
      const positions = record['positions'];
      if (!(positions instanceof Float32Array) || positions.length < count * 3) {
        return;
      }

      // 计算包围盒
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (let i = 0; i < count; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];

        // 跳过 NaN/Infinity 点
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          continue;
        }

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }

      // 校验包围盒有效性（至少有一个有效点）
      if (minX <= maxX && minY <= maxY && minZ <= maxZ) {
        bounds = { minX, minY, minZ, maxX, maxY, maxZ };
      }

      totalLoadedPoints = count;
      dataReady = count > 0;
    },

    /**
     * 读取当前点云状态快照。
     *
     * @returns 状态摘要
     */
    getData(): unknown {
      return {
        totalPoints: totalLoadedPoints,
        renderedPoints,
        bounds: bounds ? { ...bounds } : null,
        colorMode,
        pointSize,
        edlEnabled: edlStrength > 0,
      };
    },

    // ==================== 要素查询方法 ====================

    /**
     * 包围盒要素查询——点云目前不支持，返回空数组。
     *
     * @param _bbox - 查询范围
     * @param _filter - 可选过滤器
     * @returns 空数组
     */
    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },

    /**
     * 屏幕点选查询——点云支持但 MVP 阶段返回空。
     *
     * @param _point - 屏幕坐标
     * @returns 空数组
     */
    queryRenderedFeatures(_point: [number, number]): Feature[] {
      return [];
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素状态。
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

    // ==================== 点云特有方法 ====================

    /**
     * 获取点云数据的 2D 地理包围盒。
     *
     * @returns BBox2D 或 null
     */
    getBounds(): BBox2D | null {
      if (bounds === null) {
        return null;
      }
      // 将内部包围盒映射为 BBox2D（XY → 经纬度近似）
      return {
        west: bounds.minX,
        south: bounds.minY,
        east: bounds.maxX,
        north: bounds.maxY,
      };
    },

    /**
     * 设置着色模式。
     *
     * @param mode - 着色模式
     */
    setColorMode(mode: PointCloudColorMode): void {
      const validModes: PointCloudColorMode[] = ['rgb', 'height', 'intensity', 'classification'];
      if (!validModes.includes(mode)) {
        throw new Error(
          `[${POINTCLOUD_ERROR_CODES.INVALID_COLOR_MODE}] colorMode must be one of ${validModes.join('/')}, got '${mode}'`,
        );
      }
      colorMode = mode;
      paintProps.set('color-mode', mode);
    },

    /**
     * 设置基础点尺寸。
     *
     * @param pixels - 像素，范围 [0.5, 64.0]
     */
    setPointSize(pixels: number): void {
      if (!Number.isFinite(pixels) || pixels < POINT_SIZE_MIN || pixels > POINT_SIZE_MAX) {
        throw new Error(
          `[${POINTCLOUD_ERROR_CODES.INVALID_POINT_SIZE}] pointSize must be in [${POINT_SIZE_MIN}, ${POINT_SIZE_MAX}], got ${pixels}`,
        );
      }
      pointSize = pixels;
      paintProps.set('point-size', pixels);
    },

    /**
     * 设置 EDL 参数。
     *
     * @param strength - EDL 强度
     * @param radius - EDL 采样半径
     */
    setEDL(strength: number, radius: number): void {
      if (!Number.isFinite(strength) || strength < EDL_STRENGTH_MIN) {
        throw new Error(
          `[${POINTCLOUD_ERROR_CODES.INVALID_EDL_PARAMS}] edlStrength must be >= 0, got ${strength}`,
        );
      }
      if (!Number.isFinite(radius) || radius < EDL_RADIUS_MIN) {
        throw new Error(
          `[${POINTCLOUD_ERROR_CODES.INVALID_EDL_PARAMS}] edlRadius must be >= 0, got ${radius}`,
        );
      }
      edlStrength = strength;
      edlRadius = radius;
      paintProps.set('edl-strength', strength);
      paintProps.set('edl-radius', radius);
    },
  };

  return layer;
}
