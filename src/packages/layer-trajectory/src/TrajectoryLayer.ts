// ============================================================
// TrajectoryLayer.ts — GPS 轨迹时间轴动画图层（可选包 layer-trajectory）
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { LineStringGeometry } from '../../core/src/types/geometry.ts';
import type { FeatureCollection, Feature } from '../../core/src/types/feature.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** 默认线宽 */
const DEFAULT_WIDTH = 4;

/** 默认尾迹长度（秒） */
const DEFAULT_TRAIL_SECONDS = 120;

/**
 * 轨迹图层选项。
 */
export interface TrajectoryLayerOptions {
  /** 图层 id */
  readonly id: string;
  /** 数据源 id */
  readonly source: string;
  /** GeoJSON：含 LineString 的 Feature 或 FeatureCollection */
  readonly data: FeatureCollection<LineStringGeometry> | Feature<LineStringGeometry>;
  /** 播放速度倍率（1=实时） */
  readonly speed?: number;
  /** 尾迹覆盖的时间长度（秒） */
  readonly trailLength?: number;
  /** RGBA 0–1 */
  readonly color?: readonly [number, number, number, number];
  /** 线宽（像素） */
  readonly width?: number;
  /** 时间戳数组（与折线顶点一一对应，Unix 秒）；也可放在 properties['times'] */
  readonly timestamps?: readonly number[];
  readonly zIndex?: number;
  readonly projection?: string;
}

/**
 * 轨迹图层实例。
 *
 * @stability experimental
 */
export interface TrajectoryLayer extends Layer {
  /** 开始或继续播放 */
  play(): void;
  /** 暂停 */
  pause(): void;
  /** 设置当前时间（Unix 秒） */
  setTime(t: number): void;
  /** 当前时间 */
  getTime(): number;
}

/**
 * 解析输入为 LineString + 时间数组。
 */
function extractLineAndTimes(
  data: TrajectoryLayerOptions['data'],
  explicitTimes: readonly number[] | undefined,
): { line: LineStringGeometry; times: number[] } {
  let feature: Feature<LineStringGeometry> | null = null;
  if (data.type === 'FeatureCollection') {
    const f = data.features.find((x) => x.geometry?.type === 'LineString');
    if (!f || f.geometry.type !== 'LineString') {
      throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'Trajectory data needs a LineString feature', {});
    }
    feature = f as Feature<LineStringGeometry>;
  } else if (data.type === 'Feature' && data.geometry.type === 'LineString') {
    feature = data;
  }
  if (!feature) {
    throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'Trajectory data must be Feature(LineString) or FeatureCollection', {});
  }
  const line = feature.geometry;
  if (line.coordinates.length < 2) {
    throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'LineString needs at least 2 positions', {});
  }
  let times: number[] | null = null;
  if (explicitTimes && explicitTimes.length >= line.coordinates.length) {
    times = explicitTimes.slice(0, line.coordinates.length).map((t) => Number(t));
  } else {
    const props = feature.properties as Record<string, unknown> | undefined;
    const raw = props?.['times'] ?? props?.['timestamp'];
    if (Array.isArray(raw) && raw.length >= line.coordinates.length) {
      times = raw.slice(0, line.coordinates.length).map((t) => Number(t));
    }
  }
  if (!times || times.some((t) => !Number.isFinite(t))) {
    throw new GeoForgeError(
      GeoForgeErrorCode.GEOJSON_PARSE_FAILED,
      'Trajectory requires timestamps[] matching vertices (options.timestamps or properties.times)',
      { vertexCount: line.coordinates.length },
    );
  }
  return { line, times };
}

/**
 * 沿折线按时间插值位置；trailStart 为尾迹起点时间（当前时间向前 trailLengthSec）。
 */
