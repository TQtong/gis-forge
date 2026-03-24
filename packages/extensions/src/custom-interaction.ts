/**
 * @file GeoForge L5 — EP6 Interaction Tool（自定义交互扩展点）
 *
 * @description
 * **EP6** 定义地图交互工具链：指针/键盘/滚轮事件经 `InteractionManager` 分发至 `activeTool`，
 * 工具可通过 `OverlayRenderer` 绘制测量辅助几何。`InteractionContext` 聚合相机、空间查询、
 * 覆盖层与表面（类型多为 `any`，避免 L3/L4 反向依赖）。
 */

/**
 * 扩展交互模块内部错误（结构化，便于上层映射为 `GeoForgeError`）。
 */
export class ExtensionInteractionError extends Error {
  /** 错误码（稳定枚举字符串）。 */
  public readonly code: string;
  /** 附加上下文（调试与遥测）。 */
  public readonly context: Record<string, unknown>;

  /**
   * @param code - 机器可读错误码
   * @param message - 人类可读说明
   * @param context - 可选上下文键值
   */
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExtensionInteractionError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, ExtensionInteractionError.prototype);
  }
}

/**
 * 归一化后的地图指针事件：与 DOM `PointerEvent` 解耦，附加地理与拾取结果。
 */
export interface MapPointerEvent {
  /** 相对视口的屏幕 X（CSS 像素）。 */
  readonly screenX: number;
  /** 相对视口的屏幕 Y（CSS 像素）。 */
  readonly screenY: number;
  /** 当前指针位置对应的经纬度（度）。 */
  readonly lngLat: [number, number];
  /**
   * 该点查询到的要素列表（引擎填充；类型为 `any[]` 避免 L0 依赖）。
   */
  readonly features: readonly any[];
  /** 原始指针事件（含 `type` 用于分相分发）。 */
  readonly originalEvent: PointerEvent;
  /** 主按键索引（DOM 约定）。 */
  readonly button: number;
  /** 位掩码：当前按住的所有键。 */
  readonly buttons: number;
  /** Ctrl 修饰键。 */
  readonly ctrlKey: boolean;
  /** Shift 修饰键。 */
  readonly shiftKey: boolean;
  /** Alt 修饰键。 */
  readonly altKey: boolean;
  /** Meta/Win 修饰键。 */
  readonly metaKey: boolean;
  /** 与 `preventDefault` 协作：标记是否应阻止浏览器默认行为。 */
  preventDefault(): void;
  /** 与 `stopPropagation` 协作：标记是否应停止向默认工具冒泡。 */
  stopPropagation(): void;
}

/**
 * 引擎注入给交互工具的上下文。
 */
export interface InteractionContext {
  /** 相机控制器或快照（类型由 L3 提供，此处为 `any`）。 */
  readonly camera: any;
  /** 空间查询服务（点选、范围内查询等）。 */
  readonly spatialQuery: any;
  /** 屏幕空间覆盖层绘制 API。 */
  readonly overlay: OverlayRenderer;
  /** 表面 / 画布抽象（`any`，通常为 L1 SurfaceManager）。 */
  readonly surface: any;
  /**
   * 屏幕 CSS 坐标 → 经纬度；失败返回 `null`（坐标在视界外等）。
   * @param x - CSS X
   * @param y - CSS Y
   */
  screenToLngLat(x: number, y: number): [number, number] | null;
  /**
   * 经纬度 → 屏幕 CSS 坐标；失败返回 `null`。
   * @param lng - 经度（度）
   * @param lat - 纬度（度）
   */
  lngLatToScreen(lng: number, lat: number): [number, number] | null;
}

/**
 * 线样式占位（具体字段由实现方约定）。
 */
export type LineStyle = Record<string, unknown>;

/**
 * 面填充样式占位。
 */
export type FillStyle = Record<string, unknown>;

/**
 * 点符号样式占位。
 */
export type MarkerStyle = Record<string, unknown>;

/**
 * 文字标注样式占位。
 */
export type TextStyle = Record<string, unknown>;

/**
 * 矢量覆盖层绘制器：返回可更新的 overlay id。
 */
