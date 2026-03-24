import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  ChevronDown,
  Code,
  FileText,
  Image,
  Link,
  Package,
  Share,
} from 'lucide-react';
import { useMapStore } from '@/stores/mapStore';
import { useLayerStore } from '@/stores/layerStore';
import { useAnnotationStore } from '@/stores/annotationStore';
import type { Bookmark as BookmarkType } from '@/types';

/**
 * Dropdown triggered from the share/export toolbar control (console + clipboard stubs).
 */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const mode = useMapStore((s) => s.mode);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);
  const addBookmark = useAnnotationStore((s) => s.addBookmark);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const copyText = useCallback(async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      console.info(`[Export] ${label}: copied to clipboard`);
    } catch {
      console.warn(`[Export] ${label}: clipboard failed`);
    }
  }, []);

  const onExportPng = useCallback(() => {
    console.info('[Export] 导出为 PNG 图片');
    setOpen(false);
  }, []);

  const onExportPdf = useCallback(() => {
    console.info('[Export] 导出为 PDF');
    setOpen(false);
  }, []);

  const onExportGeoJson = useCallback(() => {
    const layers = getAllLayers();
    const payload = { type: 'FeatureCollection', features: [], meta: { layers } };
    console.info('[Export] 导出所有图层 GeoJSON', payload);
    setOpen(false);
  }, [getAllLayers]);

  const onCopyViewLink = useCallback(() => {
    const hash = `#center=${center[0].toFixed(5)},${center[1].toFixed(5)}&zoom=${zoom.toFixed(2)}`;
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}${typeof window !== 'undefined' ? window.location.pathname : '/'}${hash}`;
    void copyText('视图链接', url);
    setOpen(false);
  }, [center, copyText, zoom]);

  const onCopyEmbed = useCallback(() => {
    const embed = `<iframe src="${typeof window !== 'undefined' ? window.location.href : ''}" width="800" height="600" />`;
    void copyText('嵌入代码', embed);
    setOpen(false);
  }, [copyText]);

  const onSaveBookmark = useCallback(() => {
    const visibleLayers = getAllLayers().filter((l) => l.visible).map((l) => l.id);
    const bookmarkMode: BookmarkType['mode'] =
      mode === '2.5d' ? '25d' : mode === 'globe' ? 'globe' : '2d';
    const b: BookmarkType = {
      id:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `bm-${Date.now()}`,
      name: `书签 ${new Date().toLocaleString()}`,
      center: [...center] as [number, number],
      zoom,
      bearing,
      pitch,
      visibleLayers,
      mode: bookmarkMode,
      createdAt: Date.now(),
    };
    addBookmark(b);
    console.info('[Export] 保存为书签', b);
    setOpen(false);
  }, [addBookmark, bearing, center, getAllLayers, mode, pitch, zoom]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        title="导出"
        aria-label="导出"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-0.5 rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
      >
        <Share className="size-5" strokeWidth={2} />
        <ChevronDown className="size-3.5 opacity-70" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-lg"
          role="menu"
        >
          <MenuRow icon={Image} label="导出为 PNG 图片" onClick={onExportPng} />
          <MenuRow icon={FileText} label="导出为 PDF" onClick={onExportPdf} />
          <MenuRow icon={Package} label="导出所有图层 GeoJSON" onClick={onExportGeoJson} />
          <MenuRow icon={Link} label="复制当前视图链接" onClick={onCopyViewLink} />
          <MenuRow icon={Code} label="复制嵌入代码" onClick={onCopyEmbed} />
          <div className="my-1 h-px bg-[var(--border)]" role="separator" />
          <MenuRow icon={Bookmark} label="保存为书签" onClick={onSaveBookmark} />
        </div>
      )}
    </div>
  );
}

/** Single dropdown row with Lucide icon. */
function MenuRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Image;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
    >
      <Icon className="size-4 shrink-0 text-[var(--accent)]" strokeWidth={2} />
      {label}
    </button>
  );
}
