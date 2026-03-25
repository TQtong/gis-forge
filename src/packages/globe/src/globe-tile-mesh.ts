/**
 * @module globe/globe-tile-mesh
 * @description 3D Globe 瓦片曲面细分、RTE 顶点转换、覆盖瓦片算法（含 Horizon + Frustum 双裁剪）、
 *   屏幕→椭球面反投影。所有坐标计算基于 WGS84 椭球体，与 Pipeline v2 §3-4 设计对齐。
 *
 * 设计要点：
 * - 瓦片网格使用 lat/lng 规则网格映射到 WGS84 椭球面
 * - Float64 存储 ECEF 位置（CPU 精度），RTE 转 Float32 后上传 GPU
 * - 极地退化三角形使用扇形替代
 * - 视口可见瓦片通过 screenToGlobe 射线-椭球体求交 + Horizon Cull + Frustum Cull 三重过滤
 *
 * @stability experimental
 */

import {
    WGS84_A,
    WGS84_B,
    WGS84_E2,
    geodeticToECEF,
    surfaceNormal,
    haversineDistance,
} from '../../core/src/geo/ellipsoid.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';

// ════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════

/** 度转弧度乘数 */
const DEG2RAD = Math.PI / 180;

/** 弧度转度乘数 */
const RAD2DEG = 180 / Math.PI;

/** 圆周率 */
const PI = Math.PI;

/** coveringTilesGlobe 返回的最大瓦片数量上限（防止极端 zoom/pitch 暴增） */
const MAX_GLOBE_TILES = 300;

/**
 * WGS84 赤道半径的平方 / 极半径的平方，用于射线-椭球体求交中的缩放因子。
 * ia2 = 1 / a², ib2 = 1 / b²
 */
const INV_A2 = 1.0 / (WGS84_A * WGS84_A);
const INV_B2 = 1.0 / (WGS84_B * WGS84_B);

// ════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════

/**
 * Globe 瓦片曲面网格。
 * positions 使用 Float64Array（ECEF 精度），normals/uvs 使用 Float32Array（GPU 精度足够）。
 */
export interface GlobeTileMesh {
    /** ECEF 坐标，Float64 紧凑排列 [x0,y0,z0, x1,y1,z1, ...]，每顶点 3 个分量 */
    readonly positions: Float64Array;
    /** 椭球面法线（球面近似），Float32 紧凑排列 */
    readonly normals: Float32Array;
    /** UV 纹理坐标，Float32 紧凑排列 [u0,v0, u1,v1, ...]，u∈[0,1] v∈[0,1] */
    readonly uvs: Float32Array;
    /** 三角形索引，CCW 正面朝外 */
    readonly indices: Uint32Array;
    /** 顶点总数 = (segments+1)² */
    readonly vertexCount: number;
    /** 索引总数 */
    readonly indexCount: number;
    /** 包围球（ECEF 坐标），用于 Frustum Culling */
    readonly boundingSphere: {
        readonly center: [number, number, number];
        readonly radius: number;
    };
}

/**
 * 3D Globe 瓦片标识。
 */
export interface GlobeTileID {
    /** 瓦片 zoom 级别 */
    readonly z: number;
    /** 瓦片列号 */
    readonly x: number;
    /** 瓦片行号 */
    readonly y: number;
    /** 唯一键 "z/x/y" */
    readonly key: string;
    /** 与相机注视点的大圆距离（米），用于排序 */
    readonly distToCamera: number;
}

/**
 * 3D 相机状态子集——coveringTilesGlobe / screenToGlobe 所需的最小字段集合。
 * 与 core/types/viewport.ts 的 CameraState 兼容但不强制完整依赖。
 */
export interface GlobeCamera {
    /** 视图投影矩阵（RTE 空间），Float32Array[16]，column-major */
    readonly vpMatrix: Float32Array;
    /** 逆 VP 矩阵（ECEF 绝对空间版），用于 screenToGlobe 射线反投影 */
    readonly inverseVP_ECEF: Float32Array;
    /** 相机 ECEF 坐标 [x, y, z]（米），Float64 精度 */
    readonly cameraECEF: [number, number, number];
    /** 注视点经纬度 [lng, lat]（度） */
    readonly center: [number, number];
    /** 连续 zoom 级别 */
    readonly zoom: number;
    /** 相机海拔（米） */
    readonly altitude: number;
    /** 地平线距离（米） */
    readonly horizonDist: number;
    /** 垂直 FOV（弧度） */
    readonly fov: number;
    /** 视口宽度（CSS 像素） */
    readonly viewportWidth: number;
    /** 视口高度（CSS 像素） */
    readonly viewportHeight: number;
}

