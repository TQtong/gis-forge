# GeoForge GIS 算法完整清单

> 参考来源：Turf.js 全部 API、CGAL 算法库、JTS/GEOS 拓扑套件、JSTS、计算几何教材、
> CesiumJS/MapLibre/deck.gl/OpenLayers 内部算法、PostGIS 函数列表
>
> 分为**引擎核心算法**（渲染必需）和**空间分析算法**（可选模块），共 **12 大类、120+ 个算法**

---

## 一、计算几何基础（引擎核心，L0 必须内置）

### 1.1 三角剖分（Triangulation）

| # | 算法 | 用途 | 优先级 | 复杂度 |
|---|------|------|--------|--------|
| 1 | Ear Clipping（耳切法） | 简单/带洞多边形三角剖分 | P0 | O(n²) |
| 2 | Constrained Delaunay Triangulation（约束 Delaunay） | 高质量三角剖分（保留输入边） | P1 | O(n log n) |
| 3 | Delaunay Triangulation（标准 Delaunay） | 点集三角剖分（TIN 地形、Voronoi 对偶） | P1 | O(n log n) |
| 4 | Monotone Polygon Decomposition + 三角剖分 | 将复杂多边形分解为单调多边形后三角化 | P2 | O(n log n) |

### 1.2 凸包（Convex Hull）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 5 | Graham Scan / Andrew Monotone Chain | 2D 凸包 | P0 |
| 6 | Quickhull | 2D/3D 凸包（3D 用于碰撞体积） | P2 |
| 7 | Concave Hull（凹包） | 要素边界轮廓生成 | P2 |

### 1.3 多边形裁剪（Polygon Clipping）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 8 | Sutherland-Hodgman | 多边形对矩形裁剪（瓦片裁剪） | P0 |
| 9 | Weiler-Atherton | 任意多边形对多边形裁剪 | P1 |
| 10 | Martinez-Rueda-Feito | 布尔运算（交集/并集/差集） | P1 |
| 11 | Greiner-Hormann | 多边形裁剪（替代方案） | P2 |

### 1.4 线段与几何相交（Intersection）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 12 | 线段-线段相交检测 | 基础几何判断 | P0 |
| 13 | 线段-矩形裁剪（Cohen-Sutherland / Liang-Barsky） | 视口裁剪 | P0 |
| 14 | 射线-三角形相交（Möller-Trumbore） | 3D Picking、射线检测 | P0 |
| 15 | 射线-椭球体相交 | 地球 Picking | P0 |
| 16 | 射线-AABB 相交（Slab 法） | BVH 遍历、瓦片剔除 | P0 |
| 17 | 射线-OBB 相交 | 有向包围盒碰撞 | P1 |
| 18 | Bentley-Ottmann 扫描线 | 批量线段交点计算 | P2 |
| 19 | 平面-球体相交 | 视锥体与地球相交计算 | P0 |

### 1.5 点与区域关系（Point Location）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 20 | 射线法（Ray Casting）点在多边形内 | 空间查询基础 | P0 |
| 21 | 绕数法（Winding Number） | 处理复杂多边形（自相交） | P1 |
| 22 | 点在三角形内（重心坐标法） | 三角网插值、Picking | P0 |
| 23 | 点在椭球面上的最近点 | 地表投影 | P1 |
| 24 | 点到线段最近点/距离 | 捕捉、缓冲 | P0 |
| 25 | 点到多边形最近边/距离 | 缓冲区分析 | P1 |

---

## 二、空间索引与搜索（引擎核心，L0 必须内置）

| # | 算法/数据结构 | 用途 | 优先级 |
|---|-------------|------|--------|
| 26 | R-Tree（Hilbert + STR 批量加载） | 矩形范围查询、碰撞检测 | P0 |
| 27 | KD-Tree | 最近邻搜索、点云查询 | P1 |
| 28 | 空间哈希网格（Spatial Hash Grid） | 碰撞检测粗筛、标注碰撞 | P0 |
| 29 | 四叉树（Quadtree） | 瓦片调度、点聚合 | P0 |
| 30 | 八叉树（Octree） | 3D 空间索引、点云 | P2 |
| 31 | 网格索引（Grid Index） | 均匀分布数据的快速查询 | P1 |
| 32 | Geohash 编码/解码 | 空间哈希索引键 | P1 |
| 33 | S2 Geometry Cell（Google S2） | 球面空间索引 | P2 |
| 34 | H3 六边形索引（Uber H3） | 六边形网格索引系统 | P2 |

