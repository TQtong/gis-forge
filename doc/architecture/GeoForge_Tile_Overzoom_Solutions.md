# GIS-Forge 瓦片 Overzoom 解决方案 v2

> 针对 18 个开源引擎 Issue 的完整解决方案
> 与 Tile Solutions v2 统一接口，直接集成

---

## 零、类型定义（与 Tile Solutions 统一）

```typescript
// ═══ 复用 Tile Solutions 中已有的类型 ═══
// TileID, TileCache, CacheEntry, RequestScheduler, VisibleTile
// 以下为 Overzoom 新增类型

/** 数据源的 zoom 范围 */
interface TileSourceZoomRange {
  readonly minNativeZoom: number;  // 默认 0
  readonly maxNativeZoom: number;  // 默认 22
}

/** 图层 overzoom 配置（只读，不可变） */
interface OverzoomConfig {
  readonly overzoomStrategy: 'scale' | 'transparent' | 'none';
  readonly maxOverzoom: number;   // 栅格默认 6，矢量默认 10
  readonly maxUnderzoom: number;  // 默认 0
}

/** overzoom 解析结果——扩展自 TileID */
interface ResolvedTile {
  /** 实际请求的瓦片 */
  readonly requestZ: number;
  readonly requestX: number;
  readonly requestY: number;
  readonly requestKey: string;   // "z/x/y"
  /** 目标显示位置 */
  readonly displayZ: number;
  readonly displayX: number;
  readonly displayY: number;
  readonly displayKey: string;   // "z/x/y"
  /** UV 子区域映射 */
  readonly uvOffset: [number, number];
  readonly uvScale:  [number, number];
  /** overzoom 元数据 */
  readonly isOverzoomed: boolean;
  readonly overzoomLevels: number;
}

/** 矢量瓦片特征 */
interface VectorFeature {
  readonly type: 'Point' | 'LineString' | 'Polygon';
  readonly geometry: number[][];  // Point: [[x,y]], Line: [[x,y],...], Polygon: [[x,y],...]
  readonly properties: Record<string, unknown>;
  readonly layer: string;
}

const DEFAULT_RASTER_OVERZOOM: OverzoomConfig = {
  overzoomStrategy: 'scale', maxOverzoom: 6, maxUnderzoom: 0,
};
const DEFAULT_VECTOR_OVERZOOM: OverzoomConfig = {
  overzoomStrategy: 'scale', maxOverzoom: 10, maxUnderzoom: 0,
};
```

---

## 方案一：resolveTile——Overzoom/Underzoom 单一入口

> 解决：Leaflet #1802/#3096/#4034/#5644/#3004

### 1.1 参数校验（纯函数，无副作用）

```typescript
/** 校验并返回规范化后的配置。不修改输入对象。 */
function normalizeOverzoomConfig(
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): { source: TileSourceZoomRange; config: OverzoomConfig } {
  let minZ = source.minNativeZoom;
  let maxZ = source.maxNativeZoom;

  // Leaflet #3004：typeof 检查，不用 truthiness（maxNativeZoom=0 是合法值）
  if (typeof minZ !== 'number' || isNaN(minZ)) minZ = 0;
  if (typeof maxZ !== 'number' || isNaN(maxZ)) maxZ = 22;

  // Leaflet #5644：min > max 自动交换
  if (minZ > maxZ) [minZ, maxZ] = [maxZ, minZ];

  // MapLibre #4055：zoom 安全上限 24
  let maxOZ = config.maxOverzoom;
  if (!Number.isFinite(maxOZ)) maxOZ = Math.max(0, 24 - maxZ);
  maxOZ = Math.max(0, Math.floor(maxOZ));

  let maxUZ = config.maxUnderzoom;
  if (!Number.isFinite(maxUZ)) maxUZ = 0;
  maxUZ = Math.max(0, Math.floor(maxUZ));

  return {
    source: { minNativeZoom: minZ, maxNativeZoom: maxZ },
    config: { overzoomStrategy: config.overzoomStrategy, maxOverzoom: maxOZ, maxUnderzoom: maxUZ },
  };
}
```

### 1.2 resolveTile

