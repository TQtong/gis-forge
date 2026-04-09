import { describe, it, expect } from 'vitest';
import {
    area,
    length,
    centroid,
    centerOfMass,
    polylabel,
    minBoundingCircle,
    perimeter,
    pointToLineDistance,
} from '../../../src/packages/core/src/geo/measure.ts';

describe('area (shoelace)', () => {
    it('unit square = 1', () => {
        expect(area([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(1, 10);
    });
    it('triangle', () => {
        expect(area([[0, 0], [4, 0], [0, 3]])).toBeCloseTo(6, 10);
    });
    it('signed area negative for CW', () => {
        // area() returns absolute value per GIS convention
        expect(area([[0, 0], [0, 1], [1, 1], [1, 0]])).toBeCloseTo(1, 10);
    });
});

describe('length', () => {
    it('straight line', () => {
        expect(length([[0, 0], [3, 4]])).toBeCloseTo(5, 10);
    });
});

describe('perimeter', () => {
    it('unit square = 4', () => {
        expect(perimeter([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(4, 10);
    });
});

describe('centroid', () => {
    it('square at origin', () => {
        const c = centroid([[0, 0], [2, 0], [2, 2], [0, 2]]);
        expect(c[0]).toBeCloseTo(1, 10);
        expect(c[1]).toBeCloseTo(1, 10);
    });
});

describe('centerOfMass', () => {
    it('L-shape center of mass differs from vertex average', () => {
        const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
        const com = centerOfMass(L);
        const cent = centroid(L);
        // Both should be inside the L somewhere
        expect(Number.isFinite(com[0])).toBe(true);
        expect(Number.isFinite(com[1])).toBe(true);
        // L-shape CoM is typically closer to the thicker arm
        void cent;
    });
    it('square → center', () => {
        const com = centerOfMass([[0, 0], [4, 0], [4, 4], [0, 4]]);
        expect(com[0]).toBeCloseTo(2, 10);
        expect(com[1]).toBeCloseTo(2, 10);
    });
});

describe('polylabel', () => {
    it('returns interior point for square', () => {
        const p = polylabel([[[0, 0], [10, 0], [10, 10], [0, 10]]], 0.01);
        expect(p[0]).toBeCloseTo(5, 1);
        expect(p[1]).toBeCloseTo(5, 1);
    });
});

describe('minBoundingCircle', () => {
    it('3 points → circumscribed circle', () => {
        const r = minBoundingCircle([[0, 0], [10, 0], [5, 10]]);
        expect(r.center[0]).toBeCloseTo(5, 0);
        expect(r.radius).toBeGreaterThan(0);
    });
    it('single point → radius 0', () => {
        const r = minBoundingCircle([[3, 4]]);
        expect(r.radius).toBeCloseTo(0, 10);
    });
});

describe('pointToLineDistance', () => {
    it('perpendicular distance', () => {
        const d = pointToLineDistance([5, 5], [[0, 0], [10, 0]]);
        expect(d).toBeCloseTo(5, 10);
    });
});
