
/// 从插值齐次坐标取当前片段的 NDC 深度（Reversed-Z 下近处趋近 1）。
fn geoforge_log_depth_fragment_ndc_z(clip_pos: vec4<f32>) -> f32 {
  let w = max(clip_pos.w, 1e-6);
  return clip_pos.z / w;
}
