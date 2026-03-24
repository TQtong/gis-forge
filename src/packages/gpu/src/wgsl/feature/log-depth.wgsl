// feature: logarithmic depth buffer — 调整 clip.z（与 Reversed-Z 管线配合时由 DepthManager 选型）
fn gf_log_depth_modify_clip_z(clip: vec4<f32>) -> vec4<f32> {
  let C = {{LOG_DEPTH_C}};
  let w = max(clip.w, 1e-6);
  let ez = clip.z / w;
  let lz = log(C * w + 1.0) / log(C + 1.0);
  let nz = mix(ez, lz, 0.5);
  return vec4<f32>(clip.x, clip.y, nz * w, clip.w);
}
