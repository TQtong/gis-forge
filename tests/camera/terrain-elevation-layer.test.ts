import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCamera25D } from '../../src/packages/camera-25d/src/index.ts';
import { createTerrainElevationLayer } from '../../src/packages/layer-cesium-terrain/src/TerrainElevationLayer.ts';
import { QuantizedMeshSampler } from '../../src/packages/layer-cesium-terrain/src/quantized-mesh-sampler.ts';
import type { QuantizedMeshRaw } from '../../src/packages/layer-cesium-terrain/src/quantized-mesh-decoder.ts';

const { raw } = vi.hoisted(() => ({ raw: {
  header: { minimumHeight: 1000, maximumHeight: 1200 },
  vertexCount: 4,
  uArray: new Uint16Array([0, 32767, 0, 32767]),
  vArray: new Uint16Array([0, 0, 32767, 32767]),
  hArray: new Uint16Array([0, 16384, 16384, 32767]),
  triangleIndices: new Uint16Array([0, 1, 2, 1, 3, 2]),
} }));
vi.mock('../../src/packages/layer-cesium-terrain/src/quantized-mesh-decoder.ts', () => ({ decodeQuantizedMesh: () => raw }));
afterEach(() => vi.unstubAllGlobals());

describe('unified terrain elevation service', () => {
  it('interpolates triangle elevations without holes and rejects coordinates outside the tile', () => {
    const sampler = new QuantizedMeshSampler(raw as QuantizedMeshRaw);
    expect(sampler.sample(0, 0)).toBe(1000);
    expect(sampler.sample(1, 1)).toBe(1200);
    expect(sampler.sample(0.5, 0.5)).toBeCloseTo(1100, 2);
    expect(sampler.sample(1.1, 0.5)).toBeNull();
    for (let y = 0; y <= 32; y++) for (let x = 0; x <= 32; x++) { expect(sampler.sample(x / 32, y / 32)).not.toBeNull(); }
  });

  it('loads elevations without creating GPU geometry, requesting imagery, or drawing another map', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return url.endsWith('layer.json')
        ? new Response(JSON.stringify({ maxzoom: 14, tiles: ['{z}/{x}/{y}.terrain'] }))
        : new Response(new ArrayBuffer(0));
    }));
    const layer = createTerrainElevationLayer({ id: 'terrain', source: 'terrain', url: 'https://terrain.example/', exaggeration: 1.8 });
    const createRenderPipeline = vi.fn(), drawIndexed = vi.fn();
    layer.onAdd({ canvasSize: [1200, 800], gpuDevice: { createRenderPipeline } } as unknown as Parameters<typeof layer.onAdd>[0]);
    await layer.provider.initialize();
    const camera = createCamera25D({ center: [116, 40], zoom: 10, pitch: 0.7 }).update(0, { width: 1200, height: 800, physicalWidth: 1200, physicalHeight: 800, pixelRatio: 1 });
    for (let i = 0; i < 25; i++) {
      layer.onUpdate(1 / 60, camera);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(layer.sampleElevation(116, 40)).toBeGreaterThanOrEqual(1000);
    expect(layer.revision).toBeGreaterThan(0);
    expect(layer.exaggeration).toBe(1.8);
    layer.encode({ drawIndexed } as unknown as GPURenderPassEncoder, camera);
    expect(drawIndexed).not.toHaveBeenCalled();
    expect(createRenderPipeline).not.toHaveBeenCalled();
    expect(urls.every(url => url.endsWith('layer.json') || url.endsWith('.terrain'))).toBe(true);
    layer.setLayoutProperty('visibility', 'none');
    expect(layer.sampleElevation(116, 40)).toBeNull();
    layer.onRemove();
    expect(layer.getData()).toMatchObject({ cachedTiles: 0, cacheBytes: 0 });
  });
});
