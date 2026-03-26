// ============================================================
// analysis/index.ts — 可选分析包桶文件（Barrel Export）
// 重新导出全部 9 个分析子模块，上层通过以下方式导入：
//   import { BooleanOps, BufferOps, ... } from '@gis-forge/analysis';
// ============================================================

// --- 布尔空间运算（交集/并集/差集/异或/自相交检测/修复） ---
export { BooleanOps } from './boolean/index.ts';

// --- 缓冲区分析（点/线/面缓冲/偏移曲线） ---
export { BufferOps } from './buffer/index.ts';

// --- 空间插值（TIN/IDW/等值线/双线性/双三次） ---
export { InterpolationOps } from './interpolation/index.ts';
export type { WeightedPoint, GridData } from './interpolation/index.ts';

// --- 数据分类（Jenks/等距/分位数/标准差） ---
export { ClassificationOps } from './classification/index.ts';

// --- 规则网格生成（正方形/六角/三角/Voronoi） ---
export { GridOps } from './grid/index.ts';

// --- 栅格分析（坡度/坡向/山影/视域/等高线/重分类） ---
export { RasterOps } from './raster/index.ts';
export type { DEMData, HillshadeOptions, ViewshedOptions } from './raster/index.ts';

// --- 几何变换（旋转/缩放/平移/翻转/绕行方向修正/坐标清理） ---
export { TransformOps } from './transform/index.ts';

// --- 空间聚合（收集/计数/求和/均值/中位数/标准差） ---
export { AggregationOps } from './aggregation/index.ts';

// --- 拓扑关系判断（包含/在内/重叠/交叉/分离/相交/接触） ---
export { TopologyOps } from './topology/index.ts';
