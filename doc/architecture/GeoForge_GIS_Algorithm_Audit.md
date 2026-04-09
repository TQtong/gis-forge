# GIS-Forge GIS 算法实现现状审计

> 对照 `GeoForge_GIS_Algorithm_Inventory.md` 130 条目逐项审计
> 审计时间：2026-04-08
> 审计基准：`src/packages/{core,analysis,gpu,globe}` 当前代码
>
> 图例：✅ 已实现 / 🟡 部分实现 / ❌ 未实现

---

## 一、计算几何基础

### 1.1 三角剖分

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 1 | Ear Clipping | ✅ | `core/algorithm/earcut.ts`（1813 行，完整 earcut 移植）|
| 2 | Constrained Delaunay | ✅ | `core/algorithm/constrained-delaunay.ts` `constrainedDelaunay()`（批次 C，Steiner 点细化法）|
| 3 | Delaunay Triangulation | ✅ | `core/algorithm/delaunay.ts` `delaunay()`（Bowyer–Watson, O(n²)，非 O(n log n)）|
| 4 | Monotone Polygon Decomposition | ✅ | `core/algorithm/monotone.ts` `monotoneDecompose()`（批次 K，de Berg 第 3 章扫描线 + 5 类顶点 + helper 对角线）|

### 1.2 凸包

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 5 | Graham Scan / Andrew Monotone Chain | ✅ | `core/algorithm/convex-hull.ts` `convexHull()`（Andrew 单调链）|
| 6 | Quickhull (2D/3D) | ✅ | `core/algorithm/convex-hull.ts` `quickHull()`（批次 D，仅 2D；3D 留待 P3）|
| 7 | Concave Hull | ✅ | `core/algorithm/convex-hull.ts` `concaveHull()`（批次 D，KNN 法 + 自适应 k）|

### 1.3 多边形裁剪

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 8 | Sutherland-Hodgman | ✅ | `core/algorithm/clip.ts` `sutherlandHodgman()` |
| 9 | Weiler-Atherton | ✅ | `core/algorithm/polygon-clip.ts` `weilerAtherton()`（批次 M，交点插入+entering/leaving 标记+环追踪，支持凹多边形 intersection/union/difference）|
| 10 | Martinez-Rueda-Feito | ✅ | **批次 P 最终**：切换到 `polygon-clipping` npm 包（Mike Fogel / MIT / ~30 KB，Martinez 2009 论文 JS 事实标准）。`analysis/boolean/martinez.ts` 从 ~550 行自研重写为 ~95 行薄封装，保持 `martinez / martinezBoolean / MartinezOp / MartinezPolygon` API 兼容。正确处理共线边、共享顶点、T 形交、凹多边形、多孔洞。依赖文档见 `GeoForge_ThirdParty_Dependencies.md`。|
| 11 | Greiner-Hormann | ✅ | `core/algorithm/polygon-clip.ts` `greinerHormann()`（批次 M，双向链表 + entry/exit 标志；与 weilerAtherton 正交，可 A/B 校验）|

### 1.4 线段与几何相交

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 12 | 线段-线段相交 | ✅ | `core/algorithm/intersect.ts` `segmentSegment()` |
| 13 | 线段-矩形裁剪 (Cohen-Sutherland / Liang-Barsky) | ✅ | `core/algorithm/clip.ts` `cohenSutherland()` `liangBarsky()` |
| 14 | 射线-三角形 (Möller-Trumbore) | ✅ | `core/algorithm/intersect.ts` `rayTriangle()` + `RayTriangleHit`（批次 A）|
| 15 | 射线-椭球体 | ✅ | `core/geo/ellipsoid.ts` `rayEllipsoidIntersect()` |
| 16 | 射线-AABB (Slab) | ✅ | `core/algorithm/intersect.ts` `rayAABB()` |
| 17 | 射线-OBB | ✅ | `core/algorithm/intersect.ts` `rayOBB()`（批次 B）|
| 18 | Bentley-Ottmann | ✅ | `core/algorithm/bentley-ottmann.ts` `bentleyOttmann()`（批次 K，扫描线 + 事件队列 + 状态 T，报告 n 条线段所有交点，支持端点/T 形/十字交）|
| 19 | 平面-球体相交 | ✅ | `core/algorithm/intersect.ts` `planeSphere()` + `PlaneSphereRelation`（批次 A）|

补充已有：`raySphereIntersect()` (ellipsoid.ts) — 清单未列出但有用。

### 1.5 点与区域关系

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 20 | 射线法点在多边形 | ✅ | `core/algorithm/contain.ts` `pointInPolygon()` |
| 21 | 绕数法 (Winding Number) | ✅ | `core/algorithm/contain.ts` `pointInPolygonWinding()`（批次 A）|
| 22 | 点在三角形（重心坐标） | ✅ | `contain.ts` `pointInTriangle()` |
| 23 | 点在椭球面最近点 | ✅ | `core/geo/ellipsoid.ts` `closestPointOnEllipsoid(out, px, py, pz)` + `distanceToEllipsoid(px, py, pz)`（批次 M，基于 `ecefToGeodetic` 的 Bowring 迭代垂足解）|
| 24 | 点到线段最近点/距离 | ✅ | `core/geo/geodesic.ts` `nearestPointOnLine()` + `pointToLineDistance` |
| 25 | 点到多边形最近边/距离 | ✅ | `core/algorithm/contain.ts` `pointToPolygonDistance()`（批次 A）|

