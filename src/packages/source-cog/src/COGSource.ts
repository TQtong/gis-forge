// ============================================================
// COGSource.ts — Cloud Optimized GeoTIFF 数据源（HTTP Range + TIFF IFD）
// 零 npm；仅实现 getTile/getMetadata/getBounds/destroy 所需的最小 TIFF 解析。
// ============================================================

import type { BBox2D } from '../../core/src/types/math-types.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** TIFF 标签常量（数值型） */
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_GEO_PIXEL_SCALE = 33550;
const TAG_GEO_TIEPOINTS = 33922;

/** 单次 Range 安全上限 */
const MAX_RANGE_BYTES = 16 * 1024 * 1024;

/**
 * COG 构造选项。
 */
export interface COGSourceOptions {
  /** GeoTIFF / COG URL */
  readonly url: string;
  /** 请求波段索引（1-based 与 TIFF 一致），默认 [1] */
  readonly bands?: readonly number[];
  /** NoData 覆盖（若元数据未提供） */
  readonly nodata?: number;
  /** 优先读取 overview（IFD 链），默认 true */
  readonly overview?: boolean;
}

/**
 * COG 栅格元数据（简化）。
 */
export interface COGMetadata {
  /** 图像宽（像素） */
  readonly width: number;
  /** 图像高（像素） */
  readonly height: number;
  /** 瓦片宽 */
  readonly tileWidth: number;
  /** 瓦片高 */
  readonly tileHeight: number;
  /** 地理变换系数（像素大小与原点，若能从 GeoTIFF 标签解析） */
  readonly pixelScale: readonly [number, number, number] | null;
}

/**
 * 瓦片负载（JPEG/Deflate 等压缩字节，由上层解码）。
 */
export interface COGTilePayload {
  /** 原始压缩字节 */
  readonly bytes: Uint8Array;
  /** 波段索引 */
  readonly band: number;
}

/**
 * COG 数据源实例。
 *
 * @stability experimental
 */
export interface COGSource {
  getTile(z: number, x: number, y: number): Promise<COGTilePayload | null>;
  getMetadata(): COGMetadata | null;
  getBounds(): BBox2D | null;
  destroy(): void;
}

interface IFDEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly valueOffset: number;
}

interface ParsedIFD {
  readonly entries: Map<number, IFDEntry>;
  readonly littleEndian: boolean;
  readonly nextIFD: number;
}

/**
 * HTTP Range 读取。
 */
async function httpRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (end - start > MAX_RANGE_BYTES) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'COG range exceeds MAX_RANGE_BYTES', { start, end });
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
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'COG fetch failed', { url }, cause);
  }
  if (res.status !== 206 && res.status !== 200) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, `COG HTTP ${res.status}`, { url });
  }
  return res.arrayBuffer();
}

function readUInt16(dv: DataView, o: number, le: boolean): number {
  return dv.getUint16(o, le);
}

function readUInt32(dv: DataView, o: number, le: boolean): number {
  return dv.getUint32(o, le);
}

/**
 * 解析单个 IFD（不含子 IFD 链遍历内容）。
 */
function parseIFD(buffer: ArrayBuffer, offset: number, littleEndian: boolean): ParsedIFD {
  const dv = new DataView(buffer);
  const num = readUInt16(dv, offset, littleEndian);
  const entries = new Map<number, IFDEntry>();
  let p = offset + 2;
  for (let i = 0; i < num; i++) {
    const tag = readUInt16(dv, p, littleEndian);
    const type = readUInt16(dv, p + 2, littleEndian);
    const count = readUInt32(dv, p + 4, littleEndian);
    const valueOffset = readUInt32(dv, p + 8, littleEndian);
    entries.set(tag, { tag, type, count, valueOffset });
    p += 12;
  }
  const nextIFD = readUInt32(dv, p, littleEndian);
  return { entries, littleEndian, nextIFD };
}

/**
 * 读取 IFD 标量（SHORT/LONG 可内联在 value 字段）。
 */
function getScalarUint32(entry: IFDEntry | undefined): number | null {
  if (!entry || entry.count !== 1) {
    return null;
  }
  if (entry.type === 3) {
    return entry.valueOffset & 0xffff;
  }
  if (entry.type === 4) {
    return entry.valueOffset >>> 0;
  }
  return null;
}

/**
 * 创建 COG 数据源。
 *
 * @param options - URL 与波段
 * @returns 数据源实例
 *
 * @stability experimental
 */
