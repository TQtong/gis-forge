import { describe, it, expect } from 'vitest';
import {
    sutherlandHodgman,
    cohenSutherland,
    liangBarsky,
    polygonSplit,
} from '../../../src/packages/core/src/algorithm/clip.ts';

describe('sutherlandHodgman', () => {
    it('rectangle fully inside clip window', () => {
        const r = sutherlandHodgman([[1, 1], [9, 1], [9, 9], [1, 9]], [0, 0, 10, 10]);
        expect(r.length).toBe(4);
    });
    it('rectangle partially clipped', () => {
        const r = sutherlandHodgman([[-5, 5], [5, 5], [5, 15], [-5, 15]], [0, 0, 10, 10]);
        expect(r.length).toBeGreaterThanOrEqual(3);
        // All points should be within clip window
        for (const p of r) {
            expect(p[0]).toBeGreaterThanOrEqual(0);
            expect(p[0]).toBeLessThanOrEqual(10);
        }
    });
    it('rectangle fully outside → empty', () => {
        const r = sutherlandHodgman([[20, 20], [30, 20], [30, 30], [20, 30]], [0, 0, 10, 10]);
        expect(r.length).toBe(0);
    });
});

describe('cohenSutherland', () => {
    it('segment fully inside', () => {
        const r = cohenSutherland(1, 1, 9, 9, 0, 0, 10, 10);
        expect(r).not.toBeNull();
        expect(r![0]).toBeCloseTo(1, 10);
        expect(r![3]).toBeCloseTo(9, 10);
    });
    it('segment entering from left', () => {
        const r = cohenSutherland(-5, 5, 5, 5, 0, 0, 10, 10);
        expect(r).not.toBeNull();
        expect(r![0]).toBeCloseTo(0, 10);
    });
    it('segment fully outside', () => {
        const r = cohenSutherland(-5, 15, -5, 20, 0, 0, 10, 10);
        expect(r).toBeNull();
    });
});

describe('liangBarsky', () => {
    it('crossing diagonal', () => {
        const r = liangBarsky(-5, -5, 15, 15, 0, 0, 10, 10);
        expect(r).not.toBeNull();
        expect(r![0]).toBeCloseTo(0, 10);
        expect(r![1]).toBeCloseTo(0, 10);
        expect(r![2]).toBeCloseTo(10, 10);
        expect(r![3]).toBeCloseTo(10, 10);
    });
});

describe('polygonSplit', () => {
    it('split square by vertical line at x=5', () => {
        const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const [a, b] = polygonSplit(square, 5, -1, 5, 11);
        expect(a.length).toBeGreaterThanOrEqual(3);
        expect(b.length).toBeGreaterThanOrEqual(3);
        // The two pieces together cover the square; each piece stays on one side.
        // Identify which piece is left (contains x<5) vs right (x>5)
        const aHasLow = a.some((p) => p[0] < 5);
        const aHasHigh = a.some((p) => p[0] > 5);
        const bHasLow = b.some((p) => p[0] < 5);
        const bHasHigh = b.some((p) => p[0] > 5);
        // Each piece should be on one side (not straddling)
        expect(aHasLow && aHasHigh).toBe(false);
        expect(bHasLow && bHasHigh).toBe(false);
    });
});
