# GIS-Forge 架构设计 — L2 渲染层完整接口定义

> **定位**：L2 是引擎的渲染核心——管理每帧如何将场景数据转化为像素。
> 它消费 L1 的 GPU 资源，被 L4 的图层/场景驱动，是 Shader Assembler、Render Graph、Compositor 三大支柱的所在层。
> **模块数**：11 个 + 1 个构建器（FrameGraphBuilder）+ 1 个 WGSL 模板模块
>
> **v2.1 修订**：
> - 删除 `RenderableLayer` 接口，统一使用 L4 的 `Layer` 接口（修复审计不一致 #1）
> - 修复 PostProcessPass.execute 签名：`GPURenderPassEncoder` → `GPUCommandEncoder`（修复审计不一致 #10）
> - 新增 WGSL Shader 模板骨架（修复审计缺口 #3）
> - 所有 Viewport/CameraState/PickResult 引用统一来自 L0

---

## 类型依赖声明

```typescript
import type { Mat4f, Vec3f, BBox2D, Viewport, CameraState, PickResult, Feature } from '@gis-forge/core';
import type { Layer } from '@gis-forge/scene';  // L4 定义的 Layer 接口
```

---

## 模块清单

| # | 模块 | 文件 | 状态 | 解决问题 |
|---|------|------|------|---------|
| 1 | ShaderAssembler | `shader-assembler.ts` | 已有，**补充 Uniform 布局** | 一套 Shader 多维度 |
| 2 | PipelineCache | `pipeline-cache.ts` | 已有，不变 | #9.4 Shader 编译卡顿 |
| 3 | DepthManager | `depth-manager.ts` | 已有，不变 | #3.2 Z-Fighting |
| 4 | RenderGraph | `render-graph.ts` | 已有，不变 | 全局渲染框架 |
| 5 | FrameGraphBuilder | `frame-graph-builder.ts` | **v2.1 修订**：删除 RenderableLayer，使用 L4/Layer | 声明式渲染图构建 |
| 6 | Compositor | `compositor.ts` | 已有，**补充半透明处理** | 混合渲染 |
| 7 | PickingEngine | `picking-engine.ts` | **v2.1 修订**：PickResult 统一引用 L0 | 交互 |
| 8 | StencilManager | `stencil-manager.ts` | 已有，不变 | #5.1, #8.3 |
| 9 | RenderStats | `render-stats.ts` | 已有，不变 | 诊断 |
| 10 | ComputePassManager | `compute-pass.ts` | **新增** | GPU Compute 任务管理 |
| 11 | BlendPresets | `blend-presets.ts` | **新增** | 半透明/叠加/遮罩 |
| 12 | UniformLayoutBuilder | `uniform-layout.ts` | **新增** | Uniform 自动合并 |
| — | **WGSLTemplates** | `wgsl-templates.ts` | **v2.1 新增** | 内置 Shader 模板骨架 |

---

## 已有模块不变的部分

以下 4 个模块接口完全保持 Part 1 定义，不在此重复：
- **PipelineCache**（Part1 完整）
- **DepthManager**（Part1 完整）
- **StencilManager**（Part1 完整）
- **RenderStats**（Part1 完整）

---

## 已有模块的补充

### ShaderAssembler — 补充 Uniform 布局自动生成

Part 1 已有完整的模块注册/Hook/组装接口，此处补充缺失的 Uniform 管理：

```typescript
// ============================================================
// ShaderAssembler 补充：Uniform 布局管理
// 问题：各 Shader 模块（投影/几何/样式）各自声明自己的 Uniform，
//       需要自动合并为统一的 BindGroupLayout
// ============================================================

// 每个 Shader 模块声明自己需要的 Uniform
export interface ShaderUniformDeclaration {
  readonly name: string;                      // "cameraMatrix", "tileOrigin", "fillColor"
  readonly type: 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat3x3f' | 'mat4x4f' | 'u32' | 'i32';
  readonly binding: 'perFrame' | 'perLayer' | 'perObject';  // 更新频率分组
}

// 扩展 ShaderModuleDefinition（在 Part1 基础上新增 uniforms 字段）
export interface ShaderModuleDefinition {
  // ...Part1 已有字段...
  readonly type: ShaderModuleType;
  readonly id: string;
  readonly wgslCode: string;
  readonly requiredUniforms?: string[];
  readonly dependencies?: string[];

  // 新增：该模块声明的 Uniform
  readonly uniformDeclarations?: ShaderUniformDeclaration[];
}

// ShaderAssembler 新增方法
export interface ShaderAssembler {
  // ...Part1 已有方法全部保留...

  // 新增：根据 ShaderVariantKey 自动合并所有模块的 Uniform 声明
  // 按更新频率分为 3 个 BindGroup：
  //   @group(0) — perFrame（相机矩阵、视口、时间，每帧更新一次）
  //   @group(1) — perLayer（图层样式、投影参数，切换图层时更新）
  //   @group(2) — perObject（对象位置、颜色，每个 draw call 更新）
  //   @group(3) — 保留给用户自定义 / 纹理采样器
  buildUniformLayout(key: ShaderVariantKey): UniformLayout;

  // 新增：生成 WGSL 的 struct + @group/@binding 声明代码
  generateUniformWGSL(layout: UniformLayout): string;
}

export interface UniformLayout {
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[];  // 4 个 group
  readonly perFrameUniforms: ShaderUniformDeclaration[];
  readonly perLayerUniforms: ShaderUniformDeclaration[];
  readonly perObjectUniforms: ShaderUniformDeclaration[];
  readonly perFrameBufferSize: number;        // 字节（含 padding 对齐）
  readonly perLayerBufferSize: number;
  readonly perObjectBufferSize: number;
}
```

