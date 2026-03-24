// ============================================================
// layer-plugin.ts — L4 LayerPlugin：图层自描述注册协议
// 零 npm 依赖；与 LayerManager / WorkerPool 集成由上层完成。
// ============================================================

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

/**
 * PluginRegistry 子集错误码。
 */
export const LayerPluginErrorCode = {
  /** 插件缺少必填字段或类型不对。 */
  CONFIG_INVALID_PLUGIN: 'CONFIG_INVALID_PLUGIN',
  /** unregister 的 type 非法。 */
  CONFIG_INVALID_TYPE: 'CONFIG_INVALID_TYPE',
} as const;

/**
 * {@link LayerPluginErrorCode} 联合类型。
 */
export type LayerPluginErrorCode = (typeof LayerPluginErrorCode)[keyof typeof LayerPluginErrorCode];

/**
 * L4 图层插件注册表抛出的结构化错误。
 */
export class LayerPluginError extends Error {
  /** 错误码。 */
  public readonly code: LayerPluginErrorCode;

  /** 诊断上下文。 */
  public readonly context?: Record<string, unknown>;

  /**
   * @param code - 错误码
   * @param message - 说明
   * @param context - 可选上下文
   * @param cause - 可选原因
   */
  constructor(
    code: LayerPluginErrorCode,
    message: string,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'LayerPluginError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, LayerPluginError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/**
 * 图层插件：自描述 worker/shader/compute 与工厂方法。
 */
export interface LayerPlugin {
  /** 插件类型键（与 LayerSpec.type 对齐）。 */
  readonly type: string;
  /** 可选 Worker 任务列表。 */
  readonly workerTasks?: Array<{ type: string; handler: string }>;
  /** 可选 Shader 模块列表。 */
  readonly shaderModules?: Array<{ type: string; id: string; wgslCode: string }>;
  /** 可选 Compute 任务名字符串列表。 */
  readonly computeTasks?: string[];
  /**
   * 由 LayerManager 调用以实例化具体图层。
   *
   * @param spec - 图层规格（来源自样式 JSON）
   * @param context - 引擎注入上下文（LayerContext 等）
   * @returns 图层实例（具体类型由插件决定）
   */
  createLayer(spec: any, context: any): any;
}

/**
 * 插件注册表：按 type 唯一注册。
 */
export interface PluginRegistry {
  /**
   * 注册插件；同 type 重复注册将覆盖旧值。
   *
   * @param plugin - 插件定义
   */
  registerPlugin(plugin: LayerPlugin): void;
  /**
   * 按类型查询插件。
   *
   * @param type - 类型键
   */
  getPlugin(type: string): LayerPlugin | undefined;
  /**
   * 列出当前已注册的全部插件（顺序不保证）。
   */
  listPlugins(): LayerPlugin[];
  /**
   * 按类型注销插件。
   *
   * @param type - 类型键
   * @returns 是否确实删除了已存在项
   */
  unregisterPlugin(type: string): boolean;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验插件对象是否包含必填字段与可调用工厂。
 *
 * @param plugin - 待校验插件
 *
 * @example
 * assertValidPlugin({ type: 'fill', createLayer: () => ({}) });
 */
function assertValidPlugin(plugin: LayerPlugin): void {
  if (plugin === null || plugin === undefined || typeof plugin !== 'object') {
    throw new LayerPluginError(LayerPluginErrorCode.CONFIG_INVALID_PLUGIN, 'plugin 必须为非空对象', {
      plugin,
    });
  }

  if (typeof plugin.type !== 'string' || plugin.type.length === 0) {
    throw new LayerPluginError(
      LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
      'plugin.type 必须为非空字符串',
      { type: plugin.type },
    );
  }

  if (typeof plugin.createLayer !== 'function') {
    throw new LayerPluginError(
      LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
      'plugin.createLayer 必须为函数',
      { createLayer: plugin.createLayer },
    );
  }

  if (plugin.workerTasks !== undefined) {
    if (!Array.isArray(plugin.workerTasks)) {
      throw new LayerPluginError(
        LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
        'plugin.workerTasks 若存在则必须为数组',
        {},
      );
    }
    for (let i = 0; i < plugin.workerTasks.length; i++) {
      const t = plugin.workerTasks[i];
      if (t === undefined || typeof t !== 'object') {
        throw new LayerPluginError(LayerPluginErrorCode.CONFIG_INVALID_PLUGIN, `workerTasks[${i}] 非法`, {
          i,
        });
      }
      if (typeof t.type !== 'string' || t.type.length === 0) {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `workerTasks[${i}].type 必须为非空字符串`,
          {},
        );
      }
      if (typeof t.handler !== 'string' || t.handler.length === 0) {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `workerTasks[${i}].handler 必须为非空字符串`,
          {},
        );
      }
    }
  }

  if (plugin.shaderModules !== undefined) {
    if (!Array.isArray(plugin.shaderModules)) {
      throw new LayerPluginError(
        LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
        'plugin.shaderModules 若存在则必须为数组',
        {},
      );
    }
    for (let i = 0; i < plugin.shaderModules.length; i++) {
      const m = plugin.shaderModules[i];
      if (m === undefined || typeof m !== 'object') {
        throw new LayerPluginError(LayerPluginErrorCode.CONFIG_INVALID_PLUGIN, `shaderModules[${i}] 非法`, {
          i,
        });
      }
      if (typeof m.type !== 'string' || m.type.length === 0) {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `shaderModules[${i}].type 必须为非空字符串`,
          {},
        );
      }
      if (typeof m.id !== 'string' || m.id.length === 0) {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `shaderModules[${i}].id 必须为非空字符串`,
          {},
        );
      }
      if (typeof m.wgslCode !== 'string') {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `shaderModules[${i}].wgslCode 必须为字符串`,
          {},
        );
      }
    }
  }

  if (plugin.computeTasks !== undefined) {
    if (!Array.isArray(plugin.computeTasks)) {
      throw new LayerPluginError(
        LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
        'plugin.computeTasks 若存在则必须为数组',
        {},
      );
    }
    for (let i = 0; i < plugin.computeTasks.length; i++) {
      const c = plugin.computeTasks[i];
      if (typeof c !== 'string' || c.length === 0) {
        throw new LayerPluginError(
          LayerPluginErrorCode.CONFIG_INVALID_PLUGIN,
          `computeTasks[${i}] 必须为非空字符串`,
          { i, c },
        );
      }
    }
  }
}

