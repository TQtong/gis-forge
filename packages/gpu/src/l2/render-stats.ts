// ============================================================
// l2/render-stats.ts — 渲染统计信息收集
// 层级：L2（渲染层）
// 职责：按帧汇总 draw call、三角形、Pass、上传字节、FPS 与可选 GPU 时间戳；
//       为 FrameGraph、调度器与调试面板提供低开销的只读快照。
//
// 被引用于：L2/FrameGraphBuilder, L2/RenderGraph, L3/FrameScheduler,
//           L3/TileScheduler（注入瓦片/要素计数）, L4/LayerManager
//
// 设计要点：
// - FrameStats 为冻结快照；内部环形缓冲保留最近 N 帧用于趋势与平均帧时间
// - GPU 时间戳依赖 `timestamp-query`；否则 begin/end/resolve 为安全 no-op
// - WebGPU 的 writeTimestamp 仅存在于 PassEncoder；接口形参为 GPUCommandEncoder，
//   运行期若传入带 writeTimestamp 的编码器（duck typing）则写入查询槽位
// ============================================================

import type { GPUCapabilities } from '../l1/device.ts';

// ===================== 常量 =====================

/** 环形历史中保留的帧数上限；用于 getHistory 与长期趋势。 */
const HISTORY_RING_CAPACITY = 120;

/** 计算 averageFrameTime 时使用的滑动窗口（最近若干帧）。 */
const AVERAGE_FRAME_WINDOW = 60;

/** 单帧 GPU 时间戳查询槽位上限（begin/end 各占 1 槽）。 */
const MAX_TIMESTAMP_QUERY_SLOTS = 512;

/** resolve 查询结果缓冲区按 WebGPU 对齐要求向上取整（字节）。 */
const QUERY_RESOLVE_BUFFER_ALIGNMENT = 256;

// ===================== 公共类型 =====================

/**
 * 单帧渲染统计快照（冻结对象）。
 * 由 `endFrame` 或 `currentFrame` 返回；字段在快照生成后不可变。
 * `gpuDurationMs` 可选：在 GPU 时间戳异步解析完成后会回填到对应帧的历史槽位。
 */
export interface FrameStats {
  /** 单调递增的帧序号（由 beginFrame 传入）。 */
  readonly frameIndex: number;
  /** 本帧 wall-clock 持续时间（毫秒），来自 performance.now() 差值。 */
  readonly frameDurationMs: number;
  /**
   * 本帧 GPU 侧耗时（毫秒），由 timestamp query 解析得到。
   * 在首次 `resolveGPUTimers` 完成前可能为 undefined；解析后会写入历史记录。
   */
  readonly gpuDurationMs?: number;
  /** 本帧记录的 draw call 次数（每次 recordDrawCall 计 1）。 */
  readonly drawCallCount: number;
  /** 本帧累计三角形数量（各 draw 的 trianges 之和）。 */
  readonly triangleCount: number;
  /** 本帧累计实例数量（各 draw 的 instances 之和）。 */
  readonly instanceCount: number;
  /** 本帧渲染/计算 Pass 次数（每次 recordPass 计 1）。 */
  readonly passCount: number;
  /** 本帧纹理上传字节数（recordUpload('texture', ...) 累计）。 */
  readonly textureUploadBytes: number;
  /** 本帧缓冲区上传字节数（recordUpload('buffer', ...) 累计）。 */
  readonly bufferUploadBytes: number;
  /**
   * 当前进行中的瓦片加载数；由上层在集成 TileScheduler 时通过扩展 API 注入。
   * 本模块默认可靠值为 0（占位，避免引擎各处重复维护一份统计）。
   */
  readonly tileLoadsInFlight: number;
  /** 视锥内可见瓦片数量；默认 0，待场景层注入。 */
  readonly visibleTileCount: number;
  /** 视锥内可见标注数量；默认 0，待 LabelManager 注入。 */
  readonly visibleLabelCount: number;
  /** 视锥内可见要素数量；默认 0，待空间索引注入。 */
  readonly visibleFeatureCount: number;
}

