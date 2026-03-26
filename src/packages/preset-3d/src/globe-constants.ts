/**
 * @module preset-3d/globe-constants
 * @description
 * Globe3D 使用的**命名常量**（无运行时逻辑），按「角度 / 瓦片 / GPU 布局 / 交互灵敏度」分组。
 * 从 `WGS84_A` 等椭球常数推导的项会在此显式标注来源，避免魔法数散落在 `globe-3d` 与各子模块中。
 *
 * @stability experimental
 */

import { WGS84_A } from '../../core/src/geo/ellipsoid.ts';

// ─── 角度与圆周 ─────────────────────────────────────────────

/** 度 → 弧度：乘以本常量。`Math.PI / 180` */
export const DEG2RAD = Math.PI / 180;

/** 弧度 → 度：乘以本常量。`180 / Math.PI` */
export const RAD2DEG = 180 / Math.PI;

/** 圆周率 π，避免重复 `Math.PI` 长表达式 */
export const PI = Math.PI;

/** 整圈弧度 2π */
export const TWO_PI = Math.PI * 2;

/** 直角 π/2 */
export const HALF_PI = Math.PI * 0.5;

// ─── 瓦片与默认服务 ─────────────────────────────────────────

/**
 * 默认 XYZ 瓦片 URL（OpenStreetMap）。
 * 占位符：`{z}` `{x}` `{y}`。
 */
export const TILE_URL_TEMPLATE_DEFAULT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** 显存中同时保留的影像瓦片纹理条目上限；超出时按 LRU 淘汰最旧项 */
export const MAX_TILE_CACHE_SIZE = 200;

/**
 * 同时对同一瓦片服务发起的 `fetch` 上限（见 `globe-tiles` 中 `scheduleTileFetch`）。
 * 浏览器对单主机 HTTP/1.1 并发连接通常约 6；一帧对可见集无限制 `fetch` 会触发 `ERR_INSUFFICIENT_RESOURCES`。
 * 默认取 4，为扩展页内其它请求留出余量。
 */
export const MAX_CONCURRENT_TILE_FETCHES = 4;

/**
 * CPU 侧 `GlobeTileMesh` + 索引/顶点 GPU 缓冲的条目上限。
 * 缩放会不断出现新 `z/x/y`；无上限时 Map 与 GPU 缓冲持续增长。
 */
export const MAX_MESH_CACHE_SIZE = 300;

/**
 * `zoom` 与相机高度换算常数：`altitude = ZOOM_ALTITUDE_C / 2^zoom`。
 * 取 WGS84 赤道半径，使 zoom=0 时约等于「地球半径」量级高度。
 */
export const ZOOM_ALTITUDE_C = WGS84_A;

// ─── 默认相机与地形 ────────────────────────────────────────

/** 未指定 `terrain.exaggeration` 时：1.0 为真实比例 */
export const DEFAULT_TERRAIN_EXAGGERATION = 1;

/** 仿真时间推进倍率：1.0 为实时 */
export const DEFAULT_CLOCK_MULTIPLIER = 1;

/** `flyTo` / `flyToBounds` 默认动画时长（毫秒） */
export const DEFAULT_FLIGHT_DURATION_MS = 2000;

/**
 * 默认缓动：ease-in-out cubic，`t ∈ [0,1]`。
 *
 * @param t - 归一化时间 [0,1]
 * @returns 缓动后的 [0,1]
 */
export const DEFAULT_EASING_FN: (t: number) => number = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** 默认垂直 FOV（弧度），约 45° */
export const DEFAULT_FOV = PI / 4;

/** 默认相机海拔（米），约 2×10⁷ m，可看到全球 */
export const DEFAULT_ALTITUDE = 20_000_000;

// ─── GPU buffer 布局（字节） ───────────────────────────────

/** `CameraUniforms`（6×vec4）在 WGSL 中对齐后 96 bytes */
export const CAMERA_UNIFORM_SIZE = 96;

/** `TileParams`（vec4）16 bytes */
export const TILE_PARAMS_SIZE = 16;

/** `SkyUniforms`：mat4 + f32 + pad → 96 bytes */
export const SKY_UNIFORM_SIZE = 96;

// ─── 大气几何 ──────────────────────────────────────────────

/**
 * 大气椭球经纬网格细分段数；每维 64 → (65)² 顶点。
 */
export const ATMO_SPHERE_SEGMENTS = 64;

/**
 * 大气壳相对地球赤道半径：`R_atmo = WGS84_A × ATMO_RADIUS_FACTOR`。
 * 与 Cesium 等 1.025 习惯一致。
 */
export const ATMO_RADIUS_FACTOR = 1.025;

// ─── 极地冰盖（Polar Cap） ───────────────────────────────────

/**
 * 极地冰盖程序化纹理的边长（像素）。
 * 2048×2048 在方位等距投影下提供约 5°/2048 ≈ 0.0024° 角分辨率，
 * 足以展现 Natural Earth 风格的冰盖边缘细节。值越大显存消耗越高（RGBA8 → 16MB/张）。
 *
 * @stability experimental
 */
