# GIS-Forge 架构设计审计报告 — 需求覆盖度 + 缺口分析

> **审计范围**：L0~L6 共 7 份接口设计文档 + 算法补充文档 + 完整设计文档
> **对照基准**：5 项设计约束、34 个工程问题、130+ 算法需求、引擎包分割计划
> **审计结论**：核心框架完备，但存在 **7 类结构性缺口** 和 **12 项不一致**

---

## 一、34 个工程问题覆盖验证

逐项检查每个问题在 L0~L6 接口文件中是否有**具体的接口方法**承接（不是仅在概要设计中提及，而是在某个模块的 TypeScript 接口中有对应的函数签名）。

| # | 问题 | 接口覆盖 | 状态 | 说明 |
|---|------|---------|------|------|
| 3.1 | 浮点抖动 | L0/precision ✓ L1/GPUUploader.uploadDoublePrecisionPositions ✓ | ✅ 完整 | |
| 3.2 | Z-Fighting | L2/DepthManager ✓ L0/mat4.perspectiveReversedZ ✓ | ✅ 完整 | |
| 3.3 | GPU 驱动差异 | L1/DeviceManager.needsWorkaround ✓ | ✅ 完整 | |
| 4.1 | 瓦片接缝 | ⚠️ | ⚠️ 无接口 | 归属 layer-tile-raster，但该包未定义接口 |
| 4.2 | LOD 裂缝 | ⚠️ | ⚠️ 无接口 | 归属 layer-terrain，但该包未定义接口 |
| 4.3 | 瓦片调度 | L3/TileScheduler ✓ L3/RequestScheduler ✓ | ✅ 完整 | |
| 4.4 | 过缩放 | L3/TileScheduler.config.overzoomLevels ✓ | ✅ 完整 | |
| 5.1 | 三角剖分 | L0/earcut ✓ L2/StencilManager.polygonMask ✓ L3/WorkerPool ✓ | ✅ 完整 | |
| 5.2 | 宽线渲染 | L2/ComputePassManager.builtinShaders 提及 ⚠️ | ⚠️ 弱覆盖 | 无专门的宽线生成接口，仅在 L2 Compute 中提及 |
| 5.3 | 日期线 | L4/AntiMeridianHandler ✓ | ✅ 完整 | |
| 5.4 | 跨瓦片要素 | L4/FeatureStateManager ✓ | ✅ 完整 | |
| 6.1 | 标注碰撞 | L4/LabelManager ✓ L2/ComputePassManager.createLabelCollisionTask ✓ | ✅ 完整 | |
| 6.2 | 沿线标注 | L4/LabelManager.resolve 提及 ⚠️ | ⚠️ 弱覆盖 | LabelManager 有 resolve()，但未定义沿线放置的具体接口 |
| 6.3 | 文字渲染 | L4/GlyphManager ✓ | ✅ 完整 | |
| 6.4 | 字形加载 | L4/GlyphManager.loadRange/loadBlock ✓ | ✅ 完整 | |
| 7.1 | 地形碰撞 | ❌ | ❌ 未覆盖 | 归属 camera-3d，但 **CameraController 未定义接口** |
| 7.2 | 惯性动画 | ❌ | ❌ 未覆盖 | 归属 camera-2d/25d/3d，同上 |
| 7.3 | 视图过渡 | ❌ | ❌ 未覆盖 | 归属 view-morph，**该包未定义接口** |
| 8.1 | 大气散射 | ❌ | ❌ 未覆盖 | 归属 globe 包，**该包未定义接口** |
| 8.2 | 3DTiles | ❌ | ❌ 未覆盖 | 归属 layer-3dtiles，**该包未定义接口** |
| 8.3 | 地形叠加 | L2/StencilManager.terrainDrape ✓ 但 layer-terrain ❌ | ⚠️ 半覆盖 | 模板操作有，但地形图层接口未定义 |
| 8.4 | 阴影 | ❌ | ❌ 未覆盖 | 归属 postprocess-shadow，**该包未定义接口** |
| 9.1 | 内存泄漏 | L1/GPUMemoryTracker ✓ L3/MemoryBudget ✓ L3/ResourceManager ✓ | ✅ 完整 | |
| 9.2 | Draw Call | L1/IndirectDrawManager ✓ L2/ComputePassManager.createFrustumCullTask ✓ | ✅ 完整 | |
| 9.3 | 大 GeoJSON | L3/WorkerPool('geojson-parse') ✓ | ✅ 完整 | |
| 9.4 | Shader 编译 | L2/PipelineCache ✓ | ✅ 完整 | |
| 10.1 | 线抗锯齿 | L2/ShaderAssembler 模块 'sdf_line' 提及 ⚠️ | ⚠️ 弱覆盖 | SDF 在 L2 初始化中注册为内置 feature，但无具体接口 |
| 10.2 | 填充图案 | L1/TextureManager.DynamicAtlas ✓ | ✅ 完整 | |
| 10.3 | 数据驱动样式 | L4/StyleEngine ✓ | ✅ 完整 | |
| 11.1 | 移动端 | ❌ | ❌ 未覆盖 | 归属 compat-mobile，**该包未定义接口** |
| 11.2 | HiDPI | L1/SurfaceManager ✓ | ✅ 完整 | |
| 11.3 | Worker | L3/WorkerPool ✓ | ✅ 完整 | |
| 12.1 | CRS 多样性 | L0/coordinate ✓ L5/EP2 ProjectionModule ✓ | ✅ 完整 | |
| 12.2 | OGC 协议 | L5/EP3 DataSource ✓ | ✅ 完整 | |

