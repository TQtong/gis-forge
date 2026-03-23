// ============================================================
// types/tile.ts — 瓦片坐标、参数、数据、状态
// 被引用于：L3/TileScheduler, L4/SourceManager, L5/DataSource,
//          L0/types/feature.ts（TileCoord）
// 瓦片相关类型的唯一定义源（Single Source of Truth）。
//
// 注意：BBox2D 的权威定义位于 L0/math/bbox.ts。此处临时内联定义
// 以避免循环依赖，待 math/bbox.ts 创建后应统一 import。
// ============================================================

// ===================== 临时内联 BBox2D =====================

/**
 * 2D 包围盒（Bounding Box）。
 * 在地理语境下表示经纬度矩形范围，在投影语境下表示投影坐标矩形范围。
 *
 * 注意：此定义为临时内联版本。BBox2D 的权威定义位于 `math/bbox.ts`，
 * 待该模块创建后，此处将改为从 `math/bbox.ts` re-export。
 *
 * @example
 * const beijing: BBox2D = {
 *   west: 116.0, south: 39.5, east: 117.0, north: 40.5
 * };
 */
export interface BBox2D {
  /** 西边界（最小经度或最小 X），单位度或投影单位 */
  readonly west: number;

  /** 南边界（最小纬度或最小 Y），单位度或投影单位 */
  readonly south: number;

  /** 东边界（最大经度或最大 X），单位度或投影单位 */
  readonly east: number;

  /** 北边界（最大纬度或最大 Y），单位度或投影单位 */
  readonly north: number;
}

// ===================== 瓦片坐标 =====================

/**
 * 瓦片坐标（XYZ Tile Coordinate）。
 * 在 Web 墨卡托瓦片方案中唯一标识一个瓦片。
 * x/y 范围为 [0, 2^z - 1]，z 为缩放级别。
 * 遵循 Slippy Map / TMS 瓦片编号约定。
 *
 * @example
 * const coord: TileCoord = { x: 215, y: 99, z: 8 };
 */
export interface TileCoord {
  /**
   * 瓦片列号（水平方向）。
   * 范围 [0, 2^z - 1]，从左（西）到右（东）递增。
   * 必须为非负整数。
   */
  readonly x: number;

  /**
   * 瓦片行号（垂直方向）。
   * XYZ 方案：范围 [0, 2^z - 1]，从上（北）到下（南）递增。
   * TMS 方案：方向相反，从下（南）到上（北）递增。
   * 必须为非负整数。
   */
  readonly y: number;

  /**
   * 缩放级别（Zoom Level）。
   * 范围通常 [0, 22]，z=0 为全球单瓦片，每增加 1 级分辨率翻倍。
   * z 级别下共有 2^z × 2^z 个瓦片。
   * 必须为非负整数。
   */
  readonly z: number;
}

// ===================== 瓦片请求参数 =====================

/**
 * 瓦片请求参数。
 * 由 TileScheduler 组装后传递给 SourceManager / WorkerPool，
 * 包含瓦片坐标、地理范围和取消信号。
 *
 * @example
 * const params: TileParams = {
 *   x: 215, y: 99, z: 8,
 *   extent: { west: 112.5, south: 33.43, east: 114.08, north: 34.30 },
 *   signal: abortController.signal,
 * };
 */
export interface TileParams {
  /**
   * 瓦片列号。
   * 同 TileCoord.x，范围 [0, 2^z - 1]。
   */
  readonly x: number;

  /**
   * 瓦片行号。
   * 同 TileCoord.y，范围 [0, 2^z - 1]。
   */
  readonly y: number;

  /**
   * 缩放级别。
   * 同 TileCoord.z，范围 [0, 22]。
   */
  readonly z: number;

  /**
   * 瓦片覆盖的地理范围（经纬度包围盒）。
   * 由 TileScheduler 根据瓦片坐标计算得出。
   * 用于 Worker 端的坐标变换和空间查询。
   */
  readonly extent: BBox2D;

  /**
   * 请求取消信号。
   * 当瓦片不再需要时（如用户快速缩放/平移），通过 AbortController.abort()
   * 取消正在进行的网络请求和 Worker 计算，避免资源浪费。
   */
  readonly signal: AbortSignal;
}

// ===================== 瓦片数据 =====================

/**
 * 瓦片数据容器。
 * 封装从数据源加载并可能经 Worker 解码/处理后的瓦片数据。
 * 泛型参数 T 表示具体的数据类型（如 MVT 解码结果、栅格像素、DEM 高程等）。
 *
 * @typeParam T - 瓦片数据的具体类型，默认为 `any`
 *
 * @example
 * const tileData: TileData<Uint8Array> = {
 *   data: decodedPixels,
 *   extent: { west: 112.5, south: 33.43, east: 114.08, north: 34.30 },
 *   transferables: [decodedPixels.buffer],
 *   byteSize: decodedPixels.byteLength,
 *   expiresAt: Date.now() + 3600_000,
 * };
 */
export interface TileData<T = any> {
  /**
   * 解码后的瓦片数据。
   * 具体类型取决于数据源和图层类型：
   * - 矢量瓦片：解码后的 Feature 数组或顶点缓冲区
   * - 栅格瓦片：ImageBitmap 或 Uint8Array 像素数据
   * - DEM 瓦片：Float32Array 高程数据
   * - 3D Tiles：解码后的网格数据
   */
  readonly data: T;

  /**
   * 瓦片覆盖的地理范围。
   * 与请求时的 TileParams.extent 一致，冗余存储方便下游使用。
   */
  readonly extent: BBox2D;

  /**
   * 可转移对象列表（Transferable[]）。
   * 用于 Worker→主线程 postMessage 时零拷贝传输 ArrayBuffer。
   * 传输后原 Worker 端的引用将失效（所有权转移）。
   * 可选，无 transferable 数据时为 undefined。
   */
  readonly transferables?: Transferable[];

  /**
   * 瓦片数据的字节大小。
   * 用于 MemoryBudget 跟踪 GPU/CPU 内存占用，辅助 LRU 淘汰决策。
   * 单位：字节。可选，未知大小时为 undefined。
   */
  readonly byteSize?: number;

  /**
   * 缓存过期时间戳（Unix 毫秒）。
   * 超过此时间后应重新请求瓦片数据。
   * 来源于 HTTP Cache-Control / Expires 头。
   * 可选，undefined 表示不设过期（永久缓存或由 LRU 淘汰）。
   */
  readonly expiresAt?: number;
}

// ===================== 瓦片状态 =====================

/**
 * 瓦片生命周期状态。
 * TileScheduler 使用此状态管理瓦片的加载流程和缓存策略。
 *
 * 状态流转：
 * ```
 * empty → loading → loaded → cached
 *                 ↘ error → (重试) → loading
 * ```
 *
 * - `'empty'`: 初始状态，瓦片尚未开始加载
 * - `'loading'`: 正在从网络/Worker 加载中
 * - `'loaded'`: 加载完成，数据已就绪且正在渲染中
 * - `'error'`: 加载失败（网络错误、解码失败等），等待重试
 * - `'cached'`: 不在当前视口中但仍在 LRU 缓存中，可被快速恢复
 *
 * @example
 * let state: TileState = 'empty';
 * state = 'loading'; // 开始加载
 * state = 'loaded';  // 加载成功
 */
export type TileState = 'empty' | 'loading' | 'loaded' | 'error' | 'cached';
