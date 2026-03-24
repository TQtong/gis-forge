# GeoForge 可选功能包完整接口设计 — P2 增强包（上）

> layer-heatmap / layer-pointcloud / layer-marker / layer-extrusion / interaction-draw / interaction-measure / interaction-select

---

## 1. @geoforge/layer-heatmap

### 1.1 HeatmapLayerOptions

```typescript
export interface HeatmapLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly sourceLayer?: string;
  readonly paint?: {
    /**
     * 热力核半径（像素）。
     * 每个点以此半径的高斯核叠加到密度纹理。
     * 值越大热力越"模糊"，值越小越"锐利"。
     * @unit CSS 像素
     * @range [1, 200]
     * @default 30
     */
    'heatmap-radius'?: number | StyleExpression;

    /**
     * 热力权重。
     * 每个点对密度贡献的权重系数。
     * 可用数据驱动：['get', 'magnitude']（如地震震级）。
     * @range [0, 1]
     * @default 1
     */
    'heatmap-weight'?: number | StyleExpression;

    /**
     * 热力强度（全局乘数）。
     * 通常随 zoom 插值：低 zoom 减弱（避免过亮），高 zoom 增强。
     * @range [0, 10]
     * @default 1
     */
    'heatmap-intensity'?: number | StyleExpression;

    /**
     * 颜色渐变映射。
     * 将归一化密度值 [0, 1] 映射到颜色。
     * 默认：蓝(0) → 青(0.25) → 绿(0.5) → 黄(0.75) → 红(1)。
     * 使用 interpolate 表达式定义。
     *
     * @example
     * ['interpolate', ['linear'], ['heatmap-density'],
     *   0,   'rgba(0,0,255,0)',
     *   0.2, 'royalblue',
     *   0.4, 'cyan',
     *   0.6, 'lime',
     *   0.8, 'yellow',
     *   1,   'red'
     * ]
     */
    'heatmap-color'?: StyleExpression;

    /**
     * 整体透明度。
     * @range [0, 1]
     * @default 1
     */
    'heatmap-opacity'?: number | StyleExpression;
  };
  readonly minzoom?: number;
  /** 超过此 zoom 自动切换为 circle 渲染（点足够分散时热力图无意义）。@default 无限制 */
  readonly maxzoom?: number;
  readonly filter?: FilterExpression;
}
```

### 1.2 内部数据结构

```typescript
/**
 * 热力图离屏密度纹理。
 * Pass 1 将所有点的高斯核叠加到此纹理（additive blend）。
 */
interface HeatmapDensityTexture {
  /** R16F 浮点纹理（单通道密度值） */
  readonly texture: TextureHandle;
  /** 纹理宽高（通常 = viewport 物理像素 / 2，半分辨率节省性能） */
  readonly width: number;
  readonly height: number;
  /** 上一帧的最大密度值（用于归一化），指数平滑避免闪烁 */
  maxDensity: number;
}

/**
 * 颜色渐变 LUT 纹理。
 * 将 heatmap-color 表达式预计算为 256×1 RGBA8 纹理。
 * Fragment Shader 用密度值采样此纹理获取颜色。
 */
interface ColorRampTexture {
  readonly texture: TextureHandle;
  readonly width: 256;
  readonly height: 1;
}
```

### 1.3 HeatmapLayer 接口

```typescript
export interface HeatmapLayer extends Layer {
  /** @stability stable */
  readonly type: 'heatmap';

  // ═══════════════════════════════════════
  // Layer 生命周期
  // ═══════════════════════════════════════

  /**
   * onAdd 步骤：
   *   1. 创建离屏密度纹理（R16F，viewport/2 尺寸）
   *   2. 创建 colorRamp LUT 纹理（256×1 RGBA8）
   *   3. 编译 2 个 Pipeline：
   *      Pass 1（密度累加）：geometry='point_quad' + style='heatmap_gaussian' + blend=additive
   *      Pass 2（颜色映射）：fullscreen quad + style='heatmap_colorize'
   *   4. 注册 TileScheduler
   *
   * @stability stable
   */
  onAdd(context: LayerContext): void;

  /**
   * encode 两 Pass 渲染：
   *
   * Pass 1（离屏 → 密度纹理）：
   *   renderTarget = densityTexture（R16F）
   *   clearColor = [0, 0, 0, 0]
   *   blendState = additive（src × 1 + dst × 1）
   *   for each point:
   *     // Instanced quad，每个点扩展为 radius×2 的正方形
   *     // Vertex Shader: 将点位投影到屏幕 → quad 偏移 [-radius, radius]
   *     // Fragment Shader:
   *     //   dist = length(fragCoord - pointCenter) / radius
   *     //   gaussian = exp(-dist² × 4.0) × weight
   *     //   output.r = gaussian
   *     draw(6, pointCount)  // 6 vertices per quad × N instances
   *
   * Pass 2（屏幕 → 最终颜色）：
   *   renderTarget = 屏幕（或 compositing input）
   *   blendState = premultipliedAlpha
   *   fullscreen quad:
   *     // Fragment Shader:
   *     //   density = textureSample(densityTex, uv).r × intensity
   *     //   normalizedDensity = clamp(density / maxDensity, 0, 1)
   *     //   color = textureSample(colorRampTex, vec2(normalizedDensity, 0.5))
   *     //   color.a *= heatmapOpacity
   *     draw(6)
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;

  // ═══════════════════════════════════════
  // 性能 / 降级
  // ═══════════════════════════════════════
  //
  // 点数 > 50000 时：
  //   PerformanceManager 降级：降低密度纹理分辨率（viewport/4）
  //   或切换为 Compute Shader 直方图模式（GPU 并行累加）
  //
  // zoom > maxzoom 时：
  //   自动切换为 circle 渲染（每个点画独立圆，不做密度混合）
}

export function createHeatmapLayer(options: HeatmapLayerOptions): HeatmapLayer;
```

