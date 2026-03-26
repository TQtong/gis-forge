# GIS-Forge 2.5D 渲染管线完整实现设计 v2

> Cursor 实现 2.5D 渲染的**唯一参考**。
> 从 `{center, zoom, pitch, bearing}` 到屏幕像素的全部计算。
> 数学库统一使用 `wgpu-matrix`（WebGPU 原生 column-major）。

---

## 零、渲染管线总览

```
用户状态                  渲染管线                               屏幕
┌──────────────┐   ┌─────────────────────────────────────┐   ┌────────┐
│ center [lng,lat]│   │ ① 相机矩阵 computeCamera25D()      │   │        │
│ zoom  (float) │──→│ ② 瓦片列表 coveringTiles()           │──→│ 像素   │
│ pitch (rad)   │   │ ③ GPU Pipeline + 实例化绘制           │   │        │
│ bearing (rad) │   │ ④ 帧循环 onFrame()                    │   │        │
│ fov   (rad)   │   └─────────────────────────────────────┘   └────────┘
└──────────────┘
```

产物链：
- ① → `Camera25DState`（vpMatrix, inverseVP, nearZ, farZ, cameraPosition …）
- ② → `TileID[]` + 按距离排序 + frustum cull + LOD
- ③ → 一次 drawIndexed 绘制所有瓦片（实例化）
- ④ → requestAnimationFrame 帧循环

---

## 一、类型定义

```typescript
// ═══ 所有类型集中定义，Cursor 直接粘贴 ═══

/** 2D 包围盒 [west, south, east, north]（经纬度） */
type BBox2D = [number, number, number, number];

interface Viewport { width: number; height: number; }

interface Camera25DState {
  // 矩阵（全部 Float32Array[16]，column-major）
  projMatrix:    Float32Array;
  viewMatrix:    Float32Array;
  vpMatrix:      Float32Array;
  inverseVP:     Float32Array;

  // 裁剪面
  nearZ: number;
  farZ:  number;

  // 相机参数
  cameraToCenterDist: number;
  cameraPosition: [number, number, number];  // 世界像素坐标
  worldSize: number;                          // TILE_SIZE × 2^zoom

  // 用户输入的原始值（透传）
  center:  [number, number];
  zoom:    number;
  pitch:   number;
  bearing: number;
  fov:     number;
  viewport: Viewport;
}

interface TileID {
  z: number;  x: number;  y: number;
  key: string;          // "z/x/y"
  distToCamera: number; // 用于排序
}

interface LoadedTile extends TileID {
  texture: GPUTexture | null;
  bindGroup: GPUBindGroup | null;
  /** 纹理还没到时，父瓦片的 key */
  parentKey?: string;
}

// WebGPU Uniform 对齐常量
const UNIFORM_ALIGN = 16; // bytes
```

---

## 二、坐标系与转换函数

```
地理坐标 (lng, lat)
    ↓  lngLatToMercator
墨卡托归一化 (0~1, 0~1)      原点=左上角(-180, 85.05)
    ↓  × worldSize
世界像素坐标 (0~worldSize)    worldSize = 512 × 2^zoom
    ↓  viewMatrix (lookAt)
相机空间 (eye=原点, 看-Z)
    ↓  projMatrix (perspective)
裁剪空间 NDC (-1~1, -1~1, 0~1)   WebGPU: z∈[0,1], Reversed-Z: near→1 far→0
    ↓  viewport transform
屏幕像素 (0~width, 0~height)
```

```typescript
const TILE_SIZE = 512;

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

function mercatorToLngLat(mx: number, my: number): [number, number] {
  const lng = mx * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * my)));
  const lat = latRad * 180 / Math.PI;
  return [lng, lat];
}

function lngLatToWorld(lng: number, lat: number, worldSize: number): [number, number] {
  const [mx, my] = lngLatToMercator(lng, lat);
  return [mx * worldSize, my * worldSize];
}

function worldToMercator(wx: number, wy: number, worldSize: number): [number, number] {
  return [wx / worldSize, wy / worldSize];
}

function worldToLngLat(wx: number, wy: number, worldSize: number): [number, number] {
  return mercatorToLngLat(wx / worldSize, wy / worldSize);
}
```

---

## 三、相机模型

### 3.1 几何模型

```
侧视图（bearing=0）：

                Camera ●─────── cameraToCenterDist ───────● Center(地面)
                      ╱╲                                    ↑
                     ╱  ╲                                   │
              height╱    ╲ offsetBack                       │
               (h) ╱      ╲                                 │
                  ╱ pitch   ╲                               │
  ═══════════════╱══════════╪═══════════════ 地面 z=0 ═══════
               远处       Center投影

  cameraToCenterDist = viewport.height / 2 / tan(fov / 2)
  h (海拔)          = cameraToCenterDist × cos(pitch)
  offsetBack (后退) = cameraToCenterDist × sin(pitch)

  相机位置（世界坐标）：
    x = centerWorldX + sin(bearing) × offsetBack
    y = centerWorldY - cos(bearing) × offsetBack
    z = h
```

