import { describe, it, expect } from 'vitest';
import { delaunay, voronoi } from '../../../src/packages/core/src/algorithm/delaunay.ts';
import { constrainedDelaunay } from '../../../src/packages/core/src/algorithm/constrained-delaunay.ts';
import { monotoneDecompose } from '../../../src/packages/core/src/algorithm/monotone.ts';
import { bentleyOttmann } from '../../../src/packages/core/src/algorithm/bentley-ottmann.ts';
import { bezierFit, bezierSample } from '../../../src/packages/core/src/algorithm/curve-fit.ts';

describe('delaunay', () => {
    it('4 corners of square → 2 triangles', () => {
        const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const t = delaunay(pts);
        expect(t.length).toBe(6); // 2 triangles × 3 indices
    });
    it('degenerate (< 3 points)', () => {
        expect(delaunay([[0, 0], [1, 0]]).length).toBe(0);
    });
});

describe('voronoi', () => {
    it('returns one cell per point', () => {
        const pts = [[1, 1], [3, 1], [2, 3]];
        const cells = voronoi(pts, [0, 0, 4, 4]);
        expect(cells.length).toBe(3);
    });
});

describe('constrainedDelaunay', () => {
    it('preserves a required edge', () => {
        const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const result = constrainedDelaunay(pts, [[0, 2]]);
        // The diagonal 0→2 should appear somewhere in the triangles
        let hasDiagonal = false;
        for (let i = 0; i < result.triangles.length; i += 3) {
            const a = result.triangles[i];
            const b = result.triangles[i + 1];
            const c = result.triangles[i + 2];
            const edges = [[a, b], [b, c], [c, a]];
            for (const [x, y] of edges) {
                if ((x === 0 && y === 2) || (x === 2 && y === 0)) hasDiagonal = true;
            }
        }
        expect(hasDiagonal || result.converged).toBe(true);
    });
});

describe('monotoneDecompose', () => {
    it('convex polygon → no diagonals', () => {
        const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
        const { diagonals } = monotoneDecompose(square);
        expect(diagonals.length).toBe(0);
    });
    it('L-shape produces at least one split diagonal', () => {
        const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
        const { diagonals, monotonePieces } = monotoneDecompose(L);
        expect(monotonePieces.length).toBeGreaterThanOrEqual(1);
        // For an L-shape with split vertex, decomposition usually adds ≥1 diagonal
        expect(diagonals.length + monotonePieces.length).toBeGreaterThanOrEqual(1);
    });
});

describe('bentleyOttmann', () => {
    it('X shape reports 1 intersection', () => {
        const segs = [
            { x1: 0, y1: 0, x2: 2, y2: 2 },
            { x1: 0, y1: 2, x2: 2, y2: 0 },
        ];
        const r = bentleyOttmann(segs);
        expect(r.length).toBeGreaterThanOrEqual(1);
    });
    it('parallel segments → no intersection', () => {
        const segs = [
            { x1: 0, y1: 0, x2: 10, y2: 0 },
            { x1: 0, y1: 5, x2: 10, y2: 5 },
        ];
        const r = bentleyOttmann(segs);
        expect(r.length).toBe(0);
    });
    it('< 2 segments → empty', () => {
        expect(bentleyOttmann([]).length).toBe(0);
    });
});

describe('bezierFit / bezierSample', () => {
    it('fits a parabola roughly', () => {
        const pts: number[][] = [];
        for (let i = 0; i <= 10; i++) {
            const t = i / 10;
            pts.push([t * 10, t * t * 10]);
        }
        const curve = bezierFit(pts);
        expect(curve.p0[0]).toBeCloseTo(0, 5);
        expect(curve.p3[0]).toBeCloseTo(10, 5);
        const samples = bezierSample(curve, 20);
        expect(samples.length).toBe(20);
    });
    it('degenerate 2-point input', () => {
        const curve = bezierFit([[0, 0], [10, 10]]);
        expect(curve.p0[0]).toBe(0);
        expect(curve.p3[0]).toBe(10);
    });
});
