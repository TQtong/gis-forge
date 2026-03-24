/**
 * @file GeoForge bundle size monitor (CI / local quality gate).
 *
 * Runs `vite build`, parses Rollup/Vite size lines from stdout, aggregates JS and CSS
 * gzip totals, compares against GeoForge gzipped budgets, writes `dist/bundle-report.json`,
 * and exits with code 1 when any aggregate exceeds its budget by more than 5%.
 *
 * @remarks
 * The 2D preset budget (120KB gz) is recorded for future per-chunk checks; the current
 * app build emits a single JS bundle, so enforcement uses the full-bundle budget only.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ANSI reset sequence. */
const RESET = '\x1b[0m';
/** ANSI bold. */
const BOLD = '\x1b[1m';
/** ANSI green (PASS). */
const GREEN = '\x1b[32m';
/** ANSI yellow (WARN). */
const YELLOW = '\x1b[33m';
/** ANSI red (FAIL). */
const RED = '\x1b[31m';
/** ANSI dim (hints). */
const DIM = '\x1b[2m';

/** Project root (parent of `scripts/`). */
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Vite output directory. */
const DIST_DIR = join(PROJECT_ROOT, 'dist');
/** JSON report path (written after checks). */
const REPORT_PATH = join(DIST_DIR, 'bundle-report.json');

/**
 * Maximum gzipped size for the full JS output (bytes). GeoForge tree-shake target ~350KB gz.
 */
const BUDGET_JS_GZIP_BYTES = 350 * 1024;

/**
 * Maximum gzipped size for bundled CSS (bytes).
 */
const BUDGET_CSS_GZIP_BYTES = 15 * 1024;

/**
 * Documented 2D preset budget (bytes, gzipped). Not enforced until separate 2D chunk exists.
 */
const BUDGET_PRESET_2D_GZIP_BYTES = 120 * 1024;

/**
 * Allowed over-budget ratio before treating the check as a hard failure (5%).
 */
const FAIL_RATIO = 0.05;

/**
 * Parsed asset line from Vite/Rollup "computing gzip size" output.
 */
interface ViteAssetLine {
  /** Relative path as printed by Vite (e.g. `dist/assets/index-xx.js`). */
  readonly relativePath: string;
  /** Raw size in bytes (from kB line). */
  readonly rawBytes: number;
  /** Gzip size in bytes (from kB line). */
  readonly gzipBytes: number;
}

/**
 * Row in the summary table and JSON report.
 */
interface ReportRow {
  /** Display name or label. */
  readonly label: string;
  /** Raw size in bytes (aggregate or file). */
  readonly rawBytes: number;
  /** Gzip size in bytes. */
  readonly gzipBytes: number;
  /** Budget in bytes, or null when not applicable (informational rows). */
  readonly budgetBytes: number | null;
  /** PASS / WARN / FAIL / NOTE. */
  readonly status: 'PASS' | 'WARN' | 'FAIL' | 'NOTE';
  /** Human-readable note (optional). */
  readonly note?: string;
}

/**
 * Persisted report structure.
 */
interface BundleReportJson {
  /** ISO timestamp when the report was generated. */
  readonly generatedAt: string;
  /** Vite command used. */
  readonly command: string;
  /** Non-zero if the script exited with failure thresholds. */
  readonly exitCode: 0 | 1;
  /** Budget constants (bytes). */
  readonly budgets: {
    readonly jsTotalGzipMax: number;
    readonly cssTotalGzipMax: number;
    readonly preset2dGzipMax: number;
    readonly failThresholdRatio: number;
  };
  /** Per-asset lines from the build log. */
  readonly assets: readonly ViteAssetLine[];
  /** Summary rows (including totals and notes). */
  readonly summary: readonly ReportRow[];
}

/**
 * Converts Vite's printed kilobyte value to bytes using 1 kB = 1024 B (binary convention).
 *
 * @param kb - Parsed floating-point kilobytes from the build log.
 * @returns Size in bytes (non-negative integer).
 */
function kbToBytes(kb: number): number {
  if (!Number.isFinite(kb) || kb < 0) {
    return 0;
  }
  return Math.round(kb * 1024);
}

/**
 * Formats byte counts for the console table (KiB, one decimal).
 *
 * @param n - Size in bytes.
 * @returns Human-readable string.
 */
function formatKiB(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '0.0 KiB';
  }
  return `${(n / 1024).toFixed(1)} KiB`;
}

/**
 * Parses Vite/Rollup stdout for lines like:
 * `dist/assets/index-xx.js   581.01 kB │ gzip: 159.66 kB`
 *
 * @param log - Combined stdout/stderr from `vite build`.
 * @returns Parsed asset lines (may be empty if parsing failed).
 */
