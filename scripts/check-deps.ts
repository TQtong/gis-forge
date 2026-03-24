/**
 * @file GeoForge seven-layer dependency checker for `src/packages/**`.
 *
 * Scans TypeScript sources, maps each file and resolved import to architecture layers L0–L6,
 * and reports violations of GeoForge layering: no **upward** imports, and no **skip-layer**
 * downward jumps (e.g. L6→L4). Direct imports to **L0 (`core`)** are always allowed so shared
 * types/math can live in L0 without forcing every package through intermediate layers.
 *
 * Bare module specifiers (`react`, `zod`, etc.) and `node:` builtins are ignored.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ANSI reset. */
const RESET = '\x1b[0m';
/** ANSI bold. */
const BOLD = '\x1b[1m';
/** ANSI red. */
const RED = '\x1b[31m';
/** ANSI green. */
const GREEN = '\x1b[32m';
/** ANSI dim. */
const DIM = '\x1b[2m';

/** Repository root (parent of `scripts/`). */
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Root folder scanned for packages. */
const PACKAGES_ROOT = join(PROJECT_ROOT, 'src', 'packages');

/**
 * Single cross-layer violation record.
 */
interface DepViolation {
  /** Source file path (POSIX-style, relative to repo root). */
  readonly file: string;
  /** Import specifier as written in source. */
  readonly specifier: string;
  /** Resolved target file if known (POSIX-style relative path). */
  readonly resolved: string | null;
  /** Layer of the importing file (0–6). */
  readonly sourceLayer: number;
  /** Layer of the resolved target (0–6). */
  readonly targetLayer: number;
  /** Short rule name. */
  readonly reason: 'upward' | 'skip-layer';
}

/**
 * Maps a normalized `src/packages/...` path to an architecture layer, or null if unknown / outside rules.
 *
 * @param absFile - Absolute path to a `.ts` file.
 * @returns Layer index 0–6, or null when not classified.
 */
function getLayerForFile(absFile: string): number | null {
  const rel = relative(PROJECT_ROOT, absFile).replace(/\\/g, '/');
  if (!rel.startsWith('src/packages/')) {
    return null;
  }
  const rest = rel.slice('src/packages/'.length);
  const segments = rest.split('/');
  const pkg = segments[0] ?? '';
  if (pkg === 'core') {
    return 0;
  }
  if (pkg === 'gpu') {
    if (segments[1] === 'src' && segments[2] === 'l1') {
      return 1;
    }
    if (segments[1] === 'src' && segments[2] === 'l2') {
      return 2;
    }
    return null;
  }
  if (pkg === 'runtime') {
    return 3;
  }
  if (pkg === 'scene') {
    return 4;
  }
  if (pkg === 'extensions') {
    return 5;
  }
  if (/^preset-/.test(pkg)) {
    return 6;
  }
  if (
    pkg.startsWith('camera-') ||
    pkg.startsWith('layer-') ||
    pkg === 'globe' ||
    pkg === 'view-morph' ||
    pkg.startsWith('interaction-') ||
    pkg.startsWith('postprocess-') ||
    pkg.startsWith('source-') ||
    pkg.startsWith('compat-') ||
    pkg === 'analysis'
  ) {
    return 4;
  }
  return null;
}

/**
 * Returns true when the import from `sourceLayer` to `targetLayer` is allowed.
 *
 * Rules:
 * - Upward imports (`targetLayer > sourceLayer`) are forbidden.
 * - Same-layer imports are allowed.
 * - One-step downward (`targetLayer === sourceLayer - 1`) is allowed.
 * - Any import into **L0** (`targetLayer === 0`) is allowed (shared types / math).
 * - Other multi-step downward imports (skip-layer) are forbidden (e.g. L6→L4).
 *
 * @param sourceLayer - Layer of the importing module.
 * @param targetLayer - Layer of the resolved target module.
 */
function isAllowedLayerEdge(sourceLayer: number, targetLayer: number): boolean {
  if (targetLayer > sourceLayer) {
    return false;
  }
  if (targetLayer === sourceLayer) {
    return true;
  }
  if (targetLayer === 0) {
    return true;
  }
  if (targetLayer === sourceLayer - 1) {
    return true;
  }
  return false;
}

/**
 * Attempts to resolve a module path to an existing `.ts` file on disk.
 *
 * @param basePath - Candidate path without requiring existence yet.
 * @returns Absolute path if a file exists, otherwise null.
 */
