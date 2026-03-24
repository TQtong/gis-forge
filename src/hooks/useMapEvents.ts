import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Feature } from '@/types';
import { useMapStore } from '@/stores/mapStore';
import { useSelectionStore } from '@/stores/selectionStore';
import { useStatusStore } from '@/stores/statusStore';

/**
 * Client-space position for context menus.
 */
export type ContextMenuClientPos = { x: number; y: number };

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
 * Maps client coordinates inside the container to mock WGS84 lon/lat (until engine wiring).
 */
function clientToLngLat(
    container: HTMLDivElement,
    clientX: number,
    clientY: number,
): [number, number] {
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const nx = rect.width > 0 ? x / rect.width : 0;
    const ny = rect.height > 0 ? y / rect.height : 0;
    const lng = 70 + nx * 50;
    const lat = 55 - ny * 35;
    return [lng, lat];
}

/**
 * Subscribes to pointer events on the map container: coordinates, selection, hover, context menu.
 *
 * @param containerRef - Map surface element (must be non-null for listeners to attach).
 * @returns Context menu position state and setter for programmatic closing.
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
        },
        [],
    );

    const onMouseLeave = useCallback(() => {
        pointerClientPosRef.current = null;
        useStatusStore.getState().setMouseCoord(null);
    }, []);

    const onClick = useCallback(
        (e: MouseEvent) => {
            const el = containerRef.current;
            if (!el) return;
            if (activeTool !== 'select-click') return;
            const [lng, lat] = clientToLngLat(el, e.clientX, e.clientY);
            const seq = Date.now();
            addSelectedFeature(createMockFeature(lng, lat, seq));
        },
        [activeTool, addSelectedFeature, containerRef],
    );

    const onContextMenu = useCallback(
        (e: MouseEvent) => {
            e.preventDefault();
            const el = containerRef.current;
            if (!el) return;
            const [lng, lat] = clientToLngLat(el, e.clientX, e.clientY);
            setContextMenuPosState({ x: e.clientX, y: e.clientY });
            setContextMenuLngLat([lng, lat]);
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
        return () => {
            el.removeEventListener('mousemove', onMouseMove);
            el.removeEventListener('mouseleave', onMouseLeave);
            el.removeEventListener('click', onClick);
            el.removeEventListener('contextmenu', onContextMenu);
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
