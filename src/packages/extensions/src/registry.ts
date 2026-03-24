// ============================================================
// L5 extensions — ExtensionRegistry：六类扩展点统一注册表
// 依赖：无（零 npm）；错误模型与 GeoForge 结构化错误对齐
// ============================================================

/**
 * 扩展点类型：六类扩展与 EP1~EP6 一一对应（layer / projection / source / shaderHook / postProcess / interaction）。
 */
export type ExtensionType =
  | 'layer'
  | 'projection'
  | 'source'
  | 'shaderHook'
  | 'postProcess'
  | 'interaction';

/**
 * 已注册扩展的元信息摘要，用于列举与事件通知（不含具体工厂实现）。
 */
export interface ExtensionInfo {
  /**
   * 扩展所属类型（决定从哪张内部 Map 查找）。
   */
  readonly type: ExtensionType;

  /**
   * 扩展唯一标识（在同一 type 域内唯一）。
   */
  readonly id: string;

  /**
   * 扩展自声明版本（semver 字符串，可选）。
   */
  readonly version?: string;

  /**
   * 扩展声明的引擎兼容版本范围（semver range 字符串，可选）。
   */
  readonly engineVersionRange?: string;

  /**
   * 注册时间戳（毫秒，来自 `Date.now()`）。
   */
  readonly registeredAt: number;
}

/**
 * 扩展作者提供的可选元数据（随 register* 一并存储）。
 */
export interface ExtensionMeta {
  /**
   * 扩展包版本（semver，可选）。
   */
  readonly version?: string;

  /**
   * 兼容的 GeoForge 引擎版本范围（semver range，可选）。
   */
  readonly engineVersionRange?: string;

  /**
   * 人类可读描述（可选）。
   */
  readonly description?: string;

  /**
   * 作者名或组织（可选）。
   */
  readonly author?: string;
}

/**
 * 单条注册项：保存工厂/模块引用与注册时刻，供列举与元数据展示。
 */
interface RegistryEntry {
  /**
   * 注册的实现：图层工厂、投影模块、Hook 对象等（由调用方解释）。
   */
  readonly payload: unknown;

  /**
   * 调用方传入的元数据（可选）。
   */
  readonly meta: ExtensionMeta | undefined;

  /**
   * `Date.now()` 记录注册时间，用于审计与排序。
   */
  readonly registeredAt: number;
}

/**
 * GeoForge 扩展层结构化错误：携带机器可读错误码与可选上下文。
 *
 * @example
 * throw new GeoForgeError('EXT_REGISTRY_INVALID_ID', 'extension id must be non-empty', { id: '' });
 */
export class GeoForgeError extends Error {
  /**
   * 机器可读错误码（大写 SNAKE_CASE）。
   */
  public readonly code: string;

  /**
   * 可选调试上下文（禁止存放敏感信息）。
   */
  public readonly context?: Readonly<Record<string, unknown>>;

  /**
   * @param code - 错误码
   * @param message - 人类可读说明
   * @param context - 可选上下文
   */
  public constructor(code: string, message: string, context?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'GeoForgeError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, GeoForgeError.prototype);
  }
}

/**
 * 统一扩展注册表：六张 Map + 事件订阅，支持按类型列举与注销。
 */
export interface ExtensionRegistry {
  /**
   * 注册自定义图层工厂。
   *
   * @param id - 图层类型 id（非空字符串）
   * @param factory - 图层工厂函数或构造器（由上层解释）
   * @param meta - 可选元数据
   */
  registerLayer(id: string, factory: any, meta?: ExtensionMeta): void;

  /**
   * 注册自定义投影模块。
   *
   * @param id - 投影 id
   * @param module - 投影模块对象或工厂
   * @param meta - 可选元数据
   */
  registerProjection(id: string, module: any, meta?: ExtensionMeta): void;

  /**
   * 注册数据源工厂。
   *
   * @param id - 数据源类型 id
   * @param factory - 数据源工厂
   * @param meta - 可选元数据
   */
  registerSource(id: string, factory: any, meta?: ExtensionMeta): void;

  /**
   * 注册 Shader Hook（可带 `hookPoint` 字段供筛选）。
   *
   * @param id - Hook id
   * @param hook - Hook 定义（对象或函数）
   * @param meta - 可选元数据
   */
  registerShaderHook(id: string, hook: any, meta?: ExtensionMeta): void;

  /**
   * 注册后处理 Pass 工厂。
   *
   * @param id - 后处理 id
   * @param factory - 工厂函数
   * @param meta - 可选元数据
   */
  registerPostProcess(id: string, factory: any, meta?: ExtensionMeta): void;

  /**
   * 注册交互扩展工厂。
   *
   * @param id - 交互扩展 id
   * @param factory - 工厂函数
   * @param meta - 可选元数据
   */
  registerInteraction(id: string, factory: any, meta?: ExtensionMeta): void;

