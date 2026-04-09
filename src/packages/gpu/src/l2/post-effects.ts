// ============================================================
// l2/post-effects.ts — 屏幕空间后处理效果工厂（SSAO / EDL / CSM Apply）
// ============================================================
// 层级：L2（渲染层）
// 职责：封装 SSAO / Eye-Dome Lighting / CSM 应用 三个全屏后处理效果，
//       模仿 compositor.ts 的设计：WGSL 由 `?raw` 导入，pipeline 按输出
//       格式缓存，bind group 每帧重建（因为输入纹理随帧变化）。
//
// 使用模式：
//   const ssao = createSSAOEffect(device);
//   ssao.updateUniforms({ proj, invProj, radius, bias, intensity, screenSize });
//   ssao.execute(encoder, {
//     depthView, normalView, noiseView,
//     outputView, outputFormat,
//   });
//
// 这三个效果都共享 fullscreen-vertex.wgsl 作为 VS；FS 由对应 wgsl 文件提供。
// 注：compose 接口的 outputFormat 必须与 pipeline 缓存键匹配。
// ============================================================

import fullscreenVertexWgsl from '../wgsl/compositor/fullscreen-vertex.wgsl?raw';
import ssaoFragmentWgsl from '../wgsl/compositor/ssao.wgsl?raw';
import edlFragmentWgsl from '../wgsl/compositor/edl.wgsl?raw';
import csmFragmentWgsl from '../wgsl/compositor/csm.wgsl?raw';

// ===================== 常量 =====================

const LABEL_SSAO = 'gis-forge-ssao';
const LABEL_EDL = 'gis-forge-edl';
const LABEL_CSM = 'gis-forge-csm-apply';

/** SSAO uniform 尺寸（字节）：2 * mat4x4(128) + 16 * vec4(256) + 2 * vec4(32) = 416 */
const SSAO_UNIFORM_SIZE = 128 + 256 + 32;
/** EDL uniform 尺寸：vec2 + 6 * f32 = 8 + 24 = 32，但对齐到 16 倍数 → 48 */
const EDL_UNIFORM_SIZE = 48;
/** CSM uniform 尺寸：mat4x4(64) + 4*mat4x4(256) + 3*vec4(48) = 368 */
const CSM_UNIFORM_SIZE = 64 + 256 + 48;

// ===================== 工具：汇编完整的 fullscreen shader =====================

/**
 * 把 fullscreen-vertex.wgsl 与某个 fragment WGSL 拼成一个完整 shader 源码。
 * 注意 VS 文件已经有 struct VertexOutput 定义；FS 文件中的同名 struct 会冲突，
 * 所以 FS 文件中的 VertexOutput 会被自动剥离（简单字符串处理）。
 */
function assembleFullscreenShader(fragmentWgsl: string): string {
    // 剥离 FS 源中重复的 struct VertexOutput { ... }
    const stripped = fragmentWgsl.replace(
        /struct\s+VertexOutput\s*\{[^}]*\}\s*/m,
        '',
    );
    return `${fullscreenVertexWgsl}\n${stripped}`;
}

// ===================== SSAO =====================

/** 用户每帧传入的 SSAO uniform 数据。 */
export interface SSAOUniforms {
    /** 4x4 投影矩阵（列主序 Float32Array, length 16） */
    proj: Float32Array;
    /** 4x4 逆投影矩阵 */
    invProj: Float32Array;
    /** 屏幕尺寸（物理像素） */
    screenSize: [number, number];
    /** 采样半径（视空间单位，米） */
    radius: number;
    /** 偏差（避免自遮蔽，典型 0.025） */
    bias: number;
    /** 强度（1.0 标准，2.0 增强） */
    intensity: number;
    /** 16 个切空间半球样本（每个 [x,y,z]）；省略时使用内置默认样本 */
    samples?: ReadonlyArray<readonly [number, number, number]>;
}

