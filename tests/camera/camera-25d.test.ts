import { describe, expect, it } from 'vitest';

import { createCamera25D } from '../../src/packages/camera-25d/src/index.ts';
import type { Viewport } from '../../src/packages/core/src/types/viewport.ts';
import { computeRasterCoveringTiles } from '../../src/packages/layer-tile-raster/src/RasterTileLayer.ts';

const DEG2RAD = Math.PI / 180;
const VIEWPORT: Viewport = {
  width: 1200,
  height: 800,
  physicalWidth: 1200,
  physicalHeight: 800,
  pixelRatio: 1,
};

function expectLngLatClose(
  actual: readonly [number, number] | null,
  expected: readonly [number, number],
  digits = 6,
): void {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(expected[0], digits);
  expect(actual![1]).toBeCloseTo(expected[1], digits);
}

describe('Camera25D coordinate semantics', () => {
  it('projects the center to the viewport center with east right and north up', () => {
    const camera = createCamera25D({
      center: [116.3974, 39.9093], zoom: 10, pitch: 0, bearing: 0,
    });
    camera.update(0, VIEWPORT);

    const center = camera.lngLatToScreen(116.3974, 39.9093);
    const east = camera.lngLatToScreen(116.4974, 39.9093);
    const north = camera.lngLatToScreen(116.3974, 40.0093);

    expect(center[0]).toBeCloseTo(VIEWPORT.width / 2, 5);
    expect(center[1]).toBeCloseTo(VIEWPORT.height / 2, 5);
    expect(east[0]).toBeGreaterThan(center[0]);
    expect(north[1]).toBeLessThan(center[1]);
  });

  it('round-trips geographic points through a pitched and rotated view', () => {
    const camera = createCamera25D({
      center: [116.3974, 39.9093],
      zoom: 11.25,
      pitch: 50 * DEG2RAD,
      bearing: 32 * DEG2RAD,
    });
    camera.update(0, VIEWPORT);

    const samples: Array<[number, number]> = [
      [116.3974, 39.9093],
      [116.43, 39.90],
      [116.36, 39.88],
      [116.41, 39.94],
    ];
    for (const sample of samples) {
      const screen = camera.lngLatToScreen(sample[0], sample[1]);
      expectLngLatClose(camera.screenToLngLat(screen[0], screen[1]), sample, 5);
    }
  });

  it('keeps matrices and visible bounds finite at the maximum pitch', () => {
    const camera = createCamera25D({
      center: [116.3974, 39.9093],
      zoom: 10,
      pitch: 85 * DEG2RAD,
      bearing: -140 * DEG2RAD,
    });
    const state = camera.update(0, VIEWPORT);
    const bounds = camera.getVisibleBounds();

    expect(Array.from(state.vpMatrix).every(Number.isFinite)).toBe(true);
    expect(Array.from(state.inverseVPMatrix!).every(Number.isFinite)).toBe(true);
    expect([bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)).toBe(true);
  });

  it('keeps a useful raster coverage set when the horizon bbox exceeds the tile budget', () => {
    const camera = createCamera25D({
      center: [116.3974, 39.9093],
      zoom: 10,
      pitch: 85 * DEG2RAD,
      bearing: 25 * DEG2RAD,
    });
    const state = camera.update(0, VIEWPORT);
    const tiles = computeRasterCoveringTiles(
      state,
      VIEWPORT.width,
      VIEWPORT.height,
      0,
      22,
    );

    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(200);
    expect(new Set(tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`)).size).toBe(tiles.length);
  });
});
