// ============================================================
// MarkerLayer.ts — 标记点图层（L4 图层包）
// 职责：管理离散标记点（图标+标签）的添加/删除/更新/拖拽，
//       支持 grid-based 聚合（类似 Supercluster 算法），
//       事件分发（click/drag/enter/leave）。
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
 * MarkerLayer 模块错误码，前缀 `MARKER_` 以避免跨模块碰撞。
 */
const MARKER_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'MARKER_INVALID_OPTIONS',
  /** MarkerSpec 校验失败 */
  INVALID_MARKER_SPEC: 'MARKER_INVALID_MARKER_SPEC',
  /** Marker ID 重复 */
  DUPLICATE_MARKER: 'MARKER_DUPLICATE_MARKER',
  /** Marker ID 不存在 */
  MARKER_NOT_FOUND: 'MARKER_NOT_FOUND',
  /** 聚合参数不合法 */
  INVALID_CLUSTER_PARAMS: 'MARKER_INVALID_CLUSTER_PARAMS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'MARKER_INVALID_OPACITY',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认图标尺寸（CSS 像素，正方形边长） */
const DEFAULT_ICON_SIZE = 32;

/** 默认标签字号（CSS 像素） */
const DEFAULT_LABEL_SIZE = 14;

/** 默认标签偏移 [x, y]（CSS 像素，相对于锚点） */
const DEFAULT_LABEL_OFFSET_X = 0;
const DEFAULT_LABEL_OFFSET_Y = -20;

/** 默认标记颜色（十六进制） */
const DEFAULT_MARKER_COLOR = '#4264fb';

/** 默认聚合半径（CSS 像素） */
const DEFAULT_CLUSTER_RADIUS = 50;

/** 默认聚合最大缩放级别（超过此级别不再聚合） */
const DEFAULT_CLUSTER_MAX_ZOOM = 14;

/** 不透明度范围 */
const OPACITY_MIN = 0;
const OPACITY_MAX = 1;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 经度到墨卡托 X 的转换系数（简化，256 瓦片世界宽度） */
const LNG_TO_MERCATOR_X = 256 / 360;

/** 默认标记优先级（越高越优先显示，碰撞检测时使用） */
const DEFAULT_PRIORITY = 0;

// ---------------------------------------------------------------------------
// MarkerSpec（单个标记描述）
// ---------------------------------------------------------------------------

/**
 * 单个标记点的完整描述。
 * 包含位置、外观、交互属性和用户自定义数据。
 *
 * @example
 * const marker: MarkerSpec = {
 *   id: 'poi-001',
 *   lngLat: [116.39, 39.91],
 *   icon: 'restaurant',
 *   iconSize: 32,
 *   label: '天安门广场',
 *   draggable: false,
 *   data: { category: 'tourism', rating: 4.5 },
 * };
 */
export interface MarkerSpec {
  /**
   * 标记唯一 ID，在同一 MarkerLayer 内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * 标记的经纬度坐标 [longitude, latitude]。
   * 单位：度（°）。
   * longitude 范围 [-180, 180]，latitude 范围 [-90, 90]。
   * 必填。
   */
  readonly lngLat: readonly [number, number];

  /**
   * 图标名称或 URL。
   * 名称对应 SpriteSheet 中的条目，URL 为自定义图片。
   * 可选，默认使用内置默认标记图标。
   */
  readonly icon?: string;

  /**
   * 图标尺寸（CSS 像素，正方形边长）。
   * 可选，默认 32。
   */
  readonly iconSize?: number;

  /**
   * 图标旋转角度（度）。
   * 0 = 正北朝上，正值顺时针旋转。
   * 可选，默认 0。
   */
  readonly iconRotation?: number;

  /**
   * 标记颜色（CSS 颜色字符串）。
   * 用于默认图标的着色和标签底色。
   * 可选，默认 '#4264fb'。
   */
  readonly color?: string;

  /**
   * 文字标签内容。
   * 显示在图标附近，位置由 labelOffset 控制。
   * 可选，不设置则不显示标签。
   */
  readonly label?: string;

  /**
   * 标签偏移 [x, y]（CSS 像素，相对于锚点）。
   * 正 X 向右，正 Y 向下。
   * 可选，默认 [0, -20]（图标上方）。
   */
  readonly labelOffset?: readonly [number, number];

