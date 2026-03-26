# GIS-Forge 架构设计 — L4 场景层完整接口定义

> **定位**：L4 是引擎的"语义层"——图层是什么、数据从哪来、样式怎么算、标注放哪里、要素怎么查询。
> L2 只知道 Render Pass 和 Pipeline，L4 才知道"这是一条道路"、"那是一栋建筑"。
> **包名**：@gis-forge/scene
> **模块数**：11 个核心模块 + 5 个图层包接口 + 1 个地球渲染器
>
> **v2.1 修订**：
> - Feature / StyleExpression / FilterExpression 改为从 L0/types import（不再本地定义）
> - **新增 5 个核心图层包接口**（layer-tile-raster, layer-tile-vector, layer-geojson, layer-terrain, globe）——修复审计缺口 #2
> - **新增端到端数据流**——修复审计缺口 #4
> - AnimationManager.flyTo 正式委托给 L3/CameraController
> - Layer 接口确认与 L2/FrameGraphBuilder 兼容（L2 v2.1 已删除 RenderableLayer）

---

## 类型依赖声明

```typescript
import type {
  Vec3f, Mat4f, BBox2D,
  Viewport, CameraState, PickResult,
  Feature, Geometry, FeatureCollection,
  TileCoord, TileData, TileParams, TileState,
  StyleExpression, FilterExpression, StyleSpec, LayerStyleSpec, SourceSpec,
} from '@gis-forge/core';

import type { CameraController, CameraAnimation } from '@gis-forge/runtime';
```

---

## 模块清单

| # | 模块 | 文件 | 解决问题 | v2.1 状态 |
|---|------|------|---------|----------|
| 1 | SceneGraph | `scene-graph.ts` | 多投影子树、混合渲染 | 不变 |
| 2 | LayerManager | `layer-manager.ts` | 图层注册/排序/可见性 | 不变 |
| 3 | SourceManager | `source-manager.ts` | #12.2 数据源多协议 | 不变 |
| 4 | StyleEngine | `style-engine.ts` | #10.3 数据驱动样式 | **修订**：StyleExpression 引用 L0 |
| 5 | LabelManager | `label-manager.ts` | #6.1 #6.2 标注碰撞 | 不变 |
| 6 | GlyphManager | `glyph-manager.ts` | #6.3 #6.4 文字渲染 | 不变 |
| 7 | FeatureStateManager | `feature-state.ts` | #5.4 跨瓦片要素 | 不变 |
| 8 | AntiMeridianHandler | `antimeridian.ts` | #5.3 日期线 | 不变 |
| 9 | AnimationManager | `animation.ts` | 属性动画+时间轴 | **修订**：flyTo 委托 CameraController |
| 10 | SpatialQuery | `spatial-query.ts` | 空间查询 | **修订**：Feature 引用 L0 |
| 11 | A11yManager | `a11y.ts` | 无障碍 | 不变 |
| — | **layer-tile-raster** | — | #4.1 瓦片接缝 | **v2.1 新增** |
| — | **layer-tile-vector** | — | #5.1 #5.2 三角剖分/宽线 | **v2.1 新增** |
| — | **layer-geojson** | — | #9.3 大 GeoJSON | **v2.1 新增** |
| — | **layer-terrain** | — | #4.2 #8.3 LOD裂缝/地形叠加 | **v2.1 新增** |
| — | **globe** | — | #8.1 #8.4 大气/阴影 | **v2.1 新增** |

---

## 模块 1：SceneGraph — 场景图

```typescript
// ============================================================
// scene-graph.ts — 多投影场景树
// 核心职责：将图层按投影类型分组，决定每个图层属于哪个 Render Pass
// ============================================================

export interface SceneNode {
  readonly id: string;
  readonly type: 'root' | 'projection-group' | 'layer' | 'ui-overlay';
  readonly children: readonly SceneNode[];
  readonly projection?: string;                // projection-group 节点有值
  readonly layer?: Layer;                      // layer 节点有值
  readonly visible: boolean;
}

export interface SceneGraph {
  // --- 结构管理 ---
  readonly root: SceneNode;

  // 添加图层到场景（自动根据图层的 projection 归入对应子树）
  addLayer(layer: Layer): void;
  removeLayer(layerId: string): void;
  moveLayer(layerId: string, beforeId?: string): void;  // 调整图层顺序

  // --- 查询 ---

  // 获取指定投影下的所有图层（Render Pass 用）
  getLayersByProjection(projection: string): Layer[];

  // 获取所有可见图层（按渲染顺序）
  getVisibleLayers(): Layer[];

  // 获取所有使用的投影类型（决定需要几个 Render Pass）
  getActiveProjections(): string[];

  // 获取 UI 叠加层（Screen Pass 用）
  getOverlayLayers(): Layer[];

  // --- 脏标记 ---
  // 场景结构变化时标记为脏，FrameScheduler 检查后触发重建 RenderGraph
  readonly isDirty: boolean;
  clearDirty(): void;

  // --- 遍历 ---
  traverse(visitor: (node: SceneNode, depth: number) => boolean | void): void;

  // --- 调试 ---
  toJSON(): object;
}
```

