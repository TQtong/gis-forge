/**
 * @module preset-3d/globe-gpu
 * @description
 * **L1 集中创建**：`GPUBuffer` / `GPUTexture` / `GPUBindGroupLayout` / `GPURenderPipeline` / `depth32float` 附件。
 * 与 {@link import('./globe-types.ts').GlobeGPURefs} 配合，由调用方传入同一 `refs` 对象以**可测、可销毁**。
 *
 * **不负责**：瓦片纹理 LRU、网格缓存（见 `globe-tiles`）；相机数学（见 `globe-camera`）。
 *
 * @stability experimental
 */

import {
    ATMOSPHERE_WGSL,
    GLOBE_TILE_WGSL,
    SKY_DOME_WGSL,
    TERRAIN_TILE_WGSL,
} from './globe-shaders.ts';
import {
    ATMO_SPHERE_SEGMENTS,
    CAMERA_UNIFORM_SIZE,
    DRAPING_UNIFORM_SIZE,
    SKY_UNIFORM_SIZE,
    TERRAIN_UNIFORM_SIZE,
    TERRAIN_VERTEX_BYTES,
    TILE_PARAMS_SIZE,
    VERTEX_BYTES,
    VERTEX_FLOATS,
} from './globe-constants.ts';
import { tessellateAtmosphereShell } from './globe-atmosphere.ts';
import type { GlobeGPURefs } from './globe-types.ts';

/**
 * 一次性分配地球渲染所需的常驻资源，并写入 `refs`。
 *
 * @param device - 已 `requestDevice()` 的实例
 * @param refs - 可变聚合；本函数会填充 layout / buffer / sampler / 大气索引与顶点缓冲占位尺寸
 *
 * @remarks
 * 大气顶点缓冲仅预分配容量；每帧 RTE 数据由 {@link import('./globe-render.ts').renderAtmosphere} 写入。
 */
export function createGlobeGPUResources(device: GPUDevice, refs: GlobeGPURefs): void {
    refs.cameraUniformBuffer = device.createBuffer({
        size: CAMERA_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:cameraUniforms',
    });

    refs.tileParamsBuffer = device.createBuffer({
        size: TILE_PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:tileParams',
    });

    refs.skyUniformBuffer = device.createBuffer({
        size: SKY_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:skyUniforms',
    });

    refs.atmoMesh = tessellateAtmosphereShell(ATMO_SPHERE_SEGMENTS);

    refs.atmoIndexBuffer = device.createBuffer({
        size: refs.atmoMesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:atmoIndexBuffer',
    });
    device.queue.writeBuffer(
        refs.atmoIndexBuffer,
        0,
        refs.atmoMesh.indices.buffer as ArrayBuffer,
        refs.atmoMesh.indices.byteOffset,
        refs.atmoMesh.indices.byteLength,
    );

    const atmoVertBufSize = refs.atmoMesh.vertexCount * VERTEX_FLOATS * 4;
    refs.atmoVertexBuffer = device.createBuffer({
        size: atmoVertBufSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:atmoVertexBuffer',
    });

    refs.sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        label: 'Globe3D:tileSampler',
    });

    refs.cameraBindGroupLayout = device.createBindGroupLayout({
        label: 'Globe3D:cameraLayout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        }],
    });

    refs.tileBindGroupLayout = device.createBindGroupLayout({
        label: 'Globe3D:tileLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
            },
        ],
    });

    refs.tileParamsBindGroupLayout = device.createBindGroupLayout({
        label: 'Globe3D:tileParamsLayout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
        }],
    });

    refs.fallbackTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: 'Globe3D:fallbackTexture',
    });
    device.queue.writeTexture(
        { texture: refs.fallbackTexture },
        new Uint8Array([10, 20, 50, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
    );

    refs.cameraBindGroup = device.createBindGroup({
        layout: refs.cameraBindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: refs.cameraUniformBuffer },
        }],
        label: 'Globe3D:cameraBG',
    });

    refs.tileParamsBindGroup = device.createBindGroup({
        layout: refs.tileParamsBindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: refs.tileParamsBuffer },
        }],
        label: 'Globe3D:tileParamsBG',
    });

    refs.fallbackBindGroup = device.createBindGroup({
        layout: refs.tileBindGroupLayout,
        entries: [
            { binding: 0, resource: refs.sampler },
            { binding: 1, resource: refs.fallbackTexture.createView() },
        ],
        label: 'Globe3D:fallbackBG',
    });
}

/**
 * 编译 {@link import('./globe-shaders.ts').GLOBE_TILE_WGSL} 并创建三角列表管线。
 *
 * @param device - GPU 设备
 * @param format - swapchain 颜色格式（如 `bgra8unorm`）
 * @param refs - 已含三个 bind group layout
 * @returns 背面剔除 + `depth32float` + `less-equal` 深度测试
 */
