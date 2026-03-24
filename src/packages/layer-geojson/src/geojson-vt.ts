// ============================================================
// layer-geojson/geojson-vt.ts — GeoJSON 瓦片切片器
// 将 GeoJSON FeatureCollection 预处理为按瓦片坐标索引的切片。
// 支持多级缩放简化、瓦片边界裁剪、跨瓦片要素处理。
// 零 npm 依赖——自研简化版（对标 geojson-vt 核心逻辑）。
// 依赖层级：可在 Worker 或主线程运行，纯函数 + 工厂模式。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * 默认最大缩放级别（超过此级别不再细分）。
 */
const DEFAULT_MAX_ZOOM = 14;

/**
 * 默认索引最大缩放（初始索引构建到的级别）。
 */
const DEFAULT_INDEX_MAX_ZOOM = 5;

/**
 * 默认简化容差（瓦片坐标 [0,1] 下的容差比率）。
 * 对应约 ~3px at 4096 extent。
 */
const DEFAULT_TOLERANCE = 3 / 4096;

/**
 * 默认瓦片范围（extent），影响坐标精度。
 */
const DEFAULT_EXTENT = 4096;

/**
 * 瓦片裁剪缓冲（瓦片坐标 [0,1] 下的溢出容差）。
 * 避免线段在瓦片边界产生视觉接缝。
 */
const DEFAULT_BUFFER = 64 / 4096;

/**
 * 最小包围盒面积阈值（瓦片坐标下），小于此面积的 Polygon 在简化时丢弃。
 */
const MIN_AREA_THRESHOLD = 1e-12;

/**
 * 经度→瓦片坐标 [0, 1] 的换算（将 [-180, 180] 映射到 [0, 1]）。
 */
const LNG_TO_TILE_FACTOR = 1 / 360;

/**
 * Web 墨卡托纬度上限（度），超出此范围截断。
 */
const MAX_LATITUDE = 85.051129;

// ===================== 类型接口 =====================

/**
 * GeoJSON-VT 配置选项。
 */
export interface GeoJSONVTOptions {
    /** 最大缩放级别，默认 14。 */
    readonly maxZoom?: number;

    /** 索引构建最大缩放，默认 5。 */
    readonly indexMaxZoom?: number;

    /** 简化容差（瓦片坐标比率），默认 3/4096。 */
    readonly tolerance?: number;

    /** 瓦片坐标范围，默认 4096。 */
    readonly extent?: number;

    /** 裁剪缓冲（瓦片坐标比率），默认 64/4096。 */
    readonly buffer?: number;
}

/**
 * 切片后的单个要素。
 */
export interface SlicedFeature {
    /** 原始 GeoJSON 要素索引。 */
    readonly index: number;

    /** 几何类型：1=Point, 2=LineString, 3=Polygon。 */
    readonly type: number;

    /**
     * 几何坐标（瓦片坐标 [0, extent]）。
     * 点：[x, y][]
     * 线/面：[x, y][][] （环列表）
     */
    readonly geometry: number[][][];

    /** 属性（与原始 GeoJSON 共享引用）。 */
    readonly properties: Record<string, unknown> | null;

    /** 要素 ID（来自 GeoJSON feature.id）。 */
    readonly id: string | number | null;
}

/**
 * 切片后的单个瓦片。
 */
export interface VTTile {
    /** 瓦片内要素列表。 */
    readonly features: SlicedFeature[];

    /** 要素总数。 */
    readonly numFeatures: number;

    /** 点数总数（用于统计/调试）。 */
    readonly numPoints: number;
}

/**
 * GeoJSON-VT 实例接口。
 */
export interface GeoJSONVT {
    /**
     * 获取指定瓦片的切片数据。
     *
     * @param z - 缩放级别
     * @param x - 列号
     * @param y - 行号
     * @returns 切片瓦片；若无数据返回 null
     */
    getTile(z: number, x: number, y: number): VTTile | null;

    /**
     * 获取已缓存的瓦片总数（调试用途）。
     *
     * @returns 瓦片数
     */
    getCachedTileCount(): number;
}

// ===================== 内部类型 =====================

/**
 * 内部预处理后的要素（坐标已转为 [0,1] 瓦片空间）。
 */
interface InternalFeature {
    /** 原始索引。 */
    readonly index: number;
    /** 类型：1=Point, 2=LineString, 3=Polygon。 */
    readonly type: number;
    /** 几何（[0,1] 坐标）。 */
    geometry: number[][][];
    /** 包围盒 [minX, minY, maxX, maxY]。 */
    bbox: [number, number, number, number];
    /** 属性引用。 */
    readonly properties: Record<string, unknown> | null;
    /** 要素 ID。 */
    readonly id: string | number | null;
    /** 简化后的最小面积（用于跳过微小多边形）。 */
    area: number;
}

