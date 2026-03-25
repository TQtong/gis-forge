import * as React from 'react';

type TabId = 'attributes' | 'style' | 'legend';

const tabs: { id: TabId; label: string }[] = [
    { id: 'attributes', label: '属性' },
    { id: 'style', label: '样式' },
    { id: 'legend', label: '图例' },
];

function emptyMessage(tab: TabId): string {
    switch (tab) {
        case 'attributes':
            return '未选择要素。地图支持拖拽平移、滚轮缩放。';
        case 'style':
            return '样式编辑器将在此显示。';
        case 'legend':
            return '图例将在此显示。';
        default:
            return '';
    }
}

/**
 * 右侧属性 / 样式 / 图例（本地 tab 状态，无全局 store 依赖）。
 */
export function RightPanel(): React.ReactElement {
    const [tab, setTab] = React.useState<TabId>('attributes');

    return (
        <aside
            className="flex h-full flex-col overflow-y-auto bg-[var(--bg-panel)]"
            aria-label="属性与样式"
        >
            <nav
                className="flex shrink-0 border-b border-[var(--border)] px-1"
                role="tablist"
                aria-label="右侧面板"
            >
                {tabs.map(({ id, label }) => {
                    const active = tab === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setTab(id)}
                            className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium transition-colors ${
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
                className="flex min-h-0 flex-1 flex-col px-3 py-6 text-center text-sm leading-relaxed text-[var(--text-secondary)]"
                role="tabpanel"
            >
                <p className="mx-auto max-w-[220px]">{emptyMessage(tab)}</p>
            </div>
        </aside>
    );
}
