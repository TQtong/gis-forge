// ============================================================
// FogPass.ts — 大气雾效后处理 Pass（占位编码，接 FrameGraph）
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/**
 * 雾类型。
 */
export type FogType = 'linear' | 'exponential';

/**
 * 雾 Pass 选项。
 */
export interface FogPassOptions {
  /** RGBA，分量 0–1 */
  readonly color?: readonly [number, number, number, number];
  /** 密度 [0,1] */
  readonly density?: number;
  /** 近端（与相机空间一致，由上层解释） */
  readonly start?: number;
  /** 远端 */
  readonly end?: number;
  readonly type?: FogType;
}

/**
 * 雾 Pass 实例。
 *
 * @stability experimental
 */
export interface FogPass {
  encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void;
  setDensity(d: number): void;
  setColor(c: readonly [number, number, number, number]): void;
  setRange(start: number, end: number): void;
}

/**
 * 创建雾 Pass。
 *
 * @param options - 雾参数
 * @returns Pass 实例
 *
 * @stability experimental
 */
export function createFogPass(options: FogPassOptions = {}): FogPass {
  let color = options.color ?? ([0.75, 0.8, 0.9, 1] as const);
  let density = options.density ?? 0.35;
  let start = options.start ?? 1;
  let end = options.end ?? 8000;
  const fogType: FogType = options.type ?? 'linear';

  function clamp01(x: number): number {
    if (!Number.isFinite(x)) {
      return 0;
    }
    return Math.max(0, Math.min(1, x));
  }

  return {
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[FogPass] skip encode — invalid depth range', { start, end });
        }
        return;
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[FogPass] encode stub', { density, fogType, start, end, color });
      }
    },
    setDensity(d: number): void {
      if (!Number.isFinite(d)) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Fog density must be finite', { d });
      }
      density = clamp01(d);
    },
    setColor(c: readonly [number, number, number, number]): void {
      if (c.length < 4) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Fog color needs 4 components', {});
      }
      color = [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])];
    },
    setRange(near: number, far: number): void {
      if (!Number.isFinite(near) || !Number.isFinite(far) || far <= near) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Fog setRange requires near < far', { near, far });
      }
      start = near;
      end = far;
    },
  };
}

declare const __DEV__: boolean;
