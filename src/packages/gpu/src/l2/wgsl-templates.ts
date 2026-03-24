// ============================================================
// packages/gpu/src/l2/wgsl-templates.ts — L2 WGSL 模板模块
// ShaderAssembler 通过占位符替换将投影/几何/样式/特性模块拼装为完整 WGSL。
// 零 npm 依赖；仅导出类型与工厂函数。
// ============================================================

import depthSortTemplateWgsl from '../wgsl/templates/depth-sort-template.wgsl?raw';
import fillGradientWgsl from '../wgsl/style/fill-gradient.wgsl?raw';
import fillSolidWgsl from '../wgsl/style/fill-solid.wgsl?raw';
import fragmentTemplateWgsl from '../wgsl/templates/fragment-template.wgsl?raw';
import frustumCullTemplateWgsl from '../wgsl/templates/frustum-cull-template.wgsl?raw';
import globeWgsl from '../wgsl/projection/globe.wgsl?raw';
import lineWgsl from '../wgsl/geometry/line.wgsl?raw';
import logDepthRaw from '../wgsl/feature/log-depth.wgsl?raw';
import mercatorWgsl from '../wgsl/projection/mercator.wgsl?raw';
import msdfTextRaw from '../wgsl/feature/msdf-text.wgsl?raw';
import orthoWgsl from '../wgsl/projection/ortho.wgsl?raw';
import pointWgsl from '../wgsl/geometry/point.wgsl?raw';
import polygonWgsl from '../wgsl/geometry/polygon.wgsl?raw';
import sdfLineWgsl from '../wgsl/feature/sdf-line.wgsl?raw';
import splitDoubleWgsl from '../wgsl/feature/split-double.wgsl?raw';
import strokeWgsl from '../wgsl/style/stroke.wgsl?raw';
import vertexTemplateWgsl from '../wgsl/templates/vertex-template.wgsl?raw';

/**
 * 内置 WGSL 模板与模块化片段集合。
 * ShaderAssembler 读取本对象中的字符串，替换 {{PLACEHOLDER}} 后生成最终源码。
 *
 * @remarks
 * - `vertexTemplate` / `fragmentTemplate` 含固定 BindGroup 布局与 Hook 注释。
 * - `computeTemplates` 供 ComputePassManager / FrameGraphBuilder 使用。
 * - 各 `*Modules` 为可拼接片段，需满足模板中标注的函数契约。
 */
