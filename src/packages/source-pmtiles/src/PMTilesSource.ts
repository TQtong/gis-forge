// ============================================================
// source-pmtiles/PMTilesSource.ts — PMTiles 单文件瓦片数据源
// 职责：通过 HTTP Range Request 从 PMTiles v3 归档中按需读取瓦片，
//       实现 Hilbert 曲线瓦片 ID 计算、v3 头部解析、目录二分查找、
//       叶目录递归查找和目录缓存管理。
// 层级：L4 数据源（非图层，不参与渲染管线）
// 零 npm 依赖，所有功能自研。
// ============================================================

declare const __DEV__: boolean;

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../core/src/infra/errors.ts';

// ======================== 常量 ========================

/**
 * PMTiles v3 文件头部固定字节大小。
 * 前 2 字节为魔数 "PM"，后续字段按小端序紧凑排列。
 * 来源：PMTiles 规范 v3 §2.1。
 *
 * @stability stable
 */
const PMTILES_HEADER_SIZE = 127;

/**
 * PMTiles 魔数字节序列 [0x50, 0x4D] = ASCII "PM"。
 * 用于验证文件是否为合法 PMTiles 归档。
 *
 * @stability stable
 */
const PMTILES_MAGIC: readonly number[] = [0x50, 0x4D];

/**
 * 当前支持的 PMTiles 版本号。
 * GIS-Forge 仅支持 v3 格式（2022+ 标准）。
 *
 * @stability stable
 */
const PMTILES_VERSION = 3;

/**
 * 默认目录缓存条目数上限。
 * 缓存根目录和最近访问的叶目录，减少 Range Request 次数。
 * 512 在内存占用和命中率之间取得平衡。
 *
 * @stability stable
 */
const DEFAULT_DIRECTORY_CACHE = 512;

/**
 * 叶目录最大递归深度。
 * 防止畸形文件导致无限递归。PMTiles v3 规范中叶目录嵌套通常不超过 3 层。
 *
 * @stability stable
 */
const MAX_LEAF_DEPTH = 4;

/**
 * Range Request 超时时间（毫秒）。
 * 头部解析和目录加载使用此超时。
 *
 * @stability stable
 */
const RANGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 最大缩放级别上限。
 *
 * @stability stable
 */
const MAX_ZOOM = 22;

/**
 * 默认瓦片过期时间增量（毫秒），24 小时。
 *
 * @stability stable
 */
const DEFAULT_TILE_EXPIRATION_MS = 86_400_000;

// ======================== PMTiles 枚举 ========================

/**
 * PMTiles 瓦片类型枚举。
 * 对应 v3 头部 tileType 字段的数值。
 *
 * @stability stable
 */
export const PMTilesTileType = {
    /** 未知类型 */
    UNKNOWN: 0,
    /** Mapbox Vector Tile (MVT / PBF) */
    MVT: 1,
    /** PNG 栅格 */
    PNG: 2,
    /** JPEG 栅格 */
    JPEG: 3,
    /** WebP 栅格 */
    WEBP: 4,
    /** AVIF 栅格 */
    AVIF: 5,
} as const;

/** PMTiles 瓦片类型值的联合类型 */
export type PMTilesTileTypeValue = (typeof PMTilesTileType)[keyof typeof PMTilesTileType];

/**
 * PMTiles 压缩类型枚举。
 * 对应 v3 头部 internalCompression / tileCompression 字段的数值。
 *
 * @stability stable
 */
export const PMTilesCompression = {
    /** 无压缩 */
    NONE: 0,
    /** Gzip 压缩 */
    GZIP: 1,
    /** Brotli 压缩 */
    BROTLI: 2,
    /** Zstd 压缩 */
    ZSTD: 3,
} as const;

/** PMTiles 压缩类型值的联合类型 */
export type PMTilesCompressionValue = (typeof PMTilesCompression)[keyof typeof PMTilesCompression];

// ======================== 类型定义 ========================

/**
 * 用户可指定的瓦片类型字符串（友好名称）。
 *
 * @stability stable
 */
export type PMTilesUserTileType = 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'pbf';

/**
 * PMTiles 数据源配置选项。
 *
 * @example
 * const options: PMTilesSourceOptions = {
 *   url: 'https://example.com/data.pmtiles',
 *   tileType: 'mvt',
 *   directoryCacheSize: 512,
 * };
 *
 * @stability stable
 */
export interface PMTilesSourceOptions {
    /**
     * PMTiles 文件 URL。
     * 服务器必须支持 HTTP Range Request（Accept-Ranges: bytes）。
     * 必填项，不得为空。
     */
    readonly url: string;

    /**
     * 瓦片数据类型（友好名称）。
     * 可选，若不指定则从 PMTiles 头部自动检测。
     * 'pbf' 等价于 'mvt'。
     */
    readonly tileType?: PMTilesUserTileType;

    /**
     * 自定义 HTTP 请求头。
     * 用于鉴权或 CDN token。
     */
    readonly headers?: Record<string, string>;

    /**
     * 目录缓存条目数上限。
     * 默认值：`512`。
     */
    readonly directoryCacheSize?: number;
}

/**
 * PMTiles v3 文件头部解析结果。
 * 包含归档的完整元信息。
 *
 * @stability stable
 */
export interface PMTilesHeader {
    /** PMTiles 格式版本号（当前仅支持 3） */
    readonly version: number;

    /** 根目录在文件中的字节偏移 */
    readonly rootDirectoryOffset: number;

    /** 根目录字节长度 */
    readonly rootDirectoryLength: number;

    /** JSON 元数据在文件中的字节偏移 */
    readonly jsonMetadataOffset: number;

    /** JSON 元数据字节长度 */
    readonly jsonMetadataLength: number;

    /** 叶目录区域在文件中的字节偏移 */
    readonly leafDirectoryOffset: number;

    /** 叶目录区域字节长度 */
    readonly leafDirectoryLength: number;

    /** 瓦片数据区域在文件中的字节偏移 */
    readonly tileDataOffset: number;

    /** 瓦片数据区域字节长度 */
    readonly tileDataLength: number;

    /** 归档中包含的瓦片总数 */
    readonly numTiles: number;

    /**
     * 瓦片是否按 Hilbert 曲线顺序聚簇存储。
     * true 时可利用连续 Range Request 预取相邻瓦片。
     */
    readonly clustered: boolean;