### 统计

| 状态 | 数量 | 占比 |
|------|------|------|
| ✅ 完整覆盖 | 22 | 64.7% |
| ⚠️ 弱覆盖/半覆盖 | 5 | 14.7% |
| ❌ 未覆盖 | 7 | 20.6% |

---

## 二、5 项设计约束验证

| # | 约束 | 状态 | 证据 | 缺口 |
|---|------|------|------|------|
| 1 | 一个引擎，所有维度 | ✅ | L4/SceneGraph 多投影子树 + L2/Compositor 合成 | — |
| 2 | Tree-Shakable 按维度打包 | ⚠️ | L6 预设包设计正确，但 **29 个可选功能包无接口定义** | 不知道哪些模块可以被 shake 掉 |
| 3 | 同场景 2D/2.5D/3D 共存 | ✅ | L2/RenderGraph 按投影分组 + Compositor 深度合成 | — |
| 4 | 纯 WebGPU | ✅ | L1 全部基于 WebGPU API，无 WebGL 回退 | — |
| 5 | Three.js 级扩展 | ✅ | L5 六个扩展点 + ExtensionLifecycle 错误隔离 | — |

---

## 三、7 类结构性缺口

### 缺口 1：CameraController 未定义（严重）

**影响**：问题 #7.1（地形碰撞）、#7.2（惯性动画）、L6 所有预设类的 `get camera()` 返回类型。

**现状**：
- L3 定义了 `CameraState`（只读快照），但 `CameraController`（控制输入、动画、约束）从未定义
- L6/Map2D 暴露 `get camera(): CameraController`，但 `CameraController` 接口不存在
- 设计中提到 camera-2d / camera-25d / camera-3d 三个可选包，但无任何接口

**需要定义**：
- `CameraController` 接口（setCenter/setZoom/setPitch/setBearing/flyTo/easeTo/update/getState）
- `Camera2D` 实现规格（正交投影、惯性动画、边界约束）
- `Camera25D` 实现规格（透视投影、pitch/bearing、倾斜约束）
- `Camera3D` 实现规格（轨道相机、地形碰撞、高度约束、ECEF 坐标系）
- `ViewMorph` 接口（2D↔25D↔3D 投影矩阵插值动画）

### 缺口 2：可选功能包无接口（严重）

**影响**：29 个可选包在完整设计文档中列出了名称和体积估算，但在 L0~L6 的接口设计中**没有任何一个**被定义。

**缺失的包及其关键接口**：

