import type { CameraState } from '../types/viewport.ts';
import type { TileCoord } from '../types/tile.ts';

export interface PerspectiveCoverOptions {
  scheme: 'mercator' | 'geographic';
  minZoom: number;
  maxZoom: number;
  maxTiles: number;
  viewportHeight: number;
  tilePixels?: number;
  minElevation?: number;
  maxElevation?: number;
  /** Last coverage for split/merge hysteresis. Geometry coverage is still recomputed. */
  previousTiles?: readonly TileCoord[];
  isAvailable?: (z: number, x: number, y: number) => boolean;
}

/** A budget limits refinement, never geographical coverage. Leaves do not overlap. */
export function computePerspectiveTileCover(camera: CameraState, options: PerspectiveCoverOptions): TileCoord[] {
  const world = 512 * 2 ** camera.zoom;
  const mercY = (lat: number): number => {
    const rad = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat)) * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * world;
  };
  const cx = (camera.center[0] + 180) / 360 * world;
  const cy = mercY(camera.center[1]);
  const ppm = world / (40075016.68557849 * Math.cos(camera.center[1] * Math.PI / 180));
  const minHeight = (options.minElevation ?? 0) * ppm;
  const maxHeight = (options.maxElevation ?? 0) * ppm;
  const view = camera.viewMatrix;
  const eye = [0, 1, 2].map(i => -(view[i * 4] * view[12] + view[i * 4 + 1] * view[13] + view[i * 4 + 2] * view[14]));
  const vp = camera.vpMatrix;
  const focal = options.viewportHeight / (2 * Math.tan(camera.fov / 2));
  const minZoom = Math.max(0, Math.floor(options.minZoom));
  const maxZoom = Math.max(minZoom, Math.floor(options.maxZoom));
  const roots = options.scheme === 'geographic' ? 2 : 1;
  const previouslySplit = new Set<string>();
  for (const tile of options.previousTiles ?? []) {
    for (let z = tile.z - 1; z >= 0; z--) {
      const scale = 2 ** (tile.z - z);
      previouslySplit.add(`${z}/${Math.floor(tile.x / scale)}/${Math.floor(tile.y / scale)}`);
    }
  }
  type Node = TileCoord & { priority: number; distance: number };
  const makeNode = (z: number, x: number, y: number): Node | null => {
    if (z >= minZoom && options.isAvailable && !options.isAvailable(z, x, y)) { return null; }
    const n = 2 ** z;
    const x0 = x / (n * roots) * world - cx;
    const x1 = (x + 1) / (n * roots) * world - cx;
    const y0 = options.scheme === 'geographic' ? mercY(-90 + (y + 1) / n * 180) - cy : y / n * world - cy;
    const y1 = options.scheme === 'geographic' ? mercY(-90 + y / n * 180) - cy : (y + 1) / n * world - cy;
    // Homogeneous AABB/frustum test, including reversed-Z near and far planes.
    let outside = 63;
    for (const px of [x0, x1]) for (const py of [y0, y1]) for (const pz of [minHeight, maxHeight]) {
      const clip = [0, 1, 2, 3].map(i => vp[i] * px + vp[4 + i] * py + vp[8 + i] * pz + vp[12 + i]);
      const [a, b, c, w] = clip;
      outside &= (a < -w ? 1 : 0) | (a > w ? 2 : 0) | (b < -w ? 4 : 0) | (b > w ? 8 : 0) | (c < 0 ? 16 : 0) | (c > w ? 32 : 0);
    }
    if (outside !== 0) { return null; }
    const dx = Math.max(x0 - eye[0], 0, eye[0] - x1);
    const dy = Math.max(y0 - eye[1], 0, eye[1] - y1);
    const ground = (camera.targetElevation ?? 0) * ppm;
    const distance = Math.max(1, Math.hypot(dx, dy, eye[2] - ground));
    const size = Math.max(x1 - x0, y1 - y0);
    // A node splits above 110% of the target size, but merges only below 90%.
    // At integer map zooms the center tile's error is exactly 1; float32 eye
    // reconstruction must not flip it between one parent and four children.
    const threshold = previouslySplit.has(`${z}/${x}/${y}`) ? 0.9 : 1.1;
    return { z, x, y, distance, priority: z < minZoom ? Infinity : size * focal / distance / (options.tilePixels ?? 512) / threshold };
  };
  const leaves: Node[] = [];
  for (let x = 0; x < roots; x++) {
    const node = makeNode(0, x, 0);
    if (node) { leaves.push(node); }
  }
  // Best-first refinement spends the budget on foreground detail and preserves distant parents.
  for (;;) {
    let best = -1;
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].z < maxZoom && leaves[i].priority > 1 + 1e-5 && (best < 0 || leaves[i].priority > leaves[best].priority)) { best = i; }
    }
    if (best < 0) { break; }
    const parent = leaves[best];
    const children: Node[] = [];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const child = makeNode(parent.z + 1, parent.x * 2 + dx, parent.y * 2 + dy);
      if (child) { children.push(child); }
    }
    if (children.length === 0 || leaves.length - 1 + children.length > options.maxTiles) {
      parent.priority = 0;
    } else {
      leaves.splice(best, 1, ...children);
    }
  }
  return leaves.filter(t => t.z >= minZoom).sort((a, b) => a.distance - b.distance).map(({ z, x, y }) => ({ z, x, y }));
}
