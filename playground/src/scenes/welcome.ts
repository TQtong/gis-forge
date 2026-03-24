// ============================================================
// playground/src/scenes/welcome.ts
// 默认欢迎页场景 — 首次加载或无选中场景时展示。
// 无引擎初始化，纯 HTML 内容。
// ============================================================

import type { SceneConfig } from '../types';

/**
 * 欢迎页场景配置。
 * 在地图视口中渲染静态欢迎信息，引导用户从左侧面板选择功能。
 * 无控件、无引擎实例、无运行时数据。
 */
const scene: SceneConfig = {
  id: 'welcome',
  name: 'Welcome to GeoForge DevPlayground',

  /** 欢迎页无可配置控件 */
  controls: [],

  /**
   * 进入欢迎页：渲染居中的欢迎信息 HTML。
   * 使用 CSS 变量保持与当前主题一致的配色。
   *
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    // 直接写入静态 HTML，无需 Canvas 或引擎
    container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-secondary);
        font-family: Inter, system-ui, sans-serif;
        user-select: none;
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">🌍</div>
        <h1 style="
          font-size: 24px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0 0 8px 0;
        ">GeoForge DevPlayground</h1>
        <p style="
          font-size: 14px;
          max-width: 400px;
          text-align: center;
          line-height: 1.6;
          margin: 0 0 24px 0;
        ">
          Select a feature from the left panel to start exploring.<br/>
          91 core modules + 27 optional packages ready for testing.
        </p>
        <div style="
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          justify-content: center;
          max-width: 480px;
        ">
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">Camera2D</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">RasterTile</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">VectorTile</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">GeoJSON</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">Terrain</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">Globe</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">Heatmap</span>
          <span style="
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--highlight);
            color: var(--accent);
          ">Analysis</span>
        </div>
      </div>
    `;
  },

  /**
   * 离开欢迎页：清空容器内容。
   * 欢迎页无引擎实例或事件监听需要清理。
   */
  onLeave(): void {
    // 无资源需要释放
  },

  /**
   * 欢迎页无运行时数据。
   *
   * @returns 空对象
   */
  getInspectorData(): Record<string, unknown> {
    return {};
  },

  /**
   * 返回引导性的示例代码注释。
   *
   * @returns 提示用户选择场景的代码字符串
   */
  getSampleCode(): string {
    return `// Select a scene from the left panel to see example code.
//
// Quick start:
// 1. Click "Camera2D" to test pan/zoom interaction
// 2. Click "RasterTileLayer" to see OSM tile rendering
// 3. Click "GeoJSONLayer" to visualize vector data
//
// Each scene shows:
//   - Live engine rendering in the viewport
//   - Configurable parameters in the right panel
//   - Runtime inspector data
//   - Minimal runnable code example`;
  },
};

export default scene;
