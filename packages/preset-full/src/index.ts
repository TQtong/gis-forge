// ============================================================
// @geoforge/preset-full — 桶导出（L6 全量预设入口）
// 聚合 Map2D / Map25D / Globe3D / MapFull 与内置 Controls，便于单路径 import。
// ============================================================

export { Map2D, GeoForgeError, GeoForgeErrorCode } from '../../preset-2d/src/map-2d.ts';
export type {
  Map2DOptions,
  FlyToOptions,
  AnimationOptions,
  MapEventType,
  PaddingOptions,
  SourceSpec,
  LayerSpec,
  IControl,
  ControlPosition,
  MapEvent,
  MapMouseEvent,
} from '../../preset-2d/src/map-2d.ts';

export type { Feature, BBox2D, LightSpec } from '@geoforge/core';

export { Map25D, normalizeBearingDeg, clampPitchDeg, mergeLight } from '../../preset-25d/src/map-25d.ts';
export type { Map25DOptions } from '../../preset-25d/src/map-25d.ts';

export { Globe3D } from '../../preset-3d/src/globe-3d.ts';
export type { Globe3DOptions, EntitySpec } from '../../preset-3d/src/globe-3d.ts';

export { MapFull } from './map-full.ts';
export type { MapFullOptions } from './map-full.ts';

export {
  NavigationControl,
  ScaleControl,
  AttributionControl,
  GeolocateControl,
  FullscreenControl,
} from '../../preset-2d/src/controls.ts';
