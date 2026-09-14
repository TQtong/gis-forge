# GIS-Forge Agent 工作规范

本文件适用于整个仓库，根据 `.cursor/rules/` 下全部 9 份规则整理。开始任务时必须读取本文件；修改具体模块前，还必须读取对应的原始规则和架构文档。不得仅根据现有实现推断要求，不得把已有缺陷当作继续违反规范的理由。

## 1. 强制工作方式：修改一点就提交一点，完整实现

1. **修改一点就提交一点。** 将任务拆成小而完整、可独立验证的改动；每完成一个改动，立即检查、验证并执行一次 Git 提交，再开展下一个改动。禁止积攒多个无关改动后集中提交，禁止只修改不提交。
2. **小步提交不等于缩减需求。** 每次提交可以只完成整体任务的一部分，但该部分必须形成可运行、可验证的完整闭环；必须持续推进，直到用户要求的全部功能、接入、错误处理、边界处理和必要验证都完成。
3. **必须完完整整实现，禁止简约版本。** 禁止交付简约版、简化版、精简版、最小版、MVP、骨架版、示意版、演示替代品或仅 happy path 的实现。不得擅自减少功能、降低精度、替换算法、删减交互或跳过生命周期。
4. **禁止占位与省略。** 禁止新增待实现的 `TODO`、空函数、伪实现、固定返回值冒充真实结果、未接入的界面，以及“其他方法类似”“此处省略”“后续补充”“由于篇幅限制只展示核心部分”等交付。函数体、分支、循环、import/export 必须全部写完。
5. **实现必须贯通实际调用链。** 新增能力必须完成需要的类型、算法、Worker 任务、GPU 资源、Shader、注册、上层 API 和使用入口；修复问题必须处理根因及受影响的相关路径。只写接口或孤立模块不算完成。
6. **完成意味着验证完成。** 对照需求逐项验收，执行与改动相关的检查；发现本次改动导致的失败必须继续修复。不得通过删测试、跳过断言、放宽类型、吞异常或伪造数据掩盖问题。
7. **遇到真实阻塞时如实说明。** 记录阻塞原因、已完成内容及未完成事项，继续处理不受阻的工作；不得把未完成工作宣称为完成，也不得以时间、篇幅或任务较大为由擅自交付简化版本。

### Git 提交流程

