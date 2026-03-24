// ============================================================
// source-wmts/index.ts — WMTS 数据源包公共入口
// 职责：统一导出包内所有公共类型和类。
// ============================================================

import type { WMTSSourceOptions } from './WMTSSource.ts';
import { WMTSSource } from './WMTSSource.ts';

export { WMTSSource };

/**
 * 工厂函数：创建 WMTS 数据源（与 `new WMTSSource(options)` 等价）。
 *
 * @param options - WMTS 配置
 * @returns WMTSSource 实例
 */
export function createWMTSSource(options: WMTSSourceOptions): WMTSSource {
    return new WMTSSource(options);
}

export type {
    WMTSSourceOptions,
    WMTSRequestMode,
    WMTSCapabilities,
    WMTSLayerDescriptor,
    WMTSResourceUrl,
    TileMatrixDescriptor,
    TileMatrixSetDescriptor,
    WMTSTileLoadParams,
    WMTSTileLoadResult,
    WMTSSourceMetadata,
} from './WMTSSource.ts';
