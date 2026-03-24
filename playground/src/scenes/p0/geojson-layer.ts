// ============================================================
// playground/src/scenes/p0/geojson-layer.ts
// GeoJSONLayer 测试场景（stub）。
// 在 GeoForge 渲染管线就绪后替换为真实引擎实现。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * GeoJSONLayer 测试场景配置。
 * 演示 GeoJSON 数据的加载、聚合（clustering）和多种几何类型渲染。
 */
const scene: SceneConfig = {
  id: 'p0-geojson-layer',
  name: 'GeoJSONLayer GeoJSON + 聚合',

  controls: [
    { type: 'group', label: 'Data' },
    {
      type: 'select',
      key: 'dataset',
      label: 'Dataset',
      options: [
        { value: 'points', label: 'Beijing POIs (8 points)' },
        { value: 'polygon', label: 'Beijing Boundary' },
        { value: 'line', label: "Chang'an Avenue" },
      ],
      defaultValue: 'points',
    },
    { type: 'group', label: 'Clustering' },
    {
      type: 'switch',
      key: 'cluster',
      label: 'Enable Clustering',
      defaultValue: true,
    },
    {
      type: 'slider',
      key: 'clusterRadius',
      label: 'Cluster Radius (px)',
      min: 20,
      max: 100,
      step: 5,
      defaultValue: 50,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">📍</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">GeoJSONLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Load and render GeoJSON FeatureCollections with automatic geometry detection.
          Supports point clustering, polygon fill/stroke, and line rendering
          with data-driven style expressions.
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
      'Layer Info': {
        type: 'geojson',
        featureCount: 8,
        geometryTypes: ['Point'],
        clusterEnabled: true,
      },
      'Cluster Stats': {
        totalPoints: 8,
        clusters: 3,
        clusterRadius: '50 px',
        maxZoom: 14,
      },
      'Render Stats': {
        drawCalls: 2,
        instances: 5,
        gpuMemory: '0.8 MB',
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';

const geojson = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.39, 39.91] }, properties: { name: 'Tiananmen' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.40, 39.92] }, properties: { name: 'Forbidden City' } },
    // ... more features
  ],
};

const map = new Map({
  container: 'map',
  style: {
    sources: {
      pois: {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      },
    },
    layers: [
      {
        id: 'poi-circles',
        type: 'circle',
        source: 'pois',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 6,
          'circle-color': '#53a8b6',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      },
      {
        id: 'cluster-circles',
        type: 'circle',
        source: 'pois',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 25],
          'circle-color': '#0f3460',
        },
      },
    ],
  },
  center: [116.39, 39.91],
  zoom: 12,
});`;
  },
};

export default scene;
