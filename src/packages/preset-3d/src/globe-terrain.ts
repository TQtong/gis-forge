/**
 * @module preset-3d/globe-terrain
 * @description
 * 地形管线 CPU 侧：高程瓦片解码（Terrain RGB → Float32）、GPU 纹理上传、
 * 跨 scheme 纹理投影参数（DrapingParams）计算。
 *
 * 支持格式：Mapzen Terrain RGB / Mapbox Terrain RGB / Terrarium
 * GPU 侧纹理为 R32Float（单通道浮点高程），由 terrain_vs 在顶点着色器中采样做位移。
 *
 * @stability experimental
 */

import type { TilingScheme } from '../../core/src/geo/tiling-scheme.ts';

// ════════════════════════════════════════════════════════════════
// §1 类型定义
// ════════════════════════════════════════════════════════════════

/**
 * 高程瓦片数据（CPU 侧解码结果）。
 *
 * 数据布局：行优先，从北到南、从西到东。
 * `heights[row * width + col]` 对应瓦片内 UV = (col/(width-1), row/(height-1))。
 * 单位为米（海拔高度）。
 *
 * @stability experimental
 *
 * @example
 * const hm: HeightmapData = { heights: new Float32Array(65536), width: 256, height: 256 };
 */
export interface HeightmapData {
    /** 高程栅格值（米），长度 = width × height */
    readonly heights: Float32Array;
    /** 栅格宽度（像素/列数） */
    readonly width: number;
    /** 栅格高度（像素/行数） */
    readonly height: number;
}

/**
 * 地形瓦片在 GPU 中的表示。
 * 由 {@link uploadHeightmap} 创建，由 LRU 缓存管理生命周期。
 *
 * @stability experimental
 */
export interface TerrainGPUTile {
    /** R32Float 纹理，存储归一化高程值 */
    readonly texture: GPUTexture;
    /** 高程 = texel × heightScale + heightOffset（米） */
    readonly heightScale: number;
    /** 高程偏移（米） */
    readonly heightOffset: number;
    /** 绑定到 terrain bind group 的实例 */
    readonly bindGroup: GPUBindGroup;
}

/**
 * 地形 RGB 编码格式。
 * - `'mapzen'`: Mapzen Terrain RGB / Terrarium 格式
 * - `'mapbox'`: Mapbox Terrain-DEM v1
 * - `'terrarium'`: AWS Terrarium（与 Mapzen 相同编码）
 */
export type TerrainRGBFormat = 'mapzen' | 'mapbox' | 'terrarium';

// ════════════════════════════════════════════════════════════════
// §2 Terrain RGB 解码
// ════════════════════════════════════════════════════════════════

/**
 * 将 Terrain RGB 编码的 RGBA 像素数据解码为浮点高程值。
 *
 * 编码公式：
 * - Mapzen/Terrarium: h = (R × 256 + G + B / 256) − 32768
 * - Mapbox:           h = ((R × 256 × 256 + G × 256 + B) × 0.1) − 10000
 *
 * @param format - 编码格式标识
 * @param pixels - RGBA 像素数据（Uint8Array），长度 = width × height × 4
 * @param width - 影像宽度（像素）
 * @param height - 影像高度（像素）
 * @returns CPU 侧高程数据
 *
 * @example
 * const hm = decodeTerrainRGB('mapzen', rgbaPixels, 256, 256);
 * console.log(hm.heights[0]); // 海拔米数
 *
 * @stability experimental
 */
export function decodeTerrainRGB(
    format: TerrainRGBFormat,
    pixels: Uint8Array,
    width: number,
    height: number,
): HeightmapData {
    const count = width * height;
    const heights = new Float32Array(count);

    // 遍历每个像素，从 RGBA 通道解码高程
    for (let i = 0; i < count; i++) {
        // 每像素 4 字节：R, G, B, A（A 未使用）
        const offset = i * 4;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];

        if (format === 'mapbox') {
            // Mapbox Terrain-DEM v1：24-bit 编码，0.1m 精度
            // h = ((R × 65536 + G × 256 + B) × 0.1) − 10000
            heights[i] = ((r * 65536 + g * 256 + b) * 0.1) - 10000;
        } else {
            // Mapzen / Terrarium：16.8-bit 编码
            // h = (R × 256 + G + B / 256) − 32768
            heights[i] = (r * 256 + g + b / 256) - 32768;
        }
    }

    return { heights, width, height };
}

// ════════════════════════════════════════════════════════════════
// §3 GPU 纹理上传
// ════════════════════════════════════════════════════════════════

/**
 * 将 {@link HeightmapData} 上传为 GPU R32Float 纹理，并创建 terrain bind group。
 *
 * GPU 纹理格式为 `r32float`（单通道 32 位浮点），顶点着色器通过 `textureSampleLevel`
 * 采样后乘以 `heightScale` + `heightOffset` 得到实际海拔。
 *
 * 当前实现不做高程归一化——直接存储米制值，`heightScale=1, heightOffset=0`。
 * 若未来需要精度优化（16-bit 纹理），可在此处归一化并调整 scale/offset。
 *
 * @param device - GPU 设备
 * @param data - CPU 侧高程数据
 * @param layout - terrain bind group layout（来自 globe-gpu.ts）
 * @param sampler - 线性采样器（双线性插值高程）
 * @param uniformBuffer - terrain params uniform buffer
 * @returns {@link TerrainGPUTile}
 *
 * @example
 * const tile = uploadHeightmap(device, heightmap, layout, sampler, uniformBuf);
 * pass.setBindGroup(3, tile.bindGroup);
 *
 * @stability experimental
 */
