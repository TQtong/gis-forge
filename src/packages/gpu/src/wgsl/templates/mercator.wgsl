// projection: mercator — 世界坐标经 CPU vp 矩阵变换到裁剪空间
fn projectPosition(worldPos: vec3<f32>) -> vec4<f32> {
  let projected = uFrame.vpMatrix * vec4<f32>(worldPos, 1.0);
  return projected;
}
