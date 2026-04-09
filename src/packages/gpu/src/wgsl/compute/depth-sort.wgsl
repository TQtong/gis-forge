// ============================================================
// compute/depth-sort.wgsl — 全局 Bitonic Sort（多 pass 多 workgroup）
// ============================================================
//
// 按 f32 深度键升序排序，u32 值随键移动。支持任意 N（不限 256）。
//
// 实现：阶段式 Bitonic Sort（Batcher 1968）。每个 dispatch 处理 Bitonic
// 网络的一个 (stage, pass_of_stage) 阶段；上层 TS 代码按
//   for stage = 2..nPad, pass = stage/2..1
// 的顺序发起 log²(nPad) 个 dispatch。
//
// 对 N 非 2 的幂的情况，要求 **调用方传入的 keys/values buffer 大小 ≥
// nextPowerOf2(N)**，并把 [N, nPad) 范围预填 PAD_KEY (=f32::MAX) 和任意 values
// （通常 0）。nPad 外的逻辑元素在排序后自然沉到尾部，读取时取前 N 个即可。
//
// 每个 (stage, pass) 的 thread i 检查自己与 partner `i ^ j` 的键，按方向
// 位 `(i & k)` 决定上升或下降子序列，必要时交换。每个 thread 单独执行一次
// compare-swap，所以 dispatch 数 = passes = stage*(stage+1)/2；总比较 ~N log²N。
//
// 每 pass dispatch 数：ceil(nPad / workgroup_size)。
// ============================================================

struct SortParams {
    /** 比较距离（= 1 << pass_of_stage） */
    j: u32,
    /** 当前 Bitonic 阶段长度（= 1 << stage） */
    k: u32,
    /** 填充后的 2 的幂长度 nPad，每次 dispatch 覆盖 [0, nPad) */
    n_pad: u32,
    _pad: u32,
}

@group(0) @binding(0) var<storage, read_write> keys: array<f32>;
@group(0) @binding(1) var<storage, read_write> values: array<u32>;
@group(0) @binding(2) var<uniform> params: SortParams;

@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.n_pad) { return; }

    let ixj = i ^ params.j;
    // 仅由编号较小的一方执行比较（避免重复）
    if (ixj <= i) { return; }
    if (ixj >= params.n_pad) { return; }

    let ki = keys[i];
    let kj = keys[ixj];

    // (i & k) == 0 → 该对属于"升序"子序列，否则"降序"
    let ascending = (i & params.k) == 0u;
    let aGtB = ki > kj;
    let shouldSwap = (ascending && aGtB) || (!ascending && !aGtB);

    if (shouldSwap) {
        keys[i] = kj;
        keys[ixj] = ki;
        let vi = values[i];
        values[i] = values[ixj];
        values[ixj] = vi;
    }
}
