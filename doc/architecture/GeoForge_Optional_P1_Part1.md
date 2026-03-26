# GIS-Forge 可选功能包完整接口设计 — P1 核心 3D 包（上）

> layer-terrain / globe
> 质量标准与 P0 一致：每个字段有注释+范围+默认值、每个方法有参数+算法步骤、
> 每个数据流有完整管线、每个错误有场景+错误码、每个对接有方向+模块+方式、
> 非功能性全覆盖（ObjectPool/__DEV__/@stability/InternalBus/GeoForgeError/GPU走L1/out参数/列主序/Tree-Shaking）。

---

## 1. @gis-forge/layer-terrain

### 1.1 类型依赖

```typescript
import type { Layer, LayerContext } from '@gis-forge/scene';
import type { CameraState, TileCoord, BBox2D, Viewport, Vec3f, Mat4f } from '@gis-forge/core';
import type { BufferHandle, TextureHandle } from '@gis-forge/gpu';
import type { TileScheduleResult } from '@gis-forge/runtime';
import type { InternalBus } from '@gis-forge/core/infra/internal-bus';
import type { GeoForgeError, GeoForgeErrorCode } from '@gis-forge/core/infra/errors';
import type { ObjectPool } from '@gis-forge/core/infra/object-pool';
```

### 1.2 TerrainLayerOptions

```typescript
export interface TerrainLayerOptions {
  /**
   * DEM 数据源 ID（已在 SourceManager 中注册的 raster-dem 源）。
   * 支持 Mapbox Terrain RGB 和 Terrarium 编码。
   */
  readonly source: string;

  /**
   * 高程夸大系数。
   * 1.0 = 真实高度，2.0 = 高度翻倍（视觉强调地形起伏）。
   * @range [0, 100]
   * @default 1.0
   */
  readonly exaggeration?: number;

  /**
   * 每个瓦片的网格分辨率。
   * 顶点数 = (resolution + 1)²。
   * 32 → 1089 顶点/瓦片，64 → 4225 顶点/瓦片。
   * 值越大地形越精细，但 GPU 负载越高。
   * @range [8, 128]，必须是 2 的幂
   * @default 32
   */
  readonly meshResolution?: number;

  /**
   * DEM 编码方式。
   * 'mapbox':    height = -10000 + (R×65536 + G×256 + B) × 0.1
   * 'terrarium': height = (R×256 + G + B/256) - 32768
   * @default 'mapbox'
   */
  readonly encoding?: 'mapbox' | 'terrarium';

  /**
   * 裙边高度（米）。
   * 裙边是瓦片四边向下延伸的三角形条带，用于遮挡不同 LOD 瓦片之间的裂缝。
   * 'auto' = 根据网格分辨率和 zoom 自动计算。
   * @unit 米
   * @default 'auto'
   */
  readonly skirtHeight?: number | 'auto';

  /**
   * LOD Morphing 过渡开关。
   * 启用后，瓦片 LOD 切换时顶点高度平滑过渡，避免突跳。
   * @default true
   */
  readonly enableMorphing?: boolean;

  /**
   * Morphing 过渡范围。
   * 在此比例范围内，当前 LOD 和父级 LOD 的高度进行 lerp 混合。
   * 0.3 = 在 SSE 阈值的 70%~100% 范围内混合。
   * @range (0, 1)
   * @default 0.3
   */
  readonly morphRange?: number;

  /**
   * 地形光照开关。
   * 启用后使用法线纹理做简单 Diffuse 光照（增强地形立体感）。
   * @default true
   */
  readonly enableLighting?: boolean;

  readonly minzoom?: number;
  readonly maxzoom?: number;
}
```

### 1.3 内部数据结构

```typescript
/**
 * 单个地形瓦片的 GPU 渲染数据。
 */
interface TerrainTileRenderData {
  /** 瓦片坐标 */
  readonly coord: TileCoord;
  /** 顶点缓冲：[x, y, z, nx, ny, nz, u, v] × (resolution+1)² + 裙边顶点 */
  readonly vertexBuffer: BufferHandle;
  /** 索引缓冲：三角形索引 Uint32Array */
  readonly indexBuffer: BufferHandle;
  /** 三角形数量（含裙边） */
  readonly triangleCount: number;
  /** 高程纹理（R32F 格式，用于其他图层采样） */
  readonly elevationTexture: TextureHandle;
  /** 法线纹理（RGBA8，用于光照） */
  readonly normalTexture: TextureHandle;
  /** 该瓦片的高程范围 [min, max]（米），用于视锥剔除优化 */
  readonly heightRange: [number, number];
  /** 该瓦片的地理范围 */
  readonly extent: BBox2D;
  /** 父级瓦片的顶点高度采样（用于 Morphing） */
  readonly parentHeights: Float32Array | null;
  /** 当前 morph 因子 [0, 1]，0 = 完全使用当前 LOD，1 = 完全使用父级 */
  morphFactor: number;
}

/**
 * DEM 解码输入参数（传入 Worker）。
 */
interface TerrainMeshBuildParams {
  /** DEM 图像像素数据（RGBA8） */
  readonly imageData: Uint8Array;
  /** DEM 图像宽高 */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** 编码方式 */
  readonly encoding: 'mapbox' | 'terrarium';
  /** 网格分辨率 */
  readonly resolution: number;
  /** 夸大系数 */
  readonly exaggeration: number;
  /** 裙边高度（米） */
  readonly skirtHeight: number;
  /** 瓦片地理范围（用于坐标转换） */
  readonly extent: BBox2D;
  /** 父级 DEM 数据（用于 Morphing 高度采样），null = 无父级 */
  readonly parentDEM: Uint8Array | null;
}

/**
 * Worker 返回的地形网格数据。
 */
interface TerrainMeshResult {
  /** 顶点数据：Float32Array [x,y,z, nx,ny,nz, u,v] × vertexCount */
  readonly vertices: Float32Array;
  /** 索引数据：Uint32Array */
  readonly indices: Uint32Array;
  /** 高程范围 [min, max] 米 */
  readonly heightRange: [number, number];
  /** 高程纹理数据：Float32Array[(resolution+1)²]（R32F 格式） */
  readonly elevationData: Float32Array;
  /** 法线纹理数据：Uint8Array[(resolution+1)² × 4]（RGBA8） */
  readonly normalData: Uint8Array;
  /** 父级高度采样：Float32Array[(resolution+1)²]（用于 Morphing） */
  readonly parentHeights: Float32Array | null;
  /** Transferable 列表 */
  readonly transferables: ArrayBuffer[];
}
```

