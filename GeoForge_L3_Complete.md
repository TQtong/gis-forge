# GeoForge 架构设计 — L3 调度层完整接口定义

> **定位**：L3 管理引擎的"时间维度"——谁先执行、何时加载、何时释放、出错怎么办。
> 它调度 CPU 主线程帧循环、Worker 任务分发、瓦片优先级、网络请求限流、内存预算。
> **包名**：@geoforge/runtime
> **模块数**：7 + 新增 CameraController 模块 + 3 个相机实现包接口 + ViewMorph
>
> **v2.1 修订**：
> - **新增 CameraController 接口 + camera-2d / camera-25d / camera-3d 实现规格**（修复审计缺口 #1，影响 7 个问题覆盖）
> - CameraState 删除本地定义，统一引用 L0/types/viewport.ts（修复审计不一致 #3）
> - WorkerTaskType 明确为 16 种（修复审计不一致 #2，概要设计中"12 种"的说法已过时）
> - 新增 view-morph 包接口（修复审计缺口 #1 中 #7.3 视图过渡问题）

---

## 类型依赖声明

```typescript
import type { Vec3f, Mat4f, Quatf, BBox2D, Viewport, CameraState } from '@geoforge/core';
```

---

## 模块清单（v2.1）

| # | 模块 | 文件 | 解决问题 | v2.1 状态 |
|---|------|------|---------|----------|
| 1 | FrameScheduler | `frame-scheduler.ts` | CPU-GPU 并行、帧预算、省电 | 不变 |
| 2 | TileScheduler | `tile-scheduler.ts` | #4.3 瓦片调度、#4.4 过缩放 | **修订**：CameraState 引用 L0 |
| 3 | WorkerPool | `worker-pool.ts` | #11.3 重计算卸载 | **修订**：明确 16 种任务类型 |
| 4 | ResourceManager | `resource-manager.ts` | 资源加载/缓存/生命周期 | 不变 |
| 5 | MemoryBudget | `memory-budget.ts` | #9.1 GPU+CPU 内存预算 | 不变 |
| 6 | RequestScheduler | `request-scheduler.ts` | #4.3 网络限流 | 不变 |
| 7 | ErrorRecovery | `error-recovery.ts` | 健壮性：重试/重启/恢复 | 不变 |
| 8 | **CameraController** | `camera-controller.ts` | 缺口 #1 | **v2.1 新增** |
| 9 | **Camera2D** | `camera-2d.ts` | #7.2 惯性动画 | **v2.1 新增**（@geoforge/camera-2d）|
| 10 | **Camera25D** | `camera-25d.ts` | #7.2 惯性动画 | **v2.1 新增**（@geoforge/camera-25d）|
| 11 | **Camera3D** | `camera-3d.ts` | #7.1 地形碰撞 + #7.2 惯性 | **v2.1 新增**（@geoforge/camera-3d）|
| 12 | **ViewMorph** | `view-morph.ts` | #7.3 视图过渡 | **v2.1 新增**（@geoforge/view-morph）|

---

## 模块 1：FrameScheduler — 帧调度

