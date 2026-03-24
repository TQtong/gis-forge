/**
 * @file App.tsx
 * @description GeoForge DevPlayground 根布局组件。
 * 负责三栏面板布局（左/中/右）+ 底部面板 + 键盘快捷键 + URL hash 路由 + 主题切换。
 * 使用 react-resizable-panels 实现可拖拽分割面板。
 *
 * 布局结构：
 * ┌──────────────────────────────────────────────────────┐
 * │ TopBar (h-12)                                        │
 * ├──────────┬──────────────────────────┬────────────────┤
 * │ LeftPanel│     MapViewport          │   RightPanel   │
 * │ (280px)  │     (flex-1)             │   (320px)      │
 * │          ├──────────────────────────┤                │
 * │          │ BottomPanel (collapsible)│                │
 * └──────────┴──────────────────────────┴────────────────┘
 *
 * @stability experimental
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import { useSceneStore } from './stores/sceneStore';
import { useDevtoolsStore } from './stores/devtoolsStore';
import { TopBar } from './components/TopBar';
import { FeatureTree } from './components/FeatureTree';
import { MapViewport } from './components/MapViewport';
import { RightPanel } from './components/RightPanel';
import { BottomPanel } from './components/BottomPanel';

/** 左面板默认宽度百分比（对应 ~280px / 1920px） */
const LEFT_PANEL_DEFAULT_SIZE = 15;

/** 左面板最小宽度百分比（防止拖得太小） */
const LEFT_PANEL_MIN_SIZE = 10;

/** 右面板默认宽度百分比（对应 ~320px / 1920px） */
const RIGHT_PANEL_DEFAULT_SIZE = 17;

/** 右面板最小宽度百分比 */
const RIGHT_PANEL_MIN_SIZE = 12;

/** 底部面板展开时的默认高度百分比（~280px / 900px 可用高度） */
const BOTTOM_PANEL_DEFAULT_SIZE = 30;

/** 底部面板最小高度百分比（防止拖得太小，低于此值会折叠） */
const BOTTOM_PANEL_MIN_SIZE = 15;

/** 中间内容区最小宽度百分比（保证地图视口有足够空间） */
const CENTER_PANEL_MIN_SIZE = 30;

/** 地图视口最小高度百分比（保证地图在底部面板展开时仍可见） */
const MAP_VIEWPORT_MIN_SIZE = 20;

/**
 * GeoForge DevPlayground 根组件。
 *
 * 职责：
 * 1. 组合 TopBar / FeatureTree / MapViewport / RightPanel / BottomPanel 五大区域
 * 2. 通过 react-resizable-panels 实现可拖拽布局
 * 3. 同步面板折叠/展开状态（devtoolsStore ↔ Panel ref）
 * 4. 注册全局键盘快捷键（F12 / 1-4 / [ / ]）
 * 5. 管理 URL hash 路由（读取 + 监听 hashchange）
 * 6. 将主题状态同步到 documentElement 的 data-theme 属性
 *
 * @returns 根布局 JSX
 *
 * @example
 * // main.tsx
 * import { App } from './App';
 * createRoot(document.getElementById('root')!).render(<App />);
 */
