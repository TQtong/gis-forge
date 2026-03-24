// ============================================================
// L4 scene — StyleEngine：样式表达式 → WGSL 片段与 CPU 求值（MVP）
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import { GeoForgeError } from './source-manager.ts';

/**
 * 样式表达式占位类型（完整定义见 core/types/style-spec；此处 any 以满足 MVP 编译管线）。
 */
export type StyleExpression = any;

/**
 * 过滤器表达式占位类型（MapLibre filter 数组语法）。
 */
export type FilterExpression = any;

/**
 * 求值上下文：提供缩放级别与可选要素（数据驱动）。
 */
export interface StyleEvaluateContext {
  /**
   * 当前缩放级别（连续值，如 12.3）。
   */
  readonly zoom: number;

  /**
   * 参与属性查找的要素；无则仅支持非 feature 表达式。
   */
  readonly feature?: Feature;
}

/**
 * 编译后的样式着色器片段与元数据。
 */
export interface CompiledStyle {
  /**
   * 生成的 WGSL 源码片段（包含一个可调用入口函数）。
   */
  readonly wgslCode: string;

  /**
   * 与 WGSL 对应的 CPU 侧 uniform 常量快照（MVP 可能为空）。
   */
  readonly uniformValues: Readonly<Record<string, number | number[]>>;

  /**
   * 若表达式无 zoom/feature 依赖，则为 true，可跳过每帧求值。
   */
  readonly isConstant: boolean;

  /**
   * 表达式是否引用 zoom 或 interpolate 依赖 zoom。
   */
  readonly dependsOnZoom: boolean;

  /**
   * 表达式是否包含 get/feature 相关依赖。
   */
  readonly dependsOnFeature: boolean;

  /**
   * 顶点/实例所需属性名列表（供 ShaderAssembler 绑定）。
   */
  readonly requiredAttributes: readonly string[];
}

/**
 * 编译后的过滤器：GPU 侧占位 WGSL + CPU 侧判定（MVP）。
 */
export interface CompiledFilter {
  /**
   * WGSL 占位代码（未来扩展为 per-feature 布尔）；MVP 恒为 true 片段。
   */
  readonly wgslCode: string;

  /**
   * CPU 侧对要素是否通过过滤器的判定。
   *
   * @param feature - 要素
   * @returns 是否保留
   */
  readonly evaluateFeature: (feature: Feature) => boolean;
}

/**
 * StyleEngine 接口：编译、缓存与求值。
 */
export interface StyleEngine {
  /**
   * 将样式表达式编译为 WGSL 与元数据。
   *
   * @param expr - 样式表达式
   * @returns 编译结果
   */
  compile(expr: StyleExpression): CompiledStyle;

  /**
   * 将过滤器表达式编译为 WGSL + CPU 判定函数。
   *
   * @param filterExpr - 过滤器
   * @returns 编译结果
   */
  compileFilter(filterExpr: FilterExpression): CompiledFilter;

  /**
   * 对表达式求值（CPU 路径，用于布局与调试）。
   *
   * @param expr - 表达式
   * @param ctx - 上下文
   * @returns 求值结果
   */
  evaluate(expr: StyleExpression, ctx: StyleEvaluateContext): unknown;

  /**
   * 当前编译缓存条目数。
   */
  readonly cacheSize: number;

  /**
   * 清空编译缓存。
   */
  clearCache(): void;
}

/** WGSL 入口函数名前缀（避免与用户模块冲突）。 */
const WGSL_FN_PREFIX = 'geoforge_style_paint_';

/** 已编译样式缓存：序列化键 → 结果。 */
const styleCache = new Map<string, CompiledStyle>();

/** 过滤器缓存。 */
const filterCache = new Map<string, CompiledFilter>();

/** 单调递增函数名后缀，保证 WGSL 符号唯一。 */
let wgslFnSerial = 0;

/**
 * 将任意值稳定序列化为缓存键（MVP：JSON；循环引用会抛错由调用方捕获）。
 *
 * @param expr - 表达式
 * @returns 缓存键字符串
 */
function stableKey(expr: unknown): string {
  try {
    return JSON.stringify(expr);
  } catch (e) {
    throw new GeoForgeError(
      'STYLE_CACHE_KEY_FAILED',
      e instanceof Error ? e.message : String(e),
      {},
    );
  }
}

/**
 * 检测表达式是否包含对 zoom 的依赖（浅层递归）。
 *
 * @param expr - 表达式节点
 * @returns 是否依赖 zoom
 */