export interface OverlayRenderer {
  /**
   * 绘制折线。
   * @param points - 扁平坐标序列 [x0,y0,...]（与当前投影一致）
   * @param style - 样式对象
   * @returns 覆盖层 id
   */
  drawLine(points: Float64Array, style: LineStyle): string;
  /**
   * 绘制多边形外环。
   * @param ring - 闭合环坐标
   * @param style - 样式
   */
  drawPolygon(ring: Float64Array, style: FillStyle): string;
  /**
   * 绘制圆（中心 + 半径，单位与投影一致）。
   */
  drawCircle(center: readonly [number, number], radius: number, style: FillStyle): string;
  /** 绘制点符号。 */
  drawMarker(position: readonly [number, number], style: MarkerStyle): string;
  /** 绘制屏幕对齐文字（位置为地图坐标）。 */
  drawText(position: readonly [number, number], text: string, style: TextStyle): string;
  /** 更新已有 overlay 几何。 */
  update(overlayId: string, geometry: Float64Array): void;
  /** 移除单个 overlay。 */
  remove(overlayId: string): void;
  /** 清空全部 overlay。 */
  removeAll(): void;
}

/**
 * 单交互工具实例：处理输入并可选渲染 GPU 覆盖。
 */
export interface InteractionTool {
  /** 工具 id（与 Registry 注册名一致）。 */
  readonly id: string;
  /** 显示名。 */
  readonly name: string;
  /** 可选：CSS `cursor` 字符串。 */
  readonly cursor?: string;
  /**
   * 激活时注入上下文（建立辅助状态）。
   * @param context - 引擎注入
   */
  activate(context: InteractionContext): void;
  /** 停用并释放临时状态。 */
  deactivate(): void;
  /** 可选：指针按下。返回 `true` 表示已消费。 */
  onPointerDown?(event: MapPointerEvent): boolean;
  /** 可选：指针移动。 */
  onPointerMove?(event: MapPointerEvent): boolean;
  /** 可选：指针抬起。 */
  onPointerUp?(event: MapPointerEvent): boolean;
  /** 可选：双击。 */
  onDoubleClick?(event: MapPointerEvent): boolean;
  /** 可选：单击。 */
  onClick?(event: MapPointerEvent): boolean;
  /** 可选：上下文菜单。 */
  onContextMenu?(event: MapPointerEvent): boolean;
  /** 可选：键盘按下。 */
  onKeyDown?(event: KeyboardEvent): boolean;
  /** 可选：键盘抬起。 */
  onKeyUp?(event: KeyboardEvent): boolean;
  /** 可选：滚轮。 */
  onWheel?(event: WheelEvent): boolean;
  /**
   * 可选：在本工具激活时附加 GPU 绘制。
   * @param encoder - 渲染通道
   * @param camera - 当前相机
   */
  renderOverlay?(encoder: GPURenderPassEncoder, camera: any): void;
  /** 订阅工具结果事件（测量完成等）。 */
  on(event: string, callback: (...args: unknown[]) => void): () => void;
  /** 取消订阅。 */
  off(event: string, callback: (...args: unknown[]) => void): void;
}

/**
 * 交互工具工厂：由 `ExtensionRegistry.registerInteraction` 持有。
 */
export type InteractionToolFactory = (options?: Record<string, unknown>) => InteractionTool;

/**
 * 可从 Registry 解析交互工厂的最小只读外观（避免 `index.ts` 循环依赖）。
 */
export type InteractionToolRegistryLike = {
  /**
   * 按 id 获取先前注册的工厂。
   * @param id - 工具 id
   */
  getInteraction(id: string): InteractionToolFactory | undefined;
};

/**
 * 管理工具激活、默认工具开关与事件分发的引擎服务接口。
 */
export interface InteractionManager {
  /**
   * 根据 id 实例化并激活工具（应暂停冲突的默认平移/缩放）。
   * @param toolId - 注册名
   * @param options - 传给工厂的选项
   */
  activateTool(toolId: string, options?: Record<string, unknown>): void;
  /** 停用当前工具并恢复默认交互。 */
  deactivateTool(): void;
  /** 当前激活实例（无则 `null`）。 */
  readonly activeTool: InteractionTool | null;
  /**
   * 控制内置默认工具是否启用（被禁用时仍应保留状态以便恢复）。
   * @param toolId - 内置工具类别
   * @param enabled - 是否启用
   */
  setDefaultToolEnabled(toolId: 'pan' | 'zoom' | 'rotate' | 'tilt', enabled: boolean): void;
  /** 将指针事件交给激活工具（及默认链）。 */
  dispatchPointerEvent(event: MapPointerEvent): void;
  /** 分发键盘事件。 */
  dispatchKeyEvent(event: KeyboardEvent): void;
  /** 分发滚轮事件。 */
  dispatchWheelEvent(event: WheelEvent): void;
}

/**
 * 构造用于 `activate` 的最小桩 `InteractionContext`（仅当引擎尚未注入真实上下文时使用）。
 *
 * @returns 可安全调用但无实际副作用的上下文
 *
 * @example
 * ```ts
 * const ctx = createStubInteractionContext();
 * tool.activate(ctx);
 * ```
 */
