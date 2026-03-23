// ============================================================
// l2/blend-presets.ts — GPUBlendState 预设集合
// 层级：L2（渲染层）
// 职责：提供常用混合模式的 GPUBlendState 预定义配置，
//       简化 Pipeline 创建时的混合状态设置。
// 约束：无 npm 依赖；仅使用浏览器 WebGPU 全局类型（GPUBlendState 等）；
//       本模块无 GPU 资源创建，可与 PipelineCache 组合缓存 Pipeline。
// 说明：opaque 使用 undefined，表示 Fragment 目标不启用混合（替换写入）；
//       stencilOnly 提供「源贡献为 0」的混合式占位，配合 colorWriteMask: 0
//       可在模板/深度-only Pass 中避免误改颜色附件。
// ============================================================

/**
 * BlendPresets 对外 API：预置 GPUBlendState 与自定义工厂方法。
 * 所有只读字段在 `createBlendPresets()` 返回实例上冻结语义由实现保证（每次工厂返回新对象）。
 */
export interface BlendPresets {
  /**
   * 不透明绘制：不启用混合。
   * 在 `GPUColorTargetState` 中应设为 `blend: undefined`，由管线以替换方式写入颜色。
   */
  readonly opaque: undefined;
  /**
   * 标准（非预乘）Alpha 混合：RGB 与 Alpha 按「SrcAlpha / OneMinusSrcAlpha」合成。
   * 等价颜色：result = src * srcAlpha + dst * (1 - srcAlpha)（分量级 clamp 由 GPU 完成）。
   */
  readonly alphaBlend: GPUBlendState;
  /**
   * 预乘 Alpha 混合：片元颜色已乘过 alpha，源因子为 One，目标为 OneMinusSrcAlpha。
   * 等价颜色：result = src * 1 + dst * (1 - srcAlpha)。
   */
  readonly premultipliedAlpha: GPUBlendState;
  /**
   * 加法混合：源与目标均满强度相加，常用于光晕、粒子。
   * 等价颜色：result = src * 1 + dst * 1。
   */
  readonly additive: GPUBlendState;
  /**
   * 乘法混合：逐分量相乘，用于变暗、阴影叠色。
   * 等价颜色：result = src * dst + dst * 0（即 src * dst）。
   */
  readonly multiply: GPUBlendState;
  /**
   * Screen（滤色）：亮化叠加，经典公式 1 - (1-src)(1-dst)。
   * 等价颜色：result = src * (1 - dst) + dst * 1。
   */
  readonly screen: GPUBlendState;
  /**
   * 模板/深度优先 Pass 的混合占位：源因子为 Zero，目标为 One，颜色保持不变。
   * 与 `colorWriteMask: 0` 一起使用时不写入颜色附件；此处仍提供合法 GPUBlendState 以便复用管线布局。
   */
  readonly stencilOnly: GPUBlendState;
  /**
   * 按给定因子与方程构造自定义混合状态；参数非法时抛出带说明的 TypeError。
   *
   * @param colorSrc - 颜色分量的源因子（GPUBlendFactor）
   * @param colorDst - 颜色分量的目标因子
   * @param colorOp - 颜色分量的混合运算（加/减/min/max）
   * @param alphaSrc - Alpha 分量的源因子
   * @param alphaDst - Alpha 分量的目标因子
   * @param alphaOp - Alpha 分量的混合运算
   * @returns 同时包含 `color` 与 `alpha` 的 `GPUBlendState`
   *
   * @example
   * const presets = createBlendPresets();
   * const sameAsAlpha = presets.custom(
   *   'src-alpha', 'one-minus-src-alpha', 'add',
   *   'one', 'one-minus-src-alpha', 'add',
   * );
   */
  custom(
    colorSrc: GPUBlendFactor,
    colorDst: GPUBlendFactor,
    colorOp: GPUBlendOperation,
    alphaSrc: GPUBlendFactor,
    alphaDst: GPUBlendFactor,
    alphaOp: GPUBlendOperation,
  ): GPUBlendState;
}

/**
 * WebGPU 规范定义的 `GPUBlendFactor` 全集，用于运行时校验（防止字符串拼写错误或非规范值）。
 * 来源：W3C WebGPU — GPUBlendFactor 枚举字符串。
 */
