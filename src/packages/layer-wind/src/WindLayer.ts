// ============================================================
// WindLayer.ts — 风场粒子轨迹图层（可选包 layer-wind）
// 职责：加载栅格风场（u/v）、粒子平流、越界重置；encode 为占位（GPU 管线待接）。
// 依赖：L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** 默认粒子数量 */
const DEFAULT_PARTICLE_COUNT = 5000;

/** 默认轨迹线宽（像素，逻辑单位） */
const DEFAULT_LINE_WIDTH = 1.5;

/** 默认粒子颜色渐变：低风速→高风速（RGBA 0–1） */
const DEFAULT_COLOR_RAMP: readonly [number, number, number, number][] = [
  [0.1, 0.2, 0.8, 0.35],
  [0.2, 0.9, 0.4, 0.85],
  [1.0, 0.85, 0.1, 1.0],
];

/**
 * 风场栅格（等间距经纬度格网），单位：u/v 为 m/s 或与数据一致。
 */
export interface WindFieldGrid {
  /** 列数（经度方向格点数） */
  readonly nx: number;
  /** 行数（纬度方向格点数） */
  readonly ny: number;
  /** 西边界（度） */
  readonly west: number;
  /** 南边界（度） */
  readonly south: number;
  /** 东边界（度） */
  readonly east: number;
  /** 北边界（度） */
  readonly north: number;
  /** 东西向风速分量，长度 nx*ny，行主序 [row][col] */
  readonly u: Float32Array;
  /** 南北向风速分量 */
  readonly v: Float32Array;
}

/**
 * {@link createWindLayer} 的配置项。
 */
export interface WindLayerOptions {
  /** 图层唯一 id */
  readonly id: string;
  /** 绑定的数据源 id（样式层 source 字段） */
  readonly source: string;
  /** 风场 JSON 的 URL（栅格 u/v + 边界） */
  readonly url: string;
  /** 粒子数量，默认 5000 */
  readonly particleCount?: number;
  /** 轨迹拖尾透明度 [0,1]，越大越淡 */
  readonly fadeOpacity?: number;
  /** 速度缩放因子（时间步长乘子） */
  readonly speedFactor?: number;
  /** 颜色渐变（至少 2 个色标） */
  readonly colorRamp?: readonly (readonly [number, number, number, number])[];
  /** 粒子轨迹线宽（像素） */
  readonly lineWidth?: number;
  /** 初始 zIndex */
  readonly zIndex?: number;
  /** 投影 id；默认 mercator */
  readonly projection?: string;
}

/**
 * 风场图层实例（对外能力）。
 *
 * @stability experimental
 */
export interface WindLayer extends Layer {
  /** 替换风场数据（运行时热更新） */
  setWindData(grid: WindFieldGrid): void;
  /** 获取粒子当前位置（lon/lat 交错，长度 particleCount*2） */
  getParticlePositions(): Float32Array;
}

/**
 * 校验并规范化风场栅格。
 */
function validateGrid(grid: WindFieldGrid): void {
  if (grid.nx < 2 || grid.ny < 2) {
    throw new GeoForgeError(
      GeoForgeErrorCode.TILE_DECODE_FAILED,
      'Wind grid nx/ny must be >= 2',
      { nx: grid.nx, ny: grid.ny },
    );
  }
  if (grid.west >= grid.east || grid.south >= grid.north) {
    throw new GeoForgeError(
      GeoForgeErrorCode.TILE_DECODE_FAILED,
      'Wind grid bounds are invalid',
      { west: grid.west, south: grid.south, east: grid.east, north: grid.north },
    );
  }
  const expected = grid.nx * grid.ny;
  if (grid.u.length !== expected || grid.v.length !== expected) {
    throw new GeoForgeError(
      GeoForgeErrorCode.TILE_DECODE_FAILED,
      'Wind grid u/v length mismatch',
      { expected, uLen: grid.u.length, vLen: grid.v.length },
    );
  }
}

/**
 * 双线性采样 u/v。
 */
function sampleWind(
  grid: WindFieldGrid,
  lon: number,
  lat: number,
  out: { u: number; v: number },
): void {
  const { west, south, east, north, nx, ny, u, v } = grid;
  const fx = ((lon - west) / (east - west)) * (nx - 1);
  const fy = ((lat - south) / (north - south)) * (ny - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = y0 * nx + x0;
  const i10 = y0 * nx + x1;
  const i01 = y1 * nx + x0;
  const i11 = y1 * nx + x1;
  const u00 = u[i00];
  const u10 = u[i10];
  const u01 = u[i01];
  const u11 = u[i11];
  const v00 = v[i00];
  const v10 = v[i10];
  const v01 = v[i01];
  const v11 = v[i11];
  out.u = u00 * (1 - tx) * (1 - ty) + u10 * tx * (1 - ty) + u01 * (1 - tx) * ty + u11 * tx * ty;
  out.v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/**
 * 从 JSON 加载风场（网络失败时由调用方决定是否抛错）。
 */
async function loadWindGridFromUrl(url: string, signal: AbortSignal): Promise<WindFieldGrid> {
  let res: Response;
  try {
    res = await fetch(url, { signal, mode: 'cors' });
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'Wind JSON fetch failed', { url }, cause);
  }
  if (!res.ok) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, `Wind HTTP ${res.status}`, { url, status: res.status });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Wind JSON parse failed', { url }, cause);
  }
  if (typeof json !== 'object' || json === null) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Wind JSON must be object', { url });
  }
  const o = json as Record<string, unknown>;
  const nx = Number(o['nx'] ?? o['width']);
  const ny = Number(o['ny'] ?? o['height']);
  const west = Number(o['west']);
  const south = Number(o['south']);
  const east = Number(o['east']);
  const north = Number(o['north']);
  const uArr = o['u'];
  const vArr = o['v'];
  if (!Array.isArray(uArr) || !Array.isArray(vArr)) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Wind JSON requires u/v arrays', { url });
  }
  const u = new Float32Array(uArr.length);
  const v = new Float32Array(vArr.length);
  for (let i = 0; i < u.length; i++) {
    u[i] = Number(uArr[i]);
    v[i] = Number(vArr[i]);
  }
  const grid: WindFieldGrid = { nx, ny, west, south, east, north, u, v };
  validateGrid(grid);
  return grid;
}

