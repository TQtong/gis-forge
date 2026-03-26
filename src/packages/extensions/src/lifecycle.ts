// ============================================================
// L5 extensions — ExtensionLifecycle：扩展实例化、销毁与安全执行
// 依赖：`./registry.ts`（类型与注册表）；零 npm；semver 自研子集
// ============================================================

import type { ExtensionMeta, ExtensionRegistry, ExtensionType } from './registry.ts';
import { GeoForgeError } from './registry.ts';

/**
 * 扩展实例生命周期状态（含错误与销毁终态）。
 */
export type ExtensionState = 'registered' | 'initializing' | 'active' | 'error' | 'destroyed';

/**
 * 对外可见的扩展实例快照（不可变字段语义）。
 */
export interface ExtensionInstance {
  /**
   * 扩展实例 id（与注册表中的 id 一致）。
   */
  readonly id: string;

  /**
   * 扩展类型（六类之一）。
   */
  readonly type: ExtensionType;

  /**
   * 当前生命周期状态。
   */
  readonly state: ExtensionState;

  /**
   * 若 `state === 'error'`，为最后一次错误（可选）。
   */
  readonly error?: Error;

  /**
   * 初始化耗时（毫秒），仅在成功进入 `active` 后有意义。
   */
  readonly initDurationMs?: number;
}

/**
 * 可变内部实例记录：持有真实对象引用以便 `destroy` 时调用可选钩子。
 */
interface MutableInstanceRecord {
  /**
   * 对外快照字段（同步更新以保持 getInstance 一致）。
   */
  snapshot: ExtensionInstance;

  /**
   * 实例本体：工厂返回值（图层实例、Hook 对象等）。
   */
  payload: unknown;
}

/**
 * 扩展生命周期管理器：实例化、错误隔离、semver 兼容检查。
 */
export interface ExtensionLifecycle {
  /**
   * 从注册表取出工厂并实例化（异步安全）。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @param options - 传给工厂的可选参数
   * @returns 实例快照（成功为 `active`，失败为 `error`）
   */
  instantiate(type: ExtensionType, id: string, options?: any): Promise<ExtensionInstance>;

  /**
   * 销毁单个实例并释放资源。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   */
  destroy(type: ExtensionType, id: string): void;

  /**
   * 按类型批量销毁；不传则销毁全部。
   *
   * @param type - 可选类型过滤
   */
  destroyAll(type?: ExtensionType): void;

  /**
   * 获取实例快照。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns 实例或 `undefined`
   */
  getInstance(type: ExtensionType, id: string): ExtensionInstance | undefined;

  /**
   * 列出实例；可按类型过滤；默认包含非 `destroyed` 或按需包含全部由实现定义——此处返回内存中仍存在的记录（`destroyed` 会被移除）。
   *
   * @param type - 可选类型
   * @returns 实例数组
   */
  getActiveInstances(type?: ExtensionType): ExtensionInstance[];

  /**
   * 同步安全执行：捕获异常、累计连续错误、超限则禁用。
   *
   * @param extensionId - 用于错误归因的 id（建议与注册 id 或 `type:id` 一致）
   * @param fn - 待执行函数
   * @param fallback - 出错或禁用时的回退值
   * @returns `fn()` 结果或 `fallback`
   */
  safeExecute<T>(extensionId: string, fn: () => T, fallback?: T): T;

  /**
   * 异步安全执行：与 `safeExecute` 相同，但支持 async 函数。
   *
   * @param extensionId - 扩展 id
   * @param fn - 返回 Promise 的函数
   * @param fallback - 回退值
   * @returns Promise 结果或回退
   */
  safeExecuteAsync<T>(extensionId: string, fn: () => Promise<T>, fallback?: T): Promise<T>;

  /**
   * 当前连续错误阈值（超过则自动禁用该 extensionId 的执行）。
   */
  readonly maxConsecutiveErrors: number;

  /**
   * 设置连续错误阈值（必须为非负有限整数）。
   *
   * @param count - 新阈值
   */
  setMaxConsecutiveErrors(count: number): void;