### 1.4 TerrainLayer 公共接口

```typescript
export interface TerrainLayer extends Layer {
  readonly type: 'terrain';

  // ═══════════════════════════════════════
  // 高程查询
  // ═══════════════════════════════════════

  /**
   * 异步查询指定经纬度的地形高程。
   * 如果对应瓦片已加载，从 GPU 端高程纹理回读。
   * 如果未加载，触发加载并等待。
   *
   * @param lon - 经度（度）
   * @param lat - 纬度（度）
   * @returns 高程值（米，相对 WGS84 椭球面）。未加载且超时返回 0。
   * @throws GeoForgeError(DATA_TILE_LOAD) 如果加载失败
   *
   * @stability experimental
   *
   * 算法：
   *   1. 根据 lon/lat 和最佳 zoom 计算 TileCoord
   *   2. 查找该 TileCoord 的 TerrainTileRenderData
   *   3. 如果已加载：
   *      a. 计算 lon/lat 在瓦片内的 UV 坐标
   *      b. 从 elevationData 双线性插值获取高程
   *      c. return height * exaggeration
   *   4. 如果未加载：
   *      a. 触发 TileScheduler 优先加载该瓦片
   *      b. 等待加载完成（最长 5s 超时）
   *      c. 超时返回 0 + log.warn
   */
  getElevation(lon: number, lat: number): Promise<number>;

  /**
   * 同步查询（仅限已加载区域）。
   * 不触发加载，未加载区域返回 null。
   *
   * @stability experimental
   *
   * 算法：同上步骤 1~3，步骤 4 直接返回 null
   */
  getElevationSync(lon: number, lat: number): number | null;

  /**
   * 批量查询高程剖面。
   * 沿路径等距采样 sampleCount 个点。
   *
   * @param points - 路径点 [[lon, lat], ...]
   * @param sampleCount - 采样数量，默认 100
   * @returns 每个采样点的高程值数组
   *
   * @stability experimental
   *
   * 算法：
   *   1. 计算路径总长度（geodesic.vincentyInverse 逐段求和）
   *   2. 按 sampleCount 等距切分
   *   3. 每个采样点用 geodesic.intermediatePoint 计算经纬度
   *   4. 对每个点调用 getElevation
   */
  getElevationProfile(points: [number, number][], sampleCount?: number): Promise<number[]>;

  // ═══════════════════════════════════════
  // 配置
  // ═══════════════════════════════════════

  /**
   * 设置高程夸大系数。
   * 运行时修改会触发：
   *   1. 更新 perLayer Uniform
   *   2. 重新计算所有已加载瓦片的 heightRange
   *   3. 通知 Camera3D 重新查询地形碰撞高度
   *
   * @stability stable
   */
  setExaggeration(value: number): void;
  readonly exaggeration: number;

  /**
   * 设置网格分辨率。
   * 运行时修改会触发所有瓦片重建网格（开销大，慎用）。
   *
   * @stability experimental
   */
  setMeshResolution(resolution: number): void;

  // ═══════════════════════════════════════
  // 地形纹理（供其他图层采样）
  // ═══════════════════════════════════════

  /**
   * 获取当前可见区域的高程纹理。
   * 其他图层（VectorTileLayer 贴地、Camera3D 碰撞）通过此纹理采样高度。
   * 纹理格式：R32F，分辨率 = meshResolution+1 per tile。
   *
   * @returns TextureHandle 或 null（无地形数据时）
   *
   * @stability experimental
   */
  getElevationTexture(): TextureHandle | null;

  /**
   * 获取法线纹理（用于光照计算）。
   * 纹理格式：RGBA8，RGB = 法线 XYZ mapped to [0,1]，A = 1。
   *
   * @stability experimental
   */
  getNormalTexture(): TextureHandle | null;

  // ═══════════════════════════════════════
  // Layer 生命周期
  // ═══════════════════════════════════════

  /**
   * onAdd 步骤：
   *   1. 从 LayerContext 获取 TileScheduler / ShaderAssembler / PipelineCache / GPUUploader
   *   2. 编译 Shader：
   *      ShaderVariantKey = { projection, geometry:'terrain_mesh', style:'terrain_lit', features:['splitDouble'] }
   *      （3D 模式需要 Split-Double）
   *   3. 创建 Pipeline
   *   4. 创建 perLayer Uniform Buffer（exaggeration + lightDir + morphEnabled）
   *   5. 注册 TileScheduler（source=DEM源, tileSize=512）
   *   6. 注册 Camera3D terrainProvider：
   *      bus.on('camera:changed', () => camera3d?.setTerrainProvider(this.getElevation.bind(this)))
   *   7. 监听 InternalBus 'tile:loaded' / 'tile:evicted'
   *
   * @stability stable
   */
  onAdd(context: LayerContext): void;

  /**
   * onUpdate 步骤：
   *   1. 推进 Morphing 动画：
   *      for each tile:
   *        if (tile.morphFactor > 0 && !tile 需要 morph)
   *          tile.morphFactor = max(0, tile.morphFactor - deltaTime / morphDuration)
   *   2. 更新 Uniform（如果 exaggeration 有变化）
   *
   * @stability stable
   */
  onUpdate(deltaTime: number, camera: CameraState): void;

  /**
   * encode 渲染步骤：
   *   for each visibleTile:
   *     setPipeline(terrainPipeline)
   *     setVertexBuffer(0, tile.vertexBuffer)
   *     setIndexBuffer(tile.indexBuffer, 'uint32')
   *     setBindGroup(0, perFrame)               // 相机矩阵（via L1）
   *     setBindGroup(1, perLayer)               // exaggeration + lightDir + morphEnabled
   *     setBindGroup(2, perObject)              // tile 的 RTC center + morphFactor + parentHeights 纹理
   *     setBindGroup(3, tile.elevationTexture + tile.normalTexture + sampler)
   *     drawIndexed(tile.triangleCount * 3)
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

export function createTerrainLayer(options: TerrainLayerOptions): TerrainLayer;
```

### 1.5 DEM 解码 + 网格生成详细步骤（Worker: 'terrain-mesh'）

