# GeoForge 可选功能包完整接口设计 — P0 图层包（layer-tile-raster / layer-tile-vector / layer-geojson）

> **完整版**：每个接口的每个字段、每个方法的每个参数、每种错误、每个算法步骤全部展开。

---

## 4. @geoforge/layer-tile-raster

### 4.1 类型依赖

```typescript
import type { Layer, LayerContext, LayerSpec } from '@geoforge/scene';
import type { CameraState, TileCoord, BBox2D, Viewport, Feature, FilterExpression } from '@geoforge/core';
import type { BufferHandle, TextureHandle } from '@geoforge/gpu';
import type { TileScheduleResult } from '@geoforge/runtime';
import type { InternalBus } from '@geoforge/core/infra/internal-bus';
import type { GeoForgeError, GeoForgeErrorCode } from '@geoforge/core/infra/errors';
```

### 4.2 RasterTileLayerOptions

```typescript
export interface RasterTileLayerOptions {
  /** 图层唯一 ID */
  readonly id: string;

  /**
   * 数据源 ID（已在 SourceManager 中注册的 raster 或 raster-dem 源）。
   * 图层不直接管理数据请求，而是通过 TileScheduler + 数据源间接加载。
   */
  readonly source: string;

  /**
   * 瓦片像素尺寸。
   * 256: 传统瓦片（请求量多但单个文件小）
   * 512: 高分辨率瓦片（MapLibre 默认，请求量少但文件大）
   * 影响 TileScheduler 的 zoom 计算：512 瓦片在相同 zoom 下覆盖 4 倍面积。
   * @default 512
   */
  readonly tileSize?: 256 | 512;

  /**
   * 图层透明度。
   * @range [0, 1]，0 = 完全透明，1 = 完全不透明
   * @default 1
   */
  readonly opacity?: number;

  /** 最小可见 zoom，低于此 zoom 图层不渲染。默认 0 */
  readonly minzoom?: number;

  /** 最大可见 zoom。默认 22 */
  readonly maxzoom?: number;

  /**
   * 瓦片淡入动画时长（毫秒）。
   * 新瓦片加载完成后从透明渐变到不透明。
   * 设为 0 则立即显示（无过渡）。
   * @unit 毫秒
   * @default 300
   */
  readonly fadeDuration?: number;

  /**
   * 投影 ID。默认继承地图投影（通常是 'mercator'）。
   * 如果数据源使用非墨卡托投影（如 EPSG:4326 格网），需要显式设置。
   */
  readonly projection?: string;

  /**
   * 初始图像调节参数。可以后续通过 set 方法修改。
   */
  readonly paint?: {
    /** 亮度调节 @range [-1, 1] @default 0 */
    readonly 'raster-brightness-min'?: number;
    readonly 'raster-brightness-max'?: number;
    /** 对比度调节 @range [-1, 1] @default 0 */
    readonly 'raster-contrast'?: number;
    /** 饱和度调节 @range [-1, 1] @default 0 */
    readonly 'raster-saturation'?: number;
    /** 色调旋转 @unit 弧度 @default 0 */
    readonly 'raster-hue-rotate'?: number;
    /** 淡入透明度 @range [0, 1] @default 1 */
    readonly 'raster-opacity'?: number;
  };
}
```

### 4.3 内部数据结构

```typescript
/**
 * 单个瓦片的 GPU 端渲染数据。
 * 瓦片加载解码完成后创建此对象，缓存直到瓦片被卸载。
 */
interface RasterTileRenderData {
  /** 瓦片坐标 */
  readonly coord: TileCoord;
  /** GPU 纹理句柄（ImageBitmap → GPUTexture） */
  readonly texture: TextureHandle;
  /** 瓦片地理范围（墨卡托 BBox） */
  readonly extent: BBox2D;
  /** 顶点缓冲（瓦片四个角的墨卡托坐标 + UV，6 个顶点 = 2 个三角形） */
  readonly vertexBuffer: BufferHandle;
  /** 加载完成的时间戳（用于淡入动画） */
  readonly loadedAt: number;
  /** 当前淡入进度 0~1 */
  fadeProgress: number;
}

/**
 * 图像调节 Uniform 数据。
 * 上传到 perLayer BindGroup (@group(1))。
 */
interface RasterStyleUniforms {
  /** 亮度最小值 [-1, 1] */
  brightnessMin: number;
  /** 亮度最大值 [-1, 1] */
  brightnessMax: number;
  /** 对比度 [-1, 1] */
  contrast: number;
  /** 饱和度 [-1, 1] */
  saturation: number;
  /** 色调旋转（弧度） */
  hueRotate: number;
  /** 图层透明度 [0, 1] */
  opacity: number;
}
```

### 4.4 RasterTileLayer 公共接口

```typescript
export interface RasterTileLayer extends Layer {
  readonly type: 'raster';

  // ═══════════════════════════════════════
  // 瓦片状态
  // ═══════════════════════════════════════

  /** 当前可见并已渲染的瓦片列表 */
  readonly visibleTiles: ReadonlyArray<TileCoord>;

  /** 正在加载中的瓦片列表 */
  readonly loadingTiles: ReadonlyArray<TileCoord>;

  /** 已缓存的瓦片总数 */
  readonly cachedTileCount: number;

  // ═══════════════════════════════════════
  // 图像调节
  // ═══════════════════════════════════════

  /**
   * 设置亮度。
   * 在 Fragment Shader 中：color.rgb = mix(minBrightness, maxBrightness, color.rgb)
   *
   * @param value - [-1, 1]，0 = 原始亮度
   * @throws GeoForgeError(CONFIG_INVALID_PARAM) 如果 value 超出范围
   */
  setBrightness(value: number): void;
  getBrightness(): number;

  /**
   * 设置对比度。
   * 在 Fragment Shader 中：color.rgb = (color.rgb - 0.5) * (1 + contrast) + 0.5
   *
   * @param value - [-1, 1]，0 = 原始对比度，-1 = 全灰，1 = 最大对比
   */
  setContrast(value: number): void;
  getContrast(): number;

  /**
   * 设置饱和度。
   * 在 Fragment Shader 中：
   *   gray = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722))
   *   color.rgb = mix(vec3(gray), color.rgb, 1 + saturation)
   *
   * @param value - [-1, 1]，0 = 原始饱和度，-1 = 灰度图
   */
  setSaturation(value: number): void;
  getSaturation(): number;

  /**
   * 设置色调旋转。
   * 在 Fragment Shader 中：将 RGB 转为 HSL，旋转 H，再转回 RGB。
   *
   * @param radians - 旋转角度（弧度），0 = 原始色调
   */
  setHueRotate(radians: number): void;
  getHueRotate(): number;

  /**
   * 设置淡入动画时长。
   * 正在进行淡入的瓦片不受影响，只影响后续新加载的瓦片。
   *
   * @param ms - 毫秒，0 = 禁用淡入
   */
  setFadeDuration(ms: number): void;

  // ═══════════════════════════════════════
  // Layer 生命周期（由 LayerManager 调用）
  // ═══════════════════════════════════════

  /**
   * 初始化。
   * 步骤：
   *   1. 从 LayerContext 获取 TileScheduler / ShaderAssembler / PipelineCache
   *   2. 编译 Shader：assemble({ projection, geometry:'quad', style:'raster' })
   *   3. 创建 Pipeline：pipelineCache.getOrCreateAsync(pipelineDesc)
   *   4. 创建 perLayer Uniform Buffer（RasterStyleUniforms）
   *   5. 向 TileScheduler 注册数据源
   *   6. 监听 InternalBus 'tile:loaded' 事件
   *
   * @param context - 引擎注入的服务集合
   */
  onAdd(context: LayerContext): void;

  /**
   * 清理。
   * 步骤：
   *   1. 从 TileScheduler 注销数据源
   *   2. 释放所有瓦片纹理（TextureManager.release）
   *   3. 释放顶点缓冲（BufferPool.release）
   *   4. 释放 Uniform Buffer
   *   5. 取消 InternalBus 监听
   */
  onRemove(): void;

  /**
   * 每帧更新。
   * 步骤：
   *   1. 检查 zoom 是否在 [minzoom, maxzoom] 范围内，否则跳过渲染
   *   2. 推进淡入动画：fadeProgress += deltaTime * 1000 / fadeDuration
   *   3. 更新 Uniform Buffer（如果样式参数有变化）
   *
   * @param deltaTime - 帧间隔（秒）
   * @param camera - 当前相机状态
   */
  onUpdate(deltaTime: number, camera: CameraState): void;

  /**
   * 编码渲染命令。
   * 步骤：
   *   1. 遍历 visibleTiles
   *   2. 对每个瓦片：
   *      a. setPipeline(rasterPipeline)
   *      b. setVertexBuffer(0, tile.vertexBuffer)
   *      c. setBindGroup(0, perFrameBindGroup)（相机矩阵）
   *      d. setBindGroup(1, perLayerBindGroup)（样式 Uniform + 瓦片纹理）
   *      e. draw(6)（2 个三角形 = 6 个顶点）
   *   3. 未加载完成的瓦片使用 placeholder（父瓦片的对应子区域）
   *
   * @param encoder - GPURenderPassEncoder
   * @param camera - 当前相机状态
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}
```

