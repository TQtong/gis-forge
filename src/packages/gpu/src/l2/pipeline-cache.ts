// ============================================================
// l2/pipeline-cache.ts — 渲染 / 计算管线缓存（GeoForge L2）
// 层级：L2（渲染层）
// 职责：按 PipelineDescriptor 与 WGSL 源码缓存 GPURenderPipeline /
//       GPUComputePipeline；统计命中、未命中与编译耗时；支持异步创建与预热。
// 约束：零 npm 依赖；仅使用 WebGPU 与 ShaderAssembler 拼装结果。
// ============================================================

import type { ShaderAssembler, ShaderVariantKey } from './shader-assembler.ts';

/** 开发构建时由打包器注入；未定义时按 false 处理，避免 `if (__DEV__)` 引用未声明全局量。 */
declare const __DEV__: boolean | undefined;

// ===================== 常量 =====================

/** 顶点输入步长（字节）：vec3+vec3+vec2+vec4，与 wgsl-templates VertexInput 一致。 */
const VERTEX_INPUT_STRIDE_BYTES = 48;

/** 默认顶点着色器入口名（GeoForge 模板约定）。 */
const VERTEX_ENTRY_POINT = 'vs_main';

/** 默认片元着色器入口名（GeoForge 模板约定）。 */
const FRAGMENT_ENTRY_POINT = 'fs_main';

/** 计算着色器默认入口名（ComputePassManager 与 getOrCreateCompute 约定）。 */
const COMPUTE_ENTRY_POINT = 'cs_main';

/** 单维 dispatch 最大 workgroup 数（WebGPU 规范）。 */
const MAX_WORKGROUP_COUNT_PER_DIMENSION = 65535;

/** localStorage 中保存「上次会话最常用的管线描述键」的键名（与 DevPlayground / 回顾文档 O2 一致）。 */
const LOCAL_STORAGE_PIPELINE_WARMUP_STATS_KEY = 'geoforge:pipeline-warmup-stats';

/** `saveSessionStats` 持久化的条数上限（取使用次数最多的前 N 条描述键）。 */
const SESSION_STATS_PERSIST_TOP_N = 20;

/**
 * 默认预热用的场景颜色附件格式（与多数 Surface / Canvas 配置一致；与具体描述键绑定后写入 sessionStats）。
 */
const DEFAULT_WARMUP_COLOR_FORMAT: GPUTextureFormat = 'bgra8unorm';

/**
 * 默认预热用的深度附件格式（GeoForge Reversed-Z 约定）。
 */
const DEFAULT_WARMUP_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** 默认预热管线：MSAA 采样数（无 MSAA）。 */
const DEFAULT_WARMUP_SAMPLE_COUNT = 1;

/**
 * 若运行环境与类型定义支持 `destroy()`，则销毁管线对象（兼容旧版 @webgpu/types）。
 *
 * @param pipeline - 渲染或计算管线
 */
function destroyPipelineIfSupported(pipeline: GPURenderPipeline | GPUComputePipeline): void {
  const maybe = pipeline as GPURenderPipeline & { destroy?: () => void };
  if (typeof maybe.destroy === 'function') {
    try {
      maybe.destroy();
    } catch {
      // 忽略驱动侧销毁异常，保证 clear 可继续
    }
  }
}

/** 用于 compute 缓存键的简单字符串哈希（djb2 变体），降低 Map 键长度。 */
function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
    hash = hash | 0;
  }
  return `djb2_${(hash >>> 0).toString(16)}_${input.length.toString(16)}`;
}

// ===================== 类型 =====================

/**
 * 渲染管线描述：着色器变体 + 固定功能状态 + 颜色/深度格式与 MSAA。
 * 全字段参与缓存键序列化；`blendState` 为 undefined 时表示不透明替换写入。
 */
export interface PipelineDescriptor {
  /** 着色器变体键（由 ShaderAssembler 拼装）。 */
  readonly shaderVariant: ShaderVariantKey;

  /** 图元拓扑（`triangle-list` 等）。 */
  readonly topology: GPUPrimitiveTopology;

  /** 面剔除模式。 */
  readonly cullMode: GPUCullMode;

  /** 深度比较函数（GeoForge 默认 Reversed-Z 为 `greater`）。 */
  readonly depthCompare: GPUCompareFunction;

  /** 是否写入深度缓冲。 */
  readonly depthWriteEnabled: boolean;

  /** 颜色附件混合状态；undefined 表示不混合（替换）。 */
  readonly blendState?: GPUBlendState;

  /** MSAA 采样数（1 或 4 等）。 */
  readonly sampleCount: number;

  /** 颜色附件格式。 */
  readonly colorFormat: GPUTextureFormat;

  /** 深度附件格式（通常为 `depth32float`）。 */
  readonly depthFormat: GPUTextureFormat;
}

/**
 * PipelineCache 统计：命中、未命中、缓存条目数、累计编译耗时（毫秒）。
 */
export interface PipelineCacheStats {
  /** 当前缓存的管线条数（渲染 + 计算）。 */
  readonly cacheSize: number;

