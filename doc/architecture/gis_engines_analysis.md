# 开源 GIS 引擎全景分析：特点与设计理念

---

## 一、你已知的六大引擎

---

### 1. Leaflet

**GitHub**: https://github.com/Leaflet/Leaflet  
**维度**: 纯 2D  
**体积**: ~42KB gzipped  
**渲染方式**: DOM/SVG/Canvas  
**协议**: BSD 2-Clause

**核心设计理念**：**极简主义 + 插件生态**

Leaflet 的哲学可以用一句话概括："只做核心，其余交给社区"。它是所有主流 Web GIS 引擎中最轻量的，刻意保持核心代码的精简，只包含地图展示最基本的能力——瓦片加载、矢量叠加、标注、弹窗、交互控制。

**架构特点**：
- **模块化类继承体系**：基于自定义的 Class 系统（v2.0 已迁移到 ES6 原生 class），所有组件（Layer、Control、Handler）从统一基类派生
- **事件驱动松耦合**：通过 Evented 基类提供一致的事件系统，底层 DOM 事件逐层冒泡到 Map 实例
- **插件即扩展点**：不需要注册机制，任何 JS 代码只要扩展 Leaflet 的类层次即可成为插件，目前社区有 700+ 插件
- **v2.0 现代化**：从全局 `L` 命名空间迁移到 ESM 模块化导入，支持 tree shaking

**适用场景**：轻量级 2D 地图展示、快速原型、嵌入式地图、移动端友好的交互地图

**局限**：无 WebGL 渲染，不支持 3D 或 2.5D 原生能力，大数据量场景依赖插件

---

### 2. OpenLayers

**GitHub**: https://github.com/openlayers/openlayers  
**维度**: 2D（部分 WebGL 加速）  
**渲染方式**: Canvas 2D + WebGL  
**协议**: BSD 2-Clause

**核心设计理念**：**全功能 GIS 工具箱 + OGC 标准完整支持**

OpenLayers 的定位与 Leaflet 截然相反——它追求的是"开箱即有一切"的企业级 GIS 能力。从 2006 年诞生以来，它一直是 Web GIS 领域功能最完备的开源库。

**架构特点**：
- **面向对象 + 事件驱动**：严格的 OOP 设计，类与类之间通过事件通信
- **多渲染后端**：Canvas 2D 为主，矢量图层已支持 WebGL 加速渲染，可在运行时切换
- **OGC 协议全覆盖**：原生支持 WMS、WFS、WMTS、WPS，无需任何插件
- **投影系统完备**：内置多种投影支持，可与 proj4js 集成处理任意坐标系
- **矢量瓦片原生支持**：支持 MVT（Mapbox Vector Tiles）格式
- **Tree Shaking 友好**：高度模块化，只打包使用到的代码

**适用场景**：企业级 GIS 应用、需要复杂空间分析和 OGC 服务集成的项目、数据密集型地图

**局限**：学习曲线陡峭，包体较重，3D 能力有限（仅 2.5D 倾斜视角实验性支持）

---

### 3. Cesium (CesiumJS)

**GitHub**: https://github.com/CesiumGS/cesium  
**维度**: 3D 地球 + 2D 地图 + 2.5D 哥伦布视图  
**渲染方式**: WebGL  
**协议**: Apache 2.0

**核心设计理念**：**高精度虚拟地球 + 开放格式 + 时空动态可视化**

CesiumJS 源于 2011 年 AGI（现 Cesium GS）对航天卫星轨道浏览器端实时可视化的需求。它的核心理念是"在浏览器中精确呈现真实地球"，以 WGS84 椭球体为基础，不存在墨卡托投影在高纬度的形变。

