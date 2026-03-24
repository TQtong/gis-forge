import { create } from 'zustand';

/**
 * Runtime state for the simulated analysis pipeline (progress, errors, active tool key).
 */
export interface AnalysisState {
  /** Current analysis tool key (e.g. `buffer`), or `null` when idle. */
  activeAnalysis: string | null;
  /** Simulated completion percentage in [0, 100]. */
  progress: number;
  /** True while a simulated run is in progress. */
  isRunning: boolean;
  /** Last error message from the analysis UI or engine bridge; `null` when none. */
  error: string | null;
  /** Marks the start of an analysis run for `type` and resets progress. */
  startAnalysis: (type: string) => void;
  /** Updates simulated progress (0–100). */
  setProgress: (p: number) => void;
  /** Completes the current run and returns to idle. */
  finishAnalysis: () => void;
  /** Aborts the current run and clears progress. */
  cancelAnalysis: () => void;
  /** Sets or clears the error string shown in the analysis hook UI. */
  setError: (e: string | null) => void;
}

/**
 * Zustand store backing `useAnalysis`: progress simulation and error surface.
 *
 * @stability experimental
 */
export const useAnalysisStore = create<AnalysisState>((set) => ({
  activeAnalysis: null,
  progress: 0,
  isRunning: false,
  error: null,

  startAnalysis: (type) => {
    set({
      activeAnalysis: type,
      isRunning: true,
      progress: 0,
      error: null,
    });
  },

  setProgress: (p) => {
    const next = Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
    set({ progress: next });
  },

  finishAnalysis: () => {
    set({
      activeAnalysis: null,
      isRunning: false,
      progress: 0,
      error: null,
    });
  },

  cancelAnalysis: () => {
    set({
      activeAnalysis: null,
      isRunning: false,
      progress: 0,
    });
  },

  setError: (e) => {
    set({ error: e });
  },
}));
