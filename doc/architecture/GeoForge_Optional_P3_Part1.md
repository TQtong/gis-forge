# GeoForge 可选功能包完整接口设计 — P3 生态包（上）

> source-wmts / source-wms / source-wfs / source-pmtiles

---

## 1. @geoforge/source-wmts

### 1.1 WMTSSourceOptions

```typescript
export interface WMTSSourceOptions {
  /**
   * WMTS 服务 URL。
   * KVP 模式：Capabilities 端点 'https://example.com/wmts?SERVICE=WMTS&REQUEST=GetCapabilities'
   * RESTful 模式：URL 模板 'https://example.com/wmts/{layer}/{style}/{matrixSet}/{z}/{y}/{x}.png'
   */
  readonly url: string;

  /** WMTS 图层标识符（必须匹配 Capabilities 中的 Layer.Identifier） */
  readonly layer: string;

  /** 样式标识符 @default 'default' */
  readonly style?: string;

  /** TileMatrixSet 标识符（如 'EPSG:3857'） */
  readonly matrixSet: string;

  /** 瓦片格式 @default 'image/png' */
  readonly format?: string;

  /** 请求模式 @default 自动检测（URL 含 {z} → RESTful，否则 KVP） */
  readonly requestMode?: 'KVP' | 'RESTful';

  /** 额外维度参数 @example { TIME: '2024-01-01' } */
  readonly dimensions?: Record<string, string>;

  /** 多域名子域名列表（URL 中 {s} 替换）@example ['a','b','c'] */
  readonly subdomains?: string[];

  /** 自定义请求头 @example { 'Authorization': 'Bearer xxx' } */
  readonly headers?: Record<string, string>;

  /** 瓦片过期时间 @unit 毫秒 @default 0（不过期） */
  readonly tileExpiration?: number;
}
```

### 1.2 WMTSCapabilities

```typescript
export interface WMTSCapabilities {
  readonly title: string;
  readonly layers: ReadonlyArray<{
    readonly identifier: string;
    readonly title: string;
    readonly formats: ReadonlyArray<string>;
    readonly matrixSets: ReadonlyArray<string>;
    readonly styles: ReadonlyArray<{ identifier: string; isDefault: boolean }>;
    readonly bbox?: BBox2D;
    readonly dimensions?: ReadonlyArray<{ identifier: string; defaultValue: string; values: string[] }>;
  }>;
  readonly matrixSets: ReadonlyArray<{
    readonly identifier: string;
    readonly crs: string;
    readonly matrices: ReadonlyArray<{
      readonly identifier: string;
      readonly scaleDenominator: number;
      /** 左上角坐标 [x, y]（CRS 坐标单位） */
      readonly topLeftCorner: [number, number];
      readonly matrixWidth: number;
      readonly matrixHeight: number;
      readonly tileWidth: number;
      readonly tileHeight: number;
    }>;
  }>;
  readonly resourceUrls?: ReadonlyArray<{ format: string; resourceType: string; template: string }>;
}
```

### 1.3 WMTSSource 接口

