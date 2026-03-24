import { DataDrivenEditor } from '@/components/style/DataDrivenEditor';
import { FillStyleEditor } from '@/components/style/FillStyleEditor';
import { FilterEditor } from '@/components/style/FilterEditor';
import { CircleStyleEditor } from '@/components/style/CircleStyleEditor';
import { ExtrusionStyleEditor } from '@/components/style/ExtrusionStyleEditor';
import { HeatmapStyleEditor } from '@/components/style/HeatmapStyleEditor';
import { LineStyleEditor } from '@/components/style/LineStyleEditor';
import { RasterStyleEditor } from '@/components/style/RasterStyleEditor';
import { StylePresets } from '@/components/style/StylePresets';
import { SymbolStyleEditor } from '@/components/style/SymbolStyleEditor';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link StyleEditor}.
 */
export interface StyleEditorProps {
  /** Layer to edit (dispatches on `layer.type`). */
  layer: LayerConfig;
}

/**
 * Routes to the correct paint editor, then appends data-driven, filter, and preset sections.
 *
 * @param props - {@link StyleEditorProps}
 * @returns Full style editor column.
 */
export function StyleEditor(props: StyleEditorProps): ReactElement {
  const { layer } = props;

  let body: ReactElement;
  switch (layer.type) {
    case 'fill':
      body = <FillStyleEditor layer={layer} />;
      break;
    case 'line':
      body = <LineStyleEditor layer={layer} />;
      break;
    case 'circle':
      body = <CircleStyleEditor layer={layer} />;
      break;
    case 'symbol':
      body = <SymbolStyleEditor layer={layer} />;
      break;
    case 'raster':
      body = <RasterStyleEditor layer={layer} />;
      break;
    case 'extrusion':
      body = <ExtrusionStyleEditor layer={layer} />;
      break;
    case 'heatmap':
      body = <HeatmapStyleEditor layer={layer} />;
      break;
    case '3d-tiles':
      body = (
        <p className="text-xs text-[var(--text-muted)] py-4">
          此图层类型（3D Tiles）暂不支持在此面板编辑样式。
        </p>
      );
      break;
    default:
      body = (
        <p className="text-xs text-[var(--text-muted)] py-4">未知图层类型，无法编辑样式。</p>
      );
      break;
  }

  return (
    <div className="flex flex-col gap-0">
      {body}
      <DataDrivenEditor layer={layer} />
      <FilterEditor layer={layer} />
      <StylePresets layer={layer} />
    </div>
  );
}
