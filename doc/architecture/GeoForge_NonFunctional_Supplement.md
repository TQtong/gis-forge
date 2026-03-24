# GeoForge 架构补充 — 可扩展性 / 可维护性 / 性能优化 / 易用性

> 当前架构定义了"引擎做什么"（功能接口），但缺乏"引擎如何长期活下去"的系统性设计。
> 本文档补充四个非功能性维度的缺口分析和解决方案。

---

## 一、缺口总览

| 维度 | 当前状态 | 核心缺口 |
|------|---------|---------|
| **可扩展性** | EP1~EP6 定义了外部扩展点 | 内部模块扩展机制缺失；版本演进策略缺失；新增图层/投影/数据源的成本未量化 |
| **可维护性** | 日志有 Logger，统计有 RenderStats | 无调试工具链；无依赖约束机制；无运行时诊断面板；无文档自动生成 |
| **性能优化** | 有微观优化（StagingRing/IndirectDraw/SplitDouble） | 无宏观性能框架（预算/监控/降级/自适应）；无对象池化策略；无渲染管线分析 |
| **易用性** | L6 预设层提供简化 API | 错误消息不友好；TypeScript 类型体验未设计；迁移路径未定义；学习曲线未平滑 |

---

## 二、可扩展性（Extensibility）

### 2.1 当前缺口

**问题 1：内部扩展成本高**

新增一种图层类型（如 `layer-s2`）需要触碰多少个模块？

```
当前答案：至少 8 个文件
1. 新包 layer-s2/S2Layer.ts              — implements Layer
2. scene/layer-manager.ts                 — registerLayerType('s2', factory)
3. runtime/worker-pool.ts                 — 新增 WorkerTaskType 's2-decode'（如果有新编解码）
4. runtime/worker-entry.ts                — 添加 's2-decode' 分支
5. gpu/l2/shader-assembler.ts             — 如果需要新投影模块
6. gpu/wgsl/projection/s2.wgsl            — 新 WGSL 投影代码
7. preset-xxx/                            — 预设包引用新图层
8. scene/source-manager.ts                — 如果需要新数据源类型
```

**这太多了。** 理想情况下新增图层应该只需要 1~2 个文件。

**问题 2：无内部事件/钩子机制**

L5 的 EP1~EP6 是给外部社区的。但引擎内部模块之间也需要松耦合通信：
- TileScheduler 加载完瓦片后，谁通知 Layer？目前是直接方法调用（硬耦合）
- Camera 变化后，谁通知 LabelManager 重新碰撞？目前是 FrameScheduler 硬编码顺序
- 内存超预算后，谁通知各图层释放缓存？目前是 MemoryBudget 直接操作 ResourceManager

**问题 3：无版本演进策略**

- 公共 API 哪些可以改、哪些不能改？
- 内部 API 和公共 API 的边界在哪？
- 如何废弃旧接口、引导用户迁移？

### 2.2 解决方案

#### A. 内部事件总线（InternalBus）

```typescript
// 新增：core/infra/internal-bus.ts
// 引擎内部模块间的松耦合通信，与 L0/event.ts（用户事件）分离

export type InternalEventMap = {
  // 瓦片生命周期
  'tile:loaded':    { sourceId: string; coord: TileCoord; data: any };
  'tile:error':     { sourceId: string; coord: TileCoord; error: Error };
  'tile:evicted':   { sourceId: string; coord: TileCoord };

  // 相机
  'camera:changed': { state: CameraState };
  'camera:idle':    { state: CameraState };

  // 内存
  'memory:warning':  { snapshot: MemorySnapshot };
  'memory:eviction': { evictedIds: string[] };

  // 图层
  'layer:added':    { layer: Layer };
  'layer:removed':  { layerId: string };
  'layer:data-changed': { layerId: string };

  // GPU
  'device:lost':    { reason: string };
  'device:restored': {};

  // 渲染
  'frame:begin':    { frameIndex: number };
  'frame:end':      { stats: FrameStats };
};

export interface InternalBus {
  emit<K extends keyof InternalEventMap>(event: K, data: InternalEventMap[K]): void;
  on<K extends keyof InternalEventMap>(event: K, handler: (data: InternalEventMap[K]) => void): () => void;
  once<K extends keyof InternalEventMap>(event: K, handler: (data: InternalEventMap[K]) => void): () => void;
}
```