---

### Compositor — 补充半透明处理与深度统一

```typescript
// ============================================================
// Compositor 补充：半透明和深度空间统一
// ============================================================

export interface CompositorInput {
  // ...Part1 已有...
  readonly colorTexture: GPUTexture;
  readonly depthTexture: GPUTexture;
  readonly projection: string;
  readonly priority: number;

  // 新增
  readonly hasTransparentContent: boolean;     // 是否包含半透明内容
  readonly depthSpace: 'linear' | 'logarithmic' | 'reversed-z';  // 深度编码方式
}

export interface Compositor {
  // ...Part1 已有方法保留...

  // 新增：深度空间统一
  // 不同投影的 Pass 深度范围不同：
  //   2D: 线性深度 [0,1]
  //   3D: 对数深度 + Reversed-Z
  // 合成前需要统一到同一空间
  readonly depthUnificationShader: string;     // WGSL 函数

  // 新增：Order-Independent Transparency (OIT) 
  // 半透明内容不能简单按深度选择，需要混合
  composeWithOIT(
    encoder: GPUCommandEncoder,
    opaqueInputs: CompositorInput[],           // 不透明内容
    transparentInputs: CompositorInput[],      // 半透明内容
    outputTexture: GPUTexture,
  ): void;

  // OIT 模式选择
  readonly oitMethod: 'weighted-blended' | 'depth-peeling' | 'none';
}
```

---

## FrameGraphBuilder — 声明式构建每帧渲染图（v2.1 修订）

```typescript
// ============================================================
// FrameGraphBuilder — 声明式构建每帧渲染图
// 上层（L4 图层管理器）使用此接口描述每帧需要什么 Pass
//
// v2.1 变更：删除 RenderableLayer 接口
// 直接使用 L4 定义的 Layer 接口（Layer 已有 encode/encodePicking/isTransparent/projection/renderOrder）
// 这消除了 L2 和 L4 之间的接口分裂
// ============================================================

import type { Layer } from '@gis-forge/scene';

export interface FrameGraphBuilder {
  // 开始构建新一帧的渲染图
  begin(surface: SurfaceConfig, camera: CameraState): void;

  // --- 声明 Compute Pass ---

  // 视锥剔除 Compute Pass
  addFrustumCullPass(options: {
    inputBuffers: BufferHandle[];              // 待剔除的对象 BBox 列表
    frustum: Mat4f;                            // VP 矩阵
  }): string;  // 返回 pass ID

  // 深度排序 Compute Pass
  addDepthSortPass(options: {
    inputBuffer: BufferHandle;                 // 待排序的对象
    cameraPosition: Vec3f;
  }): string;

  // 标注碰撞精筛 Compute Pass
  addLabelCollisionPass(options: {
    labelBoxes: BufferHandle;                  // 标注包围盒
    labelCount: number;
    viewport: Viewport;
  }): string;

  // 自定义 Compute Pass（EP 扩展点）
  addCustomComputePass(pass: {
    id: string;
    pipeline: GPUComputePipeline;
    bindGroups: GPUBindGroup[];
    workgroupCount: [number, number, number];
    dependencies?: string[];
  }): string;

  // --- 声明 Render Pass ---

  // 场景渲染 Pass（按投影分组）— ★ v2.1: 使用 L4/Layer
  addSceneRenderPass(options: {
    id: string;
    projection: string;                        // 投影 ID
    layers: Layer[];                           // ★ v2.1: 直接使用 L4/Layer
    clearColor?: [number, number, number, number];
    dependencies?: string[];                   // 依赖的 Compute Pass
  }): string;

  // --- 声明 PostProcess Pass ---

  addPostProcessPass(pass: {
    id: string;
    factory: PostProcessPassFactory;
    inputPassId: string;                       // 读取哪个 pass 的输出
  }): string;

  // --- 声明 Screen Pass ---

  addScreenPass(options: {
    layers: Layer[];                           // ★ v2.1: UI 层（标注、控件、图例）
  }): string;

  // --- Picking Pass（可选，仅在需要时启用）---

  addPickingPass(options: {
    layers: Layer[];                           // ★ v2.1: 使用 L4/Layer
    pixelX?: number;                           // 单点拾取优化：只渲染目标像素附近区域
    pixelY?: number;
  }): string;

  // --- 构建完成 ---

  // 编译渲染图（自动处理：拓扑排序、Pass 合并、中间纹理分配）
  build(): CompiledRenderGraph;
}
```

