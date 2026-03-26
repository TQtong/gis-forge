# Globe3D 文件拆分方案 v2

> globe-3d.ts 当前 4164 行，Globe3D 类 3106 行
> 拆分目标：每文件 200-500 行，职责单一，无循环依赖
> v2：12 项审计修复——constants/buffers 分离、GlobeGPURefs 完整字段、函数签名补全、
>     barrel export、bootstrapAsync 归属、每步验证方法

---

## 一、拆分总览

```
拆分前（1 个文件 4164 行）：
  globe-3d.ts ← 所有代码

拆分后（10 个文件）：
  preset-3d/src/
  ├── index.ts                ← barrel export（对外只暴露这个）    ~15 行
  ├── globe-3d.ts             ← Globe3D 主类（字段+委托+生命周期）~500 行
  ├── globe-types.ts          ← interface / type 定义             ~270 行
  ├── globe-constants.ts      ← 不可变常量                        ~120 行
  ├── globe-buffers.ts        ← 模块级可变复用缓冲                ~50 行
  ├── globe-shaders.ts        ← 4 个 WGSL shader 字符串           ~210 行
  ├── globe-utils.ts          ← 纯工具函数（devWarn 等）          ~140 行
  ├── globe-gpu.ts            ← GPU 资源创建 + 管线 + 销毁        ~450 行
  ├── globe-camera.ts         ← 相机计算 + uniform 更新           ~230 行
  ├── globe-render.ts         ← 帧循环 + sky/tiles/atmo 渲染     ~500 行
  ├── globe-tiles.ts          ← 瓦片加载 + 网格 + 缓存 + LRU     ~330 行
  ├── globe-atmosphere.ts     ← 大气球体网格生成                  ~140 行
  └── globe-interaction.ts    ← 鼠标交互 + morph 动画             ~210 行
                                                          合计 ≈ 3165 行
                                   （压缩比 76%：去除重复注释和冗余空行）
```

---

## 二、依赖关系

```
                    index.ts（barrel export）
                        │
                    globe-3d.ts（主类，组装入口）
                   ╱    │    ╲         ╲
          globe-gpu  globe-render  globe-interaction
              │        ╱    ╲
       globe-shaders  globe-camera  globe-tiles
                                        │
                                  globe-atmosphere

所有文件 → globe-constants + globe-types + globe-buffers
globe-gpu → globe-shaders
globe-render → globe-camera, globe-tiles
globe-tiles → globe-atmosphere（大气网格）
globe-3d → globe-gpu, globe-render, globe-interaction, globe-utils

★ 无循环依赖
★ globe-3d.ts 不被任何内部文件 import（单向向下依赖）
```

---

## 三、各文件详细定义

### 1. `globe-types.ts` (~270 行)

所有 interface/type，不含任何逻辑：

```typescript
// globe-types.ts
import type { GlobeTileMesh, GlobeCamera, GlobeTileID } from '../../globe/src/globe-tile-mesh.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';

export interface Globe3DOptions { ... }
export interface EntitySpec { ... }
export interface ImageryLayerRecord { ... }
export interface TilesetRecord { ... }
export interface GeoJsonRecord { ... }
export interface CachedTile { ... }
export interface CachedMesh { ... }
export interface GlobeRendererStats { ... }

/** GPU 资源引用集合——从 Globe3D 类传给所有子模块函数 */
export interface GlobeGPURefs {
    device: GPUDevice | null;
    gpuContext: GPUCanvasContext | null;
    surfaceFormat: GPUTextureFormat;

    // 管线
    globePipeline: GPURenderPipeline | null;
    skyPipeline: GPURenderPipeline | null;
    atmoPipeline: GPURenderPipeline | null;

    // Uniform Buffers
    cameraUniformBuffer: GPUBuffer | null;
    tileParamsBuffer: GPUBuffer | null;
    skyUniformBuffer: GPUBuffer | null;

    // Bind Group Layouts
    cameraBindGroupLayout: GPUBindGroupLayout | null;
    tileBindGroupLayout: GPUBindGroupLayout | null;
    tileParamsBindGroupLayout: GPUBindGroupLayout | null;

    // Bind Groups
    cameraBindGroup: GPUBindGroup | null;
    tileParamsBindGroup: GPUBindGroup | null;
    fallbackBindGroup: GPUBindGroup | null;

    // 采样器 + 深度
    sampler: GPUSampler | null;
    depthTexture: GPUTexture | null;
    depthW: number;
    depthH: number;

    // 大气几何
    atmoVertexBuffer: GPUBuffer | null;
    atmoIndexBuffer: GPUBuffer | null;
    atmoMesh: GlobeTileMesh | null;
}

/** 瓦片管理器状态——传给 globe-tiles.ts 的函数 */
export interface TileManagerState {
    tileCache: Map<string, CachedTile>;
    tileLRU: string[];
    meshCache: Map<string, CachedMesh>;
    tileUrlTemplate: string;
    destroyed: boolean;
}

/** morph 动画状态 */
export interface MorphState {
    morphing: boolean;
    morphStartTime: number;
    morphDuration: number;
    morphTarget: '2d' | '25d' | '3d';
    viewMode: '2d' | '25d' | '3d';
}
```

