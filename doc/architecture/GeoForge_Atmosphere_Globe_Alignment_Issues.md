# 3D GIS 引擎：大气渲染与地球不对齐问题汇编 v2

> 涉及引擎：CesiumJS / cesium-unreal / cesium-unity / GIS-Forge
> 核心问题：atmosphere 渲染出的球形轮廓与 globe 瓦片几何不重合（蛋形）
> 10 项审计修复：方案A shader 代码、渲染顺序修正、方案B RTE 修复方向、sky dome 分析、ATMOSPHERE_WGSL 逐行注释、交叉引用

---

## 一、CesiumJS 的方案——椭球体几何网格

CesiumJS 官方博客（2022-05）原文：

> The sky atmosphere is rendered on an **ellipsoid drawn behind the globe**
> with dimensions slightly larger than that of the globe.

具体架构：

- **SkyAtmosphere** 用 `EllipsoidGeometry` 网格渲染，半径 = 地球半径 × 1.025
- 网格和 globe 瓦片走**完全相同的渲染管线**：相同 VP 矩阵、相同 RTE 精度路径
- 散射计算在网格的每个顶点或片元上执行（`perFragmentAtmosphere` 控制）
- **Ground atmosphere** 直接画在 globe 瓦片表面，与地形几何完全绑定
- **渲染顺序**：atmosphere ellipsoid（depthCompare: always）→ globe tiles → ground atmosphere
  即大气画在 globe **后面**（先画），globe 瓦片覆盖在大气前面

**为什么椭球体几何不会蛋形**：

```
关键：大气的球形轮廓由几何顶点决定，不由 ray-sphere 求交决定。

几何顶点精度路径（与 globe 瓦片完全一致）：
  1. CPU Float64 计算 ECEF 顶点坐标
  2. CPU Float64 减去 cameraECEF → RTE 坐标（值域 ±数千km）
  3. Float32 传给 GPU
  4. GPU: clipPos = vpMatrix × vec4(posRTE, 1.0)

这条路径中 Float32 的精度 = RTE 值域 / 2^23
  = 5000km / 8388608 ≈ 0.0006m（亚毫米级）

对比 ray-sphere 方案：
  球心坐标精度 = 26M / 2^23 ≈ 3.1m → 差 5000 倍
```

**CesiumJS atmosphere fragment shader 的散射计算方式**：

```
几何方案下，shader 的输入来自顶点插值，不需要 ray-sphere 求交：

@fragment fn atmo_fs(in: AtmoVsOut) -> vec4<f32> {
  // posRTE = 大气球面上的点（从顶点插值得到）
  // 相机在 RTE 原点 [0,0,0]
  let viewDir = normalize(in.posRTE);          // 视线方向
  let surfaceNormal = normalize(in.posRTE);    // 球面法线 ≈ 归一化位置
  let camDist = length(in.posRTE);             // 相机到该点的距离

  // 散射路径长度 = 射线在大气层中穿过的长度
  // 几何保证该点在大气球面上，path 长度由几何位置直接给出
  let earthR = 6378137.0;
  let atmoR = earthR * 1.025;
  let cosAngle = dot(viewDir, surfaceNormal);
  let pathLen = 2.0 * atmoR * cosAngle;       // 简化的弦长估计

  // Rayleigh + Mie 散射颜色计算（与全屏三角形方案相同）
  let density = clamp(pathLen / (atmoR - earthR) / 4.0, 0.0, 1.0);
  let color = vec3(0.3, 0.5, 1.0) * density * 0.6;
  return vec4(color, density * 0.4);
}
```

---

## 二、GIS-Forge 当前方案——全屏三角形 + ray-sphere（蛋形根因）

### ATMOSPHERE_WGSL 逐行注释（标注蛋形根因行）