  /**
   * 按 id 获取已注册图层工厂。
   *
   * @param id - 图层 id
   * @returns 工厂或 `undefined`
   */
  getLayer(id: string): any | undefined;

  /**
   * 按 id 获取投影模块。
   *
   * @param id - 投影 id
   * @returns 模块或 `undefined`
   */
  getProjection(id: string): any | undefined;

  /**
   * 按 id 获取数据源工厂。
   *
   * @param id - 数据源 id
   * @returns 工厂或 `undefined`
   */
  getSource(id: string): any | undefined;

  /**
   * 按 id 获取后处理工厂。
   *
   * @param id - 后处理 id
   * @returns 工厂或 `undefined`
   */
  getPostProcess(id: string): any | undefined;

  /**
   * 按 id 获取交互扩展工厂。
   *
   * @param id - 交互 id
   * @returns 工厂或 `undefined`
   */
  getInteraction(id: string): any | undefined;

  /**
   * 按 id 获取 Shader Hook。
   *
   * @param id - Hook id
   * @returns Hook 或 `undefined`
   */
  getShaderHook(id: string): any | undefined;

  /**
   * 列出 Shader Hook；可按 `hook.hookPoint` 过滤。
   *
   * @param hookPoint - 若提供，仅返回 `hookPoint` 匹配的项
   * @returns Hook 数组（可能为空）
   */
  getShaderHooks(hookPoint?: string): any[];

  /**
   * 列出当前所有已注册扩展的摘要信息。
   *
   * @returns `ExtensionInfo` 数组
   */
  listAll(): ExtensionInfo[];

  /**
   * 按类型列出已注册扩展。
   *
   * @param type - 扩展类型
   * @returns 该类型下所有 `ExtensionInfo`
   */
  listByType(type: ExtensionType): ExtensionInfo[];

  /**
   * 注销指定扩展。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns 是否确实删除了条目
   */
  unregister(type: ExtensionType, id: string): boolean;

  /**
   * 批量注销；不传 type 时清空全部六类。
   *
   * @param type - 可选，限定类型
   */
  unregisterAll(type?: ExtensionType): void;

  /**
   * 判断是否已注册某扩展。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns 是否已注册
   */
  has(type: ExtensionType, id: string): boolean;

  /**
   * 订阅注册/注销事件。
   *
   * @param event - `'registered'` 或 `'unregistered'`
   * @param callback - 接收 `ExtensionInfo` 的回调
   * @returns 取消订阅函数
   */
  on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void;
}

/** 注册/注销事件名（内部常量，避免魔法字符串分叉）。 */
const EVENT_REGISTERED = 'registered' as const;

/** 注销事件名。 */
const EVENT_UNREGISTERED = 'unregistered' as const;

/**
 * 校验扩展 id：必须为非空字符串，否则抛出结构化错误。
 *
 * @param id - 待校验 id
 * @param label - 错误上下文字段名（用于 context）
 * @throws {GeoForgeError} 当 id 非法时
 * @returns 无（通过则正常返回）
 *
 * @example
 * assertValidExtensionId('my-layer', 'id');
 */
function assertValidExtensionId(id: string, label: string): void {
  // 拒绝非 string，避免静默接受 number/object
  if (typeof id !== 'string') {
    throw new GeoForgeError('EXT_REGISTRY_INVALID_ID', 'extension id must be a string', { [label]: id });
  }
  // 空串无法作为稳定键，直接拒绝
  if (id.length === 0) {
    throw new GeoForgeError('EXT_REGISTRY_INVALID_ID', 'extension id must be non-empty', { [label]: id });
  }
}

/**
 * 由 `RegistryEntry` 与类型、id 组装对外 `ExtensionInfo`。
 *
 * @param type - 扩展类型
 * @param id - 扩展 id
 * @param entry - 内部存储项
 * @returns 只读 `ExtensionInfo`
 *
 * @example
 * const info = toExtensionInfo('layer', 'x', { payload: f, meta: { version: '1.0.0' }, registeredAt: 0 });
 */
function toExtensionInfo(type: ExtensionType, id: string, entry: RegistryEntry): ExtensionInfo {
  // 从 meta 提取版本字段，缺失则保持 undefined（符合 ExtensionInfo 可选语义）
  const version = entry.meta?.version;
  const engineVersionRange = entry.meta?.engineVersionRange;
  return {
    type,
    id,
    version,
    engineVersionRange,
    registeredAt: entry.registeredAt,
  };
}

