import { useCallback, type ReactElement } from 'react';
import { ClipboardCopy, Pencil, Trash2, ZoomIn } from 'lucide-react';
import type { Feature } from '@/types';
import { GeometryInfo } from '@/components/properties/GeometryInfo';

/**
 * Props for the single-feature property inspector.
 */
export interface FeaturePropertiesProps {
    /** Selected vector feature including geometry and attributes. */
    feature: Feature;
}

/**
 * Displays attributes, geometry summary, and quick actions for one selected feature.
 *
 * @param props - {@link FeaturePropertiesProps}
 * @returns Scrollable inspector block for the right panel.
 */
export function FeatureProperties(props: FeaturePropertiesProps): ReactElement {
    const { feature } = props;
    const entries = Object.entries(feature.properties ?? {});
    const count = entries.length;

    const onCopy = useCallback(async () => {
        const text = JSON.stringify(feature.properties ?? {}, null, 2);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            /* Clipboard may be blocked without user gesture or secure context; ignore. */
        }
    }, [feature.properties]);

    return (
        <div className="flex flex-col gap-3 text-[var(--text-primary)] w-full">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <h2 className="text-sm font-semibold">要素属性</h2>
                    <p className="text-xs text-[var(--text-secondary)] mt-1">
                        图层: <span className="text-[var(--text-primary)]">{feature.layerId}</span>
                    </p>
                    <p className="text-xs text-[var(--text-secondary)]">
                        ID: <span className="font-mono text-[var(--text-primary)]">{String(feature.id)}</span>
                    </p>
                </div>
                <button
                    type="button"
                    title="复制属性 JSON"
                    aria-label="复制属性"
                    onClick={() => void onCopy()}
                    className="shrink-0 p-2 rounded-md border border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                    <ClipboardCopy className="size-4" strokeWidth={2} aria-hidden />
                </button>
            </div>

            <details open className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] overflow-hidden">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]">
                    属性 ({count})
                </summary>
                <div className="border-t border-[var(--border)] max-h-[240px] overflow-auto">
                    {count === 0 ? (
                        <p className="px-3 py-2 text-xs text-[var(--text-muted)]">无属性字段</p>
                    ) : (
                        <table className="w-full border-collapse">
                            <tbody>
                                {entries.map(([key, value]) => (
                                    <tr key={key} className="border-b border-[var(--border)] last:border-b-0">
                                        <td className="py-1.5 px-2 text-sm align-top text-[var(--text-secondary)] w-[40%] break-all">
                                            {key}
                                        </td>
                                        <td className="py-1.5 px-2 text-sm align-top text-[var(--text-primary)] break-all">
                                            {typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </details>

            <details open className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] overflow-hidden">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]">
                    几何信息
                </summary>
                <div className="border-t border-[var(--border)] px-3 py-2">
                    <GeometryInfo geometry={feature.geometry} />
                </div>
            </details>

            <div className="flex flex-wrap gap-2 pt-1">
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <ZoomIn className="size-3.5" strokeWidth={2} aria-hidden />
                    缩放到
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <Pencil className="size-3.5" strokeWidth={2} aria-hidden />
                    编辑
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-[var(--border)] bg-[var(--bg-panel)] text-[var(--error)] hover:bg-[var(--bg-panel-hover)] transition-colors"
                >
                    <Trash2 className="size-3.5" strokeWidth={2} aria-hidden />
                    删除
                </button>
            </div>
        </div>
    );
}
