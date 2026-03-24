import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { Layers, Plus, Search } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { EmptyState } from '@/components/common/EmptyState';
import { LayerGroup } from '@/components/layers/LayerGroup';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerGroup as LayerGroupModel } from '@/types';

/**
 * Finds which group contains a layer id.
 *
 * @param groups - Current layer groups.
 * @param layerId - Target layer id.
 * @returns Group id or undefined when not found.
 */
function findGroupIdForLayer(groups: LayerGroupModel[], layerId: string): string | undefined {
  for (const g of groups) {
    if (g.layers.some((l) => l.id === layerId)) {
      return g.id;
    }
  }
  return undefined;
}

/**
 * Top-level layer tree: search, add layer, and grouped draggable rows.
 *
 * @returns Scrollable layer list for the left panel.
 */
export function LayerList() {
  const groups = useLayerStore((s) => s.groups);
  const reorderLayers = useLayerStore((s) => s.reorderLayers);
  const moveLayer = useLayerStore((s) => s.moveLayer);
  const setAddLayerDialogOpen = useUIStore((s) => s.setAddLayerDialogOpen);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return groups;
    }
    return groups
      .map((g) => ({
        ...g,
        layers: g.layers.filter((l) => l.name.toLowerCase().includes(q)),
      }))
      .filter((g) => g.layers.length > 0);
  }, [groups, searchQuery]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) {
        return;
      }
      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) {
        return;
      }

      const fromGroupId = findGroupIdForLayer(groups, activeId);
      const toGroupId = findGroupIdForLayer(groups, overId);
      if (!fromGroupId || !toGroupId) {
        return;
      }

      const fromGroup = groups.find((g) => g.id === fromGroupId);
      const toGroup = groups.find((g) => g.id === toGroupId);
      if (!fromGroup || !toGroup) {
        return;
      }

      if (fromGroupId === toGroupId) {
        const ids = fromGroup.layers.map((l) => l.id);
        const oldIndex = ids.indexOf(activeId);
        const newIndex = ids.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
          return;
        }
        reorderLayers(fromGroupId, arrayMove(ids, oldIndex, newIndex));
        return;
      }

      const toIndex = toGroup.layers.findIndex((l) => l.id === overId);
      const insertIndex = toIndex >= 0 ? toIndex : toGroup.layers.length;
      moveLayer(fromGroupId, toGroupId, activeId, insertIndex);
    },
    [groups, moveLayer, reorderLayers],
  );

  const showEmpty = filteredGroups.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          图层
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="搜索图层"
            aria-label="搜索图层"
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
            }}
            className={`rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] ${
              searchOpen ? 'bg-[var(--bg-panel-hover)] text-[var(--text-primary)]' : ''
            }`}
          >
            <Search className="size-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            title="添加图层"
            aria-label="添加图层"
            onClick={() => {
              setAddLayerDialogOpen(true);
            }}
            className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
          >
            <Plus className="size-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <div className="border-b border-[var(--border)] px-3 py-2">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            placeholder="搜索图层..."
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showEmpty ? (
          <EmptyState
            icon={Layers}
            title="无匹配图层"
            description="调整搜索关键词，或通过右上角“+”添加图层。"
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            {filteredGroups.map((g) => (
              <LayerGroup key={g.id} group={g} />
            ))}
          </DndContext>
        )}
      </div>
    </div>
  );
}