**架构特点（四层分层）**：
- **Core 层**：线性代数、相交检测、插值等数学运算
- **Renderer 层**：WebGL 的薄封装层
- **Scene 层**：地球、影像图层、多边形、相机、材质等高级构件
- **Dynamic Scene 层**：时间动态可视化，CZML 渲染
- **开放格式驱动**：3D Tiles（OGC 标准）、glTF、CZML、KML 等
- **三种视图模式**：3D 地球、2D 地图、2.5D Columbus View，可运行时无缝切换
- **Open-Core 商业模式**：引擎开源，Cesium ion 云服务提供瓦片托管和流式传输

**适用场景**：数字孪生、航空航天、智慧城市、大规模 3D Tiles 场景、时空模拟

**局限**：包体大（~532KB gzipped），2D 地图能力相比 Leaflet/OpenLayers 薄弱，配合 Cesium ion 效果最佳

---

### 4. deck.gl

**GitHub**: https://github.com/visgl/deck.gl  
**维度**: 2D / 2.5D / 3D  
**渲染方式**: WebGL2 / WebGPU（实验性）  
**协议**: MIT

**核心设计理念**：**GPU 驱动的大规模数据可视化图层系统**

deck.gl 由 Uber 可视化团队创建（现归属 OpenJS Foundation 的 vis.gl 框架族），它不是传统意义上的"地图引擎"，而是一个**可视化图层框架**。它的核心思想是：地图只是底图，真正有价值的是在底图上高性能渲染的数据图层。

**架构特点**：
- **图层抽象**：一切皆 Layer。ScatterplotLayer、ArcLayer、HexagonLayer、TileLayer 等 60+ 内置图层
- **与底图解耦**：可叠加在 MapLibre、Mapbox、Google Maps 之上，也可独立使用
- **GPU 实例化渲染**：通过 luma.gl 底层，实现百万级数据点的 60fps 交互
- **React 友好**：声明式 API，props 驱动的图层更新
- **属性动画系统**：内置 transition 和 spring 动画
- **可扩展**：Extension 机制（BrushingExtension、DataFilterExtension 等）
- **WebGPU 前瞻**：已在部分图层实验性支持 WebGPU

**适用场景**：出行数据可视化、城市热力图、轨迹分析、大规模散点/弧线/六边形聚合

**局限**：不提供地图基础能力（需配合底图库），非传统 GIS 工作流，3D 地球能力不如 Cesium

---

### 5. MapLibre GL JS

**GitHub**: https://github.com/maplibre/maplibre-gl-js  
**维度**: 2D + 2.5D（pitch/bearing 倾斜）  
**渲染方式**: WebGL  
**协议**: BSD 3-Clause

**核心设计理念**：**Mapbox GL 的开源延续 + 矢量瓦片优先 + 样式规范驱动**

MapLibre 诞生于 2020 年末 Mapbox GL JS 转向非开源许可后的社区分叉。它继承了 Mapbox GL JS 的核心理念：**一切围绕 Mapbox Style Specification 运转**。

**架构特点**：
- **样式规范驱动**：整个渲染管线由 JSON 样式规范声明式驱动，数据源、图层类型、过滤器、表达式全部在样式中定义
- **矢量瓦片原生**：为 MVT（Mapbox Vector Tiles）量身设计的渲染管线
- **WebGL 全量渲染**：所有内容（文字、图标、线、面、栅格）均通过 WebGL 渲染，而非 DOM
- **Pitch/Bearing 倾斜**：支持地图倾斜和旋转，呈现 2.5D 透视效果
- **Camera 动画**：flyTo、easeTo 等平滑相机过渡
- **社区治理**：Linux Foundation 旗下，开放治理，避免单一公司锁定

**适用场景**：自定义样式地图、矢量瓦片服务、移动端高性能地图、替代 Mapbox GL 的开源方案

**局限**：不支持真正的 3D 地球，数据分析能力不如 deck.gl，GIS 专业功能不如 OpenLayers

---

### 6. Mapbox GL JS

