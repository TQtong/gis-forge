// GIS-Forge — label AABB collision (pixel space), tie-break: lower index wins
const VIEWPORT_W: f32 = {{VIEWPORT_W}};
const VIEWPORT_H: f32 = {{VIEWPORT_H}};

@group(0) @binding(0) var<storage, read> labelBoxes: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outputVisibility: array<u32>;

fn onScreen(box: vec4<f32>) -> bool {
  let x2 = box.x + box.z;
  let y2 = box.y + box.w;
  return box.x < VIEWPORT_W && x2 > 0.0 && box.y < VIEWPORT_H && y2 > 0.0;
}

fn intersects(a: vec4<f32>, b: vec4<f32>) -> bool {
  let ax2 = a.x + a.z;
  let ay2 = a.y + a.w;
  let bx2 = b.x + b.z;
  let by2 = b.y + b.w;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = arrayLength(&labelBoxes);
  let i = gid.x;
  if (i >= n) { return; }
  let box = labelBoxes[i];
  var vis = 1u;
  if (!onScreen(box)) { vis = 0u; }
  else {
    for (var j = 0u; j < n; j = j + 1u) {
      if (j == i) { continue; }
      if (intersects(box, labelBoxes[j]) && j < i) { vis = 0u; }
    }
  }
  outputVisibility[i] = vis;
}
