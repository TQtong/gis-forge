import { AddLayerDialog } from '@/components/layers/AddLayerDialog';
import { AnnotationList } from '@/components/layers/AnnotationList';
import { BookmarkList } from '@/components/layers/BookmarkList';
import { LayerList } from '@/components/layers/LayerList';
import { TerrainControl } from '@/components/layers/TerrainControl';

/**
 * Left dock: layer list, add-layer dialog host, and terrain controls.
 */
export function LeftPanel() {
  return (
    <aside
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-panel)]"
      aria-label="图层面板"
    >
      <LayerList />
      <TerrainControl />
      <BookmarkList />
      <AnnotationList />
      <AddLayerDialog />
    </aside>
  );
}
