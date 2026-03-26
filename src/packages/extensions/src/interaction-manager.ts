/**
 * @file GIS-Forge L5 — InteractionManager（EP6 事件路由实现）
 *
 * @description
 * 维护「当前激活工具」与「默认工具」两条链；指针/键盘/滚轮事件优先派发到激活工具，
 * 若未消费（返回 `true` 表示已消费）则回退到默认工具。同一时间仅允许一个激活工具实例；
 * 默认工具同样互斥（`setDefaultTool` 会替换实例）。
 */

import {
  ExtensionInteractionError,
  createStubInteractionContext,
} from './custom-interaction.ts';

import type {
  InteractionContext,
  InteractionTool,
  InteractionToolRegistryLike,
  MapPointerEvent,
} from './custom-interaction.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 管理器可选构造参数。
 */
export interface InteractionManagerOptions {
  /**
   * 用于 `activateTool` / `setDefaultTool` 解析 {@link InteractionTool} 工厂的注册表。
   * 若缺省，则仅当两方法传入前已手动注入工具时可用（通常应提供）。
   */
  readonly registry?: InteractionToolRegistryLike;

  /**
   * `InteractionTool.activate` 时注入的引擎上下文；缺省时使用桩 {@link createStubInteractionContext}。
   */
  readonly context?: InteractionContext;
}

/**
 * 管理器对外暴露的只读统计。
 */
export interface InteractionManagerStats {
  /**
   * 当前激活工具 id；无激活工具时为 `null`。
   */
  readonly activeToolId: string | null;

  /**
   * 累计派发的输入事件次数（指针/滚轮/键盘各计一次）。
   */
  readonly eventCount: number;
}

/**
 * 订阅回调可接收的事件类型。
 */
export type InteractionManagerEventType =
  | 'activeToolChanged'
  | 'defaultToolChanged'
  | 'eventDispatched';

/**
 * 事件详情：携带当前工具 id 快照，便于 UI 同步。
 */
export interface InteractionManagerEventDetail {
  /** 事件名。 */
  readonly type: InteractionManagerEventType;
  /** 当前激活工具 id。 */
  readonly activeToolId: string | null;
  /** 当前默认工具 id。 */
  readonly defaultToolId: string | null;
  /** 可选：本次分发的事件大类。 */
  readonly eventKind?: 'pointer' | 'wheel' | 'key';
}

/**
 * 事件监听器函数签名。
 */
export type InteractionManagerListener = (detail: InteractionManagerEventDetail) => void;

/**
 * EP6 交互管理器：工具激活、默认工具、输入路由与轻量统计。
 */
export interface InteractionManager {
  /**
   * 实例化并激活指定 id 的工具；与此前激活工具互斥（先停旧再启新）。
   *
   * @param toolId - 注册表中的交互工具 id
   * @param options - 传给工具工厂的选项
   *
   * @stability stable
   */
  activateTool(toolId: string, options?: Record<string, unknown>): void;

  /**
   * 停用当前激活工具（不影响默认工具）。
   *
   * @stability stable
   */
  deactivateTool(): void;

  /**
   * 返回当前激活工具实例；无则 `null`。
   *
   * @stability stable
   */
  getActiveTool(): InteractionTool | null;

  /**
   * 设置默认工具（平移/缩放等）；与此前默认工具互斥。
   *
   * @param toolId - 注册表 id
   * @param options - 工厂选项
   *
   * @stability stable
   */
  setDefaultTool(toolId: string, options?: Record<string, unknown>): void;

  /**
   * 指针按下：激活工具优先，其次默认工具。返回是否被任一工具标记为已消费。
   *
   * @param event - 地图指针事件
   * @returns 若工具返回 `true` 则为已消费
   *
   * @stability stable
   */
  handlePointerDown(event: MapPointerEvent): boolean;

  /**
   * 指针移动。
   *
   * @param event - 地图指针事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handlePointerMove(event: MapPointerEvent): boolean;

  /**
   * 指针抬起。
   *
   * @param event - 地图指针事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handlePointerUp(event: MapPointerEvent): boolean;

  /**
   * 指针取消：映射为各工具可选的 `onPointerUp`（与 EP6 约定一致）。
   *
   * @param event - 地图指针事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handlePointerCancel(event: MapPointerEvent): boolean;

  /**
   * 滚轮事件路由。
   *
   * @param event - 原始滚轮事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handleWheel(event: WheelEvent): boolean;

  /**
   * 键盘按下。
   *
   * @param event - 原始键盘事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handleKeyDown(event: KeyboardEvent): boolean;

  /**
   * 键盘抬起。
   *
   * @param event - 原始键盘事件
   * @returns 是否已消费
   *
   * @stability stable
   */
  handleKeyUp(event: KeyboardEvent): boolean;

