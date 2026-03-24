// ============================================================
// L4/scene — AntiMeridianHandler：国际日期变更线（±180°）几何剖分
// 依赖 L0 Feature / BBox2D / TileCoord / Geometry。
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type {
  Geometry,
  GeometryCollectionGeometry,
  LineStringGeometry,
  LinearRing,
  MultiLineStringGeometry,
  MultiPointGeometry,
  MultiPolygonGeometry,
  PointGeometry,
  PolygonGeometry,
  Position,
} from '../../core/src/types/geometry.ts';

/** 浮点比较容差（度），避免边界抖动。 */
const EPS_DEG = 1e-9;

/**
 * 剖分与归一化门面：线/面在 ±180° 处切分，瓦片/经度包装。
 *
 * @example
 * const h = createAntiMeridianHandler();
 * const lon = h.normalizeLongitude(190);
 */
export interface AntiMeridianHandler {
  /**
   * 将经度包装到半开区间 [-180, 180)（180° 映射为 -180°）。
   *
   * @param lonDeg - 经度（度），可为任意有限值
   * @returns 归一化经度
   *
   * @example
   * handler.normalizeLongitude(190); // ≈ -170
   */
  normalizeLongitude(lonDeg: number): number;

  /**
   * 将瓦片 x 索引包装到当前 z 的有效列范围 [0, 2^z - 1]。
   *
   * @param coord - 瓦片坐标
   * @returns 包装后的瓦片坐标（y/z 原样复制，非法 z 抛错）
   *
   * @example
   * handler.normalizeTileCoord({ x: -1, y: 0, z: 2 }); // x → 3
   */
  normalizeTileCoord(coord: TileCoord): TileCoord;

  /**
   * 根据视域经纬度范围计算需要重复绘制的世界副本偏移（度）。
   * 偏移量用于将 [-180,180] 主世界平移 k×360°。
   *
   * @param viewBounds - 视域包围盒（经纬度或投影坐标下的西东南北）
   * @returns 偏移数组（通常包含 0，宽视域可含 ±360 等）
   *
   * @example
   * const offs = handler.getWorldCopies({ west: -200, south: -10, east: 200, north: 10 });
   */
  getWorldCopies(viewBounds: BBox2D): readonly number[];

  /**
   * 剖分 GeoJSON 几何：跨 ±180° 的 LineString/Polygon 等切分为多块。
   *
   * @param geometry - 输入几何
   * @returns 剖分后的几何数组（不跨线时长度为 1）
   *
   * @example
   * const parts = handler.splitGeometry({ type: 'LineString', coordinates: [[179,0],[-179,0]] });
   */
  splitGeometry(geometry: Geometry): readonly Geometry[];

  /**
   * 对要素数组逐个剖分几何并展开为一维数组。
   *
   * @param features - 输入要素
   * @returns 剖分后的要素列表
   *
   * @example
   * const out = handler.splitFeatures([feature]);
   */
  splitFeatures(features: readonly Feature[]): readonly Feature[];
}

/**
 * 克隆 Position（保留 2D/3D）。
 *
 * @param p - 位置
 * @returns 新元组
 *
 * @example
 * const q = clonePosition([1, 2, 3]);
 */
function clonePosition(p: Position): Position {
  if (p.length === 3) {
    return [p[0], p[1], p[2]];
  }
  return [p[0], p[1]];
}

/**
 * 将经度 unwrap 到以 lon0 为中心的连续分支（最短弧）。
 *
 * @param lon1 - 目标经度（度）
 * @param lon0 - 参考经度（度）
 * @returns 连续化后的 lon1（度）
 *
 * @example
 * unwrapLonRelative(-179, 179); // ≈ 181
 */
function unwrapLonRelative(lon1: number, lon0: number): number {
  let d = lon1 - lon0;
  // 归一化到 (-180, 180] 的步进差
  while (d > 180) {
    d -= 360;
  }
  while (d < -180) {
    d += 360;
  }
  return lon0 + d;
}

/**
 * 线性插值纬度（及可选高程）。
 *
 * @param lon0 - 段起点经度（连续分支）
 * @param lat0 - 段起点纬度
 * @param lon1 - 段终点经度（连续分支）
 * @param lat1 - 段终点纬度
 * @param atLon - 截断经度
 * @param z0 - 可选 z0
 * @param z1 - 可选 z1
 * @returns 截断点 Position
 *
 * @example
 * const p = interpolateAtLon(179, 0, 181, 1, 180);
 */