// ════════════════════════════════════════════════════════════════
// 模块级复用缓冲（避免每次调用分配）
// ════════════════════════════════════════════════════════════════

/** geodeticToECEF 输出暂存 */
const _ecefBuf = new Float64Array(3) as Vec3d;

/** surfaceNormal 输出暂存 */
const _normalBuf = new Float64Array(3) as Vec3d;

/** 通用 Float64 暂存 3 分量 */
const _tmpVec3 = new Float64Array(3) as Vec3d;

// ════════════════════════════════════════════════════════════════
// §3.1 细分段数
// ════════════════════════════════════════════════════════════════

/**
 * 根据瓦片覆盖的角跨度决定曲面细分段数。
 * 低 zoom（大瓦片）覆盖角度大→需要更多段以逼近球面曲率；
 * 高 zoom（小瓦片）几乎平面→4 段足够。
 *
 * @param tileZ - 瓦片的整数 zoom 级别
 * @returns 细分段数（4 | 8 | 16 | 32 | 64）
 *
 * @example
 * getSegments(0);  // 64 — zoom 0 每瓦片覆盖 180° 纬度
 * getSegments(10); // 4  — zoom 10 每瓦片覆盖 ~0.18°
 */
export function getSegments(tileZ: number): number {
    // 每个瓦片覆盖的纬度度数（赤道处最大）
    const angularSpanDeg = 180 / (1 << tileZ);

    if (angularSpanDeg > 45) { return 64; }   // z=0~1: 90°~180°
    if (angularSpanDeg > 10) { return 32; }   // z=2~4: 11°~45°
    if (angularSpanDeg > 2) { return 16; }    // z=5~6: 2.8°~5.6°
    if (angularSpanDeg > 0.5) { return 8; }   // z=7~8: 0.7°~1.4°
    return 4;                                  // z=9+: < 0.35°
}

// ════════════════════════════════════════════════════════════════
// §3.2 瓦片曲面细分
// ════════════════════════════════════════════════════════════════

/**
 * 经度 → 瓦片列号（浮点，需 floor 取整）。
 *
 * @param lngDeg - 经度（度）
 * @param z - zoom 级别
 * @returns 浮点瓦片 X 坐标
 */
export function lngToTileX(lngDeg: number, z: number): number {
    return ((lngDeg + 180) / 360) * (1 << z);
}

/**
 * 纬度 → 瓦片行号（浮点，需 floor 取整）。
 * 使用 Web Mercator 纬度映射公式。
 *
 * @param latDeg - 纬度（度）
 * @param z - zoom 级别
 * @returns 浮点瓦片 Y 坐标
 */
export function latToTileY(latDeg: number, z: number): number {
    const r = latDeg * DEG2RAD;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / PI) / 2) * (1 << z);
}

/**
 * 瓦片行号 → 纬度（度）。
 * 逆 Web Mercator 纬度映射。
 *
 * @param y - 瓦片行号（浮点或整数）
 * @param z - zoom 级别
 * @returns 纬度（度）
 */
export function tileYToLat(y: number, z: number): number {
    const n = PI - 2 * PI * y / (1 << z);
    return Math.atan(Math.sinh(n)) * RAD2DEG;
}

/**
 * 生成一个 Globe 瓦片的曲面网格（Pipeline v2 §3.2）。
 *
 * 算法：
 * 1. 根据瓦片 (z, x, y) 计算经纬度范围
 * 2. 在经纬度范围内均匀采样 (segments+1)² 个网格点
 * 3. 每个点通过 geodeticToECEF 映射到 WGS84 椭球面
 * 4. 极地行（y=0 北极 / y=numTiles-1 南极）使用扇形三角形替代退化矩形
 * 5. 计算包围球用于后续 Frustum Culling
 *
 * @param z - 瓦片 zoom 级别
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param segments - 细分段数（推荐使用 getSegments(z) 获取）
 * @returns 完整网格数据
 *
 * @example
 * const mesh = tessellateGlobeTile(2, 1, 1, getSegments(2));
 * console.log(mesh.vertexCount); // (32+1)² = 1089
 */
