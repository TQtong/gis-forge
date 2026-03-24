// ============================================================
// runtime/worker-entry.ts — Worker 任务入口（MVP：可测试的处理函数）
// 层级：L3（运行时调度）
// 职责：按任务类型调用 L0 算法（三角剖分/简化/索引/包含/相交等），
//       返回结构化结果；真实 Worker 中可 `postMessage` 包装本模块输出。
// 零 npm 依赖；算法全部来自 `@geoforge/core`。
// ============================================================

import {
  GeoForgeError,
  GeoForgeErrorCode,
  bboxOverlap,
  createRTree,
  createSpatialHash,
  douglasPeucker,
  earcut,
  pointInPolygon,
  rayAABB,
  segmentSegment,
  splitDouble,
  splitDoubleArray,
  visvalingam,
} from '@geoforge/core';

import type { BBox2D } from '@geoforge/core';
import type { RTreeItem } from '@geoforge/core';

// ---------------------------------------------------------------------------
// 消息协议（与 WorkerPool 提交的 `WorkerTask` 语义对齐）
// ---------------------------------------------------------------------------

/**
 * 主线程 / 测试代码传入 `handleWorkerMessage` 的入站载荷。
 * `type` 与 `WorkerPool` 的 `WorkerTaskType` 字符串对齐，便于同一套协议接入真实 Worker。
 */
export interface WorkerInboundMessage {
  /** 与 `WorkerTask.id` 对应的唯一任务 id。 */
  readonly id: string;
  /** 任务类型键（如 `earcut`、`mvt-decode`）。 */
  readonly type: string;
  /** 任务输入；具体形状由 `type` 决定。 */
  readonly payload: unknown;
}

/**
 * 成功完成的出站消息。
 */
export interface WorkerOutboundSuccess {
  /** 对应入站 `id`。 */
  readonly id: string;
  /** 成功标记。 */
  readonly ok: true;
  /** 任务结果（可序列化子集）。 */
  readonly result: unknown;
  /** 可选 transferable 列表（真实 Worker 路径使用）。 */
  readonly transferables?: Transferable[];
}

/**
 * 失败时的出站消息。
 */
export interface WorkerOutboundFailure {
  /** 对应入站 `id`。 */
  readonly id: string;
  /** 失败标记。 */
  readonly ok: false;
  /** 人类可读错误信息。 */
  readonly error: string;
  /** 可选稳定错误码（如 `GeoForgeError.code`）。 */
  readonly code?: string;
}

/**
 * `handleWorkerMessage` 的联合返回类型。
 */
export type WorkerOutboundMessage = WorkerOutboundSuccess | WorkerOutboundFailure;

// ---------------------------------------------------------------------------
// 入站解析与辅助
// ---------------------------------------------------------------------------

/**
 * 将未知输入解析为 {@link WorkerInboundMessage}；失败时返回 `null`。
 *
 * @param raw - `postMessage` 或单测直接传入的对象
 * @returns 结构化消息或 `null`
 */
function parseInbound(raw: unknown): WorkerInboundMessage | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    return null;
  }
  if (typeof o.type !== 'string' || o.type.length === 0) {
    return null;
  }
  return {
    id: o.id,
    type: o.type,
    payload: 'payload' in o ? o.payload : undefined,
  };
}

/**
 * 将任意错误归一化为字符串消息。
 *
 * @param err - 捕获值
 * @returns 非空字符串
 */
function normalizeErrorMessage(err: unknown): string {
  if (err instanceof GeoForgeError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown worker error';
  }
}

/**
 * 从 `payload` 读取 number[][] 折线；用于线简化任务。
 *
 * @param payload - 任意载荷
 * @returns 点列表
 */
function readPoints2D(payload: unknown): number[][] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: number[][] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const p = payload[i];
    if (!Array.isArray(p) || p.length < 2) {
      continue;
    }
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    out.push([x, y]);
  }
  return out;
}

/**
 * 从 `payload` 读取 earcut 所需的平铺顶点数组与可选孔洞索引。
 *
 * @param payload - 期望 `{ data: number[], holeIndices?: number[], dim?: number }`
 * @returns 参数三元组
 */
