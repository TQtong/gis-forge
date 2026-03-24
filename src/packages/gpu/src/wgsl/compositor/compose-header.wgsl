
struct CompositorUniform {
  count: u32,
  near: f32,
  far: f32,
  log_c: f32,
  modes_m0: vec4<u32>,
  modes_m1: vec4<u32>,
  prios_m0: vec4<f32>,
  prios_m1: vec4<f32>,
}
@group(0) @binding(0) var<uniform> compositor_params: CompositorUniform;

fn comp_get_mode(i: u32) -> u32 {
  if (i < 4u) {
    let v = compositor_params.modes_m0;
    return select(select(select(v.x, v.y, i == 1u), v.z, i == 2u), v.w, i == 3u);
  }
  let j = i - 4u;
  let v = compositor_params.modes_m1;
  return select(select(select(v.x, v.y, j == 1u), v.z, j == 2u), v.w, j == 3u);
}

fn comp_get_prio(i: u32) -> f32 {
  if (i < 4u) {
    let v = compositor_params.prios_m0;
    return select(select(select(v.x, v.y, i == 1u), v.z, i == 2u), v.w, i == 3u);
  }
  let j = i - 4u;
  let v = compositor_params.prios_m1;
  return select(select(select(v.x, v.y, j == 1u), v.z, j == 2u), v.w, j == 3u);
}
