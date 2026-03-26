// ============================================================
// scene-graph.ts — L4 场景图：多投影分组子树 + UI 叠加层分组
// 职责：按投影组织图层节点，供 FrameGraph / Render Pass 查询顺序。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';
import type { Feature } from '../../core/src/types/feature.ts';

// ---------------------------------------------------------------------------
// 结构化错误（L0 尚无统一 errors.ts 时，场景模块内提供最小实现）
// ---------------------------------------------------------------------------

/**
 * GIS-Forge 场景模块结构化错误。
 * 携带机器可读 `code` 与可选 `context`，便于日志与上层恢复策略。
 *
 * @example
 * throw new GeoForgeError('SCENE_DUPLICATE_LAYER', 'layer id already exists', { layerId: 'a' });
 */
export class GeoForgeError extends Error {
  /**
   * 错误码（稳定字符串，便于 CI/监控聚合）。
   */
  readonly code: string;

  /**
   * 附加上下文（图层 id、投影 id 等），不得包含循环引用对象。
   */
  readonly context?: Record<string, unknown>;

  /**
   * @param code - 错误码
   * @param message - 可读说明
   * @param context - 可选诊断上下文
   * @param cause - 可选底层原因（保留 Error.cause）
   */
  constructor(
    code: string,
    message: string,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'GeoForgeError';
    this.code = code;
    this.context = context;
    if (cause !== undefined && cause instanceof Error) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, GeoForgeError.prototype);
  }
}

/**
 * 本模块使用的错误码常量，避免魔法字符串分散。
 */
const SCENE_ERROR_CODES = {
  /** 图层 id 已存在于场景树 */
  DUPLICATE_LAYER: 'SCENE_DUPLICATE_LAYER',
  /** 未找到指定图层 */
  LAYER_NOT_FOUND: 'SCENE_LAYER_NOT_FOUND',
  /** 投影 id 非法（空字符串等） */
  INVALID_PROJECTION: 'SCENE_INVALID_PROJECTION',
  /** moveLayer 的 index 不是有限非负整数 */
  INVALID_MOVE_INDEX: 'SCENE_INVALID_MOVE_INDEX',
} as const;

/**
 * UI 叠加层使用的约定投影 id（与 Layer.projection 对齐）。
 * 凡 `projection === UI_OVERLAY_PROJECTION` 的图层归入 `ui-overlay` 子树。
 */
export const UI_OVERLAY_PROJECTION = 'ui-overlay';

// ---------------------------------------------------------------------------
// Layer（L4 共享接口）
// ---------------------------------------------------------------------------

/**
 * 图层抽象：生命周期、渲染编码、样式与可选空间查询。
 * 所有具体图层（栅格、矢量、自定义）均实现此接口。
 */
export interface Layer {
  /** 图层唯一 id（与样式文档中 `id` 一致） */
  readonly id: string;
  /** 图层类型（`raster` / `fill` / `custom` 等） */
  readonly type: string;
  /** 绑定的数据源 id */
  readonly source: string;
  /** 投影标识；`ui-overlay` 表示屏幕叠加 Pass */
  readonly projection: string;
  /** 是否参与渲染（false 时仍保留在树中，便于快速开关） */
  visible: boolean;
  /** 不透明度，范围通常 [0, 1] */
  opacity: number;
  /** 同投影内排序主键（越大越靠上） */
  zIndex: number;

  /**
   * 图层加入场景时调用一次，可创建 GPU 资源。
   *
   * @param context - 引擎注入的上下文（MVP 可为任意桩对象）
   */
  onAdd(context: any): void;

  /**
   * 图层从场景移除时调用，应释放 GPU 资源。
   */
  onRemove(): void;

  /**
   * 每帧更新（动画、瓦片状态等）。
   *
   * @param deltaTime - 距上一帧时间（秒）
   * @param camera - 当前相机快照
   */
  onUpdate(deltaTime: number, camera: CameraState): void;

