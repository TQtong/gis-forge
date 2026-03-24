# GeoForge 架构设计 — L1 GPU 层完整接口定义

> **定位**：L1 是引擎与 WebGPU API 之间的封装层。上层（L2~L6）不直接调用 WebGPU 原生 API，而是通过 L1 的接口操作 GPU 资源。
> **设计原则**：薄封装（不过度抽象）、资源生命周期可控、内存预算约束、与 L0 TypedArray 零拷贝对接。
> **模块数**：8 个（原有 5 个 + 新增 3 个）
>
> **v2.1 修订**：修复 SurfaceConfig 缺失 sampleCount（审计不一致 #8）；所有 Viewport/CameraState/PickResult 引用统一来自 `@geoforge/core/types`。

---

## 类型依赖声明

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
| 1 | DeviceManager | `device.ts` | 已有（Part1）| #3.3 GPU 驱动差异 |
| 2 | BufferPool | `buffer-pool.ts` | 已有（Part1）| #9.1 内存泄漏 |
| 3 | TextureManager | `texture-manager.ts` | 已有（Part1）| #9.1, #10.2 |
| 4 | GPUMemoryTracker | `memory-tracker.ts` | 已有（Part1）| #9.1 |
| 5 | IndirectDrawManager | `indirect-draw.ts` | 已有（Part1）| #9.2 Draw Call |
| 6 | SurfaceManager | `surface.ts` | **v2.1 修订** | #11.2 HiDPI, Canvas 管理 |
| 7 | BindGroupCache | `bind-group-cache.ts` | 新增 | 性能：BindGroup 复用 |
| 8 | GPUUploader | `uploader.ts` | 新增 | L0 TypedArray→GPU 零拷贝 |

---

## 已有模块（Part1 定义保持不变，此处不重复）

- **DeviceManager**：GPUAdapter/Device 获取、能力检测(GPUCapabilities)、丢失恢复、vendorId workaround
- **BufferPool**：Buffer 对象池(acquire/release/destroy) + StagingRing 环形上传
- **TextureManager**：Texture 生命周期 + DynamicAtlas 打包(icons/glyphs/patterns)
- **GPUMemoryTracker**：引用计数 + LRU 淘汰 + 孤立资源审计
- **IndirectDrawManager**：Indirect Draw Buffer 创建 + Compute Shader 写入 BindGroup + 编码执行

以上 5 个模块的完整接口见 `GeoForge_Architecture_Part1_L0_L1_L2.md`。

---

## 模块 6：SurfaceManager — Canvas/Surface 管理

```typescript
// ============================================================
// surface.ts — Canvas 配置、resize、DPR 适配
// v2.1 修订：SurfaceConfig 新增 sampleCount（修复审计不一致 #8）
// ============================================================

export interface SurfaceConfig {
  readonly canvas: HTMLCanvasElement;
  readonly devicePixelRatio: number;          // 实际使用的 DPR（经 maxPixelRatio 限制后）
  readonly width: number;                     // 逻辑宽度（CSS 像素）
  readonly height: number;                    // 逻辑高度（CSS 像素）
  readonly physicalWidth: number;             // 物理宽度（逻辑 × DPR）
  readonly physicalHeight: number;            // 物理高度（逻辑 × DPR）
  readonly format: GPUTextureFormat;          // Canvas 纹理格式
  readonly alphaMode: GPUCanvasAlphaMode;     // 'premultiplied' | 'opaque'
  readonly sampleCount: 1 | 4;               // ★ v2.1 新增：MSAA 采样数（修复审计 #8）
}

export interface SurfaceManager {
  // 初始化：配置 Canvas 和 GPUCanvasContext
  initialize(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    config: EngineConfig,
  ): void;

  // 当前配置
  readonly config: SurfaceConfig;

  // 获取当前帧的渲染目标纹理（每帧调用，从 SwapChain 获取）
  getCurrentTexture(): GPUTexture;
  getCurrentTextureView(): GPUTextureView;

  // MSAA 纹理（sampleCount > 1 时使用，渲染到此纹理再 resolve 到 canvas）
  getMSAATextureView(): GPUTextureView | null;  // ★ v2.1 新增

  // --- DPR 适配 ---

  // 监听 devicePixelRatio 变化（用户缩放浏览器窗口）
  // 自动更新 canvas 物理尺寸
  startDPRObserver(): void;
  stopDPRObserver(): void;

  // --- Resize ---

  // 处理 canvas 尺寸变化
  // 内部：更新 canvas.width/height、重建 GPUCanvasContext、通知所有依赖模块
  resize(logicalWidth: number, logicalHeight: number): void;

  // 监听 ResizeObserver 自动处理
  startResizeObserver(): void;
  stopResizeObserver(): void;

  // --- 坐标转换（使用 L0 的 Viewport 类型）---

  // CSS 像素 → 物理像素
  cssToPhysical(cssX: number, cssY: number): [physX: number, physY: number];

  // 物理像素 → CSS 像素
  physicalToCSS(physX: number, physY: number): [cssX: number, cssY: number];

  // CSS 像素 → NDC（Normalized Device Coordinates [-1, 1]）
  cssToNDC(cssX: number, cssY: number): [ndcX: number, ndcY: number];

  // Viewport 快照（返回 L0 定义的 Viewport 类型）
  getViewport(): Viewport;                    // ★ v2.1 新增：返回标准 Viewport

  // --- 事件 ---
  onResize(callback: (config: SurfaceConfig) => void): () => void;

  // --- 销毁 ---
  destroy(): void;
}
```