**GitHub**: https://github.com/mapbox/mapbox-gl-js  
**维度**: 2D + 2.5D + 3D（v3 支持地球和 3D 地形）  
**渲染方式**: WebGL  
**协议**: 专有许可（v2.0+ 非开源）

**核心设计理念**：**设计驱动 + 性能优先 + 商业地图平台**

Mapbox GL JS 是矢量瓦片 Web 渲染的开创者。v3 版本引入了 Globe View（3D 地球投影）、3D 地形、大气效果、动态光照等特性，是目前视觉效果最精美的 Web 地图引擎之一。

**架构特点**：
- **Standard Style**：v3 推出标准样式，支持 3D 建筑、地标、动态光照
- **Globe View**：在低缩放级别以 3D 球体展示地球
- **3D Terrain**：实时地形起伏渲染
- **60fps 优化**：资源加载优先级调度、任务分发，即使在移动端也保持流畅
- **多投影支持**：随缩放级别自适应投影

**适用场景**：商业地图产品、强调设计感的地图应用、需要 3D 地形的场景

**局限**：v2.0+ 非开源，必须使用 Mapbox 服务，商业项目需付费

---

## 二、搜索发现的其他引擎

---

### 7. MapTalks.js / maptalks-gl

**GitHub**: https://github.com/maptalks/maptalks.js  
**维度**: 2D / 3D 统一  
**渲染方式**: Canvas 2D + WebGL + WebGPU（升级中）  
**协议**: MIT  
**Stars**: ~4.2k

**核心设计理念**：**2D/3D 一体化 + 插件化架构 + 易用优先**

MapTalks 是一个中国团队开发的 GIS 引擎，最显著的设计理念是"**2D 和 3D 不应该是两个世界**"。它从一开始就设计为同一个 Map 实例上可以同时叠加 2D Canvas 图层和 3D WebGL 图层。

**架构特点**：
- **GroupGLLayer**：将多个 WebGL 图层打包为一个 GL 组，统一管理渲染上下文
- **正在升级为 maptalks-gl**：纯 WebGL/WebGPU 驱动的新引擎，API 向后兼容
- **插件体系丰富**：maptalks.three（Three.js 集成）、maptalks.d3、maptalks.echarts 等
- **内置 GIS 工具**：DrawTool、Editor、MeasureTool 等开箱即用
- **矢量瓦片 + 3DTiles**：新版 GL 引擎原生支持 MVT 和 3DTiles
- **GLTF 模型加载**：GLTFLayer + GLTFMarker 直接在地图上放置 3D 模型

**适用场景**：需要 2D/3D 混合展示的项目、中国开发者友好、快速搭建地图应用

**局限**：国际社区相对小，maptalks-gl 仍在积极开发中

---

### 8. Tangram

**GitHub**: https://github.com/tangrams/tangram  
**维度**: 2D / 3D  
**渲染方式**: WebGL  
**协议**: MIT  
**Stars**: ~2.2k

**核心设计理念**：**创意制图 + GLSL 着色器驱动 + 场景文件声明式配置**

Tangram 的理念非常独特——它想把 3D 动画、视频游戏、CAD 等视觉学科的技术带入地图领域。它不是为传统 GIS 分析设计的，而是为**艺术化、创意化的地图表现**设计的。

**架构特点**：
- **Scene File（YAML）驱动**：所有数据源、图层、过滤器、样式都在 YAML 场景文件中声明
- **GLSL 着色器内联**：可以直接在场景文件中编写 GLSL 代码，实现自定义渲染效果
- **Leaflet 插件**：通过 `Tangram.leafletLayer` 集成到 Leaflet 生态
- **矢量瓦片消费**：从矢量瓦片源实时绘制，而非加载传统栅格瓦片
- **Tangram ES**：C++ 原生移动端版本（OpenGL ES）

**适用场景**：艺术化地图设计、数据新闻可视化、创意制图项目

**局限**：社区活跃度下降，不适合传统 GIS 工作流，3D 能力有限

