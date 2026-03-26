// GIS-Forge — spatial hash cluster id per point
const CELL_SIZE: f32 = {{CELL_SIZE}};

@group(0) @binding(0) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> clusterIds: array<u32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&positions);
  let i = gid.x;
  if (i >= n) { return; }
  let p = positions[i].xyz;
  let inv = 1.0 / max(CELL_SIZE, 1e-8);
  let ix = i32(floor(p.x * inv));
  let iy = i32(floor(p.y * inv));
  let iz = i32(floor(p.z * inv));
  let h = u32(ix * 73856093 + iy * 19349663 + iz * 83492791);
  clusterIds[i] = h;
}
