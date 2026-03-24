# GeoForge 可选功能包完整接口设计 — P3 生态包（下）

> compat-mobile / compat-hidpi / analysis（9 子模块）

---

## 5. @geoforge/compat-mobile

### 5.1 MobileOptimizerOptions

```typescript
export interface MobileOptimizerOptions {
  /**
   * 自动检测设备能力并应用优化。
   * 关闭后需要手动调用 optimize()。
   * @default true
   */
  readonly autoDetect?: boolean;

  /**
   * 强制指定设备级别（跳过自动检测）。
   * 用于测试或已知设备环境。
   */
  readonly forceLevel?: 'high' | 'medium' | 'low';

  /**
   * 最大渲染分辨率缩放。
   * 移动端 GPU 吞吐有限，降低渲染分辨率可显著提升帧率。
   * 最终 canvas 仍以 CSS 尺寸显示（浏览器放大）。
   * @range [0.25, 1.0]
   * @default 0.75（降低 25% 分辨率）
   */
  readonly maxResolutionScale?: number;

  /**
   * 最大瓦片缓存数（移动端内存紧张）。
   * @range [32, 512]
   * @default 128
   */
  readonly maxTileCache?: number;

  /**
   * 最大 Worker 数量（移动端核心数少）。
   * @range [1, 4]
   * @default 2
   */
  readonly maxWorkers?: number;

  /**
   * 触摸交互优化开关。
   * 启用后调整触摸事件参数（惯性衰减更快、缩放灵敏度调整）。
   * @default true
   */
  readonly touchOptimization?: boolean;
}
```

### 5.2 DeviceProfile

```typescript
export interface DeviceProfile {
  /**
   * 设备性能级别。
   * 'high':   旗舰手机/平板（A16+/Snapdragon 8 Gen 2+）
   * 'medium': 中端手机（A14/Snapdragon 778+）
   * 'low':    低端手机/旧设备（<4GB RAM/老 GPU）
   */
  readonly level: 'high' | 'medium' | 'low';

  /** GPU 厂商名称 */
  readonly gpu: string;

  /** 是否移动设备 */
  readonly isMobile: boolean;

  /** 是否平板 */
  readonly isTablet: boolean;

  /** 估算可用内存（MB） */
  readonly estimatedMemoryMB: number;

  /** GPU 最大纹理尺寸 */
  readonly maxTextureSize: number;

  /** 是否支持 Compute Shader */
  readonly supportsCompute: boolean;

  /** 是否支持 Float32 纹理过滤 */
  readonly supportsFloat32Filter: boolean;

  /** 屏幕 DPR */
  readonly devicePixelRatio: number;

  /** 屏幕尺寸（逻辑像素） */
  readonly screenSize: { width: number; height: number };

  /** 是否支持 timestamp query（GPU 性能分析） */
  readonly supportsTimestampQuery: boolean;
}
```

### 5.3 MobileOptimizer 接口

