import { describe, it, expect } from 'vitest';
import {
    vincentyDirect,
    initialBearing,
    finalBearing,
    midpoint,
    intermediatePoint,
    nearestPointOnLine,
    karneyDistance,
    karneyInitialBearing,
    karneyInverse,
    karneyDirect,
} from '../../../src/packages/core/src/geo/geodesic.ts';

const DEG = Math.PI / 180;

describe('vincentyDirect', () => {
    it('zero distance returns origin', () => {
        const r = vincentyDirect(0, 0, 0, 0);
        expect(r.lon).toBe(0);
        expect(r.lat).toBe(0);
    });
    it('1000 km east from equator advances longitude', () => {
        const r = vincentyDirect(0, 0, 90 * DEG, 1000000);
        expect(r.lon).toBeGreaterThan(0);
        expect(Math.abs(r.lat)).toBeLessThan(0.001);
    });
});

describe('initialBearing / finalBearing (radians in/out)', () => {
    it('due east along equator ≈ π/2', () => {
        const b = initialBearing(0, 0, 10 * DEG, 0);
        expect(b).toBeCloseTo(Math.PI / 2, 3);
    });
    it('due north ≈ 0', () => {
        const b = initialBearing(0, 0, 0, 10 * DEG);
        expect(b).toBeCloseTo(0, 3);
    });
    it('finalBearing returns a number', () => {
        const b = finalBearing(0, 0, 10 * DEG, 10 * DEG);
        expect(Number.isFinite(b)).toBe(true);
    });
});

describe('midpoint', () => {
    it('between two equator points', () => {
        const m = midpoint(0, 0, 10 * DEG, 0);
        expect(Number.isFinite(m.lon)).toBe(true);
        expect(Number.isFinite(m.lat)).toBe(true);
        expect(m.lat).toBeCloseTo(0, 6);
    });
});

describe('intermediatePoint', () => {
    it('fraction 0 returns start, fraction 1 returns end', () => {
        const p0 = intermediatePoint(0, 0, 10 * DEG, 0, 0);
        const p1 = intermediatePoint(0, 0, 10 * DEG, 0, 1);
        expect(p0.lon).toBeCloseTo(0, 3);
        expect(p1.lon).toBeCloseTo(10 * DEG, 3);
    });
});

describe('nearestPointOnLine', () => {
    it('query on line returns small distance', () => {
        const r = nearestPointOnLine(
            [5 * DEG, 0],
            [[0, 0], [10 * DEG, 0]],
        );
        expect(r.distance).toBeLessThan(1e-3);
    });
});

describe('karney (strict numeric tests — Vincenty-backed)', () => {
    it('karneyInverse JFK→LHR = 5585233.58 m (GeographicLib exact)', () => {
        const r = karneyInverse(40.7128, -74.006, 51.5074, -0.1278);
        // GeographicLib WGS84 returns s12 = 5585233.578931 m for these coords
        expect(r.s12).toBeCloseTo(5585233.58, 1);
        // Initial azimuth ~51.24°
        expect(r.az1).toBeCloseTo(51.24, 1);
        // Final azimuth ~108.37°
        expect(r.az2).toBeCloseTo(108.37, 1);
    });
    it('karneyInverse zero distance', () => {
        const r = karneyInverse(30, 60, 30, 60);
        expect(r.s12).toBeCloseTo(0, 3);
    });
    it('karneyDistance (wrapper) matches Vincenty on normal inputs', () => {
        const d = karneyDistance(-74.006, 40.7128, -0.1278, 51.5074);
        expect(d / 1000).toBeGreaterThan(5500);
        expect(d / 1000).toBeLessThan(5700);
    });
    it('karneyInitialBearing due east ≈ 90°', () => {
        const b = karneyInitialBearing(0, 0, 10, 0);
        expect(b).toBeCloseTo(90, 1);
    });
    it('karneyDirect roundtrip via inverse (1000 km @ 45°)', () => {
        const d = karneyDirect(0, 0, 45, 1000000);
        expect(Number.isFinite(d.lat2)).toBe(true);
        expect(Number.isFinite(d.lon2)).toBe(true);
        const inv = karneyInverse(0, 0, d.lat2, d.lon2);
        expect(inv.s12).toBeGreaterThan(900000);
        expect(inv.s12).toBeLessThan(1100000);
    });
    it('karneyInverse handles antipodal fallback without NaN', () => {
        const r = karneyInverse(0, 0, 0, 180);
        expect(Number.isFinite(r.s12)).toBe(true);
        // Antipodal distance ≈ π × R ≈ 20 000 km
        expect(r.s12 / 1000).toBeGreaterThan(19000);
        expect(r.s12 / 1000).toBeLessThan(21000);
    });
});
