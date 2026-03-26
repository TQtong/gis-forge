# GIS-Forge DevPlayground — 可视化测试界面设计

> 面向开发者的交互式测试/演示平台。用于逐项验证 91 个核心模块 + 27 个可选包。

---
## 1. 总体定位

**GIS-Forge DevPlayground** — 一个面向开发者的交互式测试/演示平台。

目的：
1. **功能验证**：逐项测试 91 个核心模块 + 27 个可选包
2. **性能监控**：实时查看帧率/GPU 内存/Draw Call/瓦片状态
3. **可视化调试**：DevTools 面板集成
4. **文档演示**：每个功能项附带用法示例代码

**不是**生产 UI 框架，是开发阶段的测试工具。

## 2. 整体布局

```
┌──────────────────────────────────────────────────────────────────────┐
│ 顶部工具栏（TopBar）                                                │
│ [Logo] GIS-Forge DevPlayground    [主题切换] [语言] [导出] [分享]      │
├──────────┬───────────────────────────────────────┬───────────────────┤
│ 左侧面板  │           地图视口区域                  │  右侧面板         │
│ (280px)  │      （主渲染区，占满剩余空间）           │  (320px)         │
│          │                                       │                  │
│ 功能树   │   ┌───────────────────────────────┐   │  属性检查器       │
│ 导航     │   │                               │   │  配置面板         │
│          │   │      WebGPU Canvas             │   │  代码预览         │
│          │   │                               │   │                  │
│          │   │                               │   │                  │
│          │   └───────────────────────────────┘   │                  │
│          │                                       │                  │
│          │  ┌─────────────────────────────────┐  │                  │
│          │  │ 底部面板（可折叠，默认隐藏）        │  │                  │
│          │  │ DevTools / Console / Performance │  │                  │
│          │  └─────────────────────────────────┘  │                  │
└──────────┴───────────────────────────────────────┴───────────────────┘
```

## 3. 左侧面板——功能树导航

按架构层级组织的功能测试项树形导航。点击任一项，右侧切换到对应的测试场景。

