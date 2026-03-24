# GeoForge 架构设计 — L6 预设层完整接口定义（v2.1）

> **定位**：面向最终用户的便利层。"5 行代码出地图"。
> **包数**：4 个 npm 包
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

## 共享类型定义

与 v2.0 相同（FlyToOptions、PaddingOptions、AnimationOptions、MapEventType、MapEvent、MapMouseEvent、LayerSpec、SourceSpec 等），但：

```typescript
// ★ v2.1: MapMouseEvent.features 类型改为 PickResult[]（来自 L0）
export interface MapMouseEvent extends MapEvent {
  readonly lngLat: [number, number];
  readonly point: [number, number];
  readonly features?: PickResult[];            // ★ L0 定义
  readonly originalEvent: MouseEvent;
  preventDefault(): void;
}
```

---

## 包 1：@geoforge/preset-2d — Map2D 修订版

与 v2.0 完全相同的 Options 和大部分方法，仅以下变更：

```typescript
export class Map2D {
  constructor(options: Map2DOptions);

  // ... 视图控制（getCenter/setCenter/flyTo/easeTo 等）不变 ...
  // ... 图层管理（addSource/addLayer/removeLayer 等）不变 ...

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

  // ... 要素状态（setFeatureState/getFeatureState）不变 ...
  // ... 事件（on/once/off）不变 ...
  // ... Controls（addControl/removeControl）不变 ...
  // ... 坐标转换（project/unproject）不变 ...
  // ... 样式（setStyle/getStyle）不变 ...
  // ... Canvas / 生命周期 不变 ...

  // ★ v2.1: 逃生舱口 camera 返回 L3 CameraController
  get camera(): CameraController;              // ★ 来自 @geoforge/runtime

  // 其他逃生舱口不变
  get renderer(): { /* 同 v2.0 */ };
  get scene(): { /* 同 v2.0 */ };
  get scheduler(): { /* 同 v2.0 */ };
  get extensions(): { /* 同 v2.0 */ };
  get config(): EngineConfig;
}
```

---

## 包 2：@geoforge/preset-25d — Map25D

与 v2.0 完全相同，不变（继承 Map2D 的 v2.1 变更自动生效）。

---

## 包 3：@geoforge/preset-3d — Globe3D 修订版

```typescript
export class Globe3D {
  constructor(options: Globe3DOptions);

  // ★ v2.1: getCameraPosition 统一使用 bearing（弧度），删除 heading
  getCameraPosition(): {
    lon: number; lat: number; alt: number;
    bearing: number;                           // ★ 原 heading → bearing（修复审计 #3）
    pitch: number;
    roll: number;
  };

  setCameraPosition(position: {
    lon: number; lat: number; alt: number;
    bearing?: number;                          // ★ 原 heading → bearing
    pitch?: number; roll?: number;
  }): this;

  // flyTo 参数也统一
  flyTo(options: {
    destination: [number, number, number];
    orientation?: {
      bearing?: number;                        // ★ 原 heading → bearing
      pitch?: number;
      roll?: number;
    };
    duration?: number;
  }): this;

  // ★ v2.1: queryRenderedFeatures 异步（与 Map2D 一致）
  queryRenderedFeatures(
    point?: [number, number],
    options?: { layers?: string[] },
  ): Promise<Feature[]>;

  // ... 其他方法不变（lookAt/flyToBounds/addImageryLayer/add3DTileset 等）...
  // ... 地形（setTerrainExaggeration/getTerrainHeight）不变 ...
  // ... 效果（setAtmosphereEnabled/setShadowsEnabled 等）不变 ...
  // ... 时间（setDateTime/setClockMultiplier）不变 ...
  // ... 坐标转换（cartographicToScreen/screenToCartographic）不变 ...
  // ... 视图模式切换（morphTo2D/25D/3D）不变 ...
  // ... 事件 不变 ...

  // ★ v2.1: 逃生舱口
  get camera(): CameraController;              // ★ L3 CameraController (Camera3D 实现)
  get renderer(): { /* 同 Map2D */ };
  get scene(): { /* 同 Map2D + globe */ };
  get scheduler(): { /* 同 Map2D */ };
  get extensions(): { /* 同 Map2D */ };
  get config(): EngineConfig;
}
```

---

## 包 4：@geoforge/preset-full — MapFull 修订版

```typescript
export class MapFull extends Map25D {
  constructor(options: MapFullOptions);

  // 模式切换（内部使用 L3/ViewMorph）
  setMode(mode: '2d' | '25d' | '3d', options?: { duration?: number }): this;
  readonly currentMode: '2d' | '25d' | '3d';

  // 3D 功能代理
  add3DTileset(options: Parameters<Globe3D['add3DTileset']>[0]): string;
  remove3DTileset(id: string): this;
  setTerrainExaggeration(value: number): this;
  getTerrainHeight(lon: number, lat: number): Promise<number>;
  setAtmosphereEnabled(enabled: boolean): this;
  setShadowsEnabled(enabled: boolean): this;
  setDateTime(date: Date): this;

  // ★ v2.1: modechange 事件
  on(type: MapEventType | 'modechange' | 'morph-start' | 'morph-end',
     callback: (event: any) => void): this;
}
```

---

## 内置 Controls

与 v2.0 完全相同（NavigationControl、ScaleControl、AttributionControl、GeolocateControl、FullscreenControl），不变。

---

## L6 内部初始化流程

与 v2.0 相同，补充：

```typescript
// Map2D constructor 内部（v2.1 补充）
// 步骤 8: 创建 CameraController
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

// Globe3D constructor 内部
const camera = createCamera3D({
  position: options.initialPosition || { lon: 0, lat: 0, alt: 20000000 },
  enableCollision: true,
  minimumZoomDistance: 1,
  maximumZoomDistance: Infinity,
});
```

---

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| `queryRenderedFeatures` 返回 `Promise<Feature[]>` | 不一致 #11 |
| Globe3D heading → bearing | 不一致 #3 |
| `get camera()` 返回 CameraController | 缺口 #1 对接 |
| Feature / PickResult / CameraState 引用 L0 | 不一致 #3 #4 #6 |
| MapMouseEvent.features 类型为 PickResult[] | 不一致 #6 |
| 初始化流程补充 CameraController 创建 | 缺口 #1 |