### 1.4 WGSL

```wgsl
// === style/heatmap_gaussian.wgsl（Pass 1）===
struct HeatmapUniforms {
  radius: f32,        // 像素半径
  intensity: f32,
  _pad: vec2<f32>,
};
@group(1) @binding(0) var<uniform> style: HeatmapUniforms;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  // input.varyings.xy = quad 内局部坐标 [-1, 1]
  let dist = length(input.varyings.xy);
  if (dist > 1.0) { discard; }
  // 高斯核：σ=0.5 → 4.0 是经验衰减系数
  let gaussian = exp(-dist * dist * 4.0);
  // weight 来自 per-vertex attribute（数据驱动）
  let weight = input.color.r;  // weight 编码在 color.r 中
  return vec4<f32>(gaussian * weight * style.intensity, 0.0, 0.0, 1.0);
}
```

```wgsl
// === style/heatmap_colorize.wgsl（Pass 2）===
@group(1) @binding(0) var<uniform> params: vec4<f32>;  // [maxDensity, opacity, 0, 0]
@group(3) @binding(0) var densitySampler: sampler;
@group(3) @binding(1) var densityTex: texture_2d<f32>;
@group(3) @binding(2) var colorRampSampler: sampler;
@group(3) @binding(3) var colorRampTex: texture_2d<f32>;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  let density = textureSample(densityTex, densitySampler, input.uv).r;
  let normalized = clamp(density / params.x, 0.0, 1.0);  // params.x = maxDensity
  var color = textureSample(colorRampTex, colorRampSampler, vec2<f32>(normalized, 0.5));
  color.a *= params.y;  // params.y = opacity
  if (color.a < 0.001) { discard; }
  return color;
}
```

### 1.5 对接 / 错误 / 常量

```
对接：TileScheduler → WorkerPool(点数据提取) → GPUUploader → 2-Pass 渲染 → Compositor
      InternalBus 'layer:data-changed' / PerformanceManager 降级

错误：
  | 密度纹理创建 OOM | GPU_BUFFER_OOM | 降低分辨率到 viewport/4 重试 |
  | colorRamp 表达式无效 | CONFIG_INVALID_PARAM | 使用默认蓝→红渐变 |
  | 点数为 0 | — | 跳过渲染，不报错 |

常量：
  DEFAULT_HEATMAP_RADIUS = 30
  DEFAULT_HEATMAP_INTENSITY = 1.0
  DENSITY_TEXTURE_SCALE = 0.5        // 密度纹理 = viewport × 0.5
  GAUSSIAN_DECAY = 4.0               // 高斯衰减系数
  COLOR_RAMP_WIDTH = 256
  MAX_DENSITY_SMOOTH_FACTOR = 0.9    // maxDensity 指数平滑系数
```

---

## 2. @geoforge/layer-pointcloud

### 2.1 PointCloudLayerOptions

```typescript
export interface PointCloudLayerOptions {
  readonly id: string;
  readonly source: string;
  /** 点大小 @unit 像素 @range [0.5, 50] @default 2.0 */
  readonly pointSize?: number;
  /** 点大小随距离衰减 @default 'adaptive' */
  readonly sizeAttenuation?: 'fixed' | 'adaptive';
  /** 点形状 @default 'circle' */
  readonly shape?: 'circle' | 'square';
  /**
   * 着色模式。
   * 'rgb':            使用点云原始 RGB 颜色
   * 'height':         按高度着色（需要 heightColorRamp）
   * 'intensity':      按反射强度着色（灰度）
   * 'classification': 按 LAS 分类码着色（需要 classificationColors）
   * @default 'rgb'
   */
  readonly colorMode?: 'rgb' | 'height' | 'intensity' | 'classification';
  /** 高度着色渐变 @default 蓝(低)→绿→黄→红(高) */
  readonly heightColorRamp?: Array<{ value: number; color: string }>;
  /** 分类码颜色映射（LAS 标准分类） @example { 2: '#8B4513', 6: '#00FF00' } // 地面=棕,建筑=绿 */
  readonly classificationColors?: Record<number, string>;
  /** Eye-Dome Lighting 强度 @range [0, 5] @default 1.0 */
  readonly edlStrength?: number;
  /** EDL 采样半径 @unit 像素 @range [0.5, 5] @default 1.4 */
  readonly edlRadius?: number;
  /** 最大渲染点数 @range [100000, 50000000] @default 5000000 */
  readonly maxPoints?: number;
}
```