```typescript
// ============================================================
// frame-scheduler.ts — 帧循环管理
// 职责：驱动每帧更新-渲染循环，管理帧预算，处理可见性切换
// ============================================================

export type FramePhase = 'idle' | 'update' | 'render' | 'postFrame';

export interface FrameCallback {
  readonly id: string;
  readonly phase: FramePhase;
  readonly priority: number;                   // 越小越先执行
  execute(deltaTime: number, frameIndex: number): void;
}

export interface FrameScheduler {
  // --- 启停 ---
  start(): void;
  stop(): void;
  readonly isRunning: boolean;

  // --- 帧回调注册 ---
  // phase 决定回调在帧内的执行时机：
  //   'idle'      — 有空闲时间时执行（低优先级任务）
  //   'update'    — 场景/相机/动画更新
  //   'render'    — GPU 命令构建与提交
  //   'postFrame' — 帧提交后（统计、GC、内存淘汰）
  register(callback: FrameCallback): () => void;  // 返回 unregister
  unregister(id: string): void;

  // --- 帧预算 ---
  readonly targetFrameTimeMs: number;          // 1000 / targetFrameRate
  readonly frameBudgetMs: number;              // 当前帧剩余预算（毫秒）
  hasBudget(): boolean;                        // 当前帧是否还有预算

  // --- 手动请求渲染 ---
  // requestRenderMode=true 时，只在调用此方法后渲染下一帧
  requestRender(): void;
  readonly needsRender: boolean;

  // --- 可见性管理 ---
  // 页面不可见时自动降低帧率（backgroundThrottleMs）
  readonly isPageVisible: boolean;

  // --- 帧信息 ---
  readonly frameIndex: number;
  readonly deltaTime: number;                  // 上一帧耗时（秒）
  readonly elapsedTime: number;                // 引擎启动以来的总时间（秒）
  readonly currentFPS: number;                 // 实时 FPS

  // --- 调试 ---
  // 单步执行（调试用）
  stepOneFrame(): void;
}
```

**帧循环执行顺序**：

```
rAF 触发
  │
  ├── 检查 Page Visibility（不可见则降频）
  │
  ├── 计算 deltaTime、检查帧预算
  │
  ├── Phase: UPDATE（按 priority 排序执行）
  │   ├── CameraController.update(dt)
  │   ├── AnimationManager.update(dt)
  │   ├── TileScheduler.update(camera)
  │   └── LabelManager.update(camera)
  │
  ├── Phase: RENDER
  │   ├── FrameGraphBuilder.begin(...)
  │   ├── 各图层注册 Pass
  │   ├── compiledGraph = builder.build()
  │   └── compiledGraph.execute(queue)
  │
  ├── Phase: POST_FRAME
  │   ├── RenderStats.endFrame()
  │   ├── MemoryBudget.check()
  │   └── BufferPool.advanceStagingRing()
  │
  └── Phase: IDLE（如果帧预算有剩余）
      ├── ResourceManager.processIdleQueue()
      └── PipelineCache.warmupNext()
```

---

## 模块 2：TileScheduler — 瓦片调度

```typescript
// ============================================================
// tile-scheduler.ts — 瓦片加载优先级与调度
// 解决问题 #4.3 瓦片调度、#4.4 过缩放
// v2.1：CameraState / Viewport / TileCoord 统一从 @geoforge/core import
// ============================================================

import type { CameraState, Viewport, TileCoord, BBox2D } from '@geoforge/core';

export interface TilePriority {
  readonly coord: TileCoord;
  readonly distance: number;                   // 瓦片中心到相机的距离（像素）
  readonly screenSpaceError: number;           // SSE：投影到屏幕后的误差（像素）
  readonly isVisible: boolean;                 // 是否在视锥体内
  readonly isNeeded: boolean;                  // 是否是当前缩放级别需要的
}

export interface TileSchedulerConfig {
  readonly maxConcurrentLoads: number;         // 默认 6
  readonly maxCacheSize: number;               // 默认 512 瓦片
  readonly screenSpaceErrorThreshold: number;  // 默认 2.0 像素
  readonly overzoomLevels: number;             // 允许过缩放的级别数，默认 2
  readonly prefetchZoomDelta: number;          // 预取的相邻缩放级别，默认 1
  readonly pitchPriorityReduction: number;     // 高 pitch 角远处瓦片降低优先级，默认 0.5
}

export interface TileScheduler {
  // --- 核心调度 ---

  // 每帧调用：根据当前相机状态计算需要哪些瓦片
  update(camera: CameraState, viewport: Viewport): TileScheduleResult;

  // --- 配置 ---
  readonly config: TileSchedulerConfig;
  updateConfig(config: Partial<TileSchedulerConfig>): void;

  // --- 瓦片状态查询 ---
  getTileState(coord: TileCoord, sourceId: string): TileState;
  getVisibleTiles(sourceId: string): TileCoord[];
  getCachedTiles(sourceId: string): TileCoord[];

  // --- 数据源注册 ---
  // 不同数据源有不同的 zoom 范围和瓦片网格
  registerSource(sourceId: string, options: TileSourceOptions): void;
  unregisterSource(sourceId: string): void;

  // --- 瓦片加载完成回调 ---
  onTileLoaded(sourceId: string, coord: TileCoord, data: any): void;
  onTileError(sourceId: string, coord: TileCoord, error: Error): void;

  // --- 强制操作 ---
  reloadAll(): void;
  clearCache(sourceId?: string): void;

  // --- 统计 ---
  readonly stats: {
    readonly visibleCount: number;
    readonly loadingCount: number;
    readonly cachedCount: number;
    readonly totalLoaded: number;
    readonly totalErrors: number;
  };
}

export interface TileScheduleResult {
  readonly toLoad: TilePriority[];             // 需要加载的瓦片（按优先级排序）
  readonly toUnload: TileCoord[];              // 可以卸载的瓦片
  readonly visible: TileCoord[];               // 当前可见的瓦片
  readonly placeholder: Map<string, TileCoord>; // 缺失瓦片的替代（父/子瓦片）
}

export type TileState = 'empty' | 'loading' | 'loaded' | 'error' | 'cached';

export interface TileSourceOptions {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly tileSize: number;                   // 256 或 512
  readonly bounds?: BBox2D;                    // 数据覆盖范围
  readonly overzoomEnabled: boolean;
}
```