### 3.2 farZ 对照表（fov=0.6435rad, viewport.height=960）

```
cameraToCenterDist = 1440

pitch°  angleToHorizon°  topHalfSurfDist  farZ     ratio
─────────────────────────────────────────────────────────
   0     71.57             —               2880     2.00  (兜底)
  20     51.57             765             2880     2.00  (兜底)
  30     41.57            1240             2880     2.00  (兜底)
  40     31.57            1921             2882     2.00  (兜底)
  45     26.57            2277             3416     2.37
  50     21.57            2815             4223     2.93
  55     16.57            3726             5589     3.88
  60     11.57            6219             9329     6.48
  65      6.57           15860            23790    16.52
  70      1.57           57886            86829    60.30
  >71.57  ≤0              ∞              144000   100.00  (兜底)
```

### 3.3 完整计算函数

```typescript
/**
 * 2.5D 相机核心计算。
 * 
 * 库依赖：wgpu-matrix（mat4.xxx 全部 column-major Float32Array[16]）
 * 如果用 gl-matrix v4：API 一致。如果用 gl-matrix v3：注意 create() 返回 Float64Array 需手动 new Float32Array。
 */
function computeCamera25D(
  center: [number, number],
  zoom: number,
  pitch: number,
  bearing: number,
  fov: number,
  viewport: Viewport,
): Camera25DState {

  const halfFov = fov / 2;
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const aspect = viewport.width / viewport.height;

  // ═══ 1. cameraToCenterDist ═══
  const cameraToCenterDist = viewport.height / 2 / Math.tan(halfFov);

  // ═══ 2. 动态 farZ ═══
  let farZ: number;
  if (pitch < 0.01) {
    // pitch≈0 快速路径：正交等效
    farZ = cameraToCenterDist * 2.0;
  } else {
    const angleToHorizon = Math.PI / 2 - pitch - halfFov;
    if (angleToHorizon > 0.01) {
      const topHalfSurfaceDist =
        Math.sin(pitch) * cameraToCenterDist / Math.sin(angleToHorizon);
      farZ = topHalfSurfaceDist * 1.5;
    } else {
      farZ = cameraToCenterDist * 100.0;
    }
    farZ = Math.max(farZ, cameraToCenterDist * 2.0);
  }

  // ═══ 3. nearZ ═══
  // 太小会导致深度精度不足，太大会裁掉近处地面
  const nearZ = cameraToCenterDist * 0.1;

  // ═══ 4. 投影矩阵（标准 Z，非 Reversed-Z！简化实现）═══
  // WebGPU depth [0,1]，近→0 远→1，depthCompare = 'less-equal'
  // 用库函数 perspectiveZO（Z-zero-to-one）：
  const projMatrix = new Float32Array(16);
  mat4_perspectiveZO(projMatrix, fov, aspect, nearZ, farZ);

  // ═══ 5. 相机位置 ═══
  const [centerWX, centerWY] = lngLatToWorld(center[0], center[1], worldSize);
  const offsetBack = Math.sin(pitch) * cameraToCenterDist;
  const height     = Math.cos(pitch) * cameraToCenterDist;
  const camX = centerWX + Math.sin(bearing) * offsetBack;
  const camY = centerWY - Math.cos(bearing) * offsetBack;
  const camZ = height;

  // ═══ 6. 视图矩阵 ═══
  // up 向量的唯一正确写法（墨卡托 Y 向下，Z 向上）：
  //   构建方式：先 lookAt 用 up=[0,0,1]，这在 bearing=0 时就已经正确
  //   bearing!=0 时：相机绕 center 旋转，lookAt 自动处理方向，up=[0,0,1] 仍然正确
  //   原因：bearing 改变的是 eye 的位置，不是 up 的方向
  const viewMatrix = new Float32Array(16);
  mat4_lookAt(viewMatrix,
    [camX, camY, camZ],      // eye
    [centerWX, centerWY, 0], // target = center on ground
    [0, 0, 1],               // up = world Z axis (始终不变！)
  );

  // ═══ 7. VP 矩阵 ═══
  const vpMatrix = new Float32Array(16);
  mat4_multiply(vpMatrix, projMatrix, viewMatrix);  // ⚠️ 顺序：proj × view

  // ═══ 8. 逆 VP ═══
  const inverseVP = new Float32Array(16);
  mat4_invert(inverseVP, vpMatrix);

  return {
    projMatrix, viewMatrix, vpMatrix, inverseVP,
    nearZ, farZ, cameraToCenterDist,
    cameraPosition: [camX, camY, camZ],
    worldSize, center, zoom, pitch, bearing, fov, viewport,
  };
}
```

