# 中键拖拽地球问题：诊断 + 跨引擎 Issue 汇总

> 来源：CesiumJS、Mapbox GL JS、MapLibre GL JS、iTowns、Three.js 的 GitHub Issues / PRs
> 包含：GeoForge 当前 bug 的根因诊断 + 各引擎 orbit 相关问题的完整梳理

---

## 一、GeoForge 当前问题诊断

### 1.1 现象

鼠标在右下角按中键拖拽 → 地球往左上方移动。CesiumJS 同样操作 → 地球不动，相机原地绕 pivot 旋转。

### 1.2 根因

`handleRotate(bearingDelta, pitchDelta)` 做的是：**相机位置不变，只改变朝向（视线方向）**。

```
GeoForge 旧实现（相机原地扭头）：

  拖拽前：  ●（相机）──────→ 看向地球中心     地球在屏幕中央
  拖拽后：  ●（相机）────→ 视线偏左上方       地球在屏幕上滑走了
```

视线偏了，地球的投影位置自然跟着变——所以地球往反方向「跑」。

### 1.3 正确做法（CesiumJS / 已实现）

CesiumJS 中键 = `tilt`（`CameraEventType.MIDDLE_DRAG`），对应 `tilt3D` / `tilt3DOnTerrain`。

**相机物理移动到新位置，但始终看向地球上同一个 pivot 点**。

```
Pivot Orbit（相机绕 pivot 轨道运动）：

  拖拽前：  ●（相机）
            │╲
            │ ╲  看向 pivot
            │  ◆ pivot（地球表面固定点）

  拖拽后：      ●（相机移到新位置）
               ╱
              ╱  仍然看向 pivot
            ◆ pivot 不动                地球在屏幕上也不动
```

CesiumJS 源码关键 API：

- **mouseDown**：`pickGlobe(startPosition)` → `_tiltCenter`（ECEF pivot）
- **mouseMove**：`camera.rotateUp(angle)` / `camera.rotateRight(angle)` — 改变的是**相机位置**，不是朝向；相机始终看向 transform 中心

### 1.4 GeoForge 已实现的修复

`globe-interaction.ts` 中的 `applyCameraOrbit` 函数已替换旧的 `handleRotate`：

```
mouseDown（中键）：
  pickGlobeECEF → pivot ECEF → computeENUBasis（缓存 9 float）
  → cam-pivot 向量在 ENU 中投影 → 初始 bearing/pitch
  → orbitDistance = max(|cam - pivot|, 100)

mouseMove（中键，每帧）：
  movementX/Y → 帧间增量累加到 bearing/pitch
  → pitch clamp [ORBIT_PITCH_MIN, ORBIT_PITCH_MAX]
  → pivot + ENU + bearing/pitch/distance → 新相机 ECEF
  → Bowring 2 次迭代 → 经纬高
  → setPosition + setOrientation 原子更新

未命中球面：
  → 回退到 handleRotate（屏幕空间旋转）
```

### 1.5 各引擎中键行为对比

| 引擎 | 中键行为 | 旋转中心 | 地球是否移动 |
|------|---------|---------|-------------|
| **CesiumJS** | tilt（轨道旋转） | mouseDown pick 的表面点 | **不移动** |
| **Google Earth** | orbit（轨道旋转） | 鼠标位置射线求交点 | **不移动** |
| **iTowns** | GlobeControls orbit | spherical 坐标系中心 | **不移动** |
| **Three.js OrbitControls** | orbit | controls.target | **不移动** |
| **Mapbox GL JS** | dragRotate | map center（屏幕中心） | **不移动** |
| **GeoForge（已修复）** | applyCameraOrbit | mouseDown pick 的表面点 | **不移动** ✓ |

---

## 二、跨引擎 Issue 汇总：7 类根因

| # | 根因 | 严重度 | 典型表现 | Issue |
|---|------|--------|---------|-------|
| 1 | 旋转顺序错误（H 先于 V） | 致命 | 对角拖拽时相机剧烈跳变 | CesiumJS PR #9562 |
| 2 | Pivot 拖拽中漂移（每帧重新 pick） | 高 | 旋转中心偏移 + 状态卡死 | CesiumJS #12560 |
| 3 | 零向量归一化崩溃 | 致命 | 渲染停止，NaN 传播 | CesiumJS #6783, #7094, PR #3605 |
| 4 | Orbit 中心固定在屏幕中心 | 中 | 无法围绕光标下的点旋转 | Mapbox #13440 |
| 5 | 灵敏度不适配 | 中 | 近处转飞 / 远处拖不动 | Three.js #9577, iTowns #545 |
| 6 | 极地万向锁 | 中 | 拖过极点后 heading 突变 180° | CesiumJS 社区帖, #9689 |
| 7 | 中断后 roll 累积 | 低 | 交互中断恢复后地平线倾斜 | MapLibre #5083, #5104 |

