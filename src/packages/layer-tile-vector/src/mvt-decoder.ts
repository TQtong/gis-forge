// ============================================================
// layer-tile-vector/mvt-decoder.ts — MVT (Mapbox Vector Tile) Protobuf 解码器
// 从 ArrayBuffer 解码 Protocol Buffers 编码的矢量瓦片。
// 支持 MVT 规范 v2：层、要素、几何命令解码。
// 零 npm 依赖——自研简化版 Protobuf varint/zigzag 读取器。
// 依赖层级：可在 Worker 或主线程运行，纯函数无副作用。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * MVT 几何命令类型：MoveTo。
 * 编码：commandId = 1, 参数 count=N → N 组 (dx, dy)。
 */
const CMD_MOVE_TO = 1;

/**
 * MVT 几何命令类型：LineTo。
 * 编码：commandId = 2, 参数 count=N → N 组 (dx, dy)。
 */
const CMD_LINE_TO = 2;

/**
 * MVT 几何命令类型：ClosePath。
 * 编码：commandId = 7, 参数 count=1（无坐标参数）。
 */
const CMD_CLOSE_PATH = 7;

/**
 * MVT 要素类型枚举值：未知。
 */
const GEOM_TYPE_UNKNOWN = 0;

/**
 * MVT 要素类型枚举值：点。
 */
const GEOM_TYPE_POINT = 1;

/**
 * MVT 要素类型枚举值：线。
 */
const GEOM_TYPE_LINESTRING = 2;

/**
 * MVT 要素类型枚举值：面。
 */
const GEOM_TYPE_POLYGON = 3;

/**
 * Protobuf wire type: varint (type 0)。
 */
const WIRE_TYPE_VARINT = 0;

/**
 * Protobuf wire type: length-delimited (type 2)。
 */
const WIRE_TYPE_LENGTH_DELIMITED = 2;

/**
 * MVT 坐标范围上限（extent），默认 4096。
 * 超出此范围的坐标视为越界但仍解码（clip 在上层处理）。
 */
const DEFAULT_EXTENT = 4096;

// ===================== 类型接口 =====================

/**
 * MVT 要素几何类型字面量。
 */
export type MVTGeometryType = 'Unknown' | 'Point' | 'LineString' | 'Polygon';

/**
 * MVT 解码后的单个要素。
 */
export interface MVTFeature {
    /** 要素 ID（可选，MVT 规范中为可选 uint64）。 */
    readonly id: number | null;

    /** 几何类型。 */
    readonly type: MVTGeometryType;

    /**
     * 属性表（键值对）。
     * 值类型可为 string | number | boolean | null。
     */
    readonly properties: Record<string, string | number | boolean | null>;

    /**
     * 解码后的几何坐标。
     * 点：[[x, y], ...]
     * 线：[[x0,y0], [x1,y1], ...]（多段为嵌套数组）
     * 面：[外环, ...内环]，每环为 [x,y][] 序列
     * 坐标单位为瓦片坐标（0~extent）。
     */
    readonly geometry: number[][][];
}

/**
 * MVT 解码后的单个图层。
 */
export interface MVTLayer {
    /** 层名称。 */
    readonly name: string;

    /** 坐标范围（通常 4096）。 */
    readonly extent: number;

    /** 层内要素列表。 */
    readonly features: MVTFeature[];
}

/**
 * MVT 解码后的完整瓦片。
 */
export interface MVTTile {
    /** 层列表（有序）。 */
    readonly layers: MVTLayer[];
}

// ===================== Protobuf 底层读取器 =====================

/**
 * 轻量级 Protobuf 字节流读取器。
 * 支持 varint / zigzag / length-delimited 解码——MVT 解码所需的最小子集。
 */
class PbfReader {
    /** 底层字节数组视图。 */
    private readonly _buf: Uint8Array;

    /** 当前读取位置（字节偏移）。 */
    private _pos: number;

    /** 有效长度上限。 */
    private readonly _end: number;

