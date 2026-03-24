// projection: globe — ECEF 相对 RTC 中心后再乘 VP（大场景精度）
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let relative = worldPos - uObject.rtcCenter;
  let projected = uFrame.vpMatrix * vec4<f32>(relative, 1.0);
  return projected;
}
