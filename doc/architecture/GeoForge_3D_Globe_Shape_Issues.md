# 开源 3D GIS 引擎地球形状问题汇编 v2

> 涉及引擎：CesiumJS / cesium-native / MapLibre Globe / OpenGlobus
> 共 23 个 Issue，按 7 个子问题分类
> 12 项审计修复：补全 GPU 双精度算法、stencil WebGPU 等价、多截锥体原理、日期变更线 UV、防御性设计、picking 策略、occludee point 算法、精确对接 Pipeline v2 函数名、交叉引用、morph Issue

---

## 问题总述

```
3D Globe 渲染中"地球形状"相关问题的 7 个层面：

  ① 椭球体参数错误 → 地球变形/缩放不正确
  ② 投影矩阵/RTE 错误 → 地球在屏幕上呈椭圆/偏移
  ③ 瓦片细分不足 → 球面棱角、缝隙、孔洞
  ④ 地球消失/半球消失 → frustum/horizon culling 错误
  ⑤ 精度问题 → 近地面抖动(jitter)、z-fighting
  ⑥ 极地/日期变更线 → 极地瓦片畸变、经线接缝
  ⑦ 多图层球面渲染 → Polyline/光照/遮挡/picking/morph 错误
```

---

## 一、非 WGS84 椭球体——形状和投影不匹配

### CesiumJS #4244 — 非地球椭球体投影错误

**现象**：使用月球椭球体（`Ellipsoid.MOON`）时，球体和大气层大小正确，但影像瓦片仍按 WGS84 投影映射 → 纹理严重扭曲。
**根因**：`mapProjection` 设为月球椭球体时，内部影像加载仍硬编码 WGS84 参数。

### cesium-native — 非 WGS84 椭球体参数缺失

**现象**：`TilesetHeightQuery` 始终使用 WGS84 采样高度，在月球/火星上返回错误高程。
**修复**：补全所有 raster overlay 和 tileset 中的椭球体参数传播。

### CesiumJS #11656 / #10245 — 椭球体内半径缩放错误

**现象**：3D 模式下椭球体的内半径缩放不正确 → 半透明地球内壁形状畸变。

> **GIS-Forge 对接**：Globe Pipeline v2 `§一 WGS84 常量对象`——所有坐标转换函数以 `Ellipsoid` 参数化。未来支持非 WGS84 只需替换常量对象。

---

## 二、地球变形——投影矩阵/RTE 视图矩阵错误

### cesium-native 社区论坛 — 椭球体网格畸变和原点偏移

**现象**：OpenGL + cesium-native 项目中，Ellipsoid 网格严重畸变且原点不在地心。
**根因**：
1. viewMatrix 的 eye 传了绝对 ECEF 坐标而非 RTE 原点 → Float32 精度丢失
2. 投影矩阵的 aspect 比计算错误

> **GIS-Forge 对接**：与 GIS-Forge 当前 bug 完全一致——`viewRTE[14] = -26369352`。Globe Pipeline v2 `§二 computeCamera3D` 的 `mat4_lookAt([0,0,0], targetRTE, upECEF)` 已修复。

### CesiumJS #9498 — 非 WGS84 椭球体下 Camera.flyTo 失败

**现象**：自定义椭球体时 `Camera.flyTo` 飞行路径错误 → 相机飞到地球内部或太空。
**根因**：flyTo 内部距离/高度计算硬编码 WGS84 半径。

### CesiumJS #12815 — ECEF 模型在 2D/2.5D 模式下位置错误

**现象**：glTF 模型的顶点已在 ECEF 坐标系中，切换到 2D/Columbus View 后位置完全错误。
**根因**：2D/2.5D 模式的 modelView 矩阵不处理 ECEF→2D 的坐标变换。

> **GIS-Forge 对接**：Globe Pipeline v2 `§六 morph 过渡` 中两套坐标系（flatPosRel + globePosRel）归一化到相对空间解决了这个问题。

---

## 三、瓦片细分——球面棱角、缝隙、孔洞

### MapLibre Globe globe.md — 矢量瓦片细分导致单像素缝隙