    /**
     * @param buffer - 原始字节缓冲
     * @param start - 起始偏移
     * @param end - 结束偏移（不含）
     */
    constructor(buffer: Uint8Array, start: number, end: number) {
        this._buf = buffer;
        this._pos = start;
        this._end = end;
    }

    /**
     * 是否还有剩余字节。
     *
     * @returns 是否可继续读取
     */
    public hasMore(): boolean {
        return this._pos < this._end;
    }

    /**
     * 当前读取偏移。
     *
     * @returns 字节位置
     */
    public get pos(): number {
        return this._pos;
    }

    /**
     * 读取一个无符号 varint（最多 5 字节 / 32 位有效）。
     * Protobuf varint 编码：每字节低 7 位为数据，最高位为继续标志。
     *
     * @returns 解码后的无符号整数
     */
    public readVarint(): number {
        let result = 0;
        let shift = 0;

        while (this._pos < this._end) {
            const byte = this._buf[this._pos++];
            // 低 7 位拼入结果
            result |= (byte & 0x7F) << shift;
            // 最高位为 0 表示结束
            if ((byte & 0x80) === 0) {
                return result >>> 0;
            }
            shift += 7;
            // 安全阈值：varint 最多 10 字节（64 位），此处截断到 32 位
            if (shift > 35) {
                break;
            }
        }
        return result >>> 0;
    }

    /**
     * 读取一个有符号 varint（ZigZag 编码）。
     * ZigZag：将有符号数映射为无符号 → 0→0, -1→1, 1→2, -2→3, ...
     *
     * @returns 解码后的有符号整数
     */
    public readSVarint(): number {
        const n = this.readVarint();
        // ZigZag 解码：(n >>> 1) ^ -(n & 1)
        return (n >>> 1) ^ -(n & 1);
    }

    /**
     * 读取 UTF-8 字符串（长度前缀）。
     *
     * @param length - 字节长度
     * @returns 解码后的字符串
     */
    public readString(length: number): string {
        const end = Math.min(this._pos + length, this._end);
        const slice = this._buf.subarray(this._pos, end);
        this._pos = end;
        // 使用 TextDecoder 解码 UTF-8
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(slice);
        }
        // 回退：逐字节解码 ASCII（非 ASCII 字符可能不正确，但 Worker 环境通常有 TextDecoder）
        let str = '';
        for (let i = 0; i < slice.length; i++) {
            str += String.fromCharCode(slice[i]);
        }
        return str;
    }

    /**
     * 读取浮点数（IEEE 754 32 位 little-endian）。
     *
     * @returns float32 值
     */
    public readFloat(): number {
        if (this._pos + 4 > this._end) {
            return 0;
        }
        const view = new DataView(this._buf.buffer, this._buf.byteOffset + this._pos, 4);
        this._pos += 4;
        return view.getFloat32(0, true);
    }

    /**
     * 读取双精度浮点（IEEE 754 64 位 little-endian）。
     *
     * @returns float64 值
     */
    public readDouble(): number {
        if (this._pos + 8 > this._end) {
            return 0;
        }
        const view = new DataView(this._buf.buffer, this._buf.byteOffset + this._pos, 8);
        this._pos += 8;
        return view.getFloat64(0, true);
    }

    /**
     * 跳过指定字节数。
     *
     * @param bytes - 跳过的字节数
     */
    public skip(bytes: number): void {
        this._pos = Math.min(this._pos + bytes, this._end);
    }

    /**
     * 创建子读取器（嵌套消息）。
     *
     * @param length - 子消息字节长度
     * @returns 子 PbfReader
     */
    public subReader(length: number): PbfReader {
        const end = Math.min(this._pos + length, this._end);
        const sub = new PbfReader(this._buf, this._pos, end);
        this._pos = end;
        return sub;
    }
}

// ===================== MVT 几何命令解码 =====================

/**
 * 将几何类型 ID 映射为字面量字符串。
 *
 * @param typeId - MVT 规范中的 GeomType 枚举值
 * @returns 字面量类型名
 */
