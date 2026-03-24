import { useEffect, useRef } from 'react';
import type { MapViewState } from '@/types';
import type { MapViewMode } from '@/stores/mapStore';
import { useLayerStore } from '@/stores/layerStore';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';
import {
  decodeLayersFromHash,
  decodeMapState,
  encodeLayerState,
  encodeMapState,
} from '@/utils/urlState';

/** Debounce delay for writing the URL hash after store changes (ms). */
const HASH_WRITE_DEBOUNCE_MS = 500;

/**
 * Maps URL `MapViewState.mode` (`25d`) to the map store camera mode (`2.5d`).
 *
 * @param mode - Mode from decoded URL / {@link MapViewState}.
 * @returns Store mode or undefined when input is undefined.
 */
function urlModeToStore(mode: MapViewState['mode'] | undefined): MapViewMode | undefined {
  if (mode === undefined) {
    return undefined;
  }
  if (mode === '25d') {
    return '2.5d';
  }
  if (mode === '2d' || mode === 'globe') {
    return mode;
  }
  return undefined;
}

/**
 * Maps store mode to URL `MapViewState.mode` (`2.5d` → `25d`).
 *
 * @param mode - Zustand map mode.
 * @returns Serializable mode for {@link MapViewState}.
 */
function storeModeToUrl(mode: MapViewMode): MapViewState['mode'] {
  if (mode === '2.5d') {
    return '25d';
  }
  return mode;
}

/**
 * Applies decoded map + layer ids to Zustand stores (best-effort, non-destructive for missing ids).
 *
 * @param map - Partial map view state from the hash.
 * @param layerIds - Layer ids that should be marked visible; others toggled off when non-empty.
 */
function applyDecodedToStores(
  map: Partial<MapViewState>,
  layerIds: string[],
): void {
  const current = useMapStore.getState();
  const hasMap =
    map.center !== undefined ||
    map.zoom !== undefined ||
    map.bearing !== undefined ||
    map.pitch !== undefined ||
    map.mode !== undefined;

  if (hasMap) {
    const nextMode = map.mode !== undefined ? urlModeToStore(map.mode) : undefined;
    const zoom =
      map.zoom !== undefined
        ? Math.min(22, Math.max(0, Number.isFinite(map.zoom) ? map.zoom : current.zoom))
        : current.zoom;
    const center = map.center ?? current.center;
    const bearing = map.bearing !== undefined ? map.bearing : current.bearing;
    const pitch = map.pitch !== undefined ? map.pitch : current.pitch;
    const mode = nextMode ?? current.mode;

    useMapStore.setState({
      center,
      zoom,
      bearing,
      pitch,
      mode,
    });
    const b = Number.isFinite(bearing) ? bearing : 0;
    useStatusStore.getState().setBearing(b);
  }

  if (layerIds.length > 0) {
    const layerStore = useLayerStore.getState();
    const idSet = new Set(layerIds);
    const groups = layerStore.groups.map((g) => ({
      ...g,
      layers: g.layers.map((l) => ({
        ...l,
        visible: idSet.has(l.id),
      })),
    }));
    layerStore.setGroups(groups);
  }
}

/**
 * Builds a {@link MapViewState} snapshot from the current map store for URL encoding.
 *
 * @returns Full map view state compatible with {@link encodeUrlState}.
 */
function snapshotMapViewState(): MapViewState {
  const s = useMapStore.getState();
  return {
    center: s.center,
    zoom: s.zoom,
    bearing: s.bearing,
    pitch: s.pitch,
    mode: storeModeToUrl(s.mode),
  };
}

/**
 * Serializes map view state into a hash query string (no `#`), using {@link encodeMapState}.
 *
 * @param state - Map view state to encode.
 * @returns Hash body without the leading `#`.
 */
export function encodeUrlState(state: MapViewState): string {
  return encodeMapState(state);
}

/**
 * Parses a hash string into partial {@link MapViewState} (bearing/pitch in radians internally).
 *
 * @param hash - `location.hash` or equivalent.
 * @returns Partial map view state.
 */
export function decodeUrlState(hash: string): Partial<MapViewState> {
  return decodeMapState(hash);
}

/**
 * Syncs map and visible layer ids with `location.hash`, reads hash on mount, and updates on `hashchange` / `popstate`.
 * Writes are debounced by {@link HASH_WRITE_DEBOUNCE_MS} when `useMapStore` or `useLayerStore` change.
 */
export function useUrlState(): void {
  const skipNextHashEvent = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const readAndApply = (rawHash: string): void => {
      const map = decodeUrlState(rawHash);
      const layerIds = decodeLayersFromHash(rawHash);
      const hasMapKeys =
        map.center !== undefined ||
        map.zoom !== undefined ||
        map.bearing !== undefined ||
        map.pitch !== undefined ||
        map.mode !== undefined;
      if (hasMapKeys || layerIds.length > 0) {
        applyDecodedToStores(map, layerIds);
      }
    };

    const initial = window.location.hash;
    if (initial && initial !== '#') {
      readAndApply(initial);
    }

    const onHashChange = (): void => {
      if (skipNextHashEvent.current) {
        skipNextHashEvent.current = false;
        return;
      }
      readAndApply(window.location.hash);
    };

    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);

    const scheduleWrite = (): void => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        const state = snapshotMapViewState();
        const mapPart = encodeUrlState(state);
        const visibleIds = useLayerStore
          .getState()
          .getAllLayers()
          .filter((l) => l.visible)
          .map((l) => l.id);
        const layerPart = encodeLayerState(visibleIds);
        const body = layerPart ? `${mapPart}&layers=${layerPart}` : mapPart;
        const next = body ? `#${body}` : '';
        if (window.location.hash !== next) {
          skipNextHashEvent.current = true;
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
        }
      }, HASH_WRITE_DEBOUNCE_MS);
    };

    const unsubMap = useMapStore.subscribe(scheduleWrite);
    const unsubLayers = useLayerStore.subscribe(scheduleWrite);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
      unsubMap();
      unsubLayers();
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);
}