```typescript
/**
 * 将"显示需要的瓦片"转换为"实际请求的瓦片 + UV 映射"。
 * 纯函数，无副作用。
 */
function resolveTile(
  displayZ: number, displayX: number, displayY: number,
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): ResolvedTile | null {
  const { minNativeZoom: minZ, maxNativeZoom: maxZ } = source;

  // ═══ 正常范围：直接请求 ═══
  if (displayZ >= minZ && displayZ <= maxZ) {
    return makeResolved(displayZ, displayX, displayY, displayZ, displayX, displayY);
  }

  // ═══ Overzoom（displayZ > maxZ）═══
  if (displayZ > maxZ) {
    if (config.overzoomStrategy === 'none' || config.overzoomStrategy === 'transparent') return null;
    const levels = displayZ - maxZ;
    if (levels > config.maxOverzoom) return null;

    const shift = levels;
    const rz = maxZ;
    const rx = displayX >> shift;
    const ry = displayY >> shift;
    return makeResolvedWithUV(displayZ, displayX, displayY, rz, rx, ry, shift);
  }

  // ═══ Underzoom（displayZ < minZ）═══
  if (displayZ < minZ) {
    const levels = minZ - displayZ;
    if (levels > config.maxUnderzoom) return null;

    // Underzoom：请求 minZ 级别的瓦片，但只渲染覆盖 display 范围的那一块
    // 一个 displayZ 瓦片 = minZ 级别中多个瓦片的合并区域
    // 简化处理：请求 display 区域中心对应的 minZ 瓦片，UV 渲染该瓦片的全部
    // 效果：display 瓦片显示的是 minZ 瓦片缩小后的样子
    const shift = levels;
    const rz = minZ;
    // display(z=3, x=2, y=1) 对应 minZ(z=5) 中 x=8..11, y=4..7 的区域
    // 请求中心瓦片 (8+11)/2=9, (4+7)/2=5
    const centerX = (displayX << shift) + ((1 << shift) >> 1);
    const centerY = (displayY << shift) + ((1 << shift) >> 1);
    const rx = Math.min(centerX, (1 << rz) - 1);
    const ry = Math.min(centerY, (1 << rz) - 1);
    // UV 保持完整（整个瓦片渲染，由顶点缩放来适配 display 位置）
    return makeResolved(displayZ, displayX, displayY, rz, rx, ry);
  }

  return null;
}

/** 构建无 UV 偏移的 ResolvedTile */
function makeResolved(
  dz: number, dx: number, dy: number,
  rz: number, rx: number, ry: number,
): ResolvedTile {
  return {
    displayZ: dz, displayX: dx, displayY: dy, displayKey: `${dz}/${dx}/${dy}`,
    requestZ: rz, requestX: rx, requestY: ry, requestKey: `${rz}/${rx}/${ry}`,
    uvOffset: [0, 0], uvScale: [1, 1],
    isOverzoomed: dz !== rz, overzoomLevels: Math.abs(dz - rz),
  };
}

/** 构建带 UV 子区域的 ResolvedTile（overzoom 专用） */
function makeResolvedWithUV(
  dz: number, dx: number, dy: number,
  rz: number, rx: number, ry: number,
  shift: number,
): ResolvedTile {
  const n = 1 << shift;
  const subX = dx - (rx << shift);
  const subY = dy - (ry << shift);
  return {
    displayZ: dz, displayX: dx, displayY: dy, displayKey: `${dz}/${dx}/${dy}`,
    requestZ: rz, requestX: rx, requestY: ry, requestKey: `${rz}/${rx}/${ry}`,
    uvOffset: [subX / n, subY / n],
    uvScale:  [1 / n,    1 / n],
    isOverzoomed: true, overzoomLevels: shift,
  };
}
```

### 1.3 集成到 coveringTiles

```typescript
function coveringTilesWithOverzoom(
  camera: Camera25DState,
  source: TileSourceZoomRange,
  config: OverzoomConfig,
): ResolvedTile[] {
  const norm = normalizeOverzoomConfig(source, config);
  const displayTiles = coveringTiles(camera);

  const resolved: ResolvedTile[] = [];
  const seen = new Set<string>();  // 按 displayKey 去重

  for (const dt of displayTiles) {
    const r = resolveTile(dt.z, dt.x, dt.y, norm.source, norm.config);
    if (!r) continue;
    if (seen.has(r.displayKey)) continue;
    seen.add(r.displayKey);
    resolved.push(r);
  }

  return resolved;
}
```

### 1.4 数值验证

