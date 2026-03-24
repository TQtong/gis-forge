// ============================================================
// playground/src/scenes/p2/measure-tool.ts
// MeasureTool 测量工具测试场景（stub）。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * MeasureTool 测试场景配置。
 * 演示距离和面积测量工具，使用 Vincenty 椭球大地线
 * 算法获得高精度结果。
 */
const scene: SceneConfig = {
  id: 'p2-measure-tool',
  name: 'MeasureTool 测量工具',

  controls: [
    { type: 'group', label: 'Measure Mode' },
    {
      type: 'select',
      key: 'mode',
      label: 'Measurement Type',
      options: [
        { value: 'distance', label: 'Distance (Vincenty)' },
        { value: 'area', label: 'Area (Spherical Excess)' },
      ],
      defaultValue: 'distance',
    },
    { type: 'group', label: 'Display' },
    {
      type: 'select',
      key: 'unit',
      label: 'Unit',
      options: [
        { value: 'metric', label: 'Metric (m/km)' },
        { value: 'imperial', label: 'Imperial (ft/mi)' },
        { value: 'nautical', label: 'Nautical (nm)' },
      ],
      defaultValue: 'metric',
    },
    {
      type: 'switch',
      key: 'showSegments',
      label: 'Show Segment Lengths',
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
        <div style="font-size:40px;margin-bottom:16px;">📏</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">MeasureTool</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Geodesic distance and area measurement using Vincenty ellipsoidal
          algorithms. Supports metric, imperial, and nautical units with
          per-segment and total length display.
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
      'Measure State': {
        mode: 'distance',
        unit: 'metric',
        points: 0,
        totalDistance: '0 m',
        isMeasuring: false,
      },
      'Algorithm': {
        method: 'Vincenty Inverse',
        ellipsoid: 'WGS84',
        convergenceIterations: 0,
        precision: '±0.5mm',
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';
import { MeasureTool } from '@geoforge/interaction-measure';

const map = new Map({ container: 'map', /* ... */ });

const measure = new MeasureTool(map, {
  mode: 'distance',
  unit: 'metric',
  showSegments: true,
  style: {
    lineColor: '#53a8b6',
    lineWidth: 2,
    labelBackground: 'rgba(0,0,0,0.7)',
    labelColor: '#ffffff',
  },
});

// Start measuring
measure.enable();

// Listen for measurement updates
measure.on('measure:update', (e) => {
  console.log('Total distance:', e.totalDistance, 'm');
  console.log('Segments:', e.segments);
});

// Listen for measurement completion (double-click)
measure.on('measure:complete', (e) => {
  console.log('Final:', e.totalDistance, 'm');
  console.log('Feature:', JSON.stringify(e.feature));
});

// Clear and disable
measure.clear();
measure.disable();`;
  },
};

export default scene;
