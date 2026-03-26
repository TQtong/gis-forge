# GIS-Forge 3D Globe 渲染管线完整实现设计 v2

> 基于 CesiumJS / MapLibre Globe 架构
> 与 2.5D Pipeline v2 共享 WebGPU 管线
> 20 项审计缺陷全量修复

---

## 零、总览与差异

```
用户状态                 渲染管线                                  屏幕
┌──────────────┐   ┌─────────────────────────────────────┐   ┌────────┐
│ center [lng,lat]│   │ ① WGS84 椭球体 + 坐标转换          │   │        │
│ zoom  (float) │   │ ② 相机模型 computeCamera3D()        │   │        │
│ pitch (rad)   │──→│ ③ 曲面细分 tessellateGlobeTile()    │──→│ 像素   │
│ bearing (rad) │   │ ④ Horizon + Frustum Culling          │   │        │
│ fov   (rad)   │   │ ⑤ GPU: 对数深度 + RTE + 大气 + 天空  │   │        │
└──────────────┘   │ ⑥ 2D↔3D morph（坐标系归一化）        │   │        │
                   └─────────────────────────────────────┘   └────────┘
```

| 维度 | 2.5D | 3D Globe |
|------|------|----------|
| 地球模型 | 平面 z=0 | WGS84 椭球体 |
| 坐标系 | 墨卡托世界像素 | ECEF（地心地固） |
| 瓦片几何 | 4 顶点平面 | NxN 曲面网格 |
| 深度范围 | ~1:2000 | ~1:14,000,000 → **对数深度** |
| 精度 | 相机相对坐标 | **RTE (Relative to Eye)** |
| 裁剪 | Frustum | Frustum **+** Horizon |
| 极地 | 无 | 退化三角形处理 |

---

## 一、坐标系与转换

```typescript
const WGS84 = {
  a: 6378137.0,
  b: 6356752.314245179,
  f: 1 / 298.257223563,
  e2: 0.00669437999014,   // (a²-b²)/a²
  circumference: 2 * Math.PI * 6378137.0,  // 赤道周长 ≈ 40,075,016 m
} as const;

/** 大地坐标 → ECEF（结果为 Float64 number[]） */
function geodeticToECEF(lng: number, lat: number, h: number): [number, number, number] {
  const lr = lng * Math.PI / 180, br = lat * Math.PI / 180;
  const sb = Math.sin(br), cb = Math.cos(br);
  const sl = Math.sin(lr), cl = Math.cos(lr);
  const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * sb * sb);
  return [(N + h) * cb * cl, (N + h) * cb * sl, (N * (1 - WGS84.e2) + h) * sb];
}

/** ECEF → 大地坐标（Bowring 3 次迭代） */
function ecefToGeodetic(x: number, y: number, z: number): [number, number, number] {
  const lng = Math.atan2(y, x) * 180 / Math.PI;
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - WGS84.e2));
  for (let i = 0; i < 3; i++) {
    const s = Math.sin(lat);
    const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * s * s);
    lat = Math.atan2(z + WGS84.e2 * N * s, p);
  }
  const s = Math.sin(lat);
  const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * s * s);
  const h = p / Math.cos(lat) - N;
  return [lng, lat * 180 / Math.PI, h];
}

/** 椭球面法线 */
function ellipsoidNormal(lng: number, lat: number): [number, number, number] {
  const lr = lng * Math.PI / 180, br = lat * Math.PI / 180;
  const cb = Math.cos(br);
  return [cb * Math.cos(lr), cb * Math.sin(lr), Math.sin(br)];
}

/** ENU → ECEF 旋转矩阵 (3x3 列向量 in 4x4) */
function enuToECEFMatrix(lng: number, lat: number): Float32Array {
  const lr = lng * Math.PI / 180, br = lat * Math.PI / 180;
  const sl = Math.sin(lr), cl = Math.cos(lr);
  const sb = Math.sin(br), cb = Math.cos(br);
  const m = new Float32Array(16);
  // East     North              Up
  m[0]=-sl;  m[4]=-sb*cl;  m[8] =cb*cl;  m[12]=0;
  m[1]= cl;  m[5]=-sb*sl;  m[9] =cb*sl;  m[13]=0;
  m[2]= 0;   m[6]= cb;     m[10]=sb;     m[14]=0;
  m[3]= 0;   m[7]= 0;      m[11]=0;      m[15]=1;
  return m;
}

function vec3Length(v: number[]): number { return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function vec3Sub(a: number[], b: number[]): [number,number,number] { return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function vec3Dot(a: number[], b: number[]): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

/** 大圆距离（Haversine，单位：米） */
function greatCircleDistance(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const r1 = lat1*Math.PI/180, r2 = lat2*Math.PI/180;
  const dl = (lat2-lat1)*Math.PI/180, dg = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dl/2)**2 + Math.cos(r1)*Math.cos(r2)*Math.sin(dg/2)**2;
  return 2 * WGS84.a * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/** 经度 → 瓦片 X */
function lngToTileX(lng: number, z: number): number { return ((lng + 180) / 360) * (1 << z); }

/** 纬度 → 瓦片 Y */
function latToTileY(lat: number, z: number): number {
  const r = lat * Math.PI / 180;
  return ((1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2) * (1 << z);
}

/** 瓦片 Y → 纬度 */
function tileYToLat(y: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * y / (1 << z);
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}
```

