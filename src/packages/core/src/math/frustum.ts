// ============================================================
// math/frustum.ts — 视锥体（View Frustum）6 平面提取 + 相交测试
// 每个平面用 Vec4f [a, b, c, d] 表示，满足 ax + by + cz + d = 0
// 法线 [a, b, c] 指向视锥体内部
// 用于 CPU 端粗粒度剔除（瓦片、图层 AABB、球体）
// ============================================================

import type { BBox2D, BBox3D } from './bbox.ts';

/** Float32 四维向量（用于表示平面方程 [a,b,c,d]） */
export type Vec4f = Float32Array;

/** Float32 三维向量 */
export type Vec3f = Float32Array;

/** Float32 4x4 矩阵（列主序） */
export type Mat4f = Float32Array;

/** 视锥体 6 个裁剪平面的索引常量 */
const PLANE_LEFT = 0;
const PLANE_RIGHT = 1;
const PLANE_BOTTOM = 2;
const PLANE_TOP = 3;
const PLANE_NEAR = 4;
const PLANE_FAR = 5;

/** 视锥体由 6 个平面组成，每个平面是 Vec4f [a, b, c, d] */
export type Frustum = Vec4f[];

/**
 * 将平面方程归一化（使法线 [a,b,c] 成为单位向量）。
 * 归一化后 d 分量的绝对值等于原点到平面的距离。
 * 这使得后续的距离判断结果为真实的欧几里得距离。
 *
 * @param plane - 平面 [a, b, c, d]（就地修改）
 * @returns plane 引用
 *
 * @example
 * const p = new Float32Array([2, 0, 0, 10]);
 * normalizePlane(p); // p = [1, 0, 0, 5]
 */
export function normalizePlane(plane: Vec4f): Vec4f {
    // 法线长度
    const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
    if (len > 1e-8) {
        // 整体除以法线长度（包括 d 分量）
        const invLen = 1.0 / len;
        plane[0] *= invLen;
        plane[1] *= invLen;
        plane[2] *= invLen;
        plane[3] *= invLen;
    }
    return plane;
}

/**
 * 从 4x4 视图-投影矩阵（VP）中提取 6 个视锥体裁剪平面。
 * 使用 Gribb/Hartmann 方法：将 VP 矩阵的行组合得到各平面方程。
 * 所有平面自动归一化。
 *
 * 平面顺序：[left, right, bottom, top, near, far]
 * 法线方向指向视锥体内部。
 *
 * VP 矩阵为列主序，按行访问时索引映射：
 *   row0 = [m[0], m[4], m[8],  m[12]]
 *   row1 = [m[1], m[5], m[9],  m[13]]
 *   row2 = [m[2], m[6], m[10], m[14]]
 *   row3 = [m[3], m[7], m[11], m[15]]
 *
 * @param vp - 4x4 视图-投影矩阵（列主序）
 * @returns 6 个归一化平面的数组 [left, right, bottom, top, near, far]
 *
 * @example
 * const planes = extractPlanes(vpMatrix);
 * // planes[0] = left plane, planes[5] = far plane
 */
export function extractPlanes(vp: Mat4f): Frustum {
    // 分配 6 个平面（每帧调用一次，可接受分配开销）
    const planes: Frustum = [];
    for (let i = 0; i < 6; i++) {
        planes.push(new Float32Array(4));
    }

    // 提取矩阵行（列主序中按步长 4 跳跃读取）
    // row3 对应齐次裁剪空间的 w 分量
    const r3x = vp[3], r3y = vp[7], r3z = vp[11], r3w = vp[15];
    const r0x = vp[0], r0y = vp[4], r0z = vp[8], r0w = vp[12];
    const r1x = vp[1], r1y = vp[5], r1z = vp[9], r1w = vp[13];
    const r2x = vp[2], r2y = vp[6], r2z = vp[10], r2w = vp[14];

    // Left: row3 + row0（-w < x 的边界）
    planes[PLANE_LEFT][0] = r3x + r0x;
    planes[PLANE_LEFT][1] = r3y + r0y;
    planes[PLANE_LEFT][2] = r3z + r0z;
    planes[PLANE_LEFT][3] = r3w + r0w;
    normalizePlane(planes[PLANE_LEFT]);

    // Right: row3 - row0（x < w 的边界）
    planes[PLANE_RIGHT][0] = r3x - r0x;
    planes[PLANE_RIGHT][1] = r3y - r0y;
    planes[PLANE_RIGHT][2] = r3z - r0z;
    planes[PLANE_RIGHT][3] = r3w - r0w;
    normalizePlane(planes[PLANE_RIGHT]);

    // Bottom: row3 + row1（-w < y 的边界）
    planes[PLANE_BOTTOM][0] = r3x + r1x;
    planes[PLANE_BOTTOM][1] = r3y + r1y;
    planes[PLANE_BOTTOM][2] = r3z + r1z;
    planes[PLANE_BOTTOM][3] = r3w + r1w;
    normalizePlane(planes[PLANE_BOTTOM]);

    // Top: row3 - row1（y < w 的边界）
    planes[PLANE_TOP][0] = r3x - r1x;
    planes[PLANE_TOP][1] = r3y - r1y;
    planes[PLANE_TOP][2] = r3z - r1z;
    planes[PLANE_TOP][3] = r3w - r1w;
    normalizePlane(planes[PLANE_TOP]);

    // Near: row2（WebGPU NDC z ∈ [0,1]，所以近平面 = row2 而非 row3+row2）
    planes[PLANE_NEAR][0] = r2x;
    planes[PLANE_NEAR][1] = r2y;
    planes[PLANE_NEAR][2] = r2z;
    planes[PLANE_NEAR][3] = r2w;
    normalizePlane(planes[PLANE_NEAR]);

    // Far: row3 - row2（z < w → z < 1 映射）
    planes[PLANE_FAR][0] = r3x - r2x;
    planes[PLANE_FAR][1] = r3y - r2y;
    planes[PLANE_FAR][2] = r3z - r2z;
    planes[PLANE_FAR][3] = r3w - r2w;
    normalizePlane(planes[PLANE_FAR]);

    return planes;
}

