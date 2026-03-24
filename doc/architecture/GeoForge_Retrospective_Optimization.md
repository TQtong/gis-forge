# GeoForge 全量回溯 + 优化/扩展规划

---

## 一、全量回溯——3 轮设计已交付的完整清单

### 1.1 第一轮（Session 1）：调研 + 架构提案

| 交付物 | 内容 | 状态 |
|--------|------|------|
| 22 个开源 GIS 引擎调研 | MapLibre GL/CesiumJS/deck.gl/OpenLayers/Leaflet/... 的架构分析 | ✅ 完成 |
| 34 个工程问题 | 浮点精度/Z-Fighting/瓦片接缝/宽线渲染/标注碰撞/... | ✅ 完成 |
| 5 套架构提案 | 最终选定七层架构（L0~L6） | ✅ 完成 |
| 5 项锁定约束 | 统一维度/Tree-Shakable/同场景共存/纯WebGPU/6扩展点 | ✅ 完成 |
| 130+ 算法清单 | 12 大类 GIS 算法（三角剖分/裁剪/索引/度量/投影/...） | ✅ 完成 |

### 1.2 第二轮（Session 2）：核心层接口 + 审计

| 交付物 | 内容 | 状态 |
|--------|------|------|
| L0 v2.1 | 29 模块 + 5 共享类型 | ✅ 自包含 |
| L1 v2.2 | 8 模块，58 个公共方法 | ✅ 自包含（合并 Part1） |
| L2 v2.2 | 13 模块，96 个公共方法 | ✅ 自包含（合并 Part1） |
| L3 v2.1 | 12 模块含 Camera | ✅ 自包含 |
| L4 v2.1 | 11 模块 + 5 图层包 + 端到端数据流 | ✅ 自包含 |
| L5 v2.1 | 8 模块，EP1~EP6 | ✅ 自包含 |
| L6 v2.1 | 4 预设 + 5 Controls | ✅ 自包含 |
| 审计报告 | 34 问题覆盖 + 12 不一致 + 7 缺口 → 全部修复 | ✅ 完成 |
| 目录结构 | 36 包，181 源文件 + 15 WGSL + 35 测试 | ✅ 完成 |
| Cursor Rules v1 | 9 个 .mdc 文件，14 条约束 | ✅ 完成 |

### 1.3 第三轮（Session 3，本轮）：补全 + 非功能性 + 全部可选包

| 交付物 | 内容 | 状态 |
|--------|------|------|
| L1 v2.2 / L2 v2.2 | 合并 Part1，消除"见 Part1"引用 | ✅ 完成 |
| Cursor Rules v2 | 20 条约束 + 非功能性基础设施 + AI 输出规范 | ✅ 完成 |
| 非功能性补充 | 可扩展性/可维护性/性能优化/易用性 → 6 新模块 | ✅ 完成 |
| P0 相机包（完整版）| camera-2d/25d/3d，1406 行 | ✅ 质量审计 100% |
| P0 图层包（完整版）| layer-tile-raster/vector/geojson，1457 行 | ✅ 质量审计 100% |
| P1 核心 3D（完整版）| layer-terrain/globe/view-morph/layer-3dtiles，2371 行 | ✅ 质量抽查通过 |
| P2 增强包（完整版）| 7 图层交互 + 3 后处理，1579 行 | ✅ 质量抽查通过 |
| P3 生态包（完整版）| 4 数据源 + 2 兼容层 + 分析包(9子模块)，1620 行 | ✅ 质量抽查通过 |
| P0 质量审计 | 12 缺口 → 全部修复 → 31/31 通过 | ✅ 完成 |

### 1.4 数字总览

| 维度 | 数量 |
|------|------|
| 核心模块 | 91 个（L0~L6） |
| 可选包 | 27 个（P0~P3） |
| 公共方法 | ~700（核心~400 + 可选~311） |
| WGSL Shader 模块 | 15 核心 + 29 可选 = 44 |
| 错误场景 | ~120 种 |
| 算法步骤级伪代码 | ~50 个算法 |
| 对接关系 | ~200 个模块间对接点 |
| 设计文档总行数 | ~20000（核心~5000 + 可选~8433 + 基础设施~2900 + 规则~931） |
| Cursor Rules | 9 个 .mdc 文件，20 条硬约束 |

