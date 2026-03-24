import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { TrendingUp } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Slope raster output interpretation. */
type SlopeOutput = 'angle' | 'percent' | 'aspect';

const OUTPUTS: { id: SlopeOutput; label: string }[] = [
  { id: 'angle', label: '坡度角' },
  { id: 'percent', label: '坡度百分比' },
  { id: 'aspect', label: '坡向角' },
];

const RAMPS: { id: string; label: string }[] = [
  { id: 'earth', label: '地貌' },
  { id: 'slope-green', label: '绿坡' },
  { id: 'spectral', label: '光谱' },
  { id: 'gray', label: '灰度' },
];

/**
 * Slope / aspect raster from DEM.
 *
 * @returns Modal or `null` when not active.
 */
export function SlopeAnalysis() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const demLayers = useMemo(() => {
    const all = getAllLayers();
    const r = all.filter((l) => l.type === 'raster');
    return r.length > 0
      ? r
      : ([{ id: 'dem-placeholder', name: '示例 DEM（无栅格图层时）' }] as Pick<
          LayerConfig,
          'id' | 'name'
        >[]);
  }, [getAllLayers]);

  const [demId, setDemId] = useState('');
  const [outputType, setOutputType] = useState<SlopeOutput>('angle');
  const [rampId, setRampId] = useState(RAMPS[0].id);
  const [outputName, setOutputName] = useState('坡度分析');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('slope', {
      demId,
      outputType,
      rampId,
      outputName,
      outputGroupId,
      preview,
    });
  }, [demId, outputGroupId, outputName, outputType, preview, rampId, runAnalysis]);

  if (active !== 'slope') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="坡度 / 坡向分析"
      icon={TrendingUp}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          DEM 源
          <select
            className={INPUT_CLASS}
            value={demId}
            onChange={(e) => {
              setDemId(e.target.value);
            }}
          >
            <option value="">选择 DEM…</option>
            {demLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          输出类型
          <select
            className={INPUT_CLASS}
            value={outputType}
            onChange={(e) => {
              setOutputType(e.target.value as SlopeOutput);
            }}
          >
            {OUTPUTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">色带选择</p>
          <div className="flex flex-wrap gap-2">
            {RAMPS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={
                  rampId === r.id
                    ? 'rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white'
                    : 'rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]'
                }
                onClick={() => {
                  setRampId(r.id);
                }}
              >
                {r.label}
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
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
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
