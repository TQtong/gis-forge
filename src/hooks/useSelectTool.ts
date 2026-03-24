import { useEffect, useRef, useState } from 'react';
import { useMapStore } from '@/stores/mapStore';

/**
 * Normalized box selection in client pixel space (mock until engine wiring).
 */
export type SelectionBoxClient = { x: number; y: number; width: number; height: number };

/**
 * Tracks mock box / lasso selection gestures for `select-box` and `select-lasso` tools.
 *
 * @returns Selection state for overlays (no engine integration yet).
 */
export function useSelectTool(): {
    isSelecting: boolean;
    selectionBox: SelectionBoxClient | null;
    lassoPoints: { x: number; y: number }[];
} {
    const activeTool = useMapStore((s) => s.activeTool);

    const [isSelecting, setIsSelecting] = useState(false);
    const [selectionBox, setSelectionBox] = useState<SelectionBoxClient | null>(null);
    const [lassoPoints, setLassoPoints] = useState<{ x: number; y: number }[]>([]);

    const startRef = useRef<{ x: number; y: number } | null>(null);

    const enabledBox = activeTool === 'select-box';
    const enabledLasso = activeTool === 'select-lasso';

    useEffect(() => {
        if (!enabledBox) {
            setIsSelecting(false);
            setSelectionBox(null);
            startRef.current = null;
        }
    }, [enabledBox]);

    useEffect(() => {
        if (!enabledLasso) {
            setIsSelecting(false);
            setLassoPoints([]);
            startRef.current = null;
        }
    }, [enabledLasso]);

    useEffect(() => {
        if (!enabledBox) return;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            startRef.current = { x: e.clientX, y: e.clientY };
            setIsSelecting(true);
            setSelectionBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
        };

        const onMouseMove = (e: MouseEvent) => {
            const start = startRef.current;
            if (!start || !enabledBox) return;
            const x1 = Math.min(start.x, e.clientX);
            const y1 = Math.min(start.y, e.clientY);
            const x2 = Math.max(start.x, e.clientX);
            const y2 = Math.max(start.y, e.clientY);
            setSelectionBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
        };

        const onMouseUp = () => {
            startRef.current = null;
            setIsSelecting(false);
        };

        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [enabledBox]);

    useEffect(() => {
        if (!enabledLasso) return;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            startRef.current = { x: e.clientX, y: e.clientY };
            setIsSelecting(true);
            setLassoPoints([{ x: e.clientX, y: e.clientY }]);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!startRef.current || !enabledLasso) return;
            setLassoPoints((pts) => [...pts, { x: e.clientX, y: e.clientY }]);
        };

        const onMouseUp = () => {
            startRef.current = null;
            setIsSelecting(false);
        };

        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [enabledLasso]);

    return {
        isSelecting,
        selectionBox,
        lassoPoints,
    };
}
