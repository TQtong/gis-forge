// ============================================================
// cesium-terrain-provider.ts — layer.json 解析 + 瓦片二进制加载
// ============================================================

import {
  DEFAULT_ACCEPT_HEADER,
  MAX_CONCURRENT_REQUESTS,
  QM_COORD_RANGE,
  type CesiumTerrainMetadata,
} from './types.ts';
import {
  decodeQuantizedMesh,
  type QuantizedMeshRaw,
} from './quantized-mesh-decoder.ts';

/** Heightfield 光栅化目标分辨率（65×65，与 Cesium HeightmapTerrainData 对齐） */
const HEIGHTFIELD_SIZE = 65;

interface LayerJson {
  readonly attribution?: string;
  readonly version?: string;
  readonly bounds?: readonly number[];
  readonly tiles?: readonly string[];
  readonly available?: ReadonlyArray<ReadonlyArray<{
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
  }>>;
  readonly maxzoom?: number;
  readonly minzoom?: number;
  readonly scheme?: 'tms' | 'xyz';
}

/** 已光栅化的 heightfield 条目 */
interface HeightfieldEntry {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** 65×65 Float32，NaN 表示无覆盖（降级为 0） */
  readonly heights: Float32Array;
  readonly minHeight: number;
  readonly maxHeight: number;
}

export class CesiumTerrainProvider {
  private _baseUrl: string;
  private _meta: CesiumTerrainMetadata | null = null;
  private _readyPromise: Promise<CesiumTerrainMetadata> | null = null;
  private _inflight = new Map<string, AbortController>();
  private _concurrent = 0;
  private _pending: Array<{ z: number; x: number; y: number; resolve: (v: QuantizedMeshRaw) => void; reject: (e: Error) => void }> = [];

  /** 已下载 + 光栅化的高程网格，键 "z/x/y"（Cesium 地理 TMS） */
  private _heightfields = new Map<string, HeightfieldEntry>();
  /** 正在 ensure 的 QM 瓦片集合（防重复提交） */
  private _ensuring = new Set<string>();
  /** heightfield 就绪回调（layer 订阅后可重建 mesh） */
  private _onHeightfieldReadyCallbacks: Array<(e: HeightfieldEntry) => void> = [];

  constructor(baseUrl: string) {
    // 确保 baseUrl 末尾有斜杠
    this._baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  }

  get baseUrl(): string { return this._baseUrl; }
  get metadata(): CesiumTerrainMetadata | null { return this._meta; }
  get ready(): boolean { return this._meta !== null; }

