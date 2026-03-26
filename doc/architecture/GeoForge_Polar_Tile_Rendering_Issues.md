# 3D GIS 引擎南北极瓦片渲染问题汇编 v2

> 来源引擎：CesiumJS / MapLibre Globe / Mapbox GL / OpenGlobus / iTowns / Deck.GL
> 共 14 个 Issue + 2 篇技术博客 + 3 篇社区帖子
> v2：10 项审计修复——补全绕序数学推导、Issue URL、裙边极地分析、
>     OpenGlobus 分界线、验证方法、交叉引用

---

## 一、Web Mercator 投影的极地根本限制

**所有使用 Web Mercator（EPSG:3857）瓦片的 3D Globe 引擎都面临同一个数学问题。**

Web Mercator 的纬度映射公式 `y = ln(tan(π/4 + φ/2))` 在 φ→±90° 时趋向无穷大。瓦片在 ±85.051° 处截断：

```
φ_max = 2·arctan(e^π) - π/2 ≈ 85.05112878°

结果：北纬 85.05° 到北极点、南纬 85.05° 到南极点
      共 ~990km 的极地区域没有 Mercator 瓦片数据
```

这不是任何引擎的 bug——是投影数学的固有限制。各引擎的区别在于如何处理这片"真空区"。

---

## 二、各引擎极地 Issue 汇总

### 2.1 CesiumJS

**#3153 — Web Mercator Polar Caps 纹理跳动**
https://github.com/CesiumGS/cesium/issues/3153

Mercator 投影下极地附近瓦片纹理映射出现跳动——Greenland 北海岸在 zoom 切换时位移数度。开发者指出极地"caps"与 Mercator→Geographic 重投影的纹素插值错误有关。

**#7928 — EllipsoidTerrainProvider + WebMercator 黑块**
https://github.com/CesiumGS/cesium/issues/7928

WebMercatorTilingScheme 在球面上产生黑色方块。根因：WebMercator 在 ±85.05° 以上无定义，但球面网格延伸到极点 → 极地纹理坐标无效。

**#7451 — Fix Rectangle Positions at North and South Poles**
https://github.com/CesiumGS/cesium/pull/7451

矩形几何体在南北极点附近的位置计算错误。修复确保极地瓦片顶点正确放置在 EPSG:4326 网格上。

**Cesium 社区 — "Holes on the poles with WebMercatorTilingScheme"**
https://community.cesium.com/t/having-holes-on-the-poles-when-rendering-tiles-with-webmercatortilingscheme/10122

使用 WebMercator 瓦片方案时南北极都出现孔洞。单瓦片加载正常，多瓦片模式下极地无覆盖。

**Cesium 社区 — Custom TerrainProvider "Donut World"**
https://community.cesium.com/t/custom-terrainprovider-polar-caps/13928

基于 WebMercator 的 Cesium-Martini terrain provider 使地球外观如同甜甜圈。CesiumJS 默认 terrain provider 无此问题——它使用 GeographicTilingScheme（EPSG:4326）覆盖到 ±90°。

**CesiumJS Blog 2023-10 — Large Polygons & Stereographic Projection**
https://cesium.com/blog/2023/10/19/large-polygons-in-cesiumjs/

大面积多边形跨越极地时 earcut 三角剖分在 2D 投影中产生错误结果。CesiumJS 引入 Stereographic（极坐标）投影解决：用保角投影保持形状精度，在极坐标空间中做三角剖分和绕序判定。

### 2.2 MapLibre Globe

**Discussion #161 — "Hole in pole"**
https://github.com/maplibre/maplibre/discussions/161

Globe 投影概念验证的开发者明确承认：

> "Hole in pole: I did not manage to fill the hole after 85° of latitude."

MapLibre Globe 使用离屏纹理方案——先渲染 Mercator 瓦片到离屏纹理，再 drape 到球面网格。Mercator 瓦片在 85° 截断，球面网格极地区域无纹理数据。

### 2.3 Mapbox GL

**#12026 — Globe 极地渲染多种缺陷**
https://github.com/mapbox/mapbox-gl-js/issues/12026

v2.9.1 的 Globe 投影在极地出现三类问题：瓦片边界白色点状接缝、极地大面积白色三角形（裁剪错误）、极地 polyline 膨胀为巨大多边形。Globe 投影下极地区域的顶点插值和裁剪逻辑都存在边界情况。

### 2.4 OpenGlobus

**三区域球面架构（Wiki: CanvasTiles）**
https://github.com/openglobus/openglobus/wiki/HOWTO:-using-CanvasTiles-layer-for-rendering-heatmaps

OpenGlobus 将球面分为三个独立四叉树区域：

```
中央区域：EPSG:3857（Web Mercator），纬度约 ±85°
北极区域：EPSG:4326（地理坐标），纬度 ~85°N → 90°N
南极区域：EPSG:4326（地理坐标），纬度 ~85°S → 90°S

分界线 ≈ Mercator 有效纬度上限 85.05°
```

