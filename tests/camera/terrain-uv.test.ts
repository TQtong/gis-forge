import { describe, expect, it } from 'vitest';

import { computeOsmAncestorUvTransform } from '../../src/packages/layer-cesium-terrain/src/mercator.ts';

describe('terrain drape ancestor UV mapping', () => {
  it('maps a child OSM tile into the correct ancestor quadrant', () => {
    expect(computeOsmAncestorUvTransform(
      { z: 10, x: 843, y: 387 },
      { z: 8, x: 210, y: 96 },
    )).toEqual({ scale: [0.25, 0.25], offset: [0.75, 0.75] });
  });

  it('uses OSM zoom levels rather than the unrelated terrain TMS delta', () => {
    expect(computeOsmAncestorUvTransform(
      { z: 9, x: 421, y: 193 },
      { z: 8, x: 210, y: 96 },
    )).toEqual({ scale: [0.5, 0.5], offset: [0.5, 0.5] });
  });

  it('rejects textures that are not ancestors of the source tile', () => {
    expect(computeOsmAncestorUvTransform(
      { z: 9, x: 421, y: 193 },
      { z: 8, x: 211, y: 96 },
    )).toBeNull();
    expect(computeOsmAncestorUvTransform(
      { z: 8, x: 210, y: 96 },
      { z: 9, x: 421, y: 193 },
    )).toBeNull();
  });
});
