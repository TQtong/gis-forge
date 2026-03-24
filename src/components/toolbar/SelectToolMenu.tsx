import { useEffect, useRef, type ReactElement } from 'react';
import { Lasso, MousePointer, SquareDashed } from 'lucide-react';
import type { ToolType } from '@/types';

/**
 * Props for the selection-tool dropdown panel.
 */
export interface SelectToolMenuProps {
    /** Invoked when the user picks a selection mode. */
    onSelect: (tool: ToolType) => void;
    /** Invoked when the menu should close. */
    onClose: () => void;
}

const OPTIONS: { tool: ToolType; label: string; Icon: typeof MousePointer }[] = [
    { tool: 'select-click', label: '单击选择', Icon: MousePointer },
    { tool: 'select-box', label: '框选', Icon: SquareDashed },
    { tool: 'select-lasso', label: '套索', Icon: Lasso },
];

/**
 * Dropdown listing click, box, and lasso selection modes.
 *
 * @param props - Selection and close callbacks.
 * @returns Floating menu under the select toolbar control.
 */
export function SelectToolMenu(props: SelectToolMenuProps): ReactElement {
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
            aria-label="选择工具"
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