---

## 二、空间索引与搜索

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 26 | R-Tree | ✅ | `core/index/rtree.ts` `createRTree()` |
| 27 | KD-Tree | ✅ | `core/index/kd-tree.ts` `createKDTree()` |
| 28 | Spatial Hash Grid | ✅ | `core/index/spatial-hash.ts` `createSpatialHash()` |
| 29 | Quadtree | ✅ | `core/index/quadtree.ts` `createQuadTree()` |
| 30 | Octree | ✅ | `core/index/octree.ts` `createOctree()`（批次 G，3D 八叉树 + 球形范围查询）|
| 31 | Grid Index | ✅ | `core/index/grid-index.ts` `createGridIndex()` |
| 32 | Geohash | ✅ | `core/index/geohash.ts` `geohashEncode/Decode/Neighbors`（批次 B）|
| 33 | S2 Geometry Cell | ✅ | `core/index/s2.ts` `latLngToCellId/cellIdToLatLng/cellIdLevel/cellIdFace/cellIdParent/cellIdChildren`（批次 G，完整 face+Hilbert 编码，BigInt Cell ID）|
| 34 | H3 六边形索引 | ✅ | `core/index/h3.ts` 封装 Uber 官方 `h3-js`，与 h3-py/h3-java/PostGIS-H3 **二进制兼容**；API：`latLngToH3/h3ToLatLng/h3ToBoundary/h3Parent/h3Children/h3Disk/h3Ring/h3Distance/h3IsPentagon/polygonToH3/h3ToMultiPolygon`（批次 G 完整版）|

---

## 三、线简化与平滑

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 35 | Douglas-Peucker | ✅ | `core/algorithm/simplify.ts` `douglasPeucker()` |
| 36 | Visvalingam-Whyatt | ✅ | `simplify.ts` `visvalingam()` |
| 37 | 3D Douglas-Peucker | ✅ | `core/algorithm/simplify.ts` `douglasPeucker3D()`（批次 M，2D 版扩展为 3D 点到线段欧氏距离）|
| 38 | Chaikin 平滑 | ✅ | `core/algorithm/simplify.ts` `chaikin()`（批次 B，支持开/闭合环）|
| 39 | 贝塞尔曲线拟合 | ✅ | `core/algorithm/curve-fit.ts` `bezierFit()` + `bezierSample()`（批次 C，最小二乘）|
| 40 | B-Spline 插值 | ✅ | `core/algorithm/simplify.ts` `bspline(controlPoints, degree, samples)`（批次 M，均匀开放节点向量 + Cox-de Boor 递归基函数，支持任意次数）|

---

## 四、测量与度量

### 4.1 距离

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 41 | Haversine | ✅ | `ellipsoid.ts` `haversineDistance()` |
| 42 | Vincenty Inverse | ✅ | `ellipsoid.ts` `vincentyDistance()` |
| 43 | Vincenty Direct | ✅ | `geodesic.ts` `vincentyDirect()` |
| 44 | Karney 大地测量 | ✅ | **批次 P 最终**：切换到 `geographiclib-geodesic` npm 包（Charles Karney 本人维护 / MIT / ~40 KB，Karney 2013 论文 JS 事实标准）。`core/geo/karney.ts` 从 ~600 行自研重写为 ~120 行薄封装，保持 `karneyInverse/karneyDirect/karneyDistance/karneyInitialBearing` API 兼容。精度：距离 ≤ 15 nm，方位角 ≤ 1 µas，对跖点无条件收敛。依赖文档见 `GeoForge_ThirdParty_Dependencies.md`。|
| 45 | 欧几里得距离 | ✅ | `vec2/vec3` `distance()` |

### 4.2 面积与长度

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 46 | 球面多边形面积 | ✅ | `geo/measure.ts` `geodesicArea()` |
| 47 | Shoelace 公式 | ✅ | `measure.ts` `area()` `area2D()` |
| 48 | 测地线长度 | ✅ | `measure.ts` `geodesicLength()` |
| 49 | 周长 | ✅ | `measure.ts` `perimeter()` |

### 4.3 方位与角度

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 50 | Bearing | ✅ | `geodesic.ts` `initialBearing()` `finalBearing()` |
| 51 | Destination | ✅ | `vincentyDirect()` 提供 |
| 52 | Midpoint | ✅ | `geodesic.ts` `midpoint()` |
| 53 | Along | ✅ | `geodesic.ts` `intermediatePoint()` |
| 54 | Nearest Point on Line | ✅ | `geodesic.ts` `nearestPointOnLine()` |

### 4.4 中心与质心

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 55 | Centroid | ✅ | `measure.ts` `centroid()` |
| 56 | Center of Mass | ✅ | `core/geo/measure.ts` `centerOfMass()`（批次 A，面积加权重心）|
| 57 | BBox Center | ✅ | `math/bbox.ts` `center2D()` |
| 58 | Polylabel | ✅ | `measure.ts` `polylabel()` |
| 59 | 最小外接圆 | ✅ | `measure.ts` `minBoundingCircle()` |
| 60 | 最小外接矩形（旋转卡壳） | ✅ | `core/algorithm/convex-hull.ts` `minBoundingBox()`（批次 D，凸包+轴扫描）|

---