---

## 二、相机模型

### 2.1 Zoom → Altitude（SSE 方式）

```typescript
/**
 * CesiumJS 的 SSE (Screen Space Error) 换算。
 * 
 * 思路：zoom=0 时一个像素覆盖的地面距离 = 赤道周长/tileSize
 *       zoom=N 时一个像素覆盖 = 赤道周长/(tileSize * 2^N)
 *       altitude 使得该像素地面距离在屏幕上恰好 = 1px
 *
 * 简化公式：altitude = C / 2^zoom
 *   C = earthCircumference / (2 * PI) ≈ 6,378,137 m
 *   （等效于从赤道上空看一个弧度对应的地面距离）
 */
const ZOOM_ALTITUDE_C = WGS84.a;  // 6,378,137 m

function zoomToAltitude(zoom: number): number {
  return ZOOM_ALTITUDE_C / Math.pow(2, zoom);
}

function altitudeToZoom(altitude: number): number {
  return Math.log2(ZOOM_ALTITUDE_C / Math.max(altitude, 1));
}
```

### 2.2 computeCamera3D

```typescript
interface Camera3DState {
  projMatrix: Float32Array;
  viewMatrix: Float32Array;     // RTE（eye 在原点）
  vpMatrix:   Float32Array;     // RTE
  inverseVP:  Float32Array;     // RTE → 屏幕
  inverseVP_ECEF: Float32Array; // ECEF → 屏幕（用于 screenToGlobe）
  nearZ: number; farZ: number;
  cameraECEF: [number, number, number];
  centerECEF: [number, number, number];
  altitude: number;
  horizonDist: number;
  center: [number, number]; zoom: number;
  pitch: number; bearing: number; fov: number;
  viewport: Viewport;
}

function computeCamera3D(
  center: [number, number], zoom: number,
  pitch: number, bearing: number, fov: number,
  viewport: Viewport,
): Camera3DState {
  const [lng, lat] = center;
  const aspect = viewport.width / viewport.height;
  const altitude = zoomToAltitude(zoom);

  // ═══ 1. Center ECEF ═══
  const centerECEF = geodeticToECEF(lng, lat, 0);

  // ═══ 2. 相机位置（始终经过 ENU 旋转，pitch=0 + bearing≠0 也正确）═══
  const enuMat = enuToECEFMatrix(lng, lat);
  const offsetBack = Math.sin(pitch) * altitude;
  const camHeight  = Math.cos(pitch) * altitude;

  // ENU 偏移（bearing 旋转 + pitch 后退）
  const enuOff = [
    -Math.sin(bearing) * offsetBack,
    -Math.cos(bearing) * offsetBack,
    camHeight,
  ];

  // ENU → ECEF
  const camECEF: [number, number, number] = [
    centerECEF[0] + enuMat[0]*enuOff[0] + enuMat[4]*enuOff[1] + enuMat[8]*enuOff[2],
    centerECEF[1] + enuMat[1]*enuOff[0] + enuMat[5]*enuOff[1] + enuMat[9]*enuOff[2],
    centerECEF[2] + enuMat[2]*enuOff[0] + enuMat[6]*enuOff[1] + enuMat[10]*enuOff[2],
  ];

  // ═══ 3. 地平线距离 ═══
  const R = vec3Length(centerECEF);
  const d = vec3Length(camECEF);
  const horizonDist = d > R ? Math.sqrt(d * d - R * R) : altitude;

  // ═══ 4. Near/Far（对数深度辅助） ═══
  const nearZ = Math.max(altitude * 0.001, 0.5);
  const farZ  = horizonDist * 2.0 + altitude;

  // ═══ 5. Projection（标准透视 + 对数深度在着色器中实现）═══
  const projMatrix = new Float32Array(16);
  mat4_perspectiveZO(projMatrix, fov, aspect, nearZ, farZ);

  // ═══ 6. View Matrix（ECEF 绝对坐标版——用于 screenToGlobe）═══
  const upECEF: [number, number, number] = [enuMat[4], enuMat[5], enuMat[6]]; // North
  const viewMatrix_ECEF = new Float32Array(16);
  mat4_lookAt(viewMatrix_ECEF, camECEF, centerECEF, upECEF);
  const vpMatrix_ECEF = new Float32Array(16);
  mat4_multiply(vpMatrix_ECEF, projMatrix, viewMatrix_ECEF);
  const inverseVP_ECEF = new Float32Array(16);
  mat4_invert(inverseVP_ECEF, vpMatrix_ECEF);

  // ═══ 7. View Matrix（RTE 版——用于渲染，eye=[0,0,0]）═══
  const targetRTE = vec3Sub(centerECEF, camECEF); // Float64 减法
  const viewMatrix = new Float32Array(16);
  mat4_lookAt(viewMatrix, [0, 0, 0], targetRTE, upECEF);
  const vpMatrix = new Float32Array(16);
  mat4_multiply(vpMatrix, projMatrix, viewMatrix);
  const inverseVP = new Float32Array(16);
  mat4_invert(inverseVP, vpMatrix);

  return {
    projMatrix, viewMatrix, vpMatrix, inverseVP, inverseVP_ECEF,
    nearZ, farZ, cameraECEF: camECEF, centerECEF,
    altitude, horizonDist, center, zoom, pitch, bearing, fov, viewport,
  };
}
```

