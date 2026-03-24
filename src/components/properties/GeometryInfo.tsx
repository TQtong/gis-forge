import type { ReactElement } from 'react';

/**
 * GeoJSON geometry payload for read-only inspection (type + coordinates tree).
 */
export interface GeometryInfoProps {
    /** GeoJSON geometry object (`type` + `coordinates`). */
    geometry: { type: string; coordinates: unknown };
}

const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Converts degrees to radians for trigonometric helpers.
 *
 * @param deg - Angle in degrees.
 * @returns Angle in radians.
 */
function toRadians(deg: number): number {
    return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two WGS84 lon/lat points (meters).
 *
 * @param a - `[lng, lat]` in degrees.
 * @param b - `[lng, lat]` in degrees.
 * @returns Great-circle distance in meters.
 */
function haversineMeters(a: [number, number], b: [number, number]): number {
    const dLat = toRadians(b[1] - a[1]);
    const dLon = toRadians(b[0] - a[0]);
    const lat1 = toRadians(a[1]);
    const lat2 = toRadians(b[1]);
    const h =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    return EARTH_RADIUS_METERS * c;
}

/**
 * Computes total line length for a GeoJSON geometry (LineString / MultiLineString).
 *
 * @param geometry - GeoJSON geometry.
 * @returns Length in meters; 0 when not applicable.
 */
export function computeGeometryLengthMeters(geometry: { type: string; coordinates: unknown }): number {
    const { type, coordinates } = geometry;
    if (type === 'LineString' && Array.isArray(coordinates)) {
        return lineStringLengthMeters(coordinates as number[][]);
    }
    if (type === 'MultiLineString' && Array.isArray(coordinates)) {
        const lines = coordinates as number[][][];
        let total = 0;
        for (const line of lines) total += lineStringLengthMeters(line);
        return total;
    }
    return 0;
}

/**
 * Computes total polygon area for Polygon / MultiPolygon geometries.
 *
 * @param geometry - GeoJSON geometry.
 * @returns Area in square meters; 0 when not applicable.
 */
export function computeGeometryAreaSquareMeters(geometry: { type: string; coordinates: unknown }): number {
    const { type, coordinates } = geometry;
    if (type === 'Polygon' && Array.isArray(coordinates)) {
        const rings = coordinates as number[][][];
        return rings[0] ? ringAreaSquareMeters(rings[0]) : 0;
    }
    if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
        const polys = coordinates as number[][][][];
        let totalArea = 0;
        for (const poly of polys) {
            if (poly[0]) totalArea += ringAreaSquareMeters(poly[0]);
        }
        return totalArea;
    }
    return 0;
}

/**
 * Sums great-circle segment lengths along a LineString vertex chain.
 *
 * @param coords - Ordered `[lng, lat]` vertices.
 * @returns Total path length in meters.
 */
function lineStringLengthMeters(coords: number[][]): number {
    if (!coords || coords.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < coords.length; i++) {
        const p0 = coords[i - 1];
        const p1 = coords[i];
        if (!p0 || !p1 || p0.length < 2 || p1.length < 2) continue;
        sum += haversineMeters([p0[0], p0[1]], [p1[0], p1[1]]);
    }
    return sum;
}

/**
 * Approximates polygon ring area using a local equirectangular projection (meters²).
 *
 * @param ring - Closed ring `[lng, lat]` (first point may repeat last).
 * @returns Ring area in square meters (absolute value).
 */
function ringAreaSquareMeters(ring: number[][]): number {
    if (!ring || ring.length < 3) return 0;
    const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
    if (n < 3) return 0;
    let sumLat = 0;
    for (let i = 0; i < n; i++) sumLat += ring[i][1];
    const meanLat = sumLat / n;
    const cosLat = Math.cos(toRadians(meanLat));
    const r = EARTH_RADIUS_METERS;
    let area = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const xi = toRadians(ring[i][0]) * r * cosLat;
        const yi = toRadians(ring[i][1]) * r;
        const xj = toRadians(ring[j][0]) * r * cosLat;
        const yj = toRadians(ring[j][1]) * r;
        area += xi * yj - xj * yi;
    }
    return Math.abs(area / 2);
}

/**
 * Recursively collects all `[lng, lat]` pairs from nested coordinate arrays.
 *
 * @param node - GeoJSON coordinates subtree.
 * @param out - Output accumulator.
 */
function collectPositions(node: unknown, out: number[][]): void {
    if (!node) return;
    if (Array.isArray(node)) {
        if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
            out.push([node[0] as number, node[1] as number]);
            return;
        }
        for (const c of node) collectPositions(c, out);
    }
}

/**
 * Computes axis-aligned bounding box in degrees for any supported geometry.
 *
 * @param geometry - GeoJSON geometry.
 * @returns `[minLng, minLat, maxLng, maxLat]` or null when empty.
 */
