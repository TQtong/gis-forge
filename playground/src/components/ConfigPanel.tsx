import { useSceneStore } from '../stores/sceneStore';
import { scenes } from '../scenes';
import type { ControlDefinition } from '../types';
import { RotateCcw } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════
   ConfigPanel — 动态配置控件面板
   根据当前场景的 controls 数组渲染对应的表单控件。
   修改实时写入 sceneStore.configValues，引擎端订阅后即时响应。
   ═══════════════════════════════════════════════════════════════════ */

/** Lucide 图标统一尺寸（像素） */
const ICON_SIZE = 14;

/* ── 控件渲染子组件 ──────────────────────────────────────── */

/** SliderControl 的 Props */
interface SliderControlProps {
  /** 控件唯一标识键，写入 configValues 时使用 */
  controlKey: string;
  /** 显示标签 */
  label: string;
  /** 滑块最小值 */
  min: number;
  /** 滑块最大值 */
  max: number;
  /** 滑块步长 */
  step: number;
  /** 当前值（从 configValues 中读取） */
  value: number;
  /** 值变更回调 */
  onChange: (key: string, value: number) => void;
}

/**
 * 滑块控件：范围输入 + 右侧数值显示。
 * 使用原生 `<input type="range">` 以减少依赖。
 *
 * @param props - 滑块参数
 * @returns 滑块行 JSX
 *
 * @example
 * <SliderControl controlKey="opacity" label="Opacity" min={0} max={1} step={0.05} value={0.8} onChange={handleChange} />
 */
function SliderControl({ controlKey, label, min, max, step, value, onChange }: SliderControlProps) {
  return (
    <div className="flex flex-col gap-1">
      {/* 标签行：左侧控件名称 + 右侧当前数值 */}
      <div className="flex items-center justify-between">
        <label className="text-xs text-[var(--text-secondary)]">{label}</label>
        {/* 等宽字体显示数值，固定宽度防止因数字位数变化导致布局跳动 */}
        <span className="w-14 text-right font-mono text-xs text-[var(--text-primary)]">
          {value}
        </span>
      </div>
      {/* 原生 range input，全宽 */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(controlKey, parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--bg-input)] accent-[var(--accent)]"
      />
    </div>
  );
}

/** SwitchControl 的 Props */
interface SwitchControlProps {
  /** 控件唯一标识键 */
  controlKey: string;
  /** 显示标签 */
  label: string;
  /** 当前布尔值 */
  checked: boolean;
  /** 值变更回调 */
  onChange: (key: string, value: boolean) => void;
}

/**
 * 开关控件：checkbox 样式的布尔切换。
 * 使用原生 `<input type="checkbox">` + 自定义样式。
 *
 * @param props - 开关参数
 * @returns 开关行 JSX
 *
 * @example
 * <SwitchControl controlKey="msaa" label="MSAA" checked={true} onChange={handleChange} />
 */
function SwitchControl({ controlKey, label, checked, onChange }: SwitchControlProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-0.5">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      {/* 自定义 toggle 外观：圆角矩形 + 滑块圆点 */}
      <div className="relative">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(controlKey, e.target.checked)}
          className="peer sr-only"
        />
        {/* 轨道背景：未选中灰色，选中 accent */}
        <div className="h-5 w-9 rounded-full bg-[var(--bg-input)] transition-colors peer-checked:bg-[var(--accent)]" />
        {/* 滑块圆点：选中时右移 */}
        <div className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
      </div>
    </label>
  );
}

/** ColorControl 的 Props */
interface ColorControlProps {
  /** 控件唯一标识键 */
  controlKey: string;
  /** 显示标签 */
  label: string;
  /** 当前颜色值（#rrggbb 格式） */
  value: string;
  /** 值变更回调 */
  onChange: (key: string, value: string) => void;
}

/**
 * 颜色控件：原生颜色选择器 + hex 文本输入。
 * 两个输入联动：修改任一个都会同步更新另一个。
 *
 * @param props - 颜色参数
 * @returns 颜色行 JSX
 *
 * @example
 * <ColorControl controlKey="fillColor" label="Fill Color" value="#3388ff" onChange={handleChange} />
 */
function ColorControl({ controlKey, label, value, onChange }: ColorControlProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-[var(--text-secondary)]">{label}</label>
      <div className="flex items-center gap-2">
        {/* 原生颜色选择器：小正方形，点击弹出系统调色板 */}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(controlKey, e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent"
        />
        {/* Hex 文本输入框，允许手动输入精确颜色值 */}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(controlKey, e.target.value)}
          className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </div>
    </div>
  );
}

/** SelectControl 的 Props */
interface SelectControlProps {
  /** 控件唯一标识键 */
  controlKey: string;
  /** 显示标签 */
  label: string;
  /** 可选项列表 */
  options: { value: string; label: string }[];
  /** 当前选中值 */
  value: string;
  /** 值变更回调 */
  onChange: (key: string, value: string) => void;
}