export interface WGSLTemplates {
  /** 顶点着色器主模板（含 {{PROJECTION_MODULE}} 等占位符与 HOOK 注释） */
  readonly vertexTemplate: string;
  /** 片元着色器主模板（含 {{PER_LAYER_UNIFORMS}}、{{STYLE_MODULE}} 等） */
  readonly fragmentTemplate: string;
  /** 计算着色器模板：键为任务 id（如 `frustumCull`、`depthSort`） */
  readonly computeTemplates: Record<string, string>;
  /** 投影模块：`mercator` | `globe` | `ortho`，须实现 `projectPosition` */
  readonly projectionModules: Record<string, string>;
  /** 几何模块：`point` | `line` | `polygon`，须实现 `processVertex` */
  readonly geometryModules: Record<string, string>;
  /** 样式模块：`fill_solid` | `fill_gradient` | `stroke`，须实现 `computeColor` */
  readonly styleModules: Record<string, string>;
  /** 特性模块：`logDepth` | `splitDouble` | `sdf_line` | `msdf_text`（辅助函数片段） */
  readonly featureModules: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 常量：模板键与校验用（避免魔法字符串散落）
// ---------------------------------------------------------------------------

/** Compute 模板键：视锥剔除 */
const COMPUTE_KEY_FRUSTUM_CULL = 'frustumCull' as const;
/** Compute 模板键：深度排序占位（radix sort 由后续实现替换） */
const COMPUTE_KEY_DEPTH_SORT = 'depthSort' as const;

/** 投影模块键 */
const PROJ_MERCATOR = 'mercator' as const;
const PROJ_GLOBE = 'globe' as const;
const PROJ_ORTHO = 'ortho' as const;

/** 几何模块键 */
const GEOM_POINT = 'point' as const;
const GEOM_LINE = 'line' as const;
const GEOM_POLYGON = 'polygon' as const;

/** 样式模块键 */
const STYLE_FILL_SOLID = 'fill_solid' as const;
const STYLE_FILL_GRADIENT = 'fill_gradient' as const;
const STYLE_STROKE = 'stroke' as const;

/** 特性模块键 */
const FEAT_LOG_DEPTH = 'logDepth' as const;
const FEAT_SPLIT_DOUBLE = 'splitDouble' as const;
const FEAT_SDF_LINE = 'sdf_line' as const;
const FEAT_MSDF_TEXT = 'msdf_text' as const;

/** 对数深度：深度范围系数 C（经验值，与 CPU 侧 VP 远裁剪面配合调参） */
const WGSL_LOG_DEPTH_C = 1.0e6;
/** MSDF 距离场中等值线阈值（Green 论文常用 ~0.5） */
const WGSL_MSDF_MEDIAN = 0.5;

// ---------------------------------------------------------------------------
// WGSL 片段构建函数（每个函数均有 JSDoc，便于 ShaderAssembler 侧检索契约）
// ---------------------------------------------------------------------------

/**
 * 构建顶点主模板字符串。
 * 包含 PerFrame、PerObject（@group(0/2)）及注入占位符；图层 Uniform 仅在片元模板中注入。
 *
 * @param _ — 无参数
 * @returns 含 `{{PROJECTION_MODULE}}`、`{{GEOMETRY_MODULE}}`、`{{FEATURE_MODULES}}`、`{{EXTRA_VARYINGS}}` 的 WGSL 源码
 *
 * @example
 * const t = buildVertexTemplate();
 * assembler.replace(t, '{{PROJECTION_MODULE}}', projCode);
 */
function buildVertexTemplate(): string {
  return vertexTemplateWgsl;
}

/**
 * 构建片元主模板字符串。
 * 含 group(3) 纹理/采样器占位及样式注入点。
 *
 * @param _ — 无参数
 * @returns 含 `{{PER_LAYER_UNIFORMS}}`、`{{STYLE_MODULE}}`、`{{EXTRA_VARYINGS}}` 的 WGSL 源码
 *
 * @example
 * const f = buildFragmentTemplate();
 * shader.replace('{{STYLE_MODULE}}', styleCode);
 */
function buildFragmentTemplate(): string {
  return fragmentTemplateWgsl;
}

/**
 * 返回默认的 `{{PER_LAYER_UNIFORMS}}` 展开内容（可与 fragmentTemplate 组合使用）。
 *
 * @param _ — 无实际参数（JSDoc 占位以满足「无参函数」文档约定）
 * @returns 含 `PerLayerStyleUniforms` 与 `@group(1)` 绑定的 WGSL 片段
 *
 * @example
 * const wgsl = fragment.replace('{{PER_LAYER_UNIFORMS}}', getDefaultPerLayerUniformsWGSL());
 */
export function getDefaultPerLayerUniformsWGSL(): string {
  return `struct PerLayerStyleUniforms {
  baseColor: vec4<f32>,
  opacity: f32,
  lineWidth: f32,
  gradientAngle: f32,
  _padLayerStyle: f32,
}
@group(1) @binding(0) var<uniform> uLayer: PerLayerStyleUniforms;`;
}

/**
 * 构建视锥剔除计算着色器模板。
 * AABB（min/max）与视锥平面方程存储于 storage buffer。
 *
 * @param _ — 无参数
 * @returns 有效 WGSL compute 源码
 *
 * @example
 * pipeline = device.createComputePipeline({ compute: { module, entryPoint: 'cs_frustum_cull_main' } });
 */
function buildFrustumCullCompute(): string {
  return frustumCullTemplateWgsl;
}

/**
 * 构建深度排序占位计算着色器（identity：输出序等于输入序，便于后续替换为 radix sort）。
 *
 * @param _ — 无参数
 * @returns 有效 WGSL compute 源码
 *
 * @example
 * // 后续将 entryPoint 保持为 cs_depth_sort_main 以兼容 FrameGraph
 */
function buildDepthSortCompute(): string {
  return depthSortTemplateWgsl;
}

/**
 * 构建投影模块表：墨卡托 / 球体 RTC / 正交。
 *
 * @param _ — 无参数
 * @returns 投影名到 WGSL 片段的映射
 *
 * @example
 * const code = projectionModules['mercator'];
 */
function buildProjectionModules(): Record<string, string> {
  const out: Record<string, string> = {};
  out[PROJ_MERCATOR] = mercatorWgsl;
  out[PROJ_GLOBE] = globeWgsl;
  out[PROJ_ORTHO] = orthoWgsl;
  return out;
}

/**
 * 构建几何模块表：点 / 线 / 多边形（法线）。
 *
 * @param _ — 无参数
 * @returns 几何名到 WGSL 片段的映射
 *
 * @example
 * const g = geometryModules['polygon'];
 */
function buildGeometryModules(): Record<string, string> {
  const out: Record<string, string> = {};
  out[GEOM_POINT] = pointWgsl;
  out[GEOM_LINE] = lineWgsl;
  out[GEOM_POLYGON] = polygonWgsl;
  return out;
}

/**
 * 构建样式模块表：实色填充 / 渐变 / 描边宽度。
 *
 * @param _ — 无参数
 * @returns 样式名到 WGSL 片段的映射
 *
 * @example
 * const s = styleModules['fill_gradient'];
 */
function buildStyleModules(): Record<string, string> {
  const out: Record<string, string> = {};
  out[STYLE_FILL_SOLID] = fillSolidWgsl;
  out[STYLE_FILL_GRADIENT] = fillGradientWgsl;
  out[STYLE_STROKE] = strokeWgsl;
  return out;
}

/**
 * 构建特性模块表：对数深度、双精度重建、SDF 线、MSDF 文字。
 *
 * @param _ — 无参数
 * @returns 特性名到 WGSL 片段的映射
 *
 * @example
 * const f = featureModules['msdf_text'];
 */
function buildFeatureModules(): Record<string, string> {
  const logDepth = logDepthRaw.replace('{{LOG_DEPTH_C}}', String(WGSL_LOG_DEPTH_C));
  const msdfText = msdfTextRaw.replace(/\{\{MSDF_MEDIAN\}\}/g, String(WGSL_MSDF_MEDIAN));

  const out: Record<string, string> = {};
  out[FEAT_LOG_DEPTH] = logDepth;
  out[FEAT_SPLIT_DOUBLE] = splitDoubleWgsl;
  out[FEAT_SDF_LINE] = sdfLineWgsl;
  out[FEAT_MSDF_TEXT] = msdfText;
  return out;
}

/**
 * 校验 `WGSLTemplates` 实例：必填字段非空、必备键存在。
 *
 * @param templates - 待校验对象
 * @throws Error 当结构不完整或片段为空时抛出
 * @returns void
 *
 * @example
 * validateWGSLTemplates(createWGSLTemplates());
 */
function validateWGSLTemplates(templates: WGSLTemplates): void {
  // 先校验主模板非空，避免后续 includes 在空串上误通过
  if (!templates.vertexTemplate || templates.vertexTemplate.trim().length === 0) {
    throw new Error('WGSLTemplates.vertexTemplate must be a non-empty string.');
  }
  if (!templates.fragmentTemplate || templates.fragmentTemplate.trim().length === 0) {
    throw new Error('WGSLTemplates.fragmentTemplate must be a non-empty string.');
  }

  // ShaderAssembler 依赖固定占位符；缺失会导致静默错误拼装
  const requiredVertexMarkers = [
    '{{PROJECTION_MODULE}}',
    '{{GEOMETRY_MODULE}}',
    '{{FEATURE_MODULES}}',
    '{{EXTRA_VARYINGS}}',
  ];
  for (const m of requiredVertexMarkers) {
    if (!templates.vertexTemplate.includes(m)) {
      throw new Error(`WGSLTemplates.vertexTemplate must contain placeholder "${m}".`);
    }
  }

  const requiredFragMarkers = ['{{PER_LAYER_UNIFORMS}}', '{{STYLE_MODULE}}', '{{EXTRA_VARYINGS}}'];
  for (const m of requiredFragMarkers) {
    if (!templates.fragmentTemplate.includes(m)) {
      throw new Error(`WGSLTemplates.fragmentTemplate must contain placeholder "${m}".`);
    }
  }

  // Compute 管线按固定 key 查找；缺键会在运行时才发现
  const compute = templates.computeTemplates;
  if (!compute[COMPUTE_KEY_FRUSTUM_CULL] || compute[COMPUTE_KEY_FRUSTUM_CULL].trim().length === 0) {
    throw new Error(`WGSLTemplates.computeTemplates must include non-empty "${COMPUTE_KEY_FRUSTUM_CULL}".`);
  }
  if (!compute[COMPUTE_KEY_DEPTH_SORT] || compute[COMPUTE_KEY_DEPTH_SORT].trim().length === 0) {
    throw new Error(`WGSLTemplates.computeTemplates must include non-empty "${COMPUTE_KEY_DEPTH_SORT}".`);
  }

  // 投影/几何/样式/特性为 Record，必须包含文档约定的全部键
  const projKeys = [PROJ_MERCATOR, PROJ_GLOBE, PROJ_ORTHO];
  for (const k of projKeys) {
    const code = templates.projectionModules[k];
    if (!code || code.trim().length === 0) {
      throw new Error(`WGSLTemplates.projectionModules["${k}"] must be non-empty.`);
    }
  }

  const geomKeys = [GEOM_POINT, GEOM_LINE, GEOM_POLYGON];
  for (const k of geomKeys) {
    const code = templates.geometryModules[k];
    if (!code || code.trim().length === 0) {
      throw new Error(`WGSLTemplates.geometryModules["${k}"] must be non-empty.`);
    }
  }

  const styleKeys = [STYLE_FILL_SOLID, STYLE_FILL_GRADIENT, STYLE_STROKE];
  for (const k of styleKeys) {
    const code = templates.styleModules[k];
    if (!code || code.trim().length === 0) {
      throw new Error(`WGSLTemplates.styleModules["${k}"] must be non-empty.`);
    }
  }

  const featKeys = [FEAT_LOG_DEPTH, FEAT_SPLIT_DOUBLE, FEAT_SDF_LINE, FEAT_MSDF_TEXT];
  for (const k of featKeys) {
    const code = templates.featureModules[k];
    if (!code || code.trim().length === 0) {
      throw new Error(`WGSLTemplates.featureModules["${k}"] must be non-empty.`);
    }
  }
}

/**
 * 创建默认 WGSL 模板集合（ShaderAssembler 模块化拼装入口）。
 *
 * @param _ — 无参数
 * @returns 只读模板聚合对象；已通过占位符与完整性校验
 * @throws Error 当内部片段装配失败或校验不通过时抛出
 *
 * @example
 * const wgsl = createWGSLTemplates();
 * const mercator = wgsl.projectionModules['mercator'];
 */
export function createWGSLTemplates(): WGSLTemplates {
  try {
    const vertexTemplate = buildVertexTemplate();
    // 保留 {{PER_LAYER_UNIFORMS}}，由 ShaderAssembler 注入；默认片段见 getDefaultPerLayerUniformsWGSL()
    const fragmentTemplate = buildFragmentTemplate();

    const computeTemplates: Record<string, string> = {};
    // 与 FrameGraphBuilder / ComputePassManager 约定的 id 对齐
    computeTemplates[COMPUTE_KEY_FRUSTUM_CULL] = buildFrustumCullCompute();
    computeTemplates[COMPUTE_KEY_DEPTH_SORT] = buildDepthSortCompute();

    const projectionModules = buildProjectionModules();
    const geometryModules = buildGeometryModules();
    const styleModules = buildStyleModules();
    const featureModules = buildFeatureModules();

    const result: WGSLTemplates = {
      vertexTemplate,
      fragmentTemplate,
      computeTemplates,
      projectionModules,
      geometryModules,
      styleModules,
      featureModules,
    };

    // 工厂出口前统一校验，避免调用方拿到半残配置
    validateWGSLTemplates(result);
    return result;
  } catch (err) {
    // 将非 Error 抛值也纳入消息，便于定位（如校验阶段字符串化失败）
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`createWGSLTemplates failed: ${msg}`);
  }
}