  /**
   * 将绘制命令编码进当前 RenderPass。
   *
   * @param encoder - WebGPU 渲染通道编码器
   * @param camera - 当前相机快照
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 可选：拾取 Pass 编码（与主通道分离时）
   *
   * @param encoder - WebGPU 渲染通道编码器
   * @param camera - 当前相机快照
   */
  encodePicking?(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 可选：设置原始数据（GeoJSON、瓦片解码结果等）
   *
   * @param data - 数据源特定载荷
   */
  setData?(data: any): void;

  /**
   * 可选：读取当前数据引用
   *
   * @returns 数据载荷或 undefined
   */
  getData?(): any;

  /**
   * 设置 paint 属性（样式规范 v8）
   *
   * @param name - 属性名
   * @param value - 属性值
   */
  setPaintProperty(name: string, value: any): void;

  /**
   * 设置 layout 属性
   *
   * @param name - 属性名
   * @param value - 属性值
   */
  setLayoutProperty(name: string, value: any): void;

  /**
   * 读取 paint 属性
   *
   * @param name - 属性名
   * @returns 当前值或 undefined
   */
  getPaintProperty(name: string): any;

  /**
   * 读取 layout 属性
   *
   * @param name - 属性名
   * @returns 当前值或 undefined
   */
  getLayoutProperty(name: string): any;

  /**
   * 可选：包围盒内要素查询（CPU）
   *
   * @param bbox - 查询范围（地理或投影坐标，由数据源约定）
   * @param filter - 可选过滤器表达式
   * @returns 命中的要素数组（可能为空）
   */
  queryFeatures?(bbox: BBox2D, filter?: FilterExpression): Feature[];

  /**
   * 可选：屏幕点选查询
   *
   * @param point - 屏幕像素坐标 [x, y]（左上为原点，由上层约定）
   * @returns 命中的要素数组
   */
  queryRenderedFeatures?(point: [number, number]): Feature[];

  /**
   * 可选：设置要素级状态（高亮等）
   *
   * @param featureId - 要素 id
   * @param state - 状态键值
   */
  setFeatureState?(featureId: string, state: Record<string, any>): void;

  /**
   * 可选：读取要素级状态
   *
   * @param featureId - 要素 id
   * @returns 状态或 undefined
   */
  getFeatureState?(featureId: string): Record<string, any> | undefined;

  /** 数据是否已就绪（瓦片/解析完成） */
  readonly isLoaded: boolean;
  /** 是否包含半透明内容（用于合成排序提示） */
  readonly isTransparent: boolean;
  /** 全局渲染次序（通常由 LayerManager 与 zIndex 同步） */
  readonly renderOrder: number;
}

/**
 * 场景节点类型字面量。
 */
export type SceneNodeKind = 'root' | 'projection-group' | 'layer' | 'ui-overlay';

/**
 * 只读场景节点快照（对外 API）。
 * 子节点顺序即同组内渲染顺序（已按 zIndex / renderOrder 排序）。
 */
export interface SceneNode {
  /** 节点 id（调试与 JSON 序列化） */
  readonly id: string;
  /** 节点语义类型 */
  readonly type: SceneNodeKind;
  /** 子节点（叶层节点通常为空数组） */
  readonly children: readonly SceneNode[];
  /** 投影分组节点携带投影 id；根与 ui-overlay 分组可省略 */
  readonly projection?: string;
  /** 仅 `type==='layer'` 时指向图层实例 */
  readonly layer?: Layer;
  /**
   * 节点是否“可见”：图层节点同步 `Layer.visible`；
   * 分组节点为子树是否存在可见图层（空组为 false）。
   */
  readonly visible: boolean;
}

/**
 * 场景图：多投影子树 + UI 叠加组 + 脏标记 + 遍历/序列化。
 */
export interface SceneGraph {
  /** 根节点（`type==='root'`） */
  readonly root: SceneNode;

  /**
   * 将图层插入对应投影分组（或 ui-overlay 分组），并按 zIndex 排序。
   *
   * @param layer - 已构造的图层实例
   */
  addLayer(layer: Layer): void;

  /**
   * 按 id 移除图层节点；不存在则抛错。
   *
   * @param layerId - 图层 id
   */
  removeLayer(layerId: string): void;

  /**
   * 在同一投影分组内调整图层顺序。
   *
   * @param layerId - 图层 id
   * @param index - 目标索引（0 = 该组最底，越大量越靠上）
   */
  moveLayer(layerId: string, index: number): void;

  /**
   * 返回指定投影分组下的图层（自上而下渲染顺序）。
   *
   * @param projection - 投影 id 或 `ui-overlay`
   * @returns 图层数组副本
   */
  getLayersByProjection(projection: string): Layer[];