function interpolateAtLon(
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
  atLon: number,
  z0?: number,
  z1?: number,
): Position {
  const denom = lon1 - lon0;
  if (Math.abs(denom) < EPS_DEG) {
    // 退化：经度几乎相同，返回中点
    if (z0 !== undefined && z1 !== undefined) {
      return [atLon, (lat0 + lat1) * 0.5, (z0 + z1) * 0.5];
    }
    return [atLon, (lat0 + lat1) * 0.5];
  }
  const t = (atLon - lon0) / denom;
  const lat = lat0 + t * (lat1 - lat0);
  if (z0 !== undefined && z1 !== undefined) {
    const z = z0 + t * (z1 - z0);
    return [atLon, lat, z];
  }
  return [atLon, lat];
}

/**
 * 将单段 Position[] 拆成多段（在 ±180° 处切开）。
 *
 * @param p0 - 段起点
 * @param p1 - 段终点（原始坐标）
 * @returns 连续子段数组，每段至少两个点
 *
 * @example
 * const segs = splitSegment([179,0],[-179,0]);
 */
function splitSegment(p0: Position, p1: Position): readonly Position[][] {
  const lon0 = p0[0];
  const lon1u = unwrapLonRelative(p1[0], lon0);
  const lat0 = p0[1];
  const lat1 = p1[1];
  const z0 = p0.length === 3 ? p0[2] : undefined;
  const z1 = p1.length === 3 ? p1[2] : undefined;

  // 完全重合（数值上）
  if (Math.abs(lon1u - lon0) < EPS_DEG && Math.abs(lat1 - lat0) < EPS_DEG) {
    return [[p0, p1]];
  }

  // 检测与 +180° 或 -180° 经线的首次相交（在连续分支上）
  let boundary: number | null = null;
  if (lon0 < 180 - EPS_DEG && lon1u > 180 + EPS_DEG) {
    boundary = 180;
  } else if (lon0 > -180 + EPS_DEG && lon1u < -180 - EPS_DEG) {
    boundary = -180;
  }

  if (boundary === null) {
    return [[p0, p1]];
  }

  const cutOnBoundary = interpolateAtLon(lon0, lat0, lon1u, lat1, boundary, z0, z1);
  // 另一侧经线端点（几何同一点，不同表示）
  const opposite = boundary === 180 ? -180 : 180;
  const cutOpposite = interpolateAtLon(lon0, lat0, lon1u, lat1, opposite, z0, z1);

  // 第一段：p0 → boundary；第二段：opposite 起点 → p1 原始终点
  return [
    [p0, cutOnBoundary],
    [cutOpposite, p1],
  ];
}

/**
 * 剖分折线坐标序列。
 *
 * @param coords - LineString 坐标
 * @returns 多条折线
 *
 * @example
 * const lines = splitLineStringCoordinates([[170,0],[190,0]]);
 */
function splitLineStringCoordinates(coords: readonly Position[]): Position[][] {
  if (coords.length === 0) {
    return [];
  }
  if (coords.length === 1) {
    return [[coords[0]]];
  }

  const lines: Position[][] = [];
  let current: Position[] = [clonePosition(coords[0])];

  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = current[current.length - 1];
    const p1 = coords[i + 1];
    const parts = splitSegment(p0, p1);
    if (parts.length === 1) {
      current.push(clonePosition(parts[0][1]));
      continue;
    }
    // 两段：闭合前一段，开启新段
    current.push(clonePosition(parts[0][1]));
    lines.push(current);
    current = [clonePosition(parts[1][0]), clonePosition(parts[1][1])];
  }
  lines.push(current);
  return lines;
}

/**
 * 判断线性环是否闭合（首尾坐标相等，容差）。
 *
 * @param ring - 环
 * @returns 是否闭合
 *
 * @example
 * const c = isRingClosed(ring);
 */
function isRingClosed(ring: readonly Position[]): boolean {
  if (ring.length < 2) {
    return false;
  }
  const a = ring[0];
  const b = ring[ring.length - 1];
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.abs(dx) < EPS_DEG && Math.abs(dy) < EPS_DEG;
}

/**
 * 剖分单个环（外环或孔），返回若干环段（可能不闭合）。
 *
 * @param ring - 输入环
 * @returns 环数组
 *
 * @example
 * const rings = splitLinearRing([[0,0],[1,0],[1,1],[0,1],[0,0]]);
 */
