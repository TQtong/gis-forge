# GIS-Forge 架构设计 — L3 调度层完整接口定义（v2.1）

> **定位**：L3 管理引擎的"时间维度"——帧循环、瓦片调度、Worker 任务、网络限流、内存预算、错误恢复。
> **包名**：@gis-forge/runtime
> **模块数**：7 + **新增 CameraController 模块 + 3 个相机实现包接口**
>
> **v2.1 修订**：
> - **新增 CameraController 接口 + camera-2d / camera-25d / camera-3d 实现规格**（修复审计缺口 #1，影响 7 个问题覆盖）
> - CameraState 删除本地定义，统一引用 L0/types/viewport.ts（修复审计不一致 #3）
> - WorkerTaskType 明确为 16 种（修复审计不一致 #2，概要设计中"12 种"的说法已过时）
> - 新增 view-morph 包接口（修复审计缺口 #1 中 #7.3 视图过渡问题）

---

## 类型依赖声明

```typescript
import type { Vec3f, Mat4f, Quatf, BBox2D, Viewport, CameraState } from '@gis-forge/core';
```

---

## 模块清单（v2.1）

| # | 模块 | 文件 | v2.1 状态 |
|---|------|------|----------|
| 1 | FrameScheduler | `frame-scheduler.ts` | 不变 |
| 2 | TileScheduler | `tile-scheduler.ts` | **修订**：CameraState 引用 L0 |
| 3 | WorkerPool | `worker-pool.ts` | **修订**：明确 16 种任务类型 |
| 4 | ResourceManager | `resource-manager.ts` | 不变 |
| 5 | MemoryBudget | `memory-budget.ts` | 不变 |
| 6 | RequestScheduler | `request-scheduler.ts` | 不变 |
| 7 | ErrorRecovery | `error-recovery.ts` | 不变 |
| 8 | **CameraController** | `camera-controller.ts` | **新增** |
| 9 | **Camera2D** | `camera-2d.ts` | **新增**（可选包 @gis-forge/camera-2d）|
| 10 | **Camera25D** | `camera-25d.ts` | **新增**（可选包 @gis-forge/camera-25d）|
| 11 | **Camera3D** | `camera-3d.ts` | **新增**（可选包 @gis-forge/camera-3d）|
| 12 | **ViewMorph** | `view-morph.ts` | **新增**（可选包 @gis-forge/view-morph）|

---

## 模块 1~7：不变的部分

FrameScheduler、ResourceManager、MemoryBudget、RequestScheduler、ErrorRecovery 与 v2.0 完全相同。

TileScheduler 仅删除本地 `CameraState` / `Viewport` 定义，改为从 `@gis-forge/core` import（接口方法不变）。

WorkerPool 的 `WorkerTaskType` 更新如下：

```typescript
// v2.1: 明确 16 种任务类型（修复审计不一致 #2，概要设计中"12 种"已过时）
export type WorkerTaskType =
  | 'mvt-decode'              // 1. MVT Protobuf 解码
  | 'raster-decode'           // 2. 栅格图像解码
  | 'geojson-parse'           // 3. GeoJSON 解析 + geojson-vt 切片
  | 'triangulate'             // 4. earcut / Delaunay 三角剖分
  | 'simplify'                // 5. Douglas-Peucker / Visvalingam
  | 'rtree-build'             // 6. R-Tree 构建
  | 'rtree-query'             // 7. R-Tree 范围查询
  | 'label-collision'         // 8. 标注碰撞粗筛（CPU R-Tree）
  | 'text-shaping'            // 9. 文字排版
  | 'split-double'            // 10. Float64→SplitDouble 批量转换
  | 'terrain-mesh'            // 11. DEM→地形三角网 + 裙边
  | 'tiles3d-bvh'             // 12. 3D Tiles BVH 遍历
  | 'antimeridian-cut'        // 13. 日期线几何切割
  | 'cluster'                 // 14. Supercluster 点聚合
  | 'boolean-op'              // 15. 布尔运算
  | 'custom';                 // 16. 用户自定义
```