**效果**：TileScheduler 不再直接调用 Layer.onTileLoaded()，而是 `bus.emit('tile:loaded', ...)`。Layer 自己 `bus.on('tile:loaded', ...)` 监听。新增图层不需要改 TileScheduler。

#### B. 图层注册即完成（Plugin Protocol）

```typescript
// 新增：图层自描述协议
// 新增图层只需要实现此接口，引擎自动处理 Worker 任务注册、Shader 模块注册

export interface LayerPlugin {
  readonly type: string;                       // 'fill' | 'line' | 's2' | ...

  // 声明需要的 Worker 任务（引擎自动注册到 WorkerPool）
  readonly workerTasks?: Array<{
    type: string;                              // 新的 WorkerTaskType
    handler: string;                           // Worker 端处理函数的模块路径
  }>;

  // 声明需要的 Shader 模块（引擎自动注册到 ShaderAssembler）
  readonly shaderModules?: ShaderModuleDefinition[];

  // 声明需要的 Compute 任务
  readonly computeTasks?: string[];

  // 图层工厂
  createLayer(spec: LayerSpec, context: LayerContext): Layer;
}

// 使用：
// 新增 S2 图层只需要一个文件
export const s2Plugin: LayerPlugin = {
  type: 's2',
  workerTasks: [{ type: 's2-decode', handler: './s2-decoder.ts' }],
  shaderModules: [{ type: 'projection', id: 's2', wgslCode: '...' }],
  createLayer: (spec, ctx) => new S2Layer(spec, ctx),
};

// 注册：
engine.registerPlugin(s2Plugin);  // 一行搞定
```

**效果**：新增图层从"改 8 个文件"降为"写 1 个文件 + 1 行注册"。

#### C. API 分级与版本策略

```typescript
// 新增：API 稳定性标记（通过 JSDoc tag）

/**
 * @stability stable — 遵循 semver，不会 breaking change
 * @since 1.0.0
 */
export interface Map2D { ... }

/**
 * @stability experimental — 可能在 minor 版本中改变
 * @since 1.2.0
 */
export interface ViewMorph { ... }

/**
 * @stability internal — 仅引擎内部使用，随时可能改变
 * 外部使用风险自负
 */
export interface ShaderAssembler { ... }

// API 废弃流程：
// 1. 标记 @deprecated + 替代方案
// 2. 下一个 minor 版本打印 console.warn
// 3. 下一个 major 版本删除

/**
 * @deprecated 使用 queryRenderedFeatures() 代替（返回 Promise）
 * @removal 2.0.0
 */
export function queryFeaturesSync(...): Feature[];
```

---

## 三、可维护性（Maintainability）

### 3.1 当前缺口

**问题 1：无依赖约束机制**

七层架构说"禁止反向依赖"，但没有工具强制执行。开发者可能无意中在 L1 中 import L4 的类型。

**问题 2：无运行时调试工具**

RenderStats 只有数字统计。开发者无法：
- 看到当前加载了哪些瓦片
- 看到每个图层的 draw call 数量
- 看到 GPU 内存占用分布
- 看到 Shader 变体列表
- 回放某一帧的渲染过程

**问题 3：错误上下文不足**

当 Shader 编译失败、瓦片解码出错、内存超预算时，错误信息缺乏上下文（哪个图层、哪个瓦片、什么配置导致的）。

### 3.2 解决方案

#### A. 依赖约束（构建时检查）

