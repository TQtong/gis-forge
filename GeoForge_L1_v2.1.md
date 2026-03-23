# GeoForge 架构设计 — L1 GPU 层完整接口定义（v2.1）

> **定位**：L1 是引擎与 WebGPU API 之间的封装层。上层（L2~L6）不直接调用 WebGPU 原生 API，而是通过 L1 的接口操作 GPU 资源。
> **设计原则**：薄封装（不过度抽象）、资源生命周期可控、内存预算约束、与 L0 TypedArray 零拷贝对接。
> **模块数**：8 个（原有 5 个 + 新增 3 个）
>
> **v2.1 修订**：修复 SurfaceConfig 缺失 sampleCount（审计不一致 #8）；所有 Viewport/CameraState/PickResult 引用统一来自 `@geoforge/core/types`。

---

## 类型依赖声明（v2.1 新增）

```typescript
// L1 所有模块统一从 L0 导入共享类型，不再自行定义
import type {
  Vec3f, Vec3d, Mat4f, Mat4d, Vec2f, BBox2D,
  Viewport, CameraState, PickResult,
  TileCoord, TileData, TileParams,
} from '@geoforge/core';
```

---

## 模块清单

| # | 模块 | 文件 | 状态 | 解决问题 |
|---|------|------|------|---------|
| 1 | DeviceManager | `device.ts` | 不变 | #3.3 GPU 驱动差异 |
| 2 | BufferPool | `buffer-pool.ts` | 不变 | #9.1 内存泄漏 |
| 3 | TextureManager | `texture-manager.ts` | 不变 | #9.1, #10.2 |
| 4 | GPUMemoryTracker | `memory-tracker.ts` | 不变 | #9.1 |
| 5 | IndirectDrawManager | `indirect-draw.ts` | 不变 | #9.2 Draw Call |
| 6 | SurfaceManager | `surface.ts` | **修订** | #11.2 HiDPI |
| 7 | BindGroupCache | `bind-group-cache.ts` | 不变 | 性能 |
| 8 | GPUUploader | `uploader.ts` | 不变 | L0→GPU 零拷贝 |

---

## 模块 1~5、7~8：不变

DeviceManager、BufferPool、TextureManager、GPUMemoryTracker、IndirectDrawManager、BindGroupCache、GPUUploader 的接口与 v2.0 完全相同，此处不重复。

---

## 模块 6：SurfaceManager — 修订版

```typescript
// ============================================================
// surface.ts — Canvas 配置、resize、DPR 适配
// v2.1 修订：SurfaceConfig 新增 sampleCount（修复审计不一致 #8）
// ============================================================

export interface SurfaceConfig {
  readonly canvas: HTMLCanvasElement;
  readonly devicePixelRatio: number;
  readonly width: number;                     // 逻辑宽度（CSS 像素）
  readonly height: number;                    // 逻辑高度（CSS 像素）
  readonly physicalWidth: number;             // 物理宽度（逻辑 × DPR）
  readonly physicalHeight: number;            // 物理高度（逻辑 × DPR）
  readonly format: GPUTextureFormat;          // Canvas 纹理格式
  readonly alphaMode: GPUCanvasAlphaMode;
  readonly sampleCount: 1 | 4;               // ★ v2.1 新增：MSAA 采样数（修复审计 #8）
}

export interface SurfaceManager {
  initialize(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    config: EngineConfig,
  ): void;

  readonly config: SurfaceConfig;

  getCurrentTexture(): GPUTexture;
  getCurrentTextureView(): GPUTextureView;

  // MSAA 纹理（sampleCount > 1 时使用，渲染到此纹理再 resolve 到 canvas）
  getMSAATextureView(): GPUTextureView | null;  // ★ v2.1 新增

  // DPR
  startDPRObserver(): void;
  stopDPRObserver(): void;

  // Resize
  resize(logicalWidth: number, logicalHeight: number): void;
  startResizeObserver(): void;
  stopResizeObserver(): void;

  // 坐标转换（使用 L0 的 Viewport 类型）
  cssToPhysical(cssX: number, cssY: number): [physX: number, physY: number];
  physicalToCSS(physX: number, physY: number): [cssX: number, cssY: number];
  cssToNDC(cssX: number, cssY: number): [ndcX: number, ndcY: number];

  // Viewport 快照（返回 L0 定义的 Viewport 类型）
  getViewport(): Viewport;                    // ★ v2.1 新增：返回标准 Viewport

  // 事件
  onResize(callback: (config: SurfaceConfig) => void): () => void;

  destroy(): void;
}
```

---

## L1 全局初始化流程

（与 v2.0 相同，不变）

---

## L1 每帧生命周期

（与 v2.0 相同，不变）

---

## L1 与 L0 的对接点

| L0 模块 | L1 对接 | 说明 |
|---------|---------|------|
| `Mat4f` / `Mat4d` | `GPUUploader.uploadMat4()` / `updateMat4()` | 相机矩阵上传 |
| `Vec3f` / `Vec3d` | `GPUUploader.uploadBuffer()` | 顶点位置上传 |
| `Float64Array` 坐标 | `GPUUploader.uploadDoublePrecisionPositions()` | Split-Double + RTC |
| `PrecisionManager` | `GPUUploader` 内部调用 | 双精度拆分 |
| `BBox2D` | `frustum` 计算后上传 | 视锥剔除 uniform |
| `Viewport` (L0/types) | `SurfaceManager.getViewport()` | ★ v2.1：统一 Viewport 类型 |
| `EngineConfig` | `DeviceManager/SurfaceManager.initialize()` | 全局配置 |
| `Logger` / `IdGenerator` | 所有 L1 模块内部使用 | 日志/ID |

---

## L1 模块统计

| 模块 | 公共接口方法数 | v2.1 变更 |
|------|-------------|----------|
| DeviceManager | 6 | — |
| SurfaceManager | 12 | +getMSAATextureView +getViewport |
| BufferPool | 7 | — |
| TextureManager | 7 | — |
| GPUMemoryTracker | 7 | — |
| BindGroupCache | 4 | — |
| IndirectDrawManager | 4 | — |
| GPUUploader | 11 | — |
| **合计** | **58 个公共方法** | +2 |

---

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| `SurfaceConfig` 新增 `sampleCount: 1 \| 4` | 不一致 #8（L5/CustomLayerContext 引用 sampleCount 但 SurfaceConfig 未定义）|
| `SurfaceManager` 新增 `getMSAATextureView()` | sampleCount > 1 时需要 MSAA 纹理 |
| `SurfaceManager` 新增 `getViewport(): Viewport` | 不一致 #7（Viewport 类型统一来自 L0） |
| 所有 Viewport/CameraState 引用改为从 `@geoforge/core/types` import | 消除跨层类型定义冲突 |
