struct FogUniforms {
  fogColor: vec4<f32>,
  fogStart: f32,
  fogEnd: f32,
  fogDensity: f32,
  fogType: u32,
};

fn applyFog(color: vec4<f32>, rawDepth: f32, fog: FogUniforms) -> vec4<f32> {
  let linearDepth = 1.0 - rawDepth;
  if (linearDepth < fog.fogStart) {
    return color;
  }
  var fogFactor: f32;
  let d = clamp((linearDepth - fog.fogStart) / max(fog.fogEnd - fog.fogStart, 1e-6), 0.0, 1.0);
  if (fog.fogType == 0u) {
    fogFactor = 1.0 - d;
  } else if (fog.fogType == 1u) {
    fogFactor = exp(-fog.fogDensity * d);
  } else {
    let dd = fog.fogDensity * d;
    fogFactor = exp(-dd * dd);
  }
  return vec4<f32>(mix(fog.fogColor.rgb, color.rgb, fogFactor), color.a);
}
