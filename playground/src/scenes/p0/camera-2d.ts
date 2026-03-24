// ============================================================
// playground/src/scenes/p0/camera-2d.ts
// Camera2D 全功能测试场景。
// 创建 Canvas、初始化 Camera2D 实例、加载并渲染 OSM 栅格瓦片、
// 绑定鼠标/滚轮交互事件，支持惯性平移和锚点缩放。
//
// 这是一个完全独立可运行的场景——不依赖 GeoForge 渲染管线，
// 直接使用 Canvas 2D Context + OSM 瓦片 + Camera2D 控制器。
// ============================================================

import type { SceneConfig } from '../../types';
import { createCamera2D } from '../../../../packages/camera-2d/src/Camera2D';
import type { Camera2D } from '../../../../packages/camera-2d/src/Camera2D';
import { OSM_TILE_URL, CITIES, DEFAULT_CENTER, DEFAULT_ZOOM } from '../../utils/sampleData';

// ============================================================
// 常量
// ============================================================

/**
 * OSM 瓦片标准尺寸（像素）。
 * OpenStreetMap 使用 256×256 PNG 瓦片。
 * 注意：GeoForge 内部使用 512×512 瓦片，此处为 OSM 专用。
 */
const OSM_TILE_SIZE: number = 256;

/**
 * 瓦片缓存最大容量。
 * 超出时按 FIFO 策略淘汰最早插入的瓦片。
 * 200 张 256×256 瓦片约占 50MB 内存（未压缩 RGBA）。
 */
const TILE_CACHE_MAX: number = 200;

/**
 * 并发加载请求上限。
 * 浏览器对同一域名限制 6 个并发连接，设为 6 匹配限制。
 */
const MAX_CONCURRENT_LOADS: number = 6;

/**
 * 瓦片加载超时（毫秒）。
 * 超时后 Image.onerror 触发，瓦片标记为失败。
 */
const TILE_LOAD_TIMEOUT_MS: number = 10000;

/**
 * HUD 信息更新间隔（毫秒）。
 * 60fps 下每帧更新 HUD 太频繁，100ms 间隔足够。
 */
const HUD_UPDATE_INTERVAL_MS: number = 100;

/**
 * 缩放灵敏度系数。
 * 将 wheel deltaY（通常 ±100/±120）转换为 zoom 级别变化量。
 * 0.01 使每 100px 滚动约 ±1 zoom 级别。
 */
const ZOOM_SENSITIVITY: number = 0.01;

/**
 * 最小 zoom 级别限制（OSM 瓦片从 z=0 开始）。
 */
const MIN_ZOOM: number = 1;

/**
 * 最大 zoom 级别限制（OSM 瓦片最高 z=19）。
 */
const MAX_ZOOM: number = 19;

// ============================================================
// 模块级可变状态 — 场景生命周期内持有
// ============================================================

/** Camera2D 实例引用 */
let camera: Camera2D | null = null;

/** Canvas 2D 渲染上下文 */
let ctx: CanvasRenderingContext2D | null = null;

/** Canvas DOM 元素 */
let canvasEl: HTMLCanvasElement | null = null;

/** 容器 DOM 元素引用（onLeave 时用于清理） */
let containerRef: HTMLDivElement | null = null;

/** HUD 覆盖层 DOM 元素 */
let hudEl: HTMLDivElement | null = null;

/** requestAnimationFrame ID（用于取消帧循环） */
let rafId: number = 0;

/** 上一帧时间戳（ms），用于计算 deltaTime */
let lastFrameTime: number = 0;

/** FPS 计算用：最近一秒内的帧数累计 */
let frameCount: number = 0;

/** FPS 计算用：上一次 FPS 采样时间 */
let lastFpsSampleTime: number = 0;

/** 当前 FPS 值（每秒更新一次） */
let currentFps: number = 0;

/** HUD 上次更新时间 */
let lastHudUpdate: number = 0;

/** ResizeObserver 实例（监听容器尺寸变化） */
let resizeObserver: ResizeObserver | null = null;

/** 当前是否正在平移（PointerDown 到 PointerUp 之间） */
let isPointerDown: boolean = false;

/** pointerId，用于 pointer capture */
let activePointerId: number = -1;