```wgsl
@fragment fn atmo_fs(in: AtmoVsOut) -> @location(0) vec4<f32> {
  let earthRadius = 6378137.0;
  let atmoRadius = earthRadius * 1.025;
  let rd = normalize(in.rayDir);

  // ★★★ 蛋形根因：cameraPosition 是绝对 ECEF Float32（~26M 米级）★★★
  let earthCenter = -atmo.cameraPosition;   // 地球中心在 RTE 空间
  // earthCenter 的三轴精度不均匀：
  //   X: ULP ≈ 0.26m, Y: ULP ≈ 0.52m, Z: ULP ≈ 0.49m
  //   → 球心位置在三个方向上的误差不同 → 蛋形

  let oc = -earthCenter;  // = cameraPosition（从球心到相机的向量）
  let b = dot(oc, rd);
  let c = dot(oc, oc) - atmoRadius * atmoRadius;
  //       ↑ dot(oc,oc) = x²+y²+z²，每个分量精度不同 → c 有方向依赖误差

  let disc = b * b - c;
  if (disc < 0.0) { return vec4<f32>(0.0); }

  // 交点 t0/t1 受 disc 的方向依赖误差影响
  // → 不同屏幕方向的交点距离不同 → 大气轮廓不对称 → 蛋形
  let sqrtDisc = sqrt(disc);
  let t0 = -b - sqrtDisc;
  let t1 = -b + sqrtDisc;
  // ... 后续 pathLen 和颜色计算 ...
}
```

### 蛋形 vs 正圆的精度对比

```
                    globe 瓦片              atmosphere ray-sphere
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
坐标来源          CPU Float64 RTE 减法      GPU Float32 绝对 ECEF
值域              ±数千 km                  ±26,000 km
Float32 精度      ~0.0006m（亚毫米）        ~3.1m
三轴精度均匀性    ✅ 均匀（RTE 值域接近）   ❌ 不均匀（XYZ 值不同）
蛋形风险          无                        有（三轴误差差 2 倍）
```

### 为什么 sky dome 没有蛋形？

sky dome 也用全屏三角形 + inverseVP，但它**不做 ray-sphere 求交**：

```wgsl
// sky dome 只用射线方向做渐变颜色，不计算交点位置
let cosAngle = dot(in.rayDir, up);
let t = smoothstep(-0.1, 0.3, cosAngle);
skyColor = mix(horizonColor, zenithColor, t);
```

sky dome 的输出不依赖球心位置 → 不受 Float32 精度影响 → 不蛋形。
atmosphere 的输出依赖 `earthCenter`（球心 ECEF 坐标）→ Float32 精度不足 → 蛋形。

---

## 三、相关 Issue 汇总

### CesiumJS #8683 — 小椭球体的大气渲染错误

**现象**：使用小椭球体时 ground atmosphere 导致影像闪烁或消失。
**根因**：大气散射算法硬编码地球尺寸常量，小椭球体时 atmosphere 与 globe 半径不匹配。
**修复**：将大气参数参数化为椭球体尺寸。

### CesiumJS #7124 — Ground atmosphere 在非地球椭球体上破坏影像

**现象**：非地球椭球体上 `showGroundAtmosphere` 导致影像闪烁，关闭后正常。
**根因**：ground atmosphere 散射计算硬编码 WGS84 参数。
**修复**：ground atmosphere 参数跟随椭球体变化。

### CesiumJS #1064 — 大气遮挡排序错误

**现象**：月球在地球后面时，月球出现在大气前面但地球后面。
**根因**：sky atmosphere 椭球体几何的深度与月球的深度写入不一致。
**GIS-Forge 启示**：大气的深度写入策略需要与所有渲染层协调。

### CesiumJS #11681 / #10063 — 统一天空和地面大气参数

**问题**：`skyAtmosphere` 和 `globe` 有独立的散射参数副本，不同步导致颜色不一致。
**修复**：统一使用 `AtmosphereCommon.glsl` 共享散射算法。
**GIS-Forge 启示**：天穹和大气参数不能各自独立。

### cesium-unreal #661 — 移动端大气不显示

**现象**：Unreal 移动端 Sky Atmosphere 不渲染。
**解法**：创建一个巨大的反法线球体网格作为大气载体。
**GIS-Forge 启示**：椭球体几何方案天然兼容移动端。