export function tessellateGlobeTile(
    z: number,
    x: number,
    y: number,
    segments: number,
): GlobeTileMesh {
    const numTiles = 1 << z;

    // 瓦片经纬度范围（度）
    const lngMin = (x / numTiles) * 360 - 180;
    const lngMax = ((x + 1) / numTiles) * 360 - 180;
    const latMax = tileYToLat(y, z);        // 北边纬度（较大）
    const latMin = tileYToLat(y + 1, z);    // 南边纬度（较小）

    // 网格维度
    const n1 = segments + 1;
    const vertexCount = n1 * n1;

    // 分配顶点数组
    const positions = new Float64Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    // 包围球累加器
    let bsX = 0, bsY = 0, bsZ = 0;

    // 填充顶点数据
    for (let row = 0; row <= segments; row++) {
        const v = row / segments;
        // 从北到南线性插值纬度
        const latDeg = latMax + (latMin - latMax) * v;
        const latRad = latDeg * DEG2RAD;

        for (let col = 0; col <= segments; col++) {
            const u = col / segments;
            // 从西到东线性插值经度
            const lngDeg = lngMin + (lngMax - lngMin) * u;
            const lngRad = lngDeg * DEG2RAD;

            const idx = row * n1 + col;

            // ECEF 位置（Float64 精度）
            geodeticToECEF(_ecefBuf, lngRad, latRad, 0);
            positions[idx * 3] = _ecefBuf[0];
            positions[idx * 3 + 1] = _ecefBuf[1];
            positions[idx * 3 + 2] = _ecefBuf[2];

            // 椭球面法线（球面近似，Float32 足够）
            surfaceNormal(_normalBuf, lngRad, latRad);
            normals[idx * 3] = _normalBuf[0];
            normals[idx * 3 + 1] = _normalBuf[1];
            normals[idx * 3 + 2] = _normalBuf[2];

            // UV 纹理坐标
            uvs[idx * 2] = u;
            uvs[idx * 2 + 1] = v;

            // 累加包围球中心
            bsX += _ecefBuf[0];
            bsY += _ecefBuf[1];
            bsZ += _ecefBuf[2];
        }
    }

    // 包围球中心 = 所有顶点的质心
    bsX /= vertexCount;
    bsY /= vertexCount;
    bsZ /= vertexCount;

    // 包围球半径 = 质心到最远顶点的距离
    let bsRadius = 0;
    for (let i = 0; i < vertexCount; i++) {
        const dx = positions[i * 3] - bsX;
        const dy = positions[i * 3 + 1] - bsY;
        const dz = positions[i * 3 + 2] - bsZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > bsRadius) { bsRadius = dist; }
    }

    // ═══ 索引生成（含极地退化三角形处理）═══
    const isNorthPole = (y === 0);
    const isSouthPole = (y === numTiles - 1);

    let indices: Uint32Array;
    let indexCount: number;

    if (isNorthPole || isSouthPole) {
        // 极地行用扇形三角形，其余行正常四边形拆分为两个三角形
        const normalRows = segments - 1;
        // 扇形行：segments 个三角形 × 3 索引
        // 正常行：normalRows × segments × 6 索引
        const maxIdxCount = segments * 3 + normalRows * segments * 6;
        indices = new Uint32Array(maxIdxCount);
        let ii = 0;

        if (isNorthPole) {
            // 第一行所有顶点共享北极点位置 → 用扇形连接到第二行
            for (let col = 0; col < segments; col++) {
                indices[ii++] = 0;              // 极点（所有列共享同一 ECEF 位置）
                indices[ii++] = n1 + col;       // 第二行左
                indices[ii++] = n1 + col + 1;   // 第二行右
            }
            // 剩余行正常网格
            for (let row = 1; row < segments; row++) {
                for (let col = 0; col < segments; col++) {
                    const tl = row * n1 + col;
                    const tr = tl + 1;
                    const bl = (row + 1) * n1 + col;
                    const br = bl + 1;
                    // CCW 正面朝外（从地球外部观察）
                    indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
                    indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
                }
            }
        } else {
            // 南极：正常行在前，最后一行用扇形
            for (let row = 0; row < segments - 1; row++) {
                for (let col = 0; col < segments; col++) {
                    const tl = row * n1 + col;
                    const tr = tl + 1;
                    const bl = (row + 1) * n1 + col;
                    const br = bl + 1;
                    indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
                    indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
                }
            }
            // 最后一行 → 扇形（极点索引 = 最后一行第一个顶点）
            const lastRow = segments;
            const poleIdx = lastRow * n1;
            for (let col = 0; col < segments; col++) {
                indices[ii++] = (lastRow - 1) * n1 + col;
                indices[ii++] = poleIdx;
                indices[ii++] = (lastRow - 1) * n1 + col + 1;
            }
        }

        indexCount = ii;
        // 裁剪到实际使用长度
        indices = indices.slice(0, ii);
    } else {
        // 非极地：标准网格，每个四边形拆为 2 个三角形
        indexCount = segments * segments * 6;
        indices = new Uint32Array(indexCount);
        let ii = 0;
        for (let row = 0; row < segments; row++) {
            for (let col = 0; col < segments; col++) {
                const tl = row * n1 + col;
                const tr = tl + 1;
                const bl = (row + 1) * n1 + col;
                const br = bl + 1;
                indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
                indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
            }
        }
    }

    return {
        positions,
        normals,
        uvs,
        indices,
        vertexCount,
        indexCount,
        boundingSphere: {
            center: [bsX, bsY, bsZ],
            radius: bsRadius,
        },
    };
}

