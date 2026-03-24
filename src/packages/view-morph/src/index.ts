// ============================================================
// view-morph/src/index.ts — 包入口（barrel export）
// 层级：L3（运行时调度 / 相机控制）
// 仅导出公共 API，内部实现细节不暴露。
// ============================================================

export { createViewMorph } from './ViewMorph.ts';

export type {
  ViewMorph,
  ViewMorphState,
  ViewMorphOptions,
  ViewMorphAnimation,
  ViewMode,
} from './ViewMorph.ts';