| 包名 | 需要的接口 | 解决的问题 |
|------|----------|----------|
| **layer-tile-raster** | RasterTileLayer（瓦片请求/解码/GPU纹理上传/裙边/接缝处理）| #4.1 |
| **layer-tile-vector** | VectorTileLayer（MVT解码/三角剖分/宽线生成/样式求值）| #5.1 #5.2 |
| **layer-geojson** | GeoJSONLayer（解析/geojson-vt切片/动态更新）| #9.3 |
| **layer-terrain** | TerrainLayer（DEM请求/网格生成/LOD拼接/裙边/贴合）| #4.2 #8.3 |
| **layer-3dtiles** | Tiles3DLayer（BVH遍历/SSE LOD/glTF解析/内存预算）| #8.2 |
| **layer-heatmap** | HeatmapLayer（核密度估计/颜色映射）| — |
| **layer-pointcloud** | PointCloudLayer（点云LOD/Eye-Dome Lighting）| — |
| **layer-marker** | MarkerLayer（图标/标注/聚合）| — |
| **layer-extrusion** | ExtrusionLayer（多边形拉伸/光照/阴影）| — |
| **globe** | GlobeRenderer（椭球体网格/大气散射/星空/阴影）| #8.1 #8.4 |
| **view-morph** | ViewMorph（投影矩阵插值/顶点位置插值/动画）| #7.3 |
| **compat-mobile** | MobileOptimizer（降质策略/激进LOD/powerPreference）| #11.1 |
| **compat-hidpi** | HiDPIAdapter（DPR检测/动态分辨率）| #11.2（L1 已部分覆盖）|
| **postprocess-shadow** | ShadowPass（CSM/PCF/光源管理）| #8.4 |
| **postprocess-bloom** | BloomPass | — |
| **postprocess-ssao** | SSAOPass | — |
| **interaction-draw** | DrawTool（点/线/面绘制）| — |
| **interaction-measure** | MeasureTool（距离/面积测量）| — |
| **interaction-select** | SelectTool（框选/点选）| — |
| **source-wmts/wms/wfs/pmtiles** | OGC/PMTiles 数据源实现 | #12.2 |
| **proj-mercator/globe/perspective** | 内置投影模块实现 | — |

### 缺口 3：WGSL Shader 模板未定义

**影响**：L2/ShaderAssembler 定义了模块注册/组装/Hook 注入机制，但**实际的 WGSL 代码模板从未给出**。

**需要定义**：
- 顶点着色器模板（带 Hook 插入点的骨架代码）
- 片元着色器模板（带 Hook 插入点的骨架代码）
- 投影模块示例（mercator 投影的完整 WGSL `fn projectPosition`）
- 几何模块示例（polygon 几何的完整 WGSL `fn processVertex`）
- 样式模块示例（fill_solid 样式的完整 WGSL `fn computeColor`）
- Split-Double 重建代码（WGSL 中 `relativeHigh + relativeLow` 的实现）
- 对数深度代码（DepthManager.logDepthVertexCode 的内容）

### 缺口 4：端到端数据流未定义

**影响**：无法验证从 `map.addLayer({type:'vector', source:'...'})` 到 GPU 像素输出的完整路径是否可行。

**需要定义的数据流**：
1. `map.addLayer()` → L4/LayerManager.addLayer() → L4/SourceManager.addSource()
2. → L3/TileScheduler.registerSource() → L3/RequestScheduler.schedule(tileUrl)
3. → 网络响应 → L3/WorkerPool.submit('mvt-decode', buffer) → Worker 解码
4. → Worker 返回 vertices/indices (Transferable) → L1/GPUUploader.uploadFromTransferable()
5. → L1/BufferPool.acquire(VERTEX) → GPU Buffer ready
6. → L2/ShaderAssembler.assemble({projection:'mercator', geometry:'polygon', style:'fill_solid'})
7. → L2/PipelineCache.getOrCreateAsync(pipelineDesc)
8. → L3/FrameScheduler 触发渲染帧 → L2/FrameGraphBuilder.addSceneRenderPass()
9. → L4/Layer.encode(encoder, camera) → GPU draw call → 像素

### 缺口 5：StyleSpec 未定义

**影响**：L6/Map2D 接受 `style?: string | StyleSpec` 作为构造参数，L4/StyleEngine 编译样式表达式到 WGSL，但 `StyleSpec` 的完整结构从未定义。

**需要定义**：
- StyleSpec 顶层结构（version/name/sources/layers/glyphs/sprite/metadata）
- 与 MapLibre Style Spec 的兼容策略（完全兼容 vs 超集 vs 独立规范）
- FilterExpression 语法
- 样式表达式类型（Property expressions / Zoom expressions / Data expressions）

### 缺口 6：事件系统从 DOM 到图层的完整链路未定义

**影响**：L6/Map2D.on('click', layerId, callback) 需要从 DOM PointerEvent → 坐标转换 → Picking → 要素查询 → 回调的完整链路。

**现状**：
- L0/EventBus 是通用发布订阅
- L1/SurfaceManager 有坐标转换
- L2/PickingEngine 有像素拾取
- L4/SpatialQuery 有空间查询
- L5/InteractionManager 有事件分发
- 但这些模块之间的**事件流转编排**没有定义

