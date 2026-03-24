# GeoForge 架构设计 — L6 预设层完整接口定义

> **定位**：L6 是面向最终用户的便利层。"5 行代码出地图"的承诺在这里实现。
> **核心原则**：零新逻辑（只组装 L0~L5）、默认值合理（开箱即用）、逃生舱口（暴露底层）、可拆解（用户可渐进替换为底层模块）。
> **包数**：4 个 npm 包（preset-2d / preset-25d / preset-3d / preset-full）
>
> **v2.1 修订**：
> - `queryRenderedFeatures` 改为返回 `Promise<Feature[]>`（修复审计不一致 #11：L2 Picking 是异步的）
> - Globe3D.getCameraPosition 统一使用 `bearing`（弧度），删除 `heading`（修复不一致 #3）
> - `get camera()` 返回类型改为 L3 `CameraController`（与 L3 v2.1 对接）
> - Feature / CameraState / PickResult 等全部引用 L0 定义

---

## 类型依赖声明

```typescript
import type {
  BBox2D, Viewport, CameraState, PickResult, Feature, FeatureCollection,
  StyleSpec, SourceSpec, LayerStyleSpec, FilterExpression, LightSpec,
} from '@geoforge/core';

import type { CameraController, CameraAnimation, ViewMorph } from '@geoforge/runtime';
```

---

## 包清单

| # | 包名 | 入口类 | 继承 | gzipped |
|---|------|--------|------|---------|
| 1 | @geoforge/preset-2d | Map2D | — | ~120KB |
| 2 | @geoforge/preset-25d | Map25D | extends Map2D | ~155KB |
| 3 | @geoforge/preset-3d | Globe3D | — | ~195KB |
| 4 | @geoforge/preset-full | MapFull | 包含所有 | ~350KB |

---

## 共享类型定义

```typescript
// ============================================================
// 所有预设共用的类型
// ============================================================

export interface FlyToOptions {
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  duration?: number;                           // 毫秒，默认 1500
  easing?: (t: number) => number;              // 缓动函数，默认 ease-in-out
  curve?: number;                              // 飞行曲线弧度，默认 1.42
  padding?: PaddingOptions;
}

export interface PaddingOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface AnimationOptions {
  duration?: number;
  easing?: (t: number) => number;
}

// 地图事件类型
export type MapEventType =
  // 交互事件
  | 'click' | 'dblclick' | 'contextmenu'
  | 'mousedown' | 'mouseup' | 'mousemove'
  | 'mouseenter' | 'mouseleave'
  | 'touchstart' | 'touchend' | 'touchmove'
  | 'wheel'
  // 地图状态事件
  | 'movestart' | 'move' | 'moveend'
  | 'zoomstart' | 'zoom' | 'zoomend'
  | 'rotatestart' | 'rotate' | 'rotateend'
  | 'pitchstart' | 'pitch' | 'pitchend'
  // 生命周期事件
  | 'load' | 'idle' | 'resize' | 'remove'
  // 数据事件
  | 'data' | 'sourcedata' | 'tiledata'
  | 'error'
  // 渲染事件
  | 'render' | 'prerender' | 'postrender';

export interface MapEvent {
  readonly type: MapEventType;
  readonly target: Map2D | Globe3D | MapFull;
}

// ★ v2.1: MapMouseEvent.features 类型改为 PickResult[]（来自 L0）
export interface MapMouseEvent extends MapEvent {
  readonly lngLat: [number, number];
  readonly point: [number, number];            // CSS 像素
  readonly features?: PickResult[];            // ★ L0 定义
  readonly originalEvent: MouseEvent;
  preventDefault(): void;
}

// 图层规格（声明式添加图层）
export interface LayerSpec {
  readonly id: string;
  readonly type: string;                       // 'raster' | 'vector' | 'geojson' | 'marker' | 'extrusion' | 'custom' | ...
  readonly source?: string | SourceSpec;       // 数据源 ID 或内联定义
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly filter?: any[];                     // 表达式过滤器
  readonly layout?: Record<string, any>;
  readonly paint?: Record<string, any>;
  readonly beforeId?: string;                  // 插入到指定图层之前
}

export interface SourceSpec {
  readonly type: string;                       // 'raster' | 'vector' | 'geojson' | 'image' | 'terrain' | 'custom'
  readonly url?: string;
  readonly tiles?: string[];
  readonly data?: any;                         // GeoJSON 内联数据
  readonly tileSize?: number;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly attribution?: string;
}
```

---

