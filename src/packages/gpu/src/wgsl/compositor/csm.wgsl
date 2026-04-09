// ============================================================
// compositor/csm.wgsl — Cascaded Shadow Maps (CSM) 采样 / 应用
// ============================================================
//
// 级联阴影贴图：把相机视锥沿深度方向分成 N 个级联（典型 3-4 级），
// 每级拟合一张独立的 directional light 正交投影阴影贴图。近处用高分辨率，
// 远处用低分辨率，解决单张 shadow map 无法同时满足近处锯齿和远处覆盖的矛盾。
//
// 本着色器：屏幕空间后处理，对每个像素：
//   1. 从 depth 重建视空间/世界空间位置
//   2. 根据线性深度选择级联
//   3. 变换到光空间 → shadow map uv + depth
//   4. PCF 3×3 软阴影采样
//   5. 输出可见度 [0, 1]
//
// 绑定：
//   group(0) binding(0): depth_tex        — 场景深度
//   group(0) binding(1): shadow_maps      — texture_depth_2d_array（4 级）
//   group(0) binding(2): shadow_sampler   — sampler_comparison
//   group(0) binding(3): depth_sampler    — sampler
//   group(0) binding(4): uniforms         — CSMUniforms
//
// 级联分割距离、光空间 VP 矩阵由 TS 侧 computeCSMCascades() 计算。
// ============================================================

const NUM_CASCADES: u32 = 4u;

struct CSMUniforms {
  // 相机矩阵
  invViewProj: mat4x4<f32>,
  // 每级的光空间视投影矩阵
  lightVP: array<mat4x4<f32>, 4>,
  // 每级结束的视空间深度（线性，米）；最后一级 = far
  cascadeSplits: vec4<f32>,
  // 所有标量打包到一个 vec4 避免 "array<mat4x4,N> + vec4 + 标量" 的对齐歧义：
  //   x = depthBias (典型 0.0005)
  //   y = normalBias (典型 0.01)
  //   z = pcfRadius (texels)
  //   w = 相机 near 平面（米，线性深度反算用）
  params: vec4<f32>,
  // 相机投影参数 xy = (near, far)，用于从 NDC 深度反算视空间 z：
  //   viewZ = (near * far) / (far + depth * (near - far))（标准投影约定）
  // zw = pad
  projParams: vec4<f32>,
}

@group(0) @binding(0) var depth_tex: texture_depth_2d;
@group(0) @binding(1) var shadow_maps: texture_depth_2d_array;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
@group(0) @binding(3) var depth_sampler: sampler;
@group(0) @binding(4) var<uniform> u: CSMUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

/// 从非线性深度 + uv 重建世界空间坐标。
fn reconstructWorldPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let world = u.invViewProj * clip;
  return world.xyz / world.w;
}

/// 从 NDC 深度反算视空间线性深度（绝对值，米）。
///
/// 标准 WebGPU 投影（非反向 Z）：
///   z_ndc = far/(far-near) + (near·far)/((near-far)·z_view)  [z_ndc ∈ [0,1]]
///   => z_view = (near * far) / (far + depth * (near - far))
///
/// 注：本函数假定非反向 Z。如果你的投影矩阵用的是 Reversed-Z（near=1, far=0），
/// 需要把 (near, far) 参数颠倒传入。
fn linearDepthFromNdc(depth: f32) -> f32 {
  let near = u.projParams.x;
  let far = u.projParams.y;
  return (near * far) / (far + depth * (near - far));
}

/// 选择当前片段所属的级联索引。
fn selectCascade(viewZ: f32) -> u32 {
  if (viewZ < u.cascadeSplits.x) { return 0u; }
  if (viewZ < u.cascadeSplits.y) { return 1u; }
  if (viewZ < u.cascadeSplits.z) { return 2u; }
  return 3u;
}

/// 3×3 PCF 软阴影采样。
fn pcfShadow(layer: u32, lightUV: vec2<f32>, refDepth: f32) -> f32 {
  let texelSize = 1.0 / vec2<f32>(textureDimensions(shadow_maps, 0).xy);
  let pcfRadius = u.params.z;
  var sum: f32 = 0.0;
  // 9 samples in a grid
  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let offset = vec2<f32>(f32(dx), f32(dy)) * texelSize * pcfRadius;
      sum = sum + textureSampleCompareLevel(
        shadow_maps,
        shadow_sampler,
        lightUV + offset,
        layer,
        refDepth,
      );
    }
  }
  return sum / 9.0;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
  // 使用 textureSampleLevel（显式 LOD 0）以保持 uniform 控制流兼容。
  let depth = textureSampleLevel(depth_tex, depth_sampler, in.uv, 0);
  if (depth >= 0.9999) {
    return 1.0; // 天空 → 无阴影
  }

  let worldPos = reconstructWorldPos(in.uv, depth);

  // 选择级联：从 NDC 深度反算视空间线性距离（米），
  // 与 cascadeSplits 的视空间单位一致
  let viewZ = linearDepthFromNdc(depth);
  let cascade = selectCascade(viewZ);

  // 变换到光空间
  let lightClip = u.lightVP[cascade] * vec4<f32>(worldPos, 1.0);
  let lightNdc = lightClip.xyz / lightClip.w;

  // 光空间 NDC → shadow map uv
  let lightUV = vec2<f32>(
    lightNdc.x * 0.5 + 0.5,
    0.5 - lightNdc.y * 0.5,
  );

  // 边界裁剪：超出光视锥 → 认为无阴影
  if (lightUV.x < 0.0 || lightUV.x > 1.0 ||
      lightUV.y < 0.0 || lightUV.y > 1.0 ||
      lightNdc.z < 0.0 || lightNdc.z > 1.0) {
    return 1.0;
  }

  let depthBias = u.params.x;
  let refDepth = lightNdc.z - depthBias;
  return pcfShadow(cascade, lightUV, refDepth);
}
