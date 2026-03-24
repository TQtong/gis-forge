// ============================================================
// scene/index.ts — L4 场景层统一导出（Barrel Export）
// 导出 11 个核心场景模块的接口类型和工厂函数。
// ============================================================

// --- Module 1: SceneGraph ---
export type { SceneNode, SceneGraph, Layer } from './scene-graph.ts';
export { createSceneGraph } from './scene-graph.ts';

// --- Module 2: LayerManager ---
export type { LayerSpec, LayerContext, LayerManager } from './layer-manager.ts';
export { createLayerManager, createDefaultLayer } from './layer-manager.ts';

// --- Module 3: SourceManager ---
export type { SourceSpec, Source, SourceManager } from './source-manager.ts';
export { createSourceManager } from './source-manager.ts';

// --- Module 4: StyleEngine ---
export type { CompiledStyle, StyleEngine } from './style-engine.ts';
export { createStyleEngine } from './style-engine.ts';

// --- Module 5: LabelManager ---
export type { LabelSpec, PlacedLabel, LabelManager } from './label-manager.ts';
export { createLabelManager } from './label-manager.ts';

// --- Module 6: GlyphManager ---
export type { GlyphMetrics, GlyphManager } from './glyph-manager.ts';
export { createGlyphManager } from './glyph-manager.ts';

// --- Module 7: FeatureStateManager ---
export type { FeatureStateManager } from './feature-state.ts';
export { createFeatureStateManager } from './feature-state.ts';

// --- Module 8: AntiMeridianHandler ---
export type { AntiMeridianHandler } from './antimeridian.ts';
export { createAntiMeridianHandler } from './antimeridian.ts';

// --- Module 9: AnimationManager ---
export type { AnimationOptions, Animation, AnimationManager } from './animation.ts';
export { createAnimationManager } from './animation.ts';

// --- Module 10: SpatialQuery ---
export type { QueryOptions, SpatialQuery } from './spatial-query.ts';
export { createSpatialQuery } from './spatial-query.ts';

// --- Module 11: A11yManager ---
export type { A11yManager } from './a11y.ts';
export { createA11yManager } from './a11y.ts';

// ============================================================
// L4 全局初始化便捷函数
// ============================================================

import { createFeatureStateManager } from './feature-state.ts';
import { createAntiMeridianHandler } from './antimeridian.ts';
import { createGlyphManager } from './glyph-manager.ts';
import { createStyleEngine } from './style-engine.ts';
import { createLabelManager } from './label-manager.ts';
import { createSourceManager } from './source-manager.ts';
import { createAnimationManager } from './animation.ts';
import { createSpatialQuery } from './spatial-query.ts';
import { createA11yManager } from './a11y.ts';
import { createLayerManager } from './layer-manager.ts';
import { createSceneGraph } from './scene-graph.ts';

import type { FeatureStateManager } from './feature-state.ts';
import type { AntiMeridianHandler } from './antimeridian.ts';
import type { GlyphManager } from './glyph-manager.ts';
import type { StyleEngine } from './style-engine.ts';
import type { LabelManager } from './label-manager.ts';
import type { SourceManager } from './source-manager.ts';
import type { AnimationManager } from './animation.ts';
import type { SpatialQuery } from './spatial-query.ts';
import type { A11yManager } from './a11y.ts';
import type { LayerManager } from './layer-manager.ts';
import type { SceneGraph } from './scene-graph.ts';

/**
 * L4 全局初始化结果。
 */
export interface L4Context {
  readonly featureState: FeatureStateManager;
  readonly antimeridian: AntiMeridianHandler;
  readonly glyphManager: GlyphManager;
  readonly styleEngine: StyleEngine;
  readonly labelManager: LabelManager;
  readonly sourceManager: SourceManager;
  readonly animationManager: AnimationManager;
  readonly spatialQuery: SpatialQuery;
  readonly a11y: A11yManager;
  readonly layerManager: LayerManager;
  readonly sceneGraph: SceneGraph;
}

/**
 * 初始化 L4 场景层的所有模块。
 *
 * @returns L4Context
 *
 * @example
 * const l4 = initializeL4();
 * l4.layerManager.addLayer({ id: 'test', type: 'fill', source: 'streets' });
 */
export function initializeL4(): L4Context {
  // 1. FeatureStateManager — 无依赖
  const featureState = createFeatureStateManager();

  // 2. AntiMeridianHandler — 依赖 L0 算法
  const antimeridian = createAntiMeridianHandler();

  // 3. GlyphManager — 依赖 L1.textureManager（MVP 无连接）
  const glyphManager = createGlyphManager();

  // 4. StyleEngine — 依赖 L2.shaderAssembler（MVP 无连接）
  const styleEngine = createStyleEngine();

  // 5. LabelManager — 依赖 GlyphManager（MVP 无连接）
  const labelManager = createLabelManager();

  // 6. SourceManager — 依赖 L3（MVP 无连接）
  const sourceManager = createSourceManager();

  // 7. AnimationManager — 依赖 L0.interpolate
  const animationManager = createAnimationManager();

  // 8. SpatialQuery — 依赖 L2.pickingEngine（MVP stub）
  const spatialQuery = createSpatialQuery();

  // 9. A11yManager — 依赖 SpatialQuery
  const a11y = createA11yManager();

  // 10. LayerManager — 依赖以上所有
  const layerManager = createLayerManager();

  // 11. SceneGraph — 依赖 LayerManager
  const sceneGraph = createSceneGraph();

  return {
    featureState, antimeridian, glyphManager, styleEngine,
    labelManager, sourceManager, animationManager,
    spatialQuery, a11y, layerManager, sceneGraph,
  };
}