  /** 缓存命中次数（getOrCreate / getOrCreateCompute 命中）。 */
  readonly cacheHits: number;

  /** 缓存未命中次数。 */
  readonly cacheMisses: number;

  /** 累计管线创建耗时（毫秒），含同步与异步路径完成后的增量。 */
  readonly compilationTimeMs: number;

  /**
   * 当前正在进行中的 `createRenderPipeline` / `createComputePipeline` 调用数（O8）。
   * 用于 UI 显示并发编译数。
   */
  readonly compilationQueue: number;
}

/**
 * `autoWarmup()` 可选参数：非阻塞编译完成后的进度回调（用于 UI 进度条）。
 */
export interface AutoWarmupOptions {
  /**
   * 每完成一条预热任务（成功或失败均计为一次完成）调用一次；`done` 从 1 递增到 `total`。
   *
   * @param done - 已完成条数（含失败跳过项）
   * @param total - 本次预热队列总条数
   */
  readonly onWarmupProgress?: (done: number, total: number) => void;
}

/**
 * 管线 GPU 编译（`createRenderPipeline` / `createComputePipeline`）进度事件（O8）。
 */
export interface CompileProgressEvent {
  /** 事件阶段：开始、结束或错误。 */
  readonly type: 'start' | 'done' | 'error';

  /** 缓存键或描述键（渲染为 `serializePipelineDescriptor` 输出，计算为 `djb2_…` 哈希键）。 */
  readonly key: string;

  /** 单次编译耗时（毫秒），在 `done` / `error` 时提供。 */
  readonly elapsed?: number;

  /** 批量预热总条数（如 `autoWarmup`）。 */
  readonly total?: number;

  /** 批量预热已完成条数（含缓存命中与失败跳过）。 */
  readonly completed?: number;
}

/**
 * `createPipelineCache` 可选配置（O8 编译进度回调）。
 */
export interface PipelineCacheCreateOptions {
  /**
   * 在每次调用 `device.createRenderPipeline` / `device.createComputePipeline` 前后触发，
   * 供 DevTools / 加载条使用。
   */
  readonly onCompileProgress?: (event: CompileProgressEvent) => void;
}

/**
 * 渲染与计算管线缓存接口。
 */
export interface PipelineCache {
  /**
   * 同步获取或创建渲染管线。
   *
   * @param descriptor - 管线描述
   * @returns 缓存或新创建的 `GPURenderPipeline`
   * @throws TypeError 当 descriptor 非法时
   * @throws Error 当 ShaderAssembler 或 GPU 创建失败时
   */
  getOrCreate(descriptor: PipelineDescriptor): GPURenderPipeline;

  /**
   * 异步获取或创建渲染管线（优先 `createRenderPipelineAsync`，不可用时回退同步）。
   *
   * @param descriptor - 管线描述
   * @returns 解析为 `GPURenderPipeline` 的 Promise
   */
  getOrCreateAsync(descriptor: PipelineDescriptor): Promise<GPURenderPipeline>;

  /**
   * 批量预热：按顺序为每个描述创建管线（异步优先），失败则拒绝 Promise。
   *
   * @param descriptors - 描述列表
   * @returns 全部完成时 resolve
   */
  warmup(descriptors: PipelineDescriptor[]): Promise<void>;

  /**
   * 是否已存在与描述等价的缓存项（序列化键一致）。
   *
   * @param descriptor - 管线描述
   * @returns 若渲染缓存命中则为 true
   */
  has(descriptor: PipelineDescriptor): boolean;

  /** 只读统计快照。 */
  readonly stats: PipelineCacheStats;

  /**
   * 当前飞行中的 GPU 管线编译数（与 `stats.compilationQueue` 相同）。
   */
  readonly compilationQueue: number;

  /**
   * 本会话内各「管线描述序列化键」被请求的次数（`getOrCreate` / `getOrCreateAsync` 每次命中或未命中均 +1）。
   * 键与内部 `serializePipelineDescriptor` 输出一致，可供 `saveSessionStats` 持久化。
   */
  readonly sessionStats: Readonly<Record<string, number>>;

  /**
   * 将当前 `sessionStats` 中使用次数最多的前 20 条描述键序列化写入 `localStorage`。
   * 写入失败（隐私模式、配额、非浏览器环境）时静默忽略并在 `__DEV__` 下输出原因。
   */
  saveSessionStats(): void;

  /**
   * 从 `localStorage` 读取上次 `saveSessionStats` 保存的描述键列表；无数据或解析失败时返回空数组。
   *
   * @returns 描述键字符串数组（每项为完整 JSON 管线描述，与 `serializePipelineDescriptor` 格式一致）
   */
  loadSessionStats(): string[];

  /**
   * 自动预热：优先根据 `loadSessionStats()` 恢复上次常用变体；若无则使用内置四类墨卡托组合（fill / line / circle / raster 语义映射至内置 geometry+style）。
   * 全部通过 `getOrCreateAsync` 异步编译，不阻塞调用线程；单条失败不影响其它条目。
   *
   * @param options - 可选进度回调
   * @returns 全部预热尝试结束时 resolve（不因单条编译失败而 reject）
   */
  autoWarmup(options?: AutoWarmupOptions): Promise<void>;