---

## PickingEngine — 深度拾取与 3D 坐标反算（v2.1 修订）

```typescript
// ============================================================
// PickingEngine — 补充深度读取 + 3D 坐标反算
// v2.1 变更：PickResult 统一使用 L0/types/viewport.ts 中的定义
// 删除 L2 本地的 PickResult 定义，统一从 @gis-forge/core import
// ============================================================

import type { PickResult } from '@gis-forge/core';

export interface PickingEngine {
  // 渲染 Picking 帧
  renderPickingFrame(graph: RenderGraph, encoder: GPUCommandEncoder): void;

  // 异步拾取（延迟 1 帧读取）
  pickAt(x: number, y: number): Promise<PickResult | null>;

  // 框选
  pickInRect(x1: number, y1: number, x2: number, y2: number): Promise<PickResult[]>;

  // 射线检测（3D）
  raycast(origin: Vec3f, direction: Vec3f, maxDistance: number): Promise<PickResult[]>;

  // 深度读取（不需要完整的 picking 帧，只读深度纹理）
  readDepthAt(x: number, y: number): Promise<number>;

  // 屏幕坐标 + 深度 → 3D 世界坐标
  // 使用逆 VP 矩阵 + 深度值反投影
  unprojectScreenToWorld(
    screenX: number,
    screenY: number,
    depth: number,
    inverseVPMatrix: Mat4f,
  ): Vec3f;

  // 屏幕坐标 → 地球表面经纬度（3D 模式下）
  // 射线与椭球体求交，不需要深度缓冲
  screenToGeodetic(
    screenX: number,
    screenY: number,
    vpMatrix: Mat4f,
    inverseVPMatrix: Mat4f,
  ): [lon: number, lat: number, alt: number] | null;

  // 批量 picking（框选优化，一次读取整个区域）
  pickRegion(
    x: number, y: number,
    width: number, height: number,
  ): Promise<Uint32Array>;  // Color-ID 数组

  // 图层注册
  registerLayer(layerId: string, resolver: (colorId: number) => PickResult | null): void;
  unregisterLayer(layerId: string): void;
}
```

---

## 新增模块 9：ComputePassManager — GPU Compute 任务管理

