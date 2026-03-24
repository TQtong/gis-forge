// ============================================================
// compat-hidpi/index.ts — 高 DPI 适配包桶文件（Barrel Export）
// 重新导出 HiDPIAdapter 及所有相关类型，
// 上层通过 `import { HiDPIAdapter, ... } from '@geoforge/compat-hidpi';` 使用。
// ============================================================

import type { HiDPIAdapterOptions } from './HiDPIAdapter.ts';
import { HiDPIAdapter } from './HiDPIAdapter.ts';

export { HiDPIAdapter };

/**
 * 工厂函数：创建 HiDPI 适配器（与 `new HiDPIAdapter(options)` 等价）。
 *
 * @param options - 可选配置
 * @returns HiDPIAdapter 实例
 */
export function createHiDPIAdapter(options?: HiDPIAdapterOptions): HiDPIAdapter {
    return new HiDPIAdapter(options);
}

export type {
    HiDPIAdapterOptions,
    DynamicResolutionResult,
} from './HiDPIAdapter.ts';