**场景树结构示例**：
```
root
├── projection-group: "mercator"
│   ├── layer: basemap-raster (zIndex: 0)
│   ├── layer: roads-vector (zIndex: 10)
│   └── layer: buildings-fill (zIndex: 20)
├── projection-group: "globe"
│   ├── layer: satellite-imagery (zIndex: 0)
│   └── layer: 3dtiles-buildings (zIndex: 10)
└── ui-overlay
    ├── layer: labels (zIndex: 100)
    └── layer: markers (zIndex: 110)
```

---

## 模块 2：LayerManager — 图层管理

```typescript
// ============================================================
// layer-manager.ts — 图层注册、排序、可见性、生命周期
// ============================================================

export interface LayerSpec {
  readonly id: string;
  readonly type: string;                       // 'raster' | 'vector' | 'geojson' | 'heatmap' | 'extrusion' | '3dtiles' | 'custom' | ...
  readonly source: string;                     // 数据源 ID
  readonly sourceLayer?: string;               // MVT 中的图层名
  readonly projection?: string;                // 投影 ID，默认继承地图投影
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly zIndex?: number;
  readonly filter?: FilterExpression;          // 要素过滤
  readonly paint?: Record<string, any>;        // 样式属性
  readonly layout?: Record<string, any>;       // 布局属性
  readonly metadata?: Record<string, any>;
}

export interface Layer {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly projection: string;
  visible: boolean;
  opacity: number;
  zIndex: number;

  // --- 生命周期 ---
  onAdd(context: LayerContext): void;
  onRemove(): void;
  onUpdate(deltaTime: number, camera: CameraState): void;

  // --- 渲染 ---
  // 将自己的绘制命令编码到 RenderPass
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;

  // --- 数据 ---
  setData?(data: any): void;
  getData?(): any;

  // --- 样式 ---
  setPaintProperty(name: string, value: any): void;
  setLayoutProperty(name: string, value: any): void;
  getPaintProperty(name: string): any;
  getLayoutProperty(name: string): any;

  // --- 查询 ---
  queryFeatures?(bbox: BBox2D, filter?: FilterExpression): Feature[];
  queryRenderedFeatures?(point: [number, number]): Feature[];

  // --- 状态 ---
  setFeatureState?(featureId: string, state: Record<string, any>): void;
  getFeatureState?(featureId: string): Record<string, any> | undefined;

  // --- 渲染信息 ---
  readonly isLoaded: boolean;
  readonly isTransparent: boolean;
  readonly renderOrder: number;
}

export interface LayerContext {
  readonly deviceManager: DeviceManager;
  readonly uploader: GPUUploader;
  readonly shaderAssembler: ShaderAssembler;
  readonly pipelineCache: PipelineCache;
  readonly bufferPool: BufferPool;
  readonly textureManager: TextureManager;
  readonly bindGroupCache: BindGroupCache;
  readonly tileScheduler: TileScheduler;
  readonly workerPool: WorkerPool;
  readonly resourceManager: ResourceManager;
  readonly styleEngine: StyleEngine;
  readonly labelManager: LabelManager;
  readonly glyphManager: GlyphManager;
  readonly featureStateManager: FeatureStateManager;
}

export interface LayerManager {
  // --- 图层操作 ---
  addLayer(spec: LayerSpec, beforeId?: string): Layer;
  removeLayer(id: string): void;
  getLayer(id: string): Layer | undefined;
  getLayers(): Layer[];

  // --- 排序 ---
  moveLayer(id: string, beforeId?: string): void;
  setZIndex(id: string, zIndex: number): void;

  // --- 可见性 ---
  setVisibility(id: string, visible: boolean): void;
  setOpacity(id: string, opacity: number): void;

  // --- 过滤 ---
  setFilter(id: string, filter: FilterExpression | null): void;
  getFilter(id: string): FilterExpression | null;

  // --- 批量操作 ---
  setLayerOrder(ids: string[]): void;          // 完整重排序

  // --- 事件 ---
  onLayerAdded(callback: (layer: Layer) => void): () => void;
  onLayerRemoved(callback: (layerId: string) => void): () => void;
  onLayerChanged(callback: (layerId: string, property: string) => void): () => void;

  // --- 图层工厂注册（EP1 扩展点的实现基础）---
  registerLayerType(type: string, factory: (spec: LayerSpec, context: LayerContext) => Layer): void;
}
```

