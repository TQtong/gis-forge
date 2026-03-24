# GeoForge L0 基础层完整设计 — 零依赖，全部自研

> **核心原则**：不使用任何第三方库。数学运算、坐标转换、投影算法、三角函数、矩阵分解全部自己实现。
> 这是引擎的根基，必须完全自主可控。
>
> **v2.1 修订**：新增 `types/` 共享类型模块，统一 Feature、GeoJSON、Viewport、CameraState、PickResult、StyleSpec 等全局类型定义，消除跨层不一致。

---

## 设计总则

1. **零 npm 依赖**：L0 不 import 任何外部包
2. **TypedArray 优先**：所有向量/矩阵内部用 Float32Array 或 Float64Array，不用 JS Object/Array（避免 GC 压力，利于 GPU 上传）
3. **out 参数模式**：所有运算函数采用 `fn(out, a, b)` 模式，调用方预分配结果容器，避免每次运算分配新对象
4. **Float32 + Float64 双版本**：向量/矩阵同时提供 f32（GPU 传输用）和 f64（CPU 精确计算用）版本
5. **内联友好**：关键函数足够短小，方便 V8 JIT 内联优化
6. **WGSL 对齐**：数据布局与 WGSL 的 `vec3<f32>`、`mat4x4<f32>` 内存布局完全对齐，CPU→GPU 零拷贝
7. **共享类型定义权威源**：Feature、BBox2D、Viewport、CameraState、PickResult 等全局共享类型**只在 L0 定义一次**，上层全部从 `@geoforge/core` import

---

## 模块清单（v2.1）

| 模块 | 文件 | 职责 |
|------|------|------|
| **math/vec2** | `math/vec2.ts` | 2D 向量运算 |
| **math/vec3** | `math/vec3.ts` | 3D 向量运算 |
| **math/vec4** | `math/vec4.ts` | 4D 向量 / 齐次坐标 / 四元数存储 |
| **math/mat3** | `math/mat3.ts` | 3x3 矩阵（法线变换、2D 仿射） |
| **math/mat4** | `math/mat4.ts` | 4x4 矩阵（MVP、投影、视图） |
| **math/quat** | `math/quat.ts` | 四元数（旋转、球面插值 slerp） |
| **math/bbox** | `math/bbox.ts` | 2D/3D 包围盒 |
| **math/frustum** | `math/frustum.ts` | 视锥体（6 平面提取 + 相交测试） |
| **math/interpolate** | `math/interpolate.ts` | 插值函数（线性、smoothstep、贝塞尔、Hermite） |
| **math/trigonometry** | `math/trigonometry.ts` | 三角函数工具（度/弧度转换、atan2 包装、角度归一化） |
| **math/ellipsoid** | `math/ellipsoid.ts` | WGS84 椭球体计算（经纬度↔ECEF、法线、大地测量距离） |
| **math/mercator** | `math/mercator.ts` | 墨卡托投影数学（经纬度↔米、瓦片坐标↔经纬度） |
| **math/earcut** | `math/earcut.ts` | 自研 earcut 三角剖分算法 |
| **math/douglas-peucker** | `math/douglas-peucker.ts` | 自研线简化算法 |
| **math/spatial-hash** | `math/spatial-hash.ts` | 空间哈希网格（碰撞检测粗筛） |
| **math/rtree** | `math/rtree.ts` | R-Tree 空间索引（点/矩形查询） |
| **types/geometry** | `types/geometry.ts` | GeoJSON 几何类型 |
| **types/feature** | `types/feature.ts` | Feature / FeatureCollection |
| **types/viewport** | `types/viewport.ts` | Viewport / CameraState / PickResult |
| **types/style-spec** | `types/style-spec.ts` | StyleSpec / LayerSpec / SourceSpec / StyleExpression |
| **types/tile** | `types/tile.ts` | TileCoord / TileData / TileParams |
| **types/events** | `types/events.ts` | MapEventType / MapPointerEvent / FlyToOptions / AnimationOptions |
| **coordinate** | `coordinate.ts` | CRS 注册表 + 坐标转换管线 |
| **projection** | `projection.ts` | 投影模块接口定义 |
| **precision** | `precision.ts` | Split-Double + RTC |
| **event** | `event.ts` | 事件总线 |
| **id** | `id.ts` | ID 生成器 |
| **logger** | `logger.ts` | 日志系统 |
| **config** | `config.ts` | 全局配置 |

**共 29 个模块**（16 个自研数学/算法模块 + 6 个共享类型模块 + 7 个基础设施模块），零外部依赖。

> ⚠️ **跨层类型唯一真相源**：以下类型在 L0/types/ 中定义，L1~L6 全部从此处 import，不重复定义：
> `BBox2D` / `BBox3D` / `Feature` / `FeatureCollection` / `Geometry` / `Viewport` / `CameraState` / `PickResult` / `TileCoord` / `TileParams` / `TileData` / `StyleSpec` / `StyleExpression` / `FilterExpression` / `MapEventType` / `MapPointerEvent`

---

## 数学核心：数据布局与双精度设计

### 内存布局原则