**现象**：Globe 投影下相邻瓦片之间出现单像素缝隙。
**MapLibre 方案（Stencil 两遍法）**：
1. 第一遍：绘制不含边界的瓦片，标记 stencil
2. 第二遍：绘制含边界拉伸的瓦片，stencil 丢弃已绘制像素

**WebGPU 等价实现**：
```
WebGPU 完全支持 stencil——在 depthStencilState 中配置：
  depthStencilState: {
    format: 'depth24plus-stencil8',
    stencilFront: { compare: 'always', passOp: 'replace' },  // 第一遍
    stencilBack:  { compare: 'equal',  passOp: 'keep' },     // 第二遍
    stencilReadMask: 0xFF, stencilWriteMask: 0xFF,
  }
替代方案（GIS-Forge 当前选择）：裙边（skirt）遮挡接缝——更简单，
无需两遍 draw call，但需要额外 ~20% 的顶点几何。
```

### MapLibre Globe — 细分粒度配置

**问题**：Fill 图层 128 粒度足以平滑地平线，但 raster 瓦片需更高基础粒度。

### MapLibre Discussion #161 — 矢量 vs 纹理方案的球面伪影

- **矢量方案**：多边形几何必须细分到足够密，否则大三角形弯曲时不够圆滑
- **纹理方案**：瓦片渲染到离屏纹理 drape 到球面网格，无几何接缝但内存大

### CesiumJS #7928 — EllipsoidTerrainProvider + WebMercator 黑块

**现象**：WebMercatorTilingScheme 在球面上产生黑色方块。
**根因**：WebMercator 在 ±85.05° 以上无定义，但球面网格延伸到极点 → 极地纹理坐标无效。

### OpenGlobus — 三区域球面架构

**设计**：中央区域 EPSG:3857 + 两极 EPSG:4326 独立四叉树。避免 WebMercator 极地奇异性。

> **GIS-Forge 对接**：Globe Pipeline v2 `§三 tessellateGlobeTile` 基于弧度角细分 + `isNorthPole/isSouthPole` 扇形三角形处理。

---

## 四、地球消失——Frustum/Horizon Culling 错误

### CesiumJS #9161 — 设置 terrainProvider 后半球消失

**现象**：切换 terrainProvider 后地球一半变透明。
**根因**：terrain 加载中瓦片包围盒被错误计算 → frustum culling 错误剔除半球。

### CesiumJS #6301 / #6598 — 局部 terrain 导致半球消失

**现象**：仅覆盖小区域的 CesiumTerrainProvider 让地球其余部分消失。
**根因**：1.41 后 terrain 加载逻辑改变了"可渲染"判定——无 terrain 数据的瓦片被标记为不可渲染。

**GIS-Forge 防御性设计**：
```
规则：terrain 数据的缺失不能导致瓦片不可渲染。

实现：
1. 每个瓦片有两个独立状态：textureReady + demReady
2. textureReady=true + demReady=false → 渲染为平面瓦片（z=0）
3. textureReady=true + demReady=true  → 渲染为 terrain 瓦片
4. textureReady=false → 用父瓦片占位（Tile Solutions §方案一）
5. terrainProvider 切换时，旧 terrain 瓦片保留直到新 terrain 数据到达
   → 永远不会出现半球消失
```

### CesiumJS #526 — Horizon Culling 的 Occludee Point 算法

**问题**：horizon culling 用椭球体最小半径的球体近似，过于保守。

**CesiumJS 的 Occludee Point 算法**：
```
对每个瓦片计算一个"occludee point"——瓦片最高点在椭球面法线上的投影。
然后检查这个点是否在相机的地平线以下。

具体数学：
  1. 瓦片包围球中心 C，半径 r
  2. 相机位置 E（ECEF）
  3. 椭球体等效半径 R（当前用最小半径，应该用实际椭球体）
  4. 相机到地心距离 d = |E|
  5. 地平线角 θ = acos(R / d)
  6. 相机到瓦片方向 v = normalize(C - E)
  7. 相机法线方向 n = normalize(E)
  8. cos(α) = dot(v, n)  // 相机到瓦片的俯仰角
  9. 瓦片可见条件：α < θ + asin(r / |C - E|)
     即：瓦片方向角 < 地平线角 + 瓦片角半径

CesiumJS 的自评："保守球体让一些瓦片逃脱裁剪，terrain 又让一些瓦片被
过度裁剪——两个错误恰好互相抵消"
```

