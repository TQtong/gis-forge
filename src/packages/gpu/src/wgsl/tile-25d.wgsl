// ═══ tile-25d.wgsl ═══
// 2.5D tile renderer: projects textured ground-plane quads through a
// perspective camera and applies distance fog near the horizon.

struct CameraUniforms {
  vpMatrix:       mat4x4<f32>,  // 64 bytes, offset 0
  cameraPosition: vec3<f32>,    // 12 bytes, offset 64
  worldSize:      f32,          //  4 bytes, offset 76
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var tileSampler: sampler;
@group(1) @binding(1) var tileTexture: texture_2d<f32>;

struct VsIn {
  @location(0) worldPos: vec3<f32>,
  @location(1) uv:       vec2<f32>,
};
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv:        vec2<f32>,
  @location(1) fogDist:   f32,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.pos = camera.vpMatrix * vec4<f32>(in.worldPos, 1.0);
  out.uv  = in.uv;
  // Fog distance: horizontal distance from camera to vertex
  let dx = in.worldPos.x - camera.cameraPosition.x;
  let dy = in.worldPos.y - camera.cameraPosition.y;
  out.fogDist = sqrt(dx * dx + dy * dy);
  return out;
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var color = textureSample(tileTexture, tileSampler, in.uv);
  // Distance fog masks the blurry horizon at high pitch angles
  let fogStart = camera.worldSize * 0.3;
  let fogEnd   = camera.worldSize * 0.8;
  let fogFactor = clamp((in.fogDist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  let fogColor = vec4<f32>(0.06, 0.08, 0.12, 1.0);
  color = mix(color, fogColor, fogFactor * 0.7);
  return color;
}