## 包 1：@geoforge/preset-2d — Map2D

```typescript
// ============================================================
// @geoforge/preset-2d
// 最简 2D 地图，对标 MapLibre GL 的核心 API
// ============================================================

export interface Map2DOptions {
  // 容器
  container: string | HTMLElement;

  // 视图初始状态
  center?: [number, number];                   // 默认 [0, 0]
  zoom?: number;                               // 默认 1
  minZoom?: number;                            // 默认 0
  maxZoom?: number;                            // 默认 22
  bounds?: BBox2D;                             // 初始显示范围（与 center/zoom 二选一）

  // 样式
  style?: string | StyleSpec;                  // 样式 URL 或内联 JSON

  // 投影
  projection?: string;                         // 默认 'mercator'

  // 交互
  interactive?: boolean;                       // 默认 true
  scrollZoom?: boolean;                        // 默认 true
  boxZoom?: boolean;                           // 默认 true
  dragRotate?: boolean;                        // 默认 false（2D 模式默认关闭旋转）
  dragPan?: boolean;                           // 默认 true
  keyboard?: boolean;                          // 默认 true
  doubleClickZoom?: boolean;                   // 默认 true
  touchZoomRotate?: boolean;                   // 默认 true
  cooperativeGestures?: boolean;               // 默认 false（嵌入页面时需要 Ctrl+滚轮）

  // 渲染
  antialias?: boolean;                         // 默认 true
  maxPixelRatio?: number;                      // 默认 2
  preserveDrawingBuffer?: boolean;             // 默认 false（截图时需要 true）
  requestRenderMode?: boolean;                 // 默认 false

  // URL hash 同步
  hash?: boolean | string;                     // 默认 false，true 或自定义 hash 前缀

  // 国际化
  locale?: Record<string, string>;

  // 无障碍
  accessibleTitle?: string;                    // canvas ARIA label
}

export class Map2D {
  constructor(options: Map2DOptions);

  // === 视图控制 ===

  getCenter(): [number, number];
  setCenter(center: [number, number], options?: AnimationOptions): this;
  getZoom(): number;
  setZoom(zoom: number, options?: AnimationOptions): this;
  getBounds(): BBox2D;
  setBounds(bounds: BBox2D, options?: { padding?: PaddingOptions; duration?: number }): this;

  // 动画导航
  flyTo(options: FlyToOptions): this;
  easeTo(options: FlyToOptions): this;
  jumpTo(options: Omit<FlyToOptions, 'duration' | 'easing'>): this;
  fitBounds(bounds: BBox2D, options?: { padding?: PaddingOptions; duration?: number; maxZoom?: number }): this;
  stop(): this;                                // 停止当前动画
  isMoving(): boolean;
  isZooming(): boolean;

  // === 图层管理 ===

  addSource(id: string, source: SourceSpec): this;
  removeSource(id: string): this;
  getSource(id: string): DataSource | undefined;

  addLayer(layer: LayerSpec): this;
  removeLayer(id: string): this;
  getLayer(id: string): any | undefined;
  moveLayer(id: string, beforeId?: string): this;
  setLayoutProperty(layerId: string, name: string, value: any): this;
  setPaintProperty(layerId: string, name: string, value: any): this;
  setFilter(layerId: string, filter: any[]): this;
  getFilter(layerId: string): any[];

  // 图层可见性
  setLayerVisibility(layerId: string, visible: boolean): this;
  getLayerVisibility(layerId: string): boolean;

  // === 要素交互 ===

  // ★ v2.1: queryRenderedFeatures 改为异步（修复审计 #11）
  // 原因：内部依赖 L2/PickingEngine.pickAt 是异步操作（GPU readback）
  queryRenderedFeatures(
    pointOrBox?: [number, number] | [[number, number], [number, number]],
    options?: { layers?: string[]; filter?: FilterExpression },
  ): Promise<Feature[]>;                       // ★ 改为 Promise

  // querySourceFeatures 仍为同步（不经过 GPU，直接查询内存中的数据）
  querySourceFeatures(
    sourceId: string,
    options?: { sourceLayer?: string; filter?: FilterExpression },
  ): Feature[];

  // 要素状态（hover / selected / 自定义）
  setFeatureState(feature: { source: string; id: string | number }, state: Record<string, any>): void;
  getFeatureState(feature: { source: string; id: string | number }): Record<string, any>;
  removeFeatureState(feature: { source: string; id: string | number }, key?: string): void;

  // === 事件 ===

  on(type: MapEventType, callback: (event: MapEvent | MapMouseEvent) => void): this;
  on(type: MapEventType, layerId: string, callback: (event: MapMouseEvent) => void): this;
  once(type: MapEventType, callback: (event: MapEvent) => void): this;
  off(type: MapEventType, callback: (event: MapEvent) => void): this;

  // === UI Controls ===

  addControl(control: IControl, position?: ControlPosition): this;
  removeControl(control: IControl): this;
  hasControl(control: IControl): boolean;

  // === 坐标转换 ===

  // 经纬度 → 屏幕像素
  project(lngLat: [number, number]): [number, number];
  // 屏幕像素 → 经纬度
  unproject(point: [number, number]): [number, number];

  // === 样式 ===

  setStyle(style: string | StyleSpec): this;
  getStyle(): StyleSpec;

  // === Canvas ===

  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  resize(): this;

  // === 生命周期 ===

  loaded(): boolean;
  remove(): void;                              // 销毁实例
  triggerRepaint(): void;

  // === 逃生舱口 ===

  get renderer(): {
    readonly deviceManager: DeviceManager;
    readonly surface: SurfaceManager;
    readonly bufferPool: BufferPool;
    readonly textureManager: TextureManager;
    readonly uploader: GPUUploader;
    readonly shaderAssembler: ShaderAssembler;
    readonly pipelineCache: PipelineCache;
    readonly renderGraph: RenderGraph;
    readonly renderStats: RenderStats;
  };

  get scene(): {
    readonly sceneGraph: SceneGraph;
    readonly layerManager: LayerManager;
    readonly sourceManager: SourceManager;
    readonly styleEngine: StyleEngine;
    readonly labelManager: LabelManager;
  };

  get scheduler(): {
    readonly frameScheduler: FrameScheduler;
    readonly tileScheduler: TileScheduler;
    readonly workerPool: WorkerPool;
    readonly resourceManager: ResourceManager;
    readonly requestScheduler: RequestScheduler;
  };

  get extensions(): {
    readonly registry: ExtensionRegistry;
    readonly lifecycle: ExtensionLifecycle;
    readonly interactionManager: InteractionManager;
  };

  // ★ v2.1: 逃生舱口 camera 返回 L3 CameraController
  get camera(): CameraController;              // ★ 来自 @geoforge/runtime

  get config(): EngineConfig;
}

// === Control 接口 ===

export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface IControl {
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
  getDefaultPosition?(): ControlPosition;
}

// === 内置 Controls ===

export class NavigationControl implements IControl {
  constructor(options?: { showCompass?: boolean; showZoom?: boolean; visualizePitch?: boolean });
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
}

export class ScaleControl implements IControl {
  constructor(options?: { maxWidth?: number; unit?: 'imperial' | 'metric' | 'nautical' });
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
  setUnit(unit: 'imperial' | 'metric' | 'nautical'): void;
}

export class AttributionControl implements IControl {
  constructor(options?: { compact?: boolean; customAttribution?: string | string[] });
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
}

export class GeolocateControl implements IControl {
  constructor(options?: { trackUserLocation?: boolean; showAccuracyCircle?: boolean });
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
  trigger(): boolean;
}

export class FullscreenControl implements IControl {
  constructor(options?: { container?: HTMLElement });
  onAdd(map: Map2D): HTMLElement;
  onRemove(map: Map2D): void;
}
```