// ============================================================
// 瓦片缓存
// ============================================================

/**
 * 单张瓦片的缓存条目。
 * 生命周期：pending → loaded/error。
 */
interface TileCacheEntry {
  /** 瓦片唯一键 'z/x/y' */
  readonly key: string;
  /** 加载状态 */
  state: 'pending' | 'loaded' | 'error';
  /** 加载完成的 Image 对象（state='loaded' 时有效） */
  image: HTMLImageElement | null;
}

/** 瓦片缓存映射表：key='z/x/y' → 缓存条目 */
const tileCache: Map<string, TileCacheEntry> = new Map();

/** 插入顺序键队列（FIFO 淘汰用） */
const tileCacheOrder: string[] = [];

/** 当前正在加载的瓦片数量 */
let activeLoads: number = 0;

/** 待加载队列（优先级靠后的在数组末尾） */
const loadQueue: string[] = [];

// ============================================================
// 瓦片加载与缓存管理
// ============================================================

/**
 * 获取瓦片缓存键。
 *
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns 'z/x/y' 格式的唯一键
 */
function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * 构建 OSM 瓦片 URL。
 * 将模板中的 {z}/{x}/{y} 替换为实际坐标。
 *
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns 完整的瓦片图片 URL
 */
function buildTileUrl(z: number, x: number, y: number): string {
  return OSM_TILE_URL
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * 请求加载一张瓦片。
 * 若已在缓存中则跳过；否则创建 Image 对象发起加载。
 * 遵守并发上限：超出时放入队列等待。
 *
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 */
function requestTile(z: number, x: number, y: number): void {
  const key = tileKey(z, x, y);

  // 已在缓存中（无论 pending/loaded/error）则跳过
  if (tileCache.has(key)) {
    return;
  }

  // 创建 pending 条目
  const entry: TileCacheEntry = {
    key,
    state: 'pending',
    image: null,
  };
  tileCache.set(key, entry);

  // FIFO 淘汰：缓存超容量时移除最旧的条目
  tileCacheOrder.push(key);
  while (tileCacheOrder.length > TILE_CACHE_MAX) {
    const oldKey = tileCacheOrder.shift();
    if (oldKey) {
      tileCache.delete(oldKey);
    }
  }

  // 尝试立即加载，否则入队
  if (activeLoads < MAX_CONCURRENT_LOADS) {
    startLoad(key, z, x, y);
  } else {
    loadQueue.push(key);
  }
}

/**
 * 开始加载一张瓦片图片。
 * 创建 Image 对象，设置 crossOrigin 以支持 Canvas 2D 绘制。
 *
 * @param key - 缓存键
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 */
function startLoad(key: string, z: number, x: number, y: number): void {
  activeLoads++;

  const img = new Image();
  // 允许跨域加载，否则 Canvas 2D drawImage 会污染画布
  img.crossOrigin = 'anonymous';

  // 超时处理：img.src 设置后开始计时
  const timeoutId = window.setTimeout(() => {
    const entry = tileCache.get(key);
    if (entry && entry.state === 'pending') {
      entry.state = 'error';
      activeLoads = Math.max(0, activeLoads - 1);
      processQueue();
    }
  }, TILE_LOAD_TIMEOUT_MS);

  img.onload = () => {
    window.clearTimeout(timeoutId);
    const entry = tileCache.get(key);
    if (entry) {
      entry.state = 'loaded';
      entry.image = img;
    }
    activeLoads = Math.max(0, activeLoads - 1);
    processQueue();
  };

  img.onerror = () => {
    window.clearTimeout(timeoutId);
    const entry = tileCache.get(key);
    if (entry) {
      entry.state = 'error';
    }
    activeLoads = Math.max(0, activeLoads - 1);
    processQueue();
  };

  // 触发加载
  img.src = buildTileUrl(z, x, y);
}

/**
 * 处理加载队列：从队列头部取出待加载项并发起请求。
 * 在每次加载完成（成功或失败）后调用。
 */
function processQueue(): void {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const key = loadQueue.shift()!;
    // 检查该条目是否仍存在（可能已被 FIFO 淘汰）
    const entry = tileCache.get(key);
    if (!entry || entry.state !== 'pending') {
      continue;
    }
    // 从 key 解析 z/x/y
    const parts = key.split('/');
    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (Number.isFinite(z) && Number.isFinite(x) && Number.isFinite(y)) {
      startLoad(key, z, x, y);
    }
  }
}

