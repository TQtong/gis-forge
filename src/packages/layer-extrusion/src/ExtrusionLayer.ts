// ============================================================
// ExtrusionLayer.ts — 3D 建筑拉伸图层（L4 图层包）
// 职责：管理多边形要素的 3D 拉伸几何生成（顶面 earcut 三角剖分、
//       底面、侧面）、垂直渐变、Lambert 漫反射光照，
//       维护 fill-extrusion paint 属性。
// 依赖层级：L4（场景层），消费 L0 类型 + L4 Layer 接口。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { FilterExpression, StyleExpression, LightSpec } from '../../core/src/types/style-spec.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

// ---------------------------------------------------------------------------
// __DEV__ 全局标记声明（生产构建由 tree-shake 移除）
// ---------------------------------------------------------------------------

/**
 * 全局开发模式标记，生产构建定义为 false 以便 tree-shake 剥离调试代码。
 */
declare const __DEV__: boolean;

// ---------------------------------------------------------------------------
// 错误码常量
// ---------------------------------------------------------------------------

/**
 * ExtrusionLayer 模块错误码，前缀 `EXTRUSION_` 以避免跨模块碰撞。
 */
const EXTRUSION_ERROR_CODES = {
  /** 选项校验失败 */
  INVALID_OPTIONS: 'EXTRUSION_INVALID_OPTIONS',
  /** 不透明度超出有效区间 */
  INVALID_OPACITY: 'EXTRUSION_INVALID_OPACITY',
  /** 高度值不合法 */
  INVALID_HEIGHT: 'EXTRUSION_INVALID_HEIGHT',
  /** 光照参数不合法 */
  INVALID_LIGHT: 'EXTRUSION_INVALID_LIGHT',
  /** 多边形数据格式不合法 */
  INVALID_POLYGON_DATA: 'EXTRUSION_INVALID_POLYGON_DATA',
  /** Earcut 三角剖分失败 */
  TRIANGULATION_FAILED: 'EXTRUSION_TRIANGULATION_FAILED',
} as const;

// ---------------------------------------------------------------------------
// 魔法数字常量
// ---------------------------------------------------------------------------

/** 默认拉伸高度（米） */
const DEFAULT_HEIGHT = 0;

/** 默认基础高度（米） */
const DEFAULT_BASE_HEIGHT = 0;

/** 默认填充颜色（十六进制） */
const DEFAULT_FILL_COLOR = '#000000';

/** 默认不透明度 */
const DEFAULT_OPACITY = 1.0;

/** 不透明度范围 */
const OPACITY_MIN = 0;
const OPACITY_MAX = 1;

/** 默认最小缩放级别 */
const DEFAULT_MIN_ZOOM = 0;

/** 默认最大缩放级别 */
const DEFAULT_MAX_ZOOM = 22;

/** 默认光照方位角（度，从正北顺时针） */
const DEFAULT_LIGHT_AZIMUTH = 210;

/** 默认光照仰角（度） */
const DEFAULT_LIGHT_POLAR = 30;

/** 默认光照强度 */
const DEFAULT_LIGHT_INTENSITY = 0.5;

/** 默认环境光比例（无光照面不低于此比例，避免全黑） */
const AMBIENT_LIGHT_RATIO = 0.3;

/** 垂直渐变暗化系数——底部颜色乘以此系数 */
const VERTICAL_GRADIENT_BOTTOM_FACTOR = 0.6;

/** 角度→弧度转换常量 */
const DEG_TO_RAD = Math.PI / 180;

/** 三角形的顶点数 */
const TRIANGLE_VERTICES = 3;

/** 侧面每条边产生的三角形数 */
const SIDE_TRIANGLES_PER_EDGE = 2;

/** 侧面每条边产生的顶点数（2 个三角形 × 3 顶点） */
const SIDE_VERTICES_PER_EDGE = 6;

/** 每顶点的位置分量数（x, y, z） */
const POSITION_COMPONENTS = 3;

/** 每顶点的法线分量数（nx, ny, nz） */
const NORMAL_COMPONENTS = 3;

/** 每顶点的颜色分量数（r, g, b, a） */
const COLOR_COMPONENTS = 4;

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/**
 * 拉伸几何数据——一个多边形要素的完整三角网格。
 *
 * @internal 仅模块内使用。
 */
interface ExtrusionGeometry {
  /** 顶点位置数组（xyz 交错，每 3 个 float 一个顶点） */
  positions: Float32Array;

  /** 顶点法线数组（xyz 交错，与 positions 等长） */
  normals: Float32Array;

  /** 顶点颜色数组（rgba 交错，每 4 个 float 一个顶点，含垂直渐变） */
  colors: Float32Array;

  /** 三角形索引数组 */
  indices: Uint32Array;

  /** 总三角形数 */
  triangleCount: number;

  /** 关联的要素 ID */
  featureId: string | number | undefined;
}

/**
 * 拉伸图层的光照状态。
 *
 * @internal 仅模块内使用。
 */
interface ExtrusionLightState {
  /** 光照方向向量 [x, y, z]，归一化，指向光源 */
  direction: Float32Array;

  /** 光照颜色 [r, g, b]，范围 [0, 1] */
  color: Float32Array;

  /** 光照强度 [0, 1] */
  intensity: number;

  /** 锚定模式 */
  anchor: 'map' | 'viewport';
}

// ---------------------------------------------------------------------------
// ExtrusionLayerOptions
// ---------------------------------------------------------------------------

/**
 * 3D 建筑拉伸图层构造选项。
 *
 * @example
 * const opts: ExtrusionLayerOptions = {
 *   id: 'buildings-3d',
 *   source: 'openmaptiles',
 *   sourceLayer: 'building',
 *   paint: {
 *     'fill-extrusion-height': ['get', 'height'],
 *     'fill-extrusion-base': ['get', 'min_height'],
 *     'fill-extrusion-color': '#aaaaaa',
 *     'fill-extrusion-opacity': 0.8,
 *     'fill-extrusion-vertical-gradient': true,
 *   },
 *   filter: ['>', ['get', 'height'], 0],
 *   minzoom: 14,
 * };
 */
export interface ExtrusionLayerOptions {
  /**
   * 图层唯一 ID。
   * 必填。
   */
  readonly id: string;

