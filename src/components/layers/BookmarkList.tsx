import { useCallback, useState } from 'react';
import { Bookmark as BookmarkIcon, ChevronDown, ChevronRight, MapPin, Trash2 } from 'lucide-react';
import { useAnnotationStore } from '@/stores/annotationStore';
import { useLayerStore } from '@/stores/layerStore';
import { useMapStore } from '@/stores/mapStore';
import type { Bookmark } from '@/types';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/**
 * Maps bookmark view mode to `MapState.mode` values.
 */
function bookmarkModeToMapMode(m: Bookmark['mode']): '2d' | '2.5d' | 'globe' {
  if (m === '25d') return '2.5d';
  if (m === 'globe') return 'globe';
  return '2d';
}

/**
 * Collapsible bookmark section for the left panel.
 */
export function BookmarkList() {
  const [expanded, setExpanded] = useState(true);
  const bookmarks = useAnnotationStore((s) => s.bookmarks);
  const removeBookmark = useAnnotationStore((s) => s.removeBookmark);
  const flyTo = useMapStore((s) => s.flyTo);
  const setMode = useMapStore((s) => s.setMode);
  const setBearing = useMapStore((s) => s.setBearing);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const addCurrent = useCallback(() => {
    const center = useMapStore.getState().center;
    const zoom = useMapStore.getState().zoom;
    const bearing = useMapStore.getState().bearing;
    const pitch = useMapStore.getState().pitch;
    const mode = useMapStore.getState().mode;
    const visibleLayers = useLayerStore
      .getState()
      .getAllLayers()
      .filter((l) => l.visible)
      .map((l) => l.id);
    const bookmarkMode: Bookmark['mode'] =
      mode === '2.5d' ? '25d' : mode === 'globe' ? 'globe' : '2d';
    const b: Bookmark = {
      id:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `bm-${Date.now()}`,
      name: `书签 ${bookmarks.length + 1}`,
      center: [...center] as [number, number],
      zoom,
      bearing,
      pitch,
      visibleLayers,
      mode: bookmarkMode,
      createdAt: Date.now(),
    };
    useAnnotationStore.getState().addBookmark(b);
  }, [bookmarks.length]);

  const onFly = useCallback(
    (b: Bookmark) => {
      flyTo(b.center, b.zoom);
      setMode(bookmarkModeToMapMode(b.mode));
      setBearing(b.bearing);
      useMapStore.setState({ pitch: b.pitch });
    },
    [flyTo, setBearing, setMode],
  );

  const count = bookmarks.length;

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
        <span className="flex-1 truncate">
          🔖 书签 ({count})
        </span>
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          {count === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">暂无书签</p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {bookmarks.map((b) => (
                <li
                  key={b.id}
                  className="group relative flex items-center gap-1 rounded-md hover:bg-[var(--bg-panel-hover)]"
                  onMouseEnter={() => setHoverId(b.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <button
                    type="button"
                    onClick={() => onFly(b)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-[var(--text-primary)]"
                  >
                    <MapPin className="size-4 shrink-0 text-[var(--accent)]" strokeWidth={2} />
                    <span className="truncate">{b.name}</span>
                  </button>
                  {(hoverId === b.id || deleteId === b.id) && (
                    <button
                      type="button"
                      title="删除书签"
                      aria-label="删除书签"
                      onClick={() => setDeleteId(b.id)}
                      className="mr-1 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-input)] hover:text-[var(--error)]"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={addCurrent}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border)] py-2 text-xs text-[var(--accent)] hover:bg-[var(--bg-panel-hover)]"
          >
            <BookmarkIcon className="size-3.5" strokeWidth={2} />+ 添加当前视图为书签
          </button>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="删除书签"
        message="确定要删除此书签吗？"
        confirmLabel="删除"
        destructive
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) removeBookmark(deleteId);
          setDeleteId(null);
        }}
      />
    </div>
  );
}
