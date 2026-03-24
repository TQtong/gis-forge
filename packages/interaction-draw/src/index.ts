// ============================================================
// interaction-draw/src/index.ts — 绘制工具包公共 API 入口
// 导出所有公共类型和 DrawTool 类，支持 Tree-Shaking。
// ============================================================

export { DrawTool } from './DrawTool.ts';

export type {
    DrawMode,
    DrawToolOptions,
    DrawEventType,
    DrawEvent,
    LineStyle,
    FillStyle,
} from './DrawTool.ts';

import { DrawTool } from './DrawTool.ts';
import type { DrawToolOptions } from './DrawTool.ts';

/**
 * 创建 {@link DrawTool} 实例（工厂别名，便于与文档中的 `createDrawTool` 命名一致）。
 *
 * @param options - 绘制工具配置，全部可选
 * @returns 新的 DrawTool 实例
 */
export function createDrawTool(options?: DrawToolOptions): DrawTool {
    return new DrawTool(options);
}
