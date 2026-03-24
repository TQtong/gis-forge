import type { CoordinateFormat, DistanceUnit } from '@/types';

const NM_METERS = 1852;
const FT_METERS = 0.3048;
const MI_METERS = 1609.344;

/**
 * Formats longitude/latitude as decimal degrees with hemisphere suffixes.
 *
 * @param lng - Longitude in degrees, WGS84.
 * @param lat - Latitude in degrees, WGS84.
 * @returns Human-readable string such as `116.397°E, 39.908°N`.
 */
export function formatCoordDD(lng: number, lat: number): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return '—';
  }
  const lngH = lng >= 0 ? 'E' : 'W';
  const latH = lat >= 0 ? 'N' : 'S';
  const absLng = Math.abs(lng);
  const absLat = Math.abs(lat);
  return `${absLng.toFixed(6)}°${lngH}, ${absLat.toFixed(6)}°${latH}`;
}

/**
 * Converts a signed degree value to DMS with a fixed hemisphere letter.
 *
 * @param deg - Degrees (longitude or latitude magnitude handled by caller).
 * @param hemiPos - Hemisphere letter for non-negative values.
 * @param hemiNeg - Hemisphere letter for negative values.
 */
function toDmsPart(deg: number, hemiPos: string, hemiNeg: string): string {
  const sign = deg < 0 ? -1 : 1;
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = (minFloat - m) * 60;
  const hemi = sign >= 0 ? hemiPos : hemiNeg;
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(0).padStart(2, '0')}\"${hemi}`;
}

/**
 * Formats longitude/latitude as degrees–minutes–seconds with hemisphere suffixes.
 *
 * @param lng - Longitude in degrees, WGS84.
 * @param lat - Latitude in degrees, WGS84.
 * @returns Human-readable string such as `116°23'49"E, 39°54'29"N`.
 */
export function formatCoordDMS(lng: number, lat: number): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return '—';
  }
  const lngStr = toDmsPart(lng, 'E', 'W');
  const latStr = toDmsPart(lat, 'N', 'S');
  return `${lngStr}, ${latStr}`;
}

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * WGS84 lon/lat to UTM easting/northing (EPSG:326xx / 327xx grid).
 *
 * @param lon - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns Zone, hemisphere letter, easting (m), northing (m).
 */
function wgs84ToUtmParts(lon: number, lat: number): {
  zone: number;
  hemisphere: 'N' | 'S';
  easting: number;
  northing: number;
} {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56.0 && lat < 64.0 && lon >= 3.0 && lon < 12.0) {
    zone = 32;
  }
  const lonOrigin = (zone - 1) * 6 - 180 + 3;
  const lonOriginRad = (lonOrigin * Math.PI) / 180;
  const n =
    WGS84_A /
    Math.sqrt(1 - WGS84_E2 * Math.sin(latRad) * Math.sin(latRad));
  const t = Math.tan(latRad) * Math.tan(latRad);
  const c = (WGS84_E2 / (1 - WGS84_E2)) * Math.cos(latRad) * Math.cos(latRad);
  const a = (lonRad - lonOriginRad) * Math.cos(latRad);
  const m =
    WGS84_A *
    ((1 -
      WGS84_E2 / 4 -
      (3 * WGS84_E2 * WGS84_E2) / 64 -
      (5 * WGS84_E2 * WGS84_E2 * WGS84_E2) / 256) *
      latRad -
      ((3 * WGS84_E2) / 8 +
        (3 * WGS84_E2 * WGS84_E2) / 32 +
        (45 * WGS84_E2 * WGS84_E2 * WGS84_E2) / 1024) *
        Math.sin(2 * latRad) +
      ((15 * WGS84_E2 * WGS84_E2) / 256 + (45 * WGS84_E2 * WGS84_E2 * WGS84_E2) / 1024) *
        Math.sin(4 * latRad) -
      ((35 * WGS84_E2 * WGS84_E2 * WGS84_E2) / 3072) * Math.sin(6 * latRad));
  const k0 = 0.9996;
  const easting =
    k0 *
      n *
      (a +
        ((1 - t + c) * a * a * a) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58) * a * a * a * a * a) / 120) +
    500000.0;
  let northing =
    k0 *
    (m +
      n *
        Math.tan(latRad) *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a * a * a * a) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330) * a * a * a * a * a * a) / 720));
  if (lat < 0) {
    northing += 10000000.0;
  }
  return {
    zone,
    hemisphere: lat >= 0 ? 'N' : 'S',
    easting,
    northing,
  };
}

/**
 * Formats longitude/latitude as a UTM grid string (zone, easting, northing).
 *
 * @param lng - Longitude in degrees, WGS84.
 * @param lat - Latitude in degrees, WGS84.
 * @returns Human-readable string such as `50N 500123m E 4432101m N`.
 */
