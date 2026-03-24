import type { ReactElement } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useMapStore } from '@/stores/mapStore';

/**
 * Vertical +/- zoom buttons bound to `mapStore.adjustZoom` with clamped zoom range.
 *
 * @returns Stacked control on the map edge.
 */
export function ZoomControl(): ReactElement {
    const adjustZoom = useMapStore((s) => s.adjustZoom);

    return (
        <div
            className="flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)]/80 backdrop-blur"
            role="group"
            aria-label="缩放"
        >
            <button
                type="button"
                title="放大"
                aria-label="放大"
                className="flex h-8 w-8 items-center justify-center text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-panel-hover)]"
                onClick={() => adjustZoom(1)}
            >
                <Plus className="size-4" strokeWidth={2} aria-hidden />
            </button>
            <div className="h-px w-full bg-[var(--border)]" aria-hidden />
            <button
                type="button"
                title="缩小"
                aria-label="缩小"
                className="flex h-8 w-8 items-center justify-center text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-panel-hover)]"
                onClick={() => adjustZoom(-1)}
            >
                <Minus className="size-4" strokeWidth={2} aria-hidden />
            </button>
        </div>
    );
}
