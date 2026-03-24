// ============================================================
// layer-terrain/index.ts — 地形图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createTerrainLayer } from './TerrainLayer.ts';
export type { TerrainLayer, TerrainLayerOptions } from './TerrainLayer.ts';

// --- DEM → 三角网格构建器 ---
export { buildTerrainMesh } from './terrain-mesh-builder.ts';
export type { TerrainMesh, TerrainMeshOptions, DEMData } from './terrain-mesh-builder.ts';