```
Overzoom: source.maxNativeZoom=14, display z=18, x=200003, y=150001
  shift=4, rz=14, rx=200003>>4=12500, ry=150001>>4=9375
  n=16, subX=200003-(12500<<4)=200003-200000=3, subY=150001-150000=1
  uvOffset=[3/16, 1/16]=[0.1875, 0.0625], uvScale=[1/16, 1/16]
  → 请求 14/12500/9375，渲染第 4 列第 2 行的 1/16 子区域 ✅

Underzoom: source.minNativeZoom=5, display z=3, x=2, y=1
  shift=2, rz=5, centerX=(2<<2)+2=10, centerY=(1<<2)+2=6
  → 请求 5/10/6，渲染完整瓦片（由顶点位置缩放到 z=3 的范围）

Edge case: source.maxNativeZoom=0, display z=3
  shift=3, rz=0, rx=3>>3=0, ry=0>>3=0 (全球唯一瓦片)
  n=8, uvOffset=[3/8, 0/8], uvScale=[1/8, 1/8]
  → 从全球瓦片中取 1/8 子区域 ✅（Leaflet #3004 修复）
```

---

## 方案二：稀疏金字塔——请求失败时自动向上查找

> 解决：MapLibre #111/#3990/#5692/#4613

### 2.1 AncestorProber（带 LRU 清理）

```typescript
/**
 * 动态记录哪些瓦片有数据、哪些缺失，失败时自动向上查找。
 * 
 * 与 resolveTile 的职责分离：
 *   resolveTile = 静态 clamp（基于 source.maxNativeZoom，请求前）
 *   AncestorProber = 动态探测（基于实际响应，请求后）
 */
class AncestorProber {
  private missing = new Set<string>();
  private exists = new Set<string>();
  private maxCacheSize: number;

  constructor(maxCacheSize = 2000) {
    this.maxCacheSize = maxCacheSize;
  }

  /** 瓦片有数据 */
  markExists(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    this.exists.add(key);
    this.missing.delete(key);
    this.trimIfNeeded();
  }

  /** 瓦片缺失（404 / 空 / 错误） */
  markMissing(z: number, x: number, y: number): void {
    const key = `${z}/${x}/${y}`;
    this.missing.add(key);
    this.exists.delete(key);
    this.trimIfNeeded();
  }

  /**
   * 查找最近的有数据祖先。
   * 返回 ResolvedTile（含 UV 子区域），或 null。
   */
  findAncestor(z: number, x: number, y: number, maxLevelsUp = 8): ResolvedTile | null {
    let pz = z - 1, px = x >> 1, py = y >> 1;
    while (pz >= 0 && (z - pz) <= maxLevelsUp) {
      const pKey = `${pz}/${px}/${py}`;

      if (this.missing.has(pKey)) {
        // 已知缺失，继续向上
        pz--; px >>= 1; py >>= 1;
        continue;
      }

      // 已知存在 或 未知（需要请求） → 返回这个祖先
      return makeResolvedWithUV(z, x, y, pz, px, py, z - pz);
    }
    return null;
  }

  /** 防止无限增长 */
  private trimIfNeeded(): void {
    if (this.missing.size + this.exists.size > this.maxCacheSize) {
      // 粗暴清理一半（可改为 LRU，但简单实现足够）
      const half = this.maxCacheSize >> 1;
      let count = 0;
      for (const k of this.missing) {
        if (count++ > half) break;
        this.missing.delete(k);
      }
      count = 0;
      for (const k of this.exists) {
        if (count++ > half) break;
        this.exists.delete(k);
      }
    }
  }
}
```

### 2.2 集成到请求回调（与 Tile Solutions §方案四 统一）

