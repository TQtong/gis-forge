/**
 * @module preset-3d/Globe3D
 * @description
 * **PascalCase 别名入口**：与 `./globe-3d.ts` 导出相同符号，便于偏好大写文件名的项目风格 `import`。
 *
 * @see ./globe-3d.ts — 实现与类型定义所在文件
 */

// ============================================================
// @geoforge/preset-3d — Globe3D PascalCase 别名模块
// 从 kebab-case 源文件 re-export，使两种命名风格均可 import。
// ============================================================

export {
    Globe3D,
    computeLogDepthBufFC,
    LOG_DEPTH_WGSL,
} from './globe-3d.ts';

export type {
    Globe3DOptions,
    EntitySpec,
    GlobeRendererStats,
} from './globe-3d.ts';
