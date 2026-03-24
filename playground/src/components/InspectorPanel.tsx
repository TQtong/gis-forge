import { useSceneStore } from '../stores/sceneStore';
import {
  formatBytes,
  formatNumber,
  formatCoordinate,
  formatAngle,
} from '../utils/formatters';

/* ═══════════════════════════════════════════════════════════════════
   InspectorPanel — 只读运行时状态展示
   使用 <details>/<summary> 原生 HTML 做可折叠段落（最小化依赖）。
   当前使用 mock 数据填充；引擎集成后从 sceneStore 读取。
   ═══════════════════════════════════════════════════════════════════ */

/* ── 瓦片状态 → 颜色映射 ──────────────────────────────────────── */

/** 瓦片加载状态的标识 */
type TileState = 'loaded' | 'loading' | 'cached' | 'failed';

/**
 * 瓦片状态 → CSS 变量颜色映射。
 * loaded=绿（成功）、loading=黄（进行中）、cached=灰（冷数据）、failed=红（错误）。
 */
const TILE_STATE_COLORS: Record<TileState, string> = {
  loaded: 'var(--success)',
  loading: 'var(--warning)',
  cached: 'var(--text-muted)',
  failed: 'var(--error)',
};

/* ── Mock 数据 ─── 引擎集成前的占位数据 ────────────────────── */

/** 模拟相机状态（来自设计文档示例值） */
const MOCK_CAMERA = {
  /** 地图中心经纬度 [lon, lat] */
  center: [116.397428, 39.90923] as [number, number],
  /** 当前缩放级别 */
  zoom: 12.35,
  /** 旋转角（弧度），0 = 正北 */
  bearing: 0.12,
  /** 俯仰角（弧度），0 = 正俯视 */
  pitch: 0.45,
  /** 相机海拔高度（米） */
  altitude: 3542,
  /** 是否正在进行动画过渡 */
  isAnimating: false,
};

/** 模拟可见瓦片列表 */
const MOCK_TILES: { coord: string; state: TileState }[] = [
  { coord: '12/3245/1578', state: 'loaded' },
  { coord: '12/3246/1578', state: 'loading' },
  { coord: '12/3247/1578', state: 'cached' },
  { coord: '12/3245/1579', state: 'loaded' },
  { coord: '12/3246/1579', state: 'failed' },
];

/** 模拟 GPU 内存用量（MB） */
const MOCK_GPU_MEMORY = {
  /** 已用内存（MB） */
  used: 173.9,
  /** 内存预算上限（MB） */
  budget: 512,
};

/** 模拟帧统计数据 */
const MOCK_FRAME_STATS = {
  /** 每秒帧数 */
  fps: 58.3,
  /** 每帧绘制调用数 */
  drawCalls: 47,
  /** 每帧三角形数 */
  triangles: 284392,
  /** GPU 端单帧耗时（毫秒） */
  gpuTimeMs: 8.2,
};

/** GPU 内存进度条满值百分比上限 */
const PROGRESS_MAX_PERCENT = 100;

/* ── 子组件 ─── 标签-值行 ──────────────────────────────────── */

/** FieldRow 的 Props */
interface FieldRowProps {
  /** 字段名称（左侧灰色标签） */
  label: string;
  /** 字段值（右侧等宽字体） */
  value: string;
}

/**
 * 单行 label-value 对，用于在 Inspector 中展示键值数据。
 * label 使用 muted 色文字靠左，value 使用等宽字体靠右。
 *
 * @param props - 字段名和值
 * @returns 一行 JSX
 *
 * @example
 * <FieldRow label="zoom" value="12.35" />
 */
function FieldRow({ label, value }: FieldRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-3 py-0.5">
      {/* 标签：muted 色、小字号，作为字段名称 */}
      <span className="shrink-0 text-xs text-[var(--text-muted)]">{label}</span>
      {/* 值：等宽字体，便于对齐数字；靠右显示 */}
      <span className="truncate text-right font-mono text-xs text-[var(--text-primary)]">
        {value}
      </span>
    </div>
  );
}

/* ── 主组件 ──────────────────────────────────────────────── */

/**
 * 只读运行时状态检查器面板。
 *
 * 包含四个可折叠段落：
 * 1. **Camera State** — 相机位置、缩放、角度、动画状态
 * 2. **Visible Tiles** — 可见瓦片列表 + 加载状态徽章
 * 3. **GPU Memory** — 显存使用进度条
 * 4. **Frame Stats** — FPS / DrawCalls / 三角形 / GPU 耗时
 *
 * 当前使用 mock 数据。引擎集成后，从 sceneStore 读取
 * `getInspectorData()` 的返回值实时更新。
 *
 * @returns Inspector 面板 JSX
 *
 * @example
 * <InspectorPanel />
 */
