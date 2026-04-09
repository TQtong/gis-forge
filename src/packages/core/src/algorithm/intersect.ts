// ============================================================
// algorithm/intersect.ts — 几何相交检测（自研实现）
// 提供线段-线段、射线-AABB、包围盒重叠检测。
// 所有算法零外部依赖，完整处理退化和边界情况。
// ============================================================

import type { BBox2D } from '../types/tile.ts';

/**
 * 线段-线段相交检测结果。
 * 包含交点坐标和两条线段上的参数值 t、u。
 */
export interface SegmentIntersection {
    /** 交点 x 坐标 */
    readonly x: number;

    /** 交点 y 坐标 */
    readonly y: number;

    /** 第一条线段上的参数 t ∈ [0, 1]，表示交点位置：P = P1 + t * (P2 - P1) */
    readonly t: number;

    /** 第二条线段上的参数 u ∈ [0, 1]，表示交点位置：P = P3 + u * (P4 - P3) */
    readonly u: number;
}

/**
 * 计算两条线段的交点。
 * 使用参数方程法：P = P1 + t*(P2-P1), Q = P3 + u*(P4-P3)，
 * 解线性方程组求 t 和 u。当 t、u 均在 [0,1] 内时线段相交。
 *
 * 处理的特殊情况：
 * - 平行线段（行列式为 0）→ 返回 null
 * - 共线线段（即使有重叠部分）→ 返回 null（不返回重叠段）
 * - 端点相交 → 正常返回交点
 *
 * @param x1 - 第一条线段起点 x
 * @param y1 - 第一条线段起点 y
 * @param x2 - 第一条线段终点 x
 * @param y2 - 第一条线段终点 y
 * @param x3 - 第二条线段起点 x
 * @param y3 - 第二条线段起点 y
 * @param x4 - 第二条线段终点 x
 * @param y4 - 第二条线段终点 y
 * @returns 交点信息，或 null（不相交/平行/共线）
 *
 * @example
 * // 十字交叉
 * segmentSegment(0,0, 2,2, 0,2, 2,0);
 * // → { x: 1, y: 1, t: 0.5, u: 0.5 }
 *
 * @example
 * // 平行线段
 * segmentSegment(0,0, 1,0, 0,1, 1,1); // → null
 */
export function segmentSegment(
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    x4: number, y4: number,
): SegmentIntersection | null {
    // NaN 检查：任何坐标为 NaN 时无法计算
    if (
        x1 !== x1 || y1 !== y1 || x2 !== x2 || y2 !== y2 ||
        x3 !== x3 || y3 !== y3 || x4 !== x4 || y4 !== y4
    ) {
        return null;
    }

    // 线段方向向量
    const d1x = x2 - x1;
    const d1y = y2 - y1;
    const d2x = x4 - x3;
    const d2y = y4 - y3;

    // 行列式（叉积）：det = d1 × d2
    // 如果行列式为 0，两条线段平行或共线
    const denom = d1x * d2y - d1y * d2x;

    // 使用相对容差来判断行列式是否为零
    // 绝对容差在大坐标下不可靠，所以用线段长度的乘积来归一化
    const lenSq1 = d1x * d1x + d1y * d1y;
    const lenSq2 = d2x * d2x + d2y * d2y;
    const lenProduct = Math.sqrt(lenSq1 * lenSq2);

    // 当行列式远小于线段长度乘积时，认为平行
    if (Math.abs(denom) < 1e-12 * Math.max(1.0, lenProduct)) {
        return null;
    }

    // 起点差向量
    const dx = x3 - x1;
    const dy = y3 - y1;

    // 求参数 t 和 u
    // t = (dx × d2) / (d1 × d2)
    const t = (dx * d2y - dy * d2x) / denom;
    // u = (dx × d1) / (d1 × d2)
    const u = (dx * d1y - dy * d1x) / denom;

    // t 和 u 都在 [0, 1] 内时线段相交
    if (t < 0 || t > 1 || u < 0 || u > 1) {
        return null;
    }

    // 计算交点坐标
    return {
        x: x1 + t * d1x,
        y: y1 + t * d1y,
        t,
        u,
    };
}

