import { Columns2, History, Map, Settings } from 'lucide-react';
import * as React from 'react';
import { AnalysisMenu } from '@/components/toolbar/AnalysisMenu';
import { ExportMenu } from '@/components/toolbar/ExportMenu';
import { SearchBox } from '@/components/toolbar/SearchBox';
import { ToolGroup } from '@/components/toolbar/ToolGroup';
import { ViewModeSwitch } from '@/components/toolbar/ViewModeSwitch';
import type { MapViewMode } from '@/components/toolbar/ViewModeSwitch';

export interface TopToolbarProps {
    /** 当前激活的视图模式 */
    viewMode: MapViewMode;
    /** 用户点击模式切换按钮时触发 */
    onViewModeChange: (next: MapViewMode) => void;
}

/**
 * 顶栏：品牌、视图模式、搜索、工具与导出。交互状态用本地 React state（不接 store）。
 */
export function TopToolbar({ viewMode, onViewModeChange }: TopToolbarProps): React.ReactElement {
    const [historyPanelOpen, setHistoryPanelOpen] = React.useState(false);
    const [splitViewEnabled, setSplitViewEnabled] = React.useState(false);
    const [settingsOpen, setSettingsOpen] = React.useState(false);

    return (
        <>
            <header
                className="h-12 flex items-center px-3 gap-2 bg-[var(--bg-panel)] border-b border-[var(--border)] shrink-0"
                role="banner"
            >
                <div className="flex min-w-0 shrink-0 items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Map aria-hidden className="text-[var(--accent)]" strokeWidth={2} size={20} />
                        <span className="whitespace-nowrap text-base font-semibold text-[var(--text-primary)]">
                            GIS-Forge
                        </span>
                    </div>
                    <ViewModeSwitch mode={viewMode} onModeChange={onViewModeChange} />
                </div>

                <div className="flex min-w-0 flex-1 justify-center px-2">
                    <SearchBox />
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    <ToolGroup />
                    <AnalysisMenu />
                    <button
                        type="button"
                        title="操作历史"
                        aria-label="操作历史"
                        aria-pressed={historyPanelOpen}
                        onClick={() => setHistoryPanelOpen(!historyPanelOpen)}
                        className={`rounded-md p-2 transition-colors ${
                            historyPanelOpen
                                ? 'bg-[var(--accent)] text-white'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        <History className="size-5" strokeWidth={2} />
                    </button>
                    <button
                        type="button"
                        title="分屏对比"
                        aria-label="分屏对比"
                        aria-pressed={splitViewEnabled}
                        onClick={() => setSplitViewEnabled(!splitViewEnabled)}
                        className={`rounded-md p-2 transition-colors ${
                            splitViewEnabled
                                ? 'bg-[var(--accent)] text-white'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        <Columns2 className="size-5" strokeWidth={2} />
                    </button>
                    <button
                        type="button"
                        title="设置"
                        aria-label="设置"
                        onClick={() => setSettingsOpen(true)}
                        className="rounded-md p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
                    >
                        <Settings className="size-5" strokeWidth={2} />
                    </button>
                    <ExportMenu />
                </div>
            </header>

            {settingsOpen ? (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="settings-dialog-title"
                    onClick={() => setSettingsOpen(false)}
                >
                    <div
                        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-4 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 id="settings-dialog-title" className="text-lg font-semibold text-[var(--text-primary)]">
                            设置
                        </h2>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">占位：尚未接入全局设置与持久化。</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white"
                                onClick={() => setSettingsOpen(false)}
                            >
                                关闭
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