### 2.3 数值验证

```
zoom=0: altitude = 6,378,137 m ≈ 6378km → 看到整个地球 ✅
zoom=10: altitude = 6,378,137/1024 ≈ 6,229 m ✅
zoom=20: altitude = 6,378,137/1,048,576 ≈ 6.08 m ✅

center=[0,0], zoom=2, pitch=0:
  altitude = 6,378,137/4 ≈ 1,594,534 m
  centerECEF = [6,378,137, 0, 0]
  camECEF = [6,378,137 + 1,594,534, 0, 0] = [7,972,671, 0, 0]
  horizonDist = √(7972671² - 6378137²) ≈ 4,781,000 m
  farZ ≈ 11,156,534 m
```

---

## 三、瓦片曲面细分

### 3.1 细分策略（基于弧度角）

```typescript
/** 根据瓦片覆盖的角跨度决定细分段数（非 zoom 级别） */
function getSegments(tileZ: number): number {
  // 每个瓦片覆盖的纬度弧度跨度（赤道处最大）
  const angularSpanDeg = 180 / (1 << tileZ);  // 每瓦片覆盖的纬度度数

  if (angularSpanDeg > 45)  return 64;  // z=0~1: 90°~180° → 64 段
  if (angularSpanDeg > 10)  return 32;  // z=2~4: 11°~45° → 32 段
  if (angularSpanDeg > 2)   return 16;  // z=5~6: 2.8°~5.6° → 16 段
  if (angularSpanDeg > 0.5) return 8;   // z=7~8: 0.7°~1.4° → 8 段
  return 4;                              // z=9+: < 0.35° → 4 段（几乎平面）
}
```

### 3.2 网格生成（Float64 存储 + 极地退化处理）

```typescript
interface GlobeTileMesh {
  /** ECEF 坐标，Float64（CPU 精度），RTE 时再转 Float32 */
  positions: Float64Array;
  normals:   Float32Array;
  uvs:       Float32Array;
  indices:   Uint32Array;
  vertexCount: number;
  indexCount:  number;
  boundingSphere: { center: [number,number,number]; radius: number };
}

function tessellateGlobeTile(z: number, x: number, y: number, segments: number): GlobeTileMesh {
  const numTiles = 1 << z;
  const lngMin = (x / numTiles) * 360 - 180;
  const lngMax = ((x + 1) / numTiles) * 360 - 180;
  const latMax = tileYToLat(y, z);
  const latMin = tileYToLat(y + 1, z);

  const n1 = segments + 1;
  const vertexCount = n1 * n1;
  const positions = new Float64Array(vertexCount * 3);  // ★ Float64
  const normals   = new Float32Array(vertexCount * 3);
  const uvs       = new Float32Array(vertexCount * 2);

  let bsX = 0, bsY = 0, bsZ = 0;

  for (let row = 0; row <= segments; row++) {
    const v = row / segments;
    const lat = latMax + (latMin - latMax) * v;
    for (let col = 0; col <= segments; col++) {
      const u = col / segments;
      const lng = lngMin + (lngMax - lngMin) * u;
      const idx = row * n1 + col;

      const [ex, ey, ez] = geodeticToECEF(lng, lat, 0);
      positions[idx*3] = ex; positions[idx*3+1] = ey; positions[idx*3+2] = ez;

      const [nx, ny, nz] = ellipsoidNormal(lng, lat);
      normals[idx*3] = nx; normals[idx*3+1] = ny; normals[idx*3+2] = nz;

      uvs[idx*2] = u; uvs[idx*2+1] = v;
      bsX += ex; bsY += ey; bsZ += ez;
    }
  }

  bsX /= vertexCount; bsY /= vertexCount; bsZ /= vertexCount;
  let bsRadius = 0;
  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i*3]-bsX, dy = positions[i*3+1]-bsY, dz = positions[i*3+2]-bsZ;
    bsRadius = Math.max(bsRadius, Math.sqrt(dx*dx+dy*dy+dz*dz));
  }

  // ═══ 极地退化三角形处理 ═══
  // 北极（y=0）：第一行所有顶点共享同一个极点
  // 南极（y=numTiles-1）：最后一行共享同一个极点
  // → 用扇形三角形替代退化的矩形
  const isNorthPole = (y === 0);
  const isSouthPole = (y === numTiles - 1);

  let indices: Uint32Array;
  let indexCount: number;

  if (isNorthPole || isSouthPole) {
    // 极地行用扇形，其余行正常
    const normalRows = segments - 1;
    indexCount = segments * 3 + normalRows * segments * 6; // 扇形 + 正常行
    indices = new Uint32Array(indexCount);
    let ii = 0;

    if (isNorthPole) {
      // 第一行 → 扇形（顶点 0 为极点，扇形连接第二行）
      for (let col = 0; col < segments; col++) {
        indices[ii++] = 0;            // 极点（所有列共享同一位置）
        indices[ii++] = n1 + col;
        indices[ii++] = n1 + col + 1;
      }
      // 剩余行正常
      for (let row = 1; row < segments; row++) {
        for (let col = 0; col < segments; col++) {
          const tl = row * n1 + col, tr = tl + 1;
          const bl = (row+1) * n1 + col, br = bl + 1;
          indices[ii++]=tl; indices[ii++]=bl; indices[ii++]=tr;
          indices[ii++]=tr; indices[ii++]=bl; indices[ii++]=br;
        }
      }
    } else {
      // 正常行
      for (let row = 0; row < segments - 1; row++) {
        for (let col = 0; col < segments; col++) {
          const tl = row * n1 + col, tr = tl + 1;
          const bl = (row+1) * n1 + col, br = bl + 1;
          indices[ii++]=tl; indices[ii++]=bl; indices[ii++]=tr;
          indices[ii++]=tr; indices[ii++]=bl; indices[ii++]=br;
        }
      }
      // 最后一行 → 扇形
      const lastRow = segments;
      const poleIdx = lastRow * n1; // 极点
      for (let col = 0; col < segments; col++) {
        indices[ii++] = (lastRow-1) * n1 + col;
        indices[ii++] = poleIdx;
        indices[ii++] = (lastRow-1) * n1 + col + 1;
      }
    }
    indexCount = ii;
    indices = indices.slice(0, ii);
  } else {
    // 非极地：标准网格
    indexCount = segments * segments * 6;
    indices = new Uint32Array(indexCount);
    let ii = 0;
    for (let row = 0; row < segments; row++) {
      for (let col = 0; col < segments; col++) {
        const tl = row*n1+col, tr = tl+1, bl = (row+1)*n1+col, br = bl+1;
        indices[ii++]=tl; indices[ii++]=bl; indices[ii++]=tr;
        indices[ii++]=tr; indices[ii++]=bl; indices[ii++]=br;
      }
    }
  }

  return { positions, normals, uvs, indices, vertexCount, indexCount,
    boundingSphere: { center: [bsX,bsY,bsZ], radius: bsRadius } };
}
```

