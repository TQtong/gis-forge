import { type ReactElement } from 'react';

/** 三种视图模式的 key */
export type MapViewMode = '2d' | '2.5d' | 'globe';

/** 按钮显示顺序 */
const MODE_ORDER: MapViewMode[] = ['2d', '2.5d', 'globe'];

/**
 * @param mode - 内部 map mode key
 * @returns 按钮上显示的短标签
 */
function modeLabel(mode: MapViewMode): string {
    if (mode === '2.5d') { return '2.5D'; }
    if (mode === 'globe') { return 'Globe'; }
    return '2D';
}

export interface ViewModeSwitchProps {
    /** 当前激活的视图模式 */
    mode: MapViewMode;
    /** 用户点击切换时的回调 */
    onModeChange: (next: MapViewMode) => void;
}

/**
 * 分段按钮组：2D / 2.5D / Globe。
 * 受控组件——由父级 `App` 管理 `mode` 状态。
 */
export function ViewModeSwitch({ mode, onModeChange }: ViewModeSwitchProps): ReactElement {
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
                        onClick={() => { onModeChange(m); }}
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
