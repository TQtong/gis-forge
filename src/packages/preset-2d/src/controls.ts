// ============================================================
// @geoforge/preset-2d — 内置 UI 控件（L6 Map2D）
// MVP：纯 DOM + 最小样式，无 WebGPU 依赖。
// ============================================================

import type { ControlPosition, IControl, Map2D } from './map-2d.ts';

// ===================== 常量 =====================

/** WGS84 赤道周长（米），用于 Web 墨卡托比例尺换算。 */
const EARTH_CIRCUMFERENCE_M = 40075017;

/** 与 Map2D 一致的世界像素宽度基数。 */
const WORLD_SIZE_PX = 512;

/** 英尺/米换算。 */
const METERS_PER_FOOT = 0.3048;

/** 海里/米换算（国际海里）。 */
const METERS_PER_NAUTICAL_MILE = 1852;

/** 默认比例尺条最大宽度（CSS 像素）。 */
const DEFAULT_SCALE_MAX_WIDTH_PX = 100;

/** 控件按钮最小触控尺寸参考（CSS 像素）。 */
const CONTROL_BUTTON_MIN_SIZE_PX = 28;

// ===================== 小工具函数 =====================

/**
 * 根据纬度与缩放估算地面米/像素（Web 墨卡托近似）。
 *
 * @param latDeg - 纬度（度）
 * @param zoom - 缩放级别
 * @returns 米/像素
 *
 * @example
 * const mpp = metersPerPixel(40, 10);
 */
function metersPerPixel(latDeg: number, zoom: number): number {
    const latRad = (latDeg * Math.PI) / 180;
    const cosLat = Math.max(Math.cos(latRad), 1e-6);
    const scale = WORLD_SIZE_PX * Math.pow(2, zoom);
    return (EARTH_CIRCUMFERENCE_M * cosLat) / scale;
}

/**
 * 将米制长度格式化为易读字符串（含单位）。
 *
 * @param meters - 长度（米）
 * @param unit - 单位制
 * @returns 展示文本
 */
function formatScaleText(
    meters: number,
    unit: 'metric' | 'imperial' | 'nautical',
): string {
    if (!Number.isFinite(meters) || meters <= 0) {
        return '—';
    }
    if (unit === 'metric') {
        if (meters >= 1000) {
            return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
        }
        return `${Math.round(meters)} m`;
    }
    if (unit === 'nautical') {
        const nm = meters / METERS_PER_NAUTICAL_MILE;
        return nm >= 1 ? `${nm.toFixed(nm >= 10 ? 0 : 1)} nm` : `${Math.round(meters)} m`;
    }
    const feet = meters / METERS_PER_FOOT;
    if (feet >= 5280) {
        const mi = feet / 5280;
        return `${mi.toFixed(mi >= 10 ? 0 : 1)} mi`;
    }
    return `${Math.round(feet)} ft`;
}

/**
 * 选取“漂亮”的标尺长度（米），使 bar 接近 maxWidthPx 像素宽。
 *
 * @param mpp - 米/像素
 * @param maxWidthPx - 最大条宽
 * @returns 地面长度（米）
 */
function pickNiceScaleMeters(mpp: number, maxWidthPx: number): number {
    if (!Number.isFinite(mpp) || mpp <= 0 || maxWidthPx <= 0) {
        return 1;
    }
    const raw = mpp * maxWidthPx;
    const exp = Math.floor(Math.log10(raw));
    const pow10 = Math.pow(10, exp);
    const candidates = [1, 2, 0.25, 0.5].map((f) => f * pow10);
    let best = candidates[0];
    let bestDiff = 1e99;
    for (const c of candidates) {
        const px = c / mpp;
        const d = Math.abs(px - maxWidthPx);
        if (d < bestDiff && px <= maxWidthPx * 1.05) {
            bestDiff = d;
            best = c;
        }
    }
    return Math.max(best, 1e-6);
}

/**
 * 创建统一样式的按钮元素。
 *
 * @param label - 可访问名称
 * @param text - 显示文本
 * @returns button 元素
 */
