// ============================================================
// GeoJSONLayer.ts — GeoJSON 数据图层（L4 图层包）
// 职责：管理内嵌/远程 GeoJSON 数据的生命周期（加载→解析→聚合→渲染），
//       支持运行时 setData 动态更新、Supercluster 风格聚合查询、
//       空间查询 queryFeatures / queryRenderedFeatures。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FeatureCollection } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Geometry, PointGeometry } from '../../core/src/types/geometry.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

/**
 * GeoJSONLayer 模块错误码，前缀 `GEOJSON_` 以避免跨模块碰撞。
 */
const GEOJSON_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'GEOJSON_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'GEOJSON_INVALID_OPACITY',
  /** setData 接收到非法数据格式 */
  INVALID_DATA: 'GEOJSON_INVALID_DATA',
  /** setDataIncremental 接收到非法或非 FeatureCollection 数据 */
  INCREMENTAL_INVALID: 'GEOJSON_INCREMENTAL_INVALID',
  /** 聚合参数非法 */
  INVALID_CLUSTER_PARAM: 'GEOJSON_INVALID_CLUSTER_PARAM',
  /** 聚合 ID 不存在 */
  CLUSTER_NOT_FOUND: 'GEOJSON_CLUSTER_NOT_FOUND',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 不透明度下限 */
const OPACITY_MIN = 0;

/** 不透明度上限 */
const OPACITY_MAX = 1;

/** 默认聚合半径（像素） */
const DEFAULT_CLUSTER_RADIUS = 50;

/** 默认聚合最大缩放级别（超过此级别不聚合） */
const DEFAULT_CLUSTER_MAX_ZOOM = 14;

/** 默认简化容差（Douglas-Peucker 算法，像素单位） */
const DEFAULT_TOLERANCE = 0.375;

/** 默认瓦片缓冲区（像素，防止边缘裁切） */
const DEFAULT_BUFFER = 128;

/** 聚合要素属性中的点计数键名 */
const CLUSTER_POINT_COUNT_KEY = 'point_count';

/** 聚合要素属性中的缩写点计数键名 */
const CLUSTER_POINT_COUNT_ABBREVIATED_KEY = 'point_count_abbreviated';

/** 聚合要素属性中的聚合标记键名 */
const CLUSTER_FLAG_KEY = 'cluster';

/** 聚合要素属性中的聚合 ID 键名 */
const CLUSTER_ID_KEY = 'cluster_id';

// ---------------------------------------------------------------------------
// GeoJSONLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * GeoJSON 图层构造选项。
 * 由用户传入 `createGeoJSONLayer`，驱动图层初始化。
 *
 * @example
 * const opts: GeoJSONLayerOptions = {
 *   id: 'earthquakes',
 *   data: 'https://example.com/earthquakes.geojson',
 *   renderType: 'circle',
 *   cluster: true,
 *   clusterRadius: 60,
 *   clusterMaxZoom: 15,
 *   paint: { 'circle-radius': 8, 'circle-color': '#f00' },
 * };
 */
export interface GeoJSONLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * GeoJSON 数据来源。
   * - `string`: GeoJSON 文件 URL，引擎自动 fetch 并解析
   * - `object`: 内嵌 GeoJSON 对象（FeatureCollection 或单个 Feature）
   * 必填。
   */
  readonly data: string | object;

  /**
   * 渲染类型（决定使用哪套着色器管线）。
   * 支持值：'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion'。
   * 必填。
   */
  readonly renderType: 'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion';

  /**
   * 是否启用点聚合（Supercluster 风格）。
   * 仅对 Point 几何有效。
   * 可选，默认 false。
   */
  readonly cluster?: boolean;

  /**
   * 聚合半径（像素）。
   * 在同一缩放级别下，半径内的点被合并为一个聚合点。
   * 仅在 `cluster: true` 时有效。
   * 可选，默认 50。
   */
  readonly clusterRadius?: number;

  /**
   * 聚合的最大缩放级别。
   * 超过此级别后不再聚合，显示原始点。
   * 仅在 `cluster: true` 时有效。
   * 可选，默认 14。
   */
  readonly clusterMaxZoom?: number;

  /**
   * 聚合属性表达式。
   * 键为输出属性名，值为 MapReduce 表达式元组 [operator, mapExpr]。
   * 例如 `{ sum_mag: ['+', ['get', 'mag']] }` 表示对聚合内所有点的 mag 属性求和。
   * 仅在 `cluster: true` 时有效。
   * 可选。
   */
  readonly clusterProperties?: Record<string, [string, unknown]>;

  /**
   * 要素过滤表达式。
   * 仅渲染满足此表达式的要素。
   * 可选。
   */
  readonly filter?: FilterExpression;

  /**
   * paint 属性表（v8 样式规范）。
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * layout 属性表（v8 样式规范）。
   * 可选。
   */
  readonly layout?: Record<string, unknown>;

  /**
   * 几何简化容差（Douglas-Peucker 算法，像素单位）。
   * 值越大简化程度越高，性能越好但精度越低。
   * 可选，默认 0.375。
   */
  readonly tolerance?: number;

  /**
   * 瓦片缓冲区像素数。
   * 扩展瓦片边界，避免边缘要素被裁切。
   * 可选，默认 128。
   */
  readonly buffer?: number;

  /**
   * setData 更新时是否保留旧数据直到新数据就绪。
   * true = 新数据加载完成前继续显示旧数据（防止闪烁）。
   * false = 立即清除旧数据。
   * 可选，默认 false。
   */
  readonly keepStaleOnUpdate?: boolean;

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
   * 图层初始不透明度。
   * 范围 [0, 1]。
   * 可选，默认 1。
   */
  readonly opacity?: number;

  /**
   * 投影标识。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;
}

// ---------------------------------------------------------------------------
// 内部：聚合节点结构
// ---------------------------------------------------------------------------

/**
 * 聚合节点——代表一组被聚合的点要素。
 * 聚合逻辑在 CPU 端以简化网格（grid-based）方式执行。
 *
 * @internal 仅模块内使用。
 */
