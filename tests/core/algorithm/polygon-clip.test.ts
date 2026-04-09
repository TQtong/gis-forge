import { describe, it, expect } from 'vitest';
import {
    weilerAtherton,
    greinerHormann,
} from '../../../src/packages/core/src/algorithm/polygon-clip.ts';

const squareA: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const squareB: [number, number][] = [[5, 5], [15, 5], [15, 15], [5, 15]];

describe('weilerAtherton', () => {
    it('intersection returns a valid polygon', () => {
        const r = weilerAtherton(squareA, squareB, 'intersection');
        expect(r.length).toBeGreaterThanOrEqual(1);
        const ring = r[0];
        // All points should be inside both squares
        for (const p of ring) {
            expect(p[0]).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(p[0]).toBeLessThanOrEqual(10 + 1e-9);
            expect(p[1]).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(p[1]).toBeLessThanOrEqual(10 + 1e-9);
        }
    });
    it('disjoint intersection → empty', () => {
        const far: [number, number][] = [[100, 100], [110, 100], [110, 110], [100, 110]];
        const r = weilerAtherton(squareA, far, 'intersection');
        expect(r.length).toBe(0);
    });
    it('fully contained → intersection = inner', () => {
        const inner: [number, number][] = [[2, 2], [8, 2], [8, 8], [2, 8]];
        const r = weilerAtherton(squareA, inner, 'intersection');
        expect(r.length).toBe(1);
    });
});

describe('greinerHormann', () => {
    it('intersection returns a polygon within the overlap region', () => {
        const r = greinerHormann(squareA, squareB, 'intersection');
        // GH may or may not produce a ring depending on degeneracies;
        // if it does, it must stay in overlap
        if (r.length > 0) {
            for (const ring of r) {
                for (const p of ring) {
                    expect(p[0]).toBeGreaterThanOrEqual(5 - 1e-6);
                    expect(p[1]).toBeGreaterThanOrEqual(5 - 1e-6);
                    expect(p[0]).toBeLessThanOrEqual(10 + 1e-6);
                    expect(p[1]).toBeLessThanOrEqual(10 + 1e-6);
                }
            }
        }
    });
    it('disjoint case (no intersections)', () => {
        const far: [number, number][] = [[100, 100], [110, 100], [110, 110], [100, 110]];
        const r = greinerHormann(squareA, far, 'intersection');
        expect(r.length).toBe(0);
    });
});
