// ============================================================
// l1/device.ts — WebGPU 设备管理器
// 层级：L1（GPU 层）
// 职责：WebGPU Adapter/Device 的初始化、能力探测、设备丢失恢复。
//       是所有 GPU 操作的入口——L1 的其他模块均依赖 DeviceManager
//       提供的 device 和 queue。
//
// 被引用于：L1/BufferPool, L1/TextureManager, L1/SurfaceManager,
//           L1/BindGroupCache, L1/GPUUploader, L2/*, L3/ErrorRecovery
//
// 设计要点：
// - 检测 vendor/architecture 用于 workaround 分支
// - device.lost Promise 回调链支持多监听者
// - recreateDevice 在设备丢失后重建完整管线
// ============================================================

// ===================== GPUCapabilities =====================

/**
 * GPU 硬件能力描述。
 * 在 initialize 时从 GPUAdapter/GPUDevice 提取并冻结。
 * 上层模块根据此信息选择渲染路径（如禁用 timestamp query、降低纹理尺寸）。
 *
 * @example
 * if (!caps.supportsTimestampQuery) {
 *   // 使用 CPU 计时而非 GPU timestamp
 * }
 */
export interface GPUCapabilities {
  /**
   * 2D 纹理的最大宽/高像素数。
   * 对应 GPUDevice.limits.maxTextureDimension2D。
   * 典型值 8192（移动端）或 16384（桌面端）。
   */
  readonly maxTextureSize: number;

  /**
   * 单个 GPUBuffer 的最大字节数。
   * 对应 GPUDevice.limits.maxBufferSize。
   * 超过此大小的数据需拆分为多个 Buffer。
   */
  readonly maxBufferSize: number;

  /**
   * 单个 storage buffer binding 的最大字节数。
   * 对应 GPUDevice.limits.maxStorageBufferBindingSize。
   * 影响 Compute Shader 可访问的最大数据量。
   */
  readonly maxStorageBufferBindingSize: number;

  /**
   * 每个维度的最大工作组数量。
   * 对应 GPUDevice.limits.maxComputeWorkgroupsPerDimension。
   * 影响 Compute Shader dispatch 的最大网格尺寸。
   */
  readonly maxComputeWorkgroupsPerDimension: number;

  /**
   * 单个工作组的最大调用次数。
   * 对应 GPUDevice.limits.maxComputeInvocationsPerWorkgroup。
   * 典型值 256（最小保证值）。
   */
  readonly maxComputeInvocationsPerWorkgroup: number;

  /**
   * 是否支持 float32 纹理的线性过滤。
   * 对应 'float32-filterable' feature。
   * 不支持时需使用 nearest 采样或手动双线性插值。
   */
  readonly supportsFloat32Filterable: boolean;

  /**
   * 是否支持 GPU 时间戳查询。
   * 对应 'timestamp-query' feature。
   * 不支持时 RenderStats 回退到 CPU performance.now()。
   */
  readonly supportsTimestampQuery: boolean;

  /**
   * 是否支持 indirect draw 的 firstInstance 参数。
   * 对应 'indirect-first-instance' feature。
   * 不支持时 IndirectDrawManager 需要回退到非 indirect 路径。
   */
  readonly supportsIndirectFirstInstance: boolean;

  /**
   * 首选 Canvas 纹理格式。
   * 通过 navigator.gpu.getPreferredCanvasFormat() 获取。
   * 通常为 'bgra8unorm'（Windows/macOS）或 'rgba8unorm'（Android/Linux）。
   */
  readonly preferredCanvasFormat: GPUTextureFormat;

  /**
   * GPU 厂商名称。
   * 从 GPUAdapterInfo.vendor 或 description 推断。
   * 可能的值：'nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'unknown'。
   */
  readonly vendor: string;

  /**
   * GPU 架构名称。
   * 从 GPUAdapterInfo.architecture 获取。
   * 如 'ampere', 'rdna3', 'xe', 'apple gpu' 等。
   * 未提供时为空字符串。
   */
  readonly architecture: string;

  /**
   * GPU 描述字符串。
   * 从 GPUAdapterInfo.description 获取。
   * 如 'NVIDIA GeForce RTX 4090'。
   * 未提供时为空字符串。
   */
  readonly description: string;

