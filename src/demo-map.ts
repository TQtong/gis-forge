// ============================================================
// GeoForge MVP Demo — 交互式地图查看器
// 使用 Camera2D 管理视图状态，Canvas 2D 渲染 OSM 栅格瓦片。
// 验证 P0 相机包 + 图层包的核心逻辑。
// ============================================================

import { createCamera2D } from '../packages/camera-2d/src/Camera2D.ts';
import type { Camera2D } from '../packages/camera-2d/src/Camera2D.ts';
import type { CameraState, Viewport } from '../packages/core/src/types/viewport.ts';
import {
    TILE_SIZE,
    lngLatToTile,
    tileToBBox,
    lngLatToPixel,
    pixelToLngLat,
    EARTH_CIRCUMFERENCE,
} from '../packages/core/src/geo/mercator.ts';

// ============================================================
// 常量定义
// ============================================================

/** OSM 瓦片服务器 URL 模板（{s} = a/b/c 子域名均衡负载） */
const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** 瓦片图片缓存上限（超过后淘汰最旧的） */
const MAX_TILE_CACHE = 512;

/** 最大允许缩放级别（OSM 最高 19） */
const MAX_TILE_ZOOM = 19;

/** 最小视口尺寸（防止零尺寸） */
const MIN_VIEWPORT_DIM = 1;

/** 调试信息面板更新间隔（毫秒） */
const DEBUG_UPDATE_INTERVAL_MS = 200;

/** Canvas 2D 渲染用的默认瓦片尺寸 */
const RENDER_TILE_SIZE = 256;

// ============================================================
// 瓦片缓存（LRU 淘汰）
// ============================================================

/**
 * 缓存的瓦片图片。
 * key 格式为 "z/x/y"，value 为 HTMLImageElement。
 */
const tileCache: Map<string, HTMLImageElement> = new Map();

/**
 * 正在加载中的瓦片集合，防止重复请求。
 */
const tileLoading: Set<string> = new Set();

/**
 * 生成瓦片缓存键。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns "z/x/y" 格式的字符串键
 */
function tileKey(x: number, y: number, z: number): string {
    return `${z}/${x}/${y}`;
}

/**
 * 获取瓦片图片 URL。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns 完整的瓦片 URL
 */
function tileUrl(x: number, y: number, z: number): string {
    return TILE_URL_TEMPLATE
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
}

/**
 * 异步加载瓦片图片，加载完成后存入缓存并触发重绘。
 * 使用 LRU 策略淘汰超量缓存。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @param onLoaded - 加载完成回调（用于触发重绘）
 */
function loadTile(
    x: number,
    y: number,
    z: number,
    onLoaded: () => void,
): void {
    const key = tileKey(x, y, z);

    // 已缓存或正在加载，跳过
    if (tileCache.has(key) || tileLoading.has(key)) {
        return;
    }

    // 标记为加载中
    tileLoading.add(key);

    const img = new Image();
    // 设置 crossOrigin 以允许 Canvas 读取像素（即使不需要，也避免 tainted 画布）
    img.crossOrigin = 'anonymous';

    img.onload = () => {
        tileLoading.delete(key);

        // LRU 淘汰：如果缓存已满，删除最早加入的条目
        if (tileCache.size >= MAX_TILE_CACHE) {
            const oldest = tileCache.keys().next().value;
            if (oldest !== undefined) {
                tileCache.delete(oldest);
            }
        }

        tileCache.set(key, img);
        // 通知外部重绘
        onLoaded();
    };

    img.onerror = () => {
        tileLoading.delete(key);
        // 加载失败静默忽略（OSM 服务器偶尔返回 404/503）
    };

    img.src = tileUrl(x, y, z);
}

// ============================================================
// 可见瓦片计算
// ============================================================