### 2.2 PointCloudLayer 接口

```typescript
export interface PointCloudLayer extends Layer {
  /** @stability stable */
  readonly type: 'pointcloud';

  /** 当前渲染的点数 @stability stable */
  readonly renderedPointCount: number;
  /** 点云包围盒 @stability experimental */
  getBounds(): BBox3D | null;
  /** @stability stable */
  setColorMode(mode: 'rgb' | 'height' | 'intensity' | 'classification'): void;
  /** @stability stable */
  setPointSize(size: number): void;
  /** @stability experimental */
  setEDL(strength: number, radius?: number): void;

  /**
   * 渲染管线：
   *
   * 数据加载：支持 3D Tiles pnts 格式 或 LAS/LAZ（Worker 解码）
   * LOD：八叉树层级结构，SSE 驱动（同 3DTiles 的 BVH 遍历）
   *
   * 主 Pass：
   *   Instanced rendering：基础 quad(4 顶点) × instanceCount 个点
   *   Vertex Shader：
   *     点位 → 投影到屏幕
   *     if (sizeAttenuation === 'adaptive')
   *       screenSize = pointSize / clipPos.w × viewport.height  // 远处点变小
   *     else
   *       screenSize = pointSize
   *     quad 偏移 = [-1,-1],[1,-1],[-1,1],[1,1] × screenSize / viewport
   *   Fragment Shader：
   *     if (shape === 'circle')
   *       dist = length(localPos); if (dist > 1.0) discard;
   *       alpha = 1.0 - smoothstep(0.8, 1.0, dist);  // 边缘柔化
   *     颜色：根据 colorMode 选择
   *       'rgb':            直接使用 vertex color
   *       'height':         height → colorRamp LUT 查表
   *       'intensity':      intensity → grayscale
   *       'classification': classId → classificationColors LUT 查表
   *
   * EDL 后处理 Pass（可选）：
   *   读取深度纹理，采样当前像素 + 上下左右 4 邻居
   *   edlResponse = Σ max(0, log2(depthCenter) - log2(depthNeighbor))
   *   occlusion = exp(-edlResponse × edlStrength)
   *   finalColor = pointColor × occlusion
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

export function createPointCloudLayer(options: PointCloudLayerOptions): PointCloudLayer;
```

### 2.3 对接 / 错误

```
对接：3DTiles BVH 遍历复用 → RequestScheduler → WorkerPool(pnts/LAS 解码) → GPUUploader
      EDL 需要深度纹理 → DepthManager.createDepthTexture
      PerformanceManager 降级：点数超 maxPoints 时随机采样 / 降低 pointSize / 关闭 EDL

错误：
  | LAS/LAZ 解码失败 | DATA_TILE_DECODE | 跳过该文件 + log.warn |
  | 点数超 GPU 限制 | GPU_BUFFER_OOM | 截断到 maxPoints |
  | EDL 深度纹理不可用 | — | 跳过 EDL Pass |
```

---

## 3. @geoforge/layer-marker

### 3.1 MarkerSpec

```typescript
export interface MarkerSpec {
  /** 唯一标识 */
  readonly id: string;
  /** 地理位置 [lon, lat] */
  readonly lngLat: [number, number];
  /** 精灵图标名（从 sprite atlas 中查找），null = 无图标 */
  readonly icon?: string | null;
  /** 图标缩放 @range [0.1, 10] @default 1 */
  readonly iconSize?: number;
  /** 图标旋转 @unit 弧度 @default 0 */
  readonly iconRotation?: number;
  /** 标注颜色（无图标时显示为纯色圆点） @default '#3FB1CE' */
  readonly color?: string;
  /** 标注文字（显示在图标旁边） */
  readonly label?: string;
  /** 文字相对图标偏移 @unit 像素 @default [0, -20] */
  readonly labelOffset?: [number, number];
  /** 文字大小 @unit 像素 @default 14 */
  readonly labelSize?: number;
  /** 锚点位置 @default 'bottom' */
  readonly anchor?: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** 是否可拖拽 @default false */
  readonly draggable?: boolean;
  /** 点击时显示的弹窗内容（HTML 字符串或 DOM 元素） */
  readonly popup?: string | HTMLElement;
  /** 自定义数据（附加属性，不影响渲染） */
  readonly data?: Record<string, any>;
  /** Z 排序优先级（值大的显示在上面） @default 0 */
  readonly priority?: number;
}
```

