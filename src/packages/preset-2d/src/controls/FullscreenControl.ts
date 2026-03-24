// ============================================================
// @geoforge/preset-2d — FullscreenControl 工厂模块
// 提供 createFullscreenControl 工厂函数，请求地图容器或全页
// 进入/退出 Fullscreen API。兼容标准与 webkit 前缀。
// ============================================================

import type { ControlPosition, IControl, Map2D } from '../map-2d.ts';

// ===================== 常量 =====================

/** 按钮最小触控尺寸（CSS 像素）。 */
const BUTTON_MIN_SIZE_PX = 28;

/** 默认停靠位置。 */
const DEFAULT_POSITION: ControlPosition = 'top-right';

/** 进入全屏图标（Unicode 扩展箭头）。 */
const ENTER_ICON = '\u2922';

/** 退出全屏图标（Unicode 收缩箭头）。 */
const EXIT_ICON = '\u2913';

// ===================== 选项接口 =====================

/**
 * FullscreenControl 工厂选项。
 */
export interface FullscreenControlOptions {
    /**
     * 全屏目标：'map' 仅地图容器，'page' 整个页面。
     * 默认 'map'。
     */
    readonly container?: 'map' | 'page';

    /** 初始停靠角位置，默认 'top-right'。 */
    readonly position?: ControlPosition;
}

// ===================== 返回接口 =====================

/**
 * 增强型全屏控件接口。
 */
export interface FullscreenControl extends IControl {
    /**
     * 切换全屏状态：若当前非全屏则进入，反之退出。
     */
    toggle(): void;
}

// ===================== 内部辅助类型（Fullscreen API 兼容） =====================

/**
 * 扩展 Document 类型以支持 webkit 前缀。
 */
interface FullscreenDocument {
    readonly fullscreenElement?: Element | null;
    readonly webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => void;
    exitFullscreen?: () => Promise<void>;
}

/**
 * 扩展 HTMLElement 类型以支持 webkit 前缀。
 */
interface FullscreenElement extends HTMLElement {
    /** webkit 请求全屏。 */
    webkitRequestFullscreen?: () => void;
}

// ===================== 纯函数 =====================

/**
 * 检查指定元素是否处于全屏状态。
 *
 * @param el - 目标元素
 * @returns 是否全屏
 */
function isFullscreen(el: HTMLElement): boolean {
    const d = document as FullscreenDocument;
    const fe = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    return fe === el;
}

/**
 * 请求指定元素进入全屏。
 *
 * @param el - 目标元素
 */
function requestFullscreen(el: HTMLElement): void {
    const fEl = el as FullscreenElement;
    if (typeof fEl.requestFullscreen === 'function') {
        fEl.requestFullscreen().catch(() => {
            // 用户拒绝或浏览器限制，静默
        });
    } else if (typeof fEl.webkitRequestFullscreen === 'function') {
        fEl.webkitRequestFullscreen();
    }
}

/**
 * 退出全屏。
 */
function exitFullscreen(): void {
    const d = document as FullscreenDocument;
    if (typeof d.exitFullscreen === 'function') {
        d.exitFullscreen().catch(() => {
            // 静默
        });
    } else if (typeof d.webkitExitFullscreen === 'function') {
        d.webkitExitFullscreen();
    }
}

// ===================== 工厂函数 =====================

/**
 * 创建全屏控件。点击按钮切换全屏状态。
 *
 * @param options - 目标容器与位置
 * @returns 增强型 FullscreenControl 实例
 *
 * @stability stable
 *
 * @example
 * const fs = createFullscreenControl({ container: 'page' });
 * map.addControl(fs);
 */
export function createFullscreenControl(
    options?: FullscreenControlOptions,
): FullscreenControl {
    const containerMode = options?.container ?? 'map';
    const currentPosition: ControlPosition = options?.position ?? DEFAULT_POSITION;

    // DOM / 地图引用
    let root: HTMLElement | null = null;
    let btn: HTMLButtonElement | null = null;
    let mapRef: Map2D | null = null;
    let fsUnbind: (() => void) | null = null;

    /**
     * 解析全屏目标元素。
     *
     * @param map - Map2D
     * @returns 目标 HTMLElement
     */
    function resolveTarget(map: Map2D): HTMLElement {
        if (containerMode === 'page' && typeof document !== 'undefined') {
            return document.documentElement;
        }
        return map.getContainer();
    }

    /**
     * 同步按钮图标与 aria-label。
     *
     * @param map - Map2D
     */
    function syncLabel(map: Map2D): void {
        if (btn === null) {
            return;
        }
        const el = resolveTarget(map);
        const fs = isFullscreen(el);
        btn.textContent = fs ? EXIT_ICON : ENTER_ICON;
        btn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Enter fullscreen');
    }

    const control: FullscreenControl = {
        /**
         * 挂载到地图：创建按钮并监听 fullscreenchange。
         *
         * @param map - Map2D
         * @returns 根 DOM
         */
        onAdd(map: Map2D): HTMLElement {
            mapRef = map;
            const container = document.createElement('div');

            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-label', 'Enter fullscreen');
            button.textContent = ENTER_ICON;
            button.style.minWidth = `${BUTTON_MIN_SIZE_PX}px`;
            button.style.minHeight = `${BUTTON_MIN_SIZE_PX}px`;
            button.style.margin = '0';
            button.style.padding = '4px 8px';
            button.style.fontSize = '14px';
            button.style.lineHeight = '1';
            button.style.cursor = 'pointer';
            button.style.border = '1px solid rgba(0,0,0,0.2)';
            button.style.borderRadius = '4px';
            button.style.background = 'rgba(255,255,255,0.9)';
            button.style.boxShadow = '0 1px 2px rgba(0,0,0,0.15)';

            button.addEventListener('click', () => {
                control.toggle();
            });

            container.appendChild(button);
            root = container;
            btn = button;

            // 监听 fullscreenchange 以同步按钮状态
            const onFsChange = (): void => {
                syncLabel(map);
            };
            document.addEventListener('fullscreenchange', onFsChange);
            document.addEventListener('webkitfullscreenchange', onFsChange);
            fsUnbind = (): void => {
                document.removeEventListener('fullscreenchange', onFsChange);
                document.removeEventListener('webkitfullscreenchange', onFsChange);
            };

            syncLabel(map);

            return container;
        },

        /**
         * 卸载：解绑事件、移除 DOM。
         *
         * @param _map - Map2D
         */
        onRemove(_map: Map2D): void {
            if (fsUnbind !== null) {
                fsUnbind();
                fsUnbind = null;
            }
            if (root !== null) {
                root.remove();
                root = null;
            }
            btn = null;
            mapRef = null;
        },

        /**
         * 默认停靠位置。
         *
         * @returns ControlPosition
         */
        getDefaultPosition(): ControlPosition {
            return currentPosition;
        },

        /**
         * 切换全屏状态。
         */
        toggle(): void {
            if (mapRef === null) {
                return;
            }
            const el = resolveTarget(mapRef);
            if (isFullscreen(el)) {
                exitFullscreen();
            } else {
                requestFullscreen(el);
            }
        },
    };

    return control;
}

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;