function createControlButton(label: string, text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.textContent = text;
    b.style.minWidth = `${CONTROL_BUTTON_MIN_SIZE_PX}px`;
    b.style.minHeight = `${CONTROL_BUTTON_MIN_SIZE_PX}px`;
    b.style.margin = '0';
    b.style.padding = '4px 8px';
    b.style.fontSize = '14px';
    b.style.lineHeight = '1';
    b.style.cursor = 'pointer';
    b.style.border = '1px solid rgba(0,0,0,0.2)';
    b.style.borderRadius = '4px';
    b.style.background = 'rgba(255,255,255,0.9)';
    b.style.boxShadow = '0 1px 2px rgba(0,0,0,0.15)';
    return b;
}

// ===================== NavigationControl =====================

/**
 * NavigationControl 构造选项。
 */
export interface NavigationControlOptions {
    /** 是否显示指北/复位方位控件，默认 true。 */
    showCompass?: boolean;
    /** 是否显示缩放 +/- 按钮，默认 true。 */
    showZoom?: boolean;
}

/**
 * 缩放与指北控件：提供 +/- 与可选 Compass（MVP 为文本按钮）。
 */
export class NavigationControl implements IControl {
    /** 是否显示 Compass。 */
    private readonly _showCompass: boolean;

    /** 是否显示 Zoom。 */
    private readonly _showZoom: boolean;

    /** 根容器，用于 onRemove 时释放。 */
    private _root: HTMLElement | null = null;

    /**
     * @param options - 显示开关
     *
     * @example
     * map.addControl(new NavigationControl({ showCompass: false }));
     */
    constructor(options?: NavigationControlOptions) {
        this._showCompass = options?.showCompass !== false;
        this._showZoom = options?.showZoom !== false;
    }

    /**
     * 将控件挂载到地图容器。
     *
     * @param map - Map2D 实例
     * @returns 根 DOM
     */
    public onAdd(map: Map2D): HTMLElement {
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.gap = '4px';
        this._root = root;
        if (this._showZoom) {
            const zoomIn = createControlButton('Zoom in', '+');
            const zoomOut = createControlButton('Zoom out', '−');
            zoomIn.addEventListener('click', () => {
                try {
                    const z = map.getZoom();
                    map.setZoom(z + 1, { duration: 0 });
                } catch {
                    // 地图已销毁时静默忽略
                }
            });
            zoomOut.addEventListener('click', () => {
                try {
                    const z = map.getZoom();
                    map.setZoom(z - 1, { duration: 0 });
                } catch {
                    // 地图已销毁时静默忽略
                }
            });
            root.appendChild(zoomIn);
            root.appendChild(zoomOut);
        }
        if (this._showCompass) {
            const compass = createControlButton('Reset bearing', 'N');
            compass.addEventListener('click', () => {
                try {
                    map.jumpTo({ bearing: 0, pitch: 0 });
                } catch {
                    // 地图已销毁时静默忽略
                }
            });
            root.appendChild(compass);
        }
        return root;
    }

    /**
     * 从地图移除控件。
     *
     * @param _map - Map2D 实例
     */
    public onRemove(_map: Map2D): void {
        if (this._root !== null) {
            this._root.remove();
            this._root = null;
        }
    }

    /**
     * 默认停靠位置。
     *
     * @returns 右上角
     */
    public getDefaultPosition(): ControlPosition {
        return 'top-right';
    }
}

// ===================== ScaleControl =====================

/**
 * ScaleControl 构造选项。
 */
export interface ScaleControlOptions {
    /** 比例尺条最大宽度（CSS 像素）。 */
    maxWidth?: number;
    /** 度量单位。 */
    unit?: 'metric' | 'imperial' | 'nautical';
}

/**
 * 比例尺控件：根据当前 zoom 与纬度显示刻度。
 */
export class ScaleControl implements IControl {
    /** 最大条宽。 */
    private readonly _maxWidth: number;

    /** 当前单位。 */
    private _unit: 'metric' | 'imperial' | 'nautical';

    /** 根容器。 */
    private _root: HTMLElement | null = null;

    /** 填充条元素。 */
    private _bar: HTMLDivElement | null = null;

    /** 文本标签。 */
    private _label: HTMLSpanElement | null = null;

    /** 地图事件解绑函数。 */
    private _unbind: (() => void) | null = null;

    /** 当前地图引用（用于 setUnit 后刷新）。 */
    private _map: Map2D | null = null;

