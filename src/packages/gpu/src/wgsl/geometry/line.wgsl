// geometry: line — 与点类似；宽线 extrusion 由上层扩展 vertex attributes
fn processVertex(input: VertexInput) -> VertexOutput {
  var o: VertexOutput;
  let wp = (uObject.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
  o.worldPosition = wp;
  let nrm = (uObject.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
  o.worldNormal = normalize(nrm);
  o.uv = input.uv;
  o.color = input.color;
  o.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  return o;
}