### 3.2 MarkerLayer 接口

```typescript
export interface MarkerLayerOptions {
  readonly id: string;
  readonly source?: string;
  readonly markers?: MarkerSpec[];
  /** 聚合开关 @default false */
  readonly cluster?: boolean;
  /** 聚合半径（像素）@range [10, 500] @default 50 */
  readonly clusterRadius?: number;
  /** 最大聚合 zoom @range [0, 22] @default 14 */
  readonly clusterMaxZoom?: number;
  /** 聚合图标工厂（自定义聚合图标样式） */
  readonly clusterIconFactory?: (count: number) => { icon: string; size: number; label: string };
}

export interface MarkerLayer extends Layer {
  /** @stability stable */
  readonly type: 'marker';

  /** 添加单个标注 @stability stable */
  addMarker(spec: MarkerSpec): void;
  /** 批量添加 @stability stable */
  addMarkers(specs: MarkerSpec[]): void;
  /** 移除 @stability stable */
  removeMarker(id: string): void;
  /** 更新位置 @stability stable */
  setMarkerPosition(id: string, lngLat: [number, number]): void;
  /** 更新任意属性 @stability stable */
  updateMarker(id: string, spec: Partial<MarkerSpec>): void;
  /** 获取所有 @stability stable */
  getMarkers(): MarkerSpec[];
  /** 获取单个 @stability stable */
  getMarker(id: string): MarkerSpec | null;
  /** 清空 @stability stable */
  clearMarkers(): void;
  /** 标注数量 @stability stable */
  readonly markerCount: number;

  /** 标注点击事件 @stability stable */
  onMarkerClick(callback: (markerId: string, event: MapMouseEvent) => void): () => void;
  /** 拖拽结束事件 @stability stable */
  onMarkerDragEnd(callback: (markerId: string, lngLat: [number, number]) => void): () => void;
  /** 鼠标进入事件 @stability experimental */
  onMarkerEnter(callback: (markerId: string) => void): () => void;
  /** 鼠标离开事件 @stability experimental */
  onMarkerLeave(callback: (markerId: string) => void): () => void;

  /**
   * 渲染：GPU Instanced Quad
   *   每个 marker = 1 个实例
   *   实例数据：position(f32×3) + iconAtlasUV(f32×4) + color(u8×4) + size(f32) + rotation(f32) + anchorOffset(f32×2)
   *   Vertex Shader: 投影位置 → 加 anchor 偏移 → 扩展 quad
   *   Fragment Shader: 采样 sprite atlas + tint color
   *   文字标注：提交给 LabelManager（MSDF 渲染）
   *
   * 聚合：复用 L0/cluster/Supercluster
   *   每帧 update 时根据 zoom 重新计算聚合
   *   聚合点使用 clusterIconFactory 生成图标
   *
   * Picking：Color-ID per marker instance → PickingEngine
   *
   * 拖拽：
   *   onMarkerClick 检测 draggable=true → 进入拖拽模式
   *   handlePanMove 时更新 marker 位置
   *   handlePanEnd 时 emit onMarkerDragEnd
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

export function createMarkerLayer(options: MarkerLayerOptions): MarkerLayer;
```

### 3.3 对接 / 错误

```
对接：
  L1/TextureManager.getAtlasTexture('icons') — 精灵图标
  L4/LabelManager.submitLabels — 文字标注
  L0/cluster/Supercluster — 聚合
  L2/PickingEngine.registerLayer — 点击识别
  InternalBus 'marker:click' / 'marker:drag-end'

错误：
  | icon 名称在 sprite atlas 中不存在 | — | 使用默认圆点图标 + if(__DEV__) warn |
  | marker id 重复 | CONFIG_INVALID_PARAM | 覆盖旧 marker + if(__DEV__) warn |
  | 移除不存在的 marker id | — | 空操作 + if(__DEV__) warn |
  | 聚合点数超 100000 | — | PerformanceManager 降级：增大 clusterRadius |
```

---

## 4. @geoforge/layer-extrusion

### 4.1 ExtrusionLayerOptions

```typescript
export interface ExtrusionLayerOptions {
  readonly id: string;
  readonly source: string;
  readonly sourceLayer?: string;
  readonly paint?: {
    /** 拉伸高度（米）@default 0 */
    'fill-extrusion-height'?: number | StyleExpression;
    /** 拉伸底部高度（米），用于架空建筑 @default 0 */
    'fill-extrusion-base'?: number | StyleExpression;
    /** 填充颜色 */
    'fill-extrusion-color'?: string | StyleExpression;
    /** 透明度 @range [0, 1] @default 1 */
    'fill-extrusion-opacity'?: number | StyleExpression;
    /** 平移偏移 [x, y] 像素 @default [0, 0] */
    'fill-extrusion-translate'?: [number, number];
    /**
     * 垂直渐变（底暗顶亮）。
     * 模拟光照效果：底部受光少（暗），顶部受光多（亮）。
     * @default true
     */
    'fill-extrusion-vertical-gradient'?: boolean;
  };
  readonly filter?: FilterExpression;
  readonly minzoom?: number;
  readonly maxzoom?: number;
}
```