export function createStubInteractionContext(): InteractionContext {
  // 空 overlay：所有 draw 返回稳定 id，便于工具逻辑联调
  const noopOverlay: OverlayRenderer = {
    drawLine: (): string => {
      return 'overlay-line';
    },
    drawPolygon: (): string => {
      return 'overlay-polygon';
    },
    drawCircle: (): string => {
      return 'overlay-circle';
    },
    drawMarker: (): string => {
      return 'overlay-marker';
    },
    drawText: (): string => {
      return 'overlay-text';
    },
    update: (): void => {
      // 无状态：忽略更新
    },
    remove: (): void => {
      // 无状态：忽略删除
    },
    removeAll: (): void => {
      // 无状态：忽略清空
    },
  };

  return {
    camera: {},
    spatialQuery: {},
    overlay: noopOverlay,
    surface: {},
    screenToLngLat: (): null => {
      return null;
    },
    lngLatToScreen: (): null => {
      return null;
    },
  };
}

/**
 * 由 DOM `PointerEvent` 与拾取结果构造 `MapPointerEvent`。
 *
 * @param ev - 原始指针事件
 * @param lngLat - 已变换的经纬度
 * @param features - 查询结果要素
 * @returns 包装后的事件对象
 *
 * @example
 * ```ts
 * const ev = new PointerEvent('pointerdown');
 * const m = createMapPointerEvent(ev, [0, 0], []);
 * ```
 */
export function createMapPointerEvent(
  ev: PointerEvent,
  lngLat: [number, number],
  features: readonly any[],
): MapPointerEvent {
  return {
    screenX: ev.clientX,
    screenY: ev.clientY,
    lngLat,
    features,
    originalEvent: ev,
    button: ev.button,
    buttons: ev.buttons,
    ctrlKey: ev.ctrlKey,
    shiftKey: ev.shiftKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    preventDefault(): void {
      // 透传到原始事件，确保浏览器默认（如画布手势）可按工具意图取消
      ev.preventDefault();
    },
    stopPropagation(): void {
      ev.stopPropagation();
    },
  };
}

/**
 * 创建 `InteractionManager` 的轻量实现：跟踪 `activeTool` 并向其分发 DOM 事件。
 *
 * @param registry - 可选：用于 `activateTool` 查找 `InteractionToolFactory`
 * @returns 可立即使用的管理器实例
 *
 * @example
 * ```ts
 * const reg = { getInteraction: (_id: string) => undefined };
 * const mgr = createInteractionManager(reg);
 * mgr.dispatchKeyEvent(new KeyboardEvent('keydown'));
 * ```
 */
