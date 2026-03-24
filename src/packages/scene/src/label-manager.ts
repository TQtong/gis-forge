// ============================================================
// L4/scene — LabelManager：全局标注碰撞检测与屏幕空间布局（MVP）
// 依赖 L0 CameraState / Viewport；无 npm 依赖。
// ============================================================

import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';

/** 生产构建由 bundler 注入；未定义时视为 false，避免 `typeof` 分支噪音。 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 常量：屏幕空间估算与数值稳定（避免魔法数字散落）
// ---------------------------------------------------------------------------

/** 估算单字符宽度 = fontSize × 该系数（拉丁字母近似，中文等宽场景可替换为字形度量）。 */
const APPROX_CHAR_WIDTH_FACTOR = 0.6;

/** 行高系数：标注包围盒高度 = fontSize × 该系数。 */
const LINE_HEIGHT_FACTOR = 1.2;

/** 当未在 optional 中提供 fontSize 时的默认字号（CSS 像素）。 */
const DEFAULT_FONT_SIZE_PX = 16;

/** 判断两个轴对齐矩形是否分离（含相等边界视为重叠）。 */
const EPS_RECT = 1e-6;

/** 相机 zoom 变化超过该值视为显著移动（与地图缩放级别小数一致）。 */
const CAMERA_ZOOM_EPSILON = 0.01;

/**
 * 相机中心在屏幕空间上移动超过该像素数视为显著移动（用于帧间缓存失效）。
 * 近似：将经纬度差换算为米再除以 Web Mercator 近似 meters-per-pixel。
 */
const CAMERA_POSITION_EPS_PX = 1;

/** 地球赤道周长（米），用于近似地理距离与像素换算。 */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** WGS84 赤道半径（米），用于经纬度差分米制换算。 */
const WGS84_EQUATORIAL_RADIUS_M = 6378137;

/** 脏标注占比低于该阈值时尝试局部碰撞重算（O6 帧间 diff）。 */
const DIRTY_RATIO_PARTIAL_THRESHOLD = 0.1;

/**
 * 邻居半径：脏标注包围盒各边外扩 `NEIGHBOR_EXPAND_FACTOR * max(w,h)`，
 * 与该扩张盒相交的其它标注纳入局部重算集合。
 */
const NEIGHBOR_EXPAND_FACTOR = 2;

/**
 * MSDF 图集 UV 区域（最小可复用形状，避免与 L1 Texture 强耦合）。
 *
 * @example
 * const r: AtlasRegionLike = { u0: 0, v0: 0, u1: 0.5, v1: 0.25 };
 */
export interface AtlasRegionLike {
  /** 左边界 UV，范围通常 [0, 1)。 */
  readonly u0: number;
  /** 下边界 UV，范围通常 [0, 1)。 */
  readonly v0: number;
  /** 右边界 UV，范围 (u0, 1]。 */
  readonly u1: number;
  /** 上边界 UV，范围 (v0, 1]。 */
  readonly v1: number;
}

/**
 * 单个字形四边形：图集子区域 + 屏幕像素矩形。
 *
 * @example
 * const q: GlyphQuad = {
 *   atlasRegion: { u0: 0, v0: 0, u1: 1, v1: 1 },
 *   x: 10, y: 20, width: 12, height: 16,
 * };
 */
export interface GlyphQuad {
  /** 图集 UV 矩形（MVP 可用占位全图区域）。 */
  readonly atlasRegion: AtlasRegionLike;
  /** 四边形左上角屏幕 x（CSS 像素，原点左上）。 */
  readonly x: number;
  /** 四边形左上角屏幕 y（CSS 像素）。 */
  readonly y: number;
  /** 四边形宽度（像素，非负）。 */
  readonly width: number;
  /** 四边形高度（像素，非负）。 */
  readonly height: number;
}

/**
 * 屏幕轴对齐包围盒（CSS 像素）。
 *
 * @example
 * const box = { minX: 0, minY: 0, maxX: 100, maxY: 24 };
 */
export interface ScreenBBox2D {
  /** 左边界 x（包含）。 */
  readonly minX: number;
  /** 上边界 y（包含，屏幕向下为正）。 */
  readonly minY: number;
  /** 右边界 x（不包含或与 minX 同侧闭合，由碰撞检测统一用分离判定）。 */
  readonly maxX: number;
  /** 下边界 y（不包含）。 */
  readonly maxY: number;
}

/**
 * 标注输入规格：由 Layer / Worker 汇总后提交给 LabelManager。
 *
 * @example
 * const spec: LabelSpec = {
 *   id: 'lbl-1',
 *   layerId: 'roads',
 *   featureId: 42,
 *   text: 'Main St',
 *   position: [400, 300],
 *   anchor: 'center',
 *   priority: 10,
 *   placement: 'point',
 *   offset: [0, 0],
 *   rotation: 0,
 *   allowOverlap: false,
 *   optional: { fontSize: 14 },
 * };
 */
