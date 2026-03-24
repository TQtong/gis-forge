import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig } from '@/types';
import { Layers } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

/** Boolean overlay operation (mutually exclusive). */
type OverlayOp = 'intersect' | 'union' | 'difference' | 'symmetric';

const OPS: { id: OverlayOp; label: string }[] = [
  { id: 'intersect', label: '∩ 交集' },
  { id: 'union', label: '∪ 并集' },
  { id: 'difference', label: '− 差集' },
  { id: 'symmetric', label: '△ 对称差' },
];

/**
 * Overlay (boolean) analysis: two layers, attribute flags, output options.
 *
 * @returns Modal or `null` when not active.
 */
export function OverlayAnalysis() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const layers = useMemo(() => getAllLayers(), [getAllLayers]);

  const [op, setOp] = useState<OverlayOp>('intersect');
  const [layerA, setLayerA] = useState('');
  const [layerB, setLayerB] = useState('');
  const [keepA, setKeepA] = useState(true);
  const [keepB, setKeepB] = useState(false);
  const [outputName, setOutputName] = useState('叠加分析结果');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('overlay', {
      op,
      layerA,
      layerB,
      keepA,
      keepB,
      outputName,
      outputGroupId,
      preview,
    });
  }, [keepA, keepB, layerA, layerB, op, outputGroupId, outputName, preview, runAnalysis]);

  if (active !== 'overlay') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="叠加分析"
      icon={Layers}
      onCancel={onCancel}
      onRun={onRun}
      isRunning={isRunning}
      progress={progress}
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">操作类型</p>
          <div className="grid grid-cols-2 gap-2">
            {OPS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={
                  op === o.id
                    ? 'rounded-md bg-[var(--accent)] px-2 py-2 text-xs font-medium text-white'
                    : 'rounded-md border border-[var(--border)] bg-transparent px-2 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]'
                }
                onClick={() => {
                  setOp(o.id);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          图层 A
          <select
            className={INPUT_CLASS}
            value={layerA}
            onChange={(e) => {
              setLayerA(e.target.value);
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
          图层 B
          <select
            className={INPUT_CLASS}
            value={layerB}
            onChange={(e) => {
              setLayerB(e.target.value);
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

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="rounded border-[var(--border)]"
            checked={keepA}
            onChange={(e) => {
              setKeepA(e.target.checked);
            }}
          />
          保留 A 的属性
        </label>

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="rounded border-[var(--border)]"
            checked={keepB}
            onChange={(e) => {
              setKeepB(e.target.checked);
            }}
          />
          保留 B 的属性
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
