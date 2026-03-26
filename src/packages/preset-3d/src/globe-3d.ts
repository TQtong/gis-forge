/**
 * @module preset-3d/globe-3d
 * @description
 * **Globe3D**（L6 预设）：在浏览器中挂载全屏 Canvas，初始化 WebGPU，驱动 {@link Camera3D}、
 * 瓦片调度与渲染（`globe-render` / `globe-tiles`）、天穹与大气（`globe-shaders` / `globe-atmosphere`）。
 *
 * 实现已拆分为同目录 `globe-*.ts` 子模块；本文件保留类与对外 API，**子模块禁止反向 import 本文件**。
 *
 * @stability experimental
 */

declare const __DEV__: boolean | undefined;

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import { uniqueId } from '../../core/src/infra/id.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../preset-2d/src/map-2d.ts';
import {
    geodeticToECEF,
    WGS84_A,
} from '../../core/src/geo/ellipsoid.ts';
import { createCamera3D } from '../../camera-3d/src/Camera3D.ts';
import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import {
    coveringTilesGlobe,
    screenToGlobe,
} from '../../globe/src/globe-tile-mesh.ts';
import type {
    GlobeCamera,
} from '../../globe/src/globe-tile-mesh.ts';

import { _ecefTmp } from './globe-buffers.ts';
import {
    CLEAR_G,
    CLEAR_R,
    CLEAR_B,
    DEFAULT_ALTITUDE,
    DEFAULT_CLOCK_MULTIPLIER,
    DEFAULT_FLIGHT_DURATION_MS,
    DEFAULT_FOV,
    DEFAULT_TERRAIN_EXAGGERATION,
    DEG2RAD,
    DEPTH_CLEAR_VALUE,
    MAX_DEFAULT_PIXEL_RATIO,
    MIN_CANVAS_DIM,
    MORPH_DEFAULT_DURATION_MS,
    RAD2DEG,
    TILE_URL_TEMPLATE_DEFAULT,
    ZOOM_ALTITUDE_C,
} from './globe-constants.ts';
import {
    computeGlobeCamera,
    runEggShapeDiagnostic,
    updateGlobeCameraUniforms,
} from './globe-camera.ts';
import {
    createAtmoPipeline,
    createGlobeGPUResources,
    createGlobePipeline,
    createSkyPipeline,
    destroyGlobeGPUResources,
    ensureGlobeDepthTexture,
} from './globe-gpu.ts';
import { createGlobeMouseHandlers, runMorph } from './globe-interaction.ts';
import {
    renderAtmosphere,
    renderGlobeTiles,
    renderSkyDome,
} from './globe-render.ts';
import {
    clearMeshCache,
    clearTileCache,
} from './globe-tiles.ts';
import type {
    EntitySpec,
    GeoJsonRecord,
    Globe3DOptions,
    GlobeGPURefs,
    GlobeInteractionState,
    GlobeRendererStats,
    ImageryLayerRecord,
    MorphState,
    TileManagerState,
    TilesetRecord,
} from './globe-types.ts';
import { createEmptyGlobeGPURefs } from './globe-types.ts';
import { devError, requestGpuAdapterWithFallback } from './globe-utils.ts';

export type { EntitySpec, Globe3DOptions, GlobeRendererStats } from './globe-types.ts';
export { computeLogDepthBufFC } from './globe-utils.ts';
export { LOG_DEPTH_WGSL } from './globe-shaders.ts';

/**
 * 3D 数字地球宿主：DOM + WebGPU + 相机 + 瓦片与可选图层/实体占位。
 * 生命周期：`constructor` → 异步 `_bootstrapAsync` → `ready()`；`remove()` 释放 GPU 与监听。
 */
export class Globe3D {
    // ─── DOM ─────────────────────────────────────────────────

    /** 用户指定的挂载容器（已解析为 `HTMLElement`） */
    private readonly _container: HTMLElement;

    /** 全尺寸 WebGPU 画布，交互事件绑定于此 */
    private readonly _canvas: HTMLCanvasElement;

    // ─── 相机与帧快照 ────────────────────────────────────────

    /** L3 `Camera3D`：经纬高 + bearing/pitch + 交互句柄 */
    private _camera3D: Camera3D;

    /** 当前 CSS 像素尺寸、物理像素与 `devicePixelRatio`；每帧 `_resizeCanvas` 可能更新 */
    private _viewport: Viewport;

    /** 上一帧 `Camera3D.update` 返回的 `CameraState`，供 `getZoom` / 坐标转换 */
    private _lastCamState: CameraState | null = null;

    /** 上一帧 `computeGlobeCamera` 结果，供 `pickGlobe` 与异步查询 */
    private _lastGlobeCam: GlobeCamera | null = null;

    // ─── WebGPU 聚合（见 globe-types / globe-gpu）────────────

    /** 设备、管线、缓冲、深度等句柄的单对象聚合 */
    private readonly _gpuRefs: GlobeGPURefs = createEmptyGlobeGPURefs();

    // ─── 瓦片与网格（见 globe-tiles）─────────────────────────

    /** 纹理 LRU、网格缓存、当前影像 URL 模板 */
    private readonly _tileState: TileManagerState = {
        tileCache: new Map(),
        tileLRU: [],
        meshCache: new Map(),
        tileUrlTemplate: TILE_URL_TEMPLATE_DEFAULT,
    };

    // ─── 视图 morph（见 globe-interaction）──────────────────

    /** 2D/2.5D/3D 切换动画状态；与渲染管线耦合尚浅 */
    private readonly _morphState: MorphState = {
        morphing: false,
        morphStartTime: 0,
        morphDuration: 0,
        morphTarget: '3d',
        viewMode: '3d',
    };

    /** 鼠标拖拽键位与进行中标志 */
    private readonly _interactionState: GlobeInteractionState = {
        isDragging: false,
        dragButton: -1,
    };

    // ─── 图层与实体（占位）───────────────────────────────────

    /** `addImageryLayer` 注册的底图列表 */
    private readonly _imageryLayers: Map<string, ImageryLayerRecord> = new Map();

    /** `add3DTileset` 预留记录 */
    private readonly _tilesets: Map<string, TilesetRecord> = new Map();

    /** `addGeoJSON` 预留记录 */
    private readonly _geoJsonLayers: Map<string, GeoJsonRecord> = new Map();

    /** `addEntity` 实体表 */
    private readonly _entities: Map<string, EntitySpec> = new Map();

    // ─── 生命周期与事件 ─────────────────────────────────────

    /** `on` / `off` 注册的监听器；`remove` 时清空 */
    private readonly _listeners: Map<string, Set<(e: unknown) => void>> = new Map();

    /** `remove()` 后一切公共 API 抛错 */
    private _destroyed = false;

    /** `requestAnimationFrame` 句柄，用于停止帧循环 */
    private _rafId = 0;

    /** 上一帧 `performance.now()`，用于 dt */
    private _lastFrameTime = 0;

    /** 已提交帧数；首帧 EggShape 诊断用 */
    private _frameCount = 0;

    /** `ready()` resolve；bootstrap 结束后置 `null` */
    private _readyResolve: (() => void) | null = null;