**设计要点**：
- ResizeObserver + matchMedia DPR 监听，自动处理 HiDPI 和窗口缩放
- `maxPixelRatio` 限制（来自 EngineConfig），移动端避免渲染过大分辨率
- `getCurrentTexture()` 每帧调用，是 WebGPU SwapChain 的标准模式
- CSS→物理→NDC 坐标转换链，为 Picking 和事件处理提供基础
- `sampleCount` 支持 MSAA（v2.1），`getMSAATextureView()` 在多重采样时提供渲染目标
- `getViewport()` 返回 L0 统一定义的 `Viewport` 类型，消除跨层类型不一致（v2.1）

---

## 模块 7：BindGroupCache — BindGroup 缓存

```typescript
// ============================================================
// bind-group-cache.ts — GPUBindGroup 缓存与复用
// WebGPU 中 BindGroup 是不可变对象，相同配置应复用
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
  // 获取或创建 BindGroup（相同描述符返回缓存的对象）
  getOrCreate(descriptor: BindGroupDescriptor): GPUBindGroup;

  // 使指定 Buffer/Texture 相关的 BindGroup 全部失效
  // （当 Buffer/Texture 被释放或替换时调用）
  invalidateByResource(resourceId: string): void;

  // 统计
  readonly stats: {
    readonly cacheSize: number;
    readonly hits: number;
    readonly misses: number;
  };

  // 清空缓存
  clear(): void;
}

// --- Sampler 缓存（内嵌在 BindGroupCache 中）---

export interface SamplerDescriptor {
  readonly minFilter: GPUFilterMode;
  readonly magFilter: GPUFilterMode;
  readonly mipmapFilter?: GPUMipmapFilterMode;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly maxAnisotropy?: number;
  readonly compare?: GPUCompareFunction;         // 深度纹理用
}

export interface SamplerCache {
  // Sampler 是不可变的，相同描述符永远返回同一个对象
  getOrCreate(descriptor: SamplerDescriptor): GPUSampler;
  readonly cacheSize: number;
}
```

**设计要点**：
- WebGPU 的 BindGroup 一旦创建就不可修改。如果 Buffer A 绑定在 BindGroup X 中，当 Buffer A 被 release 时，BindGroup X 必须失效
- 缓存 key 由 layout + entries 的所有资源 ID 拼接生成
- Sampler 缓存独立管理：常见的采样器配置（linear/nearest/clamp/repeat）只需创建一次
- 高频操作路径：每帧可能查询数百次，hash 查找必须 O(1)

---

## 模块 8：GPUUploader — L0 数据→GPU 传输