/**
 * 清空瓦片缓存和加载队列。
 * 在场景离开时调用，释放所有 Image 对象引用。
 */
function clearTileCache(): void {
  tileCache.clear();
  tileCacheOrder.length = 0;
  loadQueue.length = 0;
  activeLoads = 0;
}

// ============================================================
// 渲染
// ============================================================

/**
 * 计算当前视口内可见的瓦片范围，并渲染到 Canvas 2D。
 *
 * 算法流程：
 * 1. 从 Camera2D 获取当前 center / zoom
 * 2. 计算中心在 Mercator 像素坐标系中的位置
 * 3. 推导视口四角在瓦片网格中的行列范围
 * 4. 遍历可见瓦片：已加载的绘制 Image，未加载的发起请求
 *
 * Mercator 像素坐标系（OSM 256 瓦片）：
 *   worldSize = 256 × 2^zoom
 *   pixelX = (lon + 180) / 360 × worldSize
 *   pixelY = (1 - ln(tan(lat) + sec(lat)) / π) / 2 × worldSize
 */
function renderFrame(): void {
  if (!ctx || !canvasEl || !camera) {
    return;
  }

  const width = canvasEl.width;
  const height = canvasEl.height;

  // 清除上一帧
  ctx.clearRect(0, 0, width, height);

  // 绘制深色背景（与主题一致）
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  // 从 camera state 获取当前视图参数
  const state = camera.state;
  const centerLon = state.center[0];
  const centerLat = state.center[1];
  const zoom = state.zoom;

  // 计算整数瓦片层级（OSM 只有整数 zoom 的瓦片）
  const tileZoom = Math.floor(zoom);
  // 限制在 OSM 有效范围内
  const clampedTileZoom = Math.max(0, Math.min(MAX_ZOOM, tileZoom));

  // 世界像素总尺寸（OSM 256 瓦片体系）
  const worldSize = OSM_TILE_SIZE * Math.pow(2, zoom);

  // 中心点在世界像素空间的坐标
  const centerPxX = ((centerLon + 180) / 360) * worldSize;
  const latRad = (centerLat * Math.PI) / 180;
  const centerPxY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * worldSize;

  // 视口半尺寸
  const halfW = width / 2;
  const halfH = height / 2;

  // 视口左上角在世界像素空间的坐标
  const viewLeftPx = centerPxX - halfW;
  const viewTopPx = centerPxY - halfH;

  // 瓦片在当前连续 zoom 下的屏幕尺寸
  // 整数 zoom 时 = OSM_TILE_SIZE，分数 zoom 时按比例缩放
  const tileScreenSize = OSM_TILE_SIZE * Math.pow(2, zoom - clampedTileZoom);

  // 当前整数 zoom 下的世界像素总尺寸
  const tileWorldSize = OSM_TILE_SIZE * Math.pow(2, clampedTileZoom);

  // 视口左上角在整数 zoom 坐标系中的像素坐标
  // 通过缩放比例从连续 zoom 转换到整数 zoom
  const scaleFactor = tileWorldSize / worldSize;
  const tileViewLeftPx = viewLeftPx * scaleFactor;
  const tileViewTopPx = viewTopPx * scaleFactor;

  // 可见瓦片的行列范围
  const maxTileIndex = Math.pow(2, clampedTileZoom) - 1;
  const startCol = Math.floor(tileViewLeftPx / OSM_TILE_SIZE);
  const endCol = Math.floor((tileViewLeftPx + width * scaleFactor) / OSM_TILE_SIZE);
  const startRow = Math.max(0, Math.floor(tileViewTopPx / OSM_TILE_SIZE));
  const endRow = Math.min(maxTileIndex, Math.floor((tileViewTopPx + height * scaleFactor) / OSM_TILE_SIZE));

  // 遍历可见瓦片并绘制
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      // 处理 X 方向的世界环绕（经度 ±180° 连续）
      let wrappedCol = col % (maxTileIndex + 1);
      if (wrappedCol < 0) {
        wrappedCol += maxTileIndex + 1;
      }

      // 瓦片在整数 zoom 像素坐标系中的左上角
      const tilePxX = col * OSM_TILE_SIZE;
      const tilePxY = row * OSM_TILE_SIZE;

      // 转换到屏幕坐标：从整数 zoom 像素空间映射到视口
      const screenX = (tilePxX - tileViewLeftPx) / scaleFactor;
      const screenY = (tilePxY - tileViewTopPx) / scaleFactor;

      const key = tileKey(clampedTileZoom, wrappedCol, row);
      const entry = tileCache.get(key);

      if (entry && entry.state === 'loaded' && entry.image) {
        // 绘制已加载的瓦片图片
        // +1 像素 oversize 消除瓦片间的细缝（浮点像素对齐误差）
        ctx.drawImage(
          entry.image,
          Math.round(screenX),
          Math.round(screenY),
          Math.ceil(tileScreenSize) + 1,
          Math.ceil(tileScreenSize) + 1,
        );
      } else {
        // 绘制占位符：深色背景 + 边框 + 坐标文字
        ctx.fillStyle = '#0f1a2e';
        ctx.fillRect(
          Math.round(screenX),
          Math.round(screenY),
          Math.ceil(tileScreenSize),
          Math.ceil(tileScreenSize),
        );
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          Math.round(screenX) + 0.5,
          Math.round(screenY) + 0.5,
          Math.ceil(tileScreenSize) - 1,
          Math.ceil(tileScreenSize) - 1,
        );

        // 在占位符中心绘制瓦片坐标
        if (tileScreenSize > 60) {
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.font = '11px JetBrains Mono, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            `${clampedTileZoom}/${wrappedCol}/${row}`,
            Math.round(screenX + tileScreenSize / 2),
            Math.round(screenY + tileScreenSize / 2),
          );
        }

        // 发起瓦片加载请求
        requestTile(clampedTileZoom, wrappedCol, row);
      }
    }
  }

  // 绘制中心十字准星
  ctx.strokeStyle = 'rgba(83, 168, 182, 0.6)';
  ctx.lineWidth = 1;
  const crossSize = 12;
  ctx.beginPath();
  ctx.moveTo(halfW - crossSize, halfH);
  ctx.lineTo(halfW + crossSize, halfH);
  ctx.moveTo(halfW, halfH - crossSize);
  ctx.lineTo(halfW, halfH + crossSize);
  ctx.stroke();
}