**调度算法要点**：
- SSE（Screen Space Error）驱动 LOD：瓦片的几何误差投影到屏幕后大于阈值则加载更精细级别
- Frustum Cull：仅视锥体内的瓦片参与调度（使用 L0 `frustum.intersectsBBox`）
- Pitch 降级：高俯仰角时远处瓦片降低优先级，避免加载大量远方瓦片
- Placeholder：目标瓦片未加载完时，使用父级瓦片（或已缓存的子瓦片）作为替代
- 过缩放处理：超过 maxZoom 后矢量瓦片保持原始精度，栅格瓦片插值放大

---

## 模块 3：WorkerPool — Worker 任务池

```typescript
// ============================================================
// worker-pool.ts — Web Worker 任务分发与管理
// 解决问题 #11.3 重计算卸载
// v2.1：明确 16 种任务类型（修复审计不一致 #2）
// ============================================================

export type WorkerTaskType =
  | 'mvt-decode'              // 1. MVT Protobuf 解码
  | 'raster-decode'           // 2. 栅格图像解码（ImageBitmap）
  | 'geojson-parse'           // 3. GeoJSON 解析 + geojson-vt 切片
  | 'triangulate'             // 4. earcut / Delaunay 三角剖分
  | 'simplify'                // 5. Douglas-Peucker / Visvalingam 线简化
  | 'rtree-build'             // 6. R-Tree 空间索引构建
  | 'rtree-query'             // 7. R-Tree 范围查询
  | 'label-collision'         // 8. 标注碰撞粗筛（CPU 端 R-Tree）
  | 'text-shaping'            // 9. 文字排版（Unicode BiDi + 换行 + 字形选择）
  | 'split-double'            // 10. Float64→SplitDouble 批量转换
  | 'terrain-mesh'            // 11. DEM→地形三角网 + 裙边生成
  | 'tiles3d-bvh'             // 12. 3D Tiles BVH 遍历 + 解析
  | 'antimeridian-cut'        // 13. 日期线几何切割
  | 'cluster'                 // 14. Supercluster 点聚合
  | 'boolean-op'              // 15. 布尔运算（intersection/union/difference）
  | 'custom';                 // 16. 用户自定义

export interface WorkerTask<TInput = any, TOutput = any> {
  readonly id: string;
  readonly type: WorkerTaskType;
  readonly priority: number;                   // 越小越先执行
  readonly input: TInput;
  readonly transferables?: Transferable[];      // 零拷贝传输列表
  readonly abortSignal?: AbortSignal;          // 可取消
}

export interface WorkerTaskResult<TOutput = any> {
  readonly taskId: string;
  readonly output: TOutput;
  readonly transferables?: Transferable[];      // Worker 返回的零拷贝对象
  readonly durationMs: number;
}

export interface WorkerPoolConfig {
  readonly workerCount: number | 'auto';       // 默认 'auto' = hardwareConcurrency - 1
  readonly maxQueueSize: number;               // 默认 1000
  readonly taskTimeout: number;                // 默认 30000ms
}

export interface WorkerPool {
  // --- 初始化 ---
  initialize(config: WorkerPoolConfig): Promise<void>;
  readonly isInitialized: boolean;
  readonly workerCount: number;

  // --- 任务提交 ---

  // 提交单个任务，返回 Promise
  submit<TInput, TOutput>(task: WorkerTask<TInput, TOutput>): Promise<WorkerTaskResult<TOutput>>;

  // 批量提交（相同类型的多个任务，自动负载均衡分发到不同 Worker）
  submitBatch<TInput, TOutput>(tasks: WorkerTask<TInput, TOutput>[]): Promise<WorkerTaskResult<TOutput>[]>;

  // --- 任务取消 ---
  cancel(taskId: string): boolean;
  cancelByType(type: WorkerTaskType): number;  // 返回取消数量

  // --- 优先级调整 ---
  // 视口变化时，已排队但尚未执行的瓦片解码任务可能需要重新排序
  reprioritize(taskId: string, newPriority: number): boolean;

  // --- Worker 健康管理 ---
  readonly stats: {
    readonly activeWorkers: number;
    readonly idleWorkers: number;
    readonly queuedTasks: number;
    readonly runningTasks: number;
    readonly completedTasks: number;
    readonly failedTasks: number;
    readonly averageTaskTimeMs: number;
  };

  // --- 销毁 ---
  terminate(): void;
}
```