```typescript
/**
 * 统一的瓦片响应处理。
 * 合并了 Tile Solutions 的 handleTileError 和 Overzoom 的 AncestorProber。
 */
function handleTileResponse(
  tile: ResolvedTile,
  result: { data: ArrayBuffer | null; status: number; error?: Error },
  cache: TileCache,
  prober: AncestorProber,
  scheduler: RequestScheduler,
  urlTemplate: string,
  device: GPUDevice,
): void {
  const { data, status, error } = result;

  // 1. 请求被取消 → 忽略
  if (error?.name === 'AbortError') return;

  // 2. 成功 + 有数据
  if (data && data.byteLength > 0 && status >= 200 && status < 300 && status !== 204) {
    prober.markExists(tile.requestZ, tile.requestX, tile.requestY);
    const { texture, bindGroup } = createTileTexture(device, data);
    cache.set(tile.requestKey, texture, bindGroup, data.byteLength);
    return;
  }

  // 3. 缺失或失败
  prober.markMissing(tile.requestZ, tile.requestX, tile.requestY);

  // 判断是临时还是永久
  const isPermanent = status === 404 || status === 204 || !data || data.byteLength === 0;
  const entry = cache.getOrCreate(tile.requestKey);

  if (isPermanent) {
    entry.state = 'error-permanent';
  } else {
    // 临时错误：重试（Tile Solutions §方案四逻辑）
    entry.errorCount++;
    entry.state = entry.errorCount > 3 ? 'error-permanent' : 'error-transient';
    if (entry.state === 'error-transient') {
      const delay = 1000 * Math.pow(2, entry.errorCount - 1);
      setTimeout(() => {
        scheduler.request(tile.requestKey, buildTileUrl(tile, urlTemplate), 'retry',
          (d) => handleTileResponse(tile, { data: d, status: 200 }, cache, prober, scheduler, urlTemplate, device),
          (e) => handleTileResponse(tile, { data: null, status: 0, error: e }, cache, prober, scheduler, urlTemplate, device),
        );
      }, delay);
      return;
    }
  }

  // 4. 尝试向上查找祖先
  const ancestor = prober.findAncestor(tile.displayZ, tile.displayX, tile.displayY);
  if (ancestor && !cache.has(ancestor.requestKey)) {
    scheduler.request(
      ancestor.requestKey,
      buildTileUrl(ancestor, urlTemplate),
      'normal',
      (d) => handleTileResponse(ancestor, { data: d, status: 200 }, cache, prober, scheduler, urlTemplate, device),
      (e) => handleTileResponse(ancestor, { data: null, status: 0, error: e }, cache, prober, scheduler, urlTemplate, device),
    );
  }
}

/** 构建 URL（兼容 ResolvedTile） */
function buildTileUrl(tile: { requestZ: number; requestX: number; requestY: number } | TileID, template: string): string {
  const z = 'requestZ' in tile ? tile.requestZ : tile.z;
  const x = 'requestX' in tile ? tile.requestX : tile.x;
  const y = 'requestY' in tile ? tile.requestY : tile.y;
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
```

---

## 方案三：矢量瓦片 Overzoom——几何裁剪

> 解决：MapLibre #2507、OpenLayers #6942

### 3.1 裁剪函数（修复 LineString 连续性 + 支持 Multi* 类型）

```typescript
/**
 * 从父矢量瓦片裁剪出子瓦片范围的特征。
 * 坐标归一化到 [0, 1] 范围（子瓦片内部坐标）。
 */
function clipVectorTileForOverzoom(
  features: VectorFeature[],
  parentZ: number, parentX: number, parentY: number,
  childZ: number, childX: number, childY: number,
): VectorFeature[] {
  const shift = childZ - parentZ;
  const n = 1 << shift;
  const subX = childX - (parentX << shift);
  const subY = childY - (parentY << shift);
  // 裁剪窗口（父瓦片归一化坐标）
  const cMinX = subX / n, cMinY = subY / n;
  const cMaxX = (subX + 1) / n, cMaxY = (subY + 1) / n;
  const cW = cMaxX - cMinX, cH = cMaxY - cMinY;

  const result: VectorFeature[] = [];

  for (const f of features) {
    const clipped = clipFeature(f, cMinX, cMinY, cMaxX, cMaxY, cW, cH);
    if (clipped) result.push(clipped);
  }
  return result;
}

function clipFeature(
  f: VectorFeature,
  minX: number, minY: number, maxX: number, maxY: number,
  w: number, h: number,
): VectorFeature | null {
  const { type, geometry } = f;

  if (type === 'Point') {
    const [x, y] = geometry[0];
    if (x < minX || x > maxX || y < minY || y > maxY) return null;
    return { ...f, geometry: [[(x - minX) / w, (y - minY) / h]] };
  }

  if (type === 'LineString') {
    const clipped = clipPolyline(geometry, minX, minY, maxX, maxY);
    if (clipped.length < 2) return null;
    // 归一化
    const norm = clipped.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return { ...f, geometry: norm };
  }

  if (type === 'Polygon') {
    let ring = [...geometry];
    ring = clipRingByEdge(ring, minX, 'left');
    ring = clipRingByEdge(ring, maxX, 'right');
    ring = clipRingByEdge(ring, minY, 'bottom');
    ring = clipRingByEdge(ring, maxY, 'top');
    if (ring.length < 3) return null;
    const norm = ring.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return { ...f, geometry: norm };
  }

  return null;
}
```

