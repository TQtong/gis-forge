import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCamera25D } from '../../src/packages/camera-25d/src/index.ts';
import { constrainCameraToTerrain } from '../../src/packages/camera-25d/src/terrain-camera.ts';
import { computeRasterCoveringTiles } from '../../src/packages/layer-tile-raster/src/RasterTileLayer.ts';
import { RasterTerrainSurface } from '../../src/packages/layer-tile-raster/src/raster-terrain-surface.ts';
import type { TileCoord } from '../../src/packages/core/src/types/tile.ts';

const viewport = { width: 1560, height: 1200, physicalWidth: 1560, physicalHeight: 1200, pixelRatio: 1 };
const center: [number, number] = [115.8557, 39.913];
const baseCamera = (zoom = 13) => createCamera25D({ center, zoom, pitch: 0, bearing: 280.5 * Math.PI / 180 }).update(0, viewport);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('stationary terrain stability', () => {
  it('does not split the center tile because of millimetre height rounding at integer zoom', () => {
    const base = baseCamera();
    const covers = [500, 500.001, 500.002].map(h => {
      const camera = constrainCameraToTerrain(base, viewport, () => h);
      return computeRasterCoveringTiles(camera, viewport.width, viewport.height, 0, 22).map(t => `${t.z}/${t.x}/${t.y}`).sort();
    });
    expect(covers[1]).toEqual(covers[0]);
    expect(covers[2]).toEqual(covers[0]);
  });

  it('retains detail near the split boundary and merges after zooming clearly away', () => {
    let previous: TileCoord[] = [];
    const centerZoom = (zoom: number) => {
      const camera = constrainCameraToTerrain(baseCamera(zoom), viewport, () => 500);
      previous = computeRasterCoveringTiles(camera, viewport.width, viewport.height, 0, 22, previous);
      const fx = (center[0] + 180) / 360;
      const fy = (1 - Math.asinh(Math.tan(center[1] * Math.PI / 180)) / Math.PI) / 2;
      return previous.find(t => Math.floor(fx * 2 ** t.z) === t.x && Math.floor(fy * 2 ** t.z) === t.y)!.z;
    };
    expect(centerZoom(13)).toBe(13);
    expect(centerZoom(13.2)).toBe(14);
    for (const zoom of [13.05, 12.99, 13.01, 13.05]) { expect(centerZoom(zoom)).toBe(14); }
    expect(centerZoom(12.8)).toBe(13);
  });

  it('keeps the orbit fixed when the displayed LOD interpolation changes', () => {
    const base = baseCamera();
    const source = () => 1073.15152182283;
    const cameras = [1073.214447, 1073.706259, 1073.214447].map(displayed =>
      constrainCameraToTerrain(base, viewport, source, [-21600, 16200], () => displayed));
    for (const camera of cameras) {
      expect(camera.targetElevation).toBe(source());
      expect(camera.viewMatrix).toEqual(cameras[0].viewMatrix);
      expect(camera.vpMatrix).toEqual(cameras[0].vpMatrix);
    }
  });

  it('still avoids the displayed surface while its elevation transitions down', () => {
    const camera = constrainCameraToTerrain(baseCamera(22), viewport, () => 1000, [-12000, 9000], () => 1200);
    expect(camera.targetElevation).toBe(1000);
    expect(camera.altitude).toBeGreaterThanOrEqual(1205);
  });
});

function surfaceFixture() {
  let now = 0, elevation = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal('GPUBufferUsage', { INDEX: 1, COPY_DST: 2, UNIFORM: 4, VERTEX: 8 });
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
  const writeBuffer = vi.fn();
  const device = {
    createBindGroupLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}),
    createPipelineLayout: () => ({}), createBindGroup: () => ({}), createBuffer: () => ({ destroy() {} }), queue: { writeBuffer },
  } as unknown as GPUDevice;
  const pass = { setPipeline() {}, setBindGroup() {}, setIndexBuffer() {}, setVertexBuffer() {}, drawIndexed() {} } as unknown as GPURenderPassEncoder;
  const source = { revision: 0, elevationRange: [0, 1000] as const, exaggeration: 1, hillshade: 0,
    lightDirection: [0, 0, 1] as const, sampleElevation: () => elevation };
  const surface = new RasterTerrainSurface(device, []);
  const camera = baseCamera();
  const tile = { targetCoord: { z: 0, x: 0, y: 0 }, entry: { bindGroup: {} as GPUBindGroup, fadeProgress: 1 },
    uvOffset: [0, 0] as const, uvScale: [1, 1] as const };
  return {
    surface, writeBuffer,
    time(t: number) { now = t; },
    update(height: number) { elevation = height; source.revision++; },
    encode() { surface.encode(pass, camera, [tile], source, {} as GPUBindGroup, {} as GPUBindGroup, 1); },
    height() { return surface.sampleElevation(0, 0); },
  };
}

describe('terrain elevation transitions', () => {
  it('continues a replacement transition from the height currently displayed', () => {
    const f = surfaceFixture();
    f.encode();
    f.time(100); f.update(100); f.encode();
    f.time(200);
    expect(f.height()).toBeCloseTo(40);
    f.update(200); f.encode();
    expect(f.height()).toBeCloseTo(40);
    f.time(325);
    expect(f.height()).toBeCloseTo(120);
    f.time(450);
    expect(f.height()).toBeCloseTo(200);
    f.surface.destroy();
  });

  it('does not restart an unchanged mesh when another source tile finishes loading', () => {
    const f = surfaceFixture();
    f.encode();
    f.time(100); f.update(100); f.encode();
    f.time(200); f.update(100);
    f.writeBuffer.mockClear(); f.encode();
    expect(f.height()).toBeCloseTo(40);
    expect(f.writeBuffer).toHaveBeenCalledTimes(1); // Tile uniform only; no geometry upload.
    f.time(350);
    expect(f.height()).toBeCloseTo(100);
    f.surface.destroy();
  });
});
