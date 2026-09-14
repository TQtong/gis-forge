/** A terrain source supplies elevations to the single raster surface; it never draws a second map. */
export interface TerrainSurfaceSource {
  /** Conservative source elevation bounds in metres, before exaggeration. */
  readonly elevationRange: readonly [number, number];
  readonly revision: number;
  readonly exaggeration: number;
  readonly hillshade: number;
  readonly lightDirection: readonly [number, number, number];
  sampleElevation(lng: number, lat: number): number | null;
}
