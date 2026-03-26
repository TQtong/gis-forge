// ============================================================
// globe/index.ts — @geoforge/globe 包入口
// 导出地球渲染器工厂函数和关键类型。
// 使用命名导出，无 default export，确保 Tree-Shake 友好。
// ============================================================

export { createGlobeRenderer } from './GlobeRenderer.ts';
export type { GlobeRenderer, GlobeOptions } from './GlobeRenderer.ts';
export type { AtmosphereConstants, StarfieldData, EllipsoidMeshData } from './GlobeRenderer.ts';
export { generateEllipsoidMesh, generateStarfield, computeSunPositionECEF, computeTransmittanceLUT, computeCascadeSplits, buildAtmosphereConstants } from './GlobeRenderer.ts';

// --- 大气散射渲染器 ---
export { createAtmosphereRenderer } from './atmosphere.ts';
export type { AtmosphereRenderer, AtmosphereRendererOptions, AtmosphereRenderContext, AtmosphereLUTData } from './atmosphere.ts';

// --- 星空天穹渲染器 ---
export { createSkyboxRenderer } from './skybox.ts';
export type { SkyboxRenderer, SkyboxRendererOptions, SkyboxRenderContext } from './skybox.ts';

// --- 太阳位置计算 ---
export { computeSunPosition } from './sun.ts';
export type { SunPosition } from './sun.ts';

// --- 3D Globe 瓦片网格 + 覆盖算法 ---
export {
    getSegments,
    tessellateGlobeTile,
    tessellateGlobePolarCap,
    meshToRTE,
    meshToRTEInto,
    meshToRTE_HighLow,
    screenToGlobe,
    isTileVisible_Horizon,
    isTileVisible_Frustum,
    coveringTilesGlobe,
    computeMorphFactor,
    computeMorphVertices,
    lngToTileX,
    latToTileY,
    tileYToLat,
    isPolarTile,
    WGS84_ELLIPSOID,
    MERCATOR_LAT_LIMIT,
    POLE_LAT_NORTH,
    POLE_LAT_SOUTH,
    POLAR_CAP_SECTORS,
    POLAR_CAP_RINGS,
} from './globe-tile-mesh.ts';
export type { GlobeTileMesh, GlobeTileID, GlobeCamera, Ellipsoid } from './globe-tile-mesh.ts';
