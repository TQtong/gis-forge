import { ColorPicker } from '@/components/style/ColorPicker';
import { patchPaint, removePaintKey } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link LineStyleEditor}.
 */
export interface LineStyleEditorProps {
  /** Layer being edited (type should be `line`). */
  layer: LayerConfig;
}

const DEFAULT_LINE_COLOR = '#FF6600';
const DEFAULT_LINE_WIDTH = 3;
const DEFAULT_LINE_OPACITY = 0.8;
const DEFAULT_CAP = 'round';
const DEFAULT_JOIN = 'round';

/**
 * Line layer paint: color, width, opacity, caps, joins, optional dash array.
 *
 * @param props - {@link LineStyleEditorProps}
 * @returns Line style editor UI.
 */
export function LineStyleEditor(props: LineStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;

  const lineColor = typeof p['line-color'] === 'string' ? p['line-color'] : DEFAULT_LINE_COLOR;
  const lineWidth =
    typeof p['line-width'] === 'number' && Number.isFinite(p['line-width'])
      ? p['line-width']
      : DEFAULT_LINE_WIDTH;
  const lineOpacity =
    typeof p['line-opacity'] === 'number' && Number.isFinite(p['line-opacity'])
      ? p['line-opacity']
      : DEFAULT_LINE_OPACITY;
  const lineCap =
    typeof p['line-cap'] === 'string' && ['butt', 'round', 'square'].includes(p['line-cap'])
      ? (p['line-cap'] as 'butt' | 'round' | 'square')
      : DEFAULT_CAP;
  const lineJoin =
    typeof p['line-join'] === 'string' && ['miter', 'round', 'bevel'].includes(p['line-join'])
      ? (p['line-join'] as 'miter' | 'round' | 'bevel')
      : DEFAULT_JOIN;
  const dash = Array.isArray(p['line-dasharray']) ? (p['line-dasharray'] as number[]) : null;
  const dashEnabled = dash !== null && dash.length > 0;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">颜色</label>
        <div>
          <ColorPicker color={lineColor} onChange={(c) => patchPaint(layer, { 'line-color': c })} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">宽度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.5}
            value={lineWidth}
            onChange={(e) => patchPaint(layer, { 'line-width': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0.5}
            aria-valuemax={20}
            aria-valuenow={lineWidth}
          />
          <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {lineWidth}px
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
            value={lineOpacity}
            onChange={(e) => patchPaint(layer, { 'line-opacity': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={lineOpacity}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {lineOpacity.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">线端</label>
        <div>
          <select
            value={lineCap}
            onChange={(e) =>
              patchPaint(layer, { 'line-cap': e.target.value as 'butt' | 'round' | 'square' })
            }
            className="max-w-[140px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
          >
            <option value="butt">butt</option>
            <option value="round">round</option>
            <option value="square">square</option>
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">拐角</label>
        <div>
          <select
            value={lineJoin}
            onChange={(e) =>
              patchPaint(layer, {
                'line-join': e.target.value as 'miter' | 'round' | 'bevel',
              })
            }
            className="max-w-[140px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
          >
            <option value="miter">miter</option>
            <option value="round">round</option>
            <option value="bevel">bevel</option>
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">虚线</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={dashEnabled}
            onClick={() => {
              if (dashEnabled) {
                removePaintKey(layer.id, 'line-dasharray');
              } else {
                patchPaint(layer, { 'line-dasharray': [10, 5] });
              }
            }}
            className={`rounded px-2 py-1 text-xs ${
              dashEnabled
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-input)] text-[var(--text-secondary)] border border-[var(--border)]'
            }`}
          >
            {dashEnabled ? '开' : '关'}
          </button>
        </div>
      </div>
      {dashEnabled ? (
        <div className="flex items-center justify-between gap-2 py-1.5">
          <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">虚线数组</label>
          <div className="flex gap-1">
            <input
              type="number"
              className="w-14 rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-xs text-[var(--text-primary)]"
              value={dash?.[0] ?? 10}
              onChange={(e) => {
                const a = Number(e.target.value);
                const b = dash?.[1] ?? 5;
                patchPaint(layer, { 'line-dasharray': [Number.isFinite(a) ? a : 10, b] });
              }}
            />
            <input
              type="number"
              className="w-14 rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-xs text-[var(--text-primary)]"
              value={dash?.[1] ?? 5}
              onChange={(e) => {
                const b = Number(e.target.value);
                const a = dash?.[0] ?? 10;
                patchPaint(layer, { 'line-dasharray': [a, Number.isFinite(b) ? b : 5] });
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
