/**
 * @file MapViewport.tsx
 * @description GeoForge 引擎的 Canvas 容器组件。
 * 占满中间区域的所有可用空间，作为 WebGPU Canvas 的挂载点。
 * 当引擎未运行时显示占位符，左下角叠加 HUD 信息。
 *
 * @stability experimental
 */

import { useRef, useEffect, useState } from 'react';
import { Map, MonitorDot } from 'lucide-react';
import { useSceneStore } from '../stores/sceneStore';
import { scenes } from '../scenes';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** HUD 状态徽章图标尺寸（px） */
const HUD_ICON_SIZE = 12;

/** 占位符中央图标尺寸（px） */
const PLACEHOLDER_ICON_SIZE = 48;

// ═══════════════════════════════════════════════════════════
// 场景名称映射（临时方案，后续由 scenes/ 注册表提供）
// ═══════════════════════════════════════════════════════════

/**
 * 从 sceneId 生成人类可读的场景名称。
 * 将 kebab-case ID 转为首字母大写 + 空格分隔。
 * 后续将由 scenes/index.ts 注册表的 name 字段替代。
 *
 * @param sceneId - 场景 ID（如 'l0-math-vec'）
 * @returns 可读名称（如 'L0 Math Vec'）
 *
 * @example
 * formatSceneName('l0-math-vec'); // → 'L0 Math Vec'
 * formatSceneName('integration-city-2d'); // → 'Integration City 2d'
 */
function formatSceneName(sceneId: string): string {
  // 空 ID 返回默认占位名
  if (!sceneId) {
    return 'No Scene Selected';
  }

  // 按连字符分割，每段首字母大写
  return sceneId
    .split('-')
    .map((segment) => {
      if (segment.length === 0) return '';
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(' ');
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

/**
 * GeoForge 引擎 Canvas 容器组件（地图视口）。
 *
 * 职责：
 * 1. 提供 HTMLDivElement 容器，供 GeoForge 引擎挂载 WebGPU Canvas
 * 2. 监听 sceneStore.activeSceneId 变化，触发场景切换（onEnter/onLeave）
 * 3. 在左下角叠加 HUD 信息（场景名称 + 状态徽章）
 * 4. 引擎未运行时显示居中占位符
 *
 * @returns MapViewport JSX
 *
 * @example
 * <MapViewport />
 */
export function MapViewport(): JSX.Element {
  // ─── Refs ───

  /** Canvas 容器 DOM 引用，传给引擎的 container 参数 */
  const containerRef = useRef<HTMLDivElement>(null);

  // ─── Store 订阅 ───

  /** 当前激活的场景 ID */
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  // ─── 本地状态 ───

  /** 引擎运行状态标签（用于 HUD 显示） */
  const [engineStatus, setEngineStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');

  // ─── 场景切换 Effect ───

  /**
   * 监听 activeSceneId 变化，执行场景的 onEnter/onLeave 生命周期。
   * 当前阶段（Phase 1）仅更新状态，实际引擎集成在 Phase 4 实现。
   */
  useEffect(() => {
    if (!activeSceneId || !containerRef.current) {
      setEngineStatus('idle');
      return;
    }

    setEngineStatus('loading');

    const scene = scenes[activeSceneId];
    const container = containerRef.current;

    if (scene) {
      // 清空容器内容（上一个场景的残留 DOM）
      container.innerHTML = '';
      try {
        scene.onEnter(container);
        setEngineStatus('ready');
      } catch (err) {
        console.error(`[MapViewport] scene onEnter failed:`, err);
        setEngineStatus('error');
      }
    } else {
      // 未注册的 sceneId — 显示通用占位信息
      container.innerHTML = '';
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;';
      placeholder.innerHTML = `
        <div style="font-size:40px;margin-bottom:12px;opacity:0.5;">📦</div>
        <div style="font-size:16px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">${formatSceneName(activeSceneId)}</div>
        <div style="font-size:13px;color:var(--text-muted);max-width:320px;text-align:center;line-height:1.6;">
          该模块的交互式测试场景尚未实现。<br/>请选择带 ● 标记的已实现场景。
        </div>
      `;
      container.appendChild(placeholder);
      setEngineStatus('ready');
    }

    return () => {
      // 场景切换时清理上一个场景
      if (scene) {
        try {
          scene.onLeave();
        } catch {
          // 忽略清理错误
        }
      }
      if (container) {
        container.innerHTML = '';
      }
      setEngineStatus('idle');
    };
  }, [activeSceneId]);

  // ─── 派生数据 ───

  /** 当前场景的可读名称 */
  const sceneName = formatSceneName(activeSceneId);

  /** 状态徽章的颜色映射 */
  const statusConfig: Record<
    typeof engineStatus,
    { label: string; color: string }
  > = {
    idle: { label: 'Idle', color: 'var(--text-muted)' },
    loading: { label: 'Loading...', color: 'var(--warning)' },
    ready: { label: 'Ready', color: 'var(--success)' },
    error: { label: 'Error', color: 'var(--error)' },
  };

  /** 当前状态的配置 */
  const currentStatus = statusConfig[engineStatus];

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* ─── 占位符（仅在无场景或 loading 状态时叠加半透明遮罩） ─── */}
      {!activeSceneId && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 pointer-events-none">
          <div
            className="p-4 rounded-2xl"
            style={{ background: 'var(--bg-panel)', opacity: 0.4 }}
          >
            <Map
              size={PLACEHOLDER_ICON_SIZE}
              style={{ color: 'var(--text-muted)' }}
            />
          </div>
          <p
            className="text-base"
            style={{ color: 'var(--text-muted)', opacity: 0.6 }}
          >
            从左侧功能树选择一个测试场景
          </p>
        </div>
      )}

      {/* ─── HUD 叠加层（左下角）─── */}
      {activeSceneId && (
        <div
          className="absolute bottom-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-md"
          style={{
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(8px)',
            color: '#ffffff',
            fontSize: '12px',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            zIndex: 10,
          }}
        >
          {/* 场景名称 */}
          <MonitorDot size={HUD_ICON_SIZE} style={{ opacity: 0.7 }} />
          <span className="opacity-90">{sceneName}</span>

          {/* 分隔点 */}
          <span className="opacity-30">·</span>

          {/* 状态徽章 */}
          <span
            className="flex items-center gap-1"
            style={{ color: currentStatus.color }}
          >
            {/* 状态指示圆点 */}
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: currentStatus.color,
                // loading 状态添加脉冲动画
                animation:
                  engineStatus === 'loading'
                    ? 'pulse 1.5s ease-in-out infinite'
                    : 'none',
              }}
            />
            {currentStatus.label}
          </span>
        </div>
      )}

      {/* ─── 脉冲动画 keyframes（内联注入）─── */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
