// ============================================================
// l1/buffer-pool.ts — GPU Buffer 对象池 + 环形 Staging Buffer
// 层级：L1（GPU 层）
// 职责：管理 GPUBuffer 的分配、回收与复用；提供环形 Staging Buffer
//       实现 CPU→GPU 零拷贝上传。解决问题 #9.1 内存泄漏。
//
// 被引用于：L1/GPUUploader, L1/IndirectDrawManager, L2/RenderGraph,
//           L3/ResourceManager, L3/MemoryBudget
//
// 设计要点：
// - acquire 优先复用已回收的同尺寸同 usage Buffer（减少 GPU 分配）
// - release 将 Buffer 放回空闲池，等待复用
// - destroy 真正销毁 Buffer 并从 MemoryTracker 移除
// - StagingRing 使用 N 个预分配的 MAP_WRITE staging buffer
//   循环使用，保证每帧上传不竞争上一帧的 GPU 读取
// ============================================================

import type { GPUMemoryTracker } from './memory-tracker.ts';
import { uniqueId } from '../../../core/src/infra/id.ts';

/** 开发构建标记；生产构建由打包器剔除调试分支。 */
declare const __DEV__: boolean | undefined;

// ===================== BufferHandle =====================

/**
 * GPU Buffer 句柄。
 * 封装 GPUBuffer 的引用和元数据，上层模块通过句柄操作 Buffer。
 * 句柄在 release 后仍有效（Buffer 可能被池化复用），
 * 在 destroy 后不可再使用。
 */
export interface BufferHandle {
  /** 唯一标识符，格式 "buf_{N}"。用于 MemoryTracker 和 BindGroupCache 的资源跟踪。 */
  readonly id: string;

  /** 底层 GPUBuffer 引用。直接传给 setVertexBuffer / setBindGroup 等 API。 */
  readonly buffer: GPUBuffer;

  /** Buffer 的字节大小。与 GPUBufferDescriptor.size 一致。范围 [4, maxBufferSize]。 */
  readonly size: number;

  /** Buffer 的用途标记。按位组合的 GPUBufferUsageFlags。 */
  readonly usage: GPUBufferUsageFlags;
}

// ===================== StagingAllocation =====================

/**
 * 从 StagingRing 分配的一段可写内存区域。
 * 调用方通过 mappedRange 写入数据，然后由 encodeStagingCopies 编码拷贝命令。
 */
export interface StagingAllocation {
  /** Staging GPUBuffer 引用。 */
  readonly buffer: GPUBuffer;

  /** 本次分配在 staging buffer 内的偏移（字节）。GPU copy 时用。 */
  readonly offset: number;

  /** 可直接写入的 ArrayBuffer 视图，对应 buffer 的 mappedRange[offset..offset+size]。 */
  readonly mappedRange: ArrayBuffer;
}

// ===================== PendingStagingCopy =====================

/**
 * 挂起的 staging→destination 拷贝操作。
 * 由 acquireStaging 内部记录，encodeStagingCopies 时批量编码到 CommandEncoder。
 */
interface PendingStagingCopy {
  /** 源 staging buffer */
  readonly srcBuffer: GPUBuffer;
  /** 源 staging buffer 内的偏移 */
  readonly srcOffset: number;
  /** 目标 buffer */
  readonly dstBuffer: GPUBuffer;
  /** 目标 buffer 内的偏移 */
  readonly dstOffset: number;
  /** 拷贝字节数 */
  readonly size: number;
}

// ===================== BufferPool 接口 =====================

/**
 * GPU Buffer 对象池接口。
 * 管理 GPUBuffer 的分配复用和 StagingRing 环形上传。
 *
 * @example
 * const pool = createBufferPool(device, memTracker, { stagingRingSize: 4*1024*1024, stagingRingSlots: 3 });
 *
 * // 获取一个 vertex buffer
 * const handle = pool.acquire(1024, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'vertices');
 *
 * // 释放回池中
 * pool.release(handle);
 *
 * // 通过 staging 上传数据
 * const staging = pool.acquireStaging(256);
 * new Float32Array(staging.mappedRange).set([1, 2, 3]);
 * pool.encodeStagingCopies(encoder);
 * pool.advanceStagingRing();
 */
