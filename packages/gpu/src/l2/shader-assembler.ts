// ============================================================
// packages/gpu/src/l2/shader-assembler.ts — L2 ShaderAssembler
// 注册投影/几何/样式/特性 WGSL 模块，注入模板与 Hook，缓存变体。
// 零 npm 依赖。
// ============================================================

import type { ComputedUniformLayout, UniformLayoutBuilder } from './uniform-layout.ts';
import { mapShaderUniformType } from './uniform-layout.ts';
import type {
  AssembledShader,
  ShaderAssembler,
  ShaderHookPoint,
  ShaderHookRegistration,
  ShaderModuleDefinition,
  ShaderModuleType,
  ShaderUniformDeclaration,
  ShaderVariantKey,
  UniformLayout,
} from './shader-types.ts';
import { createWGSLTemplates, getDefaultPerLayerUniformsWGSL, type WGSLTemplates } from './wgsl-templates.ts';

// ---------------------------------------------------------------------------
// 再导出类型（调用方单文件 import）
// ---------------------------------------------------------------------------

export type {
  AssembledShader,
  ShaderAssembler,
  ShaderHookPoint,
  ShaderHookRegistration,
  ShaderModuleDefinition,
  ShaderModuleType,
  ShaderUniformDeclaration,
  ShaderVariantKey,
  UniformLayout,
} from './shader-types.ts';

export type { ComputedUniformLayout, UniformLayoutBuilder } from './uniform-layout.ts';


// ---------------------------------------------------------------------------
// 常量：缓存、占位符、Hook 别名、额外 uniform 绑定槽
// ---------------------------------------------------------------------------

/** 顶点/片元模板中的附加 varying 占位（无扩展时置空） */
const PLACEHOLDER_EXTRA_VARYINGS = '{{EXTRA_VARYINGS}}';

/** 投影模块注入点 */
const PLACEHOLDER_PROJECTION = '{{PROJECTION_MODULE}}';

/** 几何模块注入点 */
const PLACEHOLDER_GEOMETRY = '{{GEOMETRY_MODULE}}';

/** 特性模块拼接注入点 */
const PLACEHOLDER_FEATURE = '{{FEATURE_MODULES}}';

/** 片元样式模块注入点 */
const PLACEHOLDER_STYLE = '{{STYLE_MODULE}}';

/** 片元每图层 uniform 块 */
const PLACEHOLDER_PER_LAYER = '{{PER_LAYER_UNIFORMS}}';

/** 内置模板中 `vertex_position_after_geometry` 与枚举 `vertex_position_after_projection` 等价 */
const LEGACY_HOOK_VERTEX_AFTER_GEOM = 'vertex_position_after_geometry';

/** 额外 per-frame uniform 占用 group(0) binding(1)，避免与模板 binding(0) 冲突 */
const EXTRA_UNIFORM_BINDING_FRAME = 1;

/** 额外 per-layer uniform 占用 group(1) binding(1) */
const EXTRA_UNIFORM_BINDING_LAYER = 1;

/** 额外 per-object uniform 占用 group(2) binding(1) */
const EXTRA_UNIFORM_BINDING_OBJECT = 1;

/** 模块注册表分桶键前缀长度（类型标签） */
const MODULE_KEY_SEPARATOR = ':';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 由变体四元组生成稳定缓存键（特性 id 排序后拼接）。
 *
 * @param key - 变体键
 * @returns `${projection}|${geometry}|${style}|${sortedFeatures}`
 *
 * @example
 * const k = variantKeyToString({ projection: 'mercator', geometry: 'point', style: 'fill_solid', features: ['b','a'] });
 * // 'mercator|point|fill_solid|a,b'
 */
