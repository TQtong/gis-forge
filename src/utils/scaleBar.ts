/**
 * Preferred “nice” metric distances for scale bar labels (meters), ascending.
 */
const NICE_METERS: number[] = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000,
    1000000, 2000000, 5000000,
];

/** Target on-screen width for the scale segment (pixels). */
const TARGET_WIDTH_PX = 100;

/** Minimum acceptable bar width so labels stay readable. */
const MIN_WIDTH_PX = 48;

/**
 * Approximate meters per pixel at latitude for OSM/WebMercator zoom levels.
 *
 * @param zoom - Tile zoom level (0–22 typical).
 * @param latitudeDeg - Latitude in degrees (WGS84).
 */
function metersPerPixel(zoom: number, latitudeDeg: number): number {
    const latRad = (latitudeDeg * Math.PI) / 180;
    const cos = Math.max(0.01, Math.cos(latRad));
    const equatorMetersPerPixel = 156543.03392804097 / Math.pow(2, Math.max(0, zoom));
    return equatorMetersPerPixel * cos;
}

/**
 * Pick the largest nice distance whose bar width stays near the target width.
 *
 * @param metersPerPx - Ground meters represented by one screen pixel.
 */
function pickNiceDistance(metersPerPx: number): { distance: number; widthPx: number } {
    if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) {
        return { distance: NICE_METERS[0]!, widthPx: MIN_WIDTH_PX };
    }
    const idealMeters = metersPerPx * TARGET_WIDTH_PX;
    let chosen: number = NICE_METERS[0]!;
    for (const n of NICE_METERS) {
        if (n <= idealMeters) {
            chosen = n;
        } else {
            break;
        }
    }
    let widthPx = chosen / metersPerPx;
    if (widthPx < MIN_WIDTH_PX) {
        const idx = NICE_METERS.indexOf(chosen);
        for (let j = idx + 1; j < NICE_METERS.length; j++) {
            const candidate = NICE_METERS[j]!;
            const w = candidate / metersPerPx;
            chosen = candidate;
            widthPx = w;
            if (w >= MIN_WIDTH_PX) {
                break;
            }
        }
    }
    return { distance: chosen, widthPx };
}

/**
 * Human-readable label for a metric distance (m / km).
 *
 * @param meters - Distance in meters.
 */
function formatLabel(meters: number): string {
    if (!Number.isFinite(meters) || meters < 0) {
        return '0 m';
    }
    if (meters >= 1000) {
        const km = meters / 1000;
        const rounded = km >= 100 ? Math.round(km) : Math.round(km * 10) / 10;
        return `${rounded} km`;
    }
    if (meters >= 1) {
        return `${Math.round(meters)} m`;
    }
    return `${meters.toFixed(2)} m`;
}

/**
 * Computes a round map scale bar length, label, and pixel width for the current zoom and latitude.
 *
 * @param zoom - WebMercator zoom level (clamped internally if NaN).
 * @param latitude - Latitude in degrees (WGS84); drives scale distortion away from the equator.
 * @returns Distance in meters, display label, and bar width in CSS pixels.
 */
export function calculateScaleBar(
    zoom: number,
    latitude: number,
): { distance: number; label: string; widthPx: number } {
    const z = Number.isFinite(zoom) ? zoom : 0;
    const lat = Number.isFinite(latitude) ? Math.min(85, Math.max(-85, latitude)) : 0;
    const mpp = metersPerPixel(z, lat);
    const { distance, widthPx } = pickNiceDistance(mpp);
    return {
        distance,
        label: formatLabel(distance),
        widthPx: Number.isFinite(widthPx) ? Math.max(MIN_WIDTH_PX, widthPx) : MIN_WIDTH_PX,
    };
}