/**
 * 测试轴对齐包围盒（AABB）是否与视锥体相交。
 * 使用"正顶点/负顶点"优化：对每个平面只测试 AABB 离平面最远的角点。
 *
 * 支持 BBox2D（z 范围默认 [-Infinity, Infinity]）和 BBox3D。
 *
 * @param planes - 视锥体的 6 个归一化平面
 * @param bbox - 轴对齐包围盒
 * @returns true 表示可能可见（相交或包含），false 表示完全在视锥体外
 *
 * @example
 * const visible = intersectsBBox(frustumPlanes, tileBBox);
 * if (!visible) skipRendering(tile);
 */
export function intersectsBBox(planes: Frustum, bbox: BBox2D | BBox3D): boolean {
    // 确定 Z 范围：BBox3D 有 minAlt/maxAlt，BBox2D 默认全范围
    const minZ = 'minAlt' in bbox ? bbox.minAlt : -1e10;
    const maxZ = 'maxAlt' in bbox ? bbox.maxAlt : 1e10;

    // 提取 AABB 的 min/max（与视锥体平面法线方向对齐使用）
    const minX = bbox.west;
    const maxX = bbox.east;
    const minY = bbox.south;
    const maxY = bbox.north;

    // 对每个平面执行"正顶点"测试
    for (let i = 0; i < 6; i++) {
        const plane = planes[i];
        const a = plane[0], b = plane[1], c = plane[2], d = plane[3];

        // 正顶点（p-vertex）：在法线方向上离平面最远的 AABB 角点
        // 如果法线分量为正则取 max，否则取 min
        const px = a >= 0 ? maxX : minX;
        const py = b >= 0 ? maxY : minY;
        const pz = c >= 0 ? maxZ : minZ;

        // 若正顶点在平面负侧（距离 < 0），则 AABB 完全在该平面外
        if (a * px + b * py + c * pz + d < 0) {
            return false;
        }
    }

    // 所有平面测试通过，AABB 至少部分可见
    return true;
}

/**
 * 测试球体是否与视锥体相交。
 * 对每个平面计算球心到平面的有符号距离，若距离 < -radius 则球体完全在外。
 *
 * @param planes - 视锥体的 6 个归一化平面
 * @param center - 球心坐标 [x, y, z]
 * @param radius - 球体半径（正值）
 * @returns true 表示球体可能可见
 *
 * @example
 * const visible = intersectsSphere(frustumPlanes, [0, 0, 0], 100);
 */
export function intersectsSphere(planes: Frustum, center: Vec3f, radius: number): boolean {
    const cx = center[0], cy = center[1], cz = center[2];

    for (let i = 0; i < 6; i++) {
        const plane = planes[i];
        // 球心到平面的有符号距离（归一化平面下等于欧几里得距离）
        const dist = plane[0] * cx + plane[1] * cy + plane[2] * cz + plane[3];
        // 若球心在平面外侧超过半径距离，则球体完全不可见
        if (dist < -radius) {
            return false;
        }
    }

    // 所有平面测试通过
    return true;
}

/**
 * 测试一个 3D 点是否在视锥体内。
 *
 * @param planes - 视锥体的 6 个归一化平面
 * @param point - 3D 点坐标 [x, y, z]
 * @returns true 表示点在视锥体内或边界上
 *
 * @example
 * const inside = containsPoint(frustumPlanes, [10, 20, 30]);
 */
export function containsPoint(planes: Frustum, point: Vec3f): boolean {
    const px = point[0], py = point[1], pz = point[2];

    for (let i = 0; i < 6; i++) {
        const plane = planes[i];
        // 点到平面的有符号距离
        const dist = plane[0] * px + plane[1] * py + plane[2] * pz + plane[3];
        // 若点在任一平面的外侧，则不在视锥体内
        if (dist < 0) {
            return false;
        }
    }

    // 所有平面测试通过，点在视锥体内
    return true;
}