```
WorkerPool.submit({
  type: 'terrain-mesh',
  input: TerrainMeshBuildParams,
  transferables: [imageData.buffer]
})

Worker 内部：

═══ 步骤 1：DEM 解码 ═══

  将 RGBA8 像素 → 高程值 Float32Array[width × height]

  if (encoding === 'mapbox') {
    for (i = 0; i < pixelCount; i++) {
      R = imageData[i*4];
      G = imageData[i*4+1];
      B = imageData[i*4+2];
      height[i] = -10000.0 + (R * 65536 + G * 256 + B) * 0.1;
      // 范围：约 -10000m ~ +1667721.5m（覆盖全球高程）
    }
  } else { // terrarium
    for (i = 0; i < pixelCount; i++) {
      R = imageData[i*4];
      G = imageData[i*4+1];
      B = imageData[i*4+2];
      height[i] = (R * 256 + G + B / 256) - 32768;
      // 范围：约 -32768m ~ +32767m
    }
  }

═══ 步骤 2：网格顶点生成 ═══

  gridSize = resolution + 1      // 顶点数 per 边
  totalVertices = gridSize * gridSize
  stride = 8                     // x,y,z, nx,ny,nz, u,v

  vertices = new Float32Array(totalVertices * stride)

  for (row = 0; row < gridSize; row++) {
    for (col = 0; col < gridSize; col++) {
      // UV 坐标（瓦片内 [0, 1]）
      u = col / resolution
      v = row / resolution

      // 从 DEM 双线性插值获取高程
      demU = u * (imageWidth - 1)
      demV = v * (imageHeight - 1)
      h = bilinearSample(height, imageWidth, imageHeight, demU, demV) * exaggeration

      // 墨卡托世界坐标
      mercX = extent.west + u * (extent.east - extent.west)
      mercY = extent.south + v * (extent.north - extent.south)

      // 3D 模式：需要转为 ECEF
      // 2.5D 模式：直接使用墨卡托坐标 + 高程作为 Z
      x = mercX
      y = mercY
      z = h

      idx = (row * gridSize + col) * stride
      vertices[idx]   = x
      vertices[idx+1] = y
      vertices[idx+2] = z
      // 法线稍后计算（步骤 3）
      vertices[idx+6] = u
      vertices[idx+7] = v
    }
  }

═══ 步骤 3：法线计算（中心差分法）═══

  for (row = 0; row < gridSize; row++) {
    for (col = 0; col < gridSize; col++) {
      // 读取上下左右邻居高度（边界 clamp）
      hL = getHeight(row, max(0, col-1))
      hR = getHeight(row, min(resolution, col+1))
      hD = getHeight(max(0, row-1), col)
      hU = getHeight(min(resolution, row+1), col)

      // 中心差分求偏导
      cellWidth = (extent.east - extent.west) / resolution
      cellHeight = (extent.north - extent.south) / resolution
      dzdx = (hR - hL) / (2 * cellWidth)
      dzdy = (hU - hD) / (2 * cellHeight)

      // 法线 = normalize(cross(tangentX, tangentY))
      // tangentX = (1, 0, dzdx), tangentY = (0, 1, dzdy)
      // cross = (-dzdx, -dzdy, 1)
      len = sqrt(dzdx*dzdx + dzdy*dzdy + 1)
      nx = -dzdx / len
      ny = -dzdy / len
      nz = 1 / len

      idx = (row * gridSize + col) * stride
      vertices[idx+3] = nx
      vertices[idx+4] = ny
      vertices[idx+5] = nz
    }
  }

═══ 步骤 4：三角形索引生成 ═══

  triangleCount = resolution * resolution * 2
  indices = new Uint32Array(triangleCount * 3)
  idx = 0

  for (row = 0; row < resolution; row++) {
    for (col = 0; col < resolution; col++) {
      topLeft     = row * gridSize + col
      topRight    = topLeft + 1
      bottomLeft  = topLeft + gridSize
      bottomRight = bottomLeft + 1

      // 三角形 1（左上三角）
      indices[idx++] = topLeft
      indices[idx++] = bottomLeft
      indices[idx++] = topRight

      // 三角形 2（右下三角）
      indices[idx++] = topRight
      indices[idx++] = bottomLeft
      indices[idx++] = bottomRight
    }
  }

═══ 步骤 5：裙边生成 ═══

  裙边 = 瓦片四边每个顶点向下延伸一个副本，连接为三角形条带。

  skirtH = (skirtHeight === 'auto')
    ? (extent.north - extent.south) / resolution * 5  // 自动：5 个网格单元高度
    : skirtHeight

  skirtVertexStart = totalVertices
  for each edge in [top, right, bottom, left]:
    for each vertex V on edge:
      // 创建裙边副本（x,y 相同，z 降低 skirtH）
      skirtVertex = [V.x, V.y, V.z - skirtH, 0, 0, -1, V.u, V.v]
      // 法线朝下（裙边不参与光照）

    // 连接边缘顶点和裙边顶点为三角形条带
    for i in [0, edgeVertexCount-1):
      indices.push(edge[i], skirt[i], edge[i+1])
      indices.push(edge[i+1], skirt[i], skirt[i+1])

═══ 步骤 6：LOD 边缘约束 ═══

  相邻瓦片可能是不同 LOD（如当前瓦片 z=12，右邻 z=11）。
  高 LOD 瓦片的边缘顶点数 > 低 LOD 瓦片的边缘顶点数，
  如果不约束，公共边界上顶点不对齐会产生裂缝（T-junction）。

  约束策略：
    1. 检查四个方向的邻居 LOD（由 TileScheduler 提供）
    2. 如果某方向邻居 LOD 更低（zoom 更小）：
       该边缘每 2^(myZoom-neighborZoom) 个顶点取 1 个
       中间顶点的高度 lerp 到两端（线性插值到低 LOD 网格）
    例：当前 z=12 的右边缘有 33 个顶点，右邻 z=11 只有 17 个。
       右边缘顶点 0,2,4,...,32 保持原高度（与低 LOD 对齐的点）
       顶点 1,3,5,...,31 高度 = lerp(顶点 i-1, 顶点 i+1, 0.5)

═══ 步骤 7：Morphing 父级高度采样 ═══

  if (parentDEM !== null && enableMorphing) {
    parentHeights = new Float32Array(totalVertices)
    for each vertex at (u, v):
      // 计算该顶点在父瓦片 DEM 中的位置
      parentU = (tileX % 2 === 0) ? u * 0.5 : u * 0.5 + 0.5
      parentV = (tileY % 2 === 0) ? v * 0.5 : v * 0.5 + 0.5
      parentH = bilinearSample(parentDEM, ..., parentU, parentV)
      parentHeights[vertexIndex] = parentH * exaggeration
  }

═══ 步骤 8：输出 ═══

  生成高程纹理数据（R32F）：
    elevationData = new Float32Array(gridSize * gridSize)
    for each vertex: elevationData[i] = vertices[i * stride + 2]  // z 分量

  生成法线纹理数据（RGBA8）：
    normalData = new Uint8Array(gridSize * gridSize * 4)
    for each vertex:
      normalData[i*4]   = (nx * 0.5 + 0.5) * 255  // [-1,1] → [0,255]
      normalData[i*4+1] = (ny * 0.5 + 0.5) * 255
      normalData[i*4+2] = (nz * 0.5 + 0.5) * 255
      normalData[i*4+3] = 255

  return {
    vertices, indices, heightRange: [minH, maxH],
    elevationData, normalData, parentHeights,
    transferables: [vertices.buffer, indices.buffer, elevationData.buffer, normalData.buffer, parentHeights?.buffer].filter(Boolean)
  }
```

