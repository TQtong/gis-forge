import { describe, it, expect } from 'vitest';
import { BooleanOps, martinez } from '../../src/packages/analysis/src/boolean/index.ts';
import type { Feature } from '../../src/packages/core/src/types/feature.ts';
import type { PolygonGeometry } from '../../src/packages/core/src/types/geometry.ts';

function poly(coords: number[][][]): Feature<PolygonGeometry> {
    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: coords },
        properties: {},
    };
}

const squareA = poly([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
const squareB = poly([[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]]);

describe('BooleanOps.isValid', () => {
    it('returns true for a valid square', () => {
        expect(BooleanOps.isValid(squareA)).toBe(true);
    });
    it('returns false for null input', () => {
        expect(BooleanOps.isValid(null as unknown as Feature<PolygonGeometry>)).toBe(false);
    });
    it('returns false for self-intersecting bowtie', () => {
        const bowtie = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]);
        expect(BooleanOps.isValid(bowtie)).toBe(false);
    });
});

describe('BooleanOps.kinks', () => {
    it('empty on clean polygon', () => {
        expect(BooleanOps.kinks(squareA).length).toBe(0);
    });
    it('detects bowtie self-intersection', () => {
        const bowtie = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]);
        expect(BooleanOps.kinks(bowtie).length).toBeGreaterThan(0);
    });
});

describe('BooleanOps.intersection (Sutherland-Hodgman)', () => {
    it('overlapping squares produce a result', () => {
        const r = BooleanOps.intersection(squareA, squareB);
        expect(r).not.toBeNull();
    });
});

describe('martinez (strict tests — polygon-clipping backed)', () => {
    const a = [[[0, 0], [10, 0], [10, 10], [0, 10]]] as [number, number][][];
    const b = [[[5, 5], [15, 5], [15, 15], [5, 15]]] as [number, number][][];

    it('intersection of two overlapping squares returns a polygon', () => {
        const r = martinez(a, b, 'intersection');
        expect(r.length).toBeGreaterThanOrEqual(1);
        // Each output polygon has at least one ring
        expect(r[0].length).toBeGreaterThanOrEqual(1);
        // Outer ring points should be in the overlap region [5, 10] × [5, 10]
        const outer = r[0][0];
        for (const p of outer) {
            expect(p[0]).toBeGreaterThanOrEqual(5 - 1e-6);
            expect(p[0]).toBeLessThanOrEqual(10 + 1e-6);
            expect(p[1]).toBeGreaterThanOrEqual(5 - 1e-6);
            expect(p[1]).toBeLessThanOrEqual(10 + 1e-6);
        }
    });

    it('disjoint intersection → empty', () => {
        const c = [[[0, 0], [1, 0], [1, 1], [0, 1]]] as [number, number][][];
        const d = [[[10, 10], [11, 10], [11, 11], [10, 11]]] as [number, number][][];
        expect(martinez(c, d, 'intersection').length).toBe(0);
    });

    it('difference returns the non-overlapping part of subject', () => {
        const r = martinez(a, b, 'difference');
        expect(r.length).toBeGreaterThanOrEqual(1);
    });

    it('XOR on disjoint inputs returns union (2 separate polygons)', () => {
        const c = [[[0, 0], [1, 0], [1, 1], [0, 1]]] as [number, number][][];
        const d = [[[10, 10], [11, 10], [11, 11], [10, 11]]] as [number, number][][];
        const r = martinez(c, d, 'xor');
        expect(r.length).toBe(2);
    });

    it('outer ring is CCW (positive signed area)', () => {
        const r = martinez(a, b, 'intersection');
        const ring = r[0][0];
        // Shoelace: positive means CCW
        let s = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
        }
        expect(s).toBeGreaterThan(0);
    });

    it('empty subject returns empty for intersection', () => {
        const r = martinez([], b, 'intersection');
        expect(r.length).toBe(0);
    });

    it('empty clipping returns subject for union', () => {
        const r = martinez(a, [], 'union');
        expect(r.length).toBeGreaterThanOrEqual(1);
    });
});