**需要定义**：
- DOM 事件监听注册（canvas.addEventListener 在哪个模块中）
- PointerEvent → MapPointerEvent 转换（谁调用 SurfaceManager.cssToNDC + PickingEngine.pickAt）
- 图层级事件过滤（`on('click', layerId, cb)` 如何匹配到具体图层）
- 事件冒泡/捕获顺序

### 缺口 7：最小可行原型未定义

**影响**：无法验证架构是否可以用最少代码运行起来。

**需要定义**：
- 渲染一个墨卡托栅格瓦片所需的最小模块集
- 初始化代码示例（从 `navigator.gpu.requestAdapter` 到第一个瓦片显示）
- 验证 L0→L1→L2→L3→L4 的初始化链路是否通畅

---

## 四、12 项跨层不一致

| # | 不一致 | 涉及文件 | 说明 |
|---|--------|---------|------|
| 1 | **RenderableLayer vs Layer** | L2 vs L4 | L2/FrameGraphBuilder 引用 `RenderableLayer` 接口，L4 定义的是 `Layer` 接口。字段名和方法签名不同（`isTransparent` 位置不同）。 |
| 2 | **WorkerPool 任务类型数量** | L3 | 概要设计说"12 种"，L3 接口定义中 `WorkerTaskType` 列出了 16 种。 |
| 3 | **CameraState 定义位置** | L3 vs L6 | L3 定义了 `CameraState`，但 L6/Globe3D.getCameraPosition() 返回的字段（heading/pitch/roll）与 L3/CameraState 的字段（bearing/pitch）不一致。 |
| 4 | **Feature 类型未定义** | 全局 | `Feature` 类型在 L4/SpatialQuery、L5/MapPointerEvent、L6/queryRenderedFeatures 中被引用，但**从未在任何文件中定义 Feature 接口**。 |
| 5 | **BBox2D 定义位置冲突** | L0 vs L3 | L0/bbox.ts 定义了 `BBox2D`（west/south/east/north），但 L3/TileScheduler 和 L5/DataSource 也使用 `BBox2D`，未明确是否是同一类型。 |
| 6 | **PickResult 定义重复** | L2 vs L5 | L2/PickingEngine 定义了 `PickResult`，L5/CustomLayer 也引用 `PickResult`，L2 的版本后来又补充了 depth/worldPosition/normal 字段，两处是否同步未明确。 |
| 7 | **Viewport 定义位置** | L3 vs L2 | L3 定义了 `Viewport` 接口，L2/FrameGraphBuilder 也引用 `Viewport`，但未说明是同一个。 |
| 8 | **SurfaceConfig.sampleCount** | L1 vs L5 | L1/SurfaceConfig 没有 `sampleCount` 字段，但 L5/CustomLayerContext 引用 `sampleCount: l1.surface.config.sampleCount`。 |
| 9 | **ExtensionType 枚举不完整** | L5 | `ExtensionType = 'layer' | 'projection' | 'source' | 'shaderHook' | 'postProcess' | 'interaction'`，但 Registry 有 `registerShaderHook(hook)` 不接受 id 参数（与其他 EP 的 `register(id, factory)` 签名不一致）。 |
| 10 | **PostProcessPass.execute 签名** | L5 | L5 定义 execute 接收 `GPUCommandEncoder`，但 L2/RenderGraph 中后处理 Pass 应该收到 `GPURenderPassEncoder`。两者不同。 |
| 11 | **Map2D.queryRenderedFeatures 返回类型** | L6 vs L2 | L6 声明返回 `PickResult[]`（同步），但 L2/PickingEngine.pickAt 返回 `Promise<PickResult>`（异步）。L6 不可能同步返回异步 picking 结果。 |
| 12 | **Supercluster 位置** | L0 vs L4 | L0/algorithm/cluster.ts 定义了 `Supercluster`，L4 中没有引用它。实际上 Supercluster 在 MapLibre 中由 SourceManager 在数据源层面使用，但这个衔接关系在接口中未体现。 |

---

## 五、模块数量审计