export function createCOGSource(options: COGSourceOptions): COGSource {
  if (!options.url) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'COGSource requires url', {});
  }
  const bands = options.bands ?? [1];
  const band = Math.max(1, Math.floor(bands[0] ?? 1));
  let aborted = false;
  let metaCache: COGMetadata | null = null;
  let boundsCache: BBox2D | null = null;
  let littleEndian = true;
  let tileOffsets: Uint32Array | null = null;
  let tileByteCounts: Uint32Array | null = null;
  let tilesX = 0;
  let tilesY = 0;

  async function ensureParsed(): Promise<void> {
    if (metaCache) {
      return;
    }
    const head = await httpRange(options.url, 0, 65535);
    const dv = new DataView(head);
    const bom = dv.getUint16(0, false);
    littleEndian = bom === 0x4949;
    const magic = dv.getUint16(2, littleEndian);
    if (magic !== 42) {
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Not a TIFF (magic != 42)', {});
    }
    const ifd0Offset = readUInt32(dv, 4, littleEndian);
    if (ifd0Offset + 2 > head.byteLength) {
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'IFD offset out of header window', { ifd0Offset });
    }
    const ifd = parseIFD(head, ifd0Offset, littleEndian);
    const w = getScalarUint32(ifd.entries.get(TAG_IMAGE_WIDTH));
    const h = getScalarUint32(ifd.entries.get(TAG_IMAGE_LENGTH));
    const tw = getScalarUint32(ifd.entries.get(TAG_TILE_WIDTH));
    const th = getScalarUint32(ifd.entries.get(TAG_TILE_LENGTH));
    if (!w || !h || !tw || !th) {
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'COG missing width/height/tile tags', {});
    }
    tilesX = Math.ceil(w / tw);
    tilesY = Math.ceil(h / th);
    const to = ifd.entries.get(TAG_TILE_OFFSETS);
    const tb = ifd.entries.get(TAG_TILE_BYTE_COUNTS);
    if (!to || !tb) {
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'COG missing tile offsets/byte counts', {});
    }
    const nTiles = tilesX * tilesY;
    const toff = new Uint32Array(nTiles);
    const tbc = new Uint32Array(nTiles);
    const readUint32ArrayFromFile = async (entry: IFDEntry, target: Uint32Array): Promise<void> => {
      if (entry.type !== 4 || entry.count !== nTiles) {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'Unexpected tile array type/count', {
          type: entry.type,
          count: entry.count,
          expected: nTiles,
        });
      }
      const byteLen = entry.count * 4;
      const start = entry.valueOffset;
      const end = start + byteLen - 1;
      const buf = await httpRange(options.url, start, end);
      const bdv = new DataView(buf);
      for (let i = 0; i < nTiles; i++) {
        target[i] = readUInt32(bdv, i * 4, littleEndian);
      }
    };
    try {
      await readUint32ArrayFromFile(to, toff);
      await readUint32ArrayFromFile(tb, tbc);
    } catch (e) {
      if (e instanceof GeoForgeError) {
        throw e;
      }
      const cause = e instanceof Error ? e : new Error(String(e));
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'COG tile table read failed', {}, cause);
    }
    tileOffsets = toff;
    tileByteCounts = tbc;
    let pixelScale: [number, number, number] | null = null;
    const ps = ifd.entries.get(TAG_GEO_PIXEL_SCALE);
    if (ps && ps.count >= 3 && ps.type === 12) {
      const base = ps.valueOffset;
      if (base + 24 <= head.byteLength) {
        pixelScale = [
          dv.getFloat64(base, littleEndian),
          dv.getFloat64(base + 8, littleEndian),
          dv.getFloat64(base + 16, littleEndian),
        ];
      } else {
        const psBuf = await httpRange(options.url, base, base + 24 - 1);
        const psDv = new DataView(psBuf);
        pixelScale = [
          psDv.getFloat64(0, littleEndian),
          psDv.getFloat64(8, littleEndian),
          psDv.getFloat64(16, littleEndian),
        ];
      }
    }
    metaCache = {
      width: w,
      height: h,
      tileWidth: tw,
      tileHeight: th,
      pixelScale,
    };
    const tp = ifd.entries.get(TAG_GEO_TIEPOINTS);
    if (tp && tp.count >= 6 && pixelScale) {
      const base = tp.valueOffset;
      let tpDv = dv;
      let tpBase = base;
      if (base + 40 > head.byteLength) {
        const tbuf = await httpRange(options.url, base, base + 48 - 1);
        tpDv = new DataView(tbuf);
        tpBase = 0;
      }
      const lon0 = tpDv.getFloat64(tpBase + 24, littleEndian);
      const lat0 = tpDv.getFloat64(tpBase + 32, littleEndian);
      const west = lon0;
      const north = lat0;
      const east = west + w * pixelScale[0];
      const south = north + h * -Math.abs(pixelScale[1]);
      boundsCache = { west, south, east, north };
    }
  }

  return {
    async getTile(z: number, x: number, y: number): Promise<COGTilePayload | null> {
      if (aborted) {
        return null;
      }
      if (z !== 0) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.debug('[COGSource] overview IFD not implemented; only z=0');
        }
        return null;
      }
      try {
        await ensureParsed();
      } catch (e) {
        if (e instanceof GeoForgeError) {
          throw e;
        }
        const cause = e instanceof Error ? e : new Error(String(e));
        throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, 'COG ensureParsed failed', {}, cause);
      }
      if (!metaCache || !tileOffsets || !tileByteCounts) {
        return null;
      }
      const tw = metaCache.tileWidth;
      const tx = x;
      const ty = y;
      if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) {
        return null;
      }
      const idx = ty * tilesX + tx;
      const off = tileOffsets[idx];
      const len = tileByteCounts[idx];
      if (len <= 0 || off < 0) {
        return null;
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await httpRange(options.url, off, off + len - 1);
      } catch (e) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[COGSource] tile range failed', e);
        }
        return null;
      }
      return { bytes: new Uint8Array(bytes), band };
    },

    getMetadata(): COGMetadata | null {
      return metaCache;
    },

    getBounds(): BBox2D | null {
      return boundsCache;
    },

    destroy(): void {
      aborted = true;
      metaCache = null;
      boundsCache = null;
      tileOffsets = null;
      tileByteCounts = null;
    },
  };
}

declare const __DEV__: boolean;
