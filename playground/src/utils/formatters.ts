/* ═══════════════════════════════════════════════════════════════════════════
   formatters — 数值格式化工具函数
   InspectorPanel / PerformanceTab / TilesTab 等面板中统一使用的
   坐标、角度、字节、数字、毫秒格式化。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 1 KB = 1024 字节 */
const BYTES_PER_KB = 1024;

/** 1 MB = 1024 × 1024 字节 */
const BYTES_PER_MB = 1024 * 1024;

/** 1 GB = 1024 × 1024 × 1024 字节 */
const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * 格式化地理坐标值为 6 位小数字符串。
 * 6 位小数约对应 ~0.11m 的精度，满足 GIS 坐标显示需求。
 *
 * @param value - 坐标值（经度或纬度），单位：度
 * @returns 6 位小数的字符串（如 "116.397428"）
 *
 * @example
 * formatCoord(116.39742799999999); // → "116.397428"
 * formatCoord(0);                   // → "0.000000"
 * formatCoord(NaN);                 // → "NaN"
 * formatCoord(Infinity);            // → "Infinity"
 */
export function formatCoord(value: number): string {
  // 处理非有限值
  if (!Number.isFinite(value)) {
    return String(value);
  }

  return value.toFixed(6);
}

/**
 * 格式化弧度角度为字符串。
 * 显示 4 位小数 + " rad" 后缀，与 InspectorPanel 的 bearing/pitch 字段对齐。
 *
 * @param radians - 角度值，单位：弧度
 * @returns 格式化字符串（如 "0.1234 rad"、"-1.5708 rad"）
 *
 * @example
 * formatAngle(Math.PI / 4); // → "0.7854 rad"
 * formatAngle(0);            // → "0.0000 rad"
 * formatAngle(NaN);          // → "NaN rad"
 */
export function formatAngle(radians: number): string {
  // 处理非有限值
  if (!Number.isFinite(radians)) {
    return `${String(radians)} rad`;
  }

  return `${radians.toFixed(4)} rad`;
}

/**
 * 格式化字节数为人类可读的字符串，自动选择合适的单位（B / KB / MB / GB）。
 * 用于 GPU 内存显示、瓦片大小显示等场景。
 *
 * @param bytes - 字节数，必须 ≥ 0
 * @returns 格式化字符串（如 "1.23 MB"、"456 B"、"2.10 GB"）
 *
 * @example
 * formatBytes(0);            // → "0 B"
 * formatBytes(512);          // → "512 B"
 * formatBytes(1536);         // → "1.50 KB"
 * formatBytes(2621440);      // → "2.50 MB"
 * formatBytes(1073741824);   // → "1.00 GB"
 * formatBytes(-1);           // → "0 B"  (负数钳位到 0)
 * formatBytes(NaN);          // → "0 B"
 */
export function formatBytes(bytes: number): string {
  // 非有限值或负数一律显示 0 B
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  // 不足 1 KB 时显示整数字节
  if (bytes < BYTES_PER_KB) {
    return `${Math.round(bytes)} B`;
  }

  // 不足 1 MB 时以 KB 为单位
  if (bytes < BYTES_PER_MB) {
    return `${(bytes / BYTES_PER_KB).toFixed(2)} KB`;
  }

  // 不足 1 GB 时以 MB 为单位
  if (bytes < BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;
  }

  // ≥ 1 GB 以 GB 为单位
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

/**
 * 格式化数字为千分位逗号分隔的字符串。
 * 用于 Draw Calls、三角形数量、Feature 数量等整数显示。
 *
 * @param n - 待格式化的数字（整数或浮点数）
 * @returns 千分位逗号分隔的字符串（如 "1,234,567"、"0"）
 *
 * @example
 * formatNumber(1234567);     // → "1,234,567"
 * formatNumber(42);          // → "42"
 * formatNumber(0);           // → "0"
 * formatNumber(-9876);       // → "-9,876"
 * formatNumber(1234.56);     // → "1,234.56"
 * formatNumber(NaN);         // → "NaN"
 * formatNumber(Infinity);    // → "Infinity"
 */
export function formatNumber(n: number): string {
  // 处理非有限值
  if (!Number.isFinite(n)) {
    return String(n);
  }

  // 使用 toLocaleString 以确保千分位逗号分隔
  return n.toLocaleString('en-US');
}

/**
 * 格式化毫秒时间为字符串，保留 1 位小数。
 * 用于帧时间、加载时间、解码时间等毫秒级性能数据显示。
 *
 * @param ms - 毫秒数，取值范围 0~9999
 * @returns 格式化字符串（如 "12.3 ms"、"0.0 ms"）
 *
 * @example
 * formatMs(12.345);  // → "12.3 ms"
 * formatMs(0);       // → "0.0 ms"
 * formatMs(9.99);    // → "10.0 ms"
 * formatMs(NaN);     // → "NaN ms"
 */
export function formatMs(ms: number): string {
  // 处理非有限值
  if (!Number.isFinite(ms)) {
    return `${String(ms)} ms`;
  }

  return `${ms.toFixed(1)} ms`;
}

/** 别名（组件使用 formatCoordinate 名称） */
export { formatCoord as formatCoordinate };
