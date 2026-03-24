/**
 * Color conversion, interpolation, and preset ramps for style editors and legends.
 */

/**
 * Named color ramp presets (hex strings), used by heatmap and style presets.
 */
export const PRESET_RAMPS = {
  /** Full-spectrum rainbow (multi-hue). */
  rainbow: [
    '#9400d3',
    '#4b0082',
    '#0000ff',
    '#00ff00',
    '#ffff00',
    '#ff7f00',
    '#ff0000',
  ],
  /** Blue sequential ramp (light to dark). */
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  /** Red sequential ramp. */
  reds: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d'],
  /** Green sequential ramp. */
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45'],
  /** Common heat / temperature diverging ramp. */
  heat: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#fee090', '#fdae61', '#f46d43', '#d73027'],
  /** Viridis-like perceptually uniform ramp. */
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
} as const;

/**
 * Parse a `#RRGGBB` or `#RGB` hex string into RGB components in 0–255.
 *
 * @param hex - CSS hex color (with leading `#`).
 * @returns Tuple `[r, g, b]`; invalid input falls back to black.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '');
  if (normalized.length === 3) {
    const r = parseInt(normalized[0] + normalized[0], 16);
    const g = parseInt(normalized[1] + normalized[1], 16);
    const b = parseInt(normalized[2] + normalized[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return [0, 0, 0];
    }
    return [r, g, b];
  }
  if (normalized.length === 6) {
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return [0, 0, 0];
    }
    return [r, g, b];
  }
  return [0, 0, 0];
}

/**
 * Encode RGB bytes as a lowercase `#rrggbb` hex string.
 *
 * @param r - Red 0–255 (clamped).
 * @param g - Green 0–255 (clamped).
 * @param b - Blue 0–255 (clamped).
 * @returns Hex color string with `#` prefix.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Linearly interpolate between two CSS hex colors.
 *
 * @param c1 - Start color hex.
 * @param c2 - End color hex.
 * @param t - Interpolation factor 0–1 (clamped).
 * @returns Interpolated hex color.
 */
export function interpolateColor(c1: string, c2: string, t: number): string {
  const tt = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  const r = r1 + (r2 - r1) * tt;
  const g = g1 + (g2 - g1) * tt;
  const b = b1 + (b2 - b1) * tt;
  return rgbToHex(r, g, b);
}

/**
 * Expand a short list of key colors into `steps` evenly spaced samples (inclusive ends).
 *
 * @param colors - Key colors (length ≥ 1).
 * @param steps - Number of output colors (≥ 1).
 * @returns Array of hex colors length `steps`.
 */
export function generateColorRamp(colors: string[], steps: number): string[] {
  if (steps < 1) {
    return [];
  }
  if (colors.length === 0) {
    return Array.from({ length: steps }, () => '#000000');
  }
  if (colors.length === 1) {
    return Array.from({ length: steps }, () => colors[0]);
  }
  const n = steps;
  const out: string[] = [];
  const segments = colors.length - 1;
  for (let i = 0; i < n; i += 1) {
    const u = n === 1 ? 0 : i / (n - 1);
    const segFloat = u * segments;
    const seg = Math.min(segments - 1, Math.floor(segFloat));
    const localT = segFloat - seg;
    out.push(interpolateColor(colors[seg], colors[seg + 1], localT));
  }
  return out;
}