### 3.3 RTE 顶点转换（Float64 → Float32）

```typescript
/** CPU 侧 Float64 减法，输出 Float32 用于 GPU */
function meshToRTE(mesh: GlobeTileMesh, camECEF: [number,number,number]): Float32Array {
  const n = mesh.vertexCount;
  const out = new Float32Array(n * 8); // relX,relY,relZ, nx,ny,nz, u,v
  for (let i = 0; i < n; i++) {
    // ★ Float64 减法（JS number = Float64）
    out[i*8]   = mesh.positions[i*3]   - camECEF[0];
    out[i*8+1] = mesh.positions[i*3+1] - camECEF[1];
    out[i*8+2] = mesh.positions[i*3+2] - camECEF[2];
    out[i*8+3] = mesh.normals[i*3];
    out[i*8+4] = mesh.normals[i*3+1];
    out[i*8+5] = mesh.normals[i*3+2];
    out[i*8+6] = mesh.uvs[i*2];
    out[i*8+7] = mesh.uvs[i*2+1];
  }
  return out;
}
```

---

## 四、瓦片覆盖 + Horizon + Frustum 双裁剪

### 4.1 screenToGlobe（射线-椭球体求交）

```typescript
/** 屏幕坐标 → 椭球面经纬度。用 ECEF 版 inverseVP。 */
function screenToGlobe(sx: number, sy: number, camera: Camera3DState): [number,number] | null {
  const { inverseVP_ECEF, viewport } = camera;
  const nx = (sx / viewport.width) * 2 - 1;
  const ny = 1 - (sy / viewport.height) * 2;

  const a4 = transformVec4(inverseVP_ECEF, [nx, ny, 0, 1]);
  const b4 = transformVec4(inverseVP_ECEF, [nx, ny, 1, 1]);
  const near = [a4[0]/a4[3], a4[1]/a4[3], a4[2]/a4[3]];
  const far  = [b4[0]/b4[3], b4[1]/b4[3], b4[2]/b4[3]];
  const dir = [far[0]-near[0], far[1]-near[1], far[2]-near[2]];

  // 射线-椭球体：(x/a)²+(y/a)²+(z/b)²=1
  const ia2 = 1/(WGS84.a*WGS84.a), ib2 = 1/(WGS84.b*WGS84.b);
  const A = dir[0]*dir[0]*ia2 + dir[1]*dir[1]*ia2 + dir[2]*dir[2]*ib2;
  const B = 2*(near[0]*dir[0]*ia2 + near[1]*dir[1]*ia2 + near[2]*dir[2]*ib2);
  const C = near[0]*near[0]*ia2 + near[1]*near[1]*ia2 + near[2]*near[2]*ib2 - 1;
  const disc = B*B - 4*A*C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2*A);
  if (t < 0) return null;

  const [lng, lat] = ecefToGeodetic(near[0]+t*dir[0], near[1]+t*dir[1], near[2]+t*dir[2]);
  return [lng, lat];
}
```