### 2. `globe-constants.ts` (~120 行)

只有 `const` 不可变值，零逻辑：

```typescript
// globe-constants.ts — 只有不可变常量
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;
export const CAMERA_UNIFORM_SIZE = 96;
export const TILE_PARAMS_SIZE = 16;
export const SKY_UNIFORM_SIZE = 96;
export const ATMO_SPHERE_SEGMENTS = 64;
export const ATMO_RADIUS_FACTOR = 1.025;
export const DEPTH_CLEAR_VALUE = 1.0;
// ... 其余 ~30 个 const
```

### 3. `globe-buffers.ts` (~50 行)

可变的模块级复用缓冲，单独一个文件明确其"共享可变状态"语义：

```typescript
// globe-buffers.ts — 模块级可变缓冲（帧循环中复用，避免 GC）
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';
import { CAMERA_UNIFORM_SIZE, SKY_UNIFORM_SIZE, TILE_PARAMS_SIZE } from './globe-constants.ts';

export const _ecefTmp = new Float64Array(3) as Vec3d;
export const _normTmp = new Float64Array(3) as Vec3d;
export const _tmpMat4A = mat4.create();
export const _tmpMat4B = mat4.create();
export const _tmpMat4C = mat4.create();
export const _tmpVec3A = vec3.create();
export const _tmpVec3B = vec3.create();
export const _tmpVec3C = vec3.create();
export const _ecefCam64 = new Float64Array(3);
export const _ecefCenter64 = new Float64Array(3);
export const _cameraUniformData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
export const _skyUniformData = new Float32Array(SKY_UNIFORM_SIZE / 4);
export const _tileParamsData = new Float32Array(TILE_PARAMS_SIZE / 4);
```

### 4. `globe-shaders.ts` (~210 行)

4 个 WGSL 字符串常量，无任何 TS 逻辑：

```typescript
// globe-shaders.ts
export const GLOBE_TILE_WGSL = /* wgsl */`...`;   // ~69 行
export const SKY_DOME_WGSL = /* wgsl */`...`;      // ~38 行
export const ATMOSPHERE_WGSL = /* wgsl */`...`;     // ~66 行
export const LOG_DEPTH_WGSL = /* wgsl */`...`;      // ~7 行
```

### 5. `globe-utils.ts` (~140 行)

纯函数，无副作用，无状态：

```typescript
// globe-utils.ts
export function devWarn(...args: unknown[]): void { ... }
export function devError(...args: unknown[]): void { ... }
export function normalizeAngleRad(rad: number): number { ... }
export async function requestGpuAdapterWithFallback(gpu: GPU): Promise<GPUAdapter | null> { ... }
export function computeHorizonDist(altitude: number): number { ... }
export function computeCascadeFrusta(nearZ: number, farZ: number, maxRatio?: number): Array<{near:number,far:number}> { ... }
export function computeLogDepthBufFC(farZ: number): number { ... }
```

### 6. `globe-atmosphere.ts` (~140 行)

大气球体网格生成——从 globe-utils.ts 分离出来，因为它是几何生成而非"工具"：

```typescript
// globe-atmosphere.ts
import { WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import { ATMO_SPHERE_SEGMENTS, ATMO_RADIUS_FACTOR } from './globe-constants.ts';
import type { GlobeTileMesh } from '../../globe/src/globe-tile-mesh.ts';

export function tessellateAtmosphereShell(
    segments: number = ATMO_SPHERE_SEGMENTS,
): GlobeTileMesh { ... }
```

