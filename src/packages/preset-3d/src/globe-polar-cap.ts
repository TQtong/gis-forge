/**
 * @module preset-3d/globe-polar-cap
 * @description
 * **极地冰盖（Polar Cap）渲染模块**——Plan B: Natural Earth 极地纹理。
 *
 * 本模块完整管理极地冰盖的 GPU 生命周期：
 * 1. **程序化纹理生成**：在 CPU 侧使用 TypedArray 逐像素生成 Natural Earth 风格的极地冰盖纹理
 *    （纯 RGBA 计算，不使用 Canvas 2D / SVG / DOM）
 * 2. **网格创建**：调用 `tessellateGlobePolarCap` 生成球冠曲面，上传 GPUBuffer
 * 3. **纹理加载**：可选异步加载外部极地纹理 URL（PNG/JPEG/WebP），替换程序化纹理
 * 4. **渲染**：复用 globePipeline（相同 WGSL + 顶点格式），绘制北极和南极冰盖
 * 5. **销毁**：释放所有 GPUBuffer / GPUTexture
 *
 * ## 纹理设计
 * 程序化纹理使用方位等距投影（Azimuthal Equidistant）：
 * - 中心 (size/2, size/2) = 极点
 * - 边缘（单位圆边界）= 85.05° 纬度
 * - 北极：冰盖（白色）+ 海洋（深蓝）+ 大陆轮廓（灰褐色）
 * - 南极：冰盖（白色）+ 海洋（深蓝）
 *
 * ## 与瓦片 pipeline 的复用
 * 极地冰盖复用 `globePipeline`（相同的 vertex layout、bind group layout）：
 * - group(0): 相机 uniform（已由 renderGlobeTiles 设置）
 * - group(1): sampler + texture2d（冰盖纹理）
 * - group(2): tile params（冰盖 UV offset=0, scale=1）
 *
 * @stability experimental
 */

import {
    tessellateGlobePolarCap,
    meshToRTE,
} from '../../globe/src/globe-tile-mesh.ts';
import type { GlobeTileMesh, GlobeCamera } from '../../globe/src/globe-tile-mesh.ts';
import type { GlobeGPURefs, PolarCapState } from './globe-types.ts';
import { _tileParamsData } from './globe-buffers.ts';
import {
    POLAR_TEXTURE_SIZE,
    POLAR_TEXTURE_LOAD_TIMEOUT_MS,
    NORTH_POLE_BASE_COLOR,
    SOUTH_POLE_BASE_COLOR,
    NORTH_POLE_OCEAN_COLOR,
    SOUTH_POLE_OCEAN_COLOR,
    VERTEX_FLOATS,
} from './globe-constants.ts';

// ════════════════════════════════════════════════════════════════
// §1 程序化极地纹理生成
// ════════════════════════════════════════════════════════════════

/**
 * 基于种子值的简单伪随机数生成器（xorshift32）。
 * 用于程序化纹理噪声，保证跨平台/跨帧结果一致。
 *
 * @param seed - 初始种子值（非零正整数）
 * @returns 返回值 ∈ [0, 1) 的伪随机数
 *
 * @example
 * let s = 12345;
 * s = xorshift32(s); // → 0.xxxx
 */
function xorshift32(seed: number): number {
    // 标准 xorshift32 三步变换
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    // 转换为 [0, 1) 范围
    return (seed >>> 0) / 4294967296;
}

/**
 * Smoothstep 平滑插值函数。将 t 从 [edge0, edge1] 线性范围映射为 S 形曲线 [0, 1]。
 * 用于冰盖边缘的平滑过渡，避免锯齿状硬边界。
 *
 * @param edge0 - 下界
 * @param edge1 - 上界
 * @param t - 输入值
 * @returns 平滑后的 [0, 1] 值
 */
function smoothstep(edge0: number, edge1: number, t: number): number {
    const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
}

/**
 * 2D 值噪声（Value Noise），用于生成极地冰盖的自然边缘不规则形态。
 * 使用整数网格哈希 + 双线性插值，无需预计算排列表。
 *
 * @param x - 2D 坐标 x
 * @param y - 2D 坐标 y
 * @returns 噪声值 ∈ [0, 1)
 *
 * @example
 * const n = valueNoise2D(3.14, 2.71); // → 0.xxx
 */
