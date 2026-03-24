import { useCallback, useMemo } from 'react';
import type { Annotation, HistoryEntry, HistoryEntryKind, LayerConfig } from '@/types';
import { useAnnotationStore } from '@/stores/annotationStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLayerStore } from '@/stores/layerStore';
import { createHistoryEntry } from '@/utils/historyManager';

/**
 * Applies the inverse of a history entry (best-effort by `type` / `data`).
 *
 * @param entry - Entry that was just popped from the undo stack.
 */
function applyReverse(entry: HistoryEntry): void {
  const data = entry.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') {
    return;
  }
  switch (entry.type) {
    case 'annotation':
    case 'draw': {
      const op = data.op as string | undefined;
      const ann = data.annotation as { id?: string } | undefined;
      if (op === 'add' && ann?.id) {
        useAnnotationStore.getState().removeAnnotation(ann.id);
      }
      if (op === 'remove' && ann) {
        useAnnotationStore.getState().addAnnotation(ann as Annotation);
      }
      break;
    }
    case 'add-layer': {
      const layerId = data.layerId as string | undefined;
      if (layerId) {
        useLayerStore.getState().removeLayer(layerId);
      }
      break;
    }
    case 'remove-layer': {
      const layer = data.layer as LayerConfig | undefined;
      const groupId = data.groupId as string | undefined;
      if (layer && groupId) {
        useLayerStore.getState().addLayer(groupId, layer);
      }
      break;
    }
    case 'style-change': {
      const layerId = data.layerId as string | undefined;
      const previousPaint = data.previousPaint as LayerConfig['paint'] | undefined;
      if (layerId && previousPaint) {
        useLayerStore.getState().updateLayer(layerId, { paint: previousPaint });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Re-applies a history entry after redo.
 *
 * @param entry - Entry that was popped from the redo stack.
 */
function applyForward(entry: HistoryEntry): void {
  const data = entry.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') {
    return;
  }
  switch (entry.type) {
    case 'annotation':
    case 'draw': {
      const op = data.op as string | undefined;
      const ann = data.annotation as Annotation | undefined;
      if (op === 'add' && ann) {
        useAnnotationStore.getState().addAnnotation(ann);
      }
      if (op === 'remove' && ann?.id) {
        useAnnotationStore.getState().removeAnnotation(ann.id);
      }
      break;
    }
    case 'add-layer': {
      const layer = data.layer as LayerConfig | undefined;
      const groupId = data.groupId as string | undefined;
      if (layer && groupId) {
        useLayerStore.getState().addLayer(groupId, layer);
      }
      break;
    }
    case 'remove-layer': {
      const layerId = data.layerId as string | undefined;
      if (layerId) {
        useLayerStore.getState().removeLayer(layerId);
      }
      break;
    }
    case 'style-change': {
      const layerId = data.layerId as string | undefined;
      const nextPaint = data.nextPaint as LayerConfig['paint'] | undefined;
      if (layerId && nextPaint) {
        useLayerStore.getState().updateLayer(layerId, { paint: nextPaint });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Undo/redo helpers bound to the global history store with apply/reapply hooks.
 *
 * @returns Flags, stack snapshot, and mutation helpers.
 */
export function useHistory() {
  const undoStack = useHistoryStore((s) => s.undoStack);
  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);
  const pushEntry = useHistoryStore((s) => s.pushEntry);
  const storeUndo = useHistoryStore((s) => s.undo);
  const storeRedo = useHistoryStore((s) => s.redo);

  const pushAction = useCallback(
    (type: HistoryEntryKind, description: string, data: unknown) => {
      const entry = createHistoryEntry(type, description, data);
      pushEntry(entry);
    },
    [pushEntry],
  );

  const undo = useCallback(() => {
    const entry = storeUndo();
    if (entry) {
      applyReverse(entry);
    }
    return entry;
  }, [storeUndo]);

  const redo = useCallback(() => {
    const entry = storeRedo();
    if (entry) {
      applyForward(entry);
    }
    return entry;
  }, [storeRedo]);

  return useMemo(
    () => ({
      canUndo,
      canRedo,
      pushAction,
      undo,
      redo,
      entries: undoStack,
    }),
    [canUndo, canRedo, pushAction, undo, redo, undoStack],
  );
}
