/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean | undefined;

// ============================================================
// @geoforge/preset-3d — Globe3D（3D 数字地球入口，MVP 状态机）
// 管理 Canvas、相机姿态、图层/实体注册与简单事件总线；
// 完整 WebGPU 渲染链路由引擎其他层接入，此处不创建 GPU 资源。
// ============================================================

import type { BBox2D, Feature } from '@geoforge/core';
import { uniqueId } from '@geoforge/core';

import { GeoForgeError, GeoForgeErrorCode } from '../../preset-2d/src/map-2d.ts';

/** 默认地形夸大系数。 */
const DEFAULT_TERRAIN_EXAGGERATION = 1;

/** 默认时钟倍速（实时）。 */
const DEFAULT_CLOCK_MULTIPLIER = 1;

/** 全圆（弧度）。 */
const TWO_PI = Math.PI * 2;

/** 将弧度归一化到 [0, 2π)。 */
function normalizeAngleRad(rad: number): number {
  if (!Number.isFinite(rad)) {
    return 0;
  }
  let x = rad % TWO_PI;
  if (x < 0) {
    x += TWO_PI;
  }
  return x;
}

/**
 * 数字地球构造选项。
 */
export interface Globe3DOptions {
  /**
   * 挂载容器：CSS 选择器或已有元素。
   */
  readonly container: string | HTMLElement;

  /**
   * 地形数据源与夸大参数。
   */
  readonly terrain?: {
    /** 地形 URL（模板或 TileJSON）。 */
    readonly url: string;
    /** 高程夸大系数；默认 1。 */
    readonly exaggeration?: number;
  };

  /**
   * 影像底图配置。
   */
  readonly imagery?: {
    /** 瓦片 URL 模板。 */
    readonly url?: string;
    /** 瓦片方案类型（wmts/tms/xyz 等）。 */
    readonly type?: string;
    /** 最大级别。 */
    readonly maximumLevel?: number;
  };

  /**
   * 是否启用大气层渲染。
   * 默认 true。
   */
  readonly atmosphere?: boolean;

  /**
   * 是否启用阴影。
   * 默认 false。
   */
  readonly shadows?: boolean;

  /**
   * 是否启用天空盒。
   * 默认 true。
   */
  readonly skybox?: boolean;

  /**
   * 是否启用雾效。
   * 默认 true。
   */
  readonly fog?: boolean;

  /**
   * 地球底色 RGBA，分量范围 [0,1]。
   */
  readonly baseColor?: [number, number, number, number];

  /**
   * 目标帧率（Hz）。
   */
  readonly targetFrameRate?: number;

  /**
   * 是否开启抗锯齿（上下文选项预留）。
   */
  readonly antialias?: boolean;

  /**
   * 最大 devicePixelRatio。
   */
  readonly maxPixelRatio?: number;

  /**
   * 是否允许旋转。
   */
  readonly enableRotate?: boolean;

  /**
   * 是否允许缩放。
   */
  readonly enableZoom?: boolean;

  /**
   * 是否允许倾斜。
   */
  readonly enableTilt?: boolean;

  /**
   * 最小相机距离（米）。
   */
  readonly minimumZoomDistance?: number;

  /**
   * 最大相机距离（米）。
   */
  readonly maximumZoomDistance?: number;
}

/**
 * 3D 实体描述（模型 / 标牌 / 标签）。
 */
export interface EntitySpec {
  /**
   * 实体 id；省略时由引擎生成。
   */
  readonly id?: string;

  /**
   * 位置 [lon, lat, alt]，单位度/米。
   */
  readonly position: [number, number, number];

  /**
   * glTF 等模型 URL。
   */
  readonly model?: {
    /** 模型地址。 */
    readonly url: string;
    /** 统一缩放系数。 */
    readonly scale?: number;
  };

  /**
   * 广告牌纹理。
   */
  readonly billboard?: {
    /** 图片 URL。 */
    readonly image: string;
    /** 缩放。 */
    readonly scale?: number;
  };

  /**
   * 屏幕空间标签。
   */
  readonly label?: {
    /** 文本内容。 */
    readonly text: string;
    /** 字体族描述。 */
    readonly font?: string;
  };
}

/**
 * 影像图层运行时记录。
 */