/**
 * 内部瓦片缓存条目。
 */
interface TileCacheEntry {
    /** 该瓦片的要素子集。 */
    features: InternalFeature[];
    /** 是否已完成简化。 */
    simplified: boolean;
}

// ===================== 坐标转换 =====================

/**
 * 经度转瓦片坐标 X（[0, 1]）。
 *
 * @param lng - 经度（度）
 * @returns [0, 1]
 */
function lngToTileX(lng: number): number {
    return (lng + 180) * LNG_TO_TILE_FACTOR;
}

/**
 * 纬度转瓦片坐标 Y（[0, 1]，Web 墨卡托投影）。
 *
 * @param lat - 纬度（度）
 * @returns [0, 1]
 */
function latToTileY(lat: number): number {
    // 限制纬度到 Web 墨卡托有效范围
    const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
    const latRad = (clamped * Math.PI) / 180;
    const y = 0.5 - 0.5 * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI;
    return Math.max(0, Math.min(1, y));
}

// ===================== 几何简化（Douglas-Peucker 简化版） =====================

/**
 * 计算点到线段的平方距离。
 *
 * @param px - 点 X
 * @param py - 点 Y
 * @param ax - 线段起点 X
 * @param ay - 线段起点 Y
 * @param bx - 线段终点 X
 * @param by - 线段终点 Y
 * @returns 平方距离
 */
function pointToSegmentDistSq(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-20) {
        // 退化为点
        const ex = px - ax;
        const ey = py - ay;
        return ex * ex + ey * ey;
    }

    // 投影参数 t ∈ [0, 1]
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const cx = ax + t * dx - px;
    const cy = ay + t * dy - py;
    return cx * cx + cy * cy;
}

/**
 * Douglas-Peucker 简化算法（迭代版，避免深递归栈溢出）。
 *
 * @param ring - 坐标环 [[x,y], ...]
 * @param toleranceSq - 容差的平方
 * @returns 简化后的坐标环
 */