### 4.5 瓦片加载管线详细步骤

```
TileScheduler.update(camera, viewport) → TileScheduleResult
  │
  ├── toLoad: [{ coord:{x:3,y:5,z:10}, sse:4.2, distance:100 }]
  │     │
  │     ▼
  │   RequestScheduler.schedule({
  │     id: 'raster:streets:3/5/10',
  │     url: 'https://tiles.example.com/10/3/5.png',
  │     priority: 'normal',
  │     responseType: 'blob',
  │   })
  │     │
  │     ▼
  │   fetch(url) → Blob
  │     │
  │     ▼
  │   createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }) → ImageBitmap
  │     │
  │     ▼
  │   GPUUploader.uploadTexture(imageBitmap, {
  │     format: 'rgba8unorm',
  │     mipLevelCount: 1,
  │     usage: TEXTURE_BINDING | COPY_DST,
  │     label: 'raster:3/5/10',
  │   }) → TextureHandle
  │     │
  │     ▼
  │   创建顶点缓冲：
  │     tileBBox = mercator.tileToBBox(3, 5, 10)
  │     vertices = Float32Array [
  │       // x, y, u, v （每个顶点 4 个 float）
  │       west, south, 0, 1,   // 左下
  │       east, south, 1, 1,   // 右下
  │       west, north, 0, 0,   // 左上
  │       west, north, 0, 0,   // 左上
  │       east, south, 1, 1,   // 右下
  │       east, north, 1, 0,   // 右上
  │     ]
  │     GPUUploader.uploadBuffer(vertices, VERTEX) → BufferHandle
  │     │
  │     ▼
  │   RasterTileRenderData { coord, texture, extent, vertexBuffer, loadedAt: now, fadeProgress: 0 }
  │     │
  │     ▼
  │   InternalBus.emit('tile:loaded', { sourceId, coord, data: renderData })
  │
  ├── toUnload: [{ x:0, y:0, z:8 }]
  │     │
  │     ▼
  │   TextureManager.release(tile.texture)
  │   BufferPool.release(tile.vertexBuffer)
  │   从 visibleTiles 缓存中移除
  │
  └── placeholder: Map { '3/5/10' → { x:1, y:2, z:9 } }（父瓦片替代）
        │
        ▼
      渲染时使用父瓦片纹理 + 子区域 UV 偏移：
        uOffset = (childX % 2) * 0.5
        vOffset = (childY % 2) * 0.5
        uvScale = 0.5
```

### 4.6 瓦片接缝处理详细算法

```
问题：相邻瓦片之间由于浮点精度和纹理采样的离散性，可能出现 1 像素的缝隙。

解决方案（三层防御）：

第 1 层：UV 内缩 0.5 texel
  纹理采样时 UV 不从 [0, 1] 而是从 [0.5/size, 1-0.5/size] 采样。
  避免采样到纹理边界以外的像素（clamp 模式下可能取到透明或错误颜色）。
  tileSize = 512:
    uvMin = 0.5 / 512 = 0.0009765625
    uvMax = 1 - 0.5 / 512 = 0.9990234375

第 2 层：Sampler clamp-to-edge
  GPUSampler 配置 addressModeU/V = 'clamp-to-edge'
  采样超出 [0,1] 的坐标时，取边缘像素而非透明。

第 3 层：顶点坐标重叠
  相邻瓦片的公共边界上，两个瓦片各向外扩展 1 texel 的宽度。
  确保即使有浮点误差，也不会出现间隙。
  扩展量：1 pixel / worldSize(zoom) 的墨卡托单位
  vertexBBox.west  -= 1 / worldSize
  vertexBBox.south -= 1 / worldSize
  vertexBBox.east  += 1 / worldSize
  vertexBBox.north += 1 / worldSize
```

### 4.7 WGSL Shader（style/raster.wgsl）

