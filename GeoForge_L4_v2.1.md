# GeoForge 架构设计 — L4 场景层完整接口定义（v2.1）

> **定位**：L4 是引擎的"语义层"——图层/数据源/样式/标注/空间查询。
> **包名**：@geoforge/scene
> **模块数**：11 个核心模块（不变）
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
} from '@geoforge/core';

import type { CameraController, CameraAnimation } from '@geoforge/runtime';
```

---

## 模块 1~11：核心场景模块

与 v2.0 完全相同，仅以下 3 处变更：

### 变更 1：Feature 引用 L0

```typescript
// v2.0: Feature 在 L4/SpatialQuery 本地定义
// v2.1: 删除本地定义，从 @geoforge/core import
import type { Feature } from '@geoforge/core';
```

### 变更 2：StyleExpression / FilterExpression 引用 L0

```typescript
// v2.0: StyleExpression 在 L4/StyleEngine 本地定义
// v2.1: 删除本地定义，从 @geoforge/core/types/style-spec import
import type { StyleExpression, FilterExpression } from '@geoforge/core';
```

### 变更 3：AnimationManager.flyTo 委托给 CameraController

```typescript
export interface AnimationManager {
  // ... 其他方法不变 ...

  // ★ v2.1：flyTo 委托给 CameraController
  flyTo(camera: CameraController, options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation;
}
```

### 确认：Layer 接口与 L2 兼容

```typescript
export interface Layer {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly projection: string;
  visible: boolean;
  opacity: number;
  zIndex: number;

  onAdd(context: LayerContext): void;
  onRemove(): void;
  onUpdate(deltaTime: number, camera: CameraState): void;
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;
  readonly isTransparent: boolean;
  readonly renderOrder: number;

  setPaintProperty(name: string, value: any): void;
  setLayoutProperty(name: string, value: any): void;
  getPaintProperty(name: string): any;
  getLayoutProperty(name: string): any;
  queryFeatures?(bbox: BBox2D, filter?: FilterExpression): Feature[];
  queryRenderedFeatures?(point: [number, number]): Feature[];
  setFeatureState?(featureId: string, state: Record<string, any>): void;
  getFeatureState?(featureId: string): Record<string, any> | undefined;
  readonly isLoaded: boolean;
  setData?(data: any): void;
  getData?(): any;
}
```

---

## 新增：核心图层包接口（修复审计缺口 #2）

### layer-tile-raster — 栅格瓦片图层

```typescript
// @geoforge/layer-tile-raster — 解决 #4.1 瓦片接缝

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
// @geoforge/layer-tile-vector — 解决 #5.1 三角剖分、#5.2 宽线渲染

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
// @geoforge/layer-geojson — 解决 #9.3 大 GeoJSON

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
// @geoforge/layer-terrain — 解决 #4.2 LOD 裂缝、#8.3 地形叠加

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
// @geoforge/globe — 解决 #8.1 大气散射、#8.4 阴影

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

## 新增：端到端数据流（修复审计缺口 #4）

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

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| Feature/StyleExpression/FilterExpression 引用 L0 | 不一致 #4 #12 |
| 新增 layer-tile-raster | 缺口 #2（#4.1） |
| 新增 layer-tile-vector | 缺口 #2（#5.1 #5.2） |
| 新增 layer-geojson | 缺口 #2（#9.3） |
| 新增 layer-terrain | 缺口 #2（#4.2 #8.3） |
| 新增 globe | 缺口 #2（#8.1 #8.4） |
| 新增端到端数据流 | 缺口 #4 |
| AnimationManager.flyTo → CameraController | 与 L3 对接 |
| Layer 确认与 L2 兼容 | 不一致 #1 |
