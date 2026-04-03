/**
 * @module preset-3d/globe-camera
 * @description
 * **Globe 专用相机数学**：在 `Camera3D` 之上构造透视 VP、RTE 与 ECEF 两套矩阵、上传 GPU uniform、以及 __DEV__ 下 EggShape 诊断。
 * 依赖 {@link import('./globe-buffers.ts')} 中模块级矩阵缓冲，调用须注意与 `computeGlobeCamera` 的时序（诊断依赖 `_tmpMat4A` 仍为投影矩阵）。
 *
 * @stability experimental
 */

declare const __DEV__: boolean | undefined;

import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import { geodeticToECEF } from '../../core/src/geo/ellipsoid.ts';
import * as mat4d from '../../core/src/math/mat4d.ts';
import * as vec3d from '../../core/src/math/vec3d.ts';
import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeCamera } from '../../globe/src/globe-tile-mesh.ts';
import {
    _cameraUniformData,
    _ecefCam64,
    _ecefCenter64,
    _tmpMat4A,
    _tmpMat4B,
    _tmpMat4C,
    _tmpVec3A,
    _tmpVec3B,
    _tmpVec3C,
} from './globe-buffers.ts';
import {
    DEG2RAD,
    FAR_PLANE_HORIZON_FACTOR,
    NEAR_PLANE_FACTOR,
    NEAR_PLANE_MIN,
    PI,
    RAD2DEG,
    TWO_PI,
} from './globe-constants.ts';
import { computeSunDirectionECEF } from '../../globe/src/sun.ts';
import { computeHorizonDist } from './globe-utils.ts';
import type { GlobeGPURefs } from './globe-types.ts';

/**
 * 根据 `Camera3D` 当前位置与 `CameraState` 计算椭球视线用 {@link GlobeCamera}。
 *
 * @param camera3D - 用于 `getPosition()` 取 Float64 精度经纬高
 * @param camState - 帧更新结果（含 `fov`、注视中心、`altitude` 等）
 * @param vp - CSS 视口（宽高用于 aspect）
 * @returns 含 `vpMatrix`、`inverseVP_ECEF`（拾取）、`inverseVP_RTE`（天穹）、`horizonDist` 等
 *
 * @remarks
 * - RTE 视图：eye 在原点，target 为中心 ECEF 减相机 ECEF（Float64 差）。
 * - ECEF 视图：用于 `screenToGlobe` 反投影，与 RTE 共享同一透视矩阵 `_tmpMat4A`。
 */