```wgsl
// ── 栅格瓦片样式模块 ──
// 标准签名：fn computeColor(input: FragmentInput) -> vec4<f32>

struct RasterUniforms {
  brightnessMin: f32,
  brightnessMax: f32,
  contrast: f32,
  saturation: f32,
  hueRotate: f32,
  opacity: f32,
  fadeAlpha: f32,       // 淡入动画当前 alpha
  _padding: f32,        // 对齐到 32 字节
};
@group(1) @binding(0) var<uniform> style: RasterUniforms;
@group(3) @binding(0) var tileSampler: sampler;
@group(3) @binding(1) var tileTexture: texture_2d<f32>;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  // 1. 采样纹理
  var color = textureSample(tileTexture, tileSampler, input.uv);

  // 2. 亮度调节
  color = vec4<f32>(
    mix(vec3<f32>(style.brightnessMin), vec3<f32>(style.brightnessMax), color.rgb),
    color.a
  );

  // 3. 对比度调节
  color = vec4<f32>(
    (color.rgb - 0.5) * (1.0 + style.contrast) + 0.5,
    color.a
  );

  // 4. 饱和度调节
  let gray = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  color = vec4<f32>(
    mix(vec3<f32>(gray), color.rgb, 1.0 + style.saturation),
    color.a
  );

  // 5. 色调旋转（简化版：RGB 空间旋转矩阵）
  if (abs(style.hueRotate) > 0.001) {
    let cosH = cos(style.hueRotate);
    let sinH = sin(style.hueRotate);
    let r = color.r * (0.299 + 0.701*cosH + 0.168*sinH)
          + color.g * (0.587 - 0.587*cosH + 0.330*sinH)
          + color.b * (0.114 - 0.114*cosH - 0.497*sinH);
    let g = color.r * (0.299 - 0.299*cosH - 0.328*sinH)
          + color.g * (0.587 + 0.413*cosH + 0.035*sinH)
          + color.b * (0.114 - 0.114*cosH + 0.292*sinH);
    let b = color.r * (0.299 - 0.300*cosH + 1.250*sinH)
          + color.g * (0.587 - 0.588*cosH - 1.050*sinH)
          + color.b * (0.114 + 0.886*cosH - 0.203*sinH);
    color = vec4<f32>(r, g, b, color.a);
  }

  // 6. 透明度
  color.a *= style.opacity * style.fadeAlpha;

  return color;
}
```

### 4.8 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| 数据源 ID 不存在 | CONFIG_SOURCE_NOT_FOUND | onAdd 时 throw GeoForgeError |
| 瓦片请求 404/500 | DATA_TILE_LOAD | ErrorRecovery 指数退避重试 3 次 |
| ImageBitmap 创建失败（图片损坏） | DATA_TILE_DECODE | 标记该瓦片为永久失败，使用 placeholder |
| GPU 纹理上传失败（OOM） | GPU_BUFFER_OOM | 触发 MemoryBudget 紧急淘汰，重试一次 |
| 样式参数超范围 | CONFIG_INVALID_PARAM | clamp 到有效范围 + log.warn |

---

## 5. @geoforge/layer-tile-vector

### 5.1 VectorTileLayerOptions

```typescript
export interface VectorTileLayerOptions {
  readonly id: string;

  /** 数据源 ID（vector 类型） */
  readonly source: string;

  /**
   * MVT（Mapbox Vector Tile）中的图层名。
   * 一个 MVT 文件可能包含多个逻辑图层（如 buildings, roads, water）。
   * 此字段指定从 MVT 中提取哪个逻辑图层。
   */
  readonly sourceLayer: string;

  /**
   * 渲染类型，决定几何处理和 Shader 选择。
   * fill:           多边形填充（earcut 三角剖分）
   * line:           线条渲染（宽线条带 + SDF 抗锯齿）
   * circle:         点圆（instanced quad + SDF 圆形）
   * symbol:         图标 + 文字标注（提交给 LabelManager）
   * fill-extrusion: 多边形拉伸为 3D（委托给 ExtrusionLayer）
   */
  readonly type: 'fill' | 'line' | 'circle' | 'symbol' | 'fill-extrusion';

  /**
   * 要素过滤表达式。
   * 只有满足过滤条件的要素才参与渲染。
   * 语法同 MapLibre Style Spec filter。
   *
   * @example ['==', ['get', 'type'], 'residential']  // 只渲染 type=residential
   */
  readonly filter?: FilterExpression;

  /**
   * 绘制属性（运行时可通过 setPaintProperty 修改）。
   *
   * fill 类型：
   *   'fill-color':      string | StyleExpression（填充颜色）
   *   'fill-opacity':    number | StyleExpression（填充透明度）
   *   'fill-outline-color': string | StyleExpression（轮廓颜色）
   *   'fill-antialias':  boolean（轮廓抗锯齿，默认 true）
   *
   * line 类型：
   *   'line-color':      string | StyleExpression
   *   'line-width':      number | StyleExpression（像素宽度）
   *   'line-opacity':    number | StyleExpression
   *   'line-dasharray':  number[]（虚线模式 [实线, 间隔, 实线, ...]）
   *   'line-cap':        'butt' | 'round' | 'square'
   *   'line-join':       'bevel' | 'round' | 'miter'
   *   'line-miter-limit': number（miter join 最大尖角长度，默认 2）
   *
   * circle 类型：
   *   'circle-radius':   number | StyleExpression（像素半径）
   *   'circle-color':    string | StyleExpression
   *   'circle-opacity':  number | StyleExpression
   *   'circle-stroke-color': string | StyleExpression
   *   'circle-stroke-width': number | StyleExpression
   */
  readonly paint?: Record<string, any>;

  /**
   * 布局属性（运行时可通过 setLayoutProperty 修改）。
   *
   * line 类型：
   *   'line-sort-key':  number | StyleExpression（渲染排序键）
   *
   * symbol 类型：
   *   'symbol-placement': 'point' | 'line' | 'line-center'
   *   'text-field':       string | StyleExpression（标注文字内容）
   *   'text-size':        number | StyleExpression
   *   'text-font':        string[]
   *   'text-anchor':      'center' | 'top' | 'bottom' | ...
   *   'text-offset':      [number, number]
   *   'icon-image':       string | StyleExpression
   *   'icon-size':        number | StyleExpression
   */
  readonly layout?: Record<string, any>;

  readonly minzoom?: number;
  readonly maxzoom?: number;
}
```

### 5.2 VectorTileLayer 公共接口

