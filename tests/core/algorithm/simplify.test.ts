import { describe, it, expect } from 'vitest';
import {
    douglasPeucker,
    visvalingam,
    chaikin,
    douglasPeucker3D,
    bspline,
} from '../../../src/packages/core/src/algorithm/simplify.ts';

describe('douglasPeucker', () => {
    it('straight line collapses to 2 points', () => {
        const pts = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
        const r = douglasPeucker(pts, 0.01);
        expect(r.length).toBe(2);
    });
    it('keeps sharp bends above tolerance', () => {
        const pts = [[0, 0], [1, 0], [2, 1], [3, 0], [4, 0]];
        const r = douglasPeucker(pts, 0.5);
        expect(r.length).toBeGreaterThanOrEqual(3);
    });
    it('zero tolerance keeps all points', () => {
        const pts = [[0, 0], [1, 0.1], [2, 0]];
        const r = douglasPeucker(pts, 0);
        expect(r.length).toBe(3);
    });
});

describe('visvalingam', () => {
    it('returns endpoints for any tolerance ≥ total area', () => {
        const pts = [[0, 0], [1, 0.1], [2, 0]];
        const r = visvalingam(pts, 1);
        expect(r.length).toBe(2);
    });
    it('keeps significant vertices', () => {
        const pts = [[0, 0], [5, 5], [10, 0]];
        const r = visvalingam(pts, 0);
        expect(r.length).toBe(3);
    });
});

describe('chaikin', () => {
    it('1 iteration doubles edges', () => {
        const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const r = chaikin(pts, 1, true);
        // Closed 4-gon → 4 edges → 8 new points
        expect(r.length).toBe(8);
    });
    it('3 iterations converges toward rounded shape', () => {
        const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const r = chaikin(pts, 3, true);
        expect(r.length).toBe(4 * 2 ** 3);
    });
    it('open line preserves endpoints', () => {
        const pts = [[0, 0], [10, 0], [10, 10]];
        const r = chaikin(pts, 1, false);
        expect(r[0][0]).toBe(0);
        expect(r[0][1]).toBe(0);
        expect(r[r.length - 1][0]).toBe(10);
        expect(r[r.length - 1][1]).toBe(10);
    });
});

describe('douglasPeucker3D', () => {
    it('collinear 3D line collapses to 2 points', () => {
        const pts = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]];
        const r = douglasPeucker3D(pts, 0.01);
        expect(r.length).toBe(2);
    });
    it('preserves Z-significant detour', () => {
        const pts = [[0, 0, 0], [1, 0, 5], [2, 0, 0]];
        const r = douglasPeucker3D(pts, 0.5);
        expect(r.length).toBe(3);
    });
});

describe('bspline', () => {
    it('3-point cubic spline endpoints equal first/last control points', () => {
        const cp = [[0, 0], [5, 10], [10, 0]];
        const curve = bspline(cp, 2, 20);
        expect(curve[0][0]).toBeCloseTo(0, 10);
        expect(curve[0][1]).toBeCloseTo(0, 10);
        expect(curve[curve.length - 1][0]).toBeCloseTo(10, 10);
        expect(curve[curve.length - 1][1]).toBeCloseTo(0, 10);
    });
    it('returns requested sample count', () => {
        const r = bspline([[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]], 3, 50);
        expect(r.length).toBe(50);
    });
});