    /** 目录内部压缩方式 */
    readonly internalCompression: PMTilesCompressionValue;

    /** 瓦片数据压缩方式 */
    readonly tileCompression: PMTilesCompressionValue;

    /** 瓦片数据类型 */
    readonly tileType: PMTilesTileTypeValue;

    /** 最小可用缩放级别 */
    readonly minZoom: number;

    /** 最大可用缩放级别 */
    readonly maxZoom: number;

    /**
     * 数据地理范围（WGS-84 经纬度）。
     * 由头部 minLon/minLat/maxLon/maxLat 字段构成。
     */
    readonly bounds: BBox2D;

    /**
     * 数据中心点 [经度, 纬度, 缩放级别]。
     * 推荐的初始视口位置。
     */
    readonly center: readonly [number, number, number];
}

/**
 * 目录条目（Directory Entry）。
 * PMTiles v3 目录由一组 Entry 紧凑排列组成。
 *
 * @stability stable
 */
export interface PMTilesDirectoryEntry {
    /** 瓦片 ID（Hilbert 曲线编号） */
    readonly tileId: number;

    /** 瓦片数据在文件中的字节偏移（相对于 tileDataOffset） */
    readonly offset: number;

    /** 瓦片数据字节长度 */
    readonly length: number;

    /**
     * 连续瓦片 run-length（运行长度）。
     * 0 表示此条目指向叶目录（而非瓦片数据）。
     * ≥1 表示从 tileId 开始连续 runLength 个瓦片共享相同数据。
     */
    readonly runLength: number;
}

/**
 * 瓦片加载参数。
 *
 * @stability stable
 */
export interface PMTilesTileLoadParams {
    /** 瓦片坐标 */
    readonly coord: TileCoord;

    /** 请求取消信号 */
    readonly signal?: AbortSignal;
}

/**
 * 瓦片加载结果。
 *
 * @stability stable
 */
export interface PMTilesTileLoadResult {
    /** 瓦片二进制数据（可能已压缩，取决于 tileCompression） */
    readonly data: ArrayBuffer;

    /** 瓦片坐标 */
    readonly coord: TileCoord;

    /** 缓存过期时间戳（Unix 毫秒） */
    readonly expiresAt?: number;

    /** 瓦片字节大小 */
    readonly byteSize: number;
}

/**
 * PMTiles 数据源元数据。
 *
 * @stability stable
 */
export interface PMTilesSourceMetadata {
    /** 数据源类型标识 */
    readonly type: 'pmtiles';

    /** PMTiles 文件 URL */
    readonly url: string;

    /** 检测到的瓦片类型 */
    readonly tileType: PMTilesTileTypeValue;

    /** 最小缩放级别 */
    readonly minZoom: number;

    /** 最大缩放级别 */
    readonly maxZoom: number;

    /** 数据范围 */
    readonly bounds: BBox2D | null;

    /** 瓦片总数 */
    readonly numTiles: number;

    /** 是否已初始化 */
    readonly initialized: boolean;
}

// ======================== 内部工具函数 ========================

/**
 * 将用户友好的瓦片类型字符串转换为 PMTiles 数值类型。
 *
 * @param userType - 用户指定的瓦片类型字符串
 * @returns PMTiles 瓦片类型数值
 *
 * @example
 * userTileTypeToEnum('mvt'); // → 1
 * userTileTypeToEnum('png'); // → 2
 */
function userTileTypeToEnum(userType: PMTilesUserTileType): PMTilesTileTypeValue {
    switch (userType) {
        case 'mvt':
            return PMTilesTileType.MVT;
        case 'pbf':
            // PBF 是 MVT 的另一个常用名称（Protobuf 格式的矢量瓦片）
            return PMTilesTileType.MVT;
        case 'png':
            return PMTilesTileType.PNG;
        case 'jpg':
            return PMTilesTileType.JPEG;
        case 'webp':
            return PMTilesTileType.WEBP;
        case 'avif':
            return PMTilesTileType.AVIF;
        default:
            return PMTilesTileType.UNKNOWN;
    }
}

/**
 * 计算 2D Hilbert 曲线坐标 (x, y) 在 2^order 网格中的距离值 d。
 * 基于标准 Hilbert 曲线递归展开算法。
 *
 * Hilbert 曲线将 2D 空间映射到 1D，保持良好的空间局部性。
 * PMTiles 使用此映射将 (x, y, z) 瓦片坐标编码为紧凑的 tileId。
 *
 * @param x - 列坐标，范围 [0, 2^order - 1]
 * @param y - 行坐标，范围 [0, 2^order - 1]
 * @param order - Hilbert 曲线阶数（即 zoom 级别），范围 [0, 26]
 * @returns Hilbert 距离值 d，范围 [0, 4^order - 1]
 *
 * @example
 * hilbertXYToD(0, 0, 1); // → 0
 * hilbertXYToD(1, 0, 1); // → 1
 * hilbertXYToD(1, 1, 1); // → 2
 * hilbertXYToD(0, 1, 1); // → 3
 */
function hilbertXYToD(x: number, y: number, order: number): number {
    // order=0 退化为单个格子，距离始终为 0
    if (order <= 0) {
        return 0;
    }

    let rx: number;
    let ry: number;
    let d = 0;
    let tempX = x;
    let tempY = y;

    // 从最大象限级别向下迭代，每级处理 2 bit 贡献到 d
    for (let s = Math.pow(2, order - 1); s > 0; s = Math.floor(s / 2)) {
        // 判断当前层级的象限（rx, ry 各为 0 或 1）
        rx = (tempX & s) > 0 ? 1 : 0;
        ry = (tempY & s) > 0 ? 1 : 0;

        // 将当前象限贡献累加到 d（Hilbert 公式）
        d += s * s * ((3 * rx) ^ ry);

        // 对坐标进行象限内旋转变换，为下一层级做准备
        if (ry === 0) {
            if (rx === 1) {
                // 象限2：镜像翻转 x 和 y
                tempX = s - 1 - tempX;
                tempY = s - 1 - tempY;
            }
            // 象限0 或象限2（rx=1 翻转后）：交换 x 和 y
            const temp = tempX;
            tempX = tempY;
            tempY = temp;
        }
    }

    return d;
}

