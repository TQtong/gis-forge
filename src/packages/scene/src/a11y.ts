// ============================================================
// L4/scene/a11y.ts — 无障碍：键盘映射、ARIA  live region、屏幕阅读器播报
// 层级：L4（场景）
// 职责：键盘导航占位、aria-live 区域、高对比与 reduced-motion 查询。
// 依赖：L0 Feature（零 npm）。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 高对比模式在 documentElement 上使用的 className */
const HIGH_CONTRAST_CLASS = 'gis-forge-a11y-high-contrast';

/** Live region 元素 ID，便于单例复用 */
const LIVE_REGION_ID = 'gis-forge-a11y-live-region';

/** 屏幕阅读器轮播要素时最大缓存条数，防止内存增长 */
const MAX_FOCUS_RING = 512;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 键盘动作语义（与具体地图平移/缩放实现解耦；MVP 仅播报与事件派发准备）。
 *
 * @example
 * const a: A11yKeyAction = 'panNorth';
 */
export type A11yKeyAction =
  | 'panNorth'
  | 'panSouth'
  | 'panWest'
  | 'panEast'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetView'
  | 'focusNext'
  | 'focusPrevious';

/**
 * 键位映射：KeyboardEvent.code → 语义动作。
 * 使用 `code` 而非 `key`，避免布局/输入法差异。
 *
 * @example
 * const m: A11yKeyMap = { ArrowUp: 'panNorth', Equal: 'zoomIn' };
 */
export type A11yKeyMap = Readonly<Partial<Record<string, A11yKeyAction>>>;

/**
 * 无障碍管理器接口。
 *
 * @example
 * const a11y = createA11yManager();
 * a11y.enableKeyboardNavigation(true);
 */
export interface A11yManager {
  /**
   * 开关键盘导航（注册/移除全局 keydown 监听）。
   *
   * @param enabled - 是否启用；省略视为 true
   *
   * @example
   * mgr.enableKeyboardNavigation(false);
   */
  enableKeyboardNavigation(enabled?: boolean): void;

  /**
   * 当前是否启用键盘导航。
   *
   * @example
   * if (mgr.isKeyboardNavigationEnabled()) { ... }
   */
  isKeyboardNavigationEnabled(): boolean;

  /**
   * 当前键位映射（只读视图；修改请用 setKeyMap）。
   *
   * @example
   * const km = mgr.keyMap;
   */
  readonly keyMap: A11yKeyMap;

  /**
   * 合并覆盖默认键位（未指定的键保留默认）。
   *
   * @param partial - 局部映射
   *
   * @example
   * mgr.setKeyMap({ KeyW: 'panNorth' });
   */
  setKeyMap(partial: A11yKeyMap): void;

  /**
   * 为逻辑控件设置可访问名称（写入内部表并刷新 live region 提示）。
   *
   * @param controlId - 控件稳定 ID
   * @param label - 短标签
   *
   * @example
   * mgr.setAriaLabel('zoom-in', '放大');
   */
  setAriaLabel(controlId: string, label: string): void;

  /**
   * 为逻辑控件设置详细描述。
   *
   * @param controlId - 控件稳定 ID
   * @param description - 长描述
   *
   * @example
   * mgr.setAriaDescription('compass', '旋转地图以改变北方朝向');
   */
  setAriaDescription(controlId: string, description: string): void;

  /**
   * 向屏幕阅读器播报视图变化（例如飞行动画结束）。
   *
   * @param message - 可读文本
   *
   * @example
   * mgr.announceViewChange('已缩放到级别 12');
   */
  announceViewChange(message: string): void;

  /**
   * 播报要素摘要并加入焦点环列表。
   *
   * @param feature - GeoJSON Feature
   *
   * @example
   * mgr.announceFeature(myFeature);
   */
  announceFeature(feature: Feature): void;

  /**
   * 当前键盘焦点对应的要素（由 focusNext/focusPrevious 驱动）。
   *
   * @example
   * const f = mgr.focusedFeature;
   */
  readonly focusedFeature: Feature | null;

  /**
   * 焦点移到下一个已播报要素（环形）。
   *
   * @returns 是否成功移动
   *
   * @example
   * mgr.focusNext();
   */
  focusNext(): boolean;

  /**
   * 焦点移到上一个已播报要素（环形）。
   *
   * @returns 是否成功移动
   *
   * @example
   * mgr.focusPrevious();
   */
  focusPrevious(): boolean;

  /**
   * 开关高对比样式（在 documentElement 上挂 class）。
   *
   * @param enabled - 是否启用
   *
   * @example
   * mgr.enableHighContrast(true);
   */
  enableHighContrast(enabled: boolean): void;