export interface LabelSpec {
  /** 标注实例唯一 id（同帧内唯一）。 */
  readonly id: string;
  /** 所属图层 id。 */
  readonly layerId: string;
  /** 关联要素 id（字符串或数值）。 */
  readonly featureId: string | number;
  /** 文本内容（空字符串仍合法，但不会产生可见字形）。 */
  readonly text: string;
  /**
   * 锚点位置（屏幕空间 CSS 像素），已由上游投影到屏幕。
   * [x, y]，原点为画布左上角。
   */
  readonly position: readonly [number, number];
  /**
   * 文本锚点：决定 `position` 对应到包围盒哪一侧/中心。
   * - `center`：包围盒中心落在 position
   * - `left`/`right`/`top`/`bottom`：相应边/角对齐
   */
  readonly anchor:
    | 'center'
    | 'left'
    | 'right'
    | 'top'
    | 'bottom'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right';
  /**
   * 优先级：数值越大越优先保留（碰撞时低优先级被剔除）。
   * 范围建议 [0, 2^31)，默认 0。
   */
  readonly priority: number;
  /**
   * 布局模式：点标注 / 线标注 / 视口固定（MVP 仅 point 参与碰撞盒计算）。
   */
  readonly placement: 'point' | 'line' | 'viewport';
  /**
   * 在锚点基础上的额外像素偏移 [dx, dy]（CSS 像素）。
   */
  readonly offset: readonly [number, number];
  /**
   * 顺时针旋转角（弧度）。MVP 碰撞仍按轴对齐盒近似（不计旋转扩展）。
   */
  readonly rotation: number;
  /**
   * 为 true 时始终放置（仍计入 visible，但不参与阻挡后续标注）。
   * 为 false 时参与与已放置盒的碰撞检测。
   */
  readonly allowOverlap: boolean;
  /**
   * 扩展字段：如 `fontSize`、`scale`、`textField` 等。
   * `fontSize` 用于估算包围盒宽度/高度。
   */
  readonly optional?: Record<string, unknown>;
}

/**
 * 解析后的屏幕标注：供渲染与拾取。
 *
 * @example
 * const placed: PlacedLabel = {
 *   id: 'a',
 *   screenBBox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
 *   screenPosition: [5, 5],
 *   rotation: 0,
 *   visible: true,
 *   glyphQuads: [],
 * };
 */
export interface PlacedLabel {
  /** 对应 LabelSpec.id。 */
  readonly id: string;
  /** 轴对齐屏幕包围盒（碰撞与拾取用）。 */
  readonly screenBBox: ScreenBBox2D;
  /** 锚点屏幕坐标（含 offset 后）。 */
  readonly screenPosition: readonly [number, number];
  /** 旋转角（弧度）。 */
  readonly rotation: number;
  /** 是否参与显示（被碰撞剔除则为 false）。 */
  readonly visible: boolean;
  /** 字形四边形列表（MVP 可单四边形占位）。 */
  readonly glyphQuads: readonly GlyphQuad[];
}

/**
 * LabelManager 运行配置。
 *
 * @example
 * const cfg = { crossSourceCollisions: true, fadeDuration: 0.2, padding: 2 };
 */
export interface LabelManagerConfig {
  /**
   * 为 true 时所有图层共用一套占用格；为 false 时仅同 layerId 互相碰撞。
   */
  readonly crossSourceCollisions: boolean;
  /**
   * 淡入淡出时长（秒）。MVP 不驱动渲染，仅保存供渲染侧读取。
   * 范围 [0, +∞)。
   */
  readonly fadeDuration: number;
  /**
   * 碰撞 padding（像素），扩大每个盒各边该像素再检测重叠。
   * 范围 [0, +∞)。
   */
  readonly padding: number;
}

/**
 * 统计信息：用于 DevTools / 性能面板。
 *
 * @example
 * const s = manager.stats;
 * console.log(s.visibleCount, s.cpuCullTimeMs);
 */
export interface LabelManagerStats {
  /** 最近一次 submit 的标注总数。 */
  readonly totalSubmitted: number;
  /** 最近一次 resolve 后 visible 为 true 的数量。 */
  readonly visibleCount: number;
  /** 因碰撞被剔除的数量（不含 allowOverlap 强制占位）。 */
  readonly collidedCount: number;
  /** 最近一次 resolve CPU 耗时（毫秒，高精度计时）。 */
  readonly cpuCullTimeMs: number;
  /** GPU 侧剔除占位（MVP 固定为 0）。 */
  readonly gpuCullTimeMs: number;
  /**
   * 帧间优化：`resolve` 因脏集为空且相机未显著移动而直接返回缓存的次数。
   * 范围 [0, +∞)，单调递增直至 `clearLabels` 重置。
   */
  readonly resolveSkipCount: number;
  /**
   * 帧间优化：仅对脏标注及其邻居做局部碰撞重算的次数。
   * 范围 [0, +∞)。
   */
  readonly resolveDirtyCount: number;
  /**
   * 帧间优化：全量碰撞检测次数（含首帧、相机显著移动、脏占比过高或局部回退）。
   * 范围 [0, +∞)。
   */
  readonly resolveFullCount: number;
}

/**
 * 全局标注管理器接口。
 *
 * @example
 * const lm = createLabelManager();
 * lm.submitLabels([spec]);
 * const placed = lm.resolve(camera, viewport);
 */
export interface LabelManager {
  /**
   * 提交本帧候选标注（覆盖上一轮提交内容）。
   *
   * @param labels - 标注规格数组；可空数组表示无标注
   * @returns void
   *
   * @example
   * manager.submitLabels([]);
   */
  submitLabels(labels: readonly LabelSpec[]): void;

