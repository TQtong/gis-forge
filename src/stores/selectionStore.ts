import { create } from 'zustand';
import type { Feature } from '@/types';

/**
 * Selection and hover state for identify, multi-select, and feature popup.
 */
export interface SelectionState {
    /** Features currently selected in the map document (order preserved). */
    selectedFeatures: Feature[];
    /** Feature under the cursor for hover popup; null when nothing is hovered. */
    hoveredFeature: Feature | null;
    /** Replaces the entire selection set (deduplication is caller responsibility). */
    setSelectedFeatures: (f: Feature[]) => void;
    /** Appends a feature if its id is not already selected. */
    addSelectedFeature: (f: Feature) => void;
    /** Removes a feature from the selection by id. */
    removeSelectedFeature: (id: string | number) => void;
    /** Clears all selected features. */
    clearSelection: () => void;
    /** Updates hover highlight and popup source. */
    setHoveredFeature: (f: Feature | null) => void;
}

/**
 * Zustand store for feature selection and hover (property panel + popup).
 */
export const useSelectionStore = create<SelectionState>((set) => ({
    selectedFeatures: [],
    hoveredFeature: null,
    setSelectedFeatures: (selectedFeatures) => set({ selectedFeatures }),
    addSelectedFeature: (f) =>
        set((s) => {
            const exists = s.selectedFeatures.some((x) => x.id === f.id);
            if (exists) return s;
            return { selectedFeatures: [...s.selectedFeatures, f] };
        }),
    removeSelectedFeature: (id) =>
        set((s) => ({
            selectedFeatures: s.selectedFeatures.filter((x) => x.id !== id),
        })),
    clearSelection: () => set({ selectedFeatures: [] }),
    setHoveredFeature: (hoveredFeature) => set({ hoveredFeature }),
}));
