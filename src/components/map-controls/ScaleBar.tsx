import { useMemo, type ReactElement } from 'react';
import { calculateScaleBar } from '@/utils/scaleBar';
import { useMapStore } from '@/stores/mapStore';

const TICK_HEIGHT_PX = 4;

/**
 * Horizontal scale bar with ticks and a distance label (Web Mercator ground distance).
 *
 * @returns Bottom-right overlay; width follows {@link calculateScaleBar}.
 */
export function ScaleBar(): ReactElement {
    const zoom = useMapStore((s) => s.zoom);
    const lat = useMapStore((s) => s.center[1]);

    const { label, widthPx } = useMemo(() => calculateScaleBar(zoom, lat), [zoom, lat]);

    if (widthPx <= 0 || !label) {
        return (
            <div
                className="pointer-events-none flex flex-col items-end gap-0.5 text-[10px] text-[var(--text-secondary)]"
                role="status"
                aria-label="比例尺不可用"
            >
                <span>—</span>
            </div>
        );
    }

    return (
        <div
            className="pointer-events-none flex flex-col items-end gap-0.5 text-[10px] text-[var(--text-secondary)]"
            role="status"
            aria-label={`比例尺约 ${label}`}
        >
            <span className="font-medium tabular-nums">{label}</span>
            <div
                className="relative border-b-2 border-[var(--text-secondary)]"
                style={{ width: widthPx, height: TICK_HEIGHT_PX }}
            >
                <span
                    className="absolute left-0 top-0 w-px bg-[var(--text-secondary)]"
                    style={{ height: TICK_HEIGHT_PX }}
                    aria-hidden
                />
                <span
                    className="absolute right-0 top-0 w-px bg-[var(--text-secondary)]"
                    style={{ height: TICK_HEIGHT_PX }}
                    aria-hidden
                />
                <span
                    className="absolute left-1/2 top-0 w-px bg-[var(--text-secondary)]"
                    style={{ height: TICK_HEIGHT_PX / 2 }}
                    aria-hidden
                />
            </div>
        </div>
    );
}
