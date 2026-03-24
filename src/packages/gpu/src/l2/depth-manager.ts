// ============================================================
// l2/depth-manager.ts — Reversed-Z 深度缓冲 + 对数深度 WGSL 片段
// 层级：L2（渲染层）
// 职责：统一 depth32float 附件创建、深度比较/清除约定、对数深度
//       与线性化 WGSL 函数片段，供 ShaderAssembler 注入。
//
// 设计要点：
// - GeoForge 默认 Reversed-Z：clear 0.0、depthCompare「greater」
// - 深度纹理由本模块直接 device.createTexture（特殊格式，不经 TextureManager）
// - 返回 TextureHandle 与 L1 类型对齐，便于 BindGroup / 调试标签一致
// ============================================================

import type { TextureHandle } from '../l1/texture-manager.ts';
import { uniqueId } from '../../../core/src/infra/id.ts';
import logDepthVertexWgsl from '../wgsl/depth/log-depth-vertex.wgsl?raw';
import logDepthFragmentWgsl from '../wgsl/depth/log-depth-fragment.wgsl?raw';
import linearizeDepthWgsl from '../wgsl/depth/linearize-depth.wgsl?raw';

// ===================== 常量 =====================

/** 默认近裁剪面（米/世界单位），用于初始化与非法参数回退。 */
const DEFAULT_NEAR_PLANE = 0.1;

/** 默认远裁剪面（米/世界单位）。 */
const DEFAULT_FAR_PLANE = 1.0e7;

/** MSAA 开启时的采样数（与 Surface / Color 附件对齐）。 */
const SAMPLE_COUNT_MSAA = 4 as const;

/** 非 MSAA 时的采样数。 */
const SAMPLE_COUNT_SINGLE = 1 as const;

/** 浮点比较容差，用于判断 near/far 是否有效。 */
const EPS = 1.0e-6;

// ===================== 类型 =====================

/**
 * 深度缓冲与裁剪面配置快照。
 * 供 FrameGraph、Compositor 与管线状态读取。
 */
export interface DepthConfig {
  /** 是否使用 Reversed-Z（GeoForge 默认真；为 false 时回退传统 Z）。 */
  readonly useReversedZ: boolean;

  /** 是否启用对数深度（大场景 3D 建议开启，减轻 Z-fighting）。 */
  readonly useLogarithmicDepth: boolean;

  /** 近裁剪面距离（视图空间正数，与投影矩阵一致）。 */
  readonly nearPlane: number;

  /** 远裁剪面距离（视图空间正数，必须大于 nearPlane）。 */
  readonly farPlane: number;

  /** 深度附件格式；GeoForge 固定为 depth32float。 */
  readonly depthFormat: GPUTextureFormat;
}

/**
 * Reversed-Z / 对数深度管理器。
 * 创建 depth 纹理并提供 WGSL 注入片段与深度状态常量。
 */
export interface DepthManager {
  /** 当前裁剪面与选项的快照（随 updateClipPlanes 更新）。 */
  readonly config: DepthConfig;

  /**
   * 创建与当前 MSAA 设置匹配的 depth32float 纹理。
   *
   * @param width - 附件宽度（像素）
   * @param height - 附件高度（像素）
   * @returns 封装后的 TextureHandle（含默认 depth 视图）
   */
  createDepthTexture(width: number, height: number): TextureHandle;

  /** 深度比较函数：Reversed-Z 为「greater」，否则为「less」。 */
  readonly depthCompare: GPUCompareFunction;

  /** Pass 清除深度值：Reversed-Z 为 0.0，否则为 1.0。 */
  readonly clearDepthValue: number;

  /** 顶点阶段对数深度 WGSL 片段（含 struct 与入口函数）。 */
  readonly logDepthVertexCode: string;

  /** 片段阶段对数深度辅助 WGSL 片段（可选深度修正/导出）。 */
  readonly logDepthFragmentCode: string;

  /** 将采样深度还原为线性视空间距离的 WGSL 片段。 */
  readonly linearizeDepthCode: string;

  /**
   * 更新近/远裁剪面并刷新内部配置与 WGSL 中依赖的数值。
   *
   * @param near - 新的近裁剪面
   * @param far - 新的远裁剪面
   */
  updateClipPlanes(near: number, far: number): void;
}