/**
 * 根据瓦片坐标 (x, y, z) 计算 PMTiles v3 的全局 tileId。
 *
 * 公式：tileId = Σ(4^i, i=0..z-1) + hilbert2d(x, y, z)
 * 其中前缀和是所有低于 z 级别的瓦片总数偏移。
 *
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param z - 缩放级别
 * @returns 全局 tileId
 *
 * @example
 * xyzToTileId(0, 0, 0); // → 0（zoom=0 只有 1 个瓦片，偏移为 0）
 * xyzToTileId(0, 0, 1); // → 1（zoom<1 共 1 个瓦片，+ hilbert(0,0,1)=0 → 1）
 */
function xyzToTileId(x: number, y: number, z: number): number {
    // z=0：全球唯一瓦片，tileId 固定为 0
    if (z === 0) {
        return 0;
    }

    // 计算前缀偏移：所有 zoom < z 的瓦片总数 = Σ(4^i, i=0..z-1) = (4^z - 1) / 3
    // 使用循环累加避免大数精度问题
    let prefixSum = 0;
    let power = 1;
    for (let i = 0; i < z; i++) {
        prefixSum += power;
        power *= 4;
    }

    // 在当前 zoom 级别内通过 Hilbert 曲线计算局部距离
    const hilbertD = hilbertXYToD(x, y, z);

    return prefixSum + hilbertD;
}

/**
 * 从 DataView 中读取小端序 64 位无符号整数。
 * JavaScript Number 最大安全整数为 2^53 - 1，足以覆盖 PMTiles 的偏移/长度字段。
 *
 * @param view - 数据视图
 * @param offset - 字节偏移
 * @returns 64 位无符号整数值
 *
 * @example
 * const buf = new ArrayBuffer(8);
 * new DataView(buf).setBigUint64(0, 42n, true);
 * readUint64LE(new DataView(buf), 0); // → 42
 */
function readUint64LE(view: DataView, offset: number): number {
    // 分两个 32 位部分读取（小端序），组合为 Number
    const lo = view.getUint32(offset, true);
    const hi = view.getUint32(offset + 4, true);

    // hi * 2^32 + lo（超过 Number.MAX_SAFE_INTEGER 时精度会丢失，
    // 但 PMTiles 文件大小通常远小于 9PB，不会触发此问题）
    return hi * 0x100000000 + lo;
}

/**
 * 解析 PMTiles v3 文件头部（127 字节）。
 *
 * 字段布局（小端序）：
 * - [0..1] 魔数 "PM" (0x50, 0x4D)
 * - [2] 版本号
 * - [3..10] rootDirectoryOffset (uint64)
 * - [11..18] rootDirectoryLength (uint64)
 * - [19..26] jsonMetadataOffset (uint64)
 * - [27..34] jsonMetadataLength (uint64)
 * - [35..42] leafDirectoryOffset (uint64)
 * - [43..50] leafDirectoryLength (uint64)
 * - [51..58] tileDataOffset (uint64)
 * - [59..66] tileDataLength (uint64)
 * - [67..74] numAddressedTiles (uint64)
 * - [75..82] numTileEntries (uint64)
 * - [83..90] numTileContents (uint64)
 * - [91] clustered (bool)
 * - [92] internalCompression
 * - [93] tileCompression
 * - [94] tileType
 * - [95] minZoom
 * - [96] maxZoom
 * - [97..100] minLon (int32, ×10^7)
 * - [101..104] minLat (int32, ×10^7)
 * - [105..108] maxLon (int32, ×10^7)
 * - [109..112] maxLat (int32, ×10^7)
 * - [113..116] centerLon (int32, ×10^7)
 * - [117..120] centerLat (int32, ×10^7)
 * - [121] centerZoom
 * - [122..126] 保留字节
 *
 * @param buffer - 至少 127 字节的 ArrayBuffer
 * @returns 解析后的头部对象
 * @throws {GeoForgeError} 当魔数不匹配或版本不支持时
 *
 * @example
 * const header = parseHeader(await fetchRange(url, 0, 127));
 */
function parseHeader(buffer: ArrayBuffer): PMTilesHeader {
    // 验证缓冲区大小
    if (buffer.byteLength < PMTILES_HEADER_SIZE) {
        throw new GeoForgeError(
            GeoForgeErrorCode.TILE_DECODE_FAILED,
            `PMTilesSource: 头部数据不足，需要 ${PMTILES_HEADER_SIZE} 字节，实际 ${buffer.byteLength}`,
            { actualSize: buffer.byteLength, requiredSize: PMTILES_HEADER_SIZE },
        );
    }

    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // 验证魔数 "PM"
    if (bytes[0] !== PMTILES_MAGIC[0] || bytes[1] !== PMTILES_MAGIC[1]) {
        throw new GeoForgeError(
            GeoForgeErrorCode.TILE_DECODE_FAILED,
            `PMTilesSource: 无效的魔数 [0x${bytes[0].toString(16)}, 0x${bytes[1].toString(16)}]，期望 [0x50, 0x4D]`,
            { magic: [bytes[0], bytes[1]] },
        );
    }

    // 读取版本号
    const version = bytes[2];
    if (version !== PMTILES_VERSION) {
        throw new GeoForgeError(
            GeoForgeErrorCode.TILE_DECODE_FAILED,
            `PMTilesSource: 不支持的版本 ${version}，仅支持 v${PMTILES_VERSION}`,
            { version, supportedVersion: PMTILES_VERSION },
        );
    }

    // 读取目录和数据区域偏移/长度（各 uint64 小端序）
    const rootDirectoryOffset = readUint64LE(view, 3);
    const rootDirectoryLength = readUint64LE(view, 11);
    const jsonMetadataOffset = readUint64LE(view, 19);
    const jsonMetadataLength = readUint64LE(view, 27);
    const leafDirectoryOffset = readUint64LE(view, 35);
    const leafDirectoryLength = readUint64LE(view, 43);
    const tileDataOffset = readUint64LE(view, 51);
    const tileDataLength = readUint64LE(view, 59);

    // numAddressedTiles 在偏移 67，numTileEntries 在 75，numTileContents 在 83
    const numTiles = readUint64LE(view, 67);

    // 布尔/枚举字段
    const clustered = bytes[91] === 1;
    const internalCompression = bytes[92] as PMTilesCompressionValue;
    const tileCompression = bytes[93] as PMTilesCompressionValue;
    const tileType = bytes[94] as PMTilesTileTypeValue;
    const minZoom = bytes[95];
    const maxZoom = bytes[96];

    // 地理范围（int32 × 10^-7 → 度）
    const coordScale = 1e-7;
    const minLon = view.getInt32(97, true) * coordScale;
    const minLat = view.getInt32(101, true) * coordScale;
    const maxLon = view.getInt32(105, true) * coordScale;
    const maxLat = view.getInt32(109, true) * coordScale;

    // 中心点
    const centerLon = view.getInt32(113, true) * coordScale;
    const centerLat = view.getInt32(117, true) * coordScale;
    const centerZoom = bytes[121];

    return {
        version,
        rootDirectoryOffset,
        rootDirectoryLength,
        jsonMetadataOffset,
        jsonMetadataLength,
        leafDirectoryOffset,
        leafDirectoryLength,
        tileDataOffset,
        tileDataLength,
        numTiles,
        clustered,
        internalCompression,
        tileCompression,
        tileType,
        minZoom,
        maxZoom,
        bounds: { west: minLon, south: minLat, east: maxLon, north: maxLat },
        center: [centerLon, centerLat, centerZoom] as const,
    };
}

