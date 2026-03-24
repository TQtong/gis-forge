// ============================================================
// VideoLayer.ts — 视频纹理地理配准叠加图层（可选包 layer-video）
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/**
 * 地理角点：西南、东北 [lon, lat]。
 */
export type LonLatBounds = readonly [readonly [number, number], readonly [number, number]];

/**
 * 视频图层选项。
 */
export interface VideoLayerOptions {
  readonly id: string;
  readonly source: string;
  /** 视频地址 */
  readonly url: string;
  /** [[swLon, swLat], [neLon, neLat]] */
  readonly bounds: LonLatBounds;
  /** [0,1] */
  readonly opacity?: number;
  /** 是否循环 */
  readonly loop?: boolean;
  readonly zIndex?: number;
  readonly projection?: string;
}

/**
 * 视频图层实例。
 *
 * @stability experimental
 */
export interface VideoLayer extends Layer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setOpacity(a: number): void;
}

/**
 * 校验 bounds。
 */
function validateBounds(bounds: LonLatBounds): void {
  const sw = bounds[0];
  const ne = bounds[1];
  if (!sw || !ne || sw.length < 2 || ne.length < 2) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'bounds must be [[sw],[ne]] with lon/lat', {});
  }
  if (sw[0] >= ne[0] || sw[1] >= ne[1]) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'bounds require sw west/south < ne east/north', {
      sw,
      ne,
    });
  }
}

/**
 * 创建视频叠加图层。
 *
 * @param options - 视频 URL 与地理范围
 * @returns 图层实例
 *
 * @stability experimental
 */
export function createVideoLayer(options: VideoLayerOptions): VideoLayer {
  if (!options.id || !options.source || !options.url) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'VideoLayer requires id, source, url', {});
  }
  validateBounds(options.bounds);
  const loop = options.loop !== false;
  let opacity = options.opacity ?? 1;
  if (opacity < 0 || opacity > 1 || Number.isNaN(opacity)) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'opacity must be in [0,1]', { opacity });
  }
  const projection = options.projection ?? 'mercator';

  let video: HTMLVideoElement | null = null;
  let objectUrl: string | null = null;

  const layer: VideoLayer = {
    id: options.id,
    type: 'video',
    source: options.source,
    projection,
    visible: true,
    opacity,
    zIndex: options.zIndex ?? 0,
    isLoaded: false,
    isTransparent: true,
    renderOrder: options.zIndex ?? 0,

    onAdd(): void {
      try {
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.playsInline = true;
        el.muted = true;
        el.loop = loop;
        el.preload = 'auto';
        el.src = options.url;
        video = el;
        const onReady = (): void => {
          (layer as { isLoaded: boolean }).isLoaded = true;
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.debug('[VideoLayer] video metadata ready', { duration: el.duration });
          }
        };
        const onErr = (): void => {
          (layer as { isLoaded: boolean }).isLoaded = false;
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.warn('[VideoLayer] video error', el.error);
          }
        };
        el.addEventListener('loadeddata', onReady, { once: true });
        el.addEventListener('error', onErr, { once: true });
        void el.load();
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        throw new GeoForgeError(GeoForgeErrorCode.EXTENSION_INIT_FAILED, 'VideoLayer failed to create video element', { id: options.id }, cause);
      }
    },

    onRemove(): void {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video = null;
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      (layer as { isLoaded: boolean }).isLoaded = false;
    },

    onUpdate(_deltaTime: number, _camera: CameraState): void {
      /* 解码由浏览器完成；GPU 上传在 encode 中 */
    },

    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (!video || !layer.isLoaded) {
        return;
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[VideoLayer] encode stub — GPUExternalTexture path not wired', {
          opacity: layer.opacity,
          bounds: options.bounds,
        });
      }
    },

    setPaintProperty(name: string, value: unknown): void {
      if (name === 'raster-opacity') {
        const a = Number(value);
        if (Number.isFinite(a)) {
          layer.setOpacity(a);
        }
      }
    },
    setLayoutProperty(_name: string, _value: unknown): void {},
    getPaintProperty(name: string): unknown {
      if (name === 'raster-opacity') {
        return layer.opacity;
      }
      return undefined;
    },
    getLayoutProperty(_name: string): unknown {
      return undefined;
    },

    play(): void {
      if (!video) {
        throw new GeoForgeError(GeoForgeErrorCode.EXTENSION_INIT_FAILED, 'VideoLayer.play: no video', { id: options.id });
      }
      void video.play().catch((e) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[VideoLayer] play failed', e);
        }
      });
    },
    pause(): void {
      video?.pause();
    },
    seek(seconds: number): void {
      if (!video) {
        throw new GeoForgeError(GeoForgeErrorCode.EXTENSION_INIT_FAILED, 'VideoLayer.seek: no video', { id: options.id });
      }
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'seek requires non-negative finite seconds', { seconds });
      }
      try {
        video.currentTime = seconds;
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        throw new GeoForgeError(GeoForgeErrorCode.EXTENSION_RENDER_FAILED, 'VideoLayer.seek failed', { seconds }, cause);
      }
    },
    setOpacity(a: number): void {
      if (!Number.isFinite(a) || a < 0 || a > 1) {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'setOpacity requires [0,1]', { a });
      }
      layer.opacity = a;
    },

    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },
  };

  return layer;
}

declare const __DEV__: boolean;
