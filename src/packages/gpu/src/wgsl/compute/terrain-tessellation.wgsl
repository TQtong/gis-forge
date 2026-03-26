// GIS-Forge — per-patch tessellation factor (placeholder LOD)
struct Patch {
  center: vec4<f32>,
  extent: vec4<f32>,
}
@group(0) @binding(0) var<storage, read> patches: array<Patch>;
@group(0) @binding(1) var<storage, read_write> tessFactors: array<vec4<f32>>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&patches);
  let i = gid.x;
  if (i >= n) { return; }
  let c = patches[i].center.xyz;
  let dist = length(c);
  let level = clamp(16.0 - log2(max(dist, 1.0)), 1.0, 16.0);
  tessFactors[i] = vec4<f32>(level, level, level, level);
}
