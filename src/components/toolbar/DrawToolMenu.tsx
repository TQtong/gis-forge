import { useEffect, useRef, type ReactElement } from 'react';
import { Circle, MapPin, Pentagon, Route, Square, Spline } from 'lucide-react';
import type { ToolType } from '@/types';

/**
 * Props for the draw-tool dropdown panel.
 */
export interface DrawToolMenuProps {
    /** Invoked when the user picks a draw tool; parent should set `mapStore.activeTool`. */
    onSelect: (tool: ToolType) => void;
    /** Invoked when the menu should close (selection or outside click). */
    onClose: () => void;
}

const OPTIONS: { tool: ToolType; label: string; Icon: typeof MapPin }[] = [
    { tool: 'draw-point', label: '点', Icon: MapPin },
    { tool: 'draw-line', label: '折线', Icon: Route },
    { tool: 'draw-polygon', label: '多边形', Icon: Pentagon },
    { tool: 'draw-rect', label: '矩形', Icon: Square },
    { tool: 'draw-circle', label: '圆', Icon: Circle },
    { tool: 'draw-freehand', label: '自由线', Icon: Spline },
];

/**
 * Dropdown listing vector draw tools (point, line, polygon, shapes, freehand).
 *
 * @param props - Selection and close callbacks.
 * @returns Floating menu aligned under the parent toolbar control.
 */
export function DrawToolMenu(props: DrawToolMenuProps): ReactElement {
    const { onSelect, onClose } = props;
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handlePointerDown = (ev: PointerEvent) => {
            const el = rootRef.current;
            if (!el || el.contains(ev.target as Node)) {
                return;
            }
            onClose();
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [onClose]);

    return (
        <div
            ref={rootRef}
            className="absolute left-0 top-full z-50 mt-1 min-w-[10rem] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-lg"
            role="menu"
            aria-label="绘制工具"
        >
            {OPTIONS.map(({ tool, label, Icon }) => (
                <button
                    key={tool}
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                    onClick={() => {
                        onSelect(tool);
                        onClose();
                    }}
                >
                    <Icon className="size-[18px] shrink-0 text-[var(--text-secondary)]" strokeWidth={2} aria-hidden />
                    <span>{label}</span>
                </button>
            ))}
        </div>
    );
}
