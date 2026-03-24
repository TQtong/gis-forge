import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import type { LayerConfig, LayerKind } from '@/types';
import { useLayerStore } from '@/stores/layerStore';
import { parseFile, isSupportedFormat } from '@/utils/fileParser';
import { showError } from '@/components/common/Toast';

/**
 * Inline GeoJSON payload stored in `paint` until the engine reads it (shell integration).
 * Prefix avoids collisions with style-spec keys.
 */
const INLINE_GEOJSON_KEY = '_gf_inlineGeojson';

/**
 * Props for the drag-and-drop overlay bound to a map container ref.
 */
export interface FileDragOverlayProps {
  /** Map or shell container receiving drag events (typically `MapViewport` root). */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * Infers a renderer {@link LayerKind} from GeoJSON structure (first feature wins).
 *
 * @param data - Parsed GeoJSON object.
 * @returns Layer kind for `LayerConfig.type`.
 */
function inferLayerKind(data: unknown): LayerKind {
  const gj = data as {
    type?: string;
    features?: { geometry?: { type?: string } }[];
    geometry?: { type?: string };
  };
  if (gj.type === 'Feature' && gj.geometry?.type) {
    const t = gj.geometry.type;
    if (t === 'Point' || t === 'MultiPoint') {
      return 'circle';
    }
    if (t === 'LineString' || t === 'MultiLineString') {
      return 'line';
    }
    return 'fill';
  }
  if (gj.type === 'FeatureCollection' && Array.isArray(gj.features)) {
    for (const f of gj.features) {
      const t = f.geometry?.type;
      if (t === 'Point' || t === 'MultiPoint') {
        return 'circle';
      }
      if (t === 'LineString' || t === 'MultiLineString') {
        return 'line';
      }
      if (t === 'Polygon' || t === 'MultiPolygon') {
        return 'fill';
      }
    }
  }
  return 'fill';
}

/**
 * Adds a user-dropped file as a vector layer in the `vector` group.
 *
 * @param file - Original file reference.
 * @param data - GeoJSON-compatible object from {@link parseFile}.
 */
function addFileLayer(file: File, data: unknown): void {
  const kind = inferLayerKind(data);
  const id = `layer-file-${Date.now().toString(36)}`;
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const name = baseName.length > 0 ? baseName : file.name;

  const paint: Record<string, unknown> =
    kind === 'fill'
      ? {
          'fill-color': '#53a8b6',
          'fill-opacity': 0.4,
          [INLINE_GEOJSON_KEY]: data,
        }
      : kind === 'line'
        ? {
            'line-color': '#53a8b6',
            'line-width': 2,
            [INLINE_GEOJSON_KEY]: data,
          }
        : {
            'circle-radius': 6,
            'circle-color': '#53a8b6',
            'circle-opacity': 0.9,
            [INLINE_GEOJSON_KEY]: data,
          };

  const layer: LayerConfig = {
    id,
    name,
    type: kind,
    sourceId: `source-${id}`,
    visible: true,
    opacity: 1,
    paint,
    layout: {},
    filter: [],
    minzoom: 0,
    maxzoom: 24,
    error: null,
    loading: false,
  };

  useLayerStore.getState().addLayer('vector', layer);
}

/**
 * Full-screen drag overlay for GeoJSON/CSV/KML/GPX drops; adds layers on success.
 *
 * @param props - Container ref for event binding.
 * @returns Overlay markup while dragging, or null when idle.
 */
export function FileDragOverlay(props: FileDragOverlayProps): ReactElement | null {
  const { containerRef } = props;
  const [active, setActive] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    const isFileDrag = (e: globalThis.DragEvent): boolean => {
      return Array.from(e.dataTransfer?.types ?? []).includes('Files');
    };

    const onDragEnter = (e: globalThis.DragEvent): void => {
      if (!isFileDrag(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current += 1;
      setActive(true);
    };

    const onDragOver = (e: globalThis.DragEvent): void => {
      if (!isFileDrag(e)) {
        return;
      }
      const dt = e.dataTransfer;
      if (!dt) {
        return;
      }
      e.preventDefault();
      dt.dropEffect = 'copy';
    };

    const onDragLeave = (e: globalThis.DragEvent): void => {
      if (!isFileDrag(e)) {
        return;
      }
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setActive(false);
      }
    };

    const onDrop = async (e: globalThis.DragEvent): Promise<void> => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) {
        return;
      }

      for (const file of files) {
        if (!isSupportedFormat(file.name)) {
          showError('不支持的文件格式', `无法加载：${file.name}`);
          continue;
        }
        try {
          const parsed = await parseFile(file);
          addFileLayer(file, parsed.data);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showError('文件解析失败', msg);
        }
      }
    };

    const opts = { capture: false };
    el.addEventListener('dragenter', onDragEnter, opts);
    el.addEventListener('dragover', onDragOver, opts);
    el.addEventListener('dragleave', onDragLeave, opts);
    el.addEventListener('drop', onDrop, opts);

    return () => {
      el.removeEventListener('dragenter', onDragEnter, opts);
      el.removeEventListener('dragover', onDragOver, opts);
      el.removeEventListener('dragleave', onDragLeave, opts);
      el.removeEventListener('drop', onDrop, opts);
    };
  }, [containerRef]);

  if (!active) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[40] flex flex-col items-center justify-center border-2 border-dashed border-[var(--accent)] bg-[var(--drag-overlay)]"
      role="status"
      aria-live="polite"
    >
      <p className="text-base font-medium text-[var(--text-primary)]">📂 释放以加载数据</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        支持：.geojson · .json · .csv · .kml · .gpx
      </p>
    </div>
  );
}