export function formatCoordUTM(lng: number, lat: number): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return '—';
  }
  const { zone, hemisphere, easting, northing } = wgs84ToUtmParts(lng, lat);
  return `${zone}${hemisphere} ${Math.round(easting)}m E ${Math.round(northing)}m N`;
}

/**
 * Formats a `[lng, lat]` pair according to the selected coordinate format.
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @param format - Display mode from UI settings.
 * @returns Formatted coordinate string.
 */
export function formatCoordinatesByMode(
  lng: number,
  lat: number,
  format: CoordinateFormat,
): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return '—';
  }
  if (format === 'dd') {
    return formatCoordDD(lng, lat);
  }
  if (format === 'dms') {
    return formatCoordDMS(lng, lat);
  }
  if (format === 'utm' || format === 'mgrs') {
    return formatCoordUTM(lng, lat);
  }
  return formatCoordDD(lng, lat);
}

/**
 * Formats zoom level for status overlays.
 *
 * @param zoom - Zoom level (may be fractional).
 * @returns String such as `z:12.3`.
 */
export function formatZoom(zoom: number): string {
  if (!Number.isFinite(zoom)) {
    return 'z:—';
  }
  const z = Math.abs(zoom) >= 100 ? zoom.toFixed(0) : zoom.toFixed(1);
  return `z:${z}`;
}

/**
 * Formats byte sizes with binary-ish grouping (MB/GB).
 *
 * @param bytes - Size in bytes; negative values are treated as zero.
 * @returns Compact label such as `174MB` or `1.2GB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0B';
  }
  const gb = 1024 ** 3;
  const mb = 1024 ** 2;
  if (bytes >= gb) {
    const v = bytes / gb;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}GB`;
  }
  if (bytes >= mb) {
    const v = bytes / mb;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}MB`;
  }
  const kb = 1024;
  if (bytes >= kb) {
    const v = bytes / kb;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}KB`;
  }
  return `${Math.round(bytes)}B`;
}

/**
 * Adds thousands separators to a number for tables and HUDs.
 *
 * @param n - Numeric value.
 * @returns Locale-style grouped integer/fractional string.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    return '—';
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
}

/**
 * Formats a metric distance with automatic km/m (or imperial/nautical) selection.
 *
 * @param meters - Distance in meters.
 * @param unit - Unit system selector.
 * @returns Short label with unit suffix.
 */
export function formatDistance(meters: number, unit: DistanceUnit): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return '—';
  }
  if (unit === 'metric') {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 2)} km`;
    }
    return `${meters < 1 ? meters.toFixed(2) : Math.round(meters)} m`;
  }
  if (unit === 'imperial') {
    const ft = meters / FT_METERS;
    if (ft >= MI_METERS / FT_METERS) {
      const mi = meters / MI_METERS;
      return `${mi.toFixed(mi >= 10 ? 1 : 2)} mi`;
    }
    return `${ft.toFixed(ft < 10 ? 1 : 0)} ft`;
  }
  const nm = meters / NM_METERS;
  return `${nm.toFixed(nm >= 10 ? 1 : 3)} NM`;
}

/**
 * Formats an area with automatic unit scaling per system.
 *
 * @param sqMeters - Area in square meters.
 * @param unit - Unit system selector.
 * @returns Short label with squared unit suffix.
 */
export function formatArea(sqMeters: number, unit: DistanceUnit): string {
  if (!Number.isFinite(sqMeters) || sqMeters < 0) {
    return '—';
  }
  if (unit === 'metric') {
    if (sqMeters >= 1_000_000) {
      const km2 = sqMeters / 1_000_000;
      return `${km2.toFixed(km2 >= 100 ? 0 : 2)} km²`;
    }
    if (sqMeters >= 10_000) {
      return `${(sqMeters / 10_000).toFixed(1)} ha`;
    }
    return `${sqMeters.toFixed(sqMeters < 1 ? 2 : 0)} m²`;
  }
  if (unit === 'imperial') {
    const sqFt = sqMeters / (FT_METERS * FT_METERS);
    const sqMi = sqMeters / (MI_METERS * MI_METERS);
    if (sqMi >= 1) {
      return `${sqMi.toFixed(sqMi >= 10 ? 1 : 2)} mi²`;
    }
    return `${sqFt.toFixed(sqFt >= 1000 ? 0 : 1)} ft²`;
  }
  const sqNm = sqMeters / (NM_METERS * NM_METERS);
  return `${sqNm.toFixed(sqNm >= 1 ? 3 : 6)} NM²`;
}