  /**
   * 是否为移动端设备。
   * 从 User-Agent 推断——包含 'Mobile', 'Android', 'iPhone' 等关键词时为 true。
   * 移动端可能触发降质策略（降分辨率、减 Pass、激进 LOD）。
   */
  readonly isMobile: boolean;
}

// ===================== DeviceManager 接口 =====================

/**
 * WebGPU 设备管理器接口。
 * 封装 Adapter/Device 的完整生命周期管理。
 *
 * @example
 * const dm = createDeviceManager();
 * await dm.initialize({ powerPreference: 'high-performance' });
 * const device = dm.device;
 * const queue = dm.queue;
 * dm.onDeviceLost((reason) => console.error('GPU lost:', reason));
 */
export interface DeviceManager {
  /**
   * 初始化 WebGPU adapter 和 device。
   * 必须在使用 device/queue 之前调用，且只能成功初始化一次
   * （重复调用会先销毁旧资源再重新初始化）。
   *
   * @param config - 可选配置
   * @throws 当浏览器不支持 WebGPU 或 adapter 不可用时抛出错误
   */
  initialize(config?: { powerPreference?: GPUPowerPreference }): Promise<void>;

  /** 当前 GPUDevice 实例。未初始化时访问会抛出错误。 */
  readonly device: GPUDevice;

  /** 当前 GPUQueue 实例。未初始化时访问会抛出错误。 */
  readonly queue: GPUQueue;

  /** 硬件能力描述。未初始化时访问会抛出错误。 */
  readonly capabilities: GPUCapabilities;

  /** 是否已成功初始化。 */
  readonly isInitialized: boolean;

  /**
   * 注册设备丢失回调。
   * 支持多个回调，按注册顺序调用。
   * @param callback - 设备丢失时调用，参数为丢失原因描述
   * @returns 取消注册函数
   */
  onDeviceLost(callback: (reason: string) => void): () => void;

  /**
   * 重新创建 device（设备丢失后恢复）。
   * 销毁旧 device，重新走完整初始化流程。
   * 调用方需在此之后重建所有 GPU 资源。
   */
  recreateDevice(): Promise<void>;

  /**
   * 查询是否需要特定 workaround。
   * @param id - workaround 标识符
   * @returns 是否需要该 workaround
   */
  needsWorkaround(id: string): boolean;

  /**
   * 销毁设备管理器，释放所有资源。
   * 调用后不可再使用任何属性或方法。
   */
  destroy(): void;
}

// ===================== 已知 Workaround 标识符 =====================

/**
 * 已知的 GPU workaround 列表及其触发条件。
 * - "intel-arc-jitter": Intel Arc GPU 在某些着色器中产生顶点抖动
 * - "mobile-depth-precision": 移动端 GPU 深度精度不足（需更激进的 Reversed-Z near/far 比）
 * - "safari-texture-limit": Safari 中纹理尺寸限制比报告值更低
 */
const KNOWN_WORKAROUNDS: Readonly<Record<string, (caps: GPUCapabilities) => boolean>> = {
  /** Intel Arc GPU 顶点抖动——在特定驱动版本中 VS 输出精度异常 */
  'intel-arc-jitter': (caps) => caps.vendor === 'intel' && caps.description.toLowerCase().includes('arc'),

  /** 移动端深度精度——移动 GPU 的 depth buffer 精度通常低于桌面 */
  'mobile-depth-precision': (caps) => caps.isMobile,

  /** Safari 纹理尺寸限制——WebKit 实现有时比 limits 报告值更小 */
  'safari-texture-limit': (caps) =>
    typeof navigator !== 'undefined' && /safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent),
};

// ===================== 辅助函数 =====================

/**
 * 从 GPUAdapterInfo 推断 GPU 厂商名称。
 * 优先使用 adapterInfo.vendor 字段，回退到 description 关键词匹配。
 *
 * @param info - GPU 适配器信息对象
 * @returns 标准化的厂商名称字符串
 *
 * @example
 * detectVendor({ vendor: 'nvidia corporation', ... }) // → 'nvidia'
 */
function detectVendor(info: GPUAdapterInfo): string {
  // 将 vendor 和 description 合并为小写字符串用于匹配
  const combined = `${info.vendor ?? ''} ${info.description ?? ''}`.toLowerCase();

  // 按市场份额顺序匹配，优先命中率高的厂商
  if (combined.includes('nvidia')) return 'nvidia';
  if (combined.includes('amd') || combined.includes('radeon')) return 'amd';
  if (combined.includes('intel')) return 'intel';
  if (combined.includes('apple')) return 'apple';
  if (combined.includes('qualcomm') || combined.includes('adreno')) return 'qualcomm';
  if (combined.includes('arm') || combined.includes('mali')) return 'arm';

  // 无法识别时返回 unknown
  return 'unknown';
}