interface ImageryLayerRecord {
  /** 图层 id。 */
  readonly id: string;
  /** 瓦片 URL。 */
  readonly url: string;
  /** 类型字符串。 */
  readonly type: string;
  /** 透明度 [0,1]。 */
  alpha: number;
}

/**
 * 3D Tiles 运行时记录。
 */
interface TilesetRecord {
  /** 记录 id。 */
  readonly id: string;
  /** tileset.json URL。 */
  readonly url: string;
  /** SSE 阈值。 */
  maximumScreenSpaceError: number;
  /** 是否可见。 */
  show: boolean;
}

/**
 * GeoJSON 图层记录。
 */
interface GeoJsonRecord {
  /** id。 */
  readonly id: string;
  /** 数据或 URL。 */
  data: unknown;
  /** 附加选项。 */
  options: unknown;
}

/**
 * Globe3D：3D 地球主类（MVP 状态容器 + DOM 生命周期）。
 *
 * @example
 * const g = new Globe3D({ container: '#globe', terrain: { url: 'https://example.com/tiles' } });
 */
export class Globe3D {
  /**
   * 挂载容器。
   */
  private readonly _container: HTMLElement;

  /**
   * 主绘制画布。
   */
  private readonly _canvas: HTMLCanvasElement;

  /**
   * 相机位置与姿态（弧度制 bearing/pitch/roll，与 GeoForge 一致）。
   */
  private _cameraPosition: {
    lon: number;
    lat: number;
    alt: number;
    bearing: number;
    pitch: number;
    roll: number;
  };

  /**
   * 大气层开关。
   */
  private _atmosphere: boolean;

  /**
   * 阴影开关。
   */
  private _shadows: boolean;

  /**
   * 天空盒开关。
   */
  private _skybox: boolean;

  /**
   * 雾效开关。
   */
  private _fog: boolean;

  /**
   * 仿真时间（太阳位置、阴影方向）。
   */
  private _dateTime: Date;

  /**
   * 时钟倍速。
   */
  private _clockMultiplier: number;

  /**
   * 当前视图模式（2D / 2.5D / 3D）。
   */
  private _viewMode: '2d' | '25d' | '3d';

  /**
   * 地形夸大。
   */
  private _terrainExaggeration: number;

  /**
   * 影像图层表。
   */
  private readonly _imageryLayers: Map<string, ImageryLayerRecord> = new Map();

  /**
   * 3D Tiles 表。
   */
  private readonly _tilesets: Map<string, TilesetRecord> = new Map();

  /**
   * GeoJSON 图层表。
   */
  private readonly _geoJsonLayers: Map<string, GeoJsonRecord> = new Map();

  /**
   * 实体表。
   */
  private readonly _entities: Map<string, EntitySpec> = new Map();

  /**
   * 事件监听器。
   */
  private readonly _listeners: Map<string, Set<(e: unknown) => void>> = new Map();

  /**
   * 是否已销毁。
   */
  private _destroyed = false;

  /**
   * 交互：旋转。
   */
  private readonly _enableRotate: boolean;

  /**
   * 交互：缩放。
   */
  private readonly _enableZoom: boolean;

  /**
   * 交互：倾斜。
   */
  private readonly _enableTilt: boolean;

  /**
   * 最近距离（米）。
   */
  private readonly _minimumZoomDistance: number;

  /**
   * 最远距离（米）。
   */
  private readonly _maximumZoomDistance: number;

  /**
   * ResizeObserver 句柄。
   */
  private _resizeObserver: ResizeObserver | null = null;