**Worker 内部实现要点**：

```typescript
// Worker 端代码结构（所有 L0 算法都打包进 Worker）
// worker.ts

import * as earcut from '@geoforge/core/algorithm/earcut';
import * as douglasPeucker from '@geoforge/core/algorithm/simplify';
import * as rtree from '@geoforge/core/index/rtree';
import * as splitDouble from '@geoforge/core/precision/split-double';
import * as mercator from '@geoforge/core/geo/mercator';
// ... 其他 L0 模块 ...

self.onmessage = (event: MessageEvent<WorkerTask>) => {
  const { id, type, input } = event.data;
  let output: any;
  let transferables: Transferable[] = [];

  switch (type) {
    case 'mvt-decode':
      // Protobuf 解码 → Feature 数组
      output = decodeMVT(input.buffer, input.extent);
      transferables = [output.vertices.buffer, output.indices.buffer];
      break;
    case 'triangulate':
      output = earcut.earcut(input.vertices, input.holeIndices, input.dim);
      break;
    case 'split-double':
      const high = new Float32Array(input.count * 3);
      const low = new Float32Array(input.count * 3);
      splitDouble.splitDoubleArray(input.positions, high, low);
      output = { high, low };
      transferables = [high.buffer, low.buffer];
      break;
    // ... 其他任务类型 ...
  }

  self.postMessage({ taskId: id, output, durationMs: performance.now() - start }, transferables);
};
```

---

## 模块 4：ResourceManager — 资源管理