---

### 9. harp.gl

**GitHub**: https://github.com/heremaps/harp.gl  
**维度**: 2D / 3D  
**渲染方式**: WebGL（Three.js）  
**协议**: Apache 2.0  
**Stars**: ~1.3k

**核心设计理念**：**Three.js 之上的 3D 地图渲染引擎 + HERE 地图数据管线**

harp.gl 是 HERE Maps 出品的开源 3D 地图渲染引擎。它的核心思路是"不重复造渲染引擎的轮子"——直接构建在 Three.js 之上，利用 Three.js 成熟的 3D 渲染能力。

**架构特点**：
- **TypeScript 全栈**：纯 TypeScript 编写，类型安全
- **Three.js 底座**：可以利用 Three.js 生态的所有能力（后处理、自定义着色器、3D 模型等）
- **主题系统**：JSON-based 主题定义地图样式
- **Web Worker 解码**：瓦片解码在 Worker 线程中异步执行
- **HERE 数据集成**：为 HERE 矢量瓦片和地理编码服务优化

**适用场景**：需要深度 Three.js 集成的 3D 地图、HERE 生态用户

**局限**：项目活跃度下降（HERE 已将部分精力转向其他方案），社区较小

---

### 10. flywave.gl

**GitHub**: https://github.com/flywave/flywave.gl  
**维度**: 3D  
**渲染方式**: WebGL（Three.js）  
**协议**: MIT  
**Stars**: ~100+

**核心设计理念**：**模块化 Monorepo + Three.js 底座 + 高性能 3D 地图渲染**

flywave.gl 是一个较新的项目，采用模块化 monorepo 架构，目标是提供高性能、可扩展的 3D 地图渲染方案。

**架构特点**：
- **Monorepo + pnpm**：各功能模块独立包，按需引入
- **Three.js 基础**：利用 Three.js 渲染管线
- **Web Worker 并行**：CPU 密集任务放入 Worker 执行
- **多数据源支持**：支持 ArcGIS、MVT、3DTiles 等
- **球面投影**：支持 sphereProjection 地球模式
- **动态主题切换**：运行时切换地图风格

**适用场景**：中国开发者的 3D 地图项目、需要模块化定制的场景

**局限**：项目早期，社区和文档尚不成熟

---

### 11. OpenGlobus

**GitHub**: https://github.com/openglobus/openglobus  
**维度**: 3D 地球  
**渲染方式**: 纯 WebGL（无 Three.js 依赖）  
**协议**: MIT  
**Stars**: ~1.3k

**核心设计理念**：**纯 WebGL 的轻量 3D 地球引擎 + 工业级精度**

OpenGlobus 强调"纯 WebGL"——它不依赖 Three.js 或任何第三方渲染库，自己从零构建渲染管线。目标是提供高精度的行星表面 3D 可视化。

**架构特点**：
- **自建渲染管线**：完全控制 WebGL 调用，避免第三方库的开销和限制
- **TypeScript 重写**：从 JS 迁移到 TS，提升代码质量
- **高精度地形**：支持多种地形数据提供商
- **影像图层叠加**：支持 WMS、TMS 等影像源
- **动态矢量数据**：GeoJSON 渲染，支持海量 3D 对象
- **React 集成**：提供 openglobus-react 包

**适用场景**：需要轻量 3D 地球、不想依赖 Three.js 的项目、行星科学可视化

**局限**：功能不如 Cesium 丰富，社区较小，无 3D Tiles 原生支持

---

### 12. iTowns

**GitHub**: https://github.com/iTowns/itowns  
**维度**: 3D 地球 + 局部 3D 场景  
**渲染方式**: WebGL（Three.js）  
**协议**: MIT + CeCILL-B  
**Stars**: ~1.2k

**核心设计理念**：**法国 IGN 出品的研究级 3D 地理空间框架 + 点云/3DTiles 专长**

