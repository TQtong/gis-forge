# GIS-Forge DevPlayground — GIS 可视化系统界面设计（v2）下篇

> 状态栏 / 书签 / 标注 / 操作历史 / 分屏对比 / 状态设计 / 响应式 / 无障碍 / 视觉风格 / 技术选型 / 文件结构 / 实现顺序

---

## 8. 底部状态栏

高度 28px。与 v1 一致，补充点击交互：

```
📍 116.397°E, 39.908°N │ z:12.3 │ ⬡ 47(3) │ 58fps │ 174/512MB │ 📐 12.5°
```

点击各区域的弹出浮窗：

| 区域 | 点击弹出 |
|------|---------|
| 坐标 | 复制菜单（度 / 度分秒 / UTM / MGRS） |
| fps | 性能详情：update 1.2ms / render 8.5ms / post 1.3ms / idle 5.6ms |
| 内存 | 分解：Textures 98MB / Buffers 64MB / Pipelines 12MB |
| 瓦片 | 切换瓦片调试模式（显示瓦片边框 + 编号 + 加载状态颜色） |

---

## 9. 书签管理（新增）

从导出菜单的「保存为书签」或右键菜单触发。

```
书签列表（在左侧面板底部折叠区域）：

┌──────────────────────────────┐
│ ▸ 🔖 书签 (3)                │
├──────────────────────────────┤
│  📌 北京天安门                │  ← 点击 → flyTo
│  📌 上海外滩                  │
│  📌 项目现场                  │
│  [+ 添加当前视图为书签]       │
└──────────────────────────────┘
```

每个书签存储：center / zoom / bearing / pitch / 可见图层列表 / 视图模式。

---

## 10. 标注管理（新增）

用户通过右键菜单"在此处添加标注"或绘制工具创建的标注。

```
标注面板（左侧面板的折叠区域）：

┌──────────────────────────────┐
│ ▸ 📌 标注 (5)                │
├──────────────────────────────┤
│  📍 项目入口  116.4°E,39.9°N │
│  📍 采样点1   116.5°E,39.8°N │
│  📍 采样点2   116.3°E,39.7°N │
│  📝 备注区域（面）            │
│  📏 测量线段1                 │
│                              │
│  [📥 导出所有标注]            │
│  [🗑️ 清空所有标注]           │
└──────────────────────────────┘
```

标注类型：点（图标+文字）/ 线 / 面 / 测量结果。
标注持久化到 URL hash（简单场景）或 localStorage（复杂场景）。

---

## 11. 操作历史（新增）

Ctrl+Z / Ctrl+Shift+Z 的可视化面板。通过工具栏或快捷键打开。

```
┌──────────────────────────────┐
│ ⏪ 操作历史              [X]  │
├──────────────────────────────┤
│ ● 添加图层: 道路网络     ← 当前│
│ ○ 修改样式: 道路网络.颜色  │
│ ○ 添加图层: 水系          │
│ ○ 绘制: 多边形            │
│ ○ 删除: 标注点1           │
│ ○ 分析: 缓冲区 500m       │
│ ─── 撤销点 ───            │
│ ○ (已撤销) 删除: 标注点2   │
│                              │
│ 点击任一操作 → 回退到该状态  │
└──────────────────────────────┘
```

---

## 11.5 分屏对比（新增）

从导出菜单或工具栏触发。将地图视口一分为二进行对比。

```
┌──────────────────────────────────────────────────────┐
│ 对比模式  [并排 │ 滑动] │ 左: [OSM底图 ▾] 右: [卫星影像 ▾] │ [退出对比]│
├──────────────────────┬───────────────────────────────┤
│                      │                               │
│     左侧视图          │        右侧视图               │
│   （底图样式 A）      │ │    （底图样式 B）            │
│                      │ │                             │
│                      │ │                             │
│                    ← 拖动分割线 →                     │
│                      │                               │
└──────────────────────┴───────────────────────────────┘
```

**两种对比模式**：
- **并排模式**：左右各一个独立视口，同步 pan/zoom/rotate（拖动一侧另一侧跟随）
- **滑动模式**：单视口叠加两层，中间竖线可左右拖动（类似 before/after 滑块）

