// ============================================================
// math/index.ts — 数学模块统一入口
// 使用命名空间 re-export，支持 tree-shaking
// 用法：import { vec3, mat4, bbox } from '@geoforge/core/math';
// ============================================================

export * as vec2 from './vec2.ts';
export * as vec2d from './vec2d.ts';
export * as vec3 from './vec3.ts';
export * as vec3d from './vec3d.ts';
export * as vec4 from './vec4.ts';
export * as vec4d from './vec4d.ts';
export * as mat3 from './mat3.ts';
export * as mat4 from './mat4.ts';
export * as mat4d from './mat4d.ts';
export * as quat from './quat.ts';
export * as bbox from './bbox.ts';
export * as frustum from './frustum.ts';
export * as interpolate from './interpolate.ts';
export * as trigonometry from './trigonometry.ts';