```typescript
export interface MobileOptimizer {
  /**
   * 检测设备能力。
   *
   * 检测算法：
   *   1. 基础判断：
   *      isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
   *               || navigator.maxTouchPoints > 0（iPad 新 UA 不含 iPad）
   *      isTablet = (isMobile && min(screen.width, screen.height) > 600)
   *
   *   2. GPU 信息（从 GPUCapabilities 获取）：
   *      gpu = capabilities.vendor + ' ' + capabilities.architecture
   *      maxTextureSize = capabilities.maxTextureSize
   *      supportsCompute = capabilities.maxComputeWorkgroupsPerDimension > 0
   *
   *   3. 内存估算：
   *      // WebGPU 无直接 API 查内存，通过试探法估算
   *      if (navigator.deviceMemory) estimatedMemoryMB = navigator.deviceMemory * 1024
   *      else 根据 GPU vendor 和 maxBufferSize 推算
   *
   *   4. 级别判定：
   *      if (!isMobile) level = 'high'（桌面设备不降级）
   *      else if (maxTextureSize >= 8192 && estimatedMemoryMB >= 4096 && supportsCompute) level = 'high'
   *      else if (maxTextureSize >= 4096 && estimatedMemoryMB >= 2048) level = 'medium'
   *      else level = 'low'
   *
   * @stability stable
   */
  detect(capabilities: GPUCapabilities): DeviceProfile;

  /**
   * 根据设备能力调整 EngineConfig。
   * 返回修改后的新 EngineConfig（不修改原对象）。
   *
   * 调整策略（按 level）：
   *
   * === high（旗舰手机/平板）===
   *   sampleCount: 4          // 保持 MSAA
   *   maxPixelRatio: 2
   *   workerCount: 4
   *   gpuMemoryBudget: 512MB
   *   tileCacheSize: 512
   *   // 全功能，不降级
   *   powerPreference: 'high-performance'（所有级别统一）
   *
   * === medium（中端手机）===
   *   sampleCount: 1          // 关闭 MSAA
   *   maxPixelRatio: 1.5      // 限制 DPR
   *   workerCount: 2
   *   gpuMemoryBudget: 256MB
   *   tileCacheSize: 256
   *   // PerformanceManager 预设降级：
   *   //   禁用 SSAO、Bloom
   *   //   SSE 阈值 ×1.5
   *   //   标注密度 ×0.7
   *
   * === low（低端手机/旧设备）===
   *   sampleCount: 1
   *   maxPixelRatio: 1        // 不做 HiDPI
   *   workerCount: 1
   *   gpuMemoryBudget: 128MB
   *   tileCacheSize: 64
   *   maxConcurrentRequests: 4（降低网络并发）
   *   backgroundThrottleMs: 2000（后台更激进节流）
   *   // PerformanceManager 预设降级：
   *   //   禁用所有后处理
   *   //   禁用阴影、大气
   *   //   渲染分辨率 ×0.5
   *   //   SSE 阈值 ×4
   *   //   瓦片最大 zoom 限制到 16
   *   //   禁用 3D 建筑拉伸
   *   //   标注密度 ×0.3
   *
   * @stability stable
   */
  optimize(config: EngineConfig, profile: DeviceProfile): EngineConfig;

  /**
   * 获取推荐配置差异（不直接应用，让用户自行选择）。
   * @stability experimental
   */
  getRecommendedConfig(profile: DeviceProfile): Partial<EngineConfig>;

  /** 当前设备 profile @stability stable */
  readonly profile: DeviceProfile;
}

export function createMobileOptimizer(options?: MobileOptimizerOptions): MobileOptimizer;
```

### 5.4 对接 / 错误

```
对接：
  L1/DeviceManager.capabilities — GPU 能力信息
  L0/config — EngineConfig 修改
  L3/PerformanceManager — 预设降级链
  InternalBus 'mobile:profile-detected' { profile }

错误：
  | navigator.gpu 不可用（非 WebGPU 浏览器）| — | 在引擎初始化阶段就已失败，此包不需要处理 |
  | deviceMemory API 不可用 | — | 使用 maxBufferSize 推算 + warn |
  | 检测结果不准确（某些 iPad 被误判为 desktop）| — | 提供 forceLevel 覆盖 |

常量：
  HIGH_MEMORY_THRESHOLD_MB = 4096
  MEDIUM_MEMORY_THRESHOLD_MB = 2048
  HIGH_TEXTURE_THRESHOLD = 8192
  MEDIUM_TEXTURE_THRESHOLD = 4096
  TABLET_MIN_DIMENSION = 600          // CSS 像素
```

---

## 6. @geoforge/compat-hidpi

### 6.1 HiDPIAdapterOptions

```typescript
export interface HiDPIAdapterOptions {
  /**
   * 最大 DPR 限制。
   * 高端设备可能 DPR=3，但 GPU 负载随 DPR² 增长（3× → 9× 像素），
   * 限制到 2 是常见的性能/清晰度平衡点。
   * @range [1, 4]
   * @default 2
   */
  readonly maxPixelRatio?: number;

  /**
   * 动态分辨率开关。
   * 启用后，帧率低于阈值时自动降低渲染分辨率。
   * @default false
   */
  readonly dynamicResolution?: boolean;

  /**
   * 动态分辨率最低缩放。
   * @range [0.25, 1.0]
   * @default 0.5
   */
  readonly minResolutionScale?: number;

  /**
   * 帧率目标阈值（低于此值触发降分辨率）。
   * @unit FPS
   * @range [15, 60]
   * @default 30
   */
  readonly fpsThreshold?: number;

  /**
   * 分辨率恢复速度（每帧增量）。
   * 恢复比降级慢，优先保帧率。
   * @range [0.005, 0.1]
   * @default 0.02
   */
  readonly restoreRate?: number;

  /**
   * 分辨率降级速度（每帧增量）。
   * @range [0.01, 0.2]
   * @default 0.05
   */
  readonly degradeRate?: number;
}
```

