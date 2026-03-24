// ============================================================
// l2/stencil-manager.ts — 深度+模板附件与常用 Stencil 预设
// 层级：L2（渲染层）
// 职责：提供 depth24plus-stencil8 纹理缓存及 polygonMask /
//       terrainDrape / invertedClassification 管线状态模板。
//
// 设计要点：
// - 模板纹理与 depth-only 的 depth32float 分离（本模块仅 D24S8）
// - 预设与 GeoForge Reversed-Z（depthCompare greater）对齐
// - setStencilReference 在 Pass 内由调用方设置，与预设配合使用
// ============================================================

// ===================== 常量 =====================

/** Stencil 附件与预设共用的深度+模板格式。 */
const STENCIL_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';

/** 模板测试读掩码（8 位模板缓冲全宽）。 */
const STENCIL_FULL_MASK = 0xff;

// ===================== 类型 =====================

/**
 * 模板缓冲管理器：缓存 D24S8 纹理并提供三种典型 GIS/三维场景预设。
 */
export interface StencilManager {
  /**
   * 获取与给定尺寸匹配的深度+模板附件纹理（内部缓存，尺寸变化时重建）。
   *
   * @param width - 附件宽度（物理像素）
   * @param height - 附件高度（物理像素）
   * @returns `depth24plus-stencil8` 格式的 GPUTexture
   */
  getStencilTexture(width: number, height: number): GPUTexture;

  /** 命名预设：多边形遮罩、地形叠盖、反相分类。 */
  readonly presets: {
    /**
     * 多边形遮罩：只写模板、不写颜色，用于后续裁剪矢量/注记。
     * 需配合 `setStencilReference(1)`。
     */
    readonly polygonMask: {
      /** 深度+模板状态：深度不写入、模板 replace。 */
      readonly depthStencilState: GPUDepthStencilState;
      /** 颜色掩码 0：完全禁止颜色写入。 */
      readonly colorWriteMask: GPUColorWriteFlags;
    };

    /**
     * 地形叠盖：先向模板+深度写入地形范围，再仅在与模板相等处绘制 draped 图层。
     * 两趟均需 `setStencilReference(2)` 以匹配写入/测试语义。
     */
    readonly terrainDrape: {
      /** 第一遍：写入深度与模板（Reversed-Z）。 */
      readonly writeState: GPUDepthStencilState;
      /** 第二遍：深度等于且模板等于时叠加。 */
      readonly testState: GPUDepthStencilState;
    };

    /**
     * 反相分类：在模板不等于参考值的片段上绘制（「挖洞」或反转分类区域）。
     * 需配合 `setStencilReference(3)` 作为比较基准（与分类 Pass 写入的模板值相对）。
     */
    readonly invertedClassification: {
      /** 深度测试保留，模板比较 not-equal。 */
      readonly depthStencilState: GPUDepthStencilState;
    };
  };
}

// ===================== 校验 =====================

/**
 * 校验模板附件尺寸是否合法且在设备限制内。
 *
 * @param device - WebGPU 设备
 * @param width - 宽度
 * @param height - 高度
 * @throws Error 当参数非有限、非正整数或超限时
 *
 * @example
 * assertStencilDimensions(device, 800, 600);
 */
function assertStencilDimensions(device: GPUDevice, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('StencilManager: width/height must be finite numbers.');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('StencilManager: width/height must be integers.');
  }
  if (width <= 0 || height <= 0) {
    throw new Error('StencilManager: width/height must be positive.');
  }
  const limit = device.limits.maxTextureDimension2D;
  if (width > limit || height > limit) {
    throw new Error(
      `StencilManager: dimensions ${width}x${height} exceed maxTextureDimension2D (${limit}).`
    );
  }
}

/**
 * 构建与 GeoForge Reversed-Z 一致的模板正面/背面状态（对称）。
 *
 * @param compare - 模板比较函数
 * @param passOp - 通过深度+模板测试时的操作
 * @returns 成对的 front/back 状态
 *
 * @example
 * const { stencilFront, stencilBack } = stencilFaceBoth('always', 'replace');
 */
function stencilFaceBoth(
  compare: GPUCompareFunction,
  passOp: GPUStencilOperation
): { stencilFront: GPUStencilFaceState; stencilBack: GPUStencilFaceState } {
  const face: GPUStencilFaceState = {
    compare,
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp,
  };
  return { stencilFront: face, stencilBack: { ...face } };
}

/**
 * 构建 polygonMask 预设使用的深度模板状态。
 *
 * @returns 适用于 depth24plus-stencil8 的 GPUDepthStencilState
 *
 * @example
 * const ds = buildPolygonMaskDepthStencilState();
 */
function buildPolygonMaskDepthStencilState(): GPUDepthStencilState {
  const { stencilFront, stencilBack } = stencilFaceBoth('always', 'replace');
  return {
    format: STENCIL_DEPTH_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'always',
    stencilFront,
    stencilBack,
    stencilReadMask: STENCIL_FULL_MASK,
    stencilWriteMask: STENCIL_FULL_MASK,
    depthBias: 0,
    depthBiasSlopeScale: 0,
    depthBiasClamp: 0,
  };
}

