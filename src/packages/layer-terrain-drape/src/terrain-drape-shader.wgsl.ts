// ============================================================
// terrain-drape-shader.wgsl.ts — 单层地形 WGSL 着色器
//
// 设计参照 Mapbox GL v3 / MapLibre terrain render mode：
//   • vertex shader 从 DEM 纹理采样高度（GPU 端，零 CPU 参与）
//   • fragment shader 从 DEM 纹理 Sobel 算法线（GPU 端，零 CPU 参与）
//   • 顶点输入仅 (u, v)，所有空间变换在 shader 内完成
//   • 无 DEM 时 heightInfo.w = 0 → 纯平面，与 2D 底图一致
// ============================================================

export const TERRAIN_DRAPE_WGSL = /* wgsl */ `

// ═══════════════════════════════════════════════════════════════
// Bind Group 0: Camera — 每帧 1 次 writeBuffer
// ═══════════════════════════════════════════════════════════════
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
  // x,y = cameraCenterZ0 (z=0 墨卡托像素)
  // z   = worldScale (= 2^camera.zoom)
  // w   = ppmCurrent (当前 zoom 下 米→像素)
  params: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// ═══════════════════════════════════════════════════════════════
// Bind Group 1: Style — 样式变更时 writeBuffer
// ═══════════════════════════════════════════════════════════════
struct StyleUniforms {
  // xyz = 光照方向 (世界空间); w = hillshade 强度 (0=无, 0.15=默认)
  lightAndAmbient: vec4<f32>,
  // x = opacity; y/z/w 保留
  misc: vec4<f32>,
};
@group(1) @binding(0) var<uniform> style: StyleUniforms;

// ═══════════════════════════════════════════════════════════════
// Bind Group 2: Tile — 每瓦片切换
// ═══════════════════════════════════════════════════════════════
struct TileUniforms {
  // xy = tile bbox west/south (z=0 mercator px)
  // zw = tile bbox east/north (z=0 mercator px)
  bboxZ0: vec4<f32>,
  // x = minHeight (米)
  // y = heightRange (= maxH - minH, 米)
  // z = exaggeration
  // w = hasElevation (0.0 = 纯平面, 1.0 = 有 DEM)
  heightInfo: vec4<f32>,
};
@group(2) @binding(0) var<uniform> tile: TileUniforms;
@group(2) @binding(1) var tileSampler: sampler;
@group(2) @binding(2) var demTex: texture_2d<f32>;    // R 通道 = 归一化高度
@group(2) @binding(3) var drapeTex: texture_2d<f32>;  // OSM 瓦片贴图

// ═══════════════════════════════════════════════════════════════
// Vertex Shader：共享 grid mesh，只有 (u, v)
// ═══════════════════════════════════════════════════════════════
struct VsIn {
  @location(0) uv: vec2<f32>,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  // 瓦片内双线性插值得 z=0 墨卡托像素
  let bboxMin = tile.bboxZ0.xy;
  let bboxMax = tile.bboxZ0.zw;
  let mercZ0 = mix(bboxMin, bboxMax, in.uv);

  // 相机相对 → 当前 zoom 像素
  let relZ0 = mercZ0 - camera.params.xy;
  let relCur = relZ0 * camera.params.z;

  // GPU 端 DEM 采样（textureSampleLevel 强制 mip 0，保证精度）
  let hNorm = textureSampleLevel(demTex, tileSampler, in.uv, 0.0).r;
  let hMeters = tile.heightInfo.x + hNorm * tile.heightInfo.y;
  let hPx = hMeters * camera.params.w * tile.heightInfo.z * tile.heightInfo.w;

  var out: VsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(relCur.x, relCur.y, hPx, 1.0);
  out.uv = in.uv;
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Fragment Shader：drape 纹理 + GPU Sobel hillshade
// ═══════════════════════════════════════════════════════════════
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  // drape 基色
  let base = textureSample(drapeTex, tileSampler, in.uv).rgb;

  // GPU Sobel 法线（5 次 DEM texture 采样）
  let texSize = vec2<f32>(textureDimensions(demTex));
  let dx = 1.0 / texSize.x;
  let dy = 1.0 / texSize.y;
  let hL = textureSampleLevel(demTex, tileSampler, in.uv - vec2(dx, 0.0), 0.0).r;
  let hR = textureSampleLevel(demTex, tileSampler, in.uv + vec2(dx, 0.0), 0.0).r;
  let hD = textureSampleLevel(demTex, tileSampler, in.uv - vec2(0.0, dy), 0.0).r;
  let hU = textureSampleLevel(demTex, tileSampler, in.uv + vec2(0.0, dy), 0.0).r;

  // 梯度 → 法线（缩放到真实米比例）
  let hRange = max(tile.heightInfo.y, 1.0);
  let scale = hRange * tile.heightInfo.z;
  let n = normalize(vec3<f32>((hL - hR) * scale, (hD - hU) * scale, 2.0));

  // Hillshade（平坦基准 = 1.0，只有真正有坡度的地方才变亮/变暗）
  let L = normalize(style.lightAndAmbient.xyz);
  let ndl = dot(n, L);
  let ndlFlat = L.z;    // dot((0,0,1), L) — 平坦面的 ndl
  let strength = clamp(style.lightAndAmbient.w, 0.0, 1.0);
  let shade = 1.0 + (ndl - ndlFlat) * strength * tile.heightInfo.w;
  let shaded = clamp(base * shade, vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(shaded, style.misc.x);
}
`;