```typescript
export interface WMTSSource extends DataSource<ImageBitmap> {
  readonly type: 'wmts';
  readonly cacheable: true;

  /**
   * 初始化。
   * 步骤：
   *   1. 如果 URL 是 Capabilities 端点（非模板）：
   *      a. fetch(url) → XML
   *      b. DOMParser 解析 XML → WMTSCapabilities
   *      c. 验证 layer/matrixSet/format 在 Capabilities 中存在
   *      d. 提取 resourceUrl 模板（如果有 RESTful 支持）
   *      e. 构建 TileMatrix → GeoForge zoom 映射表
   *   2. 如果 URL 是 RESTful 模板（含 {z}/{y}/{x}）：
   *      a. 跳过 Capabilities 解析
   *      b. 直接使用 URL 模板
   *   3. 注册到 SourceContext.requestScheduler
   *
   * TileMatrix → zoom 映射算法：
   *   WMTS TileMatrix 的 scaleDenominator → 实际地面分辨率
   *   groundResolution = scaleDenominator × 0.00028（OGC 标准像素尺寸 0.28mm）
   *   zoom = round(log2(EARTH_CIRCUMFERENCE / (groundResolution × tileWidth)))
   *   注意：某些 WMTS 的 TileMatrix identifier 不是数字（如 'Level_0', '00'），
   *   必须通过 scaleDenominator 计算映射，不能直接用 identifier 当 zoom。
   *
   * @stability stable
   * @throws GeoForgeError(CONFIG) layer/matrixSet 不存在
   * @throws GeoForgeError(DATA_TILE_LOAD) Capabilities 加载失败
   */
  initialize(context: SourceContext): Promise<void>;

  /** @stability stable */
  destroy(): void;

  /**
   * 获取元数据。
   * @stability stable
   */
  getMetadata(): Promise<SourceMetadata>;

  /**
   * 加载瓦片。
   *
   * KVP URL 构建：
   *   ?SERVICE=WMTS
   *   &REQUEST=GetTile
   *   &VERSION=1.0.0
   *   &LAYER={layer}
   *   &STYLE={style}
   *   &TILEMATRIXSET={matrixSet}
   *   &TILEMATRIX={matrixIdentifier}   ← 从 zoom 映射表查找
   *   &TILEROW={y}                     ← 注意 WMTS Y 轴可能从上到下
   *   &TILECOL={x}
   *   &FORMAT={format}
   *   + dimensions 追加：&TIME=2024-01-01&...
   *
   * RESTful URL 构建：
   *   template.replace('{layer}', layer)
   *           .replace('{style}', style)
   *           .replace('{TileMatrixSet}', matrixSet)
   *           .replace('{TileMatrix}', matrixIdentifier)
   *           .replace('{TileRow}', y)
   *           .replace('{TileCol}', x)
   *           .replace('{s}', subdomains[random])
   *
   * Y 轴方向注意：
   *   WMTS 标准：TileRow 从 topLeftCorner 向下计数（0 = 最上面）
   *   TMS/XYZ：Y 从底部向上计数
   *   GeoForge 内部使用 XYZ（Y 从上到下），与 WMTS 一致，无需翻转。
   *   但如果数据源实际是 TMS 方案，需要：wmtsY = matrixHeight - 1 - tmsY
   *
   * @stability stable
   */
  loadTile(params: TileParams): Promise<TileData<ImageBitmap>>;

  /** @stability stable */
  cancelTile(params: TileParams): void;

  /** 获取解析后的 Capabilities @stability experimental */
  getCapabilities(): WMTSCapabilities | null;

  /** 运行时切换维度值 @stability experimental */
  setDimension(name: string, value: string): void;
}

export function createWMTSSource(options: WMTSSourceOptions): WMTSSource;
```

### 1.4 对接 / 错误 / 常量

```
对接：
  SourceContext.requestScheduler — 请求调度（优先级/并发/退避）
  SourceContext.workerPool — 无（WMTS 瓦片是图像，不需要 Worker 解码）
  InternalBus 'source:tile-loaded' / 'source:error'
  createImageBitmap(blob) — 图像解码（主线程，浏览器原生异步）

错误：
  | Capabilities XML 解析失败 | DATA_TILE_LOAD | throw GeoForgeError 附带 URL |
  | layer 不在 Capabilities 中 | CONFIG_INVALID_PARAM | throw GeoForgeError 列出可用 layers |
  | matrixSet 不在 Capabilities 中 | CONFIG_INVALID_PARAM | throw GeoForgeError 列出可用 matrixSets |
  | 瓦片 404 | DATA_TILE_LOAD | ErrorRecovery 不重试（永久缺失）|
  | 瓦片 500/503 | DATA_TILE_LOAD | ErrorRecovery 指数退避重试 3 次 |
  | createImageBitmap 失败 | DATA_TILE_DECODE | 标记失败，使用 placeholder |
  | dimension 名称不存在 | CONFIG_INVALID_PARAM | if(__DEV__) warn 列出可用 dimensions |

常量：
  OGC_PIXEL_SIZE = 0.00028            // OGC 标准像素尺寸 0.28mm（米）
  DEFAULT_TILE_FORMAT = 'image/png'
  DEFAULT_STYLE = 'default'
  WMTS_VERSION = '1.0.0'
  CAPABILITIES_TIMEOUT_MS = 10000
```

