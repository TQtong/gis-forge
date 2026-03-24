// ============================================================
// FlatGeobufLayer.ts — FlatGeobuf 随机访问图层（可选包 layer-flatgeobuf）
// 说明：无 npm 依赖；二进制路径对齐 flatgeobuf 参考实现（魔数 + size 前缀 Header + 可选 Hilbert 索引 + Feature）。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Geometry } from '../../core/src/types/geometry.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** 与 flatgeobuf `constants.ts` 一致的魔数字节（规范版本字节末位可为 0） */
const FGB_MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);

/** FlatBuffers size 前缀长度（uint32） */
const SIZE_PREFIX_LEN = 4;

/** Packed Hilbert R-Tree 节点项字节数（与 flatgeobuf packedrtree 一致） */
const NODE_ITEM_BYTE_LEN = 40;

/** 单次下载上限（字节），防止 OOM */
const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024;

/** 默认最大要素数 */
const DEFAULT_MAX_FEATURES = 50_000;

/**
 * FlatGeobuf 图层选项。
 */
export interface FlatGeobufLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  /** 可选空间过滤（地理坐标，与数据 CRS 一致；未变换） */
  readonly bbox?: BBox2D;
  readonly maxFeatures?: number;
  readonly zIndex?: number;
  readonly projection?: string;
}

/**
 * FlatGeobuf 图层实例。
 *
 * @stability experimental
 */
export interface FlatGeobufLayer extends Layer {
  setFilter(bbox: BBox2D | null): void;
  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];
}

/**
 * HTTP Range 读取字节区间（含端点）。
 */
export async function fetchByteRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'fetchByteRange invalid range', { start, end, url });
  }
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: { Range: `bytes=${start}-${end}` },
      mode: 'cors',
    });
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'fetchByteRange network error', { url, start, end }, cause);
  }
  if (res.status !== 206 && res.status !== 200) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, `fetchByteRange HTTP ${res.status}`, {
      url,
      status: res.status,
    });
  }
  try {
    return await res.arrayBuffer();
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'fetchByteRange read body failed', { url }, cause);
  }
}

/**
 * 计算可选空间索引区大小（Packed Hilbert R-Tree）。
 * 来源：flatgeobuf `packedrtree.ts` `calcTreeSize`。
 */
function calcTreeSize(numItems: number, nodeSize: number): number {
  const ns = Math.min(Math.max(nodeSize, 2), 65535);
  let n = numItems;
  let numNodes = n;
  let nn = n;
  do {
    nn = Math.ceil(nn / ns);
    numNodes += nn;
  } while (nn !== 1);
  return numNodes * NODE_ITEM_BYTE_LEN;
}

function isFlatGeobufMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === FGB_MAGIC[0] && bytes[1] === FGB_MAGIC[1] && bytes[2] === FGB_MAGIC[2];
}

function isProbablyJson(bytes: Uint8Array): boolean {
  const c = bytes[0];
  return c === 0x7b || c === 0x5b;
}

/**
 * 读取 FlatBuffers 表字段相对偏移（fieldId 为 schema 声明顺序，从 0 起）。
 */
function getTableFieldOffset(dv: DataView, tableStart: number, fieldId: number): number {
  const vtable = tableStart - dv.getInt32(tableStart, true);
  const vtableSize = dv.getUint16(vtable, true);
  const slot = 4 + fieldId * 2;
  if (slot + 2 > vtableSize) {
    return 0;
  }
  return dv.getUint16(vtable + slot, true);
}

/**
 * 读取 uoffset_t 指向的 double 向量 → number[]。
 */
function readVectorDouble(dv: DataView, tableStart: number, fieldId: number): number[] | null {
  const rel = getTableFieldOffset(dv, tableStart, fieldId);
  if (rel === 0) {
    return null;
  }
  const ptr = tableStart + rel;
  const vecRel = dv.getUint32(ptr, true);
  const vecStart = ptr + vecRel;
  const len = dv.getUint32(vecStart, true);
  const dataStart = vecStart + 4;
  if (len <= 0 || dataStart + len * 8 > dv.byteLength) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(dv.getFloat64(dataStart + i * 8, true));
  }
  return out;
}