```typescript
// ============================================================
// compute-pass.ts — GPU Compute Shader 任务管理
// 解决问题：视锥剔除、深度排序、标注碰撞精筛、点聚合
// 这些是每帧 Render 前必须执行的 GPU 端预处理
// ============================================================

// 内置 Compute 任务类型
export type BuiltinComputeTask =
  | 'frustum-cull'            // 视锥剔除
  | 'depth-sort'              // 深度排序（Parallel Radix Sort）
  | 'label-collision'         // 标注碰撞检测精筛
  | 'point-cluster'           // 点聚合
  | 'terrain-tessellation';   // 地形自适应曲面细分

export interface ComputeTaskDescriptor {
  readonly id: string;
  readonly type: BuiltinComputeTask | 'custom';
  readonly pipeline: GPUComputePipeline;
  readonly bindGroups: GPUBindGroup[];
  readonly workgroupCount: [x: number, y: number, z: number];
  readonly dependencies?: string[];           // 依赖的其他 task ID
}

export interface ComputePassManager {
  // --- 内置 Compute 任务 ---

  // 视锥剔除：输入对象 AABB 列表 → 输出可见性标记 Buffer
  createFrustumCullTask(options: {
    objectBoundsBuffer: BufferHandle;          // Storage Buffer: array<vec4<f32>> (min+max 交替)
    objectCount: number;
    frustumPlanesBuffer: BufferHandle;         // Uniform: 6 个平面
    outputVisibilityBuffer: BufferHandle;      // Storage: array<u32> (1=可见, 0=不可见)
  }): ComputeTaskDescriptor;

  // 深度排序（GPU Parallel Radix Sort）
  // 输入：对象索引 + 深度值 → 输出：排序后的索引
  createDepthSortTask(options: {
    keyBuffer: BufferHandle;                   // Storage: array<f32> (深度值)
    valueBuffer: BufferHandle;                 // Storage: array<u32> (对象索引)
    count: number;
    // Radix sort 需要临时 buffer（内部自动分配）
  }): ComputeTaskDescriptor;

  // 标注碰撞精筛
  // 输入：标注包围盒 + 优先级 → 输出：可见性标记
  createLabelCollisionTask(options: {
    labelBoxBuffer: BufferHandle;              // Storage: array of { x,y,w,h,priority }
    labelCount: number;
    viewportWidth: number;
    viewportHeight: number;
    outputVisibilityBuffer: BufferHandle;
  }): ComputeTaskDescriptor;

  // 点聚合（GPU Spatial Hashing）
  createPointClusterTask(options: {
    positionBuffer: BufferHandle;              // Storage: array<vec2<f32>>
    pointCount: number;
    cellSize: number;
    outputClusterBuffer: BufferHandle;         // Storage: cluster centers + counts
  }): ComputeTaskDescriptor;

  // --- 自定义 Compute 任务 ---
  createCustomTask(descriptor: ComputeTaskDescriptor): ComputeTaskDescriptor;

  // --- 编码所有 Compute 任务到 CommandEncoder ---
  // 按依赖关系拓扑排序后顺序执行
  encodeAll(
    encoder: GPUCommandEncoder,
    tasks: ComputeTaskDescriptor[],
  ): void;

  // --- 内置 Compute Shader 源码 ---
  readonly builtinShaders: {
    readonly frustumCull: string;              // WGSL 源码
    readonly radixSort: string;
    readonly labelCollision: string;
    readonly spatialHash: string;
    readonly terrainTessellation: string;
  };
}
```

---

## 新增模块 10：BlendPresets — 混合模式预设

```typescript
// ============================================================
// blend-presets.ts — GPUBlendState 预设
// WebGPU 的混合状态配置复杂，提供常用预设简化使用
// ============================================================

export interface BlendPresets {
  // 不透明（默认，无混合）
  readonly opaque: undefined;                  // blendState = undefined

  // 标准 Alpha 混合（半透明）
  // src * srcAlpha + dst * (1 - srcAlpha)
  readonly alphaBlend: GPUBlendState;

  // 预乘 Alpha 混合（推荐用于纹理）
  // src * 1 + dst * (1 - srcAlpha)
  readonly premultipliedAlpha: GPUBlendState;

  // 叠加模式（光晕、发光效果）
  // src * 1 + dst * 1
  readonly additive: GPUBlendState;

  // 乘法模式（阴影、暗化）
  // src * dst + dst * 0
  readonly multiply: GPUBlendState;

  // Screen 模式（亮化）
  // src * (1 - dst) + dst * 1
  readonly screen: GPUBlendState;

  // 模板写入（只写深度/模板，不写颜色）
  readonly stencilOnly: GPUBlendState;

  // 自定义混合
  custom(
    colorSrc: GPUBlendFactor,
    colorDst: GPUBlendFactor,
    colorOp: GPUBlendOperation,
    alphaSrc: GPUBlendFactor,
    alphaDst: GPUBlendFactor,
    alphaOp: GPUBlendOperation,
  ): GPUBlendState;
}
```

---

## 新增模块 11：UniformLayoutBuilder — Uniform 自动布局

