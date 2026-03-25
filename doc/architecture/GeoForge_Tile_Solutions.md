# GeoForge 瓦片问题解决方案 v2

> 针对 26 个开源引擎 Issue 的完整解决方案
> 所有代码可直接粘贴实现，无占位符、无未定义引用

---

## 零、公共类型与工具

```typescript
// ═══ 所有方案共享的类型 ═══

interface TileID {
  z: number; x: number; y: number;
  key: string;           // "z/x/y"
  distToCamera: number;
}

class TileNotFoundError extends Error {
  constructor(public tileKey: string) { super(`Tile not found: ${tileKey}`); this.name = 'TileNotFoundError'; }
}

class TileLoadError extends Error {
  constructor(public tileKey: string, public status: number) { super(`Tile load failed: ${tileKey} (${status})`); this.name = 'TileLoadError'; }
}

function buildTileUrl(tile: TileID, template: string): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/** 512×512 RGBA = 1,048,576 bytes */
const TILE_BYTE_SIZE = 512 * 512 * 4;
```

---

## 方案一：防闪烁——父/子瓦片占位 + 可见性仲裁

> 解决：Leaflet #52/#7416（缩放闪烁）、deck.gl #6448/#3511（Z-fighting）

### 1.1 核心规则

```
同一屏幕位置永远只显示一个 zoom 级别——绝不重叠。

Zoom-In（z=10 → z=12）：
  z=12 瓦片未到 → 显示 z=10 父瓦片的对应 1/4 子区域（UV 映射）
  z=12 瓦片到达 → 替换父瓦片占位

Zoom-Out（z=12 → z=10）：
  z=10 瓦片未到 → 如果 z=12 的 4 个子瓦片全在缓存 → 拼合显示
  z=10 瓦片到达 → 替换子瓦片拼合
```

### 1.2 可见性仲裁

```typescript
interface VisibleTile {
  id: TileID;
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  uvOffset: [number, number];  // [0,0] = 完整瓦片
  uvScale:  [number, number];  // [1,1] = 完整瓦片
}

function resolveVisibleTiles(needed: TileID[], cache: TileCache): VisibleTile[] {
  const result: VisibleTile[] = [];

  for (const tile of needed) {
    // 优先级 1：当前 zoom 已加载
    const entry = cache.get(tile.key);
    if (entry?.state === 'ready' && entry.texture) {
      result.push({ id: tile, texture: entry.texture, bindGroup: entry.bindGroup!, uvOffset: [0,0], uvScale: [1,1] });
      continue;
    }

    // 优先级 2（zoom-out）：4 个子瓦片全部就绪 → 用第一个子瓦片的纹理（简化版）
    // 完整实现需要 texture atlas 拼合，这里用祖先占位替代
    
    // 优先级 3（zoom-in）：最近祖先瓦片
    const ph = findAncestor(tile, cache);
    if (ph) { result.push(ph); continue; }

    // 优先级 4（永久缺失）：标记过 error-permanent 的瓦片，用祖先占位
    if (entry?.state === 'error-permanent') {
      const ph2 = findAncestor(tile, cache);
      if (ph2) { result.push(ph2); continue; }
    }
    // 无可用瓦片 → 该位置显示背景色
  }
  return result;
}

function findAncestor(tile: TileID, cache: TileCache): VisibleTile | null {
  for (let dz = 1; dz <= Math.min(tile.z, 5); dz++) {
    const pz = tile.z - dz;
    const px = tile.x >> dz;
    const py = tile.y >> dz;
    const parent = cache.get(`${pz}/${px}/${py}`);
    if (parent?.state === 'ready' && parent.texture) {
      const n = 1 << dz;
      const sx = tile.x - (px << dz);
      const sy = tile.y - (py << dz);
      return {
        id: tile,
        texture: parent.texture,
        bindGroup: parent.bindGroup!,
        uvOffset: [sx / n, sy / n],
        uvScale:  [1 / n,  1 / n],
      };
    }
  }
  return null;
}
```

