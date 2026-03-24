// ============================================================
// playground/src/scenes/integration/city-2d.ts
// 2D 城市底图集成测试场景（stub）。
// 组合 raster + vector + label 三个图层，验证多图层共存。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * 2D 城市底图集成测试场景配置。
 * 综合验证 RasterTileLayer + VectorTileLayer + MarkerLayer 在
 * Map2D preset 下的多图层渲染、样式编译、瓦片调度和标注碰撞检测。
 */
const scene: SceneConfig = {
  id: 'integration-city-2d',
  name: '2D 城市底图（raster + vector + label）',

  controls: [
    { type: 'group', label: 'Layers' },
    {
      type: 'switch',
      key: 'showRaster',
      label: 'Raster Base Layer',
      defaultValue: true,
    },
    {
      type: 'switch',
      key: 'showVector',
      label: 'Vector Overlay',
      defaultValue: true,
    },
    {
      type: 'switch',
      key: 'showLabels',
      label: 'Labels',
      defaultValue: true,
    },
    { type: 'group', label: 'Performance' },
    {
      type: 'select',
      key: 'msaa',
      label: 'MSAA',
      options: [
        { value: '1', label: 'Off' },
        { value: '4', label: '4x' },
      ],
      defaultValue: '4',
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">🏙️</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">2D City Basemap</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Integration test combining raster base tiles, vector building/road
          overlays, and MSDF text labels in a single Map2D scene. Validates
          multi-layer compositing, z-ordering, and tile schedule coordination.
        </p>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">RasterTile</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">VectorTile</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">Labels</span>
        </div>
        <div style="margin-top:20px;padding:8px 16px;border-radius:4px;background:var(--highlight);color:var(--accent);font-size:12px;">
          Awaiting GeoForge rendering pipeline integration
        </div>
      </div>
    `;
  },

  onLeave(): void {
    if (containerRef) {
      containerRef.innerHTML = '';
      containerRef = null;
    }
  },

  getInspectorData(): Record<string, unknown> {
    return {
      'Scene Overview': {
        preset: 'Map2D',
        activeLayers: 3,
        center: '[116.3912, 39.9073]',
        zoom: 14,
      },
      'Layer Stack': {
        'raster-base': { type: 'raster', visible: true, tiles: 24 },
        'vector-overlay': { type: 'vector', visible: true, features: 8432 },
        'labels': { type: 'symbol', visible: true, markers: 45 },
      },
      'Composite Stats': {
        totalDrawCalls: 72,
        totalTriangles: 312847,
        compositorPasses: 3,
        gpuMemory: '148.6 MB',
        fps: 58,
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';

const map = new Map({
  container: 'map',
  style: {
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
      },
      streets: {
        type: 'vector',
        tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt'],
        maxzoom: 14,
      },
    },
    layers: [
      // Base raster tiles
      { id: 'base', type: 'raster', source: 'osm' },
      // Building fill
      {
        id: 'buildings',
        type: 'fill',
        source: 'streets',
        'source-layer': 'building',
        paint: {
          'fill-color': '#3388ff',
          'fill-opacity': 0.4,
        },
      },
      // Road lines
      {
        id: 'roads',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 18, 8],
        },
      },
      // Place labels
      {
        id: 'labels',
        type: 'symbol',
        source: 'streets',
        'source-layer': 'place',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
        },
        paint: {
          'text-color': '#e0e0e0',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      },
    ],
  },
  center: [116.39, 39.91],
  zoom: 14,
});`;
  },
};

export default scene;
