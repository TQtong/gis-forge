import { useCallback, useState } from 'react';
import { Globe, Info, Keyboard, Monitor, Palette, Sparkles, X } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { AboutSettings } from '@/components/settings/AboutSettings';
import { AppearanceSettings } from '@/components/settings/AppearanceSettings';
import { GlobeSettings } from '@/components/settings/GlobeSettings';
import { PostProcessSettings } from '@/components/settings/PostProcessSettings';
import { RenderSettings } from '@/components/settings/RenderSettings';
import { ShortcutsSettings } from '@/components/settings/ShortcutsSettings';

/** Left navigation id for the settings modal. */
type SettingsNavId =
  | 'render'
  | 'postprocess'
  | 'globe'
  | 'appearance'
  | 'shortcuts'
  | 'about';

const NAV_ITEMS: { id: SettingsNavId; label: string; icon: typeof Monitor }[] = [
  { id: 'render', label: '渲染', icon: Monitor },
  { id: 'postprocess', label: '后处理', icon: Sparkles },
  { id: 'globe', label: '3D/地球', icon: Globe },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'about', label: '关于', icon: Info },
];

/**
 * Full-screen modal with left nav and settings pages (600×500 content area).
 */
export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [nav, setNav] = useState<SettingsNavId>('render');
  const [resetTick, setResetTick] = useState(0);

  const onClose = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  const onRestoreDefaults = useCallback(() => {
    setResetTick((n) => n + 1);
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
    >
      <div className="relative mt-16 flex h-[500px] w-[600px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
          <h2 id="settings-dialog-title" className="text-sm font-semibold text-[var(--text-primary)]">
            设置
          </h2>
          <button
            type="button"
            aria-label="关闭设置"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-[var(--border)] bg-[var(--bg-input)] p-2"
            aria-label="设置分类"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = nav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setNav(item.id)}
                  className={`flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                    active
                      ? 'bg-[var(--highlight)] text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={2} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {nav === 'render' && <RenderSettings resetSignal={resetTick} />}
            {nav === 'postprocess' && <PostProcessSettings resetSignal={resetTick} />}
            {nav === 'globe' && <GlobeSettings resetSignal={resetTick} />}
            {nav === 'appearance' && <AppearanceSettings resetSignal={resetTick} />}
            {nav === 'shortcuts' && <ShortcutsSettings />}
            {nav === 'about' && <AboutSettings />}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <button
            type="button"
            onClick={onRestoreDefaults}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hover)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