### 1.6 WGSL Shader

#### geometry/terrain_mesh.wgsl

```wgsl
struct TerrainPerObject {
  rtcCenterHigh: vec3<f32>,       // RTC 偏移高位
  _pad0: f32,
  rtcCenterLow: vec3<f32>,        // RTC 偏移低位
  morphFactor: f32,               // Morphing 混合因子 [0, 1]
};
@group(2) @binding(0) var<uniform> obj: TerrainPerObject;
@group(3) @binding(0) var elevationSampler: sampler;
@group(3) @binding(1) var parentHeightTex: texture_2d<f32>;

fn processVertex(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  var worldPos = input.position;

  // Morphing：在当前 LOD 高度和父级 LOD 高度之间插值
  if (obj.morphFactor > 0.0) {
    let parentH = textureSampleLevel(parentHeightTex, elevationSampler, input.uv, 0.0).r;
    worldPos.z = mix(worldPos.z, parentH, obj.morphFactor);
  }

  // Split-Double RTC 重建（3D 模式下 ECEF 坐标需要双精度）
  // 由 feature/split_double.wgsl 注入
  // worldPos = reconstructDoublePrecision(posHigh, posLow, obj.rtcCenterHigh, obj.rtcCenterLow);

  output.worldPosition = worldPos;
  output.normal = input.normal;
  output.uv = input.uv;
  output.color = vec4<f32>(1.0);  // 地形不使用 per-vertex color

  return output;
}
```

#### style/terrain_lit.wgsl

```wgsl
struct TerrainStyle {
  exaggeration: f32,
  enableLighting: f32,            // 0.0 或 1.0
  _pad: vec2<f32>,
};
@group(1) @binding(0) var<uniform> style: TerrainStyle;
@group(3) @binding(2) var normalTex: texture_2d<f32>;
@group(3) @binding(3) var normalSampler: sampler;

// 太阳方向从 GlobeRenderer 或固定默认值获取
// 通过 PerFrameUniforms 扩展字段传入（或单独的 light uniform buffer）

fn computeColor(input: FragmentInput) -> vec4<f32> {
  // 采样法线纹理
  let normalSample = textureSample(normalTex, normalSampler, input.uv);
  let normal = normalSample.rgb * 2.0 - 1.0;  // [0,1] → [-1,1]

  // 基础颜色（灰白色，后续被影像图层覆盖）
  var color = vec4<f32>(0.85, 0.85, 0.83, 1.0);

  // 简单 Lambert Diffuse 光照
  if (style.enableLighting > 0.5) {
    let lightDir = normalize(vec3<f32>(0.5, 0.3, 0.8));  // 默认太阳方向（左前上方）
    let ndotl = max(dot(normal, lightDir), 0.0);
    let ambient = 0.3;
    let brightness = ambient + (1.0 - ambient) * ndotl;
    color = vec4<f32>(color.rgb * brightness, 1.0);
  }

  // 高度着色（可选，用于无影像数据时的可视化）
  // let h = input.worldPosition.z / style.exaggeration;
  // color = heightColorRamp(h);

  return color;
}
```

### 1.7 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| ← 数据 | L3/TileScheduler | 注册 raster-dem 源，update() 返回 toLoad/toUnload | 瓦片调度 |
| ← 数据 | L3/WorkerPool('terrain-mesh') | DEM 解码 + 网格生成 | Worker 端处理 |
| → GPU | L1/GPUUploader.uploadFromTransferable | 顶点/索引/纹理上传（禁止 device.create*） | 零拷贝上传 |
| → GPU | L1/TextureManager.create | 高程纹理 R32F + 法线纹理 RGBA8 | 纹理管理 |
| → GPU | L2/ShaderAssembler.assemble | terrain_mesh + terrain_lit + split_double | Shader 组装 |
| → GPU | L2/PipelineCache.getOrCreateAsync | Pipeline 创建（禁止 device.createRenderPipeline） | 缓存 |
| → 相机 | Camera3D.setTerrainProvider | 注册 getElevation 为碰撞查询器 | 地形碰撞 |
| → 图层 | VectorTileLayer encode() | 矢量图层 Vertex Shader 采样 elevationTexture 贴地 | 地形叠加 |
| → 图层 | StencilManager.terrainDrape | 矢量贴地时的模板测试 | 深度约束 |
| → 事件 | InternalBus 'terrain:ready' / 'terrain:elevation-changed' | 地形数据就绪/夸大系数变化通知 | 松耦合 |

