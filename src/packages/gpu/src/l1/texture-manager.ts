// ============================================================
// l1/texture-manager.ts — 纹理生命周期管理 + 动态 Atlas 打包
// 层级：L1（GPU 层）
// 职责：管理 GPUTexture 的创建/释放/引用计数；提供动态 Atlas
//       打包（Shelf-First-Fit 算法）将小纹理（图标/字形/图案）
//       合并到大型纹理 Atlas 中，减少 Draw Call 中的纹理切换。
//
// 被引用于：L1/GPUUploader, L2/ShaderAssembler, L3/ResourceManager,
//           L4/GlyphManager, L4/LabelManager, L4/StyleEngine
//
// 设计要点：
// - 独立纹理通过 create/release 管理，自动跟踪到 MemoryTracker
// - Atlas 使用 Shelf-First-Fit 打包算法（适合动态增量添加）
// - 内置 Atlas ID：'icons'（精灵图）/ 'glyphs'（MSDF 字形）/ 'patterns'（填充图案）
// - Atlas 扩容策略：当前大小翻倍（直到 maxAtlasSize）
// ============================================================

import type { GPUMemoryTracker } from './memory-tracker.ts';
import { uniqueId } from '../../../core/src/infra/id.ts';

/** 开发构建时由打包器注入；未定义时按 false 处理。 */
declare const __DEV__: boolean | undefined;

// ===================== TextureHandle =====================

/**
 * GPU 纹理句柄。
 * 封装 GPUTexture 和 GPUTextureView，上层模块通过句柄操作纹理。
 */
export interface TextureHandle {
  /** 唯一标识符，格式 "tex_{N}"。 */
  readonly id: string;

  /** 底层 GPUTexture 引用。 */
  readonly texture: GPUTexture;

  /** 预创建的纹理视图。直接传给 BindGroup entries。 */
  readonly view: GPUTextureView;

  /** 纹理宽度（像素）。 */
  readonly width: number;

  /** 纹理高度（像素）。 */
  readonly height: number;

  /** 纹理格式。 */
  readonly format: GPUTextureFormat;
}

// ===================== AtlasRegion =====================

/**
 * Atlas 中的一个子区域。
 * 描述小纹理在大 Atlas 纹理中的位置（像素和 UV 坐标）。
 */
export interface AtlasRegion {
  /** 所属 Atlas 的 ID。 */
  readonly atlasId: string;

  /** 区域在 Atlas 中的归一化 UV 左上角 U（水平）。范围 [0, 1]。 */
  readonly u0: number;

  /** 区域在 Atlas 中的归一化 UV 左上角 V（垂直）。范围 [0, 1]。 */
  readonly v0: number;

  /** 区域在 Atlas 中的归一化 UV 右下角 U。范围 [0, 1]。 */
  readonly u1: number;

  /** 区域在 Atlas 中的归一化 UV 右下角 V。范围 [0, 1]。 */
  readonly v1: number;

  /** 区域在 Atlas 纹理中的像素 X 坐标。 */
  readonly pixelX: number;

  /** 区域在 Atlas 纹理中的像素 Y 坐标。 */
  readonly pixelY: number;

  /** 区域的像素宽度（不含 padding）。 */
  readonly pixelWidth: number;

  /** 区域的像素高度（不含 padding）。 */
  readonly pixelHeight: number;
}

// ===================== TextureManager 接口 =====================

/**
 * 纹理管理器接口。
 *
 * @example
 * const texMgr = createTextureManager(device, memTracker, { defaultAtlasSize: 2048 });
 * const tex = texMgr.create({ size: { width: 256, height: 256 }, format: 'rgba8unorm', usage: ... });
 * // ... 使用 tex.texture / tex.view ...
 * texMgr.release(tex);
 *
 * // Atlas 使用
 * const region = texMgr.addToAtlas('icons', imageBitmap, 1);
 * const atlasTex = texMgr.getAtlasTexture('icons');
 */
export interface TextureManager {
  /**
   * 创建独立纹理。
   * @param descriptor - GPUTextureDescriptor
   * @param label - 可选调试标签
   * @returns TextureHandle
   */
  create(descriptor: GPUTextureDescriptor, label?: string): TextureHandle;

