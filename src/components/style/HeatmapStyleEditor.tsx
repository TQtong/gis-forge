import { patchPaint } from '@/components/style/styleLayerUpdate';
import { PRESET_RAMPS } from '@/utils/colorUtils';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link HeatmapStyleEditor}.
 */
export interface HeatmapStyleEditorProps {
  /** Layer being edited (type should be `heatmap`). */
  layer: LayerConfig;
}

const DEFAULT_RADIUS = 30;
const DEFAULT_WEIGHT_FIELD = 'none';
const DEFAULT_INTENSITY = 1;
const DEFAULT_OPACITY = 0.7;

const WEIGHT_OPTIONS = ['none', 'population', 'weight', 'density', 'value'] as const;

const RAMP_IDS = [
  { id: 'blue-red', label: '蓝 → 红', colors: [...PRESET_RAMPS.blues, ...PRESET_RAMPS.reds.slice().reverse()] },
  { id: 'green-red', label: '绿 → 红', colors: [...PRESET_RAMPS.greens, '#fdae61', '#d73027'] },
  { id: 'heat', label: '热度', colors: [...PRESET_RAMPS.heat] },
  { id: 'viridis', label: 'Viridis', colors: [...PRESET_RAMPS.viridis] },
  { id: 'rainbow', label: '彩虹', colors: [...PRESET_RAMPS.rainbow] },
] as const;

/**
 * Heatmap controls: radius, weight field, intensity, color ramp, opacity.
 *
 * @param props - {@link HeatmapStyleEditorProps}
 * @returns Heatmap style editor UI.
 */
export function HeatmapStyleEditor(props: HeatmapStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;

  const radius =
    typeof p['heatmap-radius'] === 'number' && Number.isFinite(p['heatmap-radius'])
      ? p['heatmap-radius']
      : DEFAULT_RADIUS;
  const weightField =
    typeof p['gf-heatmap-weight-field'] === 'string'
      ? p['gf-heatmap-weight-field']
      : DEFAULT_WEIGHT_FIELD;
  const intensity =
    typeof p['heatmap-intensity'] === 'number' && Number.isFinite(p['heatmap-intensity'])
      ? p['heatmap-intensity']
      : DEFAULT_INTENSITY;
  const opacity =
    typeof p['heatmap-opacity'] === 'number' && Number.isFinite(p['heatmap-opacity'])
      ? p['heatmap-opacity']
      : DEFAULT_OPACITY;
  const rampId =
    typeof p['gf-heatmap-color-ramp-id'] === 'string' ? p['gf-heatmap-color-ramp-id'] : 'heat';

  const activeRamp = RAMP_IDS.find((r) => r.id === rampId) ?? RAMP_IDS[2];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">半径</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={5}
            max={100}
            step={1}
            value={radius}
            onChange={(e) => patchPaint(layer, { 'heatmap-radius': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={5}
            aria-valuemax={100}
            aria-valuenow={radius}
          />
          <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {radius}px
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">权重字段</label>
        <div>
          <select
            value={weightField}
            onChange={(e) => patchPaint(layer, { 'gf-heatmap-weight-field': e.target.value })}
            className="max-w-[160px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
          >
            {WEIGHT_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">强度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={intensity}
            onChange={(e) => patchPaint(layer, { 'heatmap-intensity': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={intensity}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {intensity.toFixed(1)}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">颜色渐变</label>
        </div>
        <select
          value={activeRamp.id}
          onChange={(e) => {
            const id = e.target.value;
            const ramp = RAMP_IDS.find((r) => r.id === id) ?? RAMP_IDS[2];
            patchPaint(layer, {
              'gf-heatmap-color-ramp-id': ramp.id,
              'gf-heatmap-color-ramp': [...ramp.colors],
            });
          }}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
          aria-label="颜色渐变预设"
        >
          {RAMP_IDS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <div
          className="h-3 w-full rounded border border-[var(--border)]"
          style={{
            background: `linear-gradient(to right, ${activeRamp.colors.join(', ')})`,
          }}
          role="img"
          aria-label="渐变预览"
        />
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
            onChange={(e) => patchPaint(layer, { 'heatmap-opacity': Number(e.target.value) })}
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