    /**
     * @param options - 显示选项
     *
     * @example
     * map.addControl(new ScaleControl({ unit: 'imperial' }));
     */
    constructor(options?: ScaleControlOptions) {
        this._maxWidth = options?.maxWidth ?? DEFAULT_SCALE_MAX_WIDTH_PX;
        this._unit = options?.unit ?? 'metric';
    }

    /**
     * 刷新比例尺展示。
     *
     * @param map - 地图实例
     */
    private _update(map: Map2D): void {
        if (this._bar === null || this._label === null || this._root === null) {
            return;
        }
        let center: [number, number];
        let zoom: number;
        try {
            center = map.getCenter();
            zoom = map.getZoom();
        } catch {
            return;
        }
        const mpp = metersPerPixel(center[1], zoom);
        const meters = pickNiceScaleMeters(mpp, this._maxWidth);
        const barPx = Math.min(this._maxWidth, Math.max(2, meters / mpp));
        this._bar.style.width = `${barPx}px`;
        this._label.textContent = formatScaleText(meters, this._unit);
    }

    /**
     * 绑定地图视图更新事件。
     *
     * @param map - Map2D
     */
    private _bindMapEvents(map: Map2D): void {
        const handler = (): void => {
            this._update(map);
        };
        map.on('move', handler);
        map.on('zoom', handler);
        map.on('resize', handler);
        this._unbind = (): void => {
            try {
                map.off('move', handler);
                map.off('zoom', handler);
                map.off('resize', handler);
            } catch {
                // 地图已销毁时 off 可能失败，忽略
            }
        };
        handler();
    }

    /**
     * @param map - Map2D 实例
     * @returns 根 DOM
     */
    public onAdd(map: Map2D): HTMLElement {
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.alignItems = 'flex-start';
        root.style.gap = '4px';
        root.style.padding = '4px 8px';
        root.style.background = 'rgba(255,255,255,0.85)';
        root.style.border = '1px solid rgba(0,0,0,0.15)';
        root.style.borderRadius = '4px';
        root.style.fontSize = '11px';
        root.style.fontFamily = 'system-ui, sans-serif';
        const label = document.createElement('span');
        label.style.color = '#333';
        const bar = document.createElement('div');
        bar.style.height = '4px';
        bar.style.background = '#333';
        bar.style.borderRadius = '1px';
        root.appendChild(label);
        root.appendChild(bar);
        this._root = root;
        this._label = label;
        this._bar = bar;
        this._map = map;
        this._bindMapEvents(map);
        return root;
    }

    /**
     * @param _map - Map2D 实例
     */
    public onRemove(_map: Map2D): void {
        this._map = null;
        if (this._unbind !== null) {
            this._unbind();
            this._unbind = null;
        }
        if (this._root !== null) {
            this._root.remove();
            this._root = null;
        }
        this._bar = null;
        this._label = null;
    }

    /**
     * 切换显示单位（metric / imperial / nautical）。
     *
     * @param unit - 单位制字符串
     */
    public setUnit(unit: string): void {
        if (unit === 'metric' || unit === 'imperial' || unit === 'nautical') {
            this._unit = unit;
            if (this._map !== null) {
                this._update(this._map);
            }
        }
    }

    /**
     * @returns 左下角
     */
    public getDefaultPosition(): ControlPosition {
        return 'bottom-left';
    }
}

// ===================== AttributionControl =====================

/**
 * AttributionControl 构造选项。
 */
export interface AttributionControlOptions {
    /** 是否使用紧凑模式（MVP 仅影响字体大小）。 */
    compact?: boolean;
    /** 自定义 HTML 或纯文本归属信息。 */
    customAttribution?: string;
}

/**
 * 版权/归属信息控件。
 */
export class AttributionControl implements IControl {
    /** 是否紧凑。 */
    private readonly _compact: boolean;

    /** 自定义文案。 */
    private readonly _custom: string | undefined;

    /** 根元素引用。 */
    private _root: HTMLElement | null = null;

    /**
     * @param options - 显示选项
     *
     * @example
     * map.addControl(new AttributionControl({ customAttribution: '© OpenStreetMap' }));
     */
    constructor(options?: AttributionControlOptions) {
        this._compact = options?.compact === true;
        this._custom = options?.customAttribution;
    }