// ════════════════════════════════════════════════════════════════
// §3.3 RTE 顶点转换
// ════════════════════════════════════════════════════════════════

/**
 * 将 Globe 瓦片网格从 ECEF 绝对坐标转为 RTE（Relative-To-Eye）交错格式。
 * Float64 减法在 CPU 侧完成，输出 Float32 用于 GPU 上传。
 *
 * 输出交错格式（每顶点 8 个 Float32）：
 *   [relX, relY, relZ, nx, ny, nz, u, v]
 *
 * @param mesh - 瓦片网格（ECEF Float64 位置）
 * @param camECEF - 相机 ECEF 位置 [x, y, z]（Float64 精度）
 * @returns Float32Array 交错顶点数据，长度 = vertexCount × 8
 *
 * @example
 * const rte = meshToRTE(mesh, camera.cameraECEF);
 * device.queue.writeBuffer(vertexBuffer, 0, rte);
 */
export function meshToRTE(
    mesh: GlobeTileMesh,
    camECEF: [number, number, number],
): Float32Array {
    const n = mesh.vertexCount;
    // 8 floats/vertex: relXYZ(3) + normal(3) + uv(2)
    const out = new Float32Array(n * 8);
    const cx = camECEF[0], cy = camECEF[1], cz = camECEF[2];

    for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const i8 = i * 8;
        const i2 = i * 2;

        // Float64 减法（JS number = Float64）→ Float32 存储
        // 这保证了高精度的相对坐标（即使绝对坐标 > 6,000,000m）
        out[i8] = mesh.positions[i3] - cx;
        out[i8 + 1] = mesh.positions[i3 + 1] - cy;
        out[i8 + 2] = mesh.positions[i3 + 2] - cz;

        // 法线直接拷贝（已是 Float32）
        out[i8 + 3] = mesh.normals[i3];
        out[i8 + 4] = mesh.normals[i3 + 1];
        out[i8 + 5] = mesh.normals[i3 + 2];

        // UV 直接拷贝
        out[i8 + 6] = mesh.uvs[i2];
        out[i8 + 7] = mesh.uvs[i2 + 1];
    }

    return out;
}

// ════════════════════════════════════════════════════════════════
// §3.5 / §4.1 screenToGlobe — 射线-椭球体求交
// ════════════════════════════════════════════════════════════════

/**
 * 4×4 列主序矩阵 × 齐次向量乘法（内部工具函数）。
 *
 * @param m - 4×4 矩阵（Float32Array[16]，column-major）
 * @param x - 齐次向量 x
 * @param y - 齐次向量 y
 * @param z - 齐次向量 z
 * @param w - 齐次向量 w
 * @returns [rx, ry, rz, rw]
 */
function mulMat4Vec4(
    m: Float32Array,
    x: number, y: number, z: number, w: number,
): [number, number, number, number] {
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    ];
}

/**
 * 屏幕像素 → WGS84 椭球面经纬度（度）。
 * 使用 ECEF 空间的 inverseVP 矩阵构造射线，与椭球体 (x/a)²+(y/a)²+(z/b)²=1 求交。
 *
 * @param sx - 屏幕 x（CSS 像素）
 * @param sy - 屏幕 y（CSS 像素）
 * @param inverseVP_ECEF - 逆 VP 矩阵（ECEF 绝对坐标版）
 * @param vpWidth - 视口宽度
 * @param vpHeight - 视口高度
 * @returns [lngDeg, latDeg] 或 null（射线不与椭球面相交——太空方向）
 *
 * @example
 * const hit = screenToGlobe(400, 300, camera.inverseVP_ECEF, 800, 600);
 * if (hit) console.log(`Hit at ${hit[0]}°, ${hit[1]}°`);
 */
