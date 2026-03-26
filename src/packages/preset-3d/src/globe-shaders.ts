/**
 * @module preset-3d/globe-shaders
 * @description
 * Globe3D 使用的 **WGSL 源码字符串**，由 {@link import('./globe-gpu.ts').createGlobePipeline} 等编译为 `GPUShaderModule`。
 *
 * **Bind group 约定（地球瓦片）**
 * - group(0)：相机 `CameraUniforms`（vp、ECEF 位置、太阳、logDepthBufFC）
 * - group(1)：瓦片 `sampler` + `texture_2d`
 * - group(2)：瓦片 UV `TileParams`
 *
 * **深度**：瓦片与大气顶点使用 `applyLogDepth`；其它图层应嵌入 {@link LOG_DEPTH_WGSL} 并传入相同 `logDepthBufFC`。
 *
 * @stability experimental
 */

/**
 * 地球表面瓦片栅格化着色器。
 *
 * @remarks
 * - Vertex：`globe_vs`，RTE 位置 × VP，输出对数深度。
 * - Fragment：`globe_fs`，纹理 × 简易日照 × 边缘蓝色大气 tint。
 * - 与 {@link LOG_DEPTH_WGSL} 中 `applyLogDepth` 公式一致。
 */
export const GLOBE_TILE_WGSL = /* wgsl */`
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
 * 天穹背景：全屏 3 顶点，逆 VP 求视线，高度渐变模拟地平线—天顶—太空。
 *
 * @remarks
 * - 独立 pipeline，仅 group(0) sky uniform。
 * - 深度 `0.9999` + `depthCompare: always` 的写法见 {@link import('./globe-gpu.ts').createSkyPipeline}。
 */
export const SKY_DOME_WGSL = /* wgsl */`
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
 * 大气散射：几何壳 + 与瓦片相同 RTE 路径（方案 A），避免全屏 ray-sphere 的精度问题。
 *
 * @remarks
 * - 仅 group(0) 相机 VP；片元加性混合，不写深度。
 * - 球半径硬编码与 `ATMO_RADIUS_FACTOR` 设计一致（6378137×1.025）。
 */
export const ATMOSPHERE_WGSL = /* wgsl */`
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VsIn {
  @location(0) posRTE: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct AtmoVsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) posRTE: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex fn atmo_vs(in: VsIn) -> AtmoVsOut {
  var out: AtmoVsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(in.posRTE, 1.0);
  out.posRTE = in.posRTE;
  out.normal = in.normal;
  return out;
}

@fragment fn atmo_fs(in: AtmoVsOut) -> @location(0) vec4<f32> {
  let earthR = 6378137.0;
  let atmoR = earthR * 1.025;
  let maxPath = atmoR - earthR;
  let viewDir = normalize(in.posRTE);
  let nDotV = abs(dot(in.normal, viewDir));
  let pathLen = maxPath / max(nDotV, 0.01);
  let density = clamp(pathLen / (maxPath * 4.0), 0.0, 1.0);
  let atmoColor = vec3<f32>(0.3, 0.5, 1.0);
  return vec4<f32>(atmoColor * density * 0.6, density * 0.4);
}
`;

/**
 * 可嵌入其它 WGSL 文件的 `applyLogDepth` 片段（必须与 {@link GLOBE_TILE_WGSL} 内联实现逐字一致）。
 *
 * @remarks
 * 使用方式：与主 shader 拼接后，uniform 中传入 {@link import('./globe-utils.ts').computeLogDepthBufFC} 的结果。
 */
export const LOG_DEPTH_WGSL = /* wgsl */`
fn applyLogDepth(clipPos: vec4<f32>, logDepthBufFC: f32) -> vec4<f32> {
  var pos = clipPos;
  let logZ = log2(max(1e-6, pos.w + 1.0)) * logDepthBufFC;
  pos.z = logZ * pos.w;
  return pos;
}
`;
