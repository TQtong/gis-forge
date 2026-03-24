import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Box,
  Circle,
  Flame,
  GripVertical,
  Hexagon,
  Loader2,
  Map,
  MoreVertical,
  Route,
  Type,
} from 'lucide-react';
import { useCallback, useId, useState, type ChangeEvent } from 'react';
import { LayerContextMenu } from '@/components/layers/LayerContextMenu';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig, LayerKind } from '@/types';

/**
 * Props for a single draggable layer row (visibility, opacity, selection, error/loading).
 */
export interface LayerItemProps {
  /** Layer configuration from the document. */
  layer: LayerConfig;
  /** Parent group id for context actions and ordering. */
  groupId: string;
  /** When true, basemap radio semantics (only one visible at a time). */
  exclusive?: boolean;
}

/**
 * Maps engine layer kinds to toolbar icons.
 *
 * @param kind - Layer renderer kind.
 * @returns Lucide icon component for the row.
 */
function iconForLayerKind(kind: LayerKind) {
  switch (kind) {
    case 'raster':
      return Map;
    case 'line':
      return Route;
    case 'circle':
      return Circle;
    case 'symbol':
      return Type;
    case 'fill':
      return Hexagon;
    case 'extrusion':
      return Box;
    case 'heatmap':
      return Flame;
    case '3d-tiles':
      return Box;
    default:
      return Map;
  }
}

/**
 * One layer row: drag handle, visibility control, icon, name, opacity slider on hover, overflow menu.
 *
 * @param props - Row props including `layer` and optional `exclusive` basemap mode.
 * @returns Sortable list row element.
 */
export function LayerItem({ layer, groupId, exclusive = false }: LayerItemProps) {
  const setLayerVisibility = useLayerStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useLayerStore((s) => s.setLayerOpacity);
  const setSelectedLayerId = useLayerStore((s) => s.setSelectedLayerId);
  const updateLayer = useLayerStore((s) => s.updateLayer);
  const selectedLayerId = useLayerStore((s) => s.selectedLayerId);
  const groups = useLayerStore((s) => s.groups);
  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: layer.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  };

  const Icon = iconForLayerKind(layer.type);
  const isSelected = selectedLayerId === layer.id;
  const radioName = `basemap-group-${groupId}`;
  const rowId = useId();

  const hideSiblings = useCallback(() => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) {
      return;
    }
    for (const l of g.layers) {
      setLayerVisibility(l.id, l.id === layer.id);
    }
  }, [groupId, groups, layer.id, setLayerVisibility]);

  const onToggleVisibility = useCallback(() => {
    if (exclusive) {
      if (!layer.visible) {
        hideSiblings();
      } else {
        setLayerVisibility(layer.id, false);
      }
      return;
    }
    setLayerVisibility(layer.id, !layer.visible);
  }, [exclusive, hideSiblings, layer.id, layer.visible, setLayerVisibility]);

  const onNameClick = useCallback(() => {
    setSelectedLayerId(layer.id);
    setRightPanelTab('style');
  }, [layer.id, setRightPanelTab, setSelectedLayerId]);

  const onOpacityInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number.parseFloat(e.target.value);
      if (!Number.isFinite(v)) {
        return;
      }
      setLayerOpacity(layer.id, v);
    },
    [layer.id, setLayerOpacity],
  );

  const onMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    setMenuOpen(true);
  }, []);

  const onRetry = useCallback(() => {
    updateLayer(layer.id, { error: null, loading: true });
  }, [layer.id, updateLayer]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-[var(--bg-panel-hover)] ${
        isSelected ? 'ring-1 ring-[var(--accent)]/40' : ''
      }`}
    >
      <button
        type="button"
        className="cursor-grab touch-none p-0.5 text-[var(--text-muted)] opacity-40 hover:opacity-100"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" strokeWidth={2} />
      </button>

      {exclusive ? (
        <input
          aria-labelledby={`${rowId}-name`}
          className="accent-[var(--accent)]"
          type="radio"
          name={radioName}
          checked={layer.visible}
          onChange={() => {
            hideSiblings();
          }}
        />
      ) : (
        <input
          aria-labelledby={`${rowId}-name`}
          className="accent-[var(--accent)]"
          type="checkbox"
          checked={layer.visible}
          onChange={onToggleVisibility}
        />
      )}

      <Icon className="size-3.5 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />

      <button
        id={`${rowId}-name`}
        type="button"
        onClick={onNameClick}
        className={`min-w-0 flex-1 truncate text-left text-sm ${
          layer.error ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'
        }`}
      >
        {layer.loading ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" aria-hidden />
            <span className="truncate">{layer.name}</span>
          </span>
        ) : (
          layer.name
        )}
      </button>

      {layer.error ? (
        <span className="flex shrink-0 items-center gap-1">
          <AlertTriangle className="size-3.5 text-[var(--error)]" aria-hidden />
          <button
            type="button"
            onClick={onRetry}
            className="rounded px-1 text-xs text-[var(--accent)] hover:underline"
          >
            重试
          </button>
        </span>
      ) : null}

      <div className="flex w-16 items-center opacity-0 transition-opacity group-hover:opacity-100">
        <label className="sr-only" htmlFor={`${rowId}-opacity`}>
          透明度
        </label>
        <input
          id={`${rowId}-opacity`}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={layer.opacity}
          onChange={onOpacityInput}
          className="h-1 w-16 cursor-pointer accent-[var(--accent)]"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={layer.opacity}
        />
      </div>

      <button
        type="button"
        aria-label="图层操作"
        onClick={onMenuButtonClick}
        className="shrink-0 rounded p-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]"
      >
        <MoreVertical className="size-3.5" strokeWidth={2} />
      </button>

      {menuOpen ? (
        <LayerContextMenu
          layerId={layer.id}
          position={menuPos}
          onClose={() => {
            setMenuOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
