
const DEPTH_SPACE_REVERSED_Z: u32 = 0u;
const DEPTH_SPACE_LINEAR: u32 = 1u;
const DEPTH_SPACE_LOGARITHMIC: u32 = 2u;

fn geoforge_unify_depth_to_view_z(
  raw_depth: f32,
  space: u32,
  near: f32,
  far: f32,
  log_c: f32
) -> f32 {
  let d = clamp(raw_depth, 0.0, 1.0);
  let n = max(near, 1e-6);
  let f_dist = max(far, n + 1e-6);
  if (space == DEPTH_SPACE_REVERSED_Z) {
    let denom = max(n + d * (f_dist - n), 1e-6);
    return (n * f_dist) / denom;
  }
  if (space == DEPTH_SPACE_LINEAR) {
    return n + d * (f_dist - n);
  }
  let lc = max(log_c, 1e-6);
  let t = 1.0 - d;
  let log_n = log(lc * n + 1.0);
  let log_f = log(lc * f_dist + 1.0);
  let log_z = mix(log_n, log_f, t);
  let z_abs = (exp(log_z) - 1.0) / lc;
  return clamp(z_abs, n, f_dist);
}