function simplifyRing(ring: number[][], toleranceSq: number): number[][] {
    const n = ring.length;
    if (n <= 2) {
        return ring;
    }

    // 标记数组：true = 保留
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    // 迭代栈（替代递归）
    const stack: [number, number][] = [[0, n - 1]];

    while (stack.length > 0) {
        const [start, end] = stack.pop()!;
        if (end - start <= 1) {
            continue;
        }

        let maxDistSq = 0;
        let maxIdx = start;

        const ax = ring[start][0];
        const ay = ring[start][1];
        const bx = ring[end][0];
        const by = ring[end][1];

        for (let i = start + 1; i < end; i++) {
            const dSq = pointToSegmentDistSq(ring[i][0], ring[i][1], ax, ay, bx, by);
            if (dSq > maxDistSq) {
                maxDistSq = dSq;
                maxIdx = i;
            }
        }

        if (maxDistSq > toleranceSq) {
            keep[maxIdx] = 1;
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }

    const result: number[][] = [];
    for (let i = 0; i < n; i++) {
        if (keep[i] === 1) {
            result.push(ring[i]);
        }
    }

    return result;
}

/**
 * 计算环的有符号面积（Shoelace 公式）。
 * 正值=逆时针（外环），负值=顺时针（内环）。
 *
 * @param ring - 坐标环
 * @returns 有符号面积
 */
function ringArea(ring: number[][]): number {
    let area = 0;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
        area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return area * 0.5;
}

// ===================== 瓦片裁剪 =====================

/**
 * 将要素裁剪到指定瓦片范围。
 * 使用 Sutherland-Hodgman 裁剪（点/线/面）。
 *
 * @param features - 内部要素列表
 * @param z - 缩放
 * @param tx - 瓦片列
 * @param ty - 瓦片行
 * @param buffer - 裁剪缓冲
 * @returns 裁剪后的要素列表
 */
function clipFeatures(
    features: InternalFeature[],
    z: number,
    tx: number,
    ty: number,
    buffer: number,
): InternalFeature[] {
    const scale = 1 << z;
    // 瓦片在 [0,1] 坐标中的范围
    const tileMinX = tx / scale - buffer;
    const tileMaxX = (tx + 1) / scale + buffer;
    const tileMinY = ty / scale - buffer;
    const tileMaxY = (ty + 1) / scale + buffer;

    const result: InternalFeature[] = [];

    for (const feat of features) {
        // 快速包围盒排除
        if (
            feat.bbox[2] < tileMinX ||
            feat.bbox[0] > tileMaxX ||
            feat.bbox[3] < tileMinY ||
            feat.bbox[1] > tileMaxY
        ) {
            continue;
        }

        const clippedGeom: number[][][] = [];

        for (const ring of feat.geometry) {
            // 依次按 4 条边裁剪
            let clipped = clipRingToAxis(ring, 0, tileMinX, true);
            clipped = clipRingToAxis(clipped, 0, tileMaxX, false);
            clipped = clipRingToAxis(clipped, 1, tileMinY, true);
            clipped = clipRingToAxis(clipped, 1, tileMaxY, false);

            if (clipped.length > 0) {
                clippedGeom.push(clipped);
            }
        }

        if (clippedGeom.length > 0) {
            result.push({
                index: feat.index,
                type: feat.type,
                geometry: clippedGeom,
                bbox: computeBBox(clippedGeom),
                properties: feat.properties,
                id: feat.id,
                area: feat.area,
            });
        }
    }

    return result;
}

/**
 * 沿单轴裁剪坐标环（Sutherland-Hodgman 单边裁剪）。
 *
 * @param ring - 输入环
 * @param axis - 0=X轴, 1=Y轴
 * @param threshold - 裁剪阈值
 * @param keepGreater - true=保留 ≥ threshold 侧，false=保留 ≤ threshold 侧
 * @returns 裁剪后的环
 */
function clipRingToAxis(
    ring: number[][],
    axis: number,
    threshold: number,
    keepGreater: boolean,
): number[][] {
    if (ring.length === 0) {
        return ring;
    }

    const result: number[][] = [];
    const n = ring.length;

    for (let i = 0; i < n; i++) {
        const curr = ring[i];
        const prev = ring[(i + n - 1) % n];

        const currInside = keepGreater ? curr[axis] >= threshold : curr[axis] <= threshold;
        const prevInside = keepGreater ? prev[axis] >= threshold : prev[axis] <= threshold;

        if (currInside) {
            if (!prevInside) {
                // 从外→内：添加交点
                result.push(intersectEdge(prev, curr, axis, threshold));
            }
            result.push(curr);
        } else if (prevInside) {
            // 从内→外：添加交点
            result.push(intersectEdge(prev, curr, axis, threshold));
        }
    }

    return result;
}

/**
 * 计算线段与轴对齐线的交点。
 *
 * @param a - 线段起点
 * @param b - 线段终点
 * @param axis - 0=X, 1=Y
 * @param threshold - 阈值
 * @returns 交点 [x, y]
 */
function intersectEdge(a: number[], b: number[], axis: number, threshold: number): number[] {
    const other = axis === 0 ? 1 : 0;
    const diff = b[axis] - a[axis];
    // 防除零
    if (Math.abs(diff) < 1e-15) {
        return [a[0], a[1]];
    }
    const t = (threshold - a[axis]) / diff;
    const pt = [0, 0];
    pt[axis] = threshold;
    pt[other] = a[other] + t * (b[other] - a[other]);
    return pt;
}

// ===================== 包围盒辅助 =====================

/**
 * 计算几何的包围盒。
 *
 * @param geometry - 环列表
 * @returns [minX, minY, maxX, maxY]
 */
function computeBBox(geometry: number[][][]): [number, number, number, number] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const ring of geometry) {
        for (const pt of ring) {
            if (pt[0] < minX) { minX = pt[0]; }
            if (pt[1] < minY) { minY = pt[1]; }
            if (pt[0] > maxX) { maxX = pt[0]; }
            if (pt[1] > maxY) { maxY = pt[1]; }
        }
    }

    return [minX, minY, maxX, maxY];
}

// ===================== GeoJSON → 内部要素 =====================

/**
 * 将 GeoJSON FeatureCollection 转换为内部要素列表（坐标转为 [0,1] 瓦片空间）。
 *
 * @param data - GeoJSON 数据
 * @returns 内部要素数组
 */
function convertGeoJSON(data: Record<string, unknown>): InternalFeature[] {
    const features: InternalFeature[] = [];
    const type = data['type'] as string;

    if (type === 'FeatureCollection') {
        const rawFeatures = data['features'] as Record<string, unknown>[];
        if (!Array.isArray(rawFeatures)) {
            return features;
        }
        for (let i = 0; i < rawFeatures.length; i++) {
            const feat = rawFeatures[i];
            const converted = convertFeature(feat, i);
            if (converted !== null) {
                features.push(converted);
            }
        }
    } else if (type === 'Feature') {
        const converted = convertFeature(data, 0);
        if (converted !== null) {
            features.push(converted);
        }
    }

    return features;
}

