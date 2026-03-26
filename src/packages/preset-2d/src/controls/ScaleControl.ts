// ============================================================
// @gis-forge/preset-2d — ScaleControl 工厂模块
// 提供 createScaleControl 工厂函数，返回增强型比例尺控件。
// 根据视口中心纬度与缩放级别实时计算并渲染比例尺条。
// ============================================================

import type { ControlPosition, IControl, Map2D } from '../map-2d.ts';

// ===================== 常量 =====================

/** WGS84 赤道周长（米），用于 Web 墨卡托比例尺换算。 */
const EARTH_CIRCUMFERENCE_M = 40075017;

/** Web 墨卡托世界像素宽度基数（zoom=0 时的世界宽度像素）。 */
const WORLD_SIZE_PX = 512;

/** 1 英尺 = 0.3048 米。 */
const METERS_PER_FOOT = 0.3048;

/** 1 国际海里 = 1852 米。 */
const METERS_PER_NAUTICAL_MILE = 1852;

/** 1 英里 = 5280 英尺。 */
const FEET_PER_MILE = 5280;

/** 默认比例尺条最大 CSS 像素宽度。 */
const DEFAULT_MAX_WIDTH_PX = 100;

/** 余弦下限阈值，防止极地附近除零。 */
const COS_EPSILON = 1e-6;

/** 比例尺条最小像素宽度。 */
const BAR_MIN_PX = 2;

/** 最小合法地面米数（防零除）。 */
const NICE_METERS_FLOOR = 1e-6;

/** 默认停靠位置。 */
const DEFAULT_POSITION: ControlPosition = 'bottom-left';

// ===================== 单位类型 =====================

/**
 * 比例尺支持的度量单位。
 */
export type ScaleUnit = 'metric' | 'imperial' | 'nautical';

// ===================== 选项接口 =====================

/**
 * ScaleControl 工厂选项。
 */
export interface ScaleControlOptions {
    /** 比例尺条最大宽度（CSS 像素），默认 100。 */
    readonly maxWidth?: number;

    /** 初始度量单位，默认 'metric'。 */
    readonly unit?: ScaleUnit;

    /** 初始停靠角位置，默认 'bottom-left'。 */
    readonly position?: ControlPosition;
}

// ===================== 返回接口 =====================

/**
 * 增强型比例尺控件接口。
 */
export interface ScaleControl extends IControl {
    /**
     * 启用控件显示。
     */
    enable(): void;

    /**
     * 禁用控件（隐藏）。
     */
    disable(): void;

    /**
     * 切换度量单位（metric / imperial / nautical）。
     *
     * @param unit - 目标单位
     */
    setUnit(unit: ScaleUnit): void;
}

// ===================== 纯函数 =====================

/**
 * 根据纬度与缩放估算地面米/像素（Web 墨卡托近似）。
 *
 * @param latDeg - 纬度（度）
 * @param zoom - 缩放级别
 * @returns 每像素对应的地面米数
 *
 * @example
 * metersPerPixel(40, 10); // ≈ 76.4
 */
function metersPerPixel(latDeg: number, zoom: number): number {
    // 纬度→弧度，计算 cos(lat) 以缩放赤道距离到当前纬度
    const latRad = (latDeg * Math.PI) / 180;
    const cosLat = Math.max(Math.cos(latRad), COS_EPSILON);
    // 全球像素总宽 = WORLD_SIZE_PX × 2^zoom
    const scale = WORLD_SIZE_PX * Math.pow(2, zoom);
    return (EARTH_CIRCUMFERENCE_M * cosLat) / scale;
}

/**
 * 将地面长度（米）格式化为用户友好文本。
 *
 * @param meters - 地面长度（米）
 * @param unit - 单位制
 * @returns 格式化后的字符串（含单位后缀）
 *
 * @example
 * formatScaleText(1500, 'metric'); // '1.5 km'
 * formatScaleText(800, 'imperial'); // '2625 ft'
 */
function formatScaleText(meters: number, unit: ScaleUnit): string {
    // 非法输入返回占位符
    if (!Number.isFinite(meters) || meters <= 0) {
        return '\u2014';
    }
    if (unit === 'metric') {
        // 千米阈值
        if (meters >= 1000) {
            return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
        }
        return `${Math.round(meters)} m`;
    }
    if (unit === 'nautical') {
        const nm = meters / METERS_PER_NAUTICAL_MILE;
        return nm >= 1
            ? `${nm.toFixed(nm >= 10 ? 0 : 1)} nm`
            : `${Math.round(meters)} m`;
    }
    // imperial：英尺 / 英里
    const feet = meters / METERS_PER_FOOT;
    if (feet >= FEET_PER_MILE) {
        const mi = feet / FEET_PER_MILE;
        return `${mi.toFixed(mi >= 10 ? 0 : 1)} mi`;
    }
    return `${Math.round(feet)} ft`;
}

/**
 * 选取"漂亮"的标尺长度（米），使条宽接近 maxWidthPx。
 *
 * @param mpp - 每像素地面米数
 * @param maxWidthPx - 最大条宽
 * @returns 整齐的地面长度（米）
 *
 * @example
 * pickNiceMeters(76.4, 100); // 可能返回 5000
 */
