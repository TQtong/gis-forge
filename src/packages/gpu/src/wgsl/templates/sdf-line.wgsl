// feature: sdf line — 有向距离抗锯齿（dist 为到中心线 signed 距离，像素单位）
fn gf_sdf_line_alpha(dist: f32, halfWidth: f32) -> f32 {
  let w = max(halfWidth, 1e-4);
  let d = abs(dist);
  return 1.0 - smoothstep(w - 1.0, w + 1.0, d);
}