```
📁 L0 基础层
  📁 math
    ├── vec2/vec3/vec4 运算验证
    ├── mat4 投影矩阵（perspective/ortho/reversedZ）
    ├── quat 四元数旋转
    ├── bbox 包围盒运算
    ├── frustum 视锥体裁剪
    └── interpolate 插值函数曲线
  📁 geo
    ├── ellipsoid WGS84 坐标转换
    ├── mercator 投影
    ├── geodesic Vincenty 距离/方位
    └── measure 面积/长度/质心
  📁 algorithm
    ├── earcut 三角剖分可视化
    ├── delaunay 三角网
    ├── convex-hull 凸包
    ├── clip 裁剪
    ├── intersect 相交检测
    ├── contain 包含测试
    ├── simplify 线简化对比
    └── cluster 聚合效果
  📁 index
    ├── R-Tree 查询可视化
    ├── Quadtree 可视化
    └── KD-Tree 最近邻
  📁 precision
    ├── Split-Double 精度对比
    └── RTC 偏移演示

📁 L1 GPU 层
  ├── DeviceManager GPU 信息
  ├── SurfaceManager Canvas/DPR
  ├── BufferPool 内存分配统计
  ├── TextureManager Atlas 可视化
  ├── GPUMemoryTracker 内存监控
  └── GPUUploader 上传吞吐量

📁 L2 渲染层
  ├── ShaderAssembler 模块组合
  ├── PipelineCache 缓存命中率
  ├── DepthManager Reversed-Z 验证
  ├── RenderGraph DAG 可视化
  ├── Compositor 多投影合成
  ├── PickingEngine 拾取测试
  ├── StencilManager 模板缓冲
  ├── RenderStats 性能面板
  ├── ComputePassManager GPU 计算
  ├── BlendPresets 混合模式
  └── UniformLayoutBuilder 对齐验证

📁 L3 调度层
  ├── FrameScheduler 帧循环监控
  ├── TileScheduler 瓦片加载可视化
  ├── WorkerPool 任务队列监控
  ├── ResourceManager 资源生命周期
  ├── MemoryBudget 内存预算
  ├── RequestScheduler 网络请求监控
  └── ErrorRecovery 错误恢复测试

📁 L4 场景层
  ├── SceneGraph 投影分组
  ├── LayerManager 图层操作
  ├── SourceManager 数据源管理
  ├── StyleEngine 样式编译
  ├── LabelManager 标注碰撞
  ├── GlyphManager MSDF 字形
  ├── FeatureStateManager 状态驱动
  ├── AntiMeridianHandler 日期线
  └── AnimationManager 动画

📁 L5 扩展层
  ├── EP1 自定义图层
  ├── EP2 自定义投影
  ├── EP3 自定义数据源
  ├── EP4 Shader Hook
  ├── EP5 自定义后处理
  └── EP6 自定义交互

📁 L6 预设层
  ├── Map2D 完整测试
  ├── Map25D 完整测试
  ├── Globe3D 完整测试
  └── MapFull 模式切换

📁 P0 相机
  ├── Camera2D 正交 + 惯性 + flyTo
  ├── Camera25D 透视 + pitch/bearing
  └── Camera3D 轨道 + 地形碰撞

📁 P0 图层
  ├── RasterTileLayer 栅格瓦片
  ├── VectorTileLayer 矢量瓦片（fill/line/circle/symbol）
  └── GeoJSONLayer GeoJSON + 聚合

📁 P1 3D
  ├── TerrainLayer 地形渲染
  ├── GlobeRenderer 大气/星空/阴影
  ├── ViewMorph 2D↔3D 过渡
  └── Tiles3DLayer 3D Tiles

📁 P2 增强
  ├── HeatmapLayer 热力图
  ├── PointCloudLayer 点云
  ├── MarkerLayer 标注
  ├── ExtrusionLayer 3D 建筑
  ├── DrawTool 绘制
  ├── MeasureTool 测量
  ├── SelectTool 选择
  ├── BloomPass 泛光
  ├── SSAOPass 环境光遮蔽
  └── ShadowPass 阴影

📁 P3 生态
  ├── WMTSSource WMTS 服务
  ├── WMSSource WMS 服务
  ├── WFSSource WFS 服务
  ├── PMTilesSource PMTiles
  ├── MobileOptimizer 移动端
  ├── HiDPIAdapter 高 DPI
  └── Analysis 空间分析（9 子模块）

📁 集成场景
  ├── 2D 城市底图（raster + vector + label）
  ├── 2.5D 城市建筑（vector + extrusion + shadow）
  ├── 3D 地球（globe + terrain + atmosphere + 3dtiles）
  ├── 混合渲染（2D 底图 + 3D 建筑 + 标注共存）
  ├── 大数据（100万点 GeoJSON + 聚合）
  ├── 实时更新（WebSocket 模拟 + GeoJSON setData）
  ├── 空间分析（缓冲区 + 叠加 + 统计）
  └── 性能压测（最大瓦片 + 最大标注 + 所有后处理）
```

## 4. 右侧面板——属性检查器 + 配置面板 + 代码预览

三个 Tab 切换：

**Tab 1：属性检查器（Inspector）**

显示当前选中功能项的运行时状态：

```
┌────────────────────────────┐
│ 📋 Inspector               │
├────────────────────────────┤
│ ▸ Camera State             │
│   center: [116.4, 39.9]   │
│   zoom: 12.35              │
│   bearing: 0.12 rad        │
│   pitch: 0.45 rad          │
│   altitude: 3542m          │
│   isAnimating: false       │
│   isInertiaActive: true    │
│                            │
│ ▸ Visible Tiles (24)       │
│   [12/3245/1578] loaded    │
│   [12/3246/1578] loading   │
│   [12/3247/1578] cached    │
│   ...                      │
│                            │
│ ▸ GPU Memory               │
│   Buffers: 45.2 MB         │
│   Textures: 128.7 MB       │
│   Pipelines: 12            │
│   Total: 173.9 / 512 MB    │
│                            │
│ ▸ Frame Stats              │
│   FPS: 58.3                │
│   Draw Calls: 47           │
│   Triangles: 284,392       │
│   GPU Time: 8.2ms          │
└────────────────────────────┘
```