    /** 构造时创建，供 `ready()` 返回 */
    private readonly _readyPromise: Promise<void>;

    /** 防止并发 `_bootstrapAsync` */
    private _bootstrapping = false;

    // ─── 渲染与环境开关 ─────────────────────────────────────

    /** 大气 pass 是否执行 */
    private _atmosphere: boolean;

    /** 阴影（预留） */
    private _shadows: boolean;

    /** 天穹 pass 是否执行 */
    private _skybox: boolean;

    /** 雾效（预留） */
    private _fog: boolean;

    /** 仿真时间，影响太阳方向 uniform */
    private _dateTime: Date;

    /** 每帧推进时间的倍率 */
    private _clockMultiplier: number;

    /** DEM 夸大（预留） */
    private _terrainExaggeration: number;

    /** `resize` 时 `devicePixelRatio` 上限 */
    private readonly _maxPixelRatio: number;

    // ─── 交互约束（构造时写入，只读）────────────────────────

    /** 允许左键拖拽旋转 */
    private readonly _enableRotate: boolean;

    /** 允许滚轮缩放 */
    private readonly _enableZoom: boolean;

    /** 允许中键调节姿态 */
    private readonly _enableTilt: boolean;

    /** `Camera3D` 最小离地距离（米） */
    private readonly _minimumZoomDistance: number;

    /** `Camera3D` 最大离地距离（米） */
    private readonly _maximumZoomDistance: number;

    /** 监听容器尺寸变化以自动 `resize` */
    private _resizeObserver: ResizeObserver | null = null;

    // ─── 上一帧统计（renderer getter）──────────────────────

    /** 上一帧 `renderGlobeTiles` 绘制的瓦片数 */
    private _statsTilesRendered = 0;

    /** 上一帧 draw 调用次数（含天穹/大气） */
    private _statsDrawCalls = 0;

    /** 上一帧 `_renderFrame` 耗时（毫秒） */
    private _statsFrameTimeMs = 0;

    // ─── 事件处理器引用（供 remove 时 removeEventListener）──

    /** 由 `createGlobeMouseHandlers` 返回，绑定在 canvas/window */
    private readonly _boundMouseDown: (e: MouseEvent) => void;
    private readonly _boundMouseMove: (e: MouseEvent) => void;
    private readonly _boundMouseUp: (e: MouseEvent) => void;
    private readonly _boundWheel: (e: WheelEvent) => void;
    private readonly _boundContextMenu: (e: Event) => void;

    // ════════════════════════════════════════════════════════════
    // 构造函数
    // ════════════════════════════════════════════════════════════

    /**
     * 创建 Globe3D 实例。
     * 同步解析容器/创建 Canvas/初始化 Camera3D，异步启动 WebGPU。
     *
     * @param options - 数字地球构造选项
     * @throws {GeoForgeError} 容器无效时抛出 CONFIG_INVALID_CONTAINER
     *
     * @example
     * const globe = new Globe3D({ container: '#globe' });
     * await globe.ready();
     */
    constructor(options: Globe3DOptions) {
        // ── 解析容器 DOM ──
        this._container = this._resolveContainer(options.container);

        // ── 创建全尺寸 Canvas ──
        this._canvas = document.createElement('canvas');
        this._canvas.style.display = 'block';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.touchAction = 'none';

        // 无障碍标题
        if (options.accessibleTitle) {
            this._canvas.setAttribute('aria-label', options.accessibleTitle);
        } else {
            this._canvas.setAttribute('aria-label', 'GeoForge 3D Globe');
        }

        // 容器必须是定位元素，才能让 Canvas 的 100% 尺寸生效
        if (getComputedStyle(this._container).position === 'static') {
            this._container.style.position = 'relative';
        }
        this._container.style.overflow = 'hidden';

        // 将 Canvas 挂到容器
        this._container.appendChild(this._canvas);

        // ── 最大像素比 ──
        this._maxPixelRatio = options.maxPixelRatio ?? MAX_DEFAULT_PIXEL_RATIO;

        // ── 初始化 Canvas 尺寸 ──
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // ── 渲染选项 ──
        this._atmosphere = options.atmosphere !== false;
        this._shadows = options.shadows === true;
        this._skybox = options.skybox !== false;
        this._fog = options.fog !== false;
        this._dateTime = new Date();
        this._clockMultiplier = DEFAULT_CLOCK_MULTIPLIER;
        this._terrainExaggeration = options.terrain?.exaggeration ?? DEFAULT_TERRAIN_EXAGGERATION;

        // ── 影像 URL ──
        this._tileState.tileUrlTemplate = options.imagery?.url ?? TILE_URL_TEMPLATE_DEFAULT;

        // ── 交互选项 ──
        this._enableRotate = options.enableRotate !== false;
        this._enableZoom = options.enableZoom !== false;
        this._enableTilt = options.enableTilt !== false;
        this._minimumZoomDistance = options.minimumZoomDistance ?? 100;
        this._maximumZoomDistance = options.maximumZoomDistance ?? 5e7;

        // ── 初始相机参数 ──
        const initCenter = options.center ?? [0, 0];
        const initAlt = options.altitude ?? DEFAULT_ALTITUDE;
        const initBearingRad = (options.bearing ?? 0) * DEG2RAD;
        const initPitchRad = (options.pitch ?? -45) * DEG2RAD;

        // ── 创建 Camera3D ──
        this._camera3D = createCamera3D({
            position: { lon: initCenter[0], lat: initCenter[1], alt: initAlt },
            bearing: initBearingRad,
            pitch: initPitchRad,
            fov: DEFAULT_FOV,
            minimumZoomDistance: this._minimumZoomDistance,
            maximumZoomDistance: this._maximumZoomDistance,
        });

        // ── 绑定交互事件处理器（globe-interaction） ──
        const _handlers = createGlobeMouseHandlers(
            this._camera3D,
            {
                enableRotate: this._enableRotate,
                enableZoom: this._enableZoom,
                enableTilt: this._enableTilt,
            },
            this._interactionState,
            { isDestroyed: () => this._destroyed },
        );
        this._boundMouseDown = _handlers.onMouseDown;
        this._boundMouseMove = _handlers.onMouseMove;
        this._boundMouseUp = _handlers.onMouseUp;
        this._boundWheel = _handlers.onWheel;
        this._boundContextMenu = _handlers.onContextMenu;

        // ── 安装交互监听 ──
        this._installInteractions();

        // ── ResizeObserver 监听容器尺寸变化 ──
        this._resizeObserver = new ResizeObserver(() => {
            if (!this._destroyed) { this.resize(); }
        });
        this._resizeObserver.observe(this._container);

        // ── ready promise ──
        this._readyPromise = new Promise<void>((resolve) => {
            this._readyResolve = resolve;
        });

        // ── 异步启动 WebGPU ──
        this._bootstrapAsync().catch((err) => {
            devError('[Globe3D] bootstrap failed:', err);
        });
    }

    // ════════════════════════════════════════════════════════════
    // Public Getters
    // ════════════════════════════════════════════════════════════

    /**
     * 获取 Camera3D 控制器实例（逃生舱口）。
     *
     * @returns Camera3D 实例
     *
     * @example
     * const cam = globe.camera;
     * cam.setPosition(121.47, 31.23, 500_000);
     */
    get camera(): Camera3D {
        return this._camera3D;
    }