export function variantKeyToString(key: ShaderVariantKey): string {
  if (!key || typeof key.projection !== 'string' || key.projection.length === 0) {
    throw new Error('ShaderAssembler: ShaderVariantKey.projection must be a non-empty string.');
  }
  if (!key || typeof key.geometry !== 'string' || key.geometry.length === 0) {
    throw new Error('ShaderAssembler: ShaderVariantKey.geometry must be a non-empty string.');
  }
  if (!key || typeof key.style !== 'string' || key.style.length === 0) {
    throw new Error('ShaderAssembler: ShaderVariantKey.style must be a non-empty string.');
  }
  if (!Array.isArray(key.features)) {
    throw new Error('ShaderAssembler: ShaderVariantKey.features must be an array.');
  }
  const feats = key.features.slice().sort((a, b) => a.localeCompare(b));
  return `${key.projection}|${key.geometry}|${key.style}|${feats.join(',')}`;
}

/**
 * 将单条 `ShaderUniformDeclaration` 映射为 `UniformLayoutBuilder` 字段类型。
 *
 * @param d - 着色器 uniform 声明
 * @returns 与 `mapShaderUniformType` 一致的布局类型枚举成员
 *
 * @example
 * toUniformFieldType({ name: 'u', type: 'f32', binding: 'perFrame' });
 */
function toUniformFieldType(d: ShaderUniformDeclaration): ReturnType<typeof mapShaderUniformType> {
  return mapShaderUniformType(d.type);
}

/**
 * 校验 `ShaderModuleDefinition` 基本字段，避免空代码进入缓存。
 *
 * @param def - 模块定义
 * @returns void
 * @throws Error 当 id 或代码无效时抛出
 *
 * @example
 * validateModuleDefinition({ type: 'style', id: 'x', wgslCode: 'fn f(){}' });
 */
function validateModuleDefinition(def: ShaderModuleDefinition): void {
  if (!def.id || def.id.trim().length === 0) {
    throw new Error('ShaderAssembler.registerModule: id must be non-empty.');
  }
  if (!def.wgslCode || def.wgslCode.trim().length === 0) {
    throw new Error(`ShaderAssembler.registerModule: wgslCode for "${def.id}" must be non-empty.`);
  }
}

/**
 * 生成模块在注册表中的键。
 *
 * @param type - 模块类型
 * @param id - 模块 id
 * @returns 内部字典键
 *
 * @example
 * const k = moduleRegistryKey('projection', 'mercator');
 */
function moduleRegistryKey(type: ShaderModuleType, id: string): string {
  return `${type}${MODULE_KEY_SEPARATOR}${id}`;
}

/**
 * 自内置 `WGSLTemplates` 表构造临时 `ShaderModuleDefinition`（未显式 register 时回退）。
 *
 * @param type - 模块类型
 * @param id - 内置 id
 * @param templates - 模板集合
 * @returns 定义或 undefined
 *
 * @example
 * const m = builtinModuleFromTemplates('projection', 'mercator', tpl);
 */
function builtinModuleFromTemplates(
  type: ShaderModuleType,
  id: string,
  templates: WGSLTemplates,
): ShaderModuleDefinition | undefined {
  let code: string | undefined;
  switch (type) {
    case 'projection':
      code = templates.projectionModules[id];
      break;
    case 'geometry':
      code = templates.geometryModules[id];
      break;
    case 'style':
      code = templates.styleModules[id];
      break;
    case 'feature':
      code = templates.featureModules[id];
      break;
    default:
      code = undefined;
  }
  if (!code || code.trim().length === 0) {
    return undefined;
  }
  return { type, id, wgslCode: code };
}

/**
 * 解析模块：优先用户注册表，其次内置模板。
 *
 * @param registry - 注册表
 * @param type - 类型
 * @param id - id
 * @param templates - 内置模板
 * @returns 模块定义
 * @throws Error 当两者均不存在时抛出
 *
 * @example
 * const def = resolveModule(reg, 'geometry', 'point', tpl);
 */
function resolveModule(
  registry: Map<string, ShaderModuleDefinition>,
  type: ShaderModuleType,
  id: string,
  templates: WGSLTemplates,
): ShaderModuleDefinition {
  const reg = registry.get(moduleRegistryKey(type, id));
  if (reg) {
    return reg;
  }
  const builtin = builtinModuleFromTemplates(type, id, templates);
  if (builtin) {
    return builtin;
  }
  throw new Error(`ShaderAssembler: unknown ${type} module "${id}". Register it or use a built-in id.`);
}

