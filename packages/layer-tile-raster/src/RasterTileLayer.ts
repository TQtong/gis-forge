// ============================================================
// RasterTileLayer.ts — 栅格瓦片图层（L4 图层包）
// 职责：管理栅格瓦片的生命周期（加载→解码→纹理→渐显），
//       维护样式 Uniform（亮度/对比度/饱和度/色相旋转），
//       在 encode() 中提交绘制命令（MVP 阶段为桩实现）。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// 错误码常量（机器可读，便于日志聚合与 CI 监控）
// ---------------------------------------------------------------------------

/**
 * RasterTileLayer 模块错误码，前缀 `RASTER_` 以避免跨模块碰撞。
 */
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
  /** 瓦片坐标校验失败 */
  INVALID_TILE_COORD: 'RASTER_INVALID_TILE_COORD',
  /** 纹理句柄为空 */
  NULL_TEXTURE_HANDLE: 'RASTER_NULL_TEXTURE_HANDLE',
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

// ---------------------------------------------------------------------------
// RasterTileLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层构造选项。
 * 由用户传入 `createRasterTileLayer`，驱动图层初始化。
 *
 * @example
 * const opts: RasterTileLayerOptions = {
 *   id: 'satellite',
 *   source: 'mapbox-satellite',
 *   tileSize: 512,
 *   opacity: 0.9,
 *   minzoom: 0,
 *   maxzoom: 19,
 *   fadeDuration: 200,
 *   projection: 'mercator',
 *   paint: {
 *     'raster-brightness-min': 0,
 *     'raster-brightness-max': 1,
 *     'raster-contrast': 0,
 *     'raster-saturation': 0,
 *     'raster-hue-rotate': 0,
 *     'raster-opacity': 1,
 *   },
 * };
 */
export interface RasterTileLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的栅格数据源 ID（对应 StyleSpec.sources 中的键名）。
   * 必填。
   */
  readonly source: string;

  /**
   * 瓦片像素尺寸（正方形边长）。
   * 影响 GPU 纹理大小和 LOD 选择。
   * 常见值：256（经典）或 512（高清，减少请求数）。
   * 可选，默认 256。
   */
  readonly tileSize?: number;

  /**
   * 图层初始不透明度。
   * 范围 [0, 1]，0 = 完全透明，1 = 完全不透明。
   * 可选，默认 1。
   */
  readonly opacity?: number;

  /**
   * 图层可见的最小缩放级别（含）。
   * 低于此级别时图层不渲染。
   * 范围 [0, 22]。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 超过此级别时使用 maxzoom 级别的瓦片进行 overscaling。
   * 范围 [0, 22]，必须 ≥ minzoom。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 瓦片加载后的渐显动画时长（毫秒）。
   * 0 = 立即显示（无渐显），正值为渐变持续时间。
   * 可选，默认 300。
   */
  readonly fadeDuration?: number;

  /**
   * 投影标识（对应 SceneGraph 的投影分组键）。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * paint 属性表（v8 样式规范 raster paint 属性子集）。
   * 支持键：
   * - `'raster-brightness-min'`: 亮度下限 [0,1]，默认 0
   * - `'raster-brightness-max'`: 亮度上限 [0,1]，默认 1
   * - `'raster-contrast'`: 对比度 [-1,1]，默认 0
   * - `'raster-saturation'`: 饱和度 [-1,1]，默认 0
   * - `'raster-hue-rotate'`: 色相旋转角度（度），默认 0
   * - `'raster-opacity'`: 不透明度 [0,1]，默认 1
   * - `'raster-fade-duration'`: 渐显时长（毫秒），默认 300
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * layout 属性表（v8 样式规范 raster layout 属性子集）。
   * 支持键：
   * - `'visibility'`: `'visible'` | `'none'`，默认 `'visible'`
   * 可选。
   */
  readonly layout?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RasterStyleUniforms（GPU Uniform 数据结构）
// ---------------------------------------------------------------------------

