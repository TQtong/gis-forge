/**
 * @module core/geo/tiling-scheme
 * @description
 * **TilingScheme 最小抽象** —— 定义地理坐标 ↔ 瓦片网格坐标的双向映射。
 *
 * 本文件包含：
 * 1. `TilingScheme` 接口（6 个核心映射 + 3 个只读属性）
 * 2. `TileCoord` / `GlobeTileID` 值类型
 * 3. `TileBounds` 值类型
 * 4. 自由函数（tileBoundsInto / tileBounds / tileKey / decodeTileKey / touchesPole / forEachOverlappingTile / tileCenterInto）
 * 5. 方案注册表（registerTilingScheme / getTilingSchemeById）
 *
 * 设计原则：
 * - 最小化：接口仅含不可推导的 6 个映射 + 3 个属性
 * - 无状态：所有方法仅依赖入参，无内部可变状态
 * - 高性能：所有方法 O(1)，自由函数热路径零分配
 * - L0 层零外部依赖：不 import L1~L6 中任何符号
 *
 * @stability stable — Phase 1 交付后接口锁定，仅通过新增自由函数扩展
 */

// ════════════════════════════════════════════════════════════════
// §1 TilingScheme 接口
// ════════════════════════════════════════════════════════════════

/**
 * 瓦片方案的最小抽象——定义地理坐标 ↔ 瓦片网格坐标的双向映射。
 *
 * 标准实现：
 * - {@link WebMercator}：EPSG:3857，zoom=0 → 1×1 瓦片，纬度限制 ±85.051°
 * - {@link Geographic}：EPSG:4326，zoom=0 → 2×1 瓦片，覆盖全球 ±90°
 *
 * @stability stable
 *
 * @example
 * import { WebMercator } from './web-mercator-tiling-scheme';
 * const x = Math.floor(WebMercator.lngX(121.47, 10)); // 瓦片列号
 * const y = Math.floor(WebMercator.latY(31.23, 10));   // 瓦片行号
 */
export interface TilingScheme {
    // ━━━ 标识属性 ━━━

    /**
     * 数值唯一标识。用于 {@link tileKey} 的高位编码和 `Map<number, ...>` 缓存键。
     *
     * 取值约定：
     * - `0` = WebMercator (EPSG:3857)
     * - `1` = Geographic (EPSG:4326)
     * - `2~7` = 预留给未来内置方案
     * - `8~31` = 用户自定义方案
     *
     * tileKey 编码分配 5 bit → 最多 32 个并发方案。
     */
    readonly id: number;

    /**
     * 人类可读名称。仅用于调试日志和开发者工具面板，不参与任何比较或键计算。
     *
     * @example 'WebMercator', 'Geographic', 'WMTS:EPSG:2154'
     */
    readonly name: string;

    /**
     * 该方案覆盖的纬度有效范围（度），闭区间 [min, max]。
     * - WebMercator: [-85.05112878, 85.05112878]
     * - Geographic:  [-90, 90]
     *
     * 约束：latRange[0] < latRange[1]
     *
     * 用途：coveringTilesGlobe 裁剪无效纬度 / UI 限制相机平移范围 / 单元测试断言
     */
    readonly latRange: readonly [number, number];

    // ━━━ 网格维度 ━━━

    /**
     * 指定 zoom 下 X 方向（经度）的瓦片总列数。
     * - WebMercator: `2^z`（zoom=0 → 1 列）
     * - Geographic:  `2^(z+1)`（zoom=0 → 2 列）
     *
     * @param z - 整数 zoom 级别，范围 [0, 24]
     * @returns 正整数列数，>= 1
     * @complexity O(1)，位移运算
     *
     * @example
     * WebMercator.numX(0) // 1
     * Geographic.numX(0)  // 2
     */
    numX(z: number): number;

    /**
     * 指定 zoom 下 Y 方向（纬度）的瓦片总行数。
     * - WebMercator: `2^z`（zoom=0 → 1 行）
     * - Geographic:  `2^z`（zoom=0 → 1 行）
     *
     * @param z - 整数 zoom 级别，范围 [0, 24]
     * @returns 正整数行数，>= 1
     * @complexity O(1)
     */
    numY(z: number): number;

    // ━━━ 地理坐标 → 瓦片坐标（正向映射）━━━

