import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
    Bookmark,
    ClipboardCopy,
    Crosshair,
    MapPin,
    Ruler,
    Search,
    Share2,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatCoordDD, formatCoordDMS } from '@/utils/formatters';
import { useMapStore } from '@/stores/mapStore';

/**
 * Props for the map right-click context menu.
 */
export interface MapContextMenuProps {
    /** Viewport-fixed client position, or null when closed. */
    position: { x: number; y: number } | null;
    /** WGS84 `[longitude, latitude]` at the click; null disables geo actions. */
    lngLat: [number, number] | null;
    /** Invoked when the menu should dismiss (outside click, Escape, or after action). */
    onClose: () => void;
}

/**
 * Right-click menu for quick map actions: measure, copy coordinates, fly-to, share.
 *
 * @param props - Position, coordinates, and close handler.
 * @returns Portal-mounted menu or null.
 */
export function MapContextMenu(props: MapContextMenuProps): ReactElement | null {
    const { position, lngLat, onClose } = props;
    const flyTo = useMapStore((s) => s.flyTo);
    const zoom = useMapStore((s) => s.zoom);
    const setActiveTool = useMapStore((s) => s.setActiveTool);
    const menuRef = useRef<HTMLDivElement>(null);

    const copyText = useCallback(async (text: string, okMessage: string) => {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                toast.success(okMessage);
            } else {
                toast.error('剪贴板不可用');
            }
        } catch {
            toast.error('复制失败');
        }
        onClose();
    }, [onClose]);

    const buildShareUrl = useCallback(() => {
        if (lngLat === null) return '';
        const [lng, lat] = lngLat;
        const hash = `center=${lng.toFixed(5)},${lat.toFixed(5)}&zoom=${zoom.toFixed(1)}`;
        if (typeof window === 'undefined') return '';
        return `${window.location.origin}${window.location.pathname}#${hash}`;
    }, [lngLat, zoom]);

    useEffect(() => {
        if (position === null) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        const onPointerDown = (e: MouseEvent) => {
            const node = menuRef.current;
            if (node && e.target instanceof Node && !node.contains(e.target)) {
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [onClose, position]);

    if (position === null) {
        return null;
    }

    const { x, y } = position;
    const vw =
        typeof window !== 'undefined' ? window.innerWidth : x + 240;
    const vh =
        typeof window !== 'undefined' ? window.innerHeight : y + 320;
    const left = Math.min(x, vw - 228);
    const top = Math.min(y, vh - 8);

    const menu = (
        <div
            ref={menuRef}
            className="fixed z-[100] min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-xl"
            style={{ left, top }}
            role="menu"
            aria-label="地图上下文菜单"
        >
            <button
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                onClick={() => {
                    toast.info('📍 在此处添加标注（占位）');
                    onClose();
                }}
            >
                <MapPin className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>📍 在此处添加标注</span>
            </button>
            <button
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                onClick={() => {
                    setActiveTool('measure-distance');
                    toast.info('已切换到距离测量');
                    onClose();
                }}
            >
                <Ruler className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>📐 从此处开始测量</span>
            </button>
            <button
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                onClick={() => {
                    setActiveTool('select-click');
                    toast.info('已切换到点选查询');
                    onClose();
                }}
            >
                <Search className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>🔍 查询此处要素</span>
            </button>
            <div className="my-1 h-px bg-[var(--border)]" role="separator" />
            <button
                type="button"
                role="menuitem"
                disabled={lngLat === null}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                    if (lngLat === null) return;
                    void copyText(formatCoordDD(lngLat[0], lngLat[1]), '已复制十进制度坐标');
                }}
            >
                <ClipboardCopy className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>📋 复制坐标 (度)</span>
            </button>
            <button
                type="button"
                role="menuitem"
                disabled={lngLat === null}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                    if (lngLat === null) return;
                    void copyText(formatCoordDMS(lngLat[0], lngLat[1]), '已复制度分秒坐标');
                }}
            >
                <ClipboardCopy className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>📋 复制坐标 (度分秒)</span>
            </button>
            <button
                type="button"
                role="menuitem"
                disabled={lngLat === null}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                    if (lngLat === null) return;
                    flyTo(lngLat, zoom);
                    toast.success('已以此为中心');
                    onClose();
                }}
            >
                <Crosshair className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>🗺️ 以此为中心</span>
            </button>
            <button
                type="button"
                role="menuitem"
                disabled={lngLat === null}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                    toast.success('书签已保存（占位）', {
                        description:
                            lngLat === null
                                ? undefined
                                : formatCoordDD(lngLat[0], lngLat[1]),
                    });
                    onClose();
                }}
            >
                <Bookmark className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>🔖 保存为书签</span>
            </button>
            <button
                type="button"
                role="menuitem"
                disabled={lngLat === null}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                    const url = buildShareUrl();
                    if (!url) {
                        toast.error('无法生成链接');
                        onClose();
                        return;
                    }
                    void copyText(url, '已复制分享链接');
                }}
            >
                <Share2 className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                <span>🔗 分享此位置</span>
            </button>
        </div>
    );

    if (typeof document === 'undefined') {
        return null;
    }

    return createPortal(menu, document.body);
}