function geomTypeName(typeId: number): MVTGeometryType {
    if (typeId === GEOM_TYPE_POINT) {
        return 'Point';
    }
    if (typeId === GEOM_TYPE_LINESTRING) {
        return 'LineString';
    }
    if (typeId === GEOM_TYPE_POLYGON) {
        return 'Polygon';
    }
    return 'Unknown';
}

/**
 * 解码 MVT 几何命令序列为坐标环列表。
 *
 * MVT 几何编码：一系列 (command_integer, parameters) 对。
 * command_integer = (commandId << 3) | count（除 ClosePath 无坐标参数外）。
 * 坐标使用 ZigZag + delta 编码。
 *
 * @param integers - 命令整数序列
 * @param geomType - 几何类型 ID
 * @returns 嵌套坐标数组
 */
function decodeGeometry(integers: number[], geomType: number): number[][][] {
    const rings: number[][][] = [];
    let currentRing: number[][] = [];
    // 游标位置（delta 编码的累积器）
    let cx = 0;
    let cy = 0;
    let i = 0;

    while (i < integers.length) {
        const cmdInt = integers[i++];
        // 低 3 位为命令 ID，右移 3 位为参数计数
        const cmdId = cmdInt & 0x7;
        const count = cmdInt >> 3;

        if (cmdId === CMD_MOVE_TO) {
            // MoveTo：开始新的线段/环
            for (let j = 0; j < count; j++) {
                if (i + 1 >= integers.length) {
                    break;
                }
                // ZigZag delta 解码
                const dx = zigzagDecode(integers[i++]);
                const dy = zigzagDecode(integers[i++]);
                cx += dx;
                cy += dy;

                // Point 类型每个 MoveTo 就是一个独立点
                if (geomType === GEOM_TYPE_POINT) {
                    rings.push([[cx, cy]]);
                } else {
                    // Line/Polygon：新环
                    if (currentRing.length > 0) {
                        rings.push(currentRing);
                    }
                    currentRing = [[cx, cy]];
                }
            }
        } else if (cmdId === CMD_LINE_TO) {
            // LineTo：追加坐标
            for (let j = 0; j < count; j++) {
                if (i + 1 >= integers.length) {
                    break;
                }
                const dx = zigzagDecode(integers[i++]);
                const dy = zigzagDecode(integers[i++]);
                cx += dx;
                cy += dy;
                currentRing.push([cx, cy]);
            }
        } else if (cmdId === CMD_CLOSE_PATH) {
            // ClosePath：将当前环闭合（Polygon）
            if (currentRing.length > 0) {
                // 复制起点到末尾以闭合
                currentRing.push([currentRing[0][0], currentRing[0][1]]);
                rings.push(currentRing);
                currentRing = [];
            }
        } else {
            // 未知命令：跳过（防御性处理）
            if (__DEV__) {
                // eslint-disable-next-line no-console
                console.warn('[MVT] 未知几何命令 ID:', cmdId);
            }
        }
    }

    // 收尾：未闭合的环（LineString 场景）
    if (currentRing.length > 0) {
        rings.push(currentRing);
    }

    return rings;
}

/**
 * ZigZag 解码：将无符号整数还原为有符号。
 *
 * @param n - 无符号值
 * @returns 有符号值
 */
function zigzagDecode(n: number): number {
    return (n >>> 1) ^ -(n & 1);
}

// ===================== MVT Layer 解码 =====================

/**
 * 解码单个 MVT Layer 消息。
 *
 * MVT Layer 字段号：
 *   1: name (string)
 *   2: features (repeated message)
 *   3: keys (repeated string)
 *   4: values (repeated message)
 *   5: extent (uint32, 默认 4096)
 *   15: version (uint32)
 *
 * @param reader - 该层的 Protobuf 子读取器
 * @returns 解码后的 MVTLayer
 */