export function screenToGlobe(
    sx: number, sy: number,
    inverseVP_ECEF: Float32Array,
    vpWidth: number, vpHeight: number,
): [number, number] | null {
    // 屏幕坐标 → NDC [-1, 1]
    const nx = (sx / vpWidth) * 2 - 1;
    const ny = 1 - (sy / vpHeight) * 2;

    // 反投影到 ECEF 空间：near plane (z=0) 和 far plane (z=1)
    const a4 = mulMat4Vec4(inverseVP_ECEF, nx, ny, 0, 1);
    const b4 = mulMat4Vec4(inverseVP_ECEF, nx, ny, 1, 1);

    // 透视除法
    const near: [number, number, number] = [a4[0] / a4[3], a4[1] / a4[3], a4[2] / a4[3]];
    const far: [number, number, number] = [b4[0] / b4[3], b4[1] / b4[3], b4[2] / b4[3]];

    // 射线方向
    const dir: [number, number, number] = [
        far[0] - near[0],
        far[1] - near[1],
        far[2] - near[2],
    ];

    // 射线-椭球体求交：(x/a)² + (y/a)² + (z/b)² = 1
    // 参数化射线 P(t) = near + t·dir
    // 代入得 A·t² + B·t + C = 0
    const A = dir[0] * dir[0] * INV_A2
            + dir[1] * dir[1] * INV_A2
            + dir[2] * dir[2] * INV_B2;

    const B = 2 * (
        near[0] * dir[0] * INV_A2
        + near[1] * dir[1] * INV_A2
        + near[2] * dir[2] * INV_B2
    );

    const C = near[0] * near[0] * INV_A2
            + near[1] * near[1] * INV_A2
            + near[2] * near[2] * INV_B2
            - 1;

    const disc = B * B - 4 * A * C;
    // 判别式 < 0 → 射线不与椭球面相交（指向太空）
    if (disc < 0) { return null; }

    // 取较小的正根（最近交点）
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    // t < 0 → 交点在射线反方向（不可见）
    if (t < 0) { return null; }

    // 交点 ECEF 坐标
    const hitX = near[0] + t * dir[0];
    const hitY = near[1] + t * dir[1];
    const hitZ = near[2] + t * dir[2];

    // ECEF → 大地坐标（简化：直接用 atan2，无需完整 Bowring 迭代——精度 <10m 足够用于瓦片选择）
    const lngRad = Math.atan2(hitY, hitX);
    const p = Math.sqrt(hitX * hitX + hitY * hitY);
    let latRad = Math.atan2(hitZ, p * (1 - WGS84_E2));
    // 两次 Bowring 迭代（精度 < 1m）
    for (let i = 0; i < 2; i++) {
        const sinLat = Math.sin(latRad);
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
        latRad = Math.atan2(hitZ + WGS84_E2 * N * sinLat, p);
    }

    return [lngRad * RAD2DEG, latRad * RAD2DEG];
}

// ════════════════════════════════════════════════════════════════
// §4.2 Horizon Cull
// ════════════════════════════════════════════════════════════════

/**
 * 瓦片是否在地平线以上（面向相机的半球上）。
 *
 * 原理：
 * - 相机到瓦片中心的向量与瓦片法线的点积
 * - dot < 0 → 法线朝向相机 → 可见
 * - 大瓦片需要加余量（边缘可能跨越地平线）
 *
 * @param tx - 瓦片列号
 * @param ty - 瓦片行号
 * @param tz - 瓦片 zoom 级别
 * @param camECEF - 相机 ECEF 坐标
 * @returns true = 可见（在地平线之上或部分跨越）
 */
export function isTileVisible_Horizon(
    tx: number, ty: number, tz: number,
    camECEF: [number, number, number],
): boolean {
    const numTiles = 1 << tz;
    // 瓦片中心经纬度（度）
    const lngDeg = (tx + 0.5) / numTiles * 360 - 180;
    const latDeg = tileYToLat(ty + 0.5, tz);

    const lngRad = lngDeg * DEG2RAD;
    const latRad = latDeg * DEG2RAD;

    // 瓦片中心 ECEF
    geodeticToECEF(_ecefBuf, lngRad, latRad, 0);

    // 椭球面法线
    surfaceNormal(_normalBuf, lngRad, latRad);

    // 相机到瓦片的向量
    const camToTileX = _ecefBuf[0] - camECEF[0];
    const camToTileY = _ecefBuf[1] - camECEF[1];
    const camToTileZ = _ecefBuf[2] - camECEF[2];

    // 点积
    const dot = camToTileX * _normalBuf[0]
              + camToTileY * _normalBuf[1]
              + camToTileZ * _normalBuf[2];

    // 大瓦片的角半径余量（瓦片边缘可能跨越地平线）
    const tileAngularRadius = PI / numTiles;
    const margin = Math.sin(tileAngularRadius) * WGS84_A;

    // dot < margin → 法线大致朝向相机 → 可见
    return dot < margin;
}

