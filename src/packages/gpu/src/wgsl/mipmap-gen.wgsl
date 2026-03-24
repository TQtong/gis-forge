// 顶点着色器：生成覆盖全屏的三角形（无需顶点缓冲区）
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  // 生成覆盖全屏的三角形坐标（大三角形裁剪法）
  let x = f32(i32(vertexIndex & 1u) * 2 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 2 - 1);
  output.position = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  output.uv = vec2f(f32(vertexIndex & 1u), 1.0 - f32(vertexIndex >> 1u));
  return output;
}

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(srcTexture, srcSampler, uv);
}