function tryResolveTsFile(basePath: string): string | null {
  const exact = basePath;
  if (existsSync(exact) && statSync(exact).isFile()) {
    return exact;
  }
  const withTs = `${basePath}.ts`;
  if (existsSync(withTs) && statSync(withTs).isFile()) {
    return withTs;
  }
  const indexTs = join(basePath, 'index.ts');
  if (existsSync(indexTs) && statSync(indexTs).isFile()) {
    return indexTs;
  }
  return null;
}

/**
 * Resolves an import specifier to an absolute file path inside the repo, when possible.
 *
 * @param fromFile - Absolute path of the file containing the import.
 * @param spec - Import string literal contents.
 * @returns Absolute path to resolved `.ts` file, or null if external / unmapped.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('node:')) {
    return null;
  }
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@')) {
    return null;
  }
  if (spec.startsWith('@/')) {
    const sub = spec.slice(2);
    const mapped = join(PROJECT_ROOT, 'src', sub);
    return tryResolveTsFile(normalize(mapped));
  }
  if (spec === '@geoforge/core') {
    return tryResolveTsFile(
      join(PROJECT_ROOT, 'src', 'packages', 'core', 'src', 'index.ts'),
    );
  }
  if (spec.startsWith('@geoforge/core/')) {
    const rest = spec.slice('@geoforge/core/'.length);
    const mapped = join(PROJECT_ROOT, 'src', 'packages', 'core', 'src', rest);
    return tryResolveTsFile(normalize(mapped));
  }
  if (spec.startsWith('@')) {
    return null;
  }
  const baseDir = dirname(fromFile);
  const combined = resolve(baseDir, spec);
  return tryResolveTsFile(normalize(combined));
}

/**
 * Collects all `.ts` files under `dir` recursively.
 *
 * @param dir - Root directory.
 * @returns Absolute file paths.
 */
function listAllTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) {
      return;
    }
    for (const name of readdirSync(d)) {
      if (name === 'node_modules') {
        continue;
      }
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Extracts import module specifiers from TypeScript source text.
 *
 * @param source - Full file contents.
 * @returns Unique specifiers found.
 */
function extractImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(fromRe)) {
    found.add(m[1]);
  }
  const sideRe = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
  for (const m of source.matchAll(sideRe)) {
    found.add(m[1]);
  }
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(dynRe)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Runs the dependency scan and prints a colored report.
 *
 * @returns Exit code 0 when no violations, 1 otherwise.
 */
function main(): number {
  if (!existsSync(PACKAGES_ROOT)) {
    console.error(`${RED}Missing folder:${RESET} ${PACKAGES_ROOT}`);
    return 1;
  }

  const files = listAllTsFiles(PACKAGES_ROOT);
  const violations: DepViolation[] = [];

  for (const file of files) {
    const sourceLayer = getLayerForFile(file);
    if (sourceLayer === null) {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`${RED}Failed to read:${RESET} ${file}`, e);
      return 1;
    }
    const specs = extractImportSpecifiers(source);
    for (const spec of specs) {
      const resolved = resolveSpecifier(file, spec);
      if (!resolved) {
        continue;
      }
      const targetLayer = getLayerForFile(resolved);
      if (targetLayer === null) {
        continue;
      }
      if (isAllowedLayerEdge(sourceLayer, targetLayer)) {
        continue;
      }
      const reason: DepViolation['reason'] =
        targetLayer > sourceLayer ? 'upward' : 'skip-layer';
      violations.push({
        file: relative(PROJECT_ROOT, file).replace(/\\/g, '/'),
        specifier: spec,
        resolved: relative(PROJECT_ROOT, resolved).replace(/\\/g, '/'),
        sourceLayer,
        targetLayer,
        reason,
      });
    }
  }

  console.log(
    `${BOLD}GeoForge layer dependency check${RESET} ${DIM}(${files.length} .ts files scanned)${RESET}`,
  );

  if (violations.length === 0) {
    console.log(`${GREEN}No layer violations found.${RESET}`);
    return 0;
  }

  console.error(
    `${RED}Found ${violations.length} layer violation(s):${RESET}`,
  );
  for (const v of violations) {
    console.error(
      `- ${v.file}\n  import ${DIM}${v.specifier}${RESET} → ${v.resolved}\n  layers L${v.sourceLayer} → L${v.targetLayer} (${v.reason})`,
    );
  }
  return 1;
}

process.exitCode = main();