- 开始前执行 `git status --short`，识别已有改动，保护用户及其他任务的工作。
- 一个提交只包含一个明确目的；同一功能所需的实现、类型、接入、相关测试和文档可以作为一个完整改动一起提交。
- 每个小改动完成后依次执行：检查差异 → 相关验证 → `git diff --check` → 按明确路径暂存 → `git diff --cached` 检查 → `git commit` → 检查工作区状态。
- 本文件明确要求主动执行本地提交，不必在每次小步提交前重复询问。若创建分支，默认使用 `codex/` 前缀。
- 不得把无关改动混入提交；工作区存在其他改动时，禁止用 `git add .` 或 `git add -A` 一并收走。
- 提交信息格式：`type(scope): description`；类型为 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`，说明具体变化。
- 不得为整理提交擅自重置、覆盖、删除已有工作或改写历史；提交失败应修复原因并重试，无法解决时报告阻塞，禁止声称已提交。
- 本地提交要求不包含自动推送、合并或发布授权。最终交付说明实际完成内容、验证结果、提交哈希及尚存的真实限制。

## 2. 规则来源与适用范围

| 原始规则 | 适用范围 |
| --- | --- |
| [core.mdc](.cursor/rules/core.mdc) | 所有任务；项目定位、架构、全局硬约束和实现质量 |
| [math-coding.mdc](.cursor/rules/math-coding.mdc) | `src/packages/core/src/{math,geo,algorithm,index,precision}/**` |
| [shared-types.mdc](.cursor/rules/shared-types.mdc) | `src/packages/core/src/types/**` 及引用共享类型的代码 |
| [gpu-rendering.mdc](.cursor/rules/gpu-rendering.mdc) | `src/packages/gpu/**` |
| [shader-wgsl.mdc](.cursor/rules/shader-wgsl.mdc) | `**/*.wgsl`、`**/shader*/**`、`**/wgsl*/**` |
| [camera-runtime.mdc](.cursor/rules/camera-runtime.mdc) | `src/packages/runtime/**`、`src/packages/camera-*/**`、`src/packages/view-morph/**` |
| [scene-layers.mdc](.cursor/rules/scene-layers.mdc) | `src/packages/scene/**`、`src/packages/layer-*/**`、`src/packages/globe/**` |
| [extensions.mdc](.cursor/rules/extensions.mdc) | `src/packages/extensions/**`、`src/packages/interaction-*/**`、`src/packages/postprocess-*/**`、`src/packages/source-*/**` |
| [presets.mdc](.cursor/rules/presets.mdc) | `src/packages/preset-*/**` |

- 架构资料实际位于 `doc/architecture/`，目录总览为 [GeoForge_Directory_Structure.md](doc/architecture/GeoForge_Directory_Structure.md)。原始规则中的 `docs/architecture/` 是旧路径。
- 原始规则中的接口片段用于说明契约，不是可直接复制的完整实现；其中省略类型、`any` 或模板占位符不构成交付质量要求的例外。实现时必须补全类型、注释及行为。
- 对原始片段的歧义，遵守全局硬约束：渲染要素查询与 GPU Picking 保持异步，不因图层示例中出现同步返回类型而破坏公共 API。
- 分层依赖按下文明确的共享 L0 与 L6 组合根规则执行，与当前 `README.md` 和 `scripts/check-deps.ts` 的约束保持一致；不能据此开放任意跨层引用。

## 3. 项目定位与渲染硬约束

GIS-Forge 是统一 2D / 2.5D / 3D 的原生 WebGPU GIS 引擎，支持同场景多维度共存、多投影 Render Pass 和 Compositor。引擎算法自研，保持 Tree-Shakable，目标 gzip 体积为 2D 约 120 KB、3D 约 195 KB、全功能约 350 KB。

- 所有地图、瓦片、几何体、标注及交互辅助图形必须使用 WebGPU、WGSL、GPUBuffer、GPUTexture 和 `draw` / `drawIndexed` 绘制。
- 禁止用 Canvas 2D、`CanvasRenderingContext2D`、`getContext('2d')`、`drawImage`、`fillRect`、SVG 或 DOM/CSS 定位代替引擎渲染；禁止 WebGL 1/2 回退、等距视角或假 3D。
- HTMLCanvasElement 是 WebGPU Surface 的合法载体；普通页面控件不属于地图几何渲染。不得用 `innerHTML`、`appendChild` 或 CSS transform 拼装瓦片和地理场景。
- 2D 使用正交投影，bearing/pitch 固定为 0；2.5D 使用透视投影，pitch 范围约为 0～85°；3D 使用透视投影及真实球体/椭球体模型。
- 三种模式共用 WebGPU 渲染体系，通过相机投影、视图矩阵及相应世界坐标/球体模型表达维度差异。
- 瓦片链路必须贯通：GPUTexture → GPUBuffer 顶点 → WGSL 顶点着色器的 VP 矩阵变换 → GPU 光栅化 → WGSL 纹理采样 → 像素。
- 引擎保持零外部运行时依赖目标，数学、GIS 算法、空间索引和投影不得用新增 npm 包代替自研。规则禁止新增 npm 依赖；仓库已存在的应用及开发依赖不代表可以继续扩张，也不得在无关任务中擅自删除。

## 4. 七层架构与全局约束

| 层 | 目录与职责 |
| --- | --- |
| L0 基础 | `core/src/`：math、geo、algorithm、index、precision、types、infra |
| L1 GPU | `gpu/src/l1/`：DeviceManager、SurfaceManager、BufferPool、TextureManager、GPUMemoryTracker、BindGroupCache、IndirectDrawManager、GPUUploader |
| L2 渲染 | `gpu/src/l2/`：ShaderAssembler、PipelineCache、DepthManager、RenderGraph、FrameGraphBuilder、Compositor、PickingEngine、StencilManager、RenderStats、ComputePassManager、BlendPresets、UniformLayoutBuilder、WGSLTemplates |
| L3 调度 | `runtime/src/`：FrameScheduler、TileScheduler、WorkerPool/worker-entry、ResourceManager、MemoryBudget、RequestScheduler、ErrorRecovery、CameraController；相机实现及 ViewMorph 遵循调度规则 |
| L4 场景 | `scene/src/`：SceneGraph、LayerManager、SourceManager、StyleEngine、LabelManager、GlyphManager、FeatureStateManager、AntiMeridianHandler、AnimationManager、SpatialQuery、A11yManager |
| L5 扩展 | `extensions/src/`：ExtensionRegistry、Lifecycle、EP1～EP6、InteractionManager |
| L6 预设 | `preset-2d/`、`preset-25d/`、`preset-3d/`、`preset-full/`：Map2D、Map25D、Globe3D、MapFull、Controls |

功能包包括 `camera-2d/25d/3d`、`view-morph`、`layer-tile-raster/vector`、`layer-geojson/terrain/3dtiles/heatmap/pointcloud/marker/extrusion`、`globe`、`interaction-draw/measure/select`、`postprocess-bloom/ssao/shadow`、`source-wmts/wms/wfs/pmtiles`、`compat-mobile/hidpi` 和 `analysis`。GPU 着色模块位于 `gpu/src/wgsl/{templates,projection,geometry,style,feature,compute}/`。

### 必须遵守的 20 条约束

1. 写代码前确认所属层、包边界及依赖方向。禁止向上依赖与循环依赖；L1～L5 允许同层、向下一层或直接引用 L0，禁止其他跨层依赖；L0 不依赖上层；L6 仅通过各包公开入口组装 L0～L5。
2. `Feature`、`CameraState`、`PickResult`、`Viewport`、`BBox2D`、`TileCoord`、`StyleExpression` 等共享类型只从 L0 导入，禁止在上层重新定义。
3. 遵守零依赖及算法自研要求，禁止用外部库绕过需要完整实现的能力。
4. 数学函数使用 `fn(out, a, b)`，返回 `out`，热路径零分配。
5. GPU 资源经过 L1 管理，L2～L6 禁止直接 `device.createBuffer/createTexture`。
6. Shader 必须经 ShaderAssembler 按投影、几何、样式模块组合，禁止单体 WGSL。
7. CPU 密集计算使用 `WorkerPool.submit()`，禁止另建绕过调度体系的执行路径。
8. EP1～EP6 通过 Context 获取引擎服务，禁止 import 引擎内部实现。
9. 扩展回调必须经 `ExtensionLifecycle.safeExecute()` 隔离错误。
10. 深度统一 Reversed-Z：`depthCompare: 'greater'`、clear `0.0`、`depth32float`。
11. 矩阵统一 Column-Major，与 WGSL 对齐。
12. 旋转角统一命名 `bearing`，单位弧度，禁止对外使用 `heading`。
13. 渲染查询 `queryRenderedFeatures` 返回 `Promise<Feature[]>`，GPU Picking 异步读回。
14. 使用命名 export，禁止 default export 和模块顶层副作用，保证 Tree-Shaking。
15. 业务错误使用 `GeoForgeError(code, message, context, cause?)`，错误码统一在 `core/src/infra/errors.ts` 管理，禁止裸 `throw new Error()`。
16. 模块间跨层通知走 `InternalBus.emit/on`，例如 `tile:loaded`；禁止 TileScheduler 直接调用图层回调来传递跨模块通知。
17. 帧循环中的 CameraState 快照、TileScheduleResult、事件和临时 TypedArray 必须通过 `ObjectPool.acquire/release` 复用，禁止每帧 `new`。
18. 公共方法标注 `@stability stable|experimental|internal`；stable 遵循 semver，experimental 可在 minor 调整，internal 可随实现变化。
19. 新增渲染能力必须评估帧时间；超预算能力在 PerformanceManager 注册降级与恢复路径。
20. 调试及 DevTools 代码必须用 `if (__DEV__)` 包裹，生产构建可剥离，非开发路径禁止引用 DevTools。

### 完整代码质量

- 每个函数提供完整 JSDoc：描述、适用的 `@param`、`@returns` 和 `@example`；公共方法增加稳定性标记。
- 遵守逐行注释要求：关键逻辑每 3～5 行补充解释“为什么这么做”的注释，说明算法、坐标空间、精度策略和资源生命周期。
- 每个 interface/type/enum 字段或成员提供 `/** 注释 */`，说明用途、单位、取值范围及适用默认值。
- 明确所有参数、返回值和跨模块数据类型；提供完整 import/export，不以弱类型掩盖未完成的契约。
- GPU、网络、Worker 和索引访问等可能失败的操作必须有条件检查或异常处理，并提供可执行的恢复/传播逻辑，不得静默吞错。
- 覆盖空数组、null/undefined、NaN、Infinity、负数、零除、越界、取消及资源已销毁等适用边界。
- 魔法数字抽为有名称的常量，并注释含义及来源；长文件必须完整实现，不能因行数增加而截断。

## 5. 帧循环、初始化、恢复与预算

- 帧循环：UPDATE（Camera、Animation、TileScheduler、LabelManager 粗筛）→ RENDER（FrameGraphBuilder、Compute 剔除/排序/碰撞、按投影分组 Render、Composite、PostProcess、Screen、Picking、submit）→ POST_FRAME（Stats、MemoryBudget、StagingRing）→ IDLE（ResourceManager.idle、PipelineCache.warmup）。
- 图层数据链：L6 addLayer → L4 LayerManager 工厂及样式编译 → ShaderAssembler/PipelineCache → L3 TileScheduler/RequestScheduler → fetch → Worker 解码/三角剖分/宽线生成 → Transferable → L1 GPUUploader → L2 FrameGraphBuilder → layer.encode → GPU 像素。各阶段通过公开契约协作，不能据此直接跨层 import。
- 初始化依次为 L0 → L1（Device、Surface、MemTracker、BufferPool、Texture、BindGroup、IndirectDraw、Uploader）→ L2（Blend、Depth、Stencil、UniformLayout、ShaderAssembler、PipelineCache、ComputePass、Stats、Compositor、Picking、RenderGraph）→ L3（ErrorRecovery、Request、Worker、Resource、Memory、Tile、Camera、FrameScheduler）→ L4（FeatureState、Glyph、Style、Label、Source、Animation、Query、A11y、Layer、Scene）→ L5（Registry、Lifecycle、Interaction、内置投影/交互）→ L6（样式、视图、Controls、start）。
- 设计基线：Shader 模块组合与 Variant 缓存；CPU/GPU N+1/N 流水线并行；Split-Double + RTC 精度；Reversed-Z + 对数深度；SSE LOD；CPU R-Tree + GPU Compute 碰撞；引用计数 + LRU + CPU/GPU 双轨预算；MSDF 文字；SDF 线；Worker 宽线条带；Weighted Blended OIT；CSM + PCF 阴影。
- 瓦片失败使用带 jitter 的指数退避 `base × 2^n`，最大 30 秒；Worker 崩溃重启并重提交；GPU 丢失后销毁并重建设备及资源；扩展连续 5 次错误自动禁用。
- 内存淘汰先筛引用计数为 0 的资源，再按 LRU、不可见瓦片、远处瓦片及资源类型（Texture > Buffer > Pipeline）处理。
- InternalBus 事件包括 `tile:loaded/error/evicted`、`camera:changed/idle`、`memory:warning/eviction`、`layer:added/removed`、`device:lost/restored`、`frame:begin/end`。
- 结构化错误分组覆盖 GPU（设备丢失/Shader 编译/Buffer OOM）、DATA（瓦片加载/解码/解析）、CONFIG（无效图层/未知投影）、EXT（初始化/渲染/禁用）、WORKER（崩溃/超时）。
- 性能预算基线：60 FPS、GPU ≤ 12 ms、JS ≤ 4 ms、三角形 ≤ 2M、Draw Call ≤ 200。连续超预算按顺序关闭 MSAA、关闭后处理、降低分辨率 1.0→0.75→0.5、提高 SSE 阈值、减少标注、关闭大气/阴影；连续达标后反序恢复。
- 移动端经 `compat-mobile` 能力检测选择降质、激进 LOD、`powerPreference: 'high-performance'`、降低渲染分辨率及减少后处理 Pass。
- DevTools 支持瓦片、GPU 内存、Shader 变体、图层性能、帧回放、队列状态检查，所有入口必须能从生产构建剥离。
- 新图层优先通过 LayerPlugin 自描述协议提供 `type`、`workerTasks`、`shaderModules`、`createLayer`，由 `engine.registerPlugin()` 完整注册。
- API 废弃流程：标注 `@deprecated` → 下一 minor 发出警告 → 下一 major 删除。

## 6. L0 数学、算法与共享类型

### 数学、精度与算法

- Vec2f/Vec3f/Vec4f、Mat3f/Mat4f、Quatf 使用 Float32Array，长度分别为 2/3/4、9/16、4；四元数顺序为 `[x,y,z,w]`。Vec2d/Vec3d/Vec4d/Mat4d 使用 Float64Array，f32/f64 实现按 `vec3.ts`、`vec3d.ts` 等区分。
- CPU 地理坐标计算使用 Float64Array；ECEF 必须 Split-Double；墨卡托 zoom ≥ 18 使用 Split-Double。热路径复用预分配输出，函数保持利于 JIT 内联。
- Mat4 索引按列排列：第一行为 `m[0], m[4], m[8], m[12]`，第二行为 `m[1], m[5], m[9], m[13]`，依此类推。
- 投影包含 `perspective()`（WebGPU NDC Z ∈ [0,1]）、`perspectiveReversedZ()`、`perspectiveReversedZInfinite()`（far = ∞）、`ortho()`；实际渲染深度约定统一 Reversed-Z。
- WGS84：`WGS84_A = 6378137.0` 米，`WGS84_B = 6356752.314245179` 米，`WGS84_F = 1 / 298.257223563`，`WGS84_E2 = 0.00669437999014`。
- 算法覆盖 earcut 带洞三角剖分 O(n²)、Delaunay O(n log n)、Andrew Monotone Chain 凸包 O(n log n)、Sutherland-Hodgman/Weiler-Atherton 裁剪、11 类相交判断（含线段、Möller-Trumbore 射线/三角形、射线/椭球、射线/AABB、视锥/AABB）、射线法点在多边形内及重心坐标点在三角形内判断。
- 简化采用 Douglas-Peucker / Visvalingam；聚合采用自研 Supercluster 层级聚合、DBSCAN、K-Means；R-Tree 使用 Hilbert + STR 批量加载且 M=16；Quadtree 用于瓦片调度；KD-Tree 用于最近邻。
- CoordinateSystem 位于 `core/src/infra/coordinate.ts`，管理 CRS 注册与转换管线，内置 EPSG:4326 和 EPSG:3857；EP2 可扩展 GCJ-02、UTM、Lambert 等。
- 投影数学位于 `geo/projection-math.ts`，覆盖 UTM、Lambert、等距圆柱、GCJ-02↔WGS84、BD-09↔GCJ-02、Helmert 七参数；批量转换使用 `transformArray(input: Float64Array, fromCRS, toCRS, output?)`。
- 可选 `@gis-forge/analysis` 包包含 boolean（交/并/差）、buffer、interpolation（TIN/IDW/等值线）、classification（Jenks/分位数）、grid（Hex/Voronoi）、raster（坡度/山影/视域）、transform、aggregation、topology 九个子模块。
- 数学/算法每个函数至少覆盖正常、边界、零值三类测试；矩阵与 numpy 对照误差 < 1e-6；Vincenty 与 GeographicLib 对照误差 < 1 mm；earcut 验证面积守恒。对照数据不能变成引擎运行时依赖。

### 共享类型契约

- 全局共享类型仅在 `@gis-forge/core/types/` 定义一次，上层按公开入口导入；扩展用 `extends` 或交叉类型，不复制定义。
- `Viewport`：width/height 为 CSS 像素，physicalWidth/physicalHeight 为物理像素，pixelRatio 为像素比例。
- `CameraState`：center 为 `[lon, lat]` 度；zoom 为缩放级别；bearing/pitch/roll/fov 为弧度；bearing=0 指向正北，pitch=0 为正俯视；altitude 为米；包含 viewMatrix、projectionMatrix、vpMatrix、inverseVPMatrix 和 position。
- `PickResult`：featureId、layerId、sourceId、coordinates、screenPosition、可选 properties、depth ∈ [0,1]、可选 worldPosition/normal；featureId 支持 string、number 或 null。
- `Feature<G, P>` 遵循 GeoJSON，具有 type、可选 id、geometry、properties；运行时可附加 `_sourceId`、`_layerId`、`_tileCoord`、`_state`。
- Geometry 兼容 RFC 7946：Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection。
- `TileCoord` 包含 x/y/z；`TileParams` 增加 extent 和 AbortSignal；`TileData<T>` 包含 data、extent 及可选 transferables/byteSize/expiresAt；`TileState` 为 empty/loading/loaded/error/cached。
- 样式共享类型包括 MapLibre v8 兼容的 StyleSpec、SourceSpec、LayerStyleSpec、StyleExpression、FilterExpression、LightSpec。

## 7. L1/L2 GPU、渲染与 WGSL

### 资源、Surface 与管线

- Buffer 通过 `BufferPool.acquire/release` 管理，使用方禁止手动 destroy 池资源；Texture 通过 `TextureManager.create/release` 管理；所有资源纳入 `GPUMemoryTracker.track()`。
- 小 Uniform 使用 `GPUUploader.writeUniform()`；大数据使用 `BufferPool.acquireStaging()`，StagingRing 为 4 MB × 3 三重缓冲；Worker 数据使用 `GPUUploader.uploadFromTransferable()`。
- 驱动差异使用 `DeviceManager.needsWorkaround(id)`，通过 GPUAdapterInfo 推断 vendorId；已知标记包括 intel-arc-jitter、mobile-depth-precision、safari-texture-limit。
- 动态图集使用 `TextureManager.addToAtlas(atlasId, imageData, padding?)`；内置 icons、glyphs、patterns；填充图案通过视口/世界空间 UV 控制缩放密度。
- SurfaceConfig 必须区分 canvas、devicePixelRatio、CSS 尺寸、物理尺寸、format、alphaMode 和 sampleCount（1 或 4）。
- 近深度为 1、远深度为 0；3D 使用对数深度及 `perspectiveReversedZInfinite()`，2D 使用正交与 Reversed-Z。
- FrameGraphBuilder 生命周期为 begin → 按需添加 FrustumCull、DepthSort、LabelCollision、SceneRender、PostProcess、Screen、Picking Pass → build；明确投影分组、Pass ID、输入及依赖，输出 CompiledRenderGraph。
- PickingEngine 使用 Color-ID 像素拾取，`pickAt(x, y)` 返回 `Promise<PickResult | null>`，异步延迟一帧；支持 readDepthAt、unprojectScreenToWorld 及基于射线/椭球相交的 screenToGeodetic。
- 内置 Compute 任务为 frustum-cull、depth-sort（并行 Radix Sort）、label-collision、point-cluster（空间哈希）、terrain-tessellation。
- Pipeline 使用 `getOrCreateAsync()` 异步编译，`warmup()` 预热；材质首次使用前预编译，不能阻塞帧循环。
- EngineConfig 覆盖 devicePixelRatio（数字或 auto）、maxPixelRatio（默认 2）、sampleCount、GPU 预算（512 MB）、CPU 预算（1 GB）、tileCacheSize（512）、workerCount（数字或 auto）、maxConcurrentRequests（6）、useLogarithmicDepth、useReversedZ、requestRenderMode、targetFrameRate（60）、backgroundThrottleMs（1000）、logLevel（debug/info/warn/error/none）。

### Shader 模块与内存布局

- 标准模块签名：`projectPosition(worldPos: vec3<f32>) -> vec4<f32>`、`processVertex(input: VertexInput) -> VertexOutput`、`computeColor(input: FragmentInput) -> vec4<f32>`。
- 九个 Hook：vertex_position_before_projection、vertex_position_after_projection、vertex_output_custom、fragment_color_before_style、fragment_color_after_style、fragment_discard、fragment_alpha、compute_visibility、compute_sort_key。
- BindGroup 固定分配：group(0) 每帧相机/视口/时间；group(1) 每图层样式/投影；group(2) 每 draw 的位置/颜色；group(3) 纹理/采样器/用户数据。
- Uniform 对齐：标量 4 字节，vec2 8 字节，vec3/vec4 对齐 16 字节；mat3x3 占 48 字节，mat4x4 占 64 字节；struct 总大小向最大对齐值取整。必须区分 vec3 的 12 字节分量大小与 16 字节对齐，按实际字段布局计算偏移，不能紧密打包后直接上传。
- 顶点输入包含 position、normal、uv、color，输出包含 clipPosition、worldPosition、normal、uv、color；帧 Uniform 包含视图/投影/VP 矩阵、相机位置、视口、时间和 zoom。
- ShaderAssembler 完整注入投影、几何、样式、特性模块及 Hook；模板占位符只能作为组装机制，最终 WGSL 必须完整可编译，不能把模板骨架当成功能实现。
- 墨卡托顶点使用 `frame.vpMatrix * vec4<f32>(worldPos, 1.0)`；Split-Double 相对坐标按 `(high - centerHigh) + (low - centerLow)` 重建；线抗锯齿使用 SDF 与 smoothstep。

## 8. L3 调度、相机与视图过渡

- CameraController 提供 type（2d/25d/3d）、state、isAnimating、inertiaEnabled、constraints，以及 setCenter/setZoom/setBearing/setPitch、jumpTo/flyTo/easeTo/stop、setConstraints/setInertiaEnabled、update(deltaTime, viewport)、handlePanStart/Move/End、handleZoom、handleRotate、onMoveStart/Move/End 和 destroy；事件订阅返回取消函数。
- CameraConstraints 包含 minZoom/maxZoom、minPitch/maxPitch 和可选 maxBounds。jumpTo 设置中心/缩放/方向/俯仰，flyTo 增加 altitude/duration/easing，easeTo 支持 duration；动画返回完整的 CameraAnimation。
- Camera2D 使用 mat4.ortho，bearing/pitch 固定 0；惯性采样最近 5 帧速度并指数衰减；flyTo 在 zoom/center 空间使用 Bezier 插值。
- Camera25D 使用 perspectiveReversedZ；bearing/pitch 可变且遵守 maxPitch；pan/rotate/pitch 惯性独立衰减；高 pitch 自动调整 far plane。
- Camera3D 使用 ECEF、perspectiveReversedZInfinite、四元数旋转；异步查询 DEM 并平滑处理地形碰撞；惯性使用四元数 slerp 衰减；flyTo 使用 Great Circle Arc 与高度抛物线；补齐 setPosition(lon,lat,alt)、lookAt、queryTerrainHeight、setTerrainCollisionEnabled。
- ViewMorph 的 `morphTo(targetMode, fromCamera, toCamera, options)` 返回 ViewMorphAnimation；2D→25D 插值 pitch 和正交/透视投影；2D→3D 分为 pitch 升起、墨卡托→ECEF 顶点变形及投影混合两阶段；过渡期双相机同时计算，RenderGraph 使用混合矩阵。
- TileScheduler 提供 update、registerSource/unregisterSource、getVisibleTiles、onTileLoaded/onTileError、reloadAll、clearCache；跨模块通知仍走 InternalBus。
- TileScheduleResult 包含按优先级排序的 toLoad、toUnload、visible 和缺失瓦片替代映射 placeholder；SSE 驱动 LOD，高 pitch 时降低远处优先级，未加载子瓦片由父瓦片替代。
- FrameScheduler 严格区分 UPDATE、RENDER、POST_FRAME、IDLE；`hasBudget()` 检查剩余帧预算；Page Visibility 控制后台降频；requestRenderMode 仅在变化时渲染。

## 9. L4 场景、图层、样式与标注

- L2/L4 使用统一 Layer 契约：id/type/source/projection、visible/opacity/zIndex、isTransparent/renderOrder/isLoaded，以及 onAdd/onRemove/onUpdate/encode、可选 encodePicking、paint/layout 属性读写、可选数据读写、要素查询与要素状态读写。
- Layer 的 encode 接收 GPURenderPassEncoder 和 CameraState；图层通过 LayerContext 获取服务，必须完成注册、更新、移除与资源释放。
- StyleEngine 提供 compile、compileFilter、evaluate；CompiledStyle 包含 wgslCode、uniformValues、isConstant、dependsOnZoom、dependsOnFeature 和 requiredAttributes。
- L0 StyleExpression 经 StyleEngine.compile 编译成 WGSL；常量样式编译时求值并写入 Uniform，属性依赖样式在 GPU 实时求值，zoom 插值保持正确的 clamp/mix 行为。
- RasterTileLayer 完成瓦片加载、解码、GPU 纹理、clamp + texel 内缩 + 1 px 重叠接缝处理，以及亮度/对比度/饱和度。
- VectorTileLayer 完成 MVT → Worker earcut/宽线条带 → GPU → SDF 抗锯齿，并提供要素查询。
- GeoJSONLayer 完成 fetch → Worker 自研 geojson-vt 切片/Supercluster 聚合 → 按瓦片获取数据 → GPU，支持 setData/getCluster 系列 API。
- TerrainLayer 完成 DEM → Worker 三角网/法线/裙边 → GPU，处理 LOD 边缘约束与 Morphing，提供 getElevation/setExaggeration。
- GlobeRenderer 使用真实椭球、大气 Rayleigh + Mie + LUT、星空及 CSM + PCF 阴影，提供 setSunPosition/setSunFromDateTime。
- LabelManager 使用 CPU R-Tree 粗筛 + GPU Compute 精筛，支持 point/line/line-center 放置、crossSourceCollisions 和淡入淡出。
- GlyphManager 使用 MSDF，按 Unicode Block 加载字形，文字 Shaping 在 Worker 中执行。
- Worker 的 16 类任务：mvt-decode、raster-decode、geojson-parse、triangulate、simplify、rtree-build、rtree-query、label-collision、text-shaping、split-double、terrain-mesh、tiles3d-bvh、antimeridian-cut、cluster、boolean-op、custom。

## 10. L5 扩展契约

| 扩展点 | 接口 | 注册方法 |
| --- | --- | --- |
| EP1 | CustomLayer | registerLayer(id, factory, meta?) |
| EP2 | ProjectionModule | registerProjection(id, module, meta?) |
| EP3 | DataSource | registerSource(id, factory, meta?) |
| EP4 | ShaderHookDefinition | registerShaderHook(id, hook, meta?) |
| EP5 | PostProcessPass | registerPostProcess(id, factory, meta?) |
| EP6 | InteractionTool | registerInteraction(id, factory, meta?) |

- 扩展只通过 Context 访问引擎，所有回调由 safeExecute 隔离；连续 5 次错误自动禁用并允许手动重新启用；stable 契约不能随意 breaking change。
- CustomLayerContext 提供 device、format、depthFormat、sampleCount、bufferPool、textureManager、uploader、bindGroupCache、shaderAssembler、pipelineCache、depthManager、blendPresets、precision、只读 camera/viewport、pixelRatio、frameIndex、elapsedTime。注入 device 不代表允许绕开 L1 资源管理。
- ShaderHookDefinition 包含 hookPoint、wgslCode，以及可选 priority（数值越大越先执行）、dependencies、extraUniforms、extraVaryings、enableCondition；遵守九个标准 Hook。
- PostProcessPass 必须实现 setup、destroy、onResize、execute、setUniform、setEnabled；execute 接收 GPUCommandEncoder、inputColor、inputDepth、outputColor，由 Pass 内部创建 RenderPassEncoder，不得把参数改成 GPURenderPassEncoder。
- InteractionTool 消费顺序为 activeTool → defaultTools → map default；返回 true 表示已消费并停止冒泡；renderOverlay 经 OverlayRenderer 的 drawLine/drawPolygon/drawCircle/drawMarker/drawText/update/remove 绘制辅助图形。
- OGC 数据源通过 EP3 实现：WMTS GetTile、WMS GetMap、WFS GetFeature、PMTiles HTTP Range Request；SourceContext 注入 requestScheduler、workerPool、resourceManager。

## 11. L6 预设 API

- 预设只组装 L0～L5，不添加新的底层业务逻辑；合理默认值保证开箱即用，模块可以逐步替换；公开 renderer、scene、scheduler、extensions、camera、config getter。
- Map2D 视图 API：getCenter/setCenter/getZoom/setZoom/flyTo/easeTo/jumpTo/fitBounds/stop；图层 API：addSource/addLayer/removeLayer/moveLayer/setLayoutProperty/setPaintProperty/setFilter。
- Map2D 查询：queryRenderedFeatures 返回 `Promise<Feature[]>`，querySourceFeatures 同步；状态：setFeatureState/getFeatureState；事件：on(type, callback)、on(type, layerId, callback)、once、off；坐标：project/unproject。
- Controls 通过 addControl(control, position) 接入，覆盖 NavigationControl、ScaleControl、AttributionControl、GeolocateControl、FullscreenControl。
- Map25D extends Map2D，增加 getPitch/setPitch/getBearing/setBearing/rotateTo/resetNorth/setLight。
- Globe3D 的 getCameraPosition 返回 lon/lat/alt/bearing/pitch/roll；flyTo 接收 destination、orientation（bearing/pitch/roll）、duration；支持 addImageryLayer/add3DTileset/addGeoJSON/addEntity、setTerrainExaggeration/getTerrainHeight、setAtmosphereEnabled/setShadowsEnabled/setSkyboxEnabled、setDateTime/setClockMultiplier、cartographicToScreen/screenToCartographic、morphTo2D/morphTo25D/morphTo3D。
- MapFull extends Map25D，整合全部能力，提供 `setMode('2d'|'25d'|'3d', { duration? })`。
- 初始化按 createCanvas → L0～L5 → 加载样式 → 设置初始视图 → 默认 Controls → FrameScheduler.start() → emit('load') 完成，不得在依赖与资源未就绪时提前报告加载成功。

## 12. 验证与交付

以 `package.json` 中实际脚本为准，按改动范围执行必要检查；每个小改动通过适用验证后立即提交。

| 验证场景 | 命令或要求 |
| --- | --- |
| 所有提交 | 检查 diff、暂存内容及 `git diff --check`，确认没有无关文件或省略实现 |
| TypeScript 变更 | `npx tsc --noEmit` |
| 功能与回归测试 | `npm test -- <相关测试文件>`；影响公共链路或多个模块时执行 `npm test` |
| 依赖、包边界或导出变化 | `npm run check:deps` |
| 构建、资源、公共入口或集成变化 | `npm run build` |
| Tree-Shaking 或包体积变化 | `npm run check:bundle` |
| 开发运行与实际渲染验证 | `npm run dev`，在支持 WebGPU 的环境验证相关模式及交互 |
| 纯文档变更 | 核对规则覆盖、链接和命令有效性、Markdown 结构及差异，无须为文档改动新增实现镜像测试 |

- GPU、地形、相机、Shader 和交互变更需要实际渲染/操作验证；静态类型检查通过不能代替画面正确、交互完整、资源释放及错误恢复验证。
- 新增或修改算法使用可独立验证的结果、边界条件与守恒性质；测试必须检验行为，不能简单复制实现作为期望值。
- 既有检查失败应记录来源并与本次回归区分；工具、环境或设备导致无法完成的验证必须明确标为未验证，不能记为通过。
- 交付前逐项核对用户需求、所有实现与接入、类型/注释、错误/边界处理、验证结果及提交记录。只有全部完成后才能报告任务完成。
