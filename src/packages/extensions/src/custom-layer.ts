/**
 * @file GeoForge L5 — EP1 Custom Layer（自定义图层扩展点）
 *
 * @description
 * 本模块定义 **EP1：CustomLayer** 的引擎契约：扩展通过 `CustomLayerFactory` 产出图层实例，
 * 引擎在每帧注入 `CustomLayerContext`（WebGPU 设备、表面格式、相机/视口快照等）。
 * L5 仅声明类型与工厂签名；具体 Buffer/Pipeline 创建仍须经由引擎注入的 L1/L2 服务（此处用 `any` 占位以避免跨包引用）。
 *
 * @layer L5 extensions — 依赖方向：L6/L4 调用工厂 → EP1 接口；禁止扩展直接 import L1/L2 内部实现文件。
 */

/**
 * 引擎在 `onAdd` / 每帧渲染前注入给自定义图层的只读上下文。
 * L1/L2 具体服务类型用 `any` 保持 EP1 文件自洽（避免 `@geoforge/gpu` 等包耦合）。
 */
export interface CustomLayerContext {
  /** WebGPU 设备句柄（来自 L1 DeviceManager）。 */
  readonly device: GPUDevice;
  /** 主交换链 / 离屏颜色附件格式。 */
  readonly format: GPUTextureFormat;
  /** 深度附件格式（Reversed-Z 等策略由引擎统一）。 */
  readonly depthFormat: GPUTextureFormat;
  /** MSAA 采样数：1 或 4，与 L1 Surface 配置一致。 */
  readonly sampleCount: 1 | 4;
  /**
   * 当前帧相机状态快照（类型来自 L0 `CameraState`，此处用 `any` 避免扩展包硬依赖）。
   * @remarks 列主序矩阵、bearing 弧度等业务约定由引擎保证。
   */
  readonly camera: any;
  /**
   * 视口像素矩形与裁剪信息（L0 `Viewport` 语义）。
   */
  readonly viewport: any;
  /** 设备像素比（DPR），用于线宽/文字锐化等换算。 */
  readonly pixelRatio: number;
  /** 单调递增帧序号（用于时间抖动、缓存失效）。 */
  readonly frameIndex: number;
  /** 自地图启动起的秒级累计时间（秒，非负）。 */
  readonly elapsedTime: number;
  /**
   * 可选：L1 子系统聚合句柄（BufferPool / TextureManager / Uploader / …）。
   * 使用 `any` 以避免 EP1 文件对 L1 具体类型的反向依赖。
   */
  readonly l1Services?: any;
  /**
   * 可选：L2 子系统聚合句柄（ShaderAssembler / PipelineCache / …）。
   */
  readonly l2Services?: any;
}

/**
 * 用户实现的自定义图层实例接口。
 */
export interface CustomLayer {
  /** 图层唯一标识（与样式、调试、拾取键一致）。 */
  readonly id: string;
  /** 判别字段：固定为 `custom` 以参与图层分支。 */
  readonly type: 'custom';
  /**
   * 图层加入场景时调用一次，用于创建 GPU 资源、注册管线。
   * @param context - 引擎注入的运行时上下文
   */
  onAdd(context: CustomLayerContext): void;
  /**
   * 图层移除时调用，负责释放 GPU 与 CPU 侧资源。
   */
  onRemove(): void;
  /**
   * 主渲染入口：在此编码绘制命令到给定 `GPURenderPassEncoder`。
   * @param encoder - 当前渲染通道编码器
   * @param camera - 与上下文一致的相机快照（只读）
   */
  render(encoder: GPURenderPassEncoder, camera: any): void;
  /**
   * 可选：同步 CPU 拾取（例如读回或几何查询），返回命中结果或 `null`。
   * @param x - 视口 CSS 像素 X
   * @param y - 视口 CSS 像素 Y
   */
  pick?(x: number, y: number): any | null;
  /**
   * 可选：GPU 拾取编码（写入 picking buffer / 物体 ID）。
   * @param encoder - 拾取子通道编码器
   * @param camera - 当前相机
   */
  encodePicking?(encoder: GPURenderPassEncoder, camera: any): void;
  /** 可选：绑定投影模块 id（与 EP2 注册名一致）。 */
  readonly projection?: string;
  /** 可选：同投影分组内的排序键，越大越后绘（通常用于透明）。 */
  readonly renderOrder?: number;
  /** 可选：是否参与透明合成路径。 */
  readonly isTransparent?: boolean;
  /** 可选：是否参与本帧渲染（`false` 时引擎跳过）。 */
  readonly visible?: boolean;
  /** 可选：最小可见缩放级别（含）。 */
  readonly minZoom?: number;
  /** 可选：最大可见缩放级别（含）。 */
  readonly maxZoom?: number;
}

/**
 * 由 `ExtensionRegistry.registerLayer` 注册的工厂：给定用户 options 构造 `CustomLayer`。
 *
 * @param options - 用户图层配置（任意键值，需工厂自行校验）
 * @returns 新的图层实例（每次调用应返回独立实例，除非工厂明确实现单例）
 */
export type CustomLayerFactory = (options: Record<string, unknown>) => CustomLayer;

/**
 * 创建一个空操作的占位 `CustomLayer`，用于测试或作为默认实现的起点。
 *
 * @param id - 图层 id
 * @returns 不可见、无绘制的自定义图层实例
 *
 * @example
 * ```ts
 * const layer = createNoOpCustomLayer('debug-empty');
 * layer.onAdd(ctx as CustomLayerContext);
 * layer.render(encoder as GPURenderPassEncoder, {});
 * layer.onRemove();
 * ```
 */
export function createNoOpCustomLayer(id: string): CustomLayer {
  // 规范化 id：拒绝空串，避免引擎内部 Map 键异常
  const safeId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'custom-layer-empty';

  return {
    id: safeId,
    type: 'custom',
    visible: false,
    onAdd(_context: CustomLayerContext): void {
      // 无资源可创建；保留钩子供子类替换
    },
    onRemove(): void {
      // 无资源可释放
    },
    render(_encoder: GPURenderPassEncoder, _camera: any): void {
      // 故意不提交任何 draw call
    },
  };
}