/**
 * 计算当前视口可见的瓦片范围。
 * 基于相机中心和缩放级别，计算覆盖视口的瓦片 x/y 范围。
 *
 * @param centerLon - 中心经度（度）
 * @param centerLat - 中心纬度（度）
 * @param zoom - 缩放级别（取整）
 * @param viewportWidth - 视口宽度（CSS 像素）
 * @param viewportHeight - 视口高度（CSS 像素）
 * @returns 可见瓦片范围 { xMin, xMax, yMin, yMax, z }
 */
function getVisibleTileRange(
    centerLon: number,
    centerLat: number,
    zoom: number,
    viewportWidth: number,
    viewportHeight: number,
): { xMin: number; xMax: number; yMin: number; yMax: number; z: number } {
    // 取整缩放级别用于瓦片坐标（连续缩放通过缩放瓦片图片实现）
    const z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(zoom)));
    const tileCount = Math.pow(2, z);

    // 世界像素尺寸 = TILE_SIZE * 2^z，但渲染用 256px 瓦片
    const worldSize = RENDER_TILE_SIZE * tileCount;

    // 计算中心点的世界像素坐标
    const _px = new Float64Array(2);
    lngLatToPixel(_px, centerLon, centerLat, z);
    // lngLatToPixel 使用 TILE_SIZE=512 基准，需要缩放到 256
    const centerPxX = _px[0] * (RENDER_TILE_SIZE / TILE_SIZE);
    const centerPxY = _px[1] * (RENDER_TILE_SIZE / TILE_SIZE);

    // 连续缩放的缩放因子：zoom 的小数部分对应的缩放比例
    const fracZoom = zoom - z;
    const scale = Math.pow(2, fracZoom);

    // 视口覆盖的世界像素半宽/半高（除以缩放因子）
    const halfViewPxX = viewportWidth / 2 / scale;
    const halfViewPxY = viewportHeight / 2 / scale;

    // 视口左上角和右下角的瓦片坐标
    const xMin = Math.floor((centerPxX - halfViewPxX) / RENDER_TILE_SIZE);
    const xMax = Math.floor((centerPxX + halfViewPxX) / RENDER_TILE_SIZE);
    const yMin = Math.floor((centerPxY - halfViewPxY) / RENDER_TILE_SIZE);
    const yMax = Math.floor((centerPxY + halfViewPxY) / RENDER_TILE_SIZE);

    return {
        // 限制 y 范围在有效瓦片范围内
        xMin,
        xMax,
        yMin: Math.max(0, yMin),
        yMax: Math.min(tileCount - 1, yMax),
        z,
    };
}

// ============================================================
// 渲染逻辑
// ============================================================

/**
 * 在 Canvas 2D 上绘制所有可见瓦片。
 *
 * @param ctx - Canvas 2D 渲染上下文
 * @param camera - Camera2D 实例
 * @param vpWidth - 视口宽度
 * @param vpHeight - 视口高度
 */