  /**
   * 释放纹理（销毁 GPU 资源并从跟踪器移除）。
   * @param handle - 纹理句柄
   */
  release(handle: TextureHandle): void;

  /**
   * 向 Atlas 添加图像。
   * 使用 Shelf-First-Fit 算法在 Atlas 纹理中找到空闲区域。
   *
   * @param atlasId - Atlas 标识符（如 'icons'、'glyphs'、'patterns'）
   * @param imageData - 要添加的图像数据
   * @param padding - 每侧填充像素数（防止采样溢出），默认 1
   * @returns AtlasRegion 描述图像在 Atlas 中的位置
   */
  addToAtlas(
    atlasId: string,
    imageData: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    padding?: number
  ): AtlasRegion;

  /**
   * 从 Atlas 中移除一个区域（标记为可重用）。
   * 注意：Shelf-First-Fit 不支持完美的空间回收，
   * 移除后的区域可能无法被完全复用。
   *
   * @param atlasId - Atlas ID
   * @param region - 要移除的区域
   */
  removeFromAtlas(atlasId: string, region: AtlasRegion): void;

  /**
   * 获取 Atlas 的纹理句柄。
   * @param atlasId - Atlas ID
   * @returns TextureHandle
   */
  getAtlasTexture(atlasId: string): TextureHandle;

  /** 统计信息。 */
  readonly stats: {
    /** 独立纹理数量。 */
    readonly textureCount: number;
    /** 所有纹理占用的总字节数。 */
    readonly totalBytes: number;
    /** Atlas 数量。 */
    readonly atlasCount: number;
    /** 各 Atlas 的利用率（0~1）。 */
    readonly atlasUtilization: Record<string, number>;

    /** Atlas 整理（defrag）累计执行次数。 */
    readonly defragCount: number;

    /**
     * 各 Atlas 的碎片率快照（0~1，越大越浪费；`getFragmentation()` 与各 atlas 一致）。
     * 键为 atlasId。
     */
    readonly fragmentationByAtlas: Record<string, number>;

    /**
     * 所有 Atlas 中的最大碎片率（与 `getFragmentation()` 一致）。
     */
    readonly fragmentation: number;

    /** 最近一次 defrag 估算回收的字节数（像素面积差 × RGBA8）。 */
    readonly reclaimedBytes: number;
  };

  /**
   * 销毁所有纹理和 Atlas。
   */
  destroyAll(): void;

  /**
   * 在空闲时对指定 Atlas 做货架重排与 GPU 子区域拷贝，降低碎片率（O7）。
   * 若未传 `atlasId`，则对所有已存在的 Atlas 依次整理。
   *
   * @param atlasId - 可选；缺省时处理全部 Atlas
   * @throws Error 当 GPU 拷贝失败或重排无法容纳现有条目时
   */
  defragmentAtlas(atlasId?: string): void;

  /**
   * 返回当前 Atlas 集合中的最大碎片率（0 = 无浪费，1 = 整块未用内容意义下最糟）。
   * 公式：`1 - (usedArea / allocatedArea)`，`allocatedArea = width × height`。
   */
  getFragmentation(): number;

  /**
   * 是否建议在空闲时执行 defrag：最大碎片率 > 0.3 且自上次 defrag 后 Atlas 有增删改。
   */
  shouldDefragment(): boolean;
}

// ===================== Shelf-First-Fit Atlas 内部数据结构 =====================

/**
 * Atlas 中的一个 "shelf"（货架行）。
 * Shelf-First-Fit 将 Atlas 分为多个水平行，
 * 每行的高度由该行中最高的图像决定。
 */
interface AtlasShelf {
  /** 该 shelf 在 Atlas 纹理中的 Y 起始位置（像素）。 */
  y: number;
  /** 该 shelf 的高度（像素），等于放入该行的最高图像高度。 */
  height: number;
  /** 该 shelf 中下一个可用的 X 位置（像素）。 */
  nextX: number;
}

/**
 * 一个完整的 Atlas 实例。
 * 包含 GPU 纹理、shelf 列表和统计信息。
 */