---

## 二、后续优化点（已实现但可改进的部分）

### 2.1 性能优化

| # | 优化点 | 当前状态 | 改进方向 | 优先级 |
|---|--------|---------|---------|--------|
| O1 | BufferPool StagingRing | 固定 4MB×3 | 自适应大小（根据帧上传量动态调整，历史 P95 × 1.5） | 中 |
| O2 | PipelineCache warmup | 手动调用 warmup | 启动时自动预热常用组合（fill+mercator/line+mercator/circle+mercator/raster+mercator），基于上次会话的使用统计 | 高 |
| O3 | TileScheduler 优先级 | SSE 单因子排序 | 多因子加权：SSE × 0.5 + 可见性 × 0.3 + 缓存命中率 × 0.2（缓存中有的优先） | 中 |
| O4 | Worker 负载均衡 | 轮询分配 | 按任务类型亲和性分配（同类型任务分配给同一 Worker，利用 JIT 缓存） | 低 |
| O5 | earcut 大多边形 | 单线程 O(n²) | 顶点数 > 10000 时自动分块：先 Bounding Box 四叉树切分，子块并行 earcut，再缝合 | 中 |
| O6 | LabelManager 碰撞 | CPU R-Tree + GPU Compute 两阶段 | 引入时间连续性：帧间 diff（只重新检测变化的标注），减少每帧碰撞检测量 90%+ | 高 |
| O7 | 纹理 Atlas 碎片化 | 简单 Bin Packing | 定期整理（idle 阶段执行 defragment：重新打包所有存活项，释放碎片空间） | 低 |
| O8 | Shader 编译 | 首次使用时编译 | Pipeline warmup 队列 + 编译进度回调（UI 可显示加载进度条） | 中 |
| O9 | MemoryBudget 淘汰 | 5 级优先链 | 增加"预测性淘汰"：根据相机移动方向预测即将离开视口的瓦片，提前降低优先级 | 中 |
| O10 | 帧间复用 | 每帧重建 FrameGraph | 视口未变化时直接复用上一帧的 CompiledRenderGraph（跳过 build()），仅更新 Uniform | 高 |

### 2.2 代码质量优化

| # | 优化点 | 改进方向 | 优先级 |
|---|--------|---------|--------|
| Q1 | 单元测试覆盖率 | 目标：核心包 >90%，可选包 >70%。优先补全 L0/math（每个函数 3+ 用例）和 L0/algorithm（earcut/simplify/rtree 的边界用例） | 高 |
| Q2 | 集成测试 | headless Chrome + Dawn 的端到端测试（addLayer → 截图像素比对），至少覆盖 5 个核心场景 | 高 |
| Q3 | API 文档生成 | TypeDoc 自动从 TSDoc 注释生成 API Reference。每次 CI 构建自动更新 | 中 |
| Q4 | Bundle Size 监控 | 每次 PR 自动报告包体积变化（±5% 告警），确保 2D ~120KB / 全功能 ~350KB gz 的约束 | 高 |
| Q5 | 依赖约束 CI | check-deps.ts 集成到 GitHub Actions，每次 PR 自动检查层级依赖、循环依赖 | 高 |
| Q6 | 性能 Benchmark | vitest bench 对关键路径（mat4.multiply / earcut / R-Tree query / MVT decode）持续追踪回归 | 中 |

### 2.3 架构级优化