**典型用途**：
- 底图样式对比（OSM vs 卫星）
- 时间对比（同一数据不同时期）
- 分析前后对比（原始数据 vs 分析结果）
```

---

## 12. 加载/错误/空状态设计（新增）

### 12.1 初始化加载

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                    🗺️ GIS-Forge                       │
│                                                      │
│              初始化 WebGPU 引擎...                     │
│              [████████████░░░░░░░]  65%               │
│                                                      │
│              ✅ GPU 设备已创建                         │
│              ✅ Shader 已编译 (8/12)                   │
│              ⏳ 加载默认底图...                        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 12.2 WebGPU 不支持

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                    ⚠️ 不支持 WebGPU                   │
│                                                      │
│     GIS-Forge 需要 WebGPU 支持。您的浏览器不支持此功能。│
│                                                      │
│     推荐浏览器：                                      │
│     • Chrome 113+                                    │
│     • Edge 113+                                      │
│     • Firefox Nightly（需手动启用）                    │
│                                                      │
│     当前浏览器: Firefox 120 ❌                         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 12.3 图层加载失败

```
图层列表中的错误状态：

│ ☰ ⚠️ 🛣️ 道路网络       [⋮] │  ← 图标变为警告 + 名称变红
│     加载失败: 网络超时       │  ← 错误描述
│     [重试] [查看详情]        │  ← 操作按钮
```

### 12.4 Toast 通知系统

```
右上角堆叠显示，自动消失（5 秒），支持手动关闭：

