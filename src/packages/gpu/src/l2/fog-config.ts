// ============================================================
// l2/fog-config.ts — 2.5D 距离雾配置（Canvas 2D 叠加 + WGSL 片段）
// 层级：L2
// 职责：与 GeoForge_25D_Viewport_Fill_Fix 层 5 对齐；与 SkyConfig.fogColor 同步检查。
// ============================================================

import type { SkyConfig } from './sky-renderer.ts';
import { hexToRGBA } from './sky-renderer.ts';

/**
 * 雾效配置（与 GPU 侧 FogUniforms 对应）。
 *
 * @stability experimental
 */
export interface FogConfig {
  /** 是否启用雾叠加 */
  enabled: boolean;
  /** 雾颜色（CSS 十六进制）；应与 `SkyConfig.fogColor` 一致 */
  fogColor: string;
  /** 归一化深度起点（0~1），约等于视口深度比例 @default 0.5 */
  fogStart: number;
  /** 归一化深度终点（0~1）@default 0.95 */
  fogEnd: number;
  /** 雾类型 */
  fogType: 'linear' | 'exponential' | 'exponential-squared';
  /** 指数雾密度 @default 2.0 */
  fogDensity: number;
}

/**
 * GPU 雾 Uniform（与 WGSL `FogUniforms` 对齐）。
 *
 * @stability experimental
 */
export interface FogUniforms {
  /** 雾颜色 RGBA 线性 0~1 */
  fogColor: [number, number, number, number];
  /** 雾开始距离（归一化） */
  fogStart: number;
  /** 雾结束距离（归一化） */
  fogEnd: number;
  /** 经 zoom 缩放后的密度 */
  fogDensity: number;
  /** 0=linear, 1=exp, 2=exp² */
  fogType: number;
}

/**
 * 雾管理器实例。
 *
 * @stability experimental
 */
export interface FogManager {
  setConfig(config: Partial<FogConfig>): void;
  getConfig(): FogConfig;
  computeUniforms(zoom: number): FogUniforms;
  applyToCanvas2D(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
    pitch: number,
  ): void;
  getWGSLSource(): string;
  shouldSync(skyConfig: SkyConfig): boolean;
}

const DEFAULT_FOG_COLOR = '#2a3a5a';
const DEFAULT_FOG_START = 0.5;
const DEFAULT_FOG_END = 0.95;
const DEFAULT_FOG_TYPE: FogConfig['fogType'] = 'exponential';
const DEFAULT_FOG_DENSITY = 2.0;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** zoom 自适应密度：density * clamp(1 - (zoom-5)/10, 0.1, 1.0) */
function computeZoomScaledFogDensityInternal(baseDensity: number, zoom: number): number {
  if (!Number.isFinite(baseDensity)) {
    return DEFAULT_FOG_DENSITY;
  }
  const z = Number.isFinite(zoom) ? zoom : 12;
  const scale = clamp01(1 - (z - 5) / 10);
  const scaled = Math.min(1, Math.max(0.1, scale));
  return baseDensity * scaled;
}

function fogTypeToIndex(t: FogConfig['fogType']): number {
  if (t === 'linear') return 0;
  if (t === 'exponential') return 1;
  return 2;
}

/**
 * 线性深度代理：Canvas 2D 无深度缓冲，用「从地平线到视口底」的归一化距离近似。
 *
 * @param yNorm - 当前归一化 Y（0=顶，1=底）
 * @param horizonY - 归一化地平线 Y
 */
function canvasDepthProxy(yNorm: number, horizonY: number): number {
  const y = clamp01(yNorm);
  const h = clamp01(horizonY);
  const denom = Math.max(1e-6, 1 - h);
  if (y <= h) {
    return 0;
  }
  return clamp01((y - h) / denom);
}

/**
 * 根据雾类型与归一化距离计算「保留原色」因子 fogFactor（0=全雾，1=原色）。
 */
function fogFactorForDepth(
  linearDepth: number,
  fogStart: number,
  fogEnd: number,
  density: number,
  fogType: FogConfig['fogType'],
): number {
  if (linearDepth < fogStart) {
    return 1;
  }
  const d = clamp01((linearDepth - fogStart) / Math.max(fogEnd - fogStart, 1e-6));
  switch (fogType) {
    case 'linear': {
      return clamp01(1 - d);
    }
    case 'exponential': {
      return clamp01(Math.exp(-density * d));
    }
    default: {
      const dd = density * d;
      return clamp01(Math.exp(-dd * dd));
    }
  }
}

function mergeFogConfig(base: FogConfig, partial?: Partial<FogConfig>): FogConfig {
  if (!partial) {
    return { ...base };
  }
  return {
    enabled: partial.enabled ?? base.enabled,
    fogColor: partial.fogColor ?? base.fogColor,
    fogStart: partial.fogStart !== undefined ? clamp01(partial.fogStart) : base.fogStart,
    fogEnd: partial.fogEnd !== undefined ? clamp01(partial.fogEnd) : base.fogEnd,
    fogType: partial.fogType ?? base.fogType,
    fogDensity:
      partial.fogDensity !== undefined && Number.isFinite(partial.fogDensity)
        ? partial.fogDensity
        : base.fogDensity,
  };
}