/**
 * 转换单个 GeoJSON Feature 为内部表示。
 *
 * @param feat - GeoJSON Feature 对象
 * @param index - 原始索引
 * @returns 内部要素或 null
 */
function convertFeature(feat: Record<string, unknown>, index: number): InternalFeature | null {
    const geom = feat['geometry'] as Record<string, unknown> | null | undefined;
    if (geom === null || geom === undefined) {
        return null;
    }

    const geomType = geom['type'] as string;
    const coords = geom['coordinates'] as unknown;
    const properties = (feat['properties'] as Record<string, unknown>) ?? null;
    const id = (feat['id'] as string | number) ?? null;

    let type: number;
    let rings: number[][][] = [];

    if (geomType === 'Point') {
        type = 1;
        const c = coords as [number, number];
        if (Array.isArray(c) && c.length >= 2) {
            rings = [[[lngToTileX(c[0]), latToTileY(c[1])]]];
        }
    } else if (geomType === 'MultiPoint') {
        type = 1;
        const cs = coords as [number, number][];
        if (Array.isArray(cs)) {
            const pts: number[][] = [];
            for (const c of cs) {
                if (Array.isArray(c) && c.length >= 2) {
                    pts.push([lngToTileX(c[0]), latToTileY(c[1])]);
                }
            }
            if (pts.length > 0) {
                rings = [pts];
            }
        }
    } else if (geomType === 'LineString') {
        type = 2;
        const cs = coords as [number, number][];
        if (Array.isArray(cs)) {
            const ring = cs.filter(c => Array.isArray(c) && c.length >= 2)
                .map(c => [lngToTileX(c[0]), latToTileY(c[1])]);
            if (ring.length >= 2) {
                rings = [ring];
            }
        }
    } else if (geomType === 'MultiLineString') {
        type = 2;
        const lines = coords as [number, number][][];
        if (Array.isArray(lines)) {
            for (const line of lines) {
                if (Array.isArray(line)) {
                    const ring = line.filter(c => Array.isArray(c) && c.length >= 2)
                        .map(c => [lngToTileX(c[0]), latToTileY(c[1])]);
                    if (ring.length >= 2) {
                        rings.push(ring);
                    }
                }
            }
        }
    } else if (geomType === 'Polygon') {
        type = 3;
        const polys = coords as [number, number][][];
        if (Array.isArray(polys)) {
            for (const polyRing of polys) {
                if (Array.isArray(polyRing)) {
                    const ring = polyRing.filter(c => Array.isArray(c) && c.length >= 2)
                        .map(c => [lngToTileX(c[0]), latToTileY(c[1])]);
                    if (ring.length >= 3) {
                        rings.push(ring);
                    }
                }
            }
        }
    } else if (geomType === 'MultiPolygon') {
        type = 3;
        const multiPoly = coords as [number, number][][][];
        if (Array.isArray(multiPoly)) {
            for (const poly of multiPoly) {
                if (Array.isArray(poly)) {
                    for (const polyRing of poly) {
                        if (Array.isArray(polyRing)) {
                            const ring = polyRing.filter(c => Array.isArray(c) && c.length >= 2)
                                .map(c => [lngToTileX(c[0]), latToTileY(c[1])]);
                            if (ring.length >= 3) {
                                rings.push(ring);
                            }
                        }
                    }
                }
            }
        }
    } else {
        return null;
    }

    if (rings.length === 0) {
        return null;
    }

    const bbox = computeBBox(rings);
    // 估算面积（用于跳过微小多边形）
    let area = 0;
    if (type === 3) {
        for (const ring of rings) {
            area += Math.abs(ringArea(ring));
        }
    }

    return {
        index,
        type: type!,
        geometry: rings,
        bbox,
        properties,
        id,
        area,
    };
}

// ===================== 工厂函数 =====================

/**
 * 创建 GeoJSON 瓦片切片器。
 * 将 GeoJSON 数据预处理并按需切片到任意瓦片坐标。
 *
 * @param data - GeoJSON 对象（FeatureCollection 或 Feature）
 * @param options - 切片选项
 * @returns GeoJSONVT 实例
 *
 * @stability stable
 *
 * @example
 * const vt = createGeoJSONVT(geojsonData, { maxZoom: 16 });
 * const tile = vt.getTile(10, 512, 341);
 * if (tile) {
 *   for (const f of tile.features) {
 *     console.log(f.type, f.geometry);
 *   }
 * }
 */