/** SSAO 执行所需的输入纹理。 */
export interface SSAOExecuteInputs {
    /** 场景深度纹理 view（depth texture） */
    depthView: GPUTextureView;
    /** 视空间法线纹理 view（rgba8unorm/rgba16float） */
    normalView: GPUTextureView;
    /** 4×4 旋转噪声纹理 view，采样模式 repeat */
    noiseView: GPUTextureView;
    /** 输出遮蔽纹理 view（单通道或 rgba16float 任一） */
    outputView: GPUTextureView;
    /** 输出格式（用于 pipeline 缓存） */
    outputFormat: GPUTextureFormat;
}

export interface SSAOEffect {
    /** 每帧在 execute 前调用以写入 uniform */
    updateUniforms(u: SSAOUniforms): void;
    /** 在已存在的 encoder 上插入 SSAO 渲染 pass */
    execute(encoder: GPUCommandEncoder, inputs: SSAOExecuteInputs): void;
    /** 释放 GPU 资源 */
    destroy(): void;
}

/**
 * 生成 16 个默认的半球切空间样本（从 Halton 序列构造）。
 * 质量接近 Crytek/McGuire 参考实现。
 */
function defaultSSAOSamples(): Float32Array {
    const out = new Float32Array(16 * 4);
    for (let i = 0; i < 16; i++) {
        // Halton 2/3 生成 [0,1) 的 2D 低差异点
        const u = halton(i + 1, 2);
        const v = halton(i + 1, 3);
        // 半球面：z = u（偏向表面法向）
        const theta = 2 * Math.PI * v;
        const phi = Math.acos(1 - u);
        const sinPhi = Math.sin(phi);
        const x = sinPhi * Math.cos(theta);
        const y = sinPhi * Math.sin(theta);
        const z = Math.cos(phi);
        // 距离加权：更多样本靠近原点（平方分布）
        const scale = 0.1 + 0.9 * (i / 16) * (i / 16);
        out[i * 4] = x * scale;
        out[i * 4 + 1] = y * scale;
        out[i * 4 + 2] = z * scale;
        out[i * 4 + 3] = 1.0;
    }
    return out;
}

function halton(index: number, base: number): number {
    let f = 1;
    let r = 0;
    let i = index;
    while (i > 0) {
        f /= base;
        r += f * (i % base);
        i = Math.floor(i / base);
    }
    return r;
}

/**
 * 创建 SSAO 后处理效果。
 *
 * @param device WebGPU 设备
 */