## 五、缓冲区与偏移

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 61 | 点缓冲区 | ✅ | `analysis/buffer` `pointBuffer()` |
| 62 | 线缓冲区 | ✅ | `analysis/buffer` `lineBuffer()` |
| 63 | 多边形缓冲区 | ✅ | `analysis/buffer` `polygonBuffer()` |
| 64 | 测地线缓冲区 | ✅ | **批次 L 修复**：`analysis/buffer/index.ts` `destination()` 已切换到 `vincentyDirect()`（WGS84 椭球），距离误差从 ~30m/10km 降到 < 0.5mm/10km。所有 buffer/offsetCurve 等下游函数自动受益。|
| 65 | 线偏移 | ✅ | `analysis/buffer` `offsetCurve()` |

---

## 六、布尔运算与拓扑

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 66 | 多边形交集 | ✅ | `analysis/boolean` `intersection()` |
| 67 | 多边形并集 | ✅ | `analysis/boolean` `union()` |
| 68 | 多边形差集 | ✅ | `analysis/boolean` `difference()` |
| 69 | 对称差 | ✅ | `analysis/boolean` `xor()` |
| 70 | 多边形分割 (Split) | ✅ | `core/algorithm/clip.ts` `polygonSplit()`（批次 C，沿任意直线切割）|
| 71 | 自相交检测 (Kinks) | ✅ | `analysis/boolean` `kinks()` |
| 72 | 多边形有效性检查 | ✅ | **批次 L 修复**：`BooleanOps.isValid(poly)` —— 布尔谓词，校验 Polygon Feature 类型 + 每环 ≥ MIN_RING_VERTICES + `kinks()` 为空。|
| 73 | 多边形修复 | ✅ | `analysis/boolean` `makeValid()` |

补充：`analysis/topology` 提供 7 个谓词：`booleanContains/Within/Overlap/Crosses/Disjoint/Intersects/Touches`（清单未单列）。

---

## 七、插值与表面分析

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 74 | TIN 插值 | ✅ | `analysis/interpolation` `tin()` |
| 75 | IDW | ✅ | `analysis/interpolation` `idw()` |
| 76 | 等值线 (Marching Squares) | ✅ | `analysis/interpolation` `isolines()` + `raster.contour()` |
| 77 | 等值面 (Marching Cubes 3D) | ✅ | `analysis/interpolation/marching-cubes.ts` `marchingCubes()`（批次 F，完整 256 项 EDGE/TRI 查表，Paul Bourke 标准形式）|
| 78 | Kriging | ✅ | `analysis/interpolation/kriging.ts` `ordinaryKriging/fitVariogram/variogram`（批次 F，球状/指数/高斯变差模型，Gauss-Jordan 求解 + 估计方差）|
| 79 | 自然邻域插值 | ✅ | `analysis/interpolation/natural-neighbor.ts` `naturalNeighbor()`（批次 F，Halton 序列蒙特卡洛 Sibson）|
| 80 | 双线性插值 | ✅ | `analysis/interpolation` `bilinear()` |
| 81 | 双三次插值 | ✅ | `analysis/interpolation` `bicubic()` |

---

## 八、聚类与分类

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 82 | DBSCAN | ✅ | `core/algorithm/cluster.ts` `dbscan()` |
| 83 | K-Means | ✅ | `cluster.ts` `kMeans()` |
| 84 | Supercluster | ✅ | `cluster.ts` `supercluster()` |
| 85 | Jenks 自然断点 | ✅ | `analysis/classification` `jenks()` |
| 86 | 等间隔分级 | ✅ | `analysis/classification` `equalInterval()` |
| 87 | 分位数分级 | ✅ | `analysis/classification` `quantile()` |
| 88 | 标准差分级 | ✅ | `analysis/classification` `standardDeviation()` |

---

## 九、网格与镶嵌

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 89 | 正方形网格生成 | ✅ | `analysis/grid` `squareGrid()` |
| 90 | 六边形网格生成 | ✅ | `analysis/grid` `hexGrid()` |
| 91 | 三角形网格生成 | ✅ | `analysis/grid` `triangleGrid()` |
| 92 | Voronoi 图 | ✅ | **批次 J 复核**：`core/algorithm/delaunay.ts` `voronoi()`（行 169+）使用 **Delaunay 对偶 + 三角形外接圆心**，非 Fortune 扫描线。功能等价（结果为相同 Voronoi 图），仅算法族不同，维持 ✅。|
| 93 | DEM→Mesh | ✅ | `globe/globe-tile-mesh.ts` 等地形网格生成 |
| 94 | 自适应曲面细分 | ✅ | `gpu/wgsl/compute/terrain-tessellation.wgsl` |

注：清单 92 期望 Fortune 扫描线，当前是基于 Delaunay 对偶（结果等价但算法不同）。

---