### 4.2 ExtrusionLayer 接口

```typescript
export interface ExtrusionLayer extends Layer {
  /** @stability stable */
  readonly type: 'fill-extrusion';

  /** 设置光照参数 @stability experimental */
  setLight(light: LightSpec): void;

  /**
   * Worker 端几何生成（'triangulate' 任务）：
   *
   *   1. earcut 三角剖分顶面
   *      flatCoords = flatten(polygon.coordinates)
   *      holeIndices = recordHoles(polygon)
   *      topIndices = earcut(flatCoords, holeIndices, 2)
   *
   *   2. 顶面顶点（z = height）
   *      for each vertex in polygon:
   *        topVertices.push(x, y, height, 0, 0, 1, u, v, color)
   *        // 法线朝上 (0, 0, 1)
   *
   *   3. 底面顶点（z = base，如果 base > 0）
   *      for each vertex in polygon:
   *        bottomVertices.push(x, y, base, 0, 0, -1, u, v, color)
   *        // 法线朝下 (0, 0, -1)
   *      底面索引 = 顶面索引反向（面朝下）
   *
   *   4. 侧面生成（每条边 → 矩形 → 2 个三角形）
   *      for (i = 0; i < edgeCount; i++):
   *        p0 = polygon[i], p1 = polygon[(i+1) % n]
   *        // 4 个顶点
   *        sideVertices.push(
   *          p0.x, p0.y, base,   nx, ny, 0, ...)  // 左下
   *          p1.x, p1.y, base,   nx, ny, 0, ...)  // 右下
   *          p0.x, p0.y, height, nx, ny, 0, ...)  // 左上
   *          p1.x, p1.y, height, nx, ny, 0, ...)  // 右上
   *        // 法线 = normalize(cross(p1-p0, up))
   *        edge = [p1.x - p0.x, p1.y - p0.y]
   *        normal = normalize(-edge.y, edge.x, 0)  // 向外的法向量
   *        // 2 个三角形
   *        sideIndices.push(bl, br, tl, tl, br, tr)
   *
   *   5. 光照（Fragment Shader）
   *      Lambert Diffuse: brightness = max(0, dot(normal, lightDir))
   *      侧面根据法线朝向明暗不同（东侧面/西侧面光照不同）
   *
   *   6. 垂直渐变
   *      if (verticalGradient)
   *        t = (vertex.z - base) / (height - base)  // [0, 1]
   *        brightness *= 0.7 + 0.3 × t  // 底部 70% 亮度，顶部 100%
   *
   *   7. 地形贴合（如果有 TerrainLayer）
   *      base += terrainHeight（从 TerrainLayer.getElevationTexture 采样）
   *      height += terrainHeight
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;
}

export function createExtrusionLayer(options: ExtrusionLayerOptions): ExtrusionLayer;
```

### 4.3 WGSL

```wgsl
// === style/extrusion.wgsl ===
struct ExtrusionUniforms {
  color: vec4<f32>,
  opacity: f32,
  enableVerticalGradient: f32,
  lightDir: vec3<f32>,
  ambientStrength: f32,
};
@group(1) @binding(0) var<uniform> style: ExtrusionUniforms;

fn computeColor(input: FragmentInput) -> vec4<f32> {
  var color = select(style.color, input.color, input.color.a > 0.0);

  // Lambert diffuse
  let ndotl = max(dot(input.normal, normalize(style.lightDir)), 0.0);
  let brightness = style.ambientStrength + (1.0 - style.ambientStrength) * ndotl;

  // 垂直渐变
  if (style.enableVerticalGradient > 0.5) {
    // input.varyings.z = 归一化高度 [0, 1]（base=0, height=1）
    let gradientFactor = 0.7 + 0.3 * input.varyings.z;
    color = vec4<f32>(color.rgb * brightness * gradientFactor, color.a * style.opacity);
  } else {
    color = vec4<f32>(color.rgb * brightness, color.a * style.opacity);
  }

  return color;
}
```

### 4.4 对接 / 错误

```
对接：
  WorkerPool('triangulate') — earcut + 侧面生成
  TerrainLayer.getElevationTexture() — 地形贴合采样
  GlobeRenderer.getSunDirection() — 光照方向（如果有 globe）
  PerformanceManager 降级：减少侧面段数 / 简化多边形 / 关闭垂直渐变

错误：
  | earcut 失败（自相交多边形） | DATA_TILE_DECODE | 跳过该要素 + if(__DEV__) warn |
  | height < base | CONFIG_INVALID_PARAM | 交换 height 和 base + if(__DEV__) warn |
  | 高度为 NaN | — | 使用 0 |
```

---

## 5. @geoforge/interaction-draw

### 5.1 DrawToolOptions

