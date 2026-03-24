import { AnalysisDialogWrapper } from '@/components/analysis/AnalysisDialogWrapper';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import type { LayerConfig, LayerKind } from '@/types';
import { Hexagon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]';

const POINT_KINDS: ReadonlySet<LayerKind> = new Set(['circle', 'symbol', 'heatmap']);

/** Clip mode for Voronoi extent. */
type ClipMode = 'viewport' | 'bbox' | 'layer';

function isPointLayer(layer: LayerConfig): boolean {
  return POINT_KINDS.has(layer.type);
}

/**
 * Voronoi diagram from point sites with clip options.
 *
 * @returns Modal or `null` when not active.
 */
export function VoronoiAnalysis() {
  const active = useUIStore((s) => s.activeAnalysisDialog);
  const setActive = useUIStore((s) => s.setActiveAnalysisDialog);
  const groups = useLayerStore((s) => s.groups);
  const getAllLayers = useLayerStore((s) => s.getAllLayers);

  const { isRunning, progress, runAnalysis } = useAnalysis();

  const pointLayers = useMemo(() => getAllLayers().filter(isPointLayer), [getAllLayers]);
  const allLayers = useMemo(() => getAllLayers(), [getAllLayers]);

  const [layerId, setLayerId] = useState('');
  const [clipMode, setClipMode] = useState<ClipMode>('viewport');
  const [clipLayerId, setClipLayerId] = useState('');
  const [bboxText, setBboxText] = useState('116.2,39.8,116.5,40.0');
  const [outputName, setOutputName] = useState('Voronoi');
  const [outputGroupId, setOutputGroupId] = useState('analysis');
  const [preview, setPreview] = useState(true);

  const onCancel = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const onRun = useCallback(() => {
    runAnalysis('voronoi', {
      layerId,
      clipMode,
      clipLayerId,
      bboxText,
      outputName,
      outputGroupId,
      preview,
    });
  }, [bboxText, clipLayerId, clipMode, layerId, outputGroupId, outputName, preview, runAnalysis]);

  if (active !== 'voronoi') {
    return null;
  }

  return (
    <AnalysisDialogWrapper
      title="Voronoi 分析"
      icon={Hexagon}
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

        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          裁剪范围
          <select
            className={INPUT_CLASS}
            value={clipMode}
            onChange={(e) => {
              setClipMode(e.target.value as ClipMode);
            }}
          >
            <option value="viewport">当前视口</option>
            <option value="bbox">自定义 BBox</option>
            <option value="layer">指定图层</option>
          </select>
        </label>

        {clipMode === 'bbox' ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            BBox (minLng,minLat,maxLng,maxLat)
            <input
              type="text"
              className={INPUT_CLASS}
              value={bboxText}
              onChange={(e) => {
                setBboxText(e.target.value);
              }}
            />
          </label>
        ) : null}

        {clipMode === 'layer' ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            裁剪图层
            <select
              className={INPUT_CLASS}
              value={clipLayerId}
              onChange={(e) => {
                setClipLayerId(e.target.value);
              }}
            >
              <option value="">选择图层…</option>
              {allLayers.map((l: LayerConfig) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

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
