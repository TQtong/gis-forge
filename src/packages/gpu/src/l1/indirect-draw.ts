// ============================================================
// l1/indirect-draw.ts — Indirect Draw Buffer 管理
// 层级：L1（GPU 层）
// 职责：管理 GPU Indirect Draw Buffer 的创建、Compute Shader 写入
//       BindGroup 创建、和间接绘制命令编码。
//       通过间接绘制减少 CPU→GPU Draw Call 开销，
//       允许 GPU 端（Compute Shader）直接写入绘制参数。
//
// 被引用于：L2/RenderGraph, L2/ComputePassManager, L3/TileScheduler,
//           L4/LayerManager
//
// 设计要点：
// - Indirect Buffer 存储 drawIndexed/draw 的参数数组
// - Compute Shader 可写入 indirect buffer（视锥剔除后填充可见实例数）
// - 支持 indexed 和 non-indexed 两种模式
// - indexed: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance] × N
// - non-indexed: [vertexCount, instanceCount, firstVertex, firstInstance] × N
// ============================================================

import type { BufferHandle, BufferPool } from './buffer-pool.ts';

// ===================== 常量 =====================

/**
 * Indexed Indirect Draw 参数的字节步长。
 * 每个 draw call 占 5 个 uint32：
 * indexCount(4) + instanceCount(4) + firstIndex(4) + baseVertex(4) + firstInstance(4) = 20 字节。
 */
const INDEXED_INDIRECT_STRIDE = 5 * 4; // 20 bytes

/**
 * Non-indexed Indirect Draw 参数的字节步长。
 * 每个 draw call 占 4 个 uint32：
 * vertexCount(4) + instanceCount(4) + firstVertex(4) + firstInstance(4) = 16 字节。
 */
const NON_INDEXED_INDIRECT_STRIDE = 4 * 4; // 16 bytes

// ===================== IndirectDrawManager 接口 =====================

/**
 * Indirect Draw Buffer 管理器接口。
 *
 * @example
 * const indirectMgr = createIndirectDrawManager(device, bufferPool);
 *
 * // 创建支持 100 个 indexed draw call 的 indirect buffer
 * const ib = indirectMgr.createIndirectBuffer(100, true);
 *
 * // 为 Compute Shader 创建写入 BindGroup（使 GPU 端可写入绘制参数）
 * const bgLayout = indirectMgr.createWriteBindGroupLayout();
 * const bg = indirectMgr.createWriteBindGroup(ib, bgLayout);
 *
 * // 在渲染 pass 中编码间接绘制
 * indirectMgr.encodeIndirectDraw(renderPass, pipeline, ib, 0, true);
 */
export interface IndirectDrawManager {
  /**
   * 创建 Indirect Draw Buffer。
   * Buffer 的用途同时包含 INDIRECT 和 STORAGE（供 Compute Shader 写入）。
   *
   * @param maxDrawCalls - 最大 draw call 数量
   * @param indexed - 是否为 indexed draw
   * @param label - 可选调试标签
   * @returns BufferHandle 句柄
   */
  createIndirectBuffer(maxDrawCalls: number, indexed: boolean, label?: string): BufferHandle;

  /**
   * 创建 BindGroupLayout，供 Compute Shader 写入 Indirect Buffer。
   * layout 包含一个 storage buffer binding（read-write）。
   *
   * @returns GPUBindGroupLayout
   */
  createWriteBindGroupLayout(): GPUBindGroupLayout;

  /**
   * 创建 BindGroup，将 Indirect Buffer 绑定为 storage buffer。
   * Compute Shader 通过此 BindGroup 写入 draw 参数。
   *
   * @param indirectBuffer - Indirect Buffer 句柄
   * @param layout - BindGroupLayout（由 createWriteBindGroupLayout 创建）
   * @param label - 可选调试标签
   * @returns GPUBindGroup
   */
  createWriteBindGroup(
    indirectBuffer: BufferHandle,
    layout: GPUBindGroupLayout,
    label?: string
  ): GPUBindGroup;

  /**
   * 编码一次间接绘制命令。
   * 从 indirect buffer 的指定 drawIndex 位置读取绘制参数。
   *
   * @param encoder - GPURenderPassEncoder（当前 render pass）
   * @param pipeline - 渲染管线（必须已 set）
   * @param indirectBuffer - Indirect Buffer 句柄
   * @param drawIndex - draw call 在 buffer 中的索引（第几个 draw）
   * @param indexed - 是否为 indexed draw
   */
  encodeIndirectDraw(
    encoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawIndex: number,
    indexed: boolean
  ): void;

