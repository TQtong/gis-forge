// ============================================================
// compat-mobile/index.ts — 移动端兼容包桶文件（Barrel Export）
// 重新导出 MobileOptimizer 及所有相关类型，
// 上层通过 `import { MobileOptimizer, ... } from '@gis-forge/compat-mobile';` 使用。
// ============================================================

import type { MobileOptimizerOptions } from './MobileOptimizer.ts';
import { MobileOptimizer } from './MobileOptimizer.ts';

export { MobileOptimizer };

/**
 * 工厂函数：创建移动端优化器（与 `new MobileOptimizer(options)` 等价）。
 *
 * @param options - 可选配置
 * @returns MobileOptimizer 实例
 */
export function createMobileOptimizer(options?: MobileOptimizerOptions): MobileOptimizer {
    return new MobileOptimizer(options);
}

export type {
    MobileOptimizerOptions,
    DeviceProfile,
    GPUCapabilities,
    EngineOptimizedConfig,
} from './MobileOptimizer.ts';
