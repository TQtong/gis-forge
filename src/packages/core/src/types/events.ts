// ============================================================
// types/events.ts — 地图事件类型、指针事件、动画选项、日志级别
// 被引用于：L5/InteractionTool, L5/InteractionManager, L5/MapPointerEvent,
//          L6/Map2D, L6/Map25D, L6/Globe3D, L6/MapFull
//
// 事件与动画相关类型的唯一定义源（Single Source of Truth）。
// ============================================================

import type { PickResult } from './viewport.ts';

// ===================== 地图事件类型 =====================

/**
 * 地图事件类型字符串枚举。
 * 涵盖所有 GIS-Forge 地图实例可触发的事件，分为以下类别：
 *
 * **指针交互事件**：click, dblclick, contextmenu, mousedown/up/move, mouseenter/leave,
 *   touchstart/end/move, wheel
 * **相机运动事件**：movestart/move/moveend, zoomstart/zoom/zoomend,
 *   rotatestart/rotate/rotateend, pitchstart/pitch/pitchend
 * **生命周期事件**：load, idle, resize, remove
 * **数据事件**：data, sourcedata, tiledata, error
 * **渲染事件**：render, prerender, postrender
 *
 * @example
 * map.on('click', (e: MapPointerEvent) => { ... });
 * map.on('moveend', () => { ... });
 */
export type MapEventType =
  // 指针交互事件
  | 'click'
  | 'dblclick'
  | 'contextmenu'
  | 'mousedown'
  | 'mouseup'
  | 'mousemove'
  | 'mouseenter'
  | 'mouseleave'
  | 'touchstart'
  | 'touchend'
  | 'touchmove'
  | 'wheel'
  // 相机运动事件
  | 'movestart'
  | 'move'
  | 'moveend'
  | 'zoomstart'
  | 'zoom'
  | 'zoomend'
  | 'rotatestart'
  | 'rotate'
  | 'rotateend'
  | 'pitchstart'
  | 'pitch'
  | 'pitchend'
  // 生命周期事件
  | 'load'
  | 'idle'
  | 'resize'
  | 'remove'
  // 数据事件
  | 'data'
  | 'sourcedata'
  | 'tiledata'
  | 'error'
  // 渲染事件
  | 'render'
  | 'prerender'
  | 'postrender';

// ===================== 地图指针事件 =====================

/**
 * 地图指针事件。
 * 当用户与地图进行指针交互（鼠标/触摸）时触发。
 * 包含屏幕坐标、地理坐标、命中要素和原始 DOM 事件等信息。
 *
 * 由 InteractionManager 在 DOM 事件处理后封装，
 * 经过坐标反投影和异步拾取查询后分发给事件监听器。
 *
 * @example
 * map.on('click', (e: MapPointerEvent) => {
 *   console.log(`Clicked at ${e.lngLat}`);
 *   if (e.features.length > 0) {
 *     console.log('Hit feature:', e.features[0].featureId);
 *   }
 * });
 */
export interface MapPointerEvent {
  /**
   * 触发此事件的事件类型。
   * 与 map.on() 注册时的事件名称一致。
   */
  readonly type: MapEventType;

  /**
   * 指针在 Canvas 元素内的 X 坐标。
   * 单位：CSS 像素（逻辑像素），原点为 Canvas 左上角，向右为正。
   * 范围 [0, canvas.clientWidth]。
   */
  readonly screenX: number;

  /**
   * 指针在 Canvas 元素内的 Y 坐标。
   * 单位：CSS 像素（逻辑像素），原点为 Canvas 左上角，向下为正。
   * 范围 [0, canvas.clientHeight]。
   */
  readonly screenY: number;

  /**
   * 指针位置对应的地理坐标 [longitude, latitude]。
   * 单位：度（°）。
   * 通过 inverseVPMatrix 从屏幕坐标反投影计算得出。
   * 在 3D 模式下为射线与地球表面（或地形）的交点坐标。
   */
  readonly lngLat: [number, number];

  /**
   * 指针位置对应的海拔高度（米）。
   * 在有地形（terrain）或 3D 建筑的场景下提供准确高度值。
   * 无地形信息时为 undefined。
   * 可选。
   */
  readonly altitude?: number;

  /**
   * 在指针位置命中的要素拾取结果数组。
   * 按深度从近到远排序（Reversed-Z 下深度值从大到小）。
   * 空数组表示未命中任何要素。
   * 注意：拾取查询是异步的（GPU Readback），此数组在事件分发时已填充完毕。
   */
  readonly features: PickResult[];

  /**
   * 原始 DOM PointerEvent 对象。
   * 提供底层浏览器事件的完整信息（如 pressure、twist、pointerId 等）。
   * 用于需要访问原始事件详情的高级交互场景。
   */
  readonly originalEvent: PointerEvent;

  /**
   * 触发事件的鼠标按钮编号。
   * 遵循 DOM MouseEvent.button 规范：
   * - 0: 主按钮（通常左键）
   * - 1: 中键（滚轮按下）
   * - 2: 次按钮（通常右键）
   * - 3: 第四按钮（浏览器后退）
   * - 4: 第五按钮（浏览器前进）
   * 触摸事件时固定为 0。
   */
  readonly button: number;

  /**
   * Ctrl 键是否按下。
   * true = 用户在触发事件时按住了 Ctrl 键。
   * macOS 上 Ctrl+Click 等同于右键，由 InteractionManager 处理。
   */
  readonly ctrlKey: boolean;

  /**
   * Shift 键是否按下。
   * true = 用户在触发事件时按住了 Shift 键。
   * 常用于框选（box select）交互模式。
   */
  readonly shiftKey: boolean;

