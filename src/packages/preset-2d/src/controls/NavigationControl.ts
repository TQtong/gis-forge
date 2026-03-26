// ============================================================
// @gis-forge/preset-2d — NavigationControl 工厂模块
// 提供 createNavigationControl 工厂函数，返回增强型导航控件实例。
// 在 IControl 协议基础上补充 enable/disable/setPosition 便捷方法。
// ============================================================

import type { ControlPosition, IControl, Map2D } from '../map-2d.ts';

// ===================== 常量 =====================

/** 控件按钮最小触控尺寸（CSS 像素），确保可访问性。 */
const BUTTON_MIN_SIZE_PX = 28;

/** 按钮间距（CSS 像素）。 */
const BUTTON_GAP_PX = 4;

/** 按钮内边距。 */
const BUTTON_PADDING = '4px 8px';

/** 按钮字号。 */
const BUTTON_FONT_SIZE = '14px';

/** 默认停靠位置。 */
const DEFAULT_POSITION: ControlPosition = 'top-right';

// ===================== 选项接口 =====================

/**
 * NavigationControl 工厂选项。
 */
export interface NavigationControlOptions {
    /** 是否显示指北 Compass 按钮，默认 true。 */
    readonly showCompass?: boolean;

    /** 是否显示缩放 +/- 按钮，默认 true。 */
    readonly showZoom?: boolean;

    /** 初始停靠角位置，默认 'top-right'。 */
    readonly position?: ControlPosition;
}

// ===================== 返回接口 =====================

/**
 * 增强型导航控件接口：IControl + 便捷方法。
 */
export interface NavigationControl extends IControl {
    /**
     * 启用控件交互（按钮可点击）。
     */
    enable(): void;

    /**
     * 禁用控件交互（按钮不可点击、视觉半透明）。
     */
    disable(): void;

    /**
     * 运行时更改停靠位置（需在已挂载后调用）。
     *
     * @param position - 新的四角位置
     */
    setPosition(position: ControlPosition): void;

    /**
     * 控件挂载回调，由 Map2D.addControl 调用。
     *
     * @param map - 宿主 Map2D 实例
     * @returns 根 DOM 元素
     */
    onAdd(map: Map2D): HTMLElement;

    /**
     * 控件卸载回调，由 Map2D.removeControl 调用。
     *
     * @param map - 宿主 Map2D 实例
     */
    onRemove(map: Map2D): void;
}

// ===================== 内部工具函数 =====================

/**
 * 创建统一样式的按钮元素（圆角、阴影、最小尺寸）。
 *
 * @param label - 无障碍 aria-label 文案
 * @param text - 按钮显示文本
 * @returns HTMLButtonElement
 *
 * @example
 * const btn = createButton('Zoom in', '+');
 */
function createButton(label: string, text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.textContent = text;
    // 最小尺寸保障移动端可触控
    b.style.minWidth = `${BUTTON_MIN_SIZE_PX}px`;
    b.style.minHeight = `${BUTTON_MIN_SIZE_PX}px`;
    b.style.margin = '0';
    b.style.padding = BUTTON_PADDING;
    b.style.fontSize = BUTTON_FONT_SIZE;
    b.style.lineHeight = '1';
    b.style.cursor = 'pointer';
    b.style.border = '1px solid rgba(0,0,0,0.2)';
    b.style.borderRadius = '4px';
    b.style.background = 'rgba(255,255,255,0.9)';
    b.style.boxShadow = '0 1px 2px rgba(0,0,0,0.15)';
    return b;
}

// ===================== 工厂函数 =====================

/**
 * 创建导航控件（缩放 +/- 与可选 Compass）。
 *
 * @param options - 显示开关与初始位置
 * @returns 增强型 NavigationControl 实例
 *
 * @stability stable
 *
 * @example
 * const nav = createNavigationControl({ showCompass: false });
 * map.addControl(nav, 'top-left');
 */