  /**
   * 绑定的数据源 ID。
   * 必填。
   */
  readonly source: string;

  /**
   * MVT 矢量瓦片中的 source-layer 名。
   * 仅当 source type 为 vector 时需要。
   * 可选。
   */
  readonly sourceLayer?: string;

  /**
   * 投影标识。
   * 可选，默认 `'mercator'`。
   */
  readonly projection?: string;

  /**
   * paint 属性表（v8 样式规范 fill-extrusion paint 属性）。
   * 支持键：
   * - `'fill-extrusion-height'`: 拉伸高度（米），number 或 StyleExpression，默认 0
   * - `'fill-extrusion-base'`: 底部高度（米），number 或 StyleExpression，默认 0
   * - `'fill-extrusion-color'`: 填充颜色，string 或 StyleExpression，默认 '#000000'
   * - `'fill-extrusion-opacity'`: 不透明度 [0,1]，默认 1
   * - `'fill-extrusion-translate'`: 平移 [x, y]（像素），默认 [0, 0]
   * - `'fill-extrusion-vertical-gradient'`: 是否启用垂直渐变，默认 true
   * 可选。
   */
  readonly paint?: Record<string, unknown>;

  /**
   * 要素过滤器表达式。
   * 可选。
   */
  readonly filter?: FilterExpression;

  /**
   * 图层可见的最小缩放级别。
   * 可选，默认 0。
   */
  readonly minzoom?: number;

  /**
   * 图层可见的最大缩放级别。
   * 可选，默认 22。
   */
  readonly maxzoom?: number;

  /**
   * 初始不透明度。
   * 可选，默认 1。
   */
  readonly opacity?: number;
}

// ---------------------------------------------------------------------------
// ExtrusionLayer 扩展接口
// ---------------------------------------------------------------------------

/**
 * 3D 建筑拉伸图层接口——在 Layer 基础上扩展光照控制和几何统计。
 * 实例由 `createExtrusionLayer` 工厂创建。
 *
 * @example
 * const layer = createExtrusionLayer({ id: 'buildings', source: 'omt', sourceLayer: 'building' });
 * layer.setLight({ anchor: 'viewport', intensity: 0.7, position: [1.15, 200, 40] });
 */
export interface ExtrusionLayer extends Layer {
  /** 图层类型鉴别字面量，固定为 `'fill-extrusion'` */
  readonly type: 'fill-extrusion';

  /** 当前帧渲染的三角形总数 */
  readonly triangleCount: number;

  /** 当前帧渲染的要素数量 */
  readonly featureCount: number;

  /**
   * 设置全局光照参数。
   *
   * @param light - 光照参数（对标 StyleSpec.light）
   *
   * @example
   * layer.setLight({ anchor: 'viewport', intensity: 0.7, position: [1.15, 200, 40] });
   */
  setLight(light: LightSpec): void;
}

// ---------------------------------------------------------------------------
// CSS 颜色解析（简化版——仅支持 #rrggbb / #rgb）
// ---------------------------------------------------------------------------

/**
 * 解析 CSS 十六进制颜色为归一化 [r, g, b] 分量。
 * 支持 #rrggbb 和 #rgb 格式。无效输入返回黑色。
 *
 * @param hex - CSS 颜色字符串
 * @returns [r, g, b]，各通道 [0, 1]
 *
 * @example
 * parseHexColor('#ff0000'); // [1, 0, 0]
 * parseHexColor('#0f0');    // [0, 1, 0]
 */
function parseHexColor(hex: string): [number, number, number] {
  // 移除首字符 '#'
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;

  // #rgb 短格式
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);

    // parseInt 可能返回 NaN
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return [0, 0, 0];
    }

    return [r / 255, g / 255, b / 255];
  }

  // #rrggbb 长格式
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);

    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return [0, 0, 0];
    }

    return [r / 255, g / 255, b / 255];
  }

  // 无法解析：返回黑色
  return [0, 0, 0];
}

// ---------------------------------------------------------------------------
// 光照方向计算
// ---------------------------------------------------------------------------

/**
 * 从光照位置参数（球坐标）计算归一化方向向量。
 * 光照位置格式 [radialCoordinate, azimuthalAngle, polarAngle]：
 * - azimuthalAngle: 方位角（度），0 = 正北，顺时针
 * - polarAngle: 极角（度），0 = 正上方，90 = 地平线
 *
 * @param position - [radial, azimuth, polar]（度）
 * @returns Float32Array [x, y, z] 归一化方向向量，指向光源
 *
 * @example
 * const dir = computeLightDirection([1.15, 210, 30]);
 */
