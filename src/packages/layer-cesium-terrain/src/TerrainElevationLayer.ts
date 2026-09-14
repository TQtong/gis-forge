import type { Layer } from '../../scene/src/scene-graph.ts';
import type { TerrainSurfaceSource } from '../../scene/src/terrain-surface.ts';
import type { CesiumTerrainLayerOptions } from './types.ts';
import { CesiumTerrainProvider } from './cesium-terrain-provider.ts';
import { computeGeographicCoveringTiles } from './geographic-tile-scheduler.ts';
import { QuantizedMeshSampler } from './quantized-mesh-sampler.ts';
import { DEFAULT_TERRAIN_ELEVATION_RANGE } from '../../core/src/geo/terrain-elevation-range.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';

export type TerrainElevationLayer = Layer & TerrainSurfaceSource & { readonly provider: CesiumTerrainProvider };

/** 2.5D elevation service. Imagery and geometry are drawn once by RasterTerrainSurface. */
export function createTerrainElevationLayer(opts: CesiumTerrainLayerOptions): TerrainElevationLayer {
  const provider = new CesiumTerrainProvider(opts.url);
  const cache = new Map<string, QuantizedMeshSampler>();
  const requests = new Set<string>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  let wanted = new Set<string>();
  let previousTiles: readonly TileCoord[] = [];
  let mounted = false, revision = 0, bytes = 0;
  let elevationRange: readonly [number, number] = DEFAULT_TERRAIN_ELEVATION_RANGE;
  let context: Parameters<Layer['onAdd']>[0] | null = null;
  let initPending = false, initRetryAt = 0;
  const paint = new Map(Object.entries(opts.paint ?? {}));
  const layout = new Map(Object.entries(opts.layout ?? {}));
  let exaggeration = opts.exaggeration ?? 1.5;
  let hillshade = opts.ambient ?? 0.15;
  let lightDirection = opts.lightDirection ?? [-0.5, -0.7, 1] as const;
  let sse = opts.maxScreenSpaceError ?? 4;
  const initialize = () => {
    if (provider.ready || initPending || performance.now() < initRetryAt) { return; }
    initPending = true;
    void provider.initialize().catch(() => { initRetryAt = performance.now() + 3000; }).finally(() => { initPending = false; });
  };
  const layer: TerrainElevationLayer = {
    id: opts.id, type: 'cesium-terrain', source: opts.source, projection: 'mercator',
    visible: opts.layout?.visibility !== 'none', opacity: opts.opacity ?? 1, zIndex: 0,
    isTransparent: false, renderOrder: 0, provider,
    get isLoaded() { return provider.ready && requests.size === 0; },
    get revision() { return revision; },
    get elevationRange() { return elevationRange; },
    get exaggeration() { return exaggeration; },
    get hillshade() { return hillshade; },
    get lightDirection() { return lightDirection; },
    onAdd(ctx) { context = ctx; mounted = true; initialize(); },
    onRemove() { mounted = false; provider.abortAll(); cache.clear(); failures.clear(); wanted.clear(); previousTiles = []; bytes = 0; revision++; },
    onUpdate(_dt, camera) {
      if (!mounted) { return; }
      initialize();
      if (!provider.ready) { return; }
      const minZoom = Math.max(opts.minZoom ?? 0, provider.metadata!.minZoom);
      const tiles = computeGeographicCoveringTiles(camera, provider, {
        viewportWidth: context?.canvasSize?.[0] ?? 1024,
        viewportHeight: context?.canvasSize?.[1] ?? 768,
        minZoom, maxZoom: Math.min(opts.maxZoom ?? 14, provider.metadata!.maxZoom), maxScreenSpaceError: sse,
        minElevation: camera.terrainElevationRange?.[0] ?? elevationRange[0] * exaggeration,
        maxElevation: camera.terrainElevationRange?.[1] ?? elevationRange[1] * exaggeration,
        previousTiles,
      });
      previousTiles = tiles;
      // Ancestors are requested first so a cold zoom/pan gets broad coverage quickly.
      const jobs = new Map<string, { z: number; x: number; y: number }>();
      for (const tile of tiles) {
        const z = Math.max(minZoom, tile.z - 2), divisor = 2 ** (tile.z - z);
        const parent = { z, x: Math.floor(tile.x / divisor), y: Math.floor(tile.y / divisor) };
        if (provider.isTileAvailable(parent.z, parent.x, parent.y)) { jobs.set(`${z}/${parent.x}/${parent.y}`, parent); }
      }
      for (const tile of tiles) { jobs.set(`${tile.z}/${tile.x}/${tile.y}`, tile); }
      wanted = new Set(jobs.keys());
      provider.retainRequests(wanted);
      for (const [key, tile] of jobs) {
        const cached = cache.get(key);
        if (cached) { cache.delete(key); cache.set(key, cached); continue; }
        if (requests.has(key) || requests.size >= 6 || (failures.get(key)?.retryAt ?? 0) > performance.now()) { continue; }
        requests.add(key);
        void provider.loadTile(tile.z, tile.x, tile.y).then(raw => {
          if (!mounted || !wanted.has(key)) { return; }
          const sampler = new QuantizedMeshSampler(raw);
          elevationRange = [Math.min(elevationRange[0], raw.header.minimumHeight), Math.max(elevationRange[1], raw.header.maximumHeight)];
          cache.set(key, sampler); bytes += sampler.byteSize; revision++;
          failures.delete(key);
          for (const [oldKey, old] of cache) {
            if (bytes <= 128 * 1024 * 1024 && cache.size <= 512) { break; }
            if (wanted.has(oldKey)) { continue; }
            cache.delete(oldKey); bytes -= old.byteSize;
          }
        }).catch(() => {
          if (mounted && wanted.has(key)) {
            const count = (failures.get(key)?.count ?? 0) + 1;
            failures.set(key, { count, retryAt: performance.now() + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)) });
          }
        }).finally(() => { requests.delete(key); });
      }
    },
    encode() { /* Elevations only: the raster surface owns every ground draw call. */ },
    sampleElevation(lng, lat) {
      if (!mounted || !layer.visible || layer.opacity <= 0 || !provider.metadata) { return null; }
      const bounds = provider.metadata.bounds;
      if (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3]) { return null; }
      for (let z = Math.min(opts.maxZoom ?? 14, provider.metadata.maxZoom); z >= provider.metadata.minZoom; z--) {
        const n = 2 ** z, fx = (lng + 180) / 360 * n * 2, fy = (lat + 90) / 180 * n;
        const x = Math.max(0, Math.min(n * 2 - 1, Math.floor(fx))), y = Math.max(0, Math.min(n - 1, Math.floor(fy)));
        const cached = cache.get(`${z}/${x}/${y}`);
        if (cached) {
          const value = cached.sample(fx - x, fy - y);
          if (value !== null) { return value; }
        }
      }
      return null;
    },
    setPaintProperty(name, value) {
      paint.set(name, value);
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (name === 'terrain-exaggeration' && value > 0) { exaggeration = value; revision++; }
        if (name === 'terrain-ambient') { hillshade = Math.max(0, Math.min(1, value)); }
        if (name === 'terrain-opacity') { layer.opacity = Math.max(0, Math.min(1, value)); revision++; }
      }
      if (name === 'terrain-light-direction' && Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) { lightDirection = value as [number, number, number]; }
    },
    getPaintProperty(name) { return paint.get(name); },
    setLayoutProperty(name, value) {
      layout.set(name, value);
      if (name === 'visibility') { layer.visible = value === 'visible'; revision++; }
      if (name === 'terrain-max-screen-space-error' && typeof value === 'number' && value > 0 && Number.isFinite(value)) { sse = value; }
    },
    getLayoutProperty(name) { return layout.get(name); },
    setData() {}, getData() { return { cachedTiles: cache.size, cacheBytes: bytes, loadingCount: requests.size, scheduledTiles: wanted.size, providerReady: provider.ready, surfaceOnly: true }; },
    setFeatureState() {}, getFeatureState() { return undefined; },
  };
  return layer;
}
