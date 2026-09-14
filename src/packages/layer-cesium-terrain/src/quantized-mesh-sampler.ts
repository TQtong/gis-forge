import type { QuantizedMeshRaw } from './quantized-mesh-decoder.ts';
import { QM_COORD_RANGE } from './types.ts';

/** Spatially indexed triangle interpolation, without noisy heightfield hole filling. */
export class QuantizedMeshSampler {
  private readonly bins: number[][] = Array.from({ length: 32 * 32 }, () => []);
  readonly byteSize: number;
  private readonly raw: QuantizedMeshRaw;
  constructor(raw: QuantizedMeshRaw) {
    this.raw = raw;
    const { uArray: u, vArray: v, triangleIndices: indices } = raw;
    let count = 0;
    const bin = (q: number) => Math.max(0, Math.min(31, Math.floor(q / QM_COORD_RANGE * 32)));
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const x0 = bin(Math.min(u[a], u[b], u[c])), x1 = bin(Math.max(u[a], u[b], u[c]));
      const y0 = bin(Math.min(v[a], v[b], v[c])), y1 = bin(Math.max(v[a], v[b], v[c]));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        this.bins[y * 32 + x].push(i); count++;
      }
    }
    this.byteSize = u.byteLength * 3 + indices.byteLength + count * 8 + 32768;
  }
  sample(u: number, v: number): number | null {
    if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) { return null; }
    u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1, v));
    const px = u * QM_COORD_RANGE, py = v * QM_COORD_RANGE;
    const { uArray: xs, vArray: ys, hArray: heights, triangleIndices: indices, header } = this.raw;
    for (const i of this.bins[Math.min(31, Math.floor(v * 32)) * 32 + Math.min(31, Math.floor(u * 32))]) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const denominator = (ys[b] - ys[c]) * (xs[a] - xs[c]) + (xs[c] - xs[b]) * (ys[a] - ys[c]);
      if (Math.abs(denominator) < 1e-10) { continue; }
      const wa = ((ys[b] - ys[c]) * (px - xs[c]) + (xs[c] - xs[b]) * (py - ys[c])) / denominator;
      const wb = ((ys[c] - ys[a]) * (px - xs[c]) + (xs[a] - xs[c]) * (py - ys[c])) / denominator;
      const wc = 1 - wa - wb;
      if (wa >= -1e-6 && wb >= -1e-6 && wc >= -1e-6) {
        return header.minimumHeight + (wa * heights[a] + wb * heights[b] + wc * heights[c]) / QM_COORD_RANGE * (header.maximumHeight - header.minimumHeight);
      }
    }
    return null;
  }
}