  /** 拉取并解析 layer.json（重复调用返回相同 Promise） */
  async initialize(): Promise<CesiumTerrainMetadata> {
    if (this._readyPromise !== null) {
      return this._readyPromise;
    }
    this._readyPromise = (async () => {
      const url = this._baseUrl + 'layer.json';
      let resp: Response;
      try {
        resp = await fetch(url, { credentials: 'omit' });
      } catch (e) {
        throw new Error(`[TERRAIN_LAYER_JSON_FETCH_FAILED] ${url}: ${(e as Error).message}`);
      }
      if (!resp.ok) {
        throw new Error(
          `[TERRAIN_LAYER_JSON_FETCH_FAILED] ${url} status=${resp.status}`,
        );
      }
      const json = (await resp.json()) as LayerJson;

      // 解析 available 矩阵以推断 maxZoom
      const available = Array.isArray(json.available) ? json.available : [];
      const maxZoom = typeof json.maxzoom === 'number'
        ? json.maxzoom
        : Math.max(0, available.length - 1);
      const minZoom = typeof json.minzoom === 'number' ? json.minzoom : 0;

      // URL 模板：若 layer.json 提供则使用；否则使用 Cesium 默认
      const tiles: readonly string[] = Array.isArray(json.tiles) && json.tiles.length > 0
        ? json.tiles.map((t) => (t.startsWith('http') ? t : this._baseUrl + t.replace(/^\.?\//, '')))
        : [this._baseUrl + '{z}/{x}/{y}.terrain?v=' + (json.version ?? '1.0.0')];

      const bounds = (Array.isArray(json.bounds) && json.bounds.length === 4)
        ? ([json.bounds[0], json.bounds[1], json.bounds[2], json.bounds[3]] as const)
        : ([-180, -90, 180, 90] as const);

      const meta: CesiumTerrainMetadata = {
        bounds,
        maxZoom,
        minZoom,
        tileUrlTemplates: tiles,
        attribution: json.attribution ?? '',
        version: json.version ?? '1.0.0',
        available,
      };
      this._meta = meta;
      return meta;
    })();
    return this._readyPromise;
  }

  /**
   * 判断瓦片是否可用（根据 available 矩阵）。
   */
  isTileAvailable(z: number, x: number, y: number): boolean {
    if (this._meta === null) { return false; }
    if (z < this._meta.minZoom || z > this._meta.maxZoom) { return false; }
    const level = this._meta.available[z];
    if (level === undefined) { return false; }
    for (let i = 0; i < level.length; i++) {
      const r = level[i];
      if (x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY) {
        return true;
      }
    }
    return false;
  }

  /** 请求并解码单个瓦片（内部维护 6 并发） */
  loadTile(z: number, x: number, y: number): Promise<QuantizedMeshRaw> {
    const key = `${z}/${x}/${y}`;
    if (this._inflight.has(key)) {
      // 已在请求中 → 返回新的 Promise 包装，实际复用单次结果
      return new Promise((resolve, reject) => {
        this._pending.push({ z, x, y, resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      this._pending.push({ z, x, y, resolve, reject });
      this._drain();
    });
  }

  abortAll(): void {
    for (const c of this._inflight.values()) {
      try { c.abort(); } catch { /* ignore */ }
    }
    this._inflight.clear();
    this._pending.length = 0;
    this._concurrent = 0;
    this._ensuring.clear();
  }

  // ═════════════════════════════════════════════════════════════════
  // Heightfield 采样 API（被 mesh-builder 使用）
  // ═════════════════════════════════════════════════════════════════

  /** 订阅 heightfield 就绪事件（用于失效并重建 mesh 瓦片） */
  onHeightfieldReady(cb: (e: HeightfieldEntry) => void): () => void {
    this._onHeightfieldReadyCallbacks.push(cb);
    return () => {
      const i = this._onHeightfieldReadyCallbacks.indexOf(cb);
      if (i >= 0) { this._onHeightfieldReadyCallbacks.splice(i, 1); }
    };
  }

  /**
   * 采样给定经纬度的高程（米）。
   *
   * @param strictZoom 可选：严格在指定 Cesium QM zoom 层级查找，命中即采样，
   *                   不命中返回 0。保证同一 mesh 所有顶点使用同一层级的
   *                   heightfield，避免相邻顶点跨 LOD 采样造成的垂直尖刺。
   *                   未指定时退化为 "从 maxZoom 向下扫描最深命中层"。
   */
  sampleHeight(lng: number, lat: number, strictZoom?: number): number {
    if (this._meta === null) { return 0; }

    if (strictZoom !== undefined) {
      const z = strictZoom;
      if (z < this._meta.minZoom || z > this._meta.maxZoom) { return 0; }
      const tilesX = 2 * Math.pow(2, z);
      const tilesY = Math.pow(2, z);
      const lonStep = 360 / tilesX;
      const latStep = 180 / tilesY;
      const fx = (lng + 180) / lonStep;
      const fy = (lat + 90) / latStep;
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      if (tx < 0 || tx >= tilesX || ty < 0 || ty >= tilesY) { return 0; }
      const hf = this._heightfields.get(`${z}/${tx}/${ty}`);
      if (hf === undefined) { return 0; }
      return this._bilinearSample(hf.heights, fx - tx, fy - ty);
    }

    for (let z = this._meta.maxZoom; z >= this._meta.minZoom; z--) {
      const tilesX = 2 * Math.pow(2, z);
      const tilesY = Math.pow(2, z);
      const lonStep = 360 / tilesX;
      const latStep = 180 / tilesY;
      const fx = (lng + 180) / lonStep;
      const fy = (lat + 90) / latStep;
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      if (tx < 0 || tx >= tilesX || ty < 0 || ty >= tilesY) { continue; }
      const key = `${z}/${tx}/${ty}`;
      const hf = this._heightfields.get(key);
      if (hf === undefined) { continue; }
      const u = fx - tx;
      const v = fy - ty;
      return this._bilinearSample(hf.heights, u, v);
    }
    return 0;
  }

  /**
   * 确保覆盖给定 bbox 的 QM 瓦片处于下载/解码中。
   * 已缓存或正在处理的跳过。下载完成后 heightfield 自动光栅化并触发回调。
   *
   * @param west/south/east/north - 地理 bbox（度）
   * @param targetQmZoom - 目标 Cesium QM 层级
   */
  ensureCoverage(
    west: number, south: number, east: number, north: number,
    targetQmZoom: number,
  ): void {
    if (this._meta === null) { return; }
    const z = Math.max(this._meta.minZoom, Math.min(this._meta.maxZoom, targetQmZoom));
    const tilesX = 2 * Math.pow(2, z);
    const tilesY = Math.pow(2, z);
    const lonStep = 360 / tilesX;
    const latStep = 180 / tilesY;
    const x0 = Math.max(0, Math.floor((west + 180) / lonStep));
    const x1 = Math.min(tilesX - 1, Math.floor((east + 180 - 1e-9) / lonStep));
    const y0 = Math.max(0, Math.floor((south + 90) / latStep));
    const y1 = Math.min(tilesY - 1, Math.floor((north + 90 - 1e-9) / latStep));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.isTileAvailable(z, tx, ty)) { continue; }
        const key = `${z}/${tx}/${ty}`;
        if (this._heightfields.has(key)) { continue; }
        if (this._ensuring.has(key)) { continue; }
        this._ensuring.add(key);
        void this.loadTile(z, tx, ty).then((raw) => {
          this._ensuring.delete(key);
          const hf = this._rasterizeToHeightfield(raw, z, tx, ty);
          this._heightfields.set(key, hf);
          for (const cb of this._onHeightfieldReadyCallbacks) { cb(hf); }
        }).catch(() => {
          this._ensuring.delete(key);
        });
      }
    }
  }

  /** 返回已缓存的 heightfield 数量（用于调试/统计） */
  get heightfieldCount(): number { return this._heightfields.size; }

  /**
   * 为一组地理采样点找到它们**全部都有缓存覆盖**的最深 Cesium zoom 层级。
   * 任何一个点在某个 zoom 找不到缓存 → 降到更浅的 zoom；逐层下降直到
   * 找到全命中的层级，或返回 -1 表示无任何层级可用。
   *
   * 这是保证一个 mesh 内所有顶点**同源采样**的唯一可靠方法，消除相邻
   * 顶点从不同 zoom heightfield 取值造成的金字塔尖刺。
   */
  findCommonHeightfieldZoom(
    points: ReadonlyArray<readonly [number, number]>,
    maxZoomHint?: number,
  ): number {
    if (this._meta === null || points.length === 0) { return -1; }
    const maxZ = Math.min(this._meta.maxZoom, maxZoomHint ?? this._meta.maxZoom);
    for (let z = maxZ; z >= this._meta.minZoom; z--) {
      const tilesX = 2 * Math.pow(2, z);
      const tilesY = Math.pow(2, z);
      const lonStep = 360 / tilesX;
      const latStep = 180 / tilesY;
      let allIn = true;
      for (let i = 0; i < points.length; i++) {
        const lng = points[i][0];
        const lat = points[i][1];
        const fx = (lng + 180) / lonStep;
        const fy = (lat + 90) / latStep;
        const tx = Math.floor(fx);
        const ty = Math.floor(fy);
        if (tx < 0 || tx >= tilesX || ty < 0 || ty >= tilesY) {
          allIn = false;
          break;
        }
        if (!this._heightfields.has(`${z}/${tx}/${ty}`)) {
          allIn = false;
          break;
        }
      }
      if (allIn) { return z; }
    }
    return -1;
  }

  private _bilinearSample(grid: Float32Array, u: number, v: number): number {
    const N = HEIGHTFIELD_SIZE;
    const fx = Math.max(0, Math.min(N - 1, u * (N - 1)));
    const fy = Math.max(0, Math.min(N - 1, v * (N - 1)));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(N - 1, x0 + 1);
    const y1 = Math.min(N - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = grid[y0 * N + x0];
    const h10 = grid[y0 * N + x1];
    const h01 = grid[y1 * N + x0];
    const h11 = grid[y1 * N + x1];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - ty) + h1 * ty;
  }

  /**
   * 把 QM 三角网光栅化到 65×65 Float32 heightfield。
   *
   * 采用三遍策略，保证**每一个 grid cell 都能拿到合理高度**，不会因为
   * 小三角形跳过 grid 中心或 fallback 用全局平均造成单顶点尖刺：
   *
   *   Pass 1: 把每个 QM 顶点 stamp 到它最近的 grid cell（覆盖"小三角形
   *           完全落在 cell 内部"的情况）；
   *   Pass 2: 对每个三角形做 bbox barycentric 光栅化（覆盖大部分 cell，
   *           last-write-wins 会被插值结果覆盖 pass 1 的顶点粗值）；
   *   Pass 3: 若仍有未触达 cell，用**迭代膨胀**从已触达邻居取平均
   *           （局部传播，而非全局平均，避免远处平均值污染近处）。
   */
  private _rasterizeToHeightfield(
    raw: QuantizedMeshRaw,
    z: number, x: number, y: number,
  ): HeightfieldEntry {
    const N = HEIGHTFIELD_SIZE;
    const out = new Float32Array(N * N);
    const touched = new Uint8Array(N * N);

    const hMin = raw.header.minimumHeight;
    const hMax = raw.header.maximumHeight;
    const hRange = hMax - hMin;
    const QMR = QM_COORD_RANGE;
    const u = raw.uArray;
    const v = raw.vArray;
    const h = raw.hArray;
    const tri = raw.triangleIndices;
    const vc = raw.vertexCount;

    const toGridX = (uq: number): number => (uq * (N - 1)) / QMR;
    const toGridY = (vq: number): number => (vq * (N - 1)) / QMR;
    const toMeters = (hq: number): number => hMin + (hq / QMR) * hRange;

    // ── Pass 1: 顶点直接 stamp 最近 cell ──
    for (let vi = 0; vi < vc; vi++) {
      const gx = Math.round(toGridX(u[vi]));
      const gy = Math.round(toGridY(v[vi]));
      if (gx < 0 || gx >= N || gy < 0 || gy >= N) { continue; }
      const idx = gy * N + gx;
      const hm = toMeters(h[vi]);
      if (!touched[idx]) {
        out[idx] = hm;
        touched[idx] = 1;
      } else {
        // 已被其它顶点占过：取平均（避免边缘锯齿）
        out[idx] = (out[idx] + hm) * 0.5;
      }
    }

    // ── Pass 2: 三角形 bbox 光栅化 + barycentric 插值 ──
    for (let t = 0; t < tri.length; t += 3) {
      const ia = tri[t];
      const ib = tri[t + 1];
      const ic = tri[t + 2];
      const ax = toGridX(u[ia]); const ay = toGridY(v[ia]);
      const bx = toGridX(u[ib]); const by = toGridY(v[ib]);
      const cx = toGridX(u[ic]); const cy = toGridY(v[ic]);

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));

      const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(denom) < 1e-10) { continue; }

      const ha = toMeters(h[ia]);
      const hb = toMeters(h[ib]);
      const hc = toMeters(h[ic]);

      for (let gy = minY; gy <= maxY; gy++) {
        for (let gx = minX; gx <= maxX; gx++) {
          const wa = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / denom;
          const wb = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / denom;
          const wc = 1 - wa - wb;
          if (wa >= -1e-5 && wb >= -1e-5 && wc >= -1e-5) {
            const idx = gy * N + gx;
            out[idx] = wa * ha + wb * hb + wc * hc;
            touched[idx] = 1;
          }
        }
      }
    }

    // ── Pass 3: 未触达 cell → 迭代膨胀从邻居取平均 ──
    // 最多迭代 N 次（对角线传播深度），每轮将 "与已触达 cell 4-邻接" 的
    // 未触达 cell 填入邻居均值，然后标记为已触达，直到全部填满或无进展
    const work = new Uint8Array(N * N);
    for (let iter = 0; iter < N; iter++) {
      let changed = false;
      work.set(touched);
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const idx = gy * N + gx;
          if (work[idx]) { continue; }
          let sum = 0, cnt = 0;
          if (gx > 0 && work[idx - 1]) { sum += out[idx - 1]; cnt++; }
          if (gx < N - 1 && work[idx + 1]) { sum += out[idx + 1]; cnt++; }
          if (gy > 0 && work[idx - N]) { sum += out[idx - N]; cnt++; }
          if (gy < N - 1 && work[idx + N]) { sum += out[idx + N]; cnt++; }
          if (cnt > 0) {
            out[idx] = sum / cnt;
            touched[idx] = 1;
            changed = true;
          }
        }
      }
      if (!changed) { break; }
    }

    // 若全图仍有未触达（极端情况：QM 无顶点），填 0
    for (let i = 0; i < out.length; i++) {
      if (!touched[i]) { out[i] = 0; }
    }

    return {
      z, x, y,
      heights: out,
      minHeight: hMin,
      maxHeight: hMax,
    };
  }

  // ═════ 内部 ═════

  private _drain(): void {
    while (this._concurrent < MAX_CONCURRENT_REQUESTS && this._pending.length > 0) {
      const job = this._pending.shift()!;
      this._concurrent++;
      void this._executeJob(job);
    }
  }

  private async _executeJob(job: { z: number; x: number; y: number; resolve: (v: QuantizedMeshRaw) => void; reject: (e: Error) => void }): Promise<void> {
    const { z, x, y, resolve, reject } = job;
    const key = `${z}/${x}/${y}`;
    const controller = new AbortController();
    this._inflight.set(key, controller);
    try {
      if (this._meta === null) {
        await this.initialize();
      }
      const meta = this._meta!;
      const tmpl = meta.tileUrlTemplates[0];
      const url = tmpl
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));

      const resp = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: DEFAULT_ACCEPT_HEADER },
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const ab = await resp.arrayBuffer();
      const decoded = decodeQuantizedMesh(ab);
      resolve(decoded);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        reject(new Error('[TERRAIN_TILE_ABORTED]'));
      } else {
        reject(new Error(`[TERRAIN_TILE_FETCH_FAILED] ${key}: ${(e as Error).message}`));
      }
    } finally {
      this._inflight.delete(key);
      this._concurrent--;
      this._drain();
    }
  }
}
