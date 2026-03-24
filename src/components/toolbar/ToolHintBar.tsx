import { useMemo, type ReactElement } from 'react';
import type { ToolType } from '@/types';
import { useMapStore } from '@/stores/mapStore';

/**
 * Map of active tools to localized hint strings (centered overlay above the map).
 */
const HINT_BY_TOOL: Partial<Record<ToolType, string>> = {
    'draw-point': '✏️ 点标注 │ 单击放置标注点 · Esc 取消',
    'draw-line': '✏️ 折线绘制 │ 单击放置顶点 · 双击完成 · Esc 取消 · Ctrl+Z 撤销',
    'draw-polygon': '✏️ 多边形绘制 │ 单击放置顶点 · 双击完成 · Esc 取消 · Ctrl+Z 撤销',
    'draw-rect': '✏️ 矩形绘制 │ 按住拖拽绘制 · Esc 取消',
    'draw-circle': '✏️ 圆形绘制 │ 按住拖拽绘制 · Esc 取消',
    'draw-freehand': '✏️ 自由线 │ 按住鼠标拖拽 · 释放完成',
    'measure-distance': '📏 距离测量 │ 单击放置点 · 双击完成',
    'measure-area': '📏 面积测量 │ 单击放置顶点 · 双击完成',
    'measure-profile': '📏 高程剖面 │ 单击放置点 · 双击完成',
    'select-click': '👆 单击选择 │ 点击要素选中',
    'select-box': '👆 框选 │ 按住拖拽框选区域',
    'select-lasso': '👆 套索选择 │ 按住拖拽绘制选区',
};

/**
 * Floating hint strip shown when a non-pan tool is active (keyboard shortcuts described inline).
 *
 * @returns Absolute-positioned hint or null when panning.
 */
export function ToolHintBar(): ReactElement | null {
    const activeTool = useMapStore((s) => s.activeTool);

    const text = useMemo(() => HINT_BY_TOOL[activeTool], [activeTool]);

    if (activeTool === 'pan' || !text) {
        return null;
    }

    return (
        <div
            className="absolute top-4 left-1/2 z-20 -translate-x-1/2 bg-[var(--tool-hint-bg)] text-white text-sm px-4 py-2 rounded-lg shadow-lg pointer-events-none"
            role="status"
            aria-live="polite"
        >
            {text}
        </div>
    );
}