### 3.4 mat4 辅助函数（如果不用库）

```typescript
/** 标准 Z [0,1] 透视矩阵（WebGPU 兼容）。Column-major Float32Array[16]。 */
function mat4_perspectiveZO(
  out: Float32Array, fovY: number, aspect: number, near: number, far: number,
): Float32Array {
  const f = 1.0 / Math.tan(fovY / 2);
  const nf = 1.0 / (near - far);
  out.fill(0);
  out[0]  = f / aspect;
  out[5]  = f;
  out[10] = far * nf;          // = far / (near - far)，值为负数
  out[11] = -1.0;
  out[14] = near * far * nf;   // = (near × far) / (near - far)，值为负数
  return out;
}

/** lookAt 视图矩阵。Column-major。 */
function mat4_lookAt(
  out: Float32Array,
  eye: number[], center: number[], up: number[],
): Float32Array {
  let x0, x1, x2, y0, y1, y2, z0, z1, z2, len;

  z0 = eye[0] - center[0]; z1 = eye[1] - center[1]; z2 = eye[2] - center[2];
  len = 1 / Math.sqrt(z0*z0 + z1*z1 + z2*z2);
  z0 *= len; z1 *= len; z2 *= len;

  x0 = up[1]*z2 - up[2]*z1; x1 = up[2]*z0 - up[0]*z2; x2 = up[0]*z1 - up[1]*z0;
  len = Math.sqrt(x0*x0 + x1*x1 + x2*x2);
  if (len > 1e-10) { len = 1/len; x0*=len; x1*=len; x2*=len; }

  y0 = z1*x2 - z2*x1; y1 = z2*x0 - z0*x2; y2 = z0*x1 - z1*x0;
  len = Math.sqrt(y0*y0 + y1*y1 + y2*y2);
  if (len > 1e-10) { len = 1/len; y0*=len; y1*=len; y2*=len; }

  out[0]=x0; out[1]=y0; out[2]=z0; out[3]=0;
  out[4]=x1; out[5]=y1; out[6]=z1; out[7]=0;
  out[8]=x2; out[9]=y2; out[10]=z2; out[11]=0;
  out[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
  out[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
  out[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
  out[15]=1;
  return out;
}

function mat4_multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j*4+i] = a[i]*b[j*4] + a[4+i]*b[j*4+1] + a[8+i]*b[j*4+2] + a[12+i]*b[j*4+3];
    }
  }
  return out;
}

function mat4_invert(out: Float32Array, a: Float32Array): boolean {
  // 标准 4x4 逆矩阵（Cramer's Rule），此处省略完整代码
  // 建议直接使用 wgpu-matrix 或 gl-matrix 的 mat4.invert
  // 返回 false 表示矩阵不可逆（不应该发生）
  return true; // placeholder
}
```

### 3.5 screenToWorld / worldToScreen

```typescript
/** 屏幕像素 → 地面世界坐标。返回 null 表示射线不与地面相交。 */
function screenToWorld(
  sx: number, sy: number, camera: Camera25DState,
): [number, number] | null {
  const { inverseVP, viewport } = camera;
  const ndcX = (sx / viewport.width)  * 2 - 1;
  const ndcY = 1 - (sy / viewport.height) * 2;

  // 标准 Z：near=0, far=1
  const a = transformVec4(inverseVP, [ndcX, ndcY, 0, 1]); // near plane
  const b = transformVec4(inverseVP, [ndcX, ndcY, 1, 1]); // far plane
  const near = [a[0]/a[3], a[1]/a[3], a[2]/a[3]];
  const far  = [b[0]/b[3], b[1]/b[3], b[2]/b[3]];

  const dz = far[2] - near[2];
  if (Math.abs(dz) < 1e-10) return null;
  const t = -near[2] / dz;
  if (t < 0) return null;

  return [near[0] + t * (far[0]-near[0]), near[1] + t * (far[1]-near[1])];
}

/** 地面世界坐标 → 屏幕像素。 */
function worldToScreen(
  wx: number, wy: number, camera: Camera25DState,
): [number, number] {
  const clip = transformVec4(camera.vpMatrix, [wx, wy, 0, 1]);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return [
    (ndcX + 1) / 2 * camera.viewport.width,
    (1 - ndcY) / 2 * camera.viewport.height,
  ];
}

/** 射线不与地面相交时的 fallback：沿水平方向取最远点。 */
function screenToHorizon(sx: number, sy: number, camera: Camera25DState): [number, number] {
  const { inverseVP, viewport, cameraPosition, farZ } = camera;
  const ndcX = (sx / viewport.width) * 2 - 1;
  const ndcY = 1 - (sy / viewport.height) * 2;
  const fp = transformVec4(inverseVP, [ndcX, ndcY, 1, 1]);
  const far = [fp[0]/fp[3], fp[1]/fp[3], fp[2]/fp[3]];
  const dx = far[0] - cameraPosition[0];
  const dy = far[1] - cameraPosition[1];
  const hLen = Math.sqrt(dx*dx + dy*dy);
  if (hLen < 1e-6) return [cameraPosition[0], cameraPosition[1]];
  const t = farZ * 0.9 / hLen;
  return [cameraPosition[0] + dx*t, cameraPosition[1] + dy*t];
}

function transformVec4(m: Float32Array, v: number[]): number[] {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2]  + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2]  + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
  ];
}
```

