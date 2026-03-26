// GIS-Forge — builtin frustum cull (ComputePassManager)
struct ObjectBounds {
  min: vec4<f32>,
  max: vec4<f32>,
}
@group(0) @binding(0) var<storage, read> objectBounds: array<ObjectBounds>;
@group(0) @binding(1) var<storage, read> frustumPlanes: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outputVisibility: array<u32>;

fn distanceToPlane(p: vec3<f32>, plane: vec4<f32>) -> f32 {
  return dot(vec4<f32>(p, 1.0), plane);
}

fn aabbOutsidePlane(minP: vec3<f32>, maxP: vec3<f32>, plane: vec4<f32>) -> bool {
  let n = plane.xyz;
  let c = vec3<f32>(
    select(minP.x, maxP.x, n.x >= 0.0),
    select(minP.y, maxP.y, n.y >= 0.0),
    select(minP.z, maxP.z, n.z >= 0.0),
  );
  return distanceToPlane(c, plane) < 0.0;
}

fn isAabbVisible(minP: vec3<f32>, maxP: vec3<f32>) -> bool {
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[0])) { return false; }
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[1])) { return false; }
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[2])) { return false; }
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[3])) { return false; }
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[4])) { return false; }
  if (aabbOutsidePlane(minP, maxP, frustumPlanes[5])) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&objectBounds);
  let i = gid.x;
  if (i >= n) { return; }
  let mn = objectBounds[i].min.xyz;
  let mx = objectBounds[i].max.xyz;
  let vis = select(0u, 1u, isAabbVisible(mn, mx));
  outputVisibility[i] = vis;
}