export function uploadHeightmap(
    device: GPUDevice,
    data: HeightmapData,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
): TerrainGPUTile {
    // 创建 R32Float 纹理
    const texture = device.createTexture({
        size: { width: data.width, height: data.height },
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: 'Globe3D:terrainHeightmap',
    });

    // 上传高程数据（Float32Array → R32Float 纹理）
    // bytesPerRow 必须对齐到 256 字节（WebGPU 规范要求）
    const bytesPerRow = data.width * 4; // 每像素 4 字节（r32float）
    const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

    if (alignedBytesPerRow === bytesPerRow) {
        // 无需对齐填充——直接上传
        device.queue.writeTexture(
            { texture },
            data.heights.buffer as ArrayBuffer,
            { bytesPerRow, offset: data.heights.byteOffset },
            { width: data.width, height: data.height },
        );
    } else {
        // 需要对齐填充——逐行拷贝到对齐缓冲
        const alignedData = new Float32Array((alignedBytesPerRow / 4) * data.height);
        const srcRowFloats = data.width;
        const dstRowFloats = alignedBytesPerRow / 4;
        for (let row = 0; row < data.height; row++) {
            const srcOffset = row * srcRowFloats;
            const dstOffset = row * dstRowFloats;
            alignedData.set(data.heights.subarray(srcOffset, srcOffset + srcRowFloats), dstOffset);
        }
        device.queue.writeTexture(
            { texture },
            alignedData.buffer as ArrayBuffer,
            { bytesPerRow: alignedBytesPerRow },
            { width: data.width, height: data.height },
        );
    }

    // 当前直接存储米制高程，scale=1 offset=0
    const heightScale = 1.0;
    const heightOffset = 0.0;

    // 创建 terrain bind group：heightMap 纹理 + 采样器 + uniform
    const bindGroup = device.createBindGroup({
        layout,
        entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: uniformBuffer } },
        ],
        label: 'Globe3D:terrainBindGroup',
    });

    return { texture, heightScale, heightOffset, bindGroup };
}

// ════════════════════════════════════════════════════════════════
// §4 跨 Scheme 纹理投影参数（DrapingParams）
// ════════════════════════════════════════════════════════════════

/** 度→弧度乘数 */
const DEG2RAD = Math.PI / 180;

/** 模块级预分配 draping 参数缓冲 [imgWest, imgEast, latToV_scale, latToV_offset] */
const _drapingBuf = new Float32Array(4);

/**
 * 计算跨 scheme 纹理投影参数（DrapingParams）。
 *
 * 当地形使用 Geographic scheme、影像使用 WebMercator scheme 时，
 * 顶点着色器需要将顶点经纬度重新映射到影像瓦片的 UV 坐标。
 *
 * 输出 Float32Array(4)：
 *   [0] = imgWest  — 影像瓦片西经边界（度）
 *   [1] = imgEast  — 影像瓦片东经边界（度）
 *   [2] = latToV_scale  — Mercator V = mercY × scale + offset 中的 scale
 *   [3] = latToV_offset — 上述公式中的 offset
 *
 * 顶点着色器中：
 *   u = (lngDeg - imgWest) / (imgEast - imgWest)
 *   v = mercY(latDeg) × latToV_scale + latToV_offset
 *
 * @param imgScheme - 影像方案（通常为 WebMercator）
 * @param imgZ - 影像瓦片 zoom
 * @param imgX - 影像瓦片列号
 * @param imgY - 影像瓦片行号
 * @returns 预分配 Float32Array(4)，非线程安全
 *
 * @example
 * const params = computeDrapingParams(WebMercator, 5, 16, 11);
 * device.queue.writeBuffer(drapingUniform, 0, params);
 *
 * @stability experimental
 */
export function computeDrapingParams(
    imgScheme: TilingScheme,
    imgZ: number, imgX: number, imgY: number,
): Float32Array {
    // 影像瓦片的经度范围
    const west = imgScheme.xLng(imgX, imgZ);
    const east = imgScheme.xLng(imgX + 1, imgZ);
    // 影像瓦片的纬度范围
    const north = imgScheme.yLat(imgY, imgZ);
    const south = imgScheme.yLat(imgY + 1, imgZ);

    _drapingBuf[0] = west;
    _drapingBuf[1] = east;

    // Mercator Y 值（用于纬度 → V 映射）
    // mercY = log(tan(lat) + sec(lat))，在 WGSL 中逐顶点计算
    // CPU 侧预计算 scale 和 offset 使 V = mercY * scale + offset ∈ [0, 1]
    const northRad = north * DEG2RAD;
    const southRad = south * DEG2RAD;
    const mercNorth = Math.log(Math.tan(northRad) + 1 / Math.cos(northRad));
    const mercSouth = Math.log(Math.tan(southRad) + 1 / Math.cos(southRad));
    // range = mercSouth - mercNorth（mercSouth < mercNorth 因为南纬的 Mercator Y 更小）
    const range = mercSouth - mercNorth;

    // V = (mercY - mercNorth) / range = mercY * (1/range) + (-mercNorth/range)
    _drapingBuf[2] = 1.0 / range;
    _drapingBuf[3] = -mercNorth / range;

    return _drapingBuf;
}