### 3.6 数值验证

```
输入：center=[0,0], zoom=10, pitch=45°, bearing=0, fov=0.6435rad, viewport=1232×960

cameraToCenterDist = 480 / tan(0.3218) = 1440.0
cameraZ = cos(0.785) × 1440 = 1018.2
offsetBack = sin(0.785) × 1440 = 1018.2
centerWorld = [262144, 262144]
cameraPos = [262144, 261125.8, 1018.2]
angleToHorizon = 26.57°
topHalfSurfDist = 2277
farZ = max(2277×1.5, 1440×2) = 3416
ratio = 3416/1440 = 2.37 ✅

验证 screenToWorld(616, 480) → 应返回接近 centerWorld 的值
验证 worldToScreen(262144, 262144) → 应返回接近 (616, 480) 的值
```

---

## 四、瓦片覆盖算法

### 4.1 Fractional Zoom 处理

```
zoom = 10.5 时：
  tileZoom = floor(10.5) = 10      ← 瓦片的整数 zoom 级别
  worldSize = 512 × 2^10.5 = 741455  ← 浮点 worldSize（相机用）
  
  瓦片坐标在 zoom=10 网格中，但渲染时用 worldSize 缩放
  → 瓦片看起来会比标准大小稍大（2^0.5 ≈ 1.41 倍）
  → 这是正确行为——fractional zoom 就是在整数瓦片间平滑过渡
```

### 4.2 完整算法

