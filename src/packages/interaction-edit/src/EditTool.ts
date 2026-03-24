// ============================================================
// EditTool.ts — 要素顶点编辑（拖拽 / 插入 / 删除）
// ============================================================

import type { Feature } from '../../core/src/types/feature.ts';
import type { LineStringGeometry, PolygonGeometry } from '../../core/src/types/geometry.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

/** 历史栈上限 */
const MAX_HISTORY = 50;

/** 二维点 */
export type Vec2 = readonly [number, number];

/**
 * 编辑中的顶点引用。
 */
export interface EditVertexRef {
  /** 要素 id */
  readonly featureId: string | number;
  /** 环索引（面要素外环为 0） */
  readonly ringIndex: number;
  /** 顶点索引 */
  readonly vertexIndex: number;
}

/**
 * 编辑工具选项。
 */
export interface EditToolOptions {
  /** 目标图层 id */
  readonly layer: string;
  /** 吸附距离（像素，屏幕空间；由上层传入换算后的世界容差时可复用） */
  readonly snapDistance?: number;
}

/**
 * 编辑状态快照。
 */
export interface EditState {
  /** 当前选中的要素 id */
  readonly selectedFeatureId: string | number | null;
  /** 高亮顶点 */
  readonly activeVertex: EditVertexRef | null;
  /** 是否启用 */
  readonly enabled: boolean;
}

/**
 * 编辑工具实例。
 *
 * @stability experimental
 */
export interface EditTool {
  enable(): void;
  disable(): void;
  selectFeature(featureId: string | number | null): void;
  /** 绑定当前编辑的要素几何（LineString / Polygon） */
  setWorkingFeature(feature: Feature<LineStringGeometry | PolygonGeometry> | null): void;
  getEditState(): EditState;
  undo(): void;
  redo(): void;
  save(): Feature<LineStringGeometry | PolygonGeometry> | null;
  /** 内部：指针移动时更新悬停顶点（地图应传入世界坐标） */
  pointerMove(worldXY: Vec2): void;
  /** 内部：按下拖拽 */
  pointerDown(worldXY: Vec2): void;
  /** 内部：释放 */
  pointerUp(worldXY: Vec2): void;
  /** 内部：删除键 */
  handleDeleteKey(): void;
}

type EditableGeom = LineStringGeometry | PolygonGeometry;

function cloneLineString(g: LineStringGeometry): LineStringGeometry {
  return {
    type: 'LineString',
    coordinates: g.coordinates.map((c) => [c[0], c[1]] as [number, number]),
  };
}

function clonePolygon(g: PolygonGeometry): PolygonGeometry {
  return {
    type: 'Polygon',
    coordinates: g.coordinates.map((ring) => ring.map((c) => [c[0], c[1]] as [number, number])),
  };
}

