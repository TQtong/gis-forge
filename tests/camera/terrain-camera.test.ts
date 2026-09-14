import { describe, expect, it } from 'vitest';
import { createCamera25D } from '../../src/packages/camera-25d/src/index.ts';
import { constrainCameraToTerrain, projectTerrainPoint, terrainPixelSpace, unprojectTerrainPoint } from '../../src/packages/camera-25d/src/terrain-camera.ts';

const viewport = { width: 1200, height: 800, physicalWidth: 2400, physicalHeight: 1600, pixelRatio: 2 };

describe('terrain-aware 2.5D camera', () => {
  for (const zoom of [10, 16, 22]) for (const pitch of [0, 65, 85]) {
    it(`orbits a 4000m plateau above ground at zoom ${zoom}, pitch ${pitch}`, () => {
      const base = createCamera25D({ center: [116, 40], zoom, pitch: pitch * Math.PI / 180 }).update(0, viewport);
      const sampler = () => 4000;
      const camera = constrainCameraToTerrain(base, viewport, sampler);
      expect(camera.altitude).toBeGreaterThanOrEqual(4005);
      expect(camera.position[2]).toBeCloseTo(camera.altitude, 2);
      expect(Array.from(camera.vpMatrix).every(Number.isFinite)).toBe(true);
      const screen = projectTerrainPoint(camera, 1200, 800, [116, 40], sampler);
      expect(screen[0]).toBeCloseTo(600, 1);
      expect(screen[1]).toBeCloseTo(400, 1);
      const hit = unprojectTerrainPoint(camera, 1200, 800, screen, sampler);
      expect(hit).not.toBeNull();
      expect(hit![0]).toBeCloseTo(116, 4);
      expect(hit![1]).toBeCloseTo(40, 4);
    });
  }
  it('raises the eye when a ridge behind the target would intersect the camera', () => {
    const base = createCamera25D({ center: [116, 40], zoom: 17, pitch: 85 * Math.PI / 180 }).update(0, viewport);
    const sample = (_lng: number, lat: number) => lat < 39.9999 ? 4500 : 4000;
    const camera = constrainCameraToTerrain(base, viewport, sample);
    expect(camera.altitude).toBeGreaterThanOrEqual(4505);
    expect(camera.pitch).toBeLessThan(base.pitch);
    const space = terrainPixelSpace(camera);
    const m = camera.viewMatrix;
    const x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
    const y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
    expect(camera.altitude - sample(...space.toLngLat(x, y))).toBeGreaterThanOrEqual(5);
  });
  it('returns no intersection for sky rays, keeping horizon drags out of the opposite hemisphere', () => {
    const base = createCamera25D({ center: [116, 40], zoom: 12, pitch: 85 * Math.PI / 180 }).update(0, viewport);
    const camera = constrainCameraToTerrain(base, viewport, () => 0);
    expect(unprojectTerrainPoint(camera, 1200, 800, [600, 0], () => 0)).toBeNull();
    expect(unprojectTerrainPoint(camera, 1200, 800, [600, 700], () => 0)).not.toBeNull();
  });
  it('extends the far plane when collision avoidance lifts the camera above a steep canyon', () => {
    const base = createCamera25D({ center: [116, 40], zoom: 22, pitch: 0 }).update(0, viewport);
    const camera = constrainCameraToTerrain(base, viewport, (lng, lat) => Math.abs(lng - 116) < 1e-9 && Math.abs(lat - 40) < 1e-9 ? 0 : 10000);
    expect(camera.altitude).toBeGreaterThanOrEqual(10005);
    const m = camera.vpMatrix;
    expect(m[14] / m[15]).toBeGreaterThan(0);
    expect(m[14] / m[15]).toBeLessThan(1);
  });
  it('keeps a valley thousands of metres below the zoom-22 orbit inside the frustum', () => {
    const base = createCamera25D({ center: [116.0399, 40.0467], zoom: 22, pitch: 48.7 * Math.PI / 180, bearing: 218 * Math.PI / 180 }).update(0, viewport);
    const camera = constrainCameraToTerrain(base, viewport, () => 1100);
    const space = terrainPixelSpace(camera), v = camera.viewMatrix, p = camera.projectionMatrix;
    const eye = [0, 1, 2].map(i => -(v[i * 4] * v[12] + v[i * 4 + 1] * v[13] + v[i * 4 + 2] * v[14]));
    const oldFar = base.projectionMatrix[14] / base.projectionMatrix[10];
    for (const ny of [-1, 0, 1]) for (const nx of [-1, 0, 1]) {
      const ray = [0, 1, 2].map(i => v[i * 4] * nx / p[0] + v[i * 4 + 1] * ny / p[5] - v[i * 4 + 2]);
      const depth = -eye[2] / ray[2];
      expect(depth).toBeGreaterThan(oldFar * 10); // The old near-slope far plane clips the valley.
      const xyz = eye.map((a, i) => a + ray[i] * depth), m = camera.vpMatrix;
      const clip = [0, 1, 2, 3].map(i => m[i] * xyz[0] + m[i + 4] * xyz[1] + m[i + 8] * xyz[2] + m[i + 12]);
      expect(clip[2] / clip[3]).toBeGreaterThan(0);
      expect(clip[2] / clip[3]).toBeLessThan(1);
      expect(unprojectTerrainPoint(camera, 1200, 800, [(nx + 1) * 600, (1 - ny) * 400], () => 0)).not.toBeNull();
    }
    expect(p[14] / p[10] / space.ppm).toBeGreaterThan(1100);
  });
  it('keeps a distant ridge visible across the horizon at maximum zoom', () => {
    const base = createCamera25D({ center: [116, 40], zoom: 22, pitch: 85 * Math.PI / 180 }).update(0, viewport);
    const camera = constrainCameraToTerrain(base, viewport, () => 4000);
    const space = terrainPixelSpace(camera), m = camera.vpMatrix;
    const xyz = [0, -100000 * space.ppm, 4000 * space.ppm];
    const clip = [0, 1, 2, 3].map(i => m[i] * xyz[0] + m[i + 4] * xyz[1] + m[i + 8] * xyz[2] + m[i + 12]);
    expect(Math.abs(clip[1] / clip[3])).toBeLessThan(1);
    expect(clip[2] / clip[3]).toBeGreaterThan(0);
    expect(clip[2] / clip[3]).toBeLessThan(1);
  });
  it('still picks the first nearby ridge when far extends across the world', () => {
    const base = createCamera25D({ center: [116, 40], zoom: 22, pitch: 85 * Math.PI / 180 }).update(0, viewport);
    const camera = constrainCameraToTerrain(base, viewport, () => 4000);
    const space = terrainPixelSpace(camera);
    const ridge = space.toLngLat(0, -8 * space.ppm);
    const sample = (lng: number, lat: number) => {
      const px = space.toPixel(lng, lat), north = -(px[1] - space.center[1]) / space.ppm;
      return north >= 5 && north <= 15 ? camera.altitude : 0;
    };
    const screen = projectTerrainPoint(camera, 1200, 800, ridge, sample);
    const hit = unprojectTerrainPoint(camera, 1200, 800, screen, sample);
    expect(hit).not.toBeNull();
    const px = space.toPixel(...hit!);
    expect(-(px[1] - space.center[1]) / space.ppm).toBeCloseTo(5, 1);
  });
});