/**
 * 校验 type 字符串用于查询/注销。
 *
 * @param type - 类型键
 */
function assertValidTypeKey(type: string): void {
  if (typeof type !== 'string' || type.length === 0) {
    throw new LayerPluginError(LayerPluginErrorCode.CONFIG_INVALID_TYPE, 'type 必须为非空字符串', {
      type,
    });
  }
}

/**
 * 创建插件注册表实例。
 *
 * @returns PluginRegistry
 *
 * @example
 * const reg = createPluginRegistry();
 * reg.registerPlugin({ type: 'fill', createLayer: () => ({}) });
 * console.log(reg.getPlugin('fill') !== undefined);
 */
export function createPluginRegistry(): PluginRegistry {
  // 使用 Map 保持插入顺序可预测（与规范一致：按 type 索引）
  const store = new Map<string, LayerPlugin>();

  const registry: PluginRegistry = {
    registerPlugin(plugin: LayerPlugin): void {
      assertValidPlugin(plugin);
      // 覆盖策略：后注册者胜，便于热替换开发插件
      store.set(plugin.type, plugin);
    },

    getPlugin(type: string): LayerPlugin | undefined {
      assertValidTypeKey(type);
      return store.get(type);
    },

    listPlugins(): LayerPlugin[] {
      // 返回浅拷贝数组，避免调用方 mutates Map 的引用
      return Array.from(store.values());
    },

    unregisterPlugin(type: string): boolean {
      assertValidTypeKey(type);
      return store.delete(type);
    },
  };

  return registry;
}