iTowns 源于法国国家地理与林业信息研究所（IGN）的 MATIS 实验室，最初设计用于街景影像和地面激光雷达点云的 3D 可视化。

**架构特点**：
- **Three.js 深度集成**：直接暴露 Three.js renderer 和 camera，可自由扩展
- **GlobeView + PlanarView**：支持地球模式和局部平面模式
- **3D Tiles 强支持**：C3DTilesLayer 专门处理 3D Tiles 加载和交互
- **点云渲染**：LAS/LAZ 格式原生支持（通过 COPC）
- **OGC 服务集成**：WMS、WMTS、WFS、TMS
- **WebXR 支持**：VR 控制器支持
- **Monorepo 演进**：正在向子模块化组织迁移（@itowns/geographic 等）

**适用场景**：城市 3D 建模、点云可视化、3D Tiles 浏览、学术研究

**局限**：文档和示例主要面向法语社区，API 变化较频繁

---

### 13. VTS Browser JS

**GitHub**: https://github.com/melowntech/vts-browser-js  
**维度**: 3D 地球  
**渲染方式**: WebGL  
**协议**: BSD 2-Clause  
**Stars**: ~200+

**核心设计理念**：**全栈 3D 地理平台的浏览器端 + 极小体积**

VTS Browser JS 是 VTS 3D Geospatial Software Stack 的前端部分。它的独特之处是在仅约 163KB gzipped 的体积下提供了接近完整的 3D 地图功能。

**架构特点**：
- **超轻量**：163KB gzipped，远小于 Cesium
- **全栈生态**：配套 VTS 后端服务器，提供数据融合和瓦片生成
- **多语言标注**：支持几乎所有国际书写系统的地形标签
- **纹理多边形网格**：渲染 OBJ 等 3D 模型
- **离线部署**：支持封闭网络部署

**适用场景**：需要完整 3D 地理栈的项目、轻量前端需求、离线环境

**局限**：生态相对封闭，必须配合 VTS 后端才能发挥最大价值

---

### 14. Globe.gl / three-globe

**GitHub**: https://github.com/vasturiano/globe.gl  
**维度**: 3D 地球数据可视化  
**渲染方式**: WebGL（Three.js）  
**协议**: MIT  
**Stars**: ~2.3k

**核心设计理念**：**数据可视化组件 + 3D 球体投影 + 声明式 API**

Globe.gl 不是一个 GIS 引擎，而是一个面向数据可视化的 3D 地球组件。它的理念是：用最简单的 API 在 3D 球体上展示数据。

**架构特点**：
- **Web Component**：可直接作为 HTML 元素使用
- **声明式数据绑定**：通过 accessor 函数定义点、弧线、多边形等图层
- **多图层类型**：Points、Arcs、Polygons、Hex、Heatmap、HTML Markers 等
- **Slippy Map 引擎**：支持在球体上覆盖瓦片地图
- **React 绑定**：提供 react-globe.gl

**适用场景**：全球化数据仪表盘、航线可视化、地缘分析展示

**局限**：不是 GIS 引擎，无投影/坐标系/空间分析能力

---

### 15. NASA WorldWind (社区版)

**GitHub**: https://github.com/WorldWindEarth  
**维度**: 3D 地球 + 2D 投影  
**渲染方式**: WebGL / OpenGL (Java)  
**协议**: Apache 2.0  
**Stars**: ~800+（Java + JS 合计）

**核心设计理念**：**NASA 级虚拟地球 SDK + 多平台 + 科学数据可视化**

NASA WorldWind 是最早的开源虚拟地球项目之一，最初为 Java 桌面应用设计，后来 ESA 与 NASA 合作开发了 Web 版本。

