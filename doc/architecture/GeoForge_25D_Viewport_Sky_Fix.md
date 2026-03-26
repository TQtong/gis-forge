# GIS-Forge 2.5D 视口填充完整修复方案

> **问题**：pitch 倾斜后地图没铺满视口，上方大片黑色。
> 本文档覆盖从 clearColor 到大气散射的 7 层修复 + 瓦片 LOD + Z 精度 + 各向异性过滤。

---

## 一、问题分解（6 层叠加）

从截图（pitch≈45°, zoom≈3.3）精确诊断：

| 层 | 问题 | 现象 | 严重度 |
|----|------|------|--------|
| 1 | clearColor 为黑色 | 地平线以上区域刺眼纯黑 | 🔴 |
| 2 | 远裁面固定不够远 | 地面几何在远端被裁掉，没延伸到地平线 | 🔴 |
| 3 | 瓦片覆盖不足 | TileScheduler 没有加载视锥远端的瓦片 | 🔴 |
| 4 | 地平线以上无渲染 | pitch>70°时地平线在视口内，上方是 clearColor | 🟡 |
| 5 | 远处瓦片质量差 | Z-fighting / 纹理模糊 / 分辨率不足 | 🟡 |
| 6 | 地面→天空无过渡 | 硬边缘，不自然 | 🟡 |

---

## 二、各引擎方案汇总

| 引擎 | 远裁面 | 天空 | 雾 | 瓦片 LOD | Z 精度 | 各向异性 |
|------|--------|------|-----|---------|--------|---------|
| **MapLibre** | 动态 `farZ = f(pitch, fov, altitude)` | sky spec（sky-color/horizon-color/fog-color + 3 个 blend 参数）| fog-ground-blend 混合远处瓦片 | `setSourceTileLodParams(maxZoomLevels, ratio)` | 标准 Z buffer | `anisotropicFilteringPitch > 20°` |
| **Mapbox** | 同 MapLibre | SkyLayer（gradient / atmosphere 两种 sky-type）| Fog API（range + color + horizon-blend）| 内置 LOD 衰减 | 标准 Z | 自动 |
| **CesiumJS** | 根据相机高度自适应 | SkyBox(CubeMap) + SkyAtmosphere(预计算大气散射 LUT) | scene.fog（密度随高度自适应）| 内置 SSE 控制 | 对数深度 | 自动 |
| **deck.gl** | `MapView({ farZMultiplier })` | 无内置 | 无内置 | 无内置 | 标准 Z | 无 |
| **harp.gl** | `maxVisibilityRange` 动态计算 | 大气散射 shader（简化 Preetham）| 距离雾 | 内置 LOD | 对数深度 | 自动 |
| **iTowns** | 根据 SSE + pitch 自适应 | 天空盒 / 大气 | 距离雾 | 自适应 LOD | 对数深度 | 自动 |