function parseViteSizeLines(log: string): ViteAssetLine[] {
  const lines: ViteAssetLine[] = [];
  const re =
    /^\s*(dist\/\S+)\s+([\d.]+)\s+kB\s+[^\n]*?gzip:\s+([\d.]+)\s+kB\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(log)) !== null) {
    const relativePath = match[1];
    const rawKb = Number.parseFloat(match[2]);
    const gzipKb = Number.parseFloat(match[3]);
    if (!Number.isFinite(rawKb) || !Number.isFinite(gzipKb)) {
      continue;
    }
    lines.push({
      relativePath,
      rawBytes: kbToBytes(rawKb),
      gzipBytes: kbToBytes(gzipKb),
    });
  }
  return lines;
}

/**
 * Fallback: scans `dist` for `.js` / `.css` assets and computes gzip sizes from disk.
 * Used when log parsing yields no rows (different Vite locale/format).
 *
 * @param distDir - Absolute path to `dist`.
 * @returns Asset lines derived from files.
 */
function scanDistAssetsSync(distDir: string): ViteAssetLine[] {
  if (!existsSync(distDir)) {
    return [];
  }
  const out: ViteAssetLine[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (
        st.isFile() &&
        (name.endsWith('.js') || name.endsWith('.css'))
      ) {
        const buf = readFileSync(full);
        const rel = relative(PROJECT_ROOT, full).replace(/\\/g, '/');
        out.push({
          relativePath: rel,
          rawBytes: buf.length,
          gzipBytes: gzipSync(buf).length,
        });
      }
    }
  };
  walk(distDir);
  return out;
}

/**
 * Computes PASS / WARN / FAIL for a measured gzip size against a finite budget.
 * WARN: over budget but not beyond the 5% tolerance. FAIL: beyond tolerance.
 *
 * @param gzipBytes - Measured gzip size in bytes.
 * @param budgetBytes - Maximum allowed gzip size in bytes.
 * @returns Status label.
 */
function statusForBudget(
  gzipBytes: number,
  budgetBytes: number,
): 'PASS' | 'WARN' | 'FAIL' {
  if (gzipBytes <= budgetBytes) {
    return 'PASS';
  }
  const limit = budgetBytes * (1 + FAIL_RATIO);
  if (gzipBytes <= limit) {
    return 'WARN';
  }
  return 'FAIL';
}

/**
 * Prints a fixed-width summary table to stdout with ANSI colors.
 *
 * @param rows - Rows to render.
 */
function printSummaryTable(rows: readonly ReportRow[]): void {
  const labels = rows.map((r) => r.label);
  const maxLabel = Math.max(24, ...labels.map((l) => l.length));
  const header = `${'Label'.padEnd(maxLabel)} | ${'Raw'.padStart(12)} | ${'Gzip'.padStart(
    12,
  )} | ${'Budget'.padStart(12)} | Status`;
  console.log(`${BOLD}${header}${RESET}`);
  console.log('-'.repeat(header.length + 4));
  for (const r of rows) {
    const budgetStr =
      r.budgetBytes === null ? '—' : formatKiB(r.budgetBytes);
    let color = RESET;
    if (r.status === 'PASS') {
      color = GREEN;
    } else if (r.status === 'WARN') {
      color = YELLOW;
    } else if (r.status === 'FAIL') {
      color = RED;
    } else {
      color = DIM;
    }
    const line = `${r.label.padEnd(maxLabel)} | ${formatKiB(r.rawBytes).padStart(
      12,
    )} | ${formatKiB(r.gzipBytes).padStart(12)} | ${budgetStr.padStart(12)} | ${color}${r.status}${RESET}`;
    console.log(line);
    if (r.note) {
      console.log(`${DIM}  ${r.note}${RESET}`);
    }
  }
}

/**
 * Runs `vite build`, aggregates sizes, evaluates budgets, writes JSON, sets exit code.
 *
 * @returns Process exit code (0 or 1).
 */