```typescript
// ============================================================
// 所有向量/矩阵底层都是 TypedArray
// 好处：1) 零 GC 压力  2) 直传 GPU Buffer  3) Worker transferable
// ============================================================

// Float32 版本 — 用于 GPU 上传（与 WGSL 对齐）
export type Vec2f = Float32Array;   // 长度 2
export type Vec3f = Float32Array;   // 长度 3（注意：WGSL vec3 在 uniform 中对齐到 16 字节）
export type Vec4f = Float32Array;   // 长度 4
export type Mat3f = Float32Array;   // 长度 9（列主序 column-major）
export type Mat4f = Float32Array;   // 长度 16（列主序 column-major）
export type Quatf = Float32Array;   // 长度 4 [x, y, z, w]

// Float64 版本 — 用于 CPU 精确计算（坐标转换、大地测量）
export type Vec2d = Float64Array;   // 长度 2
export type Vec3d = Float64Array;   // 长度 3
export type Vec4d = Float64Array;   // 长度 4
export type Mat4d = Float64Array;   // 长度 16

// 矩阵存储顺序：列主序（Column-Major），与 WGSL mat4x4<f32> 一致
// 索引映射：
//   | m[0]  m[4]  m[8]   m[12] |     | c0r0 c1r0 c2r0 c3r0 |
//   | m[1]  m[5]  m[9]   m[13] |  =  | c0r1 c1r1 c2r1 c3r1 |
//   | m[2]  m[6]  m[10]  m[14] |     | c0r2 c1r2 c2r2 c3r2 |
//   | m[3]  m[7]  m[11]  m[15] |     | c0r3 c1r3 c2r3 c3r3 |
```

---

## types/ — 全局共享类型定义

> **设计决策**：以下类型在 L1~L6 的多个模块中被引用。审计发现它们之前分散在各层各自定义，导致字段名/方法签名不一致。现在全部归入 L0/types/ 作为唯一定义源（Single Source of Truth），上层统一从 `@geoforge/core` import。

### types/geometry.ts — GeoJSON 几何类型

```typescript
// ============================================================
// types/geometry.ts — GeoJSON 几何类型（RFC 7946 兼容）
// 被引用于：L4/SpatialQuery, L4/AntiMeridianHandler, L5/DataSource, L6/queryRenderedFeatures
// ============================================================

export type GeometryType =
  | 'Point' | 'MultiPoint'
  | 'LineString' | 'MultiLineString'
  | 'Polygon' | 'MultiPolygon'
  | 'GeometryCollection';

export interface PointGeometry {
  readonly type: 'Point';
  readonly coordinates: [number, number] | [number, number, number];  // [lon, lat] or [lon, lat, alt]
}

export interface LineStringGeometry {
  readonly type: 'LineString';
  readonly coordinates: number[][];            // [[lon, lat], ...]
}

export interface PolygonGeometry {
  readonly type: 'Polygon';
  readonly coordinates: number[][][];          // [[[lon, lat], ...], ...]  外环 + 内环
}

export interface MultiPointGeometry {
  readonly type: 'MultiPoint';
  readonly coordinates: number[][];
}

export interface MultiLineStringGeometry {
  readonly type: 'MultiLineString';
  readonly coordinates: number[][][];
}

export interface MultiPolygonGeometry {
  readonly type: 'MultiPolygon';
  readonly coordinates: number[][][][];
}

export interface GeometryCollection {
  readonly type: 'GeometryCollection';
  readonly geometries: Geometry[];
}

export type Geometry =
  | PointGeometry | MultiPointGeometry
  | LineStringGeometry | MultiLineStringGeometry
  | PolygonGeometry | MultiPolygonGeometry
  | GeometryCollection;
```

### types/feature.ts — Feature 与 FeatureCollection

```typescript
// ============================================================
// types/feature.ts — GeoJSON Feature 类型
// 被引用于：L4/SpatialQuery, L4/FeatureStateManager, L4/AntiMeridianHandler,
//          L4/StyleEngine, L5/MapPointerEvent, L6/queryRenderedFeatures
// 这是审计报告不一致 #4 的修复——Feature 类型之前从未统一定义
// ============================================================

export interface Feature<G extends Geometry = Geometry, P = Record<string, any>> {
  readonly type: 'Feature';
  readonly id?: string | number;
  readonly geometry: G;
  readonly properties: P;

  // 引擎运行时附加字段（非 GeoJSON 标准，由引擎内部填充）
  readonly _sourceId?: string;                 // 来自哪个数据源
  readonly _layerId?: string;                  // 当前归属图层
  readonly _tileCoord?: TileCoord;             // 来自哪个瓦片
  readonly _state?: Record<string, any>;       // FeatureStateManager 中的状态
}

export interface FeatureCollection<G extends Geometry = Geometry, P = Record<string, any>> {
  readonly type: 'FeatureCollection';
  readonly features: Feature<G, P>[];
}
```

### types/viewport.ts — Viewport / CameraState / PickResult

