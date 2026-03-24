// style: stroke — 基于 UV 横向距离模拟线宽衰减（配合 line 几何）
fn computeColor(input: FragmentInput) -> vec4<f32> {
  let w = max(uLayer.lineWidth, 1e-4);
  let d = abs(input.uv.x - 0.5) * 2.0;
  let edge = smoothstep(w + 1.0, w, d);
  let a = input.color.a * uLayer.opacity * edge;
  return vec4<f32>(input.color.rgb * uLayer.baseColor.rgb, a);
}