┌─────────────────────────────────┐
│ ✅ 图层「道路网络」添加成功   [X] │  ← 成功（绿色左边条）
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ✅ 缓冲区分析完成，生成 847 要素 │  ← 成功
│    [查看结果]                    │  ← 操作链接
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ⚠️ 图层「WMS 影像」加载缓慢    │  ← 警告（黄色左边条）
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ ❌ 无法连接到 WMTS 服务         │  ← 错误（红色左边条）
│    URL: https://broken.com/wmts │
│    [重试] [查看详情]             │
└─────────────────────────────────┘
```

---

## 13. 响应式适配（新增）

| 断点 | 布局变化 |
|------|---------|
| ≥1280px（桌面） | 完整三栏布局 |
| 960~1279px（小桌面） | 右侧面板默认折叠，点击展开覆盖在地图上方 |
| 768~959px（平板横屏） | 左右面板都折叠，底部抽屉式展开 |
| <768px（手机/平板竖屏） | 全屏地图 + 底部 Tab Bar（图层/工具/属性/设置）+ 点击展开全屏面板 |

手机模式底部 Tab Bar：

```
┌──────────────────────────────────────┐
│         全屏地图                      │
│                                      │
│                                      │
├──────────────────────────────────────┤
│  [📚图层]  [🔧工具]  [📋属性]  [⚙设置] │
└──────────────────────────────────────┘
```

---

## 14. 无障碍设计（新增）

| 维度 | 实现要求 |
|------|---------|
| **键盘导航** | 所有面板/按钮/控件可通过 Tab 键顺序聚焦。Enter/Space 激活。方向键在图层列表中移动 |
| **屏幕阅读器** | 所有交互元素有 `aria-label`。图层列表用 `role="tree"`。滑块用 `role="slider"` + `aria-valuemin/max/now` |
| **高对比度** | 检测 `prefers-contrast: more` → 加粗边框 + 增大文字对比度 |
| **减少动画** | 检测 `prefers-reduced-motion: reduce` → 禁用 ViewMorph 过渡 + flyTo 改为 jumpTo |
| **焦点可见** | 所有可聚焦元素有明显的 focus-visible 轮廓（2px accent color outline） |
| **颜色不依赖** | 所有状态不仅依赖颜色（如图层加载失败：红色 + ⚠️图标 + 文字说明三重提示） |

---

## 15. 视觉风格

与 v1 一致（深色/浅色双主题 CSS 变量），补充：

| 新增项 | 深色 | 浅色 |
|--------|------|------|
| 分组标题背景 | rgba(255,255,255,0.04) | rgba(0,0,0,0.02) |
| Toast 成功左边条 | #4caf50 | #2e7d32 |
| Toast 警告左边条 | #ff9800 | #e65100 |
| Toast 错误左边条 | #f44336 | #c62828 |
| 拖放遮罩 | accent 10% | accent 8% |
| 空状态文字 | text-muted | text-muted |
| 操作提示条背景 | rgba(0,0,0,0.7) | rgba(255,255,255,0.9) |

---

## 16. 技术选型

与 v1 一致，补充：

| 新增 | 选择 | 原因 |
|------|------|------|
| 虚拟列表 | @tanstack/virtual | 属性表大数据 |
| 拖拽排序 | @dnd-kit | 图层拖拽 |
| 颜色选择 | react-colorful | 轻量 |
| Toast | sonner | shadcn 推荐 |
| 对话框 | shadcn Dialog | Radix 基础 |
| 鹰眼图 | Canvas 2D 自绘 | 轻量，不依赖第二个引擎实例 |

---

## 17. 文件结构

```
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── index.html
├── public/
│   └── sample-data/
│
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── types.ts
│   │
│   ├── stores/
│   │   ├── mapStore.ts              # center/zoom/bearing/mode/activeTool
│   │   ├── layerStore.ts            # 图层列表+分组+排序+样式
│   │   ├── sourceStore.ts           # 数据源状态
│   │   ├── selectionStore.ts        # 选中要素
│   │   ├── analysisStore.ts         # 分析参数+结果+进度
│   │   ├── annotationStore.ts       # 标注+书签                    ← 新增
│   │   ├── historyStore.ts          # 操作历史（undo/redo 栈）      ← 新增
│   │   ├── uiStore.ts              # 面板开关/主题/语言/toast 队列
│   │   └── statusStore.ts          # 状态栏实时数据
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── TopToolbar.tsx
│   │   │   ├── LeftPanel.tsx
│   │   │   ├── RightPanel.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   ├── MapViewport.tsx
│   │   │   └── MobileTabBar.tsx     # 响应式手机底部 Tab         ← 新增
│   │   │
│   │   ├── toolbar/
│   │   │   ├── ViewModeSwitch.tsx
│   │   │   ├── SearchBox.tsx
│   │   │   ├── ToolGroup.tsx        # 编辑工具栏容器（互斥工具组）← 新增
│   │   │   ├── DrawToolMenu.tsx
│   │   │   ├── MeasureToolMenu.tsx
│   │   │   ├── SelectToolMenu.tsx
│   │   │   ├── AnalysisMenu.tsx
│   │   │   ├── ExportMenu.tsx
│   │   │   └── ToolHintBar.tsx      # 操作提示条                  ← 新增
│   │   │
│   │   ├── layers/
│   │   │   ├── LayerList.tsx         # 分组+拖拽排序
│   │   │   ├── LayerGroup.tsx        # 图层分组（文件夹）           ← 新增
│   │   │   ├── LayerItem.tsx
│   │   │   ├── LayerContextMenu.tsx
│   │   │   ├── AddLayerDialog.tsx    # 增强版（3 Tab + 预览）
│   │   │   ├── SourceList.tsx
│   │   │   ├── TerrainControl.tsx
│   │   │   ├── BookmarkList.tsx      # 书签列表                    ← 新增
│   │   │   └── AnnotationList.tsx    # 标注列表                    ← 新增
│   │   │
│   │   ├── properties/
│   │   │   ├── PropertyTab.tsx       # 属性 Tab 容器（空/单选/多选状态切换）← 新增
│   │   │   ├── FeatureProperties.tsx
│   │   │   ├── MultiSelectSummary.tsx # 多选统计                   ← 新增
│   │   │   ├── AttributeTable.tsx
│   │   │   └── GeometryInfo.tsx
│   │   │
│   │   ├── style/
│   │   │   ├── StyleTab.tsx          # 样式 Tab 容器（空状态+图层切换）← 新增
│   │   │   ├── StyleEditor.tsx
│   │   │   ├── FillStyleEditor.tsx
│   │   │   ├── LineStyleEditor.tsx
│   │   │   ├── CircleStyleEditor.tsx
│   │   │   ├── SymbolStyleEditor.tsx
│   │   │   ├── RasterStyleEditor.tsx
│   │   │   ├── ExtrusionStyleEditor.tsx
│   │   │   ├── HeatmapStyleEditor.tsx
│   │   │   ├── DataDrivenEditor.tsx
│   │   │   ├── FilterEditor.tsx
│   │   │   ├── StylePresets.tsx       # 样式预设选择器               ← 新增
│   │   │   └── ColorPicker.tsx
│   │   │
│   │   ├── legend/
│   │   │   └── LegendTab.tsx          # 图例面板                    ← 新增
│   │   │
│   │   ├── analysis/
│   │   │   ├── BufferAnalysis.tsx
│   │   │   ├── OverlayAnalysis.tsx
│   │   │   ├── ContourAnalysis.tsx
│   │   │   ├── HeatmapAnalysis.tsx    # 热力密度                    ← 新增
│   │   │   ├── VoronoiAnalysis.tsx
│   │   │   ├── ViewshedAnalysis.tsx
│   │   │   ├── SlopeAnalysis.tsx
│   │   │   ├── HillshadeAnalysis.tsx
│   │   │   ├── ClassificationDialog.tsx
│   │   │   └── AnalysisProgress.tsx
│   │   │
│   │   ├── results/
│   │   │   ├── MeasureResult.tsx
│   │   │   └── ElevationProfile.tsx
│   │   │
│   │   ├── map-controls/
│   │   │   ├── ZoomControl.tsx
│   │   │   ├── LocateControl.tsx
│   │   │   ├── CompassControl.tsx
│   │   │   ├── ScaleBar.tsx
│   │   │   ├── CoordinateDisplay.tsx
│   │   │   ├── MiniMap.tsx            # 鹰眼图                     ← 新增
│   │   │   ├── TimeSlider.tsx         # 时间轴控件                  ← 新增
│   │   │   ├── MapContextMenu.tsx
│   │   │   ├── FeaturePopup.tsx       # 要素悬停弹窗                ← 新增
│   │   │   ├── FileDragOverlay.tsx    # 文件拖放遮罩                ← 新增
│   │   │   └── SplitViewControl.tsx   # 分屏对比控制                ← 新增
│   │   │
│   │   ├── settings/
│   │   │   ├── SettingsDialog.tsx     # 独立弹窗容器                ← 改为弹窗
│   │   │   ├── RenderSettings.tsx
│   │   │   ├── PostProcessSettings.tsx
│   │   │   ├── GlobeSettings.tsx
│   │   │   ├── AppearanceSettings.tsx
│   │   │   ├── ShortcutsSettings.tsx  # 快捷键列表                  ← 新增
│   │   │   └── AboutSettings.tsx      # 关于（版本/GPU 信息）        ← 新增
│   │   │
│   │   ├── history/
│   │   │   └── HistoryPanel.tsx       # 操作历史面板                 ← 新增
│   │   │
│   │   ├── loading/
│   │   │   ├── InitLoading.tsx        # 初始化加载界面               ← 新增
│   │   │   └── WebGPUError.tsx        # WebGPU 不支持界面            ← 新增
│   │   │
│   │   └── common/
│   │       ├── Toast.tsx              # sonner 包装
│   │       ├── EmptyState.tsx         # 通用空状态组件               ← 新增
│   │       └── ConfirmDialog.tsx
│   │
│   ├── hooks/
│   │   ├── useGeoForgeMap.ts
│   │   ├── useMapEvents.ts
│   │   ├── useLayer.ts
│   │   ├── useDrawTool.ts
│   │   ├── useMeasureTool.ts
│   │   ├── useSelectTool.ts
│   │   ├── useAnalysis.ts
│   │   ├── useUrlState.ts
│   │   ├── useHistory.ts             # undo/redo hook               ← 新增
│   │   ├── useResponsive.ts          # 响应式断点检测               ← 新增
│   │   └── useA11y.ts               # 无障碍相关                    ← 新增
│   │
│   ├── utils/
│   │   ├── formatters.ts
│   │   ├── fileParser.ts
│   │   ├── colorUtils.ts
│   │   ├── urlState.ts
│   │   ├── scaleBar.ts
│   │   ├── legendGenerator.ts        # 从图层样式生成图例数据         ← 新增
│   │   └── historyManager.ts         # 操作历史管理器                ← 新增
│   │
│   └── data/
│       ├── sampleLayers.ts
│       ├── basemapStyles.ts
│       ├── defaultConfig.ts
│       └── stylePresets.ts            # 预定义样式方案                ← 新增
```

---

## 18. 实现顺序

| 阶段 | 内容 |
|------|------|
| **Phase 1** | 布局骨架 + 地图画布 + 默认底图 + 状态栏 + 初始化加载/错误页 |
| **Phase 2** | 图层管理（分组+拖拽+可见性+添加对话框）+ 数据源管理 |
| **Phase 3** | 右侧属性 Tab（空/单选/多选状态）+ 要素 Popup |
| **Phase 4** | 右侧样式 Tab（7 种图层类型编辑器 + 数据驱动 + 过滤）+ 图例 Tab |
| **Phase 5** | 交互工具（绘制+测量+选择）+ 操作提示条 + 测量结果/高程剖面 |
| **Phase 6** | 视图切换（2D/2.5D/Globe）+ 地形控制 + 3D 建筑 |
| **Phase 7** | 分析工具（全部 9 个对话框 + 进度 + 结果图层）|
| **Phase 8** | 设置弹窗 + 后处理效果 + 导出 + 搜索 + 书签/标注 |
| **Phase 9** | 响应式适配 + 无障碍 + 操作历史 + 时间轴 + 鹰眼图 + Toast |
| **Phase 10** | 文件拖放 + URL 状态 + 样式预设 + 属性表 + 最终打磨 |
