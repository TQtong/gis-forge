import { ColorPicker } from '@/components/style/ColorPicker';
import { patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link CircleStyleEditor}.
 */
export interface CircleStyleEditorProps {
  /** Layer being edited (type should be `circle`). */
  layer: LayerConfig;
}

const DEFAULT_RADIUS = 6;
const DEFAULT_COLOR = '#E74C3C';
const DEFAULT_STROKE = '#FFFFFF';
const DEFAULT_STROKE_WIDTH = 1;
const DEFAULT_OPACITY = 0.8;

/**
 * Circle layer paint: radius, fill/stroke colors, stroke width, opacity.
 *
 * @param props - {@link CircleStyleEditorProps}
 * @returns Circle style editor UI.
 */
export function CircleStyleEditor(props: CircleStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;

  const radius =
    typeof p['circle-radius'] === 'number' && Number.isFinite(p['circle-radius'])
      ? p['circle-radius']
      : DEFAULT_RADIUS;
  const color = typeof p['circle-color'] === 'string' ? p['circle-color'] : DEFAULT_COLOR;
  const stroke =
    typeof p['circle-stroke-color'] === 'string' ? p['circle-stroke-color'] : DEFAULT_STROKE;
  const strokeWidth =
    typeof p['circle-stroke-width'] === 'number' && Number.isFinite(p['circle-stroke-width'])
      ? p['circle-stroke-width']
      : DEFAULT_STROKE_WIDTH;
  const opacity =
    typeof p['circle-opacity'] === 'number' && Number.isFinite(p['circle-opacity'])
      ? p['circle-opacity']
      : DEFAULT_OPACITY;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">半径</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={radius}
            onChange={(e) => patchPaint(layer, { 'circle-radius': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={1}
            aria-valuemax={30}
            aria-valuenow={radius}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {radius}px
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">颜色</label>
        <div>
          <ColorPicker color={color} onChange={(c) => patchPaint(layer, { 'circle-color': c })} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">轮廓颜色</label>
        <div>
          <ColorPicker
            color={stroke}
            onChange={(c) => patchPaint(layer, { 'circle-stroke-color': c })}
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
            value={strokeWidth}
            onChange={(e) => patchPaint(layer, { 'circle-stroke-width': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={strokeWidth}
          />
          <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {strokeWidth}px
          </span>
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
            value={opacity}
            onChange={(e) => patchPaint(layer, { 'circle-opacity': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={opacity}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {opacity.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
