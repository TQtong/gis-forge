// ============================================================
// precision/index.ts — 精度模块统一导出
// 聚合 Split-Double 和 RTC 子模块。
// ============================================================

export { splitDouble, splitDoubleArray, recombine } from './split-double.ts';
export { computeRTCCenter, offsetPositions, fromECEF } from './rtc.ts';
