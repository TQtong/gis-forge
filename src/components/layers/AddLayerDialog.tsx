import type { LayerConfig, LayerKind, SourceKind } from '@/types';
import { SAMPLE_LAYERS, type SampleLayerItem } from '@/data/sampleLayers';
import { useLayerStore } from '@/stores/layerStore';
import { useUIStore } from '@/stores/uiStore';
import {
  Box,
  Building2,
  Globe,
  Map,
  MapPin,
  Route,
  Satellite,
  Upload,
  Wind,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

/**
 * Maps a source kind to a default renderer kind for new layers.
 *
 * @param source - Source driver key from the add-layer form.
 * @returns Layer kind used by `LayerConfig.type`.
 */
function sourceKindToLayerKind(source: SourceKind): LayerKind {
  switch (source) {
    case 'raster-tile':
    case 'wms':
    case 'wmts':
      return 'raster';
    case 'vector-tile':
    case 'geojson':
    case 'wfs':
      return 'fill';
    case '3d-tiles':
      return '3d-tiles';
    case 'pmtiles':
      return 'fill';
    default:
      return 'fill';
  }
}

/**
 * Builds a `LayerConfig` from a sample card selection.
 *
 * @param sample - Sample metadata from `SAMPLE_LAYERS`.
 * @returns A fresh layer configuration with unique ids.
 */
function sampleToLayerConfig(sample: SampleLayerItem): LayerConfig {
  const suffix = `${Date.now()}`;
  const id = `layer-${sample.id}-${suffix}`;
  const kind = sample.type === '3d-tiles' ? '3d-tiles' : sourceKindToLayerKind(sample.type);
  return {
    id,
    name: sample.name,
    type: kind,
    sourceId: `source-${sample.id}-${suffix}`,
    visible: true,
    opacity: 1,
    paint: {},
    layout: {},
    filter: [],
    minzoom: 0,
    maxzoom: 24,
    error: null,
    loading: false,
  };
}

const DATA_TYPES: { key: SourceKind; label: string }[] = [
  { key: 'vector-tile', label: '矢量瓦片' },
  { key: 'raster-tile', label: '栅格瓦片' },
  { key: 'geojson', label: 'GeoJSON' },
  { key: '3d-tiles', label: '3D Tiles' },
  { key: 'wms', label: 'WMS' },
  { key: 'wmts', label: 'WMTS' },
  { key: 'wfs', label: 'WFS' },
  { key: 'pmtiles', label: 'PMTiles' },
];

const RENDER_TYPES: { key: LayerKind; label: string }[] = [
  { key: 'fill', label: '填充' },
  { key: 'line', label: '线' },
  { key: 'circle', label: '圆' },
  { key: 'symbol', label: '符号' },
  { key: 'raster', label: '栅格' },
  { key: 'heatmap', label: '热力' },
  { key: 'extrusion', label: '挤出' },
  { key: '3d-tiles', label: '3D Tiles' },
];

const GROUP_OPTIONS: { id: string; label: string }[] = [
  { id: 'basemap', label: '底图' },
  { id: 'vector', label: '矢量图层' },
  { id: 'overlay', label: '叠加图层' },
  { id: 'analysis', label: '分析结果' },
];

/**
 * Sample card icon mapping for the grid UI.
 *
 * @param icon - Sample icon key.
 * @returns Lucide icon component.
 */
function sampleIcon(icon: SampleLayerItem['icon']) {
  switch (icon) {
    case 'map':
      return Map;
    case 'satellite':
      return Satellite;
    case 'globe':
      return Globe;
    case 'building':
      return Building2;
    case 'mapPin':
      return MapPin;
    case 'wind':
      return Wind;
    case 'route':
      return Route;
    case 'box':
      return Box;
    default:
      return Map;
  }
}

/**
 * Modal dialog to add layers from URL, upload, or built-in samples.
 *
 * @returns Dialog portal content or null when closed.
 */
export function AddLayerDialog() {
  const open = useUIStore((s) => s.addLayerDialogOpen);
  const setOpen = useUIStore((s) => s.setAddLayerDialogOpen);
  const addLayer = useLayerStore((s) => s.addLayer);

  const titleId = useId();
  const [tab, setTab] = useState<'url' | 'file' | 'sample'>('url');

  const [dataType, setDataType] = useState<SourceKind>('vector-tile');
  const [serviceUrl, setServiceUrl] = useState('');
  const [layerName, setLayerName] = useState('');
  const [renderType, setRenderType] = useState<LayerKind>('fill');
  const [targetGroupId, setTargetGroupId] = useState('vector');

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  const layerFromUrlTab = useCallback(() => {
    const id = `layer-url-${Date.now()}`;
    const name = layerName.trim() || '未命名图层';
    const layer: LayerConfig = {
      id,
      name,
      type: renderType,
      sourceId: `source-${id}`,
      visible: true,
      opacity: 1,
      paint: {},
      layout: {},
      filter: [],
      minzoom: 0,
      maxzoom: 24,
      error: null,
      loading: Boolean(serviceUrl.trim()),
    };
    addLayer(targetGroupId, layer);
  }, [addLayer, layerName, renderType, serviceUrl, targetGroupId]);

  const onAdd = useCallback(() => {
    if (tab === 'url') {
      layerFromUrlTab();
    }
    setOpen(false);
  }, [layerFromUrlTab, setOpen, tab]);

  const onPickSample = useCallback(
    (sample: SampleLayerItem) => {
      const layer = sampleToLayerConfig(sample);
      addLayer(targetGroupId, layer);
      setOpen(false);
    },
    [addLayer, setOpen, targetGroupId],
  );

  const groupSelect = useMemo(
    () => (
      <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
        目标分组
        <select
          value={targetGroupId}
          onChange={(e) => {
            setTargetGroupId(e.target.value);
          }}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
        >
          {GROUP_OPTIONS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
    ),
    [targetGroupId],
  );

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 py-10">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mt-20 w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-xl"
      >
        <div className="border-b border-[var(--border)] px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
            添加图层
          </h2>
        </div>

        <div className="flex gap-2 border-b border-[var(--border)] px-4 pt-3">
          {(
            [
              ['url', 'URL/服务'],
              ['file', '文件上传'],
              ['sample', '示例数据'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
              }}
              className={`border-b-2 px-2 pb-2 text-sm ${
                tab === key
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
          {tab === 'url' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {DATA_TYPES.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => {
                      setDataType(d.key);
                    }}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      dataType === d.key
                        ? 'border-[var(--accent)] bg-[var(--highlight)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                服务 URL
                <input
                  value={serviceUrl}
                  onChange={(e) => {
                    setServiceUrl(e.target.value);
                  }}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 font-mono text-sm text-[var(--text-primary)]"
                  placeholder="https://..."
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                  onClick={() => {
                    setRenderType(sourceKindToLayerKind(dataType));
                  }}
                >
                  自动检测
                </button>
              </div>

              <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-input)] px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                预览区域（占位）：连接服务后将显示缩略预览。
              </div>

              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                图层名称
                <input
                  value={layerName}
                  onChange={(e) => {
                    setLayerName(e.target.value);
                  }}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                渲染类型
                <select
                  value={renderType}
                  onChange={(e) => {
                    setRenderType(e.target.value as LayerKind);
                  }}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                >
                  {RENDER_TYPES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              {groupSelect}
            </div>
          ) : null}

          {tab === 'file' ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-input)] px-4 py-10 text-center">
              <Upload className="size-10 text-[var(--text-muted)]" strokeWidth={1.5} />
              <p className="text-sm text-[var(--text-secondary)]">拖拽文件到此处</p>
              <button
                type="button"
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90"
              >
                选择文件
              </button>
              <p className="text-xs text-[var(--text-muted)]">
                支持 GeoJSON、KML、Shapefile（zip）、CSV 等（具体解析由引擎完成）。
              </p>
              {groupSelect}
            </div>
          ) : null}

          {tab === 'sample' ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SAMPLE_LAYERS.map((s) => {
                  const Icon = sampleIcon(s.icon);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        onPickSample(s);
                      }}
                      className="flex flex-col items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-3 text-center hover:bg-[var(--bg-panel-hover)]"
                    >
                      <Icon className="size-6 text-[var(--accent)]" strokeWidth={2} />
                      <span className="text-xs font-medium text-[var(--text-primary)]">{s.name}</span>
                    </button>
                  );
                })}
              </div>
              {groupSelect}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
            onClick={() => {
              setOpen(false);
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-40"
            disabled={tab === 'file'}
            onClick={onAdd}
          >
            添加图层
          </button>
        </div>
      </div>
    </div>
  );
}