---

## 2. @geoforge/source-wms

### 2.1 WMSSourceOptions

```typescript
export interface WMSSourceOptions {
  /** WMS 服务端点 URL */
  readonly url: string;

  /** 图层名称（多个用逗号分隔） */
  readonly layers: string;

  /** WMS 版本 @default '1.3.0' */
  readonly version?: '1.1.1' | '1.3.0';

  /** 坐标参考系 @default 'EPSG:3857' */
  readonly crs?: string;

  /** 图像格式 @default 'image/png' */
  readonly format?: string;

  /** 是否透明 @default true */
  readonly transparent?: boolean;

  /** 样式名称（多个用逗号分隔）@default '' */
  readonly styles?: string;

  /** 瓦片化请求的瓦片尺寸 @default 256 */
  readonly tileSize?: 256 | 512;

  /** 额外请求参数 @example { CQL_FILTER: 'population > 1000000' } */
  readonly customParams?: Record<string, string>;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;
}
```

### 2.2 WMSCapabilities

```typescript
export interface WMSCapabilities {
  readonly title: string;
  readonly layers: ReadonlyArray<{
    readonly name: string;
    readonly title: string;
    readonly crs: ReadonlyArray<string>;
    readonly bbox: BBox2D;
    readonly queryable: boolean;
    readonly styles: ReadonlyArray<{ name: string; title: string }>;
    readonly minScale?: number;
    readonly maxScale?: number;
  }>;
  readonly formats: ReadonlyArray<string>;
  readonly version: string;
}
```

### 2.3 WMSSource 接口

```typescript
export interface WMSSource extends DataSource<ImageBitmap> {
  readonly type: 'wms';

  /**
   * 初始化。
   * 步骤：
   *   1. 可选：fetch GetCapabilities → 验证 layers/crs 存在
   *   2. 构建 GetMap URL 模板
   *
   * @stability stable
   */
  initialize(context: SourceContext): Promise<void>;
  destroy(): void;
  getMetadata(): Promise<SourceMetadata>;

  /**
   * 加载瓦片。
   * WMS 不是原生瓦片服务，需要将 GeoForge 的 TileCoord → BBox → GetMap 请求。
   *
   * GetMap URL 构建：
   *   baseUrl + ?SERVICE=WMS
   *   &VERSION={version}
   *   &REQUEST=GetMap
   *   &LAYERS={layers}
   *   &STYLES={styles}
   *   &CRS={crs}  (1.3.0) 或 &SRS={crs}  (1.1.1)
   *   &BBOX={bbox}
   *   &WIDTH={tileSize}
   *   &HEIGHT={tileSize}
   *   &FORMAT={format}
   *   &TRANSPARENT={transparent}
   *   + customParams
   *
   * BBOX 轴序问题（关键陷阱！）：
   *   WMS 1.1.1：BBOX 始终是 minx,miny,maxx,maxy（经度在前）
   *   WMS 1.3.0：BBOX 轴序取决于 CRS 定义
   *     EPSG:4326 → lat,lon（纬度在前！）：BBOX=south,west,north,east
   *     EPSG:3857 → x,y（经度/米在前）：BBOX=west,south,east,north
   *   GeoForge 内部始终用 [west, south, east, north]，
   *   WMS 1.3.0 + EPSG:4326 时需要翻转为 [south, west, north, east]。
   *
   * TileCoord → BBox 转换：
   *   if (crs === 'EPSG:3857')
   *     bbox = mercator.tileToBBox(x, y, z)  // 墨卡托米坐标
   *   else if (crs === 'EPSG:4326')
   *     bbox = mercator.tileToLngLatBBox(x, y, z)  // 经纬度
   *   else
   *     需要通过 CRS 注册表做坐标转换
   *
   * @stability stable
   */
  loadTile(params: TileParams): Promise<TileData<ImageBitmap>>;
  cancelTile(params: TileParams): void;

  /**
   * GetFeatureInfo 查询（点击查询要素属性）。
   *
   * URL 构建（在 GetMap 基础上追加）：
   *   &REQUEST=GetFeatureInfo
   *   &QUERY_LAYERS={layers}
   *   &INFO_FORMAT=application/json
   *   &I={pixelX}  (1.3.0) 或 &X={pixelX}  (1.1.1)
   *   &J={pixelY}  (1.3.0) 或 &Y={pixelY}  (1.1.1)
   *   &FEATURE_COUNT=10
   *
   * @param lon - 查询经度
   * @param lat - 查询纬度
   * @param zoom - 当前 zoom（用于构建等效 GetMap 范围）
   * @returns 要素属性 JSON
   *
   * @stability experimental
   */
  getFeatureInfo(lon: number, lat: number, zoom: number): Promise<any>;

  /** @stability experimental */
  getCapabilities(): WMSCapabilities | null;
}

export function createWMSSource(options: WMSSourceOptions): WMSSource;
```

