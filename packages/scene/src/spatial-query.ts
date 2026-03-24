// ============================================================
// L4/scene/spatial-query.ts — 空间查询统一入口（MVP 桩实现）
// 层级：L4（场景）
// 职责：点选/框选/多边形/半径/最近邻等查询 API；后续对接 PickingEngine + R-Tree。
// 依赖：L0 Feature / BBox2D / FilterExpression（零 npm）。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { FilterExpression } from '../../core/src/types/style-spec.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 空间查询选项：限制图层、要素过滤器、数量上限、几何容差。
 *
 * @example
 * const q: QueryOptions = { layers: ['roads'], limit: 50, tolerance: 2 };
 */
export interface QueryOptions {
  /**
   * 仅在这些图层 ID 内查询；省略表示“全部图层”（由后续实现解析样式栈）。
   */
  readonly layers?: readonly string[];

  /**
   * MapLibre 风格过滤器表达式；省略表示不过滤属性。
   */
  readonly filter?: FilterExpression;

  /**
   * 最大返回要素条数；非正或 NaN 时由实现回退为安全默认。
   */
  readonly limit?: number;

  /**
   * 几何匹配容差：点查询时为像素半径；线/面为米或像素（由投影实现定义）；MVP 忽略。
   * 单位：像素或米（实现阶段固定文档）。
   */
  readonly tolerance?: number;
}

/**
 * 统一空间查询接口（MVP 返回空结果，占位 wiring）。
 *
 * @example
 * const sq = createSpatialQuery();
 * const hits = sq.queryAtPoint([100, 200], {});
 */
export interface SpatialQuery {
  /**
   * 屏幕像素点命中查询（自上而下拾取）。
   *
   * @param screenPoint - 屏幕坐标 [cssX, cssY]（原点左上）
   * @param options - 查询选项
   * @returns 命中要素列表（MVP 空数组）
   *
   * @example
   * const f = q.queryAtPoint([120, 340], { layers: ['poi'] });
   */
  queryAtPoint(screenPoint: readonly [number, number], options?: QueryOptions): Feature[];

  /**
   * 轴对齐屏幕矩形内查询。
   *
   * @param rect - [minX, minY, maxX, maxY] 屏幕像素
   * @param options - 查询选项
   * @returns 命中要素（MVP 空数组）
   *
   * @example
   * const f = q.queryInRect([0, 0, 800, 600], {});
   */
  queryInRect(rect: readonly [number, number, number, number], options?: QueryOptions): Feature[];

  /**
   * 地理包围盒内查询（经纬度度）。
   *
   * @param bbox - west/south/east/north
   * @param options - 查询选项
   * @returns 命中要素（MVP 空数组）
   *
   * @example
   * const f = q.queryInBBox({ west: -10, south: -10, east: 10, north: 10 }, {});
   */
  queryInBBox(bbox: BBox2D, options?: QueryOptions): Feature[];

  /**
   * 多边形内查询（外环为坐标数组；洞为后续环，MVP 不校验闭合）。
   *
   * @param rings - 多边形环列表（[lng,lat][] 每条环）
   * @param options - 查询选项
   * @returns 命中要素（MVP 空数组）
   *
   * @example
   * const f = q.queryInPolygon([[[0,0],[1,0],[1,1],[0,1],[0,0]]], {});
   */
  queryInPolygon(
    rings: readonly (readonly (readonly [number, number])[])[],
    options?: QueryOptions,
  ): Feature[];

  /**
   * 固定半径（米）圆域内查询，中心为经纬度。
   *
   * @param centerLngLat - [longitude, latitude] 度
   * @param radiusMeters - 半径（米），须为正有限数
   * @param options - 查询选项
   * @returns 命中要素（MVP 空数组）
   *
   * @example
   * const f = q.queryInRadius([116.4, 39.9], 500, {});
   */
  queryInRadius(
    centerLngLat: readonly [number, number],
    radiusMeters: number,
    options?: QueryOptions,
  ): Feature[];

  /**
   * 最近邻查询：给定经纬度点，返回最近要素。
   *
   * @param lngLat - [longitude, latitude] 度
   * @param options - 查询选项
   * @returns 最近要素或 null（MVP 恒 null）
   *
   * @example
   * const f = q.queryNearest([116.4, 39.9], { layers: ['roads'] });
   */
  queryNearest(lngLat: readonly [number, number], options?: QueryOptions): Feature | null;

  /**
   * 屏幕坐标 → 经纬度；需相机与投影（MVP 恒 null）。
   *
   * @param screenPoint - [cssX, cssY]
   * @returns [lng, lat] 或 null
   *
   * @example
   * const ll = q.screenToLngLat([400, 300]);
   */
  screenToLngLat(screenPoint: readonly [number, number]): [number, number] | null;

