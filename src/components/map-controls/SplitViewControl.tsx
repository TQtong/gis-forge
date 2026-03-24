import { useUIStore } from '@/stores/uiStore';
import { useLayerStore } from '@/stores/layerStore';

/**
 * Split-view comparison chrome (toolbar + placeholders for engine wiring).
 */
export function SplitViewControl() {
  const enabled = useUIStore((s) => s.splitViewEnabled);
  const mode = useUIStore((s) => s.splitViewMode);
  const setMode = useUIStore((s) => s.setSplitViewMode);
  const setEnabled = useUIStore((s) => s.setSplitViewEnabled);
  const layers = useLayerStore((s) => s.getAllLayers());

  if (!enabled) {
    return null;
  }

  const layerOptions = layers.filter((l) => l.visible);

  return (
    <div className="absolute left-0 right-0 top-0 z-20 flex flex-col gap-2 border-b border-[var(--border)] bg-[var(--bg-panel)]/95 px-3 py-2 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">对比模式</span>
        <div className="flex rounded-md border border-[var(--border)] p-0.5">
          <ModeBtn active={mode === 'side-by-side'} label="并排" onClick={() => setMode('side-by-side')} />
          <ModeBtn active={mode === 'slider'} label="滑动" onClick={() => setMode('slider')} />
        </div>
        <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          左
          <select
            className="max-w-[140px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-[var(--text-primary)]"
            defaultValue={layerOptions[0]?.id ?? ''}
          >
            {layerOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          右
          <select
            className="max-w-[140px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-[var(--text-primary)]"
            defaultValue={layerOptions[1]?.id ?? layerOptions[0]?.id ?? ''}
          >
            {layerOptions.map((l) => (
              <option key={`r-${l.id}`} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setEnabled(false)}
          className="ml-auto rounded-md bg-[var(--error)]/90 px-2 py-1 text-xs text-white hover:opacity-90"
        >
          退出对比
        </button>
      </div>

      {mode === 'side-by-side' && (
        <div className="flex h-32 gap-0 border border-[var(--border)] rounded-md overflow-hidden">
          <div className="flex-1 bg-[var(--bg-input)] flex items-center justify-center text-xs text-[var(--text-muted)]">
            左图层预览
          </div>
          <div className="w-1 cursor-col-resize bg-[var(--accent)]" title="拖动调整宽度" />
          <div className="flex-1 bg-[var(--bg-input)] flex items-center justify-center text-xs text-[var(--text-muted)]">
            右图层预览
          </div>
        </div>
      )}

      {mode === 'slider' && (
        <div className="relative h-32 border border-[var(--border)] rounded-md bg-[var(--bg-input)] overflow-hidden">
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-muted)]">
            滑动对比（占位）
          </div>
          <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 cursor-ew-resize bg-[var(--accent)] shadow-md" />
        </div>
      )}
    </div>
  );
}

/** Segmented mode button. */
function ModeBtn({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs ${
        active ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]'
      }`}
    >
      {label}
    </button>
  );
}