export function createSSAOEffect(device: GPUDevice): SSAOEffect {
    if (!device) {
        throw new Error('[SSAO] device is required');
    }

    const module = device.createShaderModule({
        label: `${LABEL_SSAO}-module`,
        code: assembleFullscreenShader(ssaoFragmentWgsl),
    });

    const uniformBuffer = device.createBuffer({
        label: `${LABEL_SSAO}-uniform`,
        size: SSAO_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const depthSampler = device.createSampler({
        label: `${LABEL_SSAO}-depth-sampler`,
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    const linearSampler = device.createSampler({
        label: `${LABEL_SSAO}-linear-sampler`,
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
    });

    // ─── 显式 BindGroupLayout（不再依赖 `layout: 'auto'` 反射） ───
    //
    // 绑定序与 ssao.wgsl 严格对应：
    //   0: depth_tex (depth_2d)
    //   1: normal_tex (float 2d)
    //   2: noise_tex (float 2d)
    //   3: depth_sampler
    //   4: linear_sampler
    //   5: uniforms
    const bindGroupLayout = device.createBindGroupLayout({
        label: `${LABEL_SSAO}-bgl`,
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'non-filtering' },
            },
            {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' },
            },
            {
                binding: 5,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            },
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        label: `${LABEL_SSAO}-pl`,
        bindGroupLayouts: [bindGroupLayout],
    });

    // Pipeline 缓存（按输出格式）
    const pipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();

    function getPipeline(format: GPUTextureFormat): GPURenderPipeline {
        const cached = pipelineCache.get(format);
        if (cached) return cached;
        const p = device.createRenderPipeline({
            label: `${LABEL_SSAO}-pipeline-${format}`,
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format }],
            },
            primitive: { topology: 'triangle-list' },
        });
        pipelineCache.set(format, p);
        return p;
    }

    return {
        updateUniforms(u: SSAOUniforms): void {
            // Layout:
            //   proj (mat4x4)             offset  0, size 64 → f32 [0..16)
            //   invProj (mat4x4)          offset 64, size 64 → f32 [16..32)
            //   samples (array<vec4,16>)  offset 128, size 256 → f32 [32..96)
            //   screenAndNoiseScale(vec4) offset 384, size 16 → f32 [96..100)
            //   params (vec4)             offset 400, size 16 → f32 [100..104)
            // 所有字段按 16 字节对齐（vec4/mat4x4 的 WGSL 标准对齐），
            // 避免 "array<vec4,N> 后接 vec2/f32" 的隐式 padding 歧义。
            const data = new ArrayBuffer(SSAO_UNIFORM_SIZE);
            const f32 = new Float32Array(data);

            f32.set(u.proj, 0);
            f32.set(u.invProj, 16);

            let samplesData: Float32Array;
            if (u.samples && u.samples.length >= 16) {
                samplesData = new Float32Array(16 * 4);
                for (let i = 0; i < 16; i++) {
                    samplesData[i * 4] = u.samples[i][0];
                    samplesData[i * 4 + 1] = u.samples[i][1];
                    samplesData[i * 4 + 2] = u.samples[i][2];
                    samplesData[i * 4 + 3] = 1.0;
                }
            } else {
                samplesData = defaultSSAOSamples();
            }
            f32.set(samplesData, 32);

            // screenAndNoiseScale: xy = screenSize, zw = screenSize / 4
            f32[96] = u.screenSize[0];
            f32[97] = u.screenSize[1];
            f32[98] = u.screenSize[0] / 4.0;
            f32[99] = u.screenSize[1] / 4.0;

            // params: x = radius, y = bias, z = intensity, w = pad
            f32[100] = u.radius;
            f32[101] = u.bias;
            f32[102] = u.intensity;
            f32[103] = 0;

            device.queue.writeBuffer(uniformBuffer, 0, data);
        },

        execute(encoder: GPUCommandEncoder, inputs: SSAOExecuteInputs): void {
            const pipeline = getPipeline(inputs.outputFormat);
            const bindGroup = device.createBindGroup({
                label: `${LABEL_SSAO}-bg`,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: inputs.depthView },
                    { binding: 1, resource: inputs.normalView },
                    { binding: 2, resource: inputs.noiseView },
                    { binding: 3, resource: depthSampler },
                    { binding: 4, resource: linearSampler },
                    { binding: 5, resource: { buffer: uniformBuffer } },
                ],
            });

            const pass = encoder.beginRenderPass({
                label: `${LABEL_SSAO}-pass`,
                colorAttachments: [{
                    view: inputs.outputView,
                    clearValue: { r: 1, g: 1, b: 1, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3, 1, 0, 0);
            pass.end();
        },

        destroy(): void {
            uniformBuffer.destroy();
            pipelineCache.clear();
        },
    };
}

// ===================== EDL (Eye-Dome Lighting) =====================

export interface EDLUniforms {
    screenSize: [number, number];
    /** 强度系数（典型 1.0-10.0） */
    strength: number;
    /** 邻域采样半径（像素） */
    radius: number;
    /** 全局透明度 */
    opacity: number;
}

export interface EDLExecuteInputs {
    colorView: GPUTextureView;
    depthView: GPUTextureView;
    outputView: GPUTextureView;
    outputFormat: GPUTextureFormat;
}

export interface EDLEffect {
    updateUniforms(u: EDLUniforms): void;
    execute(encoder: GPUCommandEncoder, inputs: EDLExecuteInputs): void;
    destroy(): void;
}

export function createEDLEffect(device: GPUDevice): EDLEffect {
    if (!device) {
        throw new Error('[EDL] device is required');
    }

    const module = device.createShaderModule({
        label: `${LABEL_EDL}-module`,
        code: assembleFullscreenShader(edlFragmentWgsl),
    });

    const uniformBuffer = device.createBuffer({
        label: `${LABEL_EDL}-uniform`,
        size: EDL_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 颜色纹理用 filtering sampler（支持 linear 插值）
    const colorSampler = device.createSampler({
        label: `${LABEL_EDL}-color-sampler`,
        magFilter: 'linear',
        minFilter: 'linear',
    });

    // 深度纹理必须用 non-filtering sampler（WebGPU 限制：texture_depth_2d
    // 只能与 non-filtering sampler 搭配 textureSample）
    const depthSampler = device.createSampler({
        label: `${LABEL_EDL}-depth-sampler`,
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    // ─── 显式 BindGroupLayout ───
    // 绑定序与 edl.wgsl 对应：
    //   0: color_tex   (float 2d)
    //   1: depth_tex   (depth 2d)
    //   2: color_samp  (filtering)
    //   3: depth_samp  (non-filtering, depth texture 约束)
    //   4: uniforms
    const bindGroupLayout = device.createBindGroupLayout({
        label: `${LABEL_EDL}-bgl`,
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'non-filtering' },
            },
            {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            },
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        label: `${LABEL_EDL}-pl`,
        bindGroupLayouts: [bindGroupLayout],
    });

    const pipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();

    function getPipeline(format: GPUTextureFormat): GPURenderPipeline {
        const cached = pipelineCache.get(format);
        if (cached) return cached;
        const p = device.createRenderPipeline({
            label: `${LABEL_EDL}-pipeline-${format}`,
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format }],
            },
            primitive: { topology: 'triangle-list' },
        });
        pipelineCache.set(format, p);
        return p;
    }

    return {
        updateUniforms(u: EDLUniforms): void {
            const data = new ArrayBuffer(EDL_UNIFORM_SIZE);
            const f32 = new Float32Array(data);
            f32[0] = u.screenSize[0];
            f32[1] = u.screenSize[1];
            f32[2] = u.strength;
            f32[3] = u.radius;
            f32[4] = u.opacity;
            // rest = pad
            device.queue.writeBuffer(uniformBuffer, 0, data);
        },

        execute(encoder: GPUCommandEncoder, inputs: EDLExecuteInputs): void {
            const pipeline = getPipeline(inputs.outputFormat);
            const bindGroup = device.createBindGroup({
                label: `${LABEL_EDL}-bg`,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: inputs.colorView },
                    { binding: 1, resource: inputs.depthView },
                    { binding: 2, resource: colorSampler },
                    { binding: 3, resource: depthSampler },
                    { binding: 4, resource: { buffer: uniformBuffer } },
                ],
            });

            const pass = encoder.beginRenderPass({
                label: `${LABEL_EDL}-pass`,
                colorAttachments: [{
                    view: inputs.outputView,
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3, 1, 0, 0);
            pass.end();
        },

        destroy(): void {
            uniformBuffer.destroy();
            pipelineCache.clear();
        },
    };
}

// ===================== CSM Apply =====================

export interface CSMApplyUniforms {
    /** 相机逆视图投影矩阵（Float32Array length 16） */
    invViewProj: Float32Array;
    /** 4 级光空间 VP（Float32Array length 64） */
    lightVP: Float32Array;
    /** 4 级末端的视空间分割距离（米） */
    cascadeSplits: [number, number, number, number];
    /** 深度偏差（典型 0.0005） */
    depthBias: number;
    /** 法线偏差（典型 0.01） */
    normalBias: number;
    /** PCF 半径（texels） */
    pcfRadius: number;
    /**
     * 相机 near 平面（米）。用于 shader 里把 NDC 深度反算为视空间 z。
     * 若投影用的是 Reversed-Z，调用方应把 (far, near) 颠倒传入。
     */
    near: number;
    /** 相机 far 平面（米）。 */
    far: number;
}

export interface CSMApplyExecuteInputs {
    depthView: GPUTextureView;
    /** 4 级 shadow map 的 texture_depth_2d_array view */
    shadowMapArrayView: GPUTextureView;
    outputView: GPUTextureView;
    outputFormat: GPUTextureFormat;
}

export interface CSMApplyEffect {
    updateUniforms(u: CSMApplyUniforms): void;
    execute(encoder: GPUCommandEncoder, inputs: CSMApplyExecuteInputs): void;
    destroy(): void;
}

export function createCSMApplyEffect(device: GPUDevice): CSMApplyEffect {
    if (!device) {
        throw new Error('[CSMApply] device is required');
    }

    const module = device.createShaderModule({
        label: `${LABEL_CSM}-module`,
        code: assembleFullscreenShader(csmFragmentWgsl),
    });

    const uniformBuffer = device.createBuffer({
        label: `${LABEL_CSM}-uniform`,
        size: CSM_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shadowSampler = device.createSampler({
        label: `${LABEL_CSM}-shadow-sampler`,
        magFilter: 'linear',
        minFilter: 'linear',
        compare: 'less',
    });

    const depthSampler = device.createSampler({
        label: `${LABEL_CSM}-depth-sampler`,
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    // ─── 显式 BindGroupLayout ───
    // 绑定序与 csm.wgsl 对应：
    //   0: depth_tex       (depth 2d)
    //   1: shadow_maps     (depth 2d-array)
    //   2: shadow_sampler  (sampler_comparison，用于 PCF textureSampleCompareLevel)
    //   3: depth_sampler   (non-filtering，用于 depth 纹理 textureSample)
    //   4: uniforms
    const bindGroupLayout = device.createBindGroupLayout({
        label: `${LABEL_CSM}-bgl`,
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d-array' },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'comparison' },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'non-filtering' },
            },
            {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            },
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        label: `${LABEL_CSM}-pl`,
        bindGroupLayouts: [bindGroupLayout],
    });

    const pipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();

    function getPipeline(format: GPUTextureFormat): GPURenderPipeline {
        const cached = pipelineCache.get(format);
        if (cached) return cached;
        const p = device.createRenderPipeline({
            label: `${LABEL_CSM}-pipeline-${format}`,
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format }],
            },
            primitive: { topology: 'triangle-list' },
        });
        pipelineCache.set(format, p);
        return p;
    }

    return {
        updateUniforms(u: CSMApplyUniforms): void {
            // Layout:
            //   invViewProj (mat4x4)       offset  0, size 64 → f32 [0..16)
            //   lightVP (array<mat4x4, 4>) offset 64, size 256 → f32 [16..80)
            //   cascadeSplits (vec4)       offset 320, size 16 → f32 [80..84)
            //   params (vec4)              offset 336, size 16 → f32 [84..88)
            //   projParams (vec4)          offset 352, size 16 → f32 [88..92)
            // 所有字段按 16 字节对齐
            const data = new ArrayBuffer(CSM_UNIFORM_SIZE);
            const f32 = new Float32Array(data);
            f32.set(u.invViewProj, 0);
            f32.set(u.lightVP, 16);
            f32[80] = u.cascadeSplits[0];
            f32[81] = u.cascadeSplits[1];
            f32[82] = u.cascadeSplits[2];
            f32[83] = u.cascadeSplits[3];
            // params: x = depthBias, y = normalBias, z = pcfRadius, w = pad
            f32[84] = u.depthBias;
            f32[85] = u.normalBias;
            f32[86] = u.pcfRadius;
            f32[87] = 0;
            // projParams: x = near, y = far, zw = pad
            f32[88] = u.near;
            f32[89] = u.far;
            f32[90] = 0;
            f32[91] = 0;
            device.queue.writeBuffer(uniformBuffer, 0, data);
        },

        execute(encoder: GPUCommandEncoder, inputs: CSMApplyExecuteInputs): void {
            const pipeline = getPipeline(inputs.outputFormat);
            const bindGroup = device.createBindGroup({
                label: `${LABEL_CSM}-bg`,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: inputs.depthView },
                    { binding: 1, resource: inputs.shadowMapArrayView },
                    { binding: 2, resource: shadowSampler },
                    { binding: 3, resource: depthSampler },
                    { binding: 4, resource: { buffer: uniformBuffer } },
                ],
            });

            const pass = encoder.beginRenderPass({
                label: `${LABEL_CSM}-pass`,
                colorAttachments: [{
                    view: inputs.outputView,
                    clearValue: { r: 1, g: 1, b: 1, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3, 1, 0, 0);
            pass.end();
        },

        destroy(): void {
            uniformBuffer.destroy();
            pipelineCache.clear();
        },
    };
}