**Tab 2：配置面板（Config）**

交互式控件，实时修改参数并看到效果：

```
┌────────────────────────────┐
│ ⚙️ Config                  │
├────────────────────────────┤
│ 图层：VectorTileLayer      │
│                            │
│ fill-color     [🎨#3388FF] │
│ fill-opacity   [━━━●━] 0.7 │
│ line-width     [━●━━━] 2px │
│ line-color     [🎨#FF0000] │
│                            │
│ ── 渲染 ──                 │
│ MSAA           [4x ▾]      │
│ Reversed-Z     [✓]         │
│ Log Depth      [✓]         │
│                            │
│ ── 性能 ──                 │
│ Max SSE        [━━●━] 16   │
│ Tile Cache     [━━━●] 512  │
│ GPU Budget     [━━●━] 512MB│
│ Worker Count   [4 ▾]       │
│                            │
│ ── 后处理 ──               │
│ Bloom          [✓]         │
│  threshold     [━━●━] 0.8  │
│  intensity     [━●━━] 1.0  │
│ SSAO           [✓]         │
│  radius        [━●━━] 0.5  │
│ Shadow         [ ]          │
│                            │
│ [重置默认] [应用]           │
└────────────────────────────┘
```

**Tab 3：代码预览（Code）**

显示当前场景对应的最小可运行代码：

```
┌────────────────────────────┐
│ 💻 Code                    │
├────────────────────────────┤
│ ```typescript              │
│ import { Map } from        │
│   '@gis-forge/preset-2d';   │
│                            │
│ const map = new Map({      │
│   container: 'map',        │
│   style: {                 │
│     sources: { osm: {      │
│       type: 'raster',      │
│       tiles: ['https://...']│
│     }},                    │
│     layers: [{             │
│       id: 'base',          │
│       type: 'raster',      │
│       source: 'osm'        │
│     }]                     │
│   },                       │
│   center: [116.4, 39.9],   │
│   zoom: 12                 │
│ });                        │
│ ```                        │
│                            │
│ [复制代码] [在 StackBlitz 打开]│
└────────────────────────────┘
```

## 5. 底部面板——DevTools

可折叠/展开，4 个 Tab：

**Tab 1：Console（日志）**

```
┌─────────────────────────────────────────────────────────────┐
│ Console    [All ▾] [Clear]   🔍 Filter                       │
├─────────────────────────────────────────────────────────────┤
│ 🔵 [INFO]  [14:32:01] DeviceManager initialized (vendor: nvidia, arch: ada) │
│ 🔵 [INFO]  [14:32:01] SurfaceManager: canvas 1920×1080 @2x                 │
│ 🟡 [WARN]  [14:32:02] [raster] tile 12/3245/1578 load failed, retrying...  │
│ 🔵 [INFO]  [14:32:02] PipelineCache: warmed up 8 pipelines in 120ms        │
│ 🟡 [WARN]  [14:32:05] MemoryBudget: GPU usage 480/512MB (94%)              │
│ 🔴 [ERROR] [GPU_SHADER_COMPILE] custom hook syntax error line 12            │
│            💡 建议：检查 vec3 对齐到 16 字节                                   │
│            📖 https://gis-forge.dev/docs/troubleshooting#shader-errors        │
│ 🟣 [PERF]  [14:32:06] frame 1240: update=1.2ms render=9.8ms total=11.0ms   │
└─────────────────────────────────────────────────────────────┘
```

**Tab 2：Performance（性能图表）**

