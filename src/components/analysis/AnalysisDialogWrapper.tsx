import { AnalysisProgress } from '@/components/analysis/AnalysisProgress';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId } from 'react';

/**
 * Props for the shared analysis modal shell (header, scroll body, footer, progress).
 */
export interface AnalysisDialogWrapperProps {
  /** Dialog title shown next to the icon. */
  title: string;
  /** Lucide icon constructor for the header. */
  icon: LucideIcon;
  /** Form body content (inputs only; footer is fixed). */
  children: ReactNode;
  /** Invoked when the user confirms analysis. */
  onRun: () => void;
  /** Invoked when the user cancels or closes the dialog. */
  onCancel: () => void;
  /** Whether a simulated run is active. */
  isRunning: boolean;
  /** Progress 0–100 for {@link AnalysisProgress}. */
  progress: number;
  /** Optional feature counts for progress text. */
  progressCurrent?: number;
  progressTotal?: number;
}

/**
 * Standard modal frame for analysis tools: backdrop, panel, header with close, scrollable body, footer, progress.
 *
 * @param props - Layout and callbacks.
 * @returns Fixed overlay dialog fragment.
 */
export function AnalysisDialogWrapper(props: AnalysisDialogWrapperProps): ReactElement {
  const {
    title,
    icon: Icon,
    children,
    onRun,
    onCancel,
    isRunning,
    progress,
    progressCurrent,
    progressTotal,
  } = props;

  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50" aria-hidden onClick={onCancel} role="presentation" />
      <div className="relative z-10 flex min-h-full justify-center px-4 pb-8 pt-16 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="pointer-events-auto w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-xl"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className="h-5 w-5 shrink-0 text-[var(--accent)]" aria-hidden />
              <h2 id={titleId} className="truncate text-sm font-semibold text-[var(--text-primary)]">
                {title}
              </h2>
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
              aria-label="关闭"
              onClick={onCancel}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[min(70vh,520px)] overflow-y-auto px-4 py-3">{children}</div>

          <div className="border-t border-[var(--border)] px-4 py-3">
            {isRunning ? (
              <AnalysisProgress
                progress={progress}
                current={progressCurrent}
                total={progressTotal}
              />
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                onClick={onCancel}
                disabled={isRunning}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                onClick={onRun}
                disabled={isRunning}
              >
                执行分析
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
