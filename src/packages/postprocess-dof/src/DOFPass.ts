// ============================================================
// DOFPass.ts — 景深模糊后处理（占位）
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/**
 * 散景形状。
 */
export type BokehShape = 'circle' | 'hexagon';

/**
 * 景深 Pass 选项。
 */
export interface DOFPassOptions {
  /** 对焦距离（场景单位） */
  readonly focusDistance?: number;
  /** 光圈（越大越浅景深） */
  readonly aperture?: number;
  /** 最大模糊半径（像素） */
  readonly maxBlur?: number;
  readonly bokehShape?: BokehShape;
}

/**
 * 景深 Pass 实例。
 *
 * @stability experimental
 */
export interface DOFPass {
  encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void;
  setFocusDistance(d: number): void;
  setAperture(a: number): void;
}

/**
 * 创建景深 Pass。
 *
 * @param options - 景深参数
 * @returns Pass 实例
 *
 * @stability experimental
 */
export function createDOFPass(options: DOFPassOptions = {}): DOFPass {
  let focusDistance = options.focusDistance ?? 50;
  let aperture = options.aperture ?? 2.4;
  let maxBlur = options.maxBlur ?? 12;
  const bokehShape: BokehShape = options.bokehShape ?? 'circle';

  return {
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (!Number.isFinite(focusDistance) || focusDistance <= 0) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'DOF focusDistance must be positive finite', {
          focusDistance,
        });
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[DOFPass] encode stub', { focusDistance, aperture, maxBlur, bokehShape });
      }
    },
    setFocusDistance(d: number): void {
      if (!Number.isFinite(d) || d <= 0) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'setFocusDistance requires positive finite', { d });
      }
      focusDistance = d;
    },
    setAperture(a: number): void {
      if (!Number.isFinite(a) || a < 0) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'setAperture requires non-negative value', {
          a,
        });
      }
      aperture = a;
    },
  };
}

declare const __DEV__: boolean;