### 2.4 对接 / 错误

```
对接：同 WMTS + 额外 CRS 坐标转换（L0/infra/coordinate.transform）

错误：
  | BBOX 轴序错误（图像偏移）| — | 自动检测 CRS 轴序 + if(__DEV__) 日志输出实际 BBOX |
  | GetFeatureInfo 返回非 JSON | — | 尝试解析为 XML/HTML + log.warn |
  | WMS 1.3.0 不支持 GetCapabilities | — | 跳过验证，直接构建 GetMap |
  | layers 中有不存在的图层 | CONFIG_INVALID_PARAM | throw（如果有 Capabilities） / warn（无 Capabilities） |
```

---

## 3. @geoforge/source-wfs

### 3.1 WFSSourceOptions

```typescript
export interface WFSSourceOptions {
  /** WFS 服务端点 URL */
  readonly url: string;

  /** 要素类型名称 */
  readonly typeName: string;

  /** WFS 版本 @default '2.0.0' */
  readonly version?: '1.1.0' | '2.0.0';

  /** 输出格式 @default 'application/json'（GeoJSON） */
  readonly outputFormat?: 'application/json' | 'application/gml+xml';

  /** 坐标参考系 @default 'EPSG:4326' */
  readonly srsName?: string;

  /** 最大要素数量限制 @range [1, 100000] @default 10000 */
  readonly maxFeatures?: number;

  /** CQL 过滤器表达式 @example "population > 1000000 AND continent = 'Asia'" */
  readonly cqlFilter?: string;

  /** 属性字段过滤（只请求需要的字段，减少传输量）*/
  readonly propertyNames?: string[];

  /** 分页大小（大数据集分批加载）@default 1000 */
  readonly pageSize?: number;

  /** 自定义请求头 */
  readonly headers?: Record<string, string>;

  /**
   * 数据加载策略。
   * 'bbox':    按可视范围加载（每次视口变化重新请求）
   * 'all':     一次加载全部数据（适合小数据集）
   * @default 'bbox'
   */
  readonly strategy?: 'bbox' | 'all';
}
```

### 3.2 WFSSource 接口

