# 3D GIS 引擎地球形状"鸡蛋化"问题汇编 v2

> 症状：3D 地球在屏幕上不是正圆而是椭圆/蛋形/偏移
> 涉及：CesiumJS / cesium-native / cesium-unreal / cesium-unity / MapLibre Globe / GeoForge
> 7 个根因 + 决策树 + GeoForge 两轮实际调试时间线

---

## 问题定义

```
正确的地球：在屏幕上看起来是正圆
  WGS84 椭球扁率仅 0.33%（赤道 6378km vs 极半径 6357km）
  肉眼完全不可见——即使 CesiumJS 用真实 WGS84 渲染，地球在屏幕上也是正圆

"鸡蛋"地球：在屏幕上明显椭圆/蛋形
  → 100% 是渲染管线 bug，不是真实椭球形状

公式：屏幕形状 = projMatrix × viewMatrix × 几何
      任何一步出错 → 变形
```

---

## 快速决策树（30 秒定位根因）

```
地球不是正圆？
  │
  ├─ 地球变形（椭圆/蛋形）
  │   ├─ projMatrix[0]/projMatrix[5] ≠ 1/aspect?
  │   │   └─ YES → 根因一（aspect 比错误）
  │   │
  │   ├─ projMatrix[0] 或 [5] 是负数?
  │   │   └─ YES → 根因三（矩阵被覆盖）
  │   │
  │   ├─ viewRTE[14] 的绝对值 > 100000?
  │   │   └─ YES → 根因二（RTE eye 不在原点）
  │   │
  │   └─ 用非 WGS84 椭球体?
  │       └─ YES → 根因六（椭球体参数不一致）
  │
  ├─ 地球极度放大或缩小（几乎看不到或占满屏幕）
  │   └─ → 根因七（fov 用了度而非弧度）
  │
  └─ 地球不变形但偏移（不在屏幕中心）
      ├─ CSS/Physical/Surface 三者尺寸不一致?
      │   └─ YES → 根因四（Canvas 配置错误）
      └─ viewRTE[12] 或 [13] ≠ 0?
          └─ YES → 根因五（viewport 偏移）
```

---

## 根因一：投影矩阵 aspect 比错误（最常见）

### 现象

地球在宽屏上竖向拉长（竖放鸡蛋）或横向拉扁。

### 具体 bug 场景

```
标准透视投影矩阵（WebGPU Z∈[0,1]）：
  f = 1 / tan(fov / 2)
  projMatrix[0] = f / aspect    （X 缩放）
  projMatrix[5] = f             （Y 缩放）
  projMatrix[0] / projMatrix[5] = 1 / aspect ← 判定条件

场景 A：aspect 写反
  aspect = height / width = 0.56 → ratio = 1.78（应该 0.56）
  → 地球横向拉扁

场景 B：aspect = 1（忘了传/硬编码）
  → 宽屏上地球竖向拉长

场景 C：mat4_perspective 参数顺序错误
  正确：mat4_perspectiveZO(proj, fov, aspect, near, far)
  错误：mat4_perspectiveZO(proj, fov, near, far, aspect) ← aspect 被当 near
  错误：mat4_perspectiveZO(proj, aspect, fov, near, far) ← fov/aspect 互换

场景 D：CSS vs 物理像素的 aspect 不一致
  通常 CSS 和物理的宽高比相同（只是均匀缩放）
  但在非均匀 DPR 缩放（极罕见）下会不同
```

### 受影响的引擎/项目

- **cesium-native 社区论坛**：自定义 OpenGL 渲染器中 aspect 错误
- **cesium-unity #20**：Unity 无内置 Globe，开发者自定义投影搞错 aspect
- **Three.js 项目**：`PerspectiveCamera(45, window.innerWidth/window.innerHeight, ...)` 当 canvas 尺寸 ≠ window 时变形

---

## 根因二：RTE viewMatrix 的 eye 不在原点

### 现象

地球偏移 + 非对称变形（一侧大一侧小的蛋形）。

### Float32 精度损失的数学推导

