// ============================================================
// types/math-types.ts — 数学 TypedArray 类型别名
// GIS-Forge 引擎统一的向量/矩阵底层类型，所有数学模块基于这些别名。
// 好处：1) 零 GC 压力  2) 直传 GPU Buffer  3) Worker transferable
// ============================================================

// ===================== Float32 类型（GPU 上传用）=====================

/**
 * 2D 浮点向量（单精度）。
 * 底层为 Float32Array，长度为 2，布局 [x, y]。
 * 用于 2D 屏幕坐标、纹理坐标、2D 位移等场景。
 * 与 WGSL 中的 `vec2<f32>` 内存布局完全对齐，CPU→GPU 零拷贝。
 *
 * @example
 * const v: Vec2f = new Float32Array([1.0, 2.0]);
 */
export type Vec2f = Float32Array;

/**
 * 3D 浮点向量（单精度）。
 * 底层为 Float32Array，长度为 3，布局 [x, y, z]。
 * 用于 3D 位置、法线、方向向量、RGB 颜色等场景。
 * 注意：WGSL 中 `vec3<f32>` 在 uniform buffer 中对齐到 16 字节（4 个 float），
 * 但在 storage buffer / vertex buffer 中紧凑排列（12 字节）。
 *
 * @example
 * const normal: Vec3f = new Float32Array([0, 1, 0]);
 */
export type Vec3f = Float32Array;

/**
 * 4D 浮点向量（单精度）。
 * 底层为 Float32Array，长度为 4，布局 [x, y, z, w]。
 * 用于齐次坐标、RGBA 颜色、裁剪空间坐标等场景。
 * 与 WGSL 中的 `vec4<f32>` 内存布局完全对齐（16 字节）。
 *
 * @example
 * const color: Vec4f = new Float32Array([1, 0, 0, 1]); // 红色 RGBA
 */
export type Vec4f = Float32Array;

/**
 * 3×3 浮点矩阵（单精度，列主序）。
 * 底层为 Float32Array，长度为 9。
 * 列主序（Column-Major）存储，与 WGSL `mat3x3<f32>` 一致。
 *
 * 索引映射：
 * ```
 * | m[0]  m[3]  m[6] |     | c0r0  c1r0  c2r0 |
 * | m[1]  m[4]  m[7] |  =  | c0r1  c1r1  c2r1 |
 * | m[2]  m[5]  m[8] |     | c0r2  c1r2  c2r2 |
 * ```
 *
 * 用于法线变换（Model 矩阵的逆转置左上 3×3）、2D 仿射变换等。
 *
 * @example
 * const identity3: Mat3f = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
 */
export type Mat3f = Float32Array;

/**
 * 4×4 浮点矩阵（单精度，列主序）。
 * 底层为 Float32Array，长度为 16。
 * 列主序（Column-Major）存储，与 WGSL `mat4x4<f32>` 一致，CPU→GPU 零拷贝。
 *
 * 索引映射：
 * ```
 * | m[0]  m[4]  m[8]   m[12] |     | c0r0 c1r0 c2r0 c3r0 |
 * | m[1]  m[5]  m[9]   m[13] |  =  | c0r1 c1r1 c2r1 c3r1 |
 * | m[2]  m[6]  m[10]  m[14] |     | c0r2 c1r2 c2r2 c3r2 |
 * | m[3]  m[7]  m[11]  m[15] |     | c0r3 c1r3 c2r3 c3r3 |
 * ```
 *
 * 用于 Model-View-Projection 变换、投影矩阵、视图矩阵等核心渲染管线。
 *
 * @example
 * const identity4: Mat4f = new Float32Array([
 *   1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
 * ]);
 */
export type Mat4f = Float32Array;

/**
 * 四元数（单精度）。
 * 底层为 Float32Array，长度为 4，布局 [x, y, z, w]。
 * 遵循 Hamilton 约定：w 为实部，xyz 为虚部。
 * 用于 3D 旋转表示，相比欧拉角无万向锁问题，相比矩阵更紧凑。
 * 支持球面线性插值（slerp）实现平滑旋转过渡。
 *
 * @example
 * const identityQuat: Quatf = new Float32Array([0, 0, 0, 1]); // 单位四元数
 */
export type Quatf = Float32Array;

// ===================== Float64 类型（CPU 精确计算用）=====================

/**
 * 2D 浮点向量（双精度）。
 * 底层为 Float64Array，长度为 2，布局 [x, y]。
 * 用于需要高精度的 CPU 计算场景：经纬度坐标转换、墨卡托投影、大地测量等。
 * Float64 提供约 15-17 位有效数字，可满足亚毫米级地理精度需求。
 *
 * @example
 * const lngLat: Vec2d = new Float64Array([116.3912757, 39.906217]); // 北京经纬度
 */
export type Vec2d = Float64Array;

/**
 * 3D 浮点向量（双精度）。
 * 底层为 Float64Array，长度为 3，布局 [x, y, z]。
 * 用于 ECEF 笛卡尔坐标、高精度大地测量、椭球体法线计算等。
 * ECEF 坐标值可达数百万米量级，必须使用 Float64 避免精度丢失。
 *
 * @example
 * const ecef: Vec3d = new Float64Array([-2187110.0, 4524060.0, 4069060.0]);
 */
export type Vec3d = Float64Array;

/**
 * 4D 浮点向量（双精度）。
 * 底层为 Float64Array，长度为 4，布局 [x, y, z, w]。
 * 用于双精度齐次坐标变换、高精度裁剪计算等场景。
 *
 * @example
 * const homogeneous: Vec4d = new Float64Array([100.0, 200.0, 300.0, 1.0]);
 */
export type Vec4d = Float64Array;

/**
 * 4×4 浮点矩阵（双精度，列主序）。
 * 底层为 Float64Array，长度为 16。
 * 列主序（Column-Major）存储，与单精度 Mat4f 布局一致。
 * 用于 CPU 端高精度矩阵运算：Split-Double RTC 相机矩阵、
 * 椭球体坐标系变换等需要超出 Float32 精度的场景。
 * 最终传 GPU 前需降精度到 Mat4f 或使用 RTC（Relative To Center）拆分。
 *
 * @example
 * const viewMatrixD: Mat4d = new Float64Array(16);
 */
export type Mat4d = Float64Array;

// ===================== 包围盒类型 =====================

/**
 * 2D 轴对齐包围盒（Axis-Aligned Bounding Box）。
 * 使用地理坐标命名约定（west/south/east/north），
 * 也可作为通用 2D 矩形使用（west=minX, south=minY, east=maxX, north=maxY）。
 * 此类型为全局共享，上层统一从 @gis-forge/core import。
 *
 * @example
 * const bbox: BBox2D = { west: -180, south: -85, east: 180, north: 85 };
 */
export interface BBox2D {
    /** 最小 x（经度下界 / 左边界） */
    readonly west: number;

    /** 最小 y（纬度下界 / 下边界） */
    readonly south: number;

    /** 最大 x（经度上界 / 右边界） */
    readonly east: number;

    /** 最大 y（纬度上界 / 上边界） */
    readonly north: number;
}

/**
 * 3D 轴对齐包围盒，在 2D 包围盒基础上增加高度范围。
 * 用于 3D 场景中的空间裁剪、视锥体剔除等。
 *
 * @example
 * const bbox: BBox3D = { west: 0, south: 0, east: 100, north: 100, minAlt: 0, maxAlt: 50 };
 */
export interface BBox3D extends BBox2D {
    /** 最小高度（米） */
    readonly minAlt: number;

    /** 最大高度（米） */
    readonly maxAlt: number;
}
