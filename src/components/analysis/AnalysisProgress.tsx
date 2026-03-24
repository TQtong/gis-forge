import type { ReactElement } from 'react';

/**
 * Props for the linear progress indicator used during simulated geoprocessing.
 */
export interface AnalysisProgressProps {
  /** Completion percentage in [0, 100]. */
  progress: number;
  /** Optional total feature count for status text. */
  total?: number;
  /** Optional current feature index for status text. */
  current?: number;
  /** Optional label prefix or override for accessibility. */
  label?: string;
}

/**
 * Thin progress bar with optional “current/total” copy; visible only while 0 < progress < 100.
 *
 * @param props - Progress value and optional counters.
 * @returns Bar + status line, or `null` when not in the active range.
 */
export function AnalysisProgress(props: AnalysisProgressProps): ReactElement | null {
  const { progress, total, current, label } = props;
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  if (p <= 0 || p >= 100) {
    return null;
  }

  const hasCounts =
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0 &&
    typeof current === 'number' &&
    Number.isFinite(current);

  const text = hasCounts
    ? `⏳ 执行中... 处理 ${current}/${total} 要素 (${p}%)`
    : label
      ? `${label} (${p}%)`
      : `${p}%`;

  return (
    <div className="flex flex-col gap-1 pt-2" role="status" aria-live="polite">
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
          style={{ width: `${p}%` }}
        />
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{text}</p>
    </div>
  );
}