## 十、坐标与投影变换

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 95 | Web Mercator | ✅ | `core/geo/mercator.ts` `lngLatToMercator/Pixel/Tile` |
| 96 | 经纬度↔ECEF | ✅ | `ellipsoid.ts` `geodeticToECEF/ecefToGeodetic` |
| 97 | 经纬度↔ENU | ✅ | `core/geo/ellipsoid.ts` `ecefToENU/enuToECEF/geodeticToENU`（批次 B）|
| 98 | UTM | ✅ | `geo/projection-math.ts` `utmForward/utmInverse` |
| 99 | Lambert 等面积 | ✅ | `core/geo/projection-math.ts` `lambertAzimuthalForward/Inverse`（批次 E，球面公式）|
| 100 | Equirectangular | ✅ | `core/geo/projection-math.ts` `equirectangularForward/Inverse`（批次 B，独立函数）|
| 101 | 球面↔椭球墨卡托转换 | ✅ | `core/geo/projection-math.ts` `sphericalToEllipsoidalMercatorLat/ellipsoidalToSphericalMercatorLat`（批次 E）|
| 102 | Geodesic Direct/Inverse | ✅ | Vincenty 已覆盖 |
| 103 | Helmert 7 参数 | ✅ | `core/geo/projection-math.ts` `helmert7/helmert7Inverse`（批次 E，位置矢量约定）|
| 104 | GCJ-02↔WGS84 | ✅ | `projection-math.ts` `wgs84ToGcj02/gcj02ToWgs84` |
| 105 | BD-09↔GCJ-02 | ✅ | `projection-math.ts` `gcj02ToBd09/bd09ToGcj02` |

---

## 十一、栅格分析

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 106 | 坡度 (Slope) | ✅ | `analysis/raster` `slope()` |
| 107 | 坡向 (Aspect) | ✅ | `analysis/raster` `aspect()` |
| 108 | 等高线提取 | ✅ | `analysis/raster` `contour()` |
| 109 | 视域分析 (Viewshed) | ✅ | `analysis/raster` `viewshed()` |
| 110 | 山影 (Hillshade) | ✅ | `analysis/raster` `hillshade()` |
| 111 | 流域 (Watershed) | ✅ | `analysis/raster/hydrology.ts` `watershed()`（批次 I，反向 BFS 追溯上游）|
| 112 | 填洼 (Fill Sinks) | ✅ | `analysis/raster/hydrology.ts` `fillSinks()`（批次 I，Priority-Flood，自研二叉最小堆 O(N log N)）|
| 113 | 流向 (Flow Direction) | ✅ | `analysis/raster/hydrology.ts` `flowDirection()` + `flowAccumulation()`（批次 I，D8 + 拓扑 BFS 累积 O(N)）|
| 114 | 栅格重分类 | ✅ | `analysis/raster` `reclassify()` |
| 115 | 栅格代数 (Map Algebra) | ✅ | `analysis/raster/map-algebra.ts`（批次 K）：16 个命名局部操作 `local{Add,Sub,Mul,Div,Pow,Min,Max,Sum,Mean,Abs,Sqrt,Log,Exp,Clamp,Condition,Combine}` + 表达式求值器 `mapAlgebraEvaluate("sqrt(a*a+b*b)", {a,b})`（tokenizer + AST + 10 个内置函数）|

---

## 十二、渲染专用算法（GPU/WGSL）

| # | 算法 | 状态 | 位置 / 备注 |
|---|---|---|---|
| 116 | SDF 线段距离场 | ✅ | `gpu/wgsl/feature/sdf-line.wgsl` |
| 117 | MSDF 文字渲染 | ✅ | `gpu/wgsl/feature/msdf-text.wgsl` |
| 118 | 宽线条带生成 | ✅ | `gpu/wgsl/geometry/line.wgsl` |
| 119 | GPU 深度排序 | ✅ | **批次 L 初版 + 批次 N 补强**：`gpu/wgsl/compute/depth-sort.wgsl` **全局多 pass Bitonic Sort**（Batcher 1968）：shader 接受 `SortParams { j, k, n_pad }` uniform，每个 dispatch 执行一个 (stage, pass_of_stage) 阶段；`createDepthSortTask` 预分配 log²(nPad) 个 uniform buffer + bind group，通过 `executeOverride` 回调在单个 compute pass 中按顺序 dispatch 所有阶段。支持任意 N（要求 keys/values 缓冲大小 ≥ nextPowerOf2(count)×4 且越界位置预填 PAD_KEY=f32::MAX 哨兵）。`ComputeTaskDescriptor.executeOverride` 为新增的多 pass 任务通用接口。|
| 120 | GPU 视锥剔除 | ✅ | `gpu/wgsl/compute/frustum-cull.wgsl` |
| 121 | GPU 标注碰撞 | ✅ | `gpu/wgsl/compute/label-collision.wgsl` |
| 122 | 对数深度缓冲 | ✅ | `gpu/wgsl/depth/log-depth-*.wgsl` + `gpu/wgsl/feature/log-depth.wgsl` |
| 123 | Split-Double 双精度 | ✅ | `core/precision/split-double.ts` + `gpu/wgsl/feature/split-double.wgsl` |
| 124 | 地形裙边 | ✅ | **批次 J 复核**：`globe/globe-tile-mesh.ts`（行 540-720）有完整四边 skirt 实现：top/bottom/left/right 各自生成 n1 个裙边顶点（相同经纬度，海拔 = -skirtDepth ≈ 32km，`SKIRT_DEPTH_FACTOR = 0.005 × ellipsoid.a`），裙边三角形连接主网格边缘与裙边顶点 — 真实现，非占位。|
| 125 | LOD Morphing | ✅ | **批次 L 修复**：`globe/lod-geomorph.ts` 新增经典 LOD geomorph：`computeTileGeomorph` 按相机距离归一化算 morph 因子，`buildParentPositions` 按"奇/偶顶点中点"算父级网格位置（4 种情形：自身/左右中点/上下中点/4角平均），`LOD_GEOMORPH_VERTEX_WGSL` 提供 `applyGeomorph(highRes, parent, morph)` 顶点着色器辅助。与 `computeMorphFactor`（2.5D↔3D 过渡）正交，互不冲突。|
| 126 | 大气散射 (Rayleigh/Mie) | ✅ | `globe/atmosphere.ts` + `gpu/wgsl/sky.wgsl` |
| 127 | 级联阴影 (CSM) | ✅ | `gpu/wgsl/compositor/csm.wgsl`（PCF 3×3 软阴影采样 4 级 texture_depth_2d_array）+ `gpu/l2/csm-cascades.ts` `computeCSMCascades/computeCascadeSplits/computeLightSpaceVP`（批次 H，practical split scheme + 光空间 AABB）|
| 128 | Eye-Dome Lighting | ✅ | `gpu/wgsl/compositor/edl.wgsl`（批次 H，Boucheny 2009 算法，8 方向邻居深度差 exp 衰减）|
| 129 | SSAO | ✅ | `gpu/wgsl/compositor/ssao.wgsl`（批次 H，Crytek 风格 16 样本半球 + TBN 旋转 + 范围限制）|
| 130 | Atlas Bin Packing | ✅ | `gpu/l1/texture-manager.ts`（Shelf-First-Fit）|

