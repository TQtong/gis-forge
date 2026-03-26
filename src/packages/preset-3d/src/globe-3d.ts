/**
 * @module preset-3d/globe-3d
 * @description Globe3D — 3D 数字地球主入口类（L6 预设层）。
 *
 * 管理完整的 3D 地球渲染管线：
 * - Canvas + 容器 DOM 生命周期
 * - WebGPU 设备初始化 + 渲染管线创建
 * - Camera3D（ECEF 坐标系）+ 鼠标交互
 * - 瓦片加载/缓存/曲面细分
 * - WGSL 着色器（瓦片/天穹/大气）
 * - 2D↔3D 形变（morph）
 *
 * @stability experimental
 */

// ════════════════════════════════════════════════════════════════
// 构建时开发模式标志（生产构建 tree-shake 移除）
// ════════════════════════════════════════════════════════════════
declare const __DEV__: boolean | undefined;

// ════════════════════════════════════════════════════════════════
// 导入
// ════════════════════════════════════════════════════════════════

import type { BBox2D } from '../../core/src/types/math-types.ts';
import type { Feature } from '../../core/src/types/feature.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';
import { uniqueId } from '../../core/src/infra/id.ts';
import { GeoForgeError, GeoForgeErrorCode } from '../../preset-2d/src/map-2d.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
import {
    WGS84_A,
    WGS84_B,
    WGS84_E2,
    geodeticToECEF,
    ecefToGeodetic,
    surfaceNormal,
    haversineDistance,
} from '../../core/src/geo/ellipsoid.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';
import { createCamera3D } from '../../camera-3d/src/Camera3D.ts';
import type { Camera3D, Camera3DOptions } from '../../camera-3d/src/Camera3D.ts';
import {
    tessellateGlobeTile,
    meshToRTE,
    getSegments,
    coveringTilesGlobe,
    computeMorphFactor,
    computeMorphVertices,
    screenToGlobe,
    lngToTileX,
    latToTileY,
    tileYToLat,
} from '../../globe/src/globe-tile-mesh.ts';
import type {
    GlobeTileMesh,
    GlobeTileID,
    GlobeCamera,
} from '../../globe/src/globe-tile-mesh.ts';

// ════════════════════════════════════════════════════════════════
// 常量（所有魔法数字抽为命名常量）
// ════════════════════════════════════════════════════════════════

/** 度→弧度换算乘数：π / 180 */
const DEG2RAD = Math.PI / 180;

/** 弧度→度换算乘数：180 / π */
const RAD2DEG = 180 / Math.PI;

/** 圆周率 π */
const PI = Math.PI;

/** 默认瓦片 URL 模板（OSM 标准瓦片服务） */
const TILE_URL_TEMPLATE_DEFAULT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** 瓦片纹理缓存最大条目数；超出时按 LRU 淘汰最旧瓦片 */
const MAX_TILE_CACHE_SIZE = 200;

/**
 * 高度-zoom 换算系数：altitude = ZOOM_ALTITUDE_C / 2^zoom。
 * 使用地球赤道半径作为基础常数，zoom=0 时相机在约 6378km 高度
 */
const ZOOM_ALTITUDE_C = WGS84_A;

/** 默认地形夸大系数（1.0 = 真实高度） */
const DEFAULT_TERRAIN_EXAGGERATION = 1;

/** 默认时钟倍速（1.0 = 实时） */
const DEFAULT_CLOCK_MULTIPLIER = 1;

/** 全圆弧度（2π） */
const TWO_PI = Math.PI * 2;

/** 半圆弧度（π/2） */
const HALF_PI = Math.PI * 0.5;

/** 默认 flyTo 动画时长（毫秒） */
const DEFAULT_FLIGHT_DURATION_MS = 2000;

/** 默认缓动函数：ease-in-out cubic */
const DEFAULT_EASING_FN: (t: number) => number = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** 默认垂直视场角（弧度），45° */
const DEFAULT_FOV = PI / 4;

/** 默认相机海拔（米），约 20000km 可以看到整个地球 */
const DEFAULT_ALTITUDE = 20_000_000;

/** 相机 uniform buffer 字节数（6 × vec4 = 96 bytes） */
const CAMERA_UNIFORM_SIZE = 96;

/** 瓦片 params uniform buffer 字节数（uvOffset + uvScale = 16 bytes） */
const TILE_PARAMS_SIZE = 16;

/** 天穹 uniform buffer 字节数（inverseVP 64 + altitude 4 + pad 12 = 80 bytes） */
const SKY_UNIFORM_SIZE = 96;

/** 大气 uniform buffer 字节数（inverseVP 64 + camPos 12 + altitude 4 = 80 bytes） */
const ATMO_UNIFORM_SIZE = 80;

/** 深度纹理清除值（标准 Z: 1.0 = 最远，0.0 = 最近） */
const DEPTH_CLEAR_VALUE = 1.0;

/**
 * 近裁剪面系数：nearZ = max(altitude × NEAR_PLANE_FACTOR, NEAR_PLANE_MIN)。
 * 0.001 保证近处不会被裁掉
 */
const NEAR_PLANE_FACTOR = 0.001;

/** 近裁剪面下限（米），防止极端近处精度问题 */
const NEAR_PLANE_MIN = 0.5;

/** 远裁剪面余量因子：farZ = horizonDist × 2 + altitude */
const FAR_PLANE_HORIZON_FACTOR = 2.0;

/** 交错顶点数据每顶点浮点数：posRTE(3) + normal(3) + uv(2) = 8 */
const VERTEX_FLOATS = 8;

/** 每顶点字节数：8 × 4 = 32 */
const VERTEX_BYTES = VERTEX_FLOATS * 4;

/** 天穹背景清除色 R 分量（深蓝太空色） */
const CLEAR_R = 0.01;

/** 天穹背景清除色 G 分量 */
const CLEAR_G = 0.01;

/** 天穹背景清除色 B 分量 */
const CLEAR_B = 0.03;

/** morph 动画默认时长（毫秒） */
const MORPH_DEFAULT_DURATION_MS = 2000;

/** 最大设备像素比上限 */
const MAX_DEFAULT_PIXEL_RATIO = 2.0;

/** 最小画布尺寸（CSS 像素），防止零尺寸 */
const MIN_CANVAS_DIM = 1;

/** 缩放灵敏度：wheel.deltaY 到 zoom 变化量的换算因子 */
const ZOOM_SENSITIVITY = 0.01;

/** 旋转灵敏度：鼠标像素到弧度的换算因子 */
const ROTATE_SENSITIVITY = 0.003;

// ════════════════════════════════════════════════════════════════
// WGSL 着色器源码（const string）
// ════════════════════════════════════════════════════════════════

/**
 * 地球瓦片渲染着色器。
 * 包含：相机 uniforms → RTE 顶点变换 → 对数深度 → 大气边缘衰减 → 纹理采样。
 */
const GLOBE_TILE_WGSL = /* wgsl */`
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  altitude: f32,
  sunDirection: vec3<f32>,
  logDepthBufFC: f32,
};

struct TileParams {
  uvOffset: vec2<f32>,
  uvScale: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var tileSampler: sampler;
@group(1) @binding(1) var tileTexture: texture_2d<f32>;
@group(2) @binding(0) var<uniform> tile: TileParams;

struct VsIn {
  @location(0) posRTE: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) viewDir: vec3<f32>,
};

fn applyLogDepth(clipPos: vec4<f32>, logDepthBufFC: f32) -> vec4<f32> {
  var pos = clipPos;
  let logZ = log2(max(1e-6, pos.w + 1.0)) * logDepthBufFC;
  pos.z = logZ * pos.w;
  return pos;
}

@vertex fn globe_vs(in: VsIn) -> VsOut {
  var out: VsOut;
  var clip = camera.vpMatrix * vec4<f32>(in.posRTE, 1.0);
  out.clipPos = applyLogDepth(clip, camera.logDepthBufFC);
  out.uv = tile.uvOffset + in.uv * tile.uvScale;
  out.normal = in.normal;
  out.viewDir = -normalize(in.posRTE);
  return out;
}

@fragment fn globe_fs(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);
  let N = normalize(in.normal);
  let V = in.viewDir;

  // Diffuse lighting from sun (in ECEF space, consistent with all layers)
  let nDotL = max(dot(N, camera.sunDirection), 0.0);
  let ambient = 0.3;
  let diffuse = nDotL * 0.7;
  let lighting = ambient + diffuse;
  color = vec4<f32>(color.rgb * lighting, color.a);

  // Atmosphere edge effect (limb darkening / blue tint at horizon)
  let nDotV = max(dot(N, V), 0.0);
  let atmoFactor = smoothstep(0.0, 0.15, nDotV);
  let atmoColor = vec3<f32>(0.4, 0.6, 1.0);
  color = vec4<f32>(mix(atmoColor, color.rgb, atmoFactor), 1.0);

  return color;
}
`;

/**
 * 天穹渲染着色器。
 * 全屏三角形 → 射线方向 → 高度渐变（horizon → zenith → space）。
 */
const SKY_DOME_WGSL = /* wgsl */`
struct SkyUniforms {
  inverseVP: mat4x4<f32>,
  altitude: f32,
  _pad: vec3<f32>,
};
@group(0) @binding(0) var<uniform> sky: SkyUniforms;

struct SkyVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) rayDir: vec3<f32>,
};

@vertex fn sky_vs(@builtin(vertex_index) i: u32) -> SkyVsOut {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  let ndc = uv * 2.0 - 1.0;
  var out: SkyVsOut;
  out.pos = vec4<f32>(ndc, 0.9999, 1.0);
  let worldFar = sky.inverseVP * vec4<f32>(ndc, 1.0, 1.0);
  let worldNear = sky.inverseVP * vec4<f32>(ndc, 0.0, 1.0);
  let rayDir = (worldFar.xyz / worldFar.w) - (worldNear.xyz / worldNear.w);
  out.rayDir = normalize(rayDir);
  return out;
}

@fragment fn sky_fs(in: SkyVsOut) -> @location(0) vec4<f32> {
  let up = normalize(vec3<f32>(0.0, 0.0, 1.0));
  let cosAngle = dot(in.rayDir, up);
  let t = smoothstep(-0.1, 0.3, cosAngle);
  let horizonColor = vec3<f32>(0.7, 0.85, 1.0);
  let zenithColor = vec3<f32>(0.1, 0.3, 0.8);
  let spaceColor = vec3<f32>(0.01, 0.01, 0.03);
  var skyColor = mix(horizonColor, zenithColor, t);
  let altNorm = clamp(sky.altitude / 500000.0, 0.0, 1.0);
  skyColor = mix(skyColor, spaceColor, altNorm * altNorm);
  return vec4<f32>(skyColor, 1.0);
}
`;

/**
 * 大气散射着色器。
 * 全屏三角形 → 射线-大气壳求交 → 密度估算 → 加性混合。
 */
const ATMOSPHERE_WGSL = /* wgsl */`
struct AtmoUniforms {
  inverseVP: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  altitude: f32,
};
@group(0) @binding(0) var<uniform> atmo: AtmoUniforms;

struct AtmoVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) rayDir: vec3<f32>,
};

@vertex fn atmo_vs(@builtin(vertex_index) i: u32) -> AtmoVsOut {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  let ndc = uv * 2.0 - 1.0;
  var out: AtmoVsOut;
  out.pos = vec4<f32>(ndc, 0.9999, 1.0);
  let worldFar = atmo.inverseVP * vec4<f32>(ndc, 1.0, 1.0);
  let worldNear = atmo.inverseVP * vec4<f32>(ndc, 0.0, 1.0);
  out.rayDir = normalize((worldFar.xyz / worldFar.w) - (worldNear.xyz / worldNear.w));
  return out;
}

@fragment fn atmo_fs(in: AtmoVsOut) -> @location(0) vec4<f32> {
  let earthRadius = 6378137.0;
  let atmoRadius = earthRadius * 1.025;
  let camPos = atmo.cameraPosition;
  let rd = normalize(in.rayDir);
  let oc = camPos;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - atmoRadius * atmoRadius;
  let disc = b * b - c;
  if (disc < 0.0) { return vec4<f32>(0.0); }
  let sqrtDisc = sqrt(disc);
  let t0 = -b - sqrtDisc;
  let t1 = -b + sqrtDisc;
  if (t1 < 0.0) { return vec4<f32>(0.0); }
  let ce = dot(oc, oc) - earthRadius * earthRadius;
  let discE = b * b - ce;
  var pathLen = t1 - max(t0, 0.0);
  if (discE > 0.0) {
    let tE = -b - sqrt(discE);
    if (tE > 0.0) { pathLen = tE - max(t0, 0.0); }
  }
  let maxPath = atmoRadius - earthRadius;
  let density = clamp(pathLen / (maxPath * 4.0), 0.0, 1.0);
  let atmoColor = vec3<f32>(0.3, 0.5, 1.0);
  return vec4<f32>(atmoColor * density * 0.6, density * 0.4);
}
`;

// ════════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════════

/**
 * 将弧度归一化到 [0, 2π) 范围。
 * 处理 NaN / Infinity 返回 0，负值加 2π 转为正。
 *
 * @param rad - 输入弧度值
 * @returns 归一化后的弧度值，∈ [0, 2π)
 *
 * @example
 * normalizeAngleRad(-Math.PI);  // → Math.PI
 * normalizeAngleRad(3 * Math.PI); // → Math.PI
 */
function normalizeAngleRad(rad: number): number {
    // 非有限值（NaN / Infinity）回退到 0，避免传播
    if (!Number.isFinite(rad)) { return 0; }

    // 取模到 (-2π, 2π)
    let x = rad % TWO_PI;

    // 负值转正
    if (x < 0) { x += TWO_PI; }

    return x;
}

/**
 * 开发模式下输出调试日志。
 * 生产模式下此函数体为空操作，tree-shake 友好。
 *
 * @param args - 透传到 console.warn 的参数列表
 *
 * @example
 * devWarn('[Globe3D] tile load failed:', error);
 */
function devWarn(...args: unknown[]): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.warn(...args);
    }
}

/**
 * 开发模式下输出错误日志。
 *
 * @param args - 透传到 console.error 的参数列表
 */
function devError(...args: unknown[]): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.error(...args);
    }
}

/**
 * 按优先级请求 WebGPU 适配器：高性能 → 低功耗 → 默认选项。
 * 远程桌面、省电策略或未装驱动时，仅某一档可能返回非 null。
 *
 * @param gpu - `navigator.gpu` 对象
 * @returns 适配器实例；均失败时为 null
 *
 * @example
 * const adapter = await requestGpuAdapterWithFallback(navigator.gpu);
 */