```
ECEF 坐标值量级：~26,000,000 m（地球半径 + altitude）

Float32 精度分析：
  Float32 尾数 = 23 bit → 有效数字 ≈ 2^23 = 8,388,608
  ULP(Unit in Last Place) = value / 2^23
  对 26,000,000：ULP = 26,000,000 / 8,388,608 ≈ 3.1 m

  也就是说 Float32 能表示的最小差值 ≈ 3.1m
  但 zoom=18 时像素对应的地面距离 ≈ 0.6m
  精度不足倍数 = 3.1 / 0.6 ≈ 5x ← 差 5 倍！

  具体影响：
  - 地球半径 6,378,137m 在 Float32 下 = 6,378,136 或 6,378,140（±3m 抖动）
  - X/Y/Z 三轴的精度损失不均匀（因为值不同）→ 非均匀缩放 → 蛋形

RTE 的解法：
  坐标减去相机位置后，值域从 ±26M 缩小到 ±几千米
  ULP = 5000 / 8,388,608 ≈ 0.0006m（亚毫米级）✅
```

### GeoForge 实际调试（第二轮，修改诊断代码后）

```
日志：
  viewRTE[12..14]: -0.6, 0.5, -26369352.0
  vpCol0Len: 1.97, vpCol1Len: 1.81, col0/col1: 1.09, expect(1/aspect): 0.77

分析：
  viewRTE[14] = -26,369,352 ≈ 地球半径 + altitude
  → lookAt 的 eye 传了绝对 ECEF 坐标，不是 [0,0,0]
  → viewMatrix 的平移分量包含巨大 Z 值

  vpCol0Len/vpCol1Len = 1.09 而非 1/aspect = 0.77
  → vpMatrix 的列向量比例被 Float32 精度损失扭曲

修复：
  错误：mat4_lookAt(viewRTE, cameraECEF, centerECEF, up)
  正确：mat4_lookAt(viewRTE, [0,0,0], vec3Sub(centerECEF, cameraECEF), up)
```

### 受影响的引擎/项目

- **cesium-native 社区论坛**（2025-05）：OpenGL + cesium-native，Ellipsoid 畸变+偏移，根因完全一致
- **cesium-unreal #6**：Unreal Float32 model-view → jitter+变形，解法：`SetNewWorldOrigin()` 动态 rebasing
- **cesium-unity #20**：Unity 无 Float64 → 手动 dynamic rebasing
- **GeoForge**（Session 6 第二轮诊断）：`viewRTE[14] = -26369352` 确认

---

## 根因三：其他模块的矩阵覆盖了 Globe 的矩阵

### 现象

Globe 构建了正确的 vpMatrix，但 GPU 收到了完全不同的矩阵。典型表征：projMatrix[0] 和 [5] 是**负数**。

### GeoForge 实际调试（第一轮，初始诊断）

```
日志：
  vpMat[0]: -1.670  期望 +1.865
  vpMat[5]: -1.386  期望 +2.414
  ratio:     1.205  期望 0.773

分析：
  标准透视 [0] 和 [5] 必须为正 → 负值证明这不是 Globe 的投影
  ratio = 1.205 = aspect → 宽高比反了（应为 1/aspect）

  可能的覆盖来源：
  Camera3D 的 perspectiveReversedZInfinite 矩阵。
  注意：Reversed-Z 本身不改变 [0][5] 的符号——它只改变 [10][14]。
  负号可能来自引擎的坐标系约定（Y-up vs Z-up 翻转）或裁剪空间映射差异。

  关键证据：uniform[0..3] 的值与 Globe 自己计算的 vpMatrix 不匹配
  → 在 writeBuffer 和 GPU 使用之间，有其他代码覆盖了 uniform buffer

修复：
  Globe 模式必须使用独立的 camera uniform buffer
  或在 Globe 渲染 pass 的 writeBuffer 之后不再允许其他模块写入
```

### 受影响的场景

- 2D/2.5D/3D 多模式引擎共享同一个 camera uniform buffer
- 引擎框架的"全局 camera update"在 Globe 渲染后再次执行

---

## 根因四：Canvas 配置尺寸与 GPU 渲染尺寸不匹配

### 现象

地球偏移（不在屏幕中心），可能伴随轻微变形。

