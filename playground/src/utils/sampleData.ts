// ============================================================
// playground/src/utils/sampleData.ts
// DevPlayground 共享的示例数据常量。
// 所有场景可复用这些预定义的 GeoJSON、瓦片 URL 和城市坐标。
// ============================================================

// ============================================================
// 类型定义
// ============================================================

/**
 * GeoJSON Feature 简化类型。
 * 仅定义 Playground 中实际使用的字段，避免引入外部 GeoJSON 类型包。
 */
export interface GeoJSONFeature {
  /** GeoJSON 对象类型，始终为 'Feature' */
  readonly type: 'Feature';
  /** 几何体定义 */
  readonly geometry: {
    /** 几何类型：Point / Polygon / LineString 等 */
    readonly type: string;
    /** 坐标数组，具体结构取决于几何类型 */
    readonly coordinates: ReadonlyArray<unknown>;
  };
  /** 属性键值对 */
  readonly properties: Record<string, unknown>;
}

/**
 * GeoJSON FeatureCollection 简化类型。
 */
export interface GeoJSONFeatureCollection {
  /** 始终为 'FeatureCollection' */
  readonly type: 'FeatureCollection';
  /** Feature 数组 */
  readonly features: ReadonlyArray<GeoJSONFeature>;
}

/**
 * 预设城市位置。
 * 用于场景中的"跳转到预设位置"下拉菜单。
 */
export interface CityPreset {
  /** 城市名称（英文，用于下拉选项的 label） */
  readonly name: string;
  /** 经度（度，WGS84） */
  readonly lon: number;
  /** 纬度（度，WGS84） */
  readonly lat: number;
  /** 推荐缩放级别（整数或小数） */
  readonly zoom: number;
}

// ============================================================
// OSM 瓦片 URL 模板
// ============================================================

/**
 * OpenStreetMap 标准瓦片 URL 模板。
 * {z}/{x}/{y} 占位符在运行时替换为实际瓦片坐标。
 * 注意：OSM 瓦片要求 User-Agent 头，浏览器默认满足。
 * 使用 abc 子域负载均衡（可选）。
 */
export const OSM_TILE_URL: string = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * OSM 多子域瓦片 URL 模板，通过 a/b/c 子域分散请求。
 * 浏览器对同一域名有 6 连接限制，多子域可提升并发加载速度。
 */
export const OSM_TILE_URL_SUBDOMAINS: ReadonlyArray<string> = [
  'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
];

// ============================================================
// 预设城市坐标
// ============================================================

/**
 * 全球主要城市预设位置列表。
 * 覆盖亚洲、欧洲、北美、南美、非洲、大洋洲，
 * 用于演示不同经纬度和缩放级别下的渲染效果。
 */
export const CITIES: ReadonlyArray<CityPreset> = [
  { name: 'Beijing',    lon: 116.3912, lat: 39.9073,  zoom: 12 },
  { name: 'Tokyo',      lon: 139.6917, lat: 35.6895,  zoom: 12 },
  { name: 'New York',   lon: -74.0060, lat: 40.7128,  zoom: 12 },
  { name: 'London',     lon: -0.1276,  lat: 51.5074,  zoom: 12 },
  { name: 'Paris',      lon: 2.3522,   lat: 48.8566,  zoom: 12 },
  { name: 'Shanghai',   lon: 121.4737, lat: 31.2304,  zoom: 12 },
  { name: 'Sydney',     lon: 151.2093, lat: -33.8688, zoom: 12 },
  { name: 'São Paulo',  lon: -46.6333, lat: -23.5505, zoom: 12 },
  { name: 'Cairo',      lon: 31.2357,  lat: 30.0444,  zoom: 12 },
  { name: 'Singapore',  lon: 103.8198, lat: 1.3521,   zoom: 12 },
];

// ============================================================
// 示例 GeoJSON — 北京区域兴趣点
// ============================================================

/**
 * 北京市区主要地标的 GeoJSON FeatureCollection。
 * 包含 8 个 Point Feature，每个带有 name（名称）和 category（类别）属性。
 * 坐标系：WGS84（EPSG:4326），精度 4 位小数（~11m 级别）。
 */
export const SAMPLE_GEOJSON: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.3912, 39.9073] },
      properties: { name: '天安门广场', category: 'landmark', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.3972, 39.9164] },
      properties: { name: '故宫博物院', category: 'museum', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4074, 39.9042] },
      properties: { name: '王府井大街', category: 'commercial', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.3486, 39.9990] },
      properties: { name: '鸟巢体育场', category: 'sports', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.3341, 39.9999] },
      properties: { name: '水立方', category: 'sports', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.2734, 39.8663] },
      properties: { name: '颐和园', category: 'park', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4551, 39.9430] },
      properties: { name: '三里屯', category: 'commercial', population: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.3264, 39.9480] },
      properties: { name: '北京动物园', category: 'park', population: 0 },
    },
  ],
};

// ============================================================
// 示例多边形 — 北京五环近似边界
// ============================================================

/**
 * 北京五环路的简化近似边界（12 个顶点的凸多边形）。
 * 非精确行政边界，仅用于 Playground 可视化演示。
 * 顶点按逆时针排列（符合 GeoJSON 右手定则：外环逆时针）。
 * 首尾坐标相同（闭合环）。
 */
export const SAMPLE_POLYGON: GeoJSONFeature = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [116.2100, 39.9900],
        [116.2500, 40.0300],
        [116.3200, 40.0500],
        [116.4000, 40.0500],
        [116.4700, 40.0300],
        [116.5100, 39.9900],
        [116.5200, 39.9400],
        [116.5100, 39.8800],
        [116.4700, 39.8400],
        [116.3900, 39.8200],
        [116.3000, 39.8300],
        [116.2300, 39.8700],
        [116.2100, 39.9300],
        [116.2100, 39.9900],
      ],
    ],
  },
  properties: {
    name: '北京五环近似边界',
    area_km2: 667,
    description: 'Approximate boundary of Beijing 5th Ring Road',
  },
};

// ============================================================
// 示例线要素 — 长安街
// ============================================================

/**
 * 长安街简化线要素（东西走向主干道）。
 * 从复兴门到建国门的 5 个关键节点。
 */
export const SAMPLE_LINESTRING: GeoJSONFeature = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [116.3453, 39.9074],
      [116.3600, 39.9075],
      [116.3912, 39.9073],
      [116.4200, 39.9071],
      [116.4430, 39.9070],
    ],
  },
  properties: {
    name: '长安街',
    length_km: 7.4,
    lanes: 10,
  },
};

// ============================================================
// 默认视图参数
// ============================================================

/** 默认地图中心：北京天安门 [经度, 纬度] */
export const DEFAULT_CENTER: [number, number] = [116.3912, 39.9073];

/** 默认缩放级别：城市级概览 */
export const DEFAULT_ZOOM: number = 12;

/** 全球视图中心 [经度, 纬度] */
export const WORLD_CENTER: [number, number] = [0, 20];

/** 全球视图缩放级别 */
export const WORLD_ZOOM: number = 2;
