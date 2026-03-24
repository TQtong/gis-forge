import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Feature } from '@/types';

/**
 * Props for the hover feature callout anchored to screen coordinates.
 */
export interface FeaturePopupProps {
    /** Feature to preview; null hides the popup. */
    feature: Feature | null;
    /** Client-space pointer position for the anchor point. */
    position: { x: number; y: number } | null;
}

/**
 * Picks the first string property value for a compact title fallback.
 *
 * @param feature - GeoJSON feature.
 * @returns First string property or null.
 */
function firstStringProperty(feature: Feature): string | null {
    const props = feature.properties ?? {};
    for (const v of Object.values(props)) {
        if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return null;
}

/**
 * Floating hover card with delayed reveal for map-identify previews.
 *
 * @param props - {@link FeaturePopupProps}
 * @returns Fixed-position popup or null when disabled.
 */
export function FeaturePopup(props: FeaturePopupProps): ReactElement | null {
    const { feature, position } = props;
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!feature || !position) {
            setVisible(false);
            return;
        }
        const t = window.setTimeout(() => setVisible(true), 300);
        return () => {
            window.clearTimeout(t);
            setVisible(false);
        };
    }, [feature, position]);

    const title = useMemo(() => {
        if (!feature) return '';
        return firstStringProperty(feature) ?? String(feature.id);
    }, [feature]);

    const previewPairs = useMemo(() => {
        if (!feature) return [] as [string, string][];
        const entries = Object.entries(feature.properties ?? {}).slice(0, 3);
        return entries.map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)] as [string, string]);
    }, [feature]);

    if (!feature || !position || !visible) return null;

    return (
        <div
            className="fixed z-20 pointer-events-none"
            style={{
                left: position.x,
                top: position.y,
                transform: 'translate(-50%, calc(-100% - 12px))',
            }}
            role="tooltip"
        >
            <div className="relative bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg shadow-xl p-3 max-w-[250px] text-[var(--text-primary)]">
                <div className="text-sm font-semibold leading-snug break-words">{title}</div>
                <div className="mt-2 space-y-1">
                    {previewPairs.map(([k, v]) => (
                        <div key={k} className="text-xs leading-snug">
                            <span className="text-[var(--text-secondary)]">{k}: </span>
                            <span className="text-[var(--text-primary)] break-all">{v}</span>
                        </div>
                    ))}
                </div>
                <div className="mt-2 text-xs text-[var(--accent)]">点击查看详情 →</div>

                <div
                    className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-0 h-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-[var(--border)]"
                    aria-hidden
                />
                <div
                    className="absolute left-1/2 -translate-x-1/2 -bottom-[7px] w-0 h-0 border-l-[7px] border-r-[7px] border-t-[7px] border-l-transparent border-r-transparent border-t-[var(--bg-panel)]"
                    aria-hidden
                />
            </div>
        </div>
    );
}