function decodeLayer(reader: PbfReader): MVTLayer {
    let name = '';
    let extent = DEFAULT_EXTENT;
    const keys: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    const rawFeatures: PbfReader[] = [];

    while (reader.hasMore()) {
        const tag = reader.readVarint();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        if (fieldNumber === 1 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // name: string
            const len = reader.readVarint();
            name = reader.readString(len);
        } else if (fieldNumber === 2 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // features: repeated message（暂存子读取器，待 keys/values 解析完后再解码要素）
            const len = reader.readVarint();
            rawFeatures.push(reader.subReader(len));
        } else if (fieldNumber === 3 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // keys: repeated string
            const len = reader.readVarint();
            keys.push(reader.readString(len));
        } else if (fieldNumber === 4 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // values: repeated message（Value 消息内部按类型字段号存储）
            const len = reader.readVarint();
            const valReader = reader.subReader(len);
            values.push(decodeValue(valReader));
        } else if (fieldNumber === 5 && wireType === WIRE_TYPE_VARINT) {
            // extent
            extent = reader.readVarint();
            if (extent === 0) {
                extent = DEFAULT_EXTENT;
            }
        } else if (fieldNumber === 15 && wireType === WIRE_TYPE_VARINT) {
            // version（读取但不存储——仅支持 v2）
            reader.readVarint();
        } else {
            // 跳过未知字段
            skipField(reader, wireType);
        }
    }

    // 解码要素（此时 keys 和 values 已就绪）
    const features: MVTFeature[] = [];
    for (const fr of rawFeatures) {
        const feat = decodeFeature(fr, keys, values);
        if (feat !== null) {
            features.push(feat);
        }
    }

    return { name, extent, features };
}

/**
 * 解码 Protobuf Value 消息（MVT 规范 Value 类型）。
 *
 * Value 字段号：
 *   1: string_value (string)
 *   2: float_value (float)
 *   3: double_value (double)
 *   4: int_value (int64, 此处截断为 number)
 *   5: uint_value (uint64)
 *   6: sint_value (sint64)
 *   7: bool_value (bool)
 *
 * @param reader - Value 子读取器
 * @returns 解码后的值
 */
function decodeValue(reader: PbfReader): string | number | boolean | null {
    let result: string | number | boolean | null = null;

    while (reader.hasMore()) {
        const tag = reader.readVarint();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        if (fieldNumber === 1 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            const len = reader.readVarint();
            result = reader.readString(len);
        } else if (fieldNumber === 2 && wireType === 5) {
            // fixed32 (float)
            result = reader.readFloat();
        } else if (fieldNumber === 3 && wireType === 1) {
            // fixed64 (double)
            result = reader.readDouble();
        } else if (fieldNumber === 4 && wireType === WIRE_TYPE_VARINT) {
            // int64 → number（JS 精度限制）
            result = reader.readVarint();
        } else if (fieldNumber === 5 && wireType === WIRE_TYPE_VARINT) {
            result = reader.readVarint();
        } else if (fieldNumber === 6 && wireType === WIRE_TYPE_VARINT) {
            result = reader.readSVarint();
        } else if (fieldNumber === 7 && wireType === WIRE_TYPE_VARINT) {
            result = reader.readVarint() !== 0;
        } else {
            skipField(reader, wireType);
        }
    }

    return result;
}

/**
 * 解码单个 MVT Feature 消息。
 *
 * Feature 字段号：
 *   1: id (uint64)
 *   2: tags (repeated uint32, packed)
 *   3: type (GeomType enum)
 *   4: geometry (repeated uint32, packed)
 *
 * @param reader - Feature 子读取器
 * @param keys - 层级键数组
 * @param values - 层级值数组
 * @returns 解码后的 MVTFeature 或 null（异常时）
 */
