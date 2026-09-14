import { describe, expect, it } from 'vitest';
import { createCamera25D } from '../../src/packages/camera-25d/src/index.ts';
import { computeGeographicCoveringTiles } from '../../src/packages/layer-cesium-terrain/src/geographic-tile-scheduler.ts';
import { computeRasterCoveringTiles } from '../../src/packages/layer-tile-raster/src/RasterTileLayer.ts';
import { constrainCameraToTerrain, terrainPixelSpace } from '../../src/packages/camera-25d/src/terrain-camera.ts';

const viewport = { width: 1200, height: 800, physicalWidth: 1200, physicalHeight: 800, pixelRatio: 1 };
const available = { isTileAvailable: () => true };
const options = { viewportWidth: 1200, viewportHeight: 800, minZoom: 0, maxZoom: 14, minElevation: 0, maxElevation: 0 };

describe('perspective terrain coverage', () => {
  for (const pitch of [48.7, 65, 85]) {
    it(`covers valley rays independently of the old clip distance at zoom 22, pitch ${pitch}`, () => {
      const base = createCamera25D({ center: [116.0399, 40.0467], zoom: 22, pitch: pitch * Math.PI / 180, bearing: 218 * Math.PI / 180 }).update(0, viewport);
      const camera = constrainCameraToTerrain(base, viewport, () => 4000, [-24000, 18000]);
      const terrain = computeGeographicCoveringTiles(camera, available, { viewportWidth: 1200, viewportHeight: 800, minZoom: 0, maxZoom: 14 });
      const raster = computeRasterCoveringTiles(camera, 1200, 800, 0, 22);
      const space = terrainPixelSpace(camera), v = camera.viewMatrix, p = camera.projectionMatrix;
      const eye = [0, 1, 2].map(i => -(v[i * 4] * v[12] + v[i * 4 + 1] * v[13] + v[i * 4 + 2] * v[14]));
      expect(raster.length).toBeLessThanOrEqual(200);
      expect(terrain.length).toBeLessThanOrEqual(128);
      let samples = 0;
      for (let sy = 0; sy <= 8; sy++) for (let sx = 0; sx <= 12; sx++) {
        const nx = sx / 6 - 1, ny = 1 - sy / 4;
        const ray = [0, 1, 2].map(i => v[i * 4] * nx / p[0] + v[i * 4 + 1] * ny / p[5] - v[i * 4 + 2]);
        if (ray[2] >= 0) { continue; }
        const t = (-1000 * space.ppm - eye[2]) / ray[2];
        const wx = (eye[0] + ray[0] * t + space.center[0]) / space.world;
        const wy = (eye[1] + ray[1] * t + space.center[1]) / space.world;
        if (wx < 0 || wx > 1 || wy < 0 || wy > 1) { continue; }
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180 / Math.PI;
        expect(raster.some(tile => wx >= tile.x / 2 ** tile.z && wx <= (tile.x + 1) / 2 ** tile.z && wy >= tile.y / 2 ** tile.z && wy <= (tile.y + 1) / 2 ** tile.z)).toBe(true);
        expect(terrain.some(tile => wx >= tile.x / (2 ** tile.z * 2) && wx <= (tile.x + 1) / (2 ** tile.z * 2) && (lat + 90) / 180 >= tile.y / 2 ** tile.z && (lat + 90) / 180 <= (tile.y + 1) / 2 ** tile.z)).toBe(true);
        samples++;
      }
      expect(samples).toBeGreaterThan(50);
    });
  }
  it('refines more closely when screen-space error decreases', () => {
    const camera = createCamera25D({ center: [116.3974, 39.9093], zoom: 10, pitch: Math.PI / 4 }).update(0, viewport);
    const normal = computeGeographicCoveringTiles(camera, available, { ...options, maxScreenSpaceError: 4 });
    const detailed = computeGeographicCoveringTiles(camera, available, { ...options, maxScreenSpaceError: 1 });
    expect(normal.length).toBeGreaterThan(0);
    expect(Math.max(...detailed.map(t => t.z))).toBeGreaterThan(Math.max(...normal.map(t => t.z)));
    expect(detailed.length).toBeLessThanOrEqual(128);
  });

  for (const pitch of [0, 45, 65, 85]) for (const bearing of [0, 90, 180, 270]) {
    it(`covers the whole ground frustum at pitch ${pitch}, bearing ${bearing}, within a bounded mixed LOD budget`, () => {
      const camera = createCamera25D({ center: [116.3974, 39.9093], zoom: 10, pitch: pitch * Math.PI / 180, bearing: bearing * Math.PI / 180 }).update(0, viewport);
      const terrain = computeGeographicCoveringTiles(camera, available, options);
      const raster = computeRasterCoveringTiles(camera, 1200, 800, 0, 22);
      expect(terrain.length).toBeLessThanOrEqual(128);
      expect(raster.length).toBeLessThanOrEqual(200);
      for (const tiles of [terrain, raster]) {
        const keys = new Set(tiles.map(t => `${t.z}/${t.x}/${t.y}`));
        expect(keys.size).toBe(tiles.length);
        for (const tile of tiles) for (let z = tile.z - 1; z >= 0; z--) {
          const divisor = 2 ** (tile.z - z);
          expect(keys.has(`${z}/${Math.floor(tile.x / divisor)}/${Math.floor(tile.y / divisor)}`)).toBe(false);
        }
      }
      const m = camera.inverseVPMatrix!;
      const world = 512 * 2 ** camera.zoom;
      const cx = (camera.center[0] + 180) / 360 * world;
      const cy = (1 - Math.asinh(Math.tan(camera.center[1] * Math.PI / 180)) / Math.PI) / 2 * world;
      for (let sy = 0; sy <= 12; sy++) for (let sx = 0; sx <= 16; sx++) {
        const nx = sx / 8 - 1, ny = 1 - sy / 6;
        const point = (z: number) => {
          const p = [0, 1, 2, 3].map(i => m[i] * nx + m[i + 4] * ny + m[i + 8] * z + m[i + 12]);
          return p.slice(0, 3).map(v => v / p[3]);
        };
        const a = point(1), b = point(0);
        const t = -a[2] / (b[2] - a[2]);
        if (t < 0 || t > 1) { continue; }
        const wx = (a[0] + t * (b[0] - a[0]) + cx) / world;
        const wy = (a[1] + t * (b[1] - a[1]) + cy) / world;
        if (wx < 0 || wx > 1 || wy < 0 || wy > 1) { continue; }
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180 / Math.PI;
        expect(raster.some(tile => wx >= tile.x / 2 ** tile.z - 1e-9 && wx <= (tile.x + 1) / 2 ** tile.z + 1e-9 && wy >= tile.y / 2 ** tile.z - 1e-9 && wy <= (tile.y + 1) / 2 ** tile.z + 1e-9)).toBe(true);
        expect(terrain.some(tile => wx >= tile.x / (2 ** tile.z * 2) - 1e-9 && wx <= (tile.x + 1) / (2 ** tile.z * 2) + 1e-9 && (lat + 90) / 180 >= tile.y / 2 ** tile.z - 1e-9 && (lat + 90) / 180 <= (tile.y + 1) / 2 ** tile.z + 1e-9)).toBe(true);
      }
      if (pitch === 85) { expect(new Set(raster.map(t => t.z)).size).toBeGreaterThan(1); }
    });
  }
});
