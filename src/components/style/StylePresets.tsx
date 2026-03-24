import { STYLE_PRESETS } from '@/data/stylePresets';
import { patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig, StylePreset } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link StylePresets}.
 */
export interface StylePresetsProps {
  /** Layer to apply thematic presets to. */
  layer: LayerConfig;
}

const STORAGE_KEY = 'gf-user-style-presets-v1';

/**
 * Apply a built-in preset's colors to the layer `paint` fields appropriate for its `type`.
 *
 * @param layer - Target layer.
 * @param preset - Preset definition from {@link STYLE_PRESETS}.
 */
function applyPresetToLayer(layer: LayerConfig, preset: StylePreset): void {
  const c = preset.colors;
  if (c.length === 0) {
    return;
  }
  switch (layer.type) {
    case 'fill':
      patchPaint(layer, {
        'fill-color': c[0],
        'fill-outline-color': c[c.length - 1] ?? c[0],
      });
      break;
    case 'line':
      patchPaint(layer, { 'line-color': c[Math.min(c.length - 1, Math.floor(c.length / 2))] });
      break;
    case 'circle':
      patchPaint(layer, {
        'circle-color': c[0],
        'circle-stroke-color': c[c.length - 1] ?? '#ffffff',
      });
      break;
    case 'symbol':
      patchPaint(layer, {
        'text-color': c[0],
        'text-halo-color': c[c.length - 1] ?? '#ffffff',
      });
      break;
    case 'raster':
      patchPaint(layer, { 'raster-opacity': 1 });
      break;
    case 'extrusion':
      patchPaint(layer, { 'fill-extrusion-color': c[0] });
      break;
    case 'heatmap':
      patchPaint(layer, {
        'gf-heatmap-color-ramp': [...c],
        'gf-heatmap-color-ramp-id': preset.id,
      });
      break;
    default:
      break;
  }
}

/**
 * Bottom section: quick palette buttons, save-as-preset (localStorage), and built-in ramps.
 *
 * @param props - {@link StylePresetsProps}
 * @returns Style presets UI block.
 */
export function StylePresets(props: StylePresetsProps): ReactElement {
  const { layer } = props;

  const saveCurrent = () => {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      const list: StylePreset[] = raw ? (JSON.parse(raw) as StylePreset[]) : [];
      const entry: StylePreset = {
        id: `user-${Date.now()}`,
        name: `💾 ${layer.name}`,
        colors: extractColorsFromPaint(layer),
        type: 'categorical',
      };
      list.push(entry);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* ignore quota / private mode */
    }
  };

  return (
    <div className="flex flex-col border-t border-[var(--border)] pt-3 mt-3 gap-2">
      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
        ── 预设 ──
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STYLE_PRESETS.filter((p) =>
          ['rainbow', 'blues', 'reds', 'greens', 'heat'].includes(p.id),
        ).map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => applyPresetToLayer(layer, preset)}
            className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
          >
            {preset.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={saveCurrent}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--bg-panel-hover)]"
      >
        💾 保存为预设
      </button>
    </div>
  );
}

/**
 * Derive a small color list from current paint for persistence.
 *
 * @param layer - Layer to read paint from.
 * @returns Ordered distinct hex or css colors.
 */
function extractColorsFromPaint(layer: LayerConfig): string[] {
  const p = layer.paint;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('#')) {
      out.push(v);
    }
  };
  switch (layer.type) {
    case 'fill':
      push(p['fill-color']);
      push(p['fill-outline-color']);
      break;
    case 'line':
      push(p['line-color']);
      break;
    case 'circle':
      push(p['circle-color']);
      push(p['circle-stroke-color']);
      break;
    case 'symbol':
      push(p['text-color']);
      push(p['text-halo-color']);
      break;
    case 'extrusion':
      push(p['fill-extrusion-color']);
      break;
    case 'heatmap': {
      const ramp = p['gf-heatmap-color-ramp'];
      if (Array.isArray(ramp)) {
        for (const x of ramp) {
          push(x);
        }
      }
      break;
    }
    default:
      break;
  }
  return out.length > 0 ? out : ['#888888'];
}
