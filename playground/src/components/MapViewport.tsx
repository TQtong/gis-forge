/**
 * @file MapViewport.tsx
 * @description GeoForge 引擎的 Canvas 容器组件。
 * 使用两层结构：底层是场景容器（手动 DOM），上层是 React 管理的 HUD/占位符。
 * 避免 React 虚拟 DOM 与场景手动 DOM 操作冲突。
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { Map, MonitorDot } from 'lucide-react';
import { useSceneStore } from '../stores/sceneStore';
import { scenes } from '../scenes';

/** HUD 图标尺寸 */
const HUD_ICON_SIZE = 12;

/** 占位符图标尺寸 */
const PLACEHOLDER_ICON_SIZE = 48;

/**
 * 从 sceneId 生成可读的场景名称。
 */
function formatSceneName(sceneId: string): string {
  if (!sceneId) return 'No Scene Selected';
  return sceneId
    .split('-')
    .map((s) => (s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ');
}

/**
 * 地图视口组件。
 *
 * 结构：
 * ```
 * <wrapper>                       ← React ref, 占满空间
 *   <sceneContainer>              ← 独立 div, React 不管理其子节点, 场景 onEnter 挂载到这里
 *   <overlayLayer>                ← React 管理, absolute 叠加, pointer-events-none
 *     占位符 / HUD
 *   </overlayLayer>
 * </wrapper>
 * ```
 */
export function MapViewport(): JSX.Element {
  /** 场景容器 ref — 场景的 onEnter 将内容挂载到这个 div */
  const sceneRef = useRef<HTMLDivElement>(null);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  const [engineStatus, setEngineStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');

  // ─── 场景生命周期 ───
  useEffect(() => {
    const container = sceneRef.current;
    if (!activeSceneId || !container) {
      setEngineStatus('idle');
      return;
    }

    // 清空上一个场景的 DOM（安全：React 不管理 sceneRef 的子节点）
    container.innerHTML = '';
    setEngineStatus('loading');

    const scene = scenes[activeSceneId];

    if (scene) {
      try {
        scene.onEnter(container);
        setEngineStatus('ready');
      } catch (err) {
        console.error(`[MapViewport] scene onEnter failed:`, err);
        setEngineStatus('error');
      }
    } else {
      // 未注册的 sceneId — 显示通用占位
      const el = document.createElement('div');
      el.style.cssText =
        'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-family:Inter,system-ui,sans-serif;';
      el.innerHTML = `
        <div style="font-size:40px;margin-bottom:12px;opacity:0.5;">📦</div>
        <div style="font-size:16px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">${formatSceneName(activeSceneId)}</div>
        <div style="font-size:13px;color:var(--text-muted);max-width:320px;text-align:center;line-height:1.6;">
          该模块的交互式测试场景尚未实现。<br/>请选择带 <span style="color:var(--success)">●</span> 标记的已实现场景。
        </div>
      `;
      container.appendChild(el);
      setEngineStatus('ready');
    }

    return () => {
      if (scene) {
        try { scene.onLeave(); } catch { /* ignore */ }
      }
      if (container) {
        container.innerHTML = '';
      }
      setEngineStatus('idle');
    };
  }, [activeSceneId]);

  // ─── 状态配置 ───
  const sceneName = formatSceneName(activeSceneId);
  const statusConfig: Record<typeof engineStatus, { label: string; color: string }> = {
    idle: { label: 'Idle', color: 'var(--text-muted)' },
    loading: { label: 'Loading...', color: 'var(--warning)' },
    ready: { label: 'Ready', color: 'var(--success)' },
    error: { label: 'Error', color: 'var(--error)' },
  };
  const currentStatus = statusConfig[engineStatus];

  return (
    <div
      className="w-full h-full relative overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* 底层：场景容器 — React 不管理其子节点，避免 removeChild 冲突 */}
      <div
        ref={sceneRef}
        className="absolute inset-0"
        style={{ zIndex: 0 }}
      />

      {/* 上层：React 管理的 UI 叠加层 */}

      {/* 占位符（无场景时显示） */}
      {!activeSceneId && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 pointer-events-none"
          style={{ zIndex: 1 }}
        >
          <div
            className="p-4 rounded-2xl"
            style={{ background: 'var(--bg-panel)', opacity: 0.4 }}
          >
            <Map size={PLACEHOLDER_ICON_SIZE} style={{ color: 'var(--text-muted)' }} />
          </div>
          <p className="text-base" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            从左侧功能树选择一个测试场景
          </p>
        </div>
      )}

      {/* HUD（有场景时显示） */}
      {activeSceneId && (
        <div
          className="absolute bottom-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-md pointer-events-none"
          style={{
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(8px)',
            color: '#ffffff',
            fontSize: '12px',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            zIndex: 10,
          }}
        >
          <MonitorDot size={HUD_ICON_SIZE} style={{ opacity: 0.7 }} />
          <span className="opacity-90">{sceneName}</span>
          <span className="opacity-30">·</span>
          <span className="flex items-center gap-1" style={{ color: currentStatus.color }}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: currentStatus.color,
                animation: engineStatus === 'loading' ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }}
            />
            {currentStatus.label}
          </span>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
