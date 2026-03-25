// ============================================================
// RasterTileLayer.ts — 栅格瓦片图层完整 WebGPU 实现
// 职责：管理栅格瓦片生命周期（加载→解码→纹理→渐显→淘汰），
//       O(1) LRU 缓存 + Pin 防淘汰、请求调度 + 取消、父瓦片占位防闪烁、
//       相机相对坐标高精度、数据源切换 Cross-Fade、完整 encode() 绘制。
// 依赖层级：L4 图层包，消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建定义为 false 以便 tree-shake 剥离调试代码）
// ---------------------------------------------------------------------------
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/** RasterTileLayer 模块错误码，前缀 `RASTER_` 以避免跨模块碰撞。 */
const RASTER_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'RASTER_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'RASTER_INVALID_OPACITY',
  /** 亮度超出有效区间 */
  INVALID_BRIGHTNESS: 'RASTER_INVALID_BRIGHTNESS',
  /** 对比度超出有效区间 */
  INVALID_CONTRAST: 'RASTER_INVALID_CONTRAST',
  /** 饱和度超出有效区间 */
  INVALID_SATURATION: 'RASTER_INVALID_SATURATION',
  /** 色相旋转角度为非有限数 */
  INVALID_HUE_ROTATE: 'RASTER_INVALID_HUE_ROTATE',
  /** 渐显时长为非有限正数 */
  INVALID_FADE_DURATION: 'RASTER_INVALID_FADE_DURATION',
  /** GPU 设备不可用 */
  NO_GPU_DEVICE: 'RASTER_NO_GPU_DEVICE',
  /** 瓦片 URL 模板未配置 */
  NO_URL_TEMPLATE: 'RASTER_NO_URL_TEMPLATE',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认瓦片像素尺寸（WebGPU 纹理大小） */
const DEFAULT_TILE_SIZE = 256;

/** 默认渐显时长（毫秒），与 MapLibre 保持一致 */
const DEFAULT_FADE_DURATION_MS = 300;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 亮度的有效下限 */
const BRIGHTNESS_MIN = -1;

/** 亮度的有效上限 */
const BRIGHTNESS_MAX = 1;

/** 对比度的有效下限 */
const CONTRAST_MIN = -1;

/** 对比度的有效上限 */
const CONTRAST_MAX = 1;

/** 饱和度的有效下限 */
const SATURATION_MIN = -1;

/** 饱和度的有效上限 */
const SATURATION_MAX = 1;

/** 不透明度的有效下限 */
const OPACITY_MIN = 0;

/** 不透明度的有效上限 */
const OPACITY_MAX = 1;

/** 渐显完成阈值——当 fadeProgress ≥ 此值时视为完全不透明 */
const FADE_COMPLETE_THRESHOLD = 1.0;

/** 视口覆盖枚举的父级瓦片数上限（与方案五 maxTiles 一致） */
const MAX_COVERING_TILES = 200;

/**
 * 单帧最多绘制的瓦片四边形数（含 zoom-out 时 2×2 子瓦片拼合，≤ MAX_COVERING_TILES×4）。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 */
const MAX_RENDER_TILE_QUADS = 800;

/** 缓存默认最大条目数 */
const CACHE_MAX_ENTRIES = 512;

/** 缓存默认最大字节数 (256 MB) */
const CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * 祖先回溯最大层级差——搜索到 z=0 以保证 pre-loaded 全球瓦片可达。
 * 代价仅为 Map.get 查找，z=22 最多 22 次，可忽略不计。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 */
const MAX_ANCESTOR_SEARCH_DEPTH = 22;

/** 最大并发请求数 */
const MAX_CONCURRENT_REQUESTS = 6;

/**
 * IoU（Intersection over Union）阈值——低于此值时强制重新计算 coveringTiles。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 */
const SCHEDULE_IOU_THRESHOLD = 0.9;

/**
 * 视口未显著变化时最多跳过多少帧后强制重算 coveringTiles。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 */
const SCHEDULE_MAX_SKIP_FRAMES = 30;

/**
 * 预加载全球覆盖瓦片的最大 zoom——从 z=0 到此级别均在 onAdd 时请求。
 * z=0 (1 瓦片) + z=1 (4 瓦片) + z=2 (16 瓦片) = 21 瓦片，确保
 * findAncestor 在任意 zoom 下都能找到纹理，根治边缘闪烁。
 */
const PRELOAD_ANCESTOR_MAX_ZOOM = 2;

/** 每个瓦片 RGBA8 纹理的字节大小 (tileSize × tileSize × 4) 在运行时计算 */
const BYTES_PER_PIXEL_RGBA8 = 4;

/** 角度→弧度的乘法常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度→角度的乘法常量 */
const RAD_TO_DEG = 180 / Math.PI;

/** Web 墨卡托最大纬度 */
const MAX_LATITUDE = 85.051128779806604;

/** 默认瓦片 URL 尺寸 */
const TILE_PIXEL_SIZE = 512;

/** 顶点步长 = 3(pos) + 2(uv) + 1(alpha) = 6 floats × 4 bytes = 24 bytes */
const VERTEX_STRIDE_BYTES = 24;

/** 每个瓦片 4 个顶点 */
const VERTS_PER_TILE = 4;

/** 每个瓦片 6 个索引 */
const INDICES_PER_TILE = 6;

/** 重试最大次数 */
const MAX_RETRY_COUNT = 3;

/** 重试基础延迟 (ms) */
const RETRY_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// 内联 WGSL 着色器源码
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片完整 WGSL 着色器。
 * group(0) = 相机 (每帧 1 次), group(1) = 样式 (每层 1 次),
 * group(2) = 瓦片纹理+采样器 (每瓦片切换)。
 * 顶点属性携带相机相对坐标 + 预计算 UV + 渐显 alpha。
 * 片元着色器实现亮度/对比度/饱和度/色相旋转完整调色。
 */
const RASTER_TILE_WGSL = /* wgsl */ `
// ═══ 相机 Uniform（group 0，每帧更新一次）═══
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ═══ 样式 Uniform（group 1，样式变更时更新）═══
struct StyleUniforms {
  brightness: f32,
  contrast:   f32,
  saturation: f32,
  hueRotate:  f32,
};
@group(1) @binding(0) var<uniform> style: StyleUniforms;

// ═══ 瓦片纹理（group 2，每瓦片切换）═══
@group(2) @binding(0) var tileSampler: sampler;
@group(2) @binding(1) var tileTexture: texture_2d<f32>;

// ═══ 顶点输入/输出 ═══
struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) uv:       vec2<f32>,
  @location(2) alpha:    f32,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv:             vec2<f32>,
  @location(1) alpha:          f32,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(in.position, 1.0);
  out.uv      = in.uv;
  out.alpha   = in.alpha;
  return out;
}

// 色相旋转——在 RGB 空间绕灰度轴 (1,1,1)/sqrt(3) 旋转
fn hueRotateRGB(color: vec3<f32>, angle: f32) -> vec3<f32> {
  let cosA = cos(angle);
  let sinA = sin(angle);
  // 1/sqrt(3) ≈ 0.57735
  let k = 0.57735026919;
  let oneThird = 1.0 / 3.0;
  let oneMinusCos = 1.0 - cosA;
  // Rodrigues 旋转公式在 RGB 空间的展开
  let rx = color.r * (cosA + oneThird * oneMinusCos)
         + color.g * (oneThird * oneMinusCos - k * sinA)
         + color.b * (oneThird * oneMinusCos + k * sinA);
  let gx = color.r * (oneThird * oneMinusCos + k * sinA)
         + color.g * (cosA + oneThird * oneMinusCos)
         + color.b * (oneThird * oneMinusCos - k * sinA);
  let bx = color.r * (oneThird * oneMinusCos - k * sinA)
         + color.g * (oneThird * oneMinusCos + k * sinA)
         + color.b * (cosA + oneThird * oneMinusCos);
  return vec3<f32>(rx, gx, bx);
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);

  // 亮度：线性偏移
  color = vec4<f32>(color.rgb + vec3<f32>(style.brightness), color.a);

  // 对比度：以 0.5 为中心缩放
  color = vec4<f32>(
    (color.rgb - vec3<f32>(0.5)) * (1.0 + style.contrast) + vec3<f32>(0.5),
    color.a,
  );

  // 饱和度：与灰度混合
  let gray = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  color = vec4<f32>(
    mix(vec3<f32>(gray), color.rgb, 1.0 + style.saturation),
    color.a,
  );

  // 色相旋转（仅在 hueRotate ≠ 0 时有效果，但 GPU 总是执行——分支更贵）
  color = vec4<f32>(hueRotateRGB(color.rgb, style.hueRotate), color.a);

  // Clamp 到合法颜色范围
  color = clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));

  // 渐显 alpha（来自顶点属性，已乘以图层 opacity）
  color.a *= in.alpha;

  return color;
}
`;