---

## 四、修复方案

### 方案 A：椭球体几何渲染大气（推荐，CesiumJS 方案）

**原理**：大气轮廓由几何顶点决定，走 RTE 精度路径，与 globe 瓦片完美对齐。

**tessellateAtmosphereShell 实现**：

```typescript
function tessellateAtmosphereShell(segments: number = 64): GlobeTileMesh {
    // 生成一个完整球体（不是瓦片），半径 = WGS84_A × 1.025
    const atmoRadius = WGS84_A * 1.025;
    const vertCount = (segments + 1) * (segments + 1);
    const positions = new Float64Array(vertCount * 3);  // Float64 精度
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);

    let vi = 0;
    for (let lat = 0; lat <= segments; lat++) {
        const theta = (lat / segments) * Math.PI;  // 0 → π
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        for (let lng = 0; lng <= segments; lng++) {
            const phi = (lng / segments) * 2 * Math.PI;  // 0 → 2π
            const sinP = Math.sin(phi), cosP = Math.cos(phi);

            // ECEF 坐标（Float64 精度）
            const x = atmoRadius * sinT * cosP;
            const y = atmoRadius * sinT * sinP;
            const z = atmoRadius * cosT;
            positions[vi * 3] = x;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = z;

            // 法线 = 归一化位置
            normals[vi * 3] = sinT * cosP;
            normals[vi * 3 + 1] = sinT * sinP;
            normals[vi * 3 + 2] = cosT;

            uvs[vi * 2] = lng / segments;
            uvs[vi * 2 + 1] = lat / segments;
            vi++;
        }
    }

    // 三角形索引
    const indices = new Uint32Array(segments * segments * 6);
    let ii = 0;
    for (let lat = 0; lat < segments; lat++) {
        for (let lng = 0; lng < segments; lng++) {
            const a = lat * (segments + 1) + lng;
            const b = a + segments + 1;
            indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1;
            indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1;
        }
    }

    return { positions, normals, uvs, indices, indexCount: ii, vertexCount: vertCount };
}
```

**渲染顺序和 pipeline 配置**：

```
渲染顺序：
  1. atmosphere ellipsoid（在 globe 后面，先画）
     → depthCompare: 'always', depthWrite: false
     → blend: src=one, dst=one（加性混合）
  2. globe tiles（覆盖在大气前面）
     → depthCompare: 'less-equal', depthWrite: true
  3. sky dome（背景，在最远处）
     → depthCompare: 'always', depthWrite: true（z=0.9999）

注意：CesiumJS 的顺序是 atmosphere 先画（作为背景光晕），
globe 后画覆盖大气。加性混合保证大气边缘（globe 未覆盖的部分）可见。
```

**atmosphere fragment shader（几何方案）**：

```wgsl
struct AtmoVsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) posRTE: vec3<f32>,   // 大气球面上的点（RTE 空间）
  @location(1) normal: vec3<f32>,    // 球面法线
};

@vertex fn atmo_vs(in: VsIn) -> AtmoVsOut {
  var out: AtmoVsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(in.posRTE, 1.0);
  out.posRTE = in.posRTE;
  out.normal = in.normal;
  return out;
}

@fragment fn atmo_fs(in: AtmoVsOut) -> @location(0) vec4<f32> {
  let earthR = 6378137.0;
  let atmoR = earthR * 1.025;
  let maxPath = atmoR - earthR;

  // 视线方向（相机在 RTE 原点 [0,0,0]）
  let viewDir = normalize(in.posRTE);
  let dist = length(in.posRTE);

  // 散射路径估计：相机到大气球面点的距离中，穿越大气层的比例
  // 简化模型：距离越远（接近边缘）→ 路径越长 → 密度越高
  let nDotV = abs(dot(in.normal, viewDir));
  let pathLen = maxPath / max(nDotV, 0.01);  // 边缘 path 更长
  let density = clamp(pathLen / (maxPath * 4.0), 0.0, 1.0);

  let atmoColor = vec3<f32>(0.3, 0.5, 1.0);
  return vec4<f32>(atmoColor * density * 0.6, density * 0.4);
}
```

