// ============================================================
// infra/internal-bus.ts — 引擎内部事件总线（自研实现）
// 与面向用户的 EventEmitter 分离，仅供 L0~L6 内部模块解耦通信。
// 使用 Map + Set 存储处理器；emit 时快照迭代，避免回调中修改集合导致异常。
// 零外部依赖。
// ============================================================

import type { CameraState } from '../types/viewport.ts';
import type { TileCoord } from '../types/tile.ts';

// ======================== 类型定义 ========================

/**
 * 内部总线支持的事件名 → 载荷类型映射。
 * 键名使用 `域:动作` 约定，与架构文档 InternalBus 章节一致。
 */
export type InternalEventMap = {
  /** 瓦片加载成功，data 为解码后的业务载荷（类型由数据源决定） */
  'tile:loaded': {
    /** 数据源唯一标识 */
    sourceId: string;
    /** 瓦片 XYZ 坐标 */
    coord: TileCoord;
    /** 解码后的瓦片数据（矢量/栅格/DEM 等） */
    data: any;
  };
  /** 瓦片加载或解码失败 */
  'tile:error': {
    /** 数据源唯一标识 */
    sourceId: string;
    /** 瓦片 XYZ 坐标 */
    coord: TileCoord;
    /** 底层错误对象（保留堆栈便于诊断） */
    error: Error;
  };
  /** 瓦片从缓存淘汰 */
  'tile:evicted': {
    /** 数据源唯一标识 */
    sourceId: string;
    /** 被驱逐瓦片的坐标 */
    coord: TileCoord;
  };
  /** 相机状态已更新（平移/缩放/旋转等） */
  'camera:changed': {
    /** 当前相机只读快照 */
    state: CameraState;
  };
  /** 相机交互静止（用于延迟加载、标注重排等） */
  'camera:idle': {
    /** 静止时刻的相机快照 */
    state: CameraState;
  };
  /** 内存压力预警（接近预算阈值） */
  'memory:warning': {
    /** 内存统计快照（由 MemoryBudget 定义结构） */
    snapshot: any;
  };
  /** 已执行淘汰，释放资源 */
  'memory:eviction': {
    /** 被淘汰资源的逻辑 ID 列表 */
    evictedIds: string[];
  };
  /** 图层已加入场景 */
  'layer:added': {
    /** 图层运行时句柄或规范对象（由 LayerManager 决定具体类型） */
    layer: any;
  };
  /** 图层已从场景移除 */
  'layer:removed': {
    /** 图层 ID */
    layerId: string;
  };
  /** 图层关联数据变更（样式/源数据等） */
  'layer:data-changed': {
    /** 图层 ID */
    layerId: string;
  };
  /** WebGPU 设备丢失 */
  'device:lost': {
    /** 丢失原因（浏览器/驱动提供的字符串，可能为空） */
    reason: string;
  };
  /** WebGPU 设备恢复完成 */
  'device:restored': Record<string, never>;
  /** 帧开始（用于统计与调试） */
  'frame:begin': {
    /** 单调递增帧序号，从 0 或 1 起始由实现约定 */
    frameIndex: number;
  };
  /** 帧结束（携带本帧统计） */
  'frame:end': {
    /** 渲染/CPU 耗时等统计对象 */
    stats: any;
  };
};

/**
 * 内部事件处理器函数类型。
 *
 * @typeParam K - 事件名，决定 data 的推断类型
 */
type InternalHandler<K extends keyof InternalEventMap> = (
  data: InternalEventMap[K],
) => void;

// ======================== 公共接口 ========================

/**
 * 内部事件总线接口。
 * 仅描述行为；具体实现见 {@link createInternalBus}。
 */
export interface InternalBus {
  /**
   * 同步派发事件：按注册顺序调用所有处理器。
   * 单个处理器抛错不会中断其余处理器（错误会记录到控制台）。
   *
   * @typeParam K - 事件键，必须为 InternalEventMap 的键
   * @param event - 事件名
   * @param data - 与事件名匹配的载荷
   *
   * @example
   * bus.emit('tile:loaded', {
   *   sourceId: 'osm',
   *   coord: { x: 0, y: 0, z: 0 },
   *   data: { features: [] },
   * });
   */
  emit<K extends keyof InternalEventMap>(event: K, data: InternalEventMap[K]): void;

