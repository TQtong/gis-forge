// ============================================================
// source-pmtiles/index.ts — PMTiles 数据源包公共入口
// 职责：统一导出包内所有公共类型和类。
// ============================================================

import type { PMTilesSourceOptions } from './PMTilesSource.ts';
import { PMTilesSource } from './PMTilesSource.ts';

export { PMTilesSource };

/**
 * 工厂函数：创建 PMTiles 数据源（与 `new PMTilesSource(options)` 等价）。
 *
 * @param options - PMTiles 配置
 * @returns PMTilesSource 实例
 */
export function createPMTilesSource(options: PMTilesSourceOptions): PMTilesSource {
    return new PMTilesSource(options);
}

export {
    PMTilesTileType,
    PMTilesCompression,
} from './PMTilesSource.ts';
export type {
    PMTilesSourceOptions,
    PMTilesHeader,
    PMTilesDirectoryEntry,
    PMTilesTileLoadParams,
    PMTilesTileLoadResult,
    PMTilesSourceMetadata,
    PMTilesTileTypeValue,
    PMTilesCompressionValue,
    PMTilesUserTileType,
} from './PMTilesSource.ts';
