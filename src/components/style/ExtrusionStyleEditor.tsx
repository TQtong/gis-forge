import { ColorPicker } from '@/components/style/ColorPicker';
import { patchLayout, patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link ExtrusionStyleEditor}.
 */
export interface ExtrusionStyleEditorProps {
  /** Layer being edited (type should be `extrusion`). */
  layer: LayerConfig;
}

const DEFAULT_COLOR = '#8B7355';
const DEFAULT_BASE = 0;
const DEFAULT_HEIGHT = 20;
const DEFAULT_OPACITY = 0.8;

/** Placeholder property keys for height-by-attribute (until bound to real schema). */
const HEIGHT_PROPERTY_OPTIONS = ['height', 'levels', 'render_height', 'building:levels'] as const;

/**
 * Fill extrusion paint: color, base/height, opacity, optional height field.
 *
 * @param props - {@link ExtrusionStyleEditorProps}
 * @returns Extrusion style editor UI.
 */
export function ExtrusionStyleEditor(props: ExtrusionStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;
  const l = layer.layout;

  const color =
    typeof p['fill-extrusion-color'] === 'string'
      ? p['fill-extrusion-color']
      : DEFAULT_COLOR;
  const base =
    typeof p['fill-extrusion-base'] === 'number' && Number.isFinite(p['fill-extrusion-base'])
      ? p['fill-extrusion-base']
      : DEFAULT_BASE;
  const heightNum =
    typeof p['fill-extrusion-height'] === 'number' && Number.isFinite(p['fill-extrusion-height'])
      ? p['fill-extrusion-height']
      : DEFAULT_HEIGHT;
  const opacity =
    typeof p['fill-extrusion-opacity'] === 'number' &&
    Number.isFinite(p['fill-extrusion-opacity'])
      ? p['fill-extrusion-opacity']
      : DEFAULT_OPACITY;

  const byProp =
    typeof l['gf-extrusion-height-by-property'] === 'boolean'
      ? l['gf-extrusion-height-by-property']
      : false;
  const heightProp =
    typeof l['gf-extrusion-height-property'] === 'string'
      ? l['gf-extrusion-height-property']
      : HEIGHT_PROPERTY_OPTIONS[0];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">颜色</label>
        <div>
          <ColorPicker
            color={color}
            onChange={(c) => patchPaint(layer, { 'fill-extrusion-color': c })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">基础高度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={base}
            onChange={(e) => patchPaint(layer, { 'fill-extrusion-base': Number(e.target.value) })}
            className="w-28 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={base}
          />
          <span className="w-12 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {base}m
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">高度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={500}
            step={1}
            value={heightNum}
            onChange={(e) =>
              patchPaint(layer, { 'fill-extrusion-height': Number(e.target.value) })
            }
            className="w-28 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={500}
            aria-valuenow={heightNum}
          />
          <input
            type="number"
            min={0}
            max={500}
            value={heightNum}
            onChange={(e) => {
              const v = Number(e.target.value);
              patchPaint(layer, {
                'fill-extrusion-height': Number.isFinite(v) ? Math.max(0, Math.min(500, v)) : 0,
              });
            }}
            className="w-16 rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-xs text-[var(--text-primary)]"
          />
          <span className="text-xs text-[var(--text-muted)]">m</span>
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
            onChange={(e) =>
              patchPaint(layer, { 'fill-extrusion-opacity': Number(e.target.value) })
            }
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
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
          按属性设置高度
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={byProp}
            onClick={() =>
              patchLayout(layer, { 'gf-extrusion-height-by-property': !byProp })
            }
            className={`rounded px-2 py-1 text-xs ${
              byProp
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-input)] text-[var(--text-secondary)] border border-[var(--border)]'
            }`}
          >
            {byProp ? '开' : '关'}
          </button>
        </div>
      </div>
      {byProp ? (
        <div className="flex items-center justify-between gap-2 py-1.5">
          <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">高度字段</label>
          <div>
            <select
              value={heightProp}
              onChange={(e) =>
                patchLayout(layer, { 'gf-extrusion-height-property': e.target.value })
              }
              className="max-w-[180px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
            >
              {HEIGHT_PROPERTY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
