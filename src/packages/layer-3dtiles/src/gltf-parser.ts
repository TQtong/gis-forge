// ============================================================
// layer-3dtiles/gltf-parser.ts — glTF / glb 解析器
// 从 ArrayBuffer 解析 glTF 2.0 / glb 二进制格式，提取
// 网格几何（顶点/索引）、材质、纹理引用与场景节点树。
// 零 npm 依赖——自研解析逻辑。
// 依赖层级：可在 Worker 或主线程运行，纯函数无副作用。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * glb 文件魔数：ASCII 'glTF' → 0x46546C67（little-endian）。
 */
const GLB_MAGIC = 0x46546C67;

/**
 * glb 版本 2。
 */
const GLB_VERSION_2 = 2;

/**
 * glb chunk 类型：JSON。
 */
const GLB_CHUNK_JSON = 0x4E4F534A;

/**
 * glb chunk 类型：BIN（二进制缓冲）。
 */
const GLB_CHUNK_BIN = 0x004E4942;

/**
 * glb 文件头大小（字节）：magic(4) + version(4) + length(4)。
 */
const GLB_HEADER_SIZE = 12;

/**
 * glb chunk 头大小（字节）：chunkLength(4) + chunkType(4)。
 */
const GLB_CHUNK_HEADER_SIZE = 8;

/**
 * glTF accessor componentType 常量。
 */
const COMPONENT_TYPE_BYTE = 5120;
const COMPONENT_TYPE_UNSIGNED_BYTE = 5121;
const COMPONENT_TYPE_SHORT = 5122;
const COMPONENT_TYPE_UNSIGNED_SHORT = 5123;
const COMPONENT_TYPE_UNSIGNED_INT = 5125;
const COMPONENT_TYPE_FLOAT = 5126;

/**
 * glTF accessor type → 分量数映射。
 */
const TYPE_TO_COUNT: Record<string, number> = {
    'SCALAR': 1,
    'VEC2': 2,
    'VEC3': 3,
    'VEC4': 4,
    'MAT2': 4,
    'MAT3': 9,
    'MAT4': 16,
};

// ===================== 类型接口 =====================

/**
 * 解析后的网格基元（Primitive）。
 */
export interface GLTFPrimitive {
    /** 属性名 → TypedArray 映射（如 POSITION, NORMAL, TEXCOORD_0）。 */
    readonly attributes: Record<string, Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array>;

    /** 三角形索引（Uint16 或 Uint32）。 */
    readonly indices: Uint16Array | Uint32Array | null;

    /** 引用的材质索引。 */
    readonly materialIndex: number | null;

    /** 渲染模式（4=TRIANGLES, 0=POINTS, 1=LINES 等），默认 4。 */
    readonly mode: number;
}

/**
 * 解析后的网格。
 */
export interface GLTFMesh {
    /** 网格名称（可选）。 */
    readonly name: string;

    /** 基元列表。 */
    readonly primitives: GLTFPrimitive[];
}

/**
 * 解析后的 PBR 材质。
 */
export interface GLTFMaterial {
    /** 材质名称。 */
    readonly name: string;

    /** 基础颜色因子 [r, g, b, a]。 */
    readonly baseColorFactor: [number, number, number, number];

    /** 基础颜色纹理索引。 */
    readonly baseColorTextureIndex: number | null;

    /** 金属度因子 [0, 1]。 */
    readonly metallicFactor: number;

    /** 粗糙度因子 [0, 1]。 */
    readonly roughnessFactor: number;

    /** 是否双面渲染。 */
    readonly doubleSided: boolean;

    /** Alpha 模式：OPAQUE / MASK / BLEND。 */
    readonly alphaMode: string;

    /** Alpha 裁剪阈值（MASK 模式）。 */
    readonly alphaCutoff: number;
}

/**
 * 解析后的纹理引用。
 */
export interface GLTFTexture {
    /** 图片索引。 */
    readonly imageIndex: number;

    /** 采样器索引（-1 表示使用默认）。 */
    readonly samplerIndex: number;
}

/**
 * 解析后的图片数据。
 */
