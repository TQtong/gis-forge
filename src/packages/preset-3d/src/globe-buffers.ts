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
import * as mat4d from '../../core/src/math/mat4d.ts';
import * as vec3d from '../../core/src/math/vec3d.ts';

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
export const _tmpMat4A = mat4d.create();

/**
 * 视图矩阵 `lookAt` 结果暂存（RTE 或 ECEF 空间）。
 */
export const _tmpMat4B = mat4d.create();

/**
 * 合成矩阵暂存：`proj × view` 或逆矩阵计算的中间结果。
 */
export const _tmpMat4C = mat4d.create();

/**
 * `lookAt` 用的 eye / 起点向量（RTE 下常为原点）。
 */
export const _tmpVec3A = vec3d.create();

/**
 * `lookAt` 用的 target / 方向终点向量。
 */
export const _tmpVec3B = vec3d.create();

/**
 * `lookAt` 用的 up 向量（地理北向在 ECEF 中的表达）。
 */
export const _tmpVec3C = vec3d.create();

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

/**
 * 跨 scheme 纹理投影参数 `DrapingParams`：imgWest + imgEast + latToV_scale + latToV_offset，共 4 float。
 * Phase 3 地形管线使用。
 */
export const _drapingParamsData = new Float32Array(4);

/**
 * 地形参数 `TerrainParams`：exaggeration + heightScale + heightOffset + pad，共 4 float。
 * Phase 3 地形管线使用。
 */
export const _terrainParamsData = new Float32Array(4);

// ─── 中键 Orbit 预分配缓冲 ─────────────────────────────────

/**
 * orbit 计算用临时 ECEF 缓冲（mouseDown 相机位置）。
 * 由 `createGlobeMouseHandlers` 闭包的 `onMouseDown` 写入，
 * 在同一同步回调中立即消费——不持久化。
 */
export const _orbitCamECEF = new Float64Array(3);

/**
 * orbit ENU 缓冲（9 float：E/N/U 各 3 分量）。
 * mouseDown 时由 `computeENUBasis` 写入，拖拽期间不变。
 * 通过 `state.orbitENU` 引用此缓冲——拖拽期间零分配。
 */
export const _orbitENUBuf = new Float64Array(9);

// ─── 左键 spin/pan 预分配缓冲 ─────────────────────────────

/** spin/pan 当前帧交点 ECEF 暂存（3 float64）。 */
export const _spinCurrentECEF = new Float64Array(3);

/** pan3D east 向量暂存 */
export const _panEast = new Float64Array(3);

/** pan3D 平面法线暂存（极地穿越检测用） */
export const _panPlaneNormal = new Float64Array(3);

/** pan3D 球坐标 p0 rejection 暂存 */
export const _panRejA = new Float64Array(3);

/** pan3D 球坐标 p1 rejection 暂存 */
export const _panRejB = new Float64Array(3);

/** pan3D 通用临时向量 */
export const _panTmpA = new Float64Array(3);

/** pan3D 通用临时向量 */
export const _panTmpB = new Float64Array(3);

/** pan3D basis1（mostOrthogonalAxis 输出） */
export const _panBasis1 = new Float64Array(3);

/** pan3D basis2 = cross(basis0, basis1) */
export const _panBasis2 = new Float64Array(3);

/** zoom 时 camera→target 方向暂存 */
export const _zoomDir = new Float64Array(3);

/** zoom 时 unitPosition 暂存 */
export const _zoomUnitPos = new Float64Array(3);

// ─── handleZoom 预分配缓冲（对标 Cesium SSCC handleZoom scratch 变量）───

/** 持久缩放锚点 ECEF 缓冲（对标 Cesium _zoomWorldPosition） */
export const _zoomWorldPosBuf = new Float64Array(3);

/** 屏幕中心 pick 结果复制（pickGlobe 共享缓冲，第二次 pick 前必须复制） */
export const _zoomCenterHit = new Float64Array(3);

/** normalize(centerHit)——sub-path A 用 */
export const _zoomPosNormal = new Float64Array(3);

/** normalize(zoomWorldPosition)——sub-path A 用 */
export const _zoomPickNormal = new Float64Array(3);

/** cross(pickedNormal, positionNormal) 旋转轴——sub-path A 用 */
export const _zoomRotAxis = new Float64Array(3);

/** target - camPos 向量——sub-path B 用 */
export const _zoomPosToTarget = new Float64Array(3);

/** normalize(positionToTarget)——sub-path B 用 */
export const _zoomPosToTargetNorm = new Float64Array(3);

/** 新相机位置暂存——sub-path B 大圆移动 */
export const _zoomCamPos = new Float64Array(3);

/** center 参考点暂存——sub-path B */
export const _zoomCenter = new Float64Array(3);

/** forward 基向量暂存——sub-path B */
export const _zoomForward = new Float64Array(3);

/** up 基向量暂存——sub-path B */
export const _zoomUp = new Float64Array(3);

/** right 基向量暂存——sub-path B */
export const _zoomRight = new Float64Array(3);

/** 位移暂存——sub-path B pMid */
export const _zoomPan = new Float64Array(3);

/** center 位移暂存——sub-path B cMid */
export const _zoomCMid = new Float64Array(3);

/** 通用暂存 A */
export const _zoomTmpA = new Float64Array(3);

/** 通用暂存 B */
export const _zoomTmpB = new Float64Array(3);

/** zoomOnVector 射线方向暂存——sub-path C */
export const _zoomRayDir = new Float64Array(3);

/** _pickECEFBuf：screenToGlobe 输出 ECEF 暂存（供 globe-interaction 持有引用） */
export const _pickECEFBuf = new Float64Array(3);

// ─── 中键 tilt3D 预分配缓冲 ─────────────────────────────────

/** tilt 枢轴点 ECEF 暂存（屏幕中心 pick 结果） */
export const _tiltCenterECEF = new Float64Array(3);

/** tilt ENU 变换矩阵（4x4 列主序 Float64） */
export const _tiltENUMat = new Float64Array(16);

/** tilt 保存旧 constrainedAxis 用的缓冲（3 float64） */
export const _tiltOldAxis = new Float64Array(3);
