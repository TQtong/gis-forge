import { describe, it, expect } from 'vitest';
import { createRTree } from '../../../src/packages/core/src/index/rtree.ts';
import { createKDTree } from '../../../src/packages/core/src/index/kd-tree.ts';
import { createQuadTree } from '../../../src/packages/core/src/index/quadtree.ts';
import { createSpatialHash } from '../../../src/packages/core/src/index/spatial-hash.ts';
import { createGridIndex } from '../../../src/packages/core/src/index/grid-index.ts';
import { createOctree } from '../../../src/packages/core/src/index/octree.ts';
import {
    geohashEncode,
    geohashDecode,
    geohashNeighbors,
} from '../../../src/packages/core/src/index/geohash.ts';
import {
    latLngToCellId,
    cellIdToLatLng,
    cellIdLevel,
    cellIdFace,
    cellIdParent,
    cellIdChildren,
} from '../../../src/packages/core/src/index/s2.ts';
import {
    latLngToH3,
    h3ToLatLng,
    h3Resolution,
    h3Parent,
    h3Disk,
    h3IsValid,
} from '../../../src/packages/core/src/index/h3.ts';

describe('RTree', () => {
    it('insert + range search', () => {
        const t = createRTree<string>();
        t.insert({ minX: 0, minY: 0, maxX: 2, maxY: 2, data: 'A' });
        t.insert({ minX: 5, minY: 5, maxX: 7, maxY: 7, data: 'B' });
        const r = t.search({ minX: 1, minY: 1, maxX: 3, maxY: 3 });
        expect(r.length).toBe(1);
        expect(r[0].data).toBe('A');
    });
});

describe('KDTree', () => {
    it('nearest neighbor', () => {
        const t = createKDTree<number>([
            { x: 0, y: 0, data: 0 },
            { x: 1, y: 1, data: 1 },
            { x: 5, y: 5, data: 5 },
            { x: 10, y: 10, data: 10 },
        ]);
        const r = t.nearest(0.1, 0.1);
        expect(r).not.toBeNull();
        expect(r!.data).toBe(0);
    });
});

describe('QuadTree', () => {
    it('insert + search box', () => {
        const t = createQuadTree<string>(0, 0, 100, 100);
        t.insert(10, 10, 'A');
        t.insert(50, 50, 'B');
        t.insert(90, 90, 'C');
        const r = t.search(0, 0, 30, 30);
        expect(r.length).toBe(1);
        expect(r[0].data).toBe('A');
    });
});

describe('SpatialHash', () => {
    it('insert + query', () => {
        const h = createSpatialHash<string>(10);
        h.insert(5, 5, 15, 15, 'A');
        h.insert(100, 100, 110, 110, 'B');
        const r = h.query(0, 0, 20, 20);
        expect(r.length).toBeGreaterThan(0);
        expect(r).toContain('A');
    });
});

describe('GridIndex', () => {
    it('insert + box query', () => {
        const g = createGridIndex<number>(10);
        g.insert({ minX: 5, minY: 5, maxX: 8, maxY: 8, data: 1 });
        g.insert({ minX: 25, minY: 25, maxX: 28, maxY: 28, data: 2 });
        const r = g.query(0, 0, 15, 15);
        expect(r.length).toBe(1);
    });
});

describe('Octree', () => {
    it('insert + searchRadius', () => {
        const t = createOctree<string>(0, 0, 0, 100, 100, 100);
        t.insert(10, 10, 10, 'A');
        t.insert(90, 90, 90, 'B');
        const r = t.searchRadius(10, 10, 10, 5);
        expect(r.length).toBe(1);
        expect(r[0].data).toBe('A');
    });
    it('size tracking', () => {
        const t = createOctree(0, 0, 0, 10, 10, 10);
        expect(t.size()).toBe(0);
        t.insert(1, 1, 1, null);
        t.insert(2, 2, 2, null);
        expect(t.size()).toBe(2);
    });
});

describe('Geohash', () => {
    it('encode London ≈ gcpvj0e', () => {
        const h = geohashEncode(-0.1257, 51.5085, 7);
        expect(h.startsWith('gcpvj')).toBe(true);
    });
    it('decode roundtrip', () => {
        const h = geohashEncode(116.4, 39.9, 9);
        const bounds = geohashDecode(h)!;
        expect(bounds.lng).toBeCloseTo(116.4, 3);
        expect(bounds.lat).toBeCloseTo(39.9, 3);
    });
    it('neighbors returns 8 hashes', () => {
        const n = geohashNeighbors('u4pruyd');
        expect(n.length).toBe(8);
    });
});

describe('S2 Cell', () => {
    it('latLngToCellId returns a BigInt', () => {
        const id = latLngToCellId(51.5, -0.1, 10);
        expect(typeof id).toBe('bigint');
    });
    it('cellIdLevel round-trip', () => {
        const id = latLngToCellId(51.5, -0.1, 10);
        expect(cellIdLevel(id)).toBe(10);
    });
    it('cellIdFace is in [0, 5]', () => {
        const id = latLngToCellId(0, 0, 5);
        const f = cellIdFace(id);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(5);
    });
    it('cellIdToLatLng returns finite coords', () => {
        const id = latLngToCellId(30, 60, 12);
        const [lat, lng] = cellIdToLatLng(id);
        expect(Number.isFinite(lat)).toBe(true);
        expect(Number.isFinite(lng)).toBe(true);
    });
    it('cellIdParent reduces level', () => {
        const id = latLngToCellId(30, 60, 15);
        const p = cellIdParent(id, 10);
        expect(cellIdLevel(p)).toBe(10);
    });
    it('cellIdChildren returns 4 cells', () => {
        const id = latLngToCellId(30, 60, 5);
        const c = cellIdChildren(id);
        expect(c.length).toBe(4);
    });
});

describe('H3 (via h3-js)', () => {
    it('latLngToH3 returns 15-char hex', () => {
        const h = latLngToH3(51.5085, -0.1257, 9);
        expect(h.length).toBe(15);
        expect(h3IsValid(h)).toBe(true);
    });
    it('h3ToLatLng roundtrip', () => {
        const h = latLngToH3(30, 60, 9);
        const [lat, lng] = h3ToLatLng(h);
        expect(lat).toBeCloseTo(30, 1);
        expect(lng).toBeCloseTo(60, 1);
    });
    it('h3Resolution matches', () => {
        const h = latLngToH3(0, 0, 7);
        expect(h3Resolution(h)).toBe(7);
    });
    it('h3Parent at lower res', () => {
        const h = latLngToH3(0, 0, 9);
        const p = h3Parent(h, 5);
        expect(h3Resolution(p)).toBe(5);
    });
    it('h3Disk k=1 returns 7 cells (center + 6 neighbors, or 5 for pentagons)', () => {
        const h = latLngToH3(30, 60, 9);
        const d = h3Disk(h, 1);
        expect(d.length).toBeGreaterThanOrEqual(6);
        expect(d.length).toBeLessThanOrEqual(7);
    });
});
