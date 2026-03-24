# GeoForge：新一代 2D/2.5D/3D 统一 WebGPU GIS 引擎 — 完整设计文档

> **版本**：v1.0  
> **日期**：2026-03-23  
> **范围**：从引擎调研、问题收集、方案论证到完整架构设计的全链路文档

---

# 第一篇：行业现状 — 开源 GIS 引擎全景分析

---

## 1. 你已知的六大引擎

### 1.1 Leaflet
- **GitHub**: https://github.com/Leaflet/Leaflet
- **维度**: 纯 2D | **渲染**: DOM/SVG/Canvas | **体积**: ~42KB gz | **协议**: BSD 2-Clause
- **设计理念**：极简主义 + 插件生态。核心只含瓦片加载、矢量叠加、标注、弹窗、交互控制。v2.0 迁移到 ESM 模块化，支持 tree shaking。700+ 社区插件。
- **架构特点**：自定义 Class 继承体系，Evented 事件系统松耦合，插件无需注册机制。
- **适用场景**：轻量 2D 地图、快速原型、嵌入式、移动优先。
- **局限**：无 WebGL，不支持 3D/2.5D，大数据量依赖插件。

### 1.2 OpenLayers
- **GitHub**: https://github.com/openlayers/openlayers
- **维度**: 2D（部分 WebGL 加速）| **渲染**: Canvas 2D + WebGL | **协议**: BSD 2-Clause
- **设计理念**：全功能 GIS 工具箱 + OGC 标准完整支持。从 2006 年至今功能最完备。
- **架构特点**：面向对象 + 事件驱动，多渲染后端（Canvas/WebGL），OGC 全覆盖（WMS/WFS/WMTS/WPS），内置投影系统 + proj4js 集成，Tree Shaking 友好。
- **适用场景**：企业级 GIS、OGC 服务集成、数据密集型地图。
- **局限**：学习曲线陡峭，包体重，3D 能力有限。

### 1.3 CesiumJS
- **GitHub**: https://github.com/CesiumGS/cesium
- **维度**: 3D 地球 + 2D + 2.5D Columbus View | **渲染**: WebGL | **协议**: Apache 2.0
- **设计理念**：高精度虚拟地球 + 开放格式 + 时空动态可视化。源于 2011 年 AGI 的卫星轨道可视化需求。
- **架构特点（四层分层）**：Core（数学）→ Renderer（WebGL 薄封装）→ Scene（地球/影像/相机/材质）→ Dynamic Scene（时间动态 CZML）。Open-Core 模式，3D Tiles/glTF/CZML 开放格式驱动。三种视图模式运行时切换。
- **适用场景**：数字孪生、航空航天、智慧城市、大规模 3D Tiles、时空模拟。
- **局限**：包体大（~530KB gz），2D 能力薄弱，配合 Cesium ion 最佳。

### 1.4 deck.gl
- **GitHub**: https://github.com/visgl/deck.gl
- **维度**: 2D / 2.5D / 3D | **渲染**: WebGL2 / WebGPU（实验性）| **协议**: MIT
- **设计理念**：GPU 驱动的大规模数据可视化图层系统。核心思想：地图只是底图，价值在数据图层。
- **架构特点**：一切皆 Layer（60+ 内置），与底图解耦（MapLibre/Mapbox/Google Maps），GPU 实例化渲染百万级数据 60fps，React 声明式 API，Extension 机制，WebGPU 前瞻。
- **适用场景**：出行数据、城市热力图、轨迹分析、大规模散点/弧线/六边形聚合。
- **局限**：不提供地图基础能力，非传统 GIS 工作流，3D 地球不如 Cesium。

### 1.5 MapLibre GL JS
- **GitHub**: https://github.com/maplibre/maplibre-gl-js
- **维度**: 2D + 2.5D（pitch/bearing）| **渲染**: WebGL | **协议**: BSD 3-Clause
- **设计理念**：Mapbox GL 的开源延续 + 矢量瓦片优先 + 样式规范驱动。2020 年末社区分叉。
- **架构特点**：JSON 样式规范驱动全管线，为 MVT 量身设计，WebGL 全量渲染（文字/图标/线/面/栅格），Pitch/Bearing 2.5D，Camera 动画，Linux Foundation 开放治理。
- **适用场景**：自定义样式地图、矢量瓦片、移动端高性能、替代 Mapbox GL。
- **局限**：不支持 3D 地球，数据分析不如 deck.gl，GIS 专业功能不如 OpenLayers。

### 1.6 Mapbox GL JS
- **GitHub**: https://github.com/mapbox/mapbox-gl-js
- **维度**: 2D + 2.5D + 3D（v3）| **渲染**: WebGL | **协议**: 专有（v2.0+ 非开源）
- **设计理念**：设计驱动 + 性能优先 + 商业平台。矢量瓦片渲染的开创者。
- **架构特点**：v3 Standard Style（3D 建筑/地标/动态光照）、Globe View（低缩放球体）、3D Terrain、60fps 移动端优化、多投影自适应。
- **适用场景**：商业地图产品、强调设计感、3D 地形。
- **局限**：非开源，必须使用 Mapbox 服务，商业付费。

---

## 2. 搜索发现的其他引擎

### 2.1 MapTalks.js / maptalks-gl
- **GitHub**: https://github.com/maptalks/maptalks.js | **Stars**: ~4.2k | **协议**: MIT
- **维度**: 2D/3D 统一 | **渲染**: Canvas 2D + WebGL + WebGPU（升级中）
- **设计理念**：2D/3D 一体化 + 插件化 + 易用优先。同一 Map 实例上叠加 2D Canvas 和 3D WebGL 图层。
- **关键特点**：GroupGLLayer 打包多个 GL 图层，正升级为 maptalks-gl（纯 WebGL/WebGPU），内置 DrawTool/Editor/MeasureTool，支持 MVT + 3DTiles + GLTF。