```typescript
function coveringTiles(camera: Camera25DState): TileID[] {
  const { zoom, viewport, worldSize, bearing } = camera;
  const tileZoom = Math.floor(zoom);
  const numTilesPerAxis = 1 << tileZoom;  // 2^tileZoom
  
  // ═══ 步骤 1：采样屏幕点 → 地面坐标 ═══
  // 比四角多采样：上边缘 5 个点 + 左右各 2 个 + 中心
  const screenPts: [number, number][] = [];
  const W = viewport.width, H = viewport.height;
  for (let i = 0; i <= 4; i++) screenPts.push([W * i / 4, 0]);       // 上边缘 5 点
  for (let i = 0; i <= 4; i++) screenPts.push([W * i / 4, H]);       // 下边缘 5 点
  for (let i = 1; i <= 3; i++) screenPts.push([0, H * i / 4]);       // 左边缘 3 点
  for (let i = 1; i <= 3; i++) screenPts.push([W, H * i / 4]);       // 右边缘 3 点
  screenPts.push([W/2, H/2]);                                         // 中心

  const groundPts: [number, number][] = [];
  for (const [sx, sy] of screenPts) {
    const wp = screenToWorld(sx, sy, camera);
    groundPts.push(wp ?? screenToHorizon(sx, sy, camera));
  }

  // ═══ 步骤 2：地面点 → tileZoom 级别的瓦片坐标范围 ═══
  // 注意：worldSize 是浮点 zoom 的，但瓦片坐标在 tileZoom 级别
  const tileWorldSize = TILE_SIZE * numTilesPerAxis;  // 整数 zoom 的 worldSize
  let minTX = Infinity, minTY = Infinity, maxTX = -Infinity, maxTY = -Infinity;
  for (const [wx, wy] of groundPts) {
    // 世界坐标 → 归一化 → tileZoom 级别瓦片坐标
    const tx = (wx / worldSize) * numTilesPerAxis;
    const ty = (wy / worldSize) * numTilesPerAxis;
    minTX = Math.min(minTX, tx);
    minTY = Math.min(minTY, ty);
    maxTX = Math.max(maxTX, tx);
    maxTY = Math.max(maxTY, ty);
  }
  minTX = Math.max(0, Math.floor(minTX));
  minTY = Math.max(0, Math.floor(minTY));
  maxTX = Math.min(numTilesPerAxis - 1, Math.ceil(maxTX));
  maxTY = Math.min(numTilesPerAxis - 1, Math.ceil(maxTY));

  // ═══ 步骤 3：枚举 + LOD + Frustum Cull ═══
  const centerMerc = lngLatToMercator(camera.center[0], camera.center[1]);
  const centerTX = centerMerc[0] * numTilesPerAxis;
  const centerTY = centerMerc[1] * numTilesPerAxis;

  const frustumPlanes = extractFrustumPlanes(camera.vpMatrix);
  const seen = new Set<string>();
  const tiles: TileID[] = [];

  for (let y = minTY; y <= maxTY; y++) {
    for (let x = minTX; x <= maxTX; x++) {
      // LOD：距 center 越远 → zoom 越低
      const dist = Math.sqrt((x+0.5-centerTX)**2 + (y+0.5-centerTY)**2);
      const lodDrop = Math.min(Math.floor(Math.log2(Math.max(1, dist / 3))), 4);
      const z = Math.max(0, tileZoom - lodDrop);

      // 降级到父瓦片
      const shift = tileZoom - z;
      const px = x >> shift;
      const py = y >> shift;
      const key = `${z}/${px}/${py}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Frustum Cull：瓦片 BBox 的 8 个角是否全在视锥外
      if (!tileInFrustum(px, py, z, worldSize, frustumPlanes)) continue;

      tiles.push({ z, x: px, y: py, key, distToCamera: dist });
    }
  }

  // renderWorldCopies：zoom < 3 时在 X 方向复制
  if (zoom < 3) {
    const copies = [...tiles];
    for (const t of copies) {
      for (const offset of [-1, 1]) {
        const cx = t.x + offset * (1 << t.z);
        const ck = `${t.z}/${cx}/${t.y}`;
        if (!seen.has(ck)) {
          seen.add(ck);
          tiles.push({ ...t, x: cx, key: ck });
        }
      }
    }
  }

  // 按距离排序（近→远，利于 early-Z）
  tiles.sort((a, b) => a.distToCamera - b.distToCamera);
  return tiles;
}
```

### 4.3 Frustum Culling

```typescript
/** 从 VP 矩阵提取 6 个视锥平面（Gribb-Hartmann 方法） */
function extractFrustumPlanes(vp: Float32Array): Float32Array[] {
  // 每个平面 [a, b, c, d]，ax+by+cz+d >= 0 表示在视锥内
  const planes: Float32Array[] = [];
  const row = (r: number, c: number) => vp[c * 4 + r]; // column-major 访问

  // Left:   row3 + row0
  planes.push(normalizePlane(row(3,0)+row(0,0), row(3,1)+row(0,1), row(3,2)+row(0,2), row(3,3)+row(0,3)));
  // Right:  row3 - row0
  planes.push(normalizePlane(row(3,0)-row(0,0), row(3,1)-row(0,1), row(3,2)-row(0,2), row(3,3)-row(0,3)));
  // Bottom: row3 + row1
  planes.push(normalizePlane(row(3,0)+row(1,0), row(3,1)+row(1,1), row(3,2)+row(1,2), row(3,3)+row(1,3)));
  // Top:    row3 - row1
  planes.push(normalizePlane(row(3,0)-row(1,0), row(3,1)-row(1,1), row(3,2)-row(1,2), row(3,3)-row(1,3)));
  // Near:   row3 + row2  (标准 Z)
  planes.push(normalizePlane(row(3,0)+row(2,0), row(3,1)+row(2,1), row(3,2)+row(2,2), row(3,3)+row(2,3)));
  // Far:    row3 - row2
  planes.push(normalizePlane(row(3,0)-row(2,0), row(3,1)-row(2,1), row(3,2)-row(2,2), row(3,3)-row(2,3)));

  return planes;
}

function normalizePlane(a: number, b: number, c: number, d: number): Float32Array {
  const len = Math.sqrt(a*a + b*b + c*c);
  return new Float32Array([a/len, b/len, c/len, d/len]);
}

