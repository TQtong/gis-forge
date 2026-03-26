// ============================================================
// @gis-forge/preset-2d — GeolocateControl 工厂模块
// 提供 createGeolocateControl 工厂函数，使用浏览器 Geolocation API
// 获取用户位置并飞行到该位置。支持一次性定位与持续跟踪模式。
// ============================================================

import type { ControlPosition, IControl, Map2D } from '../map-2d.ts';

// ===================== 常量 =====================

/** 按钮最小触控尺寸（CSS 像素）。 */
const BUTTON_MIN_SIZE_PX = 28;

/** 默认定位超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 10000;

/** 默认位置缓存最大年龄（毫秒），0 表示不缓存。 */
const DEFAULT_MAX_AGE_MS = 0;

/** 高精度定位成功时的默认缩放级别（街道级别）。 */
const HIGH_ACCURACY_ZOOM = 16;

/** 低精度定位的默认缩放级别（城市级别）。 */
const LOW_ACCURACY_ZOOM = 14;

/** 精度阈值（米），低于此值视为高精度。 */
const ACCURACY_THRESHOLD_M = 100;

/** 飞行动画时长（毫秒）。 */
const FLY_DURATION_MS = 1200;

/** 默认停靠位置。 */
const DEFAULT_POSITION: ControlPosition = 'top-right';

/** 定位图标文本（十字准星 Unicode）。 */
const GEOLOCATE_ICON = '\u2316';

// ===================== 选项接口 =====================

/**
 * GeolocateControl 工厂选项。
 */
export interface GeolocateControlOptions {
    /** 是否请求高精度定位（GPS），默认 false。 */
    readonly enableHighAccuracy?: boolean;

    /** 定位超时（毫秒），默认 10000。 */
    readonly timeoutMs?: number;

    /** 位置缓存最大年龄（毫秒），默认 0。 */
    readonly maximumAgeMs?: number;

    /** 是否启用持续跟踪模式，默认 false。 */
    readonly trackUserLocation?: boolean;

    /** 初始停靠角位置，默认 'top-right'。 */
    readonly position?: ControlPosition;
}

// ===================== 返回接口 =====================

/**
 * 增强型定位控件接口。
 */
export interface GeolocateControl extends IControl {
    /**
     * 手动触发一次定位；成功后飞到用户位置。
     *
     * @returns 是否成功发起定位请求（false 表示 API 不可用或控件未挂载）
     */
    trigger(): boolean;

    /**
     * 切换持续跟踪模式。
     *
     * @param track - 是否跟踪
     */
    trackUserLocation(track: boolean): void;
}

// ===================== 工厂函数 =====================

/**
 * 创建定位控件。使用浏览器 Geolocation API 获取位置并跳转地图。
 *
 * @param options - 精度、超时、跟踪模式
 * @returns 增强型 GeolocateControl 实例
 *
 * @stability stable
 *
 * @example
 * const geo = createGeolocateControl({ enableHighAccuracy: true });
 * map.addControl(geo);
 */
export function createGeolocateControl(
    options?: GeolocateControlOptions,
): GeolocateControl {
    const highAccuracy = options?.enableHighAccuracy === true;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAge = options?.maximumAgeMs ?? DEFAULT_MAX_AGE_MS;
    let tracking = options?.trackUserLocation === true;
    const currentPosition: ControlPosition = options?.position ?? DEFAULT_POSITION;

    // DOM / 地图引用
    let root: HTMLElement | null = null;
    let mapRef: Map2D | null = null;
    /** watchPosition 返回的 ID；null 表示未跟踪。 */
    let watchId: number | null = null;

    /**
     * 检测 Geolocation API 是否可用。
     *
     * @returns 是否可用
     */
    function isGeolocationAvailable(): boolean {
        return typeof navigator !== 'undefined' && navigator.geolocation !== undefined;
    }

    /**
     * 将地图飞到指定经纬度，缩放级别根据精度自适应。
     *
     * @param map - Map2D
     * @param lng - 经度
     * @param lat - 纬度
     * @param accuracy - 精度（米）
     */
    function flyToPosition(map: Map2D, lng: number, lat: number, accuracy: number): void {
        try {
            const zoom = accuracy < ACCURACY_THRESHOLD_M ? HIGH_ACCURACY_ZOOM : LOW_ACCURACY_ZOOM;
            map.flyTo({
                center: [lng, lat],
                zoom,
                duration: FLY_DURATION_MS,
            });
        } catch {
            // 地图已销毁
        }
    }

    /**
     * 执行一次性定位。
     *
     * @param map - Map2D
     */
    function locateOnce(map: Map2D): void {
        if (!isGeolocationAvailable()) {
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                flyToPosition(map, pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy);
            },
            () => {
                // 用户拒绝或硬件错误：静默（MVP 无 UI 错误提示）
            },
            {
                enableHighAccuracy: highAccuracy,
                timeout: timeoutMs,
                maximumAge: maxAge,
            },
        );
    }

    /**
     * 启动持续跟踪。
     *
     * @param map - Map2D
     */
    function startTracking(map: Map2D): void {
        if (!isGeolocationAvailable()) {
            return;
        }
        // 先清理旧 watch
        stopTracking();
        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                flyToPosition(map, pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy);
            },
            () => {
                // 定位失败：静默
            },
            {
                enableHighAccuracy: highAccuracy,
                timeout: timeoutMs,
                maximumAge: maxAge,
            },
        );
    }

    /**
     * 停止持续跟踪。
     */
    function stopTracking(): void {
        if (watchId !== null && isGeolocationAvailable()) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    }

    const control: GeolocateControl = {
        /**
         * 挂载到地图：创建定位按钮。
         *
         * @param map - Map2D
         * @returns 根 DOM
         */
        onAdd(map: Map2D): HTMLElement {
            mapRef = map;
            const container = document.createElement('div');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Find my location');
            btn.textContent = GEOLOCATE_ICON;
            btn.style.minWidth = `${BUTTON_MIN_SIZE_PX}px`;
            btn.style.minHeight = `${BUTTON_MIN_SIZE_PX}px`;
            btn.style.margin = '0';
            btn.style.padding = '4px 8px';
            btn.style.fontSize = '14px';
            btn.style.lineHeight = '1';
            btn.style.cursor = 'pointer';
            btn.style.border = '1px solid rgba(0,0,0,0.2)';
            btn.style.borderRadius = '4px';
            btn.style.background = 'rgba(255,255,255,0.9)';
            btn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.15)';

            btn.addEventListener('click', () => {
                if (mapRef !== null) {
                    control.trigger();
                }
            });

            container.appendChild(btn);
            root = container;

            // 若选项指定了跟踪模式，立即启动
            if (tracking) {
                startTracking(map);
            }

            return container;
        },

        /**
         * 卸载：停止跟踪、移除 DOM。
         *
         * @param _map - Map2D
         */
        onRemove(_map: Map2D): void {
            stopTracking();
            if (root !== null) {
                root.remove();
                root = null;
            }
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
         * 手动触发一次定位。
         *
         * @returns 是否成功发起请求
         */
        trigger(): boolean {
            if (mapRef === null) {
                return false;
            }
            if (!isGeolocationAvailable()) {
                return false;
            }
            locateOnce(mapRef);
            return true;
        },

        /**
         * 切换持续跟踪模式。
         *
         * @param track - true 启动 / false 停止
         */
        trackUserLocation(track: boolean): void {
            tracking = track;
            if (track && mapRef !== null) {
                startTracking(mapRef);
            } else {
                stopTracking();
            }
        },
    };

    return control;
}

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;
