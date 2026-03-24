import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Boot phase for the GeoForge map shell: loading simulation, readiness, or WebGPU absence.
 * `error` is reserved for future engine failures (e.g. device lost) and is not set by the stub hook.
 */
export type GeoForgeMapStatus = 'loading' | 'ready' | 'error' | 'unsupported';

/**
 * Single initialization milestone shown beside the progress bar.
 */
export type GeoForgeInitStep = {
  /** Human-readable step label (GPU / shader / basemap). */
  label: string;
  /** True after this milestone is considered finished for the current boot sequence. */
  done: boolean;
};

/**
 * Return value of {@link useGeoForgeMap}: connection state plus simulated boot progress for the loading UI.
 */
export type UseGeoForgeMapResult = {
  /** Current lifecycle status of the map/engine attachment. */
  status: GeoForgeMapStatus;
  /** Simulated progress from 0–100 during `loading`; typically 100 when `ready`. */
  progress: number;
  /** Step list for the boot overlay (labels + completion flags). */
  steps: GeoForgeInitStep[];
};

const INIT_STEPS: GeoForgeInitStep[] = [
  { label: 'GPU 设备初始化', done: false },
  { label: 'Shader 编译', done: false },
  { label: '加载默认底图', done: false },
];

const PROGRESS_STEP_MS = 100;
const PROGRESS_DELTA = 5;

/**
 * Manages GeoForge engine lifecycle wiring for a map container ref.
 * Currently performs WebGPU availability checks and a deterministic 2s boot simulation; the ref is reserved for
 * future canvas/DOM attachment.
 *
 * @param containerRef - React ref to the map mount element (unused in the stub implementation).
 * @returns Status, numeric progress, and step checklist for the initialization overlay.
 *
 * @example
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const { status, progress, steps } = useGeoForgeMap(ref);
 * ```
 */
export function useGeoForgeMap(containerRef: RefObject<HTMLDivElement | null>): UseGeoForgeMapResult {
  const [status, setStatus] = useState<GeoForgeMapStatus>('loading');
  const [progress, setProgress] = useState(0);
  const [steps, setSteps] = useState<GeoForgeInitStep[]>(() => INIT_STEPS.map((s) => ({ ...s })));

  useEffect(() => {
    void containerRef;

    if (typeof navigator === 'undefined' || !navigator.gpu) {
      setStatus('unsupported');
      setProgress(0);
      setSteps(INIT_STEPS.map((s) => ({ ...s, done: false })));
      return;
    }

    setStatus('loading');
    setProgress(0);
    setSteps(INIT_STEPS.map((s) => ({ ...s, done: false })));

    let intervalId: ReturnType<typeof setInterval> | undefined;

    intervalId = setInterval(() => {
      setProgress((previous) => {
        const next = Math.min(100, previous + PROGRESS_DELTA);

        setSteps(
          INIT_STEPS.map((step, index) => {
            const threshold = index === 0 ? 30 : index === 1 ? 60 : 90;
            return {
              ...step,
              done: next >= threshold,
            };
          }),
        );

        if (next >= 100 && intervalId !== undefined) {
          clearInterval(intervalId);
          intervalId = undefined;
          setStatus('ready');
        }

        return next;
      });
    }, PROGRESS_STEP_MS);

    return () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [containerRef]);

  return { status, progress, steps };
}