/**
 * 在所有类型注册表中按 id 查找第一个匹配模块（用于依赖解析）。
 *
 * @param registry - 注册表
 * @param id - 依赖 id
 * @param templates - 内置模板
 * @returns 定义或 undefined
 *
 * @example
 * const d = findModuleByIdAny(reg, 'mercator', tpl);
 */
function findModuleByIdAny(
  registry: Map<string, ShaderModuleDefinition>,
  id: string,
  templates: WGSLTemplates,
): ShaderModuleDefinition | undefined {
  const types: ShaderModuleType[] = ['projection', 'geometry', 'style', 'feature'];
  for (const t of types) {
    const k = moduleRegistryKey(t, id);
    const hit = registry.get(k);
    if (hit) {
      return hit;
    }
    const bi = builtinModuleFromTemplates(t, id, templates);
    if (bi) {
      return bi;
    }
  }
  return undefined;
}

/**
 * 对模块 id 列表做拓扑排序（依赖在前）；检测环。
 *
 * @param rootIds - 根 id 列表（如特性列表）
 * @param resolve - id → 定义
 * @returns 拓扑序 id 数组
 * @throws Error 当缺失依赖或存在环时抛出
 *
 * @example
 * const order = topologicalSortModuleIds(['a'], (id) => map.get(id));
 */
function topologicalSortModuleIds(
  rootIds: readonly string[],
  resolve: (id: string) => ShaderModuleDefinition | undefined,
): string[] {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const result: string[] = [];

  const visit = (id: string): void => {
    if (done.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`ShaderAssembler: circular module dependency involving "${id}".`);
    }
    visiting.add(id);
    const def = resolve(id);
    if (!def) {
      throw new Error(`ShaderAssembler: unresolved module dependency "${id}".`);
    }
    const deps = def.dependencies ?? [];
    for (const d of deps) {
      visit(d);
    }
    visiting.delete(id);
    done.add(id);
    result.push(id);
  };

  for (const r of rootIds) {
    visit(r);
  }
  return result;
}

/**
 * 合并单频次的 uniform 声明列表，冲突时要求类型一致。
 *
 * @param bucket - 目标桶
 * @param incoming - 新声明
 * @returns void
 * @throws Error 当同名不同类型时抛出
 *
 * @example
 * mergeUniformDeclarations(acc, mod.uniformDeclarations);
 */
function mergeUniformDeclarations(
  bucket: Map<string, ShaderUniformDeclaration>,
  incoming: readonly ShaderUniformDeclaration[] | undefined,
): void {
  if (!incoming || incoming.length === 0) {
    return;
  }
  for (const u of incoming) {
    const prev = bucket.get(u.name);
    if (prev && (prev.type !== u.type || prev.binding !== u.binding)) {
      throw new Error(
        `ShaderAssembler: conflicting uniform "${u.name}" (${prev.type}/${prev.binding} vs ${u.type}/${u.binding}).`,
      );
    }
    if (!prev) {
      bucket.set(u.name, u);
    }
  }
}

/**
 * 自桶生成有序声明数组（按名字典序，保证稳定输出）。
 *
 * @param bucket - name → 声明
 * @returns 有序数组
 *
 * @example
 * const list = bucketToSortedDeclarations(m);
 */
function bucketToSortedDeclarations(bucket: Map<string, ShaderUniformDeclaration>): ShaderUniformDeclaration[] {
  return [...bucket.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => bucket.get(k)!) as ShaderUniformDeclaration[];
}