// ---------------------------------------------------------------------------
// 内部类型定义
// ---------------------------------------------------------------------------

/**
 * LRU 缓存条目：一个栅格瓦片在缓存中的完整状态。
 * 包含 GPU 纹理、BindGroup、双向链表指针和加载状态。
 */
interface CacheEntry {
  /** 瓦片唯一键 "z/x/y" */
  key: string;
  /** 瓦片坐标 */
  coord: TileCoord;
  /** GPU 纹理句柄，loading/error 状态下为 null */
  texture: GPUTexture | null;
  /** 纹理 + 采样器的 BindGroup，与 texture 同步创建/销毁 */
  bindGroup: GPUBindGroup | null;
  /** 纹理字节大小（用于内存统计） */
  byteSize: number;
  /** 瓦片当前状态 */
  state: 'loading' | 'ready' | 'error-transient' | 'error-permanent';
  /** 连续错误次数（用于指数退避） */
  errorCount: number;
  /** 渐显进度 [0, 1]，0=刚加载完（透明），1=完全不透明 */
  fadeProgress: number;
  /** 加载完成时间戳 (performance.now()) */
  loadedAt: number;
  /** 双向链表前驱——指向更旧的条目 */
  prev: CacheEntry | null;
  /** 双向链表后继——指向更新的条目 */
  next: CacheEntry | null;
}

/**
 * 可见瓦片描述：经过可见性仲裁后最终参与渲染的瓦片。
 * 可能是原始请求的瓦片，也可能是祖先瓦片占位（此时 UV 为子区域）。
 */
interface VisibleTile {
  /** 请求的原始瓦片坐标（决定绘制在世界中的位置） */
  targetCoord: TileCoord;
  /** 实际使用的缓存条目（可能是祖先） */
  entry: CacheEntry;
  /** UV 子区域偏移 [0,0]=完整瓦片 */
  uvOffset: [number, number];
  /** UV 子区域缩放 [1,1]=完整瓦片 */
  uvScale: [number, number];
}

/**
 * 样式 Uniform CPU 端镜像，对应 WGSL StyleUniforms struct。
 * 每帧检查脏标记后上传到 GPU。
 */
interface StyleUniformData {
  /** 亮度偏移量 [-1, 1]，0=无变化 */
  brightness: number;
  /** 对比度倍率 [-1, 1]，0=无变化 */
  contrast: number;
  /** 饱和度倍率 [-1, 1]，0=无变化 */
  saturation: number;
  /** 色相旋转角度（弧度），0=无旋转 */
  hueRotate: number;
  /** 不透明度 [0, 1]（不上传到 GPU，而是乘入顶点 alpha） */
  opacity: number;
}

// ---------------------------------------------------------------------------
// RasterTileLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层构造选项。
 *
 * @example
 * const opts: RasterTileLayerOptions = {
 *   id: 'satellite',
 *   source: 'mapbox-satellite',
 *   tiles: ['https://tile.example.com/{z}/{x}/{y}.png'],
 *   tileSize: 256,
 *   opacity: 0.9,
 *   minzoom: 0,
 *   maxzoom: 19,
 * };
 */
export interface RasterTileLayerOptions {
  /** 图层唯一 ID */
  readonly id: string;
  /** 绑定的栅格数据源 ID */
  readonly source: string;
  /** 瓦片 URL 模板列表（支持 {z}/{x}/{y} 占位符），从 source 解析或直接指定 */
  readonly tiles?: string[];
  /** 瓦片像素尺寸，可选，默认 256 */
  readonly tileSize?: number;
  /** 初始不透明度 [0,1]，默认 1 */
  readonly opacity?: number;
  /** 最小可见缩放级别，默认 0 */
  readonly minzoom?: number;
  /** 最大可见缩放级别，默认 22 */
  readonly maxzoom?: number;
  /** 渐显时长（毫秒），默认 300 */
  readonly fadeDuration?: number;
  /** 投影标识，默认 'mercator' */
  readonly projection?: string;
  /** paint 属性 */
  readonly paint?: Record<string, unknown>;
  /** layout 属性 */
  readonly layout?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RasterTileLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层公开接口。
 *
 * @stability experimental
 */
export interface RasterTileLayer extends Layer {
  /** 图层类型鉴别字面量 */
  readonly type: 'raster';
  /** 当前帧可见瓦片数 */
  readonly visibleTiles: number;
  /** 加载中瓦片数 */
  readonly loadingTiles: number;
  /** 缓存总瓦片数 */
  readonly cachedTileCount: number;

  setBrightness(value: number): void;
  getBrightness(): number;
  setContrast(value: number): void;
  getContrast(): number;
  setSaturation(value: number): void;
  getSaturation(): number;
  setHueRotate(degrees: number): void;
  getHueRotate(): number;
  setFadeDuration(ms: number): void;

  /**
   * 方案八 IdleDetector：所有瓦片加载完成后 resolve。
   * 可用于截图等需要等待完整渲染的场景。
   * @see doc/architecture/GeoForge_Tile_Solutions.md 方案八
   */
  waitForIdle(): Promise<void>;

  /**
   * 当前是否处于 idle（无进行中的瓦片加载）。
   */
  isIdle(): boolean;
}

// ---------------------------------------------------------------------------
// O(1) LRU 瓦片缓存
// ---------------------------------------------------------------------------

/**
 * O(1) 双向链表 LRU 瓦片缓存。
 * 支持 Pin 机制：当前帧正在渲染的瓦片不可被淘汰。
 * 淘汰策略：条目数 > maxSize 或字节 > maxBytes 时从链表头（最旧）开始淘汰。
 */
class TileCache {
  /** 键→条目的快速查找表 */
  private readonly map = new Map<string, CacheEntry>();
  /** 链表头：最久未使用（最先淘汰） */
  private head: CacheEntry | null = null;
  /** 链表尾：最近使用（最后淘汰） */
  private tail: CacheEntry | null = null;
  /** 当前缓存占用字节数 */
  private currentBytes = 0;
  /** 当前帧被 Pin 的瓦片键集合 */
  private readonly pinnedKeys = new Set<string>();

  /** 最大条目数 */
  readonly maxSize: number;
  /** 最大字节数 */
  readonly maxBytes: number;

  constructor(maxSize = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }

  /**
   * 查找缓存条目，命中时自动提升到链表尾部（最近使用）。
   *
   * @param key - 瓦片键 "z/x/y"
   * @returns 缓存条目或 undefined
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.moveToTail(entry);
    }
    return entry;
  }

  /**
   * 获取或创建一个 loading 状态的条目。
   *
   * @param key - 瓦片键
   * @param coord - 瓦片坐标
   * @returns 已存在或新建的条目
   */
  getOrCreate(key: string, coord: TileCoord): CacheEntry {
    let entry = this.map.get(key);
    if (entry === undefined) {
      entry = {
        key, coord,
        texture: null, bindGroup: null, byteSize: 0,
        state: 'loading', errorCount: 0, fadeProgress: 0, loadedAt: 0,
        prev: null, next: null,
      };
      this.map.set(key, entry);
      this.appendToTail(entry);
    }
    return entry;
  }

