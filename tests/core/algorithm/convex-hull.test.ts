import { describe, it, expect } from 'vitest';
import {
    convexHull,
    quickHull,
    concaveHull,
    minBoundingBox,
} from '../../../src/packages/core/src/algorithm/convex-hull.ts';

describe('convexHull (Andrew monotone chain)', () => {
    it('square point cloud', () => {
        const pts = [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2]];
        const hull = convexHull(pts);
        expect(hull.length).toBe(4);
    });
    it('handles collinear', () => {
        const pts = [[0, 0], [1, 0], [2, 0], [2, 2], [0, 2]];
        const hull = convexHull(pts);
        // Collinear points on an edge are dropped
        expect(hull.length).toBeGreaterThanOrEqual(3);
    });
});

describe('quickHull', () => {
    it('matches convexHull on simple square', () => {
        const pts = [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2]];
        const hull = quickHull(pts);
        expect(hull.length).toBe(4);
    });
    it('single point', () => {
        expect(quickHull([[1, 2]]).length).toBe(1);
    });
});

describe('concaveHull', () => {
    it('returns at least 3 vertices', () => {
        const pts = [[0, 0], [1, 0], [2, 0], [3, 1], [3, 2], [2, 3], [0, 3], [1, 1]];
        const hull = concaveHull(pts, 3);
        expect(hull.length).toBeGreaterThanOrEqual(3);
    });
    it('small point set falls back', () => {
        expect(concaveHull([[0, 0], [1, 0]], 3).length).toBe(2);
    });
});

describe('minBoundingBox (rotating calipers)', () => {
    it('axis-aligned rectangle', () => {
        const pts = [[0, 0], [4, 0], [4, 2], [0, 2]];
        const r = minBoundingBox(pts)!;
        expect(r.area).toBeCloseTo(8, 8);
        expect(r.halfExtents[0] * 2 + r.halfExtents[1] * 2).toBeCloseTo(6, 8); // perim-half
    });
    it('rotated rectangle finds smaller OBB than AABB', () => {
        // 45-degree rotated unit square — OBB should match the rotated box exactly
        const sqrt2 = Math.SQRT2;
        const pts = [[0, 0], [sqrt2, sqrt2], [0, 2 * sqrt2], [-sqrt2, sqrt2]];
        const r = minBoundingBox(pts)!;
        expect(r.area).toBeCloseTo(4, 3); // 2 × 2 rotated square
    });
    it('empty input → null', () => {
        expect(minBoundingBox([])).toBeNull();
    });
});
