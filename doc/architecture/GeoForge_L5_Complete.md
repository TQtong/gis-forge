# GeoForge 架构设计 — L5 扩展层完整接口定义

> **定位**：L5 是引擎与社区/用户之间的契约层。所有外部扩展通过 6 个扩展点（EP1~EP6）接入引擎。
> **核心原则**：接口即契约（stable 后不 breaking change）、Context 注入（不暴露内部模块）、
> 错误隔离（一个扩展崩溃不影响整体）、完整生命周期（init→active→destroy）。
> **模块数**：8 个（ExtensionRegistry + ExtensionLifecycle + 6 个 EP 接口定义）
>
> **v2.1 修订**：
> - ShaderHook 注册签名统一：`registerShaderHook(id, hook)` 与其他 EP 一致（修复审计不一致 #9）
> - PickResult / Feature / CameraState / Viewport 全部引用 L0 定义（修复 #6 #3 #7）
> - PostProcessPass.execute 签名明确为 `GPUCommandEncoder`（与 L2 v2.1 统一，修复 #10）
> - CustomLayerContext.sampleCount 引用 L1/SurfaceConfig.sampleCount（修复 #8）

---

## 类型依赖声明

```typescript
import type {
  Vec3f, Mat4f, BBox2D,
  Viewport, CameraState, PickResult, Feature,
  FilterExpression,
} from '@geoforge/core';

import type { CameraController } from '@geoforge/runtime';
import type { Layer } from '@geoforge/scene';
```

---

## 模块清单

| # | 模块 | 文件 | 职责 | v2.1 状态 |
|---|------|------|------|----------|
| 1 | ExtensionRegistry | `registry.ts` | 统一注册/查询/卸载 | **修订**：registerShaderHook 签名统一 |
| 2 | ExtensionLifecycle | `lifecycle.ts` | 生命周期管理 + 错误隔离 + 版本兼容 | 不变 |
| 3 | EP1: CustomLayer | `custom-layer.ts` | 自定义图层接口 | **修订**：sampleCount 类型明确 |
| 4 | EP2: ProjectionModule | `custom-projection.ts` | 自定义投影接口 | 不变 |
| 5 | EP3: DataSource | `custom-source.ts` | 自定义数据源接口 | 不变 |
| 6 | EP4: ShaderHook | `shader-hook.ts` | Shader 钩子接口 | **修订**：重命名为 ShaderHookDefinition |
| 7 | EP5: PostProcessPass | `custom-postprocess.ts` | 自定义后处理接口 | **修订**：execute 签名用 GPUCommandEncoder |
| 8 | EP6: InteractionTool | `custom-interaction.ts` | 自定义交互工具接口 | **修订**：camera 类型为 CameraController |

---

## 模块 1：ExtensionRegistry — 统一注册中心

```typescript
// ============================================================
// registry.ts — 所有扩展点的统一入口
// v2.1：所有 register 方法签名统一为 (id, factory/module, meta?)
// ============================================================

export type ExtensionType = 'layer' | 'projection' | 'source' | 'shaderHook' | 'postProcess' | 'interaction';

export interface ExtensionInfo {
  readonly type: ExtensionType;
  readonly id: string;
  readonly version?: string;                   // 扩展版本
  readonly engineVersionRange?: string;        // 兼容的引擎版本范围（semver）
  readonly registeredAt: number;               // 注册时间戳
}

export interface ExtensionMeta {
  readonly version?: string;
  readonly engineVersionRange?: string;        // ">=1.0.0 <2.0.0"
  readonly description?: string;
  readonly author?: string;
}

export interface ExtensionRegistry {
  // --- 注册（工厂模式，延迟实例化）---
  // ★ v2.1: 所有 register 方法签名统一为 (id, factory/module, meta?)
  registerLayer(id: string, factory: CustomLayerFactory, meta?: ExtensionMeta): void;
  registerProjection(id: string, module: ProjectionModule, meta?: ExtensionMeta): void;
  registerSource(id: string, factory: DataSourceFactory, meta?: ExtensionMeta): void;
  registerShaderHook(id: string, hook: ShaderHookDefinition, meta?: ExtensionMeta): void;  // ★ v2.1: 加 id 参数
  registerPostProcess(id: string, factory: PostProcessPassFactory, meta?: ExtensionMeta): void;
  registerInteraction(id: string, factory: InteractionToolFactory, meta?: ExtensionMeta): void;

  // --- 查询 ---
  getLayer(id: string): CustomLayerFactory | undefined;
  getProjection(id: string): ProjectionModule | undefined;
  getSource(id: string): DataSourceFactory | undefined;
  getPostProcess(id: string): PostProcessPassFactory | undefined;
  getInteraction(id: string): InteractionToolFactory | undefined;
  getShaderHook(id: string): ShaderHookDefinition | undefined;
  getShaderHooks(hookPoint?: ShaderHookPoint): ShaderHookDefinition[];

  // --- 枚举 ---
  listAll(): ExtensionInfo[];
  listByType(type: ExtensionType): ExtensionInfo[];

  // --- 卸载 ---
  unregister(type: ExtensionType, id: string): boolean;
  unregisterAll(type?: ExtensionType): void;

  // --- 存在性检查 ---
  has(type: ExtensionType, id: string): boolean;

  // --- 事件 ---
  on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void;
}
```