### 2.2 Tangram
- **GitHub**: https://github.com/tangrams/tangram | **Stars**: ~2.2k | **协议**: MIT
- **维度**: 2D/3D | **渲染**: WebGL
- **设计理念**：创意制图 + GLSL 着色器驱动 + YAML 场景文件声明式。把 3D 动画/游戏/CAD 技术带入地图。
- **关键特点**：YAML Scene File 声明数据源/图层/样式，GLSL 内联着色器，Leaflet 插件，Tangram ES（C++ 移动端）。

### 2.3 harp.gl
- **GitHub**: https://github.com/heremaps/harp.gl | **Stars**: ~1.3k | **协议**: Apache 2.0
- **维度**: 2D/3D | **渲染**: WebGL（Three.js）
- **设计理念**：Three.js 之上的 3D 地图引擎 + HERE 数据管线。TypeScript 全栈，JSON 主题，Worker 解码。

### 2.4 flywave.gl
- **GitHub**: https://github.com/flywave/flywave.gl | **Stars**: ~100+ | **协议**: MIT
- **维度**: 3D | **渲染**: WebGL（Three.js）
- **设计理念**：模块化 Monorepo + Three.js + 高性能 3D 地图。pnpm monorepo，Web Worker 并行，多数据源。

### 2.5 OpenGlobus
- **GitHub**: https://github.com/openglobus/openglobus | **Stars**: ~1.3k | **协议**: MIT
- **维度**: 3D 地球 | **渲染**: 纯 WebGL（无 Three.js 依赖）
- **设计理念**：纯自建 WebGL 渲染管线的轻量 3D 地球引擎。TypeScript 重写，高精度地形，React 集成。

### 2.6 iTowns
- **GitHub**: https://github.com/iTowns/itowns | **Stars**: ~1.2k | **协议**: MIT + CeCILL-B
- **维度**: 3D 地球 + 局部 3D | **渲染**: WebGL（Three.js）
- **设计理念**：法国 IGN 出品的研究级 3D 框架。点云/3DTiles 专长，GlobeView + PlanarView，WebXR 支持。

### 2.7 VTS Browser JS
- **GitHub**: https://github.com/melowntech/vts-browser-js | **Stars**: ~200+ | **协议**: BSD 2-Clause
- **维度**: 3D 地球 | **渲染**: WebGL
- **设计理念**：全栈 3D 地理平台浏览器端。仅约 163KB gzipped 提供接近完整 3D 功能，支持离线部署。

### 2.8 Globe.gl / three-globe
- **GitHub**: https://github.com/vasturiano/globe.gl | **Stars**: ~2.3k | **协议**: MIT
- **维度**: 3D 球体数据可视化 | **渲染**: WebGL（Three.js）
- **设计理念**：数据可视化组件 + 声明式 API。Web Component，Points/Arcs/Polygons/Hex/Heatmap 多图层。

### 2.9 NASA WorldWind（社区版）
- **GitHub**: https://github.com/WorldWindEarth | **Stars**: ~800+
- **维度**: 3D 地球 + 2D 投影 | **渲染**: WebGL/OpenGL
- **设计理念**：NASA 级虚拟地球 SDK。多平台（Java/JS/Kotlin/Android），科学数据导向。维护已减缓。

### 2.10 AntV L7
- **GitHub**: https://github.com/antvis/L7 | **Stars**: ~3.7k | **协议**: MIT
- **维度**: 2D/3D | **渲染**: WebGL
- **设计理念**：数据驱动的地理空间可视分析。Scene + Layer 双核心，多底图适配（高德/Mapbox/腾讯/百度），视觉变量映射，AntV G 渲染引擎底座。

### 2.11 Kepler.gl
- **GitHub**: https://github.com/keplergl/kepler.gl | **Stars**: ~10k+ | **协议**: MIT
- **维度**: 2D/3D | **渲染**: WebGL（基于 deck.gl）
- **设计理念**：开箱即用的无代码地理分析工具。React + Redux，自动数据推断，丰富过滤器。

### 2.12 vis.gl 框架族
- **网站**: https://vis.gl/frameworks
- **设计理念**：GPU 可视化框架生态。deck.gl + luma.gl（WebGL/WebGPU 封装）+ loaders.gl（60+ 格式加载）+ math.gl（地理空间数学）。

### 2.13 TerriaJS
- **GitHub**: https://github.com/TerriaJS/terriajs | **Stars**: ~1.3k | **协议**: Apache 2.0
- **维度**: 3D（Cesium）+ 2D（Leaflet）
- **设计理念**：数据目录驱动的地理数据浏览平台 + 2D/3D 优雅降级。驱动澳大利亚 NationalMap。

### 2.14 osgEarth
- **GitHub**: https://github.com/gwaldron/osgearth | **Stars**: ~1.7k | **协议**: LGPL
- **维度**: 3D 地球 | **语言**: C++ | **渲染**: OpenGL（OpenSceneGraph）
- **设计理念**：桌面级 C++ 3D 地图 SDK。GDAL 集成，原生性能，飞行模拟/军事仿真。

### 2.15 Tangram ES
- **GitHub**: https://github.com/tangrams/tangram-es | **Stars**: ~800+
- **维度**: 2D/3D | **语言**: C++ | **渲染**: OpenGL ES
- **设计理念**：Tangram 的原生移动端版本，共享 YAML 场景文件格式。

### 2.16 Protomaps
- **GitHub**: https://github.com/protomaps | **Stars**: ~3.5k+ | **协议**: BSD 3-Clause
- **设计理念**：地图即文件 + PMTiles + 零服务器。单文件包含所有缩放级别瓦片，HTTP Range Request 按需读取。

### 2.17 AntV G（渲染引擎底座）
- **GitHub**: https://github.com/antvis/G | **Stars**: ~900+ | **协议**: MIT
- **设计理念**：多渲染后端统一 API + DOM 兼容。Canvas2D/SVG/WebGL/WebGPU/CanvasKit 运行时切换，DOM Element/Event 兼容 API，GPGPU 计算。

---

