import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Feature } from '@/types';
import { useMapStore } from '@/stores/mapStore';
import { useSelectionStore } from '@/stores/selectionStore';
import { useStatusStore } from '@/stores/statusStore';
import {
    computeCamera,
    screenToWorld,
    worldToLngLat,
} from '@/hooks/useCamera25D';

/**
 * Client-space position for context menus.
 */
export type ContextMenuClientPos = { x: number; y: number };

/**
 * Vertical FOV for camera reconstruction (must match the renderer constant).
 * 0.6435 rad ≈ 36.87°.
 */
const FOV_RAD = 0.6435;

/**
 * Pitch used for 2.5D coordinate un-projection (35° in radians).
 */
const PITCH_25D_RAD = 35 * Math.PI / 180;

/**
 * Throttle interval for mouse coordinate updates to statusStore (ms).
 * Prevents excessive store writes during rapid mouse movement.
 */
const COORD_THROTTLE_MS = 150;

/**
 * Builds a deterministic mock feature for selection / hover demos.
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @param seq - Sequence number to vary ids.
 * @returns {@link Feature}
 */
function createMockFeature(lng: number, lat: number, seq: number): Feature {
    return {
        id: `mock-${seq}`,
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [lng, lat],
        },
        properties: {
            name: `示例要素 ${seq}`,
            category: 'demo',
        },
        layerId: 'demo-layer',
        sourceId: 'demo-source',
    };
}

/**
 * Convert a CSS pixel position within the container to geographic [lng, lat]
 * by un-projecting through the current camera matrices.
 *
 * Falls back to a simple linear mapping when the ray misses the ground plane
 * (e.g. looking above the horizon).
 *
 * @param containerRect - BoundingClientRect of the map container.
 * @param clientX       - Mouse clientX.
 * @param clientY       - Mouse clientY.
 * @returns [lng, lat] in degrees, or `null` if un-projection fails entirely.
 */
function clientToLngLatCamera(
    containerRect: DOMRect,
    clientX: number,
    clientY: number,
): [number, number] | null {
    const { center, zoom, bearing, mode } = useMapStore.getState();

    /* Screen pixel within the canvas (physical pixels at DPR=1 for CSS-space viewports) */
    const sx = clientX - containerRect.left;
    const sy = clientY - containerRect.top;
    const viewport = { width: containerRect.width, height: containerRect.height };

    /* Reconstruct the camera for the current mode */
    const pitch = mode === '2.5d' ? PITCH_25D_RAD : 0;
    const bear = mode === '2.5d' ? (bearing || 0) : 0;
    const camera = computeCamera(mode, center, zoom, pitch, bear, FOV_RAD, viewport);

    /* Un-project screen point to the z = 0 ground plane */
    const wp = screenToWorld(sx, sy, camera);
    if (!wp) return null;

    return worldToLngLat(wp[0], wp[1], camera.worldSize);
}

/**
 * Subscribes to pointer events on the map container: coordinates, selection, hover, context menu.
 *
 * Includes throttled mouse coordinate tracking (previously in useCanvasMap)
 * that converts screen position to lnglat via camera un-projection and
 * updates statusStore at most every {@link COORD_THROTTLE_MS}.
 *
 * @param containerRef - Map surface element (must be non-null for listeners to attach).
 * @returns Context menu position state and setter for programmatic closing.
 *
 * @stability experimental
 */
export function useMapEvents(containerRef: RefObject<HTMLDivElement | null>): {
    contextMenuPos: ContextMenuClientPos | null;
    setContextMenuPos: (pos: ContextMenuClientPos | null) => void;
    pointerClientPos: ContextMenuClientPos | null;
    contextMenuLngLat: [number, number] | null;
    closeContextMenu: () => void;
} {
    const activeTool = useMapStore((s) => s.activeTool);
    const addSelectedFeature = useSelectionStore((s) => s.addSelectedFeature);

    const [contextMenuPos, setContextMenuPosState] = useState<ContextMenuClientPos | null>(null);
    const [contextMenuLngLat, setContextMenuLngLat] = useState<[number, number] | null>(null);
    const pointerClientPosRef = useRef<ContextMenuClientPos | null>(null);

    /** Pending coordinate awaiting the next throttle flush. */
    const pendingCoordRef = useRef<[number, number] | null>(null);
    /** Timer id for the throttled coordinate flush. */
    const coordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const setContextMenuPos = useCallback((pos: ContextMenuClientPos | null) => {
        setContextMenuPosState(pos);
        if (pos === null) {
            setContextMenuLngLat(null);
        }
    }, []);

    const closeContextMenu = useCallback(() => {
        setContextMenuPosState(null);
        setContextMenuLngLat(null);
    }, []);

    const onMouseMove = useCallback(
        (e: MouseEvent) => {
            pointerClientPosRef.current = { x: e.clientX, y: e.clientY };

            /* Compute lnglat for status bar (throttled via pendingCoordRef) */
            const el = containerRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const lnglat = clientToLngLatCamera(rect, e.clientX, e.clientY);
            if (lnglat) {
                pendingCoordRef.current = lnglat;
            }
        },
        [containerRef],
    );

    const onMouseLeave = useCallback(() => {
        pointerClientPosRef.current = null;
        pendingCoordRef.current = null;
        useStatusStore.getState().setMouseCoord(null);
    }, []);

    const onClick = useCallback(
        (e: MouseEvent) => {
            const el = containerRef.current;
            if (!el) return;
            if (activeTool !== 'select-click') return;
            const rect = el.getBoundingClientRect();
            const lnglat = clientToLngLatCamera(rect, e.clientX, e.clientY);
            if (!lnglat) return;
            const seq = Date.now();
            addSelectedFeature(createMockFeature(lnglat[0], lnglat[1], seq));
        },
        [activeTool, addSelectedFeature, containerRef],
    );

    const onContextMenu = useCallback(
        (e: MouseEvent) => {
            e.preventDefault();
            const el = containerRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const lnglat = clientToLngLatCamera(rect, e.clientX, e.clientY);
            setContextMenuPosState({ x: e.clientX, y: e.clientY });
            setContextMenuLngLat(lnglat);
        },
        [containerRef],
    );

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        el.addEventListener('mousemove', onMouseMove);
        el.addEventListener('mouseleave', onMouseLeave);
        el.addEventListener('click', onClick);
        el.addEventListener('contextmenu', onContextMenu);

        /* Throttled coordinate flush — writes pending lnglat to statusStore */
        coordTimerRef.current = setInterval(() => {
            const c = pendingCoordRef.current;
            if (c) {
                useStatusStore.getState().setMouseCoord(c);
                pendingCoordRef.current = null;
            }
        }, COORD_THROTTLE_MS);

        return () => {
            el.removeEventListener('mousemove', onMouseMove);
            el.removeEventListener('mouseleave', onMouseLeave);
            el.removeEventListener('click', onClick);
            el.removeEventListener('contextmenu', onContextMenu);
            if (coordTimerRef.current) clearInterval(coordTimerRef.current);
        };
    }, [containerRef, onClick, onContextMenu, onMouseLeave, onMouseMove, activeTool]);

    return {
        contextMenuPos,
        setContextMenuPos,
        pointerClientPos: pointerClientPosRef.current,
        contextMenuLngLat,
        closeContextMenu,
    };
}
