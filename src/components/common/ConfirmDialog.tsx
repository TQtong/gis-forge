import { X } from 'lucide-react';

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** When true, the modal is visible. */
  open: boolean;
  /** Dialog title. */
  title: string;
  /** Body copy. */
  message: string;
  /** Primary confirm handler. */
  onConfirm: () => void;
  /** Cancel / dismiss handler. */
  onCancel: () => void;
  /** Optional confirm button label. */
  confirmLabel?: string;
  /** When true, confirm button uses destructive (error) styling. */
  destructive?: boolean;
}

/**
 * Generic confirm modal with cancel + confirm actions.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = '确认',
  destructive = false,
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-xl">
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <h2 id="confirm-dialog-title" className="text-base font-semibold text-[var(--text-primary)]">
            {title}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]"
          >
            <X className="size-5" />
          </button>
        </div>
        <p id="confirm-dialog-desc" className="px-4 py-3 text-sm text-[var(--text-secondary)]">
          {message}
        </p>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-sm text-white ${
              destructive ? 'bg-[var(--error)] hover:opacity-90' : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
