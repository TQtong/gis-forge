// ============================================================
// packages/gpu/src/l2/shader-types.ts — ShaderAssembler 共享类型
// 独立文件以避免 uniform-layout ↔ shader-assembler 循环依赖。
// ============================================================

/**
 * 着色器模块大类：投影 / 几何 / 样式 / 特性片段。
 */
export type ShaderModuleType = 'projection' | 'geometry' | 'style' | 'feature';

/**
 * 扩展注入点（与 wgsl-templates 中 `// HOOK:` 注释对齐，含别名映射）。
 */
export type ShaderHookPoint =
  | 'vertex_position_before_projection'
  | 'vertex_position_after_projection'
  | 'vertex_output_custom'
  | 'fragment_color_before_style'
  | 'fragment_color_after_style'
  | 'fragment_discard'
  | 'fragment_alpha'
  | 'compute_visibility'
  | 'compute_sort_key';

/**
 * 单个可在 UniformBuffer 中布局的 uniform 声明（频率分组）。
 */
export interface ShaderUniformDeclaration {
  /** WGSL 中的 uniform 名称 */
  readonly name: string;
  /** WGSL 类型（与 UniformLayoutBuilder 可映射子集） */
  readonly type: 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat3x3f' | 'mat4x4f' | 'u32' | 'i32';
  /** 更新频率：帧 / 图层 / 对象 */
  readonly binding: 'perFrame' | 'perLayer' | 'perObject';
}

/**
 * 可注册的 WGSL 模块：由 ShaderAssembler 拼入模板占位符。
 */
export interface ShaderModuleDefinition {
  /** 模块类型（决定查找表分区） */
  readonly type: ShaderModuleType;
  /** 稳定 id（与 ShaderVariantKey 中字符串对应） */
  readonly id: string;
  /** 原始 WGSL 片段（函数/结构体，不含模板外壳） */
  readonly wgslCode: string;
  /** 引擎固定 uniform 名称列表（校验/文档用，拼装时可检查） */
  readonly requiredUniforms?: string[];
  /** 依赖的其它模块 id（拓扑展开顺序） */
  readonly dependencies?: string[];
  /** 本模块额外 uniform 声明（供 buildUniformLayout） */
  readonly uniformDeclarations?: ShaderUniformDeclaration[];
}

/**
 * 管线变体键：四元组唯一确定一组投影/几何/样式/特性组合。
 */
export interface ShaderVariantKey {
  /** 投影模块 id */
  readonly projection: string;
  /** 几何模块 id */
  readonly geometry: string;
  /** 样式模块 id */
  readonly style: string;
  /** 特性模块 id 列表（顺序无关，缓存键会排序） */
  readonly features: readonly string[];
}

/**
 * 拼装结果：顶点/片元/可选计算源码与 BindGroup 布局描述。
 */
export interface AssembledShader {
  /** 与缓存一致的唯一字符串键 */
  readonly key: string;
  /** 完整顶点 WGSL */
  readonly vertexCode: string;
  /** 完整片元 WGSL */
  readonly fragmentCode: string;
  /** 可选计算 WGSL（扩展剔除/排序等） */
  readonly computeCode?: string;
  /** 本变体所需的 BindGroup 布局描述（按 group 索引顺序） */
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
}

/**
 * 从模块 uniform 声明聚合后的布局摘要（CPU 上传与 Pipeline 创建共用）。
 */
export interface UniformLayout {
  /** 与 `AssembledShader` 一致的布局描述数组 */
  readonly bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
  /** 归类为每帧更新的 uniform 声明 */
  readonly perFrameUniforms: ShaderUniformDeclaration[];
  /** 归类为每图层更新的 uniform 声明 */
  readonly perLayerUniforms: ShaderUniformDeclaration[];
  /** 归类为每对象更新的 uniform 声明 */
  readonly perObjectUniforms: ShaderUniformDeclaration[];
  /** 每帧 uniform 缓冲字节数（无额外字段时为 0） */
  readonly perFrameBufferSize: number;
  /** 每图层 uniform 缓冲字节数 */
  readonly perLayerBufferSize: number;
  /** 每对象 uniform 缓冲字节数 */
  readonly perObjectBufferSize: number;
}

/**
 * 注册到 ShaderAssembler 的 Hook 片段（按 priority 排序注入）。
 */
export interface ShaderHookRegistration {
  /** Hook 实例唯一 id（注销用） */
  readonly id: string;
  /** 注入点 */
  readonly hookPoint: ShaderHookPoint;
  /** 合法 WGSL 片段（多语句需用大括号包裹） */
  readonly wgslCode: string;
  /** 同点多个 Hook 的排序键（默认 0；越小越靠前） */
  readonly priority?: number;
  /** 若 Hook 依赖某模块先拼装，可写模块 id */
  readonly dependencies?: string[];
}

/**
 * L2 着色器拼装器：模块注册 + 模板拼装 + Hook 注入 + 缓存。
 */
export interface ShaderAssembler {
  /** 注册模块（覆盖同 type+id） */
  registerModule(definition: ShaderModuleDefinition): void;
  /** 移除模块 */
  unregisterModule(type: ShaderModuleType, id: string): void;
  /** 查询单个模块 */
  getModule(type: ShaderModuleType, id: string): ShaderModuleDefinition | undefined;
  /** 列出全部或某类型的模块 */
  listModules(type?: ShaderModuleType): ShaderModuleDefinition[];
  /** 注册 Hook */
  registerHook(hook: ShaderHookRegistration): void;
  /** 按 id 注销 Hook */
  unregisterHook(id: string): void;
  /** 拼装 WGSL 与布局描述 */
  assemble(key: ShaderVariantKey): AssembledShader;
  /** 仅构建 uniform 布局（不写入缓存着色器） */
  buildUniformLayout(key: ShaderVariantKey): UniformLayout;
  /** 将 UniformLayout 转为额外 WGSL struct/binding 文本（不含引擎固定块） */
  generateUniformWGSL(layout: UniformLayout): string;
  /** 最近一次拼装失败的诊断信息 */
  readonly lastCompilationError?: { readonly moduleId: string; readonly line: number; readonly message: string };
}
