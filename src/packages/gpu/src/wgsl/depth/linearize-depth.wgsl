
/// 将 Reversed-Z 深度采样（0=远、1=近）还原为视空间正距离。
/// 适用于未叠加对数扭曲的透视投影；若与 geoforge_log_depth_vertex_clip 联用，
/// 应优先使用深度纹理中的实际值配合场景统一投影反算。
fn geoforge_linearize_reversed_z_depth(depth_sample: f32, near: f32, far: f32) -> f32 {
  let d = clamp(depth_sample, 0.0, 1.0);
  let denom = max(near + d * (far - near), 1e-6);
  return (near * far) / denom;
}

/// 当深度缓冲存储为对数归一化后的 Reversed-Z 时，用标量参数反推视距（避免与顶点片段 struct 重复定义）。
fn geoforge_linearize_log_reversed_z(
  depth_sample: f32,
  near: f32,
  far: f32,
  log_c: f32
) -> f32 {
  let d = clamp(depth_sample, 0.0, 1.0);
  let t = 1.0 - d;
  let lc = max(log_c, 1e-6);
  let log_n = log(lc * near + 1.0);
  let log_f = log(lc * far + 1.0);
  let log_z = mix(log_n, log_f, t);
  let z_abs = (exp(log_z) - 1.0) / lc;
  return clamp(z_abs, near, far);
}