/**
 * 射线与轴对齐包围盒（AABB）的相交检测。
 * 使用 slab method（平板法）：对每个轴计算射线进入和离开平板的参数 t，
 * 取所有轴进入时间的最大值和离开时间的最小值。
 *
 * 射线表示为 P(t) = origin + t * direction, t >= 0。
 *
 * @param originX - 射线起点 x
 * @param originY - 射线起点 y
 * @param originZ - 射线起点 z
 * @param dirX - 射线方向 x（无需归一化）
 * @param dirY - 射线方向 y
 * @param dirZ - 射线方向 z
 * @param minX - AABB 最小角 x
 * @param minY - AABB 最小角 y
 * @param minZ - AABB 最小角 z
 * @param maxX - AABB 最大角 x
 * @param maxY - AABB 最大角 y
 * @param maxZ - AABB 最大角 z
 * @returns 射线参数 t（>= 0 表示相交，交点 = origin + t*dir），-1 表示不相交
 *
 * @example
 * // 射线从原点沿 +z 方向射向 z=5 到 z=10 的盒子
 * rayAABB(0,0,0, 0,0,1, -1,-1,5, 1,1,10);
 * // → 5（在 z=5 处进入盒子）
 *
 * @example
 * // 射线方向与盒子平行，不相交
 * rayAABB(0,0,0, 1,0,0, 2,2,2, 3,3,3); // → -1
 */
export function rayAABB(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
): number {
    // 零方向向量：射线没有方向，不可能相交
    if (dirX === 0 && dirY === 0 && dirZ === 0) {
        return -1;
    }

    // 初始化 tMin 和 tMax
    let tMin = -Infinity;
    let tMax = Infinity;

    // X 轴平板
    if (Math.abs(dirX) < 1e-30) {
        // 方向在 X 轴上为零：射线平行于 X 平板
        // 如果起点不在 X 范围内，不可能相交
        if (originX < minX || originX > maxX) {
            return -1;
        }
    } else {
        // 计算射线与 X 平板的进入/离开参数
        const invDirX = 1.0 / dirX;
        let t1 = (minX - originX) * invDirX;
        let t2 = (maxX - originX) * invDirX;

        // 确保 t1 <= t2（方向可能为负）
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }

        // 更新全局区间
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);

        // 区间无效则不相交
        if (tMin > tMax) return -1;
    }

    // Y 轴平板（逻辑同 X）
    if (Math.abs(dirY) < 1e-30) {
        if (originY < minY || originY > maxY) {
            return -1;
        }
    } else {
        const invDirY = 1.0 / dirY;
        let t1 = (minY - originY) * invDirY;
        let t2 = (maxY - originY) * invDirY;
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return -1;
    }

    // Z 轴平板（逻辑同 X）
    if (Math.abs(dirZ) < 1e-30) {
        if (originZ < minZ || originZ > maxZ) {
            return -1;
        }
    } else {
        const invDirZ = 1.0 / dirZ;
        let t1 = (minZ - originZ) * invDirZ;
        let t2 = (maxZ - originZ) * invDirZ;
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return -1;
    }

    // tMax < 0 表示盒子在射线起点后方
    if (tMax < 0) {
        return -1;
    }

    // tMin >= 0 表示射线从盒子外部进入
    // tMin < 0 表示射线起点在盒子内部，此时返回 0（立即相交）
    return tMin >= 0 ? tMin : 0;
}

/**
 * 检测两个 2D 轴对齐包围盒（BBox2D）是否重叠。
 * 使用分离轴定理的简化版本：如果在任何轴上两个盒子没有重叠，则不相交。
 *
 * BBox2D 使用 { west, south, east, north } 格式（与 GIS-Forge 类型定义一致）。
 *
 * @param a - 第一个包围盒 { west, south, east, north }
 * @param b - 第二个包围盒 { west, south, east, north }
 * @returns 两个包围盒是否重叠（含边界相切）
 *
 * @example
 * const a = { west: 0, south: 0, east: 4, north: 4 };
 * const b = { west: 2, south: 2, east: 6, north: 6 };
 * bboxOverlap(a, b); // → true（部分重叠）
 *
 * @example
 * const a = { west: 0, south: 0, east: 1, north: 1 };
 * const b = { west: 2, south: 2, east: 3, north: 3 };
 * bboxOverlap(a, b); // → false（完全分离）
 */