  /**
   * 清空候选标注与解析缓存。
   *
   * @returns void
   *
   * @example
   * manager.clearLabels();
   */
  clearLabels(): void;

  /**
   * 根据当前相机与视口解析布局（MVP：优先级 + 轴对齐碰撞）。
   *
   * @param camera - 相机状态（保留供未来世界→屏幕投影）
   * @param viewport - 视口尺寸与像素比
   * @returns 已放置标注列表（顺序为解析顺序）
   *
   * @example
   * const out = manager.resolve(camera, viewport);
   */
  resolve(camera: CameraState, viewport: Viewport): readonly PlacedLabel[];

  /**
   * 读取/更新配置（浅合并）。
   *
   * @returns 当前配置只读快照
   *
   * @example
   * manager.config = { padding: 4 };
   */
  config: LabelManagerConfig;

  /**
   * 在屏幕点拾取最上层命中标注（逆序查找）。
   *
   * @param screenX - 屏幕 x（CSS 像素）
   * @param screenY - 屏幕 y（CSS 像素）
   * @returns 命中标注或 null
   *
   * @example
   * const hit = manager.getLabelAt(120, 340);
   */
  getLabelAt(screenX: number, screenY: number): PlacedLabel | null;

  /**
   * 返回最近一次 resolve 的可见标注列表。
   *
   * @returns 可见 PlacedLabel 数组
   *
   * @example
   * const v = manager.getVisibleLabels();
   */
  getVisibleLabels(): readonly PlacedLabel[];

  /** 统计信息（只读视图）。 */
  readonly stats: LabelManagerStats;
}

/**
 * 从 optional 中安全读取 fontSize（有限正数），否则返回默认值。
 *
 * @param optional - LabelSpec.optional
 * @returns 字号（CSS 像素）
 *
 * @example
 * const fs = readFontSize({ fontSize: 12 }); // 12
 */
function readFontSize(optional: Record<string, unknown> | undefined): number {
  // 无扩展字段时使用默认字号，避免 NaN 传播
  if (optional === undefined) {
    return DEFAULT_FONT_SIZE_PX;
  }
  const raw = optional.fontSize;
  // 仅接受有限正数，其它情况回退默认
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_FONT_SIZE_PX;
  }
  return raw;
}

/**
 * 估算文本包围盒尺寸（像素）。
 *
 * @param text - 文本
 * @param fontSize - 字号
 * @returns [width, height]
 *
 * @example
 * const [w, h] = estimateLabelSize('abc', 16);
 */
function estimateLabelSize(text: string, fontSize: number): readonly [number, number] {
  // 空文本：仍给最小 1×1 盒，避免除零；拾取时可过滤
  const len = text.length;
  const width = Math.max(1, len * fontSize * APPROX_CHAR_WIDTH_FACTOR);
  const height = Math.max(1, fontSize * LINE_HEIGHT_FACTOR);
  return [width, height];
}

/**
 * 根据锚点计算包围盒左上角（轴对齐，未旋转扩展）。
 *
 * @param position - 锚点
 * @param anchor - 锚类型
 * @param width - 盒宽
 * @param height - 盒高
 * @returns [left, top]
 *
 * @example
 * const o = computeBBoxTopLeft([100, 50], 'center', 40, 16);
 */
function computeBBoxTopLeft(
  position: readonly [number, number],
  anchor: LabelSpec['anchor'],
  width: number,
  height: number,
): readonly [number, number] {
  const [px, py] = position;
  // 根据锚点将矩形对齐到锚点位置
  switch (anchor) {
    case 'center':
      return [px - width * 0.5, py - height * 0.5];
    case 'left':
      return [px, py - height * 0.5];
    case 'right':
      return [px - width, py - height * 0.5];
    case 'top':
      return [px - width * 0.5, py];
    case 'bottom':
      return [px - width * 0.5, py - height];
    case 'top-left':
      return [px, py];
    case 'top-right':
      return [px - width, py];
    case 'bottom-left':
      return [px, py - height];
    case 'bottom-right':
      return [px - width, py - height];
    default:
      // 防御性分支：若上游类型放宽为 string，仍返回中心锚点避免崩溃
      return [px - width * 0.5, py - height * 0.5];
  }
}

/**
 * 构建 ScreenBBox2D。
 *
 * @param left - 左
 * @param top - 上
 * @param width - 宽
 * @param height - 高
 * @returns 包围盒
 *
 * @example
 * const b = buildScreenBBox(0, 0, 10, 10);
 */
function buildScreenBBox(left: number, top: number, width: number, height: number): ScreenBBox2D {
  return {
    minX: left,
    minY: top,
    maxX: left + width,
    maxY: top + height,
  };
}

/**
 * 两轴对齐矩形是否重叠（含 padding 扩张）。
 *
 * @param a - 盒 a
 * @param b - 盒 b
 * @param padding - 每边额外像素
 * @returns 是否重叠
 *
 * @example
 * const hit = rectsOverlap(box1, box2, 2);
 */
function rectsOverlap(a: ScreenBBox2D, b: ScreenBBox2D, padding: number): boolean {
  // 扩张 a 的边界，等价于对两盒对称 padding；此处扩张 a 简化计算
  const al = a.minX - padding;
  const ar = a.maxX + padding;
  const at = a.minY - padding;
  const ab = a.maxY + padding;
  // 分离轴定理的 AABB 特例：任一轴分离则不重叠
  if (b.maxX < al - EPS_RECT || b.minX > ar + EPS_RECT) {
    return false;
  }
  if (b.maxY < at - EPS_RECT || b.minY > ab + EPS_RECT) {
    return false;
  }
  return true;
}