  /**
   * Alt 键是否按下。
   * true = 用户在触发事件时按住了 Alt 键。
   * 常用于旋转（rotate）交互修饰符。
   */
  readonly altKey: boolean;

  /**
   * 阻止事件的默认行为。
   * 调用后引擎内部的默认交互处理（如拖拽平移、滚轮缩放）将被跳过。
   * 用于自定义交互逻辑覆盖默认行为。
   */
  preventDefault(): void;

  /**
   * 停止事件向后续监听器传播。
   * 调用后同一事件类型的其他监听器将不再收到此事件。
   * 按注册顺序，后注册的监听器优先处理。
   */
  stopPropagation(): void;
}

// ===================== 飞行动画选项 =====================

/**
 * flyTo 飞行动画选项。
 * 控制相机从当前位置平滑过渡到目标位置的飞行动画参数。
 * 飞行曲线基于 van Wijk & Nuij (2003) 算法，
 * 实现"先缩小→飞行→再放大"的自然缩放效果。
 *
 * @example
 * map.flyTo({
 *   center: [116.39, 39.91],
 *   zoom: 15,
 *   bearing: 45,
 *   pitch: 60,
 *   duration: 3000,
 *   curve: 1.42,
 * });
 */
export interface FlyToOptions {
  /**
   * 目标中心点 [longitude, latitude]。
   * 单位：度（°）。
   * 可选，省略时保持当前中心点不变。
   */
  readonly center?: [number, number];

  /**
   * 目标缩放级别。
   * 连续值，范围 [0, 22]。
   * 可选，省略时保持当前缩放级别不变。
   */
  readonly zoom?: number;

  /**
   * 目标旋转角 / 方位角。
   * 单位：弧度。0 = 正北，正值顺时针旋转。
   * 可选，省略时保持当前方位角不变。
   */
  readonly bearing?: number;

  /**
   * 目标俯仰角。
   * 单位：弧度。0 = 正俯视。
   * 可选，省略时保持当前俯仰角不变。
   */
  readonly pitch?: number;

  /**
   * 动画持续时间。
   * 单位：毫秒（ms）。
   * 可选，默认由引擎根据飞行距离自动计算（约 2000~5000ms）。
   * 设为 0 可立即跳转（无动画）。
   * 范围 [0, +∞)。
   */
  readonly duration?: number;

  /**
   * 缓动函数。
   * 接受参数 t（归一化时间 [0, 1]），返回进度值 [0, 1]。
   * 用于控制动画速度曲线（如 ease-in-out、弹性等）。
   * 可选，默认 ease-in-out（三次贝塞尔）。
   *
   * @param t - 归一化时间，范围 [0, 1]，0 = 开始，1 = 结束
   * @returns 进度值，范围 [0, 1]
   *
   * @example
   * easing: (t) => t * t * (3 - 2 * t)  // smoothstep
   */
  readonly easing?: (t: number) => number;

  /**
   * 飞行曲线弧度系数（van Wijk & Nuij 参数）。
   * 控制飞行过程中的缩放弧度。
   * 值越大，飞行时"拉远"越多，视觉上飞行弧度越大。
   * 范围 (0, +∞)，典型值 1.42（默认）。
   * 可选，默认 1.42。
   */
  readonly curve?: number;

  /**
   * 视口内边距。
   * 飞行动画结束后，确保目标在考虑 padding 后仍然可见。
   * 用于在 UI 面板遮挡部分地图时将目标偏移到可见区域。
   * 单位：CSS 像素。每个方向可选，默认 0。
   * 可选。
   */
  readonly padding?: {
    /** 上边距（像素），默认 0 */
    readonly top?: number;
    /** 下边距（像素），默认 0 */
    readonly bottom?: number;
    /** 左边距（像素），默认 0 */
    readonly left?: number;
    /** 右边距（像素），默认 0 */
    readonly right?: number;
  };
}

// ===================== 通用动画选项 =====================

/**
 * 通用动画选项。
 * 用于 easeTo、zoomTo、rotateTo 等简单过渡动画。
 * 相比 FlyToOptions 更轻量，不含飞行曲线参数。
 *
 * @example
 * map.easeTo({
 *   duration: 500,
 *   easing: (t) => t,  // 线性
 * });
 */
export interface AnimationOptions {
  /**
   * 动画持续时间。
   * 单位：毫秒（ms）。
   * 可选，默认 300ms。
   * 设为 0 可立即生效（无动画）。
   * 范围 [0, +∞)。
   */
  readonly duration?: number;

  /**
   * 缓动函数。
   * 接受参数 t（归一化时间 [0, 1]），返回进度值 [0, 1]。
   * 可选，默认 ease-out（三次贝塞尔）。
   *
   * @param t - 归一化时间，范围 [0, 1]，0 = 开始，1 = 结束
   * @returns 进度值，范围 [0, 1]
   */
  readonly easing?: (t: number) => number;
}

// ===================== 日志级别 =====================

/**
 * 日志级别。
 * 控制 GIS-Forge 内部日志的输出粒度，由 Logger 模块使用。
 * 级别从低到高（详细到精简）：
 *
 * - `'debug'`: 调试信息（帧率、瓦片加载详情、管线创建等）
 * - `'info'`: 一般信息（初始化完成、样式加载成功等）
 * - `'warn'`: 警告（性能问题、降级处理、已废弃 API 使用等）
 * - `'error'`: 错误（GPU 丢失、网络失败、着色器编译错误等）
 * - `'none'`: 完全静默，不输出任何日志
 *
 * 设置某级别后，只输出该级别及更高级别的日志。
 *
 * @example
 * const level: LogLevel = 'warn'; // 只输出 warn 和 error
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
