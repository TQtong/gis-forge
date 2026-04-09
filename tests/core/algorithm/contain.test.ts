import { describe, it, expect } from 'vitest';
import {
    pointInPolygon,
    pointInPolygonWinding,
    pointInTriangle,
    pointInBBox,
    pointOnLine,
    pointToPolygonDistance,
} from '../../../src/packages/core/src/algorithm/contain.ts';

const square: number[][] = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe('pointInPolygon (ray-cast)', () => {
    it('returns true for interior point', () => {
        expect(pointInPolygon([5, 5], square)).toBe(true);
    });
    it('returns false for exterior point', () => {
        expect(pointInPolygon([15, 5], square)).toBe(false);
    });
    it('returns false for degenerate polygon', () => {
        expect(pointInPolygon([5, 5], [[0, 0], [1, 1]])).toBe(false);
    });
});

describe('pointInPolygonWinding', () => {
    it('agrees with ray-cast on simple polygons', () => {
        expect(pointInPolygonWinding([5, 5], square)).toBe(true);
        expect(pointInPolygonWinding([15, 5], square)).toBe(false);
    });
    it('handles self-intersecting star correctly', () => {
        // 5-pointed star — inner pentagon should be "inside" (nonzero winding)
        const star = [
            [0, 3], [1, 1], [3, 1], [1.5, -0.5], [2.5, -3],
            [0, -1.5], [-2.5, -3], [-1.5, -0.5], [-3, 1], [-1, 1],
        ];
        expect(pointInPolygonWinding([0, 0], star)).toBe(true);
    });
});

describe('pointInTriangle', () => {
    it('returns true for centroid', () => {
        expect(pointInTriangle(1, 1, 0, 0, 3, 0, 0, 3)).toBe(true);
    });
    it('returns false for exterior', () => {
        expect(pointInTriangle(5, 5, 0, 0, 3, 0, 0, 3)).toBe(false);
    });
    it('returns false for degenerate (collinear)', () => {
        expect(pointInTriangle(1, 1, 0, 0, 1, 1, 2, 2)).toBe(false);
    });
});

describe('pointInBBox', () => {
    it('inside', () => {
        expect(pointInBBox(5, 5, 0, 0, 10, 10)).toBe(true);
    });
    it('on boundary', () => {
        expect(pointInBBox(0, 5, 0, 0, 10, 10)).toBe(true);
    });
    it('outside', () => {
        expect(pointInBBox(15, 5, 0, 0, 10, 10)).toBe(false);
    });
    it('rejects NaN', () => {
        expect(pointInBBox(NaN, 5, 0, 0, 10, 10)).toBe(false);
    });
});

describe('pointOnLine', () => {
    it('point on segment interior', () => {
        expect(pointOnLine(5, 0, 0, 0, 10, 0, 1e-6)).toBe(true);
    });
    it('point slightly off', () => {
        expect(pointOnLine(5, 0.01, 0, 0, 10, 0, 1e-6)).toBe(false);
    });
    it('point beyond endpoint', () => {
        expect(pointOnLine(15, 0, 0, 0, 10, 0, 1e-6)).toBe(false);
    });
});

describe('pointToPolygonDistance', () => {
    const poly = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    it('exterior point → distance to nearest edge', () => {
        expect(pointToPolygonDistance(15, 5, poly)).toBeCloseTo(5, 10);
    });
    it('interior point → distance to nearest edge', () => {
        expect(pointToPolygonDistance(5, 5, poly)).toBeCloseTo(5, 10);
    });
    it('point on vertex → 0', () => {
        expect(pointToPolygonDistance(0, 0, poly)).toBeCloseTo(0, 10);
    });
});