---

## 包 2：@geoforge/preset-25d — Map25D

```typescript
// ============================================================
// @geoforge/preset-25d
// 在 Map2D 基础上增加 pitch/bearing/建筑拉伸
// ============================================================

export interface Map25DOptions extends Map2DOptions {
  pitch?: number;                              // 默认 0, 范围 [0, maxPitch]
  bearing?: number;                            // 默认 0, 范围 [0, 360)
  maxPitch?: number;                           // 默认 85
}

export class Map25D extends Map2D {
  constructor(options: Map25DOptions);

  // === 2.5D 视图控制 ===

  getPitch(): number;
  setPitch(pitch: number, options?: AnimationOptions): this;
  getBearing(): number;
  setBearing(bearing: number, options?: AnimationOptions): this;
  rotateTo(bearing: number, options?: AnimationOptions): this;
  resetNorth(options?: AnimationOptions): this;
  resetNorthPitch(options?: AnimationOptions): this;
  snapToNorth(options?: AnimationOptions): this;

  // flyTo 继承自 Map2D，已支持 bearing/pitch 参数

  // === 光照（影响建筑拉伸阴影）===

  setLight(light: LightSpec): this;
  getLight(): LightSpec;
}

export interface LightSpec {
  anchor?: 'map' | 'viewport';
  color?: string;
  intensity?: number;
  position?: [number, number, number];         // [径向, 方位角, 极角]
}
```