### 6.2 HiDPIAdapter 接口

```typescript
export interface HiDPIAdapter {
  /**
   * 获取建议的 DPR（考虑 maxPixelRatio + 设备能力）。
   *
   * 算法：
   *   rawDPR = window.devicePixelRatio || 1
   *   recommendedDPR = min(rawDPR, maxPixelRatio)
   *   // 如果 MobileOptimizer 检测到低端设备，进一步限制
   *   if (mobileProfile?.level === 'low') recommendedDPR = min(recommendedDPR, 1)
   *
   * @stability stable
   */
  getRecommendedDPR(): number;

  /** 当前渲染分辨率缩放 [minResolutionScale, 1.0] @stability stable */
  readonly currentScale: number;

  /** 是否正在动态调节 @stability stable */
  readonly isDynamicActive: boolean;

  /**
   * 启动动态分辨率调节。
   * 启动后每帧调用 evaluate()，自动调整 canvas 渲染分辨率。
   * @stability experimental
   */
  startDynamicResolution(): void;

  /**
   * 停止动态分辨率调节，恢复到固定分辨率。
   * @stability experimental
   */
  stopDynamicResolution(): void;

  /**
   * 每帧评估（由 FrameScheduler 在 POST 阶段调用）。
   *
   * 算法：
   *   if (fps < fpsThreshold) {
   *     // 帧率不足 → 降分辨率
   *     scale = max(minResolutionScale, currentScale - degradeRate)
   *   } else if (fps > fpsThreshold × 1.2 && currentScale < 1.0) {
   *     // 帧率充裕 → 缓慢恢复
   *     scale = min(1.0, currentScale + restoreRate)
   *   }
   *
   *   if (scale !== currentScale) {
   *     currentScale = scale
   *     // 通知 SurfaceManager 调整 canvas 物理尺寸
   *     newPhysicalWidth = logicalWidth × dpr × scale
   *     newPhysicalHeight = logicalHeight × dpr × scale
   *     surfaceManager.resize(logicalWidth, logicalHeight)  // 内部使用 scale 调整
   *     return { scale, changed: true }
   *   }
   *   return { scale: currentScale, changed: false }
   *
   * 关键：
   *   降级速度快（degradeRate=0.05/帧 → 20 帧降到底）
   *   恢复速度慢（restoreRate=0.02/帧 → 25 帧恢复到顶）
   *   这种不对称确保帧率优先（快降慢升）
   *
   * @param fps - 当前帧率
   * @param gpuTimeMs - 当前 GPU 帧时间（可选，用于更精确的决策）
   * @returns { scale, changed }
   *
   * @stability experimental
   */
  evaluate(fps: number, gpuTimeMs?: number): { scale: number; changed: boolean };
}

export function createHiDPIAdapter(options?: HiDPIAdapterOptions): HiDPIAdapter;
```

### 6.3 对接 / 错误

```
对接：
  L1/SurfaceManager — 调整 canvas 物理分辨率
  L3/FrameScheduler POST 阶段 — 每帧调用 evaluate()
  L3/RenderStats — 获取 fps 和 gpuTimeMs
  PerformanceManager — 降级链中包含 'reduce-resolution' action
  InternalBus 'hidpi:scale-changed' { oldScale, newScale }

错误：
  | window.devicePixelRatio 为 0 或 NaN | — | 使用 1 |
  | SurfaceManager.resize 失败（canvas 被移除）| — | stopDynamicResolution + warn |

常量：
  DEFAULT_MAX_PIXEL_RATIO = 2
  DEFAULT_MIN_RESOLUTION_SCALE = 0.5
  DEFAULT_FPS_THRESHOLD = 30
  DEFAULT_RESTORE_RATE = 0.02
  DEFAULT_DEGRADE_RATE = 0.05
  FPS_HYSTERESIS = 1.2              // 恢复阈值 = fpsThreshold × 1.2（避免反复切换）
```

---

## 7. @geoforge/analysis

### 7.1 包结构

```typescript
// analysis/src/index.ts — 统一入口
export { booleanOps } from './boolean';
export { bufferOps } from './buffer';
export { interpolationOps } from './interpolation';
export { classificationOps } from './classification';
export { gridOps } from './grid';
export { rasterOps } from './raster';
export { transformOps } from './transform';
export { aggregationOps } from './aggregation';
export { topologyOps } from './topology';

// 也支持按需 import 单个子模块：
// import { booleanOps } from '@geoforge/analysis/boolean';
```

