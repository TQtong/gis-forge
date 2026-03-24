// ============================================================
// l1/uploader.ts — TypedArray / L0 数据 → GPU 的传输桥梁
// 层级：L1（GPU 层）
// 职责：将 CPU 端数据（TypedArray、L0 数学类型、图像）上传到 GPU
//       Buffer 和 Texture。提供最佳路径选择（queue.writeBuffer vs
//       StagingRing）、双精度拆分上传、纹理 Mipmap 生成和异步回读。
//
// 被引用于：L2/RenderGraph, L3/ResourceManager, L3/TileScheduler,
//           L4/SourceManager, L4/GlyphManager
//
// 设计要点：
// - writeUniform 走 queue.writeBuffer（小数据最快路径，不走 StagingRing）
// - uploadBuffer 走 BufferPool.acquire + queue.writeBuffer
// - uploadDoublePrecisionPositions 内部调用 L0 splitDoubleArray + RTC
// - uploadFromTransferable 对接 Worker 零拷贝传输
// - readbackBuffer/readbackTexture 使用 mapAsync 异步读取（不阻塞渲染）
// - generateMipmaps 使用逐级 Blit Render Pass（WebGPU 不自动生成 mipmap）
// ============================================================

import type { BufferHandle, BufferPool } from './buffer-pool.ts';
import type { TextureHandle, TextureManager } from './texture-manager.ts';
import type { Mat4f } from '../../../core/src/types/math-types.ts';
import { splitDoubleArray } from '../../../core/src/precision/split-double.ts';

// ===================== GPUUploader 接口 =====================

/**
 * GPU 数据上传器接口。
 * 连接 L0 CPU 数据和 L1 GPU 资源的桥梁。
 *
 * @example
 * const uploader = createGPUUploader(device, bufferPool, textureMgr);
 *
 * // 上传顶点数据
 * const vb = uploader.uploadBuffer(vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
 *
 * // 每帧更新相机矩阵（小数据走 queue.writeBuffer 最快路径）
 * uploader.writeUniform(cameraBuffer, vpMatrix);
 *
 * // 上传双精度坐标（自动 Split-Double）
 * const { highBuffer, lowBuffer } = uploader.uploadDoublePrecisionPositions(
 *   positions64, rtcCenter
 * );
 */
export interface GPUUploader {
  /**
   * 上传 TypedArray 到新的 GPU Buffer。
   * 内部使用 queue.writeBuffer 进行数据传输。
   *
   * @param data - 要上传的数据
   * @param usage - GPUBufferUsageFlags（会自动加上 COPY_DST）
   * @param label - 可选调试标签
   * @returns BufferHandle 句柄
   */
  uploadBuffer(
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string
  ): BufferHandle;

  /**
   * 更新已有 Buffer 的指定偏移处的数据。
   *
   * @param handle - 目标 Buffer 句柄
   * @param data - 要写入的数据
   * @param offset - 目标 Buffer 内的偏移（字节），默认 0
   */
  updateBuffer(
    handle: BufferHandle,
    data: ArrayBuffer | ArrayBufferView,
    offset?: number
  ): void;

  /**
   * 直接写入 Uniform Buffer（每帧高频操作）。
   * 使用 queue.writeBuffer 最快路径，不走 StagingRing。
   *
   * @param handle - Uniform Buffer 句柄
   * @param data - 要写入的数据（如 Mat4f, Float32Array 等）
   * @param offset - 写入偏移（字节），默认 0
   */
  writeUniform(
    handle: BufferHandle,
    data: ArrayBufferView,
    offset?: number
  ): void;

  /**
   * 上传 Mat4f（4×4 矩阵，64 字节）到新的 Uniform Buffer。
   *
   * @param mat - 列主序 4×4 矩阵（Float32Array, length 16）
   * @param label - 可选调试标签
   * @returns BufferHandle
   */
  uploadMat4(mat: Mat4f, label?: string): BufferHandle;

  /**
   * 更新已有的 Mat4 Uniform Buffer。
   *
   * @param handle - 目标 Buffer 句柄
   * @param mat - 新的矩阵数据
   * @param offset - 写入偏移（字节），默认 0
   */
  updateMat4(handle: BufferHandle, mat: Mat4f, offset?: number): void;