# 第二篇：问题收集 — 从 22 个引擎中提取的 34 个工程问题

---

## 3. 精度类问题（3个）

### 3.1 浮点抖动（Jitter）
GPU float32 无法精确表达地球表面 ECEF 坐标（~6,371,000m），相机靠近地表时顶点位置帧间抖动。
- **CesiumJS**：GPU 双精度仿真，float64 拆为两个 float32（high+low），Vertex Shader 中 RTC 重组。
- **deck.gl**：fp64 扩展层，split-double 技术。
- **MapLibre GL**：tile-local 坐标（每瓦片原点为局部坐标系）。

### 3.2 深度缓冲精度不足（Z-Fighting）
3D 地球近/远裁剪面跨度极大（0.1m~20,000km），深度缓冲远处精度近零，三角面闪烁。
- **CesiumJS 早期**：Multi-Frustum（2-4 个子视锥体分别渲染，部分 draw call 重复）。
- **CesiumJS 现在**：Hybrid Multi-Frustum + Logarithmic Depth Buffer（对数深度），单视锥体覆盖 0.1m~1e8m，减少 10-40 重复 draw call。
- **WebGPU 优势**：原生 Reversed-Z + 32-bit float 深度。

### 3.3 GPU 驱动差异
特定 GPU 实现导致渲染异常（Intel Arc 抖动伪影、移动端深度精度降低）。
- 解决：GPU 能力检测 + vendorId workaround + 持续跟踪驱动更新。

---

## 4. 瓦片系统问题（4个）

### 4.1 瓦片边界接缝（Tile Seam）
浮点不对齐、LOD 密度差异、纹理采样溢出导致可见缝隙。
- **CesiumJS**：裙边（Skirt）向下延伸遮挡。
- **游戏引擎**：瓦片重叠 1 列。
- **栅格**：clamp-to-edge + 0.5 texel 内缩。

### 4.2 地形 LOD 裂缝（Terrain LOD Cracks）
相邻瓦片不同 LOD 导致 T 型接缝。
- **CesiumJS**：裙边 + 边缘顶点约束。
- **osgEarth**：自适应细分 + LOD 形变过渡。
- **游戏引擎**：Binary Triangle Trees + 每边独立 tessellation factor。

### 4.3 瓦片调度性能（Tile Scheduling）
视口变化时四叉树遍历 + 可见性判断 + 优先级排序计算量大。
- **MapLibre GL**：frustum 剔除 + 距离优先级 + 高 pitch 降低远处缩放级别。
- **CesiumJS**：Screen Space Error 驱动 LOD。
- **deck.gl**：maxRequests 限流 + 最近可见优先。

### 4.4 过缩放（Overzoom）
缩放超过数据源最大级别，栅格模糊/矢量暴露简化误差。
- **MapLibre GL**：overscaleFactorOnMaxZoom 控制级别数。
- **矢量瓦片**：保留原始精度不额外简化。

---

## 5. 矢量渲染问题（4个）

### 5.1 大多边形三角剖分性能
复杂多边形（岛洞、自相交、百万顶点）的三角剖分阻塞帧率。
- **MapLibre GL**：earcut（O(n log n)），Worker 中执行。
- **MLT（MapLibre Tile Format）**：**预三角剖分**——离线完成存入瓦片，客户端零运行时剖分。
- **Felt**：模板缓冲方案避免三角剖分。

### 5.2 宽线渲染（Wide Line）
GPU 不支持 >1px 线段，需扩展为矩形条带 + 处理 join/cap。
- **MapLibre GL**：CPU 端矩形条带，miter/bevel/round join。
- **deck.gl PathLayer**：Vertex Shader 法向量偏移。

### 5.3 跨日期线渲染（Antimeridian）
±180° 日期线处要素错误拉扯或截断。
- **MapLibre GL**：renderWorldCopies 多份世界副本。
- **CesiumJS**：3D 球面无此问题；2D 自动切割。

### 5.4 矢量要素跨瓦片边界
大多边形跨多瓦片被裁剪，需保证边界对齐 + 同一要素 ID 关联。
- **MapLibre GL**：buffer 区域（默认 128px）。
- **deck.gl MVTLayer**：uniqueIdProperty 跨瓦片状态共享。

---

## 6. 文本与标注问题（4个）

### 6.1 标注碰撞检测性能
大量标注 CPU 端 R-Tree 碰撞成为瓶颈（MapLibre iOS 性能严重下降）。
- **deck.gl**：GPU 实时碰撞检测（Compute Shader）。
- **MapLibre GL**：CPU 端，支持 crossSourceCollisions。

### 6.2 沿线标注（Line Label Placement）
路名沿线弯曲放置 + 翻转防止 + 瓦片边界截断。
- **MapLibre GL**：symbol-placement: line/line-center，但弯曲线段碰撞盒偏移。

### 6.3 文字渲染质量
SDF 字体小字号细节丢失，halo 效果严重影响性能（MapLibre Native iOS）。
- **标准方案**：SDF 字体纹理 + Fragment Shader。
- **进阶**：MSDF（Multi-channel SDF）保留尖角。

### 6.4 字形加载
GlyphManager 反复请求缺失字形范围，多语言字形集极大。
- **修复**：字形范围缓存 + 失败标记不重试 + 按 Unicode Block 按需加载。

---

## 7. 相机与交互问题（3个）

### 7.1 地形碰撞检测
相机穿入地形下方。
- 解决：异步地形高度查询 + 相机高度约束 + 平滑插值。

### 7.2 惯性动画
松手后惯性滑动需正确衰减曲线。
- 解决：速度采样 + 指数/弹簧衰减 + rAF 驱动。

### 7.3 2D↔3D 视图过渡
模式切换的平滑过渡。
- **CesiumJS**：morphTo2D/3D/ColumbusView，投影矩阵 + 顶点位置插值动画。
- **Mapbox GL v3**：低缩放自动墨卡托→地球过渡，矩阵混合。

---

## 8. 3D 特有问题（4个）

