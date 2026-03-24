import { useMemo, useRef, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Feature } from '@/types';

/**
 * Props for the virtualized attribute table.
 */
export interface AttributeTableProps {
    /** Features whose properties are rendered as rows (columns = keys from first feature). */
    features: Feature[];
}

/**
 * Virtualized property table for large multi-selection sets.
 *
 * @param props - {@link AttributeTableProps}
 * @returns Scrollable, row-virtualized table.
 */
export function AttributeTable(props: AttributeTableProps): ReactElement {
    const { features } = props;
    const parentRef = useRef<HTMLDivElement>(null);

    const columns = useMemo(() => {
        if (features.length === 0) return [] as string[];
        return Object.keys(features[0].properties ?? {});
    }, [features]);

    const rowVirtualizer = useVirtualizer({
        count: features.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 36,
        overscan: 16,
    });

    if (features.length === 0) {
        return (
            <p className="text-xs text-[var(--text-muted)] px-2 py-3 text-center">无要素</p>
        );
    }

    const virtualRows = rowVirtualizer.getVirtualItems();

    return (
        <div
            ref={parentRef}
            className="overflow-auto max-h-[400px] rounded-md border border-[var(--border)] bg-[var(--bg-input)]"
        >
            <div
                className="sticky top-0 z-[1] flex min-w-full border-b border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-secondary)]"
                role="row"
            >
                <div className="shrink-0 w-9 px-2 py-1.5 text-xs font-medium border-r border-[var(--border)]">#</div>
                {columns.map((c) => (
                    <div
                        key={c}
                        className="shrink-0 min-w-[100px] flex-1 px-2 py-1.5 text-xs font-medium border-r border-[var(--border)] last:border-r-0 truncate"
                        title={c}
                    >
                        {c}
                    </div>
                ))}
            </div>
            <div
                className="relative w-full"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
                {virtualRows.map((virtualRow) => {
                    const f = features[virtualRow.index];
                    const p = f.properties ?? {};
                    return (
                        <div
                            key={virtualRow.key}
                            role="row"
                            className="absolute left-0 flex w-full border-b border-[var(--border)]"
                            style={{
                                height: `${virtualRow.size}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                        >
                            <div className="shrink-0 w-9 px-2 py-1 text-xs font-mono text-[var(--text-muted)] border-r border-[var(--border)]">
                                {virtualRow.index + 1}
                            </div>
                            {columns.map((col) => (
                                <div
                                    key={col}
                                    className="shrink-0 min-w-[100px] flex-1 px-2 py-1 text-xs font-mono text-[var(--text-primary)] border-r border-[var(--border)] last:border-r-0 truncate"
                                    title={
                                        p[col] === undefined || p[col] === null
                                            ? ''
                                            : typeof p[col] === 'object'
                                              ? JSON.stringify(p[col])
                                              : String(p[col])
                                    }
                                >
                                    {p[col] === undefined || p[col] === null
                                        ? ''
                                        : typeof p[col] === 'object'
                                          ? JSON.stringify(p[col])
                                          : String(p[col])}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
