import { describe, expect, it } from 'vitest';

import { createCamera3D } from '../../src/packages/camera-3d/src/Camera3D.ts';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function expectAngleDeg(actualRad: number, expectedDeg: number, precision = 5): void {
  expect(actualRad * RAD2DEG).toBeCloseTo(expectedDeg, precision);
}

describe('Camera3D orientation contract', () => {
  it('reports nadir as pitch -90 and preserves the configured bearing', () => {
    const camera = createCamera3D({
      position: { lon: 116.3974, lat: 39.9093, alt: 20_000_000 },
      bearing: 0,
      pitch: -90 * DEG2RAD,
    });

    const orientation = camera.getOrientation();
    expectAngleDeg(orientation.pitch, -90);
    expectAngleDeg(orientation.bearing, 0);
  });

  it('setting bearing and pitch does not move the camera position', () => {
    const camera = createCamera3D({
      position: { lon: 12.5, lat: 48.25, alt: 750_000 },
      bearing: 30 * DEG2RAD,
      pitch: -45 * DEG2RAD,
    });

    const position = camera.getPosition();
    const orientation = camera.getOrientation();

    expect(position.lon).toBeCloseTo(12.5, 8);
    expect(position.lat).toBeCloseTo(48.25, 8);
    expect(position.alt).toBeCloseTo(750_000, 4);
    expectAngleDeg(orientation.bearing, 30);
    expectAngleDeg(orientation.pitch, -45);
  });

  it('setOrientation changes only orientation and CameraState exposes the same values', () => {
    const camera = createCamera3D({
      position: { lon: -73.9857, lat: 40.7484, alt: 120_000 },
      bearing: 0,
      pitch: -90 * DEG2RAD,
    });
    const before = camera.getPositionECEF().slice();

    camera.setOrientation(125 * DEG2RAD, -35 * DEG2RAD, 0);

    const after = camera.getPositionECEF();
    expect(Array.from(after)).toEqual(Array.from(before));

    const orientation = camera.getOrientation();
    expectAngleDeg(orientation.bearing, 125);
    expectAngleDeg(orientation.pitch, -35);

    const state = camera.update(0, {
      width: 1280,
      height: 720,
      physicalWidth: 1280,
      physicalHeight: 720,
      pixelRatio: 1,
    });
    expectAngleDeg(state.bearing, 125);
    expectAngleDeg(state.pitch, -35);
  });
});
