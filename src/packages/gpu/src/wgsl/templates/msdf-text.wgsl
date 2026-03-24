// feature: msdf text — 三通道 median 反走样（需绑定 group(3) 纹理）
fn gf_msdf_median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn gf_msdf_sample_alpha(uv: vec2<f32>, pxRange: f32) -> f32 {
  let msdf = textureSampleLevel(uGlyphTexture, uGlyphSampler, uv, 0.0);
  let m = gf_msdf_median(msdf.r, msdf.g, msdf.b);
  let w = max(pxRange, 1e-4);
  let sig = smoothstep({{MSDF_MEDIAN}} - w, {{MSDF_MEDIAN}} + w, m);
  return sig;
}