function main(): number {
  const viteCli = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteCli)) {
    console.error(
      `${RED}Vite CLI not found at ${viteCli}. Run npm install in the project root.${RESET}`,
    );
    return 1;
  }
  /** Human-readable command string for reports only. */
  const viteCmd = `node "${viteCli}" build`;
  const spawned = spawnSync(process.execPath, [viteCli, 'build'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const log = `${spawned.stdout ?? ''}\n${spawned.stderr ?? ''}`;
  if (spawned.error) {
    console.error(`${RED}Failed to spawn vite build:${RESET}`, spawned.error);
    return 1;
  }
  if (spawned.status !== 0 && spawned.status !== null) {
    console.error(`${RED}vite build exited with code ${spawned.status}.${RESET}`);
    console.error(`${DIM}${log}${RESET}`);
    try {
      mkdirSync(DIST_DIR, { recursive: true });
      const failReport: BundleReportJson = {
        generatedAt: new Date().toISOString(),
        command: viteCmd,
        exitCode: 1,
        budgets: {
          jsTotalGzipMax: BUDGET_JS_GZIP_BYTES,
          cssTotalGzipMax: BUDGET_CSS_GZIP_BYTES,
          preset2dGzipMax: BUDGET_PRESET_2D_GZIP_BYTES,
          failThresholdRatio: FAIL_RATIO,
        },
        assets: [],
        summary: [
          {
            label: 'build',
            rawBytes: 0,
            gzipBytes: 0,
            budgetBytes: null,
            status: 'FAIL',
            note: 'vite build failed; see CI log',
          },
        ],
      };
      writeFileSync(REPORT_PATH, JSON.stringify(failReport, null, 2), 'utf8');
    } catch {
      /* ignore secondary IO errors */
    }
    return 1;
  }

  let assets = parseViteSizeLines(log);
  if (assets.length === 0) {
    console.warn(
      `${YELLOW}No size lines parsed from vite output; falling back to dist scan.${RESET}`,
    );
    assets = scanDistAssetsSync(DIST_DIR);
  }

  let jsGzipTotal = 0;
  let jsRawTotal = 0;
  let cssGzipTotal = 0;
  let cssRawTotal = 0;
  for (const a of assets) {
    const p = a.relativePath.toLowerCase();
    if (p.endsWith('.js')) {
      jsGzipTotal += a.gzipBytes;
      jsRawTotal += a.rawBytes;
    } else if (p.endsWith('.css')) {
      cssGzipTotal += a.gzipBytes;
      cssRawTotal += a.rawBytes;
    }
  }

  const summary: ReportRow[] = [];

  for (const a of assets) {
    summary.push({
      label: a.relativePath,
      rawBytes: a.rawBytes,
      gzipBytes: a.gzipBytes,
      budgetBytes: null,
      status: 'NOTE',
    });
  }

  const jsStatus = statusForBudget(jsGzipTotal, BUDGET_JS_GZIP_BYTES);
  const cssStatus = statusForBudget(cssGzipTotal, BUDGET_CSS_GZIP_BYTES);

  summary.push({
    label: 'TOTAL JS (gzip, all .js chunks)',
    rawBytes: jsRawTotal,
    gzipBytes: jsGzipTotal,
    budgetBytes: BUDGET_JS_GZIP_BYTES,
    status: jsStatus,
  });
  summary.push({
    label: 'TOTAL CSS (gzip, all .css chunks)',
    rawBytes: cssRawTotal,
    gzipBytes: cssGzipTotal,
    budgetBytes: BUDGET_CSS_GZIP_BYTES,
    status: cssStatus,
  });
  summary.push({
    label: 'Preset 2D (planned)',
    rawBytes: 0,
    gzipBytes: 0,
    budgetBytes: BUDGET_PRESET_2D_GZIP_BYTES,
    status: 'NOTE',
    note:
      'Not built as a separate chunk yet; budget reserved. Full JS total is checked against 350 KiB gz.',
  });

  const anyFail = summary.some((r) => r.status === 'FAIL');
  const exitCode: 0 | 1 = anyFail ? 1 : 0;

  const report: BundleReportJson = {
    generatedAt: new Date().toISOString(),
    command: viteCmd,
    exitCode,
    budgets: {
      jsTotalGzipMax: BUDGET_JS_GZIP_BYTES,
      cssTotalGzipMax: BUDGET_CSS_GZIP_BYTES,
      preset2dGzipMax: BUDGET_PRESET_2D_GZIP_BYTES,
      failThresholdRatio: FAIL_RATIO,
    },
    assets,
    summary,
  };

  try {
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      `${DIM}Wrote ${relative(PROJECT_ROOT, REPORT_PATH).replace(/\\/g, '/')}${RESET}`,
    );
  } catch (e) {
    console.error(`${RED}Failed to write bundle report:${RESET}`, e);
    return 1;
  }

  printSummaryTable(summary);

  if (anyFail) {
    console.error(
      `${RED}Bundle size check FAILED: at least one budget exceeded by more than ${(
        FAIL_RATIO * 100
      ).toFixed(0)}%.${RESET}`,
    );
  } else {
    console.log(`${GREEN}Bundle size check completed (no hard failures).${RESET}`);
  }

  return exitCode;
}

process.exitCode = main();