---

## 三、线简化与平滑（引擎核心 + 分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 35 | Douglas-Peucker | 线简化（保形） | P0 |
| 36 | Visvalingam-Whyatt | 线简化（面积权重，视觉效果更好） | P1 |
| 37 | Ramer-Douglas-Peucker（3D 版） | 3D 线简化 | P2 |
| 38 | Chaikin 平滑 | 线平滑/圆角 | P2 |
| 39 | 贝塞尔曲线拟合（Cubic Bezier） | 路径平滑 | P1 |
| 40 | B-Spline 插值 | 平滑曲线生成 | P2 |

---

## 四、测量与度量（引擎核心）

### 4.1 距离计算

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 41 | Haversine 大圆距离 | 快速距离估算（精度 ~0.5%） | P0 |
| 42 | Vincenty 反算（Inverse） | 高精度大地测量距离（< 0.5mm） | P0 |
| 43 | Vincenty 正算（Direct） | 给定起点/方位角/距离求终点 | P1 |
| 44 | Karney 大地测量算法 | Vincenty 失败时的替代（跨极点）| P2 |
| 45 | 欧几里得距离 | 投影坐标系下的平面距离 | P0 |

### 4.2 面积与长度

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 46 | 球面多边形面积（球面过剩法） | 大地面积计算 | P0 |
| 47 | Shoelace 公式（鞋带公式） | 2D 平面多边形面积 | P0 |
| 48 | 测地线长度（沿线 Vincenty 累加） | 路径总长度 | P0 |
| 49 | 周长计算 | 多边形边界长度 | P0 |

### 4.3 方位与角度

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 50 | 方位角（Bearing） | 两点间方位 | P0 |
| 51 | 沿方位角的目的地点（Destination） | 给定起点/方位/距离求终点 | P0 |
| 52 | 中点（Midpoint） | 两点间的球面中点 | P0 |
| 53 | 沿线插值点（Along） | 在线上按距离取点 | P0 |
| 54 | 最近线段上的点（Nearest Point on Line）| 捕捉/投影 | P0 |

### 4.4 中心与质心

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 55 | 质心（Centroid） | 多边形几何中心 | P0 |
| 56 | 中心点（Center of Mass） | 加权中心 | P1 |
| 57 | 包围盒中心 | BBox 中心 | P0 |
| 58 | 视觉中心（Polylabel 算法） | 多边形内部"最佳标注位置" | P1 |
| 59 | 最小外接圆 | 要素尺度估算 | P2 |
| 60 | 最小外接矩形（旋转卡壳法） | OBB 包围盒 | P2 |

---

## 五、缓冲区与偏移（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 61 | 点缓冲区（圆近似） | 服务半径分析 | P1 |
| 62 | 线缓冲区（平行偏移 + 端点圆弧） | 道路宽度、河流宽度 | P1 |
| 63 | 多边形缓冲区（内/外扩展） | 安全区域、影响范围 | P1 |
| 64 | 测地线缓冲区（球面） | 大范围缓冲（跨时区） | P2 |
| 65 | 线偏移（Offset Curve） | 双向道路、铁路表示 | P1 |

---

## 六、布尔运算与拓扑（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 66 | 多边形交集（Intersection） | 叠加分析 | P1 |
| 67 | 多边形并集（Union） | 合并区域 | P1 |
| 68 | 多边形差集（Difference） | 裁剪、擦除 | P1 |
| 69 | 对称差（Symmetric Difference） | XOR 区域 | P2 |
| 70 | 多边形分割（Split） | 用线切割多边形 | P2 |
| 71 | 自相交检测（Kinks） | 数据质量检查 | P1 |
| 72 | 多边形有效性检查 | 拓扑验证 | P1 |
| 73 | 多边形修复（Make Valid） | 自动修复无效几何 | P2 |

---