export const POLAR_TEXTURE_SIZE = 2048;

/**
 * 极地冰盖纹理异步加载超时（毫秒）。
 * 超时后回退到程序化生成的冰盖纹理，确保极地区域始终有视觉覆盖。
 *
 * @stability experimental
 */
export const POLAR_TEXTURE_LOAD_TIMEOUT_MS = 15_000;

/**
 * 北极冰盖底色 RGBA [0,255]：冰白带蓝灰色调，模拟北极浮冰与开放海水的混合。
 * 来源参考：Natural Earth I 北极视图的平均色调。
 */
export const NORTH_POLE_BASE_COLOR: readonly [number, number, number, number] = [210, 225, 235, 255];

/**
 * 南极冰盖底色 RGBA [0,255]：纯冰白色，模拟南极冰盖的高反射率。
 * 来源参考：Natural Earth I 南极视图的平均色调。
 */
export const SOUTH_POLE_BASE_COLOR: readonly [number, number, number, number] = [235, 240, 245, 255];

/**
 * 北极海洋底色 RGBA [0,255]：深蓝黑色，模拟北冰洋在卫星影像中的色调。
 * 用于程序化纹理中极冠外缘（海洋区域）的填充。
 */
export const NORTH_POLE_OCEAN_COLOR: readonly [number, number, number, number] = [15, 35, 70, 255];

/**
 * 南极海洋底色 RGBA [0,255]：南大洋深蓝色。
 * 用于程序化纹理中极冠外缘（海洋区域）的填充。
 */
export const SOUTH_POLE_OCEAN_COLOR: readonly [number, number, number, number] = [10, 30, 65, 255];

// ─── 地形管线（Phase 3）────────────────────────────────────

/** TerrainParams uniform 大小：exaggeration + heightScale + heightOffset + pad = 16 字节 */
export const TERRAIN_UNIFORM_SIZE = 16;

/** DrapingParams uniform 大小：imgWest + imgEast + latToV_scale + latToV_offset = 16 字节 */
export const DRAPING_UNIFORM_SIZE = 16;

/** 地形模式交错顶点：posRTE(3) + normal(3) + uv(2) + lngDeg(1) + latDeg(1) = 10 floats */
export const TERRAIN_VERTEX_FLOATS = 10;

/** 地形顶点步长（字节）：10 × 4 = 40 */
export const TERRAIN_VERTEX_BYTES = TERRAIN_VERTEX_FLOATS * 4;

/** SSE 阈值（像素）。瓦片在屏幕上的几何误差低于此值则不再分裂。 */
export const SSE_THRESHOLD = 2.0;

/** 四叉树递归栈上限（防止无限递归） */
export const MAX_RECURSE_DEPTH = 25;

// ─── 深度与顶点格式 ────────────────────────────────────────

/**
 * 主 pass 深度清除值（标准深度：远平面 1.0）。
 * 注：与 Reversed-Z 全局规则不同处为历史遗留；本文件仅描述当前 Globe 实现。
 */
export const DEPTH_CLEAR_VALUE = 1.0;

/** 透视近裁剪面：`near = max(altitude × NEAR_PLANE_FACTOR, NEAR_PLANE_MIN)` */
export const NEAR_PLANE_FACTOR = 0.001;

/** 近裁剪面下限（米），防止过小导致深度精度崩溃 */
export const NEAR_PLANE_MIN = 0.5;

/** 远裁剪面：`far = horizonDist × FAR_PLANE_HORIZON_FACTOR + altitude` */
export const FAR_PLANE_HORIZON_FACTOR = 2.0;

/** 交错顶点：posRTE(3)+normal(3)+uv(2) */
export const VERTEX_FLOATS = 8;

/** `VERTEX_FLOATS × 4` 字节步长 */
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

// ─── 清除色（天穹/背景） ───────────────────────────────────

/** 主 pass 颜色附件 clear 的 R（深蓝太空） */
export const CLEAR_R = 0.01;

/** clear 的 G */
export const CLEAR_G = 0.01;

/** clear 的 B */
export const CLEAR_B = 0.03;

// ─── Morph / 画布 / 交互 ───────────────────────────────────

/** `morphTo*` 默认时长（毫秒） */
export const MORPH_DEFAULT_DURATION_MS = 2000;

/** `maxPixelRatio` 未指定时的上限：2.0 */
export const MAX_DEFAULT_PIXEL_RATIO = 2.0;

/** Canvas 最小 CSS 边长（像素），防止 0 尺寸 */
export const MIN_CANVAS_DIM = 1;

/**
 * 滚轮 `deltaY` → 传给 {@link Camera3D.handleZoom} 的增量系数。
 * `handleZoom` 内部使用 `alt *= pow(1.002, -delta)`；原值 0.01 时每格滚轮约 0.2% 高度变化，
 * 在地球尺度下需滚动过久；提高到 0.05 约为每格 ~1%（体感约 5 倍）。
 */
export const ZOOM_SENSITIVITY = 0.05;

/** 鼠标像素位移 → bearing/pitch 弧度的灵敏度（中键拖拽） */
export const ROTATE_SENSITIVITY = 0.003;