  /**
   * 上传 Float64 坐标并自动 Split-Double 拆分。
   * 将每个 Float64 值拆分为 high + low 两个 Float32 值，
   * 分别上传到两个 GPU Buffer。GPU 端用 high + low 重组还原精度。
   *
   * @param positions - Float64Array 坐标 [x1,y1,z1, x2,y2,z2, ...]
   * @param rtcCenter - RTC 中心坐标（已拆分为 high/low Float32）
   * @param label - 可选调试标签
   * @returns 包含 highBuffer 和 lowBuffer 的对象
   */
  uploadDoublePrecisionPositions(
    positions: Float64Array,
    rtcCenter: { high: Float32Array; low: Float32Array },
    label?: string
  ): { highBuffer: BufferHandle; lowBuffer: BufferHandle };

  /**
   * 从 ImageBitmap / HTMLCanvasElement 上传纹理。
   *
   * @param source - 图像数据源
   * @param options - 可选参数
   * @returns TextureHandle
   */
  uploadTexture(
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    options?: {
      format?: GPUTextureFormat;
      mipLevelCount?: number;
      usage?: GPUTextureUsageFlags;
      label?: string;
    }
  ): TextureHandle;

  /**
   * 从 ArrayBufferView 上传纹理（如 heightmap float 数据）。
   *
   * @param data - 原始像素数据
   * @param width - 宽度（像素）
   * @param height - 高度（像素）
   * @param options - 可选参数
   * @returns TextureHandle
   */
  uploadTextureFromBuffer(
    data: ArrayBufferView,
    width: number,
    height: number,
    options?: {
      format?: GPUTextureFormat;
      bytesPerRow?: number;
      label?: string;
    }
  ): TextureHandle;

  /**
   * 为纹理生成 Mipmap。
   * WebGPU 不自动生成 mipmap——使用逐级 Blit 的 Render Pass 实现。
   *
   * @param texture - 要生成 mipmap 的纹理
   */
  generateMipmaps(texture: TextureHandle): void;

  /**
   * 从 Worker transferable ArrayBuffer 直接上传到 GPU。
   * 避免额外拷贝：Worker → 主线程(transfer) → GPU。
   *
   * @param data - 通过 postMessage transfer 获得的 ArrayBuffer
   * @param usage - GPUBufferUsageFlags
   * @param label - 可选调试标签
   * @returns BufferHandle
   */
  uploadFromTransferable(
    data: ArrayBuffer,
    usage: GPUBufferUsageFlags,
    label?: string
  ): BufferHandle;

  /**
   * 异步读取 GPU Buffer 数据（不阻塞渲染）。
   * 内部使用 staging buffer + mapAsync。
   *
   * @param handle - 要读取的 Buffer
   * @param offset - 读取偏移（字节），默认 0
   * @param size - 读取大小（字节），默认整个 Buffer
   * @returns Promise<ArrayBuffer> 读取到的数据
   */
  readbackBuffer(
    handle: BufferHandle,
    offset?: number,
    size?: number
  ): Promise<ArrayBuffer>;

