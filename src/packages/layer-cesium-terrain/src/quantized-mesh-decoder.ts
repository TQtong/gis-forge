// ============================================================
// quantized-mesh-decoder.ts — Cesium quantized-mesh 二进制格式解码器
//
// 规范：https://github.com/CesiumGS/quantized-mesh
//
// 字节布局（小端序）：
//   QuantizedMeshHeader (88 B)
//     centerX, centerY, centerZ           double
//     minimumHeight, maximumHeight        float
//     boundingSphereCenter (x,y,z)        double
//     boundingSphereRadius                double
//     horizonOcclusionPoint (x,y,z)       double
//   vertexCount                           uint32
//   uBuffer                               uint16 * vertexCount  (zigzag delta)
//   vBuffer                               uint16 * vertexCount  (zigzag delta)
//   heightBuffer                          uint16 * vertexCount  (zigzag delta)
//   --- 索引 ---
//   [对齐到 triangleCount 对应的 2/4 字节] triangleCount uint32
//   indices                               uint16 * (triangleCount*3)
//                                         or uint32 if vertexCount > 65536
//                                         以 high-water-mark 编码
//   --- 边缘索引（4 段） ---
//   westVertexCount uint32; westIndices
//   southVertexCount uint32; southIndices
//   eastVertexCount uint32; eastIndices
//   northVertexCount uint32; northIndices
//   --- 可选扩展块（循环） ---
//   extensionId uint8; extensionLength uint32; extensionData byte[length]
//
// ============================================================

import {
  QM_COORD_RANGE,
  QM_EXT_METADATA,
  QM_EXT_OCT_VERTEX_NORMALS,
  QM_EXT_WATER_MASK,
} from './types.ts';

/** 解析结果（纯几何，尚未重投影到屏幕像素） */
export interface QuantizedMeshRaw {
  /** 88 字节 header */
  readonly header: QuantizedMeshHeader;
  /** 顶点数 */
  readonly vertexCount: number;
  /** 每顶点的 u，范围 [0, 32767] */
  readonly uArray: Uint16Array;
  /** 每顶点的 v，范围 [0, 32767] */
  readonly vArray: Uint16Array;
  /** 每顶点的高度，范围 [0, 32767]，代表 heightRange 内的比例 */
  readonly hArray: Uint16Array;
  /** 三角形索引 */
  readonly triangleIndices: Uint16Array | Uint32Array;
  /** 西/南/东/北 边缘顶点索引（用于 skirt 生成） */
  readonly westIndices: Uint16Array | Uint32Array;
  readonly southIndices: Uint16Array | Uint32Array;
  readonly eastIndices: Uint16Array | Uint32Array;
  readonly northIndices: Uint16Array | Uint32Array;
  /** 可选：Oct 编码法线，每顶点 2 字节 */
  readonly octNormals: Uint8Array | null;
  /** 可选：水体遮罩原始字节 */
  readonly waterMask: Uint8Array | null;
  /** 可选：元数据 JSON 字符串 */
  readonly metadata: string | null;
}

export interface QuantizedMeshHeader {
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly boundingSphereCenter: readonly [number, number, number];
  readonly boundingSphereRadius: number;
  readonly horizonOcclusionPoint: readonly [number, number, number];
}

