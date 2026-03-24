
struct OitUniform {
  opaque_count: u32,
  trans_count: u32,
  near: f32,
  far: f32,
  log_c: f32,
  _pad: u32,
  trans_m0: vec4<u32>,
  trans_m1: vec4<u32>,
}
@group(0) @binding(0) var<uniform> oit_params: OitUniform;
@group(0) @binding(1) var tex_background: texture_2d<f32>;
@group(0) @binding(2) var samp_linear: sampler;

fn oit_get_mode(i: u32) -> u32 {
  if (i < 4u) {
    let v = oit_params.trans_m0;
    return select(select(select(v.x, v.y, i == 1u), v.z, i == 2u), v.w, i == 3u);
  }
  let j = i - 4u;
  let v = oit_params.trans_m1;
  return select(select(select(v.x, v.y, j == 1u), v.z, j == 2u), v.w, j == 3u);
}