```typescript
export interface VectorTileLayer extends Layer {
  // ═══════════════════════════════════════
  // 要素查询
  // ═══════════════════════════════════════

  /**
   * 查询地理范围内的要素。
   * 搜索已加载瓦片中落入 bbox 的要素。
   * 结果基于 CPU 端缓存的要素数据（Worker 解码后保留的原始几何+属性）。
   *
   * @param bbox - 地理范围（经纬度 BBox）
   * @param filter - 可选的过滤表达式（在图层 filter 基础上再过滤）
   * @returns 匹配的要素数组（Feature 含 _sourceId/_layerId/_tileCoord）
   *
   * 算法：
   *   1. 将 bbox 转为瓦片坐标范围
   *   2. 遍历范围内已加载的瓦片
   *   3. 对每个瓦片的要素：
   *      a. 检查几何是否与 bbox 相交（BBox 预筛 + 精确检测）
   *      b. 检查是否满足 filter 表达式
   *   4. 去重（跨瓦片边界的要素可能在多个瓦片中出现）
   */
  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];

  /**
   * 查询屏幕坐标下的要素（Picking）。
   * 委托给 PickingEngine（GPU Color-ID 方式）。
   *
   * ⚠️ 返回 Promise（异步）——Cursor Rules #13。
   * 原因：Picking 基于 GPU readback，需要延迟 1 帧读取 Color-ID 纹理，
   * 无法同步返回。即使结果已缓存，也返回 Promise 保持签名一致。
   *
   * @param point - [screenX, screenY] CSS 像素
   * @returns Promise，resolve 为命中的要素列表（按渲染顺序，最上层在前）
   */
  queryRenderedFeatures(point: [number, number]): Promise<Feature[]>;

  /** 当前可见的要素数量（去重后） */
  readonly visibleFeatureCount: number;

  /** 当前已加载的瓦片数量 */
  readonly loadedTileCount: number;

  // ═══════════════════════════════════════
  // Layer 生命周期
  // ═══════════════════════════════════════

  /**
   * onAdd 初始化步骤：
   *   1. StyleEngine.compile(paint) → CompiledStyle（生成 WGSL + Uniform）
   *   2. StyleEngine.compileFilter(filter) → CompiledStyle（过滤 WGSL）
   *   3. 根据 type 选择 ShaderVariantKey：
   *      fill:   { projection, geometry:'polygon', style:'fill_solid', features:[] }
   *      line:   { projection, geometry:'line', style:'stroke', features:['sdf_line'] }
   *      circle: { projection, geometry:'point', style:'fill_solid', features:[] }
   *   4. ShaderAssembler.assemble(key) → AssembledShader
   *   5. PipelineCache.getOrCreateAsync(pipelineDesc)
   *   6. 创建 perLayer Uniform Buffer
   *   7. 注册到 TileScheduler + InternalBus
   */
  onAdd(context: LayerContext): void;

  /**
   * onUpdate 每帧步骤：
   *   1. 检查 zoom 范围
   *   2. 如果 paint/layout 有变化，重新编译 CompiledStyle + 更新 Uniform
   *   3. 如果 filter 有变化，重新编译 Filter + 重新过滤已加载的瓦片数据
   */
  onUpdate(deltaTime: number, camera: CameraState): void;

  /**
   * encode 渲染步骤：
   *   遍历可见瓦片 →
   *   setPipeline → setVertexBuffer(vertices) → setIndexBuffer(indices) →
   *   setBindGroup(0, perFrame) → setBindGroup(1, perLayer) →
   *   drawIndexed(indexCount)
   *
   *   半透明图层（opacity < 1）：使用 BlendPresets.premultipliedAlpha
   *   不透明图层：使用 BlendPresets.opaque
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}
```

### 5.3 MVT 解码 + 几何处理详细步骤（Worker 端）

```
WorkerPool.submit({ type: 'mvt-decode', input: { buffer, sourceLayer, extent, type, filter } })

Worker 内部：

1. Protobuf 解码
   MVT 使用 Protocol Buffers 编码。
   逐层解析：Layer → Feature → Geometry
   命令类型：MoveTo(1), LineTo(2), ClosePath(7)
   坐标是瓦片内的相对整数坐标（extent 通常 4096 或 8192）。

2. 坐标转换
   tilePixelX = geomX / extent * tileWorldSize
   tilePixelY = geomY / extent * tileWorldSize
   mercX = tileBBox.west + tilePixelX / worldSize
   mercY = tileBBox.north - tilePixelY / worldSize（Y 轴反转）
   worldCoord = mercX * worldSize（像素单位）

3. 几何处理（按 type 分支）

   fill（多边形填充）：
     a. 将坐标展平为 [x1,y1, x2,y2, ...] Float32Array
     b. 记录洞的起始索引 holeIndices[]
     c. 调用 earcut(flatCoords, holeIndices, 2) → Uint32Array indices
     d. 每个三角形顶点：position[x,y,0], color[r,g,b,a], uv[0,0]
     e. 如果 fill-antialias：额外生成轮廓线（1px 宽）

   line（线条）：
     a. 遍历 LineString 坐标序列
     b. 对每段线段（p0→p1）：
        perpendicular = normalize(rotate90(p1 - p0))
        halfWidth = lineWidth / 2
        生成 4 个顶点：
          p0 + perpendicular * halfWidth（左）
          p0 - perpendicular * halfWidth（右）
          p1 + perpendicular * halfWidth（左）
          p1 - perpendicular * halfWidth（右）
        生成 2 个三角形（6 个索引）
     c. 拐角处理（join）：
        miter：延长两段线的偏移线直到交汇
          miterLength = halfWidth / cos(halfAngle)
          if miterLength > miterLimit * halfWidth → 改为 bevel
        bevel：平切，生成 1 个三角形连接
        round：扇形填充，段数 = ceil(angle / (π/4))，生成 N 个三角形
     d. 线帽（cap）：
        butt：无额外顶点
        square：向外延伸 halfWidth
        round：半圆，段数 = ceil(π / (π/4)) = 4
     e. 每个顶点额外属性：distToCenter（到线中心的带符号距离，用于 SDF 抗锯齿）

   circle（点圆）：
     a. 每个点生成 1 个实例数据：
        position[x,y,0], radius, color[r,g,b,a], strokeColor, strokeWidth
     b. 使用 Instanced Rendering：
        基础 quad（4 个顶点 + 6 个索引）× instanceCount 个点
     c. Fragment Shader 中 SDF 圆形：
        dist = length(fragCoord - center) - radius
        alpha = 1 - smoothstep(-aa, 0, dist)

   symbol（标注）：
     a. 提取标注位置 + 文字内容 + 图标名
     b. 不生成 GPU 几何，而是提交给 LabelManager：
        labelManager.submitLabels([{
          id, layerId, featureId, text, position, anchor, priority,
          placement, linePath, offset, rotation, allowOverlap, optional
        }])
     c. LabelManager 在碰撞检测后决定哪些标注可见
     d. 可见标注由 LabelManager 统一渲染（GlyphManager MSDF）

4. 输出打包
   vertices: Float32Array（stride 按 type 不同：fill=28字节，line=32字节，circle=40字节）
   indices:  Uint32Array
   featureIds: Uint32Array（每个三角形对应的要素 ID，用于 Picking）
   features: JSON 序列化的要素属性（CPU 端查询用）
   以上 ArrayBuffer 全部通过 Transferable 零拷贝传回主线程
```

### 5.4 与其他模块的对接

| 方向 | 对接模块 | 说明 |
|------|---------|------|
| ← 数据 | TileScheduler | 瓦片加载时机 |
| ← 数据 | WorkerPool('mvt-decode') | 几何解码 |
| → GPU | GPUUploader.uploadFromTransferable | 顶点/索引上传 |
| → GPU | ShaderAssembler | 按 type 选择 Shader 模块组合 |
| → 标注 | LabelManager.submitLabels | symbol 类型的标注提交 |
| → 查询 | PickingEngine.registerLayer | Color-ID picking |
| ← 样式 | StyleEngine.compile | paint/layout → WGSL + Uniform |
| → 事件 | InternalBus 'layer:data-changed' | 数据更新通知 |

### 5.5 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| sourceLayer 在 MVT 中不存在 | DATA_TILE_DECODE | log.warn，跳过该瓦片（不报错，因为不是所有 zoom 都有该图层） |
| earcut 三角剖分失败（退化多边形） | DATA_TILE_DECODE | 跳过该要素，log.warn 附带要素 ID |
| 线宽为 0 或负数 | — | clamp 到 minLineWidth=0.5 |
| 要素属性访问 StyleExpression 失败 | — | 使用默认值，log.debug |
| Worker 解码超时（30s） | WORKER_TIMEOUT | 标记该瓦片失败，ErrorRecovery 重试 |

---

## 6. @geoforge/layer-geojson

### 6.1 GeoJSONLayerOptions