```typescript
// ============================================================
// uniform-layout.ts — 自动生成 Uniform Buffer 布局
// 处理 WGSL 的对齐规则（16 字节对齐等）
// ============================================================

export type UniformFieldType =
  | 'f32' | 'i32' | 'u32'                      // 4 字节
  | 'vec2f' | 'vec2i' | 'vec2u'                // 8 字节
  | 'vec3f' | 'vec3i' | 'vec3u'                // 12 字节，对齐到 16
  | 'vec4f' | 'vec4i' | 'vec4u'                // 16 字节
  | 'mat3x3f'                                   // 48 字节（3 × vec4 对齐）
  | 'mat4x4f';                                  // 64 字节

export interface UniformField {
  readonly name: string;
  readonly type: UniformFieldType;
}

export interface ComputedUniformLayout {
  readonly fields: readonly UniformField[];
  readonly offsets: ReadonlyMap<string, number>; // 字段名 → 字节偏移
  readonly totalSize: number;                   // 总字节（含 padding）
  readonly wgslStructCode: string;              // 生成的 WGSL struct 声明
  readonly wgslBindingCode: string;             // 生成的 @group/@binding 声明
}

export interface UniformLayoutBuilder {
  // 添加字段
  addField(name: string, type: UniformFieldType): this;

  // 从 ShaderModuleDefinition 的 uniformDeclarations 批量添加
  addFromModule(module: ShaderModuleDefinition): this;

  // 构建布局（自动处理 WGSL 对齐规则）
  build(group: number, binding: number): ComputedUniformLayout;

  // 创建 CPU 端写入器（方便逐字段写入 ArrayBuffer）
  createWriter(layout: ComputedUniformLayout): UniformWriter;

  // 清空
  reset(): this;
}

export interface UniformWriter {
  readonly buffer: ArrayBuffer;
  readonly view: DataView;

  // 按字段名写入值
  setFloat(name: string, value: number): this;
  setInt(name: string, value: number): this;
  setUint(name: string, value: number): this;
  setVec2(name: string, x: number, y: number): this;
  setVec3(name: string, x: number, y: number, z: number): this;
  setVec4(name: string, x: number, y: number, z: number, w: number): this;
  setMat4(name: string, m: Mat4f): this;

  // 获取最终数据（用于上传 GPU）
  getData(): ArrayBuffer;
}
```

**WGSL 对齐规则实现要点**：
- `f32` / `i32` / `u32`：对齐 4 字节
- `vec2<f32>`：对齐 8 字节
- `vec3<f32>`：对齐 **16 字节**（不是 12！WGSL 规范要求 vec3 对齐到 16）
- `vec4<f32>`：对齐 16 字节
- `mat3x3<f32>`：实际存储为 3 × `vec4<f32>`（每行 padding 到 16），总 48 字节
- `mat4x4<f32>`：4 × `vec4<f32>`，总 64 字节
- struct 总大小必须是最大对齐值的倍数

---

## 新增：WGSLTemplates — 内置 Shader 模板骨架（v2.1，修复审计缺口 #3）

```typescript
// ============================================================
// wgsl-templates.ts — 内置 WGSL Shader 模板
// ShaderAssembler 基于这些模板进行模块拼装和 Hook 注入
// ============================================================

export interface WGSLTemplates {
  // 顶点着色器模板
  readonly vertexTemplate: string;
  // 片元着色器模板
  readonly fragmentTemplate: string;
  // Compute 着色器模板（视锥剔除/排序/碰撞检测）
  readonly computeTemplates: Record<string, string>;

  // 内置投影模块 WGSL
  readonly projectionModules: Record<string, string>;  // 'mercator' | 'globe' | 'ortho'
  // 内置几何模块 WGSL
  readonly geometryModules: Record<string, string>;    // 'point' | 'line' | 'polygon'
  // 内置样式模块 WGSL
  readonly styleModules: Record<string, string>;       // 'fill_solid' | 'fill_gradient' | 'stroke'
  // 内置特性模块 WGSL
  readonly featureModules: Record<string, string>;     // 'logDepth' | 'splitDouble' | 'sdf_line' | 'msdf_text'
}
```

### 顶点着色器模板（骨架代码）

```wgsl
// ============================================================
// vertex_template.wgsl — 顶点着色器模板
// ShaderAssembler 在 {{MODULE}} 位置注入具体模块代码
// ============================================================

// ===== 共享 Uniform =====
struct PerFrameUniforms {
  viewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  vpMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  viewport: vec2<f32>,
  time: f32,
  zoom: f32,
};
@group(0) @binding(0) var<uniform> frame: PerFrameUniforms;

// ===== 投影模块注入点 =====
// {{PROJECTION_MODULE}}
// 必须实现: fn projectPosition(worldPos: vec3<f32>) -> vec4<f32>;

// ===== 几何模块注入点 =====
// {{GEOMETRY_MODULE}}
// 必须实现: fn processVertex(input: VertexInput) -> VertexOutput;

// ===== 特性模块注入点（可选，多个拼接）=====
// {{FEATURE_MODULES}}
// 如 splitDouble, logDepth 等

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  // splitDouble 时额外属性:
  // @location(4) positionHigh: vec3<f32>,
  // @location(5) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  // {{EXTRA_VARYINGS}}
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Hook: 投影前修改位置
  var worldPos = input.position;
  // HOOK: vertex_position_before_projection

  // 投影（注入的模块函数）
  output.clipPosition = projectPosition(worldPos);

  // Hook: 投影后修改位置
  // HOOK: vertex_position_after_projection

  // 几何处理（法线、UV 等）
  output = processVertex(input);

  // Hook: 自定义输出
  // HOOK: vertex_output_custom

  return output;
}
```

