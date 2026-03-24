// ============================================================
// @geoforge/preset-2d — 包公共入口（桶导出）
// 聚合 Map2D 核心类、所有类型、控件工厂函数与初始化编排器。
// ============================================================

// --- Map2D 核心 ---
export { Map2D, GeoForgeError, GeoForgeErrorCode } from './map-2d.ts';
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

// --- 原有 class 风格控件（向后兼容） ---
export {
    NavigationControl as NavigationControlClass,
    ScaleControl as ScaleControlClass,
    AttributionControl as AttributionControlClass,
    GeolocateControl as GeolocateControlClass,
    FullscreenControl as FullscreenControlClass,
} from './controls.ts';

// --- 工厂风格控件（推荐） ---
export {
    createNavigationControl,
    createScaleControl,
    createAttributionControl,
    createGeolocateControl,
    createFullscreenControl,
} from './controls/index.ts';
export type {
    NavigationControl as NavigationControlFactory,
    NavigationControlOptions,
} from './controls/NavigationControl.ts';
export type {
    ScaleControl as ScaleControlFactory,
    ScaleControlOptions,
    ScaleUnit,
} from './controls/ScaleControl.ts';
export type {
    AttributionControl as AttributionControlFactory,
    AttributionControlOptions,
} from './controls/AttributionControl.ts';
export type {
    GeolocateControl as GeolocateControlFactory,
    GeolocateControlOptions,
} from './controls/GeolocateControl.ts';
export type {
    FullscreenControl as FullscreenControlFactory,
    FullscreenControlOptions,
} from './controls/FullscreenControl.ts';

// --- 引擎初始化编排 ---
export { initializeEngine } from './init.ts';
export type { EngineConfig, EngineContext, L0Handle, L1Handle, L2Handle, L3Handle, L4Handle, L5Handle } from './init.ts';
