# GIS-Forge 架构设计 — L1 GPU 层完整接口定义（v2.2 自包含版）

> **定位**：L1 是引擎与 WebGPU API 之间的封装层。上层（L2~L6）不直接调用 WebGPU 原生 API，而是通过 L1 的接口操作 GPU 资源。
> **设计原则**：薄封装（不过度抽象）、资源生命周期可控、内存预算约束、与 L0 TypedArray 零拷贝对接。
> **模块数**：8 个
>
> **v2.2 修订**：本文件包含全部 8 个模块的完整接口（v2.0/v2.1 引用了 Part1 未自包含，现在合并）。
> 类型约定统一为 v2.1：裸 TypedArray（Vec3f=Float32Array），不使用 branded type。

---

## 类型依赖声明

```typescript
// L1 所有模块统一从 L0 导入共享类型
import type {
  Vec3f, Vec3d, Mat4f, Mat4d, Vec2f,
  BBox2D, Viewport, CameraState, PickResult,
} from '@gis-forge/core';
import type { EngineConfig } from '@gis-forge/core/infra/config';
```

---

## 模块清单

| # | 模块 | 文件 | 解决问题 |
|---|------|------|---------|
| 1 | DeviceManager | `device.ts` | #3.3 GPU 驱动差异 |
| 2 | SurfaceManager | `surface.ts` | #11.2 HiDPI, Canvas 管理 |
| 3 | BufferPool | `buffer-pool.ts` | #9.1 内存泄漏 |
| 4 | TextureManager | `texture-manager.ts` | #9.1, #10.2 填充图案 |
| 5 | GPUMemoryTracker | `memory-tracker.ts` | #9.1 |
| 6 | BindGroupCache | `bind-group-cache.ts` | 性能：BindGroup 复用 |
| 7 | IndirectDrawManager | `indirect-draw.ts` | #9.2 Draw Call |
| 8 | GPUUploader | `uploader.ts` | L0 TypedArray→GPU 零拷贝 |

---

## 模块 1：DeviceManager — GPU 设备管理

```typescript
// ============================================================
// device.ts — GPUDevice 生命周期管理
// 解决问题 #3.3 GPU 驱动差异
// ============================================================

export interface GPUCapabilities {
  readonly maxTextureSize: number;
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly supportsFloat32Filterable: boolean;
  readonly supportsTimestampQuery: boolean;
  readonly supportsIndirectFirstInstance: boolean;
  readonly preferredCanvasFormat: GPUTextureFormat;

  readonly vendor: string;                     // "intel" | "nvidia" | "amd" | "apple" | "qualcomm"
  readonly architecture: string;
  readonly description: string;
  readonly isMobile: boolean;
}

export interface DeviceManager {
  initialize(config: EngineConfig): Promise<void>;

  readonly device: GPUDevice;
  readonly queue: GPUQueue;
  readonly capabilities: GPUCapabilities;
  readonly isInitialized: boolean;

  onDeviceLost(callback: (reason: string) => void): () => void;
  recreateDevice(): Promise<void>;

  needsWorkaround(id: string): boolean;
  // 已知 workaround:
  //   "intel-arc-jitter"       — Intel Arc 浮点抖动
  //   "mobile-depth-precision" — 移动端深度缓冲精度
  //   "safari-texture-limit"   — Safari 纹理尺寸限制
}
```

---

## 模块 2：SurfaceManager — Canvas/Surface 管理

```typescript
// ============================================================
// surface.ts — Canvas 配置、resize、DPR 适配
// 解决问题 #11.2 HiDPI / Retina
// ============================================================

export interface SurfaceConfig {
  readonly canvas: HTMLCanvasElement;
  readonly devicePixelRatio: number;
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly format: GPUTextureFormat;
  readonly alphaMode: GPUCanvasAlphaMode;
  readonly sampleCount: 1 | 4;                // MSAA 采样数
}

export interface SurfaceManager {
  initialize(canvas: HTMLCanvasElement, device: GPUDevice, config: EngineConfig): void;

  readonly config: SurfaceConfig;

  getCurrentTexture(): GPUTexture;
  getCurrentTextureView(): GPUTextureView;
  getMSAATextureView(): GPUTextureView | null;

  startDPRObserver(): void;
  stopDPRObserver(): void;

  resize(logicalWidth: number, logicalHeight: number): void;
  startResizeObserver(): void;
  stopResizeObserver(): void;

  cssToPhysical(cssX: number, cssY: number): [physX: number, physY: number];
  physicalToCSS(physX: number, physY: number): [cssX: number, cssY: number];
  cssToNDC(cssX: number, cssY: number): [ndcX: number, ndcY: number];

  getViewport(): Viewport;                    // 返回 L0 定义的 Viewport

  onResize(callback: (config: SurfaceConfig) => void): () => void;

  destroy(): void;
}
```

---

## 模块 3：BufferPool — Buffer 池与 Staging