---

## 模块 3：SourceManager — 数据源管理

```typescript
// ============================================================
// source-manager.ts — 数据源注册与管理
// 解决问题 #12.2 OGC 协议 + 多数据源
// ============================================================

export interface SourceSpec {
  readonly id: string;
  readonly type: string;                       // 'vector' | 'raster' | 'raster-dem' | 'geojson' | 'image' | 'video' | '3dtiles' | 'custom'
  readonly url?: string;
  readonly urls?: string[];                    // 多域名负载均衡
  readonly tiles?: string[];                   // 瓦片 URL 模板
  readonly data?: object;                      // 内嵌 GeoJSON 数据
  readonly tileSize?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly bounds?: BBox2D;
  readonly attribution?: string;
  readonly scheme?: 'xyz' | 'tms';
  readonly encoding?: 'mapbox' | 'terrarium';  // DEM 编码方式
  readonly promoteId?: string;                 // 要素 ID 字段
}

export interface Source {
  readonly id: string;
  readonly type: string;
  readonly loaded: boolean;
  readonly error?: Error;

  // 元数据（加载后可用）
  readonly metadata?: {
    readonly bounds?: BBox2D;
    readonly minZoom?: number;
    readonly maxZoom?: number;
    readonly vectorLayers?: Array<{ id: string; fields: Record<string, string> }>;
    readonly attribution?: string;
  };

  // --- 数据获取 ---
  loadTile?(coord: TileCoord, signal?: AbortSignal): Promise<any>;
  loadFeatures?(extent: BBox2D, zoom: number): Promise<Feature[]>;

  // --- 数据更新（GeoJSON 等实时源）---
  setData?(data: object): void;

  // --- 生命周期 ---
  initialize(): Promise<void>;
  destroy(): void;
}

export interface SourceManager {
  addSource(spec: SourceSpec): Promise<Source>;
  removeSource(id: string): void;
  getSource(id: string): Source | undefined;
  getSources(): Source[];

  // 数据源类型工厂注册（EP3 扩展点的实现基础）
  registerSourceType(type: string, factory: (spec: SourceSpec) => Source): void;

  // 事件
  onSourceLoaded(callback: (source: Source) => void): () => void;
  onSourceError(callback: (sourceId: string, error: Error) => void): () => void;
}
```

---

## 模块 4：StyleEngine — 样式引擎

```typescript
// ============================================================
// style-engine.ts — 数据驱动样式 → WGSL 编译
// 解决问题 #10.3 数据驱动样式性能
// v2.1：StyleExpression / FilterExpression 统一从 @gis-forge/core import
// ============================================================

import type { StyleExpression, FilterExpression } from '@gis-forge/core';

export interface CompiledStyle {
  readonly wgslCode: string;                   // 编译后的 WGSL 函数代码
  readonly uniformValues: Float32Array;        // 编译时确定的常量值
  readonly isConstant: boolean;                // 样式是否完全是常量（不依赖属性）
  readonly dependsOnZoom: boolean;             // 是否依赖缩放级别
  readonly dependsOnFeature: boolean;          // 是否依赖要素属性
  readonly requiredAttributes: string[];       // 需要的要素属性列表
}

export interface StyleEngine {
  // --- 编译 ---

  // 将样式表达式编译为 WGSL 代码
  compile(expression: StyleExpression, outputType: 'f32' | 'vec4f'): CompiledStyle;

  // 将过滤表达式编译为 WGSL 布尔函数
  compileFilter(filter: FilterExpression): CompiledStyle;

  // --- CPU 端求值（用于不需要 GPU 的场景，如标注碰撞）---
  evaluate(expression: StyleExpression, feature: Feature, zoom: number): any;

  // --- 缓存 ---
  readonly cacheSize: number;
  clearCache(): void;
}
```

**编译示例**：
```typescript
// 输入表达式
['interpolate', ['linear'], ['zoom'],
  10, 'red',
  15, 'blue'
]

// 编译输出 WGSL
// fn computeColor(zoom: f32, attrs: FeatureAttributes) -> vec4<f32> {
//   let t = clamp((zoom - 10.0) / 5.0, 0.0, 1.0);
//   return mix(vec4<f32>(1.0, 0.0, 0.0, 1.0), vec4<f32>(0.0, 0.0, 1.0, 1.0), t);
// }
```