export function bboxOverlap(a: BBox2D, b: BBox2D): boolean {
    // 空包围盒检查：如果 east < west 或 north < south，视为空盒
    if (a.east < a.west || a.north < a.south) {
        return false;
    }
    if (b.east < b.west || b.north < b.south) {
        return false;
    }

    // 分离轴检测：如果在任何轴上不重叠，则不相交
    // X 轴（west-east）
    if (a.east < b.west || b.east < a.west) {
        return false;
    }

    // Y 轴（south-north）
    if (a.north < b.south || b.north < a.south) {
        return false;
    }

    // 两个轴都有重叠
    return true;
}

/**
 * 射线-三角形相交结果。
 */
export interface RayTriangleHit {
    /** 沿射线方向的参数距离，hitPoint = origin + t * dir */
    readonly t: number;
    /** 重心坐标 u（对应顶点 v1 的权重） */
    readonly u: number;
    /** 重心坐标 v（对应顶点 v2 的权重） */
    readonly v: number;
}

/**
 * Möller-Trumbore 射线-三角形相交算法。
 *
 * 不需要预先计算三角形平面方程，对每个三角形只用 1 次叉积 + 4 次点积。
 * 是 3D Picking、BVH 遍历、LIDAR 与 Mesh 交互等场景的核心算法。
 *
 * 退化处理：
 * - 三角形退化（面积 0）→ 行列式接近 0 → 返回 null
 * - 射线与三角形平面平行 → 返回 null
 * - 仅返回 t ≥ 0 的命中（射线起点之前的命中视为未命中）
 *
 * 注：默认双面命中（不做背面剔除）。需要单面命中时调用方判断 det 符号。
 *
 * @param ox 射线起点 x
 * @param oy 射线起点 y
 * @param oz 射线起点 z
 * @param dx 射线方向 x（无需归一化，但 t 的物理含义会随之变化）
 * @param dy 射线方向 y
 * @param dz 射线方向 z
 * @param v0x 三角形顶点 0 x
 * @param v0y 三角形顶点 0 y
 * @param v0z 三角形顶点 0 z
 * @param v1x 三角形顶点 1 x
 * @param v1y 三角形顶点 1 y
 * @param v1z 三角形顶点 1 z
 * @param v2x 三角形顶点 2 x
 * @param v2y 三角形顶点 2 y
 * @param v2z 三角形顶点 2 z
 * @returns 命中信息或 null
 */
export function rayTriangle(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    v0x: number, v0y: number, v0z: number,
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
): RayTriangleHit | null {
    // NaN 防御
    if (
        ox !== ox || oy !== oy || oz !== oz ||
        dx !== dx || dy !== dy || dz !== dz
    ) {
        return null;
    }

    // 边向量 e1 = v1 - v0, e2 = v2 - v0
    const e1x = v1x - v0x;
    const e1y = v1y - v0y;
    const e1z = v1z - v0z;

    const e2x = v2x - v0x;
    const e2y = v2y - v0y;
    const e2z = v2z - v0z;

    // p = dir × e2
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;

    // 行列式 det = e1 · p
    const det = e1x * px + e1y * py + e1z * pz;

    // 行列式接近 0 → 射线与三角形平行（或三角形退化）
    if (det > -1e-12 && det < 1e-12) {
        return null;
    }

    const invDet = 1.0 / det;

    // t-vector: tvec = origin - v0
    const tvx = ox - v0x;
    const tvy = oy - v0y;
    const tvz = oz - v0z;

    // 重心坐标 u = (tvec · p) * invDet
    const u = (tvx * px + tvy * py + tvz * pz) * invDet;
    if (u < 0 || u > 1) {
        return null;
    }

    // q = tvec × e1
    const qx = tvy * e1z - tvz * e1y;
    const qy = tvz * e1x - tvx * e1z;
    const qz = tvx * e1y - tvy * e1x;

    // 重心坐标 v = (dir · q) * invDet
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) {
        return null;
    }

    // 沿射线的距离 t = (e2 · q) * invDet
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;

    // 仅接受射线正方向的命中
    if (t < 0) {
        return null;
    }

    return { t, u, v };
}

/**
 * 平面-球体相交关系常量。
 *  1 → 球体完全在平面正面（n·p + d > r）
 * -1 → 球体完全在平面背面（n·p + d < -r）
 *  0 → 球体与平面相交
 */