```typescript
// ============================================================
// types/viewport.ts — 视口、相机状态、拾取结果
// 被引用于：L1/SurfaceManager, L2/PickingEngine, L2/FrameGraphBuilder,
//          L3/TileScheduler, L3/FrameScheduler, L4/LabelManager,
//          L5/CustomLayer, L5/InteractionTool, L6/Map2D/Globe3D
//
// 修复审计报告不一致 #3(CameraState), #6(PickResult), #7(Viewport)
// ============================================================

// --- Viewport（唯一定义）---
export interface Viewport {
  readonly width: number;                      // 逻辑宽度（CSS 像素）
  readonly height: number;                     // 逻辑高度（CSS 像素）
  readonly physicalWidth: number;              // 物理宽度（逻辑 × DPR）
  readonly physicalHeight: number;             // 物理高度（逻辑 × DPR）
  readonly pixelRatio: number;                 // 设备像素比
}

// --- CameraState（唯一定义，修复审计不一致 #3）---
// 注意：统一使用 bearing（不用 heading），pitch 角度统一为弧度
export interface CameraState {
  // 地理位置
  readonly center: [number, number];           // [lon, lat] 度
  readonly zoom: number;
  readonly bearing: number;                    // 旋转角（弧度），0 = 正北
  readonly pitch: number;                      // 俯仰角（弧度），0 = 正俯视

  // 矩阵（每帧由 CameraController 计算，只读快照）
  readonly viewMatrix: Mat4f;
  readonly projectionMatrix: Mat4f;
  readonly vpMatrix: Mat4f;                    // view × projection
  readonly inverseVPMatrix: Mat4f;

  // 3D 空间信息
  readonly position: Vec3f;                    // 相机世界坐标（ECEF 或投影坐标）
  readonly altitude: number;                   // 相机高度（米）
  readonly fov: number;                        // 视场角（弧度）

  // 便捷属性
  readonly roll: number;                       // 翻滚角（弧度），通常为 0
}

// --- PickResult（唯一定义，修复审计不一致 #6）---
export interface PickResult {
  readonly featureId: string | number | null;
  readonly layerId: string;
  readonly sourceId: string;
  readonly coordinates: [number, number] | [number, number, number];
  readonly screenPosition: [number, number];
  readonly properties?: Record<string, any>;

  // 深度信息（3D 模式下可用）
  readonly depth: number;                      // 归一化深度值 [0,1]
  readonly worldPosition?: Vec3f;              // 从深度反算的 3D 世界坐标
  readonly normal?: Vec3f;                     // 表面法线（如果可用）
}
```

### types/tile.ts — 瓦片相关类型

```typescript
// ============================================================
// types/tile.ts — 瓦片坐标、参数、数据
// 被引用于：L3/TileScheduler, L4/SourceManager, L5/DataSource
// 修复审计不一致 #5（BBox2D 位置冲突——此处明确 BBox2D 定义在 L0/math/bbox.ts）
// ============================================================

// TileCoord 统一使用此定义
export interface TileCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;                          // zoom level
}

// 瓦片请求参数
export interface TileParams {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly extent: BBox2D;                     // BBox2D 来自 L0/math/bbox.ts
  readonly signal: AbortSignal;
}

// 瓦片数据
export interface TileData<T = any> {
  readonly data: T;
  readonly extent: BBox2D;
  readonly transferables?: Transferable[];
  readonly byteSize?: number;
  readonly expiresAt?: number;                 // 缓存过期时间戳
}

// 瓦片状态
export type TileState = 'empty' | 'loading' | 'loaded' | 'error' | 'cached';
```

### types/style-spec.ts — 样式规范类型

```typescript
// ============================================================
// types/style-spec.ts — 样式规范（StyleSpec）顶层结构
// 被引用于：L4/StyleEngine, L6/Map2D.setStyle()
// 修复审计缺口 #5（StyleSpec 未定义）
// ============================================================

export interface StyleSpec {
  readonly version: 8;                         // 样式版本（对标 MapLibre Style Spec v8）
  readonly name?: string;
  readonly metadata?: Record<string, any>;

  // 数据源
  readonly sources: Record<string, SourceSpec>;

  // 图层（按渲染顺序）
  readonly layers: LayerStyleSpec[];

  // 字形
  readonly glyphs?: string;                    // URL 模板，如 "{fontstack}/{range}.pbf"

  // 精灵图
  readonly sprite?: string;                    // Sprite 图集 URL 前缀

  // 全局属性
  readonly center?: [number, number];
  readonly zoom?: number;
  readonly bearing?: number;
  readonly pitch?: number;
  readonly light?: LightSpec;
}

export interface SourceSpec {
  readonly type: 'vector' | 'raster' | 'raster-dem' | 'geojson' | 'image' | 'video' | '3dtiles' | string;
  readonly url?: string;
  readonly urls?: string[];
  readonly tiles?: string[];
  readonly data?: object;                      // 内嵌 GeoJSON
  readonly tileSize?: number;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly bounds?: [number, number, number, number];  // [west, south, east, north]
  readonly attribution?: string;
  readonly scheme?: 'xyz' | 'tms';
  readonly encoding?: 'mapbox' | 'terrarium';
  readonly promoteId?: string;
}

export interface LayerStyleSpec {
  readonly id: string;
  readonly type: 'fill' | 'line' | 'symbol' | 'circle' | 'heatmap' | 'fill-extrusion' | 'raster' | 'hillshade' | 'background' | 'sky' | string;
  readonly source?: string;
  readonly 'source-layer'?: string;
  readonly filter?: FilterExpression;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly layout?: Record<string, any>;
  readonly paint?: Record<string, any>;
  readonly metadata?: Record<string, any>;
}

export interface LightSpec {
  readonly anchor?: 'map' | 'viewport';
  readonly color?: string;
  readonly intensity?: number;
  readonly position?: [number, number, number];
}

// 样式表达式（从 L4/StyleEngine 提升到 L0 共享类型）
export type StyleExpression =
  | number | string | boolean
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
  | ['match', StyleExpression, ...any[]]
  | ['interpolate', InterpolationType, StyleExpression, ...any[]]
  | ['step', StyleExpression, any, ...any[]]
  | ['zoom']
  | ['coalesce', ...StyleExpression[]];

export type InterpolationType = ['linear'] | ['exponential', number] | ['cubic-bezier', number, number, number, number];

export type FilterExpression = StyleExpression;
```