  /**
   * 将加载完成的瓦片纹理写入缓存。
   *
   * @param key - 瓦片键
   * @param texture - GPU 纹理
   * @param bindGroup - 纹理 BindGroup
   * @param byteSize - 纹理字节大小
   */
  setReady(key: string, texture: GPUTexture, bindGroup: GPUBindGroup, byteSize: number): void {
    const entry = this.map.get(key);
    if (entry === undefined) {
      return;
    }
    // 如果旧纹理存在且不同，先销毁旧的
    if (entry.texture !== null && entry.texture !== texture) {
      entry.texture.destroy();
      this.currentBytes -= entry.byteSize;
    }
    entry.texture = texture;
    entry.bindGroup = bindGroup;
    entry.byteSize = byteSize;
    entry.state = 'ready';
    entry.errorCount = 0;
    // 跳过渐显：瓦片到达时该位置通常已被子瓦片/祖先占位覆盖，
    // 若 fadeProgress 从 0 开始，新瓦片会有 300ms 透明期导致闪烁。
    // 直接设为 1.0 让新瓦片立即完全不透明，覆盖占位纹理。
    entry.fadeProgress = FADE_COMPLETE_THRESHOLD;
    entry.loadedAt = performance.now();
    this.currentBytes += byteSize;
    this.moveToTail(entry);
    // 填入新数据后检查是否需要淘汰
    this.evictUntilFit();
  }

  /** 检查键是否存在 */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.map.size;
  }

  /** 当前缓存字节数 */
  get bytes(): number {
    return this.currentBytes;
  }

  /**
   * 每帧渲染前调用：标记本帧要渲染的瓦片不可被 LRU 淘汰。
   *
   * @param keys - 当前帧可见瓦片键的可迭代对象
   */
  pinForFrame(keys: Iterable<string>): void {
    this.pinnedKeys.clear();
    for (const k of keys) {
      this.pinnedKeys.add(k);
    }
  }

  /**
   * 销毁缓存中所有 GPU 资源，清空所有数据结构。
   */
  destroy(): void {
    for (const entry of this.map.values()) {
      if (entry.texture !== null) {
        entry.texture.destroy();
        entry.texture = null;
      }
      entry.bindGroup = null;
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.currentBytes = 0;
    this.pinnedKeys.clear();
  }

  // ═══ O(1) 双向链表操作 ═══

  /** 将条目移动到链表尾（最近使用） */
  private moveToTail(entry: CacheEntry): void {
    if (entry === this.tail) {
      return;
    }
    this.removeFromList(entry);
    this.appendToTail(entry);
  }

  /** 将条目追加到链表尾 */
  private appendToTail(entry: CacheEntry): void {
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail !== null) {
      this.tail.next = entry;
    }
    this.tail = entry;
    if (this.head === null) {
      this.head = entry;
    }
  }

