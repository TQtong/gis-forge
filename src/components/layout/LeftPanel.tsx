import { Layers } from 'lucide-react';
import * as React from 'react';

/**
 * 左侧 dock：图层列表等（当前为静态占位，后续可接 LayerList）。
 */
export function LeftPanel(): React.ReactElement {
    return (
        <aside
            className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-panel)]"
            aria-label="图层面板"
        >
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-2">
                <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <Layers className="size-4 text-[var(--accent)]" aria-hidden />
                    图层
                </span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                <div className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-2 text-xs text-[var(--text-secondary)]">
                    底图 · 示例
                </div>
                <div className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-2 text-xs text-[var(--text-secondary)]">
                    矢量 · 示例
                </div>
            </div>
            <div className="shrink-0 border-t border-[var(--border)] p-2 text-xs text-[var(--text-muted)]">
                地形 / 书签 / 标注（静态占位）
            </div>
        </aside>
    );
}
