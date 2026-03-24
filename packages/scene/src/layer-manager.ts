// ============================================================
// layer-manager.ts — L4 图层注册、排序、可见性与生命周期
// 职责：按 LayerSpec 实例化图层（工厂或默认桩）、维护 id→Layer 映射并广播事件。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Layer } from './scene-graph.ts';
import { GeoForgeError } from './scene-graph.ts';

/**
 * LayerManager 使用的错误码。
 */
const LM_ERROR_CODES = {
  /** 图层 id 已存在 */
  DUPLICATE_LAYER: 'LAYER_MANAGER_DUPLICATE_LAYER',
  /** 图层 id 不存在 */
  LAYER_NOT_FOUND: 'LAYER_MANAGER_LAYER_NOT_FOUND',
  /** LayerSpec.id 非法 */
  INVALID_SPEC_ID: 'LAYER_MANAGER_INVALID_SPEC_ID',
  /** 透明度或 zIndex 越界 */
  INVALID_NUMERIC: 'LAYER_MANAGER_INVALID_NUMERIC',
  /** moveLayer 索引非法 */
  INVALID_INDEX: 'LAYER_MANAGER_INVALID_INDEX',
} as const;

/**
 * 图层工厂：由具体图层包注册，接收规格与上下文。
 *
 * @param spec - 图层规格
 * @param context - 引擎上下文（GPU/调度/样式等句柄）
 * @returns 图层实例
 */
export type LayerFactory = (spec: LayerSpec, context: LayerContext) => Layer;

/**
 * 图层规格（对标样式文档单层 + 运行时投影/可见性覆盖）。
 */
export interface LayerSpec {
  /** 全局唯一图层 id */
  readonly id: string;
  /** 图层类型，用于查找 `registerLayerType` 注册的工厂 */
  readonly type: string;
  /** 数据源 id */
  readonly source: string;
  /** MVT source-layer 名（矢量瓦片） */
  readonly sourceLayer?: string;
  /** 投影 id；缺省为 `mercator`，UI 叠加可用 `ui-overlay` */
  readonly projection?: string;
  /** 最小可见缩放级 */
  readonly minZoom?: number;
  /** 最大可见缩放级 */
  readonly maxZoom?: number;
  /** 初始可见性 */
  readonly visible?: boolean;
  /** 初始不透明度 [0,1] */
  readonly opacity?: number;
  /** 初始 zIndex */
  readonly zIndex?: number;
  /** 要素过滤器 */
  readonly filter?: FilterExpression;
  /** paint 属性表 */
  readonly paint?: Record<string, any>;
  /** layout 属性表 */
  readonly layout?: Record<string, any>;
  /** 任意元数据 */
  readonly metadata?: Record<string, any>;
}

/**
 * 引擎注入上下文（MVP：引用为可选，便于无 GPU 单测）。
 * 强类型模块就绪后可逐步收窄为具体类。
 */
export interface LayerContext {
  /** 当前 WebGPU 设备（未创建管线时可为 null） */
  readonly gpuDevice?: GPUDevice | null;
  /** 2D 画布或离屏表面尺寸提示（CSS 像素） */
  readonly canvasSize?: readonly [number, number];
  /** 扩展服务注册表（TileScheduler、WorkerPool 等） */
  readonly services?: Record<string, unknown>;
  /** 地图/引擎宿主引用（生命周期、事件总线） */
  readonly map?: unknown;
}

/**
 * 图层管理器：注册类型、创建/删除图层、批量属性变更、订阅事件。
 */
export interface LayerManager {
  /**
   * 按规格添加图层；若已注册工厂则走工厂，否则使用默认桩图层。
   *
   * @param spec - 图层规格
   * @returns 新图层实例
   */
  addLayer(spec: LayerSpec): Layer;

  /**
   * 移除图层并调用 `onRemove`。
   *
   * @param id - 图层 id
   */
  removeLayer(id: string): void;

  /**
   * 查询图层。
   *
   * @param id - 图层 id
   * @returns 图层或 undefined
   */
  getLayer(id: string): Layer | undefined;

  /**
   * 返回所有图层（按 zIndex 升序，同 zIndex 按 id 字典序稳定排序）。
   */
  getLayers(): Layer[];

