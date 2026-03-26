/**
 * @module globe/globe-tile-mesh
 * @description 3D Globe 瓦片曲面细分（含裙边抗接缝）、RTE 顶点转换、覆盖瓦片算法
 *   （含 Horizon + Frustum 双裁剪）、屏幕→椭球面反投影。
 *   所有坐标计算可配置椭球体参数（默认 WGS84），与 Pipeline v2 §3-4 设计对齐。
 *
 * 设计要点：
 * - 瓦片网格使用 lat/lng 规则网格映射到椭球面
 * - Float64 存储 ECEF 位置（CPU 精度），RTE 转 Float32 后上传 GPU
 * - 极地退化三角形使用扇形替代
 * - 裙边（skirt）遮挡相邻瓦片接缝——无需两遍 draw call，额外 ~20% 顶点
 * - 椭球体参数化：所有函数接受可选 Ellipsoid 参数，默认 WGS84，支持月球/火星等天体
 * - 视口可见瓦片通过 screenToGlobe 射线-椭球体求交 + Horizon Cull + Frustum Cull 三重过滤
 *
 * @stability experimental
 */

import {
    WGS84_A,
    WGS84_B,
    WGS84_E2,
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
 * 裙边深度因子：裙边高度 = ellipsoid.a × SKIRT_DEPTH_FACTOR。
 * 0.005 × 6378137 ≈ 31891m（约 32km），足以覆盖任何亚像素缝隙。
 * 值过大会导致裙边在低视角下可见，过小则无法遮挡接缝。
 */
const SKIRT_DEPTH_FACTOR = 0.005;

// ════════════════════════════════════════════════════════════════
// 椭球体参数化
// ════════════════════════════════════════════════════════════════

/**
 * 椭球体参数接口，描述旋转椭球体的几何形状。
 * 支持 WGS84（地球）、月球、火星等任意天体。
 *
 * @example
 * // WGS84 地球椭球体
 * const earth: Ellipsoid = { a: 6378137.0, b: 6356752.314245179, e2: 0.00669437999014 };
 *
 * @example
 * // 月球椭球体（IAU 2015）
 * const moon: Ellipsoid = { a: 1737400.0, b: 1737400.0, e2: 0.0 };
 */
export interface Ellipsoid {
    /** 长半轴（赤道半径），单位：米。定义值，无误差 */
    readonly a: number;
    /** 短半轴（极半径），单位：米。由 b = a × (1 - f) 推导 */
    readonly b: number;
    /** 第一偏心率的平方 e² = 2f - f²，无量纲。描述偏离正球体的程度 */
    readonly e2: number;
}

/**
 * WGS84 椭球体常量对象。
 * 参考来源：NIMA TR8350.2 (2000)，IERS Conventions (2010)。
 * 所有函数的 ellipsoid 参数默认值均指向此对象。
 */
export const WGS84_ELLIPSOID: Ellipsoid = {
    a: 6378137.0,
    b: 6356752.314245179,
    e2: 0.00669437999014,
};

// ════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════

/**
 * Globe 瓦片曲面网格（含裙边几何）。
 * positions 使用 Float64Array（ECEF 精度），normals/uvs 使用 Float32Array（GPU 精度足够）。
 * vertexCount 包含主网格和裙边顶点之和。
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
    /** 顶点总数 = 主网格 (segments+1)² + 裙边顶点 */
    readonly vertexCount: number;
    /** 索引总数（主网格 + 裙边三角形） */
    readonly indexCount: number;
    /** 包围球（ECEF 坐标），用于 Frustum Culling，涵盖主网格和裙边 */
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
    /**
     * 可选椭球体参数。
     * 默认 WGS84。设为月球/火星椭球体可渲染非地球天体。
     * 影响 coveringTilesGlobe 中的 screenToGlobe 和 isTileVisible_Horizon。
     */
    readonly ellipsoid?: Ellipsoid;
}

// ════════════════════════════════════════════════════════════════
// 模块级复用缓冲（避免每次调用分配）
// ════════════════════════════════════════════════════════════════

/** localGeodeticToECEF / surfaceNormal 输出暂存 */
const _ecefBuf = new Float64Array(3) as Vec3d;

/** surfaceNormal 输出暂存 */
const _normalBuf = new Float64Array(3) as Vec3d;

/** 通用 Float64 暂存 3 分量 */
const _tmpVec3 = new Float64Array(3) as Vec3d;

// ════════════════════════════════════════════════════════════════
// 椭球体参数化本地辅助函数
// ════════════════════════════════════════════════════════════════

