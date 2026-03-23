# GeoForge 架构设计 — L2 渲染层完整接口定义（v2.2 自包含版）

> **定位**：L2 是引擎的渲染核心——ShaderAssembler、RenderGraph、Compositor。
> **模块数**：12 + 1 构建器（FrameGraphBuilder）= 13
>
> **v2.2 修订**：自包含全部 13 个模块（不再引用 Part1）。类型统一为 v2.1。
> 删除 RenderableLayer，使用 L4/Layer。PickResult 统一来自 L0。

---

## 类型依赖声明

```typescript
import type { Vec3f, Mat4f, BBox2D, Viewport, CameraState, PickResult } from '@geoforge/core';
import type { Layer } from '@geoforge/scene';
import type { BufferHandle, TextureHandle, SurfaceConfig } from '@geoforge/gpu/l1';
```

---

## 模块 1：ShaderAssembler

```typescript
export type ShaderModuleType = 'projection' | 'geometry' | 'style' | 'feature';

export interface ShaderModuleDefinition {
  readonly type: ShaderModuleType;
  readonly id: string;
  readonly wgslCode: string;
  readonly requiredUniforms?: string[];
  readonly dependencies?: string[];
  readonly uniformDeclarations?: ShaderUniformDeclaration[];
}

export interface ShaderUniformDeclaration {
  readonly name: string;
  readonly type: 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat3x3f' | 'mat4x4f' | 'u32' | 'i32';
  readonly binding: 'perFrame' | 'perLayer' | 'perObject';
}

export interface ShaderVariantKey {
  readonly projection: string;
  readonly geometry: string;
  readonly style: string;
  readonly features: readonly string[];
}

export interface AssembledShader {
  readonly key: string;
  readonly vertexCode: string;
  readonly fragmentCode: string;
  readonly computeCode?: string;
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
}

export interface UniformLayout {
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
  readonly perFrameUniforms: ShaderUniformDeclaration[];
  readonly perLayerUniforms: ShaderUniformDeclaration[];
  readonly perObjectUniforms: ShaderUniformDeclaration[];
  readonly perFrameBufferSize: number;
  readonly perLayerBufferSize: number;
  readonly perObjectBufferSize: number;
}

export interface ShaderAssembler {
  registerModule(definition: ShaderModuleDefinition): void;
  unregisterModule(type: ShaderModuleType, id: string): void;
  getModule(type: ShaderModuleType, id: string): ShaderModuleDefinition | undefined;
  listModules(type?: ShaderModuleType): ShaderModuleDefinition[];

  registerHook(hook: { id: string; hookPoint: ShaderHookPoint; wgslCode: string; priority?: number; dependencies?: string[] }): void;
  unregisterHook(id: string): void;

  assemble(key: ShaderVariantKey): AssembledShader;
  buildUniformLayout(key: ShaderVariantKey): UniformLayout;
  generateUniformWGSL(layout: UniformLayout): string;

  readonly lastCompilationError?: { readonly moduleId: string; readonly line: number; readonly message: string };
}

export type ShaderHookPoint =
  | 'vertex_position_before_projection' | 'vertex_position_after_projection' | 'vertex_output_custom'
  | 'fragment_color_before_style' | 'fragment_color_after_style' | 'fragment_discard' | 'fragment_alpha'
  | 'compute_visibility' | 'compute_sort_key';
```

---

## 模块 2：PipelineCache

```typescript
export interface PipelineDescriptor {
  readonly shaderVariant: ShaderVariantKey;
  readonly topology: GPUPrimitiveTopology;
  readonly cullMode: GPUCullMode;
  readonly depthCompare: GPUCompareFunction;
  readonly depthWriteEnabled: boolean;
  readonly blendState?: GPUBlendState;
  readonly sampleCount: number;
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
}

export interface PipelineCache {
  getOrCreate(descriptor: PipelineDescriptor): GPURenderPipeline;
  getOrCreateAsync(descriptor: PipelineDescriptor): Promise<GPURenderPipeline>;
  warmup(descriptors: PipelineDescriptor[]): Promise<void>;
  has(descriptor: PipelineDescriptor): boolean;
  readonly stats: { readonly cacheSize: number; readonly cacheHits: number; readonly cacheMisses: number; readonly compilationTimeMs: number };
  clear(): void;
  getOrCreateCompute(shaderCode: string, label?: string): GPUComputePipeline;
  getOrCreateComputeAsync(shaderCode: string, label?: string): Promise<GPUComputePipeline>;
}
```

---

## 模块 3：DepthManager

