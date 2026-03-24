// ============================================================
// l1/surface.ts — WebGPU 渲染表面管理器
// 层级：L1（GPU 层）
// 职责：管理 Canvas 的 GPUCanvasContext 配置、DPR 处理、MSAA 纹理、
//       resize 监听、坐标转换（CSS ↔ 物理像素 ↔ NDC）。
//
// 被引用于：L2/RenderGraph, L2/Compositor, L2/FrameGraphBuilder,
//           L3/FrameScheduler, L3/CameraController, L4/LabelManager
//
// 设计要点：
// - ResizeObserver 监听 Canvas 尺寸变化（比 window.resize 更准确）
// - matchMedia 监听 DPR 变化（用户拖动窗口到不同 DPI 屏幕）
// - MSAA 纹理在 sampleCount > 1 时自动创建和管理
// - 所有坐标转换方法均处理边界情况（零尺寸、NaN 等）
// ============================================================

import type { Viewport } from '../../../core/src/types/viewport.ts';

// ===================== SurfaceInitConfig =====================

/**
 * SurfaceManager 初始化配置。
 * 所有字段均可选——未提供时使用合理的默认值。
 */
export interface SurfaceInitConfig {
  /**
   * 设备像素比。
   * - 'auto'（默认）：使用 window.devicePixelRatio
   * - 数字：手动指定（如移动端降质时设为 1.0）
   */
  readonly devicePixelRatio?: number | 'auto';

  /**
   * 最大像素比上限。
   * 限制高 DPI 屏幕的实际渲染分辨率，防止 4K/5K 屏幕的 GPU 负载过高。
   * 默认值 2.0。范围 [1.0, +∞)。
   */
  readonly maxPixelRatio?: number;

  /**
   * MSAA 采样数。
   * 1 = 不使用 MSAA（默认），4 = 4× MSAA。
   * MSAA 需要额外的 multisample render target 纹理。
   */
  readonly sampleCount?: 1 | 4;

  /**
   * Canvas 的 alpha 混合模式。
   * 'opaque'（默认）：不透明背景，性能最好。
   * 'premultiplied'：预乘 alpha，支持半透明 Canvas。
   */
  readonly alphaMode?: GPUCanvasAlphaMode;
}

// ===================== SurfaceConfig（只读快照）=====================

/**
 * 当前渲染表面配置的只读快照。
 * 每次 resize 或 DPR 变化后更新。
 * 上层模块读取此对象获取渲染尺寸。
 */
export interface SurfaceConfig {
  /** Canvas DOM 元素引用。 */
  readonly canvas: HTMLCanvasElement;

  /** 当前生效的设备像素比（已受 maxPixelRatio 限制）。 */
  readonly devicePixelRatio: number;

  /** Canvas 逻辑宽度（CSS 像素）。 */
  readonly width: number;

  /** Canvas 逻辑高度（CSS 像素）。 */
  readonly height: number;

  /** Canvas 物理宽度（设备像素）= width × devicePixelRatio。 */
  readonly physicalWidth: number;

  /** Canvas 物理高度（设备像素）= height × devicePixelRatio。 */
  readonly physicalHeight: number;

  /** 当前 Canvas 纹理格式。 */
  readonly format: GPUTextureFormat;

  /** 当前 alpha 混合模式。 */
  readonly alphaMode: GPUCanvasAlphaMode;

  /** 当前 MSAA 采样数。 */
  readonly sampleCount: 1 | 4;
}

// ===================== SurfaceManager 接口 =====================

/**
 * 渲染表面管理器。
 * 管理 Canvas ↔ GPUCanvasContext 的配置、尺寸监听和 MSAA 纹理。
 *
 * @example
 * const surface = createSurfaceManager();
 * surface.initialize(canvas, device, { sampleCount: 4, maxPixelRatio: 2 });
 * surface.startResizeObserver();
 *
 * // 每帧获取当前纹理视图
 * const view = surface.getCurrentTextureView();
 * // 如果是 MSAA，获取 MSAA 纹理视图作为 render target
 * const msaaView = surface.getMSAATextureView();
 */
export interface SurfaceManager {
  /**
   * 初始化渲染表面。
   * 配置 GPUCanvasContext、计算 DPR、设置 Canvas 物理尺寸。
   *
   * @param canvas - HTMLCanvasElement DOM 元素
   * @param device - 已初始化的 GPUDevice
   * @param config - 可选初始化配置
   */
  initialize(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    config?: SurfaceInitConfig
  ): void;

