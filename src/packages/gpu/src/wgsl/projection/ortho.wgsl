// projection: ortho — 正交视图由 CPU 预乘入 vpMatrix，此处与墨卡托同型变换
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let projected = uFrame.vpMatrix * vec4<f32>(worldPos, 1.0);
  return projected;
}