/**
 * 上一帧 `submitLabels` 的标注快照，用于帧间 diff（字段覆盖包围盒与碰撞相关输入）。
 */
interface LabelEntry {
  /** 锚点位置 x/y（CSS 像素）。 */
  readonly position: readonly [number, number];
  /** 额外偏移（CSS 像素）。 */
  readonly offset: readonly [number, number];
  /** 文本内容。 */
  readonly text: string;
  /** 优先级。 */
  readonly priority: number;
  /** 锚点枚举。 */
  readonly anchor: LabelSpec['anchor'];
  /** 图层 id（跨图层碰撞规则）。 */
  readonly layerId: string;
  /** 是否允许重叠。 */
  readonly allowOverlap: boolean;
  /** 放置模式。 */
  readonly placement: LabelSpec['placement'];
  /** 旋转角（弧度）。 */
  readonly rotation: number;
  /** 解析后的字号（CSS 像素）。 */
  readonly fontSize: number;
}

/**
 * 相机轻量快照，与 `CameraState.center` / `zoom` 对齐，用于显著移动判定。
 */
interface PrevCameraSnapshot {
  /** 相机中心经度（度），对应 `CameraState.center[0]`。 */
  readonly x: number;
  /** 相机中心纬度（度），对应 `CameraState.center[1]`。 */
  readonly y: number;
  /** 缩放级别，对应 `CameraState.zoom`。 */
  readonly zoom: number;
}

/**
 * 从已通过校验的 `LabelSpec` 构建帧间比较用快照。
 *
 * @param spec - 标注规格
 * @returns 不可变快照
 */
function labelEntryFromSpec(spec: LabelSpec): LabelEntry {
  return {
    position: [spec.position[0], spec.position[1]],
    offset: [spec.offset[0], spec.offset[1]],
    text: spec.text,
    priority: spec.priority,
    anchor: spec.anchor,
    layerId: spec.layerId,
    allowOverlap: spec.allowOverlap,
    placement: spec.placement,
    rotation: spec.rotation,
    fontSize: readFontSize(spec.optional),
  };
}

/**
 * 判断两快照是否等价（无布局相关字段变化）。
 *
 * @param a - 上一帧快照
 * @param b - 当前帧快照
 * @returns 是否等价
 */
function labelEntriesEqual(a: LabelEntry, b: LabelEntry): boolean {
  return (
    a.text === b.text &&
    a.priority === b.priority &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.offset[0] === b.offset[0] &&
    a.offset[1] === b.offset[1] &&
    a.anchor === b.anchor &&
    a.layerId === b.layerId &&
    a.allowOverlap === b.allowOverlap &&
    a.placement === b.placement &&
    a.rotation === b.rotation &&
    a.fontSize === b.fontSize
  );
}

/**
 * 将本帧提交与上一帧快照对比，向脏集中写入新增/删除/内容变更的 id。
 *
 * @param nextById - 本帧 id → 规格
 * @param prevById - 上一帧 id → 快照
 * @param dirtyOut - 输出脏集（合并写入）
 */
function mergeDirtyFromSubmit(
  nextById: Map<string, LabelSpec>,
  prevById: Map<string, LabelEntry>,
  dirtyOut: Set<string>,
): void {
  for (const [id, spec] of nextById) {
    const prev = prevById.get(id);
    if (prev === undefined) {
      dirtyOut.add(id);
      continue;
    }
    const snap = labelEntryFromSpec(spec);
    if (!labelEntriesEqual(prev, snap)) {
      dirtyOut.add(id);
    }
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) {
      dirtyOut.add(id);
    }
  }
}

/**
 * 从 `CameraState` 构造相机快照；非法数值时返回 null 以触发保守的全量重算。
 *
 * @param camera - 相机状态
 * @returns 快照或 null
 */
function tryPrevCameraSnapshot(camera: CameraState): PrevCameraSnapshot | null {
  const x = camera.center[0];
  const y = camera.center[1];
  const z = camera.zoom;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return { x, y, zoom: z };
}

/**
 * 判断相机相对上一帧是否发生显著平移或缩放（缓存失效条件）。
 *
 * @param prev - 上一帧快照；首帧为 null 时视为显著移动
 * @param camera - 当前相机
 * @param viewport - 视口（保留供未来更精确 m/px 估算）
 * @returns 是否显著移动
 */