### 1.8 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| DEM 源不存在 | CONFIG_SOURCE_NOT_FOUND | onAdd 时 throw GeoForgeError |
| DEM 图像解码失败 | DATA_TILE_DECODE | ErrorRecovery 重试 2 次，失败则使用平坦 mesh（高度全 0） |
| Worker 网格生成超时（>10s） | WORKER_TIMEOUT | 降低 resolution 重试（64→32→16） |
| GPU 纹理上传 OOM | GPU_BUFFER_OOM | 触发 MemoryBudget 淘汰 + 降低 meshResolution |
| 持续帧率低于 30fps | — | PerformanceManager 降级链：降低 meshResolution(64→32→16) → 关闭光照 → 增大 SSE 阈值 |
| getElevation 超时 | — | 返回 0 + log.warn（不 throw，避免阻塞相机） |
| exaggeration 为 NaN/负数 | CONFIG_INVALID_PARAM | clamp 到 [0, 100] + if(__DEV__) log.warn |
| resolution 不是 2 的幂 | CONFIG_INVALID_PARAM | 向上取到最近的 2 的幂 + if(__DEV__) log.warn |
| 邻居 LOD 信息缺失 | — | 不做边缘约束，依赖裙边遮挡裂缝 |

### 1.9 ObjectPool / __DEV__ / @stability / Tree-Shaking / out参数 / GPU走L1

```
ObjectPool 使用点：
  1. UniformWriter 池化（同 P0 图层包）
  2. Worker 输入参数 TerrainMeshBuildParams：不池化（Worker 端消费后不返回）
  3. TerrainTileRenderData：不池化（生命周期跟瓦片一致）

__DEV__ 条件编译：
  1. if (__DEV__) { resolution 验证（2的幂检查） }
  2. if (__DEV__) { DEM 解码时间日志：logger.debug(`[terrain] tile ${coord} mesh built in ${ms}ms`) }
  3. if (__DEV__) { LOD 边缘约束详情日志 }
  4. if (__DEV__) { Morphing 因子超出 [0,1] 范围警告 }

@stability 标注：
  stable: onAdd/onRemove/onUpdate/encode/setExaggeration/exaggeration
  experimental: getElevation/getElevationSync/getElevationProfile/getElevationTexture/getNormalTexture/setMeshResolution
  internal: TerrainTileRenderData/TerrainMeshBuildParams/TerrainMeshResult

Tree-Shaking 导出：
  // layer-terrain/src/index.ts
  export { createTerrainLayer } from './TerrainLayer';
  export type { TerrainLayer, TerrainLayerOptions } from './TerrainLayer';

out 参数：
  法线计算中的 cross product 使用预分配 _tempNormal: Vec3f
  矩阵运算同 Camera 包（不在 Worker 中，Worker 可以自由分配）

GPU 走 L1：
  ✅ GPUUploader.uploadFromTransferable(vertices.buffer, VERTEX)
  ✅ GPUUploader.uploadFromTransferable(indices.buffer, INDEX)
  ✅ TextureManager.create({ format:'r32float', ... })  → elevationTexture
  ✅ TextureManager.create({ format:'rgba8unorm', ... }) → normalTexture
  ✅ GPUUploader.uploadTexture(elevationData/normalData)
  ❌ 禁止 device.createBuffer/createTexture
```

### 1.10 常量

```typescript
const DEFAULT_EXAGGERATION = 1.0;
const DEFAULT_MESH_RESOLUTION = 32;             // (32+1)² = 1089 顶点/瓦片
const DEFAULT_ENCODING = 'mapbox';
const DEFAULT_MORPH_RANGE = 0.3;
const SKIRT_HEIGHT_FACTOR = 5;                  // auto skirtHeight = cellSize * 5
const MAPBOX_DEM_BASE = -10000;                 // Mapbox Terrain RGB 基准偏移
const MAPBOX_DEM_SCALE = 0.1;                   // Mapbox Terrain RGB 精度（0.1米）
const TERRARIUM_DEM_BASE = -32768;              // Terrarium 基准偏移
const ELEVATION_QUERY_TIMEOUT_MS = 5000;        // getElevation 最大等待时间
const MAX_EXAGGERATION = 100;
const MIN_MESH_RESOLUTION = 8;
const MAX_MESH_RESOLUTION = 128;
```

---

## 2. @gis-forge/globe

### 2.1 类型依赖

```typescript
import type { CameraState, Vec3f, Mat4f, Viewport } from '@gis-forge/core';
import type { LayerContext } from '@gis-forge/scene';
import type { TextureHandle, BufferHandle } from '@gis-forge/gpu';
import type { InternalBus } from '@gis-forge/core/infra/internal-bus';
import type { GeoForgeError } from '@gis-forge/core/infra/errors';
import { ellipsoid } from '@gis-forge/core/geo/ellipsoid';
import { mat4, vec3, quat } from '@gis-forge/core/math';
```

### 2.2 GlobeOptions

```typescript
export interface GlobeOptions {
  /**
   * 大气效果开关。
   * @default true
   */
  readonly atmosphere?: boolean;

  /**
   * 大气散射强度。
   * 1.0 = 地球级（蓝天白云），0 = 无大气。
   * @range [0, 2]
   * @default 1.0
   */
  readonly atmosphereIntensity?: number;

  /**
   * 大气颜色（白天天空色）。
   * 与 Rayleigh 散射系数相乘，影响天空颜色。
   * @default [0.3, 0.5, 1.0]（蓝色系）
   */
  readonly atmosphereColor?: [number, number, number];

  /**
   * 大气渲染方案。
   * 'lut':      预计算 LUT 纹理，性能最好（推荐）
   * 'realtime': 实时射线步进，效果最好但开销大
   * @default 'lut'
   */
  readonly atmosphereMethod?: 'lut' | 'realtime';

  /**
   * 实时大气射线步进采样数。仅 atmosphereMethod='realtime' 时有效。
   * @range [4, 32]
   * @default 16
   */
  readonly atmosphereSamples?: number;

  /**
   * 星空背景开关。
   * @default true
   */
  readonly skybox?: boolean;

  /**
   * 星空粒子数量。
   * @range [1000, 100000]
   * @default 10000
   */
  readonly starCount?: number;

  /**
   * 星空亮度。
   * @range [0, 2]
   * @default 1.0
   */
  readonly starBrightness?: number;

  /**
   * 地球无影像时的底色。
   * @default [0.05, 0.05, 0.1, 1.0]（深蓝黑色）
   */
  readonly baseColor?: [number, number, number, number];

  /**
   * 阴影开关。
   * @default false
   */
  readonly shadows?: boolean;

  /**
   * CSM 级联数量。
   * 更多级联 = 更均匀的阴影质量，但更多 Shadow Map 渲染开销。
   * @range [2, 4]
   * @default 3
   */
  readonly shadowCascades?: number;

  /**
   * Shadow Map 分辨率（每个级联）。
   * @range [512, 4096]
   * @default 2048
   */
  readonly shadowMapSize?: number;

  /**
   * PCF 阴影采样核大小。
   * @range [1, 5]（1=无 PCF，3=3×3，5=5×5）
   * @default 3
   */
  readonly shadowPCFSize?: number;

  /**
   * 太阳位置（ECEF 坐标，米）。
   * 默认由时间自动计算（天文算法）。
   */
  readonly sunPosition?: Vec3f;

  /**
   * 地球网格细分级别。
   * 经度段数 = segments，纬度段数 = segments/2。
   * @range [16, 256]
   * @default 64
   */
  readonly globeSegments?: number;
}
```