```typescript
// ============================================================
// uploader.ts — TypedArray / L0 数据结构 → GPU Buffer 的便捷传输
// 连接 L0 (CPU 数据) 和 L1 (GPU 资源) 的桥梁
// ============================================================

import type { Vec3f, Vec3d, Mat4f, Mat4d, Vec2f } from '@geoforge/core';

export interface GPUUploader {
  // === 基础上传 ===

  // 将 TypedArray 上传到新建/已有 GPU Buffer
  uploadBuffer(
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string,
  ): BufferHandle;

  // 上传到已有 Buffer 的指定偏移（部分更新）
  updateBuffer(
    handle: BufferHandle,
    data: ArrayBuffer | ArrayBufferView,
    offset?: number,
  ): void;

  // === Uniform 更新（每帧高频操作）===

  // 直接写入 Queue（适合小数据，如相机矩阵）
  // 使用 device.queue.writeBuffer，不走 Staging
  writeUniform(handle: BufferHandle, data: ArrayBufferView, offset?: number): void;

  // === L0 类型专用上传 ===

  // 上传 Mat4f 到 Uniform Buffer（16 * 4 = 64 字节）
  uploadMat4(mat: Mat4f, label?: string): BufferHandle;

  // 更新已有的 Mat4 Uniform
  updateMat4(handle: BufferHandle, mat: Mat4f, offset?: number): void;

  // 上传 Float64 坐标并自动 Split-Double
  // 输入：Float64Array [lon1,lat1,alt1, lon2,lat2,alt2, ...]
  // 输出：两个 Float32 Buffer（high + low），已完成 RTC 偏移
  uploadDoublePrecisionPositions(
    positions: Float64Array,
    rtcCenter: { high: Float32Array; low: Float32Array },
    label?: string,
  ): { highBuffer: BufferHandle; lowBuffer: BufferHandle };

  // === 纹理上传 ===

  // 从 ImageBitmap / HTMLCanvasElement 上传纹理
  uploadTexture(
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    options?: {
      format?: GPUTextureFormat;
      mipLevelCount?: number;
      usage?: GPUTextureUsageFlags;
      label?: string;
    },
  ): TextureHandle;

  // 从 ArrayBuffer 上传纹理数据（如 heightmap float 数据）
  uploadTextureFromBuffer(
    data: ArrayBufferView,
    width: number,
    height: number,
    options?: {
      format?: GPUTextureFormat;
      bytesPerRow?: number;
      label?: string;
    },
  ): TextureHandle;

  // === Mipmap 生成 ===

  // 为纹理生成 Mipmap（使用 Compute Shader 或 Render Pass）
  generateMipmaps(texture: TextureHandle): void;

  // === 批量上传（Worker 传输结果直传 GPU）===

  // 从 Worker 接收的 transferable ArrayBuffer 直接上传
  // 避免额外拷贝：Worker → 主线程 (transfer) → GPU (staging)
  uploadFromTransferable(
    data: ArrayBuffer,         // 通过 postMessage transfer 获得
    usage: GPUBufferUsageFlags,
    label?: string,
  ): BufferHandle;

  // === 回读（异步，用于 Picking）===

  // 从 GPU Buffer 异步读取数据（不阻塞渲染）
  readbackBuffer(
    handle: BufferHandle,
    offset?: number,
    size?: number,
  ): Promise<ArrayBuffer>;

  // 从纹理异步读取像素
  readbackTexture(
    texture: TextureHandle,
    x: number, y: number,
    width: number, height: number,
  ): Promise<ArrayBuffer>;
}
```

**设计要点**：
- `writeUniform` 用 `device.queue.writeBuffer`（小数据最快路径），不走 StagingRing
- `uploadDoublePrecisionPositions` 是关键方法——接收 L0 的 Float64Array 坐标，内部调用 L0 的 `PrecisionManager.splitDoubleArray()` 拆分为 high/low，然后上传两个 Float32 Buffer
- `uploadFromTransferable` 对接 L3 WorkerPool——Worker 解码数据后通过 `postMessage(data, [data])` 零拷贝传递到主线程，再通过此方法零拷贝上传 GPU
- `readbackBuffer/readbackTexture` 异步读取，用于 Picking（延迟 1 帧），内部使用 `mapAsync`
- `generateMipmaps` WebGPU 不自动生成 mipmap，需要引擎自己实现（Compute Shader 逐级降采样或 Render Pass blit）

---

## L1 全局初始化流程

