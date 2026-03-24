// ============================================================
// source-wms/index.ts — WMS 数据源包公共入口
// 职责：统一导出包内所有公共类型和类。
// ============================================================

import type { WMSSourceOptions } from './WMSSource.ts';
import { WMSSource } from './WMSSource.ts';

export { WMSSource };

/**
 * 工厂函数：创建 WMS 数据源（与 `new WMSSource(options)` 等价）。
 *
 * @param options - WMS 配置
 * @returns WMSSource 实例
 */
export function createWMSSource(options: WMSSourceOptions): WMSSource {
    return new WMSSource(options);
}

export type {
    WMSSourceOptions,
    WMSVersion,
    WMSTileLoadParams,
    WMSTileLoadResult,
    WMSFeatureInfoResult,
    WMSCapabilities,
    WMSLayerDescriptor,
    WMSSourceMetadata,
} from './WMSSource.ts';