interface ClusterNode {
  /** 聚合 ID（自增整数） */
  id: number;

  /** 聚合中心坐标 [longitude, latitude] */
  center: [number, number];

  /** 聚合包含的原始点要素索引列表 */
  childIndices: number[];

  /** 聚合属性（如 point_count, 用户自定义的 reduce 属性） */
  properties: Record<string, unknown>;

  /** 聚合在哪个缩放级别展开（expansion zoom） */
  expansionZoom: number;
}

// ---------------------------------------------------------------------------
// 增量更新统计
// ---------------------------------------------------------------------------

/**
 * `setDataIncremental` 最近一次执行的要素差异统计。
 * 用于调试与性能观测（避免全量重建时的重复工作）。
 */
export interface GeoJSONIncrementalDiffStats {
  /** 相对上一快照新出现的要素 id 数量 */
  readonly added: number;
  /** 上一快照存在但本次数据中缺失的要素 id 数量 */
  readonly removed: number;
  /** id 仍存在但 geometry 或 properties 发生变化的要素数量 */
  readonly modified: number;
  /** 内容完全相同的要素数量 */
  readonly unchanged: number;
}

// ---------------------------------------------------------------------------
// GeoJSONLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * GeoJSON 图层接口——在 Layer 基础上扩展数据更新、聚合查询和要素查询。
 * 实例由 `createGeoJSONLayer` 工厂创建。
 *
 * @example
 * const layer = createGeoJSONLayer({
 *   id: 'points',
 *   data: { type: 'FeatureCollection', features: [] },
 *   renderType: 'circle',
 *   cluster: true,
 * });
 * layer.setData(newFeatureCollection);
 * const expansion = layer.getClusterExpansionZoom(42);
 */
export interface GeoJSONLayer extends Layer {
  /** 图层渲染子类型 */
  readonly type: string;

  /** 当前可见（经缩放/过滤后）的要素总数 */
  readonly visibleFeatureCount: number;

  /** 数据集中的要素总数（含聚合前的原始要素） */
  readonly totalFeatureCount: number;

  /**
   * 替换图层数据。
   * 接受 GeoJSON FeatureCollection、单个 Feature、Geometry 对象或 URL 字符串。
   * 触发完整的数据处理流程（解析→聚合→GPU 缓冲区重建）。
   *
   * @param data - GeoJSON 数据对象或 URL
   *
   * @example
   * layer.setData({
   *   type: 'FeatureCollection',
   *   features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
   * });
   */
  setData(data: string | object): void;

  /**
   * 基于要素 id（或 `properties.id` 或数组下标）对现有数据做差分更新，
   * 仅对新增 / 删除 / 修改的要素触发重新索引与（在必要时）重新聚合。
   *
   * @param newData - GeoJSON FeatureCollection
   * @returns 本次差分统计
   * @throws 若 `newData` 不是合法的 FeatureCollection
   *
   * @stability experimental
   */
  setDataIncremental(newData: FeatureCollection): GeoJSONIncrementalDiffStats;

  /**
   * 最近一次 `setDataIncremental` 的差分统计；若尚未调用过增量更新则为 `null`。
   */
  readonly lastIncrementalDiffStats: GeoJSONIncrementalDiffStats | null;

  /**
   * 读取当前数据（FeatureCollection 格式）。
   *
   * @returns 当前数据的 FeatureCollection 快照
   */
  getData(): FeatureCollection;

  /**
   * 获取聚合点的展开缩放级别。
   * 返回使得该聚合点拆分为子聚合或单点的最小缩放级别。
   *
   * @param clusterId - 聚合 ID
   * @returns 展开缩放级别
   * @throws 若 clusterId 不存在
   *
   * @example
   * const zoom = layer.getClusterExpansionZoom(42);
   * map.flyTo({ zoom }); // 飞到展开级别
   */
  getClusterExpansionZoom(clusterId: number): number;

  /**
   * 获取聚合点的直接子节点（子聚合 + 单点）。
   *
   * @param clusterId - 聚合 ID
   * @returns 子要素数组（聚合点或原始点）
   * @throws 若 clusterId 不存在
   *
   * @example
   * const children = layer.getClusterChildren(42);
   */
  getClusterChildren(clusterId: number): Feature[];