### 片元着色器模板（骨架代码）

```wgsl
// ============================================================
// fragment_template.wgsl — 片元着色器模板
// ============================================================

// ===== 样式 Uniform =====
// {{PER_LAYER_UNIFORMS}}

// ===== 样式模块注入点 =====
// {{STYLE_MODULE}}
// 必须实现: fn computeColor(input: FragmentInput) -> vec4<f32>;

struct FragmentInput {
  @location(0) worldPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  // {{EXTRA_VARYINGS}}
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // Hook: 样式计算前
  // HOOK: fragment_color_before_style

  // 样式计算（注入的模块函数）
  var color = computeColor(input);

  // Hook: 样式计算后
  // HOOK: fragment_color_after_style

  // Hook: 修改 alpha
  // HOOK: fragment_alpha

  // Hook: 自定义丢弃
  // HOOK: fragment_discard

  return color;
}
```

### 内置投影模块示例：Mercator

```wgsl
// ============================================================
// projection/mercator.wgsl — 墨卡托投影模块
// 实现标准函数签名: fn projectPosition(worldPos: vec3<f32>) -> vec4<f32>
// ============================================================

fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  // worldPos.xy 是墨卡托坐标（归一化到 [0, worldSize]）
  // worldPos.z 是高程
  let projected = frame.vpMatrix * vec4<f32>(worldPos, 1.0);
  return projected;
}
```

### 内置投影模块示例：Globe

```wgsl
// ============================================================
// projection/globe.wgsl — 地球投影模块
// 使用 ECEF 坐标 + Split-Double 精度
// ============================================================

// Split-Double uniform（从 L0/PrecisionManager 上传）
struct RTCCenter {
  high: vec3<f32>,
  low: vec3<f32>,
};
@group(1) @binding(1) var<uniform> rtcCenter: RTCCenter;

fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  // worldPos 已经是相对于 RTC 中心的偏移量
  // 在 splitDouble 模式下:
  //   relativeHigh = positionHigh - rtcCenter.high
  //   relativeLow  = positionLow  - rtcCenter.low
  //   position = relativeHigh + relativeLow
  let ecefRelative = worldPos;
  let projected = frame.vpMatrix * vec4<f32>(ecefRelative, 1.0);
  return projected;
}
```

### 内置特性模块：Split-Double

```wgsl
// ============================================================
// feature/split_double.wgsl — 双精度仿真
// 在 Vertex Shader 中重建高精度位置
// ============================================================

fn reconstructDoublePrecision(high: vec3<f32>, low: vec3<f32>, centerHigh: vec3<f32>, centerLow: vec3<f32>) -> vec3<f32> {
  let relativeHigh = high - centerHigh;
  let relativeLow = low - centerLow;
  return relativeHigh + relativeLow;
}
```

### 内置特性模块：Log Depth

```wgsl
// ============================================================
// feature/log_depth.wgsl — 对数深度缓冲
// Vertex: 计算对数深度并传递给 Fragment
// Fragment: 写入 frag_depth
// ============================================================

// Vertex 端（追加到 vs_main 末尾）
fn applyLogDepthVertex(clipPos: vec4<f32>, near: f32) -> f32 {
  let logZ = log2(max(1e-6, clipPos.w + 1.0)) * (1.0 / log2(frame.farPlane + 1.0));
  return logZ;
}

// Fragment 端
fn applyLogDepthFragment(logZ: f32) -> f32 {
  return logZ;  // 写入 @builtin(frag_depth)
}
```

### 内置特性模块：SDF Line

```wgsl
// ============================================================
// feature/sdf_line.wgsl — SDF 线段抗锯齿
// 在 Fragment Shader 中计算到线段的距离并平滑 alpha
// ============================================================

fn sdfLineAlpha(dist: f32, lineWidth: f32, antialias: f32) -> f32 {
  let halfWidth = lineWidth * 0.5;
  let edge = halfWidth - antialias;
  return 1.0 - smoothstep(edge, halfWidth, abs(dist));
}
```

---

## L2 全局初始化流程

