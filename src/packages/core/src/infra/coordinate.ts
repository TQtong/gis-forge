// ============================================================
// infra/coordinate.ts — CRS 注册表与坐标转换管线（自研实现）
// 内置 EPSG:4326 (WGS84) 和 EPSG:3857 (Web Mercator) 两种坐标系。
// 支持注册自定义 CRS 和执行坐标转换。
// 零外部依赖，所有投影算法自研。
// ============================================================

import type { BBox2D } from '../types/math-types.ts';

// ======================== 常量定义 ========================

/** WGS84 椭球长半轴（赤道半径，米） */
const WGS84_SEMI_MAJOR_AXIS = 6378137.0;

/** 墨卡托投影最大纬度（度），超出此范围的纬度在墨卡托中无法表示 */
const MERCATOR_MAX_LATITUDE = 85.06;

/** 度到弧度转换系数 */
const DEG_TO_RAD = Math.PI / 180.0;

/** 弧度到度转换系数 */
const RAD_TO_DEG = 180.0 / Math.PI;

/** 赤道周长（米），= 2π × 半径 */
const EARTH_CIRCUMFERENCE = 2.0 * Math.PI * WGS84_SEMI_MAJOR_AXIS;

/** 墨卡托投影的半范围（米），= 赤道周长 / 2 */
const MERCATOR_HALF_EXTENT = EARTH_CIRCUMFERENCE / 2.0;

// ======================== 类型定义 ========================

/**
 * 坐标参考系（CRS）定义。
 * 描述一个坐标系的标识、投影参数、有效范围和计量单位。
 */
export interface CRSDefinition {
    /** CRS 标识符，通常为 EPSG 代码（如 "EPSG:4326"） */
    readonly id: string;

    /**
     * Proj4 字符串格式的投影定义。
     * 用于描述投影参数，但本引擎不使用 proj4 库——
     * 内置的投影（4326/3857）直接用公式实现。
     * 此字段保留用于未来自定义 CRS 的参数传递。
     */
    readonly proj4String: string;

    /**
     * 该 CRS 的有效范围（在目标 CRS 坐标下的包围盒）。
     * 用于确定投影的有效区域，避免在范围外使用导致畸变。
     */
    readonly bounds: BBox2D;

    /**
     * 坐标单位。
     * degrees = 经纬度坐标系，meters = 投影坐标系。
     */
    readonly unit: 'degrees' | 'meters';
}

// ======================== 内部状态 ========================

/**
 * CRS 注册表：存储所有已注册的坐标参考系定义。
 * 使用 Map 以 CRS id 为键快速查找。
 */
const crsRegistry = new Map<string, CRSDefinition>();

/**
 * 坐标转换函数注册表。
 * 键格式为 `${fromCRS}→${toCRS}`，值为转换函数。
 */
const transformRegistry = new Map<string, (x: number, y: number) => [number, number]>();

// ======================== 内置 CRS 定义 ========================

/**
 * EPSG:4326 — WGS84 地理坐标系。
 * 坐标为经纬度（度），全球覆盖。
 * x = 经度 [-180, 180]，y = 纬度 [-90, 90]。
 */
const CRS_4326: CRSDefinition = {
    id: 'EPSG:4326',
    proj4String: '+proj=longlat +datum=WGS84 +no_defs',
    bounds: {
        west: -180,
        south: -90,
        east: 180,
        north: 90,
    },
    unit: 'degrees',
};

/**
 * EPSG:3857 — Web 墨卡托投影坐标系。
 * 坐标为米，覆盖 ±85.06° 纬度范围（形成正方形世界）。
 * 几乎所有 Web 地图瓦片服务使用此投影。
 */
const CRS_3857: CRSDefinition = {
    id: 'EPSG:3857',
    proj4String: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs',
    bounds: {
        west: -MERCATOR_HALF_EXTENT,
        south: -MERCATOR_HALF_EXTENT,
        east: MERCATOR_HALF_EXTENT,
        north: MERCATOR_HALF_EXTENT,
    },
    unit: 'meters',
};

// ======================== 内置转换函数 ========================

/**
 * EPSG:4326 → EPSG:3857 转换。
 * 经纬度（度）→ Web 墨卡托坐标（米）。
 *
 * @param lon - 经度（度）
 * @param lat - 纬度（度）
 * @returns [x, y] 墨卡托坐标（米）
 */
function forwardMercator(lon: number, lat: number): [number, number] {
    // 将纬度限制在墨卡托有效范围内，避免 tan() 趋近无穷
    const clampedLat = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));

    // 经度直接线性映射
    const x = lon * DEG_TO_RAD * WGS84_SEMI_MAJOR_AXIS;

    // 纬度使用墨卡托公式：y = R * ln(tan(π/4 + φ/2))
    const latRad = clampedLat * DEG_TO_RAD;
    const y = WGS84_SEMI_MAJOR_AXIS * Math.log(Math.tan(Math.PI / 4 + latRad / 2));

    return [x, y];
}

/**
 * EPSG:3857 → EPSG:4326 转换。
 * Web 墨卡托坐标（米）→ 经纬度（度）。
 *
 * @param x - 墨卡托 x 坐标（米）
 * @param y - 墨卡托 y 坐标（米）
 * @returns [lon, lat] 经纬度（度）
 */