### 7. `globe-gpu.ts` (~450 行)

GPU 资源的创建、管线编译、销毁——全部纯函数，接收 refs 参数：

```typescript
// globe-gpu.ts
import type { GlobeGPURefs } from './globe-types.ts';
import { GLOBE_TILE_WGSL, SKY_DOME_WGSL, ATMOSPHERE_WGSL } from './globe-shaders.ts';
import { CAMERA_UNIFORM_SIZE, TILE_PARAMS_SIZE, ... } from './globe-constants.ts';

/** 创建所有 GPU 资源，填入 refs */
export function createGPUResources(device: GPUDevice, refs: GlobeGPURefs): void { ... }

/** 创建地球瓦片管线 */
export function createGlobePipeline(
    device: GPUDevice,
    format: GPUTextureFormat,
    refs: GlobeGPURefs,
): GPURenderPipeline { ... }

/** 创建天穹管线 */
export function createSkyPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline { ... }

/** 创建大气管线 */
export function createAtmoPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline { ... }

/** 销毁所有 GPU 资源 */
export function destroyGPUResources(refs: GlobeGPURefs): void { ... }

/** 确保深度纹理尺寸匹配 */
export function ensureDepthTexture(device: GPUDevice, w: number, h: number, refs: GlobeGPURefs): void { ... }
```

### 8. `globe-camera.ts` (~230 行)

相机计算——纯函数，输入 CameraState + Camera3D，输出 GlobeCamera：

```typescript
// globe-camera.ts
import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type { GlobeCamera } from '../../globe/src/globe-tile-mesh.ts';
import type { GlobeGPURefs } from './globe-types.ts';

export function computeGlobeCamera(
    camState: CameraState,
    vp: Viewport,
    camera3D: Camera3D,
): GlobeCamera { ... }

export function updateCameraUniforms(
    device: GPUDevice,
    gc: GlobeCamera,
    dateTime: Date,
    refs: GlobeGPURefs,
): void { ... }

export function runEggShapeDiagnostic(
    camState: CameraState,
    gc: GlobeCamera,
    ctx: GPUCanvasContext,
    vp: Viewport,
): void { ... }
```

### 9. `globe-render.ts` (~500 行)

帧循环主体 + 4 个渲染子过程：

```typescript
// globe-render.ts
import type { GlobeGPURefs, TileManagerState } from './globe-types.ts';
import type { GlobeCamera, GlobeTileID } from '../../globe/src/globe-tile-mesh.ts';

export function renderSkyDome(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
): void { ... }

export function renderGlobeTiles(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    tiles: GlobeTileID[],
    refs: GlobeGPURefs,
    tileState: TileManagerState,
): { tilesRendered: number; drawCalls: number } { ... }

export function renderAtmosphere(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
): void { ... }
```

### 10. `globe-tiles.ts` (~330 行)

瓦片加载/缓存/LRU——接收 TileManagerState：

```typescript
// globe-tiles.ts
import type { GlobeGPURefs, TileManagerState, CachedMesh } from './globe-types.ts';
import { MAX_TILE_CACHE_SIZE } from './globe-constants.ts';

export function loadTileTexture(
    key: string, z: number, x: number, y: number,
    device: GPUDevice,
    refs: GlobeGPURefs,
    state: TileManagerState,
): void { ... }

export async function fetchTileImage(url: string): Promise<ImageBitmap> { ... }

export function getTileMesh(
    device: GPUDevice,
    z: number, x: number, y: number,
    meshCache: Map<string, CachedMesh>,
): CachedMesh | null { ... }

export function touchTileLRU(key: string, lru: string[]): void { ... }
export function evictTileCache(state: TileManagerState): void { ... }
export function clearTileCache(state: TileManagerState): void { ... }
```

### 11. `globe-interaction.ts` (~210 行)

交互 + morph，接收 MorphState 回写：

