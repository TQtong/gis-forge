import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';
import {
    createFogManager,
    createSkyRenderer,
    computeHorizonYNormalized,
} from '@/packages/gpu/src/l2/index.ts';
import {
    computeCamera25D,
    coveringTiles,
    worldToScreen,
} from '@/hooks/useCamera25D';
import type { Camera25DState, TileID } from '@/hooks/useCamera25D';

/** 2.5D sky + fog instances (shared, stateless singletons matching L2 config). */
const skyRenderer = createSkyRenderer();
const fogManager = createFogManager();

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

/**
 * Tile pixel size used by the 2D flat renderer (classic OSM 256 px tiles).
 * The 2.5D pipeline uses TILE_SIZE=512 for world coordinates internally,
 * but tile image fetching still uses the standard z/x/y grid.
 */
const TILE_SIZE_2D = 256;

/**
 * Pitch used for 2.5D rendering (radians).
 * 35° ≈ 0.6109 rad — provides a good sense of perspective without extreme foreshortening.
 */
const PITCH_25D_RAD = 35 * Math.PI / 180;

/**
 * Vertical FOV for the 2.5D perspective camera (radians).
 * 0.6435 rad ≈ 36.87° — matches the design document exactly.
 */
const FOV_25D = 0.6435;

/** Mouse wheel: zoom change per pixel of deltaY (after LINE/PAGE normalization). */
const WHEEL_ZOOM_RATE = 1 / 450;
/** Trackpad: higher event rate → lower rate to avoid overshooting. */
const TRACKPAD_ZOOM_RATE = 1 / 1200;
/** Firefox DOM_DELTA_LINE → scale to pixel-like units. */
const LINE_DELTA_MULTIPLIER = 40;
/** DOM_DELTA_PAGE → scale to pixel-like units. */
const PAGE_DELTA_MULTIPLIER = 300;
/** Wheel / anchor zoom clamp (interactive canvas). */
const INTERACTIVE_MIN_ZOOM = 1;
const INTERACTIVE_MAX_ZOOM = 20;

/** Time window (ms) for counting rapid wheel events (trackpad heuristic). */
const TRACKPAD_DETECT_WINDOW_MS = 400;

/** Last wheel timestamp and burst count for trackpad detection. */
let lastWheelTimeMs = 0;
let wheelBurstCount = 0;
/** Hysteresis: once trackpad, short-term remember until window resets. */
let lastTrackpadFlag = false;

/**
 * Returns true if |deltaY| is consistent with classic mouse wheel steps (multiples of 120).
 *
 * @param deltaY - Raw or normalized wheel deltaY.
 */
function isLikelyMouseWheelDelta(deltaY: number): boolean {
    const a = Math.abs(deltaY);
    if (a < 1e-6) return true;
    const n = a / 120;
    return Math.abs(n - Math.round(n)) < 1e-3;
}

/**
 * Heuristic: trackpad if deltaY is not a multiple of 120, or many events in 400ms.
 *
 * @param event - Wheel event (uses deltaY and timing).
 */
function detectTrackpad(event: WheelEvent): boolean {
    const now = performance.now();
    if (now - lastWheelTimeMs > TRACKPAD_DETECT_WINDOW_MS) {
        wheelBurstCount = 0;
        lastTrackpadFlag = false;
    }
    wheelBurstCount += 1;
    lastWheelTimeMs = now;

    if (wheelBurstCount > 3) {
        lastTrackpadFlag = true;
        return true;
    }
    if (!isLikelyMouseWheelDelta(event.deltaY)) {
        lastTrackpadFlag = true;
        return true;
    }
    return lastTrackpadFlag;
}

/**
 * Normalizes wheel deltaY to pixel-like units (DOM_DELTA_PIXEL unchanged).
 *
 * @param event - Wheel event.
 */
function normalizeWheelDeltaY(event: WheelEvent): number {
    let deltaY = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        deltaY *= LINE_DELTA_MULTIPLIER;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        deltaY *= PAGE_DELTA_MULTIPLIER;
    }
    return deltaY;
}

/**
 * Clamps longitude to [-180, 180] using the same wrap as map utilities.
 *
 * @param lng - Degrees longitude.
 */
function wrapLng(lng: number): number {
    if (!Number.isFinite(lng)) return 0;
    return ((lng + 540) % 360) - 180;
}