/**
 * 将分桶声明写入 `UniformLayoutBuilder` 并 `build`，字段为空时返回 null。
 *
 * @param builder - 布局构建器
 * @param decls - 有序声明列表
 * @param group - WebGPU group 索引
 * @param binding - binding 索引
 * @returns 计算布局或 null
 * @throws Error 当 build 失败时抛出
 *
 * @example
 * const L = buildLayoutForDeclarations(b, perFrame, 0, 1);
 */
function buildLayoutForDeclarations(
  builder: UniformLayoutBuilder,
  decls: ShaderUniformDeclaration[],
  group: number,
  binding: number,
): ComputedUniformLayout | null {
  builder.reset();
  if (decls.length === 0) {
    return null;
  }
  for (const d of decls) {
    builder.addField(d.name, toUniformFieldType(d));
  }
  return builder.build(group, binding);
}

/**
 * 为单个额外 uniform 缓冲生成 `GPUBindGroupLayoutDescriptor`。
 *
 * @param binding - binding 槽位
 * @param minBindingSize - 最小字节数
 * @returns 布局描述
 *
 * @example
 * const d = makeUniformBindGroupLayoutDescriptor(1, 256);
 */
function makeUniformBindGroupLayoutDescriptor(
  binding: number,
  minBindingSize: number,
): GPUBindGroupLayoutDescriptor {
  const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  return {
    entries: [
      {
        binding,
        visibility: vis,
        buffer: {
          type: 'uniform',
          minBindingSize,
        },
      },
    ],
  };
}

/**
 * 返回 Hook 在源码中可能出现的 `// HOOK:` 标记行（含模板遗留别名）。
 *
 * @param point - 逻辑注入点
 * @returns 需尝试替换的标记子串列表（去重）
 *
 * @example
 * const markers = hookMarkersFor('vertex_position_after_projection');
 */
function hookMarkersFor(point: ShaderHookPoint): readonly string[] {
  if (point === 'vertex_position_after_projection') {
    return [`// HOOK: ${point}`, `// HOOK: ${LEGACY_HOOK_VERTEX_AFTER_GEOM}`];
  }
  return [`// HOOK: ${point}`];
}

/**
 * 在 WGSL 源码中于首个匹配的 Hook 标记行后插入 Hook 代码（同一点多 Hook 按 priority 升序）。
 *
 * @param source - 原始 WGSL
 * @param hooks - Hook 注册表
 * @returns 注入后的 WGSL
 *
 * @example
 * const v2 = injectHooksAtMarkers(vertexTpl, hooks);
 */
function injectHooksAtMarkers(source: string, hooks: readonly ShaderHookRegistration[]): string {
  const byPoint = new Map<ShaderHookPoint, ShaderHookRegistration[]>();
  for (const h of hooks) {
    const arr = byPoint.get(h.hookPoint) ?? [];
    arr.push(h);
    byPoint.set(h.hookPoint, arr);
  }
  for (const [, arr] of byPoint) {
    arr.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }
  let out = source;
  for (const [point, arr] of byPoint) {
    const bodies = arr.map((x) => x.wgslCode.trim()).filter((x) => x.length > 0);
    if (bodies.length === 0) {
      continue;
    }
    const combined = bodies.join('\n');
    const markers = hookMarkersFor(point);
    let replaced = false;
    for (const marker of markers) {
      if (out.includes(marker)) {
        out = out.replace(marker, `${marker}\n${combined}`);
        replaced = true;
        break;
      }
    }
    if (!replaced && point !== 'compute_visibility' && point !== 'compute_sort_key') {
      // 计算类 Hook 仅作用于 compute 模板；顶点/片元若缺少对应 // HOOK: 行则跳过（不抛，以免阻断默认管线）
    }
  }
  return out;
}

/**
 * 将占位符做全局字符串替换（单次扫描，避免链式 replace 误伤）。
 *
 * @param input - 输入
 * @param placeholder - 占位符
 * @param body - 替换体
 * @returns 替换后字符串
 *
 * @example
 * const s = replacePlaceholder(tpl, '{{STYLE_MODULE}}', code);
 */
