import { afterEach, describe, expect, it, vi } from 'vitest';

import { CesiumTerrainProvider } from '../../src/packages/layer-cesium-terrain/src/cesium-terrain-provider.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CesiumTerrainProvider metadata and requests', () => {
  it('retries metadata after a temporary failure', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({ maxzoom: 4 })));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CesiumTerrainProvider('https://terrain.example/');
    await expect(provider.initialize()).rejects.toThrow('offline');
    await expect(provider.initialize()).resolves.toMatchObject({ maxZoom: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels obsolete in-flight and queued tiles so the new view can load immediately', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (input.endsWith('layer.json')) { return Promise.resolve(new Response(JSON.stringify({ maxzoom: 4, tiles: ['{z}/{x}/{y}.terrain'] }))); }
      requested.push(input);
      if (input.includes('/3/7/0.terrain')) { return Promise.resolve(new Response(new ArrayBuffer(0))); }
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }));
    const provider = new CesiumTerrainProvider('https://terrain.example/');
    await provider.initialize();
    const requests = Array.from({ length: 8 }, (_, x) => provider.loadTile(3, x, 0));
    const settled = Promise.allSettled(requests);
    expect(requested).toHaveLength(6);
    provider.retainRequests(new Set(['3/7/0']));
    await settled;
    expect(requested).toHaveLength(7);
    expect(requested.some(url => url.includes('/3/6/0.terrain'))).toBe(false);
    expect(requested.at(-1)).toContain('/3/7/0.terrain');
  });

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