  /**
   * 标签字号（CSS 像素）。
   * 可选，默认 14。
   */
  readonly labelSize?: number;

  /**
   * 锚点位置——标记坐标对应图标的哪个点。
   * 可选，默认 'bottom'（坐标对应图标底部中心）。
   */
  readonly anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right';

  /**
   * 是否可拖拽。
   * 可选，默认 false。
   */
  readonly draggable?: boolean;

  /**
   * 点击时显示的弹出内容（HTML 字符串或纯文本）。
   * 可选。
   */
  readonly popup?: string;

  /**
   * 用户自定义数据载荷——不参与渲染，仅在事件回调中透传。
   * 可选。
   */
  readonly data?: unknown;

  /**
   * 显示优先级——碰撞检测时高优先级标记优先保留。
   * 越大越优先。
   * 可选，默认 0。
   */
  readonly priority?: number;
}

// ---------------------------------------------------------------------------
// ClusterSpec（聚合结果描述）
// ---------------------------------------------------------------------------

/**
 * 聚合簇描述——多个标记在当前缩放级别下聚合为一个圆点。
 *
 * @internal 仅模块内使用。
 */
interface ClusterSpec {
  /** 聚合簇的中心经纬度（成员坐标加权平均） */
  center: readonly [number, number];

  /** 簇内标记数量 */
  count: number;

  /** 簇内成员标记 ID 列表 */
  memberIds: string[];

  /** 簇的屏幕 X 坐标（像素） */
  screenX: number;

  /** 簇的屏幕 Y 坐标（像素） */
  screenY: number;
}

// ---------------------------------------------------------------------------
// MarkerLayerOptions
// ---------------------------------------------------------------------------

/**
 * 标记图层构造选项。
 *
 * @example
 * const opts: MarkerLayerOptions = {
 *   id: 'pois',
 *   markers: [
 *     { id: 'p1', lngLat: [116.39, 39.91], label: 'Beijing' },
 *     { id: 'p2', lngLat: [121.47, 31.23], label: 'Shanghai' },
 *   ],
 *   cluster: true,
 *   clusterRadius: 60,
 *   clusterMaxZoom: 12,
 * };
 */
export interface MarkerLayerOptions {
  /**
   * 图层唯一 ID。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的数据源 ID。
   * 如果提供 markers 数组则此字段作为元数据标识。
   * 可选，默认为空字符串。
   */
  readonly source?: string;

  /**
   * 投影标识。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * 初始标记列表。
   * 可选，也可通过 addMarker / addMarkers 动态添加。
   */
  readonly markers?: ReadonlyArray<MarkerSpec>;

  /**
   * 是否启用聚合。
   * 可选，默认 false。
   */
  readonly cluster?: boolean;

  /**
   * 聚合半径（CSS 像素）——在此半径内的标记会被合并。
   * 仅当 cluster=true 时生效。
   * 可选，默认 50。
   */
  readonly clusterRadius?: number;

  /**
   * 聚合最大缩放级别——超过此级别时所有标记单独显示。
   * 仅当 cluster=true 时生效。
   * 可选，默认 14。
   */
  readonly clusterMaxZoom?: number;

  /**
   * 自定义聚合图标工厂——接收簇内标记数量，返回图标名称或 URL。
   * 可选，默认显示数字圆圈。
   */
  readonly clusterIconFactory?: (count: number) => string;

