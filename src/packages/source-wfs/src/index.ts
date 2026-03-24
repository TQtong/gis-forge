// ============================================================
// source-wfs/index.ts — WFS 数据源包公共入口
// 职责：统一导出包内所有公共类型和类。
// ============================================================

import type { WFSSourceOptions } from './WFSSource.ts';
import { WFSSource } from './WFSSource.ts';

export { WFSSource };

/**
 * 工厂函数：创建 WFS 数据源（与 `new WFSSource(options)` 等价）。
 *
 * @param options - WFS 配置
 * @returns WFSSource 实例
 */
export function createWFSSource(options: WFSSourceOptions): WFSSource {
    return new WFSSource(options);
}

export type {
    WFSSourceOptions,
    WFSVersion,
    WFSStrategy,
    WFSFeatureTypeDescription,
    WFSPropertyDescriptor,
    WFSSourceMetadata,
} from './WFSSource.ts';