```typescript
export interface DepthConfig {
  readonly useReversedZ: boolean;
  readonly useLogarithmicDepth: boolean;
  readonly nearPlane: number;
  readonly farPlane: number;
  readonly depthFormat: GPUTextureFormat;
}

export interface DepthManager {
  readonly config: DepthConfig;
  createDepthTexture(width: number, height: number): TextureHandle;
  readonly depthCompare: GPUCompareFunction;   // 'greater'（Reversed-Z）
  readonly clearDepthValue: number;            // 0.0（Reversed-Z）
  readonly logDepthVertexCode: string;
  readonly logDepthFragmentCode: string;
  readonly linearizeDepthCode: string;
  updateClipPlanes(near: number, far: number): void;
}
```

---

## 模块 4：RenderGraph

```typescript
export type RenderPassType = 'compute' | 'render' | 'composite' | 'postprocess' | 'screen';

export interface RenderPassNode {
  readonly id: string;
  readonly type: RenderPassType;
  readonly projection?: string;
  readonly dependencies: readonly string[];
  readonly inputs: readonly ResourceReference[];
  readonly outputs: readonly ResourceReference[];
  execute(context: PassExecutionContext): void;
}

export interface ResourceReference {
  readonly name: string;
  readonly type: 'texture' | 'buffer';
  readonly usage: 'read' | 'write' | 'readwrite';
  readonly format?: GPUTextureFormat;
  readonly size?: { width: number; height: number };
}

export interface PassExecutionContext {
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly getTexture: (name: string) => GPUTexture;
  readonly getTextureView: (name: string) => GPUTextureView;
  readonly getBuffer: (name: string) => GPUBuffer;
  readonly camera: Readonly<CameraState>;
  readonly viewport: Readonly<Viewport>;
  readonly frameIndex: number;
}

export interface RenderGraph {
  addPass(node: RenderPassNode): void;
  removePass(id: string): void;
  autoMergePasses(): void;
  topologicalSort(): string[];
  optimizeResourceLifetimes(): void;
  compile(): CompiledRenderGraph;
  toDot(): string;
  readonly passes: ReadonlyMap<string, RenderPassNode>;
}

export interface CompiledRenderGraph {
  execute(queue: GPUQueue): void;
  readonly stats: { readonly passCount: number; readonly mergedPassCount: number; readonly texturesAllocated: number; readonly commandBufferCount: number };
}
```

---

## 模块 5：FrameGraphBuilder

```typescript
export interface FrameGraphBuilder {
  begin(surface: SurfaceConfig, camera: CameraState): void;

  addFrustumCullPass(options: { inputBuffers: BufferHandle[]; frustum: Mat4f }): string;
  addDepthSortPass(options: { inputBuffer: BufferHandle; cameraPosition: Vec3f }): string;
  addLabelCollisionPass(options: { labelBoxes: BufferHandle; labelCount: number; viewport: Viewport }): string;
  addCustomComputePass(pass: { id: string; pipeline: GPUComputePipeline; bindGroups: GPUBindGroup[]; workgroupCount: [number, number, number]; dependencies?: string[] }): string;

  addSceneRenderPass(options: {
    id: string; projection: string;
    layers: Layer[];                           // ★ L4 的 Layer，不是 RenderableLayer
    clearColor?: [number, number, number, number]; dependencies?: string[];
  }): string;

  addPostProcessPass(pass: { id: string; factory: PostProcessPassFactory; inputPassId: string }): string;
  addScreenPass(options: { layers: Layer[] }): string;
  addPickingPass(options: { layers: Layer[]; pixelX?: number; pixelY?: number }): string;

  build(): CompiledRenderGraph;
}
```

---

## 模块 6：Compositor

```typescript
export interface CompositorInput {
  readonly colorTexture: GPUTexture;
  readonly depthTexture: GPUTexture;
  readonly projection: string;
  readonly priority: number;
  readonly hasTransparentContent: boolean;
  readonly depthSpace: 'linear' | 'logarithmic' | 'reversed-z';
}

export interface Compositor {
  compose(encoder: GPUCommandEncoder, inputs: CompositorInput[], outputTexture: GPUTexture): void;
  readonly canSkipComposition: boolean;
  updateConfiguration(inputs: CompositorInput[]): void;
  readonly depthUnificationShader: string;
  composeWithOIT(encoder: GPUCommandEncoder, opaqueInputs: CompositorInput[], transparentInputs: CompositorInput[], outputTexture: GPUTexture): void;
  readonly oitMethod: 'weighted-blended' | 'depth-peeling' | 'none';
}
```

---

## 模块 7：PickingEngine