function normalizeHexForCompare(hex: string): string {
  return hex.trim().toLowerCase();
}

/**
 * 创建雾管理器（Canvas 2D 叠加 + WGSL 片段字符串）。
 *
 * @param options - 可选初始配置
 * @returns FogManager
 *
 * @stability experimental
 */
export function createFogManager(options?: { config?: Partial<FogConfig> }): FogManager {
  const defaultBase: FogConfig = {
    enabled: true,
    fogColor: DEFAULT_FOG_COLOR,
    fogStart: DEFAULT_FOG_START,
    fogEnd: DEFAULT_FOG_END,
    fogType: DEFAULT_FOG_TYPE,
    fogDensity: DEFAULT_FOG_DENSITY,
  };

  let config: FogConfig = mergeFogConfig(defaultBase, options?.config);
  /** 最近一次 `computeUniforms` 的 zoom（实例级，避免多实例共享模块状态） */
  let lastZoomForFog = 12;

  const manager: FogManager = {
    setConfig(partial: Partial<FogConfig>) {
      config = mergeFogConfig(config, partial);
    },

    getConfig(): FogConfig {
      return { ...config };
    },

    computeUniforms(zoom: number): FogUniforms {
      lastZoomForFog = Number.isFinite(zoom) ? zoom : lastZoomForFog;
      const density = computeZoomScaledFogDensityInternal(config.fogDensity, lastZoomForFog);
      const fc = hexToRGBA(config.fogColor);
      return {
        fogColor: fc,
        fogStart: config.fogStart,
        fogEnd: config.fogEnd,
        fogDensity: density,
        fogType: fogTypeToIndex(config.fogType),
      };
    },

    applyToCanvas2D(
      ctx: CanvasRenderingContext2D,
      width: number,
      height: number,
      horizonY: number,
      pitch: number,
    ): void {
      void pitch;
      if (!config.enabled) {
        return;
      }
      if (!ctx || width <= 0 || height <= 0) {
        if (__DEV__) {
          console.warn('[FogManager] applyToCanvas2D: invalid context or size');
        }
        return;
      }
      try {
        const u = manager.computeUniforms(lastZoomForFog);
        const h = clamp01(horizonY);
        const y0 = h * height;
        const grad = ctx.createLinearGradient(0, y0, 0, height);
        const stops = 24;
        const fc = u.fogColor;

        for (let i = 0; i <= stops; i++) {
          const t = i / stops;
          const yNorm = h + (1 - h) * t;
          const linearDepth = canvasDepthProxy(yNorm, h);
          const fogFactor = fogFactorForDepth(
            linearDepth,
            config.fogStart,
            config.fogEnd,
            u.fogDensity,
            config.fogType,
          );
          const overlayAlpha = clamp01(1 - fogFactor);
          grad.addColorStop(t, `rgba(${Math.round(fc[0] * 255)},${Math.round(fc[1] * 255)},${Math.round(fc[2] * 255)},${overlayAlpha * fc[3]})`);
        }

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = grad;
        ctx.fillRect(0, y0, width, height - y0);
        ctx.restore();
      } catch (e) {
        if (__DEV__) {
          console.warn('[FogManager] applyToCanvas2D failed', e);
        }
      }
    },

    getWGSLSource(): string {
      return FOG_WGSL_SNIPPET;
    },

    shouldSync(skyConfig: SkyConfig): boolean {
      return normalizeHexForCompare(config.fogColor) !== normalizeHexForCompare(skyConfig.fogColor);
    },
  };

  return manager;
}

const FOG_WGSL_SNIPPET = `struct FogUniforms {
  fogColor: vec4<f32>,
  fogStart: f32,
  fogEnd: f32,
  fogDensity: f32,
  fogType: u32,
};

fn applyFog(color: vec4<f32>, rawDepth: f32, fog: FogUniforms) -> vec4<f32> {
  let linearDepth = 1.0 - rawDepth;
  if (linearDepth < fog.fogStart) {
    return color;
  }
  var fogFactor: f32;
  let d = clamp((linearDepth - fog.fogStart) / max(fog.fogEnd - fog.fogStart, 1e-6), 0.0, 1.0);
  if (fog.fogType == 0u) {
    fogFactor = 1.0 - d;
  } else if (fog.fogType == 1u) {
    fogFactor = exp(-fog.fogDensity * d);
  } else {
    let dd = fog.fogDensity * d;
    fogFactor = exp(-dd * dd);
  }
  return vec4<f32>(mix(fog.fogColor.rgb, color.rgb, fogFactor), color.a);
}
`;

declare const __DEV__: boolean;
