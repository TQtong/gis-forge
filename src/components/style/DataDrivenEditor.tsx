import { ColorPicker } from '@/components/style/ColorPicker';
import { patchLayout } from '@/components/style/styleLayerUpdate';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';

/**
 * Props for {@link DataDrivenEditor}.
 */
export interface DataDrivenEditorProps {
  /** Layer whose data-driven styling is edited. */
  layer: LayerConfig;
}

type ColorMethod = 'categorical' | 'linear' | 'step';

type ColorPair = {
  /** Category value or bucket key as string. */
  value: string;
  /** Associated CSS color. */
  color: string;
};

/**
 * Data-driven color / width controls stored under `layout` keys (`gf-dd-*`).
 *
 * @param props - {@link DataDrivenEditorProps}
 * @returns Data-driven editor section.
 */
export function DataDrivenEditor(props: DataDrivenEditorProps): ReactElement {
  const { layer } = props;
  const l = layer.layout;

  const colorEnabled =
    typeof l['gf-dd-color-enabled'] === 'boolean' ? l['gf-dd-color-enabled'] : false;
  const colorProperty =
    typeof l['gf-dd-color-property'] === 'string' ? l['gf-dd-color-property'] : '';
  const colorMethod = (['categorical', 'linear', 'step'].includes(
    String(l['gf-dd-color-method']),
  )
    ? l['gf-dd-color-method']
    : 'categorical') as ColorMethod;
  const rawPairs = l['gf-dd-color-pairs'];
  const colorPairs: ColorPair[] = Array.isArray(rawPairs)
    ? (rawPairs as ColorPair[])
    : [{ value: '', color: '#4A90D9' }];

  const widthEnabled =
    typeof l['gf-dd-width-enabled'] === 'boolean' ? l['gf-dd-width-enabled'] : false;
  const widthProperty =
    typeof l['gf-dd-width-property'] === 'string' ? l['gf-dd-width-property'] : '';
  const widthMin =
    typeof l['gf-dd-width-min'] === 'number' && Number.isFinite(l['gf-dd-width-min'])
      ? l['gf-dd-width-min']
      : 1;
  const widthMax =
    typeof l['gf-dd-width-max'] === 'number' && Number.isFinite(l['gf-dd-width-max'])
      ? l['gf-dd-width-max']
      : 10;

  const showWidth = layer.type === 'line' || layer.type === 'circle';

  const setLayoutPatch = (patch: Record<string, unknown>) => patchLayout(layer, patch);

  const updatePair = (index: number, next: Partial<ColorPair>) => {
    const copy = colorPairs.map((p, i) => (i === index ? { ...p, ...next } : p));
    setLayoutPatch({ 'gf-dd-color-pairs': copy });
  };

  const addPair = () => {
    setLayoutPatch({ 'gf-dd-color-pairs': [...colorPairs, { value: '', color: '#cccccc' }] });
  };

  const removePair = (index: number) => {
    const copy = colorPairs.filter((_, i) => i !== index);
    setLayoutPatch({ 'gf-dd-color-pairs': copy.length > 0 ? copy : [{ value: '', color: '#cccccc' }] });
  };

  return (
    <div className="flex flex-col border-t border-[var(--border)] pt-2 mt-2">
      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mt-1 mb-1">
        ── 数据驱动样式 ──
      </div>

      <div className="flex items-center justify-between gap-2 py-1.5">
        <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">按属性着色</label>
        <div>
          <input
            type="checkbox"
            checked={colorEnabled}
            onChange={(e) => setLayoutPatch({ 'gf-dd-color-enabled': e.target.checked })}
            className="accent-[var(--accent)]"
            aria-label="按属性着色"
          />
        </div>
      </div>

      {colorEnabled ? (
        <>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">属性字段</label>
            <div>
              <input
                type="text"
                value={colorProperty}
                onChange={(e) => setLayoutPatch({ 'gf-dd-color-property': e.target.value })}
                className="w-40 rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
                placeholder="class"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">映射方式</label>
            <div>
              <select
                value={colorMethod}
                onChange={(e) =>
                  setLayoutPatch({ 'gf-dd-color-method': e.target.value as ColorMethod })
                }
                className="max-w-[160px] rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
              >
                <option value="categorical">分类映射</option>
                <option value="linear">线性插值</option>
                <option value="step">阶梯</option>
              </select>
            </div>
          </div>
          <div className="text-xs text-[var(--text-muted)] mb-1">值 → 颜色</div>
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-0.5">
            {colorPairs.map((pair, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <input
                  type="text"
                  value={pair.value}
                  onChange={(e) => updatePair(idx, { value: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-input)] px-1 py-0.5 text-xs text-[var(--text-primary)]"
                  placeholder="值"
                />
                <ColorPicker
                  color={pair.color}
                  onChange={(c) => updatePair(idx, { color: c })}
                  label={`颜色 ${idx + 1}`}
                />
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
                  onClick={() => removePair(idx)}
                  aria-label="删除映射"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="py-1">
            <button
              type="button"
              onClick={addPair}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-panel-hover)]"
            >
              添加映射
            </button>
          </div>
        </>
      ) : null}

      {showWidth ? (
        <>
          <div className="flex items-center justify-between gap-2 py-1.5 mt-2">
            <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
              按属性调整宽度
            </label>
            <div>
              <input
                type="checkbox"
                checked={widthEnabled}
                onChange={(e) => setLayoutPatch({ 'gf-dd-width-enabled': e.target.checked })}
                className="accent-[var(--accent)]"
                aria-label="按属性调整宽度"
              />
            </div>
          </div>
          {widthEnabled ? (
            <>
              <div className="flex items-center justify-between gap-2 py-1.5">
                <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
                  宽度字段
                </label>
                <div>
                  <input
                    type="text"
                    value={widthProperty}
                    onChange={(e) => setLayoutPatch({ 'gf-dd-width-property': e.target.value })}
                    className="w-40 rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)]"
                    placeholder="count"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 py-1.5">
                <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
                  最小宽度
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={widthMin}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLayoutPatch({ 'gf-dd-width-min': v });
                    }}
                    className="w-28 accent-[var(--accent)]"
                    aria-valuemin={0.5}
                    aria-valuemax={30}
                    aria-valuenow={widthMin}
                  />
                  <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
                    {widthMin}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 py-1.5">
                <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
                  最大宽度
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={widthMax}
                    onChange={(e) =>
                      setLayoutPatch({ 'gf-dd-width-max': Number(e.target.value) })
                    }
                    className="w-28 accent-[var(--accent)]"
                    aria-valuemin={0.5}
                    aria-valuemax={30}
                    aria-valuenow={widthMax}
                  />
                  <span className="w-10 text-right text-xs text-[var(--text-muted)] tabular-nums">
                    {widthMax}
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
