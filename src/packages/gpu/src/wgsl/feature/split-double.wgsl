// feature: split double — 自 high/low 与 RTC 重建世界坐标（CPU 须对齐上传）
fn gf_reconstruct_world_from_split(
  posHigh: vec3<f32>,
  posLow: vec3<f32>,
  rtcHigh: vec3<f32>,
  rtcLow: vec3<f32>,
) -> vec3<f32> {
  let rh = posHigh - rtcHigh;
  let rl = posLow - rtcLow;
  return rh + rl;
}
