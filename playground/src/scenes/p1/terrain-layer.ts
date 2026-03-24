// ============================================================
// playground/src/scenes/p1/terrain-layer.ts
// TerrainLayer 地形渲染测试场景（stub）。
// 在 GeoForge 渲染管线就绪后替换为真实引擎实现。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * TerrainLayer 测试场景配置。
 * 演示 DEM 高程数据驱动的 3D 地形渲染，包括
 * 法线计算、光照模型、夸张系数和 LOD 调节。
 */
const scene: SceneConfig = {
  id: 'p1-terrain-layer',
  name: 'TerrainLayer 地形渲染',

  controls: [
    { type: 'group', label: 'Terrain' },
    {
      type: 'slider',
      key: 'exaggeration',
      label: 'Exaggeration',
      min: 0,
      max: 5,
      step: 0.1,
      defaultValue: 1.5,
    },
    {
      type: 'select',
      key: 'demSource',
      label: 'DEM Source',
      options: [
        { value: 'mapbox', label: 'Mapbox Terrain RGB' },
        { value: 'terrarium', label: 'Terrarium PNG' },
      ],
      defaultValue: 'mapbox',
    },
    { type: 'group', label: 'Lighting' },
    {
      type: 'slider',
      key: 'azimuth',
      label: 'Sun Azimuth (°)',
      min: 0,
      max: 360,
      step: 5,
      defaultValue: 315,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">⛰️</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">TerrainLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          3D terrain rendering with DEM elevation data. Features GPU mesh
          generation, normal-map-based hillshading, configurable exaggeration,
          and LOD-based tile mesh resolution.
        </p>
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
      'Terrain Info': {
        demSource: 'Mapbox Terrain RGB',
        exaggeration: 1.5,
        meshResolution: '64×64 vertices/tile',
      },
      'Render Stats': {
        visibleTerrainTiles: 16,
        triangles: 131072,
        gpuMemory: '32.4 MB',
        normalMapGeneration: '4.2 ms',
      },
      'Lighting': {
        azimuth: '315°',
        altitude: '45°',
        ambientIntensity: 0.3,
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-25d';

const map = new Map({
  container: 'map',
  style: {
    sources: {
      dem: {
        type: 'raster-dem',
        tiles: ['https://api.example.com/terrain/{z}/{x}/{y}.png'],
        encoding: 'mapbox',
        tileSize: 512,
      },
    },
    terrain: {
      source: 'dem',
      exaggeration: 1.5,
    },
    layers: [
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': '#473B24',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-illumination-direction': 315,
        },
      },
    ],
  },
  center: [86.92, 27.99], // Mt. Everest
  zoom: 12,
  pitch: 60,
});`;
  },
};

export default scene;