/**
 * 从任意值上读取可选的 `hookPoint`（用于 Shader Hook 过滤）。
 *
 * @param value - Hook 对象或其它
 * @returns 若为对象且带有字符串 `hookPoint` 则返回该字符串，否则 `undefined`
 *
 * @example
 * readHookPoint({ hookPoint: 'vertex' }); // 'vertex'
 */
function readHookPoint(value: unknown): string | undefined {
  // null / 原始类型无属性可读
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  // 仅接受自身属性上的 string hookPoint，避免原型链污染误判
  const raw = (value as Record<string, unknown>).hookPoint;
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  return raw;
}

/**
 * 创建空 Map 存储某一类扩展（工厂与元数据）。
 *
 * @returns 新的 `Map<string, RegistryEntry>`
 *
 * @example
 * const m = createRegistryMap();
 */
function createRegistryMap(): Map<string, RegistryEntry> {
  return new Map<string, RegistryEntry>();
}

/**
 * 构造统一扩展注册表实现。
 *
 * @returns 满足 `ExtensionRegistry` 接口的实例
 *
 * @example
 * const reg = createExtensionRegistry();
 * reg.registerLayer('custom', () => ({}), { version: '1.0.0' });
 */
export function createExtensionRegistry(): ExtensionRegistry {
  // 六类扩展各用独立 Map，避免 id 跨类型意外覆盖
  const layers = createRegistryMap();
  const projections = createRegistryMap();
  const sources = createRegistryMap();
  const shaderHooks = createRegistryMap();
  const postProcesses = createRegistryMap();
  const interactions = createRegistryMap();

  // 事件订阅使用 Set，便于 O(1) 增删
  const registeredListeners = new Set<(info: ExtensionInfo) => void>();
  const unregisteredListeners = new Set<(info: ExtensionInfo) => void>();

  /**
   * 按类型选取目标 Map（内部查表，集中分支）。
   *
   * @param type - 扩展类型
   * @returns 对应 Map 引用
   *
   * @example
   * const m = mapForType('layer'); // layers Map
   */
  function mapForType(type: ExtensionType): Map<string, RegistryEntry> {
    switch (type) {
      case 'layer':
        return layers;
      case 'projection':
        return projections;
      case 'source':
        return sources;
      case 'shaderHook':
        return shaderHooks;
      case 'postProcess':
        return postProcesses;
      case 'interaction':
        return interactions;
      default: {
        // 穷尽分支后不应到达；防御性处理未知 future 值
        const _exhaustive: never = type;
        throw new GeoForgeError('EXT_REGISTRY_UNKNOWN_TYPE', 'unknown extension type', { type: _exhaustive });
      }
    }
  }

  /**
   * 将一条注册写入 Map 并触发 `registered` 事件。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @param payload - 工厂或模块
   * @param meta - 可选元数据
   *
   * @example
   * registerEntry('layer', 'foo', () => ({}), { version: '1.0.0' });
   */
  function registerEntry(type: ExtensionType, id: string, payload: any, meta?: ExtensionMeta): void {
    assertValidExtensionId(id, 'id');
    const map = mapForType(type);
    const registeredAt = Date.now();
    const entry: RegistryEntry = { payload, meta, registeredAt };
    // 覆盖同名 id（幂等重注册），更新 registeredAt 便于观测热更新
    map.set(id, entry);
    const info = toExtensionInfo(type, id, entry);
    // 广播给所有监听者；单监听内异常不应拖垮其它监听
    for (const cb of registeredListeners) {
      try {
        cb(info);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        // 无法使用 InternalBus 时至少避免静默失败：控制台可观测
        console.error('[ExtensionRegistry] registered listener error', normalized);
      }
    }
  }

  /**
   * 读取单条注册项中的 payload。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns payload 或 undefined
   *
   * @example
   * const f = getPayload('layer', 'roads');
   */
  function getPayload(type: ExtensionType, id: string): any | undefined {
    // 读取侧同样校验 id，避免 Map 键被异常值污染（与 register 对称）
    try {
      assertValidExtensionId(id, 'id');
    } catch {
      return undefined;
    }
    const entry = mapForType(type).get(id);
    return entry?.payload;
  }

  /**
   * 将某一 Map 的全部条目展开为 `ExtensionInfo[]`。
   *
   * @param type - 扩展类型
   * @param map - 该类型对应的 Map
   * @returns 列表
   *
   * @example
   * const infos = listFromMap('source', sources);
   */
  function listFromMap(type: ExtensionType, map: Map<string, RegistryEntry>): ExtensionInfo[] {
    const out: ExtensionInfo[] = [];
    // 遍历顺序依赖 Map 插入序；对确定性测试可接受
    map.forEach((entry, id) => {
      out.push(toExtensionInfo(type, id, entry));
    });
    return out;
  }

  /**
   * 触发 `unregistered` 事件。
   *
   * @param info - 被移除扩展的摘要（移除前快照）
   *
   * @example
   * emitUnregistered({ type: 'layer', id: 'x', registeredAt: 0 });
   */
  function emitUnregistered(info: ExtensionInfo): void {
    for (const cb of unregisteredListeners) {
      try {
        cb(info);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        console.error('[ExtensionRegistry] unregistered listener error', normalized);
      }
    }
  }

  const api: ExtensionRegistry = {
    registerLayer(id: string, factory: any, meta?: ExtensionMeta): void {
      registerEntry('layer', id, factory, meta);
    },

    registerProjection(id: string, module: any, meta?: ExtensionMeta): void {
      registerEntry('projection', id, module, meta);
    },

    registerSource(id: string, factory: any, meta?: ExtensionMeta): void {
      registerEntry('source', id, factory, meta);
    },

    registerShaderHook(id: string, hook: any, meta?: ExtensionMeta): void {
      registerEntry('shaderHook', id, hook, meta);
    },

    registerPostProcess(id: string, factory: any, meta?: ExtensionMeta): void {
      registerEntry('postProcess', id, factory, meta);
    },

    registerInteraction(id: string, factory: any, meta?: ExtensionMeta): void {
      registerEntry('interaction', id, factory, meta);
    },

    getLayer(id: string): any | undefined {
      return getPayload('layer', id);
    },

    getProjection(id: string): any | undefined {
      return getPayload('projection', id);
    },

    getSource(id: string): any | undefined {
      return getPayload('source', id);
    },

    getPostProcess(id: string): any | undefined {
      return getPayload('postProcess', id);
    },

    getInteraction(id: string): any | undefined {
      return getPayload('interaction', id);
    },

    getShaderHook(id: string): any | undefined {
      return getPayload('shaderHook', id);
    },

    getShaderHooks(hookPoint?: string): any[] {
      const hooks: any[] = [];
      shaderHooks.forEach((entry) => {
        hooks.push(entry.payload);
      });
      // 未指定 hookPoint 时返回全部 payload 的浅表副本（数组为新数组）
      if (hookPoint === undefined || hookPoint === null) {
        return hooks.slice();
      }
      // 指定 hookPoint 时：过滤出 hookPoint 匹配的项（严格相等）
      if (typeof hookPoint !== 'string') {
        return [];
      }
      return hooks.filter((h) => readHookPoint(h) === hookPoint);
    },

    listAll(): ExtensionInfo[] {
      // 聚合六类；顺序：layer → … → interaction（稳定、可文档化）
      return [
        ...listFromMap('layer', layers),
        ...listFromMap('projection', projections),
        ...listFromMap('source', sources),
        ...listFromMap('shaderHook', shaderHooks),
        ...listFromMap('postProcess', postProcesses),
        ...listFromMap('interaction', interactions),
      ];
    },

    listByType(type: ExtensionType): ExtensionInfo[] {
      return listFromMap(type, mapForType(type));
    },

    unregister(type: ExtensionType, id: string): boolean {
      try {
        assertValidExtensionId(id, 'id');
      } catch {
        return false;
      }
      const map = mapForType(type);
      const prev = map.get(id);
      // 无条目则无需触发事件
      if (!prev) {
        return false;
      }
      const info = toExtensionInfo(type, id, prev);
      map.delete(id);
      emitUnregistered(info);
      return true;
    },

    unregisterAll(type?: ExtensionType): void {
      // 未指定类型：依次清空六张 Map
      if (type === undefined) {
        const allTypes: ExtensionType[] = [
          'layer',
          'projection',
          'source',
          'shaderHook',
          'postProcess',
          'interaction',
        ];
        for (const t of allTypes) {
          api.unregisterAll(t);
        }
        return;
      }
      // 指定类型：逐项删除以复用 unregister 的事件语义
      const ids = [...mapForType(type).keys()];
      for (const id of ids) {
        api.unregister(type, id);
      }
    },

    has(type: ExtensionType, id: string): boolean {
      try {
        assertValidExtensionId(id, 'id');
      } catch {
        return false;
      }
      return mapForType(type).has(id);
    },

    on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void {
      // 回调必须可调用，否则后续 emit 会抛错
      if (typeof callback !== 'function') {
        throw new GeoForgeError('EXT_REGISTRY_LISTENER_INVALID', 'callback must be a function', { event });
      }
      if (event === EVENT_REGISTERED) {
        registeredListeners.add(callback);
        return () => {
          registeredListeners.delete(callback);
        };
      }
      if (event === EVENT_UNREGISTERED) {
        unregisteredListeners.add(callback);
        return () => {
          unregisteredListeners.delete(callback);
        };
      }
      throw new GeoForgeError('EXT_REGISTRY_EVENT_UNKNOWN', 'event must be registered or unregistered', { event });
    },
  };

  return api;
}
