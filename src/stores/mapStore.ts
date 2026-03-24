import { create } from 'zustand';
import type { Annotation, ToolType } from '@/types';
import { useStatusStore } from '@/stores/statusStore';

/** Map view mode shown in the toolbar switcher (2D / 2.5D / Globe). */
export type MapViewMode = '2d' | '2.5d' | 'globe';

/** Inclusive zoom bounds for UI clamping (typical web map range). */
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;

/**
 * Map shell state: camera, interaction tool, and navigation helpers.
 */
interface MapState {
    /** Current view mode (2D / 2.5D / Globe). */
    mode: MapViewMode;
    /** Active interaction tool (pan, selection modes, draw, measure). */
    activeTool: ToolType;
    /** Map center `[longitude, latitude]` in degrees (WGS84). */
    center: [number, number];
    /** Zoom level (tile-like scale). */
    zoom: number;
    /** Map rotation about the vertical axis in radians (0 = north up). */
    bearing: number;
    /** Camera tilt in radians; 0 = top-down (2D). */
    pitch: number;
    /** User drawings and measurements persisted in the shell (engine may mirror). */
    annotations: Annotation[];
    /** Sets view mode from the toolbar. */
    setMode: (mode: MapViewMode) => void;
    /** Sets active tool from toolbar or shortcuts. */
    setActiveTool: (tool: ToolType) => void;
    /**
     * Navigates the map to a geographic center and optional zoom.
     * Engine integration will replace this implementation.
     *
     * @param center - Destination center in degrees `[lng, lat]`.
     * @param zoom - Optional zoom level; keeps current zoom when omitted.
     */
    flyTo: (center: [number, number], zoom?: number) => void;
    /** Sets map bearing in radians and mirrors to `statusStore` for compass UI. */
    setBearing: (bearing: number) => void;
    /** Sets zoom level, clamped to [0, 22]. */
    setZoom: (zoom: number) => void;
    /** Adds delta to zoom (e.g. +/-1 from buttons), clamped to [0, 22]. */
    adjustZoom: (delta: number) => void;
    /** Appends a user annotation (draw/measure output). */
    addAnnotation: (annotation: Annotation) => void;
}

/**
 * Zustand store for map view mode, active tool, and camera navigation.
 */
function clampZoom(value: number): number {
    if (!Number.isFinite(value)) {
        return MIN_ZOOM;
    }
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export const useMapStore = create<MapState>((set) => ({
    mode: '2d',
    activeTool: 'pan',
    center: [116.391, 39.907],
    zoom: 12,
    bearing: 0,
    pitch: 0,
    annotations: [],
    setMode: (mode) => {
        if (mode === '2d') {
            set({ mode, bearing: 0, pitch: 0 });
            useStatusStore.getState().setBearing(0);
        } else {
            set({ mode });
        }
    },
    setActiveTool: (activeTool) => set({ activeTool }),
    flyTo: (center, zoom) =>
        set((s) => ({
            center,
            zoom: zoom !== undefined ? zoom : s.zoom,
        })),
    setBearing: (bearing) => {
        const b = Number.isFinite(bearing) ? bearing : 0;
        set({ bearing: b });
        useStatusStore.getState().setBearing(b);
    },
    setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
    adjustZoom: (delta) =>
        set((s) => ({
            zoom: clampZoom(s.zoom + (Number.isFinite(delta) ? delta : 0)),
        })),
    addAnnotation: (annotation) =>
        set((s) => ({ annotations: [...s.annotations, annotation] })),
}));