function cameraMovedSignificantly(
  prev: PrevCameraSnapshot | null,
  camera: CameraState,
  viewport: Viewport,
): boolean {
  // 首帧或无有效快照：必须全量解析，避免误用空缓存
  if (prev === null) {
    return true;
  }
  const cur = tryPrevCameraSnapshot(camera);
  if (cur === null) {
    return true;
  }
  // 视口尺寸用于后续扩展；当前阈值主要依赖 zoom 与地理差分
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return true;
  }
  if (Math.abs(cur.zoom - prev.zoom) > CAMERA_ZOOM_EPSILON) {
    return true;
  }
  const latRad = (cur.y * Math.PI) / 180;
  const cosLat = Math.max(1e-6, Math.cos(latRad));
  const zoomClamped = Math.max(0, Math.min(25, cur.zoom));
  // Web Mercator 近似：赤道附近每像素米数（与瓦片缩放一致）
  const mPerPx = (EARTH_CIRCUMFERENCE_M * cosLat) / (256 * Math.pow(2, zoomClamped));
  if (!Number.isFinite(mPerPx) || mPerPx <= 0) {
    return true;
  }
  const dxM = (cur.x - prev.x) * (Math.PI / 180) * WGS84_EQUATORIAL_RADIUS_M * cosLat;
  const dyM = (cur.y - prev.y) * (Math.PI / 180) * WGS84_EQUATORIAL_RADIUS_M;
  const distPx = Math.hypot(dxM, dyM) / mPerPx;
  if (!Number.isFinite(distPx)) {
    return true;
  }
  return distPx > CAMERA_POSITION_EPS_PX;
}

/**
 * 计算标注的屏幕轴对齐包围盒（与 `resolve` 主路径一致，不含 padding）。
 *
 * @param spec - 标注规格
 * @returns 屏幕包围盒
 */
function computeScreenBBoxForSpec(spec: LabelSpec): ScreenBBox2D {
  const fontSize = readFontSize(spec.optional);
  const [tw, th] = estimateLabelSize(spec.text, fontSize);
  const ox = spec.position[0] + spec.offset[0];
  const oy = spec.position[1] + spec.offset[1];
  const [left, top] = computeBBoxTopLeft([ox, oy], spec.anchor, tw, th);
  return buildScreenBBox(left, top, tw, th);
}

/**
 * 将脏集扩展为「脏标注 + 各向扩张后与脏盒相交的邻居」。
 *
 * @param dirtyIds - 本帧脏 id 集合
 * @param specsById - id → 当前规格
 * @returns 需参与局部重算的 id 集合
 */
function buildNeighborExpandedSet(dirtyIds: Set<string>, specsById: Map<string, LabelSpec>): Set<string> {
  const out = new Set<string>(dirtyIds);
  const expandedRegions: ScreenBBox2D[] = [];
  for (const id of dirtyIds) {
    const spec = specsById.get(id);
    if (spec === undefined) {
      continue;
    }
    const box = computeScreenBBoxForSpec(spec);
    const fs = readFontSize(spec.optional);
    const [tw, th] = estimateLabelSize(spec.text, fs);
    const maxDim = Math.max(tw, th);
    const margin = NEIGHBOR_EXPAND_FACTOR * maxDim;
    expandedRegions.push({
      minX: box.minX - margin,
      minY: box.minY - margin,
      maxX: box.maxX + margin,
      maxY: box.maxY + margin,
    });
  }
  for (const [id, spec] of specsById) {
    if (out.has(id)) {
      continue;
    }
    const box = computeScreenBBoxForSpec(spec);
    for (let r = 0; r < expandedRegions.length; r++) {
      if (rectsOverlap(box, expandedRegions[r], 0)) {
        out.add(id);
        break;
      }
    }
  }
  return out;
}

/**
 * 全量优先级排序 + 轴对齐碰撞解析（MVP 主路径）。
 *
 * @param sorted - 已按 priority 降序排列的规格列表
 * @param cfg - 配置
 * @returns 放置结果与统计元组
 */
function runFullCollision(
  sorted: readonly LabelSpec[],
  cfg: LabelManagerConfig,
): { out: PlacedLabel[]; visible: number; collided: number } {
  const placed: { spec: LabelSpec; box: ScreenBBox2D }[] = [];
  const out: PlacedLabel[] = [];
  let collided = 0;
  let visible = 0;

  for (let i = 0; i < sorted.length; i++) {
    const spec = sorted[i];
    const fontSize = readFontSize(spec.optional);
    const [tw, th] = estimateLabelSize(spec.text, fontSize);
    const ox = spec.position[0] + spec.offset[0];
    const oy = spec.position[1] + spec.offset[1];
    const [left, top] = computeBBoxTopLeft([ox, oy], spec.anchor, tw, th);
    const box = buildScreenBBox(left, top, tw, th);

    if (spec.allowOverlap) {
      visible += 1;
      out.push({
        id: spec.id,
        screenBBox: box,
        screenPosition: [ox, oy],
        rotation: spec.rotation,
        visible: true,
        glyphQuads: [makePlaceholderGlyphQuad(box)],
      });
      continue;
    }

    const hit = conflictsWith(box, placed, spec.layerId, cfg.crossSourceCollisions, cfg.padding);
    if (hit) {
      collided += 1;
      out.push({
        id: spec.id,
        screenBBox: box,
        screenPosition: [ox, oy],
        rotation: spec.rotation,
        visible: false,
        glyphQuads: [],
      });
      continue;
    }

    visible += 1;
    placed.push({ spec, box });
    out.push({
      id: spec.id,
      screenBBox: box,
      screenPosition: [ox, oy],
      rotation: spec.rotation,
      visible: true,
      glyphQuads: [makePlaceholderGlyphQuad(box)],
    });
  }

  return { out, visible, collided };
}