  /**
   * 注册某 `type` 的工厂，后注册覆盖先注册。
   *
   * @param type - 图层类型字符串
   * @param factory - 工厂函数
   */
  registerLayerType(type: string, factory: LayerFactory): void;

  /**
   * 设置可见性并触发 `onLayerChanged('visible')`。
   *
   * @param id - 图层 id
   * @param visible - 是否可见
   */
  setVisibility(id: string, visible: boolean): void;

  /**
   * 设置不透明度并触发 `onLayerChanged('opacity')`。
   *
   * @param id - 图层 id
   * @param opacity - [0,1]
   */
  setOpacity(id: string, opacity: number): void;

  /**
   * 设置 zIndex 并触发 `onLayerChanged('zIndex')`。
   *
   * @param id - 图层 id
   * @param zIndex - 排序值
   */
  setZIndex(id: string, zIndex: number): void;

  /**
   * 设置过滤器并触发 `onLayerChanged('filter')`。
   *
   * @param id - 图层 id
   * @param filter - 过滤器或 null 清除
   */
  setFilter(id: string, filter: FilterExpression | null): void;

  /**
   * 读取过滤器（未设置则为 null）。
   *
   * @param id - 图层 id
   */
  getFilter(id: string): FilterExpression | null;

  /**
   * 按当前 zIndex 顺序重排：传入的 id 数组为从底到顶的新顺序。
   *
   * @param ids - 全量有序 id 列表
   */
  setLayerOrder(ids: string[]): void;

  /**
   * 将图层移动到全局顺序中的 `newIndex`（0=最底层）。
   *
   * @param id - 图层 id
   * @param newIndex - 目标下标
   */
  moveLayer(id: string, newIndex: number): void;

  /**
   * 订阅图层添加。
   *
   * @param callback - 回调
   * @returns 取消订阅函数
   */
  onLayerAdded(callback: (layer: Layer) => void): () => void;

  /**
   * 订阅图层移除。
   *
   * @param callback - 回调
   * @returns 取消订阅函数
   */
  onLayerRemoved(callback: (layerId: string) => void): () => void;

  /**
   * 订阅图层属性变化。
   *
   * @param callback - 回调（property 为变更字段名）
   * @returns 取消订阅函数
   */
  onLayerChanged(callback: (layerId: string, property: string) => void): () => void;
}

/**
 * 校验非空图层 id。
 *
 * @param id - 候选 id
 * @returns trim 后的 id
 *
 * @example
 * assertLayerId('  foo  '); // 'foo'
 */
function assertLayerId(id: string): string {
  const t = id.trim();
  if (t.length === 0) {
    throw new GeoForgeError(
      LM_ERROR_CODES.INVALID_SPEC_ID,
      'LayerSpec.id must be a non-empty string',
      { id },
    );
  }
  return t;
}

/**
 * 默认桩图层：完整实现 `Layer`，渲染与查询均为空操作，仅保存 paint/layout/状态。
 */
class DefaultStubLayer implements Layer {
  /** @inheritdoc */
  readonly id: string;

  /** @inheritdoc */
  readonly type: string;

  /** @inheritdoc */
  readonly source: string;

  /** @inheritdoc */
  readonly projection: string;

  /** @inheritdoc */
  visible: boolean;

  /** @inheritdoc */
  opacity: number;

  /** @inheritdoc */
  zIndex: number;

  /** @inheritdoc */
  readonly isLoaded: boolean;

  /** @inheritdoc */
  readonly isTransparent: boolean;

  /** paint 键值缓存 */
  private readonly _paint = new Map<string, any>();

  /** layout 键值缓存 */
  private readonly _layout = new Map<string, any>();

  /** 要素状态表 */
  private readonly _featureState = new Map<string, Record<string, any>>();

  /** 可选载荷 */
  private _data: any;