export interface GLTFImage {
    /** MIME 类型（如 'image/png'）。 */
    readonly mimeType: string;

    /** 图片二进制数据。 */
    readonly data: Uint8Array | null;

    /** 外部 URI（若图片未内嵌）。 */
    readonly uri: string | null;
}

/**
 * 解析后的场景节点。
 */
export interface GLTFNode {
    /** 节点名称。 */
    readonly name: string;

    /** 网格索引（可选）。 */
    readonly meshIndex: number | null;

    /** 局部变换矩阵（4×4 列主序）。 */
    readonly matrix: Float32Array;

    /** 子节点索引列表。 */
    readonly children: number[];
}

/**
 * glTF 完整解析结果。
 */
export interface GLTFData {
    /** 所有网格。 */
    readonly meshes: GLTFMesh[];

    /** 所有材质。 */
    readonly materials: GLTFMaterial[];

    /** 所有纹理引用。 */
    readonly textures: GLTFTexture[];

    /** 所有图片。 */
    readonly images: GLTFImage[];

    /** 所有场景节点。 */
    readonly nodes: GLTFNode[];

    /** 默认场景的根节点索引列表。 */
    readonly sceneNodes: number[];
}

// ===================== 内部辅助 =====================

/**
 * componentType → 单分量字节数。
 *
 * @param ct - componentType 编号
 * @returns 字节数
 */
function componentSize(ct: number): number {
    if (ct === COMPONENT_TYPE_BYTE || ct === COMPONENT_TYPE_UNSIGNED_BYTE) {
        return 1;
    }
    if (ct === COMPONENT_TYPE_SHORT || ct === COMPONENT_TYPE_UNSIGNED_SHORT) {
        return 2;
    }
    if (ct === COMPONENT_TYPE_UNSIGNED_INT || ct === COMPONENT_TYPE_FLOAT) {
        return 4;
    }
    return 1;
}

/**
 * 从 bufferView 和 accessor 信息创建 TypedArray。
 *
 * @param binData - 全部二进制数据
 * @param accessor - glTF accessor 对象
 * @param bufferViews - bufferView 列表
 * @returns 对应的 TypedArray
 */
function createTypedArray(
    binData: Uint8Array,
    accessor: Record<string, unknown>,
    bufferViews: Record<string, unknown>[],
): Float32Array | Uint16Array | Uint32Array | Int16Array | Int8Array | Uint8Array {
    const ct = accessor['componentType'] as number;
    const count = accessor['count'] as number;
    const type = (accessor['type'] as string) ?? 'SCALAR';
    const components = TYPE_TO_COUNT[type] ?? 1;
    const totalElements = count * components;

    const bvIdx = accessor['bufferView'] as number | undefined;
    let byteOffset = (accessor['byteOffset'] as number) ?? 0;

    if (bvIdx !== undefined && bvIdx < bufferViews.length) {
        const bv = bufferViews[bvIdx];
        const bvOffset = (bv['byteOffset'] as number) ?? 0;
        byteOffset += bvOffset;
    }

    // 确保偏移和长度不越界
    const endByte = byteOffset + totalElements * componentSize(ct);
    if (endByte > binData.length) {
        if (__DEV__) {
            // eslint-disable-next-line no-console
            console.warn('[glTF] TypedArray 越界，创建零数组');
        }
        return new Float32Array(totalElements);
    }

    // 创建对应 TypedArray（使用 slice 保证对齐安全）
    const slice = binData.buffer.slice(
        binData.byteOffset + byteOffset,
        binData.byteOffset + endByte,
    );

    if (ct === COMPONENT_TYPE_FLOAT) {
        return new Float32Array(slice);
    }
    if (ct === COMPONENT_TYPE_UNSIGNED_SHORT) {
        return new Uint16Array(slice);
    }
    if (ct === COMPONENT_TYPE_UNSIGNED_INT) {
        return new Uint32Array(slice);
    }
    if (ct === COMPONENT_TYPE_SHORT) {
        return new Int16Array(slice);
    }
    if (ct === COMPONENT_TYPE_BYTE) {
        return new Int8Array(slice);
    }
    return new Uint8Array(slice);
}

