import { useAnalysisStore } from '@/stores/analysisStore';
import { useCallback, useEffect, useRef } from 'react';

/** Duration of the simulated progress ramp in milliseconds. */
const SIMULATED_ANALYSIS_MS = 2000;

/**
 * Bridge hook for running analysis jobs with simulated 0→100% progress over 2 seconds.
 *
 * @returns Running state, progress, error, `runAnalysis`, and `cancel`.
 */
export function useAnalysis() {
  const isRunning = useAnalysisStore((s) => s.isRunning);
  const progress = useAnalysisStore((s) => s.progress);
  const error = useAnalysisStore((s) => s.error);
  const startAnalysis = useAnalysisStore((s) => s.startAnalysis);
  const setProgress = useAnalysisStore((s) => s.setProgress);
  const finishAnalysis = useAnalysisStore((s) => s.finishAnalysis);
  const cancelAnalysis = useAnalysisStore((s) => s.cancelAnalysis);
  const setError = useAnalysisStore((s) => s.setError);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  /**
   * Starts a simulated analysis: progress moves from 0 to 100 over {@link SIMULATED_ANALYSIS_MS}, then finishes.
   * Params are accepted for future engine integration; currently stored only in the call signature.
   *
   * @param type - Analysis key (e.g. `buffer`, `overlay`).
   * @param params - Tool-specific parameters (forwarded to engine later).
   */
  const runAnalysis = useCallback(
    (type: string, params: Record<string, any>) => {
      void params;
      clearTimer();
      setError(null);
      startAnalysis(type);
      const startedAt = Date.now();
      intervalRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const ratio = Math.min(1, elapsed / SIMULATED_ANALYSIS_MS);
        const p = Math.min(100, Math.round(ratio * 100));
        setProgress(p);
        if (p >= 100) {
          clearTimer();
          finishAnalysis();
        }
      }, 32);
    },
    [clearTimer, finishAnalysis, setError, setProgress, startAnalysis],
  );

  /**
   * Stops the simulated timer and resets analysis state without completing successfully.
   */
  const cancel = useCallback(() => {
    clearTimer();
    cancelAnalysis();
  }, [cancelAnalysis, clearTimer]);

  return {
    isRunning,
    progress,
    error,
    runAnalysis,
    cancel,
  };
}