### 8.1 大气散射
逼真天空渐变、地平线雾化、太阳散射。
- 解决：Rayleigh/Mie 散射模型，Fragment Shader 实时计算或预计算 LUT。

### 8.2 3D Tiles 流式加载与调度
海量 3D 数据按 LOD 流式加载 + 内存预算约束。
- **CesiumJS**：BVH 遍历 + SSE 驱动 LOD + 内存预算管理。

### 8.3 地形与矢量叠加（Terrain Draping）
2D 矢量贴合 3D 地形表面。
- **CesiumJS**：Ground Primitive + 模板缓冲裁剪。
- **deck.gl**：TerrainExtension GPU 高度偏移。

### 8.4 阴影渲染
大范围场景的 shadow map 精度问题。
- 解决：Cascaded Shadow Maps + PCF 软阴影。

---

## 9. 性能与内存问题（4个）

### 9.1 GPU 内存泄漏
瓦片加载/卸载时 Buffer/Texture 未释放。
- 解决：引用计数 + LRU 淘汰 + 显式 destroy() + 定期审计。WebGPU 显式管理更不易泄漏。

### 9.2 Draw Call 数量
大量小几何体独立 draw call → CPU 瓶颈。
- **CesiumJS**：Batching。**deck.gl**：Instanced Rendering。**WebGPU**：Indirect Draw。

### 9.3 大 GeoJSON 加载
10万+ 要素解析 + 三角剖分 + 上传 GPU 耗时数秒。
- **MapLibre GL**：Worker 中 geojson-vt 切片。
- **Mapbox GL**：建议预处理为矢量瓦片。

### 9.4 Shader 编译卡顿
首次使用某材质时 GPU 编译 Shader 导致帧率突降。
- 解决：预编译/预热 + WebGPU createRenderPipelineAsync 异步编译 + Pipeline 缓存。

---

## 10. 样式与视觉效果问题（3个）

### 10.1 矢量线抗锯齿
非水平/垂直角度线锯齿。
- 解决：Fragment Shader SDF 距离场 alpha 解析式抗锯齿。

### 10.2 填充图案
多边形纹理图案在不同缩放级别保持一致密度。
- 解决：Texture Atlas + 视口/世界空间 UV 选择。

### 10.3 数据驱动样式
样式表达式依赖要素属性，CPU 求值性能差。
- **MapLibre GL**：Expression 在 Worker 预求值写入 vertex attribute。
- **更优**：编译为 WGSL 在 GPU 端直接求值。

---

## 11. 平台与兼容性问题（3个）

### 11.1 移动端性能
移动 GPU 带宽/计算力低。
- 解决：激进 LOD + 降渲染分辨率 + 减后处理 Pass + powerPreference: 'high-performance'。

### 11.2 HiDPI / Retina
高 DPI 下渲染分辨率 2-3 倍，性能下降。
- 解决：检测 devicePixelRatio 调整 canvas + 动态分辨率。

### 11.3 WebWorker
重计算需卸载 Worker，OffscreenCanvas 支持不一致。
- WebGPU 支持 Worker 中创建 GPUDevice 和提交命令。

---

## 12. 数据格式与互操作问题（2个）

### 12.1 坐标参考系统多样性
全球数千 CRS，数据源可能使用任意 EPSG。
- **OpenLayers**：proj4js 全支持。**CesiumJS**：仅 WGS84 + Web Mercator。

### 12.2 OGC 标准协议
企业用户需要 WMS/WFS/WMTS/WPS。
- **OpenLayers**：全部原生。**MapLibre GL**：仅 WMTS/TMS。

---

# 第三篇：技术论证 — 三个关键问题

---

## 13. 能否用一套 Shader 同时渲染 2D/2.5D/3D？

**结论：能，通过 Shader 模块组合系统 + Pipeline Variant 缓存。**

不是一个 .wgsl 文件写 if-else（GPU SIMT 架构下分支性能灾难），而是 **Shader Assembler** 将投影/几何/样式三类 WGSL 模块片段在创建 Pipeline 时拼接编译并缓存。

所有模块共享标准函数签名：
```wgsl
fn projectPosition(geoPos: vec3<f32>, camera: CameraUniforms) -> vec4<f32>;  // 投影
fn processVertex(input: VertexInput, projected: vec4<f32>) -> VertexOutput;   // 几何
fn computeColor(input: FragmentInput, style: StyleUniforms) -> vec4<f32>;     // 样式
```

同场景混合：图层 A 用 mercator 投影，图层 B 用 globe 投影，生成不同 Pipeline Variant，在同一帧不同 Draw Call 执行。无分支，无性能损失。

---

## 14. 全部丢给 GPU 是否合理？

**结论：不合理。CPU-GPU 流水线并行，各司其职。**

**GPU 擅长**：大规模并行数值计算（投影变换、顶点变换、像素着色、排序、剔除、碰撞精筛）。

**CPU 必须做**：事件监听/分发（DOM 限制）、瓦片调度（条件分支密集）、数据解码（Protobuf/GeoJSON 串行）、空间索引（R-Tree 树结构）、文字 Shaping（Font 数据库）、CommandBuffer 提交。

**正确模型**：CPU 准备帧 N+1 数据，GPU 同时执行帧 N 渲染。两者流水线并行，永不互等。Worker 池处理数据解码/索引/三角剖分等 CPU 密集任务。

---

## 15. 能否像 Three.js 一样可扩展？

**结论：能，需要在架构第一天定义六个扩展点。**

Three.js 生态繁荣核心：Geometry 可扩展 + Material/Shader 可扩展 + 渲染管线可介入。

GIS 引擎对应六个扩展点：自定义图层（EP1）、自定义投影（EP2）、自定义数据源（EP3）、Shader 钩子（EP4）、自定义 Render Pass（EP5）、自定义交互工具（EP6）。

加上"5 行代码出地图"的低门槛入门 = 生态繁荣的基础。

---

# 第四篇：方案选型 — 从初始方案到最终收敛

