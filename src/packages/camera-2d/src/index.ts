// ============================================================
// packages/camera-2d/src/index.ts
// 公共入口 — 仅导出消费者需要的工厂函数和类型。
// 内部实现类 Camera2DImpl 不导出，强制通过工厂函数使用。
// ============================================================

export { createCamera2D } from './Camera2D.ts';
export type { Camera2D, Camera2DOptions } from './Camera2D.ts';