### 7.2 boolean/ — 布尔运算

```typescript
/**
 * 多边形布尔运算。
 * 使用 Martinez-Rueda-Feito 算法（扫描线 + 事件队列）。
 * 复杂度 O((n+k) log n)，n = 总顶点数，k = 交点数。
 *
 * 所有方法接受 Polygon 或 MultiPolygon，返回时可能降维（交集可能为空）。
 */
export interface BooleanOps {
  /**
   * 多边形交集（A ∩ B）。
   * @returns 交集多边形，无交集返回 null
   *
   * 算法步骤：
   *   1. 构建事件队列（每条边的两个端点为事件，按 x 坐标排序）
   *   2. 扫描线从左到右扫过：
   *      a. 左端点事件：将边插入状态结构（AVL 树按 y 排序）
   *      b. 右端点事件：从状态结构移除
   *      c. 检测新插入边与相邻边的交点 → 新增交点事件
   *   3. 对每个交点：标记交点，分割两条边
   *   4. 遍历交点链，按布尔运算规则（in-out 标记）连接边段
   *   5. 组装结果多边形（可能多个环）
   *   6. 确定外环/内环（面积正 = 外环，面积负 = 内环）
   *
   * @stability stable
   */
  intersection(a: Feature<Polygon | MultiPolygon>, b: Feature<Polygon | MultiPolygon>): Feature<Polygon | MultiPolygon> | null;

  /** 多边形并集（A ∪ B）@stability stable */
  union(a: Feature<Polygon | MultiPolygon>, b: Feature<Polygon | MultiPolygon>): Feature<Polygon | MultiPolygon>;

  /** 多边形差集（A - B）@stability stable */
  difference(a: Feature<Polygon | MultiPolygon>, b: Feature<Polygon | MultiPolygon>): Feature<Polygon | MultiPolygon> | null;

  /** 多边形对称差（A △ B = (A-B) ∪ (B-A)）@stability stable */
  xor(a: Feature<Polygon | MultiPolygon>, b: Feature<Polygon | MultiPolygon>): Feature<Polygon | MultiPolygon>;

  /**
   * 检测多边形自相交（kinks）。
   * @returns 自相交点的 MultiPoint
   *
   * 算法：遍历所有非相邻边对，检测 segmentSegment 相交（L0/algorithm/intersect）
   * @stability experimental
   */
  kinks(polygon: Feature<Polygon>): Feature<MultiPoint>;

  /**
   * 修复自相交多边形。
   * @returns 有效的 Polygon 或 MultiPolygon（自相交分裂为多个不相交多边形）
   *
   * 算法：
   *   1. kinks() 找到所有自相交点
   *   2. 在交点处分割多边形环
   *   3. 重新组装为不相交的多边形集合
   *   4. 修复绕向（外环逆时针，内环顺时针）
   *
   * @stability experimental
   */
  makeValid(polygon: Feature<Polygon>): Feature<Polygon | MultiPolygon>;
}
```

### 7.3 buffer/ — 缓冲区分析