```typescript
export interface WFSSource extends DataSource<Feature[]> {
  readonly type: 'wfs';

  /**
   * 初始化。
   * 步骤：
   *   1. 可选：DescribeFeatureType → 获取属性 schema
   *   2. 如果 strategy='all'：立即加载全部数据
   *   3. 如果 strategy='bbox'：等待首次 loadFeatures 调用
   *
   * @stability stable
   */
  initialize(context: SourceContext): Promise<void>;
  destroy(): void;
  getMetadata(): Promise<SourceMetadata>;

  /**
   * 按范围加载要素。
   *
   * GetFeature URL 构建：
   *   ?SERVICE=WFS
   *   &VERSION={version}
   *   &REQUEST=GetFeature
   *   &TYPENAMES={typeName}  (2.0.0) 或 &TYPENAME={typeName}  (1.1.0)
   *   &OUTPUTFORMAT={outputFormat}
   *   &SRSNAME={srsName}
   *   &BBOX={south},{west},{north},{east},{srsName}
   *   &COUNT={maxFeatures}  (2.0.0) 或 &MAXFEATURES={maxFeatures}  (1.1.0)
   *   &CQL_FILTER={cqlFilter}（如果有）
   *   &PROPERTYNAME={propertyNames.join(',')}（如果有）
   *   &STARTINDEX={offset}（分页）
   *
   * GML 解析（如果 outputFormat 不是 JSON）：
   *   1. DOMParser 解析 XML
   *   2. 遍历 gml:featureMember / wfs:member
   *   3. 提取几何：gml:Point → [x,y] / gml:LineString → [[x,y],...] / gml:Polygon → [[[x,y],...],...])
   *   4. 提取属性：遍历子元素 name → value
   *   5. 注意 GML 坐标轴序（同 WMS BBOX 问题）
   *
   * 分页加载：
   *   if (features.length === pageSize)
   *     // 可能还有更多数据
   *     递归 loadFeatures(extent, zoom, startIndex + pageSize)
   *     合并结果
   *   直到返回数量 < pageSize 或达到 maxFeatures
   *
   * 缓存策略（strategy='bbox'）：
   *   缓存 key = hash(extent + cqlFilter + zoom)
   *   如果新请求的 extent 完全在已缓存 extent 内 → 跳过请求，从缓存过滤
   *   否则请求差异区域（如果服务器支持）或全量重新请求
   *
   * @stability stable
   */
  loadFeatures(extent: BBox2D, zoom: number, signal?: AbortSignal): Promise<Feature[]>;

  /**
   * DescribeFeatureType 查询。
   * 获取要素类型的属性 schema（字段名→类型映射）。
   *
   * URL：?SERVICE=WFS&REQUEST=DescribeFeatureType&TYPENAMES={typeName}&OUTPUTFORMAT=application/json
   *
   * @returns { fieldName: 'string' | 'number' | 'boolean' | 'geometry', ... }
   * @stability experimental
   */
  describeFeatureType(): Promise<Record<string, string>>;

  /**
   * 运行时设置/更新 CQL 过滤器。
   * 设置后清除缓存并触发重新加载。
   *
   * @stability experimental
   */
  setCQLFilter(filter: string | null): void;
}

export function createWFSSource(options: WFSSourceOptions): WFSSource;
```

### 3.3 对接 / 错误

```
对接：
  SourceContext.requestScheduler — 分页请求调度
  L0/infra/coordinate — CRS 坐标转换（GML 坐标 → WGS84）
  GeoJSONLayer — WFS 返回的 GeoJSON 直接交给 GeoJSONLayer 渲染
  InternalBus 'source:features-loaded' / 'source:error'
  PerformanceManager：数据量 > 50000 要素时 warn 建议使用矢量瓦片

错误：
  | GetFeature 返回错误 XML（ExceptionReport） | DATA_TILE_LOAD | 解析 ExceptionText + throw |
  | GML 几何类型不支持（3D Solid 等） | DATA_TILE_DECODE | 跳过该要素 + warn |
  | 分页请求无限循环（服务器不支持 STARTINDEX） | — | 最大请求 10 页后停止 |
  | CQL 语法错误 | DATA_TILE_LOAD | 服务器返回 400 → throw 附带 CQL 表达式 |
  | GML 坐标轴序错误 | — | 自动检测（如果坐标超出 [-180,180] 范围则翻转）+ warn |

常量：
  DEFAULT_WFS_VERSION = '2.0.0'
  DEFAULT_OUTPUT_FORMAT = 'application/json'
  DEFAULT_SRS = 'EPSG:4326'
  DEFAULT_MAX_FEATURES = 10000
  DEFAULT_PAGE_SIZE = 1000
  MAX_PAGES = 10
  BBOX_CACHE_MARGIN = 0.2          // 缓存范围扩展 20%（减少频繁重新请求）
```

---

## 4. @geoforge/source-pmtiles