  /**
   * 注册持久处理器，返回取消订阅函数。
   *
   * @typeParam K - 事件键
   * @param event - 事件名
   * @param handler - 回调
   * @returns 调用后移除此 handler 的函数
   *
   * @example
   * const unsub = bus.on('device:lost', (e) => console.warn(e.reason));
   * // 稍后：unsub();
   */
  on<K extends keyof InternalEventMap>(
    event: K,
    handler: InternalHandler<K>,
  ): () => void;

  /**
   * 注册只触发一次的处理函数，返回取消订阅函数。
   *
   * @typeParam K - 事件键
   * @param event - 事件名
   * @param handler - 回调
   * @returns 若在触发前取消，可调用返回函数
   *
   * @example
   * bus.once('device:restored', () => engine.reload());
   */
  once<K extends keyof InternalEventMap>(
    event: K,
    handler: InternalHandler<K>,
  ): () => void;

  /**
   * 移除指定处理器（需同一函数引用）。
   *
   * @typeParam K - 事件键
   * @param event - 事件名
   * @param handler - 与注册时相同的函数引用
   *
   * @example
   * const fn = (d: InternalEventMap['layer:removed']) => {};
   * bus.on('layer:removed', fn);
   * bus.off('layer:removed', fn);
   */
  off<K extends keyof InternalEventMap>(event: K, handler: InternalHandler<K>): void;

  /**
   * 移除监听器；若省略 event 则清空全部事件。
   *
   * @param event - 可选，限定要清空的事件名
   *
   * @example
   * bus.removeAllListeners('tile:loaded');
   * bus.removeAllListeners();
   */
  removeAllListeners(event?: keyof InternalEventMap): void;

  /**
   * 当前注册的处理函数总数（所有事件累加）。
   */
  readonly listenerCount: number;
}

// ======================== 实现 ========================

/**
 * 计算 Map 中所有 Set 内处理器数量之和。
 *
 * @param handlers - 事件 → 处理器集合
 * @returns 处理器总数
 *
 * @example
 * const n = countTotalListeners(new Map());
 */
function countTotalListeners(
  handlers: Map<string, Set<InternalHandler<keyof InternalEventMap>>>,
): number {
  let total = 0;
  const values = handlers.values();

  // 遍历每个事件的 Set，累加 size（避免展开大数组）
  for (const set of values) {
    total += set.size;
  }

  return total;
}

/**
 * 创建内部事件总线实例。
 *
 * @returns 满足 {@link InternalBus} 的实例
 *
 * @example
 * const bus = createInternalBus();
 * bus.on('frame:begin', ({ frameIndex }) => {
 *   if (frameIndex < 0) return;
 * });
 */
