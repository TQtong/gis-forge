import { describe, expect, it } from 'vitest';

import {
  computeOsmTileCoverage,
  lngLatToOsmAtlasUv,
} from '../../src/packages/layer-cesium-terrain/src/mercator.ts';

describe('terrain drape atlas', () => {
  it('covers every Web-Mercator tile intersecting a Geographic terrain bbox', () => {
    const coverage = computeOsmTileCoverage(112.5, 22.5, 135, 45, 4);

    expect(coverage).toEqual({ z: 4, xMin: 13, yMin: 5, xMax: 13, yMax: 6 });
  });

  it('keeps UVs continuous across an internal OSM tile boundary', () => {
    const coverage = computeOsmTileCoverage(112.5, 22.5, 135, 45, 4);
    const justNorth = lngLatToOsmAtlasUv(120, 40.9799, coverage);
    const boundary = lngLatToOsmAtlasUv(120, 40.9798980696, coverage);
    const justSouth = lngLatToOsmAtlasUv(120, 40.9798, coverage);

    expect(boundary[1]).toBeCloseTo(0.5, 8);
    expect(justNorth[1]).toBeLessThan(boundary[1]);
    expect(justSouth[1]).toBeGreaterThan(boundary[1]);
    expect(justSouth[1] - justNorth[1]).toBeLessThan(0.00002);
  });

  it('clamps polar coverage to valid XYZ tile indices', () => {
    const coverage = computeOsmTileCoverage(-180, -90, 180, 90, 2);

    expect(coverage).toEqual({ z: 2, xMin: 0, yMin: 0, xMax: 3, yMax: 3 });
  });
});