### 3.2 Polyline 裁剪（保持连续性）

```typescript
/**
 * Cohen-Sutherland 折线裁剪。
 * 与 v1 的区别：输出连续折线而非分散的线段端点。
 */
function clipPolyline(
  line: number[][], minX: number, minY: number, maxX: number, maxY: number,
): number[][] {
  const result: number[][] = [];

  for (let i = 0; i < line.length - 1; i++) {
    const seg = clipOneSegment(
      line[i][0], line[i][1], line[i+1][0], line[i+1][1],
      minX, minY, maxX, maxY,
    );
    if (!seg) {
      // 线段完全在外 → 断开连续性
      continue;
    }
    const [ax, ay, bx, by] = seg;
    if (result.length === 0) {
      result.push([ax, ay]);
    } else {
      // 检查是否与上一个端点连续
      const last = result[result.length - 1];
      if (Math.abs(last[0] - ax) > 1e-10 || Math.abs(last[1] - ay) > 1e-10) {
        // 不连续 → 先 push 当前段起点（会产生跳跃，但裁剪后折线本身就可能断开）
        result.push([ax, ay]);
      }
    }
    result.push([bx, by]);
  }

  return result;
}

function clipOneSegment(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): [number, number, number, number] | null {
  let c0 = regionCode(x0, y0, minX, minY, maxX, maxY);
  let c1 = regionCode(x1, y1, minX, minY, maxX, maxY);

  for (let iter = 0; iter < 20; iter++) {  // 安全上限防死循环
    if (!(c0 | c1)) return [x0, y0, x1, y1];
    if (c0 & c1) return null;

    // 选择在外部的点（不用 || 避免 v1 的 bug）
    const c = c0 !== 0 ? c0 : c1;
    let x: number, y: number;

    if (c & 8)      { x = x0 + (x1 - x0) * (maxY - y0) / (y1 - y0); y = maxY; }
    else if (c & 4) { x = x0 + (x1 - x0) * (minY - y0) / (y1 - y0); y = minY; }
    else if (c & 2) { y = y0 + (y1 - y0) * (maxX - x0) / (x1 - x0); x = maxX; }
    else            { y = y0 + (y1 - y0) * (minX - x0) / (x1 - x0); x = minX; }

    if (c === c0) { x0 = x; y0 = y; c0 = regionCode(x0, y0, minX, minY, maxX, maxY); }
    else          { x1 = x; y1 = y; c1 = regionCode(x1, y1, minX, minY, maxX, maxY); }
  }
  return null;
}

function regionCode(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): number {
  return (x < minX ? 1 : 0) | (x > maxX ? 2 : 0) | (y < minY ? 4 : 0) | (y > maxY ? 8 : 0);
}
```

### 3.3 Polygon 裁剪（Sutherland-Hodgman）

```typescript
function clipRingByEdge(ring: number[][], value: number, edge: 'left' | 'right' | 'top' | 'bottom'): number[][] {
  if (ring.length === 0) return ring;
  const out: number[][] = [];
  const n = ring.length;

  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    const cIn = ptInside(curr, value, edge);
    const nIn = ptInside(next, value, edge);

    if (cIn && nIn)       { out.push(next); }
    else if (cIn && !nIn) { out.push(edgeIntersect(curr, next, value, edge)); }
    else if (!cIn && nIn) { out.push(edgeIntersect(curr, next, value, edge)); out.push(next); }
  }
  return out;
}

function ptInside(p: number[], val: number, edge: string): boolean {
  return edge === 'left'   ? p[0] >= val :
         edge === 'right'  ? p[0] <= val :
         edge === 'bottom' ? p[1] >= val :
                             p[1] <= val;
}

function edgeIntersect(a: number[], b: number[], val: number, edge: string): number[] {
  if (edge === 'left' || edge === 'right') {
    const t = (val - a[0]) / (b[0] - a[0]);
    return [val, a[1] + t * (b[1] - a[1])];
  }
  const t = (val - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), val];
}
```

### 3.4 Worker 执行