// ════════════════════════════════════════════════════════════════
// §4.3 Frustum Cull
// ════════════════════════════════════════════════════════════════

/**
 * 从 VP 矩阵提取 6 个视锥平面（Gribb-Hartmann 方法）。
 * 每个平面 [a, b, c, d]，满足 ax+by+cz+d >= 0 表示在视锥内。
 *
 * @param vp - VP 矩阵（Float32Array[16]，column-major）
 * @returns 6 个平面，顺序：Left, Right, Bottom, Top, Near, Far
 */
function extractFrustumPlanes(vp: Float32Array): Float32Array[] {
    // column-major 访问：m[row][col] = vp[col * 4 + row]
    const row = (r: number, c: number): number => vp[c * 4 + r];

    const planes: Float32Array[] = [];

    // Left:   row3 + row0
    planes.push(normalizePlane(
        row(3, 0) + row(0, 0), row(3, 1) + row(0, 1),
        row(3, 2) + row(0, 2), row(3, 3) + row(0, 3),
    ));
    // Right:  row3 - row0
    planes.push(normalizePlane(
        row(3, 0) - row(0, 0), row(3, 1) - row(0, 1),
        row(3, 2) - row(0, 2), row(3, 3) - row(0, 3),
    ));
    // Bottom: row3 + row1
    planes.push(normalizePlane(
        row(3, 0) + row(1, 0), row(3, 1) + row(1, 1),
        row(3, 2) + row(1, 2), row(3, 3) + row(1, 3),
    ));
    // Top:    row3 - row1
    planes.push(normalizePlane(
        row(3, 0) - row(1, 0), row(3, 1) - row(1, 1),
        row(3, 2) - row(1, 2), row(3, 3) - row(1, 3),
    ));
    // Near:   row3 + row2
    planes.push(normalizePlane(
        row(3, 0) + row(2, 0), row(3, 1) + row(2, 1),
        row(3, 2) + row(2, 2), row(3, 3) + row(2, 3),
    ));
    // Far:    row3 - row2
    planes.push(normalizePlane(
        row(3, 0) - row(2, 0), row(3, 1) - row(2, 1),
        row(3, 2) - row(2, 2), row(3, 3) - row(2, 3),
    ));

    return planes;
}

/**
 * 归一化平面方程 (a,b,c,d)，使 (a,b,c) 为单位向量。
 * 归一化后 dist = a*x + b*y + c*z + d 直接是到平面的有符号距离。
 */
function normalizePlane(a: number, b: number, c: number, d: number): Float32Array {
    const len = Math.sqrt(a * a + b * b + c * c);
    const invLen = len > 1e-10 ? 1.0 / len : 0;
    return new Float32Array([a * invLen, b * invLen, c * invLen, d * invLen]);
}

/**
 * 瓦片包围球是否与视锥体相交。
 * 在 RTE 空间中执行（包围球中心需减去相机 ECEF）。
 *
 * @param bsCenter - 包围球中心 ECEF [x, y, z]
 * @param bsRadius - 包围球半径（米）
 * @param vpMatrix - RTE 空间的 VP 矩阵
 * @param camECEF - 相机 ECEF 坐标
 * @returns true = 在视锥内或部分相交
 */
export function isTileVisible_Frustum(
    bsCenter: [number, number, number],
    bsRadius: number,
    vpMatrix: Float32Array,
    camECEF: [number, number, number],
): boolean {
    const planes = extractFrustumPlanes(vpMatrix);

    // 包围球中心转为 RTE 坐标
    const cx = bsCenter[0] - camECEF[0];
    const cy = bsCenter[1] - camECEF[1];
    const cz = bsCenter[2] - camECEF[2];

    for (let pi = 0; pi < planes.length; pi++) {
        const p = planes[pi];
        // 有符号距离
        const dist = p[0] * cx + p[1] * cy + p[2] * cz + p[3];
        // 完全在平面外（距离 < -半径）→ 不可见
        if (dist < -bsRadius) { return false; }
    }

    return true;
}

// ════════════════════════════════════════════════════════════════
// §4.4 coveringTilesGlobe
// ════════════════════════════════════════════════════════════════

/**
 * 计算 3D Globe 视口覆盖的瓦片列表（Pipeline v2 §4.4）。
 *
 * 算法：
 * 1. 屏幕边缘 + 内部网格 40+ 个采样点 → screenToGlobe 投射到椭球面
 * 2. 地理坐标范围 → 瓦片坐标范围（跨日期变更线检测）
 * 3. 枚举 + Horizon Cull + LOD 距离衰减
 * 4. 按距离排序，截断到上限
 *
 * @param camera - Globe 相机状态
 * @returns 瓦片列表，按距相机排序
 *
 * @example
 * const tiles = coveringTilesGlobe(camera);
 * for (const t of tiles) { loadTile(t.z, t.x, t.y); }
 */