  /**
   * 创建 Globe3D。
   *
   * @param options - 构造选项
   *
   * @example
   * new Globe3D({ container: document.body, atmosphere: true });
   */
  public constructor(options: Globe3DOptions) {
    if (options === undefined || options === null) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'Globe3DOptions 不能为空', {});
    }
    this._container = this._resolveContainer(options.container);
    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.setAttribute('role', 'application');
    this._canvas.setAttribute('aria-label', 'GeoForge Globe3D');
    this._container.style.position = 'relative';
    this._container.appendChild(this._canvas);
    // 初始相机：北京上空约 2000km（MVP 占位）
    this._cameraPosition = {
      lon: 116.4,
      lat: 39.9,
      alt: 2_000_000,
      bearing: 0,
      pitch: -Math.PI / 4,
      roll: 0,
    };
    this._atmosphere = options.atmosphere ?? true;
    this._shadows = options.shadows ?? false;
    this._skybox = options.skybox ?? true;
    this._fog = options.fog ?? true;
    this._dateTime = new Date();
    this._clockMultiplier = DEFAULT_CLOCK_MULTIPLIER;
    this._viewMode = '3d';
    this._terrainExaggeration =
      options.terrain?.exaggeration !== undefined
        ? this._validatePositive(options.terrain.exaggeration, 'terrain.exaggeration')
        : DEFAULT_TERRAIN_EXAGGERATION;
    this._enableRotate = options.enableRotate ?? true;
    this._enableZoom = options.enableZoom ?? true;
    this._enableTilt = options.enableTilt ?? true;
    this._minimumZoomDistance = options.minimumZoomDistance ?? 1;
    this._maximumZoomDistance =
      options.maximumZoomDistance !== undefined && Number.isFinite(options.maximumZoomDistance)
        ? Math.max(this._minimumZoomDistance, options.maximumZoomDistance)
        : Number.POSITIVE_INFINITY;
    const maxPR = options.maxPixelRatio ?? 2;
    this._resizeCanvas(maxPR);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        try {
          this.resize();
        } catch (err) {
          this._emit('error', { type: 'error', error: err });
        }
      });
      this._resizeObserver.observe(this._container);
    }
    queueMicrotask(() => this._emit('load', { type: 'load', target: this }));
  }

  /**
   * 校验正有限数。
   *
   * @param v - 数值
   * @param label - 字段名
   * @returns 原值
   */
  private _validatePositive(v: number, label: string): number {
    if (!Number.isFinite(v) || v <= 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, `${label} 必须为正有限数`, { [label]: v });
    }
    return v;
  }

  /**
   * 解析容器。
   *
   * @param container - 选择器或元素
   * @returns HTMLElement
   */
  private _resolveContainer(container: string | HTMLElement): HTMLElement {
    if (typeof container === 'string') {
      const el = document.querySelector(container);
      if (!el || !(el instanceof HTMLElement)) {
        throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_CONTAINER, 'Globe3D 容器未找到', {
          selector: container,
        });
      }
      return el;
    }
    if (!(container instanceof HTMLElement)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_CONTAINER, 'Globe3D container 必须是 HTMLElement', {});
    }
    return container;
  }

  /**
   * 更新画布像素尺寸。
   *
   * @param maxPixelRatio - DPR 上限
   */
  private _resizeCanvas(maxPixelRatio: number): void {
    const rect = this._container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this._canvas.width = Math.floor(w * dpr);
    this._canvas.height = Math.floor(h * dpr);
  }

  /**
   * 飞行到目标点与姿态。
   *
   * @param options - 目标 destination 与 orientation
   * @returns this
   *
   * @example
   * globe.flyTo({ destination: [0, 0, 1e6], duration: 2000 });
   */
  public flyTo(options: {
    destination: [number, number, number];
    orientation?: { bearing?: number; pitch?: number; roll?: number };
    duration?: number;
  }): this {
    this._ensureAlive();
    const [lon, lat, alt] = options.destination;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(alt)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'destination 非法', { destination: options.destination });
    }
    const o = options.orientation;
    const duration = options.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'duration 非法', { duration });
    }
    if (duration === 0) {
      this._cameraPosition.lon = lon;
      this._cameraPosition.lat = lat;
      this._cameraPosition.alt = alt;
      if (o?.bearing !== undefined) {
        this._cameraPosition.bearing = normalizeAngleRad(o.bearing);
      }
      if (o?.pitch !== undefined) {
        this._cameraPosition.pitch = o.pitch;
      }
      if (o?.roll !== undefined) {
        this._cameraPosition.roll = o.roll;
      }
      this._emit('moveend', { type: 'moveend', target: this });
      return this;
    }
    // 线性插值（完整引擎可替换为样条）
    const start = { ...this._cameraPosition };
    const endLon = lon;
    const endLat = lat;
    const endAlt = alt;
    const endBr = o?.bearing !== undefined ? normalizeAngleRad(o.bearing) : start.bearing;
    const endPi = o?.pitch !== undefined ? o.pitch : start.pitch;
    const endRl = o?.roll !== undefined ? o.roll : start.roll;
    const t0 = performance.now();
    const ease = (t: number) => 1 - (1 - t) * (1 - t);
    const step = (now: number) => {
      if (this._destroyed) {
        return;
      }
      const u = Math.min(1, (now - t0) / duration);
      const k = ease(u);
      this._cameraPosition.lon = start.lon + (endLon - start.lon) * k;
      this._cameraPosition.lat = start.lat + (endLat - start.lat) * k;
      this._cameraPosition.alt = start.alt + (endAlt - start.alt) * k;
      this._cameraPosition.bearing = start.bearing + (endBr - start.bearing) * k;
      this._cameraPosition.pitch = start.pitch + (endPi - start.pitch) * k;
      this._cameraPosition.roll = start.roll + (endRl - start.roll) * k;
      this._emit('move', { type: 'move', target: this });
      if (u < 1) {
        requestAnimationFrame(step);
      } else {
        this._emit('moveend', { type: 'moveend', target: this });
      }
    };
    this._emit('movestart', { type: 'movestart', target: this });
    requestAnimationFrame(step);
    return this;
  }

  /**
   * 看向目标点，可选 offset（bearing/pitch/range）。
   * 注：offset.heading 视为 bearing（弧度）以兼容历史命名。
   *
   * @param target - [lon, lat, alt]
   * @param offset - 相对方位偏移
   * @returns this
   *
   * @example
   * globe.lookAt([0, 0, 0], { pitch: -0.5, range: 1e7 });
   */
  public lookAt(
    target: [number, number, number],
    offset?: { heading?: number; pitch?: number; range?: number },
  ): this {
    this._ensureAlive();
    const [tlon, tlat, talt] = target;
    if (!Number.isFinite(tlon) || !Number.isFinite(tlat) || !Number.isFinite(talt)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'lookAt target 非法', { target });
    }
    const range = offset?.range ?? this._cameraPosition.alt;
    if (!Number.isFinite(range) || range <= 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'offset.range 必须为正有限数', { range });
    }
    // 简化：将相机放在目标正上方 range 米处
    this._cameraPosition.lon = tlon;
    this._cameraPosition.lat = tlat;
    this._cameraPosition.alt = talt + range;
    if (offset?.heading !== undefined) {
      this._cameraPosition.bearing = normalizeAngleRad(offset.heading);
    }
    if (offset?.pitch !== undefined) {
      this._cameraPosition.pitch = offset.pitch;
    }
    this._emit('moveend', { type: 'moveend', target: this });
    return this;
  }

  /**
   * 飞行到地理范围（MVP：计算中心与近似高度）。
   *
   * @param bounds - 经纬度包围盒
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * globe.flyToBounds({ west: -1, south: -1, east: 1, north: 1 }, { duration: 1500 });
   */
  public flyToBounds(bounds: BBox2D, options?: { duration?: number; heading?: number; pitch?: number }): this {
    this._ensureAlive();
    if (!bounds || typeof bounds !== 'object') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'bounds 不能为空', {});
    }
    const { west, south, east, north } = bounds;
    if (![west, south, east, north].every((v) => Number.isFinite(v))) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'bounds 分量非法', { bounds });
    }
    const cx = (west + east) * 0.5;
    const cy = (south + north) * 0.5;
    const span = Math.max(Math.abs(east - west), Math.abs(north - south));
    // 粗略高度：跨度越大相机越高
    const alt = Math.max(10_000, span * 111_000 * 1.5);
    const dest: [number, number, number] = [cx, cy, alt];
    const duration = options?.duration ?? 0;
    if (options?.heading !== undefined) {
      this._cameraPosition.bearing = normalizeAngleRad(options.heading);
    }
    if (options?.pitch !== undefined) {
      this._cameraPosition.pitch = options.pitch;
    }
    return this.flyTo({
      destination: dest,
      duration,
    });
  }

  /**
   * 返回当前相机姿态（弧度）。
   *
   * @returns 相机状态
   *
   * @example
   * const c = globe.getCameraPosition();
   */
  public getCameraPosition(): {
    lon: number;
    lat: number;
    alt: number;
    bearing: number;
    pitch: number;
    roll: number;
  } {
    this._ensureAlive();
    return { ...this._cameraPosition };
  }

  /**
   * 设置相机（无动画）。
   *
   * @param pos - 位置与姿态
   * @returns this
   *
   * @example
   * globe.setCameraPosition({ lon: 0, lat: 0, alt: 1e6, bearing: 0.2 });
   */
  public setCameraPosition(pos: {
    lon: number;
    lat: number;
    alt: number;
    bearing?: number;
    pitch?: number;
    roll?: number;
  }): this {
    this._ensureAlive();
    if (!Number.isFinite(pos.lon) || !Number.isFinite(pos.lat) || !Number.isFinite(pos.alt)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'setCameraPosition lon/lat/alt 非法', { pos });
    }
    this._cameraPosition.lon = pos.lon;
    this._cameraPosition.lat = pos.lat;
    this._cameraPosition.alt = pos.alt;
    if (pos.bearing !== undefined) {
      this._cameraPosition.bearing = normalizeAngleRad(pos.bearing);
    }
    if (pos.pitch !== undefined) {
      this._cameraPosition.pitch = pos.pitch;
    }
    if (pos.roll !== undefined) {
      this._cameraPosition.roll = pos.roll;
    }
    // 约束距离
    this._cameraPosition.alt = Math.min(
      Math.max(this._cameraPosition.alt, this._minimumZoomDistance),
      this._maximumZoomDistance,
    );
    return this;
  }

  /**
   * 添加影像图层。
   *
   * @param options - url / type / alpha
   * @returns 图层 id
   *
   * @example
   * const id = globe.addImageryLayer({ url: 'https://tiles/{z}/{x}/{y}.png' });
   */
  public addImageryLayer(options: { url: string; type?: string; alpha?: number }): string {
    this._ensureAlive();
    if (!options.url || typeof options.url !== 'string') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'addImageryLayer 需要 url', { options });
    }
    const id = uniqueId('imagery');
    const alpha = options.alpha !== undefined ? options.alpha : 1;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'alpha 必须在 [0,1]', { alpha });
    }
    this._imageryLayers.set(id, {
      id,
      url: options.url,
      type: options.type ?? 'xyz',
      alpha,
    });
    return id;
  }

  /**
   * 移除影像图层。
   *
   * @param id - 图层 id
   * @returns this
   */
  public removeImageryLayer(id: string): this {
    this._ensureAlive();
    if (!id) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'removeImageryLayer id 为空', {});
    }
    this._imageryLayers.delete(id);
    return this;
  }

  /**
   * 注册 3D Tiles。
   *
   * @param options - tileset 与 SSE
   * @returns 记录 id
   */
  public add3DTileset(options: { url: string; maximumScreenSpaceError?: number; show?: boolean }): string {
    this._ensureAlive();
    if (!options.url) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'add3DTileset 需要 url', {});
    }
    const id = uniqueId('tileset');
    const sse = options.maximumScreenSpaceError ?? 16;
    if (!Number.isFinite(sse) || sse <= 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'maximumScreenSpaceError 非法', { sse });
    }
    this._tilesets.set(id, {
      id,
      url: options.url,
      maximumScreenSpaceError: sse,
      show: options.show ?? true,
    });
    this._emit('3dtiles-loaded', { type: '3dtiles-loaded', id });
    return id;
  }

  /**
   * 移除 3D Tiles。
   *
   * @param id - 记录 id
   * @returns this
   */
  public remove3DTileset(id: string): this {
    this._ensureAlive();
    if (!id) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'remove3DTileset id 为空', {});
    }
    this._tilesets.delete(id);
    return this;
  }

  /**
   * 添加 GeoJSON 数据。
   *
   * @param data - GeoJSON 或 URL
   * @param options - 解析选项
   * @returns 图层 id
   */
  public addGeoJSON(data: unknown, options?: unknown): string {
    this._ensureAlive();
    const id = uniqueId('geojson');
    this._geoJsonLayers.set(id, { id, data, options });
    return id;
  }

  /**
   * 移除 GeoJSON 图层。
   *
   * @param id - 图层 id
   * @returns this
   */
  public removeGeoJSON(id: string): this {
    this._ensureAlive();
    if (!id) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'removeGeoJSON id 为空', {});
    }
    this._geoJsonLayers.delete(id);
    return this;
  }

  /**
   * 添加实体。
   *
   * @param entity - 实体规格
   * @returns 实体 id
   */
  public addEntity(entity: EntitySpec): string {
    this._ensureAlive();
    const [lon, lat, alt] = entity.position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(alt)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'entity.position 非法', { entity });
    }
    const id = entity.id ?? uniqueId('entity');
    if (this._entities.has(id)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'entity id 重复', { id });
    }
    this._entities.set(id, entity);
    return id;
  }

  /**
   * 移除实体。
   *
   * @param id - 实体 id
   * @returns this
   */
  public removeEntity(id: string): this {
    this._ensureAlive();
    if (!id) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_ID, 'removeEntity id 为空', {});
    }
    this._entities.delete(id);
    return this;
  }

  /**
   * 异步拾取（MVP：无 GPU 时返回空数组）。
   *
   * @param _point - 屏幕点
   * @param _options - 过滤选项
   * @returns Promise<Feature[]>
   */
  public async queryRenderedFeatures(
    _point?: [number, number],
    _options?: unknown,
  ): Promise<Feature[]> {
    this._ensureAlive();
    return [];
  }

  /**
   * 设置地形夸大系数。
   *
   * @param value - 夸大系数
   * @returns this
   */
  public setTerrainExaggeration(value: number): this {
    this._ensureAlive();
    this._terrainExaggeration = this._validatePositive(value, 'terrainExaggeration');
    return this;
  }

  /**
   * 查询地形高程（异步；MVP 返回椭球高 0）。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @returns Promise 米
   */
  public async getTerrainHeight(lon: number, lat: number): Promise<number> {
    this._ensureAlive();
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'getTerrainHeight 坐标非法', { lon, lat });
    }
    return Promise.resolve(0);
  }

  /**
   * 开关大气层。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setAtmosphereEnabled(enabled: boolean): this {
    this._ensureAlive();
    this._atmosphere = !!enabled;
    return this;
  }

  /**
   * 开关阴影。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setShadowsEnabled(enabled: boolean): this {
    this._ensureAlive();
    this._shadows = !!enabled;
    return this;
  }

  /**
   * 开关天空盒。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setSkyboxEnabled(enabled: boolean): this {
    this._ensureAlive();
    this._skybox = !!enabled;
    return this;
  }

  /**
   * 开关雾效。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setFogEnabled(enabled: boolean): this {
    this._ensureAlive();
    this._fog = !!enabled;
    return this;
  }

  /**
   * 设置仿真时间。
   *
   * @param date - 日期时间
   * @returns this
   */
  public setDateTime(date: Date): this {
    this._ensureAlive();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'setDateTime 需要合法 Date', {});
    }
    this._dateTime = new Date(date.getTime());
    return this;
  }

  /**
   * 获取仿真时间。
   *
   * @returns Date 副本
   */
  public getDateTime(): Date {
    this._ensureAlive();
    return new Date(this._dateTime.getTime());
  }

  /**
   * 设置时间倍速。
   *
   * @param multiplier - 倍速
   * @returns this
   */
  public setClockMultiplier(multiplier: number): this {
    this._ensureAlive();
    if (!Number.isFinite(multiplier)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'clockMultiplier 非法', { multiplier });
    }
    this._clockMultiplier = multiplier;
    return this;
  }

  /**
   * 地理坐标转屏幕坐标（MVP：近似正射投影）。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @param alt - 高度（米）
   * @returns 像素坐标或 null
   */
  public cartographicToScreen(lon: number, lat: number, alt?: number): [number, number] | null {
    this._ensureAlive();
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return null;
    }
    // alt 参与真实引擎中的透视投影；MVP 占位中仅校验有限性
    if (alt !== undefined && !Number.isFinite(alt)) {
      return null;
    }
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (w <= 0 || h <= 0) {
      return null;
    }
    const x = ((lon + 180) / 360) * w;
    const y = (1 - (lat + 90) / 180) * h;
    return [x, y];
  }

  /**
   * 屏幕坐标转地理坐标（MVP：射线与椭球近似）。
   *
   * @param x - 像素 x
   * @param y - 像素 y
   * @returns [lon, lat, alt] 或 null
   */
  public screenToCartographic(x: number, y: number): [number, number, number] | null {
    this._ensureAlive();
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (w <= 0 || h <= 0) {
      return null;
    }
    const lon = (x / w) * 360 - 180;
    const lat = 90 - (y / h) * 180;
    return [lon, lat, 0];
  }

  /**
   * 过渡到 2D 视图。
   *
   * @param options - 动画时长
   * @returns this
   */
  public morphTo2D(options?: { duration?: number }): this {
    this._ensureAlive();
    this._viewMode = '2d';
    this._runMorph(options?.duration ?? 0);
    return this;
  }

  /**
   * 过渡到 2.5D 视图。
   *
   * @param options - 动画时长
   * @returns this
   */
  public morphTo25D(options?: { duration?: number }): this {
    this._ensureAlive();
    this._viewMode = '25d';
    this._runMorph(options?.duration ?? 0);
    return this;
  }

  /**
   * 过渡到 3D 视图。
   *
   * @param options - 动画时长
   * @returns this
   */
  public morphTo3D(options?: { duration?: number }): this {
    this._ensureAlive();
    this._viewMode = '3d';
    this._runMorph(options?.duration ?? 0);
    return this;
  }

  /**
   * 执行 morph 动画占位。
   *
   * @param durationMs - 毫秒
   */
  private _runMorph(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'morph duration 非法', { durationMs });
    }
    this._emit('morph-start', { type: 'morph-start', mode: this._viewMode });
    if (durationMs === 0) {
      this._emit('morph-end', { type: 'morph-end', mode: this._viewMode });
      return;
    }
    window.setTimeout(() => {
      if (!this._destroyed) {
        this._emit('morph-end', { type: 'morph-end', mode: this._viewMode });
      }
    }, durationMs);
  }

  /**
   * 当前视图模式。
   */
  public get currentViewMode(): '2d' | '25d' | '3d' {
    return this._viewMode;
  }

  /**
   * 注册事件。
   *
   * @param type - 事件名
   * @param callback - 回调
   * @returns this
   */
  public on(type: string, callback: (event: unknown) => void): this {
    this._ensureAlive();
    if (typeof callback !== 'function') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'on: callback 必须是函数', { type });
    }
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(callback);
    return this;
  }

  /**
   * 移除事件监听。
   *
   * @param type - 事件名
   * @param callback - 回调引用
   * @returns this
   */
  public off(type: string, callback: (event: unknown) => void): this {
    this._ensureAlive();
    if (typeof callback !== 'function') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'off: callback 必须是函数', { type });
    }
    this._listeners.get(type)?.delete(callback);
    return this;
  }

  /**
   * 返回主画布。
   *
   * @returns canvas
   */
  public getCanvas(): HTMLCanvasElement {
    this._ensureAlive();
    return this._canvas;
  }

  /**
   * 返回容器。
   */
  public getContainer(): HTMLElement {
    this._ensureAlive();
    return this._container;
  }

  /**
   * 根据容器调整画布大小。
   *
   * @returns this
   */
  public resize(): this {
    this._ensureAlive();
    this._resizeCanvas(2);
    this._emit('resize', { type: 'resize', target: this });
    return this;
  }

  /**
   * 销毁实例。
   */
  public remove(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    try {
      this._resizeObserver?.disconnect();
    } catch {
      // 忽略
    }
    this._resizeObserver = null;
    this._listeners.clear();
    this._canvas.remove();
  }

  /**
   * 相机逃生舱（占位）。
   */
  public get camera(): unknown {
    this._ensureAlive();
    return {
      kind: 'Globe3D.camera.stub',
      position: { ...this._cameraPosition },
      enableRotate: this._enableRotate,
      enableZoom: this._enableZoom,
      enableTilt: this._enableTilt,
    };
  }

  /**
   * 渲染器逃生舱（占位）。
   */
  public get renderer(): unknown {
    this._ensureAlive();
    return {
      kind: 'Globe3D.renderer.stub',
      atmosphere: this._atmosphere,
      shadows: this._shadows,
      skybox: this._skybox,
      fog: this._fog,
    };
  }

  /**
   * 确保未销毁。
   */
  private _ensureAlive(): void {
    if (this._destroyed) {
      throw new GeoForgeError(GeoForgeErrorCode.MAP_DESTROYED, 'Globe3D 已销毁', {});
    }
  }

  /**
   * 向监听器广播事件。
   *
   * @param type - 事件类型
   * @param payload - 负载
   */
  private _emit(type: string, payload: unknown): void {
    const set = this._listeners.get(type);
    if (!set) {
      return;
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          // eslint-disable-next-line no-console
          console.error('[Globe3D] listener error', err);
        }
      }
    }
  }
}