```typescript
export interface BufferOps {
  /**
   * 点缓冲区（生成圆形多边形）。
   *
   * @param point - 中心点
   * @param radiusMeters - 半径（米）
   * @param steps - 圆近似段数 @range [4, 256] @default 64
   * @returns 圆形多边形
   *
   * 算法：
   *   for i in [0, steps]:
   *     angle = 2π × i / steps
   *     vertex = geodesic.destination(center, radiusMeters, angle)
   *   闭合首尾 → Polygon
   *
   * @stability stable
   */
  pointBuffer(point: Feature<Point>, radiusMeters: number, steps?: number): Feature<Polygon>;

  /**
   * 线缓冲区（平行偏移线围成的多边形）。
   *
   * @param line - 输入线
   * @param distanceMeters - 缓冲距离（正值向外扩展）
   * @param options.cap - 线端处理 @default 'round'
   * @param options.join - 拐角处理 @default 'round'
   * @param options.steps - 圆弧段数 @default 8
   * @returns 缓冲区多边形
   *
   * 算法：
   *   1. 对线段序列的每个顶点，计算左右偏移点（距离 = distanceMeters）
   *      offset = geodesic.destination(vertex, distanceMeters, bearing ± 90°)
   *   2. 拐角处理（同 P0 layer-tile-vector 的 miter/bevel/round join）
   *   3. 线帽处理（同 P0 的 butt/square/round cap）
   *   4. 左侧偏移线（正向）+ 右侧偏移线（反向）闭合成 Polygon
   *   5. 如果线自相交，用 booleanOps.makeValid() 修复
   *
   * @stability stable
   */
  lineBuffer(
    line: Feature<LineString>,
    distanceMeters: number,
    options?: { cap?: 'round' | 'flat' | 'square'; join?: 'round' | 'miter' | 'bevel'; steps?: number },
  ): Feature<Polygon>;

  /**
   * 面缓冲区（膨胀或收缩多边形）。
   * 正距离 = 膨胀（外扩），负距离 = 收缩（内缩，可能分裂或消失）。
   *
   * 算法：
   *   膨胀：外环的每个顶点向外偏移 + 圆弧拐角
   *   收缩：内环的每个顶点向外偏移（等效于外环向内偏移）
   *   用 booleanOps 处理自相交
   *
   * @stability stable
   */
  polygonBuffer(polygon: Feature<Polygon>, distanceMeters: number, steps?: number): Feature<Polygon>;

  /**
   * 单侧偏移曲线（不闭合，只生成偏移后的线）。
   * 正距离 = 左侧偏移，负距离 = 右侧偏移。
   *
   * @stability experimental
   */
  offsetCurve(line: Feature<LineString>, distanceMeters: number): Feature<LineString>;
}
```

### 7.4 interpolation/ — 插值分析

```typescript
export interface InterpolationOps {
  /**
   * TIN 不规则三角网插值。
   * 从离散点集构建 Delaunay 三角网。
   *
   * @param points - 带高程属性的点集
   * @param zProperty - 高程属性字段名
   * @returns TIN 三角网（FeatureCollection<Polygon>，每个三角形含顶点高程）
   *
   * 算法：调用 L0/algorithm/delaunay 构建三角网
   * @stability stable
   */
  tin(points: FeatureCollection<Point>, zProperty: string): FeatureCollection<Polygon>;

  /**
   * IDW 反距离加权插值。
   * 输出规则网格的插值结果。
   *
   * @param points - 采样点（带 zProperty 属性）
   * @param zProperty - 插值属性字段名
   * @param cellSize - 输出网格单元大小（经纬度度）
   * @param options.power - 距离衰减幂次 @default 2
   * @param options.maxPoints - 参与插值的最近点数 @default 12
   * @returns 二维数组 [row][col]，值为插值结果
   *
   * 算法：
   *   for each grid cell (i, j):
   *     cellCenter = gridOrigin + [j × cellSize, i × cellSize]
   *     找最近 maxPoints 个采样点（L0/index/kd-tree.kNearest）
   *     weights[k] = 1 / distance(cellCenter, point[k])^power
   *     value = Σ(weights[k] × point[k].z) / Σ(weights[k])
   *
   * @stability stable
   */
  idw(
    points: FeatureCollection<Point>,
    zProperty: string,
    cellSize: number,
    options?: { power?: number; maxPoints?: number },
  ): number[][];

  /**
   * 等值线生成（Marching Squares 算法）。
   *
   * @param grid - 二维数值网格 [row][col]
   * @param breaks - 等值线值列表（如 [100, 200, 300, 400, 500]）
   * @param options - 网格地理参考（originX/Y + cellWidth/Height）
   * @returns 等值线 FeatureCollection<LineString>，每条线含 value 属性
   *
   * 算法：
   *   for each break value:
   *     for each grid cell (i, j):
   *       // 计算四个角的 in/out 状态（值 > break → in）
   *       caseIndex = (topLeft > break) × 8 + (topRight > break) × 4
   *                 + (bottomRight > break) × 2 + (bottomLeft > break) × 1
   *       // 16 种 case 的查表（Marching Squares lookup table）
   *       // 在边上线性插值精确交叉位置
   *       t = (break - v0) / (v1 - v0)
   *       crossPoint = lerp(corner0, corner1, t)
   *     // 连接同一等值的交叉点为折线
   *     // 处理歧义 case（case 5 和 10：使用中心值决定）
   *
   * @stability stable
   */
  isolines(
    grid: number[][],
    breaks: number[],
    options?: { originX: number; originY: number; cellWidth: number; cellHeight: number },
  ): FeatureCollection<LineString>;

  /** 双线性插值（网格中任意位置取值）@stability stable */
  bilinear(grid: number[][], x: number, y: number): number;

  /** 双三次插值（更平滑，使用 4×4 邻域）@stability experimental */
  bicubic(grid: number[][], x: number, y: number): number;
}
```