export function coveringTilesGlobe(camera: GlobeCamera): GlobeTileID[] {
    const tileZoom = Math.max(0, Math.floor(camera.zoom));
    const numTiles = 1 << tileZoom;

    const W = camera.viewportWidth;
    const H = camera.viewportHeight;

    // ═══ 步骤 1：屏幕采样点 → 椭球面经纬度 ═══
    // 边缘密采（9 点/边 = 36）+ 内部网格 3×3 = 9 + 中心 1 = 46 点
    const pts: [number, number][] = [];
    // 上下边缘各 9 点
    for (let i = 0; i <= 8; i++) { pts.push([W * i / 8, 0]); }
    for (let i = 0; i <= 8; i++) { pts.push([W * i / 8, H]); }
    // 左右边缘各 7 点（排除角点重复）
    for (let i = 1; i <= 7; i++) { pts.push([0, H * i / 8]); }
    for (let i = 1; i <= 7; i++) { pts.push([W, H * i / 8]); }
    // 中心
    pts.push([W / 2, H / 2]);
    // 内部 3×3 网格点（高 pitch 时需要更多采样以覆盖可见区域）
    for (let i = 1; i <= 3; i++) {
        for (let j = 1; j <= 3; j++) {
            pts.push([W * i / 4, H * j / 4]);
        }
    }

    // 投射到椭球面
    const hits: [number, number][] = [];
    for (let pi = 0; pi < pts.length; pi++) {
        const hit = screenToGlobe(
            pts[pi][0], pts[pi][1],
            camera.inverseVP_ECEF,
            W, H,
        );
        if (hit !== null) { hits.push(hit); }
    }

    // 所有射线都指向太空——相机看向深空方向，无可见瓦片
    if (hits.length === 0) { return []; }

    // ═══ 步骤 2：经纬度范围 → 瓦片坐标范围 ═══
    let mnLng = Infinity, mxLng = -Infinity;
    let mnLat = Infinity, mxLat = -Infinity;
    for (let i = 0; i < hits.length; i++) {
        const lng = hits[i][0], lat = hits[i][1];
        if (lng < mnLng) { mnLng = lng; }
        if (lng > mxLng) { mxLng = lng; }
        if (lat < mnLat) { mnLat = lat; }
        if (lat > mxLat) { mxLat = lat; }
    }

    // 跨日期变更线检测（经度跨度 > 180°）
    if (mxLng - mnLng > 180) {
        mnLng = -180;
        mxLng = 180;
    }

    const minTX = Math.max(0, Math.floor(lngToTileX(mnLng, tileZoom)));
    const maxTX = Math.min(numTiles - 1, Math.ceil(lngToTileX(mxLng, tileZoom)));
    // latToTileY: 较大纬度 → 较小 Y
    const minTY = Math.max(0, Math.floor(latToTileY(mxLat, tileZoom)));
    const maxTY = Math.min(numTiles - 1, Math.ceil(latToTileY(mnLat, tileZoom)));

    // ═══ 步骤 3：枚举 + Horizon Cull + LOD ═══
    const [clng, clat] = camera.center;
    const clngRad = clng * DEG2RAD;
    const clatRad = clat * DEG2RAD;

    const seen = new Set<string>();
    const tiles: GlobeTileID[] = [];

    for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
            // Horizon Cull：背面瓦片跳过
            if (!isTileVisible_Horizon(x, y, tileZoom, camera.cameraECEF)) {
                continue;
            }

            // 瓦片中心经纬度
            const tlng = (x + 0.5) / numTiles * 360 - 180;
            const tlat = tileYToLat(y + 0.5, tileZoom);

            // 与相机注视点的大圆距离
            const dist = haversineDistance(
                clngRad, clatRad,
                tlng * DEG2RAD, tlat * DEG2RAD,
            );

            // LOD 距离衰减：距中心越远 → zoom 越低
            const lodDrop = Math.min(
                Math.floor(Math.log2(Math.max(1, dist / 500000))),
                4,
            );
            const z = Math.max(0, tileZoom - lodDrop);

            // 降级到父瓦片
            const shift = tileZoom - z;
            const px = x >> shift;
            const py = y >> shift;
            const key = `${z}/${px}/${py}`;

            // 去重
            if (seen.has(key)) { continue; }
            seen.add(key);

            tiles.push({ z, x: px, y: py, key, distToCamera: dist });
        }
    }

    // 按距离排序（近→远，利于 early-Z）
    tiles.sort((a, b) => a.distToCamera - b.distToCamera);

    // 上限截断
    if (tiles.length > MAX_GLOBE_TILES) {
        tiles.length = MAX_GLOBE_TILES;
    }

    return tiles;
}