function inverseMercator(x: number, y: number): [number, number] {
    // 经度：线性反算
    const lon = (x / WGS84_SEMI_MAJOR_AXIS) * RAD_TO_DEG;

    // 纬度：反墨卡托公式 φ = 2 * atan(exp(y/R)) - π/2
    const lat = (2 * Math.atan(Math.exp(y / WGS84_SEMI_MAJOR_AXIS)) - Math.PI / 2) * RAD_TO_DEG;

    return [lon, lat];
}

// ======================== 初始化：注册内置 CRS ========================

/** 注册 EPSG:4326 */
crsRegistry.set(CRS_4326.id, CRS_4326);

/** 注册 EPSG:3857 */
crsRegistry.set(CRS_3857.id, CRS_3857);

/** 注册 4326→3857 转换 */
transformRegistry.set('EPSG:4326→EPSG:3857', forwardMercator);

/** 注册 3857→4326 转换 */
transformRegistry.set('EPSG:3857→EPSG:4326', inverseMercator);

/** 恒等变换：同 CRS 转换直接返回原始坐标 */
transformRegistry.set('EPSG:4326→EPSG:4326', (x, y) => [x, y]);
transformRegistry.set('EPSG:3857→EPSG:3857', (x, y) => [x, y]);

// ======================== 公共 API ========================

/**
 * 注册一个自定义坐标参考系。
 * 注册后可以通过 getCRS() 查询定义，
 * 但要支持 transform() 还需要额外注册转换函数。
 *
 * @param def - CRS 定义
 *
 * @example
 * registerCRS({
 *   id: 'EPSG:2154',
 *   proj4String: '+proj=lcc +lat_1=49 +lat_2=44 ...',
 *   bounds: { west: -9.86, south: 41.15, east: 10.38, north: 51.56 },
 *   unit: 'meters',
 * });
 */
export function registerCRS(def: CRSDefinition): void {
    // 验证必填字段
    if (!def.id || typeof def.id !== 'string') {
        throw new Error('[CRS] Invalid CRS definition: id is required and must be a string.');
    }

    // 存入注册表（允许覆盖已有定义）
    crsRegistry.set(def.id, def);

    // 自动注册恒等变换
    const selfKey = `${def.id}→${def.id}`;
    if (!transformRegistry.has(selfKey)) {
        transformRegistry.set(selfKey, (x, y) => [x, y]);
    }
}

/**
 * 查询已注册的 CRS 定义。
 *
 * @param id - CRS 标识符（如 "EPSG:4326"）
 * @returns CRS 定义，或 undefined（未注册）
 *
 * @example
 * const wgs84 = getCRS('EPSG:4326');
 * if (wgs84) {
 *   console.log(wgs84.unit); // → 'degrees'
 * }
 */
export function getCRS(id: string): CRSDefinition | undefined {
    return crsRegistry.get(id);
}

/**
 * 在两个坐标系之间转换坐标。
 * 支持内置的 4326↔3857 转换，以及通过 4326 中转的链式转换。
 *
 * @param from - 源 CRS 标识符
 * @param to - 目标 CRS 标识符
 * @param x - 源坐标 x（经度/投影 x）
 * @param y - 源坐标 y（纬度/投影 y）
 * @returns [x, y] 目标坐标
 * @throws 如果找不到转换路径
 *
 * @example
 * // 经纬度 → 墨卡托
 * const [mx, my] = transform('EPSG:4326', 'EPSG:3857', 116.39, 39.91);
 *
 * @example
 * // 墨卡托 → 经纬度
 * const [lon, lat] = transform('EPSG:3857', 'EPSG:4326', 12958175, 4852834);
 */
export function transform(
    from: string,
    to: string,
    x: number,
    y: number,
): [number, number] {
    // 同 CRS 快速路径
    if (from === to) {
        return [x, y];
    }

    // NaN 检查
    if (x !== x || y !== y) {
        return [NaN, NaN];
    }

    // 查找直接转换函数
    const directKey = `${from}→${to}`;
    const directFn = transformRegistry.get(directKey);
    if (directFn !== undefined) {
        return directFn(x, y);
    }

    // 尝试通过 EPSG:4326 中转
    // from → 4326 → to
    const to4326Key = `${from}→EPSG:4326`;
    const from4326Key = `EPSG:4326→${to}`;
    const to4326Fn = transformRegistry.get(to4326Key);
    const from4326Fn = transformRegistry.get(from4326Key);

    if (to4326Fn !== undefined && from4326Fn !== undefined) {
        const [midX, midY] = to4326Fn(x, y);
        return from4326Fn(midX, midY);
    }

    // 无法找到转换路径
    throw new Error(
        `[CRS] No transform path found from "${from}" to "${to}". ` +
        `Register transforms using registerTransform() or through EPSG:4326 as hub.`,
    );
}

/**
 * 注册自定义坐标转换函数。
 * 允许用户为任意两个 CRS 之间注册正向和反向转换。
 *
 * @param from - 源 CRS 标识符
 * @param to - 目标 CRS 标识符
 * @param fn - 转换函数 (x, y) → [x', y']
 *
 * @example
 * registerTransform('EPSG:4326', 'EPSG:2154', (lon, lat) => {
 *   // 自定义 Lambert 投影实现
 *   return [lambertX, lambertY];
 * });
 */
export function registerTransform(
    from: string,
    to: string,
    fn: (x: number, y: number) => [number, number],
): void {
    const key = `${from}→${to}`;
    transformRegistry.set(key, fn);
}
