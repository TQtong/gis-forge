# GeoForge 架构设计 — L2 渲染层完整接口定义（v2.1）

> **定位**：L2 是引擎的渲染核心——管理每帧如何将场景数据转化为像素。
> **模块数**：11 个 + 1 个构建器（FrameGraphBuilder）
>
> **v2.1 修订**：
> - 删除 `RenderableLayer` 接口，统一使用 L4 的 `Layer` 接口（修复审计不一致 #1）
> - 修复 PostProcessPass.execute 签名：`GPURenderPassEncoder` → `GPUCommandEncoder`（修复审计不一致 #10）
> - 新增 WGSL Shader 模板骨架（修复审计缺口 #3）
> - 所有 Viewport/CameraState/PickResult 引用统一来自 L0

---

## 类型依赖声明

```typescript
import type { Mat4f, Vec3f, BBox2D, Viewport, CameraState, PickResult, Feature } from '@geoforge/core';
import type { Layer } from '@geoforge/scene';  // L4 定义的 Layer 接口
```

---

## 模块清单

| # | 模块 | v2.1 状态 |
|---|------|----------|
| 1 | ShaderAssembler | 补充 Uniform 布局（不变） |
| 2 | PipelineCache | 不变 |
| 3 | DepthManager | 不变 |
| 4 | RenderGraph | 不变 |
| 5 | FrameGraphBuilder | **修订**：删除 RenderableLayer，使用 L4/Layer |
| 6 | Compositor | 补充 OIT（不变） |
| 7 | PickingEngine | **修订**：PickResult 统一引用 L0 |
| 8 | StencilManager | 不变 |
| 9 | RenderStats | 不变 |
| 10 | ComputePassManager | 不变 |
| 11 | BlendPresets | 不变 |
| 12 | UniformLayoutBuilder | 不变 |
| — | **WGSLTemplates**（新增）| **新增**：内置 Shader 模板骨架 |

---

## 不变的模块

ShaderAssembler、PipelineCache、DepthManager、RenderGraph、Compositor、StencilManager、RenderStats、ComputePassManager、BlendPresets、UniformLayoutBuilder 的接口与 v2.0 完全相同，此处不重复。

---

## FrameGraphBuilder — 修订版（修复审计不一致 #1）

```typescript
// ============================================================
// v2.1 变更：删除 RenderableLayer 接口
// 直接使用 L4 定义的 Layer 接口（Layer 已有 encode/encodePicking/isTransparent/projection/renderOrder）
// 这消除了 L2 和 L4 之间的接口分裂
// ============================================================

import type { Layer } from '@geoforge/scene';

export interface FrameGraphBuilder {
  begin(surface: SurfaceConfig, camera: CameraState): void;

  // Compute Pass
  addFrustumCullPass(options: { inputBuffers: BufferHandle[]; frustum: Mat4f }): string;
  addDepthSortPass(options: { inputBuffer: BufferHandle; cameraPosition: Vec3f }): string;
  addLabelCollisionPass(options: { labelBoxes: BufferHandle; labelCount: number; viewport: Viewport }): string;
  addCustomComputePass(pass: { id: string; pipeline: GPUComputePipeline; bindGroups: GPUBindGroup[]; workgroupCount: [number, number, number]; dependencies?: string[] }): string;

  // Render Pass — 使用 L4 的 Layer 接口（不再是 RenderableLayer）
  addSceneRenderPass(options: {
    id: string;
    projection: string;
    layers: Layer[];                           // ★ v2.1: 直接使用 L4/Layer
    clearColor?: [number, number, number, number];
    dependencies?: string[];
  }): string;

  // PostProcess Pass
  addPostProcessPass(pass: {
    id: string;
    factory: PostProcessPassFactory;
    inputPassId: string;
  }): string;

  // Screen Pass（UI 层）
  addScreenPass(options: { layers: Layer[] }): string;

  // Picking Pass
  addPickingPass(options: { layers: Layer[]; pixelX?: number; pixelY?: number }): string;

  build(): CompiledRenderGraph;
}
```

---

## PickingEngine — 修订版（修复审计不一致 #6）

```typescript
// ============================================================
// v2.1 变更：PickResult 统一使用 L0/types/viewport.ts 中的定义
// 删除 L2 本地的 PickResult 定义，统一从 @geoforge/core import
// ============================================================

import type { PickResult } from '@geoforge/core';

export interface PickingEngine {
  // 渲染 Picking 帧
  renderPickingFrame(graph: RenderGraph, encoder: GPUCommandEncoder): void;

  // 异步拾取（延迟 1 帧读取）
  pickAt(x: number, y: number): Promise<PickResult | null>;

  // 框选
  pickInRect(x1: number, y1: number, x2: number, y2: number): Promise<PickResult[]>;

  // 射线检测（3D）
  raycast(origin: Vec3f, direction: Vec3f, maxDistance: number): Promise<PickResult[]>;

  // 深度读取
  readDepthAt(x: number, y: number): Promise<number>;

  // 屏幕 → 世界坐标
  unprojectScreenToWorld(screenX: number, screenY: number, depth: number, inverseVPMatrix: Mat4f): Vec3f;

  // 屏幕 → 地球表面经纬度
  screenToGeodetic(screenX: number, screenY: number, vpMatrix: Mat4f, inverseVPMatrix: Mat4f): [number, number, number] | null;

  // 批量 picking
  pickRegion(x: number, y: number, width: number, height: number): Promise<Uint32Array>;

  // 图层注册
  registerLayer(layerId: string, resolver: (colorId: number) => PickResult | null): void;
  unregisterLayer(layerId: string): void;
}
```

---

## 新增：WGSLTemplates — 内置 Shader 模板骨架（修复审计缺口 #3）

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

## L2 每帧执行流程

（与 v2.0 相同，不变——但 `RenderableLayer` 引用全部替换为 `Layer`）

---

## L2 与其他层的对接点

（与 v2.0 相同，补充：所有 Viewport/CameraState/PickResult 引用统一来自 `@geoforge/core/types`）

---

## v2.1 变更日志

| 变更 | 修复的审计问题 |
|------|-------------|
| 删除 `RenderableLayer` 接口，统一使用 L4 `Layer` | 不一致 #1 |
| `PickingEngine` 中 PickResult 引用 L0 定义 | 不一致 #6 |
| PostProcessPass.execute 签名使用 `GPUCommandEncoder`（它内部自建 RenderPassEncoder） | 不一致 #10（明确语义：Pass 自己管理 encoder 创建）|
| 新增 `WGSLTemplates` 模块 + 6 个内置 WGSL 代码骨架 | 缺口 #3 |
| FrameGraphBuilder 中 `layers` 类型改为 `Layer[]` | 不一致 #1 |
| 所有 Viewport/CameraState 引用统一从 L0 import | 不一致 #3 #7 |
