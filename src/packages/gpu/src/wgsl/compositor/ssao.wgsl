// ============================================================
// compositor/ssao.wgsl — Screen-Space Ambient Occlusion (SSAO)
// ============================================================
//
// 屏幕空间环境光遮蔽：通过在每个像素附近采样半球方向上的深度来估计被遮蔽程度。
// 标准 Crytek-style SSAO（McGuire 改进版）：法线半球 + 噪声旋转 + 范围限制。
//
// 输入绑定：
//   group(0) binding(0): depth_tex       — 线性 / 非线性深度纹理（sampler 2d depth）
//   group(0) binding(1): normal_tex      — 视空间法线 RGB（texture_2d<f32>）
//   group(0) binding(2): noise_tex       — 4×4 旋转噪声（texture_2d<f32>，repeat 采样）
//   group(0) binding(3): depth_sampler   — sampler
//   group(0) binding(4): linear_sampler  — sampler
//   group(0) binding(5): uniforms        — SsaoUniforms
//
// 预期 fullscreen-vertex.wgsl 作为 VS 提供 uv。
// 输出：单通道遮蔽因子（0 = 完全遮蔽，1 = 无遮蔽）。
// 调用方把结果作为环境光乘法项即可。
//
// 采样数 16 为质量/性能折中；论文推荐 16-32，移动端可降到 8。
// ============================================================

struct SsaoUniforms {
  // 视图投影矩阵
  proj: mat4x4<f32>,
  invProj: mat4x4<f32>,
  // 16 个切空间半球采样（xyz）+ 1.0 填充
  samples: array<vec4<f32>, 16>,
  // 屏幕尺寸 + 噪声纹理缩放：xy = screenSize, zw = screenSize / 4.0
  //
  // 显式把 4 个 f32 打包进单个 vec4，避免 WGSL struct layout rule 对
  // array<vec4, N> 后跟独立标量/vec2 时的对齐不确定性。TS 侧按 f32[128..131] 写入。
  screenAndNoiseScale: vec4<f32>,
  // 采样参数打包：x = radius, y = bias, z = intensity, w = pad
  params: vec4<f32>,
}

@group(0) @binding(0) var depth_tex: texture_depth_2d;
@group(0) @binding(1) var normal_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_tex: texture_2d<f32>;
@group(0) @binding(3) var depth_sampler: sampler;
@group(0) @binding(4) var linear_sampler: sampler;
@group(0) @binding(5) var<uniform> u: SsaoUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

/// 从深度纹理重建视空间坐标。
fn reconstructViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  // uv → NDC（WebGPU Y 轴向下，NDC Y 向上）
  let ndc = vec3<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let view = u.invProj * clip;
  return view.xyz / view.w;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) f32 {
  let depth = textureSampleLevel(depth_tex, depth_sampler, in.uv, 0);
  // 远平面 → 跳过（无遮蔽）
  if (depth >= 0.9999) {
    return 1.0;
  }

  let fragPos = reconstructViewPos(in.uv, depth);
  // 视空间法线（期望已压缩到 [-1,1]）
  // 使用 textureSampleLevel（显式 LOD 0）避免在非一致控制流下调用需要
  // 导数的 textureSample（WGSL uniformity 检查要求）。
  let normal = normalize(textureSampleLevel(normal_tex, linear_sampler, in.uv, 0.0).xyz * 2.0 - 1.0);

  // 随机旋转向量（每 4x4 像素一个）
  let noiseScale = u.screenAndNoiseScale.zw;
  let randomVec = normalize(textureSampleLevel(noise_tex, linear_sampler, in.uv * noiseScale, 0.0).xyz);

  // 构建切空间：Gram-Schmidt 正交化
  let tangent = normalize(randomVec - normal * dot(randomVec, normal));
  let bitangent = cross(normal, tangent);
  let tbn = mat3x3<f32>(tangent, bitangent, normal);

  var occlusion: f32 = 0.0;

  let radius = u.params.x;
  let bias = u.params.y;
  let intensity = u.params.z;

  // 16 个切空间半球采样
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let sampleDir = tbn * u.samples[i].xyz;
    let samplePos = fragPos + sampleDir * radius;

    // 把 samplePos 投影回屏幕空间获取 uv
    var clipPos = u.proj * vec4<f32>(samplePos, 1.0);
    clipPos /= clipPos.w;
    let sampleUV = vec2<f32>(
      clipPos.x * 0.5 + 0.5,
      0.5 - clipPos.y * 0.5,
    );

    // 边界剔除
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
        sampleUV.y < 0.0 || sampleUV.y > 1.0) {
      continue;
    }

    let sampleDepth = textureSampleLevel(depth_tex, depth_sampler, sampleUV, 0);
    let sampleViewPos = reconstructViewPos(sampleUV, sampleDepth);

    // 范围限制：远处像素的遮蔽贡献衰减
    let rangeCheck = smoothstep(0.0, 1.0, radius / abs(fragPos.z - sampleViewPos.z));

    // 当样本点在当前像素前方（更近相机），视为遮蔽
    if (sampleViewPos.z >= samplePos.z + bias) {
      occlusion = occlusion + rangeCheck;
    }
  }

  occlusion = 1.0 - (occlusion / 16.0) * intensity;
  return clamp(occlusion, 0.0, 1.0);
}