---

## 包 3：@geoforge/preset-3d — Globe3D

```typescript
// ============================================================
// @geoforge/preset-3d
// 3D 数字地球，对标 CesiumJS 的核心 API
// ============================================================

export interface Globe3DOptions {
  container: string | HTMLElement;

  // 地形
  terrain?: {
    url: string;                               // 地形数据源 URL
    exaggeration?: number;                     // 高程夸大系数，默认 1
    requestVertexNormals?: boolean;            // 默认 true
  };

  // 影像底图
  imagery?: {
    url?: string;                              // 瓦片服务 URL
    type?: 'wmts' | 'tms' | 'xyz';            // 默认 'xyz'
    maximumLevel?: number;
  };

  // 效果
  atmosphere?: boolean;                        // 默认 true
  shadows?: boolean;                           // 默认 false
  skybox?: boolean;                            // 默认 true
  fog?: boolean;                               // 默认 true
  baseColor?: [number, number, number, number]; // 地球底色 RGBA

  // 渲染
  targetFrameRate?: number;                    // 默认 60
  requestRenderMode?: boolean;                 // 默认 false
  antialias?: boolean;                         // 默认 true
  maxPixelRatio?: number;                      // 默认 2

  // 交互
  enableRotate?: boolean;                      // 默认 true
  enableZoom?: boolean;                        // 默认 true
  enableTilt?: boolean;                        // 默认 true
  enableLook?: boolean;                        // 默认 true（自由观看）
  minimumZoomDistance?: number;                 // 最小缩放距离（米），默认 1
  maximumZoomDistance?: number;                 // 最大缩放距离（米），默认 Infinity
}

export class Globe3D {
  constructor(options: Globe3DOptions);

  // === 相机控制 ===

  // 飞行到目标位置
  flyTo(options: {
    destination: [number, number, number];      // [lon, lat, alt]
    orientation?: {
      bearing?: number;                        // ★ v2.1: 原 heading → bearing（弧度）
      pitch?: number;                          // 俯仰角（弧度）
      roll?: number;
    };
    duration?: number;
  }): this;

  // 看向目标
  lookAt(
    target: [number, number, number],           // [lon, lat, alt]
    offset?: { heading?: number; pitch?: number; range?: number },
  ): this;

  // 缩放到范围
  flyToBounds(bounds: BBox2D, options?: { duration?: number; heading?: number; pitch?: number }): this;

  // ★ v2.1: getCameraPosition 统一使用 bearing（弧度），删除 heading
  getCameraPosition(): {
    lon: number; lat: number; alt: number;
    bearing: number;                           // ★ 原 heading → bearing（修复审计 #3）
    pitch: number;
    roll: number;
  };

  // 设置相机位置（无动画）
  setCameraPosition(position: {
    lon: number; lat: number; alt: number;
    bearing?: number;                          // ★ 原 heading → bearing
    pitch?: number; roll?: number;
  }): this;

  // === 图层管理 ===

  addImageryLayer(options: { url: string; type?: string; alpha?: number; brightness?: number }): string;
  removeImageryLayer(id: string): this;

  add3DTileset(options: {
    url: string;
    maximumScreenSpaceError?: number;          // 默认 16
    maximumMemoryUsage?: number;               // 默认 512 MB
    show?: boolean;
  }): string;
  remove3DTileset(id: string): this;

  addGeoJSON(data: any, options?: { clampToGround?: boolean; style?: Record<string, any> }): string;
  removeGeoJSON(id: string): this;

  addEntity(entity: EntitySpec): string;
  removeEntity(id: string): this;

  // === 要素交互 ===

  // ★ v2.1: queryRenderedFeatures 异步（与 Map2D 一致）
  queryRenderedFeatures(
    point?: [number, number],
    options?: { layers?: string[] },
  ): Promise<Feature[]>;

  // === 地形 ===

  setTerrainExaggeration(value: number): this;
  getTerrainHeight(lon: number, lat: number): Promise<number>;

  // === 效果控制 ===

  setAtmosphereEnabled(enabled: boolean): this;
  setShadowsEnabled(enabled: boolean): this;
  setSkyboxEnabled(enabled: boolean): this;
  setFogEnabled(enabled: boolean): this;

  // === 时间（太阳位置、阴影方向）===

  setDateTime(date: Date): this;
  getDateTime(): Date;
  setClockMultiplier(multiplier: number): this;

  // === 坐标转换 ===

  // 经纬度+高程 → 屏幕像素
  cartographicToScreen(lon: number, lat: number, alt?: number): [number, number] | null;
  // 屏幕像素 → 经纬度+高程（射线与地球求交）
  screenToCartographic(x: number, y: number): [number, number, number] | null;

  // === 视图模式切换（morph 动画）===

  morphTo2D(options?: { duration?: number }): this;
  morphTo25D(options?: { duration?: number }): this;
  morphTo3D(options?: { duration?: number }): this;
  readonly currentViewMode: '2d' | '25d' | '3d';

  // === 事件 ===

  on(type: MapEventType | '3dtiles-loaded' | 'terrain-loaded' | 'morph-start' | 'morph-end',
     callback: (event: any) => void): this;
  off(type: string, callback: (event: any) => void): this;

  // === Canvas / 生命周期 ===

  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  resize(): this;
  remove(): void;

  // === 逃生舱口 ===

  // ★ v2.1: camera 返回 L3 CameraController (Camera3D 实现)
  get camera(): CameraController;
  get renderer(): { /* 同 Map2D */ };
  get scene(): { /* 同 Map2D + globe 特有 */ };
  get scheduler(): { /* 同 Map2D */ };
  get extensions(): { /* 同 Map2D */ };
  get config(): EngineConfig;
}

// Entity 规格（3D 对象）
export interface EntitySpec {
  readonly id?: string;
  readonly position: [number, number, number]; // [lon, lat, alt]
  readonly model?: { url: string; scale?: number; minimumPixelSize?: number };
  readonly billboard?: { image: string; scale?: number; color?: string };
  readonly label?: { text: string; font?: string; fillColor?: string; outlineColor?: string };
  readonly polyline?: { positions: [number, number, number][]; width?: number; color?: string };
  readonly polygon?: { hierarchy: [number, number, number][]; color?: string; extrudedHeight?: number };
}
```