### 7.5 classification/ — 分级

```typescript
export interface ClassificationOps {
  /**
   * Jenks 自然断裂法。
   * 将数据分为 N 类，使类内方差最小，类间方差最大。
   *
   * @param values - 数值数组
   * @param classCount - 分类数 @range [2, 20]
   * @returns 断裂点数组（长度 = classCount + 1，含 min 和 max）
   *
   * 算法：Fisher-Jenks 优化（动态规划）
   *   1. 排序 values
   *   2. 构建 sum/sumSq 前缀和
   *   3. DP: varianceMatrix[i][j] = 类 j 从 index 0 到 i 的最小方差
   *   4. 回溯找到断裂点
   *   复杂度：O(n² × classCount)
   *
   * @stability stable
   */
  jenks(values: number[], classCount: number): number[];

  /** 等间距分级 @stability stable */
  equalInterval(values: number[], classCount: number): number[];

  /** 分位数分级 @stability stable */
  quantile(values: number[], classCount: number): number[];

  /**
   * 标准差分级。
   * @returns { breaks: 断裂点, mean: 平均值, stdDev: 标准差 }
   * @stability stable
   */
  standardDeviation(values: number[], classCount?: number): { breaks: number[]; mean: number; stdDev: number };
}
```

### 7.6 grid/ — 网格生成

```typescript
export interface GridOps {
  /**
   * 正方形网格。
   * @param bbox - 地理范围
   * @param cellSize - 单元边长（经纬度度）
   * @stability stable
   */
  squareGrid(bbox: BBox2D, cellSize: number): FeatureCollection<Polygon>;

  /**
   * 六边形网格。
   * @param bbox - 地理范围
   * @param cellSize - 六边形外接圆半径（经纬度度）
   * @param options.triangles - 是否返回三角形而非六边形 @default false
   *
   * 六边形排列：offset 排列（奇数行右移半个单元）
   * @stability stable
   */
  hexGrid(bbox: BBox2D, cellSize: number, options?: { triangles?: boolean }): FeatureCollection<Polygon>;

  /** 三角形网格 @stability experimental */
  triangleGrid(bbox: BBox2D, cellSize: number): FeatureCollection<Polygon>;

  /**
   * Voronoi 图（Fortune 算法）。
   * @param points - 输入点集
   * @param bbox - 裁剪范围
   * @returns Voronoi 多边形（每个多边形的 properties 含原始点的属性）
   *
   * 算法：Fortune's sweep line O(n log n)
   *   调用 L0/algorithm/delaunay → Delaunay 三角网
   *   Voronoi = Delaunay 的对偶图（连接相邻三角形外接圆圆心）
   *   用 bbox 裁剪无限远的边
   *
   * @stability stable
   */
  voronoi(points: FeatureCollection<Point>, bbox: BBox2D): FeatureCollection<Polygon>;
}
```

### 7.7 raster/ — 栅格分析