```typescript
// PickResult 统一使用 L0/types/viewport.ts 定义（含 sourceId/depth/worldPosition/normal）

export interface PickingEngine {
  renderPickingFrame(graph: RenderGraph, encoder: GPUCommandEncoder): void;
  pickAt(x: number, y: number): Promise<PickResult | null>;
  pickInRect(x1: number, y1: number, x2: number, y2: number): Promise<PickResult[]>;
  raycast(origin: Vec3f, direction: Vec3f, maxDistance: number): Promise<PickResult[]>;
  readDepthAt(x: number, y: number): Promise<number>;
  unprojectScreenToWorld(screenX: number, screenY: number, depth: number, inverseVPMatrix: Mat4f): Vec3f;
  screenToGeodetic(screenX: number, screenY: number, vpMatrix: Mat4f, inverseVPMatrix: Mat4f): [number, number, number] | null;
  pickRegion(x: number, y: number, width: number, height: number): Promise<Uint32Array>;
  registerLayer(layerId: string, resolver: (colorId: number) => PickResult | null): void;
  unregisterLayer(layerId: string): void;
}
```

---

## 模块 8：StencilManager

```typescript
export interface StencilManager {
  getStencilTexture(width: number, height: number): GPUTexture;
  readonly presets: {
    readonly polygonMask: { readonly depthStencilState: GPUDepthStencilState; readonly colorWriteMask: GPUColorWriteFlags };
    readonly terrainDrape: { readonly writeState: GPUDepthStencilState; readonly testState: GPUDepthStencilState };
    readonly invertedClassification: { readonly depthStencilState: GPUDepthStencilState };
  };
}
```

---

## 模块 9：RenderStats

```typescript
export interface FrameStats {
  readonly frameIndex: number;
  readonly frameDurationMs: number;
  readonly gpuDurationMs?: number;
  readonly drawCallCount: number;
  readonly triangleCount: number;
  readonly instanceCount: number;
  readonly passCount: number;
  readonly textureUploadBytes: number;
  readonly bufferUploadBytes: number;
  readonly tileLoadsInFlight: number;
  readonly visibleTileCount: number;
  readonly visibleLabelCount: number;
  readonly visibleFeatureCount: number;
}

export interface RenderStats {
  beginFrame(frameIndex: number): void;
  recordDrawCall(triangles: number, instances: number): void;
  recordPass(): void;
  recordUpload(type: 'texture' | 'buffer', bytes: number): void;
  endFrame(): void;
  readonly currentFrame: FrameStats;
  readonly averageFrameTime: number;
  readonly fps: number;
  getHistory(count: number): FrameStats[];
  beginGPUTimer(encoder: GPUCommandEncoder, label: string): void;
  endGPUTimer(encoder: GPUCommandEncoder, label: string): void;
  resolveGPUTimers(): Promise<Record<string, number>>;
}
```

---

## 模块 10：ComputePassManager

```typescript
export type BuiltinComputeTask = 'frustum-cull' | 'depth-sort' | 'label-collision' | 'point-cluster' | 'terrain-tessellation';

export interface ComputeTaskDescriptor {
  readonly id: string;
  readonly type: BuiltinComputeTask | 'custom';
  readonly pipeline: GPUComputePipeline;
  readonly bindGroups: GPUBindGroup[];
  readonly workgroupCount: [x: number, y: number, z: number];
  readonly dependencies?: string[];
}

export interface ComputePassManager {
  createFrustumCullTask(options: { objectBoundsBuffer: BufferHandle; objectCount: number; frustumPlanesBuffer: BufferHandle; outputVisibilityBuffer: BufferHandle }): ComputeTaskDescriptor;
  createDepthSortTask(options: { keyBuffer: BufferHandle; valueBuffer: BufferHandle; count: number }): ComputeTaskDescriptor;
  createLabelCollisionTask(options: { labelBoxBuffer: BufferHandle; labelCount: number; viewportWidth: number; viewportHeight: number; outputVisibilityBuffer: BufferHandle }): ComputeTaskDescriptor;
  createPointClusterTask(options: { positionBuffer: BufferHandle; pointCount: number; cellSize: number; outputClusterBuffer: BufferHandle }): ComputeTaskDescriptor;
  createCustomTask(descriptor: ComputeTaskDescriptor): ComputeTaskDescriptor;
  encodeAll(encoder: GPUCommandEncoder, tasks: ComputeTaskDescriptor[]): void;
  readonly builtinShaders: { readonly frustumCull: string; readonly radixSort: string; readonly labelCollision: string; readonly spatialHash: string; readonly terrainTessellation: string };
}
```

---

## 模块 11：BlendPresets