**架构特点**：
- **WorldWindow 核心**：连接所有功能到 HTML Canvas
- **WGS84 椭球体 + 多种 2D 投影**
- **矢量和栅格图层**：点、折线、多边形、标记
- **地形曲面细分**：自适应精度的地形渲染
- **多平台**：Java、JavaScript、Kotlin、Android
- **科学数据导向**：为遥感数据和科学可视化优化

**适用场景**：科学研究、遥感数据浏览、教育用途

**局限**：NASA 官方维护已停滞，社区版活跃度有限，WebGL 版功能不如 Cesium

---

### 16. AntV L7

**GitHub**: https://github.com/antvis/L7  
**维度**: 2D / 3D  
**渲染方式**: WebGL  
**协议**: MIT  
**Stars**: ~3.7k

**核心设计理念**：**数据驱动的地理空间可视分析 + 视觉编码 + 多底图适配**

L7 是蚂蚁集团 AntV 数据可视化团队出品的地理空间数据可视分析引擎。"L"代表 Location，"7"代表七大洲。它的核心理念是**从数据到图形的视觉映射**。

**架构特点**：
- **Scene + Layer 双核心**：Scene 管理底图和渲染上下文，Layer 负责数据可视化
- **多底图适配**：支持 Mapbox、高德、腾讯、百度等作为底图
- **数据驱动视觉编码**：通过颜色、大小、纹理、方向等视觉变量映射数据
- **丰富的图层类型**：PointLayer、LineLayer、PolygonLayer、HeatmapLayer、CityBuildingLayer 等
- **多数据格式**：CSV、JSON、GeoJSON，支持自定义数据格式
- **AntV G 渲染引擎底座**：底层使用 @antv/g，支持 Canvas2D/SVG/WebGL/WebGPU 多后端

**适用场景**：BI 系统地图可视化、交通分析、城市规划可视化、中国开发者生态

**局限**：国际文档不够完善，底图依赖第三方服务

---

### 17. Kepler.gl

**GitHub**: https://github.com/keplergl/kepler.gl  
**维度**: 2D / 3D  
**渲染方式**: WebGL（基于 deck.gl）  
**协议**: MIT  
**Stars**: ~10k+

**核心设计理念**：**开箱即用的地理空间分析工具 + 无代码大数据探索**

Kepler.gl 由 Uber 开发，构建在 deck.gl 之上。它不是一个底层引擎，而是一个**面向分析师的完整应用**——提供拖拽上传数据、自动推断地理列、交互式过滤、时间轴播放等开箱即用的功能。

**架构特点**：
- **React + Redux 架构**：完全状态化，可嵌入任何 React 应用
- **deck.gl 渲染层**：继承 deck.gl 的所有高性能渲染能力
- **自动数据推断**：上传 CSV/GeoJSON 后自动识别经纬度、时间等字段
- **丰富的过滤器**：范围过滤、时间过滤、值过滤
- **导出分享**：可导出地图为 HTML 或图片

**适用场景**：快速数据探索、分析师自助分析、数据新闻

**局限**：定制化需要深入 React/Redux，不是底层引擎

---

### 18. vis.gl 框架族

**GitHub**: https://github.com/visgl  
**网站**: https://vis.gl/frameworks  
**维度**: 2D / 3D  
**协议**: MIT

**核心设计理念**：**GPU 驱动的可视化框架生态 + 模块化组合**

vis.gl 不是单个引擎，而是一系列可独立使用又可协同工作的框架：

- **deck.gl**：可视化图层框架（上面已分析）
- **luma.gl**：WebGL2/WebGPU 的高级封装库，deck.gl 的渲染底座
- **loaders.gl**：60+ 地理空间和 3D 数据格式的加载解析库
- **math.gl**：地理空间数学库（坐标变换、投影等）
- **nebula.gl**（已归档）→ editable-layers：地图上的几何编辑能力

**适用场景**：构建定制化可视化管线、需要精细控制 GPU 渲染的项目

---

### 19. TerriaJS