> **GIS-Forge 对接**：Globe Pipeline v2 `§四.2 isTileVisible_Horizon` 用 `dot(camToTile, normal) < margin` 实现，margin 基于瓦片角半径。与 CesiumJS occludee point 的简化等价。

---

## 五、精度问题——抖动(Jitter)与 Z-Fighting

### CesiumJS #12879 — Intel Arc GPU 抖动

**现象**：Intel Arc GPU 上地球表面顶点抖动。
**根因**：Intel Arc 着色器编译器的 Float32 精度处理与 NVIDIA/AMD 不同。

### CesiumJS `EncodedCartesian3` — GPU 双精度模拟

**原理**：将一个 Float64 值拆分为两个 Float32 值（high + low），在 GPU 上重组：

```javascript
// CPU 侧拆分（CesiumJS EncodedCartesian3.encode）
function encode(value: number): { high: number; low: number } {
  // high = 去掉低位后的近似值（对齐到 65536 的倍数）
  const high = Math.floor(value / 65536.0) * 65536.0;
  const low = value - high;  // 残差，值小，Float32 精度足够
  return { high, low };
}

// 举例：value = 6,378,137.123456（地球赤道半径+小数）
//   high = 6,356,992.0     （65536 的倍数）
//   low  = 21,145.123456   （差值，Float32 可精确表示）

// GPU 侧重组（GLSL/WGSL）
// position = positionHigh + positionLow - eyeHigh - eyeLow
// 因为 high-high 和 low-low 分别相减，避免了大数相减的精度丢失
```

**社区改进**：65536.0 因子导致 low 值在地球表面可达 50000+，仍有精度问题。改用 2048.0 可获得亚厘米级精度。

### CesiumJS — 对数深度 + 多截锥体

**对数深度**：`gl_FragDepth = log2(z+1) / log2(far+1)`

**多截锥体原理**：
```
当 near=0.1m far=1e8m 时，即使对数深度也不够。
CesiumJS 将场景按深度范围分割为多个截锥体：

  Frustum 0: near=0.1m,   far=1000m     → 近处高精度
  Frustum 1: near=800m,   far=100000m   → 中距离
  Frustum 2: near=80000m, far=1e8m      → 远处

每个截锥体独立渲染，最后合并（先远后近，利用深度测试自然遮挡）。
截锥体的 near/far 有 20% 重叠避免接缝。

缺点：每个截锥体独立提交 draw call → 渲染负载翻倍/三倍。
CesiumJS 只在对数深度不足时才启用多截锥体。
```

### CesiumJS #8706 / #8727 — 对数深度 + Polyline 兼容问题

**现象**：对数深度下 polyline 伪影；极端深度范围的多截锥体深度解析不正确。

### cesium-unreal #6 / cesium-unity #20 — 游戏引擎中的精度问题

**问题**：Unreal/Unity 中 model-view 矩阵用 Float32 计算 → 远离原点时 jitter。
**方案**：
- Unreal：`SetNewWorldOrigin()` 动态 rebasing（将世界原点移到相机附近）
- Unity：手动实现 dynamic rebasing（Unity 无内置支持）

> **GIS-Forge 对接**：
> - Globe Pipeline v2 `§三 meshToRTE` + `§七 onFrame3D` 使用 CPU Float64 减法 + Float32 传 GPU
> - 暂不实现 EncodedCartesian3 双精度模拟（RTE 在 zoom<20 时精度足够）
> - 如果 Intel Arc 等 GPU 出现精度问题，可在 `§三 meshToRTE` 中改用 high/low 拆分

---

## 六、极地与日期变更线

### MapLibre Globe — Horizon Clipping 极地驱动 bug

**现象**：某些手机 GPU 的 `glDepthRange` 和裁剪执行顺序不正确 → 极地瓦片被错误裁剪。
**解法**：face culling + fragment shader 中丢弃超出地平线的像素。