function valueNoise2D(x: number, y: number): number {
    // 整数网格坐标
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    // 小数部分（用于双线性插值）
    const fx = x - ix;
    const fy = y - iy;

    // 四个网格角点的伪随机哈希值
    // 使用大素数乘法哈希（简单但足够用于视觉噪声）
    const hash = (px: number, py: number): number => {
        // 将 2D 整数坐标混合为 1D 种子
        const seed = ((px * 374761393 + py * 668265263 + 1013904223) & 0x7FFFFFFF);
        return (seed >>> 0) / 2147483648;
    };

    const v00 = hash(ix, iy);
    const v10 = hash(ix + 1, iy);
    const v01 = hash(ix, iy + 1);
    const v11 = hash(ix + 1, iy + 1);

    // Hermite 平滑插值因子（替代线性插值，减少格状伪影）
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    // 双线性插值
    const top = v00 + (v10 - v00) * sx;
    const bottom = v01 + (v11 - v01) * sx;
    return top + (bottom - top) * sy;
}

/**
 * 分形布朗运动（Fractal Brownian Motion）——多层值噪声叠加。
 * 产生自然界常见的 1/f 噪声分布，用于冰盖边缘的多尺度不规则形态。
 *
 * @param x - 2D 坐标 x
 * @param y - 2D 坐标 y
 * @param octaves - 叠加层数（默认 4），越多细节越丰富但计算越慢
 * @returns 噪声值 ∈ [0, 1) 近似
 */
function fbm(x: number, y: number, octaves: number = 4): number {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    let maxAmplitude = 0;

    for (let i = 0; i < octaves; i++) {
        value += valueNoise2D(x * frequency, y * frequency) * amplitude;
        maxAmplitude += amplitude;
        amplitude *= 0.5;    // 每层振幅减半（持久度 0.5）
        frequency *= 2;      // 每层频率翻倍（粗糙度 2.0）
    }

    // 归一化到 [0, 1]
    return value / maxAmplitude;
}

/**
 * 生成 Natural Earth 风格的极地冰盖程序化纹理（纯 TypedArray 逐像素计算）。
 *
 * ## 生成原理
 * 使用方位等距投影坐标系（中心=极点，边缘=85.05°纬度圆）：
 * 1. 计算每像素到中心的归一化径向距离 r ∈ [0, 1]
 * 2. 计算方位角 θ ∈ [0, 2π]
 * 3. 用 fBM 噪声扰动冰盖边界半径，生成自然的锯齿状冰缘
 * 4. r < iceBoundary → 冰盖色（白色+噪声纹理）
 *    r >= iceBoundary → 海洋色（深蓝+噪声纹理）
 * 5. 冰盖边缘使用 smoothstep 做 1-2 像素的柔和过渡
 *
 * ## 性能
 * 在 2048×2048 分辨率下约需 50-100ms（单线程），仅在初始化时执行一次。
 *
 * @param isNorth - true 生成北极纹理，false 生成南极纹理
 * @param size - 纹理边长（像素），默认 {@link POLAR_TEXTURE_SIZE}（2048）
 * @returns RGBA8 像素数据，长度 size × size × 4 字节
 *
 * @example
 * const northPixels = generatePolarIceTexture(true, 2048);
 * // 上传到 GPU：device.queue.writeTexture(...)
 *
 * @stability experimental
 */
