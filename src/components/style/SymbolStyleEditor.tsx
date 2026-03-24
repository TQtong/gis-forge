import { ColorPicker } from '@/components/style/ColorPicker';
import { patchLayout, patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link SymbolStyleEditor}.
 */
export interface SymbolStyleEditorProps {
  /** Layer being edited (type should be `symbol`). */
  layer: LayerConfig;
}

const DEFAULT_TEXT_FIELD = 'name';
const DEFAULT_TEXT_SIZE = 14;
const DEFAULT_TEXT_COLOR = '#333333';
const DEFAULT_HALO_COLOR = '#FFFFFF';
const DEFAULT_HALO_WIDTH = 1;
const DEFAULT_ICON = 'marker';

const ICON_OPTIONS = [
  { value: 'marker', label: '图钉 (marker)' },
  { value: 'circle', label: '圆 (circle)' },
  { value: 'square', label: '方 (square)' },
  { value: 'triangle', label: '三角 (triangle)' },
] as const;

/**
 * Symbol layer: text field, size, colors, halo, and placeholder icon preset.
 *
 * @param props - {@link SymbolStyleEditorProps}
 * @returns Symbol style editor UI.
 */
export function SymbolStyleEditor(props: SymbolStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;
  const l = layer.layout;

  const textField =
    typeof l['text-field'] === 'string' && l['text-field'].length > 0
      ? l['text-field']
      : DEFAULT_TEXT_FIELD;
  const textSize =
    typeof p['text-size'] === 'number' && Number.isFinite(p['text-size'])
      ? p['text-size']
      : DEFAULT_TEXT_SIZE;
  const textColor =
    typeof p['text-color'] === 'string' ? p['text-color'] : DEFAULT_TEXT_COLOR;
  const haloColor =
    typeof p['text-halo-color'] === 'string' ? p['text-halo-color'] : DEFAULT_HALO_COLOR;
  const haloWidth =
    typeof p['text-halo-width'] === 'number' && Number.isFinite(p['text-halo-width'])
      ? p['text-halo-width']
      : DEFAULT_HALO_WIDTH;
  const iconPreset =
    typeof l['gf-icon-preset'] === 'string' ? l['gf-icon-preset'] : DEFAULT_ICON;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">文字字段</label>
        <div>
          <input
            type="text"
            value={textField}
            onChange={(e) => patchLayout(layer, { 'text-field': e.target.value })}
            className="w-40 rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
            placeholder="name"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">字体大小</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={8}
            max={48}
            step={1}
            value={textSize}
            onChange={(e) => patchPaint(layer, { 'text-size': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={8}
            aria-valuemax={48}
            aria-valuenow={textSize}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {textSize}px
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">文字颜色</label>
        <div>
          <ColorPicker color={textColor} onChange={(c) => patchPaint(layer, { 'text-color': c })} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">光晕颜色</label>
        <div>
          <ColorPicker
            color={haloColor}
            onChange={(c) => patchPaint(layer, { 'text-halo-color': c })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">光晕宽度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={haloWidth}
            onChange={(e) => patchPaint(layer, { 'text-halo-width': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={haloWidth}
          />
          <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {haloWidth}px
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">图标</label>
        <div>
          <select
            value={iconPreset}
            onChange={(e) => patchLayout(layer, { 'gf-icon-preset': e.target.value })}
            className="max-w-[180px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
            aria-label="预设图标"
          >
            {ICON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