  /**
   * 图层可见的最小缩放级别。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别。
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
// 事件回调类型
// ---------------------------------------------------------------------------

/**
 * 标记点击事件回调。
 *
 * @param markerId - 被点击的标记 ID
 * @param marker - 标记描述
 * @param screenPos - 点击位置的屏幕坐标 [x, y]
 */
export type MarkerClickCallback = (
  markerId: string,
  marker: MarkerSpec,
  screenPos: [number, number],
) => void;

/**
 * 标记拖拽结束事件回调。
 *
 * @param markerId - 被拖拽的标记 ID
 * @param newLngLat - 拖拽后的新经纬度
 */
export type MarkerDragEndCallback = (
  markerId: string,
  newLngLat: [number, number],
) => void;

/**
 * 标记鼠标进入事件回调。
 *
 * @param markerId - 标记 ID
 * @param marker - 标记描述
 */
export type MarkerEnterCallback = (markerId: string, marker: MarkerSpec) => void;

/**
 * 标记鼠标离开事件回调。
 *
 * @param markerId - 标记 ID
 */
export type MarkerLeaveCallback = (markerId: string) => void;

// ---------------------------------------------------------------------------
// MarkerLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 标记图层接口——在 Layer 基础上扩展标记管理、聚合和事件处理。
 * 实例由 `createMarkerLayer` 工厂创建。
 *
 * @example
 * const layer = createMarkerLayer({ id: 'pois', cluster: true });
 * layer.addMarker({ id: 'm1', lngLat: [116.39, 39.91], label: 'Beijing' });
 * layer.onMarkerClick((id, marker) => console.log('Clicked:', id));
 */
export interface MarkerLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'marker'` */
  readonly type: 'marker';

  /**
   * 添加单个标记。
   *
   * @param spec - 标记描述
   * @throws 若 spec.id 已存在或格式不合法
   *
   * @example
   * layer.addMarker({ id: 'p1', lngLat: [116.39, 39.91] });
   */
  addMarker(spec: MarkerSpec): void;

  /**
   * 批量添加标记。
   *
   * @param specs - 标记描述数组
   * @throws 若任一 spec.id 已存在或格式不合法
   *
   * @example
   * layer.addMarkers([
   *   { id: 'p1', lngLat: [116.39, 39.91] },
   *   { id: 'p2', lngLat: [121.47, 31.23] },
   * ]);
   */
  addMarkers(specs: ReadonlyArray<MarkerSpec>): void;

  /**
   * 移除标记。
   *
   * @param markerId - 标记 ID
   * @throws 若 markerId 不存在
   *
   * @example
   * layer.removeMarker('p1');
   */
  removeMarker(markerId: string): void;

  /**
   * 移动标记到新位置。
   *
   * @param markerId - 标记 ID
   * @param lngLat - 新经纬度坐标
   * @throws 若 markerId 不存在
   *
   * @example
   * layer.setMarkerPosition('p1', [117.0, 40.0]);
   */
  setMarkerPosition(markerId: string, lngLat: [number, number]): void;

  /**
   * 更新标记属性（合并更新，未提供的属性保留原值）。
   *
   * @param markerId - 标记 ID
   * @param updates - 部分标记描述（id 和 lngLat 不可通过此方法修改）
   * @throws 若 markerId 不存在
   *
   * @example
   * layer.updateMarker('p1', { label: 'New Label', color: '#ff0000' });
   */
  updateMarker(markerId: string, updates: Partial<Omit<MarkerSpec, 'id' | 'lngLat'>>): void;

  /**
   * 获取所有标记列表。
   *
   * @returns 标记描述数组（副本）
   */
  getMarkers(): MarkerSpec[];

  /**
   * 获取指定标记。
   *
   * @param markerId - 标记 ID
   * @returns 标记描述或 undefined
   */
  getMarker(markerId: string): MarkerSpec | undefined;

  /**
   * 清空所有标记。
   */
  clearMarkers(): void;

  /**
   * 获取标记总数。
   *
   * @returns 标记数量
   */
  markerCount(): number;

  /**
   * 订阅标记点击事件。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onMarkerClick(callback: MarkerClickCallback): () => void;

  /**
   * 订阅标记拖拽结束事件。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onMarkerDragEnd(callback: MarkerDragEndCallback): () => void;

  /**
   * 订阅标记鼠标进入事件。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onMarkerEnter(callback: MarkerEnterCallback): () => void;

  /**
   * 订阅标记鼠标离开事件。
   *
   * @param callback - 回调函数
   * @returns 取消订阅函数
   */
  onMarkerLeave(callback: MarkerLeaveCallback): () => void;
}

// ---------------------------------------------------------------------------
// MarkerSpec 校验
// ---------------------------------------------------------------------------

/**
 * 校验单个 MarkerSpec 的合法性。
 *
 * @param spec - 标记描述
 * @throws Error 若格式不合法
 *
 * @example
 * validateMarkerSpec({ id: 'm1', lngLat: [116, 39] }); // OK
 */
function validateMarkerSpec(spec: MarkerSpec): void {
  // id 必须为非空字符串
  if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] MarkerSpec.id must be a non-empty string`,
    );
  }

  // lngLat 必须为 [number, number]
  if (
    !Array.isArray(spec.lngLat) ||
    spec.lngLat.length < 2 ||
    !Number.isFinite(spec.lngLat[0]) ||
    !Number.isFinite(spec.lngLat[1])
  ) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] MarkerSpec.lngLat must be [lng, lat] with finite numbers, id='${spec.id}'`,
    );
  }

  // 经度范围校验
  if (spec.lngLat[0] < -180 || spec.lngLat[0] > 180) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] longitude must be in [-180, 180], got ${spec.lngLat[0]}, id='${spec.id}'`,
    );
  }

  // 纬度范围校验
  if (spec.lngLat[1] < -90 || spec.lngLat[1] > 90) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] latitude must be in [-90, 90], got ${spec.lngLat[1]}, id='${spec.id}'`,
    );
  }

  // iconSize 校验（如果提供）
  if (spec.iconSize !== undefined) {
    if (!Number.isFinite(spec.iconSize) || spec.iconSize <= 0) {
      throw new Error(
        `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] iconSize must be a positive finite number, id='${spec.id}'`,
      );
    }
  }

  // iconRotation 校验（如果提供）
  if (spec.iconRotation !== undefined) {
    if (!Number.isFinite(spec.iconRotation)) {
      throw new Error(
        `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] iconRotation must be a finite number, id='${spec.id}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Grid-based 聚合算法