---

## 16. 初始五方案（已淘汰）

| 方案 | 核心思路 | 淘汰原因 |
|------|---------|---------|
| 分层抽象统一 | Cesium 式四层，2D/2.5D/3D 是 Scene 层的视图模式 | 2D 场景带 ECEF 开销，不满足"纯 2D 零负担" |
| 图层叠加 | deck.gl 式，底图+渲染层分离 | 不是完整引擎，深度遮挡/交互割裂 |
| 多引擎编排 | TerriaJS 式，MapLibre+Cesium 编排 | 包体巨大，切换割裂，版本同步噩梦 |
| WebGPU 原生 | 纯 WebGPU 从零构建 | 理念正确但方案不够细致 |
| 微内核插件 | Leaflet 式极简核心 + 维度即插件 | 插件间耦合/GL Context 竞争难解 |

## 17. 修订五方案（在 WebGPU-only 约束下）

| 方案 | 核心思路 | 评估 |
|------|---------|------|
| A: 统一世界空间 | 世界始终 3D(ECEF)，2D 只是正交相机 | 纯 2D 有 ECEF 开销 |
| B: 双坐标系统 | 2D/3D 各有最优坐标系，共享渲染管线 | **最务实** |
| C: Scene Graph 分层 | 场景树按维度分支，多 Pass 合成 | **混合渲染最清晰** |
| D: Projection-as-Shader | 投影在 GPU 实时执行 | **投影切换零成本** |
| E: ECS 架构 | 按功能拆 System | **Tree-Shaking 最极致** |

## 18. 最终收敛

**B 的双坐标骨架 + C 的场景分层 + D 的投影 Shader + E 的功能级拆包** = GeoForge 架构。

---

# 第五篇：完整架构设计 — 纳入 34 个问题的七层架构

---

## 19. 设计约束（锁定）

1. 一个引擎，满足所有维度需求
2. 只要 2D 就只打包 2D，要 3D 才打包 3D
3. 同一场景中 2D/2.5D/3D 可共存渲染
4. 纯 WebGPU（2026年1月所有主流浏览器已默认启用）
5. 对标 Three.js 的扩展生态

---

## 20. 七层架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ L6  预设层                                                              │
│  preset-2d(Map2D) │ preset-25d(Map25D) │ preset-3d(Globe3D)            │
│  preset-full(MapFull)  — 零新逻辑，纯组装+默认配置+逃生舱口           │
├─────────────────────────────────────────────────────────────────────────┤
│ L5  扩展层                                                              │
│  ExtensionRegistry（统一注册中心）                                      │
│  EP1 CustomLayer(生命周期+Context注入+错误隔离)                         │
│  EP2 ProjectionModule(GPU WGSL+CPU双端+瓦片网格+日期线)                │
│  EP3 DataSource(瓦片/要素/实时流+缓存控制+元数据)                      │
│  EP4 ShaderHook(9个钩子点+优先级+依赖管理)                             │
│  EP5 PostProcessPass(链式后处理+resize+开关)                           │
│  EP6 InteractionTool(事件消费链+overlay渲染+结果事件)                  │
├─────────────────────────────────────────────────────────────────────────┤
│ L4  场景层                                                              │
│  SceneGraph │ LayerManager(zIndex/beforeId) │ SourceManager             │
│  StyleEngine(表达式→WGSL) │ LabelManager(全局碰撞:CPU粗筛+GPU精筛)    │
│  GlyphManager(MSDF+Unicode Block按需加载) │ FeatureStateManager        │
│  AntiMeridianHandler │ AnimationManager │ SpatialQuery │ A11yManager   │
├─────────────────────────────────────────────────────────────────────────┤
│ L3  调度层                                                              │
│  FrameScheduler(backgroundMode省电) │ TileScheduler(SSE+pitch调整)    │
│  WorkerPool(12种任务类型) │ ResourceManager │ MemoryBudget(GPU+CPU)    │
│  RequestScheduler(限流+优先级) │ ErrorRecovery(重试/重启/设备恢复)     │
├─────────────────────────────────────────────────────────────────────────┤
│ L2  渲染层                                                              │
│  RenderGraph(DAG+自动Pass合并) │ ShaderAssembler(模块+Hook+变体)      │
│  PipelineCache(异步预编译) │ DepthManager(reversedZ+logDepth)          │
│  Compositor(多投影合成) │ PickingEngine(color-ID) │ StencilManager     │
│  RenderStats(drawCall/三角形/GPU时间)                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ L1  GPU 层                                                              │
│  DeviceManager(能力检测+vendorId workaround+丢失恢复)                  │
│  BufferPool(StagingRing环形上传) │ TextureManager(DynamicAtlas)        │
│  GPUMemoryTracker(引用计数+LRU+审计) │ IndirectDrawManager             │
├─────────────────────────────────────────────────────────────────────────┤
│ L0  基础层                                                              │
│  CoordinateSystem(CRS注册表) │ Projection(可插拔接口)                  │
│  PrecisionManager(SplitDouble+RTC) │ Math(vec/mat/bbox/frustum)       │
│  EventBus │ IdGenerator │ Logger(分级+性能标记) │ Config │ Types       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 21. L0 基础层详细设计

### 模块清单（9个，全部必选）

| 模块 | 职责 | 解决问题 |
|------|------|---------|
| CoordinateSystem | CRS 注册表、坐标转换管线 | #12.1 |
| Projection | 投影接口定义 + 内置墨卡托/WGS84 | #12.1 |
| PrecisionManager | Split-Double + RTC 中心点管理 | #3.1 |
| Math | vec2/3/4, mat3/4, BBox, Frustum, 插值 | 全局 |
| EventBus | 类型安全发布-订阅 | 全局 |
| IdGenerator | 全局唯一 ID（要素/图层/GPU 资源） | 全局 |
| Logger | 分级日志 + performance.mark 集成 | 诊断 |
| Config | 全局配置（DPR 策略/内存预算/Worker 数量） | 全局 |
| Types | TypeScript 类型定义 | 全局 |