| # | 优化点 | 改进方向 | 优先级 |
|---|--------|---------|--------|
| A1 | WebWorker 模块化 | 当前 worker-entry.ts 打包所有 L0 算法。改为按需加载（Worker 内 dynamic import），未使用的算法不占 Worker 内存 | 中 |
| A2 | GPU Compute 利用率 | 当前仅 frustumCull/depthSort/labelCollision 用 Compute。扩展到：瓦片解码（Compute Shader 解 PNG）、样式计算（大量要素的属性→颜色映射） | 低 |
| A3 | SharedArrayBuffer | 如果浏览器支持（COOP/COEP headers），Worker 和主线程共享内存，省去 Transferable 的所有权转移开销 | 低 |
| A4 | OffscreenCanvas | 将渲染完全移到 Worker 中（通过 OffscreenCanvas.transferControlToOffscreen），主线程只处理交互事件 | 低 |
| A5 | 增量更新 | GeoJSONLayer.setData() 当前全量重建。改为 diff 更新（识别新增/删除/修改的要素，只重建受影响的瓦片） | 高 |

---

## 三、后续扩展点（架构已预留但未实现的能力）

### 3.1 新图层类型

| 扩展 | 说明 | 复杂度 | 依赖 |
|------|------|--------|------|
| layer-s2 | S2 Geometry 球面瓦片 | 高 | 新投影模块 EP2 + S2 索引 |
| layer-wind | 风场粒子可视化（类 earth.nullschool.net） | 中 | Compute Shader 粒子系统 |
| layer-trajectory | GPS 轨迹动画（带时间轴） | 中 | AnimationManager + 线段渐变 |
| layer-video | 视频纹理叠加（无人机影像/监控画面） | 中 | HTMLVideoElement → GPUExternalTexture |
| layer-wkt | WKT/WKB 格式直接加载 | 低 | Worker 解析器 |
| layer-flatgeobuf | FlatGeobuf 格式支持（HTTP Range 随机访问） | 中 | 类似 PMTiles 的 Range Request |
| layer-cluster-3d | 3D 点聚合（在 ECEF 空间聚合） | 中 | Supercluster 3D 扩展 |

### 3.2 新数据源

| 扩展 | 说明 | 复杂度 |
|------|------|--------|
| source-cog | Cloud-Optimized GeoTIFF（Range Request 读取） | 中 |
| source-stac | STAC API 目录浏览 + COG 加载 | 中 |
| source-realtime | WebSocket/SSE 实时数据流（如 AIS 船舶/航班追踪） | 中 |
| source-terrarium-rgb | Terrarium 地形 RGB DEM 源 | 低（已有编码支持） |
| source-mapbox-terrain | Mapbox Terrain-RGB v2 源 | 低（已有编码支持） |

### 3.3 新交互工具

| 扩展 | 说明 | 复杂度 |
|------|------|--------|
| interaction-edit | 已有要素编辑（顶点拖动/插入/删除） | 中 |
| interaction-split | 线/面分割 | 中 |
| interaction-merge | 面合并 | 低（复用 boolean union） |
| interaction-buffer-visual | 交互式缓冲区（拖动半径实时预览） | 低 |
| interaction-profile | 交互式高程剖面（沿鼠标路径实时绘制） | 中 |

### 3.4 新后处理效果

| 扩展 | 说明 | 复杂度 |
|------|------|--------|
| postprocess-dof | 景深（Depth of Field）模糊远处/近处 | 中 |
| postprocess-fog | 体积雾/大气雾 | 低 |
| postprocess-outline | 要素轮廓线（Sobel 边缘检测） | 低 |
| postprocess-color-correction | 色彩校正（LUT 查表/曲线调整） | 低 |
| postprocess-vignette | 暗角效果 | 低 |

### 3.5 平台扩展

| 扩展 | 说明 | 复杂度 |
|------|------|--------|
| compat-maplibre | MapLibre GL JS API 兼容层 | 高 |
| compat-cesium | CesiumJS API 部分兼容（Viewer/Entity） | 高 |
| compat-react | React 组件封装（<GeoForgeMap />） | 中 |
| compat-vue | Vue 组件封装 | 中 |
| compat-svelte | Svelte 组件封装 | 低 |
| server-renderer | Node.js 服务端渲染（headless Dawn） | 高 |

---

