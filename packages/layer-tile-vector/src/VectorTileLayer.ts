// ============================================================
// VectorTileLayer.ts — 矢量瓦片图层（L4 图层包）
// 职责：管理矢量瓦片的生命周期（加载→Worker 解码→GPU 缓冲区→渲染），
//       维护每瓦片要素列表，支持 queryFeatures / queryRenderedFeatures，
//       按 source-layer 过滤要素。
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
// 错误码常量
// ---------------------------------------------------------------------------

/**
 * VectorTileLayer 模块错误码，前缀 `VECTOR_` 以避免跨模块碰撞。
 */
const VECTOR_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'VECTOR_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'VECTOR_INVALID_OPACITY',
  /** 图层类型不在支持列表中 */
  INVALID_RENDER_TYPE: 'VECTOR_INVALID_RENDER_TYPE',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 不透明度下限 */
const OPACITY_MIN = 0;

/** 不透明度上限 */
const OPACITY_MAX = 1;

/**
 * 支持的矢量渲染子类型集合。
 * 矢量瓦片图层的 `renderType` 决定 ShaderAssembler 选用哪组着色器模块。
 */
const SUPPORTED_RENDER_TYPES = new Set([
  'fill',
  'line',
  'circle',
  'symbol',
  'fill-extrusion',
]);

// ---------------------------------------------------------------------------
// VectorTileLayerOptions（外部配置接口）
// ---------------------------------------------------------------------------

/**
 * 矢量瓦片图层构造选项。
 * 由用户传入 `createVectorTileLayer`，驱动图层初始化。
 *
 * @example
 * const opts: VectorTileLayerOptions = {
 *   id: 'buildings',
 *   source: 'openmaptiles',
 *   sourceLayer: 'building',
 *   renderType: 'fill-extrusion',
 *   minzoom: 14,
 *   maxzoom: 22,
 *   filter: ['>', ['get', 'height'], 0],
 *   paint: {
 *     'fill-extrusion-color': '#aaa',
 *     'fill-extrusion-height': ['get', 'height'],
 *     'fill-extrusion-opacity': 0.8,
 *   },
 *   layout: { visibility: 'visible' },
 * };
 */
export interface VectorTileLayerOptions {
  /**
   * 图层唯一 ID，在同一地图实例内不得重复。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的矢量数据源 ID（对应 StyleSpec.sources 中的键名）。
   * 必填。
   */
  readonly source: string;

  /**
   * MVT 矢量瓦片中的子图层名称（source-layer）。
   * 一个矢量瓦片数据源通常包含多个逻辑子图层（如 'building', 'water', 'road'），
   * 此字段指定当前图层绑定哪一个子图层的要素。
   * 可选——若数据源仅含一个子图层可省略。
   */
  readonly sourceLayer?: string;

  /**
   * 渲染类型，决定使用哪套 GPU 管线和着色器模块。
   * 支持值：'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion'。
   * 必填。
   */
  readonly renderType: 'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion';

  /**
   * 要素过滤表达式（v8 样式规范 filter）。
   * 仅渲染满足此表达式的要素。
   * 可选——缺省渲染子图层的所有要素。
   */
  readonly filter?: FilterExpression;

  /**
   * paint 属性表（v8 样式规范 paint 属性子集）。
   * 具体可用键取决于 renderType，如 fill-color, line-width, circle-radius 等。
   * 值可以是常量或样式表达式。
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * layout 属性表（v8 样式规范 layout 属性子集）。
   * 具体可用键取决于 renderType，如 line-cap, symbol-placement 等。
   * 可选。
   */
  readonly layout?: Record<string, unknown>;

  /**
   * 图层可见的最小缩放级别（含）。
   * 范围 [0, 22]。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别（含）。
   * 范围 [0, 22]，必须 ≥ minzoom。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 图层初始不透明度。
   * 范围 [0, 1]。
   * 可选，默认 1。
   */
  readonly opacity?: number;

  /**
   * 投影标识。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;
}

// ---------------------------------------------------------------------------
// 内部：每瓦片要素缓存
// ---------------------------------------------------------------------------

/**
 * 单个矢量瓦片的已解码要素数据。
 * TileScheduler → Worker 解码 MVT → 主线程回传后填充此结构。
 *
 * @internal 仅模块内使用。
 */
interface VectorTileData {
  /** 瓦片 XYZ 坐标 */
  coord: TileCoord;

  /** 该瓦片中属于当前 source-layer 的要素列表 */
  features: Feature[];

