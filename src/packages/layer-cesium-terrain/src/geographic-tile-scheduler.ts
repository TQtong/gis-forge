import type { CameraState } from '../../core/src/types/viewport.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import { computePerspectiveTileCover } from '../../core/src/geo/perspective-tile-cover.ts';
import { DEFAULT_TERRAIN_ELEVATION_RANGE } from '../../core/src/geo/terrain-elevation-range.ts';

export interface GeographicScheduledTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}
export interface GeographicScheduleOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly maxScreenSpaceError?: number;
  readonly minElevation?: number;
  readonly maxElevation?: number;
  readonly previousTiles?: readonly TileCoord[];
}
export interface AvailabilityChecker {
  isTileAvailable(z: number, x: number, y: number): boolean;
}

export function computeGeographicCoveringTiles(camera: CameraState, availability: AvailabilityChecker, opts: GeographicScheduleOptions): GeographicScheduledTile[] {
  const sse = opts.maxScreenSpaceError ?? 4;
  return computePerspectiveTileCover(camera, {
    scheme: 'geographic', minZoom: opts.minZoom, maxZoom: opts.maxZoom,
    maxTiles: 128, viewportHeight: opts.viewportHeight,
    tilePixels: 512 * (Number.isFinite(sse) && sse > 0 ? sse / 4 : 1),
    minElevation: opts.minElevation ?? camera.terrainElevationRange?.[0] ?? DEFAULT_TERRAIN_ELEVATION_RANGE[0],
    maxElevation: opts.maxElevation ?? camera.terrainElevationRange?.[1] ?? DEFAULT_TERRAIN_ELEVATION_RANGE[1],
    previousTiles: opts.previousTiles,
    isAvailable: (z, x, y) => availability.isTileAvailable(z, x, y),
  }).map((tile, distance) => ({ ...tile, distance }));
}
