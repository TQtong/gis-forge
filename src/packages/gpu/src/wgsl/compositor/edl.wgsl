// ============================================================
// compositor/edl.wgsl — Eye-Dome Lighting (EDL)
// ============================================================
//
// EDL 是 Potree 等点云可视化器中使用的屏幕空间 shading 技术。
// 不依赖法线贴图或传统光照，仅根据邻域深度差异增强边缘和深度感知。
//
// 算法（Boucheny 2009, "Interactive Visualization of Surface Fields"）：
// 在每个像素周围取 N 个邻居（8 方向×1-2 环），计算与当前像素的深度差之和，
// 用指数函数把深度差映射为阴影强度：
//   shade = exp(-EDL_STRENGTH * sum_of_positive_depth_diffs)
// 最后把原色乘以 shade 得到 EDL 渲染结果。
//
// 输入绑定：
//   group(0) binding(0): color_tex     — 原始场景颜色（RGB）
//   group(0) binding(1): depth_tex     — 非线性深度
//   group(0) binding(2): color_samp    — linear / filtering sampler（颜色用）
//   group(0) binding(3): depth_samp    — non-filtering sampler（深度用）
//   group(0) binding(4): uniforms      — EDLUniforms
//
// 注：WebGPU 不允许用 filtering sampler 对 `texture_depth_2d` 调 textureSample，
// 所以必须为深度纹理单独提供 non-filtering sampler。
//
// 输出：合成后的 RGBA。
// ============================================================

struct EDLUniforms {
  screenSize: vec2<f32>,
  // 强度系数（典型 1.0-10.0，点云越稀疏越大）
  strength: f32,
  // 邻域采样半径（像素单位）
  radius: f32,
  // 全局透明度（用于渐变混合，默认 1.0）
  opacity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var color_tex: texture_2d<f32>;
@group(0) @binding(1) var depth_tex: texture_depth_2d;
@group(0) @binding(2) var color_samp: sampler;
@group(0) @binding(3) var depth_samp: sampler;
@group(0) @binding(4) var<uniform> u: EDLUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

// 8 方向邻居偏移（单位向量）
const NEIGHBORS: array<vec2<f32>, 8> = array<vec2<f32>, 8>(
  vec2<f32>( 1.0,  0.0),
  vec2<f32>( 0.7,  0.7),
  vec2<f32>( 0.0,  1.0),
  vec2<f32>(-0.7,  0.7),
  vec2<f32>(-1.0,  0.0),
  vec2<f32>(-0.7, -0.7),
  vec2<f32>( 0.0, -1.0),
  vec2<f32>( 0.7, -0.7),
);

/// 把非线性深度转换为对数深度便于邻域差分（避免远处像素主导）。
fn logDepth(d: f32) -> f32 {
  // 对 sample < 1.0 安全的 log(1 + 大数)；远平面 (d≈1) 返回大值
  return log2(max(d, 1e-5) * 100.0 + 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let texel = 1.0 / u.screenSize;
  let centerDepth = textureSampleLevel(depth_tex, depth_samp, in.uv, 0);

  // 背景 / 天空 → 不做 EDL
  // 使用 textureSampleLevel（显式 LOD 0）：textureSample 需要导数，在
  // 带 depth 早退的分支里属于非一致控制流，WGSL uniformity 检查会拒绝。
  if (centerDepth >= 0.9999) {
    let col = textureSampleLevel(color_tex, color_samp, in.uv, 0.0);
    return vec4<f32>(col.rgb, col.a * u.opacity);
  }

  let logCenter = logDepth(centerDepth);

  var sumResponse: f32 = 0.0;

  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let offset = NEIGHBORS[i] * texel * u.radius;
    let sampleUv = in.uv + offset;
    let sampleDepth = textureSampleLevel(depth_tex, depth_samp, sampleUv, 0);

    // 仅"邻居更远"时贡献（即当前像素在突出边缘上）
    if (sampleDepth >= 0.9999) {
      continue;
    }
    let logNeighbor = logDepth(sampleDepth);
    let diff = max(0.0, logCenter - logNeighbor);
    sumResponse = sumResponse + diff;
  }

  // 归一化：除以邻居数
  sumResponse = sumResponse / 8.0;

  // 阴影系数
  let shade = exp(-sumResponse * u.strength * 300.0);

  let baseColor = textureSampleLevel(color_tex, color_samp, in.uv, 0.0);
  return vec4<f32>(baseColor.rgb * shade, baseColor.a * u.opacity);
}
