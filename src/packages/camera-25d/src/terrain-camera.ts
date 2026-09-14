import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import { DEFAULT_TERRAIN_ELEVATION_RANGE } from '../../core/src/geo/terrain-elevation-range.ts';

export type TerrainSampler = (lng: number, lat: number) => number | null;
const CIRCUMFERENCE = 40075016.68557849;

export function terrainPixelSpace(camera: CameraState) {
  const world = 512 * 2 ** camera.zoom;
  const toPixel = (lng: number, lat: number): [number, number] => [
    (lng + 180) / 360 * world,
    (1 - Math.asinh(Math.tan(Math.max(-85.0511287798066, Math.min(85.0511287798066, lat)) * Math.PI / 180)) / Math.PI) / 2 * world,
  ];
  const center = toPixel(...camera.center);
  return {
    world, center, toPixel,
    ppm: world / (CIRCUMFERENCE * Math.cos(camera.center[1] * Math.PI / 180)),
    toLngLat: (x: number, y: number): [number, number] => [
      (x + center[0]) / world * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + center[1]) / world))) * 180 / Math.PI,
    ],
  };
}

/** Raise the orbit onto terrain and keep the eye and near-plane footprint above it. */
export function constrainCameraToTerrain(camera: CameraState, viewport: Viewport, sample: TerrainSampler,
  elevationRange: readonly [number, number] = DEFAULT_TERRAIN_ELEVATION_RANGE,
  collisionSample: TerrainSampler = sample): CameraState {
  const space = terrainPixelSpace(camera);
  const targetElevation = sample(...camera.center) ?? 0;
  const distance = viewport.height / (2 * Math.tan(camera.fov / 2));
  const back = Math.sin(camera.pitch) * distance;
  const sinB = Math.sin(camera.bearing), cosB = Math.cos(camera.bearing);
  const x = -sinB * back, y = cosB * back;
  const targetZ = targetElevation * space.ppm;
  const near = Math.max(1, distance * 0.01);
  // Clearance includes the entire near plane, not just the eye's single point.
  const radius = near * (1 + Math.tan(camera.fov / 2) * Math.max(1, viewport.width / viewport.height));
  let floor = targetZ;
  for (const dx of [-radius, 0, radius]) for (const dy of [-radius, 0, radius]) {
    const h = collisionSample(...space.toLngLat(x + dx, y + dy));
    if (h !== null && Number.isFinite(h)) { floor = Math.max(floor, h * space.ppm); }
  }
  const z = Math.max(targetZ + Math.cos(camera.pitch) * distance, floor + Math.max(5 * space.ppm, radius * 2));
  const pitch = Math.atan2(back, z - targetZ);
  const projectionMatrix = new Float32Array(camera.projectionMatrix);
  const actualDistance = Math.hypot(back, z - targetZ);
  const terrainElevationRange: readonly [number, number] = [
    Math.min(0, targetElevation, elevationRange[0]), Math.max(0, targetElevation, elevationRange[1]),
  ];
  // An orbit distance only describes the nearby slope, not the valley below it.
  // Bound forward depth by the actual world's AABB. When every ray points down,
  // the top ray's intersection with the lowest terrain plane is a tighter bound.
  const forward = [sinB * Math.sin(pitch), -cosB * Math.sin(pitch), -Math.cos(pitch)];
  const worldFar = forward[0] * ((forward[0] >= 0 ? space.world : 0) - space.center[0] - x)
    + forward[1] * ((forward[1] >= 0 ? space.world : 0) - space.center[1] - y)
    + forward[2] * (terrainElevationRange[0] * space.ppm - z);
  const topRayDown = Math.cos(pitch + camera.fov / 2);
  const groundFar = topRayDown > 0
    ? (z - terrainElevationRange[0] * space.ppm) * Math.cos(camera.fov / 2) / topRayDown
    : Infinity;
  const far = Math.max(actualDistance * 2, Math.min(worldFar, groundFar)) * 1.05;
  mat4.perspectiveReversedZ(projectionMatrix, camera.fov, viewport.width / viewport.height, near, far);
  projectionMatrix[0] = -projectionMatrix[0];
  const viewMatrix = new Float32Array(16);
  mat4.lookAt(viewMatrix, new Float32Array([x, y, z]), new Float32Array([0, 0, targetZ]),
    new Float32Array([sinB * Math.cos(pitch), -cosB * Math.cos(pitch), Math.sin(pitch)]));
  const vpMatrix = new Float32Array(16), inverseVPMatrix = new Float32Array(16);
  mat4.multiply(vpMatrix, projectionMatrix, viewMatrix);
  mat4.invert(inverseVPMatrix, vpMatrix);
  const mercatorPerPixel = CIRCUMFERENCE / space.world;
  return {
    ...camera, pitch, targetElevation, terrainElevationRange, viewMatrix, projectionMatrix, vpMatrix, inverseVPMatrix,
    altitude: z / space.ppm,
    position: new Float32Array([
      (space.center[0] + x - space.world / 2) * mercatorPerPixel,
      (space.world / 2 - space.center[1] - y) * mercatorPerPixel,
      z / space.ppm,
    ]),
  };
}