    /**
     * @param _map - Map2D 实例
     * @returns 根 DOM
     */
    public onAdd(_map: Map2D): HTMLElement {
        const root = document.createElement('div');
        root.style.maxWidth = '240px';
        root.style.padding = '2px 6px';
        root.style.fontSize = this._compact ? '10px' : '11px';
        root.style.lineHeight = '1.3';
        root.style.color = 'rgba(0,0,0,0.65)';
        root.style.background = 'rgba(255,255,255,0.75)';
        root.style.borderRadius = '4px';
        root.style.pointerEvents = 'auto';
        const text = this._custom ?? '© GeoForge';
        root.textContent = text;
        this._root = root;
        return root;
    }

    /**
     * @param _map - Map2D 实例
     */
    public onRemove(_map: Map2D): void {
        if (this._root !== null) {
            this._root.remove();
            this._root = null;
        }
    }

    /**
     * @returns 右下角
     */
    public getDefaultPosition(): ControlPosition {
        return 'bottom-right';
    }
}

// ===================== GeolocateControl =====================

/**
 * GeolocateControl 构造选项。
 */
export interface GeolocateControlOptions {
    /** 是否高精确度定位。 */
    enableHighAccuracy?: boolean;
    /** 定位超时（毫秒）。 */
    timeoutMs?: number;
    /** 最大缓存时间（毫秒）。 */
    maximumAgeMs?: number;
}

/**
 * 定位控件：使用浏览器 Geolocation API 将地图飞到当前位置。
 */
export class GeolocateControl implements IControl {
    /** 是否高精度。 */
    private readonly _highAccuracy: boolean;

    /** 超时。 */
    private readonly _timeoutMs: number;

    /** 缓存最大年龄。 */
    private readonly _maximumAgeMs: number;

    /** 根容器。 */
    private _root: HTMLElement | null = null;

    /** 触发按钮。 */
    private _button: HTMLButtonElement | null = null;

    /** 当前地图引用。 */
    private _map: Map2D | null = null;

    /**
     * @param options - Geolocation 选项
     */
    constructor(options?: GeolocateControlOptions) {
        this._highAccuracy = options?.enableHighAccuracy === true;
        this._timeoutMs = options?.timeoutMs ?? 10000;
        this._maximumAgeMs = options?.maximumAgeMs ?? 0;
    }

    /**
     * 执行定位并跳转地图。
     *
     * @param map - Map2D
     */
    private _locate(map: Map2D): void {
        if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lng = pos.coords.longitude;
                const lat = pos.coords.latitude;
                const accuracy = pos.coords.accuracy;
                try {
                    map.flyTo({
                        center: [lng, lat],
                        zoom: accuracy < 100 ? 16 : 14,
                        duration: 1200,
                    });
                } catch {
                    // 地图已销毁
                }
            },
            () => {
                // 用户拒绝或硬件错误：静默（MVP 无 UI）
            },
            {
                enableHighAccuracy: this._highAccuracy,
                timeout: this._timeoutMs,
                maximumAge: this._maximumAgeMs,
            },
        );
    }

    /**
     * @param map - Map2D 实例
     * @returns 根 DOM
     */
    public onAdd(map: Map2D): HTMLElement {
        this._map = map;
        const root = document.createElement('div');
        const btn = createControlButton('Find my location', '⌖');
        btn.addEventListener('click', () => {
            if (this._map !== null) {
                this.trigger();
            }
        });
        root.appendChild(btn);
        this._root = root;
        this._button = btn;
        return root;
    }

    /**
     * @param _map - Map2D 实例
     */
    public onRemove(_map: Map2D): void {
        if (this._root !== null) {
            this._root.remove();
            this._root = null;
        }
        this._button = null;
        this._map = null;
    }

    /**
     * 以编程方式触发定位；若不可用则返回 false。
     *
     * @returns 是否成功发起定位请求
     */
    public trigger(): boolean {
        if (this._map === null) {
            return false;
        }
        if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
            return false;
        }
        this._locate(this._map);
        return true;
    }

    /**
     * @returns 右上角
     */
    public getDefaultPosition(): ControlPosition {
        return 'top-right';
    }
}

// ===================== FullscreenControl =====================

/**
 * FullscreenControl 构造选项。
 */
export interface FullscreenControlOptions {
    /** 若设为 true，则对整个 `document.documentElement` 全屏，否则对地图容器。 */
    container?: 'map' | 'page';
}

/**
 * 全屏控件：请求地图容器或全页进入 Fullscreen API。
 */
