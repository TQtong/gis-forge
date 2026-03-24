// ============================================================
// l2/sky-renderer.ts — 2.5D 天空全屏渐变（Canvas 2D 回退 + WGSL 源）
// 层级：L2
// 职责：与 GeoForge_25D_Viewport_Fill_Fix 层 4 对齐；GPU 路径预留 encode/getWGSLSource。
// ============================================================

import SKY_WGSL_SOURCE from '../wgsl/sky.wgsl?raw';

/**
 * 天空渲染配置（与 MapLibre sky 规范对齐的简化子集）。
 *
 * @stability experimental
 */
export interface SkyConfig {
  /** 是否启用天空渲染；2.5D 模式下由宿主开启 @default true */
  enabled: boolean;
  /** 视口顶部颜色（CSS 十六进制，如 `#0a0f1e`） */
  skyColor: string;
  /** 地平线过渡色 */
  horizonColor: string;
  /** 远处地面雾色（应与 FogConfig.fogColor 一致以避免接缝） */
  fogColor: string;
  /** 天空→地平线渐变宽度，归一化视口高度 [0,1]；0=硬边，1=整屏渐变 @default 0.4 */
  skyHorizonBlend: number;
  /** 地平线→雾渐变宽度 [0,1] @default 0.3 */
  horizonFogBlend: number;
  /** 雾→透明（地图层）渐变宽度 [0,1] @default 0.5 */
  fogGroundBlend: number;
}

/**
 * GPU 侧天空 Uniform（与 sky.wgsl 中 `SkyUniforms` 布局一致）。
 *
 * @stability experimental
 */
export interface SkyUniforms {
  /** 天空颜色 RGBA，线性空间 0~1；已乘 skyAlpha */
  skyColor: [number, number, number, number];
  /** 地平线颜色 RGBA */
  horizonColor: [number, number, number, number];
  /** 雾颜色 RGBA */
  fogColor: [number, number, number, number];
  /** 地平线归一化 Y（0=顶，1=底），与片元 UV.y 一致 */
  horizonY: number;
  /** 拷贝自配置，便于与 WGSL 一致 */
  skyHorizonBlend: number;
  horizonFogBlend: number;
  fogGroundBlend: number;
}

/**
 * 天空渲染器实例 API。
 *
 * @stability experimental
 */
export interface SkyRenderer {
  /**
   * 合并更新配置（浅合并到当前配置）。
   *
   * @param config - 部分配置
   */
  setConfig(config: Partial<SkyConfig>): void;

  /**
   * @returns 当前完整配置快照
   */
  getConfig(): SkyConfig;

  /**
   * 计算当前帧 Uniform（含 pitch 淡入：smoothstep 0°~10°）。
   *
   * @param horizonY - 归一化地平线 Y（0~1）
   * @param pitch - 俯仰角（弧度，0=正俯视）
   */
  computeUniforms(horizonY: number, pitch: number): SkyUniforms;

  /**
   * 预留：未来在 RenderGraph 中编码 Sky Pass。
   *
   * @param pass - GPU 渲染通道（未接线时为 `any`）
   */
  encode(pass: unknown): void;

  /**
   * Canvas 2D 回退：在瓦片之前绘制全屏天空渐变。
   *
   * @param ctx - 2D 上下文
   * @param width - CSS 像素宽度
   * @param height - CSS 像素高度
   * @param horizonY - 归一化地平线 Y（0~1）
   * @param pitch - 俯仰角（弧度）
   */
  renderToCanvas2D(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
    pitch: number,
  ): void;

  /**
   * @returns 与 `computeUniforms` 一致的 WGSL 源码（全屏三角 + 片元渐变）
   */
  getWGSLSource(): string;
}

/** 默认透视 FOV（弧度），用于地平线归一化 Y 的近似；与 60° 竖直视锥常见设定一致 */
const DEFAULT_FOV_RAD = Math.PI / 3;