  /**
   * 在因连续错误被禁用后，尝试重置计数并恢复（不自动重新实例化）。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns 是否成功清除禁用状态
   */
  reenable(type: ExtensionType, id: string): Promise<boolean>;

  /**
   * 校验扩展元数据与当前引擎版本 `0.1.0` 的兼容性（semver 子集）。
   *
   * @param meta - 扩展声明的元数据
   * @returns `{ compatible, reason? }`
   */
  checkCompatibility(meta: ExtensionMeta): { compatible: boolean; reason?: string };

  /**
   * 订阅状态迁移事件。
   *
   * @param callback - `(instance, oldState) => void`
   * @returns 取消订阅函数
   */
  onStateChange(callback: (instance: ExtensionInstance, oldState: ExtensionState) => void): () => void;

  /**
   * 订阅扩展执行期错误（含 `safeExecute` 捕获的异常）。
   *
   * @param callback - `(extensionId, error) => void`
   * @returns 取消订阅函数
   */
  onError(callback: (extensionId: string, error: Error) => void): () => void;
}

/**
 * 当前引擎版本（与 GIS-Forge 发布版本对齐；无 npm 读取 package.json）。
 */
const ENGINE_VERSION = '0.1.0';

/**
 * 默认连续错误阈值（与规范「约 5 次」一致）。
 */
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

/**
 * 内部实例 Map 键：`type:id` 避免跨类型 id 碰撞。
 *
 * @param type - 扩展类型
 * @param id - 扩展 id
 * @returns 复合键
 *
 * @example
 * makeInstanceKey('layer', 'roads'); // 'layer:roads'
 */
function makeInstanceKey(type: ExtensionType, id: string): string {
  return `${type}:${id}`;
}

/**
 * 将版本字符串解析为 `[major, minor, patch]`；非法时返回 `null`。
 *
 * @param v - semver 版本字符串
 * @returns 三元组或 `null`
 *
 * @example
 * parseSemverTriple('1.2.3'); // [1,2,3]
 */
function parseSemverTriple(v: string): [number, number, number] | null {
  // 仅支持纯数字三段式，避免引入完整 semver 文法
  if (typeof v !== 'string' || v.length === 0) {
    return null;
  }
  const parts = v.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const nums: number[] = [];
  for (const p of parts) {
    // 禁止非整数段（如 prerelease）
    if (!/^\d+$/.test(p)) {
      return null;
    }
    const n = Number(p);
    if (!Number.isFinite(n)) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!];
}

/**
 * 比较两个 semver 三元组：负值 a<b，零相等，正值 a>b。
 *
 * @param a - 左操作数
 * @param b - 右操作数
 * @returns 比较结果
 *
 * @example
 * compareSemverTriples([1,0,0],[0,9,9]); // >0
 */
function compareSemverTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) {
      return d > 0 ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 判断 `version` 是否满足简单 semver range（无 npm `semver` 包）。
 * 支持：`*`、空、`>=a.b.c`、`^a.b.c`（含 0.x 特殊规则）、`~a.b.c`、精确 `a.b.c`。
 *
 * @param version - 待测版本（如引擎 `0.1.0`）
 * @param range - 范围字符串
 * @returns 是否满足
 *
 * @example
 * satisfiesSemverRange('0.1.0', '^0.1.0'); // true
 */
function satisfiesSemverRange(version: string, range: string): boolean {
  const vt = parseSemverTriple(version);
  if (!vt) {
    return false;
  }
  // 缺省或通配：视为兼容
  if (range === undefined || range === null) {
    return true;
  }
  if (typeof range !== 'string') {
    return false;
  }
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') {
    return true;
  }
  // 精确匹配
  if (!trimmed.includes(' ') && !trimmed.startsWith('>=') && !trimmed.startsWith('^') && !trimmed.startsWith('~')) {
    const rt = parseSemverTriple(trimmed);
    if (!rt) {
      return false;
    }
    return compareSemverTriples(vt, rt) === 0;
  }
  // >=
  if (trimmed.startsWith('>=')) {
    const rest = trimmed.slice(2).trim();
    const rt = parseSemverTriple(rest);
    if (!rt) {
      return false;
    }
    return compareSemverTriples(vt, rt) >= 0;
  }
  // ^
  if (trimmed.startsWith('^')) {
    const rest = trimmed.slice(1).trim();
    const rt = parseSemverTriple(rest);
    if (!rt) {
      return false;
    }
    const major = rt[0]!;
    // 0.y.z：^0.y.z 表示 >=0.y.z <0.(y+1).0
    if (major === 0) {
      return compareSemverTriples(vt, rt) >= 0 && vt[0] === 0 && vt[1] === rt[1];
    }
    // >=1.0.0 <2.0.0
    const upper: [number, number, number] = [major + 1, 0, 0];
    return compareSemverTriples(vt, rt) >= 0 && compareSemverTriples(vt, upper) < 0;
  }
  // ~
  if (trimmed.startsWith('~')) {
    const rest = trimmed.slice(1).trim();
    const rt = parseSemverTriple(rest);
    if (!rt) {
      return false;
    }
    const upper: [number, number, number] = [rt[0]!, rt[1]! + 1, 0];
    return compareSemverTriples(vt, rt) >= 0 && compareSemverTriples(vt, upper) < 0;
  }
  return false;
}

/**
 * 从注册表按类型读取已注册 payload。
 *
 * @param registry - 扩展注册表
 * @param type - 扩展类型
 * @param id - id
 * @returns payload 或 `undefined`
 *
 * @example
 * getPayloadFromRegistry(reg, 'layer', 'x');
 */
function getPayloadFromRegistry(registry: ExtensionRegistry, type: ExtensionType, id: string): unknown {
  switch (type) {
    case 'layer':
      return registry.getLayer(id);
    case 'projection':
      return registry.getProjection(id);
    case 'source':
      return registry.getSource(id);
    case 'shaderHook':
      return registry.getShaderHook(id);
    case 'postProcess':
      return registry.getPostProcess(id);
    case 'interaction':
      return registry.getInteraction(id);
    default: {
      const _exhaustive: never = type;
      throw new GeoForgeError('EXT_LIFECYCLE_UNKNOWN_TYPE', 'unknown extension type', { type: _exhaustive });
    }
  }
}

/**
 * 若对象上存在可调用的 `destroy`，则安全调用（忽略返回值）。
 *
 * @param payload - 实例对象
 * @returns 无
 *
 * @example
 * tryInvokeDestroy({ destroy: () => undefined });
 */
function tryInvokeDestroy(payload: unknown): void {
  if (payload === null || typeof payload !== 'object') {
    return;
  }
  const d = (payload as Record<string, unknown>).destroy;
  if (typeof d !== 'function') {
    return;
  }
  try {
    d.call(payload);
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    console.error('[ExtensionLifecycle] destroy() threw', normalized);
  }
}

/**
 * 构造扩展生命周期管理器。
 *
 * @param registry - 已创建的 `ExtensionRegistry`
 * @returns `ExtensionLifecycle` 实现
 *
 * @example
 * const life = createExtensionLifecycle(createExtensionRegistry());
 * await life.instantiate('layer', 'roads', {});
 */
