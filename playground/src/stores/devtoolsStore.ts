/* ═══════════════════════════════════════════════════════════════════════════
   devtoolsStore — DevTools 面板状态管理
   管理底部面板的展开/折叠、Tab 切换、日志列表、性能采样、
   瓦片调试、Shader 检查、侧面板折叠和主题切换。
   ═══════════════════════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import type { LogEntry, PerfSample, TileDebugInfo } from '../types';

/** 日志数组最大长度。超出后从头部（最旧的）丢弃 */
const MAX_LOG_COUNT = 1000;

/** 性能采样环形缓冲最大长度。保留最近 60 秒的数据（1 秒 1 次采样） */
const MAX_PERF_SAMPLES = 60;

/** 底部面板支持的 Tab 类型 */
export type BottomTabId = 'console' | 'performance' | 'tiles' | 'shaders';

/**
 * DevTools Store 的状态 + 动作定义。
 * 数据流：引擎事件 → pushLog/pushPerfSample → ConsoleTab/PerformanceTab 订阅渲染
 */
interface DevToolsState {
  // ─── Panel Visibility ───

  /**
   * 底部面板是否展开。
   * 默认折叠（false），通过 TopBar 按钮或 F12 快捷键切换。
   * 展开后默认高度 280px，可拖动调整。
   */
  isBottomPanelOpen: boolean;

  /**
   * 底部面板当前激活的 Tab。
   * 默认 'console'，可通过 Tab 标签点击或数字键 1~4 切换。
   */
  bottomTab: BottomTabId;

  /**
   * 左侧面板（FeatureTree）是否折叠。
   * 默认展开（false），通过 TopBar 按钮或 [ 快捷键切换。
   */
  isLeftPanelCollapsed: boolean;

  /**
   * 右侧面板（Inspector/Config/Code）是否折叠。
   * 默认展开（false），通过 TopBar 按钮或 ] 快捷键切换。
   */
  isRightPanelCollapsed: boolean;

  /**
   * 当前颜色主题。
   * 'dark' 为默认深色主题，'light' 为浅色主题。
   * 切换时同步更新 document.documentElement 的 data-theme 属性。
   */
  theme: 'dark' | 'light';

  // ─── Console Data ───

  /**
   * 日志条目数组。
   * 最多保留 MAX_LOG_COUNT（1000）条，超出后丢弃最旧的。
   * 由引擎 Logger 通过 pushLog 写入，ConsoleTab 订阅渲染。
   */
  logs: LogEntry[];

  // ─── Performance Data ───

  /**
   * 性能采样数据数组（环形缓冲语义）。
   * 最多保留 MAX_PERF_SAMPLES（60）个采样点（即 60 秒的滚动窗口）。
   * 由引擎 RenderStats 通过 pushPerfSample 每秒写入一次。
   */
  perfSamples: PerfSample[];

  // ─── Tile Inspector Data ───

  /**
   * 当前选中的瓦片调试信息。
   * 用户在 TilesTab 中点击地图瓦片后设置，null 表示未选中。
   */
  selectedTile: TileDebugInfo | null;

  // ─── Shader Inspector Data ───

  /**
   * 当前选中的 Shader 变体键名。
   * 如 'mercator/polygon/fill_solid'。null 表示未选中。
   */
  selectedShaderVariant: string | null;

  // ─── Actions ───

  /** 切换底部面板的展开/折叠状态 */
  toggleBottomPanel: () => void;

  /**
   * 设置底部面板当前 Tab。
   * 同时自动展开底部面板（如果当前是折叠状态）。
   *
   * @param tab - 目标 Tab ID
   */
  setBottomTab: (tab: BottomTabId) => void;

  /**
   * 追加一条日志条目。超过 MAX_LOG_COUNT 时丢弃最旧的。
   *
   * @param entry - 日志条目（id 由调用方生成，建议使用自增计数器）
   */
  pushLog: (entry: LogEntry) => void;

  /** 清空所有日志。由 ConsoleTab 的 Clear 按钮调用。 */
  clearLogs: () => void;

