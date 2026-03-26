/**
 * @file GIS-Forge L5 — EP2 Projection Module（自定义投影扩展点）
 *
 * @description
 * **EP2** 将「投影数学 + WGSL 顶点变换片段」封装为可注册模块：CPU 侧 `project`/`unproject`
 * 用于瓦片调度与交互；GPU 侧 `vertexShaderCode` 由 L2 ShaderAssembler 组合进变体。
 * 本文件使用本地 `BBox2DLike` 描述经纬度边界，避免对 L0 类型的硬依赖。
 */

/**
 * 轴对齐经纬度边界（度）。west/east 可能跨越反子午线，由 `antimeridianHandling` 解释。
 */
export interface BBox2DLike {
  /** 西边界经度（度，通常为 [-180,180] 区间内的最小值语义）。 */
  west: number;
  /** 南边界纬度（度）。 */
  south: number;
  /** 东边界经度（度）。 */
  east: number;
  /** 北边界纬度（度）。 */
  north: number;
}

/**
 * 瓦片网格约定（可选）：供 TileScheduler 与投影共同使用。
 */
export interface TileGridDefinition {
  /** 瓦片像素边长（通常为 256 或 512）。 */
  readonly tileSize: number;
  /** 切片方案：XYZ 或 TMS（Y 轴翻转）。 */
  readonly scheme?: 'xyz' | 'tms';
  /** 最大可用缩放级别（含）。 */
  readonly maxZoom?: number;
}

/**
 * 可注册的投影模块：同时声明 CPU 与 GPU 侧契约。
 */
export interface ProjectionModule {
  /** 模块唯一 id（注册名）。 */
  readonly id: string;
  /** 可选：EPSG 代码字符串，如 `EPSG:3857`。 */
  readonly epsg?: string;
  /** 面向 UI / 调试的可读名称。 */
  readonly displayName: string;
  /**
   * WGSL 顶点阶段片段：需暴露 `projectPosition` 或文档约定入口，由 ShaderAssembler 拼接。
   * @remarks 必须与引擎 uniform/varying 命名约定一致，否则编译失败。
   */
  readonly vertexShaderCode: string;
  /** 可选：需要 per-fragment 修正时附加的片段着色 WGSL。 */
  readonly fragmentShaderCode?: string;
  /**
   * 经纬度 → 投影平面坐标（引擎单位，通常为墨卡托米或归一化）。
   * @param lon - 经度（度）
   * @param lat - 纬度（度）
   */
  project(lon: number, lat: number): [x: number, y: number];
  /**
   * 投影坐标 → 经纬度（`project` 的伪逆；奇异点需返回 NaN 并由调用方处理）。
   * @param x - 投影 X
   * @param y - 投影 Y
   */
  unproject(x: number, y: number): [lon: number, lat: number];
  /** 合法数据范围（投影或经纬度语义由 `isGlobal` 辅助解释）。 */
  readonly bounds: BBox2DLike;
  /** 是否为全球连续投影（影响瓦片环绕与裁剪）。 */
  readonly isGlobal: boolean;
  /** 可选：世界宽度（例如 Web 墨卡托 512×2^z 的基准尺度）。 */
  readonly worldSize?: number;
  /** 是否建议启用双精度 RTC（大坐标数值稳定）。 */
  readonly requiresDoublePrecision: boolean;
  /** X 方向是否周期性环绕（环球）。 */
  readonly wrapsX: boolean;
  /** 反子午线策略：分割几何 / 环绕 / 不处理。 */
  readonly antimeridianHandling: 'split' | 'wrap' | 'none';
  /** 可选：与投影匹配的瓦片网格参数。 */
  readonly tileGrid?: TileGridDefinition;
  /**
   * 可选：平面近似距离（与 `project` 同一单位）。
   */
  distance?(x1: number, y1: number, x2: number, y2: number): number;
  /**
   * 可选：平面近似面积（环为闭合折线序列坐标）。
   * @param ring - 扁平坐标序列 [x0,y0,x1,y1,...]
   */
  area?(ring: Float64Array): number;
  /** 可选：推荐相机模式，供 L6 预设参考。 */
  readonly preferredCameraType?: '2d' | '25d' | '3d';
}

/**
 * 返回恒等失败占位投影：仅在调试中使用，`project`/`unproject` 返回 NaN 对。
 *
 * @param id - 模块 id
 * @returns 无效但结构完整的 `ProjectionModule`
 *
 * @example
 * ```ts
 * const p = createInvalidProjectionModule('null-proj');
 * const xy = p.project(0, 0);
 * console.assert(Number.isNaN(xy[0]));
 * ```
 */
export function createInvalidProjectionModule(id: string): ProjectionModule {
  const safeId = typeof id === 'string' && id.trim().length > 0 ? id.trim() : 'invalid-projection';

  return {
    id: safeId,
    displayName: 'Invalid (NaN) Projection',
    vertexShaderCode: 'fn projectPosition_invalid() -> vec4<f32> { return vec4<f32>(0.0); }',
    bounds: { west: 0, south: 0, east: 0, north: 0 },
    isGlobal: false,
    requiresDoublePrecision: false,
    wrapsX: false,
    antimeridianHandling: 'none',
    project(_lon: number, _lat: number): [number, number] {
      // 明确返回 NaN，调用方应检测并拒绝使用该投影
      return [Number.NaN, Number.NaN];
    },
    unproject(_x: number, _y: number): [number, number] {
      return [Number.NaN, Number.NaN];
    },
  };
}
