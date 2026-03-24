// ============================================================
// layer-3dtiles/index.ts — 3D Tiles 图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createTiles3DLayer } from './Tiles3DLayer.ts';
export type { Tiles3DLayer, Tiles3DLayerOptions, Tiles3DStyle } from './Tiles3DLayer.ts';

// --- 3D Tiles BVH 遍历器 ---
export { traverseTileset } from './tileset-traversal.ts';
export type { TileNode, BoundingVolume, TraversalCamera, VisibleTile } from './tileset-traversal.ts';

// --- glTF / glb 解析器 ---
export { parseGLTF } from './gltf-parser.ts';
export type { GLTFData, GLTFMesh, GLTFPrimitive, GLTFMaterial, GLTFTexture, GLTFImage, GLTFNode } from './gltf-parser.ts';
