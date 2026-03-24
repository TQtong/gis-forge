# GeoForge 完整项目目录结构

> 基于 L0~L6 v2.1 架构文档生成，覆盖全部 91 个核心模块 + 29 个可选功能包。
> 每个文件标注所属架构层和职责。

---

```
geoforge/
├── .cursor/
│   └── rules/
│       ├── core.mdc                           # AI 全局规则（alwaysApply）
│       ├── math-coding.mdc                    # 数学/算法规则
│       ├── shared-types.mdc                   # 共享类型规则
│       ├── shader-wgsl.mdc                    # WGSL 规则
│       ├── gpu-rendering.mdc                  # GPU/渲染规则
│       ├── scene-layers.mdc                   # 场景/图层规则
│       ├── camera-runtime.mdc                 # 相机/调度规则
│       ├── extensions.mdc                     # 扩展层规则
│       └── presets.mdc                        # 预设层规则
│
├── package.json                               # Monorepo 根配置
├── pnpm-workspace.yaml                        # pnpm workspace
├── tsconfig.base.json                         # 共享 TypeScript 配置
├── vitest.config.ts                           # 共享测试配置
├── rollup.config.ts                           # 共享构建配置
├── LICENSE
├── README.md
│
├── packages/
│   │
│   │  ════════════════════════════════════════
│   │  L0 基础层 — @geoforge/core (~20KB gz)
│   │  ════════════════════════════════════════
│   │
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── src/
│   │   │   ├── index.ts                       # 包入口，re-export 全部公共 API
│   │   │   │
│   │   │   ├── math/
│   │   │   │   ├── index.ts                   # math 子模块入口
│   │   │   │   ├── vec2.ts                    # 2D 向量 Float32（create/add/sub/scale/dot/length/normalize/lerp/distance/rotate）
│   │   │   │   ├── vec2d.ts                   # 2D 向量 Float64
│   │   │   │   ├── vec3.ts                    # 3D 向量 Float32（create/add/sub/scale/dot/cross/length/normalize/lerp/transformMat4/transformQuat）
│   │   │   │   ├── vec3d.ts                   # 3D 向量 Float64
│   │   │   │   ├── vec4.ts                    # 4D 向量 Float32（齐次坐标运算）
│   │   │   │   ├── vec4d.ts                   # 4D 向量 Float64
│   │   │   │   ├── mat3.ts                    # 3x3 矩阵 Float32（法线变换、2D 仿射、fromMat4）
│   │   │   │   ├── mat4.ts                    # 4x4 矩阵 Float32（multiply/invert/transpose/perspective/perspectiveReversedZ/perspectiveReversedZInfinite/ortho/lookAt/translate/rotate/scale/fromRotationTranslation）
│   │   │   │   ├── mat4d.ts                   # 4x4 矩阵 Float64
│   │   │   │   ├── quat.ts                    # 四元数 Float32（create/identity/fromEuler/fromAxisAngle/multiply/slerp/normalize/conjugate/rotateVec3）
│   │   │   │   ├── bbox.ts                    # BBox2D/BBox3D（create/union/intersect/contains/expand/center/size/fromPoints）
│   │   │   │   ├── frustum.ts                 # 视锥体（extractPlanes/intersectsBBox/intersectsSphere/containsPoint，6 平面）
│   │   │   │   ├── interpolate.ts             # 插值函数（linear/smoothstep/hermite/bezierCubic/catmullRom/springDamper）
│   │   │   │   └── trigonometry.ts            # 三角工具（degToRad/radToDeg/normalizeAngle/angleDiff/wrapLongitude）
│   │   │   │
│   │   │   ├── geo/
│   │   │   │   ├── index.ts
│   │   │   │   ├── ellipsoid.ts               # WGS84 椭球体（geodeticToECEF/ecefToGeodetic[Bowring]/surfaceNormal/scaleToGeodeticSurface）
│   │   │   │   ├── mercator.ts                # 墨卡托（lngLatToMerc/mercToLngLat/tileToLngLat/lngLatToTile/tileToPixel/pixelToTile/groundResolution/mapSize）
│   │   │   │   ├── geodesic.ts                # 大地测量（vincentyInverse/vincentyDirect/haversineDistance/initialBearing/finalBearing/midpoint/destination/intermediatePoint/nearestPointOnLine）
│   │   │   │   ├── measure.ts                 # 几何度量（area/length/centroid/polylabel/minBoundingCircle/pointToLineDistance/perimeter）
│   │   │   │   └── projection-math.ts         # 投影数学（utmForward/utmInverse/lambertForward/lambertInverse/gcj02ToWgs84/wgs84ToGcj02/bd09ToGcj02/gcj02ToBd09/helmert7）
│   │   │   │
│   │   │   ├── algorithm/
│   │   │   │   ├── index.ts
│   │   │   │   ├── earcut.ts                  # 带洞多边形三角剖分（earcut/flatten/deviation）
│   │   │   │   ├── delaunay.ts                # Delaunay 三角剖分 + 约束 Delaunay + Voronoi
│   │   │   │   ├── convex-hull.ts             # 凸包（Andrew Monotone Chain）
│   │   │   │   ├── clip.ts                    # 裁剪（sutherlandHodgman/weilerAtherton/cohenSutherland/liangBarsky）
│   │   │   │   ├── intersect.ts               # 相交检测（segmentSegment/rayTriangle/rayEllipsoid/rayAABB/rayPlane/planeSphere/frustumAABB/frustumSphere/bboxBBox/lineLineNearest/segmentCircle）
│   │   │   │   ├── contain.ts                 # 包含测试（pointInPolygonRay/pointInPolygonWinding/pointInTriangle/pointInBBox/pointOnLine）
│   │   │   │   ├── simplify.ts                # 线简化（douglasPeucker/visvalingam/chaikinSmooth/bezierFit）
│   │   │   │   └── cluster.ts                 # 聚合（Supercluster/dbscan/kMeans）
│   │   │   │
│   │   │   ├── index/                         # 空间索引（注意：此目录名为 index/，文件名不叫 index.ts 以避免与入口冲突）
│   │   │   │   ├── _entry.ts                  # 空间索引子模块入口
│   │   │   │   ├── rtree.ts                   # R-Tree（Hilbert+STR 批量加载，M=16，search/insert/remove/bulkLoad/nearestNeighbor）
│   │   │   │   ├── spatial-hash.ts            # 空间哈希网格（insert/query/clear/resize）
│   │   │   │   ├── quadtree.ts                # 四叉树（insert/search/remove/forEachInBBox）
│   │   │   │   ├── kd-tree.ts                 # KD-Tree（build/nearest/kNearest/rangeSearch）
│   │   │   │   └── grid-index.ts              # 规则网格索引（insert/query/cellSize 自适应）
│   │   │   │
│   │   │   ├── precision/
│   │   │   │   ├── index.ts
│   │   │   │   ├── split-double.ts            # Float64→两个Float32 拆分（splitDouble/splitDoubleArray/recombine）
│   │   │   │   └── rtc.ts                     # RTC 偏移（computeRTCCenter/offsetPositions/fromECEF）
│   │   │   │
│   │   │   ├── types/
│   │   │   │   ├── index.ts                   # 类型入口，re-export 全部共享类型
│   │   │   │   ├── geometry.ts                # GeoJSON Geometry（RFC 7946）：Point/LineString/Polygon/Multi*/GeometryCollection
│   │   │   │   ├── feature.ts                 # Feature / FeatureCollection（含 _sourceId/_layerId/_tileCoord/_state 运行时字段）
│   │   │   │   ├── viewport.ts                # Viewport / CameraState / PickResult（全局唯一定义）
│   │   │   │   ├── tile.ts                    # TileCoord / TileParams / TileData / TileState
│   │   │   │   └── style-spec.ts              # StyleSpec / SourceSpec / LayerStyleSpec / StyleExpression / FilterExpression / LightSpec
│   │   │   │
│   │   │   └── infra/
│   │   │       ├── index.ts
│   │   │       ├── coordinate.ts              # CRS 注册表 + 坐标转换管线（register/transform/transformArray）
│   │   │       ├── projection.ts              # 投影模块接口定义（ProjectionDef：project/unproject/bounds/wrapsX）
│   │   │       ├── event.ts                   # 用户事件总线（on/off/once/emit，typed EventMap）
│   │   │       ├── internal-bus.ts            # ★ 内部事件总线（tile:loaded/camera:changed/memory:warning 等模块间松耦合通信）
│   │   │       ├── errors.ts                  # ★ GeoForgeError + GeoForgeErrorCode（结构化错误 + 上下文 + DeveloperHint）
│   │   │       ├── object-pool.ts             # ★ 通用对象池（acquire/release，帧内临时对象复用）
│   │   │       ├── id.ts                      # ID 生成器（uniqueId/sequentialId/nanoid-like）
│   │   │       ├── logger.ts                  # 日志系统（debug/info/warn/error/none 分级 + DeveloperHint 友好提示）
│   │   │       └── config.ts                  # EngineConfig 完整定义 + createDefaultConfig() + PerformanceBudget
│   │   │
│   │   └── __tests__/
│   │       ├── math/
│   │       │   ├── vec3.test.ts
│   │       │   ├── mat4.test.ts
│   │       │   ├── quat.test.ts
│   │       │   ├── bbox.test.ts
│   │       │   └── frustum.test.ts
│   │       ├── geo/
│   │       │   ├── ellipsoid.test.ts
│   │       │   ├── mercator.test.ts
│   │       │   ├── geodesic.test.ts
│   │       │   └── measure.test.ts
│   │       ├── algorithm/
│   │       │   ├── earcut.test.ts
│   │       │   ├── delaunay.test.ts
│   │       │   ├── intersect.test.ts
│   │       │   ├── contain.test.ts
│   │       │   ├── simplify.test.ts
│   │       │   └── cluster.test.ts
│   │       ├── index/
│   │       │   ├── rtree.test.ts
│   │       │   └── quadtree.test.ts
│   │       └── precision/
│   │           ├── split-double.test.ts
│   │           └── rtc.test.ts
│   │
│   │  ════════════════════════════════════════
│   │  L1+L2 GPU/渲染层 — @geoforge/gpu (~30KB gz)
│   │  ════════════════════════════════════════
│   │
│   ├── gpu/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   │
│   │   │   ├── l1/                            # ── L1 GPU 资源层（8 模块）──
│   │   │   │   ├── index.ts
│   │   │   │   ├── device.ts                  # DeviceManager（requestAdapter/requestDevice/GPUCapabilities/vendorWorkaround/deviceLost 恢复）
│   │   │   │   ├── surface.ts                 # SurfaceManager（Canvas 配置/resize/DPR/getCurrentTexture/getMSAATextureView/getViewport/cssToNDC）
│   │   │   │   ├── buffer-pool.ts             # BufferPool（acquire/release/destroy）+ StagingRing（环形上传 4MB×3）
│   │   │   │   ├── texture-manager.ts         # TextureManager（create/release）+ DynamicAtlas（icons/glyphs/patterns bin-packing）
│   │   │   │   ├── memory-tracker.ts          # GPUMemoryTracker（track/untrack/refCount/LRU/orphanAudit/enforceBudget）
│   │   │   │   ├── bind-group-cache.ts        # BindGroupCache（getOrCreate/invalidateByResource）+ SamplerCache
│   │   │   │   ├── indirect-draw.ts           # IndirectDrawManager（createIndirectBuffer/bindComputeWriteGroup/encodeIndirectDraw）
│   │   │   │   └── uploader.ts                # GPUUploader（uploadBuffer/updateBuffer/writeUniform/uploadMat4/uploadDoublePrecisionPositions/uploadTexture/uploadFromTransferable/readbackBuffer/readbackTexture/generateMipmaps）
│   │   │   │
│   │   │   ├── l2/                            # ── L2 渲染管线层（13 模块）──
│   │   │   │   ├── index.ts
│   │   │   │   ├── shader-assembler.ts        # ShaderAssembler（registerModule/assemble/buildUniformLayout，4 类模块：projection/geometry/style/feature，9 Hook 点）
│   │   │   │   ├── pipeline-cache.ts          # PipelineCache（getOrCreate/getOrCreateAsync/warmup/warmupNext，ShaderVariantKey 缓存）
│   │   │   │   ├── depth-manager.ts           # DepthManager（Reversed-Z 配置/对数深度 WGSL 注入/updateClipPlanes）
│   │   │   │   ├── render-graph.ts            # RenderGraph（DAG 管理/addPass/removePass/topologicalSort/autoMergePasses/compile/toDot）
│   │   │   │   ├── frame-graph-builder.ts     # FrameGraphBuilder（begin/addFrustumCullPass/addDepthSortPass/addLabelCollisionPass/addSceneRenderPass/addPostProcessPass/addScreenPass/addPickingPass/build）
│   │   │   │   ├── compositor.ts              # Compositor（compose 深度合成/composeWithOIT 加权混合/depth space 统一）
│   │   │   │   ├── picking-engine.ts          # PickingEngine（Color-ID picking/pickAt/pickInRect/raycast/readDepthAt/unprojectScreenToWorld/screenToGeodetic）
│   │   │   │   ├── stencil-manager.ts         # StencilManager（polygonMask/terrainDrape/invertedClassification 预设）
│   │   │   │   ├── render-stats.ts            # RenderStats（FrameStats: drawCalls/triangles/instances/passes/uploads/tiles/labels + GPU timestamp query）
│   │   │   │   ├── compute-pass-manager.ts    # ComputePassManager（createFrustumCullTask/createDepthSortTask/createLabelCollisionTask/createPointClusterTask/encodeAll）
│   │   │   │   ├── blend-presets.ts           # BlendPresets（opaque/alphaBlend/premultipliedAlpha/additive/multiply/screen/stencilOnly/custom）
│   │   │   │   ├── uniform-layout-builder.ts  # UniformLayoutBuilder（WGSL 对齐规则/generateWGSL/UniformWriter）
│   │   │   │   ├── wgsl-templates.ts          # WGSLTemplates（vertexTemplate/fragmentTemplate/computeTemplates + 内置模块：mercator.wgsl/globe.wgsl/split_double.wgsl/log_depth.wgsl/sdf_line.wgsl/msdf_text.wgsl）
│   │   │   │   └── devtools.ts                # ★ DevTools 诊断面板（瓦片检查器/GPU内存分布/Shader变体/图层性能/帧回放，__DEV__ 条件编译可剥离）
│   │   │   │
│   │   │   └── wgsl/                          # ── WGSL 着色器源码 ──
│   │   │       ├── templates/
│   │   │       │   ├── vertex_template.wgsl   # 顶点着色器模板（PerFrameUniforms + VertexInput/Output + vs_main + Hook 占位符）
│   │   │       │   └── fragment_template.wgsl # 片元着色器模板（fs_main + Hook 占位符）
│   │   │       ├── projection/
│   │   │       │   ├── mercator.wgsl          # fn projectPosition → vpMatrix * vec4(worldPos, 1.0)
│   │   │       │   ├── globe.wgsl             # fn projectPosition（ECEF + Split-Double + RTC）
│   │   │       │   └── ortho.wgsl             # fn projectPosition（正交投影）
│   │   │       ├── geometry/
│   │   │       │   ├── point.wgsl             # fn processVertex（点精灵）
│   │   │       │   ├── line.wgsl              # fn processVertex（线段条带）
│   │   │       │   └── polygon.wgsl           # fn processVertex（三角网面片）
│   │   │       ├── style/
│   │   │       │   ├── fill_solid.wgsl        # fn computeColor（纯色填充）
│   │   │       │   ├── fill_gradient.wgsl     # fn computeColor（渐变填充）
│   │   │       │   └── stroke.wgsl            # fn computeColor（描边）
│   │   │       ├── feature/
│   │   │       │   ├── split_double.wgsl      # reconstructDoublePrecision()
│   │   │       │   ├── log_depth.wgsl         # applyLogDepthVertex() + applyLogDepthFragment()
│   │   │       │   ├── sdf_line.wgsl          # sdfLineAlpha()
│   │   │       │   └── msdf_text.wgsl         # MSDF 采样 + 抗锯齿
│   │   │       └── compute/
│   │   │           ├── frustum_cull.wgsl      # 视锥剔除 Compute Shader
│   │   │           ├── depth_sort.wgsl        # Parallel Radix Sort
│   │   │           └── label_collision.wgsl   # 标注碰撞精筛
│   │   │
│   │   └── __tests__/
│   │       ├── l1/
│   │       │   ├── device.test.ts
│   │       │   ├── buffer-pool.test.ts
│   │       │   └── uploader.test.ts
│   │       └── l2/
│   │           ├── shader-assembler.test.ts
│   │           ├── depth-manager.test.ts
│   │           ├── frame-graph-builder.test.ts
│   │           └── uniform-layout-builder.test.ts
│   │
│   │  ════════════════════════════════════════
│   │  L3 调度层 — @geoforge/runtime (~15KB gz)
│   │  ════════════════════════════════════════
│   │
│   ├── runtime/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── frame-scheduler.ts             # FrameScheduler（rAF 循环/4 阶段/帧预算/Page Visibility/requestRenderMode/stepOneFrame）
│   │   │   ├── tile-scheduler.ts              # TileScheduler（SSE 驱动/frustumCull/pitch 降级/placeholder/overZoom，update→TileScheduleResult）
│   │   │   ├── worker-pool.ts                 # WorkerPool（16 种任务类型/submit/submitBatch/cancel/reprioritize/负载均衡/Transferable 零拷贝）
│   │   │   ├── worker-entry.ts                # Worker 入口脚本（import L0 全部算法模块/onmessage 分发）
│   │   │   ├── resource-manager.ts            # ResourceManager（load/get/addRef/releaseRef/markAccessed/evict/processIdleQueue/事件通知）
│   │   │   ├── memory-budget.ts               # MemoryBudget（GPU+CPU 双轨/warning 80%/eviction 90%/5 级淘汰链/check/snapshot）
│   │   │   ├── request-scheduler.ts           # RequestScheduler（5 级优先队列 critical>high>normal>low>prefetch/cancel/指数退避/HTTP2 检测）
│   │   │   ├── error-recovery.ts              # ErrorRecovery（report/shouldRetry/指数退避+jitter/handleWorkerCrash/handleDeviceLost/markPermanentFailure）
│   │   │   ├── camera-controller.ts           # CameraController 抽象接口（setCenter/setZoom/setBearing/setPitch/jumpTo/flyTo/easeTo/stop/update/handlePan*/handleZoom/handleRotate/惯性/事件）
│   │   │   └── performance-manager.ts         # ★ PerformanceManager 自适应降级（PerformanceBudget/QualityLevel/降级链：MSAA→后处理→分辨率→SSE→标注→大气）
│   │   │
│   │   └── __tests__/
│   │       ├── frame-scheduler.test.ts
│   │       ├── tile-scheduler.test.ts
│   │       ├── worker-pool.test.ts
│   │       ├── memory-budget.test.ts
│   │       └── request-scheduler.test.ts
│   │
│   │  ════════════════════════════════════════
│   │  L4 场景层 — @geoforge/scene (~12KB gz)
│   │  ════════════════════════════════════════
│   │
│   ├── scene/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── scene-graph.ts                 # SceneGraph（多投影子树/addLayer→自动归入 projection-group/getLayersByProjection/getVisibleLayers/getProjectionGroups）
│   │   │   ├── layer-manager.ts               # LayerManager（addLayer/removeLayer/moveLayer/setZIndex/setVisibility/setFilter/setLayerOrder/registerLayerType/事件）+ Layer 接口 + LayerSpec + LayerContext
│   │   │   ├── source-manager.ts              # SourceManager（addSource/removeSource/getSource/registerSourceType/事件）+ Source 接口 + SourceSpec
│   │   │   ├── style-engine.ts                # StyleEngine（compile→WGSL/compileFilter/evaluate/缓存）+ CompiledStyle
│   │   │   ├── label-manager.ts               # LabelManager（submitLabels/clearLabels/resolve[CPU R-Tree 粗筛+GPU Compute 精筛]/getLabelAt/stats）+ LabelSpec + PlacedLabel + GlyphQuad
│   │   │   ├── glyph-manager.ts               # GlyphManager（registerFont/getGlyph/getGlyphs/isBlockLoaded/loadBlock/shape/atlas）+ GlyphMetrics + FontStack + UnicodeBlock
│   │   │   ├── feature-state.ts               # FeatureStateManager（setState/removeState/getState/setStates/clearStates/uploadStatesToGPU/onStateChange）
│   │   │   ├── antimeridian.ts                # AntiMeridianHandler（splitGeometry/splitFeatures/getWorldCopies/normalizeTileCoord/normalizeLongitude）
│   │   │   ├── animation.ts                   # AnimationManager（animateProperty/flyTo[→CameraController]/setClock/playClock/pauseClock/update/getAnimation/cancelAll）+ Animation + AnimationOptions
│   │   │   ├── spatial-query.ts               # SpatialQuery（queryAtPoint/queryInRect/queryInBBox/queryInPolygon/queryInRadius/queryNearest/screenToLngLat/lngLatToScreen）+ QueryOptions
│   │   │   ├── a11y.ts                        # A11yManager（键盘导航/ARIA/焦点管理/高对比度/prefers-reduced-motion）
│   │   │   └── layer-plugin.ts                # ★ LayerPlugin 自描述协议（workerTasks+shaderModules+createLayer，一行注册新图层类型）
│   │   │
│   │   └── __tests__/
│   │       ├── scene-graph.test.ts
│   │       ├── layer-manager.test.ts
│   │       ├── style-engine.test.ts
│   │       ├── label-manager.test.ts
│   │       ├── feature-state.test.ts
│   │       └── antimeridian.test.ts
│   │
│   │  ════════════════════════════════════════
│   │  L5 扩展层 — @geoforge/extensions
│   │  ════════════════════════════════════════
│   │
│   ├── extensions/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── registry.ts                   # ExtensionRegistry（6 个 register/get/list/unregister + has + 事件）+ ExtensionInfo + ExtensionMeta + ExtensionType
│   │   │   ├── lifecycle.ts                   # ExtensionLifecycle（instantiate/destroy/safeExecute/safeExecuteAsync/checkCompatibility/reenable/状态机/连续错误计数）
│   │   │   ├── custom-layer.ts                # EP1 接口定义：CustomLayer + CustomLayerContext + CustomLayerFactory
│   │   │   ├── custom-projection.ts           # EP2 接口定义：ProjectionModule（WGSL+CPU+tileGrid+antimeridian）
│   │   │   ├── custom-source.ts               # EP3 接口定义：DataSource + SourceContext + SourceMetadata + TileParams + FeatureUpdate
│   │   │   ├── shader-hook.ts                 # EP4 接口定义：ShaderHookDefinition + ShaderHookPoint（9 个）
│   │   │   ├── custom-postprocess.ts          # EP5 接口定义：PostProcessPass + PostProcessContext（execute 用 GPUCommandEncoder）
│   │   │   ├── custom-interaction.ts          # EP6 接口定义：InteractionTool + InteractionContext + MapPointerEvent + OverlayRenderer
│   │   │   └── interaction-manager.ts         # InteractionManager（activateTool/deactivateTool/事件分发链/defaultTool 开关）
│   │   │
│   │   └── __tests__/
│   │       ├── registry.test.ts
│   │       └── lifecycle.test.ts
│   │
│   │  ════════════════════════════════════════
│   │  L6 预设层 — 4 个预设包
│   │  ════════════════════════════════════════
│   │
│   ├── preset-2d/                             # @geoforge/preset-2d (~120KB gz)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts                       # export { Map2D } + 图层 + Controls
│   │   │   ├── Map2D.ts                       # Map2D 类（~50 个公共方法：视图/图层/查询/事件/Controls/坐标/样式/Canvas/逃生舱口）
│   │   │   ├── controls/
│   │   │   │   ├── index.ts
│   │   │   │   ├── NavigationControl.ts       # 缩放/旋转按钮
│   │   │   │   ├── ScaleControl.ts            # 比例尺
│   │   │   │   ├── AttributionControl.ts      # 数据归属
│   │   │   │   ├── GeolocateControl.ts        # 定位
│   │   │   │   └── FullscreenControl.ts       # 全屏
│   │   │   └── init.ts                        # L0→L1→L2→L3→L4→L5 初始化编排
│   │   └── __tests__/
│   │       └── Map2D.test.ts
│   │
│   ├── preset-25d/                            # @geoforge/preset-25d (~155KB gz)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── Map25D.ts                      # extends Map2D（+pitch/bearing/rotateTo/setLight）
│   │
│   ├── preset-3d/                             # @geoforge/preset-3d (~195KB gz)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── Globe3D.ts                     # Globe3D 类（flyTo/lookAt/addImageryLayer/add3DTileset/setTerrain/setAtmosphere/morphTo*/逃生舱口）
│   │
│   ├── preset-full/                           # @geoforge/preset-full (~350KB gz)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts                       # re-export 所有预设 + 所有可选包
│   │       └── MapFull.ts                     # extends Map25D（+setMode/3D 功能代理）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 相机
│   │  ════════════════════════════════════════
│   │
│   ├── camera-2d/                             # @geoforge/camera-2d
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── Camera2D.ts                    # implements CameraController（正交投影/惯性/边界约束）
│   │
│   ├── camera-25d/                            # @geoforge/camera-25d
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── Camera25D.ts                   # implements CameraController（透视/pitch+bearing/惯性）
│   │
│   ├── camera-3d/                             # @geoforge/camera-3d
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── Camera3D.ts                    # extends CameraController（ECEF/四元数/地形碰撞/Great Circle flyTo）
│   │
│   ├── view-morph/                            # @geoforge/view-morph
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── ViewMorph.ts                   # morphTo()（投影矩阵插值 + 顶点位置 lerp(mercator,ecef,t)）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 图层
│   │  ════════════════════════════════════════
│   │
│   ├── layer-tile-raster/                     # @geoforge/layer-tile-raster
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── RasterTileLayer.ts             # implements Layer（瓦片请求/解码/纹理上传/接缝处理/亮度对比度饱和度）
│   │
│   ├── layer-tile-vector/                     # @geoforge/layer-tile-vector
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── VectorTileLayer.ts             # implements Layer（MVT→Worker→earcut/宽线→GPU/queryFeatures）
│   │       └── mvt-decoder.ts                 # Protobuf 解码逻辑（在 Worker 中执行）
│   │
│   ├── layer-geojson/                         # @geoforge/layer-geojson
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── GeoJSONLayer.ts                # implements Layer（setData/getCluster*/geojson-vt 集成）
│   │       └── geojson-vt.ts                  # 自研 GeoJSON 瓦片切片
│   │
│   ├── layer-terrain/                         # @geoforge/layer-terrain
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── TerrainLayer.ts                # implements Layer（DEM→三角网/裙边/LOD Morphing/getElevation）
│   │       └── terrain-mesh-builder.ts        # DEM 解码 + 三角网生成 + 法线计算 + 裙边（在 Worker 中执行）
│   │
│   ├── layer-3dtiles/                         # @geoforge/layer-3dtiles
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── Tiles3DLayer.ts                # implements Layer（BVH 遍历/SSE LOD/内存预算/glTF 解析）
│   │       ├── tileset-traversal.ts           # BVH 层级遍历 + SSE 计算
│   │       └── gltf-parser.ts                 # glTF/glb 解析器
│   │
│   ├── layer-heatmap/                         # @geoforge/layer-heatmap
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── HeatmapLayer.ts                # 核密度估计 + 颜色映射 Shader
│   │
│   ├── layer-pointcloud/                      # @geoforge/layer-pointcloud
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── PointCloudLayer.ts             # 点云渲染 + Eye-Dome Lighting + LOD
│   │
│   ├── layer-marker/                          # @geoforge/layer-marker
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── MarkerLayer.ts                 # 图标/标注/HTML Marker + 聚合
│   │
│   ├── layer-extrusion/                       # @geoforge/layer-extrusion
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── ExtrusionLayer.ts              # 多边形拉伸 + 光照 + 阴影
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 地球
│   │  ════════════════════════════════════════
│   │
│   ├── globe/                                 # @geoforge/globe
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── GlobeRenderer.ts               # 椭球体网格渲染 + encode/encodeAtmosphere/encodeSkybox
│   │       ├── atmosphere.ts                  # 大气散射（Rayleigh+Mie+LUT）
│   │       ├── skybox.ts                      # 星空渲染
│   │       └── sun.ts                         # 太阳位置计算（setSunFromDateTime）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 交互工具
│   │  ════════════════════════════════════════
│   │
│   ├── interaction-draw/                      # @geoforge/interaction-draw
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── DrawTool.ts                    # implements InteractionTool（点/线/面绘制 + overlay）
│   │
│   ├── interaction-measure/                   # @geoforge/interaction-measure
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── MeasureTool.ts                 # implements InteractionTool（距离/面积测量 + 标注）
│   │
│   ├── interaction-select/                    # @geoforge/interaction-select
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── SelectTool.ts                  # implements InteractionTool（框选/点选/Shift多选）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 后处理
│   │  ════════════════════════════════════════
│   │
│   ├── postprocess-bloom/                     # @geoforge/postprocess-bloom
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── BloomPass.ts                   # implements PostProcessPass（阈值提取→高斯模糊→叠加）
│   │
│   ├── postprocess-ssao/                      # @geoforge/postprocess-ssao
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── SSAOPass.ts                    # implements PostProcessPass（屏幕空间环境光遮蔽）
│   │
│   ├── postprocess-shadow/                    # @geoforge/postprocess-shadow
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── ShadowPass.ts                  # implements PostProcessPass（CSM + PCF）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 数据源
│   │  ════════════════════════════════════════
│   │
│   ├── source-wmts/                           # @geoforge/source-wmts
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── WMTSSource.ts                  # implements DataSource（GetTile 请求构建/TileMatrixSet 解析）
│   │
│   ├── source-wms/                            # @geoforge/source-wms
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── WMSSource.ts                   # implements DataSource（GetMap 请求/GetCapabilities 解析）
│   │
│   ├── source-wfs/                            # @geoforge/source-wfs
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── WFSSource.ts                   # implements DataSource（GetFeature/DescribeFeatureType/GML 解析）
│   │
│   ├── source-pmtiles/                        # @geoforge/source-pmtiles
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── PMTilesSource.ts               # implements DataSource（HTTP Range Request/目录解析/瓦片定位）
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 兼容层
│   │  ════════════════════════════════════════
│   │
│   ├── compat-mobile/                         # @geoforge/compat-mobile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── MobileOptimizer.ts             # 能力检测→降质策略→激进 LOD→powerPreference
│   │
│   ├── compat-hidpi/                          # @geoforge/compat-hidpi
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── HiDPIAdapter.ts                # DPR 检测/动态分辨率/自适应渲染尺寸
│   │
│   │  ════════════════════════════════════════
│   │  可选功能包 — 空间分析
│   │  ════════════════════════════════════════
│   │
│   └── analysis/                              # @geoforge/analysis (~15KB gz)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── boolean/
│           │   └── index.ts                   # Martinez-Rueda-Feito：intersection/union/difference/xor/kinks/makeValid
│           ├── buffer/
│           │   └── index.ts                   # pointBuffer/lineBuffer/polygonBuffer/offsetCurve
│           ├── interpolation/
│           │   └── index.ts                   # TIN/IDW/isolines(Marching Squares)/bilinear/bicubic/kriging
│           ├── classification/
│           │   └── index.ts                   # jenks/equalInterval/quantile/standardDeviation
│           ├── grid/
│           │   └── index.ts                   # squareGrid/hexGrid/triangleGrid/voronoi(Fortune)
│           ├── raster/
│           │   └── index.ts                   # slope/aspect/hillshade/viewshed/contour/reclassify
│           ├── transform/
│           │   └── index.ts                   # rotate/scale/translate/flip/rewindPolygon/cleanCoords
│           ├── aggregation/
│           │   └── index.ts                   # collect/count/sum/avg/median/deviation
│           └── topology/
│               └── index.ts                   # booleanContains/Within/Overlap/Crosses/Disjoint/Intersects/Touches
│
│  ════════════════════════════════════════════
│  项目根目录配置文件
│  ════════════════════════════════════════════
│
├── docs/
│   ├── architecture/
│   │   ├── GeoForge_L0_v2.1.md               # L0 基础层完整接口定义
│   │   ├── GeoForge_L1_v2.1.md               # L1 GPU 层完整接口定义
│   │   ├── GeoForge_L2_v2.1.md               # L2 渲染层完整接口定义
│   │   ├── GeoForge_L3_v2.1.md               # L3 调度层完整接口定义
│   │   ├── GeoForge_L4_v2.1.md               # L4 场景层完整接口定义
│   │   ├── GeoForge_L5_v2.1.md               # L5 扩展层完整接口定义
│   │   ├── GeoForge_L6_v2.1.md               # L6 预设层完整接口定义
│   │   ├── GeoForge_Complete_Design_Document.md
│   │   ├── GeoForge_Algorithm_Inventory.md    # 130+ 算法清单
│   │   └── GeoForge_Architecture_Audit.md     # 审计报告
│   │
│   ├── api/                                   # 自动生成的 API 文档
│   └── guides/
│       ├── getting-started.md
│       ├── custom-layer.md
│       ├── custom-projection.md
│       └── custom-source.md
│
├── examples/
│   ├── basic-2d-map/                          # 最简 2D 地图示例
│   │   ├── index.html
│   │   └── main.ts
│   ├── 3d-globe/                              # 3D 地球示例
│   │   ├── index.html
│   │   └── main.ts
│   ├── mixed-2d-3d/                           # 同场景混合渲染
│   │   ├── index.html
│   │   └── main.ts
│   └── custom-layer/                          # 自定义图层示例
│       ├── index.html
│       └── main.ts
│
└── scripts/
    ├── build.ts                               # 全量构建脚本
    ├── dev.ts                                 # 开发服务器
    ├── bundle-size.ts                         # 打包体积分析
    └── check-deps.ts                          # ★ 依赖约束检查（CI 运行，验证每个包只 import 允许的依赖，禁止循环依赖）
```

---

## 统计

| 类别 | 包数 | 源文件数 |
|------|------|---------|
| 核心必选（L0~L5）| 5 | ~65 |
| L6 预设 | 4 | ~12 |
| 相机 | 4 | ~5 |
| 图层 | 9 | ~18 |
| 地球 | 1 | ~5 |
| 交互 | 3 | ~4 |
| 后处理 | 3 | ~4 |
| 数据源 | 4 | ~5 |
| 兼容层 | 2 | ~3 |
| 分析 | 1 | ~10 |
| WGSL | — | ~15 |
| 测试 | — | ~35 |
| **合计** | **36 包** | **~181 源文件 + ~15 WGSL + ~35 测试** |
