// ============================================================
// packages/camera-25d/src/index.ts
// 公共入口 — 仅导出消费者需要的工厂函数和类型。
// 内部实现类 Camera25DImpl 不导出，强制通过工厂函数使用。
// ============================================================

export { createCamera25D } from './Camera25D.ts';
export type { Camera25D, Camera25DOptions } from './Camera25D.ts';
