// ============================================================
// types/style-spec.ts — 样式规范（StyleSpec）顶层结构
// 被引用于：L4/StyleEngine, L6/Map2D.setStyle(), L6/Globe3D.setStyle()
// 修复审计缺口 #5（StyleSpec 未定义）。
//
// 对标 MapLibre Style Spec v8，提供类型安全的样式文档定义。
// 包含数据源规格、图层样式、光照、样式表达式等。
// ============================================================

// ===================== 顶层 StyleSpec =====================

/**
 * GeoForge 样式文档（对标 MapLibre Style Spec v8）。
 * 完整描述地图的视觉表现：数据源、图层渲染规则、字形/精灵图资源、
 * 初始视口状态和全局光照参数。
 *
 * 通过 `Map2D.setStyle(spec)` / `Globe3D.setStyle(spec)` 加载。
 * StyleEngine 解析此规格生成着色器和渲染管线。
 *
 * @example
 * const style: StyleSpec = {
 *   version: 8,
 *   name: 'GeoForge Dark',
 *   sources: {
 *     openmaptiles: {
 *       type: 'vector',
 *       url: 'https://example.com/tiles.json',
 *     },
 *   },
 *   layers: [
 *     { id: 'background', type: 'background', paint: { 'background-color': '#1a1a2e' } },
 *     { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
 *       paint: { 'fill-color': '#0f3460' } },
 *   ],
 * };
 */
export interface StyleSpec {
  /**
   * 样式规范版本号，固定为 `8`。
   * 对标 Mapbox/MapLibre Style Specification v8。
   * 引擎在解析时会校验此值，非 8 将抛出错误。
   */
  readonly version: 8;

  /**
   * 样式的可读名称。
   * 仅用于 UI 展示和调试日志，不影响渲染。
   * 可选，默认为 undefined。
   *
   * @example 'GeoForge Dark Mode'
   */
  readonly name?: string;

  /**
   * 样式元数据（自由格式键值对）。
   * 用于存储工具链、编辑器等外部系统的自定义信息。
   * 引擎不解析此字段，原样保留。
   * 可选，默认为 undefined。
   */
  readonly metadata?: Record<string, unknown>;

  /**
   * 数据源字典。
   * 键为数据源 ID（在 LayerStyleSpec.source 中引用），值为数据源规格。
   * 至少需要一个数据源（除非只有 background 图层）。
   *
   * @example
   * { openmaptiles: { type: 'vector', url: '...' } }
   */
  readonly sources: Record<string, SourceSpec>;

  /**
   * 图层数组（按渲染顺序排列）。
   * 数组索引 0 在最底层（最先渲染），最后一个在最顶层（最后渲染）。
   * 每个图层引用一个数据源，并定义该数据源数据的可视化规则。
   * 至少需要一个图层。
   */
  readonly layers: LayerStyleSpec[];

  /**
   * 字形（Glyph）资源 URL 模板。
   * 用于加载文本标注所需的 SDF（Signed Distance Field）字形数据。
   * 模板中的占位符：
   * - `{fontstack}`: 字体栈名称（如 'Noto Sans Regular'）
   * - `{range}`: Unicode 范围（如 '0-255'）
   *
   * 可选，不使用文字标注时可省略。
   *
   * @example 'https://fonts.example.com/{fontstack}/{range}.pbf'
   */
  readonly glyphs?: string;

  /**
   * 精灵图（Sprite）资源 URL 前缀。
   * 用于加载图标/图案所需的精灵图集（SpriteSheet）。
   * 引擎会自动追加 `.json`（元数据）和 `.png`（图片）后缀。
   * 高 DPI 设备会尝试加载 `@2x` 版本。
   *
   * 可选，不使用图标/图案时可省略。
   *
   * @example 'https://sprites.example.com/dark'
   */
  readonly sprite?: string;

  /**
   * 初始地图中心点 [longitude, latitude]。
   * 单位：度（°）。
   * 可选，可在 Map 构造函数中覆盖。
   *
   * @example [116.39, 39.91]
   */
  readonly center?: [number, number];