/**
 * 解析 glTF JSON 中的材质。
 *
 * @param matJson - 材质 JSON 对象
 * @returns GLTFMaterial
 */
function parseMaterial(matJson: Record<string, unknown>): GLTFMaterial {
    const name = (matJson['name'] as string) ?? '';
    const pbr = matJson['pbrMetallicRoughness'] as Record<string, unknown> | undefined;

    let baseColorFactor: [number, number, number, number] = [1, 1, 1, 1];
    let baseColorTextureIndex: number | null = null;
    let metallicFactor = 1;
    let roughnessFactor = 1;

    if (pbr !== undefined) {
        const bcf = pbr['baseColorFactor'] as number[] | undefined;
        if (Array.isArray(bcf) && bcf.length >= 4) {
            baseColorFactor = [bcf[0], bcf[1], bcf[2], bcf[3]];
        }

        const bct = pbr['baseColorTexture'] as Record<string, unknown> | undefined;
        if (bct !== undefined) {
            baseColorTextureIndex = (bct['index'] as number) ?? null;
        }

        metallicFactor = (pbr['metallicFactor'] as number) ?? 1;
        roughnessFactor = (pbr['roughnessFactor'] as number) ?? 1;
    }

    const doubleSided = (matJson['doubleSided'] as boolean) === true;
    const alphaMode = (matJson['alphaMode'] as string) ?? 'OPAQUE';
    const alphaCutoff = (matJson['alphaCutoff'] as number) ?? 0.5;

    return {
        name,
        baseColorFactor,
        baseColorTextureIndex,
        metallicFactor,
        roughnessFactor,
        doubleSided,
        alphaMode,
        alphaCutoff,
    };
}

/**
 * 解析节点变换矩阵。
 * 优先使用 `matrix` 字段；否则从 TRS 组合。
 *
 * @param nodeJson - 节点 JSON
 * @returns 4×4 列主序矩阵
 */
function parseNodeTransform(nodeJson: Record<string, unknown>): Float32Array {
    const mat = nodeJson['matrix'] as number[] | undefined;
    if (Array.isArray(mat) && mat.length >= 16) {
        return new Float32Array(mat);
    }

    // 从 T/R/S 组合（简化版：仅处理平移 + 缩放，旋转四元数用单位矩阵）
    const result = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);

    const translation = nodeJson['translation'] as number[] | undefined;
    const scale = nodeJson['scale'] as number[] | undefined;
    const rotation = nodeJson['rotation'] as number[] | undefined;

    // 缩放
    if (Array.isArray(scale) && scale.length >= 3) {
        result[0] = scale[0];
        result[5] = scale[1];
        result[10] = scale[2];
    }

    // 旋转（四元数 [x, y, z, w] → 旋转矩阵）
    if (Array.isArray(rotation) && rotation.length >= 4) {
        const qx = rotation[0];
        const qy = rotation[1];
        const qz = rotation[2];
        const qw = rotation[3];

        const sx = Array.isArray(scale) ? scale[0] : 1;
        const sy = Array.isArray(scale) ? scale[1] : 1;
        const sz = Array.isArray(scale) ? scale[2] : 1;

        // 四元数→旋转矩阵（含缩放）
        const x2 = qx + qx;
        const y2 = qy + qy;
        const z2 = qz + qz;
        const xx = qx * x2;
        const xy = qx * y2;
        const xz = qx * z2;
        const yy = qy * y2;
        const yz = qy * z2;
        const zz = qz * z2;
        const wx = qw * x2;
        const wy = qw * y2;
        const wz = qw * z2;

        result[0] = (1 - (yy + zz)) * sx;
        result[1] = (xy + wz) * sx;
        result[2] = (xz - wy) * sx;
        result[4] = (xy - wz) * sy;
        result[5] = (1 - (xx + zz)) * sy;
        result[6] = (yz + wx) * sy;
        result[8] = (xz + wy) * sz;
        result[9] = (yz - wx) * sz;
        result[10] = (1 - (xx + yy)) * sz;
    }

    // 平移
    if (Array.isArray(translation) && translation.length >= 3) {
        result[12] = translation[0];
        result[13] = translation[1];
        result[14] = translation[2];
    }

    return result;
}

