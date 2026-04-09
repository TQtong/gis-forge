import { describe, it, expect } from 'vitest';
import {
    fillSinks,
    flowDirection,
    flowAccumulation,
    watershed,
    D8_DIRECTIONS,
} from '../../src/packages/analysis/src/raster/hydrology.ts';
import {
    localAdd,
    localSub,
    localMul,
    localDiv,
    localAbs,
    localSqrt,
    localSum,
    localMean,
    localClamp,
    localCondition,
    evaluate,
} from '../../src/packages/analysis/src/raster/map-algebra.ts';
import type { DEMData } from '../../src/packages/analysis/src/raster/index.ts';

function makeDEM(values: number[][]): DEMData {
    return {
        values,
        rows: values.length,
        cols: values[0].length,
        bbox: { west: 0, south: 0, east: 1, north: 1 },
    };
}

describe('fillSinks (Priority-Flood)', () => {
    it('flat DEM returns unchanged', () => {
        const dem = makeDEM([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
        const filled = fillSinks(dem);
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                expect(filled.values[r]![c]).toBeCloseTo(1, 10);
            }
        }
    });
    it('fills a single sink', () => {
        const dem = makeDEM([
            [5, 5, 5],
            [5, 0, 5],
            [5, 5, 5],
        ]);
        const filled = fillSinks(dem);
        // Center cell should be raised to surrounding level
        expect(filled.values[1]![1]!).toBeGreaterThanOrEqual(4.99);
    });
});

describe('flowDirection (D8)', () => {
    it('every cell has a direction in {0, 1, 2, 4, 8, 16, 32, 64, 128}', () => {
        const dem = makeDEM([
            [3, 2, 1],
            [2, 1, 0],
            [1, 0, -1],
        ]);
        const flow = flowDirection(dem);
        const valid = new Set([0, 1, 2, 4, 8, 16, 32, 64, 128]);
        for (let i = 0; i < flow.direction.length; i++) {
            expect(valid.has(flow.direction[i])).toBe(true);
        }
    });
    it('uniform slope produces consistent flow', () => {
        const dem = makeDEM([
            [10, 9, 8],
            [9, 8, 7],
            [8, 7, 6],
        ]);
        const flow = flowDirection(dem);
        // Top-left cell should flow toward bottom-right
        expect(flow.direction[0]).toBe(D8_DIRECTIONS.SOUTHEAST);
    });
});

describe('flowAccumulation', () => {
    it('every cell has at least 1 (self)', () => {
        const dem = makeDEM([
            [3, 2, 1],
            [2, 1, 0],
            [1, 0, -1],
        ]);
        const flow = flowDirection(dem);
        const acc = flowAccumulation(flow);
        for (let i = 0; i < acc.accumulation.length; i++) {
            expect(acc.accumulation[i]).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('watershed', () => {
    it('outlet cell is in the mask', () => {
        const dem = makeDEM([
            [3, 2, 1],
            [4, 3, 2],
            [5, 4, 3],
        ]);
        const flow = flowDirection(dem);
        const mask = watershed(flow, 0, 2);
        expect(mask[0 * 3 + 2]).toBe(1);
    });
});

describe('Map Algebra — local ops', () => {
    const a = makeDEM([[1, 2], [3, 4]]);
    const b = makeDEM([[5, 6], [7, 8]]);

    it('localAdd', () => {
        const r = localAdd(a, b);
        expect(r.values[0]![0]).toBe(6);
        expect(r.values[1]![1]).toBe(12);
    });
    it('localSub with scalar', () => {
        const r = localSub(a, 1);
        expect(r.values[0]![0]).toBe(0);
    });
    it('localMul + scalar', () => {
        const r = localMul(a, 2);
        expect(r.values[1]![1]).toBe(8);
    });
    it('localDiv by zero → NaN', () => {
        const r = localDiv(a, 0);
        expect(Number.isNaN(r.values[0]![0]!)).toBe(true);
    });
    it('localAbs', () => {
        const r = localAbs(makeDEM([[-1, 2], [-3, 4]]));
        expect(r.values[0]![0]).toBe(1);
    });
    it('localSqrt', () => {
        const r = localSqrt(makeDEM([[4, 9], [16, 25]]));
        expect(r.values[0]![0]).toBe(2);
        expect(r.values[1]![1]).toBe(5);
    });
    it('localSum multiple rasters', () => {
        const r = localSum([a, b]);
        expect(r.values[0]![0]).toBe(6);
    });
    it('localMean', () => {
        const r = localMean([a, b]);
        expect(r.values[0]![0]).toBe(3);
    });
    it('localClamp', () => {
        const r = localClamp(a, 2, 3);
        expect(r.values[0]![0]).toBe(2);
        expect(r.values[1]![1]).toBe(3);
    });
    it('localCondition', () => {
        // cond > 0 → return 100 else 0
        const cond = makeDEM([[1, -1], [1, -1]]);
        const r = localCondition(cond, 100, 0);
        expect(r.values[0]![0]).toBe(100);
        expect(r.values[0]![1]).toBe(0);
    });
});

describe('Map Algebra — expression evaluate', () => {
    it('simple sum', () => {
        const a = makeDEM([[1, 2], [3, 4]]);
        const b = makeDEM([[5, 6], [7, 8]]);
        const r = evaluate('a + b', { a, b });
        expect(r.values[0]![0]).toBe(6);
    });
    it('sqrt(a*a + b*b) = hypot', () => {
        const a = makeDEM([[3]]);
        const b = makeDEM([[4]]);
        const r = evaluate('sqrt(a*a + b*b)', { a, b });
        expect(r.values[0]![0]).toBeCloseTo(5, 10);
    });
    it('min/max', () => {
        const a = makeDEM([[1, 5]]);
        const b = makeDEM([[3, 2]]);
        expect(evaluate('min(a, b)', { a, b }).values[0]![0]).toBe(1);
        expect(evaluate('max(a, b)', { a, b }).values[0]![1]).toBe(5);
    });
    it('parenthesized expression', () => {
        const a = makeDEM([[2]]);
        const b = makeDEM([[3]]);
        const r = evaluate('(a + b) * 2', { a, b });
        expect(r.values[0]![0]).toBe(10);
    });
});
