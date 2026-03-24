import { useLayerStore } from '@/stores/layerStore';
import type { LayerConfig } from '@/types';
import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';

/**
 * Props for {@link FilterEditor}.
 */
export interface FilterEditorProps {
  /** Layer whose visibility range and attribute filter are edited. */
  layer: LayerConfig;
}

type FilterRow = {
  /** Property name accessed via `['get', property]`. */
  property: string;
  /** Comparison operator. */
  operator: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in';
  /** Right-hand value (comma-separated for `in`). */
  value: string;
};

const OPS: FilterRow['operator'][] = ['==', '!=', '>', '<', '>=', '<=', 'in'];

/**
 * Build a Mapbox-like filter expression from UI rows; empty array means no filter.
 *
 * @param rows - Filter rows from the UI.
 * @returns Filter array or empty.
 */
function buildFilterExpr(rows: FilterRow[]): any[] {
  const valid = rows.filter((r) => r.property.trim().length > 0);
  if (valid.length === 0) {
    return [];
  }
  const parts: any[] = [];
  for (const row of valid) {
    const prop = row.property.trim();
    const raw = row.value;
    const num = Number(raw);
    const isNum = raw.trim() !== '' && Number.isFinite(num);
    switch (row.operator) {
      case '==':
        parts.push(
          isNum ? ['==', ['to-number', ['get', prop]], num] : ['==', ['get', prop], raw],
        );
        break;
      case '!=':
        parts.push(
          isNum ? ['!=', ['to-number', ['get', prop]], num] : ['!=', ['get', prop], raw],
        );
        break;
      case '>':
        parts.push(['>', ['to-number', ['get', prop]], isNum ? num : 0]);
        break;
      case '<':
        parts.push(['<', ['to-number', ['get', prop]], isNum ? num : 0]);
        break;
      case '>=':
        parts.push(['>=', ['to-number', ['get', prop]], isNum ? num : 0]);
        break;
      case '<=':
        parts.push(['<=', ['to-number', ['get', prop]], isNum ? num : 0]);
        break;
      case 'in': {
        const tokens = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (tokens.length === 0) {
          break;
        }
        parts.push(['in', ['get', prop], ...tokens]);
        break;
      }
      default:
        break;
    }
  }
  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return ['all', ...parts];
}

/**
 * Parse filter expression back into rows (best-effort for simple `all` chains).
 *
 * @param filter - Stored filter expression.
 * @returns Rows for the UI; empty if not recognized.
 */
function parseFilterToRows(filter: any): FilterRow[] {
  if (!Array.isArray(filter) || filter.length === 0) {
    return [{ property: '', operator: '==', value: '' }];
  }
  const rows: FilterRow[] = [];
  const walk = (node: any) => {
    if (!Array.isArray(node)) {
      return;
    }
    if (node[0] === 'all' && node.length > 1) {
      for (let i = 1; i < node.length; i += 1) {
        walk(node[i]);
      }
      return;
    }
    const lhs = node[1];
    if (node[0] === '==' && node.length === 3) {
      const rhs = node[2];
      if (Array.isArray(lhs) && lhs[0] === 'get' && typeof lhs[1] === 'string') {
        rows.push({ property: lhs[1], operator: '==', value: String(rhs) });
      } else if (
        Array.isArray(lhs) &&
        lhs[0] === 'to-number' &&
        Array.isArray(lhs[1]) &&
        lhs[1][0] === 'get'
      ) {
        rows.push({ property: String(lhs[1][1]), operator: '==', value: String(rhs) });
      }
    }
  };
  walk(filter);
  return rows.length > 0 ? rows : [{ property: '', operator: '==', value: '' }];
}

/**
 * Zoom range and attribute filter builder for a layer.
 *
 * @param props - {@link FilterEditorProps}
 * @returns Filter editor section.
 */