function renderTiles(
    ctx: CanvasRenderingContext2D,
    camera: Camera2D,
    vpWidth: number,
    vpHeight: number,
): void {
    const state = camera.state;
    const centerLon = state.center[0];
    const centerLat = state.center[1];
    const zoom = state.zoom;

    // 清空画布（深蓝色背景，模拟海洋）
    ctx.fillStyle = '#191a2e';
    ctx.fillRect(0, 0, vpWidth, vpHeight);

    // 计算可见瓦片范围
    const range = getVisibleTileRange(centerLon, centerLat, zoom, vpWidth, vpHeight);
    const { z, xMin, xMax, yMin, yMax } = range;
    const tileCount = Math.pow(2, z);

    // 连续缩放的缩放因子
    const fracZoom = zoom - z;
    const scale = Math.pow(2, fracZoom);

    // 中心点的世界像素坐标（256px 基准）
    const _px = new Float64Array(2);
    lngLatToPixel(_px, centerLon, centerLat, z);
    const centerPxX = _px[0] * (RENDER_TILE_SIZE / TILE_SIZE);
    const centerPxY = _px[1] * (RENDER_TILE_SIZE / TILE_SIZE);

    // 视口中心在屏幕上的像素坐标
    const screenCenterX = vpWidth / 2;
    const screenCenterY = vpHeight / 2;

    // 记录加载和渲染的瓦片数
    let tilesRendered = 0;
    let tilesLoading = 0;

    // 遍历所有可见瓦片
    for (let ty = yMin; ty <= yMax; ty++) {
        for (let tx = xMin; tx <= xMax; tx++) {
            // 处理 X 方向的环绕（经度跨越 ±180°）
            const wrappedX = ((tx % tileCount) + tileCount) % tileCount;

            // 瓦片左上角的世界像素坐标
            const tilePxX = tx * RENDER_TILE_SIZE;
            const tilePxY = ty * RENDER_TILE_SIZE;

            // 瓦片在屏幕上的位置（相对于视口中心偏移 + 缩放）
            const screenX = screenCenterX + (tilePxX - centerPxX) * scale;
            const screenY = screenCenterY + (tilePxY - centerPxY) * scale;
            const tileScreenSize = RENDER_TILE_SIZE * scale;

            // 获取缓存的瓦片图片
            const key = tileKey(wrappedX, ty, z);
            const img = tileCache.get(key);

            if (img) {
                // 绘制瓦片图片
                ctx.drawImage(img, screenX, screenY, tileScreenSize, tileScreenSize);
                tilesRendered++;
            } else {
                // 瓦片未加载，显示占位背景
                ctx.fillStyle = '#1a2332';
                ctx.fillRect(screenX, screenY, tileScreenSize, tileScreenSize);

                // 绘制瓦片网格线
                ctx.strokeStyle = '#2a3a4a';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(screenX + 0.5, screenY + 0.5, tileScreenSize - 1, tileScreenSize - 1);

                // 显示瓦片坐标
                ctx.fillStyle = '#3a5a7a';
                ctx.font = '11px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(
                    `${z}/${wrappedX}/${ty}`,
                    screenX + tileScreenSize / 2,
                    screenY + tileScreenSize / 2,
                );

                // 触发异步加载
                loadTile(wrappedX, ty, z, requestRedraw);
                tilesLoading++;
            }
        }
    }

    // 更新统计信息
    updateDebugInfo(state, tilesRendered, tilesLoading, tileCache.size);
}

// ============================================================
// 调试信息面板
// ============================================================

/** 上次调试信息更新时间 */
let lastDebugUpdate = 0;

/** 帧率计数器 */
let frameCount = 0;
let lastFpsTime = 0;
let currentFps = 0;

/**
 * 更新调试信息面板。
 * 节流更新以避免过度 DOM 操作。
 *
 * @param state - 当前相机状态
 * @param rendered - 已渲染瓦片数
 * @param loading - 正在加载瓦片数
 * @param cached - 缓存瓦片数
 */
function updateDebugInfo(
    state: CameraState,
    rendered: number,
    loading: number,
    cached: number,
): void {
    const now = performance.now();
    if (now - lastDebugUpdate < DEBUG_UPDATE_INTERVAL_MS) {
        return;
    }
    lastDebugUpdate = now;

    const el = document.getElementById('debug-info');
    if (!el) {
        return;
    }

    el.innerHTML = `
        <div class="debug-row"><span>Center</span><span>${state.center[0].toFixed(4)}°, ${state.center[1].toFixed(4)}°</span></div>
        <div class="debug-row"><span>Zoom</span><span>${state.zoom.toFixed(2)}</span></div>
        <div class="debug-row"><span>Altitude</span><span>${formatDistance(state.altitude)}</span></div>
        <div class="debug-row"><span>FPS</span><span>${currentFps}</span></div>
        <div class="debug-row"><span>Tiles rendered</span><span>${rendered}</span></div>
        <div class="debug-row"><span>Tiles loading</span><span>${loading}</span></div>
        <div class="debug-row"><span>Tile cache</span><span>${cached} / ${MAX_TILE_CACHE}</span></div>
    `;
}