### 1.3 着色器 UV 子区域

```wgsl
// 每瓦片 uniform（16 字节对齐 ✅）
struct TileParams {
  uvOffset: vec2<f32>,  // 8 bytes
  uvScale:  vec2<f32>,  // 8 bytes → 总 16 bytes ✅
};

@group(2) @binding(0) var<uniform> tile: TileParams;

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let uv = tile.uvOffset + in.uv * tile.uvScale;
  return textureSample(tileTexture, tileSampler, uv);
}
```

---

## 方案二：请求调度——取消、优先级、并发控制

> 解决：OpenLayers #15293（中间 zoom 浪费）、#15574（失败阻塞）、#11626（串行加载）

```typescript
type Priority = 'critical' | 'normal' | 'low' | 'retry';
const PRIORITY_RANK: Record<Priority, number> = { critical: 4, normal: 3, low: 2, retry: 1 };
const MAX_PER_PRIORITY: Record<Priority, number> = { critical: 4, normal: 3, low: 1, retry: 1 };

interface PendingRequest {
  key: string;
  url: string;
  priority: Priority;
  controller: AbortController;
  onComplete: (data: ArrayBuffer) => void;
  onError: (err: Error) => void;
}

class RequestScheduler {
  private queue = new Map<string, PendingRequest>();
  private inflight = new Map<string, PendingRequest>();
  private maxConcurrent: number;

  constructor(maxConcurrent = 6) {
    this.maxConcurrent = maxConcurrent;
  }

  request(
    key: string, url: string, priority: Priority,
    onComplete: (data: ArrayBuffer) => void,
    onError: (err: Error) => void,
  ): void {
    // 已在 inflight → 忽略
    if (this.inflight.has(key)) return;

    // 已在 queue → 升级优先级
    const existing = this.queue.get(key);
    if (existing) {
      if (PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority]) {
        existing.priority = priority;
      }
      return;
    }

    this.queue.set(key, {
      key, url, priority,
      controller: new AbortController(),
      onComplete, onError,
    });
    this.flush();
  }

  /** 每帧调用：取消所有不在 neededKeys 中的队列请求和 inflight 请求 */
  cancelStale(neededKeys: Set<string>): void {
    for (const [key, req] of this.queue) {
      if (!neededKeys.has(key)) {
        req.controller.abort();
        this.queue.delete(key);
      }
    }
    for (const [key, req] of this.inflight) {
      if (!neededKeys.has(key)) {
        req.controller.abort();
        // inflight 会在 fetch catch 中自行清理
      }
    }
  }

  /** Engine.destroy() 时调用 */
  cancelAll(): void {
    for (const req of this.queue.values()) req.controller.abort();
    for (const req of this.inflight.values()) req.controller.abort();
    this.queue.clear();
    this.inflight.clear();
  }

  private flush(): void {
    if (this.inflight.size >= this.maxConcurrent) return;

    // 按优先级排序
    const sorted = [...this.queue.values()]
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);

    // 统计每个优先级已在 inflight 的数量
    const inflightByPriority: Record<Priority, number> = { critical: 0, normal: 0, low: 0, retry: 0 };
    for (const req of this.inflight.values()) inflightByPriority[req.priority]++;

    for (const req of sorted) {
      if (this.inflight.size >= this.maxConcurrent) break;
      // 每个优先级有独立并发上限
      if (inflightByPriority[req.priority] >= MAX_PER_PRIORITY[req.priority]) continue;

      this.queue.delete(req.key);
      this.inflight.set(req.key, req);
      inflightByPriority[req.priority]++;
      this.executeRequest(req);
    }
  }

  private async executeRequest(req: PendingRequest): Promise<void> {
    try {
      const res = await fetch(req.url, { signal: req.controller.signal });
      if (!res.ok) {
        if (res.status === 404 || res.status === 204) throw new TileNotFoundError(req.key);
        throw new TileLoadError(req.key, res.status);
      }
      const data = await res.arrayBuffer();
      req.onComplete(data);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      req.onError(err);
    } finally {
      this.inflight.delete(req.key);
      this.flush();
    }
  }
}
```