/** 俯仰淡入上沿（弧度）：10° */
const SKY_PITCH_FADE_END_RAD = (10 * Math.PI) / 180;

/** 默认天空渐变 blend 宽度 */
const DEFAULT_SKY_HORIZON_BLEND = 0.4;
const DEFAULT_HORIZON_FOG_BLEND = 0.3;
const DEFAULT_FOG_GROUND_BLEND = 0.5;

/**
 * 主题配色预设（仅颜色三元组；可与 `createSkyRenderer` 合并）。
 *
 * @stability experimental
 */
export const SKY_PRESETS = {
  /** 深色 UI 默认 */
  darkStandard: {
    skyColor: '#0a0f1e',
    horizonColor: '#1a2a4a',
    fogColor: '#2a3a5a',
  },
  /** 浅色 / 日间 */
  lightStandard: {
    skyColor: '#87CEEB',
    horizonColor: '#B0C4DE',
    fogColor: '#D3D3D3',
  },
  /** 卫星底图 */
  satellite: {
    skyColor: '#000510',
    horizonColor: '#0a1528',
    fogColor: '#152238',
  },
  /** 暮光 */
  twilight: {
    skyColor: '#1a0a2e',
    horizonColor: '#4a2060',
    fogColor: '#6a3080',
  },
} as const;

/**
 * Hermite 平滑插值；WGSL `smoothstep` 等价。
 *
 * @param edge0 - 下界
 * @param edge1 - 上界
 * @param x - 输入
 * @returns 0~1 平滑因子
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(edge0) || !Number.isFinite(edge1) || !Number.isFinite(x)) {
    return 0;
  }
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 将 `#RRGGBB` / `#RGB` 解析为线性 0~1 RGBA（alpha 恒为 1）。
 *
 * @param hex - CSS 颜色字符串
 * @returns RGBA 元组
 */
