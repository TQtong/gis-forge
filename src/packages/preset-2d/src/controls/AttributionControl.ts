// ============================================================
// @gis-forge/preset-2d — AttributionControl 工厂模块
// 提供 createAttributionControl 工厂函数，返回版权归属控件。
// 显示自定义归属文案或默认 '© GIS-Forge'。
// ============================================================

import type { ControlPosition, IControl, Map2D } from '../map-2d.ts';

// ===================== 常量 =====================

/** 默认归属文案。 */
const DEFAULT_ATTRIBUTION = '\u00A9 GIS-Forge';

/** 默认停靠位置。 */
const DEFAULT_POSITION: ControlPosition = 'bottom-right';

/** 常规字号（CSS）。 */
const FONT_SIZE_NORMAL = '11px';

/** 紧凑模式字号（CSS）。 */
const FONT_SIZE_COMPACT = '10px';

// ===================== 选项接口 =====================

/**
 * AttributionControl 工厂选项。
 */
export interface AttributionControlOptions {
    /** 是否使用紧凑模式（减小字号），默认 false。 */
    readonly compact?: boolean;

    /** 自定义归属文案（HTML 或纯文本），默认 '© GIS-Forge'。 */
    readonly customAttribution?: string;

    /** 初始停靠角位置，默认 'bottom-right'。 */
    readonly position?: ControlPosition;
}

// ===================== 返回接口 =====================

/**
 * 增强型归属控件接口。
 */
export interface AttributionControl extends IControl {
    /**
     * 运行时更新归属文案。
     *
     * @param text - 新的归属文案
     */
    setCustomAttribution(text: string): void;

    /**
     * 强制重新渲染控件内容（通常不需要手动调用）。
     */
    render(): void;
}

// ===================== 工厂函数 =====================

/**
 * 创建版权归属控件。
 *
 * @param options - 紧凑模式、自定义文案、位置
 * @returns 增强型 AttributionControl 实例
 *
 * @stability stable
 *
 * @example
 * const attr = createAttributionControl({ customAttribution: '© OpenStreetMap' });
 * map.addControl(attr);
 */
export function createAttributionControl(
    options?: AttributionControlOptions,
): AttributionControl {
    const compact = options?.compact === true;
    let attribution = options?.customAttribution ?? DEFAULT_ATTRIBUTION;
    const currentPosition: ControlPosition = options?.position ?? DEFAULT_POSITION;

    // DOM 引用
    let root: HTMLElement | null = null;

    /**
     * 将当前 attribution 文案写入 root 元素。
     */
    function renderContent(): void {
        if (root === null) {
            return;
        }
        root.textContent = attribution;
    }

    const control: AttributionControl = {
        /**
         * 挂载到地图：构建 DOM。
         *
         * @param _map - Map2D
         * @returns 根 DOM
         */
        onAdd(_map: Map2D): HTMLElement {
            const container = document.createElement('div');
            container.style.maxWidth = '240px';
            container.style.padding = '2px 6px';
            container.style.fontSize = compact ? FONT_SIZE_COMPACT : FONT_SIZE_NORMAL;
            container.style.lineHeight = '1.3';
            container.style.color = 'rgba(0,0,0,0.65)';
            container.style.background = 'rgba(255,255,255,0.75)';
            container.style.borderRadius = '4px';
            container.style.pointerEvents = 'auto';
            container.textContent = attribution;

            root = container;
            return container;
        },

        /**
         * 卸载：移除 DOM。
         *
         * @param _map - Map2D
         */
        onRemove(_map: Map2D): void {
            if (root !== null) {
                root.remove();
                root = null;
            }
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
         * 更新归属文案（立即生效）。
         *
         * @param text - 新的归属文案
         */
        setCustomAttribution(text: string): void {
            attribution = text;
            renderContent();
        },

        /**
         * 强制重新渲染。
         */
        render(): void {
            renderContent();
        },
    };

    return control;
}

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;