function boundingBoxDegrees(geometry: { type: string; coordinates: unknown }): [number, number, number, number] | null {
    const pts: number[][] = [];
    collectPositions(geometry.coordinates, pts);
    if (pts.length === 0) return null;
    let minLng = pts[0][0];
    let maxLng = pts[0][0];
    let minLat = pts[0][1];
    let maxLat = pts[0][1];
    for (const p of pts) {
        minLng = Math.min(minLng, p[0]);
        maxLng = Math.max(maxLng, p[0]);
        minLat = Math.min(minLat, p[1]);
        maxLat = Math.max(maxLat, p[1]);
    }
    return [minLng, minLat, maxLng, maxLat];
}

/**
 * Read-only geometry summary: type, metrics, and bounding box for the property inspector.
 *
 * @param props - {@link GeometryInfoProps}
 * @returns Collapsible details block with computed metrics.
 */
export function GeometryInfo(props: GeometryInfoProps): ReactElement {
    const { geometry } = props;
    const type = geometry.type;
    const coords = geometry.coordinates as unknown;
    const bbox = boundingBoxDegrees(geometry);

    let lengthM: number | null = null;
    let areaM2: number | null = null;
    let vertexCount = 0;

    if (type === 'LineString' && Array.isArray(coords)) {
        const line = coords as number[][];
        lengthM = lineStringLengthMeters(line);
        vertexCount = line.length;
    } else if (type === 'MultiLineString' && Array.isArray(coords)) {
        const lines = coords as number[][][];
        let total = 0;
        let verts = 0;
        for (const line of lines) {
            total += lineStringLengthMeters(line);
            verts += line.length;
        }
        lengthM = total;
        vertexCount = verts;
    } else if (type === 'Polygon' && Array.isArray(coords)) {
        const rings = coords as number[][][];
        if (rings[0]) {
            areaM2 = ringAreaSquareMeters(rings[0]);
            vertexCount = rings[0].length;
        }
    } else if (type === 'MultiPolygon' && Array.isArray(coords)) {
        const polys = coords as number[][][][];
        let totalArea = 0;
        let verts = 0;
        for (const poly of polys) {
            if (poly[0]) {
                totalArea += ringAreaSquareMeters(poly[0]);
                verts += poly[0].length;
            }
        }
        areaM2 = totalArea;
        vertexCount = verts;
    } else if (type === 'Point' && Array.isArray(coords)) {
        vertexCount = 1;
    } else if (type === 'MultiPoint' && Array.isArray(coords)) {
        const pts = coords as number[][];
        vertexCount = pts.length;
    }

    const bboxText =
        bbox !== null
            ? `${bbox[0].toFixed(5)}, ${bbox[1].toFixed(5)} — ${bbox[2].toFixed(5)}, ${bbox[3].toFixed(5)}`
            : '—';

    return (
        <div className="text-sm text-[var(--text-primary)] space-y-2">
            <div className="flex justify-between gap-2">
                <span className="text-[var(--text-secondary)]">类型</span>
                <span className="font-mono text-xs">{type}</span>
            </div>
            {lengthM !== null && (
                <>
                    <div className="flex justify-between gap-2">
                        <span className="text-[var(--text-secondary)]">长度</span>
                        <span className="font-mono text-xs">
                            {lengthM < 1000 ? `${lengthM.toFixed(1)} m` : `${(lengthM / 1000).toFixed(3)} km`}
                        </span>
                    </div>
                    <div className="flex justify-between gap-2">
                        <span className="text-[var(--text-secondary)]">顶点数</span>
                        <span className="font-mono text-xs">{vertexCount}</span>
                    </div>
                </>
            )}
            {areaM2 !== null && (
                <>
                    <div className="flex justify-between gap-2">
                        <span className="text-[var(--text-secondary)]">面积</span>
                        <span className="font-mono text-xs">
                            {areaM2 < 1_000_000 ? `${areaM2.toFixed(0)} m²` : `${(areaM2 / 1_000_000).toFixed(3)} km²`}
                        </span>
                    </div>
                    <div className="flex justify-between gap-2">
                        <span className="text-[var(--text-secondary)]">顶点数</span>
                        <span className="font-mono text-xs">{vertexCount}</span>
                    </div>
                </>
            )}
            {type === 'Point' && (
                <div className="flex justify-between gap-2">
                    <span className="text-[var(--text-secondary)]">顶点数</span>
                    <span className="font-mono text-xs">{vertexCount}</span>
                </div>
            )}
            <div className="flex flex-col gap-1">
                <span className="text-[var(--text-secondary)]">范围 (°)</span>
                <span className="font-mono text-xs break-all text-[var(--text-primary)]">{bboxText}</span>
            </div>
        </div>
    );
}
