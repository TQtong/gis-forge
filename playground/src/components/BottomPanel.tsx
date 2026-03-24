import { Terminal, BarChart3, Grid3x3, Code2 } from 'lucide-react';
import { useDevtoolsStore } from '../stores/devtoolsStore';
import { ConsoleTab } from './ConsoleTab';
import { PerformanceTab } from './PerformanceTab';
import { TilesTab } from './TilesTab';
import { ShadersTab } from './ShadersTab';

/* ═══════════════════════════════════════════════════════════════════
   BottomPanel — 底部 4-Tab DevTools 容器
   Console（日志）| Performance（性能）| Tiles（瓦片）| Shaders（着色器）
   Tab 状态存储在 devtoolsStore 中，以便其他组件（如键盘快捷键）能切换。
   ═══════════════════════════════════════════════════════════════════ */

/** 底部面板 Tab 标识符 */
type BottomTab = 'console' | 'performance' | 'tiles' | 'shaders';

/** 单个 Tab 的描述信息（含图标组件） */
interface TabDef {
  /** 与 devtoolsStore.bottomTab 对应的唯一标识 */
  id: BottomTab;
  /** Tab 按钮上显示的文字 */
  label: string;
  /**
   * Lucide 图标组件引用。
   * 使用 React.ComponentType 以允许直接作为 JSX 元素渲染。
   */
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

/** Lucide 图标统一尺寸（像素） */
const ICON_SIZE = 14;

/**
 * 按显示顺序定义的 Tab 列表。
 * 图标选择遵循语义：
 * - Terminal → Console 日志
 * - BarChart3 → Performance 图表
 * - Grid3x3 → Tiles 网格
 * - Code2 → Shaders 代码
 */
const TABS: readonly TabDef[] = [
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'performance', label: 'Performance', icon: BarChart3 },
  { id: 'tiles', label: 'Tiles', icon: Grid3x3 },
  { id: 'shaders', label: 'Shaders', icon: Code2 },
] as const;

/**
 * 底部 DevTools 面板容器。
 *
 * 提供四个 Tab 页：
 * - **Console** — 引擎日志查看器（过滤 / 搜索 / 清除）
 * - **Performance** — FPS / GPU 内存 / Draw Calls 面板
 * - **Tiles** — 瓦片网格检查器
 * - **Shaders** — Shader 变体检查器
 *
 * 当前 Tab 存储在 `devtoolsStore.bottomTab`，方便键盘快捷键
 * （1/2/3/4）和其他组件切换。
 *
 * @returns 底部面板 JSX
 *
 * @example
 * <Panel defaultSize={30} minSize={10}>
 *   <BottomPanel />
 * </Panel>
 */
export function BottomPanel() {
  /* 从 devtoolsStore 读取当前 Tab 及切换方法 */
  const bottomTab = useDevtoolsStore((s) => s.bottomTab);
  const setBottomTab = useDevtoolsStore((s) => s.setBottomTab);

  return (
    <div className="flex h-full flex-col bg-[var(--bg-panel)]">

      {/* ── Tab 栏 ─── 紧凑设计，高度 32px ── */}
      <div className="flex h-8 shrink-0 items-center border-b border-[var(--border)]">
        {TABS.map((tab) => {
          const isActive = tab.id === bottomTab;
          /* 解构图标组件以直接渲染为 JSX */
          const IconComponent = tab.icon;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBottomTab(tab.id)}
              className={[
                /* 内联 flex + 小 padding 打造紧凑按钮 */
                'flex items-center gap-1 px-3 py-1 text-xs transition-colors duration-150',
                /* 选中态：accent 文字 + 底部边框指示器 */
                isActive
                  ? 'border-b-2 border-[var(--accent)] text-[var(--accent)]'
                  : 'border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
              ].join(' ')}
            >
              <IconComponent size={ICON_SIZE} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Tab 内容区 ─── 占满剩余空间 ── */}
      <div className="flex-1 overflow-hidden">
        {bottomTab === 'console' && <ConsoleTab />}
        {bottomTab === 'performance' && <PerformanceTab />}
        {bottomTab === 'tiles' && <TilesTab />}
        {bottomTab === 'shaders' && <ShadersTab />}
      </div>
    </div>
  );
}