```typescript
// globe-interaction.ts
import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { MorphState } from './globe-types.ts';
import { ZOOM_SENSITIVITY, ROTATE_SENSITIVITY } from './globe-constants.ts';

export interface InteractionHandlers {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
}

export function createInteractionHandlers(
    camera3D: Camera3D,
    options: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
): InteractionHandlers { ... }

export function installInteractions(
    canvas: HTMLCanvasElement,
    handlers: InteractionHandlers,
): void { ... }

export function removeInteractions(
    canvas: HTMLCanvasElement,
    handlers: InteractionHandlers,
): void { ... }

export function runMorph(
    target: '2d' | '25d' | '3d',
    durationMs: number,
    state: MorphState,
    emit: (type: string, payload: unknown) => void,
): void { ... }
```

### 12. `globe-3d.ts` — 主类（~500 行）

```typescript
// globe-3d.ts — 精简后的主类
import type { GlobeGPURefs, TileManagerState, MorphState } from './globe-types.ts';
import { createGPUResources, destroyGPUResources, ensureDepthTexture,
         createGlobePipeline, createSkyPipeline, createAtmoPipeline } from './globe-gpu.ts';
import { computeGlobeCamera, updateCameraUniforms } from './globe-camera.ts';
import { renderSkyDome, renderGlobeTiles, renderAtmosphere } from './globe-render.ts';
import { loadTileTexture, clearTileCache } from './globe-tiles.ts';
import { createInteractionHandlers, installInteractions, removeInteractions, runMorph } from './globe-interaction.ts';
import { requestGpuAdapterWithFallback, devError } from './globe-utils.ts';

export class Globe3D {
    // ── 字段（~60 行）──
    private _gpuRefs: GlobeGPURefs = { ... };    // 所有 GPU 资源
    private _tileState: TileManagerState = { ... }; // 瓦片状态
    private _morphState: MorphState = { ... };    // morph 状态
    private _camera3D: Camera3D;
    private _container: HTMLElement;
    private _canvas: HTMLCanvasElement;
    private _viewport: Viewport;
    // ... 其余状态字段

    // ── constructor（~80 行）── DOM + Camera3D + 交互安装 + bootstrapAsync
    constructor(options: Globe3DOptions) { ... }

    // ── 生命周期（~40 行）── ready / resize / remove
    // ── 相机 API（~100 行）── getZoom / flyTo / lookAt 等（纯委托）
    // ── 图层 API（~120 行）── addImageryLayer 等（操作 Map）
    // ── 环境 API（~60 行）── setAtmosphere / setSkybox 等（设置标志位）
    // ── 事件 API（~30 行）── on / off / _emit

    // ── _bootstrapAsync（~70 行）── 留在主类（跨模块编排）
    private async _bootstrapAsync(): Promise<void> {
        const adapter = await requestGpuAdapterWithFallback(navigator.gpu);
        const device = await adapter!.requestDevice();
        this._gpuRefs.device = device;
        createGPUResources(device, this._gpuRefs);
        this._gpuRefs.globePipeline = createGlobePipeline(device, format, this._gpuRefs);
        this._gpuRefs.skyPipeline = createSkyPipeline(device, format);
        this._gpuRefs.atmoPipeline = createAtmoPipeline(device, format);
        this._startFrameLoop();
    }

    // ── _renderFrame（~50 行）── 编排逻辑留在主类
    private _renderFrame(dt: number): void {
        const gc = computeGlobeCamera(camState, vp, this._camera3D);
        updateCameraUniforms(device, gc, this._dateTime, this._gpuRefs);
        // beginRenderPass...
        renderSkyDome(device, pass, gc, this._gpuRefs);
        renderGlobeTiles(device, pass, gc, tiles, this._gpuRefs, this._tileState);
        renderAtmosphere(device, pass, gc, this._gpuRefs);
        // end + submit
    }
}
```

### 13. `index.ts` — barrel export（~15 行）

```typescript
// index.ts — 对外统一出口
export { Globe3D } from './globe-3d.ts';
export type { Globe3DOptions, EntitySpec, GlobeRendererStats } from './globe-types.ts';
export { computeLogDepthBufFC, LOG_DEPTH_WGSL } from './globe-shaders.ts';
```

外部消费者只需 `import { Globe3D } from '@gis-forge/preset-3d'`，不感知内部拆分。

---

## 四、_bootstrapAsync 归属