### types/events.ts — 地图事件与动画选项

```typescript
// ============================================================
// types/events.ts — 地图事件类型、指针事件、动画选项
// 被引用于：L5/InteractionTool, L5/MapPointerEvent, L6/Map2D, L6/Globe3D
// ============================================================

// ===== 地图事件 =====

export type MapEventType =
  | 'click' | 'dblclick' | 'contextmenu'
  | 'mousedown' | 'mouseup' | 'mousemove'
  | 'mouseenter' | 'mouseleave'
  | 'touchstart' | 'touchend' | 'touchmove'
  | 'wheel'
  | 'movestart' | 'move' | 'moveend'
  | 'zoomstart' | 'zoom' | 'zoomend'
  | 'rotatestart' | 'rotate' | 'rotateend'
  | 'pitchstart' | 'pitch' | 'pitchend'
  | 'load' | 'idle' | 'resize' | 'remove'
  | 'data' | 'sourcedata' | 'tiledata' | 'error'
  | 'render' | 'prerender' | 'postrender';

export interface MapPointerEvent {
  readonly type: MapEventType;
  readonly screenX: number;
  readonly screenY: number;
  readonly lngLat: [number, number];
  readonly altitude?: number;
  readonly features: PickResult[];
  readonly originalEvent: PointerEvent;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

// ===== 动画选项 =====

export interface FlyToOptions {
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  duration?: number;
  easing?: (t: number) => number;
  curve?: number;
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface AnimationOptions {
  duration?: number;
  easing?: (t: number) => number;
}

// ===== 日志级别 =====

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
```

---

## 包围盒类型定义（math/bbox.ts 导出）

```typescript
// ============================================================
// math/bbox.ts 中定义的包围盒类型
// 唯一定义位置，L1~L6 全部 import 此处
// ============================================================

export interface BBox2D {
  readonly west: number;                       // min lon / min x
  readonly south: number;                      // min lat / min y
  readonly east: number;                       // max lon / max x
  readonly north: number;                      // max lat / max y
}

export interface BBox3D extends BBox2D {
  readonly minAlt: number;
  readonly maxAlt: number;
}
```

---

## Vec3 完整实现规格

```typescript
// ============================================================
// math/vec3.ts — 3D 向量运算（Float32 版本）
// 所有函数采用 out 参数模式，零内存分配
// ============================================================

export function create(x = 0, y = 0, z = 0): Vec3f {
  const out = new Float32Array(3);
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function fromArray(arr: ArrayLike<number>, offset = 0): Vec3f {
  const out = new Float32Array(3);
  out[0] = arr[offset]; out[1] = arr[offset + 1]; out[2] = arr[offset + 2];
  return out;
}

export function copy(out: Vec3f, a: Vec3f): Vec3f {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  return out;
}

export function set(out: Vec3f, x: number, y: number, z: number): Vec3f {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function add(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function scale(out: Vec3f, a: Vec3f, s: number): Vec3f {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

export function dot(a: Vec3f, b: Vec3f): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function length(a: Vec3f): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function squaredLength(a: Vec3f): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function normalize(out: Vec3f, a: Vec3f): Vec3f {
  const len = length(a);
  if (len > 0.000001) {
    const invLen = 1.0 / len;
    out[0] = a[0] * invLen; out[1] = a[1] * invLen; out[2] = a[2] * invLen;
  } else {
    out[0] = 0; out[1] = 0; out[2] = 0;
  }
  return out;
}

export function negate(out: Vec3f, a: Vec3f): Vec3f {
  out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
  return out;
}

export function lerp(out: Vec3f, a: Vec3f, b: Vec3f, t: number): Vec3f {
  out[0] = a[0] + t * (b[0] - a[0]);
  out[1] = a[1] + t * (b[1] - a[1]);
  out[2] = a[2] + t * (b[2] - a[2]);
  return out;
}

export function distance(a: Vec3f, b: Vec3f): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function squaredDistance(a: Vec3f, b: Vec3f): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return dx * dx + dy * dy + dz * dz;
}

export function multiply(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2];
  return out;
}

export function min(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]);
  return out;
}

export function max(out: Vec3f, a: Vec3f, b: Vec3f): Vec3f {
  out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]);
  return out;
}

export function transformMat4(out: Vec3f, a: Vec3f, m: Mat4f): Vec3f {
  const x = a[0], y = a[1], z = a[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1.0;
  out[0] = (m[0] * x + m[4] * y + m[8]  * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9]  * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function transformQuat(out: Vec3f, a: Vec3f, q: Quatf): Vec3f {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ax = a[0], ay = a[1], az = a[2];
  // 使用公式: v' = v + 2 * q.w * (q.xyz × v) + 2 * (q.xyz × (q.xyz × v))
  let uvx = qy * az - qz * ay, uvy = qz * ax - qx * az, uvz = qx * ay - qy * ax;
  let uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  const w2 = 2 * qw;
  uvx *= w2; uvy *= w2; uvz *= w2;
  uuvx *= 2; uuvy *= 2; uuvz *= 2;
  out[0] = ax + uvx + uuvx; out[1] = ay + uvy + uuvy; out[2] = az + uvz + uuvz;
  return out;
}

export function equals(a: Vec3f, b: Vec3f, epsilon = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon
      && Math.abs(a[1] - b[1]) <= epsilon
      && Math.abs(a[2] - b[2]) <= epsilon;
}

// Float64 版本 — 同样的函数签名，但操作 Float64Array
// 通过泛型工厂或独立文件 vec3d.ts 提供
```

