import { ColorPicker } from '@/components/style/ColorPicker';
import { patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link FillStyleEditor}.
 */
export interface FillStyleEditorProps {
  /** Layer being edited (type should be `fill`). */
  layer: LayerConfig;
}

const DEFAULT_FILL_COLOR = '#4A90D9';
const DEFAULT_FILL_OPACITY = 0.7;
const DEFAULT_OUTLINE_COLOR = '#2A5A8A';
const DEFAULT_OUTLINE_WIDTH = 1;

/**
 * Polygon fill paint controls: fill color/opacity and outline color/width.
 *
 * @param props - {@link FillStyleEditorProps}
 * @returns Fill style editor UI.
 */
export function FillStyleEditor(props: FillStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;

  const fillColor = typeof p['fill-color'] === 'string' ? p['fill-color'] : DEFAULT_FILL_COLOR;
  const fillOpacity =
    typeof p['fill-opacity'] === 'number' && Number.isFinite(p['fill-opacity'])
      ? p['fill-opacity']
      : DEFAULT_FILL_OPACITY;
  const outlineColor =
    typeof p['fill-outline-color'] === 'string' ? p['fill-outline-color'] : DEFAULT_OUTLINE_COLOR;
  const outlineWidth =
    typeof p['fill-outline-width'] === 'number' && Number.isFinite(p['fill-outline-width'])
      ? p['fill-outline-width']
      : DEFAULT_OUTLINE_WIDTH;

  return (
    <div className="flex flex-col">
      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mt-1 mb-1">
        ── 填充 ──
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">颜色</label>
        <div>
          <ColorPicker color={fillColor} onChange={(c) => patchPaint(layer, { 'fill-color': c })} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">透明度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={fillOpacity}
            onChange={(e) => patchPaint(layer, { 'fill-opacity': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={fillOpacity}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {fillOpacity.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mt-3 mb-1">
        ── 轮廓 ──
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">轮廓颜色</label>
        <div>
          <ColorPicker
            color={outlineColor}
            onChange={(c) => patchPaint(layer, { 'fill-outline-color': c })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">轮廓宽度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={outlineWidth}
            onChange={(e) => patchPaint(layer, { 'fill-outline-width': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={outlineWidth}
          />
          <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {outlineWidth}px
          </span>
        </div>
      </div>
    </div>
  );
}