export function createGlobePipeline(device: GPUDevice, format: GPUTextureFormat, refs: GlobeGPURefs): GPURenderPipeline {
    const shaderModule = device.createShaderModule({
        code: GLOBE_TILE_WGSL,
        label: 'Globe3D:globeShader',
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [
            refs.cameraBindGroupLayout!,
            refs.tileBindGroupLayout!,
            refs.tileParamsBindGroupLayout!,
        ],
        label: 'Globe3D:globePipelineLayout',
    });

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'globe_vs',
            buffers: [{
                arrayStride: VERTEX_BYTES,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    { shaderLocation: 2, offset: 24, format: 'float32x2' },
                ],
            }],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'globe_fs',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'back',
        },
        depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'less-equal',
        },
        label: 'Globe3D:globePipeline',
    });
}

/**
 * 天穹：无顶点缓冲、全屏三角形、深度写入 `always` 以垫底。
 *
 * @param device - GPU 设备
 * @param format - 颜色格式
 * @returns 内置独立 `skyUniformLayout` 的 pipeline（不写入 `refs` 中的 layout 字段）
 */
export function createSkyPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
    const shaderModule = device.createShaderModule({
        code: SKY_DOME_WGSL,
        label: 'Globe3D:skyShader',
    });

    const skyLayout = device.createBindGroupLayout({
        label: 'Globe3D:skyUniformLayout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        }],
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [skyLayout],
        label: 'Globe3D:skyPipelineLayout',
    });

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'sky_vs',
            buffers: [],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'sky_fs',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'none',
        },
        depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'always',
        },
        label: 'Globe3D:skyPipeline',
    });
}

/**
 * 大气：复用 `cameraBindGroupLayout`，片元加性混合、不写深度。
 *
 * @param device - GPU 设备
 * @param format - 颜色格式
 * @param refs - 需已创建 `cameraBindGroupLayout`
 */
export function createAtmoPipeline(device: GPUDevice, format: GPUTextureFormat, refs: GlobeGPURefs): GPURenderPipeline {
    const shaderModule = device.createShaderModule({
        code: ATMOSPHERE_WGSL,
        label: 'Globe3D:atmoShader',
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [refs.cameraBindGroupLayout!],
        label: 'Globe3D:atmoPipelineLayout',
    });

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'atmo_vs',
            buffers: [{
                arrayStride: VERTEX_BYTES,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },
                ],
            }],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'atmo_fs',
            targets: [{
                format,
                blend: {
                    color: {
                        srcFactor: 'one',
                        dstFactor: 'one',
                        operation: 'add',
                    },
                    alpha: {
                        srcFactor: 'one',
                        dstFactor: 'one',
                        operation: 'add',
                    },
                },
            }],
        },
        primitive: {
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'back',
        },
        depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: false,
            depthCompare: 'always',
        },
        label: 'Globe3D:atmoPipeline',
    });
}

/**
 * 创建地形管线所需的 GPU 资源：bind group layout、uniform buffer、sampler、pipeline。
 *
 * @param device - GPU 设备
 * @param format - swapchain 颜色格式
 * @param refs - 需已含 cameraBindGroupLayout 和 tileBindGroupLayout
 *
 * @stability experimental
 */
export function createTerrainResources(device: GPUDevice, format: GPUTextureFormat, refs: GlobeGPURefs): void {
    // DrapingParams uniform buffer (group 2)
    refs.drapingParamsBuffer = device.createBuffer({
        size: DRAPING_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:drapingParams',
    });

    // DrapingParams bind group layout (group 2)
    refs.drapingBindGroupLayout = device.createBindGroupLayout({
        label: 'Globe3D:drapingLayout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
        }],
    });

    // DrapingParams bind group
    refs.drapingBindGroup = device.createBindGroup({
        layout: refs.drapingBindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: refs.drapingParamsBuffer },
        }],
        label: 'Globe3D:drapingBG',
    });

    // TerrainParams uniform buffer (inside group 3)
    refs.terrainParamsBuffer = device.createBuffer({
        size: TERRAIN_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: 'Globe3D:terrainParams',
    });

    // 地形高程纹理采样器——双线性插值 + clamp-to-edge
    refs.terrainSampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        label: 'Globe3D:terrainSampler',
    });

    // Terrain bind group layout (group 3): heightMap + sampler + TerrainParams
    refs.terrainBindGroupLayout = device.createBindGroupLayout({
        label: 'Globe3D:terrainLayout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX,
                sampler: { type: 'non-filtering' },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            },
        ],
    });

    // Terrain render pipeline
    const shaderModule = device.createShaderModule({
        code: TERRAIN_TILE_WGSL,
        label: 'Globe3D:terrainShader',
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [
            refs.cameraBindGroupLayout!,       // group 0
            refs.tileBindGroupLayout!,          // group 1 (imagery texture)
            refs.drapingBindGroupLayout,        // group 2 (draping params)
            refs.terrainBindGroupLayout,        // group 3 (terrain data)
        ],
        label: 'Globe3D:terrainPipelineLayout',
    });

    refs.terrainPipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'terrain_vs',
            buffers: [{
                arrayStride: TERRAIN_VERTEX_BYTES,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0,  format: 'float32x3' },   // posRTE
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },   // normal
                    { shaderLocation: 2, offset: 24, format: 'float32x2' },   // uv
                    { shaderLocation: 3, offset: 32, format: 'float32' },     // lngDeg
                    { shaderLocation: 4, offset: 36, format: 'float32' },     // latDeg
                ],
            }],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'terrain_fs',
            targets: [{ format }],
        },
        primitive: {
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'back',
        },
        depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'less-equal',
        },
        label: 'Globe3D:terrainPipeline',
    });
}