---

## Mat4 关键函数实现规格

```typescript
// ============================================================
// math/mat4.ts — 4x4 矩阵（列主序）
// 关键实现：perspective、lookAt、multiply、invert
// ============================================================

export function create(): Mat4f {
  const out = new Float32Array(16);
  out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1; // identity
  return out;
}

export function identity(out: Mat4f): Mat4f {
  out[0]=1; out[1]=0; out[2]=0; out[3]=0;
  out[4]=0; out[5]=1; out[6]=0; out[7]=0;
  out[8]=0; out[9]=0; out[10]=1; out[11]=0;
  out[12]=0; out[13]=0; out[14]=0; out[15]=1;
  return out;
}

export function multiply(out: Mat4f, a: Mat4f, b: Mat4f): Mat4f {
  // 标准 4x4 矩阵乘法，列主序
  // 64 次乘法 + 48 次加法
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
  const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
  const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
  const a30=a[12],a31=a[13],a32=a[14],a33=a[15];

  let b0=b[0],b1=b[1],b2=b[2],b3=b[3];
  out[0]=b0*a00+b1*a10+b2*a20+b3*a30;
  out[1]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[2]=b0*a02+b1*a12+b2*a22+b3*a32;
  out[3]=b0*a03+b1*a13+b2*a23+b3*a33;

  b0=b[4]; b1=b[5]; b2=b[6]; b3=b[7];
  out[4]=b0*a00+b1*a10+b2*a20+b3*a30;
  out[5]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[6]=b0*a02+b1*a12+b2*a22+b3*a32;
  out[7]=b0*a03+b1*a13+b2*a23+b3*a33;

  b0=b[8]; b1=b[9]; b2=b[10]; b3=b[11];
  out[8]=b0*a00+b1*a10+b2*a20+b3*a30;
  out[9]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[10]=b0*a02+b1*a12+b2*a22+b3*a32;
  out[11]=b0*a03+b1*a13+b2*a23+b3*a33;

  b0=b[12]; b1=b[13]; b2=b[14]; b3=b[15];
  out[12]=b0*a00+b1*a10+b2*a20+b3*a30;
  out[13]=b0*a01+b1*a11+b2*a21+b3*a31;
  out[14]=b0*a02+b1*a12+b2*a22+b3*a32;
  out[15]=b0*a03+b1*a13+b2*a23+b3*a33;
  return out;
}

export function invert(out: Mat4f, a: Mat4f): Mat4f | null {
  // 4x4 矩阵求逆（基于伴随矩阵法 Adjugate/Cofactor）
  // 如果行列式为 0 返回 null
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3];
  const a10=a[4],a11=a[5],a12=a[6],a13=a[7];
  const a20=a[8],a21=a[9],a22=a[10],a23=a[11];
  const a30=a[12],a31=a[13],a32=a[14],a33=a[15];

  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10;
  const b02=a00*a13-a03*a10, b03=a01*a12-a02*a11;
  const b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30;
  const b08=a20*a33-a23*a30, b09=a21*a32-a22*a31;
  const b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;

  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if(Math.abs(det)<1e-8) return null;
  det=1.0/det;

  out[0]=(a11*b11-a12*b10+a13*b09)*det;
  out[1]=(a02*b10-a01*b11-a03*b09)*det;
  out[2]=(a31*b05-a32*b04+a33*b03)*det;
  out[3]=(a22*b04-a21*b05-a23*b03)*det;
  out[4]=(a12*b08-a10*b11-a13*b07)*det;
  out[5]=(a00*b11-a02*b08+a03*b07)*det;
  out[6]=(a32*b02-a30*b05-a33*b01)*det;
  out[7]=(a20*b05-a22*b02+a23*b01)*det;
  out[8]=(a10*b10-a11*b08+a13*b06)*det;
  out[9]=(a01*b08-a00*b10-a03*b06)*det;
  out[10]=(a30*b04-a31*b02+a33*b00)*det;
  out[11]=(a21*b02-a20*b04-a23*b00)*det;
  out[12]=(a11*b07-a10*b09-a12*b06)*det;
  out[13]=(a00*b09-a01*b07+a02*b06)*det;
  out[14]=(a31*b01-a30*b03-a32*b00)*det;
  out[15]=(a20*b03-a21*b01+a22*b00)*det;
  return out;
}

// --- 投影矩阵 ---

// 标准透视投影（WebGPU NDC：X[-1,1], Y[-1,1], Z[0,1]）
export function perspective(out: Mat4f, fovY: number, aspect: number, near: number, far: number): Mat4f {
  const f = 1.0 / Math.tan(fovY * 0.5);
  out[0] = f / aspect; out[1] = 0;  out[2] = 0;  out[3] = 0;
  out[4] = 0;          out[5] = f;  out[6] = 0;  out[7] = 0;
  out[8] = 0;          out[9] = 0;  out[11] = -1;
  out[12] = 0;         out[13] = 0; out[15] = 0;
  // WebGPU Z 范围 [0, 1]
  out[10] = far / (near - far);
  out[14] = (near * far) / (near - far);
  return out;
}

// Reversed-Z 透视投影（近 → 1.0, 远 → 0.0，精度更好）
export function perspectiveReversedZ(out: Mat4f, fovY: number, aspect: number, near: number, far: number): Mat4f {
  const f = 1.0 / Math.tan(fovY * 0.5);
  out[0] = f / aspect; out[1] = 0;  out[2] = 0;  out[3] = 0;
  out[4] = 0;          out[5] = f;  out[6] = 0;  out[7] = 0;
  out[8] = 0;          out[9] = 0;  out[11] = -1;
  out[12] = 0;         out[13] = 0; out[15] = 0;
  // Reversed-Z: 翻转深度映射
  out[10] = near / (far - near);
  out[14] = (near * far) / (far - near);
  return out;
}

// Reversed-Z 无限远透视投影（far → ∞，适合地球级场景）
export function perspectiveReversedZInfinite(out: Mat4f, fovY: number, aspect: number, near: number): Mat4f {
  const f = 1.0 / Math.tan(fovY * 0.5);
  out[0] = f / aspect; out[1] = 0; out[2] = 0;   out[3] = 0;
  out[4] = 0;          out[5] = f; out[6] = 0;   out[7] = 0;
  out[8] = 0;          out[9] = 0; out[10] = 0;  out[11] = -1;
  out[12] = 0;         out[13] = 0; out[14] = near; out[15] = 0;
  return out;
}

// 正交投影（2D 模式）
export function ortho(out: Mat4f, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4f {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr; out[1] = 0;       out[2] = 0;    out[3] = 0;
  out[4] = 0;       out[5] = -2 * bt; out[6] = 0;    out[7] = 0;
  out[8] = 0;       out[9] = 0;       out[10] = nf;  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = near * nf;
  out[15] = 1;
  return out;
}

// 视图矩阵
export function lookAt(out: Mat4f, eye: Vec3f, center: Vec3f, up: Vec3f): Mat4f {
  let fx = center[0]-eye[0], fy = center[1]-eye[1], fz = center[2]-eye[2];
  let len = Math.sqrt(fx*fx+fy*fy+fz*fz);
  if (len < 1e-6) { identity(out); return out; }
  len = 1/len; fx*=len; fy*=len; fz*=len;

  let sx = fy*up[2]-fz*up[1], sy = fz*up[0]-fx*up[2], sz = fx*up[1]-fy*up[0];
  len = Math.sqrt(sx*sx+sy*sy+sz*sz);
  if (len < 1e-6) { sx=0; sy=0; sz=0; } else { len=1/len; sx*=len; sy*=len; sz*=len; }

  const ux = sy*fz-sz*fy, uy = sz*fx-sx*fz, uz = sx*fy-sy*fx;

  out[0]=sx; out[1]=ux; out[2]=-fx; out[3]=0;
  out[4]=sy; out[5]=uy; out[6]=-fy; out[7]=0;
  out[8]=sz; out[9]=uz; out[10]=-fz; out[11]=0;
  out[12]=-(sx*eye[0]+sy*eye[1]+sz*eye[2]);
  out[13]=-(ux*eye[0]+uy*eye[1]+uz*eye[2]);
  out[14]= (fx*eye[0]+fy*eye[1]+fz*eye[2]);
  out[15]=1;
  return out;
}

// 平移/旋转/缩放
export function translate(out: Mat4f, a: Mat4f, v: Vec3f): Mat4f { /* ... */ }
export function rotateX(out: Mat4f, a: Mat4f, rad: number): Mat4f { /* ... */ }
export function rotateY(out: Mat4f, a: Mat4f, rad: number): Mat4f { /* ... */ }
export function rotateZ(out: Mat4f, a: Mat4f, rad: number): Mat4f { /* ... */ }
export function rotateAxis(out: Mat4f, a: Mat4f, rad: number, axis: Vec3f): Mat4f { /* ... */ }
export function scaleBy(out: Mat4f, a: Mat4f, v: Vec3f): Mat4f { /* ... */ }
export function transpose(out: Mat4f, a: Mat4f): Mat4f { /* ... */ }
export function determinant(a: Mat4f): number { /* ... */ }
export function fromRotationTranslation(out: Mat4f, q: Quatf, v: Vec3f): Mat4f { /* ... */ }
export function fromRotationTranslationScale(out: Mat4f, q: Quatf, v: Vec3f, s: Vec3f): Mat4f { /* ... */ }
export function getTranslation(out: Vec3f, a: Mat4f): Vec3f { /* ... */ }
export function getScaling(out: Vec3f, a: Mat4f): Vec3f { /* ... */ }
export function getRotation(out: Quatf, a: Mat4f): Quatf { /* ... */ }

// Float64 版本: mat4d.ts，同样的函数签名，操作 Float64Array/Mat4d
```

