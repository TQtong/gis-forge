import type { SourceKind } from '@/types';

/**
 * One sample dataset card shown in the add-layer dialog (“示例数据” tab).
 */
export type SampleLayerItem = {
  /** Stable sample id used for source/layer naming. */
  id: string;
  /** Display name in the grid. */
  name: string;
  /** Icon key consumed by the dialog (maps to Lucide icons). */
  icon:
    | 'map'
    | 'satellite'
    | 'globe'
    | 'building'
    | 'mapPin'
    | 'wind'
    | 'route'
    | 'box';
  /** Short description under the title. */
  description: string;
  /** Source protocol hint for layer wiring. */
  type: SourceKind;
  /** Template URL or empty when bundled later. */
  url: string;
};

/**
 * Eight built-in sample layers for quick demos (URLs may be filled by the engine later).
 */
export const SAMPLE_LAYERS: SampleLayerItem[] = [
  {
    id: 'osm',
    name: 'OSM 底图',
    icon: 'map',
    description: 'OpenStreetMap 标准底图',
    type: 'raster-tile',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  },
  {
    id: 'satellite',
    name: '卫星影像',
    icon: 'satellite',
    description: '全球卫星影像底图',
    type: 'raster-tile',
    url: '',
  },
  {
    id: 'world-borders',
    name: '全球国境',
    icon: 'globe',
    description: '世界各国边界线',
    type: 'geojson',
    url: '',
  },
  {
    id: 'beijing-buildings',
    name: '北京建筑',
    icon: 'building',
    description: '北京市建筑物三维数据',
    type: 'geojson',
    url: '',
  },
  {
    id: 'world-cities',
    name: '全球城市',
    icon: 'mapPin',
    description: '主要城市坐标点',
    type: 'geojson',
    url: '',
  },
  {
    id: 'wind-field',
    name: '风场数据',
    icon: 'wind',
    description: '全球风速风向场',
    type: 'geojson',
    url: '',
  },
  {
    id: 'gps-track',
    name: 'GPS轨迹',
    icon: 'route',
    description: 'GPS 运动轨迹示例',
    type: 'geojson',
    url: '',
  },
  {
    id: '3d-city',
    name: '3D城市',
    icon: 'box',
    description: '3D Tiles 城市模型',
    type: '3d-tiles',
    url: '',
  },
];
