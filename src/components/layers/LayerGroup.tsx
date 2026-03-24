import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronRight, FolderClosed, FolderOpen } from 'lucide-react';
import { useCallback, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { LayerItem } from '@/components/layers/LayerItem';
import { useLayerStore } from '@/stores/layerStore';
import type { LayerGroup as LayerGroupModel } from '@/types';

/**
 * Props for a collapsible layer group row and its sortable children.
 */
export interface LayerGroupProps {
  /** Group model from the layer store. */
  group: LayerGroupModel;
}

/**
 * Collapsible folder with group visibility controls and per-layer rows.
 *
 * @param props - Contains the `group` tree node.
 * @returns Group container with optional sortable layer list.
 */
export function LayerGroup({ group }: LayerGroupProps) {
  const toggleGroupCollapsed = useLayerStore((s) => s.toggleGroupCollapsed);
  const setLayerVisibility = useLayerStore((s) => s.setLayerVisibility);

  const items = useMemo(() => group.layers.map((l) => l.id), [group.layers]);

  const allVisibleNonExclusive =
    group.layers.length > 0 && group.layers.every((l) => l.visible);
  const anyVisible = group.layers.some((l) => l.visible);

  const onHeaderCheckboxChange = useCallback(() => {
    if (group.exclusive) {
      if (anyVisible) {
        for (const l of group.layers) {
          setLayerVisibility(l.id, false);
        }
      } else if (group.layers[0]) {
        for (const l of group.layers) {
          setLayerVisibility(l.id, l.id === group.layers[0].id);
        }
      }
      return;
    }
    const next = !allVisibleNonExclusive;
    for (const l of group.layers) {
      setLayerVisibility(l.id, next);
    }
  }, [allVisibleNonExclusive, anyVisible, group.exclusive, group.layers, setLayerVisibility]);

  const headerChecked = group.exclusive ? anyVisible : allVisibleNonExclusive;

  const onHeaderClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,button')) {
        return;
      }
      toggleGroupCollapsed(group.id);
    },
    [group.id, toggleGroupCollapsed],
  );

  const FolderIcon = group.collapsed ? FolderClosed : FolderOpen;

  return (
    <section className="border-b border-[var(--border)] last:border-b-0" aria-label={group.name}>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleGroupCollapsed(group.id);
          }
        }}
        onClick={onHeaderClick}
        className="flex cursor-pointer items-center gap-2 bg-[var(--group-header-bg)] px-2 py-1.5"
      >
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={headerChecked}
          onChange={onHeaderCheckboxChange}
          onClick={(e) => {
            e.stopPropagation();
          }}
          aria-label={`切换分组 ${group.name} 内所有图层可见性`}
        />
        <ChevronRight
          className={`size-3.5 shrink-0 text-[var(--text-secondary)] transition-transform ${
            group.collapsed ? '' : 'rotate-90'
          }`}
          strokeWidth={2}
          aria-hidden
        />
        <FolderIcon className="size-3.5 shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          {group.name}
        </span>
      </div>

      {!group.collapsed ? (
        <div className="px-1 py-1">
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            {group.layers.map((layer) => (
              <LayerItem
                key={layer.id}
                layer={layer}
                groupId={group.id}
                exclusive={group.exclusive}
              />
            ))}
          </SortableContext>
          {group.layers.length === 0 ? (
            <div className="px-2 py-2 text-xs text-[var(--text-muted)]">该分组暂无图层</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
