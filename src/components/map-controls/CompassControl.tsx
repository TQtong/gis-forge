import type { ReactElement } from 'react';
import { Compass } from 'lucide-react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';

/**
 * Compass control: rotates with map bearing and resets north on click.
 *
 * @returns Circular button under zoom controls.
 */
export function CompassControl(): ReactElement {
    const bearing = useStatusStore((s) => s.bearing);
    const setBearing = useMapStore((s) => s.setBearing);

    const deg = (-bearing * 180) / Math.PI;

    return (
        <button
            type="button"
            title="指北针 — 点击复位"
            aria-label="指北针，点击将地图旋转复位到正北"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-panel)]/80 text-[var(--text-primary)] backdrop-blur transition-colors hover:bg-[var(--bg-panel-hover)]"
            style={{ transform: `rotate(${deg}deg)` }}
            onClick={() => setBearing(0)}
        >
            <Compass className="size-4" strokeWidth={2} aria-hidden />
        </button>
    );
}
