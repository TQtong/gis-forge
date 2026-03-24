/**
 * useGlobeRenderer.ts — 正交投影 Globe 渲染器（Canvas 2D + OSM 瓦片）
 *
 * 将 Web Mercator 栅格瓦片投影到正交球面上显示。
 * 核心技术：将每个瓦片细分为 SUB_N×SUB_N 子格网，每个子格网使用
 * Canvas 2D setTransform 仿射变换近似球面纹理映射。
 *
 * 支持：
 * - 拖拽旋转球体（修改 mapStore.center）
 * - 滚轮缩放（修改 mapStore.zoom，同步切换瓦片 LOD）
 * - 双击缩放（含经纬度锚点漫游）
 * - 瓦片异步加载 + LRU 缓存淘汰
 * - 失败重试（冷却 10s）
 * - 星空 / 大气光晕 / 经纬网格 / 中心标记
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';

// ============================================================
// 常量
// ============================================================

/** 角度→弧度转换因子 */
const DEG = Math.PI / 180;

/** OSM 瓦片像素尺寸（标准 256×256） */
const TILE_SIZE = 256;

/** Globe 球体在视口短边中的占比（0.78 让球体不贴边框） */
const GLOBE_RADIUS_RATIO = 0.78;

/**
 * 每个瓦片在经纬方向上的细分数。
 * 细分越多投影越精确但 drawImage 调用越多。
 * 8×8 = 64 个子格网 / 瓦片，在中等瓦片数（~40）下总共 ~2500 次 drawImage，
 * Canvas 2D 可轻松承受。
 */
const SUB_N = 8;

/** 瓦片缩放级别下限（zoom 0 只有 1 个瓦片，细节不够） */
const MIN_TILE_ZOOM = 1;

/** 瓦片缩放级别上限（Globe 全景视角下不需要超高分辨率） */
const MAX_TILE_ZOOM = 5;

/** 瓦片缓存最大容量，超出后从 LRU 队列头部淘汰 */
const MAX_CACHE_SIZE = 512;

/** Web Mercator 投影最大纬度（±85.0511...°）——超出此纬度无瓦片数据 */
const MAX_MERCATOR_LAT = 85.05112878;

/** 瓦片加载失败后的重试冷却时间（毫秒） */
const RETRY_COOLDOWN_MS = 10_000;

/** 正交投影可见性判定阈值：cosC > 此值才算可见。-0.05 允许轻微越过地平线，避免边缘闪烁 */
const VISIBILITY_THRESHOLD = -0.05;

/** 子格网最小可见角数：4 角中至少此数可见才绘制（避免严重变形的边缘格子） */
const MIN_VISIBLE_CORNERS = 3;

/** 子格网最小像素面积：低于此值跳过绘制（避免亚像素退化格） */
const MIN_CELL_AREA_PX = 0.5;

/** 星星数量（伪随机确定性生成） */
const STAR_COUNT = 200;

/** 星星伪随机种子 */
const STAR_SEED = 42;

/** 缩放灵敏度（滚轮 deltaY 到 zoom delta 的转换系数） */
const ZOOM_RATE = 1 / 450;

/** 拖拽灵敏度（像素到经纬度的转换系数） */
const DRAG_SENSITIVITY = 0.3;

/** 缩放时中心向鼠标位置偏移的插值比例 */
const ZOOM_CENTER_LERP = 0.15;

/** 双击缩放步长 */
const DBLCLICK_ZOOM_STEP = 1;

/** 双击缩放中心偏移插值比例 */
const DBLCLICK_CENTER_LERP = 0.2;

/** 最小缩放级别 */
const MIN_ZOOM = 1;

/** 最大缩放级别 */
const MAX_ZOOM = 20;

/** 最小纬度（交互钳制） */
const MIN_LAT = -85;

/** 最大纬度（交互钳制） */
const MAX_LAT = 85;

/** lineMode 1 = 像素行；lineMode 2 = 页面行 */
const WHEEL_LINE_PX = 40;

/** lineMode 2 = 页面行 */
const WHEEL_PAGE_PX = 300;

// ============================================================
// 瓦片缓存
// ============================================================

/** 已加载瓦片缓存：key（"z/x/y"）→ HTMLImageElement */
const tileCache = new Map<string, HTMLImageElement>();

/** 正在加载中的瓦片 key 集合（防止重复请求） */
const loadingTiles = new Set<string>();

/** 加载失败的瓦片：key → 上次失败的时间戳（用于冷却期判定） */
const failedTiles = new Map<string, number>();

