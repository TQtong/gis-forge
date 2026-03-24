import { DEFAULT_TERRAIN_CONFIG } from '@/data/defaultConfig';
import { Mountain } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * Local terrain UI state (mirrors defaults until a map-wide terrain store exists).
 */
interface TerrainLocalState {
  /** Terrain mesh on/off. */
  enabled: boolean;
  /** Vertical exaggeration multiplier. */
  exaggeration: number;
  /** DEM provider key. */
  source: 'mapbox' | 'aws';
}

/**
 * Terrain exaggeration slider + DEM source selector for the left panel.
 *
 * @returns Compact terrain controls block.
 */
export function TerrainControl() {
  const enabledId = useId();
  const exaggerationId = useId();
  const sourceId = useId();

  const [state, setState] = useState<TerrainLocalState>({
    enabled: DEFAULT_TERRAIN_CONFIG.enabled,
    exaggeration: DEFAULT_TERRAIN_CONFIG.exaggeration,
    source: DEFAULT_TERRAIN_CONFIG.source === 'aws' ? 'aws' : 'mapbox',
  });

  return (
    <section
      className="border-t border-[var(--border)] px-3 py-2"
      aria-label="地形设置"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <Mountain className="size-4 text-[var(--accent)]" strokeWidth={2} />
          <span>地形</span>
        </div>
        <label className="relative inline-flex h-5 w-9 cursor-pointer items-center">
          <input
            id={enabledId}
            type="checkbox"
            className="peer sr-only"
            checked={state.enabled}
            onChange={(e) => {
              setState((s) => ({ ...s, enabled: e.target.checked }));
            }}
          />
          <span className="h-5 w-9 rounded-full bg-[var(--bg-input)] transition peer-checked:bg-[var(--accent)]" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
        </label>
      </div>

      {state.enabled ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-[var(--text-secondary)]" htmlFor={exaggerationId}>
              夸大系数
            </label>
            <span className="text-xs tabular-nums text-[var(--text-primary)]">
              {state.exaggeration.toFixed(1)}x
            </span>
          </div>
          <input
            id={exaggerationId}
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={state.exaggeration}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (!Number.isFinite(v)) {
                return;
              }
              setState((s) => ({ ...s, exaggeration: v }));
            }}
            className="h-1 w-full accent-[var(--accent)]"
            aria-valuemin={0.1}
            aria-valuemax={10}
            aria-valuenow={state.exaggeration}
          />

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]" htmlFor={sourceId}>
            DEM 数据源
            <select
              id={sourceId}
              value={state.source}
              onChange={(e) => {
                const v = e.target.value === 'aws' ? 'aws' : 'mapbox';
                setState((s) => ({ ...s, source: v }));
              }}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-sm text-[var(--text-primary)]"
            >
              <option value="mapbox">Mapbox Terrain</option>
              <option value="aws">AWS Terrain</option>
            </select>
          </label>
        </div>
      ) : null}
    </section>
  );
}