export function generatePolarIceTexture(
    isNorth: boolean,
    size: number = POLAR_TEXTURE_SIZE,
): Uint8Array {
    const pixels = new Uint8Array(size * size * 4);

    // 冰盖与海洋的基准色
    const iceColor = isNorth ? NORTH_POLE_BASE_COLOR : SOUTH_POLE_BASE_COLOR;
    const oceanColor = isNorth ? NORTH_POLE_OCEAN_COLOR : SOUTH_POLE_OCEAN_COLOR;

    // 冰盖覆盖半径（归一化）：北极约 0.35（覆盖极点到约 88.3°），南极约 0.85（南极冰盖更大）
    // 这些值模拟 Natural Earth I 中冰盖的视觉比例
    const iceBaseRadius = isNorth ? 0.35 : 0.85;

    // fBM 噪声扰动冰缘的振幅：越大冰缘越不规则
    const iceEdgeNoiseAmplitude = isNorth ? 0.12 : 0.08;

    // 噪声频率基准（与纹理坐标相乘）
    const noiseFreqBase = 6.0;

    // 冰面纹理噪声：细微的明暗变化模拟冰裂纹/积雪分布
    const iceSurfaceNoiseScale = 12.0;
    // 冰面纹理噪声强度 [0,1]：越大冰面明暗变化越明显
    const iceSurfaceNoiseStrength = 0.08;

    // 海洋纹理噪声：模拟洋流/温度变化导致的色调微变
    const oceanNoiseScale = 8.0;
    const oceanNoiseStrength = 0.05;

    // 冰盖边缘过渡宽度（归一化半径单位）
    const edgeTransitionWidth = 0.03;

    // 大陆/岛屿轮廓颜色（仅北极使用，模拟格陵兰/加拿大北极群岛等陆地）
    const landColor: readonly [number, number, number, number] = [140, 135, 115, 255];

    // 北极大陆轮廓参数：使用极坐标下的函数式描述
    // 简化的大陆遮罩——在特定方位角+径向距离范围内标记为陆地
    // 真实 Natural Earth 数据需要矢量文件，此处用参数化近似
    const hasLandMask = isNorth;

    const halfSize = size * 0.5;
    // 随机种子偏移，北极和南极使用不同种子以避免纹理看起来完全对称
    const seedOffset = isNorth ? 0 : 1000;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            // 归一化坐标 [-1, 1]，中心为 (0, 0)
            const nx = (px - halfSize) / halfSize;
            const ny = (py - halfSize) / halfSize;

            // 到中心的径向距离
            const r = Math.sqrt(nx * nx + ny * ny);

            // 方位角 [0, 2π]
            const theta = Math.atan2(ny, nx);

            // 像素在纹理数组中的偏移（RGBA，4 字节/像素）
            const offset = (py * size + px) * 4;

            // 单位圆外部 → 透明（纹理正方形的四角不在极冠范围内）
            if (r > 1.0) {
                // 填充海洋色（而非透明），因为 clamp-to-edge 采样会拉伸边缘像素
                pixels[offset] = oceanColor[0];
                pixels[offset + 1] = oceanColor[1];
                pixels[offset + 2] = oceanColor[2];
                pixels[offset + 3] = oceanColor[3];
                continue;
            }

            // ── 冰盖边界计算（用 fBM 噪声扰动）──
            // 将极坐标 (r, θ) 转为噪声采样坐标
            const noiseX = Math.cos(theta) * noiseFreqBase + seedOffset;
            const noiseY = Math.sin(theta) * noiseFreqBase + seedOffset;
            // fBM 扰动值 ∈ [-amplitude, +amplitude]（中心化到 0）
            const edgeNoise = (fbm(noiseX, noiseY, 4) - 0.5) * 2.0 * iceEdgeNoiseAmplitude;
            // 扰动后的冰盖边界半径
            const iceBoundary = iceBaseRadius + edgeNoise;

            // ── 冰盖/海洋混合因子 ──
            // 1.0 = 纯冰盖，0.0 = 纯海洋，中间为过渡
            const iceFactor = 1.0 - smoothstep(
                iceBoundary - edgeTransitionWidth,
                iceBoundary + edgeTransitionWidth,
                r,
            );

            // ── 冰面纹理噪声 ──
            const iceNoiseVal = fbm(
                nx * iceSurfaceNoiseScale + seedOffset + 500,
                ny * iceSurfaceNoiseScale + seedOffset + 500,
                3,
            );
            // 冰面明暗扰动：中心化到 [-strength, +strength]
            const iceBrightness = 1.0 + (iceNoiseVal - 0.5) * 2.0 * iceSurfaceNoiseStrength;

            // ── 海洋纹理噪声 ──
            const oceanNoiseVal = fbm(
                nx * oceanNoiseScale + seedOffset + 1500,
                ny * oceanNoiseScale + seedOffset + 1500,
                3,
            );
            const oceanBrightness = 1.0 + (oceanNoiseVal - 0.5) * 2.0 * oceanNoiseStrength;

            // ── 基础颜色混合 ──
            let finalR = iceFactor * iceColor[0] * iceBrightness + (1 - iceFactor) * oceanColor[0] * oceanBrightness;
            let finalG = iceFactor * iceColor[1] * iceBrightness + (1 - iceFactor) * oceanColor[1] * oceanBrightness;
            let finalB = iceFactor * iceColor[2] * iceBrightness + (1 - iceFactor) * oceanColor[2] * oceanBrightness;

            // ── 北极大陆遮罩（简化参数化）──
            if (hasLandMask) {
                // 格陵兰（方位角 ≈ -40°~0°，即 320°~360°，径向 0.55~0.85）
                const greenlandAngle = theta < 0 ? theta + 2 * Math.PI : theta;
                const greenlandFactor = computeLandFactor(
                    greenlandAngle, r,
                    5.6, 6.28,      // 方位角范围（弧度）：约 320°~360°
                    0.50, 0.90,     // 径向范围
                    noiseFreqBase, seedOffset + 2000,
                );

                // 加拿大北极群岛（方位角 ≈ 210°~280°，径向 0.60~0.90）
                const canadaFactor = computeLandFactor(
                    greenlandAngle, r,
                    3.66, 4.89,     // 方位角范围：约 210°~280°
                    0.55, 0.92,     // 径向范围
                    noiseFreqBase, seedOffset + 3000,
                );

                // 斯瓦尔巴/新地岛（方位角 ≈ 30°~90°，径向 0.70~0.95）
                const svalbardFactor = computeLandFactor(
                    greenlandAngle, r,
                    0.52, 1.57,     // 方位角范围：约 30°~90°
                    0.65, 0.95,     // 径向范围
                    noiseFreqBase, seedOffset + 4000,
                );

                // 西伯利亚沿岸（方位角 ≈ 90°~180°，径向 0.75~0.98）
                const siberiaFactor = computeLandFactor(
                    greenlandAngle, r,
                    1.57, 3.14,     // 方位角范围：约 90°~180°
                    0.72, 0.98,     // 径向范围
                    noiseFreqBase, seedOffset + 5000,
                );

                // 将大陆色混入
                const totalLand = Math.min(1.0,
                    greenlandFactor + canadaFactor + svalbardFactor + siberiaFactor);
                finalR = finalR * (1 - totalLand) + landColor[0] * totalLand;
                finalG = finalG * (1 - totalLand) + landColor[1] * totalLand;
                finalB = finalB * (1 - totalLand) + landColor[2] * totalLand;
            }

            // ── 极点附近亮度渐变（中心略亮，模拟冰盖厚度→反射率梯度）──
            const centerGlow = 1.0 + (1.0 - r) * 0.03 * iceFactor;
            finalR *= centerGlow;
            finalG *= centerGlow;
            finalB *= centerGlow;

            // ── 写入像素 ──
            pixels[offset] = Math.max(0, Math.min(255, Math.round(finalR)));
            pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(finalG)));
            pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(finalB)));
            pixels[offset + 3] = 255;
        }
    }

    return pixels;
}