  /**
   * 异步读取纹理像素数据。
   *
   * @param texture - 要读取的纹理
   * @param x - 起始 X 坐标
   * @param y - 起始 Y 坐标
   * @param width - 读取宽度
   * @param height - 读取高度
   * @returns Promise<ArrayBuffer> 读取到的像素数据
   */
  readbackTexture(
    texture: TextureHandle,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<ArrayBuffer>;
}

// ===================== 常量 =====================

/** Mat4f 的字节大小：16 个 float32 = 64 字节 */
const MAT4_BYTE_SIZE = 16 * 4;

/** 纹理 bytesPerRow 对齐要求（WebGPU 规定 256 字节） */
const BYTES_PER_ROW_ALIGNMENT = 256;

/** 每像素字节数查找——常见格式 */
const FORMAT_BYTES_PER_PIXEL: Record<string, number> = {
  'rgba8unorm': 4,
  'rgba8snorm': 4,
  'rgba8uint': 4,
  'rgba8sint': 4,
  'bgra8unorm': 4,
  'r8unorm': 1,
  'r8snorm': 1,
  'r8uint': 1,
  'r8sint': 1,
  'rg8unorm': 2,
  'rg8snorm': 2,
  'r16float': 2,
  'rg16float': 4,
  'rgba16float': 8,
  'r32float': 4,
  'rg32float': 8,
  'rgba32float': 16,
  'depth32float': 4,
  'depth24plus': 4,
  'depth24plus-stencil8': 4,
};

// ===================== 辅助函数 =====================

/**
 * 获取纹理格式的每像素字节数。
 *
 * @param format - GPUTextureFormat
 * @returns 每像素字节数
 */
function getBytesPerPixel(format: GPUTextureFormat): number {
  return FORMAT_BYTES_PER_PIXEL[format] ?? 4;
}

/**
 * 将 bytesPerRow 向上对齐到 256 字节（WebGPU 规范要求）。
 *
 * @param bytesPerRow - 原始每行字节数
 * @returns 对齐后的每行字节数
 */
function alignBytesPerRow(bytesPerRow: number): number {
  return Math.ceil(bytesPerRow / BYTES_PER_ROW_ALIGNMENT) * BYTES_PER_ROW_ALIGNMENT;
}

/**
 * 计算 mipmap 的级别数量。
 * log2(max(width, height)) + 1。
 *
 * @param width - 纹理宽度
 * @param height - 纹理高度
 * @returns mip level 数量
 */
function computeMipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * 获取 ArrayBufferView 或 ArrayBuffer 的字节长度和底层 ArrayBuffer。
 *
 * @param data - 数据源
 * @returns [buffer, byteOffset, byteLength]
 */
function getBufferInfo(data: ArrayBuffer | ArrayBufferView): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  if (data instanceof ArrayBuffer) {
    return { buffer: data, byteOffset: 0, byteLength: data.byteLength };
  }
  // ArrayBufferView（如 Float32Array, Uint8Array 等）
  return {
    buffer: data.buffer as ArrayBuffer,
    byteOffset: data.byteOffset,
    byteLength: data.byteLength,
  };
}

// ===================== 工厂函数 =====================

/**
 * 创建 GPU 数据上传器。
 *
 * @param gpuDevice - 已初始化的 GPUDevice
 * @param bufferPool - Buffer 池实例
 * @param textureMgr - 纹理管理器实例
 * @returns GPUUploader 实例
 *
 * @example
 * const uploader = createGPUUploader(device, bufferPool, textureManager);
 *
 * // 上传顶点数据
 * const vb = uploader.uploadBuffer(
 *   new Float32Array([0,0, 1,0, 0.5,1]),
 *   GPUBufferUsage.VERTEX
 * );
 *
 * // 每帧更新相机 uniform
 * uploader.writeUniform(cameraUniform, vpMatrix);
 */