/** AABB vs Frustum 测试。返回 true = 可能可见。 */
function tileInFrustum(
  tx: number, ty: number, tz: number,
  worldSize: number, planes: Float32Array[],
): boolean {
  const scale = worldSize / (TILE_SIZE * (1 << tz));
  const x0 = tx * TILE_SIZE * scale;
  const y0 = ty * TILE_SIZE * scale;
  const x1 = (tx+1) * TILE_SIZE * scale;
  const y1 = (ty+1) * TILE_SIZE * scale;
  // 地面瓦片 z=0，AABB = [x0,y0,0] ~ [x1,y1,0]

  for (const p of planes) {
    // 找 AABB 的 P-vertex（离平面最远的角）
    const px = p[0] >= 0 ? x1 : x0;
    const py = p[1] >= 0 ? y1 : y0;
    const pz = p[2] >= 0 ? 0  : 0; // z 始终 0
    if (p[0]*px + p[1]*py + p[2]*pz + p[3] < 0) return false; // 全在平面外
  }
  return true;
}
```

---

## 五、GPU Pipeline 与实例化绘制

### 5.1 Pipeline 创建（一次性）

```typescript
function createTilePipeline(device: GPUDevice, format: GPUTextureFormat): {
  pipeline: GPURenderPipeline;
  cameraBindGroupLayout: GPUBindGroupLayout;
  tileBindGroupLayout: GPUBindGroupLayout;
} {
  const shaderModule = device.createShaderModule({ code: TILE_SHADER_WGSL });

  const cameraBindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    }],
  });

  const tileBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cameraBindGroupLayout, tileBindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [{
        // 每顶点：worldPos(vec3) + uv(vec2) = 5 floats = 20 bytes
        arrayStride: 20,
        attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // worldPos
          { shaderLocation: 1, offset: 12, format: 'float32x2' }, // uv
        ],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less-equal',    // 标准 Z（非 Reversed-Z）
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none',              // 地面瓦片双面可见
    },
  });

  return { pipeline, cameraBindGroupLayout, tileBindGroupLayout };
}
```

### 5.2 Uniform Buffer 对齐

```typescript
// WebGPU 要求 Uniform Buffer 成员按 16 字节对齐
// CameraUniforms 布局：
//   offset  0: vpMatrix      mat4x4<f32>  64 bytes
//   offset 64: cameraPosition vec3<f32>    12 bytes
//   offset 76: worldSize      f32           4 bytes  ← 填满到 80 bytes（16 的倍数✅）
// 总大小 = 80 bytes

const CAMERA_UNIFORM_SIZE = 80; // bytes

function writeCameraUniforms(
  device: GPUDevice, buffer: GPUBuffer, camera: Camera25DState,
) {
  const data = new Float32Array(20); // 80 / 4 = 20 floats
  data.set(camera.vpMatrix, 0);                  // offset 0:  16 floats
  data.set(camera.cameraPosition, 16);            // offset 16: 3 floats
  data[19] = camera.worldSize;                    // offset 19: 1 float
  device.queue.writeBuffer(buffer, 0, data);
}
```

### 5.3 WGSL 着色器

```wgsl
// ═══ tile.wgsl ═══

struct CameraUniforms {
  vpMatrix:       mat4x4<f32>,  // 64 bytes, offset 0
  cameraPosition: vec3<f32>,    // 12 bytes, offset 64
  worldSize:      f32,          //  4 bytes, offset 76
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var tileSampler: sampler;
@group(1) @binding(1) var tileTexture: texture_2d<f32>;

struct VsIn {
  @location(0) worldPos: vec3<f32>,
  @location(1) uv:       vec2<f32>,
};
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv:        vec2<f32>,
  @location(1) fogDist:   f32,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.pos = camera.vpMatrix * vec4<f32>(in.worldPos, 1.0);
  out.uv  = in.uv;
  // fog 距离（camera 到顶点的水平距离）
  let dx = in.worldPos.x - camera.cameraPosition.x;
  let dy = in.worldPos.y - camera.cameraPosition.y;
  out.fogDist = sqrt(dx*dx + dy*dy);
  return out;
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);
  // 简单距离雾（高 pitch 时遮挡远处模糊区域）
  let fogStart = camera.worldSize * 0.3;
  let fogEnd   = camera.worldSize * 0.8;
  let fogFactor = clamp((in.fogDist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  let fogColor = vec4<f32>(0.1, 0.1, 0.15, 1.0);
  color = mix(color, fogColor, fogFactor * 0.6);
  return color;
}
```

### 5.4 渲染帧（性能优化版：批量顶点上传）

```typescript
/**
 * 渲染一帧所有瓦片。
 * 
 * 性能关键：不是每个瓦片单独 writeBuffer，而是：
 *   1. 一次性写入所有瓦片的顶点到一个大 Buffer
 *   2. 用 drawIndexed + firstVertex 偏移绘制每个瓦片
 */
function renderFrame(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  camera: Camera25DState,
  tiles: LoadedTile[],
  resources: RenderResources,
) {
  // 1. 更新相机 uniform（每帧 1 次）
  writeCameraUniforms(device, resources.cameraUniformBuffer, camera);

  // 2. 批量生成所有瓦片顶点（每帧 1 次 writeBuffer）
  const vertexCount = tiles.length * 4;   // 每瓦片 4 顶点
  const floatsPerVertex = 5;              // worldX, worldY, worldZ, u, v
  const allVertices = new Float32Array(vertexCount * floatsPerVertex);

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const verts = computeTileVertices(t.z, t.x, t.y, camera.worldSize);
    allVertices.set(verts, i * 4 * floatsPerVertex);
  }
  device.queue.writeBuffer(resources.vertexBuffer, 0, allVertices);

  // 3. 渲染 Pass
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: resources.colorView,
      clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
      loadOp: 'clear', storeOp: 'store',
    }],
    depthStencilAttachment: {
      view: resources.depthView,
      depthClearValue: 1.0,          // 标准 Z：1.0 = 最远
      depthLoadOp: 'clear', depthStoreOp: 'store',
    },
  });

  pass.setPipeline(resources.pipeline);
  pass.setBindGroup(0, resources.cameraBindGroup);
  pass.setVertexBuffer(0, resources.vertexBuffer);
  pass.setIndexBuffer(resources.indexBuffer, 'uint16');

  // 4. 逐瓦片绘制（只切换纹理 BindGroup）
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile.bindGroup) continue;

    pass.setBindGroup(1, tile.bindGroup);
    const baseVertex = i * 4;
    // drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
    pass.drawIndexed(6, 1, 0, baseVertex, 0);
  }

  pass.end();
}

