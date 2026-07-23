import { describe, expect, it } from 'vitest';

import {
  computeTerrainSkirtDepth,
  computeTerrainVertexNormals,
  sampleDecodedTerrainElevation,
} from '../../src/packages/layer-cesium-terrain/src/CesiumTerrainLayer.ts';
import { lngLatToMercatorPixel } from '../../src/packages/layer-cesium-terrain/src/mercator.ts';
import { FLOATS_PER_VERTEX, TILE_PIXEL_SIZE, type DecodedTerrainTile } from '../../src/packages/layer-cesium-terrain/src/types.ts';

describe('terrain geometry helpers', () => {
  it('bounds skirts to local terrain relief instead of a kilometre-scale wall', () => {
    expect(computeTerrainSkirtDepth(100, 200)).toBe(10);
    expect(computeTerrainSkirtDepth(-500, 1500)).toBe(100);
    expect(computeTerrainSkirtDepth(-1000, 9000)).toBe(200);
  });

  it('orients reprojected mesh normals toward local up', () => {
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
    const normals = new Float32Array(9);
    computeTerrainVertexNormals(positions, new Uint16Array([0, 2, 1]), normals);

    expect(normals[2]).toBeCloseTo(1);
    expect(normals[5]).toBeCloseTo(1);
    expect(normals[8]).toBeCloseTo(1);
  });

  it('interpolates the actual triangle height at a queried coordinate', () => {
    const bbox = [-10, -10, 10, 10] as const;
    const [centerX, centerY] = lngLatToMercatorPixel(0, 0, TILE_PIXEL_SIZE);
    const corners = [
      [-10, 10, 0],
      [10, 10, 100],
      [-10, -10, 50],
      [10, -10, 150],
    ] as const;
    const vertices = new Float32Array(corners.length * FLOATS_PER_VERTEX);
    for (let i = 0; i < corners.length; i++) {
      const [x, y] = lngLatToMercatorPixel(corners[i][0], corners[i][1], TILE_PIXEL_SIZE);
      vertices[i * FLOATS_PER_VERTEX] = x - centerX;
      vertices[i * FLOATS_PER_VERTEX + 1] = y - centerY;
      vertices[i * FLOATS_PER_VERTEX + 2] = corners[i][2];
    }
    const indices = new Uint16Array([0, 2, 1, 1, 2, 3]);
    const tile: DecodedTerrainTile = {
      coord: { z: 0, x: 1, y: 0 },
      vertices,
      indices,
      vertexCount: 4,
      indexCount: 6,
      mainIndexCount: 6,
      bbox,
      heightRange: [0, 150],
      tileCenterMercatorPxZ0: [centerX, centerY],
      tileCenterLngLat: [0, 0],
      drapeOsm: { z: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
      byteSize: vertices.byteLength + indices.byteLength,
    };

    expect(sampleDecodedTerrainElevation(tile, 0, 0)).toBeCloseTo(75, 4);
    expect(sampleDecodedTerrainElevation(tile, 30, 0)).toBeNull();
  });
});
