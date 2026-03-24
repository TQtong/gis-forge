// ============================================================
// SplitTool.ts — 线/面切割工具
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { LineStringGeometry, PolygonGeometry, Position } from '../../core/src/types/geometry.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/**
 * 切割线选项。
 */
export interface SplitToolOptions {
  /** 目标图层 id */
  readonly layer: string;
}

/**
 * 切割预览（几何片段）。
 */
export interface SplitPreview {
  /** 切割后左侧/首段 */
  readonly left: LineStringGeometry | PolygonGeometry;
  /** 切割后右侧/次段 */
  readonly right: LineStringGeometry | PolygonGeometry;
}

/**
 * 切割工具实例。
 *
 * @stability experimental
 */
export interface SplitTool {
  enable(): void;
  disable(): void;
  /** 绑定待切割的线或面 */
  setTargetFeature(feature: Feature<LineStringGeometry | PolygonGeometry> | null): void;
  /** 设置切割折线（屏幕/世界坐标由上层统一） */
  split(cuttingLine: LineStringGeometry): SplitPreview | null;
  getSplitPreview(): SplitPreview | null;
}

/**
 * 线段求交参数 t,u ∈[0,1]。
 */
function segmentIntersection(
  a0: Position,
  a1: Position,
  b0: Position,
  b1: Position,
  out: { x: number; y: number; t: number; u: number },
): boolean {
  const x1 = a0[0];
  const y1 = a0[1];
  const x2 = a1[0];
  const y2 = a1[1];
  const x3 = b0[0];
  const y3 = b0[1];
  const x4 = b1[0];
  const y4 = b1[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-14) {
    return false;
  }
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) {
    return false;
  }
  out.x = x1 + t * (x2 - x1);
  out.y = y1 + t * (y2 - y1);
  out.t = t;
  out.u = u;
  return true;
}

/**
 * 用折线切割线串（在首交点处分割）。
 */
function splitLineString(target: LineStringGeometry, cutter: LineStringGeometry): SplitPreview | null {
  if (target.coordinates.length < 2 || cutter.coordinates.length < 2) {
    return null;
  }
  const tmp = { x: 0, y: 0, t: 0, u: 0 };
  for (let i = 0; i < target.coordinates.length - 1; i++) {
    const ta0 = target.coordinates[i];
    const ta1 = target.coordinates[i + 1];
    for (let j = 0; j < cutter.coordinates.length - 1; j++) {
      const cb0 = cutter.coordinates[j];
      const cb1 = cutter.coordinates[j + 1];
      if (segmentIntersection(ta0, ta1, cb0, cb1, tmp)) {
        const p: Position = [tmp.x, tmp.y];
        const left: LineStringGeometry = {
          type: 'LineString',
          coordinates: [...target.coordinates.slice(0, i + 1), p],
        };
        const right: LineStringGeometry = {
          type: 'LineString',
          coordinates: [p, ...target.coordinates.slice(i + 1)],
        };
        return { left, right };
      }
    }
  }
  return null;
}

/**
 * 简化：对外环多边形沿切割线分为两段（凸/简单情形：交于两点则取路径中间分割）。
 */
function splitPolygonSimple(poly: PolygonGeometry, cutter: LineStringGeometry): SplitPreview | null {
  const outer = poly.coordinates[0];
  if (outer.length < 4 || cutter.coordinates.length < 2) {
    return null;
  }
  const hits: Position[] = [];
  const tmp = { x: 0, y: 0, t: 0, u: 0 };
  for (let i = 0; i < outer.length - 1; i++) {
    const a0 = outer[i];
    const a1 = outer[i + 1];
    for (let j = 0; j < cutter.coordinates.length - 1; j++) {
      if (segmentIntersection(a0, a1, cutter.coordinates[j], cutter.coordinates[j + 1], tmp)) {
        hits.push([tmp.x, tmp.y]);
      }
    }
  }
  if (hits.length < 2) {
    return null;
  }
  const p0 = hits[0];
  const p1 = hits[1];
  const leftRing: Position[] = [p0, p1, ...outer.slice(1, -1), p0];
  const rightRing: Position[] = [p1, p0, ...outer.slice(1, -1), p1];
  const left: PolygonGeometry = { type: 'Polygon', coordinates: [leftRing] };
  const right: PolygonGeometry = { type: 'Polygon', coordinates: [rightRing] };
  return { left, right };
}

/**
 * 创建切割工具。
 *
 * @param options - 目标图层
 * @returns 工具实例
 *
 * @stability experimental
 */
export function createSplitTool(options: SplitToolOptions): SplitTool {
  if (!options.layer) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'SplitTool requires layer', {});
  }
  let enabled = false;
  let preview: SplitPreview | null = null;
  let target: Feature<LineStringGeometry | PolygonGeometry> | null = null;

  return {
    enable(): void {
      enabled = true;
    },
    disable(): void {
      enabled = false;
      preview = null;
    },
    setTargetFeature(feature: Feature<LineStringGeometry | PolygonGeometry> | null): void {
      target = feature;
      preview = null;
    },
    split(cuttingLine: LineStringGeometry): SplitPreview | null {
      if (!enabled || !target) {
        return null;
      }
      const g = target.geometry;
      let result: SplitPreview | null = null;
      if (g.type === 'LineString') {
        result = splitLineString(g, cuttingLine);
      } else if (g.type === 'Polygon') {
        result = splitPolygonSimple(g, cuttingLine);
      }
      preview = result;
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.debug('[SplitTool] split result', { has: !!result });
      }
      return result;
    },
    getSplitPreview(): SplitPreview | null {
      return preview;
    },
  };
}

declare const __DEV__: boolean;