### 2.3 内部数据结构

```typescript
/**
 * 大气散射 LUT 纹理集。
 * 预计算后上传 GPU，Fragment Shader 查表。
 */
interface AtmosphereLUT {
  /** 透射率 LUT：256×64 RGBA16F，从 viewAngle × altitude 查 transmittance */
  readonly transmittance: TextureHandle;
  /** 散射 LUT：256×256×32 RGBA16F 3D 纹理，从 viewAngle × sunAngle × altitude 查 in-scattering */
  readonly scattering: TextureHandle;
}

/**
 * Cascaded Shadow Map 资源。
 */
interface CSMResources {
  /** 每个级联的 Shadow Map 深度纹理 */
  readonly shadowMaps: TextureHandle[];
  /** 每个级联的光源 VP 矩阵（Float32Array[16]） */
  readonly lightVPMatrices: Mat4f[];
  /** 每个级联的深度分割值（视图空间 Z） */
  readonly cascadeSplits: number[];
  /** 级联数量 */
  readonly count: number;
}

/**
 * 星空粒子缓冲。
 */
interface StarfieldData {
  /** 星星位置 + 亮度：Float32Array[starCount * 4]（x, y, z, brightness） */
  readonly buffer: BufferHandle;
  readonly count: number;
}

/**
 * 大气散射物理常量。
 */
interface AtmosphereConstants {
  /** 地球半径（米） */
  readonly earthRadius: number;      // 6371000
  /** 大气层顶部半径（米） */
  readonly atmosphereRadius: number; // 6471000（地球半径 + 100km）
  /** Rayleigh 散射系数（1/m），λ依赖：蓝>绿>红 */
  readonly rayleighCoeff: [number, number, number];  // [5.5e-6, 13.0e-6, 22.4e-6]
  /** Rayleigh 标高（m） */
  readonly rayleighHeight: number;   // 8000
  /** Mie 散射系数（1/m） */
  readonly mieCoeff: number;         // 21e-6
  /** Mie 标高（m） */
  readonly mieHeight: number;        // 1200
  /** Mie 相位函数不对称参数 g */
  readonly mieG: number;             // 0.76
}
```

### 2.4 GlobeRenderer 公共接口

```typescript
export interface GlobeRenderer {
  // ═══════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════

  /**
   * 初始化。
   * 步骤：
   *   1. 生成椭球体网格（WGS84，segments × segments/2 段）
   *   2. 上传网格到 GPU（Split-Double 精度）
   *   3. 编译地球 Shader（globe 投影 + 基础着色）
   *   4. 如果 atmosphere=true：
   *      a. 如果 method='lut'：预计算 Transmittance + Scattering LUT（CPU 端，~200ms）
   *      b. 上传 LUT 纹理
   *      c. 编译大气 Shader
   *   5. 如果 skybox=true：
   *      a. 生成随机星场粒子缓冲
   *      b. 编译星空 Shader
   *   6. 如果 shadows=true：
   *      a. 创建 CSM 资源（N 个 Shadow Map 深度纹理）
   *      b. 编译阴影 Shader
   *   7. 通过 InternalBus emit 'globe:ready'
   *
   * @stability stable
   */
  initialize(context: LayerContext): void;

  /**
   * @stability stable
   */
  destroy(): void;

  // ═══════════════════════════════════════
  // 大气（#8.1）
  // ═══════════════════════════════════════

  /** @stability stable */
  setAtmosphereEnabled(enabled: boolean): void;
  readonly isAtmosphereEnabled: boolean;

  /** @stability experimental */
  setAtmosphereIntensity(intensity: number): void;
  readonly atmosphereIntensity: number;

  /** @stability experimental */
  setAtmosphereColor(color: [number, number, number]): void;

  // ═══════════════════════════════════════
  // 星空
  // ═══════════════════════════════════════

  /** @stability stable */
  setSkyboxEnabled(enabled: boolean): void;
  readonly isSkyboxEnabled: boolean;

  /**
   * 自定义星空纹理（Cubemap 6 面或 Equirectangular 全景）。
   * @param texture - 已上传的 TextureHandle
   * @stability experimental
   */
  setSkyboxTexture(texture: TextureHandle): void;

  // ═══════════════════════════════════════
  // 阴影（#8.4）
  // ═══════════════════════════════════════

  /** @stability experimental */
  setShadowsEnabled(enabled: boolean): void;
  readonly isShadowsEnabled: boolean;

  /** @stability experimental */
  setShadowCascades(count: number): void;

  /** @stability experimental */
  setShadowMapSize(size: number): void;

  // ═══════════════════════════════════════
  // 太阳
  // ═══════════════════════════════════════

  /**
   * 手动设置太阳位置（ECEF 坐标，米）。
   * 调用后自动时间计算被禁用，直到下次调用 setSunFromDateTime。
   *
   * @stability stable
   */
  setSunPosition(ecef: Vec3f): void;
  getSunPosition(): Vec3f;

  /**
   * 根据 UTC 日期时间自动计算太阳位置。
   * 使用简化天文算法（Solar Position Algorithm 简化版，精度 ~0.1°）。
   *
   * @stability stable
   *
   * 算法：
   *   1. 计算 Julian Date
   *   2. 计算太阳赤经（RA）和赤纬（Dec）
   *   3. 转换为 ECEF 坐标：
   *      lon_sun = RA - GMST（格林尼治恒星时）
   *      lat_sun = Dec
   *      sunECEF = geodeticToECEF(lon_sun, lat_sun, 1.496e11)（1 AU）
   */
  setSunFromDateTime(date: Date): void;

  /**
   * 获取太阳方向（归一化，世界空间，指向太阳）。
   * 其他模块（阴影、光照）使用此方向。
   *
   * @stability stable
   */
  getSunDirection(): Vec3f;

  // ═══════════════════════════════════════
  // 渲染（由 RenderGraph / FrameGraphBuilder 调用）
  // ═══════════════════════════════════════

  /**
   * 渲染地球本体。
   * 使用 WGS84 椭球体网格 + 基础颜色/影像纹理。
   * Split-Double 精度（ECEF 坐标）。
   *
   * @stability stable
   */
  encodeGlobe(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 渲染大气层（叠加在地球上方，alpha blend）。
   * 渲染一个略大于地球的球壳（atmosphereRadius），Fragment 中计算散射。
   *
   * @stability stable
   */
  encodeAtmosphere(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 渲染星空背景。
   * 在最远处渲染（在地球之前），使用点精灵。
   * 相机旋转时星空跟随旋转（固定在天球坐标系）。
   *
   * @stability stable
   */
  encodeSkybox(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 渲染 CSM 阴影 Pass。
   * 在主渲染之前执行。对每个级联：
   *   1. 计算光源 VP 矩阵（正交投影，覆盖该级联的视锥体切片）
   *   2. 渲染场景中投射阴影的对象到 Shadow Map 深度纹理
   *
   * @stability experimental
   */
  encodeShadowPass(encoder: GPUCommandEncoder, camera: CameraState): void;

  /**
   * 获取 Shadow Map 纹理（供其他图层采样）。
   * @stability experimental
   */
  getShadowMapTexture(): TextureHandle | null;

  /**
   * 获取每个级联的光源 VP 矩阵。
   * @stability experimental
   */
  getShadowVPMatrices(): ReadonlyArray<Mat4f>;

  /**
   * 获取级联分割值（用于 Fragment Shader 选择级联）。
   * @stability experimental
   */
  getCascadeSplits(): ReadonlyArray<number>;
}

export function createGlobeRenderer(options?: GlobeOptions): GlobeRenderer;
```