  /**
   * 清空缓存并销毁已创建的 GPU 管线对象。
   */
  clear(): void;

  /**
   * 同步获取或创建计算管线（以 WGSL 源码为键，入口固定为 `cs_main`）。
   *
   * @param shaderCode - 完整 WGSL 源码（须含 `@compute` 与 `cs_main`）
   * @param label - 可选调试标签
   * @returns `GPUComputePipeline`
   */
  getOrCreateCompute(shaderCode: string, label?: string): GPUComputePipeline;

  /**
   * 异步获取或创建计算管线。
   *
   * @param shaderCode - 完整 WGSL 源码
   * @param label - 可选调试标签
   * @returns `GPUComputePipeline` 的 Promise
   */
  getOrCreateComputeAsync(shaderCode: string, label?: string): Promise<GPUComputePipeline>;
}

/** 与 GeoForge 顶点模板一致的 `GPUVertexBufferLayout`（单流交错属性）。 */
const STANDARD_VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_INPUT_STRIDE_BYTES,
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
    { shaderLocation: 3, offset: 32, format: 'float32x4' },
  ],
};

/**
 * 将 `PipelineDescriptor` 全字段序列化为稳定字符串，用作 Map 键。
 *
 * @param descriptor - 管线描述
 * @returns JSON 字符串键
 * @throws Error 当序列化失败（如循环引用）时
 */
function serializePipelineDescriptor(descriptor: PipelineDescriptor): string {
  try {
    const payload = {
      shaderVariant: {
        projection: descriptor.shaderVariant.projection,
        geometry: descriptor.shaderVariant.geometry,
        style: descriptor.shaderVariant.style,
        features: [...descriptor.shaderVariant.features],
      },
      topology: descriptor.topology,
      cullMode: descriptor.cullMode,
      depthCompare: descriptor.depthCompare,
      depthWriteEnabled: descriptor.depthWriteEnabled,
      blendState: descriptor.blendState,
      sampleCount: descriptor.sampleCount,
      colorFormat: descriptor.colorFormat,
      depthFormat: descriptor.depthFormat,
    };
    return JSON.stringify(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`serializePipelineDescriptor failed: ${msg}`);
  }
}

/**
 * 校验 `PipelineDescriptor` 基本合法性（非 NaN、正样本数、非空变体字符串）。
 *
 * @param descriptor - 待校验描述
 * @throws TypeError 当参数不合法时
 */
function validatePipelineDescriptor(descriptor: PipelineDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('PipelineDescriptor must be a non-null object.');
  }
  const sv = descriptor.shaderVariant;
  if (!sv || typeof sv.projection !== 'string' || sv.projection.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.projection must be a non-empty string.');
  }
  if (typeof sv.geometry !== 'string' || sv.geometry.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.geometry must be a non-empty string.');
  }
  if (typeof sv.style !== 'string' || sv.style.length === 0) {
    throw new TypeError('PipelineDescriptor.shaderVariant.style must be a non-empty string.');
  }
  if (!Array.isArray(sv.features)) {
    throw new TypeError('PipelineDescriptor.shaderVariant.features must be an array.');
  }
  const sc = descriptor.sampleCount;
  if (!Number.isFinite(sc) || sc <= 0 || !Number.isInteger(sc)) {
    throw new TypeError('PipelineDescriptor.sampleCount must be a positive finite integer.');
  }
  if (typeof descriptor.colorFormat !== 'string' || descriptor.colorFormat.length === 0) {
    throw new TypeError('PipelineDescriptor.colorFormat must be a non-empty string.');
  }
  if (typeof descriptor.depthFormat !== 'string' || descriptor.depthFormat.length === 0) {
    throw new TypeError('PipelineDescriptor.depthFormat must be a non-empty string.');
  }
}

/**
 * 构造默认固定功能状态 + 给定着色变体的 `PipelineDescriptor`，供自动预热与默认四类墨卡托组合使用。
 *
 * @param shaderVariant - 投影 / 几何 / 样式 / 特性四元组
 * @returns 与 GeoForge 默认场景 Pass 一致的渲染管线描述
 */
function createBaseWarmupPipelineDescriptor(shaderVariant: ShaderVariantKey): PipelineDescriptor {
  return {
    shaderVariant,
    topology: 'triangle-list',
    cullMode: 'back',
    depthCompare: 'greater',
    depthWriteEnabled: true,
    blendState: undefined,
    sampleCount: DEFAULT_WARMUP_SAMPLE_COUNT,
    colorFormat: DEFAULT_WARMUP_COLOR_FORMAT,
    depthFormat: DEFAULT_WARMUP_DEPTH_FORMAT,
  };
}

/**
 * 内置 WGSL 模板下「fill / line / circle / raster + mercator」对应的四类变体（回顾文档 O2 默认回退）。
 * - fill：面填充 → `polygon` + `fill_solid`
 * - line：线符号 → `line` + `stroke`（与模板注释中宽线/描边配合）
 * - circle：圆点 → `point` + `fill_solid`
 * - raster：栅格瓦片在专用 style 注册前，用 `polygon` + `fill_gradient` 作为可编译的独立变体以预热不同样式模块
 *
 * @returns 长度固定为 4 的描述数组
 */
