import type { ReactElement } from 'react';
import type { MeasureResult as MeasureResultType } from '@/types';
import { ElevationProfile } from '@/components/results/ElevationProfile';

/**
 * Props for rendering a completed measurement summary card.
 */
export interface MeasureResultProps {
    /** Finalized measurement payload (distance, area, or profile). */
    result: MeasureResultType;
}

/**
 * Haversine distance between two WGS84 points in meters.
 */
function haversineMeters(a: number[], b: number[]): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1]! - a[1]!);
    const dLon = toRad(b[0]! - a[0]!);
    const lat1 = toRad(a[1]!);
    const lat2 = toRad(b[1]!);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
        sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return R * c;
}

/**
 * Closed-ring perimeter in meters using geodesic segments (last vertex may duplicate first).
 */
function ringPerimeterMeters(ring: number[][]): number {
    if (ring.length < 2) {
        return 0;
    }
    let sum = 0;
    const n = ring.length;
    for (let i = 0; i < n - 1; i++) {
        sum += haversineMeters(ring[i]!, ring[i + 1]!);
    }
    const first = ring[0]!;
    const last = ring[n - 1]!;
    const closed = first[0] === last[0] && first[1] === last[1];
    if (!closed && n >= 2) {
        sum += haversineMeters(ring[n - 1]!, ring[0]!);
    }
    return sum;
}

/**
 * Card UI for distance, area, or elevation profile measurement output.
 *
 * @param props - Measurement result from the measure tool hook.
 * @returns Styled panel with primary value and secondary stats.
 */
export function MeasureResult(props: MeasureResultProps): ReactElement {
    const { result } = props;

    if (result.type === 'distance') {
        return (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3">
                <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">
                    {result.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} {result.unit}
                </p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    点数：{result.coordinates.length}
                </p>
            </div>
        );
    }

    if (result.type === 'area') {
        const perimeter = ringPerimeterMeters(result.coordinates);
        return (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3">
                <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]">
                    {result.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} {result.unit}
                </p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    周长：{perimeter.toLocaleString(undefined, { maximumFractionDigits: 2 })} m
                </p>
            </div>
        );
    }

    const elev = result.elevations ?? [];
    return (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-3">
            <p className="mb-2 text-sm text-[var(--text-secondary)]">
                剖面长度 {result.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} {result.unit}
            </p>
            <ElevationProfile coordinates={result.coordinates} elevations={elev} />
        </div>
    );
}