function computeLightDirection(position: readonly [number, number, number]): Float32Array {
  // 解构球坐标
  const azimuthDeg = position[1];
  const polarDeg = position[2];

  // 转换为弧度
  const azimuthRad = azimuthDeg * DEG_TO_RAD;
  const polarRad = polarDeg * DEG_TO_RAD;

  // 球坐标 → 笛卡尔坐标（Y-up 约定）
  // azimuth 从正北（+Z 方向）顺时针旋转
  // polar 从天顶（+Y 方向）向地平线倾斜
  const sinPolar = Math.sin(polarRad);
  const cosPolar = Math.cos(polarRad);

  // X = sin(polar) × sin(azimuth)（东方向）
  const x = sinPolar * Math.sin(azimuthRad);
  // Y = cos(polar)（上方向）
  const y = cosPolar;
  // Z = sin(polar) × cos(azimuth)（北方向）
  const z = sinPolar * Math.cos(azimuthRad);

  // 归一化（理论上已归一化，但浮点安全起见）
  const len = Math.sqrt(x * x + y * y + z * z);
  const dir = new Float32Array(3);

  // 防止零长度向量
  if (len > 1e-10) {
    dir[0] = x / len;
    dir[1] = y / len;
    dir[2] = z / len;
  } else {
    // 退化：默认指向正上方
    dir[0] = 0;
    dir[1] = 1;
    dir[2] = 0;
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Lambert 漫反射光照计算
// ---------------------------------------------------------------------------

/**
 * 计算 Lambert 漫反射光照因子。
 * Lambert 模型：diffuse = max(dot(normal, lightDir), 0) × intensity
 * 结果与环境光混合：final = ambient + (1 - ambient) × diffuse
 *
 * @param normalX - 表面法线 X 分量
 * @param normalY - 表面法线 Y 分量
 * @param normalZ - 表面法线 Z 分量
 * @param light - 光照状态
 * @returns 光照强度因子 [0, 1]
 *
 * @example
 * const factor = computeLambertFactor(0, 0, 1, lightState);
 */
function computeLambertFactor(
  normalX: number,
  normalY: number,
  normalZ: number,
  light: ExtrusionLightState,
): number {
  // 法线与光照方向的点积（N·L）
  const dotNL =
    normalX * light.direction[0] +
    normalY * light.direction[1] +
    normalZ * light.direction[2];

  // Lambert 漫反射：取正值（背向光源的面无漫反射贡献）
  const diffuse = Math.max(0.0, dotNL) * light.intensity;

  // 混合环境光——确保阴影面不完全全黑
  return AMBIENT_LIGHT_RATIO + (1.0 - AMBIENT_LIGHT_RATIO) * diffuse;
}

// ---------------------------------------------------------------------------
// Earcut 三角剖分（简化版——仅支持简单凸/凹多边形无孔）
// ---------------------------------------------------------------------------

/**
 * 简化版 earcut 三角剖分算法——将 2D 多边形转换为三角形索引。
 * 实现扇形三角剖分（适用于凸多边形）+ 简单耳切法（适用于凹多边形）。
 *
 * 完整引擎中此算法在 Worker 中执行（worker-task: triangulate），
 * 此处为 CPU 端 MVP 实现。
 *
 * @param ring - 多边形外环顶点 [x0,y0, x1,y1, ...]（扁平数组，每 2 个值一顶点）
 * @returns 三角形索引数组（每 3 个索引一个三角形）
 *
 * @example
 * const indices = earcutTriangulate([0,0, 1,0, 1,1, 0,1]); // 矩形 → 2 个三角形
 */
function earcutTriangulate(ring: Float64Array | number[]): number[] {
  // 计算顶点数
  const vertexCount = Math.floor(ring.length / 2);

  // 不足 3 个顶点无法构成三角形
  if (vertexCount < 3) {
    return [];
  }

  // 对于 3 个顶点：单个三角形
  if (vertexCount === 3) {
    return [0, 1, 2];
  }

  // 计算多边形面积符号（顺/逆时针判断）
  let signedArea = 0;
  for (let i = 0; i < vertexCount; i++) {
    const j = (i + 1) % vertexCount;
    signedArea += ring[i * 2] * ring[j * 2 + 1];
    signedArea -= ring[j * 2] * ring[i * 2 + 1];
  }
  // 正面积 = 逆时针（CCW），负面积 = 顺时针（CW）
  const isCCW = signedArea > 0;

  // 构建索引链表（可用的顶点索引）
  const remaining: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    remaining.push(i);
  }

  // 耳切法：反复寻找"耳朵"三角形并切除
  const triangles: number[] = [];
  let safety = vertexCount * vertexCount; // 防止无限循环

  while (remaining.length > 3 && safety > 0) {
    safety--;
    let earFound = false;

    for (let i = 0; i < remaining.length; i++) {
      // 当前顶点及其前后邻居
      const prev = remaining[(i + remaining.length - 1) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];

      // 提取坐标
      const ax = ring[prev * 2], ay = ring[prev * 2 + 1];
      const bx = ring[curr * 2], by = ring[curr * 2 + 1];
      const cx = ring[next * 2], cy = ring[next * 2 + 1];

      // 计算三角形叉积（判断凹凸）
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

      // 对于 CCW 多边形，耳朵三角形应为 CCW（正叉积）
      // 对于 CW 多边形，耳朵三角形应为 CW（负叉积）
      const isConvex = isCCW ? cross > 0 : cross < 0;

      if (!isConvex) {
        continue;
      }

      // 检查是否有其他顶点在三角形内部
      let hasInside = false;
      for (let j = 0; j < remaining.length; j++) {
        const testIdx = remaining[j];
        if (testIdx === prev || testIdx === curr || testIdx === next) {
          continue;
        }

        const px = ring[testIdx * 2], py = ring[testIdx * 2 + 1];

        // 点在三角形内测试（重心坐标法）
        if (isPointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          hasInside = true;
          break;
        }
      }

      if (hasInside) {
        continue;
      }

      // 找到耳朵：输出三角形并移除当前顶点
      triangles.push(prev, curr, next);
      remaining.splice(i, 1);
      earFound = true;
      break;
    }

    // 如果一轮遍历未找到耳朵，说明是退化多边形——用扇形兜底
    if (!earFound) {
      break;
    }
  }

  // 剩余 3 个顶点形成最后一个三角形
  if (remaining.length === 3) {
    triangles.push(remaining[0], remaining[1], remaining[2]);
  } else if (remaining.length > 3) {
    // 退化情况：强制扇形三角剖分处理剩余顶点
    for (let i = 1; i < remaining.length - 1; i++) {
      triangles.push(remaining[0], remaining[i], remaining[i + 1]);
    }
  }

  return triangles;
}

/**
 * 判断点 (px, py) 是否在三角形 (ax,ay)-(bx,by)-(cx,cy) 内部。
 * 使用面积法（重心坐标的符号判断）。
 *
 * @param px - 测试点 X
 * @param py - 测试点 Y
 * @param ax - 三角形顶点 A 的 X
 * @param ay - 三角形顶点 A 的 Y
 * @param bx - 三角形顶点 B 的 X
 * @param by - 三角形顶点 B 的 Y
 * @param cx - 三角形顶点 C 的 X
 * @param cy - 三角形顶点 C 的 Y
 * @returns 是否在三角形内部（含边界）
 *
 * @example
 * isPointInTriangle(0.5, 0.5, 0, 0, 1, 0, 0, 1); // true
 */
function isPointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  // 向量叉积符号
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);

  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

  // 如果三个叉积同号，点在三角形内
  return !(hasNeg && hasPos);
}

// ---------------------------------------------------------------------------
// 拉伸几何生成
// ---------------------------------------------------------------------------