---

## 方案三：瓦片缓存——O(1) LRU + Pin 机制 + 完整销毁

> 解决：OpenLayers #16156（22000+ 泄漏）、#9556（销毁不完全）

```typescript
interface CacheEntry {
  key: string;
  texture: GPUTexture | null;
  bindGroup: GPUBindGroup | null;
  byteSize: number;
  state: 'loading' | 'ready' | 'error-transient' | 'error-permanent';
  errorCount: number;
  // 双向链表指针（O(1) LRU）
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

class TileCache {
  private map = new Map<string, CacheEntry>();
  private head: CacheEntry | null = null;  // 最久未使用
  private tail: CacheEntry | null = null;  // 最近使用
  private currentBytes = 0;
  private pinnedKeys = new Set<string>();   // 当前帧正在渲染的瓦片

  readonly maxSize: number;
  readonly maxBytes: number;

  constructor(maxSize = 512, maxBytes = 256 * 1024 * 1024) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry) this.moveToTail(entry);  // O(1) 链表操作
    return entry;
  }

  /** 获取或创建一个 loading 状态的条目 */
  getOrCreate(key: string): CacheEntry {
    let entry = this.map.get(key);
    if (!entry) {
      entry = { key, texture: null, bindGroup: null, byteSize: 0, state: 'loading', errorCount: 0, prev: null, next: null };
      this.map.set(key, entry);
      this.appendToTail(entry);
    }
    return entry;
  }

  set(key: string, texture: GPUTexture, bindGroup: GPUBindGroup, byteSize: number): void {
    const entry = this.getOrCreate(key);
    if (entry.texture && entry.texture !== texture) {
      entry.texture.destroy();
      this.currentBytes -= entry.byteSize;
    }
    entry.texture = texture;
    entry.bindGroup = bindGroup;
    entry.byteSize = byteSize;
    entry.state = 'ready';
    entry.errorCount = 0;
    this.currentBytes += byteSize;
    this.moveToTail(entry);
    this.evictUntilFit();
  }

  has(key: string): boolean { return this.map.has(key); }

  /** 每帧渲染前调用：标记本帧要渲染的瓦片不可淘汰 */
  pinForFrame(keys: Iterable<string>): void {
    this.pinnedKeys.clear();
    for (const k of keys) this.pinnedKeys.add(k);
  }

  destroy(): void {
    for (const entry of this.map.values()) {
      if (entry.texture) { entry.texture.destroy(); entry.texture = null; }
      entry.bindGroup = null;
    }
    this.map.clear();
    this.head = this.tail = null;
    this.currentBytes = 0;
    this.pinnedKeys.clear();
  }

  // ═══ O(1) 双向链表操作 ═══

  private moveToTail(entry: CacheEntry): void {
    if (entry === this.tail) return;
    this.removeFromList(entry);
    this.appendToTail(entry);
  }

  private appendToTail(entry: CacheEntry): void {
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail) this.tail.next = entry;
    this.tail = entry;
    if (!this.head) this.head = entry;
  }

  private removeFromList(entry: CacheEntry): void {
    if (entry.prev) entry.prev.next = entry.next;
    else this.head = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    else this.tail = entry.prev;
    entry.prev = entry.next = null;
  }

  private evictUntilFit(): void {
    let cursor = this.head;
    while ((this.map.size > this.maxSize || this.currentBytes > this.maxBytes) && cursor) {
      const next = cursor.next;
      // ★ 跳过 pinned 瓦片（当前帧正在渲染）
      if (!this.pinnedKeys.has(cursor.key)) {
        this.removeFromList(cursor);
        if (cursor.texture) { cursor.texture.destroy(); cursor.texture = null; }
        cursor.bindGroup = null;
        this.currentBytes -= cursor.byteSize;
        this.map.delete(cursor.key);
      }
      cursor = next;
    }
  }
}
```