### 4.2 Horizon Cull（方向修正）

```typescript
/**
 * 瓦片是否在地平线以上（可见面）。
 * 
 * 原理：相机到瓦片中心的向量 与 瓦片法线 的点积。
 *   法线从地心指向外 → dot(camToTile, normal)
 *   如果 dot > 0：瓦片表面法线朝"远离相机"方向 → 背面
 *   如果 dot < 0：瓦片表面法线朝"面向相机"方向 → 正面（可见）
 */
function isTileVisible_Horizon(
  tx: number, ty: number, tz: number, camera: Camera3DState,
): boolean {
  const numTiles = 1 << tz;
  const lng = (tx + 0.5) / numTiles * 360 - 180;
  const lat = tileYToLat(ty + 0.5, tz);
  const tileECEF = geodeticToECEF(lng, lat, 0);
  const normal = ellipsoidNormal(lng, lat);

  // 从相机到瓦片的向量
  const camToTile = vec3Sub(tileECEF, camera.cameraECEF);
  const dot = vec3Dot(camToTile, normal);

  // 大瓦片需要余量（边缘可能跨越地平线）
  const tileAngularRadius = Math.PI / numTiles;
  const margin = Math.sin(tileAngularRadius) * WGS84.a;

  // dot < margin → 法线朝向相机一侧 → 可见
  return dot < margin;
}
```

### 4.3 Frustum Cull（包围球 vs 视锥体）

```typescript
function isTileVisible_Frustum(
  mesh: GlobeTileMesh, camera: Camera3DState,
): boolean {
  const { center, radius } = mesh.boundingSphere;
  const planes = extractFrustumPlanes(camera.vpMatrix);

  for (const p of planes) {
    // 包围球中心到平面的距离（RTE 坐标）
    const cx = center[0] - camera.cameraECEF[0];
    const cy = center[1] - camera.cameraECEF[1];
    const cz = center[2] - camera.cameraECEF[2];
    const dist = p[0]*cx + p[1]*cy + p[2]*cz + p[3];
    if (dist < -radius) return false; // 完全在平面外
  }
  return true;
}
```

### 4.4 coveringTilesGlobe

```typescript
function coveringTilesGlobe(camera: Camera3DState): TileID[] {
  const tileZoom = Math.floor(camera.zoom);
  const numTiles = 1 << tileZoom;

  // ═══ 步骤 1：屏幕边缘投射到椭球面 ═══
  const { viewport } = camera;
  const W = viewport.width, H = viewport.height;
  const pts: [number,number][] = [];
  for (let i = 0; i <= 8; i++) { pts.push([W*i/8, 0]); pts.push([W*i/8, H]); }
  for (let i = 1; i <= 7; i++) { pts.push([0, H*i/8]); pts.push([W, H*i/8]); }
  pts.push([W/2, H/2]);
  // 额外：内部网格点（高 pitch 时需要更多采样）
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
    pts.push([W*i/4, H*j/4]);
  }

  const hits: [number,number][] = [];
  for (const [sx, sy] of pts) {
    const h = screenToGlobe(sx, sy, camera);
    if (h) hits.push(h);
  }
  if (hits.length === 0) return [];

  // ═══ 步骤 2：经纬度范围 → 瓦片范围 ═══
  let mnLng = Infinity, mxLng = -Infinity, mnLat = Infinity, mxLat = -Infinity;
  for (const [lng, lat] of hits) {
    mnLng = Math.min(mnLng, lng); mxLng = Math.max(mxLng, lng);
    mnLat = Math.min(mnLat, lat); mxLat = Math.max(mxLat, lat);
  }
  // 跨日期变更线
  if (mxLng - mnLng > 180) { mnLng = -180; mxLng = 180; }

  const minTX = Math.max(0, Math.floor(lngToTileX(mnLng, tileZoom)));
  const maxTX = Math.min(numTiles-1, Math.ceil(lngToTileX(mxLng, tileZoom)));
  const minTY = Math.max(0, Math.floor(latToTileY(mxLat, tileZoom)));
  const maxTY = Math.min(numTiles-1, Math.ceil(latToTileY(mnLat, tileZoom)));

  // ═══ 步骤 3：枚举 + Horizon + LOD ═══
  const tiles: TileID[] = [];
  const seen = new Set<string>();
  const [clng, clat] = camera.center;

  for (let y = minTY; y <= maxTY; y++) {
    for (let x = minTX; x <= maxTX; x++) {
      if (!isTileVisible_Horizon(x, y, tileZoom, camera)) continue;

      const tlng = (x+0.5)/numTiles*360-180;
      const tlat = tileYToLat(y+0.5, tileZoom);
      const dist = greatCircleDistance(clng, clat, tlng, tlat);
      const lodDrop = Math.min(Math.floor(Math.log2(Math.max(1, dist/500000))), 4);
      const z = Math.max(0, tileZoom - lodDrop);
      const shift = tileZoom - z;
      const px = x >> shift, py = y >> shift;
      const key = `${z}/${px}/${py}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push({ z, x: px, y: py, key, distToCamera: dist });
    }
  }

  // 上限
  if (tiles.length > 300) {
    tiles.sort((a,b) => a.distToCamera - b.distToCamera);
    tiles.length = 300;
  }

  return tiles;
}
```

---

## 五、GPU Pipeline + 对数深度 + 大气

### 5.1 CameraUniforms（修正对齐）

```wgsl
struct CameraUniforms {
  vpMatrix:       mat4x4<f32>,  // 64 bytes, offset 0
  cameraPosition: vec3<f32>,    // 12 bytes, offset 64
  altitude:       f32,          //  4 bytes, offset 76
  sunDirection:   vec3<f32>,    // 12 bytes, offset 80
  logDepthBufFC:  f32,          //  4 bytes, offset 92
  // 总 96 bytes = 6 × 16 ✅
};
```

### 5.2 对数深度（解决 nearZ=0.5m farZ=14,000,000m）

```
标准 Z 深度：近处精度 = near * far / (far - near)²
  near=0.5, far=14e6 → 精度 ≈ 2.5e-15 → 完全无用