function pickNiceMeters(mpp: number, maxWidthPx: number): number {
    if (!Number.isFinite(mpp) || mpp <= 0 || maxWidthPx <= 0) {
        return 1;
    }
    // 当前像素宽对应的地面米数
    const raw = mpp * maxWidthPx;
    // 取数量级
    const exp = Math.floor(Math.log10(raw));
    const pow10 = Math.pow(10, exp);
    // 1/2/5 系列 + 0.25 补充，寻找最接近且不超过 maxWidthPx 的候选
    const candidates = [1, 2, 0.25, 0.5].map((f) => f * pow10);
    let best = candidates[0];
    let bestDiff = 1e99;
    for (const c of candidates) {
        const px = c / mpp;
        const diff = Math.abs(px - maxWidthPx);
        // 允许 5% 超宽容差
        if (diff < bestDiff && px <= maxWidthPx * 1.05) {
            bestDiff = diff;
            best = c;
        }
    }
    return Math.max(best, NICE_METERS_FLOOR);
}

// ===================== 工厂函数 =====================

/**
 * 创建比例尺控件。根据视口中心纬度与缩放级别实时渲染比例尺条与文本。
 *
 * @param options - 最大宽度、单位、位置
 * @returns 增强型 ScaleControl 实例
 *
 * @stability stable
 *
 * @example
 * const scale = createScaleControl({ unit: 'imperial', maxWidth: 120 });
 * map.addControl(scale, 'bottom-right');
 */
export function createScaleControl(
    options?: ScaleControlOptions,
): ScaleControl {
    const maxWidth = options?.maxWidth ?? DEFAULT_MAX_WIDTH_PX;
    let unit: ScaleUnit = options?.unit ?? 'metric';
    let currentPosition: ControlPosition = options?.position ?? DEFAULT_POSITION;

    // DOM 引用
    let root: HTMLElement | null = null;
    let barEl: HTMLDivElement | null = null;
    let labelEl: HTMLSpanElement | null = null;
    let mapRef: Map2D | null = null;
    let unbind: (() => void) | null = null;
    let enabled = true;

    /**
     * 从当前地图状态刷新比例尺条宽度与文本。
     *
     * @param map - Map2D 实例
     */
    function update(map: Map2D): void {
        if (barEl === null || labelEl === null) {
            return;
        }
        let center: [number, number];
        let zoom: number;
        try {
            center = map.getCenter();
            zoom = map.getZoom();
        } catch {
            // 地图可能已销毁
            return;
        }
        const mpp = metersPerPixel(center[1], zoom);
        const meters = pickNiceMeters(mpp, maxWidth);
        // 计算条宽像素并渲染
        const barPx = Math.min(maxWidth, Math.max(BAR_MIN_PX, meters / mpp));
        barEl.style.width = `${barPx}px`;
        labelEl.textContent = formatScaleText(meters, unit);
    }

    /**
     * 绑定地图视图变化事件以实时更新。
     *
     * @param map - Map2D 实例
     */
    function bindEvents(map: Map2D): void {
        const handler = (): void => {
            update(map);
        };
        map.on('move', handler);
        map.on('zoom', handler);
        map.on('resize', handler);
        unbind = (): void => {
            try {
                map.off('move', handler);
                map.off('zoom', handler);
                map.off('resize', handler);
            } catch {
                // 地图已销毁时 off 可能失败
            }
        };
        // 立即刷新一次
        handler();
    }

    const control: ScaleControl = {
        /**
         * 挂载到地图：构建 DOM、绑定事件。
         *
         * @param map - Map2D 实例
         * @returns 根 DOM
         */
        onAdd(map: Map2D): HTMLElement {
            mapRef = map;
            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.alignItems = 'flex-start';
            container.style.gap = '4px';
            container.style.padding = '4px 8px';
            container.style.background = 'rgba(255,255,255,0.85)';
            container.style.border = '1px solid rgba(0,0,0,0.15)';
            container.style.borderRadius = '4px';
            container.style.fontSize = '11px';
            container.style.fontFamily = 'system-ui, sans-serif';

            const label = document.createElement('span');
            label.style.color = '#333';

            const bar = document.createElement('div');
            bar.style.height = '4px';
            bar.style.background = '#333';
            bar.style.borderRadius = '1px';

            container.appendChild(label);
            container.appendChild(bar);

            root = container;
            labelEl = label;
            barEl = bar;

            bindEvents(map);

            return container;
        },

        /**
         * 卸载：解绑事件、移除 DOM。
         *
         * @param _map - Map2D
         */
        onRemove(_map: Map2D): void {
            mapRef = null;
            if (unbind !== null) {
                unbind();
                unbind = null;
            }
            if (root !== null) {
                root.remove();
                root = null;
            }
            barEl = null;
            labelEl = null;
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
         * 启用控件（设为可见）。
         */
        enable(): void {
            enabled = true;
            if (root !== null) {
                root.style.display = 'flex';
            }
            // 重新刷新一次
            if (mapRef !== null) {
                update(mapRef);
            }
        },

        /**
         * 禁用控件（隐藏）。
         */
        disable(): void {
            enabled = false;
            if (root !== null) {
                root.style.display = 'none';
            }
        },

        /**
         * 切换度量单位并立即刷新。
         *
         * @param newUnit - 'metric' | 'imperial' | 'nautical'
         */
        setUnit(newUnit: ScaleUnit): void {
            if (newUnit === 'metric' || newUnit === 'imperial' || newUnit === 'nautical') {
                unit = newUnit;
                if (mapRef !== null) {
                    update(mapRef);
                }
            }
        },
    };

    return control;
}

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;
