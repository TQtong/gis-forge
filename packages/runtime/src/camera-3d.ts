// ============================================================
// L3/camera-3d.ts — Globe3D 相机：透视投影 + ECEF lookAt（MVP）
// 层级：L3
// 职责：Camera3D 接口、轨道相机（目标点 + 距离 + heading/pitch）、地形占位。
// ============================================================

import type { CameraAnimation, CameraConstraints, CameraController } from './camera-controller.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import { geodeticToECEF } from '../../core/src/geo/ellipsoid.ts';
import * as mat4 from '../../core/src/math/mat4.ts';

/** WGS84 长半轴（米） */
const WGS84_A = 6378137.0;

/** 默认 zoom 范围 */
const DEFAULT_MIN_ZOOM = 0;
const DEFAULT_MAX_ZOOM = 22;

/** 俯仰约束（弧度） */
const DEFAULT_MIN_PITCH = 0.02;
const DEFAULT_MAX_PITCH = Math.PI / 2 - 0.02;

/** 默认垂直 FOV（弧度） */
const DEFAULT_FOV = Math.PI / 4;

/** 地球周长（米） */
const EARTH_CIRCUMFERENCE_METERS = 40075017;

/** 瓦片边长（像素） */
const TILE_PIXEL_SIZE = 256;

/** 动画默认时长（毫秒） */
const DEFAULT_ANIM_MS = 1500;
const MIN_ANIM_MS = 16;

/** 视口最小边长 */
const MIN_VIEWPORT_DIM = 1;

/** 惯性阈值 */
const INERTIA_EPS = 1e-5;

/** 度→弧度 */
const DEG_TO_RAD = Math.PI / 180;

/**
 * 生成动画 ID。
 *
 * @returns 唯一字符串
 *
 * @example
 * makeId();
 */
