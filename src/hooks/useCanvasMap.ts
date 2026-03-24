import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';

/**
 * Web Mercator helpers
 */
const TILE_SIZE = 256;

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
    const tileW = TILE_SIZE * scale;
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

/**
 * Canvas 2D interactive OSM map renderer.
 * Handles pan (drag), zoom (scroll wheel), and syncs with mapStore.
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

        const { center, zoom } = useMapStore.getState();
        const [lng, lat] = center;
        const w = canvas.width;
        const h = canvas.height;
        const zInt = Math.floor(zoom);
        const scale = Math.pow(2, zoom - zInt);

        const centerTileX = lngToTileX(lng, zInt);
        const centerTileY = latToTileY(lat, zInt);

        const centerPixelX = centerTileX * TILE_SIZE * scale;
        const centerPixelY = centerTileY * TILE_SIZE * scale;

        const offsetX = w / 2 - centerPixelX;
        const offsetY = h / 2 - centerPixelY;

        const tileW = TILE_SIZE * scale;
        const startTileX = Math.floor(-offsetX / tileW);
        const startTileY = Math.floor(-offsetY / tileW);
        const endTileX = Math.ceil((w - offsetX) / tileW);
        const endTileY = Math.ceil((h - offsetY) / tileW);
        const maxTile = Math.pow(2, zInt);

        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, w, h);

        let needsRedraw = false;

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
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.scale(dpr, dpr);
            canvas.width = rect.width;
            canvas.height = rect.height;
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
            const scale = Math.pow(2, store.zoom - zInt);
            const tileW = TILE_SIZE * scale;
            const mouseLng = tileXToLng(tileXAtMouse, zInt);
            const mouseLat = tileYToLat(tileYAtMouse, zInt);
            pendingCoord.current = [mouseLng, mouseLat];

            if (!isDragging.current) return;

            const dx = e.clientX - lastMouse.current.x;
            const dy = e.clientY - lastMouse.current.y;
            lastMouse.current = { x: e.clientX, y: e.clientY };

            const [cLng, cLat] = store.center;
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
