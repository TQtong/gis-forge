// GIS-Forge — depth sort placeholder (identity permutation)
struct DepthSortParams {
  elementCount: u32,
  _pad: vec3<u32>,
}
@group(0) @binding(0) var<uniform> uSort: DepthSortParams;
@group(0) @binding(1) var<storage, read> depthKeys: array<f32>;
@group(0) @binding(2) var<storage, read> inputIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> outputIndices: array<u32>;

@compute @workgroup_size(256)
fn cs_depth_sort_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= uSort.elementCount) { return; }
  let idx = inputIndices[i];
  // 占位：读取 depth key，避免 storage 绑定在占位 pass 中被优化器判为未使用；radix 实现后改为真实排序键
  let key = depthKeys[i];
  outputIndices[i] = select(idx, idx, key == key);
}