    /**
     * 获取渲染器统计信息。
     *
     * @returns 只读的渲染性能指标
     *
     * @example
     * const stats = globe.renderer;
     * console.log(`Tiles: ${stats.tilesRendered}, DrawCalls: ${stats.drawCalls}`);
     */
    get renderer(): GlobeRendererStats {
        return {
            tilesRendered: this._statsTilesRendered,
            tilesCached: this._tileState.tileCache.size,
            drawCalls: this._statsDrawCalls,
            frameTimeMs: this._statsFrameTimeMs,
        };
    }

    /**
     * 获取当前视图模式。
     *
     * @returns '2d' | '25d' | '3d'
     *
     * @example
     * if (globe.currentViewMode === '3d') { ... }
     */
    get currentViewMode(): '2d' | '25d' | '3d' {
        return this._morphState.viewMode;
    }

    // ════════════════════════════════════════════════════════════
    // 生命周期
    // ════════════════════════════════════════════════════════════

    /**
     * 等待 Globe3D 完成异步初始化（WebGPU 设备创建、管线编译）。
     *
     * @returns 初始化完成后 resolve 的 Promise
     *
     * @example
     * await globe.ready();
     * globe.flyTo({ center: [121.47, 31.23], altitude: 1_000_000 });
     */
    public ready(): Promise<void> {
        return this._readyPromise;
    }

    /**
     * 获取主绘制画布元素。
     *
     * @returns Canvas HTMLElement
     *
     * @example
     * const canvas = globe.getCanvas();
     * canvas.style.cursor = 'crosshair';
     */
    public getCanvas(): HTMLCanvasElement {
        this._ensureAlive();
        return this._canvas;
    }

    /**
     * 获取挂载容器元素。
     *
     * @returns 容器 HTMLElement
     *
     * @example
     * const container = globe.getContainer();
     */
    public getContainer(): HTMLElement {
        this._ensureAlive();
        return this._container;
    }

    /**
     * 响应容器尺寸变化，重新计算 Canvas 大小和视口参数。
     *
     * @example
     * window.addEventListener('resize', () => globe.resize());
     */
    public resize(): void {
        this._ensureAlive();

        // 重新计算 Canvas 尺寸和视口
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // 标记深度纹理需要重建（_renderFrame 中检查）
        this._gpuRefs.depthW = 0;
        this._gpuRefs.depthH = 0;
    }

    /**
     * 销毁 Globe3D 实例，释放所有 GPU 资源和 DOM 元素。
     * 调用后实例不可再使用。
     *
     * @example
     * globe.remove();
     */
    public remove(): void {
        if (this._destroyed) { return; }
        this._destroyed = true;

        // 停止帧循环
        if (this._rafId !== 0) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        // 移除交互监听
        this._canvas.removeEventListener('mousedown', this._boundMouseDown);
        window.removeEventListener('mousemove', this._boundMouseMove);
        window.removeEventListener('mouseup', this._boundMouseUp);
        this._canvas.removeEventListener('wheel', this._boundWheel);
        this._canvas.removeEventListener('contextmenu', this._boundContextMenu);

        // 停止 ResizeObserver
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // 销毁 Camera3D
        this._camera3D.destroy();

        // 销毁 GPU 资源
        this._destroyGPUResources();

        // 移除 Canvas
        if (this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }

        // 清空事件监听
        this._listeners.clear();

        // 发出销毁事件
        this._emit('remove', undefined);
    }

    // ════════════════════════════════════════════════════════════
    // 相机视图 API
    // ════════════════════════════════════════════════════════════

    /**
     * 获取当前连续 zoom 级别。
     * zoom=0 为全球视图，每增加 1 级分辨率翻倍。
     *
     * @returns zoom 浮点值
     *
     * @example
     * const z = globe.getZoom(); // 5.3
     */
    public getZoom(): number {
        this._ensureAlive();
        // 从相机状态获取 zoom
        const state = this._lastCamState;
        if (state) { return state.zoom; }
        // fallback: 从 altitude 换算
        const pos = this._camera3D.getPosition();
        return Math.log2(ZOOM_ALTITUDE_C / Math.max(pos.alt, 1));
    }

    /**
     * 获取当前方位角（度）。
     *
     * @returns bearing 度值
     *
     * @example
     * const bearing = globe.getBearing(); // 45.0
     */
    public getBearing(): number {
        this._ensureAlive();
        const orient = this._camera3D.getOrientation();
        return orient.bearing * RAD2DEG;
    }

    /**
     * 获取当前俯仰角（度）。
     *
     * @returns pitch 度值
     *
     * @example
     * const pitch = globe.getPitch(); // -45.0
     */
    public getPitch(): number {
        this._ensureAlive();
        const orient = this._camera3D.getOrientation();
        return orient.pitch * RAD2DEG;
    }

    /**
     * 获取完整相机位置和姿态。
     *
     * @returns 包含 lon/lat/alt/bearing/pitch/roll 的对象
     *
     * @example
     * const pos = globe.getCameraPosition();
     * console.log(`${pos.lon}°, ${pos.lat}°, ${pos.alt}m`);
     */
    public getCameraPosition(): {
        lon: number; lat: number; alt: number;
        bearing: number; pitch: number; roll: number;
    } {
        this._ensureAlive();
        const pos = this._camera3D.getPosition();
        const orient = this._camera3D.getOrientation();
        return {
            lon: pos.lon,
            lat: pos.lat,
            alt: pos.alt,
            bearing: orient.bearing * RAD2DEG,
            pitch: orient.pitch * RAD2DEG,
            roll: orient.roll * RAD2DEG,
        };
    }

    /**
     * 设置相机位置和姿态。
     * 所有参数以度/米为单位，bearing/pitch/roll 为度。
     *
     * @param pos - 位置和姿态对象
     *
     * @example
     * globe.setCameraPosition({ lon: 116.39, lat: 39.91, alt: 500_000, bearing: 45, pitch: -30, roll: 0 });
     */
    public setCameraPosition(pos: {
        lon?: number; lat?: number; alt?: number;
        bearing?: number; pitch?: number; roll?: number;
    }): void {
        this._ensureAlive();

        // 获取当前值作为默认
        const curPos = this._camera3D.getPosition();
        const curOrient = this._camera3D.getOrientation();

        const lon = pos.lon ?? curPos.lon;
        const lat = pos.lat ?? curPos.lat;
        const alt = pos.alt ?? curPos.alt;

        // 设置位置
        this._camera3D.setPosition(lon, lat, alt);

        // 设置姿态（入参为度，Camera3D 需要弧度）
        const bearing = (pos.bearing !== undefined) ? pos.bearing * DEG2RAD : curOrient.bearing;
        const pitch = (pos.pitch !== undefined) ? pos.pitch * DEG2RAD : curOrient.pitch;
        const roll = (pos.roll !== undefined) ? pos.roll * DEG2RAD : curOrient.roll;
        this._camera3D.setOrientation(bearing, pitch, roll);
    }

