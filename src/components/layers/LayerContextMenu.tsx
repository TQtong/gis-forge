import {
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  Palette,
  Pencil,
  Table,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Props for the floating layer context menu.
 */
export interface LayerContextMenuProps {
  /** Target layer id for menu actions. */
  layerId: string;
  /** Closes the menu (outside click / Escape / after action). */
  onClose: () => void;
  /** Viewport coordinates for fixed positioning (client space). */
  position: { x: number; y: number };
}

/**
 * Floating context menu for rename, zoom, export, delete, etc.
 *
 * @param props - Menu props including `layerId` and `position`.
 * @returns Portal-rendered menu or null when unmounted.
 */
export function LayerContextMenu({ layerId, onClose, position }: LayerContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el || el.contains(e.target as Node)) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const noop = useCallback(() => {
    void layerId;
  }, [layerId]);

  const menu = (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-[220px] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-lg"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Pencil className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        重命名
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <ZoomIn className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        缩放到图层范围
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Table className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        查看属性表
      </button>
      <div
        className="relative"
        onMouseEnter={() => {
          setPresetOpen(true);
        }}
        onMouseLeave={() => {
          setPresetOpen(false);
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        >
          <Palette className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
          <span className="flex-1">应用样式预设</span>
          <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" strokeWidth={2} />
        </button>
        {presetOpen ? (
          <div className="absolute left-full top-0 z-[70] ml-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-lg">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
              onClick={() => {
                noop();
                onClose();
              }}
            >
              预设 A
            </button>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
              onClick={() => {
                noop();
                onClose();
              }}
            >
              预设 B
            </button>
          </div>
        ) : null}
      </div>

      <div className="my-1 h-px bg-[var(--border)]" />

      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Download className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        导出 GeoJSON
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Download className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        导出 CSV
      </button>

      <div className="my-1 h-px bg-[var(--border)]" />

      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <FolderInput className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        移到分组
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Copy className="size-4 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        复制图层
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--bg-panel-hover)]"
        onClick={() => {
          noop();
          onClose();
        }}
      >
        <Trash2 className="size-4 shrink-0" strokeWidth={2} />
        删除
      </button>
    </div>
  );

  return createPortal(menu, document.body);
}
