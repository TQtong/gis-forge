import { useDevtoolsStore } from '../stores/devtoolsStore';
import { formatBytes, formatNumber } from '../utils/formatters';
import type { PerfSample } from '../types';

/* ═══════════════════════════════════════════════════════════════════
   PerformanceTab — 性能仪表板
   使用简单 HTML/CSS 渲染（MVP 不依赖 Recharts），后续可升级为图表。
   数据来源：devtoolsStore.perfSamples 的最后一个采样点。
   ═══════════════════════════════════════════════════════════════════ */

/* ── 常量 ────────────────────────────────────────────────── */

/**
 * FPS 目标值。
 * 60fps 是 WebGPU 渲染的标准目标帧率。
 */
const TARGET_FPS = 60;

/**
 * FPS 显示颜色阈值。
 * ≥55fps → 绿色（健康），≥30fps → 黄色（警告），<30fps → 红色（严重）。
 */
const FPS_GREEN_THRESHOLD = 55;
const FPS_YELLOW_THRESHOLD = 30;

/** GPU 内存段的颜色和标签配置 */
const MEMORY_SEGMENTS: {
  /** PerfSample.gpuMemory 中的字段名 */
  key: keyof PerfSample['gpuMemory'];
  /** 显示标签 */
  label: string;
  /** 段颜色（Tailwind 的 bg 色值） */
  color: string;
}[] = [
  { key: 'textures', label: 'Textures', color: '#53a8b6' },
  { key: 'buffers', label: 'Buffers', color: '#ff9800' },
  { key: 'pipelines', label: 'Pipelines', color: '#9c27b0' },
];

/** 帧时间分段的颜色和标签配置 */
const FRAME_TIME_SEGMENTS: {
  /** PerfSample 中对应的毫秒字段名 */
  key: 'updateMs' | 'renderMs' | 'postMs' | 'idleMs';
  /** 显示标签 */
  label: string;
  /** 段颜色 */
  color: string;
}[] = [
  { key: 'updateMs', label: 'Update', color: '#4caf50' },
  { key: 'renderMs', label: 'Render', color: '#f44336' },
  { key: 'postMs', label: 'Post', color: '#ff9800' },
  { key: 'idleMs', label: 'Idle', color: '#556677' },
];

/** 百分比上限 */
const MAX_PERCENT = 100;

/* ── 工具函数 ─────────────────────────────────────────── */

/**
 * 根据 FPS 值返回对应的 CSS 变量颜色。
 * 高帧率绿色、中等黄色、低帧率红色——直观表达性能状态。
 *
 * @param fps - 当前帧率
 * @returns CSS 变量字符串
 *
 * @example
 * getFpsColor(60) // → "var(--success)"
 * getFpsColor(25) // → "var(--error)"
 */
function getFpsColor(fps: number): string {
  if (fps >= FPS_GREEN_THRESHOLD) return 'var(--success)';
  if (fps >= FPS_YELLOW_THRESHOLD) return 'var(--warning)';
  return 'var(--error)';
}

/* ── 子组件 ──────────────────────────────────────────── */

/** StatCard 的 Props */
interface StatCardProps {
  /** 指标名称 */
  label: string;
  /** 格式化后的数值字符串 */
  value: string;
}

/**
 * 单个统计指标卡片：大号等宽数字 + 底部标签。
 * 用于展示 Draw Calls / Triangles / Instances 等整数指标。
 *
 * @param props - 标签和值
 * @returns 统计卡片 JSX
 *
 * @example
 * <StatCard label="Draw Calls" value="47" />
 */
function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="flex flex-col items-center">
      {/* 大号等宽数字，突出显示 */}
      <span className="font-mono text-lg font-bold text-[var(--text-primary)]">
        {value}
      </span>
      {/* 底部标签，小字灰色 */}
      <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

/** SegmentBar 的 Props */
interface SegmentBarProps {
  /** 各段数据：label + 数值 + 颜色 */
  segments: { label: string; value: number; color: string }[];
  /** 总容量（进度条满值，如 GPU budget 或 16.67ms 帧时间） */
  total: number;
  /** 格式化函数，将 value 转为显示字符串 */
  formatValue: (value: number) => string;
}

/**
 * 分段水平进度条。将多个值堆叠渲染为彩色段。
 * 每段宽度 = (段值 / total) × 100%，最大不超过 100%。
 *
 * @param props - 段数据和总量
 * @returns 分段进度条 JSX
 *
 * @example
 * <SegmentBar
 *   segments={[{ label: 'Textures', value: 128, color: '#53a8b6' }]}
 *   total={512}
 *   formatValue={formatBytes}
 * />
 */
