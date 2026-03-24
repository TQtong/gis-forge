import { Grid3x3 } from 'lucide-react';
import { useDevtoolsStore } from '../stores/devtoolsStore';
import { formatBytes, formatNumber } from '../utils/formatters';
import type { TileDebugInfo } from '../types';

/* ═══════════════════════════════════════════════════════════════════
   TilesTab — 瓦片检查器（占位实现）
   MVP 阶段仅显示提示文字 + 选中瓦片的详情卡片。
   后续集成引擎后增加瓦片网格叠加、边框开关、加载顺序等功能。
   ═══════════════════════════════════════════════════════════════════ */

/** Lucide 图标尺寸（像素） */
const ICON_SIZE = 32;

/**
 * 瓦片状态 → CSS 变量颜色映射。
 * 与 InspectorPanel 中的映射保持一致。
 */
const TILE_STATE_COLORS: Record<TileDebugInfo['state'], string> = {
  loaded: 'var(--success)',
  loading: 'var(--warning)',
  cached: 'var(--text-muted)',
  failed: 'var(--error)',
};

/* ── 子组件 ──────────────────────────────────────────── */

/** TileDetail 的 Props */
interface TileDetailProps {
  /** 选中的瓦片调试信息 */
  tile: TileDebugInfo;
}

/**
 * 瓦片详情卡片：展示选中瓦片的所有调试信息。
 * 使用 label-value 行对格式，等宽字体显示数值。
 *
 * @param props - 瓦片数据
 * @returns 瓦片详情卡片 JSX
 *
 * @example
 * <TileDetail tile={{ coord: '12/3245/1578', state: 'loaded', ... }} />
 */
function TileDetail({ tile }: TileDetailProps) {
  /** 单行 label-value 渲染 */
  function Row({ label, value }: { label: string; value: string }) {
    return (
      <div className="flex items-baseline justify-between gap-2 py-0.5">
        <span className="text-xs text-[var(--text-muted)]">{label}</span>
        <span className="font-mono text-xs text-[var(--text-primary)]">{value}</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-3">
      {/* 瓦片坐标标题 + 状态徽章 */}
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">
          {tile.coord}
        </span>
        {/* 彩色圆点 + 状态文字 */}
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: TILE_STATE_COLORS[tile.state] }}
          />
          <span className="text-xs text-[var(--text-secondary)]">{tile.state}</span>
        </span>
      </div>

      {/* 详情字段列表 */}
      <div className="flex flex-col">
        <Row label="Source" value={tile.source} />
        <Row label="Load Time" value={`${tile.loadTimeMs.toFixed(0)}ms`} />
        <Row label="Decode Time" value={`${tile.decodeTimeMs.toFixed(0)}ms`} />
        {/* GPU 占用字节数使用自适应单位格式化（KB/MB/GB） */}
        <Row label="GPU Size" value={formatBytes(tile.gpuBytes)} />
        {/* 要素数和三角形数使用千分位分隔 */}
        <Row label="Features" value={formatNumber(tile.featureCount)} />
        <Row label="Triangles" value={formatNumber(tile.triangleCount)} />
        <Row label="LOD Level" value={String(tile.lodLevel)} />
        {/* SSE（Screen Space Error）保留 1 位小数 + px 后缀 */}
        <Row label="SSE" value={`${tile.sse.toFixed(1)}px`} />
      </div>
    </div>
  );
}

/* ── 主组件 ──────────────────────────────────────────── */

/**
 * 瓦片检查器 Tab（占位实现）。
 *
 * 当前功能：
 * - 无选中瓦片时显示提示文字
 * - 有选中瓦片时显示详细的调试信息卡片
 *
 * 后续集成引擎后增加：
 * - 瓦片网格叠加渲染（Show Borders 开关）
 * - 加载顺序编号叠加（Show Load Order 开关）
 * - 数据源过滤下拉
 * - 点击地图瓦片自动选中
 *
 * @returns 瓦片 Tab JSX
 *
 * @example
 * <TilesTab />
 */
export function TilesTab() {
  /* 从 store 获取当前选中的瓦片 */
  const selectedTile = useDevtoolsStore((s) => s.selectedTile);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      {selectedTile ? (
        /* 有选中瓦片时渲染详情卡片 */
        <TileDetail tile={selectedTile} />
      ) : (
        /* 无选中瓦片时显示居中占位提示 */
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Grid3x3
            size={ICON_SIZE}
            className="text-[var(--text-muted)]"
          />
          <p className="text-sm text-[var(--text-muted)]">
            Select a tile on the map to inspect
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            Enable tile borders in the toolbar to see tile boundaries
          </p>
        </div>
      )}
    </div>
  );
}