**GitHub**: https://github.com/TerriaJS/terriajs  
**维度**: 3D（Cesium）+ 2D（Leaflet）  
**渲染方式**: WebGL  
**协议**: Apache 2.0  
**Stars**: ~1.3k

**核心设计理念**：**数据目录驱动的地理数据浏览平台 + 2D/3D 优雅降级**

TerriaJS 是澳大利亚国家地图（NationalMap）的核心引擎。它的理念不是做底层渲染，而是做"**地理数据的浏览器**"——管理海量数据目录、处理各种数据格式、提供统一的浏览体验。

**架构特点**：
- **Cesium + Leaflet 双引擎**：3D 用 Cesium，不支持 WebGL 的环境自动降级到 Leaflet 2D
- **数据目录系统**：支持嵌套目录、数万条目的管理
- **广泛数据源支持**：WMS、WFS、WMTS、Esri MapServer/FeatureServer、GeoJSON、KML、CSV、3D Tiles、GTFS 等
- **静态部署**：纯浏览器端运行，可作为静态 HTML 部署
- **TypeScript 重写**

**适用场景**：政府数据门户、空间数字孪生平台、地理数据共享平台

**局限**：是应用框架而非底层引擎，定制底层渲染较困难

---

### 20. osgEarth

**GitHub**: https://github.com/gwaldron/osgearth  
**维度**: 3D 地球  
**渲染方式**: OpenGL（OpenSceneGraph）  
**语言**: C++  
**协议**: LGPL  
**Stars**: ~1.7k

**核心设计理念**：**C++ 桌面级 3D 地图 SDK + OpenSceneGraph 场景图**

osgEarth 是桌面级和嵌入式应用的 3D GIS 引擎，构建在 OpenSceneGraph（OSG）之上。它面向的是 C++ 开发者和需要原生性能的场景。

**架构特点**：
- **Earth File（XML）配置**：声明式地图配置
- **GDAL 集成**：支持 GDAL 支持的所有栅格格式
- **多种影像/地形提供商**：TMS、WMS、ArcGIS、Bing 等
- **原生 C++ 性能**：无浏览器限制，可处理更大规模数据
- **vcpkg 安装**：通过 vcpkg 包管理器快速安装

**适用场景**：桌面 GIS 应用、飞行模拟、军事仿真、嵌入式地图

**局限**：非 Web 引擎，C++ 门槛高，社区不如 Cesium 活跃

---

### 21. Tangram ES

**GitHub**: https://github.com/tangrams/tangram-es  
**维度**: 2D / 3D  
**渲染方式**: OpenGL ES  
**语言**: C++  
**协议**: MIT  
**Stars**: ~800+

**核心设计理念**：Tangram 的原生移动端版本

与 Tangram（Web版）共享相同的场景文件（YAML）格式和设计理念，但使用 C++ 和 OpenGL ES 实现，面向 iOS 和 Android 原生应用。

**适用场景**：移动端原生地图应用、需要 Tangram 创意制图风格的 App

---

### 22. Protomaps

**GitHub**: https://github.com/protomaps  
**维度**: 2D  
**协议**: BSD 3-Clause  
**Stars**: ~3.5k+

**核心设计理念**：**地图即文件 + PMTiles 格式 + 零服务器架构**

Protomaps 的核心理念极其独特——它发明了 PMTiles 格式，将整个地图瓦片集打包成一个静态文件，通过 HTTP Range Requests 按需读取。这意味着**不需要瓦片服务器**，只需要静态文件托管（S3、R2 等）。

**架构特点**：
- **PMTiles 格式**：单文件包含所有缩放级别的矢量瓦片
- **与 MapLibre/Leaflet 集成**：作为数据源使用，不替代渲染引擎
- **成本革命**：将地图托管成本从每月数百美元降至几分钱

**适用场景**：自托管地图、无服务器架构、长期归档的交互式地图

**局限**：是数据格式/工具链，不是渲染引擎

---