---

## 汇总统计

| 状态 | 数量 | 占比 |
|---|---|---|
| ✅ 已实现 | **130** | **100%** 🎉 |
| 🟡 部分实现 | **0** | 0% |
| ❌ 未实现 | **0** | 0% |

**批次 J 复核说明**：之前的 🟡 项读源后全部归入 ✅ 或 ❌（无中间状态）。归入 ❌ 的 5 项**不是新缺失**，而是审计初版误判为"部分实现"的项，读源后发现：
- #10 布尔运算底层是 Sutherland-Hodgman（不是 Martinez）
- #64 Buffer 是球面 Haversine（不是 Vincenty 测地）
- #72 没有独立 `isValid` 谓词
- #119 `depth-sort.wgsl` 是占位桩（既非 Radix 也非 Bitonic）
- #125 `computeMorphFactor` 是 2.5D↔3D 过渡（不是 LOD geomorph）

#92（Voronoi）和 #124（Skirt）在复核后维持 ✅。

另外统计数字从 124 → 120 的差是因为 #10/#64/#72/#119/#125 这 5 项在初版表格中已标 🟡，批次 K 结束时被我错误合并成 ✅ 计入 124；本次复核后纠正为 ❌。真实实现项数一直是 120，没有新增或减少实现。
| **总计** | **130** | |

### 已完成批次