  /** 当前表面配置的只读快照。未初始化时抛出。 */
  readonly config: SurfaceConfig;

  /**
   * 获取当前帧的 Canvas 纹理。
   * 每帧只应调用一次——后续调用返回同一 GPUTexture。
   * @returns 当前帧的 Canvas 纹理
   */
  getCurrentTexture(): GPUTexture;

  /**
   * 获取当前帧的 Canvas 纹理视图。
   * @returns 当前帧的纹理视图
   */
  getCurrentTextureView(): GPUTextureView;

  /**
   * 获取 MSAA 多重采样纹理视图。
   * 仅在 sampleCount > 1 时有效——MSAA 纹理作为 colorAttachment.view，
   * Canvas 纹理作为 colorAttachment.resolveTarget。
   * @returns MSAA 纹理视图，sampleCount === 1 时返回 null
   */
  getMSAATextureView(): GPUTextureView | null;

  /**
   * 手动触发 resize。
   * 更新 Canvas 物理尺寸、重新配置 context、重建 MSAA 纹理、通知回调。
   * 通常由 ResizeObserver 自动触发，也可手动调用。
   *
   * @param width - 新的逻辑宽度（CSS 像素），可选。未提供时从 canvas.clientWidth 读取。
   * @param height - 新的逻辑高度（CSS 像素），可选。未提供时从 canvas.clientHeight 读取。
   */
  resize(width?: number, height?: number): void;

  /**
   * 启动 ResizeObserver 监听 Canvas 尺寸变化。
   * 当 Canvas 的 content box 尺寸变化时自动调用 resize()。
   */
  startResizeObserver(): void;

  /** 停止 ResizeObserver。 */
  stopResizeObserver(): void;

  /**
   * 启动 DPR（设备像素比）变化监听。
   * 当用户拖动窗口到不同 DPI 屏幕时自动触发 resize。
   */
  startDPRObserver(): void;

  /** 停止 DPR 监听。 */
  stopDPRObserver(): void;

  /**
   * CSS 像素坐标 → 物理像素坐标。
   * @param cssX - CSS X 坐标
   * @param cssY - CSS Y 坐标
   * @returns [physicalX, physicalY]
   */
  cssToPhysical(cssX: number, cssY: number): [number, number];

  /**
   * 物理像素坐标 → CSS 像素坐标。
   * @param physicalX - 物理 X 坐标
   * @param physicalY - 物理 Y 坐标
   * @returns [cssX, cssY]
   */
  physicalToCSS(physicalX: number, physicalY: number): [number, number];

  /**
   * CSS 像素坐标 → NDC（Normalized Device Coordinates）。
   * NDC 范围：X ∈ [-1, 1], Y ∈ [-1, 1]。
   * 原点左下角（WebGPU 惯例），Y 轴向上。
   *
   * @param cssX - CSS X 坐标（Canvas 左上角为原点）
   * @param cssY - CSS Y 坐标（Canvas 左上角为原点）
   * @returns [ndcX, ndcY]
   */
  cssToNDC(cssX: number, cssY: number): [number, number];

  /**
   * 获取当前 Viewport 对象（符合 L0 Viewport 类型）。
   * @returns Viewport 快照
   */
  getViewport(): Viewport;

  /**
   * 注册 resize 回调。
   * 每次尺寸变化（包括 DPR 变化）时调用。
   * @param callback - 回调函数，参数为新的 SurfaceConfig
   * @returns 取消注册函数
   */
  onResize(callback: (config: SurfaceConfig) => void): () => void;

  /**
   * 销毁管理器，清理所有观察者和 GPU 资源。
   */
  destroy(): void;
}

// ===================== 内部常量 =====================

/** 默认最大像素比——防止超高 DPI 屏幕导致 GPU 过载 */
const DEFAULT_MAX_PIXEL_RATIO = 2.0;

/** Canvas 最小逻辑尺寸（CSS 像素）——防止零尺寸导致 GPU 错误 */
const MIN_CANVAS_SIZE = 1;

// ===================== 工厂函数 =====================

