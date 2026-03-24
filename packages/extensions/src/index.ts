/**
 * @file GeoForge L5 — Extensions 层入口（Registry + Lifecycle + 初始化）
 *
 * @description
 * 本文件实现 **ExtensionRegistry**（EP1~EP6 统一注册表）与 **ExtensionLifecycle**（实例状态、
 * `safeExecute` 错误隔离、连续失败禁用）。`initializeL5()` 返回引擎装配所需的最小上下文。
 * 具体 EP 契约见同目录 `custom-*.ts` / `shader-hook.ts`。
 */

import type { CustomLayerFactory } from './custom-layer.ts';
import type { DataSourceFactory } from './custom-source.ts';
import type { InteractionManager, InteractionToolFactory } from './custom-interaction.ts';
import type { PostProcessPassFactory } from './custom-postprocess.ts';
import type { ProjectionModule } from './custom-projection.ts';
import type { ShaderHookDefinition, ShaderHookPoint } from './shader-hook.ts';

import { createInteractionManager } from './custom-interaction.ts';

/**
 * 可注册扩展类别（与 EP1~EP6 一一对应）。
 */
export type ExtensionType =
  | 'layer'
  | 'projection'
  | 'source'
  | 'shaderHook'
  | 'postProcess'
  | 'interaction';

/**
 * 注册时可选的元数据（版本、作者、兼容性声明）。
 */
export interface ExtensionMeta {
  /** 扩展自身 semver 字符串。 */
  readonly version?: string;
  /** 兼容引擎版本范围（如 `>=1.0.0 <2.0.0`），解析失败时 `checkCompatibility` 标记不兼容。 */
  readonly engineVersionRange?: string;
  /** 一句话描述。 */
  readonly description?: string;
  /** 维护者或组织名。 */
  readonly author?: string;
}

/**
 * 注册表内一条扩展的索引信息。
 */
export interface ExtensionInfo {
  /** 扩展类别。 */
  readonly type: ExtensionType;
  /** 扩展 id（用户可见）。 */
  readonly id: string;
  /** 扩展包版本。 */
  readonly version?: string;
  /** 声明的引擎兼容范围。 */
  readonly engineVersionRange?: string;
  /** 注册时间戳（`Date.now()`，毫秒）。 */
  readonly registeredAt: number;
}

/**
 * 扩展实例生命周期状态机。
 */
export type ExtensionState = 'registered' | 'initializing' | 'active' | 'error' | 'destroyed';

/**
 * 运行期跟踪的扩展实例摘要（不含具体 GPU 对象，避免泄漏引擎内部类型）。
 */
export interface ExtensionInstance {
  /** 实例 id（通常与注册 id 相同）。 */
  readonly id: string;
  /** 实例类别。 */
  readonly type: ExtensionType;
  /** 当前状态。 */
  readonly state: ExtensionState;
  /** 最近一次错误（`error` 状态时有效）。 */
  readonly error?: Error;
  /** 可选：初始化耗时（毫秒）。 */
  readonly initDurationMs?: number;
}

/**
 * L5 初始化返回的聚合上下文（供 L6 预设或集成测试持有）。
 */
export interface L5Context {
  /** 全局扩展注册表。 */
  readonly registry: ExtensionRegistry;
  /** 生命周期与错误隔离。 */
  readonly lifecycle: ExtensionLifecycle;
  /** 交互工具管理器（已与 Registry 绑定 `getInteraction`）。 */
  readonly interactionManager: InteractionManager;
}

/**
 * 统一扩展注册表接口。
 */
export interface ExtensionRegistry {
  registerLayer(id: string, factory: CustomLayerFactory, meta?: ExtensionMeta): void;
  registerProjection(id: string, module: ProjectionModule, meta?: ExtensionMeta): void;
  registerSource(id: string, factory: DataSourceFactory, meta?: ExtensionMeta): void;
  registerShaderHook(id: string, hook: ShaderHookDefinition, meta?: ExtensionMeta): void;
  registerPostProcess(id: string, factory: PostProcessPassFactory, meta?: ExtensionMeta): void;
  registerInteraction(id: string, factory: InteractionToolFactory, meta?: ExtensionMeta): void;

  getLayer(id: string): CustomLayerFactory | undefined;
  getProjection(id: string): ProjectionModule | undefined;
  getSource(id: string): DataSourceFactory | undefined;
  getPostProcess(id: string): PostProcessPassFactory | undefined;
  getInteraction(id: string): InteractionToolFactory | undefined;
  getShaderHook(id: string): ShaderHookDefinition | undefined;
  getShaderHooks(hookPoint?: ShaderHookPoint): ShaderHookDefinition[];