/**
 * 解析 PMTiles v3 目录二进制数据为条目数组。
 *
 * 目录格式为 varint 编码序列：
 * 1. numEntries (varint)
 * 2. tileId 增量序列 (numEntries 个 varint，delta 编码)
 * 3. runLength 序列 (numEntries 个 varint)
 * 4. length 序列 (numEntries 个 varint)
 * 5. offset 序列 (numEntries 个 varint，条件 delta 编码)
 *
 * @param buffer - 目录二进制数据（可能需要先解压缩）
 * @returns 目录条目数组
 * @throws {GeoForgeError} 当数据格式错误时
 *
 * @example
 * const entries = parseDirectory(directoryBuffer);
 */
function parseDirectory(buffer: ArrayBuffer): PMTilesDirectoryEntry[] {
    const bytes = new Uint8Array(buffer);
    let pos = 0;

    /**
     * 读取一个 varint（Protocol Buffers 风格的变长整数）。
     * 每字节低 7 位为数据，最高位为延续标志。
     */
    function readVarint(): number {
        let result = 0;
        let shift = 0;
        while (pos < bytes.length) {
            const byte = bytes[pos];
            pos++;
            // 累加低 7 位（左移 shift 位后按位或）
            result |= (byte & 0x7F) << shift;
            // 最高位为 0 表示结束
            if ((byte & 0x80) === 0) {
                return result >>> 0;
            }
            shift += 7;
            // 防止过长的 varint（超过 5 字节 / 35 位对于 uint32 来说不合法）
            if (shift > 35) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_DECODE_FAILED,
                    'PMTilesSource: 目录中 varint 编码过长',
                    { position: pos, shift },
                );
            }
        }
        // 数据不足
        throw new GeoForgeError(
            GeoForgeErrorCode.TILE_DECODE_FAILED,
            'PMTilesSource: 目录数据意外结束（读取 varint）',
            { position: pos, bufferLength: bytes.length },
        );
    }

    // 空目录保护
    if (bytes.length === 0) {
        return [];
    }

    // 1. 读取条目数量
    const numEntries = readVarint();
    if (numEntries === 0) {
        return [];
    }

    // 2. 读取 tileId 增量序列（delta 编码）
    const tileIds: number[] = new Array(numEntries);
    let lastTileId = 0;
    for (let i = 0; i < numEntries; i++) {
        const delta = readVarint();
        lastTileId += delta;
        tileIds[i] = lastTileId;
    }

    // 3. 读取 runLength 序列
    const runLengths: number[] = new Array(numEntries);
    for (let i = 0; i < numEntries; i++) {
        runLengths[i] = readVarint();
    }

    // 4. 读取 length 序列
    const lengths: number[] = new Array(numEntries);
    for (let i = 0; i < numEntries; i++) {
        lengths[i] = readVarint();
    }

    // 5. 读取 offset 序列（条件 delta 编码）
    // 规则：如果 offset[i] 为 0 且 i > 0，实际偏移 = offset[i-1] + length[i-1]
    const offsets: number[] = new Array(numEntries);
    for (let i = 0; i < numEntries; i++) {
        const rawOffset = readVarint();
        if (i > 0 && rawOffset === 0) {
            // 连续存储：偏移紧接上一条目之后
            offsets[i] = offsets[i - 1] + lengths[i - 1];
        } else {
            // 带增量的 offset（实际上对第一个条目直接赋值）
            offsets[i] = rawOffset;
        }
    }

    // 组装结果
    const entries: PMTilesDirectoryEntry[] = new Array(numEntries);
    for (let i = 0; i < numEntries; i++) {
        entries[i] = {
            tileId: tileIds[i],
            offset: offsets[i],
            length: lengths[i],
            runLength: runLengths[i],
        };
    }

    return entries;
}

/**
 * 在已排序的目录条目数组中二分查找指定 tileId。
 * 目录条目按 tileId 升序排列（PMTiles 规范保证）。
 *
 * @param entries - 排序后的目录条目数组
 * @param tileId - 要查找的瓦片 ID
 * @returns 匹配的条目，或 null（未找到）
 *
 * @example
 * const entry = findTileInDirectory(entries, 42);
 */
function findTileInDirectory(entries: PMTilesDirectoryEntry[], tileId: number): PMTilesDirectoryEntry | null {
    // 空目录返回 null
    if (entries.length === 0) {
        return null;
    }

    let lo = 0;
    let hi = entries.length - 1;

    // 标准二分查找：寻找 tileId 精确匹配或 run-length 覆盖
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const entry = entries[mid];

        if (tileId < entry.tileId) {
            // tileId 在左半部分
            hi = mid - 1;
        } else if (tileId >= entry.tileId + Math.max(1, entry.runLength)) {
            // tileId 超出此条目的 run-length 范围，在右半部分
            lo = mid + 1;
        } else {
            // 命中：tileId 在 [entry.tileId, entry.tileId + runLength) 范围内
            return entry;
        }
    }

    // 检查最后定位到的前一个条目（lo - 1）是否通过 runLength 覆盖 tileId
    // 这处理了 tileId 落在某个 entry 的 run-length 范围尾部的情况
    if (lo > 0) {
        const prevEntry = entries[lo - 1];
        if (prevEntry.runLength > 0 && tileId >= prevEntry.tileId && tileId < prevEntry.tileId + prevEntry.runLength) {
            return prevEntry;
        }
    }

    return null;
}