export interface BufferPool {
  /**
   * 获取一个 GPU Buffer。
   * 优先从空闲池中找到大小和 usage 匹配的 Buffer 复用。
   * 未找到时创建新 Buffer。
   *
   * @param size - 所需字节数，范围 [4, maxBufferSize]
   * @param usage - GPUBufferUsageFlags（按位组合）
   * @param label - 可选调试标签
   * @returns BufferHandle 句柄
   */
  acquire(size: number, usage: GPUBufferUsageFlags, label?: string): BufferHandle;

  /**
   * 将 Buffer 释放回空闲池（不销毁）。
   * 下次相同 size+usage 的 acquire 可复用此 Buffer。
   *
   * @param handle - 要释放的句柄
   */
  release(handle: BufferHandle): void;

  /**
   * 真正销毁 Buffer 并从跟踪器移除。
   * 调用 GPUBuffer.destroy() 释放 GPU 内存。
   *
   * @param handle - 要销毁的句柄
   */
  destroy(handle: BufferHandle): void;

  /**
   * 从 StagingRing 分配一段可写区域。
   * 返回的 mappedRange 可直接写入 TypedArray 数据。
   * 写入后需调用 encodeStagingCopies + advanceStagingRing。
   *
   * @param size - 所需字节数
   * @param dstBuffer - 目标 GPU Buffer
   * @param dstOffset - 目标 buffer 内的偏移（字节），默认 0
   * @returns StagingAllocation 对象
   */
  acquireStaging(
    size: number,
    dstBuffer: GPUBuffer,
    dstOffset?: number
  ): StagingAllocation;

  /**
   * 将本帧所有 staging 拷贝命令编码到 CommandEncoder。
   * 在 device.queue.submit 之前调用。
   *
   * @param encoder - 当前帧的 GPUCommandEncoder
   */
  encodeStagingCopies(encoder: GPUCommandEncoder): void;

  /**
   * 推进 StagingRing 到下一个 slot。
   * 在 device.queue.submit 之后调用。
   * 确保 GPU 不再读取前几帧的 staging buffer 后才重新映射。
   */
  advanceStagingRing(): void;

  /** 当前统计信息。 */
  readonly stats: {
    /** 已分配的 Buffer 总字节数（包含池化空闲和活跃） */
    readonly totalAllocated: number;
    /** 池化空闲 Buffer 数量 */
    readonly pooledFree: number;
    /** 当前帧已使用的 staging 字节数 */
    readonly stagingUsed: number;
    /** 自适应 staging ring 因尺寸调整而重建的次数（累计） */
    readonly adaptiveResizeCount: number;
    /** 当前每个 staging slot 的字节容量（自适应结果） */
    readonly currentStagingSize: number;
    /** 最近上传历史的 P95（字节），用于自适应与调试 */
    readonly p95UploadBytes: number;
  };

  /**
   * 销毁池中所有 Buffer 和 staging ring。
   * 设备重建后必须调用。
   */
  destroyAll(): void;
}

// ===================== StagingRing 内部 slot =====================

/**
 * StagingRing 中的一个 slot。
 * 每个 slot 是一个预分配的 MAP_WRITE | COPY_SRC 缓冲区。
 * 在帧间轮换使用，防止 GPU 读和 CPU 写竞争。
 */
interface StagingSlot {
  /** staging GPUBuffer，创建时带 mappedAtCreation 标记 */
  buffer: GPUBuffer;
  /** 当前写入位置的偏移（字节） */
  offset: number;
  /** 总容量（字节） */
  capacity: number;
  /** 当前 mapped 的 ArrayBuffer */
  mappedArray: ArrayBuffer | null;
  /** 是否当前正在使用（mapped 状态） */
  isMapped: boolean;
}

// ===================== 常量 =====================

/** 最小 buffer 对齐（WebGPU 要求 copy 操作 4 字节对齐） */
const BUFFER_COPY_ALIGNMENT = 4;

/** 最小 buffer 大小——WebGPU 不允许 0 大小的 buffer */
const MIN_BUFFER_SIZE = 4;

/** 池化复用的最大空闲 buffer 数量（每种 usage+size 组合） */
const MAX_POOLED_BUFFERS_PER_KEY = 8;

/** 默认 staging ring 大小（4MB） */
const DEFAULT_STAGING_RING_SIZE = 4 * 1024 * 1024;

/** 默认 staging ring slot 数量（三重缓冲） */
const DEFAULT_STAGING_RING_SLOTS = 3;

