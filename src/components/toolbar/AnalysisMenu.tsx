import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
    BarChart3,
    Circle,
    Eye,
    Flame,
    Hexagon,
    Layers,
    Mountain,
    PieChart,
    Sun,
    TrendingUp,
} from 'lucide-react';
import type { AnalysisDialogId } from '@/types';
import { useUIStore } from '@/stores/uiStore';

type AnalysisItem = {
    id: AnalysisDialogId;
    label: string;
    icon: typeof Circle;
};

const ITEMS: AnalysisItem[] = [
    { id: 'buffer', label: '缓冲区分析', icon: Circle },
    { id: 'overlay', label: '叠加分析', icon: Layers },
    { id: 'contour', label: '等值线生成', icon: Mountain },
    { id: 'heatmap', label: '热力密度', icon: Flame },
    { id: 'voronoi', label: 'Voronoi', icon: Hexagon },
    { id: 'viewshed', label: '视域分析', icon: Eye },
    { id: 'slope', label: '坡度/坡向', icon: TrendingUp },
    { id: 'hillshade', label: '山体阴影', icon: Sun },
    { id: 'classification', label: '分类统计', icon: PieChart },
];

/**
 * Dropdown of spatial analysis tools; opens the corresponding dialog id in {@link useUIStore}.
 *
 * @returns Toolbar button + anchored menu.
 */
export function AnalysisMenu(): ReactElement {
    const setActiveAnalysisDialog = useUIStore((s) => s.setActiveAnalysisDialog);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        if (!open) return;
        const onDocMouseDown = (e: MouseEvent) => {
            const node = rootRef.current;
            if (node && e.target instanceof Node && !node.contains(e.target)) {
                setOpen(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <div className="relative" ref={rootRef}>
            <button
                type="button"
                title="分析工具"
                aria-label="分析工具"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={`p-2 rounded-md transition-colors ${
                    open
                        ? 'bg-[var(--accent)] text-white'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]'
                }`}
            >
                <BarChart3 className="size-5" strokeWidth={2} />
            </button>
            {open && (
                <div
                    className="absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-xl"
                    role="menu"
                    aria-label="分析工具菜单"
                >
                    {ITEMS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            role="menuitem"
                            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                            onClick={() => {
                                setActiveAnalysisDialog(id);
                                close();
                            }}
                        >
                            <Icon className="size-4 shrink-0 text-[var(--accent)]" aria-hidden />
                            {label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
