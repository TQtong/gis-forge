import { useMemo, type ReactElement } from 'react';
import { formatCoordinatesByMode, formatZoom } from '@/utils/formatters';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';
import { useUIStore } from '@/stores/uiStore';

/**
 * Bottom-left map readout: cursor coordinates (by UI format) and current zoom.
 *
 * @returns Semi-transparent HUD label.
 */
export function CoordinateDisplay(): ReactElement {
    const mouseCoord = useStatusStore((s) => s.mouseCoord);
    const coordinateFormat = useUIStore((s) => s.coordinateFormat);
    const zoom = useMapStore((s) => s.zoom);

    const line = useMemo(() => {
        if (mouseCoord === null) {
            return '--°E, --°N';
        }
        return formatCoordinatesByMode(mouseCoord[0], mouseCoord[1], coordinateFormat);
    }, [coordinateFormat, mouseCoord]);

    return (
        <div
            className="pointer-events-none rounded-md bg-[var(--bg-panel)]/80 px-2 py-1 font-mono text-xs text-[var(--text-secondary)] backdrop-blur border border-[var(--border)]"
            role="status"
            aria-live="polite"
        >
            <span>{line}</span>
            <span className="mx-1.5 text-[var(--text-muted)]">|</span>
            <span>{formatZoom(zoom)}</span>
        </div>
    );
}
