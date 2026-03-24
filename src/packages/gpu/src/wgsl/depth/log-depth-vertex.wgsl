
/// GeoForge 对数深度参数（放入 uniform buffer，16 字节对齐）。
struct GeoForgeLogDepthParams {
  near: f32,
  far: f32,
  /// 对数尺度 C，用于 log(C * z + 1)；典型 0.1 ~ 1.0。
  log_c: f32,
  _pad: f32,
}

/// 将标准 clip 向量转为适合 Reversed-Z + 对数深度的 clip。
/// clip_in 为 projection * model_view * vec4(position,1) 的结果。
fn geoforge_log_depth_vertex_clip(clip_in: vec4<f32>, p: GeoForgeLogDepthParams) -> vec4<f32> {
  let w = max(clip_in.w, 1e-6);
  let z_view = clip_in.z;
  let z_abs = max(-z_view, p.near);
  let log_z = log(p.log_c * z_abs + 1.0);
  let log_n = log(p.log_c * p.near + 1.0);
  let log_f = log(p.log_c * p.far + 1.0);
  let t = (log_z - log_n) / max(log_f - log_n, 1e-6);
  let z_rev = (1.0 - t) * w;
  return vec4<f32>(clip_in.xy, z_rev, w);
}
