# GeoForge 架构设计 — L5 扩展层完整接口定义（v2.1）

> **定位**：L5 是引擎与社区/用户之间的契约层。
> **模块数**：8 个（ExtensionRegistry + ExtensionLifecycle + 6 个 EP 接口）
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

## 模块 1：ExtensionRegistry — 修订版

```typescript
export type ExtensionType = 'layer' | 'projection' | 'source' | 'shaderHook' | 'postProcess' | 'interaction';

export interface ExtensionInfo {
  readonly type: ExtensionType;
  readonly id: string;
  readonly version?: string;
  readonly engineVersionRange?: string;
  readonly registeredAt: number;
}

export interface ExtensionMeta {
  readonly version?: string;
  readonly engineVersionRange?: string;
  readonly description?: string;
  readonly author?: string;
}

export interface ExtensionRegistry {
  // ★ v2.1: 所有 register 方法签名统一为 (id, factory/module, meta?)
  registerLayer(id: string, factory: CustomLayerFactory, meta?: ExtensionMeta): void;
  registerProjection(id: string, module: ProjectionModule, meta?: ExtensionMeta): void;
  registerSource(id: string, factory: DataSourceFactory, meta?: ExtensionMeta): void;
  registerShaderHook(id: string, hook: ShaderHookDefinition, meta?: ExtensionMeta): void;  // ★ v2.1: 加 id 参数
  registerPostProcess(id: string, factory: PostProcessPassFactory, meta?: ExtensionMeta): void;
  registerInteraction(id: string, factory: InteractionToolFactory, meta?: ExtensionMeta): void;

  // 查询
  getLayer(id: string): CustomLayerFactory | undefined;
  getProjection(id: string): ProjectionModule | undefined;
  getSource(id: string): DataSourceFactory | undefined;
  getPostProcess(id: string): PostProcessPassFactory | undefined;
  getInteraction(id: string): InteractionToolFactory | undefined;
  getShaderHook(id: string): ShaderHookDefinition | undefined;
  getShaderHooks(hookPoint?: ShaderHookPoint): ShaderHookDefinition[];

  // 枚举
  listAll(): ExtensionInfo[];
  listByType(type: ExtensionType): ExtensionInfo[];

  // 卸载
  unregister(type: ExtensionType, id: string): boolean;
  unregisterAll(type?: ExtensionType): void;

  // 存在性
  has(type: ExtensionType, id: string): boolean;

  // 事件
  on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void;
}
```

---

## 模块 2：ExtensionLifecycle

与 v2.0 完全相同，不变。

---

## 模块 3：EP1 CustomLayer — 修订版

```typescript
export interface CustomLayerContext {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  readonly sampleCount: 1 | 4;               // ★ v2.1: 类型明确为 1|4，来自 L1/SurfaceConfig

  readonly bufferPool: BufferPool;
  readonly textureManager: TextureManager;
  readonly uploader: GPUUploader;
  readonly bindGroupCache: BindGroupCache;
  readonly shaderAssembler: ShaderAssembler;
  readonly pipelineCache: PipelineCache;
  readonly depthManager: DepthManager;
  readonly blendPresets: BlendPresets;
  readonly precision: PrecisionManager;

  readonly camera: Readonly<CameraState>;     // ★ v2.1: CameraState 来自 L0
  readonly viewport: Readonly<Viewport>;      // ★ v2.1: Viewport 来自 L0
  readonly pixelRatio: number;
  readonly frameIndex: number;
  readonly elapsedTime: number;
}

export interface CustomLayer {
  readonly id: string;
  readonly type: 'custom';

  onAdd(context: CustomLayerContext): void;
  onRemove(): void;
  onResize?(width: number, height: number): void;
  onCameraChange?(camera: CameraState): void;

  setData?(data: any): void;
  getData?(): any;

  preCompute?(encoder: GPUComputePassEncoder): void;
  render(encoder: GPURenderPassEncoder, camera: CameraState): void;

  pick?(x: number, y: number): PickResult | null;  // ★ v2.1: PickResult 来自 L0
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;

  readonly projection?: string;
  readonly renderOrder?: number;
  readonly isTransparent?: boolean;
  readonly visible?: boolean;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

export type CustomLayerFactory = (options: Record<string, any>) => CustomLayer;
```