  /** 瓦片加载完成的时间戳（performance.now() 毫秒） */
  loadedAt: number;
}

// ---------------------------------------------------------------------------
// VectorTileLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 矢量瓦片图层接口——在 Layer 基础上扩展要素查询和瓦片状态查询。
 * 实例由 `createVectorTileLayer` 工厂创建。
 *
 * @example
 * const layer = createVectorTileLayer({
 *   id: 'roads',
 *   source: 'openmaptiles',
 *   sourceLayer: 'transportation',
 *   renderType: 'line',
 *   paint: { 'line-color': '#888', 'line-width': 2 },
 * });
 * const hits = layer.queryFeatures({ west: 116, south: 39, east: 117, north: 40 });
 */
export interface VectorTileLayer extends Layer {
  /** 图层渲染子类型（'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion'） */
  readonly type: string;

  /** 当前所有已加载瓦片中可见要素总数 */
  readonly visibleFeatureCount: number;

  /** 已加载瓦片总数 */
  readonly loadedTileCount: number;

  /**
   * 按包围盒查询要素（CPU 端空间查询）。
   * 遍历所有已加载瓦片中的要素，返回几何包围盒与查询范围相交的要素。
   *
   * @param bbox - 查询包围盒（经纬度范围）
   * @param filter - 可选追加过滤表达式
   * @returns 匹配的要素数组（可能为空）
   *
   * @example
   * const features = layer.queryFeatures(
   *   { west: 116.3, south: 39.8, east: 116.5, north: 40.0 },
   *   ['==', ['get', 'class'], 'primary'],
   * );
   */
  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];

  /**
   * 按屏幕坐标查询渲染要素。
   * 使用 PickingEngine 在拾取 Pass 中查找屏幕坐标处命中的要素。
   * MVP 阶段返回空数组（完整实现需 GPU readback）。
   *
   * @param point - 屏幕像素坐标 [x, y]（CSS 像素，左上为原点）
   * @returns 命中的要素数组
   *
   * @example
   * const features = layer.queryRenderedFeatures([512, 384]);
   */
  queryRenderedFeatures(point: [number, number]): Feature[];
}

// ---------------------------------------------------------------------------
// 瓦片坐标→字符串键
// ---------------------------------------------------------------------------

/**
 * 将瓦片坐标序列化为唯一字符串键，用于 Map/Set 索引。
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
 * 校验并规范化 VectorTileLayerOptions。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项（带默认值）
 * @throws Error 若任何校验失败
 *
 * @example
 * const cfg = validateOptions({ id: 'roads', source: 's', renderType: 'line' });
 */
function validateOptions(opts: VectorTileLayerOptions): {
  id: string;
  source: string;
  sourceLayer: string | undefined;
  renderType: string;
  filter: FilterExpression | undefined;
  paint: Record<string, unknown> | undefined;
  layout: Record<string, unknown> | undefined;
  minzoom: number;
  maxzoom: number;
  opacity: number;
  projection: string;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_OPTIONS}] VectorTileLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_OPTIONS}] VectorTileLayerOptions.source must be a non-empty string`,
    );
  }

  // renderType 必须为支持的类型
  if (!SUPPORTED_RENDER_TYPES.has(opts.renderType)) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_RENDER_TYPE}] renderType must be one of ` +
        `${Array.from(SUPPORTED_RENDER_TYPES).join(', ')}, got '${opts.renderType}'`,
    );
  }

  // minzoom 校验
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  // maxzoom 校验
  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // opacity 校验
  const opacity = opts.opacity ?? OPACITY_MAX;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${VECTOR_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    sourceLayer: opts.sourceLayer?.trim(),
    renderType: opts.renderType,
    filter: opts.filter,
    paint: opts.paint,
    layout: opts.layout,
    minzoom,
    maxzoom,
    opacity,
    projection,
  };
}

// ---------------------------------------------------------------------------
// 几何包围盒辅助函数
// ---------------------------------------------------------------------------

/**
 * 从 Feature 的 geometry 坐标中计算 2D 包围盒。
 * 递归遍历所有坐标点，取经纬度的最小/最大值。
 * 处理 Point/LineString/Polygon/Multi* 所有几何类型。
 *
 * @param feature - 要计算包围盒的要素
 * @returns 包围盒，或 null（若几何为空或不可识别）
 *
 * @example
 * const bbox = featureBBox(myFeature);
 * if (bbox) console.log(bbox.west, bbox.south, bbox.east, bbox.north);
 */