function readEarcutPayload(payload: unknown): {
  data: ArrayLike<number>;
  holeIndices: number[] | undefined;
  dim: number;
} {
  const fallback = { data: new Float64Array(0), holeIndices: undefined as number[] | undefined, dim: 2 };
  if (payload === null || typeof payload !== 'object') {
    return fallback;
  }
  const o = payload as Record<string, unknown>;
  const dataRaw = o.data;
  let data: ArrayLike<number>;
  if (dataRaw instanceof Float64Array || dataRaw instanceof Float32Array) {
    data = dataRaw;
  } else if (Array.isArray(dataRaw)) {
    const tmp = new Float64Array(dataRaw.length);
    for (let i = 0; i < dataRaw.length; i += 1) {
      const v = Number(dataRaw[i]);
      tmp[i] = Number.isFinite(v) ? v : 0;
    }
    data = tmp;
  } else {
    return fallback;
  }
  let holeIndices: number[] | undefined;
  if (Array.isArray(o.holeIndices)) {
    holeIndices = [];
    for (let h = 0; h < o.holeIndices.length; h += 1) {
      const hi = Number(o.holeIndices[h]);
      if (Number.isFinite(hi) && hi >= 0) {
        holeIndices.push(Math.floor(hi));
      }
    }
    if (holeIndices.length === 0) {
      holeIndices = undefined;
    }
  }
  let dim = 2;
  if (typeof o.dim === 'number' && Number.isFinite(o.dim) && o.dim >= 2 && o.dim <= 3) {
    dim = Math.floor(o.dim);
  }
  return { data, holeIndices, dim };
}

/**
 * 读取 R-Tree 批量加载项列表。
 *
 * @param payload - 任意
 * @returns `RTreeItem[]`
 */
function readRTreeItems(payload: unknown): RTreeItem<unknown>[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const items: RTreeItem<unknown>[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const row = payload[i];
    if (row === null || typeof row !== 'object') {
      continue;
    }
    const r = row as Record<string, unknown>;
    const minX = Number(r.minX);
    const minY = Number(r.minY);
    const maxX = Number(r.maxX);
    const maxY = Number(r.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      continue;
    }
    items.push({
      minX,
      minY,
      maxX,
      maxY,
      data: 'data' in r ? r.data : i,
    });
  }
  return items;
}

/**
 * 读取轴对齐包围盒。
 *
 * @param raw - 任意对象
 * @returns 包围盒或 `null`
 */