/** LRU 顺序队列：最近访问的 key 排在末尾，淘汰从头部开始 */
const lruOrder: string[] = [];

/**
 * 标记瓦片被访问，将其移到 LRU 队列末尾。
 *
 * @param key - 瓦片缓存 key，格式 "z/x/y"
 */
function touchTile(key: string): void {
    const idx = lruOrder.indexOf(key);
    // 若已在队列中，先移除再追加到末尾
    if (idx !== -1) {
        lruOrder.splice(idx, 1);
    }
    lruOrder.push(key);
}

/**
 * 淘汰超出 MAX_CACHE_SIZE 的旧瓦片。
 * 从 LRU 队列头部（最久未访问）开始删除。
 */
function evictTiles(): void {
    while (tileCache.size > MAX_CACHE_SIZE && lruOrder.length > 0) {
        const oldest = lruOrder.shift()!;
        tileCache.delete(oldest);
    }
}

/**
 * 获取瓦片图片。已缓存则直接返回；否则异步加载并返回 null。
 *
 * 加载完成后调用 onLoad 回调以触发 Globe 重绘。
 * 失败的瓦片有 RETRY_COOLDOWN_MS 冷却期，冷却期内不会重试。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @param onLoad - 加载完成回调
 * @returns 已加载的 Image 或 null（正在加载 / 冷却中）
 *
 * @example
 * const img = getGlobeTile(3, 2, 2, () => scheduleRender());
 * if (img) drawTileOnGlobe(ctx, img, ...);
 */
function getGlobeTile(
    x: number,
    y: number,
    z: number,
    onLoad: () => void,
): HTMLImageElement | null {
    const key = `${z}/${x}/${y}`;

    // 已缓存 → 直接返回
    if (tileCache.has(key)) {
        touchTile(key);
        return tileCache.get(key)!;
    }

    // 正在加载 → 等待
    if (loadingTiles.has(key)) {
        return null;
    }

    // 之前失败 → 检查冷却期
    const failTime = failedTiles.get(key);
    if (failTime !== undefined && Date.now() - failTime < RETRY_COOLDOWN_MS) {
        return null;
    }

    // 发起加载
    loadingTiles.add(key);
    failedTiles.delete(key);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

    img.onload = () => {
        loadingTiles.delete(key);
        tileCache.set(key, img);
        touchTile(key);
        evictTiles();
        // 通知 Globe 重绘以展示新加载的瓦片
        onLoad();
    };

    img.onerror = () => {
        loadingTiles.delete(key);
        failedTiles.set(key, Date.now());
    };

    return null;
}

// ============================================================
// 坐标变换
// ============================================================

/**
 * 正交投影：经纬度 → 单位球面 2D 坐标。
 *
 * 正交投影公式（以视点中心为原点）：
 *   x = cos(φ) × sin(λ - λ₀)
 *   y = cos(φ₀) × sin(φ) - sin(φ₀) × cos(φ) × cos(λ - λ₀)
 *   cosC = sin(φ₀)sin(φ) + cos(φ₀)cos(φ)cos(λ-λ₀)
 * 其中 cosC > 0 表示点在可见半球（近半球）。
 *
 * @param lon - 经度（度）
 * @param lat - 纬度（度）
 * @param cLon - 视点中心经度（度）
 * @param cLat - 视点中心纬度（度）
 * @returns { x, y, visible } — x/y ∈ [-1,1]，visible 表示点是否在可见半球
 *
 * @example
 * const p = project(0, 0, 0, 0); // → { x: 0, y: 0, visible: true }
 */
function project(
    lon: number,
    lat: number,
    cLon: number,
    cLat: number,
): { x: number; y: number; visible: boolean } {
    const lam = lon * DEG;
    const phi = lat * DEG;
    const lam0 = cLon * DEG;
    const phi0 = cLat * DEG;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinPhi0 = Math.sin(phi0);
    const cosPhi0 = Math.cos(phi0);
    const dLam = lam - lam0;
    const cosDLam = Math.cos(dLam);

    // cosC：视点中心与目标点之间大圆角的余弦
    const cosC = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosDLam;

    const x = cosPhi * Math.sin(dLam);
    const y = cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosDLam;

    return { x, y, visible: cosC > VISIBILITY_THRESHOLD };
}

/**
 * 瓦片列号（可含小数）→ 经度（度）。
 *
 * @param x - 瓦片列号
 * @param z - 缩放级别
 * @returns 经度 ∈ [-180, 180]
 *
 * @example
 * tileXToLon(0, 1); // → -180
 * tileXToLon(2, 1); // → 180
 */
