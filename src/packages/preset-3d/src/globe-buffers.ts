/**
 * @module preset-3d/globe-buffers
 * @description
 * Globe3D 在**多帧之间复用**的模块级 TypedArray / 矩阵 / 向量缓冲。
 * 目的：避免在 `requestAnimationFrame` 循环或每瓦片绘制路径中 `new Float32Array` / `mat4.create()`，
 * 降低 GC 压力与分配器开销。
 *
 * **线程安全**：单线程 Web 环境；勿在 Worker 与主线程之间共享这些缓冲。
 *
 * @see globe-camera.ts — 读写 `_tmpMat4A`、`_cameraUniformData` 等
 * @see globe-render.ts — 读写 `_skyUniformData`、`_tileParamsData`
 *
 * @stability experimental
 */

import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';

/**
 * 通用 ECEF 三维点暂存（Float64），供 `geodeticToECEF`、`cartographicToScreen` 等写入。
 * 长度固定为 3，类型为 `Vec3d` 以与椭球模块签名一致。
 */
export const _ecefTmp = new Float64Array(3) as Vec3d;

/**
 * 法线或其它三维向量暂存（Float64），例如 `surfaceNormal` 输出；与 `_ecefTmp` 分离避免调用链互相覆盖。
 */
export const _normTmp = new Float64Array(3) as Vec3d;

/**
 * 透视投影矩阵暂存。`computeGlobeCamera` / EggShape 诊断读取 `[0]`、`[5]` 等分量校验纵横比。
 */
export const _tmpMat4A = mat4.create();

/**
 * 视图矩阵 `lookAt` 结果暂存（RTE 或 ECEF 空间）。
 */
export const _tmpMat4B = mat4.create();

/**
 * 合成矩阵暂存：`proj × view` 或逆矩阵计算的中间结果。
 */
export const _tmpMat4C = mat4.create();

/**
 * `lookAt` 用的 eye / 起点向量（RTE 下常为原点）。
 */
export const _tmpVec3A = vec3.create();

/**
 * `lookAt` 用的 target / 方向终点向量。
 */
export const _tmpVec3B = vec3.create();

/**
 * `lookAt` 用的 up 向量（地理北向在 ECEF 中的表达）。
 */
export const _tmpVec3C = vec3.create();

/**
 * 相机位置 ECEF（米），Float64；由经纬高经 `geodeticToECEF` 填入，供 RTE 减法与 `GlobeCamera.cameraECEF`。
 */
export const _ecefCam64 = new Float64Array(3);

/**
 * 注视点（通常为地表中心）ECEF（米），Float64；与 `_ecefCam64` 做差得到 RTE target。
 */
export const _ecefCenter64 = new Float64Array(3);

/**
 * 相机 WGSL `CameraUniforms` 的 CPU 镜像：6×vec4 = 24 个 float（96 bytes）。
 * 布局与 `GLOBE_TILE_WGSL` / `ATMOSPHERE_WGSL` 中 struct 一致。
 */
export const _cameraUniformData = new Float32Array(24);

/**
 * 天穹 `SkyUniforms`：inverseVP（16）+ altitude（1）+ padding（3），共 24 float。
 */
export const _skyUniformData = new Float32Array(24);

/**
 * 瓦片 UV 变换 `TileParams`：uvOffset.xy + uvScale.xy，共 4 float。
 */
export const _tileParamsData = new Float32Array(4);