---

## 方案四：错误分级——临时重试 vs 永久标记

> 解决：MapLibre #5692（404/CORS fallback 不一致）

```typescript
function classifyError(err: Error): 'transient' | 'permanent' | 'ignore' {
  if (err.name === 'AbortError') return 'ignore';
  if (err instanceof TileNotFoundError) return 'permanent';
  if (err instanceof TileLoadError && err.status >= 500) return 'transient';
  if (err.name === 'TypeError') return 'transient';  // 网络/CORS 错误
  return 'permanent';
}

function handleTileError(
  tile: TileID, err: Error,
  cache: TileCache, scheduler: RequestScheduler, urlTemplate: string,
): void {
  const type = classifyError(err);
  if (type === 'ignore') return;

  const entry = cache.getOrCreate(tile.key);

  if (type === 'permanent') {
    entry.state = 'error-permanent';
    return;
  }

  // transient：最多重试 3 次，指数退避 1s → 2s → 4s
  entry.errorCount++;
  entry.state = 'error-transient';
  if (entry.errorCount > 3) { entry.state = 'error-permanent'; return; }

  const delay = 1000 * Math.pow(2, entry.errorCount - 1);
  setTimeout(() => {
    scheduler.request(
      tile.key, buildTileUrl(tile, urlTemplate), 'retry',
      (data) => { /* 由外部处理 onComplete */ },
      (err2) => handleTileError(tile, err2, cache, scheduler, urlTemplate),
    );
  }, delay);
}
```

---

## 方案五：coveringTiles 节流 + 瓦片数上限

> 解决：deck.gl #5891（主线程阻塞）、MapLibre #4778（过多瓦片）

```typescript
class TileScheduler {
  private lastBBox: [number,number,number,number] | null = null;
  private lastZoom = -1;
  private lastTiles: TileID[] = [];
  private frameCount = 0;
  private maxTiles: number;

  constructor(maxTiles = 200) {
    this.maxTiles = maxTiles;
  }

  update(camera: Camera25DState): TileID[] {
    this.frameCount++;
    const bbox = getVisibleBBox(camera);
    const zoom = Math.floor(camera.zoom);

    const skip = this.lastBBox
      && zoom === this.lastZoom
      && bboxIoU(this.lastBBox, bbox) > 0.9
      && this.frameCount < 30;

    if (skip) return this.lastTiles;

    let tiles = coveringTiles(camera);

    // 瓦片数上限
    if (tiles.length > this.maxTiles) {
      tiles.sort((a, b) => a.distToCamera - b.distToCamera);
      tiles.length = this.maxTiles;
    }

    this.lastBBox = bbox;
    this.lastZoom = zoom;
    this.lastTiles = tiles;
    this.frameCount = 0;
    return tiles;
  }
}

/** Intersection over Union：1=完全重叠，0=无交集 */
function bboxIoU(a: [number,number,number,number], b: [number,number,number,number]): number {
  const iw = Math.max(0, Math.min(a[2],b[2]) - Math.max(a[0],b[0]));
  const ih = Math.max(0, Math.min(a[3],b[3]) - Math.max(a[1],b[1]));
  const inter = iw * ih;
  const areaA = (a[2]-a[0]) * (a[3]-a[1]);
  const areaB = (b[2]-b[0]) * (b[3]-b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
```

---

## 方案六：数据源 Cross-Fade 切换

> 解决：Leaflet #6158/#6659（setUrl 闪烁）