/**
 * 栅格图层样式 Uniform 数据，对应 WGSL 中 `struct RasterUniforms`。
 * 所有数值均在 CPU 端归一化/预计算，每帧上传到 GPU Uniform Buffer。
 *
 * @internal 仅模块内使用，不导出为公共 API。
 */
interface RasterStyleUniforms {
  /** 亮度偏移量，范围 [-1, 1]，0 = 无变化 */
  brightness: number;

  /** 对比度倍率，范围 [-1, 1]，0 = 无变化。GPU 端公式：c' = (c - 0.5) × (1 + contrast) + 0.5 */
  contrast: number;

  /** 饱和度倍率，范围 [-1, 1]，0 = 无变化。GPU 端公式：s' = mix(gray, c, 1 + saturation) */
  saturation: number;

  /** 色相旋转角度（弧度），0 = 无旋转。在 GPU 端对 HSL 的 H 通道做偏移 */
  hueRotate: number;

  /** 最终不透明度 [0, 1]，乘以每瓦片 fadeProgress 得到实际 alpha */
  opacity: number;
}

// ---------------------------------------------------------------------------
// RasterTileRenderData（每瓦片渲染数据）
// ---------------------------------------------------------------------------

/**
 * 单个栅格瓦片的渲染数据包。
 * 由 TileScheduler 加载完成后填充，encode() 遍历此结构提交绘制命令。
 *
 * @internal 仅模块内使用，不导出为公共 API。
 */
interface RasterTileRenderData {
  /** 瓦片 XYZ 坐标，标识在金字塔中的位置 */
  coord: TileCoord;

  /**
   * GPU 纹理句柄 ID（由 TextureManager 分配）。
   * MVP 阶段使用 number 占位；后续接入 L1/TextureManager 后替换为实际句柄。
   */
  textureHandle: number;

  /** 瓦片覆盖的地理范围（经纬度包围盒），用于视锥体剔除和顶点计算 */
  extent: BBox2D;

  /**
   * 瓦片四边形顶点缓冲区 ID（由 BufferPool 分配）。
   * 标准栅格瓦片为两个三角形组成的矩形（4 顶点 6 索引）。
   * MVP 阶段使用 number 占位。
   */
  vertexBufferHandle: number;

  /** 瓦片数据加载完成的时间戳（performance.now() 毫秒） */
  loadedAt: number;

  /**
   * 渐显进度 [0, 1]。
   * 0 = 刚加载（完全透明），1 = 渐显完成（完全不透明）。
   * 每帧在 onUpdate 中递增，速率由 fadeDuration 控制。
   */
  fadeProgress: number;
}

// ---------------------------------------------------------------------------
// RasterTileLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 栅格瓦片图层接口——在 Layer 基础上扩展栅格特有的样式控制和状态查询。
 * 实例由 `createRasterTileLayer` 工厂创建。
 *
 * @example
 * const layer = createRasterTileLayer({ id: 'sat', source: 'satellite' });
 * layer.setBrightness(0.1);
 * layer.setSaturation(-0.3);
 * console.log(layer.visibleTiles); // 当前帧可见瓦片数
 */
