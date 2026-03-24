// ============================================================
// playground/src/scenes/p2/marker-layer.ts
// MarkerLayer 标注图层测试场景（stub）。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * MarkerLayer 测试场景配置。
 * 演示 MSDF 文字渲染、图标图集（atlas）、标注碰撞检测
 * 和动态锚点调整。
 */
const scene: SceneConfig = {
  id: 'p2-marker-layer',
  name: 'MarkerLayer 标注',

  controls: [
    { type: 'group', label: 'Label Style' },
    {
      type: 'slider',
      key: 'fontSize',
      label: 'Font Size (px)',
      min: 8,
      max: 32,
      step: 1,
      defaultValue: 14,
    },
    {
      type: 'color',
      key: 'textColor',
      label: 'Text Color',
      defaultValue: '#e0e0e0',
    },
    {
      type: 'switch',
      key: 'collisionDetection',
      label: 'Collision Detection',
      defaultValue: true,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">🏷️</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">MarkerLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          High-performance marker and label rendering using MSDF text,
          sprite atlas, GPU-accelerated collision detection, and
          automatic anchor placement for optimal readability.
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
      'Marker Config': {
        totalMarkers: 200,
        visibleMarkers: 45,
        hiddenByCollision: 155,
        fontSize: '14 px',
      },
      'Glyph Manager': {
        loadedGlyphs: 128,
        atlasSize: '1024×1024',
        atlasUsage: '62%',
      },
      'Render Stats': {
        drawCalls: 1,
        instances: 45,
        collisionTime: '0.3 ms',
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';

const map = new Map({
  container: 'map',
  style: {
    sources: {
      cities: {
        type: 'geojson',
        data: citiesGeoJSON,
      },
    },
    layers: [
      {
        id: 'city-labels',
        type: 'symbol',
        source: 'cities',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 14,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.5],
          'icon-image': 'marker-pin',
          'icon-size': 0.8,
          'symbol-sort-key': ['get', 'population'],
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
  zoom: 6,
});`;
  },
};

export default scene;