// ════════════════════════════════════════════════════════════════
// §6.1 Morph 辅助函数
// ════════════════════════════════════════════════════════════════

/**
 * 根据 zoom 计算 2.5D ↔ 3D morph 因子。
 * - zoom >= 5 → 0（纯 2.5D 平面）
 * - zoom <= 3 → 1（纯 3D Globe）
 * - 中间线性过渡
 *
 * @param zoom - 当前连续 zoom 级别
 * @returns morphFactor ∈ [0, 1]
 *
 * @example
 * computeMorphFactor(6);   // 0 — 纯 2.5D
 * computeMorphFactor(4);   // 0.5 — 过渡中
 * computeMorphFactor(2);   // 1 — 纯 Globe
 */
export function computeMorphFactor(zoom: number): number {
    /** morph 开始的 zoom（平面→开始弯曲） */
    const MORPH_START = 5.0;
    /** morph 完成的 zoom（完全球形） */
    const MORPH_END = 3.0;

    if (zoom >= MORPH_START) { return 0; }
    if (zoom <= MORPH_END) { return 1; }
    return 1 - (zoom - MORPH_END) / (MORPH_START - MORPH_END);
}

/**
 * 为 morph 过渡生成双坐标顶点数据。
 * 两套坐标都是**相对坐标**（数值量级相近 ±几千），适合 shader 中 mix。
 *
 * 输出交错格式（每顶点 11 个 Float32）：
 *   [flatRelX, flatRelY, flatRelZ, globeRelX, globeRelY, globeRelZ, nx, ny, nz, u, v]
 *
 * @param tileZ - 瓦片 zoom
 * @param tileX - 瓦片列号
 * @param tileY - 瓦片行号
 * @param segments - 细分段数
 * @param worldSize2D - 2.5D 模式下的 worldSize = 512 × 2^zoom
 * @param centerWorld2D - 2.5D 相机中心世界像素坐标 [cx, cy]
 * @param camECEF - 相机 ECEF 位置
 * @returns Float32Array 交错顶点数据
 */
export function computeMorphVertices(
    tileZ: number, tileX: number, tileY: number,
    segments: number,
    worldSize2D: number,
    centerWorld2D: [number, number],
    camECEF: [number, number, number],
): Float32Array {
    const numTiles = 1 << tileZ;
    const n1 = segments + 1;

    // 瓦片经纬度范围
    const lngMin = (tileX / numTiles) * 360 - 180;
    const lngMax = ((tileX + 1) / numTiles) * 360 - 180;
    const latMax = tileYToLat(tileY, tileZ);
    const latMin = tileYToLat(tileY + 1, tileZ);

    // 11 floats/vertex: flatRel(3) + globeRel(3) + normal(3) + uv(2)
    const out = new Float32Array(n1 * n1 * 11);

    for (let row = 0; row <= segments; row++) {
        const v = row / segments;
        const latDeg = latMax + (latMin - latMax) * v;
        const latRad = latDeg * DEG2RAD;

        for (let col = 0; col <= segments; col++) {
            const u = col / segments;
            const lngDeg = lngMin + (lngMax - lngMin) * u;
            const lngRad = lngDeg * DEG2RAD;
            const idx = (row * n1 + col) * 11;

            // 2.5D 相对坐标（Mercator 世界像素 - 相机中心）
            const mx = ((lngDeg + 180) / 360) * worldSize2D - centerWorld2D[0];
            const sinLat = Math.sin(latRad);
            const my = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * PI)) * worldSize2D - centerWorld2D[1];
            out[idx] = mx;
            out[idx + 1] = my;
            out[idx + 2] = 0;

            // 3D RTE 坐标（ECEF - 相机 ECEF）
            geodeticToECEF(_ecefBuf, lngRad, latRad, 0);
            out[idx + 3] = _ecefBuf[0] - camECEF[0];
            out[idx + 4] = _ecefBuf[1] - camECEF[1];
            out[idx + 5] = _ecefBuf[2] - camECEF[2];

            // 法线
            surfaceNormal(_normalBuf, lngRad, latRad);
            out[idx + 6] = _normalBuf[0];
            out[idx + 7] = _normalBuf[1];
            out[idx + 8] = _normalBuf[2];

            // UV
            out[idx + 9] = u;
            out[idx + 10] = v;
        }
    }

    return out;
}