/**
 * 对脏集 ∪ 邻居子集重算碰撞，其余 id 复用上一帧缓存；若缓存缺失则返回 null 以回退全量。
 *
 * @param sorted - 已按 priority 降序排列的规格列表
 * @param cfg - 配置
 * @param activeIds - 需重新计算的 id（脏 + 邻居）
 * @param cachedById - 上一帧 `PlacedLabel` 索引
 * @returns 放置结果与统计，或 null 表示应全量重算
 */
function runPartialCollision(
  sorted: readonly LabelSpec[],
  cfg: LabelManagerConfig,
  activeIds: Set<string>,
  cachedById: Map<string, PlacedLabel>,
): { out: PlacedLabel[]; visible: number; collided: number } | null {
  const placed: { spec: LabelSpec; box: ScreenBBox2D }[] = [];
  const out: PlacedLabel[] = [];
  let collided = 0;
  let visible = 0;

  for (let i = 0; i < sorted.length; i++) {
    const spec = sorted[i];

    if (!activeIds.has(spec.id)) {
      const cached = cachedById.get(spec.id);
      if (cached === undefined) {
        return null;
      }
      // 与全量路径一致：allowOverlap 的可见标注不进入阻挡列表
      if (cached.visible) {
        visible += 1;
        if (!spec.allowOverlap) {
          placed.push({ spec, box: cached.screenBBox });
        }
      } else if (!spec.allowOverlap) {
        collided += 1;
      }
      out.push(cached);
      continue;
    }

    const fontSize = readFontSize(spec.optional);
    const [tw, th] = estimateLabelSize(spec.text, fontSize);
    const ox = spec.position[0] + spec.offset[0];
    const oy = spec.position[1] + spec.offset[1];
    const [left, top] = computeBBoxTopLeft([ox, oy], spec.anchor, tw, th);
    const box = buildScreenBBox(left, top, tw, th);

    if (spec.allowOverlap) {
      visible += 1;
      out.push({
        id: spec.id,
        screenBBox: box,
        screenPosition: [ox, oy],
        rotation: spec.rotation,
        visible: true,
        glyphQuads: [makePlaceholderGlyphQuad(box)],
      });
      continue;
    }

    const hit = conflictsWith(box, placed, spec.layerId, cfg.crossSourceCollisions, cfg.padding);
    if (hit) {
      collided += 1;
      out.push({
        id: spec.id,
        screenBBox: box,
        screenPosition: [ox, oy],
        rotation: spec.rotation,
        visible: false,
        glyphQuads: [],
      });
      continue;
    }

    visible += 1;
    placed.push({ spec, box });
    out.push({
      id: spec.id,
      screenBBox: box,
      screenPosition: [ox, oy],
      rotation: spec.rotation,
      visible: true,
      glyphQuads: [makePlaceholderGlyphQuad(box)],
    });
  }

  return { out, visible, collided };
}

/**
 * 判断候选盒是否与已放置列表冲突（尊重 crossSource 规则）。
 *
 * @param box - 候选包围盒
 * @param placed - 已放置列表
 * @param layerId - 当前图层 id
 * @param cross - 是否跨图层碰撞
 * @param padding - 像素 padding
 * @returns 是否冲突
 *
 * @example
 * const clash = conflictsWith(box, placed, 'a', true, 2);
 */
function conflictsWith(
  box: ScreenBBox2D,
  placed: readonly { spec: LabelSpec; box: ScreenBBox2D }[],
  layerId: string,
  cross: boolean,
  padding: number,
): boolean {
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    // 跨图层关闭时跳过不同 layer
    if (!cross && p.spec.layerId !== layerId) {
      continue;
    }
    // allowOverlap 的标注不阻挡他人（MVP：不加入 placed；若加入需标记）
    if (rectsOverlap(box, p.box, padding)) {
      return true;
    }
  }
  return false;
}

/**
 * 为占位 MSDF 生成单四边形（全图 UV）。
 *
 * @param box - 屏幕盒
 * @returns GlyphQuad
 *
 * @example
 * const g = makePlaceholderGlyphQuad(box);
 */
function makePlaceholderGlyphQuad(box: ScreenBBox2D): GlyphQuad {
  const fullAtlas: AtlasRegionLike = { u0: 0, v0: 0, u1: 1, v1: 1 };
  return {
    atlasRegion: fullAtlas,
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
  };
}

/**
 * 创建 LabelManager 实例（MVP 碰撞与统计）。
 *
 * @returns LabelManager 实现
 *
 * @example
 * const manager = createLabelManager();
 * manager.submitLabels([]);
 */
