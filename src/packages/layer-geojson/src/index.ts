// ============================================================
// layer-geojson/index.ts — GeoJSON 图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createGeoJSONLayer } from './GeoJSONLayer.ts';
export type { GeoJSONIncrementalDiffStats, GeoJSONLayer, GeoJSONLayerOptions } from './GeoJSONLayer.ts';

// --- GeoJSON 瓦片切片器 ---
export { createGeoJSONVT } from './geojson-vt.ts';
export type { GeoJSONVT, GeoJSONVTOptions, SlicedFeature, VTTile } from './geojson-vt.ts';
