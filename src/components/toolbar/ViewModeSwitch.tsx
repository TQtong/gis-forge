import { useState, type ReactElement } from 'react';

/** Toolbar view mode keys (2.5D uses decimal label in UI). */
export type MapViewMode = '2d' | '2.5d' | 'globe';

const MODE_ORDER: MapViewMode[] = ['2d', '2.5d', 'globe'];

/**
 * @param mode - Internal map mode key.
 * @returns Short label for the segmented control.
 */
function modeLabel(mode: MapViewMode): string {
    if (mode === '2.5d') return '2.5D';
    if (mode === 'globe') return 'Globe';
    return '2D';
}

/**
 * Segmented control: 2D / 2.5D / Globe。当前无全局 store，仅用本地 state（后续可接入 Map2D / mapStore）。
 *
 * @returns Toolbar view mode switcher.
 */
export function ViewModeSwitch(): ReactElement {
    const [mode, setMode] = useState<MapViewMode>('2d');

    return (
        <div
            className="hidden sm:flex items-center rounded-lg bg-[var(--bg-input)] p-0.5"
            role="group"
            aria-label="视图模式"
        >
            {MODE_ORDER.map((m) => {
                const active = mode === m;
                return (
                    <button
                        key={m}
                        type="button"
                        onClick={() => {
                            setMode(m);
                        }}
                        aria-pressed={active}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                            active
                                ? 'bg-[var(--accent)] text-white'
                                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        {modeLabel(m)}
                    </button>
                );
            })}
        </div>
    );
}