---

## 模块 2：ExtensionLifecycle — 生命周期管理

```typescript
// ============================================================
// lifecycle.ts — 扩展生命周期管理 + 错误隔离 + 版本兼容
// ============================================================

export type ExtensionState = 'registered' | 'initializing' | 'active' | 'error' | 'destroyed';

export interface ExtensionInstance {
  readonly id: string;
  readonly type: ExtensionType;
  readonly state: ExtensionState;
  readonly error?: Error;                      // 最后一次错误
  readonly initDurationMs?: number;            // 初始化耗时
}

export interface ExtensionLifecycle {
  // --- 实例化扩展（从 Registry 的工厂创建实例）---
  instantiate(type: ExtensionType, id: string, options?: any): Promise<ExtensionInstance>;

  // --- 销毁实例 ---
  destroy(type: ExtensionType, id: string): void;
  destroyAll(type?: ExtensionType): void;

  // --- 查询实例状态 ---
  getInstance(type: ExtensionType, id: string): ExtensionInstance | undefined;
  getActiveInstances(type?: ExtensionType): ExtensionInstance[];

  // --- 错误隔离执行 ---
  // 包装扩展的任何回调，确保异常不传播到引擎
  safeExecute<T>(
    extensionId: string,
    fn: () => T,
    fallback?: T,
  ): T;

  // 异步版本
  safeExecuteAsync<T>(
    extensionId: string,
    fn: () => Promise<T>,
    fallback?: T,
  ): Promise<T>;

  // --- 错误策略 ---
  // 扩展连续出错超过阈值后自动禁用
  readonly maxConsecutiveErrors: number;        // 默认 5
  setMaxConsecutiveErrors(count: number): void;

  // 手动重新启用被禁用的扩展
  reenable(type: ExtensionType, id: string): Promise<boolean>;

  // --- 版本兼容检查 ---
  checkCompatibility(meta: ExtensionMeta): { compatible: boolean; reason?: string };

  // --- 事件 ---
  onStateChange(callback: (instance: ExtensionInstance, oldState: ExtensionState) => void): () => void;
  onError(callback: (extensionId: string, error: Error) => void): () => void;
}
```

---

## 模块 3：EP1 — CustomLayer 自定义图层