对数深度：depth = log2(z+1) / log2(far+1)
  分辨率在整个深度范围内均匀分布
  近处 z=0.5m 和远处 z=14000km 的深度精度接近
```

```wgsl
// 在顶点着色器末尾：
fn applyLogDepth(clipPos: vec4<f32>, logDepthBufFC: f32) -> vec4<f32> {
  var pos = clipPos;
  // w > 0 时的对数深度
  let logZ = log2(max(1e-6, pos.w + 1.0)) * logDepthBufFC;
  pos.z = logZ * pos.w;  // 写入 z，后续硬件做 z/w 得到 depth
  return pos;
}

// logDepthBufFC = 2.0 / log2(farZ + 1.0)
// 在 CPU 计算并传入 uniform
```

### 5.3 Globe Tile Shader

```wgsl
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var tileSampler: sampler;
@group(1) @binding(1) var tileTexture: texture_2d<f32>;
@group(2) @binding(0) var<uniform> tile: TileParams;

struct VsIn {
  @location(0) posRTE:  vec3<f32>,  // RTE 坐标（已减去相机）
  @location(1) normal:  vec3<f32>,
  @location(2) uv:      vec2<f32>,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv:      vec2<f32>,
  @location(1) normal:  vec3<f32>,
  @location(2) viewDir: vec3<f32>,
};

@vertex fn globe_vs(in: VsIn) -> VsOut {
  var out: VsOut;
  var clip = camera.vpMatrix * vec4<f32>(in.posRTE, 1.0);
  out.clipPos = applyLogDepth(clip, camera.logDepthBufFC);
  out.uv = tile.uvOffset + in.uv * tile.uvScale;
  out.normal = in.normal;
  out.viewDir = -normalize(in.posRTE); // 从顶点指向相机
  return out;
}

@fragment fn globe_fs(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);

  // 大气散射：法线与视线的点积
  let nDotV = max(dot(normalize(in.normal), in.viewDir), 0.0);
  let atmoFactor = smoothstep(0.0, 0.15, nDotV);
  let atmoColor = vec4<f32>(0.4, 0.6, 1.0, 1.0);
  color = mix(atmoColor, color, atmoFactor);

  return color;
}
```

### 5.4 天空穹顶（用 inverseVP 射线方向）

```wgsl
struct SkyUniforms {
  inverseVP: mat4x4<f32>,  // 64 bytes
  altitude:  f32,           //  4 bytes
  _pad:      vec3<f32>,     // 12 bytes → 80 bytes total
};
@group(0) @binding(0) var<uniform> sky: SkyUniforms;

@vertex fn sky_vs(@builtin(vertex_index) i: u32) -> SkyVsOut {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  let ndc = uv * 2.0 - 1.0;

  var out: SkyVsOut;
  out.pos = vec4<f32>(ndc, 0.9999, 1.0);

  // ★ 用 inverseVP 反投影得到正确的射线方向
  let worldFar  = sky.inverseVP * vec4<f32>(ndc, 1.0, 1.0);
  let worldNear = sky.inverseVP * vec4<f32>(ndc, 0.0, 1.0);
  let rayDir = (worldFar.xyz / worldFar.w) - (worldNear.xyz / worldNear.w);
  out.rayDir = normalize(rayDir);
  return out;
}