async function requestGpuAdapterWithFallback(gpu: GPU): Promise<GPUAdapter | null> {
    // 三种偏好依次尝试，覆盖不同硬件配置
    const optionSets: GPURequestAdapterOptions[] = [
        { powerPreference: 'high-performance' },
        { powerPreference: 'low-power' },
        {},
    ];
    for (const opts of optionSets) {
        try {
            const adapter = await gpu.requestAdapter(opts);
            // 非 null 即可用
            if (adapter !== null) { return adapter; }
        } catch {
            // 个别环境下 requestAdapter 可能抛错，继续尝试下一档
        }
    }
    return null;
}

/**
 * 计算地平线距离（相机到椭球面切线的直线距离）。
 * 公式：d = sqrt((R+h)² - R²) = sqrt(h² + 2Rh)
 *
 * @param altitude - 相机海拔高度（米）
 * @returns 地平线距离（米）
 *
 * @example
 * computeHorizonDist(10000); // ≈ 357 km
 */
function computeHorizonDist(altitude: number): number {
    // 使用 WGS84 赤道半径作为球面近似
    return Math.sqrt(altitude * altitude + 2.0 * WGS84_A * altitude);
}

// ════════════════════════════════════════════════════════════════
// P2 #7: Multi-Frustum Cascade 分割
// ════════════════════════════════════════════════════════════════

/**
 * 计算多截锥体分割（Pipeline v2 §五 + Shape Issues §五）。
 * 当单个截锥体的 far/near 比超过阈值时，分割为多个截锥体渲染。
 * 每个截锥体独立执行一个 render pass，深度缓冲在 pass 之间清除。
 *
 * 分割策略：在对数空间均匀划分 [near, far]，相邻截锥体有 20% 重叠避免接缝。
 * 输出从远到近排列（先渲染远处截锥体，利用深度覆盖近处会正确覆盖远处）。
 *
 * Multi-frustum rendering: for now single frustum + log depth. Cascade function available for future use.
 *
 * @param nearZ - 最近裁剪面（米），必须 > 0
 * @param farZ - 最远裁剪面（米），必须 > nearZ
 * @param maxRatio - 单个截锥体允许的最大 far/near 比，默认 10000
 * @returns 截锥体列表 [{near, far}]，从远到近排列（先渲染远处，利用深度覆盖）
 *
 * @stability experimental
 *
 * @example
 * // 近地面 near=0.5m far=1e8m → ratio=2e8 → 分割为 2~3 个截锥体
 * const frusta = computeCascadeFrusta(0.5, 1e8);
 * // → [{ near: ~316m, far: 1e8 }, { near: 0.4m, far: ~395m }]
 *
 * @example
 * // 单截锥体足够的情况
 * const single = computeCascadeFrusta(10, 50000);
 * // → [{ near: 10, far: 50000 }]  (ratio=5000 < 10000)
 */
function computeCascadeFrusta(
    nearZ: number,
    farZ: number,
    maxRatio: number = 10000,
): Array<{ near: number; far: number }> {
    // 边界防御：nearZ 必须为正，farZ 必须大于 nearZ
    if (nearZ <= 0 || farZ <= nearZ) {
        return [{ near: Math.max(nearZ, 0.1), far: Math.max(farZ, 1.0) }];
    }

    const ratio = farZ / nearZ;
    if (ratio <= maxRatio) {
        // 单截锥体足够——不分割
        return [{ near: nearZ, far: farZ }];
    }

    // 分割为多个截锥体：在对数空间均匀分割
    // numFrusta = ceil(log(ratio) / log(maxRatio))
    const numFrusta = Math.ceil(Math.log(ratio) / Math.log(maxRatio));
    const frusta: Array<{ near: number; far: number }> = [];
    const logNear = Math.log(nearZ);
    const logFar = Math.log(farZ);
    // 对数空间中每个截锥体的跨度
    const step = (logFar - logNear) / numFrusta;

    // 从远到近排列：i = numFrusta-1 → 0
    for (let i = numFrusta - 1; i >= 0; i--) {
        const fNear = Math.exp(logNear + step * i);
        const fFar = Math.exp(logNear + step * (i + 1));
        // 20% overlap：向近端方向扩展 near，避免相邻截锥体之间的接缝
        // 第 0 个截锥体（最近）不扩展，保持原始 nearZ
        const overlapNear = i > 0 ? fNear * 0.8 : fNear;
        frusta.push({ near: overlapNear, far: fFar });
    }

    return frusta;
}

// ════════════════════════════════════════════════════════════════
// P2 #9: Polyline / Overlay 对数深度一致性工具
// ════════════════════════════════════════════════════════════════

/**
 * 计算对数深度缓冲常数（与 globe_vs 的 applyLogDepth 配套）。
 * 所有 Globe 模式下的渲染图层（polyline、point、extrusion）必须使用相同的常数，
 * 否则会出现 z-fighting（Pipeline v2 §五 + Shape Issues §七 P2 #9）。
 *
 * 公式来源：Outerra / Cesium logarithmic depth buffer
 *   logZ = log2(max(1e-6, clipW + 1.0)) * logDepthBufFC
 *   gl_Position.z = logZ * clipW
 * 其中 logDepthBufFC = 2.0 / log2(farZ + 1.0)
 *
 * @param farZ - 远裁剪面距离（米），必须 > 0
 * @returns logDepthBufFC = 2.0 / log2(farZ + 1.0)
 *
 * @stability stable
 *
 * @example
 * const fc = computeLogDepthBufFC(71190838);
 * // fc ≈ 0.0762... 用于 polyline shader 的 applyLogDepth 函数
 *
 * @example
 * // 在 Globe3D 帧渲染中：
 * const farZ = horizonDist * FAR_PLANE_HORIZON_FACTOR + altitude;
 * const fc = computeLogDepthBufFC(farZ);
 * // 写入所有图层的 uniform buffer
 */
export function computeLogDepthBufFC(farZ: number): number {
    // 防御：farZ <= 0 会导致 log2 返回 -Infinity 或 NaN
    if (farZ <= 0) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) { devWarn('computeLogDepthBufFC: farZ must be > 0, got', farZ); }
        return 2.0 / Math.log2(2.0); // fallback: farZ=1 → fc=2.0
    }
    return 2.0 / Math.log2(farZ + 1.0);
}

/**
 * Polyline / overlay 图层复用的 WGSL 对数深度函数。
 * 必须与 GLOBE_TILE_WGSL 中的 applyLogDepth 完全一致。
 * 
 * 使用方式：在 polyline/point/extrusion 等图层的 WGSL 着色器中嵌入此代码片段，
 * 并在 uniform buffer 中传入与 Globe 瓦片相同的 logDepthBufFC 值
 * （通过 computeLogDepthBufFC(farZ) 计算）。
 *
 * @stability stable
 *
 * @example
 * // 在 ShaderAssembler 中组合 polyline shader：
 * const polylineShaderCode = LOG_DEPTH_WGSL + polylineMainCode;
 */
export const LOG_DEPTH_WGSL = /* wgsl */`
fn applyLogDepth(clipPos: vec4<f32>, logDepthBufFC: f32) -> vec4<f32> {
  var pos = clipPos;
  let logZ = log2(max(1e-6, pos.w + 1.0)) * logDepthBufFC;
  pos.z = logZ * pos.w;
  return pos;
}
`;

// ════════════════════════════════════════════════════════════════
// 模块级复用缓冲（避免帧循环中分配）
// ════════════════════════════════════════════════════════════════

/** geodeticToECEF / ecefToGeodetic 输出暂存 */
const _ecefTmp = new Float64Array(3) as Vec3d;

/** surfaceNormal 输出暂存 */
const _normTmp = new Float64Array(3) as Vec3d;

/** 临时 mat4（投影矩阵计算） */
const _tmpMat4A = mat4.create();

/** 临时 mat4（VP 矩阵计算） */
const _tmpMat4B = mat4.create();

/** 临时 mat4（逆 VP 矩阵计算） */
const _tmpMat4C = mat4.create();

/** 临时 vec3（各种方向/位置计算） */
const _tmpVec3A = vec3.create();
const _tmpVec3B = vec3.create();
const _tmpVec3C = vec3.create();

/** RTE lookAt 用的 Float64 暂存（避免 Float32 精度损失） */
const _ecefCam64 = new Float64Array(3);
const _ecefCenter64 = new Float64Array(3);

/** camera uniform 数据缓冲（96 bytes = 24 floats） */
const _cameraUniformData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);

/** sky uniform 数据缓冲（96 bytes = 24 floats）。vec3 padding 对齐到 16 字节使总大小 96。 */
const _skyUniformData = new Float32Array(SKY_UNIFORM_SIZE / 4);

/** atmo uniform 数据缓冲（80 bytes = 20 floats） */
const _atmoUniformData = new Float32Array(ATMO_UNIFORM_SIZE / 4);

/** tile params uniform 数据缓冲（16 bytes = 4 floats） */
const _tileParamsData = new Float32Array(TILE_PARAMS_SIZE / 4);

// ════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════

/**
 * 数字地球构造选项。
 * 控制容器、影像底图、大气/阴影/天穹/雾效开关、交互约束和初始视角。
 *
 * @example
 * const opts: Globe3DOptions = {
 *   container: '#globe',
 *   imagery: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
 *   atmosphere: true,
 *   center: [116.39, 39.91],
 *   altitude: 5_000_000,
 * };
 */
export interface Globe3DOptions {
    /**
     * 挂载容器：CSS 选择器字符串或已有 HTMLElement。
     * 必填参数，Globe3D 会在容器内创建全尺寸 Canvas。
     */
    readonly container: string | HTMLElement;

    /**
     * 地形数据源配置。
     * 提供 DEM 高程用于地形渲染和高程查询。
     */
    readonly terrain?: {
        /** 地形瓦片 URL 模板或 TileJSON 地址 */
        readonly url: string;
        /** 高程夸大系数；默认 1（真实高度） */
        readonly exaggeration?: number;
    };

    /**
     * 影像底图配置。
     * 默认使用 OpenStreetMap 瓦片服务。
     */
    readonly imagery?: {
        /** 瓦片 URL 模板（支持 {z}/{x}/{y} 占位符） */
        readonly url?: string;
        /** 瓦片方案类型（wmts/tms/xyz 等） */
        readonly type?: string;
        /** 影像瓦片最大级别 */
        readonly maximumLevel?: number;
    };

    /** 是否启用大气层渲染，默认 true */
    readonly atmosphere?: boolean;

    /** 是否启用阴影，默认 false */
    readonly shadows?: boolean;

    /** 是否启用天空盒，默认 true */
    readonly skybox?: boolean;

    /** 是否启用雾效，默认 true */
    readonly fog?: boolean;

    /** 地球底色 RGBA，分量范围 [0,1]，默认深蓝色 */
    readonly baseColor?: [number, number, number, number];

    /** 目标帧率（Hz），默认 60 */
    readonly targetFrameRate?: number;

    /** 是否开启抗锯齿，默认 false */
    readonly antialias?: boolean;

    /** 最大 devicePixelRatio，默认 2.0 */
    readonly maxPixelRatio?: number;

    /** 是否允许鼠标左键拖拽旋转，默认 true */
    readonly enableRotate?: boolean;

    /** 是否允许滚轮缩放，默认 true */
    readonly enableZoom?: boolean;

    /** 是否允许中键拖拽倾斜，默认 true */
    readonly enableTilt?: boolean;

    /** 最小相机距地面距离（米），默认 100 */
    readonly minimumZoomDistance?: number;

    /** 最大相机距地面距离（米），默认 5×10⁷ */
    readonly maximumZoomDistance?: number;

    /** 初始注视点 [lng, lat] 度，默认 [0, 0] */
    readonly center?: [number, number];

    /** 初始相机海拔高度（米），默认 20_000_000 */
    readonly altitude?: number;

    /** 初始方位角（度），默认 0（正北） */
    readonly bearing?: number;

    /** 初始俯仰角（度），默认 -45（45° 俯视） */
    readonly pitch?: number;

    /** 无障碍标题，设置在 Canvas 的 aria-label 上 */
    readonly accessibleTitle?: string;
}

/**
 * 3D 实体描述（模型 / 标牌 / 标签）。
 * 每个实体有唯一 id 和地理位置，可选择性地附带 3D 模型、广告牌纹理或标签文本。
 */
export interface EntitySpec {
    /** 实体 id；省略时由引擎自动生成 */
    readonly id?: string;

    /** 位置 [lon, lat, alt]，单位度/度/米 */
    readonly position: [number, number, number];

    /** glTF 模型配置 */
    readonly model?: {
        /** 模型 URL */
        readonly url: string;
        /** 统一缩放系数 */
        readonly scale?: number;
    };

    /** 广告牌纹理配置 */
    readonly billboard?: {
        /** 图片 URL */
        readonly image: string;
        /** 缩放系数 */
        readonly scale?: number;
    };

    /** 屏幕空间标签配置 */
    readonly label?: {
        /** 文本内容 */
        readonly text: string;
        /** 字体族描述 */
        readonly font?: string;
    };
}

/**
 * 影像图层运行时记录。
 * 存储已添加的影像底图图层的元数据。
 */
interface ImageryLayerRecord {
    /** 图层 id */
    readonly id: string;
    /** 瓦片 URL 模板 */
    readonly url: string;
    /** 类型字符串（wmts/tms/xyz） */
    readonly type: string;
    /** 透明度 [0,1] */
    alpha: number;
}

/**
 * 3D Tiles 运行时记录。
 */
interface TilesetRecord {
    /** 记录 id */
    readonly id: string;
    /** tileset.json URL */
    readonly url: string;
    /** SSE 阈值 */
    maximumScreenSpaceError: number;
    /** 是否可见 */
    show: boolean;
}

/**
 * GeoJSON 图层运行时记录。
 */
interface GeoJsonRecord {
    /** 图层 id */
    readonly id: string;
    /** GeoJSON 数据或 URL */
    data: unknown;
    /** 附加样式选项 */
    options: unknown;
}

/**
 * 缓存的瓦片 GPU 资源。
 * texture + bindGroup 组合为一个缓存条目，加载中的瓦片 loading=true。
 */
// Defensive terrain design (GeoForge_3D_Globe_Shape_Issues §四):
// - textureReady=true + demReady=false → render as flat tile (z=0)
// - textureReady=true + demReady=true  → render as terrain tile
// - textureReady=false → use parent tile placeholder
// - terrainProvider switch: old terrain tiles retained until new data arrives
interface CachedTile {
    /** 瓦片纹理（GPUTexture），加载完成后非 null */
    texture: GPUTexture | null;
    /** 瓦片采样器+纹理 bind group */
    bindGroup: GPUBindGroup | null;
    /** 是否正在加载中 */
    loading: boolean;
    /** 影像纹理是否已就绪（区分"占位中"和"纹理已可渲染"） */
    textureReady: boolean;
    /** DEM 高程数据是否已就绪（false = 以 z=0 平面渲染） */
    demReady: boolean;
    /** DEM 高程数据（Float32Array），null 表示平面瓦片（z=0） */
    demData: Float32Array | null;
}

