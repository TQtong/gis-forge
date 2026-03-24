import { useCallback, useEffect, useState } from 'react';
import type { MeasureResult, ToolType } from '@/types';
import { useMapStore } from '@/stores/mapStore';

const EARTH_RADIUS_M = 6371000;

/**
 * Convert degrees to radians.
 */
function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two WGS84 lon/lat pairs in meters.
 *
 * @param a - Vertex `[lng, lat]`.
 * @param b - Vertex `[lng, lat]`.
 */
function haversineMeters(a: number[], b: number[]): number {
    const dLat = toRad(b[1]! - a[1]!);
    const dLon = toRad(b[0]! - a[0]!);
    const lat1 = toRad(a[1]!);
    const lat2 = toRad(b[1]!);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
        sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return EARTH_RADIUS_M * c;
}

/**
 * Sum geodesic lengths along a path.
 *
 * @param points - Ordered vertices `[lng, lat]`.
 */
function calculateDistance(points: number[][]): number {
    if (points.length < 2) {
        return 0;
    }
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
        sum += haversineMeters(points[i - 1]!, points[i]!);
    }
    return sum;
}

/**
 * Planar polygon area in m² using a local equirectangular projection (reference latitude = first vertex).
 * Suitable for small–medium regions; not for global polygons.
 *
 * @param points - Closed or open ring `[lng, lat]`; auto-closes if first ≠ last.
 */
function calculateArea(points: number[][]): number {
    if (points.length < 3) {
        return 0;
    }
    const ring = points.map((p) => [p[0]!, p[1]!]);
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push([first[0]!, first[1]!]);
    }
    const refLat = toRad(first[1]!);
    const my = EARTH_RADIUS_M * Math.cos(refLat);
    let sum = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) {
        const p1 = ring[i]!;
        const p2 = ring[i + 1]!;
        const x1 = toRad(p1[0]!) * my;
        const y1 = toRad(p1[1]!) * EARTH_RADIUS_M;
        const x2 = toRad(p2[0]!) * my;
        const y2 = toRad(p2[1]!) * EARTH_RADIUS_M;
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
}

/**
 * Build a partial or final `MeasureResult` for the active measure mode from vertices.
 *
 * @param tool - Current measure tool.
 * @param pts - Accumulated vertices.
 */
function buildMeasureResult(tool: ToolType, pts: number[][]): MeasureResult | null {
    if (!pts.length) {
        return null;
    }
    if (tool === 'measure-distance') {
        const d = calculateDistance(pts);
        return {
            type: 'distance',
            value: d,
            unit: 'm',
            coordinates: pts.map((c) => [c[0]!, c[1]!]),
        };
    }
    if (tool === 'measure-area') {
        if (pts.length < 3) {
            return {
                type: 'area',
                value: 0,
                unit: 'm²',
                coordinates: pts.map((c) => [c[0]!, c[1]!]),
            };
        }
        const a = calculateArea(pts);
        return {
            type: 'area',
            value: a,
            unit: 'm²',
            coordinates: pts.map((c) => [c[0]!, c[1]!]),
        };
    }
    if (tool === 'measure-profile') {
        const d = calculateDistance(pts);
        const elevations = pts.map(() => 0);
        return {
            type: 'profile',
            value: d,
            unit: 'm',
            coordinates: pts.map((c) => [c[0]!, c[1]!]),
            elevations,
        };
    }
    return null;
}

/**
 * Measurement workflow: distance, area, or profile with live recomputation.
 *
 * @returns Vertex buffer, latest result, and handlers.
 */
export function useMeasureTool(): {
    isMeasuring: boolean;
    points: number[][];
    result: MeasureResult | null;
    addPoint: (coord: number[]) => void;
    finish: () => void;
    cancel: () => void;
} {
    const activeTool = useMapStore((s) => s.activeTool);

    const [points, setPoints] = useState<number[][]>([]);
    const [result, setResult] = useState<MeasureResult | null>(null);

    useEffect(() => {
        setPoints([]);
        setResult(null);
    }, [activeTool]);

    useEffect(() => {
        if (!activeTool.startsWith('measure-')) {
            return;
        }
        if (points.length === 0) {
            return;
        }
        setResult(buildMeasureResult(activeTool, points));
    }, [points, activeTool]);

    const isMeasuring = points.length > 0 && activeTool.startsWith('measure-');

    const addPoint = useCallback(
        (coord: number[]) => {
            if (!activeTool.startsWith('measure-')) {
                return;
            }
            if (!Array.isArray(coord) || coord.length < 2) {
                return;
            }
            const x = Number(coord[0]);
            const y = Number(coord[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }
            setPoints((prev) => [...prev, [x, y]]);
        },
        [activeTool],
    );

    const finish = useCallback(() => {
        if (!activeTool.startsWith('measure-')) {
            return;
        }
        const finalResult = buildMeasureResult(activeTool, points);
        if (finalResult) {
            setResult(finalResult);
        }
        setPoints([]);
    }, [activeTool, points]);

    const cancel = useCallback(() => {
        setPoints([]);
        setResult(null);
    }, []);

    return {
        isMeasuring,
        points,
        result,
        addPoint,
        finish,
        cancel,
    };
}