```
场景 A：WebGPU context 未正确 configure
  canvas.width = 1600, canvas.height = 1200
  但 context.configure() 没有设 size → 默认 300×150

场景 B：viewport/scissor 设置错误
  passEncoder.setViewport(0, 0, wrongWidth, wrongHeight, 0, 1)

场景 C：忘了乘 devicePixelRatio
  canvas.width = canvas.clientWidth（应该 × DPR）
  → 渲染模糊，但 aspect 仍正确（因为 CSS 和物理的宽高比通常相同）
```

---

## 根因五：纯偏移问题（不变形但不在中心）

### 现象

地球形状完全正圆，但在屏幕上偏左/偏右/偏上/偏下。

```
可能原因：
  1. viewMatrix 的 RTE 平移 [12][13] ≠ 0（根因二的轻微版本）
  2. canvas 有 CSS padding/margin/border → 渲染区域偏移
  3. setViewport 的 x/y 偏移不为 0
  4. 多个 canvas 叠加时 z-index 或 position 错误
  5. projMatrix 包含了非对称裁剪（oblique near plane）

排查：打印 viewRTE[12]、viewRTE[13]，如果都接近 0 → 不是矩阵问题，检查 CSS 布局。
```

---

## 根因六：非 WGS84 椭球体参数不一致

### CesiumJS #4244 — 月球椭球体影像投影错误

**现象**：月球椭球体时球体大小正确，但影像按 WGS84 映射 → 纹理拉伸/压缩导致视觉"形状不对"。

### cesium-native — 椭球体参数传播不完整

**现象**：非 WGS84 椭球体的高程查询返回错误值 → 地形与球体不匹配 → 瓦片"鼓起"或"凹陷"。

### CesiumJS #11656 / #10245 — 椭球体内半径缩放错误

**现象**：半透明地球的内壁形状畸变（仅影响半透明模式）。

---

## 根因七：fov 单位错误（度 vs 弧度）

### 现象

地球极度放大（fov 太小，如 0.785 弧度被当作 0.785 度）或极度缩小（45 度被当作 45 弧度）。不是椭圆但大小完全错误。

```
正确：fov = 45° = 0.7854 弧度 = π/4
  f = 1/tan(0.7854/2) = 2.414

错误 A：fov 传了度数但函数期望弧度
  f = 1/tan(45/2) = 1/tan(22.5) = 1/0.414 = 2.414 ← 巧合结果相同（因为 tan(22.5°) ≈ 0.414）
  实际上 tan(22.5 radians) = tan(1289°) ≈ -3.38 → f ≈ -0.296 → 地球翻转+缩小

错误 B：fov 传了半角而非全角
  fov = 22.5° → f = 1/tan(11.25°) = 5.03 → 地球在屏幕上非常小

排查：打印 f = 1/tan(fov/2)。正确值对 45° fov 应 ≈ 2.414。
```

---

## 排查流程（给 Cursor 的 5 步诊断）

