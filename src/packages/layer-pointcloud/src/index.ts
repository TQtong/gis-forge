// ============================================================
// layer-pointcloud/index.ts — 点云图层包公共入口
// 职责：统一导出包内所有公共类型和工厂函数。
// ============================================================

export { createPointCloudLayer } from './PointCloudLayer.ts';
export type {
  PointCloudLayer,
  PointCloudLayerOptions,
  PointCloudColorMode,
  PointCloudSizeAttenuation,
  PointCloudShape,
} from './PointCloudLayer.ts';
