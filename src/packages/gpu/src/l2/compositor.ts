// ============================================================
// l2/compositor.ts — 多投影 Render Pass 输出合成（Compositor）
// 层级：L2（渲染层）
// 职责：将多个投影 Pass 的 color+depth 按统一深度比较合并为最终图像；
//       支持透明通道的排序加权混合（Weighted-Blended OIT 变体）。
// 约束：零 npm 依赖；@group(0) 绑定；深度空间通过 WGSL 统一为可比较视距。
// ============================================================

import type { DepthManager } from './depth-manager.ts';
import type { BlendPresets } from './blend-presets.ts';
import depthUnificationWgsl from '../wgsl/compositor/depth-unification.wgsl?raw';
import composeHeaderWgsl from '../wgsl/compositor/compose-header.wgsl?raw';
import oitHeaderWgsl from '../wgsl/compositor/oit-header.wgsl?raw';
import fullscreenVertexWgsl from '../wgsl/compositor/fullscreen-vertex.wgsl?raw';

// ===================== 常量 =====================

/** 单次合成支持的最大输入层数（受 bind group 与 WGSL 展开限制）。 */
const MAX_COMPOSITOR_INPUTS = 8 as const;

/** 主合成 Uniform 缓冲区大小（字节），满足 vec4 打包与对齐。 */
const COMPOSITOR_UNIFORM_SIZE = 256 as const;

/** OIT 阶段 Uniform 缓冲区大小（字节）。 */
const OIT_UNIFORM_SIZE = 128 as const;

/** 默认对数深度尺度 C（与 DepthManager 顶点对数深度一致的数量级）。 */
const DEFAULT_LOG_DEPTH_C = 0.1;

/** 合成管线默认标签前缀（调试）。 */
const COMPOSITOR_LABEL = 'geoforge-compositor';

// ===================== 类型 =====================

/**
 * 单个投影 Pass 输出，作为 Compositor 的输入。
 * 颜色与深度纹理尺寸须与输出目标一致（逐像素对应）。
 */
export interface CompositorInput {
  /** 颜色附件纹理（通常为 rgba16float / bgra8unorm 等可采样格式）。 */
  readonly colorTexture: GPUTexture;
  /** 深度附件纹理（depth32float）。 */
  readonly depthTexture: GPUTexture;
  /** 投影标识字符串（调试用，不参与 GPU 绑定）。 */
  readonly projection: string;
  /** 合成优先级：深度 tie-break 时数值越大越优先。 */
  readonly priority: number;
  /** 是否包含需要 OIT 的透明内容（用于 updateConfiguration / oitMethod 推断）。 */
  readonly hasTransparentContent: boolean;
  /**
   * 深度缓冲的编码空间。
   * - `reversed-z`：GeoForge 默认，0=远、1=近。
   * - `linear`：0=近、1=远的线性深度。
   * - `logarithmic`：对数扭曲后的 Rev-Z 深度，需对数反推视距。
   */
  readonly depthSpace: 'linear' | 'logarithmic' | 'reversed-z';
}

/**
 * 多 Pass 合成器：将若干输入按最近深度选色，并可做透明排序混合。
 */
export interface Compositor {
  /**
   * 将多个输入按统一深度合并到 `outputTexture`。
   * 使用全屏三角形，片元阶段逐像素比较视空间距离并选取最近片元颜色。
   *
   * @param encoder - 外部命令编码器（本方法只向其中追加 Pass，不 submit）
   * @param inputs - 合成输入列表（长度 1 时可由 canSkipComposition 短路）
   * @param outputTexture - 输出颜色附件目标
   */
  compose(encoder: GPUCommandEncoder, inputs: CompositorInput[], outputTexture: GPUTexture): void;

  /**
   * 当仅存在单一输入时，上层可直接 blit 而跳过本合成器以节省带宽。
   * 在最后一次 updateConfiguration 之后有效。
   */
  readonly canSkipComposition: boolean;

  /**
   * 根据当前帧输入更新内部 uniform 布局、OIT 策略与 canSkipComposition。
   * 应在每帧合成前调用。
   *
   * @param inputs - 本帧参与合成的输入描述
   */
  updateConfiguration(inputs: CompositorInput[]): void;