    /**
     * 经度（度）→ 连续瓦片列号。调用方 `Math.floor()` 取整得到离散列号。
     *
     * @param lngDeg - 经度，范围 [-180, 180]。超出范围的值会被合法映射（环绕）
     * @param z - 整数 zoom 级别
     * @returns 浮点列号，范围 [0, numX(z))
     * @complexity O(1)，一次乘法 + 一次加法
     *
     * @example
     * Math.floor(WebMercator.lngX(0, 2))   // 2（本初子午线在 zoom=2 的第 2 列）
     * Math.floor(Geographic.lngX(0, 2))    // 4（Geographic 在 zoom=2 有 8 列）
     */
    lngX(lngDeg: number, z: number): number;

    /**
     * 纬度（度）→ 连续瓦片行号。调用方 `Math.floor()` 取整得到离散行号。
     *
     * 映射方式因方案不同：
     * - WebMercator：Mercator 投影公式（非线性，极地压缩）
     * - Geographic：线性映射 `((90 - φ) / 180) × numY`
     *
     * 约定：行号 0 = 最北，行号 numY-1 = 最南。
     *
     * @param latDeg - 纬度，范围 [latRange[0], latRange[1]]
     * @param z - 整数 zoom 级别
     * @returns 浮点行号，范围 [0, numY(z))
     * @complexity O(1)
     */
    latY(latDeg: number, z: number): number;

    // ━━━ 瓦片坐标 → 地理坐标（逆向映射）━━━

    /**
     * 瓦片列号 → 该列西边界经度（度）。
     * 对于列号 x 的瓦片，其经度范围为 [xLng(x, z), xLng(x+1, z)]。
     *
     * @param x - 整数或浮点列号
     * @param z - 整数 zoom 级别
     * @returns 经度（度），范围 [-180, 180]
     * @complexity O(1)
     *
     * @example
     * WebMercator.xLng(0, 1)  // -180（zoom=1 第 0 列西边界）
     * WebMercator.xLng(1, 1)  // 0（第 1 列西边界 = 第 0 列东边界）
     */
    xLng(x: number, z: number): number;

    /**
     * 瓦片行号 → 该行北边界纬度（度）。
     * 对于行号 y 的瓦片，其纬度范围为 [yLat(y+1, z), yLat(y, z)]。
     * 注意：yLat(y, z) > yLat(y+1, z)，因为行号向南递增。
     *
     * @param y - 整数或浮点行号
     * @param z - 整数 zoom 级别
     * @returns 纬度（度），范围 [latRange[0], latRange[1]]
     * @complexity O(1)
     */
    yLat(y: number, z: number): number;
}

// ════════════════════════════════════════════════════════════════
// §2 值类型
// ════════════════════════════════════════════════════════════════

/**
 * 瓦片坐标三元组——轻量值类型，用于函数参数和返回值。
 * 与 {@link GlobeTileID} 不同：TileCoord 不含 distToCamera 等渲染状态。
 *
 * @stability stable
 */
export interface TileCoord {
    /** zoom 级别 */
    readonly z: number;
    /** 列号 */
    readonly x: number;
    /** 行号 */
    readonly y: number;
}

/**
 * 瓦片坐标 + 方案 ID + 缓存键——渲染调度用的完整标识。
 * 是 {@link coveringTilesGlobe} 的输出元素类型。
 *
 * @stability stable
 */
export interface GlobeTileID extends TileCoord {
    /** 数值缓存键，由 {@link tileKey} 生成 */
    readonly key: number;
    /** 瓦片中心到相机注视点的大圆距离（米），用于排序 */
    readonly distToCamera: number;
    /** 方案 ID，轻量引用而非完整 TilingScheme 对象 */
    readonly schemeId: number;
}

/**
 * 瓦片 (z, x, y) 的地理边界。分配新对象，用于非热路径。
 *
 * @stability stable
 */
export interface TileBounds {
    /** 西经边界（度） */
    readonly west: number;
    /** 南纬边界（度） */
    readonly south: number;
    /** 东经边界（度） */
    readonly east: number;
    /** 北纬边界（度） */
    readonly north: number;
}

// ════════════════════════════════════════════════════════════════
// §3 自由函数——零分配热路径
// ════════════════════════════════════════════════════════════════

/** 模块级预分配边界缓冲。格式：[west, south, east, north]。非线程安全。 */
const _boundsBuf = new Float64Array(4);

