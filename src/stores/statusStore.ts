import { create } from 'zustand';

/**
 * Runtime status line metrics for the bottom status bar.
 */
interface StatusState {
    /**
     * Cursor position `[longitude, latitude]` in degrees (WGS84), or null when unknown.
     */
    mouseCoord: [number, number] | null;
    /** Map rotation about the vertical axis in radians (0 = north up); mirrored from map for compass UI. */
    bearing: number;
    /** Current zoom level (engine-defined). */
    zoom: number;
    /** Number of loaded or visible tiles. */
    tiles: number;
    /** Frames per second (rolling or instantaneous). */
    fps: number;
    /** Estimated JS/GPU memory usage in megabytes. */
    memory: number;
    /** Updates cursor position from map pointer events or engine. */
    setMouseCoord: (value: [number, number] | null) => void;
    /** Updates map bearing for compass and overlays (radians). */
    setBearing: (value: number) => void;
    /** Updates zoom for status display. */
    setZoom: (value: number) => void;
    /** Updates tile count for status display. */
    setTiles: (value: number) => void;
    /** Updates FPS for status display. */
    setFps: (value: number) => void;
    /** Updates memory estimate for status display. */
    setMemory: (value: number) => void;
}

/**
 * Zustand store for status bar metrics (coordinates, performance).
 */
export const useStatusStore = create<StatusState>((set) => ({
    mouseCoord: null,
    bearing: 0,
    zoom: 0,
    tiles: 0,
    fps: 0,
    memory: 0,
    setMouseCoord: (mouseCoord) => set({ mouseCoord }),
    setBearing: (bearing) => set({ bearing }),
    setZoom: (zoom) => set({ zoom }),
    setTiles: (tiles) => set({ tiles }),
    setFps: (fps) => set({ fps }),
    setMemory: (memory) => set({ memory }),
}));
