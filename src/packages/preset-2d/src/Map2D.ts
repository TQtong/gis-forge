// ============================================================
// @geoforge/preset-2d — Map2D PascalCase 别名模块
// 从 kebab-case 源文件 re-export，使两种命名风格均可 import。
// ============================================================

export { Map2D } from './map-2d.ts';
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
} from './map-2d.ts';
export { GeoForgeError, GeoForgeErrorCode } from './map-2d.ts';