/** 上传历史窗口长度（帧），用于 P95 与 resize 节流 */
const UPLOAD_HISTORY_FRAMES = 60;

/** 两次自适应 resize 检查之间的最小 advance 帧间隔 */
const STAGING_RESIZE_CHECK_INTERVAL_FRAMES = 60;

/** 自适应 staging 单 slot 最小容量（字节） */
const MIN_ADAPTIVE_STAGING_BYTES = 1 * 1024 * 1024;

/** 自适应 staging 单 slot 最大容量（字节） */
const MAX_ADAPTIVE_STAGING_BYTES = 32 * 1024 * 1024;

// ===================== 辅助函数 =====================

/**
 * 将字节数向上对齐到 BUFFER_COPY_ALIGNMENT 的倍数。
 * WebGPU 的 copyBufferToBuffer 要求 offset 和 size 都是 4 字节对齐的。
 *
 * @param size - 原始字节数
 * @returns 对齐后的字节数（≥ size，是 4 的倍数）
 *
 * @example
 * alignTo4(5);  // → 8
 * alignTo4(16); // → 16
 */
function alignTo4(size: number): number {
  // (size + 3) & ~3 —— 经典的 2 幂次对齐位运算
  return (size + (BUFFER_COPY_ALIGNMENT - 1)) & ~(BUFFER_COPY_ALIGNMENT - 1);
}

/**
 * 计算空闲池的 key。
 * 使用 size 和 usage 组合标识同类 buffer。
 *
 * @param size - buffer 字节大小
 * @param usage - GPUBufferUsageFlags
 * @returns 池 key 字符串
 */
function poolKey(size: number, usage: GPUBufferUsageFlags): string {
  return `${size}:${usage}`;
}

/**
 * 计算样本集的 95 分位数（线性插值，升序）。
 * 用于自适应 staging 尺寸；空数组返回 0。
 *
 * @param values - 非负字节样本（可能被原地排序的副本）
 * @returns P95 字节数，有限且 ≥ 0
 */
function computeP95Percentile(values: number[]): number {
  if (!values || values.length === 0) {
    return 0;
  }
  const copy = values.slice();
  copy.sort((a, b) => a - b);
  const n = copy.length;
  if (n === 1) {
    return Math.max(0, finiteNonNegative(copy[0]!));
  }
  const p = 0.95 * (n - 1);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  if (lo === hi) {
    return Math.max(0, finiteNonNegative(copy[lo]!));
  }
  const t = p - lo;
  const v0 = finiteNonNegative(copy[lo]!);
  const v1 = finiteNonNegative(copy[hi]!);
  return Math.max(0, v0 + t * (v1 - v0));
}

/**
 * 将输入限制为非负有限数。
 *
 * @param v - 原始值
 * @returns 非负有限数
 */
function finiteNonNegative(v: number): number {
  if (!Number.isFinite(v) || v < 0) {
    return 0;
  }
  return v;
}

/**
 * 将正数向上取整到不小于它的最小 2 的幂（≥1）。
 *
 * @param n - 输入字节数（可非整数）
 * @returns 2 的幂（字节）
 */
function nextPowerOfTwoCeil(n: number): number {
  const x = finiteNonNegative(n);
  if (x <= 1) {
    return 1;
  }
  return 2 ** Math.ceil(Math.log2(x));
}

// ===================== 工厂函数 =====================

/**
 * 创建 GPU Buffer 对象池。
 * 管理 Buffer 的分配复用，提供 StagingRing 实现帧间无锁上传。
 *
 * @param gpuDevice - 已初始化的 GPUDevice
 * @param memTracker - GPU 内存跟踪器实例
 * @param options - 可选配置
 * @returns BufferPool 实例
 *
 * @example
 * const pool = createBufferPool(device, memTracker, {
 *   stagingRingSize: 4 * 1024 * 1024,
 *   stagingRingSlots: 3,
 * });
 *
 * const vb = pool.acquire(4096, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
 * // ... 使用 vb.buffer ...
 * pool.release(vb);
 */
