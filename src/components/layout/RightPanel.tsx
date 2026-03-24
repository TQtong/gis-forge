import { LegendTab } from '@/components/legend/LegendTab';
import { StyleTab } from '@/components/style/StyleTab';
import { useUIStore, type RightPanelTab } from '@/stores/uiStore';
import { PropertyTab } from '@/components/properties/PropertyTab';

const tabs: { id: RightPanelTab; label: string }[] = [
    { id: 'attributes', label: '📋 属性' },
    { id: 'style', label: '🎨 样式' },
    { id: 'legend', label: '🗺️ 图例' },
];

function emptyMessage(tab: RightPanelTab): string {
    switch (tab) {
        case 'attributes':
            return '未选择要素。在地图上选择要素后，属性将显示于此。';
        case 'style':
            return '样式编辑器将在此显示。';
        case 'legend':
            return '图例将在此显示。';
        default:
            return '内容将在此显示。';
    }
}

/**
 * Right inspector: fixed tabs (属性 / 样式 / 图例) and tab content placeholder.
 */
export function RightPanel() {
    const rightPanelTab = useUIStore((s) => s.rightPanelTab);
    const setRightPanelTab = useUIStore((s) => s.setRightPanelTab);

    return (
        <aside className="h-full flex flex-col bg-[var(--bg-panel)] overflow-y-auto" aria-label="属性与样式">
            <nav
                className="flex shrink-0 border-b border-[var(--border)] px-1"
                role="tablist"
                aria-label="右侧面板"
            >
                {tabs.map(({ id, label }) => {
                    const active = rightPanelTab === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            id={`right-tab-${id}`}
                            onClick={() => setRightPanelTab(id)}
                            className={`flex-1 px-2 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                                active
                                    ? 'border-[var(--accent)] text-[var(--accent)]'
                                    : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                            }`}
                        >
                            {label}
                        </button>
                    );
                })}
            </nav>
            <div
                className="flex-1 flex flex-col min-h-0 px-3 py-3 text-sm text-[var(--text-secondary)]"
                role="tabpanel"
                aria-labelledby={`right-tab-${rightPanelTab}`}
            >
                {rightPanelTab === 'attributes' ? (
                    <PropertyTab />
                ) : rightPanelTab === 'style' ? (
                    <StyleTab />
                ) : rightPanelTab === 'legend' ? (
                    <LegendTab />
                ) : (
                    <div className="flex flex-1 flex-col items-center justify-center text-center px-2">
                        <p className="max-w-[220px] leading-relaxed">{emptyMessage(rightPanelTab)}</p>
                    </div>
                )}
            </div>
        </aside>
    );
}