### MapLibre Globe — 日期变更线纹理接缝

**问题**：跨 ±180° 瓦片纹理坐标不连续 → 可见接缝线。

**具体 UV 处理方案**：
```
标准瓦片：U = (lng - tileLngMin) / (tileLngMax - tileLngMin)
  → 从 0 到 1 单调递增

跨日期变更线的瓦片（如 lngMin=170°, lngMax=-170°）：
  问题：170° 到 -170° 跨越了 360° → U 从接近 1 跳到接近 0
  
  解法 1（MapLibre）：将 -170° 视为 190°，U 正常递增
    U = (lng - 170) / (190 - 170) = (lng - 170) / 20
    对 lng=-170 → U = (190-170)/20 = 1.0 ✅

  解法 2（GIS-Forge）：在 coveringTilesGlobe 中，
    当 lngRange > 180° 时扩展为 [-180, 180] 全覆盖，
    消除跨日期变更线的瓦片
```

### CesiumJS — 极地 WebMercator 无定义区域

**解法**：CesiumJS/OpenGlobus 用 EPSG:4326 单独处理极地。

> **GIS-Forge 对接**：Globe Pipeline v2 `§四.4 coveringTilesGlobe` 步骤 2 中 `if (mxLng - mnLng > 180) { mnLng = -180; mxLng = 180; }`。极地退化三角形在 `§三.2 tessellateGlobeTile` 的 `isNorthPole/isSouthPole` 分支处理。

---

## 七、多图层球面渲染 + Morph 过渡

### CesiumJS #12371 — Polyline 与 Globe 渲染闪烁

**现象**：polyline 在地球表面上渲染时在地表上下跳跃。
**根因**：polyline 深度计算与 globe 对数深度不匹配。

### MapLibre #5229 — Globe 光照位置不一致

**现象**：球面地形和挤出建筑物的光照方向不同——看起来有两个太阳。
**根因**：Globe 着色器用了与平面模式不同的法线空间。

### CesiumJS 论坛 — 大椭球体遮挡错误

**现象**：地球大小的半透明椭球体遮挡关系不正确。
**根因**：遮挡计算用简化球体近似。

### CesiumJS #8481 — Globe Picking 性能极慢

**现象**：高细节 terrain 上 pick 操作每帧 10ms+。
**根因**：射线与所有瓦片三角形求交，高 LOD 三角形量巨大。

**GIS-Forge Picking 策略**：
```
方案 A（推荐）：GPU Depth Readback
  1. 渲染 globe 时同时写入深度纹理（depth32float）
  2. pick 时用 readPixels 读回鼠标位置的深度值
  3. 用 inverseVP 反投影 → ECEF 世界坐标
  4. 复杂度 O(1)，不依赖三角形数量
  缺点：readPixels 有 1 帧延迟（WebGPU 中需要 mapAsync）

方案 B：CPU Ray-Ellipsoid + DEM 采样
  1. 射线-椭球体求交得到近似交点
  2. 用 DEM 纹理在交点附近采样精确高程
  3. 沿射线二分查找精确交点
  4. 复杂度 O(log n)
  适用于无 GPU readback 的环境
```

### CesiumJS #423 (cesium-unreal) — 无 terrain 纯椭球体模式

**需求**：远距离只需光滑球面 + 影像。
**方案**：`EllipsoidTilesetLoader` 生成零高程球面网格。

### CesiumJS morph — 3D/Columbus/2D 切换的形状问题

**现象**：CesiumJS 在 SCENE3D → COLUMBUS_VIEW → SCENE2D 切换时，如果 morph 插值不正确，地球形状会在过渡期间严重畸变（中间帧的几何既不是球也不是平面）。
**CesiumJS 方案**：对每个顶点在 ECEF（球面坐标）和 2D（平面坐标）之间做线性插值：`pos = lerp(flatPos, globePos, morphFactor)`
**关键陷阱**：两套坐标必须在同量级的空间中插值（CesiumJS 用了内部归一化）。