```typescript
export interface BlendPresets {
  readonly opaque: undefined;
  readonly alphaBlend: GPUBlendState;
  readonly premultipliedAlpha: GPUBlendState;
  readonly additive: GPUBlendState;
  readonly multiply: GPUBlendState;
  readonly screen: GPUBlendState;
  readonly stencilOnly: GPUBlendState;
  custom(colorSrc: GPUBlendFactor, colorDst: GPUBlendFactor, colorOp: GPUBlendOperation, alphaSrc: GPUBlendFactor, alphaDst: GPUBlendFactor, alphaOp: GPUBlendOperation): GPUBlendState;
}
```

---

## 模块 12：UniformLayoutBuilder

```typescript
export type UniformFieldType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec2i' | 'vec2u' | 'vec3f' | 'vec3i' | 'vec3u' | 'vec4f' | 'vec4i' | 'vec4u' | 'mat3x3f' | 'mat4x4f';

export interface UniformField { readonly name: string; readonly type: UniformFieldType }

export interface ComputedUniformLayout {
  readonly fields: readonly UniformField[];
  readonly offsets: ReadonlyMap<string, number>;
  readonly totalSize: number;
  readonly wgslStructCode: string;
  readonly wgslBindingCode: string;
}

export interface UniformLayoutBuilder {
  addField(name: string, type: UniformFieldType): this;
  addFromModule(module: ShaderModuleDefinition): this;
  build(group: number, binding: number): ComputedUniformLayout;
  createWriter(layout: ComputedUniformLayout): UniformWriter;
  reset(): this;
}

export interface UniformWriter {
  readonly buffer: ArrayBuffer;
  readonly view: DataView;
  setFloat(name: string, value: number): this;
  setInt(name: string, value: number): this;
  setUint(name: string, value: number): this;
  setVec2(name: string, x: number, y: number): this;
  setVec3(name: string, x: number, y: number, z: number): this;
  setVec4(name: string, x: number, y: number, z: number, w: number): this;
  setMat4(name: string, m: Mat4f): this;
  getData(): ArrayBuffer;
}
```

---

## 模块 13：WGSLTemplates

```typescript
export interface WGSLTemplates {
  readonly vertexTemplate: string;
  readonly fragmentTemplate: string;
  readonly computeTemplates: Record<string, string>;
  readonly projectionModules: Record<string, string>;
  readonly geometryModules: Record<string, string>;
  readonly styleModules: Record<string, string>;
  readonly featureModules: Record<string, string>;
}

// WGSL 模板骨架及内置模块代码见 .cursor/rules/shader-wgsl.mdc
```

---

## L2 初始化流程

```typescript
async function initializeL2(l1: L1Modules, config: EngineConfig) {
  const { device } = l1.deviceManager;
  const blendPresets = createBlendPresets();
  const depthManager = createDepthManager(device, config);
  const stencilManager = createStencilManager(device);
  const uniformLayoutBuilder = createUniformLayoutBuilder();
  const shaderAssembler = createShaderAssembler(uniformLayoutBuilder);
  registerBuiltinProjections(shaderAssembler);  // mercator, globe, perspective, ortho
  registerBuiltinGeometries(shaderAssembler);   // point, line, polygon, extrusion, mesh
  registerBuiltinStyles(shaderAssembler);       // fill_solid, fill_gradient, stroke, icon, text
  registerBuiltinFeatures(shaderAssembler);     // logDepth, splitDouble, sdf_line, msdf_text
  const pipelineCache = createPipelineCache(device, shaderAssembler);
  const computePassManager = createComputePassManager(device, pipelineCache);
  const renderStats = createRenderStats(device, l1.deviceManager.capabilities);
  const compositor = createCompositor(device, depthManager, blendPresets);
  const pickingEngine = createPickingEngine(device, l1.uploader);
  const renderGraph = createRenderGraph(device);
  const frameGraphBuilder = createFrameGraphBuilder(renderGraph, l1.surface, depthManager, compositor, computePassManager, renderStats);

  return { blendPresets, depthManager, stencilManager, uniformLayoutBuilder, shaderAssembler, pipelineCache, computePassManager, renderStats, compositor, pickingEngine, renderGraph, frameGraphBuilder };
}
```

---

## L2 模块统计

| 模块 | 公共方法数 |
|------|-----------|
| ShaderAssembler | 12 |
| PipelineCache | 7 |
| DepthManager | 6 |
| RenderGraph | 8 |
| FrameGraphBuilder | 8 |
| Compositor | 6 |
| PickingEngine | 10 |
| StencilManager | 2 |
| RenderStats | 8 |
| ComputePassManager | 7 |
| BlendPresets | 8 |
| UniformLayoutBuilder | 14 |
| WGSLTemplates | — (数据) |
| **合计** | **~96** |
