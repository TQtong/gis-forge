// ============================================================
// playground/src/scenes/index.ts
// 场景注册表 — 导入所有场景配置并组织为 Record<string, SceneConfig>。
// MapViewport 通过 sceneId 查找此映射表获取对应场景的生命周期方法。
// ============================================================

import type { SceneConfig } from '../types';

// ─── 默认欢迎页 ───
import welcome from './welcome';

// ─── P0：相机与核心图层 ───
import camera2d from './p0/camera-2d';
import rasterTileLayer from './p0/raster-tile-layer';
import vectorTileLayer from './p0/vector-tile-layer';
import geojsonLayer from './p0/geojson-layer';

// ─── P1：3D 渲染 ───
import terrainLayer from './p1/terrain-layer';
import globeRenderer from './p1/globe-renderer';

// ─── P2：增强功能 ───
import heatmapLayer from './p2/heatmap-layer';
import markerLayer from './p2/marker-layer';
import drawTool from './p2/draw-tool';
import measureTool from './p2/measure-tool';

// ─── P3：生态扩展 ───
import analysisDemo from './p3/analysis-demo';

// ─── 集成场景 ───
import city2d from './integration/city-2d';

/**
 * 全局场景注册表。
 * key = 场景 ID（与 URL hash 路由一致），value = SceneConfig 对象。
 *
 * 约定：
 * - key 格式为 '{priority}-{feature-name}'，如 'p0-camera-2d'
 * - welcome 场景的 key 为 'welcome'（无优先级前缀）
 * - 集成场景的 key 前缀为 'integration-'
 *
 * 新增场景步骤：
 * 1. 在 scenes/{group}/ 目录下创建新的 .ts 文件（实现 SceneConfig）
 * 2. 在本文件中 import 并添加到 scenes 映射
 * 3. 在 data/featureTreeData.ts 中添加对应的树节点（sceneId 指向此处的 key）
 */
export const scenes: Record<string, SceneConfig> = {
  // 默认欢迎页
  'welcome': welcome,

  // P0：相机与核心图层
  'p0-camera-2d': camera2d,
  'p0-raster-tile-layer': rasterTileLayer,
  'p0-vector-tile-layer': vectorTileLayer,
  'p0-geojson-layer': geojsonLayer,

  // P1：3D 渲染
  'p1-terrain-layer': terrainLayer,
  'p1-globe-renderer': globeRenderer,

  // P2：增强功能
  'p2-heatmap-layer': heatmapLayer,
  'p2-marker-layer': markerLayer,
  'p2-draw-tool': drawTool,
  'p2-measure-tool': measureTool,

  // P3：生态扩展
  'p3-analysis': analysisDemo,

  // 集成场景
  'integration-city-2d': city2d,
};