// ============================================================
// HUD（信息叠加层）
// ============================================================

/**
 * 更新 HUD 覆盖层的文字内容。
 * 显示当前坐标、缩放、FPS 和相机运动状态。
 *
 * @param now - 当前时间戳（ms）
 */
function updateHud(now: number): void {
  if (!hudEl || !camera) {
    return;
  }

  // 节流：每 HUD_UPDATE_INTERVAL_MS 更新一次
  if (now - lastHudUpdate < HUD_UPDATE_INTERVAL_MS) {
    return;
  }
  lastHudUpdate = now;

  const state = camera.state;
  const lon = state.center[0].toFixed(4);
  const lat = state.center[1].toFixed(4);
  const z = state.zoom.toFixed(2);
  const alt = (state.altitude / 1000).toFixed(1);

  // 运动状态指示符
  let statusIcon = '⏸';
  if (camera.isPanning) {
    statusIcon = '✋';
  } else if (camera.isInertiaActive) {
    statusIcon = '💨';
  } else if (camera.isAnimating) {
    statusIcon = '✈️';
  }

  hudEl.innerHTML =
    `<span>${lon}, ${lat}</span>` +
    `<span style="margin-left:8px;">Z ${z}</span>` +
    `<span style="margin-left:8px;">Alt ${alt}km</span>` +
    `<span style="margin-left:8px;">${currentFps} FPS</span>` +
    `<span style="margin-left:8px;">${statusIcon}</span>`;
}

// ============================================================
// 帧循环
// ============================================================

/**
 * requestAnimationFrame 回调：推进相机、渲染瓦片、更新 HUD。
 *
 * @param timestamp - 浏览器提供的高精度时间戳（ms）
 */