**关键 Issues**：
- MapLibre [#4036](https://github.com/maplibre/maplibre-gl-js/issues/4036)：clearColor 设为黑色导致导出图片 horizon 为黑色 → 方案：暴露 clearColor 配置
- MapLibre [#4340](https://github.com/maplibre/maplibre-gl-js/issues/4340)：drawSky 在 style 加载前崩溃 → 方案：防御性检查 `if (this.style?.sky)`
- MapLibre [#5230](https://github.com/maplibre/maplibre-gl-js/issues/5230)：Globe 模式 sky 不工作 → 方案：sky 在 globe 和 mercator 分别处理
- MapLibre `setSourceTileLodParams`：pitch 大时远处瓦片用更低 zoom → 减少请求量同时保证覆盖
- MapLibre `anisotropicFilteringPitch`：pitch > 20° 启用各向异性过滤 → 远处瓦片纹理更清晰

---

## 三、完整修复方案（7 层）

### 层 1：clearColor 配置

**最快见效**——改一行代码消除纯黑背景。

```typescript
/** 新增到 L2/RenderGraph 或 L6/Preset25D 的配置 */
export interface ClearColorConfig {
  /** 帧缓冲清除颜色（地平线以上的 fallback 背景色）
   *  深色主题: [0.10, 0.10, 0.18, 1.0]  (#1a1a2e)
   *  浅色主题: [0.94, 0.95, 0.96, 1.0]  (#f0f2f5)
   *  当 sky 启用后此值被 sky 渲染覆盖 */
  clearColor: [number, number, number, number];
}

// RenderGraph.beginFrame():
// 当前: clearValue: { r:0, g:0, b:0, a:1 }       ← 纯黑
// 修改: clearValue: config.clearColor               ← 主题色
```

### 层 2：动态远裁面（地面延伸到地平线）

```typescript
/**
 * Camera25D._computeFarPlane()
 *
 * 核心几何：相机在 center 正上方 h 处，视线 pitch 角倾斜。
 * 视锥上边缘射线仰角 = pitch + fov/2。
 * 当此角 < 90° 时射线与地面相交 → far = 交点距离 × 安全余量。
 * 当此角 ≥ 90° 时射线指向天空 → far 取最大可见地面范围。
 *
 * 同时考虑近裁面比值约束（far/near 不能太大，否则 Z 精度下降）。
 * GIS-Forge 使用 Reversed-Z，far/near 比值容忍度远高于标准 Z（可达 10^6）。
 */
_computeFarPlane(): number {
  const halfFov = this._fov / 2;
  const cameraToCenterDist = this._viewport.height / 2 / Math.tan(halfFov);

  // pitch = 0：俯视，far 只需 1.5 倍 center 距离
  if (this._pitch < 0.01) {
    return cameraToCenterDist * 1.5;
  }

  // 视锥上边缘射线与地面交点距离
  const topRayAngle = this._pitch + halfFov;
  const cameraHeight = cameraToCenterDist * Math.cos(this._pitch);

  if (topRayAngle < Math.PI / 2 - 0.01) {
    // 射线与地面相交
    const groundDist = cameraHeight / Math.cos(topRayAngle);
    // 安全余量 1.5x + 不小于基础距离 2x
    return Math.max(groundDist * 1.5, cameraToCenterDist * 2.0);
  }

  // 射线接近水平或指向天空 → far 需要非常大
  // 使用 pitch 因子：pitch 越大 far 越大（上限 100x 防止 Z 精度完全崩溃）
  // Reversed-Z 下即使 far/near = 100000 精度也可接受
  const pitchNormalized = this._pitch / (Math.PI / 2); // 0~1
  const farMultiplier = 2.0 + pitchNormalized * 98.0;   // 2x ~ 100x
  return cameraToCenterDist * Math.min(farMultiplier, 100.0);
}

/**
 * 近裁面也要适配——far 扩大后需要确保 near 足够小。
 * Reversed-Z 下 near 对应 depth=1（最近），far 对应 depth=0（最远）。
 * near 应保持足够小以不裁掉近处地面，但不能太小以免浮点下溢。
 */
_computeNearPlane(): number {
  const cameraToCenterDist = this._viewport.height / 2 / Math.tan(this._fov / 2);
  // near = center 距离的 1% 或 10 像素等效距离，取较大者
  return Math.max(cameraToCenterDist * 0.01, 10.0);
}

/**
 * 投影矩阵重建（Reversed-Z）：
 */
_rebuildProjectionMatrix(): void {
  const near = this._computeNearPlane();
  const far  = this._computeFarPlane();
  const aspect = this._viewport.width / this._viewport.height;
  // Reversed-Z: near 和 far 交换（near > far），depth 范围 [1, 0]
  mat4.perspectiveReversedZ(this._projMatrix, this._fov, aspect, near, far);
}
```

### 层 3：瓦片覆盖扩展（TileScheduler 适配高 pitch）

```typescript
/**
 * TileScheduler 在高 pitch 时需要加载视锥远端的瓦片。
 *
 * 问题：当前 coveringTiles() 只计算屏幕四角 unproject 到地面的 BBox，
 * 但高 pitch 时上方射线不与地面相交 → BBox 不包含地平线附近的瓦片。
 *
 * MapLibre 解决方案（3 个维度）：
 *   1. coveringTiles 扩展地面范围到地平线
 *   2. setSourceTileLodParams 控制远处瓦片使用更低 zoom
 *   3. 远处瓦片数量限制（tileCountMaxMinRatio）
 */

export interface TileLodConfig {
  /**
   * 屏幕上允许的最大不同 zoom 级别数。
   * pitch=0 时只有 1 个 zoom；pitch 很大时远处瓦片用低很多的 zoom。
   * @range [1, 8]
   * @default 4
   */
  maxZoomLevelsOnScreen: number;

  /**
   * 高 pitch 时最大瓦片数与最小瓦片数的比值。
   * 越大 → pitch 倾斜时加载越多瓦片 → 覆盖越完整但越慢。
   * @range [1, 10]
   * @default 3
   */
  tileCountMaxMinRatio: number;
}

/**
 * coveringTiles 扩展算法：
 *
 *   1. 计算屏幕四角 unproject 到地面的坐标
 *   2. 如果上方两角的射线不与地面相交（pitch 大导致射线水平）：
 *      → 用地平线处的经纬度代替（沿射线方向取最大可见距离处的坐标）
 *      → 实际做法：取 far plane 与地面交点作为最远边界
 *   3. 扩展后的 BBox 用于计算需要加载的瓦片列表
 *   4. 远离 center 的瓦片使用更低的 zoom 级别：
 *      - center 处：使用正常 zoom（如 z=10）
 *      - 中距离：zoom - 1（z=9）
 *      - 远距离：zoom - 2（z=8）
 *      - 地平线附近：zoom - maxZoomLevelsOnScreen + 1（z=7）
 *      zoom 衰减曲线：zoomAtDistance = centerZoom - log2(distance / centerDistance)
 *
 *   5. 总瓦片数限制：
 *      baseTileCount = 正常视口下的瓦片数（pitch=0）
 *      maxTileCount = baseTileCount × tileCountMaxMinRatio
 *      如果瓦片列表超过 maxTileCount → 从最远处开始剔除
 *
 * 对接：L3/TileScheduler.update() 中修改 coveringTiles 逻辑。
 */
```

### 层 4：天空渲染（地平线以上填充）

```typescript
/**
 * SkyRenderer — 全屏渐变天空。
 * 在 RenderGraph 中作为第一个 Pass 执行（深度写入关闭，所有地图层覆盖在其上）。
 */
export interface SkyConfig {
  /** 是否启用天空渲染 @default true（2.5D 模式自动启用） */
  enabled: boolean;
  /** 天空颜色（视口最顶部）*/
  skyColor: string;
  /** 地平线颜色（天空与地面的过渡带）*/
  horizonColor: string;
  /** 雾颜色（远处地面覆盖的颜色）*/
  fogColor: string;
  /** 天空→地平线渐变宽度（0=硬边, 1=全屏渐变）@range [0, 1] @default 0.4 */
  skyHorizonBlend: number;
  /** 地平线→雾渐变宽度 @range [0, 1] @default 0.3 */
  horizonFogBlend: number;
  /** 雾→地面渐变宽度 @range [0, 1] @default 0.5 */
  fogGroundBlend: number;
}

// ═══ 主题配色预设 ═══
const SKY_PRESETS = {
  darkStandard:   { skyColor: '#0a0f1e', horizonColor: '#1a2a4a', fogColor: '#2a3a5a' },
  lightStandard:  { skyColor: '#87CEEB', horizonColor: '#B0C4DE', fogColor: '#D3D3D3' },
  satellite:      { skyColor: '#000510', horizonColor: '#0a1528', fogColor: '#152238' },
  twilight:       { skyColor: '#1a0a2e', horizonColor: '#4a2060', fogColor: '#6a3080' },
};
```

**WGSL Shader（sky.wgsl）**：

```wgsl
struct SkyUniforms {
  skyColor:        vec4<f32>,
  horizonColor:    vec4<f32>,
  fogColor:        vec4<f32>,
  horizonY:        f32,       // 地平线屏幕 Y（归一化 0~1，0=顶）
  skyHorizonBlend: f32,
  horizonFogBlend: f32,
  fogGroundBlend:  f32,
};

@group(0) @binding(0) var<uniform> sky: SkyUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// 全屏三角形（无顶点缓冲，3 个硬编码顶点覆盖整个屏幕）
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOutput {
  var out: VSOutput;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);   // Reversed-Z: depth=0 = 最远
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

@fragment fn fs(in: VSOutput) -> @location(0) vec4<f32> {
  let y = in.uv.y;  // 0=顶部, 1=底部
  let h = sky.horizonY;

  // 天空区域（地平线以上）
  if (y < h) {
    let skyStart = h - sky.skyHorizonBlend;
    let t = smoothstep(skyStart, h, y);         // 0=天空顶, 1=地平线
    return mix(sky.skyColor, sky.horizonColor, t);
  }

  // 过渡区域（地平线→雾）
  let fogStart = h + sky.horizonFogBlend;
  if (y < fogStart) {
    let t = smoothstep(h, fogStart, y);
    return mix(sky.horizonColor, sky.fogColor, t);
  }

  // 雾区域（远处地面会覆盖在此之上）
  let groundStart = fogStart + sky.fogGroundBlend;
  let t = smoothstep(fogStart, groundStart, y);
  return mix(sky.fogColor, vec4<f32>(0.0, 0.0, 0.0, 0.0), t); // 渐变到透明（被地图覆盖）
}
```

**地平线 Y 坐标计算**：

```typescript
/**
 * 精确计算地平线在屏幕上的归一化 Y 位置。
 * horizonY=0 表示地平线在视口顶部之上（不可见，全部是地面）。
 * horizonY=0.5 表示地平线在视口正中间。
 */
_computeHorizonY(): number {
  const halfFov = this._fov / 2;
  // 地平线方向与视线中心的夹角
  const horizonAngle = Math.PI / 2 - this._pitch;

  if (horizonAngle >= halfFov) return 0.0;       // 地平线在视口上方之外
  if (horizonAngle <= -halfFov) return 1.0;      // 全部是天空（pitch > 90°+fov/2）

  // 地平线在视口内：从中心偏移的比例
  return 0.5 - Math.tan(horizonAngle) / Math.tan(halfFov) * 0.5;
}
```

**SkyPass 深度策略**：

```
Reversed-Z 下 depth 范围 [1(近), 0(远)]。
Sky 全屏三角形的 depth = 0.0（最远端）。
Sky Pass 配置：
  depthWriteEnabled: false        ← 不写入深度（后续地图层会覆盖）
  depthCompare: 'always'          ← 始终通过（sky 作为背景）
  colorAttachment: loadOp='clear' ← sky pass 同时承担 clear 职责

执行顺序：
  Pass 0: SkyPass（clear + 渲染天空渐变）
  Pass 1~N: 地图图层（depthWrite=true, depthCompare='greater'，Reversed-Z）
  Pass N+1: 后处理
```

**sky 在 2D↔2.5D 切换时的淡入淡出**：

```
pitch 从 0 增长到 > 5° 时 sky 开始淡入（alpha 从 0 → 1）：
  skyAlpha = smoothstep(0°, 10°, pitch)
  SkyUniforms 中所有颜色乘以 skyAlpha

pitch = 0 时 sky 完全不渲染（纯 2D 不需要天空）。
ViewMorph 动画期间 pitch 平滑插值 → sky 自然淡入淡出。
```

### 层 5：Fog 淡出远处瓦片

```typescript
/**
 * FogConfig — 距离雾，注入到每个图层的 Fragment Shader。
 * 远处瓦片渐变为 fogColor → 与天空 horizonColor 无缝衔接。
 */
export interface FogConfig {
  /** 是否启用 @default true（2.5D 模式自动启用） */
  enabled: boolean;
  /** 雾颜色（必须与 SkyConfig.fogColor 一致！否则有色差接缝）*/
  fogColor: string;
  /** 雾开始距离（归一化深度 0~1）@default 0.5（视口深度 50% 处开始雾化）*/
  fogStart: number;
  /** 雾完全覆盖距离 @default 0.95 */
  fogEnd: number;
  /** 雾类型 @default 'exponential' */
  fogType: 'linear' | 'exponential' | 'exponential-squared';
  /** 指数雾密度（仅 exponential 和 exponential-squared 有效）@default 2.0 */
  fogDensity: number;
}
```

**Fog WGSL 片段（注入到各图层 fragment shader）**：

```wgsl
// 通过 ShaderAssembler Hook 注入（hook: fragment_color_after_lighting）

struct FogUniforms {
  fogColor:   vec4<f32>,
  fogStart:   f32,
  fogEnd:     f32,
  fogDensity: f32,
  fogType:    u32,     // 0=linear, 1=exp, 2=exp²
};

fn applyFog(color: vec4<f32>, rawDepth: f32, fog: FogUniforms) -> vec4<f32> {
  // Reversed-Z 深度线性化：
  //   Reversed-Z: depth=1 是近平面, depth=0 是远平面
  //   线性深度 = near * far / (far - rawDepth * (far - near))
  //   归一化到 [0, 1]（0=近, 1=远）：
  let linearDepth = 1.0 - rawDepth;  // Reversed-Z 简化：直接反转即为近似线性距离

  // 未进入雾区的不处理
  if (linearDepth < fog.fogStart) { return color; }

  var fogFactor: f32;
  let d = clamp((linearDepth - fog.fogStart) / (fog.fogEnd - fog.fogStart), 0.0, 1.0);

  switch (fog.fogType) {
    case 0u: { fogFactor = 1.0 - d; }                                        // linear
    case 1u: { fogFactor = exp(-fog.fogDensity * d); }                        // exponential
    default: { let dd = fog.fogDensity * d; fogFactor = exp(-dd * dd); }      // exponential²
  }

  return vec4<f32>(mix(fog.fogColor.rgb, color.rgb, fogFactor), color.a);
}
```

**Fog 密度随 zoom 自适应**：

```
高 zoom（zoom > 14）时 fog 几乎不可见（近处内容清晰，远处也是近距离瓦片）。
低 zoom（zoom < 5）时 fog 明显（远处跨越几千公里的瓦片需要淡出）。

fogDensity_effective = fogDensity × clamp(1.0 - (zoom - 5) / 10, 0.1, 1.0)
// zoom=5: density × 1.0（满雾）
// zoom=10: density × 0.5
// zoom=15+: density × 0.1（几乎无雾）
```

**Fog 与 Sky 颜色协调原则**：

```
关键约束：fog.fogColor === sky.fogColor === sky.horizonColor 附近色值。
否则地平线处会出现明显色带（天空一个颜色、雾化瓦片另一个颜色）。

实现：在 StyleEngine 中同步两者颜色：
  当用户设置 sky.horizonColor 时，自动将 fog.fogColor 设为相同值。
  或者暴露一个 horizonColor 统一配置两者。
```

### 层 6：远处瓦片质量优化

#### 6.1 各向异性纹理过滤

```typescript
/**
 * 当 pitch > 阈值时，远处栅格瓦片在屏幕上被极度压扁（透视缩短）。
 * 标准双线性过滤会导致远处纹理严重模糊。
 * 各向异性过滤可以沿压扁方向保持清晰度。
 *
 * MapLibre 的 anisotropicFilteringPitch 参数（默认 20°）。
 */
export interface AnisotropicFilterConfig {
  /** pitch 超过此角度时启用各向异性过滤 @default 20 @unit 度 */
  activationPitch: number;
  /** 最大各向异性等级 @range [1, 16] @default 16 */
  maxAnisotropy: number;
}

// 实现（L1/TextureManager 创建 Sampler 时）：
// WebGPU Sampler 配置：
//   if (pitch > config.activationPitch) {
//     sampler = device.createSampler({
//       minFilter: 'linear',
//       magFilter: 'linear',
//       mipmapFilter: 'linear',
//       maxAnisotropy: config.maxAnisotropy,   // ← 关键
//     });
//   }
```

#### 6.2 Z-Fighting 防护（Reversed-Z 验证）

```
GIS-Forge 已采用 Reversed-Z，这是核心优势：

标准 Z-Buffer（depth=[0,1], near=0, far=1）：
  远处精度 ≈ 1 / (2^24 × near/far)
  当 far/near = 10000 时，远处 90% 的 Z 范围被挤到 [0.999, 1.0]
  → 远处 Z-fighting 严重

Reversed-Z（depth=[1,0], near→depth=1, far→depth=0）：
  远处精度 ≈ near / (far × 2^24)
  由于浮点在 0 附近精度最高，远处精度大幅提升
  当 far/near = 100000 时仍可接受（标准 Z 在 far/near = 1000 时就崩了）

验证：GIS-Forge 的 DepthManager 已实现 Reversed-Z。
  _computeFarPlane 扩大 far 后，Z 精度仍然足够。
  如果在极端 pitch（>80°, far/near > 50000）下出现 Z-fighting：
    → 启用对数深度写入（logarithmic depth buffer）作为 fallback
    → fragment shader: gl_FragDepth = log2(linearZ) / log2(far)
```

#### 6.3 远处瓦片 LOD 衰减

```typescript
/**
 * TileScheduler 在计算远处瓦片 zoom 时应用 LOD 衰减。
 *
 * 核心思路：距离 center 越远的瓦片，用越低的 zoom 级别。
 * 原因：(1) 远处瓦片在屏幕上只有几个像素，高分辨率浪费 (2) 减少请求量 (3) 减少 GPU 内存
 *
 * MapLibre 的 setSourceTileLodParams(maxZoomLevelsOnScreen, tileCountMaxMinRatio) 就是这个。
 */

/**
 * 算法：
 *   1. 对视锥内每个瓦片格子，计算其屏幕空间的 SSE（Screen Space Error）
 *   2. 如果 SSE < threshold → 降低一级 zoom（用父瓦片覆盖）
 *   3. 最多降低 maxZoomLevelsOnScreen - 1 级
 *   4. 远处瓦片的 zoom 衰减曲线：
 *      zoomAtTile = centerZoom - floor(log2(distTile / distCenter))
 *      zoomAtTile = clamp(zoomAtTile, centerZoom - maxZoomLevelsOnScreen + 1, centerZoom)
 *
 * 示例（centerZoom=10, maxZoomLevelsOnScreen=4）：
 *   center 处: z=10（正常分辨率）
 *   2x 距离:   z=9
 *   4x 距离:   z=8
 *   8x 距离:   z=7（最低，再远也不降）
 *   16x+ 距离: z=7（但可能被 fog 完全覆盖，看不到了）
 *
 * 效果：
 *   pitch=0: 全部同 zoom → LOD 无效果
 *   pitch=60°: 远处用 z-3 的瓦片 → 请求量减少 ~70%，视觉差异被 fog 遮盖
 */
```

### 层 7：World Copies + 边界处理

```typescript
/**
 * 低 zoom + 高 pitch 时的 renderWorldCopies 问题：
 *
 *   zoom=3 时地图宽度 = 8 个瓦片（2048px）。
 *   如果视口宽度 1920px，可能看到将近一个完整世界。
 *   如果 renderWorldCopies=true → 世界两侧出现重复副本。
 *   高 pitch 时视锥远端更宽 → 可能看到更多重复。
 *
 * 处理方案：
 *   1. 如果 renderWorldCopies=true：
 *      coveringTiles 计算时允许瓦片 X 坐标超出 [0, 2^zoom) 范围
 *      渲染时 X 坐标 mod 2^zoom 映射回实际瓦片
 *      视觉上无缝重复
 *
 *   2. 如果 renderWorldCopies=false：
 *      coveringTiles 裁剪到 [0, 2^zoom) 范围
 *      超出范围的区域显示 clearColor（或 sky/fog）
 *      这是截图中左右两侧淡出的原因之一
 *
 *   3. 瓦片 Y 范围限制（墨卡托上下界）：
 *      Y 坐标不超出 [0, 2^zoom)（墨卡托只覆盖 ±85.051°）
 *      超出范围的格子不请求、不渲染
 */
```

---

## 四、对接关系与执行顺序

```
修改文件列表（按优先级排序）：

1. L2/RenderGraph.ts
   - clearValue 改为可配置的 clearColor                    ← 层 1（5 分钟）
   - 在 Pass 列表头部插入 SkyPass                          ← 层 4

2. camera-25d.ts
   - 新增 _computeFarPlane() 动态远裁面                    ← 层 2
   - 新增 _computeNearPlane()                              ← 层 2
   - 修改 _rebuildProjectionMatrix() 使用动态 near/far     ← 层 2
   - 新增 _computeHorizonY() 地平线屏幕位置                ← 层 4

3. 新增 sky-renderer.ts + sky.wgsl
   - SkyRenderer 类 + SkyConfig 接口                       ← 层 4
   - 全屏三角形 + 渐变 shader

4. L3/TileScheduler.ts
   - coveringTiles() 扩展到地平线                           ← 层 3
   - 远处瓦片 zoom 衰减（LOD）                             ← 层 6.3
   - tileCountMaxMinRatio 限制总瓦片数                     ← 层 3

5. L2/ShaderAssembler.ts
   - 新增 Hook 点 'fragment_color_after_lighting'           ← 层 5
   - Fog 代码片段注入

6. L1/TextureManager.ts
   - 创建 Sampler 时根据 pitch 启用 maxAnisotropy          ← 层 6.1

7. style-spec.ts / preset-25d.ts
   - SkySpec + FogSpec 类型定义
   - 默认主题配色
   - sky/fog 颜色联动约束

实施顺序建议：
  Phase A（1~2 天）：层 1（clearColor）+ 层 2（动态 far）→ 地面能延伸到地平线，黑色→深蓝
  Phase B（2~3 天）：层 4（sky 渲染）+ 层 5（fog）→ 天空渐变 + 远处雾化
  Phase C（1~2 天）：层 3（瓦片覆盖）+ 层 6（LOD + 各向异性）→ 覆盖完整 + 质量优化
  Phase D（0.5 天）：层 7（world copies）+ 边界处理 + 最终调参
```

---

## 五、修复效果预期

```
修复前（截图）：                         修复后：
┌─────────────────────────┐           ┌─────────────────────────┐
│       纯黑（40%）        │           │    天空渐变              │
│                         │           │  skyColor → horizonColor │
│                         │           ├─ 平滑过渡（无硬边）───── ┤
├── 地面硬边缘（截断）────┤           │    雾化远处瓦片           │
│                         │           │  fogColor 混合           │
│    地面瓦片（60%）       │           │                         │
│                         │           │    清晰近处瓦片           │
│                         │           │                         │
└─────────────────────────┘           └─────────────────────────┘
```

---

## 六、测试矩阵

| # | 场景 | 验证 |
|---|------|------|
| 1 | pitch=0, zoom=10 | 无天空（horizonY=0），地面填满，无 fog |
| 2 | pitch=30°, zoom=5 | 天空占顶部 ~10%，地面延伸到地平线，轻微 fog |
| 3 | pitch=45°, zoom=3（截图场景）| 天空 ~30%，地面完整，fog 自然过渡，无黑色 |
| 4 | pitch=60°, zoom=2 | 天空 ~45%，远处瓦片雾化（LOD 降级 z-2），各向异性过滤激活 |
| 5 | pitch=75°, zoom=1 | 天空占多数，窄带地面，远处 LOD z-3 |
| 6 | pitch=85°, zoom=1 | 几乎全天空，极窄地面，不崩溃 |
| 7 | 动态 pitch（拖拽旋转）| horizonY 实时更新，天空/fog 平滑无闪烁 |
| 8 | 2D→2.5D 切换 | sky alpha 从 0 淡入到 1，平滑过渡 |
| 9 | 深色/浅色主题切换 | sky/fog 颜色跟随主题 |
| 10 | 卫星底图 | sky 切换为深空配色 |
| 11 | 有地形（terrain） | 地形隆起不被 fog 过度遮挡（fog 基于线性深度）|
| 12 | renderWorldCopies=true | 低 zoom 世界两侧有重复副本，无缝衔接 |
| 13 | renderWorldCopies=false | 世界边缘显示 sky/fog 颜色而非黑色 |
| 14 | 远裁面 Z 精度 | pitch=80° 时近处无 Z-fighting（Reversed-Z 保障）|
| 15 | 各向异性过滤 | pitch=60° 时远处栅格瓦片纹理比不启用时清晰 |
| 16 | LOD 衰减 | pitch=60° 时远处瓦片请求量减少 >50%（对比不衰减）|
| 17 | 总瓦片数限制 | pitch=75° 时总瓦片数不超过 pitch=0 时的 3 倍 |
| 18 | 性能 | SkyPass 1 draw call < 0.1ms，fog 注入无额外 pass |
| 19 | clearColor fallback | sky 未启用时，clearColor 为主题色而非纯黑 |
| 20 | sky 属性动态修改 | map.setSky({ skyColor: '#xxx' }) 实时生效 |
