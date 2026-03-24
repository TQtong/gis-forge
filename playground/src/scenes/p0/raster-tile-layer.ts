// ============================================================
// playground/src/scenes/p0/raster-tile-layer.ts
// RasterTileLayer 栅格瓦片图层测试场景（stub）。
// 在 GeoForge 渲染管线就绪后替换为真实引擎实现。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用，onLeave 时用于清理 */
let containerRef: HTMLDivElement | null = null;

/**
 * RasterTileLayer 测试场景配置。
 * 演示栅格瓦片图层的配置、样式调整和性能参数。
 *
 * 正式实现将通过 Map2D preset 加载 OSM/卫星瓦片，
 * 支持透明度、亮度、对比度、饱和度实时调节和淡入动画。
 */
const scene: SceneConfig = {
  id: 'p0-raster-tile-layer',
  name: 'RasterTileLayer 栅格瓦片',

  controls: [
    { type: 'group', label: 'Data Source' },
    {
      type: 'select',
      key: 'source',
      label: 'Tile Source',
      options: [
        { value: 'osm', label: 'OpenStreetMap' },
        { value: 'satellite', label: 'Satellite Imagery' },
      ],
      defaultValue: 'osm',
    },
    { type: 'group', label: 'Style' },
    {
      type: 'slider',
      key: 'opacity',
      label: 'Opacity',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: 1,
    },
    {
      type: 'slider',
      key: 'brightness',
      label: 'Brightness',
      min: -1,
      max: 1,
      step: 0.05,
      defaultValue: 0,
    },
    {
      type: 'slider',
      key: 'contrast',
      label: 'Contrast',
      min: -1,
      max: 1,
      step: 0.05,
      defaultValue: 0,
    },
    {
      type: 'slider',
      key: 'saturation',
      label: 'Saturation',
      min: -1,
      max: 1,
      step: 0.05,
      defaultValue: 0,
    },
    { type: 'group', label: 'Performance' },
    {
      type: 'slider',
      key: 'fadeDuration',
      label: 'Fade Duration (ms)',
      min: 0,
      max: 1000,
      step: 50,
      defaultValue: 300,
    },
  ],

  /**
   * 进入场景：渲染功能说明页。
   * 正式实现将初始化 Map2D + RasterTileLayer。
   *
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;">
        <div style="font-size:40px;margin-bottom:16px;">🗺️</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">RasterTileLayer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Renders OSM/satellite raster tiles with GPU-accelerated brightness,
          contrast, and saturation adjustments. Supports fade-in animation
          and tile placeholder rendering.
        </p>
        <div style="margin-top:20px;padding:8px 16px;border-radius:4px;background:var(--highlight);color:var(--accent);font-size:12px;">
          Awaiting GeoForge rendering pipeline integration
        </div>
      </div>
    `;
  },

  /**
   * 离开场景：清空容器。
   */
  onLeave(): void {
    if (containerRef) {
      containerRef.innerHTML = '';
      containerRef = null;
    }
  },

  /**
   * 返回模拟的运行时数据。
   *
   * @returns 包含图层状态和瓦片统计的模拟数据
   */
  getInspectorData(): Record<string, unknown> {
    return {
      'Layer Info': {
        type: 'raster-tile',
        source: 'OpenStreetMap',
        opacity: 1.0,
        visible: true,
      },
      'Tile Stats': {
        loaded: 24,
        loading: 3,
        cached: 180,
        failed: 0,
        totalGPUMemory: '45.2 MB',
      },
      'Render Stats': {
        drawCalls: 24,
        texturesUsed: 24,
        fadeActive: 3,
      },
    };
  },

  /**
   * 返回 RasterTileLayer 的最小可运行代码示例。
   *
   * @returns TypeScript 代码字符串
   */
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
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [
      {
        id: 'base-tiles',
        type: 'raster',
        source: 'osm',
        paint: {
          'raster-opacity': 1.0,
          'raster-brightness-min': 0,
          'raster-brightness-max': 1,
          'raster-contrast': 0,
          'raster-saturation': 0,
          'raster-fade-duration': 300,
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