```typescript
export interface DrawToolOptions {
  /**
   * 绘制模式。
   * 'point':     单击放置点
   * 'line':      连续点击放置折线，双击完成
   * 'polygon':   连续点击放置多边形，双击闭合完成
   * 'rectangle': 按住拖动绘制矩形
   * 'circle':    点击中心 → 拖动半径 → 释放完成
   * @default 'polygon'
   */
  readonly mode: 'point' | 'line' | 'polygon' | 'rectangle' | 'circle';

  /** 绘制时的线样式 */
  readonly lineStyle?: {
    /** 线颜色 @default '#3FB1CE' */
    color?: string;
    /** 线宽（像素）@default 2 */
    width?: number;
    /** 虚线模式 @default undefined（实线） */
    dasharray?: number[];
  };

  /** 绘制时的填充样式 */
  readonly fillStyle?: {
    /** 填充颜色 @default 'rgba(63,177,206,0.1)' */
    color?: string;
    /** 填充透明度 @range [0, 1] @default 0.1 */
    opacity?: number;
  };

  /**
   * 顶点吸附距离。
   * 鼠标在此像素范围内靠近已有顶点/线段时自动吸附。
   * @unit CSS 像素
   * @range [0, 50]，0 = 禁用吸附
   * @default 10
   */
  readonly snapDistance?: number;

  /** 自由手绘模式（连续采样鼠标轨迹）@default false */
  readonly freehand?: boolean;

  /** 自由手绘时的最小采样间距（像素）@unit 像素 @default 5 */
  readonly freehandMinDistance?: number;

  /** 是否在绘制过程中显示面积/距离标注 @default true */
  readonly showMeasurements?: boolean;
}
```

### 5.2 DrawTool 接口

```typescript
export interface DrawTool extends InteractionTool {
  readonly id: 'draw';

  /** 当前绘制模式 @stability stable */
  readonly mode: 'point' | 'line' | 'polygon' | 'rectangle' | 'circle';

  /** 切换模式（会取消当前绘制中的图形）@stability stable */
  setMode(mode: 'point' | 'line' | 'polygon' | 'rectangle' | 'circle'): void;

  /** 撤销最后一个顶点 @stability stable */
  undo(): void;

  /** 重做（撤销的逆操作）@stability stable */
  redo(): void;

  /** 手动完成当前绘制（等效双击）@stability stable */
  finish(): Feature | null;

  /** 取消当前绘制 @stability stable */
  cancel(): void;

  /** 获取当前绘制中的坐标 @stability experimental */
  getDrawingCoordinates(): number[][] | null;

  /** 当前是否在绘制中 @stability stable */
  readonly isDrawing: boolean;

  /** 已撤销的顶点数（可 redo 的数量）@stability experimental */
  readonly undoStackSize: number;

  // ── 事件 ──

  /** @stability stable */
  on(event: 'drawstart', callback: (mode: string) => void): () => void;
  /** 绘制完成，返回生成的 GeoJSON Feature @stability stable */
  on(event: 'drawend', callback: (feature: Feature) => void): () => void;
  /** @stability stable */
  on(event: 'drawcancel', callback: () => void): () => void;
  /** @stability experimental */
  on(event: 'vertexadd', callback: (coords: [number, number]) => void): () => void;
  /** @stability experimental */
  on(event: 'vertexremove', callback: (coords: [number, number]) => void): () => void;

  /**
   * 事件消费链处理：
   *
   * point 模式：
   *   click → screenToLngLat(x, y) → Feature<Point> → emit('drawend')
   *
   * line 模式：
   *   click → 记录顶点 → 绘制辅助线（OverlayRenderer.drawLine）
   *   mousemove → 更新橡皮筋线（最后一个顶点到鼠标位置）
   *   dblclick → 结束 → Feature<LineString> → emit('drawend')
   *   吸附：检测鼠标附近已有顶点，distance < snapDistance 则吸附
   *
   * polygon 模式：
   *   click → 记录顶点 → 绘制辅助面+线
   *   mousemove → 更新橡皮筋（最后顶点 → 鼠标 → 第一个顶点）
   *   dblclick → 闭合 → Feature<Polygon>（自动添加首尾闭合点）
   *   最少 3 个顶点才能完成
   *
   * rectangle 模式：
   *   mousedown → 记录起始角
   *   mousemove → 绘制矩形预览
   *   mouseup → Feature<Polygon>（4 个角点 + 闭合）
   *
   * circle 模式：
   *   click → 记录圆心
   *   mousemove → 计算半径（geodesic.vincentyInverse）→ 绘制圆形预览
   *   click → Feature<Polygon>（64 段近似圆）
   *
   * Overlay 渲染：
   *   通过 OverlayRenderer 绘制辅助图形（不经过图层渲染管线）：
   *   OverlayRenderer.drawLine(coordinates, style)
   *   OverlayRenderer.drawPolygon(coordinates, fillStyle, lineStyle)
   *   OverlayRenderer.drawCircle(center, radius, style)
   *   OverlayRenderer.drawPoint(position, style)  // 顶点标记
   *
   * @stability stable
   */
  handlePointerDown(event: MapPointerEvent): boolean;  // 返回 true = 已消费
  handlePointerMove(event: MapPointerEvent): boolean;
  handlePointerUp(event: MapPointerEvent): boolean;
  handleDoubleClick(event: MapPointerEvent): boolean;
  handleKeyDown(event: KeyboardEvent): boolean;  // Escape=取消, Ctrl+Z=撤销, Ctrl+Y=重做

  /** 渲染辅助图形（在 Screen Pass 中调用）@stability stable */
  renderOverlay(renderer: OverlayRenderer): void;
}

export function createDrawTool(options?: DrawToolOptions): DrawTool;
```