  /**
   * 所有 `visible===true` 的图层，按全局渲染顺序（投影组顺序 + 组内顺序）。
   */
  getVisibleLayers(): Layer[];

  /**
   * 当前至少有一个可见图层的投影 id 列表（不含空分组）。
   */
  getActiveProjections(): string[];

  /**
   * UI 叠加分组中的可见图层（按组内顺序）。
   */
  getOverlayLayers(): Layer[];

  /** 结构或成员变化后为 true，直到 `clearDirty()` */
  readonly isDirty: boolean;

  /** 清除脏标记（通常在帧调度合成阶段后调用） */
  clearDirty(): void;

  /**
   * 深度优先遍历。
   *
   * @param visitor - 访问函数；返回 `false` 可中断子树展开（根仍会遍历完兄弟）
   */
  traverse(visitor: (node: SceneNode, depth: number) => boolean | void): void;

  /**
   * 调试导出（仅包含节点 id、类型、投影与图层 id，不含 GPU 资源句柄）。
   */
  toJSON(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 内部可变节点
// ---------------------------------------------------------------------------

/**
 * 内部场景节点：可变 `children` 以便插入/重排。
 */
interface InternalSceneNode {
  /** 节点 id */
  readonly id: string;
  /** 节点类型 */
  readonly type: SceneNodeKind;
  /** 子节点列表（可变） */
  readonly children: InternalSceneNode[];
  /** 投影分组 / ui-overlay 的投影键 */
  projection?: string;
  /** 图层引用（仅 layer 节点） */
  layer?: Layer;
}

/**
 * 规范化投影 id：非空字符串。
 *
 * @param projection - 原始投影
 * @returns 裁剪后的 id
 *
 * @example
 * assertProjectionId(' mercator '); // 'mercator'
 */
function assertProjectionId(projection: string): string {
  const trimmed = projection.trim();
  if (trimmed.length === 0) {
    throw new GeoForgeError(
      SCENE_ERROR_CODES.INVALID_PROJECTION,
      'projection must be a non-empty string',
      { projection },
    );
  }
  return trimmed;
}

/**
 * 计算用于排序的键：先 zIndex 再 renderOrder，保证稳定次序。
 *
 * @param layer - 图层实例
 * @returns 组合排序键
 */
function layerSortKey(layer: Layer): number {
  // zIndex 为主，renderOrder 为细粒度次序（避免浮点 zIndex 并列）
  return layer.zIndex * 1_000_000 + layer.renderOrder;
}

/**
 * 对子节点数组按附着图层排序（仅含 layer 节点时有效）。
 *
 * @param children - 分组子节点
 */
function sortLayerChildren(children: InternalSceneNode[]): void {
  children.sort((a, b) => {
    if (a.type !== 'layer' || !a.layer || b.type !== 'layer' || !b.layer) {
      return 0;
    }
    return layerSortKey(a.layer) - layerSortKey(b.layer);
  });
}

/**
 * 判断内部节点是否“可见”（用于 SceneNode.visible 聚合）。
 *
 * @param node - 内部节点
 * @returns 是否可见
 */
function internalNodeVisible(node: InternalSceneNode): boolean {
  if (node.type === 'layer' && node.layer) {
    return node.layer.visible;
  }
  if (node.children.length === 0) {
    return false;
  }
  return node.children.some((c) => internalNodeVisible(c));
}

/**
 * 将内部树转为只读 `SceneNode` 快照。
 *
 * @param node - 内部节点
 * @returns 只读快照
 */
function toSceneNodeSnapshot(node: InternalSceneNode): SceneNode {
  const visible =
    node.type === 'root' ? true : internalNodeVisible(node);
  return {
    id: node.id,
    type: node.type,
    children: node.children.map(toSceneNodeSnapshot),
    projection: node.projection,
    layer: node.layer,
    visible,
  };
}

/**
 * 在子树中查找父节点与图层节点索引。
 *
 * @param parent - 当前父节点
 * @param layerId - 目标图层 id
 * @returns 父节点与索引，或 undefined
 */
function findLayerParent(
  parent: InternalSceneNode,
  layerId: string,
): { parent: InternalSceneNode; index: number; node: InternalSceneNode } | undefined {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (child.type === 'layer' && child.layer?.id === layerId) {
      return { parent, index: i, node: child };
    }
    const deeper = findLayerParent(child, layerId);
    if (deeper) {
      return deeper;
    }
  }
  return undefined;
}

/**
 * 收集子树中所有图层节点上的 Layer 引用（深度优先）。
 *
 * @param node - 根内部节点
 * @param out - 输出数组
 */
function collectLayersDeep(node: InternalSceneNode, out: Layer[]): void {
  if (node.type === 'layer' && node.layer) {
    out.push(node.layer);
  }
  for (const c of node.children) {
    collectLayersDeep(c, out);
  }
}

/**
 * 查找或创建投影分组节点。
 *
 * @param root - 根节点
 * @param projection - 投影 id（已 trim）
 * @returns 分组节点
 */
function ensureProjectionGroup(
  root: InternalSceneNode,
  projection: string,
): InternalSceneNode {
  let group = root.children.find(
    (c) => c.type === 'projection-group' && c.projection === projection,
  );
  if (!group) {
    group = {
      id: `projection-group:${projection}`,
      type: 'projection-group',
      children: [],
      projection,
    };
    root.children.push(group);
  }
  return group;
}

/**
 * 查找或创建 UI 叠加分组节点（位于 root 下，单例）。
 *
 * @param root - 根节点
 * @returns ui-overlay 分组
 */
function ensureUiOverlayGroup(root: InternalSceneNode): InternalSceneNode {
  let group = root.children.find((c) => c.type === 'ui-overlay');
  if (!group) {
    group = {
      id: 'group:ui-overlay',
      type: 'ui-overlay',
      children: [],
      projection: UI_OVERLAY_PROJECTION,
    };
    root.children.push(group);
  }
  return group;
}

/**
 * 将 `toJSON` 用的轻量结构写出。
 *
 * @param node - 内部节点
 * @returns 可序列化对象
 */
function nodeToJSON(node: InternalSceneNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    projection: node.projection,
    layerId: node.layer?.id,
    children: node.children.map(nodeToJSON),
  };
}

/**
 * SceneGraph 的具体实现类。
 */
class SceneGraphImpl implements SceneGraph {
  /** 根内部节点 */
  private readonly _root: InternalSceneNode;