function interpolateAlongLine(
  line: LineStringGeometry,
  times: readonly number[],
  t: number,
  trailLengthSec: number,
  out: { lon: number; lat: number; segmentIndex: number; trailStart: number },
): void {
  const coords = line.coordinates;
  if (t <= times[0]) {
    const c = coords[0];
    out.lon = c[0];
    out.lat = c[1];
    out.segmentIndex = 0;
    out.trailStart = Math.max(times[0], t - trailLengthSec);
    return;
  }
  if (t >= times[times.length - 1]) {
    const c = coords[coords.length - 1];
    out.lon = c[0];
    out.lat = c[1];
    out.segmentIndex = Math.max(0, coords.length - 2);
    out.trailStart = Math.max(times[0], t - trailLengthSec);
    return;
  }
  let i = 0;
  for (let k = 0; k < times.length - 1; k++) {
    if (t >= times[k] && t <= times[k + 1]) {
      i = k;
      break;
    }
  }
  const t0 = times[i];
  const t1 = times[i + 1];
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const c0 = coords[i];
  const c1 = coords[i + 1];
  out.lon = c0[0] + (c1[0] - c0[0]) * u;
  out.lat = c0[1] + (c1[1] - c0[1]) * u;
  out.segmentIndex = i;
  out.trailStart = Math.max(times[0], t - trailLengthSec);
}

/**
 * 创建轨迹动画图层。
 *
 * @param options - 轨迹与样式
 * @returns 图层实例
 *
 * @stability experimental
 */
export function createTrajectoryLayer(options: TrajectoryLayerOptions): TrajectoryLayer {
  if (!options.id || !options.source) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'TrajectoryLayer requires id and source', {});
  }
  const { line, times } = extractLineAndTimes(options.data, options.timestamps);
  const trailLength = options.trailLength ?? DEFAULT_TRAIL_SECONDS;
  const speed = Number.isFinite(options.speed) ? (options.speed as number) : 1;
  const color = options.color ?? ([0.2, 0.8, 1.0, 0.95] as const);
  const width = options.width ?? DEFAULT_WIDTH;
  const projection = options.projection ?? 'mercator';

  let currentTime = times[0];
  let playing = false;
  const trailEnd = times[times.length - 1];
  const pos = { lon: 0, lat: 0, segmentIndex: 0, trailStart: times[0] };

  function refreshPosition(): void {
    interpolateAlongLine(line, times, currentTime, trailLength, pos);
  }
  refreshPosition();

  const layer: TrajectoryLayer = {
    id: options.id,
    type: 'trajectory',
    source: options.source,
    projection,
    visible: true,
    opacity: 1,
    zIndex: options.zIndex ?? 0,
    isLoaded: true,
    isTransparent: true,
    renderOrder: options.zIndex ?? 0,

    onAdd(): void {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[TrajectoryLayer] onAdd', { id: options.id });
      }
    },

    onRemove(): void {
      playing = false;
    },

    onUpdate(deltaTime: number, _camera: CameraState): void {
      if (!playing) {
        return;
      }
      const dt = Number.isFinite(deltaTime) ? deltaTime : 1 / 60;
      currentTime += dt * speed;
      if (currentTime > trailEnd) {
        currentTime = times[0];
      }
      if (currentTime < times[0]) {
        currentTime = times[0];
      }
      refreshPosition();
    },

    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[TrajectoryLayer] encode stub', { lon: pos.lon, lat: pos.lat, width });
      }
    },

    setPaintProperty(_name: string, _value: unknown): void {},
    setLayoutProperty(_name: string, _value: unknown): void {},
    getPaintProperty(_name: string): unknown {
      if (_name === 'line-color') {
        return color;
      }
      return undefined;
    },
    getLayoutProperty(_name: string): unknown {
      if (_name === 'line-width') {
        return width;
      }
      return undefined;
    },

    play(): void {
      playing = true;
    },
    pause(): void {
      playing = false;
    },
    setTime(t: number): void {
      if (!Number.isFinite(t)) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'setTime requires finite number', { t });
      }
      currentTime = Math.min(trailEnd, Math.max(times[0], t));
      refreshPosition();
    },
    getTime(): number {
      return currentTime;
    },

    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },
  };

  return layer;
}

declare const __DEV__: boolean;