/**
 * 计算参数化大陆遮罩因子。
 * 在指定的方位角 + 径向距离范围内，使用 fBM 噪声扰动边界产生自然轮廓。
 *
 * @param angle - 当前像素的方位角 [0, 2π]
 * @param r - 当前像素的归一化径向距离 [0, 1]
 * @param angleMin - 大陆方位角起始（弧度）
 * @param angleMax - 大陆方位角结束（弧度）
 * @param rMin - 大陆径向距离起始
 * @param rMax - 大陆径向距离结束
 * @param noiseFreq - 噪声采样频率
 * @param seedOff - 噪声种子偏移
 * @returns 大陆覆盖因子 [0, 1]
 */
function computeLandFactor(
    angle: number,
    r: number,
    angleMin: number,
    angleMax: number,
    rMin: number,
    rMax: number,
    noiseFreq: number,
    seedOff: number,
): number {
    // 方位角范围检查（含 fBM 噪声扰动边界）
    const angleMid = (angleMin + angleMax) * 0.5;
    const angleHalf = (angleMax - angleMin) * 0.5;
    const angleDist = Math.abs(angle - angleMid);
    // 噪声扰动角度边界 ±10%
    const angleNoise = (fbm(
        Math.cos(angle) * noiseFreq + seedOff,
        Math.sin(angle) * noiseFreq + seedOff,
        3,
    ) - 0.5) * angleHalf * 0.3;
    const angleThreshold = angleHalf + angleNoise;

    if (angleDist > angleThreshold) { return 0; }

    // 径向范围检查（含 fBM 噪声扰动）
    const rMid = (rMin + rMax) * 0.5;
    const rHalf = (rMax - rMin) * 0.5;
    const rNoise = (fbm(
        r * noiseFreq + seedOff + 100,
        angle * noiseFreq + seedOff + 100,
        3,
    ) - 0.5) * rHalf * 0.4;

    const rLow = rMid - rHalf + rNoise;
    const rHigh = rMid + rHalf + rNoise;

    if (r < rLow || r > rHigh) { return 0; }

    // 角度方向的柔和衰减
    const angleFade = smoothstep(angleThreshold, angleThreshold * 0.7, angleDist);
    // 径向方向的柔和衰减
    const rFade = smoothstep(rLow, rLow + 0.03, r) * (1.0 - smoothstep(rHigh - 0.03, rHigh, r));

    return angleFade * rFade * 0.6;
}

