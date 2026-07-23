import { describe, expect, it } from 'vitest';

import {
  assertSupportedGlobeOptions,
  throwUnsupportedGlobeFeature,
} from '../../src/packages/preset-3d/src/globe-3d.ts';

describe('Globe3D capability contract', () => {
  it('uses a structured error instead of silently accepting unsupported APIs', () => {
    try {
      throwUnsupportedGlobeFeature('Globe3D.add3DTileset', '3d-tiles');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'GeoForgeError',
        code: 'FEATURE_NOT_IMPLEMENTED',
        context: { api: 'Globe3D.add3DTileset', feature: '3d-tiles' },
      });
      return;
    }
    throw new Error('Expected unsupported capability to throw');
  });

  it('accepts the currently implemented Globe options', () => {
    expect(() => assertSupportedGlobeOptions({
      container: '#globe',
      imagery: { url: '/tiles/{z}/{x}/{y}.jpg', scheme: 'geographic' },
      atmosphere: true,
      skybox: true,
      shadows: false,
      fog: false,
      antialias: false,
    })).not.toThrow();
  });

  it.each([
    [{ terrain: { url: '/terrain' } }, '3d-terrain'],
    [{ shadows: true }, 'shadows'],
    [{ fog: true }, 'fog'],
    [{ targetFrameRate: 30 }, 'frame-rate-limiting'],
    [{ antialias: true }, 'msaa'],
    [{ baseColor: [0, 0, 0, 1] }, 'custom-base-color'],
    [{ imagery: { type: 'wmts' } }, 'imagery-wmts'],
    [{ imagery: { subdomains: ['a'] } }, 'imagery-subdomains'],
    [{ imagery: { tmsFlipY: true } }, 'tms-y-flip'],
  ] as const)('rejects unsupported constructor options %o', (extra, feature) => {
    expect(() => assertSupportedGlobeOptions({
      container: '#globe',
      ...extra,
    })).toThrowError(expect.objectContaining({
      code: 'FEATURE_NOT_IMPLEMENTED',
      context: expect.objectContaining({ feature }),
    }));
  });
});