### 方案 B：修复全屏三角形的 earthCenter 精度（备选）

**核心思路**：在 CPU 用 Float64 计算 earthCenter 的 RTE 坐标，然后传给 GPU。

```
当前错误路径：
  CPU: gc.cameraECEF = [x, y, z]（Float64）
  GPU: _atmoUniformData[16..18] = cameraECEF（Float64 → Float32 截断）
  shader: earthCenter = -cameraPosition（Float32 绝对值 ~26M → ULP 3m）

修复路径：
  CPU（Float64）: earthCenterRTE = [0,0,0] - cameraECEF = -cameraECEF
  CPU（Float64 → Float32）: 传 earthCenterRTE 给 GPU
  
  但 earthCenterRTE = -cameraECEF，值仍然是 ~26M → Float32 截断后精度 = 3m
  → ❌ 没有改善（因为 RTE 减法中 earthCenter 的 ECEF 坐标本身就是 [0,0,0]，
     减去 cameraECEF 后值域不变）

  根本问题：RTE 对"相机附近的点"有效（cameraECEF - cameraECEF ≈ 0），
           但地球中心 [0,0,0] 离相机 26M 远 → RTE 减法后值仍然是 ~26M → 无效

  唯一能让方案 B 工作的方法：
    不传球心坐标，而是传 viewMatrix 的列向量让 shader 自己推导球心方向。
    但这等价于用 inverseVP 重建射线方向 → 回到原始方案 → 精度问题不变。

结论：全屏三角形 + ray-sphere 方案的精度瓶颈是结构性的，
     无法通过 RTE 减法改善（因为球心离相机太远）。
     推荐方案 A。
```

---

## 五、与 GIS-Forge 文档的交叉引用

| 本文内容 | 相关文档 | 关联 |
|---------|---------|------|
| §二 Float32 精度分析 | **EggShape Issues v2 §根因二** | Float32 ULP 计算方法相同 |
| §二 蛋形根因 | **EggShape Issues v2 §根因七** | 蛋形的另一个可能来源（fov 单位） |
| §三 #8683 椭球体参数 | **Globe Shape Issues v2 §一** | 非 WGS84 椭球体参数化 |
| §三 #1064 遮挡排序 | **Globe Shape Issues v2 §七** | 多图层球面渲染的深度协调 |
| §四 方案A 的 RTE 管线 | **Globe Pipeline v2 §三** | meshToRTE 的精度路径 |
| §四 渲染顺序 | **Migration Plan v2 §Step 9/10** | sky dome 和 atmosphere 的搬入顺序 |

---

## 六、GIS-Forge 修复建议

**推荐方案 A**。给 Cursor 的指令：

```
1. 新建 tessellateAtmosphereShell(64) → 生成 R×1.025 的完整球体网格
   （可复用 tessellateGlobeTile 的 geodeticToECEF 逻辑，但遍历全球而非单个瓦片）

2. 在 _createGPUResources 中创建 atmosphere 的顶点/索引缓冲
   缓存为 this._atmoMesh（只需创建一次，不随帧变化）

3. 每帧在 _renderAtmosphere 中：
   - meshToRTE(atmoMesh, gc.cameraECEF) → RTE 顶点
   - 上传到临时 vertexBuffer
   - 用 globe pipeline 的 VP 矩阵渲染（共享 cameraBindGroup）

4. atmosphere pipeline:
   - depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' }
   - blend: { color: { src: 'one', dst: 'one' }, alpha: { src: 'one', dst: 'one' } }
   - cullMode: 'front'（只渲染球体内壁，因为相机在球体内部）

5. 渲染顺序改为：atmosphere ellipsoid → sky dome → globe tiles
   （大气先画作为背景光晕，globe 覆盖在前面）

6. 删除 ATMOSPHERE_WGSL 中的 ray-sphere 求交代码
   改为从顶点插值的 posRTE/normal 计算散射
```