// ════════════════════════════════════════════════════════════════
// §2 GPU 资源生命周期
// ════════════════════════════════════════════════════════════════

/**
 * 创建极地冰盖的全部 GPU 资源：网格 + 程序化纹理 + 缓冲区 + bind group。
 *
 * ## 创建顺序
 * 1. `tessellateGlobePolarCap` → CPU 网格（Float64 ECEF + Float32 normals/uvs + Uint32 indices）
 * 2. 索引缓冲（静态，上传一次）
 * 3. 顶点缓冲（预分配容量，每帧 RTE 更新数据）
 * 4. 程序化纹理（`generatePolarIceTexture` → GPU Texture）
 * 5. bind group（sampler + texture，复用 `refs.tileBindGroupLayout`）
 *
 * @param device - 已 `requestDevice()` 的 GPU 设备
 * @param refs - 已初始化的 globe GPU 资源（需含 sampler、tileBindGroupLayout）
 * @param state - 待填充的 PolarCapState
 *
 * @stability experimental
 */
export function createPolarCapResources(
    device: GPUDevice,
    refs: GlobeGPURefs,
    state: PolarCapState,
): void {
    if (!refs.sampler || !refs.tileBindGroupLayout) {
        return;
    }

    // ── 北极 ──
    state.northMesh = tessellateGlobePolarCap(true);
    uploadPolarCapMesh(device, state.northMesh, state, true);
    const northPixels = generatePolarIceTexture(true);
    uploadPolarCapTexture(device, refs, state, true, northPixels, POLAR_TEXTURE_SIZE);
    state.northReady = true;

    // ── 南极 ──
    state.southMesh = tessellateGlobePolarCap(false);
    uploadPolarCapMesh(device, state.southMesh, state, false);
    const southPixels = generatePolarIceTexture(false);
    uploadPolarCapTexture(device, refs, state, false, southPixels, POLAR_TEXTURE_SIZE);
    state.southReady = true;
}

/**
 * 上传极地冰盖网格的索引缓冲和顶点缓冲到 GPU。
 * 索引缓冲为静态数据（上传一次），顶点缓冲仅预分配容量（每帧 RTE 更新）。
 *
 * @param device - GPU 设备
 * @param mesh - CPU 侧极地冰盖网格
 * @param state - 待写入的 PolarCapState
 * @param isNorth - true=北极，false=南极
 */
