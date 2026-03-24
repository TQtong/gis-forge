import { useMemo, type ReactElement } from 'react';
import { Toaster, toast } from 'sonner';
import { useUIStore, type UITheme } from '@/stores/uiStore';

/**
 * Sonner theme value derived from the UI store.
 *
 * @param theme - Application theme key.
 * @returns Sonner-compatible theme.
 */
function toSonnerTheme(theme: UITheme): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark';
}

/**
 * Themed Sonner toaster aligned with CSS variables (left accent borders per severity).
 *
 * @returns Mounted toaster for the app shell.
 */
export function GeoForgeToaster(): ReactElement {
  const theme = useUIStore((s) => s.theme);
  const sonnerTheme = useMemo(() => toSonnerTheme(theme), [theme]);

  return (
    <Toaster
      position="top-right"
      theme={sonnerTheme}
      closeButton
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            'group border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-primary)] shadow-lg',
          title: 'text-[var(--text-primary)] font-medium',
          description: 'text-[var(--text-secondary)]',
          success: 'border-l-4 !border-l-[var(--toast-success-border)]',
          warning: 'border-l-4 !border-l-[var(--toast-warning-border)]',
          error: 'border-l-4 !border-l-[var(--toast-error-border)]',
        },
      }}
    />
  );
}

/**
 * Shows a success toast (green left border via themed classes).
 *
 * @param title - Primary line.
 * @param description - Optional detail text.
 */
export function showSuccess(title: string, description?: string): void {
  toast.success(title, { description });
}

/**
 * Shows a warning toast (amber left border).
 *
 * @param title - Primary line.
 * @param description - Optional detail text.
 */
export function showWarning(title: string, description?: string): void {
  toast.warning(title, { description });
}

/**
 * Shows an error toast (red left border) with optional action button.
 *
 * @param title - Primary line.
 * @param description - Optional detail text.
 * @param action - Optional button (e.g. retry).
 */
export function showError(
  title: string,
  description?: string,
  action?: { label: string; onClick: () => void },
): void {
  toast.error(title, {
    description,
    action: action
      ? {
          label: action.label,
          onClick: action.onClick,
        }
      : undefined,
  });
}