function replacePlaceholder(input: string, placeholder: string, body: string): string {
  if (!input.includes(placeholder)) {
    throw new Error(`ShaderAssembler: template missing placeholder "${placeholder}".`);
  }
  return input.split(placeholder).join(body);
}

/**
 * 拼接特性模块 WGSL（拓扑序），带分隔注释。
 *
 * @param orderedIds - 拓扑序特性 id
 * @param getDef - id → 定义
 * @returns 拼接文本
 *
 * @example
 * const f = concatFeatureModules(['a','b'], (id) => ...);
 */
function concatFeatureModules(
  orderedIds: readonly string[],
  getDef: (id: string) => ShaderModuleDefinition,
): string {
  const parts: string[] = [];
  for (const id of orderedIds) {
    const def = getDef(id);
    parts.push(`// --- feature module: ${id} ---\n${def.wgslCode}`);
  }
  return parts.join('\n\n');
}

/**
 * 展开单模块及其依赖为线性序列（依赖在前），用于投影/几何/样式单选模块。
 *
 * @param root - 根模块定义
 * @param resolve - id → 定义
 * @returns 有序定义列表
 * @throws Error 当拓扑失败时抛出
 *
 * @example
 * const chain = expandModuleWithDependencies(styleMod, resolve);
 */
function expandModuleWithDependencies(
  root: ShaderModuleDefinition,
  resolve: (id: string) => ShaderModuleDefinition | undefined,
): ShaderModuleDefinition[] {
  const ids = topologicalSortModuleIds([root.id], resolve);
  return ids.map((id) => {
    const d = resolve(id);
    if (!d) {
      throw new Error(`ShaderAssembler: internal error resolving "${id}".`);
    }
    return d;
  });
}

/**
 * 将展开后的模块链拼接为 WGSL 文本。
 *
 * @param chain - 模块链
 * @returns 拼接源码
 *
 * @example
 * const code = concatModuleChain(chain);
 */
function concatModuleChain(chain: readonly ShaderModuleDefinition[]): string {
  return chain.map((m) => `// --- ${m.type} module: ${m.id} ---\n${m.wgslCode}`).join('\n\n');
}

/**
 * 收集若干模块上声明的 uniform，并按频率分桶（同名须类型与频率一致）。
 *
 * @param modules - 已去重或含重复的模块列表（内部按 name 合并）
 * @returns 三个频次桶
 *
 * @example
 * const buckets = collectUniformBucketsFromModules([proj, geom, style]);
 */
function collectUniformBucketsFromModules(modules: readonly ShaderModuleDefinition[]): {
  perFrame: Map<string, ShaderUniformDeclaration>;
  perLayer: Map<string, ShaderUniformDeclaration>;
  perObject: Map<string, ShaderUniformDeclaration>;
} {
  const perFrame = new Map<string, ShaderUniformDeclaration>();
  const perLayer = new Map<string, ShaderUniformDeclaration>();
  const perObject = new Map<string, ShaderUniformDeclaration>();
  for (const m of modules) {
    const decls = m.uniformDeclarations;
    if (!decls) {
      continue;
    }
    for (const u of decls) {
      const bucket =
        u.binding === 'perFrame' ? perFrame : u.binding === 'perLayer' ? perLayer : perObject;
      mergeUniformDeclarations(bucket, [u]);
    }
  }
  return { perFrame, perLayer, perObject };
}

/**
 * 将模块列表按 `type:id` 去重后用于 uniform 收集（依赖链展开后可能重复）。
 *
 * @param modules - 原始列表
 * @returns 去重后的模块数组
 *
 * @example
 * const u = dedupeModulesByKey([a, b, a]);
 */
function dedupeModulesByKey(modules: readonly ShaderModuleDefinition[]): ShaderModuleDefinition[] {
  const seen = new Set<string>();
  const out: ShaderModuleDefinition[] = [];
  for (const m of modules) {
    const k = moduleRegistryKey(m.type, m.id);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(m);
  }
  return out;
}