function tileXToLon(x: number, z: number): number {
    return (x / (1 << z)) * 360 - 180;
}

/**
 * Mercator 归一化 Y 坐标 → 纬度（度）。
 * mercatorY ∈ [0, 1]，0 = 北极极限（~85.05°），1 = 南极极限（~-85.05°）。
 *
 * 公式：lat = arctan(sinh(π × (1 - 2 × mercatorY))) × (180/π)
 *
 * @param mercatorY - Mercator 归一化 Y ∈ [0, 1]
 * @returns 纬度（度）
 *
 * @example
 * mercatorYToLat(0.5); // → 0（赤道）
 * mercatorYToLat(0);   // → ~85.05（北极限）
 */
function mercatorYToLat(mercatorY: number): number {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) / DEG;
}

/**
 * 瓦片行号（可含小数）→ 纬度（度），通过 Mercator Y 归一化转换。
 *
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns 纬度（度）
 *
 * @example
 * tileYToLat(0, 1); // → ~85.05（北边界）
 * tileYToLat(1, 1); // → 0（赤道）
 */
function tileYToLat(y: number, z: number): number {
    return mercatorYToLat(y / (1 << z));
}

/**
 * 经纬度 → Web Mercator 瓦片坐标（取整后为瓦片列号/行号）。
 *
 * @param lon - 经度（度）
 * @param lat - 纬度（度），钳制到 ±MAX_MERCATOR_LAT
 * @param z - 缩放级别
 * @returns { tileX, tileY } 瓦片列号和行号
 *
 * @example
 * lonLatToTileXY(0, 0, 1); // → { tileX: 1, tileY: 1 }
 */
function lonLatToTileXY(
    lon: number,
    lat: number,
    z: number,
): { tileX: number; tileY: number } {
    const n = 1 << z;

    // 经度 → 瓦片 X：线性映射 [-180°, 180°] → [0, 2^z]
    const tileX = Math.floor(((lon + 180) / 360) * n);

    // 纬度钳制到 Mercator 极限，防止 tan(90°) 溢出
    const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
    const latRad = clampedLat * DEG;
    // 纬度 → Mercator Y → 瓦片 Y
    const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    const tileY = Math.floor(mercY * n);

    return {
        tileX: Math.max(0, Math.min(n - 1, tileX)),
        tileY: Math.max(0, Math.min(n - 1, tileY)),
    };
}

// ============================================================
// 可见瓦片计算
// ============================================================

/** 瓦片坐标描述 */
interface TileCoord {
    /** 瓦片列号 */
    readonly x: number;
    /** 瓦片行号 */
    readonly y: number;
    /** 缩放级别 */
    readonly z: number;
}

/**
 * 计算当前视点下所有可能可见的瓦片列表。
 *
 * 策略：
 * 1. 计算经度/纬度可见范围（中心 ±95°，略大于半球以覆盖边缘瓦片）
 * 2. 转为瓦片行列范围
 * 3. 逐瓦片检查中心点是否在可见半球内
 *
 * @param cLon - 视点中心经度
 * @param cLat - 视点中心纬度
 * @param z - 瓦片缩放级别
 * @returns 可见瓦片坐标数组（按距中心由近到远排序，优先加载中心瓦片）
 *
 * @example
 * const tiles = getVisibleTiles(45, 30, 2);
 * // → 约 10~15 个瓦片的 TileCoord[]
 */
function getVisibleTiles(cLon: number, cLat: number, z: number): TileCoord[] {
    const n = 1 << z;
    const tiles: TileCoord[] = [];

    // 经度范围：视点中心 ±95°（稍大于 90° 半球以捕获边缘瓦片）
    const lonMin = cLon - 95;
    const lonMax = cLon + 95;

    // 纬度范围：同理 ±95°，但钳制到 Mercator 极限
    const latMin = Math.max(-MAX_MERCATOR_LAT, cLat - 95);
    const latMax = Math.min(MAX_MERCATOR_LAT, cLat + 95);

    // 经纬范围 → 瓦片行列范围
    const { tileX: xStart } = lonLatToTileXY(lonMin, 0, z);
    const { tileX: xEnd } = lonLatToTileXY(lonMax, 0, z);
    // 纬度与行号反向：latMax → yMin（北边 = 小行号）
    const { tileY: yMin } = lonLatToTileXY(0, latMax, z);
    const { tileY: yMax } = lonLatToTileXY(0, latMin, z);

    for (let ty = Math.max(0, yMin); ty <= Math.min(n - 1, yMax); ty++) {
        // 瓦片纬度中心（行中点）
        const tileCenterLat = tileYToLat(ty + 0.5, z);

        for (let rawTx = xStart; rawTx <= xEnd; rawTx++) {
            // 经度环绕：跨越 ±180° 时取模
            const tx = ((rawTx % n) + n) % n;

            // 瓦片经度中心
            const tileCenterLon = tileXToLon(tx + 0.5, z);

            // 正交投影可见性检查
            const p = project(tileCenterLon, tileCenterLat, cLon, cLat);
            if (p.visible) {
                tiles.push({ x: tx, y: ty, z });
            }
        }
    }

    // 按到视点中心的距离排序：近处瓦片优先加载和绘制
    tiles.sort((a, b) => {
        const aLon = tileXToLon(a.x + 0.5, z);
        const aLat = tileYToLat(a.y + 0.5, z);
        const bLon = tileXToLon(b.x + 0.5, z);
        const bLat = tileYToLat(b.y + 0.5, z);
        const dA = (aLon - cLon) * (aLon - cLon) + (aLat - cLat) * (aLat - cLat);
        const dB = (bLon - cLon) * (bLon - cLon) + (bLat - cLat) * (bLat - cLat);
        return dA - dB;
    });

    return tiles;
}

