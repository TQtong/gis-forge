/**
 * @module preset-3d/globe-utils
 * @description
 * Globe3D **无状态工具函数**：角度归一化、WebGPU 适配器回退、地平线距离、截锥分割、对数深度常数。
 * 依赖 `globals` / `navigator.gpu` 的函数在 SSR 环境调用前需自行守卫。
 *
 * @stability experimental
 */

declare const __DEV__: boolean | undefined;

import { WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import { TWO_PI } from './globe-constants.ts';

/**
 * 开发环境向 `console.warn` 透传；生产构建 `__DEV__` 为 false 时无开销。
 *
 * @param args - 与 `console.warn` 相同
 */
export function devWarn(...args: unknown[]): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.warn(...args);
    }
}

/**
 * 开发环境向 `console.error` 透传。
 *
 * @param args - 与 `console.error` 相同
 */
export function devError(...args: unknown[]): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.error(...args);
    }
}

/**
 * 将任意弧度值归一化到半开区间 `[0, 2π)`，便于比较方位角。
 *
 * @param rad - 输入弧度；`NaN` / `±Infinity` → `0`
 * @returns 等价正角度（弧度）
 */
export function normalizeAngleRad(rad: number): number {
    if (!Number.isFinite(rad)) { return 0; }
    let x = rad % TWO_PI;
    if (x < 0) { x += TWO_PI; }
    return x;
}

/**
 * 依次尝试 `high-performance` → `low-power` → 默认选项请求 `GPUAdapter`。
 * 远程桌面或省电策略下仅某一档可能成功。
 *
 * @param gpu - `navigator.gpu`
 * @returns 适配器；全部失败为 `null`
 */
export async function requestGpuAdapterWithFallback(gpu: GPU): Promise<GPUAdapter | null> {
    const optionSets: GPURequestAdapterOptions[] = [
        { powerPreference: 'high-performance' },
        { powerPreference: 'low-power' },
        {},
    ];
    for (const opts of optionSets) {
        try {
            const adapter = await gpu.requestAdapter(opts);
            if (adapter !== null) { return adapter; }
        } catch {
            /* 继续尝试下一档 */
        }
    }
    return null;
}

/**
 * 以球近似地球，计算视点到地平线（切线）距离：\(d = \sqrt{h^2 + 2 R h}\)。
 *
 * @param altitude - 相机高度 \(h\)（米），相对椭球或海平面定义见调用方
 * @returns 地平线距离（米）
 */
export function computeHorizonDist(altitude: number): number {
    return Math.sqrt(altitude * altitude + 2.0 * WGS84_A * altitude);
}

/**
 * 当 `far/near` 超过 `maxRatio` 时，在对数空间切分为多个子截锥，供未来多 pass 渲染。
 * 当前主路径仍使用单截锥 + 对数深度；本函数保留供扩展。
 *
 * @param nearZ - 近裁剪面（米），须 > 0
 * @param farZ - 远裁剪面（米），须 > nearZ
 * @param maxRatio - 单截锥允许的最大 far/near，默认 10000
 * @returns 子截锥 `{near,far}` 数组，从远到近（先画远）
 */
export function computeCascadeFrusta(
    nearZ: number,
    farZ: number,
    maxRatio: number = 10000,
): Array<{ near: number; far: number }> {
    if (nearZ <= 0 || farZ <= nearZ) {
        return [{ near: Math.max(nearZ, 0.1), far: Math.max(farZ, 1.0) }];
    }
    const ratio = farZ / nearZ;
    if (ratio <= maxRatio) {
        return [{ near: nearZ, far: farZ }];
    }
    const numFrusta = Math.ceil(Math.log(ratio) / Math.log(maxRatio));
    const frusta: Array<{ near: number; far: number }> = [];
    const logNear = Math.log(nearZ);
    const logFar = Math.log(farZ);
    const step = (logFar - logNear) / numFrusta;
    for (let i = numFrusta - 1; i >= 0; i--) {
        const fNear = Math.exp(logNear + step * i);
        const fFar = Math.exp(logNear + step * (i + 1));
        const overlapNear = i > 0 ? fNear * 0.8 : fNear;
        frusta.push({ near: overlapNear, far: fFar });
    }
    return frusta;
}

/**
 * WebGPU NDC \(z \in [0,1]\) 下对数深度系数：`logDepthBufFC = 1 / log2(farZ + 1)`。
 * 与 `GLOBE_TILE_WGSL` 的 `applyLogDepth` 及 {@link LOG_DEPTH_WGSL} 共用。
 *
 * @param farZ - 远裁剪面（米），须 > 0
 * @returns 写入 `CameraUniforms.logDepthBufFC` 的标量
 */
export function computeLogDepthBufFC(farZ: number): number {
    if (farZ <= 0) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) { devWarn('computeLogDepthBufFC: farZ must be > 0, got', farZ); }
        return 1.0 / Math.log2(2.0);
    }
    return 1.0 / Math.log2(farZ + 1.0);
}
