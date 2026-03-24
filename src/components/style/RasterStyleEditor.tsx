import { patchPaint } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link RasterStyleEditor}.
 */
export interface RasterStyleEditorProps {
  /** Layer being edited (type should be `raster`). */
  layer: LayerConfig;
}

const DEFAULT_OPACITY = 1;
const DEFAULT_BRIGHTNESS: [number, number] = [0, 1];
const DEFAULT_CONTRAST = 0;
const DEFAULT_SATURATION = 0;
const DEFAULT_HUE = 0;

/**
 * Raster layer: opacity, brightness min/max, contrast, saturation, hue rotate.
 *
 * @param props - {@link RasterStyleEditorProps}
 * @returns Raster style editor UI.
 */
export function RasterStyleEditor(props: RasterStyleEditorProps): ReactElement {
  const { layer } = props;
  const p = layer.paint;

  const opacity =
    typeof p['raster-opacity'] === 'number' && Number.isFinite(p['raster-opacity'])
      ? p['raster-opacity']
      : DEFAULT_OPACITY;

  const bMinRaw = p['raster-brightness-min'];
  const bMaxRaw = p['raster-brightness-max'];
  const bMin =
    typeof bMinRaw === 'number' && Number.isFinite(bMinRaw) ? bMinRaw : DEFAULT_BRIGHTNESS[0];
  const bMax =
    typeof bMaxRaw === 'number' && Number.isFinite(bMaxRaw) ? bMaxRaw : DEFAULT_BRIGHTNESS[1];
  const brightnessMin = Math.min(bMin, bMax);
  const brightnessMax = Math.max(bMin, bMax);

  const contrast =
    typeof p['raster-contrast'] === 'number' && Number.isFinite(p['raster-contrast'])
      ? p['raster-contrast']
      : DEFAULT_CONTRAST;
  const saturation =
    typeof p['raster-saturation'] === 'number' && Number.isFinite(p['raster-saturation'])
      ? p['raster-saturation']
      : DEFAULT_SATURATION;
  const hue =
    typeof p['raster-hue-rotate'] === 'number' && Number.isFinite(p['raster-hue-rotate'])
      ? p['raster-hue-rotate']
      : DEFAULT_HUE;

  const setBrightness = (lo: number, hi: number) => {
    const a = Math.max(0, Math.min(1, lo));
    const b = Math.max(0, Math.min(1, hi));
    patchPaint(layer, {
      'raster-brightness-min': Math.min(a, b),
      'raster-brightness-max': Math.max(a, b),
    });
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">透明度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => patchPaint(layer, { 'raster-opacity': Number(e.target.value) })}
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
      <div className="flex flex-col gap-1 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">亮度 (min–max)</label>
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            {brightnessMin.toFixed(2)} — {brightnessMax.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col gap-1 pl-0">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={brightnessMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setBrightness(v, brightnessMax);
            }}
            className="w-full accent-[var(--accent)]"
            aria-label="亮度最小值"
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={brightnessMax}
            onChange={(e) => {
              const v = Number(e.target.value);
              setBrightness(brightnessMin, v);
            }}
            className="w-full accent-[var(--accent)]"
            aria-label="亮度最大值"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">对比度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={contrast}
            onChange={(e) => patchPaint(layer, { 'raster-contrast': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={contrast}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {contrast.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">饱和度</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={saturation}
            onChange={(e) => patchPaint(layer, { 'raster-saturation': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={saturation}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {saturation.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">色调旋转</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={hue}
            onChange={(e) => patchPaint(layer, { 'raster-hue-rotate': Number(e.target.value) })}
            className="w-32 accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={hue}
          />
          <span className="w-8 text-right text-xs text-[var(--text-muted)] tabular-nums">
            {hue}°
          </span>
        </div>
      </div>
    </div>
  );
}