```typescript
// L1 各模块的初始化顺序和依赖关系

async function initializeL1(canvas: HTMLCanvasElement, config: EngineConfig) {
  // 1. DeviceManager — 最先初始化，所有其他模块依赖它
  const deviceManager = createDeviceManager();
  await deviceManager.initialize(config);
  const device = deviceManager.device;

  // 2. SurfaceManager — 依赖 DeviceManager
  const surface = createSurfaceManager();
  surface.initialize(canvas, device, config);

  // 3. GPUMemoryTracker — 独立，无依赖
  const memoryTracker = createGPUMemoryTracker();

  // 4. BufferPool — 依赖 DeviceManager + GPUMemoryTracker
  const bufferPool = createBufferPool(device, memoryTracker, {
    stagingRingSize: 4 * 1024 * 1024,         // 4MB staging ring
    stagingRingSlots: 3,                        // 三重缓冲
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

  return {
    deviceManager,
    surface,
    memoryTracker,
    bufferPool,
    textureManager,
    bindGroupCache,
    indirectDraw,
    uploader,
  };
}
```

---

## L1 每帧生命周期

```
帧开始
  │
  ├── surface.getCurrentTexture()              // 获取当前帧渲染目标
  │
  ├── uploader.writeUniform(cameraBuffer, ...)  // 更新相机矩阵
  │
  ├── bufferPool.acquireStaging(...)            // 获取 staging 空间
  │   └── 写入本帧需要上传的新数据
  │
  ├── ... L2/L3/L4 构建 CommandBuffer ...
  │
  ├── bufferPool.encodeStagingCopies(encoder)   // 编码 staging→GPU 拷贝
  │
  ├── device.queue.submit([commandBuffer])      // 提交
  │
  ├── bufferPool.advanceStagingRing()           // 推进 staging 环
  │
  ├── memoryTracker.enforceBudget(...)          // 检查内存预算
  │   └── 淘汰超预算的资源
  │
  └── bindGroupCache（自动失效已释放资源的 BindGroup）
```

---

## L1 与 L0 的对接点

| L0 模块 | L1 对接 | 说明 |
|---------|---------|------|
| `Mat4f` / `Mat4d` | `GPUUploader.uploadMat4()` / `updateMat4()` | 相机矩阵、投影矩阵上传 |
| `Vec3f` / `Vec3d` | `GPUUploader.uploadBuffer()` | 顶点位置上传 |
| `Float64Array` 坐标 | `GPUUploader.uploadDoublePrecisionPositions()` | 自动 Split-Double + RTC |
| `PrecisionManager` | `GPUUploader` 内部调用 | 双精度拆分逻辑 |
| `BBox2D` / `BBox3D` | `frustum` 相关计算后上传 | 视锥剔除 uniform |
| `Viewport` (L0/types) | `SurfaceManager.getViewport()` | ★ v2.1：统一 Viewport 类型 |
| `EngineConfig` | `DeviceManager.initialize()` / `SurfaceManager.initialize()` | 全局配置消费 |
| `Logger` | 所有 L1 模块内部使用 | 日志输出 |
| `IdGenerator` | `BufferPool` / `TextureManager` 内部使用 | 资源 ID 生成 |

---

## L1 模块统计

| 模块 | 公共接口方法数 | 依赖 | v2.1 变更 |
|------|-------------|------|----------|
| DeviceManager | 6 | L0/config | — |
| SurfaceManager | 12 | DeviceManager, L0/config | +getMSAATextureView +getViewport |
| BufferPool | 7 | DeviceManager, GPUMemoryTracker | — |
| TextureManager | 7 | DeviceManager, GPUMemoryTracker | — |
| GPUMemoryTracker | 7 | 无（独立） | — |
| BindGroupCache | 4 | DeviceManager | — |
| IndirectDrawManager | 4 | DeviceManager, BufferPool | — |
| GPUUploader | 11 | DeviceManager, BufferPool, TextureManager, L0/precision | — |
| **合计** | **58 个公共方法** | | +2（v2.1） |

全部 8 个模块，58 个公共接口方法，零第三方依赖。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| `SurfaceConfig` 新增 `sampleCount: 1 \| 4` | 不一致 #8 | L5/CustomLayerContext 引用 sampleCount 但 SurfaceConfig 未定义 |
| `SurfaceManager` 新增 `getMSAATextureView()` | 不一致 #8 | sampleCount > 1 时需要 MSAA 纹理 |
| `SurfaceManager` 新增 `getViewport(): Viewport` | 不一致 #7 | Viewport 类型统一来自 L0 |
| 所有 Viewport/CameraState 引用改为从 `@geoforge/core/types` import | — | 消除跨层类型定义冲突 |