/** 解码入口 */
export function decodeQuantizedMesh(buffer: ArrayBuffer): QuantizedMeshRaw {
  if (buffer.byteLength < 92) {
    throw new Error(
      `[TERRAIN_DECODE_FAILED] quantized-mesh buffer too small: ${buffer.byteLength}`,
    );
  }

  const view = new DataView(buffer);
  let offset = 0;
  const littleEndian = true;

  // ═══ Header (88 bytes) ═══
  const centerX = view.getFloat64(offset, littleEndian); offset += 8;
  const centerY = view.getFloat64(offset, littleEndian); offset += 8;
  const centerZ = view.getFloat64(offset, littleEndian); offset += 8;
  const minimumHeight = view.getFloat32(offset, littleEndian); offset += 4;
  const maximumHeight = view.getFloat32(offset, littleEndian); offset += 4;
  const bsX = view.getFloat64(offset, littleEndian); offset += 8;
  const bsY = view.getFloat64(offset, littleEndian); offset += 8;
  const bsZ = view.getFloat64(offset, littleEndian); offset += 8;
  const bsR = view.getFloat64(offset, littleEndian); offset += 8;
  const hopX = view.getFloat64(offset, littleEndian); offset += 8;
  const hopY = view.getFloat64(offset, littleEndian); offset += 8;
  const hopZ = view.getFloat64(offset, littleEndian); offset += 8;

  const header: QuantizedMeshHeader = {
    centerX, centerY, centerZ,
    minimumHeight, maximumHeight,
    boundingSphereCenter: [bsX, bsY, bsZ],
    boundingSphereRadius: bsR,
    horizonOcclusionPoint: [hopX, hopY, hopZ],
  };

  // ═══ Vertex data ═══
  const vertexCount = view.getUint32(offset, littleEndian); offset += 4;
  if (vertexCount === 0 || vertexCount > 5_000_000) {
    throw new Error(`[TERRAIN_DECODE_FAILED] invalid vertexCount ${vertexCount}`);
  }

  // zigzag accumulator
  const uArray = new Uint16Array(vertexCount);
  const vArray = new Uint16Array(vertexCount);
  const hArray = new Uint16Array(vertexCount);

  let u = 0, v = 0, h = 0;
  for (let i = 0; i < vertexCount; i++) {
    u = (u + zigzagDecode(view.getUint16(offset, littleEndian))) & 0x7fff;
    uArray[i] = u;
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    v = (v + zigzagDecode(view.getUint16(offset, littleEndian))) & 0x7fff;
    vArray[i] = v;
    offset += 2;
  }
  for (let i = 0; i < vertexCount; i++) {
    h = (h + zigzagDecode(view.getUint16(offset, littleEndian))) & 0x7fff;
    hArray[i] = h;
    offset += 2;
  }

  // ═══ Triangle indices ═══
  // 索引数据按 2 或 4 字节对齐
  const use32 = vertexCount > 65536;
  const bytesPerIndex = use32 ? 4 : 2;
  // padding 到对应对齐
  if (offset % bytesPerIndex !== 0) {
    offset += bytesPerIndex - (offset % bytesPerIndex);
  }

  const triangleCount = view.getUint32(offset, littleEndian); offset += 4;
  const indexBytes = triangleCount * 3 * bytesPerIndex;
  if (offset + indexBytes > buffer.byteLength) {
    throw new Error(
      `[TERRAIN_DECODE_FAILED] triangle indices overflow (need ${indexBytes} bytes)`,
    );
  }

  const triangleIndices = decodeHighWaterMark(
    view, offset, triangleCount * 3, use32, littleEndian,
  );
  offset += indexBytes;

  // ═══ Edge indices ═══
  const westCount = view.getUint32(offset, littleEndian); offset += 4;
  const westIndices = readIndices(view, offset, westCount, use32, littleEndian);
  offset += westCount * bytesPerIndex;

  const southCount = view.getUint32(offset, littleEndian); offset += 4;
  const southIndices = readIndices(view, offset, southCount, use32, littleEndian);
  offset += southCount * bytesPerIndex;

  const eastCount = view.getUint32(offset, littleEndian); offset += 4;
  const eastIndices = readIndices(view, offset, eastCount, use32, littleEndian);
  offset += eastCount * bytesPerIndex;

  const northCount = view.getUint32(offset, littleEndian); offset += 4;
  const northIndices = readIndices(view, offset, northCount, use32, littleEndian);
  offset += northCount * bytesPerIndex;

  // ═══ Extensions ═══
  let octNormals: Uint8Array | null = null;
  let waterMask: Uint8Array | null = null;
  let metadata: string | null = null;

  while (offset + 5 <= buffer.byteLength) {
    const extId = view.getUint8(offset); offset += 1;
    const extLen = view.getUint32(offset, littleEndian); offset += 4;
    if (offset + extLen > buffer.byteLength) {
      // 损坏扩展——静默忽略
      break;
    }
    const slice = new Uint8Array(buffer, offset, extLen);

    if (extId === QM_EXT_OCT_VERTEX_NORMALS && extLen === vertexCount * 2) {
      octNormals = new Uint8Array(slice); // copy
    } else if (extId === QM_EXT_WATER_MASK) {
      waterMask = new Uint8Array(slice);
    } else if (extId === QM_EXT_METADATA) {
      // metadata 扩展格式：uint32 jsonLength; utf-8 bytes
      if (extLen >= 4) {
        const jlen = view.getUint32(offset, littleEndian);
        if (jlen + 4 <= extLen) {
          const jbytes = new Uint8Array(buffer, offset + 4, jlen);
          metadata = new TextDecoder('utf-8').decode(jbytes);
        }
      }
    }
    offset += extLen;
  }

  return {
    header,
    vertexCount,
    uArray, vArray, hArray,
    triangleIndices,
    westIndices, southIndices, eastIndices, northIndices,
    octNormals,
    waterMask,
    metadata,
  };
}