/**
 * 读取 FlatGeobuf Geometry 表（xy 平铺 + GeometryType）→ GeoJSON Geometry。
 * GeometryType 与 WKB 枚举对齐：1 Point，2 LineString，3 Polygon。
 */
function geometryTableToGeoJSON(dv: DataView, geomTableStart: number): Geometry | null {
  const xy = readVectorDouble(dv, geomTableStart, 1);
  const typeRel = getTableFieldOffset(dv, geomTableStart, 6);
  let geomType = 0;
  if (typeRel !== 0) {
    geomType = dv.getUint8(geomTableStart + typeRel);
  }
  if (!xy || xy.length < 2) {
    return null;
  }
  const t = geomType !== 0 ? geomType : xy.length === 2 ? 1 : 2;
  if (t === 1) {
    return { type: 'Point', coordinates: [xy[0], xy[1]] };
  }
  if (t === 2) {
    const coords: [number, number][] = [];
    for (let i = 0; i + 1 < xy.length; i += 2) {
      coords.push([xy[i], xy[i + 1]]);
    }
    if (coords.length < 2) {
      return null;
    }
    return { type: 'LineString', coordinates: coords };
  }
  if (t === 3) {
    const endsRel = getTableFieldOffset(dv, geomTableStart, 0);
    if (endsRel === 0) {
      const coords: [number, number][][] = [];
      const ring: [number, number][] = [];
      for (let i = 0; i + 1 < xy.length; i += 2) {
        ring.push([xy[i], xy[i + 1]]);
      }
      if (ring.length < 4) {
        return null;
      }
      coords.push(ring);
      return { type: 'Polygon', coordinates: coords };
    }
    const endsPtr = geomTableStart + endsRel;
    const endsVecRel = dv.getUint32(endsPtr, true);
    const endsStart = endsPtr + endsVecRel;
    const numEnds = dv.getUint32(endsStart, true);
    const rings: [number, number][][] = [];
    let flatStart = 0;
    for (let r = 0; r < numEnds; r++) {
      const flatEnd = dv.getUint32(endsStart + 4 + r * 4, true);
      const ring: [number, number][] = [];
      for (let i = flatStart; i + 1 < flatEnd && i + 1 < xy.length; i += 2) {
        ring.push([xy[i], xy[i + 1]]);
      }
      flatStart = flatEnd;
      if (ring.length >= 4) {
        rings.push(ring);
      }
    }
    if (rings.length === 0) {
      return null;
    }
    return { type: 'Polygon', coordinates: rings };
  }
  return null;
}

/**
 * 从 size-prefixed Feature FlatBuffer 解析 GeoJSON Geometry。
 */
function parseFeatureToGeometry(featureBytes: ArrayBuffer): Geometry | null {
  if (featureBytes.byteLength < 8) {
    return null;
  }
  const dv = new DataView(featureBytes);
  const rootOffset = dv.getUint32(4, true);
  const featureTable = 4 + rootOffset;
  const geomRel = getTableFieldOffset(dv, featureTable, 0);
  if (geomRel === 0) {
    return null;
  }
  const gPtr = featureTable + geomRel;
  const gOff = dv.getUint32(gPtr, true);
  const geomTableStart = gPtr + gOff;
  return geometryTableToGeoJSON(dv, geomTableStart);
}

/**
 * 从 Header size-prefixed 块读取 features_count 与 index_node_size（失败时返回安全默认值）。
 * Header 从文件偏移 8 开始（紧随魔数）。
 */