// ============================================================
// 渲染函数
// ============================================================

/**
 * 从 store zoom 映射到瓦片 LOD 级别。
 * Globe 全景视角覆盖约半个地球，不需要太高的瓦片级别。
 *
 * 映射关系：
 *   store zoom 1~2 → tile zoom 1
 *   store zoom 3~4 → tile zoom 2
 *   store zoom 5~6 → tile zoom 3
 *   store zoom 7~8 → tile zoom 4
 *   store zoom 9+   → tile zoom 5（上限）
 *
 * @param storeZoom - mapStore 中的缩放级别
 * @returns 瓦片缩放级别 ∈ [MIN_TILE_ZOOM, MAX_TILE_ZOOM]
 */
function computeTileZoom(storeZoom: number): number {
    return Math.max(MIN_TILE_ZOOM, Math.min(MAX_TILE_ZOOM, Math.floor(storeZoom / 2) + 1));
}

/**
 * 绘制伪随机星空背景。
 * 使用确定性 LCG（种子 = STAR_SEED = 42）确保每帧星星位置一致。
 * 球体投影圆 + 30px 边距内的星星被跳过（被球体遮挡）。
 *
 * @param ctx - Canvas 2D 上下文
 * @param w - 画布宽度
 * @param h - 画布高度
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param radius - 球体像素半径
 */
function drawStars(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cx: number,
    cy: number,
    radius: number,
): void {
    for (let i = 0; i < STAR_COUNT; i++) {
        // LCG 伪随机：两个不同的乘子产生 X/Y 坐标
        const a = (STAR_SEED * (i + 1) * 16807) % 2147483647;
        const b = (STAR_SEED * (i + 1) * 48271) % 2147483647;
        const sx = (a / 2147483647) * w;
        const sy = (b / 2147483647) * h;

        // 跳过被球体遮挡的星星
        const dx = sx - cx;
        const dy = sy - cy;
        if (dx * dx + dy * dy < (radius + 30) * (radius + 30)) continue;

        const brightness = 0.15 + ((a % 100) / 100) * 0.55;
        ctx.fillStyle = `rgba(255,255,255,${brightness})`;
        ctx.fillRect(sx, sy, 1.2, 1.2);
    }
}

/**
 * 绘制大气散射光晕（球体外圈的蓝色渐变光辉）。
 * 使用径向渐变模拟大气散射的边缘增亮效果。
 *
 * @param ctx - Canvas 2D 上下文
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param radius - 球体像素半径
 */