function readBBox(
  raw: unknown,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const minX = Number(o.minX);
  const minY = Number(o.minY);
  const maxX = Number(o.maxX);
  const maxY = Number(o.maxY);
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 简单网格聚类：将点按 `cellSize` 划分到桶中，返回每个桶内点下标。
 * 作为 `cluster` 任务的 MVP 实现（无 Supercluster 依赖）。
 *
 * @param points - 平面点集
 * @param cellSize - 网格边长（与坐标单位一致，必须为正有限数）
 * @returns 每个簇的点索引列表
 */
function clusterPointsGrid(points: [number, number][], cellSize: number): number[][] {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    return [];
  }
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < points.length; i += 1) {
    const cx = Math.floor(points[i][0] / cellSize);
    const cy = Math.floor(points[i][1] / cellSize);
    const key = `${cx},${cy}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(i);
  }
  return [...buckets.values()];
}

/**
 * 处理 `spatial-hash` 任务：插入若干项后可选矩形查询。
 *
 * @param payload - `{ cellSize, inserts, query? }`
 * @returns 查询结果或插入计数
 */
function runSpatialHashTask(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'spatial-hash: invalid payload', {});
  }
  const o = payload as Record<string, unknown>;
  const cellSize = Number(o.cellSize);
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'spatial-hash: cellSize must be positive', {});
  }
  const hash = createSpatialHash<unknown>(cellSize);
  const inserts = Array.isArray(o.inserts) ? o.inserts : [];
  for (let i = 0; i < inserts.length; i += 1) {
    const it = inserts[i];
    if (it === null || typeof it !== 'object') {
      continue;
    }
    const row = it as Record<string, unknown>;
    const minX = Number(row.minX);
    const minY = Number(row.minY);
    const maxX = Number(row.maxX);
    const maxY = Number(row.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      continue;
    }
    hash.insert(minX, minY, maxX, maxY, 'data' in row ? row.data : i);
  }
  const q = o.query;
  if (q !== undefined && q !== null && typeof q === 'object') {
    const qb = readBBox(q);
    if (!qb) {
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'spatial-hash: invalid query bbox', {});
    }
    return { queryResult: hash.query(qb.minX, qb.minY, qb.maxX, qb.maxY) };
  }
  return { inserted: inserts.length };
}

/**
 * 处理 `contain` 任务：`pointInPolygon`。
 *
 * @param payload - `{ point: [x,y], polygon: number[][] }`
 * @returns `{ inside: boolean }`
 */
function runContainTask(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'contain: invalid payload', {});
  }
  const o = payload as Record<string, unknown>;
  const pt = o.point;
  if (!Array.isArray(pt) || pt.length < 2) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'contain: point must be [x,y]', {});
  }
  const point: [number, number] = [Number(pt[0]), Number(pt[1])];
  const poly = readPoints2D(o.polygon);
  const inside = pointInPolygon(point, poly);
  return { inside };
}

/**
 * 处理 `intersect` 任务中的 `segment-segment` 分支。
 *
 * @param payload - `{ kind: 'segment', ... }`
 */
function runIntersectSegment(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'intersect: invalid payload', {});
  }
  const o = payload as Record<string, unknown>;
  const hit = segmentSegment(
    Number(o.x1),
    Number(o.y1),
    Number(o.x2),
    Number(o.y2),
    Number(o.x3),
    Number(o.y3),
    Number(o.x4),
    Number(o.y4),
  );
  return { intersection: hit };
}

/**
 * 处理 `intersect` 中的 `ray-aabb`。
 *
 * @param payload - 射线与 AABB 参数
 */
function runIntersectRayAabb(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'intersect: invalid payload', {});
  }
  const o = payload as Record<string, unknown>;
  const ox = Number(o.ox);
  const oy = Number(o.oy);
  const oz = Number(o.oz ?? 0);
  const dx = Number(o.dx);
  const dy = Number(o.dy);
  const dz = Number(o.dz ?? 0);
  const minX = Number(o.minX);
  const minY = Number(o.minY);
  const minZ = Number(o.minZ ?? -1e38);
  const maxX = Number(o.maxX);
  const maxY = Number(o.maxY);
  const maxZ = Number(o.maxZ ?? 1e38);
  const t = rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ);
  return { t };
}

/**
 * 处理 `intersect` 中的 `bbox-overlap`。
 *
 * @param payload - 两个 bbox
 */
function runIntersectBboxOverlap(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'intersect: invalid payload', {});
  }
  const o = payload as Record<string, unknown>;
  const a = readBBox(o.a);
  const b = readBBox(o.b);
  if (!a || !b) {
    throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'intersect: invalid a/b bbox', {});
  }
  const bboxA: BBox2D = {
    west: a.minX,
    south: a.minY,
    east: a.maxX,
    north: a.maxY,
  };
  const bboxB: BBox2D = {
    west: b.minX,
    south: b.minY,
    east: b.maxX,
    north: b.maxY,
  };
  const overlap = bboxOverlap(bboxA, bboxB);
  return { overlap };
}

/**
 * 按任务类型执行具体算法并返回可序列化结果。
 *
 * @param type - 任务类型
 * @param payload - 输入载荷
 * @returns 结果对象
 */
function dispatchTask(type: string, payload: unknown): unknown {
  switch (type) {
    case 'earcut':
    case 'triangulate': {
      const { data, holeIndices, dim } = readEarcutPayload(payload);
      const triangles = earcut(data, holeIndices, dim);
      return { triangles };
    }

    case 'simplify': {
      if (payload === null || typeof payload !== 'object') {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'simplify: invalid payload', {});
      }
      const o = payload as Record<string, unknown>;
      const points = readPoints2D(o.points);
      const tolerance = Number(o.tolerance);
      const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0;
      const mode = typeof o.mode === 'string' ? o.mode : 'douglasPeucker';
      const simplified =
        mode === 'visvalingam' ? visvalingam(points, tol) : douglasPeucker(points, tol);
      return { points: simplified, mode };
    }

    case 'rtree-build': {
      const items = readRTreeItems(payload);
      const tree = createRTree<unknown>();
      tree.load(items);
      return {
        size: tree.size,
        items: tree.all().map((it) => ({
          minX: it.minX,
          minY: it.minY,
          maxX: it.maxX,
          maxY: it.maxY,
          data: it.data,
        })),
      };
    }

    case 'rtree-query': {
      if (payload === null || typeof payload !== 'object') {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'rtree-query: invalid payload', {});
      }
      const o = payload as Record<string, unknown>;
      const items = readRTreeItems(o.items);
      const bbox = readBBox(o.bbox);
      if (!bbox) {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'rtree-query: invalid bbox', {});
      }
      const tree = createRTree<unknown>();
      tree.load(items);
      const found = tree.search(bbox);
      return {
        result: found.map((it) => ({
          minX: it.minX,
          minY: it.minY,
          maxX: it.maxX,
          maxY: it.maxY,
          data: it.data,
        })),
      };
    }

    case 'cluster': {
      if (payload === null || typeof payload !== 'object') {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'cluster: invalid payload', {});
      }
      const o = payload as Record<string, unknown>;
      const ptsRaw = o.points;
      const cellSize = Number(o.cellSize);
      const points: [number, number][] = [];
      if (Array.isArray(ptsRaw)) {
        for (let i = 0; i < ptsRaw.length; i += 1) {
          const p = ptsRaw[i];
          if (!Array.isArray(p) || p.length < 2) {
            continue;
          }
          const x = Number(p[0]);
          const y = Number(p[1]);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            points.push([x, y]);
          }
        }
      }
      const clusters = clusterPointsGrid(points, cellSize);
      return { clusters, pointCount: points.length };
    }

    case 'spatial-hash':
      return runSpatialHashTask(payload);

    case 'contain':
      return runContainTask(payload);

    case 'intersect': {
      if (payload === null || typeof payload !== 'object') {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'intersect: invalid payload', {});
      }
      const kind = String((payload as Record<string, unknown>).kind ?? 'segment');
      if (kind === 'ray-aabb') {
        return runIntersectRayAabb(payload);
      }
      if (kind === 'bbox-overlap') {
        return runIntersectBboxOverlap(payload);
      }
      return runIntersectSegment(payload);
    }

    case 'split-double': {
      if (payload === null || typeof payload !== 'object') {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'split-double: invalid payload', {});
      }
      const o = payload as Record<string, unknown>;
      if (typeof o.value === 'number' && Number.isFinite(o.value)) {
        const pair = splitDouble(o.value);
        return { high: pair[0], low: pair[1] };
      }
      const arr = o.values;
      let f64: Float64Array | null = null;
      if (arr instanceof Float64Array) {
        f64 = arr;
      } else if (Array.isArray(arr)) {
        f64 = new Float64Array(arr.length);
        for (let i = 0; i < arr.length; i += 1) {
          f64[i] = Number(arr[i]);
        }
      }
      if (!f64) {
        throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, 'split-double: expected value or values', {});
      }
      const outHigh = new Float32Array(f64.length);
      const outLow = new Float32Array(f64.length);
      splitDoubleArray(f64, outHigh, outLow);
      return { high: outHigh, low: outLow };
    }

    case 'mvt-decode':
    case 'raster-decode':
    case 'geojson-parse':
    case 'label-collision':
    case 'text-shaping':
    case 'terrain-mesh':
    case 'terrain-decode':
    case 'tiles3d-bvh':
    case 'antimeridian-cut':
    case 'boolean-op':
      throw new GeoForgeError(
        GeoForgeErrorCode.TILE_DECODE_FAILED,
        `Worker task "${type}" is not implemented in L0 worker-entry (MVP).`,
        { taskType: type },
      );

    case 'custom': {
      return { echo: payload };
    }

    default:
      throw new GeoForgeError(GeoForgeErrorCode.TILE_DECODE_FAILED, `Unknown worker task type: ${type}`, {
        taskType: type,
      });
  }
}

/**
 * 处理单条 Worker 任务：调用 L0 算法并返回成功/失败结构。
 * 供单元测试与主线程模拟池直接调用；真实 Worker 可将返回值 `postMessage`。
 *
 * @param raw - 任意入站对象（需含 `id` 与 `type`）
 * @returns 成功或失败消息（绝不抛异常到调用方）
 *
 * @example
 * const out = handleWorkerMessage({ id: '1', type: 'earcut', payload: { data: [0,0, 1,0, 0,1] } });
 * if (out.ok) console.log(out.result);
 */
export function handleWorkerMessage(raw: unknown): WorkerOutboundMessage {
  const inbound = parseInbound(raw);
  if (!inbound) {
    return {
      id: 'invalid',
      ok: false,
      error: 'Invalid worker message (expected { id: string, type: string, payload?: unknown })',
      code: GeoForgeErrorCode.TILE_DECODE_FAILED,
    };
  }

  try {
    const result = dispatchTask(inbound.type, inbound.payload);
    return {
      id: inbound.id,
      ok: true,
      result,
    };
  } catch (err) {
    const message = normalizeErrorMessage(err);
    const code = err instanceof GeoForgeError ? err.code : GeoForgeErrorCode.TILE_DECODE_FAILED;
    return {
      id: inbound.id,
      ok: false,
      error: message,
      code,
    };
  }
}

/**
 * 在真实 `DedicatedWorkerGlobalScope` 上安装 `onmessage`，将事件转发给 {@link handleWorkerMessage}
 * 并将结果 `postMessage` 回主线程。
 * 若当前上下文不是 Worker，则静默跳过（不抛错）。
 */
export function installWorkerOnMessageHandler(): void {
  try {
    const scope = globalThis as unknown as {
      onmessage: ((ev: MessageEvent) => void) | null;
      postMessage?: (msg: unknown) => void;
    };
    if (typeof scope.postMessage !== 'function') {
      return;
    }
    scope.onmessage = (ev: MessageEvent): void => {
      const out = handleWorkerMessage(ev.data);
      scope.postMessage!(out);
    };
  } catch {
    // 非 Worker 环境：忽略
  }
}

declare const __DEV__: boolean;
