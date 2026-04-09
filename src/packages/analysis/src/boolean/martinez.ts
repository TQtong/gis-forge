// ============================================================
// analysis/boolean/martinez.ts — polygon-clipping 官方封装
// ============================================================
//
// 完全委托到 Mapbox / mfogel 维护的 `polygon-clipping`（npm）。
// 自研的 Martinez 扫描线实现已全部删除——这个领域的"事实标准"就是
// polygon-clipping，作者 Mike Fogel 的实现基于 Martinez-Rueda-Feito 2009
// 论文并做了数值稳定性补强，是目前 JS 生态中最可靠的多边形布尔库。
//
// 依赖：`polygon-clipping` (MIT, ~30 KB minified)
// 参考：https://github.com/mfogel/polygon-clipping
//
// 特性（来自上游文档）：
//   - 支持任意 GeoJSON 风格多边形：凹 / 自相交 / 多孔洞 / MultiPolygon
//   - Martinez 2009 扫描线 + 边分裂 + 边类型系统（SAME/DIFF_TRANSITION）
//   - 数值容差处理：共线边、共享顶点、T 形交都正确处理
//   - 输出严格的 CCW 外环 + CW 孔洞（GeoJSON 约定）
//
// API 保持与原自研版本兼容：`martinez(subject, clipping, op)` 接收
// `MartinezPolygon` 并返回 `MultiPolygon` 风格的嵌套数组。
// ============================================================

import polygonClipping from 'polygon-clipping';
import type { Geom as PCGeom } from 'polygon-clipping';

/** 布尔运算类型。 */
export type MartinezOp = 'intersection' | 'union' | 'difference' | 'xor';

/** 单个环：[[x,y], ...]，首尾可重复也可不重复（polygon-clipping 会处理）。 */
export type Ring = ReadonlyArray<readonly [number, number]>;
/** 多边形 = 外环 + 任意多个内环（孔洞）。 */
export type MartinezPolygon = ReadonlyArray<Ring>;

// ============================================================
// 主入口
// ============================================================

/**
 * 多边形布尔运算。
 *
 * 与原自研版本的 API 完全兼容：
 * - 输入：`MartinezPolygon = Ring[]`（外环 + 可选孔洞）
 * - 输出：`[polygon1, polygon2, ...]`，每个 polygon 是 `Ring[]`
 *   （第 0 项为外环，其余为孔洞）
 *
 * @param subject 主多边形
 * @param clipping 裁剪多边形
 * @param op 运算类型
 * @returns 结果 MultiPolygon（GeoJSON 风格嵌套数组）
 *
 * @example
 * martinez(
 *     [[[0,0],[10,0],[10,10],[0,10]]],
 *     [[[5,5],[15,5],[15,15],[5,15]]],
 *     'intersection',
 * );
 * // → [[[[5,5],[10,5],[10,10],[5,10],[5,5]]]]
 */
export function martinez(
    subject: MartinezPolygon,
    clipping: MartinezPolygon,
    op: MartinezOp,
): Array<Array<Array<[number, number]>>> {
    if (subject.length === 0 && clipping.length === 0) return [];

    // polygon-clipping 需要 Polygon = Ring[] = [[[x,y], ...], ...]
    // 我们的 subject 已经是这个形状；它期望 Geom = Polygon | MultiPolygon
    const a = toPCGeom(subject);
    const b = toPCGeom(clipping);

    let result: PCGeom;
    switch (op) {
        case 'intersection':
            result = polygonClipping.intersection(a, b);
            break;
        case 'union':
            result = polygonClipping.union(a, b);
            break;
        case 'difference':
            result = polygonClipping.difference(a, b);
            break;
        case 'xor':
            result = polygonClipping.xor(a, b);
            break;
    }

    // polygon-clipping 返回 MultiPolygon: Array<Polygon> = Array<Array<Ring>>
    // 每个 Ring 形如 [[x,y], ..., [x,y]]（首尾闭合）
    return (result as Array<Array<Array<[number, number]>>>).map((poly) =>
        poly.map((ring) => ring.map((p) => [p[0], p[1]] as [number, number])),
    );
}

/**
 * 把我们的 `MartinezPolygon`（可能首尾不闭合）转换为 polygon-clipping 的 Geom。
 * polygon-clipping 接受首尾闭合或不闭合的环，都能正确处理。
 */
function toPCGeom(poly: MartinezPolygon): PCGeom {
    if (poly.length === 0) {
        // 空 Polygon → 空 MultiPolygon
        return [] as unknown as PCGeom;
    }
    // 复制为可变数组避免 readonly 类型冲突
    const out: Array<Array<[number, number]>> = poly.map((ring) =>
        ring.map((p) => [p[0], p[1]] as [number, number]),
    );
    return out as unknown as PCGeom;
}
