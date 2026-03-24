// ============================================================
// interaction-select/src/index.ts — 选择工具包公共 API 入口
// 导出所有公共类型和 SelectTool 类，支持 Tree-Shaking。
// ============================================================

export { SelectTool, pointInPolygon } from './SelectTool.ts';

export type {
    SelectMode,
    SelectToolOptions,
    SelectEventType,
    SelectEvent,
    HighlightStyle,
} from './SelectTool.ts';

import { SelectTool } from './SelectTool.ts';
import type { SelectToolOptions } from './SelectTool.ts';

/**
 * 创建 {@link SelectTool} 实例（工厂别名）。
 *
 * @param options - 选择工具配置，全部可选
 * @returns 新的 SelectTool 实例
 */
export function createSelectTool(options?: SelectToolOptions): SelectTool {
    return new SelectTool(options);
}
