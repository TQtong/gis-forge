// ============================================================
// packages/gpu/src/l2/wgsl-templates.ts — L2 WGSL 模板模块
// ShaderAssembler 通过占位符替换将投影/几何/样式/特性模块拼装为完整 WGSL。
// 零 npm 依赖；仅导出类型与工厂函数。
// ============================================================

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
  // 使用单个模板字面量，便于整体拷贝到 ShaderAssembler 调试输出
  return `// GeoForge — vertex template (assembled by ShaderAssembler)
struct PerFrameUniforms {
  viewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  vpMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  _pad0: f32,
  viewport: vec2<f32>,
  time: f32,
  zoom: f32,
}
@group(0) @binding(0) var<uniform> uFrame: PerFrameUniforms;

struct PerObjectUniforms {
  modelMatrix: mat4x4<f32>,
  rtcCenter: vec3<f32>,
  _padObj: f32,
}
@group(2) @binding(0) var<uniform> uObject: PerObjectUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  {{EXTRA_VARYINGS}}
}

// ===== 投影模块注入点 =====
// 必须实现: fn projectPosition(worldPos: vec3<f32>) -> vec4<f32>;
{{PROJECTION_MODULE}}

// ===== 几何模块注入点 =====
// 必须实现: fn processVertex(input: VertexInput) -> VertexOutput;
{{GEOMETRY_MODULE}}

// ===== 特性模块注入点（可包含辅助函数；主流程在下方调用 gf_vertex_features_post）=====
{{FEATURE_MODULES}}

fn gf_vertex_features_post(output: ptr<function, VertexOutput>) {
  // HOOK: feature_vertex_begin
  // 默认无操作；通过读取再写回 clip，保证 ptr 参数被使用且行为不变
  let clip = (*output).clipPosition;
  (*output).clipPosition = clip;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  // HOOK: vertex_position_before_projection
  output = processVertex(input);
  // HOOK: vertex_position_after_geometry
  output.clipPosition = projectPosition(output.worldPosition);
  gf_vertex_features_post(&output);
  // HOOK: vertex_output_custom
  return output;
}
`;
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
  return `// GeoForge — fragment template (assembled by ShaderAssembler)
struct PerFrameUniforms {
  viewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  vpMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  _pad0: f32,
  viewport: vec2<f32>,
  time: f32,
  zoom: f32,
}
@group(0) @binding(0) var<uniform> uFrame: PerFrameUniforms;

// ===== 图层 Uniform 注入点（样式扩展可替换整段 struct + var）=====
{{PER_LAYER_UNIFORMS}}

struct FragmentInput {
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  {{EXTRA_VARYINGS}}
}

@group(3) @binding(0) var uGlyphTexture: texture_2d<f32>;
@group(3) @binding(1) var uGlyphSampler: sampler;

// ===== 样式模块注入点 =====
// 必须实现: fn computeColor(input: FragmentInput) -> vec4<f32>;
{{STYLE_MODULE}}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // HOOK: fragment_color_before_style
  var color = computeColor(input);
  // HOOK: fragment_color_after_style
  // HOOK: fragment_alpha
  // HOOK: fragment_discard
  return color;
}
`;
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
  return `// GeoForge — frustum cull compute
struct FrustumCullParams {
  plane0: vec4<f32>,
  plane1: vec4<f32>,
  plane2: vec4<f32>,
  plane3: vec4<f32>,
  plane4: vec4<f32>,
  plane5: vec4<f32>,
  objectCount: u32,
  _pad: vec3<u32>,
}
@group(0) @binding(0) var<uniform> uCull: FrustumCullParams;
@group(0) @binding(1) var<storage, read> aabbMin: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> aabbMax: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

fn distanceToPlane(p: vec3<f32>, plane: vec4<f32>) -> f32 {
  return dot(vec4<f32>(p, 1.0), plane);
}

fn aabbOutsidePlane(minP: vec3<f32>, maxP: vec3<f32>, plane: vec4<f32>) -> bool {
  let n = plane.xyz;
  let c = vec3<f32>(
    select(minP.x, maxP.x, n.x >= 0.0),
    select(minP.y, maxP.y, n.y >= 0.0),
    select(minP.z, maxP.z, n.z >= 0.0),
  );
  return distanceToPlane(c, plane) < 0.0;
}

fn isAabbVisible(minP: vec3<f32>, maxP: vec3<f32>) -> bool {
  let p0 = uCull.plane0;
  let p1 = uCull.plane1;
  let p2 = uCull.plane2;
  let p3 = uCull.plane3;
  let p4 = uCull.plane4;
  let p5 = uCull.plane5;
  if (aabbOutsidePlane(minP, maxP, p0)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p1)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p2)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p3)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p4)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p5)) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn cs_frustum_cull_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uCull.objectCount) { return; }
  let mn = aabbMin[i].xyz;
  let mx = aabbMax[i].xyz;
  let vis = select(0u, 1u, isAabbVisible(mn, mx));
  visible[i] = vis;
}
`;
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
  return `// GeoForge — depth sort placeholder (identity permutation)
struct DepthSortParams {
  elementCount: u32,
  _pad: vec3<u32>,
}
@group(0) @binding(0) var<uniform> uSort: DepthSortParams;
@group(0) @binding(1) var<storage, read> depthKeys: array<f32>;
@group(0) @binding(2) var<storage, read> inputIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> outputIndices: array<u32>;

@compute @workgroup_size(256)
fn cs_depth_sort_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uSort.elementCount) { return; }
  let idx = inputIndices[i];
  // 占位：读取 depth key，避免 storage 绑定在占位 pass 中被优化器判为未使用；radix 实现后改为真实排序键
  let key = depthKeys[i];
  outputIndices[i] = select(idx, idx, key == key);
}
`;
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
  const mercator = `// projection: mercator — 世界坐标经 CPU vp 矩阵变换到裁剪空间
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let projected = uFrame.vpMatrix * vec4<f32>(worldPos, 1.0);
  return projected;
}
`;

  const globe = `// projection: globe — ECEF 相对 RTC 中心后再乘 VP（大场景精度）
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let relative = worldPos - uObject.rtcCenter;
  let projected = uFrame.vpMatrix * vec4<f32>(relative, 1.0);
  return projected;
}
`;

  const ortho = `// projection: ortho — 正交视图由 CPU 预乘入 vpMatrix，此处与墨卡托同型变换
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let projected = uFrame.vpMatrix * vec4<f32>(worldPos, 1.0);
  return projected;
}
`;

  const out: Record<string, string> = {};
  out[PROJ_MERCATOR] = mercator;
  out[PROJ_GLOBE] = globe;
  out[PROJ_ORTHO] = ortho;
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
  const point = `// geometry: point — 模型矩阵变到世界，保留属性
fn processVertex(input: VertexInput) -> VertexOutput {
  var o: VertexOutput;
  let wp = (uObject.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
  o.worldPosition = wp;
  let nrm = (uObject.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
  o.worldNormal = normalize(nrm);
  o.uv = input.uv;
  o.color = input.color;
  o.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  return o;
}
`;

  const line = `// geometry: line — 与点类似；宽线 extrusion 由上层扩展 vertex attributes
fn processVertex(input: VertexInput) -> VertexOutput {
  var o: VertexOutput;
  let wp = (uObject.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
  o.worldPosition = wp;
  let nrm = (uObject.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
  o.worldNormal = normalize(nrm);
  o.uv = input.uv;
  o.color = input.color;
  o.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  return o;
}
`;

  const polygon = `// geometry: polygon — 带法线用于光照/描边；Z 由顶点高程提供
fn processVertex(input: VertexInput) -> VertexOutput {
  var o: VertexOutput;
  let wp = (uObject.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
  o.worldPosition = wp;
  let nrm = (uObject.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
  o.worldNormal = normalize(nrm);
  o.uv = input.uv;
  o.color = input.color;
  o.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  return o;
}
`;

  const out: Record<string, string> = {};
  out[GEOM_POINT] = point;
  out[GEOM_LINE] = line;
  out[GEOM_POLYGON] = polygon;
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
  const fillSolid = `// style: fill_solid — 直接使用插值颜色
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let c = input.color * uLayer.baseColor;
  return vec4<f32>(c.rgb, c.a * uLayer.opacity);
}
`;

  const fillGradient = `// style: fill_gradient — UV 沿 gradientAngle 方向插值
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let ang = uLayer.gradientAngle;
  let dir = vec2<f32>(cos(ang), sin(ang));
  let t = dot(input.uv - vec2<f32>(0.5, 0.5), dir) + 0.5;
  let tt = clamp(t, 0.0, 1.0);
  let c = mix(uLayer.baseColor, input.color, tt);
  return vec4<f32>(c.rgb, c.a * uLayer.opacity);
}
`;

  const stroke = `// style: stroke — 基于 UV 横向距离模拟线宽衰减（配合 line 几何）
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let w = max(uLayer.lineWidth, 1e-4);
  let d = abs(input.uv.x - 0.5) * 2.0;
  let edge = smoothstep(w + 1.0, w, d);
  let a = input.color.a * uLayer.opacity * edge;
  return vec4<f32>(input.color.rgb * uLayer.baseColor.rgb, a);
}
`;

  const out: Record<string, string> = {};
  out[STYLE_FILL_SOLID] = fillSolid;
  out[STYLE_FILL_GRADIENT] = fillGradient;
  out[STYLE_STROKE] = stroke;
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
  const logDepth = `// feature: logarithmic depth buffer — 调整 clip.z（与 Reversed-Z 管线配合时由 DepthManager 选型）
fn gf_log_depth_modify_clip_z(clip: vec4<f32>) -> vec4<f32> {
  let C = ${WGSL_LOG_DEPTH_C};
  let w = max(clip.w, 1e-6);
  let ez = clip.z / w;
  let lz = log(C * w + 1.0) / log(C + 1.0);
  let nz = mix(ez, lz, 0.5);
  return vec4<f32>(clip.x, clip.y, nz * w, clip.w);
}
`;

  const splitDouble = `// feature: split double — 自 high/low 与 RTC 重建世界坐标（CPU 须对齐上传）
fn gf_reconstruct_world_from_split(
  posHigh: vec3<f32>,
  posLow: vec3<f32>,
  rtcHigh: vec3<f32>,
  rtcLow: vec3<f32>,
) -> vec3<f32> {
  let rh = posHigh - rtcHigh;
  let rl = posLow - rtcLow;
  return rh + rl;
}
`;

  const sdfLine = `// feature: sdf line — 有向距离抗锯齿（dist 为到中心线 signed 距离，像素单位）
fn gf_sdf_line_alpha(dist: f32, halfWidth: f32) -> f32 {
  let w = max(halfWidth, 1e-4);
  let d = abs(dist);
  return 1.0 - smoothstep(w - 1.0, w + 1.0, d);
}
`;

  const msdfText = `// feature: msdf text — 三通道 median 反走样（需绑定 group(3) 纹理）
fn gf_msdf_median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn gf_msdf_sample_alpha(uv: vec2<f32>, pxRange: f32) -> f32 {
  let msdf = textureSampleLevel(uGlyphTexture, uGlyphSampler, uv, 0.0);
  let m = gf_msdf_median(msdf.r, msdf.g, msdf.b);
  let w = max(pxRange, 1e-4);
  let sig = smoothstep(${WGSL_MSDF_MEDIAN} - w, ${WGSL_MSDF_MEDIAN} + w, m);
  return sig;
}
`;

  const out: Record<string, string> = {};
  out[FEAT_LOG_DEPTH] = logDepth;
  out[FEAT_SPLIT_DOUBLE] = splitDouble;
  out[FEAT_SDF_LINE] = sdfLine;
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