---

## 6. @geoforge/interaction-measure

### 6.1 MeasureToolOptions

```typescript
export interface MeasureToolOptions {
  /**
   * 测量模式。
   * 'distance':          折线距离测量
   * 'area':              面积测量
   * 'elevation-profile': 高程剖面（沿路径采样地形高度）
   * @default 'distance'
   */
  readonly mode: 'distance' | 'area' | 'elevation-profile';
  /** 距离单位 @default 'meters' */
  readonly unit?: 'meters' | 'kilometers' | 'miles' | 'nautical-miles';
  /** 面积单位 @default 'sq-meters' */
  readonly areaUnit?: 'sq-meters' | 'sq-kilometers' | 'hectares' | 'acres';
  /** 是否显示测量标注 @default true */
  readonly showLabels?: boolean;
  /** 线样式 */
  readonly lineStyle?: { color?: string; width?: number; dasharray?: number[] };
  /** 高程剖面采样密度 @range [10, 1000] @default 100 */
  readonly profileSampleCount?: number;
}
```

### 6.2 MeasureTool 接口

```typescript
export interface MeasureResult {
  readonly mode: 'distance' | 'area' | 'elevation-profile';
  /** 测量路径/区域的坐标 [[lon, lat], ...] */
  readonly coordinates: number[][];
  /** 总距离（米），distance 和 elevation-profile 模式有值 */
  readonly distance?: number;
  /** 面积（平方米），area 模式有值 */
  readonly area?: number;
  /** 高程剖面数据，elevation-profile 模式有值 */
  readonly elevationProfile?: Array<{ distance: number; elevation: number }>;
  /** 各段距离（米）*/
  readonly segmentDistances?: number[];
  /** 总距离格式化字符串（带单位） */
  readonly formattedDistance?: string;
  /** 面积格式化字符串（带单位） */
  readonly formattedArea?: string;
}

export interface MeasureTool extends InteractionTool {
  readonly id: 'measure';

  /** @stability stable */
  setMode(mode: 'distance' | 'area' | 'elevation-profile'): void;
  /** @stability stable */
  setUnit(unit: string): void;
  /** @stability stable */
  getResult(): MeasureResult | null;
  /** @stability stable */
  clear(): void;
  /** 当前是否在测量中 @stability stable */
  readonly isMeasuring: boolean;

  /** @stability stable */
  on(event: 'measurestart', callback: () => void): () => void;
  /** @stability stable */
  on(event: 'measureend', callback: (result: MeasureResult) => void): () => void;
  /** 每次添加顶点或鼠标移动时触发（实时预览测量值）@stability experimental */
  on(event: 'measureupdate', callback: (result: MeasureResult) => void): () => void;

  /**
   * 算法：
   *
   * distance 模式：
   *   click* → dblclick
   *   每段距离：geodesic.vincentyInverse(p[i], p[i+1])
   *   总距离 = 各段之和
   *   Overlay：绘制折线 + 每段中点标注距离 + 总距离标注
   *
   * area 模式：
   *   click* → dblclick → 闭合
   *   面积计算：measure.area(polygon)（椭球面积，非平面面积）
   *   Overlay：绘制多边形 + 中心标注面积
   *
   * elevation-profile 模式：
   *   click* → dblclick
   *   沿路径等距采样 N 点 → TerrainLayer.getElevation(lon, lat)
   *   结果：{ distance, elevation }[]
   *   Overlay：绘制路径线 + 路径上标注坡度信息
   *
   * 单位转换：
   *   meters → km: / 1000
   *   meters → miles: / 1609.344
   *   meters → nautical-miles: / 1852
   *   sq-meters → sq-km: / 1e6
   *   sq-meters → hectares: / 10000
   *   sq-meters → acres: / 4046.856
   *
   * @stability stable
   */
  handlePointerDown(event: MapPointerEvent): boolean;
  handlePointerMove(event: MapPointerEvent): boolean;
  handleDoubleClick(event: MapPointerEvent): boolean;
  renderOverlay(renderer: OverlayRenderer): void;
}

export function createMeasureTool(options?: MeasureToolOptions): MeasureTool;
```