/**
 * 创建风场粒子图层。
 *
 * @param options - 图层与风场参数
 * @returns 实现 {@link Layer} 的风场图层实例
 *
 * @stability experimental
 */
export function createWindLayer(options: WindLayerOptions): WindLayer {
  if (!options.id || !options.url || !options.source) {
    throw new GeoForgeError(
      GeoForgeErrorCode.INVALID_LAYER_SPEC,
      'WindLayer requires id, url, source',
      { layerId: options?.id },
    );
  }
  const particleCount = Math.max(1, Math.floor(options.particleCount ?? DEFAULT_PARTICLE_COUNT));
  const fadeOpacity = options.fadeOpacity ?? 0.25;
  if (fadeOpacity < 0 || fadeOpacity > 1 || Number.isNaN(fadeOpacity)) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'fadeOpacity must be in [0,1]', {
      fadeOpacity,
    });
  }
  const speedFactor = Number.isFinite(options.speedFactor) ? (options.speedFactor as number) : 1;
  const colorRamp = options.colorRamp ?? DEFAULT_COLOR_RAMP;
  if (colorRamp.length < 2) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'colorRamp needs at least 2 stops', {});
  }
  const lineWidth = options.lineWidth ?? DEFAULT_LINE_WIDTH;
  const projection = options.projection ?? 'mercator';

  let grid: WindFieldGrid | null = null;
  const particles = new Float32Array(particleCount * 2);
  const tmpVel = { u: 0, v: 0 };
  let abortController: AbortController | null = null;
  let loaded = false;

  function resetParticlesInBounds(): void {
    if (!grid) {
      return;
    }
    const { west, south, east, north } = grid;
    for (let i = 0; i < particleCount; i++) {
      particles[i * 2] = west + Math.random() * (east - west);
      particles[i * 2 + 1] = south + Math.random() * (north - south);
    }
  }

  function stepParticles(dt: number): void {
    if (!grid) {
      return;
    }
    const { west, south, east, north } = grid;
    for (let i = 0; i < particleCount; i++) {
      const lon = particles[i * 2];
      const lat = particles[i * 2 + 1];
      sampleWind(grid, lon, lat, tmpVel);
      const dLon = (tmpVel.u * speedFactor * dt) / (111320 * Math.cos((lat * Math.PI) / 180));
      const dLat = (tmpVel.v * speedFactor * dt) / 110540;
      let nLon = lon + dLon;
      let nLat = lat + dLat;
      if (nLon < west || nLon > east || nLat < south || nLat > north || Number.isNaN(nLon) || Number.isNaN(nLat)) {
        nLon = west + Math.random() * (east - west);
        nLat = south + Math.random() * (north - south);
      }
      particles[i * 2] = nLon;
      particles[i * 2 + 1] = nLat;
    }
  }

  const layer: WindLayer = {
    id: options.id,
    type: 'wind',
    source: options.source,
    projection,
    visible: true,
    opacity: 1,
    zIndex: options.zIndex ?? 0,
    isLoaded: false,
    isTransparent: true,
    renderOrder: options.zIndex ?? 0,

    onAdd(): void {
      abortController = new AbortController();
      loadWindGridFromUrl(options.url, abortController.signal)
        .then((g) => {
          grid = g;
          loaded = true;
          (layer as { isLoaded: boolean }).isLoaded = true;
          resetParticlesInBounds();
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.debug('[WindLayer] wind grid loaded', { nx: g.nx, ny: g.ny });
          }
        })
        .catch((e) => {
          loaded = false;
          (layer as { isLoaded: boolean }).isLoaded = false;
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.warn('[WindLayer] wind load failed', e);
          }
        });
    },

    onRemove(): void {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      grid = null;
      loaded = false;
      (layer as { isLoaded: boolean }).isLoaded = false;
    },

    onUpdate(deltaTime: number, _camera: CameraState): void {
      if (!loaded || !grid) {
        return;
      }
      const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 1 / 60;
      stepParticles(dt);
    },

    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (!loaded) {
        return;
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[WindLayer] encode stub — GPU particle pass not wired');
      }
    },

    setPaintProperty(_name: string, _value: unknown): void {
      /* 样式由专用管线处理；此处保留占位 */
    },
    setLayoutProperty(_name: string, _value: unknown): void {},
    getPaintProperty(_name: string): unknown {
      return undefined;
    },
    getLayoutProperty(_name: string): unknown {
      return undefined;
    },

    setWindData(g: WindFieldGrid): void {
      try {
        validateGrid(g);
        grid = g;
        loaded = true;
        (layer as { isLoaded: boolean }).isLoaded = true;
        resetParticlesInBounds();
      } catch (e) {
        if (e instanceof GeoForgeError) {
          throw e;
        }
        const cause = e instanceof Error ? e : new Error(String(e));
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'setWindData validation failed', { layerId: options.id }, cause);
      }
    },

    getParticlePositions(): Float32Array {
      return particles;
    },

    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },
  };

  return layer;
}

declare const __DEV__: boolean;
