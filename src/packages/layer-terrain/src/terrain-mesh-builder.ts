// ============================================================
// layer-terrain/terrain-mesh-builder.ts — DEM 高程→三角网格转换器
// 从 DEM（Digital Elevation Model）数据生成可直接送 GPU 的
// 三角网格顶点、索引、法线以及裙边几何。
// 零 npm 依赖——纯数学运算。
// 依赖层级：可在 Worker 或主线程运行，纯函数无副作用。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * 默认网格分辨率（每边顶点数 = resolution + 1）。
 * 64 → 65×65=4225 顶点，4096 个四边形（8192 三角形），
 * 是精度与性能的常用平衡点。
 */
const DEFAULT_RESOLUTION = 64;

/**
 * 最小网格分辨率。
 */
const MIN_RESOLUTION = 2;

/**
 * 最大网格分辨率（性能保护）。
 */
const MAX_RESOLUTION = 256;

/**
 * 默认裙边高度（相对于 DEM 值域的比例因子）。
 * 裙边用于隐藏相邻瓦片间的 LOD 裂缝。
 * 0.01 表示裙边下垂为高程范围的 1%。
 */
const DEFAULT_SKIRT_HEIGHT_RATIO = 0.01;

/**
 * 默认地形夸张系数（1.0 = 无夸张）。
 */
const DEFAULT_EXAGGERATION = 1.0;

/**
 * 每个顶点的分量数：x, y, z（位置）。
 */
const POSITION_COMPONENTS = 3;

/**
 * 每个法线的分量数：nx, ny, nz。
 */
const NORMAL_COMPONENTS = 3;

/**
 * 每个三角形的索引数。
 */
const INDICES_PER_TRIANGLE = 3;

/**
 * 每个四边形的三角形数。
 */
const TRIANGLES_PER_QUAD = 2;

/**
 * 裙边每条边使用的三角形数（每段两个三角形）。
 */
const SKIRT_TRIANGLES_PER_SEGMENT = 2;

// ===================== 类型接口 =====================

/**
 * DEM（Digital Elevation Model）输入数据。
 */
export interface DEMData {
    /**
     * 高程值数组（行优先，从左上角开始）。
     * 长度 = width × height。
     * 值单位为米。NaN 或 -Infinity 表示无数据。
     */
    readonly elevations: Float32Array;

    /** DEM 宽度（像素/采样点数）。 */
    readonly width: number;

    /** DEM 高度（像素/采样点数）。 */
    readonly height: number;
}

/**
 * 网格构建选项。
 */
export interface TerrainMeshOptions {
    /**
     * 网格分辨率（每边细分数），默认 64。
     * 实际顶点数 = (resolution+1)²。
     * 必须在 [2, 256] 范围内。
     */
    readonly resolution?: number;

    /**
     * 裙边高度比例因子（相对高程范围），默认 0.01。
     * 0 表示不生成裙边。
     */
    readonly skirtHeightRatio?: number;

    /**
     * 高程夸张系数，默认 1.0。
     */
    readonly exaggeration?: number;
}

/**
 * 构建结果：GPU 可直接消费的缓冲数据。
 */
export interface TerrainMesh {
    /**
     * 顶点位置（Float32Array），每 3 个分量为一个顶点 (x, y, z)。
     * 包含主网格 + 裙边顶点。
     * x ∈ [0, 1]，y = 归一化高程，z ∈ [0, 1]。
     */
    readonly vertices: Float32Array;

    /**
     * 三角形索引（Uint32Array 或 Uint16Array），
     * 主网格三角形索引。
     */
    readonly indices: Uint32Array;

    /**
     * 顶点法线（Float32Array），每 3 个分量为一个法线 (nx, ny, nz)。
     * 与 vertices 一一对应。
     */
    readonly normals: Float32Array;

    /**
     * 裙边三角形索引（Uint32Array）。
     * 渲染时可单独提交或与主索引合并。
     */
    readonly skirtIndices: Uint32Array;

    /** 主网格顶点数。 */
    readonly vertexCount: number;

    /** 裙边顶点数。 */
    readonly skirtVertexCount: number;

    /** 主网格三角形数。 */
    readonly triangleCount: number;

    /** 裙边三角形数。 */
    readonly skirtTriangleCount: number;

    /** DEM 高程最小值（米）。 */
    readonly minElevation: number;

    /** DEM 高程最大值（米）。 */
    readonly maxElevation: number;
}

