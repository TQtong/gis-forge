import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { SunMedium } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/**
 * Hillshade raster parameters from DEM.
 *
 * @returns Modal or `null` when not active.
 */
export function HillshadeAnalysis() {
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
  const [azimuth, setAzimuth] = useState(315);
  const [altitude, setAltitude] = useState(45);
  const [zFactor, setZFactor] = useState(1);
  const [outputName, setOutputName] = useState('山体阴影');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('hillshade', {
      demId,
      azimuthDeg: azimuth,
      altitudeDeg: altitude,
      zFactor,
      outputName,
      outputGroupId,
      preview,
    });
  }, [altitude, azimuth, demId, outputGroupId, outputName, preview, runAnalysis, zFactor]);

  if (active !== 'hillshade') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="山体阴影分析"
      icon={SunMedium}
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

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>太阳方位 (°)</span>
            <span>{azimuth}°</span>
          </div>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={azimuth}
            onChange={(e) => {
              setAzimuth(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={azimuth}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>太阳高度 (°)</span>
            <span>{altitude}°</span>
          </div>
          <input
            type="range"
            min={0}
            max={90}
            step={1}
            value={altitude}
            onChange={(e) => {
              setAltitude(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={0}
            aria-valuemax={90}
            aria-valuenow={altitude}
          />
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          Z 因子
          <input
            type="number"
            step={0.01}
            min={0}
            className={INPUT_CLASS}
            value={zFactor}
            onChange={(e) => {
              const v = Number(e.target.value);
              setZFactor(Number.isFinite(v) ? v : 1);
            }}
          />
        </label>

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