```typescript
export interface RasterOps {
  /**
   * 坡度计算。
   * 从 DEM 网格计算每个单元的坡度角。
   *
   * @param dem - 高程网格 [row][col]（米）
   * @param cellSize - 单元尺寸（米）
   * @returns 坡度网格（度，0° = 平坦，90° = 垂直）
   *
   * 算法（3×3 Sobel / Horn）：
   *   dzdx = ((z[i-1][j+1] + 2×z[i][j+1] + z[i+1][j+1]) - (z[i-1][j-1] + 2×z[i][j-1] + z[i+1][j-1])) / (8 × cellSize)
   *   dzdy = ((z[i+1][j-1] + 2×z[i+1][j] + z[i+1][j+1]) - (z[i-1][j-1] + 2×z[i-1][j] + z[i-1][j+1])) / (8 × cellSize)
   *   slope = atan(sqrt(dzdx² + dzdy²)) × 180 / π
   *
   * @stability stable
   */
  slope(dem: number[][], cellSize: number): number[][];

  /** 坡向计算（度，0°=北，90°=东，顺时针）@stability stable */
  aspect(dem: number[][], cellSize: number): number[][];

  /**
   * 山体阴影（Hillshade）。
   *
   * @param options.azimuth - 太阳方位角（度，0°=北，顺时针）@default 315
   * @param options.altitude - 太阳高度角（度）@default 45
   * @param options.zFactor - 高程夸大系数 @default 1
   * @returns 阴影值网格（0~255，0=全黑，255=全亮）
   *
   * 算法：
   *   hillshade = 255 × (cos(zenith) × cos(slopeRad) + sin(zenith) × sin(slopeRad) × cos(azimuthRad - aspectRad))
   *   clamp to [0, 255]
   *
   * @stability stable
   */
  hillshade(dem: number[][], options?: { azimuth?: number; altitude?: number; zFactor?: number; cellSize?: number }): number[][];

  /**
   * 视域分析（从观察点能看到哪些区域）。
   *
   * @param observer - 观察点 [col, row] 在 DEM 中的位置
   * @param options.height - 观察者离地高度（米）@default 1.7
   * @param options.radius - 分析半径（网格单元数）@default 全 DEM 范围
   * @returns 可见性网格（true = 可见，false = 不可见）
   *
   * 算法（射线步进法）：
   *   从 observer 向 360° 均匀发射射线（步长 1°）
   *   每条射线沿方向步进，记录最大仰角 maxElevationAngle
   *   当前点仰角 = atan2(terrainHeight - observerHeight, distance)
   *   如果当前仰角 > maxElevationAngle → 可见，更新 maxElevationAngle
   *   否则 → 被遮挡
   *
   * @stability experimental
   */
  viewshed(dem: number[][], observer: [number, number], options?: { height?: number; radius?: number; cellSize?: number }): boolean[][];

  /** 等高线生成（委托给 interpolation.isolines）@stability stable */
  contour(dem: number[][], interval: number, options?: { originX: number; originY: number; cellSize: number }): FeatureCollection<LineString>;

  /** 栅格重分类 @stability stable */
  reclassify(grid: number[][], rules: Array<{ from: [number, number]; to: number }>): number[][];
}
```

### 7.8 transform/ — 几何变换

```typescript
export interface TransformOps {
  /** 旋转（绕 pivot 点，角度单位度）@stability stable */
  rotate(feature: Feature, angle: number, pivot?: [number, number]): Feature;
  /** 缩放（相对 origin 点）@stability stable */
  scale(feature: Feature, factor: number, origin?: [number, number]): Feature;
  /** 平移（经纬度增量）@stability stable */
  translate(feature: Feature, dx: number, dy: number): Feature;
  /** 翻转 @stability stable */
  flip(feature: Feature, axis: 'x' | 'y' | 'both'): Feature;

  /**
   * 修复多边形绕向。
   * 外环逆时针（面积 > 0），内环顺时针（面积 < 0）。
   * 不符合标准的绕向被翻转。
   * @stability stable
   */
  rewindPolygon(polygon: Feature<Polygon>): Feature<Polygon>;

  /**
   * 清理冗余坐标。
   * 1. 移除连续重复坐标（distance < epsilon）
   * 2. 移除共线中间点（三点在一条直线上）
   * 3. 保证多边形闭合（首尾一致）
   * @stability stable
   */
  cleanCoords(feature: Feature, options?: { epsilon?: number }): Feature;
}
```

### 7.9 aggregation/ — 聚合统计

```typescript
export interface AggregationOps {
  /**
   * 收集多边形内的点属性。
   * 对每个多边形，找到其内部所有点的指定属性值，汇总为数组。
   *
   * @param polygons - 聚合区域
   * @param points - 数据点
   * @param inProperty - 点的输入属性名
   * @param outProperty - 多边形的输出属性名（值为收集到的数组）
   *
   * 算法：
   *   1. 构建点的 R-Tree 空间索引
   *   2. 对每个多边形：bbox 预筛 → pointInPolygon 精确测试
   *   3. 收集匹配点的属性值到数组
   *
   * @stability stable
   */
  collect(polygons: FeatureCollection<Polygon>, points: FeatureCollection<Point>, inProperty: string, outProperty: string): FeatureCollection<Polygon>;

  /** 计数（每个多边形内的点数）@stability stable */
  count(polygons: FeatureCollection<Polygon>, points: FeatureCollection<Point>): FeatureCollection<Polygon>;

  /** 求和 @stability stable */
  sum(features: Feature[], property: string): number;

  /** 平均值 @stability stable */
  avg(features: Feature[], property: string): number;

  /** 中位数 @stability stable */
  median(features: Feature[], property: string): number;

  /** 标准差 @stability stable */
  deviation(features: Feature[], property: string): number;
}
```

### 7.10 topology/ — 拓扑关系

