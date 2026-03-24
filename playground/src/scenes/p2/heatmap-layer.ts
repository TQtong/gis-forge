// ============================================================
// playground/src/scenes/p2/heatmap-layer.ts
// HeatmapLayer 热力图测试场景（stub）。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * HeatmapLayer 测试场景配置。
 * 演示 GPU Compute Shader 驱动的热力图渲染，
 * 支持权重字段、颜色渐变和核密度半径调节。
 */
const scene: SceneConfig = {
  id: 'p2-heatmap-layer',
  name: 'HeatmapLayer 热力图',

  controls: [
    { type: 'group', label: 'Heatmap' },
    {
      type: 'slider',
      key: 'radius',
      label: 'Kernel Radius (px)',
      min: 5,
      max: 50,
      step: 1,
      defaultValue: 20,
    },
    {
      type: 'slider',
      key: 'intensity',
      label: 'Intensity',
      min: 0.1,
      max: 5,
      step: 0.1,
      defaultValue: 1.0,
    },
    {
      type: 'slider',
      key: 'opacity',
      label: 'Opacity',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: 0.8,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">🔥</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">HeatmapLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          GPU Compute Shader based heatmap rendering. Supports weighted
          kernel density estimation, configurable color ramps, and
          zoom-adaptive radius scaling.
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
      'Heatmap Config': {
        radius: '20 px',
        intensity: 1.0,
        weightField: 'magnitude',
        colorRamp: 'viridis',
      },
      'Data Stats': {
        pointCount: 5000,
        weightRange: '[0.1, 9.5]',
      },
      'Render Stats': {
        computePassTime: '2.1 ms',
        renderPassTime: '0.8 ms',
        textureSize: '1024×1024',
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';

const map = new Map({
  container: 'map',
  style: {
    sources: {
      earthquakes: {
        type: 'geojson',
        data: 'https://example.com/earthquakes.geojson',
      },
    },
    layers: [
      {
        id: 'heat',
        type: 'heatmap',
        source: 'earthquakes',
        paint: {
          'heatmap-weight': ['get', 'magnitude'],
          'heatmap-intensity': 1.0,
          'heatmap-radius': 20,
          'heatmap-opacity': 0.8,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,255,0)',
            0.2, 'royalblue',
            0.4, 'cyan',
            0.6, 'lime',
            0.8, 'yellow',
            1, 'red',
          ],
        },
      },
    ],
  },
  center: [0, 20],
  zoom: 2,
});`;
  },
};

export default scene;
