import { useEffect, useState } from 'react';

/** Props for {@link RenderSettings}. */
export interface RenderSettingsProps {
  /** Changing this remounts the form and restores built-in defaults. */
  resetSignal?: number;
}

type MsaaOption = 'off' | '2' | '4';
type TextureSize = 1024 | 2048 | 4096;
type FpsCap = 30 | 60 | 'unlimited';

/**
 * Rendering preferences: MSAA, texture cap, pixel ratio, and FPS limit (local UI state).
 */
export function RenderSettings({ resetSignal = 0 }: RenderSettingsProps) {
  const [msaa, setMsaa] = useState<MsaaOption>('4');
  const [maxTexture, setMaxTexture] = useState<TextureSize>(2048);
  const [pixelRatio, setPixelRatio] = useState(() =>
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(2, Math.max(0.5, window.devicePixelRatio))
      : 1,
  );
  const [fpsCap, setFpsCap] = useState<FpsCap>(60);

  useEffect(() => {
    setMsaa('4');
    setMaxTexture(2048);
    setPixelRatio(
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? Math.min(2, Math.max(0.5, window.devicePixelRatio))
        : 1,
    );
    setFpsCap(60);
  }, [resetSignal]);

  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text-primary)]">
      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="msaa-select">
          MSAA
        </label>
        <select
          id="msaa-select"
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-[var(--text-primary)]"
          value={msaa}
          onChange={(e) => setMsaa(e.target.value as MsaaOption)}
        >
          <option value="off">Off</option>
          <option value="2">2x</option>
          <option value="4">4x</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="tex-select">
          最大纹理尺寸
        </label>
        <select
          id="tex-select"
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5"
          value={maxTexture}
          onChange={(e) => setMaxTexture(Number(e.target.value) as TextureSize)}
        >
          <option value={1024}>1024</option>
          <option value={2048}>2048</option>
          <option value={4096}>4096</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[var(--text-secondary)]">
          <span>像素比</span>
          <span className="font-mono text-[var(--text-primary)]">{pixelRatio.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={pixelRatio}
          onChange={(e) => setPixelRatio(Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
          aria-valuemin={0.5}
          aria-valuemax={2}
          aria-valuenow={pixelRatio}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[var(--text-secondary)]" htmlFor="fps-select">
          帧率限制
        </label>
        <select
          id="fps-select"
          className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5"
          value={fpsCap === 'unlimited' ? 'unlimited' : String(fpsCap)}
          onChange={(e) => {
            const v = e.target.value;
            setFpsCap(v === 'unlimited' ? 'unlimited' : (Number(v) as 30 | 60));
          }}
        >
          <option value={30}>30</option>
          <option value={60}>60</option>
          <option value="unlimited">无限制</option>
        </select>
      </div>
    </div>
  );
}