function cloneFeature(f: Feature<EditableGeom>): Feature<EditableGeom> {
  const g = f.geometry;
  const ng = g.type === 'LineString' ? cloneLineString(g) : clonePolygon(g);
  return {
    type: 'Feature',
    id: f.id,
    geometry: ng,
    properties: { ...f.properties },
  };
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * 创建要素编辑工具。
 *
 * @param options - 图层与吸附
 * @returns 工具实例
 *
 * @stability experimental
 */
export function createEditTool(options: EditToolOptions): EditTool {
  if (!options.layer) {
    throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'EditTool requires layer id', {});
  }
  const snapDist = Math.max(0, options.snapDistance ?? 8);
  const snap2 = snapDist * snapDist;

  let enabled = false;
  let working: Feature<EditableGeom> | null = null;
  let selectedId: string | number | null = null;
  let activeVertex: EditVertexRef | null = null;
  const undoStack: Feature<EditableGeom>[] = [];
  const redoStack: Feature<EditableGeom>[] = [];
  let dragging = false;

  function pushUndo(snapshot: Feature<EditableGeom>): void {
    undoStack.push(cloneFeature(snapshot));
    if (undoStack.length > MAX_HISTORY) {
      undoStack.shift();
    }
    redoStack.length = 0;
  }

  function nearestVertexOnLine(worldXY: Vec2, line: LineStringGeometry): (EditVertexRef & { coord: Vec2 }) | null {
    let best: (EditVertexRef & { coord: Vec2; d2: number }) | null = null;
    const coords = line.coordinates;
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const p: Vec2 = [c[0], c[1]];
      const d = dist2(worldXY, p);
      if (d <= snap2 && (!best || d < best.d2)) {
        best = { featureId: selectedId as string | number, ringIndex: 0, vertexIndex: i, coord: p, d2: d };
      }
    }
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const ax = a[0];
      const ay = a[1];
      const bx = b[0];
      const by = b[1];
      const px = worldXY[0];
      const py = worldXY[1];
      const abx = bx - ax;
      const aby = by - ay;
      const apx = px - ax;
      const apy = py - ay;
      const ab2 = abx * abx + aby * aby;
      let t = ab2 > 0 ? (apx * abx + apy * aby) / ab2 : 0;
      t = Math.max(0, Math.min(1, t));
      const mx = ax + abx * t;
      const my = ay + aby * t;
      const mid: Vec2 = [mx, my];
      const d = dist2(worldXY, mid);
      if (d <= snap2 && (!best || d < best.d2)) {
        best = {
          featureId: selectedId as string | number,
          ringIndex: 0,
          vertexIndex: i,
          coord: mid,
          d2: d,
        };
      }
    }
    if (!best) {
      return null;
    }
    return { featureId: best.featureId, ringIndex: best.ringIndex, vertexIndex: best.vertexIndex, coord: best.coord };
  }

  function nearestVertexPolygon(worldXY: Vec2, poly: PolygonGeometry): (EditVertexRef & { coord: Vec2 }) | null {
    let best: (EditVertexRef & { coord: Vec2; d2: number }) | null = null;
    for (let ringIndex = 0; ringIndex < poly.coordinates.length; ringIndex++) {
      const ring = poly.coordinates[ringIndex];
      for (let i = 0; i < ring.length; i++) {
        const c = ring[i];
        const p: Vec2 = [c[0], c[1]];
        const d = dist2(worldXY, p);
        if (d <= snap2 && (!best || d < best.d2)) {
          best = { featureId: selectedId as string | number, ringIndex, vertexIndex: i, coord: p, d2: d };
        }
      }
    }
    if (!best) {
      return null;
    }
    return { featureId: best.featureId, ringIndex: best.ringIndex, vertexIndex: best.vertexIndex, coord: best.coord };
  }

  return {
    enable(): void {
      enabled = true;
    },
    disable(): void {
      enabled = false;
      dragging = false;
    },
    selectFeature(featureId: string | number | null): void {
      selectedId = featureId;
      activeVertex = null;
    },
    setWorkingFeature(feature: Feature<LineStringGeometry | PolygonGeometry> | null): void {
      if (feature === null) {
        working = null;
        return;
      }
      const gt = feature.geometry as EditableGeom;
      if (gt.type !== 'LineString' && gt.type !== 'Polygon') {
        throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'EditTool only supports LineString/Polygon', {
          type: (gt as { type?: string }).type,
        });
      }
      working = cloneFeature(feature as Feature<EditableGeom>);
      if (feature.id !== undefined) {
        selectedId = feature.id;
      }
    },
    getEditState(): EditState {
      return {
        selectedFeatureId: selectedId,
        activeVertex,
        enabled,
      };
    },
    undo(): void {
      const prev = undoStack.pop();
      if (!prev || !working) {
        return;
      }
      redoStack.push(cloneFeature(working));
      working = prev;
    },
    redo(): void {
      const next = redoStack.pop();
      if (!next || !working) {
        return;
      }
      undoStack.push(cloneFeature(working));
      working = next;
    },
    save(): Feature<LineStringGeometry | PolygonGeometry> | null {
      if (!working) {
        return null;
      }
      return cloneFeature(working);
    },

    pointerMove(worldXY: Vec2): void {
      if (!enabled || !working || selectedId === null) {
        return;
      }
      const g = working.geometry;
      if (g.type === 'LineString') {
        const hit = nearestVertexOnLine(worldXY, g);
        activeVertex = hit ? { featureId: hit.featureId, ringIndex: hit.ringIndex, vertexIndex: hit.vertexIndex } : null;
      } else {
        const hit = nearestVertexPolygon(worldXY, g);
        activeVertex = hit ? { featureId: hit.featureId, ringIndex: hit.ringIndex, vertexIndex: hit.vertexIndex } : null;
      }
    },

    pointerDown(worldXY: Vec2): void {
      if (!enabled || !working) {
        return;
      }
      if (working.geometry.type === 'LineString') {
        const hit = nearestVertexOnLine(worldXY, working.geometry);
        activeVertex = hit ? { featureId: hit.featureId, ringIndex: hit.ringIndex, vertexIndex: hit.vertexIndex } : null;
      } else {
        const hit = nearestVertexPolygon(worldXY, working.geometry);
        activeVertex = hit ? { featureId: hit.featureId, ringIndex: hit.ringIndex, vertexIndex: hit.vertexIndex } : null;
      }
      dragging = activeVertex !== null;
      if (dragging && working && activeVertex) {
        pushUndo(working);
      }
    },

    pointerUp(worldXY: Vec2): void {
      if (!enabled || !working || !dragging || !activeVertex) {
        dragging = false;
        return;
      }
      const av = activeVertex;
      const g = working.geometry;
      if (g.type === 'LineString') {
        const coords = g.coordinates.slice();
        coords[av.vertexIndex] = [worldXY[0], worldXY[1]];
        working = {
          ...working,
          geometry: { type: 'LineString', coordinates: coords },
        };
      } else {
        const rings = g.coordinates.map((ring, ri) => {
          if (ri !== av.ringIndex) {
            return ring.slice();
          }
          const r = ring.slice();
          r[av.vertexIndex] = [worldXY[0], worldXY[1]];
          return r;
        });
        working = {
          ...working,
          geometry: { type: 'Polygon', coordinates: rings },
        };
      }
      dragging = false;
    },

    handleDeleteKey(): void {
      if (!enabled || !working || !activeVertex) {
        return;
      }
      pushUndo(working);
      const g = working.geometry;
      if (g.type === 'LineString') {
        if (g.coordinates.length <= 2) {
          throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'LineString must keep at least 2 vertices', {});
        }
        const coords = g.coordinates.filter((_, i) => i !== activeVertex!.vertexIndex);
        working = { ...working, geometry: { type: 'LineString', coordinates: coords } };
      } else {
        const ri = activeVertex.ringIndex;
        const vi = activeVertex.vertexIndex;
        const ring = g.coordinates[ri].filter((_, i) => i !== vi);
        if (ring.length < 4) {
          throw new GeoForgeError(GeoForgeErrorCode.INVALID_LAYER_SPEC, 'Polygon ring must keep at least 4 positions', {});
        }
        const coords = g.coordinates.map((r, i) => (i === ri ? ring : r));
        working = { ...working, geometry: { type: 'Polygon', coordinates: coords } };
      }
      activeVertex = null;
    },
  };
}

declare const __DEV__: boolean;