```
┌─────────────────────────────────────────────────────────────┐
│ Performance   [Record ●] [60s ▾]                             │
├─────────────────────────────────────────────────────────────┤
│ FPS          ████████████████████████████████  60fps         │
│              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ← 实时折线图  │
│                                                              │
│ Frame Time   █ update  ██ render  █ post  □ idle            │
│              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ← 堆叠柱状图  │
│                                                              │
│ GPU Memory   ████████████████████░░░░░░░░░░░░  348/512 MB   │
│              █ Textures  █ Buffers  █ Pipelines              │
│                                                              │
│ Tile Status  ██████████████████░░░░░░░░░░░░░░               │
│              █ Loaded(24)  █ Loading(3)  □ Cached(180)       │
│                                                              │
│ Draw Calls   47   Triangles   284K   Instances   12K        │
└─────────────────────────────────────────────────────────────┘
```

**Tab 3：Tiles（瓦片检查器）**

```
┌─────────────────────────────────────────────────────────────┐
│ Tiles   [Show Borders ✓] [Show Load Order ✓] [Source: all ▾]│
├─────────────────────────────────────────────────────────────┤
│ 瓦片网格可视化（在地图上叠加半透明瓦片边框 + 编号）             │
│                                                              │
│ Tile Details (click tile on map):                            │
│   Coord:       12/3245/1578                                  │
│   State:       loaded                                        │
│   Source:      mapbox-streets                                │
│   Load Time:   342ms                                         │
│   Decode Time: 128ms                                         │
│   GPU Size:    2.4 MB                                        │
│   Features:    1,247                                         │
│   Triangles:   8,432                                         │
│   Placeholder: none                                          │
│   LOD Level:   12                                            │
│   SSE:         12.4px                                        │
└─────────────────────────────────────────────────────────────┘
```

**Tab 4：Shaders（Shader 检查器）**

