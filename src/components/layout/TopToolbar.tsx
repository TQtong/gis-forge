import { Columns2, History, Map, Settings } from 'lucide-react';
import { AnalysisMenu } from '@/components/toolbar/AnalysisMenu';
import { ExportMenu } from '@/components/toolbar/ExportMenu';
import { SearchBox } from '@/components/toolbar/SearchBox';
import { ToolGroup } from '@/components/toolbar/ToolGroup';
import { ViewModeSwitch } from '@/components/toolbar/ViewModeSwitch';
import { useUIStore } from '@/stores/uiStore';

/**
 * Top application toolbar: branding, view mode, search, tools, settings, export.
 */
export function TopToolbar() {
    const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
    const historyPanelOpen = useUIStore((s) => s.historyPanelOpen);
    const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
    const splitViewEnabled = useUIStore((s) => s.splitViewEnabled);
    const setSplitViewEnabled = useUIStore((s) => s.setSplitViewEnabled);

    return (
        <header
            className="h-12 flex items-center px-3 gap-2 bg-[var(--bg-panel)] border-b border-[var(--border)] shrink-0"
            role="banner"
        >
            <div className="flex items-center gap-3 min-w-0 shrink-0">
                <div className="flex items-center gap-2">
                    <Map aria-hidden className="text-[var(--accent)]" strokeWidth={2} size={20} />
                    <span className="text-base font-semibold text-[var(--text-primary)] whitespace-nowrap">
                        GeoForge
                    </span>
                </div>
                <ViewModeSwitch />
            </div>

            <div className="flex-1 flex justify-center px-2 min-w-0">
                <SearchBox />
            </div>

            <div className="flex items-center gap-1 shrink-0">
                <ToolGroup />
                <AnalysisMenu />
                <button
                    type="button"
                    title="操作历史"
                    aria-label="操作历史"
                    aria-pressed={historyPanelOpen}
                    onClick={() => setHistoryPanelOpen(!historyPanelOpen)}
                    className={`p-2 rounded-md transition-colors ${
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
                    className={`p-2 rounded-md transition-colors ${
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
                    className="p-2 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <Settings className="size-5" strokeWidth={2} />
                </button>
                <ExportMenu />
            </div>
        </header>
    );
}