/**
 * 缓存的瓦片网格 GPU 资源。
 * 极地瓦片（y=0 北极 / y=numTiles-1 南极）使用扇形三角形，索引数量不同于普通瓦片。
 * 因此按 "z/x/y" 键缓存，而非按 zoom 级别共享。
 */
interface CachedMesh {
    /** CPU 端网格数据（用于 RTE 重算） */
    mesh: GlobeTileMesh;
    /** GPU 索引缓冲 */
    indexBuffer: GPUBuffer;
}

/**
 * 渲染器统计信息，对外暴露的只读性能指标。
 */
export interface GlobeRendererStats {
    /** 本帧渲染的瓦片数量 */
    readonly tilesRendered: number;
    /** 瓦片纹理缓存中的条目数 */
    readonly tilesCached: number;
    /** 本帧 GPU draw call 次数 */
    readonly drawCalls: number;
    /** 上一帧耗时（毫秒） */
    readonly frameTimeMs: number;
}

// ════════════════════════════════════════════════════════════════
// Globe3D 主类
// ════════════════════════════════════════════════════════════════

/**
 * Globe3D — 3D 数字地球主入口类（L6 预设层）。
 *
 * 管理完整的 WebGPU 渲染管线，包括：
 * - Canvas 生命周期与容器 DOM
 * - Camera3D 相机控制器（ECEF 坐标系）
 * - 瓦片加载、缓存与曲面细分
 * - 天穹 + 大气 + 地球表面渲染
 * - 鼠标交互（左键轨道旋转、中键倾斜、滚轮缩放）
 * - 2D↔3D 形变（morph）过渡
 *
 * @stability experimental
 *
 * @example
 * const globe = new Globe3D({
 *   container: '#globe',
 *   center: [116.39, 39.91],
 *   altitude: 5_000_000,
 *   atmosphere: true,
 * });
 * globe.ready().then(() => console.log('Globe ready'));
 */
export class Globe3D {
    // ══════ DOM ══════
    /** 挂载容器 */
    private readonly _container: HTMLElement;

    /** 主绘制画布 */
    private readonly _canvas: HTMLCanvasElement;

    // ══════ 相机 ══════
    /** Camera3D 控制器实例 */
    private _camera3D: Camera3D;

    /** 当前视口描述 */
    private _viewport: Viewport;

    /** 上一帧的 CameraState 快照 */
    private _lastCamState: CameraState | null = null;

    /**
     * 上一帧的 GlobeCamera 快照。
     * pickGlobe / _readDepthAtPixel 等异步查询方法需要帧循环外
     * 的 inverseVP_ECEF，所以在 _renderFrame 结尾缓存一份。
     */
    private _lastGlobeCam: GlobeCamera | null = null;

    // ══════ WebGPU 核心 ══════
    /** GPU 设备 */
    private _device: GPUDevice | null = null;

    /** Canvas 上下文 */
    private _gpuContext: GPUCanvasContext | null = null;

    /** 纹理格式 */
    private _surfaceFormat: GPUTextureFormat = 'bgra8unorm';

    /** 深度纹理 */
    private _depthTexture: GPUTexture | null = null;

    /** 深度纹理当前宽度 */
    private _depthW = 0;

    /** 深度纹理当前高度 */
    private _depthH = 0;

    // ══════ 渲染管线 ══════
    /** 地球瓦片管线 */
    private _globePipeline: GPURenderPipeline | null = null;

    /** 天穹管线 */
    private _skyPipeline: GPURenderPipeline | null = null;

    /** 大气管线 */
    private _atmoPipeline: GPURenderPipeline | null = null;

    // ══════ GPU 资源 ══════
    /** 相机 uniform buffer（96 bytes） */
    private _cameraUniformBuffer: GPUBuffer | null = null;

    /** 瓦片 params uniform buffer（16 bytes） */
    private _tileParamsBuffer: GPUBuffer | null = null;

    /** 天穹 uniform buffer（80 bytes） */
    private _skyUniformBuffer: GPUBuffer | null = null;

    /** 大气 uniform buffer（80 bytes） */
    private _atmoUniformBuffer: GPUBuffer | null = null;

    /** 线性采样器 */
    private _sampler: GPUSampler | null = null;

    // ══════ Bind Group Layouts ══════
    /** group(0) = camera uniforms */
    private _cameraBindGroupLayout: GPUBindGroupLayout | null = null;

    /** group(1) = sampler + texture */
    private _tileBindGroupLayout: GPUBindGroupLayout | null = null;

    /** group(2) = tile params */
    private _tileParamsBindGroupLayout: GPUBindGroupLayout | null = null;

    // ══════ Bind Groups ══════
    /** 相机 bind group */
    private _cameraBindGroup: GPUBindGroup | null = null;

    /** 瓦片参数 bind group */
    private _tileParamsBindGroup: GPUBindGroup | null = null;

    // ══════ 瓦片缓存 ══════
    /** 瓦片纹理缓存，key = "z/x/y" */
    private readonly _tileCache: Map<string, CachedTile> = new Map();

    /** 瓦片 LRU 顺序（最近使用排在末尾） */
    private readonly _tileLRU: string[] = [];

    /** 网格缓存，key = zoom 级别 */
    private readonly _meshCache: Map<string, CachedMesh> = new Map();

    // ══════ 图层/实体 ══════
    /** 影像图层表 */
    private readonly _imageryLayers: Map<string, ImageryLayerRecord> = new Map();

    /** 3D Tiles 表 */
    private readonly _tilesets: Map<string, TilesetRecord> = new Map();

    /** GeoJSON 图层表 */
    private readonly _geoJsonLayers: Map<string, GeoJsonRecord> = new Map();

    /** 实体表 */
    private readonly _entities: Map<string, EntitySpec> = new Map();

    // ══════ 状态 ══════
    /** 事件监听器 */
    private readonly _listeners: Map<string, Set<(e: unknown) => void>> = new Map();

    /** 是否已销毁 */
    private _destroyed = false;

    /** 帧循环 requestAnimationFrame ID */
    private _rafId = 0;

    /** 上一帧时间戳（ms） */
    private _lastFrameTime = 0;

    /** 帧计数器（诊断用） */
    private _frameCount = 0;

    /** ready Promise 的 resolve 回调 */
    private _readyResolve: (() => void) | null = null;

    /** ready Promise */
    private readonly _readyPromise: Promise<void>;

    /** 当前是否正在异步初始化 */
    private _bootstrapping = false;

    // ══════ 渲染选项 ══════
    /** 大气层开关 */
    private _atmosphere: boolean;

    /** 阴影开关 */
    private _shadows: boolean;

    /** 天空盒开关 */
    private _skybox: boolean;

    /** 雾效开关 */
    private _fog: boolean;

    /** 仿真时间（太阳位置、阴影方向） */
    private _dateTime: Date;

    /** 时钟倍速 */
    private _clockMultiplier: number;

    /** 当前视图模式 */
    private _viewMode: '2d' | '25d' | '3d' = '3d';

    /** 地形夸大系数 */
    private _terrainExaggeration: number;

    /** 影像瓦片 URL 模板 */
    private _tileUrlTemplate: string;

    /** 最大像素比 */
    private readonly _maxPixelRatio: number;

    // ══════ 交互 ══════
    /** 交互：旋转 */
    private readonly _enableRotate: boolean;

    /** 交互：缩放 */
    private readonly _enableZoom: boolean;

    /** 交互：倾斜 */
    private readonly _enableTilt: boolean;

    /** 最近距离（米） */
    private readonly _minimumZoomDistance: number;

    /** 最远距离（米） */
    private readonly _maximumZoomDistance: number;

    /** 鼠标是否正在拖拽 */
    private _isDragging = false;

    /** 当前拖拽按钮（0=左键 orbit, 1=中键 rotate） */
    private _dragButton = -1;

    /** ResizeObserver 句柄 */
    private _resizeObserver: ResizeObserver | null = null;

    // ══════ morph 动画 ══════
    /** morph 动画是否正在进行 */
    private _morphing = false;

    /** morph 动画开始时间 */
    private _morphStartTime = 0;

    /** morph 目标持续时间 */
    private _morphDuration = 0;

    /** morph 目标模式 */
    private _morphTarget: '2d' | '25d' | '3d' = '3d';

    // ══════ 统计 ══════
    /** 上一帧渲染的瓦片数 */
    private _statsTilesRendered = 0;

    /** 上一帧 draw call 数 */
    private _statsDrawCalls = 0;

    /** 上一帧耗时（ms） */
    private _statsFrameTimeMs = 0;

    // ══════ 绑定的事件处理器引用（用于移除） ══════
    private readonly _boundMouseDown: (e: MouseEvent) => void;
    private readonly _boundMouseMove: (e: MouseEvent) => void;
    private readonly _boundMouseUp: (e: MouseEvent) => void;
    private readonly _boundWheel: (e: WheelEvent) => void;
    private readonly _boundContextMenu: (e: Event) => void;

    // ════════════════════════════════════════════════════════════
    // 构造函数
    // ════════════════════════════════════════════════════════════

    /**
     * 创建 Globe3D 实例。
     * 同步解析容器/创建 Canvas/初始化 Camera3D，异步启动 WebGPU。
     *
     * @param options - 数字地球构造选项
     * @throws {GeoForgeError} 容器无效时抛出 CONFIG_INVALID_CONTAINER
     *
     * @example
     * const globe = new Globe3D({ container: '#globe' });
     * await globe.ready();
     */
    constructor(options: Globe3DOptions) {
        // ── 解析容器 DOM ──
        this._container = this._resolveContainer(options.container);

        // ── 创建全尺寸 Canvas ──
        this._canvas = document.createElement('canvas');
        this._canvas.style.display = 'block';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.touchAction = 'none';

        // 无障碍标题
        if (options.accessibleTitle) {
            this._canvas.setAttribute('aria-label', options.accessibleTitle);
        } else {
            this._canvas.setAttribute('aria-label', 'GeoForge 3D Globe');
        }

        // 容器必须是定位元素，才能让 Canvas 的 100% 尺寸生效
        if (getComputedStyle(this._container).position === 'static') {
            this._container.style.position = 'relative';
        }
        this._container.style.overflow = 'hidden';

        // 将 Canvas 挂到容器
        this._container.appendChild(this._canvas);

        // ── 最大像素比 ──
        this._maxPixelRatio = options.maxPixelRatio ?? MAX_DEFAULT_PIXEL_RATIO;

        // ── 初始化 Canvas 尺寸 ──
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // ── 渲染选项 ──
        this._atmosphere = options.atmosphere !== false;
        this._shadows = options.shadows === true;
        this._skybox = options.skybox !== false;
        this._fog = options.fog !== false;
        this._dateTime = new Date();
        this._clockMultiplier = DEFAULT_CLOCK_MULTIPLIER;
        this._terrainExaggeration = options.terrain?.exaggeration ?? DEFAULT_TERRAIN_EXAGGERATION;

        // ── 影像 URL ──
        this._tileUrlTemplate = options.imagery?.url ?? TILE_URL_TEMPLATE_DEFAULT;

        // ── 交互选项 ──
        this._enableRotate = options.enableRotate !== false;
        this._enableZoom = options.enableZoom !== false;
        this._enableTilt = options.enableTilt !== false;
        this._minimumZoomDistance = options.minimumZoomDistance ?? 100;
        this._maximumZoomDistance = options.maximumZoomDistance ?? 5e7;

        // ── 初始相机参数 ──
        const initCenter = options.center ?? [0, 0];
        const initAlt = options.altitude ?? DEFAULT_ALTITUDE;
        const initBearingRad = (options.bearing ?? 0) * DEG2RAD;
        const initPitchRad = (options.pitch ?? -45) * DEG2RAD;

        // ── 创建 Camera3D ──
        this._camera3D = createCamera3D({
            position: { lon: initCenter[0], lat: initCenter[1], alt: initAlt },
            bearing: initBearingRad,
            pitch: initPitchRad,
            fov: DEFAULT_FOV,
            minimumZoomDistance: this._minimumZoomDistance,
            maximumZoomDistance: this._maximumZoomDistance,
        });

        // ── 绑定交互事件处理器 ──
        this._boundMouseDown = this._onMouseDown.bind(this);
        this._boundMouseMove = this._onMouseMove.bind(this);
        this._boundMouseUp = this._onMouseUp.bind(this);
        this._boundWheel = this._onWheel.bind(this);
        this._boundContextMenu = (e: Event) => { e.preventDefault(); };

        // ── 安装交互监听 ──
        this._installInteractions();

        // ── ResizeObserver 监听容器尺寸变化 ──
        this._resizeObserver = new ResizeObserver(() => {
            if (!this._destroyed) { this.resize(); }
        });
        this._resizeObserver.observe(this._container);

        // ── ready promise ──
        this._readyPromise = new Promise<void>((resolve) => {
            this._readyResolve = resolve;
        });

        // ── 异步启动 WebGPU ──
        this._bootstrapAsync().catch((err) => {
            devError('[Globe3D] bootstrap failed:', err);
        });
    }

    // ════════════════════════════════════════════════════════════
    // Public Getters
    // ════════════════════════════════════════════════════════════

    /**
     * 获取 Camera3D 控制器实例（逃生舱口）。
     *
     * @returns Camera3D 实例
     *
     * @example
     * const cam = globe.camera;
     * cam.setPosition(121.47, 31.23, 500_000);
     */
    get camera(): Camera3D {
        return this._camera3D;
    }

    /**
     * 获取渲染器统计信息。
     *
     * @returns 只读的渲染性能指标
     *
     * @example
     * const stats = globe.renderer;
     * console.log(`Tiles: ${stats.tilesRendered}, DrawCalls: ${stats.drawCalls}`);
     */
    get renderer(): GlobeRendererStats {
        return {
            tilesRendered: this._statsTilesRendered,
            tilesCached: this._tileCache.size,
            drawCalls: this._statsDrawCalls,
            frameTimeMs: this._statsFrameTimeMs,
        };
    }

    /**
     * 获取当前视图模式。
     *
     * @returns '2d' | '25d' | '3d'
     *
     * @example
     * if (globe.currentViewMode === '3d') { ... }
     */
    get currentViewMode(): '2d' | '25d' | '3d' {
        return this._viewMode;
    }

    // ════════════════════════════════════════════════════════════
    // 生命周期
    // ════════════════════════════════════════════════════════════

    /**
     * 等待 Globe3D 完成异步初始化（WebGPU 设备创建、管线编译）。
     *
     * @returns 初始化完成后 resolve 的 Promise
     *
     * @example
     * await globe.ready();
     * globe.flyTo({ center: [121.47, 31.23], altitude: 1_000_000 });
     */
    public ready(): Promise<void> {
        return this._readyPromise;
    }

    /**
     * 获取主绘制画布元素。
     *
     * @returns Canvas HTMLElement
     *
     * @example
     * const canvas = globe.getCanvas();
     * canvas.style.cursor = 'crosshair';
     */
    public getCanvas(): HTMLCanvasElement {
        this._ensureAlive();
        return this._canvas;
    }