export function createNavigationControl(
    options?: NavigationControlOptions,
): NavigationControl {
    // 解构选项，赋默认值
    const showCompass = options?.showCompass !== false;
    const showZoom = options?.showZoom !== false;
    let currentPosition: ControlPosition = options?.position ?? DEFAULT_POSITION;

    // 内部状态
    let enabled = true;
    let root: HTMLElement | null = null;
    let mapRef: Map2D | null = null;
    /** 所有按钮引用，用于 enable/disable 批量切换 */
    const buttons: HTMLButtonElement[] = [];

    /**
     * 将所有按钮设置为启用/禁用态。
     *
     * @param state - 是否启用
     */
    function applyEnabledState(state: boolean): void {
        for (const btn of buttons) {
            btn.disabled = !state;
            // 禁用时降低透明度提示不可交互
            btn.style.opacity = state ? '1' : '0.4';
            btn.style.cursor = state ? 'pointer' : 'default';
        }
    }

    // 构建控件对象，满足 NavigationControl & IControl 接口
    const control: NavigationControl = {
        /**
         * 挂载到地图容器：创建 DOM 树并绑定事件。
         *
         * @param map - Map2D
         * @returns 根 DOM
         */
        onAdd(map: Map2D): HTMLElement {
            mapRef = map;
            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = `${BUTTON_GAP_PX}px`;
            root = container;

            if (showZoom) {
                // 放大按钮
                const zoomIn = createButton('Zoom in', '+');
                zoomIn.addEventListener('click', () => {
                    if (!enabled || mapRef === null) {
                        return;
                    }
                    try {
                        const z = mapRef.getZoom();
                        mapRef.setZoom(z + 1, { duration: 0 });
                    } catch {
                        // 地图已销毁时静默忽略
                    }
                });
                buttons.push(zoomIn);
                container.appendChild(zoomIn);

                // 缩小按钮
                const zoomOut = createButton('Zoom out', '\u2212');
                zoomOut.addEventListener('click', () => {
                    if (!enabled || mapRef === null) {
                        return;
                    }
                    try {
                        const z = mapRef.getZoom();
                        mapRef.setZoom(z - 1, { duration: 0 });
                    } catch {
                        // 地图已销毁时静默忽略
                    }
                });
                buttons.push(zoomOut);
                container.appendChild(zoomOut);
            }

            if (showCompass) {
                // 指北复位按钮：点击后重置 bearing/pitch 为 0
                const compass = createButton('Reset bearing', 'N');
                compass.addEventListener('click', () => {
                    if (!enabled || mapRef === null) {
                        return;
                    }
                    try {
                        mapRef.jumpTo({ bearing: 0, pitch: 0 });
                    } catch {
                        // 地图已销毁时静默忽略
                    }
                });
                buttons.push(compass);
                container.appendChild(compass);
            }

            // 首次挂载时同步 enable 状态
            applyEnabledState(enabled);

            return container;
        },

        /**
         * 卸载：移除 DOM、清理引用。
         *
         * @param _map - Map2D
         */
        onRemove(_map: Map2D): void {
            if (root !== null) {
                root.remove();
                root = null;
            }
            buttons.length = 0;
            mapRef = null;
        },

        /**
         * 默认停靠角位置。
         *
         * @returns ControlPosition
         */
        getDefaultPosition(): ControlPosition {
            return currentPosition;
        },

        /**
         * 启用控件交互。
         */
        enable(): void {
            enabled = true;
            applyEnabledState(true);
        },

        /**
         * 禁用控件交互。
         */
        disable(): void {
            enabled = false;
            applyEnabledState(false);
        },

        /**
         * 运行时更改停靠位置。
         * 若控件已挂载到地图，需先 removeControl 再 addControl 才能生效。
         *
         * @param position - 新的四角位置
         */
        setPosition(position: ControlPosition): void {
            currentPosition = position;
            // 若已挂载，重新挂载到新位置
            if (mapRef !== null && root !== null) {
                try {
                    mapRef.removeControl(control);
                    mapRef.addControl(control, currentPosition);
                } catch {
                    // 地图已销毁或控件已移除时静默忽略
                }
            }
        },
    };

    return control;
}

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;
