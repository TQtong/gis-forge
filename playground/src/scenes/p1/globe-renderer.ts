// ============================================================
// playground/src/scenes/p1/globe-renderer.ts
// GlobeRenderer 地球渲染测试场景（stub）。
// 在 GeoForge 渲染管线就绪后替换为真实引擎实现。
// ============================================================

import type { SceneConfig } from '../../types';

/** 容器 DOM 引用 */
let containerRef: HTMLDivElement | null = null;

/**
 * GlobeRenderer 测试场景配置。
 * 演示 3D 地球渲染，包括大气散射、星空背景、
 * 太阳光照模型和 ECEF 坐标系的 Camera3D 交互。
 */
const scene: SceneConfig = {
  id: 'p1-globe-renderer',
  name: 'GlobeRenderer 大气/星空/阴影',

  controls: [
    { type: 'group', label: 'Atmosphere' },
    {
      type: 'switch',
      key: 'atmosphere',
      label: 'Show Atmosphere',
      defaultValue: true,
    },
    {
      type: 'slider',
      key: 'atmosphereIntensity',
      label: 'Intensity',
      min: 0,
      max: 2,
      step: 0.1,
      defaultValue: 1.0,
    },
    { type: 'group', label: 'Environment' },
    {
      type: 'switch',
      key: 'starfield',
      label: 'Show Starfield',
      defaultValue: true,
    },
    {
      type: 'switch',
      key: 'sunLighting',
      label: 'Sun Lighting',
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
        <div style="font-size:40px;margin-bottom:16px;">🌏</div>
        <h2 style="font-size:20px;font-weight:600;color:var(--text-primary);margin:0 0 8px 0;">GlobeRenderer</h2>
        <p style="font-size:13px;max-width:420px;text-align:center;line-height:1.6;margin:0;">
          Full 3D globe rendering in ECEF coordinate system with atmosphere
          scattering (Rayleigh + Mie), procedural starfield, sun position
          calculation, and terrain integration.
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
      'Globe State': {
        coordinateSystem: 'ECEF (WGS84)',
        radius: '6,378,137 m',
        visibleHemisphere: 'Northern',
      },
      'Atmosphere': {
        enabled: true,
        rayleighScaleHeight: '8.5 km',
        mieScaleHeight: '1.2 km',
        sunDirection: '[0.5, 0.7, 0.5]',
      },
      'Render Stats': {
        drawCalls: 6,
        triangles: 524288,
        gpuMemory: '86.3 MB',
        atmospherePassTime: '1.8 ms',
      },
    };
  },

  getSampleCode(): string {
    return `import { Globe } from '@geoforge/preset-3d';

const globe = new Globe({
  container: 'map',
  atmosphere: {
    enabled: true,
    intensity: 1.0,
    color: [0.3, 0.5, 1.0],
  },
  starfield: {
    enabled: true,
    count: 10000,
    magnitude: 6.5,
  },
  sun: {
    enabled: true,
    // Auto-calculate sun position from current UTC time
    autoPosition: true,
  },
  terrain: {
    source: 'dem',
    exaggeration: 1.0,
  },
  camera: {
    position: [116.39, 39.91],
    altitude: 20000000, // 20,000 km
  },
});

// Fly into a city
globe.flyTo({
  center: [116.39, 39.91],
  altitude: 50000,
  duration: 5000,
});`;
  },
};

export default scene;