const VALID_BLEND_FACTORS: readonly GPUBlendFactor[] = [
  'zero',
  'one',
  'src',
  'one-minus-src',
  'src-alpha',
  'one-minus-src-alpha',
  'dst',
  'one-minus-dst',
  'dst-alpha',
  'one-minus-dst-alpha',
  'src-alpha-saturated',
  'constant',
  'one-minus-constant',
  'src1',
  'one-minus-src1',
  'src1-alpha',
  'one-minus-src1-alpha',
];

/**
 * 将合法混合因子放入 Set，便于 O(1) 校验。
 * 在模块加载时构建一次，避免每次 custom 调用重复分配。
 */
const VALID_BLEND_FACTOR_SET: ReadonlySet<string> = new Set(VALID_BLEND_FACTORS);

/**
 * WebGPU 规范定义的 `GPUBlendOperation` 全集。
 */
const VALID_BLEND_OPERATIONS: readonly GPUBlendOperation[] = [
  'add',
  'subtract',
  'reverse-subtract',
  'min',
  'max',
];

/**
 * 合法混合运算集合，用于校验。
 */
const VALID_BLEND_OPERATION_SET: ReadonlySet<string> = new Set(VALID_BLEND_OPERATIONS);

/**
 * 校验单个 `GPUBlendFactor` 是否为规范字符串；失败时抛出 TypeError（带参数名与允许列表）。
 *
 * @param parameterName - 形参名，便于调用方定位（如 `colorSrc`）
 * @param value - 待校验因子
 * @returns void
 *
 * @example
 * validateBlendFactorParameter('colorSrc', 'src-alpha'); // 正常返回
 * // validateBlendFactorParameter('colorSrc', 'not-a-factor'); // 抛出 TypeError
 */
function validateBlendFactorParameter(parameterName: string, value: GPUBlendFactor): void {
  // 运行时可能收到绕过类型检查的任意值，先做 typeof 防护
  if (typeof value !== 'string') {
    throw new TypeError(
      `BlendPresets.custom(): "${parameterName}" must be a GPUBlendFactor string, got ${typeof value}.`,
    );
  }
  // 再用规范集合校验，避免静默接受非法枚举字符串
  if (!VALID_BLEND_FACTOR_SET.has(value)) {
    throw new TypeError(
      `BlendPresets.custom(): invalid GPUBlendFactor for "${parameterName}": "${value}". ` +
        `Expected one of: ${VALID_BLEND_FACTORS.join(', ')}.`,
    );
  }
}

/**
 * 校验单个 `GPUBlendOperation` 是否为规范字符串。
 *
 * @param parameterName - 形参名（如 `colorOp`）
 * @param value - 待校验运算
 * @returns void
 *
 * @example
 * validateBlendOperationParameter('colorOp', 'add');
 */
function validateBlendOperationParameter(parameterName: string, value: GPUBlendOperation): void {
  // 与因子校验一致，先排除非字符串
  if (typeof value !== 'string') {
    throw new TypeError(
      `BlendPresets.custom(): "${parameterName}" must be a GPUBlendOperation string, got ${typeof value}.`,
    );
  }
  // 非法运算会导致管线创建失败，此处提前报错更易调试
  if (!VALID_BLEND_OPERATION_SET.has(value)) {
    throw new TypeError(
      `BlendPresets.custom(): invalid GPUBlendOperation for "${parameterName}": "${value}". ` +
        `Expected one of: ${VALID_BLEND_OPERATIONS.join(', ')}.`,
    );
  }
}

/**
 * 由颜色与 alpha 两组分量构造完整 `GPUBlendState`（浅拷贝新对象，避免被调用方误改内部共享引用）。
 *
 * @param color - 颜色分量混合配置
 * @param alpha - alpha 分量混合配置
 * @returns 新的 `GPUBlendState`
 *
 * @example
 * const state = createBlendStateFromComponents(
 *   { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
 *   { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
 * );
 */
function createBlendStateFromComponents(
  color: GPUBlendComponent,
  alpha: GPUBlendComponent,
): GPUBlendState {
  // 展开写入新对象，保证与预设表互不共享引用
  return {
    color: {
      srcFactor: color.srcFactor,
      dstFactor: color.dstFactor,
      operation: color.operation,
    },
    alpha: {
      srcFactor: alpha.srcFactor,
      dstFactor: alpha.dstFactor,
      operation: alpha.operation,
    },
  };
}