/**
 * Clamps latitude to Web Mercator–friendly bounds.
 *
 * @param lat - Degrees latitude.
 */
function clampLatInteractive(lat: number): number {
    if (!Number.isFinite(lat)) return 0;
    return Math.max(-85, Math.min(85, lat));
}

// ═══════════════════════════════════════════════════════════
// 2D tile coordinate helpers (used by flat renderer + pan/zoom)
// ═══════════════════════════════════════════════════════════

/**
 * Converts CSS pixel position on the canvas to tile coordinates at floor(zoom),
 * matching the renderer and pan logic (fractional zoom via tile width scale).
 *
 * @param cssX - X relative to canvas left (CSS px).
 * @param cssY - Y relative to canvas top (CSS px).
 * @param canvasWidth - Canvas width (CSS px).
 * @param canvasHeight - Canvas height (CSS px).
 * @param centerLng - Current center longitude.
 * @param centerLat - Current center latitude.
 * @param zoom - Current zoom (fractional).
 */
function cssPixelToTileCoords(
    cssX: number,
    cssY: number,
    canvasWidth: number,
    canvasHeight: number,
    centerLng: number,
    centerLat: number,
    zoom: number
): { tileX: number; tileY: number; zInt: number } {
    const zInt = Math.floor(zoom);
    const scale = Math.pow(2, zoom - zInt);
    const centerTileX = lngToTileX(centerLng, zInt);
    const centerTileY = latToTileY(centerLat, zInt);
    const tileW = TILE_SIZE_2D * scale;
    const offsetX = canvasWidth / 2 - centerTileX * tileW;
    const offsetY = canvasHeight / 2 - centerTileY * tileW;
    const tileX = (cssX - offsetX) / tileW;
    const tileY = (cssY - offsetY) / tileW;
    return { tileX, tileY, zInt };
}

function lngToTileX(lng: number, zoom: number): number {
    return ((lng + 180) / 360) * Math.pow(2, zoom);
}

function latToTileY(lat: number, zoom: number): number {
    const latRad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom);
}