```typescript
// ============================================================
// buffer-pool.ts — GPU Buffer 对象池 + 环形 Staging Buffer
// 解决问题 #9.1 内存泄漏
// ============================================================

export interface BufferHandle {
  readonly id: string;
  readonly buffer: GPUBuffer;
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
}

export interface BufferPool {
  acquire(size: number, usage: GPUBufferUsageFlags, label?: string): BufferHandle;
  release(handle: BufferHandle): void;
  destroy(handle: BufferHandle): void;

  // --- Staging Buffer（CPU → GPU 上传专用）---
  acquireStaging(size: number): {
    readonly buffer: GPUBuffer;
    readonly offset: number;
    readonly mappedRange: ArrayBuffer;
  };
  encodeStagingCopies(encoder: GPUCommandEncoder): void;
  advanceStagingRing(): void;

  readonly stats: {
    readonly totalAllocated: number;
    readonly pooledFree: number;
    readonly stagingUsed: number;
  };
}
```

---

## 模块 4：TextureManager — 纹理管理与动态 Atlas

```typescript
// ============================================================
// texture-manager.ts — 纹理生命周期管理 + 动态 Atlas 打包
// 解决问题 #9.1 内存泄漏, #10.2 填充图案
// ============================================================

export interface TextureHandle {
  readonly id: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
}

export interface AtlasRegion {
  readonly atlasId: string;
  readonly u0: number; readonly v0: number;
  readonly u1: number; readonly v1: number;
  readonly pixelX: number; readonly pixelY: number;
  readonly pixelWidth: number; readonly pixelHeight: number;
}

export interface TextureManager {
  create(descriptor: GPUTextureDescriptor, label?: string): TextureHandle;
  release(handle: TextureHandle): void;

  // --- 动态 Atlas ---
  addToAtlas(
    atlasId: string,
    imageData: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    padding?: number,
  ): AtlasRegion;
  removeFromAtlas(atlasId: string, region: AtlasRegion): void;
  getAtlasTexture(atlasId: string): TextureHandle;
  // 内置 Atlas: "icons" / "glyphs" / "patterns"

  readonly stats: {
    readonly textureCount: number;
    readonly totalBytes: number;
    readonly atlasCount: number;
    readonly atlasUtilization: Record<string, number>;
  };
}
```

---

## 模块 5：GPUMemoryTracker — GPU 内存追踪

```typescript
// ============================================================
// memory-tracker.ts — GPU 内存预算与追踪
// 解决问题 #9.1 内存泄漏
// ============================================================

export interface GPUResourceEntry {
  readonly id: string;
  readonly type: 'buffer' | 'texture' | 'pipeline' | 'bindGroup';
  readonly size: number;
  readonly lastUsedFrame: number;
  readonly label?: string;
  readonly refCount: number;
}

export interface GPUMemoryTracker {
  track(entry: Omit<GPUResourceEntry, 'lastUsedFrame' | 'refCount'>): void;
  addRef(id: string): void;
  releaseRef(id: string): void;
  markUsed(id: string, frame: number): void;
  enforceBudget(budget: number, currentFrame: number): string[];
  audit(currentFrame: number, staleThreshold: number): GPUResourceEntry[];

  readonly totalBytes: number;
  readonly entryCount: number;
  readonly entries: ReadonlyMap<string, GPUResourceEntry>;
}
```

---

## 模块 6：BindGroupCache — BindGroup 缓存

```typescript
// ============================================================
// bind-group-cache.ts — GPUBindGroup 缓存与复用
// ============================================================

export interface BindGroupDescriptor {
  readonly layout: GPUBindGroupLayout;
  readonly entries: readonly BindGroupEntryDescriptor[];
}

export interface BindGroupEntryDescriptor {
  readonly binding: number;
  readonly resource:
    | { type: 'buffer'; buffer: GPUBuffer; offset?: number; size?: number }
    | { type: 'sampler'; sampler: GPUSampler }
    | { type: 'texture'; view: GPUTextureView }
    | { type: 'storageTexture'; view: GPUTextureView }
    | { type: 'externalTexture'; texture: GPUExternalTexture };
}

export interface BindGroupCache {
  getOrCreate(descriptor: BindGroupDescriptor): GPUBindGroup;
  invalidateByResource(resourceId: string): void;

  readonly stats: {
    readonly cacheSize: number;
    readonly hits: number;
    readonly misses: number;
  };
  clear(): void;
}

// --- Sampler 缓存（内嵌）---
export interface SamplerDescriptor {
  readonly minFilter: GPUFilterMode;
  readonly magFilter: GPUFilterMode;
  readonly mipmapFilter?: GPUMipmapFilterMode;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly maxAnisotropy?: number;
  readonly compare?: GPUCompareFunction;
}

export interface SamplerCache {
  getOrCreate(descriptor: SamplerDescriptor): GPUSampler;
  readonly cacheSize: number;
}
```

---

## 模块 7：IndirectDrawManager — 间接绘制管理

