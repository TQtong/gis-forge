import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Pause, Play } from 'lucide-react';

/**
 * Props for the temporal slider bar (conditionally shown when time-enabled data exists).
 */
export interface TimeSliderProps {
  /** When false, nothing is rendered. */
  visible: boolean;
  /** Minimum time (Unix ms or ordinal; displayed via `Date`). */
  minTime: number;
  /** Maximum time (same unit as `minTime`). */
  maxTime: number;
  /** Controlled current time. */
  currentTime: number;
  /** Invoked when the user scrubs or playback advances time. */
  onChange: (time: number) => void;
}

/** Playback speed multipliers exposed in the UI. */
const SPEED_STEPS = [1, 2, 4] as const;

/** Wall-clock interval between playback ticks (ms). */
const PLAYBACK_TICK_MS = 250;

/**
 * Bottom time slider with play/pause, scrubber, range labels, and speed control.
 *
 * @param props - Visibility, bounds, value, and change handler.
 * @returns Bar UI or null when not visible.
 */
export function TimeSlider(props: TimeSliderProps): ReactElement | null {
  const { visible, minTime, maxTime, currentTime, onChange } = props;

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEED_STEPS)[number]>(1);
  const timeRef = useRef(currentTime);

  useEffect(() => {
    timeRef.current = currentTime;
  }, [currentTime]);

  const safeMin = useMemo(() => {
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
      return 0;
    }
    return Math.min(minTime, maxTime);
  }, [minTime, maxTime]);

  const safeMax = useMemo(() => {
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
      return 1;
    }
    return Math.max(minTime, maxTime);
  }, [minTime, maxTime]);

  const span = safeMax - safeMin || 1;

  const labelStart = useMemo(() => {
    try {
      return new Date(safeMin).toLocaleString();
    } catch {
      return String(safeMin);
    }
  }, [safeMin]);

  const labelEnd = useMemo(() => {
    try {
      return new Date(safeMax).toLocaleString();
    } catch {
      return String(safeMax);
    }
  }, [safeMax]);

  const labelCurrent = useMemo(() => {
    try {
      return new Date(currentTime).toLocaleString();
    } catch {
      return String(currentTime);
    }
  }, [currentTime]);

  useEffect(() => {
    if (!playing || !visible) {
      return;
    }
    const id = window.setInterval(() => {
      const step = (span / 200) * speed;
      const next = Math.min(safeMax, timeRef.current + step);
      timeRef.current = next;
      onChange(next);
      if (next >= safeMax) {
        setPlaying(false);
      }
    }, PLAYBACK_TICK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [playing, visible, onChange, safeMax, span, speed]);

  if (!visible) {
    return null;
  }

  const ratio = (currentTime - safeMin) / span;
  const sliderValue = Number.isFinite(ratio) ? Math.min(100, Math.max(0, ratio * 100)) : 0;

  return (
    <div
      className="pointer-events-auto absolute bottom-0 left-0 right-0 z-20 flex h-12 items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-panel)]/90 px-3 backdrop-blur-sm"
      role="region"
      aria-label="时间轴"
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        aria-label={playing ? '暂停' : '播放'}
        onClick={() => {
          setPlaying((p) => !p);
        }}
      >
        {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          type="range"
          className="h-2 w-full cursor-pointer accent-[var(--accent)]"
          min={0}
          max={100}
          step={0.1}
          value={sliderValue}
          aria-valuemin={safeMin}
          aria-valuemax={safeMax}
          aria-valuenow={currentTime}
          aria-label="当前时间"
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            const t = safeMin + (v / 100) * span;
            timeRef.current = t;
            onChange(t);
          }}
        />
        <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
          <span className="truncate pr-1">{labelStart}</span>
          <span className="truncate pl-1 text-right">{labelEnd}</span>
        </div>
      </div>

      <span className="shrink-0 text-[10px] text-[var(--text-secondary)] tabular-nums">{labelCurrent}</span>

      <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--text-muted)]">
        <span className="sr-only">播放速度</span>
        <select
          className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-[var(--text-primary)]"
          value={speed}
          aria-label="播放速度"
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10);
            if (v === 1 || v === 2 || v === 4) {
              setSpeed(v);
            }
          }}
        >
          {SPEED_STEPS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