/**
 * 将瓦片 (z, x, y) 的地理边界写入预分配 Float64Array(4)。
 * 零 GC 分配，用于帧循环热路径。
 *
 * 输出格式：
 *   out[0] = west  （西经边界，度）
 *   out[1] = south （南纬边界，度）
 *   out[2] = east  （东经边界，度）
 *   out[3] = north （北纬边界，度）
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param x - 列号，范围 [0, s.numX(z))
 * @param y - 行号，范围 [0, s.numY(z))
 * @param out - 可选输出缓冲。省略时使用模块级 _boundsBuf（非线程安全）
 * @returns out 引用
 *
 * @complexity O(1) — 4 次 xLng/yLat 调用
 *
 * @warning 非线程安全。默认缓冲在下次调用时被覆盖。
 *   若需在回调或异步中保持值，传入独立的 Float64Array(4)。
 *
 * @example
 * const bounds = tileBoundsInto(WebMercator, 2, 1, 1);
 * console.log(bounds[3]); // north latitude
 *
 * @example
 * // 在循环中使用独立缓冲
 * const myBuf = new Float64Array(4);
 * for (const tile of tiles) {
 *   tileBoundsInto(scheme, tile.z, tile.x, tile.y, myBuf);
 * }
 *
 * @stability stable
 */
export function tileBoundsInto(
    s: TilingScheme, z: number, x: number, y: number,
    out?: Float64Array,
): Float64Array {
    const buf = out ?? _boundsBuf;
    // west = 列 x 的西边界经度
    buf[0] = s.xLng(x, z);
    // south = 行 y+1 的北边界纬度（即行 y 的南边界）
    buf[1] = s.yLat(y + 1, z);
    // east = 列 x+1 的西边界经度（即列 x 的东边界）
    buf[2] = s.xLng(x + 1, z);
    // north = 行 y 的北边界纬度
    buf[3] = s.yLat(y, z);
    return buf;
}

/**
 * 返回瓦片边界对象。每次调用分配一个新 {@link TileBounds}。
 * 用于初始化、配置、测试等非帧循环路径。
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param x - 列号
 * @param y - 行号
 * @returns 不可变 TileBounds 对象
 *
 * @example
 * const b = tileBounds(Geographic, 0, 0, 0);
 * // b = { west: -180, south: 0, east: 0, north: 90 }（西半球北半部）
 *
 * @stability stable
 */
export function tileBounds(s: TilingScheme, z: number, x: number, y: number): TileBounds {
    return {
        west: s.xLng(x, z),
        south: s.yLat(y + 1, z),
        east: s.xLng(x + 1, z),
        north: s.yLat(y, z),
    };
}

// ════════════════════════════════════════════════════════════════
// §4 tileKey 编码/解码
// ════════════════════════════════════════════════════════════════

/**
 * 将 (schemeId, z, x, y) 编码为单个 JS 安全整数，用作 Map 键。
 *
 * 位布局（共 46 bit，JS 安全整数最大 53 bit）：
 *   bit 45-41: schemeId (5 bit → 最多 32 个方案)
 *   bit 40-36: z        (5 bit → 最大 zoom 31)
 *   bit 35-18: x       (18 bit → 最大 262143 列 → zoom 17+)
 *   bit 17-0:  y       (18 bit → 最大 262143 行)
 *
 * 对于 zoom > 17 的高精度瓦片（x/y > 2^18），回退到 {@link tileKeyStr}。
 * 实际应用中 zoom 17 = ~1.2m/pixel，足够绝大多数场景。
 *
 * @param schemeId - 方案 ID [0, 31]
 * @param z - zoom [0, 31]
 * @param x - 列号 [0, 2^18 - 1]
 * @param y - 行号 [0, 2^18 - 1]
 * @returns 非负整数键
 * @complexity O(1)
 *
 * @example
 * tileKey(0, 5, 16, 11) // 唯一数值
 * tileKey(1, 5, 33, 11) // 不同的数值（不同 scheme）
 *
 * @stability stable
 */
export function tileKey(schemeId: number, z: number, x: number, y: number): number {
    // 使用乘法而非位移（JS 位运算截断到 32 bit）
    return ((schemeId & 0x1F) * 0x10000000000)  // bits 45-41
         + ((z & 0x1F)       * 0x400000000)     // bits 40-36
         + ((x & 0x3FFFF)    * 0x40000)         // bits 35-18
         + (y & 0x3FFFF);                       // bits 17-0
}

/**
 * 逆解码 {@link tileKey}，用于调试和日志。
 *
 * @param key - 由 tileKey 生成的数值键
 * @returns 解构后的 { schemeId, z, x, y }
 *
 * @example
 * const k = tileKey(0, 5, 16, 11);
 * decodeTileKey(k) // { schemeId: 0, z: 5, x: 16, y: 11 }
 *
 * @stability stable
 */