export function createInternalBus(): InternalBus {
  /**
   * 事件名 → 处理器集合。
   * 使用 Set 保证同一引用不会重复注册。
   */
  const handlers = new Map<string, Set<InternalHandler<keyof InternalEventMap>>>();

  /**
   * once 注册的原始 handler → 包装函数，便于 off() 用原始引用移除。
   */
  const onceWrappers = new Map<InternalHandler<keyof InternalEventMap>, InternalHandler<keyof InternalEventMap>>();

  /**
   * 缓存的监听器总数，在增删时同步更新以避免每次 O(n) 遍历。
   */
  let cachedListenerCount = 0;

  /**
   * 重新计算并写回 `listenerCount` 缓存，与 `handlers` 中 Set 尺寸一致。
   *
   * @returns 无
   *
   * @example
   * syncListenerCount();
   */
  function syncListenerCount(): void {
    cachedListenerCount = countTotalListeners(handlers);
  }

  /**
   * 总线实例引用，供 on/once 返回的取消函数使用（避免依赖不稳定的 this）。
   */
  const impl: InternalBus = {
    get listenerCount(): number {
      return cachedListenerCount;
    },

    emit<K extends keyof InternalEventMap>(event: K, data: InternalEventMap[K]): void {
      const key = event as string;
      const set = handlers.get(key);

      // 无监听时快速返回，避免分配快照数组
      if (set === undefined || set.size === 0) {
        return;
      }

      // 快照当前处理器列表，避免在迭代中 once/off 修改 Set 导致遗漏或异常
      const snapshot = Array.from(set);

      for (let i = 0; i < snapshot.length; i++) {
        try {
          (snapshot[i] as InternalHandler<K>)(data);
        } catch (err) {
          // 隔离单个监听器的异常，保证其余监听器仍执行
          console.error(`[InternalBus] handler error for "${key}":`, err);
        }
      }
    },

    on<K extends keyof InternalEventMap>(event: K, handler: InternalHandler<K>): () => void {
      const key = event as string;
      let set = handlers.get(key);

      if (set === undefined) {
        set = new Set();
        handlers.set(key, set);
      }

      // Set.add 在重复引用时不会改变 size，需判断是否新增
      const before = set.size;
      set.add(handler as InternalHandler<keyof InternalEventMap>);
      if (set.size > before) {
        cachedListenerCount += 1;
      }

      return (): void => {
        impl.off(event, handler);
      };
    },

    once<K extends keyof InternalEventMap>(event: K, handler: InternalHandler<K>): () => void {
      const key = event as string;

      const wrapper: InternalHandler<K> = (data) => {
        // 先移除包装器，再调用用户逻辑，避免重入时重复触发
        const set = handlers.get(key);
        if (set !== undefined) {
          set.delete(wrapper as InternalHandler<keyof InternalEventMap>);
          if (set.size === 0) {
            handlers.delete(key);
          }
        }
        onceWrappers.delete(handler as InternalHandler<keyof InternalEventMap>);
        cachedListenerCount = Math.max(0, cachedListenerCount - 1);

        try {
          handler(data);
        } catch (err) {
          console.error(`[InternalBus] once handler error for "${key}":`, err);
        }
      };

      onceWrappers.set(handler as InternalHandler<keyof InternalEventMap>, wrapper as InternalHandler<keyof InternalEventMap>);

      let set = handlers.get(key);
      if (set === undefined) {
        set = new Set();
        handlers.set(key, set);
      }
      const before = set.size;
      set.add(wrapper as InternalHandler<keyof InternalEventMap>);
      if (set.size > before) {
        cachedListenerCount += 1;
      }

      return (): void => {
        impl.off(event, handler);
      };
    },

    off<K extends keyof InternalEventMap>(event: K, handler: InternalHandler<K>): void {
      const key = event as string;
      const set = handlers.get(key);
      if (set === undefined) {
        return;
      }

      let removed = false;

      // 优先按原始引用删除
      if (set.delete(handler as InternalHandler<keyof InternalEventMap>)) {
        removed = true;
      }

      // 若是 once 注册的原始函数，同时删除包装函数
      const wrap = onceWrappers.get(handler as InternalHandler<keyof InternalEventMap>);
      if (wrap !== undefined) {
        if (set.delete(wrap)) {
          removed = true;
        }
        onceWrappers.delete(handler as InternalHandler<keyof InternalEventMap>);
      }

      if (removed) {
        cachedListenerCount = Math.max(0, cachedListenerCount - 1);
      }

      if (set.size === 0) {
        handlers.delete(key);
      }
    },

    removeAllListeners(event?: keyof InternalEventMap): void {
      if (event === undefined) {
        handlers.clear();
        onceWrappers.clear();
        cachedListenerCount = 0;
        return;
      }

      const key = event as string;
      const set = handlers.get(key);
      if (set === undefined) {
        return;
      }

      // 清理与这些 once 相关的映射条目（避免 onceWrappers 泄漏）
      for (const h of set) {
        for (const [orig, w] of onceWrappers.entries()) {
          if (w === h) {
            onceWrappers.delete(orig);
          }
        }
      }

      handlers.delete(key);
      // 与 handlers 真值同步，避免手动减计数与 once 包装重复计数不一致
      syncListenerCount();
    },
  };

  return impl;
}