### 关键接口：ProjectionModule

```typescript
interface ProjectionModule {
  readonly id: string;
  readonly epsg?: string;
  readonly wgslCode: string;               // GPU 端 fn projectPosition(...)
  readonly bounds: BBox2D;
  readonly isGlobal: boolean;
  readonly requiresDoublePrecision: boolean;
  readonly wrapsX: boolean;
  readonly antimeridianHandling: 'split' | 'wrap' | 'none';
  project(lon: number, lat: number): [x: number, y: number];
  unproject(x: number, y: number): [lon: number, lat: number];
  tileGrid?: TileGridDefinition;
}
```

---

## 22. L1 GPU 层详细设计

### 模块清单（5个，全部必选）

| 模块 | 职责 | 解决问题 |
|------|------|---------|
| DeviceManager | GPUAdapter/Device、能力检测、丢失恢复 | #3.3 |
| BufferPool | Buffer 对象池 + StagingRing 环形上传 | #9.1 |
| TextureManager | Texture 生命周期 + DynamicAtlas 打包 | #9.1, #10.2 |
| GPUMemoryTracker | 内存追踪、LRU 淘汰、孤立资源审计 | #9.1 |
| IndirectDrawManager | Indirect Draw Buffer 管理 | #9.2 |

---

## 23. L2 渲染层详细设计

### 模块清单（7个，全部必选）

| 模块 | 职责 | 解决问题 |
|------|------|---------|
| RenderGraph | 帧 Pass DAG + 自动合并同投影 Pass | 全局渲染 |
| ShaderAssembler | 模块拼接 + Hook 注入 + 变体缓存 | 一套 Shader 多维度 |
| PipelineCache | Pipeline 缓存 + 异步预编译预热 | #9.4 |
| DepthManager | Reversed-Z + 对数深度缓冲 | #3.2 |
| Compositor | 多 Pass 深度合成（多投影共存时） | 混合渲染 |
| PickingEngine | Color-ID picking + 异步 mapAsync | 交互 |
| StencilManager | 模板缓冲状态管理 | #5.1, #8.3 |
| RenderStats | draw call/三角形/GPU 时间/Pass 数统计 | 诊断 |

### RenderGraph 每帧 DAG

```
Compute Pass → Render Passes(按投影分组，同投影合并) → Compositing → PostProcess 链 → Screen Pass → Present
```

---

## 24. L3 调度层详细设计

### 模块清单（7个，全部必选）

| 模块 | 职责 | 解决问题 |
|------|------|---------|
| FrameScheduler | rAF + 帧预算 + backgroundMode 省电 | CPU-GPU 并行 |
| TileScheduler | SSE + frustum cull + pitch 调整 + 优先级 | #4.3, #4.4 |
| WorkerPool | 12 种任务类型的 Worker 池 | #11.3 |
| ResourceManager | 资源加载、缓存、生命周期 | 全局 |
| MemoryBudget | GPU+CPU 内存预算 + 淘汰策略 | #9.1 |
| RequestScheduler | 网络请求限流 + 优先级排队 | #4.3 |
| ErrorRecovery | 瓦片重试、Worker 重启、GPU 设备恢复 | 健壮性 |

### WorkerPool 12 种任务类型

MVT 解码、栅格解码、GeoJSON 解析、三角剖分（earcut）、简化（Douglas-Peucker）、R-Tree 构建/查询、标注碰撞粗筛、文字 Shaping、双精度拆分、地形网格生成、geojson-vt 切片、3DTiles BVH 遍历。

---

## 25. L4 场景层详细设计

### 模块清单（10个，全部必选）

| 模块 | 职责 | 解决问题 |
|------|------|---------|
| SceneGraph | 场景树（多投影子树） | 混合渲染 |
| LayerManager | 图层注册/排序(zIndex/beforeId)/可见性 | 全局 |
| SourceManager | 数据源注册、多协议适配 | #12.2 |
| StyleEngine | 样式表达式求值 → 编译为 WGSL | #10.3 |
| LabelManager | 全局标注碰撞（CPU 粗筛 + GPU 精筛） | #6.1, #6.2 |
| GlyphManager | MSDF 字体 + Unicode Block 按需加载 | #6.3, #6.4 |
| FeatureStateManager | 跨瓦片要素状态同步 | #5.4 |
| AntiMeridianHandler | 日期线几何切割 + 世界副本 | #5.3 |
| AnimationManager | 图层属性动画 + 时间轴控制 | 全局 |
| SpatialQuery | 像素/BBox/多边形空间查询 | 交互 |
| A11yManager | 键盘导航 + ARIA + 屏幕阅读器 | 无障碍 |

---

## 26. L5 扩展层详细设计

### ExtensionRegistry（统一注册中心）

所有扩展通过 `registerXxx()` 注册、`getXxx()` 查询、`unregister()` 卸载。支持运行时枚举已注册扩展和注册/卸载事件通知。

### EP1 自定义图层

完整生命周期：onAdd(context) → render(encoder, camera) → onRemove()。通过 `CustomLayerContext` 注入 device/bufferPool/textureManager/precision 等引擎服务。可选 preCompute() 在 Render 前执行 Compute Pass。声明 projection 归属（决定放入哪个 Render Pass 分组）。错误隔离（try-catch）。

### EP2 自定义投影

GPU 端 WGSL 函数 + CPU 端 project/unproject + 元数据（bounds/wrapsX/tileGrid）。用户可实现 GCJ-02、UTM、Lambert 等任意投影。

### EP3 自定义数据源

瓦片型（loadTile）/ 要素型（loadFeatures）/ 实时流（subscribe）三种模式。通过 `SourceContext` 获取引擎的 requestScheduler/workerPool/cache。返回 SourceMetadata（CRS/范围/缩放/schema）。社区可实现 WMS/WFS/WMTS/PMTiles 适配器。

### EP4 Shader 钩子