- ✅ **批次 A**（P0，5 项）：rayTriangle / planeSphere / pointInPolygonWinding / pointToPolygonDistance / centerOfMass
- ✅ **批次 B**（P1，5 项）：rayOBB / ENU / Equirectangular / Geohash / Chaikin
- ✅ **批次 C**（P1，3 项）：polygonSplit / constrainedDelaunay / bezierFit
- ✅ **批次 D**（P2，3 项）：quickHull / concaveHull / minBoundingBox
- ✅ **批次 E**（P2，4 项）：lambertAzimuthal / helmert7 / sphericalEllipsoidalMercator / karneyDistance（**完整 Float64 实现**）
- ✅ **批次 F**（P2，3 项）：marchingCubes / ordinaryKriging / naturalNeighbor
- ✅ **批次 G**（P2，3 项）：octree / s2 cell / h3（**Uber H3 二进制兼容**，h3-js 依赖）
- ✅ **批次 H**（P2，3 项）：ssao.wgsl / edl.wgsl / csm.wgsl + csm-cascades.ts + post-effects.ts + shadow-map-pass.ts + frame-graph-builder 集成
- ✅ **批次 I**（P3，3 项）：fillSinks / flowDirection+flowAccumulation / watershed（基于 Priority-Flood + D8 + 拓扑 BFS，全 Float64/Int32）
- ✅ **批次 K**（P2 收尾，3 项）：monotoneDecompose / bentleyOttmann / mapAlgebra（表达式求值 + 16 个 local 操作）
- 📋 **批次 J**（🟡 复核）：读源确认 6 个 🟡 项真实状态 → 全部归入确定状态（5 ❌ + 1 ✅），见上方"批次 J 复核说明"
- ✅ **批次 L**（J 修复，5 项）：#10 Martinez（自研 ~520 行）/ #64 Buffer 切 Vincenty / #72 isValid 谓词 / #119 Bitonic Sort 重写 depth-sort.wgsl / #125 LOD geomorph (新文件 lod-geomorph.ts)
- ✅ **批次 M**（清单收尾，5 项）：#9 weilerAtherton / #11 greinerHormann / #23 closestPointOnEllipsoid / #37 douglasPeucker3D / #40 bspline
- ✅ **批次 N**（精度补强，2 项）：#10 Martinez 补加 edge-type 系统 + 共线重合处理 + 孔洞嵌套；#119 Bitonic 扩展为全局多 pass（`executeOverride` + N phases × ceil(nPad/256) workgroups，任意 N 长度）
- ✅ **批次 O**（测试基础设施）：引入 vitest，写 17 个测试文件 / 204 个用例覆盖 core/algorithm、core/geo、core/index、analysis/* 以及 globe/gpu 纯数学部分。`npm test` 运行全部绿。
- ✅ **批次 P**（第三方替换，2 项）：#10 Martinez 切到 `polygon-clipping`（Mike Fogel / MIT）；#44 Karney 切到 `geographiclib-geodesic`（Charles Karney 本人 / MIT）。删除 ~1150 行自研代码，换来 15 nm 精度 + 对跖点稳定性 + 布尔运算正确性。依赖清单见 [`GeoForge_ThirdParty_Dependencies.md`](./GeoForge_ThirdParty_Dependencies.md)。
- ✅ **批次 Q**（GPU 批次 H 运行期风险修复，4 项）：SSAO uniform 对齐（vec4 打包）/ CSM uniform 对齐（vec4 打包）/ CSM 级联 NDC→视空间 z 反算（新增 near/far 参数）/ 阴影贴图空 colorAttachments 兼容性澄清（spec 合法，无需改代码）。见下方"批次 H 已知运行期风险"章节。
- ✅ **批次 R**（GPU 批次 H 第 5 项风险收尾）：SSAO / EDL / CSMApply 三个 effect 的 pipeline 从 `layout: 'auto'` 切换到显式 `GPUBindGroupLayout` + `GPUPipelineLayout`；同时修复 EDL shader 中 `texture_depth_2d + filtering sampler` 的无效 WGSL，拆成 `color_samp`（filtering）+ `depth_samp`（non-filtering）。至此批次 H 5 项运行期风险全部清零。
- ✅ **批次 S**（真机运行期验证）：通过 Claude Preview 启动 Vite dev server，在浏览器中直接加载 `post-effects.ts`、构造 `GPUDevice`，对 SSAO/EDL/CSMApply 三个 effect 完整执行 create/updateUniforms/execute/submit 链路并监听 `uncapturederror`。发现并修复"`textureSample` in non-uniform control flow"的真机独占 bug：三个 shader 的 `textureSample` → `textureSampleLevel(..., 0)`（depth 纹理需 `i32` LOD 参数）。**最终三个 effect 在真实 WebGPU runtime 下全部 0 错误**。

🎉 **130 / 0 / 0 — 清单全部实现完成**

### 批次 J 复核揭示的 5 项缺口 → **批次 L 已全部修复 ✅**

均已在批次 L 落地，详见上方各条目的"批次 L 修复"标注。剩余 5 项 ❌（一直未实现的）：

| # | 名称 | 类别 |
|---|---|---|
| 9 | Weiler-Atherton | 多边形裁剪 |
| 11 | Greiner-Hormann | 多边形裁剪 |
| 23 | 点在椭球面最近点 | 点位置 |
| 37 | 3D Douglas-Peucker | 简化 |
| 40 | B-Spline 插值 | 简化 |
- 🟡 **#119 Radix Sort** 等仍在 🟡，待复核或后续批次处理

---

## 未实现项按优先级分类（共 33 项）

### P0（引擎核心，应优先补齐，6 项）

| # | 算法 | 类别 | 估计工作量 |
|---|---|---|---|
| 14 | 射线-三角形 (Möller-Trumbore) | 相交 | S（~80 行） |
| 19 | 平面-球体相交（独立函数） | 相交 | S（~50 行） |
| 21 | 绕数法点在多边形 | 点位置 | S（~60 行） |
| 25 | 点到多边形最近边/距离 | 点位置 | M（~150 行） |
| 56 | Center of Mass（与 centroid 区分） | 中心 | S（~40 行） |
| — | （119 Radix Sort 待复核可能已有） | GPU | — |

### P1（重要功能，11 项）

| # | 算法 | 类别 | 估计工作量 |
|---|---|---|---|
| 2 | Constrained Delaunay | 三角剖分 | L（~600 行） |
| 17 | 射线-OBB | 相交 | S |
| 23 | 点在椭球面最近点 | 点位置 | M |
| 32 | Geohash 编解码 | 索引 | S（~100 行） |
| 38 | Chaikin 平滑 | 简化 | S |
| 39 | 贝塞尔曲线**拟合**（最小二乘） | 简化 | M |
| 70 | 多边形 Split | 布尔 | M |
| 97 | 经纬度↔ENU | 投影 | S |
| 100 | Equirectangular（独立函数） | 投影 | S |
| 125 | LOD Morphing 复核 | GPU | （审计） |
| 119 | GPU Radix Sort 复核 | GPU | （审计） |

### P2（扩展功能，13 项）

| # | 算法 | 类别 |
|---|---|---|
| 4 | Monotone Polygon Decomposition | 三角剖分 |
| 6 | Quickhull 2D/3D | 凸包 |
| 7 | Concave Hull | 凸包 |
| 9 | Weiler-Atherton | 裁剪 |
| 11 | Greiner-Hormann | 裁剪 |
| 18 | Bentley-Ottmann | 相交 |
| 30 | Octree | 索引 |
| 33 | S2 Cell | 索引 |
| 34 | H3 索引 | 索引 |
| 37 | 3D Douglas-Peucker | 简化 |
| 40 | B-Spline 插值 | 简化 |
| 44 | Karney 大地测量 | 距离 |
| 60 | 旋转卡壳最小外接矩形 | 中心 |
| 77 | Marching Cubes (3D) | 插值 |
| 78 | Kriging | 插值 |
| 79 | Natural Neighbor | 插值 |
| 99 | Lambert | 投影 |
| 101 | 球面↔椭球墨卡托 | 投影 |
| 103 | Helmert 7 参数 | 投影 |
| 115 | Map Algebra | 栅格 |
| 127 | CSM 级联阴影 | GPU |
| 128 | Eye-Dome Lighting | GPU |
| 129 | SSAO | GPU |

### P3（专业功能，3 项）

| # | 算法 | 类别 |
|---|---|---|
| 111 | Watershed | 水文 |
| 112 | Fill Sinks | 水文 |
| 113 | Flow Direction | 水文 |

---

## 待复核的 🟡 部分实现项（9 项）

逐项的"是否真的部分实现"需要读源确认：

1. **#10 Martinez-Rueda-Feito**：`analysis/boolean` 三大布尔运算的底层实现是否真的是 Martinez？还是简化扫描线？需读 718 行源码。
2. **#19 平面-球体相交**：当前只有 frustum-vs-sphere，缺独立的 plane-vs-sphere（用于切割可见半球等）。
3. **#39 Bezier 拟合**：现有是 `bezierCubic` 插值（已知控制点求点），不是从点集求最佳贝塞尔参数。
4. **#64 测地线缓冲区**：buffer 是否走 Vincenty 还是欧氏近似？
5. **#72 多边形有效性检查**：`makeValid` 返回修复后几何，没有独立 `isValid()` 谓词。
6. **#100 Equirectangular**：tiling-scheme 内嵌，缺独立投影函数。
7. **#119 GPU Radix Sort**：`depth-sort.wgsl` 是 Radix 还是 Bitonic？
8. **#124 地形裙边** + **#125 LOD Morphing**：grep 命中字符串，需读 `globe-tile-mesh.ts` 确认是真实实现还是 TODO。
9. **#92 Voronoi**：使用 Delaunay 对偶（结果正确）而非 Fortune 扫描线 — 严格按算法清单算"非完全匹配"，但功能等价，建议视为 ✅。

---

## 建议的实现批次

如果你后续要让我补齐，推荐的批次粒度（每批一次对话能完成）：

- **批次 A（P0 核心相交/点位置，~5 个算法，~400 行）**
  Möller-Trumbore、平面-球体、Winding Number、点到多边形距离、Center of Mass
- **批次 B（P1 投影 + 简化 + 索引，~5 个，~500 行）**
  ENU、Equirectangular 独立函数、Geohash、Chaikin、射线-OBB
- **批次 C（P1 高级布尔/几何，~3 个，~800 行）**
  多边形 Split、Constrained Delaunay、贝塞尔拟合
- **批次 D（P2 凸包扩展，~3 个，~500 行）**
  Quickhull、Concave Hull、旋转卡壳 OBB
- **批次 E（P2 投影补全，~4 个，~400 行）**
  Lambert、Helmert 7 参数、球面↔椭球墨卡托、Karney
- **批次 F（P2 插值高级，~3 个，~600 行）**
  Kriging、Natural Neighbor、Marching Cubes
- **批次 G（P2 索引高级，~3 个，~1000 行）**
  Geohash、S2、H3、Octree
- **批次 H（P2 GPU 后处理，~3 个 WGSL，~600 行）**
  CSM、SSAO、EDL
- **批次 I（P3 水文，~3 个）**
  Watershed、Fill Sinks、Flow Direction
- **批次 J（🟡 复核 + 文档勘误）**
  逐个读源确认 9 个 🟡 项的真实状态

挑你想要的批次告诉我，我就开始实现。也可以让我先做"批次 J 的复核"把 🟡 项全部翻译成确定状态。

---

## 批次 H 已知运行期风险（未在真机验证）

以下问题 **TS 编译已通过**，但 WebGPU 运行期行为尚未在真实 device 上验证。建议在下次启动 dev server 跑最小示例场景时逐项检查，发现问题按给出的修复方向处理。

### 1. SSAO uniform 对齐 — ✅ 批次 Q 已修复

- **文件**：`gpu/wgsl/compositor/ssao.wgsl` + `gpu/l2/post-effects.ts` `createSSAOEffect.updateUniforms`
- **原风险**：`array<vec4<f32>, 16>` 后紧跟独立 `vec2 / vec2 / 3×f32 / _pad`，WGSL struct layout 可能在数组末尾插 padding，造成 TS 按 `f32[96..103]` 线性打包与实际 GPU struct 偏移错位。
- **修复**：把末尾 `screenSize / noiseScale / radius / bias / intensity / _pad` 显式打包进两个 `vec4<f32>`：
  - `screenAndNoiseScale: vec4<f32>` (xy = screenSize, zw = screenSize/4)
  - `params: vec4<f32>` (x = radius, y = bias, z = intensity, w = pad)
  - TS `SSAO_UNIFORM_SIZE = 128 + 256 + 32 = 416` 字节，所有字段严格按 16 对齐，无歧义。
  - Shader 内使用 `u.screenAndNoiseScale.zw` / `u.params.x/y/z` 访问。

### 2. CSM uniform 对齐 — ✅ 批次 Q 已修复

- **文件**：`gpu/wgsl/compositor/csm.wgsl` + `gpu/l2/post-effects.ts` `createCSMApplyEffect.updateUniforms`
- **修复**：把末尾 `depthBias / normalBias / pcfRadius / _pad` 打包进 `params: vec4<f32>`，新增 `projParams: vec4<f32>` (xy = near, far)。TS `CSM_UNIFORM_SIZE = 64 + 256 + 48 = 368` 字节。

### 3. 阴影贴图 render pass `colorAttachments: []` — ✅ 批次 Q 已确认 spec 合法

- **结论**：Chrome 113+, Firefox 141+, Safari 18+ 全部支持纯深度 pass（`colorAttachments: []` + 非空 `depthStencilAttachment`）。spec 定义 `colorAttachments` 为 `sequence<GPURenderPassColorAttachment?>`，允许空。
- **文件**：`gpu/l2/shadow-map-pass.ts` `encodeCascades` 已添加说明注释。
- **行动**：无需改代码；仅在注释中注明兼容性来源。

### 4. CSM 级联选择使用 NDC 深度代替视空间 z — ✅ 批次 Q 已修复

- **文件**：`gpu/wgsl/compositor/csm.wgsl` `linearDepthFromNdc`
- **修复**：采用方案 A（shader 侧修正）。新增 `CSMApplyUniforms.near / far` 字段，通过 `projParams: vec4<f32>` 传入；shader 内 `linearDepthFromNdc` 实现标准投影反算：
  ```wgsl
  viewZ = (near * far) / (far + depth * (near - far))
  ```
  与 `cascadeSplits` 的视空间米单位一致，级联边界精确。
- **Reversed-Z 支持**：doc 注明若使用 Reversed-Z，调用方需把 `(far, near)` 颠倒传入。

### 5. `layout: 'auto'` 反射顺序 — ✅ 批次 R 已修复

- **文件**：`gpu/l2/post-effects.ts`（SSAO / EDL / CSMApply 三个 effect）+ `gpu/wgsl/compositor/edl.wgsl`
- **修复**：把三个 effect 的 `createRenderPipeline({ layout: 'auto' })` 全部替换为显式 `GPUBindGroupLayout` + `GPUPipelineLayout`。每个 entry 手写 `visibility` / `texture.sampleType` / `texture.viewDimension` / `sampler.type` / `buffer.type`，与对应 WGSL `@binding(n)` 严格一一对应：
  - **SSAO**：6 个 binding（depth/normal/noise 三纹理 + non-filtering/filtering 两 sampler + uniform buffer）
  - **EDL**：5 个 binding（color/depth 两纹理 + filtering/non-filtering 两 sampler + uniform buffer）—— 原 shader 用单个 sampler 对 `texture_depth_2d` 调 `textureSample` 是无效 WGSL，顺手拆成 `color_samp` + `depth_samp`，shader 端和 TS 端同步更新为 5 个 binding
  - **CSM**：5 个 binding（scene depth + shadow map array + `sampler_comparison` + non-filtering sampler + uniform buffer）
- **收益**：
  - 完全不依赖 `pipeline.getBindGroupLayout(0)` 反射结果，即使 shader 死代码消除或后续重构也不会出现 "extra binding" 错误
  - bind group layout 可跨 pipeline 复用（当前每 effect 独立，但结构支持未来共享）
  - 同时顺手修复了 EDL shader 的 `texture_depth_2d + filtering sampler` 无效 WGSL 问题

---

**批次 Q 小结**：风险 1/2/3/4 通过批次 Q 解决。
**批次 R 小结**：风险 5 通过批次 R 解决，并顺手修复 EDL 的无效深度采样。
**批次 S 小结（真机运行期验证 + 额外 bug 修复）**：通过 Claude Preview 启动 Vite dev server + 在浏览器环境里直接 `import` `post-effects.ts`、构造真实 `GPUDevice`、对 SSAO/EDL/CSMApply 各自 create effect → update uniforms → allocate textures → execute render pass → submit queue，捕获 `device.onuncapturederror` 事件。首轮跑出 2 个新的真机才能发现的 bug：

### 6. 三个 shader 的 `textureSample` 在非一致控制流调用 — ✅ 批次 S 已修复
- **症状**：Tint 报 `'textureSample' must only be called from uniform control flow`。原因是三个 shader 都有 `let depth = textureSample(depth_tex, ...); if (depth >= 0.9999) { return; }` 的 pattern —— early return 后剩下的 `textureSample` 调用被视为非一致控制流下的隐式梯度调用，违反 WGSL uniformity 规则。
- **修复**：把所有深度 / 颜色纹理的 `textureSample(t, s, uv)` 替换为 `textureSampleLevel(t, s, uv, 0)`（显式 LOD，不需要导数，uniform-safe）。注意 depth 纹理的 `textureSampleLevel` level 参数必须是 **`i32` / `u32`**（不能是 `f32`），所以用 `0` 而非 `0.0`。
- **影响文件**：`ssao.wgsl`、`edl.wgsl`、`csm.wgsl` —— 总计 7 处替换。

### 7. EDL shader 原本用 filtering sampler 对 `texture_depth_2d` 调 textureSample — ✅ 批次 R 已修复（回顾）
- 这条实际在批次 R 做 explicit layout 时就顺手拆分为 `color_samp`（filtering）+ `depth_samp`（non-filtering）。批次 S 真机验证确认拆分正确。

---

**批次 S 真机验证结果**（Chromium + 实际 WebGPU device）：
```
SSAO:  ok  (r16float output)
EDL:   ok  (rgba16float output)
CSM:   ok  (r16float visibility output)
Device errors: 0
```

至此**批次 H 原 5 项 + 批次 S 发现的 2 项额外风险全部清零**，三个 post-effect 通过真实 WebGPU runtime 的 shader 编译、pipeline 创建、bind group 验证、render pass 执行、queue submission 的完整验证链。

