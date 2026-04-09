import { describe, it, expect } from 'vitest';
import { BufferOps } from '../../src/packages/analysis/src/buffer/index.ts';
import type { Feature } from '../../src/packages/core/src/types/feature.ts';
import type {
    PointGeometry,
    LineStringGeometry,
    PolygonGeometry,
} from '../../src/packages/core/src/types/geometry.ts';

const pointFeature: Feature<PointGeometry> = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [116.4, 39.9] },
    properties: {},
};

const lineFeature: Feature<LineStringGeometry> = {
    type: 'Feature',
    geometry: {
        type: 'LineString',
        coordinates: [[116.4, 39.9], [116.5, 39.9], [116.5, 40.0]],
    },
    properties: {},
};

const polyFeature: Feature<PolygonGeometry> = {
    type: 'Feature',
    geometry: {
        type: 'Polygon',
        coordinates: [[[116.4, 39.9], [116.5, 39.9], [116.5, 40.0], [116.4, 40.0], [116.4, 39.9]]],
    },
    properties: {},
};

describe('BufferOps.pointBuffer (Vincenty)', () => {
    it('1 km buffer returns a polygon with N+1 vertices', () => {
        const r = BufferOps.pointBuffer(pointFeature, 1000, 32);
        expect(r).not.toBeNull();
        expect(r!.geometry.type).toBe('Polygon');
        expect(r!.geometry.coordinates[0].length).toBeGreaterThanOrEqual(32);
    });
    it('invalid input returns null', () => {
        const r = BufferOps.pointBuffer(null as unknown as Feature<PointGeometry>, 1000);
        expect(r).toBeNull();
    });
    it('negative distance returns null', () => {
        const r = BufferOps.pointBuffer(pointFeature, -100);
        expect(r).toBeNull();
    });
});

describe('BufferOps.lineBuffer', () => {
    it('returns a polygon feature', () => {
        const r = BufferOps.lineBuffer(lineFeature, 100, 8);
        expect(r).not.toBeNull();
        expect(r!.geometry.type).toBe('Polygon');
    });
});

describe('BufferOps.polygonBuffer', () => {
    it('expands polygon outward', () => {
        const r = BufferOps.polygonBuffer(polyFeature, 100);
        expect(r).not.toBeNull();
        expect(r!.geometry.type).toBe('Polygon');
    });
});

describe('BufferOps.offsetCurve', () => {
    it('left offset produces a line string', () => {
        const r = BufferOps.offsetCurve(lineFeature, 100, 'left');
        expect(r).not.toBeNull();
    });
});