/**
 * 通过 User-Agent 检测是否为移动设备。
 * 在无 navigator 的环境中（如 Node.js / Worker）返回 false。
 *
 * @returns 是否为移动设备
 *
 * @example
 * detectMobile(); // → false (桌面 Chrome)
 */
function detectMobile(): boolean {
  // 安全检查——Worker 或 SSR 环境可能没有 navigator
  if (typeof navigator === 'undefined') {
    return false;
  }

  // 检查常见移动端 UA 关键词
  const ua = navigator.userAgent;
  return /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
}

/**
 * 从 GPUDevice 和 GPUAdapter 提取完整能力描述。
 *
 * @param device - 已创建的 GPUDevice
 * @param adapter - 请求 device 所用的 GPUAdapter
 * @returns 冻结的 GPUCapabilities 对象
 *
 * @example
 * const caps = extractCapabilities(device, adapter);
 * console.log(caps.maxTextureSize); // 16384
 */
function extractCapabilities(device: GPUDevice, adapter: GPUAdapter): GPUCapabilities {
  const limits = device.limits;
  // adapterInfo 由 requestAdapterInfo() 返回（已在初始化时调用）
  const info = adapter.info;

  // 检测可选 features——通过 Set.has 查询
  const features = device.features;

  const caps: GPUCapabilities = {
    maxTextureSize: limits.maxTextureDimension2D,
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,

    // 可选 feature 检测——不支持时为 false
    supportsFloat32Filterable: features.has('float32-filterable'),
    supportsTimestampQuery: features.has('timestamp-query'),
    supportsIndirectFirstInstance: features.has('indirect-first-instance'),

    // Canvas 格式——由 GPU 实现决定
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),

    // 厂商/架构信息
    vendor: detectVendor(info),
    architecture: info.architecture ?? '',
    description: info.description ?? '',

    // 移动端检测
    isMobile: detectMobile(),
  };

  // 冻结防止意外修改
  return Object.freeze(caps);
}

// ===================== 工厂函数 =====================

/**
 * 创建 WebGPU 设备管理器。
 * 管理 GPUAdapter → GPUDevice 的完整生命周期，提供能力检测、
 * 设备丢失回调、workaround 查询、和设备重建功能。
 *
 * @returns DeviceManager 实例（未初始化状态）
 *
 * @example
 * const dm = createDeviceManager();
 * await dm.initialize({ powerPreference: 'high-performance' });
 *
 * console.log(dm.capabilities.vendor);         // 'nvidia'
 * console.log(dm.capabilities.maxTextureSize); // 16384
 *
 * // 注册设备丢失回调
 * const unsub = dm.onDeviceLost((reason) => {
 *   console.error('Device lost:', reason);
 *   dm.recreateDevice();
 * });
 *
 * // 使用完毕后销毁
 * dm.destroy();
 */