    /**
     * 获取挂载容器元素。
     *
     * @returns 容器 HTMLElement
     *
     * @example
     * const container = globe.getContainer();
     */
    public getContainer(): HTMLElement {
        this._ensureAlive();
        return this._container;
    }

    /**
     * 响应容器尺寸变化，重新计算 Canvas 大小和视口参数。
     *
     * @example
     * window.addEventListener('resize', () => globe.resize());
     */
    public resize(): void {
        this._ensureAlive();

        // 重新计算 Canvas 尺寸和视口
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // 标记深度纹理需要重建（_renderFrame 中检查）
        this._depthW = 0;
        this._depthH = 0;
    }

    /**
     * 销毁 Globe3D 实例，释放所有 GPU 资源和 DOM 元素。
     * 调用后实例不可再使用。
     *
     * @example
     * globe.remove();
     */
    public remove(): void {
        if (this._destroyed) { return; }
        this._destroyed = true;

        // 停止帧循环
        if (this._rafId !== 0) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        // 移除交互监听
        this._canvas.removeEventListener('mousedown', this._boundMouseDown);
        window.removeEventListener('mousemove', this._boundMouseMove);
        window.removeEventListener('mouseup', this._boundMouseUp);
        this._canvas.removeEventListener('wheel', this._boundWheel);
        this._canvas.removeEventListener('contextmenu', this._boundContextMenu);

        // 停止 ResizeObserver
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // 销毁 Camera3D
        this._camera3D.destroy();

        // 销毁 GPU 资源
        this._destroyGPUResources();

        // 移除 Canvas
        if (this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }

        // 清空事件监听
        this._listeners.clear();

        // 发出销毁事件
        this._emit('remove', undefined);
    }

    // ════════════════════════════════════════════════════════════
    // 相机视图 API
    // ════════════════════════════════════════════════════════════

    /**
     * 获取当前连续 zoom 级别。
     * zoom=0 为全球视图，每增加 1 级分辨率翻倍。
     *
     * @returns zoom 浮点值
     *
     * @example
     * const z = globe.getZoom(); // 5.3
     */
    public getZoom(): number {
        this._ensureAlive();
        // 从相机状态获取 zoom
        const state = this._lastCamState;
        if (state) { return state.zoom; }
        // fallback: 从 altitude 换算
        const pos = this._camera3D.getPosition();
        return Math.log2(ZOOM_ALTITUDE_C / Math.max(pos.alt, 1));
    }

    /**
     * 获取当前方位角（度）。
     *
     * @returns bearing 度值
     *
     * @example
     * const bearing = globe.getBearing(); // 45.0
     */
    public getBearing(): number {
        this._ensureAlive();
        const orient = this._camera3D.getOrientation();
        return orient.bearing * RAD2DEG;
    }

    /**
     * 获取当前俯仰角（度）。
     *
     * @returns pitch 度值
     *
     * @example
     * const pitch = globe.getPitch(); // -45.0
     */
    public getPitch(): number {
        this._ensureAlive();
        const orient = this._camera3D.getOrientation();
        return orient.pitch * RAD2DEG;
    }

    /**
     * 获取完整相机位置和姿态。
     *
     * @returns 包含 lon/lat/alt/bearing/pitch/roll 的对象
     *
     * @example
     * const pos = globe.getCameraPosition();
     * console.log(`${pos.lon}°, ${pos.lat}°, ${pos.alt}m`);
     */
    public getCameraPosition(): {
        lon: number; lat: number; alt: number;
        bearing: number; pitch: number; roll: number;
    } {
        this._ensureAlive();
        const pos = this._camera3D.getPosition();
        const orient = this._camera3D.getOrientation();
        return {
            lon: pos.lon,
            lat: pos.lat,
            alt: pos.alt,
            bearing: orient.bearing * RAD2DEG,
            pitch: orient.pitch * RAD2DEG,
            roll: orient.roll * RAD2DEG,
        };
    }

    /**
     * 设置相机位置和姿态。
     * 所有参数以度/米为单位，bearing/pitch/roll 为度。
     *
     * @param pos - 位置和姿态对象
     *
     * @example
     * globe.setCameraPosition({ lon: 116.39, lat: 39.91, alt: 500_000, bearing: 45, pitch: -30, roll: 0 });
     */
    public setCameraPosition(pos: {
        lon?: number; lat?: number; alt?: number;
        bearing?: number; pitch?: number; roll?: number;
    }): void {
        this._ensureAlive();

        // 获取当前值作为默认
        const curPos = this._camera3D.getPosition();
        const curOrient = this._camera3D.getOrientation();

        const lon = pos.lon ?? curPos.lon;
        const lat = pos.lat ?? curPos.lat;
        const alt = pos.alt ?? curPos.alt;

        // 设置位置
        this._camera3D.setPosition(lon, lat, alt);

        // 设置姿态（入参为度，Camera3D 需要弧度）
        const bearing = (pos.bearing !== undefined) ? pos.bearing * DEG2RAD : curOrient.bearing;
        const pitch = (pos.pitch !== undefined) ? pos.pitch * DEG2RAD : curOrient.pitch;
        const roll = (pos.roll !== undefined) ? pos.roll * DEG2RAD : curOrient.roll;
        this._camera3D.setOrientation(bearing, pitch, roll);
    }

    /**
     * 飞行到指定位置/姿态，沿大圆弧平滑过渡。
     *
     * @param options - 目标参数（center=[lng,lat]度, altitude米, bearing/pitch度, duration毫秒）
     *
     * @example
     * globe.flyTo({ center: [121.47, 31.23], altitude: 500_000, bearing: 0, pitch: -45, duration: 3000 });
     */
    public flyTo(options: {
        center?: [number, number];
        altitude?: number;
        zoom?: number;
        bearing?: number;
        pitch?: number;
        duration?: number;
    }): void {
        this._ensureAlive();

        // 计算目标高度：优先使用 altitude，其次从 zoom 换算
        let alt = options.altitude;
        if (alt === undefined && options.zoom !== undefined) {
            alt = ZOOM_ALTITUDE_C / Math.pow(2, options.zoom);
        }

        const curPos = this._camera3D.getPosition();
        const curOrient = this._camera3D.getOrientation();

        // Camera3D.flyToPosition 需要弧度角度
        this._camera3D.flyToPosition({
            lon: options.center ? options.center[0] : curPos.lon,
            lat: options.center ? options.center[1] : curPos.lat,
            alt: alt ?? curPos.alt,
            bearing: options.bearing !== undefined ? options.bearing * DEG2RAD : curOrient.bearing,
            pitch: options.pitch !== undefined ? options.pitch * DEG2RAD : curOrient.pitch,
            duration: options.duration ?? DEFAULT_FLIGHT_DURATION_MS,
        });
    }

    /**
     * 将相机朝向指定目标点，可选偏移。
     *
     * @param target - 目标点 [lon(度), lat(度), alt(米)]
     * @param offset - 可选偏移：{ bearing(度), pitch(度), range(米) }
     *
     * @example
     * globe.lookAt([116.39, 39.91, 0], { bearing: 45, pitch: -30, range: 100_000 });
     */
    public lookAt(
        target: [number, number, number],
        offset?: { bearing?: number; pitch?: number; range?: number },
    ): void {
        this._ensureAlive();

        // Camera3D.lookAt 接受弧度角度
        this._camera3D.lookAt(target, offset ? {
            bearing: offset.bearing !== undefined ? offset.bearing * DEG2RAD : undefined,
            pitch: offset.pitch !== undefined ? offset.pitch * DEG2RAD : undefined,
            range: offset.range,
        } : undefined);
    }

    /**
     * 飞行到适配指定地理范围的视角。
     *
     * @param bounds - 地理包围盒 { west, south, east, north } 度
     * @param options - 附加选项 { padding?, duration? }
     *
     * @example
     * globe.flyToBounds({ west: 73, south: 18, east: 135, north: 53 }, { duration: 2000 });
     */
    public flyToBounds(
        bounds: BBox2D,
        options?: { padding?: number; duration?: number },
    ): void {
        this._ensureAlive();

        // 计算中心经纬度
        const centerLng = (bounds.west + bounds.east) / 2;
        const centerLat = (bounds.south + bounds.north) / 2;

        // 估算需要的高度：使用经度跨度和视口宽高比
        const lngSpan = Math.abs(bounds.east - bounds.west);
        const latSpan = Math.abs(bounds.north - bounds.south);
        const maxSpan = Math.max(lngSpan, latSpan);

        // 近似：将角度跨度换算为地面距离，然后根据 FOV 计算高度
        const groundDist = maxSpan * DEG2RAD * WGS84_A;
        const fov = DEFAULT_FOV;
        const alt = (groundDist / 2) / Math.tan(fov / 2);

        // 加上 padding 余量
        const padding = options?.padding ?? 0;
        const paddedAlt = alt * (1 + padding / 100);

        this.flyTo({
            center: [centerLng, centerLat],
            altitude: paddedAlt,
            duration: options?.duration ?? DEFAULT_FLIGHT_DURATION_MS,
        });
    }

    // ════════════════════════════════════════════════════════════
    // 图层管理 API
    // ════════════════════════════════════════════════════════════

    /**
     * 添加影像底图图层。
     *
     * @param options - 图层配置 { url, type?, alpha? }
     * @returns 图层 id
     *
     * @example
     * const id = globe.addImageryLayer({ url: 'https://tiles.example.com/{z}/{x}/{y}.png' });
     */
    public addImageryLayer(options: {
        url: string;
        type?: string;
        alpha?: number;
        id?: string;
    }): string {
        this._ensureAlive();

        const id = options.id ?? uniqueId('imagery');

        // 防止重复 id
        if (this._imageryLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `Imagery layer id "${id}" already exists`,
                { id },
            );
        }

        this._imageryLayers.set(id, {
            id,
            url: options.url,
            type: options.type ?? 'xyz',
            alpha: options.alpha ?? 1.0,
        });

        // 切换瓦片 URL 模板为最新添加的图层
        this._tileUrlTemplate = options.url;

        // 清空缓存以加载新瓦片
        this._clearTileCache();