/** 生成瓦片顶点。注意 fractional zoom 的缩放。 */
function computeTileVertices(
  tz: number, tx: number, ty: number, worldSize: number,
): Float32Array {
  // 瓦片在整数 zoom 级别的尺寸，缩放到当前 worldSize
  const numTiles = 1 << tz;
  const tileSize = worldSize / numTiles;
  const x0 = tx * tileSize;
  const y0 = ty * tileSize;
  const x1 = x0 + tileSize;
  const y1 = y0 + tileSize;

  return new Float32Array([
    x0, y0, 0, 0, 0,  // 左上
    x1, y0, 0, 1, 0,  // 右上
    x0, y1, 0, 0, 1,  // 左下
    x1, y1, 0, 1, 1,  // 右下
  ]);
}

// 索引缓冲（全局共享，不变）
const TILE_INDICES = new Uint16Array([0, 1, 2, 1, 3, 2]);
```

---

## 六、父瓦片占位（Placeholder）

```typescript
/**
 * 当瓦片纹理尚未加载时，使用低 zoom 父瓦片的一部分作为占位。
 * MapLibre 的核心用户体验优化——地图永远不会有空白块。
 */
function getPlaceholderTile(
  tile: TileID, cache: Map<string, LoadedTile>,
): { tile: LoadedTile; uvOffset: [number,number]; uvScale: [number,number] } | null {
  // 从当前 zoom 往上找到第一个已加载的祖先瓦片
  for (let dz = 1; dz <= tile.z && dz <= 5; dz++) {
    const parentZ = tile.z - dz;
    const parentX = tile.x >> dz;
    const parentY = tile.y >> dz;
    const parentKey = `${parentZ}/${parentX}/${parentY}`;
    const parent = cache.get(parentKey);
    if (parent?.texture) {
      // 计算子瓦片在父瓦片纹理中的 UV 区域
      const subX = tile.x - (parentX << dz);  // 子瓦片在父瓦片内的相对位置
      const subY = tile.y - (parentY << dz);
      const subCount = 1 << dz;               // 父瓦片被分成 subCount×subCount 块
      return {
        tile: parent,
        uvOffset: [subX / subCount, subY / subCount],
        uvScale:  [1 / subCount, 1 / subCount],
      };
    }
  }
  return null;
}
```

---

## 七、完整帧循环

```typescript
function onFrame(state: MapState, device: GPUDevice, resources: RenderResources) {
  // 1. 相机矩阵
  const camera = computeCamera25D(
    state.center, state.zoom, state.pitch, state.bearing, state.fov, state.viewport,
  );

  // 2. 覆盖瓦片
  const tileIds = coveringTiles(camera);

  // 3. 加载 + 占位
  const loadedTiles: LoadedTile[] = [];
  for (const tid of tileIds) {
    const cached = resources.tileCache.get(tid.key);
    if (cached?.texture) {
      loadedTiles.push(cached);
    } else {
      // 触发异步加载
      if (!resources.tileCache.has(tid.key)) {
        requestTileLoad(tid, device, resources);
      }
      // 尝试父瓦片占位
      const placeholder = getPlaceholderTile(tid, resources.tileCache);
      if (placeholder) {
        // 用父瓦片 + UV 偏移渲染（需要传额外 uniform 或修改 UV）
        loadedTiles.push({
          ...tid,
          texture: placeholder.tile.texture,
          bindGroup: placeholder.tile.bindGroup,
        });
      }
    }
  }

  // 4. 渲染
  const encoder = device.createCommandEncoder();
  renderFrame(device, encoder, camera, loadedTiles, resources);
  device.queue.submit([encoder.finish()]);

  // 5. 下一帧
  requestAnimationFrame(() => onFrame(state, device, resources));
}
```

---

## 八、排查清单 v2

```
□ 1. cameraToCenterDist
     console.log('ctcd:', cameraToCenterDist)
     viewport.height=960, fov=0.6435 → 预期 ≈1440
     ❌ 如果值完全不对 → 检查 fov 是弧度还是角度