export function hexToRGBA(hex: string): [number, number, number, number] {
  const fallback: [number, number, number, number] = [0, 0, 0, 1];
  if (typeof hex !== 'string' || hex.length < 4) {
    if (__DEV__) {
      console.warn('[SkyRenderer] hexToRGBA: invalid hex string, using black');
    }
    return fallback;
  }
  const raw = hex.trim();
  if (!raw.startsWith('#')) {
    if (__DEV__) {
      console.warn('[SkyRenderer] hexToRGBA: expected # prefix');
    }
    return fallback;
  }
  const body = raw.slice(1);
  let r = 0;
  let g = 0;
  let b = 0;
  try {
    if (body.length === 3) {
      r = parseInt(body[0] + body[0], 16);
      g = parseInt(body[1] + body[1], 16);
      b = parseInt(body[2] + body[2], 16);
    } else if (body.length === 6) {
      r = parseInt(body.slice(0, 2), 16);
      g = parseInt(body.slice(2, 4), 16);
      b = parseInt(body.slice(4, 6), 16);
    } else {
      if (__DEV__) {
        console.warn('[SkyRenderer] hexToRGBA: unsupported length');
      }
      return fallback;
    }
  } catch {
    if (__DEV__) {
      console.warn('[SkyRenderer] hexToRGBA: parse failed');
    }
    return fallback;
  }
  if (![r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) {
    return fallback;
  }
  return [r / 255, g / 255, b / 255, 1];
}

/**
 * 按文档「视口地平线」公式计算归一化 Y（0=顶，1=底）。
 *
 * @param pitchRad - 俯仰（弧度），视线向上为正
 * @param fovRad - 垂直 FOV（弧度），默认 60°
 * @returns 0~1 钳制后的地平线位置
 *
 * @stability experimental
 */
export function computeHorizonYNormalized(pitchRad: number, fovRad: number = DEFAULT_FOV_RAD): number {
  if (!Number.isFinite(pitchRad) || pitchRad <= 0) {
    return 0;
  }
  if (!Number.isFinite(fovRad) || fovRad <= 0) {
    return 0;
  }
  const halfFov = fovRad * 0.5;
  const horizonAngle = Math.PI / 2 - pitchRad;
  if (horizonAngle >= halfFov) {
    return 0;
  }
  if (horizonAngle <= -halfFov) {
    return 1;
  }
  const y = 0.5 - (Math.tan(horizonAngle) / Math.tan(halfFov)) * 0.5;
  if (!Number.isFinite(y)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, y));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function mulRGBA(
  c: [number, number, number, number],
  s: number,
): [number, number, number, number] {
  const k = clamp01(s);
  return [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
}

function rgbaToCss(c: [number, number, number, number]): string {
  const r = Math.round(clamp01(c[0]) * 255);
  const g = Math.round(clamp01(c[1]) * 255);
  const b = Math.round(clamp01(c[2]) * 255);
  const a = clamp01(c[3]);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * 与 WGSL `fs` 分支一致的颜色采样（y 为归一化 0~1，0=顶）。
 */
function sampleSkyColorAtY(
  y: number,
  h: number,
  skyBlend: number,
  horizonFogBlend: number,
  fogGroundBlend: number,
  sky: [number, number, number, number],
  horizon: [number, number, number, number],
  fog: [number, number, number, number],
): [number, number, number, number] {
  const hh = clamp01(h);
  const yy = clamp01(y);
  if (yy < hh) {
    const skyStart = hh - skyBlend;
    const t = smoothstep(skyStart, hh, yy);
    return lerpRGBA(sky, horizon, t);
  }
  const fogStart = Math.min(1, hh + horizonFogBlend);
  if (yy < fogStart) {
    const t = smoothstep(hh, fogStart, yy);
    return lerpRGBA(horizon, fog, t);
  }
  const groundStart = Math.min(1, fogStart + fogGroundBlend);
  const t = smoothstep(fogStart, groundStart, yy);
  return lerpRGBA(fog, [0, 0, 0, 0], t);
}

function lerpRGBA(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const u = clamp01(t);
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
    a[3] + (b[3] - a[3]) * u,
  ];
}

function mergeSkyConfig(base: SkyConfig, partial?: Partial<SkyConfig>): SkyConfig {
  if (!partial) {
    return { ...base };
  }
  return {
    enabled: partial.enabled ?? base.enabled,
    skyColor: partial.skyColor ?? base.skyColor,
    horizonColor: partial.horizonColor ?? base.horizonColor,
    fogColor: partial.fogColor ?? base.fogColor,
    skyHorizonBlend:
      partial.skyHorizonBlend !== undefined
        ? clamp01(partial.skyHorizonBlend)
        : base.skyHorizonBlend,
    horizonFogBlend:
      partial.horizonFogBlend !== undefined
        ? clamp01(partial.horizonFogBlend)
        : base.horizonFogBlend,
    fogGroundBlend:
      partial.fogGroundBlend !== undefined
        ? clamp01(partial.fogGroundBlend)
        : base.fogGroundBlend,
  };
}

function computeSkyAlpha(pitch: number): number {
  if (!Number.isFinite(pitch)) {
    return 0;
  }
  return smoothstep(0, SKY_PITCH_FADE_END_RAD, Math.max(0, pitch));
}

/**
 * 由当前配置与相机参数计算 Uniform（供 `computeUniforms` 与 Canvas 共用）。
 */
function buildSkyUniforms(config: SkyConfig, horizonY: number, pitch: number): SkyUniforms {
  const h = clamp01(Number.isFinite(horizonY) ? horizonY : 0);
  const skyAlpha = computeSkyAlpha(pitch);
  const skyC = mulRGBA(hexToRGBA(config.skyColor), skyAlpha);
  const horC = mulRGBA(hexToRGBA(config.horizonColor), skyAlpha);
  const fogC = mulRGBA(hexToRGBA(config.fogColor), skyAlpha);
  return {
    skyColor: skyC,
    horizonColor: horC,
    fogColor: fogC,
    horizonY: h,
    skyHorizonBlend: config.skyHorizonBlend,
    horizonFogBlend: config.horizonFogBlend,
    fogGroundBlend: config.fogGroundBlend,
  };
}

/**
 * 创建天空渲染器（含 Canvas 2D 回退与 WGSL 源码）。
 *
 * @param options - 可选初始配置与预设
 * @returns SkyRenderer 实例
 *
 * @stability experimental
 */
export function createSkyRenderer(options?: {
  /** 初始配置覆盖 */
  config?: Partial<SkyConfig>;
  /** 从 `SKY_PRESETS` 选色 */
  preset?: keyof typeof SKY_PRESETS;
}): SkyRenderer {
  const presetColors = options?.preset
    ? SKY_PRESETS[options.preset]
    : SKY_PRESETS.darkStandard;

  const defaultBase: SkyConfig = {
    enabled: true,
    skyColor: presetColors.skyColor,
    horizonColor: presetColors.horizonColor,
    fogColor: presetColors.fogColor,
    skyHorizonBlend: DEFAULT_SKY_HORIZON_BLEND,
    horizonFogBlend: DEFAULT_HORIZON_FOG_BLEND,
    fogGroundBlend: DEFAULT_FOG_GROUND_BLEND,
  };

  let config: SkyConfig = mergeSkyConfig(defaultBase, options?.config);

  const sky: SkyRenderer = {
    setConfig(partial: Partial<SkyConfig>) {
      config = mergeSkyConfig(config, partial);
    },

    getConfig(): SkyConfig {
      return { ...config };
    },

    computeUniforms(horizonY: number, pitch: number): SkyUniforms {
      return buildSkyUniforms(config, horizonY, pitch);
    },

    encode(pass: unknown): void {
      if (!config.enabled) {
        return;
      }
      try {
        if (__DEV__) {
          console.debug('[SkyRenderer] encode: GPU path not wired', { pass });
        }
      } catch (e) {
        if (__DEV__) {
          console.warn('[SkyRenderer] encode failed', e);
        }
      }
    },

    renderToCanvas2D(
      ctx: CanvasRenderingContext2D,
      width: number,
      height: number,
      horizonY: number,
      pitch: number,
    ): void {
      if (!config.enabled) {
        return;
      }
      if (!ctx || width <= 0 || height <= 0) {
        if (__DEV__) {
          console.warn('[SkyRenderer] renderToCanvas2D: invalid context or size');
        }
        return;
      }
      try {
        const u = buildSkyUniforms(config, horizonY, pitch);
        const skyRgb = hexToRGBA(config.skyColor);
        const horRgb = hexToRGBA(config.horizonColor);
        const fogRgb = hexToRGBA(config.fogColor);
        const skyAlpha = computeSkyAlpha(pitch);
        const skyA = mulRGBA(skyRgb, skyAlpha);
        const horA = mulRGBA(horRgb, skyAlpha);
        const fogA = mulRGBA(fogRgb, skyAlpha);

        const h = u.horizonY;
        const sb = u.skyHorizonBlend;
        const hf = u.horizonFogBlend;
        const fg = u.fogGroundBlend;

        const grad = ctx.createLinearGradient(0, 0, 0, height);
        const stops = 32;
        for (let i = 0; i <= stops; i++) {
          const yn = i / stops;
          const c = sampleSkyColorAtY(yn, h, sb, hf, fg, skyA, horA, fogA);
          grad.addColorStop(yn, rgbaToCss(c));
        }

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      } catch (e) {
        if (__DEV__) {
          console.warn('[SkyRenderer] renderToCanvas2D failed', e);
        }
      }
    },

    getWGSLSource(): string {
      return SKY_WGSL_SOURCE;
    },
  };

  return sky;
}

declare const __DEV__: boolean;