/**
 * 渲染统计收集器接口。
 * 典型用法：每帧 `beginFrame` → 录制 draw/pass/upload → `endFrame` → 提交 GPU → `resolveGPUTimers`。
 */
export interface RenderStats {
  /**
   * 开始新的一帧统计；重置本帧累加器并记录起始时间。
   * @param frameIndex - 单调帧序号，通常来自 FrameScheduler
   */
  beginFrame(frameIndex: number): void;

  /**
   * 记录一次绘制调用。
   * @param triangles - 该 draw 的三角形数；非法值按 0 处理
   * @param instances - 实例数；非法值按 0 处理
   */
  recordDrawCall(triangles: number, instances: number): void;

  /** 记录一次渲染或计算 Pass。 */
  recordPass(): void;

  /**
   * 记录一次 CPU→GPU 上传量。
   * @param type - 纹理或缓冲上传
   * @param bytes - 字节数；负数按 0 处理
   */
  recordUpload(type: 'texture' | 'buffer', bytes: number): void;

  /** 结束本帧：计算帧时长、冻结快照并写入环形历史。 */
  endFrame(): void;

  /** 最近一次 `endFrame` 完成的帧快照（冻结）；若尚未结束过帧则返回空快照。 */
  readonly currentFrame: FrameStats;

  /** 最近 `AVERAGE_FRAME_WINDOW` 帧的平均帧时间（毫秒）；样本不足时用已有样本。 */
  readonly averageFrameTime: number;

  /** 由平均帧时间推导的 FPS：`1000 / averageFrameTime`（平均帧时间为 0 时为 0）。 */
  readonly fps: number;

  /**
   * 获取最近若干帧的历史快照（时间正序：从旧到新）。
   * @param count - 需要的帧数；超过已有历史时返回全部
   */
  getHistory(count: number): FrameStats[];

  /**
   * 开始一段 GPU 时间测量（需 PassEncoder 在运行期提供 writeTimestamp）。
   * @param encoder - 通常为 GPURenderPassEncoder / GPUComputePassEncoder（duck typing）
   * @param label - 时间段标签，用于 resolve 结果字典键
   */
  beginGPUTimer(encoder: GPUCommandEncoder, label: string): void;

  /**
   * 结束对应 label 的 GPU 时间测量（必须与 begin 成对、同 label）。
   * @param encoder - 与 begin 相同的编码器实例
   * @param label - 与 beginGPUTimer 一致
   */
  endGPUTimer(encoder: GPUCommandEncoder, label: string): void;

  /**
   * 将本帧已写入的 timestamp 查询解析为毫秒（按 label 聚合）。
   * 须在包含时间戳写入的 command buffer 已提交之后调用。
   */
  resolveGPUTimers(): Promise<Record<string, number>>;
}

/**
 * `createRenderStats` 第二参数类型：从 `GPUCapabilities` 抽取时间戳能力位。
 * 与 DeviceManager 探测结果兼容。
 */
export type RenderStatsCapabilities = Readonly<Pick<GPUCapabilities, 'supportsTimestampQuery'>>;

// ===================== 内部类型 =====================

/**
 * 可写入时间戳的编码器（WebGPU 仅在 PassEncoder 上提供）。
 * CommandEncoder 不包含该方法；运行期通过 duck typing 探测。
 */
interface TimestampWritableEncoder {
  writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void;
}

/** 环形缓冲中可变的帧记录，用于异步回填 gpuDurationMs。 */
interface MutableFrameSlot {
  frameIndex: number;
  frameDurationMs: number;
  gpuDurationMs?: number;
  drawCallCount: number;
  triangleCount: number;
  instanceCount: number;
  passCount: number;
  textureUploadBytes: number;
  bufferUploadBytes: number;
  tileLoadsInFlight: number;
  visibleTileCount: number;
  visibleLabelCount: number;
  visibleFeatureCount: number;
}

/** 挂起的 GPU 时间段：记录查询索引与标签，供 resolve 读取。 */
interface PendingGpuInterval {
  /** 与 begin/end 一致的标签 */
  readonly label: string;
  /** begin 写入的 query 索引 */
  readonly beginQueryIndex: number;
  /** end 写入的 query 索引 */
  readonly endQueryIndex: number;
}

