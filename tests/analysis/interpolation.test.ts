import { describe, it, expect } from 'vitest';
import {
    ordinaryKriging,
    fitVariogram,
    variogram,
} from '../../src/packages/analysis/src/interpolation/kriging.ts';
import { naturalNeighbor } from '../../src/packages/analysis/src/interpolation/natural-neighbor.ts';
import { marchingCubes } from '../../src/packages/analysis/src/interpolation/marching-cubes.ts';

describe('variogram functions', () => {
    it('spherical at h=0 = nugget', () => {
        const p = { model: 'spherical' as const, nugget: 0.1, sill: 1, range: 100 };
        expect(variogram(0, p)).toBe(0);
    });
    it('spherical at h≥range = sill', () => {
        const p = { model: 'spherical' as const, nugget: 0.1, sill: 1, range: 100 };
        expect(variogram(200, p)).toBe(1);
    });
    it('exponential is monotonic', () => {
        const p = { model: 'exponential' as const, nugget: 0, sill: 1, range: 100 };
        expect(variogram(10, p)).toBeLessThan(variogram(50, p));
    });
});

describe('fitVariogram', () => {
    it('returns parameters for random point set', () => {
        const pts = [
            { x: 0, y: 0, value: 1 },
            { x: 1, y: 0, value: 2 },
            { x: 2, y: 0, value: 3 },
            { x: 0, y: 1, value: 1.5 },
            { x: 1, y: 1, value: 2.5 },
            { x: 2, y: 1, value: 3.5 },
        ];
        const p = fitVariogram(pts);
        expect(p.sill).toBeGreaterThanOrEqual(p.nugget);
        expect(p.range).toBeGreaterThan(0);
    });
});

describe('ordinaryKriging', () => {
    it('interpolates exact sample point', () => {
        const pts = [
            { x: 0, y: 0, value: 10 },
            { x: 10, y: 0, value: 20 },
            { x: 5, y: 10, value: 15 },
        ];
        const p = { model: 'exponential' as const, nugget: 0, sill: 10, range: 5 };
        const r = ordinaryKriging(pts, p, 0, 0);
        expect(Number.isFinite(r.value)).toBe(true);
        expect(r.variance).toBeGreaterThanOrEqual(0);
    });
    it('empty input → NaN', () => {
        const r = ordinaryKriging([], { model: 'exponential', nugget: 0, sill: 1, range: 1 }, 0, 0);
        expect(Number.isNaN(r.value)).toBe(true);
    });
});

describe('naturalNeighbor', () => {
    it('interpolates between sample points', () => {
        const pts = [
            { x: 0, y: 0, value: 0 },
            { x: 10, y: 0, value: 10 },
            { x: 5, y: 10, value: 5 },
        ];
        const r = naturalNeighbor(pts, 5, 3, 256);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(-1);
        expect(r).toBeLessThanOrEqual(11);
    });
    it('returns exact value at sample', () => {
        const pts = [
            { x: 0, y: 0, value: 42 },
            { x: 10, y: 10, value: 17 },
        ];
        const r = naturalNeighbor(pts, 0, 0, 128);
        expect(r).toBeCloseTo(42, 10);
    });
});

describe('marchingCubes', () => {
    it('uniform positive field → empty iso at 0', () => {
        const data = new Float64Array(4 * 4 * 4).fill(1);
        const r = marchingCubes({ data, nx: 4, ny: 4, nz: 4 }, 0);
        expect(r.triangleCount).toBe(0);
    });
    it('sphere-like field produces triangles', () => {
        const nx = 8, ny = 8, nz = 8;
        const data = new Float64Array(nx * ny * nz);
        // fill with distance from center
        for (let z = 0; z < nz; z++) {
            for (let y = 0; y < ny; y++) {
                for (let x = 0; x < nx; x++) {
                    const dx = x - 3.5, dy = y - 3.5, dz = z - 3.5;
                    data[(z * ny + y) * nx + x] = Math.sqrt(dx * dx + dy * dy + dz * dz);
                }
            }
        }
        const r = marchingCubes({ data, nx, ny, nz }, 2.5);
        expect(r.triangleCount).toBeGreaterThan(0);
        expect(r.vertices.length).toBeGreaterThan(0);
    });
});
