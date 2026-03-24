// ============================================================
// types/feature.ts — GeoJSON Feature 与 FeatureCollection 类型
// 被引用于：L4/SpatialQuery, L4/FeatureStateManager, L4/AntiMeridianHandler,
//          L4/StyleEngine, L5/MapPointerEvent, L6/queryRenderedFeatures
//
// Feature 类型的唯一定义源（Single Source of Truth）。
// 这是审计报告不一致 #4 的修复——Feature 类型之前从未统一定义，
// 导致 L4/L5/L6 各自引用不同的字段集合。
// ============================================================

import type { Geometry } from './geometry.ts';
import type { TileCoord } from './tile.ts';

/**
 * GeoJSON Feature（RFC 7946 §3.2）。
 * 表示一个带有几何形状和属性的地理要素。
 *
 * 除标准 GeoJSON 字段外，GeoForge 引擎在运行时会附加以 `_` 前缀的内部字段，
 * 用于跟踪要素的来源、归属和状态。这些字段不会序列化到 GeoJSON 输出中。
 *
 * @typeParam G - 几何类型约束，默认为 Geometry 联合类型。
 *              指定具体类型可获得更强的类型推导，
 *              如 `Feature<PointGeometry>` 限定为点要素。
 * @typeParam P - 属性对象类型，默认为 `Record<string, unknown>`。
 *              指定具体类型可获得属性字段的类型检查，
 *              如 `Feature<Geometry, { name: string; pop: number }>`。
 *
 * @example
 * const feature: Feature<PointGeometry, { name: string }> = {
 *   type: 'Feature',
 *   id: 'poi-001',
 *   geometry: { type: 'Point', coordinates: [116.39, 39.91] },
 *   properties: { name: '天安门' },
 * };
 */
export interface Feature<
  G extends Geometry = Geometry,
  P = Record<string, unknown>,
> {
  /**
   * GeoJSON 对象类型鉴别字面量，固定为 `'Feature'`。
   * 用于在 GeoJSON 联合类型中进行类型窄化。
   */
  readonly type: 'Feature';

  /**
   * 要素的唯一标识符（RFC 7946 §3.2）。
   * 可以是字符串或数值类型，在同一 FeatureCollection 内应唯一。
   * 用于 FeatureStateManager 的状态关联和拾取（Picking）结果匹配。
   * 可选，GeoJSON 标准允许省略。
   */
  readonly id?: string | number;

  /**
   * 要素的几何形状。
   * 描述要素在地理空间中的位置和形状。
   * 可以是 Point、LineString、Polygon 等任意 Geometry 类型。
   * RFC 7946 允许 null（无几何的属性要素），但 GeoForge 渲染管线
   * 会跳过 geometry 为 null 的要素。
   */
  readonly geometry: G;

  /**
   * 要素的属性集合。
   * 包含非几何的业务数据（如名称、人口、类别等）。
   * StyleEngine 通过 `['get', 'propertyName']` 表达式访问这些属性。
   * RFC 7946 允许 null，但 GeoForge 内部始终保证为对象（至少为空对象 `{}`）。
   */
  readonly properties: P;

  // ===================== 引擎运行时附加字段 =====================
  // 以下字段为 GeoForge 引擎内部使用，不属于 GeoJSON 标准。
  // 由引擎在数据加载/查询过程中自动填充，用户无需手动设置。

  /**
   * 要素所属的数据源 ID。
   * 由 SourceManager 在数据解码后填充。
   * 用于 queryRenderedFeatures 结果中追溯数据来源。
   * 引擎内部字段，非 GeoJSON 标准。
   */
  readonly _sourceId?: string;

  /**
   * 要素当前归属的图层 ID。
   * 由 LayerManager 在要素与图层关联后填充。
   * 同一数据源的要素可能被多个图层引用（通过 source-layer）。
   * 引擎内部字段，非 GeoJSON 标准。
   */
  readonly _layerId?: string;

  /**
   * 要素来自的瓦片坐标。
   * 对于瓦片化数据源（vector/raster），标识此要素解码自哪个瓦片。
   * 用于 TileScheduler 的瓦片卸载逻辑和跨瓦片要素去重。
   * 对于非瓦片化数据源（如内嵌 GeoJSON），此字段为 undefined。
   * 引擎内部字段，非 GeoJSON 标准。
   */
  readonly _tileCoord?: TileCoord;

  /**
   * 要素的交互状态。
   * 由 FeatureStateManager 管理，存储动态状态（如 hover、selected、custom）。
   * StyleEngine 通过 `['feature-state', 'stateName']` 表达式读取这些状态
   * 以实现数据驱动的样式交互（如悬停高亮、选中变色）。
   * 引擎内部字段，非 GeoJSON 标准。
   */
  readonly _state?: Record<string, unknown>;
}

/**
 * GeoJSON FeatureCollection（RFC 7946 §3.3）。
 * 表示一组 Feature 的有序集合。
 * 是 GeoJSON 最常用的顶层容器，addSource 的 `data` 字段通常接受此类型。
 *
 * @typeParam G - 集合中所有要素的几何类型约束
 * @typeParam P - 集合中所有要素的属性类型约束
 *
 * @example
 * const fc: FeatureCollection<PointGeometry> = {
 *   type: 'FeatureCollection',
 *   features: [
 *     { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
 *     { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} },
 *   ],
 * };
 */
export interface FeatureCollection<
  G extends Geometry = Geometry,
  P = Record<string, unknown>,
> {
  /**
   * GeoJSON 对象类型鉴别字面量，固定为 `'FeatureCollection'`。
   * 用于在 GeoJSON 联合类型中进行类型窄化。
   */
  readonly type: 'FeatureCollection';

  /**
   * 要素数组。
   * 按加载/添加顺序排列。数组可为空（零要素的合法 FeatureCollection）。
   * 渲染顺序取决于图层类型和排序策略，不一定与此数组顺序一致。
   */
  readonly features: Feature<G, P>[];
}