// ===================== 纯函数 =====================

/**
 * 双线性插值采样 DEM 高程值。
 *
 * @param elevations - 高程数组
 * @param demWidth - DEM 宽度
 * @param demHeight - DEM 高度
 * @param u - 归一化 X 坐标 [0, 1]
 * @param v - 归一化 Y 坐标 [0, 1]
 * @returns 插值后的高程（米）；无数据时返回 0
 *
 * @example
 * sampleDEM(data, 256, 256, 0.5, 0.5); // DEM 中心点高程
 */
function sampleDEM(
    elevations: Float32Array,
    demWidth: number,
    demHeight: number,
    u: number,
    v: number,
): number {
    // 将 [0,1] 映射到 DEM 像素坐标
    const fx = u * (demWidth - 1);
    const fy = v * (demHeight - 1);

    // 四个最近像素索引
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, demWidth - 1);
    const y1 = Math.min(y0 + 1, demHeight - 1);

    // 插值权重
    const tx = fx - x0;
    const ty = fy - y0;

    // 四角高程（无效值替换为 0）
    const e00 = safeElevation(elevations[y0 * demWidth + x0]);
    const e10 = safeElevation(elevations[y0 * demWidth + x1]);
    const e01 = safeElevation(elevations[y1 * demWidth + x0]);
    const e11 = safeElevation(elevations[y1 * demWidth + x1]);

    // 双线性插值
    const top = e00 + (e10 - e00) * tx;
    const bottom = e01 + (e11 - e01) * tx;
    return top + (bottom - top) * ty;
}

/**
 * 将可能无效的高程值安全化。
 *
 * @param value - 原始高程
 * @returns 有限高程值；NaN/Infinity 返回 0
 */
function safeElevation(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return value;
}

/**
 * 计算三角形面法线（叉积 + 归一化）。
 *
 * @param ax - 顶点 A.x
 * @param ay - 顶点 A.y
 * @param az - 顶点 A.z
 * @param bx - 顶点 B.x
 * @param by - 顶点 B.y
 * @param bz - 顶点 B.z
 * @param cx - 顶点 C.x
 * @param cy - 顶点 C.y
 * @param cz - 顶点 C.z
 * @returns [nx, ny, nz] 归一化法线
 */
function triangleNormal(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): [number, number, number] {
    // 边向量 AB, AC
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    // 叉积 AB × AC
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;

    // 归一化
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) {
        return [0, 1, 0];
    }
    const inv = 1 / len;
    nx *= inv;
    ny *= inv;
    nz *= inv;

    return [nx, ny, nz];
}

/**
 * 扫描 DEM 获取高程范围。
 *
 * @param elevations - 高程数组
 * @returns [min, max]
 */
function elevationRange(elevations: Float32Array): [number, number] {
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < elevations.length; i++) {
        const v = elevations[i];
        if (Number.isFinite(v)) {
            if (v < min) { min = v; }
            if (v > max) { max = v; }
        }
    }

    // 全部无效时回退到 [0, 0]
    if (!Number.isFinite(min)) { min = 0; }
    if (!Number.isFinite(max)) { max = 0; }

    return [min, max];
}

// ===================== 公共工厂函数 =====================

/**
 * 从 DEM 数据构建地形三角网格。
 *
 * 生成规则网格（resolution × resolution 四边形 → 2×resolution² 三角形），
 * 每个顶点通过双线性插值从 DEM 采样高程，并计算平滑顶点法线。
 * 可选生成裙边几何（skirt）以遮蔽相邻瓦片 LOD 裂缝。
 *
 * @param dem - DEM 高程数据
 * @param options - 分辨率、裙边、夸张选项
 * @returns TerrainMesh 包含 vertices, indices, normals, skirtIndices
 *
 * @stability stable
 *
 * @example
 * const mesh = buildTerrainMesh(demData, { resolution: 64, exaggeration: 1.5 });
 * // 上传 mesh.vertices / mesh.indices / mesh.normals 到 GPU
 */
