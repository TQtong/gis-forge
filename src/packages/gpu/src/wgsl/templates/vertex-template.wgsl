// GIS-Forge — vertex template (assembled by ShaderAssembler)
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

struct PerObjectUniforms {
  modelMatrix: mat4x4<f32>,
  rtcCenter: vec3<f32>,
  _padObj: f32,
}
@group(2) @binding(0) var<uniform> uObject: PerObjectUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  {{EXTRA_VARYINGS}}
}

// ===== 投影模块注入点 =====
// 必须实现: fn projectPosition(worldPos: vec3<f32>) -> vec4<f32>;
{{PROJECTION_MODULE}}

// ===== 几何模块注入点 =====
// 必须实现: fn processVertex(input: VertexInput) -> VertexOutput;
{{GEOMETRY_MODULE}}

// ===== 特性模块注入点（可包含辅助函数；主流程在下方调用 gf_vertex_features_post）=====
{{FEATURE_MODULES}}

fn gf_vertex_features_post(output: ptr<function, VertexOutput>) {
  // HOOK: feature_vertex_begin
  // 默认无操作；通过读取再写回 clip，保证 ptr 参数被使用且行为不变
  let clip = (*output).clipPosition;
  (*output).clipPosition = clip;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  // HOOK: vertex_position_before_projection
  output = processVertex(input);
  // HOOK: vertex_position_after_geometry
  output.clipPosition = projectPosition(output.worldPosition);
  gf_vertex_features_post(&output);
  // HOOK: vertex_output_custom
  return output;
}