---

## 包 4：@geoforge/preset-full — MapFull

```typescript
// ============================================================
// @geoforge/preset-full
// 所有功能 + 运行时模式切换
// ============================================================

export interface MapFullOptions extends Map25DOptions, Omit<Globe3DOptions, 'container'> {
  mode: '2d' | '25d' | '3d';                  // 初始模式
}

export class MapFull extends Map25D {
  constructor(options: MapFullOptions);

  // === 模式切换（内部使用 L3/ViewMorph）===

  setMode(mode: '2d' | '25d' | '3d', options?: { duration?: number }): this;
  readonly currentMode: '2d' | '25d' | '3d';

  // === 3D 功能（仅在 3D 模式下可用）===

  add3DTileset(options: Parameters<Globe3D['add3DTileset']>[0]): string;
  remove3DTileset(id: string): this;
  setTerrainExaggeration(value: number): this;
  getTerrainHeight(lon: number, lat: number): Promise<number>;
  setAtmosphereEnabled(enabled: boolean): this;
  setShadowsEnabled(enabled: boolean): this;
  setDateTime(date: Date): this;

  // === 事件（合并所有模式的事件）===

  // ★ v2.1: 新增 modechange 事件
  on(type: MapEventType | '3dtiles-loaded' | 'terrain-loaded' | 'morph-start' | 'morph-end' | 'modechange',
     callback: (event: any) => void): this;

  // Re-export 所有可选包（Tree-Shaking 仍然有效）
}
```

---

## L6 内部初始化流程（以 Map2D 为例）