        this._emit('imageryLayer:added', { id });
        return id;
    }

    /**
     * 移除影像底图图层。
     *
     * @param id - 图层 id
     *
     * @example
     * globe.removeImageryLayer('imagery_1');
     */
    public removeImageryLayer(id: string): void {
        this._ensureAlive();

        if (!this._imageryLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `Imagery layer "${id}" not found`,
                { id },
            );
        }

        this._imageryLayers.delete(id);

        // 回退到默认 URL 或最后一个图层
        if (this._imageryLayers.size > 0) {
            const last = Array.from(this._imageryLayers.values()).pop()!;
            this._tileUrlTemplate = last.url;
        } else {
            this._tileUrlTemplate = TILE_URL_TEMPLATE_DEFAULT;
        }

        this._clearTileCache();
        this._emit('imageryLayer:removed', { id });
    }

    /**
     * 添加 3D Tiles 数据集。
     *
     * @param options - 数据集配置
     * @returns 记录 id
     *
     * @example
     * const id = globe.add3DTileset({ url: 'https://example.com/tileset.json' });
     */
    public add3DTileset(options: {
        url: string;
        maximumScreenSpaceError?: number;
        show?: boolean;
        id?: string;
    }): string {
        this._ensureAlive();

        const id = options.id ?? uniqueId('tileset');

        if (this._tilesets.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `3D Tileset id "${id}" already exists`,
                { id },
            );
        }

        this._tilesets.set(id, {
            id,
            url: options.url,
            maximumScreenSpaceError: options.maximumScreenSpaceError ?? 16,
            show: options.show !== false,
        });

        this._emit('tileset:added', { id });
        return id;
    }

    /**
     * 移除 3D Tiles 数据集。
     *
     * @param id - 数据集 id
     *
     * @example
     * globe.remove3DTileset('tileset_1');
     */
    public remove3DTileset(id: string): void {
        this._ensureAlive();

        if (!this._tilesets.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `3D Tileset "${id}" not found`,
                { id },
            );
        }

        this._tilesets.delete(id);
        this._emit('tileset:removed', { id });
    }

    /**
     * 添加 GeoJSON 数据图层。
     *
     * @param data - GeoJSON 数据对象或 URL
     * @param options - 样式选项
     * @returns 图层 id
     *
     * @example
     * const id = globe.addGeoJSON(geojsonData, { color: 'red', lineWidth: 2 });
     */
    public addGeoJSON(data: unknown, options?: { id?: string; [key: string]: unknown }): string {
        this._ensureAlive();

        const id = options?.id as string ?? uniqueId('geojson');

        if (this._geoJsonLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `GeoJSON layer id "${id}" already exists`,
                { id },
            );
        }

        this._geoJsonLayers.set(id, { id, data, options });

        this._emit('geojson:added', { id });
        return id;
    }

    /**
     * 移除 GeoJSON 图层。
     *
     * @param id - 图层 id
     *
     * @example
     * globe.removeGeoJSON('geojson_1');
     */
    public removeGeoJSON(id: string): void {
        this._ensureAlive();

        if (!this._geoJsonLayers.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `GeoJSON layer "${id}" not found`,
                { id },
            );
        }

        this._geoJsonLayers.delete(id);
        this._emit('geojson:removed', { id });
    }

    /**
     * 添加 3D 实体（模型/标牌/标签）。
     *
     * @param entity - 实体描述
     * @returns 实体 id
     *
     * @example
     * const id = globe.addEntity({ position: [116.39, 39.91, 100], label: { text: 'Beijing' } });
     */
    public addEntity(entity: EntitySpec): string {
        this._ensureAlive();

        const id = entity.id ?? uniqueId('entity');
        const spec: EntitySpec = { ...entity, id };

        if (this._entities.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_ID,
                `Entity id "${id}" already exists`,
                { id },
            );
        }

        this._entities.set(id, spec);
        this._emit('entity:added', { id });
        return id;
    }

    /**
     * 移除 3D 实体。
     *
     * @param id - 实体 id
     *
     * @example
     * globe.removeEntity('entity_1');
     */
    public removeEntity(id: string): void {
        this._ensureAlive();

        if (!this._entities.has(id)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_NOT_FOUND,
                `Entity "${id}" not found`,
                { id },
            );
        }

        this._entities.delete(id);
        this._emit('entity:removed', { id });
    }

    // ════════════════════════════════════════════════════════════
    // 查询 API
    // ════════════════════════════════════════════════════════════

    /**
     * 查询屏幕坐标处已渲染的要素（异步，需要 GPU readback）。
     *
     * @param point - 屏幕坐标 [x, y]（CSS 像素），省略则查询全视口
     * @param options - 过滤选项 { layers? }
     * @returns 命中的要素数组
     *
     * @example
     * const features = await globe.queryRenderedFeatures([400, 300]);
     */
    public async queryRenderedFeatures(
        point?: [number, number],
        options?: { layers?: string[] },
    ): Promise<Feature[]> {
        this._ensureAlive();

        // 当前 MVP 阶段返回空数组，后续接入 PickingEngine
        return [];
    }

    // ════════════════════════════════════════════════════════════
    // 地形/环境 API
    // ════════════════════════════════════════════════════════════

    /**
     * 设置地形高程夸大系数。
     *
     * @param value - 夸大系数（>= 0），1.0 = 真实高度
     *
     * @example
     * globe.setTerrainExaggeration(2.5);
     */
    public setTerrainExaggeration(value: number): void {
        this._ensureAlive();
        this._validatePositive(value, 'terrainExaggeration');
        this._terrainExaggeration = value;
    }

    /**
     * 查询指定经纬度处的地形高程（异步）。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @returns 地形高度（米），无数据时返回 0
     *
     * @example
     * const h = await globe.getTerrainHeight(86.92, 27.99); // 珠峰
     */
    public async getTerrainHeight(lon: number, lat: number): Promise<number> {
        this._ensureAlive();

        // 通过 Camera3D 的地形查询接口
        try {
            return await this._camera3D.queryTerrainHeight(lon, lat);
        } catch {
            // 无地形数据时回退 0
            return 0;
        }
    }

    /**
     * 启用/禁用大气层渲染。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setAtmosphereEnabled(false);
     */
    public setAtmosphereEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._atmosphere = enabled;
    }

    /**
     * 启用/禁用阴影。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setShadowsEnabled(true);
     */
    public setShadowsEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._shadows = enabled;
    }

    /**
     * 启用/禁用天空盒渲染。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setSkyboxEnabled(false);
     */
    public setSkyboxEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._skybox = enabled;
    }

    /**
     * 启用/禁用雾效。
     *
     * @param enabled - 是否启用
     *
     * @example
     * globe.setFogEnabled(false);
     */
    public setFogEnabled(enabled: boolean): void {
        this._ensureAlive();
        this._fog = enabled;
    }

    /**
     * 设置仿真日期时间（影响太阳位置和阴影方向）。
     *
     * @param date - 目标时间
     *
     * @example
     * globe.setDateTime(new Date('2025-06-21T12:00:00Z'));
     */
    public setDateTime(date: Date): void {
        this._ensureAlive();
        this._dateTime = date;
    }

    /**
     * 获取当前仿真日期时间。
     *
     * @returns 仿真时间
     *
     * @example
     * const dt = globe.getDateTime();
     */
    public getDateTime(): Date {
        this._ensureAlive();
        return this._dateTime;
    }

    /**
     * 设置时钟倍速（加速/减速仿真时间流逝）。
     *
     * @param multiplier - 倍速值（>= 0），1.0 = 实时
     *
     * @example
     * globe.setClockMultiplier(60); // 1分钟=1秒
     */
    public setClockMultiplier(multiplier: number): void {
        this._ensureAlive();
        this._validatePositive(multiplier, 'clockMultiplier');
        this._clockMultiplier = multiplier;
    }

    // ════════════════════════════════════════════════════════════
    // 坐标转换 API
    // ════════════════════════════════════════════════════════════

    /**
     * 地理坐标 → 屏幕像素坐标。
     * 如果点不在视口内（被地球遮挡或裁剪），返回 null。
     *
     * @param lon - 经度（度）
     * @param lat - 纬度（度）
     * @param alt - 海拔（米），默认 0
     * @returns [screenX, screenY] CSS 像素坐标，或 null
     *
     * @example
     * const px = globe.cartographicToScreen(116.39, 39.91);
     * if (px) { tooltip.style.left = px[0] + 'px'; tooltip.style.top = px[1] + 'px'; }
     */
    public cartographicToScreen(lon: number, lat: number, alt?: number): [number, number] | null {
        this._ensureAlive();

        const camState = this._lastCamState;
        if (!camState) { return null; }

        // 经纬度→ECEF
        const lonRad = lon * DEG2RAD;
        const latRad = lat * DEG2RAD;
        geodeticToECEF(_ecefTmp, lonRad, latRad, alt ?? 0);

        // ECEF→RTE（相对相机位置）
        const camPos = camState.position;
        const rx = _ecefTmp[0] - camPos[0];
        const ry = _ecefTmp[1] - camPos[1];
        const rz = _ecefTmp[2] - camPos[2];

        // RTE → clip space (vpMatrix × [rx, ry, rz, 1])
        const vp = camState.vpMatrix;
        const cx = vp[0] * rx + vp[4] * ry + vp[8] * rz + vp[12];
        const cy = vp[1] * rx + vp[5] * ry + vp[9] * rz + vp[13];
        const cz = vp[2] * rx + vp[6] * ry + vp[10] * rz + vp[14];
        const cw = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];

        // 透视除法
        if (Math.abs(cw) < 1e-10) { return null; }
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        const ndcZ = cz / cw;

        // 裁剪检查：NDC 必须在 [-1,1] 范围内，Z 在 [0,1]
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < 0 || ndcZ > 1) {
            return null;
        }

        // NDC → 屏幕像素
        const screenX = (ndcX * 0.5 + 0.5) * this._viewport.width;
        const screenY = (1 - (ndcY * 0.5 + 0.5)) * this._viewport.height;

        return [screenX, screenY];
    }

    /**
     * 屏幕像素坐标 → 地理坐标。
     * 通过 ray-ellipsoid intersection 求交。
     *
     * @param x - 屏幕 X（CSS 像素）
     * @param y - 屏幕 Y（CSS 像素）
     * @returns [lng, lat, alt] 度/米，或 null（射线不与地球相交）
     *
     * @example
     * const geo = globe.screenToCartographic(400, 300);
     * if (geo) { console.log(`${geo[0]}°, ${geo[1]}°`); }
     */
    public screenToCartographic(x: number, y: number): [number, number, number] | null {
        this._ensureAlive();

        const camState = this._lastCamState;
        if (!camState) { return null; }

        // 需要 ECEF 空间的 inverseVP 矩阵
        const globeCam = this._computeGlobeCamera(camState, this._viewport);
        const hit = screenToGlobe(
            x, y,
            globeCam.inverseVP_ECEF,
            this._viewport.width,
            this._viewport.height,
        );

        if (!hit) { return null; }

        // screenToGlobe 返回地表交点，alt=0
        return [hit[0], hit[1], 0];
    }

    // ════════════════════════════════════════════════════════════
    // GPU Picking（深度读回 + 射线求交）
    // ════════════════════════════════════════════════════════════

    /**
     * 屏幕像素坐标 → 地球表面 ECEF 位置（异步）。
     *
     * 当前实现使用 ray-ellipsoid intersection（screenToGlobe）；
     * 后续可通过 `_readDepthAtPixel` 读取 GPU 深度缓冲获得精确
     * 三维交点（含地形高程）。
     *
     * @param screenX - 屏幕 X（CSS 像素）
     * @param screenY - 屏幕 Y（CSS 像素）
     * @returns [lng, lat, altitude] 度/米，或 null（射线不与地球相交）
     *
     * @stability experimental
     *
     * @example
     * const result = await globe.pickGlobe(400, 300);
     * if (result) { console.log(`lng=${result[0]}, lat=${result[1]}, alt=${result[2]}`); }
     */
    public async pickGlobe(screenX: number, screenY: number): Promise<[number, number, number] | null> {
        this._ensureAlive();

        // 需要至少渲染过一帧才能获取 GlobeCamera
        if (!this._lastGlobeCam) { return null; }

        const gc = this._lastGlobeCam;

        // 射线-椭球求交（screenToGlobe 返回 [lng, lat] 度 或 null）
        const hit = screenToGlobe(
            screenX, screenY,
            gc.inverseVP_ECEF,
            gc.viewportWidth, gc.viewportHeight,
        );

        if (!hit) { return null; }

        // 返回 [lng, lat, altitude=0]（地表交点，无地形高程）
        return [hit[0], hit[1], 0];
    }

    /**
     * 读取深度缓冲中指定像素的深度值（GPU → CPU 异步读回）。
     *
     * 流程：
     * 1. 创建 1×1 staging buffer（256 字节，WebGPU 最小映射尺寸）
     * 2. 将深度纹理 (x,y) 处 1×1 像素复制到 staging buffer
     * 3. mapAsync 映射 → 读取 depth32float 值
     * 4. 返回深度值（0~1 范围；Reversed-Z 下 0.0=远平面，1.0=近平面）
     *
     * @param x - 屏幕 X（CSS 像素）
     * @param y - 屏幕 Y（CSS 像素）
     * @returns 深度值（0~1），或 null（坐标越界/无深度/背景像素）
     *
     * @stability experimental
     *
     * @example
     * const depth = await this._readDepthAtPixel(400, 300);
     * if (depth !== null) { console.log(`depth = ${depth}`); }
     */
    private async _readDepthAtPixel(x: number, y: number): Promise<number | null> {
        const device = this._device;

        // GPU 设备或深度纹理不可用
        if (!device || !this._depthTexture) { return null; }

        // CSS 像素 → 物理像素（考虑设备像素比）
        const px = Math.round(x * this._viewport.pixelRatio);
        const py = Math.round(y * this._viewport.pixelRatio);

        // 边界检查：物理坐标必须在深度纹理范围内
        if (px < 0 || px >= this._depthTexture.width || py < 0 || py >= this._depthTexture.height) {
            return null;
        }

        // WebGPU 要求 buffer mapping 最小 256 字节，depth32float = 4 bytes/pixel
        const STAGING_BUFFER_SIZE = 256;

        // 创建临时 staging buffer（MAP_READ 用于 CPU 回读）
        const stagingBuffer = device.createBuffer({
            size: STAGING_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: 'Globe3D:depthReadback',
        });

        // 编码 GPU 命令：深度纹理 → staging buffer（1×1 像素拷贝）
        const encoder = device.createCommandEncoder({ label: 'Globe3D:depthCopy' });
        encoder.copyTextureToBuffer(
            { texture: this._depthTexture, origin: { x: px, y: py } },
            { buffer: stagingBuffer, bytesPerRow: STAGING_BUFFER_SIZE },
            { width: 1, height: 1 },
        );
        device.queue.submit([encoder.finish()]);

        // 等待 GPU → CPU 传输完成
        await stagingBuffer.mapAsync(GPUMapMode.READ);

        // 读取第一个 float32（depth 值）
        const data = new Float32Array(stagingBuffer.getMappedRange(0, 4));
        const depth = data[0];

        // 释放 staging buffer 资源
        stagingBuffer.unmap();
        stagingBuffer.destroy();

        // Reversed-Z: depth ≈ 0.0 表示远平面（背景/天空），无有效几何体
        // 此处阈值 0.0001 过滤掉背景像素
        if (depth <= 0.0001) { return null; }

        return depth;
    }

    // ════════════════════════════════════════════════════════════
    // Morph API（2D↔3D 视图过渡）
    // ════════════════════════════════════════════════════════════

    /**
     * 从当前视图过渡到 2D 模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo2D({ duration: 2000 });
     */
    public morphTo2D(options?: { duration?: number }): void {
        this._ensureAlive();
        this._runMorph('2d', options?.duration ?? MORPH_DEFAULT_DURATION_MS);
    }

    /**
     * 从当前视图过渡到 2.5D 模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo25D({ duration: 1500 });
     */
    public morphTo25D(options?: { duration?: number }): void {
        this._ensureAlive();
        this._runMorph('25d', options?.duration ?? MORPH_DEFAULT_DURATION_MS);
    }

    /**
     * 从当前视图过渡到 3D 球体模式。
     *
     * @param options - { duration? }（毫秒）
     *
     * @example
     * globe.morphTo3D({ duration: 1000 });
     */
    public morphTo3D(options?: { duration?: number }): void {
        this._ensureAlive();
        this._runMorph('3d', options?.duration ?? MORPH_DEFAULT_DURATION_MS);
    }

    // ════════════════════════════════════════════════════════════
    // 事件 API
    // ════════════════════════════════════════════════════════════

    /**
     * 注册事件监听器。
     *
     * @param type - 事件类型（'click' | 'move' | 'remove' | 'load' 等）
     * @param callback - 回调函数
     *
     * @example
     * globe.on('click', (e) => console.log('clicked at', e));
     */
    public on(type: string, callback: (e: unknown) => void): void {
        this._ensureAlive();

        if (!this._listeners.has(type)) {
            this._listeners.set(type, new Set());
        }

        this._listeners.get(type)!.add(callback);
    }

    /**
     * 移除事件监听器。
     *
     * @param type - 事件类型
     * @param callback - 之前注册的回调函数引用
     *
     * @example
     * globe.off('click', handler);
     */
    public off(type: string, callback: (e: unknown) => void): void {
        const set = this._listeners.get(type);
        if (set) {
            set.delete(callback);
            // 空集合清除
            if (set.size === 0) { this._listeners.delete(type); }
        }
    }

    // ════════════════════════════════════════════════════════════
    // Private — 容器和 Canvas
    // ════════════════════════════════════════════════════════════

    /**
     * 解析容器参数为 HTMLElement。
     * 支持 CSS 选择器字符串或直接传入 HTMLElement。
     *
     * @param container - CSS 选择器或 HTMLElement
     * @returns 解析后的容器元素
     * @throws {GeoForgeError} 选择器未匹配或传入无效元素时抛出
     *
     * @example
     * const el = this._resolveContainer('#globe');
     */
    private _resolveContainer(container: string | HTMLElement): HTMLElement {
        if (typeof container === 'string') {
            // CSS 选择器查询
            const el = document.querySelector(container);
            if (!el || !(el instanceof HTMLElement)) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    `Container selector "${container}" did not match any HTMLElement`,
                    { selector: container },
                );
            }
            return el;
        }

        // 直接传入的元素需要验证
        if (!(container instanceof HTMLElement)) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                'container must be an HTMLElement or a CSS selector string',
            );
        }

        return container;
    }

    /**
     * 计算并设置 Canvas 的物理像素尺寸，返回 Viewport 描述。
     *
     * @param maxPR - 最大 devicePixelRatio
     * @returns 视口描述
     *
     * @example
     * const vp = this._resizeCanvas(2.0);
     */
    private _resizeCanvas(maxPR: number): Viewport {
        // 容器的 CSS 逻辑尺寸
        const w = Math.max(this._container.clientWidth, MIN_CANVAS_DIM);
        const h = Math.max(this._container.clientHeight, MIN_CANVAS_DIM);

        // 设备像素比（钳制到上限）
        const dpr = Math.min(window.devicePixelRatio || 1, maxPR);

        // 物理像素尺寸
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);

        // 尺寸未变时复用上一帧 Viewport 对象，避免每帧分配
        if (this._canvas.width === pw && this._canvas.height === ph) {
            return this._viewport;
        }

        // 设置 Canvas 物理尺寸（触发 WebGPU surface texture 重新分配）
        this._canvas.width = pw;
        this._canvas.height = ph;

        return {
            width: w,
            height: h,
            physicalWidth: pw,
            physicalHeight: ph,
            pixelRatio: dpr,
        };
    }

    // ════════════════════════════════════════════════════════════
    // Private — WebGPU 初始化
    // ════════════════════════════════════════════════════════════

    /**
     * 异步引导 WebGPU：请求适配器/设备 → 创建资源 → 创建管线 → 启动帧循环。
     *
     * @example
     * await this._bootstrapAsync();
     */
    private async _bootstrapAsync(): Promise<void> {
        if (this._bootstrapping || this._destroyed) { return; }
        this._bootstrapping = true;

        try {
            // ── 检查 WebGPU 可用性 ──
            if (typeof navigator === 'undefined' || !navigator.gpu) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'WebGPU is not supported in this browser',
                );
            }

            // ── 请求 GPU 适配器 ──
            const adapter = await requestGpuAdapterWithFallback(navigator.gpu);
            if (!adapter) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'Failed to obtain a WebGPU adapter',
                );
            }

            // ── 请求 GPU 设备 ──
            const device = await adapter.requestDevice();
            if (this._destroyed) { return; }
            this._device = device;

            // 监听设备丢失
            device.lost.then((info) => {
                devError('[Globe3D] GPU device lost:', info.message);
                this._emit('device:lost', { message: info.message });
            });

            // ── 配置 Canvas 上下文 ──
            const ctx = this._canvas.getContext('webgpu');
            if (!ctx) {
                throw new GeoForgeError(
                    GeoForgeErrorCode.CONFIG_INVALID_CONTAINER,
                    'Failed to get WebGPU canvas context',
                );
            }
            this._gpuContext = ctx;

            // 获取推荐的纹理格式
            this._surfaceFormat = navigator.gpu.getPreferredCanvasFormat();

            ctx.configure({
                device,
                format: this._surfaceFormat,
                alphaMode: 'opaque',
            });

            // ── 创建 GPU 资源 ──
            this._createGPUResources(device);

            // ── 创建渲染管线 ──
            this._globePipeline = this._createGlobePipeline(device, this._surfaceFormat);
            this._skyPipeline = this._createSkyPipeline(device, this._surfaceFormat);
            this._atmoPipeline = this._createAtmoPipeline(device, this._surfaceFormat);

            // ── 启动帧循环 ──
            this._startFrameLoop();

            // ── 通知 ready ──
            if (this._readyResolve) {
                this._readyResolve();
                this._readyResolve = null;
            }

            this._emit('load', undefined);

        } catch (err) {
            devError('[Globe3D] _bootstrapAsync error:', err);
            // 依然 resolve ready，让调用方可以检查状态
            if (this._readyResolve) {
                this._readyResolve();
                this._readyResolve = null;
            }
            throw err;
        } finally {
            this._bootstrapping = false;
        }
    }

    /**
     * 创建所有 GPU 缓冲区、采样器和 Bind Group Layout。
     *
     * @param device - GPU 设备
     */
    private _createGPUResources(device: GPUDevice): void {
        // ── Uniform Buffers ──
        this._cameraUniformBuffer = device.createBuffer({
            size: CAMERA_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'Globe3D:cameraUniforms',
        });

        this._tileParamsBuffer = device.createBuffer({
            size: TILE_PARAMS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'Globe3D:tileParams',
        });

        this._skyUniformBuffer = device.createBuffer({
            size: SKY_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'Globe3D:skyUniforms',
        });

        this._atmoUniformBuffer = device.createBuffer({
            size: ATMO_UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'Globe3D:atmoUniforms',
        });

        // ── 线性采样器 ──
        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            label: 'Globe3D:tileSampler',
        });

        // ── Bind Group Layouts ──

        // group(0): camera uniforms
        this._cameraBindGroupLayout = device.createBindGroupLayout({
            label: 'Globe3D:cameraLayout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });

        // group(1): sampler + texture（每瓦片不同）
        this._tileBindGroupLayout = device.createBindGroupLayout({
            label: 'Globe3D:tileLayout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
            ],
        });

        // group(2): tile params uniform
        this._tileParamsBindGroupLayout = device.createBindGroupLayout({
            label: 'Globe3D:tileParamsLayout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });

        // ── 固定 Bind Groups ──

        this._cameraBindGroup = device.createBindGroup({
            layout: this._cameraBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this._cameraUniformBuffer },
            }],
            label: 'Globe3D:cameraBG',
        });

        this._tileParamsBindGroup = device.createBindGroup({
            layout: this._tileParamsBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this._tileParamsBuffer },
            }],
            label: 'Globe3D:tileParamsBG',
        });
    }

    // ════════════════════════════════════════════════════════════
    // Private — 渲染管线创建
    // ════════════════════════════════════════════════════════════

    /**
     * 创建地球瓦片渲染管线。
     * 背面剔除 + 标准 Z 深度测试 + log depth。
     *
     * @param device - GPU 设备
     * @param format - 纹理格式
     * @returns 渲染管线
     *
     * @example
     * this._globePipeline = this._createGlobePipeline(device, 'bgra8unorm');
     */
    private _createGlobePipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
        // 编译 WGSL shader module
        const shaderModule = device.createShaderModule({
            code: GLOBE_TILE_WGSL,
            label: 'Globe3D:globeShader',
        });

        // 管线布局：三个 bind group
        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [
                this._cameraBindGroupLayout!,
                this._tileBindGroupLayout!,
                this._tileParamsBindGroupLayout!,
            ],
            label: 'Globe3D:globePipelineLayout',
        });

        return device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'globe_vs',
                buffers: [{
                    // 交错顶点：posRTE(3) + normal(3) + uv(2) = 8 floats = 32 bytes
                    arrayStride: VERTEX_BYTES,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },   // posRTE
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                        { shaderLocation: 2, offset: 24, format: 'float32x2' },  // uv
                    ],
                }],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'globe_fs',
                targets: [{ format }],
            },
            primitive: {
                topology: 'triangle-list',
                frontFace: 'ccw',
                cullMode: 'back',
            },
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
            },
            label: 'Globe3D:globePipeline',
        });
    }

    /**
     * 创建天穹渲染管线。
     * 全屏三角形，深度设为 0.9999（远处），不做深度测试但写入深度。
     *
     * @param device - GPU 设备
     * @param format - 纹理格式
     * @returns 渲染管线
     *
     * @example
     * this._skyPipeline = this._createSkyPipeline(device, 'bgra8unorm');
     */
    private _createSkyPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
        const shaderModule = device.createShaderModule({
            code: SKY_DOME_WGSL,
            label: 'Globe3D:skyShader',
        });

        // 天穹只需 group(0) = sky uniforms
        const skyLayout = device.createBindGroupLayout({
            label: 'Globe3D:skyUniformLayout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [skyLayout],
            label: 'Globe3D:skyPipelineLayout',
        });

        return device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'sky_vs',
                buffers: [],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'sky_fs',
                targets: [{ format }],
            },
            primitive: {
                topology: 'triangle-list',
                frontFace: 'ccw',
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'always',
            },
            label: 'Globe3D:skyPipeline',
        });
    }

    /**
     * 创建大气散射渲染管线。
     * 全屏三角形，加性混合（src: one, dst: one），不写入深度。
     *
     * @param device - GPU 设备
     * @param format - 纹理格式
     * @returns 渲染管线
     *
     * @example
     * this._atmoPipeline = this._createAtmoPipeline(device, 'bgra8unorm');
     */
    private _createAtmoPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
        const shaderModule = device.createShaderModule({
            code: ATMOSPHERE_WGSL,
            label: 'Globe3D:atmoShader',
        });

        // 大气只需 group(0) = atmo uniforms
        const atmoLayout = device.createBindGroupLayout({
            label: 'Globe3D:atmoUniformLayout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [atmoLayout],
            label: 'Globe3D:atmoPipelineLayout',
        });

        return device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'atmo_vs',
                buffers: [],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'atmo_fs',
                targets: [{
                    format,
                    blend: {
                        color: {
                            srcFactor: 'one',
                            dstFactor: 'one',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                frontFace: 'ccw',
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: false,
                depthCompare: 'always',
            },
            label: 'Globe3D:atmoPipeline',
        });
    }

    // ════════════════════════════════════════════════════════════
    // Private — 帧循环
    // ════════════════════════════════════════════════════════════

    /**
     * 启动 requestAnimationFrame 帧循环。
     *
     * @example
     * this._startFrameLoop();
     */
    private _startFrameLoop(): void {
        this._lastFrameTime = performance.now();

        const loop = (now: number) => {
            if (this._destroyed) { return; }

            // 请求下一帧（确保即使当前帧出错也能继续）
            this._rafId = requestAnimationFrame(loop);

            try {
                // 计算 deltaTime
                const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
                this._lastFrameTime = now;

                // 推进仿真时钟
                this._dateTime = new Date(
                    this._dateTime.getTime() + dt * 1000 * this._clockMultiplier,
                );

                // 渲染一帧
                this._renderFrame(dt);
            } catch (err) {
                devError('[Globe3D] frame error:', err);
            }
        };

        this._rafId = requestAnimationFrame(loop);
    }

    /**
     * 渲染单帧：更新相机 → 计算可见瓦片 → 提交 GPU 命令。
     *
     * @param dt - 帧间隔（秒）
     *
     * @example
     * this._renderFrame(0.016); // ~60fps
     */
    private _renderFrame(dt: number): void {
        const device = this._device;
        const ctx = this._gpuContext;

        // GPU 未初始化则跳过
        if (!device || !ctx) { return; }

        const frameStart = performance.now();

        // ── 每帧刷新 Canvas 尺寸（容器可能因布局变化而改变大小） ──
        // 同时更新 viewport，保证投影矩阵 aspect 与实际渲染目标一致
        this._viewport = this._resizeCanvas(this._maxPixelRatio);

        // ── 更新相机 ──
        const camState = this._camera3D.update(dt, this._viewport);
        this._lastCamState = camState;

        // ── 计算 Globe 相机（自定义投影） ──
        const globeCam = this._computeGlobeCamera(camState, this._viewport);

        // 缓存 GlobeCamera 供异步查询（pickGlobe / _readDepthAtPixel）
        this._lastGlobeCam = globeCam;

        // ── 获取 surface texture ──
        let surfaceTexture: GPUTexture;
        try {
            surfaceTexture = ctx.getCurrentTexture();
        } catch {
            // 上下文可能已丢失
            return;
        }

        const targetView = surfaceTexture.createView();

        // ── 确保深度纹理尺寸匹配 ──
        this._ensureDepthTexture(device, surfaceTexture.width, surfaceTexture.height);
        const depthView = this._depthTexture!.createView();

        // ── 计算可见瓦片 ──
        const tiles = coveringTilesGlobe(globeCam);

        // ── 更新相机 uniforms ──
        this._updateCameraUniforms(device, globeCam);

        // ── EggShape 一次性诊断（仅首帧 + DEV 模式）──
        if (typeof __DEV__ !== 'undefined' && __DEV__ && this._frameCount === 0) {
            this._runEggShapeDiagnostic(camState, globeCam, ctx);
        }

        // ── 创建命令编码器 ──
        const encoder = device.createCommandEncoder({ label: 'Globe3D:frame' });

        // ── 开始渲染通道 ──
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                clearValue: { r: CLEAR_R, g: CLEAR_G, b: CLEAR_B, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: DEPTH_CLEAR_VALUE,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
            label: 'Globe3D:mainPass',
        });

        let drawCalls = 0;
        let tilesRendered = 0;

        // ── 1. 天穹（背景） ──
        if (this._skybox) {
            this._renderSkyDome(device, pass, globeCam);
            drawCalls++;
        }

        // ── 2. 地球瓦片 ──
        const tileResult = this._renderGlobeTiles(device, pass, globeCam, tiles);
        tilesRendered = tileResult.tilesRendered;
        drawCalls += tileResult.drawCalls;

        // ── 3. 大气（加性混合叠加） ──
        if (this._atmosphere) {
            this._renderAtmosphere(device, pass, globeCam);
            drawCalls++;
        }

        // ── 结束渲染通道并提交 ──
        pass.end();
        device.queue.submit([encoder.finish()]);

        // ── 更新统计 ──
        this._statsTilesRendered = tilesRendered;
        this._statsDrawCalls = drawCalls;
        this._statsFrameTimeMs = performance.now() - frameStart;
        this._frameCount++;
    }

    /**
     * 确保深度纹理存在且尺寸匹配。尺寸变化时销毁旧的并重建。
     *
     * @param device - GPU 设备
     * @param w - 目标宽度（物理像素）
     * @param h - 目标高度（物理像素）
     *
     * @example
     * this._ensureDepthTexture(device, 1920, 1080);
     */
    private _ensureDepthTexture(device: GPUDevice, w: number, h: number): void {
        // 尺寸匹配则不需重建
        if (this._depthTexture && this._depthW === w && this._depthH === h) { return; }

        // 销毁旧纹理
        if (this._depthTexture) {
            this._depthTexture.destroy();
        }

        // 创建新的 depth32float 纹理
        this._depthTexture = device.createTexture({
            size: { width: w, height: h },
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'Globe3D:depthTexture',
        });

        // 记录当前尺寸
        this._depthW = w;
        this._depthH = h;
    }

    // ════════════════════════════════════════════════════════════
    // Private — Globe 相机计算
    // ════════════════════════════════════════════════════════════

    /**
     * 从 Camera3D 的 CameraState 计算 GlobeCamera：
     * 自定义透视投影（near/far）+ logDepthBufFC + ECEF 版 inverseVP。
     *
     * @param camState - Camera3D 返回的 CameraState
     * @param vp - 当前视口
     * @returns GlobeCamera 结构
     *
     * @example
     * const gc = this._computeGlobeCamera(camState, viewport);
     */
    private _computeGlobeCamera(camState: CameraState, vp: Viewport): GlobeCamera {
        const alt = camState.altitude;
        const fov = camState.fov;
        const aspect = vp.width / Math.max(vp.height, 1);

        // ── 计算 near/far ──
        // near: 确保近处不被裁掉，但不能太小（浮点精度）
        const nearZ = Math.max(alt * NEAR_PLANE_FACTOR, NEAR_PLANE_MIN);
        const horizonDist = computeHorizonDist(alt);
        const farZ = horizonDist * FAR_PLANE_HORIZON_FACTOR + alt;

        // ── 标准透视投影 ──
        mat4.perspective(_tmpMat4A, fov, aspect, nearZ, farZ);

        // ── 相机与注视点 ECEF 位置（全程 Float64 精度） ──
        // CameraState.position 是 Float32（~3m 精度），不足以做 ECEF 减法。
        // 必须从经纬度+高度重新计算 Float64 ECEF，然后 Float64 减法得到 RTE。
        const camPos = this._camera3D.getPosition();
        const camLonRad = camPos.lon * DEG2RAD;
        const camLatRad = camPos.lat * DEG2RAD;
        geodeticToECEF(_ecefCam64, camLonRad, camLatRad, camPos.alt);

        const centerLngRad = camState.center[0] * DEG2RAD;
        const centerLatRad = camState.center[1] * DEG2RAD;
        geodeticToECEF(_ecefCenter64, centerLngRad, centerLatRad, 0);

        // Float64 相机位置（用于 RTE 减法和 GlobeCamera 输出）
        const camECEFx: number = _ecefCam64[0];
        const camECEFy: number = _ecefCam64[1];
        const camECEFz: number = _ecefCam64[2];

        // ── 构建 RTE View Matrix（Pipeline v2 §二 + EggShape Issues 根因二） ──
        // eye = [0,0,0]（RTE 原点 = 相机位置）
        // target = centerECEF - cameraECEF（Float64 减法，避免精度灾难）
        // 平移列为 [0,0,0]，纯旋转 — Float32 安全
        const targetRteX: number = _ecefCenter64[0] - _ecefCam64[0];
        const targetRteY: number = _ecefCenter64[1] - _ecefCam64[1];
        const targetRteZ: number = _ecefCenter64[2] - _ecefCam64[2];

        // up = 地理北向（ENU 的 North 方向）
        // 在 ECEF 中，ENU 的 North = [-sin(lat)*cos(lon), -sin(lat)*sin(lon), cos(lat)]
        const sinLat = Math.sin(centerLatRad);
        const cosLat = Math.cos(centerLatRad);
        const sinLon = Math.sin(centerLngRad);
        const cosLon = Math.cos(centerLngRad);

        vec3.set(_tmpVec3A, 0, 0, 0);  // eye = RTE origin
        vec3.set(_tmpVec3B, targetRteX, targetRteY, targetRteZ);  // target
        vec3.set(_tmpVec3C, -sinLat * cosLon, -sinLat * sinLon, cosLat);  // up = North

        mat4.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);

        // ── VP_RTE = proj × viewRTE ──
        mat4.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);
        const vpMatrix = mat4.clone(_tmpMat4C);

        // ── VP_ECEF = proj × viewECEF（用于 screenToGlobe 反投影） ──
        // ECEF 版 lookAt: eye = cameraECEF(Float64→Float32), target = centerECEF, up = North
        // screenToGlobe 需要 ECEF 绝对坐标空间的 VP 矩阵来反投影射线
        vec3.set(_tmpVec3A, _ecefCam64[0], _ecefCam64[1], _ecefCam64[2]);
        vec3.set(_tmpVec3B, _ecefCenter64[0], _ecefCenter64[1], _ecefCenter64[2]);
        // _tmpVec3C (up/North) 不变
        mat4.lookAt(_tmpMat4B, _tmpVec3A, _tmpVec3B, _tmpVec3C);
        mat4.multiply(_tmpMat4C, _tmpMat4A, _tmpMat4B);

        // inverseVP_ECEF
        const inverseVP_ECEF = mat4.create();
        mat4.invert(inverseVP_ECEF, _tmpMat4C);

        return {
            vpMatrix,
            inverseVP_ECEF: inverseVP_ECEF,
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
     * 更新相机 uniform buffer 数据。
     *
     * @param device - GPU 设备
     * @param gc - GlobeCamera 数据
     */
    private _updateCameraUniforms(device: GPUDevice, gc: GlobeCamera): void {
        if (!this._cameraUniformBuffer) { return; }

        // logDepthBufFC = 2.0 / log2(far + 1.0)
        const farZ = gc.horizonDist * FAR_PLANE_HORIZON_FACTOR + gc.altitude;
        const logDepthBufFC = 2.0 / Math.log2(farZ + 1.0);

        // 太阳方向（简化：基于日期时间计算太阳方位）
        const hourAngle = (this._dateTime.getUTCHours() + this._dateTime.getUTCMinutes() / 60) / 24 * TWO_PI - PI;
        const sunDirX = Math.cos(hourAngle);
        const sunDirY = Math.sin(hourAngle);
        const sunDirZ = 0.3;
        const sunLen = Math.sqrt(sunDirX * sunDirX + sunDirY * sunDirY + sunDirZ * sunDirZ);

        // vpMatrix: 16 floats (offset 0)
        _cameraUniformData.set(gc.vpMatrix, 0);
        // cameraPosition: 3 floats (offset 16)
        _cameraUniformData[16] = gc.cameraECEF[0];
        _cameraUniformData[17] = gc.cameraECEF[1];
        _cameraUniformData[18] = gc.cameraECEF[2];
        // altitude: 1 float (offset 19)
        _cameraUniformData[19] = gc.altitude;
        // sunDirection: 3 floats (offset 20)
        _cameraUniformData[20] = sunDirX / sunLen;
        _cameraUniformData[21] = sunDirY / sunLen;
        _cameraUniformData[22] = sunDirZ / sunLen;
        // logDepthBufFC: 1 float (offset 23)
        _cameraUniformData[23] = logDepthBufFC;

        device.queue.writeBuffer(this._cameraUniformBuffer, 0, _cameraUniformData);
    }

    /**
     * EggShape 一次性诊断（GeoForge_Globe_EggShape_Issues §排查流程 5 步）。
     * 仅在 __DEV__ 模式的首帧运行，输出所有关键渲染参数到控制台。
     * 用于快速定位地球变形的根因（7 个根因的决策树判定）。
     *
     * @param camState - Camera3D 返回的 CameraState
     * @param gc - Globe 自己计算的 GlobeCamera
     * @param ctx - WebGPU 画布上下文
     *
     * @stability internal
     */
    private _runEggShapeDiagnostic(
        camState: CameraState,
        gc: GlobeCamera,
        ctx: GPUCanvasContext,
    ): void {
        const vp = this._viewport;
        const aspect = vp.width / Math.max(vp.height, 1);
        const fov = camState.fov;
        const f = 1 / Math.tan(fov * 0.5);

        // ═══ Step 1：投影矩阵（根因一/七）═══
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

        // ═══ Step 2：RTE 平移泄漏（根因二）═══
        const rteOK = Math.abs(gc.vpMatrix[12]) < 1 && Math.abs(gc.vpMatrix[13]) < 1;
        // eslint-disable-next-line no-console
        console.log(
            `%c[EggDiag Step2] vpMat[12]:${gc.vpMatrix[12].toFixed(4)} [13]:${gc.vpMatrix[13].toFixed(4)} ` +
            `[14]:${gc.vpMatrix[14].toFixed(2)} ${rteOK ? 'OK' : 'FAIL (RTE leak)'}`,
            rteOK ? 'color:green' : 'color:red;font-weight:bold',
        );

        // ═══ Step 3：GPU uniform 与 vpMatrix 一致性（根因三）═══
        const uploadMatch = Math.abs(_cameraUniformData[0] - gc.vpMatrix[0]) < 0.0001;
        // eslint-disable-next-line no-console
        console.log(
            `%c[EggDiag Step3] uniform[0]:${_cameraUniformData[0].toFixed(4)} vpMat[0]:${gc.vpMatrix[0].toFixed(4)} ` +
            `${uploadMatch ? 'OK' : 'FAIL (matrix override)'}`,
            uploadMatch ? 'color:green' : 'color:red;font-weight:bold',
        );

        // ═══ Step 4：Canvas 尺寸（根因四）═══
        let surfW = 0, surfH = 0;
        try { const s = ctx.getCurrentTexture(); surfW = s.width; surfH = s.height; } catch { /* */ }
        const sizeOK = surfW === vp.physicalWidth && surfH === vp.physicalHeight;
        // eslint-disable-next-line no-console
        console.log(
            `%c[EggDiag Step4] CSS:${vp.width}x${vp.height} Phys:${vp.physicalWidth}x${vp.physicalHeight} ` +
            `Surf:${surfW}x${surfH} ${sizeOK ? 'OK' : 'FAIL (size mismatch)'}`,
            sizeOK ? 'color:green' : 'color:red;font-weight:bold',
        );

        // ═══ Step 5：FOV 合理性（根因七）═══
        const fovDeg = fov * RAD2DEG;
        const fovOK = fovDeg > 10 && fovDeg < 120;
        // eslint-disable-next-line no-console
        console.log(
            `%c[EggDiag Step5] fov:${fovDeg.toFixed(1)}deg f:${f.toFixed(4)} ` +
            `${fovOK ? 'OK' : 'FAIL (fov units)'}`,
            fovOK ? 'color:green' : 'color:red;font-weight:bold',
        );

        // ═══ 总结 ═══
        const allOK = projOK && rteOK && uploadMatch && sizeOK && fovOK;
        // eslint-disable-next-line no-console
        console.log(
            `%c[EggDiag] ${allOK ? 'ALL PASS' : 'ISSUES FOUND'}`,
            allOK ? 'color:green;font-weight:bold;font-size:14px' : 'color:red;font-weight:bold;font-size:14px',
        );
    }

    // ════════════════════════════════════════════════════════════
    // Private — 天穹渲染
    // ════════════════════════════════════════════════════════════

    /**
     * 渲染天穹背景（全屏三角形 + 射线方向渐变）。
     *
     * @param device - GPU 设备
     * @param pass - 当前渲染通道编码器
     * @param gc - GlobeCamera 数据
     *
     * @example
     * this._renderSkyDome(device, pass, globeCam);
     */
    private _renderSkyDome(
        device: GPUDevice,
        pass: GPURenderPassEncoder,
        gc: GlobeCamera,
    ): void {
        if (!this._skyPipeline || !this._skyUniformBuffer) { return; }

        // 更新天穹 uniform
        // inverseVP: 16 floats (offset 0)
        _skyUniformData.set(gc.inverseVP_ECEF, 0);
        // altitude: 1 float (offset 16)
        _skyUniformData[16] = gc.altitude;
        // padding: 3 floats (offset 17-19)
        _skyUniformData[17] = 0;
        _skyUniformData[18] = 0;
        _skyUniformData[19] = 0;

        device.queue.writeBuffer(this._skyUniformBuffer, 0, _skyUniformData);

        // 创建临时 bind group（天穹管线有自己的 layout）
        const skyBG = device.createBindGroup({
            layout: this._skyPipeline.getBindGroupLayout(0),
            entries: [{
                binding: 0,
                resource: { buffer: this._skyUniformBuffer },
            }],
            label: 'Globe3D:skyBG',
        });

        pass.setPipeline(this._skyPipeline);
        pass.setBindGroup(0, skyBG);
        // 全屏三角形只需 3 个顶点
        pass.draw(3);
    }

    // ════════════════════════════════════════════════════════════
    // Private — 地球瓦片渲染
    // ════════════════════════════════════════════════════════════

    /**
     * 渲染所有可见地球瓦片。
     * 对每个瓦片：获取/加载纹理 → RTE 顶点变换 → 上传 GPU → drawIndexed。
     *
     * @param device - GPU 设备
     * @param pass - 渲染通道编码器
     * @param gc - GlobeCamera 数据
     * @param tiles - 可见瓦片列表
     * @returns 渲染统计
     *
     * @example
     * const stats = this._renderGlobeTiles(device, pass, globeCam, tiles);
     */
    private _renderGlobeTiles(
        device: GPUDevice,
        pass: GPURenderPassEncoder,
        gc: GlobeCamera,
        tiles: GlobeTileID[],
    ): { tilesRendered: number; drawCalls: number } {
        if (!this._globePipeline || !this._cameraBindGroup || !this._tileParamsBindGroup) {
            return { tilesRendered: 0, drawCalls: 0 };
        }

        pass.setPipeline(this._globePipeline);
        pass.setBindGroup(0, this._cameraBindGroup);
        pass.setBindGroup(2, this._tileParamsBindGroup);

        let tilesRendered = 0;
        let drawCalls = 0;

        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            const key = tile.key;

            // ── 获取/触发瓦片纹理加载 ──
            let cached = this._tileCache.get(key);
            if (!cached) {
                // 触发异步加载
                this._loadTileTexture(key, tile.z, tile.x, tile.y);
                cached = this._tileCache.get(key);
            }

            // 纹理未就绪则跳过此瓦片（textureReady 守卫防止渲染半初始化的条目）
            if (!cached || !cached.textureReady || !cached.texture || !cached.bindGroup) { continue; }

            // 更新 LRU（移到末尾）
            this._touchTileLRU(key);

            // ── 获取/创建网格（含正确的极地拓扑） ──
            const meshData = this._getTileMesh(device, tile.z, tile.x, tile.y);
            if (!meshData) { continue; }

            // ── RTE 顶点变换（Float64 精度减法→Float32） ──
            // 复用缓存的 mesh 进行 RTE 计算（避免重复细分）
            const rteVerts = meshToRTE(meshData.mesh, gc.cameraECEF);

            // ── 上传顶点数据到临时缓冲 ──
            const vertBuf = device.createBuffer({
                size: rteVerts.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                label: `Globe3D:vertBuf:${key}`,
            });
            device.queue.writeBuffer(vertBuf, 0, rteVerts.buffer as ArrayBuffer, rteVerts.byteOffset, rteVerts.byteLength);

            // ── 更新瓦片参数（uvOffset=0, uvScale=1 默认） ──
            _tileParamsData[0] = 0; // uvOffset.x
            _tileParamsData[1] = 0; // uvOffset.y
            _tileParamsData[2] = 1; // uvScale.x
            _tileParamsData[3] = 1; // uvScale.y
            device.queue.writeBuffer(this._tileParamsBuffer!, 0, _tileParamsData);

            // ── 绑定瓦片纹理 ──
            pass.setBindGroup(1, cached.bindGroup);

            // ── 设置顶点/索引缓冲并绘制 ──
            pass.setVertexBuffer(0, vertBuf);
            pass.setIndexBuffer(meshData.indexBuffer, 'uint32');
            pass.drawIndexed(meshData.mesh.indexCount);

            tilesRendered++;
            drawCalls++;

            // 标记临时缓冲为可释放（WebGPU 会在提交后回收）
            // 注：生产环境应使用缓冲池复用
        }

        // ── P2 #8: Pure ellipsoid mode fallback ──
        // When no tiles have textures yet (initial load or imagery disabled),
        // the sky dome + atmosphere already provide the globe's visible shape.
        // The globe tile geometry contributes depth writes for correct occlusion.
        // The "pure ellipsoid" appearance is the default state before tiles load:
        //   - SkyDome renders behind the globe (background fill)
        //   - Atmosphere renders the edge glow (Rayleigh/Mie scattering)
        //   - Tiles render on top as their textures become available
        // Future: render untextured tiles with a solid base color when no imagery is available.

        return { tilesRendered, drawCalls };
    }

    /**
     * 获取或创建指定 zoom 级别的瓦片网格（共享索引缓冲）。
     *
     * @param device - GPU 设备
     * @param z - zoom 级别
     * @returns 缓存的网格数据，或 null 如果创建失败
     *
     * @example
     * const mesh = this._getTileMesh(device, 5, 3, 2);
     */
    private _getTileMesh(device: GPUDevice, z: number, x: number, y: number): CachedMesh | null {
        const key = `${z}/${x}/${y}`;

        // 检查缓存
        const existing = this._meshCache.get(key);
        if (existing) { return existing; }

        // 创建该瓦片的曲面网格（极地瓦片索引拓扑与普通瓦片不同）
        const segments = getSegments(z);
        const mesh = tessellateGlobeTile(z, x, y, segments);

        // 创建索引缓冲
        const indexBuffer = device.createBuffer({
            size: mesh.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            label: `Globe3D:indexBuf:${key}`,
        });
        device.queue.writeBuffer(indexBuffer, 0, mesh.indices.buffer as ArrayBuffer, mesh.indices.byteOffset, mesh.indices.byteLength);

        const entry: CachedMesh = { mesh, indexBuffer };
        this._meshCache.set(key, entry);

        return entry;
    }

    // ════════════════════════════════════════════════════════════
    // Private — 大气渲染
    // ════════════════════════════════════════════════════════════

    /**
     * 渲染大气散射效果（加性混合全屏三角形）。
     *
     * @param device - GPU 设备
     * @param pass - 渲染通道编码器
     * @param gc - GlobeCamera 数据
     *
     * @example
     * this._renderAtmosphere(device, pass, globeCam);
     */
    private _renderAtmosphere(
        device: GPUDevice,
        pass: GPURenderPassEncoder,
        gc: GlobeCamera,
    ): void {
        if (!this._atmoPipeline || !this._atmoUniformBuffer) { return; }

        // 更新大气 uniform
        // inverseVP: 16 floats (offset 0)
        _atmoUniformData.set(gc.inverseVP_ECEF, 0);
        // cameraPosition: 3 floats (offset 16)
        _atmoUniformData[16] = gc.cameraECEF[0];
        _atmoUniformData[17] = gc.cameraECEF[1];
        _atmoUniformData[18] = gc.cameraECEF[2];
        // altitude: 1 float (offset 19)
        _atmoUniformData[19] = gc.altitude;

        device.queue.writeBuffer(this._atmoUniformBuffer, 0, _atmoUniformData);

        // 创建临时 bind group
        const atmoBG = device.createBindGroup({
            layout: this._atmoPipeline.getBindGroupLayout(0),
            entries: [{
                binding: 0,
                resource: { buffer: this._atmoUniformBuffer },
            }],
            label: 'Globe3D:atmoBG',
        });

        pass.setPipeline(this._atmoPipeline);
        pass.setBindGroup(0, atmoBG);
        // 全屏三角形只需 3 个顶点
        pass.draw(3);
    }

    // ════════════════════════════════════════════════════════════
    // Private — 瓦片纹理加载
    // ════════════════════════════════════════════════════════════

    /**
     * 异步加载瓦片影像并创建 GPU 纹理 + bind group。
     * 加载完成后写入 _tileCache，下一帧即可渲染。
     *
     * @param key - 瓦片键 "z/x/y"
     * @param z - zoom 级别
     * @param x - 列号
     * @param y - 行号
     *
     * @example
     * this._loadTileTexture('5/16/11', 5, 16, 11);
     */
    private _loadTileTexture(key: string, z: number, x: number, y: number): void {
        // 已在缓存中（包括正在加载的）则跳过
        if (this._tileCache.has(key)) { return; }

        const device = this._device;
        if (!device) { return; }

        // 预占缓存位，标记为加载中（textureReady/demReady 均为 false）
        this._tileCache.set(key, {
            texture: null,
            bindGroup: null,
            loading: true,
            textureReady: false,
            demReady: false,
            demData: null,
        });
        this._tileLRU.push(key);

        // LRU 淘汰
        this._evictTileCache();

        // 构建 URL
        const url = this._tileUrlTemplate
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));

        // 异步加载（fetch → createImageBitmap → GPUTexture）
        this._fetchTileImage(url)
            .then((bitmap) => {
                // 可能在加载期间已被淘汰或实例被销毁
                if (this._destroyed || !this._tileCache.has(key)) {
                    bitmap.close();
                    return;
                }

                // 创建 GPU 纹理
                const texture = device.createTexture({
                    size: { width: bitmap.width, height: bitmap.height },
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING
                        | GPUTextureUsage.COPY_DST
                        | GPUTextureUsage.RENDER_ATTACHMENT,
                    label: `Globe3D:tileTex:${key}`,
                });

                // 上传位图到纹理
                device.queue.copyExternalImageToTexture(
                    { source: bitmap },
                    { texture },
                    { width: bitmap.width, height: bitmap.height },
                );

                // 位图不再需要
                bitmap.close();

                // 创建 bind group
                const bindGroup = device.createBindGroup({
                    layout: this._tileBindGroupLayout!,
                    entries: [
                        { binding: 0, resource: this._sampler! },
                        { binding: 1, resource: texture.createView() },
                    ],
                    label: `Globe3D:tileBG:${key}`,
                });

                // 更新缓存（影像纹理就绪，DEM 数据需另外加载）
                const cached = this._tileCache.get(key);
                if (cached) {
                    cached.texture = texture;
                    cached.bindGroup = bindGroup;
                    cached.loading = false;
                    cached.textureReady = true;
                }
            })
            .catch((err) => {
                devWarn(`[Globe3D] Failed to load tile ${key}:`, err);
                // 移除失败的缓存条目以允许重试
                this._tileCache.delete(key);
                const idx = this._tileLRU.indexOf(key);
                if (idx >= 0) { this._tileLRU.splice(idx, 1); }
            });
    }

    /**
     * 获取瓦片图片并解码为 ImageBitmap。
     * 内部封装 fetch + createImageBitmap。
     *
     * @param url - 瓦片图片 URL
     * @returns 解码后的 ImageBitmap
     *
     * @example
     * const bitmap = await this._fetchTileImage('https://tile.osm.org/5/16/11.png');
     */
    private async _fetchTileImage(url: string): Promise<ImageBitmap> {
        const response = await fetch(url);

        // 检查 HTTP 状态
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }

        const blob = await response.blob();
        return createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
        });
    }

    /**
     * 将指定瓦片移到 LRU 列表末尾（最近使用）。
     *
     * @param key - 瓦片键
     */
    private _touchTileLRU(key: string): void {
        const idx = this._tileLRU.indexOf(key);
        if (idx >= 0) {
            // 移到末尾
            this._tileLRU.splice(idx, 1);
            this._tileLRU.push(key);
        }
    }

    /**
     * LRU 淘汰超出上限的瓦片纹理。
     * 销毁最旧（数组头部）的瓦片 GPU 资源。
     */
    private _evictTileCache(): void {
        while (this._tileLRU.length > MAX_TILE_CACHE_SIZE) {
            // 淘汰最旧的（数组头部）
            const oldKey = this._tileLRU.shift()!;
            const cached = this._tileCache.get(oldKey);

            if (cached) {
                // 销毁 GPU 纹理
                if (cached.texture) {
                    cached.texture.destroy();
                }
                this._tileCache.delete(oldKey);
            }
        }
    }

    /**
     * 清空全部瓦片缓存（图层切换时调用）。
     */
    private _clearTileCache(): void {
        // 销毁所有 GPU 纹理
        for (const cached of this._tileCache.values()) {
            if (cached.texture) {
                cached.texture.destroy();
            }
        }
        this._tileCache.clear();
        this._tileLRU.length = 0;
    }

    // ════════════════════════════════════════════════════════════
    // Private — 交互安装
    // ════════════════════════════════════════════════════════════

    /**
     * 安装所有鼠标/滚轮交互监听器。
     *
     * @example
     * this._installInteractions();
     */
    private _installInteractions(): void {
        // mousedown 在 Canvas 上监听
        this._canvas.addEventListener('mousedown', this._boundMouseDown);

        // mousemove/mouseup 在 window 上监听（拖拽可能溢出 Canvas）
        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('mouseup', this._boundMouseUp);

        // 滚轮缩放
        this._canvas.addEventListener('wheel', this._boundWheel, { passive: false });

        // 禁止右键菜单
        this._canvas.addEventListener('contextmenu', this._boundContextMenu);
    }

    /**
     * 鼠标按下处理：记录拖拽状态和按钮。
     *
     * @param e - MouseEvent
     */
    private _onMouseDown(e: MouseEvent): void {
        if (this._destroyed) { return; }

        // 左键(0) = 轨道旋转（pan），中键(1) = 方位角/俯仰角旋转
        if (e.button === 0 && this._enableRotate) {
            this._isDragging = true;
            this._dragButton = 0;
            this._camera3D.handlePanStart(e.clientX, e.clientY);
        } else if (e.button === 1 && this._enableTilt) {
            this._isDragging = true;
            this._dragButton = 1;
            e.preventDefault();
        }
    }

    /**
     * 鼠标移动处理：根据拖拽按钮分发给相机。
     *
     * @param e - MouseEvent
     */
    private _onMouseMove(e: MouseEvent): void {
        if (!this._isDragging || this._destroyed) { return; }

        if (this._dragButton === 0) {
            // 左键拖拽 = 轨道旋转（地球跟手）
            this._camera3D.handlePanMove(e.clientX, e.clientY);
        } else if (this._dragButton === 1) {
            // 中键拖拽 = bearing/pitch 旋转
            const bearingDelta = e.movementX * ROTATE_SENSITIVITY;
            const pitchDelta = e.movementY * ROTATE_SENSITIVITY;
            this._camera3D.handleRotate(bearingDelta, pitchDelta);
        }
    }

    /**
     * 鼠标释放处理：结束拖拽。
     *
     * @param _e - MouseEvent
     */
    private _onMouseUp(_e: MouseEvent): void {
        if (!this._isDragging) { return; }

        if (this._dragButton === 0) {
            this._camera3D.handlePanEnd();
        }

        this._isDragging = false;
        this._dragButton = -1;
    }

    /**
     * 滚轮处理：缩放相机。
     *
     * @param e - WheelEvent
     */
    private _onWheel(e: WheelEvent): void {
        if (this._destroyed || !this._enableZoom) { return; }

        // 阻止页面滚动
        e.preventDefault();

        // deltaY 正值 = 缩小（zoom out），负值 = 放大（zoom in）
        const delta = -e.deltaY * ZOOM_SENSITIVITY;
        this._camera3D.handleZoom(delta, e.clientX, e.clientY);
    }

    // ════════════════════════════════════════════════════════════
    // Private — Morph 动画
    // ════════════════════════════════════════════════════════════

    /**
     * 启动 2D↔3D morph 过渡动画。
     * 内部使用 _morphing 标志控制帧循环中的插值行为。
     *
     * @param target - 目标模式
     * @param durationMs - 动画时长（毫秒）
     *
     * @example
     * this._runMorph('2d', 2000);
     */
    private _runMorph(target: '2d' | '25d' | '3d', durationMs: number): void {
        // 已经在目标模式则不需要 morph
        if (this._viewMode === target) { return; }

        this._morphing = true;
        this._morphStartTime = performance.now();
        this._morphDuration = Math.max(durationMs, 16);
        this._morphTarget = target;

        // morph 完成由帧循环检测并更新 _viewMode
        // 使用 requestAnimationFrame 来检查 morph 进度
        const checkMorph = () => {
            if (this._destroyed || !this._morphing) { return; }

            const elapsed = performance.now() - this._morphStartTime;
            const t = Math.min(elapsed / this._morphDuration, 1.0);

            if (t >= 1.0) {
                // morph 完成
                this._morphing = false;
                this._viewMode = this._morphTarget;
                this._emit('morph:complete', { mode: this._viewMode });
            } else {
                // 继续检查
                requestAnimationFrame(checkMorph);
            }
        };

        requestAnimationFrame(checkMorph);
        this._emit('morph:start', { from: this._viewMode, to: target });
    }

    // ════════════════════════════════════════════════════════════
    // Private — 验证和安全
    // ════════════════════════════════════════════════════════════

    /**
     * 检查实例是否已被销毁，销毁后抛出错误。
     *
     * @throws {GeoForgeError} 实例已销毁时抛出 MAP_DESTROYED
     *
     * @example
     * this._ensureAlive();
     */
    private _ensureAlive(): void {
        if (this._destroyed) {
            throw new GeoForgeError(
                GeoForgeErrorCode.MAP_DESTROYED,
                'Globe3D instance has been destroyed. Cannot perform operations on a removed instance.',
            );
        }
    }

    /**
     * 验证数值为非负有限数。
     *
     * @param v - 待验证数值
     * @param label - 参数名称（用于错误消息）
     * @throws {GeoForgeError} 无效值时抛出 CONFIG_INVALID_VIEW
     *
     * @example
     * this._validatePositive(exaggeration, 'terrainExaggeration');
     */
    private _validatePositive(v: number, label: string): void {
        if (!Number.isFinite(v) || v < 0) {
            throw new GeoForgeError(
                GeoForgeErrorCode.CONFIG_INVALID_VIEW,
                `${label} must be a non-negative finite number, got: ${v}`,
                { value: v },
            );
        }
    }

    /**
     * 发射事件到所有注册的监听器。
     *
     * @param type - 事件类型
     * @param payload - 事件数据
     *
     * @example
     * this._emit('load', undefined);
     */
    private _emit(type: string, payload: unknown): void {
        const set = this._listeners.get(type);
        if (!set || set.size === 0) { return; }

        // 遍历监听器并安全调用
        for (const cb of set) {
            try {
                cb(payload);
            } catch (err) {
                devError(`[Globe3D] Event handler error for "${type}":`, err);
            }
        }
    }

    /**
     * 销毁所有 GPU 资源。
     */
    private _destroyGPUResources(): void {
        // 销毁瓦片缓存
        this._clearTileCache();

        // 销毁网格缓存
        for (const entry of this._meshCache.values()) {
            entry.indexBuffer.destroy();
        }
        this._meshCache.clear();

        // 销毁深度纹理
        if (this._depthTexture) {
            this._depthTexture.destroy();
            this._depthTexture = null;
        }

        // 销毁 uniform buffers
        if (this._cameraUniformBuffer) {
            this._cameraUniformBuffer.destroy();
            this._cameraUniformBuffer = null;
        }
        if (this._tileParamsBuffer) {
            this._tileParamsBuffer.destroy();
            this._tileParamsBuffer = null;
        }
        if (this._skyUniformBuffer) {
            this._skyUniformBuffer.destroy();
            this._skyUniformBuffer = null;
        }
        if (this._atmoUniformBuffer) {
            this._atmoUniformBuffer.destroy();
            this._atmoUniformBuffer = null;
        }

        // 清空管线引用
        this._globePipeline = null;
        this._skyPipeline = null;
        this._atmoPipeline = null;

        // 清空 bind group 引用
        this._cameraBindGroup = null;
        this._tileParamsBindGroup = null;
        this._cameraBindGroupLayout = null;
        this._tileBindGroupLayout = null;
        this._tileParamsBindGroupLayout = null;

        // 清空设备引用
        this._device = null;
        this._gpuContext = null;
    }
}