/**
 * 将距离格式化为可读字符串。
 *
 * @param meters - 距离（米）
 * @returns 格式化后的字符串
 */
function formatDistance(meters: number): string {
    if (meters >= 1000000) {
        return `${(meters / 1000000).toFixed(1)} Mm`;
    }
    if (meters >= 1000) {
        return `${(meters / 1000).toFixed(1)} km`;
    }
    return `${meters.toFixed(0)} m`;
}

// ============================================================
// 渲染循环
// ============================================================

/** 是否需要重绘 */
let needsRedraw = true;

/**
 * 请求重绘（可从瓦片加载回调等处调用）。
 */
function requestRedraw(): void {
    needsRedraw = true;
}

// ============================================================
// 主初始化
// ============================================================

/**
 * 初始化交互式地图查看器。
 * 创建 Camera2D、绑定 DOM 事件、启动渲染循环。
 */
function initMapViewer(): void {
    // ─── 获取 Canvas 元素 ───
    const canvas = document.getElementById('map-canvas') as HTMLCanvasElement | null;
    if (!canvas) {
        console.error('[demo-map] #map-canvas 元素不存在');
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error('[demo-map] 无法获取 Canvas 2D 上下文');
        return;
    }

    // ─── 调整 Canvas 尺寸为父容器尺寸 ───
    function resizeCanvas(): void {
        const parent = canvas!.parentElement;
        if (!parent) {
            return;
        }
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        const dpr = window.devicePixelRatio || 1;

        // 逻辑尺寸
        canvas!.style.width = `${w}px`;
        canvas!.style.height = `${h}px`;

        // 物理尺寸（高 DPI 支持）
        canvas!.width = Math.round(w * dpr);
        canvas!.height = Math.round(h * dpr);

        // 缩放 Canvas 上下文以匹配 DPR
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

        needsRedraw = true;
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // ─── 创建 Camera2D ───
    const camera = createCamera2D({
        center: [116.39, 39.91],  // 北京
        zoom: 4,
        minZoom: 1,
        maxZoom: MAX_TILE_ZOOM,
        inertia: true,
        inertiaDecay: 0.88,
    }) as Camera2D;

    // 相机移动时触发重绘
    camera.onMove(() => {
        needsRedraw = true;
    });
    camera.onMoveStart(() => {
        needsRedraw = true;
    });
    camera.onMoveEnd(() => {
        needsRedraw = true;
    });

    // ─── 绑定鼠标事件 ───
    let isPointerDown = false;

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) {
            return; // 仅左键
        }
        isPointerDown = true;
        canvas!.setPointerCapture(e.pointerId);
        camera.handlePanStart(e.offsetX, e.offsetY);
        needsRedraw = true;
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isPointerDown) {
            return;
        }
        camera.handlePanMove(e.offsetX, e.offsetY);
        needsRedraw = true;
    });

    canvas.addEventListener('pointerup', (e: PointerEvent) => {
        if (!isPointerDown) {
            return;
        }
        isPointerDown = false;
        canvas!.releasePointerCapture(e.pointerId);
        camera.handlePanEnd();
        needsRedraw = true;
    });

    canvas.addEventListener('pointercancel', () => {
        if (isPointerDown) {
            isPointerDown = false;
            camera.handlePanEnd();
            needsRedraw = true;
        }
    });

    // 滚轮缩放
    canvas.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        // deltaY > 0 = scroll down = zoom out，取反使其符合直觉
        const delta = -e.deltaY;
        // 缩放步长：每 100px 滚动量改变 1 zoom 级别
        const zoomDelta = delta / 100;
        camera.handleZoom(zoomDelta, e.offsetX, e.offsetY);
        needsRedraw = true;
    }, { passive: false });

    // 双击缩放
    canvas.addEventListener('dblclick', (e: MouseEvent) => {
        e.preventDefault();
        const targetZoom = Math.min(camera.state.zoom + 1, MAX_TILE_ZOOM);
        // 将双击位置转换为经纬度，然后 easeTo 到那个位置
        const lngLat = camera.screenToLngLat(e.offsetX, e.offsetY);
        if (lngLat) {
            camera.easeTo({
                center: lngLat,
                zoom: targetZoom,
                duration: 300,
            });
        }
        needsRedraw = true;
    });

    // 触摸事件阻止默认行为（防止 iOS 上的页面缩放）
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    // ─── 键盘控制 ───
    window.addEventListener('keydown', (e: KeyboardEvent) => {
        const step = 0.5;
        switch (e.key) {
            case '+':
            case '=':
                camera.setZoom(camera.state.zoom + step);
                needsRedraw = true;
                break;
            case '-':
            case '_':
                camera.setZoom(camera.state.zoom - step);
                needsRedraw = true;
                break;
        }
    });

    // ─── 快速导航按钮 ───
    setupNavigationButtons(camera);

    // ─── 渲染循环 ───
    let lastTime = performance.now();

    function frame(nowMs: number): void {
        const dt = Math.min((nowMs - lastTime) / 1000, 0.1); // 秒，上限 100ms
        lastTime = nowMs;

        // 计算 FPS
        frameCount++;
        if (nowMs - lastFpsTime >= 1000) {
            currentFps = frameCount;
            frameCount = 0;
            lastFpsTime = nowMs;
        }

        // 获取逻辑视口尺寸
        const vpW = canvas!.clientWidth;
        const vpH = canvas!.clientHeight;
        const dpr = window.devicePixelRatio || 1;

        // 构造 Viewport 对象
        const viewport: Viewport = {
            width: vpW,
            height: vpH,
            physicalWidth: Math.round(vpW * dpr),
            physicalHeight: Math.round(vpH * dpr),
            pixelRatio: dpr,
        };

        // 每帧更新相机（惯性衰减、动画推进、矩阵重算）
        camera.update(dt, viewport);

        // 相机正在运动时持续重绘
        if (camera.isMoving || camera.isAnimating) {
            needsRedraw = true;
        }

        // 仅在需要时渲染
        if (needsRedraw) {
            needsRedraw = false;
            renderTiles(ctx!, camera, vpW, vpH);
        }

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    console.log('[GeoForge MVP] 交互式地图查看器已启动');
    console.log('[GeoForge MVP] 拖拽平移 | 滚轮缩放 | 双击放大 | +/- 键缩放');
}