function featureBBox(feature: Feature): BBox2D | null {
  const geom = feature.geometry;
  if (geom === null || geom === undefined) {
    return null;
  }

  // 收集所有坐标点到扁平数组
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let hasCoords = false;

  /**
   * 递归遍历坐标数组，更新包围盒边界。
   *
   * @param coords - 任意深度的坐标数组
   * @param depth - 当前递归深度（Point=0, LineString=1, Polygon=2, Multi=3）
   */
  function walkCoords(coords: unknown, depth: number): void {
    if (!Array.isArray(coords) || coords.length === 0) {
      return;
    }

    // 到达叶节点：coords 是 [number, number] 或 [number, number, number]
    if (depth === 0 && typeof coords[0] === 'number') {
      const lng = coords[0] as number;
      const lat = coords[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < west) west = lng;
        if (lng > east) east = lng;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        hasCoords = true;
      }
      return;
    }

    // 非叶节点：递归下一级
    for (const child of coords) {
      walkCoords(child, depth > 0 ? depth - 1 : 0);
    }
  }

  // 根据几何类型确定坐标数组的嵌套深度
  switch (geom.type) {
    case 'Point':
      // coordinates 本身就是 Position
      walkCoords(geom.coordinates, 0);
      break;
    case 'MultiPoint':
    case 'LineString':
      // coordinates 是 Position[]
      for (const pos of geom.coordinates) {
        walkCoords(pos, 0);
      }
      break;
    case 'MultiLineString':
    case 'Polygon':
      // coordinates 是 Position[][]
      for (const ring of geom.coordinates) {
        for (const pos of ring) {
          walkCoords(pos, 0);
        }
      }
      break;
    case 'MultiPolygon':
      // coordinates 是 Position[][][]
      for (const polygon of geom.coordinates) {
        for (const ring of polygon) {
          for (const pos of ring) {
            walkCoords(pos, 0);
          }
        }
      }
      break;
    case 'GeometryCollection':
      // 递归处理子几何
      for (const subGeom of geom.geometries) {
        const subFeature: Feature = {
          type: 'Feature',
          geometry: subGeom,
          properties: {},
        };
        const subBBox = featureBBox(subFeature);
        if (subBBox !== null) {
          if (subBBox.west < west) west = subBBox.west;
          if (subBBox.east > east) east = subBBox.east;
          if (subBBox.south < south) south = subBBox.south;
          if (subBBox.north > north) north = subBBox.north;
          hasCoords = true;
        }
      }
      break;
    default:
      return null;
  }

  if (!hasCoords) {
    return null;
  }

  return { west, south, east, north };
}

/**
 * 判断两个 2D 包围盒是否相交。
 * 使用分离轴定理（SAT）的简化版——轴对齐矩形仅需检查 4 个方向。
 *
 * @param a - 包围盒 A
 * @param b - 包围盒 B
 * @returns true 若相交（含边界接触）
 *
 * @example
 * bboxIntersects(
 *   { west: 0, south: 0, east: 10, north: 10 },
 *   { west: 5, south: 5, east: 15, north: 15 },
 * ); // true
 */
function bboxIntersects(a: BBox2D, b: BBox2D): boolean {
  // 分离轴：若任一轴上不重叠则不相交
  if (a.east < b.west || b.east < a.west) return false;
  if (a.north < b.south || b.north < a.south) return false;
  return true;
}

// ---------------------------------------------------------------------------
// createVectorTileLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建矢量瓦片图层实例。
 * 返回完整的 {@link VectorTileLayer} 实现，包含每瓦片要素管理、
 * 空间查询和 GPU 编码桩。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现——
 * 完整管线需要 L2/ShaderAssembler + PipelineCache 协同，
 * 将在后续 Sprint 接入。
 *
 * @param opts - 矢量图层构造选项
 * @returns 完整的 VectorTileLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const vectorLayer = createVectorTileLayer({
 *   id: 'water',
 *   source: 'openmaptiles',
 *   sourceLayer: 'water',
 *   renderType: 'fill',
 *   paint: { 'fill-color': '#0f3460' },
 * });
 * sceneGraph.addLayer(vectorLayer);
 */
