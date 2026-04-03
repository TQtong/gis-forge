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
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
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

    mat4.perspective(_tmpMat4A, fov, aspect, nearZ, farZ);

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
    // RTE（Relative To Eye）将相机置于原点，避免 Float32 精度问题。
    // target = direction（lookAt 需要一个目标点，用 direction 作为单位向量方向指示）
    vec3.set(_tmpVec3A, 0, 0, 0);
    vec3.set(_tmpVec3B, camDir[0], camDir[1], camDir[2]);
    vec3.set(_tmpVec3C, camUp[0], camUp[1], camUp[2]);

    mat4.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);

    mat4.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);
    const vpMatrix = mat4.clone(_tmpMat4C);

    // ─── ECEF 视图矩阵（用于 screenToGlobe 拾取）────────────
    // eye = cameraECEF, target = cameraECEF + direction * SCALE, up = camera.up
    // ⚠ direction 是单位向量（长度 ~1m），而 ECEF 坐标 ~2.6×10⁷m；
    //   Float32 在该量级 ULP ≈ 2m，1m 偏移被精度吞没 → lookAt forward 退化。
    //   乘以 1e6（1000 km）使 target 偏移远超 Float32 噪底，
    //   lookAt 内部 normalize(target - eye) 不受 scale 影响。
    const DIR_SCALE = 1e6;
    vec3.set(_tmpVec3A, camECEFx, camECEFy, camECEFz);
    vec3.set(_tmpVec3B,
        camECEFx + camDir[0] * DIR_SCALE,
        camECEFy + camDir[1] * DIR_SCALE,
        camECEFz + camDir[2] * DIR_SCALE,
    );
    vec3.set(_tmpVec3C, camUp[0], camUp[1], camUp[2]);
    mat4.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);
    mat4.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);

    const inverseVP_ECEF = mat4.create();
    mat4.invert(inverseVP_ECEF, _tmpMat4C);

    const inverseVP_RTE = mat4.create();
    mat4.invert(inverseVP_RTE, vpMatrix);

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

    const hourAngle = (dateTime.getUTCHours() + dateTime.getUTCMinutes() / 60) / 24 * TWO_PI - PI;
    const sunDirX = Math.cos(hourAngle);
    const sunDirY = Math.sin(hourAngle);
    const sunDirZ = 0.3;
    const sunLen = Math.sqrt(sunDirX * sunDirX + sunDirY * sunDirY + sunDirZ * sunDirZ);

    _cameraUniformData.set(gc.vpMatrix, 0);
    _cameraUniformData[16] = gc.cameraECEF[0];
    _cameraUniformData[17] = gc.cameraECEF[1];
    _cameraUniformData[18] = gc.cameraECEF[2];
    _cameraUniformData[19] = gc.altitude;
    _cameraUniformData[20] = sunDirX / sunLen;
    _cameraUniformData[21] = sunDirY / sunLen;
    _cameraUniformData[22] = sunDirZ / sunLen;
    _cameraUniformData[23] = logDepthBufFC;

    device.queue.writeBuffer(refs.cameraUniformBuffer, 0, _cameraUniformData);
}