```typescript
async function initializeL2(l1: L1Modules, config: EngineConfig) {
  const { device } = l1.deviceManager;

  // 1. BlendPresets — 无状态，纯常量
  const blendPresets = createBlendPresets();

  // 2. DepthManager — 依赖 config
  const depthManager = createDepthManager(device, config);

  // 3. StencilManager — 依赖 device
  const stencilManager = createStencilManager(device);

  // 4. UniformLayoutBuilder — 无状态工厂
  const uniformLayoutBuilder = createUniformLayoutBuilder();

  // 5. ShaderAssembler — 依赖 UniformLayoutBuilder
  const shaderAssembler = createShaderAssembler(uniformLayoutBuilder);
  // 注册内置 Shader 模块
  registerBuiltinProjections(shaderAssembler);   // mercator, globe, perspective, ortho
  registerBuiltinGeometries(shaderAssembler);    // point, line, polygon, extrusion, mesh
  registerBuiltinStyles(shaderAssembler);        // fill_solid, fill_gradient, stroke, icon, text
  registerBuiltinFeatures(shaderAssembler);      // logDepth, splitDouble, sdf_line, msdf_text

  // 6. PipelineCache — 依赖 device + ShaderAssembler
  const pipelineCache = createPipelineCache(device, shaderAssembler);

  // 7. ComputePassManager — 依赖 device + PipelineCache
  const computePassManager = createComputePassManager(device, pipelineCache);

  // 8. RenderStats — 依赖 device（timestamp query）
  const renderStats = createRenderStats(device, l1.deviceManager.capabilities);

  // 9. Compositor — 依赖 device + DepthManager + BlendPresets
  const compositor = createCompositor(device, depthManager, blendPresets);

  // 10. PickingEngine — 依赖 device + L1.uploader
  const pickingEngine = createPickingEngine(device, l1.uploader);

  // 11. RenderGraph + FrameGraphBuilder — 依赖以上所有
  const renderGraph = createRenderGraph(device);
  const frameGraphBuilder = createFrameGraphBuilder(
    renderGraph, l1.surface, depthManager, compositor, computePassManager, renderStats
  );

  return {
    blendPresets, depthManager, stencilManager, uniformLayoutBuilder,
    shaderAssembler, pipelineCache, computePassManager, renderStats,
    compositor, pickingEngine, renderGraph, frameGraphBuilder,
  };
}
```

---

## L2 每帧执行流程（详细版）

```
帧开始
  │
  ├── frameGraphBuilder.begin(surface, camera)
  │
  ├── [L4 图层管理器遍历所有可见图层]
  │   │
  │   ├── 图层 A（2D 矢量，投影=mercator）
  │   │   └── builder.addSceneRenderPass({ projection: 'mercator', layers: [A] })
  │   │
  │   ├── 图层 B（3D 建筑，投影=globe）
  │   │   └── builder.addSceneRenderPass({ projection: 'globe', layers: [B] })
  │   │
  │   └── 图层 C（标注，投影=screen）
  │       └── builder.addScreenPass({ layers: [C] })
  │
  ├── [如果有 Compute 任务]
  │   ├── builder.addFrustumCullPass(...)
  │   ├── builder.addDepthSortPass(...)
  │   └── builder.addLabelCollisionPass(...)
  │
  ├── [如果有后处理]
  │   ├── builder.addPostProcessPass({ id: 'bloom', ... })
  │   └── builder.addPostProcessPass({ id: 'ssao', ... })
  │
  ├── [如果需要 Picking]
  │   └── builder.addPickingPass({ layers: [...], pixelX, pixelY })
  │
  ├── compiledGraph = builder.build()
  │   │
  │   │  内部自动执行：
  │   │  1. 检测同投影 Pass → 合并（如 A 和 C 都是 mercator 则合并为一个 Pass）
  │   │  2. 拓扑排序（Compute → Render → Composite → PostProcess → Screen）
  │   │  3. 分配中间纹理（从 TextureManager 池中获取）
  │   │  4. 如果只有一种投影 → 跳过 Compositor（直接输出到屏幕）
  │   │  5. 生成 CommandBuffer
  │   │
  │   ▼
  │
  ├── compiledGraph.execute(queue)
  │   │
  │   │  实际 GPU 执行顺序：
  │   │  ┌────────────────────────────────────┐
  │   │  │ Compute Pass                        │
  │   │  │  1. frustumCull.dispatch(...)        │
  │   │  │  2. depthSort.dispatch(...)          │
  │   │  │  3. labelCollision.dispatch(...)     │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ Render Pass: mercator              │
  │   │  │  clear(color, depth)                │
  │   │  │  layerA.encode(encoder, camera)     │
  │   │  │  → output: textureMercator + depth  │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ Render Pass: globe                  │
  │   │  │  clear(color, depth)                │
  │   │  │  layerB.encode(encoder, camera)     │
  │   │  │  → output: textureGlobe + depth     │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ Compositing Pass                    │
  │   │  │  统一深度空间                        │
  │   │  │  按像素比较深度取最近颜色             │
  │   │  │  半透明 OIT 混合                     │
  │   │  │  → output: composited texture       │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ PostProcess Chain                   │
  │   │  │  bloom → ssao → ...                 │
  │   │  │  → output: final texture            │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ Screen Pass                         │
  │   │  │  标注、UI 控件、图例                 │
  │   │  │  → output: screen canvas            │
  │   │  └────────────────────────────────────┘
  │   │  ┌────────────────────────────────────┐
  │   │  │ Picking Pass (optional, 降采样)     │
  │   │  │  渲染 Color-ID + 深度               │
  │   │  │  → output: picking texture (异步读) │
  │   │  └────────────────────────────────────┘
  │   │
  │   ▼
  │
  └── renderStats.endFrame()
```