export function buildTerrainMesh(
    dem: DEMData,
    options?: TerrainMeshOptions,
): TerrainMesh {
    // 参数校验与默认值
    const resolution = Math.max(
        MIN_RESOLUTION,
        Math.min(options?.resolution ?? DEFAULT_RESOLUTION, MAX_RESOLUTION),
    );
    const skirtRatio = options?.skirtHeightRatio ?? DEFAULT_SKIRT_HEIGHT_RATIO;
    const exaggeration = Math.max(0, options?.exaggeration ?? DEFAULT_EXAGGERATION);

    // DEM 校验
    const demW = dem.width;
    const demH = dem.height;
    if (demW < 2 || demH < 2) {
        throw new Error('[TerrainMesh] DEM 尺寸必须 ≥ 2×2');
    }
    if (dem.elevations.length < demW * demH) {
        throw new Error('[TerrainMesh] 高程数据长度不足');
    }

    // 高程范围
    const [minElev, maxElev] = elevationRange(dem.elevations);
    const elevRange = Math.max(maxElev - minElev, 1e-6);

    // 裙边绝对高度
    const skirtHeight = skirtRatio * elevRange * exaggeration;

    // ===== 主网格 =====
    const cols = resolution + 1;
    const rows = resolution + 1;
    const vertexCount = cols * rows;
    const quadCount = resolution * resolution;
    const triangleCount = quadCount * TRIANGLES_PER_QUAD;

    // 位置与法线缓冲
    const positions = new Float32Array(vertexCount * POSITION_COMPONENTS);
    const normals = new Float32Array(vertexCount * NORMAL_COMPONENTS);
    const indices = new Uint32Array(triangleCount * INDICES_PER_TRIANGLE);

    // 生成顶点位置
    for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
            const idx = iy * cols + ix;
            // 归一化 UV [0, 1]
            const u = ix / resolution;
            const v = iy / resolution;

            // 从 DEM 双线性插值采样高程
            const elev = sampleDEM(dem.elevations, demW, demH, u, v);
            // 归一化高程：(elev - minElev) / elevRange × exaggeration
            const normalizedY = ((elev - minElev) / elevRange) * exaggeration;

            const off = idx * POSITION_COMPONENTS;
            positions[off + 0] = u;
            positions[off + 1] = normalizedY;
            positions[off + 2] = v;
        }
    }

    // 生成三角形索引（两个三角形构成一个四边形）
    let indexPtr = 0;
    for (let iy = 0; iy < resolution; iy++) {
        for (let ix = 0; ix < resolution; ix++) {
            const topLeft = iy * cols + ix;
            const topRight = topLeft + 1;
            const bottomLeft = topLeft + cols;
            const bottomRight = bottomLeft + 1;

            // 三角形 1：topLeft → bottomLeft → topRight
            indices[indexPtr++] = topLeft;
            indices[indexPtr++] = bottomLeft;
            indices[indexPtr++] = topRight;

            // 三角形 2：topRight → bottomLeft → bottomRight
            indices[indexPtr++] = topRight;
            indices[indexPtr++] = bottomLeft;
            indices[indexPtr++] = bottomRight;
        }
    }

    // 计算平滑顶点法线（面法线面积加权平均）
    // 先累加所有相邻面法线
    for (let i = 0; i < triangleCount; i++) {
        const i0 = indices[i * 3 + 0];
        const i1 = indices[i * 3 + 1];
        const i2 = indices[i * 3 + 2];

        const [nx, ny, nz] = triangleNormal(
            positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2],
            positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2],
            positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2],
        );

        // 累加到三个顶点
        normals[i0 * 3 + 0] += nx;
        normals[i0 * 3 + 1] += ny;
        normals[i0 * 3 + 2] += nz;
        normals[i1 * 3 + 0] += nx;
        normals[i1 * 3 + 1] += ny;
        normals[i1 * 3 + 2] += nz;
        normals[i2 * 3 + 0] += nx;
        normals[i2 * 3 + 1] += ny;
        normals[i2 * 3 + 2] += nz;
    }

    // 归一化法线
    for (let i = 0; i < vertexCount; i++) {
        const off = i * 3;
        const nx = normals[off + 0];
        const ny = normals[off + 1];
        const nz = normals[off + 2];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-12) {
            const inv = 1 / len;
            normals[off + 0] *= inv;
            normals[off + 1] *= inv;
            normals[off + 2] *= inv;
        } else {
            normals[off + 0] = 0;
            normals[off + 1] = 1;
            normals[off + 2] = 0;
        }
    }

    // ===== 裙边 =====
    // 裙边顶点数：四条边 × (resolution + 1) × 2（顶 + 底）
    // 但边角顶点只需一份，简化为：周长顶点数 × 2
    const perimeterVertexCount = 4 * resolution;
    const skirtVertexCount = perimeterVertexCount * 2;
    const skirtTriangleCount = perimeterVertexCount * SKIRT_TRIANGLES_PER_SEGMENT;

    // 分配裙边顶点和法线（追加到主数据后面）
    const totalVertexCount = vertexCount + skirtVertexCount;
    const allPositions = new Float32Array(totalVertexCount * POSITION_COMPONENTS);
    const allNormals = new Float32Array(totalVertexCount * NORMAL_COMPONENTS);
    allPositions.set(positions);
    allNormals.set(normals);

    const skirtIndices = new Uint32Array(skirtTriangleCount * INDICES_PER_TRIANGLE);

    // 收集边界顶点索引（顺时针：上→右→下→左）
    const edgeIndices: number[] = [];
    // 上边（左→右）
    for (let ix = 0; ix < resolution; ix++) {
        edgeIndices.push(ix);
    }
    // 右边（上→下）
    for (let iy = 0; iy < resolution; iy++) {
        edgeIndices.push(iy * cols + resolution);
    }
    // 下边（右→左）
    for (let ix = resolution; ix > 0; ix--) {
        edgeIndices.push(resolution * cols + ix);
    }
    // 左边（下→上）
    for (let iy = resolution; iy > 0; iy--) {
        edgeIndices.push(iy * cols);
    }

    // 生成裙边顶点与索引
    let skirtVtxBase = vertexCount;
    let skirtIdxPtr = 0;

    for (let i = 0; i < edgeIndices.length; i++) {
        const mainIdx = edgeIndices[i];
        const nextMainIdx = edgeIndices[(i + 1) % edgeIndices.length];

        // 当前边界顶点的位置
        const mx = positions[mainIdx * 3 + 0];
        const my = positions[mainIdx * 3 + 1];
        const mz = positions[mainIdx * 3 + 2];

        // 下一个边界顶点
        const nmx = positions[nextMainIdx * 3 + 0];
        const nmy = positions[nextMainIdx * 3 + 1];
        const nmz = positions[nextMainIdx * 3 + 2];

        // 裙边底部顶点：向下偏移 skirtHeight
        const topIdx1 = skirtVtxBase;
        const botIdx1 = skirtVtxBase + 1;

        // 顶部复制主网格顶点
        allPositions[topIdx1 * 3 + 0] = mx;
        allPositions[topIdx1 * 3 + 1] = my;
        allPositions[topIdx1 * 3 + 2] = mz;

        // 底部向下偏移
        allPositions[botIdx1 * 3 + 0] = mx;
        allPositions[botIdx1 * 3 + 1] = my - skirtHeight;
        allPositions[botIdx1 * 3 + 2] = mz;

        // 法线继承主网格
        allNormals[topIdx1 * 3 + 0] = normals[mainIdx * 3 + 0];
        allNormals[topIdx1 * 3 + 1] = normals[mainIdx * 3 + 1];
        allNormals[topIdx1 * 3 + 2] = normals[mainIdx * 3 + 2];
        allNormals[botIdx1 * 3 + 0] = normals[mainIdx * 3 + 0];
        allNormals[botIdx1 * 3 + 1] = normals[mainIdx * 3 + 1];
        allNormals[botIdx1 * 3 + 2] = normals[mainIdx * 3 + 2];

        skirtVtxBase += 2;
    }

    // 生成裙边三角形索引
    const skirtBase = vertexCount;
    for (let i = 0; i < perimeterVertexCount; i++) {
        const currTop = skirtBase + i * 2;
        const currBot = skirtBase + i * 2 + 1;
        const nextTop = skirtBase + ((i + 1) % perimeterVertexCount) * 2;
        const nextBot = skirtBase + ((i + 1) % perimeterVertexCount) * 2 + 1;

        // 三角形 1
        skirtIndices[skirtIdxPtr++] = currTop;
        skirtIndices[skirtIdxPtr++] = currBot;
        skirtIndices[skirtIdxPtr++] = nextTop;

        // 三角形 2
        skirtIndices[skirtIdxPtr++] = nextTop;
        skirtIndices[skirtIdxPtr++] = currBot;
        skirtIndices[skirtIdxPtr++] = nextBot;
    }

    return {
        vertices: allPositions,
        indices,
        normals: allNormals,
        skirtIndices,
        vertexCount,
        skirtVertexCount,
        triangleCount,
        skirtTriangleCount,
        minElevation: minElev,
        maxElevation: maxElev,
    };
}