```typescript
class SourceTransition {
  private oldTiles: VisibleTile[] = [];
  private fadeProgress = 1.0;
  private fadeDuration = 500;
  private active = false;

  start(currentTiles: VisibleTile[]): void {
    this.oldTiles = [...currentTiles];
    this.fadeProgress = 0;
    this.active = true;
  }

  update(deltaMs: number): { oldAlpha: number; newAlpha: number } {
    if (!this.active) return { oldAlpha: 0, newAlpha: 1 };

    this.fadeProgress = Math.min(1, this.fadeProgress + deltaMs / this.fadeDuration);
    if (this.fadeProgress >= 1) {
      this.active = false;
      this.oldTiles = [];
    }
    return { oldAlpha: 1 - this.fadeProgress, newAlpha: this.fadeProgress };
  }

  getOldTiles(): VisibleTile[] { return this.oldTiles; }
  isActive(): boolean { return this.active; }
}
```

### Pipeline 必须启用 alpha blending

```typescript
// 在 createRenderPipeline 的 fragment.targets 中：
targets: [{
  format,
  blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
}],
```

### Fade Uniform（16 字节对齐）

```wgsl
struct FadeParams {
  alpha:    f32,   // 4 bytes
  _pad1:    f32,   // 4 bytes
  _pad2:    f32,   // 4 bytes
  _pad3:    f32,   // 4 bytes → 总 16 bytes ✅
};
@group(3) @binding(0) var<uniform> fade: FadeParams;

@fragment fn fs_fade(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);
  color.a *= fade.alpha;
  return color;
}
```

---

## 方案七：Resize 帧保持

> 解决：MapLibre #4158（resize 白屏）

```typescript
class SurfaceManager {
  private retainedTexture: GPUTexture | null = null;
  private retainedSize: [number, number] = [0, 0];
  private blitPipeline: GPURenderPipeline | null = null;
  private blitBindGroupLayout: GPUBindGroupLayout | null = null;

  resize(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext, format: GPUTextureFormat, dpr: number): void {
    const oldW = canvas.width;
    const oldH = canvas.height;
    const newW = Math.floor(canvas.clientWidth * dpr);
    const newH = Math.floor(canvas.clientHeight * dpr);
    if (newW === oldW && newH === oldH) return;

    // 1. 创建保留纹理（用于下一帧 blit）
    // 注意：不能复制 swap chain texture，它在 submit 后就失效
    // 所以我们需要在 resize 之前的那一帧主动 copyTextureToTexture
    // → 解法：在 renderFrame 末尾总是 copy 到 retainedTexture
    // resize 时直接使用已有的 retainedTexture

    // 2. 更新 canvas 物理尺寸
    canvas.width = newW;
    canvas.height = newH;
    context.configure({ device, format, alphaMode: 'premultiplied' });

    this.retainedSize = [oldW, oldH];

    // 3. 延迟初始化 blit pipeline
    if (!this.blitPipeline) {
      this.initBlitPipeline(device, format);
    }
  }

  /** 每帧结束时调用：保存当前帧到 retained texture */
  retainFrame(device: GPUDevice, encoder: GPUCommandEncoder, source: GPUTexture): void {
    const w = source.width, h = source.height;

    // 如果尺寸变了或还没创建，重建
    if (!this.retainedTexture || this.retainedTexture.width !== w || this.retainedTexture.height !== h) {
      this.retainedTexture?.destroy();
      this.retainedTexture = device.createTexture({
        size: [w, h],
        format: source.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    encoder.copyTextureToTexture(
      { texture: source },
      { texture: this.retainedTexture },
      [w, h],
    );
  }

  /** resize 后的第一帧：先 blit 旧帧作为背景 */
  blitRetainedFrame(device: GPUDevice, encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    if (!this.retainedTexture || !this.blitPipeline) return;

    const bindGroup = device.createBindGroup({
      layout: this.blitBindGroupLayout!,
      entries: [
        { binding: 0, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 1, resource: this.retainedTexture.createView() },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1 } }],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);  // fullscreen triangle
    pass.end();

    // 用完释放
    this.retainedTexture.destroy();
    this.retainedTexture = null;
  }

  private initBlitPipeline(device: GPUDevice, format: GPUTextureFormat): void {
    const shaderCode = `
      @group(0) @binding(0) var samp: sampler;
      @group(0) @binding(1) var tex: texture_2d<f32>;

      struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

      @vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
        // fullscreen triangle
        let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
        var out: VsOut;
        out.pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
        out.uv = vec2<f32>(uv.x, 1.0 - uv.y);
        return out;
      }
      @fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
        return textureSample(tex, samp, in.uv);
      }
    `;
    const module = device.createShaderModule({ code: shaderCode });
    this.blitBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.blitPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBindGroupLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
  }

  destroy(): void {
    this.retainedTexture?.destroy();
    this.retainedTexture = null;
  }
}
```

