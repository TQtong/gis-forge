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

    const camPos = camera3D.getPosition();
    const camLonRad = camPos.lon * DEG2RAD;
    const camLatRad = camPos.lat * DEG2RAD;
    geodeticToECEF(_ecefCam64, camLonRad, camLatRad, camPos.alt);

    const centerLngRad = camState.center[0] * DEG2RAD;
    const centerLatRad = camState.center[1] * DEG2RAD;
    geodeticToECEF(_ecefCenter64, centerLngRad, centerLatRad, 0);

    const camECEFx: number = _ecefCam64[0];
    const camECEFy: number = _ecefCam64[1];
    const camECEFz: number = _ecefCam64[2];

    const targetRteX: number = _ecefCenter64[0] - _ecefCam64[0];
    const targetRteY: number = _ecefCenter64[1] - _ecefCam64[1];
    const targetRteZ: number = _ecefCenter64[2] - _ecefCam64[2];

    const sinLat = Math.sin(centerLatRad);
    const cosLat = Math.cos(centerLatRad);
    const sinLon = Math.sin(centerLngRad);
    const cosLon = Math.cos(centerLngRad);

    vec3.set(_tmpVec3A, 0, 0, 0);
    vec3.set(_tmpVec3B, targetRteX, targetRteY, targetRteZ);
    vec3.set(_tmpVec3C, -sinLat * cosLon, -sinLat * sinLon, cosLat);

    mat4.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);

    mat4.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);
    const vpMatrix = mat4.clone(_tmpMat4C);

    vec3.set(_tmpVec3A, _ecefCam64[0], _ecefCam64[1], _ecefCam64[2]);
    vec3.set(_tmpVec3B, _ecefCenter64[0], _ecefCenter64[1], _ecefCenter64[2]);
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

/**
 * __DEV__ 首帧控制台输出 5 步诊断：投影、RTE 泄漏、uniform 一致性、Canvas 尺寸、FOV。
 *
 * @param camState - 当前帧 `CameraState`
 * @param gc - 本帧 `GlobeCamera`（与 uniform 应一致）
 * @param ctx - 用于 `getCurrentTexture()` 读 surface 尺寸
 * @param viewport - CSS 与物理像素视口
 *
 * @remarks
 * 依赖 `computeGlobeCamera` 刚写入的 `_tmpMat4A` 与 `_cameraUniformData`；勿在中间插入其它矩阵运算。
 */
export function runEggShapeDiagnostic(
    camState: CameraState,
    gc: GlobeCamera,
    ctx: GPUCanvasContext,
    viewport: Viewport,
): void {
    if (typeof __DEV__ === 'undefined' || !__DEV__) { return; }

    const aspect = viewport.width / Math.max(viewport.height, 1);
    const fov = camState.fov;
    const f = 1 / Math.tan(fov * 0.5);

    const expectP0 = f / aspect;
    const projOK = Math.abs(_tmpMat4A[0] - expectP0) < 0.001
        && Math.abs(_tmpMat4A[5] - f) < 0.001;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag Step1] proj[0]:${_tmpMat4A[0].toFixed(4)} expect:${expectP0.toFixed(4)} ` +
        `proj[5]:${_tmpMat4A[5].toFixed(4)} expect:${f.toFixed(4)} ` +
        `ratio:${(_tmpMat4A[0] / _tmpMat4A[5]).toFixed(4)} expect:${(1 / aspect).toFixed(4)} ` +
        `${projOK ? 'OK' : 'FAIL'}`,
        projOK ? 'color:green' : 'color:red;font-weight:bold',
    );

    const rteOK = Math.abs(gc.vpMatrix[12]) < 1 && Math.abs(gc.vpMatrix[13]) < 1;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag Step2] vpMat[12]:${gc.vpMatrix[12].toFixed(4)} [13]:${gc.vpMatrix[13].toFixed(4)} ` +
        `[14]:${gc.vpMatrix[14].toFixed(2)} ${rteOK ? 'OK' : 'FAIL (RTE leak)'}`,
        rteOK ? 'color:green' : 'color:red;font-weight:bold',
    );

    const uploadMatch = Math.abs(_cameraUniformData[0] - gc.vpMatrix[0]) < 0.0001;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag Step3] uniform[0]:${_cameraUniformData[0].toFixed(4)} vpMat[0]:${gc.vpMatrix[0].toFixed(4)} ` +
        `${uploadMatch ? 'OK' : 'FAIL (matrix override)'}`,
        uploadMatch ? 'color:green' : 'color:red;font-weight:bold',
    );

    let surfW = 0; let surfH = 0;
    try { const s = ctx.getCurrentTexture(); surfW = s.width; surfH = s.height; } catch { /* */ }
    const sizeOK = surfW === viewport.physicalWidth && surfH === viewport.physicalHeight;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag Step4] CSS:${viewport.width}x${viewport.height} Phys:${viewport.physicalWidth}x${viewport.physicalHeight} ` +
        `Surf:${surfW}x${surfH} ${sizeOK ? 'OK' : 'FAIL (size mismatch)'}`,
        sizeOK ? 'color:green' : 'color:red;font-weight:bold',
    );

    const fovDeg = fov * RAD2DEG;
    const fovOK = fovDeg > 10 && fovDeg < 120;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag Step5] fov:${fovDeg.toFixed(1)}deg f:${f.toFixed(4)} ` +
        `${fovOK ? 'OK' : 'FAIL (fov units)'}`,
        fovOK ? 'color:green' : 'color:red;font-weight:bold',
    );

    const allOK = projOK && rteOK && uploadMatch && sizeOK && fovOK;
    // eslint-disable-next-line no-console
    console.log(
        `%c[EggDiag] ${allOK ? 'ALL PASS' : 'ISSUES FOUND'}`,
        allOK ? 'color:green;font-weight:bold;font-size:14px' : 'color:red;font-weight:bold;font-size:14px',
    );
}