```
┌─────────────────────────────────────────────────────────────┐
│ Shaders   [Variants: 8]  🔍 Search                           │
├─────────────────────────────────────────────────────────────┤
│ Variant: mercator/polygon/fill_solid                         │
│   Used in last frame: ✓                                      │
│   Compile time: 45ms                                         │
│   Pipeline state: cached                                     │
│                                                              │
│ ┌─ Vertex Shader (assembled) ──────────────────────────┐    │
│ │ struct PerFrameUniforms { ... }                       │    │
│ │ @group(0) @binding(0) var<uniform> frame: ...         │    │
│ │ // HOOK: vertex_position_before_projection            │    │
│ │ fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {│    │
│ │   return frame.vpMatrix * vec4(worldPos, 1.0);        │    │
│ │ }                                                     │    │
│ │ // ...                                                │    │
│ └───────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌─ Fragment Shader (assembled) ────────────────────────┐    │
│ │ fn computeColor(...) { ... }                          │    │
│ └───────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 6. 视觉风格

| 属性 | 规范 |
|------|------|
| **主题** | 默认深色主题（GIS 工具传统），可切换浅色 |
| **主色** | 深色：背景 #1a1a2e，面板 #16213e，高亮 #0f3460，强调 #53a8b6 |
| **浅色替代** | 背景 #f5f5f5，面板 #ffffff，高亮 #e3f2fd，强调 #1976d2 |
| **字体** | 代码/数据：JetBrains Mono 或 Fira Code 13px；UI 标签：Inter 或 system-ui 14px |
| **间距** | 面板内 padding 12px，控件间距 8px，分组间距 16px |
| **边框** | 面板边框 1px solid rgba(255,255,255,0.08)（深色），圆角 6px |
| **图标** | Lucide Icons（一致风格，轻量） |
| **动画** | 面板展开/折叠 200ms ease-out，数据刷新无动画（性能优先） |
| **地图** | 占最大空间，无圆角，与面板紧贴 |
| **响应式** | 左/右面板可折叠（移动端默认折叠），底部面板可拖动高度 |

## 7. 交互规范

| 交互 | 行为 |
|------|------|
| **功能树点击** | 左侧树项单击 → 地图加载对应测试场景 + 右侧切换对应配置 + 底部日志清空 |
| **配置修改** | 滑块/颜色选择器/下拉框修改 → 实时反映到地图（无需"应用"按钮，即时生效） |
| **地图交互** | 正常的 pan/zoom/rotate/pick，与当前激活的交互工具联动 |
| **Inspector 点击** | 点击 Inspector 中的瓦片坐标 → 地图高亮该瓦片 |
| **Console 过滤** | 下拉选择 INFO/WARN/ERROR/PERF，搜索框实时过滤 |
| **Performance 图表** | 鼠标悬停显示具体帧的数值 tooltip |
| **代码复制** | 点击"复制代码" → 剪贴板 + toast 提示 |
| **键盘快捷键** | F12 = 底部面板切换，1~4 = 底部面板 Tab 切换，Esc = 取消当前交互工具 |
| **URL 路由** | 每个功能树项对应一个 hash（如 #/l4/label-manager），支持直接链接分享 |

## 8. 技术选型建议

| 组件 | 推荐 | 原因 |
|------|------|------|
| 框架 | React 18+ | 生态最广，Cursor 生成 React 代码最稳定 |
| 状态管理 | Zustand | 轻量，无 boilerplate，适合工具类应用 |
| UI 组件 | shadcn/ui | 可定制，无运行时依赖，与 Tailwind 配合 |
| 样式 | Tailwind CSS v4 | 原子化 CSS，快速迭代 |
| 代码高亮 | Shiki 或 Prism | WGSL/TypeScript 语法高亮 |
| 图表 | Recharts | 性能图表（FPS/内存/Draw Call 时序） |
| 树形导航 | 自定义（shadcn Accordion 基础）| 功能树交互需求简单 |
| 图标 | Lucide React | 与 shadcn 统一风格 |
| 分割面板 | react-resizable-panels | 面板拖动调整大小 |
| 构建 | Vite | 与 GIS-Forge 引擎共享构建工具 |

## 9. 文件结构建议

```
playground/
├── package.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx                         # 入口
│   ├── App.tsx                          # 根布局（TopBar + 三面板 + 底部）
│   ├── stores/
│   │   ├── scene.ts                     # 当前场景状态
│   │   ├── config.ts                    # 配置面板状态
│   │   └── devtools.ts                  # DevTools 状态
│   ├── components/
│   │   ├── TopBar.tsx                   # 顶部工具栏
│   │   ├── FeatureTree.tsx              # 左侧功能树
│   │   ├── MapViewport.tsx              # 地图渲染区（GIS-Forge Canvas 容器）
│   │   ├── InspectorPanel.tsx           # 属性检查器
│   │   ├── ConfigPanel.tsx              # 配置面板
│   │   ├── CodePreview.tsx              # 代码预览
│   │   ├── DevToolsPanel.tsx            # 底部面板容器
│   │   ├── ConsoleTab.tsx               # 日志 Tab
│   │   ├── PerformanceTab.tsx           # 性能 Tab
│   │   ├── TilesTab.tsx                 # 瓦片检查 Tab
│   │   └── ShadersTab.tsx               # Shader 检查 Tab
│   ├── scenes/                          # 每个功能树项对应一个场景配置
│   │   ├── index.ts                     # 场景注册表
│   │   ├── l0/
│   │   │   ├── math-vec3.ts
│   │   │   ├── math-mat4.ts
│   │   │   ├── algorithm-earcut.ts
│   │   │   └── ...
│   │   ├── l1/
│   │   ├── l2/
│   │   ├── l3/
│   │   ├── l4/
│   │   ├── l5/
│   │   ├── l6/
│   │   ├── p0/
│   │   ├── p1/
│   │   ├── p2/
│   │   ├── p3/
│   │   └── integration/                 # 集成场景
│   │       ├── city-2d.ts
│   │       ├── city-25d.ts
│   │       ├── globe-3d.ts
│   │       ├── mixed-rendering.ts
│   │       ├── big-data.ts
│   │       ├── realtime.ts
│   │       ├── analysis.ts
│   │       └── stress-test.ts
│   └── utils/
│       ├── sample-data.ts               # 测试用示例数据
│       └── format.ts                    # 数值格式化
```