function drawAtmosphere(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
): void {
    const atmo = ctx.createRadialGradient(cx, cy, radius * 0.97, cx, cy, radius * 1.2);
    atmo.addColorStop(0, 'rgba(83,168,182,0.3)');
    atmo.addColorStop(0.5, 'rgba(83,168,182,0.1)');
    atmo.addColorStop(1, 'rgba(83,168,182,0)');
    ctx.fillStyle = atmo;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.2, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * 绘制海洋底色（径向渐变模拟球面光照的高光偏移效果）。
 * 渐变中心偏向左上方，模拟来自左上的环境光。
 *
 * @param ctx - Canvas 2D 上下文
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param radius - 球体像素半径
 */
function drawOcean(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
): void {
    const ocean = ctx.createRadialGradient(
        cx - radius * 0.25, cy - radius * 0.25, radius * 0.05,
        cx, cy, radius,
    );
    ocean.addColorStop(0, '#1e6fa0');
    ocean.addColorStop(0.5, '#185a80');
    ocean.addColorStop(1, '#0e3e5c');
    ctx.fillStyle = ocean;
    // 用 fillRect 覆盖整个裁剪区域（已被 clip 到球面圆）
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

/**
 * 将所有可见瓦片正交投影到球面并绘制。
 *
 * 每个瓦片被细分为 SUB_N × SUB_N 的子格网。对每个子格网：
 * 1. 计算 4 个角的地理坐标（经度等间距，纬度在 Mercator Y 空间等间距后逆变换）
 * 2. 正交投影到屏幕坐标
 * 3. 用 3 个角（左上、右上、左下）构建仿射变换矩阵
 * 4. 调用 setTransform + drawImage 绘制对应的瓦片子区域
 *
 * 仿射近似原理：对于足够小的球面区域，正交投影接近线性变换。
 * SUB_N=8 时每个子格网约覆盖 (360/2^z)/8 ≈ 几度的地理范围，
 * 投影失真 < 1px，肉眼不可见。
 *
 * @param ctx - Canvas 2D 上下文（已裁剪到球面圆）
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param radius - 球体像素半径
 * @param cLon - 视点中心经度
 * @param cLat - 视点中心纬度
 * @param tileZoom - 瓦片缩放级别
 * @param onTileLoad - 瓦片加载完成回调
 * @returns true 如果有瓦片仍在加载中（需要后续重绘）
 */
function drawTiles(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    cLon: number,
    cLat: number,
    tileZoom: number,
    onTileLoad: () => void,
): boolean {
    const tiles = getVisibleTiles(cLon, cLat, tileZoom);
    let hasLoading = false;

    for (let t = 0; t < tiles.length; t++) {
        const tile = tiles[t];
        const img = getGlobeTile(tile.x, tile.y, tile.z, onTileLoad);
        if (!img) {
            hasLoading = true;
            continue;
        }

        // 瓦片地理边界
        const lonMin = tileXToLon(tile.x, tile.z);
        const lonMax = tileXToLon(tile.x + 1, tile.z);

        // Mercator Y 范围（用于纬度方向的等间距细分）
        // 在 Mercator Y 空间等间距保证子格网与瓦片像素网格对齐
        const n = 1 << tile.z;
        const mercYTop = tile.y / n;       // 北边（Mercator Y 小 = 高纬度）
        const mercYBottom = (tile.y + 1) / n; // 南边

        // 经度和 Mercator Y 的每格步长
        const dLon = (lonMax - lonMin) / SUB_N;
        const dMercY = (mercYBottom - mercYTop) / SUB_N;

        // 源纹理每格尺寸
        const srcCellW = TILE_SIZE / SUB_N;
        const srcCellH = TILE_SIZE / SUB_N;

        for (let sy = 0; sy < SUB_N; sy++) {
            for (let sx = 0; sx < SUB_N; sx++) {
                // 子格网 4 角经纬度
                const lon0 = lonMin + sx * dLon;
                const lon1 = lonMin + (sx + 1) * dLon;

                // 纬度：从 Mercator Y 逆变换（保证在瓦片图片空间等间距）
                const mY0 = mercYTop + sy * dMercY;
                const mY1 = mercYTop + (sy + 1) * dMercY;
                const lat0 = mercatorYToLat(mY0); // 北边（子格网上边）
                const lat1 = mercatorYToLat(mY1); // 南边（子格网下边）

                // 正交投影到屏幕空间：4 个角
                const p00 = project(lon0, lat0, cLon, cLat); // 左上
                const p10 = project(lon1, lat0, cLon, cLat); // 右上
                const p01 = project(lon0, lat1, cLon, cLat); // 左下
                const p11 = project(lon1, lat1, cLon, cLat); // 右下

                // 可见性检查：至少 MIN_VISIBLE_CORNERS 个角可见才绘制
                const visCount =
                    (p00.visible ? 1 : 0) +
                    (p10.visible ? 1 : 0) +
                    (p01.visible ? 1 : 0) +
                    (p11.visible ? 1 : 0);
                if (visCount < MIN_VISIBLE_CORNERS) continue;

                // 投影坐标 → 画布像素坐标
                const dx00 = cx + p00.x * radius;
                const dy00 = cy - p00.y * radius;
                const dx10 = cx + p10.x * radius;
                const dy10 = cy - p10.y * radius;
                const dx01 = cx + p01.x * radius;
                const dy01 = cy - p01.y * radius;

                // 仿射变换矩阵：将 (0,0)-(1,1) 映射到投影四边形
                // 使用 3 个角 (p00, p10, p01) 确定仿射矩阵，
                // 对于小格网，第 4 角 (p11) 的仿射近似误差可忽略
                const ax = dx10 - dx00; // 单位 X 方向的画布 X 分量
                const ay = dy10 - dy00; // 单位 X 方向的画布 Y 分量
                const bx = dx01 - dx00; // 单位 Y 方向的画布 X 分量
                const by = dy01 - dy00; // 单位 Y 方向的画布 Y 分量

                // 退化格检查：仿射变换行列式 = 像素面积，太小说明格子退化
                const area = Math.abs(ax * by - ay * bx);
                if (area < MIN_CELL_AREA_PX) continue;

                // 源纹理偏移
                const srcX = sx * srcCellW;
                const srcY = sy * srcCellH;

                // 设置仿射变换并绘制子格网
                // setTransform(a, b, c, d, e, f) 将坐标空间变为：
                //   canvasX = a * x + c * y + e
                //   canvasY = b * x + d * y + f
                // drawImage(img, srcX, srcY, srcW, srcH, 0, 0, 1, 1) 将源矩形映射到 (0,0)-(1,1)
                // 组合效果：源矩形 → 单位方格 → 仿射变换 → 投影四边形
                ctx.setTransform(ax, ay, bx, by, dx00, dy00);
                ctx.drawImage(img, srcX, srcY, srcCellW, srcCellH, 0, 0, 1, 1);
            }
        }
    }

    // 恢复默认变换（后续绘制经纬网格等需要标准坐标系）
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    return hasLoading;
}

/**
 * 绘制经纬网格线（半透明白色，叠加在瓦片之上）。
 * 经线每 30° 一条（-180° 到 180°），纬线每 30° 一条（-60° 到 60°）。
 *
 * @param ctx - Canvas 2D 上下文
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param radius - 球体像素半径
 * @param cLon - 视点中心经度
 * @param cLat - 视点中心纬度
 */
function drawGraticules(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    cLon: number,
    cLat: number,
): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.5;

    // 经线：每 30° 一条，沿纬度方向从 -90° 到 90° 绘制
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 30) {
        ctx.beginPath();
        let started = false;
        for (let latDeg = -90; latDeg <= 90; latDeg += 2) {
            const p = project(lonDeg, latDeg, cLon, cLat);
            if (!p.visible) {
                started = false;
                continue;
            }
            const px = cx + p.x * radius;
            const py = cy - p.y * radius;
            if (!started) {
                ctx.moveTo(px, py);
                started = true;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.stroke();
    }

    // 纬线：每 30° 一条，沿经度方向从 -180° 到 180° 绘制
    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
        ctx.beginPath();
        let started = false;
        for (let lonDeg = -180; lonDeg <= 180; lonDeg += 2) {
            const p = project(lonDeg, latDeg, cLon, cLat);
            if (!p.visible) {
                started = false;
                continue;
            }
            const px = cx + p.x * radius;
            const py = cy - p.y * radius;
            if (!started) {
                ctx.moveTo(px, py);
                started = true;
            } else {
                ctx.lineTo(px, py);
            }
        }
        ctx.stroke();
    }
}

/**
 * 绘制视点中心标记（青色圆点 + 白色描边）。
 *
 * @param ctx - Canvas 2D 上下文
 * @param cx - 球心 X（中心点始终在球心位置）
 * @param cy - 球心 Y
 */
function drawCenterMarker(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
): void {
    ctx.fillStyle = '#53a8b6';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
}

/**
 * 在 Canvas 2D 上绘制完整的带瓦片纹理的正交投影地球。
 *
 * 渲染顺序（画家算法，后绘制的覆盖先绘制的）：
 * 1. 深空背景
 * 2. 星空
 * 3. 大气光晕
 * 4. [clip 到球面圆]
 * 5. 海洋底色
 * 6. 瓦片纹理
 * 7. 经纬网格
 * 8. 中心标记
 * 9. [restore clip]
 * 10. 球面边框
 *
 * @param ctx - Canvas 2D 渲染上下文
 * @param w - 画布宽度（像素）
 * @param h - 画布高度（像素）
 * @param cLon - 视点中心经度
 * @param cLat - 视点中心纬度
 * @param zoom - 地图缩放级别（来自 store）
 * @param onTileLoad - 瓦片加载完成回调（用于触发重绘）
 * @returns true 如果有瓦片仍在加载中
 */
function drawGlobe(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cLon: number,
    cLat: number,
    zoom: number,
    onTileLoad: () => void,
): boolean {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) * GLOBE_RADIUS_RATIO;

    // 1. 深空背景
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, w, h);

    // 2. 星空
    drawStars(ctx, w, h, cx, cy, radius);

    // 3. 大气光晕
    drawAtmosphere(ctx, cx, cy, radius);

    // 4. 裁剪到球面圆 + 海洋底色
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    // 5. 海洋
    drawOcean(ctx, cx, cy, radius);

    // 6. 瓦片
    const tileZoom = computeTileZoom(zoom);
    const hasLoading = drawTiles(ctx, cx, cy, radius, cLon, cLat, tileZoom, onTileLoad);

    // 7. 经纬网格
    drawGraticules(ctx, cx, cy, radius, cLon, cLat);

    // 8. 中心标记
    drawCenterMarker(ctx, cx, cy);

    // 9. 恢复裁剪
    ctx.restore();

    // 10. 球面边框
    ctx.strokeStyle = 'rgba(83,168,182,0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    return hasLoading;
}

