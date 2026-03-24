/**
 * @file TopBar.tsx
 * @description GeoForge DevPlayground 顶部工具栏。
 * 包含 Logo 区域、主题切换按钮和三个面板折叠/展开按钮。
 * 高度固定 h-12（48px），背景使用 CSS 变量 --bg-panel。
 *
 * @stability experimental
 */

import {
  Globe,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useDevtoolsStore } from '../stores/devtoolsStore';

/** 工具栏图标统一尺寸（px） */
const ICON_SIZE = 18;

/**
 * 工具栏按钮的通用 Props 接口。
 */
interface ToolbarButtonProps {
  /** 按钮的无障碍标签 */
  ariaLabel: string;
  /** 点击回调 */
  onClick: () => void;
  /** 按钮内部的 React 节点（图标） */
  children: React.ReactNode;
  /** 可选：覆盖默认的标题提示 */
  title?: string;
}

/**
 * 通用工具栏按钮组件。
 * 统一样式：h-8 w-8 圆角 hover 变色。
 *
 * @param props - ToolbarButtonProps
 * @returns 按钮 JSX
 *
 * @example
 * <ToolbarButton ariaLabel="切换主题" onClick={handleClick}>
 *   <Sun size={18} />
 * </ToolbarButton>
 */
function ToolbarButton({
  ariaLabel,
  onClick,
  children,
  title,
}: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onClick={onClick}
      className="h-8 w-8 rounded-md flex items-center justify-center transition-colors duration-150"
      style={{
        color: 'var(--text-secondary)',
      }}
      onMouseEnter={(e) => {
        // hover 时切换背景色——直接操作 style 避免 Tailwind 动态类名问题
        (e.currentTarget as HTMLElement).style.background =
          'var(--bg-panel-hover)';
        (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
        (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
      }}
    >
      {children}
    </button>
  );
}

/**
 * GeoForge DevPlayground 顶部工具栏组件。
 *
 * 布局：
 * [Globe 图标] "GeoForge" (bold) "DevPlayground" (lighter)  ───────  [主题] [左面板] [右面板] [底部面板]
 *
 * 职责：
 * 1. 显示品牌 Logo
 * 2. 主题切换（dark ↔ light），同时更新 document.documentElement.dataset.theme
 * 3. 三个面板的折叠/展开按钮（状态来自 devtoolsStore）
 *
 * @returns TopBar JSX
 *
 * @example
 * <TopBar />
 */
export function TopBar(): JSX.Element {
  // ─── Store 订阅（按需选取，最小化重渲染） ───

  /** 当前主题 */
  const theme = useDevtoolsStore((s) => s.theme);

  /** 左面板折叠状态 */
  const isLeftPanelCollapsed = useDevtoolsStore((s) => s.isLeftPanelCollapsed);

  /** 右面板折叠状态 */
  const isRightPanelCollapsed = useDevtoolsStore(
    (s) => s.isRightPanelCollapsed,
  );

  /** 底部面板展开状态 */
  const isBottomPanelOpen = useDevtoolsStore((s) => s.isBottomPanelOpen);

  /** 切换主题 action */
  const toggleTheme = useDevtoolsStore((s) => s.toggleTheme);

  /** 切换左面板 action */
  const toggleLeftPanel = useDevtoolsStore((s) => s.toggleLeftPanel);

  /** 切换右面板 action */
  const toggleRightPanel = useDevtoolsStore((s) => s.toggleRightPanel);

  /** 切换底部面板 action */
  const toggleBottomPanel = useDevtoolsStore((s) => s.toggleBottomPanel);

  /**
   * 处理主题切换。
   * 同时更新 Zustand store 和 DOM 属性，确保 CSS 变量立即生效。
   */
  const handleThemeToggle = (): void => {
    toggleTheme();

    // 直接同步 DOM 属性，不等 React effect（消除闪烁）
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nextTheme);
  };

  return (
    <header
      className="h-12 flex items-center justify-between px-4 shrink-0"
      style={{
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* ─── 左侧：品牌 Logo ─── */}
      <div className="flex items-center gap-3">
        {/* Globe 图标，使用强调色呼应 GIS 定位 */}
        <Globe size={22} style={{ color: 'var(--accent)' }} />

        {/* 品牌名称：GeoForge 加粗 + DevPlayground 次要 */}
        <div className="flex items-baseline gap-1.5">
          <span
            className="text-base font-semibold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            GeoForge
          </span>
          <span
            className="text-sm font-normal"
            style={{ color: 'var(--text-secondary)' }}
          >
            DevPlayground
          </span>
        </div>
      </div>

      {/* ─── 右侧：功能按钮组 ─── */}
      <div className="flex items-center gap-2">
        {/* 主题切换：深色显示 Sun（点击切到浅色），浅色显示 Moon（点击切到深色） */}
        <ToolbarButton
          ariaLabel={
            theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'
          }
          onClick={handleThemeToggle}
        >
          {theme === 'dark' ? (
            <Sun size={ICON_SIZE} />
          ) : (
            <Moon size={ICON_SIZE} />
          )}
        </ToolbarButton>

        {/* 分隔线：在主题切换和面板按钮之间添加视觉分隔 */}
        <div
          className="w-px h-5 mx-1"
          style={{ background: 'var(--border)' }}
        />

        {/* 左面板折叠/展开 */}
        <ToolbarButton
          ariaLabel={isLeftPanelCollapsed ? '展开左侧面板' : '折叠左侧面板'}
          title={
            isLeftPanelCollapsed
              ? '展开左侧面板 [ [ ]'
              : '折叠左侧面板 [ [ ]'
          }
          onClick={toggleLeftPanel}
        >
          {isLeftPanelCollapsed ? (
            <PanelLeftOpen size={ICON_SIZE} />
          ) : (
            <PanelLeftClose size={ICON_SIZE} />
          )}
        </ToolbarButton>

        {/* 右面板折叠/展开 */}
        <ToolbarButton
          ariaLabel={
            isRightPanelCollapsed ? '展开右侧面板' : '折叠右侧面板'
          }
          title={
            isRightPanelCollapsed
              ? '展开右侧面板 [ ] ]'
              : '折叠右侧面板 [ ] ]'
          }
          onClick={toggleRightPanel}
        >
          {isRightPanelCollapsed ? (
            <PanelRightOpen size={ICON_SIZE} />
          ) : (
            <PanelRightClose size={ICON_SIZE} />
          )}
        </ToolbarButton>

        {/* 底部面板折叠/展开 */}
        <ToolbarButton
          ariaLabel={
            isBottomPanelOpen ? '折叠底部面板' : '展开底部面板'
          }
          title={
            isBottomPanelOpen
              ? '折叠底部面板 [F12]'
              : '展开底部面板 [F12]'
          }
          onClick={toggleBottomPanel}
        >
          {isBottomPanelOpen ? (
            <ChevronDown size={ICON_SIZE} />
          ) : (
            <ChevronUp size={ICON_SIZE} />
          )}
        </ToolbarButton>
      </div>
    </header>
  );
}