  /**
   * 追加一个性能采样点。超过 MAX_PERF_SAMPLES 时丢弃最旧的。
   *
   * @param sample - 性能采样数据
   */
  pushPerfSample: (sample: PerfSample) => void;

  /**
   * 设置选中的瓦片调试信息。
   *
   * @param tile - 瓦片信息对象，或 null 取消选中
   */
  setSelectedTile: (tile: TileDebugInfo | null) => void;

  /**
   * 设置选中的 Shader 变体键名。
   *
   * @param key - Shader 变体键名字符串，或 null 取消选中
   */
  setSelectedShaderVariant: (key: string | null) => void;

  /** 切换左侧面板的折叠/展开状态 */
  toggleLeftPanel: () => void;

  /** 切换右侧面板的折叠/展开状态 */
  toggleRightPanel: () => void;

  /**
   * 切换主题（dark ↔ light）。
   * 同步更新 document.documentElement.dataset.theme 以触发 CSS 变量切换。
   */
  toggleTheme: () => void;
}

/**
 * DevTools 状态 Zustand Store。
 *
 * @example
 * // 在组件中读取日志
 * const logs = useDevToolsStore((s) => s.logs);
 *
 * @example
 * // 从引擎事件桥接推送日志
 * useDevToolsStore.getState().pushLog({
 *   id: nextLogId++,
 *   level: 'info',
 *   timestamp: Date.now(),
 *   message: 'DeviceManager initialized',
 * });
 */
/** 别名导出（组件使用 camelCase 风格） */
export { useDevToolsStore as useDevtoolsStore };

export const useDevToolsStore = create<DevToolsState>((set) => ({
  // ─── 初始状态 ───
  isBottomPanelOpen: false,
  bottomTab: 'console',
  isLeftPanelCollapsed: false,
  isRightPanelCollapsed: false,
  theme: 'dark',
  logs: [],
  perfSamples: [],
  selectedTile: null,
  selectedShaderVariant: null,

  // ─── 动作实现 ───

  toggleBottomPanel: () => {
    set((state) => ({ isBottomPanelOpen: !state.isBottomPanelOpen }));
  },

  setBottomTab: (tab: BottomTabId) => {
    // 切换 Tab 时自动展开底部面板
    set({ bottomTab: tab, isBottomPanelOpen: true });
  },

  pushLog: (entry: LogEntry) => {
    set((state) => {
      const nextLogs = [...state.logs, entry];

      // 超出上限时丢弃最旧的条目
      if (nextLogs.length > MAX_LOG_COUNT) {
        return { logs: nextLogs.slice(nextLogs.length - MAX_LOG_COUNT) };
      }

      return { logs: nextLogs };
    });
  },

  clearLogs: () => {
    set({ logs: [] });
  },

  pushPerfSample: (sample: PerfSample) => {
    set((state) => {
      const nextSamples = [...state.perfSamples, sample];

      // 环形缓冲：超出上限时丢弃最旧的采样
      if (nextSamples.length > MAX_PERF_SAMPLES) {
        return { perfSamples: nextSamples.slice(nextSamples.length - MAX_PERF_SAMPLES) };
      }

      return { perfSamples: nextSamples };
    });
  },

  setSelectedTile: (tile: TileDebugInfo | null) => {
    set({ selectedTile: tile });
  },

  setSelectedShaderVariant: (key: string | null) => {
    set({ selectedShaderVariant: key });
  },

  toggleLeftPanel: () => {
    set((state) => ({ isLeftPanelCollapsed: !state.isLeftPanelCollapsed }));
  },

  toggleRightPanel: () => {
    set((state) => ({ isRightPanelCollapsed: !state.isRightPanelCollapsed }));
  },

  toggleTheme: () => {
    set((state) => {
      const nextTheme = state.theme === 'dark' ? 'light' : 'dark';

      // 同步更新 DOM 的 data-theme 属性以触发 CSS 变量切换
      document.documentElement.dataset['theme'] = nextTheme === 'light' ? 'light' : '';

      return { theme: nextTheme };
    });
  },
}));
