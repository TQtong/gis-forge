import { EmptyState } from '@/components/common/EmptyState';
import { StyleEditor } from '@/components/style/StyleEditor';
import { useLayerStore } from '@/stores/layerStore';
import type { LayerConfig, LayerKind } from '@/types';
import { Palette, RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';

/**
 * Build default `paint` for a layer kind (used by reset).
 *
 * @param type - Layer renderer kind.
 * @returns Default paint object for that kind.
 */
function defaultPaintForKind(type: LayerKind): Record<string, unknown> {
  switch (type) {
    case 'fill':
      return {
        'fill-color': '#4A90D9',
        'fill-opacity': 0.7,
        'fill-outline-color': '#2A5A8A',
        'fill-outline-width': 1,
      };
    case 'line':
      return {
        'line-color': '#FF6600',
        'line-width': 3,
        'line-opacity': 0.8,
        'line-cap': 'round',
        'line-join': 'round',
      };
    case 'circle':
      return {
        'circle-radius': 6,
        'circle-color': '#E74C3C',
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 1,
        'circle-opacity': 0.8,
      };
    case 'symbol':
      return {
        'text-size': 14,
        'text-color': '#333333',
        'text-halo-color': '#FFFFFF',
        'text-halo-width': 1,
      };
    case 'raster':
      return {
        'raster-opacity': 1,
        'raster-brightness-min': 0,
        'raster-brightness-max': 1,
        'raster-contrast': 0,
        'raster-saturation': 0,
        'raster-hue-rotate': 0,
      };
    case 'extrusion':
      return {
        'fill-extrusion-color': '#8B7355',
        'fill-extrusion-base': 0,
        'fill-extrusion-height': 20,
        'fill-extrusion-opacity': 0.8,
      };
    case 'heatmap':
      return {
        'heatmap-radius': 30,
        'gf-heatmap-weight-field': 'none',
        'heatmap-intensity': 1,
        'heatmap-opacity': 0.7,
        'gf-heatmap-color-ramp-id': 'heat',
        'gf-heatmap-color-ramp': [
          '#313695',
          '#4575b4',
          '#74add1',
          '#abd9e9',
          '#fee090',
          '#fdae61',
          '#f46d43',
          '#d73027',
        ],
      };
    case '3d-tiles':
      return {};
    default:
      return {};
  }
}

/**
 * Default layout fields for reset (symbol text field, icon preset, extrusion flags).
 *
 * @param type - Layer kind.
 * @returns Default layout patch merged on reset.
 */
function defaultLayoutForKind(type: LayerKind): Record<string, unknown> {
  switch (type) {
    case 'symbol':
      return { 'text-field': 'name', 'gf-icon-preset': 'marker' };
    case 'extrusion':
      return {
        'gf-extrusion-height-by-property': false,
        'gf-extrusion-height-property': 'height',
      };
    default:
      return {};
  }
}

/**
 * Right-panel “样式” tab: empty state or full {@link StyleEditor} for the selected layer.
 *
 * @returns Style tab content.
 */
export function StyleTab(): ReactElement {
  const selectedLayerId = useLayerStore((s) => s.selectedLayerId);
  const updateLayer = useLayerStore((s) => s.updateLayer);

  const layer: LayerConfig | undefined = useLayerStore((s) => {
    if (!s.selectedLayerId) {
      return undefined;
    }
    return s.getLayerById(s.selectedLayerId);
  });

  const handleReset = useCallback(() => {
    if (!layer) {
      return;
    }
    const paint = defaultPaintForKind(layer.type);
    const layout = { ...layer.layout, ...defaultLayoutForKind(layer.type) };
    updateLayer(layer.id, {
      paint,
      layout,
      filter: [],
      minzoom: 0,
      maxzoom: 24,
    });
  }, [layer, updateLayer]);

  const title = useMemo(() => {
    if (!layer) {
      return '';
    }
    return `🎨 ${layer.name} (${layer.type})`;
  }, [layer]);

  if (!selectedLayerId || !layer) {
    return (
      <EmptyState
        icon={Palette}
        title="在图层列表中点击图层名"
        description="编辑该图层的样式"
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <h2 className="text-xs font-semibold text-[var(--text-primary)] truncate" title={title}>
          {title}
        </h2>
        <button
          type="button"
          onClick={handleReset}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
          aria-label="重置样式"
        >
          <RotateCcw size={14} aria-hidden />
          Reset
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        <StyleEditor layer={layer} />
      </div>
    </div>
  );
}
