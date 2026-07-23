import { afterEach, describe, expect, it, vi } from 'vitest';

import { CesiumTerrainProvider } from '../../src/packages/layer-cesium-terrain/src/cesium-terrain-provider.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CesiumTerrainProvider metadata and requests', () => {
  it('treats missing available metadata as continuous coverage inside bounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      bounds: [0, 0, 10, 10],
      minzoom: 0,
      maxzoom: 2,
      tiles: ['{z}/{x}/{y}.terrain'],
    }), { status: 200 })));

    const provider = new CesiumTerrainProvider('https://terrain.example/');
    const metadata = await provider.initialize();

    expect(metadata.scheme).toBe('tms');
    expect(provider.isTileAvailable(1, 2, 1)).toBe(true);
    expect(provider.isTileAvailable(1, 0, 0)).toBe(false);
  });

  it('converts logical TMS y to XYZ y and deduplicates concurrent loads', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('layer.json')) {
        return new Response(JSON.stringify({
          minzoom: 0,
          maxzoom: 4,
          scheme: 'xyz',
          tiles: ['https://tiles.example/{z}/{x}/{y}.terrain'],
        }), { status: 200 });
      }
      // The empty body deliberately fails decoding after the URL is observed.
      return new Response(new ArrayBuffer(0), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CesiumTerrainProvider('https://terrain.example/');
    await provider.initialize();
    const first = provider.loadTile(2, 3, 1);
    const second = provider.loadTile(2, 3, 1);

    expect(second).toBe(first);
    await Promise.allSettled([first, second]);
    expect(urls.filter((url) => url.includes('tiles.example'))).toEqual([
      'https://tiles.example/2/3/2.terrain',
    ]);
  });
});