  /**
   * 注册管理器级事件（工具切换、每次输入分发）。
   *
   * @param type - 事件类型
   * @param listener - 回调
   * @returns 卸载函数
   *
   * @stability stable
   */
  addEventListener(type: InteractionManagerEventType, listener: InteractionManagerListener): () => void;

  /**
   * 移除先前通过 {@link addEventListener} 注册的监听器。
   *
   * @param type - 事件类型
   * @param listener - 同一引用
   *
   * @stability stable
   */
  removeEventListener(type: InteractionManagerEventType, listener: InteractionManagerListener): void;

  /**
   * 只读统计：激活工具 id 与事件计数。
   *
   * @stability stable
   */
  readonly stats: InteractionManagerStats;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 调用可选的布尔消费型处理器：`true` 表示事件已消费。
 *
 * @param fn - 工具上的可选回调
 * @param ev - 地图指针事件
 * @returns 是否消费
 */
function invokePointerHandler(
  fn: ((ev: MapPointerEvent) => boolean | void) | undefined,
  ev: MapPointerEvent,
): boolean {
  if (!fn) {
    return false;
  }
  const r = fn(ev);
  return r === true;
}

/**
 * 调用滚轮处理器。
 *
 * @param fn - `onWheel`
 * @param ev - 滚轮事件
 */
function invokeWheelHandler(fn: ((ev: WheelEvent) => boolean | void) | undefined, ev: WheelEvent): boolean {
  if (!fn) {
    return false;
  }
  const r = fn(ev);
  return r === true;
}

/**
 * 调用键盘处理器。
 *
 * @param fn - `onKeyDown` / `onKeyUp`
 * @param ev - 键盘事件
 */
function invokeKeyHandler(fn: ((ev: KeyboardEvent) => boolean | void) | undefined, ev: KeyboardEvent): boolean {
  if (!fn) {
    return false;
  }
  const r = fn(ev);
  return r === true;
}

/**
 * 安全调用 `activate`，失败时抛出 {@link ExtensionInteractionError}。
 *
 * @param tool - 工具实例
 * @param context - 注入上下文
 */
function safeActivateTool(tool: InteractionTool, context: InteractionContext): void {
  try {
    tool.activate(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtensionInteractionError('INTERACTION_ACTIVATE_FAILED', `activate failed: ${message}`, {
      toolId: tool.id,
    });
  }
}

/**
 * 安全调用 `deactivate`。
 *
 * @param tool - 工具实例
 */
function safeDeactivateTool(tool: InteractionTool): void {
  try {
    tool.deactivate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtensionInteractionError('INTERACTION_DEACTIVATE_FAILED', `deactivate failed: ${message}`, {
      toolId: tool.id,
    });
  }
}

/**
 * 自注册表创建工具实例并完成形状校验。
 *
 * @param registry - 注册表
 * @param toolId - 工具 id
 * @param options - 工厂参数
 */
function instantiateTool(
  registry: InteractionToolRegistryLike,
  toolId: string,
  options?: Record<string, unknown>,
): InteractionTool {
  const factory = registry.getInteraction(toolId);
  if (!factory) {
    throw new ExtensionInteractionError('INTERACTION_TOOL_NOT_REGISTERED', `unknown tool: ${toolId}`, {
      toolId,
    });
  }
  let next: InteractionTool;
  try {
    next = factory(options ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtensionInteractionError('INTERACTION_TOOL_FACTORY_FAILED', `factory threw: ${message}`, {
      toolId,
    });
  }
  if (typeof next.activate !== 'function' || typeof next.deactivate !== 'function') {
    throw new ExtensionInteractionError(
      'INTERACTION_TOOL_INVALID_SHAPE',
      'tool must expose activate() and deactivate()',
      { toolId },
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 创建交互管理器实例。
 *
 * @param options - 注册表与可选上下文
 * @returns {@link InteractionManager}
 *
 * @example
 * ```ts
 * const mgr = createInteractionManager({ registry });
 * mgr.setDefaultTool('pan', {});
 * mgr.handleWheel(new WheelEvent('wheel'));
 * ```
 *
 * @stability stable
 */
export function createInteractionManager(options?: InteractionManagerOptions): InteractionManager {
  const registry = options?.registry;
  const resolveContext = (): InteractionContext => options?.context ?? createStubInteractionContext();

  let activeTool: InteractionTool | null = null;
  let activeToolId: string | null = null;
  let defaultTool: InteractionTool | null = null;
  let defaultToolId: string | null = null;
  let eventCount = 0;

  const listeners = new Map<InteractionManagerEventType, Set<InteractionManagerListener>>();

  /**
   * 向监听器广播详情；单个监听器抛错不影响其他监听。
   *
   * @param type - 事件类型
   * @param eventKind - 可选事件大类
   */
  const emit = (type: InteractionManagerEventType, eventKind?: 'pointer' | 'wheel' | 'key'): void => {
    const detail: InteractionManagerEventDetail = {
      type,
      activeToolId,
      defaultToolId,
      eventKind,
    };
    const bucket = listeners.get(type);
    if (!bucket) {
      return;
    }
    for (const cb of bucket) {
      try {
        cb(detail);
      } catch {
        // 监听器隔离：不冒泡到引擎
      }
    }
  };

  /**
   * 确保存在注册表以便按 id 建工具。
   *
   * @param toolId - 请求 id（用于错误上下文）
   */
  const requireRegistry = (toolId: string): InteractionToolRegistryLike => {
    if (!registry) {
      throw new ExtensionInteractionError(
        'INTERACTION_REGISTRY_MISSING',
        'createInteractionManager() was created without a registry; cannot resolve tools by id',
        { toolId },
      );
    }
    return registry;
  };

  const manager: InteractionManager = {
    activateTool(toolId: string, toolOptions?: Record<string, unknown>): void {
      if (typeof toolId !== 'string' || toolId.trim().length === 0) {
        throw new ExtensionInteractionError('INTERACTION_TOOL_ID_INVALID', 'toolId must be non-empty', {});
      }
      const id = toolId.trim();
      const reg = requireRegistry(id);
      const next = instantiateTool(reg, id, toolOptions);

      if (activeTool !== null) {
        safeDeactivateTool(activeTool);
      }

      safeActivateTool(next, resolveContext());
      activeTool = next;
      activeToolId = id;
      emit('activeToolChanged');
    },

    deactivateTool(): void {
      if (activeTool === null) {
        return;
      }
      const prev = activeTool;
      safeDeactivateTool(prev);
      activeTool = null;
      activeToolId = null;
      emit('activeToolChanged');
    },

    getActiveTool(): InteractionTool | null {
      return activeTool;
    },

    setDefaultTool(toolId: string, toolOptions?: Record<string, unknown>): void {
      if (typeof toolId !== 'string' || toolId.trim().length === 0) {
        throw new ExtensionInteractionError('INTERACTION_TOOL_ID_INVALID', 'toolId must be non-empty', {});
      }
      const id = toolId.trim();
      const reg = requireRegistry(id);

      if (defaultTool !== null) {
        safeDeactivateTool(defaultTool);
        defaultTool = null;
        defaultToolId = null;
      }

      const next = instantiateTool(reg, id, toolOptions);
      safeActivateTool(next, resolveContext());
      defaultTool = next;
      defaultToolId = id;
      emit('defaultToolChanged');
    },

    handlePointerDown(event: MapPointerEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'pointer');
      if (invokePointerHandler(activeTool?.onPointerDown, event)) {
        return true;
      }
      if (invokePointerHandler(defaultTool?.onPointerDown, event)) {
        return true;
      }
      return false;
    },

    handlePointerMove(event: MapPointerEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'pointer');
      if (invokePointerHandler(activeTool?.onPointerMove, event)) {
        return true;
      }
      if (invokePointerHandler(defaultTool?.onPointerMove, event)) {
        return true;
      }
      return false;
    },

    handlePointerUp(event: MapPointerEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'pointer');
      if (invokePointerHandler(activeTool?.onPointerUp, event)) {
        return true;
      }
      if (invokePointerHandler(defaultTool?.onPointerUp, event)) {
        return true;
      }
      return false;
    },

    handlePointerCancel(event: MapPointerEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'pointer');
      if (invokePointerHandler(activeTool?.onPointerUp, event)) {
        return true;
      }
      if (invokePointerHandler(defaultTool?.onPointerUp, event)) {
        return true;
      }
      return false;
    },

    handleWheel(event: WheelEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'wheel');
      if (invokeWheelHandler(activeTool?.onWheel, event)) {
        return true;
      }
      if (invokeWheelHandler(defaultTool?.onWheel, event)) {
        return true;
      }
      return false;
    },

    handleKeyDown(event: KeyboardEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'key');
      if (invokeKeyHandler(activeTool?.onKeyDown, event)) {
        return true;
      }
      if (invokeKeyHandler(defaultTool?.onKeyDown, event)) {
        return true;
      }
      return false;
    },

    handleKeyUp(event: KeyboardEvent): boolean {
      eventCount += 1;
      emit('eventDispatched', 'key');
      if (invokeKeyHandler(activeTool?.onKeyUp, event)) {
        return true;
      }
      if (invokeKeyHandler(defaultTool?.onKeyUp, event)) {
        return true;
      }
      return false;
    },

    addEventListener(type: InteractionManagerEventType, listener: InteractionManagerListener): () => void {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return (): void => {
        set!.delete(listener);
      };
    },

    removeEventListener(type: InteractionManagerEventType, listener: InteractionManagerListener): void {
      listeners.get(type)?.delete(listener);
    },

    get stats(): InteractionManagerStats {
      return {
        activeToolId,
        eventCount,
      };
    },
  };

  return manager;
}

declare const __DEV__: boolean;