/**
 * 构建地形叠盖「写入」Pass 的深度模板状态。
 *
 * @returns 写深度 + 模板 replace（Reversed-Z greater）
 *
 * @example
 * const w = buildTerrainDrapeWriteState();
 */
function buildTerrainDrapeWriteState(): GPUDepthStencilState {
  const { stencilFront, stencilBack } = stencilFaceBoth('always', 'replace');
  return {
    format: STENCIL_DEPTH_FORMAT,
    depthWriteEnabled: true,
    depthCompare: 'greater',
    stencilFront,
    stencilBack,
    stencilReadMask: STENCIL_FULL_MASK,
    stencilWriteMask: STENCIL_FULL_MASK,
    depthBias: 0,
    depthBiasSlopeScale: 0,
    depthBiasClamp: 0,
  };
}

/**
 * 构建地形叠盖「测试」Pass 的深度模板状态。
 *
 * @returns 深度相等 + 模板相等（叠加层）
 *
 * @example
 * const t = buildTerrainDrapeTestState();
 */
function buildTerrainDrapeTestState(): GPUDepthStencilState {
  const stencilFront: GPUStencilFaceState = {
    compare: 'equal',
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp: 'keep',
  };
  const stencilBack: GPUStencilFaceState = { ...stencilFront };
  return {
    format: STENCIL_DEPTH_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'equal',
    stencilFront,
    stencilBack,
    stencilReadMask: STENCIL_FULL_MASK,
    stencilWriteMask: 0,
    depthBias: 0,
    depthBiasSlopeScale: 0,
    depthBiasClamp: 0,
  };
}

/**
 * 构建反相分类的深度模板状态。
 *
 * @returns 模板 not-equal 时通过，深度使用 Reversed-Z
 *
 * @example
 * const inv = buildInvertedClassificationState();
 */
function buildInvertedClassificationState(): GPUDepthStencilState {
  const stencilFront: GPUStencilFaceState = {
    compare: 'not-equal',
    failOp: 'keep',
    depthFailOp: 'keep',
    passOp: 'keep',
  };
  const stencilBack: GPUStencilFaceState = { ...stencilFront };
  return {
    format: STENCIL_DEPTH_FORMAT,
    depthWriteEnabled: false,
    depthCompare: 'greater',
    stencilFront,
    stencilBack,
    stencilReadMask: STENCIL_FULL_MASK,
    stencilWriteMask: 0,
    depthBias: 0,
    depthBiasSlopeScale: 0,
    depthBiasClamp: 0,
  };
}

// ===================== 工厂 =====================

/**
 * 创建 {@link StencilManager}，管理 depth24plus-stencil8 附件与三类预设。
 *
 * @param device - 有效的 `GPUDevice`
 * @returns 可复用纹理与只读预设表
 *
 * @example
 * const sm = createStencilManager(device);
 * const st = sm.getStencilTexture(1280, 720);
 * const pipeMask = device.createRenderPipeline({
 *   layout: 'auto',
 *   vertex: { module: vertMod, entryPoint: 'main' },
 *   fragment: { module: fragMod, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
 *   depthStencil: sm.presets.polygonMask.depthStencilState,
 *   multisample: { count: 1 },
 * });
 * // renderPass.setStencilReference(sm.presets... reference constants documented);
 * st.destroy();
 */
export function createStencilManager(device: GPUDevice): StencilManager {
  if (!device) {
    throw new Error('StencilManager: device is required.');
  }

  let cachedWidth = 0;
  let cachedHeight = 0;
  let cachedTexture: GPUTexture | null = null;

  const polygonMask = {
    depthStencilState: buildPolygonMaskDepthStencilState(),
    colorWriteMask: 0 as GPUColorWriteFlags,
  };

  const terrainDrape = {
    writeState: buildTerrainDrapeWriteState(),
    testState: buildTerrainDrapeTestState(),
  };

  const invertedClassification = {
    depthStencilState: buildInvertedClassificationState(),
  };

  const presets: StencilManager['presets'] = {
    polygonMask,
    terrainDrape,
    invertedClassification,
  };

  return {
    presets,

    getStencilTexture(width: number, height: number): GPUTexture {
      assertStencilDimensions(device, width, height);

      if (cachedTexture !== null && cachedWidth === width && cachedHeight === height) {
        return cachedTexture;
      }

      if (cachedTexture !== null) {
        cachedTexture.destroy();
        cachedTexture = null;
      }

      const label = `GeoForge.stencil.${width}x${height}`;
      let texture: GPUTexture;
      try {
        texture = device.createTexture({
          label,
          size: { width, height, depthOrArrayLayers: 1 },
          format: STENCIL_DEPTH_FORMAT,
          sampleCount: 1,
          dimension: '2d',
          mipLevelCount: 1,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`StencilManager.getStencilTexture: createTexture failed — ${message}`);
      }

      cachedTexture = texture;
      cachedWidth = width;
      cachedHeight = height;

      return cachedTexture;
    },
  };
}