    /**
     * 飞行到指定位置/姿态，沿大圆弧平滑过渡。
     *
     * @param options - 目标参数（center=[lng,lat]度, altitude米, bearing/pitch度, duration毫秒）
     *
     * @example
     * globe.flyTo({ center: [121.47, 31.23], altitude: 500_000, bearing: 0, pitch: -45, duration: 3000 });
     */
    public flyTo(options: {
        center?: [number, number];
        altitude?: number;
        zoom?: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
    }): void {
        this._ensureAlive();

        // 计算目标高度：优先使用 altitude，其次从 zoom 换算
        let alt = options.altitude;
        if (alt === undefined && options.zoom !== undefined) {
            alt = ZOOM_ALTITUDE_C / Math.pow(2, options.zoom);
        }

        const curPos = this._camera3D.getPosition();
        const curOrient = this._camera3D.getOrientation();

        // Camera3D.flyToPosition 需要弧度角度
        this._camera3D.flyToPosition({
            lon: options.center ? options.center[0] : curPos.lon,
            lat: options.center ? options.center[1] : curPos.lat,
            alt: alt ?? curPos.alt,
            bearing: options.bearing !== undefined ? options.bearing * DEG2RAD : curOrient.bearing,
            pitch: options.pitch !== undefined ? options.pitch * DEG2RAD : curOrient.pitch,
            duration: options.duration ?? DEFAULT_FLIGHT_DURATION_MS,
        });
    }

    /**
     * 将相机朝向指定目标点，可选偏移。
     *
     * @param target - 目标点 [lon(度), lat(度), alt(米)]
     * @param offset - 可选偏移：{ bearing(度), pitch(度), range(米) }
     *
     * @example
     * globe.lookAt([116.39, 39.91, 0], { bearing: 45, pitch: -30, range: 100_000 });
     */
    public lookAt(
        target: [number, number, number],
        offset?: { bearing?: number; pitch?: number; range?: number },
    ): void {
        this._ensureAlive();

        // Camera3D.lookAt 接受弧度角度
        this._camera3D.lookAt(target, offset ? {
            bearing: offset.bearing !== undefined ? offset.bearing * DEG2RAD : undefined,
            pitch: offset.pitch !== undefined ? offset.pitch * DEG2RAD : undefined,
            range: offset.range,
        } : undefined);
    }

    /**
     * 飞行到适配指定地理范围的视角。
     *
     * @param bounds - 地理包围盒 { west, south, east, north } 度
     * @param options - 附加选项 { padding?, duration? }
     *
     * @example
     * globe.flyToBounds({ west: 73, south: 18, east: 135, north: 53 }, { duration: 2000 });
     */
    public flyToBounds(
        bounds: BBox2D,
        options?: { padding?: number; duration?: number },
    ): void {
        this._ensureAlive();

        // 计算中心经纬度
        const centerLng = (bounds.west + bounds.east) / 2;
        const centerLat = (bounds.south + bounds.north) / 2;

        // 估算需要的高度：使用经度跨度和视口宽高比
        const lngSpan = Math.abs(bounds.east - bounds.west);
        const latSpan = Math.abs(bounds.north - bounds.south);
        const maxSpan = Math.max(lngSpan, latSpan);

        // 近似：将角度跨度换算为地面距离，然后根据 FOV 计算高度
        const groundDist = maxSpan * DEG2RAD * WGS84_A;
        const fov = DEFAULT_FOV;
        const alt = (groundDist / 2) / Math.tan(fov / 2);

        // 加上 padding 余量
        const padding = options?.padding ?? 0;
        const paddedAlt = alt * (1 + padding / 100);

        this.flyTo({
            center: [centerLng, centerLat],
            altitude: paddedAlt,
            duration: options?.duration ?? DEFAULT_FLIGHT_DURATION_MS,
        });
    }

    // ════════════════════════════════════════════════════════════
    // 图层管理 API
    // ════════════════════════════════════════════════════════════

    /**
     * 添加影像底图图层。
     *
     * @param options - 图层配置 { url, type?, alpha? }
     * @returns 图层 id
     *
     * @example
     * const id = globe.addImageryLayer({ url: 'https://tiles.example.com/{z}/{x}/{y}.png' });
     */
    public addImageryLayer(options: {
        url: string;
        type?: string;
        alpha?: number;
        id?: string;
    }): string {
        this._ensureAlive();

        const id = options.id ?? uniqueId('imagery');

        // 防止重复 id
        if (this._imageryLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `Imagery layer id "${id}" already exists`,
                { id },
            );
        }

        this._imageryLayers.set(id, {
            id,
            url: options.url,
            type: options.type ?? 'xyz',
            alpha: options.alpha ?? 1.0,
        });

        // 切换瓦片 URL 模板为最新添加的图层
        this._tileState.tileUrlTemplate = options.url;

        // 清空缓存以加载新瓦片
        clearTileCache(this._tileState);