## 七、插值与表面分析（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 74 | TIN 不规则三角网插值 | 地形表面、高程分析 | P1 |
| 75 | IDW 反距离加权插值 | 气象数据、环境数据 | P1 |
| 76 | 等值线生成（Marching Squares） | 等高线、等温线 | P1 |
| 77 | 等值面生成（Marching Cubes）（3D） | 3D 体数据可视化 | P2 |
| 78 | Kriging 克里金插值 | 地统计分析 | P2 |
| 79 | 自然邻域插值（Natural Neighbor） | 平滑表面 | P2 |
| 80 | 双线性插值 | 栅格重采样 | P0 |
| 81 | 双三次插值 | 高质量栅格重采样 | P1 |

---

## 八、聚类与分类（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 82 | DBSCAN 密度聚类 | 点聚合、热点分析 | P1 |
| 83 | K-Means 聚类 | 分区、服务区域 | P2 |
| 84 | Supercluster（层级聚合） | 地图点聚合（zoom 依赖） | P0 |
| 85 | Jenks 自然断点 | 数据分级（专题地图） | P1 |
| 86 | 等间隔分级 | 数据分级 | P0 |
| 87 | 分位数分级 | 数据分级 | P0 |
| 88 | 标准差分级 | 数据分级 | P1 |

---

## 九、网格与镶嵌（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 89 | 正方形网格生成（Square Grid） | 热力图、聚合分析 | P1 |
| 90 | 六边形网格生成（Hex Grid） | 六边形聚合（deck.gl 风格） | P1 |
| 91 | 三角形网格生成（Triangle Grid） | 插值分析 | P2 |
| 92 | Voronoi 图（Fortune 扫描线） | 最近邻域分析、泰森多边形 | P1 |
| 93 | 地形网格生成（DEM→Mesh） | 地形渲染 | P0 |
| 94 | 自适应曲面细分 | GPU 地形 LOD | P1 |

---

## 十、坐标与投影变换（引擎核心）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 95 | 墨卡托投影（Web Mercator） | 2D 地图标准投影 | P0 |
| 96 | 经纬度↔ECEF 互转 | 3D 地球坐标 | P0 |
| 97 | 经纬度↔ENU 局部坐标 | 局部场景 | P1 |
| 98 | 横轴墨卡托（Transverse Mercator/UTM） | 分带投影 | P1 |
| 99 | 兰伯特等面积投影（Lambert） | 统计地图 | P2 |
| 100 | 等距圆柱投影（Equirectangular） | 全球概览 | P1 |
| 101 | 球面墨卡托↔椭球墨卡托转换 | 精度补偿 | P1 |
| 102 | 大地主题正/反算（Geodesic Direct/Inverse） | Vincenty/Karney | P0 |
| 103 | 坐标旋转（Helmert 7参数转换） | 坐标系间转换 | P2 |
| 104 | GCJ-02↔WGS84 偏移校正 | 中国地图偏移 | P1 |
| 105 | BD-09↔GCJ-02 转换 | 百度坐标 | P1 |

---

## 十一、栅格分析算法（分析模块）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 106 | 坡度分析（Slope） | 地形分析 | P2 |
| 107 | 坡向分析（Aspect） | 地形分析 | P2 |
| 108 | 等高线提取 | DEM→等高线 | P1 |
| 109 | 视域分析（Viewshed） | 可视域计算 | P2 |
| 110 | 山影渲染（Hillshade） | 地形阴影 | P1 |
| 111 | 流域分析（Watershed） | 水文分析 | P3 |
| 112 | 填洼分析（Fill Sinks） | 水文预处理 | P3 |
| 113 | 流向分析（Flow Direction） | 水文分析 | P3 |
| 114 | 栅格重分类（Reclassify） | 专题图 | P2 |
| 115 | 栅格代数（Map Algebra） | 栅格计算器 | P2 |

---

## 十二、渲染专用算法（引擎核心，L2/图层内置）