```typescript
// ============================================================
// resource-manager.ts — 资源加载、缓存、生命周期管理
// 统一管理所有通过网络/Worker 加载的资源
// ============================================================

export type ResourceType = 'tile-raster' | 'tile-vector' | 'tile-terrain' | 'tile-3dtiles'
  | 'geojson' | 'glyph' | 'sprite' | 'style' | 'custom';

export type ResourceState = 'pending' | 'loading' | 'decoding' | 'uploading' | 'ready' | 'error' | 'evicted';

export interface Resource<T = any> {
  readonly id: string;
  readonly type: ResourceType;
  readonly state: ResourceState;
  readonly data?: T;
  readonly error?: Error;
  readonly byteSize: number;                   // CPU 内存占用
  readonly gpuByteSize: number;                // GPU 内存占用
  readonly lastAccessFrame: number;
  readonly refCount: number;
}

export interface ResourceManager {
  // --- 加载 ---
  // 完整链路：网络请求 → Worker 解码 → GPU 上传 → 标记 ready
  load<T>(id: string, type: ResourceType, loader: () => Promise<T>): Promise<Resource<T>>;

  // --- 获取 ---
  get<T>(id: string): Resource<T> | undefined;

  // --- 引用计数 ---
  addRef(id: string): void;
  releaseRef(id: string): void;               // 归零后进入淘汰候选

  // --- 标记访问（每帧渲染时调用）---
  markAccessed(id: string, frameIndex: number): void;

  // --- 淘汰 ---
  // 由 MemoryBudget 触发，淘汰最久未使用的资源
  evict(ids: string[]): void;

  // --- 空闲处理 ---
  // 在帧空闲时间处理低优先级加载（prefetch、mipmap 生成等）
  processIdleQueue(): void;

  // --- 查询 ---
  readonly stats: {
    readonly totalCount: number;
    readonly readyCount: number;
    readonly loadingCount: number;
    readonly cpuBytes: number;
    readonly gpuBytes: number;
  };
  getByType(type: ResourceType): Resource[];
  getByState(state: ResourceState): Resource[];

  // --- 事件 ---
  onResourceReady(callback: (resource: Resource) => void): () => void;
  onResourceError(callback: (resource: Resource, error: Error) => void): () => void;
  onResourceEvicted(callback: (resource: Resource) => void): () => void;

  // --- 清理 ---
  clearAll(): void;
  clearByType(type: ResourceType): void;
}
```

---

## 模块 5：MemoryBudget — 内存预算

```typescript
// ============================================================
// memory-budget.ts — CPU + GPU 双轨内存预算管理
// 解决问题 #9.1 内存泄漏
// ============================================================

export interface MemoryBudgetConfig {
  readonly gpuBudget: number;                  // 默认 512MB
  readonly cpuBudget: number;                  // 默认 1GB
  readonly warningThreshold: number;           // 默认 0.8（80% 开始警告）
  readonly evictionThreshold: number;          // 默认 0.9（90% 开始淘汰）
  readonly evictionBatchSize: number;          // 每次淘汰的资源数，默认 16
  readonly checkIntervalFrames: number;        // 检查间隔，默认每 60 帧
}

export interface MemorySnapshot {
  readonly gpuUsed: number;
  readonly gpuBudget: number;
  readonly gpuUtilization: number;             // 0~1
  readonly cpuUsed: number;
  readonly cpuBudget: number;
  readonly cpuUtilization: number;             // 0~1
  readonly tileCacheCount: number;
  readonly textureCacheCount: number;
  readonly bufferCacheCount: number;
}

export interface MemoryBudget {
  // --- 配置 ---
  readonly config: MemoryBudgetConfig;
  updateConfig(config: Partial<MemoryBudgetConfig>): void;

  // --- 预算检查（每 N 帧由 FrameScheduler 调用）---
  check(
    gpuTracker: GPUMemoryTracker,
    resourceManager: ResourceManager,
    currentFrame: number,
  ): EvictionResult;

  // --- 快照 ---
  snapshot(gpuTracker: GPUMemoryTracker, resourceManager: ResourceManager): MemorySnapshot;

  // --- 事件 ---
  onWarning(callback: (snapshot: MemorySnapshot) => void): () => void;
  onEviction(callback: (evictedIds: string[]) => void): () => void;
  onBudgetExceeded(callback: (snapshot: MemorySnapshot) => void): () => void;
}

export interface EvictionResult {
  readonly evicted: string[];                  // 被淘汰的资源 ID
  readonly freedGpuBytes: number;
  readonly freedCpuBytes: number;
  readonly wasOverBudget: boolean;
}
```

**淘汰策略**：
1. 引用计数为 0 的资源优先淘汰
2. 同等引用计数下，按 `lastAccessFrame` 从旧到新（LRU）
3. 不可见瓦片优先于可见瓦片
4. 远处瓦片优先于近处瓦片
5. 淘汰顺序：栅格纹理（大）→ 矢量 Buffer → 字形 Atlas → 最后才淘汰 Pipeline