### 2.5 大气散射算法详细步骤

```
═══ 方案 A：预计算 LUT（推荐）═══

步骤 1：Transmittance LUT（透射率查找表）
  维度：256(viewZenith) × 64(altitude)
  对每个 (viewZenith, altitude) 组合：
    从 altitude 沿 viewZenith 方向射线步进到大气层顶：
    T(viewZenith, altitude) = exp(-∫ (βR(h)*ρR(h) + βM(h)*ρM(h)) ds)
    其中：
      βR(h) = rayleighCoeff * exp(-h / rayleighHeight)
      βM(h) = mieCoeff * exp(-h / mieHeight)
    积分用 32 步 Simpson 法

步骤 2：Scattering LUT（散射查找表）
  维度：256(viewZenith) × 256(sunZenith) × 32(altitude)
  对每个 (viewZenith, sunZenith, altitude) 组合：
    从 altitude 沿 viewZenith 方向射线步进，每步计算 in-scattering：
    S = Σ T(eye→P) * βR(P) * PhaseR(θ) * T(P→sun) * ds
      + Σ T(eye→P) * βM(P) * PhaseM(θ) * T(P→sun) * ds
    其中：
      PhaseR(θ) = 3/(16π) * (1 + cos²θ)          // Rayleigh 相位函数
      PhaseM(θ) = (1-g²) / (4π*(1+g²-2g*cosθ)^1.5)  // Henyey-Greenstein
      θ = viewDir 和 sunDir 的夹角

步骤 3：Fragment Shader 查表
  根据当前像素的 viewDir 和 sunDir，计算 viewZenith/sunZenith/altitude，
  查 Scattering LUT 获取散射颜色。
  最终颜色 = sceneColor * transmittance + scattering * atmosphereIntensity

═══ 方案 B：实时射线步进（fallback）═══

Fragment Shader 中直接执行射线步进（atmosphereSamples 步）：
  for (i = 0; i < samples; i++) {
    t = i / (samples - 1)
    P = rayOrigin + rayDir * t * rayLength
    h = length(P) - earthRadius
    if (h < 0 || h > atmosphereHeight) continue

    // 在 P 点计算散射
    opticalDepthR += exp(-h / HR) * segmentLength
    opticalDepthM += exp(-h / HM) * segmentLength

    // P 到太阳的透射率
    T_sun = exp(-(opticalDepthR_sun * βR + opticalDepthM_sun * βM))

    // 累加 in-scattering
    inScatterR += T_sun * exp(-h / HR) * segmentLength
    inScatterM += T_sun * exp(-h / HM) * segmentLength
  }

  T_view = exp(-(opticalDepthR * βR + opticalDepthM * βM))
  scatterColor = inScatterR * βR * PhaseR(θ) + inScatterM * βM * PhaseM(θ)
  finalColor = sceneColor * T_view + scatterColor * atmosphereIntensity
```

### 2.6 CSM 阴影算法详细步骤