export interface RasterTileLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'raster'` */
  readonly type: 'raster';

  /** 当前帧内可见（已加载且在视口内）的瓦片数量 */
  readonly visibleTiles: number;

  /** 正在加载中的瓦片数量 */
  readonly loadingTiles: number;

  /** 缓存中（已加载但可能不在视口）的瓦片总数 */
  readonly cachedTileCount: number;

  /**
   * 设置亮度偏移。
   *
   * @param value - 亮度偏移量，范围 [-1, 1]，0 = 无变化
   * @throws 若 value 不是有限数或超出 [-1,1] 范围
   *
   * @example
   * layer.setBrightness(0.2); // 增加亮度
   */
  setBrightness(value: number): void;

  /**
   * 获取当前亮度偏移。
   *
   * @returns 亮度偏移量，范围 [-1, 1]
   */
  getBrightness(): number;

  /**
   * 设置对比度。
   *
   * @param value - 对比度倍率，范围 [-1, 1]，0 = 无变化
   * @throws 若 value 不是有限数或超出 [-1,1] 范围
   *
   * @example
   * layer.setContrast(0.5); // 增强对比度
   */
  setContrast(value: number): void;

  /**
   * 获取当前对比度。
   *
   * @returns 对比度倍率，范围 [-1, 1]
   */
  getContrast(): number;

  /**
   * 设置饱和度。
   *
   * @param value - 饱和度倍率，范围 [-1, 1]，0 = 无变化，-1 = 灰度
   * @throws 若 value 不是有限数或超出 [-1,1] 范围
   *
   * @example
   * layer.setSaturation(-1); // 完全去饱和（灰度）
   */
  setSaturation(value: number): void;

  /**
   * 获取当前饱和度。
   *
   * @returns 饱和度倍率，范围 [-1, 1]
   */
  getSaturation(): number;

  /**
   * 设置色相旋转角度。
   *
   * @param degrees - 旋转角度（度），正值顺时针，可超出 [0,360) 自动取模
   * @throws 若 degrees 不是有限数
   *
   * @example
   * layer.setHueRotate(90); // 色相偏移 90°
   */
  setHueRotate(degrees: number): void;

  /**
   * 获取当前色相旋转角度。
   *
   * @returns 旋转角度（度）
   */
  getHueRotate(): number;

  /**
   * 设置瓦片渐显时长。
   *
   * @param ms - 渐显时长（毫秒），0 = 无渐显，必须 ≥ 0
   * @throws 若 ms 不是有限非负数
   *
   * @example
   * layer.setFadeDuration(500); // 500ms 渐显
   */
  setFadeDuration(ms: number): void;
}

// ---------------------------------------------------------------------------
// 瓦片坐标→字符串键（用于 Map 索引）
// ---------------------------------------------------------------------------

/**
 * 将瓦片坐标序列化为唯一字符串键，用于 Map/Set 索引。
 * 格式 `z/x/y`，保证同一坐标总是产出相同键。
 *
 * @param coord - 瓦片 XYZ 坐标
 * @returns 形如 `"8/215/99"` 的字符串
 *
 * @example
 * tileKey({ x: 215, y: 99, z: 8 }); // '8/215/99'
 */
function tileKey(coord: TileCoord): string {
  return `${coord.z}/${coord.x}/${coord.y}`;
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 RasterTileLayerOptions。
 * 对必填字段做空检查，对可选数值字段做范围校验。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项（带默认值）
 * @throws GeoForgeError 若任何校验失败
 *
 * @example
 * const normalized = validateOptions({ id: 'sat', source: 's1' });
 */
function validateOptions(opts: RasterTileLayerOptions): Required<
  Pick<RasterTileLayerOptions, 'id' | 'source' | 'tileSize' | 'opacity' | 'minzoom' | 'maxzoom' | 'fadeDuration' | 'projection'>
> & Pick<RasterTileLayerOptions, 'paint' | 'layout'> {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPTIONS}] RasterTileLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPTIONS}] RasterTileLayerOptions.source must be a non-empty string`,
    );
  }

  // 解析 tileSize，校验为正整数
  const tileSize = opts.tileSize ?? DEFAULT_TILE_SIZE;
  if (!Number.isFinite(tileSize) || tileSize <= 0 || Math.floor(tileSize) !== tileSize) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPTIONS}] tileSize must be a positive integer, got ${tileSize}`,
    );
  }

  // 解析 opacity，校验范围 [0, 1]
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  // 解析 minzoom，校验范围 [0, 22]
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  // 解析 maxzoom，校验范围 [minzoom, 22]
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // 解析 fadeDuration，必须为非负有限数
  const fadeDuration = opts.fadeDuration ?? DEFAULT_FADE_DURATION_MS;
  if (!Number.isFinite(fadeDuration) || fadeDuration < 0) {
    throw new Error(
      `[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0, got ${fadeDuration}`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    tileSize,
    opacity,
    minzoom,
    maxzoom,
    fadeDuration,
    projection,
    paint: opts.paint,
    layout: opts.layout,
  };
}

// ---------------------------------------------------------------------------
// 从 paint 属性表中解析初始样式 Uniform
// ---------------------------------------------------------------------------

/**
 * 从用户传入的 paint 属性字典中提取栅格样式 Uniform 初始值。
 * 无效或缺失的键回退到默认值，保证返回的结构始终合法。
 *
 * @param paint - 用户 paint 属性表，可能为 undefined
 * @param baseOpacity - 图层级不透明度（作为 raster-opacity 的默认值）
 * @returns 完整的 RasterStyleUniforms 对象
 *
 * @example
 * const u = parseStyleUniforms({ 'raster-contrast': 0.5 }, 1);
 * // u.contrast === 0.5, u.brightness === 0, u.saturation === 0, ...
 */
function parseStyleUniforms(
  paint: Record<string, unknown> | undefined,
  baseOpacity: number,
): RasterStyleUniforms {
  // 安全地从 paint 中读取数值，无效值回退到默认
  const readNum = (key: string, fallback: number): number => {
    if (paint === undefined || paint === null) {
      return fallback;
    }
    const v = paint[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    return fallback;
  };

  // 亮度：raster-brightness-min/max 合并为单一 brightness 偏移
  // MapLibre 有 min/max 两个属性；GeoForge 简化为单一 brightness 偏移
  const brightness = readNum('raster-brightness-min', 0);

  // 对比度
  const contrast = readNum('raster-contrast', 0);

  // 饱和度
  const saturation = readNum('raster-saturation', 0);

  // 色相旋转（度→弧度）
  const hueRotateDeg = readNum('raster-hue-rotate', 0);
  const hueRotate = (hueRotateDeg * Math.PI) / 180;

  // 不透明度，优先取 paint 中的 raster-opacity，否则用构造选项的 opacity
  const opacity = readNum('raster-opacity', baseOpacity);

  return { brightness, contrast, saturation, hueRotate, opacity };
}

// ---------------------------------------------------------------------------
// 度 → 弧度 / 弧度 → 度
// ---------------------------------------------------------------------------

/** 角度→弧度的乘法常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度→角度的乘法常量 */
const RAD_TO_DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// createRasterTileLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建栅格瓦片图层实例。
 * 返回完整的 {@link RasterTileLayer} 实现，包含瓦片状态管理、
 * 样式 Uniform 维护和渐显动画逻辑。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现——
 * 完整管线需要 L2/ShaderAssembler + PipelineCache + FrameGraphBuilder 协同，
 * 将在后续 Sprint 接入。
 *
 * @param opts - 栅格图层构造选项
 * @returns 完整的 RasterTileLayer 实例
 * @throws GeoForgeError 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const rasterLayer = createRasterTileLayer({
 *   id: 'satellite',
 *   source: 'mapbox-satellite',
 *   tileSize: 512,
 *   opacity: 0.85,
 *   fadeDuration: 250,
 *   paint: { 'raster-contrast': 0.2 },
 * });
 * sceneGraph.addLayer(rasterLayer);
 */
export function createRasterTileLayer(opts: RasterTileLayerOptions): RasterTileLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);

  // ── 2. 内部状态 ──

  // 已加载瓦片的渲染数据（key = "z/x/y"）
  const loadedTiles = new Map<string, RasterTileRenderData>();

  // 正在加载中的瓦片集合（key = "z/x/y"）
  const loadingSet = new Set<string>();

  // 当前帧可见瓦片的 key 集合（每帧 onUpdate 重建）
  const visibleSet = new Set<string>();

  // 样式 Uniform（CPU 端，每帧可能更新后上传 GPU）
  const styleUniforms: RasterStyleUniforms = parseStyleUniforms(cfg.paint, cfg.opacity);

  // 渐显时长（毫秒），运行时可通过 setFadeDuration 修改
  let fadeDurationMs = cfg.fadeDuration;

  // paint/layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表（栅格图层一般不使用，但 Layer 接口要求）
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化 paint 属性缓存
  if (cfg.paint) {
    for (const k of Object.keys(cfg.paint)) {
      paintProps.set(k, cfg.paint[k]);
    }
  }

  // 初始化 layout 属性缓存
  if (cfg.layout) {
    for (const k of Object.keys(cfg.layout)) {
      layoutProps.set(k, cfg.layout[k]);
    }
  }

  // 图层是否已挂载到场景（onAdd 后为 true，onRemove 后为 false）
  let mounted = false;

  // 图层上下文引用（onAdd 时注入）
  let layerContext: LayerContext | null = null;

  // 数据是否就绪标记（至少有一个瓦片加载完成后为 true）
  let dataReady = false;

  // ── 3. 构造 Layer 实现对象 ──
  const layer: RasterTileLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'raster' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（至少一个瓦片完成加载）。
     * @returns true 表示有可渲染内容
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 是否包含半透明内容。
     * 栅格图层在不透明度 < 1 或存在渐显动画时视为半透明。
     * @returns true 表示需要参与透明排序
     */
    get isTransparent(): boolean {
      // 不透明度小于 1 时为半透明
      if (styleUniforms.opacity < OPACITY_MAX) {
        return true;
      }
      // 存在未完成渐显的瓦片时为半透明
      for (const tile of loadedTiles.values()) {
        if (tile.fadeProgress < FADE_COMPLETE_THRESHOLD) {
          return true;
        }
      }
      return false;
    },

    /**
     * 全局渲染次序（与 zIndex 同步，由 LayerManager 协调）。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前帧可见瓦片数。
     * @returns 可见瓦片计数
     */
    get visibleTiles(): number {
      return visibleSet.size;
    },

    /**
     * 正在加载中的瓦片数。
     * @returns 加载中瓦片计数
     */
    get loadingTiles(): number {
      return loadingSet.size;
    },

    /**
     * 缓存中的总瓦片数（含不在视口中的）。
     * @returns 缓存瓦片计数
     */
    get cachedTileCount(): number {
      return loadedTiles.size;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载时由 LayerManager 调用。
     * 保存引擎上下文引用，后续用于 GPU 资源创建和 TileScheduler 绑定。
     *
     * @param context - 引擎注入的上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
    },

    /**
     * 图层卸载时由 LayerManager 调用。
     * 释放所有瓦片渲染数据，清理内部状态。
     */
    onRemove(): void {
      // 清空所有瓦片数据（GPU 纹理释放由 TextureManager 引用计数处理）
      loadedTiles.clear();
      loadingSet.clear();
      visibleSet.clear();
      featureStateMap.clear();

      // 重置标志
      mounted = false;
      layerContext = null;
      dataReady = false;
    },

    /**
     * 每帧更新——推进渐显动画、判断缩放可见性。
     * 由 FrameScheduler 在 UPDATE 阶段调用。
     *
     * @param deltaTime - 距上一帧的时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // ── 缩放级别可见性判断 ──
      const zoom = camera.zoom;
      if (zoom < cfg.minzoom || zoom > cfg.maxzoom) {
        // 当前缩放级别超出图层范围，清空可见集合但保留缓存
        visibleSet.clear();
        return;
      }

      // ── 重建本帧可见瓦片集合 ──
      visibleSet.clear();

      // 将 deltaTime（秒）转换为毫秒，用于渐显进度计算
      const dtMs = deltaTime * 1000;

      // 遍历所有已加载瓦片，推进渐显动画并标记可见
      for (const [key, tileData] of loadedTiles) {
        // 推进渐显动画（fadeDurationMs=0 时直接置为完成）
        if (tileData.fadeProgress < FADE_COMPLETE_THRESHOLD) {
          if (fadeDurationMs <= 0) {
            // 无渐显，直接完成
            tileData.fadeProgress = FADE_COMPLETE_THRESHOLD;
          } else {
            // 线性递增：每帧增加 dt / fadeDuration
            tileData.fadeProgress = Math.min(
              FADE_COMPLETE_THRESHOLD,
              tileData.fadeProgress + dtMs / fadeDurationMs,
            );
          }
        }

        // MVP: 所有已加载瓦片均标记为可见
        // 完整实现需要视锥体剔除（Camera frustum vs tile extent）
        visibleSet.add(key);
      }
    },

    /**
     * 将栅格瓦片绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现——完整管线需要 ShaderAssembler + PipelineCache。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要以下步骤：
      // 1. setPipeline(rasterPipeline)
      // 2. 遍历 visibleSet 中每个瓦片：
      //    a. setBindGroup(0, globalUniforms)
      //    b. setBindGroup(1, tileTexture + sampler + styleUniforms)
      //    c. setVertexBuffer(0, tileQuadVBO)
      //    d. drawIndexed(6)  -- 两个三角形组成的矩形
      if (__DEV__) {
        if (visibleSet.size > 0) {
          console.debug(
            `[RasterTileLayer:${cfg.id}] encode stub: ${visibleSet.size} visible tiles, ` +
              `brightness=${styleUniforms.brightness.toFixed(2)}, ` +
              `contrast=${styleUniforms.contrast.toFixed(2)}, ` +
              `opacity=${styleUniforms.opacity.toFixed(2)}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——栅格图层不支持要素级拾取（无几何特征），
     * 仅报告是否命中图层区域。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // 栅格瓦片无要素 ID，拾取 Pass 中不提交绘制命令
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性值。
     * 支持 raster-brightness-min/max, raster-contrast, raster-saturation,
     * raster-hue-rotate, raster-opacity, raster-fade-duration。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);

      // 同步到样式 Uniform
      if (typeof value === 'number' && Number.isFinite(value)) {
        switch (name) {
          case 'raster-brightness-min':
          case 'raster-brightness-max':
            styleUniforms.brightness = value;
            break;
          case 'raster-contrast':
            styleUniforms.contrast = value;
            break;
          case 'raster-saturation':
            styleUniforms.saturation = value;
            break;
          case 'raster-hue-rotate':
            // paint 属性中色相旋转以度为单位，转为弧度存储
            styleUniforms.hueRotate = value * DEG_TO_RAD;
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

    /**
     * 设置 layout 属性值。
     * 支持 'visibility'（'visible' | 'none'）。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      // 同步 visibility 到 Layer.visible
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性值。
     *
     * @param name - paint 属性名
     * @returns 属性值，或 undefined 若未设置
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性值。
     *
     * @param name - layout 属性名
     * @returns 属性值，或 undefined 若未设置
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法（栅格不支持 setData） ====================

    /**
     * 设置原始数据——栅格图层不支持直接 setData（数据由 TileScheduler 管理），
     * 此方法为 Layer 接口兼容性保留，接受瓦片加载结果并注入到 loadedTiles。
     *
     * @param data - 瓦片加载结果对象，需包含 coord/textureHandle/extent 字段
     */
    setData(data: unknown): void {
      // 类型守卫：确保传入对象包含必要字段
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 检查 coord 字段是否为合法 TileCoord
      if (
        record['coord'] === undefined ||
        record['coord'] === null ||
        typeof record['coord'] !== 'object'
      ) {
        return;
      }

      const coord = record['coord'] as TileCoord;

      // 校验坐标字段均为非负整数
      if (
        !Number.isFinite(coord.x) || coord.x < 0 ||
        !Number.isFinite(coord.y) || coord.y < 0 ||
        !Number.isFinite(coord.z) || coord.z < 0
      ) {
        return;
      }

      // 创建渲染数据并加入缓存
      const key = tileKey(coord);
      const renderData: RasterTileRenderData = {
        coord,
        textureHandle: typeof record['textureHandle'] === 'number' ? record['textureHandle'] : 0,
        extent: (record['extent'] as BBox2D) ?? { west: 0, south: 0, east: 0, north: 0 },
        vertexBufferHandle: typeof record['vertexBufferHandle'] === 'number' ? record['vertexBufferHandle'] : 0,
        loadedAt: performance.now(),
        fadeProgress: 0, // 从零开始渐显
      };

      loadedTiles.set(key, renderData);

      // 从加载中集合移除
      loadingSet.delete(key);

      // 标记数据就绪
      dataReady = true;
    },

    /**
     * 读取当前瓦片缓存快照（调试用途）。
     *
     * @returns 包含已加载瓦片坐标列表的对象
     */
    getData(): unknown {
      const coords: TileCoord[] = [];
      for (const tile of loadedTiles.values()) {
        coords.push(tile.coord);
      }
      return { loadedTiles: coords, loadingCount: loadingSet.size };
    },

    // ==================== 要素状态方法（栅格图层仅为接口兼容）====================

    /**
     * 设置要素状态——栅格图层无要素概念，但接口要求实现。
     * 状态存入内部 Map，可被上层查询。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态对象或 undefined
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 栅格特有样式方法 ====================

    /**
     * 设置亮度偏移。
     *
     * @param value - 范围 [-1, 1]
     */
    setBrightness(value: number): void {
      if (!Number.isFinite(value) || value < BRIGHTNESS_MIN || value > BRIGHTNESS_MAX) {
        throw new Error(
          `[${RASTER_ERROR_CODES.INVALID_BRIGHTNESS}] brightness must be in [-1, 1], got ${value}`,
        );
      }
      styleUniforms.brightness = value;
      paintProps.set('raster-brightness-min', value);
    },

    /**
     * 获取当前亮度。
     *
     * @returns 亮度偏移量
     */
    getBrightness(): number {
      return styleUniforms.brightness;
    },

    /**
     * 设置对比度。
     *
     * @param value - 范围 [-1, 1]
     */
    setContrast(value: number): void {
      if (!Number.isFinite(value) || value < CONTRAST_MIN || value > CONTRAST_MAX) {
        throw new Error(
          `[${RASTER_ERROR_CODES.INVALID_CONTRAST}] contrast must be in [-1, 1], got ${value}`,
        );
      }
      styleUniforms.contrast = value;
      paintProps.set('raster-contrast', value);
    },

    /**
     * 获取当前对比度。
     *
     * @returns 对比度倍率
     */
    getContrast(): number {
      return styleUniforms.contrast;
    },

    /**
     * 设置饱和度。
     *
     * @param value - 范围 [-1, 1]
     */
    setSaturation(value: number): void {
      if (!Number.isFinite(value) || value < SATURATION_MIN || value > SATURATION_MAX) {
        throw new Error(
          `[${RASTER_ERROR_CODES.INVALID_SATURATION}] saturation must be in [-1, 1], got ${value}`,
        );
      }
      styleUniforms.saturation = value;
      paintProps.set('raster-saturation', value);
    },

    /**
     * 获取当前饱和度。
     *
     * @returns 饱和度倍率
     */
    getSaturation(): number {
      return styleUniforms.saturation;
    },

    /**
     * 设置色相旋转角度。
     *
     * @param degrees - 旋转角度（度）
     */
    setHueRotate(degrees: number): void {
      if (!Number.isFinite(degrees)) {
        throw new Error(
          `[${RASTER_ERROR_CODES.INVALID_HUE_ROTATE}] hueRotate must be a finite number, got ${degrees}`,
        );
      }
      styleUniforms.hueRotate = degrees * DEG_TO_RAD;
      paintProps.set('raster-hue-rotate', degrees);
    },

    /**
     * 获取当前色相旋转角度。
     *
     * @returns 角度（度）
     */
    getHueRotate(): number {
      return styleUniforms.hueRotate * RAD_TO_DEG;
    },

    /**
     * 设置渐显时长。
     *
     * @param ms - 毫秒，≥ 0
     */
    setFadeDuration(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(
          `[${RASTER_ERROR_CODES.INVALID_FADE_DURATION}] fadeDuration must be >= 0, got ${ms}`,
        );
      }
      fadeDurationMs = ms;
      paintProps.set('raster-fade-duration', ms);
    },
  };

  return layer;
}

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建由 tree-shake 移除）
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;