/** zigzag 编码解码：见 Cesium spec "decodeZigZag" */
function zigzagDecode(value: number): number {
  return (value >> 1) ^ -(value & 1);
}

/**
 * high-water-mark 索引解码。
 * 按 spec：highest 初始为 0；对每个 code：index = highest - code；若 code === 0 则 ++highest。
 */
function decodeHighWaterMark(
  view: DataView,
  byteOffset: number,
  count: number,
  use32: boolean,
  littleEndian: boolean,
): Uint16Array | Uint32Array {
  const out: Uint16Array | Uint32Array = use32
    ? new Uint32Array(count)
    : new Uint16Array(count);
  let highest = 0;
  const step = use32 ? 4 : 2;
  for (let i = 0; i < count; i++) {
    const code = use32
      ? view.getUint32(byteOffset + i * step, littleEndian)
      : view.getUint16(byteOffset + i * step, littleEndian);
    const index = highest - code;
    out[i] = index;
    if (code === 0) {
      highest++;
    }
  }
  return out;
}

function readIndices(
  view: DataView,
  byteOffset: number,
  count: number,
  use32: boolean,
  littleEndian: boolean,
): Uint16Array | Uint32Array {
  if (count === 0) {
    return use32 ? new Uint32Array(0) : new Uint16Array(0);
  }
  const out: Uint16Array | Uint32Array = use32
    ? new Uint32Array(count)
    : new Uint16Array(count);
  const step = use32 ? 4 : 2;
  for (let i = 0; i < count; i++) {
    out[i] = use32
      ? view.getUint32(byteOffset + i * step, littleEndian)
      : view.getUint16(byteOffset + i * step, littleEndian);
  }
  return out;
}

/** Oct-编码 uint8x2 → 单位向量 vec3 */
export function octDecodeNormal(x: number, y: number, outXYZ: Float32Array, outOffset: number): void {
  // 将 [0,255] → [-1,1]
  let fx = (x / 255) * 2 - 1;
  let fy = (y / 255) * 2 - 1;
  let fz = 1 - (Math.abs(fx) + Math.abs(fy));
  if (fz < 0) {
    const oldX = fx;
    fx = (1 - Math.abs(fy)) * Math.sign(oldX || 1);
    fy = (1 - Math.abs(oldX)) * Math.sign(fy || 1);
  }
  const len = Math.hypot(fx, fy, fz);
  outXYZ[outOffset + 0] = fx / len;
  outXYZ[outOffset + 1] = fy / len;
  outXYZ[outOffset + 2] = fz / len;
}