  /**
   * 经纬度 → 屏幕坐标（MVP 恒 null）。
   *
   * @param lngLat - [longitude, latitude] 度
   * @returns [cssX, cssY] 或 null
   *
   * @example
   * const s = q.lngLatToScreen([116.4, 39.9]);
   */
  lngLatToScreen(lngLat: readonly [number, number]): [number, number] | null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 默认最大返回条数（防止未来实现时一次分配过大） */
const DEFAULT_QUERY_LIMIT = 65536;

/**
 * 规范化 limit：正整数，否则回退默认。
 *
 * @param limit - 用户输入
 * @returns 安全上限
 *
 * @example
 * normalizeLimit(NaN); // → 65536
 */
function normalizeLimit(limit: number | undefined): number {
  if (limit == null) {
    return DEFAULT_QUERY_LIMIT;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_QUERY_LIMIT;
  }
  return Math.min(Math.floor(limit), DEFAULT_QUERY_LIMIT);
}

/**
 * 校验屏幕点坐标有限。
 *
 * @param screenPoint - 点坐标
 * @returns 是否合法
 *
 * @example
 * isFinitePoint([1, 2]); // → true
 */
function isFinitePoint(screenPoint: readonly [number, number]): boolean {
  return (
    Array.isArray(screenPoint) &&
    screenPoint.length >= 2 &&
    Number.isFinite(screenPoint[0]) &&
    Number.isFinite(screenPoint[1])
  );
}

/**
 * 校验矩形 [minX,minY,maxX,maxY]。
 *
 * @param rect - 矩形
 * @returns 是否合法
 *
 * @example
 * isValidRect([0,0,1,1]); // → true
 */
function isValidRect(rect: readonly [number, number, number, number]): boolean {
  if (!Array.isArray(rect) || rect.length < 4) {
    return false;
  }
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(rect[i])) {
      return false;
    }
  }
  return rect[0] <= rect[2] && rect[1] <= rect[3];
}

/**
 * 校验地理包围盒。
 *
 * @param bbox - BBox2D
 * @returns 是否合法
 *
 * @example
 * isValidBBox({ west: 0, south: 0, east: 1, north: 1 }); // → true
 */
function isValidBBox(bbox: BBox2D): boolean {
  const { west, south, east, north } = bbox;
  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    return false;
  }
  return west <= east && south <= north;
}

/**
 * 校验经纬度点。
 *
 * @param lngLat - [lon, lat]
 * @returns 是否合法
 *
 * @example
 * isValidLngLat([116, 40]); // → true
 */
function isValidLngLat(lngLat: readonly [number, number]): boolean {
  return (
    Array.isArray(lngLat) &&
    lngLat.length >= 2 &&
    Number.isFinite(lngLat[0]) &&
    Number.isFinite(lngLat[1]) &&
    lngLat[0] >= -180 &&
    lngLat[0] <= 180 &&
    lngLat[1] >= -90 &&
    lngLat[1] <= 90
  );
}

/**
 * 校验半径米。
 *
 * @param m - 半径
 * @returns 是否合法
 *
 * @example
 * isValidRadius(100); // → true
 */
function isValidRadius(m: number): boolean {
  return Number.isFinite(m) && m > 0;
}

/**
 * 创建空间查询 MVP 实例（结果为空 / null，占位后续引擎接入）。
 *
 * @returns SpatialQuery 实现
 *
 * @example
 * const spatialQuery = createSpatialQuery();
 */
export function createSpatialQuery(): SpatialQuery {
  const api: SpatialQuery = {
    queryAtPoint(screenPoint: readonly [number, number], options?: QueryOptions): Feature[] {
      try {
        if (!isFinitePoint(screenPoint)) {
          return [];
        }
        normalizeLimit(options?.limit);
        // 未来：PickingEngine.pick(screenPoint, options)
        return [];
      } catch (err) {
        console.error('[SpatialQuery] queryAtPoint failed', err);
        return [];
      }
    },

    queryInRect(rect: readonly [number, number, number, number], options?: QueryOptions): Feature[] {
      try {
        if (!isValidRect(rect)) {
          return [];
        }
        normalizeLimit(options?.limit);
        return [];
      } catch (err) {
        console.error('[SpatialQuery] queryInRect failed', err);
        return [];
      }
    },

    queryInBBox(bbox: BBox2D, options?: QueryOptions): Feature[] {
      try {
        if (!isValidBBox(bbox)) {
          return [];
        }
        normalizeLimit(options?.limit);
        return [];
      } catch (err) {
        console.error('[SpatialQuery] queryInBBox failed', err);
        return [];
      }
    },

    queryInPolygon(
      rings: readonly (readonly (readonly [number, number])[])[],
      options?: QueryOptions,
    ): Feature[] {
      try {
        if (!Array.isArray(rings) || rings.length === 0) {
          return [];
        }
        normalizeLimit(options?.limit);
        return [];
      } catch (err) {
        console.error('[SpatialQuery] queryInPolygon failed', err);
        return [];
      }
    },

    queryInRadius(
      centerLngLat: readonly [number, number],
      radiusMeters: number,
      options?: QueryOptions,
    ): Feature[] {
      try {
        if (!isValidLngLat(centerLngLat) || !isValidRadius(radiusMeters)) {
          return [];
        }
        normalizeLimit(options?.limit);
        return [];
      } catch (err) {
        console.error('[SpatialQuery] queryInRadius failed', err);
        return [];
      }
    },

    queryNearest(lngLat: readonly [number, number], options?: QueryOptions): Feature | null {
      try {
        if (!isValidLngLat(lngLat)) {
          return null;
        }
        normalizeLimit(options?.limit);
        return null;
      } catch (err) {
        console.error('[SpatialQuery] queryNearest failed', err);
        return null;
      }
    },

    screenToLngLat(screenPoint: readonly [number, number]): [number, number] | null {
      try {
        if (!isFinitePoint(screenPoint)) {
          return null;
        }
        return null;
      } catch (err) {
        console.error('[SpatialQuery] screenToLngLat failed', err);
        return null;
      }
    },

    lngLatToScreen(lngLat: readonly [number, number]): [number, number] | null {
      try {
        if (!isValidLngLat(lngLat)) {
          return null;
        }
        return null;
      } catch (err) {
        console.error('[SpatialQuery] lngLatToScreen failed', err);
        return null;
      }
    },
  };

  return api;
}
