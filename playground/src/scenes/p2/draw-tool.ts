// ============================================================
// playground/src/scenes/p2/draw-tool.ts
// DrawTool 绘制工具测试场景（stub）。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * DrawTool 测试场景配置。
 * 演示点、线、面的交互式绘制工具，包括
 * 吸附（snapping）、撤销/重做和几何验证。
 */
const scene: SceneConfig = {
  id: 'p2-draw-tool',
  name: 'DrawTool 绘制工具',

  controls: [
    { type: 'group', label: 'Draw Mode' },
    {
      type: 'select',
      key: 'mode',
      label: 'Geometry Type',
      options: [
        { value: 'point', label: 'Point' },
        { value: 'line', label: 'LineString' },
        { value: 'polygon', label: 'Polygon' },
        { value: 'circle', label: 'Circle' },
      ],
      defaultValue: 'polygon',
    },
    { type: 'group', label: 'Snapping' },
    {
      type: 'switch',
      key: 'snap',
      label: 'Enable Snapping',
      defaultValue: true,
    },
    {
      type: 'slider',
      key: 'snapTolerance',
      label: 'Snap Tolerance (px)',
      min: 5,
      max: 30,
      step: 1,
      defaultValue: 10,
    },
  ],

  /**
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">✏️</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">DrawTool</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Interactive geometry drawing tool supporting Point, LineString,
          Polygon, and Circle modes. Features vertex snapping, undo/redo
          history, real-time geometry validation, and GeoJSON export.
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
      'Draw State': {
        mode: 'polygon',
        vertices: 0,
        isDrawing: false,
        snapEnabled: true,
      },
      'History': {
        undoStack: 0,
        redoStack: 0,
        totalFeatures: 0,
      },
      'Snapping': {
        tolerance: '10 px',
        nearestVertex: 'none',
        nearestEdge: 'none',
      },
    };
  },

  getSampleCode(): string {
    return `import { Map } from '@geoforge/preset-2d';
import { DrawTool } from '@geoforge/interaction-draw';

const map = new Map({ container: 'map', /* ... */ });

const draw = new DrawTool(map, {
  mode: 'polygon',
  snap: true,
  snapTolerance: 10,
  style: {
    fillColor: 'rgba(83, 168, 182, 0.3)',
    strokeColor: '#53a8b6',
    strokeWidth: 2,
    vertexRadius: 5,
  },
});

// Start drawing
draw.enable();

// Listen for draw completion
draw.on('draw:complete', (e) => {
  const geojson = e.feature;
  console.log('Drawn feature:', JSON.stringify(geojson));
});

// Undo / Redo
draw.undo();
draw.redo();

// Export all drawn features
const features = draw.getAll();

// Disable drawing
draw.disable();`;
  },
};

export default scene;
