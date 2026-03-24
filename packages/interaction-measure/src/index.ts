// ============================================================
// interaction-measure/src/index.ts — 测量工具包公共 API 入口
// 导出所有公共类型和 MeasureTool 类，支持 Tree-Shaking。
// ============================================================

export { MeasureTool } from './MeasureTool.ts';

export type {
    MeasureMode,
    DistanceUnit,
    AreaUnit,
    MeasureToolOptions,
    MeasureResult,
    MeasureEventType,
    MeasureEvent,
    MeasureLineStyle,
    ElevationProfilePoint,
} from './MeasureTool.ts';

import { MeasureTool } from './MeasureTool.ts';
import type { MeasureToolOptions } from './MeasureTool.ts';

/**
 * 创建 {@link MeasureTool} 实例（工厂别名）。
 *
 * @param options - 测量工具配置，全部可选
 * @returns 新的 MeasureTool 实例
 */
export function createMeasureTool(options?: MeasureToolOptions): MeasureTool {
    return new MeasureTool(options);
}
