import { useEffect, useState } from 'react';

/** Shown application version (matches `package.json` at release time). */
const APP_VERSION = '0.0.0';

/**
 * GPU / adapter summary for the About panel.
 */
interface GpuSummary {
  /** Vendor string or `"unknown"`. */
  vendor: string;
  /** Adapter device label or fallback message. */
  device: string;
  /** Whether WebGPU is available in this browser. */
  webgpuSupported: boolean;
}

/**
 * About page: version, build date, GPU info, license, external links.
 */
export function AboutSettings() {
  const [gpu, setGpu] = useState<GpuSummary>({
    vendor: '—',
    device: '检测中…',
    webgpuSupported: typeof navigator !== 'undefined' && !!navigator.gpu,
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!navigator.gpu) {
        if (!cancelled) {
          setGpu({
            vendor: '—',
            device: 'WebGPU 不可用',
            webgpuSupported: false,
          });
        }
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          if (!cancelled) {
            setGpu({ vendor: '—', device: '未获得适配器', webgpuSupported: true });
          }
          return;
        }
        let vendor = 'unknown';
        let device = 'GPU';
        try {
          const info =
            'requestAdapterInfo' in adapter && typeof adapter.requestAdapterInfo === 'function'
              ? await adapter.requestAdapterInfo()
              : null;
          if (info) {
            vendor = info.vendor || vendor;
            device = info.device || device;
          }
        } catch {
          /* Some browsers omit adapter info; keep label fallback. */
        }
        if (!cancelled) {
          setGpu({ vendor, device, webgpuSupported: true });
        }
      } catch {
        if (!cancelled) {
          setGpu({
            vendor: '—',
            device: '无法读取 GPU 信息',
            webgpuSupported: !!navigator.gpu,
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const buildDate = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--text-primary)]">
      <div>
        <p className="font-semibold text-[var(--text-primary)]">GeoForge</p>
        <p className="mt-1 text-[var(--text-secondary)]">
          版本 <span className="font-mono text-[var(--text-primary)]">{APP_VERSION}</span>
        </p>
        <p className="text-[var(--text-secondary)]">
          构建日期 <span className="font-mono text-[var(--text-primary)]">{buildDate}</span>
        </p>
      </div>

      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-3">
        <p className="text-xs font-semibold uppercase text-[var(--text-muted)]">GPU</p>
        <p className="mt-1 text-[var(--text-secondary)]">
          WebGPU: {gpu.webgpuSupported ? '是' : '否'}
        </p>
        <p className="text-[var(--text-secondary)]">
          Vendor: <span className="font-mono text-[var(--text-primary)]">{gpu.vendor}</span>
        </p>
        <p className="text-[var(--text-secondary)]">
          Device: <span className="font-mono text-xs text-[var(--text-primary)]">{gpu.device}</span>
        </p>
      </div>

      <div>
        <p className="text-[var(--text-secondary)]">
          许可证:{' '}
          <a
            href="https://opensource.org/licenses/MIT"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            MIT License
          </a>
        </p>
        <ul className="mt-2 list-disc pl-5 text-[var(--text-secondary)]">
          <li>
            <a
              href="https://github.com/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              项目主页
            </a>
          </li>
          <li>
            <a
              href="https://developer.mozilla.org/docs/Web/API/GPU"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              WebGPU 文档
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