/**
 * 创建 ShaderAssembler 实现。
 *
 * @param uniformLayoutBuilder - 无状态布局构建器（由工厂注入）
 * @returns `ShaderAssembler` 实例
 *
 * @example
 * const asm = createShaderAssembler(createUniformLayoutBuilder());
 * asm.registerModule({ type: 'style', id: 'custom', wgslCode: 'fn computeColor(){}' });
 */
export function createShaderAssembler(uniformLayoutBuilder: UniformLayoutBuilder): ShaderAssembler {
  const registry = new Map<string, ShaderModuleDefinition>();
  const hooks: ShaderHookRegistration[] = [];
  const cache = new Map<string, AssembledShader>();
  let templates: WGSLTemplates;

  try {
    templates = createWGSLTemplates();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`ShaderAssembler: failed to load WGSL templates: ${msg}`);
  }

  let lastCompilationError: { readonly moduleId: string; readonly line: number; readonly message: string } | undefined;

  const resolveForDeps = (id: string): ShaderModuleDefinition | undefined => {
    return findModuleByIdAny(registry, id, templates);
  };

  const assembleInner = (key: ShaderVariantKey): AssembledShader => {
    lastCompilationError = undefined;
    const cacheKey = variantKeyToString(key);

    const proj = resolveModule(registry, 'projection', key.projection, templates);
    const geom = resolveModule(registry, 'geometry', key.geometry, templates);
    const style = resolveModule(registry, 'style', key.style, templates);

    const featIdsUnique = [...new Set(key.features)];
    const sortedRoots = featIdsUnique.slice().sort((a, b) => a.localeCompare(b));
    const resolveFeat = (id: string): ShaderModuleDefinition | undefined => {
      try {
        return resolveModule(registry, 'feature', id, templates);
      } catch {
        return undefined;
      }
    };
    const orderedFeatureIds = topologicalSortModuleIds(sortedRoots, (id) => {
      const d = resolveFeat(id);
      if (!d) {
        throw new Error(`ShaderAssembler.assemble: unknown feature module "${id}".`);
      }
      return d;
    });

    const projChain = expandModuleWithDependencies(proj, resolveForDeps);
    const geomChain = expandModuleWithDependencies(geom, resolveForDeps);
    const styleChain = expandModuleWithDependencies(style, resolveForDeps);

    const projectionCode = concatModuleChain(projChain);
    const geometryCode = concatModuleChain(geomChain);
    const styleCode = concatModuleChain(styleChain);

    const featureCode = concatFeatureModules(orderedFeatureIds, (fid) =>
      resolveModule(registry, 'feature', fid, templates),
    );

    let vertex = templates.vertexTemplate;
    let fragment = templates.fragmentTemplate;

    vertex = replacePlaceholder(vertex, PLACEHOLDER_EXTRA_VARYINGS, '');
    fragment = replacePlaceholder(fragment, PLACEHOLDER_EXTRA_VARYINGS, '');

    vertex = replacePlaceholder(vertex, PLACEHOLDER_PROJECTION, projectionCode);
    vertex = replacePlaceholder(vertex, PLACEHOLDER_GEOMETRY, geometryCode);
    vertex = replacePlaceholder(vertex, PLACEHOLDER_FEATURE, featureCode);

    const perLayerBlock = getDefaultPerLayerUniformsWGSL();
    fragment = replacePlaceholder(fragment, PLACEHOLDER_PER_LAYER, perLayerBlock);
    fragment = replacePlaceholder(fragment, PLACEHOLDER_STYLE, styleCode);

    vertex = injectHooksAtMarkers(vertex, hooks);
    fragment = injectHooksAtMarkers(fragment, hooks);

    const layout = buildUniformLayoutInner(key);

    const bindGroupLayouts = layout.bindGroupLayouts.slice();

    let computeCode: string | undefined;
    const computeParts: string[] = [];
    const cVis = templates.computeTemplates['frustumCull'];
    const cSort = templates.computeTemplates['depthSort'];
    if (cVis && cVis.length > 0) {
      computeParts.push(injectHooksAtMarkers(cVis, hooks));
    }
    if (cSort && cSort.length > 0) {
      computeParts.push(injectHooksAtMarkers(cSort, hooks));
    }
    if (computeParts.length > 0) {
      computeCode = computeParts.join('\n\n// --- compute separator ---\n\n');
    }

    return {
      key: cacheKey,
      vertexCode: vertex,
      fragmentCode: fragment,
      computeCode,
      bindGroupLayouts,
    };
  };

  const buildUniformLayoutInner = (key: ShaderVariantKey): UniformLayout => {
    const proj = resolveModule(registry, 'projection', key.projection, templates);
    const geom = resolveModule(registry, 'geometry', key.geometry, templates);
    const style = resolveModule(registry, 'style', key.style, templates);
    const featIdsUnique = [...new Set(key.features)].sort((a, b) => a.localeCompare(b));

    const projChain = expandModuleWithDependencies(proj, resolveForDeps);
    const geomChain = expandModuleWithDependencies(geom, resolveForDeps);
    const styleChain = expandModuleWithDependencies(style, resolveForDeps);
    const featureChainsFlat: ShaderModuleDefinition[] = [];
    for (const fid of featIdsUnique) {
      const fm = resolveModule(registry, 'feature', fid, templates);
      const chain = expandModuleWithDependencies(fm, resolveForDeps);
      for (const c of chain) {
        featureChainsFlat.push(c);
      }
    }
    const allForUniforms = dedupeModulesByKey([
      ...projChain,
      ...geomChain,
      ...styleChain,
      ...featureChainsFlat,
    ]);
    const buckets = collectUniformBucketsFromModules(allForUniforms);
    const perFrameDecls = bucketToSortedDeclarations(buckets.perFrame);
    const perLayerDecls = bucketToSortedDeclarations(buckets.perLayer);
    const perObjectDecls = bucketToSortedDeclarations(buckets.perObject);

    const layoutFrame = buildLayoutForDeclarations(
      uniformLayoutBuilder,
      perFrameDecls,
      0,
      EXTRA_UNIFORM_BINDING_FRAME,
    );
    const layoutLayer = buildLayoutForDeclarations(
      uniformLayoutBuilder,
      perLayerDecls,
      1,
      EXTRA_UNIFORM_BINDING_LAYER,
    );
    const layoutObject = buildLayoutForDeclarations(
      uniformLayoutBuilder,
      perObjectDecls,
      2,
      EXTRA_UNIFORM_BINDING_OBJECT,
    );

    const bindGroupLayouts: GPUBindGroupLayoutDescriptor[] = [];
    if (layoutFrame) {
      bindGroupLayouts.push(
        makeUniformBindGroupLayoutDescriptor(EXTRA_UNIFORM_BINDING_FRAME, layoutFrame.totalSize),
      );
    }
    if (layoutLayer) {
      bindGroupLayouts.push(
        makeUniformBindGroupLayoutDescriptor(EXTRA_UNIFORM_BINDING_LAYER, layoutLayer.totalSize),
      );
    }
    if (layoutObject) {
      bindGroupLayouts.push(
        makeUniformBindGroupLayoutDescriptor(EXTRA_UNIFORM_BINDING_OBJECT, layoutObject.totalSize),
      );
    }

    return {
      bindGroupLayouts,
      perFrameUniforms: perFrameDecls,
      perLayerUniforms: perLayerDecls,
      perObjectUniforms: perObjectDecls,
      perFrameBufferSize: layoutFrame?.totalSize ?? 0,
      perLayerBufferSize: layoutLayer?.totalSize ?? 0,
      perObjectBufferSize: layoutObject?.totalSize ?? 0,
    };
  };

  const self: ShaderAssembler = {
    registerModule(definition: ShaderModuleDefinition): void {
      validateModuleDefinition(definition);
      const k = moduleRegistryKey(definition.type, definition.id);
      registry.set(k, definition);
      cache.clear();
    },

    unregisterModule(type: ShaderModuleType, id: string): void {
      registry.delete(moduleRegistryKey(type, id));
      cache.clear();
    },

    getModule(type: ShaderModuleType, id: string): ShaderModuleDefinition | undefined {
      return registry.get(moduleRegistryKey(type, id));
    },

    listModules(type?: ShaderModuleType): ShaderModuleDefinition[] {
      const out: ShaderModuleDefinition[] = [];
      for (const [, v] of registry) {
        if (!type || v.type === type) {
          out.push(v);
        }
      }
      return out.sort((a, b) => {
        const ta = a.type.localeCompare(b.type);
        if (ta !== 0) {
          return ta;
        }
        return a.id.localeCompare(b.id);
      });
    },

    registerHook(hook: ShaderHookRegistration): void {
      if (!hook.id || hook.id.trim().length === 0) {
        throw new Error('ShaderAssembler.registerHook: id must be non-empty.');
      }
      if (!hook.wgslCode || hook.wgslCode.trim().length === 0) {
        throw new Error(`ShaderAssembler.registerHook: wgslCode for "${hook.id}" must be non-empty.`);
      }
      const idx = hooks.findIndex((h) => h.id === hook.id);
      if (idx >= 0) {
        hooks.splice(idx, 1);
      }
      hooks.push(hook);
      cache.clear();
    },

    unregisterHook(id: string): void {
      const idx = hooks.findIndex((h) => h.id === id);
      if (idx >= 0) {
        hooks.splice(idx, 1);
        cache.clear();
      }
    },

    assemble(key: ShaderVariantKey): AssembledShader {
      const cacheKey = variantKeyToString(key);
      const hit = cache.get(cacheKey);
      if (hit) {
        lastCompilationError = undefined;
        return hit;
      }
      try {
        const assembled = assembleInner(key);
        cache.set(cacheKey, assembled);
        lastCompilationError = undefined;
        return assembled;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastCompilationError = {
          moduleId: 'assemble',
          line: 0,
          message: msg,
        };
        throw err;
      }
    },

    buildUniformLayout(key: ShaderVariantKey): UniformLayout {
      try {
        return buildUniformLayoutInner(key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastCompilationError = {
          moduleId: 'buildUniformLayout',
          line: 0,
          message: msg,
        };
        throw err;
      }
    },

    generateUniformWGSL(layout: UniformLayout): string {
      const parts: string[] = [];
      try {
        if (layout.perFrameUniforms.length > 0) {
          uniformLayoutBuilder.reset();
          for (const d of layout.perFrameUniforms) {
            uniformLayoutBuilder.addField(d.name, toUniformFieldType(d));
          }
          const cf = uniformLayoutBuilder.build(0, EXTRA_UNIFORM_BINDING_FRAME);
          parts.push(cf.wgslStructCode, cf.wgslBindingCode);
        }
        if (layout.perLayerUniforms.length > 0) {
          uniformLayoutBuilder.reset();
          for (const d of layout.perLayerUniforms) {
            uniformLayoutBuilder.addField(d.name, toUniformFieldType(d));
          }
          const cl = uniformLayoutBuilder.build(1, EXTRA_UNIFORM_BINDING_LAYER);
          parts.push(cl.wgslStructCode, cl.wgslBindingCode);
        }
        if (layout.perObjectUniforms.length > 0) {
          uniformLayoutBuilder.reset();
          for (const d of layout.perObjectUniforms) {
            uniformLayoutBuilder.addField(d.name, toUniformFieldType(d));
          }
          const co = uniformLayoutBuilder.build(2, EXTRA_UNIFORM_BINDING_OBJECT);
          parts.push(co.wgslStructCode, co.wgslBindingCode);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`ShaderAssembler.generateUniformWGSL: ${msg}`);
      }
      return parts.join('\n\n');
    },

    get lastCompilationError(): { readonly moduleId: string; readonly line: number; readonly message: string } | undefined {
      return lastCompilationError;
    },
  };

  return self;
}
