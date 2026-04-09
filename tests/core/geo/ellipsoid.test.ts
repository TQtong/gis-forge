import { describe, it, expect } from 'vitest';
import {
    WGS84_A,
    geodeticToECEF,
    ecefToGeodetic,
    vincentyDistance,
    haversineDistance,
    ecefToENU,
    enuToECEF,
    closestPointOnEllipsoid,
    distanceToEllipsoid,
} from '../../../src/packages/core/src/geo/ellipsoid.ts';

const DEG = Math.PI / 180;

describe('geodeticToECEF / ecefToGeodetic roundtrip', () => {
    it('equator + prime meridian → (a, 0, 0)', () => {
        const out = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        geodeticToECEF(out, 0, 0, 0);
        expect(out[0]).toBeCloseTo(WGS84_A, 3);
        expect(out[1]).toBeCloseTo(0, 3);
        expect(out[2]).toBeCloseTo(0, 3);
    });
    it('roundtrip London', () => {
        const out = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        geodeticToECEF(out, -0.1278 * DEG, 51.5074 * DEG, 0);
        const g = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        ecefToGeodetic(g, out[0], out[1], out[2]);
        expect(g[0]).toBeCloseTo(-0.1278 * DEG, 8);
        expect(g[1]).toBeCloseTo(51.5074 * DEG, 8);
        expect(g[2]).toBeCloseTo(0, 3);
    });
});

describe('vincentyDistance', () => {
    it('JFK → LHR ≈ 5585 km', () => {
        const d = vincentyDistance(
            -74.006 * DEG, 40.7128 * DEG,
            -0.1278 * DEG, 51.5074 * DEG,
        );
        // Actual great-circle between these coarse coords is ~5585 km
        expect(d / 1000).toBeGreaterThan(5500);
        expect(d / 1000).toBeLessThan(5700);
    });
    it('zero distance', () => {
        const d = vincentyDistance(0, 0, 0, 0);
        expect(d).toBe(0);
    });
});

describe('haversineDistance', () => {
    it('approximates great-circle', () => {
        const d = haversineDistance(0, 0, 0, DEG);
        // 1 degree of latitude ≈ 111 km on the sphere
        expect(d / 1000).toBeCloseTo(111, 0);
    });
});

describe('ENU transformations', () => {
    it('roundtrip ECEF ↔ ENU at origin', () => {
        const enu = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        const back = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        const ecef0 = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        geodeticToECEF(ecef0, 0, 45 * DEG, 0);
        // ECEF point slightly north of origin
        const ecefP = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        geodeticToECEF(ecefP, 0, 45.001 * DEG, 0);
        ecefToENU(enu, ecefP[0], ecefP[1], ecefP[2], 0, 45 * DEG, 0);
        // Should have small E ≈ 0, positive N, small U
        expect(Math.abs(enu[0])).toBeLessThan(1);
        expect(enu[1]).toBeGreaterThan(0);
        enuToECEF(back, enu[0], enu[1], enu[2], 0, 45 * DEG, 0);
        expect(back[0]).toBeCloseTo(ecefP[0], 3);
        expect(back[1]).toBeCloseTo(ecefP[1], 3);
        expect(back[2]).toBeCloseTo(ecefP[2], 3);
        void ecef0;
    });
});

describe('closestPointOnEllipsoid / distanceToEllipsoid', () => {
    it('point in space at (2a, 0, 0) projects to (a, 0, 0)', () => {
        const out = new Float64Array(3) as unknown as import('../../../src/packages/core/src/geo/ellipsoid.ts').Vec3d;
        closestPointOnEllipsoid(out, WGS84_A * 2, 0, 0);
        expect(out[0]).toBeCloseTo(WGS84_A, 3);
        expect(out[1]).toBeCloseTo(0, 3);
        expect(out[2]).toBeCloseTo(0, 3);
    });
    it('distanceToEllipsoid = altitude', () => {
        const d = distanceToEllipsoid(WGS84_A + 1000, 0, 0);
        expect(d).toBeCloseTo(1000, 1);
    });
});
