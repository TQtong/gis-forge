import { useEffect, useState } from 'react';

/** Props for {@link GlobeSettings}. */
export interface GlobeSettingsProps {
  /** Remount / reset trigger from parent dialog. */
  resetSignal?: number;
}

/**
 * Globe / 3D atmosphere, sky, sun, and fog controls (local UI state).
 */
export function GlobeSettings({ resetSignal = 0 }: GlobeSettingsProps) {
  const [atmosphere, setAtmosphere] = useState(true);
  const [stars, setStars] = useState(true);
  const [sunAuto, setSunAuto] = useState(true);
  const [azimuth, setAzimuth] = useState(45);
  const [altitude, setAltitude] = useState(30);
  const [fogOn, setFogOn] = useState(false);
  const [fogDensity, setFogDensity] = useState(0.2);

  useEffect(() => {
    setAtmosphere(true);
    setStars(true);
    setSunAuto(true);
    setAzimuth(45);
    setAltitude(30);
    setFogOn(false);
    setFogDensity(0.2);
  }, [resetSignal]);

  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text-primary)]">
      <div className="flex items-center justify-between">
        <span>大气效果</span>
        <input
          type="checkbox"
          checked={atmosphere}
          onChange={(e) => setAtmosphere(e.target.checked)}
          className="rounded border-[var(--border)]"
        />
      </div>
      <div className="flex items-center justify-between">
        <span>星空背景</span>
        <input
          type="checkbox"
          checked={stars}
          onChange={(e) => setStars(e.target.checked)}
          className="rounded border-[var(--border)]"
        />
      </div>

      <section className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">太阳位置</span>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sunAuto}
              onChange={(e) => setSunAuto(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            <span className="text-[var(--text-secondary)]">自动</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>方位角</span>
            <span className="font-mono">{azimuth}°</span>
          </div>
          <input
            type="range"
            min={0}
            max={360}
            value={azimuth}
            onChange={(e) => setAzimuth(Number(e.target.value))}
            disabled={sunAuto}
            className="w-full accent-[var(--accent)] disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>高度角</span>
            <span className="font-mono">{altitude}°</span>
          </div>
          <input
            type="range"
            min={0}
            max={90}
            value={altitude}
            onChange={(e) => setAltitude(Number(e.target.value))}
            disabled={sunAuto}
            className="w-full accent-[var(--accent)] disabled:opacity-50"
          />
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">雾效果</span>
          <input
            type="checkbox"
            checked={fogOn}
            onChange={(e) => setFogOn(e.target.checked)}
            className="rounded border-[var(--border)]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>密度</span>
            <span className="font-mono">{fogDensity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={fogDensity}
            onChange={(e) => setFogDensity(Number(e.target.value))}
            disabled={!fogOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      </section>
    </div>
  );
}
