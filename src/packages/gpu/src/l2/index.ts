// ============================================================
// l2/index.ts — L2 渲染层统一导出（Barrel Export）
// 上层模块通过此文件导入 L2 的所有公共接口。
//
// 导出 13 个模块的接口类型和工厂函数：
//   1.  BlendPresets          — 混合模式预设
//   2.  UniformLayoutBuilder  — Uniform 自动布局
//   3.  WGSLTemplates         — WGSL 模板
//   4.  DepthManager          — 深度缓冲管理
//   5.  StencilManager        — 模板缓冲管理
//   6.  RenderStats           — 渲染统计
//   7.  ShaderAssembler       — Shader 模块化组装
//   8.  PipelineCache         — Pipeline 缓存
//   9.  ComputePassManager    — GPU Compute 任务管理
//   10. Compositor            — 多投影合成 + OIT
//   11. PickingEngine         — Color-ID 拾取
//   12. RenderGraph           — 渲染图 DAG
//   13. FrameGraphBuilder     — 声明式帧图构建
// ============================================================

// --- Module 1: BlendPresets ---
export type { BlendPresets } from './blend-presets.ts';
export { createBlendPresets } from './blend-presets.ts';

// --- Module 2: UniformLayoutBuilder ---
export type {
  UniformFieldType,
  UniformField,
  ComputedUniformLayout,
  UniformLayoutBuilder,
  UniformWriter,
} from './uniform-layout.ts';
export { createUniformLayoutBuilder } from './uniform-layout.ts';

// --- Module 3: WGSLTemplates ---
export type { WGSLTemplates } from './wgsl-templates.ts';
export { createWGSLTemplates } from './wgsl-templates.ts';

// --- Module 4: DepthManager ---
export type { DepthConfig, DepthManager } from './depth-manager.ts';
export { createDepthManager } from './depth-manager.ts';

// --- Module 5: StencilManager ---
export type { StencilManager } from './stencil-manager.ts';
export { createStencilManager } from './stencil-manager.ts';

// --- Module 6: RenderStats ---
export type { FrameStats, RenderStats } from './render-stats.ts';
export { createRenderStats } from './render-stats.ts';

// --- Module 7: ShaderAssembler ---
export type {
  ShaderModuleType,
  ShaderModuleDefinition,
  ShaderUniformDeclaration,
  ShaderVariantKey,
  AssembledShader,
  UniformLayout,
  ShaderHookPoint,
  ShaderAssembler,
} from './shader-assembler.ts';
export { createShaderAssembler } from './shader-assembler.ts';

// --- Module 8: PipelineCache ---
export type {
  AutoWarmupOptions,
  CompileProgressEvent,
  PipelineCacheCreateOptions,
  PipelineDescriptor,
  PipelineCache,
} from './pipeline-cache.ts';
export { createPipelineCache } from './pipeline-cache.ts';

// --- Module 9: ComputePassManager ---
export type {
  BuiltinComputeTask,
  ComputeTaskDescriptor,
  ComputePassManager,
} from './compute-pass.ts';
export { createComputePassManager } from './compute-pass.ts';

// --- Module 10: Compositor ---
export type { CompositorInput, Compositor } from './compositor.ts';
export { createCompositor } from './compositor.ts';

// --- Module 11: PickingEngine ---
export type { PickingEngine } from './picking-engine.ts';
export { createPickingEngine } from './picking-engine.ts';

// --- Module 12: RenderGraph ---
export type {
  RenderPassType,
  RenderPassNode,
  ResourceReference,
  PassExecutionContext,
  CompiledRenderGraph,
  RenderGraph,
} from './render-graph.ts';
export { createRenderGraph } from './render-graph.ts';

// --- Module 13: FrameGraphBuilder ---
export type {
  PostProcessPassFactory,
  FrameGraphBuilder,
} from './frame-graph-builder.ts';
export { createFrameGraphBuilder, computeCameraHash } from './frame-graph-builder.ts';

// ============================================================
// L2 全局初始化便捷函数
// ============================================================

import type { L1Context } from '../l1/index.ts';

import { createBlendPresets } from './blend-presets.ts';
import { createDepthManager } from './depth-manager.ts';
import { createStencilManager } from './stencil-manager.ts';
import { createUniformLayoutBuilder } from './uniform-layout.ts';
import { createShaderAssembler } from './shader-assembler.ts';
import { createPipelineCache } from './pipeline-cache.ts';
import { createComputePassManager } from './compute-pass.ts';
import { createRenderStats } from './render-stats.ts';
import { createCompositor } from './compositor.ts';
import { createPickingEngine } from './picking-engine.ts';
import { createRenderGraph } from './render-graph.ts';
import { createFrameGraphBuilder } from './frame-graph-builder.ts';