---

## 7. @geoforge/interaction-select

### 7.1 SelectToolOptions

```typescript
export interface SelectToolOptions {
  /**
   * 选择模式。
   * 'click': 单击选择（Shift+Click 多选）
   * 'box':   框选（mousedown→drag→mouseup 画矩形）
   * 'lasso': 套索选择（click* → dblclick 画自由多边形）
   * @default 'click'
   */
  readonly mode: 'click' | 'box' | 'lasso';
  /** 可选择的图层 ID 列表（空 = 所有图层）*/
  readonly layers?: string[];
  /** 多选开关 @default true */
  readonly multiSelect?: boolean;
  /** 选中时的高亮样式 */
  readonly highlightStyle?: {
    /** 高亮颜色 @default 'rgba(255,255,0,0.3)' */
    color?: string;
    /** 高亮透明度 @range [0, 1] @default 0.3 */
    opacity?: number;
    /** 轮廓颜色 @default '#FFFF00' */
    outlineColor?: string;
    /** 轮廓宽度（像素）@default 2 */
    outlineWidth?: number;
  };
}
```

### 7.2 SelectTool 接口

```typescript
export interface SelectTool extends InteractionTool {
  readonly id: 'select';

  /** @stability stable */
  setMode(mode: 'click' | 'box' | 'lasso'): void;
  /** 获取已选要素 @stability stable */
  getSelectedFeatures(): Feature[];
  /** 已选要素数量 @stability stable */
  readonly selectedCount: number;
  /** 取消选择 @stability stable */
  clearSelection(): void;
  /** 编程式选中 @stability stable */
  selectFeatures(features: Feature[]): void;
  /** 编程式追加选中 @stability stable */
  addToSelection(features: Feature[]): void;
  /** 编程式移除选中 @stability experimental */
  removeFromSelection(featureIds: (string | number)[]): void;

  /** @stability stable */
  on(event: 'selectionchange', callback: (features: Feature[]) => void): () => void;

  /**
   * 选择实现：
   *
   * click 模式：
   *   click → PickingEngine.pickAt(x, y) → PickResult
   *   if (Shift 未按) clearSelection()
   *   if (result && result.featureId)
   *     toggleSelect(result.featureId)（已选则取消，未选则选中）
   *   选中状态通过 FeatureStateManager 管理：
   *     featureStateManager.setState(featureId, { selected: true })
   *   高亮渲染通过 StyleEngine case 表达式：
   *     paint: { 'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], highlightColor, originalColor] }
   *
   * box 模式：
   *   mousedown → 记录起点
   *   mousemove → 绘制选择框（OverlayRenderer.drawPolygon）
   *   mouseup → 计算矩形 BBox
   *   PickingEngine.pickInRect(x1, y1, x2, y2) → PickResult[]
   *   或 SpatialQuery.queryInBBox(bbox, layers) → Feature[]
   *   对结果集 setFeatureState({ selected: true })
   *
   * lasso 模式：
   *   click* → 记录多边形顶点 → 绘制套索线
   *   dblclick → 闭合多边形
   *   SpatialQuery.queryInPolygon(polygon, layers) → Feature[]
   *   对结果集 setFeatureState({ selected: true })
   *
   * 取消选择：
   *   clearSelection():
   *     for each selected feature:
   *       featureStateManager.removeState(featureId, 'selected')
   *     emit('selectionchange', [])
   *
   * @stability stable
   */
  handlePointerDown(event: MapPointerEvent): boolean;
  handlePointerMove(event: MapPointerEvent): boolean;
  handlePointerUp(event: MapPointerEvent): boolean;
  handleDoubleClick(event: MapPointerEvent): boolean;
  renderOverlay(renderer: OverlayRenderer): void;
}

export function createSelectTool(options?: SelectToolOptions): SelectTool;
```

---

## P2 上半部分统计

| 包 | 公共方法 | WGSL | 对接模块 | 错误场景 | PerformanceManager |
|---|---------|------|---------|---------|-------------------|
| layer-heatmap | 4 | gaussian + colorize | 4 | 3 | 密度纹理降分辨率 |
| layer-pointcloud | 6 | point SDF + EDL | 4 | 3 | 采样/关EDL |
| layer-marker | 14 | sprite atlas | 5 | 4 | 增大聚合半径 |
| layer-extrusion | 3 | extrusion lit | 4 | 3 | 简化多边形 |
| interaction-draw | 10 | — (Overlay) | 3 | 2 | — |
| interaction-measure | 6 | — (Overlay) | 4 | 2 | — |
| interaction-select | 8 | — (Overlay) | 5 | 2 | — |

全部 @stability 标注 / __DEV__ 标注 / ObjectPool(Overlay 复用) / InternalBus / GeoForgeError / GPU 走 L1 / Tree-Shaking 导出均已覆盖（同 P0/P1 模式，各包内按相同格式处理，不再逐个重复展开）。