  /**
   * 初始缩放级别。
   * 连续值，范围通常 [0, 22]。
   * 可选，可在 Map 构造函数中覆盖。
   * 默认值取决于预设（Map2D 默认 1，Globe3D 默认 2）。
   */
  readonly zoom?: number;

  /**
   * 初始旋转角 / 方位角。
   * 单位：度（°），注意此处为度（样式规范约定），
   * 引擎内部会转换为弧度存入 CameraState.bearing。
   * 0 = 正北，正值顺时针旋转。
   * 可选，默认 0。
   */
  readonly bearing?: number;

  /**
   * 初始俯仰角。
   * 单位：度（°），注意此处为度（样式规范约定），
   * 引擎内部会转换为弧度存入 CameraState.pitch。
   * 0 = 正俯视，正值向地平线方向倾斜。
   * 可选，默认 0。
   */
  readonly pitch?: number;

  /**
   * 全局光照参数。
   * 控制 fill-extrusion、hillshade 等图层的光照效果。
   * 可选，默认为引擎内置光照配置。
   */
  readonly light?: LightSpec;
}

// ===================== SourceSpec =====================

/**
 * 数据源规格。
 * 描述地图数据的来源类型、访问地址和参数约束。
 * 不同的 type 值对应不同的数据获取和解码策略。
 *
 * @example
 * const vectorSource: SourceSpec = {
 *   type: 'vector',
 *   tiles: ['https://tiles.example.com/{z}/{x}/{y}.pbf'],
 *   minzoom: 0,
 *   maxzoom: 14,
 * };
 *
 * @example
 * const geojsonSource: SourceSpec = {
 *   type: 'geojson',
 *   data: { type: 'FeatureCollection', features: [] },
 * };
 */
export interface SourceSpec {
  /**
   * 数据源类型。
   * 内置类型：
   * - `'vector'`: 矢量瓦片（MVT/PBF 格式）
   * - `'raster'`: 栅格影像瓦片（PNG/JPEG/WebP）
   * - `'raster-dem'`: 栅格 DEM 高程瓦片
   * - `'geojson'`: 内嵌或远程 GeoJSON 数据
   * - `'image'`: 静态地理参考图片
   * - `'video'`: 静态地理参考视频
   * - `'3dtiles'`: OGC 3D Tiles（GeoForge 扩展）
   * 允许 string 以支持 ExtensionRegistry 注册的自定义数据源类型。
   */
  readonly type: 'vector' | 'raster' | 'raster-dem' | 'geojson' | 'image' | 'video' | '3dtiles' | string;

  /**
   * TileJSON 元数据 URL。
   * 指向一个 TileJSON 端点，引擎会自动获取 tiles/bounds/minzoom/maxzoom 等信息。
   * 与 tiles 字段互斥——指定 url 时忽略 tiles。
   * 可选。
   *
   * @example 'https://tiles.example.com/openmaptiles.json'
   */
  readonly url?: string;

  /**
   * 多个备用 TileJSON URL（负载均衡/容灾）。
   * 引擎会按轮询或随机策略选择 URL。
   * 可选，较少使用。
   */
  readonly urls?: string[];

  /**
   * 瓦片 URL 模板数组。
   * 模板中的占位符：`{z}`/`{x}`/`{y}` 分别对应缩放级别/列号/行号。
   * 多个 URL 模板用于子域名负载均衡（如 a/b/c.tiles.example.com）。
   * 与 url 字段互斥——指定 tiles 时忽略 url。
   * 可选（geojson/image/video 类型不需要）。
   *
   * @example ['https://a.tiles.example.com/{z}/{x}/{y}.pbf']
   */
  readonly tiles?: string[];

  /**
   * 内嵌数据对象。
   * 用于 geojson 类型的内嵌 FeatureCollection 或 Feature。
   * 也可为 GeoJSON 文件的 URL 字符串。
   * 对于其他类型不使用。
   * 可选。
   */
  readonly data?: object | string;

  /**
   * 瓦片像素尺寸。
   * 单位：像素。常用值 256 或 512。
   * 影响 LOD 计算和地面分辨率换算。
   * 可选，默认 512（GeoForge 默认值，比传统 256 减少请求数）。
   */
  readonly tileSize?: number;