function uploadPolarCapMesh(
    device: GPUDevice,
    mesh: GlobeTileMesh,
    state: PolarCapState,
    isNorth: boolean,
): void {
    // 索引缓冲（静态）
    const idxBuf = device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:indexBuffer`,
    });
    device.queue.writeBuffer(
        idxBuf, 0,
        mesh.indices.buffer as ArrayBuffer,
        mesh.indices.byteOffset,
        mesh.indices.byteLength,
    );

    // 顶点缓冲（每帧 RTE 更新数据，此处仅预分配容量）
    // 交错格式：posRTE(3) + normal(3) + uv(2) = 8 floats × 4 bytes = 32 bytes/vertex
    const vertBufSize = mesh.vertexCount * VERTEX_FLOATS * 4;
    const vertBuf = device.createBuffer({
        size: vertBufSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:vertexBuffer`,
    });

    if (isNorth) {
        state.northIndexBuffer = idxBuf;
        state.northVertexBuffer = vertBuf;
    } else {
        state.southIndexBuffer = idxBuf;
        state.southVertexBuffer = vertBuf;
    }
}

/**
 * 创建 GPU 纹理并上传 RGBA8 像素数据，然后创建对应的 bind group。
 *
 * @param device - GPU 设备
 * @param refs - 已含 sampler 和 tileBindGroupLayout
 * @param state - 待写入的 PolarCapState
 * @param isNorth - true=北极，false=南极
 * @param pixels - RGBA8 像素数据
 * @param size - 纹理边长（像素）
 */
function uploadPolarCapTexture(
    device: GPUDevice,
    refs: GlobeGPURefs,
    state: PolarCapState,
    isNorth: boolean,
    pixels: Uint8Array,
    size: number,
): void {
    // 创建 GPU 纹理
    const texture = device.createTexture({
        size: { width: size, height: size },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:texture`,
    });

    // 上传像素数据（显式传递 ArrayBuffer + offset + size 避免 SharedArrayBuffer 类型不兼容）
    device.queue.writeTexture(
        { texture },
        pixels.buffer as ArrayBuffer,
        { bytesPerRow: size * 4, offset: pixels.byteOffset },
        { width: size, height: size },
    );

    // 创建 bind group（与瓦片共用 layout）
    const bindGroup = device.createBindGroup({
        layout: refs.tileBindGroupLayout!,
        entries: [
            { binding: 0, resource: refs.sampler! },
            { binding: 1, resource: texture.createView() },
        ],
        label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:bindGroup`,
    });

    // 销毁旧纹理（如果存在）
    if (isNorth) {
        if (state.northTexture) { state.northTexture.destroy(); }
        state.northTexture = texture;
        state.northBindGroup = bindGroup;
    } else {
        if (state.southTexture) { state.southTexture.destroy(); }
        state.southTexture = texture;
        state.southBindGroup = bindGroup;
    }
}

// ════════════════════════════════════════════════════════════════
// §3 异步纹理加载（替换程序化纹理）
// ════════════════════════════════════════════════════════════════

/**
 * 异步加载外部极地纹理 URL 并替换程序化纹理。
 * 使用 `fetch` + `createImageBitmap` 解码影像，然后通过 `copyExternalImageToTexture` 上传 GPU。
 *
 * ## 错误处理
 * - fetch 失败、超时、解码错误均会被 catch，保留已有的程序化纹理不受影响
 * - 加载中的标志 `northLoading` / `southLoading` 防止重复请求
 *
 * @param url - 极地纹理 URL（PNG/JPEG/WebP）
 * @param isNorth - true=北极，false=南极
 * @param device - GPU 设备
 * @param refs - 需含 sampler 和 tileBindGroupLayout
 * @param state - PolarCapState
 * @param isDestroyed - 回调函数，返回 true 时中止操作（实例已销毁）
 *
 * @stability experimental
 */