  /** 将条目从链表中摘除 */
  private removeFromList(entry: CacheEntry): void {
    if (entry.prev !== null) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }
    if (entry.next !== null) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  /** 从链表头开始淘汰，直到满足容量约束。跳过 pinned 条目。 */
  private evictUntilFit(): void {
    let cursor = this.head;
    while ((this.map.size > this.maxSize || this.currentBytes > this.maxBytes) && cursor !== null) {
      const next = cursor.next;
      // 跳过当前帧正在渲染的瓦片
      if (!this.pinnedKeys.has(cursor.key)) {
        this.removeFromList(cursor);
        if (cursor.texture !== null) {
          cursor.texture.destroy();
          cursor.texture = null;
        }
        cursor.bindGroup = null;
        this.currentBytes -= cursor.byteSize;
        this.map.delete(cursor.key);
      }
      cursor = next;
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/**
 * 瓦片坐标→字符串键。
 *
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns "z/x/y" 格式字符串
 */
function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * 构建瓦片请求 URL，替换 {z}/{x}/{y} 占位符。
 *
 * @param template - URL 模板
 * @param z - 缩放级别
 * @param x - 列号
 * @param y - 行号
 * @returns 完整 URL
 */
function buildTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * 钳制纬度到 Web Mercator 有效范围。
 *
 * @param lat - 输入纬度（度）
 * @returns 钳制后的纬度
 */
function clampLat(lat: number): number {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

/**
 * 经纬度→世界像素坐标（基于 512 瓦片尺寸的 Web Mercator）。
 *
 * @param lng - 经度（度）
 * @param lat - 纬度（度）
 * @param worldSize - 当前缩放级别下世界总像素 = TILE_PIXEL_SIZE × 2^zoom
 * @returns [pixelX, pixelY]
 */
function lngLatToWorldPixel(lng: number, lat: number, worldSize: number): [number, number] {
  const px = ((lng + 180) / 360) * worldSize;
  const cLat = clampLat(lat);
  const latRad = cLat * DEG_TO_RAD;
  const py = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * worldSize;
  return [px, py];
}

/**
 * 计算当前相机视口覆盖的瓦片列表。
 * 基于相机 center/zoom 计算视口边界，然后枚举所有被覆盖的瓦片。
 *
 * @param camera - 当前相机状态
 * @param canvasWidth - CSS 画布宽度
 * @param canvasHeight - CSS 画布高度
 * @param minZoom - 图层最小缩放级别
 * @param maxZoom - 图层最大缩放级别（数据源最大级别）
 * @returns 需要的瓦片坐标列表，按距离排序
 */
function computeCoveringTiles(
  camera: CameraState,
  canvasWidth: number,
  canvasHeight: number,
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const zoom = camera.zoom;
  // 瓦片 zoom 级别：取整数，限制在图层范围内
  const tileZ = Math.min(Math.max(Math.floor(zoom), minZoom), maxZoom);
  const n = Math.pow(2, tileZ);

  // 计算世界像素尺寸（使用连续 zoom 以精确定位）
  const worldSize = TILE_PIXEL_SIZE * Math.pow(2, zoom);
  const [cx, cy] = lngLatToWorldPixel(camera.center[0], camera.center[1], worldSize);

  // 视口半宽半高（像素）
  const halfW = canvasWidth / 2;
  const halfH = canvasHeight / 2;

  // 视口边界（世界像素）
  const vpLeft = cx - halfW;
  const vpRight = cx + halfW;
  const vpTop = cy - halfH;
  const vpBottom = cy + halfH;

  // 瓦片尺寸（当前缩放级别下一个瓦片的世界像素大小）
  const tileSizePx = worldSize / n;

  // 视口覆盖的瓦片范围
  const minTileX = Math.max(0, Math.floor(vpLeft / tileSizePx));
  const maxTileX = Math.min(n - 1, Math.floor(vpRight / tileSizePx));
  const minTileY = Math.max(0, Math.floor(vpTop / tileSizePx));
  const maxTileY = Math.min(n - 1, Math.floor(vpBottom / tileSizePx));

  const tiles: TileCoord[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      tiles.push({ x: tx, y: ty, z: tileZ });
    }
  }

  // 按距离相机中心排序（优先加载靠近中心的瓦片）
  const centerTileX = cx / tileSizePx;
  const centerTileY = cy / tileSizePx;
  tiles.sort((a, b) => {
    const da = (a.x + 0.5 - centerTileX) ** 2 + (a.y + 0.5 - centerTileY) ** 2;
    const db = (b.x + 0.5 - centerTileX) ** 2 + (b.y + 0.5 - centerTileY) ** 2;
    return da - db;
  });

  // 瓦片数上限（父级格子）
  if (tiles.length > MAX_COVERING_TILES) {
    tiles.length = MAX_COVERING_TILES;
  }

  return tiles;
}

/**
 * Intersection over Union（IoU）——衡量两个 AABB 的重叠程度。
 * 1 = 完全重叠，0 = 无交集。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案五
 *
 * @param a - [minX, minY, maxX, maxY]
 * @param b - [minX, minY, maxX, maxY]
 * @returns IoU ∈ [0, 1]
 */
function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 从连续 zoom 的相机 + 画布尺寸推算世界像素级视口 AABB。
 *
 * @param camera - 当前相机状态
 * @param canvasW - CSS 画布宽度
 * @param canvasH - CSS 画布高度
 * @returns [minX, minY, maxX, maxY] 世界像素坐标
 */
function computeViewBBox(
  camera: CameraState,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] {
  const worldSize = TILE_PIXEL_SIZE * Math.pow(2, camera.zoom);
  const [cx, cy] = lngLatToWorldPixel(camera.center[0], camera.center[1], worldSize);
  const hw = canvasW / 2;
  const hh = canvasH / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/**
 * zoom-out 子瓦片逐格拼合——不再要求 4 个子瓦片全部就绪。
 * 每个子格独立判定：子瓦片就绪→直接渲染；子瓦片缺失→用最近祖先 UV 子区域填充。
 * 只要至少有一个子格可渲染就返回列表；全部无可渲染数据时返回 null。
 * @see doc/architecture/GeoForge_Tile_Solutions.md 方案一
 *
 * @param tile - 需要的父级瓦片坐标
 * @param cache - 瓦片缓存
 * @param maxSourceZoom - 数据源允许的最大 z
 * @returns 1~4 条可见项，或全部无数据时 null
 */
function resolveChildrenOrAncestors(
  tile: TileCoord,
  cache: TileCache,
  maxSourceZoom: number,
): VisibleTile[] | null {
  if (tile.z >= maxSourceZoom) {
    return null;
  }
  const cz = tile.z + 1;
  const x0 = tile.x * 2;
  const y0 = tile.y * 2;
  const children: TileCoord[] = [
    { z: cz, x: x0,     y: y0 },
    { z: cz, x: x0 + 1, y: y0 },
    { z: cz, x: x0,     y: y0 + 1 },
    { z: cz, x: x0 + 1, y: y0 + 1 },
  ];

  const out: VisibleTile[] = [];
  let anyResolved = false;

  for (const child of children) {
    const ck = tileKey(child.z, child.x, child.y);
    const ce = cache.get(ck);

    if (ce !== undefined && ce.state === 'ready' && ce.texture !== null) {
      // 子瓦片就绪——直接用全 UV
      out.push({ targetCoord: child, entry: ce, uvOffset: [0, 0], uvScale: [1, 1] });
      anyResolved = true;
    } else {
      // 子瓦片缺失——查找该子格位置的最近祖先 UV 子区域
      const anc = findAncestor(child, cache);
      if (anc !== null) {
        out.push(anc);
        anyResolved = true;
      }
      // 若连祖先也无（仅在 z=0 瓦片未加载的极短冷启动窗口出现），该子格暂无纹理
    }
  }

  return anyResolved ? out : null;
}

/**
 * 完整可见性仲裁——方案一核心实现。
 *
 * 对每个需要的瓦片按以下优先级选取最佳渲染纹理：
 *   ① 当前 zoom 瓦片已就绪 → 全 UV 直接渲染
 *   ② zoom-out 子瓦片逐格拼合（就绪子格直接渲染 + 缺失子格用祖先 UV 子区域）
 *   ③ 祖先瓦片 UV 子区域（zoom-in / 子瓦片也无数据时的最终兜底）
 *
 * @param needed - 需要的瓦片列表
 * @param cache - 瓦片缓存
 * @param maxSourceZoom - 数据源 maxzoom
 * @returns 可渲染的可见瓦片列表
 */
function resolveVisibleTiles(
  needed: TileCoord[],
  cache: TileCache,
  maxSourceZoom: number,
): VisibleTile[] {
  const result: VisibleTile[] = [];

  for (const tile of needed) {
    const key = tileKey(tile.z, tile.x, tile.y);
    const entry = cache.get(key);

    // ① 当前 zoom 瓦片已就绪
    if (entry !== undefined && entry.state === 'ready' && entry.texture !== null) {
      result.push({
        targetCoord: tile,
        entry,
        uvOffset: [0, 0],
        uvScale: [1, 1],
      });
      continue;
    }

    // ② zoom-out 子瓦片逐格拼合（部分子格可用也返回结果）
    const composite = resolveChildrenOrAncestors(tile, cache, maxSourceZoom);
    if (composite !== null) {
      result.push(...composite);
      continue;
    }

    // ③ 祖先占位（zoom-in / 子瓦片和子祖先全部不可用时的终极兜底）
    const ancestor = findAncestor(tile, cache);
    if (ancestor !== null) {
      result.push(ancestor);
    }
    // 无可用纹理 → 该位置显示背景色（冷启动极短时间内可能发生）
  }

  return result;
}

/**
 * 在缓存中搜索最近的就绪祖先瓦片，计算 UV 子区域。
 *
 * @param tile - 目标瓦片坐标
 * @param cache - 瓦片缓存
 * @returns 祖先可见瓦片描述，或 null
 */
function findAncestor(tile: TileCoord, cache: TileCache): VisibleTile | null {
  const maxDepth = Math.min(tile.z, MAX_ANCESTOR_SEARCH_DEPTH);
  for (let dz = 1; dz <= maxDepth; dz++) {
    const pz = tile.z - dz;
    // 父瓦片坐标：右移 dz 位
    const px = tile.x >> dz;
    const py = tile.y >> dz;
    const parentKey = tileKey(pz, px, py);
    const parent = cache.get(parentKey);
    if (parent !== undefined && parent.state === 'ready' && parent.texture !== null) {
      // 计算 UV 子区域：当前瓦片在祖先瓦片中的位置
      const n = 1 << dz;
      const sx = tile.x - (px << dz);
      const sy = tile.y - (py << dz);
      return {
        targetCoord: tile,
        entry: parent,
        uvOffset: [sx / n, sy / n],
        uvScale: [1 / n, 1 / n],
      };
    }
  }
  return null;
}

/**
 * 错误分类：区分临时可重试错误和永久错误。
 *
 * @param err - 捕获的错误
 * @returns 错误类别
 */
function classifyError(err: unknown): 'transient' | 'permanent' | 'ignore' {
  if (err instanceof Error) {
    // AbortError = 请求被取消，忽略
    if (err.name === 'AbortError') {
      return 'ignore';
    }
    // TypeError 通常是网络/CORS 错误，可重试
    if (err.name === 'TypeError') {
      return 'transient';
    }
  }
  // HTTP 状态码分类
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: number }).status;
    // 404 / 204 = 瓦片永久缺失
    if (status === 404 || status === 204) {
      return 'permanent';
    }
    // 5xx = 服务端临时错误，可重试
    if (status >= 500) {
      return 'transient';
    }
    // 4xx (非 404) = 永久错误（权限/参数问题）
    if (status >= 400) {
      return 'permanent';
    }
  }
  return 'transient';
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 RasterTileLayerOptions。
 *
 * @param opts - 原始选项
 * @returns 规范化后的选项（带默认值）
 */
function validateOptions(opts: RasterTileLayerOptions): {
  id: string; source: string; tiles: string[];
  tileSize: number; opacity: number; minzoom: number;
  maxzoom: number; fadeDuration: number; projection: string;
  paint?: Record<string, unknown>; layout?: Record<string, unknown>;
} {
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] id must be a non-empty string`);
  }
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] source must be a non-empty string`);
  }
  const tileSize = opts.tileSize ?? DEFAULT_TILE_SIZE;
  if (!Number.isFinite(tileSize) || tileSize <= 0 || Math.floor(tileSize) !== tileSize) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPTIONS}] tileSize must be a positive integer`);
  }
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1]`);
  }
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  const fadeDuration = opts.fadeDuration ?? DEFAULT_FADE_DURATION_MS;
  if (!Number.isFinite(fadeDuration) || fadeDuration < 0) {
    throw new Error(`[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0`);
  }
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';
  const tiles = opts.tiles ?? [];
  return {
    id: opts.id.trim(), source: opts.source.trim(), tiles,
    tileSize, opacity, minzoom, maxzoom, fadeDuration, projection,
    paint: opts.paint, layout: opts.layout,
  };
}

/**
 * 从 paint 属性表解析样式 Uniform 初始值。
 *
 * @param paint - 用户 paint 属性
 * @param baseOpacity - 图层级不透明度
 * @returns 样式 Uniform 数据
 */
function parseStyleUniforms(paint: Record<string, unknown> | undefined, baseOpacity: number): StyleUniformData {
  const readNum = (key: string, fallback: number): number => {
    if (paint === undefined || paint === null) { return fallback; }
    const v = paint[key];
    return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
  };
  return {
    brightness: readNum('raster-brightness-min', 0),
    contrast: readNum('raster-contrast', 0),
    saturation: readNum('raster-saturation', 0),
    hueRotate: readNum('raster-hue-rotate', 0) * DEG_TO_RAD,
    opacity: readNum('raster-opacity', baseOpacity),
  };
}

