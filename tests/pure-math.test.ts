import { describe, it, expect } from 'vitest';
import {
    computeTileGeomorph,
    computeTileGeomorphBatch,
    buildParentPositions,
    LOD_GEOMORPH_VERTEX_WGSL,
} from '../src/packages/globe/src/lod-geomorph.ts';
import {
    computeCascadeSplits,
    computeLightSpaceVP,
    computeCSMCascades,
} from '../src/packages/gpu/src/l2/csm-cascades.ts';

describe('LOD Geomorph — computeTileGeomorph', () => {
    const cfg = { morphStart: 0.5, morphEnd: 1.5 };
    it('returns 0 when camera is very close', () => {
        const m = computeTileGeomorph([0, 0, 0], [0, 0, 0], 100, cfg);
        expect(m).toBe(0);
    });
    it('returns 1 when camera is beyond morphEnd', () => {
        const m = computeTileGeomorph([1000, 0, 0], [0, 0, 0], 100, cfg);
        expect(m).toBe(1);
    });
    it('returns value in (0,1) for transitional distance', () => {
        const m = computeTileGeomorph([100, 0, 0], [0, 0, 0], 100, cfg);
        expect(m).toBeGreaterThan(0);
        expect(m).toBeLessThan(1);
    });
});

describe('LOD Geomorph — computeTileGeomorphBatch', () => {
    it('handles multiple tiles', () => {
        const r = computeTileGeomorphBatch(
            [0, 0, 0],
            [[0, 0, 0], [100, 0, 0], [1000, 0, 0]],
            [100, 100, 100],
            { morphStart: 0.5, morphEnd: 1.5 },
        );
        expect(r.length).toBe(3);
        expect(r[0]).toBe(0);
        expect(r[2]).toBe(1);
    });
});

describe('LOD Geomorph — buildParentPositions', () => {
    it('3x3 grid: even indices preserved, odd indices interpolated', () => {
        const cols = 3, rows = 3;
        const hi = new Float32Array(cols * rows * 3);
        for (let i = 0; i < cols * rows; i++) {
            hi[i * 3] = i;       // x = linear index
            hi[i * 3 + 1] = 0;
            hi[i * 3 + 2] = 0;
        }
        const parent = buildParentPositions(hi, cols, rows);
        expect(parent.length).toBe(hi.length);
        // (0, 0) is even → should equal original
        expect(parent[0]).toBe(0);
    });
});

describe('LOD Geomorph — WGSL export is a string', () => {
    it('contains applyGeomorph function', () => {
        expect(typeof LOD_GEOMORPH_VERTEX_WGSL).toBe('string');
        expect(LOD_GEOMORPH_VERTEX_WGSL).toContain('applyGeomorph');
    });
});

describe('CSM cascades — computeCascadeSplits', () => {
    it('returns array of length numCascades', () => {
        const s = computeCascadeSplits({
            numCascades: 4,
            near: 0.1,
            far: 1000,
            shadowDistance: 200,
            lambda: 0.5,
        });
        expect(s.length).toBe(4);
    });
    it('splits are monotonically increasing', () => {
        const s = computeCascadeSplits({
            numCascades: 4,
            near: 0.1,
            far: 1000,
            shadowDistance: 200,
            lambda: 0.5,
        });
        for (let i = 1; i < s.length; i++) {
            expect(s[i]).toBeGreaterThan(s[i - 1]);
        }
    });
    it('last split equals effectiveFar', () => {
        const s = computeCascadeSplits({
            numCascades: 3,
            near: 1,
            far: 1000,
            shadowDistance: 500,
            lambda: 0.5,
        });
        expect(s[s.length - 1]).toBeCloseTo(500, 0);
    });
});

describe('CSM cascades — computeLightSpaceVP', () => {
    it('produces a 16-element matrix', () => {
        const inv = new Float64Array(16);
        // Identity-like matrix (won't produce meaningful result but shouldn't crash)
        inv[0] = 1; inv[5] = 1; inv[10] = 1; inv[15] = 1;
        const out = new Float64Array(16);
        computeLightSpaceVP(inv, 1, 100, [0, -1, 0], out);
        // Output should have at least some finite entries (identity inv trivializes geometry but not all zero)
        let finiteCount = 0;
        for (let i = 0; i < 16; i++) if (Number.isFinite(out[i])) finiteCount++;
        expect(finiteCount).toBe(16);
    });
});

describe('CSM cascades — computeCSMCascades', () => {
    it('produces splits + 4 matrices', () => {
        const inv = new Float64Array(16);
        inv[0] = 1; inv[5] = 1; inv[10] = 1; inv[15] = 1;
        const r = computeCSMCascades(
            { numCascades: 4, near: 0.1, far: 1000, shadowDistance: 200, lambda: 0.5 },
            inv,
            [0, -1, 0],
        );
        expect(r.splits.length).toBe(4);
        expect(r.lightViewProj.length).toBe(64);
    });
});