---

## 模块 5：LabelManager — 标注管理

```typescript
// ============================================================
// label-manager.ts — 全局标注碰撞检测与放置
// 解决问题 #6.1 标注碰撞性能、#6.2 沿线标注
// ============================================================

export interface LabelSpec {
  readonly id: string;
  readonly layerId: string;
  readonly featureId: string;
  readonly text: string;
  readonly position: [number, number];         // 经纬度
  readonly anchor: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  readonly priority: number;                   // 碰撞优先级，越高越优先显示
  readonly placement: 'point' | 'line' | 'line-center';
  readonly linePath?: Float64Array;            // 沿线放置时的路径坐标
  readonly offset: [number, number];           // 像素偏移
  readonly rotation?: number;                  // 旋转角（弧度）
  readonly allowOverlap: boolean;              // 允许重叠
  readonly optional: boolean;                  // 空间不足时可省略
}

export interface PlacedLabel {
  readonly id: string;
  readonly screenBBox: { x: number; y: number; width: number; height: number };
  readonly screenPosition: [number, number];
  readonly rotation: number;
  readonly visible: boolean;
  readonly glyphQuads: GlyphQuad[];            // 已排版的字形四边形
}

export interface GlyphQuad {
  readonly atlasRegion: AtlasRegion;           // 在字形 Atlas 中的位置
  readonly x: number;                          // 屏幕 x
  readonly y: number;                          // 屏幕 y
  readonly width: number;
  readonly height: number;
}

export interface LabelManager {
  // --- 标注注册（图层在每帧更新时调用）---
  submitLabels(labels: LabelSpec[]): void;
  clearLabels(layerId: string): void;

  // --- 碰撞检测（每帧调用）---
  // 两阶段：
  //   1. CPU 粗筛：R-Tree 快速剔除无交叠的标注
  //   2. GPU 精筛：Compute Shader 处理密集区域的精确碰撞
  resolve(camera: CameraState, viewport: Viewport): PlacedLabel[];

  // --- 配置 ---
  readonly config: {
    crossSourceCollisions: boolean;            // 不同数据源的标注是否互斥
    fadeDuration: number;                      // 标注显隐的淡入淡出时间（ms）
    padding: number;                           // 碰撞检测额外 padding（px）
  };

  // --- 查询 ---
  getLabelAt(screenX: number, screenY: number): PlacedLabel | null;
  getVisibleLabels(): PlacedLabel[];

  // --- 统计 ---
  readonly stats: {
    readonly totalSubmitted: number;
    readonly visibleCount: number;
    readonly collidedCount: number;
    readonly cpuCullTimeMs: number;
    readonly gpuCullTimeMs: number;
  };
}
```

---

## 模块 6：GlyphManager — 字形管理

```typescript
// ============================================================
// glyph-manager.ts — MSDF 字体管理 + Unicode Block 按需加载
// 解决问题 #6.3 文字渲染质量、#6.4 字形加载
// ============================================================

export interface GlyphMetrics {
  readonly codePoint: number;
  readonly width: number;
  readonly height: number;
  readonly bearingX: number;                   // 基线到字形左边缘
  readonly bearingY: number;                   // 基线到字形顶部
  readonly advance: number;                    // 到下一个字形的水平距离
  readonly atlasRegion: AtlasRegion;           // 在 Atlas 中的位置
}

export interface FontStack {
  readonly name: string;                       // "Noto Sans Regular"
  readonly glyphs: ReadonlyMap<number, GlyphMetrics>;
}

// Unicode Block 范围
export interface UnicodeBlock {
  readonly name: string;                       // "Basic Latin", "CJK Unified Ideographs"
  readonly start: number;                      // 起始码点
  readonly end: number;                        // 结束码点
}

export interface GlyphManager {
  // --- 字体栈注册 ---
  registerFont(fontName: string, urlTemplate: string): void;

  // --- 字形获取（按需加载）---
  getGlyph(fontName: string, codePoint: number): GlyphMetrics | null;

  // 批量获取（文字排版时一次请求所有字形）
  getGlyphs(fontName: string, text: string): Map<number, GlyphMetrics>;

  // --- 加载状态 ---
  isBlockLoaded(fontName: string, block: UnicodeBlock): boolean;
  loadBlock(fontName: string, block: UnicodeBlock): Promise<void>;

  // --- 文字排版（Text Shaping）---
  shape(
    text: string,
    fontName: string,
    fontSize: number,
    options?: {
      maxWidth?: number;
      lineHeight?: number;
      textAlign?: 'left' | 'center' | 'right';
      letterSpacing?: number;
    },
  ): { quads: GlyphQuad[]; width: number; height: number; lineCount: number };

  // --- Atlas ---
  readonly atlas: TextureHandle;
  readonly atlasSize: number;

  // --- 统计 ---
  readonly stats: {
    readonly loadedFonts: number;
    readonly loadedGlyphs: number;
    readonly pendingBlocks: number;
    readonly failedBlocks: number;
    readonly atlasUtilization: number;
  };
}
```