// ===================== 工具函数 =====================

/**
 * 将非负有限数字规范化用于统计累加（避免 NaN/Infinity/负数污染汇总）。
 *
 * @param n - 输入数值
 * @returns 安全非负数
 *
 * @example
 * sanitizeNonNegative(42); // 42
 * sanitizeNonNegative(-1); // 0
 */
function sanitizeNonNegative(n: number): number {
  // 先排除 NaN，避免 NaN 传播到整帧统计
  if (Number.isNaN(n)) {
    return 0;
  }
  // Infinity 对累加无意义，按 0 处理以保持帧统计有限
  if (!Number.isFinite(n)) {
    return 0;
  }
  // 负数在几何统计中无意义，截断为 0
  return n < 0 ? 0 : n;
}

/**
 * 将 MutableFrameSlot 冻结为对外的 FrameStats 快照。
 *
 * @param slot - 内部槽位
 * @returns 冻结的 FrameStats
 *
 * @example
 * const snap = freezeFrameStats(slot);
 */
function freezeFrameStats(slot: MutableFrameSlot): FrameStats {
  // 使用展开避免共享引用被外部修改
  return Object.freeze({
    frameIndex: slot.frameIndex,
    frameDurationMs: slot.frameDurationMs,
    gpuDurationMs: slot.gpuDurationMs,
    drawCallCount: slot.drawCallCount,
    triangleCount: slot.triangleCount,
    instanceCount: slot.instanceCount,
    passCount: slot.passCount,
    textureUploadBytes: slot.textureUploadBytes,
    bufferUploadBytes: slot.bufferUploadBytes,
    tileLoadsInFlight: slot.tileLoadsInFlight,
    visibleTileCount: slot.visibleTileCount,
    visibleLabelCount: slot.visibleLabelCount,
    visibleFeatureCount: slot.visibleFeatureCount,
  });
}

/**
 * 计算向上取整到 alignment 的整数倍（用于 GPU buffer 对齐）。
 *
 * @param size - 原始字节数
 * @param alignment - 对齐边界，必须为正整数
 * @returns 对齐后的字节数
 *
 * @example
 * alignUp(100, 256); // 256
 */
function alignUp(size: number, alignment: number): number {
  // 防御：非法对齐时直接返回原值，避免除零
  if (!Number.isFinite(size) || size <= 0) {
    return alignment;
  }
  if (!Number.isFinite(alignment) || alignment <= 0) {
    return size;
  }
  const a = Math.floor(alignment);
  // 标准对齐公式：(v + a - 1) - (v + a - 1) % a
  return Math.ceil(size / a) * a;
}

/**
 * 尝试在编码器上写入时间戳（若存在 writeTimestamp）。
 *
 * @param encoder - GPU 命令或 Pass 编码器
 * @param querySet - 时间戳查询集
 * @param queryIndex - 槽位索引
 * @returns 是否成功写入
 *
 * @example
 * tryWriteTimestamp(passEncoder, querySet, 0);
 */
function tryWriteTimestamp(
  encoder: GPUCommandEncoder,
  querySet: GPUQuerySet,
  queryIndex: number
): boolean {
  // 槽位越界时拒绝写入，防止 GPU validation error
  if (queryIndex < 0 || queryIndex >= MAX_TIMESTAMP_QUERY_SLOTS) {
    return false;
  }
  const w = encoder as unknown as Partial<TimestampWritableEncoder>;
  // 仅当 duck typing 检测到 writeTimestamp 时才调用（CommandEncoder 无此方法）
  if (typeof w.writeTimestamp !== 'function') {
    return false;
  }
  try {
    w.writeTimestamp.call(encoder, querySet, queryIndex);
    return true;
  } catch (err) {
    // 捕获运行时验证错误，避免统计模块拖垮整帧渲染
    console.warn('[RenderStats] writeTimestamp failed:', err);
    return false;
  }
}

