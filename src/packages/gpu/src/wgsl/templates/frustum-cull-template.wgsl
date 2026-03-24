// GeoForge — frustum cull compute
struct FrustumCullParams {
  plane0: vec4<f32>,
  plane1: vec4<f32>,
  plane2: vec4<f32>,
  plane3: vec4<f32>,
  plane4: vec4<f32>,
  plane5: vec4<f32>,
  objectCount: u32,
  _pad: vec3<u32>,
}
@group(0) @binding(0) var<uniform> uCull: FrustumCullParams;
@group(0) @binding(1) var<storage, read> aabbMin: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> aabbMax: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

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
  let p0 = uCull.plane0;
  let p1 = uCull.plane1;
  let p2 = uCull.plane2;
  let p3 = uCull.plane3;
  let p4 = uCull.plane4;
  let p5 = uCull.plane5;
  if (aabbOutsidePlane(minP, maxP, p0)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p1)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p2)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p3)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p4)) { return false; }
  if (aabbOutsidePlane(minP, maxP, p5)) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn cs_frustum_cull_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uCull.objectCount) { return; }
  let mn = aabbMin[i].xyz;
  let mx = aabbMax[i].xyz;
  let vis = select(0u, 1u, isAabbVisible(mn, mx));
  visible[i] = vis;
}