// ============================================================
// 导航按钮
// ============================================================

/**
 * 设置快速导航按钮（预设城市位置）。
 *
 * @param camera - Camera2D 实例
 */
function setupNavigationButtons(camera: Camera2D): void {
    const locations: Array<{ name: string; lon: number; lat: number; zoom: number }> = [
        { name: 'Beijing', lon: 116.39, lat: 39.91, zoom: 11 },
        { name: 'Tokyo', lon: 139.69, lat: 35.69, zoom: 11 },
        { name: 'New York', lon: -74.00, lat: 40.71, zoom: 11 },
        { name: 'London', lon: -0.12, lat: 51.51, zoom: 11 },
        { name: 'Sydney', lon: 151.21, lat: -33.87, zoom: 11 },
        { name: 'World', lon: 0, lat: 20, zoom: 2 },
    ];

    const container = document.getElementById('nav-buttons');
    if (!container) {
        return;
    }

    for (const loc of locations) {
        const btn = document.createElement('button');
        btn.className = 'nav-btn';
        btn.textContent = loc.name;
        btn.addEventListener('click', () => {
            camera.flyTo({
                center: [loc.lon, loc.lat],
                zoom: loc.zoom,
                duration: 2000,
            });
            needsRedraw = true;
        });
        container.appendChild(btn);
    }
}

// ============================================================
// 入口
// ============================================================

// DOM 就绪后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMapViewer);
} else {
    initMapViewer();
}