```
═══ 步骤 1：视锥体级联分割 ═══

  对数 + 均匀混合分割：
  for (i = 1; i <= cascadeCount; i++) {
    uniformSplit = near + (far - near) * i / cascadeCount
    logSplit = near * (far / near)^(i / cascadeCount)
    cascadeSplits[i] = lambda * logSplit + (1 - lambda) * uniformSplit
    // lambda = 0.5（混合系数）
  }
  cascadeSplits[0] = near
  cascadeSplits[cascadeCount] = far

═══ 步骤 2：每个级联计算光源 VP 矩阵 ═══

  for each cascade i:
    // 提取该级联对应的视锥体切片 8 个角点
    sliceFrustumCorners = computeFrustumSlice(camera.vpMatrix, cascadeSplits[i], cascadeSplits[i+1])

    // 计算切片的世界空间 AABB
    sliceCenter = average(sliceFrustumCorners)
    sliceRadius = max(distance(corner, sliceCenter)) for all corners

    // 光源正交投影（覆盖整个切片）
    lightView = mat4.lookAt(sliceCenter + sunDir * sliceRadius, sliceCenter, up)
    lightProj = mat4.ortho(-sliceRadius, sliceRadius, -sliceRadius, sliceRadius, 0, sliceRadius * 2)
    lightVPMatrices[i] = lightProj * lightView

    // 稳定化：将矩阵 snap 到 texel 边界（避免阴影闪烁）
    worldUnitsPerTexel = sliceRadius * 2 / shadowMapSize
    lightVP 的平移分量 snap 到 worldUnitsPerTexel 的整数倍

═══ 步骤 3：Shadow Map 渲染 ═══

  for each cascade i:
    beginRenderPass(shadowMaps[i], { depthClearValue: 1.0, depthCompare: 'less' })
    for each shadow-casting layer:
      layer.encodeShadow(encoder, lightVPMatrices[i])
    endRenderPass()

═══ 步骤 4：主渲染中采样阴影 ═══

  Fragment Shader 中：
    // 选择级联
    viewZ = (viewMatrix * vec4(worldPos, 1.0)).z
    cascadeIdx = 0
    for (i = 0; i < cascadeCount; i++) {
      if (viewZ < cascadeSplits[i+1]) { cascadeIdx = i; break; }
    }

    // 转换到光源空间
    lightSpacePos = lightVPMatrices[cascadeIdx] * vec4(worldPos, 1.0)
    shadowUV = lightSpacePos.xy * 0.5 + 0.5
    shadowDepth = lightSpacePos.z

    // PCF 采样（3×3 kernel）
    shadow = 0.0
    texelSize = 1.0 / shadowMapSize
    for (dx = -1; dx <= 1; dx++) {
      for (dy = -1; dy <= 1; dy++) {
        sampleUV = shadowUV + vec2(dx, dy) * texelSize
        closestDepth = textureSample(shadowMap[cascadeIdx], sampleUV).r
        shadow += select(0.0, 1.0, shadowDepth > closestDepth + bias)
      }
    }
    shadow /= 9.0  // 平均

    // 级联过渡（避免级联边界明显分界线）
    if (viewZ > cascadeSplits[cascadeIdx+1] - transitionRange) {
      t = (viewZ - (cascadeSplits[cascadeIdx+1] - transitionRange)) / transitionRange
      nextShadow = sampleShadow(cascadeIdx + 1, worldPos)
      shadow = mix(shadow, nextShadow, t)
    }

    finalColor *= (1.0 - shadow * shadowStrength)
```

### 2.7 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| → GPU | L1/GPUUploader | 椭球网格 + LUT 纹理 + 星场缓冲上传 | 禁止 device.create* |
| → GPU | L2/ShaderAssembler | globe 投影 + atmosphere + skybox + shadow Shader | 模块化 Shader |
| → GPU | L2/PipelineCache | Pipeline 缓存 | |
| → GPU | L2/DepthManager | 地球使用 perspectiveReversedZInfinite | 无限远透视 |
| → GPU | L2/BlendPresets | 大气用 premultipliedAlpha，星空用 additive | 混合模式 |
| → 图层 | 其他图层的 Fragment Shader | getShadowMapTexture() + getShadowVPMatrices() | 阴影采样 |
| → 图层 | TerrainLayer | getSunDirection() 用于地形光照 | 太阳方向 |
| → 事件 | InternalBus 'globe:ready' / 'globe:sun-changed' | | |
| ← 输入 | L6/Globe3D | 调用 setSunFromDateTime / setAtmosphere* / setShadows* | 用户控制 |

### 2.8 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| LUT 预计算失败（NaN） | — | 使用 fallback 常量值 + log.warn |
| Shadow Map 创建 OOM | GPU_BUFFER_OOM | 降低 shadowMapSize (2048→1024→512) |
| 持续帧率低于目标 | — | PerformanceManager 降级链：关闭大气→关闭阴影→降低 globeSegments→关闭星空 |
| 太阳位置计算溢出 | — | clamp 到合理范围 |
| globeSegments 超限 | CONFIG_INVALID_PARAM | clamp [16, 256] + if(__DEV__) warn |
| 3D 纹理不支持（某些 GPU） | — | fallback 到 2D 纹理 atlas + log.warn |

### 2.9 常量

```typescript
const EARTH_RADIUS = 6371000;                   // 米
const ATMOSPHERE_RADIUS = 6471000;               // 地球半径 + 100km
const RAYLEIGH_COEFF: [number, number, number] = [5.5e-6, 13.0e-6, 22.4e-6];  // 1/m
const RAYLEIGH_HEIGHT = 8000;                    // 米
const MIE_COEFF = 21e-6;                         // 1/m
const MIE_HEIGHT = 1200;                         // 米
const MIE_G = 0.76;                              // Henyey-Greenstein g 参数
const TRANSMITTANCE_LUT_WIDTH = 256;
const TRANSMITTANCE_LUT_HEIGHT = 64;
const SCATTERING_LUT_SIZE = [256, 256, 32];
const DEFAULT_SHADOW_CASCADES = 3;
const DEFAULT_SHADOW_MAP_SIZE = 2048;
const DEFAULT_PCF_SIZE = 3;
const CASCADE_SPLIT_LAMBDA = 0.5;                // 对数/均匀分割混合系数
const SHADOW_BIAS = 0.005;                       // 阴影偏移（防止 self-shadowing）
const CASCADE_TRANSITION_RANGE = 0.1;            // 级联过渡范围（视锥深度比例）
const AU_METERS = 1.496e11;                      // 1 天文单位（太阳距离）
const DEFAULT_GLOBE_SEGMENTS = 64;
const DEFAULT_STAR_COUNT = 10000;
```

### 2.10 ObjectPool / __DEV__ / Tree-Shaking

```
ObjectPool：
  1. UniformWriter 池化
  2. CSM 级联 frustum corners 临时数组：预分配 Float32Array[8*3] 复用

__DEV__：
  1. LUT 预计算时间日志：if (__DEV__) logger.debug(`[globe] LUT computed in ${ms}ms`)
  2. CSM 级联分割值日志
  3. 大气参数范围验证

Tree-Shaking：
  // globe/src/index.ts
  export { createGlobeRenderer } from './GlobeRenderer';
  export type { GlobeRenderer, GlobeOptions } from './GlobeRenderer';
```

---

## P1 上半部分统计

| 包 | 公共方法 | 内部结构 | WGSL 模块 | 对接模块 | 错误场景 | 常量 |
|---|---------|---------|----------|---------|---------|------|
| layer-terrain | 10 | 3 struct + 2 WGSL | terrain_mesh + terrain_lit | 10 个 | 8 种 | 12 |
| globe | 20 | 4 struct | globe + atmosphere + skybox + shadow | 9 个 | 5 种 | 18 |
