// style: fill_solid — 直接使用插值颜色
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let c = input.color * uLayer.baseColor;
  return vec4<f32>(c.rgb, c.a * uLayer.opacity);
}