@fragment fn sky_fs(in: SkyVsOut) -> @location(0) vec4<f32> {
  let up = normalize(vec3<f32>(0.0, 0.0, 1.0)); // ECEF Z 轴
  let cosAngle = dot(in.rayDir, up);
  let t = smoothstep(-0.1, 0.3, cosAngle);

  let horizonColor = vec3<f32>(0.7, 0.85, 1.0);
  let zenithColor  = vec3<f32>(0.1, 0.3, 0.8);
  let spaceColor   = vec3<f32>(0.01, 0.01, 0.03);

  var sky = mix(horizonColor, zenithColor, t);
  let altNorm = clamp(sky.altitude / 500000.0, 0.0, 1.0);
  sky = mix(sky, spaceColor, altNorm * altNorm);
  return vec4<f32>(sky, 1.0);
}
```

### 5.5 渲染顺序 + Backface Culling

```typescript
const globePipeline = device.createRenderPipeline({
  // ...
  primitive: {
    topology: 'triangle-list',
    cullMode: 'back',  // ★ 地球背面三角形直接剔除，不进 fragment shader
    frontFace: 'ccw',
  },
  depthStencil: {
    format: 'depth32float',   // 对数深度需要更高精度
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  },
});

// 渲染顺序：
// Pass 1: Sky dome（depth=0.9999，写 depth）
// Pass 2: Globe tiles（对数深度，depth test，backface cull）
// Pass 3: Atmosphere halo（additive blend，无 depth write）
```

---

## 六、2D ↔ 3D 过渡（坐标归一化 Morph）

### 6.1 坐标归一化（解决直接 mix 的问题）

```
v1 的 bug：直接 mix(flatPos, globePos, morphFactor)
  flatPos 在墨卡托世界像素空间（值 ~262144）
  globePos 在 ECEF 空间（值 ~6,378,137）
  mix 出的中间值完全无意义

v2 方案：两套坐标都归一化到以 center 为原点的相对空间
  flatPosRel  = flatPos - flatCenter    (2.5D 相对坐标)
  globePosRel = globePos - cameraECEF   (RTE 坐标)
  mix 的是两个同量级的相对值
```

```typescript
function computeMorphFactor(zoom: number): number {
  const START = 5.0, END = 3.0;
  if (zoom >= START) return 0;
  if (zoom <= END)   return 1;
  return 1 - (zoom - END) / (START - END);
}

/**
 * 为 morph 过渡生成双坐标顶点。
 * 两套坐标都是相对坐标，数值量级相近（±几千）。
 */
function computeMorphVertices(
  tile: TileID,
  worldSize2D: number, centerWorld2D: [number, number],
  cameraECEF: [number, number, number],
  segments: number,
): Float32Array {
  const n1 = segments + 1;
  const numTiles = 1 << tile.z;
  const tileSize2D = worldSize2D / numTiles;
  const lngMin = (tile.x / numTiles) * 360 - 180;
  const lngMax = ((tile.x+1) / numTiles) * 360 - 180;
  const latMax = tileYToLat(tile.y, tile.z);
  const latMin = tileYToLat(tile.y + 1, tile.z);

  // 11 floats/vertex: flatRel(3) + globeRel(3) + normal(3) + uv(2)
  const out = new Float32Array(n1 * n1 * 11);
  for (let row = 0; row <= segments; row++) {
    const v = row / segments;
    const lat = latMax + (latMin - latMax) * v;
    for (let col = 0; col <= segments; col++) {
      const u = col / segments;
      const lng = lngMin + (lngMax - lngMin) * u;
      const idx = (row * n1 + col) * 11;

      // 2.5D 相对坐标
      const mx = ((lng + 180) / 360) * worldSize2D - centerWorld2D[0];
      const sinLat = Math.sin(lat * Math.PI / 180);
      const my = (0.5 - Math.log((1+sinLat)/(1-sinLat))/(4*Math.PI)) * worldSize2D - centerWorld2D[1];
      out[idx] = mx; out[idx+1] = my; out[idx+2] = 0;

      // 3D RTE 坐标
      const [ex, ey, ez] = geodeticToECEF(lng, lat, 0);
      out[idx+3] = ex - cameraECEF[0];
      out[idx+4] = ey - cameraECEF[1];
      out[idx+5] = ez - cameraECEF[2];

      // 法线
      const [nx, ny, nz] = ellipsoidNormal(lng, lat);
      out[idx+6] = nx; out[idx+7] = ny; out[idx+8] = nz;

      // UV
      out[idx+9] = u; out[idx+10] = v;
    }
  }
  return out;
}
```

```wgsl
struct MorphUniforms {
  morphFactor: f32,
  logDepthBufFC: f32,
  _pad: vec2<f32>,
};
@group(3) @binding(0) var<uniform> morph: MorphUniforms;

struct MorphVsIn {
  @location(0) flatPos:  vec3<f32>,
  @location(1) globePos: vec3<f32>,
  @location(2) normal:   vec3<f32>,
  @location(3) uv:       vec2<f32>,
};

