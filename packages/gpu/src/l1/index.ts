// ============================================================
// l1/index.ts — L1 GPU 层统一导出（Barrel Export）
// 上层模块通过此文件导入 L1 的所有公共接口。
//
// 导出 8 个模块的接口类型和工厂函数：
//   1. DeviceManager       — GPU 设备管理
//   2. SurfaceManager      — Canvas/Surface 管理
//   3. BufferPool          — Buffer 对象池 + StagingRing
//   4. TextureManager      — 纹理管理 + 动态 Atlas
//   5. GPUMemoryTracker    — GPU 内存跟踪
//   6. BindGroupCache      — BindGroup/Sampler 缓存
//   7. IndirectDrawManager — 间接绘制
//   8. GPUUploader         — L0 数据→GPU 传输
// ============================================================

// --- Module 1: DeviceManager ---
export type { GPUCapabilities, DeviceManager } from './device.ts';
export { createDeviceManager } from './device.ts';

// --- Module 2: SurfaceManager ---
export type { SurfaceInitConfig, SurfaceConfig, SurfaceManager } from './surface.ts';
export { createSurfaceManager } from './surface.ts';

// --- Module 3: BufferPool ---
export type { BufferHandle, StagingAllocation, BufferPool } from './buffer-pool.ts';
export { createBufferPool } from './buffer-pool.ts';

// --- Module 4: TextureManager ---
export type { TextureHandle, AtlasRegion, TextureManager } from './texture-manager.ts';
export { createTextureManager } from './texture-manager.ts';

// --- Module 5: GPUMemoryTracker ---
export type { GPUResourceType, GPUResourceEntry, GPUMemoryTracker } from './memory-tracker.ts';
export { createGPUMemoryTracker } from './memory-tracker.ts';

// --- Module 6: BindGroupCache ---
export type {
  BindGroupEntryDescriptor,
  BindGroupCacheStats,
  SamplerCacheStats,
  BindGroupCache,
  SamplerCache,
} from './bind-group-cache.ts';
export { createBindGroupCache } from './bind-group-cache.ts';

// --- Module 7: IndirectDrawManager ---
export type { IndirectDrawManager, IndirectDrawParams } from './indirect-draw.ts';
export { createIndirectDrawManager } from './indirect-draw.ts';

// --- Module 8: GPUUploader ---
export type { GPUUploader } from './uploader.ts';
export { createGPUUploader } from './uploader.ts';

// ============================================================
// L1 全局初始化便捷函数
// ============================================================

import { createDeviceManager } from './device.ts';
import { createSurfaceManager } from './surface.ts';
import { createGPUMemoryTracker } from './memory-tracker.ts';
import { createBufferPool } from './buffer-pool.ts';
import { createTextureManager } from './texture-manager.ts';
import { createBindGroupCache } from './bind-group-cache.ts';
import { createIndirectDrawManager } from './indirect-draw.ts';
import { createGPUUploader } from './uploader.ts';

import type { DeviceManager } from './device.ts';
import type { SurfaceManager, SurfaceInitConfig } from './surface.ts';
import type { GPUMemoryTracker } from './memory-tracker.ts';
import type { BufferPool } from './buffer-pool.ts';
import type { TextureManager } from './texture-manager.ts';
import type { BindGroupCache } from './bind-group-cache.ts';
import type { SamplerCache } from './bind-group-cache.ts';
import type { IndirectDrawManager } from './indirect-draw.ts';
import type { GPUUploader } from './uploader.ts';

/**
 * L1 全局初始化结果。
 * 包含所有 8 个 L1 模块的实例。
 */