function splitLinearRing(ring: LinearRing): LinearRing[] {
  if (ring.length < 4) {
    return [];
  }
  const closed = isRingClosed(ring);
  // 去掉末尾重复点以便折线剖分
  const coords = closed ? ring.slice(0, ring.length - 1) : ring.slice();
  if (coords.length < 3) {
    return [];
  }
  const splitLines = splitLineStringCoordinates(coords);
  const out: LinearRing[] = [];
  for (let s = 0; s < splitLines.length; s++) {
    const line = splitLines[s];
    if (line.length < 3) {
      continue;
    }
    // 尝试闭合：首尾足够近则成环
    const first = line[0];
    const last = line[line.length - 1];
    const dx = first[0] - last[0];
    const dy = first[1] - last[1];
    if (Math.abs(dx) < EPS_DEG && Math.abs(dy) < EPS_DEG) {
      out.push(line as LinearRing);
    } else {
      // 不闭合：丢弃该条（无法构成合法 Polygon 环）；由上层过滤
      continue;
    }
  }
  return out;
}

/**
 * 剖分 Polygon：仅处理外环；孔洞原样复制（若外环失败则返回空）。
 *
 * @param poly - 多边形
 * @returns 多边形数组
 *
 * @example
 * const ps = splitPolygonGeometry(poly);
 */
function splitPolygonGeometry(poly: PolygonGeometry): PolygonGeometry[] {
  const rings = poly.coordinates;
  if (rings.length === 0) {
    return [];
  }
  const outer = rings[0];
  const holes = rings.slice(1);
  const outers = splitLinearRing(outer);
  // 无法从外环得到合法子环时保留原 Polygon（避免数据丢失）
  if (outers.length === 0) {
    return [poly];
  }
  const result: PolygonGeometry[] = [];
  for (let i = 0; i < outers.length; i++) {
    // MVP：孔洞仅附加到第一个外环；复杂跨线孔洞需专用裁剪算法
    const coords: LinearRing[] = i === 0 ? [outers[i], ...holes] : [outers[i]];
    result.push({ type: 'Polygon', coordinates: coords });
  }
  return result;
}

/**
 * 将 MultiPolygon 压平为 Polygon 数组。
 *
 * @param mp - 多多边形
 * @returns Polygon 列表
 *
 * @example
 * const polys = flattenMultiPolygon(mp);
 */
function flattenMultiPolygon(mp: MultiPolygonGeometry): PolygonGeometry[] {
  const out: PolygonGeometry[] = [];
  for (let i = 0; i < mp.coordinates.length; i++) {
    const poly: PolygonGeometry = { type: 'Polygon', coordinates: mp.coordinates[i] };
    const sp = splitPolygonGeometry(poly);
    for (let j = 0; j < sp.length; j++) {
      out.push(sp[j]);
    }
  }
  return out;
}

/**
 * 递归剖分几何（供 GeometryCollection 使用，避免依赖 `this` 绑定）。
 *
 * @param geometry - 输入几何
 * @returns 剖分结果
 *
 * @example
 * const parts = splitGeometryRecursive(g);
 */
function splitGeometryRecursive(geometry: Geometry): readonly Geometry[] {
  if (geometry === null || typeof geometry !== 'object') {
    throw new TypeError('splitGeometryRecursive: geometry is required.');
  }
  switch (geometry.type) {
    case 'Point':
      return [geometry];
    case 'MultiPoint':
      return [geometry];
    case 'LineString': {
      const g = geometry as LineStringGeometry;
      const lines = splitLineStringCoordinates(g.coordinates);
      if (lines.length <= 1) {
        return [g];
      }
      const out: LineStringGeometry[] = [];
      for (let i = 0; i < lines.length; i++) {
        out.push({ type: 'LineString', coordinates: lines[i] });
      }
      return out;
    }
    case 'MultiLineString': {
      const g = geometry as MultiLineStringGeometry;
      const outLines: Position[][] = [];
      for (let i = 0; i < g.coordinates.length; i++) {
        const parts = splitLineStringCoordinates(g.coordinates[i]);
        for (let j = 0; j < parts.length; j++) {
          outLines.push(parts[j]);
        }
      }
      if (outLines.length === g.coordinates.length) {
        return [g];
      }
      return [{ type: 'MultiLineString', coordinates: outLines }];
    }
    case 'Polygon': {
      const g = geometry as PolygonGeometry;
      return splitPolygonGeometry(g);
    }
    case 'MultiPolygon': {
      const g = geometry as MultiPolygonGeometry;
      const polys = flattenMultiPolygon(g);
      if (polys.length === 0) {
        return [g];
      }
      if (polys.length === 1) {
        return [polys[0]];
      }
      return [{ type: 'MultiPolygon', coordinates: polys.map((p) => p.coordinates) }];
    }
    case 'GeometryCollection': {
      const g = geometry as GeometryCollectionGeometry;
      const expanded: Geometry[] = [];
      for (let i = 0; i < g.geometries.length; i++) {
        const sub = splitGeometryRecursive(g.geometries[i]);
        for (let j = 0; j < sub.length; j++) {
          expanded.push(sub[j]);
        }
      }
      if (expanded.length === g.geometries.length) {
        return [g];
      }
      return [{ type: 'GeometryCollection', geometries: expanded }];
    }
    default: {
      return [geometry];
    }
  }
}

