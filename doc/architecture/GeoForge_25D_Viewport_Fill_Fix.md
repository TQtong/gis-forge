# GeoForge 2.5D 地面未填满视口——完整修复方案

> **现象**：任何 zoom（含 z=8.8 乡镇级别），只要有 pitch，地面始终无法铺满视口。
> **根因**：不是缺天空——是远裁面(far plane) + 瓦片覆盖算法(coveringTiles) + 可能还有相机模型本身有误。
> **参考引擎**：MapLibre [#1080](https://github.com/maplibre/maplibre-gl-js/issues/1080) / [#3983](https://github.com/maplibre/maplibre-gl-js/pull/3983) / [#719](https://github.com/maplibre/maplibre-gl-js/issues/719) / deck.gl MapView / CesiumJS

---

## 一、几何推导：为什么 pitch 后地面填不满

```
侧视图（相机、center、地面的几何关系）：

                 Camera ●                        ← 相机位置
                       /│╲
                      / │ ╲  ← 视锥上边缘射线
                     /  │  ╲    （角度 = pitch + fov/2）
                    /   │   ╲
                   / α  │ β  ╲
                  /     │     ╲
  ═══════════════/══════╪══════╲═══  ← 远裁面（far plane）
                /       │       ╲
  ─────────────/────────┼────────╲───  ← 地面（z=0）
              D_far    Center    D_near
                 
  │← topHalfSurfaceDist →│

  α = pitch + halfFov        （视锥上边缘与垂直方向的夹角）
  β = pitch - halfFov        （视锥下边缘与垂直方向的夹角）
  h = cameraToCenterDist × cos(pitch)  （相机海拔高度）
  
  如果远裁面截在 D_far 之前 → 地面在远端被裁掉 → 黑色空白！
```

### 核心公式（MapLibre transform.ts）

```
cameraToCenterDist = viewport.height / 2 / tan(fov / 2)

angleToHorizon = π/2 - pitch - fov/2

if angleToHorizon > 0:
    # 视锥上边缘仍指向地面
    topHalfSurfaceDist = sin(pitch) × cameraToCenterDist / sin(angleToHorizon)
    farZ = topHalfSurfaceDist × 1.1     ← 安全余量
else:
    # 视锥上边缘看到地平线/天空
    farZ = cameraToCenterDist × 100     ← 取很大的值
    
farZ = max(farZ, cameraToCenterDist × 2.0)   ← 兜底最小值
```

### farZ 对照表（fov=36.87°/0.6435rad，viewport.height=960px）

```
cameraToCenterDist = 1440

pitch(°)  angleToHorizon(°)  topHalfSurfDist  farZ/cameraToCenterDist  farZ
───────────────────────────────────────────────────────────────────────────
  0         71.57            —                 2.0x (兜底)              2880
 10         61.57            362               2.0x (兜底)              2880
 20         51.57            765               2.0x (兜底)              2880
 30         41.57            1240              2.0x (兜底)              2880
 40         31.57            1921              2.0x (兜底)              2880
 45         26.57            2277              1.74x → 2.0x            2880
 50         21.57            2815              2.15x                   3097
 55         16.57            3726              2.85x                   4099
 60         11.57            6219              4.75x                   6841  ← 固定2x完全不够
 65          6.57            15860             12.1x                   17446
 70          1.57            57886             44.2x                   63675
 71.57       0              ∞                 100x (兜底)             144000 ← 地平线
 75         -3.43           —                 100x                    144000
 80         -8.43           —                 100x                    144000
 85        -13.43           —                 100x                    144000
```

**关键观察**：
- pitch < 45° 时，2x 兜底就够了
- pitch 50°~60° 是 "危险区"：需要 2x~5x，固定 2x 完全不够
- pitch > 65° 后需要 12x~44x，急剧增长
- **你的截图是 pitch≈45°, zoom=8.8 还填不满——说明 farZ 可能连 1.5x 都没到，或者是其他环节有问题（见下面排查）**

---

## 二、可能的根因排查（5 个环节逐一检查）

截图中 zoom=8.8 + pitch≈45° 地面填不满，除了 farZ 之外还可能是以下环节出了问题。**按可能性从高到低排列**：

### 环节 1：farZ 计算

```
检查方法：在 Camera25D 构建投影矩阵处加 console.log

  console.log('[Camera25D] pitch:', this._pitch * 180/Math.PI, '°');
  console.log('[Camera25D] cameraToCenterDist:', cameraToCenterDist);
  console.log('[Camera25D] farZ:', farZ);
  console.log('[Camera25D] farZ/cameraToCenterDist:', farZ / cameraToCenterDist);

  ✅ 正确值（pitch=45°时）：ratio 应该 ≥ 2.0
  ❌ 如果 ratio < 2 → 远裁面太近 → 用上面的公式修复
```

### 环节 2：cameraToCenterDistance 计算

```
检查方法：打印 cameraToCenterDist 的值

  const expected = this._viewport.height / 2 / Math.tan(this._fov / 2);
  console.log('[Camera25D] cameraToCenterDist:', cameraToCenterDist, 'expected:', expected);

  ✅ 两者应该相等
  ❌ 如果 cameraToCenterDist 用了固定值或其他公式 → 修正为 viewport.height/2/tan(fov/2)
  
  这个值的含义：pitch=0 时，相机离 center 点多远。
  太大 → 相机太高 → 地面在视口中太小 → 填不满
  太小 → 相机太近 → 地面超出视口 → 不会有填不满的问题
```

### 环节 3：FOV（视场角）

```
检查方法：打印 FOV

  console.log('[Camera25D] fov:', this._fov, 'degrees:', this._fov * 180/Math.PI);

  ✅ MapLibre 默认 fov = 0.6435 rad ≈ 36.87°
  ❌ 如果 fov 太小（如 < 20°）→ 看到的范围小 → 地面更难填满
  ❌ 如果 fov 是弧度但被当成角度传入（差 57 倍！）→ 灾难性错误
```

### 环节 4：View Matrix（相机位置 + lookAt 方向）

```
MapLibre 的相机模型：
  1. center 是地面上的一个点（地图中心经纬度 → 墨卡托坐标）
  2. 相机在 center 的"上后方"：
     - 先在 center 正上方 cameraToCenterDist 处
     - 然后绕 center 旋转 bearing 角
     - 然后绕 center 倾斜 pitch 角（相机往后拉，视线往前倾）
  
  相机位置（世界坐标）：
    cameraX = centerMercX + sin(bearing) × sin(pitch) × cameraToCenterDist
    cameraY = centerMercY - cos(bearing) × sin(pitch) × cameraToCenterDist
    cameraZ = cos(pitch) × cameraToCenterDist
    
  View Matrix = lookAt(cameraPosition, centerMerc, up)
    up = [sin(bearing) × cos(pitch), -cos(bearing) × cos(pitch), sin(pitch)]
    // bearing=0 时 up = [0, -cos(pitch), sin(pitch)]
    
检查方法：
  console.log('[Camera25D] cameraPosition:', cameraPos);
  console.log('[Camera25D] cameraZ (height):', cameraPos[2]);
  
  ✅ cameraZ 应该 = cos(pitch) × cameraToCenterDist
     pitch=45° → cameraZ = 0.707 × 1440 = 1018
  ❌ 如果 cameraZ 远大于此值 → 相机太高 → 地面看起来太小
  ❌ 如果 lookAt 的 target 不是 centerMerc → 视线偏了 → 地面没对准
```

### 环节 5：VP 矩阵乘法顺序

```
正确顺序：
  vpMatrix = projMatrix × viewMatrix    ← 先 view 后 proj

错误顺序：
  vpMatrix = viewMatrix × projMatrix    ← 反了！地面会变形/截断

检查方法：
  // 在 shader 中测试——将所有 fragment 输出为红色
  // 如果红色区域只覆盖视口的部分 → VP 矩阵有问题
  // 如果红色覆盖正确区域但没有瓦片纹理 → 是 coveringTiles 的问题
```

---

## 三、修复 ①：动态远裁面

将上面的公式实现为代码（**清理干净，无注释噪音版本**）：

```typescript
/** 
 * 计算 2.5D 相机的远裁面距离。
 * 必须足够大以确保地面平面在视锥内延伸到地平线位置。
 */
private _computeFarZ(): number {
  const halfFov = this._fov / 2;
  const cameraToCenterDist = this._viewport.height / 2 / Math.tan(halfFov);
  const angleToHorizon = Math.PI / 2 - this._pitch - halfFov;
  
  let farZ: number;
  
  if (angleToHorizon > 0.01) {
    const topHalfSurfaceDist = Math.sin(this._pitch) * cameraToCenterDist 
      / Math.sin(angleToHorizon);
    farZ = topHalfSurfaceDist * 1.1;
  } else {
    farZ = cameraToCenterDist * 100.0;
  }
  
  return Math.max(farZ, cameraToCenterDist * 2.0);
}

/** 计算近裁面距离。 */
private _computeNearZ(): number {
  const cameraToCenterDist = this._viewport.height / 2 / Math.tan(this._fov / 2);
  return Math.max(cameraToCenterDist * 0.01, 1.0);
}

/** 重建投影矩阵。 */
private _rebuildProjectionMatrix(): void {
  const nearZ = this._computeNearZ();
  const farZ = this._computeFarZ();
  const aspect = this._viewport.width / this._viewport.height;
  
  // Reversed-Z: near 对应 depth=1, far 对应 depth=0
  mat4.perspectiveReversedZ(this._projMatrix, this._fov, aspect, nearZ, farZ);
}
```

---

## 四、修复 ②：覆盖瓦片算法（coveringTiles）

### MapLibre #1080 的核心设计

```
coveringTiles 的职责：给定当前相机状态，返回需要加载的瓦片列表。

2D 算法（pitch=0）：
  - 视口四角 unproject 到地面 → 得到 BBox
  - 在 BBox 内枚举当前 zoom 的所有瓦片
  - 简单、正确

2.5D 算法（pitch > 0）的问题：
  - 视口上方两角 unproject → 射线可能不与地面相交
  - 不相交的角被忽略 → BBox 不包含远处区域 → 远处瓦片不加载
  - 即使 farZ 足够大，没有瓦片数据也渲染不出东西！
```

### 修复算法

```typescript
/**
 * 当 unproject 失败时（射线不与地面相交），
 * 用 far plane 与地面的交线作为边界。
 */
coveringTiles(): TileID[] {
  const corners = [
    [0, 0], [this._viewport.width, 0],                    // 上
    [this._viewport.width, this._viewport.height], [0, this._viewport.height], // 下
  ];

  const groundCoords: LngLat[] = [];
  
  for (const [sx, sy] of corners) {
    const hit = this._camera.screenToLngLat(sx, sy);
    if (hit) {
      groundCoords.push(hit);
    } else {
      // ══ 关键修复 ══
      // 射线不与地面相交 → 沿射线的水平分量方向取最远距离
      const ray = this._camera.screenToRay(sx, sy);
      const horizLen = Math.hypot(ray.dir[0], ray.dir[1]);
      if (horizLen < 1e-6) {
        groundCoords.push(this._camera.center);
        continue;
      }
      // 沿水平方向取 farZ 的 90% 作为最远地面点
      const t = this._camera.farZ * 0.9 / horizLen;
      const worldX = ray.origin[0] + ray.dir[0] * t;
      const worldY = ray.origin[1] + ray.dir[1] * t;
      groundCoords.push(mercToLngLat(worldX, worldY));
    }
  }

  // 额外采样：视口上边缘中点（确保远处中央区域也被覆盖）
  const topMidHit = this._camera.screenToLngLat(this._viewport.width / 2, 0);
  if (topMidHit) groundCoords.push(topMidHit);
  else groundCoords.push(this._computeHorizonCenter());

  const bbox = LngLatBounds.fromCoords(groundCoords);

  // 瓦片枚举 + 远处 LOD 衰减
  return this._enumerateTilesWithLOD(bbox);
}

/**
 * 远处瓦片使用更低 zoom 级别（LOD 衰减）。
 * MapLibre #1080：基于 camera-to-tile 距离指数衰减。
 */
private _enumerateTilesWithLOD(bbox: LngLatBounds): TileID[] {
  const { zoom, center } = this._camera.state;
  const maxLodLevels = 4;  // 最多降 4 级 zoom
  const tiles: TileID[] = [];
  const centerTile = lngLatToTile(center, zoom);

  for (const tileCoord of enumerateTilesInBBox(bbox, zoom)) {
    const dist = tileDistance(tileCoord, centerTile);
    
    // 距离每翻倍 → zoom 降 1 级
    const lodDrop = Math.min(Math.floor(Math.log2(Math.max(1, dist))), maxLodLevels);
    const tileZoom = Math.max(0, zoom - lodDrop);
    
    // 转换为该 zoom 级别的瓦片坐标
    const parentTile = tileCoord.toZoom(tileZoom);
    
    // 去重（多个高 zoom 瓦片映射到同一个低 zoom 父瓦片）
    if (!tiles.find(t => t.equals(parentTile))) {
      // 视锥裁剪
      if (this._frustumTest(parentTile)) {
        tiles.push(parentTile);
      }
    }
  }
  
  return tiles;
}
```

---

## 五、修复 ③：地面 Mesh/Quad 大小

**这个容易被忽视但可能是你的截图根因之一**。

```
问题：如果每个瓦片是一个 Quad（4 个顶点的矩形），
那么 Quad 的世界坐标范围 = 该瓦片覆盖的墨卡托范围。

如果 coveringTiles 没有覆盖视口远端 → 那个区域没有 Quad → 没有像素被绘制 → 黑色。

这就是为什么修复②（coveringTiles 扩展）和修复①（farZ）必须同时做：
  - farZ 确保投影矩阵不会裁掉远处 → 但如果没有瓦片提交绘制命令也没用
  - coveringTiles 确保远处有瓦片 → 但如果投影矩阵把它们裁掉了也没用

两者缺一不可！

另一个可能性：你的引擎不是逐瓦片绘制 Quad，而是绘制一个统一的大地面平面？
如果是后者，检查这个平面的 XY 范围是否足够大：
  - 至少要覆盖 farZ 在地面上的投影范围
  - 简单做法：平面大小 = worldSize × 3（覆盖中心世界 + 左右各一个副本）
```

---

## 六、各引擎源码路径参考

| 引擎 | 远裁面 | 覆盖瓦片 | 相机模型 |
|------|--------|---------|---------|
| **MapLibre v5** | `src/geo/projection/mercator_transform.ts` → `_calcMatrices()` 中计算 farZ | `src/geo/projection/covering_tiles.ts` → `coveringTiles()` | `src/geo/projection/mercator_camera_helper.ts` |
| **MapLibre v2** | `src/geo/transform.ts` → `get farZ` / `_calcMatrices()` | `src/geo/transform.ts` → `coveringTiles()` | `src/geo/transform.ts` → camera position 从 pitch/bearing 推导 |
| **deck.gl** | `modules/core/src/viewports/web-mercator-viewport.ts` | 由 `MapView` + `TileLayer` 联合决定 | `@math.gl/web-mercator` 的 `getViewMatrix()` |
| **CesiumJS** | `Source/Scene/Camera.js` → `frustum.far` 动态设置 | `Source/Scene/QuadtreePrimitive.js` → SSE 驱动 | `Source/Scene/ScreenSpaceCameraController.js` |

---

## 七、给 Cursor 的完整排查脚本

将以下代码临时插入 Camera25D 的 `_rebuildMatrices()` 方法末尾：

```typescript
// ═══ 临时调试：粘贴到 Camera25D._rebuildMatrices() 末尾 ═══
if (typeof window !== 'undefined') {
  const halfFov = this._fov / 2;
  const cameraToCenterDist = this._viewport.height / 2 / Math.tan(halfFov);
  const pitchDeg = this._pitch * 180 / Math.PI;
  const fovDeg = this._fov * 180 / Math.PI;
  const angleToHorizon = Math.PI / 2 - this._pitch - halfFov;
  
  let expectedFarZ: number;
  if (angleToHorizon > 0.01) {
    expectedFarZ = Math.sin(this._pitch) * cameraToCenterDist / Math.sin(angleToHorizon) * 1.1;
  } else {
    expectedFarZ = cameraToCenterDist * 100;
  }
  expectedFarZ = Math.max(expectedFarZ, cameraToCenterDist * 2.0);

  // 从投影矩阵反推 near/far（column-major, Reversed-Z）
  // 标准透视矩阵: projMatrix[10] = far/(far-near), projMatrix[14] = near*far/(far-near)
  // Reversed-Z:   projMatrix[10] = near/(near-far), projMatrix[14] = near*far/(near-far)
  const p10 = this._projMatrix[10];
  const p14 = this._projMatrix[14];
  const actualNear = p14 / p10;
  const actualFar = p14 / (p10 - 1);  // 可能是负数取绝对值

  console.table({
    'pitch (°)': pitchDeg.toFixed(1),
    'fov (°)': fovDeg.toFixed(1),
    'cameraToCenterDist': cameraToCenterDist.toFixed(0),
    'angleToHorizon (°)': (angleToHorizon * 180 / Math.PI).toFixed(1),
    'expectedFarZ': expectedFarZ.toFixed(0),
    'expectedRatio': (expectedFarZ / cameraToCenterDist).toFixed(2),
    'actualNear (from matrix)': Math.abs(actualNear).toFixed(1),
    'actualFar (from matrix)': Math.abs(actualFar).toFixed(1),
    'actualRatio': (Math.abs(actualFar) / cameraToCenterDist).toFixed(2),
    'viewport': `${this._viewport.width}×${this._viewport.height}`,
    'cameraZ': this._position ? this._position[2]?.toFixed(0) : 'N/A',
  });

  // 红色警告
  const ratio = Math.abs(actualFar) / cameraToCenterDist;
  if (ratio < 1.5) {
    console.error('🔴 farZ/cameraToCenterDist =', ratio.toFixed(2), '← 太小！pitch=', pitchDeg.toFixed(0), '° 时需要至少', (expectedFarZ / cameraToCenterDist).toFixed(2), 'x');
  }
}
// ═══ 调试结束 ═══
```

**预期输出**（pitch=45°时）：

```
┌──────────────────────────┬────────────┐
│ pitch (°)                │ 45.0       │
│ fov (°)                  │ 36.9       │
│ cameraToCenterDist       │ 1440       │
│ angleToHorizon (°)       │ 26.6       │
│ expectedFarZ             │ 2880       │
│ expectedRatio            │ 2.00       │
│ actualNear (from matrix) │ 144.0      │   ← 应该 ≈ cameraToCenterDist × 0.01~0.1
│ actualFar (from matrix)  │ 2880.0     │   ← 应该 ≥ expectedFarZ
│ actualRatio              │ 2.00       │   ← 应该 ≥ expectedRatio
│ viewport                 │ 1232×960   │
│ cameraZ                  │ 1018       │   ← 应该 ≈ cos(45°) × 1440 = 1018
└──────────────────────────┴────────────┘
```

**如果 `actualRatio` 远小于 `expectedRatio`** → 修复①（farZ 公式）。
**如果 `actualRatio` 看起来正确但仍然空白** → 看 `cameraZ` 是否正确 → 如果不对 → 修复相机位置。
**如果全部看起来正确** → 问题在 coveringTiles（检查瓦片数量）或 Mesh 大小。

---

## 八、修复优先级

```
1. 先运行排查脚本（5分钟）→ 确认具体哪个环节出错

2. 如果是 farZ 问题：
   替换 _computeFarZ() → 用上面的公式 → 重新测试
   
3. 如果 farZ 正确但还是空白：
   检查 coveringTiles 输出数量和范围 → 如果远处缺瓦片 → 修复 coveringTiles
   
4. 如果瓦片数量也正确：
   检查相机位置/View Matrix/VP矩阵乘法顺序

5. 全部正确后：
   天空/Fog 是锦上添花（只在 pitch > 70° 时才需要）
```

---

## 九、天空（地面填满后的最后一步）

**只有 pitch 足够大（>~70°）使地平线出现在视口内时才需要天空。**

在 zoom=8.8 + pitch=45° 下，正确实现的引擎地面完全填满视口——不需要天空。

天空实现方案（优先级低，等地面问题解决后再做）：
- 将 clearColor 从黑色改为主题色（最简单，1 行代码）
- 全屏三角形 + sky-color → horizon-color 渐变 shader（P1 阶段）
- 大气散射（P2 Globe 包，与 Globe 共享）

---

## 十、测试验证

| 场景 | 验证方式 |
|------|---------|
| pitch=0°, zoom=10 | 地面填满视口，无空白 |
| pitch=30°, zoom=8 | 地面填满视口，无空白 |
| pitch=45°, zoom=8.8（截图场景） | 地面填满视口直到地平线，无空白 |
| pitch=60°, zoom=5 | 地面填满到地平线，地平线以上是 clearColor（可接受） |
| pitch=75°, zoom=3 | 地面填满下半部分，上半部分 clearColor，无崩溃 |
| 连续 pitch 动画 0°→85° | 地面范围平滑扩展，无闪烁/跳变 |
| zoom=0, pitch=45° | 全球尺度，地面仍然正确延伸 |
| zoom=18, pitch=45° | 街道级别，地面仍然正确延伸 |
| farZ 排查脚本 | `actualRatio >= expectedRatio` 在所有 pitch 下成立 |
| coveringTiles 数量 | pitch=45° 时瓦片数 ≥ pitch=0° 时的 1.5 倍 |