```typescript
export interface GeoJSONLayerOptions {
  readonly id: string;

  /**
   * GeoJSON 数据。
   * string: URL，通过 fetch 加载（在 Worker 中执行，不阻塞主线程）
   * object: 内嵌 GeoJSON（FeatureCollection 或单个 Feature）
   *
   * 大数据注意：> 10MB 的 GeoJSON 建议用 URL 加载。
   * 内嵌对象会被序列化传入 Worker（有一次 structuredClone 开销）。
   */
  readonly data: string | GeoJSON.FeatureCollection | GeoJSON.Feature;

  /**
   * 渲染类型（同 VectorTileLayer）。
   */
  readonly type: 'fill' | 'line' | 'circle' | 'symbol';

  /**
   * 点聚合开关。
   * 启用后，密集点在低 zoom 下合并为聚合点，zoom in 后展开。
   * 使用 L0/algorithm/cluster.ts 中的 Supercluster 实现。
   * 仅对 Point/MultiPoint 几何有效。
   * @default false
   */
  readonly cluster?: boolean;

  /**
   * 聚合半径（像素）。
   * 在该像素半径内的点合并为一个聚合点。
   * @unit CSS 像素
   * @range [1, 500]
   * @default 50
   */
  readonly clusterRadius?: number;

  /**
   * 最大聚合 zoom。
   * 超过此 zoom 后不再聚合，显示原始点。
   * @range [0, maxZoom-1]
   * @default 14
   */
  readonly clusterMaxZoom?: number;

  /**
   * 聚合属性统计。
   * 定义如何聚合要素属性。
   *
   * @example
   * {
   *   totalPopulation: ['+', ['get', 'population']],  // 求和
   *   maxHeight: ['max', ['get', 'height']],           // 取最大值
   * }
   */
  readonly clusterProperties?: Record<string, [string, any]>;

  readonly filter?: FilterExpression;
  readonly paint?: Record<string, any>;
  readonly layout?: Record<string, any>;

  /**
   * 线简化容差。
   * geojson-vt 切片时使用 Douglas-Peucker 简化几何。
   * 值越大简化越多（文件越小但精度越低）。
   * @range [0, 10]
   * @default 0.375
   */
  readonly tolerance?: number;

  /**
   * 瓦片缓冲区（像素）。
   * 瓦片边界向外扩展此像素数来获取几何数据，避免跨瓦片接缝。
   * @unit 像素
   * @range [0, 512]
   * @default 128
   */
  readonly buffer?: number;

  /**
   * 数据更新时是否保留已渲染的旧瓦片（平滑过渡）。
   * true: 旧瓦片保留到新数据处理完成
   * false: 立即清除旧瓦片（可能闪烁）
   * @default true
   */
  readonly keepStaleOnUpdate?: boolean;
}
```

### 6.2 GeoJSONLayer 公共接口

```typescript
export interface GeoJSONLayer extends Layer {
  // ═══════════════════════════════════════
  // 数据更新
  // ═══════════════════════════════════════

  /**
   * 替换全部数据。
   * 触发完整的重处理流程（见 6.3 管线详细步骤）。
   *
   * @param data - 新的 GeoJSON（URL 或对象）
   *
   * 流程：
   *   1. 如果 keepStaleOnUpdate=true，标记现有瓦片为 stale（继续渲染但不更新）
   *   2. 将新数据发送到 Worker
   *   3. Worker 重建 geojson-vt 索引 + Supercluster（如果启用）
   *   4. TileScheduler 重新请求当前可见瓦片
   *   5. 新瓦片加载完成后替换 stale 瓦片
   *   6. InternalBus.emit('layer:data-changed', { layerId })
   */
  setData(data: string | GeoJSON.FeatureCollection | GeoJSON.Feature): void;

  /**
   * 获取当前数据。
   * 返回最近一次 setData/构造函数传入的原始数据。
   * 注意：如果数据是 URL，返回的是解析后的 FeatureCollection。
   */
  getData(): FeatureCollection;

  // ═══════════════════════════════════════
  // 聚合查询
  // ═══════════════════════════════════════

  /**
   * 获取聚合点展开所需的 zoom 级别。
   * 即从哪个 zoom 开始该聚合点会分裂为子点。
   *
   * @param clusterId - 聚合点 ID（Feature 的 id 字段，由 Supercluster 分配）
   * @returns 展开 zoom 级别
   * @throws GeoForgeError(DATA) 如果 clusterId 不存在
   *
   * 内部：委托给 Worker 中缓存的 Supercluster.getClusterExpansionZoom(clusterId)
   */
  getClusterExpansionZoom(clusterId: number): number;

  /**
   * 获取聚合点的直接子节点。
   * 子节点可能是原始点或更小的子聚合点。
   *
   * @param clusterId - 聚合点 ID
   * @returns 子节点 Feature 数组
   * @throws GeoForgeError(DATA) 如果 clusterId 不存在
   */
  getClusterChildren(clusterId: number): Feature[];

  /**
   * 获取聚合点包含的所有原始点（叶子节点）。
   *
   * @param clusterId - 聚合点 ID
   * @param limit - 最大返回数量，默认 100
   * @param offset - 分页偏移，默认 0
   * @returns 原始点 Feature 数组
   */
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): Feature[];

  // ═══════════════════════════════════════
  // 要素查询
  // ═══════════════════════════════════════

  /**
   * 同 VectorTileLayer.queryFeatures
   */
  queryFeatures(bbox: BBox2D, filter?: FilterExpression): Feature[];

  /**
  /**
   * 同 VectorTileLayer.queryRenderedFeatures（异步，Cursor Rules #13）
   */
  queryRenderedFeatures(point: [number, number]): Promise<Feature[]>;

  /** 当前 zoom 下的要素数量（如果有聚合，是聚合后的数量） */
  readonly visibleFeatureCount: number;

  /** 原始数据中的总要素数量 */
  readonly totalFeatureCount: number;

  // ═══════════════════════════════════════
  // Layer 生命周期
  // ═══════════════════════════════════════

  /**
   * onAdd 步骤：
   *   1. 同 VectorTileLayer：编译 Shader / 创建 Pipeline / 注册 TileScheduler
   *   2. 额外：将初始 data 发送到 Worker 进行 geojson-vt 切片预处理
   *   3. 如果 cluster=true，同时初始化 Supercluster
   */
  onAdd(context: LayerContext): void;

  /**
   * onRemove 步骤：
   *   1. 同 VectorTileLayer：释放 GPU 资源
   *   2. 额外：通知 Worker 释放 geojson-vt 和 Supercluster 的内存
   */
  onRemove(): void;
}
```

### 6.3 数据处理管线详细步骤