---

## Ellipsoid — WGS84 椭球体计算

```typescript
// ============================================================
// math/ellipsoid.ts — WGS84 椭球体数学
// 自研实现，不依赖任何外部库
// ============================================================

// WGS84 常量
export const WGS84_A = 6378137.0;                // 长半轴（米）
export const WGS84_B = 6356752.314245179;        // 短半轴（米）
export const WGS84_F = 1.0 / 298.257223563;     // 扁率
export const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;  // 第一偏心率平方

// 经纬度（弧度）+ 高程 → ECEF 笛卡尔坐标
export function geodeticToECEF(
  out: Vec3d,     // Float64Array 输出
  lonRad: number,
  latRad: number,
  alt: number,
): Vec3d {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);  // 卯酉圈曲率半径
  out[0] = (N + alt) * cosLat * cosLon;
  out[1] = (N + alt) * cosLat * sinLon;
  out[2] = (N * (1 - WGS84_E2) + alt) * sinLat;
  return out;
}

// ECEF → 经纬度 + 高程（Bowring 迭代法，精度 < 1mm）
export function ecefToGeodetic(
  out: Vec3d,     // [lonRad, latRad, alt]
  x: number, y: number, z: number,
): Vec3d {
  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);
  // Bowring 初始近似
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
  }
  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;
  out[0] = lon; out[1] = lat; out[2] = alt;
  return out;
}

// 地表法线向量（ECEF 空间中某点的外法线）
export function surfaceNormal(out: Vec3d, lonRad: number, latRad: number): Vec3d {
  const cosLat = Math.cos(latRad);
  out[0] = cosLat * Math.cos(lonRad);
  out[1] = cosLat * Math.sin(lonRad);
  out[2] = Math.sin(latRad);
  return out;
}

// 大地测量距离（Vincenty 公式，精度 < 0.5mm）
export function vincentyDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  // 完整的 Vincenty 反算公式实现
  // 迭代求解 λ，最多 100 次迭代
  // ... 完整算法实现 ...
  return distanceMeters;
}

// 快速距离估算（Haversine，精度 ~0.5%，适合小范围）
export function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * WGS84_A * Math.asin(Math.sqrt(a));
}

// 批量经纬度→ECEF 转换（性能关键路径）
export function batchGeodeticToECEF(
  lonLatAlt: Float64Array,    // [lon1, lat1, alt1, lon2, lat2, alt2, ...]
  outECEF: Float64Array,       // [x1, y1, z1, x2, y2, z2, ...]
): void {
  const count = lonLatAlt.length / 3;
  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    geodeticToECEF(
      /* 临时 slice */ outECEF.subarray(offset, offset + 3) as unknown as Vec3d,
      lonLatAlt[offset],
      lonLatAlt[offset + 1],
      lonLatAlt[offset + 2],
    );
  }
}
```