```typescript
// 新增：scripts/check-deps.ts
// 在 CI 中运行，检查每个包只 import 允许的依赖

const ALLOWED_DEPS: Record<string, string[]> = {
  '@geoforge/core':       [],                              // L0 不依赖任何包
  '@geoforge/gpu':        ['@geoforge/core'],              // L1+L2 只依赖 L0
  '@geoforge/runtime':    ['@geoforge/core', '@geoforge/gpu'],  // L3
  '@geoforge/scene':      ['@geoforge/core', '@geoforge/gpu', '@geoforge/runtime'],
  '@geoforge/extensions': ['@geoforge/core', '@geoforge/gpu', '@geoforge/runtime', '@geoforge/scene'],
  // preset-* 可以依赖全部
};

// ESLint 规则：
// 'no-restricted-imports': 配合 ALLOWED_DEPS 自动生成
// 'import/no-cycle': 检测循环依赖
```

#### B. DevTools 诊断面板

```typescript
// 新增：L2 新模块 — DevTools

export interface DevTools {
  // 开关（生产环境可完全 tree-shake 掉）
  readonly enabled: boolean;
  enable(): void;
  disable(): void;

  // --- 瓦片检查器 ---
  getTileGrid(): Array<{
    coord: TileCoord;
    state: TileState;
    sourceId: string;
    byteSize: number;
    loadTimeMs: number;
  }>;
  showTileBorders(show: boolean): void;        // 在地图上画瓦片边框
  showTileLoadOrder(show: boolean): void;      // 显示加载顺序编号

  // --- GPU 内存分布 ---
  getMemoryBreakdown(): {
    buffers: { label: string; size: number }[];
    textures: { label: string; size: number; format: string }[];
    pipelines: number;
    bindGroups: number;
    total: number;
    budget: number;
  };

  // --- Shader 变体 ---
  getShaderVariants(): Array<{
    key: ShaderVariantKey;
    compiledAt: number;
    usedInLastFrame: boolean;
  }>;

  // --- 图层性能 ---
  getLayerStats(): Array<{
    layerId: string;
    drawCalls: number;
    triangles: number;
    gpuTimeMs: number;
    visibleTiles: number;
  }>;

  // --- 帧回放（开发时录制帧数据）---
  startRecording(): void;
  stopRecording(): FrameRecording[];
  replayFrame(frame: FrameRecording): void;

  // --- Pipeline 监控 ---
  getQueueStatus(): {
    pendingRequests: number;
    activeWorkers: number;
    idleWorkers: number;
    stalledTasks: string[];
  };
}

export interface FrameRecording {
  readonly frameIndex: number;
  readonly timestamp: number;
  readonly cameraState: CameraState;
  readonly commands: Array<{
    type: 'draw' | 'compute' | 'copy' | 'resolve';
    layerId?: string;
    pipelineKey?: string;
    vertexCount?: number;
    instanceCount?: number;
  }>;
  readonly stats: FrameStats;
}
```

#### C. 结构化错误

```typescript
// 新增：core/infra/errors.ts

export enum GeoForgeErrorCode {
  // GPU
  DEVICE_LOST = 'GPU_DEVICE_LOST',
  SHADER_COMPILE_FAILED = 'GPU_SHADER_COMPILE',
  BUFFER_OOM = 'GPU_BUFFER_OOM',
  TEXTURE_SIZE_EXCEEDED = 'GPU_TEXTURE_SIZE',

  // 数据
  TILE_LOAD_FAILED = 'DATA_TILE_LOAD',
  TILE_DECODE_FAILED = 'DATA_TILE_DECODE',
  GEOJSON_PARSE_FAILED = 'DATA_GEOJSON_PARSE',
  SOURCE_NOT_FOUND = 'DATA_SOURCE_NOT_FOUND',

  // 配置
  INVALID_LAYER_SPEC = 'CONFIG_INVALID_LAYER',
  UNKNOWN_PROJECTION = 'CONFIG_UNKNOWN_PROJECTION',
  UNKNOWN_LAYER_TYPE = 'CONFIG_UNKNOWN_LAYER_TYPE',

  // 扩展
  EXTENSION_INIT_FAILED = 'EXT_INIT_FAILED',
  EXTENSION_RENDER_FAILED = 'EXT_RENDER_FAILED',
  EXTENSION_DISABLED = 'EXT_DISABLED',

  // Worker
  WORKER_CRASH = 'WORKER_CRASH',
  WORKER_TIMEOUT = 'WORKER_TIMEOUT',
}

export class GeoForgeError extends Error {
  constructor(
    readonly code: GeoForgeErrorCode,
    message: string,
    readonly context: {
      layerId?: string;
      sourceId?: string;
      tileCoord?: TileCoord;
      moduleId?: string;
      shaderVariant?: string;
      [key: string]: any;
    },
    readonly cause?: Error,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'GeoForgeError';
  }
}

// 使用示例：
throw new GeoForgeError(
  GeoForgeErrorCode.SHADER_COMPILE_FAILED,
  `Shader 编译失败：投影模块 "custom-proj" 第 42 行语法错误`,
  { moduleId: 'custom-proj', shaderVariant: 'custom-proj/polygon/fill_solid', layerId: 'buildings' },
  originalWebGPUError,
);
// 开发者看到的信息：
// [GPU_SHADER_COMPILE] Shader 编译失败：投影模块 "custom-proj" 第 42 行语法错误
//   layerId: buildings
//   moduleId: custom-proj
//   shaderVariant: custom-proj/polygon/fill_solid
//   cause: GPUCompilationMessage { ... }
```