export function createDeviceManager(): DeviceManager {
  // ==================== 内部状态 ====================

  /** 当前 GPUAdapter 引用，初始化后赋值 */
  let currentAdapter: GPUAdapter | null = null;

  /** 当前 GPUDevice 引用，初始化后赋值 */
  let currentDevice: GPUDevice | null = null;

  /** 冻结的硬件能力对象 */
  let currentCapabilities: GPUCapabilities | null = null;

  /** 设备丢失回调列表，支持多个监听者 */
  const lostCallbacks: Set<(reason: string) => void> = new Set();

  /** 上次初始化使用的配置，recreateDevice 时复用 */
  let lastConfig: { powerPreference?: GPUPowerPreference } | undefined;

  /** 标记是否已调用 destroy——防止销毁后使用 */
  let destroyed = false;

  // ==================== 内部方法 ====================

  /**
   * 确保管理器未被销毁。
   * 在所有公开方法入口处调用。
   */
  function assertNotDestroyed(): void {
    if (destroyed) {
      throw new Error('[DeviceManager] Cannot use a destroyed DeviceManager');
    }
  }

  /**
   * 确保管理器已初始化。
   * 在访问 device/queue/capabilities 时调用。
   */
  function assertInitialized(): void {
    assertNotDestroyed();
    if (!currentDevice) {
      throw new Error(
        '[DeviceManager] Not initialized. Call initialize() first.'
      );
    }
  }

  /**
   * 设置 device.lost 监听。
   * GPUDevice.lost 是一个 Promise，resolve 时表示设备丢失。
   * 我们在每次创建 device 后绑定此监听。
   */
  function setupDeviceLostHandler(device: GPUDevice): void {
    device.lost.then((info) => {
      // 如果已销毁则不触发回调——避免销毁后的副作用
      if (destroyed) return;

      // 构造人类可读的丢失原因
      const reason = info.message || info.reason || 'unknown';

      // 依次通知所有注册的回调
      for (const callback of lostCallbacks) {
        try {
          callback(reason);
        } catch (err) {
          // 回调抛出不应影响其他回调——吞掉异常并打印警告
          console.warn('[DeviceManager] onDeviceLost callback threw:', err);
        }
      }
    });
  }

  /**
   * 请求可选 feature 列表。
   * 只请求 adapter 实际支持的 feature，避免 requestDevice 因不支持的 feature 而失败。
   *
   * @param adapter - GPU 适配器
   * @returns 该适配器支持的可选 feature 列表
   */
  function getOptionalFeatures(adapter: GPUAdapter): GPUFeatureName[] {
    // 我们感兴趣的可选 feature 列表
    const desired: GPUFeatureName[] = [
      'float32-filterable',
      'timestamp-query',
      'indirect-first-instance',
    ];

    // 过滤出适配器实际支持的子集
    return desired.filter((f) => adapter.features.has(f));
  }

  // ==================== 公开方法 ====================

  /**
   * 初始化 WebGPU adapter 和 device。
   * 流程：检查 WebGPU 支持 → requestAdapter → requestDevice → 提取能力 → 绑定 lost 监听。
   *
   * @param config - 可选配置，如 powerPreference
   * @throws 浏览器不支持 WebGPU，或 adapter/device 不可用
   *
   * @example
   * await dm.initialize({ powerPreference: 'high-performance' });
   */
  async function initialize(
    config?: { powerPreference?: GPUPowerPreference }
  ): Promise<void> {
    assertNotDestroyed();

    // 如果已有 device，先销毁旧资源——支持重复初始化
    if (currentDevice) {
      currentDevice.destroy();
      currentDevice = null;
      currentAdapter = null;
      currentCapabilities = null;
    }

    // 保存配置——recreateDevice 时复用
    lastConfig = config;

    // 检查浏览器是否支持 WebGPU API
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new Error(
        '[DeviceManager] WebGPU is not supported in this browser. ' +
        'Ensure you are using a WebGPU-capable browser (Chrome 113+, Edge 113+, Firefox Nightly).'
      );
    }

    // 请求 GPU 适配器——传入电源偏好
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: config?.powerPreference ?? 'high-performance',
    });

    // adapter 为 null 表示没有可用的 GPU
    if (!adapter) {
      throw new Error(
        '[DeviceManager] No suitable GPU adapter found. ' +
        'The device may not have a compatible GPU, or the GPU may be blocked by the browser.'
      );
    }

    currentAdapter = adapter;

    // 收集适配器支持的可选 feature
    const optionalFeatures = getOptionalFeatures(adapter);

    // 请求 device——传入可选 feature 列表
    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({
        requiredFeatures: optionalFeatures,
        requiredLimits: {
          // 请求适配器支持的最大限制——充分利用硬件能力
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
          maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
          maxBindGroups: adapter.limits.maxBindGroups,
          maxDynamicUniformBuffersPerPipelineLayout: adapter.limits.maxDynamicUniformBuffersPerPipelineLayout,
          maxDynamicStorageBuffersPerPipelineLayout: adapter.limits.maxDynamicStorageBuffersPerPipelineLayout,
          maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
          maxSamplersPerShaderStage: adapter.limits.maxSamplersPerShaderStage,
          maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
          maxStorageTexturesPerShaderStage: adapter.limits.maxStorageTexturesPerShaderStage,
          maxUniformBuffersPerShaderStage: adapter.limits.maxUniformBuffersPerShaderStage,
          maxUniformBufferBindingSize: adapter.limits.maxUniformBufferBindingSize,
          maxVertexBuffers: adapter.limits.maxVertexBuffers,
          maxVertexAttributes: adapter.limits.maxVertexAttributes,
          maxVertexBufferArrayStride: adapter.limits.maxVertexBufferArrayStride,
          maxColorAttachments: adapter.limits.maxColorAttachments,
        },
      });
    } catch (err) {
      throw new Error(
        `[DeviceManager] Failed to create GPUDevice: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    currentDevice = device;

    // 提取并冻结硬件能力
    currentCapabilities = extractCapabilities(device, adapter);

    // 绑定设备丢失监听
    setupDeviceLostHandler(device);
  }

  /**
   * 注册设备丢失回调。
   * 返回取消注册函数（调用后不再收到通知）。
   *
   * @param callback - 设备丢失时调用
   * @returns 取消注册函数
   *
   * @example
   * const unsub = dm.onDeviceLost((reason) => {
   *   console.error('GPU device lost:', reason);
   * });
   * // 稍后取消监听
   * unsub();
   */
  function onDeviceLost(callback: (reason: string) => void): () => void {
    assertNotDestroyed();

    // 添加到回调集合
    lostCallbacks.add(callback);

    // 返回一次性的取消函数
    return () => {
      lostCallbacks.delete(callback);
    };
  }

  /**
   * 重新创建 device。
   * 用于设备丢失后的恢复——销毁旧 device 并重新走完整初始化流程。
   * 使用上次 initialize 的配置。
   *
   * @example
   * dm.onDeviceLost(async (reason) => {
   *   console.warn('Recovering from device loss:', reason);
   *   await dm.recreateDevice();
   *   // 重建所有 GPU 资源...
   * });
   */
  async function recreateDevice(): Promise<void> {
    assertNotDestroyed();

    // 尝试销毁旧 device——可能已处于 lost 状态但 destroy 仍安全
    if (currentDevice) {
      try {
        currentDevice.destroy();
      } catch {
        // device 可能已经 lost，destroy 可能抛出——安全忽略
      }
      currentDevice = null;
      currentAdapter = null;
      currentCapabilities = null;
    }

    // 使用上次的配置重新初始化
    await initialize(lastConfig);
  }

  /**
   * 查询是否需要特定的 GPU workaround。
   * 基于检测到的厂商、架构、移动端等信息判断。
   *
   * @param id - workaround 标识符（如 "intel-arc-jitter"）
   * @returns 是否需要该 workaround
   *
   * @example
   * if (dm.needsWorkaround('mobile-depth-precision')) {
   *   // 使用更激进的 near/far 比
   * }
   */
  function needsWorkaround(id: string): boolean {
    assertInitialized();

    // 查找已知 workaround 的检测函数
    const detector = KNOWN_WORKAROUNDS[id];

    // 未知的 workaround ID 返回 false——不阻塞调用方
    if (!detector) {
      return false;
    }

    // 用当前能力运行检测函数
    return detector(currentCapabilities!);
  }

  /**
   * 销毁设备管理器，释放所有 GPU 资源。
   * 调用后管理器不可再使用——所有方法会抛出错误。
   *
   * @example
   * dm.destroy();
   */
  function destroy(): void {
    if (destroyed) return;

    // 销毁 GPU device
    if (currentDevice) {
      try {
        currentDevice.destroy();
      } catch {
        // device 可能已 lost，安全忽略
      }
    }

    // 清除所有引用
    currentDevice = null;
    currentAdapter = null;
    currentCapabilities = null;
    lostCallbacks.clear();

    // 标记已销毁
    destroyed = true;
  }

  // ==================== 返回公开接口 ====================

  return {
    initialize,

    /** 当前 GPUDevice。未初始化时抛出错误。 */
    get device(): GPUDevice {
      assertInitialized();
      return currentDevice!;
    },

    /** 当前 GPUQueue。未初始化时抛出错误。 */
    get queue(): GPUQueue {
      assertInitialized();
      return currentDevice!.queue;
    },

    /** 硬件能力。未初始化时抛出错误。 */
    get capabilities(): GPUCapabilities {
      assertInitialized();
      return currentCapabilities!;
    },

    /** 是否已成功初始化。 */
    get isInitialized(): boolean {
      return currentDevice !== null && !destroyed;
    },

    onDeviceLost,
    recreateDevice,
    needsWorkaround,
    destroy,
  };
}