export function createGeoJSONVT(
    data: Record<string, unknown>,
    options?: GeoJSONVTOptions,
): GeoJSONVT {
    const maxZoom = options?.maxZoom ?? DEFAULT_MAX_ZOOM;
    const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE;
    const extent = options?.extent ?? DEFAULT_EXTENT;
    const buffer = options?.buffer ?? DEFAULT_BUFFER;

    // 将 GeoJSON 转为内部要素
    const allFeatures = convertGeoJSON(data);

    // 瓦片缓存：'z/x/y' → TileCacheEntry
    const cache = new Map<string, TileCacheEntry>();

    /**
     * 生成瓦片缓存键。
     *
     * @param z - 缩放
     * @param x - 列
     * @param y - 行
     * @returns 缓存键
     */
    function tileKey(z: number, x: number, y: number): string {
        return `${z}/${x}/${y}`;
    }

    /**
     * 为指定瓦片生成切片数据。
     *
     * @param z - 缩放
     * @param x - 列
     * @param y - 行
     * @returns TileCacheEntry
     */
    function generateTile(z: number, x: number, y: number): TileCacheEntry {
        const key = tileKey(z, x, y);
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        // 裁剪所有要素到此瓦片
        const clipped = clipFeatures(allFeatures, z, x, y, buffer);

        // 简化
        const toleranceSq = tolerance * tolerance;
        const simplifiedFeatures: InternalFeature[] = [];

        for (const feat of clipped) {
            if (feat.type === 3 && feat.area < MIN_AREA_THRESHOLD) {
                // 跳过微小多边形
                continue;
            }

            const simplifiedGeom: number[][][] = [];
            for (const ring of feat.geometry) {
                if (feat.type === 1) {
                    // 点不简化
                    simplifiedGeom.push(ring);
                } else {
                    const simplified = simplifyRing(ring, toleranceSq);
                    if (simplified.length >= (feat.type === 3 ? 3 : 2)) {
                        simplifiedGeom.push(simplified);
                    }
                }
            }

            if (simplifiedGeom.length > 0) {
                simplifiedFeatures.push({
                    index: feat.index,
                    type: feat.type,
                    geometry: simplifiedGeom,
                    bbox: computeBBox(simplifiedGeom),
                    properties: feat.properties,
                    id: feat.id,
                    area: feat.area,
                });
            }
        }

        const entry: TileCacheEntry = {
            features: simplifiedFeatures,
            simplified: true,
        };
        cache.set(key, entry);

        return entry;
    }

    return {
        /**
         * 获取瓦片切片数据。
         *
         * @param z - 缩放级别
         * @param x - 列号
         * @param y - 行号
         * @returns 瓦片数据或 null
         */
        getTile(z: number, x: number, y: number): VTTile | null {
            // 参数校验
            if (!Number.isInteger(z) || z < 0 || z > maxZoom) {
                return null;
            }
            const maxTile = 1 << z;
            if (!Number.isInteger(x) || x < 0 || x >= maxTile) {
                return null;
            }
            if (!Number.isInteger(y) || y < 0 || y >= maxTile) {
                return null;
            }

            const entry = generateTile(z, x, y);
            if (entry.features.length === 0) {
                return null;
            }

            // 将内部坐标 [0,1] 转换为瓦片坐标 [0, extent]
            const scale = 1 << z;
            const slicedFeatures: SlicedFeature[] = [];
            let totalPoints = 0;

            for (const feat of entry.features) {
                const outGeom: number[][][] = [];

                for (const ring of feat.geometry) {
                    const outRing: number[][] = [];
                    for (const pt of ring) {
                        // 瓦片坐标 = (全球坐标 - 瓦片偏移) × scale × extent
                        const tileX = Math.round((pt[0] * scale - x) * extent);
                        const tileY = Math.round((pt[1] * scale - y) * extent);
                        outRing.push([tileX, tileY]);
                        totalPoints++;
                    }
                    outGeom.push(outRing);
                }

                slicedFeatures.push({
                    index: feat.index,
                    type: feat.type,
                    geometry: outGeom,
                    properties: feat.properties,
                    id: feat.id,
                });
            }

            return {
                features: slicedFeatures,
                numFeatures: slicedFeatures.length,
                numPoints: totalPoints,
            };
        },

        /**
         * 获取已缓存瓦片数。
         *
         * @returns 缓存大小
         */
        getCachedTileCount(): number {
            return cache.size;
        },
    };
}