```typescript
export interface TopologyOps {
  /**
   * 包含关系（outer 完全包含 inner）。
   *
   * 算法：
   *   1. inner 的所有坐标都在 outer 内（pointInPolygon）
   *   2. inner 的边不与 outer 的边相交（除边界共享）
   *
   * @stability stable
   */
  booleanContains(outer: Feature<Polygon>, inner: Feature): boolean;

  /** inner 在 outer 内部（Contains 的反向）@stability stable */
  booleanWithin(inner: Feature, outer: Feature<Polygon>): boolean;

  /** 两个多边形部分重叠（有交集但不完全包含）@stability stable */
  booleanOverlap(a: Feature<Polygon>, b: Feature<Polygon>): boolean;

  /** 线与线/面交叉（内部相交，而非仅边界接触）@stability stable */
  booleanCrosses(a: Feature<LineString>, b: Feature<LineString | Polygon>): boolean;

  /** 不相交（无任何交集，包括边界）@stability stable */
  booleanDisjoint(a: Feature, b: Feature): boolean;

  /** 相交（有任何交集，包括边界接触）@stability stable */
  booleanIntersects(a: Feature, b: Feature): boolean;

  /** 边界接触（仅边界相交，内部不相交）@stability stable */
  booleanTouches(a: Feature, b: Feature): boolean;
}
```

### 7.11 分析包 对接 / 错误 / Tree-Shaking

```
对接：
  L0/algorithm — earcut/delaunay/intersect/contain/simplify/cluster 复用
  L0/index — rtree/kd-tree 空间索引
  L0/geo — geodesic 距离/面积/方位角计算
  L3/WorkerPool — 大数据集分析任务可提交到 Worker
  InternalBus 'analysis:complete' { operation, duration }

错误：
  | 输入几何为空 | CONFIG_INVALID_PARAM | 返回空结果或 null |
  | 输入不是有效 GeoJSON | CONFIG_INVALID_PARAM | throw GeoForgeError |
  | 数值溢出（面积计算极大多边形） | — | 使用 Float64 精度 + warn |
  | classCount 超出范围 | — | clamp [2, 20] + if(__DEV__) warn |
  | grid 为空数组 | — | 返回空结果 |
  | Marching Squares 歧义 case | — | 使用中心值决定（线性插值） |

Tree-Shaking：
  // 按子模块 import（不 import 整个 analysis 包）
  import { booleanOps } from '@geoforge/analysis/boolean';    // 只打包 boolean 模块
  import { classificationOps } from '@geoforge/analysis/classification';  // 只打包 classification
  // 每个子模块独立 tree-shakable

  // 完整 import（全部打包）
  import { booleanOps, bufferOps, ... } from '@geoforge/analysis';

@stability：全部方法在各子模块中已标注

__DEV__：
  if (__DEV__) { 大数据集性能警告：points.length > 100000 时 warn }
  if (__DEV__) { 布尔运算结果验证：面积守恒检查 }
  if (__DEV__) { 无效几何类型检查 }
```

---

## P3 完整统计（7 个包）

| 包 | 公共方法 | 核心算法 | 对接模块 | 错误场景 |
|---|---------|---------|---------|---------|
| source-wmts | 6 | TileMatrix→zoom 映射 / XML 解析 | 3 | 7 |
| source-wms | 7 | BBOX 轴序 / GetFeatureInfo | 4 | 5 |
| source-wfs | 6 | GML 解析 / 分页 / 缓存策略 | 4 | 5 |
| source-pmtiles | 5 | Hilbert 曲线 / Range Request / 多级目录 | 3 | 6 |
| compat-mobile | 3 | GPU 能力检测 / 3 级降质策略 | 4 | 3 |
| compat-hidpi | 5 | 动态分辨率（快降慢升）| 4 | 2 |
| analysis (9 子模块) | 58 | Martinez-Rueda / IDW / Marching Squares / Jenks / Fortune / Horn slope / 射线视域 | 5 | 7 |
| **合计** | **90** | | | **35** |

---

## 全部 27 包总统计

| 优先级 | 包数 | 方法 | WGSL | 行数 |
|--------|------|------|------|------|
| P0 | 6 | 105 | 5 | 2863 |
| P1 | 4 | 50 | 10 | 2371 |
| P2 | 10 | 66 | 14 | 1579 |
| P3 | 7 | 90 | 0 | ~2100 |
| **合计** | **27** | **311** | **29** | **~8913** |