```
═══ 阶段 1：数据加载 ═══

if (data 是 string/URL) {
  // 在 Worker 中 fetch，避免阻塞主线程
  WorkerPool.submit({
    type: 'geojson-parse',
    input: { action: 'load', url: data }
  })
  → Worker: fetch(url) → response.text() → JSON.parse()
} else {
  // 内嵌对象通过 structuredClone 传入 Worker
  WorkerPool.submit({
    type: 'geojson-parse',
    input: { action: 'init', geojson: data },
    transferables: []  // 无法 transfer JSON 对象
  })
}

═══ 阶段 2：Worker 端预处理 ═══

Worker 内部（接收到 'init' 或 'load' 完成后）：

2a. geojson-vt 切片
  import { createIndex } from './geojson-vt';

  vtIndex = createIndex(geojson, {
    maxZoom: clusterMaxZoom + 1,  // 比聚合多一级
    tolerance: options.tolerance,  // Douglas-Peucker 容差
    buffer: options.buffer,        // 瓦片缓冲像素
    extent: 4096,                  // 瓦片内部坐标精度
    generateId: true,              // 为每个要素生成唯一 ID
  });

  vtIndex 是一个 Map<string, TileFeature[]>，key 是 z/x/y 字符串。
  vtIndex 缓存在 Worker 内存中，后续 getTile 直接查表。

2b. Supercluster 聚合（如果 cluster=true）
  import { Supercluster } from '@geoforge/core/algorithm/cluster';

  const points = geojson.features
    .filter(f => f.geometry.type === 'Point')
    .map(f => ({
      x: f.geometry.coordinates[0],
      y: f.geometry.coordinates[1],
      properties: f.properties,
      id: f.id,
    }));

  clusterIndex = new Supercluster({
    radius: clusterRadius,
    maxZoom: clusterMaxZoom,
    minZoom: 0,
    map: (props) => clusterProperties 的 map 函数,
    reduce: (accumulated, props) => clusterProperties 的 reduce 函数,
  });
  clusterIndex.load(points);

  clusterIndex 也缓存在 Worker 内存中。

═══ 阶段 3：瓦片请求（每帧按需）═══

TileScheduler 请求某个 TileCoord：
  WorkerPool.submit({
    type: 'geojson-parse',
    input: { action: 'getTile', x, y, z, cluster: options.cluster }
  })

  Worker 内部：
    if (cluster && z <= clusterMaxZoom) {
      // 从 Supercluster 获取聚合后的点
      features = clusterIndex.getClusters(tileBBox, z);
    } else {
      // 从 geojson-vt 获取切片
      tile = vtIndex.getTile(z, x, y);
      features = tile ? tile.features : [];
    }

    // 几何处理同 VectorTileLayer Worker 端（earcut/宽线/点精灵/标注）
    // 打包为 Float32Array + Uint32Array + Transferable
    return { vertices, indices, featureIds, features: JSON.stringify(featureProps) };

═══ 阶段 4：setData() 更新流程 ═══

主线程：
  1. if (keepStaleOnUpdate) markAllTilesStale()
  2. WorkerPool.submit({ type: 'geojson-parse', input: { action: 'init', geojson: newData } })
  3. Worker 重建 vtIndex + clusterIndex
  4. Worker 返回 'ready' 信号
  5. TileScheduler.reloadAll()（触发所有可见瓦片重新请求）
  6. 新瓦片加载完成后替换 stale 瓦片
  7. InternalBus.emit('layer:data-changed', { layerId: this.id })
```

### 6.4 与其他模块的对接

| 方向 | 对接模块 | 说明 |
|------|---------|------|
| → Worker | WorkerPool('geojson-parse') | 数据加载 + geojson-vt + Supercluster |
| → Worker | 内部复用 'mvt-decode' 的几何处理逻辑 | earcut / 宽线 / 点精灵 |
| ← 数据 | TileScheduler | 瓦片请求调度 |
| → GPU | GPUUploader.uploadFromTransferable | 上传几何数据 |
| → 标注 | LabelManager.submitLabels | symbol 类型 |
| → 事件 | InternalBus 'layer:data-changed' | setData 后通知 |

### 6.5 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| URL fetch 失败 | DATA_TILE_LOAD | ErrorRecovery 重试 3 次 |
| JSON 解析失败 | DATA_GEOJSON_PARSE | throw GeoForgeError 附带前 100 字符 |
| GeoJSON 不符合 RFC 7946 | DATA_GEOJSON_PARSE | 尝试修复（缺少 type 字段时自动推断）+ log.warn |
| clusterId 不存在 | DATA_SOURCE_NOT_FOUND | throw GeoForgeError |
| Worker geojson-vt 崩溃 | WORKER_CRASH | ErrorRecovery 重启 Worker + 重建索引 |
| 数据 > 100MB | — | log.warn 建议使用矢量瓦片格式 |

---

## P0 完整统计

| 包 | 接口方法数 | 内部结构 | 对接模块 | 错误场景 |
|---|-----------|---------|---------|---------|
| camera-2d | 20 | 15 字段 + 7 缓冲 | 7 个 | 6 种 |
| camera-25d | 25 | 21 字段 | 8 个 | 同上 + 2 |
| camera-3d | 30 | 23 字段 + 3 缓冲 | 9 个 | 10 种 |
| layer-tile-raster | 12 | 2 结构 + 1 WGSL | 6 个 | 5 种 |
| layer-tile-vector | 8 | 复用 raster 结构 | 8 个 | 5 种 |
| layer-geojson | 10 | 复用 vector + cluster | 6 个 | 6 种 |
| **合计** | **105** | | | **~34 种** |

---

## 7. 质量属性补充（适用于全部 3 个图层包）

### 7.1 WGSL 完整代码（缺口 #5）

#### style/fill_solid.wgsl

```wgsl
// 标准签名：fn computeColor(input: FragmentInput) -> vec4<f32>

struct FillUniforms {
  fillColor: vec4<f32>,              // RGBA 填充颜色
  fillOpacity: f32,                  // 透明度 [0, 1]
  _pad: vec3<f32>,                   // 对齐到 32 bytes
};
@group(1) @binding(0) var<uniform> style: FillUniforms;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  // 如果有数据驱动样式（per-vertex color），使用顶点颜色
  var color = select(style.fillColor, input.color, input.color.a > 0.0);
  color.a *= style.fillOpacity;
  return color;
}
```

#### style/stroke.wgsl + feature/sdf_line.wgsl

```wgsl
// 线条渲染 = stroke 样式 + SDF 抗锯齿

struct LineUniforms {
  lineColor: vec4<f32>,              // RGBA 线颜色
  lineWidth: f32,                    // 像素宽度
  lineOpacity: f32,                  // 透明度 [0, 1]
  antialias: f32,                    // 抗锯齿范围（像素），默认 1.0
  _pad: f32,
};
@group(1) @binding(0) var<uniform> style: LineUniforms;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  var color = style.lineColor;

  // input.varyings.x = distToCenter（到线中心的带符号距离，像素单位）
  // 由 geometry/line.wgsl 的 processVertex 写入
  let dist = abs(input.varyings.x);
  let halfWidth = style.lineWidth * 0.5;
  let aa = style.antialias;

  // SDF 抗锯齿：在线边缘 [halfWidth-aa, halfWidth] 范围内平滑过渡
  // 线内部 alpha=1，边缘渐变到 alpha=0
  let alpha = 1.0 - smoothstep(halfWidth - aa, halfWidth, dist);

  color.a *= alpha * style.lineOpacity;

  // 虚线处理（如果 dasharray 激活）
  // input.varyings.y = 沿线方向的累计距离（像素）
  // dashPattern 在 CPU 端编码为纹理或 Uniform 数组
  // let dashPhase = fract(input.varyings.y / dashPeriod);
  // let isDash = step(dashRatio, dashPhase);
  // if (isDash < 0.5) { discard; }

  return color;
}
```