export function createGPUUploader(
  gpuDevice: GPUDevice,
  bufferPool: BufferPool,
  textureMgr: TextureManager
): GPUUploader {
  // ==================== 参数校验 ====================

  if (!gpuDevice) {
    throw new Error('[GPUUploader] createGPUUploader: device must be a valid GPUDevice');
  }
  if (!bufferPool) {
    throw new Error('[GPUUploader] createGPUUploader: bufferPool must be a valid BufferPool');
  }
  if (!textureMgr) {
    throw new Error('[GPUUploader] createGPUUploader: textureMgr must be a valid TextureManager');
  }

  // ==================== Mipmap 生成管线缓存 ====================

  /** 缓存的 mipmap 生成 shader module */
  let mipmapShaderModule: GPUShaderModule | null = null;

  /** 缓存的 mipmap 生成管线（按格式缓存） */
  const mipmapPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  /** 缓存的 mipmap 采样器 */
  let mipmapSampler: GPUSampler | null = null;

  /**
   * 获取或创建 mipmap 生成用的 Shader Module。
   * 使用全屏三角形 + 双线性采样下采样。
   */
  function getMipmapShaderModule(): GPUShaderModule {
    if (mipmapShaderModule) return mipmapShaderModule;

    // 全屏三角形 + 纹理采样的 WGSL shader
    mipmapShaderModule = gpuDevice.createShaderModule({
      label: 'geoforge-mipmap-generator',
      code: `
        // 顶点着色器：生成覆盖全屏的三角形（无需顶点缓冲区）
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        };

        @vertex
        fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          // 生成覆盖全屏的三角形坐标（大三角形裁剪法）
          let x = f32(i32(vertexIndex & 1u) * 2 - 1);
          let y = f32(i32(vertexIndex >> 1u) * 2 - 1);
          output.position = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
          output.uv = vec2f(f32(vertexIndex & 1u), 1.0 - f32(vertexIndex >> 1u));
          return output;
        }

        @group(0) @binding(0) var srcTexture: texture_2d<f32>;
        @group(0) @binding(1) var srcSampler: sampler;

        @fragment
        fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
          return textureSample(srcTexture, srcSampler, uv);
        }
      `,
    });

    return mipmapShaderModule;
  }

  /**
   * 获取或创建 mipmap 渲染管线。
   */
  function getMipmapPipeline(format: GPUTextureFormat): GPURenderPipeline {
    const cached = mipmapPipelines.get(format);
    if (cached) return cached;

    const shaderModule = getMipmapShaderModule();

    const pipeline = gpuDevice.createRenderPipeline({
      label: `geoforge-mipmap-pipeline-${format}`,
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: undefined,
      },
    });

    mipmapPipelines.set(format, pipeline);
    return pipeline;
  }

  /**
   * 获取 mipmap 采样器（双线性过滤）。
   */
  function getMipmapSampler(): GPUSampler {
    if (mipmapSampler) return mipmapSampler;

    mipmapSampler = gpuDevice.createSampler({
      label: 'geoforge-mipmap-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    return mipmapSampler;
  }

  // ==================== 公开方法 ====================

  /**
   * 上传 TypedArray 到新 GPU Buffer。
   */
  function uploadBuffer(
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string
  ): BufferHandle {
    const info = getBufferInfo(data);

    if (info.byteLength === 0) {
      throw new Error('[GPUUploader] uploadBuffer: data must not be empty');
    }

    // 确保 usage 包含 COPY_DST——queue.writeBuffer 需要
    const finalUsage = usage | GPUBufferUsage.COPY_DST;

    // 通过 BufferPool 分配
    const handle = bufferPool.acquire(info.byteLength, finalUsage, label);

    // 将数据写入 Buffer
    if (data instanceof ArrayBuffer) {
      gpuDevice.queue.writeBuffer(handle.buffer, 0, data);
    } else {
      gpuDevice.queue.writeBuffer(
        handle.buffer,
        0,
        (data as ArrayBufferView).buffer,
        (data as ArrayBufferView).byteOffset,
        (data as ArrayBufferView).byteLength
      );
    }

    return handle;
  }

  /**
   * 更新已有 Buffer 的数据。
   */
  function updateBuffer(
    handle: BufferHandle,
    data: ArrayBuffer | ArrayBufferView,
    offset: number = 0
  ): void {
    if (!handle || !handle.buffer) {
      throw new Error('[GPUUploader] updateBuffer: handle must be valid');
    }

    if (data instanceof ArrayBuffer) {
      gpuDevice.queue.writeBuffer(handle.buffer, offset, data);
    } else {
      gpuDevice.queue.writeBuffer(
        handle.buffer,
        offset,
        (data as ArrayBufferView).buffer,
        (data as ArrayBufferView).byteOffset,
        (data as ArrayBufferView).byteLength
      );
    }
  }

  /**
   * 写入 Uniform Buffer（最快路径）。
   */
  function writeUniform(
    handle: BufferHandle,
    data: ArrayBufferView,
    offset: number = 0
  ): void {
    if (!handle || !handle.buffer) {
      throw new Error('[GPUUploader] writeUniform: handle must be valid');
    }

    // queue.writeBuffer 是小数据的最快路径——内部直接 DMA，不走 staging
    gpuDevice.queue.writeBuffer(
      handle.buffer,
      offset,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
  }

  /**
   * 上传 Mat4f 到新 Uniform Buffer。
   */
  function uploadMat4(mat: Mat4f, label?: string): BufferHandle {
    if (!mat || mat.byteLength < MAT4_BYTE_SIZE) {
      throw new Error(
        `[GPUUploader] uploadMat4: mat must be a Float32Array with at least 16 elements, ` +
        `got byteLength=${mat?.byteLength ?? 0}`
      );
    }

    // 分配 Uniform Buffer
    const handle = bufferPool.acquire(
      MAT4_BYTE_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label ?? 'geoforge-mat4-uniform'
    );

    // 写入矩阵数据
    gpuDevice.queue.writeBuffer(
      handle.buffer,
      0,
      mat.buffer,
      mat.byteOffset,
      MAT4_BYTE_SIZE
    );

    return handle;
  }

  /**
   * 更新 Mat4 Uniform Buffer。
   */
  function updateMat4(handle: BufferHandle, mat: Mat4f, offset: number = 0): void {
    if (!handle || !handle.buffer) {
      throw new Error('[GPUUploader] updateMat4: handle must be valid');
    }
    if (!mat || mat.byteLength < MAT4_BYTE_SIZE) {
      throw new Error('[GPUUploader] updateMat4: mat must have at least 16 float32 elements');
    }

    gpuDevice.queue.writeBuffer(
      handle.buffer,
      offset,
      mat.buffer,
      mat.byteOffset,
      MAT4_BYTE_SIZE
    );
  }

  /**
   * 上传双精度坐标并自动 Split-Double。
   */
  function uploadDoublePrecisionPositions(
    positions: Float64Array,
    rtcCenter: { high: Float32Array; low: Float32Array },
    label?: string
  ): { highBuffer: BufferHandle; lowBuffer: BufferHandle } {
    if (!positions || positions.length === 0) {
      throw new Error('[GPUUploader] uploadDoublePrecisionPositions: positions must not be empty');
    }
    if (!rtcCenter || !rtcCenter.high || !rtcCenter.low) {
      throw new Error('[GPUUploader] uploadDoublePrecisionPositions: rtcCenter must have high and low arrays');
    }

    const elementCount = positions.length;

    // 分配输出 Float32Array（高位和低位）
    const highData = new Float32Array(elementCount);
    const lowData = new Float32Array(elementCount);

    // 调用 L0 的 splitDoubleArray 执行 Veltkamp 拆分
    splitDoubleArray(positions, highData, lowData);

    // 减去 RTC 中心——使坐标相对于中心点（值更小，Float32 精度更好）
    // 每 3 个分量为一组（xyz），减去对应的 RTC 中心分量
    const centerHighX = rtcCenter.high[0];
    const centerHighY = rtcCenter.high[1];
    const centerHighZ = rtcCenter.high.length > 2 ? rtcCenter.high[2] : 0;
    const centerLowX = rtcCenter.low[0];
    const centerLowY = rtcCenter.low[1];
    const centerLowZ = rtcCenter.low.length > 2 ? rtcCenter.low[2] : 0;

    // 对 high 和 low 分别减去中心
    const triplets = Math.floor(elementCount / 3);
    for (let i = 0; i < triplets; i++) {
      const base = i * 3;
      highData[base] -= centerHighX;
      highData[base + 1] -= centerHighY;
      highData[base + 2] -= centerHighZ;

      lowData[base] -= centerLowX;
      lowData[base + 1] -= centerLowY;
      lowData[base + 2] -= centerLowZ;
    }

    // 上传到 GPU
    const highBuffer = uploadBuffer(
      highData,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label ? `${label}-high` : 'geoforge-split-double-high'
    );

    const lowBuffer = uploadBuffer(
      lowData,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label ? `${label}-low` : 'geoforge-split-double-low'
    );

    return { highBuffer, lowBuffer };
  }

  /**
   * 从图像源上传纹理。
   */
  function uploadTexture(
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData,
    options?: {
      format?: GPUTextureFormat;
      mipLevelCount?: number;
      usage?: GPUTextureUsageFlags;
      label?: string;
    }
  ): TextureHandle {
    // 获取图像尺寸
    const width = source.width;
    const height = source.height;

    if (width <= 0 || height <= 0) {
      throw new Error(`[GPUUploader] uploadTexture: invalid dimensions ${width}×${height}`);
    }

    const format = options?.format ?? 'rgba8unorm';
    const mipLevelCount = options?.mipLevelCount ?? 1;
    const usage = (options?.usage ?? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT))
      | GPUTextureUsage.COPY_DST;

    // 通过 TextureManager 创建纹理
    const handle = textureMgr.create(
      {
        label: options?.label ?? 'geoforge-uploaded-texture',
        size: { width, height },
        format,
        mipLevelCount,
        usage,
      },
      options?.label
    );

    // 将图像数据拷贝到纹理
    if (source instanceof ImageData) {
      gpuDevice.queue.writeTexture(
        { texture: handle.texture },
        source.data,
        { bytesPerRow: width * getBytesPerPixel(format), rowsPerImage: height },
        { width, height }
      );
    } else {
      gpuDevice.queue.copyExternalImageToTexture(
        { source: source as ImageBitmap },
        { texture: handle.texture },
        { width, height }
      );
    }

    return handle;
  }

  /**
   * 从 ArrayBufferView 上传纹理数据。
   */
  function uploadTextureFromBuffer(
    data: ArrayBufferView,
    width: number,
    height: number,
    options?: {
      format?: GPUTextureFormat;
      bytesPerRow?: number;
      label?: string;
    }
  ): TextureHandle {
    if (width <= 0 || height <= 0) {
      throw new Error(`[GPUUploader] uploadTextureFromBuffer: invalid dimensions ${width}×${height}`);
    }

    const format = options?.format ?? 'rgba8unorm';
    const bpp = getBytesPerPixel(format);
    const rawBytesPerRow = options?.bytesPerRow ?? (width * bpp);
    // WebGPU 要求 bytesPerRow 对齐到 256
    const alignedBytesPerRow = alignBytesPerRow(rawBytesPerRow);

    // 如果需要对齐，重新排列数据
    let uploadData: ArrayBufferView = data;
    if (alignedBytesPerRow !== rawBytesPerRow) {
      // 需要填充每行到对齐大小
      const paddedData = new Uint8Array(alignedBytesPerRow * height);
      const srcView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      for (let row = 0; row < height; row++) {
        const srcOffset = row * rawBytesPerRow;
        const dstOffset = row * alignedBytesPerRow;
        paddedData.set(
          srcView.subarray(srcOffset, srcOffset + rawBytesPerRow),
          dstOffset
        );
      }
      uploadData = paddedData;
    }

    // 创建纹理
    const handle = textureMgr.create(
      {
        label: options?.label ?? 'geoforge-buffer-texture',
        size: { width, height },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      },
      options?.label
    );

    // 上传数据——提取为纯 ArrayBuffer 避免 SharedArrayBuffer 类型不兼容
    let uploadArrayBuffer: ArrayBuffer;
    if (uploadData instanceof Uint8Array) {
      uploadArrayBuffer = uploadData.buffer.slice(
        uploadData.byteOffset,
        uploadData.byteOffset + uploadData.byteLength
      ) as ArrayBuffer;
    } else {
      const view = uploadData as ArrayBufferView;
      uploadArrayBuffer = view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength
      ) as ArrayBuffer;
    }
    gpuDevice.queue.writeTexture(
      { texture: handle.texture },
      uploadArrayBuffer,
      {
        bytesPerRow: alignedBytesPerRow,
        rowsPerImage: height,
      },
      { width, height }
    );

    return handle;
  }

  /**
   * 生成 Mipmap。
   * 使用逐级 Blit Render Pass 实现。
   */
  function generateMipmaps(texture: TextureHandle): void {
    if (!texture || !texture.texture) {
      throw new Error('[GPUUploader] generateMipmaps: texture must be valid');
    }

    const pipeline = getMipmapPipeline(texture.format);
    const sampler = getMipmapSampler();

    const encoder = gpuDevice.createCommandEncoder({
      label: 'geoforge-mipmap-encoder',
    });

    // 计算 mip 级别数
    const mipCount = computeMipLevelCount(texture.width, texture.height);

    // 逐级生成：level 0 → level 1 → level 2 → ...
    for (let level = 1; level < mipCount; level++) {
      // 源为上一级的视图
      const srcView = texture.texture.createView({
        label: `mipmap-src-level-${level - 1}`,
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });

      // 目标为当前级的视图
      const dstView = texture.texture.createView({
        label: `mipmap-dst-level-${level}`,
        baseMipLevel: level,
        mipLevelCount: 1,
      });

      // 创建 BindGroup
      const bindGroup = gpuDevice.createBindGroup({
        label: `mipmap-bg-level-${level}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: sampler },
        ],
      });

      // 创建 Render Pass
      const pass = encoder.beginRenderPass({
        label: `mipmap-pass-level-${level}`,
        colorAttachments: [
          {
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });

      // 渲染全屏三角形采样上一级
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(4);
      pass.end();
    }

    // 提交 mipmap 生成命令
    gpuDevice.queue.submit([encoder.finish()]);
  }

  /**
   * 从 Worker transferable ArrayBuffer 上传。
   */
  function uploadFromTransferable(
    data: ArrayBuffer,
    usage: GPUBufferUsageFlags,
    label?: string
  ): BufferHandle {
    if (!data || data.byteLength === 0) {
      throw new Error('[GPUUploader] uploadFromTransferable: data must be a non-empty ArrayBuffer');
    }

    // 直接调用 uploadBuffer——ArrayBuffer 从 Worker 传来已是零拷贝
    return uploadBuffer(data, usage, label ?? 'geoforge-transferable');
  }

  /**
   * 异步读取 GPU Buffer 数据。
   */
  async function readbackBuffer(
    handle: BufferHandle,
    offset: number = 0,
    size?: number
  ): Promise<ArrayBuffer> {
    if (!handle || !handle.buffer) {
      throw new Error('[GPUUploader] readbackBuffer: handle must be valid');
    }

    // 确定读取大小
    const readSize = size ?? (handle.size - offset);

    if (readSize <= 0 || offset < 0 || offset + readSize > handle.size) {
      throw new Error(
        `[GPUUploader] readbackBuffer: invalid range [${offset}, ${offset + readSize}) ` +
        `for buffer of size ${handle.size}`
      );
    }

    // 创建 MAP_READ staging buffer
    const stagingBuffer = gpuDevice.createBuffer({
      label: 'geoforge-readback-staging',
      size: readSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // 编码拷贝命令：源 buffer → staging buffer
    const encoder = gpuDevice.createCommandEncoder({
      label: 'geoforge-readback-encoder',
    });
    encoder.copyBufferToBuffer(handle.buffer, offset, stagingBuffer, 0, readSize);
    gpuDevice.queue.submit([encoder.finish()]);

    // 异步映射 staging buffer
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    // 拷贝数据——mappedRange 会在 unmap 后失效，所以必须拷贝
    const result = mappedRange.slice(0);

    // 清理
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  /**
   * 异步读取纹理像素数据。
   */
  async function readbackTexture(
    texture: TextureHandle,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<ArrayBuffer> {
    if (!texture || !texture.texture) {
      throw new Error('[GPUUploader] readbackTexture: texture must be valid');
    }

    if (width <= 0 || height <= 0) {
      throw new Error(`[GPUUploader] readbackTexture: invalid dimensions ${width}×${height}`);
    }

    const bpp = getBytesPerPixel(texture.format);
    const rawBytesPerRow = width * bpp;
    const alignedBytesPerRow = alignBytesPerRow(rawBytesPerRow);
    const totalSize = alignedBytesPerRow * height;

    // 创建 MAP_READ staging buffer
    const stagingBuffer = gpuDevice.createBuffer({
      label: 'geoforge-readback-texture-staging',
      size: totalSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // 编码纹理→buffer 拷贝
    const encoder = gpuDevice.createCommandEncoder({
      label: 'geoforge-readback-texture-encoder',
    });

    encoder.copyTextureToBuffer(
      {
        texture: texture.texture,
        origin: { x, y },
      },
      {
        buffer: stagingBuffer,
        bytesPerRow: alignedBytesPerRow,
        rowsPerImage: height,
      },
      { width, height }
    );

    gpuDevice.queue.submit([encoder.finish()]);

    // 异步映射
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    // 如果有 padding，去除每行末尾的填充
    let result: ArrayBuffer;
    if (alignedBytesPerRow !== rawBytesPerRow) {
      // 需要去除行末填充
      const compacted = new Uint8Array(rawBytesPerRow * height);
      const source = new Uint8Array(mappedRange);
      for (let row = 0; row < height; row++) {
        compacted.set(
          source.subarray(row * alignedBytesPerRow, row * alignedBytesPerRow + rawBytesPerRow),
          row * rawBytesPerRow
        );
      }
      result = compacted.buffer;
    } else {
      result = mappedRange.slice(0);
    }

    // 清理
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return result;
  }

  // ==================== 返回公开接口 ====================

  return {
    uploadBuffer,
    updateBuffer,
    writeUniform,
    uploadMat4,
    updateMat4,
    uploadDoublePrecisionPositions,
    uploadTexture,
    uploadTextureFromBuffer,
    generateMipmaps,
    uploadFromTransferable,
    readbackBuffer,
    readbackTexture,
  };
}
