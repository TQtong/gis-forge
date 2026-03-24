// ============================================================
// playground/src/scenes/p0/vector-tile-layer.ts
// VectorTileLayer 矢量瓦片图层测试场景（stub）。
// 在 GeoForge 渲染管线就绪后替换为真实引擎实现。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * VectorTileLayer 测试场景配置。
 * 演示矢量瓦片图层的 fill/line/circle/symbol 渲染、
 * 样式表达式编译和 GPU 加速渲染管线。
 */
const scene: SceneConfig = {
  id: 'p0-vector-tile-layer',
  name: 'VectorTileLayer 矢量瓦片',

  controls: [
    { type: 'group', label: 'Style' },
    {
      type: 'color',
      key: 'fillColor',
      label: 'Fill Color',
      defaultValue: '#3388ff',
    },
    {
      type: 'slider',
      key: 'fillOpacity',
      label: 'Fill Opacity',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: 0.7,
    },
    {
      type: 'slider',
      key: 'lineWidth',
      label: 'Line Width (px)',
      min: 0.5,
      max: 8,
      step: 0.5,
      defaultValue: 2,
    },
    {
      type: 'color',
      key: 'lineColor',
      label: 'Line Color',
      defaultValue: '#ff0000',
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">📐</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">VectorTileLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          GPU-accelerated vector tile rendering with fill, line, circle, and symbol layers.
          MVT decoding in Web Workers with earcut triangulation and wide-line extrusion.
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
        type: 'vector-tile',
        sublayers: ['fill', 'line', 'circle', 'symbol'],
        featureCount: 12847,
      },
      'Style Engine': {
        compiledExpressions: 8,
        shaderVariants: 4,
        pipelinesCached: 4,
      },
      'Tile Stats': {
        loaded: 18,
        loading: 2,
        decodeTimeAvg: '128 ms',
        triangles: 284392,
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';

const map = new Map({
  container: 'map',
  style: {
    sources: {
      streets: {
        type: 'vector',
        tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt'],
        maxzoom: 14,
      },
    },
    layers: [
      {
        id: 'buildings-fill',
        type: 'fill',
        source: 'streets',
        'source-layer': 'building',
        paint: {
          'fill-color': '#3388ff',
          'fill-opacity': 0.7,
        },
      },
      {
        id: 'roads-line',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        paint: {
          'line-color': '#ff0000',
          'line-width': 2,
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