---

## 新增模块 8：CameraController — 相机控制器接口

```typescript
// ============================================================
// camera-controller.ts — 相机控制器抽象接口
// 修复审计缺口 #1（CameraController 从未定义）
//
// 这是所有相机实现的基类接口。Camera2D / Camera25D / Camera3D
// 分别实现此接口。L4/AnimationManager、L5/InteractionManager、
// L6/Map2D.get camera() 全部引用此接口。
// ============================================================

export type CameraType = '2d' | '25d' | '3d';

export interface CameraController {
  readonly type: CameraType;

  // --- 状态快照（只读，每帧开始时由 update 计算）---
  readonly state: CameraState;                 // CameraState 来自 L0/types

  // --- 视图控制 ---
  setCenter(center: [number, number]): void;
  setZoom(zoom: number): void;
  setBearing(bearing: number): void;           // 弧度
  setPitch(pitch: number): void;               // 弧度

  // 批量设置（避免多次触发矩阵重算）
  jumpTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
  }): void;

  // --- 动画导航 ---
  flyTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    altitude?: number;                         // 3D 模式下的目标高度（米）
    duration?: number;                         // 毫秒，默认 1500
    easing?: (t: number) => number;
  }): CameraAnimation;

  easeTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
  }): CameraAnimation;

  // 停止当前动画
  stop(): void;
  readonly isAnimating: boolean;

  // --- 约束 ---
  readonly constraints: CameraConstraints;
  setConstraints(constraints: Partial<CameraConstraints>): void;

  // --- 每帧更新（由 FrameScheduler 调用）---
  update(deltaTime: number, viewport: Viewport): CameraState;

  // --- 输入处理（由 InteractionManager 分发）---
  handlePanStart(screenX: number, screenY: number): void;
  handlePanMove(screenX: number, screenY: number): void;
  handlePanEnd(): void;
  handleZoom(delta: number, screenX: number, screenY: number): void;
  handleRotate(bearingDelta: number, pitchDelta: number): void;

  // --- 惯性动画（修复审计问题 #7.2）---
  // 松手后基于速度采样的惯性滑动
  readonly inertiaEnabled: boolean;
  setInertiaEnabled(enabled: boolean): void;

  // --- 事件 ---
  onMoveStart(callback: () => void): () => void;
  onMove(callback: (state: CameraState) => void): () => void;
  onMoveEnd(callback: () => void): () => void;

  // --- 销毁 ---
  destroy(): void;
}

export interface CameraConstraints {
  readonly minZoom: number;                    // 默认 0
  readonly maxZoom: number;                    // 默认 22
  readonly minPitch: number;                   // 默认 0
  readonly maxPitch: number;                   // 默认 85°（~1.48 弧度）
  readonly maxBounds?: BBox2D;                 // 限制地图范围
}

export interface CameraAnimation {
  readonly id: string;
  readonly state: 'running' | 'finished' | 'cancelled';
  cancel(): void;
  readonly finished: Promise<void>;
}
```

---

## 新增模块 9：Camera2D — 2D 正交相机

```typescript
// ============================================================
// camera-2d.ts — 2D 正交相机实现规格
// 包名：@gis-forge/camera-2d
// 解决问题：#7.2 惯性动画
// ============================================================

export interface Camera2DOptions {
  center?: [number, number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  maxBounds?: BBox2D;
  inertia?: boolean;                           // 默认 true
  inertiaDecay?: number;                       // 衰减系数，默认 0.85
}

// Camera2D implements CameraController（type = '2d'）

// 实现要点：
// - 投影矩阵：mat4.ortho()，基于当前 zoom 和 viewport 计算
// - 视图矩阵：mat4.lookAt()，eye 在地图中心正上方
// - bearing 固定为 0（2D 不旋转），pitch 固定为 0（正俯视）
// - 惯性：松手时采样最近 5 帧的速度，用指数衰减驱动 pan 动画
// - flyTo：使用 Bezier 曲线在 zoom/center 空间做插值
// - 边界约束：center 被 maxBounds 限制
```

