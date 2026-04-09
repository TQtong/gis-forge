import { describe, it, expect } from 'vitest';
import {
    utmForward,
    utmInverse,
    wgs84ToGcj02,
    gcj02ToWgs84,
    gcj02ToBd09,
    bd09ToGcj02,
    equirectangularForward,
    equirectangularInverse,
    lambertAzimuthalForward,
    lambertAzimuthalInverse,
    helmert7,
    helmert7Inverse,
    helmert7CoordinateFrame,
    latToSphericalMercatorY,
    sphericalMercatorYToLat,
    latToEllipsoidalMercatorY,
    ellipsoidalMercatorYToLat,
    sphericalToEllipsoidalMercatorLat,
    ellipsoidalToSphericalMercatorLat,
} from '../../../src/packages/core/src/geo/projection-math.ts';

describe('UTM forward/inverse roundtrip', () => {
    it('Beijing', () => {
        const fwd = utmForward(116.4, 39.9);
        const back = utmInverse(fwd.easting, fwd.northing, fwd.zone, true);
        expect(back[0]).toBeCloseTo(116.4, 4);
        expect(back[1]).toBeCloseTo(39.9, 4);
    });
});

describe('GCJ-02 / BD-09', () => {
    it('WGS84 ↔ GCJ-02 roundtrip in China', () => {
        const gcj = wgs84ToGcj02(116.4, 39.9);
        const back = gcj02ToWgs84(gcj[0], gcj[1]);
        expect(back[0]).toBeCloseTo(116.4, 3);
        expect(back[1]).toBeCloseTo(39.9, 3);
    });
    it('GCJ-02 ↔ BD-09 roundtrip', () => {
        const bd = gcj02ToBd09(116.4, 39.9);
        const back = bd09ToGcj02(bd[0], bd[1]);
        expect(back[0]).toBeCloseTo(116.4, 5);
        expect(back[1]).toBeCloseTo(39.9, 5);
    });
});

describe('Equirectangular', () => {
    it('roundtrip', () => {
        const [x, y] = equirectangularForward(120, 30);
        const [lng, lat] = equirectangularInverse(x, y);
        expect(lng).toBeCloseTo(120, 6);
        expect(lat).toBeCloseTo(30, 6);
    });
});

describe('Lambert Azimuthal Equal-Area (ellipsoidal)', () => {
    it('center of projection is origin', () => {
        const [x, y] = lambertAzimuthalForward(0, 0, 0, 0);
        expect(x).toBeCloseTo(0, 3);
        expect(y).toBeCloseTo(0, 3);
    });
    it('roundtrip nearby point', () => {
        const [x, y] = lambertAzimuthalForward(10, 50, 0, 45);
        const [lng, lat] = lambertAzimuthalInverse(x, y, 0, 45);
        expect(lng).toBeCloseTo(10, 4);
        expect(lat).toBeCloseTo(50, 4);
    });
});

describe('Helmert 7 parameter', () => {
    it('identity transform (all zeros) preserves point', () => {
        const [x, y, z] = helmert7(1000, 2000, 3000, 0, 0, 0, 0, 0, 0, 0);
        expect(x).toBeCloseTo(1000, 6);
        expect(y).toBeCloseTo(2000, 6);
        expect(z).toBeCloseTo(3000, 6);
    });
    it('forward + inverse = identity', () => {
        const args = [1000, 2000, 3000] as const;
        const params = [10, -20, 5, 1e-6, -2e-6, 3e-6, 2] as const;
        const [x, y, z] = helmert7(...args, ...params);
        const [bx, by, bz] = helmert7Inverse(x, y, z, ...params);
        expect(bx).toBeCloseTo(1000, 3);
        expect(by).toBeCloseTo(2000, 3);
        expect(bz).toBeCloseTo(3000, 3);
    });
    it('CF convention = PV with negated rotations', () => {
        const pv = helmert7(1000, 2000, 3000, 10, 20, 30, 1e-6, 2e-6, 3e-6, 1);
        const cf = helmert7CoordinateFrame(1000, 2000, 3000, 10, 20, 30, -1e-6, -2e-6, -3e-6, 1);
        expect(cf[0]).toBeCloseTo(pv[0], 6);
        expect(cf[1]).toBeCloseTo(pv[1], 6);
        expect(cf[2]).toBeCloseTo(pv[2], 6);
    });
});

describe('Mercator y closed-form', () => {
    it('spherical roundtrip', () => {
        const y = latToSphericalMercatorY(45);
        expect(sphericalMercatorYToLat(y)).toBeCloseTo(45, 6);
    });
    it('ellipsoidal roundtrip', () => {
        const y = latToEllipsoidalMercatorY(45);
        expect(ellipsoidalMercatorYToLat(y)).toBeCloseTo(45, 6);
    });
    it('spherical → ellipsoidal differs at high latitudes', () => {
        const ellLat = sphericalToEllipsoidalMercatorLat(60);
        expect(ellLat).not.toBe(60);
        const back = ellipsoidalToSphericalMercatorLat(ellLat);
        expect(back).toBeCloseTo(60, 6);
    });
});