### 4.1 PMTilesSourceOptions

```typescript
export interface PMTilesSourceOptions {
  /** PMTiles 文件 URL */
  readonly url: string;

  /**
   * 覆盖自动检测的瓦片类型。
   * PMTiles header 包含 tileType 字段，但可能不准确。
   * @default 自动检测
   */
  readonly tileType?: 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'pbf';

  /** 自定义请求头（如 CDN 认证） */
  readonly headers?: Record<string, string>;

  /**
   * 目录缓存大小（条目数）。
   * PMTiles 有多级目录，叶子目录按需加载后缓存。
   * @range [16, 4096]
   * @default 512
   */
  readonly directoryCacheSize?: number;
}
```

### 4.2 内部数据结构

```typescript
/**
 * PMTiles v3 Header（127 字节）。
 */
export interface PMTilesHeader {
  readonly version: number;                  // 3
  readonly rootDirectoryOffset: number;      // 根目录在文件中的偏移
  readonly rootDirectoryLength: number;
  readonly jsonMetadataOffset: number;
  readonly jsonMetadataLength: number;
  readonly leafDirectoryOffset: number;
  readonly leafDirectoryLength: number;
  readonly tileDataOffset: number;
  readonly tileDataLength: number;
  readonly numAddressedTiles: number;
  readonly numTileEntries: number;
  readonly numTileContents: number;
  readonly clustered: boolean;
  readonly internalCompression: PMTilesCompression;
  readonly tileCompression: PMTilesCompression;
  readonly tileType: PMTilesTileType;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds: BBox2D;                   // [minLon, minLat, maxLon, maxLat]
  readonly center: [number, number, number]; // [lon, lat, zoom]
}

type PMTilesCompression = 'none' | 'gzip' | 'brotli' | 'zstd';
type PMTilesTileType = 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'unknown';

/**
 * PMTiles 目录条目。
 */
interface PMTilesEntry {
  readonly tileId: number;     // Hilbert 曲线编码的瓦片 ID
  readonly offset: number;     // 瓦片数据在文件中的偏移
  readonly length: number;     // 瓦片数据长度（字节）
  readonly runLength: number;  // 连续相同内容的瓦片数（去重）
}
```

### 4.3 PMTilesSource 接口

