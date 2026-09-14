import type { CameraState } from '../../core/src/types/viewport.ts';
import type { TileCoord } from '../../core/src/types/tile.ts';
import type { TerrainSurfaceSource } from '../../scene/src/terrain-surface.ts';

const N = 64;
const VERTEX_COUNT = (N + 1) ** 2 + (N + 1) * 4;
const SHADER = /* wgsl */ `
struct Camera { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
struct Style { brightness: f32, contrast: f32, saturation: f32, hue: f32 };
@group(1) @binding(0) var<uniform> style: Style;
@group(2) @binding(0) var imagerySampler: sampler;
@group(2) @binding(1) var imagery: texture_2d<f32>;
struct Tile {
  originSize: vec4<f32>, // camera-relative origin xy, size in pixels, pixels per metre
  uv: vec4<f32>,         // imagery scale xy, offset xy
  params: vec4<f32>,     // opacity, elevation transition, hillshade, unused
  light: vec4<f32>,
};
@group(3) @binding(0) var<uniform> tile: Tile;
struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) world: vec3<f32>,
};
@vertex fn vs_main(@location(0) uvHeight: vec4<f32>) -> Out {
  let xy = tile.originSize.xy + uvHeight.xy * tile.originSize.z;
  let height = mix(uvHeight.z, uvHeight.w, tile.params.y) * tile.originSize.w;
  var out: Out;
  out.world = vec3<f32>(xy, height);
  out.position = camera.vp * vec4<f32>(out.world, 1.0);
  out.uv = uvHeight.xy * tile.uv.xy + tile.uv.zw;
  return out;
}
@fragment fn fs_main(in: Out) -> @location(0) vec4<f32> {
  let base = textureSample(imagery, imagerySampler, in.uv);
  var normal = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (normal.z < 0.0) { normal = -normal; }
  let light = normalize(tile.light.xyz);
  let shade = 1.0 + (dot(normal, light) - light.z) * tile.params.z;
  var rgb = base.rgb * shade + vec3<f32>(style.brightness);
  rgb = (rgb - vec3<f32>(0.5)) * (1.0 + style.contrast) + vec3<f32>(0.5);
  let gray = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3<f32>(gray), rgb, 1.0 + style.saturation);
  let axis = vec3<f32>(0.57735026919);
  rgb = rgb * cos(style.hue) + cross(axis, rgb) * sin(style.hue) + axis * dot(axis, rgb) * (1.0 - cos(style.hue));
  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), base.a * tile.params.x);
}`;

export interface SurfaceTile {
  targetCoord: TileCoord;
  entry: { bindGroup: GPUBindGroup | null; fadeProgress: number };
  uvOffset: readonly [number, number];
  uvScale: readonly [number, number];
}
interface Mesh {
  vertex: GPUBuffer;
  uniform: GPUBuffer;
  group: GPUBindGroup;
  heights: Float32Array;
  previousHeights: Float32Array;
  revision: number;
  source: TerrainSurfaceSource | null;
  updatedAt: number;
}

/** One mesh per displayed imagery tile. Missing elevation is zero on this same mesh. */
export class RasterTerrainSurface {
  private readonly pipeline: GPURenderPipeline;
  private readonly tileLayout: GPUBindGroupLayout;
  private readonly index: GPUBuffer;
  private readonly indexCount: number;
  private readonly meshes = new Map<string, Mesh>();
  private source: TerrainSurfaceSource | null = null;
  private visibleKeys = new Set<string>();
  private maxVisibleZoom = 0;