function exprDependsOnZoom(expr: unknown): boolean {
  if (!Array.isArray(expr)) {
    return false;
  }
  const head = expr[0];
  if (head === 'interpolate' || head === 'step' || head === 'curve') {
    return true;
  }
  if (head === 'zoom') {
    return true;
  }
  for (let i = 1; i < expr.length; i++) {
    if (exprDependsOnZoom(expr[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 检测表达式是否包含 get / feature-state 等要素依赖。
 *
 * @param expr - 表达式节点
 * @returns 是否依赖要素属性
 */
function exprDependsOnFeature(expr: unknown): boolean {
  if (!Array.isArray(expr)) {
    return false;
  }
  const head = expr[0];
  if (head === 'get' || head === 'feature-state' || head === 'properties') {
    return true;
  }
  for (let i = 1; i < expr.length; i++) {
    if (exprDependsOnFeature(expr[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 自表达式树收集 `['get','prop']` 中的属性名。
 *
 * @param expr - 表达式
 * @param out - 输出集合
 */
function collectGetKeys(expr: unknown, out: Set<string>): void {
  if (!Array.isArray(expr)) {
    return;
  }
  if (expr[0] === 'get' && typeof expr[1] === 'string') {
    out.add(expr[1]);
  }
  for (let i = 1; i < expr.length; i++) {
    collectGetKeys(expr[i], out);
  }
}

/**
 * 解析颜色字面量为 vec4 分量 [0,1]。
 *
 * @param value - 字符串如 #RRGGBB 或 rgba()
 * @returns RGBA 浮点元组
 */
function parseColorToVec4(value: unknown): [number, number, number, number] {
  if (typeof value === 'string') {
    const s = value.trim();
    // #RGB 或 #RRGGBB
    if (s.startsWith('#')) {
      const hex = s.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16) / 255;
        const g = parseInt(hex[1] + hex[1], 16) / 255;
        const b = parseInt(hex[2] + hex[2], 16) / 255;
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          return [r, g, b, 1];
        }
      }
      if (hex.length === 6 || hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
          return [r, g, b, a];
        }
      }
    }
  }
  // 回退灰度
  return [0.7, 0.7, 0.7, 1.0];
}

/**
 * 从表达式提取用于 WGSL 的常量颜色（MVP：字面量或单层 get 默认值不存在时恒定灰）。
 *
 * @param expr - 样式表达式
 * @returns RGBA
 */
function extractConstantColorVec4(expr: StyleExpression): [number, number, number, number] {
  if (typeof expr === 'string') {
    return parseColorToVec4(expr);
  }
  if (Array.isArray(expr) && expr[0] === 'literal' && expr.length >= 2) {
    return parseColorToVec4(expr[1]);
  }
  // 默认 MVP 恒定色
  return [0.65, 0.65, 0.68, 1.0];
}

/**
 * 生成 WGSL 函数源码。
 *
 * @param fnName - 唯一函数名
 * @param rgba - 常量颜色
 * @returns WGSL 代码
 */
function buildWgslColorFunction(fnName: string, rgba: readonly [number, number, number, number]): string {
  const [r, g, b, a] = rgba;
  // 使用字面量常量，便于驱动常量折叠
  return `
fn ${fnName}() -> vec4<f32> {
  return vec4<f32>(${r.toFixed(6)}, ${g.toFixed(6)}, ${b.toFixed(6)}, ${a.toFixed(6)});
}
`.trim();
}

/**
 * 线性插值辅助。
 *
 * @param t - 参数 [0,1]
 * @param a - 起点
 * @param b - 终点
 * @returns 插值结果
 */
function lerp(t: number, a: number, b: number): number {
  return a + (b - a) * t;
}

/**
 * 将 stop 数组（数字与值交替）解析为数值 stops。
 *
 * @param stops - [z0,v0,z1,v1,...] 样式
 * @returns 清洗后的 stop 列表
 */
function parseNumericStops(stops: unknown[]): Array<{ z: number; v: number }> {
  const out: Array<{ z: number; v: number }> = [];
  for (let i = 0; i + 1 < stops.length; i += 2) {
    const z = stops[i];
    const v = stops[i + 1];
    if (typeof z === 'number' && typeof v === 'number' && Number.isFinite(z) && Number.isFinite(v)) {
      out.push({ z, v });
    }
  }
  out.sort((x, y) => x.z - y.z);
  return out;
}

/**
 * 在 zoom 上对分段线性 stops 求值（interpolate + linear 简化路径）。
 *
 * @param zoom - 当前缩放
 * @param stops - 控制点
 * @returns 插值数值
 */
function interpolateZoomLinear(zoom: number, stops: Array<{ z: number; v: number }>): number {
  if (stops.length === 0) {
    return Number.NaN;
  }
  if (zoom <= stops[0].z) {
    return stops[0].v;
  }
  if (zoom >= stops[stops.length - 1].z) {
    return stops[stops.length - 1].v;
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (zoom >= a.z && zoom <= b.z) {
      const t = (zoom - a.z) / (b.z - a.z);
      return lerp(t, a.v, b.v);
    }
  }
  return stops[0].v;
}

/**
 * 获取要素属性值（安全）。
 *
 * @param feature - 要素
 * @param key - 键名
 * @returns 属性值或 undefined
 */
function getFeatureProperty(feature: Feature | undefined, key: string): unknown {
  if (feature === undefined) {
    return undefined;
  }
  const props = feature.properties as Record<string, unknown> | undefined;
  if (props === undefined || props === null) {
    return undefined;
  }
  return props[key];
}

/**
 * 对 match 表达式求值（MVP：输入为 property 或字面量）。
 *
 * @param expr - match 数组
 * @param ctx - 上下文
 * @returns 选中分支值
 */
function evaluateMatch(expr: unknown[], ctx: StyleEvaluateContext): unknown {
  if (expr.length < 2) {
    return null;
  }
  const input = expr[1];
  let key: unknown;
  if (Array.isArray(input) && input[0] === 'get' && typeof input[1] === 'string') {
    key = getFeatureProperty(ctx.feature, input[1]);
  } else {
    key = evaluateInner(input, ctx);
  }
  const labels = expr.slice(2, -1);
  const fallback = expr[expr.length - 1];
  for (let i = 0; i + 1 < labels.length; i += 2) {
    const label = labels[i];
    const out = labels[i + 1];
    if (label === key) {
      return evaluateInner(out, ctx);
    }
  }
  return evaluateInner(fallback, ctx);
}

/**
 * 内部求值分发（避免与公共 evaluate 重复校验）。
 *
 * @param node - 表达式节点
 * @param ctx - 上下文
 * @returns 结果
 */
function evaluateInner(node: unknown, ctx: StyleEvaluateContext): unknown {
  if (node === null || node === undefined) {
    return null;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return node;
  }
  if (typeof node === 'string') {
    return node;
  }
  if (!Array.isArray(node)) {
    return node;
  }
  const op = node[0];
  if (op === 'get') {
    const k = node[1];
    if (typeof k !== 'string') {
      return undefined;
    }
    return getFeatureProperty(ctx.feature, k);
  }
  if (op === 'literal') {
    return node.length >= 2 ? node[1] : null;
  }
  if (op === 'zoom') {
    return ctx.zoom;
  }
  if (op === 'interpolate') {
    // ['interpolate', ['linear'], ['zoom'], z0, v0, z1, v1, ...]
    const h = node[1];
    if (Array.isArray(h) && h[0] === 'linear') {
      const zoomRef = node[2];
      if (Array.isArray(zoomRef) && zoomRef[0] === 'zoom') {
        const stops = parseNumericStops(node.slice(3));
        return interpolateZoomLinear(ctx.zoom, stops);
      }
    }
    return null;
  }
  if (op === 'match') {
    return evaluateMatch(node, ctx);
  }
  if (op === 'case') {
    // ['case', cond0, out0, cond1, out1, ..., default]
    const parts = node.slice(1);
    if (parts.length === 0) {
      return null;
    }
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const cond = evaluateInner(parts[i], ctx);
      if (Boolean(cond)) {
        return evaluateInner(parts[i + 1], ctx);
      }
    }
    const last = parts[parts.length - 1];
    return evaluateInner(last, ctx);
  }
  // ---------- MapLibre 过滤器子集（用于 compileFilter / 复合表达式）----------
  if (op === '==') {
    const a = evaluateInner(node[1], ctx);
    const b = evaluateInner(node[2], ctx);
    return a === b;
  }
  if (op === '!=') {
    const a = evaluateInner(node[1], ctx);
    const b = evaluateInner(node[2], ctx);
    return a !== b;
  }
  if (op === '>' || op === '>=' || op === '<' || op === '<=') {
    const a = evaluateInner(node[1], ctx);
    const b = evaluateInner(node[2], ctx);
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      if (op === '>') {
        return a > b;
      }
      if (op === '>=') {
        return a >= b;
      }
      if (op === '<') {
        return a < b;
      }
      return a <= b;
    }
    return false;
  }
  if (op === 'all') {
    for (let i = 1; i < node.length; i++) {
      if (!evaluateInner(node[i], ctx)) {
        return false;
      }
    }
    return true;
  }
  if (op === 'any') {
    for (let i = 1; i < node.length; i++) {
      if (evaluateInner(node[i], ctx)) {
        return true;
      }
    }
    return false;
  }
  if (op === 'none') {
    for (let i = 1; i < node.length; i++) {
      if (evaluateInner(node[i], ctx)) {
        return false;
      }
    }
    return true;
  }
  if (op === 'has') {
    const k = node[1];
    if (typeof k !== 'string') {
      return false;
    }
    return getFeatureProperty(ctx.feature, k) !== undefined;
  }
  if (op === '!has') {
    const k = node[1];
    if (typeof k !== 'string') {
      return false;
    }
    return getFeatureProperty(ctx.feature, k) === undefined;
  }
  if (op === 'in') {
    const needle = evaluateInner(node[1], ctx);
    const hay = node[2];
    if (Array.isArray(hay) && hay[0] === 'literal' && Array.isArray(hay[1])) {
      const arr = hay[1] as unknown[];
      return arr.some((x) => x === needle);
    }
    return false;
  }
  if (op === '!in') {
    const needle = evaluateInner(node[1], ctx);
    const hay = node[2];
    if (Array.isArray(hay) && hay[0] === 'literal' && Array.isArray(hay[1])) {
      const arr = hay[1] as unknown[];
      return !arr.some((x) => x === needle);
    }
    return true;
  }
  // 未知操作符：原样返回 null
  return null;
}

/**
 * StyleEngine 实现类。
 */
class StyleEngineImpl implements StyleEngine {
  /**
   * @inheritdoc
   * @stability experimental
   */
  public compile(expr: StyleExpression): CompiledStyle {
    const key = stableKey(expr);
    const cached = styleCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const rgba = extractConstantColorVec4(expr);
      wgslFnSerial += 1;
      const fnName = `${WGSL_FN_PREFIX}${wgslFnSerial}`;
      const wgsl = buildWgslColorFunction(fnName, rgba);
      const attrs = new Set<string>();
      collectGetKeys(expr, attrs);
      const dependsZ = exprDependsOnZoom(expr);
      const dependsF = exprDependsOnFeature(expr);
      const compiled: CompiledStyle = {
        wgslCode: wgsl,
        uniformValues: {
          u_paint_r: rgba[0],
          u_paint_g: rgba[1],
          u_paint_b: rgba[2],
          u_paint_a: rgba[3],
        },
        isConstant: !dependsZ && !dependsF,
        dependsOnZoom: dependsZ,
        dependsOnFeature: dependsF,
        requiredAttributes: Array.from(attrs.values()),
      };
      styleCache.set(key, compiled);
      return compiled;
    } catch (e) {
      if (e instanceof GeoForgeError) {
        throw e;
      }
      throw new GeoForgeError(
        'STYLE_COMPILE_FAILED',
        e instanceof Error ? e.message : String(e),
        {},
      );
    }
  }

  /**
   * @inheritdoc
   * @stability experimental
   */
  public compileFilter(filterExpr: FilterExpression): CompiledFilter {
    const key = stableKey(filterExpr);
    const cached = filterCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const wgslTrue = `
fn geoforge_filter_true() -> bool {
  return true;
}
`.trim();
      const evalFn = (feature: Feature): boolean => {
        if (filterExpr === undefined || filterExpr === null) {
          return true;
        }
        const r = evaluateInner(filterExpr, { zoom: 0, feature });
        return Boolean(r);
      };
      const cf: CompiledFilter = {
        wgslCode: wgslTrue,
        evaluateFeature: evalFn,
      };
      filterCache.set(key, cf);
      return cf;
    } catch (e) {
      throw new GeoForgeError(
        'STYLE_FILTER_COMPILE_FAILED',
        e instanceof Error ? e.message : String(e),
        {},
      );
    }
  }

  /**
   * @inheritdoc
   * @stability experimental
   */
  public evaluate(expr: StyleExpression, ctx: StyleEvaluateContext): unknown {
    if (ctx === undefined || ctx === null) {
      throw new GeoForgeError('STYLE_EVAL_CONTEXT_INVALID', 'evaluate: context is required', {});
    }
    if (typeof ctx.zoom !== 'number' || !Number.isFinite(ctx.zoom)) {
      throw new GeoForgeError('STYLE_EVAL_ZOOM_INVALID', 'evaluate: context.zoom must be a finite number', {});
    }
    try {
      return evaluateInner(expr, ctx);
    } catch (e) {
      throw new GeoForgeError(
        'STYLE_EVAL_FAILED',
        e instanceof Error ? e.message : String(e),
        {},
      );
    }
  }

  /**
   * @inheritdoc
   */
  public get cacheSize(): number {
    return styleCache.size + filterCache.size;
  }

  /**
   * @inheritdoc
   */
  public clearCache(): void {
    styleCache.clear();
    filterCache.clear();
  }
}

/**
 * 创建 StyleEngine 实例。
 *
 * @returns 新的 StyleEngine
 *
 * @example
 * const se = createStyleEngine();
 * const c = se.compile('#ff5500');
 * console.assert(c.wgslCode.includes('vec4'));
 */
export function createStyleEngine(): StyleEngine {
  return new StyleEngineImpl();
}