export function createLabelManager(): LabelManager {
  /** 当前帧候选标注。 */
  let pending: LabelSpec[] = [];
  /** 最近一次 resolve 结果（供 getLabelAt / getVisibleLabels）。 */
  let lastResolved: PlacedLabel[] = [];
  /**
   * 上一帧 `resolve` 的完整输出，用于帧间跳过与局部重算（与 `lastResolved` 同步）。
   */
  let _cachedResult: PlacedLabel[] = [];
  /**
   * 自上次 `resolve` 起，相对上一帧提交发生新增/删除/内容变更的标注 id（submit 阶段写入，resolve 末尾清空）。
   */
  let _dirtySet: Set<string> = new Set();
  /**
   * 上一帧 `submitLabels` 结束时的快照（id → 布局相关字段），供下一帧 diff。
   */
  let _prevLabels: Map<string, LabelEntry> = new Map();
  /**
   * 上一帧 `resolve` 成功后的相机快照；首帧为 null。
   */
  let _prevCamera: PrevCameraSnapshot | null = null;
  /** 运行配置。 */
  let cfg: LabelManagerConfig = {
    crossSourceCollisions: true,
    fadeDuration: 0.25,
    padding: 2,
  };
  /** 统计：提交数。 */
  let statTotalSubmitted = 0;
  /** 统计：可见数。 */
  let statVisible = 0;
  /** 统计：碰撞剔除数。 */
  let statCollided = 0;
  /** 统计：CPU 耗时。 */
  let statCpuMs = 0;
  /** 统计：GPU 耗时（MVP 0）。 */
  const statGpuMs = 0;
  /** 统计：resolve 直接命中缓存跳过全量碰撞的次数。 */
  let resolveSkipCount = 0;
  /** 统计：resolve 走脏集 + 邻居局部碰撞的次数。 */
  let resolveDirtyCount = 0;
  /** 统计：resolve 全量碰撞次数。 */
  let resolveFullCount = 0;

  const manager: LabelManager = {
    get config(): LabelManagerConfig {
      return { ...cfg };
    },
    set config(next: LabelManagerConfig) {
      // 合并配置并校验数值，防止 NaN/Infinity 破坏碰撞检测
      const fade =
        typeof next.fadeDuration === 'number' && Number.isFinite(next.fadeDuration) && next.fadeDuration >= 0
          ? next.fadeDuration
          : cfg.fadeDuration;
      const pad =
        typeof next.padding === 'number' && Number.isFinite(next.padding) && next.padding >= 0
          ? next.padding
          : cfg.padding;
      cfg = {
        crossSourceCollisions:
          typeof next.crossSourceCollisions === 'boolean' ? next.crossSourceCollisions : cfg.crossSourceCollisions,
        fadeDuration: fade,
        padding: pad,
      };
    },

    submitLabels(labels: readonly LabelSpec[]): void {
      // 防御：非数组输入直接抛错，避免静默失败
      if (!Array.isArray(labels)) {
        throw new TypeError('LabelManager.submitLabels: labels must be an array.');
      }
      const next: LabelSpec[] = [];
      for (let i = 0; i < labels.length; i++) {
        const L = labels[i];
        // 逐项校验必填字段，保证 resolve 阶段不因缺字段崩溃
        if (L === null || typeof L !== 'object') {
          throw new TypeError(`LabelManager.submitLabels: label at index ${i} is not an object.`);
        }
        if (typeof L.id !== 'string' || L.id.length === 0) {
          throw new TypeError(`LabelManager.submitLabels: label at index ${i} has invalid id.`);
        }
        if (typeof L.layerId !== 'string' || L.layerId.length === 0) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" has invalid layerId.`);
        }
        if (typeof L.text !== 'string') {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" has invalid text.`);
        }
        if (!Array.isArray(L.position) || L.position.length !== 2) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" position must be [x,y].`);
        }
        if (!Number.isFinite(L.position[0]) || !Number.isFinite(L.position[1])) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" position must be finite.`);
        }
        if (!Array.isArray(L.offset) || L.offset.length !== 2) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" offset must be [dx,dy].`);
        }
        if (!Number.isFinite(L.offset[0]) || !Number.isFinite(L.offset[1])) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" offset must be finite.`);
        }
        if (typeof L.priority !== 'number' || !Number.isFinite(L.priority)) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" priority must be a finite number.`);
        }
        if (typeof L.rotation !== 'number' || !Number.isFinite(L.rotation)) {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" rotation must be finite.`);
        }
        if (typeof L.allowOverlap !== 'boolean') {
          throw new TypeError(`LabelManager.submitLabels: label "${L.id}" allowOverlap must be boolean.`);
        }
        next.push(L);
      }
      const nextById = new Map<string, LabelSpec>();
      for (let j = 0; j < next.length; j++) {
        const spec = next[j];
        nextById.set(spec.id, spec);
      }
      mergeDirtyFromSubmit(nextById, _prevLabels, _dirtySet);
      const nextSnapshots = new Map<string, LabelEntry>();
      for (let j = 0; j < next.length; j++) {
        nextSnapshots.set(next[j].id, labelEntryFromSpec(next[j]));
      }
      _prevLabels = nextSnapshots;
      pending = next;
      statTotalSubmitted = pending.length;
    },

    clearLabels(): void {
      pending = [];
      lastResolved = [];
      _cachedResult = [];
      _dirtySet = new Set();
      _prevLabels = new Map();
      _prevCamera = null;
      statTotalSubmitted = 0;
      statVisible = 0;
      statCollided = 0;
      statCpuMs = 0;
      resolveSkipCount = 0;
      resolveDirtyCount = 0;
      resolveFullCount = 0;
    },

    resolve(camera: CameraState, viewport: Viewport): readonly PlacedLabel[] {
      // camera 与 viewport 在 MVP 中用于未来投影；此处仍校验引用与尺寸，避免静默空渲染
      if (camera === null || typeof camera !== 'object') {
        throw new TypeError('LabelManager.resolve: camera is required.');
      }
      if (viewport === null || typeof viewport !== 'object') {
        throw new TypeError('LabelManager.resolve: viewport is required.');
      }
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0
      ) {
        throw new RangeError('LabelManager.resolve: viewport width/height must be finite and positive.');
      }
      if (!Array.isArray(camera.center) || camera.center.length < 2) {
        throw new TypeError('LabelManager.resolve: camera.center must be [lon, lat].');
      }
      if (!Number.isFinite(camera.center[0]) || !Number.isFinite(camera.center[1])) {
        throw new RangeError('LabelManager.resolve: camera.center values must be finite.');
      }
      if (!Number.isFinite(camera.zoom)) {
        throw new RangeError('LabelManager.resolve: camera.zoom must be finite.');
      }

      const t0 =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();

      const cameraUnstable = cameraMovedSignificantly(_prevCamera, camera, viewport);

      if (pending.length === 0) {
        const tEmpty =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        statCpuMs = tEmpty - t0;
        statVisible = 0;
        statCollided = 0;
        lastResolved = [];
        _cachedResult = [];
        _dirtySet.clear();
        _prevCamera = tryPrevCameraSnapshot(camera);
        resolveFullCount += 1;
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.debug('[LabelManager] resolve: empty pending, full reset.');
        }
        return [];
      }

      const canSkipFullCollision =
        _dirtySet.size === 0 && _cachedResult.length > 0 && !cameraUnstable;

      if (canSkipFullCollision) {
        const t1 =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        statCpuMs = t1 - t0;
        let vis = 0;
        let col = 0;
        for (let i = 0; i < _cachedResult.length; i++) {
          if (_cachedResult[i].visible) {
            vis += 1;
          } else {
            col += 1;
          }
        }
        statVisible = vis;
        statCollided = col;
        lastResolved = _cachedResult;
        _dirtySet.clear();
        _prevCamera = tryPrevCameraSnapshot(camera);
        resolveSkipCount += 1;
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.debug('[LabelManager] resolve: temporal skip (cached collision).');
        }
        return _cachedResult;
      }

      // 按优先级降序排序（高优先先放置）
      const sorted = pending.slice().sort((a, b) => b.priority - a.priority);

      const total = pending.length;
      const dirtyRatio = total > 0 ? _dirtySet.size / total : 1;
      const tryPartial =
        _dirtySet.size > 0 &&
        dirtyRatio < DIRTY_RATIO_PARTIAL_THRESHOLD &&
        _cachedResult.length > 0 &&
        !cameraUnstable;

      if (tryPartial) {
        const specsById = new Map<string, LabelSpec>();
        for (let i = 0; i < pending.length; i++) {
          specsById.set(pending[i].id, pending[i]);
        }
        const cachedById = new Map<string, PlacedLabel>();
        for (let i = 0; i < _cachedResult.length; i++) {
          const pl = _cachedResult[i];
          cachedById.set(pl.id, pl);
        }
        const activeIds = buildNeighborExpandedSet(_dirtySet, specsById);
        const dirtySizeBefore = _dirtySet.size;
        const partial = runPartialCollision(sorted, cfg, activeIds, cachedById);
        if (partial !== null) {
          const t1 =
            typeof performance !== 'undefined' && typeof performance.now === 'function'
              ? performance.now()
              : Date.now();
          statCpuMs = t1 - t0;
          statVisible = partial.visible;
          statCollided = partial.collided;
          lastResolved = partial.out;
          _cachedResult = partial.out;
          _dirtySet.clear();
          _prevCamera = tryPrevCameraSnapshot(camera);
          resolveDirtyCount += 1;
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.debug(
              `[LabelManager] resolve: partial collision (dirty=${dirtySizeBefore}, active=${activeIds.size}).`,
            );
          }
          return partial.out;
        }
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.debug('[LabelManager] resolve: partial collision failed, falling back to full.');
        }
      }

      const full = runFullCollision(sorted, cfg);
      const t1 =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      statCpuMs = t1 - t0;
      statVisible = full.visible;
      statCollided = full.collided;
      lastResolved = full.out;
      _cachedResult = full.out;
      _dirtySet.clear();
      _prevCamera = tryPrevCameraSnapshot(camera);
      resolveFullCount += 1;
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[LabelManager] resolve: full collision.');
      }
      return full.out;
    },

    getLabelAt(screenX: number, screenY: number): PlacedLabel | null {
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        throw new RangeError('LabelManager.getLabelAt: coordinates must be finite.');
      }
      // 逆序：后放置的（高优先级排序中先处理）在上层；数组顺序与 sort 一致，需从末尾向前找可见
      for (let i = lastResolved.length - 1; i >= 0; i--) {
        const L = lastResolved[i];
        if (!L.visible) {
          continue;
        }
        const b = L.screenBBox;
        if (screenX >= b.minX && screenX <= b.maxX && screenY >= b.minY && screenY <= b.maxY) {
          return L;
        }
      }
      return null;
    },

    getVisibleLabels(): readonly PlacedLabel[] {
      const vis: PlacedLabel[] = [];
      for (let i = 0; i < lastResolved.length; i++) {
        if (lastResolved[i].visible) {
          vis.push(lastResolved[i]);
        }
      }
      return vis;
    },

    get stats(): LabelManagerStats {
      return {
        totalSubmitted: statTotalSubmitted,
        visibleCount: statVisible,
        collidedCount: statCollided,
        cpuCullTimeMs: statCpuMs,
        gpuCullTimeMs: statGpuMs,
        resolveSkipCount,
        resolveDirtyCount,
        resolveFullCount,
      };
    },
  };

  return manager;
}
