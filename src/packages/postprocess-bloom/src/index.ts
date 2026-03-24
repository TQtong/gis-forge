// ============================================================
// postprocess-bloom/src/index.ts — 泛光（Bloom）后处理包入口
// 统一导出 BloomPass 类和选项类型。
// ============================================================

export { BloomPass } from './BloomPass.ts';
export type { BloomPassOptions } from './BloomPass.ts';

import { BloomPass } from './BloomPass.ts';
import type { BloomPassOptions } from './BloomPass.ts';

/**
 * 创建 {@link BloomPass} 实例（工厂别名）。
 *
 * @param options - 泛光参数，全部可选
 * @returns 新的 BloomPass 实例
 */
export function createBloomPass(options?: BloomPassOptions): BloomPass {
    return new BloomPass(options);
}