### 根因 1：旋转顺序错误

**CesiumJS PR #9562**（已合并 2021-06）
https://github.com/CesiumGS/cesium/pull/9562

`tilt3DOnTerrain` 先水平旋转（绕 `center`），再垂直旋转（绕 `verticalCenter`）。水平旋转改变了相机位置，导致 `verticalCenter` 过时：

```
错误顺序：
  setTransform(center)           ← center 固定
  rotate3D(水平)                  ← 相机位置变了
  setTransform(verticalCenter)   ← 没更新，用的旧值
  rotate3D(垂直)                  ← 误差累积 → 跳变

修复顺序：
  setTransform(verticalCenter)   ← 先用当前帧的 verticalCenter
  rotate3D(垂直)                  ← pivot 是自己，不变
  setTransform(center)           ← center 整个拖拽期间不变
  rotate3D(水平)                  ← 安全
```

关键洞见：**先做「会失效的」旋转，再做「不变的」旋转**，避免交叉污染。

### 根因 2：Pivot 拖拽中漂移

**CesiumJS #12560**（Open 2025-04）
https://github.com/CesiumGS/cesium/issues/12560

拖拽中每帧重新 `pickGlobe` 更新 tilt center。鼠标移出地球时 pick 返回 null，状态机切到 `tilt3DOnEllipsoid` → `rotate3D`，切换不干净导致：

1. 旋转中心偏移——不再是按下时的点
2. 大幅移出后旋转卡死
3. 松开后进入 "Look 3D" 模式，无法恢复正常操作

### 根因 3：零向量归一化崩溃

**CesiumJS #6783**（已修复 2018-07）/ **#7094**（已修复 2018-09）/ **PR #3605**（已合并 2016-04）

相机到达 pivot 附近（ECEF 距离 ≈ 0）→ 方向向量长度为零 → `Cartesian3.normalize` 产生 NaN → 传播到矩阵 → 渲染崩溃：

```
DeveloperError: normalized result is not a number
  at Cartesian3.normalize → rotateVertical → Camera.rotateUp → tilt3DOnEllipsoid
```

PR #3605 是 CesiumJS 历史上最重要的防御性改动之一——对所有 `normalize` 加 NaN 检查，额外暴露了 ShadowMap、PolylineVolumeGeometry 等多个隐藏的零向量 bug。

### 根因 4：Orbit 中心固定在屏幕中心

**Mapbox GL JS #13440**（Open 2025-04）
https://github.com/mapbox/mapbox-gl-js/issues/13440

Mapbox orbit 中心是 map center，不是鼠标按下位置。用户要检查建筑必须先移到屏幕中心。Issue 作者要求 Google Earth 风格——mouseDown 时射线求交，渲染 3D 光标指示旋转中心。

### 根因 5：灵敏度不适配

**Three.js OrbitControls #9577**（Open 2016-08）
https://github.com/mrdoob/three.js/issues/9577

`rotateSpeed` 常量不随距离变化，`dampingFactor` 和 `rotateSpeed` 互相耦合。拖鼠标稍快就绕场景转 5000 圈。

**iTowns GlobeControls #545**（长期讨论 2017-01）
https://github.com/iTowns/itowns/issues/545

2000 行意大利面代码，zoom / orbit / pan 状态互相干扰，灵敏度不一致。经多轮重构（#795 等）才基本稳定。

### 根因 6：极地万向锁

**CesiumJS 社区帖**（2018-09）
https://community.cesium.com/t/earth-model-gimbal-lock-loss-of-dof-over-the-poles/7417

**CesiumJS #9689**（Open 2021-07）
https://github.com/CesiumGS/cesium/issues/9689

相机通过极点时 ENU 的 North 向量退化（极点处 North 无定义），heading 从 0° 突变到 180°，地球开始不可控旋转。CesiumJS 用 `constrainedAxis = UNIT_Z` 防止拖过极点，但 tilt 操作仍可越过极点触发。