  /**
   * 编码多次间接绘制（批量 indirect draw）。
   * 从 indirect buffer 连续读取 drawCount 个 draw 参数。
   * 注意：multiDrawIndirect 是 WebGPU 扩展，不是所有浏览器都支持。
   * 不支持时回退到循环调用单个 drawIndirect。
   *
   * @param encoder - GPURenderPassEncoder
   * @param pipeline - 渲染管线
   * @param indirectBuffer - Indirect Buffer 句柄
   * @param drawCount - draw call 数量
   * @param indexed - 是否为 indexed draw
   */
  encodeMultiIndirectDraw(
    encoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawCount: number,
    indexed: boolean
  ): void;

  /**
   * 使用 CPU 写入单个 draw call 的参数到 indirect buffer。
   * 适用于不使用 Compute Shader 的简单场景。
   *
   * @param indirectBuffer - Indirect Buffer 句柄
   * @param drawIndex - draw call 索引
   * @param params - 绘制参数
   * @param indexed - 是否为 indexed draw
   */
  writeDrawParams(
    indirectBuffer: BufferHandle,
    drawIndex: number,
    params: IndirectDrawParams,
    indexed: boolean
  ): void;
}

// ===================== IndirectDrawParams =====================

/**
 * 间接绘制参数。
 * 对应 WebGPU drawIndirect / drawIndexedIndirect 的参数。
 */
export interface IndirectDrawParams {
  /** indexed 时为 indexCount；non-indexed 时为 vertexCount。 */
  readonly count: number;

  /** 实例数量。默认 1。 */
  readonly instanceCount?: number;

  /** indexed 时为 firstIndex；non-indexed 时为 firstVertex。默认 0。 */
  readonly first?: number;

  /** indexed 模式下的 baseVertex。默认 0。仅 indexed draw 有效。 */
  readonly baseVertex?: number;

  /** firstInstance。默认 0。需要 'indirect-first-instance' feature 支持。 */
  readonly firstInstance?: number;
}

// ===================== 工厂函数 =====================

/**
 * 创建 Indirect Draw Buffer 管理器。
 *
 * @param gpuDevice - 已初始化的 GPUDevice
 * @param bufferPool - Buffer 池实例
 * @returns IndirectDrawManager 实例
 *
 * @example
 * const indirectMgr = createIndirectDrawManager(device, bufferPool);
 * const ib = indirectMgr.createIndirectBuffer(256, true, 'tile-draws');
 */