export class FullscreenControl implements IControl {
    /** 全屏目标模式。 */
    private readonly _container: 'map' | 'page';

    /** 根容器。 */
    private _root: HTMLElement | null = null;

    /** 地图引用（用于解析容器）。 */
    private _map: Map2D | null = null;

    /** 按钮引用。 */
    private _button: HTMLButtonElement | null = null;

    /** 全屏变化监理解绑。 */
    private _fsUnbind: (() => void) | null = null;

    /**
     * @param options - 目标容器
     */
    constructor(options?: FullscreenControlOptions) {
        this._container = options?.container ?? 'map';
    }

    /**
     * 解析全屏目标元素。
     *
     * @param map - Map2D
     * @returns HTMLElement
     */
    private _resolveTarget(map: Map2D): HTMLElement {
        if (this._container === 'page' && typeof document !== 'undefined') {
            return document.documentElement;
        }
        return map.getContainer();
    }

    /**
     * 是否处于全屏状态（含标准与 webkit 前缀）。
     *
     * @param el - 目标元素
     * @returns 是否全屏
     */
    private _isFullscreen(el: HTMLElement): boolean {
        const d = document as Document & {
            fullscreenElement?: Element | null;
            webkitFullscreenElement?: Element | null;
        };
        const fe = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
        return fe === el;
    }

    /**
     * 请求进入全屏。
     *
     * @param el - 目标元素
     */
    private _requestFullscreen(el: HTMLElement): void {
        const anyEl = el as HTMLElement & {
            requestFullscreen?: () => Promise<void>;
            webkitRequestFullscreen?: () => void;
        };
        if (typeof anyEl.requestFullscreen === 'function') {
            anyEl.requestFullscreen().catch(() => {
                // 用户拒绝或浏览器限制
            });
        } else if (typeof anyEl.webkitRequestFullscreen === 'function') {
            anyEl.webkitRequestFullscreen();
        }
    }

    /**
     * 退出全屏。
     */
    private _exitFullscreen(): void {
        const d = document as Document & {
            exitFullscreen?: () => Promise<void>;
            webkitExitFullscreen?: () => void;
        };
        if (typeof d.exitFullscreen === 'function') {
            d.exitFullscreen().catch(() => {
                // 忽略
            });
        } else if (typeof d.webkitExitFullscreen === 'function') {
            d.webkitExitFullscreen();
        }
    }

    /**
     * 同步按钮文案。
     *
     * @param map - Map2D
     */
    private _syncLabel(map: Map2D): void {
        if (this._button === null) {
            return;
        }
        const el = this._resolveTarget(map);
        this._button.textContent = this._isFullscreen(el) ? '⤓' : '⤢';
        this._button.setAttribute(
            'aria-label',
            this._isFullscreen(el) ? 'Exit fullscreen' : 'Enter fullscreen',
        );
    }

    /**
     * @param map - Map2D 实例
     * @returns 根 DOM
     */
    public onAdd(map: Map2D): HTMLElement {
        this._map = map;
        const root = document.createElement('div');
        const btn = createControlButton('Enter fullscreen', '⤢');
        btn.addEventListener('click', () => {
            if (this._map === null) {
                return;
            }
            const el = this._resolveTarget(this._map);
            if (this._isFullscreen(el)) {
                this._exitFullscreen();
            } else {
                this._requestFullscreen(el);
            }
        });
        root.appendChild(btn);
        this._root = root;
        this._button = btn;
        const onFs = (): void => {
            this._syncLabel(map);
        };
        document.addEventListener('fullscreenchange', onFs);
        document.addEventListener('webkitfullscreenchange', onFs);
        this._fsUnbind = (): void => {
            document.removeEventListener('fullscreenchange', onFs);
            document.removeEventListener('webkitfullscreenchange', onFs);
        };
        this._syncLabel(map);
        return root;
    }

    /**
     * @param _map - Map2D 实例
     */
    public onRemove(_map: Map2D): void {
        if (this._fsUnbind !== null) {
            this._fsUnbind();
            this._fsUnbind = null;
        }
        if (this._root !== null) {
            this._root.remove();
            this._root = null;
        }
        this._button = null;
        this._map = null;
    }

    /**
     * @returns 右上角
     */
    public getDefaultPosition(): ControlPosition {
        return 'top-right';
    }
}
