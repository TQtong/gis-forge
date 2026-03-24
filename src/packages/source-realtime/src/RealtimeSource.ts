// ============================================================
// RealtimeSource.ts — WebSocket / SSE 实时数据源
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { GeoForgeErrorCodeType } from '../../core/src/infra/errors.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** 重连退避上限（毫秒） */
const MAX_RECONNECT_MS = 30_000;

/** 消息环形缓冲默认容量 */
const DEFAULT_BUFFER_CAP = 256;

/**
 * 实时源选项。
 */
export interface RealtimeSourceOptions {
  readonly url: string;
  readonly type: 'websocket' | 'sse';
  /** 载荷格式 */
  readonly format: 'geojson' | 'protobuf';
  /** 重连间隔（毫秒），指数退避上限见 {@link MAX_RECONNECT_MS} */
  readonly reconnectInterval?: number;
}

/**
 * 连接统计。
 */
export interface RealtimeStats {
  /** 已接收消息条数 */
  readonly messagesReceived: number;
  /** 错误次数 */
  readonly errors: number;
  /** 重连次数 */
  readonly reconnects: number;
  /** 当前缓冲条数 */
  readonly bufferSize: number;
}

/**
 * 实时数据源实例。
 *
 * @stability experimental
 */
export interface RealtimeSource {
  connect(): void;
  disconnect(): void;
  onMessage(handler: (payload: unknown) => void): void;
  onError(handler: (err: GeoForgeError) => void): void;
  isConnected(): boolean;
  getStats(): RealtimeStats;
}

/**
 * 解析 GeoJSON Feature / FeatureCollection 为 Feature[]。
 */
function parseGeoJSONFeaturesPayload(text: string): Feature[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'Realtime GeoJSON parse failed', {}, cause);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Realtime message not object', {});
  }
  const o = parsed as { type?: string; features?: Feature[] };
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
    return o.features;
  }
  if (o.type === 'Feature') {
    return [o as Feature];
  }
  throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Realtime GeoJSON must be Feature or FeatureCollection', {});
}

/**
 * 创建实时数据源。
 *
 * @param options - 连接与格式
 * @returns 数据源
 *
 * @stability experimental
 */
export function createRealtimeSource(options: RealtimeSourceOptions): RealtimeSource {
  if (!options.url) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'RealtimeSource requires url', {});
  }
  const baseReconnect = Math.max(200, Math.floor(options.reconnectInterval ?? 2000));
  let ws: WebSocket | null = null;
  let es: EventSource | null = null;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let messagesReceived = 0;
  let errors = 0;
  let reconnects = 0;
  const buffer: unknown[] = [];
  let messageHandler: ((p: unknown) => void) | null = null;
  let errorHandler: ((e: GeoForgeError) => void) | null = null;

  function emitError(code: GeoForgeErrorCodeType, message: string, context: Record<string, unknown>, cause?: Error): void {
    errors += 1;
    const err = new GeoForgeError(code, message, context, cause);
    if (errorHandler) {
      try {
        errorHandler(err);
      } catch {
        /* 用户回调异常不向外抛 */
      }
    } else if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[RealtimeSource]', err);
    }
  }

  function pushBuffer(item: unknown): void {
    buffer.push(item);
    if (buffer.length > DEFAULT_BUFFER_CAP) {
      buffer.splice(0, buffer.length - DEFAULT_BUFFER_CAP);
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) {
      return;
    }
    const delay = Math.min(MAX_RECONNECT_MS, baseReconnect * Math.pow(2, attempt));
    attempt += 1;
    reconnects += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startConnection();
    }, delay);
  }

  function handlePayload(raw: string): void {
    if (options.format === 'geojson') {
      try {
        const feats = parseGeoJSONFeaturesPayload(raw);
        messagesReceived += 1;
        pushBuffer(feats);
        if (messageHandler) {
          messageHandler(feats);
        }
      } catch (e) {
        if (e instanceof GeoForgeError) {
          emitError(e.code, e.message, { ...(e.context as object) }, e.cause);
        } else {
          const cause = e instanceof Error ? e : new Error(String(e));
          emitError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Realtime payload handling failed', {}, cause);
        }
      }
    } else {
      messagesReceived += 1;
      const stub = { format: 'protobuf', byteLength: raw.length };
      pushBuffer(stub);
      if (messageHandler) {
        messageHandler(stub);
      }
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[RealtimeSource] protobuf stub — decode not wired');
      }
    }
  }

  function startConnection(): void {
    if (options.type === 'websocket') {
      try {
        ws = new WebSocket(options.url);
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        emitError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'WebSocket construct failed', { url: options.url }, cause);
        scheduleReconnect();
        return;
      }
      ws.onopen = (): void => {
        connected = true;
        attempt = 0;
      };
      ws.onclose = (): void => {
        connected = false;
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = (): void => {
        emitError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'WebSocket error', { url: options.url });
      };
      ws.onmessage = (ev: MessageEvent): void => {
        if (typeof ev.data === 'string') {
          handlePayload(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          handlePayload(new TextDecoder().decode(ev.data));
        } else {
          emitError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Unsupported WebSocket message type', {});
        }
      };
    } else {
      try {
        es = new EventSource(options.url);
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        emitError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'EventSource construct failed', { url: options.url }, cause);
        scheduleReconnect();
        return;
      }
      es.onopen = (): void => {
        connected = true;
        attempt = 0;
      };
      es.onerror = (): void => {
        connected = false;
        errors += 1;
        if (es) {
          es.close();
          es = null;
        }
        scheduleReconnect();
      };
      es.onmessage = (ev: MessageEvent): void => {
        if (typeof ev.data === 'string') {
          handlePayload(ev.data);
        }
      };
    }
  }

  function disconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    attempt = 0;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
    connected = false;
  }

  return {
    connect(): void {
      disconnect();
      startConnection();
    },
    disconnect(): void {
      disconnect();
    },
    onMessage(handler: (payload: unknown) => void): void {
      messageHandler = handler;
    },
    onError(handler: (err: GeoForgeError) => void): void {
      errorHandler = handler;
    },
    isConnected(): boolean {
      return connected;
    },
    getStats(): RealtimeStats {
      return {
        messagesReceived,
        errors,
        reconnects,
        bufferSize: buffer.length,
      };
    },
  };
}

declare const __DEV__: boolean;