export function createIndirectDrawManager(
  gpuDevice: GPUDevice,
  bufferPool: BufferPool
): IndirectDrawManager {
  // ==================== 参数校验 ====================

  if (!gpuDevice) {
    throw new Error('[IndirectDrawManager] createIndirectDrawManager: device must be a valid GPUDevice');
  }
  if (!bufferPool) {
    throw new Error('[IndirectDrawManager] createIndirectDrawManager: bufferPool must be a valid BufferPool');
  }

  // ==================== 缓存的 BindGroupLayout ====================

  /** 写入用 BindGroupLayout 缓存——只需创建一次 */
  let cachedWriteLayout: GPUBindGroupLayout | null = null;

  // ==================== 公开方法 ====================

  /**
   * 创建 Indirect Draw Buffer。
   */
  function createIndirectBuffer(
    maxDrawCalls: number,
    indexed: boolean,
    label?: string
  ): BufferHandle {
    // 校验 maxDrawCalls
    if (!Number.isFinite(maxDrawCalls) || maxDrawCalls <= 0) {
      throw new Error(
        `[IndirectDrawManager] createIndirectBuffer: maxDrawCalls must be a positive number, got ${maxDrawCalls}`
      );
    }

    // 计算所需字节数
    const stride = indexed ? INDEXED_INDIRECT_STRIDE : NON_INDEXED_INDIRECT_STRIDE;
    const totalSize = Math.ceil(maxDrawCalls) * stride;

    // 通过 BufferPool 分配
    // usage: INDIRECT（用于 drawIndirect）+ STORAGE（Compute Shader 写入）+ COPY_DST（CPU 写入）
    const handle = bufferPool.acquire(
      totalSize,
      GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label ?? 'gis-forge-indirect-draw'
    );

    return handle;
  }

  /**
   * 创建 Compute Shader 写入用 BindGroupLayout。
   */
  function createWriteBindGroupLayout(): GPUBindGroupLayout {
    // 缓存——同一 device 只需创建一次
    if (cachedWriteLayout) {
      return cachedWriteLayout;
    }

    cachedWriteLayout = gpuDevice.createBindGroupLayout({
      label: 'gis-forge-indirect-write-layout',
      entries: [
        {
          binding: 0,
          // 对 Compute Shader 可见
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            // storage 模式允许读写
            type: 'storage',
          },
        },
      ],
    });

    return cachedWriteLayout;
  }

  /**
   * 创建 Compute Shader 写入用 BindGroup。
   */
  function createWriteBindGroup(
    indirectBuffer: BufferHandle,
    layout: GPUBindGroupLayout,
    label?: string
  ): GPUBindGroup {
    if (!indirectBuffer || !indirectBuffer.buffer) {
      throw new Error('[IndirectDrawManager] createWriteBindGroup: indirectBuffer must be valid');
    }
    if (!layout) {
      throw new Error('[IndirectDrawManager] createWriteBindGroup: layout must be valid');
    }

    return gpuDevice.createBindGroup({
      label: label ?? `gis-forge-indirect-write-bg-${indirectBuffer.id}`,
      layout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: indirectBuffer.buffer,
          },
        },
      ],
    });
  }

  /**
   * 编码一次间接绘制命令。
   */
  function encodeIndirectDraw(
    encoder: GPURenderPassEncoder,
    _pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawIndex: number,
    indexed: boolean
  ): void {
    if (!encoder) {
      throw new Error('[IndirectDrawManager] encodeIndirectDraw: encoder must be valid');
    }
    if (!indirectBuffer || !indirectBuffer.buffer) {
      throw new Error('[IndirectDrawManager] encodeIndirectDraw: indirectBuffer must be valid');
    }

    // 计算该 drawIndex 在 buffer 中的字节偏移
    const stride = indexed ? INDEXED_INDIRECT_STRIDE : NON_INDEXED_INDIRECT_STRIDE;
    const offset = drawIndex * stride;

    // 编码间接绘制命令
    if (indexed) {
      encoder.drawIndexedIndirect(indirectBuffer.buffer, offset);
    } else {
      encoder.drawIndirect(indirectBuffer.buffer, offset);
    }
  }

  /**
   * 编码多次间接绘制。
   * multiDrawIndirect 不是 WebGPU 核心功能——回退到循环。
   */
  function encodeMultiIndirectDraw(
    encoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    indirectBuffer: BufferHandle,
    drawCount: number,
    indexed: boolean
  ): void {
    if (!encoder) {
      throw new Error('[IndirectDrawManager] encodeMultiIndirectDraw: encoder must be valid');
    }
    if (drawCount <= 0 || !Number.isFinite(drawCount)) return;

    // WebGPU 目前不支持 multiDrawIndirect——使用循环模拟
    for (let i = 0; i < drawCount; i++) {
      encodeIndirectDraw(encoder, pipeline, indirectBuffer, i, indexed);
    }
  }

  /**
   * 使用 CPU 写入单个 draw call 的参数。
   */
  function writeDrawParams(
    indirectBuffer: BufferHandle,
    drawIndex: number,
    params: IndirectDrawParams,
    indexed: boolean
  ): void {
    if (!indirectBuffer || !indirectBuffer.buffer) {
      throw new Error('[IndirectDrawManager] writeDrawParams: indirectBuffer must be valid');
    }

    const stride = indexed ? INDEXED_INDIRECT_STRIDE : NON_INDEXED_INDIRECT_STRIDE;
    const offset = drawIndex * stride;

    if (indexed) {
      // indexed draw: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
      const data = new Uint32Array([
        params.count,
        params.instanceCount ?? 1,
        params.first ?? 0,
        params.baseVertex ?? 0,
        params.firstInstance ?? 0,
      ]);
      gpuDevice.queue.writeBuffer(indirectBuffer.buffer, offset, data);
    } else {
      // non-indexed draw: [vertexCount, instanceCount, firstVertex, firstInstance]
      const data = new Uint32Array([
        params.count,
        params.instanceCount ?? 1,
        params.first ?? 0,
        params.firstInstance ?? 0,
      ]);
      gpuDevice.queue.writeBuffer(indirectBuffer.buffer, offset, data);
    }
  }

  // ==================== 返回公开接口 ====================

  return {
    createIndirectBuffer,
    createWriteBindGroupLayout,
    createWriteBindGroup,
    encodeIndirectDraw,
    encodeMultiIndirectDraw,
    writeDrawParams,
  };
}