```typescript
// Map2D constructor 内部做的事情

class Map2D {
  constructor(options: Map2DOptions) {
    const config = createDefaultConfig(options);

    // 1. 创建 Canvas
    const canvas = createCanvas(options.container);

    // 2. 初始化 L0
    const l0 = {
      coordinateSystem: createCoordinateSystem(),
      precision: createPrecisionManager(),
      logger: createLogger(config.logLevel),
      config,
    };

    // 3. 初始化 L1（异步）
    this._initPromise = (async () => {
      const l1 = await initializeL1(canvas, config);

      // 4. 初始化 L2
      const l2 = await initializeL2(l1, config);

      // 5. 初始化 L3
      const l3 = initializeL3(l1, l2, config);

      // 6. 初始化 L4
      const l4 = initializeL4(l0, l1, l2, l3);

      // 7. 初始化 L5
      const l5 = initializeL5(l0, l1, l2, l3);

      // 8. 创建 CameraController（★ v2.1 补充）
      const camera = createCamera2D({
        center: options.center || [0, 0],
        zoom: options.zoom || 1,
        minZoom: options.minZoom || 0,
        maxZoom: options.maxZoom || 22,
        maxBounds: options.maxBounds,
        inertia: true,
      });
      // camera 注册到 frameScheduler
      l3.frameScheduler.register({
        id: 'camera', phase: 'update', priority: 5,
        execute: (dt) => camera.update(dt, l1.surface.getViewport()),
      });

      // 9. 注册默认投影
      l5.registry.registerProjection('mercator', createMercatorProjection());

      // 10. 注册默认交互
      l5.interactionManager.setDefaultToolEnabled('pan', options.dragPan !== false);
      l5.interactionManager.setDefaultToolEnabled('zoom', options.scrollZoom !== false);
      l5.interactionManager.setDefaultToolEnabled('rotate', options.dragRotate === true);

      // 11. 加载样式（如果提供）
      if (options.style) {
        await this._loadStyle(options.style);
      }

      // 12. 设置初始视图
      this.jumpTo({
        center: options.center || [0, 0],
        zoom: options.zoom || 1,
      });

      // 13. 添加默认 Controls
      this.addControl(new AttributionControl(), 'bottom-right');

      // 14. 启动帧循环
      l3.frameScheduler.start();

      // 15. 触发 load 事件
      this.emit('load');
    })();
  }
}

// Globe3D constructor 内部（★ v2.1 补充）
// 步骤 8 替换为：
const camera = createCamera3D({
  position: options.initialPosition || { lon: 0, lat: 0, alt: 20000000 },
  enableCollision: true,
  minimumZoomDistance: 1,
  maximumZoomDistance: Infinity,
});
```

---

## 从预设到底层的逃生路径

```typescript
// 场景：用户从 preset-2d 起步，发现需要自定义 Shader

import { Map } from '@geoforge/preset-2d';

const map = new Map({ container: 'map', center: [116.4, 39.9], zoom: 10 });

// 第一步：通过逃生舱口访问 ShaderAssembler
const { shaderAssembler } = map.renderer;

// 第二步：注册自定义 Shader Hook
shaderAssembler.registerHook({
  id: 'my-heatmap-effect',
  hookPoint: 'fragment_color_after_style',
  wgslCode: `
    let heat = smoothstep(0.0, 1.0, temperature);
    color = mix(color, vec4<f32>(heat, 0.0, 1.0 - heat, 1.0), 0.5);
  `,
  priority: 0,
});

// 第三步：如果需要更深的控制，直接使用底层模块
import { createCustomLayer } from '@geoforge/core';

map.addLayer({
  id: 'particle-layer',
  type: 'custom',
  render(encoder, camera) {
    // 完全自定义的 WebGPU 渲染
    encoder.setPipeline(myPipeline);
    encoder.setBindGroup(0, myBindGroup);
    encoder.draw(particleCount);
  }
});
```

---

## L6 模块统计

| 预设包 | 公共方法数 | Options 字段数 | 内置 Controls | v2.1 变更 |
|--------|-----------|--------------|-------------|----------|
| Map2D | ~50 | ~25 | Navigation, Scale, Attribution, Geolocate, Fullscreen | queryRenderedFeatures 异步 |
| Map25D | +8 | +4 | — (继承 Map2D) | — |
| Globe3D | ~40 | ~20 | — | heading → bearing |
| MapFull | +10 | +1 (mode) | — (继承全部) | +modechange 事件 |
| **合计** | **~108 公共方法** | | | |

4 个 npm 包，108 个公共方法，5 个内置 UI Controls。零新逻辑，全部基于 L0~L5 的组装。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| `queryRenderedFeatures` 返回 `Promise<Feature[]>` | 不一致 #11 | L2 Picking 是异步的 |
| Globe3D heading → bearing | 不一致 #3 | 统一使用 bearing（弧度） |
| `get camera()` 返回 CameraController | 缺口 #1 对接 | 来自 @geoforge/runtime |
| Feature / PickResult / CameraState 引用 L0 | 不一致 #3 #4 #6 | 消除跨层类型定义 |
| MapMouseEvent.features 类型为 PickResult[] | 不一致 #6 | 来自 L0 定义 |
| 初始化流程补充 CameraController 创建 | 缺口 #1 | Map2D 用 Camera2D，Globe3D 用 Camera3D |
