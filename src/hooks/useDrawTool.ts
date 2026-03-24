import { useCallback, useEffect, useState } from 'react';
import type { Annotation, GeoJsonGeometry, ToolType } from '@/types';
import { useMapStore } from '@/stores/mapStore';

/** Default stroke color for user-drawn annotations (matches accent usage in UI). */
const DEFAULT_ANNOTATION_COLOR = 'var(--accent)';

/**
 * Build GeoJSON geometry from accumulated vertices for the active draw tool.
 *
 * @param tool - Current draw tool key.
 * @param points - Vertices in map CRS (typically `[lng, lat]`).
 * @returns Geometry or null when too few points for the tool.
 */
function buildGeometry(tool: ToolType, points: number[][]): GeoJsonGeometry | null {
    if (!points.length) {
        return null;
    }
    if (tool === 'draw-point') {
        const p = points[0]!;
        return { type: 'Point', coordinates: [p[0], p[1]] };
    }
    if (tool === 'draw-line' || tool === 'draw-freehand') {
        if (points.length < 2) {
            return null;
        }
        return { type: 'LineString', coordinates: points.map((c) => [c[0], c[1]]) };
    }
    if (tool === 'draw-polygon') {
        if (points.length < 3) {
            return null;
        }
        const ring = points.map((c) => [c[0], c[1]]);
        const first = ring[0]!;
        const last = ring[ring.length - 1]!;
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([first[0], first[1]]);
        }
        return { type: 'Polygon', coordinates: [ring] };
    }
    if (tool === 'draw-rect') {
        if (points.length < 2) {
            return null;
        }
        const [a, b] = [points[0]!, points[1]!];
        const minX = Math.min(a[0]!, b[0]!);
        const maxX = Math.max(a[0]!, b[0]!);
        const minY = Math.min(a[1]!, b[1]!);
        const maxY = Math.max(a[1]!, b[1]!);
        const ring = [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
        ];
        return { type: 'Polygon', coordinates: [ring] };
    }
    if (tool === 'draw-circle') {
        if (points.length < 2) {
            return null;
        }
        const center = points[0]!;
        const edge = points[1]!;
        const dx = edge[0]! - center[0]!;
        const dy = edge[1]! - center[1]!;
        const radiusDeg = Math.sqrt(dx * dx + dy * dy);
        if (radiusDeg <= 0) {
            return null;
        }
        const latRad = (center[1]! * Math.PI) / 180;
        const cosLat = Math.max(0.01, Math.cos(latRad));
        const ring: number[][] = [];
        const segments = 32;
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const lng = center[0]! + (radiusDeg / cosLat) * Math.cos(t);
            const lat = center[1]! + radiusDeg * Math.sin(t);
            ring.push([lng, lat]);
        }
        return { type: 'Polygon', coordinates: [ring] };
    }
    return null;
}

/**
 * Map draw tool key to annotation record type.
 *
 * @param tool - Active draw tool.
 * @returns Annotation type discriminator.
 */
function annotationKindFromTool(tool: ToolType): Annotation['type'] {
    if (tool === 'draw-point') {
        return 'point';
    }
    if (tool === 'draw-line' || tool === 'draw-freehand') {
        return 'line';
    }
    return 'polygon';
}

/**
 * State and actions for vector drawing tools (point, line, polygon, shapes, freehand).
 *
 * @returns Drawing state, vertex buffer, and lifecycle helpers.
 */
export function useDrawTool(): {
    isDrawing: boolean;
    points: number[][];
    currentType: ToolType | null;
    addPoint: (coord: number[]) => void;
    undo: () => void;
    finish: () => void;
    cancel: () => void;
} {
    const activeTool = useMapStore((s) => s.activeTool);
    const setActiveTool = useMapStore((s) => s.setActiveTool);
    const addAnnotation = useMapStore((s) => s.addAnnotation);

    const [points, setPoints] = useState<number[][]>([]);
    const [currentType, setCurrentType] = useState<ToolType | null>(null);

    useEffect(() => {
        if (activeTool.startsWith('draw-')) {
            setCurrentType(activeTool);
            setPoints([]);
        } else {
            setCurrentType(null);
            setPoints([]);
        }
    }, [activeTool]);

    const isDrawing = points.length > 0 && currentType !== null && activeTool.startsWith('draw-');

    const addPoint = useCallback((coord: number[]) => {
        if (!activeTool.startsWith('draw-')) {
            return;
        }
        if (!Array.isArray(coord) || coord.length < 2) {
            return;
        }
        const x = Number(coord[0]);
        const y = Number(coord[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        setPoints((prev) => [...prev, [x, y]]);
    }, [activeTool]);

    const undo = useCallback(() => {
        setPoints((prev) => (prev.length ? prev.slice(0, -1) : prev));
    }, []);

    const cancel = useCallback(() => {
        setPoints([]);
        setActiveTool('pan');
    }, [setActiveTool]);

    const finish = useCallback(() => {
        const tool = activeTool.startsWith('draw-') ? activeTool : currentType;
        if (!tool || !tool.startsWith('draw-')) {
            setPoints([]);
            setActiveTool('pan');
            return;
        }
        const geometry = buildGeometry(tool, points);
        if (!geometry) {
            return;
        }
        const annotation: Annotation = {
            id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ann-${Date.now()}`,
            type: annotationKindFromTool(tool),
            geometry,
            label: tool,
            style: { color: DEFAULT_ANNOTATION_COLOR, width: 2, opacity: 1 },
            createdAt: Date.now(),
        };
        addAnnotation(annotation);
        setPoints([]);
        setActiveTool('pan');
    }, [activeTool, currentType, points, addAnnotation, setActiveTool]);

    return {
        isDrawing,
        points,
        currentType,
        addPoint,
        undo,
        finish,
        cancel,
    };
}