```typescript
// ============================================================
// custom-layer.ts — 自定义图层扩展点
// v2.1：sampleCount 类型明确为 1|4，CameraState/Viewport/PickResult 来自 L0
// ============================================================

// --- 引擎注入给扩展的上下文 ---
export interface CustomLayerContext {
  // GPU 资源（只读访问，不暴露 DeviceManager 内部）
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  readonly sampleCount: 1 | 4;               // ★ v2.1: 类型明确为 1|4，来自 L1/SurfaceConfig

  // L1 服务
  readonly bufferPool: BufferPool;
  readonly textureManager: TextureManager;
  readonly uploader: GPUUploader;
  readonly bindGroupCache: BindGroupCache;

  // L2 服务
  readonly shaderAssembler: ShaderAssembler;
  readonly pipelineCache: PipelineCache;
  readonly depthManager: DepthManager;
  readonly blendPresets: BlendPresets;

  // L0 服务
  readonly precision: PrecisionManager;

  // 场景信息（每帧更新）
  readonly camera: Readonly<CameraState>;     // ★ v2.1: CameraState 来自 L0
  readonly viewport: Readonly<Viewport>;      // ★ v2.1: Viewport 来自 L0
  readonly pixelRatio: number;
  readonly frameIndex: number;
  readonly elapsedTime: number;
}

// --- 自定义图层接口 ---
export interface CustomLayer {
  readonly id: string;
  readonly type: 'custom';

  // 生命周期
  onAdd(context: CustomLayerContext): void;
  onRemove(): void;
  onResize?(width: number, height: number): void;
  onCameraChange?(camera: CameraState): void;

  // 数据
  setData?(data: any): void;
  getData?(): any;

  // 渲染
  preCompute?(encoder: GPUComputePassEncoder): void;
  render(encoder: GPURenderPassEncoder, camera: CameraState): void;

  // 交互
  pick?(x: number, y: number): PickResult | null;  // ★ v2.1: PickResult 来自 L0
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;

  // 声明
  readonly projection?: string;
  readonly renderOrder?: number;
  readonly isTransparent?: boolean;

  // 可见性（引擎在 render 前检查）
  readonly visible?: boolean;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export type CustomLayerFactory = (options: Record<string, any>) => CustomLayer;
```

---

## 模块 4：EP2 — ProjectionModule 自定义投影

```typescript
// ============================================================
// custom-projection.ts — 自定义投影扩展点
// ============================================================

export interface ProjectionModule {
  readonly id: string;
  readonly epsg?: string;
  readonly displayName: string;

  // GPU 端
  readonly vertexShaderCode: string;           // fn projectPosition(...) → vec4<f32>
  readonly fragmentShaderCode?: string;

  // CPU 端
  project(lon: number, lat: number): [x: number, y: number];
  unproject(x: number, y: number): [lon: number, lat: number];

  // 元数据
  readonly bounds: BBox2D;
  readonly isGlobal: boolean;
  readonly worldSize?: number;
  readonly requiresDoublePrecision: boolean;
  readonly wrapsX: boolean;
  readonly antimeridianHandling: 'split' | 'wrap' | 'none';

  // 瓦片网格
  readonly tileGrid?: TileGridDefinition;

  // 可选：距离/面积计算（投影坐标系下）
  distance?(x1: number, y1: number, x2: number, y2: number): number;
  area?(ring: Float64Array): number;

  // 可选：适合此投影的相机类型
  readonly preferredCameraType?: '2d' | '25d' | '3d';
}
```

---

## 模块 5：EP3 — DataSource 自定义数据源

```typescript
// ============================================================
// custom-source.ts — 自定义数据源扩展点
// ============================================================

// --- 引擎注入给数据源的上下文 ---
export interface SourceContext {
  readonly requestScheduler: RequestScheduler;
  readonly workerPool: WorkerPool;
  readonly resourceManager: ResourceManager;
  readonly coordinateSystem: CoordinateSystem;  // CRS 转换
}

// --- 瓦片参数 ---
export interface TileParams {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly extent: BBox2D;
  readonly signal: AbortSignal;                // 取消信号
}

// --- 瓦片数据 ---
export interface TileData<T = any> {
  readonly data: T;
  readonly extent: BBox2D;
  readonly transferables?: Transferable[];      // 零拷贝传输
  readonly byteSize?: number;
  readonly expiresAt?: number;                 // 缓存过期时间戳
}

// --- 要素更新（实时流）---
export interface FeatureUpdate {
  readonly type: 'add' | 'update' | 'remove';
  readonly features: Feature[];
}

// --- 数据源元数据 ---
export interface SourceMetadata {
  readonly crs: string;
  readonly bounds: BBox2D;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly tileSize?: number;
  readonly attributeSchema?: Record<string, 'string' | 'number' | 'boolean'>;
  readonly format?: string;
  readonly attribution?: string;
}

// --- 数据源接口 ---
export interface DataSource<T = any> {
  readonly id: string;
  readonly type: string;

  // 生命周期
  initialize(context: SourceContext): Promise<void>;
  destroy(): void;

  // 元数据
  getMetadata(): Promise<SourceMetadata>;

  // 瓦片型
  loadTile?(params: TileParams): Promise<TileData<T>>;
  cancelTile?(params: TileParams): void;

  // 要素型
  loadFeatures?(extent: BBox2D, zoom: number, signal?: AbortSignal): Promise<Feature[]>;

  // 实时流
  subscribe?(extent: BBox2D, callback: (update: FeatureUpdate) => void): () => void;

  // 缓存
  readonly cacheable: boolean;
  readonly maxCacheAge?: number;

  // 可选：预取提示
  prefetchHint?(tiles: TileParams[]): void;
}

export type DataSourceFactory = (options: Record<string, any>) => DataSource;
```