/**
 * 创建 BlendPresets 实例：包含常用混合模式与 `custom` 校验工厂。
 *
 * @returns 实现了 `BlendPresets` 的新对象（每次调用返回新实例，无全局可变单例）
 *
 * @example
 * const bp = createBlendPresets();
 * const desc: GPUColorTargetState = {
 *   format: 'bgra8unorm',
 *   blend: bp.premultipliedAlpha,
 *   writeMask: GPUColorWrite.ALL,
 * };
 */
export function createBlendPresets(): BlendPresets {
  // 标准 alpha：RGB 用 SrcAlpha / OneMinusSrcAlpha；Alpha 通道同步累积以匹配非预乘纹理输出
  const alphaBlend = createBlendStateFromComponents(
    {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
    {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
  );

  // 预乘：源用 One，目标用 OneMinusSrcAlpha，与 MSDF/预乘 PNG 一致
  const premultipliedAlpha = createBlendStateFromComponents(
    {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
    {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
  );

  // 加法：双 One，注意易饱和，多用于 HDR 或带 clamp 的特效
  const additive = createBlendStateFromComponents(
    {
      srcFactor: 'one',
      dstFactor: 'one',
      operation: 'add',
    },
    {
      srcFactor: 'one',
      dstFactor: 'one',
      operation: 'add',
    },
  );

  // 乘法：源乘目标颜色，目标因子 Zero 消去第二项
  const multiply = createBlendStateFromComponents(
    {
      srcFactor: 'dst',
      dstFactor: 'zero',
      operation: 'add',
    },
    {
      srcFactor: 'dst-alpha',
      dstFactor: 'zero',
      operation: 'add',
    },
  );

  // Screen：result = src * (1 - dst) + dst * 1；RGB 与 A 分量均对「当前分量」的 dst 取 OneMinusDst
  const screen = createBlendStateFromComponents(
    {
      srcFactor: 'one-minus-dst',
      dstFactor: 'one',
      operation: 'add',
    },
    {
      srcFactor: 'one-minus-dst',
      dstFactor: 'one',
      operation: 'add',
    },
  );

  // 源贡献为 0、保留目标：等价于不在数学上改变 RT；配合 writeMask 0 实现「只模板/深度」
  const stencilOnly = createBlendStateFromComponents(
    {
      srcFactor: 'zero',
      dstFactor: 'one',
      operation: 'add',
    },
    {
      srcFactor: 'zero',
      dstFactor: 'one',
      operation: 'add',
    },
  );

  /**
   * 校验全部参数并构造自定义混合状态。
   *
   * @param colorSrc - 颜色源因子
   * @param colorDst - 颜色目标因子
   * @param colorOp - 颜色混合运算
   * @param alphaSrc - alpha 源因子
   * @param alphaDst - alpha 目标因子
   * @param alphaOp - alpha 混合运算
   * @returns 校验通过后的 `GPUBlendState`
   *
   * @example
   * custom('src-alpha', 'one-minus-src-alpha', 'add', 'one', 'one-minus-src-alpha', 'add');
   */
  function custom(
    colorSrc: GPUBlendFactor,
    colorDst: GPUBlendFactor,
    colorOp: GPUBlendOperation,
    alphaSrc: GPUBlendFactor,
    alphaDst: GPUBlendFactor,
    alphaOp: GPUBlendOperation,
  ): GPUBlendState {
    // 按顺序校验，错误信息顺序与参数列表一致，便于排查
    validateBlendFactorParameter('colorSrc', colorSrc);
    validateBlendFactorParameter('colorDst', colorDst);
    validateBlendOperationParameter('colorOp', colorOp);
    validateBlendFactorParameter('alphaSrc', alphaSrc);
    validateBlendFactorParameter('alphaDst', alphaDst);
    validateBlendOperationParameter('alphaOp', alphaOp);

    // 校验通过后组装分量；使用辅助函数保持与内置预设相同的对象形状
    return createBlendStateFromComponents(
      {
        srcFactor: colorSrc,
        dstFactor: colorDst,
        operation: colorOp,
      },
      {
        srcFactor: alphaSrc,
        dstFactor: alphaDst,
        operation: alphaOp,
      },
    );
  }

  // 返回字面量对象，opaque 显式 undefined 以匹配「无混合」管线描述
  return {
    opaque: undefined,
    alphaBlend,
    premultipliedAlpha,
    additive,
    multiply,
    screen,
    stencilOnly,
    custom,
  };
}
