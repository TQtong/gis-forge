// ============================================================
// postprocess-ssao/src/index.ts — SSAO 后处理包入口
// 统一导出 SSAOPass 类和选项类型。
// ============================================================

export { SSAOPass } from './SSAOPass.ts';
export type { SSAOPassOptions } from './SSAOPass.ts';

import { SSAOPass } from './SSAOPass.ts';
import type { SSAOPassOptions } from './SSAOPass.ts';

/**
 * 创建 {@link SSAOPass} 实例（工厂别名）。
 *
 * @param options - SSAO 参数，全部可选
 * @returns 新的 SSAOPass 实例
 */
export function createSSAOPass(options?: SSAOPassOptions): SSAOPass {
    return new SSAOPass(options);
}
