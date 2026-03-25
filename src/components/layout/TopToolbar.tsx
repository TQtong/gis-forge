import { Map } from 'lucide-react';
import * as React from 'react';

/**
 * 顶栏：品牌与视图模式占位（不依赖外部 toolbar 包）。
 */
export function TopToolbar(): React.ReactElement {
    return (
        <header
            className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-panel)] px-3"
            role="banner"
        >
            <div className="flex min-w-0 shrink-0 items-center gap-3">
                <div className="flex items-center gap-2">
                    <Map aria-hidden className="text-[var(--accent)]" strokeWidth={2} size={20} />
                    <span className="whitespace-nowrap text-base font-semibold text-[var(--text-primary)]">
                        GeoForge
                    </span>
                </div>
                <div
                    className="flex rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-0.5 text-xs"
                    role="group"
                    aria-label="视图模式（静态）"
                >
                    <span className="rounded bg-[var(--accent)] px-2 py-1 text-white">2D</span>
                    <span className="rounded px-2 py-1 text-[var(--text-secondary)]">2.5D</span>
                    <span className="rounded px-2 py-1 text-[var(--text-secondary)]">3D</span>
                </div>
            </div>
            <div className="min-w-0 flex-1 px-2 text-center text-sm text-[var(--text-muted)] truncate">
                搜索与工具条（可后续接入）
            </div>
        </header>
    );
}