| # | 算法 | 用途 | 优先级 |
|---|------|------|--------|
| 116 | SDF 线段距离场 | 矢量线抗锯齿 | P0 |
| 117 | MSDF 文字渲染 | 缩放无关的文字 | P0 |
| 118 | 宽线条带生成（Miter/Bevel/Round Join） | GPU 宽线渲染 | P0 |
| 119 | GPU Parallel Radix Sort | 深度排序（Compute Shader） | P0 |
| 120 | GPU 视锥剔除（Compute Shader） | 批量可见性判断 | P0 |
| 121 | GPU 标注碰撞检测 | 标注精筛（Compute Shader） | P1 |
| 122 | 对数深度缓冲算法 | Z-Fighting 解决 | P0 |
| 123 | Split-Double 双精度仿真 | 浮点抖动解决 | P0 |
| 124 | 地形裙边生成（Skirt） | 瓦片接缝 | P0 |
| 125 | LOD 形变过渡（Morphing） | 地形 LOD 裂缝 | P1 |
| 126 | 大气散射（Rayleigh/Mie） | 3D 地球大气 | P1 |
| 127 | 级联阴影贴图（CSM） | 阴影渲染 | P2 |
| 128 | Eye-Dome Lighting | 点云增强渲染 | P2 |
| 129 | 屏幕空间环境光遮蔽（SSAO） | 后处理 | P2 |
| 130 | 纹理 Atlas 打包（Bin Packing） | 精灵图/字形图打包 | P0 |

---

## 优先级分布汇总

| 优先级 | 含义 | 数量 | 归属 |
|--------|------|------|------|
| **P0** | 引擎核心，V1.0 必须实现 | **~45** | L0 基础层 + L2 渲染层 |
| **P1** | 重要功能，V1.1 实现 | **~40** | L0 + 分析模块 |
| **P2** | 扩展功能，V2.0 实现 | **~35** | 分析模块 |
| **P3** | 专业功能，按需实现 | **~10** | 水文等专业模块 |
| **总计** | | **~130** | |

---

## 与当前 L0 设计的差距

### 当前 L0 已有（16 个算法相关模块）：

vec2, vec3, vec4, mat3, mat4, quat, bbox, frustum, interpolate, trigonometry, ellipsoid, mercator, earcut, douglas-peucker, spatial-hash, rtree

### 还需要补充到 L0 的核心算法（P0 级别，约 29 个）：

| 分类 | 需要新增 |
|------|---------|
| 三角剖分 | Delaunay Triangulation（P1 可延后） |
| 凸包 | Graham Scan / Monotone Chain |
| 裁剪 | Sutherland-Hodgman（矩形裁剪） |
| 相交检测 | 线段-线段、射线-三角形（Möller-Trumbore）、射线-椭球体、射线-AABB、平面-球体 |
| 点位置 | 射线法点在多边形、点在三角形（重心坐标）、点到线段距离 |
| 距离 | Haversine（已有）、Vincenty 正/反算 |
| 面积 | Shoelace 公式、球面面积 |
| 方位 | Bearing、Destination、Midpoint、Along、Nearest Point on Line |
| 中心 | Centroid、BBox Center、Polylabel |
| 聚合 | Supercluster（层级聚合） |
| 网格 | 四叉树（瓦片调度用） |
| 渲染 | SDF线距离场、宽线条带、Radix Sort（GPU）、视锥剔除（GPU）、对数深度、Split-Double、裙边、Atlas Bin Packing |

### 建议的 L0 包拆分策略

```
@geoforge/core
├── math/           向量/矩阵/四元数/bbox/frustum/插值/三角函数（必选）
├── geo/            椭球体/墨卡托/坐标变换/距离/面积/方位/中心（必选）
├── algorithm/      earcut/douglas-peucker/convex-hull/clip/intersect/
│                   point-in-polygon/polylabel/supercluster/quadtree（必选核心算法）
├── index/          rtree/spatial-hash/kd-tree/grid-index（空间索引）
├── precision/      split-double/RTC（精度管理）
└── infra/          event/id/logger/config/types（基础设施）

@geoforge/analysis（可选分析包）
├── boolean/        intersection/union/difference/kinks/valid（布尔运算）
├── buffer/         point-buffer/line-buffer/polygon-buffer（缓冲区）
├── interpolation/  tin/idw/isolines/kriging（插值）
├── classification/ jenks/quantile/equal-interval/dbscan/kmeans（分类聚类）
├── grid/           square-grid/hex-grid/triangle-grid/voronoi（网格）
├── raster/         slope/aspect/hillshade/viewshed/reclassify（栅格分析）
├── simplify/       visvalingam/chaikin/bezier-fit（高级简化/平滑）
└── projection/     utm/lambert/equirectangular/gcj02/bd09（扩展投影）
```

这样用户只需要 `@geoforge/core` 就能做基本地图渲染，需要空间分析时再引入 `@geoforge/analysis` 的子模块。