每个区域的瓦片独立管理。`material.segment.isPole` 属性标识当前瓦片是否属于极地区域，极地区域的 `getExtent()` 返回经纬度坐标（度）而非 Mercator 坐标。

### 2.5 iTowns

**#1282 — 极地渲染不可用**
https://github.com/iTowns/itowns/issues/1282

iTowns 开发者明确声明极地不可用：

> "Concerning the behavior at the poles: they are not usable in iTowns, due to the way the globe is subdivided around them."

极地细分产生高度畸变的三角形，大面积几何体的三角剖分穿过地球内部。

**v2.31.0 — "doesn't subdivise the pole tile mesh"**
https://github.com/iTowns/itowns/releases/tag/v2.31.0

GlobeLayer 停止对极地瓦片进一步细分。极地区域以固定颜色填充（`noTextureColor`），不渲染实际瓦片纹理。

### 2.6 Deck.GL / NASA CASEI

**Development Seed 技术博客（2024-12）— Fly Me to the Poles**
https://developmentseed.org/blog/2024-12-19-casei-globe/

NASA CASEI 团队测试了 Mapbox Globe View、MapLibre 和 Deck.GL 三种方案：

> "The Web Mercator tiles don't cover the Earth between 85 and 90 degrees, so there is a visible 'hole' in tile data near the poles."

三种方案都面临极地孔洞。对需要极地数据的科学可视化，这是关键限制。

---

## 三、各引擎极地方案对比

| 引擎 | 极地覆盖 | 方案 | 效果 |
|------|---------|------|------|
| **CesiumJS** | ✅ 完整 | EPSG:4326 TilingScheme 覆盖 ±90°；极地顶点/三角剖分/绕序专门处理；Stereographic 投影辅助 | 最佳——极地无洞无畸变 |
| **OpenGlobus** | ✅ 完整 | 三区域架构：中央 EPSG:3857 + 两极 EPSG:4326 独立四叉树，~85° 分界 | 优秀——架构级解决 |
| **MapLibre** | ❌ 有洞 | Mercator 瓦片 drape 到球面，85° 截断，无极地填充 | 极地 ~5° 孔洞 |
| **Mapbox GL** | ⚠️ 部分 | 类似 MapLibre，有极地裁剪/接缝/polyline 膨胀问题 | 极地多种渲染缺陷 |
| **Deck.GL** | ❌ 有洞 | 依赖 Mercator 瓦片源，无极地特殊处理 | 极地 ~5° 孔洞 |
| **iTowns** | ❌ 不可用 | 极地细分产生畸变，官方声明不可用 | 极地纯色填充 |
| **GIS-Forge** | ⚠️ 南极有洞 | 扇形三角形替代退化网格 + 裙边，但南极扇形绕序错误 | 北极正确，南极被 cull |

**CesiumJS 能做到极地完美覆盖的核心原因**：它默认使用 GeographicTilingScheme（EPSG:4326）而非 WebMercatorTilingScheme。EPSG:4326 的经纬度网格天然覆盖 ±90°，没有 Mercator 在 85° 的截断问题。

---

## 四、GIS-Forge 南极黑洞根因分析

截图显示 GIS-Forge 的 3D 地球南极出现圆形黑洞，但北极完整无缺。这个问题与上述行业通用的 Mercator 极地截断无关——它是 GIS-Forge 自身的三角形绕序 bug。

### 4.1 根因：南极扇形三角形绕序错误

`globe-tile-mesh.ts` 的 `tessellateGlobeTile` 函数中，极地瓦片（`y=0` 北极 / `y=numTiles-1` 南极）使用扇形三角形替代退化的矩形网格。北极扇形正确，南极扇形绕序错误。

### 4.2 数学推导

设 `segments=4, n1=5, lastRow=4`：

```
网格行排列（从北到南）：
  row=0: latMax → 顶点 0,1,2,3,4
  row=3: ...   → 顶点 15,16,17,18,19
  row=4: 南极点 → 顶点 20,21,22,23,24（ECEF 全部汇聚到同一点）

极点索引: poleIdx = lastRow × n1 = 20
```

**当前南极扇形（col=0）**：`v0=15, v1=20(极点), v2=16`

```
右手法则验证：
  edge1 = v1 - v0 = (极点 - 外圈左) 
        → 主方向：向 -Z（南极在 ECEF 中 Z 为负）
  edge2 = v2 - v0 = (外圈右 - 外圈左)
        → 主方向：沿纬圈切线

  normal = edge1 × edge2 → 指向地球内部（-R 方向）
  从外部看：CW（顺时针）= 背面 ❌
```

**北极扇形对照（col=0）**：`v0=0(极点), v1=5, v2=6`

