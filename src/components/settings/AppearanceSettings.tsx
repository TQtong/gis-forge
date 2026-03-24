import { useEffect } from 'react';
import type { CoordinateFormat, DistanceUnit } from '@/types';
import { useUIStore } from '@/stores/uiStore';
import type { UILanguage } from '@/stores/uiStore';

/** Props for {@link AppearanceSettings}. */
export interface AppearanceSettingsProps {
  /** Remount / reset trigger from parent dialog. */
  resetSignal?: number;
}

/**
 * Theme, language, coordinate format, units, and base font size (mostly from `useUIStore`).
 */
export function AppearanceSettings({ resetSignal = 0 }: AppearanceSettingsProps) {
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);
  const coordinateFormat = useUIStore((s) => s.coordinateFormat);
  const setCoordinateFormat = useUIStore((s) => s.setCoordinateFormat);
  const distanceUnit = useUIStore((s) => s.distanceUnit);
  const setDistanceUnit = useUIStore((s) => s.setDistanceUnit);
  const fontSizePx = useUIStore((s) => s.fontSizePx);
  const setFontSizePx = useUIStore((s) => s.setFontSizePx);
  const showMiniMap = useUIStore((s) => s.showMiniMap);
  const setShowMiniMap = useUIStore((s) => s.setShowMiniMap);

  useEffect(() => {
    if (resetSignal <= 0) return;
    setTheme('dark');
    setLanguage('zh');
    setCoordinateFormat('dd');
    setDistanceUnit('metric');
    setFontSizePx(14);
    setShowMiniMap(true);
  }, [resetSignal, setTheme, setLanguage, setCoordinateFormat, setDistanceUnit, setFontSizePx, setShowMiniMap]);

  const onFontReset = () => setFontSizePx(14);

  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text-primary)]">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[var(--text-secondary)]" htmlFor="minimap-toggle">
          鹰眼图
        </label>
        <input
          id="minimap-toggle"
          type="checkbox"
          checked={showMiniMap}
          onChange={(e) => setShowMiniMap(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]">主题</span>
        <button
          type="button"
          onClick={() => toggleTheme()}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-1.5 text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
        >
          {theme === 'dark' ? '切换到浅色' : '切换到深色'}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="lang-select">
          语言
        </label>
        <select
          id="lang-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value as UILanguage)}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5"
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="coord-select">
          坐标格式
        </label>
        <select
          id="coord-select"
          value={coordinateFormat}
          onChange={(e) => setCoordinateFormat(e.target.value as CoordinateFormat)}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5"
        >
          <option value="dd">DD</option>
          <option value="dms">DMS</option>
          <option value="utm">UTM</option>
          <option value="mgrs">MGRS</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="unit-select">
          距离单位
        </label>
        <select
          id="unit-select"
          value={distanceUnit}
          onChange={(e) => setDistanceUnit(e.target.value as DistanceUnit)}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5"
        >
          <option value="metric">公制</option>
          <option value="imperial">英制</option>
          <option value="nautical">海里</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[var(--text-secondary)]">
          <span>字体大小</span>
          <span className="font-mono text-[var(--text-primary)]">{fontSizePx}px</span>
        </div>
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={fontSizePx}
          onChange={(e) => setFontSizePx(Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
        <button
          type="button"
          onClick={onFontReset}
          className="self-start text-xs text-[var(--accent)] hover:underline"
        >
          重置为 14px
        </button>
      </div>
    </div>
  );
}