```typescript
// worker-vector-clip.ts
import { clipVectorTileForOverzoom } from './vector-clip';

self.onmessage = (e: MessageEvent<{
  features: VectorFeature[];
  parentZ: number; parentX: number; parentY: number;
  childZ: number; childX: number; childY: number;
}>) => {
  const { features, parentZ, parentX, parentY, childZ, childX, childY } = e.data;
  const result = clipVectorTileForOverzoom(features, parentZ, parentX, parentY, childZ, childX, childY);
  self.postMessage(result);
};
```

---

## 方案四：每图层独立 Overzoom + Zoom Fade

> 解决：MapLibre #4823（聚类冲突）、deck.gl #7417（无法关闭 overzoom）

```typescript
interface TileLayerOptions {
  source: TileSource;
  overzoom?: Partial<OverzoomConfig>;  // 缺省字段用默认值填充

  /** 图层在该 zoom 范围内 fade in/out，用于多图层平滑切换 */
  fadeInZoom?:  { start: number; end: number };
  fadeOutZoom?: { start: number; end: number };
}

function computeLayerAlpha(
  zoom: number,
  fadeIn?: { start: number; end: number },
  fadeOut?: { start: number; end: number },
): number {
  let a = 1;
  if (fadeIn) {
    if (zoom < fadeIn.start) return 0;
    if (zoom < fadeIn.end) a = (zoom - fadeIn.start) / (fadeIn.end - fadeIn.start);
  }
  if (fadeOut) {
    if (zoom > fadeOut.end) return 0;
    if (zoom > fadeOut.start) a *= 1 - (zoom - fadeOut.start) / (fadeOut.end - fadeOut.start);
  }
  return a;
}

// ═══ 使用示例 ═══

// 底图：允许 overzoom 6 级
const basemap = { source: osmSource, overzoom: { overzoomStrategy: 'scale', maxOverzoom: 6 } };

// 聚类层：禁用 overzoom（防止低 zoom 的聚类圆与高 zoom 数据重叠）
const clusters = { source: clusterSource, overzoom: { overzoomStrategy: 'none', maxOverzoom: 0 } };

// 位图→矢量切换：位图 fade out，矢量 fade in
const bitmap  = { source: bitmapSrc,  overzoom: { overzoomStrategy: 'none' }, fadeOutZoom: { start: 13.5, end: 14 } };
const vector  = { source: vectorSrc,  overzoom: { maxOverzoom: 10 },           fadeInZoom:  { start: 14,   end: 14.5 } };
```

---

## 方案五：统一帧循环（展示全部方案协同）