export function createBufferPool(
  gpuDevice: GPUDevice,
  memTracker: GPUMemoryTracker,
  options?: {
    /** Staging buffer 每个 slot 的大小（字节），默认 4MB */
    stagingRingSize?: number;
    /** Staging ring 的 slot 数量（帧间缓冲数），默认 3 */
    stagingRingSlots?: number;
  }
): BufferPool {
  // ==================== 参数校验 ====================

  if (!gpuDevice) {
    throw new Error('[BufferPool] createBufferPool: device must be a valid GPUDevice');
  }
  if (!memTracker) {
    throw new Error('[BufferPool] createBufferPool: memTracker must be a valid GPUMemoryTracker');
  }

  // ==================== 配置 ====================

  /** 当前每个 staging slot 的字节容量（可被自适应 resize 更新） */
  let currentStagingSizeBytes = options?.stagingRingSize ?? DEFAULT_STAGING_RING_SIZE;
  const stagingSlotCount = options?.stagingRingSlots ?? DEFAULT_STAGING_RING_SLOTS;

  // ==================== 内部状态 ====================

  /** 空闲 buffer 池：key(size:usage) → BufferHandle[] */
  const freePool = new Map<string, BufferHandle[]>();

  /** 所有活跃和池化的 buffer 集合（用于 destroyAll） */
  const allBuffers = new Map<string, BufferHandle>();

  /** 当前帧的 staging 拷贝列表 */
  let pendingCopies: PendingStagingCopy[] = [];

  /** StagingRing 的 slot 数组 */
  const stagingSlots: StagingSlot[] = [];

  /** 当前使用的 staging slot 索引 */
  let currentSlotIndex = 0;

  /** 统计：总分配字节数 */
  let totalAllocatedBytes = 0;

  /** 是否已销毁 */
  let destroyed = false;

  /**
   * 最近若干帧每帧上传字节数（环形语义：最多保留 UPLOAD_HISTORY_FRAMES 条）。
   * 对应需求中的 `_uploadHistory`。
   */
  const uploadHistory: number[] = [];

  /** 自适应 staging ring 成功重建次数 */
  let adaptiveResizeCount = 0;

  /** 最近一次根据历史上传的 P95（字节） */
  let p95UploadBytesStat = 0;

  /** 自上次尝试自适应 resize 以来经历的 advance 次数（用于每 60 帧最多检查一次） */
  let advancesSinceResizeCheck = 0;

  // ==================== StagingRing 初始化 ====================

  /**
   * 销毁当前 staging ring 全部 slot（unmap + destroy），清空数组。
   */
  function destroyStagingSlotsInternal(): void {
    for (const slot of stagingSlots) {
      try {
        if (slot.isMapped) {
          slot.buffer.unmap();
        }
      } catch {
        // 设备丢失等场景下 unmap 可能失败
      }
      try {
        slot.buffer.destroy();
      } catch {
        // 同上
      }
    }
    stagingSlots.length = 0;
  }

  /**
   * 创建 staging ring 的所有 slot。
   * 每个 slot 是一个 MAP_WRITE | COPY_SRC 的 buffer。
   * 创建时使用 mappedAtCreation=true 以获得初始映射。
   */
  function initStagingRing(): void {
    destroyStagingSlotsInternal();
    const raw = finiteNonNegative(currentStagingSizeBytes);
    const size = Math.max(
      MIN_BUFFER_SIZE,
      Math.min(MAX_ADAPTIVE_STAGING_BYTES, Math.floor(raw)),
    );
    currentStagingSizeBytes = size;
    for (let i = 0; i < stagingSlotCount; i++) {
      const buffer = gpuDevice.createBuffer({
        label: `gis-forge-staging-ring-slot-${i}`,
        size,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });

      const slot: StagingSlot = {
        buffer,
        offset: 0,
        capacity: size,
        mappedArray: buffer.getMappedRange(),
        isMapped: true,
      };

      stagingSlots.push(slot);
    }
  }

  /**
   * 根据上传历史计算自适应目标 slot 大小（字节）。
   * 公式：P95 × 1.5 → 向上取 2 的幂 → 钳制到 [1MB, 32MB]。
   *
   * @returns 建议的 staging 单 slot 字节数
   */
  function computeAdaptiveSize(): number {
    try {
      const p95 = computeP95Percentile(uploadHistory);
      const scaled = p95 * 1.5;
      const pow2 = nextPowerOfTwoCeil(scaled);
      const clamped = Math.max(
        MIN_ADAPTIVE_STAGING_BYTES,
        Math.min(MAX_ADAPTIVE_STAGING_BYTES, pow2),
      );
      if (!Number.isFinite(clamped) || clamped <= 0) {
        return Math.max(MIN_ADAPTIVE_STAGING_BYTES, Math.min(MAX_ADAPTIVE_STAGING_BYTES, currentStagingSizeBytes));
      }
      return clamped;
    } catch {
      return Math.max(MIN_ADAPTIVE_STAGING_BYTES, Math.min(MAX_ADAPTIVE_STAGING_BYTES, currentStagingSizeBytes));
    }
  }

  /**
   * 若当前 ring 容量与自适应目标差异过大（>2× 或 <0.5×），则重建 staging buffers。
   * 失败时保持当前容量不变。
   *
   * @returns 是否已重建 ring（true 时 `currentSlotIndex` 已置 0）
   */
  function resizeStagingRing(): boolean {
    try {
      const adaptive = computeAdaptiveSize();
      const cur = currentStagingSizeBytes;
      if (!Number.isFinite(adaptive) || !Number.isFinite(cur) || cur <= 0) {
        return false;
      }
      const significantlyLarger = cur > adaptive * 2;
      const significantlySmaller = cur < adaptive * 0.5;
      if (!significantlyLarger && !significantlySmaller) {
        return false;
      }

      destroyStagingSlotsInternal();
      currentStagingSizeBytes = adaptive;
      initStagingRing();
      currentSlotIndex = 0;
      adaptiveResizeCount += 1;
      return true;
    } catch (err) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[BufferPool] resizeStagingRing failed; keeping current staging size', err);
      }
      return false;
    }
  }

  // 立即初始化 staging ring
  initStagingRing();

  // ==================== 内部方法 ====================

  /**
   * 确保池未被销毁。
   */
  function assertNotDestroyed(): void {
    if (destroyed) {
      throw new Error('[BufferPool] Cannot use a destroyed BufferPool');
    }
  }

  // ==================== 公开方法 ====================

  /**
   * 获取一个 GPU Buffer。
   * 先查找空闲池中是否有匹配的 buffer，有则复用，无则新建。
   *
   * @param size - 所需字节数
   * @param usage - GPUBufferUsageFlags
   * @param label - 可选调试标签
   * @returns BufferHandle
   */
  function acquire(size: number, usage: GPUBufferUsageFlags, label?: string): BufferHandle {
    assertNotDestroyed();

    // 确保 size 至少为 MIN_BUFFER_SIZE 且 4 字节对齐
    const alignedSize = Math.max(MIN_BUFFER_SIZE, alignTo4(size));

    // 校验 size 有效性
    if (!Number.isFinite(alignedSize) || alignedSize <= 0) {
      throw new Error(`[BufferPool] acquire: invalid size ${size}`);
    }

    const key = poolKey(alignedSize, usage);

    // 尝试从空闲池复用
    const freeList = freePool.get(key);
    if (freeList && freeList.length > 0) {
      const recycled = freeList.pop()!;
      // 在 MemoryTracker 中重新标记为活跃
      memTracker.addRef(recycled.id);
      return recycled;
    }

    // 空闲池无匹配——创建新 Buffer
    const id = uniqueId('buf');
    const buffer = gpuDevice.createBuffer({
      label: label ?? `gis-forge-buffer-${id}`,
      size: alignedSize,
      usage,
    });

    const handle: BufferHandle = Object.freeze({
      id,
      buffer,
      size: alignedSize,
      usage,
    });

    // 注册到全局集合和内存跟踪器
    allBuffers.set(id, handle);
    memTracker.track({ id, type: 'buffer', size: alignedSize, label });
    totalAllocatedBytes += alignedSize;

    return handle;
  }

  /**
   * 将 Buffer 释放回空闲池。
   * Buffer 不被销毁——等待后续 acquire 复用。
   *
   * @param handle - 要释放的句柄
   */
  function release(handle: BufferHandle): void {
    assertNotDestroyed();

    if (!handle || !handle.id) return;

    const key = poolKey(handle.size, handle.usage);
    let freeList = freePool.get(key);
    if (!freeList) {
      freeList = [];
      freePool.set(key, freeList);
    }

    // 限制每种类型的最大池化数量——防止空闲池无限增长
    if (freeList.length >= MAX_POOLED_BUFFERS_PER_KEY) {
      // 池满了——真正销毁而非池化
      destroyHandle(handle);
      return;
    }

    // 放入空闲池
    freeList.push(handle);

    // 释放 MemoryTracker 引用计数
    memTracker.releaseRef(handle.id);
  }

  /**
   * 真正销毁一个 Buffer。
   * 调用 GPUBuffer.destroy() 释放 GPU 内存。
   *
   * @param handle - 要销毁的句柄
   */
  function destroyHandle(handle: BufferHandle): void {
    assertNotDestroyed();

    if (!handle || !handle.id) return;

    // 从 GPU 销毁
    try {
      handle.buffer.destroy();
    } catch {
      // buffer 可能已被销毁（如设备丢失后）——安全忽略
    }

    // 从跟踪器和全局集合移除
    memTracker.untrack(handle.id);
    allBuffers.delete(handle.id);
    totalAllocatedBytes -= handle.size;

    // 从空闲池中也移除（如有）
    const key = poolKey(handle.size, handle.usage);
    const freeList = freePool.get(key);
    if (freeList) {
      const idx = freeList.indexOf(handle);
      if (idx !== -1) {
        freeList.splice(idx, 1);
      }
    }
  }

  /**
   * 从 StagingRing 分配一段可写内存。
   * 在 staging buffer 的当前偏移处分配 size 字节。
   * 同时记录一个挂起的拷贝操作（staging→dstBuffer）。
   *
   * @param size - 字节数
   * @param dstBuffer - 目标 GPU Buffer
   * @param dstOffset - 目标偏移，默认 0
   * @returns StagingAllocation
   */
  function acquireStaging(
    size: number,
    dstBuffer: GPUBuffer,
    dstOffset: number = 0
  ): StagingAllocation {
    assertNotDestroyed();

    // 对齐 size
    const alignedSize = alignTo4(Math.max(MIN_BUFFER_SIZE, size));

    // 获取当前 slot
    const slot = stagingSlots[currentSlotIndex];

    // 检查当前 slot 是否还有足够空间
    if (slot.offset + alignedSize > slot.capacity) {
      throw new Error(
        `[BufferPool] StagingRing slot ${currentSlotIndex} overflow: ` +
        `need ${alignedSize} bytes but only ${slot.capacity - slot.offset} available ` +
        `(used ${slot.offset}/${slot.capacity}). ` +
        `Consider increasing stagingRingSize.`
      );
    }

    // 确保 slot 是 mapped 状态
    if (!slot.isMapped || !slot.mappedArray) {
      throw new Error(
        `[BufferPool] StagingRing slot ${currentSlotIndex} is not mapped. ` +
        `This usually means advanceStagingRing was not called or the slot is still in GPU use.`
      );
    }

    // 从 mappedRange 中切出本次分配的视图
    const offsetInSlot = slot.offset;
    const mappedView = slot.mappedArray.slice(offsetInSlot, offsetInSlot + alignedSize);

    // 推进 slot 的写入偏移
    slot.offset += alignedSize;

    // 记录挂起的拷贝操作
    pendingCopies.push({
      srcBuffer: slot.buffer,
      srcOffset: offsetInSlot,
      dstBuffer,
      dstOffset,
      size: alignedSize,
    });

    return {
      buffer: slot.buffer,
      offset: offsetInSlot,
      mappedRange: mappedView,
    };
  }

  /**
   * 将本帧所有挂起的 staging→destination 拷贝编码到 CommandEncoder。
   *
   * @param encoder - 当前帧的 GPUCommandEncoder
   */
  function encodeStagingCopies(encoder: GPUCommandEncoder): void {
    assertNotDestroyed();

    if (pendingCopies.length === 0) return;

    // 先 unmap 当前 slot——unmap 后 GPU 才能读取 staging 数据
    const slot = stagingSlots[currentSlotIndex];
    if (slot.isMapped) {
      slot.buffer.unmap();
      slot.isMapped = false;
      slot.mappedArray = null;
    }

    // 编码所有拷贝命令
    for (const copy of pendingCopies) {
      encoder.copyBufferToBuffer(
        copy.srcBuffer,
        copy.srcOffset,
        copy.dstBuffer,
        copy.dstOffset,
        copy.size
      );
    }

    // 清空挂起列表
    pendingCopies = [];
  }

  /**
   * 推进 StagingRing 到下一个 slot。
   * 在 device.queue.submit 之后调用。
   * 记录本帧上传字节、更新自适应历史；至多每 60 次 advance 尝试一次 resize。
   * 重新映射下一个 slot（如果它尚未被映射）。
   */
  function advanceStagingRing(): void {
    assertNotDestroyed();

    try {
      const finishedSlot = stagingSlots[currentSlotIndex];
      const bytesThisFrame = finishedSlot ? finiteNonNegative(finishedSlot.offset) : 0;
      uploadHistory.push(bytesThisFrame);
      if (uploadHistory.length > UPLOAD_HISTORY_FRAMES) {
        uploadHistory.shift();
      }
      p95UploadBytesStat = computeP95Percentile(uploadHistory);

      advancesSinceResizeCheck += 1;
      let ringRecreated = false;
      if (advancesSinceResizeCheck >= STAGING_RESIZE_CHECK_INTERVAL_FRAMES) {
        advancesSinceResizeCheck = 0;
        ringRecreated = resizeStagingRing();
      }

      if (!ringRecreated) {
        currentSlotIndex = (currentSlotIndex + 1) % stagingSlotCount;
        const nextSlot = stagingSlots[currentSlotIndex];
        if (!nextSlot) {
          throw new Error('[BufferPool] advanceStagingRing: missing staging slot after advance');
        }
        nextSlot.offset = 0;
        if (!nextSlot.isMapped) {
          nextSlot.buffer.mapAsync(GPUMapMode.WRITE).then(() => {
            nextSlot.mappedArray = nextSlot.buffer.getMappedRange();
            nextSlot.isMapped = true;
          }).catch((err) => {
            console.warn(
              `[BufferPool] Failed to map staging slot ${currentSlotIndex}:`,
              err,
            );
          });
        }
      } else {
        const slot0 = stagingSlots[0];
        if (slot0) {
          slot0.offset = 0;
          if (!slot0.isMapped) {
            slot0.buffer.mapAsync(GPUMapMode.WRITE).then(() => {
              slot0.mappedArray = slot0.buffer.getMappedRange();
              slot0.isMapped = true;
            }).catch((err) => {
              console.warn('[BufferPool] Failed to map staging slot 0 after resize:', err);
            });
          }
        }
      }
    } catch (err) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[BufferPool] advanceStagingRing failed; attempting minimal advance', err);
      }
      try {
        if (stagingSlots.length > 0) {
          currentSlotIndex = (currentSlotIndex + 1) % stagingSlotCount;
          const nextSlot = stagingSlots[currentSlotIndex];
          if (nextSlot) {
            nextSlot.offset = 0;
            if (!nextSlot.isMapped) {
              nextSlot.buffer.mapAsync(GPUMapMode.WRITE).then(() => {
                nextSlot.mappedArray = nextSlot.buffer.getMappedRange();
                nextSlot.isMapped = true;
              }).catch(() => {
                /* 保持当前大小，静默失败 */
              });
            }
          }
        }
      } catch {
        /* 保持当前 staging 配置 */
      }
    }
  }

  /**
   * 销毁所有 Buffer 和 staging ring。
   */
  function destroyAll(): void {
    if (destroyed) return;

    // 销毁所有 buffer
    for (const handle of allBuffers.values()) {
      try {
        handle.buffer.destroy();
      } catch {
        // 安全忽略
      }
      memTracker.untrack(handle.id);
    }
    allBuffers.clear();
    freePool.clear();
    totalAllocatedBytes = 0;

    // 销毁 staging ring
    destroyStagingSlotsInternal();

    // 清空挂起拷贝
    pendingCopies = [];

    destroyed = true;
  }

  // ==================== 返回公开接口 ====================

  return {
    acquire,
    release,
    destroy: destroyHandle,
    acquireStaging,
    encodeStagingCopies,
    advanceStagingRing,

    /** 当前统计信息。 */
    get stats() {
      // 计算空闲池中的 buffer 数量
      let pooledCount = 0;
      for (const list of freePool.values()) {
        pooledCount += list.length;
      }

      // 当前 slot 的已用字节数
      const stagingUsed = stagingSlots.length > 0
        ? stagingSlots[currentSlotIndex].offset
        : 0;

      return {
        totalAllocated: totalAllocatedBytes,
        pooledFree: pooledCount,
        stagingUsed,
        adaptiveResizeCount,
        currentStagingSize: currentStagingSizeBytes,
        p95UploadBytes: p95UploadBytesStat,
      };
    },

    destroyAll,
  };
}