  private readonly device: GPUDevice;
  constructor(device: GPUDevice, layouts: GPUBindGroupLayout[]) {
    this.device = device;
    this.tileLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [...layouts, this.tileLayout] }),
      vertex: { module, entryPoint: 'vs_main', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat(), blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'greater-equal' },
    });
    const indices: number[] = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    for (let edge = 0; edge < 4; edge++) for (let i = 0; i < N; i++) {
      const a = edge === 0 ? i : edge === 1 ? N * (N + 1) + i : edge === 2 ? i * (N + 1) : i * (N + 1) + N;
      const b = a + (edge < 2 ? 1 : N + 1);
      const s = (N + 1) ** 2 + edge * (N + 1) + i;
      indices.push(a, s, b, b, s, s + 1);
    }
    const data = new Uint16Array(indices);
    this.indexCount = data.length;
    this.index = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.index, 0, data);
  }

  private updateMesh(coord: TileCoord, mesh: Mesh | undefined, now: number): Mesh {
    const count = 2 ** coord.z;
    const data = new Float32Array(VERTEX_COUNT * 4);
    const heights = new Float32Array((N + 1) ** 2);
    const previousHeights = new Float32Array(heights.length);
    const transition = mesh ? Math.max(0, Math.min(1, (now - mesh.updatedAt) / 250)) : 1;
    let changed = !mesh;
    let min = Infinity, max = -Infinity;
    for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) {
      const i = y * (N + 1) + x;
      const lng = (coord.x + x / N) / count * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + y / N) / count))) * 180 / Math.PI;
      const elevation = (this.source?.sampleElevation(lng, lat) ?? 0) * (this.source?.exaggeration ?? 1);
      heights[i] = elevation; min = Math.min(min, elevation); max = Math.max(max, elevation);
      changed ||= heights[i] !== mesh?.heights[i];
      // A new elevation update may arrive before the previous transition ends.
      // Continue from the displayed height instead of jumping to its old target.
      previousHeights[i] = mesh ? mesh.previousHeights[i] * (1 - transition) + mesh.heights[i] * transition : elevation;
      data.set([x / N, y / N, previousHeights[i], elevation], i * 4);
    }
    if (mesh && !changed) {
      // Loading another tile bumps the source revision too. It must not restart
      // this tile's animation or upload an identical mesh.
      mesh.revision = this.source?.revision ?? -1; mesh.source = this.source;
      return mesh;
    }
    // Short skirts seal different LOD edges; they are part of this surface, never a second ground plane.
    const skirt = this.source ? Math.min(200, Math.max(10, (max - min) * 0.05)) : 0;
    for (let edge = 0; edge < 4; edge++) for (let i = 0; i <= N; i++) {
      const a = edge === 0 ? i : edge === 1 ? N * (N + 1) + i : edge === 2 ? i * (N + 1) : i * (N + 1) + N;
      const s = (N + 1) ** 2 + edge * (N + 1) + i;
      data.set([data[a * 4], data[a * 4 + 1], data[a * 4 + 2] - skirt, data[a * 4 + 3] - skirt], s * 4);
    }
    if (!mesh) {
      const uniform = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      mesh = {
        vertex: this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }), uniform,
        group: this.device.createBindGroup({ layout: this.tileLayout, entries: [{ binding: 0, resource: { buffer: uniform } }] }),
        heights, previousHeights: heights, revision: 0, source: this.source, updatedAt: now - 250,
      };
    } else { mesh.updatedAt = now; mesh.previousHeights = previousHeights; }
    this.device.queue.writeBuffer(mesh.vertex, 0, data);
    mesh.heights = heights; mesh.revision = this.source?.revision ?? -1; mesh.source = this.source;
    return mesh;
  }

  encode(pass: GPURenderPassEncoder, camera: CameraState, tiles: readonly SurfaceTile[], source: TerrainSurfaceSource | null,
    cameraGroup: GPUBindGroup, styleGroup: GPUBindGroup, opacity: number): void {
    if (this.source !== source) {
      for (const mesh of this.meshes.values()) { mesh.vertex.destroy(); mesh.uniform.destroy(); }
      this.meshes.clear();
    }
    this.source = source;
    const now = performance.now(), world = 512 * 2 ** camera.zoom;
    const cx = (camera.center[0] + 180) / 360 * world;
    const cy = (1 - Math.asinh(Math.tan(camera.center[1] * Math.PI / 180)) / Math.PI) / 2 * world;
    const ppm = world / (40075016.68557849 * Math.cos(camera.center[1] * Math.PI / 180));
    const pinned = new Set<string>();
    this.visibleKeys = pinned;
    this.maxVisibleZoom = 0;
    let rebuildBudget = 6;
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, cameraGroup); pass.setBindGroup(1, styleGroup); pass.setIndexBuffer(this.index, 'uint16');
    for (const tile of tiles) {
      if (!tile.entry.bindGroup) { continue; }
      const c = tile.targetCoord, key = `${c.z}/${c.x}/${c.y}`;
      this.maxVisibleZoom = Math.max(this.maxVisibleZoom, c.z);
      pinned.add(key);
      let mesh = this.meshes.get(key);
      if (!mesh || ((mesh.revision !== (source?.revision ?? -1) || mesh.source !== source) && rebuildBudget > 0)) {
        mesh = this.updateMesh(c, mesh, now); rebuildBudget--;
      }
      this.meshes.delete(key); this.meshes.set(key, mesh);
      const size = world / 2 ** c.z;
      const uniform = new Float32Array([
        c.x * size - cx, c.y * size - cy, size, ppm,
        ...tile.uvScale, ...tile.uvOffset,
        opacity, Math.min(1, (now - mesh.updatedAt) / 250), source?.hillshade ?? 0, 0,
        ...(source?.lightDirection ?? [-0.5, -0.7, 1]), 0,
      ]);
      this.device.queue.writeBuffer(mesh.uniform, 0, uniform);
      pass.setBindGroup(2, tile.entry.bindGroup); pass.setBindGroup(3, mesh.group); pass.setVertexBuffer(0, mesh.vertex);
      pass.drawIndexed(this.indexCount);
    }
    for (const [key, mesh] of this.meshes) {
      if (this.meshes.size <= 256) { break; }
      if (pinned.has(key)) { continue; }
      mesh.vertex.destroy(); mesh.uniform.destroy(); this.meshes.delete(key);
    }
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) { mesh.vertex.destroy(); mesh.uniform.destroy(); }
    this.meshes.clear(); this.index.destroy();
  }

  /** Match the triangles currently on screen, including their elevation transition. */
  sampleElevation(lng: number, lat: number): number | null {
    const fx = (lng + 180) / 360;
    const fy = (1 - Math.asinh(Math.tan(Math.max(-85.0511287798066, Math.min(85.0511287798066, lat)) * Math.PI / 180)) / Math.PI) / 2;
    let best: Mesh | undefined, u = 0, v = 0;
    for (let z = this.maxVisibleZoom; z >= 0; z--) {
      const n = 2 ** z, x = Math.max(0, Math.min(n - 1, Math.floor(fx * n))), y = Math.max(0, Math.min(n - 1, Math.floor(fy * n)));
      const key = `${z}/${x}/${y}`;
      if (this.visibleKeys.has(key)) { best = this.meshes.get(key); u = fx * n - x; v = fy * n - y; break; }
    }
    if (!best) { return null; }
    const x = Math.min(N - 1, Math.floor(u * N)), y = Math.min(N - 1, Math.floor(v * N));
    const dx = u * N - x, dy = v * N - y, a = y * (N + 1) + x;
    const t = Math.min(1, (performance.now() - best.updatedAt) / 250);
    const h = (i: number) => best!.previousHeights[i] * (1 - t) + best!.heights[i] * t;
    return dx + dy <= 1
      ? h(a) * (1 - dx - dy) + h(a + 1) * dx + h(a + N + 1) * dy
      : h(a + 1) * (1 - dy) + h(a + N + 1) * (1 - dx) + h(a + N + 2) * (dx + dy - 1);
  }
}