---

## 四、性能优化（Performance）

### 4.1 当前缺口

**问题 1：无宏观性能框架**

有微观优化（StagingRing/IndirectDraw/SplitDouble），但没有：
- 性能预算（每帧 CPU 时间、GPU 时间、内存的上限）
- 自适应降级（超预算时自动降低质量）
- 性能剖析入口（开发者如何定位瓶颈）

**问题 2：无对象池化策略**

BufferPool 管理 GPU Buffer，但大量 CPU 端临时对象未池化：
- 每帧创建的 CameraState 快照
- 每帧的 TileScheduleResult
- Worker 消息对象
- 事件对象（MapPointerEvent 等）

**问题 3：无渲染管线瓶颈分析**

无法区分帧率低是因为：CPU 瓶颈（JS 计算）、GPU 瓶颈（绘制）、还是带宽瓶颈（瓦片加载）。

### 4.2 解决方案

#### A. 自适应性能管理器（PerformanceManager）

```typescript
// 新增：runtime/performance-manager.ts

export interface PerformanceBudget {
  readonly targetFPS: number;                  // 目标帧率，默认 60
  readonly maxFrameTimeMs: number;             // 最大帧时间 = 1000/targetFPS
  readonly maxGPUTimeMs: number;               // GPU 时间预算，默认 12ms
  readonly maxJSTimeMs: number;                // JS 时间预算，默认 4ms
  readonly maxTileLoadsPerFrame: number;       // 每帧最多发起的瓦片请求，默认 4
  readonly maxTrianglesPerFrame: number;       // 每帧最大三角形数，默认 2M
  readonly maxDrawCallsPerFrame: number;       // 每帧最大 draw call，默认 200
}

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low' | 'potato';

export interface PerformanceManager {
  readonly budget: PerformanceBudget;
  readonly currentQuality: QualityLevel;
  readonly isAdaptiveEnabled: boolean;

  // 自适应开关
  setAdaptiveEnabled(enabled: boolean): void;

  // 每帧由 FrameScheduler 调用
  evaluate(stats: FrameStats): PerformanceAction[];

  // 手动设置质量
  setQuality(level: QualityLevel): void;

  // 查询当前降级状态
  readonly activeDowngrades: PerformanceDowngrade[];
}

export type PerformanceAction =
  | { type: 'reduce-resolution'; scale: number }       // 降低渲染分辨率
  | { type: 'reduce-tile-quality'; maxZoom: number }   // 降低瓦片最大 zoom
  | { type: 'disable-postprocess'; passId: string }    // 关闭后处理
  | { type: 'reduce-label-density'; factor: number }   // 减少标注密度
  | { type: 'disable-shadows' }                        // 关闭阴影
  | { type: 'disable-atmosphere' }                     // 关闭大气
  | { type: 'increase-sse-threshold'; value: number }  // 提高 SSE 阈值（减少瓦片）
  | { type: 'reduce-msaa'; sampleCount: 1 }           // 关闭 MSAA
  | { type: 'restore' };                               // 恢复到上一级

// 降级链（连续 N 帧超预算时按顺序执行）：
// 1. 关闭 MSAA (4→1)
// 2. 关闭后处理 (SSAO→Bloom→Shadow)
// 3. 降低渲染分辨率 (1.0→0.75→0.5)
// 4. 提高 SSE 阈值 (2→4→8)
// 5. 减少标注密度 (1.0→0.5→0.25)
// 6. 关闭大气/阴影
// 恢复：连续 M 帧在预算内，按反序逐步恢复

export interface PerformanceDowngrade {
  readonly type: string;
  readonly appliedAt: number;                  // 帧号
  readonly reason: 'gpu-bound' | 'cpu-bound' | 'memory-bound';
}
```