export const PlaneSphereRelation = {
    FRONT: 1 as const,
    BACK: -1 as const,
    INTERSECTING: 0 as const,
} as const;

export type PlaneSphereRelation = 1 | -1 | 0;

/**
 * 射线-OBB（有向包围盒）相交检测。
 *
 * 算法：把射线从世界坐标变换到 OBB 的局部坐标系，再用 Slab 法
 * 与 OBB 的等效 AABB（中心在原点、半边长为 halfX/Y/Z）求交。
 * 局部变换 = 平移到 OBB 中心 + 用三个轴向量做正交投影。
 *
 * 三个轴向量必须两两正交且为单位向量；调用方负责保证。
 *
 * 用途：3D 模型 Picking、相机碰撞、3D Tiles 选择性命中。
 *
 * @param ox 射线起点 x
 * @param oy 射线起点 y
 * @param oz 射线起点 z
 * @param dx 射线方向 x
 * @param dy 射线方向 y
 * @param dz 射线方向 z
 * @param cx OBB 中心 x
 * @param cy OBB 中心 y
 * @param cz OBB 中心 z
 * @param uxX OBB X 轴 x 分量（单位向量）
 * @param uxY OBB X 轴 y 分量
 * @param uxZ OBB X 轴 z 分量
 * @param uyX OBB Y 轴 x 分量
 * @param uyY OBB Y 轴 y 分量
 * @param uyZ OBB Y 轴 z 分量
 * @param uzX OBB Z 轴 x 分量
 * @param uzY OBB Z 轴 y 分量
 * @param uzZ OBB Z 轴 z 分量
 * @param hx OBB X 半边长
 * @param hy OBB Y 半边长
 * @param hz OBB Z 半边长
 * @returns 沿射线的入射 t（≥0），未命中返回 -1
 */
export function rayOBB(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    cx: number, cy: number, cz: number,
    uxX: number, uxY: number, uxZ: number,
    uyX: number, uyY: number, uyZ: number,
    uzX: number, uzY: number, uzZ: number,
    hx: number, hy: number, hz: number,
): number {
    // 射线起点相对于 OBB 中心的偏移
    const px = ox - cx;
    const py = oy - cy;
    const pz = oz - cz;

    // 把起点投影到 OBB 局部坐标
    const localOx = px * uxX + py * uxY + pz * uxZ;
    const localOy = px * uyX + py * uyY + pz * uyZ;
    const localOz = px * uzX + py * uzY + pz * uzZ;

    // 把方向也投影到 OBB 局部坐标
    const localDx = dx * uxX + dy * uxY + dz * uxZ;
    const localDy = dx * uyX + dy * uyY + dz * uyZ;
    const localDz = dx * uzX + dy * uzY + dz * uzZ;

    // 复用 rayAABB 的 Slab 思路
    return rayAABB(
        localOx, localOy, localOz,
        localDx, localDy, localDz,
        -hx, -hy, -hz,
        hx, hy, hz,
    );
}

/**
 * 平面-球体相交检测。
 *
 * 平面方程形式：n · p + d = 0，其中 (nx,ny,nz) 必须是单位法向量。
 * 计算球心到平面的有符号距离 dist = n · center + d，再与半径比较：
 *   dist > r  → 球体在平面正面
 *   dist < -r → 球体在平面背面
 *   否则      → 相交
 *
 * 用途：视锥剔除（每个面单独判断）、球体切割（半空间裁剪）、地球可见半球计算。
 *
 * @param nx 平面法向量 x（需为单位向量）
 * @param ny 平面法向量 y
 * @param nz 平面法向量 z
 * @param d 平面常数项（n·p + d = 0）
 * @param cx 球心 x
 * @param cy 球心 y
 * @param cz 球心 z
 * @param r 球半径（必须 ≥ 0）
 * @returns 相交关系（FRONT/BACK/INTERSECTING）
 */
export function planeSphere(
    nx: number, ny: number, nz: number, d: number,
    cx: number, cy: number, cz: number, r: number,
): PlaneSphereRelation {
    const dist = nx * cx + ny * cy + nz * cz + d;
    if (dist > r) {
        return PlaneSphereRelation.FRONT;
    }
    if (dist < -r) {
        return PlaneSphereRelation.BACK;
    }
    return PlaneSphereRelation.INTERSECTING;
}