interface AtlasInstance {
  /** Atlas 的 TextureHandle。 */
  handle: TextureHandle;
  /** Atlas 的宽度（像素）。 */
  width: number;
  /** Atlas 的高度（像素）。 */
  height: number;
  /** Shelf 列表（按 Y 位置排序）。 */
  shelves: AtlasShelf[];
  /** 已使用的像素面积（用于利用率计算）。 */
  usedArea: number;

  /**
   * 自上次 `defragmentAtlas` 完成以来，该 Atlas 是否发生过 `addToAtlas` / `removeFromAtlas`。
   */
  modifiedSinceDefrag: boolean;
}

// ===================== 常量 =====================

/** 默认 Atlas 纹理大小（像素） */
const DEFAULT_ATLAS_SIZE = 2048;

/** 估算每像素占用字节数（RGBA8）——用于 MemoryTracker */
const BYTES_PER_PIXEL_RGBA8 = 4;

/** 默认 Atlas 填充（每侧 padding 像素） */
const DEFAULT_ATLAS_PADDING = 1;

/** 建议触发 defrag 的碎片率下限（O7） */
const DEFRAG_FRAGMENTATION_THRESHOLD = 0.3;

// ===================== Atlas 活条目（defrag 用） =====================

/**
 * Atlas 内一条可整理的活记录：保存货架格与对外 `AtlasRegion` 引用，便于原地更新 UV。
 */
interface AtlasLiveEntry {
  /** 全局唯一条目 ID（调试用）。 */
  readonly id: string;

  /** 所属 Atlas ID。 */
  readonly atlasId: string;

  /** 与 `addToAtlas` 一致的每侧 padding。 */
  readonly padding: number;

  /** 图像像素宽（不含 padding）。 */
  readonly imgW: number;

  /** 图像像素高（不含 padding）。 */
  readonly imgH: number;

  /** 含 padding 的占位宽。 */
  readonly paddedW: number;

  /** 含 padding 的占位高。 */
  readonly paddedH: number;

  /**
   * 当前在 Atlas 纹理中的货架格左上角（含 padding 外沿），用于 `copyTextureToTexture` 源矩形。
   */
  slotX: number;

  /**
   * 当前在 Atlas 纹理中的货架格左上角 Y。
   */
  slotY: number;

  /**
   * 对外暴露的区域描述（defrag 后原地更新 UV 与像素坐标）。
   */
  region: AtlasRegion;
}

// ===================== 辅助函数 =====================

/**
 * 获取图像源的宽高。
 *
 * @param source - 图像数据源
 * @returns [width, height]
 */
function getImageDimensions(
  source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData
): [number, number] {
  if (source instanceof ImageData) {
    return [source.width, source.height];
  }
  // ImageBitmap, HTMLCanvasElement, OffscreenCanvas 都有 width/height 属性
  return [source.width, source.height];
}

/**
 * 估算纹理的字节大小。
 * 根据格式、尺寸和 mip 级别计算。
 *
 * @param width - 宽度（像素）
 * @param height - 高度（像素）
 * @param format - 纹理格式
 * @param mipLevelCount - Mip 级别数量
 * @returns 估算字节数
 */
function estimateTextureBytes(
  width: number,
  height: number,
  format: GPUTextureFormat,
  mipLevelCount: number = 1
): number {
  // 根据格式估算每像素字节数
  let bytesPerPixel = BYTES_PER_PIXEL_RGBA8;
  if (format.includes('32float')) {
    bytesPerPixel = format.startsWith('r') ? 4 : format.startsWith('rg') ? 8 : 16;
  } else if (format.includes('16float') || format.includes('16sint') || format.includes('16uint')) {
    bytesPerPixel = format.startsWith('r') ? 2 : format.startsWith('rg') ? 4 : 8;
  } else if (format.includes('depth32float')) {
    bytesPerPixel = 4;
  } else if (format.includes('depth24')) {
    bytesPerPixel = 4;
  }

  // 累加各 mip 级别的面积
  let totalBytes = 0;
  let mipW = width;
  let mipH = height;
  for (let level = 0; level < mipLevelCount; level++) {
    totalBytes += mipW * mipH * bytesPerPixel;
    // 每级 mip 尺寸减半，最小为 1
    mipW = Math.max(1, mipW >> 1);
    mipH = Math.max(1, mipH >> 1);
  }

  return totalBytes;
}

