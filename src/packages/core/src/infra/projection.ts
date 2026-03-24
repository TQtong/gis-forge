// ============================================================
// infra/projection.ts — 投影模块接口定义
// 定义 GeoForge 引擎的投影插件接口 (ProjectionDef) 和瓦片网格定义。
// 这些接口由 L5 扩展层的 CustomProjection (EP2) 实现，
// 由 L2 ShaderAssembler 的投影 WGSL 模块使用。
// 零外部依赖。
// ============================================================

import type { BBox2D } from '../types/math-types.ts';

// ======================== 类型定义 ========================

/**
 * 瓦片网格定义。
 * 描述投影对应的瓦片网格参数，用于 TileScheduler 计算需要加载的瓦片。
 *
 * @example
 * const webMercatorGrid: TileGridDefinition = {
 *   origin: [-20037508.34, 20037508.34],    // 左上角
 *   tileSize: 512,                          // 像素
 *   resolutions: [156543.03, 78271.52, ...], // 每级分辨率（米/像素）
 *   matrixIds: ['0', '1', '2', ...],        // WMTS 矩阵标识
 * };
 */
export interface TileGridDefinition {
    /**
     * 瓦片网格原点 [x, y]（投影坐标系下）。
     * 通常为左上角坐标。WMTS 标准中即为 TopLeftCorner。
     */
    readonly origin: [number, number];

    /**
     * 瓦片大小（像素）。
     * 标准值为 256 或 512。影响请求粒度和 GPU 纹理大小。
     */
    readonly tileSize: number;

    /**
     * 每个缩放级别的分辨率（投影坐标单位/像素）。
     * 数组索引 = 缩放级别，值 = 该级别下每个像素代表的投影单位数。
     * Web 墨卡托 z=0 分辨率 ≈ 156543.03 m/px。
     */
    readonly resolutions: number[];

    /**
     * WMTS 矩阵标识数组。
     * 与 resolutions 一一对应，用于构造 WMTS 瓦片请求 URL。
     */
    readonly matrixIds: string[];
}

/**
 * 投影模块定义接口。
 * GeoForge 的每种投影（墨卡托、等距圆柱、球面等）都实现此接口。
 * 接口包含投影的数学参数和 GPU 端使用的 WGSL 代码。
 *
 * 通过 L5 的 ExtensionPoint EP2 (CustomProjection) 注册自定义投影。
 *
 * @example
 * const mercator: ProjectionDef = {
 *   id: 'mercator',
 *   epsg: 3857,
 *   wgslCode: '...',     // WGSL 投影函数
 *   bounds: { west: -180, south: -85.06, east: 180, north: 85.06 },
 *   isGlobal: false,
 *   requiresDoublePrecision: false,
 *   wrapsX: true,
 *   antimeridianHandling: 'wrap',
 *   project: (lon, lat) => [...],
 *   unproject: (x, y) => [...],
 * };
 */
export interface ProjectionDef {
    /**
     * 投影唯一标识符。
     * 用于在 ShaderAssembler 中选择对应的 WGSL 投影模块。
     * 例如 'mercator', 'equirectangular', 'globe'。
     */
    readonly id: string;

    /**
     * 对应的 EPSG 代码。
     * 墨卡托 = 3857, WGS84 = 4326, 等。
     * 自定义投影可使用负数或 0 表示非标准。
     */
    readonly epsg: number;

    /**
     * GPU 端投影函数的 WGSL 代码。
     * 包含 `fn projectPosition(lonLat: vec2<f32>) -> vec2<f32>` 等函数。
     * 由 ShaderAssembler 在编译 shader 时注入到顶点着色器中。
     * 不同投影的 WGSL 代码被编译为不同的 Shader Variant。
     */
    readonly wgslCode: string;

    /**
     * 投影的有效地理范围（经纬度包围盒）。
     * 超出此范围的坐标在该投影中可能产生严重畸变或无法表示。
     * 用于 TileScheduler 判断哪些瓦片在当前投影下可见。
     */
    readonly bounds: BBox2D;

    /**
     * 是否为全球投影（能显示整个地球）。
     * true: 球面投影（Globe3D）、等距圆柱投影等。
     * false: 区域投影（如 Lambert, UTM）。
     */
    readonly isGlobal: boolean;

    /**
     * 是否需要双精度支持。
     * true: 投影范围很大或坐标值很大，需要 SplitDouble/RTC。
     * 球面投影和墨卡托在全球范围下通常需要双精度。
     */
    readonly requiresDoublePrecision: boolean;

    /**
     * X 轴是否环绕（循环连续）。
     * true: 经度 -180° 和 180° 连续（如墨卡托、球面）。
     * false: X 轴有明确的边界。
     */
    readonly wrapsX: boolean;

    /**
     * 反子午线处理策略。
     * - 'wrap': 自动将跨越反子午线的几何体包裹到正确位置
     * - 'split': 将跨越反子午线的几何体分裂为两部分
     * - 'none': 不处理（仅限区域投影）
     */
    readonly antimeridianHandling: 'wrap' | 'split' | 'none';

    /**
     * CPU 端正向投影函数：经纬度（度）→ 投影坐标。
     * 用于在 CPU 端进行坐标预处理（如瓦片范围计算、标注定位）。
     *
     * @param lon - 经度（度），范围 [-180, 180]
     * @param lat - 纬度（度），范围 [-90, 90]
     * @returns [x, y] 投影坐标
     */
    project(lon: number, lat: number): [number, number];

    /**
     * CPU 端反向投影函数：投影坐标 → 经纬度（度）。
     * 用于屏幕坐标拾取、鼠标位置转经纬度等操作。
     *
     * @param x - 投影坐标 x
     * @param y - 投影坐标 y
     * @returns [lon, lat] 经纬度（度）
     */
    unproject(x: number, y: number): [number, number];

    /**
     * 可选的瓦片网格定义。
     * 如果投影有自己的瓦片网格（如 WMTS 非标准矩阵），在此定义。
     * 不提供时使用默认的 Web 墨卡托瓦片网格。
     */
    readonly tileGrid?: TileGridDefinition;
}
