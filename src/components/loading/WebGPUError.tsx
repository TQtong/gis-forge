import type { ReactElement } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';

type BrowserHint = {
  /** Product label shown in the recommended list. */
  name: string;
  /** When true, the current UA is treated as this browser meeting the minimum expectation. */
  supported: boolean;
};

/**
 * Parses `navigator.userAgent` with simple regex heuristics (best-effort; not a security boundary).
 *
 * @param userAgent - Raw user agent string.
 * @returns Version numbers and flags used to decide checkmarks in the UI.
 */
function analyzeUserAgent(userAgent: string): {
  /** Major version for Chromium-based Chrome when not Edge; null if unknown. */
  chromeVersion: number | null;
  /** Major version for Chromium-based Edge; null if unknown. */
  edgeVersion: number | null;
  /** True when the UA looks like Firefox (including Nightly). */
  isFirefox: boolean;
  /** True when the UA suggests Firefox Nightly. */
  isFirefoxNightly: boolean;
} {
  const edgeMatch = /Edg(?:e)?\/(\d+)/i.exec(userAgent);
  const chromeMatch = /Chrome\/(\d+)/i.exec(userAgent);
  const isEdge = edgeMatch !== null;
  const chromeVersion =
    !isEdge && chromeMatch !== null && chromeMatch[1] !== undefined ? Number(chromeMatch[1]) : null;
  const edgeVersion = edgeMatch !== null && edgeMatch[1] !== undefined ? Number(edgeMatch[1]) : null;
  const isFirefox = /Firefox\//i.test(userAgent);
  const isFirefoxNightly = isFirefox && /Nightly/i.test(userAgent);

  return { chromeVersion, edgeVersion, isFirefox, isFirefoxNightly };
}

/**
 * Full-screen error screen shown when WebGPU is unavailable or blocked.
 * Explains the requirement, lists supported browser families, and highlights simple UA detection results.
 *
 * @returns React element covering the viewport; has no external props by design.
 *
 * @example
 * ```tsx
 * {status === 'unsupported' && <WebGPUError />}
 * ```
 */
export function WebGPUError(): ReactElement {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const { chromeVersion, edgeVersion, isFirefox, isFirefoxNightly } = analyzeUserAgent(ua);

  const chromeOk = chromeVersion !== null && chromeVersion >= 113;
  const edgeOk = edgeVersion !== null && edgeVersion >= 113;
  const firefoxNightlyOk = isFirefoxNightly;

  const hints: BrowserHint[] = [
    { name: 'Chrome 113+', supported: chromeOk },
    { name: 'Edge 113+', supported: edgeOk },
    { name: 'Firefox Nightly', supported: firefoxNightlyOk },
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--bg-primary)] px-6 text-center"
      role="alert"
    >
      <AlertTriangle className="mb-4 h-12 w-12 text-[var(--warning)]" aria-hidden size={48} strokeWidth={1.75} />
      <h1 className="mb-2 text-xl font-semibold text-[var(--text-primary)]">不支持 WebGPU</h1>
      <p className="mb-6 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
        GeoForge 需要 WebGPU 才能在浏览器中进行 GPU 加速渲染。请使用支持 WebGPU 的浏览器版本，或在设置中启用实验性
        WebGPU 功能后重试。
      </p>

      <div className="mb-6 w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3 text-left">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">推荐环境</p>
        <ul className="space-y-2">
          {hints.map((h) => (
            <li key={h.name} className="flex items-center justify-between gap-3 text-sm text-[var(--text-primary)]">
              <span>{h.name}</span>
              <span className="inline-flex items-center gap-1" aria-label={h.supported ? '满足' : '不满足'}>
                {h.supported ? (
                  <Check className="h-4 w-4 text-[var(--success)]" aria-hidden />
                ) : (
                  <X className="h-4 w-4 text-[var(--error)]" aria-hidden />
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="max-w-xl break-all font-mono text-xs text-[var(--text-muted)]">
        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">当前 UA（检测用）</span>
        {ua.length > 0 ? ua : '（不可用）'}
      </p>

      {!isFirefox && (
        <p className="mt-4 max-w-md text-xs text-[var(--text-muted)]">
          提示：稳定版 Firefox 可能尚未默认启用 WebGPU；开发通道 / Nightly 通常更早提供支持。
        </p>
      )}
    </div>
  );
}
