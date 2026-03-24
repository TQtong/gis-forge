import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MapPin,
  Pentagon,
  Route,
  Ruler,
} from 'lucide-react';
import { useAnnotationStore } from '@/stores/annotationStore';
import type { Annotation } from '@/types';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/**
 * Picks an icon for an annotation by its semantic type.
 */
function iconForType(t: Annotation['type']) {
  switch (t) {
    case 'point':
      return MapPin;
    case 'line':
      return Route;
    case 'polygon':
      return Pentagon;
    default:
      return Ruler;
  }
}

/**
 * Short coordinate summary for list display.
 */
function formatCoords(geometry: Annotation['geometry']): string {
  try {
    const c = geometry.coordinates;
    if (geometry.type === 'Point' && Array.isArray(c) && c.length >= 2) {
      return `${Number(c[0]).toFixed(4)}, ${Number(c[1]).toFixed(4)}`;
    }
    return JSON.stringify(c).slice(0, 80);
  } catch {
    return '—';
  }
}

/**
 * Collapsible annotation / measure result list (left panel).
 */
export function AnnotationList() {
  const [expanded, setExpanded] = useState(true);
  const annotations = useAnnotationStore((s) => s.annotations);
  const clearAnnotations = useAnnotationStore((s) => s.clearAnnotations);
  const [confirmClear, setConfirmClear] = useState(false);

  const count = annotations.length;

  const sorted = useMemo(
    () => [...annotations].sort((a, b) => b.createdAt - a.createdAt),
    [annotations],
  );

  const onExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(sorted, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations-${Date.now()}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
    console.info('[Annotations] exported', sorted.length);
  }, [sorted]);

  return (
    <div className="border-t border-[var(--border)]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 bg-[var(--group-header-bg)] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        <span className="flex-1 truncate">📌 标注 ({count})</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          {count === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">暂无标注</p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {sorted.map((a) => {
                const Icon = iconForType(a.type);
                return (
                  <li
                    key={a.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--bg-panel-hover)]"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" strokeWidth={2} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--text-primary)]">{a.label || a.type}</p>
                      <p className="font-mono text-[10px] text-[var(--text-muted)]">
                        {formatCoords(a.geometry)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-2 flex flex-col gap-1">
            <button
              type="button"
              onClick={onExport}
              className="w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
            >
              📥 导出所有标注
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={count === 0}
              className="w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--error)] hover:bg-[var(--bg-panel-hover)] disabled:opacity-40"
            >
              🗑️ 清空所有标注
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="清空标注"
        message="确定要清空所有标注吗？此操作无法撤销。"
        confirmLabel="清空"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clearAnnotations();
          setConfirmClear(false);
        }}
      />
    </div>
  );
}
