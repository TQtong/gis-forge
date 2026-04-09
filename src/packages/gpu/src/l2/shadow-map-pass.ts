// ============================================================
// l2/shadow-map-pass.ts — CSM Shadow Map 渲染辅助
// ============================================================
// 层级：L2
// 职责：管理 N 级 shadow map 的 `texture_depth_2d_array`，并为每级编码
//       独立的 render pass（从光源视角渲染所有 caster 图层的深度）。
//
// 使用流程：
//   const sm = createShadowMapArray(device, { resolution: 2048, numCascades: 4 });
//   // 每帧：
//   sm.encodeCascades(encoder, {
//     cascadeVPs, // Float32Array length 4*16
//     casters: [...layers],
//     lightCameraFor: (cascadeIdx) => cameraStateAt(cascadeIdx),
//   });
//   // 后续传 sm.view() 给 CSMApply
// ============================================================

import type { CameraState } from '../../../core/src/types/viewport.ts';

/**
 * CSM Shadow Map Array 配置。
 */
export interface ShadowMapArrayOptions {
    /** 每级 shadow map 的分辨率（正方形，2 的幂） */
    readonly resolution: number;
    /** 级联数（通常 4） */
    readonly numCascades: number;
    /** 深度纹理格式，默认 depth32float */
    readonly format?: GPUTextureFormat;
}

/**
 * 阴影投射者图层接口（最小抽象）。
 * 必须提供一个 `encodeShadow(encoder, cascadeVP)` 方法，在其内部
 * 使用给定光空间 VP 矩阵把几何写入 depth-only 管线。
 */
export interface ShadowCaster {
    readonly id: string;
    encodeShadow(pass: GPURenderPassEncoder, cascadeVP: Float32Array, camera: CameraState): void;
}

/**
 * 每帧编码参数。
 */
export interface EncodeCascadesOptions {
    /** 4 级光空间 VP 矩阵（Float32Array length = 16 * numCascades） */
    readonly cascadeVPs: Float32Array;
    /** 参与阴影投射的图层列表 */
    readonly casters: readonly ShadowCaster[];
    /** 当前相机状态 */
    readonly camera: CameraState;
}

export interface ShadowMapArray {
    /** 底层数组纹理（texture_depth_2d_array） */
    readonly texture: GPUTexture;
    /** 整个 array 的 view（供 CSMApply 用） */
    view(): GPUTextureView;
    /** 某一级的 view（渲染时用） */
    viewForCascade(cascadeIdx: number): GPUTextureView;
    /** 每级分辨率 */
    readonly resolution: number;
    /** 级联数 */
    readonly numCascades: number;
    /** 深度格式 */
    readonly format: GPUTextureFormat;
    /** 为每级创建 depth-only render pass 并调用 casters.encodeShadow */
    encodeCascades(encoder: GPUCommandEncoder, options: EncodeCascadesOptions): void;
    /** 释放 */
    destroy(): void;
}

/**
 * 创建 CSM 用的 shadow map array。
 */
export function createShadowMapArray(
    device: GPUDevice,
    options: ShadowMapArrayOptions,
): ShadowMapArray {
    if (!device) {
        throw new Error('[ShadowMapArray] device is required');
    }
    const resolution = options.resolution;
    const numCascades = options.numCascades;
    const format = options.format ?? 'depth32float';

    if (!Number.isFinite(resolution) || resolution <= 0 || (resolution & (resolution - 1)) !== 0) {
        throw new Error('[ShadowMapArray] resolution must be a positive power of 2');
    }
    if (!Number.isFinite(numCascades) || numCascades < 1 || numCascades > 4) {
        throw new Error('[ShadowMapArray] numCascades must be in [1,4]');
    }

    const texture = device.createTexture({
        label: 'gis-forge-csm-shadow-array',
        size: { width: resolution, height: resolution, depthOrArrayLayers: numCascades },
        format,
        dimension: '2d',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Per-cascade view 缓存
    const perLayerViews: GPUTextureView[] = new Array(numCascades);
    for (let i = 0; i < numCascades; i++) {
        perLayerViews[i] = texture.createView({
            label: `gis-forge-csm-cascade-${i}-view`,
            dimension: '2d',
            baseArrayLayer: i,
            arrayLayerCount: 1,
        });
    }

    const arrayView = texture.createView({
        label: 'gis-forge-csm-array-view',
        dimension: '2d-array',
        baseArrayLayer: 0,
        arrayLayerCount: numCascades,
    });

    return {
        texture,
        view(): GPUTextureView {
            return arrayView;
        },
        viewForCascade(cascadeIdx: number): GPUTextureView {
            if (cascadeIdx < 0 || cascadeIdx >= numCascades) {
                throw new Error(`[ShadowMapArray] cascadeIdx ${cascadeIdx} out of range`);
            }
            return perLayerViews[cascadeIdx];
        },
        resolution,
        numCascades,
        format,
        encodeCascades(encoder: GPUCommandEncoder, opts: EncodeCascadesOptions): void {
            const { cascadeVPs, casters, camera } = opts;
            if (cascadeVPs.length < 16 * numCascades) {
                throw new Error(
                    `[ShadowMapArray] cascadeVPs length ${cascadeVPs.length} < ${16 * numCascades}`,
                );
            }

            for (let i = 0; i < numCascades; i++) {
                const view = perLayerViews[i];
                // 纯深度 pass：colorAttachments 空数组是 WebGPU spec 允许的
                // （GPURenderPassDescriptor.colorAttachments 为 sequence<...?>，
                //  只要 depthStencilAttachment 非空即合法）。所有主流浏览器
                //  (Chrome 113+, Firefox 141+, Safari 18+) 均已支持。
                const pass = encoder.beginRenderPass({
                    label: `gis-forge-csm-cascade-${i}`,
                    colorAttachments: [],
                    depthStencilAttachment: {
                        view,
                        depthClearValue: 1.0,
                        depthLoadOp: 'clear',
                        depthStoreOp: 'store',
                    },
                });
                // 为该级截取 VP 矩阵（复制成独立 Float32Array 避免外部修改影响）
                const vp = new Float32Array(cascadeVPs.buffer, cascadeVPs.byteOffset + i * 16 * 4, 16);
                for (const caster of casters) {
                    if (!caster) continue;
                    caster.encodeShadow(pass, vp, camera);
                }
                pass.end();
            }
        },
        destroy(): void {
            texture.destroy();
        },
    };
}