#### B. 对象池（ObjectPool）

```typescript
// 新增：core/infra/object-pool.ts

export interface ObjectPool<T> {
  acquire(): T;
  release(obj: T): void;
  readonly size: number;
  readonly available: number;
  clear(): void;
  preAllocate(count: number): void;
}

export function createObjectPool<T>(
  factory: () => T,
  reset: (obj: T) => void,
  initialSize?: number,
): ObjectPool<T>;

// 引擎内部使用：
const cameraStatePool = createObjectPool(
  () => ({ center: [0,0], zoom: 0, bearing: 0, pitch: 0, ... } as CameraState),
  (state) => { /* 重置所有字段 */ },
  4,  // 预分配 4 个
);

const tileResultPool = createObjectPool(
  () => ({ toLoad: [], toUnload: [], visible: [], placeholder: new Map() } as TileScheduleResult),
  (result) => { result.toLoad.length = 0; result.toUnload.length = 0; ... },
  2,
);

// 帧临时数组池
const tempFloat32Pool = createObjectPool(
  () => new Float32Array(16),
  (arr) => arr.fill(0),
  8,
);
```

#### C. 帧预算分配

```typescript
// 新增到 FrameScheduler

export interface FrameBudgetAllocation {
  // 每个阶段的时间预算（毫秒）
  readonly update: number;                     // 默认 2ms
  readonly compute: number;                    // 默认 1ms
  readonly render: number;                     // 默认 10ms
  readonly postProcess: number;                // 默认 2ms
  readonly idle: number;                       // 剩余时间

  // 动态调整：如果 update 阶段只用了 1ms，render 阶段可以多用 1ms
  readonly isFlexible: boolean;
}

// FrameScheduler 增强：
export interface FrameScheduler {
  // ...已有方法...

  // 新增：阶段级计时
  readonly phaseTimings: {
    readonly update: number;
    readonly render: number;
    readonly post: number;
    readonly idle: number;
    readonly total: number;
  };

  // 新增：超预算回调（PerformanceManager 监听此事件）
  onBudgetExceeded(callback: (phase: string, actualMs: number, budgetMs: number) => void): () => void;
}
```

---

## 五、易用性（Usability / Developer Experience）

### 5.1 当前缺口

**问题 1：错误消息不友好**

WebGPU 原生错误（"Validation error at ..."）对 GIS 开发者无意义。需要翻译为业务语言。

**问题 2：TypeScript 类型推导体验未设计**

`map.on('click', layerId, callback)` 中 callback 的参数类型能否自动推导？
`map.setPaintProperty(layerId, 'fill-color', ...)` 中第三个参数能否根据 layerId 类型约束？

**问题 3：学习曲线陡峭**

从 "Hello World" 到 "自定义图层" 跨度太大。缺乏中间步骤的引导。

**问题 4：迁移路径不明**

从 MapLibre GL / CesiumJS / Leaflet 迁移到 GeoForge 的路径未定义。

### 5.2 解决方案

#### A. 开发者友好的错误消息