function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* 受限环境 */
  }
  return `c3d-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 钳制到 [lo,hi]。
 *
 * @param v - 值
 * @param lo - 下界
 * @param hi - 上界
 * @returns 钳制结果
 *
 * @example
 * clamp(5, 0, 10);
 */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return 0;
  }
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.min(b, Math.max(a, v));
}

/**
 * 线性插值。
 *
 * @param a - 起点
 * @param b - 终点
 * @param t - 因子
 * @returns 结果
 *
 * @example
 * lerp(0, 10, 0.5);
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * smoothstep 缓动。
 *
 * @param t - [0,1]
 * @returns 缓动值
 *
 * @example
 * smoothstep(0.3);
 */
function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * zoom→海拔（米）。
 *
 * @param zoom - 连续 zoom
 * @returns 海拔
 *
 * @example
 * altFromZoom(8);
 */
function altFromZoom(zoom: number): number {
  const z = Math.pow(2, Math.max(0, zoom));
  // 与 2D 一致：C / (2^z * tilePx)
  return EARTH_CIRCUMFERENCE_METERS / (z * TILE_PIXEL_SIZE);
}

/**
 * 海拔→zoom。
 *
 * @param alt - 海拔（米）
 * @returns zoom
 *
 * @example
 * zoomFromAlt(1e6);
 */
function zoomFromAlt(alt: number): number {
  const a = Math.max(1, alt);
  return clamp(Math.log2(EARTH_CIRCUMFERENCE_METERS / (TILE_PIXEL_SIZE * a)), DEFAULT_MIN_ZOOM, DEFAULT_MAX_ZOOM);
}

/**
 * 经纬度钳制 / 经度回绕。
 *
 * @param lon - 经度（度）
 * @param lat - 纬度（度）
 * @param bounds - 可选 maxBounds
 * @returns [lon, lat]
 *
 * @example
 * clampLL(200, 0, undefined);
 */
function clampLL(lon: number, lat: number, bounds?: BBox2D): [number, number] {
  let x = lon;
  let y = lat;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return [0, 0];
  }
  while (x > 180) {
    x -= 360;
  }
  while (x < -180) {
    x += 360;
  }
  if (bounds && bounds.west <= bounds.east && bounds.south <= bounds.north) {
    x = clamp(x, bounds.west, bounds.east);
    y = clamp(y, bounds.south, bounds.north);
  } else {
    y = clamp(y, -85, 85);
  }
  return [x, y];
}

/**
 * Float64 ECEF → Float32。
 *
 * @param out - 输出
 * @param src - 输入
 *
 * @example
 * ecef64To32(p, e);
 */
function ecef64To32(out: Float32Array, src: Float64Array): void {
  out[0] = src[0];
  out[1] = src[1];
  out[2] = src[2];
}

/**
 * 归一化三维向量。
 *
 * @param o - 输出
 * @param v - 输入
 *
 * @example
 * norm3(o, v);
 */
function norm3(o: Float32Array, v: Float32Array): void {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-12) {
    o[0] = 0;
    o[1] = 0;
    o[2] = 1;
    return;
  }
  const il = 1 / l;
  o[0] = v[0] * il;
  o[1] = v[1] * il;
  o[2] = v[2] * il;
}

/** 工厂选项 */
export interface Camera3DOptions {
  /** 初始相机位置（度 / 米） */
  readonly position?: { lon: number; lat: number; alt: number };
  /** 初始方位（弧度） */
  readonly heading?: number;
  /** 初始俯仰（弧度） */
  readonly pitch?: number;
  /** 初始横滚（弧度） */
  readonly roll?: number;
  /** 最近距离（米） */
  readonly minimumZoomDistance?: number;
  /** 最远距离（米） */
  readonly maximumZoomDistance?: number;
  /** 地形碰撞 */
  readonly enableCollision?: boolean;
}

/** Camera3D 扩展接口 */
export interface Camera3D extends CameraController {
  readonly type: '3d';
  setPosition(lon: number, lat: number, alt: number): void;
  getPosition(): { lon: number; lat: number; alt: number };
  setHeadingPitchRoll(heading: number, pitch: number, roll: number): void;
  lookAt(target: [number, number, number], offset?: { heading?: number; pitch?: number; range?: number }): void;
  readonly terrainCollisionEnabled: boolean;
  setTerrainCollisionEnabled(enabled: boolean): void;
  setMinAltitudeAboveTerrain(meters: number): void;
  queryTerrainHeight(lon: number, lat: number): Promise<number>;
  flyToPosition(options: { lon: number; lat: number; alt: number; heading?: number; pitch?: number; duration?: number }): CameraAnimation;
}

type Mut = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  roll: number;
  viewMatrix: Float32Array;
  projectionMatrix: Float32Array;
  vpMatrix: Float32Array;
  inverseVPMatrix: Float32Array;
  position: Float32Array;
  altitude: number;
  fov: number;
};

type Anim = {
  id: string;
  startMs: number;
  durationMs: number;
  easing: (t: number) => number;
  from: {
    tgtLon: number;
    tgtLat: number;
    range: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  to: {
    tgtLon: number;
    tgtLat: number;
    range: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  handle: CameraAnimation & { _st: 'running' | 'finished' | 'cancelled'; _res?: () => void };
};

/**
 * 创建动画句柄。
 *
 * @param id - ID
 * @param onCancel - 取消
 *
 * @example
 * mkHandle('a', () => {});
 */
function mkHandle(id: string, onCancel: () => void): Anim['handle'] {
  let done = false;
  let res: (() => void) | undefined;
  const finished = new Promise<void>((r) => {
    res = r;
  });
  const h: Anim['handle'] = {
    id,
    _st: 'running',
    get state() {
      return h._st;
    },
    cancel: () => {
      if (h._st !== 'running') {
        return;
      }
      h._st = 'cancelled';
      try {
        onCancel();
      } catch (e) {
        console.error('[Camera3D] onCancel', e);
      }
      if (!done && res) {
        done = true;
        res();
      }
    },
    finished,
  };
  h._res = () => {
    if (!done && res) {
      done = true;
      res();
    }
  };
  return h;
}

function finish(h: Anim['handle']): void {
  if (h._st !== 'running') {
    return;
  }
  h._st = 'finished';
  h._res?.();
}

/**
 * 由目标点 + 球坐标轨道参数同步相机经纬高。
 *
 * @param tgtLon - 目标经度
 * @param tgtLat - 目标纬度
 * @param range - 与目标直线距离（米）
 * @param heading - 方位（从北顺时针，弧度）
 * @param pitch - 俯仰（从水平面向上为正，弧度）
 * @param bounds - 约束
 * @param minR - 最小距离
 * @param maxR - 最大距离
 * @param minP - 最小俯仰
 * @param maxP - 最大俯仰
 * @returns [camLon, camLat, camAlt]
 *
 * @example
 * syncOrbit(0, 0, 1e6, 0, -0.3, undefined, 100, 1e8, 0.01, 1.5);
 */
function syncOrbit(
  tgtLon: number,
  tgtLat: number,
  range: number,
  heading: number,
  pitch: number,
  bounds: BBox2D | undefined,
  minR: number,
  maxR: number,
  minP: number,
  maxP: number
): [number, number, number] {
  const r = clamp(range, minR, maxR);
  const p = clamp(pitch, minP, maxP);
  const latR = tgtLat * DEG_TO_RAD;
  const cosLat = Math.max(Math.cos(latR), 1e-6);
  // 局部北东天：相机相对目标偏移（相机在目标“东北上”方向 r 米处）
  const east = r * Math.cos(p) * Math.sin(heading);
  const north = r * Math.cos(p) * Math.cos(heading);
  const up = r * Math.sin(p);
  const dLon = east / (111320 * cosLat);
  const dLat = north / 111320;
  const camLon = clampLL(tgtLon + dLon, tgtLat + dLat, bounds)[0];
  const camLat = clampLL(tgtLon + dLon, tgtLat + dLat, bounds)[1];
  const camAlt = Math.max(minR, up);
  return [camLon, camLat, camAlt];
}

/**
 * 重建矩阵与 CameraState。
 *
 * @param camLon - 相机经度
 * @param camLat - 相机纬度
 * @param camAlt - 相机海拔
 * @param tgtLon - 目标经度
 * @param tgtLat - 目标纬度
 * @param heading - bearing（弧度）
 * @param pitch - pitch（弧度）
 * @param roll - roll（弧度）
 * @param viewport - 视口
 * @param fovY - fov
 * @param near - 近裁剪
 * @param far - 远裁剪
 * @param out - 输出
 * @returns CameraState
 *
 * @example
 * rebuild(camLon, camLat, alt, tLon, tLat, 0, 0, 0, vp, PI/4, 10, 1e9, mut);
 */
function rebuild(
  camLon: number,
  camLat: number,
  camAlt: number,
  tgtLon: number,
  tgtLat: number,
  heading: number,
  pitch: number,
  roll: number,
  viewport: Viewport,
  fovY: number,
  near: number,
  far: number,
  out: Mut
): CameraState {
  void roll;
  const eye64 = new Float64Array(3);
  geodeticToECEF(eye64, camLon * DEG_TO_RAD, camLat * DEG_TO_RAD, camAlt);
  ecef64To32(out.position, eye64);

  const tgt64 = new Float64Array(3);
  geodeticToECEF(tgt64, tgtLon * DEG_TO_RAD, tgtLat * DEG_TO_RAD, 0);
  const center = new Float32Array([tgt64[0], tgt64[1], tgt64[2]]);

  const upTmp = new Float32Array(3);
  upTmp[0] = out.position[0];
  upTmp[1] = out.position[1];
  upTmp[2] = out.position[2];
  const up = new Float32Array(3);
  norm3(up, upTmp);

  mat4.lookAt(out.viewMatrix, out.position, center, up);

  const aspect = Math.max(viewport.width, MIN_VIEWPORT_DIM) / Math.max(viewport.height, MIN_VIEWPORT_DIM);
  mat4.perspectiveReversedZ(out.projectionMatrix, fovY, aspect, near, far);
  mat4.multiply(out.vpMatrix, out.projectionMatrix, out.viewMatrix);
  if (mat4.invert(out.inverseVPMatrix, out.vpMatrix) === null) {
    mat4.identity(out.inverseVPMatrix);
  }

  out.center[0] = tgtLon;
  out.center[1] = tgtLat;
  out.zoom = zoomFromAlt(camAlt);
  out.bearing = heading;
  out.pitch = pitch;
  out.roll = roll;
  out.altitude = camAlt;
  out.fov = fovY;
  return out as CameraState;
}

class Camera3DImpl implements Camera3D {
  readonly type = '3d' as const;

  private readonly _m: Mut;

  /** 轨道中心（地面注视点） */
  private _tgtLon: number;
  private _tgtLat: number;

  /** 与目标的距离（米） */
  private _range: number;

  private _heading: number;
  private _pitch: number;
  private _roll: number;

  private _constraints: CameraConstraints;
  private _minR: number;
  private _maxR: number;
  private _terrainCollision: boolean;
  private _minClear: number;

  private _inertia = true;
  private _velE = 0;
  private _velN = 0;
  private _panning = false;
  private _lastSx: number | null = null;
  private _lastSy: number | null = null;
  private _lastMs = 0;

  private _anim: Anim | null = null;
  private _destroyed = false;

  private _onStart = new Set<() => void>();
  private _onMv = new Set<(s: CameraState) => void>();
  private _onEnd = new Set<() => void>();

  private _vpW = 1024;
  private _vpH = 768;

  /**
   * 构造 3D 相机。
   *
   * @param options - 初始参数
   */
  constructor(options?: Camera3DOptions) {
    this._m = {
      center: [0, 0],
      zoom: 2,
      bearing: 0,
      pitch: 0,
      roll: 0,
      viewMatrix: mat4.create(),
      projectionMatrix: mat4.create(),
      vpMatrix: mat4.create(),
      inverseVPMatrix: mat4.create(),
      position: new Float32Array(3),
      altitude: 1e7,
      fov: DEFAULT_FOV,
    };
    this._minR = options?.minimumZoomDistance ?? 100;
    this._maxR = options?.maximumZoomDistance ?? 5e7;
    const p = options?.position ?? { lon: 0, lat: 25, alt: 12_000_000 };
    const [tlon, tlat] = clampLL(p.lon, p.lat, undefined);
    this._tgtLon = tlon;
    this._tgtLat = tlat;
    this._heading = options?.heading ?? 0;
    this._pitch = clamp(options?.pitch ?? -0.35, DEFAULT_MIN_PITCH, DEFAULT_MAX_PITCH);
    this._roll = options?.roll ?? 0;
    // 由 alt 反推初始轨道半径（近似）
    this._range = clamp(p.alt, this._minR, this._maxR);
    this._constraints = {
      minZoom: DEFAULT_MIN_ZOOM,
      maxZoom: DEFAULT_MAX_ZOOM,
      minPitch: DEFAULT_MIN_PITCH,
      maxPitch: DEFAULT_MAX_PITCH,
      maxBounds: undefined,
    };
    this._terrainCollision = options?.enableCollision ?? false;
    this._minClear = 50;
  }

  /** @inheritdoc */
  get state(): CameraState {
    return this._m as CameraState;
  }

  /** @inheritdoc */
  get constraints(): CameraConstraints {
    return this._constraints;
  }

  /** @inheritdoc */
  get isAnimating(): boolean {
    return this._anim !== null;
  }

  /** @inheritdoc */
  get inertiaEnabled(): boolean {
    return this._inertia;
  }

  /** @inheritdoc */
  setInertiaEnabled(en: boolean): void {
    this._alive();
    this._inertia = en;
    if (!en) {
      this._velE = 0;
      this._velN = 0;
    }
  }

  /** @inheritdoc */
  get terrainCollisionEnabled(): boolean {
    return this._terrainCollision;
  }

  /** @inheritdoc */
  setTerrainCollisionEnabled(en: boolean): void {
    this._alive();
    this._terrainCollision = en;
    this._terrainClamp();
  }

  /** @inheritdoc */
  setMinAltitudeAboveTerrain(m: number): void {
    this._alive();
    this._minClear = Math.max(0, m);
    this._terrainClamp();
  }

  /** @inheritdoc */
  async queryTerrainHeight(lon: number, lat: number): Promise<number> {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return 0;
    }
    return 0;
  }

  /** @inheritdoc */
  setConstraints(c: Partial<CameraConstraints>): void {
    this._alive();
    let minZ = c.minZoom ?? this._constraints.minZoom;
    let maxZ = c.maxZoom ?? this._constraints.maxZoom;
    if (minZ > maxZ) {
      const s = minZ;
      minZ = maxZ;
      maxZ = s;
    }
    this._constraints = {
      minZoom: minZ,
      maxZoom: maxZ,
      minPitch: c.minPitch ?? this._constraints.minPitch,
      maxPitch: c.maxPitch ?? this._constraints.maxPitch,
      maxBounds: c.maxBounds !== undefined ? c.maxBounds : this._constraints.maxBounds,
    };
  }

  /** @inheritdoc */
  setCenter(center: [number, number]): void {
    this._alive();
    const [x, y] = clampLL(center[0], center[1], this._constraints.maxBounds);
    this._tgtLon = x;
    this._tgtLat = y;
  }

  /** @inheritdoc */
  setZoom(zoom: number): void {
    this._alive();
    const z = clamp(zoom, this._constraints.minZoom, this._constraints.maxZoom);
    this._range = clamp(altFromZoom(z), this._minR, this._maxR);
    this._terrainClamp();
  }

  /** @inheritdoc */
  setBearing(b: number): void {
    this._alive();
    if (Number.isFinite(b)) {
      this._heading = b;
    }
  }

  /** @inheritdoc */
  setPitch(p: number): void {
    this._alive();
    this._pitch = clamp(p, this._constraints.minPitch, this._constraints.maxPitch);
  }

  /** @inheritdoc */
  setPosition(lon: number, lat: number, alt: number): void {
    this._alive();
    const [x, y] = clampLL(lon, lat, this._constraints.maxBounds);
    // 保持目标不变，调整距离使相机高度接近 alt（MVP 近似）
    this._range = clamp(alt, this._minR, this._maxR);
    this._tgtLon = x;
    this._tgtLat = y;
    this._terrainClamp();
  }

  /** @inheritdoc */
  getPosition(): { lon: number; lat: number; alt: number } {
    const [clon, clat, calt] = syncOrbit(
      this._tgtLon,
      this._tgtLat,
      this._range,
      this._heading,
      this._pitch,
      this._constraints.maxBounds,
      this._minR,
      this._maxR,
      this._constraints.minPitch,
      this._constraints.maxPitch
    );
    return { lon: clon, lat: clat, alt: calt };
  }

  /** @inheritdoc */
  setHeadingPitchRoll(h: number, p: number, r: number): void {
    this._alive();
    if (Number.isFinite(h)) {
      this._heading = h;
    }
    this._pitch = clamp(
      Number.isFinite(p) ? p : this._pitch,
      this._constraints.minPitch,
      this._constraints.maxPitch
    );
    if (Number.isFinite(r)) {
      this._roll = r;
    }
  }

  /** @inheritdoc */
  lookAt(target: [number, number, number], offset?: { heading?: number; pitch?: number; range?: number }): void {
    this._alive();
    const [tlon, tlat, th] = target;
    if (!Number.isFinite(tlon) || !Number.isFinite(tlat) || !Number.isFinite(th)) {
      return;
    }
    const [gx, gy] = clampLL(tlon, tlat, this._constraints.maxBounds);
    this._tgtLon = gx;
    this._tgtLat = gy;
    this._heading = offset?.heading ?? this._heading;
    this._pitch = clamp(
      offset?.pitch ?? -0.4,
      this._constraints.minPitch,
      this._constraints.maxPitch
    );
    this._range = clamp(offset?.range ?? 4_000_000, this._minR, this._maxR);
    void th;
    this._terrainClamp();
  }

  /** @inheritdoc */
  jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    this._alive();
    this.stop();
    if (o.center) {
      const [x, y] = clampLL(o.center[0], o.center[1], this._constraints.maxBounds);
      this._tgtLon = x;
      this._tgtLat = y;
    }
    if (o.zoom !== undefined) {
      this._range = clamp(altFromZoom(o.zoom), this._minR, this._maxR);
    }
    if (o.bearing !== undefined && Number.isFinite(o.bearing)) {
      this._heading = o.bearing;
    }
    if (o.pitch !== undefined && Number.isFinite(o.pitch)) {
      this._pitch = clamp(o.pitch, this._constraints.minPitch, this._constraints.maxPitch);
    }
    this._terrainClamp();
  }

  /** @inheritdoc */
  flyTo(o: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation {
    this._alive();
    this.stop();
    const id = makeId();
    const h = mkHandle(id, () => {
      if (this._anim?.id === id) {
        this._anim = null;
      }
    });
    const toLon = o.center ? clampLL(o.center[0], o.center[1], this._constraints.maxBounds)[0] : this._tgtLon;
    const toLat = o.center ? clampLL(o.center[0], o.center[1], this._constraints.maxBounds)[1] : this._tgtLat;
    const toR =
      o.zoom !== undefined
        ? clamp(altFromZoom(clamp(o.zoom, this._constraints.minZoom, this._constraints.maxZoom)), this._minR, this._maxR)
        : this._range;
    const toH = o.bearing !== undefined && Number.isFinite(o.bearing) ? o.bearing : this._heading;
    const toP =
      o.pitch !== undefined && Number.isFinite(o.pitch)
        ? clamp(o.pitch, this._constraints.minPitch, this._constraints.maxPitch)
        : this._pitch;
    this._anim = {
      id,
      startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      durationMs: Math.max(MIN_ANIM_MS, o.duration ?? DEFAULT_ANIM_MS),
      easing: o.easing ?? smoothstep,
      from: {
        tgtLon: this._tgtLon,
        tgtLat: this._tgtLat,
        range: this._range,
        heading: this._heading,
        pitch: this._pitch,
        roll: this._roll,
      },
      to: {
        tgtLon: toLon,
        tgtLat: toLat,
        range: toR,
        heading: toH,
        pitch: toP,
        roll: this._roll,
      },
      handle: h,
    };
    return h;
  }

  /** @inheritdoc */
  easeTo(o: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
  }): CameraAnimation {
    return this.flyTo({ ...o, easing: smoothstep });
  }

  /** @inheritdoc */
  flyToPosition(o: { lon: number; lat: number; alt: number; heading?: number; pitch?: number; duration?: number }): CameraAnimation {
    this._alive();
    this.stop();
    const id = makeId();
    const h = mkHandle(id, () => {
      if (this._anim?.id === id) {
        this._anim = null;
      }
    });
    const [x, y] = clampLL(o.lon, o.lat, this._constraints.maxBounds);
    const toR = clamp(o.alt, this._minR, this._maxR);
    const toH = o.heading !== undefined && Number.isFinite(o.heading) ? o.heading : this._heading;
    const toP =
      o.pitch !== undefined && Number.isFinite(o.pitch)
        ? clamp(o.pitch, this._constraints.minPitch, this._constraints.maxPitch)
        : this._pitch;
    this._anim = {
      id,
      startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      durationMs: Math.max(MIN_ANIM_MS, o.duration ?? DEFAULT_ANIM_MS),
      easing: smoothstep,
      from: {
        tgtLon: this._tgtLon,
        tgtLat: this._tgtLat,
        range: this._range,
        heading: this._heading,
        pitch: this._pitch,
        roll: this._roll,
      },
      to: {
        tgtLon: x,
        tgtLat: y,
        range: toR,
        heading: toH,
        pitch: toP,
        roll: this._roll,
      },
      handle: h,
    };
    return h;
  }

  /** @inheritdoc */
  stop(): void {
    if (this._anim) {
      const h = this._anim.handle;
      this._anim = null;
      h.cancel();
    }
  }

  /** @inheritdoc */
  update(dt: number, viewport: Viewport): CameraState {
    this._alive();
    this._vpW = Math.max(viewport.width, MIN_VIEWPORT_DIM);
    this._vpH = Math.max(viewport.height, MIN_VIEWPORT_DIM);
    const dts = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (this._anim) {
      const a = this._anim;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const u = clamp((now - a.startMs) / a.durationMs, 0, 1);
      const t = a.easing(u);
      this._tgtLon = lerp(a.from.tgtLon, a.to.tgtLon, t);
      this._tgtLat = lerp(a.from.tgtLat, a.to.tgtLat, t);
      this._range = lerp(a.from.range, a.to.range, t);
      this._heading = lerp(a.from.heading, a.to.heading, t);
      this._pitch = lerp(a.from.pitch, a.to.pitch, t);
      this._roll = lerp(a.from.roll, a.to.roll, t);
      const ll = clampLL(this._tgtLon, this._tgtLat, this._constraints.maxBounds);
      this._tgtLon = ll[0];
      this._tgtLat = ll[1];
      this._range = clamp(this._range, this._minR, this._maxR);
      this._terrainClamp();
      if (u >= 1) {
        finish(a.handle);
        this._anim = null;
      }
    } else if (this._inertia && !this._panning) {
      if (Math.abs(this._velE) > INERTIA_EPS || Math.abs(this._velN) > INERTIA_EPS) {
        const dec = Math.pow(0.9, dts * 60);
        const latR = this._tgtLat * DEG_TO_RAD;
        const cosLat = Math.max(Math.cos(latR), 1e-6);
        const dLon = (this._velE * dts) / (111320 * cosLat);
        const dLat = (this._velN * dts) / 111320;
        this._tgtLon = clampLL(this._tgtLon + dLon, this._tgtLat + dLat, this._constraints.maxBounds)[0];
        this._tgtLat = clampLL(this._tgtLon + dLon, this._tgtLat + dLat, this._constraints.maxBounds)[1];
        this._velE *= dec;
        this._velN *= dec;
      }
    }

    const [cLon, cLat, cAlt] = syncOrbit(
      this._tgtLon,
      this._tgtLat,
      this._range,
      this._heading,
      this._pitch,
      this._constraints.maxBounds,
      this._minR,
      this._maxR,
      this._constraints.minPitch,
      this._constraints.maxPitch
    );
    const e = new Float64Array(3);
    const g = new Float64Array(3);
    geodeticToECEF(e, cLon * DEG_TO_RAD, cLat * DEG_TO_RAD, cAlt);
    geodeticToECEF(g, this._tgtLon * DEG_TO_RAD, this._tgtLat * DEG_TO_RAD, 0);
    const dx = e[0] - g[0];
    const dy = e[1] - g[1];
    const dz = e[2] - g[2];
    const dist = Math.hypot(dx, dy, dz);
    const near = Math.max(10, dist * 1e-4);
    const far = Math.max(near + 100, dist * 2, cAlt + WGS84_A);

    return rebuild(
      cLon,
      cLat,
      cAlt,
      this._tgtLon,
      this._tgtLat,
      this._heading,
      this._pitch,
      this._roll,
      viewport,
      DEFAULT_FOV,
      near,
      far,
      this._m
    );
  }

  /** @inheritdoc */
  handlePanStart(sx: number, sy: number): void {
    this._alive();
    void sx;
    void sy;
    this._panning = true;
    this._lastSx = null;
    this._lastSy = null;
    this._lastMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._velE = 0;
    this._velN = 0;
    for (const c of this._onStart) {
      try {
        c();
      } catch (e) {
        console.error('[Camera3D] onMoveStart', e);
      }
    }
  }

  /** @inheritdoc */
  handlePanMove(sx: number, sy: number): void {
    this._alive();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const prevT = this._lastMs;
    this._lastMs = now;
    const dts = Math.max(1e-4, (now - prevT) / 1000);
    if (this._lastSx === null || this._lastSy === null) {
      this._lastSx = sx;
      this._lastSy = sy;
      return;
    }
    const dx = sx - this._lastSx;
    const dy = sy - this._lastSy;
    this._lastSx = sx;
    this._lastSy = sy;
    const latR = this._tgtLat * DEG_TO_RAD;
    const cosLat = Math.max(Math.cos(latR), 1e-6);
    const span = this._range * 0.5;
    const dEast = (-dx / this._vpW) * span * 2;
    const dNorth = (dy / this._vpH) * span * 2;
    this._tgtLon += dEast / (111320 * cosLat);
    this._tgtLat += dNorth / 111320;
    const ll = clampLL(this._tgtLon, this._tgtLat, this._constraints.maxBounds);
    this._tgtLon = ll[0];
    this._tgtLat = ll[1];
    this._velE = dEast / dts;
    this._velN = dNorth / dts;
    for (const c of this._onMv) {
      try {
        c(this.state);
      } catch (e) {
        console.error('[Camera3D] onMove', e);
      }
    }
  }

  /** @inheritdoc */
  handlePanEnd(): void {
    this._alive();
    this._panning = false;
    this._lastSx = null;
    this._lastSy = null;
    for (const c of this._onEnd) {
      try {
        c();
      } catch (e) {
        console.error('[Camera3D] onMoveEnd', e);
      }
    }
  }

  /** @inheritdoc */
  handleZoom(delta: number, sx: number, sy: number): void {
    this._alive();
    void sx;
    void sy;
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    const f = Math.pow(1.001, -delta);
    this._range = clamp(this._range * f, this._minR, this._maxR);
    this._terrainClamp();
  }

  /** @inheritdoc */
  handleRotate(db: number, dp: number): void {
    this._alive();
    this._heading += db;
    this._pitch = clamp(this._pitch + dp, this._constraints.minPitch, this._constraints.maxPitch);
  }

  /** @inheritdoc */
  onMoveStart(cb: () => void): () => void {
    this._onStart.add(cb);
    return () => this._onStart.delete(cb);
  }

  /** @inheritdoc */
  onMove(cb: (s: CameraState) => void): () => void {
    this._onMv.add(cb);
    return () => this._onMv.delete(cb);
  }

  /** @inheritdoc */
  onMoveEnd(cb: () => void): () => void {
    this._onEnd.add(cb);
    return () => this._onEnd.delete(cb);
  }

  /** @inheritdoc */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.stop();
    this._onStart.clear();
    this._onMv.clear();
    this._onEnd.clear();
  }

  private _alive(): void {
    if (this._destroyed) {
      throw new Error('[Camera3D] destroyed');
    }
  }

  /**
   * 地形净空：MVP DEM=0。
   *
   * @returns void
   *
   * @example
   * this._terrainClamp();
   */
  private _terrainClamp(): void {
    if (!this._terrainCollision) {
      return;
    }
    const [clon, clat, calt] = syncOrbit(
      this._tgtLon,
      this._tgtLat,
      this._range,
      this._heading,
      this._pitch,
      this._constraints.maxBounds,
      this._minR,
      this._maxR,
      this._constraints.minPitch,
      this._constraints.maxPitch
    );
    void clon;
    void clat;
    const minA = this._minClear;
    if (calt < minA) {
      // 增大轨道半径使相机抬高（近似）
      this._range = clamp(this._range * (minA / Math.max(calt, 1)), this._minR, this._maxR);
    }
  }
}

/**
 * 创建 Camera3D 实例。
 *
 * @param options - 选项
 * @returns Camera3D
 *
 * @example
 * createCamera3D({ position: { lon: 0, lat: 30, alt: 8e6 } });
 */
export function createCamera3D(options?: Camera3DOptions): Camera3D {
  return new Camera3DImpl(options);
}
