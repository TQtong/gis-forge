import { useMemo, useState, type ReactElement } from 'react';
import { Download, Table, Trash2, X } from 'lucide-react';
import type { Feature } from '@/types';
import { AttributeTable } from '@/components/properties/AttributeTable';
import { computeGeometryAreaSquareMeters, computeGeometryLengthMeters } from '@/components/properties/GeometryInfo';
import { useSelectionStore } from '@/stores/selectionStore';

/**
 * Props for multi-selection summary in the property panel.
 */
export interface MultiSelectSummaryProps {
    /** All features currently included in the selection. */
    features: Feature[];
}

/**
 * Summarizes multi-select: layer counts, aggregate stats, and batch actions.
 *
 * @param props - {@link MultiSelectSummaryProps}
 * @returns Summary card with optional attribute table modal region.
 */
export function MultiSelectSummary(props: MultiSelectSummaryProps): ReactElement {
    const { features } = props;
    const [showTable, setShowTable] = useState(false);
    const clearSelection = useSelectionStore((s) => s.clearSelection);

    const layerCounts = useMemo(() => {
        const map = new Map<string, number>();
        for (const f of features) {
            map.set(f.layerId, (map.get(f.layerId) ?? 0) + 1);
        }
        return map;
    }, [features]);

    const layerCount = layerCounts.size;

    const { totalLengthM, totalAreaM2 } = useMemo(() => {
        let len = 0;
        let area = 0;
        for (const f of features) {
            len += computeGeometryLengthMeters(f.geometry);
            area += computeGeometryAreaSquareMeters(f.geometry);
        }
        return { totalLengthM: len, totalAreaM2: area };
    }, [features]);

    const formatLength = (m: number): string =>
        m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`;

    const formatArea = (m2: number): string =>
        m2 < 1_000_000 ? `${m2.toFixed(0)} m²` : `${(m2 / 1_000_000).toFixed(3)} km²`;

    return (
        <div className="flex flex-col gap-3 text-[var(--text-primary)] w-full">
            <div>
                <h2 className="text-sm font-semibold">已选中 {features.length} 个要素</h2>
                <p className="text-xs text-[var(--text-secondary)] mt-1">来自 {layerCount} 个图层</p>
            </div>

            <ul className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] divide-y divide-[var(--border)] max-h-[180px] overflow-auto">
                {Array.from(layerCounts.entries()).map(([layerId, count]) => (
                    <li key={layerId} className="flex justify-between gap-2 px-3 py-2 text-xs">
                        <span className="text-[var(--text-secondary)] truncate" title={layerId}>
                            {layerId}
                        </span>
                        <span className="font-mono text-[var(--text-primary)] shrink-0">{count}</span>
                    </li>
                ))}
            </ul>

            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                    <span className="text-[var(--text-secondary)]">线长度合计</span>
                    <span className="font-mono text-[var(--text-primary)]">{formatLength(totalLengthM)}</span>
                </div>
                <div className="flex justify-between gap-2">
                    <span className="text-[var(--text-secondary)]">面面积合计</span>
                    <span className="font-mono text-[var(--text-primary)]">{formatArea(totalAreaM2)}</span>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => setShowTable((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <Table className="size-3.5" strokeWidth={2} aria-hidden />
                    属性表
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--error)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <Trash2 className="size-3.5" strokeWidth={2} aria-hidden />
                    批量删除
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <Download className="size-3.5" strokeWidth={2} aria-hidden />
                    导出选中
                </button>
                <button
                    type="button"
                    onClick={() => clearSelection()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <X className="size-3.5" strokeWidth={2} aria-hidden />
                    取消选择
                </button>
            </div>

            {showTable && (
                <div className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-2">
                    <AttributeTable features={features} />
                </div>
            )}
        </div>
    );
}