```typescript
// ============================================================
// indirect-draw.ts — Indirect Draw Buffer 管理
// 解决问题 #9.2 Draw Call 优化
// ============================================================

export interface IndirectDrawManager {
  createIndirectBuffer(maxDrawCalls: number, indexed: boolean): BufferHandle;
  createWriteBindGroup(indirectBuffer: BufferHandle): GPUBindGroup;
  encodeIndirectDraw(
    encoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawIndex: number,
    indexed: boolean,
  ): void;
  encodeMultiIndirectDraw?(
    encoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawCount: number,
    indexed: boolean,
  ): void;
}
```

---

## 模块 8：GPUUploader — L0 数据→GPU 传输

```typescript
// ============================================================
// uploader.ts — TypedArray / L0 数据结构 → GPU Buffer
// ============================================================

export interface GPUUploader {
  // 基础上传
  uploadBuffer(data: ArrayBuffer | ArrayBufferView, usage: GPUBufferUsageFlags, label?: string): BufferHandle;
  updateBuffer(handle: BufferHandle, data: ArrayBuffer | ArrayBufferView, offset?: number): void;

  // Uniform 更新（小数据，走 queue.writeBuffer 最快路径）
  writeUniform(handle: BufferHandle, data: ArrayBufferView, offset?: number): void;

  // L0 类型专用
  uploadMat4(mat: Mat4f, label?: string): BufferHandle;
  updateMat4(handle: BufferHandle, mat: Mat4f, offset?: number): void;

  // Float64 坐标自动 Split-Double
  uploadDoublePrecisionPositions(
    positions: Float64Array,
    rtcCenter: { high: Float32Array; low: Float32Array },
    label?: string,
  ): { highBuffer: BufferHandle; lowBuffer: BufferHandle };

  // 纹理上传
  uploadTexture(
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    options?: { format?: GPUTextureFormat; mipLevelCount?: number; usage?: GPUTextureUsageFlags; label?: string },
  ): TextureHandle;
  uploadTextureFromBuffer(
    data: ArrayBufferView, width: number, height: number,
    options?: { format?: GPUTextureFormat; bytesPerRow?: number; label?: string },
  ): TextureHandle;

  // Mipmap 生成
  generateMipmaps(texture: TextureHandle): void;

  // Worker Transferable 直传 GPU
  uploadFromTransferable(data: ArrayBuffer, usage: GPUBufferUsageFlags, label?: string): BufferHandle;

  // 异步回读（Picking 用）
  readbackBuffer(handle: BufferHandle, offset?: number, size?: number): Promise<ArrayBuffer>;
  readbackTexture(texture: TextureHandle, x: number, y: number, width: number, height: number): Promise<ArrayBuffer>;
}
```

---

## L1 全局初始化流程

```typescript
async function initializeL1(canvas: HTMLCanvasElement, config: EngineConfig) {
  // 1. DeviceManager — 最先，所有其他模块依赖
  const deviceManager = createDeviceManager();
  await deviceManager.initialize(config);
  const device = deviceManager.device;

  // 2. SurfaceManager — 依赖 DeviceManager
  const surface = createSurfaceManager();
  surface.initialize(canvas, device, config);

  // 3. GPUMemoryTracker — 独立
  const memoryTracker = createGPUMemoryTracker();

  // 4. BufferPool — 依赖 DeviceManager + GPUMemoryTracker
  const bufferPool = createBufferPool(device, memoryTracker, {
    stagingRingSize: 4 * 1024 * 1024, stagingRingSlots: 3,
  });

  // 5. TextureManager — 依赖 DeviceManager + GPUMemoryTracker
  const textureManager = createTextureManager(device, memoryTracker, {
    maxAtlasSize: deviceManager.capabilities.maxTextureSize,
    defaultAtlasSize: 2048,
  });

  // 6. BindGroupCache — 依赖 DeviceManager
  const bindGroupCache = createBindGroupCache(device);

  // 7. IndirectDrawManager — 依赖 DeviceManager + BufferPool
  const indirectDraw = createIndirectDrawManager(device, bufferPool);

  // 8. GPUUploader — 依赖 DeviceManager + BufferPool + TextureManager
  const uploader = createGPUUploader(device, bufferPool, textureManager);

  return { deviceManager, surface, memoryTracker, bufferPool, textureManager, bindGroupCache, indirectDraw, uploader };
}
```

---

## L1 每帧生命周期

```
帧开始
  ├── surface.getCurrentTexture()
  ├── uploader.writeUniform(cameraBuffer, ...)
  ├── bufferPool.acquireStaging(...)
  ├── ... L2/L3/L4 构建 CommandBuffer ...
  ├── bufferPool.encodeStagingCopies(encoder)
  ├── device.queue.submit([commandBuffer])
  ├── bufferPool.advanceStagingRing()
  ├── memoryTracker.enforceBudget(...)
  └── bindGroupCache（自动失效已释放资源的 BindGroup）
```

---

## L1 模块统计

| 模块 | 公共接口方法数 |
|------|-------------|
| DeviceManager | 6 |
| SurfaceManager | 12 |
| BufferPool | 7 |
| TextureManager | 7 |
| GPUMemoryTracker | 7 |
| BindGroupCache | 4 |
| IndirectDrawManager | 4 |
| GPUUploader | 11 |
| **合计** | **58** |