// ===================== 工厂函数 =====================

/**
 * 创建纹理管理器。
 *
 * @param gpuDevice - 已初始化的 GPUDevice
 * @param memTracker - GPU 内存跟踪器
 * @param options - 可选配置
 * @returns TextureManager 实例
 *
 * @example
 * const texMgr = createTextureManager(device, memTracker, {
 *   maxAtlasSize: 4096,
 *   defaultAtlasSize: 2048,
 * });
 */
export function createTextureManager(
  gpuDevice: GPUDevice,
  memTracker: GPUMemoryTracker,
  options?: {
    /** Atlas 纹理的最大尺寸（像素），默认取设备最大纹理尺寸 */
    maxAtlasSize?: number;
    /** Atlas 纹理的初始/默认尺寸（像素），默认 2048 */
    defaultAtlasSize?: number;
  }
): TextureManager {
  // ==================== 参数校验 ====================

  if (!gpuDevice) {
    throw new Error('[TextureManager] createTextureManager: device must be a valid GPUDevice');
  }
  if (!memTracker) {
    throw new Error('[TextureManager] createTextureManager: memTracker must be a valid GPUMemoryTracker');
  }

  // ==================== 配置 ====================

  const maxAtlasSize = options?.maxAtlasSize ?? 4096;
  const defaultAtlasSize = options?.defaultAtlasSize ?? DEFAULT_ATLAS_SIZE;

  // ==================== 内部状态 ====================

  /** 所有独立纹理 */
  const textures = new Map<string, TextureHandle>();

  /** 所有 Atlas 实例 */
  const atlases = new Map<string, AtlasInstance>();

  /** 是否已销毁 */
  let destroyed = false;

  /** 各 Atlas 的活条目列表（用于 defrag 与 UV 原地更新） */
  const atlasLiveEntries = new Map<string, AtlasLiveEntry[]>();

  /** `defragmentAtlas` 累计调用次数（成功计数） */
  let defragCount = 0;

  /** 最近一次 defrag 估算回收字节数 */
  let lastReclaimedBytes = 0;

  // ==================== 内部方法 ====================

  function assertNotDestroyed(): void {
    if (destroyed) {
      throw new Error('[TextureManager] Cannot use a destroyed TextureManager');
    }
  }

  /**
   * 从内部纹理映射与 MemoryTracker 中移除并销毁 GPU 纹理（Atlas 交换时用）。
   *
   * @param handle - 待释放句柄
   */
  function releaseTextureHandleInternal(handle: TextureHandle): void {
    textures.delete(handle.id);
    try {
      handle.texture.destroy();
    } catch {
      /* 忽略重复销毁 */
    }
    memTracker.untrack(handle.id);
  }

  /**
   * 计算单张 Atlas 的碎片率：`1 - usedArea / (width*height)`。
   *
   * @param atlas - Atlas 实例
   * @returns 0~1
   */
  function computeAtlasFragmentation(atlas: AtlasInstance): number {
    const allocated = atlas.width * atlas.height;
    if (allocated <= 0) {
      return 0;
    }
    const used = Math.min(atlas.usedArea, allocated);
    return 1 - used / allocated;
  }

  /**
   * 原地更新活条目的 `AtlasRegion` 像素与 UV（defrag 重排后调用）。
   *
   * @param entry - 活条目
   * @param atlasW - Atlas 宽
   * @param atlasH - Atlas 高
   * @param slotX - 新货架格左上角 X（含 padding 外沿）
   * @param slotY - 新货架格左上角 Y
   */
  function updateEntryRegionFromSlot(
    entry: AtlasLiveEntry,
    atlasW: number,
    atlasH: number,
    slotX: number,
    slotY: number
  ): void {
    entry.slotX = slotX;
    entry.slotY = slotY;
    const pixelX = slotX + entry.padding;
    const pixelY = slotY + entry.padding;
    const r = entry.region as {
      u0: number;
      v0: number;
      u1: number;
      v1: number;
      pixelX: number;
      pixelY: number;
    };
    r.u0 = pixelX / atlasW;
    r.v0 = pixelY / atlasH;
    r.u1 = (pixelX + entry.imgW) / atlasW;
    r.v1 = (pixelY + entry.imgH) / atlasH;
    r.pixelX = pixelX;
    r.pixelY = pixelY;
  }

  /**
   * 创建一个 Atlas 实例。
   *
   * @param atlasId - Atlas ID
   * @param width - 宽度
   * @param height - 高度
   * @returns AtlasInstance
   */
  function createAtlasInstance(
    atlasId: string,
    width: number,
    height: number
  ): AtlasInstance {
    const id = uniqueId('tex-atlas');

    const texture = gpuDevice.createTexture({
      label: `geoforge-atlas-${atlasId}`,
      size: { width, height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const view = texture.createView({
      label: `geoforge-atlas-${atlasId}-view`,
    });

    const handle: TextureHandle = Object.freeze({
      id,
      texture,
      view,
      width,
      height,
      format: 'rgba8unorm' as GPUTextureFormat,
    });

    // 注册到 MemoryTracker
    const estimatedBytes = width * height * BYTES_PER_PIXEL_RGBA8;
    memTracker.track({
      id,
      type: 'texture',
      size: estimatedBytes,
      label: `atlas-${atlasId}`,
    });

    // 注册到独立纹理集合（Atlas 纹理也通过统一接口管理）
    textures.set(id, handle);

    return {
      handle,
      width,
      height,
      shelves: [],
      usedArea: 0,
      modifiedSinceDefrag: false,
    };
  }

  /**
   * 确保指定的 Atlas 存在，不存在则创建。
   *
   * @param atlasId - Atlas ID
   * @returns AtlasInstance
   */
  function ensureAtlas(atlasId: string): AtlasInstance {
    let atlas = atlases.get(atlasId);
    if (!atlas) {
      atlas = createAtlasInstance(atlasId, defaultAtlasSize, defaultAtlasSize);
      atlases.set(atlasId, atlas);
    }
    return atlas;
  }

  /**
   * 在 Atlas 中使用 Shelf-First-Fit 算法找到放置位置。
   *
   * @param atlas - Atlas 实例
   * @param imgWidth - 图像宽度（含 padding）
   * @param imgHeight - 图像高度（含 padding）
   * @returns [x, y] 放置位置，如果放不下返回 null
   */
  function shelfFit(
    atlas: AtlasInstance,
    imgWidth: number,
    imgHeight: number
  ): [number, number] | null {
    // 遍历现有 shelf，查找第一个能容纳图像的 shelf
    for (const shelf of atlas.shelves) {
      // shelf 高度必须足够且水平空间足够
      if (
        imgHeight <= shelf.height &&
        shelf.nextX + imgWidth <= atlas.width
      ) {
        const x = shelf.nextX;
        const y = shelf.y;
        // 推进该 shelf 的 x 指针
        shelf.nextX += imgWidth;
        return [x, y];
      }
    }

    // 没有合适的 shelf——创建新 shelf
    // 新 shelf 的 Y 位置 = 最后一个 shelf 的底部
    let newShelfY = 0;
    if (atlas.shelves.length > 0) {
      const lastShelf = atlas.shelves[atlas.shelves.length - 1];
      newShelfY = lastShelf.y + lastShelf.height;
    }

    // 检查纵向是否还有空间
    if (newShelfY + imgHeight > atlas.height) {
      // Atlas 空间不足
      return null;
    }

    // 检查横向是否足够
    if (imgWidth > atlas.width) {
      return null;
    }

    // 创建新 shelf
    const newShelf: AtlasShelf = {
      y: newShelfY,
      height: imgHeight,
      nextX: imgWidth,
    };
    atlas.shelves.push(newShelf);

    return [0, newShelfY];
  }

  // ==================== 公开方法 ====================

  /**
   * 创建独立纹理。
   */
  function create(descriptor: GPUTextureDescriptor, label?: string): TextureHandle {
    assertNotDestroyed();

    const id = uniqueId('tex');

    // 应用调试标签
    const desc = { ...descriptor };
    if (label) {
      (desc as Record<string, unknown>).label = label;
    }

    const texture = gpuDevice.createTexture(desc);
    const view = texture.createView({
      label: label ? `${label}-view` : `geoforge-tex-${id}-view`,
    });

    // 提取尺寸信息——GPUExtent3DStrict 可能是 dict 或 iterable
    let width = 1;
    let height = 1;
    const size = descriptor.size;
    if (typeof size === 'object' && 'width' in (size as GPUExtent3DDict)) {
      const dict = size as GPUExtent3DDict;
      width = dict.width;
      height = dict.height ?? 1;
    } else if (Array.isArray(size)) {
      width = (size as number[])[0] ?? 1;
      height = (size as number[])[1] ?? 1;
    }
    const format = descriptor.format;

    const handle: TextureHandle = Object.freeze({
      id,
      texture,
      view,
      width,
      height,
      format,
    });

    // 注册到集合和 MemoryTracker
    textures.set(id, handle);

    const mipLevels = descriptor.mipLevelCount ?? 1;
    const estimatedBytes = estimateTextureBytes(width, height, format, mipLevels);
    memTracker.track({ id, type: 'texture', size: estimatedBytes, label });

    return handle;
  }

  /**
   * 释放纹理。
   */
  function release(handle: TextureHandle): void {
    assertNotDestroyed();

    if (!handle || !handle.id) return;

    // 从集合中移除
    textures.delete(handle.id);

    // GPU 销毁
    try {
      handle.texture.destroy();
    } catch {
      // 安全忽略
    }

    // 从 MemoryTracker 移除
    memTracker.untrack(handle.id);
  }

  /**
   * 向 Atlas 添加图像。
   */
  function addToAtlas(
    atlasId: string,
    imageData: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    padding: number = DEFAULT_ATLAS_PADDING
  ): AtlasRegion {
    assertNotDestroyed();

    // 获取图像尺寸
    const [imgW, imgH] = getImageDimensions(imageData);

    if (imgW <= 0 || imgH <= 0) {
      throw new Error(
        `[TextureManager] addToAtlas: image dimensions must be positive, got ${imgW}×${imgH}`
      );
    }

    // 含 padding 的占用尺寸
    const paddedW = imgW + padding * 2;
    const paddedH = imgH + padding * 2;

    // 确保 Atlas 存在
    const atlas = ensureAtlas(atlasId);

    // 尝试 Shelf-First-Fit 放置
    const placement = shelfFit(atlas, paddedW, paddedH);
    if (!placement) {
      throw new Error(
        `[TextureManager] addToAtlas: Atlas '${atlasId}' is full (${atlas.width}×${atlas.height}). ` +
        `Cannot fit ${paddedW}×${paddedH} image. Consider increasing atlas size.`
      );
    }

    const [slotX, slotY] = placement;

    // 图像实际在 Atlas 中的位置（含 padding 偏移）
    const pixelX = slotX + padding;
    const pixelY = slotY + padding;

    atlas.modifiedSinceDefrag = true;

    // 将图像数据拷贝到 Atlas 纹理的指定位置
    if (imageData instanceof ImageData) {
      // ImageData 需要通过 queue.writeTexture 上传
      gpuDevice.queue.writeTexture(
        {
          texture: atlas.handle.texture,
          origin: { x: pixelX, y: pixelY },
        },
        imageData.data,
        {
          bytesPerRow: imgW * 4,
          rowsPerImage: imgH,
        },
        { width: imgW, height: imgH }
      );
    } else {
      // ImageBitmap / HTMLCanvasElement / OffscreenCanvas 使用 copyExternalImageToTexture
      gpuDevice.queue.copyExternalImageToTexture(
        { source: imageData as ImageBitmap },
        {
          texture: atlas.handle.texture,
          origin: { x: pixelX, y: pixelY },
        },
        { width: imgW, height: imgH }
      );
    }

    // 更新已用面积
    atlas.usedArea += imgW * imgH;

    // 计算归一化 UV 坐标
    const u0 = pixelX / atlas.width;
    const v0 = pixelY / atlas.height;
    const u1 = (pixelX + imgW) / atlas.width;
    const v1 = (pixelY + imgH) / atlas.height;

    const region: AtlasRegion = {
      atlasId,
      u0,
      v0,
      u1,
      v1,
      pixelX,
      pixelY,
      pixelWidth: imgW,
      pixelHeight: imgH,
    };

    const liveEntry: AtlasLiveEntry = {
      id: uniqueId('atlas-entry'),
      atlasId,
      padding,
      imgW,
      imgH,
      paddedW,
      paddedH,
      slotX,
      slotY,
      region,
    };
    let bucket = atlasLiveEntries.get(atlasId);
    if (!bucket) {
      bucket = [];
      atlasLiveEntries.set(atlasId, bucket);
    }
    bucket.push(liveEntry);

    return region;
  }

  /**
   * 从 Atlas 中移除一个区域。
   * 注意：Shelf-First-Fit 不支持完美的碎片回收，
   * 这里仅更新已用面积统计。
   */
  function removeFromAtlas(atlasId: string, region: AtlasRegion): void {
    assertNotDestroyed();

    const atlas = atlases.get(atlasId);
    if (!atlas) return;

    // 只更新统计——Shelf-First-Fit 无法回收中间的碎片
    atlas.usedArea = Math.max(0, atlas.usedArea - region.pixelWidth * region.pixelHeight);

    const bucket = atlasLiveEntries.get(atlasId);
    if (bucket && bucket.length > 0) {
      const next = bucket.filter(
        (e) =>
          !(
            e.region.pixelX === region.pixelX &&
            e.region.pixelY === region.pixelY &&
            e.region.pixelWidth === region.pixelWidth &&
            e.region.pixelHeight === region.pixelHeight
          )
      );
      if (next.length === 0) {
        atlasLiveEntries.delete(atlasId);
      } else {
        atlasLiveEntries.set(atlasId, next);
      }
    }
    atlas.modifiedSinceDefrag = true;
  }

  /**
   * 对单个 Atlas 做货架重排与 GPU 子块拷贝（O7）。
   *
   * @param atlasKey - Atlas ID
   */
  function defragmentOneAtlas(atlasKey: string): void {
    const entries = atlasLiveEntries.get(atlasKey);
    const atlas = atlases.get(atlasKey);
    if (!atlas || !entries || entries.length === 0) {
      return;
    }

    const fragBefore = computeAtlasFragmentation(atlas);
    const allocatedBytesBefore = atlas.width * atlas.height * BYTES_PER_PIXEL_RGBA8;

    const sorted = entries.slice().sort((a, b) => b.paddedH - a.paddedH);

    const oldHandle = atlas.handle;
    const w = atlas.width;
    const h = atlas.height;

    let fresh: AtlasInstance;
    try {
      fresh = createAtlasInstance(atlasKey, w, h);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[TextureManager] defragmentAtlas: createAtlasInstance failed: ${msg}`);
    }

    fresh.usedArea = 0;
    fresh.shelves = [];

    try {
      for (let j = 0; j < sorted.length; j += 1) {
        const entry = sorted[j]!;
        const placement = shelfFit(fresh, entry.paddedW, entry.paddedH);
        if (!placement) {
          throw new Error(
            `[TextureManager] defragmentAtlas: shelfFit failed for entry "${entry.id}" in atlas "${atlasKey}"`
          );
        }
        const [nx, ny] = placement;
        try {
          const encoder = gpuDevice.createCommandEncoder();
          encoder.copyTextureToTexture(
            { texture: oldHandle.texture, origin: { x: entry.slotX, y: entry.slotY, z: 0 } },
            { texture: fresh.handle.texture, origin: { x: nx, y: ny, z: 0 } },
            { width: entry.paddedW, height: entry.paddedH, depthOrArrayLayers: 1 },
          );
          gpuDevice.queue.submit([encoder.finish()]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`[TextureManager] defragmentAtlas: copyTextureToTexture failed: ${msg}`);
        }
        updateEntryRegionFromSlot(entry, w, h, nx, ny);
      }
    } catch (err) {
      releaseTextureHandleInternal(fresh.handle);
      throw err instanceof Error ? err : new Error(String(err));
    }

    let usedSum = 0;
    for (let k = 0; k < sorted.length; k += 1) {
      usedSum += sorted[k]!.imgW * sorted[k]!.imgH;
    }
    fresh.usedArea = usedSum;
    fresh.modifiedSinceDefrag = false;

    releaseTextureHandleInternal(oldHandle);
    atlases.set(atlasKey, fresh);

    const fragAfter = computeAtlasFragmentation(fresh);
    lastReclaimedBytes = Math.max(
      0,
      Math.round(Math.max(0, fragBefore - fragAfter) * allocatedBytesBefore)
    );
    defragCount += 1;
    if (__DEV__) {
      console.info(
        `[TextureManager] defragmentAtlas("${atlasKey}"): frag ${fragBefore.toFixed(3)} → ${fragAfter.toFixed(3)}, reclaimed ~${lastReclaimedBytes} B`
      );
    }
  }

  /**
   * 整理全部或指定 Atlas（O7）。
   *
   * @param atlasId - 可选 atlas ID
   */
  function defragmentAtlas(atlasId?: string): void {
    assertNotDestroyed();
    if (atlasId !== undefined && atlasId.length > 0) {
      if (!atlases.has(atlasId)) {
        throw new Error(`[TextureManager] defragmentAtlas: unknown atlas id "${atlasId}"`);
      }
      defragmentOneAtlas(atlasId);
      return;
    }
    const keys = Array.from(atlases.keys());
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!key) {
        continue;
      }
      defragmentOneAtlas(key);
    }
  }

  /**
   * 当前所有 Atlas 中的最大碎片率。
   */
  function getFragmentation(): number {
    let maxFrag = 0;
    for (const a of atlases.values()) {
      maxFrag = Math.max(maxFrag, computeAtlasFragmentation(a));
    }
    return maxFrag;
  }

  /**
   * 是否满足 defrag 启发式条件。
   */
  function shouldDefragment(): boolean {
    if (getFragmentation() <= DEFRAG_FRAGMENTATION_THRESHOLD) {
      return false;
    }
    for (const a of atlases.values()) {
      if (a.modifiedSinceDefrag) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取 Atlas 的纹理句柄。
   */
  function getAtlasTexture(atlasId: string): TextureHandle {
    assertNotDestroyed();

    const atlas = atlases.get(atlasId);
    if (!atlas) {
      throw new Error(`[TextureManager] getAtlasTexture: unknown atlas id "${atlasId}"`);
    }

    return atlas.handle;
  }

  /**
   * 销毁所有纹理和 Atlas。
   */
  function destroyAll(): void {
    if (destroyed) return;

    // 销毁所有独立纹理
    for (const handle of textures.values()) {
      try {
        handle.texture.destroy();
      } catch {
        // 安全忽略
      }
      memTracker.untrack(handle.id);
    }
    textures.clear();

    // 清空 Atlas 记录（纹理已在上面的循环中被销毁）
    atlases.clear();
    atlasLiveEntries.clear();
    defragCount = 0;
    lastReclaimedBytes = 0;

    destroyed = true;
  }

  // ==================== 返回公开接口 ====================

  return {
    create,
    release,
    addToAtlas,
    removeFromAtlas,
    getAtlasTexture,
    defragmentAtlas,
    getFragmentation,
    shouldDefragment,

    get stats() {
      const utilization: Record<string, number> = {};
      const fragmentationByAtlas: Record<string, number> = {};
      for (const [id, atlas] of atlases) {
        const totalArea = atlas.width * atlas.height;
        utilization[id] = totalArea > 0 ? atlas.usedArea / totalArea : 0;
        fragmentationByAtlas[id] = computeAtlasFragmentation(atlas);
      }

      const fragMax = getFragmentation();

      return {
        textureCount: textures.size,
        totalBytes: memTracker.totalBytes,
        atlasCount: atlases.size,
        atlasUtilization: utilization,
        defragCount,
        fragmentationByAtlas,
        fragmentation: fragMax,
        reclaimedBytes: lastReclaimedBytes,
      };
    },

    destroyAll,
  };
}
