import { useStatusStore } from '@/stores/statusStore';

function Separator() {
    return (
        <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
            │
        </span>
    );
}

/**
 * Bottom status line: coordinates, zoom, tiles, FPS, memory.
 */
export function StatusBar() {
    const mouseCoord = useStatusStore((s) => s.mouseCoord);
    const zoom = useStatusStore((s) => s.zoom);
    const tiles = useStatusStore((s) => s.tiles);
    const fps = useStatusStore((s) => s.fps);
    const memory = useStatusStore((s) => s.memory);

    return (
        <footer
            className="h-7 flex items-center px-3 gap-0 text-xs bg-[var(--bg-panel)] border-t border-[var(--border)] text-[var(--text-secondary)] shrink-0 overflow-x-auto"
            role="contentinfo"
        >
            <span className="whitespace-nowrap">📍 {mouseCoord}</span>
            <Separator />
            <span className="whitespace-nowrap">z:{zoom}</span>
            <Separator />
            <span className="whitespace-nowrap">⬡ {tiles}</span>
            <Separator />
            <span className="whitespace-nowrap">{fps}fps</span>
            <Separator />
            <span className="whitespace-nowrap">{memory}MB</span>
        </footer>
    );
}