function decodeFeature(
    reader: PbfReader,
    keys: string[],
    values: (string | number | boolean | null)[],
): MVTFeature | null {
    let id: number | null = null;
    let geomType = GEOM_TYPE_UNKNOWN;
    const tags: number[] = [];
    const geomIntegers: number[] = [];

    while (reader.hasMore()) {
        const tag = reader.readVarint();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        if (fieldNumber === 1 && wireType === WIRE_TYPE_VARINT) {
            // id
            id = reader.readVarint();
        } else if (fieldNumber === 2 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // tags: packed repeated uint32
            const len = reader.readVarint();
            const end = reader.pos + len;
            const sub = reader.subReader(len);
            while (sub.hasMore()) {
                tags.push(sub.readVarint());
            }
        } else if (fieldNumber === 3 && wireType === WIRE_TYPE_VARINT) {
            // type
            geomType = reader.readVarint();
        } else if (fieldNumber === 4 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            // geometry: packed repeated uint32
            const len = reader.readVarint();
            const sub = reader.subReader(len);
            while (sub.hasMore()) {
                geomIntegers.push(sub.readVarint());
            }
        } else {
            skipField(reader, wireType);
        }
    }

    // 解码属性（tags 成对出现：key_index, value_index）
    const properties: Record<string, string | number | boolean | null> = {};
    for (let i = 0; i + 1 < tags.length; i += 2) {
        const keyIdx = tags[i];
        const valIdx = tags[i + 1];
        if (keyIdx < keys.length && valIdx < values.length) {
            properties[keys[keyIdx]] = values[valIdx];
        }
    }

    // 解码几何
    const geometry = decodeGeometry(geomIntegers, geomType);

    return {
        id,
        type: geomTypeName(geomType),
        properties,
        geometry,
    };
}

/**
 * 跳过一个未知 Protobuf 字段。
 *
 * @param reader - 读取器
 * @param wireType - wire type
 */
function skipField(reader: PbfReader, wireType: number): void {
    if (wireType === WIRE_TYPE_VARINT) {
        reader.readVarint();
    } else if (wireType === 1) {
        // 64-bit
        reader.skip(8);
    } else if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
        const len = reader.readVarint();
        reader.skip(len);
    } else if (wireType === 5) {
        // 32-bit
        reader.skip(4);
    } else {
        // 未知 wire type：无法安全跳过，只能中断
        if (__DEV__) {
            // eslint-disable-next-line no-console
            console.warn('[MVT] 未知 wire type:', wireType);
        }
    }
}

// ===================== 公共解码函数 =====================

/**
 * 解码 MVT（Mapbox Vector Tile）二进制数据为结构化瓦片对象。
 *
 * MVT 顶层为 Tile 消息，包含重复的 Layer 子消息（字段号 3）。
 *
 * @param buffer - MVT 二进制数据（通常从 fetch 获得）
 * @returns 解码后的 MVTTile
 *
 * @stability stable
 *
 * @example
 * const response = await fetch(tileUrl);
 * const buf = await response.arrayBuffer();
 * const tile = decodeMVT(buf);
 * for (const layer of tile.layers) {
 *   console.log(layer.name, layer.features.length);
 * }
 */
export function decodeMVT(buffer: ArrayBuffer): MVTTile {
    // 空缓冲区返回空瓦片
    if (buffer === null || buffer === undefined || buffer.byteLength === 0) {
        return { layers: [] };
    }

    const bytes = new Uint8Array(buffer);
    const reader = new PbfReader(bytes, 0, bytes.length);
    const layers: MVTLayer[] = [];

    // 顶层 Tile 消息：字段 3 = layers (repeated Layer)
    while (reader.hasMore()) {
        const tag = reader.readVarint();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        if (fieldNumber === 3 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            const len = reader.readVarint();
            const layerReader = reader.subReader(len);
            try {
                const layer = decodeLayer(layerReader);
                layers.push(layer);
            } catch (err) {
                // 单层解码失败不影响其他层
                if (__DEV__) {
                    // eslint-disable-next-line no-console
                    console.error('[MVT] 层解码失败:', err);
                }
            }
        } else {
            skipField(reader, wireType);
        }
    }

    return { layers };
}