---

## 模块 7：FeatureStateManager — 要素状态管理

```typescript
// ============================================================
// feature-state.ts — 跨瓦片要素状态同步
// 解决问题 #5.4 矢量要素跨瓦片边界
// ============================================================

export interface FeatureStateManager {
  // --- 状态设置 ---
  setState(sourceId: string, featureId: string, state: Record<string, any>): void;
  removeState(sourceId: string, featureId: string, key?: string): void;

  // --- 状态查询 ---
  getState(sourceId: string, featureId: string): Record<string, any> | undefined;

  // --- 批量操作 ---
  setStates(sourceId: string, states: Map<string, Record<string, any>>): void;
  clearStates(sourceId?: string): void;

  // --- 与 Shader 的对接 ---
  uploadStatesToGPU(uploader: GPUUploader): BufferHandle;

  // --- 事件 ---
  onStateChange(callback: (sourceId: string, featureId: string, state: Record<string, any>) => void): () => void;

  // --- 统计 ---
  readonly trackedFeatureCount: number;
}
```

---

## 模块 8：AntiMeridianHandler — 日期线处理

```typescript
// ============================================================
// antimeridian.ts — 日期线几何切割与世界副本
// 解决问题 #5.3 跨日期线渲染
// ============================================================

export interface AntiMeridianHandler {
  // --- 几何切割 ---
  splitGeometry(coords: Float64Array, geometryType: 'LineString' | 'Polygon'): Float64Array[];

  // 批量切割（瓦片解码后调用）
  splitFeatures(features: Feature[]): Feature[];

  // --- 世界副本 ---
  getWorldCopies(viewBounds: BBox2D, wrapsX: boolean): number[];

  // --- 瓦片坐标规范化 ---
  normalizeTileCoord(coord: TileCoord, maxTile: number): TileCoord;

  // --- 经度规范化 ---
  normalizeLongitude(lon: number): number;     // 归一化到 [-180, 180)
}
```

---

## 模块 9：AnimationManager — 动画管理

```typescript
// ============================================================
// animation.ts — 图层属性动画 + 时间轴控制
// v2.1：flyTo 委托给 L3/CameraController
// ============================================================

export interface AnimationOptions {
  readonly duration: number;                   // 毫秒
  readonly easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | ((t: number) => number);
  readonly delay?: number;
  readonly loop?: boolean | number;            // true=无限循环, number=循环次数
}

export interface Animation {
  readonly id: string;
  readonly state: 'pending' | 'running' | 'paused' | 'finished' | 'cancelled';
  readonly progress: number;                   // 0~1

  pause(): void;
  resume(): void;
  cancel(): void;
  reverse(): void;

  // Promise 风格等待完成
  finished: Promise<void>;
}

export interface AnimationManager {
  // --- 属性动画 ---
  // 对图层的 paint/layout 属性进行动画过渡
  animateProperty(
    layerId: string,
    property: string,
    from: any,
    to: any,
    options: AnimationOptions,
  ): Animation;

  // --- 相机动画 ---
  // ★ v2.1：flyTo 委托给 CameraController
  flyTo(camera: CameraController, options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation;

  // --- 时间轴（CZML 风格）---
  setClock(options: {
    startTime: Date;
    endTime: Date;
    currentTime?: Date;
    multiplier?: number;
  }): void;
  readonly clock: {
    readonly currentTime: Date;
    readonly multiplier: number;
    readonly isPlaying: boolean;
  };
  playClock(): void;
  pauseClock(): void;

  // --- 每帧更新（由 FrameScheduler 调用）---
  update(deltaTime: number): void;

  // --- 查询 ---
  getAnimation(id: string): Animation | undefined;
  getActiveAnimations(): Animation[];

  // --- 清理 ---
  cancelAll(): void;
}
```

---

## 模块 10：SpatialQuery — 空间查询

