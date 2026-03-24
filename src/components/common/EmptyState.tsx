import type { ComponentType, ReactElement } from 'react';

/**
 * Props for compact empty states inside side panels, drawers, or lists.
 */
export interface EmptyStateProps {
  /** Lucide icon component to render above the title (receives `className` / `size`). */
  icon: ComponentType<{ className?: string; size?: number }>;
  /** Short headline when there is no content to show. */
  title: string;
  /** Supporting copy explaining why the area is empty or what the user can do next. */
  description: string;
}

/**
 * Centered empty-state block for panels: muted icon, title, and wrapped description using theme CSS variables.
 *
 * @param props - {@link EmptyStateProps}
 * @returns React element suitable as the sole child of a scroll region or flex container.
 *
 * @example
 * ```tsx
 * import { Inbox } from 'lucide-react';
 *
 * <EmptyState icon={Inbox} title="暂无要素" description="导入数据或打开图层后将在此显示。" />
 * ```
 */
export function EmptyState(props: EmptyStateProps): ReactElement {
  const { icon: Icon, title, description } = props;

  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <Icon className="text-[var(--text-muted)] opacity-60" size={32} aria-hidden />
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      <p className="max-w-[200px] text-xs text-[var(--text-muted)]">{description}</p>
    </div>
  );
}