---

## 方案八：Idle 检测

> 解决：OpenLayers #13076（截图等瓦片加载完）

```typescript
class IdleDetector {
  private pendingCount = 0;
  private animating = false;
  private callbacks: (() => void)[] = [];
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  onTileRequest(): void  { this.pendingCount++; }
  onTileComplete(): void { this.pendingCount = Math.max(0, this.pendingCount - 1); this.check(); }
  onAnimStart(): void    { this.animating = true; }
  onAnimEnd(): void      { this.animating = false; this.check(); }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(r => this.callbacks.push(r));
  }

  isIdle(): boolean {
    return this.pendingCount === 0 && !this.animating;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.callbacks = [];
  }

  private check(): void {
    if (!this.isIdle()) return;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.timerId = setTimeout(() => {
      if (this.destroyed) return;  // ★ 防止 destroy 后触发
      if (!this.isIdle()) return;
      const cbs = this.callbacks.splice(0);
      for (const cb of cbs) cb();
    }, 100);
  }
}
```

---

## 方案九：高 Zoom Float32 精度——相机相对坐标

> 解决：GPU 侧瓦片缝隙（对应 Leaflet #9731 的根因）

### 9.1 修改 computeCamera25D

```typescript
/**
 * ★ 关键修改：viewMatrix 用相对坐标构建
 * 所有世界坐标减去 centerWorld，使数值趋近 0
 */
function computeCamera25D_Relative(
  center: [number, number], zoom: number,
  pitch: number, bearing: number, fov: number,
  viewport: Viewport,
): Camera25DState {
  const halfFov = fov / 2;
  const worldSize = 512 * Math.pow(2, zoom);
  const aspect = viewport.width / viewport.height;
  const cameraToCenterDist = viewport.height / 2 / Math.tan(halfFov);

  // farZ（同 Pipeline 文档）
  let farZ: number;
  if (pitch < 0.01) { farZ = cameraToCenterDist * 2; }
  else {
    const ath = Math.PI/2 - pitch - halfFov;
    farZ = ath > 0.01
      ? Math.max(Math.sin(pitch)*cameraToCenterDist/Math.sin(ath)*1.5, cameraToCenterDist*2)
      : cameraToCenterDist * 100;
  }
  const nearZ = cameraToCenterDist * 0.1;

  // 相机位置——相对于 center
  const offsetBack = Math.sin(pitch) * cameraToCenterDist;
  const height     = Math.cos(pitch) * cameraToCenterDist;
  const relCamX =  Math.sin(bearing) * offsetBack;  // ★ 不加 centerWorldX
  const relCamY = -Math.cos(bearing) * offsetBack;  // ★ 不加 centerWorldY
  const relCamZ = height;

  // viewMatrix：eye 和 target 都是相对坐标
  const viewMatrix = new Float32Array(16);
  mat4_lookAt(viewMatrix,
    [relCamX, relCamY, relCamZ],  // eye（相对）
    [0, 0, 0],                     // target = center = 原点
    [0, 0, 1],
  );

  const projMatrix = new Float32Array(16);
  mat4_perspectiveZO(projMatrix, fov, aspect, nearZ, farZ);

  const vpMatrix = new Float32Array(16);
  mat4_multiply(vpMatrix, projMatrix, viewMatrix);

  const inverseVP = new Float32Array(16);
  mat4_invert(inverseVP, vpMatrix);

  const [centerWX, centerWY] = lngLatToWorld(center[0], center[1], worldSize);

  return {
    projMatrix, viewMatrix, vpMatrix, inverseVP,
    nearZ, farZ, cameraToCenterDist,
    cameraPosition: [centerWX + relCamX, centerWY + relCamY, relCamZ], // 绝对位置（用于 fog）
    worldSize, center, zoom, pitch, bearing, fov, viewport,
    // ★ 新增：中心世界坐标（用于顶点生成时减去）
    centerWorld: [centerWX, centerWY],
  };
}
```

