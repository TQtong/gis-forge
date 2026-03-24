import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { Circle } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Line cap options for buffer geometry. */
type LineCap = 'round' | 'flat' | 'square';

/** Line join options for buffer geometry. */
type LineJoin = 'round' | 'miter' | 'bevel';

/** Distance unit for display and input. */
type DistanceUnit = 'm' | 'km' | 'mi';

/**
 * Converts meters to the selected unit for display.
 *
 * @param meters - Distance in meters.
 * @param unit - Target unit key.
 * @returns Value in `unit`.
 */
function metersToUnit(meters: number, unit: DistanceUnit): number {
  if (!Number.isFinite(meters)) {
    return 0;
  }
  switch (unit) {
    case 'm':
      return meters;
    case 'km':
      return meters / 1000;
    case 'mi':
      return meters / 1609.344;
    default:
      return meters;
  }
}

/**
 * Converts a value from `unit` to meters.
 *
 * @param value - Numeric value in `unit`.
 * @param unit - Source unit key.
 * @returns Distance in meters.
 */
function unitToMeters(value: number, unit: DistanceUnit): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  switch (unit) {
    case 'm':
      return value;
    case 'km':
      return value * 1000;
    case 'mi':
      return value * 1609.344;
    default:
      return value;
  }
}

/**
 * Buffer analysis dialog: distance, caps/joins, merge, output, preview.
 *
 * @returns Modal or `null` when not active.
 */
export function BufferAnalysis() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const layers = useMemo(() => getAllLayers(), [getAllLayers]);

  const [inputLayerId, setInputLayerId] = useState<string>('');
  const [distanceMeters, setDistanceMeters] = useState(500);
  const [unit, setUnit] = useState<DistanceUnit>('m');
  const [lineCap, setLineCap] = useState<LineCap>('round');
  const [lineJoin, setLineJoin] = useState<LineJoin>('round');
  const [merge, setMerge] = useState(true);
  const [outputName, setOutputName] = useState('缓冲区结果');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const displayDistance = useMemo(
    () => metersToUnit(distanceMeters, unit),
    [distanceMeters, unit],
  );

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('buffer', {
      inputLayerId,
      distanceMeters,
      unit,
      lineCap,
      lineJoin,
      merge,
      outputName,
      outputGroupId,
      preview,
    });
  }, [
    distanceMeters,
    inputLayerId,
    lineCap,
    lineJoin,
    merge,
    outputGroupId,
    outputName,
    preview,
    runAnalysis,
    unit,
  ]);

  if (active !== 'buffer') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="缓冲区分析"
      icon={Circle}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          输入图层
          <select
            className={INPUT_CLASS}
            value={inputLayerId}
            onChange={(e) => {
              setInputLayerId(e.target.value);
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

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>缓冲距离</span>
            <span>
              {displayDistance.toFixed(unit === 'm' ? 0 : 2)} {unit}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={50000}
            step={1}
            value={Math.min(50000, Math.max(1, distanceMeters))}
            onChange={(e) => {
              setDistanceMeters(Number(e.target.value));
            }}
            className="w-full accent-[var(--accent)]"
            aria-valuemin={1}
            aria-valuemax={50000}
            aria-valuenow={distanceMeters}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0.001}
              step={0.001}
              className={`${INPUT_CLASS} max-w-[140px]`}
              value={Number.isFinite(displayDistance) ? displayDistance : 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDistanceMeters(unitToMeters(v, unit));
              }}
            />
            <select
              className={`${INPUT_CLASS} max-w-[100px]`}
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value as DistanceUnit);
              }}
            >
              <option value="m">米 (m)</option>
              <option value="km">千米 (km)</option>
              <option value="mi">英里 (mi)</option>
            </select>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          线端类型
          <select
            className={INPUT_CLASS}
            value={lineCap}
            onChange={(e) => {
              setLineCap(e.target.value as LineCap);
            }}
          >
            <option value="round">round</option>
            <option value="flat">flat</option>
            <option value="square">square</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          拐角类型
          <select
            className={INPUT_CLASS}
            value={lineJoin}
            onChange={(e) => {
              setLineJoin(e.target.value as LineJoin);
            }}
          >
            <option value="round">round</option>
            <option value="miter">miter</option>
            <option value="bevel">bevel</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="rounded border-[var(--border)]"
            checked={merge}
            onChange={(e) => {
              setMerge(e.target.checked);
            }}
          />
          合并结果
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
