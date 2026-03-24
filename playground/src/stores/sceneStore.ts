/* ═══════════════════════════════════════════════════════════════════════════
   sceneStore — 场景状态管理
   管理当前激活的场景 ID、场景配置值（ConfigPanel 修改后写入）、
   以及 GeoForge 引擎实例引用。
   ═══════════════════════════════════════════════════════════════════════════ */

import { create } from 'zustand';

/**
 * 场景 Store 的状态 + 动作定义。
 * 数据流：FeatureTree 点击 → setActiveScene → MapViewport 监听 → 加载场景
 *         ConfigPanel 修改 → setConfigValue → 引擎实时响应
 */
interface SceneState {
  // ─── State ───

  /**
   * 当前激活的场景 ID。
   * 对应功能树叶子节点的 id 字段，同时用于 URL hash 路由。
   * 默认值 'welcome' 表示首次加载时显示欢迎页。
   */
  activeSceneId: string;

  /**
   * 场景配置值的键值对。
   * key 与 ControlDefinition.key 对应，value 类型由控件类型决定：
   * - slider → number
   * - switch → boolean
   * - color  → string (hex)
   * - select → string (option value)
   *
   * ConfigPanel 修改时写入，引擎通过 store 订阅实时响应。
   * 切换场景时重置为空对象。
   */
  configValues: Record<string, unknown>;

  /**
   * GeoForge 引擎实例引用。
   * 在场景 onEnter 中设置，onLeave 中清空。
   * 类型为 any 因为引擎实例类型在 playground 中不可见
   * （playground 只通过 preset 公共 API 访问引擎）。
   * 此字段不应被序列化。
   */
  engineRef: unknown | null;

  // ─── Actions ───

  /**
   * 切换到指定场景。
   * 同时清空 configValues 和 engineRef，为新场景的 onEnter 做准备。
   *
   * @param id - 目标场景 ID（如 'p0-raster-tile-layer'）
   */
  setActiveScene: (id: string) => void;

  /**
   * 设置单个配置项的值。由 ConfigPanel 的各控件 onChange 调用。
   * 引擎端应通过 Zustand 的 subscribe 或 selector 监听变化并即时生效。
   *
   * @param key - 配置键名（如 'opacity'、'fillColor'）
   * @param value - 配置值（类型取决于控件类型）
   */
  setConfigValue: (key: string, value: unknown) => void;

  /**
   * 重置所有配置值为空对象。
   * 由 ConfigPanel 底部的 "重置默认" 按钮调用。
   * 重置后 ConfigPanel 应从 ControlDefinition.defaultValue 读取默认值重新渲染。
   */
  resetConfig: () => void;

  /**
   * 存储 GeoForge 引擎实例引用。
   * 在场景 onEnter 中调用，以便 InspectorPanel 等组件访问引擎状态。
   *
   * @param ref - 引擎实例，或 null（在 onLeave 时清空）
   */
  setEngineRef: (ref: unknown) => void;
}

/**
 * 场景状态 Zustand Store。
 *
 * @example
 * // 在组件中使用
 * const activeSceneId = useSceneStore((s) => s.activeSceneId);
 * const setActiveScene = useSceneStore((s) => s.setActiveScene);
 *
 * @example
 * // 在场景 onEnter 中设置引擎引用
 * useSceneStore.getState().setEngineRef(engineInstance);
 */
export const useSceneStore = create<SceneState>((set) => ({
  // ─── 初始状态 ───
  activeSceneId: 'welcome',
  configValues: {},
  engineRef: null,

  // ─── 动作实现 ───

  setActiveScene: (id: string) => {
    set({
      activeSceneId: id,
      configValues: {},
      engineRef: null,
    });
  },

  setConfigValue: (key: string, value: unknown) => {
    set((state) => ({
      configValues: { ...state.configValues, [key]: value },
    }));
  },

  resetConfig: () => {
    set({ configValues: {} });
  },

  setEngineRef: (ref: unknown) => {
    set({ engineRef: ref });
  },
}));
