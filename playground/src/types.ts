// ============================================================
// playground/src/types.ts
// DevPlayground 公共类型定义 — 场景配置、控件描述、日志、性能采样等。
// 所有 scene/*.ts 和 components/*.tsx 共享这些类型。
// ============================================================

// ============================================================
// 控件定义 — 右侧 ConfigPanel 动态渲染所需的元数据
// ============================================================

/**
 * 滑块控件定义。
 * 渲染为 shadcn Slider + 右侧数值显示。
 */
export interface SliderControl {
  /** 控件类型标识 */
  readonly type: 'slider';
  /** 唯一键名，用于 configValues 的 key */
  readonly key: string;
  /** 显示标签（中文或英文均可） */
  readonly label: string;
  /** 滑块最小值 */
  readonly min: number;
  /** 滑块最大值 */
  readonly max: number;
  /** 步进精度 */
  readonly step: number;
  /** 初始默认值 */
  readonly defaultValue: number;
}

/**
 * 开关控件定义。
 * 渲染为 shadcn Switch。
 */
export interface SwitchControl {
  /** 控件类型标识 */
  readonly type: 'switch';
  /** 唯一键名 */
  readonly key: string;
  /** 显示标签 */
  readonly label: string;
  /** 初始默认值 */
  readonly defaultValue: boolean;
}

/**
 * 颜色选择器控件定义。
 * 渲染为 <input type="color"> + hex 文本。
 */
export interface ColorControl {
  /** 控件类型标识 */
  readonly type: 'color';
  /** 唯一键名 */
  readonly key: string;
  /** 显示标签 */
  readonly label: string;
  /** 初始默认值（十六进制色值，如 '#3388ff'） */
  readonly defaultValue: string;
}

/**
 * 下拉选择控件定义。
 * 渲染为 shadcn Select。
 */
export interface SelectControl {
  /** 控件类型标识 */
  readonly type: 'select';
  /** 唯一键名 */
  readonly key: string;
  /** 显示标签 */
  readonly label: string;
  /** 可选项列表 */
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** 初始默认值（应匹配某个 option.value） */
  readonly defaultValue: string;
}

/**
 * 分组标题控件定义。
 * 仅用于在 ConfigPanel 中插入一条分隔线 + 分组名称。
 * 无 key / defaultValue。
 */
export interface GroupControl {
  /** 控件类型标识 */
  readonly type: 'group';
  /** 分组标题文字 */
  readonly label: string;
}

/**
 * 所有控件类型的联合体。
 * ConfigPanel 根据 `type` 字段判别渲染哪种控件。
 */
export type ControlDefinition =
  | SliderControl
  | SwitchControl
  | ColorControl
  | SelectControl
  | GroupControl;

// ============================================================
// 场景配置 — 每个功能树叶子节点对应一个场景
// ============================================================

/**
 * 场景配置对象。
 * 由 scenes/*.ts 文件默认导出，注册到 scenes/index.ts 的映射表中。
 *
 * 生命周期：
 * 1. 用户点击功能树 → MapViewport 调用 onEnter(container) 初始化
 * 2. 用户切换到其他场景 → 调用 onLeave() 清理资源
 * 3. 右侧 InspectorPanel 定期调用 getInspectorData() 获取运行时数据
 * 4. 右侧 CodePreview 调用 getSampleCode() 获取示例代码
 *
 * @example
 * const scene: SceneConfig = {
 *   id: 'p0-raster-tile-layer',
 *   name: 'RasterTileLayer 栅格瓦片',
 *   controls: [{ type: 'slider', key: 'opacity', ... }],
 *   onEnter(container) { ... },
 *   onLeave() { ... },
 *   getInspectorData() { return { ... }; },
 *   getSampleCode() { return '...'; },
 * };
 */
export interface SceneConfig {
  /** 场景唯一 ID，与 URL hash 路由对应，如 'p0-raster-tile-layer' */
  readonly id: string;

  /** 场景显示名称，展示在右侧面板标题处 */
  readonly name: string;

  /**
   * 右侧 ConfigPanel 的控件定义数组。
   * 控件按数组顺序从上到下渲染。
   * 空数组 = 该场景无可配置参数。
   */
  readonly controls: ReadonlyArray<ControlDefinition>;

  /**
   * 进入场景时调用。
   * 在 container DOM 中初始化渲染内容（Canvas / HTML / 引擎实例）。
   * 应将引擎引用存入 sceneStore.setEngineRef 供其他面板使用。
   *
   * @param container - MapViewport 提供的 div 容器（已挂载到 DOM）
   */
  onEnter(container: HTMLDivElement): void;

  /**
   * 离开场景时调用。
   * 清理所有资源：销毁引擎实例、移除事件监听、清空 container.innerHTML。
   * 确保不留内存泄漏。
   */
  onLeave(): void;

  /**
   * 获取当前运行时状态数据，供 InspectorPanel 展示。
   * 返回任意 key-value 结构，InspectorPanel 递归渲染。
   * 调用频率：约 10fps（由 InspectorPanel 内部节流）。
   *
   * @returns 运行时状态快照
   */
  getInspectorData(): Record<string, unknown>;

  /**
   * 获取当前场景对应的最小可运行示例代码。
   * 返回 TypeScript 源码字符串，由 CodePreview 使用 Shiki 高亮渲染。
   *
   * @returns TypeScript 代码字符串
   */
  getSampleCode(): string;
}