```
  edge1 = v1 - v0 = (外圈左 - 极点) → 离开极点方向
  edge2 = v2 - v0 = (外圈右 - 极点) → 离开极点方向

  normal = edge1 × edge2 → 指向地球外部（+R 方向）
  从外部看：CCW（逆时针）= 正面 ✅
```

**GPU 管线 `cullMode: 'back'` + `frontFace: 'ccw'`** → 南极扇形全部被背面剔除 → 黑洞。

### 4.3 为什么不对称

北极扇形以极点为 v0 向外展开（扇心→边缘→边缘），天然形成 CCW。
南极扇形以外圈为 v0 向极点收拢（边缘→扇心→边缘），v1 插在中间打断了 CCW 绕序。

### 4.4 裙边不受影响

`globe-tile-mesh.ts` 中极地瓦片的裙边逻辑：

```typescript
const hasTopSkirt = !isNorthPole;     // 北极瓦片顶边不生成裙边（扇形退化）
const hasBottomSkirt = !isSouthPole;  // 南极瓦片底边不生成裙边（扇形退化）
const hasLeftSkirt = true;            // 左右裙边始终生成（经线段不退化）
const hasRightSkirt = true;
```

极地扇形边缘（退化边）已跳过裙边生成，修复扇形绕序不影响裙边索引。

---

## 五、修复方案

### P0：南极扇形绕序修复（立即）

在 `globe-tile-mesh.ts` 的 `tessellateGlobeTile` 函数中，`isSouthPole` 分支交换后两个索引：

```typescript
// 修复前（v1=极点在中间 → CW = 背面 ❌）
indices[ii++] = (lastRow-1) * n1 + col;      // 外圈左
indices[ii++] = poleIdx;                       // 极点
indices[ii++] = (lastRow-1) * n1 + col + 1;   // 外圈右

// 修复后（极点移到最后 → CCW = 正面 ✅）
indices[ii++] = (lastRow-1) * n1 + col;        // 外圈左
indices[ii++] = (lastRow-1) * n1 + col + 1;    // 外圈右（交换）
indices[ii++] = poleIdx;                        // 极点（交换）
```

**验证方法**：
1. 刷新渲染，旋转到南极视角——黑洞消失
2. 开启 wireframe 模式确认南极扇形三角形可见
3. 从地球内部观察南极——应被 `cullMode: 'back'` 剔除（不可见）
4. 对比北极——两极行为一致

### P1 #5：极地 EPSG:4326 瓦片覆盖（中期）

当前 `coveringTilesGlobe` 已有极地行扩展逻辑：

```typescript
const MERCATOR_LAT_LIMIT = 85.05;
if (mxLat > MERCATOR_LAT_LIMIT || camera.altitude > 5_000_000) {
    minTY = 0;        // 包含北极行
}
if (mnLat < -MERCATOR_LAT_LIMIT || camera.altitude > 5_000_000) {
    maxTY = numTiles - 1;  // 包含南极行
}
```

这保证极地瓦片被请求，但纹理仍依赖 Mercator 源的 ±85° 覆盖。完整解决参考 OpenGlobus/CesiumJS：

| 方案 | 复杂度 | 效果 |
|------|--------|------|
| A. 极地纯色填充 | 低 | 极地用深蓝/冰白色填充，无纹理但无孔洞 |
| B. Natural Earth 极地纹理 | 中 | 预烘焙极地冰盖纹理贴到扇形区域 |
| C. 三区域架构（OpenGlobus 方案） | 高 | 极地独立四叉树 + EPSG:4326 瓦片源 |

**推荐路径**：先实现方案 A（极地扇形渲染为 `baseColor`），后续按需升级到方案 B/C。

---

## 六、与 GIS-Forge 文档的交叉引用

| 本文内容 | 相关文档 | 交叉点 |
|---------|---------|--------|
| §四 南极绕序 | **Globe Shape Issues v2 §三** | 同一 bug，Shape Issues 从"球体形状"角度记录，本文从"极地渲染"角度记录 |
| §四 cullMode | **Globe Pipeline v2 §五.5** | `cullMode: 'back'` + `frontFace: 'ccw'` 的管线配置 |
| §四 裙边 | **Globe Pipeline v2 §三.2** | 裙边抗接缝设计，极地边缘跳过裙边 |
| §五 coveringTilesGlobe 极地扩展 | **Globe Pipeline v2 §四.4** | `MERCATOR_LAT_LIMIT` 检查和极地行包含逻辑 |
| §五 方案 A 纯色填充 | **Globe Pipeline v2 §七 P2 #8** | "Pure ellipsoid mode"——无纹理时用 baseColor 渲染 |
| §二.1 CesiumJS Stereographic | **Globe Shape Issues v2 §七 P2 #10** | 极地多边形三角剖分需要保角投影 |
| §二.4 OpenGlobus 三区域 | **Globe Shape Issues v2 §三** | 三区域架构作为 GIS-Forge 极地长期方案参考 |