// ============================================================
// 交互辅助：球面逆投影
// ============================================================

/**
 * 从球面上的归一化坐标 (nx, ny) 逆投影到经纬度。
 * 用于滚轮缩放和双击缩放时将鼠标位置映射回地理坐标。
 *
 * 正交逆投影：
 *   z = sqrt(1 - x² - y²)      （球面上的深度）
 *   lat = asin(y × cos(φ₀) + z × sin(φ₀))
 *   lon = λ₀ + atan2(x × cos(φ₀), z × cos(φ₀) - y × sin(φ₀))
 *
 * @param nx - 球面归一化 X ∈ [-1, 1]
 * @param ny - 球面归一化 Y ∈ [-1, 1]（向上为正）
 * @param cLon - 视点中心经度
 * @param cLat - 视点中心纬度
 * @returns { lon, lat } 地理坐标（度），若点在球外返回 null
 *
 * @example
 * const ll = inverseProject(0, 0, 45, 30); // → { lon: 45, lat: 30 }（球心）
 */
function inverseProject(
    nx: number,
    ny: number,
    cLon: number,
    cLat: number,
): { lon: number; lat: number } | null {
    const dist2 = nx * nx + ny * ny;
    // 点在球面外
    if (dist2 >= 1) return null;

    const z = Math.sqrt(Math.max(0, 1 - dist2));
    const cLatRad = cLat * DEG;
    const cLonRad = cLon * DEG;

    const lat = Math.asin(ny * Math.cos(cLatRad) + z * Math.sin(cLatRad));
    const lon = cLonRad + Math.atan2(
        nx * Math.cos(cLatRad),
        z * Math.cos(cLatRad) - ny * Math.sin(cLatRad),
    );

    return {
        lon: (lon / DEG),
        lat: (lat / DEG),
    };
}