  listAll(): ExtensionInfo[];
  listByType(type: ExtensionType): ExtensionInfo[];

  unregister(type: ExtensionType, id: string): boolean;
  unregisterAll(type?: ExtensionType): void;

  has(type: ExtensionType, id: string): boolean;

  on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void;
}

/**
 * 扩展生命周期管理器：实例化、销毁与 `safeExecute` 隔离。
 */
export interface ExtensionLifecycle {
  instantiate(type: ExtensionType, id: string, options?: Record<string, unknown>): Promise<ExtensionInstance>;
  destroy(type: ExtensionType, id: string): void;
  destroyAll(type?: ExtensionType): void;

  getInstance(type: ExtensionType, id: string): ExtensionInstance | undefined;
  getActiveInstances(type?: ExtensionType): ExtensionInstance[];

  safeExecute<T>(extensionId: string, fn: () => T, fallback?: T): T;
  safeExecuteAsync<T>(extensionId: string, fn: () => Promise<T>, fallback?: T): Promise<T>;

  readonly maxConsecutiveErrors: number;
  setMaxConsecutiveErrors(count: number): void;

  reenable(type: ExtensionType, id: string): Promise<boolean>;

  checkCompatibility(meta: ExtensionMeta): { compatible: boolean; reason?: string };

  onStateChange(callback: (instance: ExtensionInstance, oldState: ExtensionState) => void): () => void;
  onError(callback: (extensionId: string, error: Error) => void): () => void;
}

/**
 * L5 内部结构化错误（上层可映射为统一 `GeoForgeError`）。
 */
export class L5Error extends Error {
  /** 稳定错误码。 */
  public readonly code: string;
  /** 调试上下文。 */
  public readonly context: Record<string, unknown>;

  /**
   * @param code - 机器可读码
   * @param message - 说明
   * @param context - 附加上下文
   */
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'L5Error';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, L5Error.prototype);
  }
}

/**
 * 生成注册表内部复合键，避免跨类型 id 碰撞。
 *
 * @param type - 扩展类型
 * @param id - 扩展 id
 * @returns `${type}:${id}`
 *
 * @example
 * ```ts
 * const k = registryKey('layer', 'wind');
 * console.assert(k === 'layer:wind');
 * ```
 */
function registryKey(type: ExtensionType, id: string): string {
  return `${type}:${id}`;
}

/**
 * 创建空注册表：线程安全假设为单线程主线程（WebGPU 约定）。
 *
 * @returns `ExtensionRegistry` 实现
 *
 * @example
 * ```ts
 * const r = createExtensionRegistry();
 * r.has('layer', 'x'); // false
 * ```
 */