function readHeaderCounts(dv: DataView, buffer: ArrayBuffer): { featuresCount: number; indexNodeSize: number } {
  try {
    if (buffer.byteLength < 8 + 8) {
      return { featuresCount: 0, indexNodeSize: 0 };
    }
    const headerRootOffset = dv.getUint32(8 + 4, true);
    const tableStart = 8 + headerRootOffset;
    const fcRel = getTableFieldOffset(dv, tableStart, 8);
    const ixRel = getTableFieldOffset(dv, tableStart, 9);
    let featuresCount = 0;
    if (fcRel !== 0) {
      const p = tableStart + fcRel;
      featuresCount = Number(dv.getBigUint64(p, true));
    }
    let indexNodeSize = 0;
    if (ixRel !== 0) {
      indexNodeSize = dv.getUint16(tableStart + ixRel, true);
    }
    return { featuresCount, indexNodeSize };
  } catch {
    return { featuresCount: 0, indexNodeSize: 0 };
  }
}

/**
 * 解析二进制 FlatGeobuf（对齐 flatgeobuf `deserialize` 偏移公式）。
 */
function parseBinaryFlatGeobuf(buffer: ArrayBuffer, maxFeatures: number, bbox: BBox2D | null): Feature[] {
  const u8 = new Uint8Array(buffer);
  if (u8.length < FGB_MAGIC.length + 8) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'FlatGeobuf buffer too small', {});
  }
  if (!isFlatGeobufMagic(u8)) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'FlatGeobuf magic mismatch', {});
  }
  const dv = new DataView(buffer);
  const headerLength = dv.getUint32(8, true);
  if (headerLength <= 0 || 8 + SIZE_PREFIX_LEN + headerLength > u8.length) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'FlatGeobuf invalid header length', { headerLength });
  }
  const { featuresCount, indexNodeSize } = readHeaderCounts(dv, buffer);
  let pos = FGB_MAGIC.length + SIZE_PREFIX_LEN + headerLength;
  if (indexNodeSize > 0 && featuresCount > 0) {
    pos += calcTreeSize(featuresCount, indexNodeSize);
  }
  const out: Feature[] = [];
  let fid = 0;
  while (pos + 4 <= u8.length && out.length < maxFeatures) {
    const featureLength = dv.getUint32(pos, true);
    if (featureLength <= 0 || pos + SIZE_PREFIX_LEN + featureLength > u8.length) {
      break;
    }
    const slice = buffer.slice(pos, pos + SIZE_PREFIX_LEN + featureLength);
    pos += SIZE_PREFIX_LEN + featureLength;
    const geom = parseFeatureToGeometry(slice);
    if (!geom) {
      fid += 1;
      continue;
    }
    if (bbox) {
      const g = geom;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      if (g.type === 'Point') {
        const [x, y] = g.coordinates;
        minX = maxX = x;
        minY = maxY = y;
      } else if (g.type === 'LineString') {
        for (const c of g.coordinates) {
          minX = Math.min(minX, c[0]);
          maxX = Math.max(maxX, c[0]);
          minY = Math.min(minY, c[1]);
          maxY = Math.max(maxY, c[1]);
        }
      } else if (g.type === 'Polygon') {
        for (const ring of g.coordinates) {
          for (const c of ring) {
            minX = Math.min(minX, c[0]);
            maxX = Math.max(maxX, c[0]);
            minY = Math.min(minY, c[1]);
            maxY = Math.max(maxY, c[1]);
          }
        }
      }
      if (maxX < bbox.west || minX > bbox.east || maxY < bbox.south || minY > bbox.north) {
        fid += 1;
        continue;
      }
    }
    out.push({
      type: 'Feature',
      id: fid,
      geometry: geom,
      properties: {},
    });
    fid += 1;
  }
  return out;
}

function parseGeoJSONFeatures(text: string, maxFeatures: number): Feature[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'GeoJSON parse failed', {}, cause);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'GeoJSON root must be object', {});
  }
  const o = parsed as { type?: string; features?: Feature[] };
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
    return o.features.slice(0, maxFeatures);
  }
  if (o.type === 'Feature') {
    return [o as Feature];
  }
  throw new GeoForgeError(GeoForgeErrorCode.GEOJSON_PARSE_FAILED, 'Expected FeatureCollection or Feature', {});
}