```typescript
// 增强 Logger：开发模式下自动附加修复建议

export interface DeveloperHint {
  readonly code: GeoForgeErrorCode;
  readonly message: string;
  readonly suggestion: string;
  readonly docUrl?: string;
}

const DEVELOPER_HINTS: Record<string, DeveloperHint> = {
  'GPU_SHADER_COMPILE': {
    code: GeoForgeErrorCode.SHADER_COMPILE_FAILED,
    message: 'Shader 编译失败',
    suggestion: '检查自定义 Shader Hook 的 WGSL 语法。确保 vec3 对齐到 16 字节。',
    docUrl: 'https://geoforge.dev/docs/troubleshooting#shader-errors',
  },
  'CONFIG_UNKNOWN_LAYER_TYPE': {
    code: GeoForgeErrorCode.UNKNOWN_LAYER_TYPE,
    message: '未知的图层类型',
    suggestion: '检查是否已注册图层插件：engine.registerPlugin(myLayerPlugin)。内置类型：fill/line/circle/symbol/raster/extrusion。',
    docUrl: 'https://geoforge.dev/docs/layers',
  },
  'GPU_BUFFER_OOM': {
    code: GeoForgeErrorCode.BUFFER_OOM,
    message: 'GPU 内存不足',
    suggestion: '尝试：1) 减少 tileCacheSize  2) 降低 gpuMemoryBudget  3) 减少同时显示的图层数。当前 GPU 内存使用可通过 devTools.getMemoryBreakdown() 查看。',
    docUrl: 'https://geoforge.dev/docs/performance#memory',
  },
};

// 输出效果：
// ⚠️ [GPU_SHADER_COMPILE] Shader 编译失败：投影模块 "custom-proj" 第 42 行
//    💡 建议：检查自定义 Shader Hook 的 WGSL 语法。确保 vec3 对齐到 16 字节。
//    📖 文档：https://geoforge.dev/docs/troubleshooting#shader-errors
//    📋 上下文：layerId=buildings, module=custom-proj
```

#### B. 类型安全的事件与属性

```typescript
// 增强 Map2D 事件类型推导

// 事件类型映射
interface MapEventHandlers {
  'click': MapMouseEvent;
  'mousemove': MapMouseEvent;
  'zoom': MapEvent;
  'moveend': MapEvent;
  'load': MapEvent;
  'error': MapErrorEvent;
}

// 重载签名使 TypeScript 自动推导 callback 参数类型
export class Map2D {
  on<K extends keyof MapEventHandlers>(type: K, callback: (e: MapEventHandlers[K]) => void): this;
  on<K extends keyof MapEventHandlers>(type: K, layerId: string, callback: (e: MapEventHandlers[K]) => void): this;
}

// 效果：
map.on('click', (e) => {
  e.lngLat;    // ✅ TypeScript 知道这是 MapMouseEvent，自动补全 lngLat
  e.features;  // ✅ 自动补全
});

// 样式属性类型安全
interface PaintProperties {
  'fill-color': string | StyleExpression;
  'fill-opacity': number | StyleExpression;
  'line-width': number | StyleExpression;
  'line-color': string | StyleExpression;
  // ...完整映射
}

export class Map2D {
  setPaintProperty<K extends keyof PaintProperties>(
    layerId: string,
    name: K,
    value: PaintProperties[K],
  ): this;
}

// 效果：
map.setPaintProperty('buildings', 'fill-color', '#ff0000');   // ✅
map.setPaintProperty('buildings', 'fill-color', 42);          // ❌ TypeScript 报错
map.setPaintProperty('buildings', 'filll-color', '#ff0000');  // ❌ TypeScript 报错：拼写错误
```

#### C. 渐进式学习路径

```
Level 0 — 零配置（5 行代码）
  import { Map } from '@geoforge/preset-2d';
  new Map({ container: 'map', style: 'https://...' });

Level 1 — 添加数据（+10 行）
  map.addSource('points', { type: 'geojson', data: myGeoJSON });
  map.addLayer({ id: 'dots', type: 'circle', source: 'points', paint: { 'circle-radius': 5 } });

Level 2 — 交互（+5 行）
  map.on('click', 'dots', (e) => {
    console.log(e.features[0].properties);
  });

Level 3 — 3D 模式（改 1 行）
  import { Map } from '@geoforge/preset-full';
  const map = new Map({ container: 'map', mode: '3d', terrain: { ... } });

Level 4 — 自定义样式（学习 StyleExpression）
  paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'population'], 0, '#fff', 1000000, '#f00'] }

Level 5 — 自定义 Shader Hook（学习 WGSL）
  registry.registerShaderHook('night-mode', { hookPoint: 'fragment_color_after_style', wgslCode: '...' });

Level 6 — 完全自定义图层（学习 WebGPU）
  registry.registerLayer('particles', (options) => new ParticleLayer(options));
```