---

## Mercator — 墨卡托投影数学

```typescript
// ============================================================
// math/mercator.ts — 墨卡托投影纯数学实现
// ============================================================

export const TILE_SIZE = 512;                     // 默认瓦片大小（像素）
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * WGS84_A;  // 赤道周长
export const MAX_LATITUDE = 85.051128779806604;   // 墨卡托最大纬度

// 经纬度（度）→ 墨卡托坐标（米）
export function lngLatToMercator(out: Vec2d, lng: number, lat: number): Vec2d {
  out[0] = lng * (EARTH_CIRCUMFERENCE / 360);
  out[1] = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * WGS84_A;
  return out;
}

// 墨卡托坐标（米）→ 经纬度（度）
export function mercatorToLngLat(out: Vec2d, x: number, y: number): Vec2d {
  out[0] = x / (EARTH_CIRCUMFERENCE / 360);
  out[1] = (2 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2) * (180 / Math.PI);
  return out;
}

// 经纬度 → 瓦片坐标
export function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number; z: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y, z: zoom };
}

// 瓦片坐标 → 经纬度范围（BBox）
export function tileToBBox(x: number, y: number, z: number): BBox2D {
  const n = Math.pow(2, z);
  return {
    west: x / n * 360 - 180,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI,
    east: (x + 1) / n * 360 - 180,
    north: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
  };
}

// 给定缩放级别，计算地面分辨率（米/像素）
export function groundResolution(lat: number, zoom: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / (TILE_SIZE * Math.pow(2, zoom));
}

// 经纬度 → 像素坐标（在给定缩放级别下的世界像素坐标）
export function lngLatToPixel(out: Vec2d, lng: number, lat: number, zoom: number): Vec2d {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  out[0] = ((lng + 180) / 360) * worldSize;
  const latRad = lat * Math.PI / 180;
  out[1] = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * worldSize;
  return out;
}
```

---

## Earcut — 自研三角剖分

```typescript
// ============================================================
// math/earcut.ts — Ear-clipping 三角剖分算法
// 自研实现，支持岛洞多边形
// 时间复杂度 O(n²) 最坏，O(n log n) 平均
// ============================================================

/**
 * 将多边形三角剖分为三角形索引数组
 * @param data - 平铺的顶点坐标 [x1,y1, x2,y2, ...]
 * @param holeIndices - 岛洞起始顶点索引 [h1Start, h2Start, ...]
 * @param dim - 每个顶点的维度（2 = 2D, 3 = 3D取前两维）
 * @returns 三角形顶点索引数组 [i1,i2,i3, i4,i5,i6, ...]
 */
export function earcut(data: ArrayLike<number>, holeIndices?: number[], dim?: number): number[];

// 实现要点：
// 1. 构建双向链表表示多边形轮廓
// 2. 如果有岛洞，用桥接边将岛洞连接到外轮廓
// 3. 迭代切耳：找到一个"耳朵"三角形（内部无其他顶点），切掉
// 4. 如果基本切耳失败，使用 z-order 曲线优化的哈希网格加速点在三角形内的检测
// 5. 如果仍有剩余，尝试消除自相交后重试
```