export function InspectorPanel() {
  /* 读取 store 中的场景 ID（用于判断是否有活动场景） */
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  /* 计算 GPU 内存进度条百分比，限制在 0~100 之间 */
  const memoryPercent = MOCK_GPU_MEMORY.budget > 0
    ? Math.min(
        (MOCK_GPU_MEMORY.used / MOCK_GPU_MEMORY.budget) * PROGRESS_MAX_PERCENT,
        PROGRESS_MAX_PERCENT,
      )
    : 0;

  /* 如果没有活动场景，显示占位提示 */
  if (!activeSceneId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-[var(--text-muted)]">Select a scene to inspect</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">

      {/* ════════ 1. Camera State ════════ */}
      <details open>
        <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Camera State
        </summary>
        <div className="flex flex-col pb-2">
          {/* 经纬度使用 6 位小数（约 0.11m 精度）格式化 */}
          <FieldRow
            label="center"
            value={`[${formatCoordinate(MOCK_CAMERA.center[0])}, ${formatCoordinate(MOCK_CAMERA.center[1])}]`}
          />
          <FieldRow label="zoom" value={MOCK_CAMERA.zoom.toFixed(2)} />
          {/* 角度使用弧度 + 4 位小数格式化 */}
          <FieldRow label="bearing" value={formatAngle(MOCK_CAMERA.bearing)} />
          <FieldRow label="pitch" value={formatAngle(MOCK_CAMERA.pitch)} />
          {/* 海拔带 "m" 单位后缀 */}
          <FieldRow label="altitude" value={`${formatNumber(MOCK_CAMERA.altitude)}m`} />
          <FieldRow
            label="isAnimating"
            value={MOCK_CAMERA.isAnimating ? 'true' : 'false'}
          />
        </div>
      </details>

      {/* ════════ 2. Visible Tiles ════════ */}
      <details open>
        <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Visible Tiles ({MOCK_TILES.length})
        </summary>
        <div className="flex flex-col gap-0.5 pb-2">
          {MOCK_TILES.map((tile) => (
            <div
              key={tile.coord}
              className="flex items-center gap-2 px-3 py-0.5"
            >
              {/* 彩色圆点表示瓦片加载状态 */}
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: TILE_STATE_COLORS[tile.state] }}
              />
              {/* 瓦片坐标使用等宽字体以便对齐 z/x/y 列 */}
              <span className="font-mono text-xs text-[var(--text-primary)]">
                {tile.coord}
              </span>
              {/* 状态文字标签 */}
              <span className="ml-auto text-xs text-[var(--text-muted)]">
                {tile.state}
              </span>
            </div>
          ))}
        </div>
      </details>

      {/* ════════ 3. GPU Memory ════════ */}
      <details open>
        <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          GPU Memory
        </summary>
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {/* 进度条外框 */}
          <div className="h-3 w-full overflow-hidden rounded-sm bg-[var(--bg-input)]">
            {/* 进度条填充部分，宽度根据用量/预算百分比动态设置 */}
            <div
              className="h-full rounded-sm bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: `${memoryPercent.toFixed(1)}%` }}
            />
          </div>
          {/* 文字标注：已用 / 预算 */}
          <span className="text-right font-mono text-xs text-[var(--text-secondary)]">
            {formatBytes(MOCK_GPU_MEMORY.used * 1024 * 1024)} / {formatBytes(MOCK_GPU_MEMORY.budget * 1024 * 1024)}
          </span>
        </div>
      </details>

      {/* ════════ 4. Frame Stats ════════ */}
      <details open>
        <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Frame Stats
        </summary>
        <div className="flex flex-col pb-2">
          <FieldRow label="FPS" value={MOCK_FRAME_STATS.fps.toFixed(1)} />
          <FieldRow
            label="Draw Calls"
            value={formatNumber(MOCK_FRAME_STATS.drawCalls)}
          />
          {/* 三角形数使用千分位分隔，方便阅读大数字 */}
          <FieldRow
            label="Triangles"
            value={formatNumber(MOCK_FRAME_STATS.triangles)}
          />
          <FieldRow
            label="GPU Time"
            value={`${MOCK_FRAME_STATS.gpuTimeMs.toFixed(1)}ms`}
          />
        </div>
      </details>
    </div>
  );
}