/**
 * 创建渲染表面管理器。
 * 管理 Canvas 的 GPUCanvasContext 配置、DPR 处理、MSAA 纹理、
 * 自动 resize 监听和坐标转换。
 *
 * @returns SurfaceManager 实例（未初始化状态）
 *
 * @example
 * const surface = createSurfaceManager();
 * const dm = createDeviceManager();
 * await dm.initialize();
 *
 * surface.initialize(document.getElementById('canvas') as HTMLCanvasElement, dm.device, {
 *   sampleCount: 4,
 *   maxPixelRatio: 2,
 *   alphaMode: 'opaque',
 * });
 *
 * surface.startResizeObserver();
 * surface.startDPRObserver();
 *
 * const unsub = surface.onResize((cfg) => {
 *   console.log(`Resized to ${cfg.physicalWidth}×${cfg.physicalHeight}`);
 * });
 *
 * // 帧循环中使用
 * const view = surface.getCurrentTextureView();
 * const msaa = surface.getMSAATextureView();
 *
 * // 清理
 * surface.destroy();
 */
export function createSurfaceManager(): SurfaceManager {
  // ==================== 内部状态 ====================

  /** Canvas 元素引用 */
  let canvas: HTMLCanvasElement | null = null;

  /** GPUDevice 引用 */
  let device: GPUDevice | null = null;

  /** GPUCanvasContext 引用 */
  let context: GPUCanvasContext | null = null;

  /** 当前表面配置（可变内部版本） */
  let currentConfig: {
    canvas: HTMLCanvasElement;
    devicePixelRatio: number;
    width: number;
    height: number;
    physicalWidth: number;
    physicalHeight: number;
    format: GPUTextureFormat;
    alphaMode: GPUCanvasAlphaMode;
    sampleCount: 1 | 4;
  } | null = null;

  /** 初始化配置缓存——供 DPR 变化时重新计算 */
  let initConfig: SurfaceInitConfig | undefined;

  /** MSAA 多重采样纹理——sampleCount > 1 时使用 */
  let msaaTexture: GPUTexture | null = null;

  /** MSAA 纹理视图缓存——避免每帧重建 */
  let msaaTextureView: GPUTextureView | null = null;

  /** ResizeObserver 实例 */
  let resizeObserver: ResizeObserver | null = null;

  /** DPR 变化监听的 MediaQueryList */
  let dprMediaQuery: MediaQueryList | null = null;

  /** DPR 变化监听的 handler 引用——用于 removeEventListener */
  let dprHandler: (() => void) | null = null;

  /** resize 回调集合 */
  const resizeCallbacks: Set<(config: SurfaceConfig) => void> = new Set();

  /** 是否已销毁 */
  let destroyed = false;

  // ==================== 内部辅助方法 ====================

  /**
   * 确保管理器已初始化。
   */
  function assertInitialized(): void {
    if (destroyed) {
      throw new Error('[SurfaceManager] Cannot use a destroyed SurfaceManager');
    }
    if (!context || !currentConfig) {
      throw new Error('[SurfaceManager] Not initialized. Call initialize() first.');
    }
  }

  /**
   * 计算当前生效的设备像素比。
   * 考虑用户指定值、'auto' 模式和 maxPixelRatio 上限。
   *
   * @param cfg - 初始化配置
   * @returns 实际使用的 DPR 值
   */
  function computeEffectiveDPR(cfg?: SurfaceInitConfig): number {
    // 确定基础 DPR 值
    let baseDPR: number;
    if (cfg?.devicePixelRatio === 'auto' || cfg?.devicePixelRatio === undefined) {
      // 'auto' 模式：使用系统 DPR，回退到 1.0
      baseDPR = typeof window !== 'undefined' ? window.devicePixelRatio : 1.0;
    } else {
      baseDPR = cfg.devicePixelRatio;
    }

    // 校验——NaN、Infinity、负数均回退到 1.0
    if (!Number.isFinite(baseDPR) || baseDPR <= 0) {
      baseDPR = 1.0;
    }

    // 应用 maxPixelRatio 上限
    const maxDPR = cfg?.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;
    const safeMaxDPR = Number.isFinite(maxDPR) && maxDPR >= 1.0 ? maxDPR : DEFAULT_MAX_PIXEL_RATIO;

    return Math.min(baseDPR, safeMaxDPR);
  }

  /**
   * 创建或重建 MSAA 纹理。
   * 仅在 sampleCount > 1 时调用。
   * 销毁旧纹理并创建新的匹配当前尺寸的多重采样纹理。
   */
  function recreateMSAATexture(): void {
    // 销毁旧 MSAA 纹理（如有）
    if (msaaTexture) {
      msaaTexture.destroy();
      msaaTexture = null;
      msaaTextureView = null;
    }

    // 只在 sampleCount > 1 时创建
    if (!currentConfig || currentConfig.sampleCount <= 1 || !device) {
      return;
    }

    // 创建多重采样纹理——尺寸必须与 Canvas 物理尺寸匹配
    msaaTexture = device.createTexture({
      label: 'geoforge-msaa-render-target',
      size: {
        width: currentConfig.physicalWidth,
        height: currentConfig.physicalHeight,
      },
      // 采样数必须与 render pipeline 的 multisample.count 一致
      sampleCount: currentConfig.sampleCount,
      format: currentConfig.format,
      // MSAA 纹理只用作 render attachment
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // 预创建纹理视图——避免每帧分配
    msaaTextureView = msaaTexture.createView({
      label: 'geoforge-msaa-render-target-view',
    });
  }

  /**
   * 配置 GPUCanvasContext 并更新内部状态。
   * 在初始化和 resize 时调用。
   *
   * @param cssWidth - 逻辑宽度（CSS 像素）
   * @param cssHeight - 逻辑高度（CSS 像素）
   */
  function configureContext(cssWidth: number, cssHeight: number): void {
    if (!context || !device || !canvas) return;

    // 计算当前 DPR
    const dpr = computeEffectiveDPR(initConfig);

    // 确保逻辑尺寸至少为 MIN_CANVAS_SIZE——防止零尺寸
    const safeWidth = Math.max(MIN_CANVAS_SIZE, Math.floor(cssWidth));
    const safeHeight = Math.max(MIN_CANVAS_SIZE, Math.floor(cssHeight));

    // 计算物理尺寸——必须为正整数
    const physicalWidth = Math.max(MIN_CANVAS_SIZE, Math.floor(safeWidth * dpr));
    const physicalHeight = Math.max(MIN_CANVAS_SIZE, Math.floor(safeHeight * dpr));

    // 设置 Canvas 的绘制缓冲区尺寸（物理像素）
    canvas.width = physicalWidth;
    canvas.height = physicalHeight;

    // 确定纹理格式和 alpha 模式
    const format = navigator.gpu.getPreferredCanvasFormat();
    const alphaMode = initConfig?.alphaMode ?? 'opaque';
    const sampleCount = initConfig?.sampleCount ?? 1;

    // 配置 GPUCanvasContext
    context.configure({
      device,
      format,
      alphaMode,
      // usage: RENDER_ATTACHMENT 是默认值，这里显式写出便于理解
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // 更新内部配置快照
    currentConfig = {
      canvas,
      devicePixelRatio: dpr,
      width: safeWidth,
      height: safeHeight,
      physicalWidth,
      physicalHeight,
      format,
      alphaMode,
      sampleCount: sampleCount as 1 | 4,
    };
  }

  /**
   * 通知所有 resize 回调。
   */
  function notifyResizeCallbacks(): void {
    if (!currentConfig) return;

    // 创建冻结的配置快照——防止回调意外修改
    const snapshot = Object.freeze({ ...currentConfig });
    for (const cb of resizeCallbacks) {
      try {
        cb(snapshot);
      } catch (err) {
        // 回调异常不应影响其他回调
        console.warn('[SurfaceManager] onResize callback threw:', err);
      }
    }
  }

  // ==================== 公开方法 ====================

  /**
   * 初始化渲染表面。
   * 获取 GPUCanvasContext、计算 DPR、配置 context、创建 MSAA 纹理。
   *
   * @param canvasEl - Canvas DOM 元素
   * @param gpuDevice - 已初始化的 GPUDevice
   * @param config - 可选配置
   *
   * @example
   * surface.initialize(canvas, device, { sampleCount: 4, maxPixelRatio: 2 });
   */
  function initialize(
    canvasEl: HTMLCanvasElement,
    gpuDevice: GPUDevice,
    config?: SurfaceInitConfig
  ): void {
    if (destroyed) {
      throw new Error('[SurfaceManager] Cannot initialize a destroyed SurfaceManager');
    }

    // 校验 canvas 参数
    if (!canvasEl || !(canvasEl instanceof HTMLCanvasElement)) {
      throw new Error('[SurfaceManager] initialize: canvas must be a valid HTMLCanvasElement');
    }

    // 校验 device 参数
    if (!gpuDevice) {
      throw new Error('[SurfaceManager] initialize: device must be a valid GPUDevice');
    }

    // 保存引用
    canvas = canvasEl;
    device = gpuDevice;
    initConfig = config;

    // 获取 WebGPU Canvas Context
    const ctx = canvas.getContext('webgpu');
    if (!ctx) {
      throw new Error(
        '[SurfaceManager] Failed to get WebGPU context from canvas. ' +
        'Ensure the canvas element supports WebGPU.'
      );
    }
    context = ctx;

    // 读取 Canvas 当前逻辑尺寸
    const cssWidth = canvas.clientWidth || MIN_CANVAS_SIZE;
    const cssHeight = canvas.clientHeight || MIN_CANVAS_SIZE;

    // 配置 context（设置物理尺寸、格式、alpha 模式）
    configureContext(cssWidth, cssHeight);

    // 创建 MSAA 纹理（如需要）
    recreateMSAATexture();
  }

  /**
   * 获取当前帧的 Canvas 纹理。
   *
   * @returns 当前帧的 GPUTexture
   *
   * @example
   * const texture = surface.getCurrentTexture();
   */
  function getCurrentTexture(): GPUTexture {
    assertInitialized();
    // getCurrentTexture() 每帧返回新的纹理——由 Canvas context 管理
    return context!.getCurrentTexture();
  }

  /**
   * 获取当前帧的 Canvas 纹理视图。
   *
   * @returns 当前帧的 GPUTextureView
   *
   * @example
   * const view = surface.getCurrentTextureView();
   */
  function getCurrentTextureView(): GPUTextureView {
    assertInitialized();
    // 每帧从 getCurrentTexture 创建视图——WebGPU 要求每帧获取
    return context!.getCurrentTexture().createView();
  }

  /**
   * 获取 MSAA 多重采样纹理视图。
   * sampleCount === 1 时返回 null。
   *
   * @returns MSAA 纹理视图或 null
   *
   * @example
   * const msaaView = surface.getMSAATextureView();
   * if (msaaView) {
   *   // 使用 MSAA 渲染路径
   *   colorAttachment.view = msaaView;
   *   colorAttachment.resolveTarget = surface.getCurrentTextureView();
   * }
   */
  function getMSAATextureView(): GPUTextureView | null {
    assertInitialized();
    // 如果 sampleCount 为 1 或纹理未创建，返回 null
    return msaaTextureView;
  }

  /**
   * 触发 resize——更新 Canvas 尺寸并重建相关资源。
   *
   * @param width - 可选，新的逻辑宽度（CSS 像素）
   * @param height - 可选，新的逻辑高度（CSS 像素）
   *
   * @example
   * // 手动指定尺寸
   * surface.resize(1920, 1080);
   * // 自动从 Canvas DOM 读取
   * surface.resize();
   */
  function resize(width?: number, height?: number): void {
    assertInitialized();

    // 如果未指定尺寸，从 Canvas DOM 元素读取
    const cssWidth = width ?? canvas!.clientWidth ?? MIN_CANVAS_SIZE;
    const cssHeight = height ?? canvas!.clientHeight ?? MIN_CANVAS_SIZE;

    // 校验尺寸——NaN、负数、Infinity 均使用最小值
    const safeWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : MIN_CANVAS_SIZE;
    const safeHeight = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : MIN_CANVAS_SIZE;

    // 重新配置 context——更新物理尺寸
    configureContext(safeWidth, safeHeight);

    // 重建 MSAA 纹理——尺寸已变化
    recreateMSAATexture();

    // 通知所有 resize 回调
    notifyResizeCallbacks();
  }

  /**
   * 启动 ResizeObserver 监听 Canvas 尺寸变化。
   *
   * @example
   * surface.startResizeObserver();
   */
  function startResizeObserver(): void {
    assertInitialized();

    // 防止重复创建——先清理旧的
    stopResizeObserver();

    // 创建 ResizeObserver 监听 Canvas 的 content box
    resizeObserver = new ResizeObserver((entries) => {
      // 取最后一个 entry——如果有多个变化只处理最终状态
      const entry = entries[entries.length - 1];
      if (!entry) return;

      // 使用 contentBoxSize（更准确）或 contentRect（回退）
      let cssWidth: number;
      let cssHeight: number;
      if (entry.contentBoxSize && entry.contentBoxSize.length > 0) {
        // contentBoxSize 是数组——取第一个（单个 Canvas 只有一个 box）
        cssWidth = entry.contentBoxSize[0].inlineSize;
        cssHeight = entry.contentBoxSize[0].blockSize;
      } else {
        // 回退到 contentRect
        cssWidth = entry.contentRect.width;
        cssHeight = entry.contentRect.height;
      }

      // 零尺寸时跳过——Canvas 可能被隐藏
      if (cssWidth <= 0 || cssHeight <= 0) return;

      // 触发 resize
      resize(cssWidth, cssHeight);
    });

    // 开始观察 Canvas 元素
    resizeObserver.observe(canvas!);
  }

  /**
   * 停止 ResizeObserver。
   *
   * @example
   * surface.stopResizeObserver();
   */
  function stopResizeObserver(): void {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  /**
   * 启动 DPR（设备像素比）变化监听。
   * 使用 matchMedia 监听 DPR 变化——当用户拖动窗口到不同 DPI 屏幕时触发。
   *
   * @example
   * surface.startDPRObserver();
   */
  function startDPRObserver(): void {
    assertInitialized();

    // 先停止旧的监听
    stopDPRObserver();

    // 安全检查——某些环境可能不支持 matchMedia
    if (typeof window === 'undefined' || !window.matchMedia) return;

    /**
     * 设置 DPR 变化监听。
     * matchMedia 需要针对特定 DPR 值创建查询——当 DPR 变化时需要重新创建。
     */
    function setupDPRListener(): void {
      // 获取当前 DPR
      const currentDPR = window.devicePixelRatio;

      // 创建针对当前 DPR 的 media query
      dprMediaQuery = window.matchMedia(`(resolution: ${currentDPR}dppx)`);

      // handler：DPR 变化时重新配置 surface
      dprHandler = () => {
        // 清除旧的监听器
        if (dprMediaQuery && dprHandler) {
          dprMediaQuery.removeEventListener('change', dprHandler);
        }

        // DPR 已变化——触发 resize（会重新计算物理尺寸）
        if (currentConfig) {
          resize(currentConfig.width, currentConfig.height);
        }

        // 重新设置监听器（针对新的 DPR 值）
        setupDPRListener();
      };

      // 注册变化监听
      dprMediaQuery.addEventListener('change', dprHandler);
    }

    setupDPRListener();
  }

  /**
   * 停止 DPR 监听。
   *
   * @example
   * surface.stopDPRObserver();
   */
  function stopDPRObserver(): void {
    if (dprMediaQuery && dprHandler) {
      dprMediaQuery.removeEventListener('change', dprHandler);
      dprMediaQuery = null;
      dprHandler = null;
    }
  }

  /**
   * CSS 像素坐标 → 物理像素坐标。
   *
   * @param cssX - CSS X 坐标
   * @param cssY - CSS Y 坐标
   * @returns [physicalX, physicalY] 物理像素坐标
   *
   * @example
   * // DPR = 2 时
   * surface.cssToPhysical(100, 200); // → [200, 400]
   */
  function cssToPhysical(cssX: number, cssY: number): [number, number] {
    assertInitialized();

    // 处理 NaN/Infinity——返回 [0, 0]
    if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) {
      return [0, 0];
    }

    const dpr = currentConfig!.devicePixelRatio;
    // 乘以 DPR 得到物理坐标
    return [cssX * dpr, cssY * dpr];
  }

  /**
   * 物理像素坐标 → CSS 像素坐标。
   *
   * @param physicalX - 物理 X 坐标
   * @param physicalY - 物理 Y 坐标
   * @returns [cssX, cssY] CSS 像素坐标
   *
   * @example
   * // DPR = 2 时
   * surface.physicalToCSS(200, 400); // → [100, 200]
   */
  function physicalToCSS(physicalX: number, physicalY: number): [number, number] {
    assertInitialized();

    // 处理 NaN/Infinity
    if (!Number.isFinite(physicalX) || !Number.isFinite(physicalY)) {
      return [0, 0];
    }

    const dpr = currentConfig!.devicePixelRatio;

    // 防止除零——DPR 在 initialize 时已校验为正数，但防御性检查
    if (dpr === 0) return [0, 0];

    // 除以 DPR 得到 CSS 坐标
    return [physicalX / dpr, physicalY / dpr];
  }

  /**
   * CSS 像素坐标 → NDC（Normalized Device Coordinates）。
   * NDC 原点为左下角（WebGPU 惯例），X 向右 [-1, 1]，Y 向上 [-1, 1]。
   * CSS 坐标原点为左上角，Y 向下。
   *
   * @param cssX - CSS X 坐标（Canvas 左上角为原点）
   * @param cssY - CSS Y 坐标（Canvas 左上角为原点，向下为正）
   * @returns [ndcX, ndcY] NDC 坐标
   *
   * @example
   * // Canvas 尺寸 800×600
   * surface.cssToNDC(400, 300); // → [0, 0] （中心点）
   * surface.cssToNDC(0, 0);     // → [-1, 1]（左上角）
   * surface.cssToNDC(800, 600); // → [1, -1]（右下角）
   */
  function cssToNDC(cssX: number, cssY: number): [number, number] {
    assertInitialized();

    // 处理 NaN/Infinity
    if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) {
      return [0, 0];
    }

    const w = currentConfig!.width;
    const h = currentConfig!.height;

    // 防止除零——尺寸在 configureContext 中已被钳位到 MIN_CANVAS_SIZE
    if (w === 0 || h === 0) return [0, 0];

    // X: [0, width] → [-1, 1]
    const ndcX = (cssX / w) * 2 - 1;

    // Y: [0, height] → [1, -1]（翻转——CSS Y向下，NDC Y向上）
    const ndcY = 1 - (cssY / h) * 2;

    return [ndcX, ndcY];
  }

  /**
   * 获取当前 Viewport 对象。
   * 符合 L0 types/viewport.ts 中的 Viewport 接口。
   *
   * @returns Viewport 只读快照
   *
   * @example
   * const vp = surface.getViewport();
   * console.log(`${vp.width}×${vp.height} @ ${vp.pixelRatio}x`);
   */
  function getViewport(): Viewport {
    assertInitialized();

    return {
      width: currentConfig!.width,
      height: currentConfig!.height,
      physicalWidth: currentConfig!.physicalWidth,
      physicalHeight: currentConfig!.physicalHeight,
      pixelRatio: currentConfig!.devicePixelRatio,
    };
  }

  /**
   * 注册 resize 回调。
   *
   * @param callback - 尺寸变化时调用
   * @returns 取消注册函数
   *
   * @example
   * const unsub = surface.onResize((cfg) => {
   *   console.log(`New size: ${cfg.physicalWidth}×${cfg.physicalHeight}`);
   * });
   * // 取消注册
   * unsub();
   */
  function onResize(callback: (config: SurfaceConfig) => void): () => void {
    if (destroyed) {
      throw new Error('[SurfaceManager] Cannot register callback on a destroyed SurfaceManager');
    }

    // 添加到回调集合
    resizeCallbacks.add(callback);

    // 返回取消注册函数
    return () => {
      resizeCallbacks.delete(callback);
    };
  }

  /**
   * 销毁管理器，释放所有资源和观察者。
   *
   * @example
   * surface.destroy();
   */
  function destroy(): void {
    if (destroyed) return;

    // 停止所有观察者
    stopResizeObserver();
    stopDPRObserver();

    // 销毁 MSAA 纹理
    if (msaaTexture) {
      msaaTexture.destroy();
      msaaTexture = null;
      msaaTextureView = null;
    }

    // unconfigure context——释放 Canvas 纹理
    if (context) {
      context.unconfigure();
      context = null;
    }

    // 清除所有回调
    resizeCallbacks.clear();

    // 清除引用
    canvas = null;
    device = null;
    currentConfig = null;
    initConfig = undefined;

    // 标记已销毁
    destroyed = true;
  }

  // ==================== 返回公开接口 ====================

  return {
    initialize,

    /** 当前表面配置快照。 */
    get config(): SurfaceConfig {
      assertInitialized();
      return Object.freeze({ ...currentConfig! });
    },

    getCurrentTexture,
    getCurrentTextureView,
    getMSAATextureView,
    resize,
    startResizeObserver,
    stopResizeObserver,
    startDPRObserver,
    stopDPRObserver,
    cssToPhysical,
    physicalToCSS,
    cssToNDC,
    getViewport,
    onResize,
    destroy,
  };
}