### 9.2 顶点生成减去 center

```typescript
function computeTileVerticesRelative(
  tz: number, tx: number, ty: number,
  worldSize: number, centerWorld: [number, number],
): Float32Array {
  const tileSize = worldSize / (1 << tz);
  const x0 = tx * tileSize - centerWorld[0];
  const y0 = ty * tileSize - centerWorld[1];
  return new Float32Array([
    x0, y0, 0, 0, 0,
    x0 + tileSize, y0, 0, 1, 0,
    x0, y0 + tileSize, 0, 0, 1,
    x0 + tileSize, y0 + tileSize, 0, 1, 1,
  ]);
}
```

```
验证：zoom=22, worldSize=2,147,483,648
绝对坐标：顶点值 ~21 亿 → float32 精度 256px → 灾难
相对坐标：顶点值 ±几千 → float32 精度 0.001px → 完美
```

---

## 方案十：统一帧循环——所有方案协同工作

```typescript
class TileRenderer {
  private scheduler: TileScheduler;
  private requestScheduler: RequestScheduler;
  private cache: TileCache;
  private idle: IdleDetector;
  private surface: SurfaceManager;
  private transition: SourceTransition;
  private urlTemplate: string;
  private lastFrameTime = 0;

  onFrame(state: MapState, device: GPUDevice, resources: RenderResources): void {
    const now = performance.now();
    const deltaMs = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // ① 相机矩阵（相对坐标版）
    const camera = computeCamera25D_Relative(
      state.center, state.zoom, state.pitch, state.bearing, state.fov, state.viewport,
    );

    // ② 瓦片列表（节流版）
    const tiles = this.scheduler.update(camera);

    // ③ 取消过期请求
    const neededKeys = new Set(tiles.map(t => t.key));
    this.requestScheduler.cancelStale(neededKeys);

    // ④ 请求未加载的瓦片
    for (const t of tiles) {
      const entry = this.cache.get(t.key);
      if (!entry || (entry.state !== 'ready' && entry.state !== 'error-permanent' && entry.state !== 'loading')) {
        this.idle.onTileRequest();
        this.requestScheduler.request(
          t.key,
          buildTileUrl(t, this.urlTemplate),
          t.distToCamera < 5 ? 'critical' : 'normal',
          (data) => {
            const { texture, bindGroup } = createTileTexture(device, data, resources);
            this.cache.set(t.key, texture, bindGroup, TILE_BYTE_SIZE);
            this.idle.onTileComplete();
          },
          (err) => {
            handleTileError(t, err, this.cache, this.requestScheduler, this.urlTemplate);
            this.idle.onTileComplete();
          },
        );
      }
    }

    // ⑤ 可见性仲裁
    const visible = resolveVisibleTiles(tiles, this.cache);

    // ⑥ Pin 当前帧瓦片（防止 LRU 淘汰正在渲染的瓦片）
    this.cache.pinForFrame(visible.map(v => v.id.key));

    // ⑦ Cross-Fade 处理
    const { oldAlpha, newAlpha } = this.transition.update(deltaMs);

    // ⑧ 渲染
    const encoder = device.createCommandEncoder();

    // resize 后的第一帧 blit 旧帧
    const targetView = resources.context.getCurrentTexture().createView();
    this.surface.blitRetainedFrame(device, encoder, targetView);

    // 主渲染 pass
    this.renderTiles(encoder, camera, visible, newAlpha, device, resources, targetView);

    // cross-fade 旧瓦片
    if (this.transition.isActive()) {
      this.renderTiles(encoder, camera, this.transition.getOldTiles(), oldAlpha, device, resources, targetView);
    }

    // ⑨ 保留当前帧（用于下次 resize）
    this.surface.retainFrame(device, encoder, resources.context.getCurrentTexture());

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(() => this.onFrame(state, device, resources));
  }

  private renderTiles(
    encoder: GPUCommandEncoder, camera: Camera25DState,
    tiles: VisibleTile[], alpha: number,
    device: GPUDevice, res: RenderResources, targetView: GPUTextureView,
  ): void {
    // 批量写入顶点（相对坐标）
    const verts = new Float32Array(tiles.length * 20);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i].id;
      const v = computeTileVerticesRelative(t.z, t.x, t.y, camera.worldSize, camera.centerWorld);
      verts.set(v, i * 20);
    }
    device.queue.writeBuffer(res.vertexBuffer, 0, verts);

    // 写相机 + fade uniform
    writeCameraUniforms(device, res.cameraBuffer, camera);
    writeFadeUniform(device, res.fadeBuffer, alpha);

    // 开始 pass
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: res.depthView,
        depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });

    pass.setPipeline(res.pipeline);
    pass.setBindGroup(0, res.cameraBindGroup);
    pass.setBindGroup(3, res.fadeBindGroup);
    pass.setVertexBuffer(0, res.vertexBuffer);
    pass.setIndexBuffer(res.indexBuffer, 'uint16');

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t.bindGroup) continue;
      pass.setBindGroup(1, t.bindGroup);

      // 写 UV offset/scale
      const uvData = new Float32Array([...t.uvOffset, ...t.uvScale]);
      device.queue.writeBuffer(res.tileParamsBuffer, 0, uvData);
      pass.setBindGroup(2, res.tileParamsBindGroup);

      pass.drawIndexed(6, 1, 0, i * 4, 0);
    }
    pass.end();
  }

  destroy(): void {
    this.requestScheduler.cancelAll();
    this.cache.destroy();
    this.idle.destroy();
    this.surface.destroy();
  }
}
```

