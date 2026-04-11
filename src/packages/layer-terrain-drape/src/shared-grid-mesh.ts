// ============================================================
// shared-grid-mesh.ts — Singleton 128×128 grid mesh
//
// 所有瓦片共享同一份 VBO + IBO。每个顶点只有 (u, v) ∈ [0,1]²，
// vertex shader 根据 TileUniforms.bboxZ0 将 UV 插值到世界坐标。
//
// 内存：16641 vertices × 8 bytes = 133 KB（一次性分配）
//       98304 indices × 2 bytes = 192 KB（Uint16 足够）
// ============================================================

import { GRID_N, GRID_VERTS, GRID_INDICES } from './types.ts';

export interface SharedGridMesh {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
}

/**
 * 创建全局共享的 grid mesh（只调用一次）。
 *
 * 顶点布局：float32x2 (u, v)，arrayStride = 8 bytes
 * 索引：uint16（16641 < 65535）
 * 三角形：(i,j)→(i+1,j)→(i,j+1) + (i+1,j)→(i+1,j+1)→(i,j+1)
 */
export function createSharedGridMesh(device: GPUDevice): SharedGridMesh {
  const N = GRID_N;
  const vertsPerSide = N + 1;

  // ── 顶点数据：(u, v) ∈ [0, 1] ──
  const vertData = new Float32Array(GRID_VERTS * 2);
  for (let j = 0; j < vertsPerSide; j++) {
    for (let i = 0; i < vertsPerSide; i++) {
      const idx = j * vertsPerSide + i;
      vertData[idx * 2 + 0] = i / N;
      vertData[idx * 2 + 1] = j / N;
    }
  }

  const vertexBuffer = device.createBuffer({
    size: vertData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertData);

  // ── 索引数据 ──
  const idxData = new Uint16Array(GRID_INDICES);
  let w = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * vertsPerSide + i;
      const b = j * vertsPerSide + (i + 1);
      const c = (j + 1) * vertsPerSide + i;
      const d = (j + 1) * vertsPerSide + (i + 1);
      idxData[w++] = a;
      idxData[w++] = c;
      idxData[w++] = b;
      idxData[w++] = b;
      idxData[w++] = c;
      idxData[w++] = d;
    }
  }

  // Uint16 byteLength 需要 4 字节对齐
  const paddedBytes = Math.ceil(idxData.byteLength / 4) * 4;
  const indexBuffer = device.createBuffer({
    size: paddedBytes,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  if (idxData.byteLength !== paddedBytes) {
    const padded = new Uint16Array(paddedBytes / 2);
    padded.set(idxData);
    device.queue.writeBuffer(indexBuffer, 0, padded);
  } else {
    device.queue.writeBuffer(indexBuffer, 0, idxData);
  }

  return {
    vertexBuffer,
    indexBuffer,
    indexCount: GRID_INDICES,
    indexFormat: 'uint16' as GPUIndexFormat,
  };
}
