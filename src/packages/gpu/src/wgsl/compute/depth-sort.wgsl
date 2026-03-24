// GeoForge — depth key sort placeholder (identity on values; entry cs_main)
@group(0) @binding(0) var<storage, read> depthKeys: array<f32>;
@group(0) @binding(1) var<storage, read_write> values: array<u32>;

@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&depthKeys);
  let i = gid.x;
  if (i >= n) { return; }
  let k = depthKeys[i];
  let v = values[i];
  values[i] = select(v, v, k == k);
}
