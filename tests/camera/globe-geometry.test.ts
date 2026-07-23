import { describe, expect, it } from 'vitest';

import { createCamera3D } from '../../src/packages/camera-3d/src/Camera3D.ts';
import type { Viewport } from '../../src/packages/core/src/types/viewport.ts';
import { tileKeyAuto } from '../../src/packages/core/src/geo/tiling-scheme.ts';
import { Geographic } from '../../src/packages/core/src/geo/geographic-tiling-scheme.ts';
import {
  coveringTilesGlobe,
  screenToGlobe,
  tessellateGlobeTile,
} from '../../src/packages/globe/src/globe-tile-mesh.ts';
import { computeGlobeCamera } from '../../src/packages/preset-3d/src/globe-camera.ts';

const DEG2RAD = Math.PI / 180;
const VIEWPORT: Viewport = {
  width: 1280,
  height: 720,
  physicalWidth: 1280,
  physicalHeight: 720,
  pixelRatio: 1,
};

describe('Globe geometry and visibility', () => {
  it('projects the viewport center onto the nadir ground point and schedules visible tiles', () => {
    const camera = createCamera3D({
      position: { lon: 116.3974, lat: 39.9093, alt: 2_000_000 },
      bearing: 0,
      pitch: -90 * DEG2RAD,
    });
    const state = camera.update(0, VIEWPORT);
    const globeCamera = computeGlobeCamera(camera, state, VIEWPORT);
    const hit = screenToGlobe(
      VIEWPORT.width / 2,
      VIEWPORT.height / 2,
      globeCamera.inverseVP_ECEF,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    const tiles = coveringTilesGlobe(globeCamera);

    expect(hit).not.toBeNull();
    expect(hit![0]).toBeCloseTo(116.3974, 4);
    expect(hit![1]).toBeCloseTo(39.9093, 4);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(300);
    expect(new Set(tiles.map((tile) => String(tile.key))).size).toBe(tiles.length);
  });

  it('generates outward-facing main-surface triangles', () => {
    const segments = 4;
    const mesh = tessellateGlobeTile(3, 4, 4, segments);
    const mainIndexCount = segments * segments * 6;

    for (let i = 0; i < mainIndexCount; i += 3) {
      const ia = mesh.indices[i] * 3;
      const ib = mesh.indices[i + 1] * 3;
      const ic = mesh.indices[i + 2] * 3;
      const ax = mesh.positions[ia], ay = mesh.positions[ia + 1], az = mesh.positions[ia + 2];
      const ux = mesh.positions[ib] - ax;
      const uy = mesh.positions[ib + 1] - ay;
      const uz = mesh.positions[ib + 2] - az;
      const vx = mesh.positions[ic] - ax;
      const vy = mesh.positions[ic + 1] - ay;
      const vz = mesh.positions[ic + 2] - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const cx = (ax + mesh.positions[ib] + mesh.positions[ic]) / 3;
      const cy = (ay + mesh.positions[ib + 1] + mesh.positions[ic + 1]) / 3;
      const cz = (az + mesh.positions[ib + 2] + mesh.positions[ic + 2]) / 3;
      expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(0);
    }
  });

  it('uses collision-free string keys above the numeric tile-key range', () => {
    const a = tileKeyAuto(0, 24, 1, 1);
    const b = tileKeyAuto(0, 24, 1 + 0x40000, 1);

    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });

  it('keeps Geographic coverage inside its 2x1 root tile matrix', () => {
    const camera = createCamera3D({
      position: { lon: 116.3974, lat: 39.9093, alt: 2_000_000 },
      bearing: 0,
      pitch: -90 * DEG2RAD,
    });
    const state = camera.update(0, VIEWPORT);
    const globeCamera = { ...computeGlobeCamera(camera, state, VIEWPORT), zoom: 3 };
    const tiles = coveringTilesGlobe(globeCamera, Geographic);

    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.schemeId).toBe(Geographic.id);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(Geographic.numX(tile.z));
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(Geographic.numY(tile.z));
    }
  });
});