  /**
   * 获取聚合点包含的所有叶子要素（完全展开）。
   *
   * @param clusterId - 聚合 ID
   * @param limit - 最大返回数量，默认 10
   * @param offset - 跳过的要素数，默认 0
   * @returns 叶子要素数组（分页）
   * @throws 若 clusterId 不存在
   *
   * @example
   * const leaves = layer.getClusterLeaves(42, 20, 0);
   */
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): Feature[];

  /**
   * 按包围盒查询要素。
   *
   * @param bbox - 查询包围盒
   * @param filter - 可选过滤表达式
   * @returns 匹配要素数组
   */
  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];

  /**
   * 按屏幕坐标查询渲染要素。
   * MVP 阶段返回空数组（完整实现需 GPU readback）。
   *
   * @param point - 屏幕像素坐标 [x, y]
   * @returns 命中要素数组
   */
  queryRenderedFeatures(point: [number, number]): Feature[];
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 支持的渲染类型集合。
 */
const SUPPORTED_RENDER_TYPES = new Set([
  'fill', 'line', 'circle', 'symbol', 'fill-extrusion',
]);

/**
 * 校验并规范化 GeoJSONLayerOptions。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的配置对象
 * @throws Error 若任何校验失败
 *
 * @example
 * const cfg = validateOptions({ id: 'pts', data: '...', renderType: 'circle' });
 */
function validateOptions(opts: GeoJSONLayerOptions): {
  id: string;
  data: string | object;
  renderType: string;
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
  clusterProperties: Record<string, [string, unknown]> | undefined;
  filter: FilterExpression | undefined;
  paint: Record<string, unknown> | undefined;
  layout: Record<string, unknown> | undefined;
  tolerance: number;
  buffer: number;
  keepStaleOnUpdate: boolean;
  minzoom: number;
  maxzoom: number;
  opacity: number;
  projection: string;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] GeoJSONLayerOptions.id must be a non-empty string`,
    );
  }

  // data 必须为字符串或非 null 对象
  if (opts.data === null || opts.data === undefined) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] GeoJSONLayerOptions.data must be a string URL or GeoJSON object`,
    );
  }
  if (typeof opts.data !== 'string' && typeof opts.data !== 'object') {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] GeoJSONLayerOptions.data must be a string URL or GeoJSON object`,
    );
  }

  // renderType 必须为支持的类型
  if (!SUPPORTED_RENDER_TYPES.has(opts.renderType)) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] renderType must be one of ` +
        `${Array.from(SUPPORTED_RENDER_TYPES).join(', ')}, got '${opts.renderType}'`,
    );
  }

  // cluster 相关参数
  const cluster = opts.cluster === true;
  const clusterRadius = opts.clusterRadius ?? DEFAULT_CLUSTER_RADIUS;
  if (cluster && (!Number.isFinite(clusterRadius) || clusterRadius <= 0)) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_CLUSTER_PARAM}] clusterRadius must be a positive number, got ${clusterRadius}`,
    );
  }
  const clusterMaxZoom = opts.clusterMaxZoom ?? DEFAULT_CLUSTER_MAX_ZOOM;
  if (cluster && (!Number.isFinite(clusterMaxZoom) || clusterMaxZoom < 0)) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_CLUSTER_PARAM}] clusterMaxZoom must be >= 0, got ${clusterMaxZoom}`,
    );
  }

  // minzoom / maxzoom
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // opacity
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${GEOJSON_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  // tolerance / buffer
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const buffer = opts.buffer ?? DEFAULT_BUFFER;

  // projection
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  return {
    id: opts.id.trim(),
    data: opts.data,
    renderType: opts.renderType,
    cluster,
    clusterRadius,
    clusterMaxZoom,
    clusterProperties: opts.clusterProperties,
    filter: opts.filter,
    paint: opts.paint,
    layout: opts.layout,
    tolerance,
    buffer,
    keepStaleOnUpdate: opts.keepStaleOnUpdate === true,
    minzoom,
    maxzoom,
    opacity,
    projection,
  };
}

// ---------------------------------------------------------------------------
// GeoJSON 解析辅助
// ---------------------------------------------------------------------------

/**
 * 将任意 GeoJSON 输入（FeatureCollection / Feature / Geometry）
 * 统一规范化为 Feature 数组。
 *
 * @param data - 原始 GeoJSON 对象
 * @returns 要素数组
 *
 * @example
 * const features = normalizeToFeatures({ type: 'Point', coordinates: [0, 0] });
 * // → [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }]
 */
function normalizeToFeatures(data: object): Feature[] {
  // 类型安全的字段访问
  const record = data as Record<string, unknown>;
  const type = record['type'] as string | undefined;

  // 情况 1：FeatureCollection
  if (type === 'FeatureCollection') {
    const rawFeatures = record['features'];
    if (Array.isArray(rawFeatures)) {
      return rawFeatures.map((f, idx) => normalizeFeature(f, idx));
    }
    return [];
  }

  // 情况 2：单个 Feature
  if (type === 'Feature') {
    return [normalizeFeature(data, 0)];
  }

  // 情况 3：裸 Geometry 对象（包装为 Feature）
  if (
    type === 'Point' || type === 'MultiPoint' ||
    type === 'LineString' || type === 'MultiLineString' ||
    type === 'Polygon' || type === 'MultiPolygon' ||
    type === 'GeometryCollection'
  ) {
    return [{
      type: 'Feature' as const,
      geometry: data as Geometry,
      properties: {},
    }];
  }

  // 未知格式，返回空数组
  return [];
}

/**
 * 将单个原始对象规范化为合法 Feature。
 * 确保 type/geometry/properties 字段始终存在。
 *
 * @param raw - 原始对象
 * @param index - 在数组中的索引（用于生成备选 ID）
 * @returns 规范化后的 Feature
 *
 * @example
 * const f = normalizeFeature({ type: 'Feature', geometry: null, properties: null }, 0);
 * // f.properties === {}
 */
