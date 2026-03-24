import type { ReactElement } from 'react';
import { Check, Loader2, Map } from 'lucide-react';

/**
 * Props for the full-screen GeoForge engine initialization overlay.
 */
export interface InitLoadingProps {
  /** Progress percentage from 0 through 100 (inclusive); values outside this range are clamped for display. */
  progress: number;
  /** Ordered boot steps; each entry includes a human-readable label and whether it has finished. */
  steps: Array<{ label: string; done: boolean }>;
}

/**
 * Full-screen loading screen displayed while the GeoForge engine initializes (GPU, shaders, basemap).
 * Centers branding, a determinate progress bar, and a per-step status list with Lucide icons.
 *
 * @param props - {@link InitLoadingProps}
 * @returns React element covering the viewport with theme CSS variables applied.
 *
 * @example
 * ```tsx
 * <InitLoading
 *   progress={42}
 *   steps={[
 *     { label: 'GPU 设备初始化', done: true },
 *     { label: 'Shader 编译', done: false },
 *     { label: '加载默认底图', done: false },
 *   ]}
 * />
 * ```
 */
export function InitLoading(props: InitLoadingProps): ReactElement {
  const { progress, steps } = props;
  const clamped = Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--bg-primary)] px-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="GeoForge 正在初始化"
    >
      <div className="mb-10 flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <Map className="h-12 w-12 shrink-0 text-[var(--accent)]" aria-hidden size={48} strokeWidth={1.75} />
          <span className="text-2xl font-bold text-[var(--text-primary)]">GeoForge</span>
        </div>

        <div className="w-full max-w-sm">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150 ease-out"
              style={{ width: `${clamped}%` }}
            />
          </div>
          <p className="mt-2 text-center text-sm tabular-nums text-[var(--text-muted)]">{Math.round(clamped)}%</p>
        </div>
      </div>

      <ul className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--text-secondary)]">
        {steps.map((step, index) => (
          <li key={`${step.label}-${index}`} className="flex items-center gap-2">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
              {step.done ? (
                <Check className="h-4 w-4 text-[var(--success)]" strokeWidth={2.5} />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
              )}
            </span>
            <span className={step.done ? 'text-[var(--text-primary)]' : undefined}>{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
