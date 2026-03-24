import { useEffect, useState } from 'react';

/** Props for {@link PostProcessSettings}. */
export interface PostProcessSettingsProps {
  /** Remount / reset trigger from parent dialog. */
  resetSignal?: number;
}

type ShadowQuality = 'low' | 'medium' | 'high';

/**
 * Post-processing toggles: bloom, SSAO, and shadow quality (local UI state).
 */
export function PostProcessSettings({ resetSignal = 0 }: PostProcessSettingsProps) {
  const [bloomOn, setBloomOn] = useState(true);
  const [bloomIntensity, setBloomIntensity] = useState(1);
  const [bloomThreshold, setBloomThreshold] = useState(0.8);
  const [ssaoOn, setSsaoOn] = useState(false);
  const [ssaoRadius, setSsaoRadius] = useState(0.5);
  const [ssaoIntensity, setSsaoIntensity] = useState(1);
  const [ssaoBias, setSsaoBias] = useState(0.01);
  const [shadowOn, setShadowOn] = useState(true);
  const [shadowQ, setShadowQ] = useState<ShadowQuality>('medium');

  useEffect(() => {
    setBloomOn(true);
    setBloomIntensity(1);
    setBloomThreshold(0.8);
    setSsaoOn(false);
    setSsaoRadius(0.5);
    setSsaoIntensity(1);
    setSsaoBias(0.01);
    setShadowOn(true);
    setShadowQ('medium');
  }, [resetSignal]);

  return (
    <div className="flex flex-col gap-4 text-sm text-[var(--text-primary)]">
      <section className="flex flex-col gap-2 border-b border-[var(--border)] pb-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">Bloom</span>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={bloomOn}
              onChange={(e) => setBloomOn(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            <span className="text-[var(--text-secondary)]">启用</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>强度</span>
            <span className="font-mono">{bloomIntensity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={bloomIntensity}
            onChange={(e) => setBloomIntensity(Number(e.target.value))}
            disabled={!bloomOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>阈值</span>
            <span className="font-mono">{bloomThreshold.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={bloomThreshold}
            onChange={(e) => setBloomThreshold(Number(e.target.value))}
            disabled={!bloomOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      </section>

      <section className="flex flex-col gap-2 border-b border-[var(--border)] pb-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">SSAO</span>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={ssaoOn}
              onChange={(e) => setSsaoOn(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            <span className="text-[var(--text-secondary)]">启用</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>半径</span>
            <span className="font-mono">{ssaoRadius.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={4}
            step={0.05}
            value={ssaoRadius}
            onChange={(e) => setSsaoRadius(Number(e.target.value))}
            disabled={!ssaoOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>强度</span>
            <span className="font-mono">{ssaoIntensity.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={ssaoIntensity}
            onChange={(e) => setSsaoIntensity(Number(e.target.value))}
            disabled={!ssaoOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>偏差</span>
            <span className="font-mono">{ssaoBias.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.1}
            step={0.001}
            value={ssaoBias}
            onChange={(e) => setSsaoBias(Number(e.target.value))}
            disabled={!ssaoOn}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">阴影</span>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shadowOn}
              onChange={(e) => setShadowOn(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            <span className="text-[var(--text-secondary)]">启用</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[var(--text-secondary)]" htmlFor="shadow-q">
            质量
          </label>
          <select
            id="shadow-q"
            disabled={!shadowOn}
            value={shadowQ}
            onChange={(e) => setShadowQ(e.target.value as ShadowQuality)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 disabled:opacity-50"
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </div>
      </section>
    </div>
  );
}