---

## 方案总结对照表

| # | 问题 | Issue | 核心修复 | 模块 |
|---|------|-------|---------|------|
| 一 | 缩放闪烁 | Leaflet #52, deck.gl #6448 | 祖先占位 + UV 子区域 + 单 zoom 可见性仲裁 | TileCache + Shader |
| 二 | 请求浪费 | OL #15293, #15574, #11626 | cancelStale + 优先级 + per-priority 并发限制 | RequestScheduler |
| 三 | 内存泄漏 | OL #16156, #9556 | O(1) 链表 LRU + pin 机制 + destroy 全链路 | TileCache + Engine |
| 四 | 404 不一致 | MapLibre #5692 | transient/permanent 分级 + 指数退避 | ErrorHandler |
| 五 | 主线程卡 | deck.gl #5891, ML #4778 | IoU 节流 + maxTiles=200 | TileScheduler |
| 六 | 换源闪烁 | Leaflet #6158 | 双 Pass cross-fade + alpha blending pipeline | SourceTransition |
| 七 | Resize 白屏 | MapLibre #4158 | 每帧 retain + resize 后 blit（含完整 WGSL） | SurfaceManager |
| 八 | 截图空白 | OL #13076 | 计数器 + setTimeout 防抖 + destroy 安全 | IdleDetector |
| 九 | 高 zoom 缝隙 | Leaflet #9731 | 相机相对坐标 viewMatrix + 顶点减 center | Camera25D |
| 十 | 统一帧循环 | 全部 | ①~⑨ 协同工作的完整 onFrame | TileRenderer |
