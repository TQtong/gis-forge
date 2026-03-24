// ============================================================
// playground/src/scenes/p3/analysis-demo.ts
// 空间分析综合演示测试场景（stub）。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * 空间分析综合演示场景配置。
 * 展示 @geoforge/analysis 包的 9 个子模块：
 * boolean（布尔运算）、buffer（缓冲区）、interpolation（插值）、
 * classification（分类）、grid（网格生成）、raster（栅格分析）、
 * transform（变换）、aggregation（聚合）、topology（拓扑）。
 */
const scene: SceneConfig = {
  id: 'p3-analysis',
  name: 'Analysis 空间分析综合演示',

  controls: [
    { type: 'group', label: 'Analysis Module' },
    {
      type: 'select',
      key: 'module',
      label: 'Module',
      options: [
        { value: 'buffer', label: 'Buffer Analysis' },
        { value: 'boolean', label: 'Boolean Operations' },
        { value: 'interpolation', label: 'Interpolation (IDW)' },
        { value: 'classification', label: 'Classification (Jenks)' },
        { value: 'grid', label: 'Grid (Hexbin)' },
      ],
      defaultValue: 'buffer',
    },
    { type: 'group', label: 'Parameters' },
    {
      type: 'slider',
      key: 'bufferRadius',
      label: 'Buffer Radius (km)',
      min: 0.1,
      max: 10,
      step: 0.1,
      defaultValue: 1.0,
    },
    {
      type: 'slider',
      key: 'segments',
      label: 'Buffer Segments',
      min: 8,
      max: 64,
      step: 4,
      defaultValue: 32,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">🔬</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">Spatial Analysis</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Comprehensive spatial analysis toolkit with 9 modules: boolean
          operations, buffer generation, TIN/IDW interpolation, Jenks/quantile
          classification, hex/Voronoi grids, slope/hillshade raster analysis,
          coordinate transforms, spatial aggregation, and topology validation.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:16px;max-width:400px;">
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">boolean</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">buffer</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">interpolation</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">classification</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">grid</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">raster</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">transform</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">aggregation</span>
          <span style="padding:3px 8px;border-radius:3px;font-size:11px;background:var(--highlight);color:var(--accent);">topology</span>
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
      'Active Module': {
        name: 'buffer',
        inputFeatures: 1,
        outputFeatures: 1,
        processingTime: '12 ms',
      },
      'Buffer Config': {
        radius: '1.0 km',
        segments: 32,
        units: 'kilometers',
        endCapStyle: 'round',
      },
      'Result': {
        type: 'Polygon',
        vertexCount: 33,
        area: '3.14 km²',
      },
    };
  },

  getSampleCode(): string {
    return `import { buffer, booleanIntersects, classifyJenks } from '@geoforge/analysis';

// Buffer a point by 1km
const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [116.39, 39.91] }, properties: {} };
const buffered = buffer(point, 1.0, { units: 'kilometers', steps: 32 });
console.log('Buffer area:', buffered.properties.area, 'km²');

// Boolean intersection test
const polygon1 = /* ... */;
const polygon2 = /* ... */;
const intersects = booleanIntersects(polygon1, polygon2);

// Jenks natural breaks classification
const values = features.map(f => f.properties.population);
const breaks = classifyJenks(values, 5); // 5 classes
console.log('Class breaks:', breaks);

// IDW interpolation
import { interpolateIDW } from '@geoforge/analysis';
const grid = interpolateIDW(samplePoints, {
  cellSize: 0.01,      // degrees
  power: 2,
  maxDistance: 0.1,
  bounds: [116.2, 39.8, 116.6, 40.0],
});

// Hexbin grid aggregation
import { hexbinAggregate } from '@geoforge/analysis';
const hexGrid = hexbinAggregate(points, {
  cellSize: 500,        // meters
  aggregation: 'count',
});`;
  },
};

export default scene;