#### geometry/point.wgsl（点圆 SDF）

```wgsl
// 点精灵 Instanced Quad + SDF 圆形

struct CircleUniforms {
  circleColor: vec4<f32>,            // 填充颜色
  circleRadius: f32,                 // 像素半径
  circleOpacity: f32,                // 透明度
  strokeColor: vec4<f32>,            // 描边颜色
  strokeWidth: f32,                  // 描边宽度（像素）
  _pad: f32,
};
@group(1) @binding(0) var<uniform> style: CircleUniforms;

// processVertex 将每个点扩展为 2×2 quad：
// 实例属性：position[x,y,z], 每实例 1 个 quad
// quad 偏移 = [(-1,-1), (1,-1), (-1,1), (1,1)] * (radius + strokeWidth) / viewport
// 输出 varyings.xy = quad 内局部坐标 [-1, 1]

fn computeColor(input: FragmentInput) -> vec4<f32> {
  let localPos = input.varyings.xy;
  let dist = length(localPos);                                    // [0, ~1.414]

  let totalRadius = style.circleRadius + style.strokeWidth;       // 总半径（像素）
  let outerEdge = 1.0;                                            // 归一化外边缘
  let innerEdge = style.circleRadius / totalRadius;               // 归一化内边缘（填充/描边分界）
  let aa = 1.0 / totalRadius;                                     // 每像素的归一化距离

  // 外边缘 SDF（圆之外完全透明）
  let outerAlpha = 1.0 - smoothstep(outerEdge - aa, outerEdge, dist);

  // 内边缘 SDF（区分填充区和描边区）
  let strokeFactor = smoothstep(innerEdge - aa, innerEdge, dist); // 0=填充区 1=描边区

  // 颜色混合：内部填充色，外圈描边色
  var color = mix(style.circleColor, style.strokeColor, strokeFactor);
  color.a *= outerAlpha * style.circleOpacity;

  // 完全透明则 discard（避免深度写入影响后面的要素）
  if (color.a < 0.001) { discard; }

  return color;
}
```

### 7.2 GPU 走 L1 显式标注（缺口 #7）

```
所有图层代码中的 GPU 操作必须通过 L1 模块，禁止直接 device.* 调用：

纹理创建：
  ✅ GPUUploader.uploadTexture(imageBitmap, { format, label })    // L1/uploader.ts
  ❌ device.createTexture(...)                                    // 禁止

顶点/索引数据上传：
  ✅ GPUUploader.uploadFromTransferable(arrayBuffer, VERTEX|INDEX) // L1/uploader.ts
  ❌ device.createBuffer(...)                                     // 禁止

Uniform 更新：
  ✅ GPUUploader.writeUniform(handle, writer.getData())           // L1/uploader.ts
  ❌ device.queue.writeBuffer(buffer, ...)                        // 禁止

Pipeline 创建：
  ✅ PipelineCache.getOrCreateAsync(descriptor)                   // L2/pipeline-cache.ts
  ❌ device.createRenderPipeline(...)                             // 禁止

BindGroup 创建：
  ✅ BindGroupCache.getOrCreate(descriptor)                       // L1/bind-group-cache.ts
  ❌ device.createBindGroup(...)                                  // 禁止

资源释放：
  ✅ TextureManager.release(handle)                               // L1/texture-manager.ts
  ✅ BufferPool.release(handle)                                   // L1/buffer-pool.ts
  ❌ texture.destroy() / buffer.destroy()                         // 禁止
```

### 7.3 宽线拐角/线帽完整算法（缺口 #11）

#### Miter Join（斜接拐角）

```
输入：线段 A→B 和 B→C 的拐角点 B
      halfWidth = lineWidth / 2

1. 计算两段线段的单位方向：
   dirAB = normalize(B - A)
   dirBC = normalize(C - B)

2. 计算两段线段的法向量（垂直于方向，逆时针旋转 90°）：
   normalAB = vec2(-dirAB.y, dirAB.x)
   normalBC = vec2(-dirBC.y, dirBC.x)

3. 计算 miter 方向（两个法向量的角平分线）：
   miterDir = normalize(normalAB + normalBC)

4. 计算 miter 长度（法向量在 miter 方向上的投影）：
   cosHalfAngle = dot(miterDir, normalAB)
   miterLength = halfWidth / cosHalfAngle

5. Miter Limit 检查（防止极锐角产生超长尖角）：
   if (miterLength > miterLimit * halfWidth) {
     // 退化为 Bevel Join
     goto Bevel Join
   }

6. 生成 miter 顶点：
   miterLeft  = B + miterDir * miterLength
   miterRight = B - miterDir * miterLength

7. 连接前段和后段：
   三角形 1: [prevLeft, miterLeft, prevRight]
   三角形 2: [prevRight, miterLeft, miterRight]
   更新 prevLeft = miterLeft, prevRight = miterRight
```

#### Bevel Join（平切拐角）

```
输入：同上

1. 计算前段端点和后段起点的偏移顶点：
   leftAB  = B + normalAB * halfWidth
   rightAB = B - normalAB * halfWidth
   leftBC  = B + normalBC * halfWidth
   rightBC = B - normalBC * halfWidth

2. 判断拐角方向：
   cross = dirAB.x * dirBC.y - dirAB.y * dirBC.x

3. 如果左转 (cross > 0)：
   // 右侧有缺口需要填充
   三角形: [rightAB, B, rightBC]        // 填充三角形
   左侧: leftAB → leftBC 直接连接

4. 如果右转 (cross < 0)：
   三角形: [leftAB, B, leftBC]          // 填充三角形
   右侧: rightAB → rightBC 直接连接

5. 更新 prevLeft/prevRight 为 leftBC/rightBC
```

#### Round Join（圆角拐角）

```
输入：同上

1. 计算拐角角度：
   angle = acos(clamp(dot(normalAB, normalBC), -1, 1))

2. 确定段数（每 45° 一段，至少 2 段）：
   segments = max(2, ceil(angle / (π / 4)))

3. 判断拐角方向并确定需要填充扇形的一侧：
   cross = dirAB.x * dirBC.y - dirAB.y * dirBC.x
   startNormal = cross > 0 ? -normalAB : normalAB  // 需要圆角的一侧
   totalAngle = cross > 0 ? -angle : angle          // 旋转方向

4. 逐段生成扇形三角形：
   for (i = 0; i <= segments; i++) {
     t = i / segments
     theta = totalAngle * t
     // 旋转法向量（注意：角度插值，不是线性插值向量！）
     rotatedNormal = vec2(
       startNormal.x * cos(theta) - startNormal.y * sin(theta),
       startNormal.x * sin(theta) + startNormal.y * cos(theta)
     )
     vertex = B + rotatedNormal * halfWidth
     if (i > 0) {
       三角形: [B, prevVertex, vertex]
     }
     prevVertex = vertex
   }

5. 另一侧（无缺口的一侧）：使用 miter 或 bevel 逻辑
```

