import { describe, expect, it } from 'vitest';

import type { CameraState } from '../../src/packages/core/src/types/viewport.ts';
import { computeGeographicCoveringTiles } from '../../src/packages/layer-cesium-terrain/src/geographic-tile-scheduler.ts';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const camera: CameraState = {
  center: [116.3974, 39.9093],
  zoom: 10,
  bearing: 0,
  pitch: Math.PI / 4,
  roll: 0,
  altitude: 1000,
  fov: 0.6435,
  position: new Float64Array(3),
  viewMatrix: identity,
  projectionMatrix: identity,
  vpMatrix: identity,
  inverseVPMatrix: identity,
};
const available = { isTileAvailable: () => true };

describe('geographic terrain scheduler', () => {
  it('uses screen-space error to bias terrain LOD', () => {
    const normal = computeGeographicCoveringTiles(camera, available, {
      viewportWidth: 1200, viewportHeight: 800, minZoom: 0, maxZoom: 14,
      maxScreenSpaceError: 4,
    });
    const detailed = computeGeographicCoveringTiles(camera, available, {
      viewportWidth: 1200, viewportHeight: 800, minZoom: 0, maxZoom: 14,
      maxScreenSpaceError: 1,
    });

    expect(normal.length).toBeGreaterThan(0);
    expect(detailed.length).toBeGreaterThan(0);
    expect(normal.every((tile) => tile.z === 9)).toBe(true);
    expect(detailed.every((tile) => tile.z === 11)).toBe(true);
  });
});