  /** 结构变更标记 */
  private _dirty = false;

  /** 已注册图层 id，用于 O(1) 重复检测 */
  private readonly _layerIds = new Set<string>();

  /**
   * 构造空场景：仅含 root。
   */
  constructor() {
    this._root = {
      id: 'root',
      type: 'root',
      children: [],
    };
  }

  /** @inheritdoc */
  get root(): SceneNode {
    return toSceneNodeSnapshot(this._root);
  }

  /** @inheritdoc */
  get isDirty(): boolean {
    return this._dirty;
  }

  /** @inheritdoc */
  addLayer(layer: Layer): void {
    if (this._layerIds.has(layer.id)) {
      throw new GeoForgeError(
        SCENE_ERROR_CODES.DUPLICATE_LAYER,
        `layer id already exists in SceneGraph: ${layer.id}`,
        { layerId: layer.id },
      );
    }
    const projection = assertProjectionId(layer.projection);
    const group =
      projection === UI_OVERLAY_PROJECTION
        ? ensureUiOverlayGroup(this._root)
        : ensureProjectionGroup(this._root, projection);
    const layerNode: InternalSceneNode = {
      id: `layer:${layer.id}`,
      type: 'layer',
      children: [],
      layer,
    };
    group.children.push(layerNode);
    sortLayerChildren(group.children);
    this._layerIds.add(layer.id);
    this._dirty = true;
  }

