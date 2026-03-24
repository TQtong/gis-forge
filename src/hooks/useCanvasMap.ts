import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';

/**
 * Web Mercator helpers
 */
const TILE_SIZE = 256;

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
            const delta = e.deltaY > 0 ? -0.3 : 0.3;
            const newZoom = Math.max(1, Math.min(20, store.zoom + delta));
            useMapStore.getState().setZoom(newZoom);
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
            const scale = Math.pow(2, store.zoom - zInt);
            const centerTileX = lngToTileX(store.center[0], zInt);
            const centerTileY = latToTileY(store.center[1], zInt);
            const tileW = TILE_SIZE * scale;
            const offsetX = rect.width / 2 - centerTileX * tileW;
            const offsetY = rect.height / 2 - centerTileY * tileW;
            const tileXAtMouse = (px - offsetX) / tileW;
            const tileYAtMouse = (py - offsetY) / tileW;
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