#### D. MapLibre 兼容层

```typescript
// 新增可选包：@geoforge/compat-maplibre
// 让 MapLibre GL JS 的代码以最小改动在 GeoForge 上运行

export function createMapLibreCompat(map: Map2D): MapLibreCompatMap {
  // 代理 MapLibre 的 API 调用到 GeoForge 对应方法
  // 处理差异：
  //   - MapLibre: queryRenderedFeatures 同步 → GeoForge: 异步（包装为 sync stub + warning）
  //   - MapLibre: map.getCanvas().getContext('webgl') → GeoForge: 不支持（抛出友好错误）
  //   - MapLibre: style spec 100% 兼容
  //   - MapLibre: source/layer 类型映射
}
```

---

## 六、需要修改的现有模块

| 现有模块 | 补充内容 | 影响层 |
|---------|---------|--------|
| **core/infra/event.ts** | 拆分为 UserEventBus + InternalBus | L0 |
| **core/infra/logger.ts** | 增加 DeveloperHint 系统 | L0 |
| **core/infra/config.ts** | 增加 PerformanceBudget 配置字段 | L0 |
| **新增 core/infra/errors.ts** | GeoForgeError + GeoForgeErrorCode | L0 |
| **新增 core/infra/object-pool.ts** | 通用对象池 | L0 |
| **新增 core/infra/internal-bus.ts** | 内部事件总线 | L0 |
| **runtime/frame-scheduler.ts** | 增加 phaseTimings + onBudgetExceeded | L3 |
| **新增 runtime/performance-manager.ts** | 自适应降级 | L3 |
| **新增 gpu/l2/devtools.ts** | 调试面板 | L2 |
| **scene/layer-manager.ts** | 支持 LayerPlugin 协议 | L4 |
| **extensions/registry.ts** | 支持 registerPlugin 批量注册 | L5 |
| **preset-*/Map2D.ts** | 类型安全事件 + 属性 | L6 |
| **新增 scripts/check-deps.ts** | 依赖约束检查 | 构建 |

---

## 七、新增模块汇总

| 新增模块 | 所属层 | 文件 | 职责 |
|---------|--------|------|------|
| InternalBus | L0 | `core/infra/internal-bus.ts` | 内部模块松耦合通信 |
| GeoForgeError | L0 | `core/infra/errors.ts` | 结构化错误 + 错误码 + 上下文 |
| ObjectPool | L0 | `core/infra/object-pool.ts` | 通用对象池 |
| PerformanceManager | L3 | `runtime/performance-manager.ts` | 自适应性能管理 |
| DevTools | L2 | `gpu/l2/devtools.ts` | 运行时诊断面板 |
| LayerPlugin | L4 | `scene/layer-plugin.ts` | 图层自描述注册协议 |

---

## 八、Cursor Rules 更新

以下规则需要添加到 `.cursor/rules/core.mdc`：

```
15. **结构化错误**——所有错误必须使用 GeoForgeError(code, message, context)，禁止裸 throw new Error()
16. **内部通信走 Bus**——模块间通信使用 InternalBus.emit/on，禁止直接方法调用跨模块通知
17. **对象池化**——帧循环内的临时对象（CameraState/TileScheduleResult/事件对象）必须使用 ObjectPool
18. **API 稳定性标记**——公共方法必须标注 @stability (stable/experimental/internal)
19. **性能预算**——新增渲染功能必须评估对帧时间的影响，超预算功能必须实现降级路径
20. **DevTools 可剥离**——所有调试代码通过 __DEV__ 条件编译，生产环境 tree-shake 移除
```
