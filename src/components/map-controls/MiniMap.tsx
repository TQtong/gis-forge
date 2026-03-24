import { useCallback, useEffect, useRef, type MouseEvent, type ReactElement } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useUIStore } from '@/stores/uiStore';

/** Canvas width in CSS pixels (matches Tailwind `w-[120px]`). */
const CANVAS_W = 120;

/** Canvas height in CSS pixels (matches `h-[90px]`). */
const CANVAS_H = 90;

/**
 * Simplified world coastline as a single closed polyline (~20 vertices) in WGS84 degrees.
 * Used as decorative context for the overview; not intended for cartographic accuracy.
 */
const WORLD_OUTLINE: [number, number][] = [
  [-170, 72],
  [-130, 70],
  [-95, 68],
  [-60, 66],
  [-20, 65],
  [20, 63],
  [60, 62],
  [110, 58],
  [150, 55],
  [180, 52],
  [180, -58],
  [140, -48],
  [100, -42],
  [60, -38],
  [20, -40],
  [-20, -45],
  [-60, -50],
  [-100, -52],
  [-140, -55],
  [-180, -58],
  [-180, 72],
];

/**
 * Converts WGS84 lng/lat to minimap pixel coordinates (equirectangular).
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns Pixel position `[x, y]` with origin top-left.
 */
function project(lng: number, lat: number): [number, number] {
  const x = ((lng + 180) / 360) * CANVAS_W;
  const y = ((90 - lat) / 180) * CANVAS_H;
  return [x, y];
}

/**
 * Converts pixel coordinates to WGS84 lng/lat (inverse of {@link project}).
 *
 * @param x - Pixel x.
 * @param y - Pixel y.
 * @returns `[longitude, latitude]` in degrees.
 */
function unproject(x: number, y: number): [number, number] {
  const lng = (x / CANVAS_W) * 360 - 180;
  const lat = 90 - (y / CANVAS_H) * 180;
  const clampedLat = Math.min(85, Math.max(-85, lat));
  let lngWrapped = lng;
  while (lngWrapped > 180) {
    lngWrapped -= 360;
  }
  while (lngWrapped < -180) {
    lngWrapped += 360;
  }
  return [lngWrapped, clampedLat];
}

/**
 * Approximate longitude/latitude span visible at the given zoom (empirical, for viewport rectangle).
 *
 * @param zoom - Map zoom level.
 * @returns Half-width in degrees longitude and half-height in degrees latitude.
 */
function approxHalfSpans(zoom: number): { halfLng: number; halfLat: number } {
  const z = Number.isFinite(zoom) ? zoom : 0;
  const denom = Math.pow(2, Math.min(22, Math.max(0, z))) + 1e-6;
  const halfLng = 180 / denom;
  const halfLat = halfLng * 0.55;
  return { halfLng, halfLat };
}

/**
 * Eagle-eye minimap: world outline, current viewport rectangle, click-to-flyTo.
 *
 * @returns Canvas control or null when disabled in settings.
 */
export function MiniMap(): ReactElement | null {
  const showMiniMap = useUIStore((s) => s.showMiniMap);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const flyTo = useMapStore((s) => s.flyTo);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(CANVAS_W * dpr);
    canvas.height = Math.round(CANVAS_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#53a8b6';
    const border = getComputedStyle(canvas).getPropertyValue('--border').trim() || '#333';
    const muted = getComputedStyle(canvas).getPropertyValue('--text-muted').trim() || '#666';

    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < WORLD_OUTLINE.length; i += 1) {
      const p = WORLD_OUTLINE[i];
      if (!p) {
        continue;
      }
      const [px, py] = project(p[0], p[1]);
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();

    const lng = center[0];
    const lat = center[1];
    const { halfLng, halfLat } = approxHalfSpans(zoom);
    const x0 = lng - halfLng;
    const x1 = lng + halfLng;
    const y0 = lat - halfLat;
    const y1 = lat + halfLat;
    const [px0, py0] = project(x0, y1);
    const [px1, py1] = project(x1, y0);
    const rx = Math.min(px0, px1);
    const ry = Math.min(py0, py1);
    const rw = Math.abs(px1 - px0);
    const rh = Math.abs(py1 - py0);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
  }, [center, zoom]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      draw();
    });
    const canvas = canvasRef.current;
    if (canvas) {
      ro.observe(canvas);
    }
    return () => {
      ro.disconnect();
    };
  }, [draw]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const [lng, lat] = unproject(x, y);
    flyTo([lng, lat], zoom);
  };

  if (!showMiniMap) {
    return null;
  }

  return (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 z-10 h-[90px] w-[120px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-panel)]/80 shadow-md backdrop-blur-sm"
      role="presentation"
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="h-full w-full cursor-pointer"
        onClick={onClick}
        aria-label="鹰眼图，点击跳转视图"
      />
    </div>
  );
}
