// ============================================================
// layer-marker/index.ts — 标记图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createMarkerLayer } from './MarkerLayer.ts';
export type {
  MarkerLayer,
  MarkerLayerOptions,
  MarkerSpec,
  MarkerClickCallback,
  MarkerDragEndCallback,
  MarkerEnterCallback,
  MarkerLeaveCallback,
} from './MarkerLayer.ts';