export function computeGlobeCamera(
    camera3D: Camera3D,
    camState: CameraState,
    vp: Viewport,
): GlobeCamera {
    const alt = camState.altitude;
    const fov = camState.fov;
    const aspect = vp.width / Math.max(vp.height, 1);

    const nearZ = Math.max(alt * NEAR_PLANE_FACTOR, NEAR_PLANE_MIN);
    const horizonDist = computeHorizonDist(alt);
    const farZ = horizonDist * FAR_PLANE_HORIZON_FACTOR + alt;

    mat4d.perspective(_tmpMat4A, fov, aspect, nearZ, farZ);

    // ─── 从 Camera3D 读取 ECEF 向量 ─────────────────────────
    // 直接使用 Camera3D 维护的 position/direction/up 四向量，
    // 而非从经纬度重新推导视线方向。
    // 这样 tilt3D / rotateUp / rotateRight 对 direction/up 的修改才能反映到渲染中。
    const camPosECEF = camera3D.getPositionECEF(); // Float64Array(3)
    const camDir = camera3D.getDirection();          // Float64Array(3) 单位向量
    const camUp = camera3D.getUp();                  // Float64Array(3) 单位向量

    // 填充 _ecefCam64 供其他模块使用
    _ecefCam64[0] = camPosECEF[0]; _ecefCam64[1] = camPosECEF[1]; _ecefCam64[2] = camPosECEF[2];

    const camECEFx: number = camPosECEF[0];
    const camECEFy: number = camPosECEF[1];
    const camECEFz: number = camPosECEF[2];

    // ─── RTE 视图矩阵：eye=origin，target=direction，up=camera.up ────
    // RTE（Relative To Eye）将相机置于原点，避免大 ECEF 坐标的精度问题。
    // 全程 Float64 计算，最后转 Float32 上传 GPU。
    vec3d.set(_tmpVec3A, 0, 0, 0);
    vec3d.set(_tmpVec3B, camDir[0], camDir[1], camDir[2]);
    vec3d.set(_tmpVec3C, camUp[0], camUp[1], camUp[2]);

    mat4d.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);

    mat4d.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);
    const vpMatrix = mat4d.create();
    mat4d.copy(vpMatrix, _tmpMat4C);

    // ─── ECEF 视图矩阵（用于 screenToGlobe 拾取）────────────
    // eye = cameraECEF, target = cameraECEF + direction, up = camera.up
    // 全程 Float64——不再需要 DIR_SCALE 技巧，Float64 精度足以表达 1m 偏移于 2.6×10⁷m 坐标上。
    vec3d.set(_tmpVec3A, camECEFx, camECEFy, camECEFz);
    vec3d.set(_tmpVec3B,
        camECEFx + camDir[0],
        camECEFy + camDir[1],
        camECEFz + camDir[2],
    );
    vec3d.set(_tmpVec3C, camUp[0], camUp[1], camUp[2]);
    mat4d.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);
    mat4d.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);

    const inverseVP_ECEF = mat4d.create();
    mat4d.invert(inverseVP_ECEF, _tmpMat4C);

    const inverseVP_RTE = mat4d.create();
    mat4d.invert(inverseVP_RTE, vpMatrix);

    return {
        vpMatrix,
        inverseVP_ECEF,
        inverseVP_RTE,
        cameraECEF: [camECEFx, camECEFy, camECEFz],
        center: [camState.center[0], camState.center[1]],
        zoom: camState.zoom,
        altitude: alt,
        horizonDist,
        fov,
        viewportWidth: vp.width,
        viewportHeight: vp.height,
    };
}

/**
 * 将 `GlobeCamera` 与仿真时间写入 `_cameraUniformData` 并 `writeBuffer` 到 GPU。
 *
 * @param device - 用于 `queue.writeBuffer`
 * @param gc - 本帧 `computeGlobeCamera` 结果
 * @param refs - 需含 `cameraUniformBuffer`
 * @param dateTime - 用于简化太阳方向（时角）
 *
 * @remarks
 * 太阳方向为低成本近似，非真实天文；`logDepthBufFC` 由 far 与海拔推导。
 */
export function updateGlobeCameraUniforms(
    device: GPUDevice,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
    dateTime: Date,
): void {
    if (!refs.cameraUniformBuffer) { return; }

    const farZ = gc.horizonDist * FAR_PLANE_HORIZON_FACTOR + gc.altitude;
    const logDepthBufFC = 1.0 / Math.log2(farZ + 1.0);

    // ─── 太阳方向：基于真实天文算法计算 ECEF 方向 ───────────
    // 使用简化 Meeus 算法计算太阳赤经/赤纬 + GMST，得到太阳在 ECEF 坐标系中的归一化方向。
    // 精度约 ±1°，随本地时间自动更新，正确反映季节性太阳赤纬变化。
    const sunDir = computeSunDirectionECEF(dateTime);

    _cameraUniformData.set(gc.vpMatrix, 0);
    _cameraUniformData[16] = gc.cameraECEF[0];
    _cameraUniformData[17] = gc.cameraECEF[1];
    _cameraUniformData[18] = gc.cameraECEF[2];
    _cameraUniformData[19] = gc.altitude;
    // sunDir 已经是归一化的 ECEF 方向向量（单位球面上的点）
    _cameraUniformData[20] = sunDir[0];
    _cameraUniformData[21] = sunDir[1];
    _cameraUniformData[22] = sunDir[2];
    _cameraUniformData[23] = logDepthBufFC;

    device.queue.writeBuffer(refs.cameraUniformBuffer, 0, _cameraUniformData);
}