### 根因 7：中断后 roll 累积

**MapLibre GL JS #5083**（已合并 2025-01）
https://github.com/maplibre/maplibre-gl-js/issues/5083

拖拽旋转中途被中断（弹窗、焦点切换），恢复后多出 roll 分量，地平线倾斜。中断时 bearing/pitch 增量状态未清零，残留 delta 被误解为 roll。

**MapLibre GL JS #5104**（已合并 2025-01）
https://github.com/maplibre/maplibre-gl-js/issues/5104

鼠标在屏幕中心附近开始拖拽旋转时 bearing 变化率极大——`atan2(dy, dx)` 在原点附近不稳定。修复：中心附近添加死区。

---

## 三、补充 Issue

| Issue | 引擎 | 状态 | 要点 |
|-------|------|------|------|
| #12137 | CesiumJS | Open | 地面附近旋转卡死：负高度 → 数学异常 |
| #7232 | CesiumJS | 讨论中 | 拖到地平线时 spin→pivot 模式突变 |
| #1855 | CesiumJS | 已修复 | mouseUp 未注册：鼠标拖出 iframe 松手后状态卡住 |
| #11353 | Mapbox | Open | Globe 视图拖拽时意外缩放：orbit distance 未锁定 |
| #5473 | MapLibre | Open | Globe 投影下 drag marker 经度偏移 ±360° |
| #6032 | CesiumJS | 讨论中 | `camera.setView` 在特定角度失效：direction 接近 UNIT_Y 时 pitch 翻转 |

---

## 四、防御检查表（全部 ✓ 已实现）

| # | 防御点 | 来源 | 状态 | 实现位置 |
|---|--------|------|------|---------|
| 1 | Pivot mouseDown 锁定，拖拽中不重新 pick | #12560 | ✓ | `onMouseDown` 中 `pickGlobeECEF` 一次，`onMouseMove` 不调 |
| 2 | Bearing/Pitch 一次性应用（不分两步旋转） | PR #9562 | ✓ | `applyCameraOrbit` 在 ENU 空间单步算 ECEF 位置 |
| 3 | orbitDistance ≥ 100m | #6783, #7094 | ✓ | `globe-interaction.ts` `Math.max(sqrt(...), 100)` |
| 4 | mouseUp 监听 window 而非 canvas | #1855 | ✓ | `globe-3d.ts` `window.addEventListener('mouseup')` |
| 5 | 拖拽期间不切换交互模式 | #7232 | ✓ | mouseDown 确定 orbit/fallback 后锁定 |
| 6 | Orbit distance 拖拽中不变 | #11353 | ✓ | `orbitDistance` 在 mouseDown 锁定，mouseMove 不修改 |
| 7 | ENU 基向量 mouseDown 缓存 | #12560 | ✓ | `computeENUBasis` 只在 mouseDown 调一次，写入 `_orbitENUBuf` |
| 8 | 极地 pitch clamp | #9689 | ✓ | `ORBIT_PITCH_MIN = -0.49π`（≈-88.2°），`ORBIT_PITCH_MAX = -0.0175`（≈-1°） |
| 9 | camAlt 下限 | #12137 | ✓ | `applyCameraOrbit` 末尾 `Math.max(camAlt, 100)` |
| 10 | Bowring ECEF→LLH（不用球面近似） | — | ✓ | `applyCameraOrbit` 中 2 次 Bowring 迭代，精度 < 1m |
| 11 | cam≈pivot 退化：`atan2(0,0)` 防护 | #6783, #5104 | ✓ | `ORBIT_CAM_PIVOT_DEGENERATE_DIST_SQ_M2` 下用 `getOrientation` 种子；否则 `horizSafe=max(horizDist,1e-15)` |
| 12 | `setPosition`/`setOrientation` 前 `Number.isFinite` | PR #3605 | ✓ | `applyCameraOrbit` 内非有限则 `return` |
| 13 | 失焦/隐藏页签时结束拖拽 | #1855, #5083 | ✓ | `globe-3d.ts` `window blur` + `document visibilitychange` → 合成 `mouseup` |

所有防御点均在 `globe-interaction.ts`、`globe-constants.ts` 和 `globe-3d.ts` 中实现。