export function FilterEditor(props: FilterEditorProps): ReactElement {
  const { layer } = props;
  const updateLayer = useLayerStore((s) => s.updateLayer);

  const minZ = Math.max(0, Math.min(24, Math.floor(layer.minzoom)));
  const maxZ = Math.max(0, Math.min(24, Math.floor(layer.maxzoom)));
  const lo = Math.min(minZ, maxZ);
  const hi = Math.max(minZ, maxZ);

  const rows: FilterRow[] = useMemo(() => {
    const fromLayout = layer.layout['gf-filter-rows'];
    if (Array.isArray(fromLayout) && fromLayout.length > 0) {
      return fromLayout as FilterRow[];
    }
    return parseFilterToRows(layer.filter);
  }, [layer.filter, layer.layout]);

  const commitRows = useCallback(
    (next: FilterRow[]) => {
      const expr = buildFilterExpr(next);
      const current = useLayerStore.getState().getLayerById(layer.id);
      if (!current) {
        return;
      }
      updateLayer(layer.id, {
        filter: expr,
        layout: { ...current.layout, 'gf-filter-rows': next },
      });
    },
    [layer.id, updateLayer],
  );

  const setZoom = useCallback(
    (a: number, b: number) => {
      const x = Math.max(0, Math.min(24, Math.floor(a)));
      const y = Math.max(0, Math.min(24, Math.floor(b)));
      updateLayer(layer.id, { minzoom: Math.min(x, y), maxzoom: Math.max(x, y) });
    },
    [layer.id, updateLayer],
  );

  return (
    <div className="flex flex-col border-t border-[var(--border)] pt-2 mt-2">
      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mt-1 mb-1">
        ── 可见性 ──
      </div>
      <div className="flex flex-col gap-1 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--text-secondary)]">缩放范围</span>
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            z {lo} — {hi}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={24}
          step={1}
          value={lo}
          onChange={(e) => setZoom(Number(e.target.value), hi)}
          className="w-full accent-[var(--accent)]"
          aria-label="最小缩放级别"
        />
        <input
          type="range"
          min={0}
          max={24}
          step={1}
          value={hi}
          onChange={(e) => setZoom(lo, Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
          aria-label="最大缩放级别"
        />
      </div>

      <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mt-3 mb-1">
        ── 过滤条件 ──
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, idx) => (
          <div
            key={idx}
            className="flex flex-wrap items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-input)] p-1.5"
          >
            <select
              value={
                ['name', 'class', 'type', 'id'].includes(row.property) ? row.property : '__custom__'
              }
              onChange={(e) => {
                const v = e.target.value;
                const copy = rows.map((r, i) =>
                  i === idx
                    ? { ...r, property: v === '__custom__' ? '' : v }
                    : r,
                );
                commitRows(copy);
              }}
              className="w-[88px] rounded border border-[var(--border)] bg-[var(--bg-panel)] px-1 py-0.5 text-[10px] text-[var(--text-primary)]"
              aria-label="常用属性"
            >
              <option value="__custom__">自定义…</option>
              <option value="name">name</option>
              <option value="class">class</option>
              <option value="type">type</option>
              <option value="id">id</option>
            </select>
            <input
              type="text"
              value={row.property}
              onChange={(e) => {
                const copy = rows.map((r, i) => (i === idx ? { ...r, property: e.target.value } : r));
                commitRows(copy);
              }}
              className="min-w-[72px] flex-1 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-1 py-0.5 text-[10px] text-[var(--text-primary)]"
              placeholder="属性名"
              list={`gf-props-${layer.id}`}
            />
            <datalist id={`gf-props-${layer.id}`}>
              <option value="name" />
              <option value="class" />
              <option value="type" />
            </datalist>
            <select
              value={row.operator}
              onChange={(e) => {
                const copy = rows.map((r, i) =>
                  i === idx ? { ...r, operator: e.target.value as FilterRow['operator'] } : r,
                );
                commitRows(copy);
              }}
              className="w-[52px] rounded border border-[var(--border)] bg-[var(--bg-panel)] px-0.5 py-0.5 text-[10px] text-[var(--text-primary)]"
            >
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={row.value}
              onChange={(e) => {
                const copy = rows.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r));
                commitRows(copy);
              }}
              className="min-w-[50px] flex-1 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-1 py-0.5 text-[10px] text-[var(--text-primary)]"
              placeholder="值"
            />
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
              onClick={() => {
                const copy = rows.filter((_, i) => i !== idx);
                commitRows(copy.length > 0 ? copy : [{ property: '', operator: '==', value: '' }]);
              }}
              aria-label="移除此条件"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => commitRows([...rows, { property: '', operator: '==', value: '' }])}
        className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-panel-hover)]"
      >
        + 添加条件
      </button>
    </div>
  );
}