9 个钩子点覆盖 Vertex/Fragment/Compute 三阶段关键位置。优先级排序 + 依赖管理。ShaderAssembler 在编译时将同一钩子点的代码按优先级拼接注入。

### EP5 自定义后处理 Pass

链式后处理：每个 Pass 接收上一个的输出纹理，输出到自己的纹理。order 控制位置，enabled 运行时开关。RenderGraph 自动管理 Pass 间纹理生命周期。

### EP6 自定义交互工具

事件消费链：activeTool → defaultTools → map default behavior。返回 true 表示已消费，阻止冒泡。支持 overlay 渲染（绘制辅助线/测量标注）。InteractionManager 管理工具激活/停用/切换。

---

## 27. L6 预设层详细设计

### 四个预设包

| 预设 | 内含 | 入口类 | 体积 |
|------|------|--------|------|
| preset-2d | core+gpu+runtime+scene+proj-mercator+camera-2d+layer-tile-raster+layer-tile-vector+layer-geojson+layer-marker+compat-hidpi | Map2D | ~120KB gz |
| preset-25d | preset-2d + proj-perspective+camera-25d+layer-extrusion | Map25D(extends Map2D) | ~155KB gz |
| preset-3d | core+gpu+runtime+scene+proj-globe+camera-3d+globe+layer-terrain+layer-3dtiles+view-morph+compat-hidpi | Globe3D | ~195KB gz |
| preset-full | 所有 preset + 所有图层/交互/后处理/数据源 | MapFull(setMode) | ~350KB gz |

### 设计原则

1. **零新逻辑**：只做模块组装和默认配置
2. **可拆解**：用户可从 preset 起步，逐步替换为直接引用底层模块
3. **逃生舱口**：永远暴露 renderer/scene/camera 供高级用户直接操作
4. **默认值合理**：开箱即"能用且好用"

### 入口 API 示例

```typescript
// 5行代码出2D地图
import { Map } from '@geoforge/preset-2d';
const map = new Map({ container: 'map', center: [116.4, 39.9], zoom: 10, style: '...' });

// 5行代码出3D地球
import { Globe } from '@geoforge/preset-3d';
const globe = new Globe({ container: 'globe', terrain: '...', imagery: '...' });

// 全功能 + 运行时切换
import { Map } from '@geoforge/preset-full';
const map = new Map({ container: 'map', mode: '2d' });
map.setMode('3d', 2000);  // 2 秒过渡动画
```

---

## 28. CPU-GPU 流水线完整时序

```
时间 ──────────────────────────────────────────────────────────▶

CPU Main ┌─────────────────────────────┐ ┌────────────────
         │ 事件处理 → 相机更新 → 脏检测 │ │ ...
         │ → Pipeline 查找 → Uniform  │ │
         │   更新 → CommandBuffer 构建 │ │
         │ → queue.submit()           │ │
         └────────────┬──────────────┘ │
                      │                 │
GPU      ┌────────────▼──────────────┐ │
         │ Compute: 剔除+排序+碰撞   │ │
         │ Render: 各投影 Pass        │ │
         │  (reversedZ+logDepth      │ │
         │   +splitDouble+SDF线      │ │
         │   +MSDF文字+IndirectDraw) │ │
         │ Compositing → PostProcess │ │
         │ → Screen → Picking → 显示 │ │
         └───────────────────────────┘ │

Worker   ┌─────────────────────────────────────────────
(持续)   │ MVT/PBF解码 │ GeoJSON解析+geojson-vt切片
         │ earcut三角剖分 │ R-Tree构建/查询
         │ 文字Shaping │ 双精度拆分 │ 地形网格生成
         │ 3DTiles BVH遍历 │ Douglas-Peucker简化
         │ 日期线切割 │ 标注碰撞粗筛
         └─────────────────────────────────────────────
```

---

## 29. 34 个问题覆盖验证

| # | 问题 | 归属层/模块 | 解决方案 |
|---|------|-----------|---------|
| 3.1 | 浮点抖动 | L0/PrecisionManager + L2/ShaderAssembler | SplitDouble + RTC |
| 3.2 | Z-Fighting | L2/DepthManager | Reversed-Z + 对数深度 |
| 3.3 | GPU 驱动差异 | L1/DeviceManager | 能力检测 + vendorId workaround |
| 4.1 | 瓦片接缝 | layer-tile-raster, layer-terrain | 裙边 + texel 内缩 |
| 4.2 | LOD 裂缝 | layer-terrain | 边缘约束 + 形变过渡 + Compute 细分 |
| 4.3 | 瓦片调度 | L3/TileScheduler + RequestScheduler | SSE + 优先级 + 限流 |
| 4.4 | 过缩放 | L3/TileScheduler | 矢量保精度 + 栅格插值 |
| 5.1 | 三角剖分 | layer-tile-vector + L3/WorkerPool | MLT 预剖分 + Worker earcut + 模板缓冲 |
| 5.2 | 宽线渲染 | layer-tile-vector | Compute Shader 条带 + SDF 抗锯齿 |
| 5.3 | 日期线 | L4/AntiMeridianHandler | 几何切割 + 世界副本 |
| 5.4 | 跨瓦片要素 | L4/FeatureStateManager | 要素 ID 全局映射 + buffer 区域 |
| 6.1 | 标注碰撞 | L4/LabelManager | CPU R-Tree 粗筛 + GPU Compute 精筛 |
| 6.2 | 沿线标注 | L4/LabelManager | 全局管理器（不受瓦片边界限制） |
| 6.3 | 文字渲染 | L4/GlyphManager + L2/ShaderAssembler | MSDF 字体 + Fragment Shader |
| 6.4 | 字形加载 | L4/GlyphManager | Unicode Block 按需加载 + 失败标记 |
| 7.1 | 地形碰撞 | camera-3d | 异步高度查询 + 相机约束 + 平滑插值 |
| 7.2 | 惯性动画 | camera-2d/25d/3d | 速度采样 + 指数衰减 + rAF |
| 7.3 | 视图过渡 | view-morph | 投影矩阵插值 + 顶点位置插值 |
| 8.1 | 大气散射 | globe | Rayleigh/Mie + 预计算 LUT |
| 8.2 | 3DTiles | layer-3dtiles + L3/WorkerPool | BVH(Worker) + SSE + 内存预算 |
| 8.3 | 地形叠加 | layer-terrain + L2/StencilManager | 模板缓冲 + GPU 高度采样 |
| 8.4 | 阴影 | globe + postprocess-shadow | CSM + PCF |
| 9.1 | 内存泄漏 | L1/GPUMemoryTracker + L3/MemoryBudget | 引用计数 + LRU + 预算 + 审计 |
| 9.2 | Draw Call | L1/IndirectDrawManager + L2/RenderGraph | 实例化 + IndirectDraw + GPU 剔除 |
| 9.3 | 大 GeoJSON | layer-geojson + L3/WorkerPool | Worker 流式解析 + geojson-vt |
| 9.4 | Shader 编译 | L2/PipelineCache + ShaderAssembler | 异步预编译 + 缓存 |
| 10.1 | 线抗锯齿 | L2/ShaderAssembler (sdf_line feature) | SDF distance field alpha |
| 10.2 | 填充图案 | L1/TextureManager(DynamicAtlas) | TextureAtlas + UV 选择 |
| 10.3 | 数据驱动样式 | L4/StyleEngine + L2/ShaderAssembler | 表达式编译为 WGSL |
| 11.1 | 移动端 | compat-mobile + L1/DeviceManager | 能力检测 + 降质 + 激进 LOD |
| 11.2 | HiDPI | compat-hidpi | DPR 适配 + 动态分辨率 |
| 11.3 | Worker | L3/WorkerPool | 12 种任务 + WebGPU Worker |
| 12.1 | CRS 多样性 | L0/CoordinateSystem + Projection | 可插拔投影模块（EP2） |
| 12.2 | OGC 协议 | source-wmts/wms/wfs | EP3 DataSource 扩展 |

