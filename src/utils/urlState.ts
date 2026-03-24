import type { MapViewState } from '@/types';

/** Multiplier to convert radians to degrees. */
const RAD_TO_DEG = 180 / Math.PI;

/** Multiplier to convert degrees to radians. */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Parses a URL hash fragment into query-style key/value pairs.
 * Accepts strings with or without a leading `#`. Exported for hooks that need keys such as `layers`.
 *
 * @param hash - Raw hash string (e.g. `#center=1,2&zoom=3` or `center=1,2`).
 * @returns Record of decoded keys to string values.
 */
export function parseHashParams(hash: string): Record<string, string> {
  const trimmed = hash.trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!withoutHash) {
    return {};
  }
  const params: Record<string, string> = {};
  const pairs = withoutHash.split('&');
  for (const pair of pairs) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf('=');
    if (eq === -1) {
      params[decodeURIComponent(pair)] = '';
    } else {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1));
      params[key] = value;
    }
  }
  return params;
}

/**
 * Serializes map view fields into URL hash query segments (no leading `#`).
 * Bearing and pitch are written in **degrees** for readability; `mode` uses `2d` / `25d` / `globe`.
 *
 * @param state - Partial map view state; omitted keys are skipped.
 * @returns Hash body without `#`, e.g. `center=116.4,39.9&zoom=12&bearing=0&pitch=0&mode=2d`.
 */
export function encodeMapState(
  state: Partial<
    Pick<MapViewState, 'center' | 'zoom' | 'bearing' | 'pitch' | 'mode'>
  >,
): string {
  const parts: string[] = [];
  const c = state.center;
  if (c && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
    parts.push(`center=${c[0]},${c[1]}`);
  }
  if (state.zoom !== undefined && Number.isFinite(state.zoom)) {
    parts.push(`zoom=${state.zoom}`);
  }
  if (state.bearing !== undefined && Number.isFinite(state.bearing)) {
    const deg = state.bearing * RAD_TO_DEG;
    parts.push(`bearing=${deg}`);
  }
  if (state.pitch !== undefined && Number.isFinite(state.pitch)) {
    const deg = state.pitch * RAD_TO_DEG;
    parts.push(`pitch=${deg}`);
  }
  if (state.mode) {
    parts.push(`mode=${state.mode}`);
  }
  return parts.join('&');
}

/**
 * Parses map parameters from a full hash string into a partial {@link MapViewState}.
 * Unknown keys are ignored. Center uses `center=lng,lat`. Bearing/pitch in the hash are **degrees**.
 *
 * @param hash - Full location hash including optional `#`.
 * @returns Partial map view state (radians for bearing/pitch).
 */
export function decodeMapState(hash: string): Partial<MapViewState> {
  const params = parseHashParams(hash);
  const out: Partial<MapViewState> = {};

  const centerRaw = params.center;
  if (centerRaw) {
    const bits = centerRaw.split(',');
    if (bits.length >= 2) {
      const lng = Number.parseFloat(bits[0] ?? '');
      const lat = Number.parseFloat(bits[1] ?? '');
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        const clampLat = Math.min(90, Math.max(-90, lat));
        const wrapLng = ((((lng + 180) % 360) + 360) % 360) - 180;
        out.center = [wrapLng, clampLat];
      }
    }
  }

  if (params.zoom !== undefined) {
    const z = Number.parseFloat(params.zoom);
    if (Number.isFinite(z)) {
      out.zoom = Math.min(22, Math.max(0, z));
    }
  }

  if (params.bearing !== undefined) {
    const b = Number.parseFloat(params.bearing);
    if (Number.isFinite(b)) {
      out.bearing = b * DEG_TO_RAD;
    }
  }

  if (params.pitch !== undefined) {
    const p = Number.parseFloat(params.pitch);
    if (Number.isFinite(p)) {
      out.pitch = p * DEG_TO_RAD;
    }
  }

  const modeRaw = params.mode;
  if (modeRaw === '2d' || modeRaw === '25d' || modeRaw === 'globe') {
    out.mode = modeRaw;
  }

  return out;
}

/**
 * Encodes visible layer ids as a comma-separated list safe for URL hash segments.
 *
 * @param visibleLayerIds - Layer ids to expose in the hash (order preserved).
 * @returns Comma-separated, URI-encoded ids.
 */
export function encodeLayerState(visibleLayerIds: string[]): string {
  if (!visibleLayerIds.length) {
    return '';
  }
  return visibleLayerIds.map((id) => encodeURIComponent(id)).join(',');
}

/**
 * Decodes a `layers` hash parameter into layer id strings.
 *
 * @param param - Value of the `layers` key (comma-separated ids).
 * @returns Decoded layer ids; empty strings are skipped.
 */
export function decodeLayerState(param: string): string[] {
  if (!param.trim()) {
    return [];
  }
  return param
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/**
 * Reads the `layers` key from a full hash string.
 *
 * @param hash - Location hash including optional `#`.
 * @returns Decoded visible layer ids.
 */
export function decodeLayersFromHash(hash: string): string[] {
  const params = parseHashParams(hash);
  const raw = params.layers;
  if (!raw) {
    return [];
  }
  return decodeLayerState(raw);
}
