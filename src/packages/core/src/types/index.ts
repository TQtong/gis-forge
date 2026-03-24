// ============================================================
// types/index.ts — L0 共享类型桶文件（Barrel Export）
// 重新导出所有子模块的类型定义，上层通过以下方式导入：
//   import type { Feature, Viewport, ... } from '@geoforge/core/types/index.ts';
// 或通过包级别入口：
//   import type { Feature, Viewport, ... } from '@geoforge/core';
//
// 使用 `export type *` 语法以满足 TypeScript verbatimModuleSyntax 要求。
// ============================================================

// --- 数学 TypedArray 类型别名 ---
export type {
  Vec2f,
  Vec3f,
  Vec4f,
  Mat3f,
  Mat4f,
  Quatf,
  Vec2d,
  Vec3d,
  Vec4d,
  Mat4d,
} from './math-types.ts';

// --- GeoJSON 几何类型 ---
export type {
  GeometryType,
  Position,
  LinearRing,
  PointGeometry,
  MultiPointGeometry,
  LineStringGeometry,
  MultiLineStringGeometry,
  PolygonGeometry,
  MultiPolygonGeometry,
  GeometryCollectionGeometry,
  Geometry,
} from './geometry.ts';

// --- 瓦片相关类型 ---
export type {
  BBox2D,
  TileCoord,
  TileParams,
  TileData,
  TileState,
} from './tile.ts';

// --- Feature 与 FeatureCollection ---
export type {
  Feature,
  FeatureCollection,
} from './feature.ts';

// --- 视口、相机状态、拾取结果 ---
export type {
  Viewport,
  CameraState,
  PickResult,
} from './viewport.ts';

// --- 样式规范 ---
export type {
  StyleSpec,
  SourceSpec,
  LayerStyleSpec,
  LightSpec,
  StyleExpression,
  InterpolationType,
  FilterExpression,
} from './style-spec.ts';

// --- 事件与动画 ---
export type {
  MapEventType,
  MapPointerEvent,
  FlyToOptions,
  AnimationOptions,
  LogLevel,
} from './events.ts';
