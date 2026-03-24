import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { useSceneStore } from '../stores/sceneStore';
import { scenes } from '../scenes';

/* ═══════════════════════════════════════════════════════════════════
   CodePreview — 代码预览 + 复制按钮
   显示当前场景的 getSampleCode() 返回的最小可运行代码示例。
   MVP 阶段使用 <pre><code> 纯文本渲染，后续可升级为 Shiki 高亮。
   ═══════════════════════════════════════════════════════════════════ */

/** "Copied!" 状态持续时间（毫秒）。1.5 秒后恢复为 Copy 图标。 */
const COPIED_FEEDBACK_MS = 1500;

/** Lucide 图标统一尺寸（像素） */
const ICON_SIZE = 14;

/**
 * 代码预览面板：展示当前场景的最小可运行代码 + 一键复制功能。
 *
 * 实现细节：
 * - 代码来自 `scenes[activeSceneId].getSampleCode()`
 * - 使用 `<pre><code>` 渲染（MVP 不依赖 Shiki，减少包体积）
 * - 复制按钮使用 `navigator.clipboard` API
 * - 复制后图标从 Copy 变为 Check，1.5 秒后自动恢复
 *
 * @returns 代码预览面板 JSX
 *
 * @example
 * <CodePreview />
 */
export function CodePreview() {
  /* ── 状态 ── */

  /** 复制成功后的短暂反馈状态 */
  const [copied, setCopied] = useState(false);

  /* 从 store 获取当前场景 ID */
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  /* 从场景注册表中获取场景配置 */
  const scene = activeSceneId ? scenes[activeSceneId] : null;

  /* 获取代码文本；无场景时为空字符串 */
  const code = scene?.getSampleCode?.() ?? '';

  /**
   * 将代码文本复制到系统剪贴板。
   * 使用 Clipboard API（现代浏览器均支持）。
   * 复制成功后设置 copied=true，超时后自动恢复。
   */
  const handleCopy = useCallback(async () => {
    /* 空代码时不执行复制操作 */
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);

      /* 1.5 秒后恢复按钮状态 */
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      /* 剪贴板 API 在部分环境（如 iframe 无权限）可能失败 */
      console.warn('[CodePreview] clipboard.writeText failed');
    }
  }, [code]);

  /* 未选中场景时显示占位提示 */
  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-[var(--text-muted)]">Select a scene to view code</p>
      </div>
    );
  }

  /* 场景存在但无示例代码 */
  if (!code) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-[var(--text-muted)]">No sample code available</p>
      </div>
    );
  }

  return (
    <div className="relative h-full p-3">
      {/* ── 复制按钮（右上角浮动）── */}
      <button
        type="button"
        onClick={handleCopy}
        className={[
          'absolute top-5 right-5 z-10 flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
          /* 复制成功时变为绿色反馈，否则显示半透明悬浮按钮 */
          copied
            ? 'bg-[var(--success)]/20 text-[var(--success)]'
            : 'bg-[var(--bg-panel)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        ].join(' ')}
        title="Copy to clipboard"
      >
        {/* 根据复制状态切换图标 */}
        {copied ? <Check size={ICON_SIZE} /> : <Copy size={ICON_SIZE} />}
        {/* 复制成功时显示文字反馈 */}
        {copied && <span>Copied!</span>}
      </button>

      {/* ── 代码块 ── */}
      <pre className="h-full overflow-auto rounded-md bg-[var(--bg-input)] p-3">
        <code className="block whitespace-pre font-mono text-xs leading-relaxed text-[var(--text-primary)]">
          {code}
        </code>
      </pre>
    </div>
  );
}