import type { BlendPresets } from './blend-presets.ts';
import type { DepthManager } from './depth-manager.ts';
import type { StencilManager } from './stencil-manager.ts';
import type { UniformLayoutBuilder } from './uniform-layout.ts';
import type { ShaderAssembler } from './shader-assembler.ts';
import type { PipelineCache } from './pipeline-cache.ts';
import type { ComputePassManager } from './compute-pass.ts';
import type { RenderStats } from './render-stats.ts';
import type { Compositor } from './compositor.ts';
import type { PickingEngine } from './picking-engine.ts';
import type { RenderGraph } from './render-graph.ts';
import type { FrameGraphBuilder } from './frame-graph-builder.ts';

/**
 * L2 全局初始化结果。
 * 包含所有 13 个 L2 模块的实例。
 */
export interface L2Context {
  /** 混合模式预设 */
  readonly blendPresets: BlendPresets;
  /** 深度缓冲管理器 */
  readonly depthManager: DepthManager;
  /** 模板缓冲管理器 */
  readonly stencilManager: StencilManager;
  /** Uniform 布局构建器 */
  readonly uniformLayoutBuilder: UniformLayoutBuilder;
  /** Shader 模块化组装器 */
  readonly shaderAssembler: ShaderAssembler;
  /** 渲染/计算管线缓存 */
  readonly pipelineCache: PipelineCache;
  /** GPU Compute 任务管理器 */
  readonly computePassManager: ComputePassManager;
  /** 渲染统计信息收集器 */
  readonly renderStats: RenderStats;
  /** 多投影合成器 */
  readonly compositor: Compositor;
  /** Color-ID 拾取引擎 */
  readonly pickingEngine: PickingEngine;
  /** 渲染图 DAG */
  readonly renderGraph: RenderGraph;
  /** 声明式帧图构建器 */
  readonly frameGraphBuilder: FrameGraphBuilder;
}

/**
 * 初始化 L2 渲染层的所有模块。
 * 按依赖顺序创建 13 个模块并返回 L2Context。
 *
 * @param l1 - 已初始化的 L1Context（L2 消费 L1 的 GPU 资源）
 * @returns L2Context 包含所有模块实例
 *
 * @example
 * const l1 = await initializeL1(canvas);
 * const l2 = initializeL2(l1);
 *
 * // 使用 ShaderAssembler 组装 Shader
 * const shader = l2.shaderAssembler.assemble({
 *   projection: 'mercator', geometry: 'polygon',
 *   style: 'fill_solid', features: [],
 * });
 *
 * // 使用 PipelineCache 获取渲染管线
 * const pipeline = l2.pipelineCache.getOrCreate({ ... });
 */
export function initializeL2(l1: L1Context): L2Context {
  const device = l1.deviceManager.device;

  // 1. BlendPresets — 无状态，纯常量
  const blendPresets = createBlendPresets();

  // 2. DepthManager — 依赖 device 和引擎配置
  const depthManager = createDepthManager(device, {
    antialias: false,
    reversedZ: true,
  });

  // 3. StencilManager — 依赖 device
  const stencilManager = createStencilManager(device);

  // 4. UniformLayoutBuilder — 无状态工厂
  const uniformLayoutBuilder = createUniformLayoutBuilder();

  // 5. ShaderAssembler — 依赖 UniformLayoutBuilder
  const shaderAssembler = createShaderAssembler(uniformLayoutBuilder);

  // 6. PipelineCache — 依赖 device + ShaderAssembler
  const pipelineCache = createPipelineCache(device, shaderAssembler);

  // 7. ComputePassManager — 依赖 device + PipelineCache
  const computePassManager = createComputePassManager(device, pipelineCache);

  // 8. RenderStats — 依赖 device（timestamp query 能力）
  const renderStats = createRenderStats(device, l1.deviceManager.capabilities);

  // 9. Compositor — 依赖 device + DepthManager + BlendPresets
  const compositor = createCompositor(device, depthManager, blendPresets);

  // 10. PickingEngine — 依赖 device + L1.uploader
  const pickingEngine = createPickingEngine(device, l1.uploader);

  // 11. RenderGraph — 依赖 device
  const renderGraph = createRenderGraph(device);

  // 12. FrameGraphBuilder — 依赖 RenderGraph + device
  const frameGraphBuilder = createFrameGraphBuilder(renderGraph, device);

  return {
    blendPresets,
    depthManager,
    stencilManager,
    uniformLayoutBuilder,
    shaderAssembler,
    pipelineCache,
    computePassManager,
    renderStats,
    compositor,
    pickingEngine,
    renderGraph,
    frameGraphBuilder,
  };
}
