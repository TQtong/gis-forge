import { describe, it, expect } from 'vitest';
import {
    segmentSegment,
    rayAABB,
    rayTriangle,
    rayOBB,
    planeSphere,
    PlaneSphereRelation,
    bboxOverlap,
} from '../../../src/packages/core/src/algorithm/intersect.ts';

describe('segmentSegment', () => {
    it('crossing X', () => {
        const r = segmentSegment(0, 0, 2, 2, 0, 2, 2, 0)!;
        expect(r.x).toBeCloseTo(1, 10);
        expect(r.y).toBeCloseTo(1, 10);
        expect(r.t).toBeCloseTo(0.5, 10);
        expect(r.u).toBeCloseTo(0.5, 10);
    });
    it('parallel → null', () => {
        expect(segmentSegment(0, 0, 1, 0, 0, 1, 1, 1)).toBeNull();
    });
    it('no intersection in range', () => {
        expect(segmentSegment(0, 0, 1, 0, 2, -1, 2, 1)).toBeNull();
    });
});

describe('rayAABB', () => {
    it('hit from outside', () => {
        const t = rayAABB(-5, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 1, 1, 1);
        expect(t).toBeCloseTo(5, 10);
    });
    it('miss', () => {
        const t = rayAABB(-5, 2, 2, 1, 0, 0, 0, 0, 0, 1, 1, 1);
        expect(t).toBe(-1);
    });
});

describe('rayTriangle (Möller-Trumbore)', () => {
    it('hit through center of +Z facing triangle', () => {
        const hit = rayTriangle(
            0.25, 0.25, -1,    // origin below
            0, 0, 1,           // ray up
            0, 0, 0,  1, 0, 0,  0, 1, 0,
        );
        expect(hit).not.toBeNull();
        expect(hit!.t).toBeCloseTo(1, 10);
        expect(hit!.u + hit!.v).toBeLessThan(1);
    });
    it('miss — ray parallel', () => {
        const hit = rayTriangle(
            0, 0, 5, 1, 0, 0,
            0, 0, 0,  1, 0, 0,  0, 1, 0,
        );
        expect(hit).toBeNull();
    });
    it('miss — outside triangle', () => {
        const hit = rayTriangle(
            5, 5, -1, 0, 0, 1,
            0, 0, 0,  1, 0, 0,  0, 1, 0,
        );
        expect(hit).toBeNull();
    });
});

describe('rayOBB', () => {
    it('hit axis-aligned cube (OBB = AABB identity axes)', () => {
        const t = rayOBB(
            -5, 0, 0, 1, 0, 0,  // origin, dir
            0, 0, 0,             // center
            1, 0, 0, 0, 1, 0, 0, 0, 1, // axes
            1, 1, 1,             // half extents
        );
        expect(t).toBeCloseTo(4, 10);
    });
});

describe('planeSphere', () => {
    it('front', () => {
        expect(planeSphere(0, 1, 0, 0, 0, 5, 0, 1)).toBe(PlaneSphereRelation.FRONT);
    });
    it('back', () => {
        expect(planeSphere(0, 1, 0, 0, 0, -5, 0, 1)).toBe(PlaneSphereRelation.BACK);
    });
    it('intersecting', () => {
        expect(planeSphere(0, 1, 0, 0, 0, 0.5, 0, 1)).toBe(PlaneSphereRelation.INTERSECTING);
    });
});

describe('bboxOverlap', () => {
    it('overlapping', () => {
        expect(bboxOverlap(
            { west: 0, south: 0, east: 10, north: 10 },
            { west: 5, south: 5, east: 15, north: 15 },
        )).toBe(true);
    });
    it('disjoint', () => {
        expect(bboxOverlap(
            { west: 0, south: 0, east: 10, north: 10 },
            { west: 11, south: 11, east: 20, north: 20 },
        )).toBe(false);
    });
});