---

## 新增模块 10：Camera25D — 2.5D 透视相机

```typescript
// ============================================================
// camera-25d.ts — 2.5D 透视相机实现规格
// 包名：@gis-forge/camera-25d
// 解决问题：#7.2 惯性动画
// ============================================================

export interface Camera25DOptions extends Camera2DOptions {
  bearing?: number;                            // 默认 0
  pitch?: number;                              // 默认 0
  maxPitch?: number;                           // 默认 85°
}

// Camera25D implements CameraController（type = '25d'）

// 实现要点：
// - 投影矩阵：mat4.perspectiveReversedZ()，fov 根据 pitch 动态调整
// - 视图矩阵：基于 center + zoom + bearing + pitch 计算
//   eye 位置 = center 偏移 altitude × sin(pitch) 向后 + altitude × cos(pitch) 向上
// - bearing/pitch 有约束（maxPitch）
// - 惯性：pan + rotate + pitch 都有独立的惯性衰减
// - 高 pitch 角时自动调整 far plane（避免看到地平线以外）
```

---

## 新增模块 11：Camera3D — 3D 轨道相机

```typescript
// ============================================================
// camera-3d.ts — 3D 地球轨道相机实现规格
// 包名：@gis-forge/camera-3d
// 解决问题：#7.1 地形碰撞、#7.2 惯性动画
// ============================================================

export interface Camera3DOptions {
  position?: { lon: number; lat: number; alt: number };
  heading?: number;                            // 方位角（弧度）
  pitch?: number;                              // 俯仰角（弧度）
  roll?: number;                               // 翻滚角（弧度）
  minimumZoomDistance?: number;                 // 最小缩放距离（米），默认 1
  maximumZoomDistance?: number;                 // 最大缩放距离（米），默认 Infinity
  enableCollision?: boolean;                   // 地形碰撞检测，默认 true
}

export interface Camera3D extends CameraController {
  readonly type: '3d';

  // 3D 特有方法
  setPosition(lon: number, lat: number, alt: number): void;
  getPosition(): { lon: number; lat: number; alt: number };
  setHeadingPitchRoll(heading: number, pitch: number, roll: number): void;

  // 看向目标
  lookAt(
    target: [number, number, number],          // [lon, lat, alt]
    offset?: { heading?: number; pitch?: number; range?: number },
  ): void;

  // 地形碰撞（修复审计问题 #7.1）
  readonly terrainCollisionEnabled: boolean;
  setTerrainCollisionEnabled(enabled: boolean): void;
  // 内部实现：每帧查询相机位置下方的地形高度（异步），
  // 如果相机高度 < 地形高度 + minAltitudeAboveTerrain，则推高相机
  setMinAltitudeAboveTerrain(meters: number): void;
  queryTerrainHeight(lon: number, lat: number): Promise<number>;

  // 3D 飞行
  flyToPosition(options: {
    lon: number; lat: number; alt: number;
    heading?: number; pitch?: number;
    duration?: number;
  }): CameraAnimation;
}

// 实现要点：
// - 坐标系：ECEF（与 L0/ellipsoid 对接）
// - 投影矩阵：mat4.perspectiveReversedZInfinite()（地球级场景）
// - 视图矩阵：基于 ECEF 位置 + 四元数旋转（heading/pitch/roll）
// - 地形碰撞：异步查询 TerrainLayer 的 DEM 数据，平滑插值防止突跳
// - 惯性：轨道旋转使用四元数 slerp 衰减
// - flyTo：Great Circle Arc 飞行路径 + 高度抛物线
```

---

## 新增模块 12：ViewMorph — 视图模式过渡