function buildDefaultMercatorWarmupDescriptors(): PipelineDescriptor[] {
  const fill: ShaderVariantKey = {
    projection: 'mercator',
    geometry: 'polygon',
    style: 'fill_solid',
    features: [],
  };
  const line: ShaderVariantKey = {
    projection: 'mercator',
    geometry: 'line',
    style: 'stroke',
    features: [],
  };
  const circle: ShaderVariantKey = {
    projection: 'mercator',
    geometry: 'point',
    style: 'fill_solid',
    features: [],
  };
  const raster: ShaderVariantKey = {
    projection: 'mercator',
    geometry: 'polygon',
    style: 'fill_gradient',
    features: [],
  };
  return [
    createBaseWarmupPipelineDescriptor(fill),
    createBaseWarmupPipelineDescriptor(line),
    createBaseWarmupPipelineDescriptor(circle),
    createBaseWarmupPipelineDescriptor(raster),
  ];
}

/**
 * 将 `serializePipelineDescriptor` 产出的 JSON 字符串还原为 `PipelineDescriptor`；用于从 `localStorage` 恢复的键。
 *
 * @param serialized - 与缓存键相同的 JSON 字符串
 * @returns 合法描述；解析或校验失败时返回 `null`（不抛错，便于跳过损坏条目）
 */
function parsePipelineDescriptorFromSerializedKey(serialized: string): PipelineDescriptor | null {
  if (!serialized || typeof serialized !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const svRaw = root['shaderVariant'];
  if (!svRaw || typeof svRaw !== 'object') {
    return null;
  }
  const sv = svRaw as Record<string, unknown>;
  const projection = sv['projection'];
  const geometry = sv['geometry'];
  const style = sv['style'];
  const features = sv['features'];
  if (typeof projection !== 'string' || projection.length === 0) {
    return null;
  }
  if (typeof geometry !== 'string' || geometry.length === 0) {
    return null;
  }
  if (typeof style !== 'string' || style.length === 0) {
    return null;
  }
  if (!Array.isArray(features)) {
    return null;
  }
  const featureList: string[] = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (typeof f !== 'string') {
      return null;
    }
    featureList.push(f);
  }
  const topology = root['topology'];
  const cullMode = root['cullMode'];
  const depthCompare = root['depthCompare'];
  const depthWriteEnabled = root['depthWriteEnabled'];
  const sampleCount = root['sampleCount'];
  const colorFormat = root['colorFormat'];
  const depthFormat = root['depthFormat'];
  if (typeof topology !== 'string' || topology.length === 0) {
    return null;
  }
  if (typeof cullMode !== 'string' || cullMode.length === 0) {
    return null;
  }
  if (typeof depthCompare !== 'string' || depthCompare.length === 0) {
    return null;
  }
  if (typeof depthWriteEnabled !== 'boolean') {
    return null;
  }
  if (typeof sampleCount !== 'number' || !Number.isFinite(sampleCount)) {
    return null;
  }
  if (typeof colorFormat !== 'string' || colorFormat.length === 0) {
    return null;
  }
  if (typeof depthFormat !== 'string' || depthFormat.length === 0) {
    return null;
  }
  const blendStateRaw = root['blendState'];
  let blendState: GPUBlendState | undefined;
  if (blendStateRaw !== undefined && blendStateRaw !== null) {
    if (typeof blendStateRaw !== 'object') {
      return null;
    }
    blendState = blendStateRaw as GPUBlendState;
  }
  const shaderVariant: ShaderVariantKey = {
    projection,
    geometry,
    style,
    features: featureList,
  };
  const descriptor: PipelineDescriptor = {
    shaderVariant,
    topology: topology as GPUPrimitiveTopology,
    cullMode: cullMode as GPUCullMode,
    depthCompare: depthCompare as GPUCompareFunction,
    depthWriteEnabled,
    blendState,
    sampleCount,
    colorFormat: colorFormat as GPUTextureFormat,
    depthFormat: depthFormat as GPUTextureFormat,
  };
  try {
    validatePipelineDescriptor(descriptor);
  } catch {
    return null;
  }
  return descriptor;
}

/**
 * 由 `localStorage` 读取原始 JSON 数组字符串并解析为描述键列表（模块级，供 `PipelineCache.loadSessionStats` 复用）。
 *
 * @returns 合法非空字符串键数组；失败时返回空数组
 */
function readPipelineWarmupStatsFromStorage(): string[] {
  if (typeof localStorage === 'undefined' || localStorage === null) {
    return [];
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOCAL_STORAGE_PIPELINE_WARMUP_STATS_KEY);
  } catch (err) {
    if (__DEV__) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PipelineCache] loadSessionStats: localStorage.getItem failed: ${msg}`);
    }
    return [];
  }
  if (raw === null || raw.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    if (__DEV__) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PipelineCache] loadSessionStats: JSON.parse failed: ${msg}`);
    }
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item === 'string' && item.length > 0) {
      out.push(item);
    }
  }
  return out;
}

