import { useLayerStore } from '@/stores/layerStore';
import type { LayerConfig } from '@/types';

/**
 * Merge keys into the target layer's `paint` using the latest store snapshot (avoids stale closures).
 *
 * @param layerId - Layer id to update.
 * @param patch - Paint keys to merge.
 */
export function patchLayerPaint(layerId: string, patch: Record<string, unknown>): void {
  const layer = useLayerStore.getState().getLayerById(layerId);
  if (!layer) {
    return;
  }
  useLayerStore.getState().updateLayer(layerId, {
    paint: { ...layer.paint, ...patch },
  });
}

/**
 * Merge keys into the target layer's `layout` using the latest store snapshot.
 *
 * @param layerId - Layer id to update.
 * @param patch - Layout keys to merge.
 */
export function patchLayerLayout(layerId: string, patch: Record<string, unknown>): void {
  const layer = useLayerStore.getState().getLayerById(layerId);
  if (!layer) {
    return;
  }
  useLayerStore.getState().updateLayer(layerId, {
    layout: { ...layer.layout, ...patch },
  });
}

/**
 * Convenience: merge paint for a layer referenced by {@link LayerConfig}.
 *
 * @param layer - Current layer config (uses `layer.id`).
 * @param patch - Paint patch.
 */
export function patchPaint(layer: LayerConfig, patch: Record<string, unknown>): void {
  patchLayerPaint(layer.id, patch);
}

/**
 * Convenience: merge layout for a layer referenced by {@link LayerConfig}.
 *
 * @param layer - Current layer config (uses `layer.id`).
 * @param patch - Layout patch.
 */
export function patchLayout(layer: LayerConfig, patch: Record<string, unknown>): void {
  patchLayerLayout(layer.id, patch);
}

/**
 * Remove a single key from the layer's `paint` object (used to clear optional props).
 *
 * @param layerId - Target layer id.
 * @param key - Paint property key to delete.
 */
export function removePaintKey(layerId: string, key: string): void {
  const layer = useLayerStore.getState().getLayerById(layerId);
  if (!layer) {
    return;
  }
  const next = { ...layer.paint };
  delete next[key];
  useLayerStore.getState().updateLayer(layerId, { paint: next });
}