```typescript
// ============================================================
// spatial-query.ts — 空间查询统一接口
// 封装 PickingEngine + FeatureStateManager + R-Tree
// v2.1：Feature 统一从 @gis-forge/core import
// ============================================================

import type { Feature } from '@gis-forge/core';

export interface QueryOptions {
  readonly layers?: string[];                  // 限定查询的图层，默认全部
  readonly filter?: FilterExpression;          // 结果过滤
  readonly limit?: number;                     // 最大返回数量
  readonly tolerance?: number;                 // 容差（像素）
}

export interface SpatialQuery {
  // --- 像素查询（Picking）---
  queryAtPoint(screenX: number, screenY: number, options?: QueryOptions): Promise<Feature[]>;

  // --- 矩形查询 ---
  queryInRect(
    screenX1: number, screenY1: number,
    screenX2: number, screenY2: number,
    options?: QueryOptions,
  ): Promise<Feature[]>;

  // --- 地理范围查询 ---
  queryInBBox(bbox: BBox2D, options?: QueryOptions): Feature[];

  // --- 多边形查询 ---
  queryInPolygon(polygon: Float64Array, options?: QueryOptions): Feature[];

  // --- 半径查询 ---
  queryInRadius(center: [number, number], radiusMeters: number, options?: QueryOptions): Feature[];

  // --- 最近邻查询 ---
  queryNearest(point: [number, number], options?: QueryOptions & { k?: number }): Feature[];

  // --- 屏幕坐标 → 地理坐标 ---
  screenToLngLat(screenX: number, screenY: number): [number, number] | null;
  lngLatToScreen(lng: number, lat: number): [number, number] | null;
}
```

---

## 模块 11：A11yManager — 无障碍

```typescript
// ============================================================
// a11y.ts — 无障碍访问支持
// 键盘导航、ARIA 标签、屏幕阅读器
// ============================================================

export interface A11yManager {
  // --- 键盘导航 ---
  enableKeyboardNavigation(enabled: boolean): void;
  readonly isKeyboardNavigationEnabled: boolean;

  readonly keyMap: {
    panUp: string[];
    panDown: string[];
    panLeft: string[];
    panRight: string[];
    zoomIn: string[];
    zoomOut: string[];
    resetView: string[];
    rotateCW: string[];
    rotateCCW: string[];
  };
  setKeyMap(keyMap: Partial<typeof this.keyMap>): void;

  // --- ARIA ---
  setAriaLabel(label: string): void;
  setAriaDescription(description: string): void;
  announceViewChange(center: [number, number], zoom: number): void;
  announceFeature(feature: Feature): void;

  // --- 焦点管理 ---
  readonly focusedFeature: Feature | null;
  focusNext(): void;
  focusPrevious(): void;

  // --- 高对比度模式 ---
  enableHighContrast(enabled: boolean): void;
  readonly isHighContrastEnabled: boolean;

  // --- 减少动画 ---
  readonly prefersReducedMotion: boolean;
}
```

---

## 新增：核心图层包接口（v2.1，修复审计缺口 #2）

### layer-tile-raster — 栅格瓦片图层

```typescript
// @gis-forge/layer-tile-raster — 解决 #4.1 瓦片接缝

export interface RasterTileLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly tileSize?: 256 | 512;
  readonly opacity?: number;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly fadeDuration?: number;
}

export interface RasterTileLayer extends Layer {
  readonly type: 'raster';
  readonly visibleTiles: TileCoord[];
  readonly loadingTiles: TileCoord[];

  // 接缝处理：clamp-to-edge + 0.5 texel 内缩 + 相邻重叠 1px + 父瓦片 bilinear placeholder
  setBrightness(value: number): void;
  setContrast(value: number): void;
  setSaturation(value: number): void;
}
```

### layer-tile-vector — 矢量瓦片图层

```typescript
// @gis-forge/layer-tile-vector — 解决 #5.1 三角剖分、#5.2 宽线渲染

export interface VectorTileLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly sourceLayer: string;
  readonly type: 'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion';
  readonly filter?: FilterExpression;
  readonly paint?: Record<string, any>;
  readonly layout?: Record<string, any>;
  readonly minzoom?: number;
  readonly maxzoom?: number;
}

export interface VectorTileLayer extends Layer {
  // 管线：TileScheduler → fetch(MVT) → Worker(mvt-decode + earcut + 宽线条带) → GPU
  // 宽线：Worker端矩形条带 + Miter/Bevel/Round + Fragment SDF抗锯齿

  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];
  queryRenderedFeatures(point: [number, number]): Feature[];
}
```

### layer-geojson — GeoJSON 图层