export function createExtensionRegistry(): ExtensionRegistry {
  const layers = new Map<string, CustomLayerFactory>();
  const projections = new Map<string, ProjectionModule>();
  const sources = new Map<string, DataSourceFactory>();
  const shaderHooks = new Map<string, ShaderHookDefinition>();
  const postProcesses = new Map<string, PostProcessPassFactory>();
  const interactions = new Map<string, InteractionToolFactory>();
  const infos = new Map<string, ExtensionInfo>();

  const registeredListeners = new Set<(info: ExtensionInfo) => void>();
  const unregisteredListeners = new Set<(info: ExtensionInfo) => void>();

  const emit = (event: 'registered' | 'unregistered', info: ExtensionInfo): void => {
    const set = event === 'registered' ? registeredListeners : unregisteredListeners;
    for (const cb of set) {
      try {
        cb(info);
      } catch (err) {
        // 监听器隔离：不向外抛，避免破坏注册路径
        void err;
      }
    }
  };

  const makeInfo = (type: ExtensionType, id: string, meta?: ExtensionMeta): ExtensionInfo => {
    return {
      type,
      id,
      version: meta?.version,
      engineVersionRange: meta?.engineVersionRange,
      registeredAt: Date.now(),
    };
  };

  const registry: ExtensionRegistry = {
    registerLayer(id: string, factory: CustomLayerFactory, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerLayer: id must be non-empty', {});
      }
      const key = registryKey('layer', id.trim());
      layers.set(id.trim(), factory);
      const info = makeInfo('layer', id.trim(), meta);
      infos.set(key, info);
      emit('registered', info);
    },

    registerProjection(id: string, module: ProjectionModule, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerProjection: id must be non-empty', {});
      }
      if (!module || module.id !== id.trim()) {
        throw new L5Error('L5_REGISTRY_PROJECTION_MISMATCH', 'ProjectionModule.id must match registry id', {
          id,
        });
      }
      const key = registryKey('projection', id.trim());
      projections.set(id.trim(), module);
      infos.set(key, makeInfo('projection', id.trim(), meta));
      emit('registered', infos.get(key)!);
    },

    registerSource(id: string, factory: DataSourceFactory, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerSource: id must be non-empty', {});
      }
      const key = registryKey('source', id.trim());
      sources.set(id.trim(), factory);
      infos.set(key, makeInfo('source', id.trim(), meta));
      emit('registered', infos.get(key)!);
    },

    registerShaderHook(id: string, hook: ShaderHookDefinition, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerShaderHook: id must be non-empty', {});
      }
      const key = registryKey('shaderHook', id.trim());
      shaderHooks.set(id.trim(), hook);
      infos.set(key, makeInfo('shaderHook', id.trim(), meta));
      emit('registered', infos.get(key)!);
    },

    registerPostProcess(id: string, factory: PostProcessPassFactory, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerPostProcess: id must be non-empty', {});
      }
      const key = registryKey('postProcess', id.trim());
      postProcesses.set(id.trim(), factory);
      infos.set(key, makeInfo('postProcess', id.trim(), meta));
      emit('registered', infos.get(key)!);
    },

    registerInteraction(id: string, factory: InteractionToolFactory, meta?: ExtensionMeta): void {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_REGISTRY_INVALID_ID', 'registerInteraction: id must be non-empty', {});
      }
      const key = registryKey('interaction', id.trim());
      interactions.set(id.trim(), factory);
      infos.set(key, makeInfo('interaction', id.trim(), meta));
      emit('registered', infos.get(key)!);
    },

    getLayer(id: string): CustomLayerFactory | undefined {
      return layers.get(id);
    },
    getProjection(id: string): ProjectionModule | undefined {
      return projections.get(id);
    },
    getSource(id: string): DataSourceFactory | undefined {
      return sources.get(id);
    },
    getPostProcess(id: string): PostProcessPassFactory | undefined {
      return postProcesses.get(id);
    },
    getInteraction(id: string): InteractionToolFactory | undefined {
      return interactions.get(id);
    },
    getShaderHook(id: string): ShaderHookDefinition | undefined {
      return shaderHooks.get(id);
    },

    getShaderHooks(hookPoint?: ShaderHookPoint): ShaderHookDefinition[] {
      const list: ShaderHookDefinition[] = [];
      for (const h of shaderHooks.values()) {
        if (hookPoint === undefined || h.hookPoint === hookPoint) {
          list.push(h);
        }
      }
      // priority 大者优先（默认 0）
      list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      return list;
    },

    listAll(): ExtensionInfo[] {
      return [...infos.values()].sort((a, b) => a.registeredAt - b.registeredAt);
    },

    listByType(type: ExtensionType): ExtensionInfo[] {
      return this.listAll().filter((i) => i.type === type);
    },

    unregister(type: ExtensionType, id: string): boolean {
      const key = registryKey(type, id);
      const existed = infos.has(key);
      if (!existed) {
        return false;
      }
      switch (type) {
        case 'layer':
          layers.delete(id);
          break;
        case 'projection':
          projections.delete(id);
          break;
        case 'source':
          sources.delete(id);
          break;
        case 'shaderHook':
          shaderHooks.delete(id);
          break;
        case 'postProcess':
          postProcesses.delete(id);
          break;
        case 'interaction':
          interactions.delete(id);
          break;
        default: {
          const _exhaustive: never = type;
          void _exhaustive;
        }
      }
      infos.delete(key);
      emit('unregistered', { type, id, registeredAt: Date.now() });
      return true;
    },

    unregisterAll(type?: ExtensionType): void {
      if (type === undefined) {
        layers.clear();
        projections.clear();
        sources.clear();
        shaderHooks.clear();
        postProcesses.clear();
        interactions.clear();
        infos.clear();
        return;
      }
      const toDelete = [...infos.entries()].filter(([k]) => k.startsWith(`${type}:`));
      for (const [key, info] of toDelete) {
        this.unregister(info.type, info.id);
        void key;
      }
    },

    has(type: ExtensionType, id: string): boolean {
      return infos.has(registryKey(type, id));
    },

    on(event: 'registered' | 'unregistered', callback: (info: ExtensionInfo) => void): () => void {
      const set = event === 'registered' ? registeredListeners : unregisteredListeners;
      set.add(callback);
      return (): void => {
        set.delete(callback);
      };
    },
  };

  return registry;
}