  /**
   * 数据源可用的最小缩放级别。
   * 低于此级别时不请求瓦片。
   * 范围 [0, 22]，必须 ≤ maxzoom。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 数据源可用的最大缩放级别。
   * 超过此级别时使用 maxzoom 级别的瓦片进行 overscaling。
   * 范围 [0, 22]，必须 ≥ minzoom。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 数据源的地理范围 [west, south, east, north]。
   * 单位：度（°）。
   * 超出此范围的瓦片不会被请求。
   * 用于减少无效请求（如海洋区域不请求建筑物瓦片）。
   * 可选，默认 [-180, -85.051129, 180, 85.051129]（全球墨卡托范围）。
   *
   * @example [-180, -85.051129, 180, 85.051129]
   */
  readonly bounds?: [number, number, number, number];

  /**
   * 数据源归属信息（版权声明）。
   * 显示在地图底部的归属控件中（如 "© OpenStreetMap contributors"）。
   * 支持 HTML 标签（如 `<a>` 链接）。
   * 可选。
   */
  readonly attribution?: string;

  /**
   * 瓦片编号方案。
   * - `'xyz'`: 标准 Slippy Map 方案，y 轴从上（北）到下（南），默认值
   * - `'tms'`: TMS 方案，y 轴从下（南）到上（北），y' = 2^z - 1 - y
   * 可选，默认 `'xyz'`。
   */
  readonly scheme?: 'xyz' | 'tms';

  /**
   * DEM 高程编码方案。
   * 仅用于 `'raster-dem'` 类型的数据源。
   * - `'mapbox'`: Mapbox Terrain-RGB 编码（height = -10000 + (R×256×256 + G×256 + B) × 0.1）
   * - `'terrarium'`: Terrarium 编码（height = (R×256 + G + B/256) - 32768）
   * 可选，默认 `'mapbox'`。
   */
  readonly encoding?: 'mapbox' | 'terrarium';

  /**
   * 要素 ID 提升字段名。
   * 将要素属性中的指定字段值提升为 Feature.id。
   * 用于 FeatureStateManager 需要按 ID 设置状态但原始数据无顶层 id 的场景。
   * 仅对 vector 和 geojson 类型有效。
   * 可选。
   *
   * @example 'osm_id'
   */
  readonly promoteId?: string;
}

// ===================== LayerStyleSpec =====================

/**
 * 图层样式规格。
 * 定义单个渲染图层的类型、数据过滤条件、缩放范围和视觉样式。
 * 一个图层引用一个数据源，并可通过 source-layer 指定矢量瓦片中的子图层。
 *
 * layout 属性在图层创建时求值（不随要素变化），
 * paint 属性在每帧渲染时求值（支持数据驱动和缩放插值）。
 *
 * @example
 * const buildingLayer: LayerStyleSpec = {
 *   id: 'buildings-3d',
 *   type: 'fill-extrusion',
 *   source: 'openmaptiles',
 *   'source-layer': 'building',
 *   filter: ['>', ['get', 'height'], 0],
 *   minzoom: 14,
 *   paint: {
 *     'fill-extrusion-height': ['get', 'height'],
 *     'fill-extrusion-color': '#aaa',
 *     'fill-extrusion-opacity': 0.8,
 *   },
 * };
 */
export interface LayerStyleSpec {
  /**
   * 图层唯一标识符。
   * 在 StyleSpec.layers 数组中必须唯一。
   * 用于 queryRenderedFeatures 过滤、PickResult.layerId 关联、
   * 运行时样式修改（如 setPaintProperty）等。
   * 必填。
   */
  readonly id: string;

  /**
   * 图层渲染类型。
   * 决定了可用的 layout/paint 属性集合和渲染管线。
   * 内置类型：
   * - `'fill'`: 多边形填充
   * - `'line'`: 折线描边
   * - `'symbol'`: 图标+文字标注
   * - `'circle'`: 圆点
   * - `'heatmap'`: 热力图
   * - `'fill-extrusion'`: 3D 建筑拉伸
   * - `'raster'`: 栅格影像
   * - `'hillshade'`: 山影
   * - `'background'`: 背景色
   * - `'sky'`: 天空/大气（GeoForge 扩展）
   * 允许 string 以支持 ExtensionRegistry 注册的自定义图层类型。
   */
  readonly type:
    | 'fill'
    | 'line'
    | 'symbol'
    | 'circle'
    | 'heatmap'
    | 'fill-extrusion'
    | 'raster'
    | 'hillshade'
    | 'background'
    | 'sky'
    | string;