/**
 * 由 `localStorage` 写入描述键 JSON 数组（模块级，供 `PipelineCache.saveSessionStats` 复用）。
 *
 * @param keys - 至多 20 条描述键（调用方已截断）
 */
function writePipelineWarmupStatsToStorage(keys: readonly string[]): void {
  if (typeof localStorage === 'undefined' || localStorage === null) {
    return;
  }
  let payload: string;
  try {
    payload = JSON.stringify(keys);
  } catch (err) {
    if (__DEV__) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PipelineCache] saveSessionStats: JSON.stringify failed: ${msg}`);
    }
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_PIPELINE_WARMUP_STATS_KEY, payload);
  } catch (err) {
    if (__DEV__) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PipelineCache] saveSessionStats: localStorage.setItem failed: ${msg}`);
    }
  }
}

/**
 * 由 `AssembledShader.bindGroupLayouts` 创建 `GPUPipelineLayout`；空数组时返回 `'auto'`。
 *
 * @param device - GPU 设备
 * @param bindGroupLayouts - BindGroup 布局描述数组
 * @returns `GPUPipelineLayout` 或字面量 `'auto'`
 */
function createRenderPipelineLayout(
  device: GPUDevice,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
): GPUPipelineLayout | 'auto' {
  if (bindGroupLayouts.length === 0) {
    return 'auto';
  }
  try {
    const layouts: GPUBindGroupLayout[] = [];
    for (let i = 0; i < bindGroupLayouts.length; i++) {
      layouts.push(device.createBindGroupLayout(bindGroupLayouts[i]!));
    }
    return device.createPipelineLayout({ bindGroupLayouts: layouts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`createRenderPipelineLayout failed at index binding: ${msg}`);
  }
}

/**
 * 创建 `PipelineCache` 实现。
 *
 * @param device - WebGPU 设备
 * @param shaderAssembler - 着色器拼装器
 * @returns `PipelineCache` 实例
 *
 * @example
 * const cache = createPipelineCache(device, shaderAssembler);
 * const pl = cache.getOrCreate(descriptor);
 */
export function createPipelineCache(
  device: GPUDevice,
  shaderAssembler: ShaderAssembler,
  options?: PipelineCacheCreateOptions
): PipelineCache {
  if (!device || typeof device.createShaderModule !== 'function') {
    throw new TypeError('createPipelineCache: device must be a valid GPUDevice.');
  }
  if (!shaderAssembler || typeof shaderAssembler.assemble !== 'function') {
    throw new TypeError('createPipelineCache: shaderAssembler must provide assemble().');
  }

  const onCompileProgress = options?.onCompileProgress;

  const renderCache = new Map<string, GPURenderPipeline>();
  const computeCache = new Map<string, GPUComputePipeline>();

  let cacheHits = 0;
  let cacheMisses = 0;
  let compilationTimeMs = 0;

  /** 飞行中的 `create*Pipeline` 调用数（O8） */
  let compilationQueue = 0;

  /**
   * 向调用方通知编译进度；回调异常时隔离，不中断编译。
   *
   * @param event - 进度事件
   */
  const emitCompileProgress = (event: CompileProgressEvent): void => {
    if (!onCompileProgress) {
      return;
    }
    try {
      onCompileProgress(event);
    } catch (err) {
      if (__DEV__) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PipelineCache] onCompileProgress callback threw: ${msg}`);
      }
    }
  };

  /** 本会话内各管线描述键（`serializePipelineDescriptor` 输出）的请求次数，供 `saveSessionStats` / 自动预热。 */
  const sessionUsageByKey = new Map<string, number>();

  /**
   * 累加 `sessionStats` 中对应描述键的计数（每次 `getOrCreate` / `getOrCreateAsync` 渲染路径调用一次）。
   *
   * @param key - `serializePipelineDescriptor` 的稳定字符串键
   */
  const recordSessionUsage = (key: string): void => {
    const prev = sessionUsageByKey.get(key) ?? 0;
    sessionUsageByKey.set(key, prev + 1);
  };

  /**
   * 记录一次编译耗时并累加到统计。
   *
   * @param startMs - performance.now() 起始时间
   */
  const addCompilationTime = (startMs: number): void => {
    const dt = performance.now() - startMs;
    if (Number.isFinite(dt) && dt >= 0) {
      compilationTimeMs += dt;
    }
  };

  /**
   * 内部：构建单条渲染管线（同步路径）。
   *
   * @param descriptor - 已校验的管线描述
   * @returns 新创建的 `GPURenderPipeline`
   */
  const buildRenderPipeline = (descriptor: PipelineDescriptor): GPURenderPipeline => {
    const t0 = performance.now();
    let assembled;
    try {
      assembled = shaderAssembler.assemble(descriptor.shaderVariant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ShaderAssembler.assemble failed: ${msg}`);
    }

    if (!assembled.vertexCode || assembled.vertexCode.trim().length === 0) {
      throw new Error('AssembledShader.vertexCode is empty.');
    }
    if (!assembled.fragmentCode || assembled.fragmentCode.trim().length === 0) {
      throw new Error('AssembledShader.fragmentCode is empty.');
    }

    let vertexModule: GPUShaderModule;
    let fragmentModule: GPUShaderModule;
    try {
      vertexModule = device.createShaderModule({
        label: `${assembled.key}-vertex`,
        code: assembled.vertexCode,
      });
      fragmentModule = device.createShaderModule({
        label: `${assembled.key}-fragment`,
        code: assembled.fragmentCode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule failed: ${msg}`);
    }

    let pipelineLayout: GPUPipelineLayout | 'auto';
    try {
      pipelineLayout = createRenderPipelineLayout(device, assembled.bindGroupLayouts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineLayout failed: ${msg}`);
    }

    const colorTarget: GPUColorTargetState = {
      format: descriptor.colorFormat,
      blend: descriptor.blendState,
    };

    let descriptorKey = '';
    try {
      descriptorKey = serializePipelineDescriptor(descriptor);
    } catch {
      descriptorKey = 'render:serialize-error';
    }

    let pipeline: GPURenderPipeline;
    compilationQueue += 1;
    emitCompileProgress({ type: 'start', key: descriptorKey });
    const pipelineCompileStart = performance.now();
    try {
      pipeline = device.createRenderPipeline({
        label: `render-${assembled.key}`,
        layout: pipelineLayout,
        vertex: {
          module: vertexModule,
          entryPoint: VERTEX_ENTRY_POINT,
          buffers: [STANDARD_VERTEX_BUFFER_LAYOUT],
        },
        fragment: {
          module: fragmentModule,
          entryPoint: FRAGMENT_ENTRY_POINT,
          targets: [colorTarget],
        },
        primitive: {
          topology: descriptor.topology,
          cullMode: descriptor.cullMode,
        },
        depthStencil: {
          format: descriptor.depthFormat,
          depthWriteEnabled: descriptor.depthWriteEnabled,
          depthCompare: descriptor.depthCompare,
        },
        multisample: {
          count: descriptor.sampleCount,
        },
      });
      emitCompileProgress({
        type: 'done',
        key: descriptorKey,
        elapsed: performance.now() - pipelineCompileStart,
      });
    } catch (err) {
      emitCompileProgress({
        type: 'error',
        key: descriptorKey,
        elapsed: performance.now() - pipelineCompileStart,
      });
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipeline failed: ${msg}`);
    } finally {
      compilationQueue -= 1;
    }

    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：构建计算管线（同步）。
   *
   * @param shaderCode - WGSL 源码
   * @param label - 调试标签
   * @returns `GPUComputePipeline`
   */
  const buildComputePipeline = (shaderCode: string, label: string | undefined): GPUComputePipeline => {
    const t0 = performance.now();
    if (!shaderCode || shaderCode.trim().length === 0) {
      throw new TypeError('getOrCreateCompute: shaderCode must be a non-empty string.');
    }
    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({ label: label ?? 'compute-shader', code: shaderCode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule (compute) failed: ${msg}`);
    }
    const computeKey = hashStringDjb2(shaderCode);

    let pipeline: GPUComputePipeline;
    compilationQueue += 1;
    emitCompileProgress({ type: 'start', key: computeKey });
    const computeCompileStart = performance.now();
    try {
      pipeline = device.createComputePipeline({
        label: label ?? 'compute-pipeline',
        layout: 'auto',
        compute: {
          module,
          entryPoint: COMPUTE_ENTRY_POINT,
        },
      });
      emitCompileProgress({
        type: 'done',
        key: computeKey,
        elapsed: performance.now() - computeCompileStart,
      });
    } catch (err) {
      emitCompileProgress({
        type: 'error',
        key: computeKey,
        elapsed: performance.now() - computeCompileStart,
      });
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createComputePipeline failed: ${msg}`);
    } finally {
      compilationQueue -= 1;
    }
    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：异步构建渲染管线。
   *
   * @param descriptor - 管线描述
   * @returns Promise<GPURenderPipeline>
   */
  const buildRenderPipelineAsync = async (descriptor: PipelineDescriptor): Promise<GPURenderPipeline> => {
    const t0 = performance.now();
    let assembled;
    try {
      assembled = shaderAssembler.assemble(descriptor.shaderVariant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ShaderAssembler.assemble failed: ${msg}`);
    }

    if (!assembled.vertexCode || !assembled.fragmentCode) {
      throw new Error('AssembledShader vertex/fragment code is empty.');
    }

    let vertexModule: GPUShaderModule;
    let fragmentModule: GPUShaderModule;
    try {
      vertexModule = device.createShaderModule({ label: `${assembled.key}-vertex`, code: assembled.vertexCode });
      fragmentModule = device.createShaderModule({
        label: `${assembled.key}-fragment`,
        code: assembled.fragmentCode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule failed: ${msg}`);
    }

    let pipelineLayout: GPUPipelineLayout | 'auto';
    try {
      pipelineLayout = createRenderPipelineLayout(device, assembled.bindGroupLayouts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineLayout failed: ${msg}`);
    }

    const colorTarget: GPUColorTargetState = {
      format: descriptor.colorFormat,
      blend: descriptor.blendState,
    };

    const desc: GPURenderPipelineDescriptor = {
      label: `render-${assembled.key}`,
      layout: pipelineLayout,
      vertex: {
        module: vertexModule,
        entryPoint: VERTEX_ENTRY_POINT,
        buffers: [STANDARD_VERTEX_BUFFER_LAYOUT],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: FRAGMENT_ENTRY_POINT,
        targets: [colorTarget],
      },
      primitive: {
        topology: descriptor.topology,
        cullMode: descriptor.cullMode,
      },
      depthStencil: {
        format: descriptor.depthFormat,
        depthWriteEnabled: descriptor.depthWriteEnabled,
        depthCompare: descriptor.depthCompare,
      },
      multisample: {
        count: descriptor.sampleCount,
      },
    };

    let descriptorKeyAsync = '';
    try {
      descriptorKeyAsync = serializePipelineDescriptor(descriptor);
    } catch {
      descriptorKeyAsync = 'render:serialize-error';
    }

    let pipeline: GPURenderPipeline;
    compilationQueue += 1;
    emitCompileProgress({ type: 'start', key: descriptorKeyAsync });
    const pipelineCompileStartAsync = performance.now();
    try {
      const asyncFn = device.createRenderPipelineAsync?.bind(device);
      if (typeof asyncFn === 'function') {
        pipeline = await asyncFn(desc);
      } else {
        pipeline = device.createRenderPipeline(desc);
      }
      emitCompileProgress({
        type: 'done',
        key: descriptorKeyAsync,
        elapsed: performance.now() - pipelineCompileStartAsync,
      });
    } catch (err) {
      emitCompileProgress({
        type: 'error',
        key: descriptorKeyAsync,
        elapsed: performance.now() - pipelineCompileStartAsync,
      });
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createRenderPipelineAsync failed: ${msg}`);
    } finally {
      compilationQueue -= 1;
    }

    addCompilationTime(t0);
    return pipeline;
  };

  /**
   * 内部：异步构建计算管线。
   *
   * @param shaderCode - WGSL
   * @param label - 标签
   */
  const buildComputePipelineAsync = async (
    shaderCode: string,
    label: string | undefined,
  ): Promise<GPUComputePipeline> => {
    const t0 = performance.now();
    if (!shaderCode || shaderCode.trim().length === 0) {
      throw new TypeError('getOrCreateComputeAsync: shaderCode must be non-empty.');
    }
    let module: GPUShaderModule;
    try {
      module = device.createShaderModule({ label: label ?? 'compute-shader', code: shaderCode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createShaderModule (compute) failed: ${msg}`);
    }
    const desc: GPUComputePipelineDescriptor = {
      label: label ?? 'compute-pipeline',
      layout: 'auto',
      compute: {
        module,
        entryPoint: COMPUTE_ENTRY_POINT,
      },
    };
    const computeKeyAsync = hashStringDjb2(shaderCode);

    let pipeline: GPUComputePipeline;
    compilationQueue += 1;
    emitCompileProgress({ type: 'start', key: computeKeyAsync });
    const computeCompileStartAsync = performance.now();
    try {
      const asyncFn = device.createComputePipelineAsync?.bind(device);
      if (typeof asyncFn === 'function') {
        pipeline = await asyncFn(desc);
      } else {
        pipeline = device.createComputePipeline(desc);
      }
      emitCompileProgress({
        type: 'done',
        key: computeKeyAsync,
        elapsed: performance.now() - computeCompileStartAsync,
      });
    } catch (err) {
      emitCompileProgress({
        type: 'error',
        key: computeKeyAsync,
        elapsed: performance.now() - computeCompileStartAsync,
      });
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`createComputePipelineAsync failed: ${msg}`);
    } finally {
      compilationQueue -= 1;
    }
    addCompilationTime(t0);
    return pipeline;
  };

  const statsGetter: PipelineCacheStats = {
    get cacheSize(): number {
      return renderCache.size + computeCache.size;
    },
    get cacheHits(): number {
      return cacheHits;
    },
    get cacheMisses(): number {
      return cacheMisses;
    },
    get compilationTimeMs(): number {
      return compilationTimeMs;
    },
    get compilationQueue(): number {
      return compilationQueue;
    },
  };

  const api: PipelineCache = {
    getOrCreate(descriptor: PipelineDescriptor): GPURenderPipeline {
      validatePipelineDescriptor(descriptor);
      let key: string;
      try {
        key = serializePipelineDescriptor(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreate: ${msg}`);
      }
      recordSessionUsage(key);
      const hit = renderCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      let pipeline: GPURenderPipeline;
      try {
        pipeline = buildRenderPipeline(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreate: ${msg}`);
      }
      renderCache.set(key, pipeline);
      return pipeline;
    },

    async getOrCreateAsync(descriptor: PipelineDescriptor): Promise<GPURenderPipeline> {
      validatePipelineDescriptor(descriptor);
      let key: string;
      try {
        key = serializePipelineDescriptor(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreateAsync: ${msg}`);
      }
      recordSessionUsage(key);
      const hit = renderCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      let pipeline: GPURenderPipeline;
      try {
        pipeline = await buildRenderPipelineAsync(descriptor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`getOrCreateAsync: ${msg}`);
      }
      renderCache.set(key, pipeline);
      return pipeline;
    },

    async warmup(descriptors: PipelineDescriptor[]): Promise<void> {
      if (!Array.isArray(descriptors)) {
        throw new TypeError('warmup: descriptors must be an array.');
      }
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        if (!d) {
          throw new TypeError(`warmup: descriptors[${i}] is null or undefined.`);
        }
        try {
          await api.getOrCreateAsync(d);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`warmup failed at index ${i}: ${msg}`);
        }
      }
    },

    has(descriptor: PipelineDescriptor): boolean {
      try {
        validatePipelineDescriptor(descriptor);
        const key = serializePipelineDescriptor(descriptor);
        return renderCache.has(key);
      } catch {
        return false;
      }
    },

    get stats(): PipelineCacheStats {
      return statsGetter;
    },

    get compilationQueue(): number {
      return compilationQueue;
    },

    get sessionStats(): Readonly<Record<string, number>> {
      return Object.fromEntries(sessionUsageByKey);
    },

    saveSessionStats(): void {
      const entries = Array.from(sessionUsageByKey.entries());
      entries.sort((a, b) => b[1] - a[1]);
      const topKeys: string[] = [];
      const limit = Math.min(SESSION_STATS_PERSIST_TOP_N, entries.length);
      for (let i = 0; i < limit; i++) {
        const pair = entries[i];
        if (pair) {
          topKeys.push(pair[0]);
        }
      }
      writePipelineWarmupStatsToStorage(topKeys);
    },

    loadSessionStats(): string[] {
      return readPipelineWarmupStatsFromStorage().slice();
    },

    async autoWarmup(options?: AutoWarmupOptions): Promise<void> {
      const onWarmupProgress = options?.onWarmupProgress;
      let queue: PipelineDescriptor[] = [];
      const storedKeys = readPipelineWarmupStatsFromStorage();
      if (storedKeys.length > 0) {
        for (let i = 0; i < storedKeys.length; i++) {
          const keyStr = storedKeys[i];
          if (!keyStr) {
            continue;
          }
          const parsed = parsePipelineDescriptorFromSerializedKey(keyStr);
          if (parsed) {
            queue.push(parsed);
          } else if (__DEV__) {
            console.warn(`[PipelineCache] autoWarmup: skipped invalid stored descriptor key at index ${i}`);
          }
        }
      }
      if (queue.length === 0) {
        queue = buildDefaultMercatorWarmupDescriptors();
      }
      const total = queue.length;
      if (total === 0) {
        return;
      }
      let done = 0;
      for (let i = 0; i < queue.length; i++) {
        const desc = queue[i]!;
        let warmupKey = '';
        try {
          warmupKey = serializePipelineDescriptor(desc);
        } catch (err) {
          if (__DEV__) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[PipelineCache] autoWarmup: serializePipelineDescriptor failed at index ${i}: ${msg}`);
          }
          warmupKey = `autoWarmup:index:${i}`;
        }
        try {
          await api.getOrCreateAsync(desc);
        } catch (err) {
          if (__DEV__) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[PipelineCache] autoWarmup: getOrCreateAsync failed at index ${i}: ${msg}`);
          }
        } finally {
          done++;
          try {
            onWarmupProgress?.(done, total);
          } catch (cbErr) {
            if (__DEV__) {
              const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
              console.warn(`[PipelineCache] autoWarmup: onWarmupProgress callback error: ${msg}`);
            }
          }
          emitCompileProgress({
            type: 'done',
            key: warmupKey,
            completed: done,
            total,
            elapsed: undefined,
          });
        }
      }
    },

    clear(): void {
      for (const pl of renderCache.values()) {
        destroyPipelineIfSupported(pl);
      }
      renderCache.clear();
      for (const cp of computeCache.values()) {
        destroyPipelineIfSupported(cp);
      }
      computeCache.clear();
      cacheHits = 0;
      cacheMisses = 0;
      compilationTimeMs = 0;
      compilationQueue = 0;
      sessionUsageByKey.clear();
    },

    getOrCreateCompute(shaderCode: string, label?: string): GPUComputePipeline {
      const key = hashStringDjb2(shaderCode);
      const hit = computeCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      const pipeline = buildComputePipeline(shaderCode, label);
      computeCache.set(key, pipeline);
      return pipeline;
    },

    async getOrCreateComputeAsync(shaderCode: string, label?: string): Promise<GPUComputePipeline> {
      const key = hashStringDjb2(shaderCode);
      const hit = computeCache.get(key);
      if (hit) {
        cacheHits++;
        return hit;
      }
      cacheMisses++;
      const pipeline = await buildComputePipelineAsync(shaderCode, label);
      computeCache.set(key, pipeline);
      return pipeline;
    },
  };

  return api;
}

export type { ShaderVariantKey } from './shader-assembler.ts';
