import { useMemo, type ReactElement } from 'react';
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

/**
 * Props for the elevation profile chart (distance vs elevation).
 */
export interface ElevationProfileProps {
    /** Path vertices as `[lng, lat]` or `[x, y]` in map CRS. */
    coordinates: number[][];
    /** Per-vertex elevations in meters; length should match `coordinates` when provided. */
    elevations: number[];
}

const CHART_HEIGHT_PX = 160;

/**
 * Haversine distance between two WGS84 lon/lat pairs in meters.
 *
 * @param a - First point `[lng, lat]` in degrees.
 * @param b - Second point `[lng, lat]` in degrees.
 * @returns Geodesic distance in meters.
 */
function haversineMeters(a: number[], b: number[]): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
        sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return R * c;
}

/**
 * Recharts area chart of cumulative path distance vs elevation with accent gradient fill.
 *
 * @param props - Coordinates and sampled elevations.
 * @returns Responsive chart or empty-state text.
 */
export function ElevationProfile(props: ElevationProfileProps): ReactElement {
    const { coordinates, elevations } = props;

    const chartData = useMemo(() => {
        if (!coordinates.length || !elevations.length || coordinates.length !== elevations.length) {
            return [];
        }
        const rows: { dist: number; elevation: number }[] = [];
        let cum = 0;
        for (let i = 0; i < coordinates.length; i++) {
            if (i > 0) {
                cum += haversineMeters(coordinates[i - 1]!, coordinates[i]!);
            }
            const elev = elevations[i];
            if (!Number.isFinite(elev)) {
                continue;
            }
            rows.push({ dist: cum, elevation: elev });
        }
        return rows;
    }, [coordinates, elevations]);

    const minMax = useMemo(() => {
        if (!chartData.length) {
            return { min: 0, max: 0 };
        }
        let min = chartData[0]!.elevation;
        let max = chartData[0]!.elevation;
        for (const row of chartData) {
            if (row.elevation < min) {
                min = row.elevation;
            }
            if (row.elevation > max) {
                max = row.elevation;
            }
        }
        return { min, max };
    }, [chartData]);

    if (!chartData.length) {
        return (
            <div className="flex h-[160px] w-full items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-input)] text-sm text-[var(--text-muted)]">
                暂无高程剖面数据
            </div>
        );
    }

    return (
        <div className="w-full">
            <div className="mb-1 flex justify-between text-xs text-[var(--text-secondary)]">
                <span>最低 {minMax.min.toFixed(1)} m</span>
                <span>最高 {minMax.max.toFixed(1)} m</span>
            </div>
            <div className="h-[160px] w-full">
                <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id="elevationFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.55} />
                                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.05} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                        <XAxis
                            dataKey="dist"
                            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                            tickFormatter={(v: number) => `${(v / 1000).toFixed(2)} km`}
                            label={{ value: '累计距离', position: 'insideBottom', offset: -2, fill: 'var(--text-secondary)', fontSize: 11 }}
                        />
                        <YAxis
                            dataKey="elevation"
                            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                            width={44}
                            label={{ value: '高程 (m)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
                        />
                        <Tooltip
                            contentStyle={{
                                background: 'var(--bg-panel)',
                                border: '1px solid var(--border)',
                                borderRadius: 6,
                                color: 'var(--text-primary)',
                            }}
                            formatter={(value: number) => [`${value.toFixed(1)} m`, '高程']}
                            labelFormatter={(_, payload) => {
                                const p = payload?.[0]?.payload as { dist: number } | undefined;
                                return p ? `距离 ${(p.dist / 1000).toFixed(3)} km` : '';
                            }}
                        />
                        <Area
                            type="monotone"
                            dataKey="elevation"
                            stroke="var(--accent)"
                            strokeWidth={2}
                            fill="url(#elevationFill)"
                            isAnimationActive={false}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