// ===================== WGSL 片段生成 =====================

/**
 * 构建顶点阶段对数深度 WGSL 源码（依赖 GeoForgeLogDepthParams）。
 * 使用 view 空间前向距离 z_abs = max(-z_view, near) 与 log(C*z+1) 归一化。
 *
 * @returns 完整可编译的 WGSL 辅助代码字符串
 *
 * @example
 * const wgsl = buildLogDepthVertexWgsl();
 * const module = device.createShaderModule({ code: mainShader + wgsl });
 */
function buildLogDepthVertexWgsl(): string {
  return logDepthVertexWgsl;
}

/**
 * 构建片段阶段对数深度 WGSL（占位/调试用：从插值位置读归一化深度）。
 *
 * @returns WGSL 源码字符串
 *
 * @example
 * const fragAux = buildLogDepthFragmentWgsl();
 */
function buildLogDepthFragmentWgsl(): string {
  return logDepthFragmentWgsl;
}

/**
 * 构建线性化深度 WGSL：将 Reversed-Z 非线性深度转为视空间正距离。
 *
 * @returns WGSL 源码字符串
 *
 * @example
 * const linearWgsl = buildLinearizeDepthWgsl();
 */
function buildLinearizeDepthWgsl(): string {
  return linearizeDepthWgsl;
}

// ===================== 内部实现 =====================

/**
 * 校验纹理尺寸是否可用于 device 限制。
 *
 * @param device - WebGPU 设备
 * @param width - 宽度
 * @param height - 高度
 * @throws Error 当尺寸非法或超出限制时
 *
 * @example
 * assertTextureDimensions(device, 1024, 768);
 */
function assertTextureDimensions(device: GPUDevice, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('DepthManager: width/height must be finite numbers.');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('DepthManager: width/height must be integers (physical pixels).');
  }
  if (width <= 0 || height <= 0) {
    throw new Error('DepthManager: width/height must be positive.');
  }
  const limit = device.limits.maxTextureDimension2D;
  if (width > limit || height > limit) {
    throw new Error(
      `DepthManager: dimensions ${width}x${height} exceed maxTextureDimension2D (${limit}).`
    );
  }
}

/**
 * 校验近远裁剪面。
 *
 * @param near - 近裁剪面
 * @param far - 远裁剪面
 * @throws Error 当 near/far 非法或 near >= far 时
 *
 * @example
 * assertClipPlanes(0.1, 1e7);
 */
function assertClipPlanes(near: number, far: number): void {
  if (!Number.isFinite(near) || !Number.isFinite(far)) {
    throw new Error('DepthManager: near and far must be finite.');
  }
  if (near <= 0 || far <= 0) {
    throw new Error('DepthManager: near and far must be positive.');
  }
  if (!(near < far - EPS)) {
    throw new Error('DepthManager: near must be strictly less than far.');
  }
}

/**
 * 解析 MSAA 采样数：与颜色附件一致使用 1 或 4。
 * 若设备不支持 4x，`createTexture` 将抛错，上层可捕获并回退为 1。
 *
 * @param _device - 保留参数以便未来读取设备扩展限制（当前类型定义未暴露 maxSampleCount）
 * @param antialias - 是否请求 MSAA
 * @returns 1 或 4
 *
 * @example
 * const samples = resolveSampleCount(device, true);
 */
function resolveSampleCount(_device: GPUDevice, antialias: boolean): 1 | 4 {
  if (!antialias) {
    return SAMPLE_COUNT_SINGLE;
  }
  return SAMPLE_COUNT_MSAA;
}

/**
 * 构造 DepthManager 运行时实例（内部由 {@link createDepthManager} 调用）。
 *
 * @param device - WebGPU 设备
 * @param options - 初始反 Z、对数深度、裁剪面与 MSAA
 * @returns 满足 {@link DepthManager} 的实例
 *
 * @example
 * const dm = createDepthManagerImpl(device, {
 *   antialias: true,
 *   reversedZ: true,
 *   useLogarithmicDepth: false,
 *   initialNear: 0.1,
 *   initialFar: 1e6,
 * });
 */