export function createInteractionManager(registry?: InteractionToolRegistryLike): InteractionManager {
  // 当前激活工具；为 null 时事件仅由默认工具链处理（此处为 no-op）
  let activeTool: InteractionTool | null = null;

  // 默认内置工具开关：全部默认开启
  const defaultEnabled = new Map<'pan' | 'zoom' | 'rotate' | 'tilt', boolean>([
    ['pan', true],
    ['zoom', true],
    ['rotate', true],
    ['tilt', true],
  ]);

  /**
   * 包装工厂调用与 `activate`，隔离异常，避免工具构造函数弄崩引擎。
   */
  const safeActivate = (tool: InteractionTool, context: InteractionContext): void => {
    try {
      tool.activate(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 激活失败时回滚 active，防止半激活状态
      throw new ExtensionInteractionError(
        'INTERACTION_ACTIVATE_FAILED',
        `activate failed: ${message}`,
        { toolId: tool.id },
      );
    }
  };

  const manager: InteractionManager = {
    get activeTool(): InteractionTool | null {
      return activeTool;
    },

    activateTool(toolId: string, options?: Record<string, unknown>): void {
      // 校验 id 非空，避免静默失败
      if (typeof toolId !== 'string' || toolId.trim().length === 0) {
        throw new ExtensionInteractionError('INTERACTION_TOOL_ID_INVALID', 'toolId must be non-empty', {});
      }

      if (!registry) {
        throw new ExtensionInteractionError(
          'INTERACTION_REGISTRY_MISSING',
          'createInteractionManager() was created without a registry; cannot activate tools',
          { toolId },
        );
      }

      const factory = registry.getInteraction(toolId.trim());
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
        throw new ExtensionInteractionError(
          'INTERACTION_TOOL_FACTORY_FAILED',
          `factory threw: ${message}`,
          { toolId },
        );
      }

      if (typeof next.activate !== 'function' || typeof next.deactivate !== 'function') {
        throw new ExtensionInteractionError(
          'INTERACTION_TOOL_INVALID_SHAPE',
          'tool must expose activate() and deactivate()',
          { toolId },
        );
      }

      // 先停旧工具，再激活新工具，顺序保证资源释放先于分配
      if (activeTool !== null) {
        try {
          activeTool.deactivate();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new ExtensionInteractionError(
            'INTERACTION_DEACTIVATE_FAILED',
            `previous tool deactivate failed: ${message}`,
            { previousId: activeTool.id },
          );
        }
      }

      const stubCtx = createStubInteractionContext();
      safeActivate(next, stubCtx);
      activeTool = next;
    },

    deactivateTool(): void {
      if (activeTool === null) {
        return;
      }
      try {
        activeTool.deactivate();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ExtensionInteractionError(
          'INTERACTION_DEACTIVATE_FAILED',
          `deactivate failed: ${message}`,
          { toolId: activeTool.id },
        );
      } finally {
        activeTool = null;
      }
    },

    setDefaultToolEnabled(toolId: 'pan' | 'zoom' | 'rotate' | 'tilt', enabled: boolean): void {
      // 显式 Boolean 归一，避免 truthy 字符串
      defaultEnabled.set(toolId, Boolean(enabled));
    },

    dispatchPointerEvent(event: MapPointerEvent): void {
      const tool = activeTool;
      if (tool === null) {
        return;
      }

      const domType = event.originalEvent.type;

      try {
        if (domType === 'pointerdown' && tool.onPointerDown) {
          tool.onPointerDown(event);
          return;
        }
        if (domType === 'pointermove' && tool.onPointerMove) {
          tool.onPointerMove(event);
          return;
        }
        if (domType === 'pointerup' && tool.onPointerUp) {
          tool.onPointerUp(event);
          return;
        }
        if (domType === 'pointercancel' && tool.onPointerUp) {
          tool.onPointerUp(event);
          return;
        }
        if (domType === 'click' && tool.onClick) {
          tool.onClick(event);
          return;
        }
        if (domType === 'dblclick' && tool.onDoubleClick) {
          tool.onDoubleClick(event);
          return;
        }
        if (domType === 'contextmenu' && tool.onContextMenu) {
          tool.onContextMenu(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ExtensionInteractionError(
          'INTERACTION_POINTER_HANDLER_FAILED',
          `pointer dispatch failed: ${message}`,
          { toolId: tool.id, domType },
        );
      }
    },

    dispatchKeyEvent(event: KeyboardEvent): void {
      const tool = activeTool;
      if (tool === null) {
        return;
      }

      try {
        if (event.type === 'keydown' && tool.onKeyDown) {
          tool.onKeyDown(event);
          return;
        }
        if (event.type === 'keyup' && tool.onKeyUp) {
          tool.onKeyUp(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ExtensionInteractionError(
          'INTERACTION_KEY_HANDLER_FAILED',
          `key dispatch failed: ${message}`,
          { toolId: tool.id, type: event.type },
        );
      }
    },

    dispatchWheelEvent(event: WheelEvent): void {
      const tool = activeTool;
      if (tool === null) {
        return;
      }
      if (!tool.onWheel) {
        return;
      }
      try {
        tool.onWheel(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ExtensionInteractionError(
          'INTERACTION_WHEEL_HANDLER_FAILED',
          `wheel dispatch failed: ${message}`,
          { toolId: tool.id },
        );
      }
    },
  };

  return manager;
}

/**
 * 最小可用的占位交互工具：空事件订阅，用于测试 `InteractionManager`。
 *
 * @param id - 工具 id
 * @param name - 显示名
 * @returns 满足 `InteractionTool` 的实例
 *
 * @example
 * ```ts
 * const t = createNoOpInteractionTool('noop', 'NoOp');
 * t.activate(createStubInteractionContext());
 * t.deactivate();
 * ```
 */
export function createNoOpInteractionTool(id: string, name: string): InteractionTool {
  const safeId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'noop-tool';
  const safeName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'No-Op';

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    id: safeId,
    name: safeName,
    activate(_context: InteractionContext): void {
      // 无状态
    },
    deactivate(): void {
      // 无状态
    },
    on(event: string, callback: (...args: unknown[]) => void): () => void {
      let bucket = listeners.get(event);
      if (!bucket) {
        bucket = new Set();
        listeners.set(event, bucket);
      }
      bucket.add(callback);
      return (): void => {
        bucket!.delete(callback);
      };
    },
    off(event: string, callback: (...args: unknown[]) => void): void {
      listeners.get(event)?.delete(callback);
    },
  };
}