/**
 * 若 `refs.depthTexture` 缺失或尺寸与当前 `getCurrentTexture()` 不一致，则销毁并重建。
 *
 * @param device - GPU 设备
 * @param w - 物理像素宽度
 * @param h - 物理像素高度
 * @param refs - 更新 `depthTexture` / `depthW` / `depthH`
 */
export function ensureGlobeDepthTexture(device: GPUDevice, w: number, h: number, refs: GlobeGPURefs): void {
    if (refs.depthTexture && refs.depthW === w && refs.depthH === h) { return; }

    if (refs.depthTexture) {
        refs.depthTexture.destroy();
    }

    refs.depthTexture = device.createTexture({
        size: { width: w, height: h },
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        label: 'Globe3D:depthTexture',
    });

    refs.depthW = w;
    refs.depthH = h;
}

/**
 * 释放 `refs` 中除管线/布局外的大部分 GPU 资源，并将指针置 `null`。
 * 最后将 `device`、`gpuContext` 置 `null`，表示实例侧不再持有 WebGPU 句柄。
 *
 * @param refs - 由 {@link createGlobeGPUResources} 填充过的聚合
 *
 * @remarks
 * 必须先调用 `clearTileCache` / `clearMeshCache` 等销毁瓦片/网格独占缓冲，再本函数，避免 use-after-free。
 */
export function destroyGlobeGPUResources(refs: GlobeGPURefs): void {
    if (refs.depthTexture) {
        refs.depthTexture.destroy();
        refs.depthTexture = null;
    }

    if (refs.cameraUniformBuffer) {
        refs.cameraUniformBuffer.destroy();
        refs.cameraUniformBuffer = null;
    }
    if (refs.tileParamsBuffer) {
        refs.tileParamsBuffer.destroy();
        refs.tileParamsBuffer = null;
    }
    if (refs.skyUniformBuffer) {
        refs.skyUniformBuffer.destroy();
        refs.skyUniformBuffer = null;
    }
    if (refs.atmoIndexBuffer) {
        refs.atmoIndexBuffer.destroy();
        refs.atmoIndexBuffer = null;
    }
    if (refs.atmoVertexBuffer) {
        refs.atmoVertexBuffer.destroy();
        refs.atmoVertexBuffer = null;
    }
    refs.atmoMesh = null;

    if (refs.fallbackTexture) {
        refs.fallbackTexture.destroy();
        refs.fallbackTexture = null;
    }
    refs.fallbackBindGroup = null;

    refs.globePipeline = null;
    refs.skyPipeline = null;
    refs.atmoPipeline = null;

    refs.cameraBindGroup = null;
    refs.tileParamsBindGroup = null;
    refs.cameraBindGroupLayout = null;
    refs.tileBindGroupLayout = null;
    refs.tileParamsBindGroupLayout = null;

    refs.sampler = null;

    // 地形资源
    if (refs.drapingParamsBuffer) {
        refs.drapingParamsBuffer.destroy();
        refs.drapingParamsBuffer = null;
    }
    if (refs.terrainParamsBuffer) {
        refs.terrainParamsBuffer.destroy();
        refs.terrainParamsBuffer = null;
    }
    refs.terrainPipeline = null;
    refs.drapingBindGroupLayout = null;
    refs.terrainBindGroupLayout = null;
    refs.terrainSampler = null;
    refs.drapingBindGroup = null;

    refs.device = null;
    refs.gpuContext = null;
}