function normalizeFeature(raw: unknown, index: number): Feature {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    // 非法输入，构造空要素
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point', coordinates: [0, 0] } as PointGeometry,
      properties: {},
    };
  }

  const record = raw as Record<string, unknown>;

  // 提取并校验 id
  const id = record['id'] !== undefined && record['id'] !== null
    ? record['id'] as string | number
    : undefined;

  // 提取 geometry，缺省为空点
  const geometry = (record['geometry'] !== undefined && record['geometry'] !== null)
    ? record['geometry'] as Geometry
    : { type: 'Point', coordinates: [0, 0] } as PointGeometry;

  // 提取 properties，缺省为空对象
  const properties = (record['properties'] !== undefined && record['properties'] !== null && typeof record['properties'] === 'object')
    ? record['properties'] as Record<string, unknown>
    : {};

  // 提取引擎内部字段
  const _sourceId = typeof record['_sourceId'] === 'string' ? record['_sourceId'] : undefined;
  const _layerId = typeof record['_layerId'] === 'string' ? record['_layerId'] : undefined;
  const _tileCoord = (record['_tileCoord'] !== undefined && record['_tileCoord'] !== null && typeof record['_tileCoord'] === 'object')
    ? record['_tileCoord'] as TileCoord
    : undefined;

  const feature: Feature = {
    type: 'Feature' as const,
    id,
    geometry,
    properties,
    _sourceId,
    _layerId,
    _tileCoord,
  };

  return feature;
}

/**
 * 为要素生成稳定键：优先 `feature.id`，其次 `properties.id`，否则使用数组下标占位。
 * 下标占位仅在无显式 id 时有效，重排无 id 要素会被视为删除+新增。
 *
 * @param feature - 要素
 * @param index - 在当前数组中的下标
 * @returns 稳定字符串键
 */
function stableFeatureId(feature: Feature, index: number): string {
  if (feature.id !== undefined && feature.id !== null) {
    return String(feature.id);
  }
  const props = feature.properties as Record<string, unknown> | undefined;
  if (props !== undefined && props !== null && props['id'] !== undefined && props['id'] !== null) {
    return String(props['id']);
  }
  return `__index_${index}`;
}

/**
 * 比较两要素的 geometry 与 properties 是否一致（JSON 序列化比较）。
 *
 * @param a - 要素 a
 * @param b - 要素 b
 * @returns 内容是否相同
 */
function featureContentEquals(a: Feature, b: Feature): boolean {
  try {
    return (
      JSON.stringify(a.geometry) === JSON.stringify(b.geometry) &&
      JSON.stringify(a.properties) === JSON.stringify(b.properties)
    );
  } catch {
    return false;
  }
}

/**
 * 判断几何是否为点（参与网格聚合）。
 *
 * @param geometry - 几何对象
 * @returns 是否为 Point
 */
function isPointGeometry(geometry: Geometry | null | undefined): boolean {
  return geometry !== null && geometry !== undefined && geometry.type === 'Point';
}

/**
 * 在启用聚合时，判断是否需要重新执行 `buildClusters`。
 * 任意增删或点几何变化时需要重建；仅非点几何或点属性变化时可能跳过。
 *
 * @param clusterEnabled - 是否开启聚合
 * @param added - 新增数量
 * @param removed - 删除数量
 * @param modified - 修改数量
 * @param oldById - 旧 id → 要素
 * @param newFeatures - 规范化后的新要素列表（顺序与 newData 一致）
 * @returns 是否应全量重建聚合索引
 */
