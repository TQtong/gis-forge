import { create } from 'zustand';
import { DEFAULT_LAYER_GROUPS } from '@/data/defaultConfig';
import type { LayerConfig, LayerGroup } from '@/types';

/**
 * Layer tree state: grouped layers, selection for the style editor, and CRUD helpers.
 */
interface LayerState {
  /** Layer groups shown in the panel (basemap, vector, overlay, analysis). */
  groups: LayerGroup[];
  /** Selected layer id for the properties/style panel; null if none. */
  selectedLayerId: string | null;
  /** Replace the entire group list (e.g. after loading a project). */
  setGroups: (g: LayerGroup[]) => void;
  /** Append one group at the end of the list. */
  addGroup: (g: LayerGroup) => void;
  /** Toggle collapsed flag for a group by id; no-op if id is missing. */
  toggleGroupCollapsed: (groupId: string) => void;
  /** Append a layer to the group with the given id; no-op if group is missing. */
  addLayer: (groupId: string, layer: LayerConfig) => void;
  /** Remove a layer from whichever group contains it; no-op if not found. */
  removeLayer: (layerId: string) => void;
  /** Shallow-merge fields into the layer with the given id; no-op if not found. */
  updateLayer: (layerId: string, patch: Partial<LayerConfig>) => void;
  /** Set `visible` on a layer; no-op if not found. */
  setLayerVisibility: (layerId: string, visible: boolean) => void;
  /** Set `opacity`, clamped to [0, 1]; no-op if not found. */
  setLayerOpacity: (layerId: string, opacity: number) => void;
  /**
   * Move a layer between groups or reorder within the same group.
   * `newIndex` is the insertion index in the target group's layer array after removal from the source.
   */
  moveLayer: (
    fromGroupId: string,
    toGroupId: string,
    layerId: string,
    newIndex: number,
  ) => void;
  /** Reorder layers in a group to match the order of `layerIds` (unknown ids skipped). */
  reorderLayers: (groupId: string, layerIds: string[]) => void;
  /** Set or clear the selected layer id. */
  setSelectedLayerId: (id: string | null) => void;
  /** Return a flat array of all layers in group order. */
  getAllLayers: () => LayerConfig[];
  /** Find a layer by id across all groups. */
  getLayerById: (id: string) => LayerConfig | undefined;
}

/**
 * Clamp a number to the inclusive range [0, 1], handling NaN by falling back to 0.
 *
 * @param value - Raw opacity value.
 * @returns A finite number in [0, 1].
 */
function clampOpacity(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Zustand store: layer groups and style-editor selection.
 * @stability experimental
 */
/** Deep-clone default groups so the store never mutates the exported `DEFAULT_LAYER_GROUPS` reference. */
function cloneDefaultGroups(): LayerGroup[] {
  return DEFAULT_LAYER_GROUPS.map((g) => ({
    ...g,
    layers: g.layers.map((l) => ({ ...l })),
  }));
}

export const useLayerStore = create<LayerState>()((set, get) => ({
  groups: cloneDefaultGroups(),
  selectedLayerId: null,

  setGroups: (g) => {
    set({ groups: g });
  },

  addGroup: (g) => {
    set((state) => ({ groups: [...state.groups, g] }));
  },

  toggleGroupCollapsed: (groupId) => {
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId ? { ...group, collapsed: !group.collapsed } : group,
      ),
    }));
  },

  addLayer: (groupId, layer) => {
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId ? { ...group, layers: [...group.layers, layer] } : group,
      ),
    }));
  },

  removeLayer: (layerId) => {
    set((state) => ({
      groups: state.groups.map((group) => ({
        ...group,
        layers: group.layers.filter((l) => l.id !== layerId),
      })),
    }));
  },

  updateLayer: (layerId, patch) => {
    set((state) => ({
      groups: state.groups.map((group) => ({
        ...group,
        layers: group.layers.map((l) =>
          l.id === layerId ? { ...l, ...patch } : l,
        ),
      })),
    }));
  },

  setLayerVisibility: (layerId, visible) => {
    get().updateLayer(layerId, { visible });
  },

  setLayerOpacity: (layerId, opacity) => {
    get().updateLayer(layerId, { opacity: clampOpacity(opacity) });
  },

  moveLayer: (fromGroupId, toGroupId, layerId, newIndex) => {
    set((state) => {
      const groups = state.groups.map((g) => ({
        ...g,
        layers: [...g.layers],
      }));

      const fromGroup = groups.find((g) => g.id === fromGroupId);
      const toGroup = groups.find((g) => g.id === toGroupId);
      if (!fromGroup || !toGroup) {
        return state;
      }

      const fromIndex = fromGroup.layers.findIndex((l) => l.id === layerId);
      if (fromIndex === -1) {
        return state;
      }

      const [moved] = fromGroup.layers.splice(fromIndex, 1);
      const maxInsert = toGroup.layers.length;
      const idx = Math.max(0, Math.min(newIndex, maxInsert));
      toGroup.layers.splice(idx, 0, moved);

      return { groups };
    });
  },

  reorderLayers: (groupId, layerIds) => {
    set((state) => ({
      groups: state.groups.map((group) => {
        if (group.id !== groupId) {
          return group;
        }
        const byId = new Map(group.layers.map((l) => [l.id, l] as const));
        const ordered: LayerConfig[] = [];
        for (const id of layerIds) {
          const layer = byId.get(id);
          if (layer) {
            ordered.push(layer);
          }
        }
        for (const l of group.layers) {
          if (!layerIds.includes(l.id)) {
            ordered.push(l);
          }
        }
        return { ...group, layers: ordered };
      }),
    }));
  },

  setSelectedLayerId: (id) => {
    set({ selectedLayerId: id });
  },

  getAllLayers: () => {
    const { groups } = get();
    const out: LayerConfig[] = [];
    for (const g of groups) {
      out.push(...g.layers);
    }
    return out;
  },

  getLayerById: (id) => {
    for (const g of get().groups) {
      const found = g.layers.find((l) => l.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  },
}));
