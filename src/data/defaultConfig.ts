import type { LayerConfig, LayerGroup, MapViewState } from '@/types';

/**
 * Default terrain / DEM settings for the terrain panel (local state may mirror this).
 */
export type DefaultTerrainConfig = {
  /** When true, terrain mesh is shown and exaggerated. */
  enabled: boolean;
  /** Vertical scale multiplier (0.1–10 typical). */
  exaggeration: number;
  /** DEM provider key. */
  source: 'mapbox' | 'aws';
};

/**
 * Pre-configured layer groups with one visible OSM basemap in the basemap group.
 */
export const DEFAULT_LAYER_GROUPS: LayerGroup[] = [
  {
    id: 'basemap',
    name: '底图',
    type: 'basemap',
    collapsed: false,
    exclusive: true,
    layers: [
      {
        id: 'osm-standard-raster',
        name: 'OSM 标准',
        type: 'raster',
        sourceId: 'source-osm-standard',
        visible: true,
        opacity: 1,
        paint: {},
        layout: {},
        filter: [],
        minzoom: 0,
        maxzoom: 22,
        error: null,
        loading: false,
      } satisfies LayerConfig,
    ],
  },
  {
    id: 'vector',
    name: '矢量图层',
    type: 'vector',
    collapsed: false,
    exclusive: false,
    layers: [],
  },
  {
    id: 'overlay',
    name: '叠加图层',
    type: 'overlay',
    collapsed: false,
    exclusive: false,
    layers: [],
  },
  {
    id: 'analysis',
    name: '分析结果',
    type: 'analysis',
    collapsed: false,
    exclusive: false,
    layers: [],
  },
];

/**
 * Initial map camera / mode for Beijing city center (degrees + radians per `MapViewState`).
 */
export const DEFAULT_MAP_STATE: MapViewState = {
  center: [116.397, 39.908],
  zoom: 11,
  bearing: 0,
  pitch: 0,
  mode: '2d',
};

/**
 * Default terrain panel values before user overrides.
 */
export const DEFAULT_TERRAIN_CONFIG: DefaultTerrainConfig = {
  enabled: false,
  exaggeration: 1.5,
  source: 'mapbox',
};