function SegmentBar({ segments, total, formatValue }: SegmentBarProps) {
  /* 避免除以零 */
  const safeDivisor = total > 0 ? total : 1;

  return (
    <div className="flex flex-col gap-1">
      {/* 堆叠进度条 */}
      <div className="flex h-4 w-full overflow-hidden rounded-sm bg-[var(--bg-input)]">
        {segments.map((seg) => {
          /* 计算每段百分比，限制在 0~100 之间 */
          const pct = Math.min((seg.value / safeDivisor) * MAX_PERCENT, MAX_PERCENT);
          /* 宽度为 0 时不渲染，避免不必要的 DOM 节点 */
          if (pct <= 0) return null;
          return (
            <div
              key={seg.label}
              className="h-full transition-[width] duration-300"
              style={{ width: `${pct.toFixed(1)}%`, backgroundColor: seg.color }}
              title={`${seg.label}: ${formatValue(seg.value)}`}
            />
          );
        })}
      </div>

      {/* 图例行：每段的彩色点 + 标签 + 数值 */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: seg.color }}
            />
            <span className="text-[10px] text-[var(--text-muted)]">
              {seg.label}: {formatValue(seg.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 主组件 ──────────────────────────────────────────── */

/**
 * 性能仪表板 Tab。
 *
 * 四个指标区：
 * 1. **FPS** — 大号数字 + "fps" 小标签，颜色根据帧率健康度变化
 * 2. **GPU Memory** — 分段进度条（Textures / Buffers / Pipelines）+ 总量/预算
 * 3. **Stats** — Draw Calls / Triangles / Instances 三个数字卡片
 * 4. **Frame Time** — 分段进度条（Update / Render / Post / Idle）
 *
 * MVP 使用简单 HTML/CSS 渲染，无 Recharts 图表。
 * 后续可在此基础上叠加时序折线图。
 *
 * @returns 性能 Tab JSX
 *
 * @example
 * <PerformanceTab />
 */
export function PerformanceTab() {
  /* 从 store 获取最新的性能采样点（数组的最后一个元素） */
  const perfSamples = useDevtoolsStore((s) => s.perfSamples);
  const latest: PerfSample | undefined = perfSamples[perfSamples.length - 1];

  /* 无采样数据时显示占位提示 */
  if (!latest) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-[var(--text-muted)]">Waiting for performance data...</p>
      </div>
    );
  }

  /* 帧时间总和（用于帧时间分段条的 total） */
  const totalFrameMs = latest.updateMs + latest.renderMs + latest.postMs + latest.idleMs;

  /* 目标帧时间：1000ms / targetFPS = 16.67ms（60fps） */
  const targetFrameMs = 1000 / TARGET_FPS;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">

      {/* ════════ 1. FPS 大数字 ════════ */}
      <div className="flex items-baseline gap-2">
        {/* FPS 数值：超大等宽字体，颜色随帧率健康度变化 */}
        <span
          className="font-mono text-4xl font-bold leading-none"
          style={{ color: getFpsColor(latest.fps) }}
        >
          {Math.round(latest.fps)}
        </span>
        <span className="text-xs text-[var(--text-muted)]">fps</span>
        {/* 目标帧率参考线 */}
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          target: {TARGET_FPS}fps
        </span>
      </div>

      {/* ════════ 2. GPU Memory 分段条 ════════ */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">GPU Memory</span>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {formatBytes(latest.gpuMemory.total)} / {formatBytes(latest.gpuMemory.budget)}
          </span>
        </div>
        <SegmentBar
          segments={MEMORY_SEGMENTS.map((seg) => ({
            label: seg.label,
            value: latest.gpuMemory[seg.key],
            color: seg.color,
          }))}
          total={latest.gpuMemory.budget}
          formatValue={formatBytes}
        />
      </div>

      {/* ════════ 3. Stats 数字卡片行 ════════ */}
      <div className="flex justify-around rounded-md bg-[var(--bg-input)] px-3 py-2">
        <StatCard label="Draw Calls" value={formatNumber(latest.drawCalls)} />
        <StatCard label="Triangles" value={formatNumber(latest.triangles)} />
        <StatCard label="Instances" value={formatNumber(latest.instances)} />
      </div>

      {/* ════════ 4. Frame Time 分段条 ════════ */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">Frame Time</span>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {totalFrameMs.toFixed(1)}ms / {targetFrameMs.toFixed(1)}ms
          </span>
        </div>
        <SegmentBar
          segments={FRAME_TIME_SEGMENTS.map((seg) => ({
            label: seg.label,
            value: latest[seg.key],
            color: seg.color,
          }))}
          total={Math.max(totalFrameMs, targetFrameMs)}
          formatValue={(v) => `${v.toFixed(1)}ms`}
        />
      </div>
    </div>
  );
}