```typescript
// ============================================================
// view-morph.ts — 2D ↔ 2.5D ↔ 3D 视图过渡动画
// 包名：@gis-forge/view-morph
// 解决问题：#7.3 视图过渡
// ============================================================

export type ViewMode = '2d' | '25d' | '3d';

export interface ViewMorphOptions {
  duration?: number;                           // 默认 2000ms
  easing?: (t: number) => number;
}

export interface ViewMorph {
  // 执行过渡
  morphTo(
    targetMode: ViewMode,
    fromCamera: CameraController,
    toCamera: CameraController,
    options?: ViewMorphOptions,
  ): ViewMorphAnimation;

  // 当前状态
  readonly isMorphing: boolean;
  readonly currentMode: ViewMode;
  readonly progress: number;                   // 0~1

  // 取消过渡
  cancel(): void;
}

export interface ViewMorphAnimation {
  readonly finished: Promise<void>;
  cancel(): void;
}

// 实现要点：
// - 2D → 2.5D：线性插值 pitch 0→目标 pitch，投影矩阵 ortho→perspective 渐变
// - 2D → 3D：分两阶段：
//   Phase 1: 2D→2.5D（pitch 升起）
//   Phase 2: 2.5D→3D（墨卡托坐标→ECEF 顶点变形 + 投影矩阵混合）
// - CesiumJS 的实现参考：顶点位置 lerp(mercator, ecef, t) + 投影矩阵 lerp
// - Mapbox GL v3 的实现参考：低 zoom 自动 mercator→globe 过渡
// - 过渡期间：两个相机同时计算 CameraState，RenderGraph 使用混合后的矩阵
```

---

## L3 初始化流程（v2.1 更新）

```typescript
function initializeL3(l1: L1Modules, l2: L2Modules, config: EngineConfig) {
  // 1~7 与 v2.0 相同

  // 8. CameraController（根据预设模式创建）
  let camera: CameraController;
  if (config.mode === '3d') {
    camera = createCamera3D(config.camera3dOptions);
  } else if (config.mode === '25d') {
    camera = createCamera25D(config.camera25dOptions);
  } else {
    camera = createCamera2D(config.camera2dOptions);
  }

  // 9. ViewMorph（可选，仅 preset-full 需要）
  const viewMorph = config.enableViewMorph ? createViewMorph() : null;

  // 注册相机到帧循环
  frameScheduler.register({
    id: 'camera', phase: 'update', priority: 5,
    execute: (dt) => camera.update(dt, l1.surface.getViewport()),
  });

  return {
    errorRecovery, requestScheduler, workerPool,
    resourceManager, memoryBudget, tileScheduler, frameScheduler,
    camera, viewMorph,   // ★ v2.1 新增
  };
}
```

---

## L3 模块统计（v2.1）

| 模块 | 公共方法数 | v2.1 变更 |
|------|-----------|----------|
| FrameScheduler | 10 | — |
| TileScheduler | 10 | CameraState 引用 L0 |
| WorkerPool | 8 | 明确 16 种 |
| ResourceManager | 12 | — |
| MemoryBudget | 5 | — |
| RequestScheduler | 7 | — |
| ErrorRecovery | 9 | — |
| **CameraController** | **18** | **新增** |
| **Camera2D** | — (实现 CameraController) | **新增** |
| **Camera25D** | — (扩展 Camera2D) | **新增** |
| **Camera3D** | **+8 (3D 特有)** | **新增** |
| **ViewMorph** | **4** | **新增** |
| **合计** | **~91 个公共方法** | +30 |

---

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| 新增 CameraController 接口 | 缺口 #1（影响 #7.1 #7.2 + L6 所有 camera 逃生舱口）|
| 新增 Camera2D 实现规格 | #7.2 惯性动画 |
| 新增 Camera25D 实现规格 | #7.2 惯性动画 |
| 新增 Camera3D 实现规格 | #7.1 地形碰撞 + #7.2 惯性 |
| 新增 ViewMorph 接口 | #7.3 视图过渡 |
| CameraState 删除本地定义，引用 L0 | 不一致 #3 |
| WorkerTaskType 明确为 16 种 | 不一致 #2 |