        this._emit('imageryLayer:added', { id });
        return id;
    }

    /**
     * 移除影像底图图层。
     *
     * @param id - 图层 id
     *
     * @example
     * globe.removeImageryLayer('imagery_1');
     */
    public removeImageryLayer(id: string): void {
        this._ensureAlive();

        if (!this._imageryLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `Imagery layer "${id}" not found`,
                { id },
            );
        }

        this._imageryLayers.delete(id);

        // 回退到默认 URL 或最后一个图层
        if (this._imageryLayers.size > 0) {
            const last = Array.from(this._imageryLayers.values()).pop()!;
            this._tileState.tileUrlTemplate = last.url;
        } else {
            this._tileState.tileUrlTemplate = TILE_URL_TEMPLATE_DEFAULT;
        }

        clearTileCache(this._tileState);
        this._emit('imageryLayer:removed', { id });
    }

    /**
     * 添加 3D Tiles 数据集。
     *
     * @param options - 数据集配置
     * @returns 记录 id
     *
     * @example
     * const id = globe.add3DTileset({ url: 'https://example.com/tileset.json' });
     */
    public add3DTileset(options: {
        url: string;
        maximumScreenSpaceError?: number;
        show?: boolean;
        id?: string;
    }): string {
        this._ensureAlive();

        const id = options.id ?? uniqueId('tileset');

        if (this._tilesets.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `3D Tileset id "${id}" already exists`,
                { id },
            );
        }

        this._tilesets.set(id, {
            id,
            url: options.url,
            maximumScreenSpaceError: options.maximumScreenSpaceError ?? 16,
            show: options.show !== false,
        });

        this._emit('tileset:added', { id });
        return id;
    }

    /**
     * 移除 3D Tiles 数据集。
     *
     * @param id - 数据集 id
     *
     * @example
     * globe.remove3DTileset('tileset_1');
     */
    public remove3DTileset(id: string): void {
        this._ensureAlive();

        if (!this._tilesets.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `3D Tileset "${id}" not found`,
                { id },
            );
        }

        this._tilesets.delete(id);
        this._emit('tileset:removed', { id });
    }

    /**
     * 添加 GeoJSON 数据图层。
     *
     * @param data - GeoJSON 数据对象或 URL
     * @param options - 样式选项
     * @returns 图层 id
     *
     * @example
     * const id = globe.addGeoJSON(geojsonData, { color: 'red', lineWidth: 2 });
     */
    public addGeoJSON(data: unknown, options?: { id?: string; [key: string]: unknown }): string {
        this._ensureAlive();

        const id = options?.id as string ?? uniqueId('geojson');

        if (this._geoJsonLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `GeoJSON layer id "${id}" already exists`,
                { id },
            );
        }

        this._geoJsonLayers.set(id, { id, data, options });

        this._emit('geojson:added', { id });
        return id;
    }

    /**
     * 移除 GeoJSON 图层。
     *
     * @param id - 图层 id
     *
     * @example
     * globe.removeGeoJSON('geojson_1');
     */
    public removeGeoJSON(id: string): void {
        this._ensureAlive();

        if (!this._geoJsonLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `GeoJSON layer "${id}" not found`,
                { id },
            );
        }

        this._geoJsonLayers.delete(id);
        this._emit('geojson:removed', { id });
    }

    /**
     * 添加 3D 实体（模型/标牌/标签）。
     *
     * @param entity - 实体描述
     * @returns 实体 id
     *
     * @example
     * const id = globe.addEntity({ position: [116.39, 39.91, 100], label: { text: 'Beijing' } });
     */
    public addEntity(entity: EntitySpec): string {
        this._ensureAlive();

        const id = entity.id ?? uniqueId('entity');
        const spec: EntitySpec = { ...entity, id };

        if (this._entities.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `Entity id "${id}" already exists`,
                { id },
            );
        }

        this._entities.set(id, spec);
        this._emit('entity:added', { id });
        return id;
    }

    /**
     * 移除 3D 实体。
     *
     * @param id - 实体 id
     *
     * @example
     * globe.removeEntity('entity_1');
     */
    public removeEntity(id: string): void {
        this._ensureAlive();

        if (!this._entities.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `Entity "${id}" not found`,
                { id },
            );
        }

        this._entities.delete(id);
        this._emit('entity:removed', { id });
    }

    // ════════════════════════════════════════════════════════════
    // 查询 API
    // ════════════════════════════════════════════════════════════

    /**
     * 查询屏幕坐标处已渲染的要素（异步，需要 GPU readback）。
     *
     * @param point - 屏幕坐标 [x, y]（CSS 像素），省略则查询全视口
     * @param options - 过滤选项 { layers? }
     * @returns 命中的要素数组
     *
     * @example
     * const features = await globe.queryRenderedFeatures([400, 300]);
     */
    public async queryRenderedFeatures(
        point?: [number, number],
        options?: { layers?: string[] },
    ): Promise<Feature[]> {
        this._ensureAlive();

        // 当前 MVP 阶段返回空数组，后续接入 PickingEngine
        return [];
    }

    // ════════════════════════════════════════════════════════════
    // 地形/环境 API
    // ════════════════════════════════════════════════════════════

    /**
     * 设置地形高程夸大系数。
     *
     * @param value - 夸大系数（>= 0），1.0 = 真实高度
     *
     * @example
     * globe.setTerrainExaggeration(2.5);
     */
    public setTerrainExaggeration(value: number): void {
        this._ensureAlive();
        this._validatePositive(value, 'terrainExaggeration');
        this._terrainExaggeration = value;
    }

    /**
     * 查询指定经纬度处的地形高程（异步）。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns 地形高度（米），无数据时返回 0
     *
     * @example
     * const h = await globe.getTerrainHeight(86.92, 27.99); // 珠峰
     */
    public async getTerrainHeight(lon: number, lat: number): Promise<number> {
        this._ensureAlive();

        // 通过 Camera3D 的地形查询接口
        try {
            return await this._camera3D.queryTerrainHeight(lon, lat);
        } catch {
            // 无地形数据时回退 0
            return 0;
        }
    }

    /**
     * 启用/禁用大气层渲染。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setAtmosphereEnabled(false);
     */
    public setAtmosphereEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._atmosphere = enabled;
    }

    /**
     * 启用/禁用阴影。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setShadowsEnabled(true);
     */
    public setShadowsEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._shadows = enabled;
    }

    /**
     * 启用/禁用天空盒渲染。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setSkyboxEnabled(false);
     */
    public setSkyboxEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._skybox = enabled;
    }

    /**
     * 启用/禁用雾效。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setFogEnabled(false);
     */
    public setFogEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._fog = enabled;
    }

    /**
     * 设置仿真日期时间（影响太阳位置和阴影方向）。
     *
     * @param date - 目标时间
     *
     * @example
     * globe.setDateTime(new Date('2025-06-21T12:00:00Z'));
     */
    public setDateTime(date: Date): void {
        this._ensureAlive();
        this._dateTime = date;
    }

    /**
     * 获取当前仿真日期时间。
     *
     * @returns 仿真时间
     *
     * @example
     * const dt = globe.getDateTime();
     */
    public getDateTime(): Date {
        this._ensureAlive();
        return this._dateTime;
    }

    /**
     * 设置时钟倍速（加速/减速仿真时间流逝）。
     *
     * @param multiplier - 倍速值（>= 0），1.0 = 实时
     *
     * @example
     * globe.setClockMultiplier(60); // 1分钟=1秒
     */
    public setClockMultiplier(multiplier: number): void {
        this._ensureAlive();
        this._validatePositive(multiplier, 'clockMultiplier');
        this._clockMultiplier = multiplier;
    }

    // ════════════════════════════════════════════════════════════
    // 坐标转换 API
    // ════════════════════════════════════════════════════════════

    /**
     * 地理坐标 → 屏幕像素坐标。
     * 如果点不在视口内（被地球遮挡或裁剪），返回 null。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @param alt - 海拔（米），默认 0
     * @returns [screenX, screenY] CSS 像素坐标，或 null
     *
     * @example
     * const px = globe.cartographicToScreen(116.39, 39.91);
     * if (px) { tooltip.style.left = px[0] + 'px'; tooltip.style.top = px[1] + 'px'; }
     */
    public cartographicToScreen(lon: number, lat: number, alt?: number): [number, number] | null {
        this._ensureAlive();

        const camState = this._lastCamState;
        if (!camState) { return null; }

        // 经纬度→ECEF
        const lonRad = lon * DEG2RAD;
        const latRad = lat * DEG2RAD;
        geodeticToECEF(_ecefTmp, lonRad, latRad, alt ?? 0);

        // ECEF→RTE（相对相机位置）
        const camPos = camState.position;
        const rx = _ecefTmp[0] - camPos[0];
        const ry = _ecefTmp[1] - camPos[1];
        const rz = _ecefTmp[2] - camPos[2];

        // RTE → clip space (vpMatrix × [rx, ry, rz, 1])
        const vp = camState.vpMatrix;
        const cx = vp[0] * rx + vp[4] * ry + vp[8] * rz + vp[12];
        const cy = vp[1] * rx + vp[5] * ry + vp[9] * rz + vp[13];
        const cz = vp[2] * rx + vp[6] * ry + vp[10] * rz + vp[14];
        const cw = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];

        // 透视除法
        if (Math.abs(cw) < 1e-10) { return null; }
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        const ndcZ = cz / cw;

        // 裁剪检查：NDC 必须在 [-1,1] 范围内，Z 在 [0,1]
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < 0 || ndcZ > 1) {
            return null;
        }

        // NDC → 屏幕像素
        const screenX = (ndcX * 0.5 + 0.5) * this._viewport.width;
        const screenY = (1 - (ndcY * 0.5 + 0.5)) * this._viewport.height;

        return [screenX, screenY];
    }

    /**
     * 屏幕像素坐标 → 地理坐标。
     * 通过 ray-ellipsoid intersection 求交。
     *
     * @param x - 屏幕 X（CSS 像素）
     * @param y - 屏幕 Y（CSS 像素）
     * @returns [lng, lat, alt] 度/米，或 null（射线不与地球相交）
     *
     * @example
     * const geo = globe.screenToCartographic(400, 300);
     * if (geo) { console.log(`${geo[0]}°, ${geo[1]}°`); }
     */
    public screenToCartographic(x: number, y: number): [number, number, number] | null {
        this._ensureAlive();

        const camState = this._lastCamState;
        if (!camState) { return null; }

        // 需要 ECEF 空间的 inverseVP 矩阵
        const globeCam = computeGlobeCamera(this._camera3D, camState, this._viewport);
        const hit = screenToGlobe(
            x, y,
            globeCam.inverseVP_ECEF,
            this._viewport.width,
            this._viewport.height,
        );

        if (!hit) { return null; }

        // screenToGlobe 返回地表交点，alt=0
        return [hit[0], hit[1], 0];
    }

    // ════════════════════════════════════════════════════════════
    // GPU Picking（深度读回 + 射线求交）
    // ════════════════════════════════════════════════════════════

    /**
     * 屏幕像素坐标 → 地球表面 ECEF 位置（异步）。
     *
     * 当前实现使用 ray-ellipsoid intersection（screenToGlobe）；
     * 后续可通过 `_readDepthAtPixel` 读取 GPU 深度缓冲获得精确
     * 三维交点（含地形高程）。
     *
     * @param screenX - 屏幕 X（CSS 像素）
     * @param screenY - 屏幕 Y（CSS 像素）
     * @returns [lng, lat, altitude] 度/米，或 null（射线不与地球相交）
     *
     * @stability experimental
     *
     * @example
     * const result = await globe.pickGlobe(400, 300);
     * if (result) { console.log(`lng=${result[0]}, lat=${result[1]}, alt=${result[2]}`); }
     */
    public async pickGlobe(screenX: number, screenY: number): Promise<[number, number, number] | null> {
        this._ensureAlive();

        // 需要至少渲染过一帧才能获取 GlobeCamera
        if (!this._lastGlobeCam) { return null; }

        const gc = this._lastGlobeCam;

        // 射线-椭球求交（screenToGlobe 返回 [lng, lat] 度 或 null）
        const hit = screenToGlobe(
            screenX, screenY,
            gc.inverseVP_ECEF,
            gc.viewportWidth, gc.viewportHeight,
        );

        if (!hit) { return null; }

        // 返回 [lng, lat, altitude=0]（地表交点，无地形高程）
        return [hit[0], hit[1], 0];
    }

    /**
     * 读取深度缓冲中指定像素的深度值（GPU → CPU 异步读回）。
     *
     * 流程：
     * 1. 创建 1×1 staging buffer（256 字节，WebGPU 最小映射尺寸）
     * 2. 将深度纹理 (x,y) 处 1×1 像素复制到 staging buffer
     * 3. mapAsync 映射 → 读取 depth32float 值
     * 4. 返回深度值（0~1 范围；Reversed-Z 下 0.0=远平面，1.0=近平面）
     *
     * @param x - 屏幕 X（CSS 像素）
     * @param y - 屏幕 Y（CSS 像素）
     * @returns 深度值（0~1），或 null（坐标越界/无深度/背景像素）
     *
     * @stability experimental
     *
     * @example
     * const depth = await this._readDepthAtPixel(400, 300);
     * if (depth !== null) { console.log(`depth = ${depth}`); }
     */
    private async _readDepthAtPixel(x: number, y: number): Promise<number | null> {
        const device = this._gpuRefs.device;

        // GPU 设备或深度纹理不可用
        if (!device || !this._gpuRefs.depthTexture) { return null; }

        // CSS 像素 → 物理像素（考虑设备像素比）
        const px = Math.round(x * this._viewport.pixelRatio);
        const py = Math.round(y * this._viewport.pixelRatio);

        // 边界检查：物理坐标必须在深度纹理范围内
        if (px < 0 || px >= this._gpuRefs.depthTexture.width || py < 0 || py >= this._gpuRefs.depthTexture.height) {
            return null;
        }

        // WebGPU 要求 buffer mapping 最小 256 字节，depth32float = 4 bytes/pixel
        const STAGING_BUFFER_SIZE = 256;

        // 创建临时 staging buffer（MAP_READ 用于 CPU 回读）
        const stagingBuffer = device.createBuffer({
            size: STAGING_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: 'Globe3D:depthReadback',
        });

        // 编码 GPU 命令：深度纹理 → staging buffer（1×1 像素拷贝）
        const encoder = device.createCommandEncoder({ label: 'Globe3D:depthCopy' });
        encoder.copyTextureToBuffer(
            { texture: this._gpuRefs.depthTexture, origin: { x: px, y: py } },
            { buffer: stagingBuffer, bytesPerRow: STAGING_BUFFER_SIZE },
            { width: 1, height: 1 },
        );
        device.queue.submit([encoder.finish()]);

        // 等待 GPU → CPU 传输完成
        await stagingBuffer.mapAsync(GPUMapMode.READ);

        // 读取第一个 float32（depth 值）
        const data = new Float32Array(stagingBuffer.getMappedRange(0, 4));
        const depth = data[0];

        // 释放 staging buffer 资源
        stagingBuffer.unmap();
        stagingBuffer.destroy();

        // Reversed-Z: depth ≈ 0.0 表示远平面（背景/天空），无有效几何体
        // 此处阈值 0.0001 过滤掉背景像素
        if (depth <= 0.0001) { return null; }

        return depth;
    }

    // ════════════════════════════════════════════════════════════
    // Morph API（2D↔3D 视图过渡）
    // ════════════════════════════════════════════════════════════

    /**
     * 从当前视图过渡到 2D 模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo2D({ duration: 2000 });
     */
    public morphTo2D(options?: { duration?: number }): void {
        this._ensureAlive();
        runMorph(this._morphState, '2d', options?.duration ?? MORPH_DEFAULT_DURATION_MS, (t, p) => this._emit(t, p), () => this._destroyed);
    }

    /**
     * 从当前视图过渡到 2.5D 模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo25D({ duration: 1500 });
     */
    public morphTo25D(options?: { duration?: number }): void {
        this._ensureAlive();
        runMorph(this._morphState, '25d', options?.duration ?? MORPH_DEFAULT_DURATION_MS, (t, p) => this._emit(t, p), () => this._destroyed);
    }

    /**
     * 从当前视图过渡到 3D 球体模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo3D({ duration: 1000 });
     */
    public morphTo3D(options?: { duration?: number }): void {
        this._ensureAlive();
        runMorph(this._morphState, '3d', options?.duration ?? MORPH_DEFAULT_DURATION_MS, (t, p) => this._emit(t, p), () => this._destroyed);
    }

    // ════════════════════════════════════════════════════════════
    // 事件 API
    // ════════════════════════════════════════════════════════════

    /**
     * 注册事件监听器。
     *
     * @param type - 事件类型（'click' | 'move' | 'remove' | 'load' 等）
     * @param callback - 回调函数
     *
     * @example
     * globe.on('click', (e) => console.log('clicked at', e));
     */
    public on(type: string, callback: (e: unknown) => void): void {
        this._ensureAlive();

        if (!this._listeners.has(type)) {
            this._listeners.set(type, new Set());
        }

        this._listeners.get(type)!.add(callback);
    }

    /**
     * 移除事件监听器。
     *
     * @param type - 事件类型
     * @param callback - 之前注册的回调函数引用
     *
     * @example
     * globe.off('click', handler);
     */
    public off(type: string, callback: (e: unknown) => void): void {
        const set = this._listeners.get(type);
        if (set) {
            set.delete(callback);
            // 空集合清除
            if (set.size === 0) { this._listeners.delete(type); }
        }
    }

    // ════════════════════════════════════════════════════════════
    // Private — 容器和 Canvas
    // ════════════════════════════════════════════════════════════

    /**
     * 解析容器参数为 HTMLElement。
     * 支持 CSS 选择器字符串或直接传入 HTMLElement。
     *
     * @param container - CSS 选择器或 HTMLElement
     * @returns 解析后的容器元素
     * @throws {GeoForgeError} 选择器未匹配或传入无效元素时抛出
     *
     * @example
     * const el = this._resolveContainer('#globe');
     */
    private _resolveContainer(container: string | HTMLElement): HTMLElement {
        if (typeof container === 'string') {
            // CSS 选择器查询
            const el = document.querySelector(container);
            if (!el || !(el instanceof HTMLElement)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    `Container selector "${container}" did not match any HTMLElement`,
                    { selector: container },
                );
            }
            return el;
        }

        // 直接传入的元素需要验证
        if (!(container instanceof HTMLElement)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                'container must be an HTMLElement or a CSS selector string',
            );
        }

        return container;
    }

    /**
     * 计算并设置 Canvas 的物理像素尺寸，返回 Viewport 描述。
     *
     * @param maxPR - 最大 devicePixelRatio
     * @returns 视口描述
     *
     * @example
     * const vp = this._resizeCanvas(2.0);
     */
    private _resizeCanvas(maxPR: number): Viewport {
        // 容器的 CSS 逻辑尺寸
        const w = Math.max(this._container.clientWidth, MIN_CANVAS_DIM);
        const h = Math.max(this._container.clientHeight, MIN_CANVAS_DIM);

        // 设备像素比（钳制到上限）
        const dpr = Math.min(window.devicePixelRatio || 1, maxPR);

        // 物理像素尺寸
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);

        // 尺寸未变时复用上一帧 Viewport 对象，避免每帧分配
        if (this._canvas.width === pw && this._canvas.height === ph) {
            return this._viewport;
        }

        // 设置 Canvas 物理尺寸（触发 WebGPU surface texture 重新分配）
        this._canvas.width = pw;
        this._canvas.height = ph;

        return {
            width: w,
            height: h,
            physicalWidth: pw,
            physicalHeight: ph,
            pixelRatio: dpr,
        };
    }

    // ════════════════════════════════════════════════════════════
    // Private — WebGPU 初始化
    // ════════════════════════════════════════════════════════════

    /**
     * 异步引导 WebGPU：请求适配器/设备 → 创建资源 → 创建管线 → 启动帧循环。
     *
     * @example
     * await this._bootstrapAsync();
     */
    private async _bootstrapAsync(): Promise<void> {
        if (this._bootstrapping || this._destroyed) { return; }
        this._bootstrapping = true;

        try {
            // ── 检查 WebGPU 可用性 ──
            if (typeof navigator === 'undefined' || !navigator.gpu) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'WebGPU is not supported in this browser',
                );
            }

            // ── 请求 GPU 适配器 ──
            const adapter = await requestGpuAdapterWithFallback(navigator.gpu);
            if (!adapter) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'Failed to obtain a WebGPU adapter',
                );
            }

            // ── 请求 GPU 设备 ──
            const device = await adapter.requestDevice();
            if (this._destroyed) { return; }
            this._gpuRefs.device = device;

            // 监听设备丢失
            device.lost.then((info) => {
                devError('[Globe3D] GPU device lost:', info.message);
                this._emit('device:lost', { message: info.message });
            });

            // ── 配置 Canvas 上下文 ──
            const ctx = this._canvas.getContext('webgpu');
            if (!ctx) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'Failed to get WebGPU canvas context',
                );
            }
            this._gpuRefs.gpuContext = ctx;

            // 获取推荐的纹理格式
            this._gpuRefs.surfaceFormat = navigator.gpu.getPreferredCanvasFormat();

            ctx.configure({
                device,
                format: this._gpuRefs.surfaceFormat,
                alphaMode: 'opaque',
            });

            // ── 创建 GPU 资源 ──
            createGlobeGPUResources(device, this._gpuRefs);

            // ── 创建渲染管线 ──
            this._gpuRefs.globePipeline = createGlobePipeline(device, this._gpuRefs.surfaceFormat, this._gpuRefs);
            this._gpuRefs.skyPipeline = createSkyPipeline(device, this._gpuRefs.surfaceFormat);
            this._gpuRefs.atmoPipeline = createAtmoPipeline(device, this._gpuRefs.surfaceFormat, this._gpuRefs);

            // ── 启动帧循环 ──
            this._startFrameLoop();

            // ── 通知 ready ──
            if (this._readyResolve) {
                this._readyResolve();
                this._readyResolve = null;
            }

            this._emit('load', undefined);

        } catch (err) {
            devError('[Globe3D] _bootstrapAsync error:', err);
            // 依然 resolve ready，让调用方可以检查状态
            if (this._readyResolve) {
                this._readyResolve();
                this._readyResolve = null;
            }
            throw err;
        } finally {
            this._bootstrapping = false;
        }
    }

    // ════════════════════════════════════════════════════════════
    // Private — 帧循环
    // ════════════════════════════════════════════════════════════

    /**
     * 启动 requestAnimationFrame 帧循环。
     *
     * @example
     * this._startFrameLoop();
     */
    private _startFrameLoop(): void {
        this._lastFrameTime = performance.now();

        const loop = (now: number) => {
            if (this._destroyed) { return; }

            // 请求下一帧（确保即使当前帧出错也能继续）
            this._rafId = requestAnimationFrame(loop);

            try {
                // 计算 deltaTime
                const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
                this._lastFrameTime = now;

                // 推进仿真时钟
                this._dateTime = new Date(
                    this._dateTime.getTime() + dt * 1000 * this._clockMultiplier,
                );

                // 渲染一帧
                this._renderFrame(dt);
            } catch (err) {
                devError('[Globe3D] frame error:', err);
            }
        };

        this._rafId = requestAnimationFrame(loop);
    }

    /**
     * 渲染单帧：更新相机 → 计算可见瓦片 → 提交 GPU 命令。
     *
     * @param dt - 帧间隔（秒）
     *
     * @example
     * this._renderFrame(0.016); // ~60fps
     */
    private _renderFrame(dt: number): void {
        const device = this._gpuRefs.device;
        const ctx = this._gpuRefs.gpuContext;

        // GPU 未初始化则跳过
        if (!device || !ctx) { return; }

        const frameStart = performance.now();

        // ── 每帧刷新 Canvas 尺寸（容器可能因布局变化而改变大小） ──
        // 同时更新 viewport，保证投影矩阵 aspect 与实际渲染目标一致
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // ── 更新相机 ──
        const camState = this._camera3D.update(dt, this._viewport);
        this._lastCamState = camState;

        // ── 计算 Globe 相机（自定义投影） ──
        const globeCam = computeGlobeCamera(this._camera3D, camState, this._viewport);

        // 缓存 GlobeCamera 供异步查询（pickGlobe / _readDepthAtPixel）
        this._lastGlobeCam = globeCam;

        // ── 获取 surface texture ──
        let surfaceTexture: GPUTexture;
        try {
            surfaceTexture = ctx.getCurrentTexture();
        } catch {
            // 上下文可能已丢失
            return;
        }

        const targetView = surfaceTexture.createView();

        // ── 确保深度纹理尺寸匹配 ──
        ensureGlobeDepthTexture(device, surfaceTexture.width, surfaceTexture.height, this._gpuRefs);
        const depthView = this._gpuRefs.depthTexture!.createView();

        // ── 计算可见瓦片 ──
        let tiles = coveringTilesGlobe(globeCam);
        // coveringTilesGlobe 依赖 screenToGlobe 射线-椭球面求交。
        // 高空（altitude > 地球半径）时，viewport 边缘可能全部指向太空（pitch=-90 正俯视），
        // 导致所有采样点未命中椭球面 → tiles=[]。此时手动生成 zoom-0 全部瓦片作为兜底。
        if (tiles.length === 0) {
            const fallbackZoom = Math.max(0, Math.floor(globeCam.zoom));
            const numFallback = 1 << fallbackZoom;
            tiles = [];
            for (let y = 0; y < numFallback; y++) {
                for (let x = 0; x < numFallback; x++) {
                    tiles.push({
                        z: fallbackZoom,
                        x,
                        y,
                        key: `${fallbackZoom}/${x}/${y}`,
                        distToCamera: 0,
                    });
                }
            }
        }

        // ── 更新相机 uniforms ──
        updateGlobeCameraUniforms(device, globeCam, this._gpuRefs, this._dateTime);

        // ── EggShape 一次性诊断（仅首帧 + DEV 模式）──
        if (typeof __DEV__ !== 'undefined' && __DEV__ && this._frameCount === 0) {
            runEggShapeDiagnostic(camState, globeCam, ctx, this._viewport);
        }

        // ── 创建命令编码器 ──
        const encoder = device.createCommandEncoder({ label: 'Globe3D:frame' });

        // ── 开始渲染通道 ──
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                clearValue: { r: CLEAR_R, g: CLEAR_G, b: CLEAR_B, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: DEPTH_CLEAR_VALUE,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
            label: 'Globe3D:mainPass',
        });

        let drawCalls = 0;
        let tilesRendered = 0;

        // ── 1. 天穹（背景） ──
        if (this._skybox) {
            renderSkyDome(device, pass, globeCam, this._gpuRefs);
            drawCalls++;
        }

        const tileResult = renderGlobeTiles(
            device,
            pass,
            globeCam,
            tiles,
            this._gpuRefs,
            this._tileState,
            () => this._destroyed,
        );
        tilesRendered = tileResult.tilesRendered;
        drawCalls += tileResult.drawCalls;

        if (this._atmosphere) {
            renderAtmosphere(device, pass, globeCam, this._gpuRefs);
            drawCalls++;
        }

        // ── 结束渲染通道并提交 ──
        pass.end();
        device.queue.submit([encoder.finish()]);

        // ── 更新统计 ──
        this._statsTilesRendered = tilesRendered;
        this._statsDrawCalls = drawCalls;
        this._statsFrameTimeMs = performance.now() - frameStart;
        this._frameCount++;
    }

    // 相机矩阵、天穹/瓦片/大气绘制、瓦片加载与 LRU 已迁至 globe-camera / globe-render / globe-tiles 模块。

    // ════════════════════════════════════════════════════════════
    // Private — 交互安装（处理器由 createGlobeMouseHandlers 生成）
    // ════════════════════════════════════════════════════════════

    /**
     * 安装所有鼠标/滚轮交互监听器。
     *
     * @example
     * this._installInteractions();
     */
    private _installInteractions(): void {
        // mousedown 在 Canvas 上监听
        this._canvas.addEventListener('mousedown', this._boundMouseDown);

        // mousemove/mouseup 在 window 上监听（拖拽可能溢出 Canvas）
        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('mouseup', this._boundMouseUp);

        // 滚轮缩放
        this._canvas.addEventListener('wheel', this._boundWheel, { passive: false });

        // 禁止右键菜单
        this._canvas.addEventListener('contextmenu', this._boundContextMenu);
    }

    // morph 逻辑见 globe-interaction.runMorph；此处无单独私有方法块。

    // ════════════════════════════════════════════════════════════
    // Private — 验证和安全
    // ════════════════════════════════════════════════════════════

    /**
     * 检查实例是否已被销毁，销毁后抛出错误。
     *
     * @throws {GeoForgeError} 实例已销毁时抛出 MAP_DESTROYED
     *
     * @example
     * this._ensureAlive();
     */
    private _ensureAlive(): void {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.MAP_DESTROYED,
                'Globe3D instance has been destroyed. Cannot perform operations on a removed instance.',
            );
        }
    }

    /**
     * 验证数值为非负有限数。
     *
     * @param v - 待验证数值
     * @param label - 参数名称（用于错误消息）
     * @throws {GeoForgeError} 无效值时抛出 CONFIG_INVALID_VIEW
     *
     * @example
     * this._validatePositive(exaggeration, 'terrainExaggeration');
     */
    private _validatePositive(v: number, label: string): void {
        if (!Number.isFinite(v) || v < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                `${label} must be a non-negative finite number, got: ${v}`,
                { value: v },
            );
        }
    }

    /**
     * 发射事件到所有注册的监听器。
     *
     * @param type - 事件类型
     * @param payload - 事件数据
     *
     * @example
     * this._emit('load', undefined);
     */
    private _emit(type: string, payload: unknown): void {
        const set = this._listeners.get(type);
        if (!set || set.size === 0) { return; }

        // 遍历监听器并安全调用
        for (const cb of set) {
            try {
                cb(payload);
            } catch (err) {
                devError(`[Globe3D] Event handler error for "${type}":`, err);
            }
        }
    }

    /**
     * 销毁所有 GPU 资源。
     */
    private _destroyGPUResources(): void {
        clearTileCache(this._tileState);
        clearMeshCache(this._tileState.meshCache);
        destroyGlobeGPUResources(this._gpuRefs);
    }
}
