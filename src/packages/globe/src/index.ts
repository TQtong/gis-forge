// ============================================================
// globe/index.ts — @geoforge/globe 包入口
// 导出地球渲染器工厂函数和关键类型。
// 使用命名导出，无 default export，确保 Tree-Shake 友好。
// ============================================================

export { createGlobeRenderer } from './GlobeRenderer.ts';
export type { GlobeRenderer, GlobeOptions } from './GlobeRenderer.ts';
export type { AtmosphereConstants, StarfieldData, EllipsoidMeshData } from './GlobeRenderer.ts';
export { generateEllipsoidMesh, generateStarfield, computeSunPositionECEF, computeTransmittanceLUT, computeCascadeSplits, buildAtmosphereConstants } from './GlobeRenderer.ts';
