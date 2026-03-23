// ============================================================
// types/geometry.ts — GeoJSON 几何类型（RFC 7946 兼容）
// 被引用于：L4/SpatialQuery, L4/AntiMeridianHandler, L5/DataSource,
//          L6/queryRenderedFeatures, L0/types/feature.ts
// 所有几何类型的唯一定义源（Single Source of Truth），
// L1~L6 全部从 @geoforge/core 的 types/ 中 import。
// ============================================================

/**
 * GeoJSON 几何类型字符串枚举（RFC 7946 §1.4）。
 * 用于 Geometry 接口的 `type` 字段鉴别联合。
 * 共 7 种几何类型，涵盖点、线、面及其多要素变体和异构集合。
 *
 * @example
 * const geoType: GeometryType = 'Polygon';
 */
export type GeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'GeometryCollection';

/**
 * GeoJSON 位置坐标（RFC 7946 §3.1.1）。
 * 2D 位置为 [longitude, latitude]，3D 位置为 [longitude, latitude, altitude]。
 * - longitude: 经度，单位度（°），范围 [-180, 180]
 * - latitude: 纬度，单位度（°），范围 [-90, 90]
 * - altitude: 海拔高度，单位米（m），可选
 *
 * 注意：GeoJSON 坐标顺序为 [经度, 纬度]（与 [lat, lng] 相反）。
 *
 * @example
 * const pos2d: Position = [116.3912757, 39.906217];
 * const pos3d: Position = [116.3912757, 39.906217, 50.0];
 */
export type Position = [number, number] | [number, number, number];

/**
 * GeoJSON 线性环（Linear Ring）坐标数组。
 * 由 4 个或更多位置组成的闭合环，首尾坐标必须相同（RFC 7946 §3.1.6）。
 * 外环为逆时针方向，内环（孔洞）为顺时针方向。
 *
 * @example
 * const ring: LinearRing = [[0,0], [10,0], [10,10], [0,10], [0,0]];
 */
export type LinearRing = Position[];

// ===================== 单一几何类型 =====================

/**
 * GeoJSON 点几何（RFC 7946 §3.1.2）。
 * 表示空间中的一个单独位置。
 * 坐标为单个 Position。
 *
 * @example
 * const point: PointGeometry = {
 *   type: 'Point',
 *   coordinates: [116.3912757, 39.906217]
 * };
 */
export interface PointGeometry {
  /** 几何类型鉴别字面量，固定为 `'Point'` */
  readonly type: 'Point';

  /**
   * 点的坐标位置。
   * 2D: [longitude, latitude]，单位度
   * 3D: [longitude, latitude, altitude]，altitude 单位米
   */
  readonly coordinates: Position;
}

/**
 * GeoJSON 多点几何（RFC 7946 §3.1.3）。
 * 表示一组不相关联的点。
 *
 * @example
 * const multiPoint: MultiPointGeometry = {
 *   type: 'MultiPoint',
 *   coordinates: [[100, 0], [101, 1]]
 * };
 */
export interface MultiPointGeometry {
  /** 几何类型鉴别字面量，固定为 `'MultiPoint'` */
  readonly type: 'MultiPoint';

  /**
   * 点坐标数组，每个元素为一个 Position。
   * 数组长度即为点的个数。
   */
  readonly coordinates: Position[];
}

/**
 * GeoJSON 线串几何（RFC 7946 §3.1.4）。
 * 表示由两个或更多位置连成的折线。
 * 至少包含 2 个坐标点。
 *
 * @example
 * const line: LineStringGeometry = {
 *   type: 'LineString',
 *   coordinates: [[100, 0], [101, 1], [102, 0]]
 * };
 */
export interface LineStringGeometry {
  /** 几何类型鉴别字面量，固定为 `'LineString'` */
  readonly type: 'LineString';

  /**
   * 折线顶点坐标数组，按绘制顺序排列。
   * 至少包含 2 个 Position，每个为 [lon, lat] 或 [lon, lat, alt]。
   */
  readonly coordinates: Position[];
}

/**
 * GeoJSON 多线串几何（RFC 7946 §3.1.5）。
 * 表示一组独立的折线。
 *
 * @example
 * const multiLine: MultiLineStringGeometry = {
 *   type: 'MultiLineString',
 *   coordinates: [
 *     [[100, 0], [101, 1]],
 *     [[102, 2], [103, 3]]
 *   ]
 * };
 */