@vertex fn morph_vs(in: MorphVsIn) -> VsOut {
  let pos = mix(in.flatPos, in.globePos, morph.morphFactor);
  var out: VsOut;
  var clip = camera.vpMatrix * vec4<f32>(pos, 1.0);
  // morph 过渡期间也用对数深度
  if (morph.morphFactor > 0.01) {
    clip = applyLogDepth(clip, morph.logDepthBufFC);
  }
  out.clipPos = clip;
  out.uv = tile.uvOffset + in.uv * tile.uvScale;
  out.normal = in.normal;
  return out;
}
```

---

## 七、帧循环

```typescript
function onFrame3D(state: MapState, device: GPUDevice, res: RenderResources3D) {
  const camera = computeCamera3D(
    state.center, state.zoom, state.pitch, state.bearing, state.fov, state.viewport,
  );
  const morphFactor = computeMorphFactor(state.zoom);

  // 瓦片列表（始终用对应模式的算法）
  const tiles = morphFactor > 0.5
    ? coveringTilesGlobe(camera)
    : coveringTiles(camera);  // 2.5D

  // 请求调度（复用 Tile Solutions）
  const neededKeys = new Set(tiles.map(t => t.key));
  res.scheduler.cancelStale(neededKeys);
  for (const t of tiles) {
    if (!res.cache.has(t.key)) {
      res.scheduler.request(t.key, buildTileUrl(t, res.urlTemplate), 'critical',
        (data) => { /* createTexture + cache.set */ },
        (err) => { /* handleTileResponse */ },
      );
    }
  }

  const visible = resolveVisibleTiles(tiles, res.cache);
  res.cache.pinForFrame(visible.map(v => v.id.key));

  const encoder = device.createCommandEncoder();
  const target = res.context.getCurrentTexture().createView();

  // logDepthBufFC = 2 / log2(farZ + 1)
  const logDepthBufFC = 2.0 / Math.log2(camera.farZ + 1.0);

  if (morphFactor < 0.01) {
    // 纯 2.5D
    renderFrame2D(encoder, camera, visible, device, res, target);
  } else if (morphFactor > 0.99) {
    // 纯 Globe
    renderSkyDome(encoder, camera, res, target);
    renderGlobeTiles(encoder, camera, visible, logDepthBufFC, device, res, target);
    renderAtmosphere(encoder, camera, res, target);
  } else {
    // Morph 过渡
    renderSkyDome(encoder, camera, res, target);
    renderMorphTiles(encoder, camera, visible, morphFactor, logDepthBufFC, device, res, target);
    renderAtmosphere(encoder, camera, res, target);
  }

  res.surface.retainFrame(device, encoder, res.context.getCurrentTexture());
  device.queue.submit([encoder.finish()]);
}
```

---

## 八、排查清单 v2

```
□ 1. geodeticToECEF 验证
     (0,0,0) → [6378137, 0, 0]
     (0,90,0) → [0, 0, 6356752]
     (90,0,0) → [0, 6378137, 0]

□ 2. altitude 验证
     zoom=0 → ≈6378km   zoom=10 → ≈6229m   zoom=20 → ≈6.08m

□ 3. screenToGlobe 验证
     屏幕中心 → ≈ center 经纬度
     屏幕角落（低 zoom）→ 合理经纬度或 null（太空）

□ 4. 对数深度验证
     近处 z=1m 和远处 z=14000km 都能正确渲染（无 z-fighting）
     depthStencil format = depth32float

□ 5. RTE 精度验证
     zoom=18 → 顶点 RTE 值应在 ±5000 范围
     如果 > 100000 → 减法精度问题

□ 6. Horizon Cull 验证
     太空视角 → 地球背面瓦片不应加载
     旋转地球 → 刚露出的瓦片立即加载

□ 7. 极地瓦片验证
     zoom=0 看北极 → 无零面积三角形闪烁

□ 8. Morph 验证
     zoom=5 → morphFactor=0（纯 2.5D）
     zoom=3 → morphFactor=1（纯 Globe）
     zoom=4 → 过渡中，瓦片不跳变

□ 9. Backface Culling
     cullMode='back' → 地球背面三角形不渲染

□ 10. 天空射线方向
      旋转相机 → 天空颜色随视角正确变化（用 inverseVP 而非固定方向）
```

---

## 九、与现有文档对接

| 模块 | 对接方式 |
|------|---------|
| **2.5D Pipeline** | 共享 mat4 库、WebGPU Pipeline 创建、TileParams uniform |
| **Tile Solutions §1** | resolveVisibleTiles 直接复用（父瓦片占位） |
| **Tile Solutions §2** | RequestScheduler 直接复用 |
| **Tile Solutions §3** | TileCache 直接复用 |
| **Overzoom Solutions** | resolveTile + AncestorProber 直接复用 |
| **Cursor Rules** | 新增：3D 模式仍然是 WebGPU，不是 Three.js |

### 新增包

```
@gis-forge/wgs84               → 椭球体常量 + 坐标转换
@gis-forge/camera-3d            → computeCamera3D + screenToGlobe
@gis-forge/globe-tessellation   → tessellateGlobeTile + meshToRTE + 极地处理
@gis-forge/globe-culling        → coveringTilesGlobe + horizon + frustum cull
@gis-forge/atmosphere           → sky dome + atmosphere halo
@gis-forge/morph                → 2D↔3D morph + 归一化坐标
@gis-forge/log-depth            → 对数深度 uniform 计算 + WGSL 函数
```
