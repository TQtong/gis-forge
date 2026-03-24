// style: fill_gradient — UV 沿 gradientAngle 方向插值
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let ang = uLayer.gradientAngle;
  let dir = vec2<f32>(cos(ang), sin(ang));
  let t = dot(input.uv - vec2<f32>(0.5, 0.5), dir) + 0.5;
  let tt = clamp(t, 0.0, 1.0);
  let c = mix(uLayer.baseColor, input.color, tt);
  return vec4<f32>(c.rgb, c.a * uLayer.opacity);
}