export interface MultiLineStringGeometry {
  /** 几何类型鉴别字面量，固定为 `'MultiLineString'` */
  readonly type: 'MultiLineString';

  /**
   * 线串坐标数组的数组。
   * 外层数组的每个元素代表一条独立的折线，
   * 内层数组为该折线的顶点序列。
   */
  readonly coordinates: Position[][];
}

/**
 * GeoJSON 多边形几何（RFC 7946 §3.1.6）。
 * 表示一个多边形面，可包含孔洞。
 * coordinates[0] 为外环（逆时针），coordinates[1..n] 为内环/孔洞（顺时针）。
 * 每个环至少 4 个坐标点，且首尾坐标必须相同。
 *
 * @example
 * const polygon: PolygonGeometry = {
 *   type: 'Polygon',
 *   coordinates: [
 *     [[100,0], [101,0], [101,1], [100,1], [100,0]],  // 外环
 *     [[100.2,0.2], [100.8,0.2], [100.8,0.8], [100.2,0.8], [100.2,0.2]]  // 孔洞
 *   ]
 * };
 */
export interface PolygonGeometry {
  /** 几何类型鉴别字面量，固定为 `'Polygon'` */
  readonly type: 'Polygon';

  /**
   * 多边形环坐标数组。
   * coordinates[0]: 外环（逆时针方向，RFC 7946 推荐）
   * coordinates[1..n]: 内环/孔洞（顺时针方向）
   * 每个环为 LinearRing，即首尾坐标相同的闭合路径。
   */
  readonly coordinates: LinearRing[];
}

/**
 * GeoJSON 多多边形几何（RFC 7946 §3.1.7）。
 * 表示一组独立的多边形，每个可含孔洞。
 * 常用于表示群岛（如印度尼西亚）或不连续行政区。
 *
 * @example
 * const multiPoly: MultiPolygonGeometry = {
 *   type: 'MultiPolygon',
 *   coordinates: [
 *     [[[102,2],[103,2],[103,3],[102,3],[102,2]]],
 *     [[[100,0],[101,0],[101,1],[100,1],[100,0]]]
 *   ]
 * };
 */
export interface MultiPolygonGeometry {
  /** 几何类型鉴别字面量，固定为 `'MultiPolygon'` */
  readonly type: 'MultiPolygon';

  /**
   * 多多边形坐标数组。
   * 最外层数组的每个元素代表一个独立的 Polygon，
   * 每个 Polygon 为环数组（外环 + 若干内环），
   * 每个环为 LinearRing。
   */
  readonly coordinates: LinearRing[][];
}

/**
 * GeoJSON 几何集合（RFC 7946 §3.1.8）。
 * 表示异构几何对象的有序集合，可包含任意类型的几何对象。
 * GeometryCollection 自身不含 coordinates 字段，而是通过 geometries 聚合子几何。
 *
 * @example
 * const collection: GeometryCollectionGeometry = {
 *   type: 'GeometryCollection',
 *   geometries: [
 *     { type: 'Point', coordinates: [100, 0] },
 *     { type: 'LineString', coordinates: [[101, 0], [102, 1]] }
 *   ]
 * };
 */
export interface GeometryCollectionGeometry {
  /** 几何类型鉴别字面量，固定为 `'GeometryCollection'` */
  readonly type: 'GeometryCollection';

  /**
   * 子几何对象数组。
   * 每个元素可以是任意 Geometry 类型（包括嵌套的 GeometryCollection，
   * 但 RFC 7946 不推荐嵌套）。
   */
  readonly geometries: Geometry[];
}

// ===================== 联合类型 =====================

/**
 * GeoJSON 几何联合类型。
 * 涵盖 RFC 7946 定义的全部 7 种几何类型的可辨识联合（Discriminated Union）。
 * 通过 `type` 字段进行类型窄化（type narrowing）。
 *
 * @example
 * function getType(g: Geometry): string {
 *   switch (g.type) {
 *     case 'Point': return `Point at ${g.coordinates}`;
 *     case 'Polygon': return `Polygon with ${g.coordinates.length} rings`;
 *     default: return g.type;
 *   }
 * }
 */
export type Geometry =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry
  | GeometryCollectionGeometry;