/**
 * 从 HTTP 响应头解析缓存过期时间。
 *
 * @param headers - fetch 响应的 Headers 对象
 * @param fallbackMs - 回退过期时间（毫秒）
 * @returns 过期时间戳（Unix 毫秒）
 */
function parseExpiresFromHeaders(headers: Headers, fallbackMs?: number): number | undefined {
    // 优先解析 Cache-Control: max-age=<seconds>
    const cacheControl = headers.get('Cache-Control');
    if (cacheControl !== null && cacheControl.length > 0) {
        const maxAgeMatch = cacheControl.match(/max-age\s*=\s*(\d+)/i);
        if (maxAgeMatch !== null && maxAgeMatch[1] !== undefined) {
            const maxAgeSec = parseInt(maxAgeMatch[1], 10);
            if (Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
                return Date.now() + maxAgeSec * 1000;
            }
        }
    }

    // 其次解析 Expires 头
    const expiresStr = headers.get('Expires');
    if (expiresStr !== null && expiresStr.length > 0) {
        const expiresTimestamp = Date.parse(expiresStr);
        if (Number.isFinite(expiresTimestamp) && expiresTimestamp > 0) {
            return expiresTimestamp;
        }
    }

    // 使用回退值
    if (fallbackMs !== undefined && Number.isFinite(fallbackMs) && fallbackMs > 0) {
        return Date.now() + fallbackMs;
    }

    return undefined;
}

// ======================== PMTilesSource 类 ========================

/**
 * PMTiles 单文件瓦片数据源。
 *
 * 通过 HTTP Range Request 从 PMTiles v3 归档中按需读取瓦片。
 * 实现 Hilbert 曲线瓦片 ID 编码、v3 头部解析、目录二分查找、
 * 叶目录递归查找和 LRU 目录缓存。
 *
 * 这是一个纯数据源，不继承 Layer，不参与渲染管线。
 * 由上层图层（如 VectorTileLayer、RasterTileLayer）组合使用。
 *
 * @stability stable
 *
 * @example
 * const source = new PMTilesSource({
 *   url: 'https://example.com/data.pmtiles',
 *   tileType: 'mvt',
 * });
 * await source.initialize();
 * const tile = await source.loadTile({ coord: { x: 1, y: 0, z: 1 } });
 */
export class PMTilesSource {
    /** 数据源类型标识，用于运行时类型鉴别 */
    readonly type: 'pmtiles' = 'pmtiles';

    /** 配置选项 */
    private readonly _options: Readonly<PMTilesSourceOptions>;

    /** 目录缓存大小上限 */
    private readonly _directoryCacheSize: number;

    /** 是否已初始化 */
    private _initialized: boolean;

    /** 是否已销毁 */
    private _destroyed: boolean;

    /** 解析后的文件头部 */
    private _header: PMTilesHeader | null;

    /** 根目录条目缓存 */
    private _rootDirectory: PMTilesDirectoryEntry[] | null;

    /**
     * 叶目录 LRU 缓存。
     * Key 为 "offset:length" 字符串，Value 为解析后的目录条目数组。
     * 使用 Map 的插入顺序近似 LRU（满时删除最早插入的条目）。
     */
    private readonly _directoryCache: Map<string, PMTilesDirectoryEntry[]>;

    /** JSON 元数据缓存 */
    private _jsonMetadata: Record<string, unknown> | null;

    /** 活跃的瓦片请求映射（tileKey → AbortController） */
    private readonly _activeRequests: Map<string, AbortController>;

    /** 检测/覆盖后的瓦片类型 */
    private _resolvedTileType: PMTilesTileTypeValue;

    /**
     * 创建 PMTiles 数据源实例。
     *
     * @param options - PMTiles 配置选项
     * @throws {GeoForgeError} 当 url 为空时
     *
     * @example
     * const source = new PMTilesSource({
     *   url: 'https://example.com/world.pmtiles',
     * });
     */
    constructor(options: PMTilesSourceOptions) {
        // 参数验证：url 必须非空
        if (options.url === undefined || options.url === null || options.url.trim().length === 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: url 不能为空',
                { optionKeys: Object.keys(options) },
            );
        }

        this._options = options;
        this._directoryCacheSize = options.directoryCacheSize ?? DEFAULT_DIRECTORY_CACHE;

        // 如果用户指定了瓦片类型，预设之；否则初始化时从头部检测
        this._resolvedTileType = options.tileType !== undefined
            ? userTileTypeToEnum(options.tileType)
            : PMTilesTileType.UNKNOWN;