_bootstrapAsync 跨越 GPU 初始化 + 管线创建 + 帧循环启动，涉及多个子模块的编排。
**留在 globe-3d.ts 主类中**——它是"组装逻辑"，不是"功能逻辑"：

```
_bootstrapAsync 调用链：
  requestGpuAdapterWithFallback()     ← globe-utils.ts
  createGPUResources(device, refs)    ← globe-gpu.ts
  createGlobePipeline(device, ...)    ← globe-gpu.ts
  createSkyPipeline(device, ...)      ← globe-gpu.ts
  createAtmoPipeline(device, ...)     ← globe-gpu.ts
  _startFrameLoop()                   ← 留在主类
```

同理 `_startFrameLoop` 和 `_renderFrame` 的**编排逻辑**留在主类，
具体的渲染子过程委托给 globe-render.ts。

---

## 五、拆分步骤 + 每步验证

```
Step 1: globe-types.ts + globe-constants.ts + globe-buffers.ts
  搬出：所有 interface/type、const 常量、模块级缓冲
  globe-3d.ts 改为 import { ... } from './globe-xxx.ts'
  ✅ 验证：tsc 编译通过 + 刷新渲染正常（红球 or 纹理球仍然显示）

Step 2: globe-shaders.ts
  搬出：4 个 WGSL 字符串
  ✅ 验证：tsc 编译通过 + 无 shader 编译错误

Step 3: globe-utils.ts
  搬出：devWarn, devError, normalizeAngleRad, requestGpuAdapterWithFallback,
        computeHorizonDist, computeCascadeFrusta, computeLogDepthBufFC
  ✅ 验证：tsc 编译通过 + 帧循环正常启动

Step 4: globe-atmosphere.ts
  搬出：tessellateAtmosphereShell
  ✅ 验证：大气球体网格创建正常（console.log 顶点数）

Step 5: globe-gpu.ts
  将 _createGPUResources / _create*Pipeline / _destroyGPUResources / _ensureDepthTexture
  改为独立函数，接收 GlobeGPURefs 参数
  Globe3D 类中添加 _gpuRefs 字段，constructor 中初始化
  对应方法改为委托调用：createGPUResources(device, this._gpuRefs)
  ✅ 验证：GPU 管线创建成功 + 无 validation error

Step 6: globe-camera.ts
  将 _computeGlobeCamera / _updateCameraUniforms / _runEggShapeDiagnostic
  改为独立函数
  ✅ 验证：EggDiag 输出 ALL PASS + 相机矩阵正确

Step 7: globe-tiles.ts
  将瓦片加载/缓存方法改为独立函数，接收 TileManagerState
  Globe3D 类添加 _tileState 字段
  ✅ 验证：瓦片加载触发 + LRU 淘汰正常

Step 8: globe-interaction.ts
  将交互处理和 morph 逻辑提取
  Globe3D 类添加 _morphState 字段
  ✅ 验证：鼠标拖拽旋转 + 滚轮缩放 + morph 动画正常

Step 9: globe-render.ts
  将 renderSkyDome / renderGlobeTiles / renderAtmosphere 提取
  _renderFrame 中改为调用独立函数
  ✅ 验证：完整渲染管线工作——天穹 + 瓦片 + 大气

Step 10: index.ts + 精简 globe-3d.ts
  创建 barrel export
  删除 globe-3d.ts 中所有已搬出的代码
  ✅ 验证：外部 import { Globe3D } from '@gis-forge/preset-3d' 正常工作
```

---

## 六、与 GIS-Forge 文档的交叉引用

| 本文内容 | 相关文档 |
|---------|---------|
| GlobeGPURefs 接口 | **Globe Pipeline v2 §三** — GPU 资源清单 |
| globe-shaders.ts 的 WGSL | **Migration Plan v2 §Step 6-8** — applyLogDepth / 完整 shader |
| globe-atmosphere.ts | **Atmosphere Issues v2 §四** — 方案 A 椭球体几何 |
| globe-camera.ts 的 RTE | **EggShape Issues v2 §根因二** — viewRTE lookAt 的 Float64 减法 |
| globe-render.ts 渲染顺序 | **Atmosphere Issues v2 §四** — atmo→sky→tiles 顺序 |
| _bootstrapAsync 编排 | **Migration Plan v2 §Step 7** — GPU 资源创建时序 |