// ---------------------------------------------------------------------------

/**
 * 经纬度转墨卡托像素坐标（简化的 Web Mercator 投影）。
 * 用于聚合时的空间索引。
 *
 * @param lng - 经度（度）
 * @param lat - 纬度（度）
 * @param zoom - 缩放级别
 * @returns [pixelX, pixelY] 屏幕像素坐标
 *
 * @example
 * const [px, py] = lngLatToPixel(116.39, 39.91, 10);
 */
function lngLatToPixel(lng: number, lat: number, zoom: number): [number, number] {
  // Web Mercator 投影公式
  const scale = Math.pow(2, zoom) * 256;

  // 经度 → 像素 X：线性映射 [-180, 180] → [0, scale]
  const x = ((lng + 180) / 360) * scale;

  // 纬度 → 像素 Y：Mercator 非线性映射
  const latRad = (lat * Math.PI) / 180;
  // 钳位纬度到合法墨卡托范围，避免 tan 溢出
  const clampedLatRad = Math.max(-1.4844, Math.min(1.4844, latRad));
  const y = ((1 - Math.log(Math.tan(clampedLatRad) + 1 / Math.cos(clampedLatRad)) / Math.PI) / 2) * scale;

  return [x, y];
}

/**
 * 基于网格的标记聚合算法。
 * 将屏幕空间划分为 clusterRadius 大小的网格单元，
 * 同一单元格内的标记聚合为一个簇。
 *
 * 算法复杂度：O(N) 遍历 + O(G) 簇生成，N 为标记数，G 为网格单元数。
 *
 * @param markers - 所有标记的 Map
 * @param zoom - 当前缩放级别
 * @param clusterRadius - 聚合半径（像素）
 * @returns 聚合簇数组
 *
 * @example
 * const clusters = computeClusters(markerMap, 10, 50);
 */
