/**
 * @file GeoForge L5 — EP4 Shader Hook（WGSL 注入扩展点）
 *
 * @description
 * **EP4** 允许在 L2 ShaderAssembler 预置锚点插入 WGSL 片段，实现夜间模式、自定义光照等。
 * `ShaderHookPoint` 限定九个稳定锚点；`ShaderHookDefinition` 描述代码、优先级与依赖，
 * 由 `ExtensionRegistry.registerShaderHook(id, hook)` 注册（id 在 Registry 侧管理）。
 */

/**
 * Shader 组合锚点：顶点 / 片元 / 计算阶段各若干固定插入位置。
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
 * 单个 Shader 钩子定义：由 ShaderAssembler 按 `hookPoint` 与 `priority` 排序合并。
 */
export interface ShaderHookDefinition {
  /** 插入锚点（九个之一）。 */
  readonly hookPoint: ShaderHookPoint;
  /** 合法 WGSL 片段（需与 uniform/varying 声明一致）。 */
  readonly wgslCode: string;
  /**
   * 可选：优先级；数值越大越先插入（默认 0）。
   * @remarks 同点多钩子时用于稳定排序。
   */
  readonly priority?: number;
  /** 可选：依赖的其他钩子注册 id（由 Registry 解析顺序）。 */
  readonly dependencies?: readonly string[];
  /**
   * 可选：额外 uniform 声明（名称 + WGSL 类型字符串）。
   */
  readonly extraUniforms?: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  /**
   * 可选：额外 varying 声明。
   */
  readonly extraVaryings?: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  /**
   * 可选：运行时开关；返回 `false` 时本帧跳过该钩子的代码生成。
   */
  readonly enableCondition?: () => boolean;
}

/**
 * 返回一个恒为禁用的 `enableCondition`，用于临时停用钩子而不卸载注册。
 *
 * @returns 返回 `false` 的函数引用
 *
 * @example
 * ```ts
 * const hook: ShaderHookDefinition = {
 *   hookPoint: 'fragment_color_after_style',
 *   wgslCode: 'color = vec4<f32>(0.0);',
 *   enableCondition: createDisabledShaderHookCondition(),
 * };
 * ```
 */
export function createDisabledShaderHookCondition(): () => boolean {
  return (): boolean => {
    // 明确关闭：Assembler 仍注册定义，但每帧不激活
    return false;
  };
}

/**
 * 校验 `ShaderHookPoint` 是否为九个合法字面量之一（用于运行时配置防御）。
 *
 * @param value - 待校验字符串
 * @returns 是否为合法枚举值
 *
 * @example
 * ```ts
 * if (!isShaderHookPoint(userInput)) throw new Error('bad hook');
 * ```
 */
export function isShaderHookPoint(value: string): value is ShaderHookPoint {
  // 穷举白名单，避免依赖字符串枚举运行时对象
  switch (value) {
    case 'vertex_position_before_projection':
    case 'vertex_position_after_projection':
    case 'vertex_output_custom':
    case 'fragment_color_before_style':
    case 'fragment_color_after_style':
    case 'fragment_discard':
    case 'fragment_alpha':
    case 'compute_visibility':
    case 'compute_sort_key':
      return true;
    default:
      return false;
  }
}