---

## 模块 4：EP2 ProjectionModule

与 v2.0 完全相同，不变。

---

## 模块 5：EP3 DataSource

与 v2.0 完全相同，不变（TileParams/TileData 已引用 L0）。

---

## 模块 6：EP4 ShaderHook — 修订版

```typescript
// ★ v2.1: ShaderHook 重命名为 ShaderHookDefinition，与 registerShaderHook(id, hook) 对齐
// id 由 Registry 管理，不再嵌入 hook 对象内部

export type ShaderHookPoint =
  | 'vertex_position_before_projection'
  | 'vertex_position_after_projection'
  | 'vertex_output_custom'
  | 'fragment_color_before_style'
  | 'fragment_color_after_style'
  | 'fragment_discard'
  | 'fragment_alpha'
  | 'compute_visibility'
  | 'compute_sort_key';

export interface ShaderHookDefinition {
  readonly hookPoint: ShaderHookPoint;
  readonly wgslCode: string;
  readonly priority?: number;
  readonly dependencies?: string[];            // 依赖的其他 hook ID
  readonly extraUniforms?: Array<{ name: string; type: string }>;
  readonly extraVaryings?: Array<{ name: string; type: string }>;
  readonly enableCondition?: () => boolean;
}

// 注册方式（v2.1 统一签名）：
// registry.registerShaderHook('night-mode', {
//   hookPoint: 'fragment_color_after_style',
//   wgslCode: `color = vec4<f32>(color.rgb * 0.3, color.a);`,
//   priority: -10,
// });
```

---

## 模块 7：EP5 PostProcessPass — 修订版

```typescript
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
  readonly order: number;
  readonly enabled: boolean;

  setup(context: PostProcessContext): void;
  destroy(): void;
  onResize(width: number, height: number): void;

  // ★ v2.1: 签名明确为 GPUCommandEncoder
  // Pass 内部自行创建 GPURenderPassEncoder（因为它需要控制 colorAttachment 绑定）
  execute(
    encoder: GPUCommandEncoder,
    inputColor: GPUTextureView,
    inputDepth: GPUTextureView,
    outputColor: GPUTextureView,
  ): void;

  setUniform(name: string, value: number | number[]): void;
  getUniform(name: string): number | number[] | undefined;
  setEnabled(enabled: boolean): void;

  readonly intermediateTextures?: Array<{
    name: string;
    format: GPUTextureFormat;
    scale?: number;
  }>;
}

export type PostProcessPassFactory = (options?: Record<string, any>) => PostProcessPass;
```

---

## 模块 8：EP6 InteractionTool — 修订版

```typescript
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

export interface InteractionContext {
  readonly camera: CameraController;           // ★ v2.1: CameraController 来自 L3
  readonly spatialQuery: SpatialQuery;
  readonly overlay: OverlayRenderer;
  readonly coordinateSystem: CoordinateSystem;
  readonly surface: SurfaceManager;

  screenToLngLat(x: number, y: number): [number, number] | null;
  lngLatToScreen(lng: number, lat: number): [number, number] | null;
}

// OverlayRenderer / InteractionTool / InteractionManager 与 v2.0 完全相同，不变。
```

---

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| `registerShaderHook(id, hook)` 加 id 参数 | 不一致 #9 |
| ShaderHook → ShaderHookDefinition | 不一致 #9（id 由 Registry 管理）|
| PickResult / Feature / CameraState / Viewport 引用 L0 | 不一致 #3 #6 #7 |
| CustomLayerContext.sampleCount 类型为 `1 \| 4` | 不一致 #8 |
| PostProcessPass.execute 用 GPUCommandEncoder | 不一致 #10 |
| InteractionContext.camera 类型为 CameraController | 与 L3 对接 |
