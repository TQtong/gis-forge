import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig, LayerKind } from '@/types';
import { Flame } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Layer kinds treated as point-like for heatmap input. */
const POINT_KINDS: ReadonlySet<LayerKind> = new Set(['circle', 'symbol', 'heatmap']);

const GRADIENT_PRESETS: { id: string; label: string }[] = [
  { id: 'ylorrd', label: '黄-红' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'magma', label: 'Magma' },
  { id: 'blues', label: '蓝色' },
];

const WEIGHT_FIELDS = ['population', 'count', 'weight', 'value'] as const;

/**
 * Returns true when the layer is considered a point layer for heatmap input.
 *
 * @param layer - Map layer config.
 */
function isPointLayer(layer: LayerConfig): boolean {
  return POINT_KINDS.has(layer.type);
}

/**
 * Kernel density / heatmap analysis for point layers.
 *
 * @returns Modal or `null` when not active.
 */
export function HeatmapAnalysis() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const pointLayers = useMemo(() => getAllLayers().filter(isPointLayer), [getAllLayers]);

  const [layerId, setLayerId] = useState('');
  const [radiusPx, setRadiusPx] = useState(30);
  const [weightField, setWeightField] = useState<string>(WEIGHT_FIELDS[0]);
  const [gradientId, setGradientId] = useState(GRADIENT_PRESETS[0].id);
  const [outputName, setOutputName] = useState('热力图');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('heatmap', {
      layerId,
      radiusPx,
      weightField,
      gradientId,
      outputName,
      outputGroupId,
      preview,
    });
  }, [gradientId, layerId, outputGroupId, outputName, preview, radiusPx, runAnalysis, weightField]);

  if (active !== 'heatmap') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="热力密度分析"
      icon={Flame}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          点图层
          <select
            className={INPUT_CLASS}
            value={layerId}
            onChange={(e) => {
              setLayerId(e.target.value);
            }}
          >
            <option value="">选择点图层…</option>
            {pointLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>半径（像素）</span>
            <span>{radiusPx} px</span>
          </div>
          <input
            type="range"
            min={10}
            max={200}
            step={1}
            value={radiusPx}
            onChange={(e) => {
              setRadiusPx(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={10}
            aria-valuemax={200}
            aria-valuenow={radiusPx}
          />
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          权重字段
          <select
            className={INPUT_CLASS}
            value={weightField}
            onChange={(e) => {
              setWeightField(e.target.value);
            }}
          >
            {WEIGHT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">颜色渐变</p>
          <div className="flex flex-wrap gap-2">
            {GRADIENT_PRESETS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={
                  gradientId === g.id
                    ? 'rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white'
                    : 'rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]'
                }
                onClick={() => {
                  setGradientId(g.id);
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          输出图层名
          <input
            type="text"
            className={INPUT_CLASS}
            value={outputName}
            onChange={(e) => {
              setOutputName(e.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          添加到分组
          <select
            className={INPUT_CLASS}
            value={outputGroupId}
            onChange={(e) => {
              setOutputGroupId(e.target.value);
            }}
          >
            {groups.map((gr) => (
              <option key={gr.id} value={gr.id}>
                {gr.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="rounded border-[var(--border)]"
            checked={preview}
            onChange={(e) => {
              setPreview(e.target.checked);
            }}
          />
          实时预览
        </label>
      </div>
    </AnalysisDialogWrapper>
  );
}
