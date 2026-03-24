import { useMemo, type ReactElement } from 'react';
import { ClipboardList, Layers, Settings, Wrench, X } from 'lucide-react';
import { AnalysisMenu } from '@/components/toolbar/AnalysisMenu';
import { ToolGroup } from '@/components/toolbar/ToolGroup';
import { LeftPanel } from '@/components/layout/LeftPanel';
import { PropertyTab } from '@/components/properties/PropertyTab';
import { useResponsive } from '@/hooks/useResponsive';
import { useUIStore, type MobileOverlayTab } from '@/stores/uiStore';

const ICON = 20;

/**
 * Mobile-only bottom tab bar; opens full-screen overlays for each section.
 *
 * @returns Tab bar + overlay host, or null when not in the `mobile` breakpoint.
 */
export function MobileTabBar(): ReactElement | null {
  const breakpoint = useResponsive();
  const mobileOverlay = useUIStore((s) => s.mobileOverlay);
  const setMobileOverlay = useUIStore((s) => s.setMobileOverlay);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab);

  const tabs = useMemo(
    () =>
      [
        { id: 'layers' as const, label: '📚 图层', Icon: Layers },
        { id: 'tools' as const, label: '🔧 工具', Icon: Wrench },
        { id: 'attributes' as const, label: '📋 属性', Icon: ClipboardList },
        { id: 'settings' as const, label: '⚙ 设置', Icon: Settings },
      ] as const,
    [],
  );

  if (breakpoint !== 'mobile') {
    return null;
  }

  const close = (): void => {
    setMobileOverlay(null);
  };

  const onTab = (id: MobileOverlayTab): void => {
    if (id === 'attributes') {
      setRightPanelTab('attributes');
    }
    if (id === 'settings') {
      setSettingsOpen(true);
      setMobileOverlay(null);
      return;
    }
    setMobileOverlay(mobileOverlay === id ? null : id);
  };

  return (
    <>
      {mobileOverlay && mobileOverlay !== 'settings' && (
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-[var(--bg-primary)]"
          role="dialog"
          aria-modal="true"
          aria-label="移动面板"
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-3 bg-[var(--bg-panel)]">
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {mobileOverlay === 'layers' && '图层'}
              {mobileOverlay === 'tools' && '工具'}
              {mobileOverlay === 'attributes' && '属性'}
            </span>
            <button
              type="button"
              className="rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]"
              aria-label="关闭"
              onClick={close}
            >
              <X size={20} aria-hidden />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mobileOverlay === 'layers' && (
              <div className="h-full min-h-[50vh]">
                <LeftPanel />
              </div>
            )}
            {mobileOverlay === 'tools' && (
              <div className="flex flex-col gap-3 p-3">
                <ToolGroup />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)]">分析</span>
                  <AnalysisMenu />
                </div>
              </div>
            )}
            {mobileOverlay === 'attributes' && (
              <div className="p-2">
                <PropertyTab />
              </div>
            )}
          </div>
        </div>
      )}

      <nav
        className="fixed bottom-0 left-0 right-0 z-[90] flex h-14 w-full items-stretch border-t border-[var(--border)] bg-[var(--bg-panel)] pb-[env(safe-area-inset-bottom)]"
        role="tablist"
        aria-label="移动导航"
      >
        {tabs.map(({ id, label, Icon }) => {
          const active = id === 'settings' ? false : mobileOverlay === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] ${
                active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
              }`}
              onClick={() => {
                onTab(id);
              }}
            >
              <Icon size={ICON} aria-hidden strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
