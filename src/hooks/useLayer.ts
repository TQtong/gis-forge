import { useCallback, useMemo } from 'react';
import { useLayerStore } from '@/stores/layerStore';
import type { LayerConfig } from '@/types';

/**
 * Per-layer selectors and action wrappers for tree rows and inspectors.
 *
 * @param layerId - Target layer id; if missing in the document, `layer` is undefined.
 * @returns Layer snapshot, selection flag, and imperative helpers.
 */
export function useLayer(layerId: string): {
  /** Current layer config, if present. */
  layer: LayerConfig | undefined;
  /** True when this layer is selected for the style panel. */
  isSelected: boolean;
  /** Sets visibility flag. */
  setVisibility: (visible: boolean) => void;
  /** Sets opacity in [0, 1]. */
  setOpacity: (opacity: number) => void;
  /** Removes the layer from its group. */
  remove: () => void;
  /** Selects this layer for editing. */
  select: () => void;
  /** Fits the map view to the layer extent when the engine exposes bounds (placeholder). */
  zoomTo: () => void;
} {
  const layer = useLayerStore((s) => s.getLayerById(layerId));
  const isSelected = useLayerStore((s) => s.selectedLayerId === layerId);
  const setLayerVisibility = useLayerStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useLayerStore((s) => s.setLayerOpacity);
  const removeLayer = useLayerStore((s) => s.removeLayer);
  const setSelectedLayerId = useLayerStore((s) => s.setSelectedLayerId);

  const setVisibility = useCallback(
    (visible: boolean) => {
      setLayerVisibility(layerId, visible);
    },
    [layerId, setLayerVisibility],
  );

  const setOpacity = useCallback(
    (opacity: number) => {
      setLayerOpacity(layerId, opacity);
    },
    [layerId, setLayerOpacity],
  );

  const remove = useCallback(() => {
    removeLayer(layerId);
  }, [layerId, removeLayer]);

  const select = useCallback(() => {
    setSelectedLayerId(layerId);
  }, [layerId, setSelectedLayerId]);

  const zoomTo = useCallback(() => {
    if (!layer) {
      return;
    }
    // Engine hook: call MapViewport.fitBounds when layer metadata exposes an extent.
    void layerId;
  }, [layer, layerId]);

  return useMemo(
    () => ({
      layer,
      isSelected,
      setVisibility,
      setOpacity,
      remove,
      select,
      zoomTo,
    }),
    [isSelected, layer, remove, select, setOpacity, setVisibility, zoomTo],
  );
}