/**
 * 下拉选择控件：原生 `<select>` 元素。
 *
 * @param props - 选择器参数
 * @returns 选择器行 JSX
 *
 * @example
 * <SelectControl controlKey="source" label="Tile Source" options={[...]} value="osm" onChange={handleChange} />
 */
function SelectControl({ controlKey, label, options, value, onChange }: SelectControlProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-[var(--text-secondary)]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(controlKey, e.target.value)}
        className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ── 主组件 ──────────────────────────────────────────────── */

/**
 * 动态配置面板。根据当前场景的 `controls` 数组生成对应的表单控件。
 *
 * 支持的控件类型：
 * - `'group'`  → 分组标题（分隔线 + 大写标题）
 * - `'slider'` → 范围滑块 + 数值显示
 * - `'switch'` → 布尔开关
 * - `'color'`  → 颜色选择器 + hex 输入
 * - `'select'` → 下拉选择
 *
 * 控件的 onChange 调用 `sceneStore.setConfigValue(key, value)`，
 * 引擎端订阅 configValues 变化后即时应用。
 *
 * @returns 配置面板 JSX
 *
 * @example
 * <ConfigPanel />
 */
export function ConfigPanel() {
  /* 从 store 读取当前场景 ID 和配置值 */
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const configValues = useSceneStore((s) => s.configValues);
  const setConfigValue = useSceneStore((s) => s.setConfigValue);
  const resetConfig = useSceneStore((s) => s.resetConfig);

  /* 从场景注册表中获取当前场景配置 */
  const scene = activeSceneId ? scenes[activeSceneId] : null;

  /* 未选择场景时显示占位提示 */
  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-[var(--text-muted)]">Select a scene</p>
      </div>
    );
  }

  /* 获取场景的控件定义数组，若无则为空数组 */
  const controls: ControlDefinition[] = scene.controls ?? [];

  /**
   * 读取某个控件的当前值。
   * 优先从 configValues 中获取用户修改的值，
   * 找不到时回退到控件定义的 defaultValue。
   */
  function getControlValue(ctrl: ControlDefinition): unknown {
    if (ctrl.type === 'group') return undefined;
    const storeValue = configValues[ctrl.key];
    /* 使用 ?? 而非 || ，因为 0、false、"" 是合法的用户值 */
    return storeValue ?? ctrl.defaultValue;
  }

  /**
   * 根据控件类型渲染对应的 UI 组件。
   * 使用 switch-case 确保穷举所有 ControlDefinition 变体。
   */
  function renderControl(ctrl: ControlDefinition, index: number) {
    switch (ctrl.type) {
      /* ── 分组标题 ── */
      case 'group':
        return (
          <div
            key={`group-${index}`}
            className={[
              'text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]',
              /* 第一个 group 不需要顶部分隔线 */
              index > 0 ? 'mt-3 border-t border-[var(--border)] pt-3' : '',
            ].join(' ')}
          >
            {ctrl.label}
          </div>
        );

      /* ── 滑块 ── */
      case 'slider':
        return (
          <SliderControl
            key={ctrl.key}
            controlKey={ctrl.key}
            label={ctrl.label}
            min={ctrl.min}
            max={ctrl.max}
            step={ctrl.step}
            value={getControlValue(ctrl) as number}
            onChange={setConfigValue}
          />
        );

      /* ── 布尔开关 ── */
      case 'switch':
        return (
          <SwitchControl
            key={ctrl.key}
            controlKey={ctrl.key}
            label={ctrl.label}
            checked={getControlValue(ctrl) as boolean}
            onChange={setConfigValue}
          />
        );

      /* ── 颜色选择 ── */
      case 'color':
        return (
          <ColorControl
            key={ctrl.key}
            controlKey={ctrl.key}
            label={ctrl.label}
            value={getControlValue(ctrl) as string}
            onChange={setConfigValue}
          />
        );

      /* ── 下拉选择 ── */
      case 'select':
        return (
          <SelectControl
            key={ctrl.key}
            controlKey={ctrl.key}
            label={ctrl.label}
            options={ctrl.options}
            value={getControlValue(ctrl) as string}
            onChange={setConfigValue}
          />
        );

      /* 类型安全兜底：未知控件类型不渲染 */
      default:
        return null;
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── 控件列表（可滚动） ── */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3">
          {controls.map((ctrl, i) => renderControl(ctrl, i))}
        </div>
      </div>

      {/* ── 底部操作栏：重置按钮 ── */}
      <div className="shrink-0 border-t border-[var(--border)] p-3">
        <button
          type="button"
          onClick={resetConfig}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <RotateCcw size={ICON_SIZE} />
          Reset Default
        </button>
      </div>
    </div>
  );
}