        this._initialized = false;
        this._destroyed = false;
        this._header = null;
        this._rootDirectory = null;
        this._directoryCache = new Map<string, PMTilesDirectoryEntry[]>();
        this._jsonMetadata = null;
        this._activeRequests = new Map<string, AbortController>();
    }

    /**
     * 初始化数据源。
     * 通过 Range Request 读取文件头部（前 127 字节），解析头部信息，
     * 然后读取并解析根目录。
     *
     * @returns 初始化完成的 Promise
     * @throws {GeoForgeError} 当数据源已销毁、服务器不支持 Range Request、
     *         或头部解析失败时
     *
     * @stability stable
     *
     * @example
     * await source.initialize();
     * console.log(source.getHeader().numTiles);
     */
    async initialize(): Promise<void> {
        // 防止在已销毁状态下初始化
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 无法初始化已销毁的数据源',
                { url: this._options.url },
            );
        }

        // 幂等
        if (this._initialized) {
            return;
        }

        try {
            // 步骤 1：通过 Range Request 读取头部
            const headerBuffer = await this._fetchRange(0, PMTILES_HEADER_SIZE);
            this._header = parseHeader(headerBuffer);

            // 步骤 2：如果用户未指定瓦片类型，从头部自动检测
            if (this._resolvedTileType === PMTilesTileType.UNKNOWN) {
                this._resolvedTileType = this._header.tileType;
            }

            // 步骤 3：读取并解析根目录
            if (this._header.rootDirectoryLength > 0) {
                const rootDirBuffer = await this._fetchRange(
                    this._header.rootDirectoryOffset,
                    this._header.rootDirectoryLength,
                );

                // 根目录可能需要解压缩（取决于 internalCompression）
                const decompressedRootDir = await this._decompressDirectory(rootDirBuffer);
                this._rootDirectory = parseDirectory(decompressedRootDir);
            } else {
                this._rootDirectory = [];
            }

            this._initialized = true;

            if (__DEV__) {
                console.log(
                    `[PMTilesSource] 初始化完成: v${this._header.version}, ` +
                    `${this._header.numTiles} 瓦片, ` +
                    `zoom=${this._header.minZoom}-${this._header.maxZoom}, ` +
                    `tileType=${this._header.tileType}, ` +
                    `rootEntries=${this._rootDirectory.length}`,
                );
            }
        } catch (err: unknown) {
            if (err instanceof GeoForgeError) {
                throw err;
            }
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 初始化失败',
                { url: this._options.url },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    /**
     * 销毁数据源，释放所有资源。
     * 取消所有进行中的请求，清除目录缓存。
     *
     * @stability stable
     */
    destroy(): void {
        if (this._destroyed) {
            return;
        }

        // 取消所有活跃请求
        this._activeRequests.forEach((controller) => {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出
            }
        });
        this._activeRequests.clear();

        // 清除缓存
        this._header = null;
        this._rootDirectory = null;
        this._directoryCache.clear();
        this._jsonMetadata = null;

        this._destroyed = true;
        this._initialized = false;

        if (__DEV__) {
            console.log(`[PMTilesSource] 已销毁: ${this._options.url}`);
        }
    }

    /**
     * 获取数据源元数据。
     *
     * @returns 不可变元数据快照
     *
     * @stability stable
     */
    getMetadata(): PMTilesSourceMetadata {
        return {
            type: 'pmtiles',
            url: this._options.url,
            tileType: this._resolvedTileType,
            minZoom: this._header?.minZoom ?? 0,
            maxZoom: this._header?.maxZoom ?? MAX_ZOOM,
            bounds: this._header?.bounds ?? null,
            numTiles: this._header?.numTiles ?? 0,
            initialized: this._initialized,
        };
    }

    /**
     * 加载指定坐标的瓦片数据。
     * 通过 Hilbert 曲线将 (x, y, z) 转换为 tileId，
     * 在目录（含叶目录递归查找）中定位数据偏移和长度，
     * 然后通过 Range Request 读取瓦片数据。
     *
     * @param params - 瓦片加载参数
     * @returns 瓦片数据的 Promise
     * @throws {GeoForgeError} 当未初始化、已销毁、瓦片不存在或请求失败时
     *
     * @stability stable
     *
     * @example
     * const result = await source.loadTile({
     *   coord: { x: 215, y: 99, z: 8 },
     * });
     */
    async loadTile(params: PMTilesTileLoadParams): Promise<PMTilesTileLoadResult> {
        // 前置条件检查
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 数据源已销毁',
                { coord: params.coord },
            );
        }

        if (!this._initialized || this._header === null || this._rootDirectory === null) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 数据源未初始化，请先调用 initialize()',
                { coord: params.coord },
            );
        }

        const { coord, signal: externalSignal } = params;

        // 验证瓦片坐标有效性
        if (coord.z < 0 || coord.z > MAX_ZOOM || coord.x < 0 || coord.y < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 无效的瓦片坐标',
                { x: coord.x, y: coord.y, z: coord.z },
            );
        }

        // 验证 zoom 范围
        if (coord.z < this._header.minZoom || coord.z > this._header.maxZoom) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `PMTilesSource: zoom ${coord.z} 超出范围 [${this._header.minZoom}, ${this._header.maxZoom}]`,
                { z: coord.z, minZoom: this._header.minZoom, maxZoom: this._header.maxZoom },
            );
        }

        // 验证 x/y 不超出当前 zoom 级别范围
        const maxTileIndex = Math.pow(2, coord.z) - 1;
        if (coord.x > maxTileIndex || coord.y > maxTileIndex) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 瓦片坐标超出范围',
                { x: coord.x, y: coord.y, z: coord.z, maxIndex: maxTileIndex },
            );
        }

        // 计算 Hilbert tileId
        const tileId = xyzToTileId(coord.x, coord.y, coord.z);

        // 在目录中查找瓦片（支持叶目录递归）
        const entry = await this._findTileEntry(tileId, this._rootDirectory, 0, externalSignal);

        if (entry === null) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `PMTilesSource: 瓦片不存在 (${coord.z}/${coord.x}/${coord.y}, tileId=${tileId})`,
                { x: coord.x, y: coord.y, z: coord.z, tileId },
            );
        }

        // 生成瓦片唯一键
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;

        // 创建内部 AbortController
        const internalController = new AbortController();
        this._activeRequests.set(tileKey, internalController);

        // 联动外部取消信号
        let externalAbortHandler: (() => void) | undefined;
        if (externalSignal !== undefined) {
            if (externalSignal.aborted) {
                internalController.abort();
            } else {
                externalAbortHandler = () => { internalController.abort(); };
                externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        try {
            // 计算瓦片数据在文件中的绝对偏移
            const absoluteOffset = this._header.tileDataOffset + entry.offset;

            if (__DEV__) {
                console.log(
                    `[PMTilesSource] 加载瓦片: ${tileKey} → tileId=${tileId}, ` +
                    `offset=${absoluteOffset}, length=${entry.length}`,
                );
            }

            // 通过 Range Request 读取瓦片数据
            const data = await this._fetchRange(
                absoluteOffset,
                entry.length,
                internalController.signal,
            );

            // 验证响应体非空
            if (data.byteLength === 0) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'PMTilesSource: 瓦片数据为空',
                    { tileKey, tileId, offset: absoluteOffset, length: entry.length },
                );
            }

            return {
                data,
                coord,
                expiresAt: Date.now() + DEFAULT_TILE_EXPIRATION_MS,
                byteSize: data.byteLength,
            };
        } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'PMTilesSource: 瓦片请求已取消',
                    { tileKey, aborted: true },
                );
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                `PMTilesSource: 瓦片加载异常 (${tileKey})`,
                { tileKey, tileId },
                err instanceof Error ? err : new Error(String(err)),
            );
        } finally {
            this._activeRequests.delete(tileKey);
            if (externalAbortHandler !== undefined && externalSignal !== undefined) {
                externalSignal.removeEventListener('abort', externalAbortHandler);
            }
        }
    }

    /**
     * 取消指定瓦片坐标的加载请求。
     *
     * @param coord - 要取消的瓦片坐标
     *
     * @stability stable
     */
    cancelTile(coord: TileCoord): void {
        const tileKey = `${coord.z}/${coord.x}/${coord.y}`;
        const controller = this._activeRequests.get(tileKey);
        if (controller !== undefined) {
            try {
                controller.abort();
            } catch {
                // abort 不应抛出
            }
            this._activeRequests.delete(tileKey);
        }
    }

    /**
     * 获取已解析的文件头部。
     *
     * @returns 头部对象，未初始化时返回 null
     *
     * @stability stable
     *
     * @example
     * const header = source.getHeader();
     * if (header) console.log(header.numTiles, header.tileType);
     */
    getHeader(): PMTilesHeader | null {
        return this._header;
    }

    /**
     * 获取 PMTiles 嵌入的 JSON 元数据。
     * 首次调用时通过 Range Request 读取并解析，后续返回缓存。
     *
     * JSON 元数据通常包含 TileJSON 兼容字段（name、description、
     * attribution、vector_layers 等）。
     *
     * @returns JSON 元数据对象的 Promise，无元数据时返回空对象
     * @throws {GeoForgeError} 当未初始化、已销毁或读取失败时
     *
     * @stability stable
     *
     * @example
     * const meta = await source.getJSONMetadata();
     * console.log(meta.name, meta.vector_layers);
     */
    async getJSONMetadata(): Promise<Record<string, unknown>> {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 数据源已销毁',
                { url: this._options.url },
            );
        }

        if (!this._initialized || this._header === null) {
            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 数据源未初始化',
                { url: this._options.url },
            );
        }

        // 返回缓存
        if (this._jsonMetadata !== null) {
            return this._jsonMetadata;
        }

        // 无元数据区域
        if (this._header.jsonMetadataLength === 0) {
            this._jsonMetadata = {};
            return this._jsonMetadata;
        }

        try {
            // 读取元数据区域
            const metaBuffer = await this._fetchRange(
                this._header.jsonMetadataOffset,
                this._header.jsonMetadataLength,
            );

            // 元数据可能使用内部压缩方式，需解压
            const decompressed = await this._decompressDirectory(metaBuffer);

            // 将二进制数据解码为 UTF-8 字符串
            const decoder = new TextDecoder('utf-8');
            const jsonStr = decoder.decode(decompressed);

            if (jsonStr.trim().length === 0) {
                this._jsonMetadata = {};
                return this._jsonMetadata;
            }

            // 解析 JSON
            const parsed = JSON.parse(jsonStr);

            // 确保返回对象类型
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                this._jsonMetadata = parsed as Record<string, unknown>;
            } else {
                // 非对象的 JSON（如字符串或数组）包装为 { data: ... }
                this._jsonMetadata = { data: parsed };
            }

            if (__DEV__) {
                console.log(
                    `[PMTilesSource] JSON 元数据已加载: ${Object.keys(this._jsonMetadata).length} 个字段`,
                );
            }

            return this._jsonMetadata;
        } catch (err: unknown) {
            // JSON 解析错误不应阻断整体使用，返回空对象
            if (err instanceof SyntaxError) {
                if (__DEV__) {
                    console.warn('[PMTilesSource] JSON 元数据解析失败，返回空对象', err.message);
                }
                this._jsonMetadata = {};
                return this._jsonMetadata;
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: 读取 JSON 元数据失败',
                { url: this._options.url },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    // ======================== 私有方法 ========================

    /**
     * 在目录树中递归查找指定 tileId 的条目。
     * 如果在当前目录中找到 runLength=0 的条目（叶目录指针），
     * 则加载对应的叶目录并递归查找。
     *
     * @param tileId - 要查找的瓦片 ID
     * @param directory - 当前搜索的目录条目数组
     * @param depth - 当前递归深度
     * @param signal - 可选取消信号
     * @returns 匹配的条目（或 null）
     */
    private async _findTileEntry(
        tileId: number,
        directory: PMTilesDirectoryEntry[],
        depth: number,
        signal?: AbortSignal,
    ): Promise<PMTilesDirectoryEntry | null> {
        // 递归深度保护
        if (depth > MAX_LEAF_DEPTH) {
            if (__DEV__) {
                console.warn(
                    `[PMTilesSource] 叶目录递归深度超过 ${MAX_LEAF_DEPTH}，中止查找 tileId=${tileId}`,
                );
            }
            return null;
        }

        // 检查取消信号
        if (signal !== undefined && signal.aborted) {
            return null;
        }

        const entry = findTileInDirectory(directory, tileId);

        if (entry === null) {
            return null;
        }

        // runLength > 0：直接命中瓦片数据
        if (entry.runLength > 0) {
            return entry;
        }

        // runLength = 0：此条目是叶目录指针，需加载叶目录继续查找
        if (this._header === null) {
            return null;
        }

        // 叶目录的绝对偏移 = leafDirectoryOffset + entry.offset
        const leafOffset = this._header.leafDirectoryOffset + entry.offset;
        const leafLength = entry.length;

        // 尝试从缓存获取叶目录
        const cacheKey = `${leafOffset}:${leafLength}`;
        let leafEntries = this._directoryCache.get(cacheKey);

        if (leafEntries === undefined) {
            // 缓存未命中：通过 Range Request 加载叶目录
            try {
                const leafBuffer = await this._fetchRange(leafOffset, leafLength, signal);
                const decompressed = await this._decompressDirectory(leafBuffer);
                leafEntries = parseDirectory(decompressed);

                // 写入缓存（LRU 淘汰：超限时删除最早插入的条目）
                if (this._directoryCache.size >= this._directoryCacheSize) {
                    const firstKey = this._directoryCache.keys().next().value;
                    if (firstKey !== undefined) {
                        this._directoryCache.delete(firstKey);
                    }
                }
                this._directoryCache.set(cacheKey, leafEntries);

                if (__DEV__) {
                    console.log(
                        `[PMTilesSource] 叶目录已加载: ${cacheKey}, ${leafEntries.length} 条目, 深度=${depth + 1}`,
                    );
                }
            } catch (err: unknown) {
                if (err instanceof GeoForgeError) {
                    throw err;
                }
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'PMTilesSource: 叶目录加载失败',
                    { cacheKey, depth, tileId },
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        }

        // 在叶目录中递归查找
        return this._findTileEntry(tileId, leafEntries, depth + 1, signal);
    }

    /**
     * 通过 HTTP Range Request 获取文件的指定字节范围。
     *
     * @param offset - 起始字节偏移
     * @param length - 字节长度
     * @param signal - 可选取消信号
     * @returns 字节数据的 ArrayBuffer
     */
    private async _fetchRange(
        offset: number,
        length: number,
        signal?: AbortSignal,
    ): Promise<ArrayBuffer> {
        // 防御非法参数
        if (length <= 0) {
            return new ArrayBuffer(0);
        }

        // 构建 Range 头：bytes=offset-(offset+length-1)
        const rangeEnd = offset + length - 1;
        const rangeHeader = `bytes=${offset}-${rangeEnd}`;

        // 合并用户自定义请求头与 Range 头
        const headers: Record<string, string> = {
            ...(this._options.headers ?? {}),
            'Range': rangeHeader,
        };

        // 创建超时 controller
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RANGE_REQUEST_TIMEOUT_MS);

        // 联动外部取消信号
        let externalAbortHandler: (() => void) | undefined;
        if (signal !== undefined) {
            if (signal.aborted) {
                clearTimeout(timeoutId);
                controller.abort();
            } else {
                externalAbortHandler = () => { controller.abort(); };
                signal.addEventListener('abort', externalAbortHandler, { once: true });
            }
        }

        try {
            const response = await fetch(this._options.url, {
                method: 'GET',
                headers,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            // 期望 206 Partial Content 或 200 OK（全文件返回）
            if (!response.ok && response.status !== 206) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    `PMTilesSource: Range Request 失败 HTTP ${response.status} ${response.statusText}`,
                    { url: this._options.url, status: response.status, range: rangeHeader },
                );
            }

            // 如果服务器返回 200 而非 206，可能不支持 Range Request
            if (response.status === 200 && length < 1_000_000) {
                // 对于小范围请求收到完整文件，从 ArrayBuffer 中截取需要的部分
                const fullBuffer = await response.arrayBuffer();
                if (fullBuffer.byteLength < offset + length) {
                    throw new GeoForgeError(
                        GeoForgeErrorCode.TILE_LOAD_FAILED,
                        'PMTilesSource: 响应数据不足（服务器可能不支持 Range Request）',
                        {
                            url: this._options.url,
                            expectedOffset: offset,
                            expectedLength: length,
                            actualLength: fullBuffer.byteLength,
                        },
                    );
                }
                return fullBuffer.slice(offset, offset + length);
            }

            return await response.arrayBuffer();
        } catch (err: unknown) {
            clearTimeout(timeoutId);

            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_LOAD_FAILED,
                    'PMTilesSource: Range Request 超时或已取消',
                    { url: this._options.url, range: rangeHeader },
                );
            }

            if (err instanceof GeoForgeError) {
                throw err;
            }

            throw new GeoForgeError(
                GeoForgeErrorCode.TILE_LOAD_FAILED,
                'PMTilesSource: Range Request 异常',
                { url: this._options.url, range: rangeHeader },
                err instanceof Error ? err : new Error(String(err)),
            );
        } finally {
            if (externalAbortHandler !== undefined && signal !== undefined) {
                signal.removeEventListener('abort', externalAbortHandler);
            }
        }
    }

    /**
     * 解压缩目录数据。
     * 根据头部的 internalCompression 字段选择解压缩方式。
     * 当前支持：NONE（直通）和 GZIP（通过 DecompressionStream）。
     * BROTLI 和 ZSTD 需要 WASM 解码器，当前返回原始数据并发出开发警告。
     *
     * @param buffer - 可能已压缩的二进制数据
     * @returns 解压缩后的 ArrayBuffer
     */
    private async _decompressDirectory(buffer: ArrayBuffer): Promise<ArrayBuffer> {
        if (this._header === null) {
            return buffer;
        }

        const compression = this._header.internalCompression;

        // 无压缩：直接返回
        if (compression === PMTilesCompression.NONE) {
            return buffer;
        }

        // GZIP 解压缩：使用 Web Streams API 的 DecompressionStream
        if (compression === PMTilesCompression.GZIP) {
            try {
                // DecompressionStream 是 Web 标准 API，主流浏览器均支持
                const ds = new DecompressionStream('gzip');
                const writer = ds.writable.getWriter();
                const reader = ds.readable.getReader();

                // 写入压缩数据并关闭写入端
                writer.write(new Uint8Array(buffer));
                writer.close();

                // 读取解压缩后的所有数据块
                const chunks: Uint8Array[] = [];
                let totalLength = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    chunks.push(value);
                    totalLength += value.byteLength;
                }

                // 合并所有数据块为单个 ArrayBuffer
                const result = new Uint8Array(totalLength);
                let offset = 0;
                for (let i = 0; i < chunks.length; i++) {
                    result.set(chunks[i], offset);
                    offset += chunks[i].byteLength;
                }

                return result.buffer;
            } catch (err: unknown) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.TILE_DECODE_FAILED,
                    'PMTilesSource: GZIP 解压缩失败',
                    { compression: 'gzip', bufferSize: buffer.byteLength },
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        }

        // Brotli / Zstd：当前 Web 标准不支持，需要 WASM 解码器
        if (compression === PMTilesCompression.BROTLI || compression === PMTilesCompression.ZSTD) {
            if (__DEV__) {
                const name = compression === PMTilesCompression.BROTLI ? 'Brotli' : 'Zstd';
                console.warn(
                    `[PMTilesSource] ${name} 解压缩尚未实现，返回原始数据。` +
                    `请确保 PMTiles 文件使用 GZIP 或无压缩格式。`,
                );
            }
            return buffer;
        }

        // 未知压缩格式
        if (__DEV__) {
            console.warn(`[PMTilesSource] 未知压缩类型 ${compression}，返回原始数据`);
        }
        return buffer;
    }
}