  /**
   * @param spec - 构造规格
   */
  constructor(spec: LayerSpec) {
    this.id = assertLayerId(spec.id);
    this.type = spec.type;
    this.source = spec.source;
    this.projection = (spec.projection ?? 'mercator').trim() || 'mercator';
    this.visible = spec.visible ?? true;
    if (spec.opacity !== undefined && spec.opacity !== null) {
      if (!Number.isFinite(spec.opacity) || spec.opacity < 0 || spec.opacity > 1) {
        throw new GeoForgeError(
          LM_ERROR_CODES.INVALID_NUMERIC,
          'LayerSpec.opacity must be finite and in [0,1]',
          { id: this.id, opacity: spec.opacity },
        );
      }
      this.opacity = spec.opacity;
    } else {
      this.opacity = 1;
    }
    if (spec.zIndex !== undefined && spec.zIndex !== null) {
      if (!Number.isFinite(spec.zIndex)) {
        throw new GeoForgeError(
          LM_ERROR_CODES.INVALID_NUMERIC,
          'LayerSpec.zIndex must be finite',
          { id: this.id, zIndex: spec.zIndex },
        );
      }
      this.zIndex = spec.zIndex;
    } else {
      this.zIndex = 0;
    }
    this.isLoaded = false;
    this.isTransparent = true;
    if (spec.paint) {
      for (const k of Object.keys(spec.paint)) {
        this._paint.set(k, spec.paint[k]);
      }
    }
    if (spec.layout) {
      for (const k of Object.keys(spec.layout)) {
        this._layout.set(k, spec.layout[k]);
      }
    }
  }

  /** @inheritdoc — 与 zIndex 对齐的渲染次序（桩实现无独立 renderOrder 通道） */
  get renderOrder(): number {
    return this.zIndex;
  }

  /** @inheritdoc */
  onAdd(_context: any): void {
    // MVP：不创建 GPU 资源；工厂图层可在子类中重写
  }

  /** @inheritdoc */
  onRemove(): void {
    // MVP：无 GPU 资源释放
  }

  /** @inheritdoc */
  onUpdate(_deltaTime: number, _camera: CameraState): void {
    // MVP：无动画/瓦片逻辑
  }

  /** @inheritdoc */
  encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
    // 桩图层不向 Pass 提交任何 draw/dispatch
  }

  /** @inheritdoc */
  encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
    // 桩图层无拾取几何
  }

  /** @inheritdoc */
  setData(data: any): void {
    this._data = data;
  }

  /** @inheritdoc */
  getData(): any {
    return this._data;
  }

  /** @inheritdoc */
  setPaintProperty(name: string, value: any): void {
    this._paint.set(name, value);
  }

  /** @inheritdoc */
  setLayoutProperty(name: string, value: any): void {
    this._layout.set(name, value);
  }

  /** @inheritdoc */
  getPaintProperty(name: string): any {
    return this._paint.get(name);
  }

  /** @inheritdoc */
  getLayoutProperty(name: string): any {
    return this._layout.get(name);
  }

  /** @inheritdoc */
  queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
    return [];
  }

  /** @inheritdoc */
  queryRenderedFeatures(_point: [number, number]): Feature[] {
    return [];
  }

  /** @inheritdoc */
  setFeatureState(featureId: string, state: Record<string, any>): void {
    this._featureState.set(featureId, { ...state });
  }

  /** @inheritdoc */
  getFeatureState(featureId: string): Record<string, any> | undefined {
    return this._featureState.get(featureId);
  }
}

/**
 * 创建默认桩图层（无注册工厂时使用）。
 *
 * @param spec - 图层规格
 * @returns 桩图层实例
 *
 * @example
 * const layer = createDefaultLayer({ id: 'x', type: 'fill', source: 's' });
 */
export function createDefaultLayer(spec: LayerSpec): Layer {
  return new DefaultStubLayer(spec);
}

/**
 * LayerManager 实现。
 */
class LayerManagerImpl implements LayerManager {
  /** id → 图层 */
  private readonly _layers = new Map<string, Layer>();

  /** type → 工厂 */
  private readonly _factories = new Map<string, LayerFactory>();

  /** 规范缓存：用于 getFilter 等（桩图层不持久 filter 字段时） */
  private readonly _filterById = new Map<string, FilterExpression | null>();

  /** 注入上下文 */
  private readonly _context: LayerContext;

  /** 添加回调 */
  private readonly _onAdded: Array<(layer: Layer) => void> = [];

  /** 移除回调 */
  private readonly _onRemoved: Array<(layerId: string) => void> = [];

  /** 变更回调 */
  private readonly _onChanged: Array<(layerId: string, property: string) => void> =
    [];

  /**
   * @param context - 可选上下文；缺省使用空对象
   */
  constructor(context?: LayerContext) {
    this._context = context ?? {};
  }