---

## 模块 6：EP4 — ShaderHook Shader 钩子

```typescript
// ============================================================
// shader-hook.ts — Shader 钩子扩展点
// v2.1：重命名为 ShaderHookDefinition，id 由 Registry 管理
// ============================================================

export type ShaderHookPoint =
  // Vertex
  | 'vertex_position_before_projection'
  | 'vertex_position_after_projection'
  | 'vertex_output_custom'
  // Fragment
  | 'fragment_color_before_style'
  | 'fragment_color_after_style'
  | 'fragment_discard'
  | 'fragment_alpha'
  // Compute
  | 'compute_visibility'
  | 'compute_sort_key';

// ★ v2.1: ShaderHook 重命名为 ShaderHookDefinition，与 registerShaderHook(id, hook) 对齐
// id 由 Registry 管理，不再嵌入 hook 对象内部
export interface ShaderHookDefinition {
  readonly hookPoint: ShaderHookPoint;
  readonly wgslCode: string;
  readonly priority?: number;                  // 默认 0，越大越先执行
  readonly dependencies?: string[];            // 依赖的其他 hook ID

  // 该 hook 声明的额外 Uniform / Varying
  readonly extraUniforms?: Array<{ name: string; type: string }>;
  readonly extraVaryings?: Array<{ name: string; type: string }>;

  // 启用条件（运行时开关）
  readonly enableCondition?: () => boolean;
}

// 注册方式（v2.1 统一签名）：
// registry.registerShaderHook('night-mode', {
//   hookPoint: 'fragment_color_after_style',
//   wgslCode: `color = vec4<f32>(color.rgb * 0.3, color.a);`,
//   priority: -10,
// });

// ShaderHook 的运行时管理在 L2/ShaderAssembler 中，
// L5 只定义接口。用户通过 ExtensionRegistry.registerShaderHook() 注册。
```

---

## 模块 7：EP5 — PostProcessPass 自定义后处理

```typescript
// ============================================================
// custom-postprocess.ts — 自定义后处理扩展点
// v2.1：execute 签名明确为 GPUCommandEncoder
// ============================================================

export interface PostProcessContext {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  readonly shaderAssembler: ShaderAssembler;
  readonly pipelineCache: PipelineCache;
  readonly uploader: GPUUploader;
}

export interface PostProcessPass {
  readonly id: string;
  readonly name: string;
  readonly order: number;                      // 链中位置
  readonly enabled: boolean;

  // 生命周期
  setup(context: PostProcessContext): void;
  destroy(): void;
  onResize(width: number, height: number): void;

  // 渲染
  // ★ v2.1: 签名明确为 GPUCommandEncoder
  // Pass 内部自行创建 GPURenderPassEncoder（因为它需要控制 colorAttachment 绑定）
  execute(
    encoder: GPUCommandEncoder,
    inputColor: GPUTextureView,
    inputDepth: GPUTextureView,
    outputColor: GPUTextureView,
  ): void;

  // 参数
  setUniform(name: string, value: number | number[]): void;
  getUniform(name: string): number | number[] | undefined;
  setEnabled(enabled: boolean): void;

  // 声明资源需求（RenderGraph 自动分配中间纹理）
  readonly intermediateTextures?: Array<{
    name: string;
    format: GPUTextureFormat;
    scale?: number;                            // 相对视口的缩放（0.5 = 半分辨率）
  }>;
}

export type PostProcessPassFactory = (options?: Record<string, any>) => PostProcessPass;
```