```typescript
// @gis-forge/layer-geojson — 解决 #9.3 大 GeoJSON

export interface GeoJSONLayerOptions {
  readonly id: string;
  readonly data: string | object;
  readonly type: 'fill' | 'line' | 'circle' | 'symbol';
  readonly cluster?: boolean;
  readonly clusterRadius?: number;
  readonly clusterMaxZoom?: number;
  readonly filter?: FilterExpression;
  readonly paint?: Record<string, any>;
  readonly layout?: Record<string, any>;
  readonly tolerance?: number;
}

export interface GeoJSONLayer extends Layer {
  // 管线：fetch/接收 → Worker(geojson-parse + geojson-vt切片 + Supercluster聚合) → 按瓦片取切片 → GPU

  setData(data: string | object): void;
  getData(): FeatureCollection;
  getClusterExpansionZoom(clusterId: number): number;
  getClusterChildren(clusterId: number): Feature[];
  getClusterLeaves(clusterId: number, limit?: number): Feature[];
}
```

### layer-terrain — 地形图层

```typescript
// @gis-forge/layer-terrain — 解决 #4.2 LOD 裂缝、#8.3 地形叠加

export interface TerrainLayerOptions {
  readonly source: string;
  readonly exaggeration?: number;
  readonly meshResolution?: number;
  readonly encoding?: 'mapbox' | 'terrarium';
}

export interface TerrainLayer extends Layer {
  // 管线：TileScheduler → 加载DEM → Worker(terrain-mesh: 解码+三角网+法线+裙边) → GPU
  // LOD裂缝：边缘约束 + 裙边遮挡 + Morphing过渡
  // 地形叠加：配合StencilManager.terrainDrape + Vertex Shader采样高度纹理

  getElevation(lon: number, lat: number): Promise<number>;
  getElevationSync(lon: number, lat: number): number | null;
  setExaggeration(value: number): void;
  readonly exaggeration: number;
}
```

### globe — 地球渲染器

```typescript
// @gis-forge/globe — 解决 #8.1 大气散射、#8.4 阴影

export interface GlobeOptions {
  readonly atmosphere?: boolean;
  readonly atmosphereIntensity?: number;
  readonly skybox?: boolean;
  readonly skyboxStars?: boolean;
  readonly baseColor?: [number, number, number, number];
  readonly shadows?: boolean;
  readonly sunPosition?: [number, number, number];
}

export interface GlobeRenderer {
  // 大气（#8.1）：Rayleigh + Mie + 预计算 LUT 或实时射线步进
  setAtmosphereEnabled(enabled: boolean): void;
  setAtmosphereIntensity(intensity: number): void;

  setSkyboxEnabled(enabled: boolean): void;
  setSkyboxTexture?(texture: TextureHandle): void;

  // 阴影（#8.4）：CSM + PCF
  setShadowsEnabled(enabled: boolean): void;
  setSunPosition(ecef: Vec3f): void;
  setSunFromDateTime(date: Date): void;

  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
  encodeAtmosphere(encoder: GPURenderPassEncoder, camera: CameraState): void;
  encodeSkybox(encoder: GPURenderPassEncoder, camera: CameraState): void;

  initialize(context: LayerContext): void;
  destroy(): void;
}
```

---

## 新增：端到端数据流（v2.1，修复审计缺口 #4）

```
L6  map.addLayer({ id:'buildings', type:'fill', source:'streets', 'source-layer':'buildings', paint:{'fill-color':'#aaa'} })
  ▼
L4  layerManager.addLayer(spec) → VectorTileLayer 工厂 → layer.onAdd():
      styleEngine.compile → shaderAssembler.assemble → pipelineCache.getOrCreateAsync
      sceneGraph.addLayer → "mercator" 投影组
  ▼
L3  tileScheduler.registerSource('streets')
    每帧: camera.update → tileScheduler.update → toLoad → requestScheduler.schedule
  ▼
网络  fetch(MVT) → ArrayBuffer
  ▼
L3  workerPool.submit('mvt-decode') → Worker: Protobuf→earcut→条带→Float32Array (transferable)
  ▼
L1  uploader.uploadFromTransferable → GPU Buffer + memoryTracker.track
  ▼
L4  layer.onTileLoaded(coord, buffers)
  ▼
L2  frameGraphBuilder.addSceneRenderPass → build → execute:
      layer.encode: setPipeline → setVertexBuffer → setIndexBuffer → setBindGroup → drawIndexed
  ▼
GPU  Vertex(projectPosition→mercator) → Fragment(computeColor→#aaa) → 像素
  ▼
屏幕  灰色建筑物多边形
```

---

## L4 初始化流程