export async function loadPolarCapTextureFromUrl(
    url: string,
    isNorth: boolean,
    device: GPUDevice,
    refs: GlobeGPURefs,
    state: PolarCapState,
    isDestroyed: () => boolean,
): Promise<void> {
    // 防止重复加载
    if (isNorth && state.northLoading) { return; }
    if (!isNorth && state.southLoading) { return; }

    // 标记加载中
    if (isNorth) { state.northLoading = true; }
    else { state.southLoading = true; }

    try {
        // 带超时的 fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), POLAR_TEXTURE_LOAD_TIMEOUT_MS);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // 检查实例是否已销毁
        if (isDestroyed()) { return; }

        // 解码为 ImageBitmap
        const blob = await response.blob();
        if (isDestroyed()) { return; }

        const bitmap = await createImageBitmap(blob);
        if (isDestroyed()) {
            bitmap.close();
            return;
        }

        // 检查设备和所需 layout 是否仍有效
        if (!refs.sampler || !refs.tileBindGroupLayout) {
            bitmap.close();
            return;
        }

        // 创建新纹理
        const texture = device.createTexture({
            size: { width: bitmap.width, height: bitmap.height },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING
                 | GPUTextureUsage.COPY_DST
                 | GPUTextureUsage.RENDER_ATTACHMENT,
            label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:urlTexture`,
        });

        // 从 ImageBitmap 复制到 GPU 纹理
        device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture },
            { width: bitmap.width, height: bitmap.height },
        );
        bitmap.close();

        // 创建新 bind group
        const bindGroup = device.createBindGroup({
            layout: refs.tileBindGroupLayout,
            entries: [
                { binding: 0, resource: refs.sampler },
                { binding: 1, resource: texture.createView() },
            ],
            label: `Globe3D:polarCap:${isNorth ? 'north' : 'south'}:urlBindGroup`,
        });

        // 替换旧纹理（销毁程序化纹理）
        if (isNorth) {
            if (state.northTexture) { state.northTexture.destroy(); }
            state.northTexture = texture;
            state.northBindGroup = bindGroup;
        } else {
            if (state.southTexture) { state.southTexture.destroy(); }
            state.southTexture = texture;
            state.southBindGroup = bindGroup;
        }

    } catch (err) {
        // 加载失败：保留程序化纹理，仅打印警告
        if (typeof console !== 'undefined') {
            console.warn(
                `[Globe3D] Failed to load ${isNorth ? 'north' : 'south'} polar texture from URL: ${url}`,
                err,
            );
        }
    } finally {
        // 清除加载标志
        if (isNorth) { state.northLoading = false; }
        else { state.southLoading = false; }
    }
}

// ════════════════════════════════════════════════════════════════
// §4 渲染
// ════════════════════════════════════════════════════════════════

/**
 * 在当前渲染通道中绘制北极和南极冰盖。
 * 复用 `globePipeline`（相同的顶点 layout + bind group layout），
 * 每帧将 CPU 侧 ECEF 网格转为 RTE Float32 后上传顶点缓冲。
 *
 * ## 调用时序
 * 必须在 `renderGlobeTiles` 之后、`renderAtmosphere` 之前调用，
 * 以确保冰盖在瓦片之上渲染（深度测试 `less-equal` 允许覆盖同深度瓦片）。
 *
 * ## 每帧开销
 * - 2× `meshToRTE`（CPU Float64→Float32，约 0.1ms / 513 顶点）
 * - 2× `writeBuffer`（GPU 上传，约 16KB/极）
 * - 2× `drawIndexed`（GPU 绘制，约 3000 三角形/极）
 *
 * @param device - GPU 设备
 * @param pass - 已开始的主渲染通道（已 setPipeline + setBindGroup(0)）
 * @param gc - 当前帧 Globe 相机（含 cameraECEF 用于 RTE 减法）
 * @param refs - globe pipeline 和 camera/tileParams bind group
 * @param state - PolarCapState（含网格和纹理）
 * @returns 本次绘制的 draw call 数（0、1 或 2）
 *
 * @stability experimental
 */
export function renderPolarCaps(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
    state: PolarCapState,
): number {
    if (!refs.globePipeline || !refs.cameraBindGroup || !refs.tileParamsBindGroup) {
        return 0;
    }

    // 确保 pipeline 和 group(0)/(2) 已设置
    // renderGlobeTiles 已设置过，但如果极地冰盖在其他位置被调用也需要兜底
    pass.setPipeline(refs.globePipeline);
    pass.setBindGroup(0, refs.cameraBindGroup);
    pass.setBindGroup(2, refs.tileParamsBindGroup);

    // TileParams: UV 偏移 (0,0) + 缩放 (1,1) — 极地冰盖使用全纹理 UV [0,1]
    _tileParamsData[0] = 0;
    _tileParamsData[1] = 0;
    _tileParamsData[2] = 1;
    _tileParamsData[3] = 1;
    device.queue.writeBuffer(refs.tileParamsBuffer!, 0, _tileParamsData);

    let drawCalls = 0;

    // ── 北极冰盖 ──
    drawCalls += renderSinglePolarCap(device, pass, gc, state, true);

    // ── 南极冰盖 ──
    drawCalls += renderSinglePolarCap(device, pass, gc, state, false);

    return drawCalls;
}

/**
 * 渲染单个极地冰盖（北极或南极）。
 * 将 ECEF 网格转为 RTE 交错格式并上传到预分配的顶点缓冲，然后 drawIndexed。
 *
 * @param device - GPU 设备
 * @param pass - 渲染通道
 * @param gc - Globe 相机
 * @param state - PolarCapState
 * @param isNorth - true=北极，false=南极
 * @returns 0 或 1（是否执行了 draw call）
 */
function renderSinglePolarCap(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    state: PolarCapState,
    isNorth: boolean,
): number {
    const mesh = isNorth ? state.northMesh : state.southMesh;
    const indexBuffer = isNorth ? state.northIndexBuffer : state.southIndexBuffer;
    const vertexBuffer = isNorth ? state.northVertexBuffer : state.southVertexBuffer;
    const bindGroup = isNorth ? state.northBindGroup : state.southBindGroup;
    const ready = isNorth ? state.northReady : state.southReady;

    // 任一资源缺失则跳过
    if (!mesh || !indexBuffer || !vertexBuffer || !bindGroup || !ready) {
        return 0;
    }

    // CPU 侧 ECEF → RTE 转换（Float64 减相机 ECEF，输出 Float32 交错数组）
    const rteVerts = meshToRTE(mesh, gc.cameraECEF);

    // 上传 RTE 顶点数据到预分配的缓冲
    device.queue.writeBuffer(
        vertexBuffer, 0,
        rteVerts.buffer as ArrayBuffer,
        rteVerts.byteOffset,
        rteVerts.byteLength,
    );

    // 绑定冰盖纹理（group 1）
    pass.setBindGroup(1, bindGroup);

    // 绑定顶点与索引缓冲
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');

    // 绘制
    pass.drawIndexed(mesh.indexCount);

    return 1;
}

// ════════════════════════════════════════════════════════════════
// §5 销毁
// ════════════════════════════════════════════════════════════════

/**
 * 释放极地冰盖的所有 GPU 资源，并将 state 字段重置为 null/false。
 * 必须在 `destroyGlobeGPUResources` 之前调用。
 *
 * @param state - 待清理的 PolarCapState
 *
 * @stability experimental
 */
export function destroyPolarCapResources(state: PolarCapState): void {
    // 索引缓冲
    if (state.northIndexBuffer) {
        state.northIndexBuffer.destroy();
        state.northIndexBuffer = null;
    }
    if (state.southIndexBuffer) {
        state.southIndexBuffer.destroy();
        state.southIndexBuffer = null;
    }

    // 顶点缓冲
    if (state.northVertexBuffer) {
        state.northVertexBuffer.destroy();
        state.northVertexBuffer = null;
    }
    if (state.southVertexBuffer) {
        state.southVertexBuffer.destroy();
        state.southVertexBuffer = null;
    }

    // 纹理
    if (state.northTexture) {
        state.northTexture.destroy();
        state.northTexture = null;
    }
    if (state.southTexture) {
        state.southTexture.destroy();
        state.southTexture = null;
    }

    // bind group 无需手动销毁（WebGPU 规范：bind group 生命周期由关联资源管理）
    state.northBindGroup = null;
    state.southBindGroup = null;

    // CPU 网格释放引用
    state.northMesh = null;
    state.southMesh = null;

    // 重置标志
    state.northLoading = false;
    state.southLoading = false;
    state.northReady = false;
    state.southReady = false;
}
