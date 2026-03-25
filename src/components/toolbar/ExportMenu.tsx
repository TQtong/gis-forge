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
import type { Bookmark as BookmarkType } from '@/types';

export interface ExportMenuProps {
    /** 当前视图中心，用于复制链接 / 书签；默认北京演示点。 */
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    /** 与 {@link Bookmark} 一致：`'2d' | '25d' | 'globe'`。 */
    mode?: '2d' | '25d' | 'globe';
    /** 返回当前文档图层列表（导出 GeoJSON / 书签可见性）；默认可空数组。 */
    getAllLayers?: () => Array<{ id: string; visible: boolean; name?: string }>;
    /** 保存书签时调用；默认仅 `console.info`。 */
    onSaveBookmark?: (b: BookmarkType) => void;
}

/**
 * 分享 / 导出下拉：剪贴板与控制台占位。无 store 时使用 props 或内置默认值。
 */
export function ExportMenu(props: ExportMenuProps = {}) {
    const {
        center = [116.3974, 39.9093],
        zoom = 10,
        bearing = 0,
        pitch = 0,
        mode = '2d',
        getAllLayers = () => [],
        onSaveBookmark,
    } = props;

    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

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

    const onSaveBookmarkClick = useCallback(() => {
        const visibleLayers = getAllLayers().filter((l) => l.visible).map((l) => l.id);
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
            mode,
            createdAt: Date.now(),
        };
        if (onSaveBookmark) {
            onSaveBookmark(b);
        } else {
            console.info('[Export] 保存为书签', b);
        }
        setOpen(false);
    }, [bearing, center, getAllLayers, mode, onSaveBookmark, pitch, zoom]);

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
                    <MenuRow icon={Bookmark} label="保存为书签" onClick={onSaveBookmarkClick} />
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