```typescript
function initializeL4(l1: L1Modules, l2: L2Modules, l3: L3Modules) {
  // 1. FeatureStateManager — 无依赖
  const featureState = createFeatureStateManager();

  // 2. AntiMeridianHandler — 依赖 L0 算法
  const antimeridian = createAntiMeridianHandler();

  // 3. GlyphManager — 依赖 L1.textureManager + L3.requestScheduler + L3.workerPool
  const glyphManager = createGlyphManager(l1.textureManager, l3.requestScheduler, l3.workerPool);

  // 4. StyleEngine — 依赖 L2.shaderAssembler
  const styleEngine = createStyleEngine(l2.shaderAssembler);

  // 5. LabelManager — 依赖 GlyphManager + L2.computePassManager + L0.rtree
  const labelManager = createLabelManager(glyphManager, l2.computePassManager);

  // 6. SourceManager — 依赖 L3.requestScheduler + L3.workerPool + L3.resourceManager
  const sourceManager = createSourceManager(l3.requestScheduler, l3.workerPool, l3.resourceManager);

  // 7. AnimationManager — 依赖 L0.interpolate
  const animationManager = createAnimationManager();

  // 8. SpatialQuery — 依赖 L2.pickingEngine + FeatureStateManager + L0.rtree
  const spatialQuery = createSpatialQuery(l2.pickingEngine, featureState);

  // 9. A11yManager — 依赖 SpatialQuery + AnimationManager
  const a11y = createA11yManager(spatialQuery, animationManager);

  // 10. LayerManager — 依赖以上所有（构造 LayerContext）
  const layerContext: LayerContext = {
    deviceManager: l1.deviceManager, uploader: l1.uploader,
    shaderAssembler: l2.shaderAssembler, pipelineCache: l2.pipelineCache,
    bufferPool: l1.bufferPool, textureManager: l1.textureManager,
    bindGroupCache: l1.bindGroupCache, tileScheduler: l3.tileScheduler,
    workerPool: l3.workerPool, resourceManager: l3.resourceManager,
    styleEngine, labelManager, glyphManager, featureStateManager: featureState,
  };
  const layerManager = createLayerManager(layerContext);

  // 11. SceneGraph — 依赖 LayerManager
  const sceneGraph = createSceneGraph(layerManager);

  return {
    featureState, antimeridian, glyphManager, styleEngine, labelManager,
    sourceManager, animationManager, spatialQuery, a11y, layerManager, sceneGraph,
  };
}
```

---

## L4 模块统计

| 模块 | 公共方法数 | 核心数据结构 | v2.1 变更 |
|------|-----------|------------|----------|
| SceneGraph | 9 | SceneNode | — |
| LayerManager | 14 | LayerSpec, Layer, LayerContext | — |
| SourceManager | 6 | SourceSpec, Source | — |
| StyleEngine | 4 | CompiledStyle | StyleExpression 引用 L0 |
| LabelManager | 7 | LabelSpec, PlacedLabel, GlyphQuad | — |
| GlyphManager | 8 | GlyphMetrics, FontStack, UnicodeBlock | — |
| FeatureStateManager | 7 | — | — |
| AntiMeridianHandler | 5 | — | — |
| AnimationManager | 11 | Animation, AnimationOptions | flyTo → CameraController |
| SpatialQuery | 8 | QueryOptions | Feature 引用 L0 |
| A11yManager | 11 | — | — |
| **合计** | **90 个公共方法** | | |

全部 11 个核心模块 + 5 个图层包接口 + 1 个地球渲染器，90+ 个公共接口方法，零第三方依赖。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| Feature/StyleExpression/FilterExpression 引用 L0 | 不一致 #4 #12 | 删除本地定义，统一从 @gis-forge/core import |
| 新增 layer-tile-raster | 缺口 #2（#4.1）| 栅格瓦片接缝处理 |
| 新增 layer-tile-vector | 缺口 #2（#5.1 #5.2）| 三角剖分 + 宽线渲染 |
| 新增 layer-geojson | 缺口 #2（#9.3）| 大 GeoJSON Worker 切片 |
| 新增 layer-terrain | 缺口 #2（#4.2 #8.3）| LOD 裂缝 + 地形叠加 |
| 新增 globe | 缺口 #2（#8.1 #8.4）| 大气散射 + 阴影 |
| 新增端到端数据流 | 缺口 #4 | 从 addLayer 到屏幕像素完整链路 |
| AnimationManager.flyTo → CameraController | 与 L3 对接 | flyTo 委托给 L3 相机控制器 |
| Layer 确认与 L2 兼容 | 不一致 #1 | L2 已删除 RenderableLayer |
