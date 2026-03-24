struct SkyUniforms {
  skyColor: vec4<f32>,
  horizonColor: vec4<f32>,
  fogColor: vec4<f32>,
  horizonY: f32,
  skyHorizonBlend: f32,
  horizonFogBlend: f32,
  fogGroundBlend: f32,
};

@group(0) @binding(0) var<uniform> sky: SkyUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOutput {
  var out: VSOutput;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn smoothstep_f(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@fragment
fn fs(in: VSOutput) -> @location(0) vec4<f32> {
  let y = in.uv.y;
  let h = sky.horizonY;

  if (y < h) {
    let skyStart = h - sky.skyHorizonBlend;
    let t = smoothstep_f(skyStart, h, y);
    return mix(sky.skyColor, sky.horizonColor, t);
  }

  let fogStart = h + sky.horizonFogBlend;
  if (y < fogStart) {
    let t = smoothstep_f(h, fogStart, y);
    return mix(sky.horizonColor, sky.fogColor, t);
  }

  let groundStart = fogStart + sky.fogGroundBlend;
  let t = smoothstep_f(fogStart, groundStart, y);
  return mix(sky.fogColor, vec4<f32>(0.0, 0.0, 0.0, 0.0), t);
}