// ============================================================
// React Hook
// ============================================================

/**
 * 渲染交互式正交投影地球到 Canvas 2D 元素。
 * 支持拖拽旋转球体和滚轮缩放（调整 mapStore center/zoom）。
 *
 * @param canvasRef - Canvas 元素 ref
 * @param containerRef - 容器 div ref（用于 ResizeObserver）
 * @param active - 是否激活渲染（仅在 globe 模式下为 true）
 *
 * @stability experimental
 *
 * @example
 * useGlobeRenderer(canvasRef, containerRef, mode === 'globe');
 */
export function useGlobeRenderer(
    canvasRef: RefObject<HTMLCanvasElement | null>,
    containerRef: RefObject<HTMLDivElement | null>,
    active: boolean,
): void {
    const isDragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const rafId = useRef(0);
    const fpsCounter = useRef({ frames: 0, lastTime: performance.now() });
    /** 瓦片加载中时的轮询定时器 */
    const pollTimerId = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!active) return;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        // ---- 尺寸适配 ----
        const resize = () => {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            canvas.width = rect.width;
            canvas.height = rect.height;
        };
        resize();

        const ro = new ResizeObserver(resize);
        ro.observe(container);

        // ---- 渲染循环 ----
        const render = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const { center, zoom } = useMapStore.getState();

            const hasLoading = drawGlobe(
                ctx,
                canvas.width,
                canvas.height,
                center[0],
                center[1],
                zoom,
                scheduleRender,
            );

            // 瓦片仍在加载 → 200ms 后轮询重绘以检查新到的瓦片
            if (hasLoading && pollTimerId.current === null) {
                pollTimerId.current = setTimeout(() => {
                    pollTimerId.current = null;
                    scheduleRender();
                }, 200);
            }

            // FPS 统计
            fpsCounter.current.frames++;
            const now = performance.now();
            if (now - fpsCounter.current.lastTime >= 1000) {
                useStatusStore.getState().setFps(fpsCounter.current.frames);
                fpsCounter.current.frames = 0;
                fpsCounter.current.lastTime = now;
            }
        };

        // 首次渲染
        render();

        const scheduleRender = () => {
            cancelAnimationFrame(rafId.current);
            rafId.current = requestAnimationFrame(render);
        };

        // ---- 拖拽旋转 ----
        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            isDragging.current = true;
            lastMouse.current = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;
            const dx = e.clientX - lastMouse.current.x;
            const dy = e.clientY - lastMouse.current.y;
            lastMouse.current = { x: e.clientX, y: e.clientY };

            const store = useMapStore.getState();
            const [curLon, curLat] = store.center;
            const newLon = curLon - dx * DRAG_SENSITIVITY;
            const newLat = Math.max(MIN_LAT, Math.min(MAX_LAT, curLat + dy * DRAG_SENSITIVITY));
            store.flyTo([newLon, newLat]);
            scheduleRender();
        };

        const onMouseUp = () => {
            isDragging.current = false;
            canvas.style.cursor = 'grab';
        };

        // ---- 滚轮缩放 ----
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const store = useMapStore.getState();

            // 统一 deltaY 到像素单位
            let deltaY = e.deltaY;
            if (e.deltaMode === 1) deltaY *= WHEEL_LINE_PX;
            else if (e.deltaMode === 2) deltaY *= WHEEL_PAGE_PX;

            const zoomDelta = -deltaY * ZOOM_RATE;
            const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom + zoomDelta));

            // 鼠标位置球面逆投影 → 向鼠标位置偏移中心
            const rect = canvas.getBoundingClientRect();
            const halfW = rect.width / 2;
            const halfH = rect.height / 2;
            const radius = Math.min(halfW, halfH) * GLOBE_RADIUS_RATIO;
            // 归一化球面坐标（Y 轴向上）
            const nx = (e.clientX - rect.left - halfW) / radius;
            const ny = -(e.clientY - rect.top - halfH) / radius;

            if (nx * nx + ny * ny < 1) {
                const [curLon, curLat] = store.center;
                const ll = inverseProject(nx, ny, curLon, curLat);
                if (ll) {
                    const t = ZOOM_CENTER_LERP * Math.sign(zoomDelta);
                    const newLon = curLon + (ll.lon - curLon) * t;
                    const newLat = Math.max(MIN_LAT, Math.min(MAX_LAT, curLat + (ll.lat - curLat) * t));
                    store.flyTo([newLon, newLat]);
                }
            }

            store.setZoom(newZoom);
            scheduleRender();
        };

        // ---- 双击缩放 ----
        const onDblClick = (e: MouseEvent) => {
            e.preventDefault();
            const store = useMapStore.getState();
            const zoomStep = e.shiftKey ? -DBLCLICK_ZOOM_STEP : DBLCLICK_ZOOM_STEP;
            const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, store.zoom + zoomStep));

            const rect = canvas.getBoundingClientRect();
            const halfW = rect.width / 2;
            const halfH = rect.height / 2;
            const radius = Math.min(halfW, halfH) * GLOBE_RADIUS_RATIO;
            const nx = (e.clientX - rect.left - halfW) / radius;
            const ny = -(e.clientY - rect.top - halfH) / radius;

            if (nx * nx + ny * ny < 1) {
                const [curLon, curLat] = store.center;
                const ll = inverseProject(nx, ny, curLon, curLat);
                if (ll) {
                    const t = DBLCLICK_CENTER_LERP * Math.sign(zoomStep);
                    const newLon = curLon + (ll.lon - curLon) * t;
                    const newLat = Math.max(MIN_LAT, Math.min(MAX_LAT, curLat + (ll.lat - curLat) * t));
                    store.flyTo([newLon, newLat]);
                }
            }

            store.setZoom(newZoom);
            scheduleRender();
        };

        // ---- 事件绑定 ----
        canvas.style.cursor = 'grab';
        canvas.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDblClick);

        // store 变更时重绘（其他组件可能修改 center/zoom）
        const unsub = useMapStore.subscribe(scheduleRender);

        // ---- 清理 ----
        return () => {
            cancelAnimationFrame(rafId.current);
            if (pollTimerId.current !== null) {
                clearTimeout(pollTimerId.current);
                pollTimerId.current = null;
            }
            ro.disconnect();
            canvas.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('dblclick', onDblClick);
            unsub();
        };
    }, [active, canvasRef, containerRef]);
}