export function decodeTileKey(key: number): {
    schemeId: number; z: number; x: number; y: number;
} {
    const y = key & 0x3FFFF;
    const x = Math.floor(key / 0x40000) & 0x3FFFF;
    const z = Math.floor(key / 0x400000000) & 0x1F;
    const schemeId = Math.floor(key / 0x10000000000) & 0x1F;
    return { schemeId, z, x, y };
}

/**
 * 对于 zoom > 17 或 x/y > 262143 的瓦片，使用字符串键回退。
 * 生产中极少触发（zoom 17 = 1.2m/pixel 精度）。
 *
 * @param schemeId - 方案 ID
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号
 * @returns 格式 "schemeId:z/x/y" 的字符串键
 *
 * @stability stable
 */
export function tileKeyStr(schemeId: number, z: number, x: number, y: number): string {
    return `${schemeId}:${z}/${x}/${y}`;
}

/**
 * 统一键获取：优先数值键，zoom > 17 时回退字符串。
 * 推荐：缓存使用两个 Map（numericCache + stringFallbackCache）而非 unknown 键。
 *
 * @param schemeId - 方案 ID
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号
 * @returns 数值键或字符串键
 *
 * @stability stable
 */
export function tileKeyAuto(schemeId: number, z: number, x: number, y: number): number | string {
    // 18 bit 上限：262143 = 0x3FFFF
    if (z <= 17 && x < 0x40000 && y < 0x40000) {
        return tileKey(schemeId, z, x, y);
    }
    return tileKeyStr(schemeId, z, x, y);
}

// ════════════════════════════════════════════════════════════════
// §5 极地判定 + 瓦片重叠遍历 + 瓦片中心
// ════════════════════════════════════════════════════════════════

/**
 * 判断瓦片是否触及极点（纬度达到 ±89.99°）。
 * 由瓦片实际纬度值判断，而非硬编码行号。
 * 对 WebMercator 和 Geographic 都正确。
 *
 * WebMercator zoom=0 的唯一瓦片 latMax ≈ 85.05° → 不触及极点。
 * Geographic zoom=0 的唯一行 latMax = 90° → 触及北极。
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param y - 行号
 * @returns 'north' | 'south' | null
 *
 * @example
 * touchesPole(Geographic, 0, 0)  // 'north'（zoom=0 row=0 → lat 90°）
 * touchesPole(WebMercator, 0, 0) // null（lat ≈ 85°，不算极点）
 *
 * @stability stable
 */
export function touchesPole(
    s: TilingScheme, z: number, y: number,
): 'north' | 'south' | null {
    // 行 y 的北边界纬度
    const north = s.yLat(y, z);
    // 行 y 的南边界纬度
    const south = s.yLat(y + 1, z);
    // 阈值 89.99° 避免浮点误差导致 85° 被误判为极点
    if (north >= 89.99) return 'north';
    if (south <= -89.99) return 'south';
    return null;
}

/**
 * 遍历与指定地理边界重叠的所有瓦片，零分配。
 * 使用回调模式替代返回数组，避免 GC 压力。
 *
 * 用途：地形瓦片渲染时，推导其覆盖的影像瓦片。
 *
 * @param bounds - 地理边界 Float64Array(4)，格式 [west, south, east, north]（度）
 * @param targetScheme - 目标方案（影像方案）
 * @param targetZoom - 目标 zoom 级别
 * @param callback - 每找到一个重叠瓦片调用一次。参数 (z, x, y)。
 *   回调中不应修改 bounds。
 *
 * @complexity O(M) 其中 M = 重叠瓦片数。通常 M ∈ [1, 4]。
 *
 * @example
 * // 查找覆盖某地形瓦片的所有 WebMercator 影像瓦片
 * const terrBounds = tileBoundsInto(Geographic, 5, 10, 3);
 * forEachOverlappingTile(terrBounds, WebMercator, 5, (z, x, y) => {
 *   loadImageryTile(z, x, y);
 * });
 *
 * @stability stable
 */