// ---------------------------------------------------------------------------
// createRasterTileLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建栅格瓦片图层完整实例。
 * 包含 O(1) LRU 缓存、请求调度、父瓦片占位、相机相对坐标、
 * WebGPU 管线创建和 encode() 完整绘制实现。
 *
 * @param opts - 构造选项
 * @returns 完整 RasterTileLayer 实例
 *
 * @stability experimental
 *
 * @example
 * const layer = createRasterTileLayer({
 *   id: 'osm', source: 'osm-tiles',
 *   tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
 *   tileSize: 256,
 * });
 */
export function createRasterTileLayer(opts: RasterTileLayerOptions): RasterTileLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);
  const tileByteSize = cfg.tileSize * cfg.tileSize * BYTES_PER_PIXEL_RGBA8;

  // ── 2. 内部状态 ──
  const cache = new TileCache(CACHE_MAX_ENTRIES, CACHE_MAX_BYTES);
  const styleUniforms: StyleUniformData = parseStyleUniforms(cfg.paint, cfg.opacity);
  let fadeDurationMs = cfg.fadeDuration;
  let mounted = false;
  let styleDirty = true;
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化属性缓存
  if (cfg.paint) { for (const k of Object.keys(cfg.paint)) { paintProps.set(k, cfg.paint[k]); } }
  if (cfg.layout) { for (const k of Object.keys(cfg.layout)) { layoutProps.set(k, cfg.layout[k]); } }

  // 瓦片 URL 模板（运行时可从 source 更新）
  let urlTemplates: string[] = [...cfg.tiles];

  // 请求管理
  const inflightRequests = new Map<string, AbortController>();
  let concurrentCount = 0;
  const pendingQueue: Array<{ key: string; z: number; x: number; y: number; priority: number }> = [];

  // 当前帧可见瓦片
  let currentVisibleTiles: VisibleTile[] = [];
  let lastNeededKeys = new Set<string>();

  // ── 方案五 TileScheduler：IoU 节流 ──
  /** 上次计算 coveringTiles 时的整数 tileZ */
  let schedLastTileZ = -1;
  /** 上次计算时的世界像素视口 AABB */
  let schedLastBBox: [number, number, number, number] | null = null;
  /** 上次计算得到的 coveringTiles 缓存（节流期内复用） */
  let schedCachedTiles: TileCoord[] = [];
  /** 节流计帧器——即使视口几乎不变也每 N 帧强制刷新 */
  let schedFrameCount = 0;

  // ── 方案一 RetainedTiles：旧帧保持 ──
  /** 上一次 "覆盖完整" 的可见瓦片快照——新帧覆盖不足时退用此集合渲染 */
  let retainedVisibleTiles: VisibleTile[] = [];

  // ── 方案八 IdleDetector：计数 + 回调 ──
  /** 仍在加载中的瓦片请求计数 */
  let idlePendingCount = 0;
  /** idle 回调队列 */
  let idleCallbacks: Array<() => void> = [];
  /** 防抖定时器 */
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  /** idle 检测器已销毁标记 */
  let idleDestroyed = false;

  /** 检测并触发 idle 回调 */
  function checkIdle(): void {
    if (idlePendingCount > 0 || idleDestroyed) {
      return;
    }
    if (idleTimerId !== null) {
      clearTimeout(idleTimerId);
    }
    idleTimerId = setTimeout(() => {
      if (idleDestroyed || idlePendingCount > 0) {
        return;
      }
      const cbs = idleCallbacks.splice(0);
      for (const cb of cbs) {
        cb();
      }
    }, 100);
  }

  // 画布尺寸（由 onAdd 注入或 onUpdate 推断）
  let canvasWidth = 800;
  let canvasHeight = 600;

  // ── 3. GPU 资源 ──
  let device: GPUDevice | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let sampler: GPUSampler | null = null;
  let cameraUniformBuffer: GPUBuffer | null = null;
  let styleUniformBuffer: GPUBuffer | null = null;
  let cameraBindGroup: GPUBindGroup | null = null;
  let styleBindGroup: GPUBindGroup | null = null;
  let vertexBuffer: GPUBuffer | null = null;
  let indexBuffer: GPUBuffer | null = null;
  let cameraBindGroupLayout: GPUBindGroupLayout | null = null;
  let styleBindGroupLayout: GPUBindGroupLayout | null = null;
  let textureBindGroupLayout: GPUBindGroupLayout | null = null;
  let pipelineLayout: GPUPipelineLayout | null = null;

  // ── 4. GPU 资源初始化 ──

  /**
   * 初始化所有 WebGPU 资源：管线、缓冲区、采样器、BindGroup 布局。
   * 在 onAdd 获得 GPUDevice 后调用一次。
   *
   * @param dev - WebGPU 设备实例
   */
  function initGPUResources(dev: GPUDevice): void {
    device = dev;

    // 着色器模块
    const shaderModule = dev.createShaderModule({ code: RASTER_TILE_WGSL });

    // 采样器：双线性过滤 + clamp-to-edge（防瓦片边缘溢出）
    sampler = dev.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // BindGroup 布局定义
    cameraBindGroupLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });

    styleBindGroupLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    textureBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });

    pipelineLayout = dev.createPipelineLayout({
      bindGroupLayouts: [cameraBindGroupLayout, styleBindGroupLayout, textureBindGroupLayout],
    });

    // 渲染管线
    const format = navigator.gpu.getPreferredCanvasFormat();
    pipeline = dev.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          // 顶点缓冲布局：position(vec3f) + uv(vec2f) + alpha(f32) = 24 bytes
          arrayStride: VERTEX_STRIDE_BYTES,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
            { shaderLocation: 1, offset: 12, format: 'float32x2' },  // uv
            { shaderLocation: 2, offset: 20, format: 'float32' },    // alpha
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            // 标准 alpha blending（支持渐显和半透明）
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: 'none',
      },
      // 2D 不使用深度缓冲（正交投影无深度）
    });

    // Uniform 缓冲区
    cameraUniformBuffer = dev.createBuffer({
      size: 64, // mat4x4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    styleUniformBuffer = dev.createBuffer({
      size: 16, // 4 × f32 (brightness, contrast, saturation, hueRotate)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // BindGroups
    cameraBindGroup = dev.createBindGroup({
      layout: cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cameraUniformBuffer } }],
    });

    styleBindGroup = dev.createBindGroup({
      layout: styleBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: styleUniformBuffer } }],
    });

    // 顶点缓冲（预分配 MAX_RENDER_TILE_QUADS 个瓦片四边形）
    vertexBuffer = dev.createBuffer({
      size: MAX_RENDER_TILE_QUADS * VERTS_PER_TILE * VERTEX_STRIDE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // 索引缓冲（单个四边形 [0,1,2, 2,1,3]，通过 baseVertex 复用）
    const indexData = new Uint16Array([0, 1, 2, 2, 1, 3]);
    indexBuffer = dev.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(indexBuffer, 0, indexData);
  }

  /**
   * 为一个已加载的瓦片创建纹理 BindGroup。
   *
   * @param texture - 瓦片 GPU 纹理
   * @returns BindGroup
   */
  function createTileBindGroup(texture: GPUTexture): GPUBindGroup {
    if (device === null || textureBindGroupLayout === null || sampler === null) {
      throw new Error(`[${RASTER_ERROR_CODES.NO_GPU_DEVICE}] GPU not initialized`);
    }
    return device.createBindGroup({
      layout: textureBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
  }

  // ── 5. 瓦片加载 ──

  /**
   * 异步加载单个瓦片：fetch → decode → upload GPU texture → cache。
   *
   * @param key - 瓦片键
   * @param z - 缩放级别
   * @param x - 列号
   * @param y - 行号
   */
  async function loadTile(key: string, z: number, x: number, y: number): Promise<void> {
    if (device === null || urlTemplates.length === 0) {
      return;
    }

    // 选择 URL 模板（多个模板时随机选择以分散请求）
    const templateIdx = urlTemplates.length > 1
      ? Math.floor(Math.random() * urlTemplates.length)
      : 0;
    const url = buildTileUrl(urlTemplates[templateIdx], z, x, y);

    // 创建取消控制器
    const controller = new AbortController();
    inflightRequests.set(key, controller);
    concurrentCount++;
    idlePendingCount++;

    try {
      // 网络请求
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      }

      // 解码为 ImageBitmap（浏览器原生异步解码）
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });

      // 检查取消（可能在解码过程中被 abort）
      if (controller.signal.aborted) {
        bitmap.close();
        return;
      }

      // 创建 GPU 纹理
      const texture = device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // 上传图像数据到纹理
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      );
      bitmap.close();

      // 创建 BindGroup 并存入缓存
      const bindGroup = createTileBindGroup(texture);
      cache.setReady(key, texture, bindGroup, tileByteSize);

    } catch (err: unknown) {
      // 错误分类与处理
      const errType = classifyError(err);
      if (errType === 'ignore') {
        return;
      }

      const entry = cache.get(key);
      if (entry !== undefined) {
        if (errType === 'permanent') {
          entry.state = 'error-permanent';
        } else {
          entry.errorCount++;
          entry.state = 'error-transient';
          // 超过最大重试次数则标记为永久错误
          if (entry.errorCount > MAX_RETRY_COUNT) {
            entry.state = 'error-permanent';
          } else {
            // 指数退避重试
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, entry.errorCount - 1);
            setTimeout(() => {
              if (mounted && !controller.signal.aborted) {
                scheduleTileLoad(key, z, x, y, 0);
              }
            }, delay);
          }
        }
      }
    } finally {
      inflightRequests.delete(key);
      concurrentCount--;
      idlePendingCount = Math.max(0, idlePendingCount - 1);
      checkIdle();
      // 触发队列中的下一个请求
      flushPendingQueue();
    }
  }

  /**
   * 将瓦片加载请求入队。如果并发未满则立即执行，否则按优先级排队。
   *
   * @param key - 瓦片键
   * @param z - 缩放级别
   * @param x - 列号
   * @param y - 行号
   * @param priority - 优先级（越大越优先）
   */
  function scheduleTileLoad(key: string, z: number, x: number, y: number, priority: number): void {
    // 已在加载中 → 忽略
    if (inflightRequests.has(key)) {
      return;
    }

    if (concurrentCount < MAX_CONCURRENT_REQUESTS) {
      // 直接执行
      void loadTile(key, z, x, y);
    } else {
      // 入队等待
      pendingQueue.push({ key, z, x, y, priority });
      // 按优先级降序排列
      pendingQueue.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * 从等待队列中取出请求执行，直到达到并发上限。
   */
  function flushPendingQueue(): void {
    while (concurrentCount < MAX_CONCURRENT_REQUESTS && pendingQueue.length > 0) {
      const req = pendingQueue.shift()!;
      // 检查该瓦片是否仍然需要
      if (lastNeededKeys.has(req.key)) {
        void loadTile(req.key, req.z, req.x, req.y);
      }
    }
  }

  /**
   * 取消所有不在 neededKeys 中的进行中请求和待队列请求。
   *
   * @param neededKeys - 当前帧需要的瓦片键集合
   */
  function cancelStaleRequests(neededKeys: Set<string>): void {
    // 取消进行中的过期请求
    for (const [key, controller] of inflightRequests) {
      if (!neededKeys.has(key)) {
        controller.abort();
        inflightRequests.delete(key);
        concurrentCount--;
      }
    }
    // 清理队列中过期的请求
    for (let i = pendingQueue.length - 1; i >= 0; i--) {
      if (!neededKeys.has(pendingQueue[i].key)) {
        pendingQueue.splice(i, 1);
      }
    }
  }

  /**
   * 取消所有请求（destroy 时调用）。
   */
  function cancelAllRequests(): void {
    for (const controller of inflightRequests.values()) {
      controller.abort();
    }
    inflightRequests.clear();
    concurrentCount = 0;
    pendingQueue.length = 0;
  }

  // ── 6. 释放 GPU 资源 ──

  /**
   * 销毁所有 GPU 资源。
   */
  function destroyGPUResources(): void {
    cameraUniformBuffer?.destroy();
    styleUniformBuffer?.destroy();
    vertexBuffer?.destroy();
    indexBuffer?.destroy();
    cameraUniformBuffer = null;
    styleUniformBuffer = null;
    vertexBuffer = null;
    indexBuffer = null;
    pipeline = null;
    sampler = null;
    cameraBindGroup = null;
    styleBindGroup = null;
    cameraBindGroupLayout = null;
    styleBindGroupLayout = null;
    textureBindGroupLayout = null;
    pipelineLayout = null;
    device = null;
  }

  // ── 7. 构造 Layer 实现对象 ──
  const layer: RasterTileLayer = {
    id: cfg.id,
    type: 'raster' as const,
    source: cfg.source,
    projection: cfg.projection,
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    get isLoaded(): boolean {
      return cache.size > 0;
    },

    get isTransparent(): boolean {
      if (styleUniforms.opacity < OPACITY_MAX) { return true; }
      for (const vt of currentVisibleTiles) {
        if (vt.entry.fadeProgress < FADE_COMPLETE_THRESHOLD) { return true; }
      }
      return false;
    },

    get renderOrder(): number {
      return layer.zIndex;
    },

    get visibleTiles(): number {
      return currentVisibleTiles.length;
    },

    get loadingTiles(): number {
      return inflightRequests.size;
    },

    get cachedTileCount(): number {
      return cache.size;
    },

    // ══════ 生命周期 ══════

    onAdd(context: LayerContext): void {
      mounted = true;

      // 尝试从 LayerContext 获取 GPU 设备
      const dev = context.gpuDevice ?? null;
      if (dev !== null && dev !== undefined) {
        initGPUResources(dev);
      }

      // 获取画布尺寸
      if (context.canvasSize !== undefined) {
        canvasWidth = context.canvasSize[0];
        canvasHeight = context.canvasSize[1];
      }

      // 尝试从 services 获取 URL 模板
      if (context.services !== undefined) {
        const srcTiles = context.services['tiles'];
        if (Array.isArray(srcTiles) && srcTiles.length > 0) {
          urlTemplates = srcTiles as string[];
        }
      }

      // ── 方案一：预加载全球覆盖瓦片（z=0 ~ PRELOAD_ANCESTOR_MAX_ZOOM）──
      // 确保 findAncestor 在任何 zoom 下都至少找到 z≤2 的纹理，
      // 彻底消除 zoom-out 时边缘区域因无祖先纹理导致的闪烁。
      if (urlTemplates.length > 0) {
        const maxPreloadZ = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, cfg.maxzoom);
        for (let pz = 0; pz <= maxPreloadZ; pz++) {
          const n = 1 << pz;
          for (let py = 0; py < n; py++) {
            for (let px = 0; px < n; px++) {
              const pk = tileKey(pz, px, py);
              if (!cache.has(pk)) {
                cache.getOrCreate(pk, { z: pz, x: px, y: py });
                scheduleTileLoad(pk, pz, px, py, 0);
              }
            }
          }
        }
      }
    },

    onRemove(): void {
      cancelAllRequests();
      cache.destroy();
      destroyGPUResources();
      currentVisibleTiles = [];
      retainedVisibleTiles = [];
      lastNeededKeys.clear();
      featureStateMap.clear();
      schedLastTileZ = -1;
      schedLastBBox = null;
      schedCachedTiles = [];
      schedFrameCount = 0;
      idleDestroyed = true;
      if (idleTimerId !== null) {
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
      idleCallbacks = [];
      idlePendingCount = 0;
      mounted = false;
    },

    onUpdate(deltaTime: number, camera: CameraState): void {
      if (device === null || !mounted || !layer.visible) {
        currentVisibleTiles = [];
        return;
      }

      // 缩放可见性判断
      if (camera.zoom < cfg.minzoom || camera.zoom > cfg.maxzoom + 1) {
        currentVisibleTiles = [];
        return;
      }

      // ════════════════════════════════════════════════════
      // 方案五：IoU 节流——视口几乎不变时复用上帧 coveringTiles
      // ════════════════════════════════════════════════════
      const idealTileZ = Math.min(
        Math.max(Math.floor(camera.zoom), cfg.minzoom),
        cfg.maxzoom,
      );
      const viewBBox = computeViewBBox(camera, canvasWidth, canvasHeight);
      schedFrameCount++;

      const shouldRecalc =
        schedLastTileZ !== idealTileZ ||
        schedLastBBox === null ||
        bboxIoU(schedLastBBox, viewBBox) < SCHEDULE_IOU_THRESHOLD ||
        schedFrameCount >= SCHEDULE_MAX_SKIP_FRAMES;

      if (shouldRecalc) {
        schedCachedTiles = computeCoveringTiles(
          camera, canvasWidth, canvasHeight, cfg.minzoom, cfg.maxzoom,
        );
        schedLastTileZ = idealTileZ;
        schedLastBBox = viewBBox;
        schedFrameCount = 0;
      }

      const neededTiles = schedCachedTiles;

      // ════════════════════════════════════════════════════
      // 方案一/二：构建扩展 neededKeys——不止当前 z，还包括
      //   · z+1 子瓦片（zoom-out 拼合）
      //   · 上一帧 retainedVisibleTiles 使用的纹理（旧帧保持）
      //   · 预加载祖先瓦片
      // 三者合并后再 cancelStale，保证过渡期纹理不被误杀。
      // ════════════════════════════════════════════════════
      const loadTileList: TileCoord[] = [...neededTiles];

      for (const t of neededTiles) {
        const pk = tileKey(t.z, t.x, t.y);
        const pe = cache.get(pk);
        const parentReady = pe !== undefined && pe.state === 'ready' && pe.texture !== null;
        if (!parentReady && t.z < cfg.maxzoom) {
          const cz = t.z + 1;
          const x0 = t.x * 2;
          const y0 = t.y * 2;
          loadTileList.push(
            { z: cz, x: x0,     y: y0 },
            { z: cz, x: x0 + 1, y: y0 },
            { z: cz, x: x0,     y: y0 + 1 },
            { z: cz, x: x0 + 1, y: y0 + 1 },
          );
        }
      }

      const neededKeys = new Set<string>();
      for (const t of loadTileList) {
        neededKeys.add(tileKey(t.z, t.x, t.y));
      }
      // 保留旧帧正在使用的纹理键——避免 cancelStale 杀死仍在渲染的占位纹理
      for (const vt of retainedVisibleTiles) {
        neededKeys.add(vt.entry.key);
      }
      // 预加载 z=0~2 瓦片始终保留——不被 cancelStale 杀死
      const maxPreZ2 = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, cfg.maxzoom);
      for (let pz = 0; pz <= maxPreZ2; pz++) {
        const n = 1 << pz;
        for (let py = 0; py < n; py++) {
          for (let px = 0; px < n; px++) {
            neededKeys.add(tileKey(pz, px, py));
          }
        }
      }

      cancelStaleRequests(neededKeys);
      lastNeededKeys = neededKeys;

      // ════════════════════════════════════════════════════
      // 重试未就绪的预加载祖先（onAdd 时 device 可能尚未就绪导致首次加载跳过）
      // ════════════════════════════════════════════════════
      if (urlTemplates.length > 0) {
        for (let pz = 0; pz <= maxPreZ2; pz++) {
          const n = 1 << pz;
          for (let py = 0; py < n; py++) {
            for (let px = 0; px < n; px++) {
              const pk = tileKey(pz, px, py);
              const pe = cache.get(pk);
              if (pe === undefined) {
                cache.getOrCreate(pk, { z: pz, x: px, y: py });
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              } else if (pe.state !== 'ready' && pe.state !== 'loading' && pe.state !== 'error-permanent') {
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              } else if (pe.state === 'loading' && !inflightRequests.has(pk)) {
                scheduleTileLoad(pk, pz, px, py, MAX_COVERING_TILES + 1);
              }
            }
          }
        }
      }

      // ════════════════════════════════════════════════════
      // 方案二：对缺失瓦片调度加载（去重 + 优先级）
      // ════════════════════════════════════════════════════
      const seenLoad = new Set<string>();
      for (const t of loadTileList) {
        const key = tileKey(t.z, t.x, t.y);
        if (seenLoad.has(key)) {
          continue;
        }
        seenLoad.add(key);

        const idxInParent = neededTiles.indexOf(t);
        const priority = idxInParent >= 0 ? MAX_COVERING_TILES - idxInParent : 0;

        const entry = cache.get(key);
        if (entry === undefined) {
          cache.getOrCreate(key, t);
          if (urlTemplates.length > 0) {
            scheduleTileLoad(key, t.z, t.x, t.y, priority);
          }
        } else if (
          entry.state !== 'ready' &&
          entry.state !== 'error-permanent' &&
          entry.state !== 'loading'
        ) {
          if (urlTemplates.length > 0) {
            scheduleTileLoad(key, t.z, t.x, t.y, priority);
          }
        }
      }

      // ════════════════════════════════════════════════════
      // 方案一：可见性仲裁 + 旧帧保持
      // ════════════════════════════════════════════════════
      const newVisible = resolveVisibleTiles(neededTiles, cache, cfg.maxzoom);

      // 统计新帧能覆盖多少需要的格子。
      // targetCoord 可能在 z（精确）或 z+1（子瓦片拼合），两种都要检查。
      const coveredPositions = new Set<string>();
      for (const vt of newVisible) {
        coveredPositions.add(
          tileKey(vt.targetCoord.z, vt.targetCoord.x, vt.targetCoord.y),
        );
      }
      let gapCount = 0;
      for (const t of neededTiles) {
        // ① 精确匹配或祖先（targetCoord == needed coord）
        if (coveredPositions.has(tileKey(t.z, t.x, t.y))) {
          continue;
        }
        // ② 子瓦片拼合路径——targetCoord 在 z+1，检查 4 个子格是否全部在结果中
        const cz = t.z + 1;
        const cx = t.x * 2;
        const cy = t.y * 2;
        if (
          coveredPositions.has(tileKey(cz, cx,     cy)) &&
          coveredPositions.has(tileKey(cz, cx + 1, cy)) &&
          coveredPositions.has(tileKey(cz, cx,     cy + 1)) &&
          coveredPositions.has(tileKey(cz, cx + 1, cy + 1))
        ) {
          continue;
        }
        gapCount++;
      }

      if (gapCount === 0 || retainedVisibleTiles.length === 0) {
        currentVisibleTiles = newVisible;
        retainedVisibleTiles = newVisible.slice();
      } else {
        currentVisibleTiles = [...retainedVisibleTiles, ...newVisible];
      }

      // ════════════════════════════════════════════════════
      // 方案三：Pin 当前帧 + retained + 预加载祖先（防 LRU 淘汰）
      // ════════════════════════════════════════════════════
      const pinKeys: string[] = [];
      for (const vt of currentVisibleTiles) {
        pinKeys.push(vt.entry.key);
      }
      // 永久 pin z=0~2 预加载瓦片——它们是全局兜底祖先，被淘汰后 findAncestor 会失效
      const maxPreZ = Math.min(PRELOAD_ANCESTOR_MAX_ZOOM, cfg.maxzoom);
      for (let pz = 0; pz <= maxPreZ; pz++) {
        const n = 1 << pz;
        for (let py = 0; py < n; py++) {
          for (let px = 0; px < n; px++) {
            pinKeys.push(tileKey(pz, px, py));
          }
        }
      }
      cache.pinForFrame(pinKeys);

      // ════════════════════════════════════════════════════
      // 渐显动画推进
      // ════════════════════════════════════════════════════
      const dtMs = deltaTime * 1000;
      for (const vt of currentVisibleTiles) {
        if (vt.entry.fadeProgress < FADE_COMPLETE_THRESHOLD) {
          if (fadeDurationMs <= 0) {
            vt.entry.fadeProgress = FADE_COMPLETE_THRESHOLD;
          } else {
            vt.entry.fadeProgress = Math.min(
              FADE_COMPLETE_THRESHOLD,
              vt.entry.fadeProgress + dtMs / fadeDurationMs,
            );
          }
        }
      }
    },

    encode(encoder: GPURenderPassEncoder, camera: CameraState): void {
      // 前置条件检查
      if (
        device === null || pipeline === null ||
        cameraBindGroup === null || styleBindGroup === null ||
        vertexBuffer === null || indexBuffer === null ||
        cameraUniformBuffer === null || styleUniformBuffer === null ||
        currentVisibleTiles.length === 0 || !layer.visible
      ) {
        return;
      }

      const tileCount = Math.min(currentVisibleTiles.length, MAX_RENDER_TILE_QUADS);

      // ① 上传相机 Uniform（VP 矩阵）
      device.queue.writeBuffer(cameraUniformBuffer, 0, camera.vpMatrix.buffer, camera.vpMatrix.byteOffset, camera.vpMatrix.byteLength);

      // ② 上传样式 Uniform（仅在脏时）
      if (styleDirty) {
        const styleData = new Float32Array([
          styleUniforms.brightness,
          styleUniforms.contrast,
          styleUniforms.saturation,
          styleUniforms.hueRotate,
        ]);
        device.queue.writeBuffer(styleUniformBuffer, 0, styleData);
        styleDirty = false;
      }

      // ③ 构建所有瓦片的顶点数据（相机相对坐标 + 预计算 UV + fade alpha）
      const worldSize = TILE_PIXEL_SIZE * Math.pow(2, camera.zoom);
      const [centerPx, centerPy] = lngLatToWorldPixel(
        camera.center[0], camera.center[1], worldSize,
      );

      // 每个顶点 6 floats: px, py, pz, u, v, alpha
      const vertData = new Float32Array(tileCount * VERTS_PER_TILE * 6);
      let offset = 0;

      for (let i = 0; i < tileCount; i++) {
        const vt = currentVisibleTiles[i];
        const t = vt.targetCoord;
        const tileSizePx = worldSize / Math.pow(2, t.z);

        // 瓦片世界像素边界
        const tx0 = t.x * tileSizePx;
        const ty0 = t.y * tileSizePx;
        const tx1 = tx0 + tileSizePx;
        const ty1 = ty0 + tileSizePx;

        // 相机相对坐标（Solution 9：减去 center 保持 float32 精度）
        const rx0 = tx0 - centerPx;
        const ry0 = ty0 - centerPy;
        const rx1 = tx1 - centerPx;
        const ry1 = ty1 - centerPy;

        // UV 子区域（祖先占位时为子区域，正常时为 [0,0]-[1,1]）
        const u0 = vt.uvOffset[0];
        const v0 = vt.uvOffset[1];
        const u1 = u0 + vt.uvScale[0];
        const v1 = v0 + vt.uvScale[1];

        // 综合 alpha = 渐显进度 × 图层不透明度
        const alpha = vt.entry.fadeProgress * styleUniforms.opacity;

        // 顶点 0: 左上
        vertData[offset++] = rx0; vertData[offset++] = ry0; vertData[offset++] = 0;
        vertData[offset++] = u0; vertData[offset++] = v0; vertData[offset++] = alpha;
        // 顶点 1: 右上
        vertData[offset++] = rx1; vertData[offset++] = ry0; vertData[offset++] = 0;
        vertData[offset++] = u1; vertData[offset++] = v0; vertData[offset++] = alpha;
        // 顶点 2: 左下
        vertData[offset++] = rx0; vertData[offset++] = ry1; vertData[offset++] = 0;
        vertData[offset++] = u0; vertData[offset++] = v1; vertData[offset++] = alpha;
        // 顶点 3: 右下
        vertData[offset++] = rx1; vertData[offset++] = ry1; vertData[offset++] = 0;
        vertData[offset++] = u1; vertData[offset++] = v1; vertData[offset++] = alpha;
      }

      // ④ 上传顶点数据
      device.queue.writeBuffer(vertexBuffer, 0, vertData, 0, offset);

      // ⑤ 设置管线和共享 BindGroups
      encoder.setPipeline(pipeline);
      encoder.setBindGroup(0, cameraBindGroup);
      encoder.setBindGroup(1, styleBindGroup);
      encoder.setVertexBuffer(0, vertexBuffer);
      encoder.setIndexBuffer(indexBuffer, 'uint16');

      // ⑥ 逐瓦片绘制（每个瓦片切换纹理 BindGroup）
      for (let i = 0; i < tileCount; i++) {
        const vt = currentVisibleTiles[i];
        if (vt.entry.bindGroup === null) {
          continue;
        }
        encoder.setBindGroup(2, vt.entry.bindGroup);
        encoder.drawIndexed(INDICES_PER_TILE, 1, 0, i * VERTS_PER_TILE, 0);
      }
    },

    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // 栅格瓦片无要素 ID，拾取 Pass 不提交绘制命令
    },

    // ══════ 属性方法 ══════

    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
      if (typeof value === 'number' && Number.isFinite(value)) {
        switch (name) {
          case 'raster-brightness-min':
          case 'raster-brightness-max':
            styleUniforms.brightness = value;
            styleDirty = true;
            break;
          case 'raster-contrast':
            styleUniforms.contrast = value;
            styleDirty = true;
            break;
          case 'raster-saturation':
            styleUniforms.saturation = value;
            styleDirty = true;
            break;
          case 'raster-hue-rotate':
            styleUniforms.hueRotate = value * DEG_TO_RAD;
            styleDirty = true;
            break;
          case 'raster-opacity':
            styleUniforms.opacity = value;
            break;
          case 'raster-fade-duration':
            fadeDurationMs = value;
            break;
          default:
            break;
        }
      }
    },

    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    setData(data: unknown): void {
      // 支持外部注入 URL 模板（由 Map2D 在 addSource 后传入）
      if (data !== null && data !== undefined && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        if (Array.isArray(record['tiles'])) {
          urlTemplates = record['tiles'] as string[];
        }
      }
    },

    getData(): unknown {
      return {
        cachedTiles: cache.size,
        loadingCount: inflightRequests.size,
        visibleCount: currentVisibleTiles.length,
        cacheBytes: cache.bytes,
      };
    },

    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ══════ 栅格特有样式方法 ══════

    setBrightness(value: number): void {
      if (!Number.isFinite(value) || value < BRIGHTNESS_MIN || value > BRIGHTNESS_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_BRIGHTNESS}] brightness must be in [-1, 1]`);
      }
      styleUniforms.brightness = value;
      paintProps.set('raster-brightness-min', value);
      styleDirty = true;
    },

    getBrightness(): number {
      return styleUniforms.brightness;
    },

    setContrast(value: number): void {
      if (!Number.isFinite(value) || value < CONTRAST_MIN || value > CONTRAST_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_CONTRAST}] contrast must be in [-1, 1]`);
      }
      styleUniforms.contrast = value;
      paintProps.set('raster-contrast', value);
      styleDirty = true;
    },

    getContrast(): number {
      return styleUniforms.contrast;
    },

    setSaturation(value: number): void {
      if (!Number.isFinite(value) || value < SATURATION_MIN || value > SATURATION_MAX) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_SATURATION}] saturation must be in [-1, 1]`);
      }
      styleUniforms.saturation = value;
      paintProps.set('raster-saturation', value);
      styleDirty = true;
    },

    getSaturation(): number {
      return styleUniforms.saturation;
    },

    setHueRotate(degrees: number): void {
      if (!Number.isFinite(degrees)) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_HUE_ROTATE}] hueRotate must be finite`);
      }
      styleUniforms.hueRotate = degrees * DEG_TO_RAD;
      paintProps.set('raster-hue-rotate', degrees);
      styleDirty = true;
    },

    getHueRotate(): number {
      return styleUniforms.hueRotate * RAD_TO_DEG;
    },

    setFadeDuration(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0`);
      }
      fadeDurationMs = ms;
      paintProps.set('raster-fade-duration', ms);
    },

    // ══════ 方案八 IdleDetector ══════

    waitForIdle(): Promise<void> {
      if (idlePendingCount === 0 && inflightRequests.size === 0 && pendingQueue.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleCallbacks.push(resolve);
      });
    },

    isIdle(): boolean {
      return idlePendingCount === 0 && inflightRequests.size === 0 && pendingQueue.length === 0;
    },
  };

  return layer;
}
