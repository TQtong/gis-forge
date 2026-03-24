import { useCallback, useMemo } from 'react';
import { X } from 'lucide-react';
import { useHistory } from '@/hooks/useHistory';
import { useHistoryStore } from '@/stores/historyStore';
import { useUIStore } from '@/stores/uiStore';
import type { HistoryEntry } from '@/types';

/**
 * Seeks the history stacks so the given entry becomes the tip of the undo stack.
 */
function seekToEntry(targetId: string, undo: () => void, redo: () => void): void {
  const maxSteps = 200;
  for (let i = 0; i < maxSteps; i++) {
    const { undoStack, redoStack } = useHistoryStore.getState();
    const last = undoStack[undoStack.length - 1];
    if (last?.id === targetId) {
      return;
    }
    const inUndo = undoStack.some((e) => e.id === targetId);
    const inRedo = redoStack.some((e) => e.id === targetId);
    if (inUndo) {
      undo();
      continue;
    }
    if (inRedo) {
      redo();
      continue;
    }
    break;
  }
}

/**
 * Floating undo history list (most recent first).
 */
export function HistoryPanel() {
  const open = useUIStore((s) => s.historyPanelOpen);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const undoStack = useHistoryStore((s) => s.undoStack);
  const redoStack = useHistoryStore((s) => s.redoStack);
  const { undo, redo } = useHistory();

  const rows = useMemo(() => {
    const redoIds = new Set(redoStack.map((e) => e.id));
    const merged = [...undoStack, ...redoStack];
    const byId = new Map<string, HistoryEntry>();
    for (const e of merged) {
      byId.set(e.id, e);
    }
    const list = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
    const currentId = undoStack[undoStack.length - 1]?.id;
    return list.map((e) => ({
      entry: e,
      isCurrent: e.id === currentId,
      isUndone: redoIds.has(e.id),
    }));
  }, [redoStack, undoStack]);

  const onRowClick = useCallback(
    (id: string) => {
      seekToEntry(id, undo, redo);
    },
    [redo, undo],
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed bottom-16 right-4 z-40 flex w-80 max-h-[min(360px,50vh)] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-xl"
      role="dialog"
      aria-label="操作历史"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-sm font-semibold text-[var(--text-primary)]">⏪ 操作历史</span>
        <button
          type="button"
          aria-label="关闭历史"
          onClick={() => setHistoryPanelOpen(false)}
          className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]"
        >
          <X className="size-4" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
        {rows.length === 0 ? (
          <li className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">暂无操作记录</li>
        ) : (
          rows.map(({ entry, isCurrent, isUndone }) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onRowClick(entry.id)}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-panel-hover)] ${
                  isUndone ? 'opacity-50' : ''
                }`}
              >
                <span className="mt-0.5 font-mono text-[var(--accent)]" aria-hidden>
                  {isCurrent ? '●' : '○'}
                </span>
                <span className="min-w-0 flex-1 text-[var(--text-primary)]">
                  {entry.description}
                  {isUndone ? (
                    <span className="ml-1 text-[var(--text-muted)]">(已撤销)</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      <p className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--text-muted)]">
        提示：Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · 点击条目跳转到该状态
      </p>
    </div>
  );
}