/**
 * 实现 AntiMeridianHandler。
 *
 * @returns 处理器实例
 *
 * @example
 * const h = createAntiMeridianHandler();
 */
export function createAntiMeridianHandler(): AntiMeridianHandler {
  return {
    normalizeLongitude(lonDeg: number): number {
      if (!Number.isFinite(lonDeg)) {
        throw new RangeError('AntiMeridianHandler.normalizeLongitude: lonDeg must be finite.');
      }
      // 映射到 [-180, 180)，将 +180 规范为 -180 以符合半开区间
      let x = lonDeg;
      while (x < -180) {
        x += 360;
      }
      while (x >= 180) {
        x -= 360;
      }
      if (x === 180) {
        x = -180;
      }
      return x;
    },

    normalizeTileCoord(coord: TileCoord): TileCoord {
      if (coord === null || typeof coord !== 'object') {
        throw new TypeError('AntiMeridianHandler.normalizeTileCoord: coord is required.');
      }
      const z = coord.z;
      const x = coord.x;
      const y = coord.y;
      if (!Number.isFinite(z) || !Number.isInteger(z) || z < 0 || z > 30) {
        throw new RangeError('AntiMeridianHandler.normalizeTileCoord: z must be integer in [0, 30].');
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new RangeError('AntiMeridianHandler.normalizeTileCoord: x/y must be finite.');
      }
      const n = 1 << z;
      // 包装 x 到 [0, n-1]
      let wx = Math.trunc(x) % n;
      if (wx < 0) {
        wx += n;
      }
      const ty = Math.trunc(y);
      if (ty < 0 || ty >= n) {
        throw new RangeError('AntiMeridianHandler.normalizeTileCoord: y out of range for z.');
      }
      return { x: wx, y: ty, z };
    },

    getWorldCopies(viewBounds: BBox2D): readonly number[] {
      if (viewBounds === null || typeof viewBounds !== 'object') {
        throw new TypeError('AntiMeridianHandler.getWorldCopies: viewBounds is required.');
      }
      const w = viewBounds.west;
      const e = viewBounds.east;
      const s = viewBounds.south;
      const n = viewBounds.north;
      if (![w, e, s, n].every((v) => Number.isFinite(v))) {
        throw new RangeError('AntiMeridianHandler.getWorldCopies: bounds must be finite.');
      }
      if (w > e || s > n) {
        throw new RangeError('AntiMeridianHandler.getWorldCopies: invalid west/east or south/north order.');
      }
      // 计算与 [west,east] 相交的 360° 经度窗口索引
      const minK = Math.floor((w + 180) / 360);
      const maxK = Math.floor((e + 180) / 360);
      const offsets: number[] = [];
      for (let k = minK; k <= maxK; k++) {
        offsets.push(k * 360);
      }
      return offsets;
    },

    splitGeometry(geometry: Geometry): readonly Geometry[] {
      return splitGeometryRecursive(geometry);
    },

    splitFeatures(features: readonly Feature[]): readonly Feature[] {
      if (!Array.isArray(features)) {
        throw new TypeError('AntiMeridianHandler.splitFeatures: features must be an array.');
      }
      const out: Feature[] = [];
      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        if (f === null || typeof f !== 'object' || f.type !== 'Feature') {
          throw new TypeError(`AntiMeridianHandler.splitFeatures: invalid feature at index ${i}.`);
        }
        const parts = this.splitGeometry(f.geometry);
        for (let p = 0; p < parts.length; p++) {
          out.push({
            type: 'Feature',
            id: f.id,
            properties: f.properties,
            geometry: parts[p],
            _sourceId: f._sourceId,
            _layerId: f._layerId,
            _tileCoord: f._tileCoord,
            _state: f._state,
          });
        }
      }
      return out;
    },
  };
}
