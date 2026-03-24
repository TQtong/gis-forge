import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { Eye } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Output mask kind for viewshed. */
type ViewshedOutput = 'visible' | 'invisible';

/**
 * Line-of-sight / viewshed analysis from an observer point and DEM.
 *
 * @returns Modal or `null` when not active.
 */
export function ViewshedAnalysis() {
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

  const [pickMode, setPickMode] = useState(false);
  const [lng, setLng] = useState(116.397);
  const [lat, setLat] = useState(39.908);
  const [observerHeight, setObserverHeight] = useState(1.7);
  const [radiusM, setRadiusM] = useState(5000);
  const [demId, setDemId] = useState('');
  const [outputKind, setOutputKind] = useState<ViewshedOutput>('visible');
  const [outputName, setOutputName] = useState('视域分析');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setPickMode(false);
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    setPickMode(false);
    runAnalysis('viewshed', {
      observer: { lng, lat, heightM: observerHeight },
      radiusM,
      demId,
      outputKind,
      outputName,
      outputGroupId,
      preview,
    });
  }, [
    demId,
    lat,
    lng,
    observerHeight,
    outputGroupId,
    outputKind,
    outputName,
    preview,
    radiusM,
    runAnalysis,
  ]);

  if (active !== 'viewshed') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="视域分析"
      icon={Eye}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={
              pickMode
                ? 'rounded-md bg-[var(--accent)] px-3 py-2 text-sm text-white'
                : 'rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]'
            }
            onClick={() => {
              setPickMode((v) => !v);
            }}
          >
            📍 在地图上点击选择
          </button>
          {pickMode ? (
            <p className="text-xs text-[var(--warning)]">请在地图上点击以设置观察点（示例：仍可使用下方手动坐标）。</p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            经度
            <input
              type="number"
              step="0.000001"
              className={INPUT_CLASS}
              value={lng}
              onChange={(e) => {
                setLng(Number(e.target.value));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            纬度
            <input
              type="number"
              step="0.000001"
              className={INPUT_CLASS}
              value={lat}
              onChange={(e) => {
                setLat(Number(e.target.value));
              }}
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>观察者高度 (m)</span>
            <span>{observerHeight.toFixed(1)} m</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={observerHeight}
            onChange={(e) => {
              setObserverHeight(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={observerHeight}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>分析半径 (m)</span>
            <span>{radiusM} m</span>
          </div>
          <input
            type="range"
            min={100}
            max={10000}
            step={50}
            value={radiusM}
            onChange={(e) => {
              setRadiusM(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={100}
            aria-valuemax={10000}
            aria-valuenow={radiusM}
          />
        </div>

        <p className="text-xs text-[var(--warning)]">⚠️ 分析半径越大计算时间越长</p>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          地形数据
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

        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">输出类型</p>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="radio"
                name="viewshed-out"
                checked={outputKind === 'visible'}
                onChange={() => {
                  setOutputKind('visible');
                }}
              />
              可见区域
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="radio"
                name="viewshed-out"
                checked={outputKind === 'invisible'}
                onChange={() => {
                  setOutputKind('invisible');
                }}
              />
              不可见区域
            </label>
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