---

## 模块 6：RequestScheduler — 网络请求调度

```typescript
// ============================================================
// request-scheduler.ts — 网络请求限流与优先级管理
// 解决问题 #4.3 瓦片调度中的并发控制
// ============================================================

export interface RequestConfig {
  readonly maxConcurrent: number;              // 默认 6（HTTP/2 多路复用下可更高）
  readonly maxPerHost: number;                 // 默认 6
  readonly timeout: number;                    // 默认 30000ms
  readonly retryCount: number;                 // 默认 3
  readonly retryDelay: number;                 // 默认 1000ms（指数退避基数）
}

export type RequestPriority = 'critical' | 'high' | 'normal' | 'low' | 'prefetch';

export interface ScheduledRequest<T = any> {
  readonly id: string;
  readonly url: string;
  readonly priority: RequestPriority;
  readonly responseType: 'arrayBuffer' | 'json' | 'blob' | 'text';
  readonly abortController: AbortController;
  readonly headers?: Record<string, string>;
}

export interface RequestScheduler {
  // --- 发起请求 ---
  // 不立即执行，加入优先级队列等待调度
  schedule<T>(request: ScheduledRequest<T>): Promise<T>;

  // --- 优先级调整 ---
  // 视口变化后，已排队的请求优先级可能需要更新
  reprioritize(id: string, newPriority: RequestPriority): boolean;

  // --- 取消 ---
  cancel(id: string): boolean;
  cancelByUrl(urlPattern: string | RegExp): number;  // 返回取消数量
  cancelAll(): number;

  // --- 统计 ---
  readonly stats: {
    readonly active: number;                   // 当前进行中
    readonly queued: number;                   // 排队等待
    readonly completed: number;
    readonly failed: number;
    readonly totalBytes: number;               // 总下载量
    readonly averageLatencyMs: number;
  };

  // --- 事件 ---
  onQueueEmpty(callback: () => void): () => void;
}
```

**调度策略**：
- Priority Queue：critical > high > normal > low > prefetch
- 相同优先级内按提交顺序（FIFO）
- 视口快速移动时：自动取消所有 `low` 和 `prefetch` 请求（避免加载已滑出视口的瓦片）
- 指数退避重试：delay = retryDelay × 2^(attempt-1)，最大 30s
- HTTP/2 检测：如果服务器支持，可提高 maxConcurrent

---

## 模块 7：ErrorRecovery — 错误恢复

```typescript
// ============================================================
// error-recovery.ts — 全局错误恢复机制
// 瓦片加载失败、Worker 崩溃、GPU 设备丢失的自动恢复
// ============================================================

export type ErrorCategory = 'network' | 'decode' | 'gpu' | 'worker' | 'unknown';

export interface ErrorEvent {
  readonly category: ErrorCategory;
  readonly message: string;
  readonly source?: string;                    // 模块名
  readonly resourceId?: string;                // 相关资源 ID
  readonly retryable: boolean;
  readonly timestamp: number;
}

export interface RetryPolicy {
  readonly maxRetries: number;                 // 默认 3
  readonly baseDelay: number;                  // 默认 1000ms
  readonly maxDelay: number;                   // 默认 30000ms
  readonly backoffMultiplier: number;          // 默认 2（指数退避）
  readonly jitter: boolean;                    // 默认 true（加随机抖动防止雪崩）
}

export interface ErrorRecovery {
  // --- 错误报告 ---
  report(error: ErrorEvent): void;

  // --- 重试 ---
  // 判断是否应该重试，以及延迟多久
  shouldRetry(resourceId: string): { retry: boolean; delayMs: number };

  // 标记重试成功（重置该资源的重试计数器）
  markSuccess(resourceId: string): void;

  // 标记永久失败（不再重试）
  markPermanentFailure(resourceId: string): void;

  // --- Worker 崩溃恢复 ---
  // Worker 无响应或 error 事件时自动重启
  handleWorkerCrash(workerIndex: number): Promise<void>;

  // --- GPU 设备丢失恢复 ---
  // WebGPU 的 device.lost 事件触发后：
  //   1. 销毁所有 GPU 资源引用
  //   2. 重新请求 adapter + device
  //   3. 重建所有 Pipeline / Buffer / Texture
  //   4. 恢复最后的渲染状态
  handleDeviceLost(reason: string): Promise<void>;

  // --- 配置 ---
  readonly retryPolicy: RetryPolicy;
  updateRetryPolicy(policy: Partial<RetryPolicy>): void;

  // --- 统计 ---
  readonly stats: {
    readonly totalErrors: number;
    readonly retriedSuccess: number;
    readonly permanentFailures: number;
    readonly workerRestarts: number;
    readonly deviceRecoveries: number;
  };

  // --- 事件 ---
  onError(callback: (error: ErrorEvent) => void): () => void;
  onRecovery(callback: (resourceId: string) => void): () => void;
}
```