### 23. AntV G（渲染引擎底座）

**GitHub**: https://github.com/antvis/G  
**维度**: 2D / 3D  
**渲染方式**: Canvas2D / SVG / WebGL / WebGPU / CanvasKit  
**协议**: MIT  
**Stars**: ~900+

**核心设计理念**：**多后端统一渲染引擎 + DOM 兼容 API + GPGPU 计算**

G 是 AntV 可视化体系的底层渲染引擎，L7 的底座。它的独特理念是用**兼容 DOM Element 和 DOM Event 的 API**来操作图形，使得 D3、Hammer.js 等 Web 生态库可以几乎零成本迁移。

**架构特点**：
- **多渲染后端**：Canvas2D、SVG、WebGL、WebGPU、CanvasKit，可运行时切换
- **DOM 兼容**：图形元素 API 兼容 DOM Element，事件兼容 DOM Event
- **Web Animations API 兼容**：动画系统遵循 Web Animations 标准
- **GPGPU**：基于 WebGPU 的通用 GPU 计算，用于图分析并行算法
- **服务端渲染**：支持 Node.js 环境

**适用场景**：作为可视化底座构建上层应用、需要多渲染后端的项目

---

## 三、总结对比矩阵

| 引擎 | 维度 | 渲染技术 | 设计理念关键词 | 体积/复杂度 |
|------|------|---------|--------------|-----------|
| Leaflet | 2D | DOM/SVG/Canvas | 极简、插件化、移动优先 | 极轻 |
| OpenLayers | 2D(+WebGL) | Canvas/WebGL | 全功能、OGC标准、企业级 | 重 |
| CesiumJS | 3D/2D/2.5D | WebGL | 精确地球、开放格式、时空4D | 重 |
| deck.gl | 2D/2.5D/3D | WebGL2/WebGPU | GPU数据可视化、图层抽象、React | 中 |
| MapLibre GL | 2D/2.5D | WebGL | 样式驱动、矢量瓦片、开源治理 | 中 |
| Mapbox GL | 2D/2.5D/3D | WebGL | 设计优先、商业平台、3D地形 | 中(闭源) |
| MapTalks | 2D/3D | Canvas/WebGL/GPU | 2D/3D一体、插件化、易用 | 中 |
| Tangram | 2D/3D | WebGL | 创意制图、GLSL着色器、YAML场景 | 轻 |
| harp.gl | 2D/3D | WebGL(Three.js) | Three.js底座、TypeScript、HERE生态 | 中 |
| flywave.gl | 3D | WebGL(Three.js) | Monorepo模块化、Three.js底座 | 中 |
| OpenGlobus | 3D球 | 纯WebGL | 无依赖纯WebGL、轻量地球 | 轻 |
| iTowns | 3D球+局部 | WebGL(Three.js) | 研究级、点云/3DTiles、IGN出品 | 中 |
| VTS Browser | 3D球 | WebGL | 超轻量(163KB)、全栈配套 | 极轻 |
| Globe.gl | 3D球 | WebGL(Three.js) | 数据可视化组件、声明式 | 轻 |
| WorldWind | 3D球/2D | WebGL/OpenGL | NASA级、科学数据、多平台 | 中 |
| AntV L7 | 2D/3D | WebGL | 数据驱动、视觉编码、多底图 | 中 |
| Kepler.gl | 2D/3D | WebGL(deck.gl) | 无代码分析工具、大数据探索 | 重(应用级) |
| TerriaJS | 3D/2D | WebGL | 数据目录平台、2D/3D降级 | 重(平台级) |
| osgEarth | 3D球 | OpenGL(C++) | 桌面级C++ SDK、OSG场景图 | 重(Native) |
| Protomaps | 2D | - | 地图即文件、PMTiles、零服务器 | 极轻(工具) |
| AntV G | 2D/3D | 多后端 | 多渲染后端统一、DOM兼容API | 中(底座) |