```typescript
/**
 * 完整帧循环：Overzoom 方案与 Tile Solutions 全部 10 个方案协同工作。
 * 
 * 调用链：
 *   onFrame
 *     → computeCamera25D_Relative          (Pipeline §九 精度)
 *     → 对每个图层:
 *         → computeLayerAlpha               (方案四 zoom fade)
 *         → coveringTilesWithOverzoom       (方案一 overzoom)
 *         → scheduler.cancelStale           (Tile Solutions §二 请求取消)
 *         → scheduler.request               (Tile Solutions §二 优先级)
 *         → handleTileResponse              (方案二 稀疏金字塔 + §四 错误分级)
 *         → resolveVisibleTiles             (Tile Solutions §一 父瓦片占位)
 *     → cache.pinForFrame                   (Tile Solutions §三 pin 机制)
 *     → renderFrame                         (Pipeline §五 GPU 渲染)
 *     → surface.retainFrame                 (Tile Solutions §七 resize 保持)
 */
function onFrame(
  layers: TileLayerInstance[],
  state: MapState,
  device: GPUDevice,
  resources: RenderResources,
) {
  const camera = computeCamera25D_Relative(
    state.center, state.zoom, state.pitch, state.bearing, state.fov, state.viewport,
  );

  const allVisible: VisibleTile[] = [];
  const allNeededKeys = new Set<string>();

  for (const layer of layers) {
    // 1. Zoom fade → alpha=0 的图层直接跳过
    const alpha = computeLayerAlpha(state.zoom, layer.fadeInZoom, layer.fadeOutZoom);
    if (alpha <= 0) continue;

    // 2. Overzoom 解析
    const norm = normalizeOverzoomConfig(layer.source.zoomRange, layer.overzoomConfig);
    const resolved = coveringTilesWithOverzoom(camera, norm.source, norm.config);

    // 3. 收集 requestKeys
    for (const r of resolved) allNeededKeys.add(r.requestKey);

    // 4. 请求未加载的瓦片
    for (const r of resolved) {
      if (!layer.cache.has(r.requestKey) && layer.cache.getOrCreate(r.requestKey).state === 'loading') {
        resources.idle.onTileRequest();
        resources.scheduler.request(
          r.requestKey,
          buildTileUrl(r, layer.source.urlTemplate),
          r.overzoomLevels === 0 ? 'critical' : 'normal',
          (data) => {
            handleTileResponse(
              r, { data, status: 200 }, layer.cache, layer.prober,
              resources.scheduler, layer.source.urlTemplate, device,
            );
            resources.idle.onTileComplete();
          },
          (err) => {
            handleTileResponse(
              r, { data: null, status: 0, error: err }, layer.cache, layer.prober,
              resources.scheduler, layer.source.urlTemplate, device,
            );
            resources.idle.onTileComplete();
          },
        );
      }
    }

    // 5. 可见性仲裁（Tile Solutions §一 + Overzoom UV 子区域——共享同一机制）
    const visible = resolveVisibleTilesFromResolved(resolved, layer.cache);
    for (const v of visible) {
      allVisible.push({ ...v, layerAlpha: alpha });
    }
  }

  // 6. 请求取消
  resources.scheduler.cancelStale(allNeededKeys);

  // 7. Pin + 渲染
  for (const layer of layers) {
    layer.cache.pinForFrame(allVisible.filter(v => layer.cache.has(v.requestKey)).map(v => v.requestKey));
  }

  const encoder = device.createCommandEncoder();
  resources.surface.blitRetainedFrame(device, encoder, resources.targetView);
  renderAllLayers(encoder, camera, allVisible, device, resources);
  resources.surface.retainFrame(device, encoder, resources.context.getCurrentTexture());
  device.queue.submit([encoder.finish()]);
}

/**
 * 从 ResolvedTile[] 构建 VisibleTile[]。
 * 与 Tile Solutions §方案一的 resolveVisibleTiles 统一——
 * ResolvedTile 自带 UV 子区域，直接映射到 VisibleTile。
 */
function resolveVisibleTilesFromResolved(
  resolved: ResolvedTile[], cache: TileCache,
): VisibleTile[] {
  const result: VisibleTile[] = [];

  for (const r of resolved) {
    // 优先级 1：request 瓦片已加载
    const entry = cache.get(r.requestKey);
    if (entry?.state === 'ready' && entry.texture) {
      result.push({
        id: { z: r.displayZ, x: r.displayX, y: r.displayY, key: r.displayKey, distToCamera: 0 },
        texture: entry.texture,
        bindGroup: entry.bindGroup!,
        uvOffset: r.uvOffset,
        uvScale: r.uvScale,
      });
      continue;
    }

    // 优先级 2：缓存中找祖先（Tile Solutions §方案一的 findAncestor 逻辑）
    const ph = findAncestor(
      { z: r.displayZ, x: r.displayX, y: r.displayY, key: r.displayKey, distToCamera: 0 },
      cache,
    );
    if (ph) result.push(ph);
  }

  return result;
}
```

---

## 方案总结对照表

| # | Issue | 问题 | v1 缺陷 | v2 修复 |
|---|-------|------|---------|--------|
| 一 | Leaflet #1802/#3096/#4034 | maxNativeZoom bug | underzoom 坐标错误 | 重写 underzoom 为 center 对齐 |
| 一 | Leaflet #3004 | maxNativeZoom=0 falsy | 已正确 | 新增数值验证 |
| 二 | MapLibre #111/#5692 | 稀疏金字塔 | knownMissing 无限增长 / cache.setAlias 不存在 / displayKey 未定义 | maxCacheSize + trimIfNeeded / 移除 setAlias 改用 resolveVisibleTilesFromResolved / 添加 displayKey |
| 三 | MapLibre #2507 | 矢量精度灾难 | LineString 不连续 / code0\|\|code1 bug / VectorFeature 未定义 | 重写 clipPolyline 保连续 / c0!==0?c0:c1 / 定义 VectorFeature |
| 四 | ML #4823, deck.gl #7417 | 图层冲突 | 与 Tile Solutions 接口不统一 | 统一 VisibleTile + resolveVisibleTilesFromResolved |
| 五 | 全部 | 缺统一帧循环 | 10 个方案散落 | onFrame 展示全部方案协同 |