function shouldRebuildPointClusters(
  clusterEnabled: boolean,
  added: number,
  removed: number,
  modified: number,
  oldById: Map<string, Feature>,
  newFeatures: Feature[],
): boolean {
  if (!clusterEnabled) {
    return false;
  }
  if (added > 0 || removed > 0) {
    return true;
  }
  if (modified === 0) {
    return false;
  }
  // 任意「点要素」内容变化（坐标或属性）都可能改变聚合 reduce 结果或网格归属
  for (let i = 0; i < newFeatures.length; i++) {
    const nf = newFeatures[i];
    const id = stableFeatureId(nf, i);
    const oldF = oldById.get(id);
    if (oldF === undefined) {
      continue;
    }
    if (featureContentEquals(oldF, nf)) {
      continue;
    }
    if (isPointGeometry(oldF.geometry) || isPointGeometry(nf.geometry)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 简化聚合实现（grid-based clustering）
// ---------------------------------------------------------------------------

/**
 * 对点要素执行简化的网格聚合。
 * 使用经纬度网格（cell 大小由 radius 和 zoom 决定）将临近点归组。
 * 这是 Supercluster 的简化版——生产环境应使用 Worker 中的完整 Supercluster 实现。
 *
 * @param features - 原始要素数组
 * @param radius - 聚合半径（像素）
 * @param maxZoom - 最大聚合缩放级别
 * @param clusterProperties - 自定义聚合属性
 * @returns 聚合节点映射表（clusterId → ClusterNode）
 *
 * @example
 * const clusters = buildClusters(features, 50, 14, undefined);
 */
function buildClusters(
  features: Feature[],
  radius: number,
  maxZoom: number,
  clusterProperties: Record<string, [string, unknown]> | undefined,
): Map<number, ClusterNode> {
  const clusters = new Map<number, ClusterNode>();
  let nextClusterId = 0;

  // 仅对 Point 几何做聚合
  const pointIndices: number[] = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (f.geometry !== null && f.geometry !== undefined && f.geometry.type === 'Point') {
      pointIndices.push(i);
    }
  }

  // 如果没有点要素，直接返回空
  if (pointIndices.length === 0) {
    return clusters;
  }

  // 网格聚合：将经纬度空间分割为 cellSize × cellSize 的网格
  // cellSize 基于 radius 近似计算（在 zoom=0 时 1 像素 ≈ 360/256 度）
  const cellSizeDeg = (radius / 256) * 360;

  // 校验 cellSize 有效性，避免零除
  if (cellSizeDeg <= 0 || !Number.isFinite(cellSizeDeg)) {
    return clusters;
  }

  // 网格索引：cellKey → [featureIndex, ...]
  const grid = new Map<string, number[]>();

  for (const idx of pointIndices) {
    const geom = features[idx].geometry as PointGeometry;
    const lng = geom.coordinates[0];
    const lat = geom.coordinates[1];

    // 跳过非法坐标
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }

    // 计算网格单元键
    const cellX = Math.floor(lng / cellSizeDeg);
    const cellY = Math.floor(lat / cellSizeDeg);
    const cellKey = `${cellX}:${cellY}`;

    // 将要素索引加入对应网格单元
    let cell = grid.get(cellKey);
    if (cell === undefined) {
      cell = [];
      grid.set(cellKey, cell);
    }
    cell.push(idx);
  }

  // 将每个包含 ≥2 个点的网格单元创建为聚合节点
  for (const [_cellKey, indices] of grid) {
    if (indices.length < 2) {
      // 单点不聚合
      continue;
    }

    // 计算聚合中心（所有子点坐标的简单算术平均）
    let sumLng = 0;
    let sumLat = 0;
    for (const idx of indices) {
      const geom = features[idx].geometry as PointGeometry;
      sumLng += geom.coordinates[0];
      sumLat += geom.coordinates[1];
    }
    const centerLng = sumLng / indices.length;
    const centerLat = sumLat / indices.length;

    // 构建聚合属性
    const props: Record<string, unknown> = {
      [CLUSTER_FLAG_KEY]: true,
      [CLUSTER_ID_KEY]: nextClusterId,
      [CLUSTER_POINT_COUNT_KEY]: indices.length,
      [CLUSTER_POINT_COUNT_ABBREVIATED_KEY]: abbreviateCount(indices.length),
    };

    // 如果有自定义聚合属性，执行简化的 reduce 聚合
    if (clusterProperties !== undefined) {
      for (const [propName, [operator]] of Object.entries(clusterProperties)) {
        // MVP：仅支持 '+' 求和运算符
        if (operator === '+') {
          let sum = 0;
          for (const idx of indices) {
            const val = (features[idx].properties as Record<string, unknown>)[propName];
            if (typeof val === 'number' && Number.isFinite(val)) {
              sum += val;
            }
          }
          props[propName] = sum;
        }
        // 其他运算符（max, min, concat 等）可在后续扩展
      }
    }

    // 计算展开缩放级别（使聚合拆分的最小 zoom）
    // 简化策略：expansionZoom = 当前聚合的 zoom + 1（即比最大聚合 zoom 大 1）
    const expansionZoom = Math.min(maxZoom + 1, DEFAULT_MAX_ZOOM);

    clusters.set(nextClusterId, {
      id: nextClusterId,
      center: [centerLng, centerLat],
      childIndices: [...indices],
      properties: props,
      expansionZoom,
    });

    nextClusterId += 1;
  }

  return clusters;
}

/**
 * 将数字缩写为人类可读的短格式。
 *
 * @param count - 原始计数
 * @returns 缩写字符串（如 "1.2k", "3.4M"）
 *
 * @example
 * abbreviateCount(1234); // '1.2k'
 * abbreviateCount(42);   // '42'
 */
function abbreviateCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// 几何包围盒辅助
// ---------------------------------------------------------------------------

/**
 * 从 Feature 的 geometry 中计算 2D 包围盒。
 *
 * @param feature - 要素
 * @returns 包围盒或 null
 *
 * @example
 * const bbox = featureBBox(myFeature);
 */
function featureBBox(feature: Feature): BBox2D | null {
  const geom = feature.geometry;
  if (geom === null || geom === undefined) {
    return null;
  }

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let hasCoords = false;

  /**
   * 从坐标数组中更新包围盒边界。
   *
   * @param coords - Position 坐标 [lng, lat, ...]
   */
  function updateFromPosition(coords: unknown): void {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const lng = coords[0] as number;
    const lat = coords[1] as number;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    hasCoords = true;
  }

  /**
   * 递归遍历坐标数组更新包围盒。
   *
   * @param coords - 任意深度的坐标数组
   * @param depth - 嵌套深度
   */
  function walkCoords(coords: unknown[], depth: number): void {
    if (depth === 0) {
      updateFromPosition(coords);
      return;
    }
    for (const child of coords) {
      if (Array.isArray(child)) {
        walkCoords(child, depth - 1);
      }
    }
  }

  switch (geom.type) {
    case 'Point':
      updateFromPosition(geom.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      walkCoords(geom.coordinates as unknown[], 0);
      break;
    case 'MultiLineString':
    case 'Polygon':
      walkCoords(geom.coordinates as unknown[], 1);
      break;
    case 'MultiPolygon':
      walkCoords(geom.coordinates as unknown[], 2);
      break;
    case 'GeometryCollection':
      for (const subGeom of geom.geometries) {
        const subBBox = featureBBox({
          type: 'Feature',
          geometry: subGeom,
          properties: {},
        });
        if (subBBox !== null) {
          if (subBBox.west < west) west = subBBox.west;
          if (subBBox.east > east) east = subBBox.east;
          if (subBBox.south < south) south = subBBox.south;
          if (subBBox.north > north) north = subBBox.north;
          hasCoords = true;
        }
      }
      break;
    default:
      return null;
  }

  if (!hasCoords) return null;
  return { west, south, east, north };
}

/**
 * 判断两个 2D 包围盒是否相交。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @returns true 若相交
 *
 * @example
 * bboxIntersects(bboxA, bboxB); // true / false
 */
function bboxIntersects(a: BBox2D, b: BBox2D): boolean {
  if (a.east < b.west || b.east < a.west) return false;
  if (a.north < b.south || b.north < a.south) return false;
  return true;
}

// ---------------------------------------------------------------------------
// createGeoJSONLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建 GeoJSON 图层实例。
 * 返回完整的 {@link GeoJSONLayer} 实现，包含数据解析、
 * 聚合逻辑、空间查询和 GPU 编码桩。
 *
 * @param opts - GeoJSON 图层构造选项
 * @returns 完整的 GeoJSONLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const geojsonLayer = createGeoJSONLayer({
 *   id: 'earthquakes',
 *   data: 'https://example.com/earthquakes.geojson',
 *   renderType: 'circle',
 *   cluster: true,
 *   clusterRadius: 60,
 *   paint: { 'circle-radius': 6, 'circle-color': '#f00' },
 * });
 * sceneGraph.addLayer(geojsonLayer);
 */
export function createGeoJSONLayer(opts: GeoJSONLayerOptions): GeoJSONLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);

  // ── 2. 内部状态 ──

  // 原始要素列表（解析后的 Feature 数组）
  let rawFeatures: Feature[] = [];

  // 聚合节点映射（clusterId → ClusterNode），仅在 cluster=true 时填充
  let clusterMap = new Map<number, ClusterNode>();

  // 当前数据源引用（FeatureCollection 或 URL 字符串）
  let currentDataRef: string | object = cfg.data;

  // paint / layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化 paint 属性
  if (cfg.paint) {
    for (const k of Object.keys(cfg.paint)) {
      paintProps.set(k, cfg.paint[k]);
    }
  }

  // 初始化 layout 属性
  if (cfg.layout) {
    for (const k of Object.keys(cfg.layout)) {
      layoutProps.set(k, cfg.layout[k]);
    }
  }

  // 图层挂载状态
  let mounted = false;
  let layerContext: LayerContext | null = null;
  let dataReady = false;

  // 当前帧可见要素计数
  let currentVisibleCount = 0;

  /** 最近一次 `setDataIncremental` 的统计；未执行过时为 `null`。 */
  let lastIncrementalDiffStats: GeoJSONIncrementalDiffStats | null = null;

  // ── 3. 数据处理入口 ──

  /**
   * 处理 GeoJSON 数据（同步）——解析 → 聚合。
   * 异步 URL 加载在 MVP 中不实现（需要 RequestScheduler）。
   *
   * @param data - GeoJSON 对象或 URL 字符串
   */
  function processData(data: string | object): void {
    // 如果是 URL 字符串，MVP 阶段存储引用但不执行 fetch
    if (typeof data === 'string') {
      // MVP: URL 数据需要通过 RequestScheduler fetch，此处仅记录引用
      // 完整实现：requestScheduler.fetch(url).then(json => processData(json))
      rawFeatures = [];
      clusterMap.clear();
      dataReady = false;
      return;
    }

    // 解析 GeoJSON 对象为 Feature 数组
    rawFeatures = normalizeToFeatures(data);

    // 如果启用了聚合，构建聚合索引
    if (cfg.cluster && rawFeatures.length > 0) {
      clusterMap = buildClusters(
        rawFeatures,
        cfg.clusterRadius,
        cfg.clusterMaxZoom,
        cfg.clusterProperties,
      );
    } else {
      clusterMap.clear();
    }

    // 标记数据就绪
    dataReady = rawFeatures.length > 0;
  }

  /**
   * 差分更新 FeatureCollection：按稳定 id 比较，仅必要时重建聚合索引。
   *
   * @param newData - 新的 GeoJSON FeatureCollection
   * @returns 差分统计
   */
  function applySetDataIncremental(newData: FeatureCollection): GeoJSONIncrementalDiffStats {
    if (newData === null || newData === undefined || typeof newData !== 'object') {
      throw new Error(
        `[${GEOJSON_ERROR_CODES.INCREMENTAL_INVALID}] setDataIncremental: newData must be a FeatureCollection object`,
      );
    }
    if (newData.type !== 'FeatureCollection') {
      throw new Error(
        `[${GEOJSON_ERROR_CODES.INCREMENTAL_INVALID}] setDataIncremental: type must be FeatureCollection`,
      );
    }
    const incomingFeatures = newData.features;
    if (!Array.isArray(incomingFeatures)) {
      throw new Error(
        `[${GEOJSON_ERROR_CODES.INCREMENTAL_INVALID}] setDataIncremental: features must be an array`,
      );
    }

    const newNormalized: Feature[] = [];
    for (let i = 0; i < incomingFeatures.length; i++) {
      newNormalized.push(normalizeFeature(incomingFeatures[i], i));
    }

    const oldById = new Map<string, Feature>();
    for (let i = 0; i < rawFeatures.length; i++) {
      const f = rawFeatures[i];
      const id = stableFeatureId(f, i);
      oldById.set(id, f);
    }

    const newIdSet = new Set<string>();
    for (let i = 0; i < newNormalized.length; i++) {
      newIdSet.add(stableFeatureId(newNormalized[i], i));
    }

    let added = 0;
    let removed = 0;
    let modified = 0;
    let unchanged = 0;

    for (let i = 0; i < newNormalized.length; i++) {
      const nf = newNormalized[i];
      const id = stableFeatureId(nf, i);
      const oldF = oldById.get(id);
      if (oldF === undefined) {
        added += 1;
      } else if (featureContentEquals(oldF, nf)) {
        unchanged += 1;
      } else {
        modified += 1;
      }
    }

    for (const id of oldById.keys()) {
      if (!newIdSet.has(id)) {
        removed += 1;
      }
    }

    rawFeatures = newNormalized;
    dataReady = rawFeatures.length > 0;

    const rebuildClusters = shouldRebuildPointClusters(
      cfg.cluster,
      added,
      removed,
      modified,
      oldById,
      newNormalized,
    );

    if (cfg.cluster && rawFeatures.length > 0) {
      if (rebuildClusters) {
        clusterMap = buildClusters(
          rawFeatures,
          cfg.clusterRadius,
          cfg.clusterMaxZoom,
          cfg.clusterProperties,
        );
      }
    } else {
      clusterMap.clear();
    }

    const stats: GeoJSONIncrementalDiffStats = {
      added,
      removed,
      modified,
      unchanged,
    };
    lastIncrementalDiffStats = stats;

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.debug(
        `[GeoJSONLayer:${cfg.id}] incremental update: +${added} -${removed} ~${modified} =${unchanged}`,
      );
    }

    return stats;
  }

  // ── 4. 处理初始数据 ──
  if (typeof cfg.data === 'object') {
    processData(cfg.data);
  } else {
    // URL 类型，记录引用（后续由 RequestScheduler 加载）
    currentDataRef = cfg.data;
  }

  // ── 5. 构造 Layer 实现对象 ──
  const layer: GeoJSONLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: cfg.renderType,
    source: cfg.id, // GeoJSON 图层的 source 默认与 id 相同（内嵌数据源）
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪。
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 是否包含半透明内容。
     */
    get isTransparent(): boolean {
      if (layer.opacity < OPACITY_MAX) return true;
      const fillOpacity = paintProps.get('fill-opacity');
      if (typeof fillOpacity === 'number' && fillOpacity < OPACITY_MAX) return true;
      const circleOpacity = paintProps.get('circle-opacity');
      if (typeof circleOpacity === 'number' && circleOpacity < OPACITY_MAX) return true;
      return false;
    },

    /**
     * 全局渲染次序。
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前可见要素数。
     */
    get visibleFeatureCount(): number {
      return currentVisibleCount;
    },

    /**
     * 数据集中的总要素数（原始要素，不含聚合生成的虚拟要素）。
     */
    get totalFeatureCount(): number {
      return rawFeatures.length;
    },

    /**
     * 最近一次增量更新的差分统计。
     */
    get lastIncrementalDiffStats(): GeoJSONIncrementalDiffStats | null {
      return lastIncrementalDiffStats;
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
    },

    /**
     * 图层卸载——释放所有数据。
     */
    onRemove(): void {
      rawFeatures = [];
      clusterMap.clear();
      featureStateMap.clear();
      mounted = false;
      layerContext = null;
      dataReady = false;
      currentVisibleCount = 0;
      lastIncrementalDiffStats = null;
    },

    /**
     * 每帧更新——统计可见要素、执行缩放过滤。
     *
     * @param deltaTime - 距上一帧时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      const zoom = camera.zoom;

      // 缩放级别可见性判断
      if (zoom < cfg.minzoom || zoom > cfg.maxzoom) {
        currentVisibleCount = 0;
        return;
      }

      // MVP: 所有已解析要素视为可见
      // 完整实现需要视锥体剔除 + geojson-vt 瓦片切片
      currentVisibleCount = rawFeatures.length;
    },

    /**
     * GPU 编码桩。
     *
     * @param _encoder - RenderPass 编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        if (currentVisibleCount > 0) {
          console.debug(
            `[GeoJSONLayer:${cfg.id}] encode stub: ` +
              `${currentVisibleCount} features, ` +
              `${clusterMap.size} clusters, ` +
              `renderType=${cfg.renderType}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码桩。
     *
     * @param _encoder - RenderPass 编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性。
     *
     * @param name - 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
    },

    /**
     * 设置 layout 属性。
     *
     * @param name - 属性名
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
     * 替换图层数据，触发重解析和重聚合。
     *
     * @param data - GeoJSON 数据对象或 URL 字符串
     */
    setData(data: string | object): void {
      // 输入校验
      if (data === null || data === undefined) {
        throw new Error(
          `[${GEOJSON_ERROR_CODES.INVALID_DATA}] setData: data must be a string URL or GeoJSON object`,
        );
      }

      // 常见优化路径：已是 FeatureCollection 且已有内存数据时走增量更新
      if (
        typeof data === 'object' &&
        !Array.isArray(data) &&
        rawFeatures.length > 0
      ) {
        const rec = data as Record<string, unknown>;
        if (rec.type === 'FeatureCollection' && Array.isArray(rec.features)) {
          try {
            applySetDataIncremental(data as FeatureCollection);
            currentDataRef = data;
            return;
          } catch (err) {
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.warn(
                `[GeoJSONLayer:${cfg.id}] setData: incremental path failed, falling back to full rebuild`,
                err,
              );
            }
          }
        }
      }

      // 如果启用了 keepStaleOnUpdate，保留旧数据直到新数据就绪
      if (!cfg.keepStaleOnUpdate) {
        rawFeatures = [];
        clusterMap.clear();
        dataReady = false;
      }

      // 更新数据引用
      currentDataRef = data;

      // 处理数据
      processData(data);
    },

    /**
     * @inheritdoc
     */
    setDataIncremental(newData: FeatureCollection): GeoJSONIncrementalDiffStats {
      return applySetDataIncremental(newData);
    },

    /**
     * 读取当前数据（FeatureCollection 格式）。
     *
     * @returns 当前要素集合的快照
     */
    getData(): FeatureCollection {
      return {
        type: 'FeatureCollection' as const,
        features: [...rawFeatures],
      };
    },

    // ==================== 聚合查询方法 ====================

    /**
     * 获取聚合点的展开缩放级别。
     *
     * @param clusterId - 聚合 ID
     * @returns 展开缩放级别
     */
    getClusterExpansionZoom(clusterId: number): number {
      const cluster = clusterMap.get(clusterId);
      if (cluster === undefined) {
        throw new Error(
          `[${GEOJSON_ERROR_CODES.CLUSTER_NOT_FOUND}] cluster with id ${clusterId} not found`,
        );
      }
      return cluster.expansionZoom;
    },

    /**
     * 获取聚合点的直接子节点。
     *
     * @param clusterId - 聚合 ID
     * @returns 子要素数组
     */
    getClusterChildren(clusterId: number): Feature[] {
      const cluster = clusterMap.get(clusterId);
      if (cluster === undefined) {
        throw new Error(
          `[${GEOJSON_ERROR_CODES.CLUSTER_NOT_FOUND}] cluster with id ${clusterId} not found`,
        );
      }

      // 返回聚合内的原始要素
      const children: Feature[] = [];
      for (const idx of cluster.childIndices) {
        if (idx >= 0 && idx < rawFeatures.length) {
          children.push(rawFeatures[idx]);
        }
      }
      return children;
    },

    /**
     * 获取聚合点的所有叶子要素（分页）。
     *
     * @param clusterId - 聚合 ID
     * @param limit - 最大返回数，默认 10
     * @param offset - 偏移量，默认 0
     * @returns 叶子要素数组
     */
    getClusterLeaves(clusterId: number, limit?: number, offset?: number): Feature[] {
      const cluster = clusterMap.get(clusterId);
      if (cluster === undefined) {
        throw new Error(
          `[${GEOJSON_ERROR_CODES.CLUSTER_NOT_FOUND}] cluster with id ${clusterId} not found`,
        );
      }

      // 规范化分页参数
      const effectiveLimit = (limit !== undefined && Number.isFinite(limit) && limit > 0) ? limit : 10;
      const effectiveOffset = (offset !== undefined && Number.isFinite(offset) && offset >= 0) ? offset : 0;

      // 收集所有叶子要素
      const allLeaves: Feature[] = [];
      for (const idx of cluster.childIndices) {
        if (idx >= 0 && idx < rawFeatures.length) {
          allLeaves.push(rawFeatures[idx]);
        }
      }

      // 应用分页
      return allLeaves.slice(effectiveOffset, effectiveOffset + effectiveLimit);
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素级状态。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素级状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态或 undefined
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 查询方法 ====================

    /**
     * 按包围盒查询要素。
     *
     * @param bbox - 查询包围盒
     * @param filter - 可选过滤表达式（MVP 不求值）
     * @returns 匹配要素数组
     */
    queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[] {
      const results: Feature[] = [];

      // 校验输入
      if (
        !Number.isFinite(bbox.west) || !Number.isFinite(bbox.south) ||
        !Number.isFinite(bbox.east) || !Number.isFinite(bbox.north)
      ) {
        return results;
      }

      // 遍历所有要素，检查包围盒相交
      for (const feature of rawFeatures) {
        const fBBox = featureBBox(feature);
        if (fBBox === null) continue;

        if (bboxIntersects(bbox, fBBox)) {
          results.push(feature);
        }
      }

      return results;
    },

    /**
     * 按屏幕坐标查询渲染要素。
     * MVP 返回空数组（完整实现需 GPU PickingEngine readback）。
     *
     * @param point - 屏幕坐标 [x, y]
     * @returns 命中要素数组
     */
    queryRenderedFeatures(point: [number, number]): Feature[] {
      if (
        !Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])
      ) {
        return [];
      }

      // MVP: 完整实现需要 GPU PickingEngine
      return [];
    },
  };

  return layer;
}

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;