function tileXToLng(x: number, zoom: number): number {
    return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tileYToLat(y: number, zoom: number): number {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Computes new center and zoom so the point under the CSS pixel stays fixed (tile-space anchor formula).
 *
 * @param cssX - Pointer X in canvas CSS pixels.
 * @param cssY - Pointer Y in canvas CSS pixels.
 * @param canvasWidth - Canvas client width.
 * @param canvasHeight - Canvas client height.
 * @param oldZoom - Zoom before change.
 * @param newZoomRequested - Desired zoom (clamped to [INTERACTIVE_MIN_ZOOM, INTERACTIVE_MAX_ZOOM]).
 * @param centerLng - Current center longitude.
 * @param centerLat - Current center latitude.
 */
function computeCenterAfterZoomAroundPoint(
    cssX: number,
    cssY: number,
    canvasWidth: number,
    canvasHeight: number,
    oldZoom: number,
    newZoomRequested: number,
    centerLng: number,
    centerLat: number
): { center: [number, number]; zoom: number } {
    const clampedZoom = Math.max(
        INTERACTIVE_MIN_ZOOM,
        Math.min(INTERACTIVE_MAX_ZOOM, newZoomRequested)
    );
    if (!Number.isFinite(clampedZoom) || !Number.isFinite(oldZoom)) {
        return {
            center: [wrapLng(centerLng), clampLatInteractive(centerLat)],
            zoom: INTERACTIVE_MIN_ZOOM,
        };
    }
    if (Math.abs(clampedZoom - oldZoom) < 1e-10) {
        return {
            center: [wrapLng(centerLng), clampLatInteractive(centerLat)],
            zoom: clampedZoom,
        };
    }

    const zInt = Math.floor(oldZoom);
    const { tileX: anchorTileX, tileY: anchorTileY } = cssPixelToTileCoords(
        cssX,
        cssY,
        canvasWidth,
        canvasHeight,
        centerLng,
        centerLat,
        oldZoom
    );
    const oldCenterTileX = lngToTileX(centerLng, zInt);
    const oldCenterTileY = latToTileY(centerLat, zInt);

    const scaleFactor = Math.pow(2, clampedZoom - oldZoom);
    const newCenterTileX = anchorTileX + (oldCenterTileX - anchorTileX) / scaleFactor;
    const newCenterTileY = anchorTileY + (oldCenterTileY - anchorTileY) / scaleFactor;

    const newLng = wrapLng(tileXToLng(newCenterTileX, zInt));
    const newLat = clampLatInteractive(tileYToLat(newCenterTileY, zInt));
    return { center: [newLng, newLat], zoom: clampedZoom };
}

// ═══════════════════════════════════════════════════════════
// Tile image cache (shared across 2D and 2.5D)
// ═══════════════════════════════════════════════════════════

const tileCache = new Map<string, HTMLImageElement>();
const loadingTiles = new Set<string>();

function getTileImage(x: number, y: number, z: number): HTMLImageElement | null {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key)!;
    if (loadingTiles.has(key)) return null;

    loadingTiles.add(key);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    img.onload = () => {
        tileCache.set(key, img);
        loadingTiles.delete(key);
    };
    img.onerror = () => {
        loadingTiles.delete(key);
    };
    return null;
}

// ═══════════════════════════════════════════════════════════
// 2.5D tile quad projection
// ═══════════════════════════════════════════════════════════

/**
 * Projects the four corners of a tile through the VP matrix to screen space.
 *
 * Returns null only if all four corners would be behind the camera (clip w < 0).
 * For Canvas 2D rendering we use the bounding rect of these four screen points.
 *
 * @param tid    - Tile identifier (z, x, y).
 * @param camera - {@link Camera25DState} from {@link computeCamera25D}.
 * @returns Four screen-space [x,y] pairs: [topLeft, topRight, bottomLeft, bottomRight], or null.
 */
function computeTileScreenQuad(
    tid: TileID,
    camera: Camera25DState,
): [[number, number], [number, number], [number, number], [number, number]] | null {
    const numTiles = 1 << tid.z;
    const tileSize = camera.worldSize / numTiles;
    const x0 = tid.x * tileSize;
    const y0 = tid.y * tileSize;
    const x1 = x0 + tileSize;
    const y1 = y0 + tileSize;

    const p0 = worldToScreen(x0, y0, camera);
    const p1 = worldToScreen(x1, y0, camera);
    const p2 = worldToScreen(x0, y1, camera);
    const p3 = worldToScreen(x1, y1, camera);

    return [p0, p1, p2, p3];
}

// ═══════════════════════════════════════════════════════════
// 2.5D fog overlay (Canvas 2D approximation of GPU distance fog)
// ═══════════════════════════════════════════════════════════

/**
 * Draw a vertical gradient fog overlay that fades distant (top) regions.
 *
 * @param ctx       - Canvas 2D context.
 * @param w         - Canvas width.
 * @param h         - Canvas height.
 * @param horizonY  - Normalised horizon position (0 = top, 1 = bottom).
 */
function drawFogOverlay(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    horizonY: number,
): void {
    const horizonPx = horizonY * h;
    /* Fog starts at 40% of the way from horizon to bottom, full at horizon */
    const fogStartY = horizonPx + (h - horizonPx) * 0.1;
    const grad = ctx.createLinearGradient(0, horizonPx, 0, fogStartY);
    grad.addColorStop(0, 'rgba(10, 14, 23, 0.7)');
    grad.addColorStop(1, 'rgba(10, 14, 23, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, horizonPx, w, fogStartY - horizonPx);
}

// ═══════════════════════════════════════════════════════════
// Main hook
// ═══════════════════════════════════════════════════════════

/**
 * Canvas 2D interactive OSM map renderer.
 * Handles pan (drag), zoom (scroll wheel), and syncs with mapStore.
 *
 * @param canvasRef    - Ref to the <canvas> element.
 * @param containerRef - Ref to the parent container (for resize observation).
 */
export function useCanvasMap(canvasRef: RefObject<HTMLCanvasElement | null>, containerRef: RefObject<HTMLDivElement | null>) {
    const rafId = useRef(0);
    const isDragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const pendingCoord = useRef<[number, number] | null>(null);
    const coordTimerId = useRef<ReturnType<typeof setInterval> | null>(null);

    const render = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const { center, zoom, mode } = useMapStore.getState();
        const [lng, lat] = center;
        const w = canvas.width;
        const h = canvas.height;
        const is25d = mode === '2.5d';
        const pitchRad = is25d ? PITCH_25D_RAD : 0;
        const zInt = Math.floor(zoom);
        const scale = Math.pow(2, zoom - zInt);

        const centerTileX = lngToTileX(lng, zInt);
        const centerTileY = latToTileY(lat, zInt);

        const centerPixelX = centerTileX * TILE_SIZE_2D * scale;
        const centerPixelY = centerTileY * TILE_SIZE_2D * scale;

        const offsetX = w / 2 - centerPixelX;
        const offsetY = h / 2 - centerPixelY;

        const tileW = TILE_SIZE_2D * scale;
        const startTileX = Math.floor(-offsetX / tileW);
        const startTileY = Math.floor(-offsetY / tileW);
        const endTileX = Math.ceil((w - offsetX) / tileW);
        const endTileY = Math.ceil((h - offsetY) / tileW);
        const maxTile = Math.pow(2, zInt);

        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);

        let needsRedraw = false;

        if (is25d) {
            // ═══ 2.5D: VP-matrix perspective pipeline ═══

            const camera = computeCamera25D(
                center,
                zoom,
                pitchRad,
                0,
                FOV_25D,
                { width: w, height: h },
            );

            /* Sky gradient above the horizon */
            const horizonY = computeHorizonYNormalized(pitchRad);
            skyRenderer.renderToCanvas2D(ctx, w, h, horizonY, pitchRad);

            /* Covering tiles from the real frustum, sorted near→far by the algorithm. */
            const tileIds = coveringTiles(camera);

            /* Canvas 2D painter's algorithm needs far→near (back-to-front). */
            tileIds.reverse();

            const numTiles = 1 << Math.floor(zoom);

            for (const tid of tileIds) {
                const verts = computeTileScreenQuad(tid, camera);
                if (!verts) continue;

                /* Bounding rect of the projected quad (Canvas 2D can't do arbitrary quads) */
                const minX = Math.min(verts[0][0], verts[1][0], verts[2][0], verts[3][0]);
                const minY = Math.min(verts[0][1], verts[1][1], verts[2][1], verts[3][1]);
                const maxX = Math.max(verts[0][0], verts[1][0], verts[2][0], verts[3][0]);
                const maxY = Math.max(verts[0][1], verts[1][1], verts[2][1], verts[3][1]);

                /* Skip tiles fully outside the viewport */
                if (maxX < 0 || minX > w || maxY < 0 || minY > h) continue;

                /* Wrap x into valid [0, numTiles) range for the OSM URL */
                const wrappedX = ((tid.x % numTiles) + numTiles) % numTiles;

                const img = getTileImage(wrappedX, tid.y, tid.z);
                if (img) {
                    ctx.drawImage(img, minX, minY, maxX - minX, maxY - minY);
                } else {
                    ctx.fillStyle = '#1a2744';
                    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
                    needsRedraw = true;
                }
            }

            /* Fog overlay for far-away tiles near the horizon */
            drawFogOverlay(ctx, w, h, horizonY);

        } else {
            // ═══ 2D flat rendering ═══
            for (let ty = startTileY; ty < endTileY; ty++) {
                for (let tx = startTileX; tx < endTileX; tx++) {
                    const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
                    if (ty < 0 || ty >= maxTile) continue;

                    const img = getTileImage(wrappedX, ty, zInt);
                    const drawX = tx * tileW + offsetX;
                    const drawY = ty * tileW + offsetY;

                    if (img) {
                        ctx.drawImage(img, drawX, drawY, tileW, tileW);
                    } else {
                        ctx.fillStyle = '#1a2744';
                        ctx.fillRect(drawX, drawY, tileW, tileW);
                        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
                        ctx.strokeRect(drawX, drawY, tileW, tileW);
                        needsRedraw = true;
                    }
                }
            }
        }

        if (needsRedraw) {
            rafId.current = requestAnimationFrame(render);
        }
    }, [canvasRef]);

    const scheduleRender = useCallback(() => {
        cancelAnimationFrame(rafId.current);
        rafId.current = requestAnimationFrame(render);
    }, [render]);

    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const resizeCanvas = () => {
            const rect = container.getBoundingClientRect();
            canvas.width = rect.width;
            canvas.height = rect.height;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            canvas.style.position = '';
            canvas.style.top = '';
            canvas.style.left = '';
            scheduleRender();
        };

        resizeCanvas();
        const ro = new ResizeObserver(resizeCanvas);
        ro.observe(container);

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const store = useMapStore.getState();
            const rect = canvas.getBoundingClientRect();
            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;
            const deltaY = normalizeWheelDeltaY(e);
            const isTrackpad = detectTrackpad(e);
            const zoomRate = isTrackpad ? TRACKPAD_ZOOM_RATE : WHEEL_ZOOM_RATE;
            const zoomDelta = -deltaY * zoomRate;
            const newZoomRequested = store.zoom + zoomDelta;
            const [lng, lat] = store.center;
            const { center, zoom } = computeCenterAfterZoomAroundPoint(
                cssX,
                cssY,
                rect.width,
                rect.height,
                store.zoom,
                newZoomRequested,
                lng,
                lat
            );
            useMapStore.getState().flyTo(center, zoom);
            scheduleRender();
        };

        const onDblClick = (e: MouseEvent) => {
            e.preventDefault();
            const store = useMapStore.getState();
            const rect = canvas.getBoundingClientRect();
            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;
            const step = e.shiftKey ? -1 : 1;
            const newZoomRequested = store.zoom + step;
            const [lng, lat] = store.center;
            const { center, zoom } = computeCenterAfterZoomAroundPoint(
                cssX,
                cssY,
                rect.width,
                rect.height,
                store.zoom,
                newZoomRequested,
                lng,
                lat
            );
            useMapStore.getState().flyTo(center, zoom);
            scheduleRender();
        };

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            isDragging.current = true;
            lastMouse.current = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
        };

        const onMouseMove = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            const store = useMapStore.getState();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            const zInt = Math.floor(store.zoom);
            const { tileX: tileXAtMouse, tileY: tileYAtMouse } = cssPixelToTileCoords(
                px,
                py,
                rect.width,
                rect.height,
                store.center[0],
                store.center[1],
                store.zoom
            );
            const mouseLng = tileXToLng(tileXAtMouse, zInt);
            const mouseLat = tileYToLat(tileYAtMouse, zInt);
            pendingCoord.current = [mouseLng, mouseLat];

            if (!isDragging.current) return;

            const dx = e.clientX - lastMouse.current.x;
            const dy = e.clientY - lastMouse.current.y;
            lastMouse.current = { x: e.clientX, y: e.clientY };

            const [cLng, cLat] = store.center;
            const scale = Math.pow(2, store.zoom - zInt);
            const tileW = TILE_SIZE_2D * scale;
            const tileXCenter = lngToTileX(cLng, zInt);
            const tileYCenter = latToTileY(cLat, zInt);
            const newTileX = tileXCenter - dx / tileW;
            const newTileY = tileYCenter - dy / tileW;
            const newLng = tileXToLng(newTileX, zInt);
            const newLat = Math.max(-85, Math.min(85, tileYToLat(newTileY, zInt)));
            useMapStore.getState().flyTo([newLng, newLat]);
            scheduleRender();
        };

        const onMouseUp = () => {
            isDragging.current = false;
            canvas.style.cursor = 'grab';
        };

        const onMouseLeave = () => {
            isDragging.current = false;
            canvas.style.cursor = 'grab';
            useStatusStore.getState().setMouseCoord(null);
        };

        canvas.style.cursor = 'grab';
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDblClick);
        canvas.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseLeave);

        const pollInterval = setInterval(scheduleRender, 250);

        coordTimerId.current = setInterval(() => {
            const c = pendingCoord.current;
            if (c) {
                useStatusStore.getState().setMouseCoord(c);
                pendingCoord.current = null;
            }
        }, 150);

        const unsubMap = useMapStore.subscribe(scheduleRender);

        return () => {
            cancelAnimationFrame(rafId.current);
            ro.disconnect();
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('dblclick', onDblClick);
            canvas.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('mouseleave', onMouseLeave);
            clearInterval(pollInterval);
            if (coordTimerId.current) clearInterval(coordTimerId.current);
            unsubMap();
        };
    }, [containerRef, canvasRef, scheduleRender]);
}
