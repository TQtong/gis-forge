/**
 * @file GIS-Forge L5 — EP5 Post-Process Pass（自定义后处理扩展点）
 *
 * @description
 * **EP5** 定义屏幕空间后处理链中的可插拔 Pass：`execute` 接收 `GPUCommandEncoder`，
 * 内部自行开始/结束子通道并绑定 `inputColor`/`outputColor`。
 * `PostProcessContext` 聚合设备与格式，以及 L2 服务占位（`any`）以避免跨包类型引用。
 */

/**
 * 引擎在 `setup` 时注入的上下文：设备、表面格式与可选 L2 服务句柄。
 */
export interface PostProcessContext {
  /** WebGPU 设备。 */
  readonly device: GPUDevice;
  /** 颜色附件格式。 */
  readonly format: GPUTextureFormat;
  /** 深度格式（与主场景一致，便于共享深度纹理视图）。 */
  readonly depthFormat: GPUTextureFormat;
  /**
   * 可选：L2 子系统聚合（ShaderAssembler、PipelineCache、Uploader 等），类型为 `any`。
   */
  readonly l2Services?: any;
}

/**
 * 中间纹理声明：供 FrameGraph 预分配。
 */
export interface PostProcessIntermediateTextureSpec {
  /** 逻辑名称（在 Pass 内查找）。 */
  readonly name: string;
  /** 像素格式。 */
  readonly format: GPUTextureFormat;
  /** 可选：相对视口比例（0.5 = 半分辨率）。 */
  readonly scale?: number;
}

/**
 * 后处理 Pass 实例接口。
 */
export interface PostProcessPass {
  /** Pass 唯一 id（链内去重）。 */
  readonly id: string;
  /** 可读名称（调试 UI）。 */
  readonly name: string;
  /** 链顺序：数值越小越早执行（具体排序由 Compositor 定义）。 */
  readonly order: number;
  /** 当前是否参与渲染。 */
  enabled: boolean;
  /**
   * 分配管线、缓冲与绑定组。
   * @param context - 引擎注入
   */
  setup(context: PostProcessContext): void;
  /** 释放 GPU 资源。 */
  destroy(): void;
  /**
   * 表面尺寸变化时重建与视口相关的资源。
   * @param width - 像素宽（正整数）
   * @param height - 像素高（正整数）
   */
  onResize(width: number, height: number): void;
  /**
   * 编码本 Pass：在 `encoder` 上提交命令，读 `input*` 写 `outputColor`。
   * @param encoder - 帧级命令编码器
   * @param inputColor - 输入颜色视图
   * @param inputDepth - 输入深度视图
   * @param outputColor - 输出颜色视图
   */
  execute(
    encoder: GPUCommandEncoder,
    inputColor: GPUTextureView,
    inputDepth: GPUTextureView,
    outputColor: GPUTextureView,
  ): void;
  /**
   * 设置 uniform（具体名称由 Pass WGSL 决定）。
   * @param name - uniform 名
   * @param value - 标量或向量分量展开
   */
  setUniform(name: string, value: number | readonly number[]): void;
  /**
   * 读取已缓存的 uniform；未设置时返回 `undefined`。
   * @param name - uniform 名
   */
  getUniform(name: string): number | readonly number[] | undefined;
  /**
   * 启用或禁用本 Pass（禁用时 `execute` 应快速返回）。
   * @param enabled - 是否启用
   */
  setEnabled(enabled: boolean): void;
  /** 可选：中间纹理需求列表。 */
  readonly intermediateTextures?: readonly PostProcessIntermediateTextureSpec[];
}

/**
 * `ExtensionRegistry.registerPostProcess` 使用的工厂。
 *
 * @param options - 用户选项
 * @returns 新的后处理 Pass 实例
 */
export type PostProcessPassFactory = (options?: Record<string, unknown>) => PostProcessPass;

/**
 * 无操作后处理：直接跳过（不复制），仅用于占位或性能基线。
 *
 * @param id - Pass id
 * @returns 禁用的 `PostProcessPass`
 *
 * @example
 * ```ts
 * const pass = createNoOpPostProcessPass('noop');
 * pass.setup({ device: dev, format: 'rgba8unorm', depthFormat: 'depth32float' } as PostProcessContext);
 * pass.destroy();
 * ```
 */
export function createNoOpPostProcessPass(id: string): PostProcessPass {
  const safeId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'noop-post';

  // 单一状态源：同时服务 `enabled` 字段与 `setEnabled` 方法
  let enabledFlag = false;

  return {
    id: safeId,
    name: 'No-Op',
    order: 0,
    get enabled(): boolean {
      return enabledFlag;
    },
    set enabled(v: boolean) {
      enabledFlag = Boolean(v);
    },
    setup(_context: PostProcessContext): void {
      // 无 GPU 资源
    },
    destroy(): void {
      // 无资源释放
    },
    onResize(width: number, height: number): void {
      // 忽略非法尺寸，避免 NaN 传播
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return;
      }
    },
    execute(
      _encoder: GPUCommandEncoder,
      _inputColor: GPUTextureView,
      _inputDepth: GPUTextureView,
      _outputColor: GPUTextureView,
    ): void {
      if (!enabledFlag) {
        return;
      }
      // 若启用仍无操作：生产环境应记录警告，此处保持静默
    },
    setUniform(_name: string, _value: number | readonly number[]): void {
      // 无 uniform 槽位
    },
    getUniform(_name: string): number | readonly number[] | undefined {
      return undefined;
    },
    setEnabled(enabled: boolean): void {
      enabledFlag = Boolean(enabled);
    },
  };
}
