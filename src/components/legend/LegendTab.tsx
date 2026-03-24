import { EmptyState } from '@/components/common/EmptyState';
import { useLayerStore } from '@/stores/layerStore';
import type { LayerConfig, LayerGroup } from '@/types';
import { generateColorRamp } from '@/utils/colorUtils';
import { BookOpen } from 'lucide-react';
import type { ReactElement } from 'react';
import { useMemo } from 'react';

/**
 * Collect visible layers in display order (groups top-to-bottom, layers as listed).
 *
 * @param groups - Layer groups from the store.
 * @returns Visible layers only.
 */
function visibleLayersInOrder(groups: LayerGroup[]): LayerConfig[] {
  const out: LayerConfig[] = [];
  for (const g of groups) {
    for (const l of g.layers) {
      if (l.visible) {
        out.push(l);
      }
    }
  }
  return out;
}

/**
 * Resolve a CSS color for legend swatches from paint.
 *
 * @param layer - Layer config.
 * @returns Primary color string.
 */
function primaryColor(layer: LayerConfig): string {
  const p = layer.paint;
  switch (layer.type) {
    case 'fill':
      return typeof p['fill-color'] === 'string' ? p['fill-color'] : '#4A90D9';
    case 'line':
      return typeof p['line-color'] === 'string' ? p['line-color'] : '#FF6600';
    case 'circle':
      return typeof p['circle-color'] === 'string' ? p['circle-color'] : '#E74C3C';
    case 'extrusion':
      return typeof p['fill-extrusion-color'] === 'string' ? p['fill-extrusion-color'] : '#8B7355';
    case 'heatmap': {
      const ramp = p['gf-heatmap-color-ramp'];
      if (Array.isArray(ramp) && ramp.length > 0 && typeof ramp[0] === 'string') {
        return ramp[0];
      }
      return '#313695';
    }
    case 'raster':
      return '#aaaaaa';
    case 'symbol':
      return typeof p['text-color'] === 'string' ? p['text-color'] : '#333333';
    default:
      return '#888888';
  }
}

/**
 * Auto legend from visible layers; updates when styles or visibility change.
 *
 * @returns Legend tab content.
 */
export function LegendTab(): ReactElement {
  const groups = useLayerStore((s) => s.groups);

  const layers = useMemo(() => visibleLayersInOrder(groups), [groups]);

  if (layers.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="暂无可见图层"
        description="添加并显示图层后将自动生成图例"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-2 overflow-y-auto">
      {layers.map((layer) => (
        <div key={layer.id} className="rounded border border-[var(--border)] bg-[var(--bg-input)] p-2">
          <div className="text-xs font-semibold text-[var(--text-primary)] mb-2 truncate" title={layer.name}>
            {layer.name}
          </div>
          <LegendEntry layer={layer} />
        </div>
      ))}
    </div>
  );
}

/**
 * Single-layer legend visualization by geometry type.
 *
 * @param props - Layer to render.
 * @returns Legend graphics for that layer.
 */
function LegendEntry(props: { layer: LayerConfig }): ReactElement {
  const { layer } = props;
  const label = layer.name;
  const color = primaryColor(layer);

  switch (layer.type) {
    case 'fill':
      return (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 shrink-0 rounded-sm border border-[var(--border)]"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        </div>
      );
    case 'line':
      return (
        <div className="flex items-center gap-2">
          <svg width={40} height={10} viewBox="0 0 40 10" aria-hidden>
            <line
              x1={0}
              y1={5}
              x2={40}
              y2={5}
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
            />
          </svg>
          <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        </div>
      );
    case 'circle':
      return (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 shrink-0 rounded-full border border-[var(--border)]"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        </div>
      );
    case 'heatmap': {
      const p = layer.paint;
      const rampRaw = p['gf-heatmap-color-ramp'];
      const colors = Array.isArray(rampRaw)
        ? (rampRaw as string[])
        : generateColorRamp(['#313695', '#d73027'], 8);
      const gradient = `linear-gradient(to right, ${colors.join(', ')})`;
      return (
        <div className="flex flex-col gap-1">
          <div
            className="h-4 w-full rounded border border-[var(--border)]"
            style={{ background: gradient }}
            role="img"
            aria-label="热力渐变"
          />
          <div className="flex justify-between text-[10px] text-[var(--text-muted)] tabular-nums">
            <span>低</span>
            <span>高</span>
          </div>
        </div>
      );
    }
    case 'extrusion': {
      const p = layer.paint;
      const base =
        typeof p['fill-extrusion-base'] === 'number' ? p['fill-extrusion-base'] : 0;
      const h =
        typeof p['fill-extrusion-height'] === 'number' ? p['fill-extrusion-height'] : 20;
      const c = primaryColor(layer);
      return (
        <div className="flex items-end gap-2">
          <div className="flex gap-1 items-end">
            <span
              className="inline-block w-5 rounded-t border border-[var(--border)]"
              style={{ height: 16, backgroundColor: c, opacity: 0.85 }}
              aria-hidden
            />
            <span
              className="inline-block w-5 rounded-t border border-[var(--border)]"
              style={{ height: 28, backgroundColor: c }}
              aria-hidden
            />
          </div>
          <div className="text-[10px] text-[var(--text-muted)] leading-tight">
            <div>高度约 {h}m</div>
            <div>基底 {base}m</div>
          </div>
        </div>
      );
    }
    case 'raster':
      return (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-8 shrink-0 rounded-sm border border-[var(--border)] bg-gradient-to-r from-[var(--text-muted)] to-[var(--text-secondary)] opacity-80"
            aria-hidden
          />
          <span className="text-xs text-[var(--text-secondary)]">栅格 · {label}</span>
        </div>
      );
    case 'symbol':
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color }}>
            Aa
          </span>
          <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        </div>
      );
    default:
      return (
        <div className="text-xs text-[var(--text-muted)]">此类型图例预览暂略</div>
      );
  }
}