/**
 * 创建空的可变帧槽（用于尚未开始统计时的占位）。
 *
 * @returns 全零 MutableFrameSlot
 *
 * @example
 * const empty = createEmptyMutableSlot();
 * empty.frameIndex; // -1
 */
function createEmptyMutableSlot(): MutableFrameSlot {
  return {
    frameIndex: -1,
    frameDurationMs: 0,
    drawCallCount: 0,
    triangleCount: 0,
    instanceCount: 0,
    passCount: 0,
    textureUploadBytes: 0,
    bufferUploadBytes: 0,
    tileLoadsInFlight: 0,
    visibleTileCount: 0,
    visibleLabelCount: 0,
    visibleFeatureCount: 0,
  };
}

// ===================== 工厂 =====================

/**
 * 创建渲染统计收集器。
 *
 * @param device - WebGPU 设备（用于时间戳查询集与 resolve）
 * @param capabilities - 是否声明支持 timestamp-query（需与 device.features 一致）
 * @returns RenderStats 实例
 *
 * @example
 * const stats = createRenderStats(device, deviceManager.capabilities);
 * stats.beginFrame(0);
 * stats.recordDrawCall(128, 1);
 * stats.endFrame();
 */
export function createRenderStats(
  device: GPUDevice,
  capabilities: RenderStatsCapabilities
): RenderStats {
  // 同时信任上层能力与设备特性，避免半初始化设备误用时间戳
  const canUseTimestamp =
    capabilities.supportsTimestampQuery === true && device.features.has('timestamp-query');

  let querySet: GPUQuerySet | null = null;
  let resolveBuffer: GPUBuffer | null = null;
  let resolveBufferByteLength = 0;

  // 仅在支持时分配查询集，减少不支持平台上的对象数量
  if (canUseTimestamp) {
    try {
      querySet = device.createQuerySet({
        type: 'timestamp',
        count: MAX_TIMESTAMP_QUERY_SLOTS,
      });
    } catch (e) {
      // 创建失败时降级为无时间戳模式，保证统计模块仍可用
      console.warn('[RenderStats] createQuerySet(timestamp) failed, GPU timers disabled:', e);
      querySet = null;
    }
  }

  /** 本帧 wall-clock 起点（ms）。 */
  let frameStartMs = 0;
  /** 是否已调用 beginFrame 且尚未 endFrame。 */
  let frameOpen = false;
  /** 当前正在累积的帧序号。 */
  let currentFrameIndex = -1;

  /** 本帧累加器（draw、pass、upload）。 */
  let accDrawCalls = 0;
  let accTriangles = 0;
  let accInstances = 0;
  let accPasses = 0;
  let accTexBytes = 0;
  let accBufBytes = 0;

  /** 下一次写入的查询索引（每帧 beginFrame 归零）。 */
  let nextQueryIndex = 0;
  /** 嵌套 begin/end 栈，用于校验 label 配对。 */
  const timerStack: { label: string; beginQueryIndex: number }[] = [];
  /** 本帧完成的 [begin,end] 区间列表，供 resolve 读取。 */
  let pendingIntervals: PendingGpuInterval[] = [];

  /** 环形缓冲：固定槽位，循环写入。 */
  const ring: MutableFrameSlot[] = [];
  for (let i = 0; i < HISTORY_RING_CAPACITY; i++) {
    ring.push(createEmptyMutableSlot());
  }
  /** 环形写指针（下一个 endFrame 写入位置）。 */
  let ringWrite = 0;
  /** 已写入历史的帧条数（用于区分冷启动与满环）。 */
  let ringCount = 0;

  /** 最近一次 endFrame 写入的槽位索引（0..CAPACITY-1）。 */
  let lastCompletedSlotIndex = -1;

  /**
   * 最近一次 `endFrame` 对应的帧序号；在 `resolveGPUTimers` 中用于回填 gpuDurationMs。
   * 避免在下一帧 `beginFrame` 之后仍误用已递增的 currentFrameIndex。
   */
  let lastEndedFrameIndex = -1;

  /** 查询槽溢出时只告警一次，避免刷屏。 */
  let warnedQueryOverflow = false;
  /** 时间戳栈不匹配时只告警一次。 */
  let warnedTimerMismatch = false;

  /** 空快照，用于尚无历史时 currentFrame。 */
  const emptyFrozen = freezeFrameStats(createEmptyMutableSlot());

  /**
   * 确保 resolve 缓冲区足够大以容纳 `queryCount` 个 uint64。
   *
   * @param requiredBytes - 所需最小字节数（含对齐前的原始长度）
   * @returns 可复用的 GPUBuffer；创建失败时返回 null
   *
   * @example
   * const buf = ensureResolveBuffer(64);
   * if (buf) { device.queue.submit([...]); }
   */
  function ensureResolveBuffer(requiredBytes: number): GPUBuffer | null {
    const aligned = alignUp(requiredBytes, QUERY_RESOLVE_BUFFER_ALIGNMENT);
    // 若已有缓冲区且够大则复用，减少 GPU 分配抖动
    if (resolveBuffer !== null && resolveBufferByteLength >= aligned) {
      return resolveBuffer;
    }
    // 旧缓冲区若存在且过小则销毁后重建
    if (resolveBuffer !== null) {
      try {
        resolveBuffer.destroy();
      } catch {
        // destroy 失败时忽略，避免二次抛出掩盖主错误
      }
      resolveBuffer = null;
      resolveBufferByteLength = 0;
    }
    try {
      const buf = device.createBuffer({
        label: 'geoforge-render-stats-query-resolve',
        size: aligned,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.MAP_READ,
      });
      resolveBuffer = buf;
      resolveBufferByteLength = aligned;
      return buf;
    } catch (e) {
      console.warn('[RenderStats] failed to create resolve buffer:', e);
      return null;
    }
  }

  /**
   * 计算最近若干帧的平均帧时间（滑动窗口 `AVERAGE_FRAME_WINDOW`）。
   *
   * @returns 平均毫秒数；尚无历史时为 0
   *
   * @example
   * // ringCount>=1 时返回正数平均帧时间
   * const avg = computeAverageFrameTime();
   */
  function computeAverageFrameTime(): number {
    const n = Math.min(ringCount, AVERAGE_FRAME_WINDOW);
    // 尚无有效帧时平均为 0
    if (n <= 0) {
      return 0;
    }
    let sum = 0;
    // ringWrite 指向下一次写入位置，最近结束帧为 ringWrite - 1（模环）
    for (let i = 0; i < n; i++) {
      const idx = (ringWrite - 1 - i + HISTORY_RING_CAPACITY) % HISTORY_RING_CAPACITY;
      sum += ring[idx].frameDurationMs;
    }
    return sum / n;
  }

  /**
   * 将解析得到的 GPU 总耗时写回对应帧槽位（异步完成后调用）。
   *
   * @param frameIndex - 目标帧号（与 `endFrame` 写入的 frameIndex 一致）
   * @param gpuMs - GPU 耗时（毫秒）
   * @returns void
   *
   * @example
   * patchFrameGpuDuration(42, 2.35);
   */
  function patchFrameGpuDuration(frameIndex: number, gpuMs: number): void {
    // 在历史环中查找匹配帧索引并回填（通常仅最近 1 帧）
    for (let i = 0; i < ringCount && i < HISTORY_RING_CAPACITY; i++) {
      const idx = (ringWrite - 1 - i + HISTORY_RING_CAPACITY) % HISTORY_RING_CAPACITY;
      const slot = ring[idx];
      if (slot.frameIndex === frameIndex) {
        slot.gpuDurationMs = gpuMs;
        break;
      }
    }
  }

  const api: RenderStats = {
    /**
     * 实现 `RenderStats.beginFrame`：开启新帧并清空本帧累加器与 GPU 计时状态。
     *
     * @param frameIndex - 单调帧序号
     * @returns void
     *
     * @example
     * stats.beginFrame(frameScheduler.frameIndex);
     */
    beginFrame(frameIndex: number): void {
      // 若上一帧未 endFrame，先强制结束，避免累计器泄漏到下一帧
      if (frameOpen) {
        try {
          api.endFrame();
        } catch (e) {
          console.warn('[RenderStats] auto endFrame after missing endFrame failed:', e);
        }
      }
      frameStartMs = performance.now();
      frameOpen = true;
      currentFrameIndex = frameIndex;

      accDrawCalls = 0;
      accTriangles = 0;
      accInstances = 0;
      accPasses = 0;
      accTexBytes = 0;
      accBufBytes = 0;

      nextQueryIndex = 0;
      timerStack.length = 0;
      pendingIntervals = [];
    },

    /**
     * 实现 `RenderStats.recordDrawCall`：累加 draw 次数、三角形与实例数。
     *
     * @param triangles - 三角形数量
     * @param instances - 实例数量
     * @returns void
     *
     * @example
     * stats.recordDrawCall(2048, 4);
     */
    recordDrawCall(triangles: number, instances: number): void {
      // 未 beginFrame 时忽略，避免静默污染
      if (!frameOpen) {
        return;
      }
      const t = sanitizeNonNegative(triangles);
      const inst = sanitizeNonNegative(instances);
      accDrawCalls += 1;
      accTriangles += t;
      accInstances += inst;
    },

    /**
     * 实现 `RenderStats.recordPass`：Pass 计数加一。
     *
     * @returns void
     *
     * @example
     * stats.recordPass();
     */
    recordPass(): void {
      if (!frameOpen) {
        return;
      }
      accPasses += 1;
    },

    /**
     * 实现 `RenderStats.recordUpload`：按类型累加上传字节。
     *
     * @param type - 纹理或缓冲上传
     * @param bytes - 字节数
     * @returns void
     *
     * @example
     * stats.recordUpload('texture', 65536);
     */
    recordUpload(type: 'texture' | 'buffer', bytes: number): void {
      if (!frameOpen) {
        return;
      }
      const b = sanitizeNonNegative(bytes);
      if (type === 'texture') {
        accTexBytes += b;
      } else {
        accBufBytes += b;
      }
    },

    /**
     * 实现 `RenderStats.endFrame`：结算帧时长并写入环形历史。
     *
     * @returns void
     *
     * @example
     * stats.endFrame();
     */
    endFrame(): void {
      const endMs = performance.now();
      // 未 begin 时生成零时长占位，便于调试发现调用顺序错误
      if (!frameOpen) {
        console.warn('[RenderStats] endFrame without beginFrame');
        return;
      }
      const duration = Math.max(0, endMs - frameStartMs);
      frameOpen = false;

      const slot = ring[ringWrite];
      slot.frameIndex = currentFrameIndex;
      slot.frameDurationMs = duration;
      slot.drawCallCount = accDrawCalls;
      slot.triangleCount = accTriangles;
      slot.instanceCount = accInstances;
      slot.passCount = accPasses;
      slot.textureUploadBytes = accTexBytes;
      slot.bufferUploadBytes = accBufBytes;
      slot.tileLoadsInFlight = 0;
      slot.visibleTileCount = 0;
      slot.visibleLabelCount = 0;
      slot.visibleFeatureCount = 0;
      // gpuDurationMs 保留上一异步解析值或待 resolve 回填；新帧先清除
      slot.gpuDurationMs = undefined;

      lastCompletedSlotIndex = ringWrite;
      ringWrite = (ringWrite + 1) % HISTORY_RING_CAPACITY;
      ringCount = Math.min(ringCount + 1, HISTORY_RING_CAPACITY);
      lastEndedFrameIndex = currentFrameIndex;
    },

    /**
     * 实现 `RenderStats.currentFrame`：返回最近一次 `endFrame` 的冻结快照。
     *
     * @returns FrameStats
     *
     * @example
     * const f = stats.currentFrame.drawCallCount;
     */
    get currentFrame(): FrameStats {
      if (lastCompletedSlotIndex < 0) {
        return emptyFrozen;
      }
      return freezeFrameStats(ring[lastCompletedSlotIndex]);
    },

    /**
     * 实现 `RenderStats.averageFrameTime`：最近窗口内平均帧时间（毫秒）。
     *
     * @returns 平均毫秒
     *
     * @example
     * const ms = stats.averageFrameTime;
     */
    get averageFrameTime(): number {
      return computeAverageFrameTime();
    },

    /**
     * 实现 `RenderStats.fps`：由平均帧时间推导的帧率。
     *
     * @returns FPS 数值
     *
     * @example
     * hud.textContent = stats.fps.toFixed(0);
     */
    get fps(): number {
      const avg = computeAverageFrameTime();
      // 避免除零；极小值时限制上限防止 Infinity
      if (avg <= 0) {
        return 0;
      }
      const v = 1000 / avg;
      return Number.isFinite(v) ? v : 0;
    },

    /**
     * 实现 `RenderStats.getHistory`：按时间正序返回最近若干帧。
     *
     * @param count - 需要的帧条数
     * @returns 冻结的 FrameStats 数组（旧→新）
     *
     * @example
     * const last10 = stats.getHistory(10);
     */
    getHistory(count: number): FrameStats[] {
      const c = Math.floor(sanitizeNonNegative(count));
      if (c <= 0) {
        return [];
      }
      const out: FrameStats[] = [];
      const take = Math.min(c, ringCount);
      // 从旧到新：最旧的一条在 ringWrite - ringCount
      const oldestOffset = ringCount - take;
      for (let i = 0; i < take; i++) {
        const idx = (ringWrite - ringCount + oldestOffset + i + HISTORY_RING_CAPACITY) % HISTORY_RING_CAPACITY;
        out.push(freezeFrameStats(ring[idx]));
      }
      return out;
    },

    /**
     * 实现 `RenderStats.beginGPUTimer`：为 GPU 时间戳写入 begin 槽（需 PassEncoder duck typing）。
     *
     * @param encoder - 命令或 Pass 编码器
     * @param label - 时间段标签
     * @returns void
     *
     * @example
     * stats.beginGPUTimer(renderPass as unknown as GPUCommandEncoder, 'main');
     */
    beginGPUTimer(encoder: GPUCommandEncoder, label: string): void {
      if (!frameOpen) {
        return;
      }
      if (!canUseTimestamp || querySet === null) {
        return;
      }
      if (typeof label !== 'string' || label.length === 0) {
        console.warn('[RenderStats] beginGPUTimer: empty label ignored');
        return;
      }
      // 需要连续两个槽位给 begin/end
      if (nextQueryIndex + 1 >= MAX_TIMESTAMP_QUERY_SLOTS) {
        if (!warnedQueryOverflow) {
          console.warn('[RenderStats] timestamp query slots exhausted; dropping GPU timers');
          warnedQueryOverflow = true;
        }
        return;
      }
      const beginIdx = nextQueryIndex;
      nextQueryIndex += 1;
      const ok = tryWriteTimestamp(encoder, querySet, beginIdx);
      // 写入失败仍压栈，便于 end 检测配对；resolve 时跳过无效区间
      if (!ok) {
        nextQueryIndex -= 1;
        return;
      }
      timerStack.push({ label, beginQueryIndex: beginIdx });
    },

    /**
     * 实现 `RenderStats.endGPUTimer`：与 begin 成对写入 end 槽。
     *
     * @param encoder - 与 begin 相同的编码器
     * @param label - 与 begin 相同的标签
     * @returns void
     *
     * @example
     * stats.endGPUTimer(renderPass as unknown as GPUCommandEncoder, 'main');
     */
    endGPUTimer(encoder: GPUCommandEncoder, label: string): void {
      if (!frameOpen) {
        return;
      }
      if (!canUseTimestamp || querySet === null) {
        return;
      }
      const top = timerStack.pop();
      if (!top || top.label !== label) {
        if (!warnedTimerMismatch) {
          console.warn('[RenderStats] endGPUTimer label mismatch or missing begin');
          warnedTimerMismatch = true;
        }
        // 尝试恢复栈一致性：把错误项推回
        if (top) {
          timerStack.push(top);
        }
        return;
      }
      if (nextQueryIndex >= MAX_TIMESTAMP_QUERY_SLOTS) {
        return;
      }
      const endIdx = nextQueryIndex;
      nextQueryIndex += 1;
      const ok = tryWriteTimestamp(encoder, querySet, endIdx);
      if (!ok) {
        nextQueryIndex -= 1;
        timerStack.push(top);
        return;
      }
      pendingIntervals.push({
        label: top.label,
        beginQueryIndex: top.beginQueryIndex,
        endQueryIndex: endIdx,
      });
    },

    /**
     * 实现 `RenderStats.resolveGPUTimers`：resolveQuerySet + 读回各 label 毫秒值。
     *
     * @returns label→毫秒 的映射；失败时 Promise reject
     *
     * @example
     * const m = await stats.resolveGPUTimers();
     * m['main'];
     */
    async resolveGPUTimers(): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      if (!canUseTimestamp || querySet === null) {
        return out;
      }
      if (pendingIntervals.length === 0) {
        return out;
      }
      const maxIndex = nextQueryIndex;
      if (maxIndex <= 0) {
        return out;
      }
      const rawBytes = maxIndex * 8;
      const dst = ensureResolveBuffer(rawBytes);
      if (dst === null) {
        return out;
      }

      const frameIdxSnapshot = lastEndedFrameIndex;
      const intervalsSnapshot = pendingIntervals.slice();

      let encoder: GPUCommandEncoder;
      try {
        encoder = device.createCommandEncoder({ label: 'geoforge-render-stats-resolve' });
      } catch (e) {
        return Promise.reject(new Error(`[RenderStats] createCommandEncoder failed: ${String(e)}`));
      }

      try {
        encoder.resolveQuerySet(querySet, 0, maxIndex, dst, 0);
        const cb = encoder.finish();
        device.queue.submit([cb]);
      } catch (e) {
        return Promise.reject(new Error(`[RenderStats] resolveQuerySet failed: ${String(e)}`));
      }

      try {
        await device.queue.onSubmittedWorkDone();
      } catch (e) {
        return Promise.reject(new Error(`[RenderStats] onSubmittedWorkDone failed: ${String(e)}`));
      }

      try {
        await dst.mapAsync(GPUMapMode.READ);
      } catch (e) {
        return Promise.reject(new Error(`[RenderStats] mapAsync failed: ${String(e)}`));
      }

      let raw: ArrayBuffer;
      try {
        raw = dst.getMappedRange();
      } catch (e) {
        try {
          dst.unmap();
        } catch {
          // 忽略 unmap 二次错误
        }
        return Promise.reject(new Error(`[RenderStats] getMappedRange failed: ${String(e)}`));
      }

      const ticks = new BigUint64Array(raw);
      // WebGPU timestamp period 是固定的 1 纳秒（根据规范）
      // 旧版 API 有 getTimestampPeriod()，但最新规范已移除
      const periodNs = 1;

      for (const iv of intervalsSnapshot) {
        const b = iv.beginQueryIndex;
        const e = iv.endQueryIndex;
        if (b < 0 || e < 0 || b >= ticks.length || e >= ticks.length) {
          continue;
        }
        const tb = ticks[b];
        const te = ticks[e];
        let delta = te - tb;
        // 若 GPU 重置或乱序，delta 可能极大；用模运算不适用，直接跳过异常值
        if (tb > te) {
          continue;
        }
        const ms = Number(delta) * (periodNs / 1e6);
        if (!Number.isFinite(ms) || ms < 0) {
          continue;
        }
        out[iv.label] = (out[iv.label] ?? 0) + ms;
      }

      try {
        dst.unmap();
      } catch {
        // unmap 失败不影响返回结果字典
      }

      let totalGpuMs = 0;
      for (const k of Object.keys(out)) {
        totalGpuMs += out[k] ?? 0;
      }
      if (Number.isFinite(totalGpuMs) && totalGpuMs >= 0 && frameIdxSnapshot >= 0) {
        patchFrameGpuDuration(frameIdxSnapshot, totalGpuMs);
      }

      // 已读取的区间不再参与后续 resolve，避免同帧重复提交产生重复累加
      pendingIntervals.length = 0;

      return out;
    },
  };

  return api;
}