  /**
   * WGSL 源码片段：将不同 depthSpace 下采样的深度值统一为「视空间正距离」，
   * 供片元比较（值越小表示离相机越近）。可与 ShaderAssembler 注入拼接。
   */
  readonly depthUnificationShader: string;

  /**
   * 先合成不透明输入到内部 scratch，再按深度排序将透明层叠加到输出。
   *
   * @param encoder - 命令编码器（所有操作追加到同一 encoder）
   * @param opaqueInputs - 不透明层输入
   * @param transparentInputs - 透明层输入
   * @param outputTexture - 最终输出
   */
  composeWithOIT(
    encoder: GPUCommandEncoder,
    opaqueInputs: CompositorInput[],
    transparentInputs: CompositorInput[],
    outputTexture: GPUTexture
  ): void;

  /**
   * 当前透明合成策略（由工厂与 updateConfiguration 推断）。
   * - `none`：本帧无透明需求或已禁用 OIT。
   * - `weighted-blended`：片元级深度排序后从前向后加权混合。
   * - `depth-peeling`：枚举占位；完整实现需多 Pass，此处仍用排序近似。
   */
  readonly oitMethod: 'weighted-blended' | 'depth-peeling' | 'none';
}

// ===================== WGSL：深度统一 =====================

/**
 * 生成深度统一 WGSL 辅助函数源码（不含 entry point）。
 *
 * @returns 可拼接到主 shader 的 WGSL 字符串
 */
function buildDepthUnificationWgsl(): string {
  return depthUnificationWgsl;
}

/**
 * 将 TypeScript 的 depthSpace 枚举映射为 WGSL uniform u32。
 *
 * @param space - 输入深度空间
 * @returns 0 / 1 / 2
 */
function depthSpaceToU32(space: CompositorInput['depthSpace']): number {
  if (space === 'reversed-z') {
    return 0;
  }
  if (space === 'linear') {
    return 1;
  }
  return 2;
}

// ===================== 主合成 WGSL =====================

/**
 * 构建主合成着色器完整 WGSL（@group(0) 绑定）。
 *
 * @returns 完整 shader 源码
 */
function buildComposeShaderWgsl(): string {
  const bindings: string[] = [];
  bindings.push(composeHeaderWgsl);

  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    bindings.push(`@group(0) @binding(${1 + i}) var tex_color_${i}: texture_2d<f32>;`);
  }
  const depthBindingBase = 1 + MAX_COMPOSITOR_INPUTS;
  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    bindings.push(
      `@group(0) @binding(${depthBindingBase + i}) var tex_depth_${i}: texture_2d<f32>;`
    );
  }

  const fsParts: string[] = [];
  fsParts.push(`${fullscreenVertexWgsl}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let dims0 = textureDimensions(tex_color_0);
  let coord = vec2<i32>(
    i32(clamp(in.uv.x, 0.0, 1.0) * f32(max(dims0.x, 1u) - 1u)),
    i32(clamp(in.uv.y, 0.0, 1.0) * f32(max(dims0.y, 1u) - 1u))
  );
  let n = compositor_params.count;
  if (n == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  var best_z: f32 = 1.0e38;
  var best_prio: f32 = -1.0e38;
  var best_color: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);
`);

  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    fsParts.push(`
  {
    let idx = ${i}u;
    if (idx < n) {
      let d_raw = textureLoad(tex_depth_${i}, coord, 0).x;
      let mode_u = comp_get_mode(idx);
      let z_view = geoforge_unify_depth_to_view_z(
        d_raw,
        mode_u,
        compositor_params.near,
        compositor_params.far,
        compositor_params.log_c
      );
      let col = textureLoad(tex_color_${i}, coord, 0);
      let prio = comp_get_prio(idx);
      if (z_view < best_z - 1e-6 || (abs(z_view - best_z) < 1e-6 && prio > best_prio)) {
        best_z = z_view;
        best_prio = prio;
        best_color = col;
      }
    }
  }
`);
  }

  fsParts.push(`
  return best_color;
}
`);

  return buildDepthUnificationWgsl() + bindings.join('\n') + fsParts.join('');
}

