// GeoForge — fragment template (assembled by ShaderAssembler)
struct PerFrameUniforms {
  viewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  vpMatrix: mat4x4<f32>,
  cameraPosition: vec3<f32>,
  _pad0: f32,
  viewport: vec2<f32>,
  time: f32,
  zoom: f32,
}
@group(0) @binding(0) var<uniform> uFrame: PerFrameUniforms;

// ===== 图层 Uniform 注入点（样式扩展可替换整段 struct + var）=====
{{PER_LAYER_UNIFORMS}}

struct FragmentInput {
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  {{EXTRA_VARYINGS}}
}

@group(3) @binding(0) var uGlyphTexture: texture_2d<f32>;
@group(3) @binding(1) var uGlyphSampler: sampler;

// ===== 样式模块注入点 =====
// 必须实现: fn computeColor(input: FragmentInput) -> vec4<f32>;
{{STYLE_MODULE}}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // HOOK: fragment_color_before_style
  var color = computeColor(input);
  // HOOK: fragment_color_after_style
  // HOOK: fragment_alpha
  // HOOK: fragment_discard
  return color;
}