**34/34 全部覆盖。**

---

## 30. 包分割与体积

### Monorepo 核心包（必选，~67KB gz）

| 包 | 层 | 体积 |
|---|---|------|
| @geoforge/core | L0 | ~10KB |
| @geoforge/gpu | L1+L2 | ~30KB |
| @geoforge/runtime | L3 | ~15KB |
| @geoforge/scene | L4 | ~12KB |

### 可选功能包

| 包 | 体积 | 用途 |
|---|------|------|
| proj-mercator | ~2KB | 墨卡托投影 |
| proj-globe | ~3KB | 地球球面投影 |
| proj-perspective | ~2KB | 2.5D 透视 |
| camera-2d | ~5KB | 正交相机+惯性 |
| camera-25d | ~6KB | 透视相机+pitch |
| camera-3d | ~8KB | 轨道相机+地球导航+地形碰撞 |
| layer-tile-raster | ~10KB | 栅格瓦片+接缝处理 |
| layer-tile-vector | ~35KB | 矢量瓦片+宽线+三角剖分 |
| layer-geojson | ~10KB | GeoJSON+geojson-vt |
| layer-heatmap | ~5KB | 热力图 |
| layer-3dtiles | ~25KB | 3DTiles+BVH+LOD |
| layer-terrain | ~18KB | 地形+LOD裂缝+细分+贴合 |
| layer-pointcloud | ~10KB | 点云+Eye-Dome Lighting |
| layer-marker | ~8KB | 标注/图标 |
| layer-extrusion | ~8KB | 建筑拉伸 |
| globe | ~22KB | 椭球体+大气+星空+阴影 |
| view-morph | ~5KB | 2D↔3D 视图过渡 |
| interaction-draw | ~6KB | 绘制工具 |
| interaction-measure | ~4KB | 测量工具 |
| interaction-select | ~4KB | 框选工具 |
| postprocess-bloom | ~3KB | Bloom |
| postprocess-ssao | ~5KB | SSAO |
| postprocess-shadow | ~5KB | 阴影 |
| source-wmts | ~5KB | WMTS 数据源 |
| source-wms | ~5KB | WMS 数据源 |
| source-wfs | ~8KB | WFS 数据源 |
| source-pmtiles | ~5KB | PMTiles |
| compat-hidpi | ~2KB | HiDPI 适配 |
| compat-mobile | ~3KB | 移动端调优 |

### 典型打包体积

| 场景 | gzipped |
|------|---------|
| 最简 2D 栅格地图 | ~85KB |
| 2D 矢量地图 | ~120KB |
| 2.5D 城市 | ~155KB |
| 3D 数字地球 | ~195KB |
| 全功能 | ~350KB |

---

## 31. 模块总计

| 层 | 模块数 | 必选/可选 |
|---|--------|----------|
| L0 基础层 | 9 | 全部必选 |
| L1 GPU 层 | 5 | 全部必选 |
| L2 渲染层 | 8 | 全部必选 |
| L3 调度层 | 7 | 全部必选 |
| L4 场景层 | 11 | 全部必选 |
| L5 扩展层 | 7（注册中心+6个EP接口）| 接口必选，实现可选 |
| L6 预设层 | 4 个预设包 | 全部可选 |
| 核心合计 | **48** | |
| 可选功能包 | **29** | |
| **总计** | **77** | |

---

## 32. 下一步：进入架构设计

本文档是架构设计前的**完整方案确认文档**。确认后进入：

1. **TypeScript 核心接口定义** — L0 到 L6 每个模块的 public API
2. **Render Graph 详细设计** — Pass DAG、资源生命周期、自动 Pass 合并规则
3. **Shader Assembler 实现** — 模块注册、拼接语法、Hook 系统、变体管理、编译缓存
4. **数据流端到端** — 从 `map.addLayer()` 到 GPU 像素输出的完整路径
5. **最小可行原型** — WebGPU Canvas 渲染一个墨卡托栅格瓦片
