// ============================================================
// infra/object-pool.ts — 泛型对象池（自研实现）
// 用于帧循环内复用临时对象，降低 GC 压力；与 ObjectPool.acquire/release 约定配合。
// 零外部依赖。
// ============================================================

import { GeoForgeError, GeoForgeErrorCode } from './errors.ts';

// ======================== 公共接口 ========================

/**
 * 泛型对象池实例。
 * acquire 从空闲栈取出或新建；release 经 reset 后归还。
 *
 * @typeParam T - 池化对象类型
 */
export interface ObjectPool<T> {
  /**
   * 获取一个可用对象：优先从空闲栈弹出，否则调用工厂创建。
   *
   * @returns 已 reset 或全新的实例（由工厂决定初始态）
   *
   * @example
   * const p = createObjectPool(() => new Float32Array(16), (a) => a.fill(0));
   * const m = p.acquire();
   */
  acquire(): T;

  /**
   * 归还对象到池中：先 reset 再入栈。
   * 禁止重复归还同一引用（将抛出 {@link GeoForgeError}）。
   *
   * @param obj - 此前由 acquire 得到的同一引用
   *
   * @example
   * p.release(m);
   */
  release(obj: T): void;

  /**
   * 累计创建过的对象总数（工厂调用次数单调计数，不因 release 减少）。
   */
  readonly size: number;

  /**
   * 当前空闲栈中的对象数量。
   */
  readonly available: number;

  /**
   * 清空空闲栈（不回收仍被外部持有的已借出对象）。
   * 借出对象不应再 release 回已 clear 的池。
   *
   * @example
   * pool.clear();
   */
  clear(): void;

  /**
   * 预创建若干对象放入空闲栈，用于首帧或加载阶段摊销分配。
   *
   * @param count - 要预分配的数量（非正数或非法数字将静默跳过）
   *
   * @example
   * pool.preAllocate(64);
   */
  preAllocate(count: number): void;
}

// ======================== 工厂 ========================

/**
 * 创建对象池。
 *
 * @typeParam T - 池化类型
 * @param factory - 无参工厂，在池为空时创建新实例
 * @param reset - 归还前将对象重置到可复用状态（须幂等）
 * @param initialSize - 可选初始预分配数量（>=0）
 * @returns {@link ObjectPool} 实例
 *
 * @example
 * const pool = createObjectPool(
 *   () => ({ x: 0, y: 0 }),
 *   (o) => { o.x = 0; o.y = 0; },
 *   8,
 * );
 */
export function createObjectPool<T>(
  factory: () => T,
  reset: (obj: T) => void,
  initialSize?: number,
): ObjectPool<T> {
  if (typeof factory !== 'function') {
    throw new GeoForgeError(
      GeoForgeErrorCode.INVALID_LAYER_SPEC,
      'Object pool factory must be a function',
      { scope: 'object-pool', arg: 'factory' },
    );
  }

  if (typeof reset !== 'function') {
    throw new GeoForgeError(
      GeoForgeErrorCode.INVALID_LAYER_SPEC,
      'Object pool reset must be a function',
      { scope: 'object-pool', arg: 'reset' },
    );
  }

  /**
   * 空闲对象栈（LIFO，减少缓存抖动）。
   */
  const freeList: T[] = [];

  /**
   * 当前在空闲栈中的对象引用集合，用于 O(1) 检测重复 release。
   */
  const availableSet = new Set<T>();

  /**
   * 工厂累计调用次数（即“曾创建”的对象总数）。
   */
  let totalCreated = 0;

  /**
   * 将对象压入空闲栈并登记到 `availableSet`，用于后续 O(1) 重复 release 检测。
   *
   * @param obj - 已通过 reset 的可复用实例
   * @returns 无
   *
   * @example
   * pushFree(myObj);
   */
  function pushFree(obj: T): void {
    freeList.push(obj);
    availableSet.add(obj);
  }

  /**
   * 从空闲栈弹出栈顶对象，并自 `availableSet` 移除。
   *
   * @returns 复用实例；栈空时返回 undefined
   *
   * @example
   * const x = popFree();
   */
  function popFree(): T | undefined {
    const obj = freeList.pop();
    if (obj !== undefined) {
      availableSet.delete(obj);
    }
    return obj;
  }

  /**
   * 调用工厂新建对象并递增 `totalCreated`。
   *
   * @returns 新创建的非空实例
   * @throws {GeoForgeError} 工厂抛错或返回 null/undefined 时
   *
   * @example
   * const inst = createNew();
   */
  function createNew(): T {
    let created: T;
    try {
      created = factory();
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new GeoForgeError(
        GeoForgeErrorCode.INVALID_LAYER_SPEC,
        'Object pool factory threw an error',
        { scope: 'object-pool' },
        cause,
      );
    }

    if (created === undefined || created === null) {
      throw new GeoForgeError(
        GeoForgeErrorCode.INVALID_LAYER_SPEC,
        'Object pool factory returned null or undefined',
        { scope: 'object-pool' },
      );
    }

    totalCreated += 1;
    return created;
  }

  const pool: ObjectPool<T> = {
    get size(): number {
      return totalCreated;
    },

    get available(): number {
      return freeList.length;
    },

    acquire(): T {
      const reused = popFree();
      if (reused !== undefined) {
        return reused;
      }
      return createNew();
    },

    release(obj: T): void {
      if (obj === undefined || obj === null) {
        throw new GeoForgeError(
          GeoForgeErrorCode.INVALID_LAYER_SPEC,
          'Object pool release: object must not be null or undefined',
          { scope: 'object-pool' },
        );
      }

      if (availableSet.has(obj)) {
        throw new GeoForgeError(
          GeoForgeErrorCode.INVALID_LAYER_SPEC,
          'Object pool release: duplicate release of the same object',
          { scope: 'object-pool' },
        );
      }

      try {
        reset(obj);
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        throw new GeoForgeError(
          GeoForgeErrorCode.INVALID_LAYER_SPEC,
          'Object pool reset callback threw an error',
          { scope: 'object-pool' },
          cause,
        );
      }

      pushFree(obj);
    },

    clear(): void {
      // 丢弃所有空闲引用，计数保持不变（已创建对象仍可能在外部使用）
      freeList.length = 0;
      availableSet.clear();
    },

    preAllocate(count: number): void {
      // 非有限或负数：无可执行行为，直接返回
      if (!Number.isFinite(count) || count <= 0) {
        return;
      }

      const n = Math.floor(count);
      for (let i = 0; i < n; i++) {
        const obj = createNew();
        try {
          reset(obj);
        } catch (err) {
          const cause = err instanceof Error ? err : new Error(String(err));
          throw new GeoForgeError(
            GeoForgeErrorCode.INVALID_LAYER_SPEC,
            'Object pool preAllocate: reset threw an error',
            { scope: 'object-pool', index: i },
            cause,
          );
        }
        pushFree(obj);
      }
    },
  };

  // 初始预分配：失败时向上抛错（已在 createNew/reset 中包装）
  if (initialSize !== undefined && initialSize !== null) {
    if (!Number.isFinite(initialSize) || initialSize < 0) {
      throw new GeoForgeError(
        GeoForgeErrorCode.INVALID_LAYER_SPEC,
        'Object pool initialSize must be a non-negative finite number',
        { scope: 'object-pool', initialSize },
      );
    }
    pool.preAllocate(Math.floor(initialSize));
  }

  return pool;
}