/**
 * 从多边形要素生成完整的拉伸三角网格。
 * 包含三个部分：
 * 1. 顶面（earcut 三角剖分，法线朝上 [0,1,0]）
 * 2. 底面（与顶面相同三角形，Y 坐标替换为 base，法线朝下 [0,-1,0]，索引反转）
 * 3. 侧面（每条边 → 2 个三角形，法线为边的外法线）
 *
 * @param outerRing - 外环顶点 [x0,y0, x1,y1, ...]（扁平 2D 坐标）
 * @param height - 拉伸高度（米）
 * @param base - 底部高度（米）
 * @param color - 填充颜色 [r, g, b]，范围 [0, 1]
 * @param verticalGradient - 是否启用垂直渐变
 * @param light - 光照状态（用于侧面法线光照预计算）
 * @param featureId - 关联的要素 ID
 * @returns 拉伸几何数据，失败时返回 null
 *
 * @example
 * const geom = generateExtrusionGeometry(
 *   [0,0, 10,0, 10,10, 0,10], 50, 0, [0.5, 0.5, 0.5], true, light, 'b1'
 * );
 */
function generateExtrusionGeometry(
  outerRing: Float64Array | number[],
  height: number,
  base: number,
  color: [number, number, number],
  verticalGradient: boolean,
  light: ExtrusionLightState,
  featureId: string | number | undefined,
): ExtrusionGeometry | null {
  // 计算外环顶点数
  const ringVertexCount = Math.floor(outerRing.length / 2);

  // 至少 3 个顶点
  if (ringVertexCount < 3) {
    return null;
  }

  // ── 1. 顶面三角剖分 ──
  const topIndices = earcutTriangulate(outerRing);
  if (topIndices.length === 0) {
    return null;
  }
  const topTriangleCount = Math.floor(topIndices.length / TRIANGLE_VERTICES);

  // ── 2. 底面三角形数（与顶面相同） ──
  const bottomTriangleCount = topTriangleCount;

  // ── 3. 侧面三角形数（每条边 2 个三角形） ──
  const sideTriangleCount = ringVertexCount * SIDE_TRIANGLES_PER_EDGE;

  // 总三角形数
  const totalTriangles = topTriangleCount + bottomTriangleCount + sideTriangleCount;

  // ── 4. 计算总顶点数 ──
  // 顶面和底面共享索引，但法线不同，因此需要独立顶点
  const topVertexCount = ringVertexCount;
  const bottomVertexCount = ringVertexCount;
  // 侧面每条边 6 个顶点（2 个三角形，不共享法线以保持硬边）
  const sideVertexCount = ringVertexCount * SIDE_VERTICES_PER_EDGE;
  const totalVertices = topVertexCount + bottomVertexCount + sideVertexCount;

  // ── 5. 分配缓冲区 ──
  const positions = new Float32Array(totalVertices * POSITION_COMPONENTS);
  const normals = new Float32Array(totalVertices * NORMAL_COMPONENTS);
  const colors = new Float32Array(totalVertices * COLOR_COMPONENTS);
  const indices = new Uint32Array(totalTriangles * TRIANGLE_VERTICES);

  // 安全高度钳位
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const safeBase = Number.isFinite(base) ? Math.max(0, base) : 0;

  // 顶面光照因子（法线朝上 [0, 1, 0]）
  const topLightFactor = computeLambertFactor(0, 1, 0, light);

  // 底面光照因子（法线朝下 [0, -1, 0]）
  const bottomLightFactor = computeLambertFactor(0, -1, 0, light);

  // 垂直渐变的顶部和底部颜色倍率
  const topColorMult = verticalGradient ? 1.0 : 1.0;
  const bottomColorMult = verticalGradient ? VERTICAL_GRADIENT_BOTTOM_FACTOR : 1.0;

  let vertexOffset = 0;
  let indexOffset = 0;

  // ── 6. 填充顶面顶点 ──
  for (let i = 0; i < ringVertexCount; i++) {
    const vi = (vertexOffset + i) * POSITION_COMPONENTS;
    // X = 外环 X 坐标，Y = height（拉伸高度），Z = 外环 Y 坐标
    positions[vi] = outerRing[i * 2];
    positions[vi + 1] = safeHeight;
    positions[vi + 2] = outerRing[i * 2 + 1];

    // 法线朝上
    const ni = (vertexOffset + i) * NORMAL_COMPONENTS;
    normals[ni] = 0;
    normals[ni + 1] = 1;
    normals[ni + 2] = 0;

    // 颜色（含光照和顶部渐变）
    const ci = (vertexOffset + i) * COLOR_COMPONENTS;
    colors[ci] = color[0] * topLightFactor * topColorMult;
    colors[ci + 1] = color[1] * topLightFactor * topColorMult;
    colors[ci + 2] = color[2] * topLightFactor * topColorMult;
    colors[ci + 3] = DEFAULT_OPACITY;
  }

  // 顶面索引
  for (let i = 0; i < topIndices.length; i++) {
    indices[indexOffset + i] = vertexOffset + topIndices[i];
  }
  indexOffset += topIndices.length;
  vertexOffset += ringVertexCount;

  // ── 7. 填充底面顶点 ──
  for (let i = 0; i < ringVertexCount; i++) {
    const vi = (vertexOffset + i) * POSITION_COMPONENTS;
    positions[vi] = outerRing[i * 2];
    positions[vi + 1] = safeBase;
    positions[vi + 2] = outerRing[i * 2 + 1];

    // 法线朝下
    const ni = (vertexOffset + i) * NORMAL_COMPONENTS;
    normals[ni] = 0;
    normals[ni + 1] = -1;
    normals[ni + 2] = 0;

    // 颜色（含光照和底部渐变）
    const ci = (vertexOffset + i) * COLOR_COMPONENTS;
    colors[ci] = color[0] * bottomLightFactor * bottomColorMult;
    colors[ci + 1] = color[1] * bottomLightFactor * bottomColorMult;
    colors[ci + 2] = color[2] * bottomLightFactor * bottomColorMult;
    colors[ci + 3] = DEFAULT_OPACITY;
  }

  // 底面索引（反转三角形缠绕方向使法线朝外/朝下）
  for (let i = 0; i < topIndices.length; i += TRIANGLE_VERTICES) {
    indices[indexOffset] = vertexOffset + topIndices[i + 2];
    indices[indexOffset + 1] = vertexOffset + topIndices[i + 1];
    indices[indexOffset + 2] = vertexOffset + topIndices[i];
    indexOffset += TRIANGLE_VERTICES;
  }
  vertexOffset += ringVertexCount;

  // ── 8. 填充侧面顶点 ──
  for (let i = 0; i < ringVertexCount; i++) {
    const j = (i + 1) % ringVertexCount;

    // 当前边的两个端点
    const x0 = outerRing[i * 2], z0 = outerRing[i * 2 + 1];
    const x1 = outerRing[j * 2], z1 = outerRing[j * 2 + 1];

    // 计算边的 2D 方向向量
    const edgeDx = x1 - x0;
    const edgeDz = z1 - z0;

    // 外法线 = 边方向逆时针旋转 90°：(dz, 0, -dx) 归一化
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDz * edgeDz);

    let nx: number, nz: number;
    if (edgeLen > 1e-10) {
      nx = edgeDz / edgeLen;
      nz = -edgeDx / edgeLen;
    } else {
      // 退化边（长度为零），使用默认法线
      nx = 0;
      nz = 1;
    }

    // 侧面光照因子
    const sideLightFactor = computeLambertFactor(nx, 0, nz, light);

    // 4 个角点坐标（侧面矩形的两个三角形需要 6 个顶点）
    // 顶部左：(x0, height, z0)
    // 顶部右：(x1, height, z1)
    // 底部左：(x0, base, z0)
    // 底部右：(x1, base, z1)

    // 三角形 1：顶部左 → 底部左 → 底部右
    // 三角形 2：顶部左 → 底部右 → 顶部右

    const sideBaseIdx = vertexOffset * POSITION_COMPONENTS;
    const sideColorIdx = vertexOffset * COLOR_COMPONENTS;
    const sideNormalIdx = vertexOffset * NORMAL_COMPONENTS;

    // 定义 6 个顶点的位置
    const sidePositions: Array<[number, number, number]> = [
      [x0, safeHeight, z0],   // tri1: 顶部左
      [x0, safeBase, z0],     // tri1: 底部左
      [x1, safeBase, z1],     // tri1: 底部右
      [x0, safeHeight, z0],   // tri2: 顶部左
      [x1, safeBase, z1],     // tri2: 底部右
      [x1, safeHeight, z1],   // tri2: 顶部右
    ];

    for (let v = 0; v < SIDE_VERTICES_PER_EDGE; v++) {
      const pi = (vertexOffset + v) * POSITION_COMPONENTS;
      positions[pi] = sidePositions[v][0];
      positions[pi + 1] = sidePositions[v][1];
      positions[pi + 2] = sidePositions[v][2];

      // 所有侧面顶点共享同一法线
      const nni = (vertexOffset + v) * NORMAL_COMPONENTS;
      normals[nni] = nx;
      normals[nni + 1] = 0;
      normals[nni + 2] = nz;

      // 颜色含垂直渐变——顶部亮，底部暗
      const isTop = sidePositions[v][1] === safeHeight;
      const gradMult = isTop ? topColorMult : bottomColorMult;

      const cci = (vertexOffset + v) * COLOR_COMPONENTS;
      colors[cci] = color[0] * sideLightFactor * gradMult;
      colors[cci + 1] = color[1] * sideLightFactor * gradMult;
      colors[cci + 2] = color[2] * sideLightFactor * gradMult;
      colors[cci + 3] = DEFAULT_OPACITY;

      // 侧面索引：直接顺序
      indices[indexOffset + v] = vertexOffset + v;
    }

    indexOffset += SIDE_VERTICES_PER_EDGE;
    vertexOffset += SIDE_VERTICES_PER_EDGE;
  }

  return {
    positions,
    normals,
    colors,
    indices,
    triangleCount: totalTriangles,
    featureId,
  };
}