  /** @inheritdoc */
  registerLayerType(type: string, factory: LayerFactory): void {
    const key = type.trim();
    if (key.length === 0) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_SPEC_ID,
        'registerLayerType: type must be non-empty',
        { type },
      );
    }
    this._factories.set(key, factory);
  }

  /** @inheritdoc */
  addLayer(spec: LayerSpec): Layer {
    const id = assertLayerId(spec.id);
    if (this._layers.has(id)) {
      throw new GeoForgeError(
        LM_ERROR_CODES.DUPLICATE_LAYER,
        `layer id already registered: ${id}`,
        { layerId: id },
      );
    }
    const typeKey = spec.type.trim();
    if (typeKey.length === 0) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_SPEC_ID,
        'LayerSpec.type must be non-empty',
        { layerId: id },
      );
    }
    const factory = this._factories.get(typeKey);
    let layer: Layer;
    try {
      layer = factory
        ? factory(spec, this._context)
        : createDefaultLayer(spec);
    } catch (cause) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_NUMERIC,
        `failed to construct layer: ${id}`,
        { layerId: id, type: typeKey },
        cause,
      );
    }
    if (spec.filter !== undefined) {
      this._filterById.set(id, spec.filter);
    } else {
      this._filterById.set(id, null);
    }
    this._layers.set(id, layer);
    try {
      layer.onAdd(this._context as any);
    } catch (cause) {
      this._layers.delete(id);
      this._filterById.delete(id);
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_NUMERIC,
        `layer.onAdd failed: ${id}`,
        { layerId: id },
        cause,
      );
    }
    for (const cb of this._onAdded) {
      try {
        cb(layer);
      } catch {
        // 订阅者错误隔离：不阻断主流程
      }
    }
    return layer;
  }

  /** @inheritdoc */
  removeLayer(id: string): void {
    const key = assertLayerId(id);
    const layer = this._layers.get(key);
    if (!layer) {
      throw new GeoForgeError(
        LM_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found: ${key}`,
        { layerId: key },
      );
    }
    try {
      layer.onRemove();
    } catch {
      // 仍移除映射，避免泄漏；上层可通过日志排查 onRemove
    }
    this._layers.delete(key);
    this._filterById.delete(key);
    for (const cb of this._onRemoved) {
      try {
        cb(key);
      } catch {
        // 隔离订阅错误
      }
    }
  }

  /** @inheritdoc */
  getLayer(id: string): Layer | undefined {
    return this._layers.get(assertLayerId(id));
  }

  /** @inheritdoc */
  getLayers(): Layer[] {
    const list = Array.from(this._layers.values());
    list.sort((a, b) => {
      if (a.zIndex !== b.zIndex) {
        return a.zIndex - b.zIndex;
      }
      return a.id.localeCompare(b.id);
    });
    return list;
  }

  /** @inheritdoc */
  setVisibility(id: string, visible: boolean): void {
    const layer = this._requireLayer(id);
    if (layer.visible === visible) {
      return;
    }
    layer.visible = visible;
    this._emitChanged(layer.id, 'visible');
  }

  /** @inheritdoc */
  setOpacity(id: string, opacity: number): void {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_NUMERIC,
        'opacity must be finite and in [0,1]',
        { id, opacity },
      );
    }
    const layer = this._requireLayer(id);
    if (layer.opacity === opacity) {
      return;
    }
    layer.opacity = opacity;
    this._emitChanged(layer.id, 'opacity');
  }

  /** @inheritdoc */
  setZIndex(id: string, zIndex: number): void {
    if (!Number.isFinite(zIndex)) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_NUMERIC,
        'zIndex must be finite',
        { id, zIndex },
      );
    }
    const layer = this._requireLayer(id);
    if (layer.zIndex === zIndex) {
      return;
    }
    layer.zIndex = zIndex;
    this._emitChanged(layer.id, 'zIndex');
  }

  /** @inheritdoc */
  setFilter(id: string, filter: FilterExpression | null): void {
    const layer = this._requireLayer(id);
    this._filterById.set(layer.id, filter);
    this._emitChanged(layer.id, 'filter');
  }

  /** @inheritdoc */
  getFilter(id: string): FilterExpression | null {
    const layer = this._layers.get(assertLayerId(id));
    if (!layer) {
      throw new GeoForgeError(
        LM_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found: ${id}`,
        { layerId: id },
      );
    }
    const f = this._filterById.get(layer.id);
    return f === undefined ? null : f;
  }

  /** @inheritdoc */
  setLayerOrder(ids: string[]): void {
    const idSet = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      const raw = ids[i];
      const lid = assertLayerId(raw);
      if (idSet.has(lid)) {
        throw new GeoForgeError(
          LM_ERROR_CODES.INVALID_SPEC_ID,
          'setLayerOrder: duplicate id in list',
          { index: i, layerId: lid },
        );
      }
      idSet.add(lid);
      if (!this._layers.has(lid)) {
        throw new GeoForgeError(
          LM_ERROR_CODES.LAYER_NOT_FOUND,
          `setLayerOrder: unknown layer id: ${lid}`,
          { layerId: lid },
        );
      }
    }
    if (idSet.size !== this._layers.size) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_SPEC_ID,
        'setLayerOrder: must include every layer id exactly once',
        { expectedCount: this._layers.size, givenCount: idSet.size },
      );
    }
    for (let i = 0; i < ids.length; i++) {
      const lid = assertLayerId(ids[i]);
      const layer = this._layers.get(lid);
      if (layer && layer.zIndex !== i) {
        layer.zIndex = i;
        this._emitChanged(lid, 'zIndex');
      }
    }
  }

  /** @inheritdoc */
  moveLayer(id: string, newIndex: number): void {
    if (!Number.isFinite(newIndex) || newIndex < 0 || Math.floor(newIndex) !== newIndex) {
      throw new GeoForgeError(
        LM_ERROR_CODES.INVALID_INDEX,
        'newIndex must be a non-negative finite integer',
        { id, newIndex },
      );
    }
    const key = assertLayerId(id);
    const ordered = this.getLayers();
    const idx = ordered.findIndex((l) => l.id === key);
    if (idx < 0) {
      throw new GeoForgeError(
        LM_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found: ${key}`,
        { layerId: key },
      );
    }
    const clamped = Math.min(newIndex, ordered.length - 1);
    const copy = ordered.slice();
    const [item] = copy.splice(idx, 1);
    copy.splice(clamped, 0, item);
    for (let i = 0; i < copy.length; i++) {
      const layer = copy[i];
      if (layer.zIndex !== i) {
        layer.zIndex = i;
        this._emitChanged(layer.id, 'zIndex');
      }
    }
  }

  /** @inheritdoc */
  onLayerAdded(callback: (layer: Layer) => void): () => void {
    this._onAdded.push(callback);
    return () => {
      const i = this._onAdded.indexOf(callback);
      if (i >= 0) {
        this._onAdded.splice(i, 1);
      }
    };
  }

  /** @inheritdoc */
  onLayerRemoved(callback: (layerId: string) => void): () => void {
    this._onRemoved.push(callback);
    return () => {
      const i = this._onRemoved.indexOf(callback);
      if (i >= 0) {
        this._onRemoved.splice(i, 1);
      }
    };
  }

  /** @inheritdoc */
  onLayerChanged(
    callback: (layerId: string, property: string) => void,
  ): () => void {
    this._onChanged.push(callback);
    return () => {
      const i = this._onChanged.indexOf(callback);
      if (i >= 0) {
        this._onChanged.splice(i, 1);
      }
    };
  }

  /**
   * 解析图层或抛错。
   *
   * @param id - 图层 id
   * @returns 图层实例
   */
  private _requireLayer(id: string): Layer {
    const key = assertLayerId(id);
    const layer = this._layers.get(key);
    if (!layer) {
      throw new GeoForgeError(
        LM_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found: ${key}`,
        { layerId: key },
      );
    }
    return layer;
  }

  /**
   * 广播属性变更。
   *
   * @param layerId - 图层 id
   * @param property - 字段名
   */
  private _emitChanged(layerId: string, property: string): void {
    for (const cb of this._onChanged) {
      try {
        cb(layerId, property);
      } catch {
        // 隔离订阅错误
      }
    }
  }
}

/**
 * 创建图层管理器实例。
 *
 * @param context - 可选引擎上下文
 * @returns LayerManager 实现
 *
 * @example
 * const lm = createLayerManager({ gpuDevice: null });
 * lm.registerLayerType('custom', (s, c) => new MyLayer(s, c));
 */
export function createLayerManager(context?: LayerContext): LayerManager {
  return new LayerManagerImpl(context);
}