// ===================== OIT WGSL =====================

/**
 * 构建透明合成着色器完整 WGSL。
 *
 * @returns 完整 shader 源码
 */
function buildOitShaderComplete(): string {
  let b = 3;
  const lines: string[] = [];
  lines.push(depthUnificationWgsl);
  lines.push(oitHeaderWgsl);

  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    lines.push(`@group(0) @binding(${b + i}) var oit_tc_${i}: texture_2d<f32>;`);
  }
  b += MAX_COMPOSITOR_INPUTS;
  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    lines.push(`@group(0) @binding(${b + i}) var oit_td_${i}: texture_2d<f32>;`);
  }

  lines.push(`${fullscreenVertexWgsl}
fn sort8_indices(z: array<f32, ${MAX_COMPOSITOR_INPUTS}>, count: u32) -> array<u32, ${MAX_COMPOSITOR_INPUTS}> {
  var idx: array<u32, ${MAX_COMPOSITOR_INPUTS}>;
  for (var i: u32 = 0u; i < ${MAX_COMPOSITOR_INPUTS}u; i = i + 1u) {
    idx[i] = i;
  }
  for (var sortPass: u32 = 0u; sortPass < ${MAX_COMPOSITOR_INPUTS}u; sortPass = sortPass + 1u) {
    for (var bb: u32 = 0u; bb < ${MAX_COMPOSITOR_INPUTS - 1}u; bb = bb + 1u) {
      if (bb >= count - 1u) { continue; }
      let i0 = idx[bb];
      let i1 = idx[bb + 1u];
      if (z[i0] > z[i1]) {
        idx[bb] = i1;
        idx[bb + 1u] = i0;
      }
    }
  }
  return idx;
}
`);

  let frag = `
@fragment
fn fs_oit(in: VertexOutput) -> @location(0) vec4<f32> {
  let dims_bg = textureDimensions(tex_background);
  let coord = vec2<i32>(
    i32(clamp(in.uv.x, 0.0, 1.0) * f32(max(dims_bg.x, 1u) - 1u)),
    i32(clamp(in.uv.y, 0.0, 1.0) * f32(max(dims_bg.y, 1u) - 1u))
  );
  var color = textureLoad(tex_background, coord, 0);
  let nt = oit_params.trans_count;
  var zbuf: array<f32, ${MAX_COMPOSITOR_INPUTS}>;
  var cols: array<vec4<f32>, ${MAX_COMPOSITOR_INPUTS}>;
`;
  for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
    frag += `
  if (${i}u < nt) {
    let d_raw_${i} = textureLoad(oit_td_${i}, coord, 0).x;
    zbuf[${i}u] = geoforge_unify_depth_to_view_z(
      d_raw_${i},
      oit_get_mode(${i}u),
      oit_params.near,
      oit_params.far,
      oit_params.log_c
    );
    cols[${i}u] = textureLoad(oit_tc_${i}, coord, 0);
  } else {
    zbuf[${i}u] = 1.0e38;
    cols[${i}u] = vec4<f32>(0.0);
  }
`;
  }
  frag += `
  let order = sort8_indices(zbuf, nt);
  for (var k: u32 = 0u; k < ${MAX_COMPOSITOR_INPUTS}u; k = k + 1u) {
    if (k >= nt) { break; }
    let li = order[k];
    let src = cols[li];
    let a = clamp(src.a, 0.0, 1.0);
    let zv = zbuf[li];
    let w_blend = a * (1.0 / (1.0 + zv * 0.001));
    color = vec4<f32>(
      color.rgb * (1.0 - w_blend) + src.rgb * w_blend,
      max(color.a, a)
    );
  }
  return color;
}
`;
  lines.push(frag);
  return lines.join('\n');
}

// ===================== Uniform CPU 打包 =====================

/**
 * 写入主合成 Uniform（vec4 打包 modes / priorities）。
 *
 * @param inputs - 当前输入
 * @param near - 近裁剪面
 * @param far - 远裁剪面
 * @param logC - 对数尺度
 * @returns ArrayBuffer
 */
