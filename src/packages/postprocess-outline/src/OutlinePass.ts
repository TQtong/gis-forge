// ============================================================
// OutlinePass.ts — Sobel 边缘检测轮廓后处理（占位）
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/**
 * 轮廓 Pass 选项。
 */
export interface OutlinePassOptions {
  /** RGBA 0–1 */
  readonly color?: readonly [number, number, number, number];
  /** 线宽 1–5 px */
  readonly width?: number;
  /** 边缘阈值 0–1 */
  readonly threshold?: number;
  /** 仅选中要素 */
  readonly selectedOnly?: boolean;
}

/**
 * 轮廓 Pass 实例。
 *
 * @stability experimental
 */
export interface OutlinePass {
  encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void;
  setColor(c: readonly [number, number, number, number]): void;
  setWidth(px: number): void;
}

/**
 * 创建轮廓 Pass。
 *
 * @param options - 轮廓样式
 * @returns Pass 实例
 *
 * @stability experimental
 */
export function createOutlinePass(options: OutlinePassOptions = {}): OutlinePass {
  let color = options.color ?? ([0, 0, 0, 1] as const);
  let width = options.width ?? 2;
  let threshold = options.threshold ?? 0.35;
  const selectedOnly = options.selectedOnly ?? false;

  function clamp01(x: number): number {
    if (!Number.isFinite(x)) {
      return 0;
    }
    return Math.max(0, Math.min(1, x));
  }

  return {
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Outline threshold must be in [0,1]', {
          threshold,
        });
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[OutlinePass] encode stub (Sobel)', { width, threshold, selectedOnly, color });
      }
    },
    setColor(c: readonly [number, number, number, number]): void {
      if (c.length < 4) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Outline color needs 4 components', {});
      }
      color = [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])];
    },
    setWidth(px: number): void {
      if (!Number.isFinite(px) || px < 1 || px > 5) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Outline width must be 1..5 px', { px });
      }
      width = Math.floor(px);
    },
  };
}

declare const __DEV__: boolean;