```javascript
// 在 Globe 渲染帧中插入以下代码（只执行一次即可）

// ═══ Step 1：投影矩阵 ═══
const f = 1 / Math.tan(fov / 2);
const expectP0 = f / aspect;
console.log(`[EggDiag] projMatrix[0]:${projMatrix[0].toFixed(4)} expect:${expectP0.toFixed(4)}`);
console.log(`[EggDiag] projMatrix[5]:${projMatrix[5].toFixed(4)} expect:${f.toFixed(4)}`);
console.log(`[EggDiag] ratio:${(projMatrix[0]/projMatrix[5]).toFixed(4)} expect:${(1/aspect).toFixed(4)}`);
// ❌ ratio ≠ 1/aspect → 根因一
// ❌ 值为负数 → 根因三
// ❌ f ≠ 2.414（对45° fov）→ 根因七

// ═══ Step 2：viewMatrix RTE 平移 ═══
console.log(`[EggDiag] viewRTE[12..14]:${viewMatrix[12].toFixed(1)},${viewMatrix[13].toFixed(1)},${viewMatrix[14].toFixed(1)}`);
// ✅ 全部接近 0 → RTE 正确
// ❌ |[14]| > 100000 → 根因二

// ═══ Step 3：vpMatrix 列向量长度比 ═══
const c0 = Math.hypot(vpMatrix[0], vpMatrix[1], vpMatrix[2], vpMatrix[3]);
const c1 = Math.hypot(vpMatrix[4], vpMatrix[5], vpMatrix[6], vpMatrix[7]);
console.log(`[EggDiag] vpCol0:${c0.toFixed(4)} vpCol1:${c1.toFixed(4)} ratio:${(c0/c1).toFixed(4)} expect:${(1/aspect).toFixed(4)}`);
// 注意：vpMatrix = proj × view，列向量长度不是 1
// 但 col0/col1 的比值应 ≈ 1/aspect（因为 proj 的 X/Y 缩放比就是 1/aspect）
// ❌ col0/col1 ≠ 1/aspect → 矩阵链中有错误

// ═══ Step 4：GPU 实际数据 ═══
// 在 device.queue.writeBuffer(cameraUBO, ..., data) 处打印
console.log(`[EggDiag] uploaded[0..3]:${data[0].toFixed(4)},${data[1].toFixed(4)},${data[2].toFixed(4)},${data[3].toFixed(4)}`);
// 与 Step 1 的 vpMatrix[0..3] 对比
// ❌ 不一致 → 根因三（被其他模块覆盖）

// ═══ Step 5：Canvas 尺寸 ═══
console.log(`[EggDiag] CSS:${canvas.clientWidth}×${canvas.clientHeight} Phys:${canvas.width}×${canvas.height} Surf:${context.getCurrentTexture().width}×${context.getCurrentTexture().height}`);
// ✅ Phys = CSS × DPR, Surf = Phys
// ❌ 不一致 → 根因四
```

---

## GeoForge 调试时间线

```
Session 6 调试轨迹（两轮诊断定位根因）：

第一轮（初始诊断）：
  截图：地球无纹理 + 偏移 + 变形（蛋形）
  日志：vpMat[0]:-1.67 vpMat[5]:-1.39 (负值！)
  结论：GPU 收到的不是 Globe 自己的 vpMatrix → 根因三

第二轮（修改诊断代码后）：
  日志：vpCol0Len:1.97 vpCol1Len:1.81 col0/col1:1.09 expect:0.77
         viewRTE[12..14]:-0.6, 0.5, -26369352.0
  结论：viewRTE[14] = -26M → lookAt eye 传了绝对 ECEF → 根因二
  修复：mat4_lookAt([0,0,0], vec3Sub(centerECEF, cameraECEF), up)

根因确认：根因二（RTE eye）+ 根因三（矩阵覆盖）叠加。
两个 bug 同时存在时症状互相叠加，需要分别修复。
```

---

## 与 GeoForge 文档的对接

| 根因 | 解决方案出处 | 具体位置 |
|------|------------|---------|
| 一：aspect 错误 | Globe Pipeline v2 | `§二 computeCamera3D` → `aspect = vp.width/vp.height` |
| 二：RTE eye | Globe Pipeline v2 | `§二` → `mat4_lookAt([0,0,0], targetRTE, up)` |
| 三：矩阵覆盖 | Cursor Rules | Globe 模式 uniform buffer 独立于 2.5D Camera |
| 四：Canvas 尺寸 | 2.5D Pipeline | `§一 viewport` → `canvas.width = clientWidth * DPR` |
| 五：纯偏移 | 2.5D Pipeline | `§一` → viewport/CSS 布局检查 |
| 六：非 WGS84 | Globe Pipeline v2 | `§一 WGS84 常量对象` → 参数化椭球体 |
| 七：fov 单位 | Globe Pipeline v2 | `§二` → `fov` 参数注释标注单位为弧度 |

### 与其他 Issue 汇编的交叉引用

| 本文根因 | 相关文档 | 关联 |
|---------|---------|------|
| 二：Float32 精度 | **Globe Shape Issues v2 §五** | CesiumJS #12879 Intel Arc jitter / GPU 双精度 EncodedCartesian3 |
| 三：矩阵覆盖 | **Globe Shape Issues v2 §七** | CesiumJS #12815 ECEF 模型在 2D 模式下位置错误 |
| 六：非 WGS84 | **Globe Shape Issues v2 §一** | CesiumJS #4244 月球椭球体 / cesium-native 参数传播 |
| 排查流程 | **Globe Pipeline v2 §八** | 排查清单的 10 项检查（本文 5 步是其子集+快速版） |