  /**
   * 是否已启用高对比。
   *
   * @example
   * if (mgr.isHighContrastEnabled()) { ... }
   */
  isHighContrastEnabled(): boolean;

  /**
   * 用户系统是否偏好减少动效（matchMedia）。
   *
   * @returns 无 window 或非浏览器时为 false
   *
   * @example
   * if (mgr.prefersReducedMotion()) { skipAnimation(); }
   */
  prefersReducedMotion(): boolean;
}

// ---------------------------------------------------------------------------
// 默认键位
// ---------------------------------------------------------------------------

/**
 * 构建默认键位：方向键平移、+/- 缩放、R 重置、Tab 式焦点环。
 *
 * @returns 默认映射
 *
 * @example
 * const d = createDefaultKeyMap();
 */
export function createDefaultKeyMap(): A11yKeyMap {
  return {
    ArrowUp: 'panNorth',
    ArrowDown: 'panSouth',
    ArrowLeft: 'panWest',
    ArrowRight: 'panEast',
    Equal: 'zoomIn',
    NumpadAdd: 'zoomIn',
    Minus: 'zoomOut',
    NumpadSubtract: 'zoomOut',
    KeyR: 'resetView',
    // 使用 PageDown/PageUp 避免劫持 Tab 焦点环（浏览器默认行为）
    PageDown: 'focusNext',
    PageUp: 'focusPrevious',
  } as const;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 检测是否在浏览器环境且存在 document。
 *
 * @returns 是否可用 DOM
 *
 * @example
 * if (hasDom()) { ... }
 */
function hasDom(): boolean {
  return typeof document !== 'undefined' && document != null && typeof document.createElement === 'function';
}

/**
 * 检测是否存在 window 与 matchMedia。
 *
 * @returns 是否可查询媒体特性
 *
 * @example
 * if (hasWindow()) { ... }
 */
function hasWindow(): boolean {
  return typeof window !== 'undefined' && window != null && typeof window.matchMedia === 'function';
}

/**
 * 将文本截断到安全长度，避免 live region 文本爆炸。
 *
 * @param s - 输入
 * @param max - 最大字符数
 * @returns 截断后字符串
 *
 * @example
 * truncateText('x'.repeat(9999), 1000);
 */
function truncateText(s: string, max: number): string {
  if (typeof s !== 'string') {
    return '';
  }
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 从 Feature 提取简短播报字符串。
 *
 * @param f - 要素
 * @returns 文本
 *
 * @example
 * summarizeFeature(feature);
 */
function summarizeFeature(f: Feature): string {
  try {
    const idPart = f.id != null ? ` id ${String(f.id)}` : '';
    const props = f.properties as Record<string, unknown> | null | undefined;
    let name = '';
    if (props && typeof props === 'object') {
      const n = props.name ?? props.title ?? props.NAME;
      if (typeof n === 'string') {
        name = n;
      } else if (n != null) {
        name = String(n);
      }
    }
    const geo = f.geometry && typeof f.geometry === 'object' ? f.geometry.type : 'Unknown';
    const base = name.length > 0 ? name : geo;
    return truncateText(`要素${idPart}：${base}`, 512);
  } catch {
    return '要素';
  }
}

/**
 * 合并键位映射（后者覆盖前者）。
 *
 * @param base - 基础
 * @param override - 覆盖
 * @returns 合并结果
 *
 * @example
 * mergeKeyMaps(defaults, { KeyW: 'panNorth' });
 */
function mergeKeyMaps(base: A11yKeyMap, override: A11yKeyMap): A11yKeyMap {
  const out: Record<string, A11yKeyAction> = {};
  const baseKeys = Object.keys(base as Record<string, unknown>);
  for (let i = 0; i < baseKeys.length; i++) {
    const k = baseKeys[i];
    const v = (base as Record<string, A11yKeyAction | undefined>)[k];
    if (v != null) {
      out[k] = v;
    }
  }
  const keys = Object.keys(override as Record<string, unknown>);
  for (let j = 0; j < keys.length; j++) {
    const k = keys[j];
    const v = (override as Record<string, A11yKeyAction | undefined>)[k];
    if (v != null) {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 创建无障碍管理器（单页应用内可多次创建，但通常单例）。
 *
 * @returns A11yManager
 *
 * @example
 * const a11y = createA11yManager();
 */
export function createA11yManager(): A11yManager {
  /** 是否注册全局键盘监听 */
  let keyboardEnabled = false;

  /** keydown 处理器引用，便于移除 */
  let keydownHandler: ((ev: KeyboardEvent) => void) | null = null;

  /** 当前键位（可变，经 setKeyMap 更新） */
  let keyMapState: A11yKeyMap = createDefaultKeyMap();

  /** 逻辑控件标签 */
  const labels = new Map<string, string>();

  /** 逻辑控件描述 */
  const descriptions = new Map<string, string>();

  /** 已播报要素环 */
  const focusRing: Feature[] = [];

  /** 焦点索引 [-1, focusRing.length-1] */
  let focusIndex = -1;

  /** 高对比开关 */
  let highContrast = false;

  /** 缓存的 live region 元素 */
  let liveRegionEl: HTMLDivElement | null = null;

  /**
   * 确保 live region 节点存在并返回。
   *
   * @returns 元素或 null（无 DOM）
   */
  const ensureLiveRegion = (): HTMLDivElement | null => {
    if (!hasDom()) {
      return null;
    }
    try {
      const existing = document.getElementById(LIVE_REGION_ID) as HTMLDivElement | null;
      if (existing) {
        liveRegionEl = existing;
        return existing;
      }
      const el = document.createElement('div');
      el.id = LIVE_REGION_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      // 视觉隐藏但保持可被辅助技术读出
      el.style.position = 'absolute';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.padding = '0';
      el.style.margin = '-1px';
      el.style.overflow = 'hidden';
      el.style.clipPath = 'inset(50%)';
      el.style.whiteSpace = 'nowrap';
      el.style.border = '0';
      const host = document.body ?? document.documentElement;
      host.appendChild(el);
      liveRegionEl = el;
      return el;
    } catch (err) {
      console.error('[A11yManager] ensureLiveRegion failed', err);
      return null;
    }
  };

  /**
   * 向 live region 写入文本（触发 polite 播报）。
   *
   * @param text - 文本
   */
  const pushLive = (text: string): void => {
    const safe = truncateText(text, 2048);
    const el = ensureLiveRegion();
    if (el == null) {
      return;
    }
    try {
      // 连续写入相同文本时强制微变，确保 NVDA/JAWS 重新播报
      el.textContent = '';
      // 微任务后写入，保证 DOM 刷新
      void Promise.resolve().then(() => {
        try {
          el.textContent = safe;
        } catch (err) {
          console.error('[A11yManager] pushLive async write failed', err);
        }
      });
    } catch (err) {
      console.error('[A11yManager] pushLive failed', err);
    }
  };

  /**
   * 焦点环：下一项（与 focusNext 共享逻辑，避免引用未初始化的 mgr）。
   *
   * @returns 是否移动成功
   */
  const focusNextInternal = (): boolean => {
    if (focusRing.length === 0) {
      focusIndex = -1;
      pushLive('暂无可聚焦要素');
      return false;
    }
    focusIndex = (focusIndex + 1) % focusRing.length;
    const f = focusRing[focusIndex];
    if (f) {
      pushLive(summarizeFeature(f));
    }
    return true;
  };

  /**
   * 焦点环：上一项。
   *
   * @returns 是否移动成功
   */
  const focusPreviousInternal = (): boolean => {
    if (focusRing.length === 0) {
      focusIndex = -1;
      pushLive('暂无可聚焦要素');
      return false;
    }
    focusIndex = (focusIndex - 1 + focusRing.length) % focusRing.length;
    const f = focusRing[focusIndex];
    if (f) {
      pushLive(summarizeFeature(f));
    }
    return true;
  };

  /**
   * 处理键盘：查表并播报对应动作。
   *
   * @param ev - 键盘事件
   */
  const onKeyDown = (ev: KeyboardEvent): void => {
    try {
      const code = ev.code;
      const action = (keyMapState as Record<string, A11yKeyAction | undefined>)[code];
      if (action == null) {
        return;
      }
      // 对可打印键避免与表单冲突：仅当目标非输入元素时处理
      const t = ev.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase() ?? '';
      if (tag === 'input' || tag === 'textarea' || (t as HTMLElement | null)?.isContentEditable) {
        return;
      }
      ev.preventDefault();
      switch (action) {
        case 'panNorth':
          pushLive('向北平移地图');
          break;
        case 'panSouth':
          pushLive('向南平移地图');
          break;
        case 'panWest':
          pushLive('向西平移地图');
          break;
        case 'panEast':
          pushLive('向东平移地图');
          break;
        case 'zoomIn':
          pushLive('放大');
          break;
        case 'zoomOut':
          pushLive('缩小');
          break;
        case 'resetView':
          pushLive('重置视图');
          break;
        case 'focusNext':
          focusNextInternal();
          break;
        case 'focusPrevious':
          focusPreviousInternal();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[A11yManager] onKeyDown error', err);
    }
  };

  const mgr: A11yManager = {
    enableKeyboardNavigation(enabled?: boolean): void {
      const on = enabled !== false;
      if (on === keyboardEnabled) {
        return;
      }
      if (!hasWindow()) {
        keyboardEnabled = false;
        return;
      }
      try {
        if (on) {
          keydownHandler = onKeyDown;
          window.addEventListener('keydown', keydownHandler, false);
          keyboardEnabled = true;
        } else if (keydownHandler != null) {
          window.removeEventListener('keydown', keydownHandler, false);
          keydownHandler = null;
          keyboardEnabled = false;
        }
      } catch (err) {
        console.error('[A11yManager] enableKeyboardNavigation failed', err);
        keyboardEnabled = false;
      }
    },

    isKeyboardNavigationEnabled(): boolean {
      return keyboardEnabled;
    },

    get keyMap(): A11yKeyMap {
      return keyMapState;
    },

    setKeyMap(partial: A11yKeyMap): void {
      try {
        if (partial == null || typeof partial !== 'object') {
          return;
        }
        // 在已有映射上合并，支持多次增量覆盖
        keyMapState = mergeKeyMaps(keyMapState, partial);
      } catch (err) {
        console.error('[A11yManager] setKeyMap failed', err);
      }
    },

    setAriaLabel(controlId: string, label: string): void {
      try {
        if (typeof controlId !== 'string' || controlId.length === 0) {
          throw new TypeError('controlId must be non-empty string');
        }
        if (typeof label !== 'string') {
          throw new TypeError('label must be string');
        }
        labels.set(controlId, truncateText(label, 256));
        pushLive(`控件 ${controlId} 标签已更新`);
      } catch (err) {
        console.error('[A11yManager] setAriaLabel failed', err);
      }
    },

    setAriaDescription(controlId: string, description: string): void {
      try {
        if (typeof controlId !== 'string' || controlId.length === 0) {
          throw new TypeError('controlId must be non-empty string');
        }
        if (typeof description !== 'string') {
          throw new TypeError('description must be string');
        }
        descriptions.set(controlId, truncateText(description, 1024));
        pushLive(`控件 ${controlId} 描述已更新`);
      } catch (err) {
        console.error('[A11yManager] setAriaDescription failed', err);
      }
    },

    announceViewChange(message: string): void {
      try {
        if (typeof message !== 'string') {
          return;
        }
        pushLive(`视图：${truncateText(message, 1024)}`);
      } catch (err) {
        console.error('[A11yManager] announceViewChange failed', err);
      }
    },

    announceFeature(feature: Feature): void {
      try {
        if (feature == null || feature.type !== 'Feature') {
          throw new TypeError('announceFeature: expected GeoJSON Feature');
        }
        const summary = summarizeFeature(feature);
        focusRing.push(feature);
        if (focusRing.length > MAX_FOCUS_RING) {
          focusRing.splice(0, focusRing.length - MAX_FOCUS_RING);
        }
        focusIndex = focusRing.length - 1;
        pushLive(summary);
      } catch (err) {
        console.error('[A11yManager] announceFeature failed', err);
      }
    },

    get focusedFeature(): Feature | null {
      if (focusIndex < 0 || focusIndex >= focusRing.length) {
        return null;
      }
      return focusRing[focusIndex] ?? null;
    },

    focusNext(): boolean {
      try {
        return focusNextInternal();
      } catch (err) {
        console.error('[A11yManager] focusNext failed', err);
        return false;
      }
    },

    focusPrevious(): boolean {
      try {
        return focusPreviousInternal();
      } catch (err) {
        console.error('[A11yManager] focusPrevious failed', err);
        return false;
      }
    },

    enableHighContrast(enabled: boolean): void {
      try {
        highContrast = Boolean(enabled);
        if (!hasDom() || !document.documentElement) {
          return;
        }
        if (highContrast) {
          document.documentElement.classList.add(HIGH_CONTRAST_CLASS);
        } else {
          document.documentElement.classList.remove(HIGH_CONTRAST_CLASS);
        }
        pushLive(highContrast ? '已启用高对比' : '已关闭高对比');
      } catch (err) {
        console.error('[A11yManager] enableHighContrast failed', err);
      }
    },

    isHighContrastEnabled(): boolean {
      return highContrast;
    },

    prefersReducedMotion(): boolean {
      try {
        if (!hasWindow()) {
          return false;
        }
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (err) {
        console.error('[A11yManager] prefersReducedMotion failed', err);
        return false;
      }
    },
  };

  return mgr;
}