export function projectTerrainPoint(camera: CameraState, width: number, height: number, point: [number, number], sample: TerrainSampler): [number, number] {
  const space = terrainPixelSpace(camera);
  const px = space.toPixel(...point);
  const xyz = [px[0] - space.center[0], px[1] - space.center[1], (sample(...point) ?? 0) * space.ppm];
  const m = camera.vpMatrix;
  const clip = [0, 1, 3].map(i => m[i] * xyz[0] + m[4 + i] * xyz[1] + m[8 + i] * xyz[2] + m[12 + i]);
  return [(clip[0] / clip[2] + 1) * width / 2, (1 - clip[1] / clip[2]) * height / 2];
}

/** First positive terrain intersection; sky rays never intersect behind the camera. */
export function unprojectTerrainPoint(camera: CameraState, width: number, height: number, point: [number, number], sample: TerrainSampler): [number, number] | null {
  const nx = point[0] / width * 2 - 1, ny = 1 - point[1] / height * 2;
  const view = camera.viewMatrix, projection = camera.projectionMatrix;
  const near = projection[14] / (projection[10] + 1), far = projection[14] / projection[10];
  // Derive a ray from the orthonormal view basis. Inverting a VP with an enormous
  // far/near ratio loses the foreground precision needed by cursor-anchored zoom.
  const eye = [0, 1, 2].map(i => -(view[i * 4] * view[12] + view[i * 4 + 1] * view[13] + view[i * 4 + 2] * view[14]));
  const direction = [0, 1, 2].map(i => view[i * 4] * nx / projection[0] + view[i * 4 + 1] * ny / projection[5] - view[i * 4 + 2]);
  const a = eye.map((v, i) => v + direction[i] * near);
  if (![...a, far].every(Number.isFinite) || far <= near) { return null; }
  const space = terrainPixelSpace(camera);
  const delta = direction.map(v => v * (far - near));
  const at = (t: number) => a.map((v, i) => v + delta[i] * t);
  const heightAbove = (t: number) => {
    const p = at(t);
    return p[2] - (sample(...space.toLngLat(p[0], p[1])) ?? 0) * space.ppm;
  };
  let previous = 0;
  // Scale the logarithmic steps to the near plane, so extending far never skips
  // nearby ridges. Refine the first crossing by bisection.
  const range = (far - near) / near;
  for (let i = 1; i <= 96; i++) {
    const t = Math.expm1(i / 96 * Math.log1p(range)) / range;
    if (heightAbove(t) <= 0) {
      let lo = previous, hi = t;
      for (let j = 0; j < 28; j++) {
        const mid = (lo + hi) / 2;
        if (heightAbove(mid) > 0) { lo = mid; } else { hi = mid; }
      }
      const hit = at((lo + hi) / 2);
      return space.toLngLat(hit[0], hit[1]);
    }
    previous = t;
  }
  return null;
}