// ---------------------------------------------------------------------------
// 选项校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化 ExtrusionLayerOptions。
 *
 * @param opts - 用户传入的原始选项
 * @returns 规范化后的选项
 * @throws Error 若任何校验失败
 */
function validateExtrusionOptions(opts: ExtrusionLayerOptions): {
  id: string;
  source: string;
  sourceLayer: string | undefined;
  projection: string;
  minzoom: number;
  maxzoom: number;
  opacity: number;
  filter: FilterExpression | undefined;
  paint: Record<string, unknown> | undefined;
} {
  // id 必须为非空字符串
  if (typeof opts.id !== 'string' || opts.id.trim().length === 0) {
    throw new Error(
      `[${EXTRUSION_ERROR_CODES.INVALID_OPTIONS}] ExtrusionLayerOptions.id must be a non-empty string`,
    );
  }

  // source 必须为非空字符串
  if (typeof opts.source !== 'string' || opts.source.trim().length === 0) {
    throw new Error(
      `[${EXTRUSION_ERROR_CODES.INVALID_OPTIONS}] ExtrusionLayerOptions.source must be a non-empty string`,
    );
  }

  // 投影默认 mercator
  const projection = (opts.projection ?? 'mercator').trim() || 'mercator';

  // 缩放范围
  const minzoom = opts.minzoom ?? DEFAULT_MIN_ZOOM;
  if (!Number.isFinite(minzoom) || minzoom < DEFAULT_MIN_ZOOM || minzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${EXTRUSION_ERROR_CODES.INVALID_OPTIONS}] minzoom must be in [0, 22], got ${minzoom}`,
    );
  }

  const maxzoom = opts.maxzoom ?? DEFAULT_MAX_ZOOM;
  if (!Number.isFinite(maxzoom) || maxzoom < minzoom || maxzoom > DEFAULT_MAX_ZOOM) {
    throw new Error(
      `[${EXTRUSION_ERROR_CODES.INVALID_OPTIONS}] maxzoom must be in [${minzoom}, 22], got ${maxzoom}`,
    );
  }

  // 不透明度
  const opacity = opts.opacity ?? DEFAULT_OPACITY;
  if (!Number.isFinite(opacity) || opacity < OPACITY_MIN || opacity > OPACITY_MAX) {
    throw new Error(
      `[${EXTRUSION_ERROR_CODES.INVALID_OPACITY}] opacity must be in [0, 1], got ${opacity}`,
    );
  }

  return {
    id: opts.id.trim(),
    source: opts.source.trim(),
    sourceLayer: opts.sourceLayer,
    projection,
    minzoom,
    maxzoom,
    opacity,
    filter: opts.filter,
    paint: opts.paint,
  };
}

// ---------------------------------------------------------------------------
// 从 paint 属性解析拉伸参数
// ---------------------------------------------------------------------------

/**
 * 从 paint 属性中提取拉伸图层初始参数。
 *
 * @param paint - 用户 paint 属性表
 * @returns 解析后的参数
 */
function parseExtrusionPaint(paint: Record<string, unknown> | undefined): {
  height: number | StyleExpression;
  base: number | StyleExpression;
  color: string;
  opacity: number;
  translate: [number, number];
  verticalGradient: boolean;
} {
  if (paint === undefined || paint === null) {
    return {
      height: DEFAULT_HEIGHT,
      base: DEFAULT_BASE_HEIGHT,
      color: DEFAULT_FILL_COLOR,
      opacity: DEFAULT_OPACITY,
      translate: [0, 0],
      verticalGradient: true,
    };
  }

  // 高度——可以是常量或表达式
  let height: number | StyleExpression = DEFAULT_HEIGHT;
  const h = paint['fill-extrusion-height'];
  if (typeof h === 'number' && Number.isFinite(h)) {
    height = h;
  } else if (Array.isArray(h)) {
    height = h as StyleExpression;
  }

  // 底部高度
  let base: number | StyleExpression = DEFAULT_BASE_HEIGHT;
  const b = paint['fill-extrusion-base'];
  if (typeof b === 'number' && Number.isFinite(b)) {
    base = b;
  } else if (Array.isArray(b)) {
    base = b as StyleExpression;
  }

  // 颜色
  let color = DEFAULT_FILL_COLOR;
  const c = paint['fill-extrusion-color'];
  if (typeof c === 'string') {
    color = c;
  }

  // 不透明度
  let opacity = DEFAULT_OPACITY;
  const o = paint['fill-extrusion-opacity'];
  if (typeof o === 'number' && Number.isFinite(o)) {
    opacity = Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, o));
  }

  // 平移
  let translate: [number, number] = [0, 0];
  const t = paint['fill-extrusion-translate'];
  if (Array.isArray(t) && t.length >= 2 &&
      typeof t[0] === 'number' && typeof t[1] === 'number' &&
      Number.isFinite(t[0]) && Number.isFinite(t[1])) {
    translate = [t[0], t[1]];
  }

  // 垂直渐变
  let verticalGradient = true;
  const vg = paint['fill-extrusion-vertical-gradient'];
  if (typeof vg === 'boolean') {
    verticalGradient = vg;
  }

  return { height, base, color, opacity, translate, verticalGradient };
}

// ---------------------------------------------------------------------------
// createExtrusionLayer 工厂
// ---------------------------------------------------------------------------

/**
 * 创建 3D 建筑拉伸图层实例。
 * 返回完整的 {@link ExtrusionLayer} 实现，包含多边形拉伸几何生成
 * （顶面 earcut + 底面 + 侧面）、垂直渐变、Lambert 漫反射光照。
 *
 * GPU 渲染管线（encode/encodePicking）在 MVP 阶段为桩实现。
 *
 * @param opts - 拉伸图层构造选项
 * @returns 完整的 ExtrusionLayer 实例
 * @throws Error 若选项校验失败
 *
 * @stability experimental
 *
 * @example
 * const extLayer = createExtrusionLayer({
 *   id: 'buildings-3d',
 *   source: 'openmaptiles',
 *   sourceLayer: 'building',
 *   paint: {
 *     'fill-extrusion-height': ['get', 'height'],
 *     'fill-extrusion-base': ['get', 'min_height'],
 *     'fill-extrusion-color': '#aaa',
 *     'fill-extrusion-opacity': 0.8,
 *   },
 * });
 * sceneGraph.addLayer(extLayer);
 */
export function createExtrusionLayer(opts: ExtrusionLayerOptions): ExtrusionLayer {
  // ── 1. 校验并规范化选项 ──
  const cfg = validateExtrusionOptions(opts);

  // ── 2. 解析 paint 属性 ──
  const extParams = parseExtrusionPaint(cfg.paint);

  // ── 3. 内部状态 ──

  // 拉伸参数（运行时可修改）
  let extHeight: number | StyleExpression = extParams.height;
  let extBase: number | StyleExpression = extParams.base;
  let extColor: string = extParams.color;
  let extOpacity: number = extParams.opacity;
  let extTranslate: [number, number] = extParams.translate;
  let extVerticalGradient: boolean = extParams.verticalGradient;

  // 光照状态——使用默认值初始化
  const lightState: ExtrusionLightState = {
    direction: computeLightDirection([1.15, DEFAULT_LIGHT_AZIMUTH, DEFAULT_LIGHT_POLAR]),
    color: new Float32Array([1, 1, 1]),
    intensity: DEFAULT_LIGHT_INTENSITY,
    anchor: 'viewport',
  };

  // 已生成的拉伸几何缓存（key = 要素 ID 或索引）
  const geometryCache = new Map<string, ExtrusionGeometry>();

  // 当前帧统计
  let currentTriangleCount = 0;
  let currentFeatureCount = 0;

  // paint/layout 属性缓存
  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  // 要素状态表
  const featureStateMap = new Map<string, Record<string, unknown>>();

  // 初始化 paint 属性缓存
  if (cfg.paint) {
    for (const k of Object.keys(cfg.paint)) {
      paintProps.set(k, cfg.paint[k]);
    }
  }

  // 图层生命周期标志
  let mounted = false;
  let layerContext: LayerContext | null = null;
  let dataReady = false;

  // ── 4. 构造 Layer 实现对象 ──
  const layer: ExtrusionLayer = {
    // ==================== 只读标识属性 ====================
    id: cfg.id,
    type: 'fill-extrusion' as const,
    source: cfg.source,
    projection: cfg.projection,

    // ==================== 可变渲染属性 ====================
    visible: true,
    opacity: extOpacity,
    zIndex: 0,

    // ==================== 只读计算属性 ====================

    /**
     * 数据是否已就绪。
     * @returns true 表示有可渲染内容
     */
    get isLoaded(): boolean {
      return dataReady;
    },

    /**
     * 拉伸图层在不透明度 < 1 时视为半透明。
     * @returns 是否半透明
     */
    get isTransparent(): boolean {
      return layer.opacity < OPACITY_MAX;
    },

    /**
     * 全局渲染次序。
     * @returns 渲染顺序数值
     */
    get renderOrder(): number {
      return layer.zIndex;
    },

    /**
     * 当前帧渲染的三角形总数。
     * @returns 三角形数
     */
    get triangleCount(): number {
      return currentTriangleCount;
    },

    /**
     * 当前帧渲染的要素数量。
     * @returns 要素数
     */
    get featureCount(): number {
      return currentFeatureCount;
    },

    // ==================== 生命周期方法 ====================

    /**
     * 图层挂载。
     *
     * @param context - 引擎上下文
     */
    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
    },

    /**
     * 图层卸载。
     */
    onRemove(): void {
      geometryCache.clear();
      featureStateMap.clear();
      currentTriangleCount = 0;
      currentFeatureCount = 0;
      mounted = false;
      layerContext = null;
      dataReady = false;
    },

    /**
     * 每帧更新——统计几何。
     *
     * @param deltaTime - 秒
     * @param camera - 相机快照
     */
    onUpdate(deltaTime: number, camera: CameraState): void {
      // 缩放级别可见性判断
      if (camera.zoom < cfg.minzoom || camera.zoom > cfg.maxzoom) {
        currentTriangleCount = 0;
        currentFeatureCount = 0;
        return;
      }

      // 统计当前帧几何
      let totalTris = 0;
      let featureCount = 0;
      for (const geom of geometryCache.values()) {
        totalTris += geom.triangleCount;
        featureCount++;
      }
      currentTriangleCount = totalTris;
      currentFeatureCount = featureCount;
    },

    /**
     * 将拉伸几何绘制命令编码进 RenderPass。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encode(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      if (__DEV__) {
        if (currentFeatureCount > 0) {
          console.debug(
            `[ExtrusionLayer:${cfg.id}] encode stub: ${currentFeatureCount} features, ` +
              `${currentTriangleCount} triangles, ` +
              `color=${extColor}, opacity=${extOpacity.toFixed(2)}, ` +
              `verticalGradient=${extVerticalGradient}, ` +
              `light.intensity=${lightState.intensity.toFixed(2)}`,
          );
        }
      }
    },

    /**
     * 拾取 Pass 编码——拉伸图层支持要素级拾取。
     * MVP 阶段为桩实现。
     *
     * @param _encoder - WebGPU 渲染通道编码器
     * @param _camera - 当前相机快照
     */
    encodePicking(_encoder: GPURenderPassEncoder, _camera: CameraState): void {
      // MVP 桩：完整实现需要将要素 ID 编码为拾取颜色
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

      switch (name) {
        case 'fill-extrusion-height':
          if (typeof value === 'number' && Number.isFinite(value)) {
            extHeight = value;
          } else if (Array.isArray(value)) {
            extHeight = value as StyleExpression;
          }
          break;
        case 'fill-extrusion-base':
          if (typeof value === 'number' && Number.isFinite(value)) {
            extBase = value;
          } else if (Array.isArray(value)) {
            extBase = value as StyleExpression;
          }
          break;
        case 'fill-extrusion-color':
          if (typeof value === 'string') {
            extColor = value;
          }
          break;
        case 'fill-extrusion-opacity':
          if (typeof value === 'number' && Number.isFinite(value)) {
            extOpacity = Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, value));
            layer.opacity = extOpacity;
          }
          break;
        case 'fill-extrusion-translate':
          if (
            Array.isArray(value) && value.length >= 2 &&
            typeof value[0] === 'number' && typeof value[1] === 'number' &&
            Number.isFinite(value[0]) && Number.isFinite(value[1])
          ) {
            extTranslate = [value[0], value[1]];
          }
          break;
        case 'fill-extrusion-vertical-gradient':
          if (typeof value === 'boolean') {
            extVerticalGradient = value;
          }
          break;
        default:
          break;
      }
    },

    /**
     * 设置 layout 属性值。
     *
     * @param name - layout 属性名
     * @param value - 属性值
     */
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);

      if (name === 'visibility') {
        layer.visible = value === 'visible';
      }
    },

    /**
     * 读取 paint 属性值。
     *
     * @param name - 属性名
     * @returns 值或 undefined
     */
    getPaintProperty(name: string): unknown {
      return paintProps.get(name);
    },

    /**
     * 读取 layout 属性值。
     *
     * @param name - 属性名
     * @returns 值或 undefined
     */
    getLayoutProperty(name: string): unknown {
      return layoutProps.get(name);
    },

    // ==================== 数据方法 ====================

    /**
     * 设置数据——接受 GeoJSON FeatureCollection（Polygon/MultiPolygon 要素）。
     * 将每个多边形要素生成拉伸几何并缓存。
     *
     * @param data - GeoJSON FeatureCollection
     */
    setData(data: unknown): void {
      if (data === null || data === undefined || typeof data !== 'object') {
        return;
      }

      const record = data as Record<string, unknown>;

      // 仅接受 FeatureCollection
      if (record['type'] !== 'FeatureCollection' || !Array.isArray(record['features'])) {
        return;
      }

      // 清空现有缓存
      geometryCache.clear();

      const features = record['features'] as Array<Record<string, unknown>>;
      const parsedColor = parseHexColor(extColor);

      for (let fi = 0; fi < features.length; fi++) {
        const feat = features[fi];
        if (feat === null || typeof feat !== 'object') continue;

        const geom = feat['geometry'] as Record<string, unknown> | null | undefined;
        if (geom === null || geom === undefined) continue;

        const geomType = geom['type'];
        const coords = geom['coordinates'];

        // 提取要素 ID
        const featureId = feat['id'] !== undefined ? feat['id'] as string | number : undefined;
        const cacheKey = featureId !== undefined ? String(featureId) : `idx-${fi}`;

        // 提取要素级高度（data-driven）
        const props = (feat['properties'] ?? {}) as Record<string, unknown>;
        let featureHeight: number;
        let featureBase: number;

        // 解析高度
        if (typeof extHeight === 'number') {
          featureHeight = extHeight;
        } else if (
          Array.isArray(extHeight) &&
          extHeight.length === 2 &&
          extHeight[0] === 'get' &&
          typeof extHeight[1] === 'string'
        ) {
          const v = props[extHeight[1]];
          featureHeight = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_HEIGHT;
        } else {
          featureHeight = DEFAULT_HEIGHT;
        }

        // 解析底部高度
        if (typeof extBase === 'number') {
          featureBase = extBase;
        } else if (
          Array.isArray(extBase) &&
          extBase.length === 2 &&
          extBase[0] === 'get' &&
          typeof extBase[1] === 'string'
        ) {
          const v = props[extBase[1]];
          featureBase = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_BASE_HEIGHT;
        } else {
          featureBase = DEFAULT_BASE_HEIGHT;
        }

        // 颜色——如果 fill-extrusion-color 是 data-driven，尝试从属性获取
        let featureColor = parsedColor;
        const colorPaint = paintProps.get('fill-extrusion-color');
        if (
          Array.isArray(colorPaint) &&
          colorPaint.length === 2 &&
          colorPaint[0] === 'get' &&
          typeof colorPaint[1] === 'string'
        ) {
          const cv = props[colorPaint[1]];
          if (typeof cv === 'string') {
            featureColor = parseHexColor(cv);
          }
        }

        // 处理 Polygon
        if (geomType === 'Polygon' && Array.isArray(coords) && coords.length > 0) {
          const outerRing = coords[0] as number[][];
          if (Array.isArray(outerRing) && outerRing.length >= 3) {
            // 将坐标数组扁平化为 [x0,y0, x1,y1, ...]
            const flat = new Float64Array(outerRing.length * 2);
            for (let ri = 0; ri < outerRing.length; ri++) {
              const pt = outerRing[ri];
              if (Array.isArray(pt) && pt.length >= 2) {
                flat[ri * 2] = pt[0];
                flat[ri * 2 + 1] = pt[1];
              }
            }

            const geomResult = generateExtrusionGeometry(
              flat, featureHeight, featureBase, featureColor,
              extVerticalGradient, lightState, featureId,
            );
            if (geomResult !== null) {
              geometryCache.set(cacheKey, geomResult);
            }
          }
        }

        // 处理 MultiPolygon
        if (geomType === 'MultiPolygon' && Array.isArray(coords)) {
          for (let pi = 0; pi < coords.length; pi++) {
            const polygon = coords[pi] as number[][][];
            if (!Array.isArray(polygon) || polygon.length === 0) continue;

            const outerRing = polygon[0];
            if (!Array.isArray(outerRing) || outerRing.length < 3) continue;

            const flat = new Float64Array(outerRing.length * 2);
            for (let ri = 0; ri < outerRing.length; ri++) {
              const pt = outerRing[ri];
              if (Array.isArray(pt) && pt.length >= 2) {
                flat[ri * 2] = pt[0];
                flat[ri * 2 + 1] = pt[1];
              }
            }

            const subKey = `${cacheKey}-${pi}`;
            const geomResult = generateExtrusionGeometry(
              flat, featureHeight, featureBase, featureColor,
              extVerticalGradient, lightState, featureId,
            );
            if (geomResult !== null) {
              geometryCache.set(subKey, geomResult);
            }
          }
        }
      }

      dataReady = geometryCache.size > 0;
    },

    /**
     * 读取当前几何缓存状态。
     *
     * @returns 摘要对象
     */
    getData(): unknown {
      return {
        featureCount: geometryCache.size,
        triangleCount: currentTriangleCount,
        color: extColor,
        opacity: extOpacity,
        verticalGradient: extVerticalGradient,
      };
    },

    // ==================== 要素查询方法 ====================

    /**
     * 包围盒要素查询——MVP 返回空数组。
     *
     * @param _bbox - 查询范围
     * @param _filter - 可选过滤器
     * @returns 空数组
     */
    queryFeatures(_bbox: BBox2D, _filter?: FilterExpression): Feature[] {
      return [];
    },

    /**
     * 屏幕点选查询——拉伸图层支持但 MVP 阶段返回空。
     *
     * @param _point - 屏幕坐标
     * @returns 空数组
     */
    queryRenderedFeatures(_point: [number, number]): Feature[] {
      return [];
    },

    // ==================== 要素状态方法 ====================

    /**
     * 设置要素状态。
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

    // ==================== 拉伸特有方法 ====================

    /**
     * 设置全局光照参数。
     *
     * @param light - 光照规格
     */
    setLight(light: LightSpec): void {
      // 锚定模式
      if (light.anchor !== undefined) {
        if (light.anchor !== 'map' && light.anchor !== 'viewport') {
          throw new Error(
            `[${EXTRUSION_ERROR_CODES.INVALID_LIGHT}] anchor must be 'map' or 'viewport', got '${light.anchor}'`,
          );
        }
        lightState.anchor = light.anchor;
      }

      // 光照颜色
      if (light.color !== undefined) {
        const [r, g, b] = parseHexColor(light.color);
        lightState.color[0] = r;
        lightState.color[1] = g;
        lightState.color[2] = b;
      }

      // 光照强度
      if (light.intensity !== undefined) {
        if (!Number.isFinite(light.intensity) || light.intensity < 0 || light.intensity > 1) {
          throw new Error(
            `[${EXTRUSION_ERROR_CODES.INVALID_LIGHT}] intensity must be in [0, 1], got ${light.intensity}`,
          );
        }
        lightState.intensity = light.intensity;
      }

      // 光照位置
      if (light.position !== undefined) {
        if (
          !Array.isArray(light.position) ||
          light.position.length < 3 ||
          !Number.isFinite(light.position[0]) ||
          !Number.isFinite(light.position[1]) ||
          !Number.isFinite(light.position[2])
        ) {
          throw new Error(
            `[${EXTRUSION_ERROR_CODES.INVALID_LIGHT}] position must be [radial, azimuth, polar] with finite numbers`,
          );
        }
        lightState.direction = computeLightDirection(light.position);
      }

      // 光照变化后需要重新计算所有几何的颜色（含光照因子）
      // MVP：标记需要重建——完整实现在 GPU Shader 中动态计算
    },
  };

  return layer;
}