#### Butt Cap（平头线帽）

```
线段端点处不添加额外顶点。
端点的左右偏移顶点直接构成线末端：

  left  = endpoint + normal * halfWidth
  right = endpoint - normal * halfWidth
  // 无额外三角形，线段在此截止
```

#### Square Cap（方形线帽）

```
线段端点处沿线方向向外延伸 halfWidth：

  tangent = normalize(direction)   // 线段方向
  capLeft  = endpoint + tangent * halfWidth + normal * halfWidth
  capRight = endpoint + tangent * halfWidth - normal * halfWidth

  三角形 1: [left, right, capLeft]
  三角形 2: [right, capRight, capLeft]
  // 产生一个正方形的线帽
```

#### Round Cap（圆形线帽）

```
端点处生成半圆：

  segments = max(4, ceil(π / (π / 4)))   // 通常 4 段

  for (i = 0; i <= segments; i++) {
    t = i / segments
    theta = π * t                        // 从一侧法线扫到另一侧
    // 以线段方向为基准旋转
    angle = tangentAngle + theta         // tangentAngle = atan2(dir.y, dir.x)
    vertex = endpoint + vec2(cos(angle), sin(angle)) * halfWidth
    if (i > 0) {
      三角形: [endpoint, prevVertex, vertex]
    }
    prevVertex = vertex
  }
```

### 7.4 ObjectPool 使用点（缺口 #1）

```
layer-tile-raster:
  1. 每帧 encode() 中的 Uniform 数据写入：
     const writer = uniformWriterPool.acquire();  // ObjectPool<UniformWriter>
     writer.setFloat('brightnessMin', ...);
     ...
     gpuUploader.writeUniform(buffer, writer.getData());
     uniformWriterPool.release(writer);

  2. RasterTileRenderData 不需要池化（生命周期跟瓦片一致，不是帧内临时）

layer-tile-vector:
  1. 同上：Uniform Writer 池化
  2. queryFeatures 返回的 Feature[] 不池化（返回给用户，生命周期不可控）

layer-geojson:
  1. 同上
  2. setData 时的中间状态标记不池化（一次性操作）
```

### 7.5 __DEV__ 条件编译标注（缺口 #2）

```
layer-tile-raster:
  if (__DEV__) {
    // paint 属性范围检查
    if (brightness < -1 || brightness > 1)
      logger.warn('[raster] brightness 超出 [-1,1] 范围，已 clamp');
    // 瓦片加载性能日志
    logger.debug(`[raster] tile ${coord} loaded in ${loadMs}ms, decoded in ${decodeMs}ms`);
  }

layer-tile-vector:
  if (__DEV__) {
    // sourceLayer 存在性检查 + 友好错误消息
    if (!mvtLayers.includes(sourceLayer))
      logger.warn(`[vector] sourceLayer "${sourceLayer}" 不在 MVT 中，可用图层: ${mvtLayers.join(', ')}`);
    // paint/layout 属性名拼写检查
    for (const key of Object.keys(paint))
      if (!KNOWN_PAINT_PROPS.has(key))
        logger.warn(`[vector] 未知 paint 属性 "${key}"，是否拼写错误？相似: ${findSimilar(key, KNOWN_PAINT_PROPS)}`);
    // earcut 退化多边形警告
    if (deviation > 0.01)
      logger.warn(`[vector] earcut 面积偏差 ${(deviation*100).toFixed(1)}%，要素 ${featureId} 可能有自相交`);
  }

layer-geojson:
  if (__DEV__) {
    // 数据大小警告
    const sizeStr = (jsonStr.length / 1024 / 1024).toFixed(1);
    if (jsonStr.length > 100 * 1024 * 1024)
      logger.warn(`[geojson] 数据 ${sizeStr}MB 过大，建议使用矢量瓦片格式`);
    // GeoJSON 格式修复日志
    if (!geojson.type) logger.warn('[geojson] 缺少 type 字段，自动推断为 FeatureCollection');
  }
```

### 7.6 @stability 标注（缺口 #3）

```
@stability stable:
  layer-*: onAdd / onRemove / onUpdate / encode / encodePicking
  layer-*: visible / opacity / zIndex / id / type / source
  layer-*: setPaintProperty / setLayoutProperty / getPaintProperty / getLayoutProperty
  layer-geojson: setData / getData
  layer-raster: setBrightness / setContrast / setSaturation / setHueRotate

@stability experimental:
  layer-vector/geojson: queryFeatures / queryRenderedFeatures
  layer-geojson: getClusterExpansionZoom / getClusterChildren / getClusterLeaves
  layer-raster: setFadeDuration

@stability internal:
  RasterTileRenderData / RasterStyleUniforms（全部内部结构）
  MVT 解码管线中间数据格式
  Worker 通信协议（action/input/output 格式）
```

### 7.7 Tree-Shaking 导出规范（缺口 #9）

```typescript
// layer-tile-raster/src/index.ts
export { createRasterTileLayer } from './RasterTileLayer';
export type { RasterTileLayer, RasterTileLayerOptions } from './RasterTileLayer';

// layer-tile-vector/src/index.ts
export { createVectorTileLayer } from './VectorTileLayer';
export type { VectorTileLayer, VectorTileLayerOptions } from './VectorTileLayer';

// layer-geojson/src/index.ts
export { createGeoJSONLayer } from './GeoJSONLayer';
export type { GeoJSONLayer, GeoJSONLayerOptions } from './GeoJSONLayer';

// ❌ 禁止
export default RasterTileLayer;              // 禁止 default export
import './side-effect-registration';         // 禁止顶层副作用 import

// 图层工厂函数通过 LayerManager.registerLayerType 注册，
// 不在包入口执行注册（否则 import 即产生副作用）：
//
// ✅ 正确（在 preset-2d/init.ts 中集中注册）：
//   import { createRasterTileLayer } from '@geoforge/layer-tile-raster';
//   layerManager.registerLayerType('raster', createRasterTileLayer);
//
// ❌ 错误（在 layer-tile-raster/index.ts 中自动注册）：
//   LayerManager.registerLayerType('raster', createRasterTileLayer); // 顶层副作用
```

### 7.8 Context / safeExecute 适用性说明

```
layer-tile-raster/vector/geojson 是引擎内部包，不是 EP1~EP6 扩展。
它们通过 LayerManager.registerLayerType 注册，由引擎直接实例化。

因此：
  ✅ 服务注入通过 onAdd(context: LayerContext)，不是 CustomLayerContext
  ✅ 不需要 safeExecute 包裹（引擎内部代码，错误直接向上传播）
  ✅ 可以 import 引擎内部模块（如 @geoforge/core/algorithm/earcut）

但如果用户通过 EP1 注册的自定义图层，则：
  ❌ 不能 import 引擎内部模块
  ✅ 必须通过 CustomLayerContext 获取服务
  ✅ 引擎用 safeExecute 包裹其 onAdd/encode 等回调
```