  /**
   * 引用的数据源 ID。
   * 对应 StyleSpec.sources 中的键名。
   * background 和 sky 类型图层不需要数据源，此字段可省略。
   * 可选。
   */
  readonly source?: string;

  /**
   * 矢量瓦片中的子图层名称。
   * 仅对 source type 为 `'vector'` 的数据源有效。
   * 对应 MVT 中的 layer name（如 'water', 'building', 'transportation'）。
   * 可选。
   *
   * @example 'building'
   */
  readonly 'source-layer'?: string;

  /**
   * 数据过滤表达式。
   * 仅渲染满足过滤条件的要素。
   * 使用样式表达式语法（如 `['==', ['get', 'class'], 'residential']`）。
   * 可选，默认不过滤（渲染所有要素）。
   */
  readonly filter?: FilterExpression;

  /**
   * 图层可见的最小缩放级别（含）。
   * 低于此级别时图层不渲染。
   * 范围 [0, 24]，可以为小数。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 超过此级别时图层不渲染。
   * 范围 [0, 24]，可以为小数，必须 ≥ minzoom。
   * 可选，默认 24。
   */
  readonly maxzoom?: number;

  /**
   * 布局属性（Layout Properties）。
   * 控制要素的几何布局方式（如文字锚点、线端样式、图标旋转模式）。
   * 在图层创建/样式更新时求值，不参与逐帧重新计算。
   * 具体可用属性取决于图层 type。
   * 值可以是常量或样式表达式。
   * 可选，使用各属性的默认值。
   */
  readonly layout?: Record<string, unknown>;

  /**
   * 绘制属性（Paint Properties）。
   * 控制要素的视觉外观（如颜色、透明度、宽度、模糊等）。
   * 在每帧渲染时求值，支持数据驱动（`['get', 'prop']`）和
   * 缩放级别插值（`['interpolate', ...]`）。
   * 具体可用属性取决于图层 type。
   * 值可以是常量或样式表达式。
   * 可选，使用各属性的默认值。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * 图层元数据（自由格式键值对）。
   * 用于存储工具链或应用层的自定义信息（如编辑器分组、标签等）。
   * 引擎不解析此字段，原样保留。
   * 可选。
   */
  readonly metadata?: Record<string, unknown>;
}

// ===================== LightSpec =====================

/**
 * 全局光照参数。
 * 控制 fill-extrusion（3D 建筑）和 hillshade（山影）图层的光照效果。
 * 定义一个方向光源的锚定模式、颜色、强度和位置。
 *
 * @example
 * const light: LightSpec = {
 *   anchor: 'viewport',
 *   color: '#ffffff',
 *   intensity: 0.5,
 *   position: [1.15, 210, 30],
 * };
 */
export interface LightSpec {
  /**
   * 光源锚定模式。
   * - `'map'`: 光源相对于地图固定，旋转地图时光照方向随之变化
   * - `'viewport'`: 光源相对于视口固定，旋转地图时光照方向不变
   * 可选，默认 `'viewport'`。
   */
  readonly anchor?: 'map' | 'viewport';

  /**
   * 光源颜色。
   * CSS 颜色字符串（如 `'#ffffff'`、`'rgb(255,255,255)'`、`'white'`）。
   * 可选，默认 `'#ffffff'`（纯白光）。
   */
  readonly color?: string;

  /**
   * 光源强度。
   * 范围 [0.0, 1.0]。
   * 0.0 = 无光照（纯环境光），1.0 = 最大强度。
   * 可选，默认 0.5。
   */
  readonly intensity?: number;

