// ============================================================
// layer-tile-vector/index.ts — 矢量瓦片图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createVectorTileLayer } from './VectorTileLayer.ts';
export type { VectorTileLayer, VectorTileLayerOptions } from './VectorTileLayer.ts';

// --- MVT Protobuf 解码器 ---
export { decodeMVT } from './mvt-decoder.ts';
export type { MVTTile, MVTLayer, MVTFeature, MVTGeometryType } from './mvt-decoder.ts';