---

## R-Tree — 自研空间索引

```typescript
// ============================================================
// math/rtree.ts — R-Tree 空间索引
// 自研实现，基于 Hilbert R-Tree 的批量加载优化
// ============================================================

export interface RTreeItem<T = any> {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly data: T;
}

export interface RTree<T = any> {
  // 批量加载（比逐个 insert 快 10 倍+，使用 Hilbert 曲线排序 + STR 批量加载）
  load(items: RTreeItem<T>[]): void;

  // 逐个插入
  insert(item: RTreeItem<T>): void;

  // 删除
  remove(item: RTreeItem<T>): boolean;

  // 矩形范围查询
  search(bbox: { minX: number; minY: number; maxX: number; maxY: number }): RTreeItem<T>[];

  // 碰撞检测（与给定矩形相交的所有项）
  collides(bbox: { minX: number; minY: number; maxX: number; maxY: number }): boolean;

  // 所有项
  all(): RTreeItem<T>[];

  // 项数
  readonly size: number;

  // 清空
  clear(): void;
}

// 实现要点：
// 1. 节点扇出 M=16（经验最优，cache-line 友好）
// 2. 批量加载使用 STR（Sort-Tile-Recursive）+ Hilbert 曲线排序
// 3. 查询使用自顶向下遍历 + 包围盒快速剔除
// 4. 插入使用选择最小面积增长的叶节点 + 节点分裂
```

---

## 更新后的 L0 模块总计（v2.1）

| 类别 | 模块数 | 关键实现 |
|------|--------|---------|
| 数学向量/矩阵 | 6 | vec2/3/4, mat3/4, quat（各有 f32+f64 双版本） |
| 数学几何 | 2 | bbox, frustum |
| 数学工具 | 2 | interpolate, trigonometry |
| GIS 数学 | 2 | ellipsoid(WGS84), mercator |
| 算法 | 4 | earcut, douglas-peucker, spatial-hash, rtree |
| **共享类型** | **6** | **geometry, feature, viewport, tile, style-spec, events** |
| 基础设施 | 7 | coordinate, projection, precision, event, id, logger, config |
| **总计** | **29** | 零外部依赖 |

预估体积：~18KB gzipped（新增类型定义几乎零运行时体积，纯 TypeScript 类型会被编译器擦除）。

---

## 与 Part 1 的接口差异

Part 1 中 L0 的 math 模块是"声明式接口"（`export declare const vec3: {...}`），现在改为"实现规格"（`export function create(): Vec3f`），关键区别：

1. **数据类型从 branded type 改为裸 TypedArray**：`Vec3f = Float32Array`，不再用 `__brand` 标记（减少类型体操，裸 TypedArray 直传 GPU）
2. **增加 Float64 双版本**：所有向量/矩阵都有 f32 和 f64 两套
3. **新增 6 个 GIS 数学/算法模块**：ellipsoid、mercator、earcut、douglas-peucker、spatial-hash、rtree
4. **Mat4 增加 3 种投影矩阵**：标准透视、Reversed-Z 透视、Reversed-Z 无限远透视（地球级场景用）
5. **列主序显式声明**：与 WGSL mat4x4 内存布局一致，CPU→GPU 零拷贝
6. **types/ 子目录作为全局共享类型中心**（审计修复）：Feature/GeoJSON/BBox2D/Viewport/CameraState/PickResult/TileCoord/StyleSpec/MapEventType/MapPointerEvent 全部在 L0 定义，L1~L6 从此处 import，消除跨层类型不一致

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| 新增 `types/feature.ts` | 不一致 #4 | Feature 之前在 L4/L5/L6 各自引用但从未定义 |
| 新增 `types/viewport.ts` | 不一致 #3 #6 #7 | CameraState/Viewport/PickResult 统一到 L0 单一定义 |
| 新增 `types/tile.ts` | 不一致 #5 | TileCoord/TileParams/TileData 统一定义，BBox2D 明确来自 math/bbox.ts |
| 新增 `types/geometry.ts` | 不一致 #4 补充 | GeoJSON Geometry 类型，Feature 依赖它 |
| 新增 `types/style-spec.ts` | 缺口 #5 | StyleSpec 顶层结构 + StyleExpression + FilterExpression 统一到 L0 |
| 新增 `types/events.ts` | — | MapEventType/MapPointerEvent/FlyToOptions/AnimationOptions/LogLevel 统一到 L0 |
| CameraState 统一使用 `bearing`（弧度） | 不一致 #3 | L6/Globe3D.getCameraPosition 返回的 heading 改为 bearing，与 L3 一致 |
| PickResult 增加 `sourceId`/`depth`/`worldPosition`/`normal` | 不一致 #6 | L2 的补充版本与 L5 引用版本统一 |
| 取消独立 `types.ts`，改为 `types/` 子目录 | — | 6 个类型文件按领域拆分，更清晰 |