// ===================== 公共解析函数 =====================

/**
 * 解析 glTF 2.0 / glb 二进制数据。
 *
 * 支持：
 * - glb (binary) 格式：自动检测魔数
 * - glTF JSON + 外部/嵌入缓冲（data URI）
 *
 * @param buffer - 文件二进制数据
 * @returns 解析后的 GLTFData
 *
 * @stability stable
 *
 * @example
 * const resp = await fetch('model.glb');
 * const buf = await resp.arrayBuffer();
 * const gltf = parseGLTF(buf);
 * for (const mesh of gltf.meshes) {
 *   for (const prim of mesh.primitives) {
 *     uploadToGPU(prim.attributes['POSITION'], prim.indices);
 *   }
 * }
 */
export function parseGLTF(buffer: ArrayBuffer): GLTFData {
    if (buffer === null || buffer === undefined || buffer.byteLength === 0) {
        throw new Error('[glTF] 输入缓冲为空');
    }

    const bytes = new Uint8Array(buffer);
    let jsonObj: Record<string, unknown>;
    let binData: Uint8Array = new Uint8Array(0);

    // 检测是否为 glb（二进制 glTF）
    const isGLB = buffer.byteLength >= GLB_HEADER_SIZE && readUint32LE(bytes, 0) === GLB_MAGIC;

    if (isGLB) {
        // 解析 glb 头
        const version = readUint32LE(bytes, 4);
        if (version !== GLB_VERSION_2) {
            throw new Error(`[glTF] 不支持的 glb 版本: ${version}`);
        }

        // 解析 chunks
        let offset = GLB_HEADER_SIZE;
        let jsonStr = '';

        while (offset + GLB_CHUNK_HEADER_SIZE <= bytes.length) {
            const chunkLength = readUint32LE(bytes, offset);
            const chunkType = readUint32LE(bytes, offset + 4);
            const chunkStart = offset + GLB_CHUNK_HEADER_SIZE;
            const chunkEnd = Math.min(chunkStart + chunkLength, bytes.length);

            if (chunkType === GLB_CHUNK_JSON) {
                // JSON chunk
                const slice = bytes.subarray(chunkStart, chunkEnd);
                if (typeof TextDecoder !== 'undefined') {
                    jsonStr = new TextDecoder('utf-8').decode(slice);
                } else {
                    let str = '';
                    for (let i = 0; i < slice.length; i++) {
                        str += String.fromCharCode(slice[i]);
                    }
                    jsonStr = str;
                }
            } else if (chunkType === GLB_CHUNK_BIN) {
                // BIN chunk
                binData = bytes.subarray(chunkStart, chunkEnd);
            }

            offset = chunkEnd;
            // 对齐到 4 字节
            while (offset % 4 !== 0 && offset < bytes.length) {
                offset++;
            }
        }

        if (jsonStr === '') {
            throw new Error('[glTF] glb 缺少 JSON chunk');
        }

        try {
            jsonObj = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
            throw new Error('[glTF] JSON chunk 解析失败');
        }
    } else {
        // 纯 JSON glTF（整个 buffer 是 JSON 文本）
        let jsonStr: string;
        if (typeof TextDecoder !== 'undefined') {
            jsonStr = new TextDecoder('utf-8').decode(bytes);
        } else {
            let str = '';
            for (let i = 0; i < bytes.length; i++) {
                str += String.fromCharCode(bytes[i]);
            }
            jsonStr = str;
        }

        try {
            jsonObj = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
            throw new Error('[glTF] JSON 解析失败');
        }
    }

    // ===== 解析 JSON 结构 =====
    const accessors = (jsonObj['accessors'] as Record<string, unknown>[]) ?? [];
    const bufferViews = (jsonObj['bufferViews'] as Record<string, unknown>[]) ?? [];
    const meshesJson = (jsonObj['meshes'] as Record<string, unknown>[]) ?? [];
    const materialsJson = (jsonObj['materials'] as Record<string, unknown>[]) ?? [];
    const texturesJson = (jsonObj['textures'] as Record<string, unknown>[]) ?? [];
    const imagesJson = (jsonObj['images'] as Record<string, unknown>[]) ?? [];
    const nodesJson = (jsonObj['nodes'] as Record<string, unknown>[]) ?? [];
    const scenesJson = (jsonObj['scenes'] as Record<string, unknown>[]) ?? [];
    const defaultScene = (jsonObj['scene'] as number) ?? 0;

    // 解析网格
    const meshes: GLTFMesh[] = [];
    for (const meshJson of meshesJson) {
        const name = (meshJson['name'] as string) ?? '';
        const primsJson = (meshJson['primitives'] as Record<string, unknown>[]) ?? [];
        const primitives: GLTFPrimitive[] = [];

        for (const primJson of primsJson) {
            const attrsJson = (primJson['attributes'] as Record<string, number>) ?? {};
            const attributes: Record<string, Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array> = {};

            for (const [attrName, accIdx] of Object.entries(attrsJson)) {
                if (typeof accIdx === 'number' && accIdx < accessors.length) {
                    attributes[attrName] = createTypedArray(binData, accessors[accIdx], bufferViews);
                }
            }

            let indices: Uint16Array | Uint32Array | null = null;
            const indicesIdx = primJson['indices'] as number | undefined;
            if (indicesIdx !== undefined && indicesIdx < accessors.length) {
                const arr = createTypedArray(binData, accessors[indicesIdx], bufferViews);
                if (arr instanceof Uint16Array || arr instanceof Uint32Array) {
                    indices = arr;
                } else {
                    // 其他类型转为 Uint32
                    const u32 = new Uint32Array(arr.length);
                    for (let i = 0; i < arr.length; i++) {
                        u32[i] = arr[i];
                    }
                    indices = u32;
                }
            }

            const materialIndex = (primJson['material'] as number) ?? null;
            const mode = (primJson['mode'] as number) ?? 4;

            primitives.push({ attributes, indices, materialIndex, mode });
        }

        meshes.push({ name, primitives });
    }

    // 解析材质
    const materials: GLTFMaterial[] = materialsJson.map(parseMaterial);

    // 解析纹理
    const textures: GLTFTexture[] = texturesJson.map((tex) => ({
        imageIndex: (tex['source'] as number) ?? 0,
        samplerIndex: (tex['sampler'] as number) ?? -1,
    }));

    // 解析图片
    const images: GLTFImage[] = imagesJson.map((img) => {
        const mimeType = (img['mimeType'] as string) ?? 'image/png';
        const bvIdx = img['bufferView'] as number | undefined;
        let data: Uint8Array | null = null;
        const uri = (img['uri'] as string) ?? null;

        if (bvIdx !== undefined && bvIdx < bufferViews.length) {
            const bv = bufferViews[bvIdx];
            const bvOffset = (bv['byteOffset'] as number) ?? 0;
            const bvLength = (bv['byteLength'] as number) ?? 0;
            data = binData.subarray(bvOffset, bvOffset + bvLength);
        }

        return { mimeType, data, uri };
    });

    // 解析节点
    const nodes: GLTFNode[] = nodesJson.map((nodeJson) => ({
        name: (nodeJson['name'] as string) ?? '',
        meshIndex: (nodeJson['mesh'] as number) ?? null,
        matrix: parseNodeTransform(nodeJson),
        children: (nodeJson['children'] as number[]) ?? [],
    }));

    // 解析场景根节点
    let sceneNodes: number[] = [];
    if (defaultScene < scenesJson.length) {
        const scene = scenesJson[defaultScene];
        sceneNodes = (scene['nodes'] as number[]) ?? [];
    }

    return {
        meshes,
        materials,
        textures,
        images,
        nodes,
        sceneNodes,
    };
}

/**
 * 从 Uint8Array 读取 little-endian uint32。
 *
 * @param buf - 字节数组
 * @param offset - 偏移
 * @returns uint32 值
 */
function readUint32LE(buf: Uint8Array, offset: number): number {
    return (
        buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)
    ) >>> 0;
}