export interface L1Context {
  /** GPU 设备管理器 */
  readonly deviceManager: DeviceManager;
  /** 渲染表面管理器 */
  readonly surface: SurfaceManager;
  /** GPU 内存跟踪器 */
  readonly memoryTracker: GPUMemoryTracker;
  /** GPU Buffer 对象池 */
  readonly bufferPool: BufferPool;
  /** 纹理管理器 */
  readonly textureManager: TextureManager;
  /** BindGroup 缓存 */
  readonly bindGroupCache: BindGroupCache & { sampler: SamplerCache };
  /** 间接绘制管理器 */
  readonly indirectDraw: IndirectDrawManager;
  /** GPU 上传器 */
  readonly uploader: GPUUploader;
}

/**
 * L1 初始化配置。
 */
export interface L1InitOptions {
  /** GPU 电源偏好。默认 'high-performance'。 */
  readonly powerPreference?: GPUPowerPreference;
  /** Surface 配置。 */
  readonly surface?: SurfaceInitConfig;
  /** StagingRing 每个 slot 的大小（字节）。默认 4MB。 */
  readonly stagingRingSize?: number;
  /** StagingRing slot 数量。默认 3（三重缓冲）。 */
  readonly stagingRingSlots?: number;
  /** Atlas 纹理最大尺寸。 */
  readonly maxAtlasSize?: number;
  /** Atlas 纹理初始/默认尺寸。默认 2048。 */
  readonly defaultAtlasSize?: number;
}

/**
 * 初始化 L1 GPU 层的所有模块。
 * 按依赖顺序创建 8 个模块并返回 L1Context。
 *
 * @param canvas - HTMLCanvasElement
 * @param options - 可选初始化配置
 * @returns L1Context 包含所有模块实例
 *
 * @example
 * const l1 = await initializeL1(canvas, {
 *   powerPreference: 'high-performance',
 *   surface: { sampleCount: 4, maxPixelRatio: 2 },
 *   stagingRingSize: 4 * 1024 * 1024,
 * });
 *
 * // 使用各模块
 * const vb = l1.uploader.uploadBuffer(vertices, GPUBufferUsage.VERTEX);
 * l1.uploader.writeUniform(cameraBuffer, vpMatrix);
 */
export async function initializeL1(
  canvas: HTMLCanvasElement,
  options?: L1InitOptions
): Promise<L1Context> {
  // 1. DeviceManager — 最先，其他所有模块依赖
  const deviceManager = createDeviceManager();
  await deviceManager.initialize({
    powerPreference: options?.powerPreference ?? 'high-performance',
  });
  const device = deviceManager.device;

  // 2. SurfaceManager — 依赖 DeviceManager
  const surface = createSurfaceManager();
  surface.initialize(canvas, device, options?.surface);

  // 3. GPUMemoryTracker — 独立，无依赖
  const memoryTracker = createGPUMemoryTracker();

  // 4. BufferPool — 依赖 DeviceManager + GPUMemoryTracker
  const bufferPool = createBufferPool(device, memoryTracker, {
    stagingRingSize: options?.stagingRingSize ?? 4 * 1024 * 1024,
    stagingRingSlots: options?.stagingRingSlots ?? 3,
  });

  // 5. TextureManager — 依赖 DeviceManager + GPUMemoryTracker
  const textureManager = createTextureManager(device, memoryTracker, {
    maxAtlasSize: options?.maxAtlasSize ?? deviceManager.capabilities.maxTextureSize,
    defaultAtlasSize: options?.defaultAtlasSize ?? 2048,
  });

  // 6. BindGroupCache — 依赖 DeviceManager
  const bindGroupCache = createBindGroupCache(device);

  // 7. IndirectDrawManager — 依赖 DeviceManager + BufferPool
  const indirectDraw = createIndirectDrawManager(device, bufferPool);

  // 8. GPUUploader — 依赖 DeviceManager + BufferPool + TextureManager
  const uploader = createGPUUploader(device, bufferPool, textureManager);

  return {
    deviceManager,
    surface,
    memoryTracker,
    bufferPool,
    textureManager,
    bindGroupCache,
    indirectDraw,
    uploader,
  };
}
