import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { Mountain } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Smoothing preset for contour generalization. */
type SmoothLevel = 'low' | 'mid' | 'high';

const SMOOTH: { id: SmoothLevel; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'mid', label: '中' },
  { id: 'high', label: '高' },
];

/**
 * Contour (isoline) analysis from a DEM source.
 *
 * @returns Modal or `null` when not active.
 */
export function ContourAnalysis() {
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
      : ([
          {
            id: 'dem-placeholder',
            name: '示例 DEM（无栅格图层时）',
          },
        ] as Pick<LayerConfig, 'id' | 'name'>[]);
  }, [getAllLayers]);

  const [demId, setDemId] = useState<string>('');
  const [intervalM, setIntervalM] = useState(100);
  const [autoRange, setAutoRange] = useState(true);
  const [minElev, setMinElev] = useState(0);
  const [maxElev, setMaxElev] = useState(1000);
  const [smooth, setSmooth] = useState<SmoothLevel>('mid');
  const [outputName, setOutputName] = useState('等值线');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const estimatedLines = useMemo(() => {
    const step = Math.max(10, Math.min(500, intervalM));
    if (autoRange) {
      const span = 2000;
      return Math.max(0, Math.ceil(span / step));
    }
    const lo = Math.min(minElev, maxElev);
    const hi = Math.max(minElev, maxElev);
    const span = Math.max(0, hi - lo);
    return Math.ceil(span / step);
  }, [autoRange, intervalM, maxElev, minElev]);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('contour', {
      demId,
      intervalM,
      autoRange,
      minElev,
      maxElev,
      smooth,
      outputName,
      outputGroupId,
      preview,
    });
  }, [
    autoRange,
    demId,
    intervalM,
    maxElev,
    minElev,
    outputGroupId,
    outputName,
    preview,
    runAnalysis,
    smooth,
  ]);

  if (active !== 'contour') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="等值线分析"
      icon={Mountain}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          数据源（地形 DEM）
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

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>间隔</span>
            <span>{intervalM} m</span>
          </div>
          <input
            type="range"
            min={10}
            max={500}
            step={1}
            value={intervalM}
            onChange={(e) => {
              setIntervalM(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={10}
            aria-valuemax={500}
            aria-valuenow={intervalM}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="rounded border-[var(--border)]"
            checked={autoRange}
            onChange={(e) => {
              setAutoRange(e.target.checked);
            }}
          />
          自动范围
        </label>

        {!autoRange ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              最小高程 (m)
              <input
                type="number"
                className={INPUT_CLASS}
                value={minElev}
                onChange={(e) => {
                  setMinElev(Number(e.target.value));
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              最大高程 (m)
              <input
                type="number"
                className={INPUT_CLASS}
                value={maxElev}
                onChange={(e) => {
                  setMaxElev(Number(e.target.value));
                }}
              />
            </label>
          </div>
        ) : null}

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          平滑度
          <select
            className={INPUT_CLASS}
            value={smooth}
            onChange={(e) => {
              setSmooth(e.target.value as SmoothLevel);
            }}
          >
            {SMOOTH.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <p className="text-xs text-[var(--text-secondary)]">
          预览：将生成约 <span className="text-[var(--accent)]">{estimatedLines}</span> 条等值线
        </p>

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