□ 2. farZ 是否够大
     console.log('farZ:', farZ, 'ratio:', farZ/cameraToCenterDist)
     pitch=45° → ratio ≥ 2.0
     pitch=60° → ratio ≥ 6.0
     ❌ 如果 ratio < 1.5 → 远处地面被裁掉

□ 3. 相机 Z（海拔）
     console.log('camZ:', cameraPosition[2])
     pitch=45° → 预期 ≈1018
     ❌ 如果 = 0 → 相机在地面上
     ❌ 如果 < 0 → 相机在地面下

□ 4. VP 矩阵乘法顺序
     必须 vpMatrix = projMatrix × viewMatrix
     ❌ 反了 → 画面完全变形

□ 5. up 向量
     必须 [0, 0, 1]（世界 Z 轴向上）
     ❌ 如果用了 [0, 1, 0] → 相机翻转
     ❌ 如果用了 [0, -1, 0] → 可能偶尔对但 pitch 大时会出错

□ 6. 瓦片顶点范围
     打印任意瓦片的 4 个顶点 x, y 值
     ✅ 应在 [0, worldSize] 范围
     ❌ 如果在 [0, TILE_SIZE] → 没有乘 scale
     ❌ 如果在 [0, 1] → 用了归一化坐标没转世界坐标

□ 7. depthCompare
     标准 Z（本文档方案）：depthCompare = 'less-equal'，depthClearValue = 1.0
     ❌ 如果用了 'greater' + clearValue=0 → 那是 Reversed-Z 配置

□ 8. coveringTiles 数量
     console.log('tiles:', tiles.length)
     pitch=0° zoom=10 → 预期 6~30 个
     pitch=45° zoom=10 → 预期 30~200 个
     ❌ 如果 = 0 → BBox 计算全错
     ❌ 如果 > 500 → 没有 frustum cull / LOD

□ 9. 固定颜色测试
     把 fs_main 改为 return vec4(1,0,0,1);
     ✅ 红色瓦片铺满视口下方 → 矩阵/顶点正确，问题在纹理
     ❌ 红色瓦片没铺满 → 问题在矩阵/顶点/裁剪

□ 10. 投影矩阵对角线符号
      打印 projMatrix[0], [5], [10], [11]
      ✅ [0] > 0, [5] > 0, [10] < 0, [11] = -1
      ❌ [11] ≠ -1 → 透视除法配置错误
```

---

## 九、与 GIS-Forge 架构的对接

| GIS-Forge 模块 | 本文档对应 | 修改内容 |
|---------------|-----------|---------|
| `@gis-forge/camera-25d` (P0) | §三 computeCamera25D | 替换整个矩阵计算函数 |
| `@gis-forge/camera-25d` (P0) | §三.5 screenToWorld/worldToScreen | 新增 project/unproject |
| `@gis-forge/runtime` TileScheduler (L3) | §四 coveringTiles | 替换瓦片覆盖算法 |
| `@gis-forge/runtime` TileScheduler (L3) | §四.3 extractFrustumPlanes | 新增 frustum cull |
| `@gis-forge/layer-tile-raster` (P0) | §五 Pipeline + Shader | 替换 WGSL + Pipeline 创建 |
| `@gis-forge/renderer` RenderGraph (L2) | §五.4 renderFrame | 批量顶点 + Pass 配置 |
| `@gis-forge/renderer` DepthManager (L2) | §五.1 depthStencil | 标准 Z + depth24plus |
| `@gis-forge/runtime` TileCache (L3) | §六 getPlaceholderTile | 父瓦片占位逻辑 |
| `@gis-forge/scene` InteractionManager (L5) | §七 onFrame | state → camera → render 循环 |

### 不用 Reversed-Z 的理由

本文档选择**标准 Z**（near→0, far→1）而非 Reversed-Z：
- 标准 Z 的投影矩阵更简单，不容易写错
- 2.5D 地图的深度范围有限（不像 3D 地球需要 1m~1000km），标准 Z 精度足够
- depthCompare='less-equal' + depthClearValue=1.0 是默认配置，不需要特殊设置
- 如果未来需要 Reversed-Z（3D Globe 包），只需改投影矩阵 + depthCompare + depthClearValue