function computeClusters(
  markers: Map<string, MarkerSpec>,
  zoom: number,
  clusterRadius: number,
): ClusterSpec[] {
  // 空标记时直接返回
  if (markers.size === 0) {
    return [];
  }

  // 网格单元大小（像素）
  const cellSize = clusterRadius;

  // 安全检查：cellSize 必须大于零
  if (cellSize <= 0) {
    return [];
  }

  // 网格桶：key = "gridX_gridY"，值为该格子内的标记 ID 列表和像素坐标
  const grid = new Map<string, Array<{ id: string; px: number; py: number; lng: number; lat: number }>>();

  // 第一遍：将所有标记投影到屏幕坐标并分配到网格
  for (const [id, marker] of markers) {
    const [px, py] = lngLatToPixel(marker.lngLat[0], marker.lngLat[1], zoom);

    // 计算网格坐标
    const gx = Math.floor(px / cellSize);
    const gy = Math.floor(py / cellSize);
    const key = `${gx}_${gy}`;

    // 获取或创建格子
    let bucket = grid.get(key);
    if (bucket === undefined) {
      bucket = [];
      grid.set(key, bucket);
    }

    bucket.push({ id, px, py, lng: marker.lngLat[0], lat: marker.lngLat[1] });
  }

  // 第二遍：将每个网格桶转换为聚合簇
  const clusters: ClusterSpec[] = [];

  for (const bucket of grid.values()) {
    // 单元素桶不产生聚合（标记单独显示）
    if (bucket.length === 1) {
      const item = bucket[0];
      clusters.push({
        center: [item.lng, item.lat] as const,
        count: 1,
        memberIds: [item.id],
        screenX: item.px,
        screenY: item.py,
      });
      continue;
    }

    // 多元素桶：计算加权中心（简单平均）
    let sumLng = 0;
    let sumLat = 0;
    let sumPx = 0;
    let sumPy = 0;
    const memberIds: string[] = [];

    for (const item of bucket) {
      sumLng += item.lng;
      sumLat += item.lat;
      sumPx += item.px;
      sumPy += item.py;
      memberIds.push(item.id);
    }

    const count = bucket.length;
    clusters.push({
      center: [sumLng / count, sumLat / count] as const,
      count,
      memberIds,
      screenX: sumPx / count,
      screenY: sumPy / count,
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 MarkerLayerOptions。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项
 * @throws Error 若任何校验失败
 */
function validateMarkerOptions(opts: MarkerLayerOptions): {
  id: string;
  source: string;
  projection: string;
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
  clusterIconFactory: ((count: number) => string) | undefined;
  minzoom: number;
  maxzoom: number;
  opacity: number;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_OPTIONS}] MarkerLayerOptions.id must be a non-empty string`,
    );
  }

  // source 默认空字符串
  const source = (opts.source ?? '').trim();

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  // 聚合开关
  const cluster = opts.cluster ?? false;

  // 聚合半径校验
  const clusterRadius = opts.clusterRadius ?? DEFAULT_CLUSTER_RADIUS;
  if (cluster && (!Number.isFinite(clusterRadius) || clusterRadius <= 0)) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_CLUSTER_PARAMS}] clusterRadius must be a positive finite number, got ${clusterRadius}`,
    );
  }

  // 聚合最大缩放校验
  const clusterMaxZoom = opts.clusterMaxZoom ?? DEFAULT_CLUSTER_MAX_ZOOM;
  if (cluster && (!Number.isFinite(clusterMaxZoom) || clusterMaxZoom < 0)) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_CLUSTER_PARAMS}] clusterMaxZoom must be >= 0, got ${clusterMaxZoom}`,
    );
  }

  // 缩放范围
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;

  // 不透明度
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${MARKER_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  return {
    id: opts.id.trim(),
    source,
    projection,
    cluster,
    clusterRadius,
    clusterMaxZoom,
    clusterIconFactory: opts.clusterIconFactory,
    minzoom,
    maxzoom,
    opacity,
  };
}

// ---------------------------------------------------------------------------
// createMarkerLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建标记图层实例。
 * 返回完整的 {@link MarkerLayer} 实现，包含标记 CRUD、
 * grid-based 聚合、事件分发和图层生命周期管理。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现。
 *
 * @param opts - 标记图层构造选项
 * @returns 完整的 MarkerLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const markerLayer = createMarkerLayer({
 *   id: 'pois',
 *   markers: [{ id: 'p1', lngLat: [116.39, 39.91], label: 'Beijing' }],
 *   cluster: true,
 *   clusterRadius: 60,
 * });
 * sceneGraph.addLayer(markerLayer);
 */
export function createMarkerLayer(opts: MarkerLayerOptions): MarkerLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateMarkerOptions(opts);

  // ── 2. 内部状态 ──

  // 标记存储：id → MarkerSpec
  const markerMap = new Map<string, MarkerSpec>();

  // 当前帧的聚合结果缓存
  let currentClusters: ClusterSpec[] = [];

  // 聚合脏标记——标记增删或缩放变化时需重新聚合
  let clustersDirty = true;

  // 上一帧的缩放级别（用于检测缩放变化）
  let lastZoom = -1;

  // 事件回调列表
  const clickCallbacks: MarkerClickCallback[] = [];
  const dragEndCallbacks: MarkerDragEndCallback[] = [];
  const enterCallbacks: MarkerEnterCallback[] = [];
  const leaveCallbacks: MarkerLeaveCallback[] = [];

  // paint/layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 图层生命周期标志
  let mounted = false;
  let layerContext: LayerContext | null = null;

  // ── 3. 批量添加初始标记（校验后添加） ──
  if (opts.markers) {
    for (const spec of opts.markers) {
      validateMarkerSpec(spec);
      markerMap.set(spec.id, spec);
    }
    clustersDirty = true;
  }

  // ── 4. 辅助方法：安全调用回调 ──

  /**
   * 安全调用回调数组中的每个函数，隔离单个回调的异常。
   *
   * @param callbacks - 回调数组
   * @param args - 传递给回调的参数
   */
  function safeInvokeAll<T extends (...args: any[]) => void>(
    callbacks: T[],
    ...args: Parameters<T>
  ): void {
    for (const cb of callbacks) {
      try {
        cb(...args);
      } catch {
        // 订阅者错误隔离：不阻断主流程
      }
    }
  }

  /**
   * 从回调数组中移除特定回调。
   *
   * @param array - 回调数组
   * @param callback - 要移除的回调
   * @returns 取消订阅函数
   */
  function removeCallback<T>(array: T[], callback: T): () => void {
    return () => {
      const idx = array.indexOf(callback);
      if (idx >= 0) {
        array.splice(idx, 1);
      }
    };
  }

  // ── 5. 构造 Layer 实现对象 ──
  const layer: MarkerLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'marker' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（有至少一个标记）。
     * @returns true 表示有可渲染内容
     */
    get isLoaded(): boolean {
      return markerMap.size > 0;
    },

    /**
     * 标记图层始终可能包含半透明内容（图标 alpha）。
     * @returns 始终 true
     */
    get isTransparent(): boolean {
      return true;
    },

    /**
     * 全局渲染次序。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载。
     *
     * @param context - 引擎上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
      clustersDirty = true;
    },

    /**
     * 图层卸载。
     */
    onRemove(): void {
      markerMap.clear();
      currentClusters = [];
      clickCallbacks.length = 0;
      dragEndCallbacks.length = 0;
      enterCallbacks.length = 0;
      leaveCallbacks.length = 0;
      featureStateMap.clear();
      mounted = false;
      layerContext = null;
      clustersDirty = false;
    },

    /**
     * 每帧更新——在缩放变化或标记变更时重新计算聚合。
     *
     * @param deltaTime - 距上一帧时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // 缩放级别可见性判断
      if (camera.zoom < cfg.minzoom || camera.zoom > cfg.maxzoom) {
        currentClusters = [];
        return;
      }

      // 检测缩放变化
      const currentZoom = Math.floor(camera.zoom);
      if (currentZoom !== lastZoom) {
        clustersDirty = true;
        lastZoom = currentZoom;
      }

      // 仅当脏标记置位时重新聚合
      if (clustersDirty && cfg.cluster) {
        // 判断是否超过聚合最大缩放——超过则不聚合
        if (camera.zoom > cfg.clusterMaxZoom) {
          // 不聚合：每个标记单独显示
          currentClusters = [];
          for (const [id, marker] of markerMap) {
            const [px, py] = lngLatToPixel(marker.lngLat[0], marker.lngLat[1], camera.zoom);
            currentClusters.push({
              center: marker.lngLat,
              count: 1,
              memberIds: [id],
              screenX: px,
              screenY: py,
            });
          }
        } else {
          // 执行 grid-based 聚合
          currentClusters = computeClusters(markerMap, camera.zoom, cfg.clusterRadius);
        }
        clustersDirty = false;
      } else if (!cfg.cluster && clustersDirty) {
        // 不启用聚合：每个标记独立
        currentClusters = [];
        for (const [id, marker] of markerMap) {
          const [px, py] = lngLatToPixel(marker.lngLat[0], marker.lngLat[1], camera.zoom);
          currentClusters.push({
            center: marker.lngLat,
            count: 1,
            memberIds: [id],
            screenX: px,
            screenY: py,
          });
        }
        clustersDirty = false;
      }
    },

    /**
     * 将标记/聚合圈绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        const clusterCount = currentClusters.filter((c) => c.count > 1).length;
        const singleCount = currentClusters.filter((c) => c.count === 1).length;
        if (markerMap.size > 0) {
          console.debug(
            `[MarkerLayer:${cfg.id}] encode stub: ${markerMap.size} markers, ` +
              `${clusterCount} clusters + ${singleCount} singles, ` +
              `cluster=${cfg.cluster}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——标记支持点击拾取。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要将标记 ID 编码为拾取颜色
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
    },

    /**
     * 设置 layout 属性。
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
     * 读取 paint 属性。
     *
     * @param name - 属性名
     * @returns 值或 undefined
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性。
     *
     * @param name - 属性名
     * @returns 值或 undefined
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 设置数据——接受标记数组或 GeoJSON FeatureCollection。
     *
     * @param data - 标记数据
     */
    setData(data: unknown): void {
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      // 格式 1：标记数组
      if (Array.isArray(data)) {
        markerMap.clear();
        for (const item of data) {
          if (item !== null && typeof item === 'object' && 'id' in item && 'lngLat' in item) {
            const spec = item as MarkerSpec;
            try {
              validateMarkerSpec(spec);
              markerMap.set(spec.id, spec);
            } catch {
              // 跳过不合法的标记
            }
          }
        }
        clustersDirty = true;
        return;
      }

      // 格式 2：GeoJSON FeatureCollection
      const record = data as Record<string, unknown>;
      if (record['type'] === 'FeatureCollection' && Array.isArray(record['features'])) {
        markerMap.clear();
        const features = record['features'] as Array<Record<string, unknown>>;
        for (let i = 0; i < features.length; i++) {
          const feat = features[i];
          if (feat === null || typeof feat !== 'object') continue;

          const geom = feat['geometry'] as Record<string, unknown> | null | undefined;
          if (geom === null || geom === undefined || geom['type'] !== 'Point') continue;

          const coords = geom['coordinates'] as number[] | null | undefined;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;

          const props = (feat['properties'] ?? {}) as Record<string, unknown>;
          const id = typeof feat['id'] === 'string' ? feat['id'] :
                     typeof feat['id'] === 'number' ? String(feat['id']) :
                     typeof props['id'] === 'string' ? props['id'] : `feature-${i}`;

          const spec: MarkerSpec = {
            id,
            lngLat: [coords[0], coords[1]] as const,
            label: typeof props['label'] === 'string' ? props['label'] : undefined,
            icon: typeof props['icon'] === 'string' ? props['icon'] : undefined,
            data: props,
          };

          markerMap.set(spec.id, spec);
        }
        clustersDirty = true;
      }
    },

    /**
     * 读取当前标记数据。
     *
     * @returns 标记数组
     */
    getData(): unknown {
      return Array.from(markerMap.values());
    },

    // ==================== 要素查询方法 ====================

    /**
     * 包围盒要素查询——返回范围内的标记转换为 Feature。
     *
     * @param bbox - 查询范围
     * @param _filter - 可选过滤器（MVP 暂不支持）
     * @returns Feature 数组
     */
    queryFeatures(bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      const results: Feature[] = [];

      for (const marker of markerMap.values()) {
        const [lng, lat] = marker.lngLat;

        // 检查标记是否在包围盒内
        if (lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north) {
          results.push({
            type: 'Feature' as const,
            id: marker.id,
            geometry: {
              type: 'Point' as const,
              coordinates: [lng, lat],
            },
            properties: {
              id: marker.id,
              label: marker.label,
              icon: marker.icon,
              data: marker.data,
            },
          } as Feature);
        }
      }

      return results;
    },

    /**
     * 屏幕点选查询——MVP 阶段返回空数组。
     *
     * @param _point - 屏幕坐标
     * @returns Feature 数组
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

    // ==================== 标记管理方法 ====================

    /**
     * 添加单个标记。
     *
     * @param spec - 标记描述
     */
    addMarker(spec: MarkerSpec): void {
      validateMarkerSpec(spec);

      if (markerMap.has(spec.id)) {
        throw new Error(
          `[${MARKER_ERROR_CODES.DUPLICATE_MARKER}] marker id already exists: '${spec.id}'`,
        );
      }

      markerMap.set(spec.id, spec);
      clustersDirty = true;
    },

    /**
     * 批量添加标记。
     *
     * @param specs - 标记描述数组
     */
    addMarkers(specs: ReadonlyArray<MarkerSpec>): void {
      // 先校验所有标记（全部通过才添加，保证原子性）
      for (const spec of specs) {
        validateMarkerSpec(spec);
        if (markerMap.has(spec.id)) {
          throw new Error(
            `[${MARKER_ERROR_CODES.DUPLICATE_MARKER}] marker id already exists: '${spec.id}'`,
          );
        }
      }

      // 全部校验通过后批量添加
      for (const spec of specs) {
        markerMap.set(spec.id, spec);
      }
      clustersDirty = true;
    },

    /**
     * 移除标记。
     *
     * @param markerId - 标记 ID
     */
    removeMarker(markerId: string): void {
      if (!markerMap.has(markerId)) {
        throw new Error(
          `[${MARKER_ERROR_CODES.MARKER_NOT_FOUND}] marker not found: '${markerId}'`,
        );
      }
      markerMap.delete(markerId);
      clustersDirty = true;
    },

    /**
     * 移动标记到新位置。
     *
     * @param markerId - 标记 ID
     * @param lngLat - 新坐标
     */
    setMarkerPosition(markerId: string, lngLat: [number, number]): void {
      const existing = markerMap.get(markerId);
      if (existing === undefined) {
        throw new Error(
          `[${MARKER_ERROR_CODES.MARKER_NOT_FOUND}] marker not found: '${markerId}'`,
        );
      }

      // 校验新坐标
      if (
        !Array.isArray(lngLat) ||
        lngLat.length < 2 ||
        !Number.isFinite(lngLat[0]) ||
        !Number.isFinite(lngLat[1])
      ) {
        throw new Error(
          `[${MARKER_ERROR_CODES.INVALID_MARKER_SPEC}] lngLat must be [lng, lat] with finite numbers`,
        );
      }

      // 创建新的 MarkerSpec（不可变更新）
      const updated: MarkerSpec = {
        ...existing,
        lngLat: [lngLat[0], lngLat[1]] as const,
      };
      markerMap.set(markerId, updated);
      clustersDirty = true;
    },

    /**
     * 更新标记属性。
     *
     * @param markerId - 标记 ID
     * @param updates - 部分更新
     */
    updateMarker(markerId: string, updates: Partial<Omit<MarkerSpec, 'id' | 'lngLat'>>): void {
      const existing = markerMap.get(markerId);
      if (existing === undefined) {
        throw new Error(
          `[${MARKER_ERROR_CODES.MARKER_NOT_FOUND}] marker not found: '${markerId}'`,
        );
      }

      // 合并更新（保留原 id 和 lngLat）
      const updated: MarkerSpec = {
        ...existing,
        ...updates,
        id: existing.id,
        lngLat: existing.lngLat,
      };

      markerMap.set(markerId, updated);
      // 属性更新不影响聚合空间分布，仅在视觉属性变化时无需重聚合
    },

    /**
     * 获取所有标记列表（副本）。
     *
     * @returns 标记数组
     */
    getMarkers(): MarkerSpec[] {
      return Array.from(markerMap.values());
    },

    /**
     * 获取指定标记。
     *
     * @param markerId - 标记 ID
     * @returns 标记或 undefined
     */
    getMarker(markerId: string): MarkerSpec | undefined {
      return markerMap.get(markerId);
    },

    /**
     * 清空所有标记。
     */
    clearMarkers(): void {
      markerMap.clear();
      currentClusters = [];
      clustersDirty = true;
    },

    /**
     * 获取标记总数。
     *
     * @returns 标记数量
     */
    markerCount(): number {
      return markerMap.size;
    },

    // ==================== 事件订阅方法 ====================

    /**
     * 订阅标记点击事件。
     *
     * @param callback - 回调
     * @returns 取消订阅函数
     */
    onMarkerClick(callback: MarkerClickCallback): () => void {
      clickCallbacks.push(callback);
      return removeCallback(clickCallbacks, callback);
    },

    /**
     * 订阅标记拖拽结束事件。
     *
     * @param callback - 回调
     * @returns 取消订阅函数
     */
    onMarkerDragEnd(callback: MarkerDragEndCallback): () => void {
      dragEndCallbacks.push(callback);
      return removeCallback(dragEndCallbacks, callback);
    },

    /**
     * 订阅标记鼠标进入事件。
     *
     * @param callback - 回调
     * @returns 取消订阅函数
     */
    onMarkerEnter(callback: MarkerEnterCallback): () => void {
      enterCallbacks.push(callback);
      return removeCallback(enterCallbacks, callback);
    },

    /**
     * 订阅标记鼠标离开事件。
     *
     * @param callback - 回调
     * @returns 取消订阅函数
     */
    onMarkerLeave(callback: MarkerLeaveCallback): () => void {
      leaveCallbacks.push(callback);
      return removeCallback(leaveCallbacks, callback);
    },
  };

  return layer;
}