---

## 模块 8：EP6 — InteractionTool 自定义交互工具

```typescript
// ============================================================
// custom-interaction.ts — 自定义交互工具扩展点
// v2.1：PickResult 来自 L0，camera 类型为 CameraController
// ============================================================

// --- 地图指针事件 ---
export interface MapPointerEvent {
  readonly screenX: number;
  readonly screenY: number;
  readonly lngLat: [number, number];
  readonly altitude?: number;
  readonly features: PickResult[];             // ★ v2.1: PickResult 来自 L0
  readonly originalEvent: PointerEvent;
  readonly button: number;
  readonly buttons: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

// --- 引擎注入给工具的上下文 ---
export interface InteractionContext {
  readonly camera: CameraController;           // ★ v2.1: CameraController 来自 L3
  readonly spatialQuery: SpatialQuery;
  readonly overlay: OverlayRenderer;
  readonly coordinateSystem: CoordinateSystem;
  readonly surface: SurfaceManager;

  // 便捷方法
  screenToLngLat(x: number, y: number): [number, number] | null;
  lngLatToScreen(lng: number, lat: number): [number, number] | null;
}

// --- Overlay 渲染器（绘制辅助图形：线、点、多边形）---
export interface OverlayRenderer {
  drawLine(points: Float64Array, style: LineStyle): string;     // 返回 overlay ID
  drawPolygon(ring: Float64Array, style: FillStyle): string;
  drawCircle(center: [number, number], radius: number, style: FillStyle): string;
  drawMarker(position: [number, number], style: MarkerStyle): string;
  drawText(position: [number, number], text: string, style: TextStyle): string;
  update(overlayId: string, geometry: Float64Array): void;
  remove(overlayId: string): void;
  removeAll(): void;
}

// --- 交互工具接口 ---
export interface InteractionTool {
  readonly id: string;
  readonly name: string;
  readonly cursor?: string;

  // 生命周期
  activate(context: InteractionContext): void;
  deactivate(): void;

  // 事件处理（返回 true = 已消费，阻止冒泡）
  onPointerDown?(event: MapPointerEvent): boolean;
  onPointerMove?(event: MapPointerEvent): boolean;
  onPointerUp?(event: MapPointerEvent): boolean;
  onDoubleClick?(event: MapPointerEvent): boolean;
  onClick?(event: MapPointerEvent): boolean;
  onContextMenu?(event: MapPointerEvent): boolean;
  onKeyDown?(event: KeyboardEvent): boolean;
  onKeyUp?(event: KeyboardEvent): boolean;
  onWheel?(event: WheelEvent): boolean;

  // 渲染覆盖物
  renderOverlay?(encoder: GPURenderPassEncoder, camera: CameraState): void;

  // 结果事件
  on(event: string, callback: (...args: any[]) => void): () => void;
  off(event: string, callback: (...args: any[]) => void): void;
}

export type InteractionToolFactory = (options?: Record<string, any>) => InteractionTool;

// --- InteractionManager（管理工具激活/切换）---
export interface InteractionManager {
  // 激活工具（暂停默认的 pan/zoom/rotate）
  activateTool(toolId: string, options?: Record<string, any>): void;

  // 停用当前工具（恢复默认行为）
  deactivateTool(): void;

  // 当前激活的工具
  readonly activeTool: InteractionTool | null;

  // 默认工具管理
  setDefaultToolEnabled(toolId: 'pan' | 'zoom' | 'rotate' | 'tilt', enabled: boolean): void;

  // 事件分发（内部调用，外部不直接使用）
  // 分发链：activeTool → defaultTools → map default
  dispatchPointerEvent(event: MapPointerEvent): void;
  dispatchKeyEvent(event: KeyboardEvent): void;
  dispatchWheelEvent(event: WheelEvent): void;
}
```

---

## L5 初始化流程