/**
 * 创建 FlatGeobuf 图层。
 *
 * @param options - URL 与过滤
 * @returns 图层实例
 *
 * @stability experimental
 */
export function createFlatGeobufLayer(options: FlatGeobufLayerOptions): FlatGeobufLayer {
  if (!options.id || !options.source || !options.url) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'FlatGeobufLayer requires id, source, url', {});
  }
  const maxFeatures = Math.max(1, Math.floor(options.maxFeatures ?? DEFAULT_MAX_FEATURES));
  let filterBbox: BBox2D | null = options.bbox ?? null;
  const projection = options.projection ?? 'mercator';

  let cached: Feature[] = [];
  let loaded = false;
  let abort: AbortController | null = null;

  async function reload(): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    let buf: ArrayBuffer;
    try {
      const head = await fetchByteRange(options.url, 0, Math.min(15, MAX_DOWNLOAD_BYTES - 1), signal);
      const peek = new Uint8Array(head);
      if (isProbablyJson(peek)) {
        const res = await fetch(options.url, { signal, mode: 'cors' });
        if (!res.ok) {
          throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, `FlatGeobuf HTTP ${res.status}`, { url: options.url });
        }
        const text = await res.text();
        cached = parseGeoJSONFeatures(text, maxFeatures);
      } else {
        const res = await fetch(options.url, { signal, mode: 'cors' });
        if (!res.ok) {
          throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, `FlatGeobuf HTTP ${res.status}`, { url: options.url });
        }
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > MAX_DOWNLOAD_BYTES) {
          throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'FlatGeobuf file exceeds MAX_DOWNLOAD_BYTES', {
            len,
            max: MAX_DOWNLOAD_BYTES,
          });
        }
        buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'FlatGeobuf buffer too large', {});
        }
        cached = parseBinaryFlatGeobuf(buf, maxFeatures, filterBbox);
      }
      loaded = true;
      (layer as { isLoaded: boolean }).isLoaded = true;
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[FlatGeobufLayer] loaded features', { count: cached.length });
      }
    } catch (e) {
      loaded = false;
      (layer as { isLoaded: boolean }).isLoaded = false;
      if (e instanceof GeoForgeError) {
        throw e;
      }
      const cause = e instanceof Error ? e : new Error(String(e));
      throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'FlatGeobuf reload failed', { url: options.url }, cause);
    }
  }

  const layer: FlatGeobufLayer = {
    id: options.id,
    type: 'flatgeobuf',
    source: options.source,
    projection,
    visible: true,
    opacity: 1,
    zIndex: options.zIndex ?? 0,
    isLoaded: false,
    isTransparent: false,
    renderOrder: options.zIndex ?? 0,

    onAdd(): void {
      void reload().catch((e) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[FlatGeobufLayer] onAdd load failed', e);
        }
      });
    },

    onRemove(): void {
      abort?.abort();
      abort = null;
      cached = [];
      loaded = false;
      (layer as { isLoaded: boolean }).isLoaded = false;
    },

    onUpdate(_deltaTime: number, _camera: CameraState): void {},

    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[FlatGeobufLayer] encode stub');
      }
    },

    setPaintProperty(_name: string, _value: unknown): void {},
    setLayoutProperty(_name: string, _value: unknown): void {},
    getPaintProperty(_name: string): unknown {
      return undefined;
    },
    getLayoutProperty(_name: string): unknown {
      return undefined;
    },

    setFilter(bbox: BBox2D | null): void {
      filterBbox = bbox;
      void reload().catch((e) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[FlatGeobufLayer] setFilter reload failed', e);
        }
      });
    },

    queryFeatures(bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      if (!loaded) {
        return [];
      }
      return cached.filter((f) => {
        const g = f.geometry;
        if (g.type === 'Point') {
          const [x, y] = g.coordinates;
          return x >= bbox.west && x <= bbox.east && y >= bbox.south && y <= bbox.north;
        }
        return true;
      });
    },
  };

  return layer;
}

declare const __DEV__: boolean;
