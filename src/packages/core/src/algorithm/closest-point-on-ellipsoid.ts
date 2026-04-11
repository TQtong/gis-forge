// ============================================================
// algorithm/closest-point-on-ellipsoid.ts — 任意 3D 点到椭球面最近点
//
// 给定 ECEF 坐标系下任意 3D 点 P，求它在 WGS84 椭球面（轴对齐于原点）上
// 的最近点 Q。该问题等价于：
//
//   minimize  |P - Q|²
//   subject to  Qx²/a² + Qy²/a² + Qz²/b² = 1
//
// 这是一个二次约束的优化问题。常用做法：
//   • 解析方法（需要解六次方程）— 数值不稳定；
//   • 牛顿迭代在 (lat, lon) 上 — 简单但收敛较慢；
//   • Bowring 1985 / Heikkinen 1982 闭式 ECEF→geodetic 转换法 — 给出
//     geodetic 高度（即 P 到椭球的有向距离），高度=0 即是最近点。
//
// 本实现采用 **Heikkinen 闭式法**：精度 < 0.1 mm，无需迭代，对全部输入
// 稳定。详见：
//
//   Heikkinen, M. (1982). "Geschlossene formeln zur berechnung räumlicher
//   geodätischer koordinaten aus rechtwinkligen koordinaten."
//   Zeitschrift für Vermessungswesen 107: 207-211.
//
// 步骤：
//   1. 由 ECEF (x,y,z) 用 Heikkinen 计算大地坐标 (lon, lat, h)；
//   2. 将 h 设为 0，再 geodeticToECEF 得到椭球面上的 Q；
//   3. P-Q 即沿椭球外法线的 ±h 偏移。
// ============================================================

import {
    WGS84_A,
    WGS84_B,
    WGS84_E2,
    geodeticToECEF,
} from '../geo/ellipsoid.ts';

const EPS = 1e-12;

/** 输出：椭球面上的最近点 + 与 P 的有向距离（外正内负） */
export interface ClosestPointOnEllipsoid {
    /** 椭球面最近点 ECEF 坐标 [x, y, z]（米） */
    readonly point: [number, number, number];
    /** P 的大地纬度（弧度） */
    readonly latitude: number;
    /** P 的大地经度（弧度） */
    readonly longitude: number;
    /** 有向高度：> 0 椭球外侧，< 0 椭球内侧（米） */
    readonly height: number;
}

/**
 * 求 ECEF 坐标系下点 P 到 WGS84 椭球面的最近点。
 *
 * @param px - P 的 ECEF X（米）
 * @param py - P 的 ECEF Y（米）
 * @param pz - P 的 ECEF Z（米）
 * @returns ClosestPointOnEllipsoid
 *
 * @example
 * // 北京上空 1000 m
 * const r = closestPointOnEllipsoid(-2178880, 4388300, 4069390);
 * // r.point ≈ ECEF of (39.9°N, 116.4°E, 0)
 * // r.height ≈ 1000
 */
export function closestPointOnEllipsoid(
    px: number, py: number, pz: number,
): ClosestPointOnEllipsoid {
    // ── Heikkinen 闭式法 ──
    const a = WGS84_A;
    const b = WGS84_B;
    const a2 = a * a;
    const b2 = b * b;
    const e2 = WGS84_E2;
    const ep2 = (a2 - b2) / b2;

    const p = Math.sqrt(px * px + py * py);

    // 极轴退化情形
    if (p < EPS) {
        const sign = pz >= 0 ? 1 : -1;
        return {
            point: [0, 0, sign * b],
            latitude: sign * Math.PI / 2,
            longitude: 0,
            height: Math.abs(pz) - b,
        };
    }

    const F = 54 * b2 * pz * pz;
    const G = p * p + (1 - e2) * pz * pz - e2 * (a2 - b2);
    const c = (e2 * e2 * F * p * p) / (G * G * G);
    const sCube = 1 + c + Math.sqrt(c * c + 2 * c);
    const s = Math.cbrt(sCube);
    const k = s + 1 + 1 / s;
    const P_ = F / (3 * k * k * G * G);
    const Q = Math.sqrt(1 + 2 * e2 * e2 * P_);
    const r0 = -(P_ * e2 * p) / (1 + Q)
        + Math.sqrt(
            Math.max(0, 0.5 * a2 * (1 + 1 / Q)
                - (P_ * (1 - e2) * pz * pz) / (Q * (1 + Q))
                - 0.5 * P_ * p * p),
        );
    const tmp = p - e2 * r0;
    const U = Math.sqrt(tmp * tmp + pz * pz);
    const V = Math.sqrt(tmp * tmp + (1 - e2) * pz * pz);
    const z0 = (b2 * pz) / (a * V);

    const height = U * (1 - b2 / (a * V));
    const latitude = Math.atan2(pz + ep2 * z0, p);
    const longitude = Math.atan2(py, px);

    // 椭球面点 = 大地高度置 0
    const surface = new Float64Array(3);
    geodeticToECEF(surface, longitude, latitude, 0);
    return {
        point: [surface[0], surface[1], surface[2]],
        latitude,
        longitude,
        height,
    };
}
