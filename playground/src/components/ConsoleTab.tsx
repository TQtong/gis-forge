import { useState, useRef, useEffect, useMemo } from 'react';
import { Info, AlertTriangle, XCircle, Timer, Search, Trash2 } from 'lucide-react';
import { useDevtoolsStore } from '../stores/devtoolsStore';
import type { LogEntry } from '../types';

/* ═══════════════════════════════════════════════════════════════════
   ConsoleTab — 日志查看器
   支持按级别过滤、关键词搜索、一键清除、新日志自动滚动到底部。
   ═══════════════════════════════════════════════════════════════════ */

/* ── 常量 ────────────────────────────────────────────────── */

/** 日志级别标识符 */
type LogLevel = LogEntry['level'];

/** 下拉过滤器选项（"all" 表示不过滤） */
type FilterOption = 'all' | LogLevel;

/** 过滤器下拉选项列表 */
const FILTER_OPTIONS: { value: FilterOption; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'perf', label: 'Perf' },
];

/** Lucide 图标统一尺寸（像素） */
const ICON_SIZE = 14;

/**
 * 日志级别 → 图标组件映射。
 * 语义对应：info=圆形信息、warn=三角警告、error=圆形叉号、perf=计时器。
 */
const LEVEL_ICONS: Record<LogLevel, React.ComponentType<{ size?: number; className?: string }>> = {
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
  perf: Timer,
};

/**
 * 日志级别 → CSS 变量颜色映射。
 * 与 index.css 中定义的主题色变量保持一致。
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  info: 'var(--success)',
  warn: 'var(--warning)',
  error: 'var(--error)',
  perf: 'var(--perf)',
};

/* ── 工具函数 ─────────────────────────────────────────── */

/**
 * 将 Unix 时间戳格式化为 HH:mm:ss 字符串。
 * 使用 Date 对象的本地时间方法，避免引入 date 库。
 *
 * @param ts - Unix 时间戳（毫秒）
 * @returns "HH:mm:ss" 格式字符串
 *
 * @example
 * formatTime(1711234567890) // → "14:32:01"
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  /* padStart 确保个位数时补零（如 "9" → "09"） */
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/* ── 子组件 ──────────────────────────────────────────── */

/** LogRow 的 Props */
interface LogRowProps {
  /** 日志条目数据 */
  entry: LogEntry;
}

/**
 * 单条日志渲染行。
 * 包含：彩色图标 + 时间戳 + 消息文本。
 * ERROR 级别额外显示建议和文档链接（如果有）。
 *
 * @param props - 日志条目
 * @returns 日志行 JSX
 *
 * @example
 * <LogRow entry={{ id: 1, level: 'info', timestamp: Date.now(), message: 'Initialized' }} />
 */
function LogRow({ entry }: LogRowProps) {
  const IconComponent = LEVEL_ICONS[entry.level];
  const color = LEVEL_COLORS[entry.level];

  return (
    <div className="flex items-start gap-2 border-b border-[var(--border)]/50 px-3 py-1 hover:bg-[var(--bg-panel-hover)]">
      {/* 级别图标，颜色根据日志级别动态设置 */}
      <span className="shrink-0 pt-0.5" style={{ color }}>
        <IconComponent size={ICON_SIZE} />
      </span>

      {/* 时间戳：等宽字体保证列对齐 */}
      <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
        {formatTime(entry.timestamp)}
      </span>

      {/* 消息正文 + 可选的建议/文档 */}
      <div className="min-w-0 flex-1">
        <span className="text-xs text-[var(--text-primary)]">{entry.message}</span>

        {/* ERROR 级别日志的额外建议信息 */}
        {entry.suggestion && (
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            💡 {entry.suggestion}
          </div>
        )}
        {/* 关联文档链接 */}
        {entry.docUrl && (
          <div className="mt-0.5">
            <a
              href={entry.docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--accent)] hover:underline"
            >
              📖 Documentation
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 主组件 ──────────────────────────────────────────── */

/**
 * 日志控制台 Tab。
 *
 * 功能：
 * 1. **级别过滤** — 下拉选择 All / Info / Warn / Error / Perf
 * 2. **关键词搜索** — 实时过滤日志消息内容
 * 3. **一键清除** — 清空所有日志
 * 4. **自动滚动** — 新日志到达时自动滚动到底部
 *
 * 数据来源：`devtoolsStore.logs` 数组。
 *
 * @returns 控制台 Tab JSX
 *
 * @example
 * <ConsoleTab />
 */
export function ConsoleTab() {
  /* ── 本地 UI 状态 ── */

  /** 当前级别过滤器选项 */
  const [filter, setFilter] = useState<FilterOption>('all');
  /** 搜索关键词（大小写不敏感匹配） */
  const [search, setSearch] = useState('');

  /* ── Store 数据 ── */
  const logs = useDevtoolsStore((s) => s.logs);
  const clearLogs = useDevtoolsStore((s) => s.clearLogs);

  /* 用于自动滚动到底部的容器 ref */
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * 过滤后的日志列表。
   * 使用 useMemo 避免每次渲染都重新过滤（日志数组可能很长）。
   */
  const filteredLogs = useMemo(() => {
    /* 将搜索词转小写，以实现大小写不敏感匹配 */
    const searchLower = search.toLowerCase();

    return logs.filter((entry) => {
      /* 级别过滤：all 通过所有级别 */
      if (filter !== 'all' && entry.level !== filter) return false;
      /* 关键词过滤：空搜索词通过所有日志 */
      if (searchLower && !entry.message.toLowerCase().includes(searchLower)) return false;
      return true;
    });
  }, [logs, filter, search]);

  /**
   * 新日志到达时自动滚动到底部。
   * 依赖 filteredLogs.length 确保过滤后列表变化也触发滚动。
   */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    /* scrollTop 设为 scrollHeight 实现滚动到底部 */
    container.scrollTop = container.scrollHeight;
  }, [filteredLogs.length]);

  return (
    <div className="flex h-full flex-col">

      {/* ── 顶部工具栏：过滤器 + 搜索 + 清除 ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">

        {/* 级别过滤下拉 */}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterOption)}
          className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
        >
          {FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {/* 搜索输入框：带图标前缀 */}
        <div className="relative flex-1">
          <Search
            size={12}
            className="absolute top-1/2 left-2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter logs..."
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-input)] py-1 pr-2 pl-7 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
        </div>

        {/* 清除按钮 */}
        <button
          type="button"
          onClick={clearLogs}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--error)]"
          title="Clear all logs"
        >
          <Trash2 size={ICON_SIZE} />
          Clear
        </button>
      </div>

      {/* ── 日志列表（可滚动）── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        {filteredLogs.length === 0 ? (
          /* 日志为空时显示占位提示 */
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-[var(--text-muted)]">
              {logs.length === 0 ? 'No logs yet' : 'No logs match the current filter'}
            </p>
          </div>
        ) : (
          /* 渲染过滤后的日志条目 */
          filteredLogs.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}