function frameLoop(timestamp: number): void {
  // 计算帧间隔（秒）
  const dtMs = lastFrameTime > 0 ? timestamp - lastFrameTime : 16.67;
  lastFrameTime = timestamp;
  const dt = Math.min(dtMs / 1000, 0.1); // 上限 100ms 防止大幅跳帧

  // FPS 采样
  frameCount++;
  if (timestamp - lastFpsSampleTime >= 1000) {
    currentFps = frameCount;
    frameCount = 0;
    lastFpsSampleTime = timestamp;
  }

  // 推进 Camera2D（惯性衰减 + 动画插值 + 矩阵重建）
  if (camera && canvasEl) {
    camera.update(dt, {
      width: canvasEl.width,
      height: canvasEl.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  // 渲染瓦片
  renderFrame();

  // 更新 HUD
  updateHud(timestamp);

  // 请求下一帧
  rafId = requestAnimationFrame(frameLoop);
}

// ============================================================
// 事件处理器
// ============================================================

/**
 * PointerDown 处理：开始平移手势。
 * 使用 Pointer Events API（统一处理鼠标/触摸/手写笔）。
 */
function onPointerDown(e: PointerEvent): void {
  if (!camera || !canvasEl) {
    return;
  }
  // 仅响应主按钮（左键/单指）
  if (e.button !== 0) {
    return;
  }

  isPointerDown = true;
  activePointerId = e.pointerId;

  // 捕获指针：即使光标移出 Canvas 也继续接收事件
  canvasEl.setPointerCapture(e.pointerId);

  // 计算相对于 Canvas 的坐标
  const rect = canvasEl.getBoundingClientRect();
  camera.handlePanStart(e.clientX - rect.left, e.clientY - rect.top);

  e.preventDefault();
}

/**
 * PointerMove 处理：平移手势移动。
 */
function onPointerMove(e: PointerEvent): void {
  if (!camera || !canvasEl || !isPointerDown) {
    return;
  }
  if (e.pointerId !== activePointerId) {
    return;
  }

  const rect = canvasEl.getBoundingClientRect();
  camera.handlePanMove(e.clientX - rect.left, e.clientY - rect.top);

  e.preventDefault();
}

/**
 * PointerUp 处理：结束平移手势，触发惯性。
 */
function onPointerUp(e: PointerEvent): void {
  if (!camera || !canvasEl) {
    return;
  }
  if (e.pointerId !== activePointerId) {
    return;
  }

  isPointerDown = false;
  activePointerId = -1;

  // 释放指针捕获
  try {
    canvasEl.releasePointerCapture(e.pointerId);
  } catch {
    // 某些浏览器在指针已释放时会抛出 InvalidStateError
  }

  camera.handlePanEnd();

  e.preventDefault();
}

/**
 * Wheel 处理：锚点缩放。
 * deltaY > 0 = 缩小（zoom 减少），deltaY < 0 = 放大（zoom 增加）。
 */
function onWheel(e: WheelEvent): void {
  if (!camera || !canvasEl) {
    return;
  }

  // 阻止页面滚动
  e.preventDefault();

  const rect = canvasEl.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // 负号：浏览器 deltaY 正值 = 向下滚 = 缩小 = zoom 减少
  const delta = -e.deltaY * ZOOM_SENSITIVITY;

  camera.handleZoom(delta, screenX, screenY);
}

/**
 * 双击处理：在双击位置放大一级。
 */
function onDblClick(e: MouseEvent): void {
  if (!camera || !canvasEl) {
    return;
  }

  e.preventDefault();

  const rect = canvasEl.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // 双击放大 1 级
  camera.handleZoom(1, screenX, screenY);
}

// ============================================================
// Canvas 尺寸管理
// ============================================================

/**
 * 同步 Canvas 的像素尺寸与容器 CSS 尺寸。
 * 考虑 devicePixelRatio 以支持 HiDPI 屏幕。
 * 使用 ResizeObserver 在容器尺寸变化时自动调用。
 */
function syncCanvasSize(): void {
  if (!canvasEl || !containerRef) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = containerRef.getBoundingClientRect();
  const displayWidth = Math.round(rect.width);
  const displayHeight = Math.round(rect.height);

  // 仅在尺寸实际变化时更新，避免不必要的重绘
  if (canvasEl.width !== displayWidth * dpr || canvasEl.height !== displayHeight * dpr) {
    canvasEl.width = displayWidth * dpr;
    canvasEl.height = displayHeight * dpr;
    canvasEl.style.width = `${displayWidth}px`;
    canvasEl.style.height = `${displayHeight}px`;

    // 在 HiDPI 下缩放 2D 上下文以匹配 CSS 像素
    if (ctx && dpr !== 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
}

// ============================================================
// 场景配置导出
// ============================================================

/**
 * Camera2D 测试场景配置。
 *
 * 功能：
 * - Canvas 2D + OSM 瓦片渲染（256×256 PNG）
 * - Camera2D 惯性平移（环形缓冲区 + 指数衰减）
 * - 锚点缩放（以光标位置为缩放中心）
 * - 双击放大
 * - 预设城市位置跳转（flyTo 弧线动画）
 * - HUD 覆盖层（坐标/缩放/海拔/FPS/运动状态）
 *
 * 控件：
 * - zoom 滑块（1-19）
 * - inertiaDecay 滑块（0.5-0.99）
 * - inertia 开关
 * - preset 城市选择
 */
const scene: SceneConfig = {
  id: 'p0-camera-2d',
  name: 'Camera2D 正交 + 惯性 + flyTo',

  controls: [
    { type: 'group', label: 'Navigation' },
    {
      type: 'slider',
      key: 'zoom',
      label: 'Zoom Level',
      min: MIN_ZOOM,
      max: MAX_ZOOM,
      step: 0.5,
      defaultValue: DEFAULT_ZOOM,
    },
    {
      type: 'slider',
      key: 'inertiaDecay',
      label: 'Inertia Decay',
      min: 0.50,
      max: 0.99,
      step: 0.01,
      defaultValue: 0.85,
    },
    {
      type: 'switch',
      key: 'inertia',
      label: 'Inertia Enabled',
      defaultValue: true,
    },
    { type: 'group', label: 'Presets' },
    {
      type: 'select',
      key: 'preset',
      label: 'Jump to City',
      options: CITIES.map((city) => ({
        value: city.name,
        label: `${city.name} (${city.lon.toFixed(2)}, ${city.lat.toFixed(2)})`,
      })),
      defaultValue: CITIES[0].name,
    },
  ],

  /**
   * 进入 Camera2D 场景。
   * 创建 Canvas、Camera2D 实例、绑定事件、启动帧循环。
   *
   * @param container - MapViewport 提供的 div 容器
   */
  onEnter(container: HTMLDivElement): void {
    containerRef = container;

    // 清空容器
    container.innerHTML = '';

    // 创建 Canvas 元素
    canvasEl = document.createElement('canvas');
    canvasEl.style.display = 'block';
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    // 禁用默认触摸行为（防止浏览器滚动/缩放冲突）
    canvasEl.style.touchAction = 'none';
    container.appendChild(canvasEl);

    // 获取 2D 渲染上下文
    ctx = canvasEl.getContext('2d');
    if (!ctx) {
      container.innerHTML = '<div style="color:var(--error);padding:20px;">Failed to get Canvas 2D context</div>';
      return;
    }

    // 创建 HUD 覆盖层
    hudEl = document.createElement('div');
    hudEl.style.cssText = `
      position: absolute;
      bottom: 8px;
      left: 8px;
      background: rgba(0,0,0,0.6);
      color: #e0e0e0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 10;
      white-space: nowrap;
    `;
    // 容器需要 position:relative 使 HUD absolute 定位生效
    container.style.position = 'relative';
    container.appendChild(hudEl);

    // 同步 Canvas 尺寸
    syncCanvasSize();

    // 监听容器尺寸变化（面板拖拽调整大小时触发）
    resizeObserver = new ResizeObserver(() => {
      syncCanvasSize();
    });
    resizeObserver.observe(container);

    // 创建 Camera2D 实例
    camera = createCamera2D({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      inertia: true,
      inertiaDecay: 0.85,
    });

    // 绑定事件
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('pointercancel', onPointerUp);
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    canvasEl.addEventListener('dblclick', onDblClick);

    // 禁用右键菜单（GIS 工具传统）
    canvasEl.addEventListener('contextmenu', (e: Event) => e.preventDefault());

    // 初始化帧计时器
    lastFrameTime = 0;
    frameCount = 0;
    lastFpsSampleTime = 0;
    currentFps = 0;
    lastHudUpdate = 0;

    // 启动帧循环
    rafId = requestAnimationFrame(frameLoop);
  },

  /**
   * 离开 Camera2D 场景。
   * 停止帧循环、销毁相机、移除事件监听、清空缓存和 DOM。
   */
  onLeave(): void {
    // 停止帧循环
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }

    // 销毁 Camera2D 实例
    if (camera) {
      camera.destroy();
      camera = null;
    }

    // 停止 ResizeObserver
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    // 移除事件监听（Canvas 即将被移除，但显式清理更安全）
    if (canvasEl) {
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointercancel', onPointerUp);
      canvasEl.removeEventListener('wheel', onWheel);
      canvasEl.removeEventListener('dblclick', onDblClick);
    }

    // 清空瓦片缓存
    clearTileCache();

    // 清空 DOM 引用
    ctx = null;
    canvasEl = null;
    hudEl = null;

    // 清空容器
    if (containerRef) {
      containerRef.innerHTML = '';
      containerRef = null;
    }

    // 重置状态
    isPointerDown = false;
    activePointerId = -1;
  },

  /**
   * 返回当前 Camera2D 的运行时状态，供 InspectorPanel 展示。
   *
   * @returns 包含 cameraState、运动状态和瓦片统计的对象
   */
  getInspectorData(): Record<string, unknown> {
    if (!camera) {
      return { status: 'not initialized' };
    }

    const state = camera.state;
    return {
      'Camera State': {
        center: `[${state.center[0].toFixed(6)}, ${state.center[1].toFixed(6)}]`,
        zoom: state.zoom.toFixed(4),
        bearing: `${state.bearing.toFixed(4)} rad`,
        pitch: `${state.pitch.toFixed(4)} rad`,
        altitude: `${(state.altitude / 1000).toFixed(2)} km`,
      },
      'Motion State': {
        isMoving: camera.isMoving,
        isPanning: camera.isPanning,
        isInertiaActive: camera.isInertiaActive,
        isAnimating: camera.isAnimating,
      },
      'Tile Cache': {
        cached: tileCache.size,
        maxCapacity: TILE_CACHE_MAX,
        activeLoads,
        queueLength: loadQueue.length,
      },
      'Performance': {
        fps: currentFps,
      },
    };
  },

  /**
   * 返回 Camera2D 的最小可运行代码示例。
   *
   * @returns TypeScript 代码字符串
   */
  getSampleCode(): string {
    return `import { createCamera2D } from '@geoforge/camera-2d';

// Create a 2D orthographic camera
const camera = createCamera2D({
  center: [116.39, 39.91], // Beijing
  zoom: 12,
  minZoom: 1,
  maxZoom: 19,
  inertia: true,
  inertiaDecay: 0.85,
});

// Set up interaction handlers
canvas.addEventListener('pointerdown', (e) => {
  camera.handlePanStart(e.clientX, e.clientY);
});
canvas.addEventListener('pointermove', (e) => {
  camera.handlePanMove(e.clientX, e.clientY);
});
canvas.addEventListener('pointerup', () => {
  camera.handlePanEnd();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.handleZoom(-e.deltaY * 0.01, e.clientX, e.clientY);
}, { passive: false });

// Frame loop
function frame(timestamp: number) {
  const dt = /* compute delta time */ 1 / 60;
  const state = camera.update(dt, {
    width: canvas.width,
    height: canvas.height,
    devicePixelRatio: window.devicePixelRatio,
  });

  // Use state.vpMatrix for rendering
  // Use state.center, state.zoom for tile loading
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Fly to a new location
const anim = camera.flyTo({
  center: [-74.006, 40.7128], // New York
  zoom: 14,
  duration: 2000,
});
await anim.finished;

// Query visible bounds for data loading
const bounds = camera.getVisibleBounds();
console.log(\`Visible: \${bounds.west}...\${bounds.east}\`);

// Coordinate conversion
const lngLat = camera.screenToLngLat(mouseX, mouseY);
const [sx, sy] = camera.lngLatToScreen(116.39, 39.91);`;
  },
};

export default scene;