  /** @inheritdoc */
  removeLayer(layerId: string): void {
    const found = findLayerParent(this._root, layerId);
    if (!found) {
      throw new GeoForgeError(
        SCENE_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found in SceneGraph: ${layerId}`,
        { layerId },
      );
    }
    found.parent.children.splice(found.index, 1);
    this._layerIds.delete(layerId);
    this._dirty = true;
  }

  /** @inheritdoc */
  moveLayer(layerId: string, index: number): void {
    if (!Number.isFinite(index) || index < 0 || Math.floor(index) !== index) {
      throw new GeoForgeError(
        SCENE_ERROR_CODES.INVALID_MOVE_INDEX,
        'moveLayer index must be a non-negative finite integer',
        { layerId, index },
      );
    }
    const found = findLayerParent(this._root, layerId);
    if (!found) {
      throw new GeoForgeError(
        SCENE_ERROR_CODES.LAYER_NOT_FOUND,
        `layer not found in SceneGraph: ${layerId}`,
        { layerId },
      );
    }
    const arr = found.parent.children;
    const [removed] = arr.splice(found.index, 1);
    const clamped = Math.min(index, arr.length);
    arr.splice(clamped, 0, removed);
    // 不重跑 zIndex 排序：此处的顺序即用户显式指定的兄弟次序
    this._dirty = true;
  }

  /** @inheritdoc */
  getLayersByProjection(projection: string): Layer[] {
    const key = assertProjectionId(projection);
    if (key === UI_OVERLAY_PROJECTION) {
      const g = this._root.children.find(
        (c) => c.type === 'ui-overlay',
      );
      const out: Layer[] = [];
      if (g) {
        collectLayersDeep(g, out);
      }
      return out.slice();
    }
    const g = this._root.children.find(
      (c) => c.type === 'projection-group' && c.projection === key,
    );
    const out: Layer[] = [];
    if (g) {
      collectLayersDeep(g, out);
    }
    return out.slice();
  }

  /** @inheritdoc */
  getVisibleLayers(): Layer[] {
    const all: Layer[] = [];
    collectLayersDeep(this._root, all);
    const visible = all.filter((l) => l.visible);
    visible.sort((a, b) => {
      const ga = this._projectionOrderKey(a.projection);
      const gb = this._projectionOrderKey(b.projection);
      if (ga !== gb) {
        return ga - gb;
      }
      return layerSortKey(a) - layerSortKey(b);
    });
    return visible;
  }

  /**
   * 投影组在 root.children 中的顺序键（越小越先渲染）。
   *
   * @param projection - 图层投影 id
   * @returns 次序整数
   */
  private _projectionOrderKey(projection: string): number {
    const list = this._root.children;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.type === 'projection-group' && n.projection === projection) {
        return i;
      }
      if (n.type === 'ui-overlay' && projection === UI_OVERLAY_PROJECTION) {
        return i;
      }
    }
    return list.length;
  }

  /** @inheritdoc */
  getActiveProjections(): string[] {
    const result: string[] = [];
    for (const g of this._root.children) {
      if (g.type === 'projection-group' && g.projection) {
        const layers: Layer[] = [];
        collectLayersDeep(g, layers);
        if (layers.some((l) => l.visible)) {
          result.push(g.projection);
        }
      }
      if (g.type === 'ui-overlay') {
        const layers: Layer[] = [];
        collectLayersDeep(g, layers);
        if (layers.some((l) => l.visible)) {
          result.push(UI_OVERLAY_PROJECTION);
        }
      }
    }
    return result;
  }

  /** @inheritdoc */
  getOverlayLayers(): Layer[] {
    const g = this._root.children.find((c) => c.type === 'ui-overlay');
    const out: Layer[] = [];
    if (g) {
      collectLayersDeep(g, out);
    }
    return out.filter((l) => l.visible);
  }

  /** @inheritdoc */
  clearDirty(): void {
    this._dirty = false;
  }

  /** @inheritdoc */
  traverse(visitor: (node: SceneNode, depth: number) => boolean | void): void {
    const walk = (internal: InternalSceneNode, depth: number): boolean => {
      const snap = toSceneNodeSnapshot(internal);
      const r = visitor(snap, depth);
      if (r === false) {
        return false;
      }
      for (const c of internal.children) {
        const cont = walk(c, depth + 1);
        if (cont === false) {
          return false;
        }
      }
      return true;
    };
    walk(this._root, 0);
  }

  /** @inheritdoc */
  toJSON(): Record<string, unknown> {
    return {
      isDirty: this._dirty,
      root: nodeToJSON(this._root),
    };
  }
}

/**
 * 创建空的多投影场景图实例。
 *
 * @returns 可变的 SceneGraph 实现
 *
 * @example
 * const graph = createSceneGraph();
 * graph.addLayer(myLayer);
 */
export function createSceneGraph(): SceneGraph {
  return new SceneGraphImpl();
}