> **GIS-Forge 对接**：Globe Pipeline v2 `§六 computeMorphVertices` 将两套坐标归一化到以 center 为原点的相对空间（flatPosRel + globePosRel），数值量级一致后 mix 产生平滑过渡。与 **Tile Solutions §方案六**（cross-fade）联动——morph 期间旧模式瓦片保留直到新模式瓦片就绪。

---

## 八、对 GIS-Forge 的设计要求总结

### 已在 Globe Pipeline v2 中解决的

| 问题类型 | 对应 Issue | Pipeline v2 解决方案 |
|---------|-----------|-------------------|
| RTE viewMatrix 偏移 | cesium-native 论坛 | `§二 computeCamera3D` → `lookAt([0,0,0], targetRTE, up)` |
| 投影矩阵 aspect | 同上 | `§二` → `aspect = viewport.width/viewport.height` |
| 极地退化三角形 | CesiumJS #7928 | `§三 tessellateGlobeTile` → `isNorthPole/isSouthPole` 扇形 |
| 对数深度 | CesiumJS #8706/#8727 | `§五 globe_vs` → `applyLogDepth` + `depth32float` |
| Horizon + Frustum 双裁剪 | CesiumJS #526/#9161 | `§四ivisTileVisible_Horizon` + `_Frustum` |
| 日期变更线 | MapLibre Globe | `§四 coveringTilesGlobe` → BBox 跨 180° 扩展 |
| Backface Culling | MapLibre Globe | `§五` → `cullMode: 'back'` |
| Morph 坐标归一化 | CesiumJS morph | `§六 computeMorphVertices` → flatPosRel + globePosRel |
| Float64→Float32 RTE | cesium-unreal #6 | `§三 meshToRTE` → CPU Float64 减法 |

### 待实现

| 优先级 | # | 需求 | 对应 Issue | 影响的已有模块 |
|-------|---|------|-----------|-------------|
| P1 | 1 | 椭球体参数化（非 WGS84） | CesiumJS #4244 | `§一 WGS84` 改为 `Ellipsoid` 参数 |
| P1 | 2 | Globe picking（GPU depth readback） | CesiumJS #8481 | 新增 `@gis-forge/globe-picking` |
| P1 | 3 | Globe 光照一致性（ECEF 法线空间） | MapLibre #5229 | `§五 globe_fs` 光照计算 |
| P1 | 4 | 瓦片接缝 stencil 方案（备选） | MapLibre Globe | `depthStencilState` 配置 |
| P1 | 5 | 极地 EPSG:4326 瓦片 | OpenGlobus | `§四 coveringTilesGlobe` 扩展 |
| P2 | 6 | GPU 双精度（high/low 拆分） | CesiumJS #12879 | `§三 meshToRTE` 改为 EncodedCartesian3 |
| P2 | 7 | 多截锥体 | CesiumJS #8727 | `§七 onFrame3D` 分截锥体渲染 |
| P2 | 8 | 纯椭球体模式（无 terrain） | cesium-unreal #423 | 新增 `EllipsoidTilesetLoader` |
| P2 | 9 | Polyline Globe 深度一致性 | CesiumJS #12371 | Polyline shader 对数深度 |
| P2 | 10 | 矢量瓦片 Globe 细分自适应 | MapLibre Globe | 新增 subdivide 模块 |

### 与其他 GIS-Forge 文档的交叉引用

| 本文 Issue | 相关 GIS-Forge 文档 | 交叉点 |
|-----------|-------------------|--------|
| §四 半球消失 | **Tile Solutions §方案一** | 父瓦片占位——terrain 切换时旧瓦片保留 |
| §四 半球消失 | **Tile Solutions §方案四** | 错误分级——terrainProvider 404 不应标记瓦片为不可渲染 |
| §三 极地黑块 | **Overzoom Solutions §方案一** | DEM 瓦片在极地也需要 overzoom 处理 |
| §五 精度 | **2.5D Pipeline §九** | 相机相对坐标——Globe RTE 与 2.5D 相机相对坐标原理相同 |
| §七 morph | **Tile Solutions §方案六** | cross-fade——morph 期间新旧模式瓦片平滑过渡 |
| §六 日期变更线 | **Terrain Issues §七 P1.5** | DEM 瓦片在日期变更线也有同样的 UV 不连续问题 |