---

## 新增模块 8：CameraController — 相机控制器接口（v2.1）

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

## 新增模块 9：Camera2D — 2D 正交相机（v2.1）

```typescript
// ============================================================
// camera-2d.ts — 2D 正交相机实现规格
// 包名：@geoforge/camera-2d
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

## 新增模块 10：Camera25D — 2.5D 透视相机（v2.1）

```typescript
// ============================================================
// camera-25d.ts — 2.5D 透视相机实现规格
// 包名：@geoforge/camera-25d
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

## 新增模块 11：Camera3D — 3D 轨道相机（v2.1）

```typescript
// ============================================================
// camera-3d.ts — 3D 地球轨道相机实现规格
// 包名：@geoforge/camera-3d
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

## 新增模块 12：ViewMorph — 视图模式过渡（v2.1）

```typescript
// ============================================================
// view-morph.ts — 2D ↔ 2.5D ↔ 3D 视图过渡动画
// 包名：@geoforge/view-morph
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

## L3 全局初始化流程（v2.1 更新）

```typescript
function initializeL3(l1: L1Modules, l2: L2Modules, config: EngineConfig) {
  // 1. ErrorRecovery — 最先创建，其他模块的错误都汇报给它
  const errorRecovery = createErrorRecovery({
    maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2, jitter: true,
  });

  // 2. RequestScheduler — 依赖 ErrorRecovery（重试策略）
  const requestScheduler = createRequestScheduler(
    { maxConcurrent: 6, maxPerHost: 6, timeout: 30000 },
    errorRecovery,
  );

  // 3. WorkerPool — 依赖 ErrorRecovery（Worker 崩溃重启）
  const workerPool = createWorkerPool(config, errorRecovery);

  // 4. ResourceManager — 依赖 RequestScheduler + WorkerPool + L1.uploader
  const resourceManager = createResourceManager(requestScheduler, workerPool, l1.uploader);

  // 5. MemoryBudget — 依赖 L1.memoryTracker + ResourceManager
  const memoryBudget = createMemoryBudget(config);

  // 6. TileScheduler — 依赖 ResourceManager + RequestScheduler
  const tileScheduler = createTileScheduler(config, resourceManager, requestScheduler);

  // 7. FrameScheduler — 依赖以上所有（驱动帧循环）
  const frameScheduler = createFrameScheduler(config);
  // 注册帧回调
  frameScheduler.register({ id: 'tiles', phase: 'update', priority: 10,
    execute: (dt, frame) => tileScheduler.update(camera, viewport) });
  frameScheduler.register({ id: 'memory', phase: 'postFrame', priority: 100,
    execute: (dt, frame) => memoryBudget.check(l1.memoryTracker, resourceManager, frame) });
  frameScheduler.register({ id: 'idle', phase: 'idle', priority: 999,
    execute: () => resourceManager.processIdleQueue() });

  // 8. CameraController（根据预设模式创建）★ v2.1 新增
  let camera: CameraController;
  if (config.mode === '3d') {
    camera = createCamera3D(config.camera3dOptions);
  } else if (config.mode === '25d') {
    camera = createCamera25D(config.camera25dOptions);
  } else {
    camera = createCamera2D(config.camera2dOptions);
  }

  // 9. ViewMorph（可选，仅 preset-full 需要）★ v2.1 新增
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

## L3 与其他层的对接

### L3 → L0

| L3 消费 | L0 提供 |
|---------|---------|
| 瓦片范围计算 | `mercator.tileToBBox()` |
| 视锥体剔除 | `frustum.intersectsBBox()` |
| Worker 内算法 | earcut, simplify, rtree, splitDouble, mercator 等全部 L0 算法 |
| SSE 计算 | `ellipsoid`, `mercator.groundResolution()` |
| 点聚合 | `cluster.supercluster` |
| CameraState / Viewport 类型 | `@geoforge/core/types`（★ v2.1 统一） |

### L3 → L1

| L3 消费 | L1 提供 |
|---------|---------|
| 解码后数据上传 GPU | `GPUUploader.uploadFromTransferable()` |
| 内存预算检查 | `GPUMemoryTracker.totalBytes` |
| GPU 设备丢失恢复 | `DeviceManager.recreateDevice()` |
| Viewport 快照 | `SurfaceManager.getViewport()`（★ v2.1 新增） |

### L3 → L2

| L3 消费 | L2 提供 |
|---------|---------|
| 帧渲染触发 | `FrameGraphBuilder.begin()` (由 FrameScheduler 驱动) |
| Pipeline 空闲预热 | `PipelineCache.warmupNext()` |

### L4 → L3

| L4 消费 | L3 提供 |
|---------|---------|
| 瓦片加载 | `TileScheduler.update()` → 触发 ResourceManager.load() |
| Worker 解码 | `WorkerPool.submit('mvt-decode', ...)` |
| 网络请求 | `RequestScheduler.schedule(...)` |
| 帧注册 | `FrameScheduler.register(...)` |
| 相机控制 | `CameraController.flyTo()` / `.jumpTo()`（★ v2.1 新增） |

---

## L3 模块统计（v2.1）

| 模块 | 公共方法数 | 核心数据结构 | v2.1 变更 |
|------|-----------|------------|----------|
| FrameScheduler | 10 | FrameCallback, FramePhase | — |
| TileScheduler | 10 | TilePriority, TileScheduleResult | CameraState 引用 L0 |
| WorkerPool | 8 | WorkerTask, WorkerTaskResult | 明确 16 种 |
| ResourceManager | 12 | Resource, ResourceState | — |
| MemoryBudget | 5 | MemorySnapshot, EvictionResult | — |
| RequestScheduler | 7 | ScheduledRequest, RequestPriority | — |
| ErrorRecovery | 9 | ErrorEvent, RetryPolicy | — |
| **CameraController** | **18** | CameraConstraints, CameraAnimation | **v2.1 新增** |
| **Camera2D** | — | (实现 CameraController) | **v2.1 新增** |
| **Camera25D** | — | (扩展 Camera2D) | **v2.1 新增** |
| **Camera3D** | **+8** | 3D 特有方法 | **v2.1 新增** |
| **ViewMorph** | **4** | ViewMorphAnimation | **v2.1 新增** |
| **合计** | **~91 个公共方法** | | +30 |

全部 12 个模块，~91 个公共接口方法，零第三方依赖。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| 新增 CameraController 接口 | 缺口 #1 | 影响 #7.1 #7.2 + L6 所有 camera 逃生舱口 |
| 新增 Camera2D 实现规格 | #7.2 | 惯性动画 |
| 新增 Camera25D 实现规格 | #7.2 | 惯性动画 |
| 新增 Camera3D 实现规格 | #7.1 + #7.2 | 地形碰撞 + 惯性 |
| 新增 ViewMorph 接口 | #7.3 | 视图过渡 |
| CameraState 删除本地定义，引用 L0 | 不一致 #3 | TileScheduler 中不再自行定义 |
| WorkerTaskType 明确为 16 种 | 不一致 #2 | 概要设计中"12 种"已过时 |