---

## L2 与 L1 的对接点

| L2 消费 | L1 提供 |
|---------|---------|
| Shader 编译 | `DeviceManager.device.createShaderModule()` |
| Pipeline 创建 | `DeviceManager.device.createRenderPipeline()` |
| 中间纹理分配 | `TextureManager.create()` |
| 深度纹理 | `DepthManager.createDepthTexture()` → `TextureManager` |
| Uniform 上传 | `GPUUploader.writeUniform()` |
| Compute Buffer | `BufferPool.acquire(STORAGE)` |
| BindGroup | `BindGroupCache.getOrCreate()` |
| Picking 回读 | `GPUUploader.readbackTexture()` |
| 帧渲染目标 | `SurfaceManager.getCurrentTextureView()` |
| 内存追踪 | `GPUMemoryTracker.track()` 每个纹理/Buffer |

## L2 与 L0 的对接点

| L2 消费 | L0 提供 |
|---------|---------|
| 投影 WGSL 代码 | `ProjectionModule.vertexShaderCode` |
| 视锥体平面 | `frustum.fromViewProjection(vpMatrix)` |
| 射线-椭球求交 | `intersect.rayEllipsoid()` (Picking) |
| 矩阵运算 | `mat4.multiply`, `mat4.invert` |
| WGSL 对齐规则 | `UniformLayoutBuilder` 内部硬编码对齐常量 |
| Viewport/CameraState/PickResult | 统一来自 `@gis-forge/core/types`（★ v2.1） |

---

## L2 模块统计

| 模块 | 公共方法数 | 状态 | v2.1 变更 |
|------|-----------|------|----------|
| ShaderAssembler | 10 + 2新 = 12 | 已有+补充 | — |
| PipelineCache | 7 | 已有不变 | — |
| DepthManager | 6 | 已有不变 | — |
| RenderGraph | 8 | 已有不变 | — |
| FrameGraphBuilder | 8 | 新增构建器 | layers 类型改为 L4/Layer |
| Compositor | 4 + 2新 = 6 | 已有+补充 | — |
| PickingEngine | 6 + 4新 = 10 | 已有+补充 | PickResult 引用 L0；+registerLayer/unregisterLayer |
| StencilManager | 2 | 已有不变 | — |
| RenderStats | 8 | 已有不变 | — |
| ComputePassManager | 7 | 新增 | — |
| BlendPresets | 8 | 新增 | — |
| UniformLayoutBuilder | 6 + UniformWriter 8 = 14 | 新增 | — |
| WGSLTemplates | — (纯数据模块) | **v2.1 新增** | 6 个 WGSL 骨架 |
| **合计** | **~98+ 个公共方法** | | |

全部 11 个模块 + 1 个构建器（FrameGraphBuilder）+ 1 个 WGSL 模板模块，零第三方依赖。

---

## v2.1 变更日志

| 变更 | 修复的审计问题 | 说明 |
|------|-------------|------|
| 删除 `RenderableLayer` 接口，统一使用 L4 `Layer` | 不一致 #1 | 消除 L2/L4 接口分裂 |
| `PickingEngine` 中 PickResult 引用 L0 定义 | 不一致 #6 | 删除 L2 本地 PickResult 定义 |
| PostProcessPass.execute 签名使用 `GPUCommandEncoder` | 不一致 #10 | Pass 自己管理 encoder 创建 |
| 新增 `WGSLTemplates` 模块 + 6 个内置 WGSL 代码骨架 | 缺口 #3 | 顶点/片元模板 + mercator/globe/splitDouble/logDepth/sdfLine |
| FrameGraphBuilder 中 `layers` 类型改为 `Layer[]` | 不一致 #1 | 与 L4 统一 |
| 所有 Viewport/CameraState 引用统一从 L0 import | 不一致 #3 #7 | 消除跨层类型定义冲突 |