```typescript
function initializeL5(l0: L0Modules, l1: L1Modules, l2: L2Modules, l3: L3Modules) {
  // 1. ExtensionRegistry — 纯容器，无依赖
  const registry = createExtensionRegistry();

  // 2. ExtensionLifecycle — 依赖 Registry + Logger
  const lifecycle = createExtensionLifecycle(registry, l0.logger, {
    maxConsecutiveErrors: 5,
  });

  // 3. InteractionManager — 依赖 Lifecycle + Surface
  const interactionManager = createInteractionManager(
    lifecycle, l1.surface, l2.pickingEngine,
  );

  // 4. 注册内置扩展
  // 内置投影
  registry.registerProjection('mercator', createMercatorProjection());
  registry.registerProjection('globe', createGlobeProjection());

  // 内置交互工具
  registry.registerInteraction('pan', createPanTool);
  registry.registerInteraction('zoom', createZoomTool);
  registry.registerInteraction('rotate', createRotateTool);

  // 5. 构建扩展 Context（注入给所有扩展使用的服务集合）
  const layerContext: CustomLayerContext = {
    device: l1.deviceManager.device,
    format: l1.surface.config.format,
    depthFormat: l2.depthManager.config.depthFormat,
    sampleCount: l1.surface.config.sampleCount || 1,
    bufferPool: l1.bufferPool,
    textureManager: l1.textureManager,
    uploader: l1.uploader,
    bindGroupCache: l1.bindGroupCache,
    shaderAssembler: l2.shaderAssembler,
    pipelineCache: l2.pipelineCache,
    depthManager: l2.depthManager,
    blendPresets: l2.blendPresets,
    precision: l0.precision,
    camera: null as any,   // 每帧更新
    viewport: null as any, // 每帧更新
    pixelRatio: l1.surface.config.devicePixelRatio,
    frameIndex: 0,
    elapsedTime: 0,
  };

  return { registry, lifecycle, interactionManager, layerContext };
}
```

---

## 错误隔离机制详解

```typescript
// ExtensionLifecycle 内部的 safeExecute 实现逻辑

function safeExecute<T>(extensionId: string, fn: () => T, fallback?: T): T {
  try {
    return fn();
  } catch (error) {
    // 1. 记录错误
    logger.error('extension', `Extension "${extensionId}" threw: ${error.message}`);

    // 2. 递增连续错误计数
    const count = incrementErrorCount(extensionId);

    // 3. 超过阈值则自动禁用
    if (count >= maxConsecutiveErrors) {
      logger.warn('extension', `Extension "${extensionId}" disabled after ${count} consecutive errors`);
      setState(extensionId, 'error');
      // 从渲染循环中移除，但不从 Registry 卸载（用户可手动 reenable）
    }

    // 4. 触发错误事件
    emitError(extensionId, error);

    // 5. 返回 fallback 值（渲染不中断）
    return fallback as T;
  }
}

// 在渲染循环中的使用
// L2 FrameGraphBuilder 遍历图层时：
for (const layer of layers) {
  if (layer.type === 'custom') {
    lifecycle.safeExecute(layer.id, () => {
      layer.render(encoder, camera);
    });
    // 即使 render 抛异常，循环继续，其他图层正常渲染
  }
}
```

---

## 扩展与引擎各层的交互图

```
用户代码 / 社区扩展
  │
  │  registry.registerXxx(...)
  ▼
┌─────────────────────────────────────────────────────┐
│ L5 ExtensionRegistry                                 │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │EP1 图层│ │EP2 投影│ │EP3 源 │ │EP4 Hook│ ...    │
│  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘       │
│      │          │          │          │             │
│  ExtensionLifecycle（safeExecute 错误隔离）          │
└──────┼──────────┼──────────┼──────────┼─────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│L4 Scene  │ │L2 Shader│ │L3 Tile │ │L2 Shader │
│LayerMgr  │ │Assembler│ │Scheduler│ │Assembler │
│ addLayer │ │register │ │register │ │ register │
│          │ │Module   │ │Source   │ │ Hook     │
└──────────┘ └────────┘ └────────┘ └──────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
   L1 GPU     L1 GPU     L3 Network  L2 Pipeline
   (Buffer,   (Pipeline, (Request,   (Compile,
    Texture)   Shader)    Worker)     Cache)
```