  /**
   * 光源位置 [radialCoordinate, azimuthalAngle, polarAngle]。
   * - radialCoordinate: 径向距离，范围 [1.0, +∞)，默认 1.15
   * - azimuthalAngle: 方位角，单位度（°），范围 [0, 360)，0 = 正北，顺时针，默认 210
   * - polarAngle: 极角/仰角，单位度（°），范围 [0, 90]，0 = 正上方，90 = 地平线，默认 30
   * 可选，默认 [1.15, 210, 30]。
   */
  readonly position?: [number, number, number];
}

// ===================== 样式表达式 =====================

/**
 * 样式表达式（Style Expression）。
 * GeoForge 样式系统的核心，用于在样式规格中定义数据驱动和缩放级别相关的动态值。
 * 支持以下运算符类别：
 *
 * **属性访问**：`['get', name]`, `['has', name]`
 * **比较**：`['==', a, b]`, `['!=', a, b]`, `['>', a, b]`, `['<', a, b]`, `['>=', a, b]`, `['<=', a, b]`
 * **逻辑**：`['all', ...exprs]`, `['any', ...exprs]`, `['!', expr]`
 * **条件**：`['case', cond1, val1, ..., fallback]`, `['match', input, ...pairs, fallback]`, `['coalesce', ...exprs]`
 * **插值**：`['interpolate', type, input, stop1, val1, ...]`, `['step', input, default, stop1, val1, ...]`
 * **缩放**：`['zoom']`
 *
 * 表达式可递归嵌套，叶节点为字面值（number/string/boolean）。
 *
 * @example
 * const colorExpr: StyleExpression = [
 *   'interpolate', ['linear'], ['zoom'],
 *   10, '#ffffcc',
 *   15, '#ff0000',
 * ];
 *
 * @example
 * const filterExpr: StyleExpression = [
 *   'all',
 *   ['==', ['get', 'class'], 'residential'],
 *   ['>', ['get', 'height'], 10],
 * ];
 */
export type StyleExpression =
  | number
  | string
  | boolean
  | ['get', string]
  | ['has', string]
  | ['==', StyleExpression, StyleExpression]
  | ['!=', StyleExpression, StyleExpression]
  | ['>', StyleExpression, StyleExpression]
  | ['<', StyleExpression, StyleExpression]
  | ['>=', StyleExpression, StyleExpression]
  | ['<=', StyleExpression, StyleExpression]
  | ['all', ...StyleExpression[]]
  | ['any', ...StyleExpression[]]
  | ['!', StyleExpression]
  | ['case', ...StyleExpression[]]
  | ['match', StyleExpression, ...unknown[]]
  | ['interpolate', InterpolationType, StyleExpression, ...unknown[]]
  | ['step', StyleExpression, unknown, ...unknown[]]
  | ['zoom']
  | ['coalesce', ...StyleExpression[]];

/**
 * 插值类型定义。
 * 控制 `['interpolate', ...]` 表达式在停靠点之间的插值方式。
 *
 * - `['linear']`: 线性插值，在相邻停靠点之间均匀过渡
 * - `['exponential', base]`: 指数插值，base 控制增长速率（base=1 等同线性，base>1 加速增长）
 * - `['cubic-bezier', x1, y1, x2, y2]`: 三次贝塞尔曲线插值，
 *   (x1,y1) 和 (x2,y2) 为控制点坐标，范围 [0,1]
 *
 * @example
 * const linear: InterpolationType = ['linear'];
 * const exponential: InterpolationType = ['exponential', 1.5];
 * const bezier: InterpolationType = ['cubic-bezier', 0.42, 0, 0.58, 1];
 */
export type InterpolationType =
  | ['linear']
  | ['exponential', number]
  | ['cubic-bezier', number, number, number, number];

/**
 * 过滤表达式。
 * 用于 LayerStyleSpec.filter，决定哪些要素参与渲染。
 * 语法与 StyleExpression 相同，但求值结果必须为布尔值。
 * true = 渲染该要素，false = 跳过该要素。
 *
 * @example
 * const filter: FilterExpression = ['all',
 *   ['==', ['get', 'type'], 'highway'],
 *   ['>=', ['get', 'lanes'], 2],
 * ];
 */
export type FilterExpression = StyleExpression;