export function App(): JSX.Element {
  // ═══════════════════════════════════════════════════════════
  // 面板 Ref（用于命令式控制 collapse / expand）
  // ═══════════════════════════════════════════════════════════

  /** 左侧面板（FeatureTree）的命令式引用 */
  const leftPanelRef = useRef<ImperativePanelHandle>(null);

  /** 右侧面板（RightPanel）的命令式引用 */
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  /** 底部面板（BottomPanel）的命令式引用 */
  const bottomPanelRef = useRef<ImperativePanelHandle>(null);

  // ═══════════════════════════════════════════════════════════
  // Store 订阅（按需选取字段，避免不必要的重渲染）
  // ═══════════════════════════════════════════════════════════

  /** 当前主题（'dark' | 'light'） */
  const theme = useDevtoolsStore((s) => s.theme);

  /** 左面板是否已折叠 */
  const isLeftPanelCollapsed = useDevtoolsStore((s) => s.isLeftPanelCollapsed);

  /** 右面板是否已折叠 */
  const isRightPanelCollapsed = useDevtoolsStore(
    (s) => s.isRightPanelCollapsed,
  );

  /** 底部面板是否展开 */
  const isBottomPanelOpen = useDevtoolsStore((s) => s.isBottomPanelOpen);

  /** 切换底部面板展开/折叠 */
  const toggleBottomPanel = useDevtoolsStore((s) => s.toggleBottomPanel);

  /** 设置底部面板当前 Tab */
  const setBottomTab = useDevtoolsStore((s) => s.setBottomTab);

  /** 切换左面板折叠 */
  const toggleLeftPanel = useDevtoolsStore((s) => s.toggleLeftPanel);

  /** 切换右面板折叠 */
  const toggleRightPanel = useDevtoolsStore((s) => s.toggleRightPanel);

  /** 设置当前激活场景 */
  const setActiveScene = useSceneStore((s) => s.setActiveScene);

  // ═══════════════════════════════════════════════════════════
  // 主题同步：将 Zustand theme 状态同步到 <html data-theme="...">
  // ═══════════════════════════════════════════════════════════

  useEffect(() => {
    // 将主题写入 documentElement，CSS 变量通过 :root[data-theme] 切换
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ═══════════════════════════════════════════════════════════
  // 面板状态同步：Store → Panel Ref（命令式 collapse/expand）
  // ═══════════════════════════════════════════════════════════

  /**
   * 同步左面板折叠状态。
   * 当 devtoolsStore.isLeftPanelCollapsed 变化时，命令式操控面板。
   */
  useEffect(() => {
    if (isLeftPanelCollapsed) {
      leftPanelRef.current?.collapse();
    } else {
      leftPanelRef.current?.expand();
    }
  }, [isLeftPanelCollapsed]);

  /**
   * 同步右面板折叠状态。
   */
  useEffect(() => {
    if (isRightPanelCollapsed) {
      rightPanelRef.current?.collapse();
    } else {
      rightPanelRef.current?.expand();
    }
  }, [isRightPanelCollapsed]);

  /**
   * 同步底部面板展开/折叠状态。
   * isBottomPanelOpen 初始为 false → mount 时自动折叠底部面板。
   */
  useEffect(() => {
    if (isBottomPanelOpen) {
      bottomPanelRef.current?.expand();
    } else {
      bottomPanelRef.current?.collapse();
    }
  }, [isBottomPanelOpen]);

  // ═══════════════════════════════════════════════════════════
  // URL Hash 路由：页面加载时读取 hash + 监听 hashchange 事件
  // ═══════════════════════════════════════════════════════════

  useEffect(() => {
    /**
     * 解析 URL hash 并切换到对应场景。
     * hash 格式：#/{sceneId}，如 #/p0-raster-tile-layer
     */
    const handleHashChange = (): void => {
      // 去掉 # 和可选的前导 /
      const hash = window.location.hash.replace(/^#\/?/, '');

      // 仅在 hash 非空时切换场景，避免清空当前状态
      if (hash) {
        setActiveScene(hash);
      }
    };

    // 页面加载时立即读取当前 hash
    handleHashChange();

    // 监听后续的 hash 变化（浏览器前进/后退、手动修改 URL）
    window.addEventListener('hashchange', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [setActiveScene]);

  // ═══════════════════════════════════════════════════════════
  // 全局键盘快捷键
  // ═══════════════════════════════════════════════════════════

  /**
   * 键盘快捷键回调，用 useCallback 包裹避免 effect 频繁重建。
   * - F12：切换底部面板
   * - 1/2/3/4：切换底部面板 Tab（console / performance / tiles / shaders）
   * - [：切换左面板
   * - ]：切换右面板
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      // 当焦点在输入框/文本域内时不触发快捷键，避免干扰用户输入
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (isInputFocused) {
        return;
      }

      switch (e.key) {
        case 'F12':
          // 阻止浏览器默认行为（如 Chrome 打开 DevTools）
          e.preventDefault();
          toggleBottomPanel();
          break;

        case '1':
          setBottomTab('console');
          break;

        case '2':
          setBottomTab('performance');
          break;

        case '3':
          setBottomTab('tiles');
          break;

        case '4':
          setBottomTab('shaders');
          break;

        case '[':
          toggleLeftPanel();
          break;

        case ']':
          toggleRightPanel();
          break;

        default:
          break;
      }
    },
    [toggleBottomPanel, setBottomTab, toggleLeftPanel, toggleRightPanel],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  // ═══════════════════════════════════════════════════════════
  // 面板折叠回调：Panel → Store（处理用户拖拽导致的折叠/展开）
  // ═══════════════════════════════════════════════════════════

  /**
   * 当左面板被拖拽折叠时，同步 store 状态。
   * 检查 isLeftPanelCollapsed 是否已经是目标值，防止无限循环。
   */
  const handleLeftPanelCollapse = useCallback((): void => {
    if (!isLeftPanelCollapsed) {
      toggleLeftPanel();
    }
  }, [isLeftPanelCollapsed, toggleLeftPanel]);

  /** 当左面板被拖拽展开时，同步 store 状态 */
  const handleLeftPanelExpand = useCallback((): void => {
    if (isLeftPanelCollapsed) {
      toggleLeftPanel();
    }
  }, [isLeftPanelCollapsed, toggleLeftPanel]);

  /** 当右面板被拖拽折叠时，同步 store 状态 */
  const handleRightPanelCollapse = useCallback((): void => {
    if (!isRightPanelCollapsed) {
      toggleRightPanel();
    }
  }, [isRightPanelCollapsed, toggleRightPanel]);

  /** 当右面板被拖拽展开时，同步 store 状态 */
  const handleRightPanelExpand = useCallback((): void => {
    if (isRightPanelCollapsed) {
      toggleRightPanel();
    }
  }, [isRightPanelCollapsed, toggleRightPanel]);

  /** 当底部面板被拖拽折叠时，同步 store 状态 */
  const handleBottomPanelCollapse = useCallback((): void => {
    if (isBottomPanelOpen) {
      toggleBottomPanel();
    }
  }, [isBottomPanelOpen, toggleBottomPanel]);

  /** 当底部面板被拖拽展开时，同步 store 状态 */
  const handleBottomPanelExpand = useCallback((): void => {
    if (!isBottomPanelOpen) {
      toggleBottomPanel();
    }
  }, [isBottomPanelOpen, toggleBottomPanel]);

  // ═══════════════════════════════════════════════════════════
  // 渲染
  // ═══════════════════════════════════════════════════════════

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* 顶部工具栏：Logo + 主题切换 + 面板折叠按钮 */}
      <TopBar />

      {/* 水平三栏布局：左侧面板 | 中间（地图 + 底部面板） | 右侧面板 */}
      <PanelGroup direction="horizontal" className="flex-1">
        {/* ─── 左侧面板：功能树导航 ─── */}
        <Panel
          ref={leftPanelRef}
          defaultSize={LEFT_PANEL_DEFAULT_SIZE}
          minSize={LEFT_PANEL_MIN_SIZE}
          collapsible
          collapsedSize={0}
          onCollapse={handleLeftPanelCollapse}
          onExpand={handleLeftPanelExpand}
          order={1}
        >
          <FeatureTree />
        </Panel>

        {/* 左 ↔ 中 拖拽手柄 */}
        <PanelResizeHandle
          className="w-1 transition-colors duration-150"
          style={{
            background: 'var(--border)',
          }}
        />

        {/* ─── 中间区域：地图视口 + 底部面板（垂直分割） ─── */}
        <Panel minSize={CENTER_PANEL_MIN_SIZE} order={2}>
          <PanelGroup direction="vertical">
            {/* 地图视口（占满剩余垂直空间） */}
            <Panel minSize={MAP_VIEWPORT_MIN_SIZE} order={1}>
              <MapViewport />
            </Panel>

            {/* 中上 ↔ 底 拖拽手柄 */}
            <PanelResizeHandle
              className="h-1 transition-colors duration-150"
              style={{
                background: 'var(--border)',
              }}
            />

            {/* 底部面板：Console / Performance / Tiles / Shaders */}
            <Panel
              ref={bottomPanelRef}
              defaultSize={BOTTOM_PANEL_DEFAULT_SIZE}
              minSize={BOTTOM_PANEL_MIN_SIZE}
              collapsible
              collapsedSize={0}
              onCollapse={handleBottomPanelCollapse}
              onExpand={handleBottomPanelExpand}
              order={2}
            >
              <BottomPanel />
            </Panel>
          </PanelGroup>
        </Panel>

        {/* 中 ↔ 右 拖拽手柄 */}
        <PanelResizeHandle
          className="w-1 transition-colors duration-150"
          style={{
            background: 'var(--border)',
          }}
        />

        {/* ─── 右侧面板：Inspector / Config / Code ─── */}
        <Panel
          ref={rightPanelRef}
          defaultSize={RIGHT_PANEL_DEFAULT_SIZE}
          minSize={RIGHT_PANEL_MIN_SIZE}
          collapsible
          collapsedSize={0}
          onCollapse={handleRightPanelCollapse}
          onExpand={handleRightPanelExpand}
          order={3}
        >
          <RightPanel />
        </Panel>
      </PanelGroup>
    </div>
  );
}