/**
 * 将大地坐标（经度、纬度、高程）转换为 ECEF 地心地固笛卡尔坐标（参数化椭球体版本）。
 *
 * 与 core/geo/ellipsoid.ts 中的 geodeticToECEF 逻辑一致，但接受任意椭球体参数，
 * 支持月球/火星等非 WGS84 天体。核心模块不修改，此为本模块内的局部辅助函数。
 *
 * ECEF 坐标系：X→0°经线赤道交点，Y→90°E 赤道交点，Z→北极
 *
 * @param out - 预分配的 Float64Array(3) 输出，存储 [X, Y, Z]（米）
 * @param lonRad - 经度（弧度），范围 [-π, π]
 * @param latRad - 纬度（弧度），范围 [-π/2, π/2]
 * @param alt - 椭球面上方高程（米），负值表示椭球面以下
 * @param ellipsoid - 椭球体参数（a=长半轴, b=短半轴, e2=偏心率²）
 * @returns out 引用，便于链式调用
 *
 * @example
 * const ecef = new Float64Array(3);
 * localGeodeticToECEF(ecef, 0, 0, 0, WGS84_ELLIPSOID);
 * // ecef ≈ [6378137, 0, 0]  （赤道与本初子午线交点）
 */
function localGeodeticToECEF(
    out: Vec3d,
    lonRad: number,
    latRad: number,
    alt: number,
    ellipsoid: Ellipsoid,
): Vec3d {
    // 预计算三角函数值，避免重复调用（V8 无法自动 CSE 跨 Math.sin/cos 调用）
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    // N = 卯酉圈曲率半径：N = a / sqrt(1 - e²·sin²φ)
    // 赤道处 N = a ≈ 6378137m，极点处 N = a²/b ≈ 6399594m（WGS84）
    const N = ellipsoid.a / Math.sqrt(1.0 - ellipsoid.e2 * sinLat * sinLat);

    // ECEF 转换公式（标准大地测量）
    // X = (N + h) · cosφ · cosλ
    out[0] = (N + alt) * cosLat * cosLon;
    // Y = (N + h) · cosφ · sinλ
    out[1] = (N + alt) * cosLat * sinLon;
    // Z = (N·(1-e²) + h) · sinφ — Z 方向因扁率 e² 而比 X/Y 短
    out[2] = (N * (1.0 - ellipsoid.e2) + alt) * sinLat;

    return out;
}

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
// §3.2 瓦片曲面细分（含裙边抗接缝）
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
 * 生成一个 Globe 瓦片的曲面网格（含裙边抗接缝几何，Pipeline v2 §3.2）。
 *
 * 算法：
 * 1. 根据瓦片 (z, x, y) 计算经纬度范围
 * 2. 在经纬度范围内均匀采样 (segments+1)² 个网格点
 * 3. 每个点通过 localGeodeticToECEF 映射到椭球面
 * 4. 极地行（y=0 北极 / y=numTiles-1 南极）使用扇形三角形替代退化矩形
 * 5. 为非退化边缘生成裙边顶点（海拔 = -skirtDepth），裙边三角形连接主网格边缘与裙边
 * 6. 计算包围球（含裙边）用于后续 Frustum Culling
 *
 * 裙边设计：
 * - 每条非退化边缘（segments+1 个顶点）生成 (segments+1) 个裙边顶点
 * - 裙边深度 = ellipsoid.a × SKIRT_DEPTH_FACTOR ≈ 32km（WGS84）
 * - 极地行边缘（所有顶点汇聚到极点）跳过裙边生成（退化三角形无视觉意义）
 * - 裙边三角形绕序保证正面朝外（远离瓦片中心方向）
 *
 * @param z - 瓦片 zoom 级别
 * @param x - 瓦片列号
 * @param y - 瓦片行号
 * @param segments - 细分段数（推荐使用 getSegments(z) 获取）
 * @param ellipsoid - 椭球体参数，默认 WGS84。支持月球/火星等非地球天体
 * @returns 完整网格数据（含裙边）
 *
 * @example
 * const mesh = tessellateGlobeTile(2, 1, 1, getSegments(2));
 * // 主网格: (32+1)² = 1089 顶点，裙边: 4×33 = 132 顶点，总计 1221 顶点
 *
 * @example
 * // 月球瓦片
 * const MOON: Ellipsoid = { a: 1737400, b: 1737400, e2: 0 };
 * const moonMesh = tessellateGlobeTile(3, 2, 2, 16, MOON);
 */
