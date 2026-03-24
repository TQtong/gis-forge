import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { PieChart } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Statistical classification method. */
type ClassificationMethod = 'jenks' | 'equal' | 'quantile' | 'stddev';

const METHODS: { id: ClassificationMethod; label: string }[] = [
  { id: 'jenks', label: 'Jenks自然断点' },
  { id: 'equal', label: '等间距' },
  { id: 'quantile', label: '分位数' },
  { id: 'stddev', label: '标准差' },
];

const RAMPS: { id: string; label: string }[] = [
  { id: 'brewer-ylgn', label: '黄绿' },
  { id: 'brewer-ylorrd', label: '黄-红' },
  { id: 'brewer-blues', label: '蓝阶' },
  { id: 'brewer-set3', label: '分色' },
];

const NUMERIC_FIELDS = ['value', 'population', 'density', 'score'] as const;

/**
 * Choropleth classification dialog (Jenks / equal interval / quantile / std dev).
 *
 * @returns Modal or `null` when not active.
 */
export function ClassificationDialog() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const layers = useMemo(() => getAllLayers(), [getAllLayers]);

  const [layerId, setLayerId] = useState('');
  const [field, setField] = useState<string>(NUMERIC_FIELDS[0]);
  const [method, setMethod] = useState<ClassificationMethod>('jenks');
  const [classCount, setClassCount] = useState(5);
  const [rampId, setRampId] = useState(RAMPS[0].id);
  const [outputName, setOutputName] = useState('分类结果');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('classification', {
      layerId,
      field,
      method,
      classCount,
      rampId,
      outputName,
      outputGroupId,
      preview,
    });
  }, [classCount, field, layerId, method, outputGroupId, outputName, preview, rampId, runAnalysis]);

  if (active !== 'classification') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="分类统计"
      icon={PieChart}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          图层
          <select
            className={INPUT_CLASS}
            value={layerId}
            onChange={(e) => {
              setLayerId(e.target.value);
            }}
          >
            <option value="">选择图层…</option>
            {layers.map((l: LayerConfig) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          数值字段
          <select
            className={INPUT_CLASS}
            value={field}
            onChange={(e) => {
              setField(e.target.value);
            }}
          >
            {NUMERIC_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          方法
          <select
            className={INPUT_CLASS}
            value={method}
            onChange={(e) => {
              setMethod(e.target.value as ClassificationMethod);
            }}
          >
            {METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>类数</span>
            <span>{classCount}</span>
          </div>
          <input
            type="range"
            min={2}
            max={20}
            step={1}
            value={classCount}
            onChange={(e) => {
              setClassCount(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={2}
            aria-valuemax={20}
            aria-valuenow={classCount}
          />
        </div>

        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">配色方案</p>
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
