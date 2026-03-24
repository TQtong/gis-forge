// ============================================================
// postprocess-shadow/src/index.ts — 阴影后处理包入口
// 统一导出 ShadowPass 类和选项类型。
// ============================================================

export { ShadowPass } from './ShadowPass.ts';
export type { ShadowPassOptions } from './ShadowPass.ts';

import { ShadowPass } from './ShadowPass.ts';
import type { ShadowPassOptions } from './ShadowPass.ts';

/**
 * 创建 {@link ShadowPass} 实例（工厂别名）。
 *
 * @param options - 屏幕空间阴影参数，全部可选
 * @returns 新的 ShadowPass 实例
 */
export function createShadowPass(options?: ShadowPassOptions): ShadowPass {
    return new ShadowPass(options);
}