function createDepthManagerImpl(
  device: GPUDevice,
  options: {
    readonly antialias: boolean;
    readonly reversedZ: boolean;
    readonly useLogarithmicDepth: boolean;
    readonly initialNear: number;
    readonly initialFar: number;
  }
): DepthManager {
  let nearPlane = options.initialNear;
  let farPlane = options.initialFar;
  const useReversedZ = options.reversedZ;
  const useLogarithmicDepth = options.useLogarithmicDepth;
  const sampleCount = resolveSampleCount(device, options.antialias);
  const depthFormat: GPUTextureFormat = 'depth32float';

  const logDepthVertexCode = buildLogDepthVertexWgsl();
  const logDepthFragmentCode = buildLogDepthFragmentWgsl();
  const linearizeDepthCode = buildLinearizeDepthWgsl();

  const depthCompare: GPUCompareFunction = useReversedZ ? 'greater' : 'less';
  const clearDepthValue = useReversedZ ? 0.0 : 1.0;

  const buildConfig = (): DepthConfig => ({
    useReversedZ,
    useLogarithmicDepth,
    nearPlane,
    farPlane,
    depthFormat,
  });

  return {
    get config(): DepthConfig {
      return buildConfig();
    },

    depthCompare,
    clearDepthValue,
    logDepthVertexCode,
    logDepthFragmentCode,
    linearizeDepthCode,

    createDepthTexture(width: number, height: number): TextureHandle {
      // 先校验尺寸，避免在 GPU 驱动层得到晦涩错误
      assertTextureDimensions(device, width, height);

      const label = `GeoForge.depth.${uniqueId('depth')}`;
      let texture: GPUTexture;
      try {
        // depth32float 仅用于深度附件；保留 TEXTURE_BINDING 以便后续拷贝/调试采样
        texture = device.createTexture({
          label,
          size: { width, height, depthOrArrayLayers: 1 },
          format: depthFormat,
          sampleCount,
          dimension: '2d',
          mipLevelCount: 1,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`DepthManager.createDepthTexture: createTexture failed — ${message}`);
      }

      let view: GPUTextureView;
      try {
        // depth-only 视图与 Framebuffer 绑定一致，避免误绑 stencil 面
        view = texture.createView({
          label: `${label}.view`,
          aspect: 'depth-only',
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          dimension: '2d',
        });
      } catch (err) {
        texture.destroy();
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`DepthManager.createDepthTexture: createView failed — ${message}`);
      }

      const id = uniqueId('tex');

      return {
        id,
        texture,
        view,
        width,
        height,
        format: depthFormat,
      };
    },

    updateClipPlanes(near: number, far: number): void {
      // 校验失败时保持原 near/far，不静默修改，避免相机与投影矩阵漂移
      assertClipPlanes(near, far);
      nearPlane = near;
      farPlane = far;
    },
  };
}

// ===================== 工厂 =====================

/**
 * 创建 {@link DepthManager}，封装 Reversed-Z 与对数深度 WGSL 及 depth32float 附件创建。
 *
 * @param device - 已请求的 `GPUDevice`
 * @param config - `antialias` 控制深度附件 sampleCount（与颜色 MSAA 对齐）；`reversedZ` 为 false 时使用传统深度比较与清除值
 * @returns 配置完成的 DepthManager 实例
 *
 * @example
 * const depth = createDepthManager(device, { antialias: true, reversedZ: true });
 * depth.updateClipPlanes(0.25, 1e7);
 * const handle = depth.createDepthTexture(1920, 1080);
 * // passEncoder.setPipeline(...); depthCompare === depth.depthCompare
 * // renderPassDescriptor.depthStencilAttachment.depthClearValue = depth.clearDepthValue;
 * handle.texture.destroy();
 */
export function createDepthManager(
  device: GPUDevice,
  config: { antialias: boolean; reversedZ: boolean }
): DepthManager {
  if (!device) {
    throw new Error('DepthManager: device is required.');
  }

  const initialNear = DEFAULT_NEAR_PLANE;
  const initialFar = DEFAULT_FAR_PLANE;

  try {
    assertClipPlanes(initialNear, initialFar);
  } catch {
    throw new Error('DepthManager: internal default clip planes are invalid.');
  }

  return createDepthManagerImpl(device, {
    antialias: config.antialias,
    reversedZ: config.reversedZ,
    useLogarithmicDepth: false,
    initialNear,
    initialFar,
  });
}