export function tessellateGlobeTile(
    z: number,
    x: number,
    y: number,
    segments: number,
    ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
): GlobeTileMesh {
    const numTiles = 1 << z;

    // 瓦片经纬度范围（度）
    const lngMin = (x / numTiles) * 360 - 180;
    const lngMax = ((x + 1) / numTiles) * 360 - 180;
    const latMax = tileYToLat(y, z);        // 北边纬度（较大）
    const latMin = tileYToLat(y + 1, z);    // 南边纬度（较小）

    // 网格维度
    const n1 = segments + 1;
    const mainVertexCount = n1 * n1;

    // ═══ 裙边边缘判定 ═══
    // 北极瓦片（y=0）：顶边所有顶点汇聚到极点，裙边退化→跳过
    const isNorthPole = (y === 0);
    // 南极瓦片（y=numTiles-1）：底边所有顶点汇聚到极点→跳过
    const isSouthPole = (y === numTiles - 1);

    // 四条边是否生成裙边
    const hasTopSkirt = !isNorthPole;
    const hasBottomSkirt = !isSouthPole;
    // 左右边缘始终需要裙边（即使极地瓦片，左右边缘也是非退化的经线段）
    const hasLeftSkirt = true;
    const hasRightSkirt = true;

    // 裙边边数和顶点/索引计数
    const skirtEdgeCount = (hasTopSkirt ? 1 : 0) + (hasBottomSkirt ? 1 : 0)
        + (hasLeftSkirt ? 1 : 0) + (hasRightSkirt ? 1 : 0);
    // 每条裙边边缘复制 n1 个顶点到负高程处
    const skirtVertexCount = skirtEdgeCount * n1;
    const totalVertexCount = mainVertexCount + skirtVertexCount;

    // 裙边深度：椭球赤道半径 × 深度因子（WGS84 ≈ 31891m）
    const skirtDepth = ellipsoid.a * SKIRT_DEPTH_FACTOR;

    // ═══ 分配顶点数组（主网格 + 裙边）═══
    const positions = new Float64Array(totalVertexCount * 3);
    const normals = new Float32Array(totalVertexCount * 3);
    const uvs = new Float32Array(totalVertexCount * 2);

    // ═══ 填充主网格顶点 ═══
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

            // ECEF 位置（Float64 精度），使用参数化椭球体
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, 0, ellipsoid);
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
        }
    }

    // ═══ 填充裙边顶点 ═══
    // 每条活跃边缘生成 n1 个裙边顶点，位置 = 相同经纬度但海拔 = -skirtDepth
    // 法线和 UV 直接复制自对应的主网格边缘顶点
    let svOffset = mainVertexCount;

    // 记录每条边裙边顶点的起始偏移，用于后续索引生成
    const skirtTopBase = hasTopSkirt ? svOffset : -1;
    if (hasTopSkirt) {
        // 顶边（row=0）：从西向东遍历所有列
        const latRad = latMax * DEG2RAD;
        for (let col = 0; col <= segments; col++) {
            const u = col / segments;
            const lngRad = (lngMin + (lngMax - lngMin) * u) * DEG2RAD;

            // 裙边 ECEF：相同经纬度，海拔 = -skirtDepth（向球心内缩）
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, -skirtDepth, ellipsoid);
            positions[svOffset * 3] = _ecefBuf[0];
            positions[svOffset * 3 + 1] = _ecefBuf[1];
            positions[svOffset * 3 + 2] = _ecefBuf[2];

            // 法线和 UV 完全复制自主网格对应顶点（row=0, col）
            const mainIdx = col;
            normals[svOffset * 3] = normals[mainIdx * 3];
            normals[svOffset * 3 + 1] = normals[mainIdx * 3 + 1];
            normals[svOffset * 3 + 2] = normals[mainIdx * 3 + 2];
            uvs[svOffset * 2] = uvs[mainIdx * 2];
            uvs[svOffset * 2 + 1] = uvs[mainIdx * 2 + 1];

            svOffset++;
        }
    }

    const skirtBottomBase = hasBottomSkirt ? svOffset : -1;
    if (hasBottomSkirt) {
        // 底边（row=segments）：从西向东遍历所有列
        const latRad = latMin * DEG2RAD;
        for (let col = 0; col <= segments; col++) {
            const u = col / segments;
            const lngRad = (lngMin + (lngMax - lngMin) * u) * DEG2RAD;

            // 裙边 ECEF：同上，海拔 = -skirtDepth
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, -skirtDepth, ellipsoid);
            positions[svOffset * 3] = _ecefBuf[0];
            positions[svOffset * 3 + 1] = _ecefBuf[1];
            positions[svOffset * 3 + 2] = _ecefBuf[2];

            // 法线和 UV 复制自主网格底边顶点（row=segments, col）
            const mainIdx = segments * n1 + col;
            normals[svOffset * 3] = normals[mainIdx * 3];
            normals[svOffset * 3 + 1] = normals[mainIdx * 3 + 1];
            normals[svOffset * 3 + 2] = normals[mainIdx * 3 + 2];
            uvs[svOffset * 2] = uvs[mainIdx * 2];
            uvs[svOffset * 2 + 1] = uvs[mainIdx * 2 + 1];

            svOffset++;
        }
    }

    const skirtLeftBase = svOffset;
    {
        // 左边（col=0）：从北向南遍历所有行
        const lngRad = lngMin * DEG2RAD;
        for (let row = 0; row <= segments; row++) {
            const v = row / segments;
            const latRad = (latMax + (latMin - latMax) * v) * DEG2RAD;

            // 裙边 ECEF
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, -skirtDepth, ellipsoid);
            positions[svOffset * 3] = _ecefBuf[0];
            positions[svOffset * 3 + 1] = _ecefBuf[1];
            positions[svOffset * 3 + 2] = _ecefBuf[2];

            // 法线和 UV 复制自主网格左边顶点（row, col=0）
            const mainIdx = row * n1;
            normals[svOffset * 3] = normals[mainIdx * 3];
            normals[svOffset * 3 + 1] = normals[mainIdx * 3 + 1];
            normals[svOffset * 3 + 2] = normals[mainIdx * 3 + 2];
            uvs[svOffset * 2] = uvs[mainIdx * 2];
            uvs[svOffset * 2 + 1] = uvs[mainIdx * 2 + 1];

            svOffset++;
        }
    }

    const skirtRightBase = svOffset;
    {
        // 右边（col=segments）：从北向南遍历所有行
        const lngRad = lngMax * DEG2RAD;
        for (let row = 0; row <= segments; row++) {
            const v = row / segments;
            const latRad = (latMax + (latMin - latMax) * v) * DEG2RAD;

            // 裙边 ECEF
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, -skirtDepth, ellipsoid);
            positions[svOffset * 3] = _ecefBuf[0];
            positions[svOffset * 3 + 1] = _ecefBuf[1];
            positions[svOffset * 3 + 2] = _ecefBuf[2];

            // 法线和 UV 复制自主网格右边顶点（row, col=segments）
            const mainIdx = row * n1 + segments;
            normals[svOffset * 3] = normals[mainIdx * 3];
            normals[svOffset * 3 + 1] = normals[mainIdx * 3 + 1];
            normals[svOffset * 3 + 2] = normals[mainIdx * 3 + 2];
            uvs[svOffset * 2] = uvs[mainIdx * 2];
            uvs[svOffset * 2 + 1] = uvs[mainIdx * 2 + 1];

            svOffset++;
        }
    }

    // ═══ 包围球（含裙边顶点）═══
    // 使用所有顶点的质心作为球心，最远顶点到质心的距离作为半径
    let bsX = 0, bsY = 0, bsZ = 0;
    for (let i = 0; i < totalVertexCount; i++) {
        bsX += positions[i * 3];
        bsY += positions[i * 3 + 1];
        bsZ += positions[i * 3 + 2];
    }
    // 质心 = 所有顶点坐标的算术平均值
    bsX /= totalVertexCount;
    bsY /= totalVertexCount;
    bsZ /= totalVertexCount;

    // 半径 = 质心到最远顶点的欧几里德距离
    let bsRadius = 0;
    for (let i = 0; i < totalVertexCount; i++) {
        const dx = positions[i * 3] - bsX;
        const dy = positions[i * 3 + 1] - bsY;
        const dz = positions[i * 3 + 2] - bsZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > bsRadius) { bsRadius = dist; }
    }

    // ═══ 索引生成（主网格 + 裙边）═══
    // 预计算主网格索引的精确数量
    const mainIdxCount = (isNorthPole || isSouthPole)
        ? segments * 3 + (segments - 1) * segments * 6   // 扇形 + 网格
        : segments * segments * 6;                         // 全网格
    // 裙边索引：每条活跃边缘 × segments 个四边形 × 每四边形 2 三角形 × 每三角形 3 索引
    const skirtIdxCount = skirtEdgeCount * segments * 6;
    const totalMaxIdxCount = mainIdxCount + skirtIdxCount;

    const indices = new Uint32Array(totalMaxIdxCount);
    let ii = 0;

    // ── 主网格索引（含极地退化三角形处理）──
    if (isNorthPole) {
        // 北极：第一行所有顶点共享极点位置 → 扇形连接到第二行
        for (let col = 0; col < segments; col++) {
            indices[ii++] = 0;              // 极点（所有列共享同一 ECEF 位置）
            indices[ii++] = n1 + col;       // 第二行左
            indices[ii++] = n1 + col + 1;   // 第二行右
        }
        // 剩余行正常网格（row 1..segments-1）
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
    } else if (isSouthPole) {
        // 南极：正常行在前（row 0..segments-2），最后一行用扇形
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
    } else {
        // 非极地：标准网格，每个四边形拆为 2 个三角形
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

    // ── 裙边索引 ──
    // 绕序规则：裙边三角形的正面必须朝向瓦片外侧，以便从地球外部可见。
    //   顶边/左边：edge[i], skirt[i], edge[i+1]; edge[i+1], skirt[i], skirt[i+1]
    //   底边/右边：edge[i], edge[i+1], skirt[i]; skirt[i], edge[i+1], skirt[i+1]
    // 推导：对每条边，edge→skirt 方向指向球心（inward），沿边缘方向叉积决定法线朝向。
    //   顶边法线朝北、左边法线朝西 → 使用 "正向" 绕序
    //   底边法线朝南、右边法线朝东 → 使用 "反向" 绕序

    if (hasTopSkirt) {
        // 顶边裙边（row=0 的所有列段）：正面朝北（瓦片上方）
        for (let col = 0; col < segments; col++) {
            // 主网格顶边的两个相邻顶点
            const e0 = col;
            const e1 = col + 1;
            // 对应的裙边顶点
            const s0 = skirtTopBase + col;
            const s1 = skirtTopBase + col + 1;
            // 正向绕序：CCW 从北侧（瓦片外侧）观察
            indices[ii++] = e0; indices[ii++] = s0; indices[ii++] = e1;
            indices[ii++] = e1; indices[ii++] = s0; indices[ii++] = s1;
        }
    }

    if (hasBottomSkirt) {
        // 底边裙边（row=segments 的所有列段）：正面朝南（瓦片下方）
        for (let col = 0; col < segments; col++) {
            // 主网格底边的两个相邻顶点
            const e0 = segments * n1 + col;
            const e1 = segments * n1 + col + 1;
            // 对应的裙边顶点
            const s0 = skirtBottomBase + col;
            const s1 = skirtBottomBase + col + 1;
            // 反向绕序：CCW 从南侧（瓦片外侧）观察
            indices[ii++] = e0; indices[ii++] = e1; indices[ii++] = s0;
            indices[ii++] = s0; indices[ii++] = e1; indices[ii++] = s1;
        }
    }

    {
        // 左边裙边（col=0 的所有行段）：正面朝西（瓦片左侧）
        for (let row = 0; row < segments; row++) {
            // 主网格左边的两个相邻顶点（沿纬度方向，从北到南）
            const e0 = row * n1;
            const e1 = (row + 1) * n1;
            // 对应的裙边顶点
            const s0 = skirtLeftBase + row;
            const s1 = skirtLeftBase + row + 1;
            // 正向绕序：CCW 从西侧（瓦片外侧）观察
            indices[ii++] = e0; indices[ii++] = s0; indices[ii++] = e1;
            indices[ii++] = e1; indices[ii++] = s0; indices[ii++] = s1;
        }
    }

    {
        // 右边裙边（col=segments 的所有行段）：正面朝东（瓦片右侧）
        for (let row = 0; row < segments; row++) {
            // 主网格右边的两个相邻顶点
            const e0 = row * n1 + segments;
            const e1 = (row + 1) * n1 + segments;
            // 对应的裙边顶点
            const s0 = skirtRightBase + row;
            const s1 = skirtRightBase + row + 1;
            // 反向绕序：CCW 从东侧（瓦片外侧）观察
            indices[ii++] = e0; indices[ii++] = e1; indices[ii++] = s0;
            indices[ii++] = s0; indices[ii++] = e1; indices[ii++] = s1;
        }
    }

    // 最终索引数 = 主网格 + 裙边
    const totalIndexCount = ii;

    return {
        positions,
        normals,
        uvs,
        indices: indices.slice(0, totalIndexCount),
        vertexCount: totalVertexCount,
        indexCount: totalIndexCount,
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
 * 含裙边顶点——vertexCount 已包含裙边，无需额外处理。
 *
 * @param mesh - 瓦片网格（ECEF Float64 位置，含裙边）
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
// §3.3b RTE 高低精度拆分（EncodedCartesian3 方式）
// ════════════════════════════════════════════════════════════════

/**
 * 将 Globe 瓦片网格从 ECEF 转为 RTE 高低精度拆分格式（EncodedCartesian3）。
 * 每个位置分量拆分为 high + low 两个 Float32，在 GPU 着色器中重组：
 *   position = (posHigh - eyeHigh) + (posLow - eyeLow)
 * 
 * 这种方式避免了大数减法的 Float32 精度丢失，适用于 Intel Arc 等 GPU。
 *
 * 输出交错格式（每顶点 14 个 Float32）：
 *   [highX, highY, highZ, lowX, lowY, lowZ, nx, ny, nz, u, v, pad, pad, pad]
 *
 * @param mesh - 瓦片网格（ECEF Float64 位置）
 * @param camECEF - 相机 ECEF 位置
 * @returns Float32Array 交错顶点数据
 *
 * @example
 * const rte = meshToRTE_HighLow(mesh, camera.cameraECEF);
 */
export function meshToRTE_HighLow(
    mesh: GlobeTileMesh,
    camECEF: [number, number, number],
): Float32Array {
    const n = mesh.vertexCount;
    // 14 floats/vertex: highXYZ(3) + lowXYZ(3) + normal(3) + uv(2) + pad(3)
    const out = new Float32Array(n * 14);
    const cx = camECEF[0], cy = camECEF[1], cz = camECEF[2];

    /**
     * 拆分因子：高位对齐到 SPLIT_FACTOR 的整数倍。
     * 使用 2048 而非 CesiumJS 的 65536，在 ECEF 量级（~6.4×10⁶ m）下
     * 可保证 high 部分约 3120 个离散级别，low 部分 ≤ 2048m → 亚厘米级精度。
     */
    const SPLIT_FACTOR = 2048.0;

    for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const i14 = i * 14;
        const i2 = i * 2;

        // 对每个分量做 high/low 拆分
        for (let axis = 0; axis < 3; axis++) {
            const ecef = mesh.positions[i3 + axis];
            const cam = axis === 0 ? cx : axis === 1 ? cy : cz;

            // high = 对齐到 SPLIT_FACTOR 的倍数（截断到整数倍）
            const posHigh = Math.floor(ecef / SPLIT_FACTOR) * SPLIT_FACTOR;
            // low = 原始值与 high 的差值，必然 |low| < SPLIT_FACTOR
            const posLow = ecef - posHigh;
            const camHigh = Math.floor(cam / SPLIT_FACTOR) * SPLIT_FACTOR;
            const camLow = cam - camHigh;

            // GPU 将计算: (posHigh - camHigh) + (posLow - camLow)
            // 两个减法都在 Float32 安全范围内，避免大数相减精度丢失
            out[i14 + axis] = posHigh - camHigh;      // high part（差值量级 ≤ 数千 km）
            out[i14 + 3 + axis] = posLow - camLow;    // low part（差值量级 ≤ 4096m）
        }

        // 法线直接拷贝（Float32 精度足够）
        out[i14 + 6] = mesh.normals[i3];
        out[i14 + 7] = mesh.normals[i3 + 1];
        out[i14 + 8] = mesh.normals[i3 + 2];

        // UV 纹理坐标
        out[i14 + 9] = mesh.uvs[i2];
        out[i14 + 10] = mesh.uvs[i2 + 1];

        // padding 对齐到 16 字节 (vec4) 边界，确保 GPU 内存访问效率
        out[i14 + 11] = 0;
        out[i14 + 12] = 0;
        out[i14 + 13] = 0;
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
 * 屏幕像素 → 椭球面经纬度（度）。
 * 使用 ECEF 空间的 inverseVP 矩阵构造射线，与椭球体 (x/a)²+(y/a)²+(z/b)²=1 求交。
 *
 * @param sx - 屏幕 x（CSS 像素）
 * @param sy - 屏幕 y（CSS 像素）
 * @param inverseVP_ECEF - 逆 VP 矩阵（ECEF 绝对坐标版）
 * @param vpWidth - 视口宽度
 * @param vpHeight - 视口高度
 * @param ellipsoid - 椭球体参数，默认 WGS84。影响射线-椭球体求交和 ECEF→大地坐标逆转换
 * @returns [lngDeg, latDeg] 或 null（射线不与椭球面相交——太空方向）
 *
 * @example
 * const hit = screenToGlobe(400, 300, camera.inverseVP_ECEF, 800, 600);
 * if (hit) console.log(`Hit at ${hit[0]}°, ${hit[1]}°`);
 *
 * @example
 * // 月球椭球体
 * const MOON: Ellipsoid = { a: 1737400, b: 1737400, e2: 0 };
 * const moonHit = screenToGlobe(400, 300, cam.inverseVP_ECEF, 800, 600, MOON);
 */
export function screenToGlobe(
    sx: number, sy: number,
    inverseVP_ECEF: Float32Array,
    vpWidth: number, vpHeight: number,
    ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
): [number, number] | null {
    // 从椭球体参数计算射线-椭球体求交所需的缩放因子
    // invA2 = 1/a²，invB2 = 1/b²，用于将椭球体方程化为标准二次型
    const invA2 = 1.0 / (ellipsoid.a * ellipsoid.a);
    const invB2 = 1.0 / (ellipsoid.b * ellipsoid.b);

    // 屏幕坐标 → NDC [-1, 1]
    const nx = (sx / vpWidth) * 2 - 1;
    const ny = 1 - (sy / vpHeight) * 2;

    // 反投影到 ECEF 空间：near plane (z=0) 和 far plane (z=1)
    const a4 = mulMat4Vec4(inverseVP_ECEF, nx, ny, 0, 1);
    const b4 = mulMat4Vec4(inverseVP_ECEF, nx, ny, 1, 1);

    // 透视除法：齐次坐标 → 笛卡尔坐标
    // w=0 检查：如果 w 接近零，矩阵可能有问题，返回 null 避免 NaN 扩散
    if (Math.abs(a4[3]) < 1e-15 || Math.abs(b4[3]) < 1e-15) { return null; }
    const near: [number, number, number] = [a4[0] / a4[3], a4[1] / a4[3], a4[2] / a4[3]];
    const far: [number, number, number] = [b4[0] / b4[3], b4[1] / b4[3], b4[2] / b4[3]];

    // 射线方向 = far 点 - near 点
    const dir: [number, number, number] = [
        far[0] - near[0],
        far[1] - near[1],
        far[2] - near[2],
    ];

    // 射线-椭球体求交：(x/a)² + (y/a)² + (z/b)² = 1
    // 参数化射线 P(t) = near + t·dir
    // 代入得 A·t² + B·t + C = 0
    const A = dir[0] * dir[0] * invA2
            + dir[1] * dir[1] * invA2
            + dir[2] * dir[2] * invB2;

    const B = 2 * (
        near[0] * dir[0] * invA2
        + near[1] * dir[1] * invA2
        + near[2] * dir[2] * invB2
    );

    const C = near[0] * near[0] * invA2
            + near[1] * near[1] * invA2
            + near[2] * near[2] * invB2
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

    // ECEF → 大地坐标（Bowring 简化迭代，精度 <1m 足够用于瓦片选择）
    const lngRad = Math.atan2(hitY, hitX);
    const p = Math.sqrt(hitX * hitX + hitY * hitY);
    // 初始近似纬度
    let latRad = Math.atan2(hitZ, p * (1 - ellipsoid.e2));
    // 两次 Bowring 迭代（精度 < 1m）
    for (let i = 0; i < 2; i++) {
        const sinLat = Math.sin(latRad);
        // 卯酉圈曲率半径 N 使用参数化椭球体的 a 和 e2
        const N = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinLat * sinLat);
        latRad = Math.atan2(hitZ + ellipsoid.e2 * N * sinLat, p);
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
 * @param ellipsoid - 椭球体参数，默认 WGS84。影响瓦片中心 ECEF 和地平线余量
 * @returns true = 可见（在地平线之上或部分跨越）
 *
 * @example
 * const visible = isTileVisible_Horizon(3, 2, 4, camera.cameraECEF);
 * if (!visible) { /* 背面瓦片，跳过渲染 *\/ }
 */
export function isTileVisible_Horizon(
    tx: number, ty: number, tz: number,
    camECEF: [number, number, number],
    ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
): boolean {
    const numTiles = 1 << tz;
    // 瓦片中心经纬度（度）
    const lngDeg = (tx + 0.5) / numTiles * 360 - 180;
    const latDeg = tileYToLat(ty + 0.5, tz);

    const lngRad = lngDeg * DEG2RAD;
    const latRad = latDeg * DEG2RAD;

    // 使用参数化椭球体计算瓦片中心 ECEF
    localGeodeticToECEF(_ecefBuf, lngRad, latRad, 0, ellipsoid);

    // 椭球面法线（球面近似，不依赖椭球体参数）
    surfaceNormal(_normalBuf, lngRad, latRad);

    // 相机到瓦片的向量
    const camToTileX = _ecefBuf[0] - camECEF[0];
    const camToTileY = _ecefBuf[1] - camECEF[1];
    const camToTileZ = _ecefBuf[2] - camECEF[2];

    // 点积：camToTile · normal < 0 表示法线朝向相机 → 可见
    const dot = camToTileX * _normalBuf[0]
              + camToTileY * _normalBuf[1]
              + camToTileZ * _normalBuf[2];

    // 大瓦片的角半径余量（瓦片边缘可能跨越地平线）
    // tileAngularRadius ≈ π / numTiles（一个瓦片覆盖的角度）
    const tileAngularRadius = PI / numTiles;
    // margin = sin(角半径) × 椭球体赤道半径，使用参数化椭球体的 a
    const margin = Math.sin(tileAngularRadius) * ellipsoid.a;

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
    // 防御除零：平面法线长度不应为零，但退化矩阵可能导致此情况
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

    // 包围球中心转为 RTE 坐标（Float64 减法保持精度）
    const cx = bsCenter[0] - camECEF[0];
    const cy = bsCenter[1] - camECEF[1];
    const cz = bsCenter[2] - camECEF[2];

    for (let pi = 0; pi < planes.length; pi++) {
        const p = planes[pi];
        // 有符号距离：正值 = 在平面内侧，负值 = 在平面外侧
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
 * 自动从 camera.ellipsoid 读取椭球体参数（默认 WGS84），
 * 传递给 screenToGlobe 和 isTileVisible_Horizon。
 *
 * @param camera - Globe 相机状态（含可选 ellipsoid 字段）
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

    // 从相机状态提取椭球体（默认 WGS84）
    const ell = camera.ellipsoid ?? WGS84_ELLIPSOID;

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

    // 投射到椭球面（使用参数化椭球体）
    const hits: [number, number][] = [];
    for (let pi = 0; pi < pts.length; pi++) {
        const hit = screenToGlobe(
            pts[pi][0], pts[pi][1],
            camera.inverseVP_ECEF,
            W, H,
            ell,
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
    let minTY = Math.max(0, Math.floor(latToTileY(mxLat, tileZoom)));
    let maxTY = Math.min(numTiles - 1, Math.ceil(latToTileY(mnLat, tileZoom)));

    // ── P1 #5: Polar EPSG:4326 tile coverage ──
    // WebMercator is undefined beyond ±85.05°. When the camera can see polar regions,
    // extend tile range to cover rows 0 (north pole) and numTiles-1 (south pole).
    // The tile geometry (tessellateGlobeTile) already handles polar fan triangles.
    const MERCATOR_LAT_LIMIT = 85.05;
    if (mxLat > MERCATOR_LAT_LIMIT || camera.altitude > 5_000_000) {
        // Camera can see north pole region → include row 0
        minTY = 0;
    }
    if (mnLat < -MERCATOR_LAT_LIMIT || camera.altitude > 5_000_000) {
        // Camera can see south pole region → include last row
        maxTY = numTiles - 1;
    }

    // ═══ 步骤 3：枚举 + Horizon Cull + LOD ═══
    const [clng, clat] = camera.center;
    const clngRad = clng * DEG2RAD;
    const clatRad = clat * DEG2RAD;

    const seen = new Set<string>();
    const tiles: GlobeTileID[] = [];

    for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
            // Horizon Cull：背面瓦片跳过（使用参数化椭球体）
            if (!isTileVisible_Horizon(x, y, tileZoom, camera.cameraECEF, ell)) {
                continue;
            }

            // 瓦片中心经纬度
            const tlng = (x + 0.5) / numTiles * 360 - 180;
            const tlat = tileYToLat(y + 0.5, tileZoom);

            // 与相机注视点的大圆距离（haversineDistance 内部用 WGS84_A，对非 WGS84 有微小偏差，
            // 但此距离仅用于 LOD 排序，不影响正确性）
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
 * @param ellipsoid - 椭球体参数，默认 WGS84。影响 3D 球面坐标的 ECEF 计算
 * @returns Float32Array 交错顶点数据
 *
 * @example
 * const morphVerts = computeMorphVertices(4, 8, 5, 16, worldSize, center, camECEF);
 * device.queue.writeBuffer(morphBuffer, 0, morphVerts);
 */
export function computeMorphVertices(
    tileZ: number, tileX: number, tileY: number,
    segments: number,
    worldSize2D: number,
    centerWorld2D: [number, number],
    camECEF: [number, number, number],
    ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
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
            // Mercator Y 投影公式：y = 0.5 - ln((1+sinφ)/(1-sinφ))/(4π)
            const my = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * PI)) * worldSize2D - centerWorld2D[1];
            out[idx] = mx;
            out[idx + 1] = my;
            out[idx + 2] = 0;

            // 3D RTE 坐标（ECEF - 相机 ECEF），使用参数化椭球体
            localGeodeticToECEF(_ecefBuf, lngRad, latRad, 0, ellipsoid);
            out[idx + 3] = _ecefBuf[0] - camECEF[0];
            out[idx + 4] = _ecefBuf[1] - camECEF[1];
            out[idx + 5] = _ecefBuf[2] - camECEF[2];

            // 法线（球面近似，不依赖椭球体参数）
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