| 层 | 概要设计模块数 | 接口设计模块数 | 差异 |
|---|-------------|-------------|------|
| L0 | 24 + 12 补充 = 36 | 24（接口完整）+ 12（仅函数签名） | ✅ 匹配 |
| L1 | 5 → 8 | 8 | ✅ 匹配 |
| L2 | 8 → 11 + FrameGraphBuilder | 11 + 1 构建器 | ✅ 匹配 |
| L3 | 7 | 7 | ✅ 匹配 |
| L4 | 11 | 11 | ✅ 匹配 |
| L5 | 7 | 8（+ExtensionLifecycle）| ✅ 更完善 |
| L6 | 4 预设 | 4 预设 + 5 Controls | ✅ 匹配 |
| **可选功能包** | **29** | **0** | ❌ **全部缺失** |

---

## 六、公共方法总计

| 层 | 模块数 | 方法数 |
|---|--------|--------|
| L0 | 36 | ~135（算法）+ ~30（基础设施）= ~165 |
| L1 | 8 | 56 |
| L2 | 12 | 98 |
| L3 | 7 | 61 |
| L4 | 11 | 90 |
| L5 | 8 | 32 + 20 接口定义 |
| L6 | 4 + 5 | 108 |
| **合计** | **91 核心模块** | **~630 公共方法** |
| 可选功能包（缺失） | 29 | 未知 |

---

## 七、优先级排序的行动项

### P0 — 必须在编码前完成

| # | 行动项 | 预估工作量 | 理由 |
|---|--------|----------|------|
| 1 | **定义 CameraController 接口** + camera-2d/25d/3d 三个实现规格 | 大 | 影响 7 个问题覆盖 + L6 所有预设的 camera 逃生舱口 |
| 2 | **定义核心图层包接口**（layer-tile-raster, layer-tile-vector, layer-geojson, layer-terrain）| 大 | 这 4 个图层是引擎最基本的功能，无它们引擎不可用 |
| 3 | **定义 Feature / GeoJSON 类型** | 小 | 全局引用但从未定义，缺失导致所有接口不可编译 |
| 4 | **修复 12 项跨层不一致** | 中 | 接口矛盾将导致实现时无法对接 |
| 5 | **定义端到端数据流** | 中 | 验证架构可行性 |

### P1 — 编码前完成最佳，可在 V1.0 开发中并行

| # | 行动项 | 预估工作量 |
|---|--------|----------|
| 6 | 定义 globe 包接口（椭球体网格/大气/星空）| 中 |
| 7 | 定义 view-morph 包接口 | 小 |
| 8 | 定义 layer-3dtiles 包接口 | 大 |
| 9 | 定义 StyleSpec 结构 | 中 |
| 10 | 定义 WGSL Shader 模板骨架 | 中 |
| 11 | 定义事件系统完整链路 | 中 |

### P2 — V1.0 后

| # | 行动项 |
|---|--------|
| 12 | 定义 layer-heatmap / layer-pointcloud / layer-extrusion 接口 |
| 13 | 定义 compat-mobile 接口 |
| 14 | 定义 postprocess-bloom / ssao / shadow 接口 |
| 15 | 定义 interaction-draw / measure / select 接口 |
| 16 | 定义 source-wmts / wms / wfs / pmtiles 接口 |
| 17 | 定义最小可行原型代码 |

---

## 八、总体评估

**架构骨架完备**：L0~L6 七层的模块划分、职责边界、初始化顺序、帧循环、跨层对接关系都已清晰定义。91 个核心模块、630+ 个公共方法为实现提供了足够细致的蓝图。

**核心框架可实现**：L0 数学库（零依赖/双精度/out 参数/WGSL 对齐）→ L1 GPU 资源管理（StagingRing/Atlas/MemoryTracker）→ L2 渲染管线（ShaderAssembler/RenderGraph/Compositor）→ L3 调度（FrameScheduler/TileScheduler/WorkerPool）→ L4 场景语义（LayerManager/StyleEngine/LabelManager）→ L5 扩展（6 个 EP + 错误隔离）→ L6 预设（Map2D/Globe3D），这条链路的接口定义已经足够开始编码。

**关键缺口在"血肉"而非"骨架"**：现有设计定义了框架的骨架（如何组装模块、如何管理资源、如何调度任务），但引擎真正"做事"的部分——CameraController（怎么操控视角）、具体图层实现（怎么渲染一个瓦片）、WGSL Shader（GPU 执行什么代码）——还未定义。这类似于定义了 React 的 Reconciler 但还没有写任何 Component。

**建议的下一步**：先完成 P0 的 5 个行动项（CameraController + 4 个核心图层 + Feature 类型 + 不一致修复 + 数据流），然后就可以开始编码最小可行原型。
