/**
 * Basemap style preset (raster template + attribution).
 */
export type BasemapStyleDef = {
  /** Unique preset id. */
  id: string;
  /** User-visible label. */
  name: string;
  /** XYZ or raster template URL; empty when not configured. */
  url: string;
  /** Preview image URL; empty when using placeholder UI. */
  thumbnail: string;
  /** Attribution line for the map chrome. */
  attribution: string;
};

/**
 * Three default basemap style entries (URLs may be filled by deployment).
 */
export const BASEMAP_STYLES: BasemapStyleDef[] = [
  {
    id: 'osm-standard',
    name: 'OSM 标准',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    thumbnail: '',
    attribution: '© OpenStreetMap contributors',
  },
  {
    id: 'satellite',
    name: '卫星影像',
    url: '',
    thumbnail: '',
    attribution: '',
  },
  {
    id: 'dark-nav',
    name: '深色导航',
    url: '',
    thumbnail: '',
    attribution: '',
  },
];