---

## L5 与其他层的对接

### L5 消费的下层服务（通过 Context 注入）

| 扩展点 | 消费的 L1 服务 | 消费的 L2 服务 | 消费的 L3 服务 | 消费的 L0 服务 |
|--------|--------------|--------------|--------------|--------------|
| EP1 CustomLayer | device, bufferPool, textureManager, uploader, bindGroupCache | shaderAssembler, pipelineCache, depthManager, blendPresets | — | precision |
| EP2 Projection | — | shaderAssembler (注册 WGSL 模块) | — | coordinateSystem |
| EP3 DataSource | — | — | requestScheduler, workerPool, resourceManager | coordinateSystem |
| EP4 ShaderHook | — | shaderAssembler (注册 hook) | — | — |
| EP5 PostProcess | device, uploader | shaderAssembler, pipelineCache | — | — |
| EP6 Interaction | surface | pickingEngine | — | coordinateSystem |

### 上层消费 L5 注册的扩展

| 消费者 | 消费的扩展 | 机制 |
|--------|----------|------|
| L4/LayerManager | EP1 CustomLayer | `registry.getLayer(id)` → 实例化 → addLayer |
| L2/ShaderAssembler | EP2 Projection | `registry.getProjection(id)` → registerModule |
| L2/ShaderAssembler | EP4 ShaderHook | `registry.getShaderHooks(point)` → applyHooks |
| L3/TileScheduler | EP3 DataSource | `registry.getSource(id)` → 实例化 → registerSource |
| L2/FrameGraphBuilder | EP5 PostProcess | `registry.getPostProcess(id)` → addPostProcessPass |
| L5/InteractionManager | EP6 Interaction | `registry.getInteraction(id)` → activateTool |

---

## L5 模块统计

| 模块 | 公共方法数 | 接口/类型数 | v2.1 变更 |
|------|-----------|-----------|----------|
| ExtensionRegistry | 16 | ExtensionInfo, ExtensionMeta, ExtensionType | registerShaderHook 签名统一 |
| ExtensionLifecycle | 10 | ExtensionState, ExtensionInstance | — |
| EP1 CustomLayer | — (接口定义) | CustomLayer, CustomLayerContext, CustomLayerFactory | sampleCount: 1\|4 |
| EP2 ProjectionModule | — (接口定义) | ProjectionModule, TileGridDefinition | — |
| EP3 DataSource | — (接口定义) | DataSource, SourceContext, SourceMetadata, TileParams, TileData, FeatureUpdate | — |
| EP4 ShaderHook | — (接口定义) | ShaderHookDefinition, ShaderHookPoint | ShaderHook → ShaderHookDefinition |
| EP5 PostProcessPass | — (接口定义) | PostProcessPass, PostProcessContext | execute 用 GPUCommandEncoder |
| EP6 InteractionTool | — (接口定义) | InteractionTool, InteractionContext, MapPointerEvent, OverlayRenderer | camera: CameraController |
| InteractionManager | 6 | — | — |
| **合计** | **~32 方法 + 20+ 接口定义** | | |

8 个模块，32 个公共方法，20+ 个接口/类型定义。EP1~EP6 本身不含实现代码，只定义契约——实际实现分布在各功能包和社区扩展中。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| `registerShaderHook(id, hook)` 加 id 参数 | 不一致 #9 | 签名与其他 EP 统一 |
| ShaderHook → ShaderHookDefinition | 不一致 #9 | id 由 Registry 管理 |
| PickResult / Feature / CameraState / Viewport 引用 L0 | 不一致 #3 #6 #7 | 消除跨层类型定义 |
| CustomLayerContext.sampleCount 类型为 `1 \| 4` | 不一致 #8 | 与 L1/SurfaceConfig 一致 |
| PostProcessPass.execute 用 GPUCommandEncoder | 不一致 #10 | 与 L2 v2.1 统一 |
| InteractionContext.camera 类型为 CameraController | 与 L3 对接 | 使用 L3 相机控制器 |