```typescript
export interface PMTilesSource extends DataSource {
  readonly type: 'pmtiles';

  /**
   * 初始化。
   * 步骤：
   *   1. HTTP Range Request 读取 Header（前 127 字节）：
   *      fetch(url, { headers: { Range: 'bytes=0-126' } })
   *   2. 解析 Header → PMTilesHeader
   *   3. 读取 Root Directory：
   *      fetch(url, { headers: { Range: `bytes=${rootOffset}-${rootOffset+rootLength-1}` } })
   *   4. 解码 Root Directory（可能 gzip 压缩）→ PMTilesEntry[]
   *   5. Root Directory 缓存到内存
   *   6. 读取 JSON Metadata（可选，包含 attribution/description 等）
   *
   * PMTiles v3 目录结构：
   *   Root Directory: 覆盖所有 zoom 级别的顶层索引
   *   Leaf Directory: 如果 Root Directory 条目指向 leafDirectoryOffset 范围内，
   *                   则该条目是 Leaf Directory 的引用（非瓦片数据）
   *   大文件（>100万瓦片）会有多级 Leaf Directory
   *
   * @stability stable
   * @throws GeoForgeError(DATA_TILE_LOAD) 如果 HTTP Range Request 不支持
   */
  initialize(context: SourceContext): Promise<void>;
  destroy(): void;
  getMetadata(): Promise<SourceMetadata>;

  /**
   * 加载瓦片。
   *
   * 查找算法：
   *   1. 计算 Hilbert tileId = hilbertXYZToId(z, x, y)
   *      Hilbert 曲线将 2D 瓦片坐标映射为 1D 整数，保持空间局部性
   *   2. 在 Root Directory 中二分搜索 tileId
   *      a. 找到精确匹配 → entry.offset + entry.length 指向瓦片数据
   *      b. 找到 runLength > 1 的条目且 tileId 在范围内 → 同一数据（去重）
   *      c. 找到 Leaf Directory 引用 → 加载 Leaf Directory → 再次搜索
   *      d. 未找到 → 瓦片不存在（返回空/透明）
   *
   *   3. HTTP Range Request 读取瓦片数据：
   *      fetch(url, { headers: { Range: `bytes=${offset}-${offset+length-1}` } })
   *
   *   4. 解压（如果 tileCompression !== 'none'）：
   *      'gzip': DecompressionStream('gzip')（浏览器原生）
   *      'zstd': 需要 zstd-wasm 解码（在 Worker 中执行）
   *      'brotli': DecompressionStream('brotli')
   *
   *   5. 根据 tileType 后续处理：
   *      'mvt' / 'pbf' → 返回 ArrayBuffer（由 VectorTileLayer Worker 解码）
   *      'png'/'jpg'/'webp'/'avif' → createImageBitmap(blob) → ImageBitmap
   *
   * Hilbert 曲线编码/解码：
   *   tileId = hilbertXYToD(n, x, y)  // n = 2^z
   *   其中 hilbertXYToD 是标准 Hilbert 曲线算法（位操作实现）
   *   PMTiles v3 使用的具体编码：
   *     level = z
   *     pos = hilbert2d(x, y, level)
   *     tileId = Σ(4^i for i=0..level-1) + pos
   *     // 每个 zoom 级别的 tileId 范围不重叠
   *
   * @stability stable
   */
  loadTile(params: TileParams): Promise<TileData>;
  cancelTile(params: TileParams): void;

  /** 获取 Header 信息 @stability stable */
  getHeader(): PMTilesHeader | null;

  /** 获取 JSON Metadata @stability experimental */
  getJSONMetadata(): Record<string, any> | null;
}

export function createPMTilesSource(options: PMTilesSourceOptions): PMTilesSource;
```

### 4.4 对接 / 错误 / 常量

```
对接：
  SourceContext.requestScheduler — Range Request 调度
  SourceContext.workerPool — zstd 解压（如果需要）
  VectorTileLayer / RasterTileLayer — 根据 tileType 自动对接
  同一 PMTiles 文件的多个图层共享 Directory 缓存（通过 SourceManager 共享实例）

错误：
  | HTTP Range Request 不支持（服务器返回 200 而非 206） | DATA_TILE_LOAD | throw + 建议用户检查 CDN 配置 |
  | Header 解析失败（非 PMTiles 文件） | DATA_TILE_DECODE | throw 附带前 16 字节 hex dump |
  | PMTiles 版本不是 3 | DATA_TILE_DECODE | throw（仅支持 v3） |
  | Leaf Directory 加载失败 | DATA_TILE_LOAD | ErrorRecovery 重试 2 次 |
  | zstd 解压失败 | DATA_TILE_DECODE | 尝试无解压直接解析 + warn |
  | tileId 超出 Directory 范围 | — | 返回空瓦片（正常：该位置无数据） |

常量：
  PMTILES_HEADER_SIZE = 127             // 字节
  PMTILES_MAGIC = [0x50, 0x4D]          // "PM" ASCII
  PMTILES_VERSION = 3
  DEFAULT_DIRECTORY_CACHE = 512
  MAX_LEAF_DIRECTORY_DEPTH = 4          // 最大目录嵌套层级（防无限递归）
```

---

## P3 数据源包统计

| 包 | 公共方法 | 协议特殊处理 | 对接模块 | 错误场景 |
|---|---------|------------|---------|---------|
| source-wmts | 6 | TileMatrix→zoom 映射 / 维度参数 / RESTful 模板 | 3 | 7 |
| source-wms | 7 | BBOX 轴序 / GetFeatureInfo / 瓦片化 | 4 | 5 |
| source-wfs | 6 | GML 解析 / 分页 / CQL 过滤 / 缓存策略 | 4 | 5 |
| source-pmtiles | 5 | Hilbert 曲线 / Range Request / 多级目录 / 去重 | 3 | 6 |