/**
 * 创建生命周期管理器：与给定 `registry` 协作完成 `instantiate`。
 *
 * @param registry - 已创建的扩展注册表
 * @returns `ExtensionLifecycle` 实现
 *
 * @example
 * ```ts
 * const r = createExtensionRegistry();
 * const life = createExtensionLifecycle(r);
 * await life.instantiate('projection', 'mercator', {});
 * ```
 */
export function createExtensionLifecycle(registry: ExtensionRegistry): ExtensionLifecycle {
  const instances = new Map<string, ExtensionInstance>();
  const errorStrikes = new Map<string, number>();
  const disabled = new Set<string>();

  let maxConsecutiveErrors = 5;

  const stateListeners = new Set<(instance: ExtensionInstance, old: ExtensionState) => void>();
  const errorListeners = new Set<(extensionId: string, error: Error) => void>();

  const keyOf = (type: ExtensionType, id: string): string => registryKey(type, id);

  const setState = (
    type: ExtensionType,
    id: string,
    state: ExtensionState,
    patch: Partial<ExtensionInstance> = {},
  ): ExtensionInstance => {
    const k = keyOf(type, id);
    const prev = instances.get(k);
    const oldState: ExtensionState = prev?.state ?? 'registered';
    const next: ExtensionInstance = {
      id,
      type,
      state,
      error: patch.error,
      initDurationMs: patch.initDurationMs,
    };
    instances.set(k, next);
    for (const cb of stateListeners) {
      try {
        cb(next, oldState);
      } catch (err) {
        void err;
      }
    }
    return next;
  };

  const lifecycle: ExtensionLifecycle = {
    get maxConsecutiveErrors(): number {
      return maxConsecutiveErrors;
    },

    setMaxConsecutiveErrors(count: number): void {
      if (!Number.isFinite(count) || count < 1) {
        throw new L5Error('L5_LIFECYCLE_BAD_THRESHOLD', 'maxConsecutiveErrors must be a finite number >= 1', {
          count,
        });
      }
      maxConsecutiveErrors = Math.floor(count);
    },

    async instantiate(
      type: ExtensionType,
      id: string,
      options?: Record<string, unknown>,
    ): Promise<ExtensionInstance> {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new L5Error('L5_LIFECYCLE_INVALID_ID', 'instantiate: id must be non-empty', { type });
      }

      const k = keyOf(type, id.trim());
      if (disabled.has(k)) {
        throw new L5Error('L5_EXTENSION_DISABLED', 'extension is disabled due to prior errors', {
          type,
          id,
        });
      }

      setState(type, id.trim(), 'initializing');

      try {
        if (type === 'layer') {
          const factory = registry.getLayer(id.trim());
          if (!factory) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'layer factory not registered', { id });
          }
          const t0 = performance.now();
          factory(options ?? {});
          const dt = performance.now() - t0;
          return setState(type, id.trim(), 'active', { initDurationMs: dt });
        }

        if (type === 'projection') {
          const mod = registry.getProjection(id.trim());
          if (!mod) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'projection module not registered', { id });
          }
          void mod;
          return setState(type, id.trim(), 'active', { initDurationMs: 0 });
        }

        if (type === 'source') {
          const factory = registry.getSource(id.trim());
          if (!factory) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'source factory not registered', { id });
          }
          const ds = factory(options ?? {});
          const ctx = options?.['sourceContext'];
          if (ctx !== undefined) {
            await ds.initialize(ctx as import('./custom-source.ts').SourceContext);
          }
          return setState(type, id.trim(), 'active');
        }

        if (type === 'shaderHook') {
          const hook = registry.getShaderHook(id.trim());
          if (!hook) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'shader hook not registered', { id });
          }
          void hook;
          return setState(type, id.trim(), 'active');
        }

        if (type === 'postProcess') {
          const factory = registry.getPostProcess(id.trim());
          if (!factory) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'post process factory not registered', { id });
          }
          const t0 = performance.now();
          factory(options ?? {});
          const dt = performance.now() - t0;
          return setState(type, id.trim(), 'active', { initDurationMs: dt });
        }

        if (type === 'interaction') {
          const factory = registry.getInteraction(id.trim());
          if (!factory) {
            throw new L5Error('L5_LIFECYCLE_NOT_FOUND', 'interaction factory not registered', { id });
          }
          const t0 = performance.now();
          factory(options ?? {});
          const dt = performance.now() - t0;
          return setState(type, id.trim(), 'active', { initDurationMs: dt });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState(type, id.trim(), 'error', { error });
        throw error;
      }

      const _never: never = type;
      throw new L5Error('L5_LIFECYCLE_UNKNOWN_TYPE', `unknown extension type: ${_never}`, {});
    },

    destroy(type: ExtensionType, id: string): void {
      const k = keyOf(type, id);
      instances.delete(k);
      errorStrikes.delete(k);
      disabled.delete(k);
    },

    destroyAll(type?: ExtensionType): void {
      if (type === undefined) {
        instances.clear();
        errorStrikes.clear();
        disabled.clear();
        return;
      }
      for (const k of [...instances.keys()]) {
        if (k.startsWith(`${type}:`)) {
          instances.delete(k);
          errorStrikes.delete(k);
          disabled.delete(k);
        }
      }
    },

    getInstance(type: ExtensionType, id: string): ExtensionInstance | undefined {
      return instances.get(keyOf(type, id));
    },

    getActiveInstances(type?: ExtensionType): ExtensionInstance[] {
      const all = [...instances.values()].filter((i) => i.state === 'active');
      if (type === undefined) {
        return all;
      }
      return all.filter((i) => i.type === type);
    },

    safeExecute<T>(extensionId: string, fn: () => T, fallback?: T): T {
      try {
        const result = fn();
        errorStrikes.set(extensionId, 0);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const cb of errorListeners) {
          try {
            cb(extensionId, error);
          } catch (listenerErr) {
            void listenerErr;
          }
        }
        const n = (errorStrikes.get(extensionId) ?? 0) + 1;
        errorStrikes.set(extensionId, n);
        if (n >= maxConsecutiveErrors) {
          disabled.add(extensionId);
        }
        return fallback as T;
      }
    },

    async safeExecuteAsync<T>(extensionId: string, fn: () => Promise<T>, fallback?: T): Promise<T> {
      try {
        const result = await fn();
        errorStrikes.set(extensionId, 0);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const cb of errorListeners) {
          try {
            cb(extensionId, error);
          } catch (listenerErr) {
            void listenerErr;
          }
        }
        const n = (errorStrikes.get(extensionId) ?? 0) + 1;
        errorStrikes.set(extensionId, n);
        if (n >= maxConsecutiveErrors) {
          disabled.add(extensionId);
        }
        return fallback as T;
      }
    },

    async reenable(type: ExtensionType, id: string): Promise<boolean> {
      const k = keyOf(type, id);
      if (!registry.has(type, id)) {
        return false;
      }
      disabled.delete(k);
      errorStrikes.delete(k);
      setState(type, id, 'active');
      return true;
    },

    checkCompatibility(meta: ExtensionMeta): { compatible: boolean; reason?: string } {
      if (meta.engineVersionRange === undefined || meta.engineVersionRange.trim().length === 0) {
        return { compatible: true };
      }
      // 轻量启发式：若包含明显不可能满足的 `<0.0.0` 则拒绝；完整 semver 解析留给上层
      const rng = meta.engineVersionRange.trim();
      if (rng.includes('<0.0.0')) {
        return { compatible: false, reason: 'engineVersionRange is unsatisfiable' };
      }
      return { compatible: true };
    },

    onStateChange(callback: (instance: ExtensionInstance, oldState: ExtensionState) => void): () => void {
      stateListeners.add(callback);
      return (): void => {
        stateListeners.delete(callback);
      };
    },

    onError(callback: (extensionId: string, error: Error) => void): () => void {
      errorListeners.add(callback);
      return (): void => {
        errorListeners.delete(callback);
      };
    },
  };

  return lifecycle;
}

/**
 * 初始化 L5：构造注册表、生命周期与绑定 Registry 的交互管理器。
 *
 * @returns 聚合上下文
 *
 * @example
 * ```ts
 * const l5 = initializeL5();
 * l5.registry.registerLayer('x', () => createNoOpCustomLayer('x'));
 * ```
 */
export function initializeL5(): L5Context {
  const registry = createExtensionRegistry();
  const lifecycle = createExtensionLifecycle(registry);
  const interactionManager = createInteractionManager(registry);
  return { registry, lifecycle, interactionManager };
}

export * from './custom-layer.ts';
export * from './custom-projection.ts';
export * from './custom-source.ts';
export * from './shader-hook.ts';
export * from './custom-postprocess.ts';
export * from './custom-interaction.ts';