export function createExtensionLifecycle(registry: ExtensionRegistry): ExtensionLifecycle {
  // 实例表：复合键 → 记录
  const instances = new Map<string, MutableInstanceRecord>();
  // 连续错误计数：键为 `extensionId`（与 safeExecute 参数一致）
  const consecutiveErrors = new Map<string, number>();
  // 被安全执行机制禁用的 extensionId 集合
  const disabledBySafeExecute = new Set<string>();
  // 可变阈值（使用对象包裹以便 readonly 属性对外只读）
  const errorBudget = { max: DEFAULT_MAX_CONSECUTIVE_ERRORS };

  const stateListeners = new Set<(instance: ExtensionInstance, oldState: ExtensionState) => void>();
  const errorListeners = new Set<(extensionId: string, error: Error) => void>();

  /**
   * 广播状态变化。
   *
   * @param snap - 新快照
   * @param oldState - 旧状态
   * @returns 无
   *
   * @example
   * emitStateChange({ id: 'a', type: 'layer', state: 'active' }, 'initializing');
   */
  function emitStateChange(snap: ExtensionInstance, oldState: ExtensionState): void {
    for (const cb of stateListeners) {
      try {
        cb(snap, oldState);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        console.error('[ExtensionLifecycle] onStateChange listener error', normalized);
      }
    }
  }

  /**
   * 广播错误。
   *
   * @param extensionId - 扩展 id
   * @param error - 错误对象
   * @returns 无
   *
   * @example
   * emitError('layer:roads', new Error('boom'));
   */
  function emitError(extensionId: string, error: Error): void {
    for (const cb of errorListeners) {
      try {
        cb(extensionId, error);
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error(String(err));
        console.error('[ExtensionLifecycle] onError listener error', normalized);
      }
    }
  }

  /**
   * 将记录中的快照字段更新并触发事件。
   *
   * @param key - 实例复合键
   * @param next - 新快照
   * @param oldState - 旧状态
   * @returns 无
   *
   * @example
   * updateSnapshot('layer:x', { id: 'x', type: 'layer', state: 'active' }, 'error');
   */
  function updateSnapshot(key: string, next: ExtensionInstance, oldState: ExtensionState): void {
    const rec = instances.get(key);
    if (!rec) {
      return;
    }
    rec.snapshot = next;
    emitStateChange(next, oldState);
  }

  /**
   * 校验 `setMaxConsecutiveErrors` 入参。
   *
   * @param count - 待校验值
   * @throws {GeoForgeError} 非法时
   * @returns 无
   *
   * @example
   * assertValidErrorBudget(3);
   */
  function assertValidErrorBudget(count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      throw new GeoForgeError('EXT_LIFECYCLE_BUDGET_INVALID', 'maxConsecutiveErrors must be a finite number', {
        count,
      });
    }
    if (count < 0 || !Number.isInteger(count)) {
      throw new GeoForgeError('EXT_LIFECYCLE_BUDGET_INVALID', 'maxConsecutiveErrors must be a non-negative integer', {
        count,
      });
    }
  }

  /**
   * 从注册表元数据校验与当前引擎版本的兼容性（不依赖 `api` 以避免循环引用）。
   *
   * @param type - 扩展类型
   * @param id - 扩展 id
   * @returns `{ ok, reason? }`
   *
   * @example
   * const r = checkCompatibilityForRegistry('layer', 'foo');
   */
  function checkCompatibilityForRegistry(type: ExtensionType, id: string): { ok: boolean; reason?: string } {
    const list = registry.listByType(type);
    const found = list.find((e) => e.id === id);
    if (!found) {
      return { ok: false, reason: 'extension not found in registry list' };
    }
    const meta: ExtensionMeta = {
      version: found.version,
      engineVersionRange: found.engineVersionRange,
    };
    if (meta.engineVersionRange === undefined || meta.engineVersionRange === null) {
      return { ok: true };
    }
    if (typeof meta.engineVersionRange !== 'string') {
      return { ok: false, reason: 'engineVersionRange must be a string when provided' };
    }
    const ok = satisfiesSemverRange(ENGINE_VERSION, meta.engineVersionRange.trim());
    if (!ok) {
      return {
        ok: false,
        reason: `engine version ${ENGINE_VERSION} does not satisfy range "${meta.engineVersionRange}"`,
      };
    }
    return { ok: true };
  }

  const api: ExtensionLifecycle = {
    get maxConsecutiveErrors(): number {
      return errorBudget.max;
    },

    setMaxConsecutiveErrors(count: number): void {
      assertValidErrorBudget(count);
      errorBudget.max = count;
    },

    checkCompatibility(meta: ExtensionMeta): { compatible: boolean; reason?: string } {
      // 未声明范围：视为不约束（兼容）
      if (meta.engineVersionRange === undefined || meta.engineVersionRange === null) {
        return { compatible: true };
      }
      if (typeof meta.engineVersionRange !== 'string') {
        return { compatible: false, reason: 'engineVersionRange must be a string when provided' };
      }
      const ok = satisfiesSemverRange(ENGINE_VERSION, meta.engineVersionRange.trim());
      if (!ok) {
        return {
          compatible: false,
          reason: `engine version ${ENGINE_VERSION} does not satisfy range "${meta.engineVersionRange}"`,
        };
      }
      return { compatible: true };
    },

    onStateChange(callback: (instance: ExtensionInstance, oldState: ExtensionState) => void): () => void {
      if (typeof callback !== 'function') {
        throw new GeoForgeError('EXT_LIFECYCLE_LISTENER_INVALID', 'onStateChange callback must be a function', {});
      }
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    },

    onError(callback: (extensionId: string, error: Error) => void): () => void {
      if (typeof callback !== 'function') {
        throw new GeoForgeError('EXT_LIFECYCLE_LISTENER_INVALID', 'onError callback must be a function', {});
      }
      errorListeners.add(callback);
      return () => {
        errorListeners.delete(callback);
      };
    },

    getInstance(type: ExtensionType, id: string): ExtensionInstance | undefined {
      const key = makeInstanceKey(type, id);
      const rec = instances.get(key);
      return rec?.snapshot;
    },

    getActiveInstances(type?: ExtensionType): ExtensionInstance[] {
      const out: ExtensionInstance[] = [];
      instances.forEach((rec, key) => {
        // key 前缀过滤（按类型）
        if (type !== undefined) {
          const prefix = `${type}:`;
          if (!key.startsWith(prefix)) {
            return;
          }
        }
        // 已销毁的记录不应再视为 active；实现上 destroy 会 delete
        if (rec.snapshot.state !== 'destroyed') {
          out.push(rec.snapshot);
        }
      });
      return out;
    },

    destroy(type: ExtensionType, id: string): void {
      const key = makeInstanceKey(type, id);
      const rec = instances.get(key);
      if (!rec) {
        return;
      }
      const oldState = rec.snapshot.state;
      // 先尝试用户销毁钩子，再移除记录
      tryInvokeDestroy(rec.payload);
      instances.delete(key);
      const destroyedSnap: ExtensionInstance = {
        id,
        type,
        state: 'destroyed',
        error: rec.snapshot.error,
        initDurationMs: rec.snapshot.initDurationMs,
      };
      emitStateChange(destroyedSnap, oldState);
    },

    destroyAll(type?: ExtensionType): void {
      const keys = [...instances.keys()];
      for (const key of keys) {
        if (type !== undefined && !key.startsWith(`${type}:`)) {
          continue;
        }
        const parts = key.split(':');
        // 复合键必须为 type:id（id 中不含冒号）；若 id 含冒号，规范禁止——此处取首个分段为 type，余下连接为 id
        const t = parts[0] as ExtensionType;
        const id = parts.slice(1).join(':');
        api.destroy(t, id);
      }
    },

    async instantiate(type: ExtensionType, id: string, options?: any): Promise<ExtensionInstance> {
      const key = makeInstanceKey(type, id);
      const compat = checkCompatibilityForRegistry(type, id);
      if (!compat.ok) {
        const err = new Error(compat.reason ?? 'compatibility check failed');
        const failSnap: ExtensionInstance = { id, type, state: 'error', error: err };
        emitStateChange(failSnap, 'destroyed');
        emitError(key, err);
        return failSnap;
      }
      const factory = getPayloadFromRegistry(registry, type, id);
      if (factory === undefined) {
        const err = new GeoForgeError('EXT_LIFECYCLE_NOT_REGISTERED', 'no extension registered for type/id', {
          type,
          id,
        });
        const failSnap: ExtensionInstance = { id, type, state: 'error', error: err };
        emitStateChange(failSnap, 'destroyed');
        emitError(key, err);
        return failSnap;
      }
      // 若已存在且未销毁，先销毁再重建，避免资源泄漏
      if (instances.has(key)) {
        api.destroy(type, id);
      }
      const registeredSnap: ExtensionInstance = { id, type, state: 'registered' };
      emitStateChange(registeredSnap, 'destroyed');
      const initSnap: ExtensionInstance = { id, type, state: 'initializing' };
      emitStateChange(initSnap, 'registered');
      const t0 = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      try {
        let payload: unknown;
        if (typeof factory === 'function') {
          const r = (factory as (opts?: any) => any)(options);
          payload = r instanceof Promise ? await r : r;
        } else {
          // 非函数：将注册项本身视为单例/模块
          payload = factory;
        }
        const t1 = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
        const duration = Math.max(0, t1 - t0);
        const activeSnap: ExtensionInstance = {
          id,
          type,
          state: 'active',
          initDurationMs: duration,
        };
        instances.set(key, { snapshot: activeSnap, payload });
        emitStateChange(activeSnap, 'initializing');
        return activeSnap;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const failSnap: ExtensionInstance = { id, type, state: 'error', error: err };
        emitStateChange(failSnap, 'initializing');
        emitError(key, err);
        return failSnap;
      }
    },

    safeExecute<T>(extensionId: string, fn: () => T, fallback?: T): T {
      if (typeof extensionId !== 'string' || extensionId.length === 0) {
        throw new GeoForgeError('EXT_LIFECYCLE_SAFE_ID_INVALID', 'extensionId must be non-empty string', {
          extensionId,
        });
      }
      if (typeof fn !== 'function') {
        throw new GeoForgeError('EXT_LIFECYCLE_SAFE_FN_INVALID', 'fn must be a function', { extensionId });
      }
      // 已禁用则直接回退，避免再次抛错放大日志
      if (disabledBySafeExecute.has(extensionId)) {
        return fallback as T;
      }
      try {
        const result = fn();
        // 成功则清零连续错误
        consecutiveErrors.set(extensionId, 0);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        emitError(extensionId, err);
        const prev = consecutiveErrors.get(extensionId) ?? 0;
        const next = prev + 1;
        consecutiveErrors.set(extensionId, next);
        if (next >= errorBudget.max) {
          disabledBySafeExecute.add(extensionId);
        }
        return fallback as T;
      }
    },

    async safeExecuteAsync<T>(extensionId: string, fn: () => Promise<T>, fallback?: T): Promise<T> {
      if (typeof extensionId !== 'string' || extensionId.length === 0) {
        throw new GeoForgeError('EXT_LIFECYCLE_SAFE_ID_INVALID', 'extensionId must be non-empty string', {
          extensionId,
        });
      }
      if (typeof fn !== 'function') {
        throw new GeoForgeError('EXT_LIFECYCLE_SAFE_FN_INVALID', 'fn must be a function', { extensionId });
      }
      if (disabledBySafeExecute.has(extensionId)) {
        return fallback as T;
      }
      try {
        const result = await fn();
        consecutiveErrors.set(extensionId, 0);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        emitError(extensionId, err);
        const prev = consecutiveErrors.get(extensionId) ?? 0;
        const next = prev + 1;
        consecutiveErrors.set(extensionId, next);
        if (next >= errorBudget.max) {
          disabledBySafeExecute.add(extensionId);
        }
        return fallback as T;
      }
    },

    async reenable(type: ExtensionType, id: string): Promise<boolean> {
      const key = makeInstanceKey(type, id);
      // 同时清除复合键与裸 id，便于与 safeExecute 计数对齐
      consecutiveErrors.delete(key);
      consecutiveErrors.delete(id);
      disabledBySafeExecute.delete(key);
      disabledBySafeExecute.delete(id);
      const rec = instances.get(key);
      if (!rec) {
        return true;
      }
      if (rec.snapshot.state === 'error') {
        const old = rec.snapshot.state;
        const next: ExtensionInstance = {
          id,
          type,
          state: 'active',
          initDurationMs: rec.snapshot.initDurationMs,
        };
        updateSnapshot(key, next, old);
      }
      return true;
    },
  };

  return api;
}