function buildComposeUniformBuffer(
  inputs: CompositorInput[],
  near: number,
  far: number,
  logC: number
): ArrayBuffer {
  const buf = new ArrayBuffer(COMPOSITOR_UNIFORM_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, inputs.length, true);
  dv.setFloat32(4, near, true);
  dv.setFloat32(8, far, true);
  dv.setFloat32(12, logC, true);
  dv.setUint32(16, depthSpaceToU32(inputs[0]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(20, depthSpaceToU32(inputs[1]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(24, depthSpaceToU32(inputs[2]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(28, depthSpaceToU32(inputs[3]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(32, depthSpaceToU32(inputs[4]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(36, depthSpaceToU32(inputs[5]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(40, depthSpaceToU32(inputs[6]?.depthSpace ?? 'reversed-z'), true);
  dv.setUint32(44, depthSpaceToU32(inputs[7]?.depthSpace ?? 'reversed-z'), true);
  dv.setFloat32(48, inputs[0]?.priority ?? 0, true);
  dv.setFloat32(52, inputs[1]?.priority ?? 0, true);
  dv.setFloat32(56, inputs[2]?.priority ?? 0, true);
  dv.setFloat32(60, inputs[3]?.priority ?? 0, true);
  dv.setFloat32(64, inputs[4]?.priority ?? 0, true);
  dv.setFloat32(68, inputs[5]?.priority ?? 0, true);
  dv.setFloat32(72, inputs[6]?.priority ?? 0, true);
  dv.setFloat32(76, inputs[7]?.priority ?? 0, true);
  return buf;
}

/**
 * 构建 OIT 阶段 Uniform（trans_m0/trans_m1 与 WGSL struct 对齐）。
 *
 * @param opaqueCount - 不透明层数（保留）
 * @param transInputs - 透明输入
 * @param near - 近裁剪面
 * @param far - 远裁剪面
 * @param logC - 对数尺度
 * @returns ArrayBuffer
 */
function buildOitUniformBuffer(
  opaqueCount: number,
  transInputs: CompositorInput[],
  near: number,
  far: number,
  logC: number
): ArrayBuffer {
  const buf = new ArrayBuffer(OIT_UNIFORM_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, opaqueCount, true);
  dv.setUint32(4, transInputs.length, true);
  dv.setFloat32(8, near, true);
  dv.setFloat32(12, far, true);
  dv.setFloat32(16, logC, true);
  dv.setUint32(20, 0, true);
  for (let i = 0; i < 4; i++) {
    dv.setUint32(32 + i * 4, depthSpaceToU32(transInputs[i]?.depthSpace ?? 'reversed-z'), true);
  }
  for (let i = 0; i < 4; i++) {
    dv.setUint32(48 + i * 4, depthSpaceToU32(transInputs[i + 4]?.depthSpace ?? 'reversed-z'), true);
  }
  return buf;
}

// ===================== 校验与辅助 =====================

/**
 * 校验输入数组长度与纹理尺寸一致性。
 *
 * @param inputs - 合成输入
 * @param output - 输出纹理
 * @param label - 错误消息前缀
 */
function assertInputsCompatible(
  inputs: CompositorInput[],
  output: GPUTexture,
  label: string
): void {
  if (inputs.length > MAX_COMPOSITOR_INPUTS) {
    throw new Error(
      `${label}: at most ${MAX_COMPOSITOR_INPUTS} inputs allowed, got ${inputs.length}`
    );
  }
  const ow = output.width;
  const oh = output.height;
  if (ow <= 0 || oh <= 0) {
    throw new Error(`${label}: output texture has invalid dimensions`);
  }
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    if (!inp.colorTexture || !inp.depthTexture) {
      throw new Error(`${label}: input ${i} missing color or depth texture`);
    }
    const cw = inp.colorTexture.width;
    const ch = inp.colorTexture.height;
    const dw = inp.depthTexture.width;
    const dh = inp.depthTexture.height;
    if (cw !== ow || ch !== oh || dw !== ow || dh !== oh) {
      throw new Error(
        `${label}: input ${i} size ${cw}x${ch} / depth ${dw}x${dh} must match output ${ow}x${oh}`
      );
    }
  }
}

/**
 * 创建 1×1 占位纹理（颜色透明、深度 Rev-Z 远平面 0）。
 *
 * @param device - GPU 设备
 * @param colorFormat - 颜色格式
 * @returns { color, depth } 纹理
 */
function createDummyTextures(
  device: GPUDevice,
  colorFormat: GPUTextureFormat
): { color: GPUTexture; depth: GPUTexture } {
  const color = device.createTexture({
    label: `${COMPOSITOR_LABEL}-dummy-color`,
    size: { width: 1, height: 1 },
    format: colorFormat,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const depth = device.createTexture({
    label: `${COMPOSITOR_LABEL}-dummy-depth`,
    size: { width: 1, height: 1 },
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  return { color, depth };
}

/**
 * 将 uniform 数据写入 GPU 缓冲。
 *
 * @param device - GPU 设备
 * @param buffer - 目标 uniform buffer
 * @param data - 对齐后的 CPU 数据
 */
function writeUniformRaw(device: GPUDevice, buffer: GPUBuffer, data: ArrayBuffer): void {
  device.queue.writeBuffer(buffer, 0, data);
}

// ===================== 工厂 =====================

/**
 * 创建 Compositor 实例。
 *
 * @param device - WebGPU 设备
 * @param depthManager - 深度管理器（提供 near/far 与深度约定）
 * @param blendPresets - 混合预设（保留用于未来管线扩展与 EP 插件）
 * @returns Compositor 实现
 *
 * @example
 * const compositor = createCompositor(device, depthManager, blendPresets);
 * compositor.updateConfiguration(inputs);
 * compositor.compose(encoder, inputs, outputTex);
 */
export function createCompositor(
  device: GPUDevice,
  depthManager: DepthManager,
  blendPresets: BlendPresets
): Compositor {
  if (!device) {
    throw new Error('[Compositor] device is required');
  }
  if (!depthManager) {
    throw new Error('[Compositor] depthManager is required');
  }
  if (!blendPresets) {
    throw new Error('[Compositor] blendPresets is required');
  }

  const composeShaderSource = buildComposeShaderWgsl();
  const oitShaderSource = buildOitShaderComplete();

  const composeModule = device.createShaderModule({
    label: `${COMPOSITOR_LABEL}-compose-module`,
    code: composeShaderSource,
  });

  const oitModule = device.createShaderModule({
    label: `${COMPOSITOR_LABEL}-oit-module`,
    code: oitShaderSource,
  });

  const uniformBuffer = device.createBuffer({
    label: `${COMPOSITOR_LABEL}-uniform`,
    size: COMPOSITOR_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const oitUniformBuffer = device.createBuffer({
    label: `${COMPOSITOR_LABEL}-oit-uniform`,
    size: OIT_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const linearSampler = device.createSampler({
    label: `${COMPOSITOR_LABEL}-linear`,
    magFilter: 'linear',
    minFilter: 'linear',
  });

  let skipFlag = true;
  let oitMode: Compositor['oitMethod'] = 'none';

  const pipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();
  const oitPipelineCache = new Map<GPUTextureFormat, GPURenderPipeline>();

  let scratchColor: GPUTexture | null = null;
  let scratchFormat: GPUTextureFormat | null = null;
  let scratchW = 0;
  let scratchH = 0;

  const depthUnificationShader = buildDepthUnificationWgsl();

  /**
   * 确保内部 scratch 纹理与输出匹配（用于 OIT 第二遍采样背景）。
   */
  function ensureScratch(outputTexture: GPUTexture): void {
    const w = outputTexture.width;
    const h = outputTexture.height;
    const fmt = outputTexture.format;
    if (scratchColor && scratchW === w && scratchH === h && scratchFormat === fmt) {
      return;
    }
    if (scratchColor) {
      scratchColor.destroy();
      scratchColor = null;
    }
    scratchColor = device.createTexture({
      label: `${COMPOSITOR_LABEL}-scratch`,
      size: { width: w, height: h },
      format: fmt,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
    scratchW = w;
    scratchH = h;
    scratchFormat = fmt;
  }

  /**
   * 获取或创建主合成管线（按输出格式缓存）。
   */
  function getComposePipeline(format: GPUTextureFormat): GPURenderPipeline {
    const cached = pipelineCache.get(format);
    if (cached) {
      return cached;
    }
    const pipeline = device.createRenderPipeline({
      label: `${COMPOSITOR_LABEL}-pipeline-${format}`,
      layout: 'auto',
      vertex: {
        module: composeModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: composeModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    pipelineCache.set(format, pipeline);
    return pipeline;
  }

  /**
   * 获取或创建 OIT 透明叠加管线。
   */
  function getOitPipeline(format: GPUTextureFormat): GPURenderPipeline {
    const cached = oitPipelineCache.get(format);
    if (cached) {
      return cached;
    }
    const pipeline = device.createRenderPipeline({
      label: `${COMPOSITOR_LABEL}-oit-pipeline-${format}`,
      layout: 'auto',
      vertex: {
        module: oitModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: oitModule,
        entryPoint: 'fs_oit',
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'zero',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'zero',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    oitPipelineCache.set(format, pipeline);
    return pipeline;
  }

  /**
   * 为主合成 Pass 构建 bind group。
   */
  function buildComposeBindGroup(
    pipeline: GPURenderPipeline,
    inputs: CompositorInput[],
    dummies: { color: GPUTexture; depth: GPUTexture }
  ): GPUBindGroup {
    const layout = pipeline.getBindGroupLayout(0);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniformBuffer } },
    ];
    for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
      const col = i < inputs.length ? inputs[i].colorTexture : dummies.color;
      entries.push({
        binding: 1 + i,
        resource: col.createView({ label: `${COMPOSITOR_LABEL}-color-view-${i}` }),
      });
    }
    const db = 1 + MAX_COMPOSITOR_INPUTS;
    for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
      const dep = i < inputs.length ? inputs[i].depthTexture : dummies.depth;
      entries.push({
        binding: db + i,
        resource: dep.createView({ label: `${COMPOSITOR_LABEL}-depth-view-${i}` }),
      });
    }
    return device.createBindGroup({
      label: `${COMPOSITOR_LABEL}-bind`,
      layout,
      entries,
    });
  }

  /**
   * 为 OIT Pass 构建 bind group（背景 + 透明层）。
   */
  function buildOitBindGroup(
    pipeline: GPURenderPipeline,
    background: GPUTexture,
    trans: CompositorInput[],
    dummies: { color: GPUTexture; depth: GPUTexture }
  ): GPUBindGroup {
    const layout = pipeline.getBindGroupLayout(0);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: oitUniformBuffer } },
      {
        binding: 1,
        resource: background.createView({ label: `${COMPOSITOR_LABEL}-bg-view` }),
      },
      { binding: 2, resource: linearSampler },
    ];
    let bb = 3;
    for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
      const col = i < trans.length ? trans[i].colorTexture : dummies.color;
      entries.push({
        binding: bb + i,
        resource: col.createView({ label: `${COMPOSITOR_LABEL}-oit-c-${i}` }),
      });
    }
    bb += MAX_COMPOSITOR_INPUTS;
    for (let i = 0; i < MAX_COMPOSITOR_INPUTS; i++) {
      const dep = i < trans.length ? trans[i].depthTexture : dummies.depth;
      entries.push({
        binding: bb + i,
        resource: dep.createView({ label: `${COMPOSITOR_LABEL}-oit-d-${i}` }),
      });
    }
    return device.createBindGroup({
      label: `${COMPOSITOR_LABEL}-oit-bind`,
      layout,
      entries,
    });
  }

  /**
   * 填充主合成 uniform 并上传。
   */
  function uploadComposeUniform(inputs: CompositorInput[]): void {
    const cfg = depthManager.config;
    const raw = buildComposeUniformBuffer(
      inputs,
      cfg.nearPlane,
      cfg.farPlane,
      DEFAULT_LOG_DEPTH_C
    );
    writeUniformRaw(device, uniformBuffer, raw);
  }

  /**
   * 执行一次主合成（可选 clear）。
   */
  function composeImpl(
    encoder: GPUCommandEncoder,
    inputs: CompositorInput[],
    outputTexture: GPUTexture,
    clear: boolean
  ): void {
    assertInputsCompatible(inputs, outputTexture, '[Compositor.compose]');
    const fmt = outputTexture.format;
    const pipeline = getComposePipeline(fmt);
    const dummies = createDummyTextures(device, fmt);
    try {
      uploadComposeUniform(inputs);
      const bg = buildComposeBindGroup(pipeline, inputs, dummies);
      const pass = encoder.beginRenderPass({
        label: `${COMPOSITOR_LABEL}-pass`,
        colorAttachments: [
          {
            view: outputTexture.createView({ label: `${COMPOSITOR_LABEL}-out` }),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    } finally {
      dummies.color.destroy();
      dummies.depth.destroy();
    }
  }

  const api: Compositor = {
    get depthUnificationShader(): string {
      return depthUnificationShader;
    },

    get canSkipComposition(): boolean {
      return skipFlag;
    },

    get oitMethod(): Compositor['oitMethod'] {
      return oitMode;
    },

    updateConfiguration(inputs: CompositorInput[]): void {
      if (!Array.isArray(inputs)) {
        throw new Error('[Compositor] updateConfiguration: inputs must be an array');
      }
      skipFlag = inputs.length <= 1;
      const anyTrans = inputs.some((i) => i.hasTransparentContent);
      if (!anyTrans) {
        oitMode = 'none';
      } else {
        oitMode = 'weighted-blended';
      }
    },

    compose(encoder: GPUCommandEncoder, inputs: CompositorInput[], outputTexture: GPUTexture): void {
      if (!encoder) {
        throw new Error('[Compositor] compose: encoder required');
      }
      if (inputs.length === 0) {
        throw new Error('[Compositor] compose: inputs must not be empty');
      }
      composeImpl(encoder, inputs, outputTexture, true);
    },

    composeWithOIT(
      encoder: GPUCommandEncoder,
      opaqueInputs: CompositorInput[],
      transparentInputs: CompositorInput[],
      outputTexture: GPUTexture
    ): void {
      if (!encoder) {
        throw new Error('[Compositor] composeWithOIT: encoder required');
      }
      const fmt = outputTexture.format;
      if (transparentInputs.length === 0) {
        if (opaqueInputs.length === 0) {
          throw new Error('[Compositor] composeWithOIT: no inputs');
        }
        composeImpl(encoder, opaqueInputs, outputTexture, true);
        return;
      }

      ensureScratch(outputTexture);
      if (!scratchColor) {
        throw new Error('[Compositor] composeWithOIT: scratch texture allocation failed');
      }

      const dummies = createDummyTextures(device, fmt);
      try {
        if (opaqueInputs.length > 0) {
          composeImpl(encoder, opaqueInputs, scratchColor, true);
        } else {
          const clearPass = encoder.beginRenderPass({
            label: `${COMPOSITOR_LABEL}-clear-scratch`,
            colorAttachments: [
              {
                view: scratchColor.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          clearPass.end();
        }

        const cfg = depthManager.config;
        const oitRaw = buildOitUniformBuffer(
          opaqueInputs.length,
          transparentInputs,
          cfg.nearPlane,
          cfg.farPlane,
          DEFAULT_LOG_DEPTH_C
        );
        device.queue.writeBuffer(oitUniformBuffer, 0, oitRaw);

        const oitPipe = getOitPipeline(fmt);
        const bgGroup = buildOitBindGroup(oitPipe, scratchColor, transparentInputs, dummies);

        const pass2 = encoder.beginRenderPass({
          label: `${COMPOSITOR_LABEL}-oit-pass`,
          colorAttachments: [
            {
              view: outputTexture.createView({ label: `${COMPOSITOR_LABEL}-oit-out` }),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass2.setPipeline(oitPipe);
        pass2.setBindGroup(0, bgGroup);
        pass2.draw(3);
        pass2.end();
      } finally {
        dummies.color.destroy();
        dummies.depth.destroy();
      }
    },
  };

  return api;
}
