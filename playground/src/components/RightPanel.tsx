import { useState } from 'react';
import { InspectorPanel } from './InspectorPanel';
import { ConfigPanel } from './ConfigPanel';
import { CodePreview } from './CodePreview';

/* ═══════════════════════════════════════════════════════════════════
   RightPanel — 右侧 3-Tab 容器
   Inspector（运行时状态）| Config（场景控件）| Code（示例代码）
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 右侧面板 Tab 标识符。
 * 使用字面量联合类型让编译器在 switch/if 链中检查穷举。
 */
type RightTab = 'inspector' | 'config' | 'code';

/** 单个 Tab 的描述信息。 */
interface TabDef {
  /** 与 RightTab 联合类型对应的唯一标识 */
  id: RightTab;
  /** 在 Tab 按钮上显示的人类可读标签 */
  label: string;
}

/**
 * 按显示顺序定义的 Tab 列表。
 * 使用 `as const` 确保数组和元素都是只读的。
 */
const TABS: readonly TabDef[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'config', label: 'Config' },
  { id: 'code', label: 'Code' },
] as const;

/**
 * 右侧面板容器，提供三个可切换 Tab：
 * - **Inspector** — 只读运行时状态查看器（Camera / Tiles / GPU / Stats）
 * - **Config** — 根据当前场景动态生成的配置控件
 * - **Code** — 当前场景的最小可运行代码示例 + 复制按钮
 *
 * Tab 状态保存在组件本地 `useState` 中，因为它不需要被
 * 其他组件消费，也不需要在卸载后保留。
 *
 * @returns 右侧面板 JSX
 *
 * @example
 * <Panel defaultSize={25} minSize={15}>
 *   <RightPanel />
 * </Panel>
 */
export function RightPanel() {
  /**
   * 当前激活的 Tab。
   * 默认打开 Inspector，因为运行时状态是开发者最频繁查看的信息。
   */
  const [activeTab, setActiveTab] = useState<RightTab>('inspector');

  return (
    <div className="flex h-full flex-col bg-[var(--bg-panel)]">

      {/* ── Tab 栏 ─── 固定高度，水平排列三个按钮 ── */}
      <div className="flex h-9 shrink-0 border-b border-[var(--border)]">
        {TABS.map((tab) => {
          /* 判断当前按钮是否处于选中态 */
          const isActive = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={[
                /* flex-1 让所有 Tab 等宽分布 */
                'flex-1 text-xs font-medium transition-colors duration-150',
                /* 选中态：底部 accent 色 2px 边框 + accent 文字 */
                isActive
                  ? 'border-b-2 border-[var(--accent)] text-[var(--accent)]'
                  : 'border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Tab 内容区 ─── 可滚动，占满剩余空间 ── */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'inspector' && <InspectorPanel />}
        {activeTab === 'config' && <ConfigPanel />}
        {activeTab === 'code' && <CodePreview />}
      </div>
    </div>
  );
}