export function createVectorTileLayer(opts: VectorTileLayerOptions): VectorTileLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateOptions(opts);

  // ── 2. 内部状态 ──

  // 已加载瓦片的要素数据（key = "z/x/y"）
  const loadedTiles = new Map<string, VectorTileData>();

  // paint 属性缓存
  const paintProps = new Map<string, unknown>();

  // layout 属性缓存
  const layoutProps = new Map<string, unknown>();

  // 要素状态表（featureId → state）
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 当前绑定的过滤表达式（运行时可通过上层 LayerManager.setFilter 变更）
  let activeFilter: FilterExpression | undefined = cfg.filter;

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

  // 图层是否已挂载
  let mounted = false;

  // 引擎上下文引用
  let layerContext: LayerContext | null = null;

  // 数据就绪标记
  let dataReady = false;

  // 当前帧可见要素计数（每帧 onUpdate 重新计算）
  let currentVisibleFeatureCount = 0;

  // ── 3. 构造 Layer 实现对象 ──
  const layer: VectorTileLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: cfg.renderType,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: cfg.opacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪（至少一个瓦片解码完成）。
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 是否包含半透明内容。
     * 矢量图层在不透明度 < 1 或 paint 中指定了半透明样式时为 true。
     */
    get isTransparent(): boolean {
      if (layer.opacity < OPACITY_MAX) return true;
      // 检查常见的透明度 paint 属性
      const fillOpacity = paintProps.get('fill-opacity');
      if (typeof fillOpacity === 'number' && fillOpacity < OPACITY_MAX) return true;
      const fillExtrusionOpacity = paintProps.get('fill-extrusion-opacity');
      if (typeof fillExtrusionOpacity === 'number' && fillExtrusionOpacity < OPACITY_MAX) return true;
      return false;
    },

    /**
     * 全局渲染次序。
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前所有已加载瓦片中的可见要素总数。
     */
    get visibleFeatureCount(): number {
      return currentVisibleFeatureCount;
    },

    /**
     * 已加载的瓦片总数。
     */
    get loadedTileCount(): number {
      return loadedTiles.size;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载到场景。
     *
     * @param context - 引擎上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
    },

    /**
     * 图层从场景卸载——释放所有内部数据。
     */
    onRemove(): void {
      loadedTiles.clear();
      featureStateMap.clear();
      mounted = false;
      layerContext = null;
      dataReady = false;
      currentVisibleFeatureCount = 0;
    },

    /**
     * 每帧更新——统计可见要素数、执行缩放过滤。
     *
     * @param deltaTime - 距上一帧时间（秒）
     * @param camera - 当前相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      const zoom = camera.zoom;

      // 缩放级别可见性判断
      if (zoom < cfg.minzoom || zoom > cfg.maxzoom) {
        currentVisibleFeatureCount = 0;
        return;
      }

      // 统计可见要素总数（MVP：所有已加载瓦片中的要素均视为可见）
      let count = 0;
      for (const tileData of loadedTiles.values()) {
        count += tileData.features.length;
      }
      currentVisibleFeatureCount = count;
    },

    /**
     * 将矢量要素绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现——完整管线需要 ShaderAssembler + PipelineCache。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要以下步骤：
      // 1. setPipeline(vectorPipeline) -- 根据 renderType 选用管线
      // 2. 遍历可见瓦片：
      //    a. setBindGroup(0, globalUniforms)
      //    b. setBindGroup(1, tileUniforms)
      //    c. setVertexBuffer(0, tileVertexBuffer) -- Worker 解码生成的几何缓冲区
      //    d. setIndexBuffer(tileIndexBuffer)
      //    e. drawIndexed(indexCount)
      if (__DEV__) {
        if (currentVisibleFeatureCount > 0) {
          console.debug(
            `[VectorTileLayer:${cfg.id}] encode stub: ` +
              `${loadedTiles.size} tiles, ${currentVisibleFeatureCount} features, ` +
              `renderType=${cfg.renderType}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——使用要素 ID 编码颜色以支持 GPU 拾取。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现使用 feature ID → color 编码进行 GPU 拾取
    },

    // ==================== 样式属性方法 ====================

    /**
     * 设置 paint 属性值。
     *
     * @param name - paint 属性名
     * @param value - 属性值
     */
    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
    },

    /**
     * 设置 layout 属性值。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      // 同步 visibility
      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性。
     *
     * @param name - 属性名
     * @returns 属性值或 undefined
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性。
     *
     * @param name - 属性名
     * @returns 属性值或 undefined
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 注入瓦片解码后的要素数据。
     * 由 TileScheduler 回调 → SourceManager → Layer.setData 调用链注入。
     *
     * @param data - 瓦片数据对象，应包含 coord 和 features 字段
     */
    setData(data: unknown): void {
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 校验 coord 字段
      if (
        record['coord'] === undefined ||
        record['coord'] === null ||
        typeof record['coord'] !== 'object'
      ) {
        return;
      }

      const coord = record['coord'] as TileCoord;

      // 校验坐标有效性
      if (
        !Number.isFinite(coord.x) || coord.x < 0 ||
        !Number.isFinite(coord.y) || coord.y < 0 ||
        !Number.isFinite(coord.z) || coord.z < 0
      ) {
        return;
      }

      // 提取要素数组，非数组时使用空数组
      const rawFeatures = Array.isArray(record['features']) ? record['features'] as Feature[] : [];

      // 如果指定了 sourceLayer，过滤要素中 _layerId 或 _sourceId 匹配的子集
      // MVT 解码结果中，每个要素通常携带所属 source-layer 的标记
      const filteredFeatures = cfg.sourceLayer
        ? rawFeatures.filter((f) => {
            // 匹配来自相同 source-layer 的要素
            const layerMatch = f._layerId === cfg.sourceLayer;
            // 备选：部分解码器将 source-layer 存在 properties._sourceLayer 中
            const propsMatch =
              f.properties !== null &&
              f.properties !== undefined &&
              (f.properties as Record<string, unknown>)['_sourceLayer'] === cfg.sourceLayer;
            return layerMatch || propsMatch;
          })
        : rawFeatures;

      // 存入缓存
      const key = tileKey(coord);
      loadedTiles.set(key, {
        coord,
        features: filteredFeatures,
        loadedAt: performance.now(),
      });

      // 标记数据就绪
      dataReady = true;
    },

    /**
     * 读取已加载数据的快照。
     *
     * @returns 包含已加载瓦片信息的对象
     */
    getData(): unknown {
      const tiles: Array<{ coord: TileCoord; featureCount: number }> = [];
      for (const tileData of loadedTiles.values()) {
        tiles.push({ coord: tileData.coord, featureCount: tileData.features.length });
      }
      return { tiles, totalFeatures: currentVisibleFeatureCount };
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素级状态（如高亮、选中）。
     *
     * @param featureId - 要素 ID
     * @param state - 状态键值对
     */
    setFeatureState(featureId: string, state: Record<string, unknown>): void {
      featureStateMap.set(featureId, { ...state });
    },

    /**
     * 读取要素级状态。
     *
     * @param featureId - 要素 ID
     * @returns 状态对象或 undefined
     */
    getFeatureState(featureId: string): Record<string, unknown> | undefined {
      return featureStateMap.get(featureId);
    },

    // ==================== 查询方法 ====================

    /**
     * 按包围盒查询要素（CPU 端）。
     * 遍历所有已加载瓦片中的要素，返回几何包围盒与查询范围相交的要素。
     *
     * @param bbox - 查询包围盒
     * @param filter - 可选追加过滤表达式（MVP 阶段不求值，保留签名兼容性）
     * @returns 匹配要素数组
     */
    queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[] {
      const results: Feature[] = [];

      // 校验输入包围盒的有效性
      if (
        !Number.isFinite(bbox.west) || !Number.isFinite(bbox.south) ||
        !Number.isFinite(bbox.east) || !Number.isFinite(bbox.north)
      ) {
        return results;
      }

      // 遍历所有已加载瓦片
      for (const tileData of loadedTiles.values()) {
        // 遍历瓦片内的每个要素
        for (const feature of tileData.features) {
          // 计算要素的包围盒
          const fBBox = featureBBox(feature);
          if (fBBox === null) {
            continue;
          }

          // 检查包围盒相交
          if (bboxIntersects(bbox, fBBox)) {
            results.push(feature);
          }
        }
      }

      return results;
    },

    /**
     * 按屏幕坐标查询渲染要素。
     * MVP 阶段：返回空数组（完整实现需要 GPU PickingEngine readback）。
     *
     * @param point - 屏幕像素坐标 [x, y]
     * @returns 命中要素数组
     */
    queryRenderedFeatures(point: [number, number]): Feature[] {
      // 校验输入坐标有效性
      if (
        !Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])
      ) {
        return [];
      }

      // MVP: 无法在 CPU 端精确做屏幕坐标→要素的反投影匹配，
      // 完整实现需要 GPU PickingEngine 的 readback 结果
      return [];
    },
  };

  return layer;
}

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;