export function forEachOverlappingTile(
    bounds: Float64Array,
    targetScheme: TilingScheme,
    targetZoom: number,
    callback: (z: number, x: number, y: number) => void,
): void {
    const west = bounds[0], south = bounds[1], east = bounds[2], north = bounds[3];
    const numX = targetScheme.numX(targetZoom);
    const numY = targetScheme.numY(targetZoom);

    // clamp 到有效纬度范围（WebMercator 不覆盖极地）
    const clampedNorth = Math.min(north, targetScheme.latRange[1]);
    const clampedSouth = Math.max(south, targetScheme.latRange[0]);

    // 无重叠（地形瓦片完全在极地，影像 scheme 不覆盖）
    if (clampedNorth <= clampedSouth) return;

    // 列范围：east - 1e-10 防止浮点精度导致越界到下一列
    const minX = Math.max(0, Math.floor(targetScheme.lngX(west, targetZoom)));
    const maxX = Math.min(numX - 1, Math.floor(targetScheme.lngX(east - 1e-10, targetZoom)));
    // 行范围：较大纬度 → 较小行号
    const minY = Math.max(0, Math.floor(targetScheme.latY(clampedNorth, targetZoom)));
    const maxY = Math.min(numY - 1, Math.floor(targetScheme.latY(clampedSouth, targetZoom)));

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            callback(targetZoom, x, y);
        }
    }
}

/** 模块级预分配中心缓冲。格式：[lngDeg, latDeg]。非线程安全。 */
const _centerBuf = new Float64Array(2);

/**
 * 计算瓦片中心经纬度（度），写入预分配 Float64Array(2)。
 * 用于 horizon cull 和距离排序。
 *
 * @param s - TilingScheme
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号
 * @param out - Float64Array(2)，格式 [lngDeg, latDeg]。省略时使用模块级缓冲。
 * @returns out 引用
 *
 * @example
 * const c = tileCenterInto(WebMercator, 5, 16, 11);
 * console.log(c[0], c[1]); // lng, lat
 *
 * @stability stable
 */
export function tileCenterInto(
    s: TilingScheme, z: number, x: number, y: number,
    out?: Float64Array,
): Float64Array {
    const buf = out ?? _centerBuf;
    // 列中心 = x + 0.5 的经度
    buf[0] = s.xLng(x + 0.5, z);
    // 行中心 = y + 0.5 的纬度
    buf[1] = s.yLat(y + 0.5, z);
    return buf;
}

// ════════════════════════════════════════════════════════════════
// §6 方案注册表
// ════════════════════════════════════════════════════════════════

/**
 * 全局方案注册表——通过 id 查找 TilingScheme 实例。
 * 内置方案在模块加载时自动注册。
 * 用户自定义方案通过 {@link registerTilingScheme} 添加。
 *
 * 用途：
 * 1. GlobeTileID.schemeId → 完整 TilingScheme 查表
 * 2. 序列化/反序列化场景状态
 * 3. 开发者工具枚举所有可用方案
 */
const _schemeRegistry = new Map<number, TilingScheme>();

/**
 * 注册自定义 TilingScheme。
 * id 必须在 [8, 31] 范围内（0~7 为内置保留）。
 *
 * @param scheme - 要注册的方案实例
 * @throws {Error} 若 id 超出 [8, 31] 范围
 * @throws {Error} 若 id 已被其他方案注册
 *
 * @example
 * const LambertFrance: TilingScheme = { id: 8, name: 'Lambert93', ... };
 * registerTilingScheme(LambertFrance);
 *
 * @stability stable
 */
export function registerTilingScheme(scheme: TilingScheme): void {
    if (scheme.id < 8 || scheme.id > 31) {
        throw new Error(`Custom TilingScheme id must be in [8, 31], got ${scheme.id}`);
    }
    if (_schemeRegistry.has(scheme.id)) {
        throw new Error(
            `TilingScheme id ${scheme.id} already registered as "${_schemeRegistry.get(scheme.id)!.name}"`,
        );
    }
    _schemeRegistry.set(scheme.id, Object.freeze(scheme));
}

/**
 * 通过数值 id 查找已注册的 TilingScheme。
 *
 * @param id - 方案 id
 * @returns 方案实例，未找到时返回 undefined
 *
 * @stability stable
 */
export function getTilingSchemeById(id: number): TilingScheme | undefined {
    return _schemeRegistry.get(id);
}

/**
 * 内置方案自动注册入口。由 WebMercator / Geographic 模块在加载时调用。
 * 内置方案 id ∈ [0, 7]，不受 registerTilingScheme 的 [8, 31] 约束。
 *
 * @param schemes - 要注册的内置方案列表
 *
 * @stability internal
 */
export function _registerBuiltins(...schemes: TilingScheme[]): void {
    for (const s of schemes) {
        _schemeRegistry.set(s.id, s);
    }
}
